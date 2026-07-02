const $ = (id) => document.getElementById(id);

const state = {
  sources: [],
  searchSettings: null,
  openSearchSettings: null,
  configLoaded: false,
  loadPromise: null,
  activeSourceMode: "fast",
  modeSources: {
    fast: new Set(),
    full: new Set(),
    watch: new Set(),
  },
  sourceFilter: "",
  rssPackCoverage: null,
  taiwanMediaHealth: null,
  taiwanPublicInterestHealth: null,
  taiwanNativeDiscoveryPlan: null,
  taiwanNativeDiscoveryRecovery: null,
  followupPlan: null,
  followupRecovery: null,
  sourceFamilyRefreshRecovery: null,
  nativePromotionEffectiveness: null,
  nativePromotionRefreshPlan: null,
  nativePromotionRefreshRecovery: null,
  nativePromotionGovernance: null,
  continuousCollectionPlan: null,
  continuousCollectionResult: null,
  freeTargetCoverage: null,
  freeTargetCoverageEffectiveness: null,
  rssPackCatalog: [],
  activeRssPackMode: "fast",
  modeRssPacks: {
    fast: new Set(),
    full: new Set(),
    watch: new Set(),
  },
};

const QUICK_SCAN_SOURCES = [
  "googleNews",
  "bingNews",
  "duckDuckGo",
  "rssFeeds",
  "gdelt",
  "reddit",
  "youtube",
  "browserFallback",
  "ptt",
  "dcard",
  "threads",
  "xSearch",
  "weiboSearch",
];
const CRISIS_SCAN_SOURCES = [
  "googleNews",
  "bingNews",
  "duckDuckGo",
  "rssFeeds",
  "gdelt",
  "reddit",
  "youtube",
  "browserFallback",
  "ptt",
  "dcard",
  "threads",
  "xSearch",
  "weiboSearch",
  "xiaohongshuSearch",
  "tiktokSearch",
  "publicReviewSites",
  "regionalComplaintSources",
];
const SOURCE_MODE_LABELS = {
  fast: "快速扫描",
  full: "深度扫描",
  watch: "危情扫描",
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `请求失败：${res.status}`);
  return data;
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => $("toast").classList.remove("show"), 2600);
}

function setStatus(text) {
  $("adminStatus").textContent = text;
}

function sourceText(source) {
  return `${source.source_key || ""} ${source.label || ""} ${source.source_type || ""}`;
}

function sourceKeys(sourceList = state.sources) {
  return sourceList.map(source => source.source_key).filter(Boolean);
}

function defaultSourceKeysForMode(mode, availableKeys = sourceKeys()) {
  const available = new Set(availableKeys);
  if (mode === "full") return availableKeys;
  const defaults = mode === "watch" ? CRISIS_SCAN_SOURCES : QUICK_SCAN_SOURCES;
  const matched = defaults.filter(key => available.has(key));
  return matched.length ? matched : availableKeys;
}

function normalizeModeSourceSet(mode, raw, availableKeys = sourceKeys()) {
  const available = new Set(availableKeys);
  const values = Array.isArray(raw) ? raw : [];
  const selected = values.map(item => String(item || "").trim()).filter(key => available.has(key));
  return new Set(selected.length ? selected : defaultSourceKeysForMode(mode, availableKeys));
}

function currentModeSources() {
  return state.modeSources[state.activeSourceMode] || state.modeSources.fast;
}

function selectedSourceCount(mode = state.activeSourceMode) {
  return state.modeSources[mode]?.size || 0;
}

function sourceModeSummary() {
  return Object.entries(SOURCE_MODE_LABELS)
    .map(([mode, label]) => `${label} ${selectedSourceCount(mode)}`)
    .join("｜");
}

function defaultRssPacksForMode(mode, availableKeys = state.rssPackCatalog.map(pack => pack.key)) {
  const available = new Set(availableKeys);
  const preferred = mode === "full"
    ? availableKeys
    : mode === "watch"
      ? ["taiwanMedia", "taiwanBusinessMedia", "taiwanPublicInterest", "greaterChinaMedia", "globalMainstreamMedia", "consumerProtection", "taiwanRegulatory", "regulatoryNotices", "security", "business", "pressReleases"]
      : ["chineseNews", "taiwanMedia", "consumerProtection", "taiwanRegulatory", "regulatoryNotices"];
  const matched = preferred.filter(key => available.has(key));
  return matched.length ? matched : availableKeys;
}

function normalizeModeRssPackSet(mode, raw, availableKeys = state.rssPackCatalog.map(pack => pack.key)) {
  const available = new Set(availableKeys);
  const values = Array.isArray(raw) ? raw : [];
  const selected = values.map(item => String(item || "").trim()).filter(key => available.has(key));
  return new Set(selected.length ? selected : defaultRssPacksForMode(mode, availableKeys));
}

function currentModeRssPacks() {
  return state.modeRssPacks[state.activeRssPackMode] || state.modeRssPacks.fast;
}

function rssPackModeSummary() {
  return Object.entries(SOURCE_MODE_LABELS)
    .map(([mode, label]) => `${label} ${state.modeRssPacks[mode]?.size || 0}`)
    .join("｜");
}

function renderSources() {
  const filter = state.sourceFilter.trim().toLowerCase();
  const sources = state.sources.filter(source => !filter || sourceText(source).toLowerCase().includes(filter));
  const selected = currentModeSources();
  $("sourceSummary").textContent = `${SOURCE_MODE_LABELS[state.activeSourceMode]}：已选择 ${selected.size} / ${state.sources.length} 个来源（${sourceModeSummary()}）`;
  $("sourceList").innerHTML = sources.map(source => {
    const key = source.source_key;
    const checked = selected.has(key) ? "checked" : "";
    const lastError = source.last_error ? `<span class="source-error">最近错误：${escapeHtml(source.last_error).slice(0, 160)}</span>` : "";
    return `
      <label class="source-row">
        <span class="source-check"><input type="checkbox" data-source="${escapeHtml(key)}" ${checked}></span>
        <span class="source-main">
          <strong>${escapeHtml(source.label || key)}</strong>
          <small>${escapeHtml(key)}</small>
        </span>
        <span class="source-meta">${escapeHtml(source.source_type || "public")}</span>
        <span class="source-priority">优先级 ${Number(source.priority || 0)}</span>
        <span class="source-health">${lastError || "正常"}</span>
      </label>
    `;
  }).join("") || `<div class="source-summary">没有匹配的来源</div>`;

  document.querySelectorAll("[data-source]").forEach(input => {
    input.addEventListener("change", () => {
      const selectedForMode = currentModeSources();
      if (input.checked) selectedForMode.add(input.dataset.source);
      else selectedForMode.delete(input.dataset.source);
      $("sourceSummary").textContent = `${SOURCE_MODE_LABELS[state.activeSourceMode]}：已选择 ${selectedForMode.size} / ${state.sources.length} 个来源（${sourceModeSummary()}）`;
    });
  });
}

function renderRssPackConfig() {
  const selected = currentModeRssPacks();
  $("rssPackConfigSummary").textContent = `${SOURCE_MODE_LABELS[state.activeRssPackMode]}：已选择 ${selected.size} / ${state.rssPackCatalog.length} 个媒体包（${rssPackModeSummary()}）`;
  $("rssPackConfigList").innerHTML = state.rssPackCatalog.map(pack => {
    const checked = selected.has(pack.key) ? "checked" : "";
    const feedCount = Array.isArray(pack.feeds) ? pack.feeds.length : 0;
    const priorityCount = Array.isArray(pack.prioritySites) ? pack.prioritySites.length : 0;
    const siteBadges = renderRssPackSiteBadges(pack.prioritySites || pack.requiredSites || [], { emptyText: "无重点站点" });
    return `
      <label class="rss-pack-config-row">
        <span class="source-check"><input type="checkbox" data-rss-pack="${escapeHtml(pack.key)}" ${checked}></span>
        <span class="source-main">
          <strong>${escapeHtml(pack.label || pack.key)}</strong>
          <small>${escapeHtml(pack.key)}</small>
        </span>
        <span class="source-meta">Feed ${feedCount}</span>
        <span class="source-priority">重点站点 ${priorityCount}</span>
        <span class="rss-pack-config-sites">
          <strong>站点清单</strong>
          ${siteBadges}
        </span>
      </label>
    `;
  }).join("") || `<div class="source-summary">暂无可配置的 RSS 媒体包</div>`;
  document.querySelectorAll("[data-rss-pack]").forEach(input => {
    input.addEventListener("change", () => {
      const selectedForMode = currentModeRssPacks();
      if (input.checked) selectedForMode.add(input.dataset.rssPack);
      else selectedForMode.delete(input.dataset.rssPack);
      $("rssPackConfigSummary").textContent = `${SOURCE_MODE_LABELS[state.activeRssPackMode]}：已选择 ${selectedForMode.size} / ${state.rssPackCatalog.length} 个媒体包（${rssPackModeSummary()}）`;
    });
  });
}

function renderRssPackSiteBadges(sites = [], { emptyText = "暂无站点", limit = 36 } = {}) {
  const rows = Array.isArray(sites) ? sites.filter(Boolean) : [];
  if (!rows.length) return `<span class="site-empty">${escapeHtml(emptyText)}</span>`;
  const visible = rows.slice(0, limit);
  const hiddenCount = Math.max(0, rows.length - visible.length);
  const badges = visible.map(site => {
    const count = Number(site.evidence_count || 0);
    const hasEvidence = count > 0;
    const statusClass = site.fresh === true ? "good" : site.stale === true ? "warn" : hasEvidence ? "good" : "";
    const statusText = hasEvidence ? ` · ${count}` : "";
    const family = site.family || site.source_family || "";
    const title = [
      site.name || site.site || "",
      site.site || "",
      family,
    ].filter(Boolean).join(" · ");
    return `<span class="site-badge ${statusClass}" title="${escapeHtml(title)}">${escapeHtml(site.name || site.site || "-")}${escapeHtml(statusText)}</span>`;
  }).join("");
  return `${badges}${hiddenCount ? `<span class="site-badge">+${hiddenCount}</span>` : ""}`;
}

function renderMetricStrip(targetId, metrics = []) {
  const target = $(targetId);
  if (!target) return;
  target.innerHTML = metrics.map(item => `
    <div class="metric-tile">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value)}</strong>
    </div>
  `).join("");
}

function renderRssModeCoverage(payload = {}) {
  const target = $("rssModeCoverageList");
  if (!target) return;
  const modes = Array.isArray(payload.mode_coverage) ? payload.mode_coverage : [];
  target.innerHTML = modes.map(item => {
    const mode = String(item.mode || "");
    const selectedCount = Number(item.selected_pack_count || 0);
    const observedCount = Number(item.observed_selected_pack_count || 0);
    const emptyCount = Number(item.empty_selected_pack_count || 0);
    const evidenceCount = Number(item.evidence_count || 0);
    const statusClass = emptyCount > 0 ? "warn" : observedCount > 0 ? "good" : "";
    const statusText = emptyCount > 0
      ? `空包 ${emptyCount}/${selectedCount}`
      : observedCount > 0
        ? "覆盖正常"
        : "暂无证据";
    const emptyKeys = Array.isArray(item.empty_pack_keys)
      ? item.empty_pack_keys.slice(0, 8).join("，")
      : "";
    const priorityTotal = Number(item.priority_site_count || 0);
    const priorityObserved = Number(item.observed_priority_site_count || 0);
    const priorityFresh = Number(item.fresh_priority_site_count || 0);
    const priorityStale = Number(item.stale_priority_site_count || 0);
    const priorityEmpty = Number(item.empty_priority_site_count || 0);
    const indexStats = item.index_redundancy || {};
    const familyGroups = Array.isArray(item.priority_site_family_groups) ? item.priority_site_family_groups : [];
    const familyGroupText = familyGroups.map(group => {
      const observed = Number(group.observed_priority_site_count || 0);
      const fresh = Number(group.fresh_priority_site_count || 0);
      const stale = Number(group.stale_priority_site_count || 0);
      const total = Number(group.priority_site_count || 0);
      const empty = Number(group.empty_priority_site_count || 0);
      return `${group.family} ${observed}/${total}${fresh ? ` · 新鲜 ${fresh}` : ""}${stale ? ` · 久未更新 ${stale}` : ""}${empty ? ` · 空 ${empty}` : ""}`;
    }).join("；") || "-";
    const emptyPrioritySites = Array.isArray(item.empty_priority_sites)
      ? item.empty_priority_sites.slice(0, 6).map(site => site.name || site.site).filter(Boolean).join("，")
      : "";
    const stalePrioritySites = Array.isArray(item.stale_priority_sites)
      ? item.stale_priority_sites.slice(0, 6).map(site => `${site.name || site.site}${site.days_since_latest_captured ? ` ${site.days_since_latest_captured}天` : ""}`).filter(Boolean).join("，")
      : "";
    const recommendations = Array.isArray(item.recommendations) ? item.recommendations : [];
    const recommendationText = recommendations.slice(0, 3)
      .map(recommendation => {
        const prefix = recommendation.auto_apply
          ? "可一键应用"
          : recommendation.recommendation_type === "collection"
            ? "需入队补采"
            : "建议";
        return `${prefix}：${recommendation.recommended_text || recommendation.action}`;
      })
      .filter(Boolean)
      .join("；") || "";
    const productivePacks = Array.isArray(item.selected_packs)
      ? item.selected_packs
        .filter(pack => Number(pack.evidence_count || 0) > 0)
        .slice(0, 5)
        .map(pack => `${pack.pack_key} ${Number(pack.evidence_count || 0)}`)
        .join("，")
      : "";
    return `
      <div class="rss-mode-row">
        <div class="rss-mode-main">
          <strong>${escapeHtml(SOURCE_MODE_LABELS[mode] || mode || "未知模式")}</strong>
          <small>${escapeHtml(mode || "-")}</small>
        </div>
        <span class="status-pill ${statusClass}">${escapeHtml(statusText)}</span>
        <div class="rss-mode-metrics">
          <span>已选 ${selectedCount}</span>
          <span>有证据 ${observedCount}</span>
          <span>证据 ${evidenceCount}</span>
          <span>重点站点 ${priorityObserved}/${priorityTotal}</span>
          <span>新鲜 ${priorityFresh}</span>
          <span>久未更新 ${priorityStale}</span>
          <span>双索引 ${Number(indexStats.dual_index_site_count || 0)}/${Number(indexStats.indexed_site_count || 0)}</span>
        </div>
        <div class="rss-mode-detail">
          <span>有效包：${escapeHtml(productivePacks || "-")}</span>
          <small>空包：${escapeHtml(emptyKeys || "无")}</small>
          <small>分组：${escapeHtml(familyGroupText)}</small>
          <small>久未更新：${escapeHtml(priorityStale ? stalePrioritySites || "有久未更新站点" : "无")}</small>
          <small>空站点：${escapeHtml(priorityEmpty ? emptyPrioritySites || "有空站点" : "无")}</small>
          <small>建议：${escapeHtml(recommendationText || "暂无")}</small>
        </div>
      </div>
    `;
  }).join("") || `<div class="source-summary">暂无扫描模式覆盖数据</div>`;
}

