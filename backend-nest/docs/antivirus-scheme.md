# 病毒扫描方案（ClamAV · complete 后异步扫描）

> 2026-10-09 落地。决策：INFECTED 删磁盘保留记录（透明可查）；扫描失败 fail-open 放行 + jobs 重扫自愈。

## 前置知识：服务端病毒扫描的方案空间

> 面试先讲"为什么扫、用什么模式、失败怎么办"，再进本项目实现（正文 §2/§6/§7）。

### 1. 为什么服务端要扫毒

用户上传是恶意文件分发的经典入口（挂马压缩包、钓鱼附件）。文件分享平台不做扫描 = 变相成为恶意软件中转站——合规风险之外，域名信誉会被浏览器 / 邮件网关拉黑。ClamAV 是开源业界的标配引擎（思科维护、病毒库免费更新）。

### 2. 引擎两种工作模式（为什么选 clamd 而不是 CLI）

- **CLI 逐次调起（clamscan）**：每次调用重新加载数百 MB 病毒库（20s+）——只适合低频离线场景，在线接口完全不可用
- **守护进程 clamd**：病毒库常驻内存，暴露 TCP 端口（3310），INSTREAM 协议把文件流式送进去，秒级出结果——在线服务的正确姿势

本项目自写 ~60 行 INSTREAM 客户端（`zINSTREAM\0` + 4 字节长度前缀分块 + 响应解析），零依赖（§2）。

### 3. fail-open vs fail-closed（核心取舍）

扫描失败（引擎挂了/超时/超限）时怎么办：

- **fail-closed 拦截**：安全优先——但引擎抖一下 = 全站上传不可用
- **fail-open 放行**：可用性优先——风险窗口靠**定时重扫自愈**压缩

本项目选 fail-open（ERROR 落库 + 每小时重扫，§7）+ 感染处置双保险（删磁盘 + 下载链路 403，§6/§8）。

### 4. 扫描时机

上传中扫描（阻塞上传协议，体验差）/ **complete 后异步**（先隔离后放行，本项目）/ 下载时（窗口太晚，文件已存了一段时间）/ 定时兜底重扫。混合策略：complete 异步为主 + jobs 重扫兜底。

### 5. 术语速查

| 术语 | 一句话解释 |
|---|---|
| 签名 signature | 病毒特征码（如 Eicar-Test-Signature），报毒时返回的标识 |
| 病毒库 | 特征数据库，需定期更新（freshclam） |
| INSTREAM | clamd 的流式送检协议，文件不必落盘即可扫 |
| 隔离 quarantine | 删除/移走危险文件但保留记录痕迹 |
| EICAR | 反病毒行业公认测试文件（一段 ASCII 串，所有引擎都报毒） |
| 误报 / 漏报 | 干净文件报毒 / 恶意文件放行 |

## 1. 部署（docker-compose.yml → clamav 服务）

- 镜像 `clamav/clamav:latest`（内置 clamd + freshclam）；容器名 sharelink-clamav
- **端口映射 3310 仅因开发环境后端跑宿主机**（`localhost:3310`，CLAMAV_PORT 可覆盖）；生产 backend 在容器内时可删映射，走服务名
- 病毒库 named volume `clamav_data` 持久化（~250MB，避免重启重下）；freshclam 每日自动更新
- healthcheck 必须用镜像自带 `clamdcheck.sh`（不能用端口探测：clamd 库加载完成前可能已监听但拒扫）；`start_period: 300s` 是首次下载病毒库的宽限
- 内存预算 **1~1.5GB**（病毒库全量驻留）；资源紧张可在 config 关 `antivirus.enabled`

## 2. 客户端（clamav.service.ts）——自写 INSTREAM，零依赖

不用 clamscan CLI（每次 spawn 重载病毒库 20s+）；不用 clamdjs（维护停滞）。INSTREAM 协议 ~60 行：

```
zINSTREAM\0 → 循环 [4字节大端长度][chunk≤128KB]（write 返回 false 时等 drain 背压控制）
→ 0 长度块结束 → 响应（\0 结尾）：
  "stream: OK"                    → clean
  "stream: <签名> FOUND"          → infected（提取签名）
  "INSTREAM size limit exceeded"  → ClamAvError（文件超 StreamMaxLength）
```

- 连接参数走 env（CLAMAV_HOST/CLAMAV_PORT）——环境相关不进 config.yaml
- 连接超时 5s（clamd 假死快速失败）；扫描响应超时 5min（大文件病毒库匹配慢）
- 流式读盘（内存恒定 ~chunk 大小），不整读大文件

## 3. 模块架构与接线

```
ShareModule.complete ──void 异步──→ ScanService.scanShare(id, onDone)   （AntivirusModule exports）
JobsModule.任务8 ─────────────────→ ScanService.findRescanCandidates / rescanFile
ScanService ──模块内私有──────────→ ClamAvService ──TCP 3310──→ clamd 容器（INSTREAM）
ScanService ──@Global 免显式接线──→ PrismaService（状态机落库）/ AppConfigService（antivirus.enabled）
```

