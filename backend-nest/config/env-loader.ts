import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { z } from 'zod';

// 环境文件映射：NODE_ENV 决定加载哪个 env 文件，未设置或未知时回退 development
const ENV_FILE_MAP: Record<string, string> = {
  development: '.env.development',
  test: '.env.test',
  production: '.env.production',
};

// 获取当前环境对应的 env 文件绝对路径（ConfigModule 的 envFilePath 也复用它）
export function getEnvFilePath(): string {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  return resolve(process.cwd(), ENV_FILE_MAP[nodeEnv] ?? ENV_FILE_MAP.development);
}

// 由 DB_* 变量拼装 MySQL 连接串（特殊字符做 URL 编码），避免 env 文件里重复维护一份 DATABASE_URL
export function buildDatabaseUrl(): string {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME } = process.env;
  return `mysql://${encodeURIComponent(DB_USER ?? 'root')}:${encodeURIComponent(DB_PASS ?? '')}@${DB_HOST ?? 'localhost'}:${DB_PORT ?? '3306'}/${DB_NAME ?? ''}`;
}

/**
 * env 校验 schema（zod）：启动期 fail-fast，杜绝"键打错/漏配 → 静默走默认值带病运行"
 *
 * 设计原则：
 * - 校验，不注入默认值——各消费点现有的 `?? 默认` 行为保持不变，schema 只拦截危险/矛盾的配置
 * - dotenv 产物全是字符串：数值键用 z.coerce.number() 顺带校验"是合法正整数"
 * - 生产附加规则与条件必填见下方 superRefine
 */
const envSchema = z.object({
  // ---- 进程基础 ----
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  PORT: z.coerce.number().int().positive().optional(),
  LOG_LEVEL: z
    .enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'])
    .optional(),

  // ---- 认证 / 会话 ----
  // 会话令牌与分享访问令牌共用此密钥（HMAC-SHA512 密码签名），漏配等于全线裸奔——必填
  JWT_SECRET: z.string().min(16, 'JWT_SECRET 过短（<16 字符），请用强随机值'),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  CORS_ORIGIN: z.string().optional(),

  // ---- 数据库（DATABASE_URL 由这五键派生，缺一 Prisma 必挂——启动期拦下比运行时报错清晰）----
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive(),
  DB_USER: z.string().min(1),
  DB_PASS: z.string(),
  DB_NAME: z.string().min(1),

  // ---- Redis ----
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  REDIS_PASSWORD: z.string().optional(),

  // ---- 邮件（MAIL_DELIVERY=smtp 时投递五键条件必填，见 superRefine）----
  MAIL_DELIVERY: z.enum(['log', 'smtp']).optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: z.enum(['true', 'false']).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  // ---- 链接拼装（FRONTEND_URL=面向用户页面；APP_URL=OAuth 回调基址）----
  FRONTEND_URL: z.string().optional(),
  APP_URL: z.string().optional(),

  // ---- OAuth（GitHub / 本地 OIDC，不配则对应登录方式不可用，不拦启动）----
  OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
  OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
  OAUTH_LOCAL_ISSUER: z.string().optional(),
  OAUTH_LOCAL_CLIENT_ID: z.string().optional(),
  OAUTH_LOCAL_CLIENT_SECRET: z.string().optional(),

  // ---- 存储 / 扫描 ----
  DATA_DIRECTORY: z.string().optional(),
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().positive().optional(),

  // ---- 文件存储驱动（local=本地磁盘；s3=任意 S3 兼容服务，凭据五键条件必填见 superRefine）----
  STORAGE_DRIVER: z.enum(['local', 's3']).optional(),
  S3_ENDPOINT: z.string().optional(), // 如 MinIO http://localhost:9000
  S3_REGION: z.string().optional(), // 缺省 us-east-1
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional(), // MinIO/自建网关必须 true
  // 预签名直传专用：签名绑定 Host——浏览器直连的 URL 必须签在「浏览器可达」的端点上。
  // 生产里 S3_ENDPOINT 可能是容器内网名（如 http://minio:9000），此时配 S3_PUBLIC_ENDPOINT 出签名
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_DIRECT_URL_EXPIRES: z.coerce.number().int().positive().optional(), // 预签名有效期秒数，默认 86400
});

/**
 * 校验 process.env：失败打印逐键清单后退出（本模块先于 winston 加载，只能用 console）。
 * - 生产附加规则：弱密钥 / 非 HTTPS cookie / 无跨域白名单 → 拒绝启动（弱配置宁可起不来，不能带病上线）
 * - 条件必填：MAIL_DELIVERY=smtp 时 SMTP 五键缺一不可（log 投递则全部可省）
 * - 成功返回类型安全快照，新代码可 `import { env } from '../config/env-loader'` 消费
 *   （存量代码仍直接读 process.env，不必一次性迁移）
 */
function validateEnv(): z.infer<typeof envSchema> {
  const result = envSchema.superRefine((env, ctx) => {
    if (process.env.NODE_ENV !== 'production') return;
    if (['manage_jwt_secret_key', 'test_jwt_secret_key'].includes(env.JWT_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: '生产环境不得使用模板默认密钥，请更换为强随机值' });
    }
    if (env.COOKIE_SECURE !== 'true') {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: '生产环境必须设为 true（HTTPS 传输 cookie）' });
    }
    if (!env.CORS_ORIGIN) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ORIGIN'], message: '生产环境必须配置跨域白名单（逗号分隔来源），不得放行所有来源' });
    }
  }).superRefine((env, ctx) => {
    if ((env.MAIL_DELIVERY ?? 'log') !== 'smtp') return;
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const) {
      if (!env[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: `MAIL_DELIVERY=smtp 时 ${key} 必填` });
      }
    }
  }).superRefine((env, ctx) => {
    if ((env.STORAGE_DRIVER ?? 'local') !== 's3') return;
    for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
      if (!env[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: `STORAGE_DRIVER=s3 时 ${key} 必填` });
      }
    }
  }).safeParse(process.env);

  if (!result.success) {
    console.error(`环境变量校验失败（${getEnvFilePath()}）：`);
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    console.error('修正后重新启动。');
    process.exit(1);
  }
  return result.data;
}

// 加载当前环境的 env 文件，并派生 DATABASE_URL 供 Prisma（schema 中 env("DATABASE_URL")）使用
// dotenv 不会覆盖已存在的 process.env，多次加载是安全的
function loadAppEnv(): void {
  dotenv.config({ path: getEnvFilePath() });
  process.env.DATABASE_URL ??= buildDatabaseUrl();
}

// 本模块被 import 时立即执行：
// main.ts 必须把它放在第一个 import，保证 AppModule 定义时（winston 配置工厂读取 LOG_LEVEL）环境变量已就绪
loadAppEnv();

/** 校验通过的环境变量快照（数值键已转为 number），新代码优先消费它而非散读 process.env */
export const env = validateEnv();
