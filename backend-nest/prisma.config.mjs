// 生产镜像专用 Prisma 配置（ESM 原生版）。
// 背景：tsc 编译出的 prisma.config.js 是 CJS，Prisma CLI（jiti 加载器）在运行镜像里
// 解析它失败（"Failed to parse syntax of config file"）——本地完整依赖树下却正常，
// 属于 prod-deps 精简树里加载链的兼容问题（2026-10-21 阿里云部署实测）。
// 用 ESM 源文件替代：CLI 对 .mjs 原生加载无转换，不再依赖 jiti。
// 数据库 URL 直接从 compose 注入的 DB_* 环境变量拼装（容器内服务名 mysql），
// 不 import 应用的 env-loader（那是给 main 进程用的，两者互不影响）。
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: `mysql://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  },
});
