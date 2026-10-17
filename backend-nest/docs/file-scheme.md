# 文件模块方案（分块上传 · 断点续传 · 下载 · 打包）

> 范围：`src/share/` 内文件相关链路（上传/下载/打包/删除）+ 存储布局 + 将来的 S3 迁移路径。
> 病毒扫描的状态机与处置规则见 [antivirus-scheme.md](./antivirus-scheme.md)；分享令牌/密码语义见代码注释。
> 含核心代码摘录与面试速答（§10）。

## 前置知识：文件上传下载的通用难题

> 面试先讲"大文件传输的行业难题与方案空间"，再进本项目实现（正文 §3 上传 / §5 下载）。

### 1. 为什么大文件不能"一个请求整包传"

- **内存**：body 整包进内存（Node/Express 默认 100kb 上限就是防这个），1GB 文件直接打爆进程
- **超时**：HTTP 请求、反向代理、网关都有超时，传一半断线 = 全部重来
- **无断点**：连接中断从 0 重传，弱网环境不可用

结论：**切分 + 可恢复**是大文件传输的必选项 → 分块上传。

### 2. 分块上传的核心要素（业界通行形态）

- 切块：客户端按固定 chunkSize 切片逐块发（octet-stream 原始体，省 multipart 编解码开销）
- 服务端进度：以"**已收到多少字节**"为准，不信任客户端自报进度
- 断点续传：中断后服务端告诉客户端"下一个该发第几块"（expectedChunkIndex 协议，见 §3.1）
- 转正：最后一块到达后原子 rename + 写表记录——表记录 = "上传完成"的唯一事实

### 3. 字节流走哪条路：代理 vs 直传

| | 代理上传（本项目现状） | 直传（presigned URL） |
|---|---|---|
| 路径 | 字节流过应用服务器 | 服务器只签临时授权 URL，浏览器直传对象存储 |
| 优点 | 简单；可在管线里插病毒扫描/审计 | 带宽卸载，服务器不搬字节 |
| 代价 | 占应用服务器出口带宽 | 多一套存储设施；扫描/审计插桩难 |

旧后端的三端点（upload-init 等）就是直传形态；本项目的选择与迁移路径见 §8。

### 4. 下载侧的三个关键词

- **Content-Disposition**：attachment（触发下载）/ inline（浏览器内预览）
- **Range 请求**：`bytes=start-end` → 206 Partial Content；越界 416。视频拖动播放、断点下载的基础
- **流式响应**：createReadStream 边读边发，内存占用 ≈ 流缓冲区，永不整文件进内存

### 5. 术语速查

| 术语 | 一句话解释 |
|---|---|
| chunk | 分块，分块上传的调度单位 |
| multipart/form-data | 带边界编码的表单上传，整包语义，不适合大文件续传 |
| octet-stream | 原始二进制流 Content-Type |
| presigned URL | 带签名 + 过期的临时授权链接，让无凭证客户端直读直写存储 |
| MIME type | 内容类型（决定浏览器怎么处理：下载/预览/执行） |
| streaming | 流式处理——数据分批流过内存，不整体加载 |

## 1. 模块组成

| 组件 | 文件 | 职责 |
|---|---|---|
| FileController | `src/share/file.controller.ts` | `/api/shares/:shareId/files` 路由：分块上传 / 下载 / zip / 删除 |
| FileService | `src/share/file.service.ts` | 本地盘读写：分块落盘、Range 读流、zip 流、删除清理 |
| ShareService | `src/share/share.service.ts` | 分享骨架、complete 编排、createZip（`exports` 给 jobs 补打 zip） |
| RawBodyMiddleware | `src/share/share.module.ts` | octet-stream 原始体解析（express.raw，limit=chunkSize 按值缓存） |
| 六个守卫 | `src/share/guard/` | 见 §6 速查表 |
| share.utils.ts | `src/share/share.utils.ts` | 纯函数：过期时间解析 / Range 解析 / Content-Disposition |

模块接线要点：`RawBodyMiddleware` 用 `forRoutes(FileController)` **控制器类引用**挂载
（Nest 11 对 `*` 通配路径有破坏性变更，字符串路径不可靠）；守卫全部注册为 providers
（`@UseGuards(类)` 时由本模块 DI 容器实例化）；`FileService` 导出给 users 模块
（注销账号清磁盘）、`ShareService` 导出给 jobs 模块（重扫后补打 zip）。

