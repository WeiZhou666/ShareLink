# 部署方案（docker-compose 五容器 · env 生产校验 · 生产 checklist）

> 面试学习文档 · 与代码全量同步（2026-10-12）
> 姊妹篇：[env-scheme.md](./env-scheme.md)（env 文件体系与 zod 校验细则）、[antivirus-scheme.md](./antivirus-scheme.md)（ClamAV 细节）、[database-scheme.md](./database-scheme.md)（连接接线）

---

## 前置知识：容器编排的三个基本功

> 面试先讲"依赖容器化"的边界与 healthcheck 的意义，再进本项目实现（正文 §1/§2）。

### 1. 哪些东西进容器：应用与依赖的分界

业界两种形态：

- **全容器化**：应用 + 全部依赖都进 compose/k8s——一致性强，但应用镜像的构建/发布链路变重
- **依赖容器化**：**有状态/第三方依赖**（数据库/缓存/存储）进容器，**应用本身跑宿主机**（node 直启）——开发迭代快、调试直连

本项目开发环境取后者：MySQL/Redis/Mailpit/ClamAV/MinIO 五个依赖进 compose，NestJS 应用 `npm run start:dev` 宿主机直启。**这正是端口映射存在的原因**：依赖容器要把端口暴露给宿主机上的应用（生产全容器化时，内部组件的端口映射可删，走 docker 网络服务名直连）。

### 2. healthcheck：编排器眼中的"活着"

容器进程存在 ≠ 服务可用（MySQL 进程起了但还没监听、ClamAV 起了但病毒库没加载完）。healthcheck 让编排器掌握**服务级就绪状态**，`docker compose up --wait` / 依赖等待工具据此决定"什么时候算启动完成"。

### 3. 数据持久化：named volume vs 容器层

容器可随时销毁重建，数据必须落在**容器外的卷**上。named volume 由 Docker 统一管理（`docker volume ls`），容器删除数据不丢——本项目五个依赖各配一个。

### 4. 术语速查

| 术语 | 一句话解释 |
|---|---|
| 端口映射 | 宿主机端口 → 容器端口（`3307:3306`），跨网络边界的桥 |
| start_period | healthcheck 的宽限期：启动慢的服务先不算失败 |
| fail-fast | 配置错误时启动期立即退出，不带病运行 |
| named volume | Docker 命名卷：生命周期独立于容器的持久化单元 |

## 0. 一句话总纲

> **五个依赖容器 + 一套 env 双消费 + 启动期 fail-fast**：docker-compose 声明 MySQL/Redis/Mailpit/ClamAV/MinIO（各配 healthcheck + named volume），同一份 `.env.development` 既喂 compose（容器凭证）又喂应用（env-loader）；应用侧三道生产闸门——env zod 校验（弱密钥/非 HTTPS cookie/无 CORS 白名单直接拒启）、winston 日志轮转落盘（生产关控制台）、shutdown hooks 优雅断连。端口策略分层：**数据面（MySQL/Redis）与工具面（Mailpit/MinIO/ClamAV-dev）映射宿主机，内部组件（ClamAV）生产收回去**。

---

## 1. 五容器一览（docker-compose.yml）

| 服务 | 镜像 | 端口 | 持久化 | healthcheck |
|---|---|---|---|---|
| mysql | mysql:8.4 | `${DB_PORT:-3306}:3306`（宿主 3307 避让本机 MySQL） | mysql_data | `mysqladmin ping`（5s 间隔 ×20 次） |
| redis | redis:7-alpine | `${REDIS_PORT:-6379}:6379` | redis_data | `redis-cli ping` |
| mailpit | axllent/mailpit | 1025（SMTP）/ 8025（网页收件箱） | 无（开发假邮局，丢就丢） | 无 |
| clamav | clamav/clamav:latest | 3310（dev 映射；**生产删除映射**） | clamav_data | `clamdcheck.sh`（30s 间隔，start_period 300s） |
| minio | bitnamilegacy/minio:latest | 9000（S3 API） | minio_data | `curl /minio/health/live` |

逐个的关键决策：

