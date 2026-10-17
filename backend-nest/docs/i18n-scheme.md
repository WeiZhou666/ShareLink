# ShareLink 后端国际化方案（nestjs-i18n）

> 面试学习文档 · 与代码全量同步（2026-10-01）
> 姊妹篇：[token-scheme.md](./token-scheme.md)（JWT 双 token 体系）、[oauth-scheme.md](./oauth-scheme.md)（第三方登录）

---

## 前置知识：国际化要解决的问题

> 本文档讲本项目实现；本节先对齐 i18n 的通用工程问题。

### 1. i18n / l10n 是什么

i18n（internationalization，首尾字母 + 中间 18 个）= 让程序**具备**支持多语言的能力；l10n（localization）= 针对具体语言/地区的翻译落地。工程上就是三件事：**翻译资源外置、语言解析、格式化**（日期/数字/复数）。

### 2. 翻译资源怎么组织（业界主流）

按"语言 → 命名空间"两层的资源树（`zh-CN/auth.json`、`en-US/auth.json`），key 用嵌套路径（`auth.signIn.title`）；代码里**绝不出现裸文案**——硬编码文案是 i18n 债，散出去就收不回来。键名是前后端/模板之间的**契约**：新增/改名要全局搜引用（本项目 §4 的构建管线坑即源于此）。

### 3. 用户语言怎么定（协商优先级）

常见信号按优先级：URL 路径前缀（/zh/…）> 用户手动选择（cookie/localStorage）> 账号偏好（DB）> **Accept-Language 头**（浏览器自动）> 默认语言。原则：**显式选择 > 隐式推断**。后端侧（报错消息、邮件）用"这次请求"的协商结果——本项目语言解析链路见 §3。

### 4. 术语速查

| 术语 | 一句话解释 |
|---|---|
| locale | 语言 + 地区标识（zh-CN / en-US） |
| namespace | 按业务模块拆分的资源文件（auth / share / admin） |
| 占位符插值 | `{username}` 模板变量，运行时替换 |
| fallback | 某键在当前语言缺失时回退到的语言 |
| 硬编码文案 | 写死在代码里的字符串——i18n 的头号反模式 |
| ICU MessageFormat | 业界复杂复数/性别规则的格式标准（本项目用简单占位符，未引入） |

## 0. 一句话总纲

> **面向用户的 HTTP 消息（异常 + 响应体）一律走 i18n key，按 `业务域.语义名` 组织；语言由全局 I18nMiddleware 在请求入口解析（`?lang=` 优先，Accept-Language 兜底）并写入 CLS 上下文，此后整条调用链（守卫/策略/服务）取译文都无需关心"当前是什么语言"。运维日志保持中文——日志是给开发者看的，不是给用户看的。**

---

## 1. 先搞懂三个名词

**i18n（internationalization）—— 国际化**

"国际化"的缩写（i + 中间 18 个字母 + n）：把程序里所有**面向人的文字**抽成带 key 的资源，代码只引用 key，运行时按用户的语言偏好从资源表取译文。与 l10n（localization，本地化——针对特定语言/地区的具体翻译与格式适配）相对：i18n 是**能力**（代码层面支持多语言），l10n 是**内容**（每门语言的具体译文）。所以"加一门语言"= 只加 JSON 文件，零代码改动。

**CLS（AsyncLocalStorage，Continuation-Local Storage）—— 异步上下文本地存储**

Node.js 的"请求级全局变量"：一次 HTTP 请求无论穿越多少层 async/await、回调、Promise，链上的代码都能读到同一个上下文对象（如 `当前语言`、`当前用户 id`）。底层是 `node:async_hooks` 的 `AsyncLocalStorage`——每次 `storage.run(ctx, callback)` 都让 callback 的整条异步链共享 `ctx`。没有它，"在 service 深处拿到请求语言"就得层层传参。nestjs-i18n 的核心机制就是这个。

**Accept-Language —— HTTP 语言协商头**

