/**
 * 定时任务模块：集中注册 JobsService（对齐旧版 jobs.module 的组织方式）。
 * ScheduleModule.forRoot() 已在 AppModule 注册，@Cron 装饰器在此即可生效；
 * PrismaModule（@Global）无需显式 import，FileService/ShareService 由 ShareModule 导出，
 * ScanService 由 AntivirusModule 导出
 */
import { Module } from '@nestjs/common';
import { ShareModule } from '../share/share.module';
import { UsersModule } from '../users/users.module';
import { AntivirusModule } from '../antivirus/antivirus.module';
import { JobsService } from './jobs.service';

@Module({
  // FileService（清磁盘）+ ShareService（任务 8 补 zip）由 ShareModule exports；
  // UsersService（软删到期物理清）由 UsersModule exports；ScanService（任务 8 重扫）由 AntivirusModule exports
  imports: [ShareModule, UsersModule, AntivirusModule],
  providers: [JobsService],
})
export class JobsModule {}