## 2. 存储布局与路径安全

```
{DATA_DIRECTORY}/uploads/shares/     ← SHARE_DIRECTORY（share.constants.ts）
  {shareId}/
    {fileId}              ← 内容文件（fileId = 前端生成的 36 位 UUID）
    {fileId}.tmp-chunk    ← 上传中的分块暂存（最后一块到达后 rename 转正）
    archive.zip           ← complete 后后台生成（isZipReady 标记）
```

- `DATA_DIRECTORY` 来自 env（默认 `./data`，**cwd 相对路径**——必须在 backend-nest 目录下启动）
- `File.size` 用 **BigInt** 承载超大文件（>2^31 字节），出 JSON 前需 toString

三层防路径穿越：shareId 过 `ID_PATTERN` → fileId 过 36 位 UUID 正则 → resolve 前缀检查：

```ts
// share.constants.ts：URL 安全字符集，既做创建时校验，也做路由参数防注入
export const ID_PATTERN = /^[a-zA-Z0-9_-]*={0,2}$/;

// file.service.ts：resolve 后必须仍落在分享目录内（防 "../" 穿越到任意路径）
private contentFilePath(shareId: string, fileId: string): string {
  const baseDir = path.resolve(this.shareDir(shareId));
  const resolved = path.resolve(baseDir, fileId);
  if (!resolved.startsWith(baseDir + path.sep)) {
    throw new BadRequestException(this.i18n.t("file.invalidIdFormat"));
  }
  return resolved;
}
```

## 3. 上传协议（三步分块）

```
POST /api/shares                        建骨架（id 为前端生成的 8 位 nanoid）
POST /api/shares/:shareId/files         逐块上传（octet-stream 原始体）
POST /api/shares/:shareId/complete      完成 → 202（后台异步扫描+打包）
```

单块请求：body 为原始字节流；query 携带 `id`（文件 UUID）/`name`（展示名）/
`chunkIndex`/`totalChunks`。前端按 `share.chunkSize`（admin 可改的配置）切片。

### 3.1 断点续传核心——期望块索引校验

**设计思想：服务端不信任客户端声明的进度，以磁盘已有字节数为唯一事实。**

```ts
// file.service.ts createChunk
// ---- 期望块索引校验：磁盘上已有多少字节决定下一个该收第几块 ----
let diskFileSize = 0;
try {
  diskFileSize = (await fsp.stat(path.join(this.shareDir(shareId), `${file.id}.tmp-chunk`))).size;
} catch {
  diskFileSize = 0; // 首块：暂存文件尚不存在
}
const chunkSize = await this.appConfig.getNumber("share.chunkSize");
const expectedChunkIndex = Math.ceil(diskFileSize / chunkSize);
if (expectedChunkIndex !== chunk.index) {
  // 响应体带 error/expectedChunkIndex——前端 useUpload 据此跳到服务端期望的块重传
  throw new HttpException(
    {
      message: this.i18n.t("file.unexpectedChunk"),
      error: "unexpected_chunk_index",
      expectedChunkIndex,
    },
    HttpStatus.BAD_REQUEST,
  );
}
```

400 响应体能整体展开成 `{ statusCode, ...obj }` 依赖 **AllExceptionFilter**——
`error`/`expectedChunkIndex` 是对端协议的一部分，不是普通报错文案。

最后一块到达：暂存文件**原子 rename 转正** + 写表（表记录 = "上传完成"的唯一事实）：

```ts
const isLastChunk = chunk.index === chunk.total - 1;
if (isLastChunk) {
  const tmpPath = path.join(this.shareDir(shareId), `${file.id}.tmp-chunk`);
  const finalPath = path.join(this.shareDir(shareId), file.id);
  await fsp.rename(tmpPath, finalPath);
  const fileSize = (await fsp.stat(finalPath)).size;
  await this.prisma.file.create({
    data: {
      id: file.id,
      name: file.name,
      size: BigInt(fileSize),          // BigInt 承载超大文件，出 JSON 前 toString
      share: { connect: { id: shareId } },
    },
  });
}
```

### 3.2 配额校验（磁盘空间 + 分享总大小）

