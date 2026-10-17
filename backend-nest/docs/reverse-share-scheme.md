# 反向分享方案（ReverseShare · 免登录上传 · 匿名分享所有权）

> 面试学习文档 · 与代码全量同步（2026-10-12）
> 姊妹篇：[file-scheme.md](./file-scheme.md)（分块上传协议 + §6 守卫链速查）、[users-scheme.md](./users-scheme.md)、[jobs-scheme.md](./jobs-scheme.md)（过期令牌清理）

---

## 前置知识：什么是反向分享与匿名所有权

> 面试先讲"双向分享"的产品形态与"无主资源"的权限设计，再进本项目实现（正文 §3/§5）。

### 1. 分享的两个方向

- **正向分享**（普通分享）：我有文件 → 生成链接 → 别人来**下载**
- **反向分享**（reverse share，俗称"帮我上传"/collect link）：我需要一个文件 → 生成上传链接发给别人 → 对方**免登录向我上传**

反向分享解决的是"对方没有账号也不该有账号"的场景：向客户收资料、向协作者收素材。实现载体是**一次性上传令牌**——令牌本身就是凭证，谁持令牌谁能传。

### 2. 令牌型链接的通用要素

| 要素 | 语义 | 过期方式 |
|---|---|---|
| 有效期 | 链接本身活多久 | 到期即失效 |
| 次数 | 允许产生几次上传 | 用一次少一次，扣完失效 |
| 额度约束 | 单次上传大小上限 | 覆盖全局配额 |
| 撤销 | 创建者主动作废 | 删令牌，未完成上传一并作废 |

### 3. 匿名资源的所有权难题

反向分享的上传者**没有账号**，产出的分享 `creatorId = null`（匿名分享）。无主资源带来一个权限设计的两难：

- **管得太松**：任何人可改可删 → 恶意清空别人收集的资料
- **管得太死**：上传者自己也无法续传/完成上传（他没登录态）

业界的折中：**"上传会话"内的操作对持令牌者开放（完成/续传），"销毁级"操作收严（删除受二次拦截）**。本项目就是这个方案（§5）。

### 4. 术语速查

| 术语 | 一句话解释 |
|---|---|
| reverse share | 反向分享：令牌持有者向令牌创建者免登录上传 |
| 原子递减 decrement | DB 层 `remainingUses: { decrement: 1 }`——并发扣减不会少扣/多扣 |
| 匿名分享 | `creatorId = null` 的分享（反向上传产物或创建者被删） |
| SetNull | 关系删除策略：被引用行删除时引用方字段置空（解绑不删数据） |

## 0. 一句话总纲

> **一张令牌管两头**：创建者 `POST /api/reverseShares` 生成令牌，把 `{FRONTEND_URL}/upload/{token}` 发给别人；对方打开上传页，`CreateShareGuard` 先试 JWT、失败降级验 `reverse_share_token` cookie（存在 + 未过期 + 剩余次数 > 0）放行匿名上传。令牌的三重约束（shareExpiration / maxShareSize / remainingUses）**覆盖上传者自选值**；complete 时 `decrement` 原子扣次数。产出的分享 `creatorId = null`：管理操作（PATCH/expire/complete）任何人可做（上传者要能续传），**删除被 service 二次拦截**（403 anonymousNoDelete，防恶意清空他人收集）。

---

## 1. 数据模型（prisma/schema.prisma）

```prisma
model ReverseShare {
  id        String   @id @default(uuid())
  token     String   @unique @default(uuid())  // 对外核心凭证；可自定义
  shareExpiration      DateTime   // 令牌产生的分享的过期时间（覆盖上传者自选）
  maxShareSize         Int        // 单次分享大小上限（覆盖全局 share.maxSize）
  sendEmailNotification Boolean   // complete 时通知创建者（邮件模板本期未迁移，字段保留）
  remainingUses        Int        // 剩余可用次数（最低 1，无 -1 语义）
  simplified           Boolean @default(false)  // 简化模式：上传页隐藏高级选项
  publicAccess         Boolean @default(true)   // false 时仅令牌创建者与分享创建者能看产物
  creatorId String
  creator   User  @relation(..., onDelete: Cascade)  // 删用户 → 令牌级联清
  shares    Share[]                                    // 令牌产生的分享
}
```

