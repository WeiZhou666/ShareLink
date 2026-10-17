import {
  Injectable,
  UnauthorizedException,
  ExecutionContext,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { I18nService } from 'nestjs-i18n';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../auth.types';

/**
 * JWT 认证守卫：配合 @UseGuards(JwtAuthGuard) 按路由启用，两段职责：
 * 1. super.canActivate → JwtStrategy 完成"token 有效性"校验（验签/两级黑名单），payload 挂 req.user
 * 2. 按 payload.sub 查库确认用户存在，User 实体缓存到 req.currentUser（每请求仅查一次），供 @CurrentUser() 读取
 * 未携带有效 access_token、或 token 有效但用户已不存在时返回 401
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    // protected：子类守卫（AdminGuard/share 模块各守卫）复用同一实例查库
    protected prisma: PrismaService,
    // protected：子类 AdminGuard 复用同一实例做授权层的 403 消息翻译
    protected i18n: I18nService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ok = (await super.canActivate(context)) as boolean;
    if (!ok) return false;

    const request = context.switchToHttp().getRequest();
    if (!request.currentUser) {
      const payload = request.user as JwtPayload;
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });
      if (!user) {
        // token 本身有效但用户已被删除：拒绝
        throw new UnauthorizedException(this.i18n.t('auth.loginStateInvalid'));
      }
      request.currentUser = user;
    }
    return true;
  }
}
