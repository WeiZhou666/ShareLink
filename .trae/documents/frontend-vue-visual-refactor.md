# frontend-vue 视觉与布局换新实施方案

## Context

项目是 Pingvin Share 二次开发，新前端 frontend-vue 与上游视觉相似度过高：60px 白色顶栏 + 1200px 容器 + Mantine 风格 nav-link + 上游紫 `#6741d9` + AppHeader 全内联样式 + 40px spacer 魔法数，整壳就是上游观感。本次重构**只动视觉与布局层**（模板结构、样式、布局组件），不改业务逻辑/路由/API；保留 Element Plus；目标风格为**现代简洁 SaaS 风**（类 Linear/Vercel：中性灰阶、细边框分隔、克制品牌色、精致亮暗双模式）。品牌主色已定为**靛蓝 `#5E6AD2`**。

## 关键决策

| 决策点 | 结论 |
|---|---|
| 范围 | 视觉与布局（用户选定），不做代码架构重构/品牌重命名 |
| UI 方案 | 保留 Element Plus 深度定制（CSS 变量层 + scoped），不换库 |
| 品牌色 | 靛蓝 `#5E6AD2`，tint 按现有 mixHex 公式预计算为静态值（亮暗两套表见下） |
| 壳层布局 | 顶栏改 sticky 毛玻璃 56px；workspace 改**通顶侧栏**（消灭 top:100px / calc(100vh-100px) / 40px spacer 三个魔法数）；footer 移入内容列 |
| App.vue 主题引擎 | 删除 L64-123 watchEffect + mantineColors + mixHex（appearance.* 键新后端不存在，恒走默认，死代码）；保留暗色切换机制与 customCss 注入；顺带消除 vue-tsc radius 存量错误 |
| i18n | 目标零新增键（主题按钮 emoji 换 Sunny/Moon 图标不需要文案）；如需新键只写 zh-CN + en-US（运行时缺键回退 en-US） |

## Token 层（阶段 1 前置）

新建 `frontend-vue/src/styles/tokens.css`，main.ts 中插在 EP 两份 CSS 之后、global.css 之前（覆盖生效前提：EP 亮色挂 `:root`、暗色挂 `html.dark`(0,1,1)，我们的暗色段用 `:root.dark`(0,2,0) 天然压过）。

**语义变量（亮/暗两套）**：
- 底色：`--app-bg-base` #fafafa/#0a0a0b、`--app-bg-surface` #ffffff/#141416、`--app-bg-subtle` #f4f4f5/#1d1d21、`--app-bg-elevated` #ffffff/#1a1a1f
- 文字：`--app-text-1/2/3` #18181b/#52525b/#a1a1aa（暗 #ececee/#a0a0a8/#63636b）
- 边框：`--app-border` #e4e4e7（暗 #26262a）、`--app-border-strong` #d4d4d8（暗 #34343a）
- 品牌：`--app-brand` #5E6AD2、`--app-brand-hover` #4B55A8、`--app-brand-subtle` rgba 淡底
- 圆角：`--app-radius-sm/md/lg/full` 6/8/12/9999px；阴影三档；字阶 xs~2xl（12/13/14/16/20/24）
- 布局：`--app-header-h` 56px、`--app-sidebar-w` 232px、`--app-content-max` 1120px、`--app-page-x/y` 24px

**EP 变量映射**（tokens.css 内直接覆盖）：`--el-color-primary` 系列用预计算静态值；`--el-border-radius-base`→var(--app-radius-sm)；bg/text/border/fill/shadow 全套指到 --app-*；card/menu/table/dialog/drawer 专项变量。

**靛蓝 tint 预计算表**（公式 mix(c,target,r)=每通道 round(c×(1−r)+target×r)）：

| 变量 | 亮 `:root` | 暗 `:root.dark` |
|---|---|---|
| primary | #5E6AD2 | #5E6AD2 |
| light-3 | #8E97E0 | #7E88DB |
| light-5 | #AFB5E9 | #393F73 |
| light-7 | #CFD2F2 | #2A2E4D |
| light-8 | #DFE1F6 | #23253A |
| light-9 | #EFF0FB | #1B1D27 |
| dark-2 | #4B55A8 | #7E88DB |

迁移后用 getComputedStyle 逐项比对与现引擎输出一致（防 tint 漂移）。

## 五阶段实施（每阶段独立 commit/可单独 revert/可浏览器验证）

### 阶段 1 · Token 地基
- 新建 `src/styles/tokens.css`；改 `src/main.ts`（import 顺序+注释）、`src/styles/global.css`（token 化重写：删 Mantine 痕迹硬编码、body 色引 --app-*、删 `:root[data-theme="dark"]` 段保留 .nav-link 类名在原位暂留）、`src/App.vue`（删 L64-123 引擎）
- 验证：亮/暗全路由走查主色/tint/圆角/底色；getComputedStyle 比对 tint；vue-tsc 无新增错误

