/**
 * 存储后端抽象：local（本地磁盘）/ s3（S3 兼容对象存储）双模式的统一接缝
 *
 * 设计不变式（双模式共存的基石）：
 * 1. 分块暂存协议只在本地磁盘——{SHARE_DIRECTORY}/{shareId}/{fileId}.tmp-chunk 两种模式一致，
 *    断点续传"磁盘字节数 = 期望块索引"的原协议零改动；差异收敛在"最后一块转正"之后
 * 2. 对象键镜像磁盘布局：{shareId}/{fileId}（内容）、{shareId}/archive.zip（打包）——
 *    shareId 过 ID_PATTERN（无斜杠）、fileId 过 UUID 正则，键无穿越风险
 * 3. 所有删除方法幂等（对象可能已被清理任务/上一轮处置先删）
 *
 * 消费方：FileService（上传转正/下载/删除/zip 流）、ShareService（createZip 源与汇）、
 * ScanService（扫描流与隔离删除）。实现见 local.storage.ts 与 s3.storage.ts，
 * 由 share.module 的工厂按 STORAGE_DRIVER 装配（进程级常量，不做运行时切换——
 * 中途换驱动会留下"两边都有半份"的脏数据）。
 */
import type { Readable } from 'node:stream';

/** 注入令牌：share.module 工厂按 STORAGE_DRIVER 装配 local / s3 实现 */
export const FILE_STORAGE = Symbol('FILE_STORAGE');

/** 字节区间（下载 Range 已由 FileService 统一解析，实现方只管按区间出流） */
export interface ByteRange {
  start: number;
  end: number;
}

/** 直传会话指纹：urls[chunkIndex] ↔ PartNumber = chunkIndex + 1，前端逐块 PUT 后收 etag 回执 */
export interface DirectUploadInitResult {
  uploadId: string;
  urls: string[];
}

/** 直传分片回执（complete 提交；etag 保留 S3 返回的原始形态，含引号） */
export interface DirectUploadPart {
  etag: string;
  partNumber: number;
}

/** 能力缺失：可选能力方法只有部分驱动实现（如直传仅 s3），消费方捕获后按"不支持"转 404 降级 */
export class StorageCapabilityError extends Error {
  constructor(capability: string) {
    super(`storage driver does not support capability: ${capability}`);
    this.name = 'StorageCapabilityError';
  }
}

export interface StorageBackend {
  /**
   * 最后一块到位：把 tmp-chunk 转为正式内容存储
   * - local：tmp 原子改名
   * - s3：tmp 流式上传（lib-storage 自动分片）后删 tmp
   * @returns 最终字节数（File 表登记用）
   */
  finalizeChunk(shareId: string, fileId: string): Promise<number>;

  /** 打开内容读流（整文件或字节区间；流的消费与销毁由调用方负责） */
  openContentStream(
    shareId: string,
    fileId: string,
    range?: ByteRange,
  ): Promise<Readable>;

  /** 内容是否存在（扫描前防"读不到→ERROR→永远重扫"死循环的检查） */
  contentExists(shareId: string, fileId: string): Promise<boolean>;

  /** 删除内容文件（幂等；INFECTED 隔离处置与编辑删除共用） */
  deleteContent(shareId: string, fileId: string): Promise<void>;

  /** 删除分享的全部存储对象：内容 + archive.zip + 本地 tmp 残留（幂等） */
  deleteShare(shareId: string): Promise<void>;

  /** archive.zip 是否已生成（getZipStream 判定用） */
  zipExists(shareId: string): Promise<boolean>;

  /** 打开 zip 读流；未生成返回 null（调用方走单文件降级/400） */
  openZipStream(shareId: string): Promise<Readable | null>;

  /** 把打包流（archiver）持久化为 zip；失败自清半成品后抛出 */
  saveZip(shareId: string, content: Readable): Promise<void>;

  // ---- 直传能力（可选：仅 S3 驱动实现；local 抛 StorageCapabilityError，消费方转 404 供前端降级）----

  /** 初始化 multipart 直传：清理同键残留 → CreateMultipartUpload → 逐块预签名 UploadPart URL */
  initDirectUpload(
    shareId: string,
    fileId: string,
    totalChunks: number,
  ): Promise<DirectUploadInitResult>;

  /** 提交 multipart：CompleteMultipartUpload + HeadObject 出字节数（File 表登记用） */
  completeDirectUpload(
    shareId: string,
    fileId: string,
    uploadId: string,
    parts: DirectUploadPart[],
  ): Promise<number>;

  /** 中止 multipart（幂等：会话不存在视为已中止；abort 无 fileId，实现方按 uploadId 反查 Key） */
  abortDirectUpload(shareId: string, uploadId: string): Promise<void>;
}
