import { Module } from '@nestjs/common';
import { AnnouncementController } from './announcement.controller';
import { AnnouncementService } from './announcement.service';

/**
 * 运营公告模块：管理端发布 / 全体登录用户接收
 *
 * 单控制器双前缀（/admin/announcements 管理端 + /announcements 用户端），
 * 各自挂 JwtAuthGuard(+AdminGuard)，不需要 import AuthModule——守卫类无状态依赖，
 * 直接 @UseGuards 引用即可（admin.module import AuthModule 是为了注入 AuthService，
 * 本模块无此需求）。Prisma/Config 均为 @Global 模块，无需显式 import
 */
@Module({
  controllers: [AnnouncementController],
  providers: [AnnouncementService],
})
export class AnnouncementModule {}
