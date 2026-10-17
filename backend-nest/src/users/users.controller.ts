import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Patch,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorator/current-user.decorator';
import { UsersService } from './users.service';
import { UpdateCurrentUserDto } from './dto/update-current-user.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';

@ApiTags('用户模块')
@Controller('users')
export class UsersController {
  constructor(
    private usersService: UsersService,
    private authService: AuthService, // 注销账号：清除认证 Cookie（服务端只管吊销会话）
  ) {}

  /** 修改当前用户资料（用户名/邮箱），返回更新后的安全形态用户对象 */
  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: '修改当前用户资料',
    description: '只更新提供的字段；用户名/邮箱唯一，冲突返回 409',
  })
  @ApiSecurity('JWT')
  @ApiConflictResponse({ description: '用户名或邮箱已被占用' })
  updateCurrentUser(
    // 操作者身份一律取认证态注入，不收客户端参数
    @CurrentUser() user: User,
    @Body() dto: UpdateCurrentUserDto,
  ) {
    return this.usersService.updateCurrentUser(user.id, dto);
  }

  /** 修改当前用户密码：已设密码者验旧密码；OAuth 无密码用户直接设置 */
  @Patch('password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  @ApiOperation({
    summary: '修改当前用户密码',
    description:
      '已设密码的用户须提供 oldPassword；OAuth 创建的无密码用户可直接设置新密码',
  })
  @ApiSecurity('JWT')
  @ApiResponse({ status: 204, description: '修改成功' })
  @ApiUnauthorizedResponse({ description: '旧密码错误' })
  async updatePassword(
    @CurrentUser() user: User,
    @Body() dto: UpdatePasswordDto,
  ) {
    await this.usersService.updatePassword(
      user.id,
      dto.oldPassword,
      dto.password,
    );
  }

  /**
   * 注销账号：删除自己 + 清空名下分享的磁盘文件 + 吊销全部会话
   *
   * Cookie 处理：passthrough 拿到 response 后手动清 access_token/refresh_token
   * （与 auth signOut 同款），204 无响应体，前端拿到 204 后自行清本地状态回登录页
   */
  @Delete('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  @ApiOperation({
    summary: '注销当前账号',
    description:
      '删除当前用户并清理名下分享的磁盘文件，吊销全部会话并清除认证 Cookie；最后一个管理员禁止注销',
  })
  @ApiSecurity('JWT')
  @ApiResponse({ status: 204, description: '注销成功' })
  @ApiUnauthorizedResponse({ description: '未登录' })
  async deleteCurrentUser(
    @CurrentUser() user: User,
    // passthrough：仍走 Nest 的响应管道（这里返回 void + 204），同时允许手动改 Cookie 头
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.usersService.deleteCurrentUser(user.id);
    // 清除认证 Cookie（maxAge -1 立即过期），逻辑与 auth signOut 完全一致
    this.authService.clearTokensFromResponse(response);
  }
}
