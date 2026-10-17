<script setup lang="ts">
// 分享编辑页：阶段 5 完整实现，当前提供基本信息编辑
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import shareService from "../../api/share.service";
import type { MyShare } from "../../types/share.type";
import { t } from "../../i18n";
import toast from "../../utils/toast";

const route = useRoute();
const share = ref<MyShare | null>(null);
const name = ref("");
const description = ref("");
const saving = ref(false);

// 标题优先显示分享名；键值 "编辑 {shareId}" 带占位符，必须传参（否则页面直接渲染 "{shareId}"）
const shareId = route.params.shareId as string;
const pageTitle = computed(() => share.value?.name || t("share.edit.title", { shareId }));

onMounted(async () => {
  try {
    share.value = await shareService.getFromOwner(route.params.shareId as string);
    name.value = share.value.name ?? "";
    description.value = share.value.description ?? "";
  } catch (e) {
    toast.axiosError(e);
  }
});

const save = async () => {
  saving.value = true;
  try {
    await shareService.update(route.params.shareId as string, {
      name: name.value || null,
      description: description.value || null,
    });
    toast.success(t("share.edit.notify.success"));
  } catch (e) {
    toast.axiosError(e);
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <el-card shadow="never">
    <template #header>{{ pageTitle }}</template>
    <div class="edit-form">
      <el-input v-model="name" :placeholder="t('upload.modal.name.placeholder')" />
      <el-input v-model="description" type="textarea" :placeholder="t('upload.modal.description.placeholder')" />
      <el-button type="primary" :loading="saving" @click="save">
        {{ t("common.button.save") }}
      </el-button>
    </div>
  </el-card>
</template>

<style scoped>
.edit-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
