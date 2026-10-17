/** Redis 吊销键前缀：用户级（封禁/改密全员下线），值为吊销时间戳（毫秒） */
export const AUTH_USER_REVOKE_PREFIX = 'auth:revoke:';
/** access_token 有效期（秒）——用户级吊销键的 TTL 取此值，过后所有旧 token 已自然过期，键自动清理 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** 注销冷静期（毫秒）：软删除后保留时长，期内可自助恢复（POST /auth/recoverAccount），
 *  超期由 jobs.deleteSoftDeletedUsers 物理清除。登录拦截与 jobs 到期判断共用此常量。
 *  半年按 182 天计（365/2 向下取整，不引入日历月复杂性） */
export const ACCOUNT_RETENTION_MS = 182 * 24 * 60 * 60 * 1000;
