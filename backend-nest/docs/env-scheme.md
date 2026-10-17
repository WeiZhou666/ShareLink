# 环境文件方案（.env 体系 + env-loader 加载链路）

核心机制在 [config/env-loader.ts](../config/env-loader.ts)：**main.ts 的第一个 import**（[main.ts](../src/main.ts) L1-2），
在任何业务代码（winston 工厂读 LOG_LEVEL、AppModule 定义）求值前把 env 文件灌进 `process.env`。
本文件同时是 compose 容器编排的变量来源——一份文件两个消费方（见 §3）。

## 前置知识：配置为什么不能写死在代码里

### 1. 同一份代码，不同环境

开发/测试/生产的差异本质只是"配置不同"：数据库地址、密钥、日志级别、功能开关。12-Factor App 第三条（Config）：**配置存储在环境中，与代码严格分离**——目标是"一份构建产物 + 不同环境配置 = 部署到任何环境"，改配置不改代码、不重新构建。

### 2. 配置写死在代码里的三种后果

- 密钥进 git = **永久泄漏**（git 历史抹不掉，等于要轮换所有密钥）
- 换环境要改代码重新构建，违反"构建一次、处处部署"
- 本地值/生产值互相覆盖，优先级混乱出事故

### 3. .env 文件：本地开发的行业惯例

dotenv 约定：`KEY=VALUE` 行格式文件，进程启动时读进 `process.env`。它**不进 git**（里面全是真实密钥），所以总是配对出现——`.env.example`（脱敏模板，进 git，新环境照着抄）+ `.env`（真实值，.gitignore）。生产更进一步用 secret manager（Vault / 云 KMS / 平台注入），连文件都不落。

### 4. 配置注入的两个时机

- **启动时读一次**（env 层）：immutable，改了要重启——适合基础设施连接信息（DB/Redis/密钥）
- **运行时每次读**（DB/yaml 层）：可热更，admin 改完即生效——适合业务开关

本项目两级都有、分工明确（§5），混放是常见反模式（业务开关写 env = 改开关要重启；密钥写 yaml 随 git 走 = 泄漏）。

### 5. 术语速查

| 术语 | 一句话解释 |
|---|---|
| process.env | Node 进程运行时环境变量表 |
| NODE_ENV | 环境标识（development / test / production） |
| 12-Factor | 云原生应用十二要素方法论，配置分离是第三条 |
| secret manager | 密钥托管服务（Vault / KMS / 云平台注入） |
| immutable config | 启动时注入、进程生命周期内不可变 |

## 1. 文件清单与选择规则

| 文件 | git | 作用 |
|---|---|---|
| `.env.development` | 忽略 | 开发环境实际配置（含真实密钥） |
| `.env.test` | 忽略 | jest 测试（`test`/`test:e2e` 脚本注入 NODE_ENV=test） |
| `.env.production` | 忽略 | 生产部署（`start:prod` 注入 NODE_ENV=production，**部署前需先建此文件**） |
| `.env.example` | **入库**（.gitignore `!.env.example` 例外） | 全键位模板 + 注释，新环境从它复制 |

选择规则：`ENV_FILE_MAP[NODE_ENV]`，NODE_ENV 缺失或未知一律回退 `.env.development`。
NODE_ENV **不在 env 文件里**——由 package.json 脚本经 cross-env 注入（dev/test/e2e/prod 各自固定）。

## 2. 加载链路（env-loader.ts）

```
import '../config/env-loader'   ← main.ts 第一行 import（模块求值即执行 loadAppEnv()）
  ├─ dotenv.config({ path: getEnvFilePath() })     resolve(cwd, .env.<NODE_ENV>)
  └─ process.env.DATABASE_URL ??= buildDatabaseUrl()   由 DB_* 五键拼装 mysql:// 连接串
ConfigModule.forRoot({ envFilePath: getEnvFilePath() })   ← app.module.ts 复用同一函数，二次加载幂等
  └─ PrismaService：new PrismaMariaDb(process.env.DATABASE_URL)   ← adapter 模式消费
```

