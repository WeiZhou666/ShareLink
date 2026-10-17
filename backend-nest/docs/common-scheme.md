# 横切基础设施方案（全局异常 · 限流 · 安全响应头 · bootstrap）

> 面试学习文档 · 与代码全量同步（2026-10-12）
> 姊妹篇：[env-scheme.md](./env-scheme.md)（环境加载与 zod 校验）、[i18n-scheme.md](./i18n-scheme.md)（多语言）、[token-scheme.md](./token-scheme.md)（认证链）、[file-scheme.md](./file-scheme.md)（下载响应头消费方）

---

## 前置知识：横切关注点与 Nest 的全局注册位

> 面试先讲"横切关注点"为什么不能散在业务代码里，再进本项目实现（正文 §1-§4）。

### 1. 横切关注点（cross-cutting concerns）

异常整形、限流、安全头、日志——这些能力**每个接口都需要，但都不属于任何一个业务模块**。散着写会出现三种腐烂：实现漂移（十个接口十种错误格式）、遗漏（新接口忘了限流）、不可测试（改一处要回归全部）。

集中治理的手段：**在框架的"全局注册位"上各挂一份实现**。Nest 提供的全局位：

| 全局位 | 注册方式 | 本项目挂的 |
|---|---|---|
| 全局异常过滤器 | `{ provide: APP_FILTER, ... }` | AllExceptionFilter |
| 全局守卫 | `{ provide: APP_GUARD, ... }` | ThrottlerGuard |
| 全局管道 | `app.useGlobalPipes()` | ValidationPipe（whitelist + transform） |
| 全局前缀/中间件 | `app.setGlobalPrefix()` / `app.use()` | `/api`、cookie-parser |

### 2. 限流的层次（业界演进）

- **粗粒度全局限流**：保护服务器整体（防爬虫/防误循环）——一刀切
- **细粒度端点限流**：凭据验证、验证码、枚举探测类接口单独收紧——防爆破/防枚举
- **为什么不能只靠全局限流**：下载类接口（视频 Range 播放高频打点）与登录接口（必须收紧）的合理速率差 3 个数量级，全局单一阈值必然"要么误杀下载、要么放行爆破"

### 3. 错误响应的契约思维

前端要做协议分支（如断点续传按 `expectedChunkIndex` 补块、按 `error` 错误码切 UI），前提是**后端异常响应的结构是稳定契约**。"抛什么 → 前端收到什么"必须全局唯一确定，这就是全局异常过滤器的存在意义。

### 4. 术语速查

| 术语 | 一句话解释 |
|---|---|
| 横切关注点 | 跨多个业务模块的通用能力（异常/日志/限流） |
| APP_FILTER / APP_GUARD | Nest 全局 provider 令牌：注册即对全部路由生效 |
| @Throttle | @nestjs/throttler 的端点级限流装饰器，覆盖全局默认值 |
| nosniff | 禁止浏览器嗅探改判 Content-Type 的响应头 |

## 0. 一句话总纲

> **四件全局事，四个注册位**：① `AllExceptionFilter`（APP_FILTER）把一切异常统一成 `{ statusCode, ...字段 }` 的稳定契约——**对象形态 HttpException 整体展开**是分块续传协议的根基；② `ThrottlerGuard`（APP_GUARD）全局限流 100 次/60 秒，敏感端点 `@Throttle` 单独收紧（登录 20/5min、文件下载 1200/分）；③ 下载响应头三防线：nosniff + 非被动媒体 CSP sandbox + RFC 5987 中文文件名；④ `main.ts` bootstrap 按序装配 env-loader → winston → cookie/CORS/管道 → Swagger。

---

## 1. 全局异常过滤器（AllExceptionFilter）

```ts
// common/filters/all-exception.filter.ts（APP_FILTER 全局注册）
@Catch()
export class AllExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        body = { statusCode: status, message: res };
      } else {
        const obj = res as Record<string, unknown>;
        body = { statusCode: status, ...obj };   // 对象形态整体展开
      }
    } else {
      status = 500;
      body = { statusCode: 500, message: '服务器内部错误' };   // 内部细节不外泄
    }
    this.logger.error('请求发生异常', { url, method, query, body, statusCode, errorMsg, error: stack });
    response.status(status).json(body);
  }
}
```

三个关键决策：

- **对象形态必须整体展开，不能压平成 `{ statusCode, message }`**——前端按响应体里的字段做协议分支：
  - 分块上传续传：`{ message, error: "unexpected_chunk_index", expectedChunkIndex }`（[file-scheme.md](./file-scheme.md) §3.1）
  - 分享密码错误码：`error: "share_password_required"`
  压平会把这些字段丢掉，协议直接失效；
- **非 HttpException 一律 500 + 固定话术**：堆栈只进日志不进响应（内部细节不外泄）；
- **无 code/data 包装**：与旧后端约定一致，前端零迁移。

**日志侧**：每条异常记录 url/method/query/body/statusCode/堆栈——排障时一次看全上下文；logger 用 `WINSTON_MODULE_PROVIDER` 注入原生 winston（保留 meta 元数据，nest-winston 的 Nest 适配层会丢 meta）。

