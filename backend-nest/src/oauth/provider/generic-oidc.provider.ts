import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as jmespath from 'jmespath';
import { I18nService } from 'nestjs-i18n';
import { Logger } from 'winston';
import { RedisService } from '../../redis/redis.service';
import { OAuthProfile, OAuthToken } from './oauth-provider.interface';

/** OIDC 发现文档（/.well-known/openid-configuration）中本流程用到的端点 */
interface DiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** 角色映射配置：用 jmespath 从 ID Token 里按配置路径提取角色列表，命中即管理员 */
interface RoleConfig {
  path: string; // 如 "roles" 或 "resource_access.my-client.roles"
  adminAccess: string[]; // 视为管理员的组名
}

/**
 * GenericOidcProvider —— 任何标准 OIDC 提供商的通用实现（迁移自旧后端，两处手术）：
 *  1. 验签：旧版 decodeIdToken 只 base64 解码不验签（JWKS 拉了没用）；
 *     本版用 jose 的 jwtVerify 走真验签——签名（JWKS 公钥）/iss/aud/exp 一步完成，
 *     jose 的 createRemoteJwkSet 内部自带 JWKS 缓存与轮换，无需手写缓存
 *  2. nonce 存取：cache-manager → 项目统一 RedisService（GETDEL 原子一次性）
 * 保留旧版设计：发现文档按 Expires 头缓存、sub 做身份标识、email_verified=false 拒绝、jmespath 角色映射
 */
@Injectable()
export abstract class GenericOidcProvider {
  abstract readonly name: string;

  // ---- 依赖与配置由子类在构造中赋值（父类不写 constructor：
  //      Nest 按构造参数反射注入，父类构造里的 string 配置会被当成依赖导致 DI 失败） ----
  protected redis!: RedisService;
  protected logger!: Logger;
  protected i18n!: I18nService; // 子类构造注入后赋值（父类不写 constructor，避免 Nest DI 反射坑）
  protected abstract readonly issuerUri: string;
  protected abstract readonly clientId: string;
  protected abstract readonly clientSecret: string;

  /** 发现文档内存缓存：避免每次请求都打 IdP；过期时间取响应 Expires 头，缺省 24h */
  private discovery?: { doc: DiscoveryDocument; expiresAt: number };

  /** jose JWKS 客户端：实例级懒缓存（createRemoteJWKSet 内部自带公钥缓存与轮换，不能每请求重建） */
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  /** 角色映射配置（可选）：如 Keycloak 从 token 的 roles claim 提取管理员组；Google 不启用 */
  protected roleConfig?: RoleConfig;

  // ---------- STEP 1：生成授权页 URL（浏览器 302 跳转目标） ----------

