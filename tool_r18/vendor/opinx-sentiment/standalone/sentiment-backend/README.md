# OpinX Sentiment Backend

This is a standalone backend for the CRM sentiment collection system. It does not start Electron or any frontend UI.

## Run

From the repository root:

```powershell
node .\standalone\sentiment-backend\src\server.js
```

Open the Web UI:

```text
http://127.0.0.1:8787
```

The first screen is the sentiment search workspace. Users can enter a brand, product, person, or event keyword, choose fast/full/watch scan mode, start public-source matching, and review the generated analysis report plus matched evidence.

Run the backend-only demo flow:

```powershell
npm run sentiment:demo
```

The demo uses a temporary data directory by default. To keep the demo database:

```powershell
npm run sentiment:demo -- --data-dir D:\data\opinx-sentiment-demo
```

Optional environment variables:

```powershell
$env:PORT = "8787"
$env:SENTIMENT_DATA_DIR = "D:\data\opinx-sentiment"
$env:SENTIMENT_SCHEDULER = "0"
$env:SENTIMENT_INTERVAL_MINUTES = "30"
$env:SENTIMENT_AI_ENABLED = "1"
$env:SENTIMENT_AI_BASE_URL = "https://your-model-host/v1"
$env:SENTIMENT_AI_API_KEY = "..."
$env:SENTIMENT_AI_MODEL = "your-crisis-model"
node .\standalone\sentiment-backend\src\server.js
```

Default data directory:

```text
%USERPROFILE%\.opinx-sentiment
```

The backend writes:

- `crm.db`
- `sentiment-config.json`

## API

Base URL:

```text
http://127.0.0.1:8787
```

Common endpoints:

- `GET /health`
- `GET /api/sentiment`
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
- `GET /api/sentiment/free-source-target-coverage`
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
- `GET /api/sentiment/continuous-collection-plan`
- `POST /api/sentiment/continuous-collection/run`
- `POST /api/sentiment/collection-jobs/execute-due`
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
- `GET /api/sentiment/keyword-source-family-coverage`
- `GET /api/sentiment/collection-operations`
- `GET /api/sentiment/collection-operations/remediation`
- `POST /api/sentiment/collection-operations/remediation`
- `GET /api/sentiment/collection-quality/operations-remediation`
- `GET /api/sentiment/collection-quality/multilingual-queries`
- `GET /api/sentiment/collection-quality/noise-suppression`
- `GET /api/sentiment/realtime-source-coverage`
- `GET /api/sentiment/evidence-chain-gaps`
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

Example:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:8787/api/sentiment/keywords `
  -ContentType "application/json" `
  -Body '{"keyword":"捐款 客服"}'

Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:8787/api/sentiment/scan `
  -ContentType "application/json" `
  -Body '{"mode":"fast"}'

Invoke-RestMethod -Method Put `
  -Uri http://127.0.0.1:8787/api/sentiment/search-settings `
  -ContentType "application/json" `
  -Body '{"keywordExpansion":{"aliases":["BBY"],"competitors":["競品A"],"industryTerms":["公益平台"],"customTerms":["退費爭議"],"riskTerms":["投訴","詐騙","爆料"],"queryTemplatePacks":["complaints","trustSafety"],"customQueryTemplates":["{term} 官方聲明"]},"collectionBudget":{"fast":{"maxPagesPerKeyword":1,"maxItemsPerKeyword":10},"full":{"maxPagesPerKeyword":3,"maxItemsPerKeyword":25}},"deepCollectionBudget":{"fast":{"maxPagesPerKeyword":0,"maxCommentsPerItem":0,"captureQuotedContext":false},"full":{"maxPagesPerKeyword":2,"maxCommentsPerItem":40,"captureQuotedContext":true},"watch":{"maxPagesPerKeyword":0,"maxCommentsPerItem":0,"captureQuotedContext":false}},"incremental":{"enabled":true,"overlapMinutes":60},"domainControls":{"allowDomains":["news.example.tw"],"denyDomains":["spam.example"]},"contentControls":{"requireAnyTerms":["客服","款項"],"excludeTerms":["NBA","棒球"],"minRelevanceScore":35,"minQualityScore":40}}'
```

## Sources

The backend uses the existing sentiment collectors:

- Yahoo Taiwan Search
- Google News Taiwan RSS
- DuckDuckGo
- GDELT
- Generic RSS / Atom feeds with built-in `chineseNews`, `consumerProtection`, `regulatoryNotices`, `globalTech`, `security`, and `business` feed packs, including official consumer-protection, recall, safety-alert, and regulatory notice feeds
- GitHub Issues public search with issue comment enrichment
- GitLab Issues public search with issue note enrichment
- Reddit public search with post comment enrichment
- Hacker News public search with comment-tree enrichment
- Stack Overflow public search with answer enrichment
- Discourse public forum search with topic reply enrichment
- Threads / Instagram public-index search with bounded public-page OG/JSON-LD metadata extraction
- YouTube public feed search with bounded watch-page visible comment extraction, related-video discovery, and public channel-feed follow-up discovery
- Bluesky public search with optional quoted-post context capture

`search-settings.deepCollectionBudget` controls the default deep collection budget for fast/full/watch lanes, including public-page fetches, visible comments, YouTube related/channel videos, issue notes, answers, forum replies, and quoted context. The runner adapts the per-source `deepBudget` from source quality, propagation tracking, anomaly bursts, evidence completeness gaps, contribution, coverage gaps, entity-topic blind spots, recovery state, and deep collector health. Strong anomaly bursts and crisis evidence gaps can deepen pages, comments, quoted context, or YouTube related/channel follow-ups for capable free sources while the high-risk watch lane remains shallow to avoid overloading public sources. Individual sources can override it with `sentiment_sources.config.deepCollectionBudget`; scan results expose `sourceDeepBudgets`, and scan jobs/source logs record the actual `deepBudget` used for audit and tuning.

The spread graph preserves YouTube deep-video relationships: watch-page related videos and channel-feed follow-ups appear in event timelines as `video-follow-up` items with `video_relation`, `related_to`, and `channel_id` evidence. Spread graph nodes also expose `propagation_path_score`, `propagation_score_label`, and a score breakdown for origin confidence, amplification, cross-platform movement, edge strength, and urgency.
- Mastodon / ActivityPub public tag timelines
- Bluesky public AppView search
- PTT
- Dcard
- Threads public-index fallback
- Instagram public-index fallback
- YouTube public video feed discovery

Threads and Instagram are public search-index fallbacks, not logged-in or official API crawlers.

## Implemented proposal capabilities

