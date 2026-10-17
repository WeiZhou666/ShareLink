import { Global, Module } from '@nestjs/common';
import { AppConfigController } from './config.controller';
import { AppConfigService } from './config.service';
import { RedisModule } from '../redis/redis.module';

/**
 * @Global：AppConfigService 会被多个业务模块消费（auth.signUp 读邮箱验证开关、
 * 前端公开配置端点等），全局注册避免每个模块重复 import
 */
@Global()
@Module({
  imports: [RedisModule], // testRedis 自检用
  controllers: [AppConfigController],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