- **模块面**：`AntivirusModule` = providers `[ClamAvService, ScanService]` + exports `[ScanService]`。
  ClamAvService 只被 ScanService 内部消费，不导出（缩小 API 面）；Prisma/Config 全局模块无需 import
- **依赖方向严格单向**：ShareService → ScanService → ClamAvService，无环。
  zip 打包以**回调注入**（`scanShare(id, onDone)`）解耦——ScanService 不知道 zip 的存在，
  ShareModule 侧传 `() => this.createZip(id)`；反之 JobsModule 只依赖 ScanService 的重扫方法
- **complete 接线**（share.service.ts）：多文件 → `onDone = () => this.createZip(id)`（先扫描后打包，
  INFECTED 绝不进包）；单文件 → 无 zip 语义不传 onDone。`void scanShare(...).catch(...)` 兜编排级意外
  （scanOne 内部已逐文件容错），HTTP 202 立即返回，扫描全程后台进行

## 4. 代码用法

**ClamAvService**（纯协议客户端，无状态，可复用）

| 方法 | 签名 | 语义 |
|---|---|---|
| scanFile | `(filePath: string): Promise<ScanResult>` | 流式读盘送 clamd；成功 `{ clean: boolean, signature?: string }`；失败抛 `ClamAvError`（连接失败/连接超时 5s/扫描超时 5min/超 StreamMaxLength/未知响应） |

**ScanService**（编排 + 状态机，唯一消费 ClamAvService 的地方）

| 方法 | 调用方 | 语义 |
|---|---|---|
| scanShare | ShareService.complete | share 级入口：开关关闭 → 全部落 CLEAN（含历史 PENDING）；否则扫 PENDING/ERROR，终态后调 onDone（幂等） |
| rescanFile | jobs 任务 8 | 单文件重扫，复用 scanOne 状态机，返回终态 ScanStatus 供调用方决定是否补打 zip |
| findRescanCandidates | jobs 任务 8 | `scanStatus=ERROR` 且 share `uploadLocked`（未完成骨架由任务 3 兜底，不重复回收） |
| onModuleInit | Nest 生命周期 | 启动时把卡死的 SCANNING 重置 PENDING（进程被杀残留，无人再扫会永远卡住） |

**数据消费（扫描结果如何被读走）**

- 后端：`File.scanStatus / scanSignature / scannedAt` 随 share 详情（metaData/详情接口）下发；
  `file.service.ts` 的 `get()` 与 `getZipStream()` 单文件分支对 INFECTED 返回 403 `file.quarantined`（i18n）
- 前端 `ShareView.vue` 文件行徽标：INFECTED → danger「已隔离」+ 隐藏下载按钮；
  SCANNING/PENDING → info「扫描中」；CLEAN/ERROR → 无徽标（无噪音）。
  **状态只在 onMounted 取一次，扫描进行中打开的页面不会自动变化，需手动刷新**（如需实时，见演进留白轮询项）

**扩展点**

- 换杀毒引擎：新 Provider 以 `ClamAvService` class token 注册、实现同签名 `scanFile` 即可，状态机/编排零改动
- 新增扫描状态：Prisma enum + scanOne 流转 + 前端徽标三处同步
- 改「上传中逐块扫、不等 complete」：scanOne 是单文件原子单元可在 createChunk 收尾触发，
  SCANNING 状态天然是并发调度挡板，complete 全量扫描不会重扫已 SCANNING 的文件

## 5. 数据模型（File.scanStatus 状态机）

```
PENDING（上传完成默认）→ SCANNING（防重复调度）→ CLEAN / INFECTED / ERROR
```

- **CLEAN**：可进 zip、可下载
- **INFECTED**：磁盘文件已删（第一层防线），下载链路 403（第二层双保险）；表记录保留——owner 可见「已隔离」+ `scanSignature`（如 Eicar-Test-Signature）
- **ERROR**：clamd 不可用/超时/超限制——**fail-open 放行下载**，jobs 任务 8 每小时重扫自愈
- **读盘前 existsSync 预检**：磁盘文件丢失（INFECTED 处置中断于 unlink 与状态更新之间、或被杀毒软件隔离）时无法扫描，落 ERROR 会进入「重扫→读盘失败→永远 ERROR」死循环——直接落 INFECTED 终态跳出（语义与隔离完成等价）
- `scannedAt` 记扫描时间；编辑场景（revertComplete 补传）再次 complete 全部重走

## 6. 扫描编排（scan.service.ts）——先扫描后打包（核心顺序）

`complete` 202 立即返回，后台 `void scanService.scanShare(id, onDone)`：

```
① enabled=false → 全部文件直接落 CLEAN（含历史 PENDING）→ onDone
② enabled=true  → 扫 PENDING/ERROR 的文件（CLEAN 不重扫、INFECTED 已无内容）
   逐文件：置 SCANNING → clamd INSTREAM → CLEAN/INFECTED（unlink 磁盘+记签名）/ERROR
③ 全部终态 → onDone = shareService.createZip（回调注入，依赖方向 ShareService→ScanService 单向无环）
```

