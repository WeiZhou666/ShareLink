# 定时任务方案（Jobs 统一调度）

> 面试学习文档 · 与代码全量同步（2026-10-08）
> 姊妹篇：[token-scheme.md](./token-scheme.md)（JWT 双 token 体系）、[config-scheme.md](./config-scheme.md)（应用配置）、[users-scheme.md](./users-scheme.md)（账号注销）

---

## 前置知识：后台定时任务

> 面试先讲"为什么需要、怎么写表达式、多实例会怎样"，再进本项目任务清单（正文 §1/§2）。

### 1. 为什么需要定时任务

一批系统行为天然是"延迟/周期"的：过期数据清理、软删冷静期到点物理删、扫描失败重试、过期会话回收。没有定时任务，这些要么永远不做，要么堆进请求线程做（拖死接口、超时扩散）。

### 2. cron 表达式（六段式）

NestJS @Cron 用 **"秒 分 时 日 月 周"** 六段（注意与 Linux crontab 五段差一个秒位）。例：`0 20 * * * *` = 每小时第 20 分；`0 0 2 * * *` = 每天 02:00。语义是"**到点触发**"而非"间隔多少"——所以"错峰"就是给不同任务排不同的分钟位。

### 3. 单实例假设（重要边界）

@Cron 是**进程内调度器**：多实例部署时每个实例都会到点跑一遍 → 任务并发重复执行（清理类通常幂等无害，但计数/统计类会翻车）。解法：Redis 分布式锁（setnx + 过期）或选主。本项目当前单实例，演进留白见 §5。

### 4. 任务健壮性三件套（本项目的实践）

- **幂等**：任务随时可能重跑，写成"重跑无害"（updateMany + where 条件天然幂等）
- **错峰**：多个任务别排同一秒——DB 连接池（limit=10）会被挤兑、清理类并发会产生磁盘 IO 风暴；本项目任务全部错开分钟位
- **任务内 try-catch**：一个任务抛异常不能拖死调度器、更不能影响别的任务

### 5. 术语速查

| 术语 | 一句话解释 |
|---|---|
| @Cron / Schedule 模块 | NestJS 官方进程内定时调度 |
| 幂等 idempotent | 重复执行结果不变——定时任务的第一设计原则 |
| 错峰 staggering | 把任务的触发时刻互相错开，防资源挤兑 |
| 分布式锁 | 多实例下保证"同一任务同一时刻只跑一份" |
| 补偿重试 | 定时任务兜底修复异步流程的失败（如重扫 ERROR 文件） |

## 0. 一句话总纲

> **全项目所有 `@Cron` 只存在于 `src/jobs/jobs.service.ts` 一处**（原 share 模块 `ExpiredShareCleanupService`、auth 模块 `RefreshTokenCleanupService` 均已并入，消灭双重清理路径）。过期门禁与磁盘回收分离：分享一过期，公开访问立即 404（查询时判断），但磁盘文件与表记录要等任务回收——**任务只做"物理回收"，不做"逻辑门禁"**。当前 8 个任务按分钟位错峰执行：任务 1-6 从 00:05 起每 15 分钟一个（00:05/00:20/00:35/00:50/01:05/01:20），任务 7（软删物理清）02:00，任务 8（扫描失败重扫）每小时第 20 分——避免同秒并发挤兑 DB 连接池与磁盘 IO（见 §1 频率注）。

与旧后端（Pingvin Share）的差异：旧版任务散落在各模块 service 里（share 的清理 + auth 的令牌清理各自 `@Cron`）；新版集中一个 service 一个模块，删除顺序、排除规则、语义注释全部就地可查。

---

## 1. 八个任务一览

| # | 方法 | 频率 | 回收对象 |
|---|---|---|---|
| 1 | `deleteExpiredShares` | 每天 00:05 | 过期分享：磁盘目录 + Share 表记录 |
| 2 | `deleteExpiredReverseShares` | 每天 00:20 | 过期反向分享令牌 + 名下分享解绑置过期 |
| 3 | `deleteUnfinishedShares` | 每天 00:35 | 超 1 天未完成上传的分享骨架 |
| 4 | `deleteExpiredTokens` | 每天 00:50 | 过期 refresh 会话行 + User 行上的过期重置码 |
| 5 | `deleteUnactivatedUsers` | 每天 01:05 | 注册 24h 未激活的账号（连名下分享文件） |
| 6 | `deleteTemporaryFiles` | 每天 01:20 | 超 1 天的 `.tmp-chunk` 分块暂存孤儿 |
| 7 | `deleteSoftDeletedUsers` | 每天 02:00 | 冷静期（182 天）到期的软删用户：磁盘 + 行，名字随行释放 |
| 8 | `rescanErrorFiles` | 每小时第 20 分 | ClamAV 扫描失败（ERROR）文件重扫自愈，终态后补打 zip |

