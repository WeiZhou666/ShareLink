<script setup lang="ts">
import { computed, ref, watch } from "vue";
import QRCode from "qrcode";
import type { CompletedShare } from "../../types/share.type";
import { t } from "../../i18n";
import toast from "../../utils/toast";

const props = defineProps<{
  share: CompletedShare | null;
  appUrl: string;
}>();

const emit = defineEmits<{ (e: "close"): void }>();

const visible = computed({
  get: () => !!props.share,
  set: () => emit("close"),
});

// 链接由 share prop 直接推导（computed 保证 prop 就绪即有值，不依赖父组件手动触发）；
// appUrl 兜底当前站点源，防止配置未加载时拼出 "undefined/s/{id}"
const shareLink = computed(() =>
  props.share ? `${props.appUrl || window.location.origin}/s/${props.share.id}` : "",
);
const qrDataUrl = ref("");
const email = ref("");
const sending = ref(false);

// 打开（share 就绪）时生成二维码；关闭（share 置空）时清空状态，
// 避免下次打开残留上一个分享的二维码与邮箱
watch(
  () => props.share,
  async (share) => {
    if (!share) {
      qrDataUrl.value = "";
      email.value = "";
      return;
    }
    try {
      qrDataUrl.value = await QRCode.toDataURL(shareLink.value);
    } catch {
      // 二维码生成失败不应阻塞弹窗其余功能（链接/邮件仍可用）
      qrDataUrl.value = "";
    }
  },
);

const copyLink = async () => {
  await navigator.clipboard.writeText(shareLink.value);
  toast.success(t("upload.modal.link.copied"));
};

const sendEmail = async () => {
  sending.value = true;
  try {
    const { default: api } = await import("../../api/client");
    await api.post(`/shares/${props.share?.id}/email`, {
      email: email.value,
      webview: false,
    });
    toast.success(t("upload.modal.email.sent"));
  } catch (e) {
    toast.axiosError(e);
  } finally {
    sending.value = false;
  }
};

const openShareLink = () => window.open(`/share/${props.share?.id}`, "_blank");
</script>

<template>
  <el-dialog v-model="visible" :title="t('upload.modal.completed.title')" width="min(90vw, 520px)">
    <!-- 病毒扫描提示：complete 后扫描在后台异步进行，先告知再分享（不阻塞弹窗其余功能） -->
    <el-alert type="info" :closable="false" show-icon class="scan-alert" :title="t('upload.modal.scan.notice')" />
    <el-tabs>
      <el-tab-pane name="link" :label="t('upload.modal.completed.link')">
        <div class="tab-stack">
          <div class="link-row">
            <el-input :model-value="shareLink" readonly />
            <el-button type="primary" @click="copyLink">
              {{ t("common.button.copy") }}
            </el-button>
          </div>
          <el-button class="full-btn" plain @click="openShareLink">
            {{ t("upload.modal.completed.open-link") }}
          </el-button>
        </div>
      </el-tab-pane>
      <el-tab-pane name="qr" :label="t('upload.modal.completed.qr')">
        <div class="qr-wrap">
          <img v-if="qrDataUrl" :src="qrDataUrl" alt="QR code" class="qr-img" />
        </div>
      </el-tab-pane>
      <el-tab-pane name="email" :label="t('upload.modal.completed.email')">
        <div class="tab-stack">
          <el-input v-model="email" :placeholder="t('upload.modal.email.placeholder')" />
          <el-button type="primary" class="full-btn" :loading="sending" :disabled="!email" @click="sendEmail">
            {{ t("upload.modal.email.button") }}
          </el-button>
        </div>
      </el-tab-pane>
    </el-tabs>
  </el-dialog>
</template>

<style scoped>
.scan-alert {
  margin-bottom: 12px;
}

.tab-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.link-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.link-row .el-input {
  flex: 1;
}

.full-btn {
  width: 100%;
}

.qr-wrap {
  text-align: center;
}

.qr-img {
  max-width: 240px;
}
</style>
