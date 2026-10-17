/**
 * 更新分享入参：PATCH /api/shares/:id
 * 与旧后端语义对齐：字段"未传 = 不改"；name/description 传 null 或空串 = 清空。
 * security 的密码修改走独立语义（removePassword 显式删密码，见 UpdateShareSecurityDTO）。
 */
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class UpdateShareSecurityDTO {
  /** 新密码（3-30 位明文，service 层哈希） */
  @IsString()
  @IsOptional()
  @Length(3, 30)
  password?: string;

  /** 显式删除密码（优先级高于 password） */
  @IsBoolean()
  @IsOptional()
  removePassword?: boolean;

  /** 最大查看次数；null = 取消限制 */
  @IsNumber()
  @IsOptional()
  maxViews?: number | null;
}

export class UpdateShareDTO {
  /** 名称：null/空串清空 */
  @Length(3, 30)
  @IsOptional()
  name?: string | null;

  /** 过期时间（形态同创建；非管理员受 share.maxExpiration 约束） */
  @IsString()
  @IsOptional()
  expiration?: string;

  /** 描述：null/空串清空 */
  @MaxLength(512)
  @IsOptional()
  description?: string | null;

  /** 安全策略增量更新 */
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateShareSecurityDTO)
  security?: UpdateShareSecurityDTO;
}
