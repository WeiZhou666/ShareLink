import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { OAuthService } from './oauth.service';
import { I18nService } from 'nestjs-i18n';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { CurrentUser } from '../auth/decorator/current-user.decorator';
import { OAuthBindDto } from './dto/oauth-bind.dto';

/**
 * OAuth 第三方登录（浏览器跳转链路），两个端点：
 *   GET /api/oauth/:provider           —— 发起：302 到 IdP 授权页
 *   GET /api/oauth/:provider/callback  —— 回调：IdP 授权完成后 302 回到这里
 * 回调一律 302 回前端（成功到首页，失败带 error 参数回登录页）——
 * 浏览器场景下 callback 若返回 JSON 会白页；Set-Cookie 在 302 响应里照常生效，
 * 前端拿到页面后由 /api/auth/me 拉到登录态（与密码登录同一条状态同步路径）。
 * POST bind/:provider 是 fetch 调用（非跳转），保持 JSON 响应。
 */
@ApiTags('OAuth 第三方登录')
@Controller('oauth')
export class OAuthController {
  /** 前端基址：与邮件重置链接共用同一 env（生产必须配，否则重置链接/OAuth 回跳落错地方） */
  private readonly frontendUrl =
    process.env.FRONTEND_URL || 'http://localhost:5173';

  constructor(
    private readonly oauthService: OAuthService,
    private readonly authService: AuthService, // 复用双 token 下发（Set-Cookie 与 signIn 完全一致）
    private readonly i18n: I18nService,
  ) {}

  @Get(':provider')
  @ApiOperation({ summary: '发起第三方登录：302 到 IdP 授权页' })
  @ApiParam({ name: 'provider', example: 'github' })
  async login(@Param('provider') provider: string, @Res() response: Response) {
    const url = await this.oauthService.createLoginUrl(provider);
    return response.redirect(302, url);
  }

  @Get(':provider/callback')
  @ApiOperation({
    summary:
      'IdP 回调：校验 state/nonce → findOrCreate → 种双 cookie → 302 回前端',
  })
  @ApiParam({ name: 'provider', example: 'github' })
  async callback(
    @Param('provider') provider: string,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
    @Res() response?: Response,
  ) {
    const backToSignIn = () =>
      response!.redirect(
        302,
        `${this.frontendUrl}/auth/signIn?error=oauth_failed`,
      );
    // 用户在 IdP 页面点了"取消"（GitHub/Deny、OIDC error 回调）→ 带参回登录页
    if (error) return backToSignIn();
    try {
      const result = await this.oauthService.handleCallback(
        provider,
        code,
        state,
      );
      // 下发与密码登录完全相同的双 httpOnly cookie（302 响应里照常 Set-Cookie）
      this.authService.addTokensToResponse(
        response!,
        result.refreshToken,
        result.accessToken,
      );
      return response!.redirect(302, this.frontendUrl);
    } catch {
      // 失败详情只在服务端日志（防枚举口径与 signIn 一致）；前端按 ?error=oauth_failed 展示通用提示
      return backToSignIn();
    }
  }

  /**
   * 绑定第三方身份到当前登录账号——外部身份没有可用邮箱时（如 GitHub 私有邮箱）的入账途径
   * 流程：登录态下访问 /api/oauth/:provider → mock/IdP 302 回 callback 带 code/state
   * → 前端拿 code/state POST 到这里（幂等：重复绑同一身份 already:true）
   */
  @Post('bind/:provider')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '绑定第三方身份（外部邮箱不可用时的登录前置）' })
  @ApiParam({ name: 'provider', example: 'github' })
  bind(
    @Param('provider') provider: string,
    @Body() dto: OAuthBindDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.oauthService.bind(provider, dto.code, dto.state, user.id);
  }
}
