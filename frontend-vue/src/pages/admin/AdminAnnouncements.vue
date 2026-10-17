<script setup lang="ts">
// 公告管理页：发布/删除面向全体登录用户的运营公告。
// 公告弹窗由 App.vue 的强制确认弹窗统一展示（kind=announcement），本页只做 CRUD。
import { computed, onMounted, ref } from "vue";
import { ElMessageBox } from "element-plus";
import announcementService, {
  type Announcement,
} from "../../api/announcement.service";
import toast from "../../utils/toast";
import { t } from "../../i18n";
import { Delete, Edit, Promotion } from "@element-plus/icons-vue";

// 与 AccountShares 同款轻量格式化（项目无独立日期格式化 util）
const formatTime = (value: string | Date) => new Date(value).toLocaleString();

const announcements = ref<Announcement[]>([]);
const loading = ref(false);

// 发布表单
const form = ref({ title: "", message: "", actionLink: "" });
const publishing = ref(false);
const canPublish = computed(
  () => form.value.title.trim() !== "" && form.value.message.trim() !== "",
);

const load = async () => {
  loading.value = true;
  try {
    announcements.value = (await announcementService.list()) ?? [];
  } catch (e) {
    toast.axiosError(e);
  } finally {
    loading.value = false;
  }
};

const publish = async () => {
  if (!canPublish.value) return;
  publishing.value = true;
  try {
    await announcementService.create({
      title: form.value.title.trim(),
      message: form.value.message.trim(),
      // 链接可选项：空串归一化为 undefined，后端落 null
      ...(form.value.actionLink.trim()
        ? { actionLink: form.value.actionLink.trim() }
        : {}),
    });
    toast.success(t("admin.announcements.toast.published"));
    form.value = { title: "", message: "", actionLink: "" };
    await load();
  } catch (e) {
    toast.axiosError(e);
  } finally {
    publishing.value = false;
  }
};

const removeAnnouncement = async (item: Announcement) => {
  try {
    await announcementService.remove(item.id);
    toast.success(t("admin.announcements.toast.deleted"));
    await load();
  } catch (e) {
    toast.axiosError(e);
  }
};

const confirmRemove = (item: Announcement) => {
  // 删除不可逆：已读记录级联清理，未读用户也不再收到
  ElMessageBox.confirm(t("admin.announcements.delete.confirm"), {
    confirmButtonText: t("common.button.delete"),
    cancelButtonText: t("common.button.cancel"),
    type: "warning",
  })
    .then(() => removeAnnouncement(item))
    .catch(() => { });
};

// ===== 编辑弹窗：字段与发布表单一致，保存后已读记录保留（已读用户不再弹） =====
const editDialogVisible = ref(false);
const editingItem = ref<Announcement | null>(null);
const editForm = ref({ title: "", message: "", actionLink: "" });
const saving = ref(false);
const canSave = computed(
  () => editForm.value.title.trim() !== "" && editForm.value.message.trim() !== "",
);

const openEdit = (item: Announcement) => {
  editingItem.value = item;
  // actionLink 为 null 时填空串，输入框受控才正常
  editForm.value = {
    title: item.title,
    message: item.message,
    actionLink: item.actionLink ?? "",
  };
  editDialogVisible.value = true;
};

const saveEdit = async () => {
  if (!editingItem.value || !canSave.value) return;
  saving.value = true;
  try {
    await announcementService.update(editingItem.value.id, {
      title: editForm.value.title.trim(),
      message: editForm.value.message.trim(),
      // 链接可选项：空串归一化为 undefined，后端落 null
      ...(editForm.value.actionLink.trim()
        ? { actionLink: editForm.value.actionLink.trim() }
        : {}),
    });
    toast.success(t("admin.announcements.toast.updated"));
    editDialogVisible.value = false;
    await load();
  } catch (e) {
    toast.axiosError(e);
  } finally {
    saving.value = false;
  }
};

const readCount = (item: Announcement) =>
  t("admin.announcements.list.readCount", { count: item._count?.reads ?? 0 });

onMounted(load);
</script>

