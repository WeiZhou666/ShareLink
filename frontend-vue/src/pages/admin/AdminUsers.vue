<script setup lang="ts">
// 管理端用户管理：分页列表 + 搜索 + 设/撤管理员 + 启用/禁用 + 重置密码 + 踢下线 + 删除
// 对接 backend-nest /api/admin/users*（后端保护：不能改自己 isAdmin / 删自己 / 删最后一个管理员）
import { onMounted, reactive, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { Search } from "@element-plus/icons-vue";
import adminService from "../../api/admin.service";
import { useAuthStore } from "../../stores/auth";
import { t } from "../../i18n";
import toast from "../../utils/toast";

interface AdminUserRow {
  id: string;
  createdAt: string;
  username: string;
  email: string;
  isAdmin: boolean;
  isActivated: boolean;
}

const auth = useAuthStore();
const rows = ref<AdminUserRow[]>([]);
const loading = ref(true);
const query = reactive({ page: 1, pageSize: 20, keyword: "" });
const total = ref(0);

// 自我保护行：改自己 isAdmin / 禁用自己 / 删自己在后端都是 400，UI 直接禁用并提示
const isSelf = (row: AdminUserRow) => row.id === auth.user?.id;

const load = async () => {
  loading.value = true;
  try {
    const data = await adminService.listUsers({
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword.trim() || undefined,
    });
    rows.value = data.list;
    total.value = data.total;
  } catch (e) {
    toast.axiosError(e);
  } finally {
    loading.value = false;
  }
};

const onSearch = () => {
  query.page = 1;
  load();
};

const onSizeChange = () => {
  query.page = 1;
  load();
};

/** 开关类操作（isAdmin/isActivated）：无论成败都重新拉列表，让开关视觉状态始终以后端为准（失败自动回滚） */
const toggle = async (row: AdminUserRow, field: "isAdmin" | "isActivated", value: boolean) => {
  try {
    await adminService.updateUser(row.id, { [field]: value });
    toast.success(t("admin.users.notify.update.success"));
  } catch (e) {
    toast.axiosError(e);
  } finally {
    await load();
  }
};

// ElMessageBox 取消时 reject 字符串 "cancel"/"close"，与业务错误区分
const dismissed = (e: unknown) => e === "cancel" || e === "close";

const confirmBox = async (titleKey: string, bodyKey: string, row: AdminUserRow) => {
  return ElMessageBox.confirm(t(bodyKey, { username: row.username }), t(titleKey, { username: row.username }), {
    confirmButtonText: t("common.button.confirm"),
    cancelButtonText: t("common.button.cancel"),
    confirmButtonClass: "el-button--danger",
    type: "warning",
  });
};

const resetPassword = async (row: AdminUserRow) => {
  try {
    const { value } = await ElMessageBox.prompt(
      t("admin.users.confirm.resetPrompt"),
      t("admin.users.confirm.resetTitle", { username: row.username }),
      {
        inputType: "password",
        inputValidator: (v: string) => (v.length >= 8 ? true : t("account.validation.passwordLength")),
        confirmButtonText: t("common.button.confirm"),
        cancelButtonText: t("common.button.cancel"),
      },
    );
    try {
      await adminService.resetPassword(row.id, value);
      toast.success(t("admin.users.notify.reset.success"));
    } catch (e) {
      toast.axiosError(e);
    }
  } catch (e) {
    if (!dismissed(e)) throw e;
  }
};

const revokeSessions = async (row: AdminUserRow) => {
  try {
    await confirmBox("admin.users.confirm.revokeTitle", "admin.users.confirm.revokeBody", row);
  } catch (e) {
    if (!dismissed(e)) throw e;
    return;
  }
  try {
    await adminService.revokeSessions(row.id);
    toast.success(t("admin.users.notify.revoke.success"));
  } catch (e) {
    toast.axiosError(e);
  }
};

const remove = async (row: AdminUserRow) => {
  try {
    await confirmBox("admin.users.confirm.deleteTitle", "admin.users.confirm.deleteBody", row);
  } catch (e) {
    if (!dismissed(e)) throw e;
    return;
  }
  try {
    await adminService.removeUser(row.id);
    toast.success(t("admin.users.notify.delete.success"));
    // 删的是本页最后一条时回退一页，避免停在空页
    if (rows.value.length === 1 && query.page > 1) query.page -= 1;
    await load();
  } catch (e) {
    toast.axiosError(e);
  }
};

const formatTime = (value: string) => new Date(value).toLocaleString();

onMounted(load);
</script>

<template>
  <div class="admin-users-page">
    <h2 class="page-title">{{ t("admin.users.title") }}</h2>

    <div class="page-toolbar">
      <el-input v-model="query.keyword" class="search-input" clearable
        :placeholder="t('admin.users.search.placeholder')" :prefix-icon="Search" @keyup.enter="onSearch"
        @clear="onSearch" />
    </div>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="rows" row-key="id">
        <el-table-column prop="username" :label="t('admin.users.table.username')" min-width="140" />
        <el-table-column prop="email" :label="t('admin.users.table.email')" min-width="200" show-overflow-tooltip />
        <el-table-column :label="t('admin.users.table.admin')" width="90" align="center">
          <template #default="{ row }: { row: AdminUserRow }">
            <el-tooltip :disabled="!isSelf(row)" :content="t('admin.users.selfHint')" placement="top">
              <span>
                <el-switch :model-value="row.isAdmin" :disabled="isSelf(row)"
                  @change="(v: string | number | boolean) => toggle(row, 'isAdmin', Boolean(v))" />
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column :label="t('admin.users.table.status')" width="90" align="center">
          <template #default="{ row }: { row: AdminUserRow }">
            <el-tooltip :disabled="!isSelf(row)" :content="t('admin.users.selfHint')" placement="top">
              <span>
                <el-switch :model-value="row.isActivated" :disabled="isSelf(row)"
                  @change="(v: string | number | boolean) => toggle(row, 'isActivated', Boolean(v))" />
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column :label="t('admin.users.table.createdAt')" width="170">
          <template #default="{ row }: { row: AdminUserRow }">
            {{ formatTime(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column :label="t('admin.users.table.actions')" width="220" align="right" fixed="right">
          <template #default="{ row }: { row: AdminUserRow }">
            <el-button text size="small" @click="resetPassword(row)">
              {{ t("admin.users.action.resetPassword") }}
            </el-button>
            <el-tooltip :disabled="!isSelf(row)" :content="t('admin.users.selfHint')" placement="top">
              <span>
                <el-button text size="small" :disabled="isSelf(row)" @click="revokeSessions(row)">
                  {{ t("admin.users.action.revokeSessions") }}
                </el-button>
              </span>
            </el-tooltip>
            <el-tooltip :disabled="!isSelf(row)" :content="t('admin.users.selfHint')" placement="top">
              <span>
                <el-button text size="small" type="danger" :disabled="isSelf(row)" @click="remove(row)">
                  {{ t("common.button.delete") }}
                </el-button>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-bar">
        <el-pagination v-model:current-page="query.page" v-model:page-size="query.pageSize" :total="total"
          :page-sizes="[10, 20, 50, 100]" layout="total, sizes, prev, pager, next" @current-change="load"
          @size-change="onSizeChange" />
      </div>
    </el-card>
  </div>
</template>

<style scoped>
/* 容器宽度/内边距由 App.vue workspace-main 统一承担，本页不再自设 */
.page-title {
  /* 字体规格走全局 .page-title，这里只管与内容的间距 */
  margin-bottom: 20px;
}

.page-toolbar {
  justify-content: flex-end;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
