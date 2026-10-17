# ShareLink 项目分析

> 分析日期：2026-10-13　|　版本：`2.0.0-beta.1`
> 基座：Pingvin Share X（smp46 维护的 Pingvin Share fork）→ 本项目在 fork 基础上完成前后端目录重置（`backend-nest/` + `frontend-vue/`）、存储双模式改造、前端整体视觉重构与多项功能增强。

## 1. 项目概述

**ShareLink** 是一个**自托管文件分享平台**（WeTransfer 的开源替代），核心能力：

- 链接分享：文件大小仅受磁盘/对象存储限制
- 分享规则：过期时间、最大访问次数、密码保护、收件人限制
- **反向分享**：生成链接让外部人员向自己上传文件
- 分块上传 + 断点续传，多文件自动打包 zip
- **存储双模式**：本地磁盘 / S3 兼容对象存储（MinIO），配置一行切换
- ClamAV 病毒扫描（流式扫描，不落盘二次读取）
- 多种登录：本地账号 + TOTP 双因素、GitHub OAuth、OIDC
- 运营公告系统、账号软删除（冷静期自助恢复）
- 30+ 界面语言（i18n），缺键自动回退英文

## 2. 仓库结构

```
ShareLink/
├── backend-nest/          # NestJS 后端（API + 文件处理 + 定时任务）
│   ├── src/               # 按模块划分：auth/share/announcement/admin/users/config/...
│   ├── prisma/            # schema + seed + 迁移（MySQL）
│   ├── docs/              # 16 篇模块技术文档（前置知识→实现→核心代码→面试速答）
│   ├── docker-compose.yml # 开发依赖容器（mysql/redis/minio/clamav/mailpit）
│   └── .env.development   # DB_*/JWT/SMTP/S3 等环境变量（env-loader 运行时拼装）
├── frontend-vue/          # Vue 3 前端（Element Plus + Vite）
│   ├── src/pages/         # upload/share/account/admin/auth 四大页面族
│   └── src/i18n/          # 30 语言包（zh-CN/en-US 为维护源）
├── config.yaml            # 运行时配置（优先级最高，仅 7 个锁死键）
├── config.example.yaml    # 最小配置示例
├── aliyun-deploy.md       # 阿里云 ECS 部署全流程
└── docker-compose.yml     # 生产编排（sharelink-prod，与开发环境隔离）
```

## 3. 技术栈

| 层 | 技术 |
|---|---|
| 后端框架 | NestJS 11（Express 5 平台）+ TypeScript 5.8 |
| 数据库 | **MySQL 8** + Prisma 7（`@prisma/adapter-mariadb` 驱动适配器） |
| 会话/缓存 | Redis（ioredis）：RefreshToken 吊销表、Throttler 限流存储 |
| 认证 | Passport JWT（HttpOnly Cookie 双令牌）、argon2、otplib（TOTP） |
| 文件存储 | 双驱动：Local / S3（`@aws-sdk/client-s3` + `lib-storage` 分片上传） |
| 病毒扫描 | clamscan（ClamAV socket，`scanStream` 流式） |
| 邮件 | nodemailer（QQ SMTP 实测） |
| 定时任务 | @nestjs/schedule（Cron，8 任务错峰） |
| 前端框架 | Vue 3.5 `<script setup>` + Vue Router + Pinia |
| UI 组件 | Element Plus（深度定制设计令牌）+ @element-plus/icons-vue |
| 构建 | Vite 7，dev 端口 3001 代理 `/api` → 后端 3000 |
| 国际化 | 自研 i18n（30 语言包扁平键，运行时 en-US 回退） |

## 4. 后端架构（backend-nest）

### 4.1 模块划分

| 模块 | 职责 |
|---|---|
| `auth` | 注册/登录、JWT 双令牌（access 15min + refresh，全部 HttpOnly Cookie）、TOTP、密码重置、会话吊销 |
| `share` | 核心业务：三控制器（share/file/reverse-share）+ 六守卫 + 分块上传协议 + zip 打包 + **存储双模式**（`src/share/storage/`） |
| `announcement` | 运营公告：单控制器双前缀（`/admin/announcements` 管理端 + `/announcements/*` 用户端），已读回执表 |
| `users` | 用户管理 + **账号软删除**（半年冷静期→物理清理） |
| `admin` | 管理面板 API（用户/分享/配置），AdminGuard 继承 JwtAuthGuard 分层 |
| `config` | 三层动态配置（yaml > 数据库 > 默认值），zod 校验 |
| `email` | SMTP 模板邮件（激活/重置/分享投递/下载通知） |
| `antivirus` | ClamAV 流式扫描（完成后异步执行，ERROR 自动重扫任务） |
| `jobs` | 8 个定时任务（过期清理/临时分块回收/软删物理清理/重扫） |
| `prisma` / `i18n` / `app-config` | 基础设施（PrismaModule 全局 + BigInt 序列化纪律） |

