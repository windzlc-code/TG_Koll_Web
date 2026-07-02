# Current goal
完成 Lingke 历史遗留的仓库级收尾，确保源码、打包样例、测试、快照和本地运行数据里不再残留 `lingkeapi.com` / `LINGKE_API_KEY` / `Lingke` 文本命中。

# Changed files
- CODEX_PROGRESS.md
- claude.py
- task.py
- WorkFlow.py
- tiktok_face_replace_app.py
- webapp/server.py
- commerce_video_generator.py
- replace_productANDmodel.py
- tests/test_workflow_chains.py
- webapp/static/admin.html
- webapp/static/assets/admin.js
- webapp/static/assets/app.js
- webapp/static/assets/style.css
- webapp/tests/test_admin_logs.py
- webapp/tests/test_batch_create_video_logic.py
- webapp/tests/test_commerce_video_resume.py
- webapp/tests/test_nano_banana.py
- webapp/tests/test_runtime_config.py
- dist/WorkflowDesktop/_internal/runtime_config.example.json
- webapp_data_qa/runtime_config.json
- webapp_data_qa_run/runtime_config.json

# Key decisions
- 后端新增工作流链数组字段：`oral_digital_human_workflow_ids`、`image_generate_workflow_ids`、`replace_model_*_workflow_ids`、`replace_product_workflow_ids`。
- 旧的单个工作流字段继续保留，运行时从新链路字段做兼容映射：口播链取首步作为音频、末步作为视频，其余工作流链取最后一个有效步骤作为 legacy `*_app_id`。
- 执行层已按链路顺序消费这些配置：
  - `口播数字人工作流`：首步生成音频，后续步骤按顺序串联视频工作流，上一阶段视频会重新上传给下一阶段。
  - `RunningHub 生图工作流`：按步骤顺序串联，上一阶段生成图片会重新上传给下一阶段。
  - `模特替换 / 商品替换 / 联合替换商品和模特`：按步骤顺序串联，上一阶段输出视频会重新上传给下一阶段。
- `replace_productANDmodel` 新增 `model_app_ids` / `product_app_ids`，并在服务端入口把 `model_workflow_chain_ids` / `product_workflow_chain_ids` 传入执行层。
- 任务详情页新增 `execution_trace`：
  - `replace_model / replace_product / image_generate` 直接从 `raw_result.steps` 提取链路步骤
  - `create_video / commerce_video / batch_create_video` 从产物目录 `logs.jsonl` 提取视频链步骤
  - `replace_productANDmodel` 从产物目录 `logs.jsonl` 提取模特链 / 商品链的分段步骤
- 前端详情弹窗新增“执行链路”区块，展示每一步的工作流 ID、RunningHub task id、状态、输入引用、输出路径、续链上传引用。
- 后端新增 `workflow_chain_summary` / `workflow_step_count`：
  - 任务列表可直接显示“口播链 3 步（音频 1 + 视频 2）”这类摘要
  - 任务详情面板也同步展示链路摘要
- 前端系统配置页改成两个大面板：
  - `闭源模型配置`：文字模型 + 图片模型
  - `开源模型配置`：RunningHub API Key + 串联工作流编辑器 + 兼容图片与识别服务
- 工作流编辑器采用 `+/-` 行内步骤编辑，允许增加、删除和修改每一步 RunningHub 工作流 ID。
- 闭源模型候选配置继续拆分：
  - `文字模型` 新增 `Gemini 候选模型` 和 `GPT 候选模型`
  - `图片模型` 改为分别维护 `Gemini 候选模型` 和 `GPT 候选模型`
- 后端运行配置新增拆分字段：
  - `llm_default_model_gemini`
  - `llm_default_model_gpt`
  - `image_model_default_model_gemini`
  - `image_model_default_model_gpt`
- 旧的 `llm_default_model` / `image_model_default_model` 继续保留作为兼容字段：
  - 优先取 Gemini 列表
  - 若 Gemini 为空则回退到 GPT 列表
- 归一化逻辑允许“只配置 GPT，不配置 Gemini”，不会在下一次读取时错误把 GPT 候选回填到 Gemini 列表。
- 前端在闭源模型配置区新增“当前默认执行”提示：
  - 文字模型显示当前默认来源和首个候选模型
  - 图片模型显示当前默认来源和首个候选模型
  - 判定规则与兼容字段保持一致：优先 Gemini，Gemini 为空则回退 GPT
- 文字模型配置继续拆分：
  - 新增 `llm_api_key_gemini`
  - 新增 `llm_api_key_gpt`
  - 旧的 `llm_api_key` 继续保留为兼容字段，优先映射到 Gemini key
- `_resolve_llm_settings()` 现在会根据 `llm_model / llm_default_model` 判断提供商：
  - `gpt-* / o1 / o3 / o4` 走 GPT key
  - 其他默认走 Gemini key
  - 若目标 key 为空，再回退到 legacy key 或另一侧 key
- Lingke 收尾按三层处理：
  - 可执行源码：去掉 `lingkeapi.com` 和 `LINGKE_API_KEY`，改为通用或当前配置名
  - 打包样例：同步 `dist/WorkflowDesktop/_internal/webapp/static` 到当前 `webapp/static`
  - 本地数据与快照：删除 `.playwright-mcp`，重写 QA/本地 runtime json、jsonl 和 sqlite 文本字段，并对 sqlite 做 `VACUUM` / 重建以消除旧字节残留

# Verification
- 本地 `python -m compileall webapp/server.py commerce_video_generator.py replace_productANDmodel.py` 通过
- 本地 `python -m pytest tests/test_runninghub_common.py tests/test_workflow_chains.py -q` 通过（`9 passed`）
- 本地 `python -m pytest tests/test_runninghub_common.py tests/test_workflow_chains.py -q` 通过（最新为 `11 passed`）
- 本地 `python -m pytest tests/test_runninghub_common.py tests/test_workflow_chains.py -q` 通过（最新为 `12 passed`）
- 本地 `node --check webapp/static/assets/admin.js` 通过
- 本地 smoke test：
  - `replace_productANDmodel.run_product_and_model_replace()` 在 `model_app_ids=['m1','m2']` 和 `product_app_ids=['p1','p2']` 时按顺序执行链路，最终文件生成成功。
  - `webapp.server._run_replace_product_and_model()` 能把 `model_workflow_chain_ids` / `product_workflow_chain_ids` 正确透传到执行层，并把最后一个 RunningHub task id 作为主 task id 返回。
  - `webapp.server._normalize_runtime_config()` 能把后台保存的链路数组回填为 legacy `create_*_app_id / replace_*_app_id`
- 本地真实页面验证：
  - 临时启动 `uvicorn webapp.server:app --host 127.0.0.1 --port 8099`
  - 登录 `admin / admin123` 成功
  - `系统配置` 页已显示 `闭源模型配置` 和 `开源模型配置`
  - `口播数字人工作流` 的 `+/-` 按钮验证通过，可新增和删除步骤
  - 点击 `保存运行配置` 后返回成功提示，并完成回填
- 线上部署验证：
  - 已上传 `webapp/server.py`、`commerce_video_generator.py`、`replace_productANDmodel.py` 到 `47.250.188.76:/opt/apps/digital-human-tg-bot`
  - 已上传 `tests/test_workflow_chains.py` 到远端，仅用于零成本验证，不影响运行时
  - 远端 `./.venv/bin/python -m compileall ...` 通过
  - `systemctl restart digital-human-tg-bot.service` 成功，`systemctl is-active` 返回 `active`
  - 公网页面 `http://47.250.188.76/login.html` 可访问，标题为“登录 - 电商带货视频生成平台”
  - 远端未安装 `pytest`，因此未新增依赖；改用内联 Python smoke test 验证链路，结果通过
- Playwright 实测远端 `http://47.250.188.76/admin.html#admin-runtime`：
  - `闭源模型配置` / `开源模型配置` 面板存在
  - `口播数字人工作流` 已显示两步链路
  - 所有工作流配置项仍可见，未触发真实 RunningHub 请求
- Playwright 实测远端 `http://47.250.188.76/admin.html#admin-tasks` 可正常打开，说明新增详情渲染代码未破坏后台记录页。
- Playwright 零成本假数据验证：
  - 在远端后台页面直接调用 `openTaskInspectModal(buildTaskDetailHtml(fakeData))`
  - 已确认任务详情弹窗内出现“执行链路”区块
  - 已确认联合替换示例中 2 条链、4 个步骤、每步的流程 ID / task id / 输入 / 输出 / 续链上传引用都会显示
  - 已确认任务卡片假数据会显示 `链路摘要`
  - 已确认任务详情 HTML 会显示 `链路摘要`
- 本地新增候选模型拆分验证：
  - `python -m pytest tests/test_runninghub_common.py tests/test_workflow_chains.py -q` 通过（最新为 `15 passed`）
  - `python -m compileall webapp/server.py tests/test_workflow_chains.py` 通过
  - `node --check webapp/static/assets/admin.js` 通过
- 本地新增默认执行来源展示验证：
  - `python -m pytest tests/test_runninghub_common.py tests/test_workflow_chains.py -q` 继续通过（`15 passed`）
  - `node --check webapp/static/assets/admin.js` 通过
- 本地新增文字模型分钥匙验证：
  - `python -m pytest tests/test_runninghub_common.py tests/test_workflow_chains.py -q` 通过（最新为 `18 passed`）
  - `python -m compileall webapp/server.py tests/test_workflow_chains.py` 通过
  - `node --check webapp/static/assets/admin.js` 通过
- 线上文字模型分钥匙验证：
  - 已部署 `webapp/server.py`、`webapp/static/admin.html`、`webapp/static/assets/admin.js`
  - `systemctl restart digital-human-tg-bot.service` 成功，服务状态 `active`
  - 浏览器实测 `http://47.250.188.76/admin.html?ts=20260523c#admin-runtime`
  - 已确认页面出现 `Gemini 文字模型密钥` 和 `GPT 文字模型密钥`
  - 已确认兼容回填生效：Gemini key 已显示旧配置值，GPT key 当前为空
- 本地 Lingke 收尾验证：
  - `python -m compileall claude.py task.py WorkFlow.py tiktok_face_replace_app.py webapp/server.py` 通过
  - `node --check webapp/static/assets/app.js` 通过
  - `node --check webapp/static/assets/admin.js` 通过
  - 文本级仓库扫描：`lingkeapi\\.com|LINGKE_API_KEY|lingke|Lingke` 命中为 0（已排除虚拟环境和缓存二进制）
  - sqlite SQL 复核：
    - `webapp_data/app.db` 命中 0
    - `webapp_data_qa/app.db` 命中 0
    - `webapp_data_qa_run/app.db` 命中 0
  - 子集 pytest 复跑未通过，但失败集中在既有的 `commerce_video_resume` mock 目标漂移和 `runtime_config` 断言不一致，不是 Lingke 文本残留

