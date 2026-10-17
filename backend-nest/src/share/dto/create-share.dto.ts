/**
 * 创建分享入参：POST /api/shares
 * 生命周期：本接口只建"分享骨架"（此时 uploadLocked=false），随后逐块上传文件，
 * 最后 POST /:id/complete 加锁对外可见——三段式与前端 useUpload 编排一一对应。
 */
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ShareSecurityDTO } from './share-security.dto';

export class CreateShareDTO {
  /** 分享 ID（即公开链接 /s/{id} 的 path 段）：允许自定义，3-50 位 URL 安全字符 */
  @IsString()
  @Matches('^[a-zA-Z0-9_-]*$', undefined, {
    message: '分享 ID 只能包含字母、数字、下划线和连字符',
  })
  @Length(3, 50)
  id: string;

  /** 分享名称（可选，展示在链接列表与分享页标题） */
  @Length(3, 30)
  @IsOptional()
  name?: string;

  /**
   * 过期时间，三种形态（service 层 parseExpiration 归一化）：
   * - "never" 永不过期
   * - "3days"/"3-days" 相对时间（前端弹窗实际发送形态）
   * - ISO 绝对日期
   */
  @IsString()
  expiration: string;

  /** 分享描述（可选） */
  @MaxLength(512)
  @IsOptional()
  description?: string;

  /** 邮件收件人列表（可选；仅 share.enableUserRecipients 开启时有意义） */
  @IsEmail({}, { each: true })
  @IsOptional()
  recipients?: string[];

  /** 安全策略（密码/最大查看次数/限定收件人），可选 */
  @IsOptional()
  @ValidateNested()
  @Type(() => ShareSecurityDTO)
  security?: ShareSecurityDTO;

  /** 前端预估的分享总大小（字节）：创建时用于磁盘空间预检，非可信值，仅作软校验 */
  @IsNumber()
  @IsOptional()
  size?: number;
}
