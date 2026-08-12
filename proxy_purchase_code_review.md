# Proxy-Cheap 代理采购代码审核

> 修复状态（2026-08-12）：本文下方保留了修复前的审核记录便于追溯。其中列出的代码问题已修复，不能由本地事务消除的供应商外部风险已由硬门禁封闭；实现通过 133 项相关回归测试与 Mock Provider 真实浏览器闭环。真实无人值守采购仍由双重安全开关禁用，直到轮换并注入完整 API Key/Secret，且供应商书面确认 Execute 幂等/可靠查单与锁价边界。

审核日期：2026-08-12
审核范围：代理供应商适配器、采购状态机、现金背书点数账本、自动续费、Webhook、用户/管理员 API、采购前端和用户清理流程。

## 修复前结论（历史记录）

当前实现已经具备 Mock Provider 全链路、服务端报价、现金背书点预占、真实采购默认关闭、供应商凭据仅从服务端环境读取、代理凭据加密入库等基础能力。采购专项 18 项单元测试全部通过，Python 编译检查和新增 JavaScript 语法检查也通过；仓库中未发现用户此前粘贴的凭据。

但真实无人值守采购仍不应开启。审核确认 4 个 P0、9 个 P1 和若干 P2 缺口，其中两项已通过独立脚本复现：

- 供应商受理后最终失败，订单为 `failed`，reservation 仍为 `settled`，用户钱包已扣款；
- ACTIVE 订单后开自动续费，接口返回 `renewal_enabled=1`，但续费计划数量仍为 0；
- 用户产生采购报价后执行永久清理，SQLite 返回 `FOREIGN KEY constraint failed`。

## P0 - 上线阻断

### PC-P0-001：代理尚未交付就结算，后续失败不退款

- 位置：`webapp/proxy_purchases.py:629-638`、`webapp/proxy_purchases.py:824-837`、`webapp/commercial_billing.py:1900-1907`
- 证据：Execute 返回供应商订单号后立即 settle；供应商后续进入 cancelled/expired/failed 时只尝试 release，而 release 对 settled reservation 直接返回。
- 影响：用户被扣现金背书点但没有得到代理。
- 修复：保持 reservation 为 held，直到代理 ACTIVE 且 owned 资产成功落库，再在同一事务结算；若必须提前结算，需要实现按原资金分类的幂等反向退款流水。

### PC-P0-002：Execute 已成功但响应解析失败会被当成明确失败退款

- 位置：`webapp/proxy_providers/proxycheap.py:181-212`、`webapp/proxy_purchases.py:604-614`
- 证据：变更请求的响应超限、无效 UTF-8/JSON 等错误抛出普通 `ProxyProviderResponseError`，采购服务随后释放点数。
- 影响：供应商可能已扣款并创建订单，平台却给用户退款，平台直接亏损。
- 修复：mutation 请求发送后的读取、大小、解析和语义错误全部归类为 outcome unknown；仅明确表示请求未执行的响应才允许释放。

### PC-P0-003：Execute 成功到供应商订单号持久化之间存在不可恢复崩溃窗

- 位置：`webapp/proxy_purchases.py:593-635`
- 证据：供应商调用和本地 SQLite 提交无法形成原子事务。若进程在供应商成功后、本地保存 `provider_order_id` 前退出，本地只剩 reserved 且没有查单键；幂等重放又只返回旧订单。
- 影响：订单可能已真实购买，但本地永久无法自动识别，点数冻结且存在重复人工操作风险。
- 修复：上线前必须确认供应商支持客户端引用/幂等键并可据此查单。若不支持，这个风险无法由本地事务消除，真实自动采购应继续关闭。

### PC-P0-004：不亏损校验混用 TWD 与 USD

- 位置：`webapp/proxy_purchases.py:143-153`、`webapp/proxy_purchases.py:185-197`
- 证据：`price_ntd / total_points` 是 TWD/点，乘 `points_per_usd` 后是 TWD/USD，却直接与 USD 表示的订单成本上限、安全垫和利润比较。
- 影响：错误配置能够通过发布，当前代码不能保证“只赚不亏”。
- 修复：增加版本化且有有效期的保守 USD/TWD 汇率和支付费率；发布、报价、Execute 前全部统一到同一币种比较，并将使用的汇率/费率保存到订单快照。