```prisma
// Share 侧的关联
reverseShareId String?
reverseShare   ReverseShare? @relation(..., onDelete: SetNull)
// 令牌删除 → 产物分享保留但解绑（SetNull），数据不丢
```

设计要点：

- **令牌即凭证**：`token` 唯一索引同时是查询键与防撞约束（并发自定义撞名 → P2002 转译 400 tokenInUse）；
- **`shareExpiration` 一字段两用**：既是令牌自身的有效期，又是产出的每个分享的过期时间（强制覆盖）——一个字段承载"链接活多久 + 传出来的东西活多久"两个语义（与旧后端一致）；
- **SetNull 而非 Cascade**：删令牌 ≠ 删已产生的文件——收集到的资料是创建者的核心资产，令牌只是入口。

## 2. 端点一览（/api/reverseShares）

| 端点 | 守卫 | 限流 | 用途 |
|---|---|---|---|
| `GET /isReverseShareTokenAvailable/:token` | Jwt | 10/分 | 自定义 token 查重（前端实时校验） |
| `POST /` | Jwt | 全局 | 创建令牌 → `{ token, link }`（link 后端拼） |
| `GET /:token` | 公开 | 20/分 | 令牌信息（上传页展示"给谁传/上限/剩余次数"） |
| `GET /` | Jwt | 全局 | 我的反向分享列表（含各令牌已产生的分享） |
| `DELETE /:id` | Jwt | 全局 | 删令牌（创建者本人或管理员） |

路由声明顺序：`isReverseShareTokenAvailable/:token` 必须声明在 `:token` 之前，否则被动态段吞掉。

**查重接口为什么收紧限流**：token 可用性是公开可探测的（逐字符试探可枚举已占用 token），10 次/分拖慢枚举。同理 `GET /:token` 对无效/过期/次数用尽的令牌**统一 404**，不暴露"存在但已失效"。

## 3. 创建令牌与链接拼装（非原子坑）

```ts
@Post()
@UseGuards(JwtAuthGuard)
async create(@Body() dto: CreateReverseShareDTO, @CurrentUser() user: User) {
  // env 读取同步且不会抛错，杜绝"令牌行已落库、链接拼装才失败"的非原子残留
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
  const token = await this.reverseShareService.create(dto, user.id);
  return { token, link: `${frontendUrl}/upload/${token}` };
}
```

- **基址取 `FRONTEND_URL` env 而非 AppConfig**：链接本质是前端页面地址，走部署环境变量（与邮件重置链接/分享邮件同先例）；去尾斜杠防拼出 `//upload`；
- **历史坑**：曾误用清单外的 `general.appConfig.get("general.appUrl")` → 404 且**令牌行已先落库**（写库成功、后续步骤失败的非原子残留）——修法是把"可能抛错的取值"换成"同步读 env 永不抛"，从根上消除该类残留；
- **非管理员受 `share.maxExpiration` 约束**（与分享过期校验同构）；`"never"` 解析为 `NEVER_EXPIRES`（1970 unix 0，全代码统一约定）。

## 4. CreateShareGuard：双通道降级认证

```ts
@Injectable()
export class CreateShareGuard extends JwtAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ① 先试 JWT：成功即放行（req.currentUser 同时被填充）
    try {
      if (await super.canActivate(context)) return true;
    } catch { /* 未登录：继续尝试反向令牌 */ }

    // ② 反向分享 cookie（前端上传页写入，非 httpOnly）
    const reverseShareToken = request.cookies?.["reverse_share_token"];
    if (!reverseShareToken) throw new UnauthorizedException(this.i18n.t("auth.unauthorized"));

    // ③ 校验有效性：存在 + 未过期 + 剩余次数 > 0
    const reverseShare = await this.prisma.reverseShare.findUnique({ where: { token: reverseShareToken } });
    const isExpired = reverseShare && new Date() > reverseShare.shareExpiration;
    const usesExhausted = reverseShare && reverseShare.remainingUses <= 0;
    if (!reverseShare || isExpired || usesExhausted) {
      throw new UnauthorizedException(this.i18n.t("reverseShare.notFound"));
    }
    return true;
  }
}
```

