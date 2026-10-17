/**
 * S3 兼容对象存储驱动（MinIO / AWS S3 / R2 / OSS 通吃，走开放 S3 API）
 *
 * 连接参数取 env（与 CLAMAV_HOST/PORT 同理：环境相关基础设施配置不进 config.yaml）：
 *   STORAGE_DRIVER=s3 启用；S3_ENDPOINT / S3_REGION / S3_BUCKET /
 *   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_FORCE_PATH_STYLE
 *
 * 关键语义：
 * - 分块暂存仍在本地磁盘（见 storage.backend.ts 不变式），最后一块转正时把 tmp 文件
 *   用 lib-storage Upload 流式上传（>5MB 自动 Multipart，内存恒定）后删 tmp——
 *   断点续传协议、RawBodyMiddleware、前端上传编排全部零改动
 * - 直传能力（方案 B，initDirectUpload/completeDirectUpload/abortDirectUpload 仅本驱动实现）：
 *   CreateMultipartUpload → 逐块预签名 UploadPart URL → 浏览器 PUT 直达对象存储 →
 *   CompleteMultipartUpload。签名绑定 Host，预签名必须用浏览器可达的端点（S3_PUBLIC_ENDPOINT）
 * - Range 下载直接透传 GetObject 的 Range 参数（S3 服务端原生支持 206）
 * - 对象键 = 磁盘布局镜像：{shareId}/{fileId}、{shareId}/archive.zip
 */
import { BadRequestException, Inject, NotFoundException } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import * as fsp from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { I18nService } from 'nestjs-i18n';
import { SHARE_DIRECTORY } from '../share.constants';
import { env } from '../../../config/env-loader';
import type {
  ByteRange,
  DirectUploadInitResult,
  DirectUploadPart,
  StorageBackend,
} from './storage.backend';
import type { GetObjectCommandOutput } from '@aws-sdk/client-s3';

export class S3Storage implements StorageBackend {
  private readonly client: S3Client;
  private readonly bucket: string;
  /** 预签名专用 client：端点必须浏览器可达（签名绑定 Host），默认与主 client 同端点 */
  private readonly presignClient: S3Client;
  /** 预签名 URL 有效期（秒）：默认 24h，覆盖慢速大块上传；sigv4 上限 7 天 */
  private readonly directUrlExpires: number;

