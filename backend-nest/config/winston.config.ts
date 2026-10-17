import { format, transports } from 'winston';
import { utilities as nestWinstonModuleUtilities } from 'nest-winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { join } from 'path';

const isProd = process.env.NODE_ENV === 'production';


// 兼容 Nest 适配器把对象作为 context 传入的情况（业务层 log('消息', { 对象 })）
// nestLike 控制台格式会用 + 拼接 context，遇到无原型对象会抛 "Cannot convert object to primitive value"
const safeContextFormat = format((info) => {
  if (info.context && typeof info.context === 'object') {
    info.context = JSON.stringify(info.context);
  }
  return info;
});

//格式化日志
const logFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),//添加时间戳，格式为YYYY-MM-DD HH:mm:ss
  format.errors({ stack: true }),//自动捕获错误堆栈
  format.splat(),//支持使用...args传递多个参数，将多个参数转换为数组
  safeContextFormat(),//context 统一字符串化，避免 nestLike 拼接报错
);

// 生成轮转transport工厂函数
function createRotateTransport(level: string, filename: string) {
  return new DailyRotateFile({
    level,
    dirname: join(process.cwd(), 'logs'), // 日志存放目录，基于项目根目录 logs
    filename: `${filename}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',           // 单个文件最大20M
    maxFiles: '14d',          // 只保留最近14天日志，自动删除旧文件
    zippedArchive: true,      // 过期日志压缩
    // 文件落盘必须显式指定输出格式，否则写入 undefined
    format: format.combine(
      logFormat,
      format.json(),          // 将 info 序列化为 JSON 一行，含 meta 与堆栈
    ),
  });
}

// 工厂函数：LOG_LEVEL 来自对应环境的 .env 文件（经 ConfigService 注入，确保 env 文件已加载）
// error 日志固定记录不受 LOG_LEVEL 影响；combined 与控制台跟随 LOG_LEVEL
export function createWinstonConfig(logLevel: string = process.env.LOG_LEVEL ?? 'debug') {
  return {
    transports: [
      //1.error日志单独记录 logs/error-2026-01-01.log
      createRotateTransport('error', 'error'),
      //2.合并日志 logs/combined.log-2026-01-01.log
      //combined 日志包含 LOG_LEVEL 及以上级别的日志
      createRotateTransport(logLevel, 'combined'),
      // 开发环境控制台打印，生产关闭控制台,三元运算符判断是否开启
      ...(!isProd
        ? [
          new transports.Console({
            level: logLevel,
            format: format.combine(
              logFormat,
              nestWinstonModuleUtilities.format.nestLike('ShareLink', {
                colors: true,
                prettyPrint: true,
              })
            ),
          }),
        ]
        : []),

    ],

    format: logFormat,
  }
}

