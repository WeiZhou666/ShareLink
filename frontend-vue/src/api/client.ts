import axios from "axios";

const api = axios.create({
  baseURL: "/api",
});

// 这些端点的 401 是业务语义（凭据错误/验证码无效/无会话），不做「刷新后重试」，
// 否则登录失败会触发无意义的刷新尝试甚至重放请求（烧限流额度）
const PUBLIC_APIS = [
  "auth/signIn",
  "auth/signUp",
  "auth/token", // 刷新接口自身，防止递归
  "auth/verifyEmail",
  "auth/resendVerification",
  "auth/requestPasswordReset",
  "auth/resetPassword",
];

// 并发多个 401 只触发一次刷新（共享同一个 in-flight Promise，完成后置空）
let refreshing: Promise<unknown> | null = null;

/**
 * 会话续期（单飞）：无论多少处同时触发（401 拦截器 / App 定时器），同一时刻只有一个 /auth/token 在途。
 * 必须单飞的原因：refresh 采用轮换（旧的立即作废），并发刷新会让后发请求撞上已吊销会话，
 * 触发重用检测 → 全家桶吊销 → 用户被登出
 */
export async function refreshSession(): Promise<unknown> {
  refreshing ??= axios
    // 用裸 axios 而非本实例：同源自动携带 refresh_token cookie，且不经过本拦截器（防递归）
    .post("/api/auth/token")
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

// access_token 是 httpOnly cookie（XSS 加固），前端 JS 无法读取它判断过期；
// 统一策略：请求 401 时刷新会话并重放原请求一次；
// 刷新失败则把原始 401 抛回——由 getCurrentUser 置空用户态、路由守卫按未登录处理
api.interceptors.response.use(undefined, async (error) => {
  const original = error.config as (typeof error.config & { _retried?: boolean }) | undefined;
  const url: string = original?.url ?? "";
  if (
    !original || // 无原始请求信息的错误（如网络层错误）不处理
    error.response?.status !== 401 ||
    original._retried || // 只重试一次：刷新成功但仍 401（如权限不足）时防止打转
    PUBLIC_APIS.some((p) => url.includes(p))
  ) {
    throw error;
  }
  original._retried = true;
  try {
    await refreshSession();
  } catch {
    throw error; // refresh_token 也失效/缺失：会话真没了，按未登录处理
  }
  return api(original); // 用新 access_token 重放原请求
});

export default api;
