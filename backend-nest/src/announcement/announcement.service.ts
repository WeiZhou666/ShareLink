import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto';

/**
 * 运营公告：管理端发布，全体登录用户可见（弹一次确认后不再弹）。
 * 与 admin 模块的系统级 AdminNotice 区分：
 * - AdminNotice：代码内置静态定义（随版本发布），只有管理员看
 * - Announcement：管理员在界面上发布，存 DB，全体登录用户看
 * 两者共用前端同一个强制确认弹窗（见 frontend App.vue 合并队列逻辑）
 */
@Injectable()
export class AnnouncementService {
  constructor(private readonly prisma: PrismaService) {}

  // ===== 管理端 =====

  /** 发布公告：记录发布人用户名快照 */
  async create(dto: CreateAnnouncementDto, createdByUsername: string) {
    return this.prisma.announcement.create({
      data: {
        title: dto.title,
        message: dto.message,
        actionLink: dto.actionLink || null,
        createdByUsername,
      },
    });
  }

  /** 管理端全量列表：附带每条已读人数（_count）供管理页展示 */
  async listForAdmin() {
    return this.prisma.announcement.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { reads: true } } },
    });
  }

  /**
   * 编辑公告：更新标题/正文/链接。
   * 已读记录刻意保留——已读用户不会被重新弹窗，只有未读用户能看到新内容
   */
  async update(id: string, dto: UpdateAnnouncementDto) {
    const announcement = await this.prisma.announcement.findUnique({
      where: { id },
    });
    if (!announcement) {
      throw new NotFoundException('公告不存在');
    }
    return this.prisma.announcement.update({
      where: { id },
      data: {
        title: dto.title,
        message: dto.message,
        actionLink: dto.actionLink || null,
      },
    });
  }

  /** 删除公告：已读记录级联清理（schema onDelete: Cascade） */
  async remove(id: string) {
    const announcement = await this.prisma.announcement.findUnique({
      where: { id },
    });
    if (!announcement) {
      throw new NotFoundException('公告不存在');
    }
    await this.prisma.announcement.delete({ where: { id } });
  }

  // ===== 用户端（全体登录用户） =====

  /** 当前用户未读公告：新→旧，前端按队列逐条强制确认 */
  async getPendingForUser(user: { id: string }) {
    const readSet = await this.prisma.announcementRead.findMany({
      where: { readByUserId: user.id },
      select: { announcementId: true },
    });
    const readIds = new Set(readSet.map((r) => r.announcementId));
    const all = await this.prisma.announcement.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return all.filter((a) => !readIds.has(a.id));
  }

  /**
   * 标记已读：upsert 天然幂等（重复 dismiss / 并发双击不报错）
   * 复合唯一键 [announcementId, readByUserId] 保证一人一条
   */
  async dismiss(id: string, user: { id: string; username: string }) {
    const announcement = await this.prisma.announcement.findUnique({
      where: { id },
    });
    if (!announcement) {
      // 公告可能已被管理员删除——视为已读成功，前端直接过
      return;
    }
    await this.prisma.announcementRead.upsert({
      where: {
        announcementId_readByUserId: {
          announcementId: id,
          readByUserId: user.id,
        },
      },
      update: {},
      create: {
        announcementId: id,
        readByUserId: user.id,
        readByUsername: user.username,
      },
    });
  }
}