# Blockers
- 无 Lingke 清理 blocker。
- 当前未做远端重新部署；本次主要是本地仓库、打包样例和历史数据收尾。

# Next steps
1. 如需把这次 Lingke 收尾同步到 ECS，再部署一次 `/opt/apps/digital-human-tg-bot`。
2. 如需继续修测试，下一步处理 `webapp/tests/test_commerce_video_resume.py` 的 `get_nano_banana` mock 目标，以及 `webapp/tests/test_runtime_config.py` 与当前运行配置兼容逻辑的断言漂移。

---

# 2026-05-24 TG Bot 恢复记录

## 现象
- 用户反馈 Telegram Bot 操作无响应。

## 根因
- 线上唯一的 `digital-human-tg-bot.service` 当前实际执行的是：
  - `/opt/apps/digital-human-tg-bot/.venv/bin/uvicorn webapp.server:app --host 127.0.0.1 --port 8091`
- 这意味着服务只启动了新版 Web 后台，没有启动旧的 `src/digital_human_tg_bot/bot.py` 轮询进程。
- 服务器上的旧 TG Bot 代码、`.env` 中的 `TG_BOT_TOKEN`、以及 `data/workbench.db` 的授权成员数据都仍然存在，问题不是 token 丢失，也不是白名单为空，而是 bot worker 没有运行。

## 处理
- 新增远端文件：
  - `/opt/apps/digital-human-tg-bot/run_tg_bot_only.py`
  - `/etc/systemd/system/digital-human-tg-bot-telegram.service`
- 新 service 只负责：
  - 加载旧 `src/digital_human_tg_bot` 配置
  - 启动 `WorkspaceService`
  - 启动 `TelegramWorkbenchBot` 轮询
- 保持原 `digital-human-tg-bot.service` 不变，继续提供 8091 Web 后台。

## 验证
- `systemctl is-active digital-human-tg-bot.service` -> `active`
- `systemctl is-active digital-human-tg-bot-telegram.service` -> `active`
- `systemctl show digital-human-tg-bot-telegram.service -p ExecStart -p ActiveState -p SubState`
  - `ExecStart=/opt/apps/digital-human-tg-bot/.venv/bin/python /opt/apps/digital-human-tg-bot/run_tg_bot_only.py`
  - `ActiveState=active`
  - `SubState=running`
- Telegram API 验证：
  - `getMe` 返回 `200`，bot 用户名 `ricky54088_bot`
  - `getWebhookInfo` 返回空 `url`，确认当前是 polling，不存在残留 webhook
  - 对授权成员 `6470391105` 和 `7601992552` 执行 `sendMessage`，均返回 `200`

## 风险
- 这次恢复是服务器侧 operational fix，当前本地交付包主线仍然是 Web 版，不包含可直接部署的 TG Bot 双服务编排。
- 如果后续再次整包覆盖 ECS，而没有保留 `digital-human-tg-bot-telegram.service` 和 `run_tg_bot_only.py`，TG Bot 会再次失效。

---

# 2026-05-24 TG Bot 设置页补齐

## 目标
- 在当前 Web 后台的 `系统配置` 页展示 TG Bot 相关配置。
- 允许管理员新增、启停、删除信任的 TG 用户 ID。
- 复用旧 TG 工作台数据库 `/opt/apps/digital-human-tg-bot/data/workbench.db`，让之前已经配置过的授权成员直接显示。

## 改动
- `webapp/server.py`
  - 新增 `TG_WORKBENCH_DB_PATH`，默认指向 `ROOT_DIR/data/workbench.db`。
  - 新增 `/api/admin/tg_settings`。
  - 新增 `/api/admin/tg_trusted_users`。
  - 新增 `/api/admin/tg_trusted_users/{chat_id}/toggle`。
  - 新增 `/api/admin/tg_trusted_users/{chat_id}` 删除接口。
  - 接口会读取 `.env` 中的 `TG_BOT_TOKEN`、`TG_ALLOWED_CHAT_IDS`、`TG_CHAT_ID`，并只返回脱敏 token。
- `webapp/static/admin.html`
  - `系统配置` 页新增 `TG Bot 设置` 面板。
  - 显示 Bot Token 状态、授权数据库路径、环境默认 ID、信任用户数量。
  - 支持输入 TG 用户 ID、备注、启用状态和通知开关。
- `webapp/static/assets/admin.js`
  - 新增 TG 设置加载、渲染、新增、启停、删除逻辑。
- `webapp/static/assets/style.css`
  - 新增 TG 设置面板和信任用户表格样式。

## 验证
- 本地：
  - `python -m compileall webapp/server.py` 通过。
  - `node --check webapp/static/assets/admin.js` 通过。
  - 本地 smoke 验证能从 `TG_ALLOWED_CHAT_IDS=7601992552,6470391105` 初始化授权成员。
- 远端：
  - 已上传 `webapp/server.py`、`webapp/static/admin.html`、`webapp/static/assets/admin.js`、`webapp/static/assets/style.css`。
  - `systemctl restart digital-human-tg-bot.service` 成功。
  - `digital-human-tg-bot.service` 和 `digital-human-tg-bot-telegram.service` 均为 `active`。
- 远端 smoke 确认读取到旧授权成员：

---

# 2026-05-24 口播数字人三步链路（TG 同步）

## 目标
- 让 TG 口播入口适配新的链路：`RunningHub(音频) -> 闭源图片模型(生成人像) -> RunningHub(数字人视频)`。
- TG 口播提交流程改走内部 Web 提交，统一到 `webapp/server.py` 的执行链路，避免继续走旧 `DigitalHumanWorkflowRunner`。

## 改动
- `src/digital_human_tg_bot/media.py`
  - 新增 `extract_video_first_frame()`，用于从 TG 上传视频提取首帧图片。
- `src/digital_human_tg_bot/bot.py`
  - 口播上传交互改为 4 步：`视频 -> 文案 -> 人像提示词 -> 秒数`（移除“上传照片”步骤）。
  - 提交时自动抽取视频首帧作为 `model_image_local_path/product_image_local_path` 占位输入。
  - 提交 `create_video` 内部任务参数：
    - `speech_text`
    - `prompt_text`（人像提示词）
    - `camera_video_local_path`
    - `model_image_local_path`
    - `product_image_local_path`
  - `ORAL_DEFAULT_BUTTON` 与 `/run` 改为内部提交 `create_video`，不再走旧本地 runner。
  - TG 文案同步更新为“视频、文案、人像提示词、秒数”。
- `webapp/server.py`
  - `_build_internal_tg_task_payload()` 新增支持 `create_video / commerce_video`，并校验本地文件参数。

## 验证
- `python -m compileall src/digital_human_tg_bot/bot.py src/digital_human_tg_bot/media.py webapp/server.py` 通过。
- 本地零成本 smoke：
  - 直接调用 `_build_internal_tg_task_payload(..., 'create_video', ...)`，返回成功并完成路径校验。
- 远端部署验证：
  - 已上传 `src/digital_human_tg_bot/bot.py`、`src/digital_human_tg_bot/media.py`、`webapp/server.py` 到 `47.250.188.76:/opt/apps/digital-human-tg-bot`。
  - 远端 `./.venv/bin/python -m compileall ...` 通过。
  - `systemctl restart digital-human-tg-bot.service` 与 `digital-human-tg-bot-telegram.service` 成功，`is-active` 均为 `active`。
  - 远端接口探针 `POST /api/internal/tg/submit`（`task_type=create_video`, 空参数）返回 `400: 模特图 不能为空`，说明接口已进入 `create_video` 分支（不再是“TG 暂不支持的任务类型”）。

## 备注
- 这次没有触发真实 RunningHub / 闭源模型请求，只做了本地静态与函数级验证。
    - `6470391105 / Frank / enabled`
    - `7601992552 / TG-7601992552 / enabled`
  - 浏览器实测 `http://47.250.188.76/admin.html?ts=20260524tg#admin-runtime`：
    - 页面出现 `TG Bot 设置`。
    - 显示脱敏 token `8788***Tt_U`。
    - 显示授权数据库 `/opt/apps/digital-human-tg-bot/data/workbench.db`。
    - 显示旧授权成员 2 条。
  - 浏览器 API smoke：
    - 临时新增 `999999999 / Codex smoke test` 返回 200。
    - 随后删除该临时 ID 返回 200。
    - 最终授权成员数量恢复为 2。

---

# 2026-05-24 TG Bot 指令与后台工作流对齐

## 目标
- 用户反馈 TG Bot 上的按钮/指令与后台工作流配置对应不上。
- 调整 TG 菜单，让按钮直接按后台工作流命名，避免旧的泛化按钮误导用户。
- 不触发真实 RunningHub/API 任务，避免资金消耗。

## 根因
- 线上 TG Bot worker 使用旧 `src/digital_human_tg_bot/bot.py`。
- 旧菜单只有：
  - `上傳素材建立任務`
  - `預設素材建立任務`
- 这两项实际只会进入口播数字人链，但后台系统配置现在已经拆成：
  - 口播数字人工作流
  - 图片生成工作流
  - 模特替换工作流
  - 商品替换工作流
  - 联合替换工作流

## 改动
- 从服务器同步旧 TG 源码到本地交付包，补齐：
  - `run_tg_bot_only.py`
  - `src/digital_human_tg_bot/*.py`
- 修改 `src/digital_human_tg_bot/bot.py`：
  - 新 TG 菜单：
    - `口播數字人：上傳素材`
    - `口播數字人：預設素材`
    - `圖片生成工作流`
    - `聯合替換工作流`
    - `模特替換工作流`
    - `商品替換工作流`
    - `查看後台工作流配置`
  - 保留旧按钮 `上傳素材建立任務` / `預設素材建立任務` 作为兼容别名。
  - 新增 `/workflow` 指令，读取 `runtime/runtime_config.json` 并展示当前 workflow ID 链。
  - 图片/替换类按钮只展示当前后台工作流配置和 Web 工作台地址，不在 TG 里提交任务，避免误触发真实 API。

## 远端部署
- 远端备份：
  - `/opt/apps/digital-human-tg-bot/src/digital_human_tg_bot/bot.py.bak-20260524061929`
- 已上传：
  - `/opt/apps/digital-human-tg-bot/src/digital_human_tg_bot/bot.py`
- 已重启：
  - `digital-human-tg-bot-telegram.service`

## 验证
- 本地：
  - `python -m compileall src/digital_human_tg_bot/bot.py run_tg_bot_only.py` 通过。
