# 账号注销方案（DELETE /users/me · 软删除 + 半年冷静期）

> 面试学习文档 · 与代码全量同步（2026-10-10）
> 姊妹篇：[token-scheme.md](./token-scheme.md)（JWT 双 token 体系，会话吊销细节）、[jobs-scheme.md](./jobs-scheme.md)（任务 7 物理清除 + 任务 1 排除规则）、[announcement-scheme.md](./announcement-scheme.md)（公告）

---

## 前置知识：账号注销为什么不能"直接 DELETE"

> 面试先讲合规背景与软删除的通用矛盾，再进本项目占名方案（正文 §0/§1）。

### 1. 合规背景：删除权

GDPR"被遗忘权"、个人信息保护法的注销权——提供账号删除是硬性合规要求。但"点击即物理删除"两头都是风险：用户手滑或被盗号后数据不可逆丢失；名下分享、审计记录等关联数据的清理需要编排（先磁盘后行、先吊销会话后删人）。

### 2. 软删除 vs 硬删除

- **硬删除**：DELETE 行，数据即失
- **软删除**：打 `deletedAt` 标记、行保留，业务查询过滤；到期后物理清理

软删除的两大工程代价：① 所有查询都要记得过滤 deletedAt（漏一处就"闹鬼"）；② **行还在 = 唯一索引还被占着**（username/email 撞唯一约束）——② 正是本文档「占名方案」要解的核心矛盾：是把它当麻烦（改写暂存），还是当特性（防冒充）。

### 3. 冷静期（retention period）

行业惯例 30 天 ~ 1 年：期内用户可自助恢复，到期由定时任务物理清理。本项目取 182 天（半年，§0）。

### 4. 占名与防冒充

软删期间名字占着唯一索引，两种流派：

- **改写占位**：username 改成 `{name}_deleted_xxx`，原值暂存到别的列——恢复时要处理"名字已被抢"的冲突，复杂度高
- **原值占位（本项目）**：原值不动，同名注册被唯一约束自然拦截（P2002 → 409），恢复 = 清 deletedAt 一行 UPDATE，物理删行后名字自动释放

### 5. 术语速查

| 术语 | 一句话解释 |
|---|---|
| soft / hard delete | 标记删除 / 物理删行 |
| retention period | 冷静期——软删到物理删之间的可恢复窗口 |
| P2002 | Prisma 唯一约束冲突错误码 |
| 级联 Cascade / SetNull | 外键在主行删除时的跟随行为 |
| 冒充 | 他人注册同名账号借旧身份行骗——占名方案防的就是它 |

## 0. 一句话总纲

> **自我注销 = 软删除进半年冷静期**：事务内置软删标记 + 名下分享全部置为立即过期（访问即刻 404）→ 吊销全部会话。**username/email 原值保留不动（占名防冒充）**——行还在 + 唯一索引还在 = 冷静期内同名新用户注册被 P2002 自然拦截（防他人注册同邮箱收到原用户邮件）；冷静期内凭原凭据登录命中 403 `error: account_deleted`，前端展示一键恢复入口；到期由 jobs 任务 7 物理清除（磁盘 + 行），**名字随行删除自动释放**。**物理删除的顺序仍是安全的全部**：先清磁盘（否则 SetNull 让文件无主）→ 吊销 → 删行。

> **方案演化注记（2026-10-10）**：初版曾采用「唯一键改写释放」（原值暂存 `pendingRestore*`，原字段改写 `{原名}_deleted_{id 前 8 位}`）——同名可立即注册，但引入暂存字段、改写/还原逻辑、恢复 409 冲突分支与查询链兜底四处复杂度，且冒充防护弱（注销第二天他人即可注册同邮箱收原用户邮件）。现行**占名方案**零额外机制（占用是数据库自然行为），恢复 = 只清 `deletedAt` 一行 UPDATE，代价仅为冷静期内同名不可注册——自建场景半年撞名概率趋零，语义收益（防冒充窗口）远大于代价。

---

## 1. 端点与执行序

```
DELETE /api/users/me              @UseGuards(JwtAuthGuard) @HttpCode(204)   —— 软删除
POST  /api/auth/recoverAccount    @Throttle(10 次 / 5 分钟) @HttpCode(200)   —— 冷静期内自助恢复
```

软删除执行序（users.service.deleteCurrentUser）：

```
① prisma.user.findUnique()                        ── 无行 → 400 userNotFound；已有 deletedAt → 400 accountAlreadyDeleted（幂等保护）
② if (isAdmin) count({ isAdmin })                 ── adminCount <= 1 → 400 cannotDeleteLastAdmin
③ $transaction([
     share.updateMany({ creatorId, expiration: now }),   ── 名下分享全部立即过期（含「永不」分享）
     user.update({ deletedAt, 重置码/激活码作废 }),        ── username/email 原值保留（占名）
   ])
④ authService.revokeAllUserTokens(userId)         ── Redis 吊销键 + RefreshToken 全吊销（先置软删再吊销，堵住窗口）
⑤ authService.clearTokensFromResponse(response)   ── 204 + 双 Cookie 清除（@Res passthrough）
```