要点：

- **继承而非并列**：JWT 成功就是普通登录用户建分享；JWT 失败**不立即拒绝**（try/catch 吞掉），降级查反向令牌——一条守卫同时服务两类调用方；
- **显式 401 而非裸 false**：守卫 `return false` 会被 Nest 转成 ForbiddenException（403），话术反而不清晰——无效令牌显式抛 UnauthorizedException；
- **service 层不再重复验令牌有效性**：守卫已验过，`shareService.create` 只取实体用于过期覆盖与归属（connect reverseShare）。

## 5. 匿名分享的所有权规则（核心安全设计）

反向分享产出的分享 `creatorId = null`，围绕它的守卫规则分三级：

| 操作 | 守卫 | 规则 |
|---|---|---|
| 续传文件 / complete / revertComplete | `StrictShareOwnerGuard`（allowAdmin=false） | 创建者本人 **或 匿名分享任何人**——上传者无账号，必须放行才能完成上传会话 |
| PATCH / expire / 管理类操作 | `ShareOwnerGuard`（allowAdmin=true） | 同上 + 管理员可管 |
| **DELETE 分享** | `ShareService.remove` 二次拦截 | `!creatorId && !isAdmin` → **403 anonymousNoDelete** |

```ts
// share.service.ts — 匿名分享删除受 service 二次拦截
async remove(shareId: string, isDeleterAdmin = false) {
  const share = await this.prisma.share.findUnique({ where: { id: shareId } });
  if (!share) throw new NotFoundException(this.i18n.t("share.notFound"));
  if (!share.creatorId && !isDeleterAdmin) {
    throw new ForbiddenException(this.i18n.t("share.anonymousNoDelete"));
  }
  await this.fileService.deleteAllFiles(shareId);
  await this.prisma.share.delete({ where: { id: shareId } });
}
```

为什么删除要单独收严：守卫层"匿名分享任何人可管理"是为了让**持令牌的上传者**能完成上传会话，但同一规则也意味着**任何匿名访客都能删**——收集来的资料一旦被恶意清空无法追责。所以销毁级操作在 service 层再拦一道：无主分享只有管理员能删。**守卫管"进门"，service 管"销毁"**——两层各管各的威胁。

（另一个匿名来源：普通分享的创建者被物理删除时 SetNull 也产生匿名分享，规则同样适用。）

## 6. 令牌生命周期：扣次数与删除令牌

### 6.1 complete 时原子扣减

```ts
// share.service.ts complete()
if (share.reverseShare) {
  await this.prisma.reverseShare.update({
    where: { id: share.reverseShare.id },
    data: { remainingUses: { decrement: 1 } },
  });
}
```

`decrement` 是 DB 层原子操作（`UPDATE ... SET x = x - 1`），并发 complete 不会少扣/多扣——比"读出来减一再写回"（check-then-act 竞态）正确。扣到 0 后 `CreateShareGuard` 的 `remainingUses <= 0` 检查把后续上传挡在门外。

### 6.2 删除令牌：事务三步

```ts
await this.prisma.$transaction([
  // ① 未完成的分享：先解绑再置立即过期（防"令牌没了还能续传"的悬空状态）
  this.prisma.share.updateMany({ where: { reverseShareId: id, uploadLocked: false },
    data: { reverseShareId: null, expiration: new Date() } }),
  // ② 全部分享解绑（SetNull 语义手动执行，令牌行随后删除）
  this.prisma.share.updateMany({ where: { reverseShareId: id }, data: { reverseShareId: null } }),
  // ③ 删令牌
  this.prisma.reverseShare.delete({ where: { id } }),
]);
```

语义：**未完成的上传立即作废（门禁关闭），已完成的分享保留（资料不丢）但解绑**；磁盘数据一律不动。删除令牌的归属校验（创建者本人或管理员）在 service 层，非本人 404 同话术（不暴露存在性）。

## 7. 高频坑清单

