/**
 * 文件安全守卫：文件下载（GET /shares/:shareId/files/:fileId）与 zip 下载的门禁
 *
 * 两条通路（与旧后端 FileSecurityGuard 一致）：
 * - 带 share_{id}_token cookie：走父类 ShareSecurityGuard 的完整校验
 *   （正常入口：ShareView 先调 POST /:id/token 再展示文件列表，cookie 已就位）
 * - 不带 token（浏览器 <img>/<video> 直接请求、第三方下载工具）：
 *   独立校验——公开分享放行并计一次浏览；密码/限定收件人分享不放行（无法弹密码框）
 */
import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { ShareSecurityGuard } from './share-security.guard';
import { NEVER_EXPIRES } from '../share.constants';

@Injectable()
export class FileSecurityGuard extends ShareSecurityGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest();
    // String() 收窄：Express 5 类型里 params 值是 string | string[]
    const shareId = String(request.params.shareId ?? request.params.id ?? '');

    // 分享 ID 格式前置校验：防路径穿越（/../ 等）与无意义查库
    if (!/^[a-zA-Z0-9_-]*={0,2}$/.test(shareId)) {
      throw new NotFoundException(this.i18n.t('file.notFound'));
    }

    const shareToken = request.cookies?.[`share_${shareId}_token`] as
      string | undefined;

    // 有访问令牌：父类完整校验（密码/收件人/私密反向分享等）
    if (shareToken) {
      return super.canActivate(context);
    }

    // ---- 无令牌的直连访问 ----
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: {
        security: true,
        userRecipients: { select: { userId: true } },
        recipients: { select: { email: true } },
      },
    });
    if (!share) {
      throw new NotFoundException(this.i18n.t('file.notFound'));
    }
    request.share = share;

    // 可选登录（管理员越权/收件人匹配需要）
    let user: { id: string; isAdmin: boolean; email: string } | undefined;
    try {
      await super.canActivate(context);
      user = request.currentUser as any;
    } catch {
      user = undefined;
    }

    if (
      user?.isAdmin &&
      (await this.appConfig.getBoolean('security.allowAdminAccessAllShares'))
    ) {
      return true;
    }

    if (
      new Date() > share.expiration &&
      share.expiration.getTime() !== NEVER_EXPIRES.getTime()
    ) {
      throw new NotFoundException(this.i18n.t('file.notFound'));
    }

    if (share.security?.restrictToRecipients) {
      const isCreator = user && share.creatorId === user.id;
      const isRecipient = await this.tryMatchRecipient(share, user);
      if (!isCreator && !isRecipient) {
        throw new ForbiddenException(
          this.i18n.t('share.restrictedToRecipients'),
          'share_restricted_to_recipients',
        );
      }
    }

    // 密码分享直连不放行：必须先走 token 流程（否则密码形同虚设）
    if (share.security?.password) {
      throw new ForbiddenException(this.i18n.t('file.passwordProtected'));
    }

    if (share.security?.maxViews && share.security.maxViews <= share.views) {
      throw new ForbiddenException(
        this.i18n.t('share.maxViewsExceeded'),
        'share_max_views_exceeded',
      );
    }

    // 直连访问计一次浏览（带 token 的在签发接口已计过）
    await this.prisma.share.update({
      where: { id: share.id },
      data: { views: { increment: 1 } },
    });
    return true;
  }
}
