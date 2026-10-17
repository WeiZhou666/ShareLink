import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorator/current-user.decorator';
import { AdminGuard } from './guard/admin.guard';
import { AdminService } from './admin.service';
import { AdminNoticeService } from './admin-notice.service';
import {
  AdminResetPasswordDto,
  AdminUpdateUserDto,
  AdminUserQueryDto,
} from './dto/admin-user.dto';
import { AdminShareQueryDto } from './dto/admin-share.dto';

/**
 * 管理员后台 — 用户管理
 *
 * 权限模型（两层）：
 * - 类级 @UseGuards(AdminGuard)：本控制器所有接口都要求"有效登录 + isAdmin"
 *   （AdminGuard 内部先走完整 JWT 认证链，再做角色检查）
 * - 业务级保护在 AdminService：不能自删/自降权/删最后一个管理员
 *
 * 为什么 :id 用 ParseUUIDPipe：路由参数是纯字符串入口，
 * 用管道在 controller 层就拦掉非法格式（400），service 层只处理业务语义
 */
@ApiTags('Admin')
@ApiSecurity('JWT') // swagger 里锁形图标：cookie 中的 access_token（与 auth 模块同款安全方案）
@ApiUnauthorizedResponse({ description: '未登录或 token 无效（401）' })
@ApiForbiddenResponse({ description: '已登录但不是管理员（403）' })
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private adminService: AdminService,
    private adminNoticeService: AdminNoticeService,
  ) {}

  /** 用户列表：分页 + keyword 模糊搜索（username / email） */
  @Get('users')
  @ApiOperation({ summary: '用户列表（分页+搜索）' })
  listUsers(@Query() query: AdminUserQueryDto) {
    return this.adminService.listUsers(query);
  }

  /** 启用/禁用账号、设/撤管理员（禁用会联动踢下线） */
  @Patch('users/:id')
  @ApiOperation({ summary: '更新用户（isAdmin / isActivated）' })
  @ApiNotFoundResponse({ description: '目标用户不存在' })
  @ApiBadRequestResponse({
    description: '业务规则不满足（如修改自己的管理员身份）',
  })
  updateUser(
    // 操作者 id / email 来自守卫链查库结果（req.currentUser），不是客户端传参——不可伪造
    @CurrentUser('id') operatorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateUserDto,
  ) {
    return this.adminService.updateUser(operatorId, id, dto);
  }

  /** 管理员直接设置新密码（重置后该用户全部会话失效，需用新密码重新登录） */
  @Post('users/:id/resetPassword')
  @HttpCode(200)
  @ApiOperation({ summary: '重置用户密码（联动踢下线）' })
  @ApiNotFoundResponse({ description: '目标用户不存在' })
  resetPassword(
    @CurrentUser('email') operatorEmail: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminResetPasswordDto,
  ) {
    return this.adminService.resetPassword(operatorEmail, id, dto);
  }

  /** 踢下线：吊销目标用户全部会话，不改任何用户数据 */
  @Post('users/:id/revokeSessions')
  @HttpCode(200)
  @ApiOperation({ summary: '踢下线（吊销目标用户全部会话）' })
  @ApiNotFoundResponse({ description: '目标用户不存在' })
  revokeSessions(
    @CurrentUser('email') operatorEmail: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminService.revokeSessions(operatorEmail, id);
  }

  /** 删除用户：软删除（半年冷静期，与自我注销同语义），不能删自己 / 最后一个管理员 */
  @Delete('users/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: '删除用户',
    description:
      '软删除：名下分享立即过期、会话全吊销；username/email 原值保留占名防冒充；半年冷静期内可自助恢复，到期由定时任务物理清除',
  })
  @ApiNotFoundResponse({ description: '目标用户不存在' })
  @ApiBadRequestResponse({
    description: '业务规则不满足（删自己 / 最后一个管理员 / 已处于注销态）',
  })
  deleteUser(
    @CurrentUser('id') operatorId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminService.deleteUser(operatorId, id);
  }

  /** 分享列表：分页 + keyword 搜索（分享 id / 名称 / 创建者），附带全库磁盘占用 */
  @Get('shares')
  @ApiOperation({ summary: '分享列表（分页+搜索+磁盘占用）' })
  listShares(@Query() query: AdminShareQueryDto) {
    return this.adminService.listShares(query);
  }

  /**
   * 删除分享（文件行级联清理；物理存储清理随 share 模块迁移接入）
   * :id 不挂 ParseUUIDPipe：分享 id 将来开放自定义（shareIdLength），不锁死 uuid 格式
   */
  @Delete('shares/:id')
  @HttpCode(204)
  @ApiOperation({ summary: '删除分享' })
  @ApiNotFoundResponse({ description: '分享不存在' })
  removeShare(
    @CurrentUser('email') operatorEmail: string,
    @Param('id') id: string,
  ) {
    return this.adminService.removeShare(operatorEmail, id);
  }

  // ===== 管理员公告（移植自旧后端 adminNotice 模块，路由收编进 admin 域） =====

  /**
   * 待展示公告列表：App.vue 管理员登录后轮询弹窗用。
   * :id 是公告定义 id（如 "s3_cors_update"），不是 UUID——不挂 ParseUUIDPipe
   */
  @Get('notices/pending')
  @ApiOperation({ summary: '待展示的管理员公告' })
  listPendingNotices() {
    return this.adminNoticeService.getPendingNotices();
  }

  /** 公告标记已读：幂等 upsert，记录操作人 */
  @Post('notices/:id/dismiss')
  @HttpCode(200)
  @ApiOperation({ summary: '公告标记已读' })
  dismissNotice(
    @CurrentUser() operator: { id: string; username: string },
    @Param('id') noticeId: string,
  ) {
    return this.adminNoticeService.dismissNotice(noticeId, operator);
  }
}
