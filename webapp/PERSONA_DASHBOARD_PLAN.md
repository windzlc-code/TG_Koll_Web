# 人设与热点数据 Web 仪表盘计划

## 目标

在现有前台 WebApp 中增加“人设数据看板”，让用户能用总览、排行、趋势图和明细表快速看懂所有人设的设定、发布、素材和热点数据。

## 数据来源

- `TOOL_R18_RUNTIME_DIR/persona_archives.json`
- `TOOL_R18_RUNTIME_DIR/persona_archives_cache.json`
- `TOOL_R18_RUNTIME_DIR/publish_queue.db`
- `TOOL_R18_RUNTIME_DIR/sentiment_hot_candidates.json`

本页面只读取缓存，不触发热点刷新、账号登录验证或外部采集。

## 实现范围

- 后端新增免登录只读接口 `GET /api/persona_dashboard/overview`。
- 前端在人设看板控制台视图 `console.html?view=persona_dashboard` 提供登录后入口。
- 图表使用原生 HTML/CSS/SVG，不新增前端依赖。
- 敏感字段脱敏展示，不返回明文 token、secret、password、session 等值。

## 指标口径

- `recentViews`：账号主页级浏览量，单独展示为“主页浏览”。
- `views` / `viewCount`：逐帖浏览量，单独展示为“帖子浏览”。
- 总互动量：点赞、评论、分享、转发的合计，不包含浏览量。
- 热度排行：优先使用逐帖浏览、点赞、评论、分享、转发的合计。

## 验收

- 无人设归档时页面显示空态，接口不报 500。
- 有人设归档时返回总览、图表和明细。
- `recentViews` 与逐帖 `views` 不合并。
- 前台页面在桌面和移动宽度下不出现明显文本重叠或图表溢出。
