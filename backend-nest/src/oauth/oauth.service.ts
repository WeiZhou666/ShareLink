import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { I18nService } from 'nestjs-i18n';
import { User } from '@prisma/client';
import { Logger } from 'winston';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { RedisService } from '../redis/redis.service';
import {
  OAuthProfile,
  OAuthProvider,
} from './provider/oauth-provider.interface';
import { GithubProvider } from './provider/github.provider';
import { LocalOidcProvider } from './provider/local-oidc.provider';
import { GenericOidcProvider } from './provider/generic-oidc.provider';

/** state 键前缀：oauth:state:{provider}:{state}，5 分钟一次性（回调 getDel） */
const STATE_TTL_SECONDS = 300;

@Injectable()
export class OAuthService {
  /** 已注册的提供商表：controller 按 name 路由到对应 provider */
  private readonly providers: Map<string, OAuthProvider>;

  constructor(
    github: GithubProvider,
    local: LocalOidcProvider,
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly redis: RedisService,
    private readonly i18n: I18nService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    // 新增 IdP 时在此追加一行，controller/service 其余逻辑零改动
    this.providers = new Map<string, OAuthProvider>([
      ['github', github], // GitHub OAuth（标准 OAuth2 + REST API，非 OIDC）
      ['local', local], // 本地 mock/自建 OIDC（scripts/mock-oidp.mjs 或 Keycloak）
    ]);
  }

  /** STEP 1：生成授权页 URL（controller 302 跳转）。state 本服务统一管理（防 Login CSRF） */
  async createLoginUrl(providerName: string): Promise<string> {
    const provider = this.getProvider(providerName);
    const state = crypto.randomUUID();
    await this.redis.set(
      `oauth:state:${providerName}:${state}`,
      '1',
      STATE_TTL_SECONDS,
    );
    return provider.buildAuthUrl(state);
  }

  /** STEP 3-5：回调编排——state 校验 → 换 token → 取身份 → findOrCreate → 签发本系统会话 */
  async handleCallback(providerName: string, code?: string, state?: string) {
    const profile = await this.resolveProfile(providerName, code, state);
    const user = await this.findOrCreateUser(profile);

    // 汇合点：与 signIn/signUp 同一个出口，refresh 轮换/黑名单/登出/定时清理全部自动生效
    const { accessToken, refreshToken } =
      await this.authService.generateToken(user);
    this.logger.info(
      `OAuth 登录成功：${profile.provider}:${profile.providerId} -> user ${user.id}`,
      { context: OAuthService.name },
    );
    return { user, accessToken, refreshToken };
  }

  /**
   * 已登录用户绑定第三方身份（微信等无邮箱提供商的唯一入账途径）。
   * 幂等：重复绑同一身份直接成功；冲突：该外部身份已被其他账号占用则 409
   */
  async bind(
    providerName: string,
    code: string | undefined,
    state: string | undefined,
    userId: string,
  ) {
    const profile = await this.resolveProfile(providerName, code, state);
    const existing = await this.prisma.userIdentity.findUnique({
      where: {
        provider_providerId: {
          provider: profile.provider,
          providerId: profile.providerId,
        },
      },
    });
    if (existing) {
      if (existing.userId === userId) return { bound: true, already: true };
      throw new ConflictException(this.i18n.t('oauth.identityAlreadyBound'));
    }
    await this.prisma.userIdentity.create({
      data: {
        provider: profile.provider,
        providerId: profile.providerId,
        userId,
      },
    });
    this.logger.info(
      `OAuth 绑定成功：${profile.provider}:${profile.providerId} -> user ${userId}`,
      { context: OAuthService.name },
    );
    return { bound: true, already: false };
  }

  /** 公共前段：state 一次性校验 → code 换 token → 标准化用户资料 */
  private async resolveProfile(
    providerName: string,
    code?: string,
    state?: string,
  ): Promise<OAuthProfile> {
    const provider = this.getProvider(providerName);

    // state 防伪：必须存在且一次性（原子 getDel），否则可能是伪造回调（Login CSRF）
    if (
      !code ||
      !state ||
      !(await this.redis.getDel(`oauth:state:${providerName}:${state}`))
    ) {
      throw new UnauthorizedException(
        this.i18n.t('oauth.invalidOrExpiredState'),
      );
    }

    const token = await provider.exchangeCode(code);
    return provider.fetchProfile(token, state);
  }

  /**
   * 身份关联（UserIdentity 表）：找到绑定直接登录；找不到走自动注册或明确拒绝。
   * 两条铁律：绝不按 email 认领已有账号（防接管）；自动注册只创建新账号
   */
  private async findOrCreateUser(profile: OAuthProfile): Promise<User> {
    // ① 已绑定：外部身份 -> 本地用户，直接登录（email 变更不影响关联，sub 永不变）
    const identity = await this.prisma.userIdentity.findUnique({
      where: {
        provider_providerId: {
          provider: profile.provider,
          providerId: profile.providerId,
        },
      },
      include: { user: true },
    });
    if (identity) return identity.user;

    // ② 未绑定：自动注册的前提是"提供商已验证邮箱"——否则无法确认邮箱归属，拒绝（如微信场景应走手动绑定）
    if (profile.emailVerified !== true || !profile.email) {
      throw new UnauthorizedException(
        this.i18n.t('oauth.providerEmailNotVerified'),
      );
    }
    const email = profile.email.trim().toLowerCase();

    // ③ 邮箱已被本地账号占用：明确拒绝而非静默认领——认领 = 账号接管漏洞
    const emailOwner = await this.prisma.user.findUnique({ where: { email } });
    if (emailOwner) {
      throw new ConflictException(this.i18n.t('oauth.emailAlreadyTaken'));
    }

    // ④ 自动注册：全新账号（isActivated=true——邮箱已经 IdP 验证，跳过邮件激活）
    const username = await this.uniqueUsername(profile.username);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            username,
            email,
            password: null, // 第三方注册的用户没有本系统密码
            isAdmin: profile.isAdmin ?? false,
            isActivated: true,
          },
        });
        await tx.userIdentity.create({
          data: {
            provider: profile.provider,
            providerId: profile.providerId,
            userId: user.id,
          },
        });
        return user;
      });
    } catch (err) {
      // 并发回调下的兜底：唯一约束冲突（provider+providerId / username / email）统一 409
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(this.i18n.t('oauth.accountAlreadyExists'));
      }
      throw err;
    }
  }

  /** 用户名去重：与现有用户冲突时追加随机后缀（preferred_username 在 IdP 间极易撞名） */
  private async uniqueUsername(base: string): Promise<string> {
    let candidate = base.slice(0, 30);
    for (let i = 0; i < 3; i++) {
      if (
        !(await this.prisma.user.findUnique({ where: { username: candidate } }))
      )
        return candidate;
      candidate = `${base.slice(0, 25)}.${crypto.randomUUID().slice(0, 4)}`;
    }
    return `${base.slice(0, 20)}.${crypto.randomUUID().slice(0, 8)}`; // 兜底必唯一
  }

  private getProvider(name: string) {
    const provider = this.providers.get(name);
    if (!provider)
      throw new NotFoundException(
        this.i18n.t('oauth.unsupportedProvider', { args: { name } }),
      );
    return provider;
  }
}