- Raw JSON archive for every ingested sentiment item.
- Structured NLP-style fields: tokens, extracted keywords, emotion labels, demographic hints, entities, topics, geo tags, competitor tags, KOL score, spread score, influence score, and action suggestion.
- RAG-style local question answering over the sentiment database through `/api/sentiment/ask`.
- Competitor/topic comparison through `/api/sentiment/compare`.
- CSV export and report schedule records.
- Workspace/customer fields for multi-customer isolation at the API and storage layer.
- Source configuration records for per-platform enablement, interval, priority, and metadata. Enabled state and priority now drive the scan runner.
- Evidence records for raw JSON, raw HTML, text, metrics, URL, and future screenshot paths.
- Comment records for forum/social discussion depth, including comment-level sentiment and risk.
- Configurable alert rules for negative bursts, high-risk items, and cross-platform spread.
- Deeper PTT/Dcard collection: PTT article body and push comments; Dcard detail and comments with graceful fallback.
- YouTube public video discovery for video-level sentiment leads.
- Generic RSS/Atom collection with built-in `chineseNews`, `consumerProtection`, `regulatoryNotices`, `globalTech`, `security`, and `business` free feed packs. The consumer/regulatory packs use official public feeds such as FTC consumer protection, FTC Data Spotlight, CFPB newsroom, CPSC recalls and Federal Register notices, FDA recalls / food-safety recalls / MedWatch safety alerts, Canada consumer-product / food / health-product recalls, UK GOV.UK product-safety and drug/device alert Atom feeds, Product Safety Australia recalls, and SEC releases to capture complaint, fraud, recall, health/product safety, enforcement, and public-warning signals without paid APIs. `GET /api/sentiment/rss-feed-packs` lists available packs; the `rssFeeds` source config accepts `feedPacks` plus extra `feeds`, and evidence metrics preserve `feed_pack`, `source_family`, `feed_tags`, `regulatory`, and `source_weight_tier` markers so official consumer-protection, regulatory, and safety-alert feeds participate in credibility and evidence-depth scoring.
- Configurable query expansion through `/api/sentiment/search-settings`: brand aliases, competitor names, industry terms, custom terms, risk-word combinations, and query template packs are expanded into scan queries for all free public sources. `GET /api/sentiment/query-template-packs` lists built-in `complaints`, `crisis`, `trustSafety`, `socialDiscovery`, `officialResponse`, and `regulatorySafety` packs, including official statement/response, recall, regulatory warning, safety alert, and product-safety searches.
- Monitored entity governance through `/api/sentiment/search-settings` and `GET/PUT /api/sentiment/monitored-entities`: brands, aliases, products, executives, competitors, typo variants, negative phrases, and platform hints are normalized as structured entities. Scan planning prioritizes entity-derived `monitoredEntityKeywords` so crisis monitoring is not limited to a single raw keyword.
- High-risk realtime watch lane: `/api/sentiment/search-settings.highRiskWatch` configures lightweight high-frequency sources, crisis terms, keyword limits, and source budget. `POST /api/sentiment/watch-scan` or `/api/sentiment/scan` with `reason:"watch"` runs only the `high-risk-watch` lane, combining brand/entity terms with complaint, fraud, leak, boycott, and other risk terms without consuming full deep-scan capacity.
- Per-source incremental cursors: successful scheduled/watch scans write `incrementalCursor` into `sentiment_sources.config`, including lastSuccessfulAt, since, executed keywords, result count, and failure count. Later scheduled/watch scans prefer this cursor with an overlap window to reduce repeated RSS/search/community collection, while manual scans remain available for full investigation.
- Entity recall gap report: `GET /api/sentiment/entity-recall-gaps` evaluates monitored entities across source families such as news, search, community, forums, social, and video. It returns `missing_families`, `weak_families`, `recall_score`, and source/keyword expansion recommendations for brands, products, people, or competitors with insufficient public coverage.
- Entity-topic source recall report: `GET /api/sentiment/entity-topic-source-recall-gaps` drills monitored entity plus risk-scenario coverage down to concrete free sources such as `youtube`, `dcard`, `googleNews`, and `rssFeeds`. It reports `missing-source-topic`, `weak-source-topic`, source-specific keywords, and `strengthen-source-topic-query:*` recommendations, and scan planning folds those exact source gaps back into `entityTopicSignal`.
- Entity recall trend report: `GET /api/sentiment/entity-recall-trend` buckets entity recall over time and labels `persistent-gap`, `worsening`, `improving`, `stable-covered`, or `stable-gap` trends. This separates one-off collection misses from long-running blind spots across news, search, community, forum, social, and video source families.
- Entity-topic recall trend report: `GET /api/sentiment/entity-topic-recall-trend` buckets monitored entity plus risk-scenario recall over time, exposing persistent missing/weak source families and suggested keywords. It helps distinguish durable brand-risk-platform blind spots from one-off free-source collection misses. Scan execution merges current gaps with persistent or worsening trends so durable blind spots receive stronger source priority, budget, and source-specific query terms.
- Entity recall policy suggestions: `GET/POST /api/sentiment/entity-recall-gaps/policy` turns entity recall gaps into executable search/source patches. It dry-runs by default; with `apply:true`, it can update `monitoredEntities.platformHints`, `keywordExpansion.queryTemplatePacks`, full-scan budget, and RSS `feedPacks`, then records an `entity-recall-policy` audit entry.
- Dashboard coverage summary: `GET /api/sentiment/dashboard` includes `stats.entityRecall` with gap summary, trend summary, and the highest-priority monitored entities lacking sufficient source-family coverage.
- Configurable multilingual query expansion through `/api/sentiment/search-settings`: `keywordExpansion.includeMultilingual` is enabled by default and uses local risk-term packs, not paid translation APIs. `multilingualLocales`, `multilingualRiskTerms`, and `maxMultilingualTerms` control English, Simplified Chinese, Traditional Chinese, Japanese, Korean, Hong Kong/Taiwan, and Southeast Asian complaint/refund/scam/recall query combinations so free public sources can surface cross-region brand risk.
- Configurable collection budget through `/api/sentiment/search-settings`: `collectionBudget.fast/full` controls pages and maximum items per keyword. News/RSS, public search, developer/community sources, decentralized social sources, PTT, Dcard, Threads/Instagram public indexes, and YouTube all use this budget for bounded deep collection.
- Collection job queue: each scan is decomposed into `sentiment_collection_jobs` before source execution. Jobs keep source, planned query terms, entity expansion context, priority, budget metadata, status, attempts, cooldown time, result count, and failure count. `GET /api/sentiment/collection-jobs` filters by batch, source, or status for source-level audit and retry planning.
- Collection job retry planning: `GET /api/sentiment/collection-jobs/retry-plan` selects retryable `failed`, `partial`, `cooldown`, `throttled`, and `interval` jobs that still have attempts left, then combines open high-risk alerts/events, entity recall trend gaps, and source-family gaps into `priority_score` and `priority_reasons` before returning next retry time, remaining attempts, and recommended action. `POST /api/sentiment/collection-jobs/requeue` dry-runs by default; `apply:true` creates a new `pending` retry job while preserving the original failed job for audit.
- Recoverable follow-up queue planning: `GET /api/sentiment/collection-jobs/recoverable-followups` converts source-discovery deep-crawl targets and social follow-up signals into auditable pending collection jobs without running them immediately. `POST /api/sentiment/collection-jobs/recoverable-followups` dry-runs by default; `apply:true` writes jobs with `task_type`, target/signal evidence, operator/reason metadata, priority reasons, source-weight tiers, and higher retry budgets for official/regulatory/recall/safety-alert targets. Deep crawl and social spread-path follow-ups can therefore survive process restarts and be retried through the same free-source job queue.
- Due retry execution: `POST /api/sentiment/collection-jobs/execute-due` consumes due `pending` retry jobs and runs only the original source/query plan, then updates job status, source logs, and newly collected sentiment items. The scheduler also consumes a small number of due retry jobs before each scheduled scan so failed free sources can recover without rerunning the full batch.
- Continuous collection planning: `GET /api/sentiment/continuous-collection-plan` merges source intervals, source cooldown/domain throttle, due retry jobs, coverage health, reliability reports, source credibility, entity-topic gap signals, realtime hot topics, realtime anomaly windows, free-source target coverage gaps, propagation tracking signals, open anomaly bursts, source-discovery deep-crawl candidates, and commercial remediation signals into a ranked free-source queue with `ready_scan_sources`, `priority_score`, `priority_reasons`, and `discovery_deep_crawl`. `GET /api/sentiment/realtime-hot-topics` compares each keyword's current short-window volume, negative/high-risk mix, source weight, source-family coverage, and spread velocity against the previous window; hot topics add a `realtime-hot-topic` priority reason and can trigger `scan-realtime-hot-topic-source` for free news, RSS, search, public review/complaint, forum, social, and video sources. `GET /api/sentiment/realtime-anomaly-windows` compares 5-minute, 15-minute, 1-hour, 6-hour, and 24-hour windows for volume, source-weight, negative/high-risk acceleration, cross-platform acceleration, and spread velocity; strong sub-hour or cross-platform signals add `realtime-anomaly-window` and can trigger `scan-realtime-anomaly-window-source`. `GET /api/sentiment/free-source-target-coverage` audits public review, vertical product/software review, ecommerce review, and regional complaint/consumer-protection target catalogs for missing official/regulatory, consumer-protection, complaint, B2B, app, marketplace, and regional profiles; gaps add `free-source-target-coverage` priority and source-specific queries such as `brand + regulatory warning`, `brand + Taiwan complaint`, or `brand + marketplace review`. Fresh negative-ratio, source-weight, or spread-velocity anomalies are mapped back to concrete free sources such as PTT, Dcard, Threads, Instagram, Mastodon, Bluesky, YouTube, Google News, RSS, and GDELT; high burst priority adds an `anomaly-burst` reason and can trigger `scan-burst-source` even when the normal source interval is still waiting. High credibility or high `source_weight_tier` sources add a `source-credibility` reason and can trigger `scan-trusted-source` to build fresh evidence from official, regulatory, consumer-protection, or otherwise trusted public sources. Scan execution also converts hot-topic, realtime anomaly-window, target-coverage, and anomaly evidence terms into source-specific query plans such as `brand + refund + YouTube`, persisted in `sourceKeywordPlans` and source log metadata, so rescans stay precise instead of merely broad. `POST /api/sentiment/continuous-collection/run` consumes due retry jobs first, scans only planned sources, and when `discovery_deep_crawl.should_execute` is true, runs a bounded public URL deep crawl that returns `deepCrawlResult`; request bodies can set `discovery_deep_crawl:false` or `discovery_deep_crawl_limit`.
- Alert/event-triggered rescanning: open critical/high alerts and high-risk events now produce `alert_event_signal` source signals and an `alert-event-urgency` priority reason. Strong signals can trigger `scan-alert-event-source` for waiting free sources, convert alert titles, brand terms, risk terms, and platform hints into source-specific query plans, and deepen capable sources for body, comment, and quoted-context collection.
- Credibility-driven query precision: scan execution converts source credibility into source-level query strategy and content controls. Official, regulatory, consumer-protection, or high `source_weight_tier` sources can use `expand-pages` with larger collection/deep budgets, while weak, low-trust, coordinated-risk, or unsupported high-risk claim sources are tightened to `require-entity-and-risk-term` / `thin-risk-first` with higher relevance and quality thresholds.
- Source discovery candidates: `GET /api/sentiment/source-discovery` extracts candidate RSS/Atom feeds, sitemaps, site-search/topic pages, author/channel profiles, and related domains from captured evidence page HTML, canonical/OG URLs, and evidence metrics. Candidates expose `source_weight_tiers`, and candidates discovered from `regulatory`, `official-consumer-protection`, or `regulatory-alert` evidence receive stronger scores. `GET /api/sentiment/source-discovery/validate` supports `types=author-profile,rss-feed,sitemap` for read-only lightweight validation: author/channel pages are fetched for title, description, author name, recent links, profile signals, and keyword hits; RSS/Atom feeds are checked for HTTP access, parsed items, item links, and brand/risk keyword hits; sitemaps are scored by URL count, article-like paths, feed URLs, section hints, and keyword hits. `GET /api/sentiment/source-discovery/deep-crawl-plan` turns validated RSS items, sitemap article URLs, and author/channel recent links into deduplicated concrete deep-crawl targets with `target_type`, `priority_score`, `priority_reasons`, `source_weight_tiers`, `suggested_collector`, captured-target filtering, and seen-target filtering; official/regulatory/safety-alert sources get `official-or-regulatory-source-tier` and `regulatory-alert-source-tier` priority reasons so bounded deep-crawl budgets prefer official responses, regulatory notices, recalls, and safety alerts. `include_seen=true` can be used for review. `POST /api/sentiment/source-discovery/deep-crawl-plan/execute` dry-runs by default; `apply:true` fetches public HTML, extracts body/author/published time/canonical/OG metadata, and writes `sourceDiscoveryDeepCrawl` evidence with `deep_crawl_quality_score`, quality label/reasons, keyword hits, body/HTML length, and metadata completeness. Executions persist URL/domain/status plus ETag and Last-Modified hints into `sourceDiscoveryDeepCrawl.config.discoveryDeepCrawlCursor` to reduce repeat fetching. Low-quality deep-crawl pages are recorded as `sourceDiscoveryDeepCrawl` source-quality samples so domain-quality policy can later deny or tighten noisy hosts. `POST /api/sentiment/source-discovery/policy` dry-runs by default and turns high-score RSS candidates into `rssFeeds.config.feeds` patches; `apply:true` first validates candidate feeds with a lightweight fetch, parsed item count, and brand/risk keyword hits, then writes reviewed feeds. Passing `track_profiles:true` writes validated author/channel candidates into `duckDuckGo.config.discoveredProfiles`; passing `track_domains:true` writes high-score sitemap/topic candidates into `duckDuckGo.config.discoveredDomains`. Later scans generate `site:candidate-host-or-path brand/risk-term` public-search queries to track tipster, KOL, channel, topic, and site-scope pages. Applied changes record a rollback-capable `source-discovery-policy` audit.
- Deep-crawl structured extraction: public URL deep crawls now parse JSON-LD `NewsArticle` / `Article` / `SocialMediaPosting` / `VideoObject` / `Review`, OG/Twitter metadata, canonical links, structured `articleBody`, author, published/modified times, section, image, comment/discussion entrypoints, RSS/Atom alternates, and sitemap links. Structured article body can become evidence `content_text`; extracted fields are stored as `deep_crawl_jsonld_*`, `deep_crawl_comment_*`, `deep_crawl_feed_candidates`, `deep_crawl_sitemap_candidates`, and quality reasons for deeper commercial evidence, comment backfill, and follow-up source discovery. Structured feed/sitemap hints flow into `source-discovery` candidates, and comment/discussion entrypoints flow into later `deep-crawl-outlink` targets so one deep crawl can expand the next free-source collection round.
- Review/complaint two-hop structured deep crawl: `deep-crawl-review-comments`, `deep-crawl-review-pagination`, `deep-crawl-review-page`, and `deep-crawl-review-profile` targets prioritize JSON-LD `Review` plus common HTML review/comment cards, then store review text, authors, published times, ratings, average rating, block counts, and dedicated `deep_crawl_review_*` metrics. Review text is preferred as evidence `content_text`, so public review pagination, comments, and complaint follow-ups become deeper evidence instead of generic page captures.
- Public-source access barrier detection: deep crawl now classifies HTTP 401/403/429/451 plus 200 pages that are actually captcha, human verification, Cloudflare/JavaScript challenge, login wall, robots denial, or access-denied pages. Those targets are not stored as thin evidence; they are recorded as `access-barrier-*` source quality samples, execution results, and domain quality signals for later backoff, cooldown, repair, or alternate free-source routing.
- Access-barrier alternate recovery jobs: `/api/sentiment/collection-jobs/recoverable-followups` can turn recent `access-barrier-*` deep-crawl samples into `access-barrier-alternate` pending jobs. Blocked URLs/domains are converted into brand/risk queries and routed to healthy free sources such as RSS, Google News, DuckDuckGo, GDELT, public review/complaint sources, regional complaint sources, Reddit, and YouTube so one blocked public domain does not create a coverage gap.
- Access-barrier alternate effectiveness: `GET /api/sentiment/collection-quality/access-barrier-alternates` reports pending/success/failed alternate jobs, recovered evidence counts, effective alternate sources, blocked domains, and compensation quality fields such as `best_quality_score`, `average_quality_score`, `strong_evidence_count`, `trusted_evidence_count`, `high_risk_evidence_count`, and `quality_reasons`. Recommendations now distinguish `promote-high-quality-alternate-source`, `promote-effective-alternate-source`, `keep-alternate-but-tighten-quality`, `try-different-alternate-family`, and `wait-for-alternate-results`, so a noisy alternate result is not treated the same as deep, trusted, high-risk evidence.
- Effective alternate-source promotion: continuous collection reads access-barrier alternate effectiveness and adds an `access-barrier-alternate-effective` priority reason for alternate sources that recovered quality evidence. The signal feeds source-specific keywords plus light collection/deep-budget boosts, with stronger boosts for high-quality, trusted, or high-risk recovered evidence and weaker treatment for thin compensation results.
- Forced deep-crawl review of seen URLs uses cursor ETag/Last-Modified values as `If-None-Match` / `If-Modified-Since`; HTTP 304 updates only the cursor/statistics path and skips HTML parsing plus duplicate evidence writes.
- Deep crawl extracts high-signal outlinks from captured public pages, filters low-value assets/login/privacy links, stores relevant article/feed/sitemap/profile/risk-term links in evidence metrics and cursor state, and feeds them back into the next `deep-crawl-plan` as `deep-crawl-outlink` two-hop targets for original statements, follow-up reports, comment pages, or author/profile pages.
- Deep-crawl execution supports explicit `followup_limit` / `followupLimit`; continuous collection supports `discovery_deep_crawl_followup_limit`. Values above zero fetch a bounded set of high-score outlinks in the same run and return `followup_fetched_count` plus per-result follow-up details. When the continuous-collection request omits the follow-up parameter, the backend now uses the deep-crawl plan recommendation: ordinary candidates remain at zero follow-up requests, official/regulatory candidates get one same-run follow-up, and `regulatory-alert` recall/safety candidates get two. Follow-up targets inherit parent `source_weight_tiers` and prioritize official response, statement, recall, safety alert, notice, and timeline links.
- Official/regulatory follow-up collection: continuous collection derives `official_regulatory_followup_signal` from recent `regulatory`, `official-consumer-protection`, and `regulatory-alert` evidence. Matching brand/risk terms are expanded into Google News, DuckDuckGo, GDELT, RSS, Reddit, YouTube, PTT, Dcard, Threads, Mastodon, and Bluesky source-specific queries. News/search/RSS sources receive higher priority plus a lightweight budget boost for media follow-up and official statements; social/forum sources receive precise platform keywords for public-discussion and spread-path confirmation.
- Official/regulatory follow-up signal API: `GET /api/sentiment/official-regulatory-followup-signals` is read-only and returns the recent official/regulatory/recall/safety evidence that is driving media/search/social follow-up. It includes a summary, per-source signals, `priorityBoost`, tiers, reasons, suggested keywords, and sample URLs so operators can audit why Google News, DuckDuckGo, GDELT, RSS, or public discussion sources are pulled into the next collection round. Suggested keywords filter weak English filler terms such as `and`, `the`, `customers`, and `reported`, while preserving configured brand terms, risk terms, and business terms such as refund, complaint, recall, statement, response, and timeline.
- Sitemap validation recognizes public `sitemapindex` files and expands a bounded number of same-domain child sitemaps so article URLs and RSS/Atom URLs inside nested sitemaps become `article_candidates`, `feed_candidates`, and deep-crawl targets. Cross-domain child sitemaps are skipped to keep free-source collection controlled.
- Sitemap entries preserve `lastmod`, News sitemap `news:title`, and `news:publication_date` in `article_candidate_details`; deep-crawl targets use the news title and boost fresh/recent sitemap entries with `fresh-sitemap-entry` / `recent-sitemap-entry` priority reasons.
- RSS/Atom validation preserves item `pubDate` / `published` / `updated`; deep-crawl targets carry `published_at` and boost fresh/recent feed items with `fresh-feed-entry` / `recent-feed-entry` priority reasons. When the fetched page lacks published-time metadata, inserted evidence falls back to the feed item time so stale feed content is less likely to consume deep-crawl budget.
- Evidence-gap collection feedback: continuous planning reads recent crisis-brief `fact_findings.evidence_completeness` and maps missing body/page evidence to news/RSS/search sources, missing comments/replies to YouTube/forums/community sources, missing quoted context to Bluesky/Threads/Instagram/Mastodon, and missing video follow-ups to YouTube. Matching sources receive an `evidence-completeness-gap` priority reason, while scan execution turns those gaps into source-specific query terms such as `brand + comments + YouTube`, `brand + expose + RSS`, or `brand + official statement + Google News`; the terms are persisted in `sourceKeywordPlans` and source log metadata with `evidenceGapSignal`. The plan summary exposes `evidence_gap_signal_sources` and the lowest evidence completeness score.
- Retry quality feedback: `GET /api/sentiment/collection-jobs/quality-feedback` combines retry job outcomes, zero-result rate, source quality low-quality rate, relevance score, and quality score to recommend `tighten-content-controls`, `reduce-retry-budget-or-expand-query`, `require-entity-risk-cooccurrence`, or `repair-source-before-more-retries`, preventing noisy free sources from repeatedly consuming collection budget.
- Retry quality feedback policy: `GET/POST /api/sentiment/collection-jobs/quality-feedback/policy` turns feedback into executable source/search patches. It dry-runs by default; `apply:true` can update global `contentControls`, source `queryStrategy`, retry collection budget, and scan interval, then records a `retry-quality-feedback-policy` audit row that can be rolled back through the existing audit rollback API.
- Entity-topic recall gaps: `GET /api/sentiment/entity-topic-recall-gaps` evaluates each monitored entity against risk scenarios such as refund, fraud, privacy, service complaints, official response, and boycott/viral backlash across news, search, forum, social, community, and video source families. It emits `suggested_keywords`, and scan planning feeds high-priority topic-gap keywords into `searchKeywords` so free-source coverage automatically expands toward missing brand-risk-platform combinations. The same signal maps missing families back to concrete free sources, boosting source order, collection budget, auditable `entityTopicSignal` scan metadata, and source-specific `sourceKeywords` such as brand-risk-YouTube terms for YouTube or brand-risk-Dcard terms for Dcard.
- Keyword source-family coverage: `GET /api/sentiment/keyword-source-family-coverage` evaluates recently collected keywords against enabled free source families such as news, search, forum, social, community, video, and public review/complaint sources. It returns `missing-family`, `weak-family`, and `covered` rows with suggested sources and source-specific keywords, then continuous collection turns those gaps into a `keyword-source-family-coverage-gap` priority reason so already-seen risk terms are expanded into missing families instead of staying trapped in one channel.
- Collection operations health: `GET /api/sentiment/collection-operations` merges the continuous collection plan with source freshness, due or stuck collection jobs, retry backlog, and quality backoff state. It returns `healthy`, `watch`, `degraded`, and `critical` source rows plus `due_pending_jobs`, `stale_running_jobs`, actionable sources, and a recommended next action so unattended free-source collection can detect stale sources, retry pressure, or stuck jobs before coverage silently degrades.
- Collection operations remediation: `GET/POST /api/sentiment/collection-operations/remediation` converts `critical` or `degraded` source health into auditable `collection-operations-remediation` pending jobs. It dry-runs by default; `apply:true` writes jobs into `sentiment_collection_jobs`, routing the same brand/risk terms from a stalled YouTube/forum/social/news/RSS/review source to healthy alternate free sources while preserving the original source, health issues, recommended actions, operator, and reason for later review.
- Collection operations remediation effectiveness: `GET /api/sentiment/collection-quality/operations-remediation` evaluates whether `collection-operations-remediation` jobs actually recovered useful evidence. It groups results by original degraded source and alternate source, reports job counts, evidence counts, `best_quality_score`, `average_quality_score`, strong/trusted/high-risk evidence counts, sample URLs, and recommendations. Continuous collection converts high-quality results into a `collection-operations-remediation-effective` priority reason plus a light budget boost for proven alternate free sources.
- Multilingual query quality feedback: `GET /api/sentiment/collection-quality/multilingual-queries` evaluates multilingual risk expansion from collected evidence and scan-log `metadata.sourceKeywords`. It reports effective evidence, high-risk/negative hits, zero-result rate, failure rate, source distribution, recommended locales, and locales that should be tightened. Continuous collection converts strong multilingual query evidence into `multilingual-query-quality` priority and source-specific keywords, while high-zero-result or high-failure terms are suppressed per source so broader free-source coverage does not trade away precision.
- Noise and duplicate suppression: `GET /api/sentiment/collection-quality/noise-suppression` combines source quality profiles, per-source keyword contribution, content-similarity clusters, and deduped volume precision. It identifies low-quality sources, repost-heavy sources, high-failure sources, and source-specific keywords with high zero-result or low-quality rates. Continuous collection converts those findings into `noise-suppression` priority, `wait-noise-suppression-repair` / `wait-noise-suppression-backoff`, lighter budgets, and per-source keyword suppression so broader free-source coverage does not waste budget on search pages, repost aggregators, or ineffective terms.
- Realtime source-family coverage: `GET /api/sentiment/realtime-source-coverage` starts from realtime hot topics and checks whether free source families such as news/search, social, forums/community, video, public reviews, and complaint sources have fresh coverage. When a high-risk topic is only visible in one family, the report returns missing families, candidate sources, suggested keywords, and `fill-realtime-source-family-gaps`. Continuous collection turns those gaps into `realtime-source-family-coverage` priority and `scan-realtime-coverage-source`, so waiting PTT, Dcard, Threads, YouTube, public review, and regional complaint sources can be pulled into a lightweight follow-up cycle without paid APIs.
- Evidence-chain gap backfill: `GET /api/sentiment/evidence-chain-gaps` merges evidence-depth scoring with crisis-brief evidence completeness to find event, URL, or brief scopes that still lack body context, comments, author/timestamp metadata, official/regulatory evidence, origin/propagation proof, fact-claim support, video follow-up, or quoted context. Continuous collection converts severe gaps into `evidence-chain-gap` priority and `scan-evidence-chain-source`, while scan execution adds source-specific keywords and expands collection/deep-crawl budgets for the free source families that can fill each gap.
- Domain-level quality governance: `GET /api/sentiment/source-quality/domains` aggregates public collection samples by source and hostname, exposing low-quality rate, low-relevance rate, duplicate rate, effective rate, event contribution, and recommendations such as `deny-domain` or `allowlist-candidate`. `GET/POST /api/sentiment/source-quality/domains/policy` dry-runs by default; `apply:true` writes only high-evidence noisy hostnames into that source's `config.domainControls.denyDomains`, records a `domain-quality-policy` audit entry, and can be rolled back without disabling the whole free source. `sourceDiscoveryDeepCrawl` is a disabled auxiliary governance source rather than a normal scheduled source; its deny domains are checked before public URL deep-crawl fetches, so noisy discovery domains can be skipped before spending requests.
- Dynamic per-source collection budget: scan execution adjusts pages/items from source quality, effective rate, failure rate, low-quality rate, event contribution, priority, and risk-term hits. Individual sources can override this through `sentiment_sources.config.collectionBudget`; scan results and `sentiment_scan_source_logs.metadata` expose the resolved budget used by each source.
- Deep collector health: `GET /api/sentiment/deep-collection-health` separates YouTube watch comments, watch-related videos, channel follow-up videos, Bluesky quoted context, community comments, and public social page metadata. It reports evidence/comment volume, event contribution, average comments per item, metadata completeness, useful evidence rate, health score, and budget recommendations such as `expand-deep-budget`, `reduce-deep-budget`, or `needs-more-samples`. Scan execution reads these local health signals to increase deep pages/comments for proven high-value collectors and reduce budget for low-value collectors without using paid APIs.
- Evidence depth scoring: `GET /api/sentiment/evidence-depth` scores each evidence document for original URL, title, body/HTML, canonical/OG metadata, author/channel, published time, comments/replies, engagement metrics, source weight, and structured fields. It returns `depth_score`, `depth_level`, missing dimensions, and suggested collection actions so thin snippets can be separated from evidence suitable for commercial crisis analysis. Continuous collection maps thin/insufficient evidence back to Google News, RSS, DuckDuckGo, GDELT, YouTube, forums, communities, and public review/complaint sources with an `evidence-depth-gap` priority reason and source-specific queries such as `brand + comments + YouTube` or `brand + official statement + Google News`.
- Coverage-aware rescanning: scan execution reads source coverage/SLA scores, boosts ordering and budget for `stale`, `under-covered`, or weak-contribution sources, and compresses budget for `noisy` or `blocked` sources. Scan results expose `sourceCoverageSignals`, and each per-source log keeps status, score, issues, and recommendation in `metadata.coverageSignal`.
- Source recovery actions: each scan derives `recoveryAction` for every source. `HTTP 429`, `HTTP 403`, timeout/connection failures, noisy sources, stale sources, and under-covered sources get structured backoff, query-thinning, alternate-source, filter-tightening, or rescan recommendations. Scan results expose `sourceRecoveryActions`, and per-source logs keep the same payload in `metadata.recoveryAction`.
- Per-source query strategies: scan execution applies each `recoveryAction.queryStrategy` to the actual keywords passed into that source. `thin-risk-first` prioritizes brand and risk terms, `minimal` reduces constrained-source noise, and `require-entity-and-risk-term` restricts noisy sources to entity+risk co-occurrence terms. `metadata.sourceKeywords` and `sourceKeywordPlans` audit the real per-source search scope.
- Alternate-source failover: when a source is blocked, rate-limited, or cooling down, scan execution temporarily merges that source's thinned high-risk keywords into healthy enabled alternate free sources. Scan results expose `sourceFailoverPlans`, and receiving-source logs keep the origin, reason, and failover keywords in `metadata.failoverReceived`.
- Failover evidence attribution: public results collected through alternate sources store `failover_attribution` and `failover_from_sources` in evidence metrics. `GET /api/sentiment/collection-quality` separates a receiver's `failover_received_count` from the blocked source's `failover_compensated_count`, so compensated coverage is not mistaken for native source health.
- Source recovery summary: `GET /api/sentiment/source-recovery` combines coverage scores, quality profiles, source reliability reports, latest source logs, recovery actions, and failover attribution into an operator checklist with `critical/high/medium/low` priority, `operator_action`, `playbook.actions`, `playbook.config_hints`, `reliability`, `reliability_policy`, latest cooldown/error context, and compensation direction.
- Source throttle governance: scan execution maintains per-domain throttle windows for free public sources. Successful requests keep a minimum interval, while 429/403/timeout failures adaptively extend backoff. `GET /api/sentiment/source-throttle`, `GET /api/sentiment/status`, and scan results expose `sourceThrottle`; source schedule rows include `throttled`, `throttle_domain`, `throttle_until`, and reason fields.
- Background realtime scheduling: `POST /api/sentiment/monitor` starts the normal scheduled scan plus an independent watch timer using `highRiskWatch.intervalMinutes`; `GET /api/sentiment/status` exposes `watchEnabled`, `watchIntervalMs`, and `nextWatchRunAt` for operational visibility.
- Source reliability daily report: `GET /api/sentiment/source-reliability` aggregates recent scan logs by source and day, returning success/failure/cooldown/throttle rates, average duration, collected counts, top failure reasons, daily trend rows, and `reliable/watch/rate-limited/unstable/no-data` status.
- Reliability policy suggestions: `GET/POST /api/sentiment/source-reliability/policy` turns reliability reports into executable source patches. It dry-runs by default; with `apply:true`, it writes settings such as `scan_interval_minutes`, `config.throttle`, `config.queryStrategy`, and `config.collectionBudget`, then records a `source-reliability-policy` audit entry.
- Playbook preview/apply: `POST /api/sentiment/source-recovery/playbook` accepts `source_key`, `actions`, and `apply`. It returns source/search settings diffs by default; with `apply:true`, it writes accepted hints such as `queryStrategy`, `scan_interval_minutes`, RSS `feedPacks`, `contentControls`, and `collectionBudget`.
- Playbook apply audit: `GET /api/sentiment/source-recovery/audit` lists applied recovery changes by source, including operator, reason, actions, source/search patches, and the recovery summary captured at apply time.
- Playbook rollback: `POST /api/sentiment/source-recovery/audit/:id/rollback` returns a rollback diff by default; with `apply:true`, it restores the audited source/search settings `before` values and appends a `source-recovery-rollback` audit entry.
- Event-driven expansion through `/api/sentiment/search-settings`: `eventExpansion` reads recent unresolved/high-risk events before each scan and derives follow-up queries from event titles, summaries, entities, risk terms, and platform hints. Scan results expose `eventExpansionKeywords` so operators can audit how crisis events feed the next collection cycle.
- Propagation-stage analysis through `/api/sentiment/spread-graph`: event nodes include `propagation_stage`, `tracking_priority`, `tracking_reasons`, `next_tracking_sources`, `propagation_path_score`, `propagation_score_label`, and `propagation_score_breakdown`, derived from origin confidence, platform spread, risk level, interaction strength, edge strength, timeline span, and graph direction.
- Propagation-confidence scoring through `/api/sentiment/spread-graph`: event edges expose `propagationConfidence`, confidence labels, and evidence reasons; nodes expose `propagation_confidence_score`, confidence labels, reasons, and breakdowns so crisis analysts can separate high-confidence propagation chains from weak related mentions that need more free-source collection.
- Low-confidence propagation backfill: continuous collection turns high-risk, low-confidence propagation paths into `propagation-confidence-gap` source signals. Weak origin evidence backfills Google News/RSS/DuckDuckGo/GDELT, weak edge evidence backfills search/news, and thin timeline or missing cross-platform confirmation backfills public social/comment sources such as Threads, Dcard, PTT, YouTube, and Reddit with source-specific query terms.
- Narrative origin/repost/amplification classification: spread graph nodes expose `likely_origin`, `narrative_flow`, and per-timeline `narrative_role`, `origin_candidate_score`, `origin_candidate_reasons`, and `origin_selected` values. The scorer lowers origin confidence for search indexes, reposts/aggregators, and video follow-ups while boosting candidates with published time, author, news/RSS, public social post, or community thread signals. Event clusters choose the strongest cross-event `likely_origin`, reducing false origin attribution to the earliest search-indexed or obviously reposted page. Event edges expose `narrativeRelation` to distinguish news-to-social amplification, social-to-media follow-up, and downstream related mentions.
- Social follow-up discovery signals: `GET /api/sentiment/social-followup-signals` aggregates Bluesky quoted context, YouTube related/channel follow-ups, comment bursts, and repeated author/account activity from captured evidence and comments. It returns `signal_type`, reasons, `priorityBoost`, suggested sources, suggested keywords, and sample URLs. Continuous collection converts those signals into a `social-followup-signal` priority reason, can trigger `scan-social-followup-source`, and adds quote/repost/comment/follow-up-video/author-latest terms to the relevant YouTube, Bluesky, Threads, Mastodon, PTT, Dcard, and Reddit query plans. `POST /api/sentiment/social-followup-signals/policy` supports dry-run/apply promotion of high-score social follow-up accounts, channels, and author pages into `duckDuckGo.config.discoveredProfiles` for long-term `site:` tracking, with `social-followup-policy` audit records for rollback.
- Similar-content propagation chains: event edges compute cross-platform title/body token similarity and expose `contentSimilarity`, `sharedContentTokens`, and `similar-content` propagation reasons, so related stories can connect even when their monitored keywords differ.
- Author/account tracking: spread-graph nodes include `author_signals`, `repeated_authors`, and `author_influence_score`, combining post authors, comment authors, appearances, platforms, and interaction signals to identify likely amplification accounts.
- Tracking-source scheduling: scan execution and continuous collection planning aggregate spread-graph `next_tracking_sources`, `tracking_priority`, and `propagation_path_score` into `sourceTrackingSignals` / `tracking_signal`, boost collection budgets, deep budgets, ordering, and plan priority for recommended sources, and record the signal in `sentiment_scan_source_logs.metadata.trackingSignal`.
- Collection-quality feedback: `GET /api/sentiment/collection-quality` scores sources, keywords, source-keywords, and authors by effective event contribution, zero-result runs, low-quality samples, failure rate, and suggested action. Scan execution uses `collectionQualityFeedback` to prioritize high-contribution keywords, suppress well-evidenced low-quality expansion terms, and feed source contribution signals into dynamic budgets. Source-keyword profiles are recorded in scan log `metadata.sourceKeywordQualityFeedback`, so a noisy or zero-result term can be demoted for one source without suppressing it globally.
- Incremental scheduled scans through `/api/sentiment/search-settings`: `incremental.enabled` and `incremental.overlapMinutes` use each source's `last_success_at` as a cursor for scheduled scans while preserving manual scans for full coverage. Google News, GDELT, RSS feeds, Taiwan news RSS, GitHub Issues, GitLab Issues, Reddit, Hacker News, Stack Overflow, Discourse, Mastodon, Bluesky, and YouTube honor the cursor.
- Continuous collection scheduling: the scheduler checks every 5 minutes by default while each source decides actual execution from `scan_interval_minutes`, cooldown, enabled state, and source-quality health. `GET /api/sentiment/status` and `GET /api/sentiment/source-schedule` expose each source's `due`, `waiting`, `cooldown`, `next_scan_at`, and realtime-source flag for operating social discovery and news/RSS deep collection at different frequencies.
- Source-quality health scheduling: `GET /api/sentiment/continuous-collection-plan` includes `source_quality_signal` and `source-quality-health` priority reasons. Healthy high-yield sources can be promoted in the plan, while sources with high failure or low-quality rates are backed off as `wait-source-quality-repair` or `wait-source-quality-backoff` before they spend more free-source budget.
- Source coverage/SLA scoring: `GET /api/sentiment/source-coverage` combines source configuration, scan logs, and quality profiles to expose `coverage_score`, `status`, `issues`, `recommendation`, latest scan/success age, and freshness SLA so operators can find `stale`, `blocked`, `noisy`, `under-covered`, and `disabled` collection gaps.
- Local evidence full-text retrieval: SQLite FTS5 indexes sentiment rows, evidence documents, comments, and event clusters into a local evidence corpus. `GET /api/sentiment/evidence-search?q=...` searches by `sentiment/evidence/comment/event` document type, while `POST /api/sentiment/search-index/rebuild` rebuilds the index. Chinese queries combine FTS with a LIKE fallback, and AI analyst Q&A plus crisis briefs automatically cite these deeper records without paid search or vector APIs.
- Domain controls through `/api/sentiment/search-settings`: `domainControls.allowDomains` and `domainControls.denyDomains` are applied before public scraper rows are accepted. Skipped rows are recorded in source-quality samples with `domain-blocked` or `domain-not-allowed` reasons.
- Content controls through `/api/sentiment/search-settings`: `contentControls.requireAnyTerms`, `contentControls.excludeTerms`, `minRelevanceScore`, and `minQualityScore` are applied before public scraper rows are accepted. Skipped rows keep reasons such as `excluded-term`, `required-term-missing`, `below-min-relevance`, and `below-min-quality`.
- GitHub Issues, GitLab Issues, Reddit, Hacker News, Stack Overflow, and Discourse public community collection for international brand spillover, technical complaints, product-community complaints, and overseas developer/community discussion coverage. Matched community items are enriched with public comments, discussion trees, or answers when available.
- Mastodon / ActivityPub and Bluesky public social discovery for decentralized social posts, interaction metrics, and attached image evidence without paid APIs.
- App Store, Google Play, public review/complaint sites, vertical product/community reviews, ecommerce/marketplace reviews, and regional consumer-protection/complaint sources. `appStoreReviews` uses Apple public iTunes Search and customer reviews RSS/JSON; `googlePlayReviews` uses Google Play public search/detail pages and optional configured `packageIds`; `publicReviewSites` uses free public search pages to discover Trustpilot, BBB, Sitejabber, ComplaintsBoard, PissedConsumer, ProductReview, ConsumerAffairs, Reviews.io, MouthShut, and Hellopeter pages; `verticalReviewSources` uses the same no-paid-API discovery path for Chrome Web Store, Product Hunt, Steam, G2, Capterra, TrustRadius, Microsoft Store, GetApp, Software Advice, SourceForge, AlternativeTo, and AppSumo; `ecommerceReviewSources` covers Amazon, eBay, Etsy, Walmart, Best Buy, Target, Costco, Newegg, AliExpress, Shopee Taiwan, PChome 24h, momo, Lazada, Tokopedia, and Rakuten Japan search-discovered product/marketplace pages; `regionalComplaintSources` covers Taiwan CPC/Consumers' Foundation, Hong Kong Consumer Council, CASE Singapore, ACCC/Scamwatch/Product Safety Australia, U.S. CFPB/CPSC/FTC consumer and fraud sites, Canada Recalls and Safety Alerts, EU Safety Gate, Japan Consumer Affairs Agency, UK Citizens Advice/Trading Standards/Product Safety Alerts, New Zealand Consumer Protection, India National Consumer Helpline, and Korea Consumer Agency public domains. The four public vertical review/complaint sources support `targetProfiles` / `target_profiles` / `profiles` filters such as `taiwan`, `saas`, `marketplace`, `complaint`, `official`, `regulatory`, `recall`, `financial`, `india`, `new-zealand`, `korea`, `southeast-asia`, and `japan`, and evidence metrics store `target_profiles` plus `source_weight_tier` for source weighting and focused crisis monitoring. They store review text, rating/version/package metadata when visible, target review-site, marketplace, or regional complaint tags, and `app_store_review` / `google_play_review` / `public_review_site_result` / `vertical_review_source_result` / `ecommerce_review_source_result` / `regional_complaint_source_result` evidence for product feedback, refund, support, rating-drop, consumer-complaint, SaaS, extension, game/software, open-source software, alternative-product communities, product-community, logistics, seller-service, cross-border marketplace, scam-warning, recall, product-safety, financial complaint, and regional consumer-protection monitoring without paid APIs.
- Regional complaint targets are dynamically ranked per query. Recall/product-safety terms prioritize CPSC, Canada Recalls, EU Safety Gate, UK/Australia product safety, and Japan/Korea consumer safety sources; financial/payment/billing/credit terms prioritize CFPB; scam/fraud/phishing terms prioritize Scamwatch, FTC, and regulatory alert sources; region terms such as UK, Australia, India, Korea, and New Zealand prioritize the corresponding local official or consumer-protection sources. This keeps the default bounded target budget focused on the most relevant official public domains.
- Public review page enrichment parses JSON-LD `Review` and `AggregateRating` from fetched public HTML and stores `review_rating`, `review_best_rating`, `review_worst_rating`, `review_rating_count`, `review_count`, `review_author`, `review_published_time`, `review_item`, `review_text`, and `has_review_structured_data` in evidence metrics. Review body text is preferred for summaries, so review/complaint evidence is deeper than a search snippet when public structured data is available.
- Public review follow-up discovery extracts comment entrypoints, next-page pagination, more same-brand reviews, product/company pages, and author/profile links from fetched review/complaint HTML into `review_followup_links` and `review_followup_link_count`. The `source-discovery/deep-crawl-plan` `deep-crawl-outlink` lane reads those links and classifies them as `deep-crawl-review-comments`, `deep-crawl-review-pagination`, `deep-crawl-review-page`, or `deep-crawl-review-profile`, so review comments, pagination, and related review pages enter recoverable deep-crawl follow-up planning with more precise priority.
- Persistent scan batch and per-source execution logs for auditing coverage, disabled sources, cooldowns, failures, durations, and source counts.
- Article metadata enrichment for search/RSS hits, including readable body summary, raw HTML excerpt, site name, canonical URL, OG URL, author, published time, and `og:image` visual evidence.
- Public URL normalization and canonical/OG URL dedupe before storage, reducing tracking-parameter duplicates and repeated cross-source article hits. News, RSS, and search sources also use a `content_fingerprint` to compress lightly rewritten syndicated hits while keeping social posts available for spread-path analysis.
- Public-result quality scoring that filters thin content, low-information posts, keyword stuffing, search/tag/category pages, and generic reference/template pages even when they contain the monitored keyword.
- Public-source event clustering and propagation graph output. Public news/forum/social hits can form low-risk events without triggering internal crisis alerts, and graph edges are directed from earlier events to later amplification/receiver events with source weight, interaction, timing, and propagation-reason evidence. Event-cluster reports include `merge_recommendation`, `merge_confidence_score`, `merge_evidence`, `official_regulatory_profile`, `independent_confirmation`, `fact_confidence_score`, and `crisis_priority_score` so strong same-keyword, similar-content, same-day, cross-platform, official, regulatory, recall, safety-alert, or independently confirmed source-family signals can be treated as one incident for crisis review instead of inflated as unrelated events. `independent_confirmation` scores whether the same issue is corroborated across free source families such as news, public feedback/review/complaint, social/forum/community, video, and official/regulatory evidence while penalizing duplicate amplification. Crisis briefs carry these fields into event-cluster evidence and recommend checking official statements, regulatory notices, recalls, or safety alerts before finalizing response language.
- Source-quality profiles for effective rate, low-quality rate, duplicate rate, failure rate, average quality/relevance scores, event contribution, health score, and tuning recommendation.
- Source originality/repost profiling: `/api/sentiment/source-credibility` converts near-duplicate clusters into source-level `content_origin_profile` metrics, including origin count, repost count, originality rate, repost rate, cross-platform repost count, sample URLs, and origin/repost labels. Origin-heavy sources get a small credibility lift, while repost-heavy or cross-platform copy sources are penalized and require corroboration.
- Originality-driven collection scheduling: continuous collection reads `content_origin_profile`. Origin-heavy sources get higher source-credibility priority, `expand-pages` query strategy, and larger collection/deep-collection budgets; repost-heavy or cross-platform-copy sources are tightened to `require-entity-and-risk-term` and receive lower budgets so free-source capacity is spent on higher-value sources.
- Conservative source auto-tuning that adjusts source priority and scan interval from quality profiles. Scheduled scans respect per-source `scan_interval_minutes`; manual scans remain available for forced coverage.
- Event-edge generation for spread-path graphing across related events.
- Crisis brief generation for high-risk events, including severity, confidence, hypotheses, evidence, response strategy, recommended actions, and a draft holding statement. Crisis briefs also consume spread-graph `propagation_path_score`, propagation stage, likely origin, and next tracking sources, then persist this context in `fact_findings.propagation_path`, `propagation_path` evidence, and recommended actions so collection, propagation analysis, and crisis judgment stay connected. They also match the related event cluster and persist cluster size, propagation edges, likely origin, amplifiers, evidence gaps, and second-hop tracking sources in `fact_findings.event_cluster` plus `event_cluster` evidence. They compute `fact_findings.evidence_completeness` across article/body evidence, comments/replies, origin clues, cross-platform propagation, fact claims, quoted context, and video follow-ups; thin evidence lowers local confidence and adds collection actions for the missing evidence classes. Source credibility is written into `fact_findings.source_credibility` and `source_credibility` evidence, and incorporates evidence `source_weight_tier` so official/regulatory/consumer-protection evidence ranks above ordinary review or repost-heavy sources before facts are treated as confirmed.
- Evidence-level fact claims for local contradiction screening. `/api/sentiment/fact-claims/summary` groups asserted, denied, disputed, resolved, and questioned claims, then weights them with `source_reputation_score`, `weighted_confidence`, and `trusted_evidence_count` from official/media/comment signals plus source/domain quality history.
- Author/account reputation and coordinated-amplification detection. `/api/sentiment/author-reputation` scores account trust and coordination risk; `/api/sentiment/coordinated-amplification` flags repeated similar content, short-window bursts, cross-platform copying, and low-trust author clusters. Spread graphs and crisis briefs include these signals.
- Near-duplicate content clusters: `/api/sentiment/content-similarity-clusters` groups reposts, syndicated copies, and lightly rewritten duplicates by `content_fingerprint` and shared similarity tokens. It returns `cluster_score`, `shared_tokens`, platform/author/URL samples, and recommendations so repeated amplification can be separated from independent public-opinion volume.
- Effective volume precision: `/api/sentiment/volume-precision` converts duplicate clusters into `raw_volume`, `effective_volume`, `duplicate_amplification_rate`, `precision_score`, and keyword/platform/source breakdowns so alert thresholds can use independent volume while raw volume remains available for reach and amplification analysis.
- Deduped metric alerts: built-in `volume:` and `negative:` signals prefer effective independent volume over raw repost counts. Single-source duplicate reposts no longer inflate crisis severity, while cross-platform duplicate amplification can still raise a tracking volume signal with raw volume, effective volume, and duplicate rate in the message.
- Deeper public context collection for YouTube and Bluesky without paid APIs. YouTube video hits attempt to parse public watch-page `ytInitialData` comments into `sentiment_comments`; Bluesky search captures quoted-post text/author/URI as deep comment evidence for local search, fact extraction, author profiling, and coordination analysis.
- Optional OpenAI-compatible AI enhancement for crisis briefs. `POST /api/sentiment/crisis-briefs` with `{"ai":true}` calls the configured model and falls back to the local heuristic brief when unavailable. Saved API keys can be cleared with `clearApiKey:true` or `apiKey:null`.
- Persistent anomaly detection for negative-ratio shifts, source-weighted spikes, and cross-platform spread velocity, exposed through `/api/sentiment/anomalies` and `anomaly:*` alerts.
- Spread graph API for event nodes, relationship edges, source/amplifier/receiver roles, origin platform, strongest source platform, highest-interaction platform, per-event propagation roles, and `summary.top_propagation_nodes` for ranked crisis-path review.
- AI analyst Q&A through `/api/sentiment/ask` with `{"ai":true}`, using local citations and the configured model with local fallback.
- Alert response workflow records for assignee, status, note, due date, action updates, and action history.
- Visual/OCR asset storage for image or screenshot URLs, OCR text, logo tags, object tags, and scene tags, deduplicated per sentiment item by asset hash.
- Reprocess endpoint for rebuilding structured insights from stored sentiment rows.
- JSONL migration export for future OpenSearch/PostgreSQL migration.
- Architecture status endpoint that reports why the current mode is modular-monolith and which distributed components are deferred.

## Architecture stance

This backend intentionally stays as a modular monolith for the current MVP stage. OpenSearch, Redis/Kafka, S3/object storage, and PostgreSQL are deferred until real volume or customer isolation pressure requires them. The current storage tables and JSONL export are designed so the data can be migrated later without changing the public sentiment API shape.
