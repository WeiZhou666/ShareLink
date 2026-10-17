/**
 * 病毒扫描编排：share 级批量扫描 + 文件级状态机 + 失败自愈
 *
 * 状态机（File.scanStatus）：
 *   PENDING（上传完成默认）→ SCANNING（防重复调度）→ CLEAN / INFECTED / ERROR
 *   - CLEAN：通过，可进 zip、可下载
 *   - INFECTED：感染——磁盘文件已删除（防下载），表记录保留（owner/admin 可见被隔离的透明痕迹）
 *   - ERROR：扫描失败（clamd 不可用/超时/超 StreamMaxLength）——fail-open 放行下载，
 *     jobs 任务 8 每小时重扫自愈；clamd 恢复后自动补扫
 *
 * 时机：complete 之后异步（HTTP 202 立即返回不阻塞上传协议），
 * 编排方式为「先扫描、后打 zip」——zip 由调用方以回调注入（share.service 传 createZip），
 * 保证病毒文件绝不进包；依赖方向 ShareService → ScanService 单向，无循环依赖。
 *
 * 与软删除体系的关系：scanShare 由 complete 触发，软删用户的 share 不会再有 complete，
 * 无交叉；jobs 重扫 ERROR 时也不区分（存储对象还在就值得补扫）。
 */
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';
import { ClamAvService, ClamAvError } from './clamav.service';
import { FILE_STORAGE } from '../share/storage/storage.backend';
import type { StorageBackend } from '../share/storage/storage.backend';
import type { ScanStatus } from '@prisma/client';

