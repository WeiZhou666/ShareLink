import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * 用户列表查询参数
 * GET /api/admin/users?page=1&pageSize=20&keyword=xxx
 *
 * 注意：query 传来的都是字符串，必须用 @Type(() => Number) 显式转换后再做数值校验，
 * 否则 @IsInt() 会对 "1" 这个字符串校验失败（ValidationPipe 已开 transform，两者配合生效）
 */
export class AdminUserQueryDto {
  /** 页码，从 1 开始 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** 每页条数，上限 100 —— 防止恶意 pageSize=99999 一次拖走全表 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  /** 模糊搜索关键词：匹配 username 或 email（可选） */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  keyword?: string;
}

/**
 * 更新用户（管理员开关 / 账号启停）
 * PATCH /api/admin/users/:id
 *
 * 只暴露 isAdmin / isActivated 两个字段做白名单——这是"最小授权"的典型写法：
 * 管理员接口永远不应该出现"直接透传 DTO 改任意字段"（否则改 email/password 都是越权）
 */
export class AdminUpdateUserDto {
  /** 是否设为管理员 */
  @IsOptional()
  @IsBoolean()
  isAdmin?: boolean;

  /** 是否启用账号（false = 禁用：无法登录 + 立即踢下线） */
  @IsOptional()
  @IsBoolean()
  isActivated?: boolean;
}

/**
 * 管理员重置密码
 * POST /api/admin/users/:id/resetPassword
 *
 * 校验规则与用户自行设置密码保持一致（8-64 位），复用同一套策略避免两条密码标准
 */
export class AdminResetPasswordDto {
  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(64, { message: '密码最多 64 位' })
  newPassword: string;
}