- 远端：
  - `./.venv/bin/python -m compileall src/digital_human_tg_bot/bot.py run_tg_bot_only.py` 通过。
  - `systemctl is-active digital-human-tg-bot-telegram.service` -> `active`。
  - `systemctl is-active digital-human-tg-bot.service` -> `active`。
  - 远端只读 smoke 输出新键盘：
    - `口播數字人：上傳素材 | 口播數字人：預設素材`
    - `圖片生成工作流 | 聯合替換工作流`
    - `模特替換工作流 | 商品替換工作流`
    - `查看後台工作流配置 | 查看工作台狀態`
  - 远端只读 smoke 输出当前配置：
    - 口播数字人：`2027189109067878402 > 2018758760096862209`
    - 图片生成：`1900814586436534274`
    - 模特替换原版：`1977634608437174274`
    - 模特替换主要/动作迁移：`2047889041936355329`
    - 模特替换切片：`1955095782514987010`
    - 商品替换：`1977410328592031746`

## 注意
- 本次没有提交真实任务，也没有调用 RunningHub 任务接口。
- TG 直接建任务当前仍只支持口播数字人链；图片生成和替换类按钮会提示到 Web 工作台提交。

---

# 2026-05-24 TG Bot 操作面板精简

## 目标
- 用户反馈 TG Bot 操作面板内容太杂，要求移除生产无关项。

## 改动
- 修改 `src/digital_human_tg_bot/bot.py` 的 `_menu_keyboard()`。
- 面板从 6 行精简为 3 行，只保留：
  - `口播數字人：上傳素材`
  - `口播數字人：預設素材`
  - `重跑最近任務`
  - `查看工作台狀態`
  - `強制停止目前任務`
- 从面板移除：
  - 图片生成/替换类工作流说明按钮
  - `查看後台工作流配置`
  - `工作台網址`
  - `設定預設文案`
- 兼容处理：
  - 旧按钮文本和 `/workflow`、`/workbench`、`/setscript` 等入口仍保留 handler，可手动输入使用，不再展示在面板里。

## 部署与验证
- 远端备份：
  - `/opt/apps/digital-human-tg-bot/src/digital_human_tg_bot/bot.py.bak-20260524062355`
- 已上传：
  - `/opt/apps/digital-human-tg-bot/src/digital_human_tg_bot/bot.py`
- 已重启：
  - `digital-human-tg-bot-telegram.service`
- 验证：
  - 本地 `python -m compileall src/digital_human_tg_bot/bot.py run_tg_bot_only.py` 通过。
  - 远端 `./.venv/bin/python -m compileall src/digital_human_tg_bot/bot.py run_tg_bot_only.py` 通过。
  - `digital-human-tg-bot-telegram.service` 为 `active/running`。
  - `digital-human-tg-bot.service` 为 `active`。
  - 远端只读 smoke 新菜单：
    - `口播數字人：上傳素材 | 口播數字人：預設素材`
    - `重跑最近任務 | 查看工作台狀態`
    - `強制停止目前任務`

## 注意
- 本次没有提交真实任务，没有调用 RunningHub/API。

---

# 2026-05-24 TG Bot 其他生产工作流执行层接入

## 目标
- 用户反馈 TG 中点击 `图片生成工作流` 只提示“到 Web 工作台提交”，但希望 TG 也可以执行其他生产工作流。
- 继续遵守“不真实发布 API 请求导致资金消耗”，验证只做无成本路径。

## 根因
- 上一版只把图片生成、模特替换、商品替换、联合替换恢复为 TG 菜单入口。
- 这些按钮仍是配置说明入口，没有真正收集素材、没有提交到 Web 后台任务队列，所以截图里会出现“目前 TG 只开放口播数字人直接提交”的提示。

## 改动
- `webapp/server.py`
  - 新增本机内部接口 `POST /api/internal/tg/submit`，供 TG worker 提交任务到 Web 后台队列。
  - 接口只允许 localhost 调用；如设置 `TG_INTERNAL_API_TOKEN`，还会校验 `x-tg-internal-token`。
  - 新增 TG 内部任务 payload 构建与文件校验，支持 `image_generate`、`replace_model`、`replace_product`、`replace_productANDmodel`。
  - 提交后复用 Web 后台 `_enqueue_task()`，因此任务记录、排队、计费、运行日志都走同一执行层。
- `src/digital_human_tg_bot/bot.py`
  - `图片生成工作流`：在 TG 收集商品图和提示词，然后提交 `image_generate`。
  - `模特替换工作流`：在 TG 收集原视频、模特图、提示词、秒数，然后提交 `replace_model`。
  - `商品替换工作流`：在 TG 收集原视频、商品图、商品名、提示词、秒数，然后提交 `replace_product`。
  - `联合替换工作流`：在 TG 收集原视频、模特图、商品图、商品名、秒数，然后提交 `replace_productANDmodel`。
  - 口播数字人旧流程保持不变。

## 部署
- 远端备份：
  - `/opt/apps/digital-human-tg-bot/webapp/server.py.bak-20260524063356`
  - `/opt/apps/digital-human-tg-bot/src/digital_human_tg_bot/bot.py.bak-20260524063356`
- 已上传：
  - `/opt/apps/digital-human-tg-bot/webapp/server.py`
  - `/opt/apps/digital-human-tg-bot/src/digital_human_tg_bot/bot.py`
- 已重启：
  - `digital-human-tg-bot.service`
  - `digital-human-tg-bot-telegram.service`

## 验证
- 本地 `python -m compileall webapp/server.py src/digital_human_tg_bot/bot.py run_tg_bot_only.py` 通过。
- 本地 FastAPI TestClient 对 `/api/internal/tg/submit` 发送缺失文件路径，返回 400，未入队。
- 远端 `./.venv/bin/python -m compileall webapp/server.py src/digital_human_tg_bot/bot.py run_tg_bot_only.py` 通过。
- `systemctl is-active digital-human-tg-bot.service` -> `active`
- `systemctl is-active digital-human-tg-bot-telegram.service` -> `active`
- 远端只读菜单 smoke 输出：
  - `口播數字人：上傳素材 | 口播數字人：預設素材`
  - `圖片生成工作流 | 聯合替換工作流`
  - `模特替換工作流 | 商品替換工作流`
  - `重跑最近任務 | 查看工作台狀態`
  - `強制停止目前任務`
- 本机内部接口负向 smoke：
  - 请求 `image_generate` 并传入不存在的 `product_image_local_path`
  - 返回 `400 {"detail":"商品图 文件不存在: /tmp/codex-no-such-image.png"}`
  - 这证明请求停在文件校验层，没有提交真实任务、没有调用 RunningHub。

## 注意
- 从现在开始，用户在 TG 中完整走完这些工作流的素材/参数收集并确认提交时，会进入 Web 后台队列并正常消耗对应 API/RunningHub 成本。
- 当前 TG 版本接入的是单任务生产流，不包含 Web 后台的批量 ZIP/目录批处理体验。

---

# 2026-05-24 生图工作流支持闭源模型阶段

## 目标
- 用户要求工作流链路中的阶段可以替换成闭源模型，而不是只能全部配置为 RunningHub 开源工作流。

## 改动
- `webapp/server.py`
  - 新增闭源图片模型阶段编码：`closed_image_model:<model>`。
  - 运行配置归一化支持旧的纯字符串数组，也支持对象形式：
    - `{ "type": "runninghub_workflow", "value": "190..." }`
    - `{ "type": "closed_image_model", "value": "gpt-image-1" }`
  - 生图执行链 `_run_image_generate_via_runninghub_workflow()` 支持混合步骤：
    - RunningHub 步骤继续上传上一阶段图片并执行 RunningHub workflow。
    - 闭源图片模型步骤调用当前闭源图片模型 API，输入为上一阶段图片，输出继续传给下一阶段。
  - 任务元数据会把闭源阶段展示为 `闭源图片模型:<model>`，并生成类似 `生图链 2 步（闭源模型 1 + RunningHub 1）` 的摘要。
- `webapp/static/assets/admin.js`
  - 生图链编辑器每一步新增类型下拉：
    - `RunningHub`
    - `闭源图片模型`
  - 保存时仍兼容旧字段，闭源步骤保存为 `closed_image_model:<model>`。
  - legacy `image_runninghub_workflow_id` 只从最后一个 RunningHub 步骤回填，避免闭源模型名被当成 RunningHub ID。
- `webapp/static/admin.html`
  - 生图工作流说明改为支持 RunningHub 和闭源图片模型混排。
- `webapp/static/assets/style.css`
  - 补充生图步骤类型下拉布局。
- `tests/test_workflow_chains.py`
  - 新增混合阶段归一化、任务摘要、闭源阶段无 RunningHub 调用的测试。

## 验证
- 本地：
  - `python -m compileall webapp/server.py tests/test_workflow_chains.py` 通过。
  - `node --check webapp/static/assets/admin.js` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`17 passed`）。
- 远端部署：
  - 备份时间戳：`20260524065510`
  - 已上传 `webapp/server.py`、`webapp/static/admin.html`、`webapp/static/assets/admin.js`、`webapp/static/assets/style.css`。
  - 远端 `./.venv/bin/python -m compileall webapp/server.py` 通过。
  - `systemctl restart digital-human-tg-bot.service` 成功。
  - `digital-human-tg-bot.service` 和 `digital-human-tg-bot-telegram.service` 均为 `active`。
- 远端无成本 smoke：
  - 直接调用远端 Python 归一化混合配置，返回 `['1900814586436534274', 'closed_image_model:gpt-image-1']`。
  - 任务元数据摘要返回 `生图链 2 步（闭源模型 1 + RunningHub 1）`。
- 线上浏览器验证：
  - `http://47.250.188.76/admin.html?ts=20260524mixed#admin-runtime`
  - 页面存在 `闭源图片模型` 下拉选项。
  - 浏览器内临时构造混合链，`runtimeFormToPayload()` 输出：
    - `image_generate_mode_default: runninghub_workflow`
    - `image_generate_workflow_ids: ['1900814586436534274', 'closed_image_model:gpt-image-1']`
    - `image_runninghub_workflow_id: '1900814586436534274'`
  - 未保存配置，未提交真实任务，未触发 RunningHub/API 成本。

---

# 2026-05-24 闭源阶段改为模型下拉选择

## 目标
- 用户指出选择 `闭源图片模型` 时，右侧不应该继续显示 RunningHub 工作流 ID 输入框，而应该显示可选择的模型。

## 改动
- `webapp/static/assets/admin.js`
  - 闭源图片模型阶段右侧改为模型下拉框。
  - 模型选项读取后台 `图片模型` 区域的 Gemini/GPT 候选模型。
  - 从 RunningHub 切换到闭源图片模型时，如果原值是数字工作流 ID，会自动替换为第一个图片候选模型，避免把工作流 ID 当模型名保存。
  - 保存 payload 继续使用执行层兼容格式：`closed_image_model:<model>`。
- `webapp/static/assets/style.css`
  - 增加闭源阶段模型下拉框样式。

