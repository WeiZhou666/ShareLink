<script setup lang="ts">
// 账户中心：账号信息（用户名/邮箱）+ 修改密码，参考旧前端 account 页；
// 我的分享/反向分享/收到的分享由独立页面实现（依赖未迁移的 share 模块），暂不放入本页
import { computed, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import type { FormInstance, FormRules } from "element-plus";
import { useAuthStore } from "../../stores/auth";
import userService from "../../api/user.service";
import { t } from "../../i18n";
import toast from "../../utils/toast";

const auth = useAuthStore();
const router = useRouter();

// —— 账号信息 ——
const infoFormRef = ref<FormInstance>();
const savingInfo = ref(false);
const infoForm = reactive({
  username: auth.user?.username ?? "",
  email: auth.user?.email ?? "",
});
// 校验规则与后端 DTO 对齐：username 3-32 位、email 格式（后端 IsEmail，冲突 409 由 toast 提示）
const infoRules: FormRules = {
  username: [
    { required: true, message: t("account.validation.usernameRequired"), trigger: "blur" },
    { min: 3, max: 32, message: t("account.validation.usernameLength"), trigger: "blur" },
  ],
  email: [
    { required: true, message: t("account.validation.emailRequired"), trigger: "blur" },
    { type: "email", message: t("account.validation.emailInvalid"), trigger: ["blur", "change"] },
  ],
};
const saveInfo = async () => {
  if (!(await infoFormRef.value?.validate().catch(() => false))) return;
  savingInfo.value = true;
  try {
    await userService.updateCurrentUser({
      username: infoForm.username.trim(),
      email: infoForm.email.trim(),
    });
    await auth.refreshUser(); // 同步顶栏显示的用户名等
    toast.success(t("account.notify.info.success"));
  } catch (e) {
    toast.axiosError(e);
  } finally {
    savingInfo.value = false;
  }
};

// —— 修改密码 ——
// hasPassword 由后端 me 接口下发：已设密码者须验旧密码；OAuth 创建的无密码用户直接设置
const hasPassword = auth.user?.hasPassword ?? true;
const passwordFormRef = ref<FormInstance>();
const savingPassword = ref(false);
const passwordForm = reactive({ oldPassword: "", password: "" });
const passwordRules: FormRules = {
  oldPassword: hasPassword
    ? [{ required: true, message: t("account.validation.oldPasswordRequired"), trigger: "blur" }]
    : [],
  password: [
    { required: true, message: t("account.validation.passwordRequired"), trigger: "blur" },
    { min: 8, max: 64, message: t("account.validation.passwordLength"), trigger: "blur" },
  ],
};
const savePassword = async () => {
  if (!(await passwordFormRef.value?.validate().catch(() => false))) return;
  savingPassword.value = true;
  try {
    await userService.updatePassword(passwordForm.oldPassword, passwordForm.password);
    await auth.refreshUser(); // 无密码用户首次设密后 hasPassword 翻转为 true
    toast.success(t("account.notify.password.success"));
    passwordForm.oldPassword = "";
    passwordForm.password = "";
    passwordFormRef.value?.clearValidate(); // 清除校验残留状态
  } catch (e) {
    toast.axiosError(e);
  } finally {
    savingPassword.value = false;
  }
};

// —— 危险区：删除账号 ——
// 后端 DELETE /users/me 语义：清名下分享的磁盘文件 → 吊销全部会话 → 删用户行 → 清认证 Cookie
const currentUsername = auth.user?.username ?? "";
const deleteDialogVisible = ref(false);
const deleting = ref(false);
const deleteConfirmInput = ref("");
// 必须原样输入自己的用户名才能点亮确认按钮（防止误点 + 强制用户意识到后果）
const canDelete = computed(() => deleteConfirmInput.value.trim() === currentUsername);

const openDeleteDialog = () => {
  deleteConfirmInput.value = ""; // 每次打开都重置，避免上次残留输入直接可点
  deleteDialogVisible.value = true;
};

const deleteAccount = async () => {
  deleting.value = true;
  try {
    await userService.removeCurrentUser();
    auth.setUser(null); // Cookie 已由后端清除，本地登录态同步置空（侧栏/顶栏随 isAuthenticated 收起）
    toast.success(t("account.danger.notify.deleted"));
    deleteDialogVisible.value = false;
    router.push("/auth/signIn");
  } catch (e) {
    // 失败弹窗保持打开，用户可重试（如"最后一个管理员"会被 400 拦截，toast 显示原因）
    toast.axiosError(e);
  } finally {
    deleting.value = false;
  }
};
</script>

<template>
  <div class="account-page">
    <h2 class="page-title">{{ t("account.title") }}</h2>

    <el-card shadow="never" class="account-card">
      <template #header>
        <div class="card-head">
          <p class="card-title">{{ t("account.card.info.title") }}</p>
          <p class="card-desc">{{ t("account.card.info.description") }}</p>
        </div>
      </template>
      <el-form ref="infoFormRef" :model="infoForm" :rules="infoRules" label-position="top" @submit.prevent="saveInfo">
        <el-form-item prop="username" :label="t('account.card.info.username')">
          <el-input v-model="infoForm.username" maxlength="32" />
        </el-form-item>
        <el-form-item prop="email" :label="t('account.card.info.email')">
          <el-input v-model="infoForm.email" />
        </el-form-item>
        <div class="form-actions">
          <el-button type="primary" native-type="submit" :loading="savingInfo"
            :disabled="infoForm.username.trim().length < 3 || !infoForm.email.trim()">
            {{ t("common.button.save") }}
          </el-button>
        </div>
      </el-form>
    </el-card>

    <el-card shadow="never" class="account-card">
      <template #header>
        <div class="card-head">
          <p class="card-title">{{ t("account.card.password.title") }}</p>
          <p class="card-desc">{{ t("account.card.password.description") }}</p>
        </div>
      </template>
      <el-form ref="passwordFormRef" :model="passwordForm" :rules="passwordRules" label-position="top"
        @submit.prevent="savePassword">
        <el-form-item v-if="hasPassword" prop="oldPassword" :label="t('account.card.password.old')">
          <el-input v-model="passwordForm.oldPassword" type="password" show-password />
        </el-form-item>
        <p v-else class="no-password-hint">{{ t("account.card.password.noPasswordSet") }}</p>
        <el-form-item prop="password" :label="t('account.card.password.new')">
          <el-input v-model="passwordForm.password" type="password" show-password placeholder="········" />
        </el-form-item>
        <div class="form-actions">
          <el-button type="primary" native-type="submit" :loading="savingPassword"
            :disabled="passwordForm.password.length < 8 || (hasPassword && !passwordForm.oldPassword)">
            {{ t("common.button.save") }}
          </el-button>
        </div>
      </el-form>
    </el-card>

    <!-- 危险区：红色描边卡片 + 弱化说明，按钮 plain 弱化视觉、确认弹窗强制输入用户名 -->
    <el-card shadow="never" class="account-card danger-card">
      <template #header>
        <div class="card-head">
          <p class="card-title danger-title">{{ t("account.danger.title") }}</p>
          <p class="card-desc">{{ t("account.danger.description") }}</p>
        </div>
      </template>
      <el-button type="danger" plain @click="openDeleteDialog">{{ t("account.danger.button") }}</el-button>
    </el-card>

    <!-- 删除确认弹窗：要求原样输入用户名才可提交 -->
    <el-dialog v-model="deleteDialogVisible" :title="t('account.danger.modal.title')" width="420px"
      :close-on-click-modal="false">
      <el-alert :title="t('account.danger.modal.warning')" type="error" :closable="false" show-icon />
      <p class="danger-hint">{{ t("account.danger.modal.confirmHint", { username: currentUsername }) }}</p>
      <el-input v-model="deleteConfirmInput" :placeholder="currentUsername" />
      <template #footer>
        <el-button @click="deleteDialogVisible = false">{{ t("common.button.cancel") }}</el-button>
        <el-button type="danger" :loading="deleting" :disabled="!canDelete" @click="deleteAccount">
          {{ t("account.danger.modal.confirm") }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.account-page {
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 16px 48px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.page-title {
  font-size: var(--app-font-xl);
  font-weight: 600;
  margin: 0;
}

.card-head {
  line-height: 1.4;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}

.card-desc {
  font-size: var(--app-font-sm);
  color: var(--app-text-2);
  margin: 2px 0 0;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
}

.no-password-hint {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin: 0 0 12px;
}

/* 危险区：红色描边 + 标题标红，与普通卡片形成视觉反差 */
.danger-card {
  --el-card-border-color: var(--el-color-danger-light-5);
}

.danger-title {
  color: var(--el-color-danger);
}

.danger-hint {
  font-size: 13px;
  margin: 14px 0 8px;
}
</style>