function renderRssPrioritySiteGaps(payload = {}) {
  const target = $("rssPrioritySiteGapList");
  if (!target) return;
  const gaps = Array.isArray(payload.priority_site_gaps) ? payload.priority_site_gaps : [];
  target.innerHTML = gaps.slice(0, 8).map(gap => {
    const actions = Array.isArray(gap.recommended_actions) ? gap.recommended_actions.slice(0, 2).join("；") : "";
    return `
      <div class="rss-priority-gap-row">
        <div class="rss-priority-gap-main">
          <strong>${escapeHtml(gap.site_name || gap.site || "未知站点")}</strong>
          <small>${escapeHtml(gap.pack_label || gap.pack_key || "-")} · ${escapeHtml(gap.site || "-")}</small>
        </div>
        <div class="rss-priority-gap-query">
          <span>建议查询</span>
          <strong>${escapeHtml(gap.suggested_query || "-")}</strong>
        </div>
        <div class="rss-priority-gap-action">${escapeHtml(actions || "补充关键词或启用浏览器兜底")}</div>
      </div>
    `;
  }).join("") || `<div class="source-summary">暂无重点站点缺口</div>`;
}

function followupPlanUrl() {
  return "/api/sentiment/collection-jobs/recoverable-followups?days=30&limit=30&include_deep_crawl=0&include_social_followup=0&include_access_barrier_alternates=0&include_rss_priority_site_gaps=1&include_rss_source_family_refresh=1&include_collection_operations_remediation=0&include_free_source_target_coverage_followups=0";
}

function followupRecoveryUrl() {
  return "/api/sentiment/collection-jobs/rss-priority-site-gap-recovery?days=30&limit=100";
}

function sourceFamilyRefreshRecoveryUrl() {
  return "/api/sentiment/collection-jobs/rss-source-family-refresh-recovery?days=30&limit=100";
}

function nativePromotionEffectivenessUrl() {
  return "/api/sentiment/rss-feed-pack-coverage/native-entry-promotion-effectiveness?days=30&freshness_days=14&limit=100";
}

function nativePromotionRefreshUrl() {
  return "/api/sentiment/collection-jobs/rss-native-entry-promotion-refresh?days=30&freshness_days=14&limit=30";
}

function nativePromotionRefreshRecoveryUrl() {
  return "/api/sentiment/collection-jobs/rss-native-entry-promotion-refresh-recovery?days=30&freshness_days=14&limit=100";
}

function nativePromotionGovernanceUrl() {
  return "/api/sentiment/rss-feed-pack-coverage/native-entry-promotion-governance?days=30&freshness_days=14&limit=100";
}

function taiwanMediaHealthUrl() {
  return "/api/sentiment/rss-feed-pack-coverage/taiwan-media-health?limit=100";
}

function taiwanPublicInterestHealthUrl() {
  return "/api/sentiment/rss-feed-pack-coverage/taiwan-public-interest-health?limit=100";
}

function taiwanNativeDiscoveryPlanUrl() {
  return "/api/sentiment/collection-jobs/recoverable-followups?days=30&limit=40&include_deep_crawl=0&include_social_followup=0&include_access_barrier_alternates=0&include_rss_priority_site_gaps=0&include_rss_native_entry_discovery=1&include_evidence_coverage_followups=0&include_collection_operations_remediation=0&include_free_source_target_coverage_followups=0";
}

function taiwanNativeDiscoveryRecoveryUrl() {
  return "/api/sentiment/collection-jobs/rss-native-entry-discovery-recovery?days=30&limit=100";
}

function continuousCollectionPlanUrl() {
  return "/api/sentiment/continuous-collection-plan?mode=fast&max_sources=8&retry_limit=20";
}

function freeTargetCoverageUrl() {
  return "/api/sentiment/free-source-target-coverage?limit=100";
}

function freeTargetCoverageEffectivenessUrl() {
  return "/api/sentiment/collection-jobs/free-source-target-coverage-effectiveness?days=30&limit=100";
}

function freeTargetCoverageFollowupUrl() {
  return "/api/sentiment/collection-jobs/free-source-target-coverage-followups";
}

function renderSourceHealth(payload = {}, {
  stateKey,
  summaryId,
  listId,
  title,
  emptyText,
  maxSites = 16,
} = {}) {
  if (stateKey) state[stateKey] = payload;
  const summary = payload.summary || {};
  const sites = Array.isArray(payload.sites) ? payload.sites : [];
  const targetSummary = $(summaryId);
  const targetList = $(listId);
  if (!targetSummary || !targetList) return;
  targetSummary.textContent = `${title || "来源健康"}：站点 ${Number(summary.site_count || 0)} · 强覆盖 ${Number(summary.strong_site_count || 0)} · 站点地图 ${Number(summary.sitemap_entry_site_count || 0)} · 仅索引兜底 ${Number(summary.indexed_only_site_count || 0)} · 缺失 ${Number(summary.missing_site_count || 0)} · 双索引 ${Number(summary.dual_index_ready_site_count || 0)} · 总入口 ${Number(summary.total_entry_count || 0)}`;
  targetList.innerHTML = sites.slice(0, maxSites).map(site => {
    const statusClass = site.coverage_status === "strong" || site.coverage_status === "good"
      ? "good"
      : site.coverage_status === "missing"
        ? "bad"
        : "warn";
    const statusText = {
      strong: "强覆盖",
      good: "良好",
      "indexed-only": "索引兜底",
      partial: "部分覆盖",
      missing: "缺失",
    }[site.coverage_status] || site.coverage_status || "未知";
    const entryText = `直接 ${Number(site.native_entry_count || 0)} · RSS ${Number(site.rss_like_entry_count || 0)} · JSON ${Number(site.json_entry_count || 0)} · Sitemap ${Number(site.sitemap_entry_count || 0)} · Google ${Number(site.google_news_index_entry_count || 0)} · Bing ${Number(site.bing_news_index_entry_count || 0)}`;
    const feeds = Array.isArray(site.feeds)
      ? site.feeds.slice(0, 4).map(feed => `${feed.name || feed.type || "入口"}(${feed.type || "-"})`).join("，")
      : "";
    return `
      <div class="rss-followup-job-row taiwan-health-row">
        <div class="rss-followup-main">
          <strong>${escapeHtml(site.name || site.site || "来源")}</strong>
          <small>${escapeHtml(site.family || "-")} · ${escapeHtml(site.site || "-")} · ${escapeHtml(entryText)}</small>
        </div>
        <div class="rss-followup-query">
          <span>${escapeHtml(site.recommended_action || "建议")}</span>
          <strong>${escapeHtml(site.recommended_text || feeds || "-")}</strong>
        </div>
        <div class="rss-followup-score">
          <span>${escapeHtml(feeds || "入口明细")}</span>
          <strong class="${statusClass}">${escapeHtml(statusText)}</strong>
        </div>
      </div>
    `;
  }).join("") || `<div class="source-summary">${escapeHtml(emptyText || "暂无来源健康数据")}</div>`;
}

function renderTaiwanMediaHealth(payload = {}) {
  renderSourceHealth(payload, {
    stateKey: "taiwanMediaHealth",
    summaryId: "taiwanMediaHealthSummary",
    listId: "taiwanMediaHealthList",
    title: "台湾媒体健康",
    emptyText: "暂无台湾媒体健康数据",
    maxSites: 16,
  });
}

function renderTaiwanPublicInterestHealth(payload = {}) {
  renderSourceHealth(payload, {
    stateKey: "taiwanPublicInterestHealth",
    summaryId: "taiwanPublicInterestHealthSummary",
    listId: "taiwanPublicInterestHealthList",
    title: "台湾公共议题媒体健康",
    emptyText: "暂无公共议题媒体健康数据",
    maxSites: 12,
  });
}

function continuousCollectionActionText(action = "") {
  return {
    "scan-due-source": "到期扫描",
    "scan-alert-event-source": "事件预警",
    "scan-realtime-anomaly-window-source": "实时异常",
    "scan-realtime-hot-topic-source": "热点发现",
    "scan-burst-source": "异常突增",
    "scan-official-regulatory-followup-source": "监管跟进",
    "scan-realtime-latency-source": "实时延迟修复",
    "scan-realtime-coverage-source": "实时覆盖补强",
    "scan-social-followup-source": "社媒补采",
    "scan-multilingual-query-source": "多语言查询",
    "scan-free-source-target-coverage-source": "免费源覆盖补强",
    "scan-collection-operations-remediation-source": "降级来源修复",
    "scan-access-barrier-alternate-source": "访问受限替代",
    "scan-evidence-coverage-routed-alternate-source": "证据覆盖替代",
    "scan-event-cluster-source": "事件簇追踪",
    "scan-propagation-confidence-source": "扩散可信度",
    "scan-keyword-family-coverage-source": "关键词家族覆盖",
    "scan-taiwan-priority-site-health-source": "台湾重点媒体健康",
    "scan-evidence-chain-source": "证据链补强",
    "scan-evidence-depth-source": "证据深度补强",
    "scan-evidence-coverage-recovery-source": "证据恢复",
    "scan-commercial-benchmark-source": "商用覆盖基准",
    "scan-commercial-governance-source": "商用治理",
    "scan-trusted-source": "可信来源",
    "consume-retry-jobs": "重试待执行任务",
  }[action] || action || "待评估";
}

function renderContinuousCollectionPlan(payload = {}) {
  state.continuousCollectionPlan = payload;
  const summary = payload.summary || {};
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const ready = Array.isArray(payload.ready_scan_sources) ? payload.ready_scan_sources : [];
  const readySet = new Set(ready);
  const deep = payload.discovery_deep_crawl || {};
  const retryDue = Number(summary.retry_due_jobs || summary.retry_due_count || payload.retry_plan?.due || 0);
  const totalSources = Number(summary.total_sources || sources.length || 0);
  const targetSummary = $("continuousCollectionSummary");
  const targetList = $("continuousCollectionList");
  if (!targetSummary || !targetList) return;
  targetSummary.textContent = `连续采集计划：待扫 ${ready.length}/${totalSources} 个来源 · 待重试 ${retryDue} 个任务 · 深挖候选 ${Number(deep.candidate_count || summary.discovery_deep_crawl_candidate_count || 0)} · 最高深挖 ${Number(deep.highest_score || summary.discovery_deep_crawl_highest_score || 0)} · 商用就绪 ${escapeHtml(summary.commercial_readiness_level || "-")} ${summary.commercial_readiness_score ?? ""}`;
  const visibleSources = sources
    .filter(source => readySet.has(source.source_key) || Number(source.retry_due_count || 0) > 0)
    .slice(0, 10);
  targetList.innerHTML = visibleSources.map(source => {
    const reasons = Array.isArray(source.priority_reasons)
      ? source.priority_reasons.slice(0, 3).map(item => item.reason || item.label || "").filter(Boolean).join("，")
      : "";
    const statusClass = readySet.has(source.source_key) ? "good" : Number(source.retry_due_count || 0) > 0 ? "warn" : "bad";
    const waitMinutes = Number(source.waiting_ms || 0) > 0 ? Math.round(Number(source.waiting_ms || 0) / 60000) : 0;
    return `
      <div class="rss-followup-job-row">
        <div class="rss-followup-main">
          <strong>${escapeHtml(source.label || source.source_key || "连续采集来源")}</strong>
          <small>${escapeHtml(source.source_key || "-")} · ${escapeHtml(source.status || "-")} · 等待 ${waitMinutes} 分 · 重试 ${Number(source.retry_due_count || 0)}/${Number(source.retry_job_count || 0)}</small>
        </div>
        <div class="rss-followup-query">
          <span>${escapeHtml(continuousCollectionActionText(source.action))}</span>
          <strong>${escapeHtml(reasons || "按来源调度和覆盖缺口排序")}</strong>
        </div>
        <div class="rss-followup-score">
          <span>优先级</span>
          <strong class="${statusClass}">${Number(source.priority_score || 0)}</strong>
        </div>
      </div>
    `;
  }).join("") || `<div class="source-summary">暂无到期连续采集来源；可刷新计划或等待来源调度到期。</div>`;
}

function renderContinuousCollectionResult(payload = {}) {
  state.continuousCollectionResult = payload;
  const target = $("continuousCollectionResultSummary");
  if (!target) return;
  const scanSources = Array.isArray(payload.executed_scan_sources) ? payload.executed_scan_sources : [];
  const retry = payload.retryResult || {};
  const post = payload.postScanFollowupResult || {};
  const deep = payload.deepCrawlResult || {};
  const scanTotal = Number(payload.scanResult?.total || payload.scanResult?.summary?.total || 0);
  const postReason = post.reason ? ` · 补采状态 ${post.reason}` : "";
  target.textContent = `最近运行：扫描来源 ${scanSources.length} 个（${scanSources.slice(0, 5).join("，") || "无"}）· 证据 ${scanTotal} 条 · 重试 ${Number(retry.executed || 0)}/${Number(retry.total || retry.job_count || 0)} · 扫描后补采 ${Number(post.executed || 0)}/${Number(post.total || post.job_count || 0)} · 深挖入库 ${Number(deep.inserted || deep.inserted_count || 0)} · ${payload.ok ? "完成" : "异常"}${postReason}`;
}

async function loadContinuousCollectionPlan() {
  const payload = await api(continuousCollectionPlanUrl());
  renderContinuousCollectionPlan(payload);
  return payload;
}

