import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../stores/auth";

const routes = [
  {
    // 首页：营销页，保持单栏（meta.sidebar=false → 不渲染工作台侧栏）
    path: "/",
    name: "home",
    component: () => import("../pages/Home.vue"),
    meta: { sidebar: false },
  },
  {
    path: "/upload",
    name: "upload",
    component: () => import("../pages/upload/UploadView.vue"),
    meta: { requiresAuthOrPublicShare: true },
  },
  {
    // 反向上传页：面向外部上传者（通常未登录），保持单栏
    path: "/upload/:reverseShareToken",
    name: "reverse-share-upload",
    component: () => import("../pages/upload/UploadView.vue"),
    props: (route: any) => ({ reverseShareToken: route.params.reverseShareToken }),
    meta: { sidebar: false },
  },
  {
    path: "/s/:shareId",
    redirect: (to: any) => `/share/${to.params.shareId}`,
  },
  {
    // 公开访问页：访客多数未登录，保持单栏
    path: "/share/:shareId",
    name: "share",
    component: () => import("../pages/share/ShareView.vue"),
    props: true,
    meta: { sidebar: false },
  },
  {
    path: "/share/:shareId/edit",
    name: "share-edit",
    component: () => import("../pages/share/ShareEditView.vue"),
    meta: { requiresAuth: true },
    props: true,
  },
  {
    // 认证流程页：登录前无工作台，全部单栏
    path: "/auth/signIn",
    name: "sign-in",
    component: () => import("../pages/auth/SignIn.vue"),
    meta: { sidebar: false },
  },
  {
    path: "/auth/signUp",
    name: "sign-up",
    component: () => import("../pages/auth/SignUp.vue"),
    meta: { sidebar: false },
  },
  {
    path: "/auth/totp/:loginToken",
    name: "totp",
    component: () => import("../pages/auth/Totp.vue"),
    props: true,
    meta: { sidebar: false },
  },
  {
    // 验证码回填页：注册后携带 ?email= 进入（新后端 6 位验证码方案，不再有链接 token）
    path: "/auth/verify",
    name: "verify",
    component: () => import("../pages/auth/Verify.vue"),
    meta: { sidebar: false },
  },
  {
    path: "/auth/verify/info",
    name: "verify-info",
    component: () => import("../pages/auth/VerifyInfo.vue"),
    meta: { sidebar: false },
  },
  {
    path: "/auth/resetPassword",
    name: "reset-password",
    component: () => import("../pages/auth/ResetPassword.vue"),
    meta: { sidebar: false },
  },
  {
    path: "/auth/resetPassword/verify",
    name: "reset-password-verify",
    component: () => import("../pages/auth/ResetPasswordVerify.vue"),
    props: true,
    meta: { sidebar: false },
  },
  {
    path: "/account",
    name: "account",
    component: () => import("../pages/account/AccountView.vue"),
    meta: { requiresAuth: true },
  },
  {
    path: "/account/shares",
    name: "account-shares",
    component: () => import("../pages/account/AccountShares.vue"),
    meta: { requiresAuth: true },
  },
  {
    path: "/account/reverseShares",
    name: "account-reverse-shares",
    component: () => import("../pages/account/AccountReverseShares.vue"),
    meta: { requiresAuth: true },
  },
  {
    path: "/account/received",
    name: "account-received",
    component: () => import("../pages/account/AccountReceived.vue"),
    meta: { requiresAuth: true },
  },
  {
    path: "/admin",
    name: "admin",
    component: () => import("../pages/admin/AdminView.vue"),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: "/admin/users",
    name: "admin-users",
    component: () => import("../pages/admin/AdminUsers.vue"),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: "/admin/shares",
    name: "admin-shares",
    component: () => import("../pages/admin/AdminShares.vue"),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: "/admin/announcements",
    name: "admin-announcements",
    component: () => import("../pages/admin/AdminAnnouncements.vue"),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    path: "/admin/config/:category?",
    name: "admin-config",
    component: () => import("../pages/admin/AdminConfig.vue"),
    meta: { requiresAuth: true, requiresAdmin: true },
    props: true,
  },
  {
    path: "/privacy",
    name: "privacy",
    component: () => import("../pages/Legal.vue"),
    props: { type: "privacyPolicy" },
    meta: { sidebar: false },
  },
  {
    path: "/imprint",
    name: "imprint",
    component: () => import("../pages/Legal.vue"),
    props: { type: "imprint" },
    meta: { sidebar: false },
  },
  {
    path: "/error",
    name: "error",
    component: () => import("../pages/ErrorPage.vue"),
    meta: { blankLayout: true },
  },
  {
    path: "/:pathMatch(.*)*",
    name: "not-found",
    component: () => import("../pages/NotFound.vue"),
    meta: { sidebar: false },
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  // 懒初始化：首次导航时拉取用户态（对齐 React getInitialProps 的行为）
  if (!auth.initialized) {
    await auth.refreshUser().catch(() => auth.setUser(null));
  }

  if (to.meta.requiresAdmin && !auth.isAdmin) {
    return { name: "sign-in", query: { redirect: to.fullPath } };
  }
  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    return { name: "sign-in", query: { redirect: to.fullPath } };
  }
  return true;
});
