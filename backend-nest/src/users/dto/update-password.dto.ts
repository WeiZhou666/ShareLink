import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** 修改当前用户密码：oldPassword 仅已设密码的用户必填（OAuth 创建的无密码用户可省略，直接设置新密码） */
export class UpdatePasswordDto {
  @IsOptional()
  @IsString()
  oldPassword?: string;

  @IsString()
  @MinLength(8, { message: '密码至少 8 位' })
  @MaxLength(64, { message: '密码最多 64 位' })
  password: string;
}
