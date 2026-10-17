import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
// isolatedModules + emitDecoratorMetadata 下，装饰器签名中的纯类型必须用 import type 引入
import type { Request, Response } from 'express';
import type { User } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { I18nService } from 'nestjs-i18n';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guard/jwt-auth.guard';
import { CurrentUser } from './decorator/current-user.decorator';
import { GetJwtPayload } from './decorator/get-jwt-payload.decorator';
import type { JwtPayload } from './auth.types';
// DTO 必须值导入：ValidationPipe 依赖 emitDecoratorMetadata 生成的 design:paramtypes，
// import type 会导致元数据缺失、校验静默失效（express Request/User 等纯类型才用 import type）
import { AuthSignInDto } from './dto/auth-sign-in.dto';
import {
  AuthSignUpDto,
  AuthResendVerificationDto,
  AuthVerifyEmailDto,
} from './dto/auth-sign-up.dto';
import {
  AuthRequestResetDto,
  AuthResetPasswordDto,
} from './dto/auth-forgot-password.dto';
import {
  ApiTags,
  ApiOperation,
  ApiSecurity,
  ApiBody,
  ApiResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

@ApiTags('认证模块')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private i18n: I18nService, // 面向用户的响应消息走 i18n（?lang / Accept-Language 切换）
  ) {}

  /** 登录：签发双 token 并写入 cookie（敏感接口限流：5 分钟内最多 20 次） */
  @Post('signIn')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 5 * 60 * 1000 } })
  @ApiOperation({
    summary: '登录',
    description:
      '账号密码登录，返回accessToken；refreshToken 仅通过 HttpOnly Cookie 下发，不在响应体暴露',
  })
  @ApiBody({ type: AuthSignInDto })
  @ApiResponse({
    status: 200,
    description: '登录成功，Set-Cookie 下发双 token',
  })
  async signIn(
    // 从请求体中取出登录 dto
    @Body() dto: AuthSignInDto,
    // 从请求中取出 ip 地址
    @Req() { ip }: Request,
    //从响应中取出 response 对象，passthrough 为 true 表示不拦截响应体，直接返回给客户端
    @Res({ passthrough: true }) response: Response,
  ) {
    const { accessToken, refreshToken } = await this.authService.signIn(
      dto,
      ip,
    );
    this.authService.addTokensToResponse(response, refreshToken, accessToken);
    // 响应体不返回 refreshToken：双 httpOnly 后，响应体是 XSS 拿到长效凭证的唯一残留通道
    return { accessToken };
  }

  /**
   * 恢复注销冷静期内的账号：验证原凭据后还原账号并直接登录（Set-Cookie 下发双 token）
   * 登录遇 403 accountDeleted 时，前端展示恢复入口调此接口
   */
  @Post('recoverAccount')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 5 * 60 * 1000 } }) // 与 signIn 同档限流：凭据验证型接口防爆破
  @ApiOperation({
    summary: '恢复注销账号',
    description:
      '注销冷静期内凭原凭据恢复账号并直接登录；超冷静期或已被占用时失败',
  })
  @ApiBody({ type: AuthSignInDto })
  @ApiResponse({
    status: 200,
    description: '恢复成功，Set-Cookie 下发双 token',
  })
  @ApiResponse({
    status: 400,
    description: '账号未注销 / 冷静期已过 / 原用户名或邮箱已被占用',
  })
  @ApiResponse({ status: 401, description: '凭据错误' })
  async recoverAccount(
    @Body() dto: AuthSignInDto,
    @Req() { ip }: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { accessToken, refreshToken } = await this.authService.recoverAccount(
      dto,
      ip,
    );
    this.authService.addTokensToResponse(response, refreshToken, accessToken);
    return { accessToken };
  }

  /** 注册：首个用户自动成为管理员；开启邮箱验证时返回 verificationRequired，激活后才能登录 */
  @Post('signUp')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60 * 60 * 1000 } })
  @ApiOperation({
    summary: '注册',
    description:
      '用户名+邮箱+密码注册；首个用户自动 isAdmin；开启邮箱验证时需激活后才能登录，响应体不返回 refreshToken',
  })
  @ApiBody({ type: AuthSignUpDto })
  @ApiResponse({
    status: 201,
    description: '注册成功；需邮箱验证时返回 { verificationRequired: true }',
  })
  async signUp(
    @Body() dto: AuthSignUpDto,
    @Req() { ip }: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.signUp(dto, ip);
    if ('verificationRequired' in result) {
      return result; // 待激活：不下发任何 token
    }
    this.authService.addTokensToResponse(
      response,
      result.refreshToken,
      result.accessToken,
    );
    // 与 signIn 一致：refreshToken 仅经 Set-Cookie 下发
    return { accessToken: result.accessToken, user: result.user };
  }

  /** 邮箱激活：用户回填邮件中的 6 位验证码（POST body——码绝不出现在 URL） */
  @Post('verifyEmail')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60 * 60 * 1000 } }) // 码空间仅 10^6，接口层限流是防爆破第二道闸
  @ApiOperation({
    summary: '邮箱激活',
    description:
      '凭 (email, 6 位验证码) 激活账号；验证码 10 分钟内有效且一次性，错 5 次锁死',
  })
  @ApiBody({ type: AuthVerifyEmailDto })
  @ApiResponse({ status: 200, description: '激活成功' })
  @ApiResponse({ status: 401, description: '验证码错误/已过期/错误次数超限' })
  async verifyEmail(@Body() dto: AuthVerifyEmailDto) {
    await this.authService.verifyEmail(dto.email, dto.code);
    return { message: this.i18n.t('auth.activationSuccess') };
  }

  /** 重发激活邮件：对外返回一致结果，防止账号枚举 */
  @Post('resendVerification')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } })
  @ApiOperation({
    summary: '重发激活邮件',
    description: '无论邮箱是否存在/是否已激活，均返回一致响应',
  })
  @ApiBody({ type: AuthResendVerificationDto })
  @ApiResponse({ status: 200, description: '固定提示语' })
  async resendVerification(@Body() dto: AuthResendVerificationDto) {
    return this.authService.resendVerification(dto.email);
  }

  /** 请求重置密码：6 位重置验证码发往邮箱（SMTP 接入前走日志投递），10 分钟有效 */
  @Post('requestPasswordReset')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } }) // 敏感入口从严：防刷重置邮件
  @ApiOperation({
    summary: '请求重置密码',
    description:
      '无论邮箱是否存在，均返回一致响应（防账号枚举）；验证码 10 分钟内有效',
  })
  @ApiBody({ type: AuthRequestResetDto })
  @ApiResponse({ status: 200, description: '固定提示语' })
  async requestPasswordReset(@Body() dto: AuthRequestResetDto) {
    return this.authService.requestPasswordReset(dto.email);
  }

  /** 重置密码：凭 (email, 6 位验证码) 设置新密码，并吊销该用户全部会话（踢下线） */
  @Post('resetPassword')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60 * 60 * 1000 } })
  @ApiOperation({
    summary: '重置密码',
    description:
      '凭邮箱 + 6 位重置验证码设置新密码；验证码 10 分钟内有效且一次性，错 5 次锁死；成功后旧会话全部失效，需重新登录',
  })
  @ApiBody({ type: AuthResetPasswordDto })
  @ApiResponse({ status: 200, description: '重置成功' })
  @ApiResponse({ status: 400, description: '重置验证码无效或已过期' })
  @ApiResponse({ status: 401, description: '验证码错误次数超限已锁死' })
  async resetPassword(@Body() dto: AuthResetPasswordDto) {
    return this.authService.resetPassword(dto.email, dto.code, dto.password);
  }

  /** 静默续期：凭 refresh_token cookie 轮换出新双 token（旧 refresh 立即作废） */
  @Post('token')
  @HttpCode(200)
  @ApiOperation({
    summary: '刷新令牌',
    description: '凭 refresh_token cookie 轮换出新双 token（旧即作废）即作废）',
  })
  @ApiUnauthorizedResponse({
    description: '缺少 refresh_token/refresh_token 无效',
  })
  @ApiResponse({
    status: 200,
    description: '刷新成功，返回新accessToken，Set‑Cookie下发新refresh_token',
  })
  async refreshAccessToken(
    // 从请求中取出 request 对象
    @Req() request: Request,
    // 从响应中取出 response 对象，passthrough 为 true 表示不拦截响应体，直接返回给客户端
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!request.cookies?.refresh_token) {
      throw new UnauthorizedException(this.i18n.t('auth.missingRefreshToken'));
    }
    const { accessToken, refreshToken } =
      await this.authService.refreshAccessToken(request.cookies.refresh_token);
    // 轮换出的新 refresh_token 必须随 Set-Cookie 下发，替换浏览器里的旧值
    this.authService.addTokensToResponse(response, refreshToken, accessToken);
    return { accessToken };
  }

  /**
   * 登出：吊销当前 access_token（jti 黑名单）+ 删除当前 refresh 会话 + 清除双 cookie
   * 挂 JwtAuthGuard：user 与 payload 都来自验签后的守卫链，杜绝伪造 access_token 调登出
   */
  @Post('signOut')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: '退出登录',
    description:
      '销毁refresh会话并吊销当前access_token，清除Cookie；需要有效登录态，swagger‑ui无法直接测试',
  })
  @ApiSecurity('JWT')
  @ApiUnauthorizedResponse({ description: '未授权，token无效或缺失' })
  @ApiResponse({ status: 204, description: '登出成功' })
  async signOut(
    @CurrentUser() user: User,
    @GetJwtPayload() payload: JwtPayload,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.authService.signOut(user, payload);
    this.authService.clearTokensFromResponse(response);
  }

  /** 当前登录用户（校验守卫 + cookie 会话的联调入口） */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '获取当前登录用户信息' })
  @ApiSecurity('JWT')
  @ApiUnauthorizedResponse({ description: '未授权，token无效或者缺失' })
  me(@CurrentUser() user: User) {
    // 剔除密码 + 激活/重置凭证及其过期时间，附加 hasPassword 供前端决定是否展示旧密码框
    return this.authService.stripPassword(user);
  }
}