浏览器自动携带的请求头（`zh-CN,zh;q=0.9,en;q=0.8` 形式），表达用户偏好的语言及权重（q 值）。服务端按权重挑一个自己支持的返回。这是"无感知切换"的兜底通道；显式切换靠 URL 查询参数（本项目用 `?lang=`，方便回归测试与前端强制切换）。

### 本项目的语言解析优先级

| 优先级 | 来源 | 例子 | 场景 |
|---|---|---|---|
| 1 | Query 参数 `lang` | `?lang=en-US` | 显式切换、回归测试、前端强制 |
| 2 | `Accept-Language` 头 | `en-US,en;q=0.9` | 浏览器真实偏好 |
| 3 | fallback `zh-CN` | — | 以上全没有 / 语言不支持 |

> 项目硬约束：默认语言是 zh-CN（无 cookie 且浏览器语言不在支持列表时回落中文），与前端语言选择器的约定一致。

---

## 2. 目录结构与资源设计

```
src/i18n/
├── zh-CN/            # 默认语言 + fallback
│   ├── auth.json     # 登录/注册/激活/忘记密码/会话 19 key
│   ├── admin.json    # 管理员后台 5 key
│   └── oauth.json    # 第三方登录（含 provider 层）21 key
└── en-US/            # 第二语言，key 与 zh-CN 一一对应
```

**key 设计三原则**（对齐旧后端 GenericOidcProvider 时代的 i18n 风格）：

1. **`业务域.语义名`**：`auth.wrongCredentials`、`admin.userNotFound`——JSON 文件名即第一个命名空间，防跨域冲突；
2. **camelCase + 描述语义而非文案**：写 `accountNotActivated` 而非 `emailNotVerifiedMsg`——译文换了措辞，key 不动；
3. **插值用 `{var}` 占位**：`"unsupportedProvider": "不支持的登录方式：{name}"`，调用时传 args：

```ts
this.i18n.t('oauth.unsupportedProvider', { args: { name } });
// → "不支持的登录方式：wechat" / "Unsupported login provider: wechat"
```

**范围约定（谁进 i18n，谁不进）**：

| 文字类型 | 是否 i18n | 理由 |
|---|---|---|
| 异常 message（用户可见的 4xx/5xx 响应体） | ✅ | 用户可见，必须随语言切换 |
| 正常响应 message（如 `resetPasswordSuccess`） | ✅ | 同上 |
| 运维日志（`logger.warn/info` 中文） | ❌ | 给开发者看的，保持中文可 grep、可告警 |
| DTO class-validator 校验消息 | ❌（暂缓） | 校验消息经 ValidationPipe 全局生成，i18n 需换 I18nValidationPipe + 错误格式化器，属后续演进 |

---

## 3. 注册与语言解析链路

### 3.1 模块注册（app.module.ts）

```ts
I18nModule.forRoot({
  fallbackLanguage: 'zh-CN',
  loader: I18nJsonLoader,
  loaderOptions: {
    path: path.join(__dirname, '../i18n/'), // 见 §4：dist/src 回退一级到 dist/i18n
    watch: true,                            // 开发模式翻译 JSON 热载
  },
  // resolvers 必须用 { use, options } 形式！见 §5 高频坑
  resolvers: [
    { use: QueryResolver, options: ['lang'] },                  // ?lang=en-US
    { use: AcceptLanguageResolver, options: [] },              // Accept-Language 兜底（RFC4647 感知）
  ],
}),
```

I18nModule 自带 `@Global()`——业务模块无需 import，直接注入 `I18nService` 使用。

### 3.2 全链路时序（为什么守卫里的消息也能切语言）

```
请求 GET /api/admin/users?lang=en-US
  │
  ├─ ① I18nMiddleware（库自动全局挂载，先于一切守卫）
  │     resolveLanguage(resolvers, req) → 'en-US'
  │     req.i18nLang = 'en-US'
  │     I18nContext.create(ctx, next)  → AsyncLocalStorage.run(ctx, next)
  │         ▲ 从这里开始，整条异步链都能 I18nContext.current() 拿到 ctx
  │
  ├─ ② 全局守卫 ThrottlerGuard → 路由守卫 JwtAuthGuard / AdminGuard
  │     （CLS 已就绪：AdminGuard 的 i18n.t('admin.adminRequired') 可正确切英文）
  │
  ├─ ③ 全局拦截器 / 管道（ValidationPipe）→ Controller → Service
  │     （service 里 throw new UnauthorizedException(this.i18n.t('auth.wrongCredentials'))
  │       —— t() 从 CLS 取语言，翻译发生在抛出瞬间，消息已是目标语言）
  │
  └─ ④ AllExceptionFilter 序列化 message → 响应体
```