## 2. 限流体系（ThrottlerModule）

### 2.1 全局基线

```ts
// app.module.ts
ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
// providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }]
```

全局 100 次/60 秒兜底（防爬虫/防误循环），按 IP 维度（内存存储；多实例部署时换 Redis 存储器，见演进留白）。

### 2.2 端点级覆盖（@Throttle 全表）

| 端点 | 限流 | 防什么 |
|---|---|---|
| `POST /auth/signIn` | 20/5min | 密码爆破 |
| `POST /auth/recoverAccount` | 10/5min | 凭据验证型，与 signIn 同档 |
| `POST /auth/signUp` | 10/h | 批量注册 |
| `POST /auth/verifyEmail` | 10/h | 6 位码空间仅 10⁶，接口层是防爆破第二道闸 |
| `POST /auth/resendVerification` | 5/h | 防刷激活邮件（邮件轰炸） |
| `POST /auth/requestPasswordReset` | 5/h | 防刷重置邮件 |
| `POST /auth/resetPassword` | 10/h | 验证码爆破 |
| `GET /shares/isShareIdAvailable/:id` | 10/60s | 公开可探测（枚举分享 id） |
| `GET /reverseShares/isReverseShareTokenAvailable/:token` | 10/60s | 同上（枚举令牌） |
| `GET /reverseShares/:token` | 20/60s | 令牌信息公开端点 |
| `POST /shares/:id/token` | 20/5min | 密码验证型（换分享令牌） |
| `GET /shares/:shareId/files/:fileId` | **1200/分** | **放宽**：视频 Range 播放高频打点，全局 100/分必误杀 |

设计逻辑一句话：**凭据验证型从严（防爆破）、枚举探测型收紧（防枚举）、高频合法流量放宽（防误杀）**。限流值不是拍脑袋，是按"接口暴露的信息量 × 尝试成本"分档。

## 3. 下载响应头三防线（file.controller / share.utils）

### 3.1 防嗅探 + 内联执行防护

```ts
const isPassiveMedia =
  mimeType.startsWith("video/") || mimeType.startsWith("audio/") ||
  (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") ||
  mimeType === "text/plain";

const headers = {
  "Content-Type": mimeType,
  "X-Content-Type-Options": "nosniff",   // 防线一：禁止浏览器嗅探改判类型
  "Content-Disposition": buildContentDisposition(name, isDownload ? "attachment" : "inline"),
};
if (!isPassiveMedia) {
  headers["Content-Security-Policy"] = "sandbox";   // 防线二：inline 打开时禁脚本/同源访问
}
```

威胁模型：分享里的文件是**用户上传的任意字节**。若允许 `text/html` inline 打开，恶意 HTML 在同域执行脚本 → 偷 access_token cookie（存储型 XSS）。对策分层：

- **nosniff**：浏览器不再凭内容嗅探改判 Content-Type（防"伪装成 text/plain 的 HTML"）；
- **被动媒体白名单**：视频/音频/图片（SVG 除外——SVG 可含脚本）/纯文本可以安全 inline；
- **CSP sandbox**：非被动媒体 inline 打开时禁脚本、禁同源访问——即使内容是恶意 HTML 也在沙箱里跑不起来。

### 3.2 Content-Disposition 与 RFC 5987

```ts
// share.utils.ts — 自实现替代 content-disposition 依赖（只覆盖本项目两种模式）
export function buildContentDisposition(fileName: string, mode: "attachment" | "inline"): string {
  const fallbackName = fileName.replace(/[^\x20-\x7e]|["%\\]/g, "_").replace(/"/g, "'");
  const encodedName = encodeURIComponent(fileName)
    .replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${mode}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`;
}
```

中文文件名必须走 `filename*=UTF-8''...`（RFC 5987）——只写 `filename=` 会乱码或被截断；同时提供 ASCII fallback 给老客户端。**头注入也要防**：引号/换行/百分号这些对 HTTP 头有毒的字符在 fallback 里被替换。

### 3.3 Range 语义（下载链路的一部分）

`Accept-Ranges: bytes` + 命中区间回 206（`Content-Range: bytes start-end/total`）+ 起点越界回 416（`Content-Range: bytes */total`，播放器据此复位）——完整实现见 [file-scheme.md](./file-scheme.md) §5.1，本篇只列头语义。

## 4. main.ts bootstrap 与 app.module 装配

### 4.1 bootstrap 顺序（每步都有理由）

```ts
// main.ts — import 顺序即语义
import '../config/env-loader';        // ① 必须第一个 import：winston 工厂要读 LOG_LEVEL
import { NestFactory } from '@nestjs/core';
```

```
NestFactory.create(AppModule)
  → app.useLogger(winston)          // 内置 logger 替换为 winston
  → app.setGlobalPrefix('api')      // 与前端及旧后端约定一致
  → app.enableShutdownHooks()       // 进程退出触发 PrismaService.onModuleDestroy 断连
  → app.use(cookieParser())         // 认证方案依赖 req.cookies（access_token/refresh_token）
  → app.enableCors({ origin: 白名单, credentials: true })   // cookie 认证必须 credentials
  → app.useGlobalPipes(ValidationPipe({ whitelist: true, transform: true }))
  → SwaggerModule.setup('api-docs') // /api-docs（v11 不叠加全局前缀）
  → app.listen(PORT ?? 3000)
