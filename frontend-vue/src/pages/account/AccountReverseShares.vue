<script setup lang="ts">
// 反向分享管理：列表 + 删除，创建在阶段 5 充实
import { onMounted, ref } from "vue";
import shareService from "../../api/share.service";
import type { MyReverseShare } from "../../types/share.type";
import { t } from "../../i18n";
import toast from "../../utils/toast";

const reverseShares = ref<MyReverseShare[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    reverseShares.value = await shareService.getMyReverseShares();
  } catch (e) {
    toast.axiosError(e);
  } finally {
    loading.value = false;
  }
});

const remove = async (id: string) => {
  try {
    await shareService.removeReverseShare(id);
    reverseShares.value = reverseShares.value.filter((r) => r.id !== id);
  } catch (e) {
    toast.axiosError(e);
  }
};
</script>

<template>
  <div class="page-stack">
    <div class="page-header">
      <h1 class="page-title">{{ t("account.reverseShares.title") }}</h1>
    </div>
    <el-card shadow="never">
      <div v-loading="loading">
        <el-empty v-if="!reverseShares.length" :description="t('account.reverseShares.description.empty')" />
        <ul v-else class="simple-list">
          <li v-for="rs in reverseShares" :key="rs.id" class="simple-row">
            <div class="row-flex">
              <div class="row-main">
                <a class="simple-link" :href="`/upload/${rs.token}`">{{ rs.token }}</a>
                <span class="row-meta uses">
                  {{ t("account.reverseShares.remaining-uses", { uses: rs.remainingUses }) }}
                </span>
              </div>
              <el-button size="small" type="danger" text @click="remove(rs.id)">
                {{ t("common.button.delete") }}
              </el-button>
            </div>
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

.row-flex {
  display: flex;
  align-items: center;
  gap: 12px;
}

.row-main {
  flex: 1;
  min-width: 0;
}

.simple-link {
  color: var(--el-color-primary);
  word-break: break-all;
}

.simple-link:hover {
  text-decoration: underline;
}

.uses {
  margin-left: 8px;
}
</style>
