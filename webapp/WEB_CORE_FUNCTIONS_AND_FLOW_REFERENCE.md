# Web 端核心功能与执行链路参考

## 1. 目的

这份文档只回答一件事:

- 当前项目里, 哪些功能是真正可执行的核心能力
- 每条能力在后端是怎么一步步跑通的
- Web 前端应该以哪些真实接口和执行器为准
- 哪些内容只是旧 Telegram/Bot/历史运营残留, 不应该再反推 Web 结构

这份文档用于后续整理 `console.html / console.js` 的交互结构, 也用于约束 Web 端不要再出现“按钮文案像 Bot, 但实际执行链路不一致”的问题。

## 2. 单一事实来源

后续 Web 重构时, 以下文件是主参考源:

- `webapp/server.py`
- `webapp/social_automation_api.py`
- `social_automation/runner.py`
- `webapp/db.py`
- `webapp/static/assets/console.js`
- `webapp/static/assets/persona-dashboard.js`

其中角色分工必须明确:

- `server.py`: Web 页面入口, 通用任务队列, 人设总览/详情 API, 本地控制台 session
- `social_automation_api.py`: 指纹浏览器自动化 API, 账号/代理/自动化任务队列
- `runner.py`: 真正执行浏览器任务的地方, 也是“是否支持某动作”的最终判定点
- `db.py`: 两套任务队列和自动化数据表的落库结构
- `console.js`: 当前 Web 控制台壳层
- `persona-dashboard.js`: 人设看板视图逻辑，由控制台的 `persona_dashboard` 面板挂载。

## 3. 系统真实架构

当前项目不是“Web 调 Telegram Bot 再转执行”。

真正的 Web 主链是:

1. 用户打开 Web 页面
2. Web 页面调用 FastAPI 接口
3. FastAPI 把任务写入数据库和队列
4. 后端 worker 取任务
5. 生成任务走通用 `tasks` 队列
6. 浏览器自动化任务走 `social_automation_tasks` 队列
7. 指纹浏览器执行器 `runner.py` 真正打开浏览器执行

也就是说, Web 端后续所有交互设计, 都应该围绕下面两条真实后端主链:

- 通用生成/编辑任务链: `/api/tasks/*`
- 指纹浏览器自动化链: `/api/persona_dashboard/automation/*`

## 4. 页面边界

### 4.1 `console.html`

定位:

- Web 控制台
- 用来替代原先 Bot 的操作入口
- 负责收集参数, 提交任务, 看任务状态

当前页面入口:

- `/console.html`

特点:

- 打开页面时, 后端会创建本地控制台 session
- 这意味着它本身就是 Web 侧的主操作入口, 不是演示页

### 4.2 控制台内置人设看板

定位:

- 人设看板
- 偏数据/运营/汇总/绑定管理
- 是 Web 控制台内的独立视图

当前页面入口:

- `/console.html?view=persona_dashboard`

边界:

- 它不是控制台右侧详情面板的一部分
- 控制台里的“人设看板”直接切换至该内置视图，不再打开独立页面

### 4.3 `admin.html`

定位:

- 运维和配置

结论:

- 不应该拿它们作为 Web 控制台交互结构的参考模板

## 5. 两套任务系统必须分开理解

这是当前项目里最容易混乱的地方。

### 5.1 通用任务队列

用途:

- 生成人设图
- 根据推文正文和人设参考图生成推文配图

入口接口:

- `POST /api/tasks/submit`
- `GET /api/tasks`
- `GET /api/tasks/{task_id}`
- `GET /api/tasks/{task_id}/events`
- `GET /api/tasks/{task_id}/download`
- `POST /api/tasks/{task_id}/retry`

落库表:

- `tasks`
- `task_events`

执行器:

- `server.py` 内的 task worker

### 5.2 浏览器自动化任务队列

用途:

- 打开登录
- 检测登录
- 浏览 feed
- 浏览主页
- 发布内容
- 评论
- 回复评论
- 点赞
- 分享
- Threads 养号
- Threads 自动回复

入口接口:

- `GET /api/persona_dashboard/automation/overview`
- `GET /api/persona_dashboard/automation/accounts`
- `POST /api/persona_dashboard/automation/accounts`
- `PATCH /api/persona_dashboard/automation/accounts/{account_id}`
- `POST /api/persona_dashboard/automation/accounts/{account_id}/open_login`
- `POST /api/persona_dashboard/automation/accounts/{account_id}/check_login`
- `GET /api/persona_dashboard/automation/tasks`
- `POST /api/persona_dashboard/automation/tasks`
- `GET /api/persona_dashboard/automation/tasks/{task_id}`
- `POST /api/persona_dashboard/automation/tasks/{task_id}/cancel`
- `POST /api/persona_dashboard/automation/tasks/{task_id}/retry`
- `GET /api/persona_dashboard/automation/tasks/{task_id}/logs`
- `POST /api/persona_dashboard/automation/media`

