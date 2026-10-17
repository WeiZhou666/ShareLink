# ShareLink 应用配置方案（AppConfig 三层取值）

> 面试学习文档 · 与代码全量同步（2026-10-08，share/s3 段迁移后扩充至 24 项）
> 姊妹篇：[token-scheme.md](./token-scheme.md)（JWT 双 token 体系）、[oauth-scheme.md](./oauth-scheme.md)（第三方登录）、[i18n-scheme.md](./i18n-scheme.md)（国际化）、[email-scheme.md](./email-scheme.md)（邮件投递）、[jobs-scheme.md](./jobs-scheme.md)（定时任务）

---

## 前置知识：配置体系的三层模型

> 本文档 §1/§2 讲本项目实现；本节先讲业界怎么给配置分层、为什么这样分。

### 1. 配置的三个归宿（业界分层）

| 层 | 典型内容 | 变更代价 | 生效方式 |
|---|---|---|---|
| 环境变量 / .env | 基础设施级：DB 地址、密钥、端口 | 改文件 + 重启进程 | 启动时注入 |
| 配置文件（yaml） | 业务默认值 | 随代码发布 | 发布时生效 |
| 数据库 | 运行时业务开关 | admin 后台一点 | 立即（热更） |

判断一个键放哪层的准绳：**它会不会在运行中变？改它算不算一次发布？** 数据库地址不会运行中变（→ env），"是否开启邮箱验证"会（→ DB）。

### 2. 12-Factor 视角

Config 条款要求配置存于环境、与代码分离：**同一构建产物 + 不同环境配置 = 部署到任何环境**。env 管"环境差异"，config 管"业务参数"——两者混放是常见反模式（密钥写进 yaml 随 git 走 = 泄漏；业务开关写 env = 改开关要重启）。

### 3. 允许覆盖就要定义优先级

多层配置必然要定优先级。本项目：**代码默认值 < DB（admin 改的）< config.yaml（部署者覆盖）**（§2）。设计原则：越靠运行时（DB）越灵活，越靠构建期（yaml）越可控；安全相关的键必须留在高层，不能被 DB 随意覆盖。

### 4. 术语速查

| 术语 | 一句话解释 |
|---|---|
| config.yaml | YAML 业务配置文件，随代码版本管理 |
| 覆盖 override | 高优先级层盖掉低优先级层的值 |
| fail-safe 默认值 | 读不到配置时回落到安全值（危险开关默认关） |
| 热更新 | 不重启进程使新配置生效 |

## 0. 一句话总纲

> **所有可调参数收敛为一个 24 项变量清单（`config.constants.ts`，单一事实来源），取值三层覆盖：`config.yaml`（启动加载一次，进程内只读） > DB `Config` 稀疏表（只存 admin 改过的值） > 代码内 `defaultValue`。yaml 覆盖过的 key 拒绝 admin 界面修改——否则会出现"界面改成功、重启被打回"的假象。敏感凭证（SMTP/OAuth secret）不进配置体系，仍走 env：凭证只该有一处来源。**

与旧后端（Pingvin Share 风格）的差异：旧版 seed 全量落库 + EventEmitter 热更新；新版无 seed、无事件——消费方每次读值即可（读 DB 一次 index 查询，yaml 命中时连 DB 都不碰），加新变量 = 在清单里加一行，零 seed 零 migration。

---

## 1. 先搞懂三个名词

**稀疏表（sparse table）—— DB 只存"偏离默认值"的行**

`Config` 表每行就是一个 `key -> value`。admin 从没改过的配置在表里**没有行**——读取时回落到代码清单的 `defaultValue`。好处：① 新增变量不需要为每个实例写入初始值；② 清单常驻代码，所有变量及默认值打开 `config.constants.ts` 一目了然；③ "恢复默认" = 删行，而不是把默认值抄进库里。

**覆盖层（override layer）—— config.yaml 的定位**

yaml 是**启动时一次性加载**的快照（`onModuleInit` → `loadYamlOverrides`），进程生命周期内只读。它服务于"部署者想锁死某些配置"的场景：Docker 部署用一份 yaml 描述环境差异（应用名、默认语言），UI 怎么点都改不动。修改 yaml 需要重启才生效——这是**特性不是缺陷**：启动期配置就该与进程同生命周期，做热更新（旧版的 EventEmitter 方案）是为不存在的需求付复杂度。

**yaml 管辖（yaml-managed）—— 为什么界面改不动**

yaml 里出现的 key 视为"部署者接管"，`updateMany` 对这类 key 抛 400「只能通过配置文件修改」。不做这层拦截的后果是旧版踩过的坑：界面显示保存成功 → 进程内存值变了 → 重启后 yaml 覆盖层加载 → 值被打回，用户以为系统坏了。

---

## 2. 三层取值链路

```
get('security.enableEmailVerification')
        │
        ▼
┌─ ① yamlOverrides（Map，启动时加载）────── 命中 → 直接返回（不查库）
│        │ 未命中
        ▼
┌─ ② prisma.config.findUnique ──────────── 有行 → 返回 DB 值
│        │ 无行
        ▼
└─ ③ CONFIG_VARIABLES.defaultValue ─────── 兜底
```

