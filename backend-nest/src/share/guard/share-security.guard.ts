/**
 * 分享访问安全守卫：公开访问入口（GET /shares/:id、/metaData、zip 下载）的统一门禁
 *
 * 访问令牌模型（与旧后端一致）：
 * - 每个 share 的访问都凭 `share_{id}_token` cookie（JWT，POST /shares/:id/token 签发）
 * - 公开分享：token 只绑定分享 id + 创建时间（防"换内容续命"），无需密码
 * - 密码分享：token 额外携带密码 HMAC 签名——改密码后旧 token 全部失效
 * - 无 token 直接 403（share_token_required），前端先调 token 接口再读分享
 *
 * JWT 在这里是"可选认证"：分享是公开资源，游客可访问，登录态只用于收件人匹配
 * 与管理员越权，所以 super.canActivate 失败仅吞掉不拒绝。
 */
import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import * as crypto from 'node:crypto';
import { JwtAuthGuard } from '../../auth/guard/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../config/config.service';
import { I18nService } from 'nestjs-i18n';
import { NEVER_EXPIRES } from '../share.constants';

/** 分享访问令牌的 JWT 载荷（见 ShareService.generateShareToken） */
export interface ShareTokenClaims {
  shareId: string;
  shareCreatedAt: number;
  sharePasswordSignature?: string;
  iat: number;
  exp?: number;
}

@Injectable()
export class ShareSecurityGuard extends JwtAuthGuard {
  constructor(
    prisma: PrismaService,
    i18n: I18nService,
    // AppConfigService 是 @Global 的，守卫可直接注入（与 JwtAuthGuard 不同层级的依赖）
    protected appConfig: AppConfigService,
    // 分享访问令牌的签发/验签（ShareModule 内注册的 JwtModule 提供）
    protected jwtService: JwtService,
  ) {
    super(prisma, i18n);
  }

