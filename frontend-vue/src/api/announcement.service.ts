import api from "./client";

/**
 * 运营公告（管理端发布，全体登录用户可见）
 * 与 adminNotice.service 的系统级公告共用 App.vue 弹窗，按 kind 分发 dismiss 端点
 */
export interface Announcement {
  id: string;
  title: string;
  message: string;
  actionLink?: string | null;
  createdAt: string;
  createdByUsername?: string | null;
  /** 管理端列表才有：已读人数 */
  _count?: { reads: number };
}

// ===== 用户端 =====

const getPending = async (): Promise<Announcement[]> => {
  return (await api.get("/announcements/pending")).data;
};

const dismiss = async (id: string): Promise<void> => {
  await api.post(`/announcements/${id}/dismiss`);
};

// ===== 管理端 =====

const create = async (data: {
  title: string;
  message: string;
  actionLink?: string;
}): Promise<Announcement> => {
  return (await api.post("/admin/announcements", data)).data;
};

const list = async (): Promise<Announcement[]> => {
  return (await api.get("/admin/announcements")).data;
};

// 编辑公告：字段与发布一致；已读记录保留（已读用户不再弹，未读用户看到新内容）
const update = async (
  id: string,
  data: { title: string; message: string; actionLink?: string },
): Promise<Announcement> => {
  return (await api.patch(`/admin/announcements/${id}`, data)).data;
};

const remove = async (id: string): Promise<void> => {
  await api.delete(`/admin/announcements/${id}`);
};

export default { getPending, dismiss, create, list, update, remove };
