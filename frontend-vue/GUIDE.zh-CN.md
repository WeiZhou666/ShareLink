# Pingvin Share X 前端学习指南（frontend-vue）

> 本项目是 [Pingvin Share](https://github.com/stonith404/pingvin-share)（React/Next.js 版）的 **Vue 3 移植版**：一个自托管文件分享平台，用户可上传文件生成分享链接，支持密码保护、过期时间、限次查看、反向分享（reverse share）等。
>
> 在上游基础上已完成**整体视觉重构**：通顶侧栏工作台（AppSidebar）、品牌靛蓝（#5E6AD2）设计令牌、深空纸飞机首页，与上游的观感差异刻意拉开。

---

## 1. 技术栈

| 类别 | 选型 | 说明 |
|---|---|---|
| 框架 | Vue 3.5（`<script setup>` 组合式 API） | 全部页面组件均为 SFC |
| 语言 | TypeScript 5.6 | `vue-tsc` 做类型检查 |
| 构建 | Vite 6 | 开发端口 3001，`@` 别名指向 `src/` |
| 路由 | vue-router 4 | history 模式，全部页面懒加载 |
| 状态 | Pinia 2 | 仅 2 个 store（auth / config），刻意保持极简 |
| HTTP | axios | 单例封装于 `src/api/client.ts` |
| UI 库 | Element Plus 2.14 | `main.ts` 全量注册 + 全局样式；暗色用 `html.dark` |
| 图标 | @vicons/tabler | 与原版 Pingvin Share 同款 Tabler 图标 |
| 其他 | jose（JWT 解码）、p-limit（并发控制）、qrcode（二维码）、moment（日期，经 `moment.compat.ts` 适配） | |

**没有**用的东西：vue-i18n（自研运行时，见 §9）、CSS 框架（纯手写 CSS + 内联样式）、全局状态库之外的复杂抽象。

---

## 2. 快速开始

```bash
cd frontend-vue
npm install
npm run dev        # http://localhost:3001
```

- 后端默认代理到 `http://localhost:3000`（backend-nest 开发端口），可用环境变量覆盖：`API_URL=http://xxx npm run dev`（注意该变量只从启动 vite 的 shell 环境读取，不走 .env 文件）
- 代理规则在 [vite.config.ts](./vite.config.ts)：`/api` → 后端，与生产环境 Nginx 反代拓扑一致
- 其他脚本：`npm run build`（产出 `dist/`）、`npm run typecheck`（vue-tsc）、`npm run lint`、`npm run format`

---

## 3. 目录结构

```
frontend-vue/
├── index.html                 # SPA 入口
├── vite.config.ts             # 端口 3001、@ 别名、/api 代理
└── src/
    ├── main.ts                # 应用入口：Pinia + Router + Element Plus 全量注册
    ├── App.vue                # 根组件：布局、主题（CSS 变量）、公告弹窗、全局初始化
    ├── env.d.ts
    ├── router/index.ts        # 路由表 + 全局守卫 ★
    ├── pages/                 # 路由页面（按领域分目录）
    │   ├── Home.vue           # 首页（深空纸飞机视觉：极光背景 + 飞行动画）
    │   ├── Legal.vue          # 隐私政策/ imprint（同一组件，props 区分）
    │   ├── ErrorPage.vue / NotFound.vue
    │   ├── auth/              # 登录、注册、TOTP、邮箱验证码、重置密码（7 个）
    │   ├── upload/UploadView.vue        # 上传页（含反向分享复用）
    │   ├── share/             # ShareView（访问分享）、ShareEditView（编辑）
    │   ├── account/           # 我的分享、反向分享、收到的分享、账户设置（4 个）
    │   └── admin/             # 管理端：概览、用户、分享、公告、配置（5 个）
    ├── components/
    │   ├── AppSidebar.vue     # 工作台侧栏（el-menu router 模式，分组 + 折叠）★
    │   ├── AppHeader.vue / AppFooter.vue
    │   ├── AuthShell.vue      # 认证页外壳（登录卡等复用）
    │   ├── ConfigValueInput.vue  # 管理端配置项输入控件
    │   └── upload/            # 上传页四件套：Dropzone、FileList、CreateUploadModal、CompletedModal
    ├── composables/
    │   └── useUpload.ts       # 分块上传编排 ★ 核心逻辑
    ├── stores/
    │   ├── auth.ts            # 当前用户（对齐 React 版 UserContext）
    │   └── config.ts          # 全局配置（对齐 React 版 ConfigContext）
    ├── api/                   # 服务层：一个后端领域一个文件
    │   ├── client.ts          # axios 单例（baseURL: /api）
    │   ├── auth.service.ts    # 登录/JWT 刷新/TOTP/OAuth
    │   ├── share.service.ts   # 分享 CRUD + 分块上传协议（本地代理 / S3 直传双模式）★
    │   ├── user.service.ts / config.service.ts / system.service.ts
    │   ├── announcement.service.ts  # 运营公告（发布/列表/删除/已读）
    │   └── adminNotice.service.ts / admin.service.ts
    ├── i18n/                  # 自研 i18n 运行时 + 33 个语言包
    ├── types/                 # TS 类型（share / user / config / File / timespan）
    ├── utils/                 # 12 个纯工具函数（toast、cookies、crypto、文件大小…）
    └── styles/global.css      # body 底色、暗色规则（data-theme="dark"）
```

---

## 4. 架构分层

```
pages / components          ← 视图层：模板 + Element Plus 组件
      │ 使用
composables (useUpload)     ← 业务编排：上传流程、进度、重试
      │ 调用
stores (auth / config)      ← 全局状态：当前用户、配置变量
      │
api/*.service.ts            ← 服务层：每个后端领域一个文件，统一走 axios 单例
      │ 请求 /api/**
vite proxy（开发）/ 反向代理（生产）
      ↓
NestJS 后端（localhost:8080）
```

要点：

- **视图层不直接调 axios**，一律通过 service；组件间共享状态只进 Pinia，局部状态留在组件里
- React 版的 `getInitialProps`（服务端预载用户/配置）在 SPA 里改成两处懒初始化：路由守卫里拉用户、`App.vue onMounted` 里拉配置（见 §6、§7）

---

## 5. 路由系统（[router/index.ts](./src/router/index.ts)）

### 5.1 完整路由表

| 路径 | 页面 | 守卫 |
|---|---|---|
| `/` | Home | - |
| `/upload` | UploadView | `requiresAuthOrPublicShare`（标记位） |
| `/upload/:reverseShareToken` | UploadView（反向分享上传） | - |
| `/s/:shareId` | **redirect** → `/share/:shareId`（短链兼容） |
| `/share/:shareId` | ShareView | 公开 |
| `/share/:shareId/edit` | ShareEditView | `requiresAuth` |
| `/auth/signIn` `/auth/signUp` | 登录 / 注册 | - |
| `/auth/totp/:loginToken` | 两步验证 | props 传 token |
| `/auth/verify` `/auth/verify/info` | 邮箱验证（6 位验证码回填，`?email=` 进入） | - |
| `/auth/resetPassword` `/auth/resetPassword/verify` | 重置密码（发起 / 验证码回填） | - |
| `/account` | 账户设置（含危险区「删除账号」） | `requiresAuth` |
| `/account/shares` | 我的分享 | `requiresAuth` |
| `/account/reverseShares` | 反向分享管理 | `requiresAuth` |
| `/account/received` | 收到的分享 | `requiresAuth` |
| `/admin` `/admin/users` `/admin/shares` | 管理端概览/用户/分享 | `requiresAuth + requiresAdmin` |
| `/admin/announcements` | 公告管理 | `requiresAuth + requiresAdmin` |
| `/admin/config/:category?` | 系统配置（自绘布局） | `+ blankLayout: true` |
| `/privacy` `/imprint` | Legal.vue（props 区分类型） | - |
| `/error` | 错误页 | `blankLayout` |
| `/:pathMatch(.*)*` | NotFound | - |

### 5.2 关键机制

```ts
router.beforeEach(async (to) => {
  const auth = useAuthStore();
  // 懒初始化：首次导航时才拉取用户态（替代 React 版 getInitialProps）
  if (!auth.initialized) {
    await auth.refreshUser().catch(() => auth.setUser(null));
  }
  if (to.meta.requiresAdmin && !auth.isAdmin)
    return { name: "sign-in", query: { redirect: to.fullPath } };
  if (to.meta.requiresAuth && !auth.isAuthenticated)
    return { name: "sign-in", query: { redirect: to.fullPath } };
  return true;
});
```

- **全部懒加载**：`component: () => import("../pages/xxx.vue")`，按路由自动代码分割
- **登录后回跳**：守卫把目标路径放进 `?redirect=`，登录成功后 `router.push(redirect)`
- **双布局标记**：`meta.sidebar: false`（单栏页：首页、公开分享、认证页、反向上传、法律页、404）与 `meta.blankLayout: true`（无任何壳：错误页）；App.vue 的判定是 `showSidebar = isAuthenticated && sidebar !== false && blankLayout !== true`——未登录即使访问工作台页也回退单栏
- **工作台导航在侧栏**：登录后由 [AppSidebar.vue](./src/components/AppSidebar.vue) 承载（el-menu router 模式，`:default-active=route.path`，上传/分享/管理三分组，管理组 `v-if="auth.isAdmin"`，底部可折叠成 64px 图标模式）；[AppHeader.vue](./src/components/AppHeader.vue) 的 `navLinks` 只在游客态渲染，`<768px` 由汉堡按钮经 `provide("openSidebar")` 唤起 el-drawer 抽屉侧栏（watch 路由自动关闭）

---

## 6. 状态管理（Pinia）

只有两个 store，都刻意做成"React Context 的对等物"：

**auth**（[stores/auth.ts](./src/stores/auth.ts)）
- `user: CurrentUser | null` + `initialized` 标志
- getters：`isAuthenticated`、`isAdmin`
- actions：`refreshUser()`（GET `/users/me`）、`setUser()`

**config**（[stores/config.ts](./src/stores/config.ts)）
- `configVariables`（后端 `/configs` 返回的键值对）+ `isFallback`（后端不可达时用默认配置兜底）
- `get(key, returnDefault?)`：模板里到处在用，如 `config.get("general.appName")`、`config.get("appearance.themePrimaryColor")`

---

## 7. 认证体系（[api/auth.service.ts](./src/api/auth.service.ts)）

- 登录 `POST /auth/signIn` → 后端发 **access_token（JWT）+ refresh_token（HttpOnly cookie）**
- 前端用 `jose` 的 `decodeJwt` 解 access_token 过期时间，`App.vue` 里每 2 分钟调 `POST /auth/token` 静默续期
- TOTP 两步验证：signIn 返回需要 TOTP 时跳 `/auth/totp/:loginToken`
- 邮箱验证为新后端 6 位验证码方案：注册后跳 `/auth/verify?email=xxx` 回填验证码（不再有邮件链接 token）
- 其余：注册、密码重置、TOTP 启用/解绑、OAuth 状态查询
- 登出 `POST /auth/signOut`

---

## 8. 上传分享核心流程 ★ 最值得精读

### 8.1 组件编排（[pages/upload/UploadView.vue](./src/pages/upload/UploadView.vue)）

```
Dropzone（选择/拖拽/粘贴文本，递归读目录）
  → FileList（文件表格 + 进度条 + 删除）
  → CreateUploadModal（填链接 ID/过期/密码/描述 → emit("create")）
      → useUpload().uploadFiles(share)
          → CompletedModal（分享完成：链接、二维码、邮箱发送）
```

### 8.2 分块上传协议（[api/share.service.ts](./src/api/share.service.ts)）

骨架 → 逐块 → complete 三段式，存储驱动双模式：

1. `POST shares` 创建分享骨架（拿到 shareId）
2. **本地代理模式**（默认）：每块 `POST shares/{id}/files`，请求体为 `application/octet-stream` 裸块，query 携带 `id`（前端生成的 36 位 UUID）/`name`/`chunkIndex`/`totalChunks` → `POST .../complete`（返回 202，旧 API 契约）
3. **S3 直传模式（已启用）**：`STORAGE_DRIVER=s3` 时 upload-init 返回 `directToS3: true` + 每块一条预签名 PUT URL → 逐块 `PUT` **直达 MinIO**（跨源直传，字节不过后端）→ complete 提交 etag 回执；`uploadFile` 第 0 块探测 init，**404（local 驱动）/ 报错 / chunkSize 过小都自动降级代理分块模式**。代理模式下分块仍经后端本地 tmp 暂存、最后一块转正时后端流式上传 S3
4. 断点续传：服务端按磁盘已有字节算出期望块索引，不匹配返回 400 `unexpected_chunk_index` + `expectedChunkIndex`（§8.3 的重试依据）
5. 多文件分享 complete 后后台自动打包 zip（`GET .../files/zip` 拉取），单文件降级为原文件流

### 8.3 编排逻辑（[composables/useUpload.ts](./src/composables/useUpload.ts)）

- `p-limit(3)`：最多 3 个文件并发，单文件内分块串行
- 进度：块内进度 + 已完成块字节 → 折算整文件百分比（封顶 99.9，完成才 100）
- 错误恢复两种：
  - `unexpected_chunk_index` → 按服务端期望的索引重发该块
  - 其他错误 → 进度置 `-1`（FileList 渲染为红色异常条），等 5s 从头重试该文件
- 全部文件 ≥100 且无 `-1` → `completeShare` → 回调 `onCompleted` 弹 CompletedModal

**反向分享**：`/upload/:reverseShareToken` 同一页面复用，创建分享时 `isReverseShare=true` 走 `POST reverseShares/{token}/shares`。

---

## 9. i18n：自研运行时（[i18n/index.ts](./src/i18n/index.ts)）

**为什么不用 vue-i18n**：33 个语言包是 Crowdin 导出的扁平 `Record<string, string>`，内含 react-intl 的 ICU 语法（`{count, plural, =1 {...} other {...}}`）和 `@`/`|` 保留字，vue-i18n 的消息编译器消化不了。自研运行时让语言包**零改动**复用。

实现三件事：

1. 扁平 key 查找：当前语言 → 回退 en-US → 回退 key 本身
2. `{name}` 命名插值
3. ICU 复数的最小解析（只支持 `=n` 精确匹配 + `other` 兜底，覆盖项目全部用法）

语言决策链：**cookie `language` → 浏览器语言（找相似前缀）→ 兜底 zh-CN**。
切换语言 = 写 cookie + `window.location.reload()`（非响应式切换，简单可靠）。

```ts
t("upload.notify.count-failed", { count: 2 });   // 组件里直接 import { t }
```

新增语言：往 `i18n/translations/` 加 `<code>.ts` 并在 `i18n/locales.ts` 注册。

---

## 10. UI 层：Element Plus + 主题

- [main.ts](./src/main.ts)：`app.use(ElementPlus)` 全量注册 + `element-plus/dist/index.css` + 暗色变量包 `theme-chalk/dark/css-vars.css`（`html.dark` 时生效）。`v-loading` 指令全局可用
- **主题映射**（[App.vue](./src/App.vue)）：管理端可配置主色（Mantine 命名色/自定义 hex）与圆角，`watchEffect` 把它们换算成 Element Plus 的 CSS 变量：

```ts
document.documentElement.style.setProperty("--el-color-primary", primary);
// 以及 light-3/5/7/8/9（hover、plain 底色）、dark-2（按压）——用 mixHex 手动混色
document.documentElement.style.setProperty("--el-border-radius-base", ...);
```

- **暗色模式**：`html.dark`（Element Plus）+ `html[data-theme="dark"]`（global.css 的 body 规则）双轨同步，右上角 🌙 切换，跟随系统 + 用户偏好（localStorage）+ 管理端默认，优先级从高到低
- **全局自定义 CSS**：管理端配置的 `appearance.customCss` 在 App.vue 里转义后以 `<style>` 注入
- **公告弹窗**：App.vue 把系统级通知与运营公告合并为同一 pendingNotices 队列，渲染进单个 el-dialog 列表（多条不再逐条弹窗）；勾选「已全部知悉」确认后逐条调用各自 dismiss，全部成功才清空关闭
- 组件约定：模板直接用 `el-*` 标签（无需 import）；图表标用 `@vicons/tabler`

---

## 11. 工具函数速查（src/utils/）

| 文件 | 作用 |
|---|---|
| toast.ts | ElMessage 封装（`toast.error/success/info/axiosError`），任意位置可调 |
| cookies.ts | get/set cookie |
| crypto.util.ts | 前端加密相关 |
| file.util.ts / fileSize.util.ts / mime.util.ts | 文件名规范化、字节数格式化、MIME 判断 |
| date.util.ts / moment.compat.ts | 日期格式化（moment 的兼容层） |
| defaultConfig.util.ts | 后端不可达时的默认配置兜底 |
| error.util.ts | 从 axios 错误提取后端 message |
| upload.util.ts | 上传相关辅助 |
| userPreferences.util.ts | localStorage 用户偏好（如明暗色选择） |

---

## 12. 建议学习路线

按这个顺序读，每一步都有明确产出：

1. **跑起来**：`npm run dev`，注册账号、上传一个文件、访问分享链接，对着页面认组件
2. **骨架**：[main.ts](./src/main.ts) → [App.vue](./src/App.vue) → [AppSidebar.vue](./src/components/AppSidebar.vue) → [router/index.ts](./src/router/index.ts)，理解入口、双布局判定、守卫
3. **状态**：[stores/auth.ts](./src/stores/auth.ts) → [stores/config.ts](./src/stores/config.ts)，体会"极简 Pinia"
4. **一条完整业务链**：登录 → [auth/SignIn.vue](./src/pages/auth/SignIn.vue) → [api/auth.service.ts](./src/api/auth.service.ts) → [api/client.ts](./src/api/client.ts)，理解 token 流
5. **核心难点**：[pages/upload/UploadView.vue](./src/pages/upload/UploadView.vue) → [components/upload/](./src/components/upload/) 四件套 → [composables/useUpload.ts](./src/composables/useUpload.ts) → [api/share.service.ts](./src/api/share.service.ts) 的分块协议。这是全项目逻辑密度最高的部分
6. **特色设计**：[i18n/index.ts](./src/i18n/index.ts)（为什么不引入 vue-i18n）与 App.vue 的主题 CSS 变量映射
7. **收尾**：admin 目录（配置表单的动态渲染）、utils 各文件

### 与 React 版的主要差异（移植时值得对照）

| React 版 | Vue 版 |
|---|---|
| Next.js（SSR + getInitialProps 预载） | Vite SPA（路由守卫 + onMounted 懒初始化） |
| Mantine UI | Element Plus |
| react-intl + react-i18next | 自研 i18n 运行时 |
| Context（UserContext/ConfigContext） | Pinia（auth/config） |
| react-query 部分场景 | 直接 async/await + 局部 ref |

> 备注：类型检查存在 7 个已知的存量报错（`npm run typecheck`），分布在 `config.service.ts`、`stores/config.ts`（`Config` 导入）、`ShareEditView.vue`、`UploadView.vue`（类型收窄）与 `en-US.ts`（重复键），属移植期遗留，不影响运行。
