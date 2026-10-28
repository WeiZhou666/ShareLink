# ShareLink 后端生产镜像（NestJS + Prisma 7 / MySQL）
# 构建：docker build -t sharelink-backend ./backend-nest
# 运行时依赖外部注入 env（DB_*/REDIS_*/JWT_SECRET...），容器内不含 .env 文件——
# dotenv 找不到 .env.production 时静默跳过，全部变量由 compose environment 提供
# 启动：entrypoint 先 prisma db push 同步 schema（幂等，无漂移时 no-op）再 node dist/src/main

# ---------- 阶段 1：全量依赖（含 devDependencies，prisma generate/nest build 需要） ----------
FROM node:24-alpine AS deps
# argon2 为原生模块，alpine(musl) 需要编译链兜底（官方有 prebuilt 时跳过）
RUN apk add --no-cache python3 make g++
WORKDIR /opt/app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- 阶段 2：构建（产物 dist/：dist/src/main + dist/config/env-loader 同源编译） ----------
FROM deps AS builder
WORKDIR /opt/app
COPY . .
# 构建期占位 env：nest build 模块加载即触发 env-loader 的 zod 校验，而 .dockerignore
# 有意排除所有 .env*（密钥不进镜像层）——构建上下文里没有任何 env 文件，校验必炸。
# 用假值骗过校验让编译通过；运行时 compose env_file（根 .env）提供真值，其优先级
# 高于镜像 ENV，占位值在容器里不会生效。⚠️ 改占位值会使服务器构建缓存失效，勿随意动
ENV JWT_SECRET=build-placeholder DB_HOST=localhost DB_PORT=3306 DB_USER=build DB_PASS=build DB_NAME=build REDIS_HOST=localhost REDIS_PORT=6379
RUN npx prisma generate && npm run build

# ---------- 阶段 3：生产依赖（runtime deps + prisma CLI，镜像瘦身） ----------
FROM node:24-alpine AS prod-deps
RUN apk add --no-cache python3 make g++
WORKDIR /opt/app
COPY package.json package-lock.json ./
# prisma CLI 在 devDependencies，但 entrypoint 的 db push 需要它：
# 单独补装并锁版本（与 @prisma/client 7.10 对齐），--no-save 不污染 lockfile
RUN npm ci --omit=dev && npm i --no-save prisma@7.10.0 && npm cache clean --force

# ---------- 阶段 4：运行镜像 ----------
FROM node:24-alpine AS runner
ENV NODE_ENV=production
# Prisma db push / generate 运行需要 openssl（Prisma 7 engine 依赖）
RUN apk add --no-cache openssl curl tini \
  && addgroup -S app && adduser -S app -G app

WORKDIR /opt/app
# dist/（含 src 与 config 编译产物）、prisma/（schema，db push 用）、node_modules、package.json
COPY --from=builder /opt/app/dist ./dist
COPY --from=builder /opt/app/prisma ./prisma
COPY --from=prod-deps /opt/app/node_modules ./node_modules
# Prisma client generate 产物：prod-deps 阶段 npm ci --omit=dev 时尚无 schema、
# postinstall generate 被跳过，运行期 @prisma/client stub require('.prisma/client/default')
# 会 MODULE_NOT_FOUND（2026-10-21 阿里云部署实测）——从 builder（完整 generate 过）拷产物。
# 两侧 @prisma/client 同 lockfile 同版本，产物直接兼容
COPY --from=builder /opt/app/node_modules/.prisma ./node_modules/.prisma
COPY --from=prod-deps /opt/app/package.json ./package.json
# prisma CLI 配置：Prisma 7 的 db push 必须有 config 文件提供 datasource.url，
# 但 tsc 编译产物 prisma.config.js（CJS）在精简 prod 依赖树下会被 CLI 的 jiti 加载器
# 解析失败（"Failed to parse syntax of config file"，2026-10-21 阿里云部署实测，
# 本地完整依赖树却正常）——改用 ESM 原生源文件：CLI 对 .mjs 无转换直接加载，
# 数据库 URL 从 compose 注入的 DB_* 环境变量拼装（见 prisma.config.mjs）
COPY prisma.config.mjs ./prisma.config.mjs

# 预建运行时可写目录：logs（winston 轮转日志，compose 挂 backend_logs 卷）与
# backend/data（DATA_DIRECTORY 上传目录，compose 挂 backend_data 卷）。
# 这些路径是 named volume 挂载点——若镜像内不存在，Docker 首次挂卷会以 root 属主
# 创建挂载点，app 用户写入即 EACCES 崩溃（2026-10-21 阿里云部署实测：日志目录炸）。
# 镜像内预建 + chown 后，新空卷初始化会继承镜像目录属主；已存在的旧卷需服务器侧
# docker compose run --user root chown 一次性修复
RUN mkdir -p /opt/app/logs /opt/app/backend/data /opt/app/data && chown -R app:app /opt/app
USER app

EXPOSE 3000
# GET /api 为应用探活端点（AppController.getHello）
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fs http://localhost:3000/api || exit 1

# tini 作 PID 1：正确转发信号，enableShutdownHooks 才能在 stop 时触发 Prisma 断连
ENTRYPOINT ["/sbin/tini", "--"]
# 先同步数据库 schema（项目无 migrations 目录，db push 即部署迁移），再启动应用。
# 注意不能带 --skip-generate：Prisma 7 已移除该选项（v7 CLI 不再自动 generate），
# 传了会直接报 unknown option 退出（2026-10-21 阿里云部署实测踩坑）
CMD ["sh", "-c", "npx prisma db push && node dist/src/main"]
