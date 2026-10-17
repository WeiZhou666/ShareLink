<script setup lang="ts">
import { Delete } from "@element-plus/icons-vue";
import type { FileUpload } from "../../types/File.type";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import { getNormalizedFileName } from "../../utils/file.util";
import { t } from "../../i18n";

const props = defineProps<{ files: FileUpload[] }>();
const emit = defineEmits<{ (e: "remove", file: FileUpload): void }>();

const progressStatus = (progress: number) => {
  if (progress == -1) return "exception";
  if (progress >= 100) return "success";
  return undefined;
};

const isUploading = (progress: number) => progress > 0 && progress < 100;
</script>

<template>
  <!-- 对齐 Pingvin Share 演示站：文件名 / 文件大小 两列表格 + 红色删除图标 -->
  <table class="file-table">
    <thead>
      <tr>
        <th>{{ t("upload.filelist.name") }}</th>
        <th class="col-size">{{ t("upload.filelist.size") }}</th>
        <th class="col-action"></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="file in props.files" :key="getNormalizedFileName(file)">
        <td>
          <div class="file-name">
            {{ getNormalizedFileName(file) }}
          </div>
          <el-progress v-if="file.uploadingProgress !== 0" type="line"
            :percentage="file.uploadingProgress < 0 ? 100 : file.uploadingProgress"
            :status="progressStatus(file.uploadingProgress)" :stroke-width="6" :show-text="false"
            class="file-progress" />
        </td>
        <td>{{ byteToHumanSizeString(file.size) }}</td>
        <td class="col-action">
          <!-- 删除图标必须包 el-icon 显式定尺寸：@vicons/tabler 图标是无宽高 svg，
               裸放 inline-flex 按钮里会收缩成 0×0 隐形（曾踩坑） -->
          <el-button text type="danger" size="small" :disabled="isUploading(file.uploadingProgress)"
            :aria-label="t('common.button.delete')" @click="emit('remove', file)">
            <el-icon :size="18">
              <Delete />
            </el-icon>
          </el-button>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.file-table {
  width: 100%;
  margin-top: 20px;
  border-collapse: collapse;
  font-size: 0.95rem;
}

.file-table th {
  text-align: left;
  font-weight: 600;
  padding: 10px 8px;
  border-bottom: 1px solid var(--app-border);
  color: var(--app-text-2);
}

.file-table td {
  padding: 12px 8px;
  border-bottom: 1px solid var(--app-border);
  color: var(--app-text-1);
}

.col-size {
  width: 40%;
}

.col-action {
  width: 60px;
  text-align: right;
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-progress {
  max-width: 260px;
  margin-top: 6px;
}
</style>
