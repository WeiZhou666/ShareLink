/**
 * 分享模块常量
 *
 * SHARE_DIRECTORY：分享文件的本地存储根目录。
 * 目录结构：{DATA_DIRECTORY}/uploads/shares/{shareId}/{fileId}
 *   - 每个 share 一个独立目录，删除分享 = 整目录 rm（含 archive.zip）
 *   - 上传中的分块落盘为 {fileId}.tmp-chunk，最后一块到达后 rename 去掉后缀
 */
import * as path from 'node:path';

export const DATA_DIRECTORY = process.env.DATA_DIRECTORY || './data';
export const SHARE_DIRECTORY = path.join(DATA_DIRECTORY, 'uploads/shares');

/**
 * 分享 ID / 文件 ID / 反向分享 token 的合法字符集。
 * 旧后端叫 isBase64（自生成的 id 是 base64url），这里沿用同一正则语义：
 * URL 安全字符 + 可选的 "=" 结尾。既做创建时校验，也做路由参数防注入校验。
 */
export const ID_PATTERN = /^[a-zA-Z0-9_-]*={0,2}$/;

/**
 * "永不过期"的特殊过期时间：unix 0（1970-01-01T00:00:00Z）。
 * 沿用旧后端约定——所有"是否过期"的判断都要先排除这个值。
 */
export const NEVER_EXPIRES = new Date(0);
