<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type { FileUpload } from "../../types/File.type";
import type { CreateShare } from "../../types/share.type";
import { useAuthStore } from "../../stores/auth";
import { t } from "../../i18n";
import { nanoid } from "./nanoid";

const props = defineProps<{
  show: boolean;
  files: FileUpload[];
  maxExpiration: { value: number; unit: string };
  defaultExpiration: { value: number; unit: string };
  shareIdLength: number;
  appUrl?: string;
}>();

const emit = defineEmits<{
  (e: "update:show", value: boolean): void;
  (e: "create", share: CreateShare): void;
}>();

const auth = useAuthStore();
const showNotSignedInAlert = ref(true);

// ElDialog 的 v-model 代理
const visible = computed({
  get: () => props.show,
  set: (v: boolean) => emit("update:show", v),
});

const units = [
  { label: t("upload.modal.expires.second-singular"), value: "seconds" },
  { label: t("upload.modal.expires.minute-singular"), value: "minutes" },
  { label: t("upload.modal.expires.hour-singular"), value: "hours" },
  { label: t("upload.modal.expires.day-singular"), value: "days" },
  { label: t("upload.modal.expires.week-singular"), value: "weeks" },
  { label: t("upload.modal.expires.month-singular"), value: "months" },
  { label: t("upload.modal.expires.year-singular"), value: "years" },
  { label: t("upload.modal.expires.never"), value: "never" },
];

const form = reactive({
  name: "",
  description: "",
  customUrl: "" as string,
  expirationNum: props.defaultExpiration?.value ?? 1,
  expirationUnit: props.defaultExpiration?.unit ?? "days",
  password: "",
  maxViews: null as number | null,
});

const generateId = () => {
  form.customUrl = nanoid(props.shareIdLength);
};

// 打开弹窗时自动生成分享链接（与演示站行为一致）
watch(
  () => props.show,
  (v) => {
    if (v && !form.customUrl) generateId();
  },
);

const expirationValue = computed(() => {
  if (props.maxExpiration?.value === 0) return null; // 无限制
  return props.maxExpiration?.value;
});

const canSubmit = computed(() => {
  const hasExpiration =
    form.expirationUnit === "never" || form.expirationNum > 0;
  const idValid = form.customUrl.length >= 3;
  return hasExpiration && idValid;
});

const shareUrl = computed(() => {
  if (!form.customUrl) return "";
  const base = (props.appUrl ?? "").replace(/\/$/, "");
  return `${base}/s/${form.customUrl}`;
});

// 过期时间预览
const expiryDate = computed(() => {
  if (form.expirationUnit === "never") return null;
  const d = new Date();
  const n = form.expirationNum || 0;
  switch (form.expirationUnit) {
    case "seconds":
      d.setSeconds(d.getSeconds() + n);
      break;
    case "minutes":
      d.setMinutes(d.getMinutes() + n);
      break;
    case "hours":
      d.setHours(d.getHours() + n);
      break;
    case "days":
      d.setDate(d.getDate() + n);
      break;
    case "weeks":
      d.setDate(d.getDate() + 7 * n);
      break;
    case "months":
      d.setMonth(d.getMonth() + n);
      break;
    case "years":
      d.setFullYear(d.getFullYear() + n);
      break;
  }
  return d;
});

const expirationNote = computed(() =>
  expiryDate.value
    ? t("upload.modal.expires.expiration-date-time", {
      expiration: expiryDate.value.toLocaleString(),
    })
    : t("upload.modal.completed.never-expires"),
);

const submit = () => {
  emit("update:show", false);
  emit("create", {
    id: form.customUrl,
    name: form.name || undefined,
    description: form.description || undefined,
    recipients: [],
    expiration:
      form.expirationUnit === "never"
        ? "never"
        : `${form.expirationNum}${form.expirationUnit}`,
    security: {
      password: form.password || undefined,
      maxViews: form.maxViews ?? undefined,
    },
  });
};
</script>

<template>
  <el-dialog v-model="visible" :title="t('upload.modal.title')" width="480px">
    <!-- 未登录提示（对齐演示站的黄色警告条） -->
    <el-alert v-if="!auth.isAuthenticated && showNotSignedInAlert" type="warning"
      :title="t('upload.modal.not-signed-in')" closable class="signed-in-alert" @close="showNotSignedInAlert = false">
      {{ t("upload.modal.not-signed-in-description") }}
    </el-alert>

    <!-- 分享链接 + 生成按钮 -->
    <div class="field-label">{{ t("upload.modal.link.label") }}</div>
    <div class="inline-row">
      <el-input v-model="form.customUrl" />
      <el-button plain type="primary" @click="generateId">
        {{ t("common.button.generate") }}
      </el-button>
    </div>
    <div v-if="shareUrl" class="share-url-preview">{{ shareUrl }}</div>

    <!-- 过期时间 -->
    <div class="field-label field-gap">
      {{ t("upload.modal.expires.label") }}
    </div>
    <div class="inline-row">
      <el-input-number v-if="form.expirationUnit !== 'never'" v-model="form.expirationNum" :min="1"
        :max="expirationValue ?? 99999" class="grow" />
      <el-select v-model="form.expirationUnit" class="grow">
        <el-option v-for="o in units" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
    </div>
    <div class="expiration-note">{{ expirationNote }}</div>

    <!-- 折叠面板：名称与描述 / 安全选项 -->
    <el-collapse accordion class="options-collapse">
      <el-collapse-item :title="t('upload.modal.accordion.name-and-description.title')" name="name-and-description">
        <el-input v-model="form.name"
          :placeholder="t('upload.modal.accordion.name-and-description.name.placeholder')" />
        <el-input v-model="form.description" type="textarea"
          :placeholder="t('upload.modal.accordion.name-and-description.description.placeholder')" class="stack-gap" />
      </el-collapse-item>
      <el-collapse-item :title="t('upload.modal.accordion.security.title')" name="security">
        <el-input v-model="form.password" type="password" show-password
          :placeholder="t('upload.modal.accordion.security.password.label')" />
        <el-input-number v-model="form.maxViews" :min="1" class="stack-gap full-width"
          :placeholder="t('upload.modal.accordion.security.max-views.placeholder')" />
      </el-collapse-item>
    </el-collapse>

    <!-- 通栏共享按钮 -->
    <el-button type="primary" :disabled="!canSubmit || props.files.length === 0" class="submit-btn" @click="submit">
      {{ t("common.button.share") }}
    </el-button>
  </el-dialog>
</template>

<style scoped>
.signed-in-alert {
  margin-bottom: 16px;
}

.inline-row {
  display: flex;
  gap: 8px;
}

.grow {
  flex: 1;
}

.field-label {
  font-size: var(--app-font-md);
  font-weight: 500;
  color: var(--app-text-1);
  margin-bottom: 6px;
}

.field-gap {
  margin-top: 16px;
}

.options-collapse {
  margin-top: 8px;
  border: none;
}

.stack-gap {
  margin-top: 10px;
}

.full-width {
  width: 100%;
}

.submit-btn {
  width: 100%;
  margin-top: 16px;
}

.share-url-preview {
  margin-top: 6px;
  font-size: var(--app-font-xs);
  color: var(--app-text-3);
  word-break: break-all;
}

.expiration-note {
  margin-top: 6px;
  font-size: var(--app-font-xs);
  color: var(--app-text-3);
}
</style>