恢复执行序（auth.service.recoverAccount）：

```
① findFirst({ OR: [{email}, {username}] })        ── 原凭据直接可查（占名方案无改写）；查不到 = 账号不存在或已物理清 → 401 wrongCredentials（防枚举）
② 未注销的正常账号（密码对）→ 400 accountNotDeleted「请直接登录」
③ 冷静期已过（jobs 未跑到的一小段窗口）→ 400 accountDeleted
④ user.update({ deletedAt: null })                ── 恢复 = 一行 UPDATE，无键冲突可能（原名从未被动过）
⑤ generateToken(restored) 直接发新会话 → Set-Cookie 双 token（恢复即登录）
```

关键实现细节：

- **③ 分享置过期零查询侵入**：所有访问链路（令牌签发/文件下载/zip）本来就做过期检查，`expiration < now` 自动 404，不需要在任何查询里加 `deletedAt` 条件；
- **③ 占名 = 数据库自然行为**：不写任何「占用」代码——行还在 + unique 索引还在，signUp 撞名时既有的 P2002 → 409 userAlreadyExists 自动生效；恢复也无键冲突（原值从未动过），初版的 `pendingRestore*` 暂存字段、改写截断、409 recoverConflict 分支全部删除；
- **③ 顺带作废重置码/激活码**：注销态下不允许用历史凭证改密或激活；
- **物理删除方法抽取（physicallyDeleteUser）**：`清磁盘 → 吊销 → 删行`，用户不存在静默返回（jobs 幂等语义）；自我注销的旧硬删逻辑与 jobs 任务 7 共用这一个方法，`deleteExpiredShares` 排除软删创建者（磁盘保留到冷静期结束），到期后由任务 7 连磁盘一起清。

---

## 2. 数据去向（软删之后 / 物理删之后）

**软删除时（冷静期内）：**

| 对象 | 结果 | 原因 |
|---|---|---|
| User 行 | **保留**，deletedAt=now，**username/email 原值不动** | 冷静期可恢复；占名防冒充（同邮箱/用户名注册 409） |
| 名下分享 expiration | **全部置为 now**（含永不） | 访问链路既有过期检查自动 404 |
| 分享磁盘文件 | **保留** | 用户可恢复；jobs.deleteExpiredShares 的 OR 排除软删创建者 |
| RefreshToken 行 | **全吊销** | revokeAllUserTokens（先置软删再吊销） |
| Redis 吊销键 | **写入** | 旧 access JWT 立即失效 |

**冷静期到期（jobs 任务 7 physicallyDeleteUser）：**

| 对象 | 结果 | 原因 |
|---|---|---|
| 磁盘文件（该用户全部分享） | **物理删除** | 先清磁盘：SetNull 之后没人负责这些文件 |
| Redis 吊销键 | **再写一次** | 先吊销再删行，堵住"行已删但吊销键没写"窗口 |
| User 行 | **删除** | —（名字随行删除自动释放，同名可注册） |
| Share 行（分享壳） | **保留**，creatorId = null（SetNull） | 下轮任务 1 回收（OR 条件里 `creatorId: null` 命中）——磁盘已清，rm force 幂等无害 |
| AnnouncementRead 行 | 留存（userId SetNull + username 快照） | 已读记录可追溯 |

> **管理端删除（`adminService.deleteUser`）已对齐软删语义**（2026-10-09）：直接复用 `usersService.deleteCurrentUser`（AdminModule imports UsersModule），404 / 幂等保护（重复删 → 400 accountAlreadyDeleted）/ 最后管理员保护 / 软删事务 / 会话吊销全部同源；管理端额外保留「不能删自己」400 cannotDeleteSelf（operatorId 取自 JWT 不可伪造，删自己引导走 DELETE /users/me 正规入口）。

---

## 3. 前端配合（登录页恢复入口 + AccountView「危险区」）

**登录页（SignIn.vue）：**

- signIn 的 403 响应体带 `error: "account_deleted"`（对象形态 ForbiddenException 被 AllExceptionFilter 整体展开——与 `share_password_required` / `unexpected_chunk_index` 同款错误码惯例），前端**凭错误码而非状态码分支**（signIn 链路还有其他 403 可能，文案会变、码不会）；
- 命中后收起常规错误 toast，展示 el-alert 恢复条：`signin.recover.*` 三键（标题/说明/按钮）；
- 「恢复账号」复用登录表单里的同一份凭据调 `POST /auth/recoverAccount`，成功 → refreshUser + toast + 跳转 redirectPath；失败走常规 axiosError toast（凭据错/冷静期已过），恢复条保持展示。

**账号页（AccountView.vue）：**