落库表:

- `social_accounts`
- `social_proxies`
- `social_automation_tasks`
- `social_automation_logs`

执行器:

- `social_automation_api.py` worker
- `social_automation/runner.py`

### 5.3 结论

Web 控制台不能把这两条链混成一个“任务系统”。

正确方式是:

- 生成/编辑类参数面板 -> 对接 `/api/tasks/*`
- 浏览器账号/发布/养号/自动回复 -> 对接 `/api/persona_dashboard/automation/*`

## 6. 核心功能分组与真实后端链路

下面按 Web 端应该呈现给用户的一级功能来整理。

---

## 6.1 生成 / 编辑任务

### 真实可用能力

当前真正能走通的生成/编辑任务类型:

- `persona_image`
- `persona_post_image`

### 当前前端来源

定义在:

- `webapp/static/assets/console.js` 的 `taskMeta` 和人设图片生成入口

### 参数 -> 提交 -> 执行链

1. 前端收集参数
   - prompt
   - aspect ratio
   - 推文正文
   - 当前人设和参考图

2. 前端调用
   - `POST /api/tasks/submit`

3. 后端 `api_task_submit`
   - 保存上传文件
   - 根据 `task_type` 组装不同 payload
   - 创建任务记录
   - 调 `_enqueue_task`

4. task worker 取任务
   - 状态从 `queued` -> `running`
   - 根据 `TASK_RUNNERS` 分发到真实执行函数

5. 执行完成
   - 写回 `tasks`
   - 写入 `task_events`
   - 前端通过 SSE 和任务详情接口看结果

### Web 端应如何设计

这类任务适合做成:

- 左侧一级菜单只保留“生成 / 编辑任务”
- 右侧参数区通过下拉选择具体任务类型
- 只显示当前任务真正需要的参数
- 文件上传区跟随任务类型切换

### 不能再混入的内容

- 不要把人设发布/账号养号参数混进这个面板
- 不要把 Bot 的历史 callback 文案直接塞成按钮

---

## 6.2 我的人设

### 真实职责

“我的人设”本质不是单个执行器, 而是一个人设数据入口。

它应该承担四类事情:

1. 查看人设列表
2. 查看或修改人设资料
3. 查看该人设绑定的执行账号
4. 从该人设发起内容发布或 Threads 自动化

### 数据来源

主要接口:

- `GET /api/persona_dashboard/overview`
- `GET /api/persona_dashboard/personas/{archive_id}/profile`
- `PATCH /api/persona_dashboard/personas/{archive_id}/profile`
- `POST /api/persona_dashboard/personas/{archive_id}/threads_binding`
- `DELETE /api/persona_dashboard/personas/{archive_id}/threads_binding`
- `POST /api/persona_dashboard/refresh`
- `GET /api/persona_dashboard/refresh/{task_id}`

### 正确页面行为

“我的人设”在控制台里应该这样工作:

1. 进入“我的人设”
2. 用下拉框选择某个人设
3. 右侧显示该人设详细信息
4. 再用另一个下拉框选择操作分组
   - 内容与发布
   - 人设设置
   - 浏览器账号
   - 数据与队列

这意味着:

- 人设列表应该完整展示在可选范围内
- 不应该把每个人设都展开成占空间的大卡片
- 未绑定账号的状态, 应该在详情或下拉项中明确标注

### 人设详情区应该显示什么

建议只展示真实字段:

- 人设名称
- 简介/内容
- 绑定账号
- 链接预设
- 推文风格相关字段
- 素材图数量
- 已发布数/热度/帖子数等统计
- 当前队列状态

### 控制台和人设看板的关系

必须明确:

- 控制台中的“我的人设”不会自动跳去人设看板
- 只有点击“人设看板”时，才切换到控制台内置看板视图

---

## 6.3 发布与排程

### 真实职责

这部分不是通用生成任务, 它属于浏览器自动化任务。

典型动作:

- 立即发布
- 按账号发布
- 按素材发布
- 定时入队

### 真实后端入口

- `POST /api/persona_dashboard/automation/tasks`

### 典型链路

1. 用户选人设
2. 系统确定执行账号
3. 如需素材, 先调用
   - `POST /api/persona_dashboard/automation/media`
4. 拿到 `media_paths`
5. 创建自动化任务
   - `task_type = publish_post`
   - 或其他浏览器自动化任务类型
6. 写入 `social_automation_tasks`
7. automation worker 取任务
8. `runner.py` 打开 Camoufox profile 执行

### 平台限制

当前平台能力不是全平台通用。

特别注意:

- Threads Web 自动化目前不支持 `publish_post`
- Threads 当前只支持:
  - `open_login`
  - `check_login`
  - `browse_feed`
  - `threads_warmup`
  - `threads_auto_reply`

