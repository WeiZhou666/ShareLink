/**
 * 分享服务：分享生命周期（创建 → 上传 → 完成）+ 公开访问（令牌签发/校验）+ 管理操作
 *
 * 生命周期：
 *   create        建"分享骨架"（uploadLocked=false），此时仅创建者可见
 *   （分块上传）   FileService.createChunk 逐块落盘，File 表逐文件登记
 *   complete      加锁（uploadLocked=true）→ 对外可访问；多文件后台打 zip；
 *                  反向分享扣减剩余次数；收件人按邮箱自动关联注册账号
 *   revertComplete 解锁重新上传（编辑场景）
 *   remove/expire 删除（含磁盘清理）/ 立即过期
 *
 * 公开访问：凭 share_{id}_token cookie（JWT）——签发与验签逻辑集中在本服务，
 * 守卫（ShareSecurityGuard）只做"过没过门禁"的判断。
 */
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as argon from 'argon2';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Inject } from '@nestjs/common';
import { Logger } from 'winston';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';
import { ScanService } from '../antivirus/scan.service';
import { EmailService } from '../email/email.service';
import { I18nService } from 'nestjs-i18n';
import archiver from 'archiver';
import { FileService } from './file.service';
import { FILE_STORAGE } from './storage/storage.backend';
import type { StorageBackend } from './storage/storage.backend';
import { SHARE_DIRECTORY, NEVER_EXPIRES } from './share.constants';
import { isValidISODate, parseRelativeDateToAbsolute } from './share.utils';
import { CreateShareDTO } from './dto/create-share.dto';
import { UpdateShareDTO } from './dto/update-share.dto';
import type { User } from '@prisma/client';

/** include 形状：管理类接口返回的完整分享（文件 + 创建者 + 策略 + 收件人 + 反向来源） */
const SHARE_FULL_INCLUDE = {
  files: { orderBy: { name: 'asc' as const } },
  creator: true,
  security: true,
  recipients: true,
  userRecipients: { select: { userId: true } },
  reverseShare: { include: { creator: true } },
} satisfies Prisma.ShareInclude;

@Injectable()
export class ShareService {
  constructor(
    private prisma: PrismaService,
    private appConfig: AppConfigService,
    private fileService: FileService,
    private emailService: EmailService,
    private scanService: ScanService, // complete 后触发病毒扫描（先扫描后打 zip）
    private jwtService: JwtService,
    private readonly i18n: I18nService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    @Inject(FILE_STORAGE) private readonly fileStorage: StorageBackend, // zip 的源流与汇走存储驱动
  ) {}

  // ==================== 创建 ====================

