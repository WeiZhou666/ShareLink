import type { User } from '@prisma/client';

/**
 * access JWT 的 payload（jwtService.sign 的入参 + iat/exp）
 * JwtStrategy 验签通过后才能拿到——不可信的 decode 结果不允许以此类型流转
 */
export interface JwtPayload {
  sub: string;
  email?: string;
  isAdmin?: boolean;
  /** 当前 refresh 会话 id，登出时据此删除会话行 */
  refreshTokenId?: string;
  /** token 唯一标识，登出时写入 Redis 黑名单 */
  jti?: string;
  /** 签发时间戳，单位秒 */
  iat?: number;
  /** 过期时间戳，单位秒 */
  exp?: number;
}

// req.user = JwtStrategy.validate 返回的验签后 payload（passport 挂载，主流形态）。
// @types/passport 已声明 Express.Request.user?: Express.User，无法重声明改型，
// 故扩展 Express.User 接口使其携带 payload 字段（passport 社区标准做法）；
// User 实体由 JwtAuthGuard 查库后缓存到 req.currentUser（每请求仅一次），供 @CurrentUser() 同步读取
declare global {
  namespace Express {
    interface User extends JwtPayload {}
    interface Request {
      currentUser?: User;
    }
  }
}