async function runContinuousCollection() {
  const button = $("runContinuousCollectionBtn");
  button.disabled = true;
  try {
    const payload = await api("/api/sentiment/continuous-collection/run", {
      method: "POST",
      body: JSON.stringify({
        mode: "fast",
        maxSources: 8,
        retryLimit: 3,
        postScanFollowupLimit: 3,
        discoveryDeepCrawl: true,
        discoveryDeepCrawlLimit: 3,
      }),
    });
    renderContinuousCollectionResult(payload);
    await loadContinuousCollectionPlan();
    const post = payload.postScanFollowupResult || {};
    toast(`连续采集已运行：扫描 ${Array.isArray(payload.executed_scan_sources) ? payload.executed_scan_sources.length : 0} 个来源 · 扫描后补采 ${Number(post.executed || 0)} 个`);
    return payload;
  } finally {
    button.disabled = false;
  }
}

function renderFreeTargetCoverage(payload = {}) {
  state.freeTargetCoverage = payload;
  const summary = payload.summary || {};
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const targetSummary = $("freeTargetCoverageSummary");
  const targetList = $("freeTargetCoverageList");
  if (!targetSummary || !targetList) return;
  targetSummary.textContent = `目标覆盖：来源 ${Number(summary.source_count || sources.length || 0)} · 弱覆盖 ${Number(summary.weak_source_count || 0)} · 缺口 ${Number(summary.gap_count || 0)} · 最低覆盖 ${Number(summary.lowest_coverage_score ?? 100)} · 建议来源 ${escapeHtml((summary.suggested_sources || []).slice(0, 6).join("，") || "-")} · 建议词 ${escapeHtml((summary.suggested_terms || []).slice(0, 6).join("，") || "-")}`;
  targetList.innerHTML = sources.slice(0, 12).map(source => {
    const missingProfiles = Array.isArray(source.missing_profiles) ? source.missing_profiles : [];
    const targetProfiles = Array.isArray(source.target_profiles) ? source.target_profiles : [];
    const statusClass = Number(source.coverage_score || 0) >= 85
      ? "good"
      : Number(source.coverage_score || 0) >= 60
        ? "warn"
        : "bad";
    const missingText = missingProfiles
      .slice(0, 4)
      .map(profile => profile.label || profile.profile || "")
      .filter(Boolean)
      .join("，");
    const suggestedTerms = missingProfiles.flatMap(profile => profile.suggested_terms || []).slice(0, 5).join("，");
    const coveredText = targetProfiles.slice(0, 4).map(profile => `${profile.profile}:${Number(profile.count || 0)}`).join("，");
    return `
      <div class="rss-followup-job-row">
        <div class="rss-followup-main">
          <strong>${escapeHtml(source.source_key || "免费来源")}</strong>
          <small>目标 ${Number(source.target_count || 0)} · 动态 ${Number(source.dynamic_target_count || 0)} · 已覆盖 ${Number(source.covered_profile_count || 0)}/${Number(source.expected_profile_count || 0)} · ${escapeHtml(coveredText || "-")}</small>
        </div>
        <div class="rss-followup-query">
          <span>${escapeHtml(source.recommendation || "目标覆盖")}</span>
          <strong>${escapeHtml(missingText || suggestedTerms || "目标覆盖正常")}</strong>
        </div>
        <div class="rss-followup-score">
          <span>${escapeHtml(suggestedTerms || "建议词")}</span>
          <strong class="${statusClass}">${Number(source.coverage_score || 0)}</strong>
        </div>
      </div>
    `;
  }).join("") || `<div class="source-summary">暂无免费来源目标覆盖数据</div>`;
}

function renderFreeTargetCoverageEffectiveness(payload = {}) {
  state.freeTargetCoverageEffectiveness = payload;
  const summary = payload.summary || {};
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const targetSummary = $("freeTargetCoverageEffectivenessSummary");
  const targetList = $("freeTargetCoverageEffectivenessList");
  if (!targetSummary || !targetList) return;
  targetSummary.textContent = `目标补扫效果：来源 ${Number(summary.source_count || 0)} · 任务 ${Number(summary.job_count || 0)} · 已恢复 ${Number(summary.recovered_source_count || 0)} · 部分恢复 ${Number(summary.partial_recovered_source_count || 0)} · 失败 ${Number(summary.failed_source_count || 0)} · 待执行 ${Number(summary.pending_source_count || 0)} · 入库 ${Number(summary.inserted_count || 0)} · 缺失 Profile ${Number(summary.missing_profile_count || 0)} · 建议词 ${Number(summary.suggested_term_count || 0)}`;
  targetList.innerHTML = sources.slice(0, 10).map(source => {
    const statusClass = source.recovery_status === "recovered"
      ? "good"
      : source.recovery_status === "partial-recovered" || source.recovery_status === "pending"
        ? "warn"
        : "bad";
    const statusText = {
      recovered: "已恢复",
      "partial-recovered": "部分恢复",
      failed: "失败",
      pending: "待执行",
      "no-evidence": "暂无证据",
    }[source.recovery_status] || source.recovery_status || "暂无证据";
    const missingProfiles = Array.isArray(source.missing_profiles) ? source.missing_profiles.slice(0, 4).join("，") : "";
    const requestedQueries = Array.isArray(source.requested_queries) ? source.requested_queries.slice(0, 2).join("，") : "";
    const suggestedTerms = Array.isArray(source.suggested_terms) ? source.suggested_terms.slice(0, 5).join("，") : "";
    return `
      <div class="rss-followup-job-row">
        <div class="rss-followup-main">
          <strong>${escapeHtml(source.source_key || "目标补扫来源")}</strong>
          <small>任务 ${Number(source.job_count || 0)} · 成功 ${Number(source.success_count || 0)} · 失败 ${Number(source.failed_count || 0)} · 缺口 ${Number(source.max_missing_profile_count || 0)} · 最近 ${escapeHtml(source.latest_updated_at || "-")}</small>
        </div>
        <div class="rss-followup-query">
          <span>${escapeHtml(missingProfiles || "请求查询")}</span>
          <strong>${escapeHtml(requestedQueries || suggestedTerms || "-")}</strong>
        </div>
        <div class="rss-followup-score">
          <span>${escapeHtml(statusText)} · 入库 ${Number(source.inserted_count || 0)} · 失败 ${Number(source.failure_count || 0)}</span>
          <strong class="${statusClass}">${Number(source.latest_coverage_score || 0)}</strong>
        </div>
      </div>
    `;
  }).join("") || `<div class="source-summary">暂无目标覆盖补扫执行记录</div>`;
}

async function loadFreeTargetCoverage() {
  const [coverage, effectiveness] = await Promise.all([
    api(freeTargetCoverageUrl()),
    api(freeTargetCoverageEffectivenessUrl()),
  ]);
  renderFreeTargetCoverage(coverage);
  renderFreeTargetCoverageEffectiveness(effectiveness);
  return { coverage, effectiveness };
}

async function enqueueFreeTargetCoverageFollowups() {
  const button = $("enqueueFreeTargetCoverageBtn");
  if (button) button.disabled = true;
  try {
    const payload = await api(freeTargetCoverageFollowupUrl(), {
      method: "POST",
      body: JSON.stringify({
        apply: true,
        limit: 30,
        operator: "admin",
        reason: "free source target coverage recovery",
      }),
    });
    await loadFreeTargetCoverage();
    const summary = payload.summary || {};
    toast(`目标补扫已入队：创建 ${Number(summary.created_jobs || 0)} 个 · 跳过运行中 ${Number(summary.skipped_running_jobs || 0)} 个`);
    return payload;
  } finally {
    if (button) button.disabled = false;
  }
}

function renderTaiwanNativeDiscoveryPlan(payload = {}) {
  state.taiwanNativeDiscoveryPlan = payload;
  const summary = payload.summary || {};
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const nativeJobs = jobs.filter(job => job.metadata?.task_type === "rss-native-entry-discovery");
  const nativePackGroups = Array.isArray(summary.created_rss_native_entry_discovery_pack_groups)
    ? summary.created_rss_native_entry_discovery_pack_groups
    : Array.isArray(summary.rss_native_entry_discovery_pack_groups)
      ? summary.rss_native_entry_discovery_pack_groups
    : [];
  const targetSummary = $("taiwanNativeDiscoverySummary");
  const targetList = $("taiwanNativeDiscoveryList");
  if (!targetSummary || !targetList) return;
  const packGroupText = nativePackGroups.slice(0, 3)
    .map(group => {
      const created = Number(group.created_job_count || 0);
      const updated = Number(group.updated_job_count || 0);
      const recoveredStale = Number(group.recovered_stale_running_job_count || 0);
      const skippedRunning = Number(group.skipped_running_job_count || 0);
      const maxRunningAgeMinutes = Number(group.max_running_age_minutes || 0);
      const runningAgeText = maxRunningAgeMinutes > 0 ? ` · 最久 ${maxRunningAgeMinutes} 分` : "";
      const suffix = created || updated || recoveredStale || skippedRunning
        ? ` · 新建 ${created} · 更新 ${updated} · 恢复 ${recoveredStale} · 跳过 ${skippedRunning}${runningAgeText}`
        : runningAgeText;
      return `${group.pack_label || group.pack_key || "来源包"} ${Number(group.unattempted_job_count || 0)}/${Number(group.job_count || 0)}${suffix}`;
    })
    .join(" · ");
  targetSummary.textContent = `入口发现预览：来源包 ${Number(summary.rss_native_entry_discovery_pack_group_count || nativePackGroups.length || 0)} 个 · 待发现 ${nativeJobs.length} 个站点 · 未尝试 ${Number(summary.rss_native_entry_discovery_unattempted_jobs || 0)} · 近期已尝试 ${Number(summary.rss_native_entry_discovery_recent_attempt_jobs || 0)} · ${packGroupText || "暂无包级任务"} · 计划任务 ${Number(summary.rss_native_entry_discovery_jobs || 0)} · 最高优先级 ${Number(summary.highest_priority || 0)} · ${payload.applied ? "已入队" : "预览"}`;
  targetList.innerHTML = nativeJobs.slice(0, 8).map(job => {
    const entity = job.entity || {};
    const queryText = Array.isArray(job.query) ? job.query.slice(0, 3).join("，") : "";
    const known = entity.known_index_entries || {};
    const reasons = Array.isArray(job.metadata?.priority_reasons) ? job.metadata.priority_reasons.slice(0, 4).join("，") : "";
    return `
      <div class="rss-followup-job-row">
        <div class="rss-followup-main">
          <strong>${escapeHtml(entity.site_name || job.label || "入口发现")}</strong>
          <small>${escapeHtml(entity.pack_label || entity.pack_key || "-")} · ${escapeHtml(entity.site || "-")} · Google ${Number(known.google_news || 0)} · Bing ${Number(known.bing_news || 0)}</small>
        </div>
        <div class="rss-followup-query">
          <span>发现查询</span>
          <strong>${escapeHtml(queryText || "-")}</strong>
        </div>
        <div class="rss-followup-score">
          <span>${escapeHtml(reasons || "native-rss-json-sitemap")}</span>
          <strong>${Number(job.priority || 0)}</strong>
        </div>
      </div>
    `;
  }).join("") || `<div class="source-summary">暂无需要发现的台湾媒体原生入口</div>`;
}

function renderTaiwanNativeDiscoveryRecovery(payload = {}) {
  state.taiwanNativeDiscoveryRecovery = payload;
  const summary = payload.summary || {};
  const packGroups = Array.isArray(payload.pack_groups) ? payload.pack_groups : [];
  const sites = Array.isArray(payload.sites) ? payload.sites : [];
  const targetSummary = $("taiwanNativeDiscoveryRecoverySummary");
  const targetList = $("taiwanNativeDiscoveryRecoveryList");
  if (!targetSummary || !targetList) return;
  targetSummary.textContent = `入口发现效果：来源包 ${Number(summary.pack_group_count || packGroups.length || 0)} 个 · 追踪 ${Number(summary.tracked_site_count || 0)} 个站点 · 任务 ${Number(summary.job_count || 0)} · 成功 ${Number(summary.success_count || 0)} · 失败 ${Number(summary.failed_count || 0)} · 已恢复 ${Number(summary.recovered_native_entry_site_count || 0)} · 仍缺入口 ${Number(summary.still_missing_native_entry_site_count || 0)} · 未开始 ${Number(summary.not_started_missing_native_entry_site_count || 0)} · 已插入 ${Number(summary.inserted_count || 0)} · 失败候选 ${Number(summary.failed_candidate_count || 0)}`;
  const groupRows = packGroups.slice(0, 6).map(group => {
    const sampleSites = Array.isArray(group.sample_sites) ? group.sample_sites.slice(0, 4).join("，") : "";
    const statusClass = Number(group.still_missing_native_entry_site_count || 0) > 0
      ? Number(group.failed_count || 0) > 0 || Number(group.failed_candidate_count || 0) > 0 ? "bad" : "warn"
      : "good";
    return `
      <div class="rss-followup-job-row">
        <div class="rss-followup-main">
          <strong>${escapeHtml(group.pack_label || group.pack_key || "来源包")}</strong>
          <small>${escapeHtml(group.pack_key || "-")} · 站点 ${Number(group.site_count || 0)} · 样例 ${escapeHtml(sampleSites || "-")}</small>
        </div>
        <div class="rss-followup-query">
          <span>包级恢复</span>
          <strong>已恢复 ${Number(group.recovered_native_entry_site_count || 0)} · 仍缺 ${Number(group.still_missing_native_entry_site_count || 0)} · 未开始 ${Number(group.not_started_missing_native_entry_site_count || 0)} · 插入 ${Number(group.inserted_count || 0)}</strong>
        </div>
        <div class="rss-followup-score">
          <span>任务 ${Number(group.job_count || 0)} · 成功 ${Number(group.success_count || 0)} · 失败 ${Number(group.failed_count || 0)}</span>
          <strong class="${statusClass}">${Number(group.failed_candidate_count || 0)}</strong>
        </div>
      </div>
    `;
  });
  const siteRows = sites.slice(0, 8).map(site => {
    const statusClass = site.current_status === "recovered"
      ? "good"
      : Number(site.failed_count || 0) > 0 || Number(site.failed_candidate_count || 0) > 0
        ? "bad"
        : "warn";
    const statusText = site.current_status === "recovered"
      ? "已恢复"
      : !site.has_recovery_job
        ? "未开始"
        : Number(site.pending_count || 0) > 0
        ? "待执行"
        : Number(site.running_count || 0) > 0
          ? "执行中"
          : Number(site.failed_count || 0) > 0
            ? "执行失败"
            : "仍缺入口";
    const queries = Array.isArray(site.sample_queries) ? site.sample_queries.slice(0, 2).join("，") : "";
    const targets = Array.isArray(site.discovery_targets) ? site.discovery_targets.slice(0, 3).join("，") : "";
    return `
      <div class="rss-followup-job-row">
        <div class="rss-followup-main">
          <strong>${escapeHtml(site.site_name || site.site || "入口发现站点")}</strong>
          <small>${escapeHtml(site.pack_label || site.pack_key || "-")} · ${escapeHtml(site.site || "-")} · 当前入口 ${Number(site.current_native_entry_count || 0)} · Google ${Number(site.current_google_news_index_entry_count || 0)} · Bing ${Number(site.current_bing_news_index_entry_count || 0)}</small>
        </div>
        <div class="rss-followup-query">
          <span>${escapeHtml(targets || "native-rss-json-sitemap")}</span>
          <strong>${escapeHtml(queries || "-")}</strong>
        </div>
        <div class="rss-followup-score">
          <span>${escapeHtml(statusText)} · 插入 ${Number(site.inserted_count || 0)}</span>
          <strong class="${statusClass}">${Number(site.job_count || 0)}</strong>
        </div>
      </div>
    `;
  });
  targetList.innerHTML = [...groupRows, ...siteRows].join("") || `<div class="source-summary">暂无入口发现执行记录</div>`;
}

