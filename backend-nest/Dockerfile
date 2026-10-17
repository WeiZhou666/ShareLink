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
COPY --from=prod-deps /opt/app/package.json ./package.json
# prisma CLI 配置发现：CLI 在 cwd 找 prisma.config.js，其内部 import './config/env-loader'
# （编译产物的相对引用）——必须按同样相对布局补齐，否则模块断链
COPY --from=builder /opt/app/dist/prisma.config.js ./prisma.config.js
COPY --from=builder /opt/app/dist/config/env-loader.js ./config/env-loader.js

RUN mkdir -p /opt/app/data && chown -R app:app /opt/app
USER app

EXPOSE 3000
# GET /api 为应用探活端点（AppController.getHello）
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fs http://localhost:3000/api || exit 1

# tini 作 PID 1：正确转发信号，enableShutdownHooks 才能在 stop 时触发 Prisma 断连
ENTRYPOINT ["/sbin/tini", "--"]
# 先同步数据库 schema（项目无 migrations 目录，db push 即部署迁移），再启动应用
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/src/main"]
