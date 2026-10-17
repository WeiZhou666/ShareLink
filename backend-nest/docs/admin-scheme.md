# 管理员后台方案（AdminGuard · 用户管理 · 分享管理 · 系统级公告）

> 面试学习文档 · 与代码全量同步（2026-10-12）
> 姊妹篇：[users-scheme.md](./users-scheme.md)（软删除/注销全流程）、[token-scheme.md](./token-scheme.md)（会话吊销底层）、[announcement-scheme.md](./announcement-scheme.md)（运营公告，与本篇 AdminNotice 是双队列的两翼）

---

## 前置知识：管理后台的权限模型与"自锁"事故

> 面试先讲"认证/授权分层"与"最后管理员保护"，再进本项目实现（正文 §1/§3）。

### 1. 认证（authentication）与授权（authorization）分层

- **认证**回答"你是谁"：验签 JWT、查黑名单、查库确认用户存在——成本高、逻辑重
- **授权**回答"你能干什么"：拿到已认证身份后查角色/权限——一行判断

正确的分层是**授权守卫复用认证链，而不是另写一套**。本项目所有管理守卫都继承 `JwtAuthGuard`（§1），`super.canActivate()` 先走完认证，子类只追加一步角色判断——认证逻辑全局只有一份，不会随守卫增多而漂移。

### 2. RBAC 最小实现

角色权限模型（Role-Based Access Control）不必一上来就建 Role/Permission 三张表。**单布尔字段 `isAdmin` + 守卫一层判断**就是最小可用实现；等出现第二种角色（如"审核员"）再升级成角色表。过早建表是过度设计，一个字段就是当前复杂度的最优解。

### 3. 管理后台的经典"自锁"事故

管理后台的删改操作如果不对**操作者自身**做保护，会出现把自己锁在门外的连锁反应：

| 事故 | 后果 | 对策 |
|---|---|---|
| 管理员把自己降权 | 失去管理入口，需改库救回 | 禁止修改自己的 `isAdmin` |
| 管理员删掉唯一的自己 | 系统再无管理员 | 禁止删自己 + 最后管理员保护 |
| 删最后一个管理员 | 同上 | 删除前 `adminCount <= 1` 则 400 |
| 禁用/改密不清会话 | 被处置者手里旧 token 仍有效 15 分钟 | 联动吊销全部会话 |

### 4. 术语速查

| 术语 | 一句话解释 |
|---|---|
| RBAC | 基于角色的访问控制：身份 → 角色 → 权限的间接映射 |
| 吊销 revoke | 让已签发的令牌提前失效（区别于等它自然过期） |
| 纵深防御 | 同一威胁布置多层拦截——如"禁用"既拦登录又吊销存量会话 |
| 审计线索 | 操作日志里"谁在什么时候对谁做了什么"的可追溯记录 |

## 0. 一句话总纲

> **一个守卫、两类管理、一套复用**：`AdminGuard` 继承 `JwtAuthGuard` 只追加 `isAdmin` 判断；用户管理（列表/改角色/重置密码/踢下线/软删除）与分享管理（分页列表/删除）是两个业务面；所有"会话相关"的危险操作（禁用/重置密码/踢下线/删除）统一复用 `AuthService.revokeAllUserTokens` 一份实现，删除用户复用 `UsersService.deleteCurrentUser`（与自我注销同语义的软删除）——**admin 模块只做编排，不复制安全代码**。

与旧后端的差异：列表加了分页+搜索（旧版全量返回）；删除/禁用联动吊销会话（旧版删了用户，已签发的 access_token 15 分钟内仍有效）；不做管理员邀请创建（统一走 signUp）。

---

## 1. 模块结构与 AdminGuard

```
src/admin/
  admin.controller.ts      /api/admin/* 全部端点，类级 @UseGuards(AdminGuard)
  admin.service.ts         用户/分享管理业务逻辑
  admin-notice.service.ts  系统级公告（静态定义 + 已读落库）
  guard/admin.guard.ts     管理员守卫
  dto/                     admin-user.dto / admin-share.dto（分页参数校验）
```

```ts
// guard/admin.guard.ts
@Injectable()
export class AdminGuard extends JwtAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ① 先执行父类完整认证链：验签 + Redis 两级黑名单 → 查库缓存 req.currentUser
    await super.canActivate(context);
    // ② 授权检查：只判断角色
    const request = context.switchToHttp().getRequest();
    if (!request.currentUser?.isAdmin) {
      throw new ForbiddenException(this.i18n.t('admin.adminRequired'));
    }
    return true;
  }
}
```

要点：

- **守卫也是 provider**：带依赖注入的类需要在模块 `providers` 里注册才能实例化；
- **`req.currentUser` 由父类保证存在**（查库成功才放行），操作者身份来自查库结果而非客户端传参——不可伪造，这是"不能删自己"等保护规则可信的前提；
- **模块接线**：`imports: [AuthModule, UsersModule]`——复用 `revokeAllUserTokens` 与 `deleteCurrentUser`；`PrismaModule`/`AppConfigModule` 是 `@Global`，无需显式 import。