  constructor(
    private readonly i18n: I18nService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    this.client = new S3Client({
      region: env.S3_REGION ?? 'us-east-1',
      endpoint: env.S3_ENDPOINT,
      // MinIO / 自建网关没有虚拟主机域名，必须走路径风格（bucket 放 path 里）
      forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      },
    });
    this.bucket = env.S3_BUCKET!;
    this.presignClient = new S3Client({
      region: env.S3_REGION ?? 'us-east-1',
      endpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
      forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      },
    });
    this.directUrlExpires = env.S3_DIRECT_URL_EXPIRES ?? 86400;
  }

  /** 对象键与磁盘布局镜像（shareId 无斜杠、fileId 为 UUID，无穿越风险） */
  private contentKey(shareId: string, fileId: string): string {
    return `${shareId}/${fileId}`;
  }

  private zipKey(shareId: string): string {
    return `${shareId}/archive.zip`;
  }

  /** 分块暂存路径：与 local 驱动同款——tmp 永远在本地磁盘（双模式不变式） */
  private tmpChunkPath(shareId: string, fileId: string): string {
    return path.join(SHARE_DIRECTORY, shareId, `${fileId}.tmp-chunk`);
  }

  private tmpShareDir(shareId: string): string {
    return path.join(SHARE_DIRECTORY, shareId);
  }

  /** 对象缺失判定：HeadObject 404 的错误名是 "NotFound"，GetObject 缺键是 "NoSuchKey" */
  private isNotFound(e: unknown): boolean {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    return (
      err.name === 'NotFound' ||
      err.name === 'NoSuchKey' ||
      err.$metadata?.httpStatusCode === 404
    );
  }

  /** 最后一块转正：tmp 流式上传（lib-storage 自动分片）→ 删 tmp → 返回字节数 */
  async finalizeChunk(shareId: string, fileId: string): Promise<number> {
    const tmpPath = this.tmpChunkPath(shareId, fileId);
    const size = (await fsp.stat(tmpPath)).size;
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.contentKey(shareId, fileId),
        Body: createReadStream(tmpPath),
        ContentLength: size, // 带长度让 S3 顺带校验完整性，也免去流式上传的长度探测
      },
    });
    await upload.done();
    // 上传成功即删 tmp：暂存的使命结束（删除失败不影响正确性，任务 6 按期回收）
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    return size;
  }

  async openContentStream(
    shareId: string,
    fileId: string,
    range?: ByteRange,
  ): Promise<Readable> {
    let response: GetObjectCommandOutput;
    try {
      response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.contentKey(shareId, fileId),
          // Range 由 S3 服务端原生支持（返回 206 与对应字节区间）
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }),
      );
    } catch (e) {
      // DB 行在但对象没了（清理竞态等孤儿场景）：与"文件不存在"同语义 → 404
      if (this.isNotFound(e)) {
        throw new NotFoundException(this.i18n.t('file.notFound'));
      }
      throw e;
    }
    return response.Body as Readable;
  }

  async contentExists(shareId: string, fileId: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.contentKey(shareId, fileId),
        }),
      );
      return true;
    } catch (e) {
      if (this.isNotFound(e)) return false;
      throw e;
    }
  }

  /** S3 删除缺失键天然幂等 */
  async deleteContent(shareId: string, fileId: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.contentKey(shareId, fileId),
      }),
    );
  }

  /** 删全部对象：ListObjectsV2 翻页 → DeleteObjects 批删（每批上限 1000）+ 本地 tmp 残留 */
  async deleteShare(shareId: string): Promise<void> {
    try {
      let token: string | undefined;
      do {
        const page = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: `${shareId}/`,
            ContinuationToken: token,
            MaxKeys: 1000,
          }),
        );
        const objects = (page.Contents ?? []).map((item) => ({
          Key: item.Key!,
        }));
        if (objects.length > 0) {
          await this.client.send(
            new DeleteObjectsCommand({
              Bucket: this.bucket,
              Delete: { Objects: objects },
            }),
          );
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      // 直传会话残留一并中止：in-flight multipart 的已传分片同样占存储与计费
      const uploads = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          Prefix: `${shareId}/`,
        }),
      );
      for (const upload of uploads.Uploads ?? []) {
        await this.client
          .send(
            new AbortMultipartUploadCommand({
              Bucket: this.bucket,
              Key: upload.Key!,
              UploadId: upload.UploadId!,
            }),
          )
          .catch(() => {});
      }
    } catch (e) {
      this.logger.warn(
        `删除分享的 S3 对象失败（${this.bucket}/${shareId}/）：${(e as Error).message}`,
      );
    }
    // 本地 tmp 残留一并清（上传中断的 .tmp-chunk 永远在本地磁盘）
    await fsp
      .rm(this.tmpShareDir(shareId), { recursive: true, force: true })
      .catch(() => {
        this.logger.warn(
          `删除分享本地暂存目录失败（可能已不存在）：${shareId}`,
        );
      });
  }

  async zipExists(shareId: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.zipKey(shareId),
        }),
      );
      return true;
    } catch (e) {
      if (this.isNotFound(e)) return false;
      throw e;
    }
  }

  async openZipStream(shareId: string): Promise<Readable | null> {
    if (!(await this.zipExists(shareId))) return null;
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.zipKey(shareId) }),
    );
    return response.Body as Readable;
  }

  /**
   * archiver 流直接作为 Upload 的 Body；失败删半成品对象后抛出
   *
   * 坑：Readable.from(content) 不是多余包装——archiver v7 内部是 readable-stream 包的
   * Transform 实现（原型链同名但不同源），lib-storage 用内建 `instanceof Readable` 分类
   * Body 判不到它（direct 传会抛 "Body Data is unsupported format"）。Readable.from()
   * 把任意流适配成内建 Readable（对真正的 node 流同样安全），源流的 error 也经异步
   * 迭代原样传播到 Upload
   */
  async saveZip(shareId: string, content: Readable): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.zipKey(shareId),
        Body: Readable.from(content),
      },
    });
    try {
      await upload.done();
    } catch (e) {
      // 失败不留半成品对象，下次 complete 回退后重试可再生成
      await this.client
        .send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: this.zipKey(shareId),
          }),
        )
        .catch(() => {});
      throw e;
    }
  }

  // ================= 直传能力（方案 B：字节不过后端，后端只做控制面） =================

  /** 清理同键残留 multipart（重传/页面刷新后再 init 的孤儿分片会一直占存储与计费） */
  private async abortStaleMultiparts(
    shareId: string,
    fileId: string,
  ): Promise<void> {
    const listed = await this.client.send(
      new ListMultipartUploadsCommand({
        Bucket: this.bucket,
        Prefix: this.contentKey(shareId, fileId),
      }),
    );
    for (const upload of listed.Uploads ?? []) {
      await this.client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: this.bucket,
            Key: upload.Key!,
            UploadId: upload.UploadId!,
          }),
        )
        .catch(() => {}); // 单个清理失败不阻塞新会话建立
    }
  }

  /** CreateMultipartUpload + 逐块预签名 UploadPart URL（urls[chunkIndex] ↔ PartNumber = index+1） */
  async initDirectUpload(
    shareId: string,
    fileId: string,
    totalChunks: number,
  ): Promise<DirectUploadInitResult> {
    await this.abortStaleMultiparts(shareId, fileId);
    const { UploadId: uploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.contentKey(shareId, fileId),
      }),
    );
    const urls = await Promise.all(
      Array.from({ length: totalChunks }, (_, i) =>
        getSignedUrl(
          this.presignClient,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: this.contentKey(shareId, fileId),
            UploadId: uploadId,
            PartNumber: i + 1,
          }),
          { expiresIn: this.directUrlExpires },
        ),
      ),
    );
    return { uploadId: uploadId!, urls };
  }

  /** CompleteMultipartUpload + HeadObject 出字节数（File 表登记用） */
  async completeDirectUpload(
    shareId: string,
    fileId: string,
    uploadId: string,
    parts: DirectUploadPart[],
  ): Promise<number> {
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.contentKey(shareId, fileId),
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((p) => ({
              ETag: p.etag,
              PartNumber: p.partNumber,
            })),
          },
        }),
      );
    } catch (e) {
      const errName = (e as { name?: string }).name ?? '';
      // 会话已失效（重复 complete / 服务端过期清理）：可恢复，前端整文件重试
      if (errName === 'NoSuchUpload') {
        throw new BadRequestException(this.i18n.t('file.s3UploadStale'));
      }
      // 分片回执问题（etag 不匹配 / 块序缺失 / 块过小）：客户端锅，400 而非 500
      if (
        ['InvalidPart', 'InvalidPartList', 'EntityTooSmall'].includes(errName)
      ) {
        throw new BadRequestException(this.i18n.t('file.s3CompleteFailed'));
      }
      throw e;
    }
    const head = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.contentKey(shareId, fileId),
      }),
    );
    return head.ContentLength ?? 0;
  }

  /** 中止 multipart：abort 无 fileId，在该分享前缀下按 uploadId 反查 Key（幂等：查不到即已不存在） */
  async abortDirectUpload(shareId: string, uploadId: string): Promise<void> {
    const listed = await this.client.send(
      new ListMultipartUploadsCommand({
        Bucket: this.bucket,
        Prefix: `${shareId}/`,
      }),
    );
    const target = (listed.Uploads ?? []).find((u) => u.UploadId === uploadId);
    if (!target) return;
    await this.client
      .send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: target.Key!,
          UploadId: uploadId,
        }),
      )
      .catch(() => {});
  }
}