```ts
// ---- 磁盘剩余空间预检（statfs 失败不阻塞上传，交给写入阶段系统错误兜底）----
const space = await fsp.statfs(SHARE_DIRECTORY);
if (space.bavail * space.bsize < buffer.byteLength) {
  throw new InternalServerErrorException(this.i18n.t("file.notEnoughSpace"));
}

// ---- 分享总大小上限：全局 share.maxSize，反向分享的 maxShareSize 优先覆盖 ----
const limit = share.reverseShare
  ? share.reverseShare.maxShareSize
  : await this.appConfig.getNumber("share.maxSize");
if (existingSize + diskFileSize + buffer.byteLength > limit) {
  throw new HttpException(this.i18n.t("file.maxSizeExceeded"), HttpStatus.PAYLOAD_TOO_LARGE);
}
```

### 3.3 原始体解析中间件（express.raw 按 limit 缓存）

```ts
// share.module.ts RawBodyMiddleware
async use(req: Request, res: Response, next: NextFunction) {
  // 只管分块上传：方法非 POST、或 Content-Type 不是 octet-stream（下载/预览等）直接放行
  if (req.method !== "POST") return next();
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("application/octet-stream")) return next();

  const chunkSize = await this.appConfig.getNumber("share.chunkSize");
  if (!this.cached || this.cached.limit !== chunkSize) {
    this.cached = {
      limit: chunkSize,
      // limit 恰好等于 chunkSize（前端按同一配置切片，单块不会超）
      parser: express.raw({ type: "application/octet-stream", limit: chunkSize }),
    };
  }
  this.cached.parser(req, res, next);
}
```

要点：不用全局 raw body（会把 JSON 请求也无差别读进内存）；parser 实例按 limit 值缓存——
admin 改 chunkSize 后自动换新，不能每请求都造解析器闭包。

前端配套（useUpload）两个历史坑：`files` 必须传 **Ref**（数组快照引用失效 → 静默零上传）、
`chunkSize` 必须 getter（setup 时读值 → NaN → for 循环零次）。

## 4. complete 与 zip 打包

`ShareService.complete`（HTTP **202**，不阻塞上传协议）——先扫描后打包，**回调注入解耦**：

```ts
// share.service.ts complete
// 病毒扫描 → 扫完再打 zip（先扫描后打包，INFECTED 文件绝不进包）；
// 202 立即返回，扫描在后台异步进行。单文件无 zip 语义，只扫状态不传 onDone
const onDone = share.files.length > 1 ? () => this.createZip(id) : undefined;
void this.scanService.scanShare(id, onDone).catch((e) => {
  // scanShare 内部已逐文件容错，这里兜的是编排本身的意外
  this.logger.error(`分享 ${id} 扫描编排异常：${(e as Error).message}`);
});
```

```ts
// share.service.ts createZip（private，jobs 经 rebuildZip 公开入口补打）
private async createZip(shareId: string) {
  // 只打包扫描通过（及 ERROR fail-open）的文件；INFECTED 已删磁盘，绝不进包。
  // 全部文件被隔离时 files 为空：跳过打包（空 zip 无意义），isZipReady 保持 false
  const files = await this.prisma.file.findMany({
    where: { shareId, scanStatus: { not: "INFECTED" } },
  });
  if (files.length === 0) return;
  const dir = path.join(SHARE_DIRECTORY, shareId);
  const archive = archiver("zip", {
    zlib: { level: await this.appConfig.getNumber("share.zipCompressionLevel") },
  });
  const output = fs.createWriteStream(path.join(dir, "archive.zip"));
  for (const file of files) {
    // shell 用流式 append，避免整包进内存
    archive.append(fs.createReadStream(path.join(dir, file.id)), { name: file.name });
  }
  try {
    archive.pipe(output);
    await archive.finalize();
    await this.prisma.share.update({ where: { id: shareId }, data: { isZipReady: true } });
  } catch (e) {
    this.logger.error(`分享 ${shareId} zip 打包失败：${(e as Error).message}`);
    // 失败不留半成品文件，下次 complete 回退后重试可再生成
    fs.rmSync(path.join(dir, "archive.zip"), { force: true });
  }
}
```

