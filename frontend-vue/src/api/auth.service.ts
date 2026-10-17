import api, { refreshSession } from "./client";

const signIn = async (emailOrUsername: string, password: string) => {
  const emailOrUsernameBody = emailOrUsername.includes("@")
    ? { email: emailOrUsername }
    : { username: emailOrUsername };

  const response = await api.post("auth/signIn", {
    ...emailOrUsernameBody,
    password,
  });

  return response;
};

const signInTotp = (totp: string, loginToken: string) => {
  return api.post("auth/signIn/totp", {
    totp,
    loginToken,
  });
};

const signUp = async (email: string, username: string, password: string) => {
  const response = await api.post("auth/signUp", { email, username, password });

  return response;
};

// 恢复注销冷静期内的账号：凭原凭据验证，成功即登录（后端 Set-Cookie 下发双 token）
const recoverAccount = async (emailOrUsername: string, password: string) => {
  const body = emailOrUsername.includes("@")
    ? { email: emailOrUsername }
    : { username: emailOrUsername };
  return api.post("auth/recoverAccount", { ...body, password });
};

const signOut = async () => {
  const response = await api.post("/auth/signOut");

  if (URL.canParse(response.data?.redirectURI))
    window.location.href = response.data.redirectURI;
  else window.location.reload();
};

const refreshAccessToken = async () => {
  // httpOnly 加固后前端读不到 access_token 的过期时间，无法"快过期才刷新"；
  // 统一走 client 的单飞刷新（与 401 拦截器共享同一 in-flight，防轮换竞争），失败静默——
  // 未登录/会话失效由 getCurrentUser 置空用户态、路由守卫处理
  try {
    await refreshSession();
  } catch {
    console.info("Refresh token invalid or expired");
  }
};

const requestResetPassword = async (email: string) => {
  // backend-nest：POST body 传邮箱（旧后端是 /auth/resetPassword/:email 路径参数风格）
  await api.post("/auth/requestPasswordReset", { email });
};

// 重置密码：邮箱 + 6 位重置验证码 + 新密码（与激活流程同构，验证码走 body 绝不出现在 URL）
const resetPassword = async (email: string, code: string, password: string) => {
  await api.post("/auth/resetPassword", { email, code, password });
};

// 邮箱激活：新后端为 6 位验证码方案（POST body 提交，码绝不出现在 URL）
const verifyEmail = async (email: string, code: string) => {
  await api.post("/auth/verifyEmail", { email, code });
};

const resendVerification = async (email: string) => {
  await api.post("/auth/resendVerification", { email });
};

const enableTOTP = async (password: string) => {
  const { data } = await api.post("/auth/totp/enable", { password });

  return {
    totpAuthUrl: data.totpAuthUrl,
    totpSecret: data.totpSecret,
    qrCode: data.qrCode,
  };
};

const verifyTOTP = async (totpCode: string, password: string) => {
  await api.post("/auth/totp/verify", {
    code: totpCode,
    password,
  });
};

const disableTOTP = async (totpCode: string, password: string) => {
  await api.post("/auth/totp/disable", {
    code: totpCode,
    password,
  });
};

const getAvailableOAuth = async () => {
  return api.get("/oauth/available");
};

const getOAuthStatus = () => {
  return api.get("/oauth/status");
};

export default {
  signIn,
  signInTotp,
  signUp,
  recoverAccount,
  signOut,
  refreshAccessToken,
  requestResetPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
  enableTOTP,
  verifyTOTP,
  disableTOTP,
  getAvailableOAuth,
  getOAuthStatus,
};
