# ShareLink 前端生产镜像：Vite 构建产物交 Nginx 托管
# 职责：静态资源 + SPA fallback + /api 反代到后端容器（与 dev 期 Vite 代理同一拓扑）

# ---------- 阶段 1：构建 ----------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 产物为纯静态文件（axios baseURL="/api" 相对路径，同源反代零配置）
RUN npm run build

# ---------- 阶段 2：Nginx 运行镜像 ----------
# 官方镜像内置 envsubst 机制：/etc/nginx/templates/*.template 中的 ${BACKEND_HOST}
# 由容器环境变量替换后生成 conf.d/default.conf
FROM nginx:alpine
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
