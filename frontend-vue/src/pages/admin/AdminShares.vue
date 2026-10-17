<script setup lang="ts">
// 管理端分享管理：分页列表 + 搜索 + 删除（backend-nest /admin/shares）
// 上传/分享创建链路（P0）尚未迁移，列表为空属预期；表结构已就绪，数据一到即可管理
import { onMounted, reactive, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { Delete, Search } from "@element-plus/icons-vue";
import adminService from "../../api/admin.service";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import { t } from "../../i18n";
import toast from "../../utils/toast";

interface AdminShareRow {
  id: string;
  name: string | null;
  description: string | null;
  views: number;
  expiration: string;
  createdAt: string;
  fileCount: number;
  size: string; // 后端 BigInt 转 string 出 JSON
  creator: { id: string; username: string; email: string } | null;
}

const rows = ref<AdminShareRow[]>([]);
const loading = ref(true);
const query = reactive({ page: 1, pageSize: 20, keyword: "" });
const total = ref(0);
const diskUsage = ref("0");

const load = async () => {
  loading.value = true;
  try {
    const data = await adminService.listShares({
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword.trim() || undefined,
    });
    rows.value = data.list;
    total.value = data.total;
    diskUsage.value = data.diskUsage;
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

const remove = async (row: AdminShareRow) => {
  try {
    await ElMessageBox.confirm(
      t("admin.shares.confirm.deleteBody"),
      t("admin.shares.confirm.deleteTitle", { id: row.id }),
      {
        confirmButtonText: t("common.button.confirm"),
        cancelButtonText: t("common.button.cancel"),
        confirmButtonClass: "el-button--danger",
        type: "warning",
      },
    );
  } catch (e) {
    // ElMessageBox 取消时 reject 字符串 "cancel"/"close"，与业务错误区分
    if (e !== "cancel" && e !== "close") throw e;
    return;
  }
  try {
    await adminService.removeShare(row.id);
    toast.success(t("admin.shares.notify.delete.success"));
    // 删的是本页最后一条时回退一页，避免停在空页
    if (rows.value.length === 1 && query.page > 1) query.page -= 1;
    await load();
  } catch (e) {
    toast.axiosError(e);
  }
};

const formatTime = (value: string) =>
  // 去掉秒位（"2026/10/13 22:22:51" → "22:22"），列宽更省、可读性不减
  new Date(value).toLocaleString().replace(/:\d{2}$/, "");

// NEVER_EXPIRES 落库为 unix 0 → 1970，视为"永不"（与我的分享页一致）
const isNeverExpires = (value: string) => new Date(value).getTime() <= 0;

onMounted(load);
</script>

<template>
  <div class="admin-shares-page">
    <div class="page-head">
      <h2 class="page-title">{{ t("admin.shares.title") }}</h2>
      <el-tag type="info" effect="plain" size="large">
        {{ t("admin.shares.diskUsage", { size: byteToHumanSizeString(Number(diskUsage)) }) }}
      </el-tag>
    </div>

    <div class="page-toolbar">
      <el-input v-model="query.keyword" class="search-input" clearable
        :placeholder="t('admin.shares.search.placeholder')" :prefix-icon="Search" @keyup.enter="onSearch"
        @clear="onSearch" />
    </div>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="rows" row-key="id">
        <el-table-column prop="id" :label="t('admin.shares.table.id')" min-width="120" show-overflow-tooltip />
        <el-table-column :label="t('admin.shares.table.name')" min-width="95" show-overflow-tooltip>
          <template #default="{ row }: { row: AdminShareRow }">
            <span v-if="row.name">{{ row.name }}</span>
            <span v-else class="dim">—</span>
          </template>
        </el-table-column>
        <!-- 创建者两行堆叠：用户名在上、邮箱小字弱化，避免长邮箱撑成多行竖条 -->
        <el-table-column :label="t('admin.shares.table.username')" min-width="130">
          <template #default="{ row }: { row: AdminShareRow }">
            <template v-if="row.creator">
              <div>{{ row.creator.username }}</div>
              <div class="sub">{{ row.creator.email }}</div>
            </template>
            <span v-else class="dim">{{ t("admin.shares.table.anonymous") }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('admin.shares.table.size')" width="85" align="right">
          <template #default="{ row }: { row: AdminShareRow }">
            {{ byteToHumanSizeString(Number(row.size)) }}
          </template>
        </el-table-column>
        <el-table-column prop="views" :label="t('admin.shares.table.views')" width="60" align="right" />
        <el-table-column :label="t('admin.shares.table.expires')" width="135">
          <template #default="{ row }: { row: AdminShareRow }">
            <span v-if="isNeverExpires(row.expiration)">
              {{ t("account.shares.table.expiry-never") }}
            </span>
            <span v-else>{{ formatTime(row.expiration) }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('admin.shares.table.createdAt')" width="135">
          <template #default="{ row }: { row: AdminShareRow }">
            {{ formatTime(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column width="55" align="center" fixed="right">
          <template #default="{ row }: { row: AdminShareRow }">
            <el-button text size="small" type="danger" :aria-label="t('common.button.delete')" @click="remove(row)">
              <el-icon :size="16">
                <Delete />
              </el-icon>
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty :description="t('admin.shares.empty')" :image-size="80" />
        </template>
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

.dim {
  color: var(--app-text-3);
}

/* 创建者邮箱等次要信息：小字弱化，随暗色模式自动适配 */
.sub {
  font-size: 0.8em;
  opacity: 0.55;
}
</style>