- **dotenv 不覆盖已存在的 process.env**：多次加载安全；系统级环境变量优先于文件值
- **DATABASE_URL 是运行时派生键**，env 文件里没有、也不该有（避免同一连接串维护两份）；
  `buildDatabaseUrl` 对 user/password 做 `encodeURIComponent`（密码含 `@#?` 等特殊字符安全）
- **cwd 相对解析坑**：`getEnvFilePath` 用 `process.cwd()`——必须在 `backend-nest` 目录下启动
  （`npm run start:dev` 在仓库根目录跑会静默找不到 env 文件，全部键走代码默认值）；
  tsx 临时脚本同理，用 `path.join(__dirname, '.env.development')` 防 cwd 漂移
- **启动期校验（zod，2026-10-10 加入）**：`validateEnv()` 在 dotenv 加载后立即跑 schema——
  必需键缺失/格式错/数值非法 → 打印逐键清单后 `process.exit(1)`（fail-fast，先于 winston/Nest 起动）。
  附加规则：生产环境拒绝模板默认 JWT_SECRET、要求 COOKIE_SECURE=true 与 CORS_ORIGIN 白名单；
  MAIL_DELIVERY=smtp 时 SMTP 五键条件必填。校验通过导出类型安全快照
  `import { env } from '../../config/env-loader'`（数值键已转 number；存量代码仍可直读 process.env 渐进迁移）。
  设计上**校验不注入默认值**——各消费点现有 `?? 默认` 行为不变，schema 只拦截危险/矛盾配置

## 3. 一份文件、两个消费方（应用进程 + docker compose）

```bash
docker compose --env-file .env.development up -d
```

compose 消费的是同一份 .env.development 的变量插值（`docker-compose.yml`）：

| 插值点 | 键 | 说明 |
|---|---|---|
| mysql 端口映射 | `${DB_PORT:-3306}:3306` | 宿主机用 3307 避开本机 MySQL90（容器内仍是 3306） |
| mysql 初始化 | `MYSQL_ROOT_PASSWORD: ${DB_PASS}`、`MYSQL_DATABASE: ${DB_NAME}` | 容器首次启动建库，与应用 DB_* 天然一致 |
| mysql healthcheck | `-p${DB_PASS}` | |
| redis 端口映射 | `${REDIS_PORT:-6379}:6379` | |
| clamav 端口映射 | `${CLAMAV_PORT:-3310}:3310` | 宿主机跑后端时 CLAMAV_HOST=localhost 直连此映射 |

坑：mailpit 镜像 pull 依赖 docker 凭据助手 PATH，可能失败——本地只需 `up -d mysql redis clamav`。
另外 `backend/prisma/.env` 是**旧后端遗留**，与本项目无关。

## 4. 键目录（按消费方分组）

标注 🔑 的键是敏感值（真实值只存在于被 git 忽略的 env 文件里，本文档一律不落）。

**进程基础**

| 键 | 默认 | 消费方 |
|---|---|---|
| PORT | 3000 | main.ts `app.listen` |
| LOG_LEVEL | debug | winston.config 工厂（error 恒记录不受影响；级别语义见 .env.example 尾部表） |
| NODE_ENV | （脚本注入） | env-loader 选文件，非业务键 |

**认证 / 会话**

| 键 | 默认 | 消费方 |
|---|---|---|
| JWT_SECRET 🔑 | `manage_jwt_secret_key`（弱默认，代码内多处 fallback） | auth.module JwtModule、jwt.strategy、share.module/share.service（分享令牌 + 密码签名 HMAC-SHA512 共用此密钥）——**生产必须换强随机值** |
| COOKIE_SECURE | false | auth.service 双 cookie `secure` 标志（生产 HTTPS 必须 true） |
| CORS_ORIGIN | 未设置=放行所有来源（仅开发） | main.ts enableCors（逗号分隔白名单，credentials: true） |

**数据库 / Redis**

| 键 | 默认 | 消费方 |
|---|---|---|
| DB_HOST / DB_PORT / DB_USER / DB_PASS 🔑 / DB_NAME | localhost / 3306 / root / 空 / 空 | env-loader 拼 DATABASE_URL；compose 容器初始化。**键名是 DB_PASS 不是 DB_PASSWORD**（tsx 直连脚本常踩） |
| REDIS_HOST / REDIS_PORT / REDIS_PASSWORD 🔑 | 127.0.0.1 / 6379 / 无 | redis.service（ioredis；吊销令牌黑名单） |