  /** 令牌签名密钥：与登录 JWT 共用（env JWT_SECRET，env-loader 在 AppModule 前已加载） */
  protected get jwtSecret(): string {
    return process.env.JWT_SECRET || 'manage_jwt_secret_key';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest();
    // String() 收窄：Express 5 类型里 params 值是 string | string[]
    const shareId = String(request.params.id ?? request.params.shareId ?? '');

    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: {
        security: true,
        reverseShare: true,
        // 收件人体系：userRecipients = 已关联的注册用户；recipients = 邮箱名单
        userRecipients: { select: { userId: true } },
        recipients: { select: { email: true } },
      },
    });
    if (!share) {
      throw new NotFoundException(this.i18n.t('share.notFound'));
    }
    // 缓存到 request：controller 取分享数据时免二次查库
    request.share = share;

    // 可选登录：失败不拒绝（公开资源）
    let user: { id: string; isAdmin: boolean; email: string } | undefined;
    try {
      await super.canActivate(context);
      user = request.currentUser as any;
    } catch {
      user = undefined;
    }

    // ① 管理员越权：需 security.allowAdminAccessAllShares 开启（默认关）
    if (
      user?.isAdmin &&
      (await this.appConfig.getBoolean('security.allowAdminAccessAllShares'))
    ) {
      return true;
    }

    // ② 过期检查：永不过期（unix 0）除外
    if (
      new Date() > share.expiration &&
      share.expiration.getTime() !== NEVER_EXPIRES.getTime()
    ) {
      throw new NotFoundException(this.i18n.t('share.notFound'));
    }

    // ③ 收件人匹配：已关联用户直接放行；邮箱命中则补关联（upsert 幂等）并放行
    if (await this.tryMatchRecipient(share, user)) return true;

    // ④ 限定收件人：除创建者外一律 403（未登录也拦）
    if (
      share.security?.restrictToRecipients &&
      (!user || share.creatorId !== user.id)
    ) {
      throw new ForbiddenException(
        this.i18n.t('share.restrictedToRecipients'),
        'share_restricted_to_recipients',
      );
    }

    // ⑤ 密码前置检查：有密码但没带 token cookie → 提示先输密码（前端弹密码框）
    const shareToken = request.cookies?.[`share_${share.id}_token`] as
      string | undefined;
    if (share.security?.password && !shareToken) {
      throw new ForbiddenException(
        this.i18n.t('file.passwordProtected'),
        'share_password_required',
      );
    }

    // ⑥ 校验访问令牌（签名/归属/有效期/密码签名）
    if (!this.verifyShareToken(share, shareToken)) {
      throw new ForbiddenException(
        this.i18n.t('share.tokenRequired'),
        'share_token_required',
      );
    }

    // ⑦ 私密反向分享：publicAccess=false 时仅令牌创建者与分享创建者可见
    if (
      share.reverseShare &&
      !share.reverseShare.publicAccess &&
      share.creatorId !== user?.id &&
      share.reverseShare.creatorId !== user?.id
    ) {
      throw new ForbiddenException(
        this.i18n.t('share.privateShare'),
        'private_share',
      );
    }

    return true;
  }

  /**
   * 收件人匹配（依赖 share.enableUserRecipients 开关）：
   * - 已在 userRecipients 里 → 直接放行
   * - 账号邮箱（小写比对）命中邮箱名单 → upsert 关联后放行
   * 注意：名单里"未注册的邮箱"不主动探测注册状态，防账号枚举；对方注册后首次访问自动关联
   */
  protected async tryMatchRecipient(
    share: {
      id: string;
      userRecipients: { userId: string }[];
      recipients: { email: string }[];
    },
    user?: { id: string; email: string },
  ): Promise<boolean> {
    if (!user) return false;
    if (!(await this.appConfig.getBoolean('share.enableUserRecipients')))
      return false;

    if (share.userRecipients.some((r) => r.userId === user.id)) return true;

    const userEmail = user.email?.toLowerCase();
    if (
      userEmail &&
      share.recipients.some((r) => r.email.toLowerCase() === userEmail)
    ) {
      await this.prisma.shareUserRecipient.upsert({
        where: { userId_shareId: { userId: user.id, shareId: share.id } },
        create: { userId: user.id, shareId: share.id },
        update: {},
      });
      return true;
    }
    return false;
  }

  /**
   * 校验分享访问令牌：
   * - 验签（本模块 secret 与 auth 共用 JWT_SECRET）
   * - 载荷的 shareId / shareCreatedAt 必须与当前分享一致（分享重建后旧 token 作废）
   * - 有密码的分享：token 里的密码签名必须与当前密码签名一致（改密码即全员下线）
   * - 分享过期时间即 token 过期时间（永不过期的分享签 1 小时短 token）
   */
  verifyShareToken(
    share: {
      id: string;
      createdAt: Date;
      expiration: Date;
      security: { password: string | null } | null;
    },
    token?: string,
  ): boolean {
    if (!token) return false;
    try {
      const claims = this.jwtService.verify<ShareTokenClaims>(token, {
        secret: this.jwtSecret,
        // 永不过期的分享：token 带了 1h 过期，但校验时忽略（否则永久链接每小时断一次）
        ignoreExpiration:
          share.expiration.getTime() === NEVER_EXPIRES.getTime(),
      });
      const passwordSignature = share.security?.password
        ? this.getPasswordSignature(share.security.password)
        : undefined;
      return (
        claims.shareId === share.id &&
        claims.shareCreatedAt ===
          Math.floor(share.createdAt.getTime() / 1000) &&
        (!passwordSignature ||
          claims.sharePasswordSignature === passwordSignature)
      );
    } catch {
      return false;
    }
  }

  /** 密码 HMAC-SHA512 签名（密钥用 JWT_SECRET）——只存签名进 token，不回存明文/哈希 */
  protected getPasswordSignature(password: string): string {
    return crypto
      .createHmac('sha512', this.jwtSecret)
      .update(password)
      .digest('hex');
  }
}
