# 公告与通知方案（Announcement + AdminNotice 双队列）

> 面试学习文档 · 与代码全量同步（2026-10-08）
> 姊妹篇：[users-scheme.md](./users-scheme.md)（账号注销）、[jobs-scheme.md](./jobs-scheme.md)（定时任务）、[config-scheme.md](./config-scheme.md)（应用配置）

---

## 前置知识：消息触达的两种形态与已读模型

> 面试先讲"推还是拉、已读怎么建模"，再进本项目实现（正文 §1/§3）。

### 1. 推 vs 拉

- **推**（WebSocket / SSE）：即时触达，但要维护长连接、多实例广播、断线重连——复杂度高
- **拉**（登录时查未读 / 轮询）：简单可靠，延迟以"下次登录 / 轮询周期"为限

运营公告不需要秒级触达 → **拉取**（登录后 fetch pending）是复杂度收益比最优解。项目里"系统通知"与"运营公告"走同一条拉取通道、合并进同一弹窗（§3）。

### 2. 广播公告的已读模型（关键设计）

- **私信通知**：一条消息一个收件人——已读 = 改那条消息自己的状态
- **广播公告**：一条消息全体用户——**不能存"谁没读"**（一万人的公告要写一万行"未读"），必须反过来**存"谁读过"**（AnnouncementRead 表，读过才有一行）；未读集合 = 全员 − 已读

这是广播已读的标准解法，规模越大越是唯一正解。本项目 AnnouncementRead 以 `(announcementId, readByUserId)` 唯一约束保证每人一行（§1）。

### 3. 触达强度分级

持久入口（管理页/个人页列表）< 顶栏红点 < **弹窗强制知悉**（阻断式，勾选确认后才放行）。重要公告用"弹窗 + 勾选 + 已读落库"保证触达，同时靠"已读不再拉取"防止重复打扰。

### 4. 术语速查

| 术语 | 一句话解释 |
|---|---|
| 广播 broadcast / 单播 unicast | 一条消息对全员 / 对单个收件人 |
| 已读回执 read receipt | "我看过"的持久化记录 |
| upsert | 存在则更新、不存在则插入——天然幂等的写法 |
| 幂等 | 同一操作重复执行结果不变——防重复已读 / 重复弹窗的关键 |

## 0. 一句话总纲

> **两套通知、一条队列**：系统级提醒（`AdminNotice`，代码内置的静态定义，如 S3 CORS 变更提示，仅管理员可见）与运营公告（`Announcement`，DB 表，管理员发布、全体用户可见）在后端各走各的模块，前端 `App.vue` 把两条 pending 队列**合并成一个强制确认弹窗**（滚动列表 + 一键全部已读）——多条公告不再逐条连环弹窗。已读状态两套表各管各的，dismiss 端点按 kind 分发。

与旧后端的差异：旧版 AdminNoticeModal 逐条弹窗（多条公告连环打断）；新版合并展示。旧版运营公告无此功能（本模块为新增）。

---

## 1. 数据模型（prisma/schema.prisma）

```prisma
model Announcement {
  id                String   @id @default(uuid())
  createdAt         DateTime @default(now())
  title             String
  message           String
  actionLink        String?   // 可选的"了解更多"外链
  createdByUsername String?   // 发布人用户名快照（管理员被删后仍可追溯是谁发的）
  reads             AnnouncementRead[]
}

model AnnouncementRead {
  id             String       @id @default(uuid())
  announcementId String
  announcement   Announcement @relation(..., onDelete: Cascade)  // 删公告 → 已读记录级联清
  readByUserId   String?
  readByUser     User?        @relation(..., onDelete: SetNull)   // 删用户 → 记录留存
  readByUsername String?                                          // 用户名快照兜底追溯
  @@unique([announcementId, readByUserId])                         // 每人每公告一条 = 幂等
}
```

设计要点：

- **稀疏已读**：`AnnouncementRead` 只存"读过的人"，未读 = 没有对应行——`GET /announcements/pending` 就是一次反连接查询，无需在用户行上维护未读计数；
- **双身份快照**：`readByUserId` 是唯一键载体（SetNull 后 unique 约束不再占用），`readByUsername` 快照保证用户注销后记录仍可追溯；
- **系统级提醒不走表**：`AdminNotice` 的"公告内容"是代码内置静态定义（`admin/admin-notice.service.ts`），已读状态同样落 DB（独立表），因为它是"随版本发布的迁移提示"，写死在代码里随代码走。

---

## 2. 端点（AnnouncementController）