function renderRssFollowupPlan(payload = {}) {
  state.followupPlan = payload;
  const summary = payload.summary || {};
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const rssJobs = jobs.filter(job => job.metadata?.task_type === "rss-priority-site-gap");
  const sourceFamilyRefreshJobs = jobs.filter(job => job.metadata?.task_type === "rss-source-family-refresh");
  const refreshFamilies = Array.isArray(summary.rss_source_family_refresh_families) ? summary.rss_source_family_refresh_families.slice(0, 4).join("，") : "";
  $("rssFollowupSummary").textContent = `待补采 ${rssJobs.length} 个重点站点任务 · 来源家族刷新 ${Number(summary.rss_source_family_refresh_jobs || 0)} · 家族 ${Number(summary.rss_source_family_refresh_family_count || 0)} · 模式 ${Number(summary.rss_source_family_refresh_mode_count || 0)} · 家族清单 ${refreshFamilies || "-"} · 空站点 ${Number(summary.rss_priority_site_empty_recovery_jobs || 0)} · 久未更新 ${Number(summary.rss_priority_site_stale_refresh_jobs || 0)} · 双索引 ${Number(summary.rss_priority_site_dual_index_jobs || 0)} · 最高优先级 ${Number(summary.highest_priority || 0)} · ${payload.applied ? "已入队" : "预览"}`;
  $("rssFollowupJobList").innerHTML = rssJobs.slice(0, 12).map(job => {
    const entity = job.entity || {};
    const metadata = job.metadata || {};
    const queryText = Array.isArray(job.query) ? job.query.slice(0, 3).join("，") : "";
    const engines = Array.isArray(metadata.recovery_index_engines)
      ? metadata.recovery_index_engines
      : Array.isArray(entity.recovery_index_engines)
        ? entity.recovery_index_engines
        : [];
    const engineText = engines.length
      ? engines.map(engine => engine === "google-news" ? "Google News" : engine === "bing-news" ? "Bing News" : engine).join(" + ")
      : "-";
    return `
      <div class="rss-followup-job-row">
        <div class="rss-followup-main">
          <strong>${escapeHtml(entity.site_name || job.label || job.sourceKey || "补采任务")}</strong>
          <small>${escapeHtml(entity.pack_label || entity.pack_key || "-")} · ${escapeHtml(entity.site || "-")} · 索引 ${escapeHtml(engineText)}</small>
        </div>
        <div class="rss-followup-query">
          <span>查询</span>
          <strong>${escapeHtml(queryText || "-")}</strong>
        </div>
        <div class="rss-followup-score">
          <span>优先级</span>
          <strong>${Number(job.priority || 0)}</strong>
        </div>
      </div>
    `;
  }).join("") || `<div class="source-summary">暂无可入队的重点站点补采任务</div>`;
  const refreshTarget = $("rssSourceFamilyRefreshPlanList");
  if (refreshTarget) {
    refreshTarget.innerHTML = sourceFamilyRefreshJobs.slice(0, 12).map(job => {
      const entity = job.entity || {};
      const metadata = job.metadata || {};
      const mode = entity.mode || metadata.mode || job.mode || "";
      const queryText = Array.isArray(job.query) ? job.query.slice(0, 3).join("，") : "";
      const packKeys = Array.isArray(entity.pack_keys)
        ? entity.pack_keys
        : Array.isArray(metadata.pack_keys)
          ? metadata.pack_keys
          : [];
      return `
        <div class="rss-followup-job-row">
          <div class="rss-followup-main">
            <strong>${escapeHtml(entity.source_family_label || metadata.source_family_label || job.label || "来源家族刷新")}</strong>
            <small>${escapeHtml(SOURCE_MODE_LABELS[mode] || mode || "-")} · ${escapeHtml(entity.source_family || metadata.source_family || "-")} · 媒体包 ${escapeHtml(packKeys.join("，") || "-")}</small>
          </div>
          <div class="rss-followup-query">
            <span>查询</span>
            <strong>${escapeHtml(queryText || "-")}</strong>
          </div>
          <div class="rss-followup-score">
            <span>配置 ${Number(entity.configured_score ?? metadata.configured_score ?? 0)} · 近期证据 ${Number(entity.observed_score ?? metadata.observed_score ?? 0)}</span>
            <strong>${Number(job.priority || metadata.priority_score || 0)}</strong>
          </div>
        </div>
      `;
    }).join("") || `<div class="source-summary">暂无可入队的来源家族刷新任务</div>`;
  }
}

function renderRssFollowupRecovery(payload = {}) {
  state.followupRecovery = payload;
  const summary = payload.summary || {};
  const sites = Array.isArray(payload.sites) ? payload.sites : [];
  $("rssFollowupRecoverySummary").textContent = `补采效果：已追踪 ${Number(summary.tracked_site_count || 0)} 个站点 · 已恢复 ${Number(summary.recovered_site_count || 0)} · 久未更新 ${Number(summary.stale_site_count || 0)} · 仍为空 ${Number(summary.still_empty_site_count || 0)} · 空站点任务 ${Number(summary.empty_recovery_site_count || 0)} · 刷新任务 ${Number(summary.stale_refresh_site_count || 0)} · 运行时恢复 ${Number(summary.runtime_recovery_site_count || 0)} · 异常入口 ${Number(summary.runtime_unhealthy_feed_count || 0)} · 双索引 ${Number(summary.dual_index_site_count || 0)} · 请求索引 ${Number(summary.requested_index_feed_count || 0)} · 失败索引 ${Number(summary.failed_index_feed_count || 0)} · 入库 ${Number(summary.inserted_count || 0)} · 成功任务 ${Number(summary.success_count || 0)}`;
  $("rssFollowupRecoveryList").innerHTML = sites.slice(0, 10).map(site => {
    const statusClass = site.current_status === "recovered" ? "good" : site.failed_count > 0 ? "bad" : "warn";
    const statusText = site.current_status === "recovered" ? "已恢复" : site.current_status === "stale" ? "久未更新" : site.pending_count > 0 ? "待执行" : site.failed_count > 0 ? "执行失败" : "仍为空";
    const engines = Array.isArray(site.recovery_index_engines)
      ? site.recovery_index_engines.map(engine => engine === "google-news" ? "Google News" : engine === "bing-news" ? "Bing News" : engine).join(" + ")
      : "";
    const failedEngines = Array.isArray(site.failed_index_engines)
      ? site.failed_index_engines.map(engine => engine === "google-news" ? "Google News" : engine === "bing-news" ? "Bing News" : engine).join(" + ")
      : "";
    return `
      <div class="rss-followup-job-row">
        <div class="rss-followup-main">
          <strong>${escapeHtml(site.site_name || site.site || "重点站点")}</strong>
          <small>${escapeHtml(site.pack_label || site.pack_key || "-")} · ${escapeHtml(site.site || "-")} · 索引 ${escapeHtml(engines || "-")} · 失败 ${escapeHtml(failedEngines || "无")} · 入库 ${Number(site.inserted_count || 0)}</small>
        </div>
        <div class="rss-followup-query">
          <span>最近查询</span>
          <strong>${escapeHtml((site.sample_queries || []).slice(0, 2).join("，") || "-")}</strong>
        </div>
        <div class="rss-followup-score">
          <span>${escapeHtml(statusText)}</span>
          <strong class="${statusClass}">${Number(site.current_evidence_count || 0)}</strong>
        </div>
      </div>
    `;
  }).join("") || `<div class="source-summary">暂无补采执行记录</div>`;
}

function renderRssSourceFamilyRefreshRecovery(payload = {}) {
  state.sourceFamilyRefreshRecovery = payload;
  const summary = payload.summary || {};
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const targetSummary = $("rssSourceFamilyRefreshRecoverySummary");
  const targetList = $("rssSourceFamilyRefreshRecoveryList");
  if (!targetSummary || !targetList) return;
  targetSummary.textContent = `来源家族刷新：追踪 ${Number(summary.tracked_group_count || 0)} 组 · 必需 ${Number(summary.current_required_group_count || 0)} · 模式 ${Number(summary.mode_count || 0)} · 来源家族 ${Number(summary.source_family_count || 0)} · 已有近期证据 ${Number(summary.observed_group_count || 0)} · 已尝试 ${Number(summary.attempted_group_count || 0)} · 未开始 ${Number(summary.not_started_group_count || 0)} · 入库 ${Number(summary.inserted_count || 0)} · 成功 ${Number(summary.success_count || 0)} · 失败 ${Number(summary.failed_count || 0)} · 运行中 ${Number(summary.running_count || 0)}`;
  targetList.innerHTML = groups.slice(0, 12).map(group => {
    const statusClass = group.recovery_status === "observed"
      ? "good"
      : group.recovery_status === "inserted-but-not-yet-reflected"
        ? "warn"
        : group.failed_count > 0
          ? "bad"
          : "warn";
    const statusText = {
      observed: "已有近期证据",
      "inserted-but-not-yet-reflected": "已入库待反映",
      attempted: "已尝试",
      "not-started": "未开始",
    }[group.recovery_status] || "待观察";
    const packs = Array.isArray(group.pack_keys) ? group.pack_keys.join("，") : "";
    const queries = Array.isArray(group.sample_queries) ? group.sample_queries.slice(0, 2).join("，") : "";
    const failedTargets = Array.isArray(group.failed_targets) ? group.failed_targets.slice(0, 2).join("，") : "";
    const latest = group.latest_updated_at ? formatDateTime(group.latest_updated_at) : "-";
    const recommendationText = group.recommendation_text || group.recommended_action || "";
    return `
      <div class="rss-followup-job-row">
        <div class="rss-followup-main">
          <strong>${escapeHtml(group.source_family_label || group.source_family || "来源家族")}</strong>
          <small>${escapeHtml(SOURCE_MODE_LABELS[group.mode] || group.mode || "-")} · ${escapeHtml(group.source_family || "-")} · 媒体包 ${escapeHtml(packs || "-")} · 请求包 ${Number(group.requested_pack_count || 0)} · 最近 ${escapeHtml(latest)}</small>
        </div>
        <div class="rss-followup-query">
          <span>${failedTargets ? "失败目标" : "建议动作"}</span>
          <strong>${escapeHtml(failedTargets || recommendationText || queries || "-")}</strong>
        </div>
        <div class="rss-followup-score">
          <span>${escapeHtml(statusText)} · ${escapeHtml(group.recommended_action || "-")} · 任务 ${Number(group.job_count || 0)} · 失败 ${Number(group.failed_count || 0)} · 诊断失败 ${Number(group.diagnostic_failure_count || 0)}</span>
          <strong class="${statusClass}">${Number(group.inserted_count || 0)}</strong>
        </div>
      </div>
    `;
  }).join("") || `<div class="source-summary">暂无来源家族刷新执行记录</div>`;
}

function renderNativePromotionEffectiveness(payload = {}) {
  state.nativePromotionEffectiveness = payload;
  const summary = payload.summary || {};
  const feeds = Array.isArray(payload.feeds) ? payload.feeds : [];
  const targetSummary = $("rssNativePromotionSummary");
  const targetList = $("rssNativePromotionList");
  if (!targetSummary || !targetList) return;
  targetSummary.textContent = `已晋升 ${Number(summary.promoted_feed_count || 0)} 个入口 · 有效 ${Number(summary.productive_feed_count || 0)} · 久未更新 ${Number(summary.stale_feed_count || 0)} · 暂无证据 ${Number(summary.empty_feed_count || 0)} · 证据 ${Number(summary.evidence_count || 0)} · 高相关入口 ${Number(summary.high_relevance_feed_count || 0)} · 高质量入口 ${Number(summary.high_quality_feed_count || 0)}`;
  targetList.innerHTML = feeds.slice(0, 12).map(feed => {
    const statusClass = feed.status === "productive" ? "good" : feed.status === "stale" ? "warn" : "bad";
    const statusText = feed.status === "productive" ? "有效产出" : feed.status === "stale" ? "久未更新" : "暂无证据";
    const latest = feed.latest_captured_at
      ? `${feed.latest_captured_at}${feed.days_since_latest_captured !== null && feed.days_since_latest_captured !== undefined ? ` · ${feed.days_since_latest_captured}天` : ""}`
      : "无";
    const keywords = Array.isArray(feed.matched_keywords) ? feed.matched_keywords.slice(0, 4).join("，") : "";
    const samples = Array.isArray(feed.sample_titles) ? feed.sample_titles.slice(0, 2).join("，") : "";
    return `
      <div class="rss-followup-job-row">
        <div class="rss-followup-main">
          <strong>${escapeHtml(feed.feed_name || feed.feed_url || "晋升入口")}</strong>
          <small>${escapeHtml(feed.pack_key || "-")} · ${escapeHtml(feed.site || "-")} · ${escapeHtml(feed.feed_url || "-")}</small>
        </div>
        <div class="rss-followup-query">
          <span>关键词 / 样本</span>
          <strong>${escapeHtml(keywords || samples || "-")}</strong>
        </div>
        <div class="rss-followup-score">
          <span>${escapeHtml(statusText)} · ${escapeHtml(latest)}</span>
          <strong class="${statusClass}">${Number(feed.evidence_count || 0)}</strong>
        </div>
      </div>
    `;
  }).join("") || `<div class="source-summary">暂无已晋升的 RSS 原生入口</div>`;
}