- `get()` 未知 key 直接 404（`NotFoundException`）——拼错配置名在第一次读就暴露，而不是静默吃到 undefined；
- `getBoolean()` = `get() === "true"`（存储层统一字符串，类型转换在读端做，与"DB 只存字符串"的稀疏表约束自洽）；
- 对外形态统一为 `{ key, value, defaultValue, type }`——前端 store 拿到后既能渲染当前值，也能高亮"被改过"的项。

### config.yaml 匹配规则

```yaml
# 项目根 config.yaml（CONFIG_FILE env 可指定路径）
general:
  defaultLanguage: zh-CN    #  →  匹配清单键 general.defaultLanguage
security:
  enableEmailVerification: "true"
```

loader 只认**清单里存在的键**：yaml 里的未知键（旧后端遗留的 share/s3/ldap 段等）静默忽略——yaml 可以是超集，清单才是边界。文件不存在是常态（静默跳过），解析坏了降级为 DB/默认值（ERROR 日志但不让应用起不来）。

---

## 3. 模块结构

```
src/config/
├── config.constants.ts   # 13 变量清单 + 分类（单一事实来源）
├── config.service.ts     # 三层取值 / listPublic / listByCategory / updateMany
├── config.controller.ts  # 见下方端点表（路径与前端现有调用对齐，前端零改动）
└── config.module.ts      # @Global，imports RedisModule（testRedis 用）
```

| 端点 | 守卫 | 用途 |
|---|---|---|
| `GET /api/configs` | 公开 | 前端全局 store 消费（public=true 的变量） |
| `GET /api/configs/admin/:category` | AdminGuard | 按分类读全部变量（表单回填） |
| `PATCH /api/configs/admin` | AdminGuard | 批量修改，body `{ updates: { key: value } }` |
| `POST /api/configs/admin/testEmail` | AdminGuard | 发测试邮件（走 EmailService 同一 deliver 链路） |
| `POST /api/configs/admin/testRedis` | AdminGuard | Redis ping 自检 |

**PATCH 整批校验顺序**（任何一个 key 非法 → 整批拒绝，不留半成功状态）：

1. 未知 key → 404
2. yaml 管辖 → 400「只能通过配置文件修改」
3. 类型不符（boolean 必须是 "true"/"false"；number 必须可转数字）→ 400

全部通过才 `$transaction` 批量 upsert。

### 与 @nestjs/config 的命名冲突

`@nestjs/config` 已占用 `ConfigModule/ConfigService` 名字（env 加载在用），所以本模块全部加 `App` 前缀：`AppConfigModule/AppConfigService`。两套体系职责正交：**@nestjs/config 管 env（进程环境），AppConfig 管应用参数（业务可调项）**。

---

## 4. 24 个变量一览

> 完整定义见 `config.constants.ts`（单一事实来源）。public=✓ 的随 `GET /api/configs` 下发（当前 20 项 public）。

| key | type | 默认值 | public | 消费方 |
|---|---|---|---|---|
| `general.appName` | string | ShareLink | ✓ | 前端标题/导航 |
| `general.showHomePage` | boolean | true | ✓ | 首页渲染开关 |
| `general.defaultLanguage` | string | zh-CN | ✓ | 前端无 cookie 时语言（硬约束：默认简体中文） |
| `general.appUrl` | string | http://localhost:5173 | ✓ | 前端弹窗拼 `/s/{id}` 分享链接（yaml 里指向实际端口） |
| `security.allowRegistration` | boolean | true | ✓ | 注册入口显隐 |
| `security.allowUnauthenticatedShares` | boolean | false | ✓ | 匿名分享开关 |
| `security.enableEmailVerification` | boolean | false | ✓ | 注册后是否需验证码激活（**原 env ENABLE_EMAIL_VERIFICATION 迁入**） |
| `security.allowAdminAccessAllShares` | boolean | false | — | 管理员越权访问所有分享（share 守卫消费） |
| `smtp.enabled` | boolean | false | ✓ | 邮件功能开关（凭证在 env，绝不进配置） |
| `oauth.openProviders` | string | github | ✓ | 登录页第三方按钮显隐（逗号分隔） |
| `share.chunkSize` | filesize | 10000000 | ✓ | 单文件分块大小（前后端必须一致：前端切片 + 后端 raw body 限额同源） |
| `share.maxSize` | filesize | 1000000000 | ✓ | 单次分享总大小上限 |
| `share.maxExpiration` | timespan | 0 days | ✓ | 最长有效期（"0 days" = 不限制） |
| `share.defaultExpiration` | timespan | 7 days | ✓ | 创建分享默认选中有效期（**当前 yaml 配为 `never` = 默认永不**） |
| `share.shareIdLength` | number | 8 | ✓ | 随机分享 ID 长度（前端 nanoid 生成） |
| `share.enableUserRecipients` | boolean | false | ✓ | 收件人体系总开关 |
| `share.enableShareEmailRecipients` | boolean | false | — | 下载通知邮件链路（模板未迁移，字段先行保留） |
| `share.enableShareDownloadNotifications` | boolean | false | — | 同上 |
| `share.zipCompressionLevel` | number | 9 | — | zip 压缩等级（仅后端） |
| `legal.enabled` | boolean | false | ✓ | 页脚法律页开关 |
| `legal.imprintText` / `imprintUrl` | text/string | "" | ✓ | 版权页 |
| `legal.privacyPolicyText` / `privacyPolicyUrl` | text/string | "" | ✓ | 隐私政策页 |

