import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

// 开发期通过 Vite 代理把 /api 转发到 NestJS 后端（对齐原 Next.js 的 pages/api 代理）。
// 生产环境由 Caddy/nginx 托管 dist/ 并反代 /api（与原部署拓扑一致）。
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 3001,
    proxy: {
      "/api": {
        // 默认指向 backend-nest 开发端口 3000；注意 process.env 不会从 .env 文件加载，
        // API_URL 只能来自启动 vite 的 shell 环境（未设置时必须回落到 3000，否则代理打空）
        target: process.env.API_URL || "http://localhost:3000",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
