import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

/**
 * Prisma 数据库服务：注册在 @Global 的 PrismaModule 中，业务模块无需重复 import 即可注入
 * Prisma 7 起 client 必须通过驱动适配器连接数据库，这里把 env-loader 派生的 DATABASE_URL 交给 mariadb 适配器
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    // DATABASE_URL 由 config/env-loader 保证已注入（main.ts 首个 import），此处断言非空
    super({ adapter: new PrismaMariaDb(process.env.DATABASE_URL!) });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.info('数据库连接成功', { context: PrismaService.name });
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.info('数据库连接已断开', { context: PrismaService.name });
  }
}
