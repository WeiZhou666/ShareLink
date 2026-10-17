import api from "./client";

export interface AdminNotice {
  id: string;
  title: string;
  message: string;
  /** 可选的"查看如何解决"外链（后端静态公告定义里的 actionLink） */
  actionLink?: string;
}

// 路由收编进 admin 域（backend-nest 无独立 adminNotice 模块），与旧后端 /admin-notices 不同
const getPendingNotices = async (): Promise<AdminNotice[]> => {
  return (await api.get("/admin/notices/pending")).data;
};

const dismissNotice = async (id: string): Promise<void> => {
  await api.post(`/admin/notices/${id}/dismiss`);
};

export default {
  getPendingNotices,
  dismissNotice,
};
