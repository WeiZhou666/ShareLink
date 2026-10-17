<script setup lang="ts">
// 公开分享访问页：标题/有效期/文件列表/下载（含密码门禁）
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { Document, Files, Headset, Picture, VideoPlay } from "@element-plus/icons-vue";
import shareService from "../../api/share.service";
import type { Share } from "../../types/share.type";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import { t } from "../../i18n";
import toast from "../../utils/toast";

const route = useRoute();
const share = ref<Share | null>(null);
const loading = ref(true);
const needsPassword = ref(false);
const password = ref("");

const shareId = computed(() => route.params.shareId as string);

const load = async (withPassword?: string) => {
  loading.value = true;
  try {
    await shareService.getShareToken(shareId.value, withPassword);
    share.value = await shareService.get(shareId.value);
    needsPassword.value = false;
  } catch (e: any) {
    // 后端两种形态都判：无密码提交 403 + error: "share_password_required"（对齐 backend-nest）
    if (e?.response?.status === 401 || e?.response?.data?.error === "share_password_required") {
      needsPassword.value = true;
    } else {
      toast.axiosError(e);
    }
  } finally {
    loading.value = false;
  }
};

const submitPassword = () => load(password.value);

const download = (fileId: string) => shareService.downloadFile(shareId.value, fileId);

const downloadZip = async () => {
  // zip 打包挂载在 files 子路径（对齐 backend-nest 路由 /api/shares/:id/files/zip）
  window.location.href = `${window.location.origin}/api/shares/${shareId.value}/files/zip`;
};

// 日期与其他页面统一：本地化 + 去秒（moment 未挂中文 locale，会渲染成英文 LLL）
const formatTime = (value: string | Date) =>
  new Date(value).toLocaleString().replace(/:\d{2}$/, "");

// NEVER_EXPIRES 落库为 unix 0 → 1970，公开页也显示"永不"（与我的分享/管理页一致）
const isNeverExpires = (value: string | Date) => new Date(value).getTime() <= 0;

const expirationText = computed(() =>
  share.value ? formatTime(share.value.expiration) : "",
);

// 按扩展名选文件图标（图片/视频/音频/压缩包/默认文档）
const fileIcon = (name: string) => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return Picture;
  if (["mp4", "mkv", "avi", "mov", "webm"].includes(ext)) return VideoPlay;
  if (["mp3", "wav", "flac", "ogg", "m4a"].includes(ext)) return Headset;
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return Files;
  return Document;
};

onMounted(() => load());
</script>

<template>
  <div v-loading="loading" class="share-page">
    <div class="page-stack">
      <div class="page-header">
        <!-- 有自定义名称显示名称；否则"分享 {shareId}"（i18n 键带占位符，必须传参，
             否则页面会直接渲染出 "(shareId)" 字样） -->
        <h1 class="page-title">{{ share?.name || t("share.title", { shareId: shareId }) }}</h1>
      </div>

      <el-card shadow="never">
        <template v-if="needsPassword && !share">
          <div class="password-box">
            <p>{{ t("share.password.title") }}</p>
            <el-input v-model="password" type="password" show-password :placeholder="t('share.password.placeholder')"
              @keyup.enter="submitPassword" />
            <el-button type="primary" :disabled="!password" @click="submitPassword">
              {{ t("share.password.button") }}
            </el-button>
          </div>
        </template>

        <template v-else-if="share">
          <div class="share-body">
            <p v-if="share.description" class="share-desc">{{ share.description }}</p>
            <p class="share-meta">
              <span v-if="isNeverExpires(share.expiration)">
                {{ t("account.shares.table.expiry-never") }}
              </span>
              <span v-else>{{ t("share.expiration", { expiration: expirationText }) }}</span>
            </p>

            <ul class="file-list">
              <li v-for="file in share.files" :key="file.id" class="file-row">
                <el-icon :size="22" class="file-icon">
                  <component :is="fileIcon(file.name)" />
                </el-icon>
                <div class="file-info">
                  <div class="file-name">
                    {{ file.name }}
                    <!-- 病毒扫描状态徽标：CLEAN/ERROR 不显示（无噪音；ERROR 为 fail-open 放行） -->
                    <el-tag v-if="file.scanStatus === 'INFECTED'" type="danger" size="small" class="scan-tag">
                      {{ t("share.scan.quarantined") }}
                    </el-tag>
                    <el-tag v-else-if="file.scanStatus === 'SCANNING' || file.scanStatus === 'PENDING'" type="info"
                      size="small" class="scan-tag">
                      {{ t("share.scan.scanning") }}
                    </el-tag>
                  </div>
                  <div class="file-size">{{ byteToHumanSizeString(file.size) }}</div>
                </div>
                <!-- 隔离文件不给下载入口（后端 403 双保险） -->
                <el-button v-if="file.scanStatus !== 'INFECTED'" size="small" type="primary" plain
                  @click="download(file.id)">
                  {{ t("common.button.download") }}
                </el-button>
              </li>
            </ul>

            <!-- 单文件时"下载全部"与单文件下载重复，仅多文件展示 -->
            <el-button v-if="share.files.length > 1" class="zip-btn" @click="downloadZip">
              {{ t("share.download-all") }}
            </el-button>
          </div>
        </template>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
/* 公开分享页聚焦容器：720px 居中（单栏壳内再收一档） */
.share-page {
  max-width: 720px;
  margin: 0 auto;
}

.zip-btn {
  width: 100%;
}

.password-box {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.share-body {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.share-desc {
  margin: 0;
  white-space: pre-wrap;
}

/* 有效期/永不：弱化小字 */
.share-meta {
  margin: 0;
  color: var(--app-text-2);
  font-size: 0.85rem;
}

/* 文件列表：圆角边框容器 + 行分隔线，行 hover 微亮 */
.file-list {
  list-style: none;
  padding: 0;
  margin: 0;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-md);
  overflow: hidden;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--app-border);
  transition: background-color 0.15s;
}

.file-row:last-child {
  border-bottom: none;
}

.file-row:hover {
  background-color: var(--app-bg-subtle);
}

/* 文件类型图标：弱化配色，暗色模式自动适配 */
.file-icon {
  color: var(--app-text-2);
  flex-shrink: 0;
}

.file-info {
  flex: 1;
  min-width: 0;
  /* 超长文件名可换行不撑破布局 */
}

/* 病毒扫描徽标：跟随文件名，不参与换行挤压 */
.scan-tag {
  margin-left: 8px;
  flex-shrink: 0;
}

.file-name {
  word-break: break-all;
}

.file-size {
  opacity: 0.6;
  font-size: 0.8em;
  margin-top: 2px;
}
</style>
