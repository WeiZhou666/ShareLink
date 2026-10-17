/**
 * 定时任务集：任务 1-6 对齐旧 React 版后端 jobs.service.ts（清理语义一致，频率已错峰见下），
 * cron 从旧版 5 段（分 时 日 月 周）换算为 Nest 6 段（秒 分 时 日 月 周）；
 * 任务 7 为软删除体系的回收端（旧版硬删即时生效，无此任务）
 *
 * 任务总览（1-6 已从旧版"全部零点"错峰拆开——零点同秒并发 6 个任务会造成
 * MySQL 连接池挤兑 + 磁盘 IO 风暴，间隔 15 分钟保证互不重叠）：
 * 1. deleteExpiredShares        每天 00:05 → 清理已过期的分享（磁盘 + 表记录）；排除软删冷静期用户的分享
 * 2. deleteExpiredReverseShares 每天 00:20 → 清理过期的反向分享令牌（解绑其名下分享并置过期）
 * 3. deleteUnfinishedShares     每天 00:35 → 清理创建超 1 天仍未完成上传的分享
 * 4. deleteExpiredTokens        每天 00:50 → 清理过期的 refresh 会话与失效的重置码
 * 5. deleteUnactivatedUsers     每天 01:05 → 清理注册超 24 小时仍未激活的账号
 * 6. deleteTemporaryFiles       每天 01:20 → 清理超 1 天的分块上传暂存文件（.tmp-chunk）
 * 7. deleteSoftDeletedUsers     每天 02:00 → 物理清除注销冷静期（半年）已满的软删用户
 * 8. rescanErrorFiles           每小时第 20 分 → 重扫病毒扫描失败（ERROR）的文件，CLEAN 后补打 zip
 *
 * 稳定性约定：
 * - 全部任务经 runSafely 统一兜底：@nestjs/schedule 本身不会因任务异常杀进程，
 *   这里再加一层"任务名 + 错误"的可检索日志（旧版部分任务只有内层 catch，外层查询失败裸堆栈）
 * - 幂等即自愈：任务失败下轮自动重试（磁盘回收延迟不丢数据），故频率从低不影响正确性
 *
 * 通用约定（与旧版一致）：
 * - 「先删磁盘再删库」：库记录先删而磁盘删失败会留下无主目录（没有表记录就再也找不到它了）
 * - 单条失败不阻塞其余（磁盘目录可能已被手动删除等），记日志继续
 * - 旧版 deleteExpiredShares 依赖的 share.fileRetentionPeriod（过期后保留期）配置
 *   未迁移到新配置体系，本服务按"到期即清"处理；永不过期分享（NEVER_EXPIRES=1970）
 *   必须显式排除，否则会被误删——这是 deleteExpiredShares 最重要的一行
 *
 * 与旧版的实现差异（均为新后端架构所致，语义不变）：
 * - 删除反向分享不再绕道 ReverseShareService.remove（该方法带创建者/管理员鉴权，
 *   定时任务以系统身份执行，直接在事务里做"解绑 + 置过期 + 删令牌"三步）
 * - 旧版有独立 LoginToken/ResetPasswordToken 表；新后端 TOTP 登录令牌走 Redis（自带
 *   TTL 过期），重置码存在 User 行上——deleteExpiredTokens 据此改为清理
 *   RefreshToken 表 + 重置 User 行上过期的重置码字段
 * - DELETE /users/me 已改为软删除（半年冷静期可恢复），物理清除由任务 7 承担；
 *   任务 1 排除软删用户的分享（磁盘保留到冷静期结束）
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { PrismaService } from '../prisma/prisma.service';
import { FileService } from '../share/file.service';
import { UsersService } from '../users/users.service';
import { ScanService } from '../antivirus/scan.service';
import { ShareService } from '../share/share.service';
import { ACCOUNT_RETENTION_MS } from '../auth/auth.constants';
import { NEVER_EXPIRES } from '../share/share.constants';
import { SHARE_DIRECTORY } from '../share/share.constants';

@Injectable()
export class JobsService {
  constructor(
    private prisma: PrismaService,
    private fileService: FileService,
    private usersService: UsersService, // 任务 7：软删冷静期到期物理清除
    private scanService: ScanService, // 任务 8：病毒扫描 ERROR 重试
    private shareService: ShareService, // 任务 8：重扫 CLEAN 后补打 zip
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /**
   * 任务统一兜底：@nestjs/schedule 对 @Cron 抛出的异常只记日志不杀进程，这里再加一层
   * 「任务名 + 错误」的可检索 error 日志（旧版部分任务只有内层 catch，外层查询失败裸堆栈）
   */
  private async runSafely(task: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      this.logger.error(
        `定时任务 ${task} 执行失败（下轮自动重试）：${(e as Error).message}`,
        {
          context: JobsService.name,
        },
      );
    }
  }

  // ===== 1. 过期分享清理（每天 00:05） =====

  /**
   * 分享过期（expiration < now）后门禁立即生效（公开访问 404），但磁盘文件与表记录
   * 不会自动消失——由本任务回收。每天一轮（磁盘回收延迟不影响访问控制正确性）。
   */
  @Cron('0 5 0 * * *')
  async deleteExpiredShares() {
    await this.runSafely('deleteExpiredShares', async () => {
      const expiredShares = await this.prisma.share.findMany({
        where: {
          // 只清"真过期"的：expiration < now 且 != NEVER_EXPIRES（1970 恒小于 now，
          // "永不过期"的分享必须显式排除）
          expiration: { lt: new Date(), not: NEVER_EXPIRES },
          // 排除软删冷静期用户的分享：注销时分享被置为立即过期以停止访问，
          // 但磁盘要保留到冷静期结束（用户可恢复）——到期由 deleteSoftDeletedUsers
          // 连同磁盘一起物理清理，本任务若抢先清了磁盘，恢复后文件就丢了。
          // creatorId 为 null 的匿名分享壳（历史遗留/用户已物理删）正常回收
          OR: [{ creatorId: null }, { creator: { deletedAt: null } }],
        },
        select: { id: true },
      });

      for (const share of expiredShares) {
        await this.fileService.deleteAllFiles(share.id);
        await this.prisma.share
          .delete({ where: { id: share.id } })
          .catch(() => {
            this.logger.warn(`清理过期分享时删除表记录失败：${share.id}`, {
              context: JobsService.name,
            });
          });
      }

      if (expiredShares.length > 0) {
        this.logger.info(
          `定时清理：删除过期分享 ${expiredShares.length} 个（含磁盘文件）`,
          { context: JobsService.name },
        );
      }
    });
  }

  // ===== 2. 过期反向分享清理（每天 00:20） =====

  /**
   * 反向分享令牌过期（shareExpiration < now）后匿名上传入口已关闭，令牌记录需清掉。
   * 旧版语义：令牌删除时其名下分享全部"解绑 + 置为立即过期"——匿名上传入口没了，
   * 这些分享不能再续传/补文件，交给 deleteExpiredShares（每天 00:05）顺路清磁盘。
   */
  @Cron('0 20 0 * * *')
  async deleteExpiredReverseShares() {
    await this.runSafely('deleteExpiredReverseShares', async () => {
      const expiredReverseShares = await this.prisma.reverseShare.findMany({
        where: { shareExpiration: { lt: new Date() } },
        select: { id: true },
      });

      for (const reverseShare of expiredReverseShares) {
        await this.prisma
          .$transaction([
            // 名下分享解绑（令牌删后 SetNull 也会兜底，这里显式置过期语义更清晰）
            this.prisma.share.updateMany({
              where: { reverseShareId: reverseShare.id },
              data: { reverseShareId: null, expiration: new Date() },
            }),
            this.prisma.reverseShare.delete({ where: { id: reverseShare.id } }),
          ])
          .catch(() => {
            this.logger.warn(
              `清理过期反向分享失败（下轮重试）：${reverseShare.id}`,
              { context: JobsService.name },
            );
          });
      }

      if (expiredReverseShares.length > 0) {
        this.logger.info(
          `定时清理：删除过期反向分享 ${expiredReverseShares.length} 个`,
          { context: JobsService.name },
        );
      }
    });
  }

  // ===== 3. 未完成分享清理（每天 00:35） =====

  /**
   * 上传中断/放弃的分享骨架（uploadLocked=false）超 1 天未动即视为废弃。
   * 新 schema 的 updatedAt 是 @updatedAt 非空字段，创建即有值——旧版里
   * "updatedAt 为空则看 createdAt" 的兜底分支不再需要。
   */
  @Cron('0 35 0 * * *')
  async deleteUnfinishedShares() {
    await this.runSafely('deleteUnfinishedShares', async () => {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const unfinishedShares = await this.prisma.share.findMany({
        where: {
          uploadLocked: false,
          updatedAt: { lt: cutoff },
        },
        select: { id: true },
      });
      // 未完成分享：删除所有文件 + 表记录
      for (const share of unfinishedShares) {
        await this.fileService.deleteAllFiles(share.id);
        await this.prisma.share
          .delete({ where: { id: share.id } })
          .catch(() => {
            this.logger.warn(`清理未完成分享时删除表记录失败：${share.id}`, {
              context: JobsService.name,
            });
          });
      }

      if (unfinishedShares.length > 0) {
        this.logger.info(
          `定时清理：删除未完成分享 ${unfinishedShares.length} 个（超 1 天未完成上传）`,
          { context: JobsService.name },
        );
      }
    });
  }

  // ===== 4. 过期令牌清理（每天 00:50） =====

  /**
   * 旧版清三张 token 表；新后端等价物（auth 模块原 RefreshTokenCleanupService 已并入
   * 本方法，避免重复清理路径，CLEANUP_CRON 环境变量覆盖随之移除）：
   * - RefreshToken 表：expiresAt < now 的会话行（含 revoked 与未 revoked）。
   *   必须保留 expiresAt > now 的行——revoked 行是"重用检测"的证据（旧 token 轮换后
   *   再次出现要能查到 revokedAt 才触发家族吊销）；未 revoked 行是存活会话。
   *   旧 token 一旦自然过期即失去刷新能力，此时无论是否 revoked 都可安全删除
   * - User 行上的重置码字段：resetPasswordTokenExpiresAt < now 的置空
   *   （旧版的 ResetPasswordToken 表删除语义；TOTP 登录令牌在 Redis 自带 TTL，无需处理）
   */
  @Cron('0 50 0 * * *')
  async deleteExpiredTokens() {
    await this.runSafely('deleteExpiredTokens', async () => {
      const { count: refreshTokenCount } =
        await this.prisma.refreshToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });

      const { count: resetCodeCount } = await this.prisma.user.updateMany({
        where: { resetPasswordTokenExpiresAt: { lt: new Date() } },
        data: { resetPasswordToken: null, resetPasswordTokenExpiresAt: null },
      });

      const deletedTokensCount = refreshTokenCount + resetCodeCount;
      if (deletedTokensCount > 0) {
        this.logger.info(
          `定时清理：删除过期 refresh 会话 ${refreshTokenCount} 条、失效重置码 ${resetCodeCount} 个`,
          { context: JobsService.name },
        );
      }
    });
  }

  // ===== 5. 未激活账号清理（每天 01:05） =====

  /**
   * 注册后 24 小时仍未邮箱激活的账号按废弃处理（防注册垃圾堆积）。
   * 管理员后台创建的账号默认已激活，不受本任务影响。
   * 删除顺序沿用 DELETE /users/me 的做法：先删该用户名下分享的磁盘文件
   * （Share.creator 是 SetNull，先删人会导致文件无主），再删用户行（级联清分享/会话）。
   */
  @Cron('0 5 1 * * *')
  async deleteUnactivatedUsers() {
    await this.runSafely('deleteUnactivatedUsers', async () => {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const unactivatedUsers = await this.prisma.user.findMany({
        where: {
          isActivated: false,
          createdAt: { lt: cutoff },
        },
        include: { shares: { select: { id: true } } },
      });

      for (const user of unactivatedUsers) {
        await Promise.all(
          user.shares.map((share) => this.fileService.deleteAllFiles(share.id)),
        );
        await this.prisma.user.delete({ where: { id: user.id } }).catch(() => {
          this.logger.warn(`清理未激活用户时删除账号失败：${user.id}`, {
            context: JobsService.name,
          });
        });
      }

      if (unactivatedUsers.length > 0) {
        this.logger.info(
          `定时清理：删除未激活用户 ${unactivatedUsers.length} 个（注册超 24 小时未激活，含名下分享文件）`,
          { context: JobsService.name },
        );
      }
    });
  }

  // ===== 6. 分块上传暂存文件清理（每天 01:20） =====

  /**
   * 上传中断会在磁盘留下 {shareId}/{fileId}.tmp-chunk 暂存文件（断点续传依赖它们，
   * 不能随删随清）；超过 1 天仍存在即视为永久孤儿（前端续传窗口早已关闭），批量回收。
   * 只扫磁盘不查库：暂存文件本身就没有表记录，mtime 是唯一可靠的废弃判据。
   */
  @Cron('0 20 1 * * *')
  async deleteTemporaryFiles() {
    // 同步 fs 扫描包进 runSafely 统一兜底（readdir/stat 意外抛错不再裸传给调度器）
    await this.runSafely('deleteTemporaryFiles', async () => {
      let filesDeleted = 0;

      // SHARE_DIRECTORY 不存在（从未上传过）时直接跳过，避免 readdir 抛 ENOENT
      if (!fs.existsSync(SHARE_DIRECTORY)) return;

      const shareDirectories = fs
        .readdirSync(SHARE_DIRECTORY, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

      for (const shareDirectory of shareDirectories) {
        const sharePath = path.join(SHARE_DIRECTORY, shareDirectory);
        const temporaryFiles = fs
          .readdirSync(sharePath)
          .filter((file) => file.endsWith('.tmp-chunk'));

        for (const file of temporaryFiles) {
          const stats = fs.statSync(path.join(sharePath, file));
          const isOlderThanOneDay =
            stats.mtime.getTime() < Date.now() - 24 * 60 * 60 * 1000;

          if (isOlderThanOneDay) {
            fs.rmSync(path.join(sharePath, file));
            filesDeleted++;
          }
        }
      }

      if (filesDeleted > 0) {
        this.logger.info(`定时清理：删除分块上传暂存文件 ${filesDeleted} 个`, {
          context: JobsService.name,
        });
      }
    });
  }

  // ===== 7. 软删冷静期到期物理清理（每天 02:00，新增任务——软删除体系的回收端） =====

  /**
   * 对超过冷静期（ACCOUNT_RETENTION_MS = 半年 182 天）的软删用户执行物理删除：
   * 清磁盘 → 吊销会话 → 删行（复用 UsersService.physicallyDeleteUser，幂等）。
   * 每天凌晨一轮；登录侧 recoverAccount 已兜住
   * "到期但任务未跑"的间隙窗口（超期直接拒绝恢复），语义正确性不依赖本任务的实时性。
   * 频率与旧版无对齐关系（旧版无软删除，硬删即时生效）
   */
  @Cron('0 0 2 * * *')
  async deleteSoftDeletedUsers() {
    await this.runSafely('deleteSoftDeletedUsers', async () => {
      const cutoff = new Date(Date.now() - ACCOUNT_RETENTION_MS);
      const expiredUsers = await this.prisma.user.findMany({
        where: { deletedAt: { lt: cutoff } },
        select: { id: true, email: true },
      });

      for (const user of expiredUsers) {
        await this.usersService
          .physicallyDeleteUser(user.id)
          .catch((e: unknown) => {
            this.logger.warn(
              `物理删除软删用户失败：${user.email}（${user.id}）：${String(e)}`,
              {
                context: JobsService.name,
              },
            );
          });
      }

      if (expiredUsers.length > 0) {
        this.logger.info(
          `定时清理：物理删除注销冷静期已满的用户 ${expiredUsers.length} 个（含名下分享文件）`,
          { context: JobsService.name },
        );
      }
    });
  }

  // ===== 8. 病毒扫描失败重试（每小时第 20 分，新增任务——antivirus 体系的自愈端） =====

  /**
   * 重扫 ERROR 状态的文件（ClamAV 不可用/超时/超 StreamMaxLength 时 ScanService 落 ERROR，
   * fail-open：期间下载放行）。clamd 恢复后本任务自动补扫；重扫 CLEAN 的文件若所在分享
   * 多文件且 zip 未就绪 → 补打 zip（首次打包时 ERROR 文件未进包，补扫通过后包里该有它）。
   * 按文件逐个重扫（rescanFile 内部已容错落状态），单条失败不阻塞其余
   */
  @Cron('0 20 * * * *')
  async rescanErrorFiles() {
    await this.runSafely('rescanErrorFiles', async () => {
      const errorFiles = await this.scanService.findRescanCandidates();
      if (errorFiles.length === 0) return;

      let recovered = 0;
      for (const file of errorFiles) {
        const status = await this.scanService.rescanFile(file.shareId, file.id);
        if (status !== 'CLEAN') continue;
        recovered += 1;

        // 补打 zip：多文件 + 已完成上传 + zip 未就绪（ERROR 未进包导致）——
        // 单文件无 zip 语义；已就绪说明包在重扫前已含该文件之外的其他状态，不动
        const share = await this.prisma.share.findUnique({
          where: { id: file.shareId },
          select: {
            uploadLocked: true,
            isZipReady: true,
            _count: { select: { files: true } },
          },
        });
        if (
          share?.uploadLocked &&
          !share.isZipReady &&
          share._count.files > 1
        ) {
          await this.shareService.rebuildZip(file.shareId);
        }
      }

      this.logger.info(
        `病毒扫描重试：重扫 ERROR 文件 ${errorFiles.length} 个，恢复 ${recovered} 个`,
        { context: JobsService.name },
      );
    });
  }
}
