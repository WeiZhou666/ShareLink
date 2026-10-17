/**
 * 创建反向分享令牌入参：POST /api/reverseShares
 * 反向分享 = 把 {appUrl}/upload/{token} 链接发给别人，对方免登录向你上传文件。
 */
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class CreateReverseShareDTO {
  /** complete 时是否邮件通知令牌创建者（字段保留，邮件模板本期未迁移） */
  @IsBoolean()
  sendEmailNotification: boolean;

  /** 该链接产生的单次分享大小上限（字节）。前端以 string 形态发送（对齐旧 API），@Type 转数字后再校验 */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxShareSize: number;

  /**
   * 反向分享自身有效期：只接受 "never" 与相对时间（"30days"/"30-days"）——
   * 用 @Matches 在 DTO 层拦掉垃圾输入（service 的 parseRelativeDateToAbsolute
   * 是纯工具函数，遇到非法形态会抛未翻译的裸字符串，这里从源头保证进不去）
   */
  @IsString()
  // @Matches 第一参收"正则字符串"（class-validator 内部 new RegExp），非法形态在 DTO 层 400
  @Matches(
    '^(never|\\d+-(seconds|minutes|hours|days|weeks|months|years)|\\d+(seconds|minutes|hours|days|weeks|months|years))$',
    undefined,
    {
      message: 'shareExpiration 仅支持 never 或数字+单位（如 30days）',
    },
  )
  shareExpiration: string;

  /** 可用次数 1-1000：每次 complete 扣 1 次，扣完链接失效 */
  @IsInt()
  @Min(1)
  @Max(1000)
  maxUseCount: number;

  /** 简化模式：对方上传页隐藏高级选项 */
  @IsBoolean()
  simplified: boolean;

  /** false 时仅令牌创建者与分享创建者能访问生成的分享 */
  @IsBoolean()
  publicAccess: boolean;

  /** 自定义 token（可选，默认生成 uuid） */
  @IsString()
  @IsOptional()
  @Matches('^[a-zA-Z0-9_-]+$', undefined, {
    message: 'token 只能包含字母、数字、下划线和连字符',
  })
  @Length(3, 50)
  token?: string;
}