## 验证
- 本地：
  - `node --check webapp/static/assets/admin.js` 通过。
  - `python -m compileall webapp/server.py tests/test_workflow_chains.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`20 passed`）。
- 远端部署：
  - 备份时间戳：`20260524071221`
  - 已上传 `webapp/static/assets/admin.js`、`webapp/static/assets/style.css`。
  - `digital-human-tg-bot.service` 和 `digital-human-tg-bot-telegram.service` 均为 `active`。
- 线上浏览器验证：
  - `http://47.250.188.76/admin.html?ts=20260524modelselect#admin-runtime`
  - 临时将 `商品替换工作流` 第一步切换为 `闭源图片模型`。
  - 右侧已变为模型下拉框，且不再显示 workflow ID 输入框。
  - `runtimeFormToPayload()` 输出：
    - `replace_product_workflow_ids[0]: closed_image_model:gemini-3-pro-image-preview`
  - 未保存配置，未提交真实任务，未触发 RunningHub/API 成本。

## 注意
- 当前混合闭源阶段已接入 `生图工作流`，因为闭源配置目前只有文字模型和图片模型；口播数字人、模特替换、商品替换这类音频/视频链仍保持 RunningHub 工作流阶段。

---

# 2026-05-24 替换类工作流支持闭源图片模型阶段

## 目标
- 用户要求动作迁移、人物替换、商品替换这些替换类工作流也可以调用闭源模型来解决图像问题。

## 执行原则
- 闭源图片模型只处理图片输入，不直接产出替换后视频。
- 替换类链路中的闭源阶段作为“参考图预处理阶段”执行：
  - 模特替换链：处理模特图。
  - 商品替换链：处理商品图。
  - 联合替换链：分别处理模特目录和商品目录。
- 视频输出仍由后续 RunningHub 视频工作流完成，因此每条替换链至少需要保留一个 RunningHub 视频工作流步骤。

## 改动
- `webapp/server.py`
  - 新增通用闭源图片处理 helper：
    - `_run_closed_image_model_transform`
    - `_split_workflow_chain_stages`
    - `_apply_closed_image_stages_to_file`
    - `_apply_closed_image_stages_to_dir`
  - `_run_replace_model()` 支持链路中包含 `closed_image_model:<model>`：
    - 先用闭源图片模型处理 `image_local_path` / `image_url`。
    - 再上传处理后的图片给后续 RunningHub 模特替换 workflow。
  - `_run_replace_product()` 同步支持商品图闭源预处理。
  - `_run_replace_product_and_model()` 支持联合替换目录级闭源预处理：
    - 若输入是 zip，会先展开到任务工作目录，再处理图片目录。
    - 闭源处理后的目录再交给 RunningHub 联合替换执行器。
  - 运行配置归一化和 runtime 默认值回填改为取最后一个 RunningHub 步骤，避免把闭源模型名写入 legacy `*_app_id`。
  - 任务摘要会显示：
    - `模特替换链 2 步（闭源图片 1 + RunningHub 1）`
    - `商品替换链 2 步（闭源图片 1 + RunningHub 1）`
    - `联合链 模特 N 步 + 商品 N 步（闭源图片 N）`
- `webapp/static/assets/admin.js`
  - 所有替换类链路步骤都支持选择：
    - `RunningHub`
    - `闭源图片模型`
  - 保存 payload 时，闭源步骤写为 `closed_image_model:<model>`，legacy app id 只回填最后一个 RunningHub 步骤。
- `webapp/static/admin.html`
  - 替换类工作流说明补充闭源图片模型阶段语义。
- `tests/test_workflow_chains.py`
  - 新增替换类混合链归一化、元数据摘要、模特替换闭源预处理无外部请求测试。

## 验证
- 本地：
  - `python -m compileall webapp/server.py tests/test_workflow_chains.py` 通过。
  - `node --check webapp/static/assets/admin.js` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`20 passed`）。
- 远端部署：
  - 备份时间戳：`20260524070344`
  - 已上传 `webapp/server.py`、`webapp/static/admin.html`、`webapp/static/assets/admin.js`、`webapp/static/assets/style.css`。
  - 远端 `./.venv/bin/python -m compileall webapp/server.py` 通过。
  - `systemctl restart digital-human-tg-bot.service` 成功。
  - `digital-human-tg-bot.service` 和 `digital-human-tg-bot-telegram.service` 均为 `active`。
- 远端无成本 smoke：
  - 模特替换混合链归一化为 `['closed_image_model:gpt-image-1', '1977634608437174274']`。
  - 商品替换混合链归一化为 `['closed_image_model:gpt-image-1', '1977410328592031746']`。
  - 元数据摘要分别返回闭源图片 + RunningHub 的混合链摘要。
- 线上浏览器验证：
  - `http://47.250.188.76/admin.html?ts=20260524replaceclosed#admin-runtime`
  - 模特替换基础、快速、片段、动作迁移、商品替换的步骤下拉均出现 `闭源图片模型`。
  - 浏览器内临时构造商品替换混合链，`runtimeFormToPayload()` 输出：
    - `replace_product_workflow_ids: ['1977410328592031746', 'closed_image_model:gpt-image-1']`
    - `replace_product_app_id: '1977410328592031746'`
  - 未保存配置，未提交真实任务，未触发 RunningHub/API 成本。

---

# 2026-05-24 TG Bot 生产工作流入口恢复

## 目标
- 用户指出图片生成、替换类工作流也是生产相关，不应从 TG 操作面板消失。

## 改动
- 修改 `src/digital_human_tg_bot/bot.py`。
- 面板保留所有生产工作流入口：
  - `口播數字人：上傳素材`
  - `口播數字人：預設素材`
  - `圖片生成工作流`
  - `聯合替換工作流`
  - `模特替換工作流`
  - `商品替換工作流`
  - `重跑最近任務`
  - `查看工作台狀態`
  - `強制停止目前任務`
- 仍不显示后台配置、设置文案、工作台网址这类管理项。
- 图片/替换类按钮当前只作为生产入口说明，不直接提交任务，避免 TG 误触发扣费。

## 部署与验证
- 远端备份：
  - `/opt/apps/digital-human-tg-bot/src/digital_human_tg_bot/bot.py.bak-20260524062635`
- 已上传并重启：
  - `digital-human-tg-bot-telegram.service`
- 验证：
  - 本地 `python -m compileall src/digital_human_tg_bot/bot.py run_tg_bot_only.py` 通过。
  - 远端 `./.venv/bin/python -m compileall src/digital_human_tg_bot/bot.py run_tg_bot_only.py` 通过。
  - `digital-human-tg-bot-telegram.service` 为 `active/running`。
  - `digital-human-tg-bot.service` 为 `active`。
  - 远端只读 smoke 菜单：
    - `口播數字人：上傳素材 | 口播數字人：預設素材`
    - `圖片生成工作流 | 聯合替換工作流`
    - `模特替換工作流 | 商品替換工作流`
    - `重跑最近任務 | 查看工作台狀態`
    - `強制停止目前任務`

## 注意
- 本次没有提交真实任务，没有调用 RunningHub/API。

---

# 2026-05-24 模型候选项恢复与防丢草稿

## 目标
- 用户反馈刚添加的模型候选项被移除，要求恢复：
  - 图像模型：`gpt-image-2`、`gemini-3.1-flash-image-preview`
  - 文字模型：`gpt-5.5`、`gemini-3-flash-preview`

## 处理
- 远端运行配置已写入两个实际读取路径：
  - `/opt/apps/digital-human-tg-bot/webapp_data/runtime_config.json`
  - `/opt/apps/digital-human-tg-bot/runtime/runtime_config.json`
- 备份：
  - `/opt/apps/digital-human-tg-bot/webapp_data/runtime_config.json.bak-models-20260524072002`
  - `/opt/apps/digital-human-tg-bot/runtime/runtime_config.json.bak-models-20260524072002`
- 当前候选模型：
  - `llm_default_model_gemini`: `gemini-3.1-pro-preview, gemini-3-flash-preview`
  - `llm_default_model_gpt`: `gpt-5.5`
  - `image_model_default_model_gemini`: `gemini-3-pro-image-preview, gemini-3.1-flash-image-preview`
  - `image_model_default_model_gpt`: `gpt-image-2`
- 前端新增浏览器本地草稿保护：
  - 添加或删除候选模型时写入 `localStorage` 草稿。
  - 后台配置加载后会合并未保存草稿。
  - 成功保存运行配置后清除草稿。

## 验证
- 本地：
  - `node --check webapp/static/assets/admin.js` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`20 passed`）。
- 远端：
  - 两个 runtime config 文件均已确认包含上述四个模型。
  - 浏览器实测 `http://47.250.188.76/admin.html?ts=20260524models#admin-runtime`：
    - 页面可见 `gpt-image-2`。
    - 页面可见 `gemini-3.1-flash-image-preview`。
    - 页面可见 `gpt-5.5`。
    - 页面可见 `gemini-3-flash-preview`。
    - `runtimeFormToPayload()` 输出的 Gemini/GPT 拆分字段正确。
- 未提交真实任务，未调用 RunningHub 或闭源模型 API。

---

# 2026-05-24 口播数字人工作流支持闭源模型阶段

## 目标
- 用户要求 `口播数字人工作流` 也可以把步骤替换为闭源模型。

## 改动
- `webapp/server.py`
  - 新增闭源文字模型阶段编码：`closed_llm_model:<model>`。
  - 口播链支持：
    - `RunningHub`
    - `closed_llm_model:<model>`
    - `closed_image_model:<model>`
  - 运行配置归一化时，`create_audio_app_id` / `create_video_app_id` 只从 RunningHub 步骤回填，避免把模型名写入旧字段。
  - 任务元数据展示：
    - `闭源文字模型:<model>`
    - `闭源图片模型:<model>`
    - `口播链 4 步（闭源文字 1 + 闭源图片 1 + RunningHub 2）`
  - 执行层：
    - 闭源文字模型步骤用于指定自动文案/提示词生成模型。
    - 闭源图片模型步骤用于指定口播场景图生成模型。
    - RunningHub 步骤仍负责音频与最终视频输出。
- `webapp/static/assets/admin.js`
  - `口播数字人工作流` 步骤类型新增：
    - `RunningHub`
    - `闭源文字模型`
    - `闭源图片模型`
  - 选择闭源文字模型时，右侧显示文字模型候选下拉。
  - 选择闭源图片模型时，右侧显示图片模型候选下拉。
  - 保存 payload 使用 `closed_llm_model:<model>` / `closed_image_model:<model>`。
- `webapp/static/admin.html`
  - 更新口播链说明，明确可混排闭源文字模型和闭源图片模型。

## 验证
- 本地：
  - `python -m compileall webapp/server.py tests/test_workflow_chains.py` 通过。
  - `node --check webapp/static/assets/admin.js` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`23 passed`）。
