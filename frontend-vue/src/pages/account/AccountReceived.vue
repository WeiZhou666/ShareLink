<script setup lang="ts">
// 收到的分享（fork 特性）：列表骨架
import { onMounted, ref } from "vue";
import shareService from "../../api/share.service";
import { t } from "../../i18n";
import toast from "../../utils/toast";

const received = ref<any[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    received.value = await shareService.getReceivedShares();
  } catch (e) {
    toast.axiosError(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page-stack">
    <div class="page-header">
      <h1 class="page-title">{{ t("account.received.title") }}</h1>
    </div>
    <el-card shadow="never">
      <div v-loading="loading">
        <el-empty v-if="!received.length" :description="t('account.received.empty')" />
        <ul v-else class="simple-list">
          <li v-for="share in received" :key="share.id" class="simple-row">
            <a class="simple-link" :href="`/share/${share.id}`">{{ share.name || share.id }}</a>
          </li>
        </ul>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.simple-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.simple-row {
  padding: 12px 4px;
  border-bottom: 1px solid var(--app-border);
}

.simple-row:last-child {
  border-bottom: none;
}

.simple-link {
  color: var(--el-color-primary);
  word-break: break-all;
}

.simple-link:hover {
  text-decoration: underline;
}
</style>
