<script setup lang="ts">
import { computed, onMounted, provide, ref, watch, watchEffect } from "vue";
import { useRoute } from "vue-router";
import { useConfigStore } from "./stores/config";
import { useAuthStore } from "./stores/auth";
import authService from "./api/auth.service";
import adminNoticeService from "./api/adminNotice.service";
import announcementService from "./api/announcement.service";
import { getLocaleByCode, currentLocaleCode, setLanguageCookie, t } from "./i18n";
import userPreferences from "./utils/userPreferences.util";
import AppHeader from "./components/AppHeader.vue";
import AppFooter from "./components/AppFooter.vue";
import AppSidebar from "./components/AppSidebar.vue";
import { getCookie, setCookie } from "./utils/cookies";
import { Link, WarningFilled, Coffee } from "@element-plus/icons-vue";

const route = useRoute();
const config = useConfigStore();
const auth = useAuthStore();

// ===== 工作台壳（顶栏 + 左侧边栏）=====
// 侧栏只给登录后的功能页：公开页/认证页路由声明 meta.sidebar=false，单栏渲染；
// blankLayout（/error）连顶栏都不要，两者都不满足才出工作台。
// 未登录时即使路由没声明 sidebar=false（如匿名可上传的 /upload）也回退单栏——
// 侧栏的分享/管理分组全需要账号，空壳没有意义。
const showSidebar = computed(
  () => auth.isAuthenticated && route.meta.sidebar !== false && route.meta.blankLayout !== true,
);

// 移动端（<768px）侧栏收进抽屉：AppHeader 汉堡按钮唤起，路由跳转后自动关闭
const sidebarDrawer = ref(false);
provide("openSidebar", () => (sidebarDrawer.value = true));
provide("closeSidebar", () => (sidebarDrawer.value = false));
watch(
  () => route.path,
  () => (sidebarDrawer.value = false),
);

const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)");
const colorScheme = ref<"light" | "dark">("light");
const isDark = computed(() => colorScheme.value === "dark");

const applyColorScheme = () => {
  const pref = userPreferences.get("colorScheme");
  const adminDefault = config.get("appearance.themeColorScheme", true);
  if (pref === "light" || pref === "dark") colorScheme.value = pref;
  else if (adminDefault === "light" || adminDefault === "dark")
    colorScheme.value = adminDefault;
  else colorScheme.value = systemPrefersDark.matches ? "dark" : "light";
  setCookie("mantine-color-scheme", colorScheme.value, { sameSite: "lax" });
  // 同步到 html data-theme，供 global.css 的暗色规则使用
  document.documentElement.dataset.theme = colorScheme.value;
  // Element Plus 暗色模式：html.dark（配合 dark/css-vars.css）
  document.documentElement.classList.toggle("dark", isDark.value);
};

const toggleColorScheme = () => {
  userPreferences.set("colorScheme", isDark.value ? "light" : "dark");
  applyColorScheme();
};
provide("toggleColorScheme", toggleColorScheme);
provide("isDark", isDark);

// 主色/圆角/亮暗底色等主题变量已收敛到 styles/tokens.css（静态 token + :root.dark 分段），
// 原运行时注入引擎（mantineColors/mixHex/watchEffect）已删除——appearance.* 配置键
// 在新后端 CONFIG_VARIABLES 中不存在，恒走默认值，属死代码。

const customCss = computed(() => config.get("appearance.customCss", true) ?? "");
// 在 script 侧做转义（模板内联正则会破坏 Vue 的模板解析）
const sanitizedCustomCss = computed(() =>
  customCss.value.replace(/<\/style/gi, "<\\/style"),
);

// ===== 公告弹窗（强制确认型，对齐旧 React 版 AdminNoticeModal 语义）=====
// 合并两条队列，系统级提醒优先于运营公告展示：
// - kind=system：代码内置的系统级提醒，仅管理员可见（adminNotice.service，如 S3 CORS 变更）
// - kind=announcement：管理端发布的运营公告，全体登录用户可见（announcement.service）
// 弹窗无 X/遮罩/ESC 关闭路径，必须勾选"已知悉"后点确认才 dismiss
interface NoticeQueueItem {
  id: string;
  title: string;
  message: string;
  actionLink?: string | null;
  kind: "announcement" | "system";
}

const pendingNotices = ref<NoticeQueueItem[]>([]);
const noticeConfirmed = ref(false);
const noticeSubmitting = ref(false);

// 混合队列里只要含系统级提醒，图标/确认按钮就用红色（视觉上更重）
const hasSystemNotice = computed(() => pendingNotices.value.some((n) => n.kind === "system"));