面试点：ScanService 不知道 zip 的存在（回调注入），依赖方向 ShareService → ScanService
严格单向、无循环依赖；扫描失败落 ERROR 是 fail-open（放行下载，定时任务重扫自愈），
打包失败只影响"下载全部"按钮（逐文件下载仍可用）。

## 5. 下载链路

### 5.1 GET /:fileId（限流 1200/分——Range 播放会高频打点）

**Range 解析**（自实现不引 range-parser，语义只覆盖单区间）：

```ts
// share.utils.ts parseRangeHeader
// 返回 null = 无 Range 头（整文件 200）；"unsatisfiable" = 越界（416）；闭区间 [start, end]
const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
if (rawStart === "") {
  // "bytes=-N" 后缀区间：取文件末尾 N 字节
  const suffixLength = parseInt(rawEnd);
  if (suffixLength === 0 || suffixLength > totalSize) return "unsatisfiable";
  start = totalSize - suffixLength;
  end = totalSize - 1;
} else {
  start = parseInt(rawStart);
  end = rawEnd === "" ? totalSize - 1 : parseInt(rawEnd);
}
if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) {
  return "unsatisfiable";
}
return { start, end: Math.min(end, totalSize - 1) };
```

**Controller 组装 416 / 206**：

```ts
// file.controller.ts getFile
if (file.isRangeNotSatisfiable) {
  res.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
  res.set({ "Content-Range": `bytes */${totalSize}`, "Accept-Ranges": "bytes" }); // 播放器据此复位
  return;
}
if (file.range) {
  res.status(HttpStatus.PARTIAL_CONTENT);                                        // 206
  headers["Content-Range"] = `bytes ${file.range.start}-${file.range.end}/${totalSize}`;
  headers["Content-Length"] = file.range.end - file.range.start + 1;
}
```

**XSS 三层防线**（nosniff 已在 headers 三件套里）：

```ts
// "被动媒体"：浏览器解析但不执行脚本的类型，可安全 inline；
// 其余（HTML/SVG 等）inline 打开是存储型 XSS 注入点（上传恶意 HTML 钓同域 cookie）
const isPassiveMedia =
  mimeType.startsWith("video/") ||
  mimeType.startsWith("audio/") ||
  (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") ||
  mimeType === "text/plain";

headers["X-Content-Type-Options"] = "nosniff";        // 禁止浏览器嗅探改判 Content-Type
if (!isPassiveMedia) {
  headers["Content-Security-Policy"] = "sandbox";     // inline 打开时禁脚本/同源访问
}
```

**中文文件名（RFC 5987 双文件名）**：

```ts
// share.utils.ts buildContentDisposition
export function buildContentDisposition(fileName: string, mode: "attachment" | "inline"): string {
  // ASCII 兜底名：先去掉对 HTTP 头有毒的字符（引号、换行、百分号）
  const fallbackName = fileName.replace(/[^\x20-\x7e]|["%\\]/g, "_").replace(/"/g, "'");
  // RFC 5987 filename*：括号/星号/单引号虽允许出现在 query 里，header 里必须转义
  const encodedName = encodeURIComponent(fileName)
    .replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return mode === "inline"
    ? `inline; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`
    : `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`;
}
```

INFECTED → 403 quarantined（**下载双保险的第二层**；第一层是磁盘文件已删）。

### 5.2 GET /zip（打包下载三级降级）

优先级：`isZipReady && 磁盘存在` → 流 archive.zip；单文件分享 → 降级流原文件本身
（"下载全部"仍有意义）；多文件未就绪 → 400 zipError（前端轮询 metaData 的 isZipReady 后重试）。

### 5.3 无令牌直连的访问规则（FileSecurityGuard）

```ts
// guard/file-security.guard.ts（无 share_{id}_token cookie 的直连访问）
if (new Date() > share.expiration && share.expiration.getTime() !== NEVER_EXPIRES.getTime()) {
  throw new NotFoundException(this.i18n.t("file.notFound"));          // 过期 = 404（不可探测）
}
if (share.security?.restrictToRecipients) {
  const isCreator = user && share.creatorId === user.id;
  const isRecipient = await this.tryMatchRecipient(share, user);
  if (!isCreator && !isRecipient) throw new ForbiddenException(/* 受限分享 */);
}
// 密码分享直连不放行：必须先走 token 流程（否则密码形同虚设）
if (share.security?.password) throw new ForbiddenException(this.i18n.t("file.passwordProtected"));
if (share.security?.maxViews && share.security.maxViews <= share.views) {
  throw new ForbiddenException(this.i18n.t("share.maxViewsExceeded"), "share_max_views_exceeded");
}
// 直连访问计一次浏览（带 token 的在签发接口已计过；同令牌重复 GET 不重复消耗 maxViews）
await this.prisma.share.update({ where: { id: share.id }, data: { views: { increment: 1 } } });
```

