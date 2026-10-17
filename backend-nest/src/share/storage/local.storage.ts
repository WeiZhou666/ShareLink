/**
 * 本地磁盘存储驱动（原 FileService 的磁盘逻辑原样迁移）
 *
 * 布局：{SHARE_DIRECTORY}/{shareId}/{fileId}（内容）
 *                                  /{shareId}/{fileId}.tmp-chunk（分块暂存，上传期存在）
 *                                  /{shareId}/archive.zip（complete 后后台打包）
 */
import { BadRequestException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { SHARE_DIRECTORY } from '../share.constants';
import { I18nService } from 'nestjs-i18n';
import { StorageCapabilityError } from './storage.backend';
import type {
  ByteRange,
  DirectUploadInitResult,
  StorageBackend,
} from './storage.backend';

export class LocalStorage implements StorageBackend {
  constructor(
    private readonly i18n: I18nService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /** 分享目录绝对路径（shareId 已过 ID_PATTERN 校验，无路径穿越风险） */
  private shareDir(shareId: string): string {
    return path.join(SHARE_DIRECTORY, shareId);
  }

  /** 文件内容绝对路径：fileId 必须是纯 ID 字符，resolve 后仍须落在分享目录内 */
  private contentFilePath(shareId: string, fileId: string): string {
    const baseDir = path.resolve(this.shareDir(shareId));
    const resolved = path.resolve(baseDir, fileId);
    if (!resolved.startsWith(baseDir + path.sep)) {
      throw new BadRequestException(this.i18n.t('file.invalidIdFormat'));
    }
    return resolved;
  }

  private tmpChunkPath(shareId: string, fileId: string): string {
    return path.join(this.shareDir(shareId), `${fileId}.tmp-chunk`);
  }

  private zipPath(shareId: string): string {
    return path.join(this.shareDir(shareId), 'archive.zip');
  }

  /** 最后一块转正：tmp 原子改名 + stat 出最终字节数（File 表登记用） */
  async finalizeChunk(shareId: string, fileId: string): Promise<number> {
    const tmpPath = this.tmpChunkPath(shareId, fileId);
    const finalPath = this.contentFilePath(shareId, fileId);
    await fsp.rename(tmpPath, finalPath);
    return (await fsp.stat(finalPath)).size;
  }

  async openContentStream(
    shareId: string,
    fileId: string,
    range?: ByteRange,
  ): Promise<Readable> {
    // 有区间按区间建流（206 拖动播放）；无区间整文件（200）
    const stream = range
      ? createReadStream(this.contentFilePath(shareId, fileId), {
          start: range.start,
          end: range.end,
        })
      : createReadStream(this.contentFilePath(shareId, fileId));
    stream.on('error', (err) => {
      this.logger.error(`文件流打开失败：${shareId}/${fileId}，${err.message}`);
    });
    return stream;
  }

  async contentExists(shareId: string, fileId: string): Promise<boolean> {
    return fs.existsSync(this.contentFilePath(shareId, fileId));
  }

  /** 幂等删除：文件已不在磁盘（清理任务先删过）不算错误 */
  async deleteContent(shareId: string, fileId: string): Promise<void> {
    await fsp.unlink(this.contentFilePath(shareId, fileId)).catch(() => {});
  }

  /** 整目录递归 rm（含 tmp-chunk 与 archive.zip） */
  async deleteShare(shareId: string): Promise<void> {
    await fsp
      .rm(this.shareDir(shareId), { recursive: true, force: true })
      .catch(() => {
        this.logger.warn(`删除分享目录失败（可能已不存在）：${shareId}`);
      });
  }

  async zipExists(shareId: string): Promise<boolean> {
    return fs.existsSync(this.zipPath(shareId));
  }

  async openZipStream(shareId: string): Promise<Readable | null> {
    if (!fs.existsSync(this.zipPath(shareId))) return null;
    return createReadStream(this.zipPath(shareId));
  }

  /** archiver 管道写入 archive.zip；失败删半成品后抛出（下次 complete 回退可重试） */
  async saveZip(shareId: string, content: Readable): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(this.zipPath(shareId));
        content.pipe(output);
        output.on('close', () => resolve());
        output.on('error', reject);
        content.on('error', reject);
      });
    } catch (e) {
      // 失败不留半成品文件
      fs.rmSync(this.zipPath(shareId), { force: true });
      throw e;
    }
  }

  // ---- 直传能力：本地磁盘驱动不支持（消费方捕获 StorageCapabilityError 转 404，前端自动降级代理）----
  // 实现为"零参数"签名（TS 允许实现收窄参数个数），避免引入未使用参数的 lint 噪音

  initDirectUpload(): Promise<DirectUploadInitResult> {
    return Promise.reject(new StorageCapabilityError('s3 direct upload'));
  }

  completeDirectUpload(): Promise<number> {
    return Promise.reject(new StorageCapabilityError('s3 direct upload'));
  }

  abortDirectUpload(): Promise<void> {
    return Promise.reject(new StorageCapabilityError('s3 direct upload'));
  }
}