// ===== 支持作者（微信收款码）=====
// 收款码是静态素材 public/img/wechat-donate.png：未放置图片时预加载失败，
// 支持小节与侧栏「支持作者」入口自动隐藏——投放图片后刷新即生效，无需改代码
const donateAvailable = ref(false);
const donateImageOk = ref(true); // 运行时兜底：预加载通过但中途 404 时隐藏图片
// 侧栏入口强制打开弹窗：无未读通知时只展示支持小节，不带确认按钮
const donateForcedOpen = ref(false);
const noticeDialogVisible = computed(
  () => pendingNotices.value.length > 0 || donateForcedOpen.value,
);
const openDonate = () => (donateForcedOpen.value = true);
provide("openDonate", openDonate);
provide("donateAvailable", donateAvailable);
onMounted(() => {
  const probe = new Image();
  probe.onload = () => (donateAvailable.value = true);
  probe.src = "/img/wechat-donate.png";
});

const dismissOne = async (item: NoticeQueueItem) => {
  // 两种公告的 dismiss 端点不同，按 kind 分发
  if (item.kind === "announcement") await announcementService.dismiss(item.id);
  else await adminNoticeService.dismissNotice(item.id);
};

/**
 * 一键全部确认：所有未读通知（系统级 + 运营公告）合并在同一弹窗内滚动展示，
 * 勾选「已全部知悉」后逐条调用各自 dismiss（allSettled 保证单条失败不拖垮其余）。
 * 部分失败时重拉未读回滚弹窗内容——成功的已写入已读表，不会重复弹。
 */
const acknowledgeAll = async () => {
  if (!pendingNotices.value.length) return;
  noticeSubmitting.value = true;
  try {
    const results = await Promise.allSettled(pendingNotices.value.map(dismissOne));
    if (results.every((r) => r.status === "fulfilled")) {
      pendingNotices.value = []; // 全部成功 → 关闭弹窗（含侧栏入口的强制打开态）
      donateForcedOpen.value = false;
    } else {
      fetchPendingNotices(); // 有失败 → 重拉未读（失败项保留，弹窗不关）
    }
  } finally {
    noticeSubmitting.value = false;
    noticeConfirmed.value = false; // 无论成败都重置勾选，防残留勾选误点
  }
};

/**
 * 拉取未读公告（两类并行，allSettled 互不影响），整体替换本地队列。
 * 触发时机：挂载后登录态就绪 / 登录成功 / 管理员身份变化 / dismiss 失败回滚
 */
const fetchPendingNotices = async () => {
  const tasks: Promise<NoticeQueueItem[]>[] = [];
  if (auth.isAdmin) {
    tasks.push(
      adminNoticeService.getPendingNotices().then((ns) =>
        (ns ?? []).map((n) => ({ ...n, kind: "system" as const })),
      ),
    );
  }
  if (auth.isAuthenticated) {
    tasks.push(
      announcementService
        .getPending()
        .then((list) =>
          (list ?? []).map((a) => ({ ...a, kind: "announcement" as const })),
        ),
    );
  }
  const results = await Promise.allSettled(tasks);
  pendingNotices.value = results.flatMap((r) =>
    r.status === "fulfilled" ? r.value : [],
  );
  noticeConfirmed.value = false; // 队列重建后重置勾选，防残留勾选误点
};

onMounted(async () => {
  await config.load();

  // 语言初始化：cookie > 管理端默认 > 浏览器语言
  const defaultLanguage = config.get("general.defaultLanguage", true);
  const lang = currentLocaleCode();
  const locale = getLocaleByCode(lang);
  document.documentElement.lang = locale.code;
  document.documentElement.dir = locale.direction ?? "ltr";
  if (!getCookie("language") && defaultLanguage) {
    // 先落 cookie 再刷新，否则 reload 后条件仍成立会无限刷新
    setLanguageCookie(defaultLanguage);
    window.location.reload();
    return;
  }

  applyColorScheme();
  systemPrefersDark.addEventListener("change", applyColorScheme);

  await auth.refreshUser().catch(() => auth.setUser(null));

  // 静默续期：access JWT 15 分钟，每 10 分钟无条件轮换一次保证永不过期；
  // refreshSession 单飞，与 401 拦截器不会并发轮换（并发会撞已吊销会话触发全家桶吊销）
  setInterval(() => authService.refreshAccessToken(), 10 * 60 * 1000);

  if (auth.isAuthenticated) {
    fetchPendingNotices();
  }
});

