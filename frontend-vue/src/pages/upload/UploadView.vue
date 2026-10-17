<script setup lang="ts">
import { computed, ref } from "vue";
import Dropzone from "../../components/upload/Dropzone.vue";
import FileList from "../../components/upload/FileList.vue";
import CreateUploadModal from "../../components/upload/CreateUploadModal.vue";
import CompletedModal from "../../components/upload/CompletedModal.vue";
import { useUpload } from "../../composables/useUpload";
import { useConfigStore } from "../../stores/config";
import { useAuthStore } from "../../stores/auth";
import type { CompletedShare, CreateShare } from "../../types/share.type";
import type { FileUpload } from "../../types/File.type";
import { filterDuplicateFiles, getNormalizedFileName } from "../../utils/file.util";
import { t } from "../../i18n";
import toast from "../../utils/toast";

const props = defineProps<{ reverseShareToken?: string }>();

const config = useConfigStore();
const auth = useAuthStore();

const isReverseShare = computed(() => !!props.reverseShareToken);
const files = ref<FileUpload[]>([]);
const showCreateModal = ref(false);
const showCompletedModal = ref(false);
const completedShare = ref<CompletedShare | null>(null);

const chunkSize = computed(() => parseInt(config.get("share.chunkSize")));
const maxShareSize = computed(() => {
  if (auth.user?.shareSizeLimit) return parseInt(auth.user.shareSizeLimit);
  return parseInt(config.get("share.maxSize"));
});
const currentFilesSize = computed(() =>
  files.value.reduce((acc, file) => acc + file.size, 0),
);

const setFileProgress = (index: number, progress: number) => {
  const file = files.value[index];
  if (file) file.uploadingProgress = progress;
};

// ⚠️ files 传 Ref 本体、chunkSize 传 getter——不要传 .value：
// onFilesChanged/onCompleted 都会整体替换 files.value，传快照会让 useUpload 闭包
// 永远看到空列表（骨架建成但零分块、静默无报错）；chunkSize 定帧读取会在配置
// 未加载时固化 NaN。见 useUpload.ts 顶部说明。
const { state, uploadFiles } = useUpload(
  files,
  setFileProgress,
  () => chunkSize.value,
  isReverseShare.value,
  (share) => {
    completedShare.value = share;
    showCompletedModal.value = true;
    files.value = [];
  },
);

// 进度回调用索引寻址：进度状态直接改 FileUpload 对象上的字段，无需深度响应
const startUpload = (share: CreateShare) => {
  uploadFiles(share);
};

const onFilesChanged = (newFiles: File[]) => {
  const withProgress = newFiles.map((f) => {
    const fileUpload = f as FileUpload;
    fileUpload.uploadingProgress = 0;
    return fileUpload;
  });
  const filtered = filterDuplicateFiles(
    withProgress,
    files.value,
    (normalizedName) =>
      toast.error(t("upload.notify.duplicate-skipped", { name: normalizedName })),
  );
  if (filtered.length === 0) return;
  files.value = [...files.value, ...filtered];
};

const removeFile = (file: FileUpload) => {
  files.value = files.value.filter(
    (f) => getNormalizedFileName(f) !== getNormalizedFileName(file),
  );
};

const openCreateModal = () => {
  showCreateModal.value = true;
};

const notAllowed = computed(
  () => auth.user && auth.user.allowShare === false && !isReverseShare.value,
);
</script>

<template>
  <div>
    <div class="page-toolbar upload-toolbar">
      <el-button type="primary" :loading="state.uploading" :disabled="files.length <= 0" @click="openCreateModal">
        {{ t("common.button.share") }}
      </el-button>
    </div>

    <el-empty v-if="notAllowed" :description="t('upload.error.not-allowed.description')" class="empty-state" />

    <template v-else>
      <Dropzone :max-share-size="maxShareSize" :current-files-size="currentFilesSize" :disabled="state.uploading"
        @files="onFilesChanged" />
      <FileList v-if="files.length > 0" :files="files" @remove="removeFile" />
    </template>

    <CreateUploadModal v-model:show="showCreateModal" :files="files" :max-expiration="auth.user?.isAdmin ? { value: 0, unit: 'days' } : config.get('share.maxExpiration')
      " :default-expiration="config.get('share.defaultExpiration')"
      :share-id-length="config.get('share.shareIdLength')" :app-url="config.get('general.appUrl')"
      @create="startUpload" />

    <CompletedModal :share="completedShare" :app-url="config.get('general.appUrl')" @close="
      () => {
        showCompletedModal = false;
        completedShare = null;
      }
    " />
  </div>
</template>

<style scoped>
.upload-toolbar {
  justify-content: flex-end;
  margin-bottom: 20px;
}

.empty-state {
  padding: 120px 0;
}
</style>
