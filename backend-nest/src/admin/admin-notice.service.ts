import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';

/** 公告形状：与旧后端 dto 一致，前端 adminNotice.service 原样消费 */
export interface AdminNoticeDto {
  id: string;
  title: string;
  message: string;
  /** 展示条件键：声明"什么配置状态下这条公告才需要展示" */
  conditionKey?: string;
  /** 可选的"查看如何解决"外链 */
  actionLink?: string;
}

/** 条件键清单（新增公告条件时在此扩展 + getPendingNotices 里补判断） */
const NOTICE_CONDITION_KEYS = {
  /** 仅当 S3 存储启用时展示（引导管理员更新桶 CORS 以支持直传） */
  REQUIRE_S3_ENABLED: 'REQUIRE_S3_ENABLED',
} as const;

/**
 * 管理员公告：代码内置的静态定义（移植自旧后端 adminNotice 模块的 admin-notices.json）。
 * 设计语义与旧版保持一致：
 * - 公告内容不走 DB / 管理端 CRUD——系统级提醒随代码版本发布，改公告 = 发版
 * - DB 只存"已读"（AdminNoticeDismissal，noticeId 唯一，记录谁读的）
 * - 条件不满足的公告直接过滤（无论读没读都不展示）
 * 这里用 TS 常量而非 JSON 文件：tsc 构建无需资产拷贝配置，一两条公告不值得引入 copy-assets
 */
const NOTICE_DEFINITIONS: AdminNoticeDto[] = [
  {
    id: 's3_cors_update',
    title: 'Action Required: Update S3 CORS Configuration',
    message:
      "This version introduces direct S3 uploads and downloads. You must update your S3 bucket's CORS configuration to support this.",
    conditionKey: NOTICE_CONDITION_KEYS.REQUIRE_S3_ENABLED,
    actionLink:
      'https://smp46.github.io/pingvin-share-x/v2/setup/s3#cors-configuration',
  },
];

@Injectable()
export class AdminNoticeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService, // @Global 模块，直接注入
  ) {}

  /** 待展示公告 = 静态定义 - 已读记录 - 条件不满足 */
  async getPendingNotices(): Promise<AdminNoticeDto[]> {
    const dismissals = await this.prisma.adminNoticeDismissal.findMany();
    const dismissed = new Set(dismissals.map((d) => d.noticeId));

    // s3 分类尚未迁移（s3.enabled 不在 CONFIG_VARIABLES 清单里，get 会抛 NotFound）
    // ——与旧版同语义：读不到配置按 false 处理，公告不展示
    let isS3Enabled = false;
    try {
      isS3Enabled = (await this.config.get('s3.enabled')) === 'true';
    } catch {
      isS3Enabled = false;
    }

    return NOTICE_DEFINITIONS.filter((notice) => {
      if (dismissed.has(notice.id)) return false;
      if (
        notice.conditionKey === NOTICE_CONDITION_KEYS.REQUIRE_S3_ENABLED &&
        !isS3Enabled
      ) {
        return false;
      }
      return true;
    });
  }

  /**
   * 标记已读：upsert 天然幂等（重复 dismiss 不报错），
   * 记录 dismiss 人（用户名快照冗余一份，管理员账号被删后仍有审计线索）
   */
  async dismissNotice(
    noticeId: string,
    user: { id: string; username: string },
  ): Promise<void> {
    await this.prisma.adminNoticeDismissal.upsert({
      where: { noticeId },
      update: {
        dismissedByUserId: user.id,
        dismissedByUsername: user.username,
      },
      create: {
        noticeId,
        dismissedByUserId: user.id,
        dismissedByUsername: user.username,
      },
    });
  }
}