## 6. 守卫链速查

| 守卫 | 挂载路由 | 语义 |
|---|---|---|
| CreateShareGuard | POST /shares、POST files | JWT 登录用户 或 反向分享令牌持有者（二选一：先试 JWT，失败降级查 `reverse_share_token` cookie 的存在/过期/剩余次数） |
| StrictShareOwnerGuard | POST files、DELETE file | 创建者本人 或 匿名分享（反向上传产物无创建者）；**allowAdmin=false**，管理员不能越权上传 |
| ShareOwnerGuard | PATCH / expire 等 | 同上但 allowAdmin=true（管理员可管） |
| FileSecurityGuard | GET file、GET zip | 带 share token 走父类完整校验；无 token 走 §5.3 直连规则 |
| ShareSecurityGuard | GET /shares/:id | 分享访问令牌验签 + 密码/收件人/过期完整门禁 |
| ShareTokenGuard | POST /:id/token | 轻量存在性检查（防"没令牌拿不到令牌"死锁），密码/maxViews 校验在 service |

## 7. 删除与清理

- `remove`（单文件，编辑场景）：先 `unlink`（失败静默——清理任务可能已删）再删表记录
- `deleteAllFiles`（整目录递归 rm，含 tmp-chunk 与 archive.zip）：分享删除、
  **注销账号清理**（users 模块经 `exports: [FileService]` 复用）复用
- 过期分享的定时清理在 jobs 模块（原 ExpiredShareCleanupService 并入）；
  ClamAV ERROR 重扫任务通过 `ScanService.rescanFile` + `ShareService.rebuildZip` 自愈

## 8. 存储双模式（local | s3，已落地）

**现状（2026-10-17）**：存储已策略化为 `local | s3` 双驱动，代码一套通吃本地盘与任意 S3 兼容
服务（MinIO / AWS S3 / R2 / OSS）。迁移清单全部完成：2026-10-17 起第 1 步
**presigned URL 直传三端点也已落地**（`upload-init / upload-complete / upload-abort`，
仅 s3 驱动可用，local 驱动 404 → 前端自动降级代理，见 §8.6）。

### 8.1 架构：接口隔离 + 全局模块

```
src/share/storage/
  storage.backend.ts   FILE_STORAGE 注入令牌 + ByteRange + StorageBackend 接口（11 方法 = 8 基础 + 3 直传能力）
  local.storage.ts     磁盘实现（原 FileService 磁盘逻辑原样迁入；直传能力抛 StorageCapabilityError）
  s3.storage.ts        S3 实现（@aws-sdk/client-s3 + lib-storage Upload + s3-request-presigner）
  storage.module.ts    @Global 模块：按 env.STORAGE_DRIVER 装配唯一实例
```

- **接口 8 基础方法**：finalizeChunk（最后一块转正）、openContentStream（读取/Range）、
  contentExists / deleteContent（扫描编排）、deleteShare（内容+zip+本地 tmp）、
  zipExists / openZipStream（zip 回源）、saveZip（汇侧写入，失败自清半成品）
- **为什么 @Global**：FileService/ShareService（ShareModule）与 ScanService（AntivirusModule）
  都要注入——挂 ShareModule 会让 AntivirusModule 反向依赖 ShareModule（循环）；
  存储是纯基础设施，全局化与 PrismaModule/AppConfigModule 同惯例
- **驱动装配是进程级常量**：启动时定死，不做运行时切换（中途换驱动会留下"两边都有半份"的脏数据）

### 8.2 双模式不变式（设计核心）