> 频率注：全部任务按分钟位**错峰**执行。历史上曾统一零点同秒——实测清理任务同刻并发会挤兑 DB 连接池（Prisma limit=10）并制造磁盘 IO 风暴；错峰后任意时刻至多一个任务占池。任务之间的协作用**数据状态衔接**（如任务 2 把分享置过期 → 次日任务 1 回收磁盘，最多延迟一个周期），不直接互相调用；回收延迟由查询时的 404 门禁兜底，不影响安全。

---

## 2. 逐任务语义

### 2.1 deleteExpiredShares

- 条件：`expiration < now 且 != NEVER_EXPIRES`（1970-01-01）。**NEVER_EXPIRES 恒小于 now，必须显式排除，否则"永不过期"的分享会被第一轮任务误删**。
- 顺序：**先删磁盘目录、再删表记录**。反过来做的话，磁盘删除一旦失败（句柄占用、权限）就留下无主目录，再也没人认领。
- 完成后门禁兜底：即便磁盘多留一个周期，过期分享的公开访问也早已 404（查询时判断），不影响安全，只占空间。

### 2.2 deleteExpiredReverseShares（链式三步，事务内）

1. 删过期令牌行；
2. 令牌名下 `reverseShareTokenId` 挂靠的分享**解绑**（置 null）；
3. 这些分享**置为立即过期**（`expiration = now`）。

语义：匿名上传入口没了，这些分享不能再续传/补文件。置过期后交给任务 1 顺路清磁盘——**任务之间用数据状态衔接，不直接互相调用**。

### 2.3 deleteUnfinishedShares

- 条件：`isUploadLocked = false 且 updatedAt < now - 1 天`。创建分享骨架后从未 `complete` 的半成品（用户关了页面/断网放弃）。
- 新 schema 的 `updatedAt` 是 `@updatedAt` 非空字段，创建即有值——旧版"updatedAt 为空则看 createdAt"的兜底分支不再需要。

### 2.4 deleteExpiredTokens

- RefreshToken 表：`expiresAt < now` 的行整体删除。**保留规则：`expiresAt > now` 的行无论是否 revoked 都必须留**——revoked 行是"重用检测"的证据（旧 token 轮换后再次出现要能查到 `revokedAt` 才触发家族吊销）；未 revoked 行是存活会话。旧 token 一旦自然过期即失去刷新能力，此时才可安全删除。
- User 行上的重置码字段：`resetPasswordTokenExpiresAt < now` 的置空（旧版 ResetPasswordToken 表删除语义的等价迁移）。
- **TOTP 登录令牌不处理**：在 Redis 自带 TTL，到期自动消失。

### 2.5 deleteUnactivatedUsers

- 条件：邮箱未验证（`emailVerified = false`）且 `createdAt < now - 24h`。注册了但从未激活的僵尸账号。
- 删除顺序沿用 DELETE /users/me：**先删该用户名下分享的磁盘文件，再删用户行**（Share.creator 是 `onDelete: SetNull`，先删人会导致文件无主）。
- 用户行删除后：分享壳保留（SetNull 成匿名分享）、RefreshToken 级联删除——与"注销账号"完全同构。

### 2.6 deleteTemporaryFiles

- 扫 `data/uploads/_tmp-chunks/`（分块暂存目录）：mtime 超过 1 天的文件删除。
- **只扫磁盘、不查库**：暂存分块本身没有表记录，mtime 是唯一可靠的废弃判据。正常上传的分块几分钟内就会被 complete 消费合并，不能随删随清；超过 1 天仍在 = 上传会话早已关闭的永久孤儿。

### 2.7 deleteSoftDeletedUsers

- 条件：`deletedAt != null 且 deletedAt < now - 182 天`（冷静期常量 ACCOUNT_RETENTION_MS）。
- 删除顺序与"注销账号"完全同构：**先清名下分享磁盘 → 吊销全部会话 → 删用户行**。
- 名字释放：占名方案下 username/email 原值保留占用唯一索引（冷静期内同名注册被 P2002 拦截防冒充），物理删行后名字自动释放，无需任何额外清理。
- 冷静期内的软删用户登录被拦截（403 + `account_deleted`），可自助恢复——只有到点没恢复的才进本任务。