- **MySQL**：`MYSQL_ROOT_PASSWORD` 直接取 env 的 `DB_PASS`——一份凭证喂两个消费方（容器初始化 + 应用连接）；TZ 固定 Asia/Shanghai 防时区漂移；
- **Redis**：`--appendonly yes` 开 AOF 持久化——Redis 存的是**认证吊销键**（[token-scheme.md](./token-scheme.md)），Redis 重启丢数据 = 已吊销的 token 复活，AOF 是安全要求非性能选择；
- **Mailpit**：本地 SMTP 假邮局，配合 `MAIL_DELIVERY=smtp` 做邮件全链路联调（[email-scheme.md](./email-scheme.md)）；真实 SMTP（QQ 邮箱）时此容器闲置；
- **ClamAV**：**不能用端口探测做 healthcheck**——clamd 病毒库加载完成前可能已监听但拒绝扫描，必须用镜像自带的 `clamdcheck.sh`；`start_period: 300s` 给首次下载 ~250MB 病毒库留宽限期；病毒库持久化到 volume，重启不重新下载；
- **MinIO**：`bitnamilegacy` 镜像（官方 minio/minio 已从 Docker Hub 下架，国内加速器无缓存——可拉取即为此镜像，2025-05 冻结版无控制台 UI，管理用容器自带 `mc`）；`MINIO_ROOT_*` 凭证同样取自 env。

```bash
# 启动（变量取自 .env.development）
npm run docker:up      # = docker compose --env-file .env.development up -d
npm run docker:down
```

## 2. 网络与端口策略

```
宿主机 (开发)
  NestJS 应用 (node 直启, :3000)
    │ localhost:3307        localhost:6379       localhost:3310        localhost:9000
    ▼                       ▼                    ▼                     ▼
  mysql(3306)            redis(6379)          clamav(3310)          minio(9000)
    │ docker 网络内部：服务名直连（compose 项目名 sharelink 的默认网络）
    ▼
  mailpit :1025 (SMTP) / :8025 (UI)
```

- **开发环境应用在宿主机**：依赖端口必须映射出来（`CLAMAV_HOST=localhost`）；**生产应用进网络后**：ClamAV 等内部组件删除端口映射，`CLAMAV_HOST=clamav`（服务名直连）——病毒扫描是内部组件不对外暴露；
- **端口避让**：宿主 3306 常被本机既有 MySQL 服务占用，compose 用 `${DB_PORT:-3306}` 让 env 决定映射（本项目 3307）；

**Docker Desktop 实战坑档案**（Windows 开发机亲历，排障方法论宝贵）：

1. **端口转发注册条目单端口坏死**：症状是连接 3307 建立（TCP 探测通）但数据不达，Prisma 报 pool timeout（active=0 idle=0）。`docker restart` / 重启 Docker Desktop / `wsl --shutdown` **都重建不了坏注册**——必须 `docker rm -f` 容器 + `compose up` 重建容器才生成新注册（数据在 volume 无损）。诊断三招：`active=0 idle=0` = 连接建不出（非占满）；容器内 `SHOW PROCESSLIST` 无 unauthenticated user = 包没进容器；**对照实验**——同架构转发的另一端口（redis 发真实 PING）通 → 架构正常、单端口注册坏；
2. **TCP 探测不可信**：`Test-NetConnection` 显示通不代表数据层可用（wslrelay accept 后可能丢包）——必须用数据层验证（ioredis PING / Prisma 直连）；
3. **compose 拉镜像需修凭据助手 PATH**：Docker CLI 不在 PATH（`%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin` 前缀）时 credential helper 失败导致 pull 挂；
4. compose 只 up 需要的服务（`up -d mysql redis`），避免无关镜像（如 mailpit）拉取失败阻塞整体。

## 3. 应用侧部署三闸门

### 3.1 启动期 env 校验（fail-fast）

```ts
// config/env-loader.ts —— zod superRefine 的生产附加规则
if (NODE_ENV === 'production') {
  if (JWT_SECRET 是模板默认值)      → 拒启   // "manage_jwt_secret_key" 之类
  if (COOKIE_SECURE !== 'true')     → 拒启   // cookie 必须 HTTPS 传输
  if (!CORS_ORIGIN)                 → 拒启   // 不得放行所有来源
}
// 条件必填（任何环境）：
MAIL_DELIVERY=smtp  → SMTP_HOST/PORT/USER/PASS/FROM 缺一不可
STORAGE_DRIVER=s3   → S3_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY 缺一不可
```

设计原则：**校验不注入默认值**——各消费点的 `?? 默认` 行为不变，schema 只拦危险/矛盾配置；校验失败打印逐键清单后 `process.exit(1)`。**弱配置宁可起不来，不能带病上线**（完整键目录见 [env-scheme.md](./env-scheme.md) §4）。

### 3.2 日志：轮转落盘，生产关控制台

```ts
// config/winston.config.ts
createRotateTransport('error', 'error'),       // logs/error-YYYY-MM-DD.log
createRotateTransport(logLevel, 'combined'),   // logs/combined-*.log
...(isProd ? [] : [new transports.Console()])  // 生产关闭控制台输出
```

DailyRotateFile：单文件 20m 上限、保留 14 天、过期自动压缩；文件落盘用 JSON 行格式（含 meta 与堆栈，异常过滤器的 url/method/body 上下文都在里面）。日志目录 `logs/` 基于进程 cwd。

