/**
 * 反向分享控制器（路由前缀 /api/reverseShares）
 *
 * 反向分享 = "帮我上传"链接：创建者生成令牌，把 {appUrl}/upload/{token} 发给别人，
 * 对方打开上传页免登录上传（令牌作为 reverse_share_token cookie 随创建/上传请求携带）。
 *
 * 路由一览（与旧后端 API 面对齐，前端 share.service.ts 一一对应）：
 *   GET    /isReverseShareTokenAvailable/:token   自定义 token 查重（登录，10 次/分）
 *   POST   /                                      创建令牌（登录）→ { token, link }
 *   GET    /:token                                公开读取令牌信息（上传页展示用，20 次/分）
 *   GET    /                                      我的反向分享列表（登录）
 *   DELETE /:id                                   删除令牌（创建者或管理员）
 *
 * 注意路由声明顺序：isReverseShareTokenAvailable/:token 必须声明在 :token 之前。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorator/current-user.decorator';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { ReverseShareService } from './reverse-share.service';
import { CreateReverseShareDTO } from './dto/create-reverse-share.dto';

@Controller('reverseShares')
export class ReverseShareController {
  constructor(private reverseShareService: ReverseShareService) {}

  /** 自定义 token 查重：创建弹窗输入自定义 token 时前端实时校验（公开可探测，收紧限流） */
  @Throttle({ default: { limit: 10, ttl: 60 * 1000 } })
  @Get('isReverseShareTokenAvailable/:token')
  @UseGuards(JwtAuthGuard)
  async isReverseShareTokenAvailable(@Param('token') token: string) {
    return this.reverseShareService.isReverseShareTokenAvailable(token);
  }

  /**
   * 创建反向分享令牌，返回 { token, link }——link 由后端拼（旧后端契约字段）。
   * 基址取 FRONTEND_URL env（与邮件重置链接/分享邮件同先例）：链接本质是前端页面
   * 地址，走部署环境变量而非 AppConfig（前端自己拼链接时用的就是自己的 origin）。
   * 注意先取环境变量再建令牌以外的逻辑：env 读取同步且不会抛错，杜绝
   * "令牌行已落库、链接拼装才失败"的非原子残留（此前误用清单外的 general.appUrl 就是这个坑）。
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Body() dto: CreateReverseShareDTO, @CurrentUser() user: User) {
    // 去掉尾部斜杠：FRONTEND_URL 配成 "https://host/" 时避免拼出 //upload
    const frontendUrl = (
      process.env.FRONTEND_URL || 'http://localhost:5173'
    ).replace(/\/$/, '');
    const token = await this.reverseShareService.create(dto, user.id);
    return { token, link: `${frontendUrl}/upload/${token}` };
  }

  /** 公开读取令牌信息（对方打开 /upload/{token} 时上传页展示"给谁上传/上限/剩余次数"） */
  @Throttle({ default: { limit: 20, ttl: 60 * 1000 } })
  @Get(':token')
  async getByToken(@Param('token') token: string) {
    // 无效/过期/次数用尽的令牌统一 404（service 内判定），不暴露存在性
    return this.reverseShareService.getByToken(token);
  }

  /** 我的反向分享列表（"反向分享"管理页数据源：令牌 + 各令牌已产生的分享） */
  @Get()
  @UseGuards(JwtAuthGuard)
  async getAllByUser(@CurrentUser() user: User) {
    return this.reverseShareService.getAllByUser(user.id);
  }

  /**
   * 删除令牌：归属校验在 service（创建者本人或管理员）。
   * 其下未完成的分享一并过期作废，已完成的分享保留但解绑（SetNull）
   */
  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async remove(@Param('id') id: string, @CurrentUser() user: User) {
    await this.reverseShareService.remove(id, user.id, user.isAdmin);
  }
}
