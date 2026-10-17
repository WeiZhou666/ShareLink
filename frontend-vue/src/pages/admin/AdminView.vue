<script setup lang="ts">
// 管理面板入口：卡片式分类导航（RouterLink 站内跳转，避免 <a href> 整页刷新）
import { Link, Setting, User } from "@element-plus/icons-vue";
import { RouterLink } from "vue-router";
import { t } from "../../i18n";

const entries = [
  {
    to: "/admin/users",
    icon: User,
    title: "admin.users.title",
    description: "admin.users.description",
  },
  {
    to: "/admin/shares",
    icon: Link,
    title: "admin.shares.title",
    description: "admin.shares.description",
  },
  {
    to: "/admin/config",
    icon: Setting,
    title: "admin.config.title",
    description: "admin.config.description",
  },
];
</script>

<template>
  <div class="admin-view-page">
    <h2 class="page-title">{{ t("admin.title") }}</h2>

    <div class="entry-grid">
      <RouterLink v-for="entry in entries" :key="entry.to" :to="entry.to" class="entry-card">
        <el-icon :size="22" class="entry-icon">
          <component :is="entry.icon" />
        </el-icon>
        <div class="entry-text">
          <div class="entry-name">{{ t(entry.title) }}</div>
          <div class="entry-description">{{ t(entry.description) }}</div>
        </div>
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
/* 入口导航与 config 同款 760px 窄栏；内边距由 workspace-main 统一提供 */
.admin-view-page {
  max-width: 760px;
  margin: 0 auto;
}

.page-title {
  margin: 0 0 20px;
}

.entry-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.entry-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 24px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-md);
  background: var(--app-bg-surface);
  text-decoration: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.entry-card:hover {
  border-color: var(--el-color-primary);
  box-shadow: var(--app-shadow-sm);
}

.entry-icon {
  color: var(--el-color-primary);
  flex-shrink: 0;
}

.entry-name {
  font-weight: 600;
  color: var(--app-text-1);
}

.entry-description {
  font-size: var(--app-font-sm);
  color: var(--app-text-2);
  margin-top: 2px;
}
</style>
