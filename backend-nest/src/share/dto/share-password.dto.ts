/**
 * 密码换访问令牌入参：POST /api/shares/:id/token
 * 密码保护的分享访问两步走：先拿密码换一次性 cookie 令牌，再凭令牌读分享/下载文件。
 */
import { IsOptional, IsString, Length } from 'class-validator';

export class SharePasswordDTO {
  /** 无密码分享也允许调本接口（签发免密令牌），故 password 可选 */
  @IsString()
  @IsOptional()
  @Length(1, 100)
  password?: string;
}
