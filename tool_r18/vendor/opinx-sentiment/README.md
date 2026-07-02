# OpinX舆情监控后端

这个仓库现在只保留舆情监控功能。原来的 Electron 桌面端、聊天 Agent、CRM 联系人/项目管理、桥接、构建产物和其他插件都已删除。

## 启动

```bash
npm start
```

默认监听：

```text
http://127.0.0.1:8787
```

常用环境变量：

```bash
PORT=8787
HOST=127.0.0.1
SENTIMENT_DATA_DIR=/path/to/data
SENTIMENT_SCHEDULER=0
SENTIMENT_INTERVAL_MINUTES=30
SENTIMENT_AI_ENABLED=1
SENTIMENT_AI_BASE_URL=https://your-model-host/v1
SENTIMENT_AI_API_KEY=...
SENTIMENT_AI_MODEL=your-crisis-model
```

默认数据目录是 `~/.opinx-sentiment`，会写入 `crm.db` 和 `sentiment-config.json`。

## API

- `GET /health`
- `GET /api/sentiment/dashboard`
- `GET /api/sentiment/commercial-readiness`
- `GET /api/sentiment/commercial-remediation-plan`
- `POST /api/sentiment/commercial-remediation-plan`
- `GET /api/sentiment/commercial-remediation-effectiveness`
- `GET /api/sentiment/commercial-remediation-post-scan`
- `GET /api/sentiment/commercial-policy-governance`
- `GET /api/sentiment/realtime-discovery-latency`
- `GET /api/sentiment/realtime-hot-topics`
- `GET /api/sentiment/realtime-anomaly-windows`
- `GET /api/sentiment/keyword-source-family-coverage`
- `GET /api/sentiment/collection-operations`
- `GET /api/sentiment/collection-operations/remediation`
- `POST /api/sentiment/collection-operations/remediation`
- `GET /api/sentiment/collection-quality/operations-remediation`
- `GET /api/sentiment/collection-quality/multilingual-queries`
- `GET /api/sentiment/collection-quality/noise-suppression`
- `GET /api/sentiment/realtime-source-coverage`
- `GET /api/sentiment/free-source-target-coverage`
- `GET /api/sentiment/evidence-chain-gaps`
- `GET /api/sentiment/event-clusters`
- `GET /api/sentiment/source-credibility`
- `GET /api/sentiment/source-discovery`
- `GET /api/sentiment/source-discovery/validate`
- `GET /api/sentiment/source-discovery/deep-crawl-plan`
- `POST /api/sentiment/source-discovery/deep-crawl-plan/execute`
- `POST /api/sentiment/source-discovery/policy`
- `GET /api/sentiment/status`
- `POST /api/sentiment/watch-scan`
- `GET /api/sentiment/architecture`
- `GET /api/sentiment/trends`
- `GET /api/sentiment/anomalies`
- `GET /api/sentiment/insights`
- `POST /api/sentiment/insights/reprocess`
- `GET /api/sentiment/evidence`
- `GET /api/sentiment/fact-claims`
- `GET /api/sentiment/fact-claims/summary`
- `POST /api/sentiment/fact-claims/rebuild`
- `GET /api/sentiment/author-reputation`
- `GET /api/sentiment/coordinated-amplification`
- `GET /api/sentiment/content-similarity-clusters`
- `GET /api/sentiment/social-followup-signals`
- `GET /api/sentiment/official-regulatory-followup-signals`
- `POST /api/sentiment/social-followup-signals/policy`
- `GET /api/sentiment/volume-precision`
- `GET /api/sentiment/visual-assets`
- `GET /api/sentiment/comments`
- `GET /api/sentiment/entity-recall-gaps`
- `GET /api/sentiment/entity-topic-recall-gaps`
- `GET /api/sentiment/entity-topic-source-recall-gaps`
- `GET /api/sentiment/entity-recall-trend`
- `GET /api/sentiment/entity-topic-recall-trend`
- `GET /api/sentiment/entity-recall-gaps/policy`
- `POST /api/sentiment/entity-recall-gaps/policy`
- `GET /api/sentiment/sources`
- `PUT /api/sentiment/sources/:key`
- `GET /api/sentiment/scan-batches`
- `GET /api/sentiment/scan-source-logs`
- `GET /api/sentiment/collection-jobs`
- `GET /api/sentiment/collection-jobs/retry-plan`
- `POST /api/sentiment/collection-jobs/requeue`
- `GET /api/sentiment/collection-jobs/recoverable-followups`
- `POST /api/sentiment/collection-jobs/recoverable-followups`
- `POST /api/sentiment/collection-jobs/execute-due`
- `GET /api/sentiment/continuous-collection-plan`
- `POST /api/sentiment/continuous-collection/run`
- `GET /api/sentiment/collection-jobs/quality-feedback`
- `GET /api/sentiment/collection-jobs/quality-feedback/policy`
- `POST /api/sentiment/collection-jobs/quality-feedback/policy`
- `GET /api/sentiment/source-quality`
- `GET /api/sentiment/source-quality/domains`
- `GET /api/sentiment/source-quality/domains/policy`
- `POST /api/sentiment/source-quality/domains/policy`
- `GET /api/sentiment/deep-collection-health`
- `GET /api/sentiment/evidence-depth`
- `GET /api/sentiment/source-coverage`
- `GET /api/sentiment/source-reliability`
- `GET /api/sentiment/source-reliability/policy`
- `POST /api/sentiment/source-reliability/policy`
- `GET /api/sentiment/source-recovery`
- `GET /api/sentiment/source-throttle`
- `GET /api/sentiment/source-recovery/audit`
- `POST /api/sentiment/source-recovery/audit/:id/rollback`
- `POST /api/sentiment/source-recovery/playbook`
- `GET /api/sentiment/rss-feed-packs`
- `GET /api/sentiment/query-template-packs`
- `POST /api/sentiment/source-quality/tune`
- `GET /api/sentiment/alert-rules`
- `POST /api/sentiment/alert-rules`
- `PUT /api/sentiment/alert-rules/:key`
- `GET /api/sentiment/analysis`
- `GET /api/sentiment/compare?keywords=topicA,topicB`
- `POST /api/sentiment/ask`
- `GET /api/sentiment/report`
- `GET /api/sentiment/crisis-briefs`
- `POST /api/sentiment/crisis-briefs`
- `GET /api/sentiment/ai-settings`
- `PUT /api/sentiment/ai-settings`
- `GET /api/sentiment/export.csv`
- `GET /api/sentiment/migration-export.jsonl`
- `GET /api/sentiment/report-schedules`
- `POST /api/sentiment/report-schedules`
- `DELETE /api/sentiment/report-schedules/:id`
- `GET /api/sentiment/events`
- `GET /api/sentiment/event-edges`
- `GET /api/sentiment/spread-graph`
- `GET /api/sentiment/alerts`
- `POST /api/sentiment/alerts/:id/ack`
- `POST /api/sentiment/alerts/:id/status`
- `GET /api/sentiment/alerts/:id/actions`
- `POST /api/sentiment/alerts/:id/actions`
- `PATCH /api/sentiment/alerts/:id/actions/:actionId`
- `POST /api/sentiment/alerts/:id/notify`
- `GET /api/sentiment/notifications`
- `PUT /api/sentiment/notifications`
- `POST /api/sentiment/notifications/:id/retry`
- `GET /api/sentiment/keywords`
- `POST /api/sentiment/keywords`
- `DELETE /api/sentiment/keywords/:id`
- `GET /api/sentiment/search-settings`
- `PUT /api/sentiment/search-settings`
- `POST /api/sentiment/scan`
- `POST /api/sentiment/monitor`
- `POST /api/sentiment/ingest`

## 商业级增强基础

当前版本已经加入第一轮商业级舆情底座：