**邮件投递**

| 键 | 默认 | 消费方 |
|---|---|---|
| MAIL_DELIVERY | log（日志投递，零配置） | email.service：`smtp` 才建真实 SMTP transport |
| SMTP_HOST / SMTP_PORT / SMTP_SECURE 🔑 | — / 1025 / false | email.service（465 隐式 TLS 设 true；587 STARTTLS 设 false） |
| SMTP_USER / SMTP_PASS 🔑 | 无 | nodemailer auth（QQ 邮箱用授权码非密码） |
| SMTP_FROM | 无 | 发件头（QQ 要求与认证账号一致否则拒信） |

**链接拼装（两套 URL，别混用）**

| 键 | 默认 | 消费方 |
|---|---|---|
| FRONTEND_URL | http://localhost:3001 | 重置密码链接、分享链接、反向上传链接（oauth.controller / share.service / reverse-share.controller；统一去尾斜杠） |
| APP_URL | http://localhost:3000 | OAuth 回调 `{APP_URL}/api/oauth/{provider}/callback`（须与 IdP 后台登记一致） |

**OAuth**

| 键 | 默认 | 消费方 |
|---|---|---|
| OAUTH_GITHUB_CLIENT_ID / CLIENT_SECRET 🔑 | 空 | github.provider（不设 AUTH_BASE/API_BASE 回落官方域名；本地回归可指 mock :9099） |
| OAUTH_GITHUB_AUTH_BASE / API_BASE | github.com / api.github.com | 同上 |
| OAUTH_LOCAL_ISSUER / CLIENT_ID / CLIENT_SECRET 🔑 | :9099 / local-client / local-secret | local-oidc.provider（scripts/mock-oidp.mjs 默认值即此） |

**存储 / 扫描 / 配置文件**

| 键 | 默认 | 消费方 |
|---|---|---|
| DATA_DIRECTORY | `./data` | share.constants（分享文件磁盘根；可选键，.env.example 注释态收录） |
| CLAMAV_HOST / CLAMAV_PORT | `clamav` / 3310 | clamav.service（开发 localhost:3310 走 compose 端口映射） |
| CONFIG_FILE | `../config.yaml` | config.service（应用配置文件路径，可选） |

**已清理的死键**：`CLEANUP_CRON`、`ORDER_TIMEOUT_MINUTES`——src 下无任何 process.env 读取
（旧后端遗留），2026-10-11 已从全部 env 文件移除；今后若需要同类键先在代码里接上消费方再进模板

## 5. 与应用配置体系（config.yaml / DB）的关系——两套平行体系

- **env 键**：进程级/基础设施级（连什么库、监听什么端口、SMTP 凭据），只被 `process.env.*` 直接读，改完须重启
- **应用配置**（AppConfigService）：业务开关（如 `antivirus.enabled`、`security.enableEmailVerification`），
  存 DB 可 admin 后台改，config.yaml 可覆盖，代码默认兜底——**改 config.yaml 无需重启**（视实现）
- **迁移模式**：业务开关从 env 迁出（先例：`ENABLE_EMAIL_VERIFICATION` → `security.enableEmailVerification`，
  env 文件里留注释指向新键）；基础设施连接类键没有迁移动机，留在 env

## 6. 安全清单

- `.gitignore`：`.env` + `.env.*` 全忽略，仅 `!.env.example` 入库——**新键必须同步进 .env.example**（注释写清默认值与消费方）
- 🔑 键泄露处置：SMTP 授权码在邮箱后台作废；OAuth secret 在 IdP 后台重置；JWT_SECRET 轮换会使全部会话失效（含分享访问令牌——同一密钥签名）
- 生产 `.env.production` 部署前必查：JWT_SECRET 换强随机、COOKIE_SECURE=true、CORS_ORIGIN 收紧、MAIL_DELIVERY=smtp、DB_* 指向生产实例
