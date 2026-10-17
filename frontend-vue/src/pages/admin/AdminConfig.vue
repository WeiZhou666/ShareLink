<script setup lang="ts">
// 动态配置编辑：字段按后端 {key,value,type,allowEdit} 渲染，label 复用旧 i18n 的
// admin.config.* 键家族（camelCase 变量名 → kebab-case i18n 键），副行显示完整键名——
// 与 config.yaml / CONFIG_VARIABLES 一一对应，运维可直接定位
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import configService from "../../api/config.service";
import type { AdminConfig } from "../../types/config.type";
import ConfigValueInput from "../../components/ConfigValueInput.vue";
import { t, currentLocaleCode, getLocaleByCode } from "../../i18n";
import { LOCALES } from "../../i18n/locales";
import toast from "../../utils/toast";

// general.appName → admin.config.general.app-name
const i18nKeyOf = (key: string) =>
  `admin.config.${key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;

// 描述文案可选：当前语言/英文翻译存在才渲染副标题（t() 缺失时会回退 key 本身，需先探测）
const descriptionOf = (key: string) => {
  const id = `${i18nKeyOf(key)}.description`;
  const message = getLocaleByCode(currentLocaleCode()).messages[id] ?? LOCALES.ENGLISH.messages[id];
  return message !== undefined ? t(id) : null;
};

const route = useRoute();
const router = useRouter();
const configs = ref<AdminConfig[]>([]);
const loading = ref(true);
const saving = ref(false);

const category = computed(() => (route.params.category as string) ?? "general");

const load = async () => {
  loading.value = true;
  try {
    configs.value = await configService.getByCategory(category.value);
  } catch (e) {
    toast.axiosError(e);
  } finally {
    loading.value = false;
  }
};

onMounted(load);
// 切换分类 tab → 改路由 → 触发重载（tab 与 URL 双向同步，刷新后停留原分类）
watch(category, load);
const onTabChange = (name: string | number) => {
  router.push(`/admin/config/${name}`);
};

const save = async () => {
  saving.value = true;
  try {
    await configService.updateMany(
      configs.value
        .filter((c) => c.allowEdit)
        .map((c) => ({ key: c.key, value: c.value })),
    );
    toast.success(t("admin.config.notify.success"));
    await load(); // 保存后以后端值为准（yaml 覆盖/类型修正都在服务端）
  } catch (e) {
    toast.axiosError(e);
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <div class="admin-config-page">
    <h2 class="page-title">{{ t("admin.config.title") }}</h2>

    <el-tabs :model-value="category" @tab-change="onTabChange">
      <el-tab-pane v-for="cat in configService.categories" :key="cat" :name="cat"
        :label="t(`admin.config.category.${cat}`)" />
    </el-tabs>

    <el-card shadow="never">
      <div v-loading="loading">
        <div class="field-list">
          <div v-for="item in configs" :key="item.key" class="field">
            <div class="field-head">
              <span class="field-label">{{ t(i18nKeyOf(item.key)) }}</span>
              <el-tag v-if="!item.allowEdit" type="warning" size="small" effect="plain">
                {{ t("admin.config.lockedByYaml") }}
              </el-tag>
            </div>
            <div class="field-key">{{ item.key }}</div>
            <div v-if="descriptionOf(item.key)" class="field-desc">
              {{ descriptionOf(item.key) }}
            </div>

            <el-switch v-if="item.type === 'boolean'" :model-value="item.value === 'true'" :disabled="!item.allowEdit"
              @update:model-value="(v: boolean) => (item.value = String(v))" />
            <el-input-number v-else-if="item.type === 'number'" :model-value="parseInt(item.value)"
              :disabled="!item.allowEdit" class="value-input"
              @update:model-value="(v: number | null) => (item.value = String(v ?? 0))" />
            <!-- filesize/timespan：常用值下拉 + 可输入自定义带单位值（如 100 MB / 7 days / never） -->
            <ConfigValueInput v-else-if="item.type === 'filesize' || item.type === 'timespan'" :model-value="item.value"
              :type="item.type" :disabled="!item.allowEdit" @update:model-value="(v: string) => (item.value = v)" />
            <el-input v-else-if="item.type === 'text'" v-model="item.value" type="textarea" :rows="4"
              :disabled="!item.allowEdit" />
            <el-input v-else v-model="item.value" :disabled="!item.allowEdit" />
          </div>
        </div>

        <div class="save-bar">
          <el-button type="primary" :loading="saving" @click="save">
            {{ t("common.button.save") }}
          </el-button>
        </div>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
/* 表单类页面用 760px 窄栏居中；水平/顶部内边距由 workspace-main 统一提供，这里不再自设 */
.admin-config-page {
  max-width: 760px;
  margin: 0 auto;
}

.page-title {
  /* 字体规格走全局 .page-title，这里只管与内容的间距 */
  margin-bottom: 20px;
}

.field-list {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.field-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
}

.field-label {
  font-weight: 600;
}

.field-key {
  font-family: monospace;
  font-size: 12px;
  color: var(--app-text-3);
  margin-bottom: 2px;
}

.field-desc {
  font-size: 12px;
  color: var(--app-text-3);
  margin-bottom: 6px;
  white-space: pre-line;
}

.value-input {
  max-width: 300px;
}

.save-bar {
  margin-top: 20px;
}
</style>