// 登录成功 / 管理员身份变化后无需刷新即可拉公告（对齐旧版对 user.isAdmin 的响应式依赖）；
// 登出时清空未读队列，避免公告弹窗残留到登录页
watch(
  () => [auth.isAuthenticated, auth.isAdmin],
  ([authenticated]) => {
    if (authenticated) fetchPendingNotices();
    else {
      pendingNotices.value = [];
      donateForcedOpen.value = false; // 登出清掉侧栏入口的强制打开态
    }
  },
);

watchEffect(() => {
  const appName = config.get("general.appName", true) ?? "ShareLink";
  document.title = appName;
});
</script>

<template>
  <div style="min-height: 100vh">
    <!-- 管理端配置的全局自定义 CSS（与 React 版一致，做转义防注入） -->

    <component :is="'style'" v-if="sanitizedCustomCss">{{ sanitizedCustomCss }}</component>

    <!-- 公告弹窗：强制确认型（无 X/遮罩/ESC 关闭），所有未读通知合并为一个滚动列表，
         勾选「已全部知悉」后一键全部标记已读——多条公告不再逐条弹窗。
         支持作者小节常驻弹窗底部；侧栏「支持作者」入口在无未读通知时也打开本弹窗（纯支持视图） -->
    <el-dialog :model-value="noticeDialogVisible" width="480px" align-center class="notice-dialog"
      :close-on-click-modal="false" :close-on-escape="false" :show-close="false">
      <template #header>
        <div class="notice-header">
          <el-icon :size="22" :color="pendingNotices.length
            ? (hasSystemNotice ? 'var(--el-color-danger)' : 'var(--el-color-primary)')
            : 'var(--el-color-warning)'">
            <WarningFilled v-if="pendingNotices.length" />
            <Coffee v-else />
          </el-icon>
          <el-tag v-if="pendingNotices.length" :type="hasSystemNotice ? 'danger' : 'primary'" effect="dark" size="small">
            {{ pendingNotices.length > 1
              ? t("notice.modal.headerTagMultiple", { count: pendingNotices.length })
              : pendingNotices[0]?.kind === "announcement"
                ? t("announcement.modal.headerTag")
                : t("admin.notice.modal.headerTag") }}
          </el-tag>
          <span v-else class="donate-header-title">{{ t("notice.donate.title") }}</span>
        </div>
      </template>
      <div v-if="pendingNotices.length" class="notice-list">
        <div v-for="notice in pendingNotices" :key="notice.kind + '-' + notice.id" class="notice-item">
          <div class="notice-item-head">
            <el-tag :type="notice.kind === 'announcement' ? 'primary' : 'danger'" effect="plain" size="small">
              {{ notice.kind === "announcement"
                ? t("announcement.modal.headerTag")
                : t("admin.notice.modal.headerTag") }}
            </el-tag>
          </div>
          <div class="notice-title">{{ notice.title }}</div>
          <div class="notice-message">{{ notice.message }}</div>
          <a v-if="notice.actionLink" :href="notice.actionLink" target="_blank" rel="noopener noreferrer"
            class="notice-docs-link">
            {{ t("admin.notice.modal.docsLink") }}
            <el-icon :size="13">
              <Link />
            </el-icon>
          </a>
        </div>
      </div>
      <!-- 支持作者：收款码静态素材（未投放时 donateAvailable=false 整节隐藏） -->
      <div v-if="donateAvailable && donateImageOk" class="donate-section">
        <img class="donate-qr" src="/img/wechat-donate.png" :alt="t('notice.donate.alt')"
          @error="donateImageOk = false" />
        <div class="donate-text">
          <div class="donate-title">{{ t("notice.donate.title") }}</div>
          <div class="donate-desc">{{ t("notice.donate.description") }}</div>
        </div>
      </div>
      <template v-if="pendingNotices.length">
        <el-checkbox v-model="noticeConfirmed" class="notice-checkbox">
          {{ t("notice.modal.allCheckboxLabel") }}
        </el-checkbox>
        <div class="notice-footer-note">{{ t("notice.modal.allFooterNote") }}</div>
      </template>
      <template #footer>
        <el-button v-if="pendingNotices.length" :type="hasSystemNotice ? 'danger' : 'primary'"
          :disabled="!noticeConfirmed" :loading="noticeSubmitting" @click="acknowledgeAll">
          {{ noticeSubmitting
            ? t("admin.notice.modal.button.acknowledging")
            : t("admin.notice.modal.button.acknowledge") }}
        </el-button>
        <el-button v-else type="primary" @click="donateForcedOpen = false">
          {{ t("notice.donate.close") }}
        </el-button>
      </template>
    </el-dialog>

    <div class="app-shell">
      <AppHeader v-if="!route.meta.blankLayout" />

      <!-- 工作台壳：通顶侧栏 + 内容列（登录后的功能页）；
           footer 在内容列底部（Linear/Vercel 式），单栏页 footer 仍全宽 -->
      <div v-if="showSidebar" class="workspace">
        <aside class="workspace-aside">
          <AppSidebar />
        </aside>
        <div class="workspace-body">
          <main class="workspace-main">
            <router-view />
          </main>
          <AppFooter />
        </div>
      </div>

      <!-- 单栏壳：公开页/认证页/未登录 -->
      <div v-else class="plain-shell">
        <main class="plain-main">
          <router-view />
        </main>
        <AppFooter v-if="!route.meta.blankLayout" />
      </div>

      <!-- 移动端侧栏抽屉（<768px 时桌面侧栏隐藏，由 AppHeader 汉堡唤起） -->
      <el-drawer v-model="sidebarDrawer" direction="ltr" size="240px" :with-header="false">
        <AppSidebar />
      </el-drawer>
    </div>
  </div>
