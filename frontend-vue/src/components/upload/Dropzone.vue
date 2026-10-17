<script setup lang="ts">
import { ref } from "vue";
import { CloudUpload, Upload } from "@vicons/tabler";
import { t } from "../../i18n";
import { byteToHumanSizeString } from "../../utils/fileSize.util";

const props = defineProps<{
  maxShareSize?: number;
  currentFilesSize: number;
  disabled?: boolean;
}>();

const emit = defineEmits<{ (e: "files", files: File[]): void }>();

const isDragging = ref(false);
const fileInput = ref<HTMLInputElement>();

const collect = (list: FileList | null | undefined): File[] =>
  list ? Array.from(list) : [];

const onDrop = async (e: DragEvent) => {
  if (props.disabled) return;
  isDragging.value = false;
  const items = e.dataTransfer?.items;
  if (items && Array.from(items).some((i) => i.kind === "file")) {
    // 支持拖入目录：用 webkitGetAsEntry 递归展开
    const files: File[] = [];
    const entries = Array.from(items)
      .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
      .filter(Boolean);

    const walk = async (entry: any): Promise<void> => {
      if (!entry) return;
      if (entry.isFile) {
        await new Promise<void>((resolve) =>
          entry.file((f: File) => {
            files.push(f);
            resolve();
          }, resolve),
        );
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const children: any[] = await new Promise((resolve) =>
          reader.readEntries(resolve, () => resolve([])),
        );
        for (const child of children) await walk(child);
      }
    };

    for (const entry of entries) await walk(entry);
    if (files.length > 0) emit("files", files);
  } else {
    const files = collect(e.dataTransfer?.files);
    if (files.length > 0) emit("files", files);
  }
};

const onSelect = (e: Event) => {
  if (props.disabled) return;
  emit("files", collect((e.target as HTMLInputElement).files));
  (e.target as HTMLInputElement).value = "";
};
</script>

<template>
  <!-- 对齐 Pingvin Share 演示站：虚线卡片 + 云上传图标 + 底部悬浮圆形上传按钮 -->
  <div class="dropzone-wrapper">
    <div class="dropzone" :class="{ dragging: isDragging }" :style="{ cursor: disabled ? 'not-allowed' : 'pointer' }"
      @click="!disabled && fileInput?.click()" @dragover.prevent="isDragging = true" @dragleave="isDragging = false"
      @drop.prevent="onDrop">
      <CloudUpload class="dropzone-icon" :stroke-width="1.5" />
      <div class="dropzone-title">
        {{ t(currentFilesSize > 0 ? "upload.dropzone.title.append" : "upload.dropzone.title") }}
      </div>
      <div class="dropzone-description">
        {{
          t("upload.dropzone.description", {
            maxSize: byteToHumanSizeString(maxShareSize ?? 0),
          })
        }}
      </div>
    </div>
    <button type="button" class="dropzone-fab" :disabled="disabled" @click.stop="!disabled && fileInput?.click()">
      <Upload :size="20" :stroke-width="2" />
    </button>
  </div>
  <input ref="fileInput" type="file" multiple hidden @change="onSelect" />
</template>

<style scoped>
.dropzone-wrapper {
  position: relative;
}

.dropzone {
  border: 1.5px dashed var(--app-border-strong);
  border-radius: var(--app-radius-md);
  background: transparent;
  text-align: center;
  padding: 48px 16px 72px;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.dropzone.dragging {
  border-color: var(--el-color-primary);
  background-color: var(--app-brand-subtle);
}

.dropzone-icon {
  width: 56px;
  height: 56px;
  color: var(--app-text-3);
}

.dropzone-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--app-text-1);
  margin-top: 16px;
}

.dropzone-description {
  margin-top: 8px;
  font-size: 0.9rem;
  color: var(--app-text-3);
}

/* 圆形上传按钮：中心压在卡片下边框上 */
.dropzone-fab {
  position: absolute;
  left: 50%;
  bottom: 0;
  transform: translate(-50%, 50%);
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--el-color-primary);
  background-color: var(--app-brand-subtle);
  transition: background-color 0.15s ease;
}

.dropzone-fab:hover:not(:disabled) {
  background-color: var(--el-color-primary-light-7);
}

.dropzone-fab:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
