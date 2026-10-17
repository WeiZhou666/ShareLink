/**
 * 创建分享守卫：挂在 POST /api/shares 与文件上传路由上
 *
 * 放行两类调用方：
 * 1. 已登录用户（走完整 JWT 认证链）——常规"我的分享"上传
 * 2. 匿名访客但持有有效的 reverse_share_token cookie——通过反向分享链接来上传的人
 *
 * 与 backend-nest 现有守卫风格一致地继承 JwtAuthGuard：
 * JwtStrategy 验签失败会抛 UnauthorizedException，这里 try/catch 吞掉后降级检查反向令牌
 * （旧后端的 JwtGuard 失败时返回 false 而不抛错，行为语义相同，实现适配本项目）。
 */
import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guard/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { I18nService } from 'nestjs-i18n';

@Injectable()
export class CreateShareGuard extends JwtAuthGuard {
  constructor(prisma: PrismaService, i18n: I18nService) {
    super(prisma, i18n);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest();

    // ① 先试 JWT：成功即放行（req.currentUser 同时被填充）
    try {
      const ok = await super.canActivate(context);
      if (ok) return true;
    } catch {
      // 未登录/令牌无效：不立即拒绝，继续尝试反向分享令牌
    }

    // ② 反向分享 cookie：前端 setReverseShare 时写入（非 httpOnly，同站 cookie）
    const reverseShareToken = request.cookies?.['reverse_share_token'] as
      string | undefined;
    if (!reverseShareToken) {
      throw new UnauthorizedException(this.i18n.t('auth.unauthorized'));
    }

    // ③ 校验反向令牌有效性：存在、未过期、剩余次数 > 0（无效令牌显式 401，不用裸 false——
    //   守卫 return false 会被 Nest 转成 ForbiddenException，话术反而不清晰）
    const reverseShare = await this.prisma.reverseShare.findUnique({
      where: { token: reverseShareToken },
    });
    const isExpired = reverseShare && new Date() > reverseShare.shareExpiration;
    const usesExhausted = reverseShare && reverseShare.remainingUses <= 0;
    if (!reverseShare || isExpired || usesExhausted) {
      throw new UnauthorizedException(this.i18n.t('reverseShare.notFound'));
    }
    return true;
  }
}
