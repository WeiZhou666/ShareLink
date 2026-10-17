import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// @Global：业务模块直接注入 PrismaService，无需每个模块重复 import
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