1. **路由顺序**：`isReverseShareTokenAvailable/:token` 声明在 `:token` 之前，否则被动态段吞掉（Nest 按声明顺序匹配）。
2. **DTO 层拦垃圾输入**：`shareExpiration` 用 `@Matches` 只放行 `never` 与相对时间形态——service 的 `parseRelativeDateToAbsolute` 是纯工具函数，遇非法形态抛**未翻译的裸字符串**，必须从 DTO 源头挡住。
3. **前端以 string 发数字**：`maxShareSize`（字节）可能超出 JS 安全整数精度的展示习惯，DTO 用 `@Type(() => Number)` 转数字后再 `@IsInt @Min(1)` 校验（对齐旧 API 契约）。
4. **自定义 token 的并发撞名**：先查重的 check-then-act 之间仍有窗口，唯一索引 P2002 在 catch 里转译成 400 tokenInUse——查重是体验优化，唯一约束才是正确性保证。
5. **匿名分享 ≠ 无主垃圾**：`StrictShareOwnerGuard` 放行匿名上传会话的同时打开了删除面——service.remove 的二次拦截不是冗余，是补守卫层的洞。
6. **`getByToken` 对外字段收敛**：只回 token/上限/剩余次数/创建者用户名——不回 creatorId、email 等内部字段（公开端点最小暴露面）。

## 8. 回归矩阵

| # | 用例 | 期望 | 结果 |
|---|---|---|---|
| R1 | 创建令牌 → 拼链接 | `{ token, link: {FRONTEND_URL}/upload/{token} }` | ✓ |
| R2 | 匿名访客持令牌建分享 + 上传 + complete | CreateShareGuard 放行，产物 creatorId=null | ✓ |
| R3 | complete 后令牌 remainingUses -1 | decrement 原子扣减，0 次后令牌 401/404 | ✓ |
| R4 | 令牌产物匿名分享：非管理员 DELETE | 403 anonymousNoDelete（service 二次拦截） | ✓ |
| R5 | 删除令牌 | 事务：未完成分享立即过期、全部解绑、令牌删除；已产生文件保留 | ✓ |
| R6 | 过期/次数用尽令牌打开上传页 | 统一 404（不暴露存在性） | ✓ |

## 9. 演进留白

- **complete 通知邮件**：`sendEmailNotification` 字段已落库，邮件模板本期未迁移（`notifyReverseShareCreator` 恒 undefined）——EmailService 补模板即可点亮；
- **publicAccess=false 的访问强制**：字段语义为"仅令牌创建者与分享创建者能看产物"，当前后端公开读取路径未强制（`ShareSecurityGuard` 不感知令牌归属），约束暂由前端隐藏入口承载——后端强制需在守卫链加"当前用户是令牌创建者或分享创建者"判断；
- **presigned 直传**：反向分享的字节流同样走应用服务器中转，S3 直传改造与主链路共用方案（见 [file-scheme.md](./file-scheme.md) §8 留白）。

## 10. 面试速答（30 秒版）

- **Q: 反向分享和普通分享的本质区别？** 方向相反：普通分享是"有文件的人发链接给人下载"，反向分享是"要文件的人发上传令牌让对方免登录上传"。实现载体是 ReverseShare 令牌（唯一 token + 有效期 + 次数 + 大小上限），cookie `reverse_share_token` 携带，`CreateShareGuard` 双通道降级（JWT 优先，失败验令牌）。
- **Q: 次数扣减怎么做并发安全？** `remainingUses: { decrement: 1 }` 数据库原子递减（单条 UPDATE），并发 complete 不会少扣；扣到 0 由守卫的 `<= 0` 检查拦截。
- **Q: 匿名分享的权限怎么设计？** 产物 `creatorId = null`。上传会话操作（续传/complete）任何人可做（上传者没账号，必须放行）；销毁级操作（删除）service 层二次拦截：无主分享仅管理员可删（403 anonymousNoDelete），防恶意清空他人收集。守卫管进门、service 管销毁。
- **Q: 删令牌会删掉已上传的文件吗？** 不会。事务三步：未完成分享解绑+立即过期（关门禁）、全部分享解绑、删令牌——产物分享保留（SetNull 语义），磁盘数据不动；令牌只是入口，资料是资产。