  /**
   * 创建分享骨架
   * @param dto 前端上传弹窗表单
   * @param user 创建者（经反向分享链接上传时为 undefined）
   * @param reverseShareToken 命中的反向分享令牌（cookie 里带过来的）
   */
  async create(dto: CreateShareDTO, user?: User, reverseShareToken?: string) {
    // 反向分享：令牌有效性在 CreateShareGuard 已验过，这里取实体用于过期覆盖与归属
    const reverseShare = reverseShareToken
      ? await this.prisma.reverseShare.findUnique({
          where: { token: reverseShareToken },
        })
      : null;

    // 自定义分享 ID 查重（ID 是公开链接的一部分，允许自选但要唯一）
    if (!(await this.isShareIdAvailable(dto.id)).isAvailable) {
      throw new BadRequestException(this.i18n.t('share.idInUse'));
    }

    // 安全策略归一化：空对象视为无策略
    const security =
      dto.security && Object.keys(dto.security).length > 0
        ? dto.security
        : undefined;
    // 密码 + 限定收件人互斥：限定收件人本身已是强约束，密码会挡住真正的收件人
    if (security?.restrictToRecipients && security.password) {
      throw new BadRequestException(
        'Cannot set a password on a share restricted to recipients.',
      );
    }
    // 限定收件人必须真的给了名单
    if (security?.restrictToRecipients) {
      if (!(await this.appConfig.getBoolean('share.enableUserRecipients'))) {
        throw new BadRequestException(
          this.i18n.t('share.restrictedToRecipients'),
        );
      }
      if (!dto.recipients?.length) {
        throw new BadRequestException(
          'A share restricted to recipients must have at least one recipient.',
        );
      }
    }
    // 明文密码立即哈希（argon2id，与登录密码同算法）
    const hashedPassword = security?.password
      ? await argon.hash(security.password)
      : undefined;

    // 过期时间：反向分享强制覆盖为令牌设定的值；否则按用户选择解析并受 maxExpiration 约束
    let expirationDate: Date;
    if (reverseShare) {
      expirationDate = reverseShare.shareExpiration;
    } else {
      expirationDate = this.parseExpiration(dto.expiration);
      if (!user?.isAdmin) {
        await this.validateExpiration(expirationDate);
      }
    }

    // 建库：安全策略/收件人/反向归属一并嵌套创建；目录同步建好等分块写入
    const share = await this.prisma.share.create({
      data: {
        id: dto.id,
        name: dto.name || null,
        description: dto.description || null,
        expiration: expirationDate,
        creator: user ? { connect: { id: user.id } } : undefined,
        security:
          hashedPassword || security?.maxViews || security?.restrictToRecipients
            ? {
                create: {
                  password: hashedPassword,
                  maxViews: security?.maxViews ?? null,
                  restrictToRecipients: security?.restrictToRecipients ?? false,
                },
              }
            : undefined,
        recipients: {
          // 名单不做注册状态探测——防账号枚举；complete 时自动匹配注册账号
          create: dto.recipients?.map((email) => ({ email })) ?? [],
        },
        reverseShare: reverseShare
          ? { connect: { id: reverseShare.id } }
          : undefined,
        // 存储后端落库固化：本期仅本地盘（S3 迁移后按配置写入）
        storageProvider: 'LOCAL',
      },
      include: SHARE_FULL_INCLUDE,
    });

    fs.mkdirSync(path.join(SHARE_DIRECTORY, share.id), { recursive: true });
    return this.transformShare(share);
  }

  // ==================== 完成 / 回退 ====================

  /**
   * 完成分享：上传收尾，分享对外可见
   * 返回值带 notifyReverseShareCreator（旧 API 契约）：本期未迁移邮件模板，恒为 undefined
   */
  async complete(id: string, reverseShareToken?: string) {
    const share = await this.prisma.share.findUnique({
      where: { id },
      include: { files: true, recipients: true, reverseShare: true },
    });
    if (!share) throw new NotFoundException(this.i18n.t('share.notFound'));
    if (share.uploadLocked) {
      throw new BadRequestException(this.i18n.t('share.alreadyCompleted'));
    }
    if (share.files.length === 0) {
      throw new BadRequestException(
        this.i18n.t('share.completionRequiresFile'),
      );
    }

    // 病毒扫描 → 扫完再打 zip（先扫描后打包，INFECTED 文件绝不进包）；
    // 202 立即返回，扫描在后台异步进行（前端文件列表会短暂显示"扫描中"）。
    // 单文件无 zip 语义，只扫状态不传 onDone；扫描关闭时 scanShare 内部直接落 CLEAN 后继续打包
    const onDone =
      share.files.length > 1 ? () => this.createZip(id) : undefined;
    void this.scanService.scanShare(id, onDone).catch((e) => {
      // scanShare 内部已逐文件容错，这里兜的是编排本身的意外（如 zip 回调抛错）
      this.logger.error(`分享 ${id} 扫描编排异常：${(e as Error).message}`);
    });

    // 收件人邮箱命中注册账号 → 自动挂到"收到的分享"（幂等 upsert）
    if (await this.appConfig.getBoolean('share.enableUserRecipients')) {
      const emails = share.recipients.map((r) => r.email);
      if (emails.length > 0) {
        const matched = await this.prisma.user.findMany({
          where: { email: { in: emails } },
          select: { id: true },
        });
        for (const matchedUser of matched) {
          await this.prisma.shareUserRecipient.upsert({
            where: {
              userId_shareId: { userId: matchedUser.id, shareId: share.id },
            },
            create: { userId: matchedUser.id, shareId: share.id },
            update: {},
          });
        }
      }
    }

    // 反向分享：扣减剩余次数（CreateShareGuard 已把 0 次的令牌挡在门外）
    if (share.reverseShare) {
      await this.prisma.reverseShare.update({
        where: { id: share.reverseShare.id },
        data: { remainingUses: { decrement: 1 } },
      });
      // 注意：remainingUses 用 decrement 原子递减，并发 complete 不会少扣
    }

    // 给反向令牌创建者/收件人发通知邮件的链路本期未迁移（EmailService 暂无模板）——预留字段语义不变

    const updated = await this.prisma.share.update({
      where: { id },
      data: { uploadLocked: true },
    });
    // 返回完整分享形态（前端完成弹窗消费 id 等字段）+ 旧 API 契约字段
    const full = await this.prisma.share.findUnique({
      where: { id: updated.id },
      include: SHARE_FULL_INCLUDE,
    });
    return {
      ...this.transformShare(full!),
      notifyReverseShareCreator: undefined,
    };
  }

