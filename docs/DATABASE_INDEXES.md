# 数据库集合与索引

索引的唯一事实来源是 `database/indexes.json`。除 `chat_events` 按自定义安全规则只允许本人只读外，所有集合应设置为“小程序端不可直接读写”，业务访问统一通过云函数完成。

## 使用方式

先执行只读预览：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/init-database-indexes.ps1
```

确认环境 ID 为自己的云环境 ID 后，再明确执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/init-database-indexes.ps1 -EnvId your-env-id -Apply
```

脚本只创建或校验清单里的索引，不删除集合和数据。唯一索引创建前，应先在控制台检查是否已有重复的 OPENID、搭子关系或会话记录；已有重复数据时，云端会拒绝创建对应唯一索引。

## 重点索引

- `rides.active_departure`：支持活动行程按日期、时间分页。
- `rides.school_active_departure`：支持当前学校的活动行程按日期、时间分页，是全国多校范围隔离的主要查询索引。
- `ride_members.ride_user_unique`：防止同一用户重复入团。
- `ride_members.user_school_joined`：支持按当前用户与当前学校分页读取拼车团。
- `buddy_requests.ride_group_requests`：支持行程终态按 `rideId` 清理临时群内申请记录。
- `conversations.member_updated`：支持会话列表及未读汇总。
- `messages.conversation_created`：支持聊天记录按时间分页。
- `chat_events.owner_created`：支持消息页按本人 openid 实时监听。
- `chat_events.owner_conversation_created`：支持聊天页按本人和会话实时监听。
- `conversation_reads.conversation_user_unique`：每位成员每个会话只有一条阅读游标。

学校范围使用教育部学校标识码 `schoolId`；学号是当前用户选填的私有资料，业务不按学号查询，也不建立唯一索引。

CloudBase 官方建议只为实际查询创建索引；索引会增加写入成本，因此新增查询时应同步更新清单并复核慢查询，而不是无差别增加索引。
