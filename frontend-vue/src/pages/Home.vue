<script setup lang="ts">
// 首页（游客落地页）：深空沉浸 hero（极光流光 + 纸飞机飞越动画）+ 亮色特性卡区。
// 文案全部复用既有 home.* i18n 键（30 语言包齐全），仅 home.badge 为新增键（zh+en）。
// 已登录用户直接跳转上传页，不展示落地页。
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { Files, House, Lock } from "@element-plus/icons-vue";
import { useAuthStore } from "../stores/auth";
import { useConfigStore } from "../stores/config";
import { t } from "../i18n";

const router = useRouter();
const auth = useAuthStore();
const config = useConfigStore();

// 富文本标题："A <h>self-hosted</h> file sharing platform." → 高亮 span
const heroTitle = computed(() =>
  t("home.title").replace(/<h>/g, '<span class="home-highlight">').replace(/<\/h>/g, "</span>"),
);

const signupEnabled = computed(() => config.get("security.allowRegistration") !== false);

// 已登录用户直接跳转上传页（与 React 版行为一致）
onMounted(() => {
  if (auth.isAuthenticated) router.replace("/upload");
});

const startButtonHref = computed(() =>
  signupEnabled.value ? "/auth/signUp" : "/auth/signIn",
);

// 特性区三卡：复用 home.bullet.a/b/c 文案
const features = [
  { icon: House, name: "home.bullet.a.name", description: "home.bullet.a.description" },
  { icon: Files, name: "home.bullet.b.name", description: "home.bullet.b.description" },
  { icon: Lock, name: "home.bullet.c.name", description: "home.bullet.c.description" },
];
</script>

<template>
  <div class="home-page">
    <!-- 深空沉浸 hero：常驻深色（不随主题翻转），极光 + 网格 + 纸飞机 -->
    <section class="hero">
      <div class="hero-bg" aria-hidden="true">
        <div class="aurora aurora-a" />
        <div class="aurora aurora-b" />
        <div class="hero-grid" />
        <!-- 两架纸飞机错峰飞越：大架主视觉，小架远景层次 -->
        <span class="plane plane-a"><img src="/img/logo.svg?v=5" alt="" /></span>
        <span class="plane plane-b"><img src="/img/logo.svg?v=5" alt="" /></span>
      </div>

      <div class="hero-inner">
        <span class="hero-badge">
          <span class="badge-dot" />
          {{ t("home.badge") }}
        </span>

        <h1 class="hero-title" v-html="heroTitle" />
        <p class="hero-desc">{{ t("home.description") }}</p>

        <div class="hero-cta">
          <el-button size="large" type="primary" class="cta-main" @click="router.push(startButtonHref)">
            {{ t("home.button.start") }}
          </el-button>
        </div>
      </div>
    </section>

    <!-- 亮色特性区：三卡 bento，跟随明暗主题 -->
    <section class="features">
      <div v-for="f in features" :key="f.name" class="feature-card">
        <span class="feature-icon">
          <el-icon :size="22">
            <component :is="f.icon" />
          </el-icon>
        </span>
        <h3 class="feature-name">{{ t(f.name) }}</h3>
        <p class="feature-desc">{{ t(f.description) }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ===== hero：全屏深空 ===== */
/* 负 margin 逃逸 1120px 容器，铺满视口（配合 global 的 body overflow-x:hidden） */
.hero {
  position: relative;
  margin-inline: calc(50% - 50vw);
  min-height: calc(100dvh - var(--app-header-h));
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background:
    radial-gradient(ellipse 120% 80% at 50% -20%, rgba(94, 106, 210, 0.28), transparent 60%),
    linear-gradient(180deg, #0b0c14 0%, #0d0f1c 55%, #10121f 100%);
  color: #fff;
}

.hero-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* 极光流光：两个大 blur 圆缓慢漂移 */
.aurora {
  position: absolute;
  width: 720px;
  height: 720px;
  border-radius: 50%;
  filter: blur(90px);
  opacity: 0.55;
}

.aurora-a {
  left: -12%;
  top: -18%;
  background: radial-gradient(circle, rgba(94, 106, 210, 0.55), transparent 65%);
  animation: drift-a 18s ease-in-out infinite alternate;
}

.aurora-b {
  right: -14%;
  bottom: -22%;
  background: radial-gradient(circle, rgba(139, 92, 246, 0.38), transparent 65%);
  animation: drift-b 22s ease-in-out infinite alternate;
}

@keyframes drift-a {
  from {
    transform: translate(0, 0) scale(1);
  }

  to {
    transform: translate(14vw, 8vh) scale(1.15);
  }
}

@keyframes drift-b {
  from {
    transform: translate(0, 0) scale(1.1);
  }

  to {
    transform: translate(-12vw, -8vh) scale(0.95);
  }
}

/* 细网格：中心亮四周渐隐，撑起空间感 */
.hero-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px);
  background-size: 52px 52px;
  mask-image: radial-gradient(ellipse 75% 65% at 50% 42%, black 30%, transparent 100%);
  -webkit-mask-image: radial-gradient(ellipse 75% 65% at 50% 42%, black 30%, transparent 100%);
}