> **前端门控与兜底配置的配合**：backend-nest 尚无 config 模块时前端走 `isFallback` 兜底，注册入口判断是 `config.isFallback || config.get("security.allowRegistration") === true`——兜底模式视为开启。config 模块上线后 `/api/configs` 可达，仅显式 `true` 才渲染入口。

---

## 5. 高频坑清单

1. **`../config.yaml` 是相对 cwd 的**：loader 默认 `process.env.CONFIG_FILE || "../config.yaml"`，`nest start --watch` 的 cwd 是 `backend-nest/`，所以指向项目根的 `E:\桌面\ShareLink\config.yaml`。排障时用错 cwd 推断会得出"文件不存在"的假结论（本项目实测踩过：yaml 一直在被加载，我却以为没有）。
2. **yaml 修改必须重启**：覆盖层是启动快照，改文件后不重启进程，内存里还是旧值——"改了没生效"先看启动日志 `config.yaml 已加载，覆盖 N 个配置项`。
3. **yaml 命中数即管辖数**：日志"覆盖 12 个配置项" = 13 个变量里 12 个被 yaml 接管，admin 界面改这 12 个都会 400。想让某项在 UI 可改，从 yaml 里删掉该键再重启。
4. **布尔值在 DB/yaml 里都是字符串** `"true"`：类型只在清单里声明，读取端做转换。直接拿 `get()` 的返回值做真值判断会踩坑（非空字符串恒真），boolean 一律走 `getBoolean()`。
5. **DTO 必须值导入 + `@IsObject()`**：PATCH 的 body 校验靠全局 ValidationPipe，`import type` 会让元数据丢失、校验静默失效（auth 模块同款坑）。
6. **公开端点设计前置**：`public: true` 的变量未登录即可见——注册开关、法律文本这类渲染依据必须 public；不要把"admin 才需要"的变量顺手设成 public。
7. **timespan 校验含 `never` 特例**（2026-10-08 起）：update() 的正则 `^\d+ (minutes|hours|days|weeks|months|years)$|^never$`——`never` = 永不过期（前端 `stringToTimespan` 转 `{value:1, unit:"never"}`，弹窗选中「永不」；后端 `parseExpiration("never")` → 1970）。yaml 加载路径本就无格式校验，正则放宽只为配置挪回 DB 管理时管理端能保存。
8. **filesize 类型存字节数字符串**：前端消费时 parseInt；新增 filesize 变量要同时想好前端展示单位换算（B/KB/MB）在哪层做。

---

## 6. 回归矩阵（2026-10-04 全绿）

| # | 用例 | 期望 | 结果 |
|---|---|---|---|
| R1 | `GET /api/configs` | 13 项；defaultLanguage=zh-CN、enableEmailVerification=true、smtp.enabled=true（均来自 yaml），openProviders=github（代码默认） | ✓ |
| R2 | 无凭证 GET/PATCH admin 端点 | 401 | ✓ |
| R3 | PATCH yaml 管辖项（general.showHomePage） | 400「由 config.yaml 管理」 | ✓ |
| R4 | PATCH 未知 key（foo.bar） | 404 | ✓ |
| R5 | PATCH 合法 string 新值（openProviders） | 200 落库，value 与 defaultValue 可分离 | ✓（已还原并清行） |
| R6 | PATCH 还原 + `GET admin/:category` | 200 返回该分类全量变量（表单回填形态） | ✓ |
| R7 | GET 未知分类 | 404「未知的配置分类」 | ✓ |
| R8 | `testRedis` | `{ok:true}` | ✓ |
| R9 | `testEmail`（QQ SMTP 真发） | 201 无 WARN（deliver 成功静默） | ✓ |
| R10 | 前端登录页 | GitHub 按钮按 openProviders 渲染、注册链接可见 | ✓ |

> boolean/number 类型校验分支（config.service.ts L124-129）为防御性代码：当前 13 变量中全部 boolean 均被 yaml 管辖，yaml 400 先于类型 400 命中，线上路径暂不可达，代码级验证。

---

## 7. 演进留白

- **配置变更审计**：Config 表可加 updatedBy 字段（谁改的），当前一行只记 value/updatedAt；
- **缓存**：`get()` 每次查 DB，公开配置读多写少，后续可加 60s 内存缓存或落 Redis——等出现读瓶颈再说，不过早优化。

> 历史注：本篇 2026-10-04 首版时清单 13 项，share 模块迁移后扩充至 24 项（§4）；当时"share/s3 模块迁移时扩充变量"的留白已完成。§6 回归矩阵为 10-04 的 13 项历史快照，R1 的"13 项"对应当时规模，扩充后应为 20 项 public。
