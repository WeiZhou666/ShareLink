<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import authService from "../../api/auth.service";
import { t } from "../../i18n";
import toast from "../../utils/toast";
import AuthShell from "../../components/AuthShell.vue";

const router = useRouter();
const email = ref("");
const loading = ref(false);

const onSubmit = async () => {
  loading.value = true;
  try {
    await authService.requestResetPassword(email.value.trim());
    toast.success(t("resetPassword.notify.success"));
    // 进入验证码回填页（?email= 驱动，与注册激活 /auth/verify 同构）
    router.push({ path: "/auth/resetPassword/verify", query: { email: email.value.trim() } });
  } catch (e) {
    toast.axiosError(e);
  } finally {
    loading.value = false;
  }
};
</script>

<template>
  <AuthShell>
    <h1 class="auth-title">{{ t("resetPassword.title") }}</h1>
    <el-form label-position="top" @submit.prevent="onSubmit">
      <el-form-item :label="t('resetPassword.input.email')">
        <el-input v-model="email" />
      </el-form-item>
      <el-button native-type="submit" type="primary" class="auth-submit" :loading="loading" :disabled="!email">
        {{ t("resetPassword.button.submit") }}
      </el-button>
    </el-form>
  </AuthShell>
</template>