function renderNativePromotionRefreshPlan(payload = {}) {
  state.nativePromotionRefreshPlan = payload;
  const summary = payload.summary || {};
  const target = $("rssNativePromotionRefreshSummary");
  if (!target) return;
  target.textContent = `可刷新 ${Number(summary.refresh_job_count || 0)} 个失效晋升入口 · 久未更新 ${Number(summary.stale_feed_count || 0)} · 暂无证据 ${Number(summary.empty_feed_count || 0)} · 最高优先级 ${Number(summary.highest_priority || 0)} · ${payload.applied ? "已入队" : "预览"}`;
}

function renderNativePromotionRefreshRecovery(payload = {}) {
  state.nativePromotionRefreshRecovery = payload;
  const summary = payload.summary || {};
  const feeds = Array.isArray(payload.feeds) ? payload.feeds : [];
  const targetSummary = $("rssNativePromotionRefreshRecoverySummary");
  const targetList = $("rssNativePromotionRefreshRecoveryList");
  if (!targetSummary || !targetList) return;
  targetSummary.textContent = `刷新效果：追踪 ${Number(summary.tracked_feed_count || 0)} 个入口 · 任务 ${Number(summary.job_count || 0)} · 成功 ${Number(summary.success_count || 0)} · 失败 ${Number(summary.failed_count || 0)} · 已恢复 ${Number(summary.recovered_feed_count || 0)} · 待观察 ${Number(summary.inserted_pending_feed_count || 0)} · 入库 ${Number(summary.inserted_count || 0)}`;
  targetList.innerHTML = feeds.slice(0, 10).map(feed => {
    const statusClass = feed.recovery_status === "recovered" ? "good" : feed.recovery_status === "failed" ? "bad" : "warn";
    const statusText = feed.recovery_status === "recovered"
      ? "已恢复"
      : feed.recovery_status === "inserted-pending-effectiveness"
        ? "已入库待观察"
        : feed.recovery_status === "pending"
          ? "待执行"
          : feed.recovery_status === "failed"
            ? "执行失败"
            : "未恢复";
    return `
      <div class="rss-followup-job-row">
        <div class="rss-followup-main">
          <strong>${escapeHtml(feed.feed_name || feed.feed_url || "刷新入口")}</strong>
          <small>${escapeHtml(feed.pack_key || "-")} · ${escapeHtml(feed.site || "-")} · ${escapeHtml(feed.feed_url || "-")} · 当前 ${escapeHtml(feed.current_status || "-")}</small>
        </div>
        <div class="rss-followup-query">
          <span>最近查询</span>
          <strong>${escapeHtml((feed.sample_queries || []).slice(0, 2).join("，") || "-")}</strong>
        </div>
        <div class="rss-followup-score">
          <span>${escapeHtml(statusText)} · 入库 ${Number(feed.inserted_count || 0)}</span>
          <strong class="${statusClass}">${Number(feed.job_count || 0)}</strong>
        </div>
      </div>
    `;
  }).join("") || `<div class="source-summary">暂无晋升入口刷新执行记录</div>`;
}

function renderNativePromotionGovernance(payload = {}) {
  state.nativePromotionGovernance = payload;
  const summary = payload.summary || {};
  const feeds = Array.isArray(payload.feeds) ? payload.feeds : [];
  const targetSummary = $("rssNativePromotionGovernanceSummary");
  const targetList = $("rssNativePromotionGovernanceList");
  if (!targetSummary || !targetList) return;
  targetSummary.textContent = `治理建议：保留 ${Number(summary.keep_count || 0)} · 刷新 ${Number(summary.refresh_count || 0)} · 观察 ${Number(summary.monitor_count || 0)} · 人工复核 ${Number(summary.manual_review_count || 0)} · 高风险 ${Number(summary.bad_count || 0)}`;
  targetList.innerHTML = feeds.slice(0, 10).map(feed => {
    const statusClass = feed.severity === "good" ? "good" : feed.severity === "bad" ? "bad" : "warn";
    return `
      <div class="rss-followup-job-row">
        <div class="rss-followup-main">
          <strong>${escapeHtml(feed.feed_name || feed.feed_url || "治理入口")}</strong>
          <small>${escapeHtml(feed.pack_key || "-")} · ${escapeHtml(feed.site || "-")} · ${escapeHtml(feed.status || "-")} · 刷新任务 ${Number(feed.refresh_job_count || 0)}</small>
        </div>
        <div class="rss-followup-query">
          <span>${escapeHtml(feed.action || "建议")}</span>
          <strong>${escapeHtml(feed.recommendation_text || "-")}</strong>
        </div>
        <div class="rss-followup-score">
          <span>${escapeHtml(feed.reason || "-")} · 证据 ${Number(feed.evidence_count || 0)}</span>
          <strong class="${statusClass}">${escapeHtml(feed.severity || "info")}</strong>
        </div>
      </div>
    `;
  }).join("") || `<div class="source-summary">暂无晋升入口治理建议</div>`;
}

async function loadRssFollowupPlan() {
  const [plan, recovery, sourceFamilyRefreshRecovery, nativePromotion, nativePromotionRefresh, nativePromotionRefreshRecovery, nativePromotionGovernance, taiwanMediaHealth, taiwanPublicInterestHealth, taiwanNativeDiscoveryPlan, taiwanNativeDiscoveryRecovery] = await Promise.all([
    api(followupPlanUrl()),
    api(followupRecoveryUrl()),
    api(sourceFamilyRefreshRecoveryUrl()),
    api(nativePromotionEffectivenessUrl()),
    api(nativePromotionRefreshUrl()),
    api(nativePromotionRefreshRecoveryUrl()),
    api(nativePromotionGovernanceUrl()),
    api(taiwanMediaHealthUrl()),
    api(taiwanPublicInterestHealthUrl()),
    api(taiwanNativeDiscoveryPlanUrl()),
    api(taiwanNativeDiscoveryRecoveryUrl()),
  ]);
  renderRssFollowupPlan(plan);
  renderRssFollowupRecovery(recovery);
  renderRssSourceFamilyRefreshRecovery(sourceFamilyRefreshRecovery);
  renderNativePromotionEffectiveness(nativePromotion);
  renderNativePromotionRefreshPlan(nativePromotionRefresh);
  renderNativePromotionRefreshRecovery(nativePromotionRefreshRecovery);
  renderNativePromotionGovernance(nativePromotionGovernance);
  renderTaiwanMediaHealth(taiwanMediaHealth);
  renderTaiwanPublicInterestHealth(taiwanPublicInterestHealth);
  renderTaiwanNativeDiscoveryPlan(taiwanNativeDiscoveryPlan);
  renderTaiwanNativeDiscoveryRecovery(taiwanNativeDiscoveryRecovery);
  return plan;
}

async function enqueueRssFollowupPlan() {
  $("enqueueFollowupPlanBtn").disabled = true;
  try {
    const payload = await api("/api/sentiment/collection-jobs/recoverable-followups", {
      method: "POST",
      body: JSON.stringify({
        apply: true,
        days: 30,
        limit: 30,
        includeDeepCrawl: false,
        includeSocialFollowup: false,
        includeAccessBarrierAlternates: false,
        includeRssPrioritySiteGaps: true,
        includeRssSourceFamilyRefresh: true,
        includeCollectionOperationsRemediation: false,
        includeFreeSourceTargetCoverageFollowups: false,
        operator: "admin",
        reason: "rss priority site gap recovery",
      }),
    });
    renderRssFollowupPlan(payload);
    renderRssFollowupRecovery(await api(followupRecoveryUrl()));
    renderRssSourceFamilyRefreshRecovery(await api(sourceFamilyRefreshRecoveryUrl()));
    renderNativePromotionEffectiveness(await api(nativePromotionEffectivenessUrl()));
    renderNativePromotionRefreshPlan(await api(nativePromotionRefreshUrl()));
    renderNativePromotionRefreshRecovery(await api(nativePromotionRefreshRecoveryUrl()));
    renderNativePromotionGovernance(await api(nativePromotionGovernanceUrl()));
    renderTaiwanMediaHealth(await api(taiwanMediaHealthUrl()));
    renderTaiwanPublicInterestHealth(await api(taiwanPublicInterestHealthUrl()));
    renderTaiwanNativeDiscoveryPlan(await api(taiwanNativeDiscoveryPlanUrl()));
    renderTaiwanNativeDiscoveryRecovery(await api(taiwanNativeDiscoveryRecoveryUrl()));
    toast(`已入队 ${Number(payload.summary?.created_jobs || 0)} 个补采任务 · 来源家族刷新新建 ${Number(payload.summary?.created_rss_source_family_refresh_jobs || 0)} · 运行中跳过 ${Number(payload.summary?.skipped_running_rss_source_family_refresh_jobs || 0)}`);
  } finally {
    $("enqueueFollowupPlanBtn").disabled = false;
  }
}

async function enqueueTaiwanNativeDiscovery() {
  $("enqueueTaiwanNativeDiscoveryBtn").disabled = true;
  try {
    const payload = await api("/api/sentiment/collection-jobs/recoverable-followups", {
      method: "POST",
      body: JSON.stringify({
        apply: true,
        days: 30,
        limit: 40,
        includeDeepCrawl: false,
        includeSocialFollowup: false,
        includeAccessBarrierAlternates: false,
        includeRssPrioritySiteGaps: false,
        includeRssNativeEntryDiscovery: true,
        includeEvidenceCoverageFollowups: false,
        includeCollectionOperationsRemediation: false,
        includeFreeSourceTargetCoverageFollowups: false,
        operator: "admin",
        reason: "taiwan media native rss json sitemap discovery",
      }),
    });
    renderTaiwanMediaHealth(await api(taiwanMediaHealthUrl()));
    renderTaiwanPublicInterestHealth(await api(taiwanPublicInterestHealthUrl()));
    renderTaiwanNativeDiscoveryPlan(payload);
    renderTaiwanNativeDiscoveryRecovery(await api(taiwanNativeDiscoveryRecoveryUrl()));
    renderRssFollowupPlan(await api(followupPlanUrl()));
    renderRssFollowupRecovery(await api(followupRecoveryUrl()));
    renderNativePromotionRefreshPlan(await api(nativePromotionRefreshUrl()));
    const created = Number(payload.summary?.created_jobs || 0);
    const createdNative = Number(payload.summary?.created_rss_native_entry_discovery_jobs || 0);
    const newlyCreatedNative = Number(payload.summary?.newly_created_rss_native_entry_discovery_jobs || 0);
    const updatedNative = Number(payload.summary?.updated_existing_rss_native_entry_discovery_jobs || 0);
    const recoveredStaleNative = Number(payload.summary?.recovered_stale_running_rss_native_entry_discovery_jobs || 0);
    const skippedRunningNative = Number(payload.summary?.skipped_running_rss_native_entry_discovery_jobs || 0);
    const planned = Number(payload.summary?.rss_native_entry_discovery_jobs || 0);
    const packCount = Number(payload.summary?.created_rss_native_entry_discovery_pack_group_count || payload.summary?.skipped_running_rss_native_entry_discovery_pack_group_count || payload.summary?.rss_native_entry_discovery_pack_group_count || 0);
    toast(created || skippedRunningNative ? `已入队/更新 ${createdNative || created} 个入口发现任务 · 新建 ${newlyCreatedNative} · 更新 ${updatedNative} · 恢复卡死 ${recoveredStaleNative} · 运行中跳过 ${skippedRunningNative} · 来源包 ${packCount}` : `暂无新的入口发现任务 · 预览 ${planned} · 来源包 ${packCount}`);
  } finally {
    $("enqueueTaiwanNativeDiscoveryBtn").disabled = false;
  }
}

async function loadNativePromotionRefreshPlan() {
  const [effectiveness, refreshPlan, refreshRecovery, governance, taiwanMediaHealth, taiwanPublicInterestHealth, taiwanNativeDiscoveryPlan, taiwanNativeDiscoveryRecovery] = await Promise.all([
    api(nativePromotionEffectivenessUrl()),
    api(nativePromotionRefreshUrl()),
    api(nativePromotionRefreshRecoveryUrl()),
    api(nativePromotionGovernanceUrl()),
    api(taiwanMediaHealthUrl()),
    api(taiwanPublicInterestHealthUrl()),
    api(taiwanNativeDiscoveryPlanUrl()),
    api(taiwanNativeDiscoveryRecoveryUrl()),
  ]);
  renderNativePromotionEffectiveness(effectiveness);
  renderNativePromotionRefreshPlan(refreshPlan);
  renderNativePromotionRefreshRecovery(refreshRecovery);
  renderNativePromotionGovernance(governance);
  renderTaiwanMediaHealth(taiwanMediaHealth);
  renderTaiwanPublicInterestHealth(taiwanPublicInterestHealth);
  renderTaiwanNativeDiscoveryPlan(taiwanNativeDiscoveryPlan);
  renderTaiwanNativeDiscoveryRecovery(taiwanNativeDiscoveryRecovery);
  return refreshPlan;
}

async function enqueueNativePromotionRefreshPlan() {
  $("enqueueNativePromotionRefreshBtn").disabled = true;
  try {
    const payload = await api("/api/sentiment/collection-jobs/rss-native-entry-promotion-refresh", {
      method: "POST",
      body: JSON.stringify({
        apply: true,
        days: 30,
        freshnessDays: 14,
        limit: 30,
        operator: "admin",
        reason: "refresh ineffective promoted native rss entries",
      }),
    });
    renderNativePromotionRefreshPlan(payload);
    renderNativePromotionEffectiveness(await api(nativePromotionEffectivenessUrl()));
    renderNativePromotionRefreshRecovery(await api(nativePromotionRefreshRecoveryUrl()));
    renderNativePromotionGovernance(await api(nativePromotionGovernanceUrl()));
    renderTaiwanMediaHealth(await api(taiwanMediaHealthUrl()));
    renderTaiwanPublicInterestHealth(await api(taiwanPublicInterestHealthUrl()));
    renderTaiwanNativeDiscoveryPlan(await api(taiwanNativeDiscoveryPlanUrl()));
    toast(`已入队 ${Number(payload.summary?.created_jobs || 0)} 个晋升入口刷新任务`);
  } finally {
    $("enqueueNativePromotionRefreshBtn").disabled = false;
  }
}