  /** 重新打开上传（编辑场景：删文件/补传后需再次 complete） */
  async revertComplete(id: string) {
    return this.prisma.share.update({
      where: { id },
      data: { uploadLocked: false, isZipReady: false },
    });
  }

  /**
   * 后台生成 archive.zip：所有文件按原名打包（shell 用流式 append，避免整包进内存）
   * 失败仅记日志——分享仍可用（逐文件下载），zip 下载端点会兜底提示
   */
  private async createZip(shareId: string) {
    // 只打包扫描通过（及 ERROR fail-open）的文件；INFECTED 已删存储对象，绝不进包。
    // 全部文件被隔离时 files 为空：跳过打包（空 zip 无意义），isZipReady 保持 false
    const files = await this.prisma.file.findMany({
      where: { shareId, scanStatus: { not: 'INFECTED' } },
    });
    if (files.length === 0) return;
    const archive = archiver('zip', {
      zlib: {
        level: await this.appConfig.getNumber('share.zipCompressionLevel'),
      },
    });
    try {
      for (const file of files) {
        // 源流由存储驱动出（local 磁盘流 / s3 GetObject 流），按原名进包
        archive.append(
          await this.fileStorage.openContentStream(shareId, file.id),
          { name: file.name },
        );
      }
      // 收尾归档输入：不 finalize 则归档永不结束——saveZip 的 pipe close / Upload done
      // 都会无错挂起（zip 打包"卡死"而非失败）。归档由本方法持有，收尾职责也在这
      await archive.finalize();
      // 汇也在存储驱动：local 写 {shareId}/archive.zip / s3 Upload 到同名键
      await this.fileStorage.saveZip(shareId, archive);
      await this.prisma.share.update({
        where: { id: shareId },
        data: { isZipReady: true },
      });
      this.logger.info(
        `分享 ${shareId} 的 zip 打包完成（${files.length} 个文件）`,
      );
    } catch (e) {
      this.logger.error(
        `分享 ${shareId} zip 打包失败：${(e as Error).message}`,
      );
      // 半成品清理已由存储驱动负责（saveZip 内自清），下次 complete 回退后重试可再生成
    }
  }

  // ==================== 查询 ====================

  /** jobs 任务 8 补打 zip 的公开入口（createZip 保持 private——外部只能按需重建，不能随意直调） */
  async rebuildZip(shareId: string) {
    await this.createZip(shareId);
  }

  /** 公开访问的分享详情（ShareSecurityGuard 已过门禁，这里只管取数与整形） */
  async get(id: string) {
    const share = await this.prisma.share.findUnique({
      where: { id },
      include: {
        files: { orderBy: { name: 'asc' } },
        creator: true,
        security: true,
      },
    });
    if (!share || !share.uploadLocked) {
      throw new NotFoundException(this.i18n.t('share.notFound'));
    }
    return this.transformShare(share);
  }

  /** 所有者视角取分享（ShareEditView 编辑页用；不过期也不隐藏，本人可管） */
  async getFromOwner(id: string) {
    const share = await this.prisma.share.findUnique({
      where: { id },
      include: SHARE_FULL_INCLUDE,
    });
    if (!share) throw new NotFoundException(this.i18n.t('share.notFound'));
    return this.transformShare(share);
  }

