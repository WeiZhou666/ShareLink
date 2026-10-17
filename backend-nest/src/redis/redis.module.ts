import { Module } from '@nestjs/common';
import { RedisService } from './redis.service';

@Module({
  providers: [RedisService],
  exports: [RedisService], // ⚠️导出，别的模块import这个module就可以用service
})
export class RedisModule {}