async function applyNativePromotionGovernance() {
  $("applyNativePromotionGovernanceBtn").disabled = true;
  try {
    const payload = await api("/api/sentiment/rss-feed-pack-coverage/native-entry-promotion-governance/apply", {
      method: "POST",
      body: JSON.stringify({
        apply: true,
        disable: false,
        days: 30,
        freshnessDays: 14,
        limit: 100,
        operator: "admin",
        reason: "mark promoted native feeds that require manual review",
      }),
    });
    renderNativePromotionGovernance(await api(nativePromotionGovernanceUrl()));
    renderNativePromotionEffectiveness(await api(nativePromotionEffectivenessUrl()));
    renderTaiwanMediaHealth(await api(taiwanMediaHealthUrl()));
    renderTaiwanPublicInterestHealth(await api(taiwanPublicInterestHealthUrl()));
    renderTaiwanNativeDiscoveryPlan(await api(taiwanNativeDiscoveryPlanUrl()));
    renderTaiwanNativeDiscoveryRecovery(await api(taiwanNativeDiscoveryRecoveryUrl()));
    toast(`已标记 ${Number(payload.summary?.marked_feed_count || 0)} 个需复核入口`);
  } finally {
    $("applyNativePromotionGovernanceBtn").disabled = false;
  }
}

