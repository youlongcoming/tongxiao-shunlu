# 架构说明

这份文档描述代码的运行时结构、身份边界、数据模型和关键状态机。部署步骤见 [CLOUD_SETUP.md](CLOUD_SETUP.md)，合规注意事项见 [COMPLIANCE.md](COMPLIANCE.md)。

## 1. 运行时分层

```text
┌──────────────────────────────────────────────┐
│ 小程序页面（pages/*）                         │
│ WXML / WXSS / JS，无第三方 UI 框架            │
└──────────────────────┬───────────────────────┘
                       │ utils/cloud.js
                       ▼
┌──────────────────────────────────────────────┐
│ 微信云函数（cloudfunctions/*）                │
│ login / profile / social / chat / rides      │
│ Node.js + wx-server-sdk                      │
└──────────────────────┬───────────────────────┘
                       │ cloud.getWXContext()
                       ▼
┌──────────────────────────────────────────────┐
│ 云数据库（集合） + 私有云存储                 │
│ users / rides / ride_members / buddies / ... │
│ avatars/ + payment-codes/（私有）             │
└──────────────────────────────────────────────┘
```

页面不直接访问业务集合。`utils/cloud.js` 统一封装 `wx.cloud.callFunction()`，把云函数返回的 `{ ok:false, code, message }` 转成异常，页面只处理成功结果或错误状态。

## 2. 身份与信任边界

- 唯一可信身份是云函数中的 `cloud.getWXContext().OPENID`。
- 客户端传来的 `openid`、`userId`、`ownerOpenid` 等字段一律不作为身份依据。
- 客户端拿不到其他用户的 OPENID；需要展示用户时使用公开用户 ID、昵称、头像和搭子码。
- 手机号只允许在以下场景由云函数返回：
  - 仍有效的双人搭子会话；
  - 当前活动拼车团的成员/发布者。
- 学号只返回给本人，不进入公开资料、申请、成员列表或日志。
- 收款码文件 ID 只保存在 `users` 私有字段；临时 URL 只向结算参与者返回。

## 3. 页面与职责

| 页面 | 职责 |
| --- | --- |
| `pages/school-select` | 首次选校、按省份/城市/学校搜索与滚轮选择 |
| `pages/index` | 首页、当前学校、可选行程统计、最近行程 |
| `pages/rides` | 拼车列表、分类筛选、下拉刷新、直接加入 |
| `pages/publish` | 发布行程、座位/时间/路线校验、收款码门槛 |
| `pages/messages` | 对话列表、拼车团、搭子申请/删除 |
| `pages/chat` | 双人会话、行程群聊、加入拼车团、备注 |
| `pages/group` | 拼车团详情、成员、群聊入口、结算/取消/编辑 |
| `pages/settlement` | 最终车费、实际乘车人、AA 分摊、收款码、确认进度 |
| `pages/ride-edit` | 发车前编辑行程 |

## 4. 行程生命周期

```text
active ──出发时间到──> active（仍可查看/结算入口）
  │                         │
  │ 发布人结束              │ 当天结束，次日 00:00
  ▼                         ▼
settling（待结算）        expired（过期）
  │
  │ 所有乘车人确认 + 发布人确认收款
  ▼
settled（已结算）

active ──发布人取消──> cancelled
active ──发布人解散──> disbanded
```

关键规则：

- 出发后禁止加入、退出、编辑；列表仍保留当天进行中的行程。
- 跨日保留 24 小时补结算窗口；过期由 `rides` 定时触发器和读取时惰性清理兜底。
- `settling` 期间保留成员和群聊，结算完成后清理临时群数据。
- `seatsLeft` 是冗余字段，发布/加入/退出时在事务内维护，读取时可惰性回填。
- 同一用户最多 3 条活动行程（以云端校验为准）。

## 5. 结算流程

1. 发布人在 `pages/group` 点击“结束并结算”，进入 `settling`。
2. 发布人填写最终车费，勾选实际乘车人。
3. `rides` 在事务中生成 `settlement`：总额、参与人、每人金额、尾差分配。
4. 参与人看到自己的金额和发布人收款码；点击“已转账”后状态变为 `claimed`。
5. 发布人确认收款后，对应参与人变为 `confirmed`。
6. 所有参与人确认后，行程变为 `settled`，清理临时群。

平台不调用 `wx.requestPayment`，不代收代付，不按车费抽成；收款码只用于同行人之间自行转账。

## 6. 聊天与实时事件

- 双人会话只允许仍为搭子的双方访问。
- 行程群聊只允许当前活动行程成员访问。
- 客户端优先 `watch()` `chat_events` 的本人只读投影；失败时退回长轮询。
- `chat_events` 安全规则：

```json
{
  "read": "auth.openid == doc.ownerOpenid",
  "write": false
}
```

- 事件只保存会话 ID、消息 ID、发送者公开用户 ID、昵称、文本和时间；不包含其他用户 OPENID、手机号或完整成员列表。
- 行程结束/取消/解散/过期/成员退出时清理对应事件；清理失败只记录警告，不阻断主操作。

## 7. 数据集合

| 集合 | 关键字段 | 说明 |
| --- | --- | --- |
| `users` | `_openid`, `name`, `schoolId`, `phone`, `studentId`, `avatar`, `paymentCode` | 私有资料；学号/收款码仅本人或授权场景 |
| `rides` | `schoolId`, `ownerOpenid`, `date`, `time`, `status`, `seatsLeft`, `settlement` | 行程与结算 |
| `ride_members` | `rideId`, `openid`, `role`, `joinedAt` | 拼车团成员 |
| `buddy_requests` | `from`, `to`, `status`, `rideId` | 搭子申请 |
| `buddies` | `ownerOpenid`, `buddyOpenid`, `remark` | 双向关系 |
| `conversations` | `type`, `memberOpenids`, `rideId` | 双人/群会话 |
| `messages` | `conversationId`, `senderUserId`, `text` | 消息 |
| `chat_events` | `ownerOpenid`, `conversationId`, `messageId` | 客户端只读投影 |
| `conversation_reads` | `conversationId`, `openid`, `lastReadAt` | 已读 |
| `subscriptions` | `openid`, `remaining` | 订阅额度 |

索引清单见 [database/indexes.json](../database/indexes.json)，初始化脚本见 `scripts/init-database-indexes.ps1`。

## 8. 失败与降级

- 云端不可用：页面显示错误或空状态，不生成模拟订单/成员/聊天。
- 云函数部分失败：返回 `{ ok:false, code, message }`，页面提示并允许重试。
- 订阅消息失败：事务内预扣的额度回补，不影响加入拼车团主流程。
- 清理失败：记录云函数日志，不阻断结算/退出；由定时任务或后续读取兜底。

## 9. 已知架构限制

- 学校选择还不是强学籍认证；接入统一身份认证需要学校配合。
- 内容审核、举报/拉黑、管理员后台、账号注销尚未完成。
- `seatsLeft` 是冗余字段，历史数据可能存在漂移，需要巡检脚本。
- 没有支付、保险、承运能力；这些能力不应被文案暗示为已提供。
- 个人主体无法完成“拼车”类目备案；上线路径见 [COMPLIANCE.md](COMPLIANCE.md)。