### 3.3 优雅停机

```
main.ts: app.enableShutdownHooks()
  → SIGTERM/SIGINT → Nest 生命周期钩子
  → PrismaService.onModuleDestroy → $disconnect()
```

生产环境容器/进程管理器发 SIGTERM 后，必须给应用时间做完连接清理——否则数据库侧积累半开连接。

## 4. 生产 checklist

| # | 项 | 要求 | 校验点 |
|---|---|---|---|
| 1 | JWT_SECRET | 强随机值（≥16 字符，非模板） | env-loader 拒启 |
| 2 | COOKIE_SECURE | `true`（HTTPS 传输 cookie） | env-loader 拒启 |
| 3 | CORS_ORIGIN | 显式白名单（前端 origin） | env-loader 拒启 |
| 4 | MAIL_DELIVERY | 真实发信 = smtp + 五键齐全 | env-loader 拒启 |
| 5 | STORAGE_DRIVER | s3 时四键齐全；**local 与 s3 不可中途切换**（进程级常量，换驱动留脏数据） | env-loader / [file-scheme.md](./file-scheme.md) §8 |
| 6 | 数据库 schema | 生产首启用 `prisma migrate deploy`（或先 db push + 停机窗口） | [database-scheme.md](./database-scheme.md) |
| 7 | 定时任务 | 单实例假设（jobs 的 @Cron 无分布式锁）——多实例前必须改造 | [jobs-scheme.md](./jobs-scheme.md) |
| 8 | ClamAV | 应用进容器网络后删端口映射、`CLAMAV_HOST=clamav` | compose |
| 9 | Redis | 生产建议设密码（REDIS_PASSWORD）+ AOF 已开 | compose |
| 10 | 限流存储 | 多实例部署时 Throttler 换 Redis 存储器（内存计数按进程分片） | [common-scheme.md](./common-scheme.md) |
| 11 | 日志 | logs/ 目录挂卷或接日志采集；LOG_LEVEL 调到 info | winston.config |
| 12 | 启动命令 | `npm run start:prod`（= `node dist/src/main`，注意产物路径是 dist/src） | package.json |

## 5. 高频坑清单

1. **healthcheck 不能用端口探测替代语义检查**：ClamAV 监听了 ≠ 能扫描（病毒库未加载完会拒扫）——healthcheck 要表达"服务级就绪"，用官方 check 脚本而不是 nc/curl 端口。
2. **Redis 掉数据的安全后果**：吊销键是安全状态不是缓存——AOF 必须开；同理生产 Redis 必须设密码。
3. **compose 变量来自 env 文件**：`--env-file .env.development` 漏掉时 `${DB_PASS}` 为空 → MySQL 容器初始化成空密码，与应用连接凭证对不上（`docker:up` 脚本已固化参数）。
4. **Windows + Docker Desktop 的端口坏死**（§2 实战档案）：TCP 通 ≠ 数据通；restart 重建不了坏注册；volume 保数据，`rm -f` + `up` 重建是正解。
5. **产物路径 dist/src/main**：tsconfig 布局决定 `start:prod` 是 `node dist/src/main` 而非 `dist/main`——写部署脚本时照抄 package.json。

## 6. 面试速答（30 秒版）

- **Q: 你的部署形态是什么？** 依赖容器化 + 应用宿主机（开发）：compose 五容器（MySQL/Redis/Mailpit/ClamAV/MinIO）各配 healthcheck 与 named volume，同一份 env 文件既喂 compose 又喂应用；生产 checklist 覆盖 env 闸门、单实例 cron、限流 Redis 化。
- **Q: 启动期做了哪些 fail-fast？** env-loader 用 zod 校验全部键并派生 DATABASE_URL，校验失败逐键打印后 exit(1)；生产附加三条：JWT_SECRET 非模板、COOKIE_SECURE=true、CORS_ORIGIN 必填；条件必填两段：smtp 五键、s3 四键——弱配置宁可起不来。
- **Q: 为什么 Redis 要开 AOF？** Redis 存的是认证吊销键（踢下线/登出的即时失效依据），重启丢数据 = 已吊销 token 复活——这是安全状态持久化，不是缓存。
- **Q: 遇到过什么印象深刻的容器网络问题？** Docker Desktop 端口转发注册单端口坏死：TCP 探测通但数据不达，Prisma pool timeout active=0——restart/重启 Desktop 都修不好，对照实验（同架构 redis 端口 PING 正常）锁定单端口注册坏，`docker rm -f` + `compose up` 重建容器才重新生成注册（数据在 volume 无损）。教训：容器排障要做数据层验证 + 对照实验，别信 TCP 探测。