因此 Web 端必须根据账号平台做参数和动作过滤, 不能把所有按钮都展示出来。

---

## 6.4 指纹浏览器自动化

### 真实职责

这是浏览器执行链的基础层, 不是附属功能。

主要包含:

- 打开登录
- 检测登录
- 浏览 Feed
- 浏览主页
- 账号养号
- 自动回复

### 当前后端支持的任务类型

`social_automation_api.py` 当前允许:

- `check_login`
- `open_login`
- `browse_feed`
- `browse_profile`
- `threads_warmup`
- `threads_auto_reply`
- `publish_post`
- `comment_post`
- `reply_comment`
- `like_post`
- `share_post`
- `repost_post`

但“允许创建任务”和“真正 runner 支持”不是一回事。

### 最终以 runner 为准

`runner.py` 才是最终真实能力边界:

- 平台只支持 `instagram` 和 `threads`
- `threads_warmup` / `threads_auto_reply` 只能跑在 Threads
- Threads 不支持 `publish_post` / `comment_post` / `reply_comment` / `like_post` / `share_post`
- Instagram 不支持真正的 `repost_post`

### Web 端实现规则

前端必须做到:

1. 先选账号或从人设推导账号
2. 识别平台
3. 只展示该平台真实支持的动作
4. 对于需要 URL/内容/图片的动作, 只展示对应参数

这一步是后续 Web 前端避免“按钮点了但执行错逻辑”的关键。

---

## 6.5 任务队列

### 这部分实际要分成两个视图

#### A. 通用任务队列

看的是:

- 生成/编辑任务

来源:

- `/api/tasks`

#### B. 自动化任务队列

看的是:

- 登录
- 发布
- 养号
- 自动回复

来源:

- `/api/persona_dashboard/automation/tasks`

### Web 端不要再做的事情

- 不要把这两个列表混在一起
- 不要用 Bot 的“待发布/失败/定时”词面直接代表一个真实数据源
- 必须让每个列表都能明确看到:
  - 任务类型
  - 平台
  - 执行账号
  - 状态
  - 创建时间
  - 调度时间
  - 错误信息
  - 日志或事件入口

---

## 6.6 系统状态

当前项目没有一个单独的“万能系统状态执行器”。

Web 端如果要展示系统状态, 应从真实状态源汇总:

- `/api/persona_dashboard/automation/overview`
- `/api/persona_dashboard/monitor`
- `/api/tasks`
- `/api/persona_dashboard/automation/tasks`
- 后端 worker 状态
- 远程 Comfy 健康状态相关接口

因此“系统状态”更适合做成只读汇总, 不适合伪装成一个独立业务链。

## 7. Threads 相关链路

当前 Web 项目里, Threads 不是通用发布平台, 而是一个受限自动化平台。

### 真实可用链路

- `open_login`
- `check_login`
- `browse_feed`
- `threads_warmup`
- `threads_auto_reply`

### 真实数据增强

当创建 Threads 自动化任务时:

1. 前端提交 `persona_id + account_id + task_type + payload`
2. 后端 `_enrich_threads_task_payload`
3. 从 persona archive 补齐:
   - persona 信息
   - reply templates
   - hot post 目标
   - 策略参数
4. worker 执行
5. 成功后 `_sync_successful_task_to_persona_archive`

### 对 Web 端的含义

这说明 Threads 相关动作不能只靠前端假文案。

必须基于后端真实 task type 和 payload 组织 UI。

## 8. 当前前端里已经确认的残留/混乱点

下面这些内容是后续 Web 整理时必须明确处理的。

### 8.1 不应继续作为一级真实能力展示

#### `get_gemini`

现状:

- 专用接口还在
- 但当前控制台主提交流程走的是 `/api/tasks/submit`
- 当前通用提交流程没有按执行器真实期望去组装 `user_input`

结论:

- 当前它不应被视为“已闭环的稳定 Web 能力”
- 如果不修, 就不该继续作为正式可执行入口展示

#### `repost_post`

现状:

- API 类型里还有
- runner 明确不支持 Instagram 真 repost
- Threads 也没有实现这条链

结论:

- 属于旧残留
- 不应作为正式 Web 动作展示

### 8.2 只是前端别名, 不是后端真实任务类型

例如:

- `reply_hot`
- `acctprofile`
- `persona_autoreply`
- `persona_warmup`
- `acctplatform_threads`

这些只是前端映射壳层。

Web 重构时必须统一回真实后端动作:

- `open_login`
- `check_login`
- `browse_feed`
- `browse_profile`
- `publish_post`
- `comment_post`
- `reply_comment`
- `like_post`
- `share_post`
- `threads_warmup`
- `threads_auto_reply`

### 8.3 Telegram 历史命名残留

例如:

