import { IsEmail, IsOptional, IsString } from 'class-validator';

/** 登录参数：邮箱或用户名二选一 + 密码（与旧后端 AuthSignInDTO 一致） */
export class AuthSignInDto {
  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  username?: string;

  @IsString()
  password: string;
}