### 阶段 2 · 壳层骨架
- `src/components/AppHeader.vue`：内联→scoped；sticky top:0 + backdrop blur 毛玻璃（亮 rgba(255,255,255,.72)/暗 rgba(10,10,11,.72)，@supports 回退纯色）；56px；全宽通栏；用户下拉改首字母圆形头像；emoji 主题按钮换 Sunny/Moon；删模板尾部 40px spacer
- `src/App.vue`：模板 L311-341 重构为通顶结构——`.workspace{display:flex;min-height:calc(100vh - var(--app-header-h))}` + `.workspace-aside{width:var(--app-sidebar-w);position:sticky;top:var(--app-header-h);height:calc(100vh - var(--app-header-h));overflow-y:auto}` + `.workspace-body{flex:1;flex-direction:column}` 内含 main(max-width:1120px) 与 AppFooter；单栏页 `.plain-shell` 同理保 footer 贴底；**notice 公告弹窗段一行不动**；el-drawer body padding:0
- `src/components/AppFooter.vue`：内联→scoped，border-top 弱化文字
- 验证：两栏页/单栏页/blank 页（/error 无顶栏 footer）、短页 footer 贴底、公告弹窗全流程、<768px 汉堡唤抽屉

### 阶段 3 · 侧栏精修
- `src/components/AppSidebar.vue`：232px、背景同 body 仅 border-right 分隔、分组标题 11px/--app-text-3、菜单项 36px 圆角 6px、激活态=灰底+图标着色（`:deep(.el-menu-item.is-active)`）、折叠态 `.group-title{display:none}` 修复保留、底部折叠按钮保留
- tokens.css 追加 menu vars（--el-menu-bg-color:transparent 等）
- 验证：折叠/展开互切（用 `__vueParentComponent.setupState.collapsed` 读真实状态）、折叠态不漏字、tooltip、暗色、抽屉内无边框、admin/非 admin 两态

### 阶段 4 · 页面族（4 个互不阻塞的子步，低风险→高风险）
- global.css 先落 4 个全局工具类（各页 scoped 同名副本删除，模板零改动）：`.page-header`（20px/600 标题+desc+actions）、`.page-toolbar`（flex gap8 下距16）、`.page-stack`（纵 gap16）、`.list-row`（min-width:0 主体+右侧 actions+border-top 分隔+meta 12px 弱化）
- 4a auth：`AuthShell.vue`（400px 边框卡+36px 顶部 logo+可选 wide）、`pages/auth/{Totp,ResetPassword,ResetPasswordVerify,VerifyInfo}.vue` 迁入 AuthShell（仅模板包裹层，脚本零改动）、SignIn/SignUp/Verify 微调
- 4b 列表族：`pages/account/{AccountView,AccountShares,AccountReceived,AccountReverseShares}.vue`（残留 rgba 内联边框一并替换）、`pages/share/{ShareView(720px 聚焦容器),ShareEditView}.vue`
- 4c admin：`pages/admin/{AdminView,AdminUsers,AdminShares,AdminConfig,AdminAnnouncements}.vue`（重复的 page-title/toolbar/search-input scoped 副本删净，el-table 走全局 token）
- 4d upload+Home：`pages/upload/UploadView.vue`、`components/upload/{Dropzone,FileList,CreateUploadModal,CompletedModal}.vue`（Dropzone 虚线 1.5px dashed + brand hover）、`pages/Home.vue`（hero 72px/40px/700/-0.02em、紫色圆点改 brand-subtle、CTA 去药丸圆角、内联全转 scoped）
- 每子步验证：亮/暗、<768px、该族核心流程（登录、建分享、复制链接、admin 搜索、上传完成弹窗）

### 阶段 5 · 打磨与全量回归
- `pages/{ErrorPage,NotFound,Legal}.vue` 收尾 + tokens.css 弹层/滚动条/focus ring 细节 + notice 弹窗 `max-width:calc(100vw - 32px)` 小屏保护
- 全量矩阵：双模式 × {两栏/单栏/blank} × {≥768/<768} 全路由；公告弹窗、删除确认 MessageBox、上传完成 Modal、抽屉、折叠态

## 内联样式收敛通用做法

1. 静态 `:style` 对象→scoped class，搬运与 token 化分开提交
2. `isDark ? A : B` 内联三元→`html.dark .x {}` 分段，模板不再感知暗色
3. EP 定制优先级：tokens.css 全局变量 → 组件 `:deep()` → 禁全局标签污染；`:deep` 仅限白名单（menu 激活项/drawer body/dropdown 触发器/table 表头/checkbox label）
4. 只改实现不改类名（.nav-link 迁 scoped 后管理端 customCss 仍可命中）

## 风险清单（关键 6 条）

1. tokens.css 必须在 dark/css-vars.css 之后 import；global.css 旧暗色硬编码段删净防双源打架
2. tint 预计算与现 mixHex 输出逐项比对防漂移
3. <768px：plain-main padding-top 接替 spacer、Home hero 换行、notice 480px 小屏溢出
4. el-menu 折叠 64px 下自定义 padding/margin 错位——专项验证
5. notice 弹窗 DOM/类名/逻辑一行不动
6. vue-tsc 存量错误不新增（radius 错误随引擎删除消失）

## 验证方式

浏览器 E2E（browser_use）走查全路由矩阵 + 关键流程；`npx vue-tsc --noEmit` 比对错误清单无新增；getComputedStyle 抽查 3 个关键变量确认 token 生效。
