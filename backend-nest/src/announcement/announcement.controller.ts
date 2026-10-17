import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { CurrentUser } from '../auth/decorator/current-user.decorator';
import { AdminGuard } from '../admin/guard/admin.guard';
import { AnnouncementService } from './announcement.service';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto';

@ApiTags('announcement')
@ApiBearerAuth()
@Controller()
export class AnnouncementController {
  constructor(private readonly announcementService: AnnouncementService) {}

  // ===== 管理端（AdminGuard）=====

  /** 发布公告（全体登录用户下次加载即会弹窗） */
  @Post('admin/announcements')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({ summary: '发布公告' })
  create(
    @CurrentUser() operator: { id: string; username: string },
    @Body() dto: CreateAnnouncementDto,
  ) {
    return this.announcementService.create(dto, operator.username);
  }

  /** 管理端全量列表（含已读人数） */
  @Get('admin/announcements')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({ summary: '公告管理列表' })
  listForAdmin() {
    return this.announcementService.listForAdmin();
  }

  /** 编辑公告（不重置已读状态：已读用户不再弹，未读用户收到新内容） */
  @Patch('admin/announcements/:id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({ summary: '编辑公告' })
  @ApiNotFoundResponse({ description: '公告不存在' })
  update(@Param('id') id: string, @Body() dto: UpdateAnnouncementDto) {
    return this.announcementService.update(id, dto);
  }

  /** 删除公告（已读记录级联清理） */
  @Delete('admin/announcements/:id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(204)
  @ApiOperation({ summary: '删除公告' })
  @ApiNotFoundResponse({ description: '公告不存在' })
  remove(@Param('id') id: string) {
    return this.announcementService.remove(id);
  }

  // ===== 用户端（全体登录用户）=====

  /** 我的未读公告：登录后 App.vue 拉取弹窗 */
  @Get('announcements/pending')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '当前用户未读公告' })
  getPending(@CurrentUser() user: { id: string }) {
    return this.announcementService.getPendingForUser(user);
  }

  /** 公告标记已读：幂等；公告被删视为已读成功 */
  @Post('announcements/:id/dismiss')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @ApiOperation({ summary: '公告标记已读' })
  dismiss(
    @CurrentUser() user: { id: string; username: string },
    @Param('id') id: string,
  ) {
    return this.announcementService.dismiss(id, user);
  }
}