1. **分块暂存恒在本地磁盘**：`{SHARE_DIRECTORY}/{shareId}/{fileId}.tmp-chunk` 不随驱动变化——
   断点续传协议（期望块索引 = 磁盘字节 / chunkSize 向上取整）、statfs 预检、maxSize 上限
   全部零改动；tmp 是协议的唯一事实源（**注意**：该不变式仅约束"代理分块"路径；
   直传路径（§8.6）字节不过后端，天然不走 tmp）
2. **差异收敛在"最后一块转正"之后**：finalizeChunk（磁盘 rename / lib-storage Upload 后删 tmp）
   与读取（createReadStream / GetObject+Range 透传）走驱动；对象键 = 磁盘布局镜像
   `{shareId}/{fileId}`、`{shareId}/archive.zip`
3. **删除方法全部幂等**：S3 缺键删除天然成功（"对象已不在"不算错误）；deleteShare 同时
   清本地 tmp 残留（上传中断的 .tmp-chunk 永远在本地磁盘）
4. **Range 解析统一在 FileService**（parseRangeHeader 一处），驱动只按区间出流

### 8.3 配置（env 双轨，环境相关基础设施不进 config.yaml）

`STORAGE_DRIVER`（local|s3，缺省 local）+ S3_ENDPOINT / S3_REGION / S3_BUCKET /
S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_FORCE_PATH_STYLE；
zod 条件必填：STORAGE_DRIVER=s3 时四键缺一不可（env-loader 第三段 superRefine，
与 MAIL_DELIVERY=smtp 的 SMTP 五键同模式）。

### 8.4 各消费方的接法

| 链路 | local | s3 |
|---|---|---|
| 最后一块转正 | rename + stat | lib-storage Upload（tmp 流式，>5MB 自动 Multipart）→ 删 tmp |
| 下载 / 预览 | createReadStream({start,end}) | GetObject + Range 参数透传（206 服务端原生） |
| ClamAV 扫描 | 磁盘流 → scanStream | GetObject 流 → scanStream（同一入口） |
| zip 打包 | archiver → pipe 写盘 | archiver → Upload（Readable.from 适配，见 §9） |
| zip 下载 | 磁盘流 | GetObject 流 |
| 单文件删除 / 注销 / jobs 清理 | unlink / rm -rf | DeleteObject / ListObjectsV2 翻页 + DeleteObjects 批删（1000/批） |
| 直传（方案 B） | 不支持（StorageCapabilityError → 404，前端降级代理） | initDirectUpload（清残留 → CreateMultipartUpload → 逐块预签名）/ completeDirectUpload（Complete + Head 取字节数）/ abortDirectUpload（按 uploadId 反查 Key 后 Abort，幂等） |

### 8.5 E2E 验证（两模式全绿）

- **s3 模式**（MinIO）：建分享 → 单块上传（tmp 转正 → S3，本地 tmp 已删）→ complete 202 →
  ClamAV 扫描 CLEAN（GetObject 源流）→ zip 就绪（archiver → Upload）→ 全量下载逐字节一致 →
  Range 206 → zip 下载 → mc 桶内对象核对（2 文件 + archive.zip）→ 删单文件对象同步删 →
  删分享 S3 全清 + 本地 tmp 目录回收（16 项断言）
- **local 模式**：单块 + 3 块多块上传（26MB，协议回归）→ complete → 扫描 → zip 落盘 →
  下载比对 → 删单文件 / 删分享磁盘回收（12 项断言）

> **MinIO 预研容器**：`docker-compose.yml` 的 `minio` 服务（`bitnamilegacy/minio:latest`——
> 官方 `minio/minio` 已从 Docker Hub 下架、quay.io 直连被墙、国内加速器无缓存，本机唯一可拉取）。
> S3 API `http://localhost:9000`，凭证取 `.env.development` 的 `MINIO_ROOT_*`；
> 该构建无内置控制台 UI，管理用容器自带 mc：`docker exec sharelink-minio mc ls local/`
> （Bitnami 已预配 local 别名 = root 凭证）；dev 桶 `sharelink-dev`。

### 8.6 预签名直传（方案 B，2026-10-17 落地）

字节不再穿过 Node：后端只做控制面（签 URL / 确认 / 中止），浏览器逐块 PUT 直达对象存储。
契约逐字对齐前端休眠直传代码（`uploadFileDirectS3`），**前端零改动**。