### 4.2 分享访问令牌模型（特色设计）

分享密码验证后签发独立 JWT（`share_{id}_token` Cookie），载荷三重绑定：

- `shareId` + `shareCreatedAt` + `sharePasswordSignature`（HMAC-SHA512(argon 哈希)）
- 改密码 → 旧令牌签名全部失配 → 天然全量失效
- 永不过期分享（unix 0 哨兵）签 1h 短令牌 + 验签 `ignoreExpiration`
- 免密续签：持有有效旧令牌直接换新（views+1），无需重复输密码

### 4.3 分块上传协议

```
POST /api/shares                     # 建分享骨架（壳）
POST /api/shares/:id/files           # octet-stream 分块（query: id/name/chunkIndex/totalChunks）
  └─ file id 必须 36 位 UUID；断点续传 = ceil(磁盘字节/chunkSize)
  └─ 期望块不匹配 → 400 { error: "unexpected_chunk_index", expectedChunkIndex }
POST /api/shares/:id/complete        # 返回 202（上游契约），多文件后台 archiver 打 zip
```

**存储双模式不变式**：分块暂存恒在本地磁盘（断点续传协议的唯一事实源），差异收敛在「最后一块转正」之后——`finalizeChunk`（本地 rename / S3 Upload 后删 tmp）与读取（本地 createReadStream / S3 GetObject+Range 透传）。对象键 = 磁盘布局镜像 `{shareId}/{fileId}`。驱动为进程级常量，不做运行时切换。

### 4.4 定时任务（错峰设计）

| Cron | 任务 |
|---|---|
| 00:05 / 00:20 / 00:35 / 00:50 / 01:05 / 01:20 | 过期分享清理、临时分块回收、未激活用户清理、过期令牌清理等 6 项（从原「零点同秒并发」错峰，防连接池挤兑 + 磁盘 IO 风暴） |
| 02:00 | 软删除用户物理清理（先清磁盘文件 → 吊销全部会话 → 删库行） |
| 每小时 :20 | ClamAV ERROR 状态分享重扫 |

### 4.5 安全防线

- 全局 ThrottlerGuard（Redis 存储）+ 12 处按端点分档的 @Throttle
- JWT **只认 Cookie**（fromExtractors 仅 cookie，Bearer 恒 401）
- 下载三防线：`nosniff` + RFC5987 文件名 + 非被动媒体 CSP sandbox；Range 206/416 断点续传
- AllExceptionFilter 对象响应整体展开 `{statusCode, ...obj}`——断点续传协议的根基
- 匿名分享删除二次拦截（防恶意清空收集），最后一个管理员保护

## 5. 数据模型（Prisma + MySQL）

```
User ──< Share ──< File              # 分享下的文件
 │        │  ──< ShareRecipient      # 邮件收件人
 │        │  ──< ShareUserRecipient  # 站内用户收件人（"收到的分享"）
 │        │  ─── ShareSecurity       # 密码(argon)/最大访问次数/限定收件人
 │        └──> ReverseShare          # 反向分享令牌
 ├──< RefreshToken / LoginToken / ResetPasswordToken
 ├──< AnnouncementRead               # 公告已读（@@unique([announcementId, readByUserId])）
 ├──< OAuthUser                      # GitHub / OIDC 绑定
 └─ 软删除字段：deletedAt / pendingRestore（用户名/邮箱唯一键暂存）
```

要点：BigInt 主键序列化纪律（全局拦截器转 string）；`Share.creator` onDelete:SetNull（匿名分享壳保留）；NEVER_EXPIRES 以 unix 0 为哨兵值；唯一键即业务规则（软删时暂存到 pendingRestore 释放用户名/邮箱）。

## 6. 前端架构（frontend-vue）

### 6.1 页面族

| 路由 | 说明 |
|---|---|
| `/` | 深空风落地页（极光流光 + 纸飞机飞越动画，常驻深色不随主题翻转） |
| `/upload` | 上传页（核心）：Dropzone + FileList + 创建/完成弹窗 |
| `/s/:shareId` → `/share/:shareId` | 分享落地（短链重定向）→ 文件列表/下载 |
| `/account/*` | 我的账号 / 我的分享 / 收到的 / 反向分享 |
| `/admin/*` | 管理面板：用户 / 分享 / 配置（tabs）/ 运营公告 |
| `/auth/*` | 登录 / 注册 / TOTP / 邮箱验证 / 密码重置（AuthShell 统一收口） |

### 6.2 设计令牌体系（视觉重构后）