| 端点 | 守卫 | 用途 |
|---|---|---|
| `POST /api/announcements/admin/announcements` | Jwt + AdminGuard | 发布（title/message 必填，actionLink 可选 URL） |
| `GET /api/announcements/admin/announcements` | Jwt + AdminGuard | 管理列表（含每条已读人数） |
| `PATCH /api/announcements/admin/announcements/:id` | Jwt + AdminGuard | 编辑（`UpdateAnnouncementDto extends Create`） |
| `DELETE /api/announcements/admin/announcements/:id` | Jwt + AdminGuard | 删除（级联清已读记录） |
| `GET /api/announcements/pending` | Jwt | 当前用户的未读公告（弹窗数据源） |
| `POST /api/announcements/:id/dismiss` | Jwt | 标记已读（幂等，重复 dismiss 不报错） |

管理端 CRUD 完整；**编辑不重置已读状态**——已读用户不会被重新弹窗，只有未读用户能看到更新后的内容（"改公告" ≠ "重新推送"）。

---

## 3. 前端合并弹窗（App.vue）

```
pendingNotices: NoticeQueueItem[]   // { id, title, message, actionLink, kind: 'system'|'announcement' }
```

- **队列合并**：`fetchPendingNotices` 两路并行拉取（管理员多拉一路 AdminNotice pending），`Promise.allSettled` 互不影响——运营公告接口挂了不影响系统提醒展示；
- **一键确认**：勾选「已全部知悉」→ `acknowledgeAll` 用 `Promise.allSettled` **逐条**调用各自 dismiss（system → adminNotice 端点，announcement → announcement 端点）；**全部成功才清空队列关弹窗**，有失败则 `fetchPendingNotices()` 重拉——成功的已落已读表不会重复弹，失败的保留在弹窗里；
- **强制确认**：弹窗无 X / 无遮罩点击关闭 / 无 ESC——必须勾选后点确认（对齐旧版 AdminNoticeModal 语义）；
- **登出清队列**：watch `[isAuthenticated, isAdmin]` 的 else 分支 `pendingNotices.value = []`——不清理的话公告弹窗会残留到登录页（真实踩过）；
- **勾选防残留**：`noticeConfirmed` 在队列重建（fetch 末尾）与确认提交（finally）两处重置，防止"弹窗内容变了勾选还在"的误确认。

---

## 4. 高频坑清单

1. **`{count} 条通知` 的 i18n 插值**：多条时头部标签用 `t('notice.modal.headerTagMultiple', { count })`——漏传插值参数会把 `{count}` 原样渲染进页面（ShareView 标题同款坑）。
2. **部分成功不算成功**：allSettled 之后必须 `results.every(fulfilled)` 才关弹窗；"一部分成功一部分失败"时要重拉未读——否则弹窗内容与 DB 已读状态脱节。
3. **dismiss 幂等性靠 unique 约束**：`@@unique([announcementId, readByUserId])` + upsert 语义，双击确认按钮/多标签页同时 dismiss 都不会产生重复行或报错。
4. **两类通知的 pending 接口形态不同**：AdminNotice pending 返回的是静态定义与已读表的差集（代码里算），Announcement pending 是纯查询（SQL 里算）——前端统一 `kind` 字段后按 kind 分发 dismiss，不能混用端点。

---

## 5. 回归矩阵（2026-10-08 全绿）

| # | 用例 | 期望 | 结果 |
|---|---|---|---|
| R1 | 管理员发布公告 → 用户登录 | 强制弹窗展示，含标题/正文/外链 | ✓ |
| R2 | 多条未读（2 条） | 单弹窗滚动列表，头部显示「2 条通知」 | ✓ |
| R3 | 勾选 + 一键确认 | 弹窗关 + AnnouncementRead 落库 + 刷新不再弹 | ✓ |
| R4 | 编辑公告（PATCH） | 列表即时更新；未读用户弹窗显示新内容；已读用户不重弹 | ✓ |
| R5 | 删除公告 | 记录消失 + 已读记录级联清 | ✓ |
| R6 | 部分失败模拟（断网一条） | 弹窗不关，重拉未读保留失败项 | 代码级验证 |
| R7 | 登出 | 弹窗不残留到登录页 | ✓ |

---

## 6. 演进留白

- **定时公告**：发布时可设"生效时间"，由 jobs 模块到点推送——等运营需求出现再做；
- **按用户组定向**：当前全体用户可见；若要按角色/用户组定向，`AnnouncementRead` 已有 userId 维度，扩展 target 字段即可；
- **系统级提醒的代码内置清单**：随版本发布增长的静态定义需要归档机制（旧版本提示自动失效），当前数量少暂不需要。