```
POST /api/shares/:shareId/files/upload-init     { id, name, totalChunks }
  200  { directToS3: true, uploadId, urls[] }   // urls[chunkIndex] ↔ PartNumber=index+1
  404  local 驱动（CapabilityError 映射）→ 前端永久降级代理
  400  chunkSize < 5MiB 且 totalChunks > 1（S3 multipart 除末块外每块 ≥ 5MiB，
       不前置拦截则 complete 时才 EntityTooSmall）
POST /api/shares/:shareId/files/upload-complete { id, name, uploadId, parts: [{ ETag, PartNumber }] }
  200  { id, name }                              // File 表登记，幂等（重试不撞 NoSuchUpload）
POST /api/shares/:shareId/files/upload-abort    { name, uploadId }   // 无 fileId！
  200  幂等（ListMultipartUploads 按 uploadId 反查 Key；查不到视为已中止）
```

设计要点：

- **能力协商**：三方法进 StorageBackend 接口、仅 S3Storage 实现，LocalStorage 抛
  `StorageCapabilityError` → FileService 转 404——前端"探测失败→降级"兜底即协商机制
- **防孤儿分片**：init 前 `ListMultipartUploads`（Prefix=`{shareId}/{fileId}`）先 Abort 残留
  会话（重传/刷新堆积的孤儿分片占存储计费）；deleteShare 同样中止 in-flight 会话
- **大小预检**：init 时按 `totalChunks × chunkSize` 粗上界校验 limit（直传后没有逐块检查点，
  必须前置卡总量）；5MiB 分片规则前置为 400（init 失败即触发前端降级，代理模式无此约束）
- **Host 绑定**：签名绑定 Host——预签名 client 用 `S3_PUBLIC_ENDPOINT`（缺省回退
  S3_ENDPOINT）；生产 compose 的 S3_ENDPOINT 是容器内网名，浏览器到不了，必配 public 端点
- **URL 有效期**：`S3_DIRECT_URL_EXPIRES`（秒，默认 86400；sigv4 上限 7 天）
- **CORS**：MinIO 默认放行跨源 PUT（ACAO 回显 Origin + ETag 可读），无需额外配置
  （浏览器 E2E 实测：OPTIONS 预检 204 + PUT 200）
- **扫描/zip/下载零改动**：File 行在 upload-complete 登记，share.complete 起的扫描
  （`openContentStream`）与 zip 打包对直传对象原样可用
- **边界（v1）**：直传不做跨刷新断点续传（刷新丢 etag 集合，complete 会 InvalidPart）；
  失败 → abort → 前端 5s 整文件重试 → 重新 init（防孤儿清理接住旧会话）；
  代理模式的"磁盘字节即真相"续传语义不变

**直传 E2E（全绿）**：init 签发 2 块 URL → 预签名 PUT 5.5MiB + 尾块（etag 回执 + ACAO 回显）→
complete 落库 → share complete 202 → abort 假 uploadId 幂等 201 → 下载字节数精确吻合 →
mc 对象核对 → 删分享对象全清；local 驱动 upload-init 404（消息「当前存储驱动不支持直传」）；
浏览器真实 UI 上传（:3001 → PUT :9000 跨源直传，CompletedModal 出现，无降级日志）。

## 9. 坑清单（历史踩坑存档）

- **archiver v7 不是内建 stream**：Archiver 原型链挂着 readable-stream 包的 Transform
  （构造器同名但不同源），`instanceof Readable`（内建）判 **false**——lib-storage 按
  `instanceof Readable` 分类 Body 会抛 "Body Data is unsupported format"。解法：
  `Readable.from(archive)` 适配成内建流（对真 node 流同样安全，error 经异步迭代传播）
- **archive.finalize() 不可省**：append 完必须 `await finalize()` 再交 saveZip——不收尾则
  归档永不结束，pipe close / Upload done 全部**无错挂起**（表现为 zip 打包"卡死"而非失败）。
  finalize 的 promise 在 zip 模块流 'end' 时 resolve，先 finalize 后接消费者是安全的
  （已实证：5MB 内容无消费者 finalize 正常 resolve，产物合法）
- **file id 必须 36 位 UUID**：正则校验不过直接 400；分享 id 是 8 位 nanoid，两者别混
- **nanoid 字符表**：前端 `components/upload/nanoid.ts` 曾漏 `-`/`_` 导致 `& 63` 越界拼进
  `undefined`——已对齐官方 64 字符表，改动前先 node -e 校验 length+unique
