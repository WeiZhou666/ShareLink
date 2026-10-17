# 数据库方案（Prisma 7 · MySQL · 关系与级联全景）

> 面试学习文档 · 与代码全量同步（2026-10-12）
> 姊妹篇：[env-scheme.md](./env-scheme.md)（DATABASE_URL 派生）、[users-scheme.md](./users-scheme.md)（软删除流程）、[antivirus-scheme.md](./antivirus-scheme.md)（ScanStatus 状态机）

---

## 前置知识：ORM、驱动适配器与迁移策略

> 面试先讲"ORM 解决什么问题"与"迁移策略的取舍"，再进本项目实现（正文 §2/§6）。

### 1. ORM 在架构里的位置

- **没有 ORM**：手写 SQL 字符串 → 字段拼错运行期才炸、结果集手动映射、注入风险靠自觉
- **有 ORM**：schema 单一事实源 → 生成类型安全的 client（编译期拦截拼错字段）、关系自动装载、迁移脚本可版本化
- **Prisma 的形态**：schema.prisma 声明模型 → `prisma generate` 产出 client → 业务代码 `prisma.user.findMany()` 全程类型推导。它不是传统"Active Record"（模型类继承基类），而是"查询构建器 + 纯数据对象"

### 2. Prisma 7 的驱动适配器（driver adapter）

Prisma 7 起运行时连接**不再由引擎内建**，必须传驱动适配器：`new PrismaClient({ adapter: new PrismaMariaDb(url) })`——底层换成成熟驱动（mariadb）承担连接管理，Prisma 专注查询翻译。CLI 侧同理：schema 不再写 `url`，连接串在 `prisma.config.ts` 里给 migrate/introspect 用。**两处配置、同一来源**（本项目都指向 env-loader 派生的 DATABASE_URL，§3）。

### 3. 迁移策略：migrate vs db push

| 方式 | 机制 | 适用 |
|---|---|---|
| `prisma migrate dev` | 生成 SQL 迁移文件进版本库，可审计可回放 | 团队协作 / 生产演进 |
| `prisma db push` | 直接把 schema 差异推进库，无迁移文件 | 原型期 / 个人项目 / schema 频繁试验 |

本项目开发期用 **db push**（无 migration 目录）：schema 高频演进，迁移文件的审计价值低于摩擦成本；`db:migrate`/`db:deploy` 脚本保留，生产化时切换即可。

### 4. 术语速查

| 术语 | 一句话解释 |
|---|---|
| 级联 onDelete | 被引用行删除时引用行的处置：Cascade 删 / SetNull 置空 / Restrict 拒绝 |
| P2002 / P2025 | Prisma 错误码：唯一约束冲突 / 目标记录不存在 |
| BigInt | 任意精度整数；MySQL BIGINT 对应，JSON 序列化需转 string |
| 软删除 | 用 deletedAt 标记代替物理删行（可恢复/可审计） |

## 0. 一句话总纲

> **13 个 model + 1 个枚举，四条主线**：认证主线（User → RefreshToken / UserIdentity，全 Cascade）、分享主线（Share 为中心，安全/文件/收件人挂 Cascade，creator 与 reverseShare 挂 SetNull——**人走了分享还在**）、公告主线（Announcement → AnnouncementRead，人走 SetNull 留审计）、基础设施（Config 稀疏配置表）。两个特殊约定贯穿全库：**File.size 用 BigInt**（出 JSON 前 `.toString()`）、**永不过期 = 1970-01-01**（unix 0 哨兵值，全代码统一判断）。Prisma 7 接线：schema 无 url，CLI 走 prisma.config.ts、运行时走 PrismaMariaDb 适配器，同一 DATABASE_URL 两头消费。

---

## 1. 全景关系图

```
User ─┬─< RefreshToken        (Cascade)   会话令牌
      ├─< UserIdentity        (Cascade)   第三方身份绑定
      ├─< Share               (SetNull)   名下分享：人走分享留（公开链接语义）
      ├─< ReverseShare        (Cascade)   反向分享令牌
      ├─< ShareUserRecipient  (Cascade)   收到的分享关联
      ├─< AnnouncementRead    (SetNull)   公告已读：留行做审计
      └─< AdminNoticeDismissal(SetNull)   系统公告已读：同上

Share ─┬─? ShareSecurity       (Cascade)   密码/次数/收件人限制（一对一可选）
       ├─< File                (Cascade)   文件记录（含病毒扫描状态）
       ├─< ShareRecipient      (Cascade)   邮件收件人名单
       ├─< ShareUserRecipient  (Cascade)
       └─? ReverseShare        (SetNull)   反向分享来源：令牌删了解绑

Announcement ─< AnnouncementRead (Cascade)  删公告 → 已读记录级联清

Config（独立表）：key 主键稀疏存储，只存 admin 改过的值
```