关键认知：**`i18n.t()` 在"调用瞬间"求值**。语言解析发生在请求入口（①），而所有消息都在 ②③ 链路内生成——天然拿到正确语言。这也是为什么"先解语言、再走守卫"的顺序（middleware 先于 guard）让认证/授权层的 401/403 也能本地化。

### 3.3 用法：三种注入形态

```ts
// ① 普通 service/controller：constructor 注入
constructor(
  private prisma: PrismaService,
  private i18n: I18nService,
) {}
throw new UnauthorizedException(this.i18n.t('auth.wrongCredentials'));

// ② 父类不写 constructor（Nest DI 反射坑规避）：子类注入后赋 protected 字段
// generic-oidc.provider.ts
protected i18n!: I18nService;
// google.provider.ts / local-oidc.provider.ts
constructor(redis: RedisService, i18n: I18nService, @Inject(WINSTON_MODULE_PROVIDER) logger: Logger) {
  super();
  this.redis = redis; this.i18n = i18n; this.logger = logger;
}

// ③ 父子守卫共享：JwtAuthGuard 声明 protected，AdminGuard 直接用 this.i18n
constructor(
  private prisma: PrismaService,
  protected i18n: I18nService,
) { super(); }
```

---

## 4. 构建管线：JSON 怎么进 dist（高频坑）

tsc 只编译 TS，**不会拷贝 JSON**——不处理的话，生产构建后 loader 找不到资源直接启动失败。三步修复：

1. **nest-cli.json 声明资产**（`watchAssets: true` 让 watch 模式下改 JSON 同步拷贝）：

```json
"compilerOptions": {
  "deleteOutDir": true,
  "assets": [{ "include": "i18n/**/*", "watchAssets": true }]
}
```

2. **落点错位**：本项目 tsconfig 把 `src/`、`common/`、`config/` 一起编译，产物是 `dist/src/`、`dist/common/`…，而 assets 相对 sourceRoot 拷贝到 **`dist/i18n/`**。于是 app.module（位于 `dist/src/`）里 `__dirname` 是 `dist/src`，loader path 必须回退一级：

```ts
path: path.join(__dirname, '../i18n/'),   // dist/src → dist/i18n
```

3. **热载**：`loaderOptions.watch: true` + `watchAssets` 双开——开发时改 JSON，进程不动、译文即变（回归时已验证）。

> 另一个 JSON 坑：nest-cli.json 是纯 JSON，**不能写 `//` 注释**（与 env 文件的 `#` 注释是两回事）。

---

## 5. 高频坑清单

**坑 ①：resolvers 裸类写法 = 语言永远 fallback（本项目实际踩中）**

```ts
// ✗ 错误：看似默认参数会生效，实际恒解析不到
resolvers: [QueryResolver, HeaderResolver],
// ✓ 正确：必须显式传 options
resolvers: [
  { use: QueryResolver, options: ['lang'] },
  { use: AcceptLanguageResolver, options: [] },
],
```

原理：库的 `createResolverProviders` 对**裸类条目**注入 `useFactory: () => undefined` 的 options——Resolver 构造函数拿到 `undefined` 后走默认值，而 `QueryResolver`/`HeaderResolver` 的默认 keys 都是 **`[]`**（不是直觉上的 `'lang'`），于是什么都不读，语言恒为 fallback。症状：i18n 本身工作正常（插值、fallback 都对），唯独语言切不动。

**坑 ①-b：HeaderResolver 不支持 RFC4647 列表头（本项目实际踩中）**