- 红色描边卡片 + 「注销账号」按钮 → 强确认弹窗：错误警示（el-alert）+ **必须手动输入自己的用户名**，`canDelete = computed(() => input.trim() === currentUsername)` 点亮按钮；
- 文案为软删语义：**注销 ≠ 永久删除**——「分享即刻停止访问；半年冷静期内可恢复；冷静期结束后账号与文件永久删除」；
- 成功后：`auth.setUser(null)` + toast + 跳转登录页。

---

## 4. 高频坑清单

1. **顺序错误 = 资源泄漏（物理删阶段仍成立）**：先删用户行再清磁盘 → 分享变匿名壳，磁盘永久泄漏。physicallyDeleteUser 的顺序：磁盘 → 吊销 → 删行。
2. **SetNull 不是 Cascade**：物理删用户后 Share 行保留（creatorId=null），断言"分享行已删"会假失败——壳由任务 1 下轮回收（`OR: [{creatorId: null}, ...]`），磁盘已在 physicallyDeleteUser 清掉，rm force 幂等无害（E2E 实测踩过断言写错）。
3. **403 的来源不止一个**：前端不能用状态码判"已注销"——后端用对象形态异常带 `error: 'account_deleted'` 错误码，前端按码分支。字符串形态的 `ForbiddenException(message)` 展开后只有 `{statusCode, message, error: "Forbidden"}`，无法区分。
4. **恢复时机竞态（jobs 间隙窗口）**：任务 7 凌晨低频跑，`deletedAt` 过期到实际清除之间有最长一天窗口——recoverAccount 里独立的冷静期检查兜住（超期 → 400「不可恢复」）。
5. **测试造数的"幽灵用户"**：`npx tsx -e` 里 `user.create` 偶发"同脚本 findUnique 可见、跨进程查无此行"的未落库现象——重要造数用 `upsert` 并开第二个进程验证存在。
6. **schema 改列后必须 `prisma generate` + 重启 dev**：`db push` 删列后运行中的 nest --watch 进程里 Prisma Client（node_modules 生成产物）仍是旧模型，查询引用已删列会 500（`The column ... does not exist in the current database`）——generate + 重启进程才干净（E2E 实测踩到）。
7. **JWT 只认 cookie 不认 Authorization 头**：JwtStrategy 的 `fromExtractors` 只配了 `access_token` cookie——curl/PowerShell E2E 必须用 WebSession 走 Set-Cookie，`-Headers @{Authorization="Bearer ..."}` 恒 401（E2E 实测踩到）。

---

## 5. 回归矩阵（2026-10-10 占名方案 curl/tsx 全链路全绿）

| # | 用例 | 期望 | 结果 |
|---|---|---|---|
| R1 | 注册测试用户（邮箱验证开 → DB 直激活） | 201 | ✓ |
| R2 | 登录（cookie WebSession）→ `DELETE /users/me` | 200 → 204 | ✓ |
| R3 | DB 复核 | deletedAt 落库、**username/email 原值未改写**、重置码/激活码已清 | ✓ |
| R4 | 软删期间同邮箱 / 同用户名注册 | **409 userAlreadyExists**（占名生效，预期反转：改写方案时代是 201） | ✓ |
| R5 | 原凭据 signIn | 403 + `error: account_deleted`（原凭据直接可查，无需兜底） | ✓ |
| R6 | `POST /auth/recoverAccount` | 200（恢复 = 只清 deletedAt） | ✓ |
| R7 | 恢复后 signIn | 200（会话有效） | ✓ |
| R8 | deletedAt 回拨 183 天（行保留）→ recoverAccount | 400 accountDeleted（超期不可恢复，兜住任务 7 间隙窗口） | ✓ |
| R9 | 物理删行（等效任务 7 DB 结果）→ 同名注册 | **201**（名字随行删除释放） | ✓ |
| R10 | 物理删后 recoverAccount | 401（查无此人） | ✓ |
| R11 | 管理端删除（2026-10-09 验证，占名方案下同构） | 204 → 软删字段落库 + 会话吊销 | ✓ |

> 2026-10-09 改写方案时代的 R2/R9/R10（`_deleted_` 后缀、同名 201、恢复 409 recoverConflict）已随方案演化作废；R14 最后管理员保护规则原样保留。

---

## 6. 演进留白

- **注销邮件确认**：开启 SMTP 后可加"邮件确认后才执行"，防会话被盗后恶意注销——等需求；
- **恢复邮件确认**：恢复改走邮件链接（现凭密码即可，密码错本来就进不来）——现方案防枚举已够，等需求；
- **冷静期配置化**：`ACCOUNT_RETENTION_MS` 现为常量（auth.constants.ts，登录拦截与 jobs 共用，避免循环依赖），2026-10-09 由 7 天调整为半年（**182 天**，365/2 向下取整，不引入日历月复杂性）——部署需要时再改配置项；
- **占名期长短权衡**：现行占名贯穿整个冷静期（半年）——若未来注册量大、撞名投诉多，可给「占名期」单独设短值（如 30 天后改写释放，冒充防护交给邮箱验证），再回退到改写方案的部分机制。
