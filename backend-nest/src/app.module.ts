import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { AnnouncementModule } from './announcement/announcement.module';
import { OAuthModule } from './oauth/oauth.module';
import { EmailModule } from './email/email.module';
import { AppConfigModule } from './config/config.module';
import { StorageModule } from './share/storage/storage.module';
import { UsersModule } from './users/users.module';
import { ShareModule } from './share/share.module';
import { JobsModule } from './jobs/jobs.module';
import { WinstonModule } from 'nest-winston';
import {
  I18nModule,
  QueryResolver,
  AcceptLanguageResolver,
  I18nJsonLoader,
} from 'nestjs-i18n';
import * as path from 'node:path';

import { AllExceptionFilter } from '../common/filters/all-exception.filter';
import { getEnvFilePath } from '../config/env-loader';
import { createWinstonConfig } from '../config/winston.config';
@Module({
  imports: [
    // ① 按 NODE_ENV 加载对应 env 文件（.env.development / .env.test / .env.production），并注册全局 ConfigService
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: getEnvFilePath(),
    }),
    // ② 注册winston全局模块，传入配置工厂函数
    WinstonModule.forRoot(createWinstonConfig()),
    // ③ 数据库（@Global，业务模块无需重复 import）
    PrismaModule,
    // ④ 邮件（@Global）：激活码/重置邮件投递出口，MAIL_DELIVERY 切换 log|smtp 模式
    EmailModule,
    // ⑤ 全局限流：默认 60 秒内最多 100 次，敏感接口用 @Throttle 单独收紧（如登录 20 次/5分钟）
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    // ⑥ 定时任务（@Cron 装饰器所在服务，如过期 refresh 会话清理）
    ScheduleModule.forRoot(),
    // ⑥ 认证模块（内部 import RedisModule 供黑名单使用）
    AuthModule,
    // ⑦ 管理员后台（用户管理；AdminGuard 复用 auth 的 JWT 认证链）
    AdminModule,
    // ⑧ OAuth 第三方登录（GitHub OAuth + 本地 OIDC；回调后汇合到 auth 的 generateToken 双 token 体系）
    OAuthModule,
    // ⑨ 应用配置（@Global：三层取值 config.yaml > DB > 代码清单默认值；公开配置 + admin 修改/自检）
    AppConfigModule,
    // ⑨½ 文件存储（@Global：按 STORAGE_DRIVER 装配 local/s3 驱动，FileService/ShareService/ScanService 注入）
    StorageModule,
    // ⑩ 用户资料（PATCH /users/me 修改用户名/邮箱；改密在 auth 的 PATCH /api/auth/password）
    UsersModule,
    // ⑪ 分享模块（分享 CRUD/分块上传/公开访问/反向分享；octet-stream raw body 中间件在模块内挂载）
    ShareModule,
    // ⑫ 定时任务（对齐旧版 6 个 cron：过期分享/反向分享/未完成分享/过期令牌/未激活账号/暂存分块）
    JobsModule,
    // ⑬ 运营公告（管理端发布 /admin/announcements；全体登录用户接收 /announcements/pending）
    AnnouncementModule,
    // ⑭ 国际化（@Global，全项目可注入 I18nService）：
    //  - fallback zh-CN：无匹配语言时的兜底（默认语言，与前端约定一致）
    //  - QueryResolver：?lang=en-US 查询参数优先（便于回归测试与显式切换）
    //  - AcceptLanguageResolver：无查询参数时按 Accept-Language 头解析（RFC4647 感知，
    //    支持 "zh-CN,zh;q=0.9,en;q=0.8" 列表形式与 q 权重；HeaderResolver 只认单值头，浏览器场景恒失效）
    //  - watch: true：开发模式下翻译 JSON 变更热载，无需重启进程
    I18nModule.forRoot({
      fallbackLanguage: 'zh-CN',
      loader: I18nJsonLoader,
      loaderOptions: {
        // assets 落点 dist/i18n/，而本文件编译产物在 dist/src/ —— 回退一级对齐
        path: path.join(__dirname, '../i18n/'),
        watch: true,
      },
      // resolvers 必须用 { use, options } 形式：裸类写法会注入 undefined 的 options，
      // QueryResolver/HeaderResolver 的默认 keys 是 []，什么都解析不到（语言恒为 fallback）
      resolvers: [
        { use: QueryResolver, options: ['lang'] }, // ?lang=en-US 显式切换
        { use: AcceptLanguageResolver, options: [] }, // RFC4647 感知：支持 "zh-CN,zh;q=0.9" 列表头 + q 权重
      ],
    }),
  ],

  controllers: [AppController],
  providers: [
    AppService,
    // 全局注册异常过滤器：所有路由抛出的异常统一捕获、记录日志并返回 { statusCode, message }
    { provide: APP_FILTER, useClass: AllExceptionFilter },
    // 全局注册限流守卫
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
