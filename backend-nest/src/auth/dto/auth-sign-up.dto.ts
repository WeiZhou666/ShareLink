import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** 注册参数：用户名 + 邮箱 + 密码 */
export class AuthSignUpDto {
  @IsString()
  @MinLength(3, { message: '用户名至少 3 个字符' })
  @MaxLength(30, { message: '用户名最多 30 个字符' })
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: '用户名只能包含字母、数字、下划线和短横线',
  })
  username: string;

  @IsEmail({}, { message: '邮箱格式不正确' })
  email: string;

  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(64, { message: '密码最多 64 位' })
  password: string;
}

/** 重发激活邮件参数 */
export class AuthResendVerificationDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email: string;
}

/** 邮箱激活参数：验证码走 POST body——绝不出现在 URL（浏览器历史/访问日志/Referer 都是泄漏面） */
export class AuthVerifyEmailDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: '验证码为 6 位数字' })
  code: string;
}