- **先扫后包的原因**：若先打 zip 事后发现病毒需重打包，引入额外复杂度；扫完再包则 INFECTED 天然不进包
- `createZip` where 加 `scanStatus: { not: "INFECTED" }`；全部隔离时 files 为空 → 跳过打包（isZipReady 保持 false）
- 启动时 `onModuleInit` 把卡死的 SCANNING 重置 PENDING（进程被杀残留）
- 回调注入而非依赖反转：`ShareService` 传 `() => this.createZip(id)`，ScanService 不需要知道 zip 存在

## 7. 自愈（jobs 任务 8 rescanErrorFiles @Cron "0 20 * * * *"）

每小时第 20 分（与任务 7 的 02:00 错峰）：

1. `findRescanCandidates()`：`scanStatus=ERROR` 且 share `uploadLocked`（未完成的骨架由任务 3 兜底回收）
2. 逐个 `rescanFile` 复用 scanOne 状态机
3. 重扫 CLEAN 且所在 share 多文件 + `!isZipReady` → `shareService.rebuildZip`（ShareModule exports ShareService）补打包——首次打包时 ERROR 文件未进包，通过后包里该有它

## 8. 下载拦截（file.service.ts）

- `get()`（单文件/Range）：`scanStatus === INFECTED` → **403 file.quarantined**
- `getZipStream()` 单文件降级分支：同 403（多文件走 archive.zip，打包时已排除）

## 9. 配置

| 项 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `antivirus.enabled` | config 清单（admin 可改） | `true` | 关闭时 complete 后全部直接落 CLEAN |
| `CLAMAV_HOST` / `CLAMAV_PORT` | env | `clamav` / `3310` | 开发环境 `localhost:3310` |

## 10. 前端

- ShareView 文件行：INFECTED → 红色「已隔离」tag + **隐藏下载按钮**；SCANNING/PENDING → 灰「扫描中」；CLEAN/ERROR 无徽标（无噪音）
- CompletedModal：完成弹窗顶部 info alert「服务器正在对上传文件进行病毒扫描…」（i18n `upload.modal.scan.notice`，zh+en）

## 11. E2E（Windows 开发机：EICAR 不可用，用自定义签名）

**坑：EICAR 在开着 Windows Defender 的宿主机上测不了。** EICAR 一落盘 Defender 立即拦截/隔离（连 `.tmp-chunk` 中间态都拦），后端 `createReadStream` 打开文件直接 `UNKNOWN: unknown error, open ...` → ClamAvError → 落 ERROR——症状极像「clamd 连不上」（连接其实通，是读盘失败；clamd 日志无 instream 记录）。探针直发字符串（不落盘）能 FOUND、落盘文件必失败，是这个问题的指纹。

替代方案：给 clamd 注入自定义签名（Defender 不认识，走完全相同的扫描管线）：

1. 造 `.ndb` 签名文件（**必须 4 段 `名称:0:*:HEX`**——真实库格式是 `名称:类型:偏移:签名`，少一段偏移会报 Malformed database；文件要以 LF 结尾）：
   ```
   ShareLink-E2E-Test:0:*:<ASCII 魔法串的 HEX>
   ```
2. `docker cp` 进容器 `/var/lib/clamav/` → 向 3310 发 `zRELOAD\0` → 日志确认签名总数 +1（RELOAD 是原子的：任一文件坏则整轮不生效）
3. 上传含魔法串的文件走完整协议（signIn → POST /shares → files 分块 → complete 202 → token → GET 文件）

**实测结果（2026-10-10，全绿）**：

| 断言 | 感染文件（含魔法串） | 干净文件 |
|---|---|---|
| scanStatus | INFECTED | CLEAN |
| scanSignature | `ShareLink-E2E-Test.UNOFFICIAL` 落库（clamd 给非官方库签名自动加 .UNOFFICIAL 后缀） | null |
| 磁盘文件 | 已删（扫描处置 unlink） | 保留 |
| 下载 | 403「该文件已被病毒扫描隔离，无法下载」 | 200 内容正确 |

测试后已还原：容器内 ndb 已删 + RELOAD（恢复纯官方库），测试分享（DB 行 + 磁盘目录）已清。

## 12. 演进留白

- **前端实时刷新扫描状态**：ShareView 仅 onMounted 取一次状态，扫描进行中打开的页面需手动刷新——可加 metaData 轮询（仅当列表存在 SCANNING/PENDING 文件时低频轮询，全部终态即停）
- **StreamMaxLength**：超限文件落 ERROR（fail-open），部署侧可在 clamav 容器调大 clamd.conf 的 StreamMaxLength（本客户端不盲改对端配置语义）
- **INFECTED 恢复误报**：目前无白名单机制，误报需 admin 到 DB 手工改状态——等需求
- **上传时逐文件扫**（不等 complete）：大分享减少末尾等待——现状 complete 后一次性扫全量，够用
- **扫描结果通知 owner**（邮件/站内信）：等邮件模板体系补齐