- 来源配置表：可管理平台开关、扫描间隔、优先级和来源元数据。
- 原始证据表：每条舆情保留原始 JSON、HTML、正文、URL、指标和截图路径字段。
- 评论表：支持保存贴文评论、作者、评论情绪、风险等级和互动指标。
- 告警规则表：支持负面数量、高风险数量、跨平台扩散等规则化告警。
- PTT 深度采集：搜索命中后继续抓文章正文和推文。
- Dcard 深度采集：搜索命中后继续抓贴文详情和评论，失败时回退摘要。
- YouTube 公开视频发现：通过公开 feed 发现视频级舆情线索，并在预算允许时从公开 watch 页提取可见评论、相关视频和同频道后续视频，追踪同一事件的视频扩散链。
- App Store / Google Play 公开评论：`appStoreReviews` 使用 Apple 公开 iTunes Search 和 customer reviews RSS/JSON；`googlePlayReviews` 使用 Google Play 公开搜索/详情网页，按品牌/产品词发现相关 iOS/Android App，也支持在来源配置里指定 `appIds` / `packageIds` 提高精确性。系统会采集最新评论、星级、版本、国家/地区、开发者或 package id，用于补齐移动应用体验、退款、客服、评分下滑等投诉/评价场景，不依赖任何付费 API。
- 公开评价/投诉站采集：`publicReviewSites` 使用免费公开搜索页对 Trustpilot、BBB、Sitejabber、ComplaintsBoard、PissedConsumer、ProductReview、ConsumerAffairs、Reviews.io、MouthShut、Hellopeter 等公开评价/投诉域名做垂直发现，来源配置可用 `targets` / `sites` 收窄目标站点。命中结果会继续做公开页面摘要提取，并保存 `public_review_site_result` 证据、`review_site_key`、`site_tags` 和 `source_family:"review"`，用于补齐移动应用商店以外的客户投诉、评分、消费体验和售后争议。
- 垂直产品/社区评价源：`verticalReviewSources` 使用免费公开搜索页对 Chrome Web Store、Product Hunt、Steam、G2、Capterra、TrustRadius、Microsoft Store、GetApp、Software Advice、SourceForge、AlternativeTo、AppSumo 等产品/软件/社区评价域名做垂直发现，来源配置同样支持 `targets` / `sites` 收窄目标站点。命中结果保存为 `vertical_review_source_result` 证据，并记录 `vertical_source_key`、`site_tags` 和 `source_family:"review"`，用于覆盖浏览器插件、SaaS、游戏/软件、开源软件、替代品社区、产品发布社区和桌面应用商店里的体验反馈。
- 电商/市场公开评价源：`ecommerceReviewSources` 使用免费公开搜索页对 Amazon、eBay、Etsy、Walmart、Best Buy、Target、Costco、Newegg、AliExpress、Shopee Taiwan、PChome 24h、momo、Lazada、Tokopedia、Rakuten Japan 等电商/市场域名做垂直发现，来源配置可用 `targets` / `sites` 收窄目标站点。命中结果保存为 `ecommerce_review_source_result` 证据，并记录 `marketplace_key`、`site_tags` 和 `source_family:"review"`，用于覆盖商品评价、物流延迟、退款退货、卖家服务、跨境交易和市场渠道负评。
- 区域投诉/消费者保护源：`regionalComplaintSources` 使用免费公开搜索页对台湾行政院消保会、台湾消费者文教基金会、香港消委会、新加坡 CASE、澳洲 ACCC / Scamwatch / Product Safety Australia、美国 CFPB / CPSC / FTC consumer / ReportFraud、加拿大 Recalls and Safety Alerts、EU Safety Gate、日本 Consumer Affairs Agency、英国 Citizens Advice / Trading Standards / Product Safety Alerts、新西兰 Consumer Protection、印度 National Consumer Helpline、韩国 Consumer Agency 等公开消费者保护/投诉/召回/监管域名做垂直发现。命中结果保存为 `regional_complaint_source_result` 证据，并记录 `regional_source_key`、`site_tags`、`complaint_or_regulatory:true` 和 `source_family:"review"`，用于补齐本地消费者投诉、退款争议、诈骗警示、产品召回、安全警示和监管/消保信号。
- 区域投诉源会按查询词动态排序目标：出现 `recall` / `召回` / `product safety` 会优先 CPSC、Canada Recalls、EU Safety Gate、英国/澳洲产品安全和日本/韩国消费安全源；出现金融、付款、账单、信用、贷款等词会优先 CFPB；出现诈骗/钓鱼词会优先 Scamwatch、FTC 和监管警示源；出现 UK、Australia、India、Korea、New Zealand 等区域词会优先对应本地官方/消保源。这样在默认有限预算下也能先搜索最相关的官方公开源。
- 四类垂直评价/投诉源都支持来源配置 `targetProfiles` / `target_profiles` / `profiles`，可按 `taiwan`、`saas`、`marketplace`、`complaint`、`official`、`regulatory`、`recall`、`financial`、`india`、`new-zealand`、`korea`、`southeast-asia`、`japan` 等画像收窄采集目标；证据指标会保存 `target_profiles` 和 `source_weight_tier`，方便后续做来源权重、区域专项监控和危机证据排序。
- 公开评价页面富化：搜索/RSS/评价/投诉命中后的公开 HTML 富化会解析 JSON-LD `Review` / `AggregateRating`，把 `review_rating`、`review_best_rating`、`review_worst_rating`、`review_rating_count`、`review_count`、`review_author`、`review_published_time`、`review_item`、`review_text` 和 `has_review_structured_data` 写入 evidence metrics；评价正文会优先进入摘要候选，减少只保存搜索片段导致的证据过浅问题。
- 公开评价二跳发现：公开 HTML 富化会从评价/投诉页中提取评论入口、下一页/分页、同品牌更多评价、产品/公司/作者 profile 等链接，写入 `review_followup_links` 和 `review_followup_link_count`。`source-discovery/deep-crawl-plan` 的 `deep-crawl-outlink` 类型会读取这些入口，并按 `deep-crawl-review-comments`、`deep-crawl-review-pagination`、`deep-crawl-review-page`、`deep-crawl-review-profile` 区分目标，让评论页、分页和相关评价页以更精确的优先级进入可恢复深抓候选。
- 通用 RSS/Atom 采集：内置 `chineseNews`、`consumerProtection`、`regulatoryNotices`、`globalTech`、`security`、`business` 免费公开源包；其中 `consumerProtection` / `regulatoryNotices` 覆盖 FTC 消费者保护、FTC Data Spotlight、CFPB 新闻公告、CPSC 召回和 Federal Register notices、FDA 召回/食品安全召回/MedWatch 安全警示、加拿大消费品/食品/健康产品召回、英国 GOV.UK 产品安全/药械警示、澳洲 Product Safety recalls、SEC 公告等官方公开 RSS/Atom，用于补齐投诉、诈骗、召回、监管处罚、产品/健康安全和官方警示信号。`rssFeeds` 来源配置可通过 `feedPacks` 启用源包、通过 `feeds` 追加自定义 feed URL，证据 metrics 会保留 `feed_pack`、`source_family`、`feed_tags`、`regulatory` 和 `source_weight_tier` 标记，使官方消费者保护、监管和召回/安全警示证据进入可信度评分与证据深度评分。
- 去中心化社媒实时发现：支持 Mastodon / ActivityPub 公开标签时间线和 Bluesky public AppView 搜索，保存公开贴文、互动指标和图片证据。
- 国际/技术社区采集：支持 GitHub Issues、GitLab Issues、Reddit、Hacker News、Stack Overflow、Discourse 公开论坛搜索；GitHub Issues、Reddit、Hacker News、Stack Overflow 会继续补抓评论、跟帖或回答证据，扩大品牌外溢、技术投诉和海外开发者讨论覆盖深度。
- 查询扩展配置：`/api/sentiment/search-settings` 支持配置品牌别名、竞品、行业词、自定义词、危机风险词组合和查询模板包；内置 `complaints`、`crisis`、`trustSafety`、`socialDiscovery`、`officialResponse`、`regulatorySafety` 模板包，默认会补搜投诉危机、社媒入口、官方声明/回应、召回、监管警示和产品安全词，`GET /api/sentiment/query-template-packs` 可查看模板内容，让所有免费公开源自动扩大搜索范围。`keywordExpansion.includeMultilingual` 默认启用本地多语言风险词扩展，可用 `multilingualLocales`、`multilingualRiskTerms`、`maxMultilingualTerms` 控制英文、简中、繁中、日文、韩文、港澳台及东南亚语言投诉/退款/诈骗/召回等查询组合，不依赖任何付费翻译或搜索 API。
- 监控实体治理：`/api/sentiment/search-settings` 和 `GET/PUT /api/sentiment/monitored-entities` 支持把品牌、别名、产品、负责人、竞品、错别字、负面短语和平台提示配置成结构化实体；扫描会优先把实体词展开为 `monitoredEntityKeywords`，让品牌危机搜索不再只依赖单一关键词。
- 高风险实时 watch lane：`/api/sentiment/search-settings.highRiskWatch` 可配置高频轻量扫描来源、危机风险词、关键词上限和单源预算；`POST /api/sentiment/watch-scan` 或 `/api/sentiment/scan` 传 `reason:"watch"` 会只运行 `high-risk-watch` lane，把品牌/实体词与投诉、诈骗、爆料、抵制等风险词组合后扫描，避免完整深扫占用实时预警资源。
- 来源级增量游标：scheduled/watch 扫描成功后会把每个来源的 `incrementalCursor` 写入 `sentiment_sources.config`，记录 lastSuccessfulAt、since、实际关键词、结果数和失败数；下一轮 scheduled/watch 会优先使用该游标加 overlap window，减少 RSS/search/community 重复抓取，同时手动扫描仍可按需完整排查。
- 实体召回缺口：`GET /api/sentiment/entity-recall-gaps` 会按监控实体评估新闻、搜索、社区、论坛、社媒、视频、评论/评价等 source family 是否有命中，输出 `missing_families`、`weak_families`、`recall_score` 和补源/补关键词建议，用来发现某个品牌或竞品在哪类公开来源上覆盖不足。
- 实体主题召回缺口：`GET /api/sentiment/entity-topic-recall-gaps` 会按“监控实体 × 风险主题/场景 × source family”评估覆盖，例如退款、诈骗、个资、客服、官方回应、抵制炎上等主题在新闻、搜索、论坛、社媒、社区和视频侧是否缺失；输出 `suggested_keywords`，扫描计划会优先把高风险主题缺口词并入 `searchKeywords`，自动补搜 `品牌 + 风险词 + Dcard/Threads/YouTube` 等组合，并把缺口家族映射回具体免费来源，提高对应来源排序、采集预算和扫描日志里的可审计 `entityTopicSignal`。对应来源的 `sourceKeywords` 会优先使用匹配平台名的缺口词，例如 YouTube 来源优先搜索 `品牌 + 风险词 + YouTube`，Dcard 来源优先搜索 `品牌 + 风险词 + Dcard`。
- 具体来源级实体主题召回：`GET /api/sentiment/entity-topic-source-recall-gaps` 会进一步把“实体 × 风险主题”拆到 `youtube`、`dcard`、`googleNews`、`rssFeeds` 等具体免费来源，输出 `missing-source-topic` / `weak-source-topic` / `covered`、建议关键词和 `strengthen-source-topic-query:*` 建议；扫描执行和连续采集计划会把该精确信号合并进 `entityTopicSignal`，让真正漏掉特定风险主题的来源获得更高优先级和更贴合平台的查询词。
- 商业覆盖基准报告：`GET /api/sentiment/commercial-readiness` 会把来源覆盖、新鲜度、实体召回、实体主题深度、危机证据完整度、来源质量/可靠性和传播路径图谱合并成 `overall_score`、`readiness_level`、六个维度分、`benchmark_targets` 和可执行 `gaps`，用于持续判断免费公开源采集是否接近商业级舆情系统要求。
- 商业基准修复计划：`GET /api/sentiment/commercial-remediation-plan` 会读取 `commercial-readiness.gaps`，把来源覆盖、实体召回、主题深度、证据完整度、来源可靠性和传播追踪短板编排成 dry-run `actions`、`policy_previews` 和 `next_endpoints`；它会复用实体召回策略、来源可靠性策略、来源恢复 playbook、重试质量治理和低质域名治理预览，但默认不写配置，便于先审查后通过既有 policy endpoint 应用并保留审计/回滚能力。
- 商业基准修复应用：`POST /api/sentiment/commercial-remediation-plan` 支持 `action_names` 选择 `preview-entity-recall-policy`、`preview-source-reliability-policy`、`preview-source-recovery-playbook`、`preview-retry-quality-policy`、`preview-domain-quality-policy` 等已有策略动作；默认 `apply:false` 只返回应用预览，传 `apply:true` 后才调用对应策略函数写入 source/search 配置，并复用 `sentiment_source_recovery_audit` 审计和既有 rollback。返回值会包含 `readiness_delta`，记录应用前后 `overall_score`、六个维度分和 gap 数变化；应用产生的审计 metadata 也会保存这份 delta，便于复盘策略是否真的改善了覆盖、深度或精确性。
- 商业修复效果复盘：`GET /api/sentiment/commercial-remediation-effectiveness` 会读取商业修复审计里的 `commercial_readiness_delta`，按策略动作和来源汇总 `average_overall_delta`、gap 变化和维度变化，并给出 `keep-and-monitor-next-scan`、`keep-but-require-more-evidence`、`monitor-until-fresh-collection-evidence` 或 `rollback-or-adjust-policy` 建议；返回项包含对应 rollback endpoint，便于保留有效策略、调整无效策略或回滚负向策略。
- 商业修复后采集复评：`GET /api/sentiment/commercial-remediation-post-scan` 会在商业修复审计之后查找对应来源的新扫描日志，输出 `post_scan.scan_count`、成功/失败数、采集量、最新状态和 `post_scan_recommendation`；它用于区分“策略刚应用但还没有新采集证据”和“已经经过后续扫描验证”，从而判断是继续保留、扩展关键词、修复来源还是回滚策略。
- 商业策略治理建议：`GET /api/sentiment/commercial-policy-governance` 会把商业修复后扫复评归类成 `keep`、`scan-for-evidence`、`adjust-query`、`repair-source`、`rollback-or-adjust` 或 `monitor`，并返回 `next_actions`、rollback endpoint 和 `collection_hint`；连续采集计划会读取这些治理信号，对缺后扫证据、需要扩词、需要修复来源或疑似负向策略的来源提高优先级，形成“基准发现 - 策略应用 - 后扫复评 - 采集调度/回滚候选”的闭环。
- 实时发现延迟评估：`GET /api/sentiment/realtime-discovery-latency` 会按 `published_at -> first_seen_at/found_at` 计算免费公开源的发现延迟，输出整体平均、P50/P90、慢发现率、高风险慢发现率和来源级 `recommendation`；连续采集计划会把 PTT、Dcard、Reddit、Mastodon、Bluesky、YouTube 等 watch-lane 来源的延迟短板映射成 `realtime-discovery-latency` 优先级，必要时触发 `scan-realtime-latency-source`，用于逼近商业系统的“发现速度”指标。
- 实时热点主题发现：`GET /api/sentiment/realtime-hot-topics` 会按关键词/品牌在当前短窗口和上一窗口之间比较声量、负面、高风险、来源权重、源族覆盖和跨平台扩散速度，输出 `critical-hot-topic` / `high-hot-topic` / `watch-hot-topic`、缺口和建议补采源；连续采集计划会把高热主题映射成 `realtime-hot-topic` 优先级，必要时触发 `scan-realtime-hot-topic-source`，并把热点词、新闻确认、公开投诉/评价、社媒讨论等精确补采词写入 source-specific 查询计划。
- 多窗口近实时异常发现：`GET /api/sentiment/realtime-anomaly-windows` 会同时比较 5 分钟、15 分钟、1 小时、6 小时和 24 小时窗口的声量增量、来源权重增量、负面/高风险增速、跨平台加速度和扩散速度，输出 `critical/high/medium/watch` 窗口信号、缺口、样本 URL、建议来源和补采关键词；连续采集会把强信号转成 `realtime-anomaly-window` 优先级和 `scan-realtime-anomaly-window-source` 动作，并把短窗口异常词组合成 YouTube、PTT、Dcard、Threads、Bluesky、新闻/RSS/搜索等免费源的 source-specific 查询，同时提高可深抓来源的正文、评论和引用上下文预算。
- 事件簇扩散研判：`GET /api/sentiment/event-clusters` 会基于传播图节点和事件边构建连通事件簇，输出 `likely_origin`、`amplifiers`、跨平台 `platform_families`、`cluster_precision_score`、`merge_recommendation`、`merge_confidence_score`、`merge_evidence`、`official_regulatory_profile`、`independent_confirmation`、`fact_confidence_score`、`crisis_priority_score`、`evidence_gaps`、`next_tracking_sources` 和事件级边证据；强相似、同关键词、同日序列和跨平台证据会被标记为 `merge-as-same-incident`，用于把新闻、论坛、社媒、视频和监管线索按“同一事件”口径研判，而不是重复计算为多个独立危机；`independent_confirmation` 会按新闻、社媒/论坛、公开评价/投诉、社区、视频、官方/监管等免费源族计算独立确认分，并对明显重复搬运扣分，区分“同源转载放大”和“多源独立证实”；当簇内证据含 `regulatory`、`official-consumer-protection`、`regulatory-alert`、`regulatory_notice` 或 `consumer_protection_notice` 时，会提高事实可信度和危机优先级，并在危机简报里提示优先核对官方声明、监管公告、召回或安全警示原文；连续采集计划会把缺首发、缺独立确认、缺公开反馈、缺社媒放大、缺新闻确认或高传播事件簇映射成 `event-cluster-gap` 优先级，必要时触发 `scan-event-cluster-source`。多事件/有传播边的事件簇会额外标记 `twoHopCollection`，摘要暴露 `event_cluster_two_hop_signal_sources` 和独立确认簇数量，用于把二跳补采来源拉入下一轮免费源扫描。
- 来源可信度评分：`GET /api/sentiment/source-credibility` 会把来源质量、来源可靠性、覆盖新鲜度、证据 `source_weight_tier`、事实主张加权置信度、可信证据比例、协同放大风险和高风险未证实主张合并成 `credibility_score` 与 `credibility_label`；事件簇报告会同步暴露 `source_credibility`，让首发/放大者研判同时带上可信来源、弱可信来源和交叉验证建议。
- 来源发现候选：`GET /api/sentiment/source-discovery` 会从已捕获 evidence 页面的 `raw_html`、canonical/OG URL 和 metrics 中提取 RSS/Atom、sitemap、站内搜索/主题页、作者/频道主页和关联域名候选，输出 `candidate_type`、`score`、`evidence_count`、`source_keys`、`source_weight_tiers`、`reasons` 和人工复核建议；来自 `regulatory`、`official-consumer-protection`、`regulatory-alert` 等高权重证据的候选会获得更高来源发现分。`GET /api/sentiment/source-discovery/validate` 支持 `types=author-profile,rss-feed,sitemap` 只读轻量验证：作者/频道会抓取公开 profile 页面并提取标题、简介、作者名、近期内容链接和品牌/风险关键词命中；RSS/Atom 会验证 HTTP 可访问、可解析 item、item 链接和关键词命中；sitemap 会统计 URL、文章型路径、feed URL、栏目线索和关键词命中，用来筛出可长期追踪的免费源、爆料源/KOL/频道页和站点级公开内容入口。`GET /api/sentiment/source-discovery/deep-crawl-plan` 会把验证通过的 RSS item、sitemap 文章 URL 和作者/频道近期链接去重后转成具体深抓取目标，输出 `target_type`、`priority_score`、`priority_reasons`、`source_weight_tiers`、`suggested_collector`、已采集过滤结果和 seen 过滤结果；官方/监管/安全警示来源会追加 `official-or-regulatory-source-tier` / `regulatory-alert-source-tier` 优先级原因，使有限 deep crawl 预算优先抓取官方回应、监管公告、召回和安全警示正文。默认会过滤已经处理过的 URL，传 `include_seen=true` 可复核历史目标。`POST /api/sentiment/source-discovery/deep-crawl-plan/execute` 默认 dry-run，只返回将抓取的目标，传 `apply:true` 后才会抓取公开 HTML、抽取正文/作者/发布时间/canonical/OG 信息并写入 `sourceDiscoveryDeepCrawl` evidence，并把 URL、域名、状态、ETag 和 Last-Modified 写入 `sourceDiscoveryDeepCrawl.config.discoveryDeepCrawlCursor`，减少重复抓取。deep crawl 入库会写入 `deep_crawl_quality_score`、`deep_crawl_quality_label`、关键词命中、正文/HTML 长度和元数据完整度；低质页面会作为 `sourceDiscoveryDeepCrawl` 的 source quality sample 进入域名级质量治理，用于后续 deny/tighten 策略。`POST /api/sentiment/source-discovery/policy` 默认 dry-run，只把高分 RSS 候选生成 `rssFeeds.config.feeds` patch；传 `apply:true` 后会先轻量抓取候选 RSS，验证 HTTP 可访问、可解析 item、并命中品牌/风险关键词后才写入配置；传 `track_profiles:true` 时会把验证通过的作者/频道候选写入 `duckDuckGo.config.discoveredProfiles`，传 `track_domains:true` 时会把高分 sitemap/站内主题页候选写入 `duckDuckGo.config.discoveredDomains`，后续扫描会自动生成 `site:候选域名或路径 品牌/风险词` 公开搜索查询来追踪爆料源、KOL、频道页、站点主题页和新出现的公开内容。所有应用都会记录 `source-discovery-policy` 审计，可用既有 audit rollback 回滚。
- Deep crawl 结构化解析：公开 URL 深抓取会额外解析 JSON-LD `NewsArticle` / `Article` / `SocialMediaPosting` / `VideoObject` / `Review`、OG/Twitter meta、canonical、`articleBody`、结构化作者、发布时间、修改时间、栏目、图片、评论/讨论入口、RSS/Atom alternate 和 sitemap 链接。结构化正文会优先用于 evidence `content_text`，相关字段写入 `deep_crawl_jsonld_*`、`deep_crawl_comment_*`、`deep_crawl_feed_candidates`、`deep_crawl_sitemap_candidates` 和质量评分原因，用来支撑商业级证据深度、评论补采和后续来源发现。结构化 feed/sitemap hints 会进入 `source-discovery` candidates，评论/讨论入口会进入后续 `deep-crawl-outlink` 目标，让一次深抓取自动扩大下一轮免费源覆盖范围。
- 评价/投诉二跳结构化深抓：`deep-crawl-review-comments`、`deep-crawl-review-pagination`、`deep-crawl-review-page` 和 `deep-crawl-review-profile` 目标会优先抽取 JSON-LD `Review` 与常见 HTML review/comment 卡片，把评论正文、作者、发布时间、评分、平均评分和评论块数量写入 `deep_crawl_review_*` 指标，并把评论正文优先作为 evidence `content_text`，用于补齐公开评价页的分页评论、用户评论和投诉跟进证据深度。
- 公开源阻断识别：deep crawl 会识别 HTTP 401/403/429/451，以及 200 页面里的 captcha、人机验证、Cloudflare/JS challenge、登录墙、robots/访问拒绝等内容级阻断；这类目标不会作为薄证据入库，而是写入 `access-barrier-*` source quality sample、执行结果和 domain quality profile，用于后续自动降频、冷却、修复或切换替代免费源。
- 阻断域名替代补采：`/api/sentiment/collection-jobs/recoverable-followups` 会从近期 `access-barrier-*` deep-crawl 样本中生成 `access-barrier-alternate` 可恢复任务，把被验证码、登录墙、429 或访问拒绝阻断的 URL/域名转成品牌/风险关键词，并路由到 RSS、Google News、DuckDuckGo、GDELT、公开评价/投诉、区域投诉、Reddit、YouTube 等健康免费源，避免单个公开域名阻断造成覆盖空窗。
- 阻断替代补采成效：`GET /api/sentiment/collection-quality/access-barrier-alternates` 会汇总 `access-barrier-alternate` 任务的待执行、成功、失败、补到 evidence 数、有效替代源和被阻断域名；同时按内容深度、风险词、高风险/负面标记、来源权重、failover 归因、证据类型和重复/搜索页信号计算 `best_quality_score`、`average_quality_score`、`strong_evidence_count`、`trusted_evidence_count`、`high_risk_evidence_count` 和 `quality_reasons`，输出 `promote-high-quality-alternate-source`、`promote-effective-alternate-source`、`keep-alternate-but-tighten-quality`、`try-different-alternate-family` 或 `wait-for-alternate-results` 建议，用于区分“有补采结果”和“补到可支撑商业研判的强证据”。
- 有效替代源自动提权：连续采集计划会读取阻断替代补采成效，把已补到高质量 evidence 的免费替代源标记为 `access-barrier-alternate-effective`，并把补偿质量分、强证据数、可信源证据数和高风险证据数写入优先级原因；强补偿证据会获得更高优先级、补偿关键词和轻量采集预算，弱补偿结果只保留审计信号并要求收紧质量，避免免费公开源范围扩大后引入噪声。
- Deep crawl 强制复查 seen URL 时会读取 cursor 中保存的 ETag/Last-Modified，发送 `If-None-Match` / `If-Modified-Since`；若公开源返回 HTTP 304，则只更新 cursor 和统计，不重复解析 HTML 或写入 evidence。
- Deep crawl 会从已抓取公开页面中抽取高相关 outlinks，过滤资源文件、登录/隐私等低价值链接，并把同域文章型链接、RSS/sitemap/作者页、命中品牌/风险词的链接写入 evidence metrics 和 cursor；下一轮 `deep-crawl-plan` 默认会把这些链接作为 `deep-crawl-outlink` 二跳候选继续补抓，用来发现原始声明、后续报道、评论页或作者页。
- Deep crawl 执行接口支持显式 `followup_limit` / `followupLimit`，连续采集执行支持 `discovery_deep_crawl_followup_limit`；传入大于 0 时，同一轮会按 outlink 评分限量抓取二跳页面，并把 follow-up evidence、`followup_fetched_count` 和结果明细返回。连续采集在未显式传 follow-up 参数时会根据 deep-crawl 计划自动判断：普通候选仍为 0；官方/监管候选给 1 个二跳预算，召回/安全警示类 `regulatory-alert` 候选给 2 个二跳预算。二跳目标会继承父级 `source_weight_tiers`，并优先抓取 official response、statement、recall、safety alert、notice、timeline 等官方回应/风险后续链接。
- 官方/监管后续补采：连续采集会从近期 `regulatory`、`official-consumer-protection`、`regulatory-alert` 证据中派生 `official_regulatory_followup_signal`，把命中的品牌/风险词扩展到 Google News、DuckDuckGo、GDELT、RSS，以及 Reddit、YouTube、PTT、Dcard、Threads、Mastodon、Bluesky 等公开讨论源。新闻/搜索/RSS 会获得较高优先级和轻量预算提升，用于补抓媒体跟进、公开搜索结果和官方后续声明；社媒/论坛源会获得平台化关键词，用于确认公众讨论和扩散链。
- 官方/监管 follow-up 信号 API：`GET /api/sentiment/official-regulatory-followup-signals` 只读输出近期官方/监管/召回/安全警示证据触发的补采信号，包含 `summary`、按来源分组的 `signals`、`priorityBoost`、`tiers`、`reasons`、`suggestedKeywords` 和样本 URL，方便审查为什么 Google News、DuckDuckGo、GDELT、RSS 或公开讨论源会被临时拉入下一轮补采。官方/监管补采关键词会过滤 `and/the/customers/reported` 等弱词，优先保留已配置品牌词、风险词和 refund/complaint/recall/statement/response/timeline 等业务词，避免补采查询变宽。
- Sitemap 验证会识别公开 `sitemapindex`，限量展开同域子 sitemap，把子 sitemap 中的文章 URL、RSS/Atom URL 纳入 `article_candidates` / `feed_candidates` 和 deep crawl 目标；跨域子 sitemap 会被跳过，避免把免费源采集扩散到不可控站点。
- Sitemap 条目会保留 `lastmod`、News sitemap 的 `news:title` 和 `news:publication_date`，输出到 `article_candidate_details`；deep crawl 目标会使用新闻标题作为标题，并对新近 sitemap 条目加入 `fresh-sitemap-entry` / `recent-sitemap-entry` 优先级，提升最新公开报道和声明的抓取精度。
- RSS/Atom 验证会保留 item 的 `pubDate` / `published` / `updated`，deep crawl 目标会带上 `published_at` 并对新近 feed item 加入 `fresh-feed-entry` / `recent-feed-entry` 优先级；当页面本身缺少发布时间元数据时，入库 evidence 会回退使用 feed item 时间，减少旧 feed 内容挤占抓取预算。
- 实体召回趋势：`GET /api/sentiment/entity-recall-trend` 会把实体召回按时间桶拆分，输出 `persistent-gap`、`worsening`、`improving`、`stable-covered` 等趋势，识别长期缺失的新闻、搜索、社区、论坛、社媒或视频覆盖，避免把持续盲区误判为单次扫描波动。
- 实体主题召回趋势：`GET /api/sentiment/entity-topic-recall-trend` 会把“实体 × 风险主题/场景”的召回缺口按时间桶拆分，输出持续缺失的 `persistent_missing_families`、`persistent_weak_families`、趋势标签和建议关键词，用来判断 `品牌 + 退款 + Dcard/YouTube` 这类缺口是长期盲区还是一次性波动。扫描执行会合并当前缺口和趋势信号，对 `persistent-gap` / `worsening` 的主题进一步增强对应来源提权、预算和平台专属 `sourceKeywords`。
- 关键词源族覆盖矩阵：`GET /api/sentiment/keyword-source-family-coverage` 会从最近已入库舆情出发，按关键词统计新闻、搜索、论坛、社媒、社区、视频、公开评价/投诉等免费源族是否覆盖，输出 `missing-family` / `weak-family` / `covered`、建议补采源和 source-specific 查询词；连续采集会把缺失源族映射成 `keyword-source-family-coverage-gap` 优先级，避免已经出现的风险词只停留在单一新闻源或单一社媒源，推动下一轮补齐视频、论坛、投诉/评价和搜索侧证据。
- 采集运行健康：`GET /api/sentiment/collection-operations` 会把连续采集计划、来源新鲜度、到期/卡住的 collection job、retry 积压和来源质量退避合并成后端运行报告，输出 `healthy` / `watch` / `degraded` / `critical` 来源、`due_pending_jobs`、`stale_running_jobs`、推荐下一步动作和可执行来源列表。它用于无人值守采集巡检，避免免费公开源长时间无成功采集、队列积压或 running job 卡死后仍被误认为系统正常。
- 采集运行自动补救：`GET/POST /api/sentiment/collection-operations/remediation` 会把 `critical` / `degraded` 来源转成可审计的 `collection-operations-remediation` 补采任务，默认 dry-run，只生成计划；`apply:true` 后写入 `sentiment_collection_jobs`。当 YouTube、论坛、社媒、新闻/RSS、公开评价/投诉等免费源长期无成功采集、卡住、冷却或被节流时，系统会把同一批品牌/风险关键词路由到健康替代免费源，保留原异常来源、问题、推荐动作、操作人和原因，避免单一来源故障造成覆盖盲区。
- 采集运行补救成效：`GET /api/sentiment/collection-quality/operations-remediation` 会评估 `collection-operations-remediation` 任务是否真正补到有效证据，按“原异常源 -> 替代源”输出补采 job 数、证据数、`best_quality_score`、`average_quality_score`、强证据/可信证据/高风险证据数、样本 URL 和建议。连续采集会把高质量补救结果转成 `collection-operations-remediation-effective` 优先级原因，并给有效替代源轻量预算提升，让系统把已验证有效的免费源纳入后续监控闭环。
- 多语言查询质量闭环：`GET /api/sentiment/collection-quality/multilingual-queries` 会从已入库舆情和扫描日志 `metadata.sourceKeywords` 中识别英文、简中、繁中、日文、韩文及东南亚风险查询词，统计有效证据数、高风险/负面命中、0 结果率、失败率、来源分布、推荐语言和待收紧语言。连续采集会把高质量多语言词转成 `multilingual-query-quality` 优先级原因和 source-specific 查询词，同时把高 0 结果或高失败词在对应来源上降噪，避免多语言扩展只扩大搜索范围却降低精确性。
- 噪声与重复压制：`GET /api/sentiment/collection-quality/noise-suppression` 会合并来源质量画像、来源内关键词画像、近似内容簇和有效声量精度，识别低质来源、高重复转载来源、高失败来源和高 0 结果/低质来源内关键词。连续采集会把高噪声来源转成 `noise-suppression` 优先级原因，必要时进入 `wait-noise-suppression-repair` / `wait-noise-suppression-backoff`，并把对应来源的低质关键词加入 per-source suppress 列表，避免扩源后被重复聚合页、搜索页和无效词消耗免费采集预算。
- 实时源族覆盖补扫：`GET /api/sentiment/realtime-source-coverage` 会以实时热点主题为输入，检查新闻/搜索、社媒、论坛/社区、视频、公开评价/投诉等免费源族是否都有近期覆盖；当高风险或负面热点只出现在单一来源族时，会输出缺失源族、候选来源、建议关键词和 `fill-realtime-source-family-gaps` 建议。连续采集会把该结果转成 `realtime-source-family-coverage` 优先级原因和 `scan-realtime-coverage-source` 动作，推动等待中的 PTT、Dcard、Threads、YouTube、公开投诉/评价等来源进入本轮轻量补扫。
- 免费源目标池覆盖治理：`GET /api/sentiment/free-source-target-coverage` 会审计公开评价、垂直软件/产品评价、电商评价和区域投诉/消保来源的 target catalog，按官方/监管、消保、投诉、评价、B2B、App/扩展、电商、台湾、美国、英国、欧盟、日本、韩国、印度、东南亚等 profile 检查覆盖缺口。连续采集会把缺口转成 `free-source-target-coverage` 优先级和 `scan-free-source-target-coverage-source` 动作，并把缺失地区/行业/风险场景合成 source-specific 查询词，例如 `品牌 + Taiwan complaint`、`品牌 + regulatory warning`、`品牌 + marketplace review`，避免公开源只覆盖少数地区或少数平台。
- 证据链缺口补采：`GET /api/sentiment/evidence-chain-gaps` 会合并证据深度评分和危机简报证据完整度，按事件/URL/简报范围识别缺正文上下文、缺评论互动、缺作者时间、缺官方/监管、缺首发传播、缺事实声明、缺视频后续或缺引用上下文的链路短板。连续采集会把高分缺口转成 `evidence-chain-gap` 优先级和 `scan-evidence-chain-source` 动作，并把对应样本标题、缺口维度和建议来源转成 source-specific 查询词；扫描执行还会为新闻/RSS/搜索、YouTube、论坛/社区、公开评价/投诉和社媒引用上下文动态提高普通采集与深抓取预算。
- 实体召回策略：`GET/POST /api/sentiment/entity-recall-gaps/policy` 会把实体召回缺口转成可执行 search/source patch。默认 dry-run；`apply:true` 后可写回 `monitoredEntities.platformHints`、`keywordExpansion.queryTemplatePacks`、完整扫描预算和 RSS `feedPacks`，并记录 `entity-recall-policy` 审计。
- Dashboard 覆盖摘要：`GET /api/sentiment/dashboard` 的 `stats.entityRecall` 会返回实体召回缺口 summary、趋势 summary 和优先级最高的缺口实体，方便在总览层发现品牌/产品/竞品覆盖不足及长期盲区。
- 采集预算与深扫：`/api/sentiment/search-settings` 支持 `collectionBudget` 和 `deepCollectionBudget`，分别控制快速/完整/watch 扫描的分页采集、每关键词最大条数、每条评论深采集数量和引用上下文采集开关；新闻/RSS、公开搜索、技术社区、去中心化社媒、PTT、Dcard、Threads/Instagram 公开索引和 YouTube 已接入预算控制，完整扫描可进行受控分页、公开页元数据解析或评论/引用深搜，watch 默认关闭高成本深采集。
- 采集任务队列：每次扫描会先把免费来源拆成 `sentiment_collection_jobs`，按 source 记录计划查询词、实体扩展词、优先级、预算、状态、尝试次数、冷却时间、结果数和失败数；`GET /api/sentiment/collection-jobs` 可按批次、来源或状态查询任务，便于审计禁用、节流、冷却、失败和成功来源。
- 采集任务重试计划：`GET /api/sentiment/collection-jobs/retry-plan` 会筛选 `failed`、`partial`、`cooldown`、`throttled`、`interval` 且未超过最大尝试次数的任务，结合 open 高风险告警/事件、实体召回长期缺口和 source family 缺口输出 `priority_score`、`priority_reasons`、下一次重试时间、剩余次数和建议动作；`POST /api/sentiment/collection-jobs/requeue` 默认 dry-run，`apply:true` 后创建新的 `pending` retry job，保留原失败任务作为审计证据。
- 可恢复后续采集任务：`GET /api/sentiment/collection-jobs/recoverable-followups` 会把 source-discovery 深抓目标和社媒后续追踪信号转成可审计的 pending collection job，不会立即执行；`POST /api/sentiment/collection-jobs/recoverable-followups` 默认 dry-run，`apply:true` 后写入任务队列，并保存 `task_type`、目标/信号证据、操作人/原因、优先级原因、source-weight tier。官方/监管/召回/安全警示目标会获得更高优先级和更多重试次数，使深抓与扩散路径补采在进程重启后仍可恢复。
- 到期重试消费：`POST /api/sentiment/collection-jobs/execute-due` 会执行已到期的 `pending` retry job，只跑对应 source/query 并写回任务状态、来源日志和新采集结果；后台调度每轮扫描前也会轻量消费少量到期 retry job，避免失败免费源必须整批重跑。
- 连续采集计划：`GET /api/sentiment/continuous-collection-plan` 会把来源扫描间隔、source cooldown/domain throttle、到期 retry、来源覆盖健康、来源质量健康、可靠性报告、来源可信度、实体主题盲区、实时热点主题、多窗口近实时异常、异常突发信号、证据完整度缺口、事件簇二跳补采信号、source discovery 深抓取候选和商业基准修复计划合并成下一轮免费源采集队列，输出 `ready_scan_sources`、`priority_score`、`priority_reasons`、`source_quality_signal` 和 `discovery_deep_crawl` 子计划；当某个关键词/品牌在短窗口内声量、负面、高风险或源族覆盖快速升温时，计划会以 `realtime-hot-topic` 原因触发 `scan-realtime-hot-topic-source` 并补抓新闻、社媒、视频、论坛、公开评价/投诉等免费源族；当 5/15/60 分钟等短窗口出现声量、负面、高风险或跨平台加速度异常时，计划会以 `realtime-anomaly-window` 原因触发 `scan-realtime-anomaly-window-source`；当负面占比突变、高权重来源声量突增或跨平台扩散速度异常仍处于 open 状态时，计划会把异常证据里的平台映射回 PTT、Dcard、Threads、Instagram、Mastodon、Bluesky、YouTube、Google News、RSS/GDELT 等免费来源，并以 `anomaly-burst` 原因触发 `scan-burst-source`；当来源质量画像显示高有效率、高健康分且有事件贡献时，计划会以 `source-quality-health` 提高优先级；当来源失败率或低质量率过高时，计划会退避为 `wait-source-quality-repair` 或 `wait-source-quality-backoff`，避免免费公开源预算被不稳定或噪声来源消耗；当 `source-credibility` 发现官方监管、消保、可信媒体或高 `source_weight_tier` 证据来源时，计划会提升对应来源优先级，必要时触发 `scan-trusted-source` 建立高可信样本基线；当 `commercial-remediation-plan` 发现某些来源需要可靠性修复、覆盖补强、主题深度补齐或证据补采时，计划会以 `commercial-readiness-gap` 原因提高对应来源优先级，并可触发 `scan-commercial-benchmark-source`，让等待中的高价值来源临时进入本轮扫描；扫描执行还会把热点主题、多窗口异常、异常证据、证据缺口、事件簇和商业主题缺口里的品牌词、风险词和平台提示组合成 source-specific 查询词，例如 `品牌 + 退款 + YouTube`，写入 `sourceKeywordPlans` 和 source log metadata，避免补扫只选对来源却搜索过宽或过浅；`POST /api/sentiment/continuous-collection/run` 会先消费到期 retry，再只扫描计划选中的来源，并在 `discovery_deep_crawl.should_execute` 时限量执行公开 URL 深抓取，返回 `deepCrawlResult`。请求体可用 `discovery_deep_crawl:false` 禁用、`discovery_deep_crawl_limit` 控制补抓数量，避免每轮全源扫一遍造成免费公开源限流。
- 告警/事件触发补扫：连续采集计划会把 open 的 critical/high 告警和高风险事件映射回 Google News、DuckDuckGo、RSS/GDELT、PTT、Dcard、Threads、Instagram、Mastodon、Bluesky、YouTube 等免费来源，写入 `alert_event_signal` 和 `alert-event-urgency` 优先级；强信号可触发 `scan-alert-event-source`，并把告警标题、品牌词、风险词和平台提示合成 source-specific 查询词，同时提高可深采来源的正文、评论和引用上下文预算。
- 重试质量反馈：`GET /api/sentiment/collection-jobs/quality-feedback` 会把 retry job 成功率、失败率、0 结果率、source quality 低质率、相关性和质量分结合起来，输出 `tighten-content-controls`、`reduce-retry-budget-or-expand-query`、`require-entity-risk-cooccurrence`、`repair-source-before-more-retries` 等建议，避免低质量免费源反复消耗采集预算。
- 重试质量策略应用：`GET/POST /api/sentiment/collection-jobs/quality-feedback/policy` 会把质量反馈转成可执行 source/search patch。默认 dry-run；`apply:true` 后可写回全局 `contentControls`、来源 `queryStrategy`、重试预算/扫描间隔等配置，并记录 `retry-quality-feedback-policy` 审计，支持通过既有 audit rollback 回滚。
- 域名级质量治理：`GET /api/sentiment/source-quality/domains` 会按来源+域名聚合公开采集样本，输出低质率、低相关率、重复率、有效率、事件贡献和 `deny-domain` / `allowlist-candidate` 等建议；`GET/POST /api/sentiment/source-quality/domains/policy` 默认 dry-run，`apply:true` 后只把高证据噪音域名写入对应来源的 `config.domainControls.denyDomains`，记录 `domain-quality-policy` 审计并支持回滚，不会停用整个免费来源。`sourceDiscoveryDeepCrawl` 是默认禁用的辅助治理源，不参与普通 source 扫描，但会读取自己的 `domainControls.denyDomains`；当 deep crawl 低质样本触发策略后，后续公开 URL 深抓取会在请求前跳过已拉黑域名并记录 `domain-blocked` 样本。
- 动态采集预算：扫描执行时会结合来源质量、有效率、失败率、低质率、事件贡献、优先级和风险词命中，为不同来源动态放大或收缩页数/条数；单个来源也可在 `sentiment_sources.config.collectionBudget` 中覆盖预算。扫描返回值和 `sentiment_scan_source_logs.metadata` 会记录每个来源实际使用的预算，便于审计覆盖深度。
- 自适应深采集预算：扫描执行时会基于来源质量、传播图追踪信号、异常突发信号、证据完整度缺口、事件贡献、覆盖缺口、实体主题盲区、失败率、低质率、来源恢复状态和深采集健康画像，为每个来源动态计算 `deepBudget`，并在扫描结果 `sourceDeepBudgets` 与 source log metadata 中记录实际值。高质量/高贡献/正在扩散、异常升温、长期缺失风险主题且历史深采集有效的 YouTube、Bluesky、Threads、Instagram、RSS/新闻/社区来源会在完整扫描或高风险手动扫描中加深公开页、评论、答案、论坛回复或引用上下文采集；当危机简报缺评论/回复、引用上下文、相关视频或正文证据时，对应 YouTube、论坛/社区、Bluesky/Threads/Instagram、新闻/RSS/搜索来源也会加深对应 collector；噪音、限流、失败率高、处于修复策略或深采集证据价值低的来源会自动变浅。`sentiment_sources.config.deepCollectionBudget` 可覆盖单源深采集预算，watch 实时通道默认保持浅采集，避免免费公开源压力失控。
- 证据缺口反哺采集：连续采集计划会读取最近危机简报里的 `fact_findings.evidence_completeness`，把缺正文/页面内容映射到 Google News、RSS、DuckDuckGo、GDELT、Yahoo/Taiwan News，把缺评论/回复映射到 YouTube、PTT、Dcard、Reddit、GitHub/GitLab Issues、Hacker News、Stack Overflow、Discourse，把缺引用/转述上下文映射到 Bluesky、Threads、Instagram/Mastodon，把缺相关视频映射到 YouTube，并以 `evidence-completeness-gap` 提高对应免费来源优先级；扫描执行会进一步把这些缺口转成 source-specific 查询词，例如 `品牌 + 留言 + YouTube`、`品牌 + 爆料 + RSS`、`品牌 + 官方聲明 + Google News`，写入 `sourceKeywordPlans` 和 source log metadata 的 `evidenceGapSignal`；`continuous-collection-plan.summary` 会暴露 `evidence_gap_signal_sources` 和最低证据完整度分数。
- 深采集健康画像：`GET /api/sentiment/deep-collection-health` 会把 YouTube watch 评论、watch 相关视频、频道后续视频、Bluesky 引用上下文、社区评论和 Threads/Instagram 公开页元数据拆成独立 collector，聚合 evidence/comment 数量、事件贡献、平均评论数、元数据完整度、有效证据率、健康分和 `expand-deep-budget` / `reduce-deep-budget` / `needs-more-samples` 建议；扫描执行会读取这些建议，自动给高价值 collector 增加深采集页数/评论量，给低价值 collector 降低深采集预算。
- 证据深度评分：`GET /api/sentiment/evidence-depth` 会按每条 evidence 评估原始 URL、标题、正文/HTML、canonical/OG、作者/频道、发布时间、评论/回复、互动指标、来源权重和结构化字段，输出 `depth_score`、`depth_level`、缺口和补采建议；用于区分“搜到薄摘要”和“可支撑商业研判的完整证据”。连续采集计划会把薄证据/不足证据映射回 Google News、RSS、DuckDuckGo、GDELT、YouTube、论坛、社区和评价/投诉源，以 `evidence-depth-gap` 提升优先级，并把缺口转成 source-specific 查询词，例如 `品牌 + 留言 + YouTube`、`品牌 + 官方聲明 + Google News`。
- 覆盖感知补扫：扫描执行会读取来源覆盖/SLA 评分，把 `stale`、`under-covered` 或弱贡献来源提升排序并增加采集预算，把 `noisy`、`blocked` 来源压缩预算；扫描返回值会输出 `sourceCoverageSignals`，每个单源日志也会在 `metadata.coverageSignal` 中保留状态、分数、问题和建议。
- 来源恢复动作：扫描会为每个来源生成 `recoveryAction`，针对 `HTTP 429`、`HTTP 403`、timeout/连接异常、噪音高、过期和覆盖不足分别给出退避重试、查询瘦身、替代来源、收紧过滤或补扫建议；扫描返回值输出 `sourceRecoveryActions`，单源日志保存在 `metadata.recoveryAction`。
- 来源级查询策略：扫描执行会把 `recoveryAction.queryStrategy` 应用到每个来源的实际查询词；`thin-risk-first` 优先品牌词和风险词，`minimal` 用于受限来源降噪降频，`require-entity-and-risk-term` 让高噪音来源只跑实体+风险共现词，`metadata.sourceKeywords` 和 `sourceKeywordPlans` 可审计每个来源实际搜索范围。
- 替代来源补偿：当某个来源处于 429/403/冷却等不可运行状态时，扫描会把该来源瘦身后的高风险查询词临时合并到健康且已启用的替代免费源；扫描结果输出 `sourceFailoverPlans`，替代源日志会在 `metadata.failoverReceived` 中记录补偿来源、原因和关键词。
- 补偿证据归因：通过替代源采集到的公开结果会在 evidence metrics 中保存 `failover_attribution` 和 `failover_from_sources`；`GET /api/sentiment/collection-quality` 会区分替代源的 `failover_received_count` 与被补偿源的 `failover_compensated_count`，避免把补偿覆盖误判为原始来源健康。
- 来源恢复摘要：`GET /api/sentiment/source-recovery` 会把来源覆盖、质量画像、可靠性日报、最近扫描日志、恢复动作和 failover 归因汇总成可执行清单，输出 `critical/high/medium/low` 优先级、`operator_action`、`playbook.actions`、`playbook.config_hints`、`reliability`、`reliability_policy`、最新冷却/错误信息和补偿方向，帮助运营直接判断该修哪个免费源、如何调整配置。
- 来源限速治理：扫描执行会为每个免费来源维护 domain-level throttle window，成功后保持最小请求间隔，遇到 429/403/timeout 会自适应放大退避；`GET /api/sentiment/source-throttle`、`GET /api/sentiment/status` 和扫描结果会输出 `sourceThrottle`，`source-schedule` 会显示 `throttled`、`throttle_domain`、`throttle_until` 和原因。
- 后台实时调度：`POST /api/sentiment/monitor` 启动普通 scheduled scan 的同时，会按 `highRiskWatch.intervalMinutes` 启动独立 watch 定时器；`GET /api/sentiment/status` 返回 `watchEnabled`、`watchIntervalMs` 和 `nextWatchRunAt`，便于确认高风险实时发现通道是否运行。
- 来源可靠性日报：`GET /api/sentiment/source-reliability` 会按来源聚合最近 N 天扫描日志，输出成功率、失败率、冷却率、节流率、平均耗时、采集量、top failure reasons、每日趋势和 `reliable/watch/rate-limited/unstable/no-data` 状态，帮助运营区分短期节流和长期不稳定免费源。
- 可靠性策略建议：`GET/POST /api/sentiment/source-reliability/policy` 会根据可靠性日报生成可执行 source patch。默认 dry-run；`apply:true` 后写回 `scan_interval_minutes`、`config.throttle`、`config.queryStrategy`、`config.collectionBudget` 等设置，并记录 `source-reliability-policy` 审计。
- Playbook 预览/应用：`POST /api/sentiment/source-recovery/playbook` 支持 `source_key`、`actions`、`apply`。默认只返回 source/search settings diff；传入 `apply:true` 后才写回来源配置或搜索设置，可把 `queryStrategy`、`scan_interval_minutes`、RSS `feedPacks`、`contentControls`、`collectionBudget` 等建议应用到系统。
- Playbook 应用审计：`GET /api/sentiment/source-recovery/audit` 可按来源查看已应用恢复策略的审计记录，包含操作者、原因、动作、source/search patch 和当时的恢复摘要，便于复盘免费来源被限流、补偿、扩容或降噪后的配置变化。
- Playbook 回滚：`POST /api/sentiment/source-recovery/audit/:id/rollback` 默认只返回回滚 diff；传入 `apply:true` 后会把审计记录里的 source/search settings `before` 写回，并追加 `source-recovery-rollback` 审计，支持错误恢复策略快速撤销。
- 事件驱动扩展：`/api/sentiment/search-settings` 支持 `eventExpansion`。扫描前会读取最近未解决/高风险事件，从事件标题、摘要、实体、风险词和平台线索生成扩展查询词，并暴露 `eventExpansionKeywords`，让系统自动追踪危机后续扩散，而不只依赖初始品牌词。
- 扩散阶段研判：`/api/sentiment/spread-graph` 的事件节点会输出 `propagation_stage`、`tracking_priority`、`tracking_reasons`、`next_tracking_sources`、`propagation_path_score`、`propagation_score_label` 和 `propagation_score_breakdown`，根据首发置信、放大节点、跨平台路径、边权重、风险等级、互动强度、时间跨度和图边方向判断事件处于首发、跨平台扩散、放大或降温阶段，并给出可排序的传播路径风险分。
- 传播路径置信度：`/api/sentiment/spread-graph` 会在事件边输出 `propagationConfidence`、`propagationConfidenceLabel` 和证据原因，并在节点输出 `propagation_confidence_score`、`propagation_confidence_label`、`propagation_confidence_reasons` 与 breakdown，用来区分高置信传播链、弱证据关联和需要补采的路径。
- 低置信传播链补采：连续采集计划会把高传播分但低 `propagation_confidence_score` 的事件转成 `propagation-confidence-gap` 来源信号；缺首发证据会补 Google News/RSS/DuckDuckGo/GDELT，缺边证据会补搜索和新闻，缺时间线或跨平台确认会补 Threads、Dcard、PTT、YouTube、Reddit 等公开社媒/评论来源，并把补采关键词写入 source-specific 查询计划。
- 叙事来源/转载/放大分类：`/api/sentiment/spread-graph` 的事件节点会输出 `likely_origin`、`narrative_flow` 和 timeline item 的 `narrative_role`、`origin_candidate_score`、`origin_candidate_reasons`、`origin_selected`，区分 `origin-candidate`、`repost-or-aggregation`、`cross-platform-amplifier`、`media-follow-up`、`discovery-index` 等角色；首发候选评分会降低搜索索引、转帖/转载/聚合和视频后续内容的首发置信，并提高有发布时间、作者、新闻/RSS、公开社媒原帖或社区原帖信号的候选；事件簇会在跨事件传播链里选择最高置信 `likely_origin`，避免把最早被搜索引擎收录或明显转帖的页面误判为源头。事件边会输出 `narrativeRelation`，帮助判断新闻到社媒、社媒到媒体跟进或下游转述路径。
- 视频扩散链识别：`/api/sentiment/spread-graph` 会读取 YouTube 深采集 evidence metrics，把 watch 页相关视频和同频道后续视频标记为 `video-follow-up`，并在 `narrative_flow.video_followup_count` 和 timeline 的 `video_relation`、`related_to`、`channel_id` 中保留传播关系，帮助区分搜索命中、相关推荐和同频道后续扩散。
- 社媒二跳发现信号：`GET /api/sentiment/social-followup-signals` 会从已采集证据和评论里聚合 Bluesky 引用上下文、YouTube 相关视频/同频道后续、评论爆点、作者/账号连续发帖等信号，输出 `signal_type`、`reasons`、`priorityBoost`、`suggested_sources`、`suggested_keywords` 和样本 URL。连续采集计划会把这些信号转成 `social-followup-signal` 优先级，必要时触发 `scan-social-followup-source`，并把“引用/转述/评论/后续影片/作者最新”等二跳词写入对应 YouTube、Bluesky、Threads、Mastodon、PTT、Dcard、Reddit 查询计划。`POST /api/sentiment/social-followup-signals/policy` 支持 dry-run/apply，把高分社媒二跳账号、频道或作者主页写入 `duckDuckGo.config.discoveredProfiles` 的长期 `site:` 追踪范围，并记录 `social-followup-policy` 审计用于回滚。
- 相似内容传播链：事件边会计算跨平台标题/正文 token 相似度，输出 `contentSimilarity`、`sharedContentTokens` 和 `similar-content` 传播原因；不同关键词但内容高度相似的新闻、社媒、论坛线索也能连成传播链。
- 作者/账号追踪：传播图节点会输出 `author_signals`、`repeated_authors` 和 `author_influence_score`，综合主贴作者、评论作者、出现次数、平台和互动信号，识别重复出现或可能放大事件的账号。
- 追踪源自动调度：扫描执行和连续采集计划会把传播图里的 `next_tracking_sources`、`tracking_priority` 与 `propagation_path_score` 聚合成 `sourceTrackingSignals` / `tracking_signal`，自动提高对应免费来源的采集预算、深采预算、执行排序和计划优先级，并写入 `sentiment_scan_source_logs.metadata.trackingSignal`，让扩散研判直接反哺下一轮数据收集。
- 可信度驱动查询策略：扫描执行会把 `source-credibility` 转成来源级 `queryStrategy` 与 `contentControls`。官方监管、消保和高 `source_weight_tier` 来源会自动使用 `expand-pages` 并提高采集/深采预算；低可信、协同放大风险或存在未证实高风险声明的来源会自动收窄为 `require-entity-and-risk-term` / `thin-risk-first`，并提高最低相关性和质量阈值，减少免费搜索噪声。
- 来源原创/搬运识别：`GET /api/sentiment/source-credibility` 会把近似内容簇反推到来源级 `content_origin_profile`，输出 `origin_count`、`repost_count`、`originality_rate`、`repost_rate`、跨平台搬运数、样本 URL 和原创/搬运标签；高原创来源获得轻微加权，高搬运或跨平台复制来源会被扣分并要求交叉验证。
- 原创度驱动采集调度：连续采集计划会读取 `content_origin_profile`。高原创来源会提高 `source-credibility` 优先级、使用 `expand-pages` 并增加采集/深采预算；高搬运或跨平台复制来源会降低优先级、收紧为 `require-entity-and-risk-term`，并减少采集/深采预算，避免免费搜索资源被重复转载源消耗。
- 采集质量闭环：`GET /api/sentiment/collection-quality` 会按来源、关键词、来源内关键词和作者聚合有效事件贡献、0 结果、低质样本、失败率和建议动作；扫描执行会读取 `collectionQualityFeedback`，自动提前高贡献关键词、抑制证据充分的低质扩展词，并把来源贡献信号纳入动态预算。来源内关键词画像会写入扫描日志的 `metadata.sourceKeywordQualityFeedback`，让某个来源上的低质/0 结果词只在该来源降权，不误伤其他来源。
- 增量游标：`/api/sentiment/search-settings` 支持 `incremental` 配置。定时扫描会基于每个来源的 `last_success_at` 加重叠窗口过滤旧内容，Google News、GDELT、RSS、台湾新闻 RSS、GitHub Issues、GitLab Issues、Reddit、Hacker News、Stack Overflow、Discourse、Mastodon、Bluesky、YouTube 已接入；手动扫描仍保留全量覆盖。
- 连续采集调度：调度器默认每 5 分钟检查一次，实际执行由每个来源的 `scan_interval_minutes`、冷却状态、启用状态和来源质量健康决定；`GET /api/sentiment/status` 和 `GET /api/sentiment/source-schedule` 会输出每个来源的 `due`、`waiting`、`cooldown`、`next_scan_at` 和实时源标记，便于对社媒实时发现与新闻/RSS深扫做不同频率治理。
- 来源覆盖/SLA 评分：`GET /api/sentiment/source-coverage` 会结合来源配置、扫描日志和质量画像输出 `coverage_score`、`status`、`issues`、`recommendation`、最近扫描/成功年龄和来源新鲜度 SLA，用于识别 `stale`、`blocked`、`noisy`、`under-covered`、`disabled` 等采集缺口。
- 本地证据全文检索：SQLite FTS5 会把舆情主记录、原始证据、评论、事实声明和事件聚类统一建成本地证据索引；`GET /api/sentiment/evidence-search?q=...` 支持按 `sentiment/evidence/comment/fact_claim/event` 类型检索，`POST /api/sentiment/search-index/rebuild` 可重建索引，中文查询会结合 FTS 和 LIKE 回退；AI 分析助手和危机简报会自动引用这些深层证据，避免依赖任何付费搜索/向量 API。
- 事实声明与矛盾检测：`processSentimentIntelligence()` 会从舆情正文、原始证据和评论中抽取事实声明，按 `financial/service/fraud/privacy/legal/response/evidence` 分类，并标记 `asserted/denied/disputed/resolved/questioned` 立场；每条声明会结合官方/媒体/评论来源、source quality、domain quality、来源优先级等生成 `source_reputation_score` 与 `weighted_confidence`，`GET /api/sentiment/fact-claims/summary` 会聚合 verified、repeated-claim、disputed、unsupported-allegation、trusted_evidence_count 等状态，危机简报会带入事实发现和矛盾项，帮助区分多源佐证、官方否认、低可信转载和单点指控。
- 作者可信度与协同扩散：`GET /api/sentiment/author-reputation` 会按作者/账号聚合发帖、评论、平台数、重复内容、互动和风险信号，输出 `reputation_score`、`coordination_risk_score` 与 `label`；`GET /api/sentiment/coordinated-amplification` 会按相似内容、短时间爆发、跨平台搬运、低可信作者聚集识别疑似协同扩散，传播图和危机简报会带入这些信号，避免把同一作者或低可信账号群的重复搬运误判成自然声量。
- 近似内容簇：`GET /api/sentiment/content-similarity-clusters` 会按 `content_fingerprint` 和相似 token 聚合同一内容的跨平台转载、搬运和轻微改写，输出 `cluster_score`、`shared_tokens`、平台/作者/URL 样本和处理建议，用来在声量统计和危机研判中区分自然新增舆情与重复扩散。
- 有效声量精度：`GET /api/sentiment/volume-precision` 会把近似内容簇折算成 `raw_volume`、`effective_volume`、`duplicate_amplification_rate`、`precision_score` 和按关键词/平台/来源拆分的去重口径，帮助告警阈值使用真实独立声量，同时保留原始声量作为触达和扩散参考。
- 去重驱动告警：内置 `volume:` / `negative:` 指标告警会优先使用有效独立声量触发，单平台重复转载不会直接抬高危机等级；跨平台重复放大仍会触发追踪型 volume 信号，并在告警消息中暴露原始声量、有效声量和重复放大率。
- 公开视频/引用/社区回复/社媒公开页/应用评论/公开评价站/垂直产品评价/电商评价/区域投诉深采集：YouTube 公开 feed 命中后会按 `deepCollectionBudget.maxCommentsPerItem` 读取公开视频页里的 `ytInitialData` 评论片段，把可见评论作为 `sentiment_comments` 保存；同一 watch 页里的相关视频会在预算允许时作为新的 YouTube 舆情线索入库，并记录 `youtube_related_video` 证据；若 feed 暴露 `yt:channelId`，系统还会读取公开 channel feed，把同频道近期后续视频作为 `youtube_channel_video` 证据入库，帮助追踪同一事件的后续视频扩散；App Store / Google Play 公开评论会保存 `app_store_review` / `google_play_review` 证据和星级、版本、国家/地区、package id 等指标；公开评价/投诉站会保存 `public_review_site_result` 证据和目标站点标签；垂直产品/社区评价源会保存 `vertical_review_source_result` 证据和产品域名标签；电商/市场公开评价源会保存 `ecommerce_review_source_result` 证据和市场/商品域名标签；区域投诉/消费者保护源会保存 `regional_complaint_source_result` 证据和投诉/监管标签；Bluesky 公开搜索会按 `captureQuotedContext` 把 quoted post 的作者、正文和 URI 作为深层评论证据保存；GitHub/GitLab Issues、Reddit、Hacker News、Stack Overflow 和 Discourse 会按同一预算抓取 issue notes、post comments、comment tree、answers 或 topic replies；Threads/Instagram 公开搜索命中后可按预算读取公开页面的 OG/JSON-LD 元数据，提取作者、发布时间、贴文正文和社媒证据指标。相关证据都会进入本地证据检索、事实声明抽取、作者画像和协同扩散分析，不使用任何付费 API。
- 域名精确控制：`/api/sentiment/search-settings` 支持 `domainControls.allowDomains` 和 `domainControls.denyDomains`，公开来源入库前会统一执行域名 allow/deny 过滤并记录 source-quality 样本，便于排除低质站或只跟踪重点媒体/社区。
- 内容精确控制：`/api/sentiment/search-settings` 支持 `contentControls.requireAnyTerms`、`contentControls.excludeTerms`、`minRelevanceScore`、`minQualityScore`，可在公开结果入库前排除同名噪音、体育/百科/模板等误报，并保留跳过原因用于来源质量分析。
- 来源治理：`sentiment_sources` 的启用/禁用、优先级和来源配置会真实驱动扫描执行，并持久化扫描批次与单源执行日志。
- 文章元数据采集：公开搜索/RSS 命中文章可保存正文摘要、原始 HTML 片段、站点名、canonical URL、OG URL、作者、发布时间和 `og:image` 视觉证据。
- 精确去重：入库前规范化公开 URL，移除常见追踪参数，并优先使用 canonical/OG URL 合并跨来源重复文章；新闻、RSS、搜索来源还会生成 `content_fingerprint`，压缩轻微改写的转载/聚合命中，同时保留社媒来源用于扩散路径研判。
- 低质过滤：公开采集结果会综合关键词相关性、正文长度、页面类型、低信息量、关键词堆砌、作者信号、互动指标和百科/模板/搜索页特征评分，过滤低质量命中。
- 公开舆情事件图谱：公开新闻、论坛、社媒采集结果会进入低风险事件聚类，传播图谱按时间方向标记首发、放大和接收节点，并输出来源权重、互动强度、时间间隔和传播原因。
- 来源质量画像：按来源统计有效率、低质率、重复率、失败率、平均质量分、事件贡献和调优建议，用于后续自动调度来源优先级。
- 自动来源调度：可根据来源画像自动调整来源优先级和扫描间隔；定时扫描会尊重每个来源的 `scan_interval_minutes`，手动扫描仍可按需触发。
- 传播路径基础：自动生成事件之间的关键词、平台、时间相近、来源权重和互动变化关系边，可用于后续图谱展示和首发/搬运/放大研判。
- 危机研判简报：对高风险事件生成本地规则版研判，包含严重度、信心、根因假设、关键证据、应对策略、建议动作和暂定对外口径；简报会读取传播图的 `propagation_path_score`、传播阶段、可能首发和下一步追踪来源，把高传播路径风险写入 `fact_findings.propagation_path`、`propagation_path` 证据和行动建议，形成采集、传播图、危机研判闭环。简报还会匹配 `event_cluster`，把整簇事件数、传播边、簇信心、首发候选、放大者、证据缺口和二跳追踪源写入 `fact_findings.event_cluster` 与 `event_cluster` 证据，用来研判同一危机下的首发、搬运、媒体跟进和社媒放大。简报还会计算 `fact_findings.evidence_completeness`，按正文/页面内容、评论/回复、首发来源、跨平台传播、事实声明、引用/转述上下文、相关视频/后续内容评估证据完整度，低完整度会降低本地信心分并生成 `evidence_completeness` 证据和补采动作；同时写入 `fact_findings.source_credibility` 和 `source_credibility` 证据，区分可信来源、弱可信来源和需交叉验证来源，避免把未核实转传直接当作事实。
- AI 增强研判：支持 OpenAI-compatible Chat Completions 接口。`POST /api/sentiment/crisis-briefs` 传入 `{"ai":true}` 后会尝试调用模型生成深度研判；模型未配置或失败时自动回退本地规则简报。
- AI 设置支持 `clearApiKey:true` 或 `apiKey:null` 显式清除已保存密钥。
- 高级异常预警：持久化负面占比突变、高权重来源声量突增、跨平台扩散速度异常，并生成 `anomaly:*` 告警用于危机早期发现。
- 传播图谱 API：输出事件节点、关系边、首发/放大/接收角色、传播路径评分和 `summary.top_propagation_nodes`，供前端绘制扩散路径，也可直接用于后端危机研判、采集调度和重点来源追踪。
- AI 分析助手：`POST /api/sentiment/ask` 支持 `{"ai":true}`，基于本地引用证据调用已配置模型生成研判回答。
- 处置闭环：告警支持状态流转、负责人、动作记录、备注、到期时间和动作更新。
- 视觉/OCR 基础：支持保存图片/截图 URL、OCR 文本、logo/object/scene 标签，并按资产 hash 去重后通过 API 查询。

## 测试

```bash
npm test
npm run sentiment:demo
```
