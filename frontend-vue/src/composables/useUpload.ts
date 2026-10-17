import { reactive } from "vue";
import type { Ref } from "vue";
import pLimit from "p-limit";
import { AxiosError } from "axios";
import shareService from "../api/share.service";
import type { FileUpload } from "../types/File.type";
import type { CreateShare, Share } from "../types/share.type";
import { getNormalizedFileName } from "../utils/file.util";
import toast from "../utils/toast";
import { t } from "../i18n";

/**
 * 分块上传编排（移植自 React 版 upload/index.tsx）：
 * - 创建分享 → p-limit(3) 并发上传 → 每个文件按 chunkSize 分块
 * - unexpected_chunk_index 时按服务端期望的索引重试
 * - 其他错误：进度置 -1，等 5s 从头重试该文件
 * - 全部完成后调用 completeShare
 *
 * ⚠️ files 必须传 Ref 本体而非 .value 快照：UploadView 里 onFilesChanged 用
 * `files.value = [...展开]` 整体替换数组，若闭包持有旧快照会永远看到空列表——
 * 表现为"骨架建成了但一个分块都不发、无任何报错"（已踩坑，勿回退）。
 * chunkSize 同理传 getter：直开 /upload 时配置可能晚于组件挂载返回，
 * setup 时定帧读取会得到 NaN，导致 chunks=NaN、for 循环零次执行。
 */
export const useUpload = (
  files: Ref<FileUpload[]>,
  setFileProgress: (index: number, progress: number) => void,
  getChunkSize: () => number,
  isReverseShare: boolean,
  onCompleted: (share: Share) => void,
) => {
  const state = reactive({ uploading: false, errorCount: 0 });

  const uploadFiles = async (share: CreateShare) => {
    state.uploading = true;
    let createdShare: Share;

    try {
      const totalSize = files.value.reduce((acc, file) => acc + file.size, 0);
      createdShare = await shareService.create(
        { ...share, size: totalSize },
        isReverseShare,
      );
    } catch (e) {
      toast.axiosError(e);
      state.uploading = false;
      return;
    }

    const promiseLimit = pLimit(3);
    const chunkSize = getChunkSize();
    // 此刻再取一次列表快照：后续进度/失败判定与上传用同一份，避免上传中途增删文件错位
    const uploadingFiles = files.value;
    const fileUploadPromises = uploadingFiles.map(async (file, fileIndex) =>
      promiseLimit(async () => {
        let fileId: string | undefined;
        setFileProgress(fileIndex, 1);

        let chunks = Math.ceil(file.size / chunkSize);
        // 0 字节文件仍需上传 1 个块
        if (chunks == 0) chunks++;

        for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex++) {
          const from = chunkIndex * chunkSize;
          const to = from + chunkSize;
          const blob = file.slice(from, to);
          try {
            const response = await shareService.uploadFile(
              createdShare.id,
              blob,
              { id: fileId, name: getNormalizedFileName(file) },
              chunkIndex,
              chunks,
              (progressEvent) => {
                if (progressEvent.total && file.size > 0) {
                  const chunkProgress = progressEvent.loaded / progressEvent.total;
                  const uploadedBytesBeforeThisChunk = chunkIndex * chunkSize;
                  const uploadedBytesInThisChunk = blob.size * chunkProgress;
                  const totalUploaded =
                    uploadedBytesBeforeThisChunk + uploadedBytesInThisChunk;
                  const overallPercent = (totalUploaded / file.size) * 100;
                  setFileProgress(fileIndex, Math.min(overallPercent, 99.9));
                }
              },
            );
            fileId = response.id;
            setFileProgress(fileIndex, ((chunkIndex + 1) / chunks) * 100);
          } catch (e) {
            if (
              e instanceof AxiosError &&
              e.response?.data.error == "unexpected_chunk_index"
            ) {
              // 按服务端期望的块索引重试
              chunkIndex = e.response!.data!.expectedChunkIndex - 1;
              continue;
            } else {
              setFileProgress(fileIndex, -1);
              state.errorCount++;
              await new Promise((resolve) => setTimeout(resolve, 5000));
              chunkIndex = -1;
              continue;
            }
          }
        }
      }),
    );

    await Promise.all(fileUploadPromises).catch(() => { });

    // 完成分享：所有文件 >= 100 且无失败（用 uploadingFiles 判定，与实际上传的列表一致）
    const failed = uploadingFiles.filter((f) => f.uploadingProgress == -1).length;
    if (
      uploadingFiles.length > 0 &&
      failed == 0 &&
      uploadingFiles.every((f) => f.uploadingProgress >= 100)
    ) {
      try {
        const share = await shareService.completeShare(createdShare.id);
        state.uploading = false;
        onCompleted(share);
      } catch {
        toast.error(t("upload.notify.generic-error"));
        state.uploading = false;
      }
    } else {
      state.uploading = false;
      if (failed > 0) toast.error(t("upload.notify.count-failed", { count: failed }));
    }
  };

  return { state, uploadFiles };
};