</template>

<style scoped>
/* 应用壳：纵向 flex，workspace/plain-shell 各自 flex:1 撑满剩余高度，短页 footer 贴底 */
.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

/* 工作台两栏：通顶侧栏（吸在毛玻璃顶栏下方）+ 内容列 */
.workspace {
  flex: 1;
  display: flex;
  align-items: stretch;
}

.workspace-aside {
  flex-shrink: 0;
  width: var(--app-sidebar-w);
  position: sticky;
  top: var(--app-header-h);
  height: calc(100vh - var(--app-header-h));
  overflow-y: auto;
  border-right: 1px solid var(--app-border);
}

.workspace-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.workspace-main {
  flex: 1;
  width: 100%;
  /* 防长内容/长词把两栏布局撑破 */
  max-width: var(--app-content-max);
  margin: 0 auto;
  padding: var(--app-page-y) var(--app-page-x) 48px;
}

/* 单栏壳：公开页/认证页/未登录 */
.plain-shell {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.plain-main {
  flex: 1;
  width: 100%;
  max-width: var(--app-content-max);
  margin: 0 auto;
  padding: var(--app-page-y) var(--app-page-x) 48px;
}

/* 侧栏抽屉：去掉 EP 默认 20px 内边距，让菜单贴边渲染 */
:deep(.el-drawer__body) {
  padding: 0;
}

/* 窄屏：桌面侧栏退场，走 AppHeader 汉堡 + el-drawer */
@media (max-width: 768px) {
  .workspace-aside {
    display: none;
  }
}

/* ===== 管理员公告弹窗 ===== */
.notice-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 小屏保护：480px 固定宽在 <512px 视口会横向溢出 */
:deep(.notice-dialog) {
  max-width: calc(100vw - 32px);
}

/* 多条公告合并展示：超出高度内部滚动，条目间用分隔线 */
.notice-list {
  max-height: 340px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.notice-item+.notice-item {
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 16px;
}

.notice-item-head {
  margin-bottom: 6px;
}

.notice-title {
  font-weight: 600;
  font-size: 16px;
  margin-bottom: 6px;
}

.notice-message {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.notice-docs-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
  font-size: 13px;
  color: var(--el-color-primary);
  text-decoration: none;
}

.notice-docs-link:hover {
  text-decoration: underline;
}

/* 勾选文案较长：允许换行并顶部对齐（el-checkbox 默认 nowrap 单行） */
.notice-checkbox {
  display: flex;
  align-items: flex-start;
  margin-top: 14px;
  white-space: normal;
}

.notice-checkbox :deep(.el-checkbox__label) {
  white-space: normal;
  line-height: 1.5;
}

.notice-footer-note {
  margin-top: 12px;
  font-size: 12px;
  font-style: italic;
  color: var(--el-text-color-secondary);
}

/* ===== 支持作者小节（弹窗底部；侧栏入口打开时为唯一内容） ===== */
.donate-section {
  display: flex;
  gap: 14px;
  align-items: center;
  /* 有公告列表时与列表拉开间距并加分隔线；纯支持视图下上边距收紧 */
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.donate-qr {
  flex: none;
  width: 112px;
  height: 112px;
  border-radius: var(--app-radius-sm);
  border: 1px solid var(--el-border-color);
}

.donate-title {
  font-weight: 600;
  font-size: 15px;
  color: var(--el-text-color-primary);
  margin-bottom: 6px;
}

.donate-desc {
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

/* 侧栏入口打开的纯支持视图：头部标题替代通知 tag */
.donate-header-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
</style>
