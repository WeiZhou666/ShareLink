<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import authService from "../../api/auth.service";
import AuthShell from "../../components/AuthShell.vue";
import { t } from "../../i18n";
import toast from "../../utils/toast";

// 新后端为 6 位验证码方案：注册成功后携带 ?email= 跳转到本页回填验证码，
// 不再是旧方案的“邮件里的验证链接”（因此没有 token 参数、也没有自动验证）
const route = useRoute();
const router = useRouter();

const email = computed(() => (route.query.email as string) ?? "");
const code = ref("");
const loading = ref(false);
const resending = ref(false);
const activated = ref(false);

const onSubmit = async () => {
  loading.value = true;
  try {
    await authService.verifyEmail(email.value.trim(), code.value.trim());
    activated.value = true;
  } catch (e) {
    toast.axiosError(e);
  } finally {
    loading.value = false;
  }
};

const onResend = async () => {
  resending.value = true;
  try {
    await authService.resendVerification(email.value.trim());
    toast.success(t("verify.info.resend.success"));
  } catch (e) {
    toast.axiosError(e);
  } finally {
    resending.value = false;
  }
};
</script>

<template>
  <AuthShell>
    <el-result v-if="!email" status="warning" :title="t('verify.missingEmail.title')">
      <template #sub-title>
        <span>{{ t("verify.missingEmail.description") }}</span>
      </template>
      <template #footer>
        <el-button type="primary" @click="router.push('/auth/signUp')">{{
          t("navbar.signup")
        }}</el-button>
      </template>
    </el-result>

    <el-result v-else-if="activated" status="success"
      :title="t('account.notify.account-activated.title')">
      <template #footer>
        <el-button type="primary" @click="router.push('/auth/signIn')">{{
          t("verify.button.signin")
        }}</el-button>
      </template>
    </el-result>

    <template v-else>
      <h2 class="auth-title">{{ t("verify.title") }}</h2>
      <p class="auth-subtitle">{{ t("verify.info.description", { email }) }}</p>
      <el-form label-position="top" @submit.prevent="onSubmit">
        <el-form-item :label="t('verify.input.code')">
          <el-input v-model="code" maxlength="6" size="large" class="verify-code"
            :placeholder="t('verify.input.placeholder')" />
        </el-form-item>
        <div class="verify-actions">
          <el-button native-type="submit" type="primary" size="large" :loading="loading"
            :disabled="code.trim().length !== 6">
            {{ t("verify.button.submit") }}
          </el-button>
          <el-button text :loading="resending" @click="onResend">
            {{ t("verify.info.resend.button") }}
          </el-button>
        </div>
      </el-form>
      <p class="verify-note">
        {{ t("verify.info.note") }}
      </p>
    </template>
  </AuthShell>
</template>

<style scoped>
/* 验证码输入：字距拉开居中呈现 6 位码 */
.verify-code :deep(input) {
  letter-spacing: 0.4em;
  font-size: 1.1rem;
  text-align: center;
}

.verify-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.verify-note {
  margin: 14px 0 0;
  color: var(--app-text-3);
  font-size: var(--app-font-xs);
}
</style>
