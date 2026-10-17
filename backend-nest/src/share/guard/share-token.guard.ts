/**
 * 令牌签发前置守卫：POST /shares/:id/token 专用
 *
 * 为什么不用 ShareSecurityGuard：签发端点是"换令牌"的入口，此时请求方必然还没有
 * 有效令牌（密码分享）或从未访问过（公开分享首次打开）——用它校验会形成死锁
 * （没令牌 → 拿不到令牌）。这里只做轻量检查：分享存在、已完成、未过期。
 * 密码正确性/最大查看次数由 ShareService.getShareToken 校验（需要读 body）。
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { I18nService } from 'nestjs-i18n';
import { NEVER_EXPIRES } from '../share.constants';

@Injectable()
export class ShareTokenGuard implements CanActivate {
  constructor(
    private prisma: PrismaService,
    private readonly i18n: I18nService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    // String() 收窄：Express 5 类型里 params 值是 string | string[]
    const shareId = String(request.params.id ?? request.params.shareId ?? '');

    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });
    if (!share || !share.uploadLocked) {
      throw new NotFoundException(this.i18n.t('share.notFound'));
    }
    if (
      new Date() > share.expiration &&
      share.expiration.getTime() !== NEVER_EXPIRES.getTime()
    ) {
      throw new NotFoundException(this.i18n.t('share.notFound'));
    }
    return true;
  }
}
