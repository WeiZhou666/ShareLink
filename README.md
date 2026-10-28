# ShareLink

基于 [Pingvin Share X](https://github.com/smp46/pingvin-share-x)（[Pingvin Share](https://github.com/stonith404/pingvin-share) 的 fork）二次开发的自托管文件分享平台——上传文件、生成链接、设置有效期与访问规则，数据全程留在自己的服务器上。

## 核心特性

- 链接分享：拖入文件即刻生成分享链接
- 分享规则自定义：有效期、最大访问次数、密码保护
- 反向分享：他人通过固定链接向你投递文件
- 分块上传 + 断点续传，文件大小只受磁盘限制
- S3 预签名直传：分块经预签名 URL 直达对象存储，文件字节不过后端（local 驱动自动回退代理分块）
- ClamAV 病毒扫描集成
- 存储双模式：本地磁盘 / S3 兼容对象存储（MinIO），一行配置切换
- 多文件分享自动打包 zip 下载
- 邮件通知（激活、重置密码、分享投递）
- 30+ 界面语言（i18n），含简体中文

## 技术栈

| 端 | 技术 |
|---|---|
| 后端 | NestJS 11 + Prisma 7 + MySQL + Redis（会话/限流）+ BullMQ 定时任务 |
| 前端 | Vue 3 + TypeScript + Element Plus + Vite |
| 存储 | 本地磁盘 / S3（STORAGE_DRIVER 切换，分块暂存恒在本地） |
| 安全 | Argon2 密码哈希、JWT 双令牌、TOTP 两步验证、ClamAV 流式扫描 |

## 目录结构

```
ShareLink/
├── backend-nest/        # 后端（NestJS）
│   ├── src/             # 源码（share/announcement/admin/users/... 模块化）
│   └── docker-compose.yml  # 开发依赖容器（mysql/redis/minio/clamav/mailpit）
├── frontend-vue/        # 前端（Vue 3）
├── config.yaml          # 运行时配置（优先级最高，覆盖数据库与代码默认值，不入库）
├── config.example.yaml  # 配置示例（最小必填集）
└── docker-compose.yml   # 生产编排（sharelink-prod，与开发环境隔离）
```

## 快速开始（开发环境）

### 0. 准备

- Node.js 20+、Docker Desktop
- 复制 `config.example.yaml` 为 `config.yaml`，按需修改
- 复制 `backend-nest/.env.example` 为 `backend-nest/.env.development`，填入数据库连接、SMTP、S3 凭据等

### 1. 启动依赖容器

```bash
cd backend-nest
docker compose up -d mysql redis   # MinIO/ClamAV 按需追加服务名
```

### 2. 启动后端（端口 3000）

```bash
cd backend-nest
npm install
npx prisma db push        # 建表
npm run start:dev
```

### 3. 启动前端（端口 3001）

```bash
cd frontend-vue
npm install
npm run dev
```

访问 http://localhost:3001，注册账号即可使用。首个用户默认不是管理员，需在数据库中将该用户 `isAdmin` 置为 `true`，即可解锁管理后台。

> 根目录提供了聚合脚本：`npm run install:all` 一次装两端依赖，`npm run dev` 并行启动前后端。

## 生产部署（Docker Compose）

前后端各自镜像化：后端多阶段构建（NestJS 编译产物 + 生产依赖，entrypoint 自动 `prisma db push` 同步 schema）；前端 Vite 产物由 Nginx 托管并反代 `/api`（与开发期 Vite 代理同拓扑，axios 相对路径零改动）。

```bash
cp .env.production.example .env   # 必改：JWT_SECRET / COOKIE_SECURE / CORS_ORIGIN / DB_PASS
docker compose up -d --build
# 访问 http://localhost:${WEB_PORT:-80}
```

要点：

- `.env` 同时供 compose 变量替换（MySQL/MinIO 凭证）与 backend 容器 env（zod 启动校验，弱密钥/缺 CORS 白名单直接拒绝启动）
- 服务名映射由 compose 注入：容器内 `DB_HOST=mysql`、`REDIS_HOST=redis`、`CLAMAV_HOST=clamav`、`S3_ENDPOINT=http://minio:9000`
- 换云厂商 S3：删 minio 服务，`STORAGE_DRIVER=s3` + S3 凭证即可；启用直传另需 `S3_PUBLIC_ENDPOINT`（浏览器可达地址，容器内网 `S3_ENDPOINT` 签出的 Host 浏览器访问不到）
- 可选挂载 `config.yaml` 锁死应用级配置（compose 内已注释示例）
- 项目名 `sharelink-prod` 与开发环境（`sharelink`）容器/卷完全隔离，可同机共存

## 常用脚本

| 命令（根目录） | 作用 |
|---|---|
| `npm run install:all` | 安装前后端全部依赖 |
| `npm run dev` | 并行启动后端 + 前端 |
| `npm run build` | 构建前后端产物 |
| `npm run lint` / `npm run format` | 两端统一 ESLint 检查 / Prettier 格式化 |

## 与上游的主要差异

- 前端整体视觉重构：通顶侧栏工作台、毛玻璃顶栏、品牌靛蓝（#5E6AD2）设计令牌体系、深空风首页
- 存储双模式落地（local / S3 可切换，分块暂存协议不变），S3 另支持预签名分块直传
- 运营公告系统（Announcement + 已读回执），弹窗内置「支持作者」收款码小节 + 侧栏入口（投放 `public/img/wechat-donate.png` 即生效，缺图自动隐藏）
- 账号注销（软删除 + 半年冷静期自助恢复 + 物理清理任务链）
- 配置中心瘦身：config.yaml 仅保留 7 个锁死键，其余全部下放管理后台 UI 可视化编辑

## License

基于上游 [Pingvin Share](https://github.com/stonith404/pingvin-share)（MIT License）二次开发，遵循原协议保留版权声明，详见 [LICENSE](LICENSE)。