function renderRssPackCoverage(payload = {}) {
  state.rssPackCoverage = payload;
  const summary = payload.summary || {};
  const packs = Array.isArray(payload.packs) ? payload.packs : [];
  const status = $("rssPackStatus");
  if (!payload.ok) {
    status.textContent = "加载失败";
    status.className = "status-pill bad";
    $("rssPackList").innerHTML = `<div class="source-summary">RSS 媒体包覆盖数据加载失败</div>`;
    renderMetricStrip("rssPackSummary", []);
    renderRssModeCoverage({});
    renderRssPrioritySiteGaps({});
    return;
  }
  const staleCount = Number(summary.stale_or_empty_pack_count || 0);
  const observedCount = Number(summary.observed_pack_count || 0);
  status.textContent = staleCount
    ? `已检测 · ${staleCount} 个空包`
    : observedCount
      ? "覆盖正常"
      : "暂无证据";
  status.className = `status-pill ${staleCount ? "warn" : observedCount ? "good" : ""}`;
  renderMetricStrip("rssPackSummary", [
    { label: "配置包", value: String(summary.configured_pack_count || 0) },
    { label: "有证据包", value: String(summary.observed_pack_count || 0) },
    { label: "总证据", value: String(summary.evidence_count || 0) },
    { label: "高质量", value: String(summary.high_quality_evidence_count || 0) },
    { label: "高相关", value: String(summary.high_relevance_evidence_count || 0) },
    { label: "重点站点", value: `${Number(summary.observed_priority_site_count || 0)}/${Number(summary.priority_site_count || 0)}` },
    { label: "新鲜站点", value: String(summary.fresh_priority_site_count || 0) },
    { label: "久未更新", value: String(summary.stale_priority_site_count || 0) },
    { label: "空站点", value: String(summary.empty_priority_site_count || 0) },
    { label: "双索引站点", value: `${Number(summary.index_redundancy?.dual_index_site_count || 0)}/${Number(summary.index_redundancy?.indexed_site_count || 0)}` },
    { label: "平均质量", value: String(summary.average_quality_score || 0) },
  ]);
  renderRssModeCoverage(payload);
  renderRssPrioritySiteGaps(payload);
  $("rssPackList").innerHTML = packs.map(pack => {
    const evidenceCount = Number(pack.evidence_count || 0);
    const healthClass = evidenceCount > 0 ? "good" : pack.configured ? "warn" : "";
    const healthText = evidenceCount > 0 ? "有证据" : pack.configured ? "空包" : "未配置";
    const topFeeds = (pack.top_feeds || []).slice(0, 3).map(item => `${item.feed_name} ${item.count}`).join("，") || "-";
    const topTiers = (pack.source_weight_tiers || []).slice(0, 3).map(item => `${item.tier} ${item.count}`).join("，") || "-";
    const prioritySites = Array.isArray(pack.priority_sites) ? pack.priority_sites : [];
    const observedSites = prioritySites.filter(site => Number(site.evidence_count || 0) > 0);
    const freshSites = prioritySites.filter(site => site.fresh === true);
    const staleSites = prioritySites.filter(site => site.stale === true);
    const emptySites = prioritySites.filter(site => Number(site.evidence_count || 0) === 0);
    const observedSiteText = observedSites.slice(0, 5).map(site => `${site.name} ${Number(site.evidence_count || 0)}`).join("，") || "-";
    const freshSiteText = freshSites.slice(0, 5).map(site => site.name).join("，") || "无";
    const staleSiteText = staleSites.slice(0, 5).map(site => `${site.name}${site.days_since_latest_captured ? ` ${site.days_since_latest_captured}天` : ""}`).join("，") || "无";
    const emptySiteText = emptySites.slice(0, 6).map(site => site.name).join("，") || "无";
    const prioritySiteBadges = renderRssPackSiteBadges(prioritySites, { emptyText: "无重点站点", limit: 48 });
    const indexStats = pack.index_redundancy || {};
    const indexText = `双索引 ${Number(indexStats.dual_index_site_count || 0)}/${Number(indexStats.indexed_site_count || 0)} · Google ${Number(indexStats.google_news_index_feed_count || 0)} · Bing ${Number(indexStats.bing_news_index_feed_count || 0)}`;
    const indexGapText = Number(indexStats.missing_bing_index_site_count || 0) || Number(indexStats.missing_google_index_site_count || 0)
      ? `缺 Bing ${Number(indexStats.missing_bing_index_site_count || 0)} · 缺 Google ${Number(indexStats.missing_google_index_site_count || 0)}`
      : "无索引缺口";
    const familyGroups = Array.isArray(pack.priority_site_family_groups) ? pack.priority_site_family_groups : [];
    const familyGroupText = familyGroups.map(group => {
      const observed = Number(group.observed_priority_site_count || 0);
      const fresh = Number(group.fresh_priority_site_count || 0);
      const stale = Number(group.stale_priority_site_count || 0);
      const total = Number(group.priority_site_count || 0);
      const empty = Number(group.empty_priority_site_count || 0);
      return `${group.family} ${observed}/${total}${fresh ? ` · 新鲜 ${fresh}` : ""}${stale ? ` · 久未更新 ${stale}` : ""}${empty ? ` · 空 ${empty}` : ""}`;
    }).join("；") || "-";
    const latest = pack.latest_captured_at ? formatDateTime(pack.latest_captured_at) : "-";
    return `
      <div class="rss-pack-row">
        <div class="rss-pack-main">
          <strong>${escapeHtml(pack.pack_label || pack.pack_key)}</strong>
          <small>${escapeHtml(pack.pack_key)} · 配置 Feed ${Number(pack.configured_feed_count || 0)} · 重点站点 ${Number(pack.configured_priority_site_count || 0)}</small>
        </div>
        <span class="status-pill ${healthClass}">${escapeHtml(healthText)}</span>
        <div class="rss-pack-score">
          <span>证据</span>
          <strong>${evidenceCount}</strong>
        </div>
        <div class="rss-pack-score">
          <span>质量</span>
          <strong>${Number(pack.average_quality_score || 0)}</strong>
        </div>
        <div class="rss-pack-detail">
          <span>最近 ${escapeHtml(latest)}</span>
          <small>Feed：${escapeHtml(topFeeds)}</small>
          <small>Tier：${escapeHtml(topTiers)}</small>
          <small>索引：${escapeHtml(indexText)}；${escapeHtml(indexGapText)}</small>
          <small>分组：${escapeHtml(familyGroupText)}</small>
          <small>重点站点：${escapeHtml(observedSiteText)}；新鲜：${escapeHtml(freshSiteText)}；久未更新：${escapeHtml(staleSiteText)}；空站点：${escapeHtml(emptySiteText)}</small>
          <span class="rss-pack-sites">${prioritySiteBadges}</span>
        </div>
      </div>
    `;
  }).join("") || `<div class="source-summary">暂无 RSS 媒体包配置</div>`;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function authUrlsForBrowserProfile(profile = {}) {
  const configured = Array.isArray(profile.authUrls || profile.auth_urls)
    ? (profile.authUrls || profile.auth_urls)
    : [];
  if (configured.length) return configured.map(item => String(item || "").trim()).filter(Boolean);
  if (profile.authUrl || profile.auth_url) return [String(profile.authUrl || profile.auth_url)];
  const domain = String(profile.domain || "").replace(/^\.+/, "").replace(/^www\./, "");
  if (!domain) return [];
  if (domain === "youtube.com") return ["https://www.youtube.com/"];
  if (domain === "reddit.com") return ["https://www.reddit.com/"];
  if (domain === "dcard.tw") return ["https://www.dcard.tw/"];
  if (domain === "threads.net") return ["https://www.threads.net/", "https://www.instagram.com/accounts/login/"];
  if (domain === "x.com" || domain === "twitter.com") return ["https://x.com/"];
  return [`https://${domain}/`];
}

async function ensureConfigLoaded() {
  const profiles = state.searchSettings?.browserFallback?.profiles || [];
  if (state.configLoaded && profiles.length) return;
  if (!state.loadPromise) {
    state.loadPromise = loadAll().finally(() => {
      state.loadPromise = null;
    });
  }
  await state.loadPromise;
}

async function openBrowserAuthorizationPages() {
  await ensureConfigLoaded();
  const profiles = state.searchSettings?.browserFallback?.profiles || [];
  const urls = [...new Set(profiles.flatMap(authUrlsForBrowserProfile).filter(Boolean))];
  if (!urls.length) {
    toast("没有可打开的浏览器授权 Profile");
    return;
  }
  let opened = 0;
  for (const url of urls) {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (win) opened += 1;
  }
  $("browserAuthStatus").textContent = `已打开 ${opened} / ${urls.length} 个授权页面；登录完成后授权助手扩展会自动记录 Cookie`;
  if (opened < urls.length) toast("浏览器拦截了部分弹窗，请允许此站点打开弹窗后重试");
}

async function openSingleBrowserAuthorization(profileKey = "") {
  await ensureConfigLoaded();
  const profiles = state.searchSettings?.browserFallback?.profiles || [];
  const profile = profiles.find(item => item.key === profileKey);
  const urls = [...new Set(authUrlsForBrowserProfile(profile).filter(Boolean))];
  if (!profile || !urls.length) {
    toast("该站点没有可打开的授权地址");
    return;
  }
  let opened = 0;
  for (const url of urls) {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (win) opened += 1;
  }
  if (!opened) {
    toast("浏览器拦截了授权页面，请允许此站点打开弹窗后重试");
    return;
  }
  $("browserAuthStatus").textContent = `已打开 ${profile.label || profile.domain || profile.key} 授权页面 ${opened} / ${urls.length} 个；登录完成后授权助手扩展会自动记录 Cookie`;
  if (opened < urls.length) toast("浏览器拦截了部分授权页面，请允许弹窗后重试");
}

function formatDateTime(value = "") {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function cookieExpiryState(cookies = []) {
  const nowSeconds = Date.now() / 1000;
  const rows = Array.isArray(cookies) ? cookies : [];
  let validCookieCount = 0;
  let expiredCookieCount = 0;
  let sessionCookieCount = 0;
  let persistentCookieCount = 0;
  let expiringSoonCookieCount = 0;
  let nearestExpires = Infinity;
  for (const cookie of rows) {
    const expires = Number(cookie?.expires);
    if (!Number.isFinite(expires) || expires <= 0) {
      sessionCookieCount += 1;
      validCookieCount += 1;
      continue;
    }
    if (expires <= nowSeconds) {
      expiredCookieCount += 1;
      continue;
    }
    persistentCookieCount += 1;
    validCookieCount += 1;
    nearestExpires = Math.min(nearestExpires, expires);
    if (expires <= nowSeconds + 7 * 24 * 60 * 60) expiringSoonCookieCount += 1;
  }
  return {
    cookieCount: rows.length,
    validCookieCount,
    expiredCookieCount,
    sessionCookieCount,
    persistentCookieCount,
    expiringSoonCookieCount,
    nearestExpiresAt: Number.isFinite(nearestExpires) ? new Date(nearestExpires * 1000).toISOString() : "",
    authStatus: validCookieCount > 0 ? "authorized" : rows.length > 0 ? "expired" : "missing",
    authHealth: validCookieCount > 0 ? (expiredCookieCount > 0 ? "degraded" : expiringSoonCookieCount > 0 ? "watch" : "healthy") : rows.length > 0 ? "expired" : "missing",
    authorizationNeedsRefresh: rows.length === 0 || validCookieCount === 0 || expiredCookieCount > 0 || expiringSoonCookieCount > 0,
    recommendedAction: rows.length === 0
      ? "authorize-profile"
      : validCookieCount === 0
        ? "reauthorize-profile"
        : expiredCookieCount > 0
          ? "refresh-profile-cookies"
          : expiringSoonCookieCount > 0
            ? "refresh-before-expiry"
            : "keep",
    statusReasons: [],
  };
}

function profileCookieState(profile = {}) {
  const local = cookieExpiryState(profile.cookies || []);
  return {
    ...local,
    cookieCount: Number(profile.cookieCount ?? local.cookieCount) || 0,
    validCookieCount: Number(profile.validCookieCount ?? local.validCookieCount) || 0,
    expiredCookieCount: Number(profile.expiredCookieCount ?? local.expiredCookieCount) || 0,
    sessionCookieCount: Number(profile.sessionCookieCount ?? local.sessionCookieCount) || 0,
    persistentCookieCount: Number(profile.persistentCookieCount ?? local.persistentCookieCount) || 0,
    expiringSoonCookieCount: Number(profile.expiringSoonCookieCount ?? local.expiringSoonCookieCount) || 0,
    nearestExpiresAt: profile.nearestExpiresAt || local.nearestExpiresAt,
    authStatus: profile.authStatus || local.authStatus,
    authHealth: profile.authHealth || local.authHealth,
    authorizationNeedsRefresh: Boolean(profile.authorizationNeedsRefresh ?? local.authorizationNeedsRefresh),
    recommendedAction: profile.recommendedAction || local.recommendedAction,
    statusReasons: Array.isArray(profile.statusReasons) ? profile.statusReasons : local.statusReasons,
    lastAuthorizedAgeDays: profile.lastAuthorizedAgeDays ?? null,
  };
}

function updateBrowserAuthStatus(browser = {}) {
  const profiles = Array.isArray(browser.profiles) ? browser.profiles : [];
  const profileStates = profiles.map(profile => ({ profile, state: profileCookieState(profile) }));
  const authorizedProfiles = profileStates.filter(item => item.state.validCookieCount > 0);
  const expiredProfiles = profileStates.filter(item => item.state.cookieCount > 0 && item.state.validCookieCount === 0);
  const partialExpiredProfiles = profileStates.filter(item => item.state.validCookieCount > 0 && item.state.expiredCookieCount > 0);
  const refreshProfiles = profileStates.filter(item => item.state.validCookieCount > 0 && item.state.authorizationNeedsRefresh);
  const cookieCount = authorizedProfiles.reduce((sum, item) => sum + item.state.validCookieCount, 0);
  const latestAuthorizedAt = authorizedProfiles
    .map(item => item.profile.lastAuthorizedAt || item.profile.last_authorized_at || "")
    .filter(Boolean)
    .sort()
    .pop();
  if (!cookieCount) {
    $("browserAuthStatus").textContent = expiredProfiles.length ? `授权已过期：${expiredProfiles.length} 个站点需要重新授权` : "未开始授权";
    return { authorizedCount: 0, cookieCount, latestAuthorizedAt: "", expiredCount: expiredProfiles.length, partialExpiredCount: 0 };
  }
  const latestText = latestAuthorizedAt ? ` · 最近授权 ${formatDateTime(latestAuthorizedAt)}` : "";
  const warningText = expiredProfiles.length || partialExpiredProfiles.length
    ? ` · ${expiredProfiles.length} 个站点过期，${partialExpiredProfiles.length} 个站点有过期 Cookie`
    : refreshProfiles.length
      ? ` · ${refreshProfiles.length} 个站点建议刷新`
    : "";
  $("browserAuthStatus").textContent = `已授权 ${authorizedProfiles.length} / ${profiles.length} 个站点 · 有效 Cookie ${cookieCount}${latestText}${warningText}`;
  return {
    authorizedCount: authorizedProfiles.length,
    cookieCount,
    latestAuthorizedAt,
    expiredCount: expiredProfiles.length,
    partialExpiredCount: partialExpiredProfiles.length,
    refreshCount: refreshProfiles.length,
  };
}

function renderBrowserProfiles(browser = {}) {
  const profiles = Array.isArray(browser.profiles) ? browser.profiles : [];
  $("browserProfileList").innerHTML = profiles.map(profile => {
    const state = profileCookieState(profile);
    const authorized = state.validCookieCount > 0;
    const expired = state.cookieCount > 0 && !authorized;
    const authorizedAt = profile.lastAuthorizedAt || profile.last_authorized_at || "";
    const statusClass = authorized ? (state.authorizationNeedsRefresh ? "warn" : "good") : "bad";
    const statusText = authorized
      ? state.authHealth === "degraded"
        ? `需刷新 · 有效 ${state.validCookieCount} · 过期 ${state.expiredCookieCount}`
        : state.recommendedAction === "refresh-before-expiry"
          ? `即将过期 · 有效 ${state.validCookieCount} · 7天内过期 ${state.expiringSoonCookieCount}`
          : state.recommendedAction === "reauthorize-session-profile"
            ? `会话可能过期 · 有效 ${state.validCookieCount}`
            : `已授权 · 有效 Cookie ${state.validCookieCount}`
      : expired
        ? `授权过期 · 过期 Cookie ${state.expiredCookieCount || state.cookieCount}`
        : "未授权";
    const expiresText = state.nearestExpiresAt ? `<span class="auth-profile-time">最近过期 ${escapeHtml(formatDateTime(state.nearestExpiresAt))}</span>` : "";
    const timeText = authorizedAt ? `<span class="auth-profile-time">最近授权 ${escapeHtml(formatDateTime(authorizedAt))}</span>` : "";
    return `
      <div class="auth-profile-row">
        <div class="auth-profile-main">
          <strong>${escapeHtml(profile.label || profile.key || profile.domain || "授权站点")}</strong>
          <small>${escapeHtml(profile.domain || profile.platform || profile.sourceKey || "-")}</small>
        </div>
        <span class="status-pill ${statusClass}">${escapeHtml(statusText)}</span>
        ${expiresText}
        ${timeText}
        <button class="secondary auth-profile-action" type="button" data-auth-profile="${escapeHtml(profile.key || "")}">单独授权</button>
      </div>
    `;
  }).join("") || `<div class="auth-profile-empty">暂无授权站点配置</div>`;
  document.querySelectorAll("[data-auth-profile]").forEach(button => {
    button.addEventListener("click", () => openSingleBrowserAuthorization(button.dataset.authProfile).catch(error => toast(error.message)));
  });
}

async function loadAll() {
  setStatus("正在加载配置...");
  state.configLoaded = false;
  $("openBrowserAuthBtn").disabled = true;
  const [ai, openSearch, admin, sourcePayload, searchPayload, rssPackCatalogPayload, rssPackCoverage, taiwanMediaHealth, taiwanPublicInterestHealth, taiwanNativeDiscoveryPlan, taiwanNativeDiscoveryRecovery, continuousCollectionPlan, freeTargetCoverage, freeTargetCoverageEffectiveness, followupPlan, followupRecovery, sourceFamilyRefreshRecovery, nativePromotionEffectiveness, nativePromotionRefresh, nativePromotionRefreshRecovery, nativePromotionGovernance] = await Promise.all([
    api("/api/sentiment/ai-settings?reveal=1"),
    api("/api/sentiment/opensearch-settings?reveal=1"),
    api("/api/admin-settings"),
    api("/api/sentiment/sources"),
    api("/api/sentiment/search-settings"),
    api("/api/sentiment/rss-feed-packs"),
    api("/api/sentiment/rss-feed-pack-coverage?days=30&limit=100"),
    api(taiwanMediaHealthUrl()),
    api(taiwanPublicInterestHealthUrl()),
    api(taiwanNativeDiscoveryPlanUrl()),
    api(taiwanNativeDiscoveryRecoveryUrl()),
    api(continuousCollectionPlanUrl()),
    api(freeTargetCoverageUrl()),
    api(freeTargetCoverageEffectivenessUrl()),
    api(followupPlanUrl()),
    api(followupRecoveryUrl()),
    api(sourceFamilyRefreshRecoveryUrl()),
    api(nativePromotionEffectivenessUrl()),
    api(nativePromotionRefreshUrl()),
    api(nativePromotionRefreshRecoveryUrl()),
    api(nativePromotionGovernanceUrl()),
  ]);

  const aiSettings = ai.settings || {};
  $("aiEnabled").value = aiSettings.enabled ? "true" : "false";
  $("aiBaseUrl").value = aiSettings.baseUrl || "";
  $("aiModel").value = aiSettings.model || "";
  $("aiTimeoutMs").value = aiSettings.timeoutMs || 20000;
  $("aiApiKey").value = aiSettings.apiKey || "";
  $("aiApiKey").placeholder = aiSettings.apiKey ? "" : "请输入 API Key";
  $("aiConfigured").textContent = aiSettings.configured ? "已配置" : "未完整配置";
  $("aiConfigured").className = `status-pill ${aiSettings.configured ? "good" : "bad"}`;

  const openSearchSettings = openSearch.settings || {};
  state.openSearchSettings = openSearchSettings;
  $("openSearchEnabled").value = openSearchSettings.enabled ? "true" : "false";
  $("openSearchAccessMode").value = openSearchSettings.accessMode || "direct";
  $("openSearchEndpoint").value = openSearchSettings.endpoint || "";
  $("openSearchIndexName").value = openSearchSettings.indexName || "sentiment_high_value_evidence";
  $("openSearchUsername").value = openSearchSettings.username || "";
  $("openSearchPassword").value = openSearchSettings.password || "";
  $("openSearchApiKey").value = openSearchSettings.apiKey || "";
  $("openSearchTimeoutMs").value = openSearchSettings.timeoutMs || 15000;
  $("openSearchMinArchiveScore").value = openSearchSettings.minArchiveScore ?? 70;
  $("openSearchMaxSyncItems").value = openSearchSettings.maxSyncItems || 1000;
  const openSearchMaintenance = openSearchSettings.maintenance || {};
  $("openSearchMaintenanceEnabled").value = openSearchMaintenance.enabled === false ? "false" : "true";
  $("openSearchRetentionDays").value = openSearchMaintenance.retentionDays || 365;
  $("openSearchNoiseRetentionDays").value = openSearchMaintenance.noiseRetentionDays || 45;
  $("openSearchDuplicateLookbackDays").value = openSearchMaintenance.duplicateLookbackDays || 180;
  $("openSearchMinKeepScore").value = openSearchMaintenance.minKeepScore ?? 70;
  $("openSearchMaxDeletePerRun").value = openSearchMaintenance.maxDeletePerRun || 1000;
  $("openSearchConfigured").textContent = openSearchSettings.configured ? "已配置" : "未完整配置";
  $("openSearchConfigured").className = `status-pill ${openSearchSettings.enabled && openSearchSettings.configured ? "good" : openSearchSettings.configured ? "warn" : "bad"}`;

  $("scanDays").value = admin.settings?.scanDays || 30;
  $("reportDays").value = admin.settings?.reportDays || 30;
  state.searchSettings = searchPayload.settings || {};
  const browser = state.searchSettings.browserFallback || {};
  $("browserEnabled").value = browser.enabled === false ? "false" : "true";
  $("browserMaxKeywords").value = browser.maxKeywords || 4;
  $("browserCapturePages").value = browser.captureResultPages === false ? "false" : "true";
  $("browserMaxItems").value = browser.maxItemsPerKeyword || 8;
  $("browserMaxDetailPages").value = browser.maxDetailPagesPerKeyword ?? 3;
  $("browserTimeoutMs").value = browser.timeoutMs || 25000;
  $("browserWaitMs").value = browser.waitMs || 1800;
  renderBrowserProfiles(browser);
  const authSummary = updateBrowserAuthStatus(browser);
  const cookieCount = authSummary.cookieCount;
  $("browserConfigured").textContent = browser.enabled === false ? "已停用" : `已启用 · 有效 Cookie ${cookieCount}`;
  $("browserConfigured").className = `status-pill ${browser.enabled === false || authSummary.expiredCount ? "bad" : authSummary.partialExpiredCount ? "warn" : "good"}`;
  if (authSummary.expiredCount) toast(`有 ${authSummary.expiredCount} 个授权站点 Cookie 已过期，请重新授权`);
  else if (authSummary.partialExpiredCount) toast(`有 ${authSummary.partialExpiredCount} 个授权站点存在过期 Cookie，建议重新授权刷新`);

  state.sources = (sourcePayload.sources || []).sort((a, b) => Number(b.enabled || 0) - Number(a.enabled || 0) || Number(b.priority || 0) - Number(a.priority || 0));
  const availableKeys = sourceKeys();
  const scopes = admin.settings?.sourceScopes || {};
  state.modeSources = {
    fast: normalizeModeSourceSet("fast", scopes.fast, availableKeys),
    full: normalizeModeSourceSet("full", scopes.full, availableKeys),
    watch: normalizeModeSourceSet("watch", scopes.watch, availableKeys),
  };
  state.rssPackCatalog = Array.isArray(rssPackCatalogPayload.packs) ? rssPackCatalogPayload.packs : [];
  const rssPackKeys = state.rssPackCatalog.map(pack => pack.key).filter(Boolean);
  const rssFeedPacks = state.searchSettings.rssFeedPacks || {};
  state.modeRssPacks = {
    fast: normalizeModeRssPackSet("fast", rssFeedPacks.fast, rssPackKeys),
    full: normalizeModeRssPackSet("full", rssFeedPacks.full, rssPackKeys),
    watch: normalizeModeRssPackSet("watch", rssFeedPacks.watch, rssPackKeys),
  };
  renderSources();
  renderRssPackConfig();
  renderRssPackCoverage(rssPackCoverage);
  renderTaiwanMediaHealth(taiwanMediaHealth);
  renderTaiwanPublicInterestHealth(taiwanPublicInterestHealth);
  renderTaiwanNativeDiscoveryPlan(taiwanNativeDiscoveryPlan);
  renderTaiwanNativeDiscoveryRecovery(taiwanNativeDiscoveryRecovery);
  renderContinuousCollectionPlan(continuousCollectionPlan);
  renderFreeTargetCoverage(freeTargetCoverage);
  renderFreeTargetCoverageEffectiveness(freeTargetCoverageEffectiveness);
  renderRssFollowupPlan(followupPlan);
  renderRssFollowupRecovery(followupRecovery);
  renderRssSourceFamilyRefreshRecovery(sourceFamilyRefreshRecovery);
  renderNativePromotionEffectiveness(nativePromotionEffectiveness);
  renderNativePromotionRefreshPlan(nativePromotionRefresh);
  renderNativePromotionRefreshRecovery(nativePromotionRefreshRecovery);
  renderNativePromotionGovernance(nativePromotionGovernance);
  state.configLoaded = true;
  $("openBrowserAuthBtn").disabled = false;
  setStatus("配置已加载");
}

async function saveAi(event) {
  event.preventDefault();
  const payload = {
    enabled: $("aiEnabled").value === "true",
    baseUrl: $("aiBaseUrl").value.trim(),
    model: $("aiModel").value.trim(),
    temperature: 0.2,
    timeoutMs: Number($("aiTimeoutMs").value || 20000),
  };
  const apiKey = $("aiApiKey").value.trim();
  if (apiKey) payload.apiKey = apiKey;
  const result = await api("/api/sentiment/ai-settings", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  await loadAll();
  $("aiConfigured").textContent = result.settings?.configured ? "已配置" : "未完整配置";
  $("aiConfigured").className = `status-pill ${result.settings?.configured ? "good" : "bad"}`;
  toast("AI 配置已保存");
}

async function clearAiKey() {
  const payload = {
    enabled: $("aiEnabled").value === "true",
    baseUrl: $("aiBaseUrl").value.trim(),
    model: $("aiModel").value.trim(),
    temperature: 0.2,
    clearApiKey: true,
  };
  await api("/api/sentiment/ai-settings", { method: "PUT", body: JSON.stringify(payload) });
  await loadAll();
  toast("AI 密钥已清除");
}

function openSearchPayload() {
  const payload = {
    enabled: $("openSearchEnabled").value === "true",
    accessMode: $("openSearchAccessMode").value,
    endpoint: $("openSearchEndpoint").value.trim(),
    indexName: $("openSearchIndexName").value.trim() || "sentiment_high_value_evidence",
    username: $("openSearchUsername").value.trim(),
    timeoutMs: Number($("openSearchTimeoutMs").value || 15000),
    minArchiveScore: Number($("openSearchMinArchiveScore").value || 70),
    maxSyncItems: Number($("openSearchMaxSyncItems").value || 1000),
    storeNoiseAggregates: true,
    maintenance: {
      enabled: $("openSearchMaintenanceEnabled").value !== "false",
      retentionDays: Number($("openSearchRetentionDays").value || 365),
      noiseRetentionDays: Number($("openSearchNoiseRetentionDays").value || 45),
      duplicateLookbackDays: Number($("openSearchDuplicateLookbackDays").value || 180),
      minKeepScore: Number($("openSearchMinKeepScore").value || 70),
      duplicateKeepScore: 90,
      maxScanDocs: 5000,
      maxDeletePerRun: Number($("openSearchMaxDeletePerRun").value || 1000),
    },
  };
  const password = $("openSearchPassword").value.trim();
  const apiKey = $("openSearchApiKey").value.trim();
  if (password) payload.password = password;
  if (apiKey) payload.apiKey = apiKey;
  return payload;
}

function renderOpenSearchStatus(payload = {}) {
  const target = $("openSearchStatus");
  if (!target) return;
  if (payload.dry_run) {
    if (payload.estimated_delete_count !== undefined) {
      target.textContent = `维护预览：预计清理 ${Number(payload.estimated_delete_count || 0)} 条 · 过期低价值 ${Number(payload.expired_low_value_count || 0)} · 低分噪音 ${Number(payload.noise_low_score_count || 0)} · 重复 ${Number(payload.duplicate_delete_count || 0)} · 扫描 ${Number(payload.duplicate_scanned_count || 0)} 条`;
      return;
    }
    const rejected = Array.isArray(payload.rejected_family_counts)
      ? payload.rejected_family_counts.slice(0, 6).map(row => `${row.family}:${row.count}`).join("，")
      : "-";
    target.textContent = `预览：候选 ${Number(payload.candidate_count || 0)} · 高价值入库 ${Number(payload.selected_count || 0)} · 噪音/低价值 ${Number(payload.rejected_count || 0)} · 阈值 ${Number(payload.min_archive_score || 0)} · 主要未入库来源 ${rejected || "-"}`;
    return;
  }
  if (payload.cluster_name || payload.status) {
    target.textContent = `连接状态：${payload.status || "-"} · 集群 ${payload.cluster_name || "-"} · 版本 ${payload.version || "-"} · 节点 ${Number(payload.number_of_nodes || 0)} · 索引 ${payload.index_exists ? "已存在" : "未创建"} · 已入库 ${Number(payload.indexed_count || 0)}`;
    return;
  }
  if (payload.synced_count !== undefined) {
    target.textContent = `同步完成：入库 ${Number(payload.synced_count || 0)} · 失败 ${Number(payload.failed_count || 0)} · 候选 ${Number(payload.candidate_count || 0)} · 选中 ${Number(payload.selected_count || 0)}`;
    return;
  }
  if (payload.deleted_count !== undefined) {
    target.textContent = `维护完成：删除 ${Number(payload.deleted_count || 0)} 条 · 重复 ${Number(payload.duplicate_deleted_count || 0)} · 过期 ${Number(payload.expired_deleted_count || 0)} · 噪音 ${Number(payload.noise_deleted_count || 0)} · 状态 ${payload.status || "-"}`;
    return;
  }
  target.textContent = payload.error ? `OpenSearch 错误：${payload.error}` : "尚未检测 OpenSearch。";
}

async function saveOpenSearch(event) {
  event.preventDefault();
  const result = await api("/api/sentiment/opensearch-settings", {
    method: "PUT",
    body: JSON.stringify(openSearchPayload()),
  });
  state.openSearchSettings = result.settings || {};
  await loadAll();
  toast("OpenSearch 配置已保存");
}

async function testOpenSearch() {
  await api("/api/sentiment/opensearch-settings", {
    method: "PUT",
    body: JSON.stringify(openSearchPayload()),
  });
  const health = await api("/api/sentiment/opensearch-health");
  renderOpenSearchStatus(health);
  $("openSearchConfigured").textContent = health.ok ? "连接正常" : health.status || "连接失败";
  $("openSearchConfigured").className = `status-pill ${health.ok ? "good" : "bad"}`;
  toast(health.ok ? "OpenSearch 连接正常" : "OpenSearch 连接失败");
}

async function previewOpenSearchSync() {
  await api("/api/sentiment/opensearch-settings", {
    method: "PUT",
    body: JSON.stringify(openSearchPayload()),
  });
  const payload = await api("/api/sentiment/opensearch-sync", {
    method: "POST",
    body: JSON.stringify({ dryRun: true, limit: Number($("openSearchMaxSyncItems").value || 1000) }),
  });
  renderOpenSearchStatus(payload);
  toast(`预览完成：高价值 ${Number(payload.selected_count || 0)} 条`);
}

async function runOpenSearchSync() {
  await api("/api/sentiment/opensearch-settings", {
    method: "PUT",
    body: JSON.stringify(openSearchPayload()),
  });
  const payload = await api("/api/sentiment/opensearch-sync", {
    method: "POST",
    body: JSON.stringify({ dryRun: false, limit: Number($("openSearchMaxSyncItems").value || 1000) }),
  });
  renderOpenSearchStatus(payload);
  toast(`OpenSearch 同步完成：${Number(payload.synced_count || 0)} 条`);
}

async function previewOpenSearchMaintenance() {
  await api("/api/sentiment/opensearch-settings", {
    method: "PUT",
    body: JSON.stringify(openSearchPayload()),
  });
  const payload = await api("/api/sentiment/opensearch-maintenance", {
    method: "POST",
    body: JSON.stringify({ dryRun: true }),
  });
  renderOpenSearchStatus(payload);
  toast(`维护预览完成：预计清理 ${Number(payload.estimated_delete_count || 0)} 条`);
}

async function runOpenSearchMaintenance() {
  await api("/api/sentiment/opensearch-settings", {
    method: "PUT",
    body: JSON.stringify(openSearchPayload()),
  });
  const payload = await api("/api/sentiment/opensearch-maintenance", {
    method: "POST",
    body: JSON.stringify({ dryRun: false }),
  });
  renderOpenSearchStatus(payload);
  toast(`OpenSearch 维护完成：删除 ${Number(payload.deleted_count || 0)} 条`);
}

async function saveWindow(event) {
  event.preventDefault();
  await api("/api/admin-settings", {
    method: "PUT",
    body: JSON.stringify({
      scanDays: Number($("scanDays").value || 30),
      reportDays: Number($("reportDays").value || 30),
      sourceScopes: serializeSourceScopes(),
    }),
  });
  toast("日期设置已保存");
}

async function saveBrowser(event) {
  event.preventDefault();
  const current = state.searchSettings || {};
  const payload = {
    ...current,
    browserFallback: {
      ...(current.browserFallback || {}),
      enabled: $("browserEnabled").value === "true",
      maxKeywords: Number($("browserMaxKeywords").value || 4),
      captureResultPages: $("browserCapturePages").value === "true",
      maxItemsPerKeyword: Number($("browserMaxItems").value || 8),
      maxDetailPagesPerKeyword: Number($("browserMaxDetailPages").value || 3),
      timeoutMs: Number($("browserTimeoutMs").value || 25000),
      waitMs: Number($("browserWaitMs").value || 1800),
      profiles: current.browserFallback?.profiles || [],
    },
  };
  const result = await api("/api/sentiment/search-settings", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  state.searchSettings = result.settings || payload;
  await loadAll();
  toast("浏览器采集配置已保存");
}

function serializeSourceScopes() {
  return {
    fast: [...state.modeSources.fast],
    full: [...state.modeSources.full],
    watch: [...state.modeSources.watch],
  };
}

function serializeRssFeedPacks() {
  return {
    fast: [...state.modeRssPacks.fast],
    full: [...state.modeRssPacks.full],
    watch: [...state.modeRssPacks.watch],
  };
}

async function saveSources() {
  const emptyMode = Object.keys(SOURCE_MODE_LABELS).find(mode => !state.modeSources[mode]?.size);
  if (emptyMode) {
    toast(`${SOURCE_MODE_LABELS[emptyMode]}至少保留一个扫描来源`);
    return;
  }
  await api("/api/admin-settings", {
    method: "PUT",
    body: JSON.stringify({
      scanDays: Number($("scanDays").value || 30),
      reportDays: Number($("reportDays").value || 30),
      sourceScopes: serializeSourceScopes(),
    }),
  });
  await loadAll();
  toast("扫描网站范围已保存");
}

async function saveRssPacks() {
  const emptyMode = Object.keys(SOURCE_MODE_LABELS).find(mode => !state.modeRssPacks[mode]?.size);
  if (emptyMode) {
    toast(`${SOURCE_MODE_LABELS[emptyMode]}至少保留一个 RSS 媒体包`);
    return;
  }
  const current = state.searchSettings || {};
  const result = await api("/api/sentiment/search-settings", {
    method: "PUT",
    body: JSON.stringify({
      ...current,
      rssFeedPacks: serializeRssFeedPacks(),
    }),
  });
  state.searchSettings = result.settings || current;
  await loadAll();
  toast("RSS 媒体包范围已保存");
}

async function applyRssModeRecommendations() {
  const result = await api("/api/sentiment/rss-feed-pack-coverage/apply-recommendations", {
    method: "POST",
    body: JSON.stringify({ apply: true, days: 30, limit: 100 }),
  });
  if (!result.applied_count) {
    toast("暂无可自动应用的 RSS 覆盖建议");
    return;
  }
  await loadAll();
  const delta = result.coverage_delta || {};
  const addedPacks = Number(delta.added_pack_count || 0);
  const priorityDelta = Number(delta.priority_site_delta || 0);
  toast(`已应用 ${Number(result.applied_count || 0)} 条 RSS 覆盖建议 · 新增媒体包 ${addedPacks} · 重点站点 ${priorityDelta >= 0 ? "+" : ""}${priorityDelta}`);
}

$("aiForm").addEventListener("submit", (event) => saveAi(event).catch(error => toast(error.message)));
$("openSearchForm").addEventListener("submit", (event) => saveOpenSearch(event).catch(error => toast(error.message)));
$("windowForm").addEventListener("submit", (event) => saveWindow(event).catch(error => toast(error.message)));
$("browserForm").addEventListener("submit", (event) => saveBrowser(event).catch(error => toast(error.message)));
$("openBrowserAuthBtn").addEventListener("click", () => openBrowserAuthorizationPages().catch(error => toast(error.message)));
$("clearAiKeyBtn").addEventListener("click", () => clearAiKey().catch(error => toast(error.message)));
$("testOpenSearchBtn").addEventListener("click", () => testOpenSearch().catch(error => toast(error.message)));
$("previewOpenSearchSyncBtn").addEventListener("click", () => previewOpenSearchSync().catch(error => toast(error.message)));
$("runOpenSearchSyncBtn").addEventListener("click", () => runOpenSearchSync().catch(error => toast(error.message)));
$("previewOpenSearchMaintenanceBtn").addEventListener("click", () => previewOpenSearchMaintenance().catch(error => toast(error.message)));
$("runOpenSearchMaintenanceBtn").addEventListener("click", () => runOpenSearchMaintenance().catch(error => toast(error.message)));
$("saveSourcesBtn").addEventListener("click", () => saveSources().catch(error => toast(error.message)));
$("saveRssPacksBtn").addEventListener("click", () => saveRssPacks().catch(error => toast(error.message)));
$("applyRssModeRecommendationsBtn").addEventListener("click", () => applyRssModeRecommendations().catch(error => toast(error.message)));
$("reloadContinuousCollectionBtn").addEventListener("click", () => loadContinuousCollectionPlan().then(() => toast("连续采集计划已刷新")).catch(error => toast(error.message)));
$("runContinuousCollectionBtn").addEventListener("click", () => runContinuousCollection().catch(error => toast(error.message)));
$("reloadFreeTargetCoverageBtn").addEventListener("click", () => loadFreeTargetCoverage().then(() => toast("免费来源目标覆盖已刷新")).catch(error => toast(error.message)));
$("enqueueFreeTargetCoverageBtn").addEventListener("click", () => enqueueFreeTargetCoverageFollowups().catch(error => toast(error.message)));
$("reloadFollowupPlanBtn").addEventListener("click", () => loadRssFollowupPlan().then(() => toast("补采任务预览已刷新")).catch(error => toast(error.message)));
$("enqueueFollowupPlanBtn").addEventListener("click", () => enqueueRssFollowupPlan().catch(error => toast(error.message)));
$("enqueueTaiwanNativeDiscoveryBtn").addEventListener("click", () => enqueueTaiwanNativeDiscovery().catch(error => toast(error.message)));
$("reloadNativePromotionRefreshBtn").addEventListener("click", () => loadNativePromotionRefreshPlan().then(() => toast("晋升入口刷新预览已更新")).catch(error => toast(error.message)));
$("enqueueNativePromotionRefreshBtn").addEventListener("click", () => enqueueNativePromotionRefreshPlan().catch(error => toast(error.message)));
$("applyNativePromotionGovernanceBtn").addEventListener("click", () => applyNativePromotionGovernance().catch(error => toast(error.message)));
$("reloadBtn").addEventListener("click", () => loadAll().catch(error => {
  setStatus("配置加载失败");
  toast(error.message);
}));
$("sourceFilter").addEventListener("input", () => {
  state.sourceFilter = $("sourceFilter").value;
  renderSources();
});
$("sourceModeSelect").addEventListener("change", () => {
  state.activeSourceMode = $("sourceModeSelect").value;
  renderSources();
});
$("rssPackModeSelect").addEventListener("change", () => {
  state.activeRssPackMode = $("rssPackModeSelect").value;
  renderRssPackConfig();
});
$("selectAllBtn").addEventListener("click", () => {
  const selected = currentModeSources();
  state.sources.forEach(source => selected.add(source.source_key));
  renderSources();
});
$("selectNoneBtn").addEventListener("click", () => {
  currentModeSources().clear();
  renderSources();
});
$("rssPackSelectAllBtn").addEventListener("click", () => {
  const selected = currentModeRssPacks();
  state.rssPackCatalog.forEach(pack => selected.add(pack.key));
  renderRssPackConfig();
});
$("rssPackSelectNoneBtn").addEventListener("click", () => {
  currentModeRssPacks().clear();
  renderRssPackConfig();
});

state.loadPromise = loadAll().finally(() => {
  state.loadPromise = null;
}).catch(error => {
  setStatus("后端连接失败");
  toast(error.message);
});
