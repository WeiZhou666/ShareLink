# ShareLink 邮件投递方案（EmailService / nodemailer）

> 面试学习文档 · 与代码全量同步（2026-10-03）
> 姊妹篇：[token-scheme.md](./token-scheme.md)（验证码/重置 token 体系）、[i18n-scheme.md](./i18n-scheme.md)（邮件语言如何确定）

---

## 前置知识：一封邮件是怎么发出去的

> 面试先讲链路、事务邮件、到达率，再进本项目双模式设计（正文 §2/§3）。

### 1. 链路与角色

发件人客户端（MUA）→ 发件服务器（MTA，SMTP 协议）→ DNS 查收件域的 **MX 记录** → 收件服务器 → 收件箱。应用发信 = 程序扮演 SMTP 客户端，把信交给一台 MTA——要么自己搭（postfix，运维重），要么用现成的（邮箱厂商 SMTP / 专业发信服务）。

### 2. 事务邮件（transactional email）

由**用户动作触发**的功能性邮件（验证码、重置密码、通知），区别于营销邮件。特点：必须低延迟、高到达率、按需单发——验证码 10 分钟过期，意味着邮件延迟 15 分钟功能就废了。

### 3. 到达率为什么难

三大域名认证（SPF / DKIM / DMARC）证明"这封信真是你的域名发的"，缺一个就可能进垃圾箱；共享 SMTP（QQ/163 个人邮箱）有频率限制且信誉共享。高要求生产场景用专业发信服务（SendGrid / SES / 阿里邮件推送）——本项目演进留白保留了该方向（§8），现状走 QQ SMTP（§2 配置）。

### 4. 开发环境怎么收信：不发真邮件

真发到用户邮箱联调又慢又脏（还污染真实收件箱）。业界两种做法：**log 投递**（邮件内容打进日志）或**本地假邮局**（mailpit / maildev，一个带网页收件箱的 SMTP catcher）。本项目做成运行时开关 `MAIL_DELIVERY=log|smtp`（§2），开发默认 log。

### 5. 术语速查

| 术语 | 一句话解释 |
|---|---|
| SMTP | 发信协议；25 明文 / 465 隐式 TLS / 587 STARTTLS |
| 授权码 | 邮箱厂商发给第三方客户端的专用密码（QQ/163），可单独作废 |
| SPF / DKIM / DMARC | 域名级发信人认证三件套 |
| MX 记录 | DNS 里"这个域的邮件交给哪台服务器" |
| mailpit | 本地假邮局（SMTP catcher + 网页收件箱） |
| fail-open | 发信失败不阻断主流程（注册照常成功，邮件失败只告警） |

## 0. 一句话总纲

> **两封事务邮件（激活验证码 / 重置密码）统一从 auth.service 抽到 EmailService；`MAIL_DELIVERY` 一个开关切换 `log`（日志投递，开发默认零配置）与 `smtp`（nodemailer 真发信）；发送 fail-open——邮件失败只打 WARN 不阻断注册/重置主流程，因为凭证（验证码/重置 token）在发信前已落库，可重发。**

---

## 1. 模块结构

```
src/email/
├── email.module.ts   # @Global：业务模块无需 import，直接注入 EmailService（与 PrismaModule 同款基建定位）
└── email.service.ts  # 两个业务方法 + 投递分发 + 懒创建 transporter + HTML 模板
```

业务方法只有两个（事务邮件不该超过一个文件的体量）：

| 方法 | 触发点 | 内容 |
|---|---|---|
| `sendActivationCode(email, code, lang?)` | signUp（需验证时）/ resendVerification | 6 位验证码大字排版（10 分钟有效） |
| `sendResetCode(email, code, lang?)` | requestPasswordReset | 6 位重置验证码大字排版（10 分钟有效）——2026-10-04 起替代重置链接：邮件里没有 URL，不受邮件商安全跳转拦截（QQ 邮箱 xmsafejump 实测拦 localhost）/预扫描提前消费影响，跨设备体验也好 |

## 2. 双模式设计（MAIL_DELIVERY）

```bash
MAIL_DELIVERY=log    # 日志投递（默认）：邮件内容原样进日志——开发/单测零配置
MAIL_DELIVERY=smtp   # 真实发信：SMTP_HOST/PORT/SECURE/USER/PASS/FROM
```

**为什么保留 log 模式而不是「接入后删掉日志投递」**：

1. **零依赖开发**：单测/本地起服务不需要任何 SMTP 基建；
2. **天然安全兜底**：日志投递 = 邮件只能被有服务器权限的人看到，验证码不会被第三方截获；
3. **回归对照**：log 话术与接入前逐字一致（`[激活邮件·日志投递] ...`），行为可对比。

