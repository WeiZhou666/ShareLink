import { defineStore } from "pinia";
import type { CurrentUser } from "../types/user.type";
import userService from "../api/user.service";

// 对齐 React 版 UserContext：当前用户 + 手动刷新
export const useAuthStore = defineStore("auth", {
  state: () => ({
    user: null as CurrentUser | null,
    initialized: false,
  }),
  getters: {
    isAuthenticated: (state) => !!state.user,
    isAdmin: (state) => !!state.user?.isAdmin,
  },
  actions: {
    async refreshUser() {
      this.user = await userService.getCurrentUser();
      this.initialized = true;
      return this.user;
    },
    setUser(user: CurrentUser | null) {
      this.user = user;
      this.initialized = true;
    },
  },
});