- 远端：
  - 已上传 `webapp/server.py`、`webapp/static/admin.html`、`webapp/static/assets/admin.js`、`tests/test_workflow_chains.py`。
  - 远端 `./.venv/bin/python -m compileall webapp/server.py tests/test_workflow_chains.py` 通过。
  - `digital-human-tg-bot.service` 为 `active`。
  - `digital-human-tg-bot-telegram.service` 为 `active`。
  - 远端无成本 smoke：
    - 口播链归一化为 `['closed_llm_model:gpt-5.5', '1001', 'closed_image_model:gpt-image-2', '1002']`。
    - legacy audio/video ID 回填为 `1001` / `1002`。
    - 元数据摘要为 `口播链 4 步（闭源文字 1 + 闭源图片 1 + RunningHub 2）`。
  - 浏览器实测 `http://47.250.188.76/admin.html?ts=20260524oralclosed#admin-runtime`：
    - 口播链步骤类型已出现 `闭源文字模型` 和 `闭源图片模型`。
    - 临时切换口播步骤时，payload 可输出 `closed_llm_model:gpt-5.5` 和 `closed_image_model:gpt-image-2`。
- 未保存临时页面配置，未提交真实任务，未调用 RunningHub 或闭源模型 API。

---

# 2026-05-24 移除三项模特替换变体配置

## 目标
- 用户要求移除截图中标记的三个工作流配置：
  - `模特替换·快速模式`
  - `模特替换·片段替换`
  - `模特替换·动作迁移`

## 改动
- `webapp/static/admin.html`
  - 从系统配置页删除上述三个工作流编辑器。
- `webapp/static/assets/admin.js`
  - 从 `WORKFLOW_CHAIN_META` 删除三个链路。
  - 保存运行配置时不再提交：
    - `replace_model_primary_workflow_ids`
    - `replace_model_slice_workflow_ids`
    - `replace_model_motion_transfer_workflow_ids`
    - 对应的 `*_app_id`
  - 读取配置时不再初始化对应表单状态。
- `webapp/server.py`
  - 从 `DEFAULT_RUNTIME_CONFIG` 和 `RuntimeConfigPayload` 移除三类配置字段。
  - `_normalize_runtime_config()` 不再把旧 runtime config 中的三类字段归一化回写。
  - 保留执行层兼容兜底，避免旧任务显式传入旧 mode 时直接失败。
- `tests/test_workflow_chains.py`
  - 新增测试确认旧配置里即使包含这些字段，归一化后也会被剔除。

## 验证
- 本地：
  - `node --check webapp/static/assets/admin.js` 通过。
  - `python -m compileall webapp/server.py tests/test_workflow_chains.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`24 passed`）。
- 远端：
  - 已上传 `webapp/server.py`、`webapp/static/admin.html`、`webapp/static/assets/admin.js`、`tests/test_workflow_chains.py`。
  - 远端 `./.venv/bin/python -m compileall webapp/server.py tests/test_workflow_chains.py` 通过。
  - `digital-human-tg-bot.service` 为 `active`。
  - `digital-human-tg-bot-telegram.service` 为 `active`。
  - 远端无成本 smoke：
    - 旧字段归一化后 `deprecated_keys=[]`。
    - `模特替换·基础模式` 和 `商品替换工作流` 保留。
  - 浏览器实测 `http://47.250.188.76/admin.html?ts=20260524removevariants#admin-runtime`：
    - `模特替换·快速模式` 不可见。
    - `模特替换·片段替换` 不可见。
    - `模特替换·动作迁移` 不可见。
    - 对应 DOM 容器不存在。
    - `runtimeFormToPayload()` 不再包含对应 key。
- 未保存临时页面配置，未提交真实任务，未调用 RunningHub 或闭源模型 API。

---

# 2026-05-24 口播数字人当前 RunningHub 工作流适配

## 目标
- 用户已将口播数字人工作流 ID 更换为：
  - 音频工作流：`1965684535247650818`
  - 视频工作流：`2031016553440878594`
- 需要让当前执行层和服务器配置适配新 ID。

## 改动
- `create_audio.py`
  - 默认音频工作流 ID 改为 `1965684535247650818`。
- `create_video.py`
  - 默认视频工作流 ID 改为 `2031016553440878594`。
  - 新视频工作流明确复用当前数字人口播视频节点映射：
    - image: `42`
    - audio: `17`
    - duration: `248`
    - prompt: `7`
    - width/height: `33` / `34`
  - `2031016553440878594` 不再走未知工作流分支，也不会附加旧运镜节点 `53`。
  - 旧 `2018758760096862209` 仍保留兼容。
- `runtime_config_bootstrap.py`、`runtime_config.example.json`、`dist/WorkflowDesktop/_internal/runtime_config.example.json`
  - 默认口播音频/视频 ID 同步为新 ID。
- `webapp_data/runtime_config.json`、`webapp_data_qa/runtime_config.json`、`webapp_data_qa_run/runtime_config.json`
  - 本地运行配置同步新口播 ID。
- `src/digital_human_tg_bot/config.py`、`src/digital_human_tg_bot/workflow.py`
  - TG worker 默认口播视频 ID 同步为 `2031016553440878594`。
  - TG 旧 workflow 执行器也把 `2031016553440878594` 归到当前数字人口播视频节点映射。
- `webapp/tests/test_create_video_node_mapping.py`
  - 新增测试覆盖 `2031016553440878594` 的节点映射。

## 远端处理
- 已上传：
  - `create_audio.py`
  - `create_video.py`
  - `runtime_config_bootstrap.py`
  - `runtime_config.example.json`
  - `src/digital_human_tg_bot/config.py`
  - `src/digital_human_tg_bot/workflow.py`
  - `webapp/tests/test_create_video_node_mapping.py`
- 已结构化更新远端两个 runtime 配置文件，保留 API Key 和其他工作流配置，仅替换口播链字段：
  - `/opt/apps/digital-human-tg-bot/webapp_data/runtime_config.json`
  - `/opt/apps/digital-human-tg-bot/runtime/runtime_config.json`
- 当前远端配置：
  - `oral_digital_human_workflow_ids`: `['1965684535247650818', '2031016553440878594']`
  - `create_audio_app_id`: `1965684535247650818`
  - `create_video_app_id`: `2031016553440878594`
  - `video_app_id`: `2031016553440878594`
- 已重启：
  - `digital-human-tg-bot.service`
  - `digital-human-tg-bot-telegram.service`

## 验证
- 本地：
  - `python -m compileall create_audio.py create_video.py runtime_config_bootstrap.py src/digital_human_tg_bot/config.py src/digital_human_tg_bot/workflow.py webapp/server.py webapp/tests/test_create_video_node_mapping.py` 通过。
  - `python -m pytest webapp/tests/test_create_video_node_mapping.py tests/test_workflow_chains.py -q` 通过（`28 passed`）。
- 远端：
  - 远端 `compileall` 通过。
  - `digital-human-tg-bot.service` 为 `active`。
  - `digital-human-tg-bot-telegram.service` 为 `active`。
  - 远端只读 smoke：
    - `create_audio.DEFAULT_APP_ID == 1965684535247650818`
    - `create_video.DEFAULT_APP_ID == 2031016553440878594`
    - `create_video._build_node_info_list(app_id='2031016553440878594')` 返回节点 `['42', '17', '248', '7', '33', '34']`
    - 不包含旧运镜节点 `53`
  - 浏览器实测 `http://47.250.188.76/admin.html?ts=20260524oralcurrent#admin-runtime`：
    - `/api/admin/runtime_config` 返回新口播链。
    - 口播表单输入值为 `1965684535247650818` 和 `2031016553440878594`。
    - `runtimeFormToPayload()` 输出新口播链和 legacy 音视频 ID。
- 未提交真实任务，未调用 RunningHub/API。

---

# 2026-05-24 生图工作流更名为图像编辑工作流

## 目标
- 用户要求把后台里的 `生图工作流` 更名为 `图像编辑工作流`。
- 同步处理 TG 菜单和任务摘要里的旧入口文案。

## 改动
- 保留内部 `image_generate_*` 配置字段名，避免破坏历史配置和任务兼容性。
- `webapp/static/admin.html`
  - 后台系统配置链路标题改为 `图像编辑工作流`。
- `src/digital_human_tg_bot/bot.py`
  - TG 菜单按钮、配置回显和上传提示改为 `圖像編輯工作流`。
- `webapp/server.py`
  - 任务元数据摘要、RunningHub/闭源模型错误提示改为 `图像编辑链` / `图像编辑`。
- `tests/test_workflow_chains.py`
  - 同步更新任务元数据断言。

## 验证
- 本地：
  - `python -m compileall webapp/server.py src/digital_human_tg_bot/bot.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`24 passed`）。
  - `rg` 确认 `webapp`、`src`、`tests` 内旧入口文案无残留。
- 远端：
  - 已上传到 `/opt/apps/digital-human-tg-bot`。
  - 远端 `compileall` 通过。
  - `digital-human-tg-bot.service` 为 `active`。
  - `digital-human-tg-bot-telegram.service` 为 `active`。
  - `grep` 确认后台和 TG 源码包含新名称。
  - 浏览器访问 `http://47.250.188.76/admin.html?ts=20260524rename-image-edit#admin-runtime`，页面显示 `图像编辑工作流`，且不包含旧的 `生图工作流` / `图片生成工作流`。
- 未提交真实任务，未调用 RunningHub/API 或闭源模型 API。

---

# 2026-05-24 TG Bot 控制台面板同步更新

## 目标
- 用户要求同步更新 TG Bot 的控制台面板，使其与后台 `图像编辑工作流` 命名和当前生产入口一致。

## 改动
- `src/digital_human_tg_bot/bot.py`
  - 新 TG 面板按钮继续显示 `圖像編輯工作流`。
  - 保留旧按钮 `圖片生成工作流` 为隐藏兼容别名，避免用户聊天里旧键盘按钮点击失效。
  - `/start` / 入口说明改为当前实际可直接提交的生产工作流：
    - 口播数字人
    - 图像编辑
    - 模特替换
    - 商品替换
    - 联合替换
  - `查看後台工作流配置` 不再提示“只开放口播数字人直接提交”，改为说明 TG 面板可直接建立生产任务。
  - 配置回显移除已从后台配置页移除的模特替换子项，只保留 `模特替換工作流`、`商品替換工作流`、联合链。
  - 图像编辑提交失败提示从 `圖片生成任務提交失敗` 改为 `圖像編輯任務提交失敗`。