- `tg_prompt_mode`
- `tg_web_branch`
- `/api/internal/tg/*`

要分开看:

- `tg_prompt_mode` 这类字段虽然名字旧, 但生成链里仍在实际使用
- `/api/internal/tg/*` 是旧客户端调用 Web 的入站兼容层，本身不访问 Telegram；daemon、Bot API 出站通知和自动启动入口已移除

## 9. 哪些内容不应该再作为 Web 端参考

后续整理 Web 结构时, 以下内容只能视为历史兼容层, 不能再反推设计:

- `/api/internal/tg/*`
- Persona archive 中的 `pad` / `boundPadCode` / `ownerBotName` 一类历史运营字段
- 控制台中为了兼容旧流程而保留的动作别名
- `admin.html`
- 已经失效或缺页的旧入口

## 10. 给 Web 前端的落地规则

这部分是后续改 `console.js` 和页面结构时必须遵守的规则。

### 10.1 左侧导航规则

左侧只保留一级菜单。

建议一级菜单:

- 生成 / 编辑任务
- 我的人设
- 发布与排程
- 指纹浏览器自动化
- 任务队列
- 系统状态

不要在左侧再展开第二层按钮列表。

### 10.2 右侧参数面板规则

右侧只负责:

- 当前一级菜单下的参数调整
- 当前执行对象选择
- 当前动作选择
- 当前执行确认

也就是:

- 一级选项在左侧
- 二级分支在右侧用下拉框或切换控件完成

### 10.3 参数展示规则

只能展示当前动作真正需要的参数。

例如:

- `publish_post` 才展示素材上传
- `browse_profile` 才展示目标主页 URL
- `reply_comment` 才展示回复文本
- `threads_warmup` 才展示策略参数

不要为了对齐 Bot 而把一堆无效按钮堆出来。

### 10.4 按钮规则

按钮只保留两类:

1. 会触发真实执行动作的按钮
2. 会切换到明确业务视图或打开必要操作面板的按钮

如果某项内容已经能直接在当前面板编辑并保存, 就不要再额外做一个重复按钮。

### 10.5 平台过滤规则

前端必须按平台过滤动作:

- Threads 只显示 Threads 真支持的动作
- Instagram 只显示 Instagram 真支持的动作
- 不支持的动作不允许“先展示再报错”

### 10.6 人设规则

- 人设列表用下拉框选择
- 右侧展示详情
- 人设看板是控制台内置视图
- 控制台中的人设操作不能乱跳到人设看板

### 10.7 刷新规则

控制台只保留一个全局刷新入口即可。

参数面板里不要再放“刷新人设”“局部刷新”这类重复刷新按钮, 除非某个任务链本身需要明确二次拉取远端数据。

## 11. 建议的 Web 映射关系

这是后续前端继续改版时最实用的一层映射。

### 11.1 生成 / 编辑任务

右侧应包含:

- 任务类型下拉
- prompt 参数
- 任务专属参数
- 文件区
- 提交按钮
- 任务状态摘要

### 11.2 我的人设

右侧应包含:

- 人设选择下拉
- 操作分组下拉
- 当前分组详细字段
- 当前分组真实动作按钮

### 11.3 发布与排程

右侧应包含:

- 执行账号选择
- 平台选择或平台展示
- 发布动作选择
- 素材上传
- 定时信息
- 提交任务

### 11.4 指纹浏览器自动化

右侧应包含:

- 账号选择
- 平台信息
- 动作下拉
- 目标 URL / 文本 / 策略参数
- 提交按钮
- 最近日志/状态

### 11.5 任务队列

右侧应包含两个 tab 或两个切换视图:

- 通用任务
- 自动化任务

## 12. 当前结论

可以直接作为 Web 端参考的核心事实如下:

1. Web 真正的执行中心不是 Telegram, 而是 FastAPI + 两套任务队列 + Camoufox runner
2. 人设看板已内置到控制台，是同一控制台内的独立业务视图
3. 生成/编辑任务与浏览器自动化任务必须分为两条后端链
4. Threads 是受限自动化平台, 不是当前项目里的通用发布平台
5. 一切前端菜单、下拉项、按钮文案, 都必须回到真实 task type、真实 API 和真实 runner 能力来组织
6. 无效残留能力和旧 Bot 命名不能继续主导 Web 结构

## 13. 后续改版时的优先顺序

建议按下面顺序继续整理 Web 控制台:

1. 先按本文件梳理一级菜单边界
2. 再把每个一级菜单右侧的二级分支统一改成下拉/参数面板
3. 再逐项清理假按钮、残留别名和无效动作
4. 最后补齐每个动作的“参数 -> 提交 -> 状态 -> 日志/结果”闭环

只有按这条顺序走, Web 端才会从“像 Bot 的壳”真正收敛成“真实可执行的控制台”。