/* 纸飞机飞越：弧线 + 微俯仰，带渐隐尾迹 */
.plane {
  position: absolute;
  top: 58%;
  left: 0;
  display: inline-flex;
  animation: plane-fly 13s linear infinite;
  will-change: transform;
}

.plane img {
  width: 38px;
  height: 38px;
  filter: drop-shadow(0 0 14px rgba(94, 106, 210, 0.85));
}

/* 尾迹：挂在飞机运动反方向 */
.plane::after {
  content: "";
  position: absolute;
  right: calc(100% - 10px);
  top: 55%;
  width: 120px;
  height: 2px;
  background: linear-gradient(90deg, transparent, rgba(139, 148, 240, 0.75));
  transform: rotate(6deg);
  transform-origin: right center;
}

.plane-a {
  animation-delay: 0s;
}

/* 远景小飞机：错开半程，透明度压低做层次 */
.plane-b {
  animation-delay: -6.5s;
  opacity: 0.55;
}

.plane-b img {
  width: 24px;
  height: 24px;
}

@keyframes plane-fly {
  0% {
    transform: translate(-10vw, 24vh) rotate(5deg);
    opacity: 0;
  }

  8% {
    opacity: 1;
  }

  50% {
    transform: translate(46vw, -6vh) rotate(-7deg);
  }

  92% {
    opacity: 0.9;
  }

  100% {
    transform: translate(108vw, -26vh) rotate(-11deg);
    opacity: 0;
  }
}

/* ===== hero 文案 ===== */
.hero-inner {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 880px;
  padding: 96px var(--app-page-x) 72px;
  text-align: center;
}

.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(6px);
  font-size: 13px;
  color: rgba(255, 255, 255, 0.78);
  letter-spacing: 0.02em;
}

.badge-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #7cdb9b;
  box-shadow: 0 0 8px rgba(124, 219, 155, 0.9);
}

.hero-title {
  margin: 28px 0 0;
  font-size: clamp(42px, 7.2vw, 84px);
  line-height: 1.06;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: #fff;
  text-wrap: balance;
}

/* 标题高亮词：靛蓝→紫→青 渐变文字（v-html 内容需 :deep） */
.hero-title :deep(.home-highlight) {
  background: linear-gradient(120deg, #97a1f5 0%, #c0a8ff 45%, #7dd9f5 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.hero-desc {
  margin: 22px auto 0;
  max-width: 560px;
  font-size: clamp(16px, 1.6vw, 19px);
  line-height: 1.65;
  color: rgba(255, 255, 255, 0.66);
}

.hero-cta {
  margin-top: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  flex-wrap: wrap;
}

/* 主 CTA：加发光阴影，深底上更跳 */
.cta-main {
  height: 48px;
  padding: 0 34px;
  font-size: 16px;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(94, 106, 210, 0.45);
}

/* ===== 亮色特性区 ===== */
.features {
  width: 100%;
  max-width: var(--app-content-max);
  margin: 0 auto;
  padding: 56px var(--app-page-x) 72px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}

.feature-card {
  padding: 28px 26px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-lg);
  background: var(--app-bg-surface);
  transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
}

.feature-card:hover {
  transform: translateY(-3px);
  border-color: var(--el-color-primary);
  box-shadow: var(--app-shadow-sm);
}

.feature-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 10px;
  background: var(--app-brand-subtle);
  color: var(--el-color-primary);
}

.feature-name {
  margin: 16px 0 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--app-text-1);
}

.feature-desc {
  margin: 8px 0 0;
  font-size: var(--app-font-md);
  line-height: 1.6;
  color: var(--app-text-2);
}

/* ===== 响应式 ===== */
@media (max-width: 900px) {
  .features {
    grid-template-columns: 1fr;
    padding-top: 40px;
  }
}

@media (max-width: 768px) {
  .hero-inner {
    padding-top: 72px;
    padding-bottom: 56px;
  }

  .plane img {
    width: 28px;
    height: 28px;
  }
}

/* 无障碍：关闭所有动效，飞机静态隐藏 */
@media (prefers-reduced-motion: reduce) {

  .aurora,
  .plane {
    animation: none;
  }

  .plane {
    opacity: 0;
  }
}
</style>
