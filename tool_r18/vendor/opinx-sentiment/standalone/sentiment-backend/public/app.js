const state = {
  keyword: "",
  filter: "all",
  dashboard: null,
  adminSettings: {
    scanDays: 30,
    reportDays: 30,
  },
  sourceScopes: {
    fast: [],
    full: [],
    watch: [],
  },
  availableSourceKeys: [],
  report: "",
  evidence: [],
  reports: [],
  selectedReportId: "",
  progress: {
    visible: false,
    active: false,
    phase: "idle",
    title: "准备扫描",
    messageCount: 0,
    scannedSources: 0,
    totalSources: 0,
    failedSources: 0,
    startedAtMs: 0,
    batchId: null,
    mode: "",
    plannedSources: [],
    timer: null,
  },
};

const $ = (id) => document.getElementById(id);
const REPORT_STORAGE_KEY = "opinx.sentiment.reportRecords.v1";
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
const SCAN_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const SCAN_POLL_INTERVAL_MS = 1800;

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败：${res.status}`);
  }
  return data;
}

function escapeHtml(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function riskLabel(item = {}) {
  const risk = String(item.risk_level || item.risk || item.severity || "").toLowerCase();
  if (risk) return risk;
  if (String(item.sentiment || "").toLowerCase() === "negative") return "medium";
  return "low";
}

function sentimentClass(value = "") {
  const normalized = String(value || "neutral").toLowerCase();
  if (normalized.includes("negative")) return "negative";
  if (normalized.includes("positive")) return "positive";
  return "warning";
}

function markdownToHtml(markdown = "") {
  const lines = String(markdown || "").split(/\r?\n/);
  const html = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      continue;
    }
    if (line.startsWith("### ")) {
      if (inList) html.push("</ul>");
      inList = false;
      html.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
    } else if (line.startsWith("## ")) {
      if (inList) html.push("</ul>");
      inList = false;
      html.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    } else if (line.startsWith("# ")) {
      if (inList) html.push("</ul>");
      inList = false;
      html.push(`<h2>${escapeHtml(line.slice(2))}</h2>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${escapeHtml(line.replace(/^[-*]\s+/, ""))}</li>`);
    } else {
      if (inList) html.push("</ul>");
      inList = false;
      html.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  if (inList) html.push("</ul>");
  return html.join("");
}

function getItems() {
  return selectedReport()?.items || state.dashboard?.items || [];
}

function loadReportRecords() {
  try {
    const parsed = JSON.parse(localStorage.getItem(REPORT_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
  } catch {
    return [];
  }
}

function saveReportRecords() {
  localStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(state.reports.slice(0, 50)));
}

function selectedReport() {
  return state.reports.find(item => item.id === state.selectedReportId) || null;
}

function reportStatsFromDashboard(dashboard = {}, evidence = []) {
  const items = Array.isArray(dashboard.items) ? dashboard.items : [];
  const rows = evidence.length ? evidence : items;
  const sources = new Set(rows.map(item => item.platform || item.source_key || item.source || "").filter(Boolean));
  const negative = rows.filter(item => String(item.sentiment || "").toLowerCase().includes("negative")).length;
  const highRisk = rows.filter(item => ["high", "critical"].includes(riskLabel(item))).length;
  return {
    total: dashboard.stats?.total ?? rows.length,
    negative,
    highRisk,
    sourceCount: sources.size,
  };
}

function reportSummary(keyword = "", stats = {}) {
  if (!keyword) return "未指定关键词的系统报告。";
  return `围绕“${keyword}”匹配 ${stats.total || 0} 条舆情，负面 ${stats.negative || 0} 条，高危 ${stats.highRisk || 0} 条，有结果来源 ${stats.sourceCount || 0} 个。`;
}

function parseKeywordInput(value = "") {
  return [...new Set(String(value || "")
    .split(/[\n,，;；、]+/)
    .map(item => item.trim())
    .filter(Boolean))]
    .slice(0, 20);
}

function keywordDisplayText(keywords = []) {
  return keywords.join(", ");
}

function searchKeywordsFromInput() {
  return parseKeywordInput($("keywordInput").value);
}

function setKeywordInputFromList(keywords = []) {
  $("keywordInput").value = keywordDisplayText(keywords);
}

function addKeywordToInput(keyword = "") {
  const value = String(keyword || "").trim();
  if (!value) return [];
  const keywords = [...new Set([...searchKeywordsFromInput(), value])].slice(0, 20);
  setKeywordInputFromList(keywords);
  return keywords;
}

function createReportRecord({ keyword = "", mode = "", dashboard = {}, markdown = "", evidence = [] } = {}) {
  const stats = reportStatsFromDashboard(dashboard, evidence);
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    keyword,
    mode,
    createdAt: new Date().toISOString(),
    summary: reportSummary(keyword, stats),
    markdown,
    stats,
    evidence,
    items: Array.isArray(dashboard.items) ? dashboard.items : [],
  };
}

function addReportRecord(record) {
  state.reports = [record, ...state.reports.filter(item => item.id !== record.id)].slice(0, 50);
  state.selectedReportId = "";
  saveReportRecords();
}

function scanSourcesForMode(mode = "fast") {
  const available = new Set(state.availableSourceKeys || []);
  const configured = Array.isArray(state.sourceScopes?.[mode])
    ? state.sourceScopes[mode].filter(source => !available.size || available.has(source))
    : [];
  if (configured.length) return configured;
  if (mode === "full") return state.availableSourceKeys.length ? state.availableSourceKeys : null;
  const defaults = mode === "watch" ? CRISIS_SCAN_SOURCES : QUICK_SCAN_SOURCES;
  const selected = available.size ? defaults.filter(source => available.has(source)) : defaults;
  return selected.length ? selected : defaults;
}

function scanProgressPercent() {
  if (state.progress.phase === "complete") return 100;
  const total = Number(state.progress.totalSources || 0);
  if (total > 0) return Math.max(0, Math.min(100, Math.round((state.progress.scannedSources / total) * 100)));
  if (state.progress.active) return 8;
  return 0;
}

function renderScanProgress() {
  const panel = $("scanProgress");
  panel.hidden = !state.progress.visible;
  if (!state.progress.visible) return;
  const percent = scanProgressPercent();
  $("progressTitle").textContent = state.progress.title || "扫描中";
  $("progressPercent").textContent = `${percent}%`;
  $("progressFill").style.width = `${percent}%`;
  $("progressMessages").textContent = state.progress.messageCount ?? 0;
  $("progressSources").textContent = state.progress.scannedSources ?? 0;
  $("progressTotalSources").textContent = state.progress.totalSources ?? 0;
  $("progressFailures").textContent = state.progress.failedSources ?? 0;
}

function setScanProgress(partial = {}) {
  state.progress = { ...state.progress, ...partial };
  renderScanProgress();
}

function stopScanProgressPolling() {
  if (state.progress.timer) window.clearTimeout(state.progress.timer);
  state.progress.timer = null;
}

function countSourceLogs(logs = []) {
  const latestBySource = new Map();
  for (const log of logs) {
    const key = log.source_key || log.sourceKey || "";
    if (!key || latestBySource.has(key)) continue;
    latestBySource.set(key, log);
  }
  const latest = [...latestBySource.values()];
  return {
    messageCount: latest.reduce((sum, log) => sum + (Number(log.count || 0) || 0), 0),
    scannedSources: latest.length,
    failedSources: latest.filter(log => ["failed", "partial", "cooldown", "throttled", "blocked"].includes(String(log.status || ""))).length,
  };
}

function normalizeProgressSourceList(values = []) {
  return Array.isArray(values)
    ? values.map(value => String(value || "").trim()).filter(Boolean).sort()
    : [];
}

function sourceListsMatch(a = [], b = []) {
  const left = normalizeProgressSourceList(a);
  const right = normalizeProgressSourceList(b);
  if (!left.length || !right.length) return true;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function findCurrentScanBatch(batches = []) {
  const startedAtMs = Number(state.progress.startedAtMs || 0);
  const mode = String(state.progress.mode || "").trim();
  const plannedSources = normalizeProgressSourceList(state.progress.plannedSources || []);
  const candidates = batches.filter(batch => {
    const batchStartedAt = Date.parse(batch.started_at || batch.startedAt || "");
    if (!Number.isFinite(batchStartedAt) || (startedAtMs && batchStartedAt < startedAtMs - 5000)) return false;
    const batchMode = String(batch.mode || "").trim();
    if (mode && batchMode && mode !== batchMode) return false;
    const batchSources = Array.isArray(batch.requested_sources) && batch.requested_sources.length
      ? batch.requested_sources
      : batch.sources;
    return sourceListsMatch(plannedSources, batchSources);
  });
  return candidates.find(batch => batch.status === "running") || candidates[0] || null;
}

async function refreshScanProgress() {
  const batchResponse = await api("/api/sentiment/scan-batches?limit=8");
  const batch = findCurrentScanBatch(batchResponse.batches || []);
  if (!batch) return null;
  const totalSources = Array.isArray(batch.sources) ? batch.sources.length : state.progress.totalSources;
  const logs = await api(`/api/sentiment/scan-source-logs?batch_id=${encodeURIComponent(batch.id)}&limit=300`);
  const counts = countSourceLogs(logs.logs || []);
  const isComplete = batch.status && batch.status !== "running";
  const messageCount = isComplete ? Number(batch.total || counts.messageCount || 0) : counts.messageCount;
  const scannedSources = isComplete ? (totalSources || counts.scannedSources) : counts.scannedSources;
  setScanProgress({
    batchId: batch.id,
    title: isComplete
      ? `扫描完成：采集 ${messageCount} 条消息，扫描 ${scannedSources} 个网站/来源`
      : totalSources
        ? `正在扫描 ${counts.scannedSources}/${totalSources} 个网站/来源`
        : "正在扫描公开网站/来源",
    totalSources: totalSources || state.progress.totalSources,
    messageCount,
    scannedSources,
    failedSources: Number(batch.failure_count || batch.failureCount || counts.failedSources || 0),
  });
  return batch;
}

async function pollScanProgress() {
  if (!state.progress.active) return;
  try {
    await refreshScanProgress();
  } catch {
    // Progress polling is best-effort; the completion waiter remains authoritative.
  } finally {
    if (state.progress.active) {
      state.progress.timer = window.setTimeout(pollScanProgress, SCAN_POLL_INTERVAL_MS);
    }
  }
}

function beginScanProgress(keyword, mode, plannedSources = null) {
  stopScanProgressPolling();
  setScanProgress({
    visible: true,
    active: true,
    phase: "scanning",
    title: `正在扫描“${keyword}”`,
    messageCount: 0,
    scannedSources: 0,
    totalSources: Array.isArray(plannedSources) ? plannedSources.length : mode === "full" ? 60 : 20,
    failedSources: 0,
    startedAtMs: Date.now(),
    batchId: null,
    mode,
    plannedSources: Array.isArray(plannedSources) ? plannedSources : [],
    timer: null,
  });
  pollScanProgress();
}

function finishScanProgressFromBatch(batch = null) {
  stopScanProgressPolling();
  const finalSources = (Array.isArray(batch?.sources) ? batch.sources.length : 0)
    || state.progress.totalSources
    || state.progress.scannedSources;
  const total = Number(batch?.total || state.progress.messageCount || 0);
  setScanProgress({
    visible: true,
    active: false,
    phase: "complete",
    title: `扫描完成：采集 ${total} 条消息，扫描 ${finalSources} 个网站/来源`,
    messageCount: total,
    scannedSources: finalSources,
    totalSources: finalSources || state.progress.totalSources || 0,
    failedSources: Number(batch?.failure_count || batch?.failureCount || state.progress.failedSources || 0),
  });
}

function finishScanProgressFromReport({ dashboard = {}, evidence = [], title = "报告已生成" } = {}) {
  stopScanProgressPolling();
  const stats = reportStatsFromDashboard(dashboard, evidence);
  const sourceCount = stats.sourceCount || state.progress.scannedSources || state.progress.totalSources || 0;
  setScanProgress({
    visible: true,
    active: false,
    phase: "complete",
    title: `${title}：匹配 ${stats.total || 0} 条舆情，有结果来源 ${sourceCount} 个`,
    messageCount: stats.total || 0,
    scannedSources: sourceCount,
    totalSources: sourceCount,
    failedSources: state.progress.failedSources || 0,
  });
}

async function waitForScanCompletion() {
  const deadline = Date.now() + SCAN_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const batch = await refreshScanProgress().catch(() => null);
    if (batch?.status && batch.status !== "running") return batch;
    await new Promise(resolve => window.setTimeout(resolve, SCAN_POLL_INTERVAL_MS));
  }
  throw new Error("扫描仍在后台运行，已超过页面等待时间，请稍后刷新报告。");
}

function failScanProgress(message = "扫描失败") {
  stopScanProgressPolling();
  setScanProgress({
    visible: true,
    active: false,
    phase: "failed",
    title: message,
  });
}

function getEvidenceRows() {
  const active = selectedReport();
  const rows = active ? (active.evidence.length ? active.evidence : active.items) : [];
  if (state.filter === "negative") {
    return rows.filter(item => String(item.sentiment || "").toLowerCase().includes("negative"));
  }
  if (state.filter === "high") {
    return rows.filter(item => ["high", "critical"].includes(riskLabel(item)));
  }
  return rows;
}

function renderStatus() {
  const dashboard = state.dashboard || {};
  const active = selectedReport();
  const stats = active?.stats || reportStatsFromDashboard(dashboard, state.evidence);
  $("totalCount").textContent = stats.total ?? 0;
  $("riskCount").textContent = Number(stats.negative || 0) + Number(stats.highRisk || 0);
  $("sourceCount").textContent = stats.sourceCount ?? 0;
  $("updatedAt").textContent = formatTime(new Date().toISOString());
}

function renderKeywords(keywords = []) {
  const wrap = $("keywordChips");
  const rows = Array.isArray(keywords) ? keywords.slice(0, 30) : [];
  wrap.innerHTML = rows.map(row => {
    const value = row.keyword || row;
    const id = row.id ?? "";
    return `
      <span class="keyword-chip">
        <button class="chip-select" type="button" data-keyword="${escapeHtml(value)}">${escapeHtml(value)}</button>
        ${id ? `<button class="chip-delete" type="button" data-keyword-id="${escapeHtml(id)}" data-keyword="${escapeHtml(value)}" aria-label="删除 ${escapeHtml(value)}">×</button>` : ""}
      </span>
    `;
  }).join("");
  wrap.querySelectorAll("[data-keyword-id]").forEach(button => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await api(`/api/sentiment/keywords/${encodeURIComponent(button.dataset.keywordId)}`, { method: "DELETE" });
        await loadKeywords();
        showToast("关键词已删除");
      } catch (error) {
        showToast(error.message);
      }
    });
  });
  wrap.querySelectorAll(".chip-select").forEach(button => {
    button.addEventListener("click", () => {
      const selected = addKeywordToInput(button.dataset.keyword || "");
      if (selected.length) refreshReport(keywordDisplayText(selected)).catch(error => showToast(error.message));
    });
  });
}

function renderMetrics() {
  const active = selectedReport();
  const stats = active?.stats || {};
  const metrics = [
    ["报告记录", state.reports.length],
    ["总匹配量", stats.total ?? 0],
    ["负面证据", stats.negative ?? 0],
    ["高危证据", stats.highRisk ?? 0],
    ["有结果来源", stats.sourceCount ?? 0],
  ];
  $("metricList").innerHTML = metrics.map(([label, value]) => (
    `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
  )).join("");

  const recommendations = [];
  if (!state.reports.length) recommendations.push("暂无分析报告记录，请输入关键词后执行搜索。");
  if (state.reports.length && !active) recommendations.push("点击左侧任一报告记录查看完整报告内容。");
  if (Number(stats.negative || 0) > 0) recommendations.push("存在负面证据，建议优先核实高权重来源、原始链接和传播路径。");
  if (Number(stats.sourceCount || 0) < 3 && Number(stats.total || 0) > 0) recommendations.push("当前有结果来源偏少，建议查看扫描进度和来源日志，优先处理被限流、超时或阻塞的来源。");
  if (Number(stats.highRisk || 0) > 0) recommendations.push("发现高危信号，建议生成危机简报并建立人工处置记录。");
  if (!recommendations.length) recommendations.push("当前风险较低，建议保持危情扫描并观察异常窗口。");
  $("recommendations").innerHTML = recommendations.map(item => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderReportRecords() {
  const wrap = $("reportRecords");
  if (!state.reports.length) {
    wrap.innerHTML = `
      <div class="records-empty">
        <strong>暂无分析报告记录</strong>
        <p>输入关键词并执行搜索后，报告会以记录形式显示在这里。点击记录才会展开详细报告内容。</p>
      </div>
    `;
    return;
  }
  wrap.innerHTML = state.reports.map(record => {
    const active = record.id === state.selectedReportId ? " active" : "";
    return `
      <button class="report-record${active}" type="button" data-report-id="${escapeHtml(record.id)}">
        <span class="record-main">
          <strong>${escapeHtml(record.keyword || "未命名报告")}</strong>
          <small>${escapeHtml(formatTime(record.createdAt))} · ${escapeHtml(record.mode || "scan")}</small>
        </span>
        <span class="record-stats">
          <b>${escapeHtml(record.stats?.total ?? 0)}</b> 条
          <em>${escapeHtml(record.stats?.negative ?? 0)} 负面</em>
          <em>${escapeHtml(record.stats?.highRisk ?? 0)} 高危</em>
        </span>
        <span class="record-summary">${escapeHtml(record.summary || "")}</span>
      </button>
    `;
  }).join("");
  wrap.querySelectorAll(".report-record").forEach(button => {
    button.addEventListener("click", () => {
      state.selectedReportId = button.dataset.reportId || "";
      renderAll();
      $("reportDetailSection").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function renderReportDetail() {
  const active = selectedReport();
  $("reportDetailSection").hidden = !active;
  $("evidenceSection").hidden = !active;
  if (!active) {
    $("executiveSummary").textContent = "";
    $("reportMarkdown").innerHTML = "";
    return;
  }
  $("detailTitle").textContent = active.keyword || "报告详情";
  $("detailMeta").textContent = `${formatTime(active.createdAt)} · ${active.mode || "scan"} · ${active.stats?.total || 0} 条证据`;
  $("executiveSummary").textContent = active.summary || "";
  $("reportMarkdown").innerHTML = markdownToHtml(active.markdown || "");
}

function renderEvidence() {
  const rows = getEvidenceRows();
  if (!rows.length) {
    $("evidenceTable").innerHTML = '<tr><td colspan="6" class="empty">暂无证据</td></tr>';
    return;
  }
  $("evidenceTable").innerHTML = rows.slice(0, 80).map(item => {
    const title = item.title || item.headline || item.url || "未命名证据";
    const content = item.content || item.content_text || item.snippet || item.summary || "";
    const url = item.url || "";
    const sentiment = item.sentiment || "neutral";
    const risk = riskLabel(item);
    return `
      <tr>
        <td>${escapeHtml(formatTime(item.published_at || item.found_at || item.captured_at))}</td>
        <td>${escapeHtml(item.platform || item.source_key || item.source || "-")}</td>
        <td class="title-cell"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(String(content).slice(0, 180))}</p></td>
        <td><span class="badge ${sentimentClass(sentiment)}">${escapeHtml(sentiment)}</span></td>
        <td><span class="badge ${escapeHtml(risk)}">${escapeHtml(risk)}</span></td>
        <td>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td>
      </tr>
    `;
  }).join("");
}

function renderAll() {
  renderStatus();
  renderScanProgress();
  renderMetrics();
  renderReportRecords();
  renderReportDetail();
  renderEvidence();
}

async function refreshReport(keyword = state.keyword) {
  state.keyword = String(keyword || state.keyword || "").trim();
  $("runState").textContent = state.keyword ? "读取报告" : "待搜索";
  const query = state.keyword ? `?q=${encodeURIComponent(state.keyword)}&limit=80` : "?limit=80";
  const reportDays = Number(state.adminSettings.reportDays || 30);
  const reportQuery = state.keyword ? `?days=${reportDays}&q=${encodeURIComponent(state.keyword)}` : `?days=${reportDays}`;
  const [dashboard, report, evidence] = await Promise.all([
    api("/api/sentiment/dashboard?limit=80"),
    api(`/api/sentiment/report${reportQuery}`),
    state.keyword ? api(`/api/sentiment/evidence-search${query}`) : api("/api/sentiment/evidence?limit=80"),
  ]);
  state.dashboard = dashboard;
  state.report = report.markdown || "";
  state.evidence = evidence.results || evidence.evidence || [];
  $("runState").textContent = "报告就绪";
  if (state.progress.visible || state.reports.length) {
    finishScanProgressFromReport({ dashboard, evidence: state.evidence, title: "报告已生成" });
  }
  renderAll();
}

async function runSearch(keyword, mode) {
  const keywords = Array.isArray(keyword) ? keyword : parseKeywordInput(keyword);
  state.keyword = keywordDisplayText(keywords);
  if (!state.keyword) {
    showToast("请输入或选择关键词");
    return;
  }
  const plannedSources = scanSourcesForMode(mode);
  $("searchBtn").disabled = true;
  $("runState").textContent = "保存关键词";
  beginScanProgress(state.keyword, mode, plannedSources);
  try {
    await api("/api/sentiment/keywords", {
      method: "POST",
      body: JSON.stringify({ keyword: keywords.join("\n") }),
    });
    $("runState").textContent = "启动扫描";
    const scanStart = await api("/api/sentiment/scan-start", {
      method: "POST",
      body: JSON.stringify({
        reason: "manual",
        mode,
        sources: plannedSources,
        days: Number(state.adminSettings.scanDays || 30),
      }),
    });
    const serverStartedAtMs = Date.parse(scanStart.startedAt || "");
    if (Number.isFinite(serverStartedAtMs)) {
      setScanProgress({ startedAtMs: serverStartedAtMs });
    }
    let scanBatch = null;
    if (scanStart.alreadyRunning && !scanStart.started) {
      stopScanProgressPolling();
      setScanProgress({
        active: false,
        phase: "reporting",
        title: "已有后台扫描在运行，先生成当前报告",
      });
      showToast("已有后台扫描在运行，先基于当前结果生成报告");
    } else {
      $("runState").textContent = "全网搜索中";
      scanBatch = await waitForScanCompletion();
    }
    $("runState").textContent = "生成报告";
    setScanProgress({
      active: true,
      phase: "reporting",
      title: "扫描完成，正在生成分析报告",
    });
    const [dashboard, report, evidence] = await Promise.all([
      api("/api/sentiment/dashboard?limit=80"),
      api(`/api/sentiment/report?days=${Number(state.adminSettings.reportDays || 30)}&q=${encodeURIComponent(state.keyword)}`),
      api(`/api/sentiment/evidence-search?q=${encodeURIComponent(state.keyword)}&limit=80`),
    ]);
    state.dashboard = dashboard;
    state.report = report.markdown || "";
    state.evidence = evidence.results || [];
    addReportRecord(createReportRecord({
      keyword: state.keyword,
      mode,
      dashboard: state.dashboard || {},
      markdown: state.report,
      evidence: state.evidence,
    }));
    $("runState").textContent = "报告就绪";
    finishScanProgressFromBatch(scanBatch);
    finishScanProgressFromReport({ dashboard: state.dashboard || {}, evidence: state.evidence, title: "报告已生成" });
    renderAll();
    await loadKeywords();
    showToast("搜索完成");
  } catch (error) {
    $("runState").textContent = "搜索失败";
    failScanProgress(error.message || "搜索失败");
    showToast(error.message);
  } finally {
    $("searchBtn").disabled = false;
  }
}

async function loadKeywords() {
  try {
    renderKeywords(await api("/api/sentiment/keywords"));
  } catch {
    renderKeywords([]);
  }
}

async function loadAdminRuntimeSettings() {
  const [admin, sourcePayload] = await Promise.all([
    api("/api/admin-settings"),
    api("/api/sentiment/sources"),
  ]);
  const sourceKeys = (sourcePayload.sources || []).map(source => source.source_key).filter(Boolean);
  const available = new Set(sourceKeys);
  const fallbackSources = (mode) => {
    if (mode === "full") return sourceKeys;
    const defaults = mode === "watch" ? CRISIS_SCAN_SOURCES : QUICK_SCAN_SOURCES;
    const selected = defaults.filter(source => available.has(source));
    return selected.length ? selected : sourceKeys;
  };
  const normalizeScope = (mode) => {
    const configured = Array.isArray(admin.settings?.sourceScopes?.[mode]) ? admin.settings.sourceScopes[mode] : [];
    const selected = configured.map(source => String(source || "").trim()).filter(source => available.has(source));
    return selected.length ? selected : fallbackSources(mode);
  };
  state.adminSettings = {
    scanDays: Number(admin.settings?.scanDays || 30),
    reportDays: Number(admin.settings?.reportDays || 30),
  };
  state.availableSourceKeys = sourceKeys;
  state.sourceScopes = {
    fast: normalizeScope("fast"),
    full: normalizeScope("full"),
    watch: normalizeScope("watch"),
  };
}

async function boot() {
  try {
    state.reports = loadReportRecords();
    const health = await api("/health");
    $("systemStatus").textContent = "后端在线";
    await loadAdminRuntimeSettings();
    await Promise.all([loadKeywords(), refreshReport("")]);
  } catch (error) {
    $("systemStatus").textContent = "后端连接失败";
    showToast(error.message);
  }
}

$("searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch(searchKeywordsFromInput(), $("modeSelect").value);
});

$("refreshBtn").addEventListener("click", () => {
  refreshReport(keywordDisplayText(searchKeywordsFromInput())).catch(error => showToast(error.message));
});

$("copyReportBtn").addEventListener("click", async () => {
  const active = selectedReport();
  await navigator.clipboard.writeText(active?.markdown || active?.summary || "");
  showToast("报告已复制");
});

$("clearReportsBtn").addEventListener("click", () => {
  state.reports = [];
  state.selectedReportId = "";
  saveReportRecords();
  renderAll();
  showToast("报告记录已清空");
});

document.querySelectorAll(".segmented").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".segmented").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    state.filter = button.dataset.filter || "all";
    renderEvidence();
  });
});

boot();
