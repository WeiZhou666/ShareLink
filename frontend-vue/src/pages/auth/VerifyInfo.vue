<script setup lang="ts">
import { t } from "../../i18n";
import AuthShell from "../../components/AuthShell.vue";
</script>

<template>
  <AuthShell wide>
    <el-result status="info" :title="t('verify.info.title')" :sub-title="t('verify.info.description')" />
  </AuthShell>
</template>
