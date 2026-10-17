<script setup lang="ts">
import { useRouter } from "vue-router";
import { t } from "../i18n";

const router = useRouter();
</script>

<template>
  <el-result class="result-page" :title="t('404.title')" :sub-title="t('404.message')">
    <template #icon>
      <span class="result-code">404</span>
    </template>
    <template #extra>
      <el-button type="primary" @click="router.push('/')">{{ t("home.button.start") }}</el-button>
    </template>
  </el-result>
</template>

<style scoped>
.result-page {
  padding: 80px 0;
}

.result-code {
  font-size: 72px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: -0.02em;
  color: var(--app-text-3);
}
</style>
