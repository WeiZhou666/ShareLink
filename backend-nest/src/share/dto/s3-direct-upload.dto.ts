/**
 * S3 预签名直传三端点入参（POST /api/shares/:shareId/files/upload-init|upload-complete|upload-abort）
 *
 * 契约逐字对齐前端直传编排（frontend-vue share.service.ts uploadFileDirectS3）：
 * - init/complete 的 id = 前端生成的 36 位 uuid 文件 ID（同代理模式 query id）
 * - complete 的 parts 是 [{ ETag, PartNumber }]：保留 S3 线上格式（ETag 含引号）——
 *   若改小写字段名会被全局 ValidationPipe 的 whitelist 静默剥掉，complete 时才炸
 * - abort 只有 { name, uploadId }（无 fileId）：后端按 uploadId 反查对象键
 */
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class UploadInitDTO {
  /** 文件 ID：前端生成的 uuid，规则与代理模式一致（service 侧再做 36 位格式校验） */
  @IsString()
  @MinLength(1)
  id: string;

  /** 展示名（可含中文） */
  @IsString()
  @MinLength(1)
  name: string;

  /** 总块数：前端按 share.chunkSize 切片得出 */
  @IsInt()
  @Min(1)
  @Max(10000) // S3 multipart 单对象分片上限
  totalChunks: number;
}

export class DirectUploadPartDTO {
  /** S3 返回的分片 etag（含引号原样回传） */
  @IsString()
  @MinLength(1)
  ETag: string;

  /** 分片序号（1 起） */
  @IsInt()
  @Min(1)
  @Max(10000)
  PartNumber: number;
}

export class UploadCompleteDTO {
  @IsString()
  @MinLength(1)
  id: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsString()
  @MinLength(1)
  uploadId: string;

  /** 各已传分片的 etag 回执，顺序即分片顺序 */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DirectUploadPartDTO)
  parts: DirectUploadPartDTO[];
}

export class UploadAbortDTO {
  @IsString()
  @MinLength(1)
  name: string;

  @IsString()
  @MinLength(1)
  uploadId: string;
}
