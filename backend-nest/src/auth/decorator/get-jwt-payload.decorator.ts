import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from '../auth.types';

/**
 * 从请求中取出验签后的 JWT payload（jti / refreshTokenId 等非 User 字段）
 * 注意：req.user 即 JwtStrategy.validate 返回的 JwtPayload（passport 挂载），
 * User 实体走 req.currentUser 缓存，见 @CurrentUser()
 * 用法：@GetJwtPayload() payload: JwtPayload
 */
export const GetJwtPayload = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): JwtPayload | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