  /** 元数据（旧 API：前端上传完成页轮询 zip 状态用） */
  async getMetaData(id: string) {
    const share = await this.prisma.share.findUnique({ where: { id } });
    if (!share || !share.uploadLocked) {
      throw new NotFoundException(this.i18n.t('share.notFound'));
    }
    return { id: share.id, isZipReady: share.isZipReady };
  }

  /** 我的分享列表：只返回"已完成且未过期"的（永不过期的恒在） */
  async getSharesByUser(userId: string) {
    const shares = await this.prisma.share.findMany({
      where: {
        creatorId: userId,
        uploadLocked: true,
        OR: [
          { expiration: { gt: new Date() } },
          { expiration: { equals: NEVER_EXPIRES } },
        ],
      },
      orderBy: { expiration: 'desc' },
      include: SHARE_FULL_INCLUDE,
    });
    return shares.map((s) => this.transformShare(s));
  }

  /** 收到的分享：挂给 userId 的分享列表（收件人自动关联的产物），拍平成分享对象 */
  async getReceivedShares(userId: string) {
    const links = await this.prisma.shareUserRecipient.findMany({
      where: { userId },
      include: { share: { include: SHARE_FULL_INCLUDE } },
      orderBy: { createdAt: 'desc' },
    });
    return links
      .filter((l) => l.share)
      .map((l) => ({
        ...this.transformShare(l.share),
        receivedAt: l.createdAt,
      }));
  }

  // ==================== 管理（所有者） ====================