- **archiver 必须 v7 + @types/archiver@6**：v8 纯 ESM 类导出与 CJS 产物不兼容
- **Nest 11 中间件通配符**：`forRoutes("shares/:shareId/files/*")` 语义破坏性变更——
  一律用控制器类引用 `forRoutes(FileController)`
- **Express 5 params/query**：值类型是 `string | string[]`，取值处统一 `String()` 收窄
- **zip 未就绪**：GET /zip 会 400，前端须先轮询 metaData 的 isZipReady
- **BigInt 序列化**：`JSON.stringify` 直接抛错，出接口前 toString
- **前端**：useUpload 传 Ref 不传数组快照；chunkSize 用 getter 不用定值；
  文件行布局用 flex + `min-width:0`（el-table 固定列宽窄屏横向裁切）

## 10. 面试速答（高频问题 30 秒版）

**Q1 断点续传怎么实现的？**
服务端以磁盘字节数为唯一事实：`expectedChunkIndex = ceil(已收字节 / chunkSize)`，与请求的
chunkIndex 不匹配就 400 并返回 expectedChunkIndex，客户端跳块重传。客户端崩溃、重复请求、
并发乱序都安全——因为进度不在客户端内存里，在磁盘文件大小里。

**Q2 为什么分块上传而不是一个大 multipart？**
内存可控（单块 ≤ chunkSize 才进 Buffer，整文件永不进内存）；可断点续传（块是天然断点单位）；
octet-stream 原始体省掉 multipart 编解码开销；chunkSize 是运行时配置，admin 可调。

**Q3 下载的 Range 是怎么支持的？为什么自实现而不用 range-parser？**
自解析 `bytes=start-end`（含 `bytes=-N` 后缀区间）返回闭区间，service 按区间 `createReadStream`，
controller 组 206/416。自实现是因为只用单区间语义、几十行零依赖；通用场景可以直接用库——
这是"按需取舍"不是"重复造轮子"。

**Q4 上传/下载的内存占用为什么稳定？**
上传：express.raw 只缓冲单块；下载：createReadStream 流式（内存占用 ≈ 流缓冲）。
zip 打包同样流式 append。全链路没有任何"整文件进内存"的点。

**Q5 用户上传一个 HTML 怎么防 XSS？**
三层：`X-Content-Type-Options: nosniff`（禁嗅探）、被动媒体白名单（video/audio/image/svg除外/
text 可 inline）、其余类型强制 `Content-Security-Policy: sandbox`（inline 打开也禁脚本/同源访问）。

**Q6 病毒扫描和打包怎么解耦的？**
回调注入：`scanShare(id, onDone)`，complete 传 `onDone = createZip`——ScanService 不知道 zip
存在，依赖单向无循环；202 立即返回，扫描打包全异步。

**Q7 文件大小为什么要 BigInt？**
MySQL BIGINT ↔ Prisma 映射就是 BigInt；JS number 在 >2^53 后不精确，>2GB 文件必须 BigInt。
坑在序列化：`JSON.stringify` 遇 BigInt 直接抛错，出接口前 toString。

**Q8 maxViews（限浏览次数）怎么计数的？**
只在两个入口计：访问令牌签发时、无令牌直连下载时；带令牌重复请求不重复消耗（令牌本身就是
凭证）。过期分享 404 处理（不是 403——不暴露存在性）。

**Q9 匿名用户怎么能往别人的分享里传文件？**
反向上传：创建者生成 reverse_share_token（带过期+剩余次数），匿名访客带该 cookie 请求时
CreateShareGuard 在 JWT 失败后降级校验它；产物是"匿名分享"（creatorId=null），
StrictShareOwnerGuard 放行任何人管理——匿名分享删除另有 service 层拦截防恶意清空。

**Q10 将来怎么迁到 S3？**
已经迁完（§8）：存储双模式 local|s3 一套代码，STORAGE_DRIVER 一个键切换；分块暂存协议、
断点续传、RawBodyMiddleware 全部零改动。presigned 直传三端点也已落地（§8.6）：
字节绕过应用服务器、浏览器直传对象存储，local 驱动 404 触发前端自动降级，双模式共存。
