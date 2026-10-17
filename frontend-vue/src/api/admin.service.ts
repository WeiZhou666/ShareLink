import api from "./client";

// 管理员用户管理端点，一一对应 backend-nest src/admin 模块（AdminGuard：非管理员 403）
const listUsers = async (params: { page?: number; pageSize?: number; keyword?: string }) => {
  return (await api.get("/admin/users", { params })).data;
};

const updateUser = async (id: string, data: { isAdmin?: boolean; isActivated?: boolean }) => {
  return (await api.patch(`/admin/users/${id}`, data)).data;
};

const resetPassword = async (id: string, newPassword: string) => {
  return (await api.post(`/admin/users/${id}/resetPassword`, { newPassword })).data;
};

const revokeSessions = async (id: string) => {
  return (await api.post(`/admin/users/${id}/revokeSessions`)).data;
};

const removeUser = async (id: string) => {
  await api.delete(`/admin/users/${id}`);
};

// —— 分享管理（backend-nest /admin/shares，分享模块 P0 迁移前的最小管理端点） ——
const listShares = async (params: { page?: number; pageSize?: number; keyword?: string }) => {
  return (await api.get("/admin/shares", { params })).data;
};

const removeShare = async (id: string) => {
  await api.delete(`/admin/shares/${id}`);
};

export default {
  listUsers,
  updateUser,
  resetPassword,
  revokeSessions,
  removeUser,
  listShares,
  removeShare,
};
