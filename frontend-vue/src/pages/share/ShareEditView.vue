<script setup lang="ts">
// 分享编辑页：除名称/描述外，还支持修改有效期、密码与最大访问次数（PATCH 增量提交：字段未传 = 不改）
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import shareService from "../../api/share.service";
import type { MyShare, UpdateShare } from "../../types/share.type";
import { useAuthStore } from "../../stores/auth";
import { useConfigStore } from "../../stores/config";
import { t } from "../../i18n";
import toast from "../../utils/toast";

const route = useRoute();
const auth = useAuthStore();
const config = useConfigStore();

const share = ref<MyShare | null>(null);
const name = ref("");
const description = ref("");
const saving = ref(false);

// ===== 有效期 =====
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

const expirationForm = reactive({ num: 1, unit: "days" });
// 初始快照：只有用户改动过有效期才提交 expiration，
// 否则会以"打开页面时刻"重新计算剩余时间，导致过期时间悄悄漂移
let expirationPristine = "";

// 非管理员受 share.maxExpiration 约束（0 = 无限制），与创建弹窗逻辑一致
const maxExpiration = computed(() =>
  auth.user?.isAdmin
    ? { value: 0, unit: "days" }
    : config.get("share.maxExpiration"),
);
const maxExpirationValue = computed(() =>
  maxExpiration.value?.value === 0 ? undefined : maxExpiration.value?.value,
);

// 后端读回的是绝对过期时间，这里反推 value+unit 以预填选择器
const prefillExpiration = (expiration: Date | string) => {
  const d = new Date(expiration);
  // 永不过期在后端以 1970 年的哨兵时间（NEVER_EXPIRES）表示
  if (d.getFullYear() <= 1970) return { num: 1, unit: "never" };
  const remainingMs = d.getTime() - Date.now();
  if (remainingMs <= 0) return { num: 1, unit: "minutes" }; // 已过期兜底，避免出现 0
  const table: Array<{ unit: string; ms: number }> = [
    { unit: "years", ms: 365 * 86400e3 },
    { unit: "months", ms: 30 * 86400e3 },
    { unit: "weeks", ms: 7 * 86400e3 },
    { unit: "days", ms: 86400e3 },
    { unit: "hours", ms: 3600e3 },
    { unit: "minutes", ms: 60e3 },
    { unit: "seconds", ms: 1e3 },
  ];
  for (const { unit, ms } of table) {
    if (remainingMs >= ms) return { num: Math.floor(remainingMs / ms), unit };
  }
  return { num: 1, unit: "seconds" };
};

// 过期时间预览（与创建弹窗一致）
const expiryDate = computed(() => {
  if (expirationForm.unit === "never") return null;
  const d = new Date();
  const n = expirationForm.num || 0;
  switch (expirationForm.unit) {
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

// ===== 安全选项 =====
const password = ref("");
const removePassword = ref(false);
const hadPassword = ref(false);
const maxViews = ref<number | null>(null);
// 初始快照：只有改动才提交 maxViews（null = 取消限制，未传 = 不改）
let maxViewsPristine: number | null = null;

// 标题优先显示分享名；键值 "编辑 {shareId}" 带占位符，必须传参（否则页面直接渲染 "{shareId}"）
const shareId = route.params.shareId as string;
const pageTitle = computed(() => share.value?.name || t("share.edit.title", { shareId }));

onMounted(async () => {
  try {
    share.value = await shareService.getFromOwner(shareId);
    name.value = share.value.name ?? "";
    description.value = share.value.description ?? "";

    // 有效期预填；快照在赋值后取，避免选择器自动钳制造成"未改动也提交"
    const prefill = prefillExpiration(share.value.expiration);
    expirationForm.num = prefill.num;
    expirationForm.unit = prefill.unit;
    expirationPristine =
      expirationForm.unit === "never"
        ? "never"
        : `${expirationForm.num}${expirationForm.unit}`;

    // 安全选项预填
    hadPassword.value = share.value.security.passwordProtected;
    maxViews.value = share.value.security.maxViews ?? null;
    maxViewsPristine = share.value.security.maxViews ?? null;
  } catch (e) {
    toast.axiosError(e);
  }
});

const save = async () => {
  saving.value = true;
  try {
    const payload: UpdateShare = {
      name: name.value || null,
      description: description.value || null,
    };

    // 有效期：仅改动过才提交
    const currentExpiration =
      expirationForm.unit === "never"
        ? "never"
        : `${expirationForm.num}${expirationForm.unit}`;
    if (currentExpiration !== expirationPristine) {
      payload.expiration = currentExpiration;
    }

    // 安全选项增量：有新密码 → 改密码；勾选移除 → 删密码（后端 removePassword 优先）
    const security: NonNullable<UpdateShare["security"]> = {};
    if (password.value) {
      security.password = password.value;
    } else if (hadPassword.value && removePassword.value) {
      security.removePassword = true;
    }
    if (maxViews.value !== maxViewsPristine) {
      security.maxViews = maxViews.value; // null = 取消限制
    }
    if (Object.keys(security).length > 0) {
      payload.security = security;
    }

    await shareService.update(shareId, payload);
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

      <!-- 有效期 -->
      <div class="field-label field-gap">{{ t("upload.modal.expires.label") }}</div>
      <div class="inline-row">
        <el-input-number v-if="expirationForm.unit !== 'never'" v-model="expirationForm.num" :min="1"
          :max="maxExpirationValue ?? 99999" class="grow" />
        <el-select v-model="expirationForm.unit" class="grow">
          <el-option v-for="o in units" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </div>
      <div class="field-note">{{ expirationNote }}</div>

      <!-- 密码 -->
      <div class="field-label field-gap">{{ t("upload.modal.accordion.security.password.label") }}</div>
      <el-checkbox v-if="hadPassword" v-model="removePassword">
        {{ t("share.edit.password.remove") }}
      </el-checkbox>
      <el-input v-model="password" type="password" show-password :disabled="removePassword"
        :placeholder="t('upload.modal.accordion.security.password.placeholder')" />
      <div v-if="hadPassword" class="field-note">{{ t("share.edit.password.hint") }}</div>

      <!-- 最大访问次数 -->
      <div class="field-label field-gap">{{ t("upload.modal.accordion.security.max-views.label") }}</div>
      <el-input-number v-model="maxViews" :min="1" class="full-width"
        :placeholder="t('upload.modal.accordion.security.max-views.placeholder')" />
      <div class="field-note">{{ t("share.edit.max-views.hint") }}</div>

      <el-button type="primary" :loading="saving" class="submit-btn" @click="save">
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

.inline-row {
  display: flex;
  gap: 8px;
}

.grow {
  flex: 1;
}

.full-width {
  width: 100%;
}

.field-label {
  font-size: var(--app-font-md);
  font-weight: 500;
  color: var(--app-text-1);
  margin-bottom: -6px;
}

.field-gap {
  margin-top: 8px;
}

.field-note {
  font-size: var(--app-font-xs);
  color: var(--app-text-3);
}

.submit-btn {
  margin-top: 8px;
}
</style>