### 2.8 rescanErrorFiles

- 条件：`scanStatus = "ERROR" 且 share.uploadLocked = true`（join 分享判活，排除已随分享删除的孤儿行）。
- 语义：ERROR 是 ClamAV 扫描失败（引擎不可用/超时/超 StreamMaxLength）的 fail-open 状态——下载放行但不可信，本任务每小时补扫自愈。
- 复用 `ScanService.rescanFile` → `scanOne` 状态机：磁盘文件已丢失时直接落 INFECTED 终态跳出（防"重扫 → 读盘失败 → 永远 ERROR"死循环）。
- 回到 CLEAN/INFECTED 终态后，若多文件分享的 zip 因 ERROR 未打全，经 `ShareService.rebuildZip` 补打（zip 打包时过滤 INFECTED）。

---

## 3. 高频坑清单

1. **`@Cron` 表达式必须 6 段（秒 分 时 日 月 周）**。写成 7 段（`"0 0 0 * * * *"`，croner 的周日字段习惯）会抛 `CronError: Too many fields`——**异常发生在模块初始化注册阶段，后端启动即崩且 watch 崩溃循环**，前端所有请求经代理打到死端口表现为 500。本项目真实踩过（2026-10-08）："登录 500" 的根因不是登录接口，是后端整个不在了。
2. **先磁盘后表**（任务 1/5）：反序会留下无主目录。
3. **NEVER_EXPIRES 显式排除**（任务 1）：漏了会清掉所有"永不过期"的分享。
4. **Windows delete-pending 观察误判**：`rmSync` 成功后，若还有进程持有句柄，资源管理器/`ls` 里目录可能仍显示——文件已被标记删除，句柄关闭后真正消失。E2E 时"日志说删了、目录还在"不一定是 bug（本项目实测踩过，生产每天一次不可见）。
5. **任务不绕 service 层**：清理以"系统身份"直接操作 prisma/磁盘——service 方法（如 `reverseShareService.remove`）带创建者鉴权与业务副作用，定时任务复用会误触权限拦截。语义对齐靠注释与测试保证。
6. **`ScheduleModule.forRoot()` 挂在 AppModule**，JobsModule 只需普通 `@Module` + providers——重复 `forRoot` 会导致调度器行为异常。

---

## 4. E2E 验证方法

定时任务不好等真实触发，**临时把 `@Cron` 改成 `"* * * * * *"`（每秒）** + tsx 造数 + 看日志，验证完还原：

| # | 造数 | 期望 |
|---|---|---|
| R1 | 过期分享 + 磁盘目录 | 表记录 + 磁盘目录全消 |
| R2 | 过期反向令牌 + 挂靠分享 | 令牌删 → 解绑 + 置过期 → **下一秒**被任务 1 连磁盘清掉（链式衔接） |
| R3 | `updatedAt` 改 2 天前的未完成分享 | 删除 |
| R4 | 过期 refresh 行 + 过期重置码 | 行删除 + 字段置空；**未过期的 revoked 行保留** |
| R5 | `createdAt` 改 2 天前的未激活用户 + 名下分享文件 | 文件删净、分享壳留存（creatorId=null） |
| R6 | mtime 改 2 天前的 tmp-chunk 文件 | 删除（Windows 句柄占用时表现为 pending，见坑 4） |

2026-10-08 全绿。造数脚本注意：`npx tsx -e` 里 prisma create 偶发"同脚本可见、跨进程消失"的未落库现象——重要造数用 upsert 并**开第二个进程验证存在**。

---

## 5. 演进留白

- **频率配置化**：当前写死在 `@Cron` 字符串；旧版曾有 `SHARE_CLEANUP_CRON` 环境变量（已随 ExpiredShareCleanupService 并入而移除）。若部署需要，可统一为 `JOBS_CRON_<NAME>` env 覆盖（`@Cron(process.env.X ?? '默认')`），出现需求再做；
- **分布式部署**：多实例部署时任务会重复执行——届时需要分布式锁（Redis SETNX）或主实例选举，单实例阶段不过早设计；
- **清理指标**：每次删除量目前只进日志，后续可落 metrics 便于观察磁盘回收趋势。