浏览器实际发送的 Accept-Language 是带 q 权重的列表形式（`zh-CN,zh;q=0.9,en;q=0.8`），而 `HeaderResolver` 只认**单值头**——遇到列表形式会在日志里打 WARN 并跳过解析，真实浏览器场景 Accept-Language 兜底**恒失效**（curl 单发 `Accept-Language: en-US` 才会通过，回归极易被这种"假绿"骗过）。必须换 `AcceptLanguageResolver`（RFC4647 感知：按 q 权重挑选支持语言）。识别信号：后端日志出现 `HeaderResolver does not support RFC4647 Accept-Language header`。

**坑 ②：`?lang=debug` 探针——判别"没挂载"还是"没解析到"**

`t()` 约定：语言为字面量 `debug` 时**直接返回 key 本身**。两个用途：

```ts
this.i18n.t('auth.wrongCredentials');
```

- `?lang=debug` 返回 `auth.wrongCredentials` → CLS 上下文已建立、解析链路通，问题在具体 resolver 的 keys；
- 返回 `邮箱/用户名或密码错误`（fallback 译文）→ CLS 上下文根本没建立（中间件没挂载 / skipAsyncHook / 调用发生在请求上下文之外）。

一行请求即可二分定位，不用插桩源码。

**坑 ③：父类 constructor 与 Nest DI**

Nest 靠 `design:paramtypes` 反射构造参数做自动注入。抽象父类若写 `constructor(config: string)`，字符串参数会被误当依赖注入导致启动失败。因此 `GenericOidcProvider` 全程不写 constructor，依赖（RedisService/I18nService/Logger）统一由子类构造注入后赋给 `protected` 字段（`this.i18n = i18n`）。

**坑 ④：Express 5 / path-to-regexp v8 通配符语法**

Nest 11 迁移 Express 5 后，路由通配符从 `*` 变为 `{*splat}` 命名语法。若手工挂载中间件（`consumer.apply(...).forRoutes('*')`）匹配不到路径，改用 `forRoutes('{*splat}')`。

---

## 6. 覆盖范围与回归矩阵

**已覆盖（45 处，12 文件）**：auth.service（13）、auth.controller（2）、jwt.strategy（2）、jwt-auth.guard（1）、admin.service（7）、admin.guard（1）、oauth.controller（1）、oauth.service（6）、generic-oidc.provider（9）、wechat.provider（5）——en-US / zh-CN 双份资源。

**回归矩阵（全部通过）**：

| # | 场景 | 期望 | 结果 |
|---|---|---|---|
| 1 | signIn 密码错，无 lang | 中文 `邮箱/用户名或密码错误` | ✅ |
| 2 | 同上 `?lang=en-US` | `Incorrect email/username or password` | ✅ |
| 3 | 同上 `Accept-Language: en-US` | 英文 | ✅ |
| 4 | 不支持的 provider | 插值英文 `Unsupported login provider: nonexistent` | ✅ |
| 5 | 非 admin 访问 admin 接口（守卫层） | 403 双语切换 | ✅ |
| 6 | admin 删不存在用户（service 层） | `User not found` / `用户不存在` | ✅ |
| 7 | 改自己 isAdmin（保护规则） | `Cannot modify your own admin role` | ✅ |
| 8 | 无效 refresh_token | `Session not found` | ✅ |
| 9 | 登录/me/refresh//swagger | 业务零影响 | ✅ |
| 10 | 改 zh-CN JSON 不重启 | 译文热载生效 | ✅ |

---

## 7. 演进方向（刻意留白）

- **DTO 校验消息 i18n**：换 `I18nValidationPipe` + `I18nValidationExceptionFilter`，错误模板进 `validation.json`（key 形如 `validation.EMPTY_EMAIL`）；
- **更多语言**：加目录即生效（如 `ja-JP/`），零代码改动；前端语言选择器把 `?lang=` 带上即可；
- **Cookie 记忆语言**：库自带 `CookieResolver`，与现有语言 cookie 约定对齐后可作为第 1.5 优先级；
- **Swagger 描述多语言**：`@ApiOperation` 的 summary 走 key，`t()` 同样适用。
