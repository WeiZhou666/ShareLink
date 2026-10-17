import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 发布公告 DTO：标题/正文必填，链接可选
 * 长度上限：标题 100、正文 2000——弹窗场景不宜塞长文，防滥用
 */
export class CreateAnnouncementDto {
  @IsString()
  @MinLength(1, { message: '公告标题不能为空' })
  @MaxLength(100)
  title: string;

  @IsString()
  @MinLength(1, { message: '公告内容不能为空' })
  @MaxLength(2000)
  message: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  actionLink?: string;
}

/**
 * 编辑公告 DTO：字段校验与发布完全一致（标题/正文必填、链接可选），直接继承
 */
export class UpdateAnnouncementDto extends CreateAnnouncementDto {}