## P1 - 高优先级

### PC-P1-001：无供应商订单号的 unknown 状态无法对账

- 位置：`webapp/proxy_purchases.py:596-624`、`webapp/proxy_purchases.py:817-820`、`webapp/proxy_purchases.py:1178-1181`
- 影响：Execute 超时或缺少订单号后，自动与管理员“人工对账”都会原样返回，现金点永久冻结。
- 修复：支持按客户端引用查单；否则提供 MFA 保护、强审计的“绑定供应商订单”与“确认未下单并释放”人工状态机。

### PC-P1-002：多进程 worker 可对同一续费调用供应商两次

- 位置：`webapp/proxy_purchases.py:936-1002`、`webapp/proxy_purchase_api.py:263-270`、`webapp/server.py:21055`
- 证据：每个应用进程都会启动 worker，续费任务读取后才无条件更新为 extending，没有 CAS/lease；账本幂等只能合并预占，不能阻止第二次供应商调用。
- 影响：供应商延期两次、平台只扣一次点数。
- 修复：供应商调用前使用条件 UPDATE 原子领取任务并校验 rowcount，所有完成/失败更新都校验 lease token。

### PC-P1-003：续费成功后的崩溃和 unknown 结果没有恢复路径

- 位置：`webapp/proxy_purchases.py:985-1034`
- 影响：供应商已延期但本地停在 extending/provider_unknown，预占永久不结算，调度器也不会再处理。
- 修复：新增续费 attempt 记录，保存 reservation、供应商操作引用和 lease；通过供应商真实到期时间对账，并提供 MFA 人工结算/退款。

### PC-P1-004：供应商缺失到期时间会触发立即续费

- 位置：`webapp/proxy_purchases.py:862-877`
- 证据：无法解析到期时间时得到 0，`next_attempt_at` 被设为当前时间。
- 影响：刚购买完成就可能再次扣点并续费。
- 修复：仅在到期时间有效且晚于安全最小周期时创建 schedule；否则进入 missing_expiry，仅同步、不扣点。

### PC-P1-005：历史已付费点数没有现金背书回填

- 位置：`webapp/db.py:460-465`
- 证据：新增列对现有钱包统一默认 0，没有从已完成充值订单重建来源。
- 影响：上线前已付费用户会被误判为无可采购余额。
- 修复：编写一次性、可审计且可回滚的迁移，从完成/退款的充值订单与历史消费重建余额；无法精确归因的账户进入人工复核。

### PC-P1-006：永久删除用户被采购外键阻断

- 位置：`webapp/db.py:530-606`、`webapp/server.py:28894-28909`
- 证据：采购 quotes/orders/schedules 外键没有级联；purge 流程也不删除或匿名化这些表。已复现 `FOREIGN KEY constraint failed`。
- 影响：任何产生过报价/订单的用户无法永久清理，已购 owned 资产还存在所有权保留问题。
- 修复：先明确财务留存政策；对订单做匿名化保留或按 events → schedules → orders → quotes 的顺序清理，并显式处理 owned 资产。

### PC-P1-007：动态产品 UI 与硬编码静态住宅实现不一致

- 位置：`webapp/proxy_providers/proxycheap.py:228-261`、`webapp/proxy_purchases.py:694-791`、`webapp/static/assets/admin.js:8680-8722`
- 影响：管理员可选择其他产品，但未知 Setup 字段会被丢弃，入库仍固定标记静态住宅、周期固定按月，可能买错或记录错误。
- 修复：首版严格锁定已验证的 static residential IPv4 service/plan；后续按产品建立字段映射与能力矩阵。

### PC-P1-008：同一供应商代理 ID 的交付不校验所有权

- 位置：`webapp/proxy_purchases.py:694-705`
- 影响：若供应商返回重复代理 ID，当前订单直接复用其他用户/订单的 market item，却仍可能把当前订单标为 active 并结算。
- 修复：仅同一订单允许幂等复用；owner/order 不一致时进入冲突和人工对账，禁止结算。

