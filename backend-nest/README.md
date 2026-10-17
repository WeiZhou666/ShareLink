# ShareLink 后端（backend-nest）

文件分享服务的 NestJS 后端：注册用户可创建分享链接、分块上传/断点续传、打包下载；支持反向分享（免登录"帮我上传"）、密码/次数/收件人访问控制、ClamAV 病毒扫描、运营公告与管理后台。核心链路与前端约定沿用旧后端 API 契约（响应体无 code/data 包装、分块上传 202 语义、`unexpected_chunk_index` 续传协议）。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | NestJS 11（Express 5 平台）+ TypeScript |
| ORM | Prisma 7（`@prisma/adapter-mariadb` 驱动适配器）+ MySQL 8.4 |
| 认证 | JWT 双 token（access/refresh）+ cookie 传输 + refresh 轮换与重用检测；Redis 两级吊销黑名单；OAuth（GitHub + 本地 OIDC） |
| 存储 | 双驱动：本地磁盘 / S3 兼容对象存储（MinIO，`STORAGE_DRIVER` 切换） |
| 安全 | argon2id、Throttler 限流、ClamAV INSTREAM 病毒扫描、nosniff/CSP sandbox 下载头 |
| 配置 | env 文件按 NODE_ENV 加载 + zod 启动期校验；应用配置三层（config.yaml > DB > 代码默认值） |
| 可观测 | winston（nest-winston）每日轮转日志；Swagger（/api-docs） |

## 快速启动

前置：Node.js ≥ 20、Docker Desktop。

```bash
# 1. 安装依赖（postinstall 会执行 prisma skills sync）
npm install

# 2. 准备环境文件：复制 .env.development 模板（仓库内已有开发配置），按需改 DB_PASS / JWT_SECRET / SMTP 等

# 3. 启动依赖容器（MySQL/Redis/Mailpit/ClamAV/MinIO，变量取自 .env.development）
npm run docker:up

# 4. 同步数据库 schema（开发期 db push；Prisma 7 的连接串由 config/env-loader 从 DB_* 派生）
npm run db:push
npm run db:generate

# 5. 启动应用（watch 模式，http://localhost:3000）
npm run start:dev
```

- API 文档：`http://localhost:3000/api-docs`（cookie 型认证：先调 signIn 建立浏览器会话再测受保护接口，swagger-ui 无法注入 cookie）
- 存储驱动切换：`.env.development` 改 `STORAGE_DRIVER=local|s3`（s3 需 S3_* 四键；进程启动后不可中途切换）
- 邮件联调：`MAIL_DELIVERY=smtp` + Mailpit（网页收件箱 http://localhost:8025），或接真实 SMTP

## 常用脚本

| 脚本 | 作用 |
|---|---|
| `start:dev` | 开发启动（cross-env NODE_ENV=development + watch） |
| `start:prod` | 生产启动（`node dist/src/main`） |
| `docker:up` / `docker:down` | 依赖容器起停（`--env-file .env.development`） |
| `db:push` | schema 差异直接推进库（改 schema 后需 `db:generate` + 重启进程） |
| `db:generate` | 重新生成 Prisma Client |
| `db:migrate` / `db:deploy` | 迁移开发 / 生产迁移（生产化时切换用） |
| `test` / `test:e2e` | 单测 / e2e（NODE_ENV=test） |
| `lint` / `format` | ESLint（--fix）/ Prettier |

## 文档（docs/）

全部按「前置知识 → 本项目具体实现 → 核心代码块 → 面试速答」结构撰写：

**核心链路**
- [token-scheme.md](./docs/token-scheme.md) — 认证：JWT 双 token + cookie + 轮换重用检测
- [file-scheme.md](./docs/file-scheme.md) — 分块上传/断点续传/下载/打包 + 存储双模式
- [reverse-share-scheme.md](./docs/reverse-share-scheme.md) — 反向分享：免登录上传与匿名分享所有权
- [database-scheme.md](./docs/database-scheme.md) — Prisma 7 全景：关系级联、BigInt、db push 工作流
- [oauth-scheme.md](./docs/oauth-scheme.md) — GitHub OAuth + 本地 OIDC

**功能模块**
- [users-scheme.md](./docs/users-scheme.md) — 用户资料与账号软删除（半年冷静期）
- [admin-scheme.md](./docs/admin-scheme.md) — 管理后台：AdminGuard/用户管理/最后管理员保护
- [announcement-scheme.md](./docs/announcement-scheme.md) — 运营公告 + 系统级通知双队列
- [email-scheme.md](./docs/email-scheme.md) — 邮件投递（log/smtp 双模式）
- [antivirus-scheme.md](./docs/antivirus-scheme.md) — ClamAV 扫描与 fail-open 自愈
- [jobs-scheme.md](./docs/jobs-scheme.md) — 八个定时任务与错峰调度

**横切与基础设施**
- [common-scheme.md](./docs/common-scheme.md) — 全局异常整形/限流/安全响应头/bootstrap
- [config-scheme.md](./docs/config-scheme.md) — 应用配置三层取值
- [env-scheme.md](./docs/env-scheme.md) — env 文件体系与 zod 校验
- [i18n-scheme.md](./docs/i18n-scheme.md) — 国际化
- [deployment-scheme.md](./docs/deployment-scheme.md) — 五容器部署/生产 checklist/Docker 实战坑

## 目录速览

```
backend-nest/
├── src/
│   ├── auth/            # 认证（JWT 策略、守卫、会话吊销）
│   ├── users/           # 用户资料 + 账号软删除
│   ├── admin/           # 管理后台（用户/分享/系统级公告）
│   ├── share/           # 分享（controller/service/guards）+ storage/（local|s3 双驱动）
│   ├── announcement/    # 运营公告
│   ├── oauth/           # 第三方登录
│   ├── email/           # 邮件投递
│   ├── antivirus/       # ClamAV 扫描
│   ├── jobs/            # 定时任务（8 个 cron，错峰调度）
│   ├── prisma/          # PrismaService（@Global）
│   ├── config/          # 应用配置三层取值
│   └── app.module.ts    # 模块装配（全局 filter/guard 注册位）
├── common/filters/      # AllExceptionFilter（全局异常整形）
├── config/              # env-loader（zod 校验）、winston.config
├── prisma/              # schema.prisma（13 model + 1 enum）
├── prisma.config.ts     # CLI 连接（复用 env-loader）
├── docker-compose.yml   # 五依赖容器
└── docs/                # 16 篇方案文档
```
