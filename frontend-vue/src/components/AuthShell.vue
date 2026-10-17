<script setup lang="ts">
// 认证页公共外壳：无背景装饰，仅提供「导航栏下方顶对齐 + 边框卡片」布局。
// 登录/注册/验证码等 auth 系页面共用；卡片底色走 --el-bg-color-overlay，深色模式自动跟随主题。
// wide：含较宽内容（如表格）的页面用 520px 卡片，默认 400px。
defineProps<{ wide?: boolean }>();
</script>

<template>
  <div class="auth-shell">
    <div class="auth-shell__card" :class="{ 'auth-shell__card--wide': wide }">
      <img class="auth-shell__logo" src="/img/logo.svg?v=5" alt="logo" />
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* auth 页在 App.vue 的导航栏布局内渲染：顶对齐 + 紧凑上边距，
   避免垂直居中把卡片吊在屏幕中央、与导航栏之间留出大片空白 */
.auth-shell {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 40px 16px 64px;
}

/* 边框优先卡片：细边框 + 轻阴影，去掉大模糊 */
.auth-shell__card {
  width: 100%;
  max-width: 400px;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-lg);
  box-shadow: var(--app-shadow-xs);
  padding: 32px 28px;
}

.auth-shell__card--wide {
  max-width: 520px;
}

.auth-shell__logo {
  display: block;
  width: 36px;
  height: 36px;
  margin: 0 auto 16px;
}
</style>