**SMTP transporter 懒创建**：首次真发信才 `createTransport`——log 模式永远不连接；SMTP 参数配错也不会阻塞应用启动，错误延迟到发送时刻并被 fail-open 捕获。

## 3. fail-open：为什么发信失败不抛错

```
凭证生命周期：  落库（激活码/重置 token）→ 发信 → 用户收信
                     ↑                      ↑
                业务已成功              失败可接受：重发按钮兜底
```

发信发生在凭证落库**之后**，此时业务主流程已经成立——SMTP 故障若向上抛错，用户会看到注册失败，但账号其实已创建、验证码已生成，状态自相矛盾。所以 `deliver()` 内部 catch + WARN（`[EmailService] 邮件发送失败：...`），调用方 `void fire-and-forget`（不 await，SMTP 往返不拖慢注册响应）。

> 代价与边界：用户需手动点「重发」。若未来邮件类型扩展到「每分钟限一次的强事务通知」，再考虑 BullMQ 队列 + 退避重试——为两封邮件引队列是过度设计。

## 4. 邮件语言（i18n 集成）

- 调用方透传请求语言：`I18nContext.current()?.lang`（`?lang=` / Accept-Language 已由 I18nMiddleware 解析进 CLS）；
- EmailService 内 `this.i18n.t('email.xxx', { lang })` 取译文——资源文件 `src/i18n/{zh-CN,en-US}/email.json`（主题/正文/按钮/兜底提示共 9 key）；
- `lang` 缺省时（如未来 cron 触发）自然回落 fallback zh-CN。

## 5. HTML 模板：TS 函数而非模板引擎

先用纯 TS 函数拼 HTML（激活码 = 一个大字数字块，主题色 #6741d9），不引 handlebars/pug——模板数量到两位数再换。两个教学理由：

1. 邮件 HTML 必须用 **table/inline style** 老派写法（Outlook/Gmail 剥离 `<style>`），模板引擎的价值在复用布局，两封邮件没有布局可复用；
2. TS 函数有类型、可单测、跳过编译缓存，`renderXxx(code, lang)` 签名即文档。

## 6. 本地联调：假邮局

| 工具 | 启动 | 收件箱 |
|---|---|---|
| **mailpit**（推荐，已入 docker-compose） | `npm run docker:up` | SMTP :1025 · Web http://localhost:8025 |
| maildev（本机 Docker CLI 不可用时的替代） | `npx -y maildev -s 1025 -w 1080` | SMTP :1025 · Web http://localhost:1080 |

`.env.development` 里 `SMTP_HOST=localhost SMTP_PORT=1025 SMTP_USER=`（留空 = 免认证）+ `MAIL_DELIVERY=smtp` 即全链路联调，无需真实邮箱。生产 `.env.production` 默认 `MAIL_DELIVERY=log`，上线改 `smtp` 并填真实凭证（凭证只进 env，绝不入库）。

## 7. 回归矩阵（2026-10-03 全部通过）

| # | 场景 | 期望 | 结果 |
|---|---|---|---|
| 1 | smtp 模式 resendVerification（zh） | maildev 收到中文激活邮件，紫色 6 位码 | ✅ |
| 2 | `?lang=en-US` resendVerification | 英文主题 "ShareLink Email Verification Code" | ✅ |
| 3 | Accept-Language 列表头（RFC4647） | 英文响应 + 英文邮件 | ✅（依赖坑 ①-b 修复） |
| 4 | smtp 模式 requestPasswordReset | 重置邮件含按钮 → `http://localhost:5173/auth/resetPassword/{uuid}` | ✅ |
| 5 | **SMTP 宕机时发信（fail-open）** | 响应仍 200 防枚举话术 + 日志 WARN | ✅ |
| 6 | 切回 log 模式 | 日志话术与接入前逐字一致（含前端化重置链接） | ✅ |
| 7 | 邮箱不存在时 requestPasswordReset | 相同话术、不发信（防枚举） | ✅ |
| 8 | build + 业务回归 | 编译零错误，signIn/me/swagger 不受影响 | ✅ |

## 8. 演进方向（刻意留白）

- **BullMQ 队列**：邮件量大或需要重试语义时上（Redis 已就绪）；
- **handlebars 模板**：邮件类型超过 ~5 封时引入 `@nestjs-modules/mailer`；
- **验证码/重置邮件进 antispam 白名单**：真实 SMTP 上线后关注 SPF/DKIM/DMARC 三件套；
- **`User.preferredLanguage`**：邮件语言落库，不依赖发起请求的浏览器。
