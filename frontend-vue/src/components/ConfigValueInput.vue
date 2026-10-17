<script setup lang="ts">
// 配置值选择器：filesize / timespan 两类「带单位」配置项的编辑控件
// - el-select filterable + allow-create：点选常用值，或直接输入自定义值（如 "512 MB" / "2 weeks"）
// - filesize 用 1000 进制（KB=1e3, MB=1e6, GB=1e9）；展示单位取「能整除的最大单位」，
//   保证加载回显与编辑回写不变形（10000000 → "10 MB" → 10000000）
// - timespan 特例 "never" 显示为「永不」（与后端 updateMany 的正则白名单一致），
//   数字+单位按 "<数值> <单位>" 原样透传（minutes/hours/days/weeks/months/years）
// - 解析失败：toast 警告并回退到当前合法值，避免脏数据写进 Config 表
import { ref, watch } from "vue";
import { t } from "../i18n";
import toast from "../utils/toast";

const props = defineProps<{
  modelValue: string;
  type: "filesize" | "timespan";
  disabled?: boolean;
}>();
const emit = defineEmits<{ (e: "update:modelValue", v: string): void }>();

const SIZE_UNITS: Array<[string, number]> = [
  ["B", 1],
  ["KB", 1e3],
  ["MB", 1e6],
  ["GB", 1e9],
];

/** 字节数 → "10 MB"：从大到小找第一个整除的单位（最大 1000 进制换算） */
const bytesToDisplay = (bytes: number) => {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return String(bytes);
  for (const [unit, factor] of [...SIZE_UNITS].reverse()) {
    if (n % factor === 0) return `${n / factor} ${unit}`;
  }
  return `${n} B`;
};

/** 当前值的展示串（作为选中项） */
const displayOf = (value: string) => {
  if (props.type === "filesize") return bytesToDisplay(parseInt(value, 10));
  return value === "never" ? t("admin.config.valueNever") : value;
};

/** "512 MB" / "100000 B" → 字节数；不合法返回 null */
const parseSize = (raw: string): number | null => {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i);
  if (!m) return null;
  const factor = SIZE_UNITS.find(([u]) => u.toLowerCase() === m[2].toLowerCase())![1];
  return Math.round(parseFloat(m[1]) * factor);
};

/** timespan 合法性（与后端正则同源）；合法返回归一化字符串 */
const parseTimespan = (raw: string): string | null => {
  const v = raw.trim();
  if (v === "never") return "never";
  const m = v.match(/^(\d+)\s*(minutes|hours|days|weeks|months|years)$/i);
  if (!m) return null;
  return `${m[1]} ${m[2].toLowerCase()}`;
};

// 常用值下拉（当前展示值始终作为一个选项，保证回显）
const options = ref<Array<{ value: string; label: string }>>([]);
const rebuildOptions = () => {
  const current = displayOf(props.modelValue);
  const presets =
    props.type === "filesize"
      ? ["1 MB", "10 MB", "50 MB", "100 MB", "500 MB", "1 GB", "5 GB", "10 GB"]
      : ["never", "1 hour", "6 hours", "1 day", "3 days", "7 days", "30 days", "90 days", "1 year"];
  options.value = presets
    .map((v) => ({ value: v, label: v === "never" ? t("admin.config.valueNever") : v }))
    .filter((o, i, arr) => o.value !== current || arr.findIndex((x) => x.value === current) === i);
  if (!options.value.some((o) => o.value === current)) {
    options.value.unshift({ value: current, label: current });
  }
};

const selected = ref(displayOf(props.modelValue));
watch(
  () => props.modelValue,
  () => {
    selected.value = displayOf(props.modelValue);
    rebuildOptions();
  },
  { immediate: true },
);

const onChange = (raw: string) => {
  const parsed =
    props.type === "filesize"
      ? (() => { const bytes = parseSize(raw); return bytes === null ? null : String(bytes); })()
      : parseTimespan(raw);
  if (parsed === null) {
    toast.warning(t(props.type === "filesize" ? "admin.config.sizeInvalid" : "admin.config.timespanInvalid"));
    selected.value = displayOf(props.modelValue); // 回退当前合法值
    return;
  }
  if (parsed !== props.modelValue) emit("update:modelValue", parsed);
};
</script>

<template>
  <el-select v-model="selected" class="value-select" filterable allow-create default-first-option :disabled="disabled"
    :placeholder="t('admin.config.valuePlaceholder')" @change="onChange">
    <el-option v-for="opt in options" :key="opt.value" :value="opt.value" :label="opt.label" />
  </el-select>
</template>

<style scoped>
.value-select {
  max-width: 300px;
}
</style>
