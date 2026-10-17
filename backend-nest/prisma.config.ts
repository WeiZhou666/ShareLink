import { defineConfig } from 'prisma/config';
// Prisma 7 起 CLI 不再自动加载 .env：这里复用应用的 env-loader，按 NODE_ENV 加载对应环境文件
import './config/env-loader';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  // 迁移 / 内省等命令需要的数据库连接，取自 env-loader 派生的 DATABASE_URL
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
