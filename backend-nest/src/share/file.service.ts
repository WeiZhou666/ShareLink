/**
 * 文件服务：分块上传协议、下载链路、删除清理——业务规则在这层，物理存储在 StorageBackend 后面
 *
 * 存储双模式（STORAGE_DRIVER=local|s3，local 为本地磁盘、s3 为任意 S3 兼容服务）：
 * - 分块暂存协议不随驱动变化：{SHARE_DIRECTORY}/{shareId}/{fileId}.tmp-chunk 恒在本地磁盘，
 *   断点续传"期望块索引 = 磁盘已有字节数 / chunkSize 向上取整"的原协议零改动
 * - 差异收敛在"最后一块转正"（finalizeChunk：磁盘改名 / 上传 S3）与读取（磁盘流 / GetObject），
 *   见 storage/storage.backend.ts 的接口契约
 *
 * 分块上传协议（前端 useUpload 编排）：
 * - 前端按 share.chunkSize 切片，逐块 POST /shares/:shareId/files（query 带 id/name/chunkIndex/totalChunks）
 * - 后端校验"期望块索引"，不匹配即 400 并返回 expectedChunkIndex（前端据此断点续传，
 *   错误码 unexpected_chunk_index 是对端协议的一部分）
 * - 最后一块到达后转正存储并写入 File 表记录（表记录即"上传完成"的唯一事实）
 */
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import * as mime from 'mime-types';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';
import { I18nService } from 'nestjs-i18n';
import { SHARE_DIRECTORY } from './share.constants';
import { parseRangeHeader } from './share.utils';
import {
  FILE_STORAGE,
  StorageCapabilityError,
} from './storage/storage.backend';
import type {
  DirectUploadPart,
  StorageBackend,
} from './storage/storage.backend';
import {
  UploadAbortDTO,
  UploadCompleteDTO,
  UploadInitDTO,
} from './dto/s3-direct-upload.dto';

/** 文件 ID 规则：前端生成的 36 位 uuid（直传端点与代理分块共用同一规则） */
const FILE_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;

/** S3 multipart 的最小分片约束：除末块外每块必须 ≥ 5MiB，否则 complete 时 EntityTooSmall */
const S3_MIN_PART_SIZE = 5 * 1024 * 1024;

/** 读取结果：内容流 + 元数据 + 命中的区间（Range 请求时非空） */
export interface FileContentResult {
  metaData: {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    shareId: string;
  };
  file?: Readable;
  range?: { start: number; end: number };
  isRangeNotSatisfiable?: boolean;
}

@Injectable()
export class FileService {
  constructor(
    private prisma: PrismaService,
    private appConfig: AppConfigService,
    private readonly i18n: I18nService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    @Inject(FILE_STORAGE) private readonly storage: StorageBackend,
  ) {}

  /** 分享目录绝对路径（shareId 已过 ID_PATTERN 校验，无路径穿越风险）——仅分块暂存用 */
  private shareDir(shareId: string): string {
    return path.join(SHARE_DIRECTORY, shareId);
  }

  /** 分块暂存文件路径：双模式不变式——tmp 恒在本地磁盘（断点续传协议的"唯一事实源"） */
  private tmpChunkPath(shareId: string, fileId: string): string {
    return path.join(this.shareDir(shareId), `${fileId}.tmp-chunk`);
  }

