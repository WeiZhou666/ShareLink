import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';

/**
 * 邮件模块（@Global：业务模块无需 import，直接注入 EmailService，
 * 与 PrismaModule 同款全局基建定位）
 */
@Global()
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