## 验证
- 本地：
  - `python -m compileall src/digital_human_tg_bot/bot.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`24 passed`）。
- 远端：
  - 已上传到 `/opt/apps/digital-human-tg-bot/src/digital_human_tg_bot/bot.py`。
  - 远端 `compileall` 通过。
  - 已重启 `digital-human-tg-bot-telegram.service`，状态为 `active`。
  - 已向远端启用的可信 TG 用户推送一次新控制台面板，发送成功 2 个，失败 0 个。
  - 远端 grep 确认旧的“只开放口播”“Web 工作台提交”“图片生成任务失败”和已移除模特替换子项提示无残留。
- 本次没有创建生产任务，也没有触发 RunningHub/API 或闭源模型 API。

---

# 2026-05-24 闭源模型优先级顺序与失败自动降级

## 目标
- 在设置页新增“闭源模型优先级调用顺序”配置。
- 执行层按优先级依次调用模型，前一模型失败时自动降级到下一个候选。

## 改动
- `webapp/static/admin.html`
  - 在“文字模型 / 图片模型”区新增“优先级调用顺序（失败自动降级）”编辑器。
- `webapp/static/assets/admin.js`
  - 新增 `llmPriorityModels`、`imagePriorityModels` 状态与草稿持久化。
  - 新增优先级列表渲染（支持上移/下移/删除/添加）。
  - 保存配置时新增：
    - `llm_model_priority_order`
    - `image_model_priority_order`
  - 读取配置时恢复优先级顺序，并与候选模型池自动同步。
- `webapp/static/assets/style.css`
  - 新增优先级列表和排序按钮样式。
- `webapp/server.py`
  - 默认配置、Pydantic payload、运行时补全增加：
    - `llm_model_priority_order`
    - `image_model_priority_order`
  - 新增候选解析与回退工具函数：
    - `_resolve_llm_fallback_candidates`
    - `_resolve_closed_image_model_fallback_candidates`
    - `_request_llm_json_with_fallback`
    - `_generate_closed_image_with_fallback`
  - 关键执行链路切换为回退调用：
    - 口播文案生成（LLM）
    - 图像编辑闭源调用（含链路阶段）
    - 闭源图像编辑任务入口
- `image_model_api.py`
  - `generate_image` 支持逗号/换行分隔的候选模型顺序，失败自动降级并记录 attempts。
- `runtime_config_bootstrap.py`、`runtime_config.example.json`
  - 补齐闭源 Gemini/GPT 分离字段与优先级字段默认值。
- `tests/test_workflow_chains.py`
  - 新增优先级归一化与 LLM/图片模型回退单测。
  - 更新一处口播闭源链 mock 返回结构，兼容新的 `ok=True` 判定。

## 验证
- `python -m compileall webapp/server.py image_model_api.py runtime_config_bootstrap.py` 通过。
- `node --check webapp/static/assets/admin.js` 通过。
- `python -m pytest tests/test_workflow_chains.py -q` 通过（`28 passed`）。
- 说明：`webapp/tests/test_runtime_config.py` 仍有存量失败（旧字段断言与当前代码长期不一致），本次未扩散该问题，也未触发真实生产任务或真实 API 计费请求。

## 远端部署
- 已上传到 `/opt/apps/digital-human-tg-bot`：
  - `webapp/server.py`
  - `webapp/static/admin.html`
  - `webapp/static/assets/admin.js`
  - `webapp/static/assets/style.css`
  - `image_model_api.py`
  - `runtime_config_bootstrap.py`
  - `runtime_config.example.json`
  - `tests/test_workflow_chains.py`
- 已备份远端被覆盖文件到 `.deploy_backups/<timestamp>/`。
- 已增量更新远端两个运行配置文件，只补充：
  - `llm_model_priority_order`
  - `image_model_priority_order`
- 保留了现有 API Key、候选模型、工作流链路。
- 远端配置当前解析结果：
  - 文字模型顺序：`gemini-3.1-pro-preview, gemini-3-flash-preview, gpt-5.5, gpt-4.1`
  - 图片模型顺序：`gemini-3-pro-image-preview, gemini-3.1-flash-image-preview, gpt-image-2, gpt-image-1`
- 远端 `.venv/bin/python -m compileall webapp/server.py image_model_api.py runtime_config_bootstrap.py` 通过。
- 已重启：
  - `digital-human-tg-bot.service` active
  - `digital-human-tg-bot-telegram.service` active
- 远端最近 5 分钟 systemd warning/error 日志为空。
- 公网静态页面检查 `http://47.250.188.76/admin.html?ts=20260524priority#admin-runtime`：
  - HTTP 200
  - 包含 `rtLlmPriorityModelList`
  - 包含 `rtImagePriorityModelList`
  - 包含 `优先级调用顺序`
- 本次没有创建生产任务，也没有触发 RunningHub/API 或闭源模型 API。

---

# 2026-05-24 视频模特替换 / 视频商品替换命名同步

## 目标
- 用户要求把后台配置中的两个工作流分别改名为：
  - `视频模特替换`
  - `视频商品替换`
- 同步更新 TG Bot 控制台面板。

## 改动
- `webapp/static/admin.html`
  - `模特替换·基础模式` -> `视频模特替换`
  - `商品替换工作流` -> `视频商品替换`
- `src/digital_human_tg_bot/bot.py`
  - TG 面板按钮改为 `視頻模特替換`、`視頻商品替換`。
  - `/start`、后台工作流配置回显、步骤提示、失败提示同步新名称。
  - 保留旧按钮 `模特替換工作流`、`商品替換工作流` 为隐藏兼容别名，避免旧聊天键盘点击失效。
- `webapp/server.py`
  - 任务类型显示名、执行链摘要、执行追踪标题、阶段日志和错误提示同步为 `视频模特替换` / `视频商品替换`。
- `tests/test_workflow_chains.py`
  - 同步更新任务摘要和执行追踪断言。

## 验证
- 本地：
  - `python -m compileall webapp/server.py src/digital_human_tg_bot/bot.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`24 passed`）。
- 远端：
  - 已上传并重启：
    - `digital-human-tg-bot.service` active
    - `digital-human-tg-bot-telegram.service` active
  - 远端 `compileall` 通过。
  - 已向 2 个启用的可信 TG 用户推送新控制台面板，失败 0 个。
  - 浏览器访问 `http://47.250.188.76/admin.html?ts=20260524video-replace-names#admin-runtime`：
    - 显示 `视频模特替换` 和 `视频商品替换`。
    - 不再显示 `模特替换·基础模式` 和 `商品替换工作流`。
- 本次没有创建生产任务，也没有触发 RunningHub/API 或闭源模型 API。

---

# 2026-05-24 联合替换工作流独立配置

## 目标
- 用户要求把 `联合替换工作流` 在开源模型配置中单独列成一个可配置工作流。

## 改动
- 新增运行配置字段：
  - `replace_union_model_workflow_ids`
  - `replace_union_product_workflow_ids`
- `webapp/static/admin.html`
  - 在开源模型配置的替换类工作流中新增 `联合替换工作流` 区块。
  - 区块内单独配置：
    - `联合替换·视频模特链`
    - `联合替换·视频商品链`
- `webapp/static/assets/admin.js`
  - 新增两个链路编辑器，支持 RunningHub 与闭源图片模型混排。
  - 保存运行配置时写入新的联合替换链字段。
  - 加载配置时从新字段恢复；没有新字段时回退到视频模特替换/视频商品替换链。
- `webapp/server.py`
  - 默认配置、运行配置规范化、Pydantic payload 增加新字段。
  - `replace_productANDmodel` 执行层优先读取独立联合替换链；未配置时再回退到原视频模特/视频商品链。
- `src/digital_human_tg_bot/bot.py`
  - `查看後台工作流配置` 展示独立的联合替换视频模特链和视频商品链。
- `runtime_config_bootstrap.py`、`runtime_config.example.json`、`webapp_data/runtime_config.json`
  - 补充新字段默认值。
- `tests/test_workflow_chains.py`
  - 新增测试覆盖联合替换执行层优先读取独立链。

## 验证
- 本地：
  - `python -m compileall webapp/server.py src/digital_human_tg_bot/bot.py runtime_config_bootstrap.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`25 passed`）。
- 远端：
  - 已上传到 `/opt/apps/digital-human-tg-bot`。
  - 已给远端两个 runtime 配置文件补充独立联合替换字段，初始值沿用当前视频模特/视频商品链。
  - 远端 `compileall` 通过。
  - `digital-human-tg-bot.service` 为 `active`。
  - `digital-human-tg-bot-telegram.service` 为 `active`。
  - 浏览器访问 `http://47.250.188.76/admin.html?ts=20260524union-chain-config#admin-runtime`：
    - 页面显示 `联合替换工作流`。
    - 页面显示 `联合替换·视频模特链`、`联合替换·视频商品链`。
    - `/api/admin/runtime_config` 返回新字段。
    - `runtimeFormToPayload()` 输出新字段和值。
  - 远端只读 smoke 使用项目 `.venv` 验证 `replace_productANDmodel` 默认值优先读取：
    - `replace_union_model_workflow_ids`
    - `replace_union_product_workflow_ids`
  - 已向 2 个启用的可信 TG 用户推送控制台面板更新提示，失败 0 个。
- 本次没有创建生产任务，也没有触发 RunningHub/API 或闭源模型 API。

---

# 2026-05-24 TG Bot 启用文字模型理解与提示词生成

## 目标
- TG Bot 的会话不再只依赖固定按钮和手填提示词。
- 用户在 TG 上的自然语言消息由后台已配置的文字模型理解，并生成对应工作流提示词。
- 明确按钮流程中的提示词字段也统一交给文字模型生成或润色。

## 改动
- `webapp/server.py`
  - 新增 TG 提示词增强函数：`_enhance_tg_payload_with_llm_prompt()`。
  - TG 内部提交的这些任务会在入队前按 `llm_model_priority_order` 调用文字模型生成/润色提示词：
    - `create_video / commerce_video`
    - `image_generate`
    - `replace_model`
    - `replace_product`
    - `replace_productANDmodel`
    - `get_nano_banana`
  - `_build_agent_task_payload()` 改用 `_request_llm_json_with_fallback()`，自然语言规划会按后台文字模型优先级失败自动降级。
  - 新增 `/api/internal/tg/agent_submit`，供 TG Bot 提交“自然语言 + 附件”的智能生产入口。
  - `create_audio / get_nano_banana / get_gemini` 补齐 TG 内部提交兼容校验。
- `src/digital_human_tg_bot/bot.py`
  - `_message_text()` 支持读取 caption。
  - 新增自然语言兜底 handler：用户直接发文字或带 caption 的素材时，Bot 会把消息和附件提交给后台智能入口。
  - 显式工作流流程提交时增加 `tg_use_llm_prompt` / `tg_user_instruction`，让后台文字模型生成提示词：
    - 口播数字人
    - 图像编辑
    - 视频模特替换
    - 视频商品替换
    - 联合替换
  - `/start` 和上线通知补充自然语言交互说明。
- `tests/test_workflow_chains.py`
  - 新增 2 条零成本测试，覆盖 TG 提示词生成和自然语言规划。