  async buildAuthUrl(state: string): Promise<string> {
    const doc = await this.fetchDiscovery();
    // nonce：防 ID Token 重放。发起时生成存 Redis（5 分钟），回调验签后必须逐一匹配
    const nonce = crypto.randomUUID();
    await this.redis.set(`oauth:nonce:${this.name}:${state}`, nonce, 300);

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      state, // 防 Login CSRF：发起时种入，回调时由 OAuthService 校验一次性
      nonce,
    });
    return `${doc.authorization_endpoint}?${params.toString()}`;
  }

  // ---------- STEP 4a：授权码换 token（后端对 token endpoint，机密客户端） ----------

  async exchangeCode(code: string): Promise<OAuthToken> {
    const doc = await this.fetchDiscovery();
    const res = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    // 旧版无 res.ok 检查，IdP 报错时会抛出难懂的 JSON parse 错误——这里给出可读的 502
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(
        `OIDC token endpoint 失败：${this.name} HTTP ${res.status} - ${body.slice(0, 300)}`,
        { context: GenericOidcProvider.name },
      );
      throw new BadGatewayException(this.i18n.t('oauth.tokenExchangeFailed'));
    }
    const raw = (await res.json()) as Record<string, unknown>;
    return {
      accessToken: raw.access_token as string,
      idToken: raw.id_token as string,
      raw,
    };
  }

  // ---------- STEP 4b：验签 ID Token → 标准化用户资料 ----------

  async fetchProfile(token: OAuthToken, state: string): Promise<OAuthProfile> {
    if (!token.idToken)
      throw new UnauthorizedException(this.i18n.t('oauth.missingIdToken'));
    // jose 验签：签名（自动按 kid 匹配 JWKS 公钥，内部缓存+轮换）+ iss + aud + exp 一次完成
    const jwks = await this.getJwks();
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token.idToken, jwks, {
        issuer: this.issuerUri,
        audience: this.clientId,
        clockTolerance: 5, // 容忍 5 秒时钟偏移
      }));
    } catch (err) {
      this.logger.warn(
        `ID Token 验签失败：${this.name} - ${(err as Error).message}`,
        { context: GenericOidcProvider.name },
      );
      throw new UnauthorizedException(this.i18n.t('oauth.invalidIdToken'));
    }

    // nonce 校验（jose 不管）：原子 getDel 保证一次性，重放或过期在此被拒
    const expected = await this.redis.getDel(
      `oauth:nonce:${this.name}:${state}`,
    );
    if (!expected || expected !== payload.nonce) {
      throw new UnauthorizedException(
        this.i18n.t('oauth.nonceVerificationFailed'),
      );
    }

    // 旧版语义保留：IdP 明确标记 email_verified=false 时拒绝登录（防抢注他人邮箱）
    if (payload.email_verified === false) {
      throw new UnauthorizedException(this.i18n.t('oauth.idpEmailNotVerified'));
    }

    // 角色映射（可选）：jmespath 按配置路径提取角色列表，命中 adminAccess 即管理员
    let isAdmin: boolean | undefined;
    if (this.roleConfig) {
      const roles =
        (jmespath.search(payload, this.roleConfig.path) as string[] | null) ??
        [];
      isAdmin = roles.some((r) => this.roleConfig!.adminAccess.includes(r));
    }

    if (!payload.sub)
      throw new UnauthorizedException(this.i18n.t('oauth.missingSubClaim'));
    return {
      provider: this.name,
      providerId: payload.sub as string,
      email: payload.email as string | undefined,
      emailVerified: payload.email_verified as boolean | undefined,
      username:
        (payload.preferred_username as string) ??
        (payload.name as string) ??
        (payload.email as string) ??
        (payload.sub as string),
      isAdmin,
    };
  }

  // ---------- 发现文档（带 Expires 缓存） ----------

  /** 实例级懒初始化 JWKS 客户端（jose 自带公钥缓存与轮换，单例即可） */
  private async getJwks() {
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(
        new URL((await this.fetchDiscovery()).jwks_uri),
      );
    }
    return this.jwks;
  }

  private async fetchDiscovery(): Promise<DiscoveryDocument> {
    if (this.discovery && this.discovery.expiresAt > Date.now())
      return this.discovery.doc;

    const url = `${this.issuerUri}/.well-known/openid-configuration`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      // 网络层失败（DNS/超时/被墙）单独包装，与 HTTP 错误码区分
      throw new BadGatewayException(
        this.i18n.t('oauth.discoveryUnreachable', {
          args: { provider: this.name, message: (err as Error).message },
        }),
      );
    }
    if (!res.ok) {
      throw new BadGatewayException(
        this.i18n.t('oauth.discoveryFetchFailed', {
          args: { provider: this.name, status: res.status },
        }),
      );
    }
    const doc = (await res.json()) as DiscoveryDocument;
    // 过期策略：优先响应 Expires 头，缺省 24h（与旧版一致）
    const expires = res.headers.get('expires');
    const ttlMs = expires
      ? Math.max(0, new Date(expires).getTime() - Date.now())
      : 24 * 60 * 60 * 1000;
    this.discovery = { doc, expiresAt: Date.now() + ttlMs };
    return doc;
  }

  /** redirect_uri：回调端点固定模式 /api/oauth/{name}/callback（与 controller 路由一致） */
  protected get redirectUri(): string {
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    if (!this.clientId || !this.clientSecret) {
      throw new InternalServerErrorException(
        this.i18n.t('oauth.oauthNotConfigured', {
          args: {
            provider: this.name,
            env: `OAUTH_${this.name.toUpperCase()}_CLIENT_ID / _SECRET`,
          },
        }),
      );
    }
    return `${appUrl}/api/oauth/${this.name}/callback`;
  }
}