  /**
   * 写入一个分块
   * @param data 请求体：express.raw 解析出的 Buffer（或字符串形态的 base64，兼容旧客户端）
   * @param chunk 块索引信息（index 从 0 计）
   * @param file 文件标识（id 由前端生成 uuid；name 为展示名，可含中文）
   */
  async createChunk(
    data: Buffer | string,
    chunk: { index: number; total: number },
    file: { id?: string; name: string },
    shareId: string,
  ) {
    // 文件 ID 规范化：前端已带 id 则直接用（分块续传要求幂等），否则服务端生成
    if (!file.id) file.id = crypto.randomUUID();
    else if (!/^[0-9a-fA-F-]{36}$/.test(file.id)) {
      throw new BadRequestException(this.i18n.t('file.invalidIdFormat'));
    }

    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { files: true, reverseShare: true, creator: true },
    });
    if (!share) throw new NotFoundException(this.i18n.t('share.notFound'));
    // 已完成的分享拒绝再传（complete 后 uploadLocked=true）
    if (share.uploadLocked) {
      throw new BadRequestException(this.i18n.t('file.alreadyCompleted'));
    }

    // ---- 期望块索引校验：磁盘上已有多少字节决定下一个该收第几块 ----
    let diskFileSize = 0;
    try {
      diskFileSize = (await fsp.stat(this.tmpChunkPath(shareId, file.id))).size;
    } catch {
      diskFileSize = 0; // 首块：暂存文件尚不存在
    }
    const chunkSize = await this.appConfig.getNumber('share.chunkSize');
    const expectedChunkIndex = Math.ceil(diskFileSize / chunkSize);
    if (expectedChunkIndex !== chunk.index) {
      // 响应体带 error/expectedChunkIndex——前端 useUpload 据此跳到服务端期望的块重传
      throw new HttpException(
        {
          message: this.i18n.t('file.unexpectedChunk'),
          error: 'unexpected_chunk_index',
          expectedChunkIndex,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // 统一入参为 Buffer：express.raw 已给 Buffer；字符串形态按 base64 兜底（协议兼容）
    const buffer = Buffer.isBuffer(data)
      ? data
      : Buffer.from(String(data ?? ''), 'base64');

    // ---- 磁盘剩余空间预检（大小至少要装下本块；tmp 恒在本地磁盘，双模式同一检查） ----
    try {
      const space = await fsp.statfs(SHARE_DIRECTORY);
      if (space.bavail * space.bsize < buffer.byteLength) {
        throw new InternalServerErrorException(
          this.i18n.t('file.notEnoughSpace'),
        );
      }
    } catch (e) {
      if (e instanceof HttpException) throw e;
      // statfs 失败（如挂载点异常）不阻塞上传，交给写入阶段的系统错误兜底
      this.logger.warn(
        `statfs 预检失败，跳过磁盘空间检查：${(e as Error).message}`,
      );
    }

    // ---- 分享总大小上限：全局 share.maxSize，反向分享的 maxShareSize 优先覆盖 ----
    const existingSize = share.files.reduce(
      (sum, f) => sum + Number(f.size),
      0,
    );
    const limit = share.reverseShare
      ? share.reverseShare.maxShareSize
      : await this.appConfig.getNumber('share.maxSize');
    if (existingSize + diskFileSize + buffer.byteLength > limit) {
      throw new HttpException(
        this.i18n.t('file.maxSizeExceeded'),
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    // 追加写入暂存文件（appendFile 保证逐块顺序落盘）
    await fsp.appendFile(this.tmpChunkPath(shareId, file.id), buffer);

    // 最后一块：暂存转正存储（磁盘改名 / 上传 S3）+ 登记 File 表（表记录即"上传完成"的唯一事实）
    const isLastChunk = chunk.index === chunk.total - 1;
    if (isLastChunk) {
      const fileSize = await this.storage.finalizeChunk(shareId, file.id);
      await this.prisma.file.create({
        data: {
          id: file.id,
          name: file.name,
          // BigInt 承载超大文件（>2^31 字节），出 JSON 前 toString
          size: BigInt(fileSize),
          share: { connect: { id: shareId } },
        },
      });
    }

    return { id: file.id, name: file.name };
  }

  // ================= S3 直传编排（方案 B）：字节不过后端，后端只做控制面 =================

  /** upload-init：探测 + 签发直传会话。本驱动不支持 → 404（前端对任何失败自动降级代理分块） */
  async initDirectUpload(shareId: string, dto: UploadInitDTO) {
    if (!FILE_ID_PATTERN.test(dto.id)) {
      throw new BadRequestException(this.i18n.t('file.invalidIdFormat'));
    }
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { files: true, reverseShare: true },
    });
    if (!share) throw new NotFoundException(this.i18n.t('share.notFound'));
    if (share.uploadLocked) {
      throw new BadRequestException(this.i18n.t('file.alreadyCompleted'));
    }

    // 5MiB 规则前置：chunkSize 过小 complete 时才炸（EntityTooSmall），体验差——
    // 提前拒绝，init 失败即触发前端降级代理模式（代理模式无此约束）
    const chunkSize = await this.appConfig.getNumber('share.chunkSize');
    if (dto.totalChunks > 1 && chunkSize < S3_MIN_PART_SIZE) {
      throw new BadRequestException(
        this.i18n.t('file.s3MultipartPartTooSmall'),
      );
    }

    // 大小预检：totalChunks × chunkSize 是粗上界（末块不足整块），宁严勿漏——
    // 直传后没有逐块检查点，总量必须在 init 卡住；limit 非 chunkSize 整数倍的极端
    // 边界存在误拒可能，属可接受取舍（对齐 limit 与 chunkSize 整数倍即可规避）
    const existingSize = share.files.reduce(
      (sum, f) => sum + Number(f.size),
      0,
    );
    const limit = share.reverseShare
      ? share.reverseShare.maxShareSize
      : await this.appConfig.getNumber('share.maxSize');
    if (existingSize + dto.totalChunks * chunkSize > limit) {
      throw new HttpException(
        this.i18n.t('file.maxSizeExceeded'),
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    try {
      return {
        directToS3: true as const,
        ...(await this.storage.initDirectUpload(
          shareId,
          dto.id,
          dto.totalChunks,
        )),
      };
    } catch (e) {
      if (e instanceof StorageCapabilityError) {
        throw new NotFoundException(this.i18n.t('file.s3DirectNotSupported'));
      }
      throw e;
    }
  }

  /** upload-complete：CompleteMultipartUpload + File 表登记（与代理模式"最后一块落库"等价） */
  async completeDirectUpload(shareId: string, dto: UploadCompleteDTO) {
    if (!FILE_ID_PATTERN.test(dto.id)) {
      throw new BadRequestException(this.i18n.t('file.invalidIdFormat'));
    }
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      select: { uploadLocked: true },
    });
    if (!share) throw new NotFoundException(this.i18n.t('share.notFound'));
    if (share.uploadLocked) {
      throw new BadRequestException(this.i18n.t('file.alreadyCompleted'));
    }

    // 幂等：上一次 complete 已成功（网络重试）时 S3 会话已不存在，直接确认返回，
    // 避免重试路径撞 NoSuchUpload
    const existing = await this.prisma.file.findUnique({
      where: { id: dto.id },
    });
    if (existing) return { id: dto.id, name: dto.name };

    let size: number;
    try {
      size = await this.storage.completeDirectUpload(
        shareId,
        dto.id,
        dto.uploadId,
        dto.parts.map((p): DirectUploadPart => ({
          etag: p.ETag,
          partNumber: p.PartNumber,
        })),
      );
    } catch (e) {
      if (e instanceof StorageCapabilityError) {
        throw new NotFoundException(this.i18n.t('file.s3DirectNotSupported'));
      }
      throw e;
    }

    await this.prisma.file.create({
      data: {
        id: dto.id,
        name: dto.name,
        // BigInt 承载超大文件（>2^31 字节），出 JSON 前 toString
        size: BigInt(size),
        share: { connect: { id: shareId } },
      },
    });
    return { id: dto.id, name: dto.name };
  }

  /** upload-abort：前端上传失败时调用；幂等，会话不存在视为已中止 */
  async abortDirectUpload(shareId: string, dto: UploadAbortDTO) {
    try {
      await this.storage.abortDirectUpload(shareId, dto.uploadId);
    } catch (e) {
      // 不支持的驱动本就没有直传会话，静默成功即可
      if (e instanceof StorageCapabilityError) return;
      throw e;
    }
  }

  /** 读取文件内容（支持 HTTP Range，用于媒体文件拖动播放） */
  async get(
    shareId: string,
    fileId: string,
    rangeHeader?: string,
  ): Promise<FileContentResult> {
    const metaData = await this.prisma.file.findUnique({
      where: { id: fileId },
    });
    if (!metaData || metaData.shareId !== shareId) {
      throw new NotFoundException(this.i18n.t('file.notFound'));
    }
    // 病毒隔离双保险的第二层：存储侧已删是第一层，这里挡住"删除失败仍可读"的残余风险
    if (metaData.scanStatus === 'INFECTED') {
      throw new ForbiddenException(this.i18n.t('file.quarantined'));
    }

    const totalSize = Number(metaData.size);
    const range = parseRangeHeader(rangeHeader, totalSize);
    if (range === 'unsatisfiable') {
      // 416 响应由 controller 层组装（需带 Content-Range: bytes * / total）
      return {
        metaData: this.toMetaData(metaData.name, totalSize, metaData),
        isRangeNotSatisfiable: true,
      };
    }

    // 有区间按区间出流（206）；无区间整文件（200）——区间解析统一在这层，驱动只管按区间出流
    const stream = await this.storage.openContentStream(
      shareId,
      fileId,
      range ?? undefined,
    );

    return {
      metaData: this.toMetaData(metaData.name, totalSize, metaData),
      file: stream,
      range: range ?? undefined,
    };
  }

  private toMetaData(
    name: string,
    size: number,
    row: { id: string; shareId: string },
  ): FileContentResult['metaData'] {
    // mime-types 按扩展名查 Content-Type；未知类型回落 application/octet-stream
    return {
      id: row.id,
      name,
      size,
      mimeType:
        mime.contentType(name.split('.').pop() || '') ||
        'application/octet-stream',
      shareId: row.shareId,
    };
  }

  /** 删除单个文件（存储 + 表记录；表删除失败不回滚存储——孤儿对象由清理任务兜底） */
  async remove(shareId: string, fileId: string) {
    const metaData = await this.prisma.file.findUnique({
      where: { id: fileId },
    });
    if (!metaData || metaData.shareId !== shareId) {
      throw new NotFoundException(this.i18n.t('file.notFound'));
    }
    await this.storage.deleteContent(shareId, fileId).catch(() => {
      // 对象已不在（如清理任务先删了）不算错误，表记录仍需删除
    });
    await this.prisma.file.delete({ where: { id: fileId } });
  }

  /** 删除分享的全部文件：内容 + zip + 本地 tmp 残留（存储侧整段回收） */
  async deleteAllFiles(shareId: string) {
    await this.storage.deleteShare(shareId);
  }

  /**
   * 打包下载的 zip 流：
   * - complete 后台已生成 archive.zip（isZipReady）→ 直接流该文件
   * - 单文件分享无 zip 语义 → 降级为直接流该文件本身（前端"下载全部"按钮仍有意义）
   * - 其余（多文件但 zip 未就绪）→ 400 提示稍后再试
   */
  async getZipStream(
    shareId: string,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { files: { orderBy: { name: 'asc' } } },
    });
    if (!share || !share.uploadLocked) {
      throw new NotFoundException(this.i18n.t('share.notFound'));
    }

    if (share.isZipReady) {
      const zipStream = await this.storage.openZipStream(shareId);
      if (zipStream) {
        return {
          stream: zipStream,
          fileName: `${share.name || shareId}.zip`,
          mimeType: 'application/zip',
        };
      }
    }

    // 单文件降级：流文件本身，文件名保持原名（被隔离的文件同 403 拦截——虽然对象已删）
    if (share.files.length === 1) {
      const only = share.files[0];
      if (only.scanStatus === 'INFECTED') {
        throw new ForbiddenException(this.i18n.t('file.quarantined'));
      }
      return {
        stream: await this.storage.openContentStream(shareId, only.id),
        fileName: only.name,
        mimeType:
          mime.contentType(only.name.split('.').pop() || '') ||
          'application/octet-stream',
      };
    }

    throw new BadRequestException(this.i18n.t('file.zipError'));
  }
}
