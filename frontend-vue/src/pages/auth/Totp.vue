<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import authService from "../../api/auth.service";
import { useAuthStore } from "../../stores/auth";
import { t } from "../../i18n";
import toast from "../../utils/toast";
import AuthShell from "../../components/AuthShell.vue";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const totp = ref("");
const loading = ref(false);
const redirectPath = (route.query.redirect as string) ?? "/upload";

const onSubmit = async () => {
  loading.value = true;
  try {
    await authService.signInTotp(totp.value.trim(), route.params.loginToken as string);
    await auth.refreshUser();
    router.replace(redirectPath);
  } catch (e) {
    toast.axiosError(e);
  } finally {
    loading.value = false;
  }
};
</script>

<template>
  <AuthShell>
    <h1 class="auth-title">{{ t("totp.title") }}</h1>
    <el-form label-position="top" @submit.prevent="onSubmit">
      <el-form-item :label="t('totp.input.totp')">
        <el-input v-model="totp" maxlength="6" />
      </el-form-item>
      <el-button
        native-type="submit"
        type="primary"
        class="auth-submit"
        :loading="loading"
        :disabled="totp.length < 6"
      >
        {{ t("totp.button.submit") }}
      </el-button>
    </el-form>
  </AuthShell>
</template>
