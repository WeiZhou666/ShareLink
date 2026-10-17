/**
 * 分享控制器（路由前缀 /api/shares）
 *
 * 路由一览（与旧后端 API 面对齐，前端 api/share.service.ts 一一对应）：
 *   GET    /all                          管理员全量列表（旧 API 兼容端点；admin 页走 /admin/shares）
 *   GET    /                             我的分享列表（已完成 + 未过期）
 *   GET    /received                     收到的分享（收件人视角）
 *   GET    /isShareIdAvailable/:id       分享 ID 查重（公开，限流 10/分）
 *   POST   /                             创建分享骨架（登录 或 反向分享令牌）
 *   GET    /:id                          公开读取分享（ShareSecurityGuard 门禁）
 *   GET    /:id/from-owner               所有者视角读取（不过期门禁，编辑页用）
 *   GET    /:id/metaData                 公开元数据（zip 就绪状态）
 *   PATCH  /:id                          更新（所有者）
 *   POST   /:id/complete                 完成上传（HTTP 202 = 旧 API 契约）
 *   DELETE /:id/complete                 回退到上传中
 *   POST   /:id/expire                   立即过期
 *   POST   /:id/token                    密码换访问令牌（20 次/5 分钟）
 *   POST   /:id/email                    把分享链接发到指定邮箱（所有者）
 *   DELETE /:id                          删除分享
 *
 * 注意路由声明顺序：NestJS 按声明顺序匹配，静态段（all/received/isShareIdAvailable）
 * 必须声明在 @Get(":id") 之前，否则会被 ":id" 通配吃掉。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import type { User } from '@prisma/client';
import { I18nContext, I18nService } from 'nestjs-i18n';
import { CurrentUser } from '../auth/decorator/current-user.decorator';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { AdminGuard } from '../admin/guard/admin.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CreateShareGuard } from './guard/create-share.guard';
import {
  ShareOwnerGuard,
  StrictShareOwnerGuard,
} from './guard/share-owner.guard';
import { ShareSecurityGuard } from './guard/share-security.guard';
import { ShareTokenGuard } from './guard/share-token.guard';
import { ShareService } from './share.service';
import { CreateShareDTO } from './dto/create-share.dto';
import { UpdateShareDTO } from './dto/update-share.dto';
import { SharePasswordDTO } from './dto/share-password.dto';

@Controller('shares')
export class ShareController {
  constructor(
    private shareService: ShareService,
    private prisma: PrismaService,
    private jwtService: JwtService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * 管理员全量列表（旧 API 兼容端点，前端旧 admin 页曾用；现 admin 后台走 /api/admin/shares 分页接口）
   * size 用 BigInt 求和再 toString——File.size 是 BigInt，直接 JSON.stringify 会抛错
   */
  @Get('all')
  @UseGuards(AdminGuard)
  async getAllShares() {
    const shares = await this.prisma.share.findMany({
      orderBy: { expiration: 'desc' },
      include: { files: true, creator: true },
    });
    return shares.map((s) => ({
      id: s.id,
      name: s.name,
      views: s.views,
      expiration: s.expiration,
      createdAt: s.createdAt,
      creator: s.creator
        ? { username: s.creator.username, email: s.creator.email }
        : null,
      size: s.files.reduce((sum, f) => sum + f.size, 0n).toString(),
      filesCount: s.files.length,
    }));
  }

  /** 我的分享列表（"我的分享"页数据源） */
  @Get()
  @UseGuards(JwtAuthGuard)
  async getMyShares(@CurrentUser() user: User) {
    return this.shareService.getSharesByUser(user.id);
  }

  /** 收到的分享（share.enableUserRecipients 开关控制收件人功能） */
  @Get('received')
  @UseGuards(JwtAuthGuard)
  async getReceivedShares(@CurrentUser() user: User) {
    return this.shareService.getReceivedShares(user.id);
  }

  /** 分享 ID 查重：上传弹窗自定义链接时前端实时校验（公开可探测，收紧限流） */
  @Throttle({ default: { limit: 10, ttl: 60 * 1000 } })
  @Get('isShareIdAvailable/:id')
  async isShareIdAvailable(@Param('id') id: string) {
    return this.shareService.isShareIdAvailable(id);
  }

  /**
   * 创建分享骨架（登录用户 或 持反向分享令牌的访客）
   * CreateShareGuard：JWT 认证可选，匿名必须有有效 reverse_share_token cookie
   * 创建的只是"骨架"（uploadLocked=false），文件走 POST /:shareId/files 逐块上传
   */
  @Post()
  @UseGuards(CreateShareGuard)
  async create(
    @Body() dto: CreateShareDTO,
    @Req() request: Request,
    @CurrentUser() user?: User,
  ) {
    const reverseShareToken = request.cookies?.['reverse_share_token'] as
      string | undefined;
    return this.shareService.create(dto, user, reverseShareToken);
  }

  /** 公开读取分享（密码分享需先 POST /:id/token 换 cookie 令牌；守卫负责全部门禁） */
  @Get(':id')
  @UseGuards(ShareSecurityGuard)
  async get(@Req() request: Request) {
    // String() 收窄：Express 5 类型里 params 值是 string | string[]
    return this.shareService.get(String(request.params.id));
  }

  /** 所有者视角读取：不过公开门禁（过期/密码的分享本人仍可管理），ShareEditView 编辑页用 */
  @Get(':id/from-owner')
  @UseGuards(ShareOwnerGuard)
  async getFromOwner(@Param('id') id: string) {
    return this.shareService.getFromOwner(id);
  }

  /** 元数据：公开分享页轮询 zip 打包是否就绪 */
  @Get(':id/metaData')
  @UseGuards(ShareSecurityGuard)
  async getMetaData(@Param('id') id: string) {
    return this.shareService.getMetaData(id);
  }

  /** 更新分享（所有者或管理员；匿名分享任何人可改——与旧后端语义一致） */
  @Patch(':id')
  @UseGuards(ShareOwnerGuard)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateShareDTO,
    @CurrentUser() user?: User,
  ) {
    return this.shareService.update(id, dto, user);
  }

  /** 完成上传：分享对外可见（HTTP 202 = 旧 API 契约，前端据此弹完成窗） */
  @HttpCode(HttpStatus.ACCEPTED)
  @Post(':id/complete')
  @UseGuards(StrictShareOwnerGuard)
  async complete(@Param('id') id: string, @Req() request: Request) {
    const reverseShareToken = request.cookies?.['reverse_share_token'] as
      string | undefined;
    return this.shareService.complete(id, reverseShareToken);
  }

  /** 回退到上传中（编辑场景重开上传通道，补传/删文件后需再次 complete） */
  @Delete(':id/complete')
  @UseGuards(StrictShareOwnerGuard)
  async revertComplete(@Param('id') id: string) {
    return this.shareService.revertComplete(id);
  }

  /** 立即过期：不删数据，只把 expiration 置为当前时间（门禁立即生效） */
  @HttpCode(HttpStatus.OK)
  @Post(':id/expire')
  @UseGuards(ShareOwnerGuard)
  async expire(@Param('id') id: string) {
    await this.shareService.expire(id);
  }

  /**
   * 密码换访问令牌：响应头种 share_{id}_token cookie（httpOnly）
   * 前端 ShareView 先调本接口再 GET /:id，cookie 自动携带
   *
   * 守卫选择说明：这里用轻量 ShareTokenGuard 而非 ShareSecurityGuard——
   * 签发端点是"换令牌"入口，请求方此刻必然还没有有效令牌，用全量门禁守卫
   * 会形成"没令牌 → 拿不到令牌"的死锁。密码正确性/maxViews 在 service 层校验
   * （需要读 body 里的密码），有效旧令牌可免密续签（刷新页面不重打密码）。
   */
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 5 * 60 * 1000 } })
  @UseGuards(ShareTokenGuard)
  @Post(':id/token')
  async getShareToken(
    @Param('id') id: string,
    @Body() body: SharePasswordDTO,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    // 请求方已持有的旧令牌（可能是别的分享的/过期的/伪造的）——service 里验签，
    // 有效则免密续签，无效则静默走正常密码校验
    const existingToken = request.cookies?.[`share_${id}_token`] as
      string | undefined;
    const token = await this.shareService.getShareToken(
      id,
      body.password,
      existingToken,
    );

    this.clearShareTokenCookies(request, response);
    response.cookie(`share_${id}_token`, token, {
      path: '/',
      httpOnly: true,
      // sameSite lax：站内请求携带，从微信/邮件点开的外链 GET 也携带（分享页主场景）
      sameSite: 'lax',
    });
    return { token };
  }

  /** 把分享链接发到指定邮箱（上传完成弹窗的邮件 tab） */
  @HttpCode(HttpStatus.OK)
  @Post(':id/email')
  @UseGuards(ShareOwnerGuard)
  async sendToEmail(@Param('id') id: string, @Body() body: { email?: string }) {
    // 邮箱格式后端再验一道（前端输入框无格式校验）
    if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      throw new BadRequestException(this.i18n.t('share.invalidEmail'));
    }
    // I18nContext 取当前请求语言（I18nService 实例上没有 lang——当前语言挂在 CLS 上下文里）
    await this.shareService.emailShareLink(
      id,
      body.email,
      I18nContext.current()?.lang,
    );
    return { sent: true };
  }

  /** 删除分享（磁盘目录 + 数据库级联；匿名分享仅管理员可删，见 service.remove） */
  @Delete(':id')
  @UseGuards(ShareOwnerGuard)
  async remove(@Param('id') id: string, @CurrentUser() user?: User) {
    await this.shareService.remove(id, user?.isAdmin === true);
  }

  /**
   * 清理过期的分享令牌 cookie（超过 10 个时删最旧的）：
   * 访问多个密码分享会累积 share_*_token cookie，不清理会撞浏览器单域 180 cookie 上限，
   * 导致最早的登录 cookie 被浏览器静默丢弃
   */
  private clearShareTokenCookies(request: Request, response: Response) {
    const now = Math.floor(Date.now() / 1000);
    const shareTokenCookies = Object.entries(request.cookies ?? {})
      .filter(([key]) => key.startsWith('share_') && key.endsWith('_token'))
      .map(([key, value]) => {
        // jwtService.decode 仅解码不验签——这里只读 exp 做过期分拣，无安全语义
        const payload = this.jwtService.decode(value);
        return { key, exp: payload?.exp ?? 0 };
      });

    // 已过期的先清
    shareTokenCookies
      .filter((c) => c.exp < now)
      .forEach((c) => response.clearCookie(c.key));

    // 有效但超出 10 个：按过期时间升序删最旧的
    const valid = shareTokenCookies
      .filter((c) => c.exp >= now)
      .sort((a, b) => a.exp - b.exp);
    valid
      .slice(0, Math.max(0, valid.length - 10))
      .forEach((c) => response.clearCookie(c.key));
  }
}