读图三句话：

- **"人走了，东西留不留"是每条关系的第一决策**——会话/身份绑定随人走（Cascade，无独立价值）；分享/公告已读留（SetNull，公开链接语义 + 审计价值）；
- **"挂件随主"**：ShareSecurity/File/ShareRecipient 都是 Share 的从属物，分享删即全删（Cascade）；
- **SetNull 的前提是引用列可空**：`creatorId String?`、`reverseShareId String?`——schema 层的可空性就是权限/归属语义的一部分。

## 2. 级联策略速查表

| 关系 | onDelete | 业务理由 |
|---|---|---|
| User → RefreshToken | Cascade | 用户没了会话必须没了 |
| User → UserIdentity | Cascade | 身份绑定随账号消亡 |
| User → Share（creator） | **SetNull** | 分享变匿名保留（公开链接不失效，与旧后端对齐） |
| User → ReverseShare | Cascade | 令牌是用户私产，随人删 |
| User → ShareUserRecipient | Cascade | "收到"关系无独立价值 |
| User → AnnouncementRead / AdminNoticeDismissal | **SetNull** | 已读记录留存：换人登录不再重弹 + username 快照可追溯 |
| Announcement → AnnouncementRead | Cascade | 删公告清已读 |
| Share → File / ShareSecurity / ShareRecipient / ShareUserRecipient | Cascade | 挂件随主 |
| ReverseShare → Share（reverseShareId） | **SetNull** | 删令牌解绑产物，分享与文件保留（[reverse-share-scheme.md](./reverse-share-scheme.md) §6.2） |

## 3. 接线：从 schema 到连接

```ts
// prisma/schema.prisma —— Prisma 7：datasource 不再写 url
datasource db { provider = "mysql" }
```

```ts
// prisma.config.ts —— CLI（migrate/db push/introspect）的连接来源
import './config/env-loader';                       // 复用应用的 env 加载
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL },    // env-loader 由 DB_* 五键派生
});
```

```ts
// src/prisma/prisma.service.ts —— 运行时的连接来源（@Global）
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger) {
    super({ adapter: new PrismaMariaDb(process.env.DATABASE_URL!) });  // 驱动适配器
  }
  async onModuleInit()    { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }   // enableShutdownHooks 触发
}
```

- **DATABASE_URL 不手写在 env 里**：由 [env-scheme.md](./env-scheme.md) 的 `buildDatabaseUrl()` 从 `DB_HOST/PORT/USER/PASS/NAME` 五键派生（特殊字符 URL 编码）——一份凭证两个消费方（CLI + 运行时）；
- **@Global 的 PrismaModule**：业务模块无需 import 即可注入 PrismaService；
- **连接生命周期挂 Nest 钩子**：`onModuleInit` 连接、`onModuleDestroy` 断连（main.ts `enableShutdownHooks()` 保证优雅停机）。

## 4. 两个贯穿全库的约定

### 4.1 BigInt 纪律（File.size）

```prisma
model File {
  size BigInt    // 承载 >2^31 字节（约 2GB+）的文件；Int 上限 21 亿不够
}
```

**JS 的 number 超过 2^53 丢精度、JSON.stringify 遇 BigInt 直接抛 TypeError**——所以每个把 size 送出 JSON 边界的出口都要 `.toString()`（admin 列表、分享列表、反向分享列表都是 `reduce((sum, f) => sum + f.size, 0n).toString()`）。项目**刻意不打全局 `BigInt.prototype.toJSON` 补丁**：全局原型改写影响面不可控，边界处显式转换可审计。

### 4.2 永不过期哨兵值（1970 unix 0）

```prisma
expiration DateTime   // 特殊值 1970-01-01 表示"永不过期"
```

`NEVER_EXPIRES = new Date(0)`（share.constants）——不用可空列 `expiration?` 而用哨兵值，是与旧后端 API 对齐的历史决策：所有"是否过期"判断统一 `new Date() > expiration`，永不过期的分享自然永真。代码里所有 `getTime() === NEVER_EXPIRES.getTime()` 的分支都在处理它。

## 5. 唯一约束即业务规则