## 2. 端点一览

| 端点 | 用途 | 关键规则 |
|---|---|---|
| `GET /api/admin/users` | 用户列表（分页 + keyword 模糊搜 username/email） | select 白名单排除 password |
| `PATCH /api/admin/users/:id` | 设/撤管理员、启用/禁用 | 不能改自己的 isAdmin；禁用联动吊销会话 |
| `POST /api/admin/users/:id/resetPassword` | 重置密码 | argon2id 哈希 + 吊销全部会话 |
| `POST /api/admin/users/:id/revokeSessions` | 踢下线 | 只吊销会话，不改任何用户数据 |
| `DELETE /api/admin/users/:id` | 删除用户（软删除） | 不能删自己；最后管理员保护；不能重复删 |
| `GET /api/admin/shares` | 分享列表（分页 + 搜索 + 全库磁盘占用） | BigInt 求和后 `.toString()` |
| `DELETE /api/admin/shares/:id` | 删除分享 | DB 级联清 files 行（物理文件缺口见 §6） |
| `GET /api/admin/notices/pending` | 待展示系统级公告 | 仅管理员（App.vue 弹窗数据源之一） |
| `POST /api/admin/notices/:id/dismiss` | 公告标记已读 | upsert 天然幂等 |

`:id` 挂 `ParseUUIDPipe`（用户 id 恒为 uuid，controller 层就拦掉非法格式）；**分享的 `:id` 不挂**——分享 id 将来开放自定义（shareIdLength），不锁死 uuid 格式。

## 3. 用户管理：保护规则与会话联动

### 3.1 列表：并行查询 + 两个防坑

```ts
const [users, total] = await Promise.all([
  this.prisma.user.findMany({ where, select: {/* 白名单 */}, skip, take }),
  this.prisma.user.count({ where }),
]);
```

- **findMany + count 并行**：列表页固定两次查询，并行省一半等待；
- **keyword 动态 where 的坑**：Prisma 的 `OR` 条件里混入 `undefined` 字段会生成空过滤对象 `{}`，**空 OR 在部分 Prisma 版本会匹配全表**——所以只在 keyword 真的存在时才展开 OR；
- **select 白名单**：显式列出要返回的字段（比查出实体再 delete 敏感字段安全——将来加敏感字段也不会误泄漏）。

### 3.2 更新与踢下线：都汇入同一个吊销原语

```ts
// 禁用账号时
if (dto.isActivated === false) {
  await this.authService.revokeAllUserTokens(targetUserId);
}
```

`revokeAllUserTokens` 一份实现（[token-scheme.md](./token-scheme.md) §吊销）：删 RefreshToken 表全部会话（refresh 无法续期）+ 写 Redis 用户级吊销键 `auth:revoke:{userId}`（access 立即失效，TTL 与 token 同步）。**为什么要吊销**：`isActivated` 只拦 signIn，已签发的 access_token（最长 15 分钟）不吊销就还能继续用——纵深防御。重置密码同理：改密场景通常是"账号疑似被盗"，盗号者手里的旧 token 还能用，重置就形同虚设。

### 3.3 删除用户：复用自我注销的软删除

```ts
async deleteUser(operatorId: string, targetUserId: string) {
  // 管理端删自己语义上等于自我注销，引导走 DELETE /users/me 的正规入口
  if (operatorId === targetUserId) {
    throw new BadRequestException(this.i18n.t('admin.cannotDeleteSelf'));
  }
  await this.usersService.deleteCurrentUser(targetUserId);
}
```

`deleteCurrentUser` 内部已包含（[users-scheme.md](./users-scheme.md) §注销）：目标不存在 404、重复删除 400 accountAlreadyDeleted、**最后管理员保护**（`adminCount <= 1` → 400 cannotDeleteLastAdmin）、事务内名下分享全部置过期 + `deletedAt` 软删标记、清理磁盘文件、吊销全部会话。**管理端与管理端自我注销天然共享同一套规则**——这正是"复用而非复制"的收益。

## 4. 分享管理：分页列表与 BigInt 纪律

```ts
const [shares, total, diskUsageAgg] = await Promise.all([
  this.prisma.share.findMany({ where, include: { files: { select: { size: true } }, creator: true }, skip, take }),
  this.prisma.share.count({ where }),
  this.prisma.file.aggregate({ _sum: { size: true } }),
]);
// 每条分享大小：内存求和（每页 ≤100 条，规模可控，不为它写 groupBy 聚合）
size: share.files.reduce((sum, f) => sum + f.size, 0n).toString(),
// 全库磁盘占用：一次聚合查询
diskUsage: (diskUsageAgg._sum.size ?? 0n).toString(),
```

- **BigInt 不能直接 JSON 序列化**（`TypeError: Do not know how to serialize`）——出 JSON 前必须 `.toString()`，本项目没有全局 `BigInt.prototype.toJSON` 补丁，靠各出口自觉转换（纪律见 [database-scheme.md](./database-scheme.md)）；
- **搜索维度**：分享 id / 名称 / 创建者的 username 或 email（关系字段嵌套 OR）。

