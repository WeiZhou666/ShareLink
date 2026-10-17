import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import type { User } from '@prisma/client';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { I18nService, I18nContext } from 'nestjs-i18n';
import { Response } from 'express';
import * as argon from 'argon2';
import { randomInt, randomUUID } from 'node:crypto';
import { Logger } from 'winston';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AppConfigService } from '../config/config.service';
import { EmailService } from '../email/email.service';
import { AuthSignInDto } from './dto/auth-sign-in.dto';
import { AuthSignUpDto } from './dto/auth-sign-up.dto';
import type { JwtPayload } from './auth.types';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ACCOUNT_RETENTION_MS,
  AUTH_USER_REVOKE_PREFIX,
} from './auth.constants';

// 有效期约定与旧后端保持一致
const ACCESS_COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 30 * 3; // access_token cookie：3 个月（JWT 本身 15 分钟，靠刷新续期）
const REFRESH_TOKEN_MAX_AGE = 1000 * 60 * 60 * 24 * 30; // refresh 会话：30 天
const REFRESH_COOKIE_PATH = '/api/auth/token'; // refresh_token cookie 仅在刷新接口可见
const ACTIVATION_CODE_TTL_MS = 1000 * 60 * 10; // 邮箱激活验证码有效期：10 分钟（码空间小，必须短命）
const ACTIVATION_CODE_FAIL_PREFIX = 'verify:fail:'; // 激活码错误尝试计数前缀（防爆破计数器）
const ACTIVATION_CODE_MAX_ATTEMPTS = 5; // 单个验证码最多可错 5 次，超限锁死至过期
const RESET_CODE_TTL_MS = 1000 * 60 * 10; // 重置验证码有效期：10 分钟（码空间仅 10^6，必须短命，与激活码同策略）
const RESET_CODE_FAIL_PREFIX = 'reset:fail:'; // 重置验证码错误尝试计数前缀（防爆破计数器）
const RESET_CODE_MAX_ATTEMPTS = 5; // 单个重置验证码最多可错 5 次，超限锁死至过期

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private redis: RedisService,
    // I18nService（@Global 注入）：面向用户的 HTTP 消息走翻译 key，运维日志保持中文
    private i18n: I18nService,
    // EmailService（@Global 注入）：激活码/重置邮件统一投递出口（log|smtp 双模式）
    private email: EmailService,
    // AppConfigService（@Global 注入）：应用配置三层取值（yaml > DB > 代码清单默认值）
    private config: AppConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /** 邮箱或用户名 + 密码登录，成功返回双 token */
  async signIn(dto: AuthSignInDto, ip?: string) {
    if (!dto.email && !dto.username) {
      throw new BadRequestException(
        this.i18n.t('auth.emailOrUsernameRequired'),
      );
    }
    // 邮箱或用户名二选一 + 密码
    // 动态构造OR数组，防止undefined产生空条件
    const orArr: Array<{ email: string } | { username: string }> = [];
    if (dto.email != null) {
      //trim() 去掉邮箱或用户名首尾空格，
      //toLowerCase() 转换为小写，确保大小写不敏感
      const email = dto.email.trim().toLowerCase();
      orArr.push({ email });
    }
    if (dto.username != null) {
      const username = dto.username.trim();
      orArr.push({ username });
    }
    // findFirst() 查找第一个匹配的用户；
    // 软删用户的 username/email 原值保留（占名防冒充，见 users.service 注销注释），
    // 原凭据直接可查，无需额外兜底——命中软删行走下方 deletedAt 拦截展示恢复入口
    const user = await this.prisma.user.findFirst({
      where: { OR: orArr },
    });

    if (!user?.password || !(await argon.verify(user.password, dto.password))) {
      this.logger.warn(`登录失败：${dto.email ?? dto.username} 来自 ${ip}`, {
        context: AuthService.name,
      });
      throw new UnauthorizedException(this.i18n.t('auth.wrongCredentials'));
    }

    // 未激活账号禁止登录（放在密码校验之后，避免未持密码者探测账号激活状态）
    if (!user.isActivated) {
      this.logger.warn(`登录失败：邮箱未激活：${user.email} 来自 ${ip}`, {
        context: AuthService.name,
      });
      throw new UnauthorizedException(this.i18n.t('auth.accountNotActivated'));
    }

    // 已注销（软删冷静期）账号禁止登录：放在密码校验之后防探测；
    // 对象形态异常 → 过滤器整体展开出 error 错误码，前端凭 error === "account_deleted" 展示恢复入口
    if (user.deletedAt) {
      this.logger.warn(
        `登录失败：账号已注销（软删冷静期）：${user.email} 来自 ${ip}`,
        { context: AuthService.name },
      );
      throw new ForbiddenException({
        message: this.i18n.t('auth.accountDeleted'),
        error: 'account_deleted',
      });
    }

    this.logger.info(`登录成功：${user.email ?? user.username} 来自 ${ip}`, {
      context: AuthService.name,
    });
    return this.generateToken(user);
  }

  /**
   * 恢复注销冷静期内的账号：验原凭据（密码）→ 清软删标记 → 直接发新会话
   *
   * 安全与边界：
   * - 凭据错误统一 wrongCredentials（不区分"不存在/密码错"，防枚举）
   * - 未注销的正常账号调此接口 → 400 提示直接登录（不返回会话，避免混淆两条链路）
   * - 超过冷静期（jobs 尚未跑到的一小段窗口）→ 400 不可恢复
   * - 软删期间 username/email 原值一直占着 unique 索引（占名防冒充），
   *   恢复 = 只清 deletedAt 一行 UPDATE，无键冲突可能（物理删后名字才释放）
   */
  async recoverAccount(dto: AuthSignInDto, ip?: string) {
    if (!dto.email && !dto.username) {
      throw new BadRequestException(
        this.i18n.t('auth.emailOrUsernameRequired'),
      );
    }
    const orArr: Array<{ email: string } | { username: string }> = [];
    if (dto.email != null) {
      orArr.push({ email: dto.email.trim().toLowerCase() });
    }
    if (dto.username != null) {
      orArr.push({ username: dto.username.trim() });
    }
    // 原凭据直接可查（占名方案无改写）；查不到 = 账号不存在或已被物理清
    const user = await this.prisma.user.findFirst({
      where: { OR: orArr },
    });

    if (!user?.password || !(await argon.verify(user.password, dto.password))) {
      this.logger.warn(
        `账号恢复失败：${dto.email ?? dto.username} 来自 ${ip}`,
        { context: AuthService.name },
      );
      throw new UnauthorizedException(this.i18n.t('auth.wrongCredentials'));
    }

    // 未注销账号：引导走正常登录
    if (!user.deletedAt) {
      throw new BadRequestException(this.i18n.t('auth.accountNotDeleted'));
    }

    // 冷静期已过（jobs.deleteSoftDeletedUsers 每天凌晨跑，此处兜住间隙窗口）
    if (Date.now() - user.deletedAt.getTime() >= ACCOUNT_RETENTION_MS) {
      throw new BadRequestException(this.i18n.t('auth.accountDeleted'));
    }

    // 恢复 = 清软删标记（username/email 原值从未被动过，无需还原）
    const restored = await this.prisma.user.update({
      where: { id: user.id },
      data: { deletedAt: null },
    });
    this.logger.info(
      `账号恢复成功：${restored.email}（${user.id}）来自 ${ip}`,
      { context: AuthService.name },
    );
    // 直接发新会话：恢复即登录，前端免二次输入
    return this.generateToken(restored);
  }

  /**
   * 注册：首个用户自动 isAdmin；开启 ENABLE_EMAIL_VERIFICATION 时需邮箱激活后才能登录
   * 邮件投递交给 EmailService（MAIL_DELIVERY=log|smtp），发送失败 fail-open 不阻断注册
   */
  async signUp(dto: AuthSignUpDto, ip?: string) {
    const isFirstUser = (await this.prisma.user.count()) === 0;
    // 邮箱统一小写落库，与 signIn 的小写查询匹配
    const email = dto.email.trim().toLowerCase();
    // 邮箱验证开关已迁入配置体系（DB 可改 / config.yaml 可覆盖），替代旧 env ENABLE_EMAIL_VERIFICATION
    const needsVerification =
      !isFirstUser &&
      (await this.config.getBoolean('security.enableEmailVerification'));

    try {
      const user = await this.prisma.user.create({
        data: {
          email,
          username: dto.username.trim(),
          password: await argon.hash(dto.password),
          isAdmin: isFirstUser,
          isActivated: !needsVerification,
          // 6 位数字码：randomInt 密码学安全随机；码空间仅 10^6，安全性由"短过期 + 尝试限制 + 限流"保障
          activationToken: needsVerification
            ? String(randomInt(100000, 1000000))
            : null,
          activationTokenExpiresAt: needsVerification
            ? new Date(Date.now() + ACTIVATION_CODE_TTL_MS)
            : null,
        },
      });

      if (user.activationToken) {
        // 邮件语言跟随注册请求（?lang / Accept-Language）；void fire-and-forget：SMTP 往返不拖慢注册响应，
        // 发送失败由 EmailService 内部 catch + warn（验证码已落库，可重发）
        void this.email.sendActivationCode(
          user.email,
          user.activationToken,
          I18nContext.current()?.lang,
        );
        return { verificationRequired: true as const };
      }

      this.logger.info(`注册成功：${user.email} 来自 ${ip}`, {
        context: AuthService.name,
      });
      const { accessToken, refreshToken } = await this.generateToken(user);
      return { accessToken, refreshToken, user: this.stripPassword(user) };
    } catch (e) {
      // 唯一约束冲突：邮箱或用户名已存在
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(this.i18n.t('auth.userAlreadyExists'));
      }
      throw e;
    }
  }

  /**
   * 邮箱激活：凭 (email, 6 位验证码) 激活账号（一次性、10 分钟有效）
   * 防爆破三件套：码短命（10 分钟）+ 错 5 次锁死（Redis 原子计数，TTL 对齐码寿命）+ 接口层 @Throttle。
   * 链接方案的安全性靠 uuid 的 2^122 熵；换成 10^6 的小码空间后，安全责任转移到频控——这是两种方案的本质差异
   */
  async verifyEmail(email: string, code: string) {
    const normalized = email.trim().toLowerCase();
    const failKey = `${ACTIVATION_CODE_FAIL_PREFIX}${normalized}`;
    // 先查锁：失败次数已达上限则拒绝（即使码正确——防止爆破者用"撞对的那一次"通过）
    const fails = await this.redis.get(failKey);
    if (fails !== null && Number(fails) >= ACTIVATION_CODE_MAX_ATTEMPTS) {
      throw new UnauthorizedException(
        this.i18n.t('auth.tooManyVerifyAttempts'),
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
    });
    const valid =
      user?.activationToken === code &&
      user.activationTokenExpiresAt !== null &&
      user.activationTokenExpiresAt > new Date();
    if (!user || !valid) {
      // 原子自增失败计数（TTL=10 分钟，与码同生命周期：换码/过期后计数自然作废）
      const count = await this.redis.incrWithTtl(
        failKey,
        ACTIVATION_CODE_TTL_MS / 1000,
      );
      if (count !== null && count >= ACTIVATION_CODE_MAX_ATTEMPTS) {
        this.logger.warn(`激活验证码错误次数超限，已锁死：${normalized}`, {
          context: AuthService.name,
        });
      }
      throw new UnauthorizedException(this.i18n.t('auth.invalidOrExpiredCode'));
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isActivated: true,
        activationToken: null,
        activationTokenExpiresAt: null,
      },
    });
    await this.redis.set(failKey, '0', 1).catch(() => undefined); // 激活成功即清计数（set 0 立即过期等价于删除）
    this.logger.info(`邮箱激活成功（验证码）：${user.email}`, {
      context: AuthService.name,
    });
  }

  /** 重发激活邮件：无论邮箱是否存在/是否已激活，对外返回一致结果，防止账号枚举 */
  async resendVerification(email: string) {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
    });
    if (user && !user.isActivated) {
      // 轮换新码（旧的立即作废）+ 清空失败计数——用户换到新码后应获得完整的 5 次尝试机会
      const activationToken = String(randomInt(100000, 1000000));
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          activationToken,
          activationTokenExpiresAt: new Date(
            Date.now() + ACTIVATION_CODE_TTL_MS,
          ),
        },
      });
      await this.redis
        .set(`${ACTIVATION_CODE_FAIL_PREFIX}${normalized}`, '0', 1)
        .catch(() => undefined);
      void this.email.sendActivationCode(
        user.email,
        activationToken,
        I18nContext.current()?.lang,
      );
    }
    return { message: this.i18n.t('auth.resendVerificationSent') };
  }

  /**
   * 请求重置密码：生成 10 分钟有效的 6 位重置验证码（重发即轮换旧的，同一时刻至多一个有效）
   * 无论邮箱是否存在都返回同一话术——防止攻击者靠响应差异枚举已注册邮箱。
   * 验证码方案（而非 uuid 链接）：邮件里没有 URL，不受邮件商安全跳转拦截/预扫描消费影响，跨设备体验也好；
   * 码空间 10^6 的安全性由「短命 + 错 5 次锁死 + 限流」保障（与激活码同策略）
   */
  async requestPasswordReset(email: string) {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
    });
    if (user) {
      const resetPasswordToken = String(randomInt(100000, 1000000));
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          resetPasswordToken,
          resetPasswordTokenExpiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
        },
      });
      void this.email.sendResetCode(
        user.email,
        resetPasswordToken,
        I18nContext.current()?.lang,
      );
    }
    return { message: this.i18n.t('auth.resetEmailSent') };
  }

  /**
   * 重置密码：凭 (email, 6 位验证码) 设置新密码，并吊销该用户全部会话（踢下线）
   * 重置密码多半因为疑似被盗——只改密码不吊销会话，盗号者手里已签发的 access_token 仍能用到自然过期。
   * 防爆破与激活码同构：先查锁（错 5 次锁死至过期），失败原子计数（TTL 与码同生命周期），成功清计数
   */
  async resetPassword(email: string, code: string, newPassword: string) {
    const normalized = email.trim().toLowerCase();
    const failKey = `${RESET_CODE_FAIL_PREFIX}${normalized}`;
    const fails = await this.redis.get(failKey);
    if (fails !== null && Number(fails) >= RESET_CODE_MAX_ATTEMPTS) {
      throw new UnauthorizedException(this.i18n.t('auth.tooManyResetAttempts'));
    }
    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
    });
    const valid =
      user?.resetPasswordToken === code &&
      user.resetPasswordTokenExpiresAt !== null &&
      user.resetPasswordTokenExpiresAt > new Date();
    if (!user || !valid) {
      const count = await this.redis.incrWithTtl(
        failKey,
        RESET_CODE_TTL_MS / 1000,
      );
      if (count !== null && count >= RESET_CODE_MAX_ATTEMPTS) {
        this.logger.warn(`重置验证码错误次数超限，已锁死：${normalized}`, {
          context: AuthService.name,
        });
      }
      throw new BadRequestException(
        this.i18n.t('auth.invalidOrExpiredResetToken'),
      );
    }
    // argon2id 哈希后写入，同时清空重置验证码（一次性：重放此请求因验证码已清而失效）
    const password = await argon.hash(newPassword);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password,
        resetPasswordToken: null,
        resetPasswordTokenExpiresAt: null,
      },
    });
    await this.redis.set(failKey, '0', 1).catch(() => undefined); // 重置成功即清计数
    // 踢下线：写用户级吊销键（Redis，TTL=15min 覆盖旧 access 剩余寿命）+ 删除全部 refresh 会话
    await this.revokeAllUserTokens(user.id);
    this.logger.warn(`密码已重置并吊销全部会话：${user.email}`, {
      context: AuthService.name,
    });
    return { message: this.i18n.t('auth.resetPasswordSuccess') };
  }

  /**
   * 剔除敏感字段（响应给前端的用户对象）：
   * password 之外，激活/重置 token 及其过期时间也绝不允许出现在任何 API 响应里——
   * 否则用户请求重置后马上查询个人信息，重置 token 就经响应体泄漏（重置密码 = 接管账号）
   */
  // 响应安全形态：密码 + 激活/重置凭证及其过期时间不出响应体；hasPassword 供前端决定是否展示旧密码框
  // （me 端点与 users 模块也复用，故公开）
  stripPassword(user: User) {
    const {
      password: _password,
      activationToken: _activationToken,
      activationTokenExpiresAt: _activationTokenExpiresAt,
      resetPasswordToken: _resetPasswordToken,
      resetPasswordTokenExpiresAt: _resetPasswordTokenExpiresAt,
      ...safe
    } = user;
    return { ...safe, hasPassword: user.password !== null };
  }

  /** 创建 refresh 会话记录并签发 access JWT */
  async generateToken(user: User) {
    const { id, token } = await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE),
      },
    });
    const accessToken = await this.createAccessToken(user, id);
    return { accessToken, refreshToken: token };
  }

  /** access JWT：payload 携带 sub/email/isAdmin/refreshTokenId/jti，15 分钟过期 */
  async createAccessToken(user: User, refreshTokenId: string) {
    return this.jwtService.sign({
      sub: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      refreshTokenId,
      // jti：token 唯一标识，登出时据此写入 Redis 黑名单实现即时吊销
      jti: randomUUID(),
    });
  }

  /**
   * 凭 refresh_token 换发双 token（轮换机制）：
   * 每次刷新作废旧会话（保留 revokedAt 行用于重用检测）并签发新 refresh_token，会话滑动续期
   * 重用检测：已作废的旧 token 再次出现 → 疑似 cookie 被盗，吊销该用户全部会话
   */
  async refreshAccessToken(refreshToken: string) {
    const session = await this.prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      //关联查询，把外键对应的 user 一并查出来
      include: { user: true },
    });

    if (!session) {
      this.logger.warn('刷新失败：refresh_token 不存在（伪造或已被清理）', {
        context: AuthService.name,
      });
      throw new UnauthorizedException(this.i18n.t('auth.sessionNotFound'));
    }
    // 检查是否已作废
    if (session.revokedAt) {
      const { count } = await this.prisma.refreshToken.deleteMany({
        where: { userId: session.userId },
      });
      this.logger.warn(
        `refresh_token 重用（疑似被盗）：用户 ${session.user.email}（${session.userId}），已吊销其全部会话（${count} 个）`,
        { context: AuthService.name },
      );
      throw new UnauthorizedException(this.i18n.t('auth.sessionReuseDetected'));
    }

    if (session.expiresAt < new Date()) {
      await this.prisma.refreshToken
        .delete({ where: { id: session.id } })
        .catch(() => undefined);
      this.logger.warn(`刷新失败：会话已过期：${session.user.email}`, {
        context: AuthService.name,
      });
      throw new UnauthorizedException(this.i18n.t('auth.sessionExpired'));
    }

    // 轮换：事务内"旧会话标记作废 + 创建新会话"，避免并发刷新产生双活会话
    const { id, token } = await this.prisma.$transaction(async (tx) => {
      //更新旧会话为已废状态
      await tx.refreshToken.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      // 创建新会话
      return tx.refreshToken.create({
        data: {
          userId: session.userId,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE),
        },
      });
    });
    // 签发新 access_token
    const accessToken = await this.createAccessToken(session.user, id);
    this.logger.info(`token 轮换成功：${session.user.email}，旧会话已作废`, {
      context: AuthService.name,
    });
    return { accessToken, refreshToken: token };
  }

  /**
   * 登出：access 的 jti 入 Redis 黑名单（立即失效）+ 删除当前 refresh 会话
   * 入参只信任验签后的结果：user 来自 JwtAuthGuard 查库缓存（req.currentUser），payload 来自 req.user（JwtStrategy 验签后挂载）
   * —— 不再使用不验签的 jwtService.decode，杜绝伪造 payload 删他人会话/灌黑名单
   */
  async signOut(user: User, payload: JwtPayload) {
    if (payload.jti && payload.exp) {
      // access_token 即时吊销：TTL = 剩余寿命，过期后键自动清理（黑名单上限 15 分钟）
      const remainingMs = payload.exp * 1000 - Date.now();
      if (remainingMs > 0) {
        await this.redis.setBlackList(payload.jti, remainingMs / 1000);
      }
    }
    if (payload.refreshTokenId) {
      await this.prisma.refreshToken
        // 双重范围限定（id + userId）：纵深防御，即便字段异常也越不了权删他人会话
        .delete({ where: { id: payload.refreshTokenId, userId: user.id } })
        .catch(() => undefined); // 会话不存在（P2025）时静默忽略
      this.logger.info(
        `登出：用户 ${user.email}（${user.id}），会话 ${payload.refreshTokenId} 已删除`,
        { context: AuthService.name },
      );
    }
  }

  /**
   * 用户级吊销（封禁/修改密码/管理员强制下线时调用）：
   * 设吊销时间戳键（TTL = access 最长寿命），使该用户此刻之前签发的所有 access_token 立即失效，
   * 同时清除其全部 refresh 会话
   */
  async revokeAllUserTokens(userId: string) {
    // 吊销键：值为吊销时间戳（毫秒），TTL = access 最长寿命（15 分钟），过后旧 token 已全部自然过期
    await this.redis.set(
      `${AUTH_USER_REVOKE_PREFIX}${userId}`,
      String(Date.now()),
      ACCESS_TOKEN_TTL_SECONDS,
    );
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { userId },
    });
    this.logger.warn(
      `用户级吊销：用户 ${userId}，已清除 ${count} 个 refresh 会话`,
      { context: AuthService.name },
    );
    return count;
  }

  /** 双 token 写入 cookie，属性与旧后端一致 */
  addTokensToResponse(
    response: Response,
    refreshToken?: string,
    accessToken?: string,
  ) {
    const isSecure = process.env.COOKIE_SECURE === 'true';
    if (accessToken) {
      response.cookie('access_token', accessToken, {
        // `sameSite: 'lax'`：普通页面请求带上 cookie；跨站 POST 不会带。
        // **没有指定 path，默认 `/`，全站生效**
        sameSite: 'lax',
        //secure: true：仅通过 HTTPS 传输，防止明文泄露
        secure: isSecure,
        maxAge: ACCESS_COOKIE_MAX_AGE,
        httpOnly: true,
      });
    }
    if (refreshToken) {
      response.cookie('refresh_token', refreshToken, {
        path: REFRESH_COOKIE_PATH,
        httpOnly: true,
        //sameSite: 'strict'：跨站任何场景都不会携带 refresh_token，防护 CSRF
        sameSite: 'strict',
        //secure: true：仅通过 HTTPS 传输，防止明文泄露
        secure: isSecure,
        maxAge: REFRESH_TOKEN_MAX_AGE,
      });
    }
  }

  /** 清除双 cookie（maxAge 置 -1 立即失效），用于登出；属性与 set 侧保持镜像 */
  clearTokensFromResponse(response: Response) {
    const isSecure = process.env.COOKIE_SECURE === 'true';
    response.cookie('access_token', '', {
      maxAge: -1,
      secure: isSecure,
      httpOnly: true,
    });
    response.cookie('refresh_token', '', {
      path: REFRESH_COOKIE_PATH,
      httpOnly: true,
      maxAge: -1,
      secure: isSecure,
    });
  }
}
