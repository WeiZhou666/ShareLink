import { IsString, MinLength } from 'class-validator';

/**
 * 第三方身份绑定：发起登录 → 拿到 callback 里的 code/state → 登录状态下提交绑定。
 * 注意 DTO 类必须值导入（import type 会使 design:paramtypes 缺失、ValidationPipe 静默失效）
 */
export class OAuthBindDto {
  @IsString()
  @MinLength(1)
  code: string;

  @IsString()
  @MinLength(1)
  state: string;
}
