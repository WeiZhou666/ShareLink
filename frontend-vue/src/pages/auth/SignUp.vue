<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import authService from "../../api/auth.service";
import { useAuthStore } from "../../stores/auth";
import { useConfigStore } from "../../stores/config";
import AuthShell from "../../components/AuthShell.vue";
import { t } from "../../i18n";
import toast from "../../utils/toast";

const router = useRouter();
const auth = useAuthStore();
const config = useConfigStore();

const form = ref({ email: "", username: "", password: "" });
const loading = ref(false);

// backend-nest 尚无 config 模块，store 走兜底配置（isFallback=true，allowRegistration 默认 "false"）
// ——兜底模式下注册视为开启；待 config 模块迁移后，仅当真实配置显式为 true 才开启
const allowRegistration = computed(
  () => config.isFallback || config.get("security.allowRegistration") === true,
);

const onSubmit = async () => {
  loading.value = true;
  try {
    const { data } = await authService.signUp(
      form.value.email.trim(),
      form.value.username.trim(),
      form.value.password.trim(),
    );
    if (data?.verificationRequired) {
      // 需邮箱验证：带 email 跳验证码回填页（6 位码走 POST /auth/verifyEmail）
      toast.success(t("verify.info.resend.success"));
      router.push({ path: "/auth/verify", query: { email: form.value.email.trim() } });
    } else {
      // 未启用邮箱验证：注册即登录（cookie 已由后端 Set-Cookie 下发），直接进主界面
      await auth.refreshUser();
      toast.success(t("signup.notify.success"));
      router.push("/upload");
    }
  } catch (e) {
    toast.axiosError(e);
  } finally {
    loading.value = false;
  }
};
</script>

<template>
  <AuthShell>
    <template v-if="allowRegistration">
      <h2 class="auth-title">{{ t("signup.title") }}</h2>
      <p class="auth-subtitle">{{ t("signup.subtitle") }}</p>
      <el-form label-position="top" @submit.prevent="onSubmit">
        <el-form-item :label="t('signup.input.email')">
          <el-input v-model="form.email" size="large" :placeholder="t('signup.input.email.placeholder')" />
        </el-form-item>
        <el-form-item :label="t('signup.input.username')">
          <el-input v-model="form.username" size="large" :placeholder="t('signup.input.username.placeholder')" />
        </el-form-item>
        <el-form-item :label="t('signup.input.password')">
          <el-input v-model="form.password" type="password" :placeholder="t('signup.input.password.placeholder')" show-password size="large" />
        </el-form-item>
        <el-button native-type="submit" type="primary" size="large" class="auth-submit signup-submit"
          :loading="loading" :disabled="!form.email || !form.username || !form.password">
          {{ t("signup.button.submit") }}
        </el-button>
        <div class="auth-links">
          <span>{{ t("signup.description") }}</span>
          <a href="/auth/signIn">{{ t("signup.button.signin") }}</a>
        </div>
      </el-form>
    </template>
    <el-result v-else status="403" :title="t('signup.error.disabled.title')" />
  </AuthShell>
</template>

<style scoped>
/* 提交按钮与上方表单拉开小间距 */
.signup-submit {
  margin-top: 4px;
}
</style>
