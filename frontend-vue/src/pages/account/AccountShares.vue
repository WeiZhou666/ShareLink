<script setup lang="ts">
// 我的分享列表：表格化展示（名称/文件/浏览量/过期/创建 + 复制链接/删除）
import { onMounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import { CopyDocument, Delete } from "@element-plus/icons-vue";
import shareService from "../../api/share.service";
import { useConfigStore } from "../../stores/config";
import type { MyShare } from "../../types/share.type";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import { t } from "../../i18n";
import toast from "../../utils/toast";

const router = useRouter();
const config = useConfigStore();

const shares = ref<MyShare[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    shares.value = await shareService.getMyShares();
  } catch (e) {
    toast.axiosError(e);
  } finally {
    loading.value = false;
  }
});

const formatTime = (value: string | Date) => new Date(value).toLocaleString();

// NEVER_EXPIRES 落库为 unix 0，序列化后是 1970 → 视为"永不"过期
const isNeverExpires = (expiration: string | Date) =>
  new Date(expiration).getTime() <= 0;

const shareLink = (id: string) =>
  `${(config.get("general.appUrl") ?? "").replace(/\/$/, "")}/s/${id}`;

const copyLink = async (share: MyShare) => {
  await navigator.clipboard.writeText(shareLink(share.id));
  toast.success(t("common.notify.copied-link"));
};

const remove = async (share: MyShare) => {
  try {
    // 删除前二次确认，标题/正文复用旧前端的带参 i18n 键
    await ElMessageBox.confirm(
      t("account.shares.modal.delete.description"),
      t("account.shares.modal.delete.title", { share: share.name || share.id }),
      {
        confirmButtonText: t("common.button.confirm"),
        cancelButtonText: t("common.button.cancel"),
        type: "warning",
      },
    );
  } catch {
    return; // 用户取消
  }
  try {
    await shareService.remove(share.id);
    shares.value = shares.value.filter((s) => s.id !== share.id);
  } catch (e) {
    toast.axiosError(e);
  }
};

const goUpload = () => router.push("/upload");
</script>

<template>
  <div class="page-stack">
    <div class="page-header">
      <h1 class="page-title">{{ t("account.shares.title") }}</h1>
    </div>
    <el-card shadow="never">
      <div v-loading="loading">
        <!-- 列表式布局：每条分享一行，名称+描述在左、元信息灰色小字、操作图标靠右。
           弃用 el-table 的原因：固定列宽在窄视口下操作列会被横向滚动裁掉，
           且长名称/描述挤压其他列；列表换行自然、移动端友好 -->
        <ul v-if="shares.length" class="share-list">
          <li v-for="share in shares" :key="share.id" class="share-item">
            <div class="share-main">
              <RouterLink :to="`/share/${share.id}/edit`" class="share-name">
                {{ share.name || share.id }}
              </RouterLink>
              <!-- 次要行：id / 描述（有自定义名称时才补显 id） -->
              <div v-if="share.name || share.description" class="share-sub">
                <span v-if="share.name">{{ share.id }}</span>
                <span v-if="share.name && share.description">·</span>
                <span v-if="share.description">{{ share.description }}</span>
              </div>
              <!-- 元信息行：大小 · 浏览量 · 过期 · 创建 -->
              <div class="share-meta">
                <span>{{ byteToHumanSizeString(share.size) }}</span>
                <!-- 设了最大浏览量时展示 "已看/上限"（复用旧键 {count}/{max}） -->
                <span v-if="share.security?.maxViews != null">
                  {{ t("account.shares.table.visitors") }}
                  {{
                    t("account.shares.table.visitor-count", {
                      count: share.views,
                      max: share.security.maxViews,
                    })
                  }}
                </span>
                <span v-else>
                  {{ t("account.shares.table.visitors") }} {{ share.views }}
                </span>
                <span v-if="isNeverExpires(share.expiration)">
                  {{ t("account.shares.table.expiry-never") }}
                </span>
                <span v-else>
                  {{ t("account.shares.table.expiresAt") }} {{ formatTime(share.expiration) }}
                </span>
                <span>{{ t("account.shares.table.createdAt") }} {{ formatTime(share.createdAt) }}</span>
              </div>
            </div>
            <div class="actions">
              <el-button text size="small" :aria-label="t('common.button.copy')" @click="copyLink(share)">
                <el-icon :size="16">
                  <CopyDocument />
                </el-icon>
              </el-button>
              <el-button text type="danger" size="small" :aria-label="t('common.button.delete')" @click="remove(share)">
                <el-icon :size="16">
                  <Delete />
                </el-icon>
              </el-button>
            </div>
          </li>
        </ul>

        <!-- 空状态：👀 + 提示 + 引导去创建 -->
        <el-empty v-else-if="!loading" :description="t('account.shares.description.empty')">
          <template #image>
            <div class="empty-face">👀</div>
          </template>
          <el-button type="primary" @click="goUpload">
            {{ t("account.shares.button.create") }}
          </el-button>
        </el-empty>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
/* 列表容器：去掉 ul 默认样式 */
.share-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

/* 每条分享一行：主体在左（可收缩），操作在右（固定不缩）；行间用分隔线 */
.share-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 4px;
}

.share-item+.share-item {
  border-top: 1px solid var(--app-border);
}

.share-main {
  flex: 1;
  min-width: 0;
  /* 允许名称/描述超长时内部换行而不撑破布局 */
}

.share-name {
  color: var(--el-color-primary);
  text-decoration: none;
  font-weight: 500;
  word-break: break-all;
}

.share-name:hover {
  text-decoration: underline;
}

/* 次要信息：id/描述，弱化显示且随暗色模式自动适配 */
.share-sub {
  font-size: 0.8em;
  color: var(--app-text-3);
  margin-top: 2px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  word-break: break-all;
}

/* 元信息行：大小/浏览量/过期/创建，小字横排可换行 */
.share-meta {
  font-size: 0.8em;
  color: var(--app-text-3);
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
}

/* 操作按钮：固定在行右侧，两个图标横排（覆盖相邻 el-button 自带 margin-left） */
.actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
}

.actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.empty-face {
  font-size: 48px;
  line-height: 1;
}
</style>