  /** 更新分享基本信息与安全策略（字段级"未传不改"语义见 UpdateShareDTO 注释） */
  async update(shareId: string, dto: UpdateShareDTO, user?: User) {
    const current = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { security: true },
    });
    if (!current) throw new NotFoundException(this.i18n.t('share.notFound'));

    // 过期时间变更：非管理员仍受 maxExpiration 约束
    let expirationDate: Date | undefined;
    if (dto.expiration !== undefined) {
      expirationDate = this.parseExpiration(dto.expiration);
      if (!user?.isAdmin) await this.validateExpiration(expirationDate);
    }

    await this.prisma.share.update({
      where: { id: shareId },
      data: {
        // null 或空串 = 清空（前端编辑框清空后保存的语义）
        name: dto.name !== undefined ? dto.name || null : undefined,
        description:
          dto.description !== undefined ? dto.description || null : undefined,
        expiration: expirationDate,
      },
    });

    // 安全策略增量更新：removePassword 显式删密码 > password 设新密码 > 维持原值
    if (dto.security) {
      const nextPassword = dto.security.removePassword
        ? null
        : dto.security.password
          ? await argon.hash(dto.security.password)
          : (current.security?.password ?? null);
      const nextMaxViews =
        dto.security.maxViews !== undefined
          ? dto.security.maxViews
          : (current.security?.maxViews ?? null);

      // 无密码也无 maxViews → 策略行直接删掉（保持"无策略 = 无行"的约定）
      if (!nextPassword && !nextMaxViews) {
        if (current.security) {
          await this.prisma.shareSecurity.delete({ where: { shareId } });
        }
      } else {
        await this.prisma.shareSecurity.upsert({
          where: { shareId },
          create: {
            shareId,
            password: nextPassword,
            maxViews: nextMaxViews ?? null,
          },
          update: { password: nextPassword, maxViews: nextMaxViews ?? null },
        });
      }
    }

    const updated = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: SHARE_FULL_INCLUDE,
    });
    return this.transformShare(updated!);
  }

  /**
   * 删除分享：磁盘目录清理 + 表记录级联删除
   * 匿名分享（反向分享产生）不允许非管理员删除——上传者不留名，防止恶意清空他人收集
   */
  async remove(shareId: string, isDeleterAdmin = false) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });
    if (!share) throw new NotFoundException(this.i18n.t('share.notFound'));
    if (!share.creatorId && !isDeleterAdmin) {
      throw new ForbiddenException(this.i18n.t('share.anonymousNoDelete'));
    }
    await this.fileService.deleteAllFiles(shareId);
    await this.prisma.share.delete({ where: { id: shareId } });
  }

  /** 立即过期：expiration 置为当前时间（不删数据，门禁立即生效） */
  async expire(shareId: string) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });
    if (!share) throw new NotFoundException(this.i18n.t('share.notFound'));
    if (!share.creatorId) {
      throw new ForbiddenException(this.i18n.t('share.anonymousNoExpire'));
    }
    await this.prisma.share.update({
      where: { id: shareId },
      data: { expiration: new Date() },
    });
  }

  async isShareIdAvailable(id: string) {
    const share = await this.prisma.share.findUnique({ where: { id } });
    return { isAvailable: !share };
  }

  // ==================== 访问令牌 ====================

  /**
   * 校验密码并签发分享访问令牌（POST /:id/token）
   * cookie 落地由 controller 完成（需要写响应头）。
   * 注意：签发即计一次浏览（views +1）——与旧后端一致，浏览数 = 打开分享页次数
   *
   * @param existingToken 请求方已持有的旧令牌（cookie 里带来的，可为空）：
   *   有效旧令牌 → 免密续签。对应旧后端 ShareTokenSecurityGuard 的语义——
   *   密码分享的访问者刷新页面时前端会先 POST /token（不带密码），若此时
   *   强制重输密码，每次刷新都要打一遍密码，体验不可接受。续签路径跳过
   *   密码/最大查看次数检查（能持有有效令牌说明当初已通过全部门禁）
   */
  async getShareToken(
    shareId: string,
    password?: string,
    existingToken?: string,
  ) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { security: true },
    });
    if (!share || !share.uploadLocked) {
      throw new NotFoundException(this.i18n.t('share.notFound'));
    }
    // 已过期（非永久）不可再换令牌
    if (
      new Date() > share.expiration &&
      share.expiration.getTime() !== NEVER_EXPIRES.getTime()
    ) {
      throw new NotFoundException(this.i18n.t('share.notFound'));
    }

    // ---- 免密续签路径：旧令牌验签通过 → 直接换新令牌 ----
    if (existingToken && (await this.isValidShareToken(existingToken, share))) {
      const token = await this.generateShareToken(share);
      await this.prisma.share.update({
        where: { id: share.id },
        data: { views: { increment: 1 } },
      });
      return token;
    }

    // 密码校验：错误统一话术（不区分"无密码分享"与"密码错误"，防探测）
    if (share.security?.password) {
      if (!password) {
        throw new HttpException(
          {
            message: this.i18n.t('file.passwordProtected'),
            error: 'share_password_required',
          },
          HttpStatus.FORBIDDEN,
        );
      }
      const ok = await argon
        .verify(share.security.password, password)
        .catch(() => false);
      if (!ok) {
        throw new HttpException(
          {
            message: this.i18n.t('share.wrongPassword'),
            error: 'wrong_password',
          },
          HttpStatus.FORBIDDEN,
        );
      }
    }

    // 最大查看次数：签发令牌 = 一次查看，超限拒绝
    if (share.security?.maxViews && share.security.maxViews <= share.views) {
      throw new HttpException(
        {
          message: this.i18n.t('share.maxViewsExceeded'),
          error: 'share_max_views_exceeded',
        },
        HttpStatus.FORBIDDEN,
      );
    }

    const token = await this.generateShareToken(share);
    await this.prisma.share.update({
      where: { id: share.id },
      data: { views: { increment: 1 } },
    });
    return token;
  }

  /**
   * 生成分享访问令牌（JWT，签名密钥与登录 token 共用）：
   * - 载荷绑定 shareId + createdAt：分享删除重建后旧 token 自动作废
   * - 密码分享额外带密码 HMAC 签名：改密码后旧 token 全部失效（无需逐个吊销）
   * - 有效期 = 分享剩余时间；永不过期的分享签 1 小时短 token（验证时忽略 exp）
   */
  private async generateShareToken(share: {
    id: string;
    createdAt: Date;
    expiration: Date;
    security: { password: string | null } | null;
  }) {
    const payload = {
      shareId: share.id,
      shareCreatedAt: Math.floor(share.createdAt.getTime() / 1000),
      sharePasswordSignature: share.security?.password
        ? this.getPasswordSignature(share.security.password)
        : undefined,
    };

    const options: { expiresIn?: number } = {};
    if (share.expiration.getTime() !== NEVER_EXPIRES.getTime()) {
      const diffSeconds = Math.floor(
        (share.expiration.getTime() - Date.now()) / 1000,
      );
      // 已过期分享（管理员越权查看场景）给 1 小时令牌兜底
      options.expiresIn = diffSeconds > 0 ? diffSeconds : 3600;
    }
    return this.jwtService.sign(payload, {
      secret: process.env.JWT_SECRET || 'manage_jwt_secret_key',
      expiresIn: options.expiresIn ?? '1h',
    });
  }

  /**
   * 校验一个已存在的分享令牌是否对当前分享有效（免密续签用）。
   * 校验维度与 ShareSecurityGuard.verifyShareToken 完全一致，两处必须同步修改：
   *   1. JWT 验签（密钥 = JWT_SECRET）——伪造的令牌过不了
   *   2. shareId 绑定——A 分享的令牌不能开 B 分享
   *   3. shareCreatedAt 绑定——分享删除后重建（同 ID）旧令牌自动作废
   *   4. 密码签名比对——改密码后所有旧令牌失效（无需逐个吊销）
   *   5. 永不过期分享的令牌 exp 很短，验签时忽略 exp（门禁按分享过期时间另判）
   * 任何一步失败都返回 false（静默降级为正常密码流程），不抛错。
   */
  private async isValidShareToken(
    token: string,
    share: {
      id: string;
      createdAt: Date;
      expiration: Date;
      security: { password: string | null } | null;
    },
  ): Promise<boolean> {
    try {
      const payload = await this.jwtService.verifyAsync<{
        shareId: string;
        shareCreatedAt: number;
        sharePasswordSignature?: string;
      }>(token, {
        secret: process.env.JWT_SECRET || 'manage_jwt_secret_key',
        // 永不过期分享签的是 1h 短令牌（见 generateShareToken），这里忽略 exp：
        // 真正的"过期门禁"由分享自身的 expiration 判定，而不是令牌的 exp
        ignoreExpiration:
          share.expiration.getTime() === NEVER_EXPIRES.getTime(),
      });
      if (payload.shareId !== share.id) return false;
      if (
        payload.shareCreatedAt !== Math.floor(share.createdAt.getTime() / 1000)
      )
        return false;
      if (share.security?.password) {
        // 密码签名 = 对 argon 哈希的 HMAC（见 getPasswordSignature），不是对明文
        if (
          payload.sharePasswordSignature !==
          this.getPasswordSignature(share.security.password)
        ) {
          return false;
        }
      }
      return true;
    } catch {
      return false; // 验签失败/令牌过期/格式错误 → 当作没有令牌
    }
  }

  /** 密码签名（HMAC-SHA512，密钥 = JWT_SECRET）——只出签名，不落明文/哈希进 token */
  private getPasswordSignature(password: string): string {
    return crypto
      .createHmac('sha512', process.env.JWT_SECRET || 'manage_jwt_secret_key')
      .update(password)
      .digest('hex');
  }

  /**
   * 把分享链接发到指定邮箱（上传完成弹窗"发送到邮箱"）
   * 仅分享所有者/管理员可调（守卫 ShareOwnerGuard），邮件 fail-open 不阻断
   */
  async emailShareLink(shareId: string, to: string, lang?: string) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });
    if (!share || !share.uploadLocked) {
      throw new NotFoundException(this.i18n.t('share.notFound'));
    }
    const frontendUrl = (
      process.env.FRONTEND_URL || 'http://localhost:3001'
    ).replace(/\/$/, '');
    const shareUrl = `${frontendUrl}/s/${share.id}`;
    await this.emailService.sendShareLink(
      to,
      share.name || share.id,
      shareUrl,
      lang,
    );
  }

  // ==================== 私有工具 ====================

  /**
   * 过期时间归一化：'never' | '3days'/'3-days' | ISO → Date（非法输入 400）
   * 兼容两种相对时间分隔形式（前端弹窗发送 "3days"，旧客户端可能是 "3-days"）
   */
  private parseExpiration(expiration: string): Date {
    if (expiration === 'never') return NEVER_EXPIRES;
    if (
      /^\d+-(seconds|minutes|hours|days|weeks|months|years)$/.test(
        expiration,
      ) ||
      /^\d+(seconds|minutes|hours|days|weeks|months|years)$/.test(expiration)
    ) {
      return parseRelativeDateToAbsolute(expiration);
    }
    if (isValidISODate(expiration)) return new Date(expiration);
    throw new BadRequestException(this.i18n.t('share.invalidExpiration'));
  }

  /**
   * 非管理员的最大有效期约束（share.maxExpiration，"0 days" = 不限制）
   * 永不过期也视为超限——普通用户不允许创建永久链接
   */
  private async validateExpiration(expiration: Date) {
    const maxExpiration = await this.appConfig.get('share.maxExpiration');
    const [valueStr, unit] = maxExpiration.split(' ');
    const maxValue = parseInt(valueStr);
    if (maxValue === 0) return;
    const expiresNever = expiration.getTime() === NEVER_EXPIRES.getTime();
    const limit = new Date();
    switch (unit) {
      case 'minutes':
        limit.setMinutes(limit.getMinutes() + maxValue);
        break;
      case 'hours':
        limit.setHours(limit.getHours() + maxValue);
        break;
      case 'days':
        limit.setDate(limit.getDate() + maxValue);
        break;
      case 'weeks':
        limit.setDate(limit.getDate() + maxValue * 7);
        break;
      case 'months':
        limit.setMonth(limit.getMonth() + maxValue);
        break;
      case 'years':
        limit.setFullYear(limit.getFullYear() + maxValue);
        break;
    }
    if (expiresNever || expiration > limit) {
      throw new BadRequestException(this.i18n.t('share.maxExpirationExceeded'));
    }
  }

  /**
   * 响应整形（旧 API 契约）：
   * - size = 文件字节数合计（BigInt 求和转 string 保持精度，前端 byteToHumanSizeString 可处理）
   * - security 收敛为三个布尔/数字，绝不回传密码哈希
   * - creator 只暴露用户名（邮箱不随公开分享泄露）
   *
   * 参数用手写结构类型而非 Prisma GetPayload：公开读取路径（get）故意用子集
   * include（不查 recipients/userRecipients/reverseShare），管理路径用全量 include，
   * 两种结果都要能进来——扩展键全部可选，内部 ?. / ?? [] 容错
   */
  private transformShare(share: {
    id: string;
    name: string | null;
    description: string | null;
    createdAt: Date;
    expiration: Date;
    views: number;
    uploadLocked: boolean;
    isZipReady: boolean;
    files: { id: string; name: string; size: bigint; createdAt: Date }[];
    creator: { username: string } | null;
    security: {
      password: string | null;
      maxViews: number | null;
      restrictToRecipients: boolean;
    } | null;
    recipients?: { email: string }[];
    reverseShare?: { token: string; publicAccess: boolean } | null;
  }) {
    return {
      id: share.id,
      name: share.name,
      description: share.description,
      createdAt: share.createdAt,
      expiration: share.expiration,
      views: share.views,
      uploadLocked: share.uploadLocked,
      isZipReady: share.isZipReady,
      size: share.files.reduce((sum, f) => sum + f.size, 0n).toString(),
      creator: share.creator ? { username: share.creator.username } : null,
      recipients: share.recipients?.map((r) => r.email) ?? [],
      files: share.files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size.toString(),
        createdAt: f.createdAt,
      })),
      security: {
        passwordProtected: !!share.security?.password,
        maxViews: share.security?.maxViews ?? undefined,
        restrictToRecipients: !!share.security?.restrictToRecipients,
      },
      reverseShare: share.reverseShare
        ? {
            token: share.reverseShare.token,
            publicAccess: share.reverseShare.publicAccess,
          }
        : null,
      hasPassword: !!share.security?.password,
    };
  }
}
