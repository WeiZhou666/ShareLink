# 方案 B：S3 预签名直传三端点实现

## Context

当前上传是代理模式：分块 octet-stream → 后端 tmp 暂存 → 最后一块转正时后端流式上传 S3。数据面全量穿过 Node，多用户/大文件场景下后端带宽是瓶颈。用户确认迁移方案 B（预签名直传）：后端只做控制面（签 URL/确认/中止），字节由浏览器直传 MinIO。

**关键前提（已第一手核实）**：前端 [share.service.ts](file:///e:/桌面/ShareLink/frontend-vue/src/api/share.service.ts) 的直传代码是现成的休眠逻辑（L146-235 uploadFileDirectS3、L262-348 分发），**前端零改动**——第 0 块探测 upload-init，响应含 `directToS3: true` 即走直传，404/报错/无 directToS3 自动永久降级代理（按页面加载记忆）。

**已验证的不受影响项**：
- 病毒扫描走 `FILE_STORAGE.openContentStream`（[scan.service.ts](file:///e:/桌面/ShareLink/backend-nest/src/antivirus/scan.service.ts) L111），对直传对象原样可用，零改动
- share.complete / zip 打包 / 下载 Range 链路全部零改动
- RawBodyMiddleware 按 content-type 分流（octet-stream 才裸解析），新 JSON 端点不受影响（实现时确认其 `use()` 的分流实现即可）

## 前端契约（必须精确对齐，实测自休眠代码）

```
POST /api/shares/:shareId/files/upload-init
  body: { id: uuid, name: string, totalChunks: int }
  200: { directToS3: true, uploadId: string, urls: string[] }
       // urls[chunkIndex] 对应 PartNumber = chunkIndex+1；前端逐块 PUT，
       // 收集响应头 etag → parts[{ETag, PartNumber}]
  404: 本地盘驱动（前端标记该 share 不支持 → 降级代理）
  400: chunkSize < 5MiB 且 totalChunks > 1（S3 multipart 除末块外每块 ≥ 5MiB，
       不拦截则 complete 时才 EntityTooSmall，体验差——提前拒绝走代理）

POST /api/shares/:shareId/files/upload-complete
  body: { id: uuid, name: string, uploadId: string, parts: [{ ETag, PartNumber }] }
  200: { id, name }   // 与代理模式 FileUploadResponse 一致

POST /api/shares/:shareId/files/upload-abort
  body: { name: string, uploadId: string }   // 注意：无 fileId！
  200 幂等（uploadId 不存在视为已中止，静默成功）
```

## 设计决策（定案）

1. **Multipart 模式**：CreateMultipartUpload + 每块预签名 UploadPart URL + CompleteMultipartUpload。每块一个独立小对象的方案否决（complete 时服务端还得下载重传拼接）。
2. **能力协商**：三方法加进 `StorageBackend` 接口，仅 S3Storage 实现；LocalStorage 抛 `StorageCapabilityError`（新错误类，定义在 storage.backend.ts）。file.service 捕获后转 404 → 前端优雅降级。
3. **abort 无状态寻址**：abort 请求体没有 fileId → 用 `ListMultipartUploads`（Prefix=`{shareId}/`）按 UploadId 反查 Key 后 Abort。不引入服务端会话存储。
4. **init 幂等/防孤儿**：init 前先 `ListMultipartUploads`（Prefix=`{shareId}/{fileId}`）把同名残留 multipart 全部 Abort，防重传/页面刷新堆积孤儿分片（分片会占存储计费）。
5. **File 表行在 upload-complete 创建**（与代理模式「最后一块创建」等价），幂等：findUnique 已存在则直接返回 `{id,name}`（网络重试安全）。
6. **断点续传边界**：直传模式 v1 不做跨刷新续传（页面刷新丢 etag 集合，complete 会 InvalidPart）；失败 → abort → useUpload 现有 5s 整文件重试 → 重新 init（决策 4 清理旧会话）。代理模式语义不变。
7. **预签名端点与 Host 绑定**：签名绑定 Host，预签名必须用**浏览器可达**的端点。新增可选 env `S3_PUBLIC_ENDPOINT`（默认回退 S3_ENDPOINT）；预签名用该端点构造 client（region/凭证/FORCE_PATH_STYLE 同主 client）。
8. **URL 有效期**：env `S3_DIRECT_URL_EXPIRES`（秒，默认 86400=24h，sigv4 上限 7 天），读法同 s3.storage.ts 现有 env.S3_* 模式。
9. **限流**：三端点低频（每文件 3 个请求），不吃 @SkipThrottle，走全局默认。

## 文件改动

**backend-nest（主体）**：

| 文件 | 改动 |
|---|---|
| [package.json](file:///e:/桌面/ShareLink/backend-nest/package.json) | + `@aws-sdk/s3-request-presigner@^3.1149.0`（与 client-s3 版本对齐） |
| [storage.backend.ts](file:///e:/桌面/ShareLink/backend-nest/src/share/storage/storage.backend.ts) | 接口 + 3 能力方法（initDirectUpload/completeDirectUpload/abortDirectUpload）+ `StorageCapabilityError` 类 + 注释说明「能力方法，local 不支持」 |
| [s3.storage.ts](file:///e:/桌面/ShareLink/backend-nest/src/share/storage/s3.storage.ts) | 实现三方法：presign client（S3_PUBLIC_ENDPOINT）+ init（清孤儿→Create→逐块 presign）+ complete（CompleteMultipartUpload，S3 错误分类：NoSuchUpload→stale、InvalidPart/EntityTooSmall→透传 i18n；HeadObject 取 ContentLength）+ abort（List 反查→Abort，静默） |
| [local.storage.ts](file:///e:/桌面/ShareLink/backend-nest/src/share/storage/local.storage.ts) | 三方法抛 StorageCapabilityError 存根 |
| [file.controller.ts](file:///e:/桌面/ShareLink/backend-nest/src/share/file.controller.ts) | +3 路由（守卫 CreateShareGuard + StrictShareOwnerGuard，与 POST / 一致）；更新头注释 L10-15（三端点已迁移） |
| [file.service.ts](file:///e:/桌面/ShareLink/backend-nest/src/share/file.service.ts) | +3 编排方法：init（uuid/uploadLocked/大小预检 totalChunks×chunkSize vs limit→PAYLOAD_TOO_LARGE、5MiB 规则→400、捕获 CapabilityError→404）；complete（校验+委托+File 行幂等创建 BigInt size）；abort（委托，吞错返 200） |
| src/share/dto/s3-direct-upload.dto.ts（新） | UploadInitDto / UploadCompleteDto / UploadAbortDto，class-validator 风格对齐 create-share.dto |
| src/i18n（zh+en） | `file.s3MultipartPartTooSmall`、`file.s3UploadStale`（complete 会话失效）、按需 `file.s3CompleteFailed` |
| [.env.production.example](file:///e:/桌面/ShareLink/.env.production.example) | S3_PUBLIC_ENDPOINT / S3_DIRECT_URL_EXPIRES 键注释（生产必配：预签名 Host 必须浏览器可达） |
| [docker-compose.yml](file:///e:/桌面/ShareLink/backend-nest/docker-compose.yml) | minio 服务 CORS 相关 env 视验证结果补（先浏览器实测默认 CORS 是否放行 PUT 跨源 + ETag 暴露，缺则加 MINIO_API_CORS_ALLOW_ORIGIN / EXPOSE_HEADERS） |
| backend-nest/docs/file-scheme.md | §8「演进留白」→ 已实现说明 |

**frontend-vue：零改动**（仅文档）：
- [GUIDE.zh-CN.md](file:///e:/桌面/ShareLink/frontend-vue/GUIDE.zh-CN.md) §8.2：休眠直传代码 → 已启用，S3 直传为默认、404/小 chunkSize 降级代理

## 验证

1. `npm run lint`（后端）+ 前端 typecheck 不回归
2. 重启 dev 后端（此前后台 dev 进程已退出）+ MinIO 确认在跑
3. **浏览器 E2E**（:3001 上传真实文件）：
   - Network 面板：upload-init 200 带 urls → 逐块 PUT 直达 localhost:9000 → upload-complete 200
   - mc ls 验证对象 `{shareId}/{fileId}`；下载可用；扫描 CLEAN；zip 可拉
   - 中途断网/取消 → abort 生效、无孤儿分片残留（重新上传成功）
4. **降级回归**：`STORAGE_DRIVER=local` 重启 → upload-init 404 → 前端 console.warn 后照常代理上传成功
5. 生产预留：S3_PUBLIC_ENDPOINT 语义写入 .env.production.example 注释即可，生产接线（nginx /s3/ 反代或 9000 直曝）留到部署时验证

## 不做（明确出界）

- 跨刷新断点续传（直传模式 v1 重来即可）
- 前端任何代码改动
- 下载通知（recipient 形参与本特性无关）
- 生产 MinIO 对外暴露的 nginx 路由配置（部署阶段单独做）
