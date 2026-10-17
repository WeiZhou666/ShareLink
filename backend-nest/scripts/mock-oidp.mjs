/**
 * 本地 Mock OIDC Provider（仅开发/回归用，node scripts/mock-oidp.mjs，端口 9099）
 * 实现真实 OIDC 四端点的最小子集，RS256 真实签名（非 BASE64 裸拼）——
 * 用于在无法访问外网 Google 的环境里完整验证 oauth 模块全链路：
 *   发现文档 → 302 授权页 → code 换 token → JWKS 验签 → nonce → 本地会话签发
 * 同端口模拟 GitHub OAuth App 私有端点（/login/oauth/*、/user、/user/emails），
 * 供 GithubProvider 在无外网环境做全链路回归
 */
import { createServer } from 'node:http';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';

const PORT = 9099;
const ISSUER = `http://localhost:${PORT}`;
const CLIENT_ID = 'local-client';
const CLIENT_SECRET = 'local-secret';
const GH_CLIENT_ID = 'gh-client';
const GH_CLIENT_SECRET = 'gh-secret';

// RSA 密钥对：每次重启重新生成（mock 场景无需持久化）
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64u = (s) => Buffer.from(s).toString('base64url');

/** RS256 真签名 JWT（与真实 IdP 行为一致，jose 必须用 JWKS 公钥才能验过） */
function signJwt(payload) {
  const header = { alg: 'RS256', kid: 'mock-key', typ: 'JWT' };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = createSign('RSA-SHA256').update(input).sign(privateKey, 'base64url');
  return `${input}.${sig}`;
}

// 授权码一次性：code -> nonce（token 交换时取回并删除，防重放）
const codes = new Map();

createServer((req, res) => {
  const url = new URL(req.url, ISSUER);
  const json = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  // ① 发现文档
  if (url.pathname === '/.well-known/openid-configuration') {
    return json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks.json`,
    });
  }

  // ② 授权端点：模拟"用户扫码/选账号并确认"——直接签发一次性 code 并 302 回 callback
  if (url.pathname === '/authorize') {
    const code = `mock-code-${randomUUID()}`;
    codes.set(code, { nonce: url.searchParams.get('nonce') });
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }

  // ③ token 端点：校验 code 一次性 + client 凭证，签发 id_token（sub/email/nonce 与发起时一致）
  if (url.pathname === '/token' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      if (p.get('client_id') !== CLIENT_ID || p.get('client_secret') !== CLIENT_SECRET) {
        res.writeHead(401); return res.end('invalid_client');
      }
      const entry = codes.get(p.get('code'));
      if (!entry) { res.writeHead(400); return res.end(JSON.stringify({ error: 'invalid_grant' })); }
      codes.delete(p.get('code')); // 一次性
      const now = Math.floor(Date.now() / 1000);
      return json({
        access_token: `mock-at-${randomUUID()}`,
        token_type: 'Bearer',
        id_token: signJwt({
          iss: ISSUER,
          sub: 'mock-sub-001',
          aud: CLIENT_ID,
          iat: now,
          exp: now + 3600,
          email: 'oidcuser@example.com',
          email_verified: true,
          preferred_username: 'oidcuser',
          nonce: entry.nonce,
        }),
      });
    });
    return;
  }

  // ④ JWKS：导出公钥（含 kid，jose 按 id_token header 的 kid 匹配）
  if (url.pathname === '/jwks.json') {
    return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'mock-key', use: 'sig', alg: 'RS256' }] });
  }

  // ⑤ GitHub OAuth App 模拟（标准 OAuth2 + REST：无 id_token/JWKS，资料凭 access_token 查询）
  if (url.pathname === '/login/oauth/authorize') {
    const code = `gh-code-${randomUUID()}`;
    codes.set(code, {});
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = JSON.parse(body || '{}');
      if (p.client_id !== GH_CLIENT_ID || p.client_secret !== GH_CLIENT_SECRET) {
        return json({ error: 'incorrect_client_credentials' }); // GitHub 语义：HTTP 200 + error 字段
      }
      const entry = codes.get(p.code);
      if (!entry) return json({ error: 'bad_verification_code' });
      codes.delete(p.code); // 一次性
      return json({ access_token: `gh-at-${randomUUID()}`, token_type: 'bearer', scope: 'read:user,user:email' });
    });
    return;
  }
  if (url.pathname === '/user') {
    return json({ id: 675001, login: 'ghuser', name: 'GitHub User' });
  }
  if (url.pathname === '/user/emails') {
    return json([{ email: 'ghuser@example.com', primary: true, verified: true }]);
  }

  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`Mock OIDC Provider: ${ISSUER} (client_id=${CLIENT_ID} client_secret=${CLIENT_SECRET})`));
