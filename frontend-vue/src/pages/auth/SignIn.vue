<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import authService from "../../api/auth.service";
import { useAuthStore } from "../../stores/auth";
import { useConfigStore } from "../../stores/config";
import AuthShell from "../../components/AuthShell.vue";
import { t } from "../../i18n";
import toast from "../../utils/toast";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const configStore = useConfigStore();

const form = ref({ emailOrUsername: "", password: "" });
const loading = ref(false);
// 软删冷静期：登录命中"已注销"账号时置 true，展示恢复入口（凭 error === "account_deleted" 判定，
// 不用 403 状态码判——signIn 链路还有其他 403 可能，错误码才是稳定协议）
const accountDeleted = ref(false);
const recovering = ref(false);

const redirectPath = (route.query.redirect as string) ?? "/upload";

// 登录页公开的第三方登录方式（配置驱动，逗号分隔列表）
const openProviders = computed(() =>
  String(configStore.get("oauth.openProviders") ?? "").split(",").map((s) => s.trim()),
);

// OAuth 回调失败时后端 302 回这里并带 error=oauth_failed（详情只在服务端日志，防枚举）
onMounted(() => {
  if (route.query.error === "oauth_failed") {
    toast.error(t("signin.notify.oauth-failed"));
  }
});

const onSubmit = async () => {
  loading.value = true;
  try {
    const response = await authService.signIn(
      form.value.emailOrUsername.trim(),
      form.value.password.trim(),
    );
    if (response.data["loginToken"]) {
      toast.info(t("signIn.notify.totp-required.description"));
      router.push(
        `/auth/totp/${response.data["loginToken"]}?redirect=${encodeURIComponent(redirectPath)}`,
      );
    } else {
      await auth.refreshUser();
      router.replace(redirectPath);
    }
  } catch (e) {
    // 命中已注销账号：收起常规错误 toast，展示冷静期恢复入口（用同一份表单凭据恢复）
    if ((e as any)?.response?.data?.error === "account_deleted") {
      accountDeleted.value = true;
    } else {
      toast.axiosError(e);
    }
  } finally {
    loading.value = false;
  }
};

// 一键恢复：复用登录表单里的邮箱/用户名 + 密码调恢复接口，成功即直接登录
const onRecover = async () => {
  recovering.value = true;
  try {
    await authService.recoverAccount(
      form.value.emailOrUsername.trim(),
      form.value.password.trim(),
    );
    await auth.refreshUser();
    toast.success(t("signin.notify.recovered"));
    router.replace(redirectPath);
  } catch (e) {
    // 恢复失败（凭据错/冷静期已过/用户名被占用）走常规错误提示，恢复入口保持展示
    toast.axiosError(e);
  } finally {
    recovering.value = false;
  }
};
</script>

<template>
  <AuthShell>
    <h2 class="auth-title">{{ t("signin.title") }}</h2>
    <p class="auth-subtitle">{{ t("signin.description") }}</p>
    <el-form label-position="top" @submit.prevent="onSubmit">
      <el-form-item :label="t('signin.input.email-or-username')">
        <el-input v-model="form.emailOrUsername" size="large"
          :placeholder="t('signin.input.email-or-username.placeholder')" />
      </el-form-item>
      <el-form-item :label="t('signin.input.password')">
        <el-input v-model="form.password" type="password" show-password size="large"
          :placeholder="t('signin.input.password.placeholder')" />
      </el-form-item>
      <el-button native-type="submit" type="primary" size="large" class="auth-submit signin-submit" :loading="loading"
        :disabled="!form.emailOrUsername || !form.password">
        {{ t("signin.button.submit") }}
      </el-button>
    </el-form>
    <!-- 软删冷静期恢复入口：登录命中已注销账号后展示（文案含半年冷静期说明） -->
    <el-alert v-if="accountDeleted" type="warning" :closable="false" show-icon class="recover-alert">
      <template #title>{{ t("signin.recover.title") }}</template>
      <p class="recover-text">{{ t("signin.recover.description") }}</p>
      <el-button type="warning" size="small" :loading="recovering" @click="onRecover">
        {{ t("signin.recover.button") }}
      </el-button>
    </el-alert>
    <div class="auth-links">
      <a href="/auth/signUp">{{ t("signin.button.signup") }}</a>
      <a href="/auth/resetPassword">{{ t("resetPassword.title") }}</a>
    </div>
    <el-divider v-if="openProviders.includes('github')"><span class="oauth-divider">{{ t("signin.oauth.divider")
    }}</span></el-divider>
    <!-- 整页跳转到后端发起端点：后端 302 到 GitHub 授权页，回调后种 cookie 并 302 回首页 -->
    <!-- 显示开关由配置驱动：oauth.openProviders（admin 可改，兜底默认 github） -->
    <a v-if="openProviders.includes('github')" class="oauth-github" href="/api/oauth/github" data-testid="github-login">
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
        <path
          d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
      </svg>
      {{ t("signin.oauth.github") }}
    </a>
  </AuthShell>
</template>

<style scoped>
/* 提交按钮与上方表单拉开小间距 */
.signin-submit {
  margin-top: 4px;
}

/* 软删冷静期恢复提示条：与上下元素拉开间距，正文小字弱化 */
.recover-alert {
  margin-top: 16px;
}

.recover-text {
  margin: 4px 0 8px;
  font-size: 13px;
  line-height: 1.5;
}

.oauth-divider {
  font-size: 12px;
  color: var(--app-text-3);
}

.oauth-github {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 10px 0;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-md);
  color: var(--app-text-1);
  text-decoration: none;
  font-size: var(--app-font-md);
  transition: border-color 0.2s, background-color 0.2s;
}

.oauth-github:hover {
  border-color: var(--el-color-primary);
  background-color: var(--app-bg-subtle);
}
</style>
