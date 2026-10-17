/**
 * OAuthProvider 统一接口：任何第三方登录源（OIDC / 微信私有协议 / 未来 LDAP）实现这三个方法，
 * 上层 OAuthService 对具体提供商零感知——新增提供商 = 新增一个 provider 类，编排层一行不改
 */
export interface OAuthProvider {
  /** 提供商名（路由参数 / UserIdentity.provider） */
  readonly name: string;
  /** 生成授权页 URL（state 由 OAuthService 统一管理，nonce 等一次性凭证由实现自管） */
  buildAuthUrl(state: string): Promise<string>;
  /** 授权码换 token */
  exchangeCode(code: string): Promise<OAuthToken>;
  /** 标准化为本地用户资料（OIDC 在此验签 ID Token；state 用于 nonce 校验） */
  fetchProfile(token: OAuthToken, state: string): Promise<OAuthProfile>;
}

export interface OAuthToken {
  /** 第三方颁发的访问令牌（仅用于调其 userinfo API，与本系统会话无关） */
  accessToken: string;
  /** OIDC 的身份凭证（JWT，验签后即用户资料）；非 OIDC 提供商可为空 */
  idToken?: string;
  /** 原始响应透传（扩展字段用） */
  raw: Record<string, unknown>;
}

export interface OAuthProfile {
  /** 提供商名（UserIdentity.provider） */
  provider: string;
  /** 提供商内永不改变的用户标识（OIDC=sub）——UserIdentity.providerId，身份关联的唯一依据 */
  providerId: string;
  email?: string;
  /** 提供商是否已验证该邮箱；false/undefined 影响自动注册决策 */
  emailVerified?: boolean;
  /** 首次注册时的初始用户名（可冲突，service 层负责去重） */
  username: string;
  /** 角色映射结果（可选）：如从 ID Token 的 roles claim 提取管理员组 */
  isAdmin?: boolean;
}
