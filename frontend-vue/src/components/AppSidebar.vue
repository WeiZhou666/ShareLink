<script setup lang="ts">
// 左侧功能栏（工作台壳专用）：登录后的 /upload、/account、/admin 等页面渲染。
// 公开页/认证页走 App.vue 的单栏壳，不挂载本组件。
// 结构：上传 / 分享组（我的分享、收到的、反向、账号）/ 管理组（仅 admin 可见）。
import { computed, inject, ref } from "vue";
import { useRoute } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { t } from "../i18n";
import {
  Bell,
  Coffee,
  Download,
  Expand,
  Fold,
  Link,
  Menu as MenuIcon,
  Monitor,
  Setting,
  Share,
  Upload,
  User,
} from "@element-plus/icons-vue";
import type { Ref } from "vue";

const route = useRoute();
const auth = useAuthStore();

// 折叠态：收成 64px 图标条（el-menu 自带 collapse 模式 + tooltip）
const collapsed = ref(false);
const toggleCollapse = () => (collapsed.value = !collapsed.value);

// 移动端抽屉由 App.vue 持有，点菜单跳转后随路由变化自动关闭；
// 此按钮供用户不跳转直接收起抽屉（桌面端恒隐藏）
const closeSidebar = inject<() => void>("closeSidebar", () => { });

// 支持作者入口：点击唤起 App.vue 的公告弹窗（纯支持视图）；收款码就绪才渲染
const openDonate = inject<() => void>("openDonate", () => { });
const donateAvailable = inject<Ref<boolean>>("donateAvailable", ref(false));

// 当前激活项跟随路由路径（el-menu router 模式下 index 即目标路径）
const activeIndex = computed(() => route.path);
</script>

<template>
  <div class="sidebar">
    <el-menu :default-active="activeIndex" :collapse="collapsed" router class="sidebar-menu">
      <el-menu-item index="/upload">
        <el-icon>
          <Upload />
        </el-icon>
        <template #title>{{ t("navbar.upload") }}</template>
      </el-menu-item>

      <el-menu-item-group>
        <template #title>
          <span class="group-title">{{ t("sidebar.group.shares") }}</span>
        </template>
        <el-menu-item index="/account/shares">
          <el-icon>
            <Share />
          </el-icon>
          <template #title>{{ t("navbar.links.shares") }}</template>
        </el-menu-item>
        <el-menu-item index="/account/received">
          <el-icon>
            <Download />
          </el-icon>
          <template #title>{{ t("navbar.links.received") }}</template>
        </el-menu-item>
        <el-menu-item index="/account/reverseShares">
          <el-icon>
            <Link />
          </el-icon>
          <template #title>{{ t("navbar.links.reverse") }}</template>
        </el-menu-item>
        <el-menu-item index="/account">
          <el-icon>
            <User />
          </el-icon>
          <template #title>{{ t("navbar.avatar.account") }}</template>
        </el-menu-item>
      </el-menu-item-group>

      <!-- 管理组：非 admin 整组隐藏（路由层还有 requiresAdmin 双保险） -->
      <el-menu-item-group v-if="auth.isAdmin">
        <template #title>
          <span class="group-title">{{ t("sidebar.group.admin") }}</span>
        </template>
        <el-menu-item index="/admin">
          <el-icon>
            <Monitor />
          </el-icon>
          <template #title>{{ t("admin.overview") }}</template>
        </el-menu-item>
        <el-menu-item index="/admin/users">
          <el-icon>
            <User />
          </el-icon>
          <template #title>{{ t("admin.button.users") }}</template>
        </el-menu-item>
        <el-menu-item index="/admin/shares">
          <el-icon>
            <Share />
          </el-icon>
          <template #title>{{ t("admin.button.shares") }}</template>
        </el-menu-item>
        <el-menu-item index="/admin/announcements">
          <el-icon>
            <Bell />
          </el-icon>
          <template #title>{{ t("admin.button.announcements") }}</template>
        </el-menu-item>
        <el-menu-item index="/admin/config">
          <el-icon>
            <Setting />
          </el-icon>
          <template #title>{{ t("admin.button.config") }}</template>
        </el-menu-item>
      </el-menu-item-group>
    </el-menu>

    <!-- 支持作者入口：低调文字行，hover 着品牌色；折叠态只留图标（原生 title 提示） -->
    <button v-if="donateAvailable" class="donate-entry" :class="{ 'is-collapsed': collapsed }"
      :title="collapsed ? t('sidebar.donate') : undefined" @click="openDonate">
      <el-icon :size="18">
        <Coffee />
      </el-icon>
      <span v-if="!collapsed" class="donate-label">{{ t("sidebar.donate") }}</span>
    </button>

    <div class="sidebar-footer">
      <el-button text :icon="collapsed ? Expand : Fold" @click="toggleCollapse" />
      <!-- 移动端抽屉内的关闭入口（桌面端由 CSS 隐藏） -->
      <el-button text :icon="MenuIcon" class="drawer-close" @click="closeSidebar" />
    </div>
  </div>
</template>

<style scoped>
/* 背景透明融入画布（--app-bg-base），与内容区只靠容器 border-right 分隔；
   抽屉场景同构（el-drawer 自带边界阴影） */
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: transparent;
}

.sidebar-menu {
  flex: 1;
  overflow-y: auto;
  border-right: none;
  /* 边框由容器承担，避免双线 */
}

/* 菜单项：36px 高 + 圆角浮动块（Linear 式），默认文字次级色 */
.sidebar-menu :deep(.el-menu-item) {
  margin: 2px 8px;
  border-radius: var(--app-radius-sm);
  color: var(--app-text-2);
  transition: background-color 0.15s, color 0.15s;
}

.sidebar-menu :deep(.el-menu-item:hover) {
  background-color: var(--app-bg-subtle);
  color: var(--app-text-1);
}

/* 激活态：灰底 + 主文字加重 + 图标着品牌色（替代 EP 默认纯色文字） */
.sidebar-menu :deep(.el-menu-item.is-active) {
  background-color: var(--app-bg-subtle);
  color: var(--app-text-1);
}

.sidebar-menu :deep(.el-menu-item.is-active .el-icon) {
  color: var(--el-color-primary);
}

/* 分组标题：11px 小写字距弱化（el-menu-item-group 默认样式偏大） */
.group-title {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--app-text-3);
}

/* 组间拉开间距 */
.sidebar-menu :deep(.el-menu-item-group) {
  margin-top: 8px;
}

/* 折叠态：隐藏分组标题（EP 只做 visibility:hidden 保留行高，自定义 span 会漏出来） */
.sidebar-menu.el-menu--collapse .group-title {
  display: none;
}

.sidebar-footer {
  display: flex;
  justify-content: flex-end;
  padding: 4px;
  border-top: 1px solid var(--app-border);
}

/* 支持作者入口：与菜单项同规格（36px 高 + 圆角浮动块），默认次级色 */
.donate-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 8px;
  padding: 0 12px;
  height: 36px;
  border: none;
  border-radius: var(--app-radius-sm);
  background: transparent;
  color: var(--app-text-2);
  font-size: 14px;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.donate-entry:hover {
  background-color: var(--app-bg-subtle);
  color: var(--el-color-primary);
}

.donate-entry.is-collapsed {
  justify-content: center;
  padding: 0;
}

/* 抽屉关闭按钮：仅移动端抽屉场景显示（桌面端 footer 只有折叠按钮） */
.drawer-close {
  display: none;
}

@media (max-width: 768px) {
  .drawer-close {
    display: inline-flex;
  }
}
</style>