## 验证
- 本地：
  - `python -m compileall webapp/server.py src/digital_human_tg_bot/bot.py tests/test_workflow_chains.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`30 passed`）。
- 远端：
  - 已上传 `webapp/server.py`、`src/digital_human_tg_bot/bot.py`、`tests/test_workflow_chains.py` 到 `/opt/apps/digital-human-tg-bot`。
  - 远端 `./.venv/bin/python -m compileall ...` 通过。
  - 已重启：
    - `digital-human-tg-bot.service` active
    - `digital-human-tg-bot-telegram.service` active
  - 远端 zero-cost smoke：mock 掉 `get_gemini.request_gemini3_pro_json` 后验证：
    - `_enhance_tg_payload_with_llm_prompt('replace_product', ...)` 生成 `prompt_text`。
    - `_build_agent_task_payload(...)` 识别为 `replace_product` 并生成 `prompt_text`。
    - 调用模型名来自远端配置优先级首项 `gemini-3.1-pro-preview`。
  - 最近 3 分钟 systemd warning 日志为空。
- 本次没有创建真实生产任务，没有触发 RunningHub/API 或闭源模型真实请求。

---

# 2026-05-24 TG Bot 视频编辑二级菜单

## 目标
- 主菜单不再直接展示三个视频替换工作流。
- 将 `视频商品替换`、`视频模特替换`、`联合替换工作流` 收进 `视频编辑` 二级菜单。
- `图像编辑工作流` 在 TG 面板更名为 `图片编辑`。

## 改动
- `src/digital_human_tg_bot/bot.py`
  - 主菜单调整为：
    - `口播數字人：上傳素材` / `口播數字人：預設素材`
    - `圖片編輯` / `視頻編輯`
    - `重跑最近任務` / `查看工作台狀態`
    - `強制停止目前任務`
  - 新增 `_video_edit_keyboard()` 二级菜单：
    - `視頻商品替換`
    - `視頻模特替換`
    - `聯合替換工作流`
    - `返回主菜單`
  - 新增 `視頻編輯` 和 `返回主菜單` 按钮处理。
  - 保留旧按钮 `圖像編輯工作流`、`圖片生成工作流`、`模特替換工作流`、`商品替換工作流` 的隐藏兼容。
  - TG 说明文案同步为 `圖片編輯` / `視頻編輯`。

## 验证
- 本地：
  - `python -m compileall src/digital_human_tg_bot/bot.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`30 passed`）。
- 远端：
  - 已上传 `src/digital_human_tg_bot/bot.py`。
  - 远端 `compileall` 通过。
  - 已重启 `digital-human-tg-bot-telegram.service`，Web 和 TG worker 均为 `active`。
  - 远端只读 smoke 确认：
    - 主菜单为 `[['口播數字人：上傳素材', '口播數字人：預設素材'], ['圖片編輯', '視頻編輯'], ['重跑最近任務', '查看工作台狀態'], ['強制停止目前任務']]`
    - 视频二级菜单为 `[['視頻商品替換', '視頻模特替換'], ['聯合替換工作流'], ['返回主菜單', '查看工作台狀態']]`
  - 最近 2 分钟 TG service warning 日志为空。
  - 已向 2 个启用的可信 TG 用户推送新控制台面板，失败 0 个。
- 本次没有创建生产任务，没有触发 RunningHub 或闭源模型生产请求。

---

# 2026-05-24 TG Bot 数字人入口合并

## 目标
- 将 TG 主菜单顶部 `口播數字人：上傳素材` / `口播數字人：預設素材` 两个按钮合并为一个按钮：`數字人視頻生成`。

## 改动
- `src/digital_human_tg_bot/bot.py`
  - 新主菜单顶部仅显示 `數字人視頻生成`。
  - 点击 `數字人視頻生成` 进入原上传素材数字人视频生成流程。
  - 旧按钮 `口播數字人：上傳素材`、`口播數字人：預設素材`、`上傳素材建立任務`、`預設素材建立任務` 继续作为隐藏兼容入口或命令兼容，不再显示在面板。
  - `/start` 和上线通知文案同步更新。

## 验证
- 本地：
  - `python -m compileall src/digital_human_tg_bot/bot.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`30 passed`）。
- 远端：
  - 已上传 `src/digital_human_tg_bot/bot.py`。
  - 远端 `compileall` 通过。
  - 已重启 `digital-human-tg-bot-telegram.service`；Web 和 TG worker 均为 `active`。
  - 远端只读 smoke 确认主菜单为：
    - `[['數字人視頻生成'], ['圖片編輯', '視頻編輯'], ['重跑最近任務', '查看工作台狀態'], ['強制停止目前任務']]`
  - 视频二级菜单保持：
    - `[['視頻商品替換', '視頻模特替換'], ['聯合替換工作流'], ['返回主菜單', '查看工作台狀態']]`
  - 最近 2 分钟 TG service warning 日志为空。
  - 已向 2 个启用的可信 TG 用户推送新版面板，失败 0 个。
- 本次没有创建生产任务，没有触发 RunningHub 或闭源模型生产请求。

---

# 2026-05-24 TG Bot 视频编辑菜单移除状态按钮

## 目标
- 视频编辑二级菜单内不再显示 `查看工作台狀態`。

## 改动
- `src/digital_human_tg_bot/bot.py`
  - `_video_edit_keyboard()` 底部从 `返回主菜單 / 查看工作台狀態` 改为只显示 `返回主菜單`。

## 验证
- 本地：
  - `python -m compileall src/digital_human_tg_bot/bot.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`30 passed`）。
- 远端：
  - 已上传 `src/digital_human_tg_bot/bot.py`。
  - 远端 `compileall` 通过。
  - 已重启 `digital-human-tg-bot-telegram.service`；Web 和 TG worker 均为 `active`。
  - 远端只读 smoke 确认视频二级菜单为：
    - `[['視頻商品替換', '視頻模特替換'], ['聯合替換工作流'], ['返回主菜單']]`
  - 最近 2 分钟 TG service warning 日志为空。
  - 已向 2 个启用的可信 TG 用户推送新版视频编辑子菜单，失败 0 个。
- 本次没有创建生产任务，没有触发 RunningHub 或闭源模型生产请求。

---

# 2026-05-24 TG Bot 移除预设素材功能

## 目标
- 移除无用的 `口播數字人：預設素材` 功能。

## 改动
- `src/digital_human_tg_bot/bot.py`
  - 删除 `ORAL_DEFAULT_BUTTON` / `LEGACY_DEFAULT_BUTTON`。
  - 删除 `submit_oral_default_task()`。
  - 删除隐藏按钮 `口播數字人：預設素材` / `預設素材建立任務` 的任务提交 handler。
  - `/run` 不再提交预设素材任务，只提示该功能已移除并引导使用 `數字人視頻生成`，避免旧命令误触发生产任务。

## 验证
- 本地：
  - `python -m compileall src/digital_human_tg_bot/bot.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`30 passed`）。
  - `rg` 确认 `ORAL_DEFAULT_BUTTON`、`LEGACY_DEFAULT_BUTTON`、`submit_oral_default_task`、`預設素材建立任務`、`預設口播任務提交` 无残留。
- 远端：
  - 已上传 `src/digital_human_tg_bot/bot.py`。
  - 远端 `compileall` 通过。
  - 已重启 `digital-human-tg-bot-telegram.service`；Web 和 TG worker 均为 `active`。
  - 远端 grep 确认预设素材提交入口无残留。
  - 远端只读 smoke 确认主菜单为：
    - `[['數字人視頻生成'], ['圖片編輯', '視頻編輯'], ['重跑最近任務', '查看工作台狀態'], ['強制停止目前任務']]`
  - 最近 2 分钟 TG service warning 日志为空。
  - 已向 2 个启用的可信 TG 用户推送新版主菜单，失败 0 个。
- 本次没有创建生产任务，没有触发 RunningHub 或闭源模型生产请求。

---

# 2026-05-24 TG Bot 视频编辑菜单行布局调整

## 目标
- 将视频编辑二级菜单里的 `聯合替換工作流` 和 `返回主菜單` 放在同一排。

## 改动
- `src/digital_human_tg_bot/bot.py`
  - `_video_edit_keyboard()` 调整为两行：
    - `視頻商品替換` / `視頻模特替換`
    - `聯合替換工作流` / `返回主菜單`

## 验证
- 本地：
  - `python -m compileall src/digital_human_tg_bot/bot.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`30 passed`）。
- 远端：
  - 已上传 `src/digital_human_tg_bot/bot.py`。
  - 远端 `compileall` 通过。
  - 已重启 `digital-human-tg-bot-telegram.service`；Web 和 TG worker 均为 `active`。
  - 远端只读 smoke 确认视频二级菜单为：
    - `[['視頻商品替換', '視頻模特替換'], ['聯合替換工作流', '返回主菜單']]`
  - 最近 2 分钟 TG service warning 日志为空。
  - 已向 2 个启用的可信 TG 用户推送新版视频编辑子菜单，失败 0 个。
- 本次没有创建生产任务，没有触发 RunningHub 或闭源模型生产请求。

---

# 2026-05-24 TG Bot 直接对话误建任务修复

## 目标
- 修复 TG 直接发送 `你好` 等普通会话时，被文字模型规划为 `get_gemini` 并创建后台任务的问题。

## 根因
- Telegram catch-all 自然语言入口会把所有文字/附件转发到 `/api/internal/tg/agent_submit`。
- 后台 `_build_agent_task_payload()` 的规划提示词允许 `get_gemini`、`create_audio`、`get_nano_banana` 这类非生产入口，导致问候语也可能被排成分析任务并入队。
- TG 端 `_submit_internal_webapp_agent_task()` 强制要求后台返回任务 ID，不能表达“这只是普通回复，不创建任务”。

## 改动
- `webapp/server.py`
  - 为 `_build_agent_task_payload()` 增加 `production_only=True` 模式。
  - TG 内部智能提交只允许生产任务：`create_video`、`image_generate`、`replace_model`、`replace_product`、`replace_productANDmodel`。
  - 问候、闲聊、需求不完整、纯分析或旧模型入口会返回 `submitted: false` + `reply`，不会 `_enqueue_task()`。
  - TG 直接对话支持将图片编辑规划为 `image_generate`，不再走旧 `get_nano_banana`。
- `src/digital_human_tg_bot/bot.py`
  - 接受后台 `submitted: false` 响应并直接回复引导文本。
  - 只有真正创建生产任务时才展示工作流和任务编号。
- `tests/test_workflow_chains.py`
  - 增加测试覆盖：问候返回 chat、不接受 `get_gemini` 入队、图片编辑仍能规划为 `image_generate`。