<template>
  <el-card class="announcements-card">
    <template #header>
      <span class="card-title">{{ t("admin.announcements.title") }}</span>
    </template>

    <!-- 发布表单 -->
    <div class="publish-form">
      <el-input v-model="form.title" :placeholder="t('admin.announcements.form.titlePlaceholder')" maxlength="100"
        show-word-limit />
      <el-input v-model="form.message" type="textarea" :rows="4"
        :placeholder="t('admin.announcements.form.messagePlaceholder')" maxlength="2000" show-word-limit />
      <div class="publish-row">
        <el-input v-model="form.actionLink" :placeholder="t('admin.announcements.form.actionLinkPlaceholder')"
          maxlength="500">
          <template #prepend>{{ t("admin.announcements.form.actionLink") }}</template>
        </el-input>
        <el-button type="primary" :icon="Promotion" :disabled="!canPublish" :loading="publishing" @click="publish">
          {{ t("admin.announcements.form.publish") }}
        </el-button>
      </div>
    </div>

    <!-- 已发布公告列表 -->
    <div class="list-title">{{ t("admin.announcements.list.title") }}</div>
    <div v-if="announcements.length === 0" class="empty">
      {{ t("admin.announcements.list.empty") }}
    </div>
    <ul v-else class="announcement-list">
      <li v-for="item in announcements" :key="item.id" class="announcement-item">
        <div class="item-main">
          <div class="item-title">{{ item.title }}</div>
          <div class="item-message">{{ item.message }}</div>
          <div class="item-meta">
            <span v-if="item.createdByUsername" class="meta-item">
              {{ t("admin.announcements.list.publishedBy", { name: item.createdByUsername }) }}
            </span>
            <span class="meta-item">{{ formatTime(item.createdAt) }}</span>
            <span class="meta-item">{{ readCount(item) }}</span>
            <a v-if="item.actionLink" :href="item.actionLink" target="_blank" rel="noopener noreferrer"
              class="item-link">{{
                item.actionLink }}</a>
          </div>
        </div>
        <div class="item-actions">
          <el-button :icon="Edit" circle :aria-label="t('common.button.edit')" @click="openEdit(item)" />
          <el-button type="danger" :icon="Delete" circle :aria-label="t('common.button.delete')"
            @click="confirmRemove(item)" />
        </div>
      </li>
    </ul>

    <!-- 编辑弹窗：复用发布表单的字段与长度限制 -->
    <el-dialog v-model="editDialogVisible" :title="t('admin.announcements.edit.title')" width="480px"
      :close-on-click-modal="false">
      <div class="publish-form">
        <el-input v-model="editForm.title" :placeholder="t('admin.announcements.form.titlePlaceholder')" maxlength="100"
          show-word-limit />
        <el-input v-model="editForm.message" type="textarea" :rows="4"
          :placeholder="t('admin.announcements.form.messagePlaceholder')" maxlength="2000" show-word-limit />
        <el-input v-model="editForm.actionLink" :placeholder="t('admin.announcements.form.actionLinkPlaceholder')"
          maxlength="500">
          <template #prepend>{{ t("admin.announcements.form.actionLink") }}</template>
        </el-input>
      </div>
      <template #footer>
        <el-button @click="editDialogVisible = false">{{ t("common.button.cancel") }}</el-button>
        <el-button type="primary" :disabled="!canSave" :loading="saving" @click="saveEdit">
          {{ t("admin.announcements.edit.save") }}
        </el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
/* 卡片头对齐全局标题规格（EP 卡头默认样式随主题漂移，显式收口） */
.card-title {
  font-size: var(--app-font-md);
  font-weight: 600;
  color: var(--app-text-1);
}

.publish-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.publish-row {
  display: flex;
  gap: 10px;
}

.publish-row .el-input {
  flex: 1;
}

.list-title {
  margin: 20px 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.empty {
  padding: 24px 0;
  text-align: center;
  color: var(--app-text-3);
}

.announcement-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.announcement-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--app-border);
}

.announcement-item:last-child {
  border-bottom: none;
}

.item-main {
  flex: 1;
  min-width: 0;
}

.item-title {
  font-weight: 600;
  margin-bottom: 2px;
}

.item-message {
  font-size: 13px;
  color: var(--app-text-2);
  white-space: pre-wrap;
  word-break: break-word;
}

.item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--app-text-3);
}

.item-link {
  color: var(--el-color-primary);
  text-decoration: none;
  word-break: break-all;
}

.item-actions {
  flex-shrink: 0;
}
</style>