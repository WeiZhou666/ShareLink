<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { useConfigStore } from "../stores/config";
import authService from "../api/auth.service";
import { LOCALES } from "../i18n/locales";
import { t, useI18n, currentLocaleCode } from "../i18n";
import {
  Link,
  Menu as MenuIcon,
  Moon,
  User,
  Setting,
  Sunny,
  SwitchButton,
} from "@element-plus/icons-vue";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const config = useConfigStore();
const { setLocale } = useI18n();
const toggleColorScheme = inject<() => void>("toggleColorScheme", () => { });
const isDark = inject<boolean>("isDark", false);

// 移动端汉堡：唤起 App.vue 的侧栏抽屉（仅工作台路由 + 登录态有意义）
const openSidebar = inject<() => void>("openSidebar", () => { });
const showHamburger = computed(
  () => auth.isAuthenticated && route.meta.sidebar !== false && route.meta.blankLayout !== true,
);

const appName = computed(() => config.get("general.appName") ?? "ShareLink");

// 功能入口已迁往左侧边栏：顶栏文字导航只保留给未登录访客（首页/上传/登录/注册），
// 登录用户顶栏仅剩汉堡（移动端）+ 用户下拉 + 语言/主题
const navLinks = computed(() => {
  if (auth.isAuthenticated) return [];
  const links: { label: string; to: string }[] = [];
  if (config.get("general.showHomePage") !== false)
    links.push({ label: t("navbar.home"), to: "/" });
  links.push({ label: t("navbar.upload"), to: "/upload" });
  links.push({ label: t("navbar.signin"), to: "/auth/signIn" });
  // 兜底配置模式（backend-nest 尚无 config 模块）注册入口恒显示；
  // 迁移后仅当真实配置显式 allowRegistration=true 才显示
  if (config.isFallback || config.get("security.allowRegistration") === true)
    links.push({ label: t("navbar.signup"), to: "/auth/signUp" });
  return links;
});

// 头像下拉四项（对齐旧版）：我的分享 / 我的账号 / 管理后台（仅管理员）/ 退出登录
const onUserAction = async (key: string) => {
  if (key === "signout") return authService.signOut();
  const targets: Record<string, string> = {
    shares: "/account/shares",
    account: "/account",
    admin: "/admin",
  };
  router.push(targets[key]);
};

const languageOptions = Object.values(LOCALES).map((l) => ({
  label: l.name,
  value: l.code,
}));
// 初始值跟随当前实际语言，避免 setLocale 刷新后下拉框重置回 English
const langValue = ref(currentLocaleCode());
const onLocaleChange = (code: string) => setLocale(code);

// 首字母头像（28px 圆形，纯 CSS）
const userInitial = computed(() =>
  (auth.user?.username ?? "?").charAt(0).toUpperCase(),
);
</script>

<template>
  <header class="app-header">
    <div class="app-header-inner">
      <div class="app-header-left">
        <a class="brand" @click="router.push('/')">
          <img src="/img/logo.svg?v=5" alt="logo" width="28" height="28" />
          <span class="brand-name">{{ appName }}</span>
        </a>

        <!-- 移动端汉堡（<768px 显示）：唤起工作台侧栏抽屉；桌面端由侧栏承担导航 -->
        <el-button v-if="showHamburger" text class="hamburger" :icon="MenuIcon" :aria-label="t('navbar.menu')"
          @click="openSidebar" />
      </div>

      <nav class="desktop-links">
        <a v-for="link in navLinks" :key="link.to" class="nav-link" :class="{ active: route.path === link.to }"
          @click="router.push(link.to)">
          {{ link.label }}
        </a>

        <template v-if="auth.isAuthenticated">
          <el-dropdown trigger="click" @command="onUserAction">
            <button class="user-trigger" :title="auth.user?.username">
              <span class="user-avatar">{{ userInitial }}</span>
              <span class="user-name">{{ auth.user?.username }}</span>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="shares" :icon="Link">{{ t("navbar.links.shares") }}</el-dropdown-item>
                <el-dropdown-item command="account" :icon="User">{{ t("navbar.avatar.account") }}</el-dropdown-item>
                <el-dropdown-item v-if="auth.isAdmin" command="admin" :icon="Setting">{{ t("navbar.avatar.admin")
                }}</el-dropdown-item>
                <el-dropdown-item command="signout" :icon="SwitchButton">{{ t("navbar.logout") }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>

        <el-select v-model="langValue" size="small" class="lang-select" @change="onLocaleChange">
          <el-option v-for="o in languageOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-button text size="small" class="theme-btn" :aria-label="isDark ? 'light mode' : 'dark mode'"
          @click="toggleColorScheme">
          <el-icon :size="16">
            <component :is="isDark ? Sunny : Moon" />
          </el-icon>
        </el-button>
      </nav>
    </div>
  </header>
</template>

<style scoped>
/* 吸顶毛玻璃顶栏：半透明底 + 模糊；不支持 backdrop-filter 的浏览器回退纯色 */
.app-header {
  position: sticky;
  top: 0;
  z-index: 100;
  height: var(--app-header-h);
  border-bottom: 1px solid var(--app-border);
  background-color: var(--app-bg-surface);
}

@supports (backdrop-filter: blur(12px)) or (-webkit-backdrop-filter: blur(12px)) {
  .app-header {
    background-color: rgba(255, 255, 255, 0.72);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
}

html.dark .app-header {
  background-color: var(--app-bg-surface);
}

@supports (backdrop-filter: blur(12px)) or (-webkit-backdrop-filter: blur(12px)) {
  html.dark .app-header {
    background-color: rgba(10, 10, 11, 0.72);
  }
}

/* 全宽通栏（原 1200px 内收容器取消），左右留页边距 */
.app-header-inner {
  height: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 var(--app-page-x);
}

.app-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.brand-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--app-text-1);
}

/* 用户下拉触发器：首字母圆形头像 + 用户名 */
.user-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 4px;
  border: none;
  background: none;
  border-radius: var(--app-radius-full);
  cursor: pointer;
  font-family: inherit;
}

.user-trigger:hover {
  background-color: var(--app-bg-subtle);
}

.user-avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--app-radius-full);
  background-color: var(--app-brand);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.user-name {
  font-size: var(--app-font-sm);
  font-weight: 500;
  color: var(--app-text-1);
}

.lang-select {
  width: 130px;
}

.theme-btn {
  padding: 8px;
}

.desktop-links {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 汉堡仅移动端显示（桌面端导航由侧边栏承担） */
.hamburger {
  display: none !important;
}

@media (max-width: 768px) {
  .desktop-links {
    display: none !important;
  }

  .hamburger {
    display: inline-flex !important;
  }
}
</style>
