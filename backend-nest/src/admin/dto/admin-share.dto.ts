import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 分享列表查询参数（与 AdminUserQueryDto 同构：query 传来的是字符串，必须 @Type 转换后再数值校验）
 * GET /api/admin/shares?page=1&pageSize=20&keyword=xxx
 */
export class AdminShareQueryDto {
  /** 页码，从 1 开始 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** 每页条数，上限 100 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  /** 模糊搜索：分享 id / 名称 / 创建者用户名或邮箱 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  keyword?: string;
}