@Injectable()
export class ScanService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private appConfig: AppConfigService,
    private clamav: ClamAvService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    @Inject(FILE_STORAGE) private readonly fileStorage: StorageBackend, // 扫描源流与隔离删除走存储驱动（local/s3 通用）
  ) {}

  /** 进程启动时把 SCANNING 重置回 PENDING：上次运行中被杀的文件若停在 SCANNING 会永远卡住（无人在扫） */
  async onModuleInit() {
    const { count } = await this.prisma.file.updateMany({
      where: { scanStatus: 'SCANNING' },
      data: { scanStatus: 'PENDING' },
    });
    if (count > 0) {
      this.logger.warn(
        `启动重置：${count} 个卡在 SCANNING 的文件已回到 PENDING 等待重扫`,
        {
          context: ScanService.name,
        },
      );
    }
  }

  /**
   * 扫描一个 share 的全部待扫文件，结束后执行 onDone（通常是打包 zip）
   * @param onDone 扫描收尾回调（仅在有文件进入终态后调用；注入方保证幂等）
   */
  async scanShare(
    shareId: string,
    onDone?: () => Promise<void>,
  ): Promise<void> {
    const enabled = await this.appConfig.getBoolean('antivirus.enabled');
    if (!enabled) {
      // 扫描关闭 = 视为全部通过：历史 PENDING（如曾关过开关）也一并落 CLEAN，避免前端永远显示"扫描中"
      await this.prisma.file.updateMany({
        where: { shareId, scanStatus: { not: 'CLEAN' } },
        data: { scanStatus: 'CLEAN', scannedAt: new Date() },
      });
      await onDone?.();
      return;
    }

    // 只扫未定终态的：CLEAN 不重扫（编辑场景补传不重复消耗）；INFECTED 已删磁盘无内容可扫；
    // SCANNING 理论上只存在于并发调度窗口（complete 只在 uploadLocked 翻转时调用一次）
    const pending = await this.prisma.file.findMany({
      where: { shareId, scanStatus: { in: ['PENDING', 'ERROR'] } },
      select: { id: true, shareId: true },
    });

    for (const file of pending) {
      await this.scanOne(file.shareId, file.id);
    }

    // 无论是否有文件被扫（可能全部已是终态），zip 都该尝试补齐（createZip 内部自行过滤 INFECTED）
    await onDone?.();
  }

  /** 扫描单个文件并落终态：INFECTED 删存储对象保留记录；异常落 ERROR（fail-open，等 jobs 重扫） */
  private async scanOne(shareId: string, fileId: string): Promise<void> {
    await this.prisma.file.update({
      where: { id: fileId },
      data: { scanStatus: 'SCANNING' },
    });

    // 读前先确认内容还在：丢失（INFECTED 处置中断于删除与状态更新之间、
    // 或曾被手动清理）时无法扫描，若落 ERROR 会进入"重扫→读不到→永远 ERROR"死循环——
    // 直接落 INFECTED 终态（对象已无 + 下载 403 拦截，语义与隔离完成等价）跳出循环
    if (!(await this.fileStorage.contentExists(shareId, fileId))) {
      await this.prisma.file.update({
        where: { id: fileId },
        data: { scanStatus: 'INFECTED', scannedAt: new Date() },
      });
      this.logger.warn(
        `病毒扫描：存储对象已不存在（疑似处置中断或手动清理），按已隔离落 INFECTED ${shareId}/${fileId}`,
        { context: ScanService.name },
      );
      return;
    }
    try {
      // 存储驱动出扫描源流（local 磁盘流 / s3 GetObject 流），clamd INSTREAM 流式收块
      const result = await this.clamav.scanStream(
        await this.fileStorage.openContentStream(shareId, fileId),
      );

      if (result.clean) {
        await this.prisma.file.update({
          where: { id: fileId },
          data: {
            scanStatus: 'CLEAN',
            scannedAt: new Date(),
            scanSignature: null,
          },
        });
        return;
      }

      // 感染处置：存储对象必须删（下载双保险的第二层；第一层是下载链路的 INFECTED → 403），
      // 表记录保留——owner 文件列表能看到"该文件已被隔离"及签名，透明可查
      await this.fileStorage.deleteContent(shareId, fileId).catch(() => {
        // 删除失败不算致命：下载链路仍会 403 拦截，管理员可手动清理
        this.logger.warn(
          `隔离文件存储删除失败（下载链路仍会拦截）：${shareId}/${fileId}`,
          {
            context: ScanService.name,
          },
        );
      });
      await this.prisma.file.update({
        where: { id: fileId },
        data: {
          scanStatus: 'INFECTED',
          scannedAt: new Date(),
          scanSignature: result.signature,
        },
      });
      this.logger.warn(
        `病毒扫描：发现感染文件并已隔离 ${shareId}/${fileId}，签名：${result.signature}`,
        { context: ScanService.name },
      );
    } catch (err) {
      // ClamAvError（连接失败/超时/超限制）→ ERROR + fail-open（下载放行），jobs 任务 8 每小时重扫自愈
      const message = err instanceof ClamAvError ? err.message : String(err);
      await this.prisma.file.update({
        where: { id: fileId },
        data: { scanStatus: 'ERROR', scannedAt: new Date() },
      });
      this.logger.error(
        `病毒扫描失败（文件落 ERROR，将等待重试）：${shareId}/${fileId}，${message}`,
        {
          context: ScanService.name,
        },
      );
    }
  }

  /** jobs 任务 8 消费：按状态找待重扫文件（排除磁盘已随 share 物理删除的孤儿——join share 判活） */
  async findRescanCandidates(): Promise<{ id: string; shareId: string }[]> {
    return this.prisma.file.findMany({
      where: { scanStatus: 'ERROR', share: { is: { uploadLocked: true } } },
      select: { id: true, shareId: true },
    });
  }

  /** 单文件重扫（jobs 任务 8 用）：复用 scanOne 状态机；返回终态便于调用方决定是否补打 zip */
  async rescanFile(shareId: string, fileId: string): Promise<ScanStatus> {
    await this.scanOne(shareId, fileId);
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { scanStatus: true },
    });
    return file!.scanStatus;
  }
}
