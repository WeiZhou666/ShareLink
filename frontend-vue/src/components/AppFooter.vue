<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useConfigStore } from "../stores/config";
import { t } from "../i18n";

const router = useRouter();
const config = useConfigStore();

const legalEnabled = computed(() => !!config.get("legal.enabled"));
const imprintType = computed(() =>
  config.get("legal.imprintUrl") ? "url" : "text",
);
const privacyType = computed(() =>
  config.get("legal.privacyPolicyUrl") ? "url" : "text",
);

const goLegal = (path: string, url: string | undefined) => {
  if (url) window.open(url, "_blank");
  else router.push(path);
};
</script>

<template>
  <footer class="app-footer">
    <div class="footer-inner">
      <span>{{ config.get("general.appName") }}</span>
      <span v-if="legalEnabled">
        <a v-if="imprintType === 'text'" class="footer-link" href="/imprint">{{ t("navbar.imprint") }}</a>
        <a v-else class="footer-link" href="javascript:void(0)"
          @click="goLegal('/imprint', config.get('legal.imprintUrl'))">{{ t("navbar.imprint") }}</a>
        <a v-if="privacyType === 'text'" class="footer-link" href="/privacy">{{ t("navbar.privacy") }}</a>
        <a v-else class="footer-link" href="javascript:void(0)"
          @click="goLegal('/privacy', config.get('legal.privacyPolicyUrl'))">{{ t("navbar.privacy") }}</a>
      </span>
    </div>
  </footer>
</template>

<style scoped>
.app-footer {
  border-top: 1px solid var(--app-border);
}

/* 文字区与 1120px 内容列对齐 */
.footer-inner {
  max-width: var(--app-content-max);
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px var(--app-page-x);
  font-size: var(--app-font-sm);
  color: var(--app-text-3);
}

.footer-link {
  color: var(--app-text-3);
  transition: color 0.15s;
}

.footer-link+.footer-link {
  margin-left: 12px;
}

.footer-link:hover {
  color: var(--app-text-1);
}
</style>
