# Telegram 推文工作台

## 设计边界

推文 Bot 使用独立 Token、worker、成员表和管理 API。它不读取旧 VMOS 文件，不调用旧 Telegram 内部提交接口，也不复制人设、草稿、媒体或发布队列。

```text
Telegram 私聊用户
  -> telegram_tweet_members (Chat ID -> VECTO user_id)
  -> Telegram initData 签名和 user.id 校验
  -> 3 分钟一次性 ticket
  -> 1 小时 VECTO 用户会话
  -> 现有 console / persona dashboard / social automation API
```

Bot 原生菜单按网页能力分为：我的人设、推文生成、发布与自动化、账号与浏览器、任务中心。具体操作在 Telegram Mini App 中运行，所以网页端已有的租户校验、额度、冷却、OAuth 身份核验、任务幂等、日志、截图、取消与重试保持为唯一实现。

## 启用

1. 在 BotFather 为独立的推文 Bot 配置 Mini App 域名。
2. 打开运营后台的 `Telegram -> 推文工作台`。
3. 填写独立 Bot Token 和当前新服务器的 HTTPS 公网地址。
4. 保持“内容设置”开启；该开关控制 Bot 菜单入口及 TG 会话对人设 profile 写接口的访问。
5. 将每个私聊 Chat ID 绑定到明确的 VECTO 用户 ID 或用户名。
6. 检测 Token 后启用轮询并保存。

视频工作台 Token 不能与推文 Bot Token 相同。成员停用、删除或换绑时，由该成员兑换的 Telegram 工作台会话会立即撤销。

## 部署边界

- 仅发布到新服务器应用容器 `tg-koll-web-console`。
- `TG_DEPLOYMENT_ROLE=collector` 时不注册推文 Bot 管理、兑换路由，也不启动 worker。
- 不向旧服务器 `tg-koll-capture-worker` 或 `tg-koll-collector-admin` 分发 Token、成员映射或数据库。

## 验证

```powershell
py -3 -m unittest webapp.tests.test_telegram_tweet_admin webapp.tests.test_telegram_admin webapp.tests.test_telegram_closed_loop webapp.tests.test_automation_plan_frontend_contract
node --check webapp/static/assets/admin.js
node --check webapp/static/assets/console.js
```

移动端 UI 校验脚本只允许显式指定 Windows 临时目录下的隔离数据库：

```powershell
$env:TG_TWEET_UI_ALLOW_DB_MUTATION = "1"
$env:APP_DB_PATH = "$env:TEMP\vecto-tg-ui\app.db"
py -3 scripts\verify-telegram-tweet-ui.py
```