- `styles/tokens.css`：`--app-*` 语义变量（bg/text/border/brand #5E6AD2/radius/shadow）+ Element Plus `--el-*` 全量映射 + 靛蓝 tint 亮暗两套预计算
- 加载顺序：EP index.css → EP dark → tokens.css → global.css；暗色用 `:root.dark` 压过 EP `html.dark`
- 布局：登录后通顶侧栏（232px，sticky）+ 56px 毛玻璃顶栏 + 1120px 内容列；未登录单栏（plain-shell）
- 全局工具类：`.page-header/.page-toolbar/.page-stack/.list-row/.search-input`

### 6.3 关键实现

- **useUpload 签名纪律**：接收 `Ref<FileUpload[]>` 与 getter（曾因数组快照失效导致「我的分享」静默空白）
- **nanoid 生成器**：对齐官方 64 字符表（曾因缺 `-`/`_` 导致 22% 脏 ID）
- 公告弹窗：双队列合并（系统级 + 运营公告）、`Promise.allSettled` 批量已读
- 配置页 ConfigValueInput：filesize/timespan 带单位下拉 + 自定义输入

## 7. 配置体系

优先级：**config.yaml（锁死） > 数据库（管理后台 UI） > 代码默认值**

yaml 仅保留 7 个运维级键：`appUrl`、`allowUnauthenticatedShares`、`allowAdminAccessAllShares`、`chunkSize`、`antivirus.enabled`、`smtp.enabled`、`oauth.openProviders`——被 yaml 覆盖的键在 UI 中标记「已锁定」且 PATCH 400；其余全部可视化编辑。

环境变量（`.env.development`）走 env-loader 运行时拼装（`DB_*` → DATABASE_URL）；`STORAGE_DRIVER=local|s3` + `S3_*` 六键由 zod superRefine 条件必填。

## 8. 部署与运行

### 8.1 开发（当前主模式）

```bash
cd backend-nest && docker compose up -d mysql redis minio   # 依赖容器
npx prisma db push && npm run start:dev                     # 后端 :3000
cd frontend-vue && npm run dev                              # 前端 :3001（/api 代理）
```

### 8.2 验证基线

- 存储双模式 E2E：s3 模式 16 项（上传→转正→扫描→zip→Range 206→mc 核对→级联清理全绿）；local 模式 12 项（含 3 块 26MB 多块协议回归）
- vue-tsc 存量错误清单固定，零新增为合并门槛

### 8.3 S3 触发点（决策留档）

多实例部署 / 出口带宽成瓶颈 / 容器弹性伸缩时，推进 presigned 直传三端点改造；前端 upload-init 404 降级兜底已存在，迁移成本极低。

## 9. 相对上游的主要增强

1. **前端整体视觉重构**：设计令牌体系（品牌靛蓝 #5E6AD2）、通顶侧栏工作台、毛玻璃顶栏、深空风首页、SVG 矢量 Logo
2. **存储双模式**：`StorageBackend` 接口抽象 local/S3，分块暂存协议不变，一行配置切换（上游仅 S3 service 单点）
3. **运营公告系统**：Announcement + 已读回执，管理端发布/全员弹窗
4. **账号软删除**：半年冷静期 + 自助恢复（占名方案）+ 物理清理任务链（磁盘/会话/库行三步序）
5. **配置中心瘦身**：yaml 锁死键从全量收敛到 7 个，其余下放 UI；filesize/timespan 带单位控件
6. **定时任务错峰**：8 任务按 15 分钟间隔打散，消除零点并发风暴
7. **目录重置**：backend-nest + frontend-vue（上游后端框架同源，前端 Next.js → Vue 3 整体重写）

## 10. 架构小结

```
浏览器 ──► Vue 3 前端(:3001, Vite dev 代理 /api)
               │
               ▼
          NestJS 后端(:3000)
               │
   ┌───────────┼────────────┬──────────────┐
   ▼           ▼            ▼              ▼
 MySQL 8   本地磁盘 / S3   Redis        ClamAV(容器)
 (Prisma7) (双驱动镜像键)  (令牌/限流)   (流式扫描)
               │
               └── SMTP(QQ 邮箱) / 定时任务 8 项错峰
```

**设计特点**：

- 存储差异收敛于接口之后，业务代码对驱动零感知；分块暂存协议与断点续传完全解耦于存储后端
- 安全分层清晰：认证（JWT Cookie）→ 授权（Owner/Admin Guard）→ 访问控制（分享令牌签名绑定）→ 传输防线（CSP/nosniff/Range）
- 配置三层各司其职：运维锁死 / 管理员即改即生效 / 代码兜底
- 前后端契约稳定：202 complete、unexpected_chunk_index、对象响应展开等上游协议全量保留，保证升级兼容
