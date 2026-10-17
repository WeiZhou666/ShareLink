<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import authService from "../../api/auth.service";
import { t } from "../../i18n";
import toast from "../../utils/toast";
import AuthShell from "../../components/AuthShell.vue";

// 密码重置验证码回填页（?email= 驱动，与注册激活 /auth/verify 同构）：
// 邮箱 + 6 位验证码 + 新密码，POST body 提交——验证码方案没有 URL 链接，
// 不受邮件商安全跳转拦截/预扫描提前消费影响
const route = useRoute();
const router = useRouter();
const email = ref((route.query.email as string) ?? "");
const code = ref("");
const password = ref("");
const loading = ref(false);

const onSubmit = async () => {
  loading.value = true;
  try {
    await authService.resetPassword(email.value.trim(), code.value.trim(), password.value);
    toast.success(t("resetPassword.notify.reset-success"));
    router.push("/auth/signIn");
  } catch (e) {
    toast.axiosError(e);
  } finally {
    loading.value = false;
  }
};
</script>

<template>
  <AuthShell>
    <h1 class="auth-title">{{ t("resetPassword.text.resetPassword") }}</h1>
    <el-form label-position="top" @submit.prevent="onSubmit">
      <el-form-item :label="t('resetPassword.input.email')">
        <el-input v-model="email" />
      </el-form-item>
      <el-form-item :label="t('resetPassword.input.code')">
        <el-input v-model="code" maxlength="6" :placeholder="t('resetPassword.description.code')" />
      </el-form-item>
      <el-form-item :label="t('resetPassword.input.password')">
        <el-input v-model="password" type="password" show-password />
      </el-form-item>
      <el-button native-type="submit" type="primary" class="auth-submit" :loading="loading"
        :disabled="email.length < 6 || code.length !== 6 || !password">
        {{ t("resetPassword.button.reset") }}
      </el-button>
    </el-form>
  </AuthShell>
</template>
