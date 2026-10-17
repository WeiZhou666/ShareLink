/**
 * 分享安全策略入参（创建/更新共用）
 *
 * 注意：class-validator 的 DTO 必须值导入装饰器——
 * 若写成 `import type`，装饰器元数据不生成，全局 ValidationPipe 会静默跳过校验（项目踩过的坑）。
 */
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

export class ShareSecurityDTO {
  /** 明文密码（3-30 位）；入库前在 service 层 argon2 哈希，响应里永远不出现 */
  @IsString()
  @IsOptional()
  @Length(3, 30)
  password?: string;

  /** 最大查看次数：达到后链接失效（空 = 不限） */
  @IsNumber()
  @IsOptional()
  maxViews?: number;

  /** true 时仅指定收件人（及创建者）可访问；依赖 share.enableUserRecipients 开启 */
  @IsBoolean()
  @IsOptional()
  restrictToRecipients?: boolean;
}