## 验证
- 本地：
  - `python -m compileall webapp/server.py src/digital_human_tg_bot/bot.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`33 passed`）。
  - 本地 mock 确认 `你好` + `production_only=True` 返回 `('chat', {'reply': ...}, '用户只是问候')`。
- 远端：
  - 已备份并上传 `webapp/server.py`、`src/digital_human_tg_bot/bot.py` 到 `/opt/apps/digital-human-tg-bot`。
  - 远端 `.venv` 编译通过。
  - 已重启 `digital-human-tg-bot.service` 和 `digital-human-tg-bot-telegram.service`，两个服务均为 `active`。
  - 最近 2 分钟服务 warning 日志为空。
  - 使用远端 `.venv/bin/python` mock 检查确认：`你好` 返回 `chat`，不会生成任务 payload。
- 本次没有创建生产任务，没有触发 RunningHub 或闭源模型生产请求。

---

# 2026-05-24 TG Bot 工作流 Skill 调度约束

## 目标
- 正常对话仍可调动工作流，但文字模型职责限定为“引导用户使用工作流”和“素材齐全时创建工作流任务”。
- 将每个生产工作流写成内部 workflow skill，避免模型自由发挥或选择未授权任务。

## 改动
- `webapp/server.py`
  - 新增 `TG_AGENT_WORKFLOW_SKILLS`，定义 5 个可用技能：
    - `digital_human_video` -> `create_video`（数字人视频生成）
    - `image_edit` -> `image_generate`（图片编辑）
    - `video_model_replace` -> `replace_model`（视频模特替换）
    - `video_product_replace` -> `replace_product`（视频商品替换）
    - `video_union_replace` -> `replace_productANDmodel`（联合替换）
  - TG 规划 prompt 现在注入 workflow skills 目录，要求模型只能选择这些 skill 或 `chat`。
  - `skill` 字段在 `production_only=True` 时成为权威映射：即使模型把 `task_type` 写偏，只要 skill 正确，也会落到对应生产工作流。
  - 缺少素材时返回对应 skill 的补充说明，不入队，不显示错误式任务失败。
  - 禁止 TG 智能入口创建未列出的 task_type 或分析型任务。
- `tests/test_workflow_chains.py`
  - 增加 skill 目录 prompt 测试。
  - 增加 skill 权威映射测试，覆盖模型把 `task_type` 写成 `get_gemini` 但 `skill=image_edit` 时仍落到 `image_generate`。
  - 增加缺素材时按工作流返回引导、不建任务的测试。

## 验证
- 本地：
  - `python -m compileall webapp/server.py src/digital_human_tg_bot/bot.py` 通过。
  - `python -m pytest tests/test_workflow_chains.py -q` 通过（`36 passed`）。
- 远端：
  - 已备份并上传 `webapp/server.py` 到 `/opt/apps/digital-human-tg-bot`。
  - 远端 `.venv/bin/python -m compileall webapp/server.py` 通过。
  - 已重启 `digital-human-tg-bot.service` 和 `digital-human-tg-bot-telegram.service`，两个服务均为 `active`。
  - 最近 2 分钟服务 warning 日志为空。
  - 远端 mock 检查确认：
    - `skill=image_edit` 且 `task_type=get_gemini` 时，最终工作流为 `image_generate`。
    - `我要做视频商品替换` 但无素材时，返回 chat 引导用户补充原视频、商品图和商品说明，不创建任务。
- 本次没有创建生产任务，没有触发 RunningHub 或闭源图像生产请求；远端验证使用 mock，不访问真实模型。

---

# 2026-05-24 TG 工作流审查与 dry-run 验证

## 目标
- 审查最近 TG 工作台、自然语言 skill 调度和工作流链路改动。
- 对每个 TG 工作流做最小运行验证，但不触发真实 RunningHub / 闭源模型生产请求。

## 审查发现与修复
- 发现一个实际问题：自然语言 skill 调度出的 `replace_productANDmodel` 可能使用 `mixed_image_paths/video_paths` 或 zip 路径，而 TG 内部提交构建器只接受菜单式 `video_local_path/model_image_local_path/product_image_local_path`。
- 已修复：
  - `webapp/server.py`
    - 联合替换 skill prompt 增加简单三素材 schema：`video_index + model_image_index + product_image_index`。
    - `_build_agent_task_payload()` 在自然语言联合替换中优先生成菜单兼容 payload。
    - `_build_internal_tg_task_payload()` 对联合替换增加 zip、混传图片+视频 payload 的兼容校验。
  - `tests/test_workflow_chains.py`
    - 增加自然语言联合替换生成菜单兼容 payload 的测试。
    - 增加 TG 内部构建器接受 agent 混传 payload 的测试。

## 测试
- 全量 `python -m pytest -q` 结果：`124 passed / 13 failed`。
  - 失败项主要来自历史/弃用测试或产品改名后的旧断言：
    - `runninghub_batch_test/test_single.py` 缺少真实 `config.json`。
    - 旧文案断言仍期望 `替换模特（原版工作流）`、`图片生成服务`。
    - 旧 `commerce_video_generator.get_nano_banana` patch 点已不存在。
    - 旧 runtime/nano 字段断言与当前配置拆分/移除后的结构不一致。
- 当前改动相关聚焦测试：
  - `python -m pytest tests/test_workflow_chains.py tests/test_runninghub_common.py -q` 通过（`42 passed`）。
  - `python -m compileall webapp/server.py src/digital_human_tg_bot/bot.py` 通过。

## TG 工作流 dry-run
- 本地 dry-run：
  - 菜单式 TG 提交路径全部通过：
    - 数字人视频生成 -> `create_video`
    - 图片编辑 -> `image_generate`
    - 视频模特替换 -> `replace_model`
    - 视频商品替换 -> `replace_product`
    - 联合替换 -> `replace_productANDmodel`
  - 自然语言 skill 调度路径全部通过：
    - `digital_human_video`
    - `image_edit`
    - `video_model_replace`
    - `video_product_replace`
    - `video_union_replace`
- 远端 dry-run：
  - 已上传 `webapp/server.py` 到 `/opt/apps/digital-human-tg-bot` 并备份旧文件。
  - 远端 `.venv/bin/python -m compileall webapp/server.py` 通过。
  - 已重启 `digital-human-tg-bot.service` 和 `digital-human-tg-bot-telegram.service`，两个服务均为 `active`。
  - 远端菜单式 5 个工作流和自然语言 5 个 skill 全部 dry-run 通过。
  - 最近 5 分钟服务 warning 日志为空。
- 本次验证没有创建真实任务，没有触发 RunningHub 或闭源模型生产请求。

---

# 2026-05-24 TG 引导话术排版优化

## 目标
- 调整 TG 启动引导和几个工作流入口提示的排版，避免大段文字挤在一条消息里难以阅读。

## 改动
- `src/digital_human_tg_bot/bot.py`
  - `_quick_start_text()` 改为分段结构：可用工作流、直接对话、常用操作、详情说明。
  - 数字人视频生成、图片编辑、视频模特替换、视频商品替换、联合替换的入口提示改为标题 + 步骤 + 简短说明格式。

## 验证与部署
- 本地 `python -m compileall src\digital_human_tg_bot\bot.py` 通过。
- 本地 `python -m pytest tests\test_workflow_chains.py -q` 通过（`38 passed`）。
- 已备份并上传 `src/digital_human_tg_bot/bot.py` 到 `/opt/apps/digital-human-tg-bot`。
- 远端 `.venv/bin/python -m compileall src/digital_human_tg_bot/bot.py` 通过。
- 已重启 `digital-human-tg-bot-telegram.service`；`digital-human-tg-bot.service` 与 `digital-human-tg-bot-telegram.service` 均为 `active`。
- 远端预览 `_quick_start_text()` 确认新排版已生效。
- 最近 2 分钟 telegram 服务 warning 日志为空。
- 本次没有创建真实任务，没有触发 RunningHub 或闭源模型生产请求。

## 追加调整
- 启动引导重点分区增加 `★ / ☆` 标记：工作台启动、可用工作流、直接对话、常用操作、执行记录说明。
- 工作流入口提示增加 `★` 标题标记：数字人视频生成、图片编辑、视频模特替换、视频商品替换、联合替换。
- 本地 `python -m compileall src\digital_human_tg_bot\bot.py` 通过。
- 本地 `python -m pytest tests\test_workflow_chains.py -q` 通过（`38 passed`）。
- 已上传并重启远端 `digital-human-tg-bot-telegram.service`；两个服务均为 `active`。
- 远端 `_quick_start_text()` 预览确认星号版话术已生效，最近 3 分钟 warning 日志为空。

## 追加调整 2
- 将文字星号 `★ / ☆` 替换为表情符号 `🌟 / ✨`，用于 TG 引导分区和工作流入口标题。
- 本地 `python -m compileall src\digital_human_tg_bot\bot.py` 通过。
- 本地 `python -m pytest tests\test_workflow_chains.py -q` 通过（`38 passed`）。
- 已备份并上传到远端 `/opt/apps/digital-human-tg-bot`，重启 `digital-human-tg-bot-telegram.service`。
- 远端两个服务均为 `active`，最近 3 分钟 warning 日志为空。
- 远端 `_quick_start_text()` 预览确认显示 `🌟 / ✨` 表情符号。

## 追加调整 3
- 将普通重点 emoji 改为 Telegram 自定义动态表情实体：
  - 使用示例 `custom_emoji_id=5368324170671202286`
  - 文本格式为 `<tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>`
- 新增 `_answer_with_custom_emoji_fallback()`：
  - 如果 Telegram 拒绝自定义表情实体，会自动去掉 `<tg-emoji>` 标签并退回普通 `👍`，避免 `/start` 或工作流入口消息发送失败。
- 已覆盖启动引导、数字人视频生成、图片编辑、视频模特替换、视频商品替换、联合替换入口提示。
- 本地 `python -m compileall src\digital_human_tg_bot\bot.py` 通过。
- 本地 `python -m pytest tests\test_workflow_chains.py -q` 通过（`38 passed`）。
- 已备份并上传到远端 `/opt/apps/digital-human-tg-bot`，重启 `digital-human-tg-bot-telegram.service`。
- 远端两个服务均为 `active`，最近 2 分钟 warning 日志为空。
- 远端 `_quick_start_text()` 预览确认输出自定义表情实体，并确认 fallback 文本可退回普通 `👍`。

## 追加调整 4
- 因当前 Bot 自定义动态表情显示不稳定，撤回 `<tg-emoji>` 自定义表情实体逻辑。
- 恢复普通 emoji 标记：
  - 分区标题使用 `🌟`
  - 执行记录说明使用 `✨`
- 已移除 `GUIDE_CUSTOM_EMOJI_ID`、`_answer_with_custom_emoji_fallback()` 和 `<tg-emoji>` 相关处理。
- 本地确认 `src/digital_human_tg_bot/bot.py` 无 `tg-emoji/custom_emoji` 相关残留。
- 本地 `python -m compileall src\digital_human_tg_bot\bot.py` 通过。
- 本地 `python -m pytest tests\test_workflow_chains.py -q` 通过（`38 passed`）。
- 已备份并上传到远端 `/opt/apps/digital-human-tg-bot`，重启 `digital-human-tg-bot-telegram.service`。
- 远端两个服务均为 `active`，最近 2 分钟 warning 日志为空。
- 远端 `_quick_start_text()` 预览确认显示普通 `🌟 / ✨`。
