<script setup lang="ts">
import { computed } from "vue";
import { useConfigStore } from "../stores/config";

const props = defineProps<{ type: "privacyPolicy" | "imprint" }>();
const config = useConfigStore();

const text = computed(() =>
  props.type === "imprint"
    ? config.get("legal.imprintText")
    : config.get("legal.privacyPolicyText"),
);
</script>

<template>
  <el-card shadow="never" class="legal-card">
    <div class="legal-text">{{ text }}</div>
  </el-card>
</template>

<style scoped>
.legal-card {
  margin-top: 8px;
}

.legal-text {
  white-space: pre-wrap;
  color: var(--app-text-1);
  line-height: 1.7;
}
</style>
