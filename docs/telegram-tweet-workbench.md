# Telegram 推文工作台

## 运行边界

推文 Bot 使用独立 Token、成员表、FSM 状态、callback token、审计表、worker 和跨进程租约。它不调用视频工作台内部接口，不读取旧 VMOS 数据，也不复制网页端的发布、计费或任务执行器。

```text
Telegram 私聊用户
  -> telegram_tweet_members (Chat ID -> VECTO user_id)
  -> Telegram 原生菜单 / 持久化 FSM / 短 callback token
  -> 带 web_user_id 的 TweetWorkbenchOps
  -> 既有人设、计费、热点、媒体和 social task 服务
```

Bot 不创建 VECTO Web session，因此不会绕过网页端密码、MFA、新设备验证或单会话策略。OAuth、账号凭证、代理和浏览器人工接管只提供普通 HTTPS 网页链接，用户仍须按网页端原有流程登录。

## 核心闭环

- 人设：分页查看、选择和新建。
- 生成：输入主题后进入既有异步生成队列，并在完成时回传草稿。
- 草稿与收藏：分页、详情、编辑、收藏和二次确认删除。
- 媒体：从 Telegram 上传图片、视频或文件，支持追加、替换和移除。
- 热点：进入既有热点任务，完成后选择候选保存为草稿。
- 发布：立即发布、北京时间定时发布和矩阵发布，全部二次确认后进入既有队列。
- 任务：按 VECTO 用户隔离查看、取消和重试。
- 内容设置：管理员开关启用后，可在 Bot 内编辑人设简介和推文风格。

## 启用

1. 在运营后台 `Telegram -> 推文工作台` 配置独立 Bot Token。
2. 确保该 Token 与已启用的视频工作台 Token 不同。
3. 让目标 Telegram 用户先向推文 Bot 发送 `/start`，取得 Chat ID。
4. 管理员将经 Bot API 验证的 Chat ID 绑定到明确的 VECTO 用户。
5. 保持“内容设置”开启并启用推文 Bot 轮询。

## 部署与隔离

- 只在 application/new-console 角色注册路由和启动 worker；collector/old-worker 不启动。
- 同一个推文 Token 通过 SQLite 租约保证最多一个活跃 long-poll 实例；滚动发布时待命实例不会调用 `getUpdates`。
- 启动前再次检查视频和推文 Token。发生冲突只拒绝推文 Bot，不停止、不重启视频 Bot。
- runtime 配置采用字段级更新，读取、合并和写入位于同一把锁内。
- callback token 与 Chat ID 绑定且 15 分钟过期；FSM 状态和关键动作审计持久化到新服务器数据库。

## 验收

- 使用两个 Telegram 私聊账号分别绑定两个 VECTO 用户，确认彼此看不到人设、草稿、账号和任务。
- 完成“选择人设 -> 生成 -> 编辑/媒体 -> 发布确认 -> 任务状态/结果”的真实 Telegram 流程。
- 验证内容设置关闭后，Bot 的简介和风格更新被服务端拒绝。
- 启动两个 application 实例，确认只有租约持有者轮询且没有 Telegram 409。
- 同时运行视频 Bot，确认两个 Token、线程、菜单、成员和业务队列完全独立。
