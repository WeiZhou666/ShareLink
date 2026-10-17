import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** 修改当前用户资料：用户名/邮箱均可选传，只更新提供的字段 */
export class UpdateCurrentUserDto {
  @IsOptional()
  @IsString()
  @MinLength(3, { message: '用户名至少 3 位' })
  @MaxLength(32, { message: '用户名最多 32 位' })
  username?: string;

  @IsOptional()
  @IsEmail({}, { message: '邮箱格式不正确' })
  email?: string;
}
