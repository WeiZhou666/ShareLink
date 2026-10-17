import {
  IsEmail,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

/** 请求重置密码：只收邮箱；无论邮箱是否存在都返回一致话术（防账号枚举） */
export class AuthRequestResetDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email: string;
}

/** 提交新密码：凭 (email, 6 位重置验证码)；验证码走 POST body，绝不出现在 URL；密码规则与注册一致 */
export class AuthResetPasswordDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email: string;

  @IsString()
  @Length(6, 6, { message: '验证码是 6 位数字' })
  code: string;

  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(64, { message: '密码最多 64 位' })
  password: string;
}