### PC-P1-009：单条本地异常可饿死整轮订单及续费队列

- 位置：`webapp/proxy_purchases.py:1170-1188`、`webapp/proxy_purchase_api.py:263-270`
- 影响：SQLite、加密或资产交付异常未在单订单边界处理，会中止后续订单并跳过本轮续费；最旧故障可反复阻塞队列。
- 修复：每行独立 rollback、记录错误、退避并继续；订单、Webhook、续费使用独立异常边界。

## P2 - 应补齐

### PC-P2-001：ACTIVE 后开启续费不创建 schedule

- 位置：`webapp/proxy_purchases.py:898-915`、`webapp/static/assets/proxy-purchase.js:186-198`
- 证据：后端只 UPDATE，影响 0 行仍返回开启；前端显示成功。已复现 schedule 数量保持 0。
- 修复：开启时根据 owned 代理的真实到期时间 UPSERT；缺少必要数据则返回冲突错误。

### PC-P2-002：Webhook 只入库，没有消费者

- 位置：`webapp/proxy_purchases.py:1056-1105`、`webapp/proxy_purchase_api.py:263-270`
- 影响：`processed_at` 永远为 0，Webhook 不会驱动状态同步，事件表持续增长。
- 修复：增加可重试的事件 claim/consumer，复用订单/代理同步路径并记录处理失败原因。

### PC-P2-003：供应商余额不足状态永不重试

- 位置：`webapp/proxy_purchases.py:936-969`
- 影响：代码虽然写入下一尝试时间，但查询只选择 scheduled，`provider_balance_low` 永久滞留。
- 修复：把可重试状态纳入查询，或保持 scheduled 并单独记录错误。

### PC-P2-004：续费到期时间固定加 30 天

- 位置：`webapp/proxy_purchases.py:1020-1033`
- 影响：自然月、供应商实际到期日或既有偏移会造成持续漂移。
- 修复：延期成功后读取供应商真实 `expiresAt`，同时更新 schedule 与 owned 资产。

### PC-P2-005：前端没有持久化下单幂等键

- 位置：`webapp/static/assets/proxy-purchase.js:165-182`
- 影响：服务端已下单但响应丢失时，页面丢弃 key 和 quote，用户无法安全重放恢复，只能等待不一定有效的自动对账。
- 修复：在 sessionStorage 中按 quote 保存稳定 key，网络未知时用原请求恢复；或提供按用户 + idempotency key 查询订单的 API。

### PC-P2-006：管理员人工对账缺少 MFA 二次确认和结果判定

- 位置：`webapp/proxy_purchase_api.py:233-240`、`webapp/static/assets/admin.js:8870-8877`
- 影响：普通管理员会话即可触发可能改变资金/资产的对账；无 supplier ID 的订单实际没有变化，UI 仍提示“已完成”。
- 修复：涉及资金/资产变化的人工动作复用 step-up MFA，记录前后值；按返回状态区分“完成”与“仍待处理”。

### PC-P2-007：未知币种被默认为 USD

- 位置：`webapp/proxy_providers/proxycheap.py:58-87`、`webapp/proxy_purchases.py:454-466`
- 影响：供应商响应缺少币种时系统继续按 USD 计算，不符合 fail closed。
- 修复：报价和余额必须明确包含受支持 ISO 币种；缺失或非 USD 直接停止报价/采购，并用官方响应 fixture 做契约测试。

## 测试缺口与上线门槛

现有测试验证了 happy path、基础幂等、现金点限制、Execute timeout、单进程续费崩溃边界和 Webhook HMAC，但没有覆盖：

- Execute 接受后转失败及精确退款；
- 变更响应 JSON/大小解析失败的 unknown 分类；
- 多进程续费竞争；
- unknown 订单和续费的人工恢复；
- 缺少到期时间、币种和重复 proxy ID；
- 历史现金背书迁移与用户永久清理；
- Webhook 消费、ACTIVE 资产持续同步和队列单条异常隔离；
- 前端断网后以原幂等键恢复。

真实采购开关保持关闭，直至至少完成全部 P0、P1 修复与相应故障注入测试，并取得供应商关于 Execute 幂等/查单及价格锁定语义的书面确认。