## 5. 系统级公告（AdminNotice）

与运营公告（`Announcement`，DB 表、管理员发布、全体用户可见）相对，系统级公告是**代码内置的静态定义**：

```ts
const NOTICE_DEFINITIONS: AdminNoticeDto[] = [
  {
    id: 's3_cors_update',
    title: 'Action Required: Update S3 CORS Configuration',
    message: '...',
    conditionKey: 'REQUIRE_S3_ENABLED',   // 仅 S3 启用时展示
    actionLink: 'https://...',
  },
];
```

设计语义（移植自旧后端 admin-notices.json）：

- **公告内容不走 DB / 管理端 CRUD**——系统级提醒随代码版本发布，改公告 = 发版；用 TS 常量而非 JSON 文件：tsc 构建无需资产拷贝配置；
- **DB 只存"已读"**（`AdminNoticeDismissal`，`noticeId` 唯一，记录谁读的）——公告是静态的，"未读 = 定义 - 已读 - 条件不满足"在代码里算差集；
- **条件过滤**：`REQUIRE_S3_ENABLED` 声明"什么配置状态下才需要展示"；读不到配置按 false 处理（公告不展示），不抛错；
- **dismiss 幂等**：upsert 语义，重复 dismiss 不报错，同时记录 `dismissedByUserId` + `dismissedByUsername` 快照（管理员被删后仍有审计线索）。

前端消费：App.vue 把本队列与运营公告队列合并成同一个强制确认弹窗——见 [announcement-scheme.md](./announcement-scheme.md) §3。

## 6. 高频坑清单

1. **操作者身份必须来自服务端**：`operatorId`/`operatorEmail` 从 `@CurrentUser()` 取（守卫链查库结果），绝不能从 body/query 接收——否则"不能删自己"保护形同虚设。
2. **`ParseUUIDPipe` 不是万能的**：只挂确定恒为 uuid 的参数（用户 id）；分享 id 留了自定义空间，挂上就把未来演进锁死了。
3. **空 OR 匹配全表**：keyword 动态 where 必须判空后再展开 OR，不能无条件传 `{ OR: [{ username: { contains: undefined } }] }`。
4. **管理端删除分享不清理物理文件（已知缺口）**：`removeShare` 只 `prisma.share.delete`（File 行级联清），磁盘/S3 对象残留为孤儿——上传链路迁入存储双模式后此注释已过时，物理清理待接线（`fileStorage.deleteShare(shareId)` 一行即可，见演进留白）。删除用户路径无此问题（`deleteCurrentUser` 会逐分享调 `fileService.deleteAllFiles`）。
5. **守卫要在模块里注册**：`AdminGuard` 既是 `@UseGuards` 引用又是 provider——只挂装饰器不注册 providers，依赖注入会在实例化时挂掉。

## 7. 演进留白

- **管理端删分享的物理清理接线**：`removeShare` 补一行 `await this.fileStorage.deleteShare(shareId)`（StorageModule 已 @Global，直接注入）——当前 DB 行删除在前，孤儿对象不影响正确性只占空间；
- **操作审计表**：目前靠 winston 日志（logger.warn 带 operator/target）；需要"可查询的审计"时再落 AdminAuditLog 表；
- **批量操作**：批量禁用/删除待真实运维需求出现再加（分页结构已就绪）。

## 8. 面试速答（30 秒版）

- **Q: 管理员权限怎么实现？** 单字段 `isAdmin` + `AdminGuard` 继承 `JwtAuthGuard`：super 先走完整认证链（验签/黑名单/查库），子类追加一步角色判断——认证与授权分层，认证逻辑全局一份不漂移。RBAC 最小实现，等出现第二种角色再建角色表。
- **Q: 禁用账号后为什么旧 token 还可能有效？怎么堵？** access_token 自包含、15 分钟内验签即过；堵法 = 吊销：删 refresh 会话 + 写 Redis 用户级吊销键（strategy 校验链每请求查），access 立即失效。禁用/重置密码/踢下线/删除四类操作共用 `revokeAllUserTokens` 一份实现。
- **Q: 怎么防止把系统锁死（删了唯一管理员）？** 两层：不能删自己（operatorId 来自查库结果不可伪造）；`deleteCurrentUser` 内 `adminCount <= 1` 抛 400 cannotDeleteLastAdmin——管理端与自我注销共用同一实现，规则天然对齐。
- **Q: 列表接口有什么性能/安全细节？** findMany+count `Promise.all` 并行；select 白名单防敏感字段泄漏（比查出来再删安全）；keyword 判空后再展开 OR（Prisma 空 OR 有匹配全表的坑）；BigInt 出 JSON 前 `.toString()`。
- **Q: 系统级公告和运营公告什么区别？** 系统级 = 代码内置静态定义（改公告 = 发版），DB 只存已读（noticeId 唯一 + upsert 幂等）；运营公告 = DB 表 + 管理端 CRUD + 已读表。前端合并成同一弹窗，按 kind 分发 dismiss 端点。