| 约束 | 拦下的业务事故 |
|---|---|
| `User.username / email @unique` | **占名防冒充**：软删除期间行还在 + 唯一索引还在 → 同名注册被 P2002 自然拦截，防他人注册同邮箱收到原用户邮件（[users-scheme.md](./users-scheme.md)） |
| `RefreshToken.token @unique` | 会话令牌防撞 |
| `UserIdentity.@@unique([provider, providerId])` | 一个外部身份只绑一个本地账号（防账号接管） |
| `ReverseShare.token @unique` | 令牌凭证唯一；自定义撞名 P2002 → 400 tokenInUse |
| `ShareSecurity.shareId @unique` | 一对一可选关系的落库形态 |
| `ShareUserRecipient.@@unique([userId, shareId])` | 一个用户对一条分享只挂一次 |
| `AnnouncementRead.@@unique([announcementId, readByUserId])` | 每人每公告一条已读 = dismiss 幂等的根基 |
| `AdminNoticeDismissal.noticeId @unique` | 系统级公告一条只存一条已读 |
| `Config.key @id` | 点号前缀键名（general.appName）天然分类 |

## 6. schema 演进工作流与坑

### 6.1 日常流程

```bash
# 1. 改 prisma/schema.prisma
npm run db:push          # prisma db push：schema 差异直接进库
npm run db:generate      # prisma generate：重新生成 client 类型
# 2. 重启 dev 进程（见 6.2 的坑）
```

### 6.2 高频坑：db push 删列后必须 generate + 重启进程

**症状**：db push 删掉某列后，运行中的 `nest --watch` 进程里相关查询 500 报「The column ... does not exist in the current database」。

**根因**：`prisma generate` 产出的是 node_modules 里的 **Prisma Client 构建产物**（模型类型与查询集在生成时固化）。db push 只改了数据库，**运行中进程的 Prisma Client 仍是旧模型**——旧模型还带着已删除的列，select 时照样把旧列名写进 SQL。

**修法**：db push（尤其删列/改列）后必须 `npm run db:generate` + 重启 dev 进程。加列同理（新字段在旧 client 里查不出来）。

### 6.3 软删除的 schema 落点

```prisma
model User {
  deletedAt DateTime?   // 非空 = 已注销，等待半年冷静期（182 天，jobs 任务 7 物理清除）
  // username/email 原值保留不动 + unique 索引还在 = 冷静期内同名注册被 P2002 拦截（占名防冒充）
}
```

注销/恢复/物理清理的**流程层**在 [users-scheme.md](./users-scheme.md)，本篇只锁定 schema 事实：软删除 = `deletedAt` 单字段 + 唯一键原值保留（占名方案），无独立 pendingRestore 结构。

## 7. 索引清单

| 表 | 索引 | 查询场景 |
|---|---|---|
| RefreshToken | `@@index([userId])` | 家族吊销/清理按 userId 批量删 |
| UserIdentity | `@@index([userId])` | 按 user 查身份绑定 |
| Share | `@@index([creatorId])` / `@@index([expiration])` | 我的分享列表 / jobs 过期扫描 |
| ReverseShare | `@@index([creatorId])` | 我的令牌列表 |
| ShareUserRecipient | `@@index([userId])` | 收到的分享 |
| File | `@@index([shareId])` | 分享详情装载文件 |

原则：**为已知的批量查询路径建索引**（外键列 + 扫描列），唯一约束自带索引不重复建。

## 8. 面试速答（30 秒版）

- **Q: 级联策略怎么定的？** 按数据的独立价值分：会话/身份绑定/挂件（File、Security、收件人）随主 Cascade；有独立语义的留 SetNull——分享（公开链接不失效）、公告已读（审计 + 防重弹）、反向分享产物（删令牌不删资料）。SetNull 的前提是引用列可空。
- **Q: 为什么 File.size 用 BigInt？出口怎么处理？** MySQL Int 上限 21 亿字节（约 2GB）不够；JS number 超 2^53 丢精度、JSON.stringify 遇 BigInt 抛 TypeError——所有出 JSON 边界的出口 `.toString()`，不打全局原型补丁（影响面不可控）。
- **Q: Prisma 7 的连接和 6 有什么不同？** 运行时必须传驱动适配器（`new PrismaClient({ adapter: new PrismaMariaDb(url) })`），CLI 连接串从 schema 移到 prisma.config.ts；本项目两处同源——env-loader 从 DB_* 五键派生 DATABASE_URL。
- **Q: 为什么用 db push 不用 migrate？** 开发期 schema 高频演进，迁移文件的审计价值低于摩擦成本；生产化时 `db:migrate`/`db:deploy` 脚本已就位可切换。**坑**：push 改列后必须 `prisma generate` + 重启 dev 进程——运行中进程的 Prisma Client 是旧产物，会带着已删列名发 SQL 500。
- **Q: "永不过期"怎么建模？** 哨兵值 1970-01-01（unix 0，NEVER_EXPIRES 常量），不用可空列——所有过期判断统一 `now > expiration` 一个不等式，与旧后端 API 对齐。
