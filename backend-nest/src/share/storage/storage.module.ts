/**
 * 存储模块（@Global 基础设施，与 PrismaModule/AppConfigModule 同待遇）：
 * 按 STORAGE_DRIVER 装配 local / s3 唯一实例，全模块通过 FILE_STORAGE 令牌注入
 *
 * 为什么独立成全局模块而不是挂在 ShareModule：ScanService（AntivirusModule）与
 * FileService/ShareService（ShareModule）都要注入，挂 ShareModule 会让 AntivirusModule
 * 反向依赖 ShareModule（循环）；存储又是纯基础设施，全局化与既有惯例一致
 */
import { Global, Module } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { I18nService } from 'nestjs-i18n';
import { env } from '../../../config/env-loader';
import { FILE_STORAGE } from './storage.backend';
import { LocalStorage } from './local.storage';
import { S3Storage } from './s3.storage';

@Global()
@Module({
  providers: [
    // 存储驱动装配：STORAGE_DRIVER 进程级常量（启动时定死，不做运行时切换——
    // 中途换驱动会留下"两边都有半份"的脏数据）；local/s3 实现同一 StorageBackend 接缝
    {
      provide: FILE_STORAGE,
      useFactory: (i18n: I18nService, logger: Logger) =>
        (env.STORAGE_DRIVER ?? 'local') === 's3'
          ? new S3Storage(i18n, logger)
          : new LocalStorage(i18n, logger),
      inject: [I18nService, WINSTON_MODULE_PROVIDER],
    },
  ],
  exports: [FILE_STORAGE],
})
export class StorageModule {}
