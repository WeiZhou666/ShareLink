// 必须是第一个 import：在 AppModule 定义（winston 配置工厂读取 LOG_LEVEL）之前完成环境文件加载
import '../config/env-loader';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { createLogger } from 'winston';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { createWinstonConfig } from '../config/winston.config';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

// 独立于 Nest 容器的 logger，用于启动失败与未捕获异常落盘
const bootLogger = createLogger(createWinstonConfig());

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // 日志记录器配置：Nest 内置 logger 替换为 winston
  const logger = app.get(WINSTON_MODULE_NEST_PROVIDER);
  app.useLogger(logger);

  // 全局路由前缀 /api，与前端及旧后端约定一致
  app.setGlobalPrefix('api');
  // 注册 shutdown 钩子，进程退出时触发 PrismaService.onModuleDestroy 断开数据库连接
  app.enableShutdownHooks();
  // cookie 解析：认证方案依赖 req.cookies（access_token / refresh_token）
  app.use(cookieParser());
  // 跨域：cookie 认证要求 credentials: true，origin 白名单来自 env（未配置时放行所有来源，仅限开发）
  const corsOrigins = process.env.CORS_ORIGIN?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins?.length ? corsOrigins : true,
    credentials: true,
  });
  // 全局校验管道：按 DTO 的 class-validator 装饰器校验入参，whitelist 剔除未声明的字段
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  //swagger构建
  // swagger文档构建
  const config = new DocumentBuilder()
    .setTitle('sharelink接口文档')
    .setDescription('项目API文档')
    .setVersion('1.0')
    // cookie 型 apiKey：与真实鉴权方式一致（JwtStrategy 只读 req.cookies.access_token，不识别 Bearer 头）
    .addApiKey(
      {
        type: 'apiKey',
        in: 'cookie',
        name: 'access_token',
        description:
          'cookie 认证：浏览器登录后自动携带 access_token。注意 swagger-ui 无法通过 Authorize 注入 cookie，需浏览器已持有会话（先调用 signIn）后再测试受保护接口',
      },
      'JWT', // 这个名字，后面 @ApiSecurity('JWT') 使用
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  // swagger v11 默认按原始路径提供文档（不叠加全局前缀），即 /api-docs
  SwaggerModule.setup('api-docs', app, document);
  //swagger端口
  console.log('swagger地址：http://localhost:3000/api-docs');

  // 应用监听端口配置
  await app.listen(process.env.PORT ?? 3000);
  logger.log(
    `Application is running on: http://localhost:${process.env.PORT ?? 3000}`,
  );
}

bootstrap();
