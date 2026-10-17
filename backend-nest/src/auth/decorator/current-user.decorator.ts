import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { User } from '@prisma/client';

/**
 * 当前登录用户（User 数据库实体）
 * req.user 现在是 JwtStrategy 验签后的 JwtPayload（passport 挂载 validate 返回值）；
 * 实体由 JwtAuthGuard 按 payload.sub 查库并缓存到 req.currentUser（每请求仅查一次）
 * 用法：@CurrentUser() user: User 或 @CurrentUser('id') userId: string
 */
export const CurrentUser = createParamDecorator(
  (data: keyof User | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.currentUser as User;
    return data ? user?.[data] : user;
  },
);
