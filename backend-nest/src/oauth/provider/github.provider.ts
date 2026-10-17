import {
  BadGatewayException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { I18nService } from 'nestjs-i18n';
import { Logger } from 'winston';
import {
  OAuthProfile,
  OAuthProvider,
  OAuthToken,
} from './oauth-provider.interface';

/**
 * GitHub OAuth（OAuth App：标准 OAuth 2.0 授权码模式 + REST API）。
 *
 * 与 OIDC 的差异（为什么继承不了 GenericOidcProvider）：
 *  - 无发现文档、无 JWKS、无 ID Token——身份资料凭 access_token 调 REST API 获取
 *  - token 端点固定 POST /login/oauth/access_token，必须带 Accept: application/json
 *    （否则 GitHub 返回 query string 而非 JSON）
 *  - GitHub API 强制要求 User-Agent 头，缺失直接 403
 *
 * 身份标识：providerId = 数字 id（GitHub 保证不变；login 用户名可改名）——
 * 符合"提供商保证不变的不可变标识"铁律。
 * 邮箱：scope 含 user:email 时 /user/emails 才可见；只认 primary && verified 的邮箱
 * （GitHub 邮箱可自填，未验证邮箱不能作为信任依据）。拿不到 → emailVerified 保持
 * undefined → OAuthService 据此走"手动绑定"分支（绝不编造邮箱）
 */
@Injectable()
export class GithubProvider implements OAuthProvider {
  readonly name = 'github';

  private readonly clientId = process.env.OAUTH_GITHUB_CLIENT_ID ?? '';
  private readonly clientSecret = process.env.OAUTH_GITHUB_CLIENT_SECRET ?? '';
  // 端点基址 env 可覆盖：本地 mock 回归与代理场景用，生产默认官方域名
  private readonly authBase =
    process.env.OAUTH_GITHUB_AUTH_BASE ?? 'https://github.com';
  private readonly apiBase =
    process.env.OAUTH_GITHUB_API_BASE ?? 'https://api.github.com';

  constructor(
    private readonly i18n: I18nService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /** STEP 1：GitHub 授权页地址（scope：读基本资料 + 邮箱） */
  async buildAuthUrl(state: string): Promise<string> {
    this.assertConfigured();
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state, // 防 Login CSRF：与 OIDC 同一套 service 管理的一次性 state
      scope: 'read:user user:email',
      allow_signup: 'true',
    });
    return `${this.authBase}/login/oauth/authorize?${params.toString()}`;
  }

  /** STEP 4a：code 换 token——业务失败时响应体带 error 字段（HTTP 仍 200） */
  async exchangeCode(code: string): Promise<OAuthToken> {
    this.assertConfigured();
    const raw = await this.postJson(
      `${this.authBase}/login/oauth/access_token`,
      {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.redirectUri,
      },
    );
    if (raw.error) {
      this.logger.warn(`GitHub token 交换失败：error=${raw.error}`, {
        context: GithubProvider.name,
      });
      throw new UnauthorizedException(this.i18n.t('oauth.githubAuthFailed'));
    }
    return { accessToken: raw.access_token as string, raw };
  }

  /** STEP 4b：拉用户资料——凭 access_token 调 REST API（无 id_token 验签环节） */
  async fetchProfile(token: OAuthToken): Promise<OAuthProfile> {
    const user = (await this.getJson(
      `${this.apiBase}/user`,
      token.accessToken,
    )) as Record<string, unknown>;
    // /user/emails 拿不到（scope 不足/邮箱私有）不阻塞登录——邮箱信任决策交给编排层
    const emails = await this.getJson(
      `${this.apiBase}/user/emails`,
      token.accessToken,
    ).catch(() => []);
    const primary = Array.isArray(emails)
      ? emails.find(
          (e) =>
            (e as { primary?: boolean }).primary &&
            (e as { verified?: boolean }).verified,
        )
      : undefined;
    const verifiedEmail = primary
      ? (primary as { email: string }).email
      : undefined;
    return {
      provider: this.name,
      providerId: String(user.id), // 数字 id 永不改变（login 可改名）
      email: verifiedEmail,
      emailVerified: verifiedEmail ? true : undefined,
      username: (user.login as string) || `gh_${String(user.id).slice(-8)}`,
    };
  }

  private get redirectUri(): string {
    return `${process.env.APP_URL || 'http://localhost:3000'}/api/oauth/${this.name}/callback`;
  }

  private assertConfigured(): void {
    if (!this.clientId || !this.clientSecret) {
      throw new InternalServerErrorException(
        this.i18n.t('oauth.githubNotConfigured', {
          args: { env: 'OAUTH_GITHUB_CLIENT_ID / OAUTH_GITHUB_CLIENT_SECRET' },
        }),
      );
    }
  }

  /** GitHub API 统一 GET：User-Agent 必填（缺失 403），Bearer 鉴权 */
  private async getJson(url: string, accessToken?: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ShareLink-OAuth',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
      });
    } catch (err) {
      throw new BadGatewayException(
        this.i18n.t('oauth.githubUnreachable', {
          args: { message: (err as Error).message },
        }),
      );
    }
    if (!res.ok)
      throw new BadGatewayException(
        this.i18n.t('oauth.githubApiError', { args: { status: res.status } }),
      );
    return res.json();
  }

  /** token 端点统一 POST（Accept: application/json 才返回 JSON） */
  private async postJson(
    url: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'ShareLink-OAuth',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new BadGatewayException(
        this.i18n.t('oauth.githubUnreachable', {
          args: { message: (err as Error).message },
        }),
      );
    }
    if (!res.ok)
      throw new BadGatewayException(
        this.i18n.t('oauth.githubApiError', { args: { status: res.status } }),
      );
    return (await res.json()) as Record<string, unknown>;
  }
}