```

要点：

- **CORS**：`CORS_ORIGIN` env 逗号分隔白名单；**未配置时放行所有来源（仅限开发）**，生产由 env-loader zod 强制必填（[env-scheme.md](./env-scheme.md)）；`credentials: true` 是 cookie 跨域携带的前提；
- **ValidationPipe whitelist**：剔除 DTO 未声明的字段（防 mass-assignment——客户端塞 `isAdmin: true` 进 body 也进不了实体）；`transform` 让 query/body 按 DTO 类型自动转型；
- **Swagger 认证方案**：注册 cookie 型 apiKey（`access_token`）并注明"swagger-ui 无法通过 Authorize 注入 cookie，需先调 signIn 建立浏览器会话"——与真实鉴权方式一致（[token-scheme.md](./token-scheme.md)：JWT 只认 cookie 不认 Bearer 头）。

### 4.2 app.module 全局 provider

```ts
providers: [
  { provide: APP_FILTER, useClass: AllExceptionFilter },   // 全局异常整形
  { provide: APP_GUARD, useClass: ThrottlerGuard },        // 全局限流
],
```

imports 顺序（① env/config → ② winston → ③ Prisma → ④ Email → ⑤ Throttler → ⑥ Schedule → 业务模块 → ⑭ i18n）本身就是一份"依赖先行"清单；i18n 的 resolvers 配置坑与 fallback 策略见 [i18n-scheme.md](./i18n-scheme.md)。

## 5. 高频坑清单

1. **对象形态 HttpException 压平 = 协议失效**：`{ ...obj }` 展开不是风格偏好——`expectedChunkIndex`、`error` 错误码都靠它到达前端。新加协议字段时确认过滤器没有中途改形。
2. **nest-winston 两种 provider 别混**：`WINSTON_MODULE_NEST_PROVIDER`（Nest 适配层，丢 meta）与 `WINSTON_MODULE_PROVIDER`（原生 winston，保留 meta）——需要带 meta 的结构化日志（如异常过滤器）必须用后者。
3. **SVG 不是被动媒体**：`image/svg+xml` 可内嵌脚本，被动媒体白名单里显式排除——漏排就是存储型 XSS。
4. **限流存储的实例边界**：默认内存存储按进程计数，多实例部署时同一 IP 的配额 = 实例数 × 100——横向扩容前必须换 Redis 存储器。
5. **Express 5 的 params/query 类型**：值是 `string | string[]`，拼路径/查库前一律 `String()` 收窄（file.controller 的 shareId 校验即此写法）。
6. **Swagger 路径不带 /api**：v11 的 `SwaggerModule.setup` 按原始路径挂载不叠加全局前缀，文档在 `/api-docs` 而非 `/api/api-docs`。

## 6. 面试速答（30 秒版）

- **Q: 全局异常过滤器为什么要"对象展开"？** HttpException 的 getResponse() 有字符串/对象两形态。字符串（普通业务错误）包成 `{ statusCode, message }`；对象形态是协议载体（续传的 expectedChunkIndex、错误码 error 字段），必须 `{ statusCode, ...obj }` 整体展开——前端按字段分支，压平即断约。非 HttpException 统一 500 固定话术，堆栈只进 winston 日志。
- **Q: 限流怎么设计的？** 两层：全局 ThrottlerGuard 100 次/60 秒兜底；`@Throttle` 端点级覆盖——凭据验证类从严（登录 20/5min、验证码 10/h）、枚举探测类收紧（id/token 查重 10/分）、高频合法流量放宽（文件下载 1200/分，Range 播放打点）。分档依据是信息暴露量 × 尝试成本。
- **Q: 用户上传的文件直接 inline 预览有什么风险？** 恶意 HTML/SVG 同域执行脚本偷 cookie（存储型 XSS）。三防线：nosniff 防嗅探改判；被动媒体白名单（视频/音频/图片非 SVG/纯文本）才允许 inline；其余强制 `CSP: sandbox` 禁脚本禁同源。
- **Q: cookie 认证对 CORS/管道有什么特殊要求？** CORS 必须 `credentials: true` 且 origin 是显式白名单（`origin: true` 反射模式与 credentials 不能共存于生产）；cookie 解析靠 cookie-parser 中间件；ValidationPipe whitelist 防 body 塞isAdmin 之类的 mass-assignment。
- **Q: 为什么 env-loader 要是第一个 import？** 它加载 .env 文件 + zod 校验 + 派生 DATABASE_URL，而 AppModule 定义过程中 winston 配置工厂就要读 LOG_LEVEL——import 顺序保证"任何配置消费方执行前环境已就绪"，启动即 fail-fast。
