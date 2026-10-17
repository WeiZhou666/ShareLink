import type { CurrentUser, UpdateCurrentUser } from "../types/user.type";
import api from "./client";
import authService from "./auth.service";

// 管理员用户 CRUD 在 admin.service.ts（backend-nest 的 /admin/users* 端点，AdminGuard 保护）

const updateCurrentUser = async (user: UpdateCurrentUser) => {
  return (await api.patch("/users/me", user)).data;
};

// 修改密码：PATCH /users/password（从 /auth/password 迁入 users 模块，语义同"账号资料管理"）
const updatePassword = async (oldPassword: string, password: string) => {
  await api.patch("/users/password", { oldPassword, password });
};

const removeCurrentUser = async () => {
  await api.delete("/users/me");
};

const getCurrentUser = async (): Promise<CurrentUser | null> => {
  try {
    await authService.refreshAccessToken();
    // backend-nest 的当前用户端点是 GET /auth/me（旧后端才是 /users/me）
    return (await api.get("/auth/me")).data;
  } catch {
    return null;
  }
};

export default {
  getCurrentUser,
  updateCurrentUser,
  updatePassword,
  removeCurrentUser,
};
