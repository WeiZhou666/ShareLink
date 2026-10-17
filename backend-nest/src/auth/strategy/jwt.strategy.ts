import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { I18nService } from 'nestjs-i18n';
import { RedisService } from '../../redis/redis.service';
import { AUTH_USER_REVOKE_PREFIX } from '../auth.constants';
import type { JwtPayload } from '../auth.types';

/**
 * JWT 校验策略：token 只从 cookie 中的 access_token 提取（与旧后端一致，不走 Authorization 头）
 * 职责边界：只回答"token 本身是否有效"——验签+过期（本地）→ Redis 用户级吊销键 → Redis 单 token 黑名单
 * validate 返回 payload（passport 挂到 req.user）；User 实体由 JwtAuthGuard 查库补充到 req.currentUser
 * Redis 两级检查 fail-open：故障时由 RedisService 降级为未命中，退化为无黑名单状态
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private redis: RedisService,
    private i18n: I18nService, // 401 消息走 i18n：I18nMiddleware 在守卫/策略之前解析请求语言
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        JwtStrategy.extractJwtFromCookie,
      ]),
      // JWT_SECRET 由 config/env-loader 保证在模块初始化前加载
      secretOrKey: process.env.JWT_SECRET!,
      ignoreExpiration: false,
    });
  }

  private static extractJwtFromCookie(req: Request): string | null {
    return (req.cookies?.access_token as string) ?? null;
  }

  // 校验 jwt 格式（本地验签+过期）
  // 校验用户是否已吊销
  // 校验用户是否在黑名单中
  async validate(payload: JwtPayload): Promise<JwtPayload> {
    // ① 用户级吊销：token 签发时间早于吊销时间戳 → 拒绝（键 TTL = 15 分钟，过后旧 token 已自然过期）
    const revokedAt = await this.redis.get(
      `${AUTH_USER_REVOKE_PREFIX}${payload.sub}`,
    );
    if (revokedAt && (payload.iat ?? 0) * 1000 < Number(revokedAt)) {
      throw new UnauthorizedException(this.i18n.t('auth.loginStateInvalid'));
    }
    // ② 单 token 黑名单：登出后 jti 命中即拒绝
    if (payload.jti && (await this.redis.isInBlackList(payload.jti))) {
      throw new UnauthorizedException(this.i18n.t('auth.loginStateInvalid'));
    }
    // 验签 + 两级黑名单全过：payload 是唯一可信的 JWT 载荷，作为 req.user 流转
    return payload;
  }
}
