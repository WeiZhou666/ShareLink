/**
 * 病毒扫描模块：ClamAV clamd INSTREAM 客户端 + 扫描编排
 *
 * - ClamAvService：纯协议客户端（连接参数走 env：CLAMAV_HOST/CLAMAV_PORT）
 * - ScanService：share 级批量扫描 + File.scanStatus 状态机 + ERROR 自愈辅助（jobs 消费）
 *
 * 被依赖方：ShareModule（complete 触发扫描）与 JobsModule（任务 8 重扫）——
 * 需 exports ScanService；ClamAvService 仅被 ScanService 内部使用不必导出。
 * PrismaModule（@Global）/ ConfigModule（@Global）无需显式 import
 */
import { Module } from '@nestjs/common';
import { ClamAvService } from './clamav.service';
import { ScanService } from './scan.service';

@Module({
  providers: [ClamAvService, ScanService],
  exports: [ScanService],
})
export class AntivirusModule {}
