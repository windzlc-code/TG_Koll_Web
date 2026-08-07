let personaDashboardRoot = null;
let personaDashboardBoundRoot = null;
const PD_ADMIN_WORKSPACE_USER_ID = String(document.querySelector('meta[name="admin-workspace-user-id"]')?.content || "").trim();
const PD_ADMIN_CONSOLE_SESSION = document.querySelector('meta[name="admin-console-session"]')?.content === "1";
const PERSONA_DASHBOARD_TIME_ZONE = "Asia/Shanghai";

function pdEl(id) {
  return personaDashboardRoot?.querySelector(`#${id}`) || document.getElementById(id);
}

async function pdApi(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (PD_ADMIN_WORKSPACE_USER_ID) headers["X-Admin-Workspace-User-ID"] = PD_ADMIN_WORKSPACE_USER_ID;
  if (PD_ADMIN_CONSOLE_SESSION) headers["X-Admin-Console"] = "1";
  let body = opts.body;
  if (body && typeof body !== "string") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { cache: "no-store", ...opts, headers, body });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { detail: text || `接口状态 ${res.status}` };
  }
  if (!res.ok) throw data || { detail: `接口状态 ${res.status}` };
  return data;
}

function pdEscape(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] || ch));
}

const pdInitialDashboardData = window.__PERSONA_DASHBOARD_BOOTSTRAP__ || window.__CONSOLE_BOOTSTRAP__;
let personaDashboardData = pdInitialDashboardData && Array.isArray(pdInitialDashboardData.personas)
  ? pdInitialDashboardData
  : null;
let personaDashboardRefreshTask = "";
let personaDashboardPlatform = "";
let personaDashboardPlatformPickerOpen = false;
let personaDashboardAutoPollTimer = 0;
let personaDashboardLastLoadedAt = personaDashboardData ? Date.now() : 0;
let personaDashboardLoadPromise = null;
const PD_DASHBOARD_VIEW_CACHE_MS = 60 * 1000;

const PD_LABELS = {
  likes: "点赞",
  comments: "评论",
  shares: "分享",
  reposts: "转发",
  complete: "完整数据",
  partial_or_unknown: "部分/未知",
  none: "暂无数据",
  queued: "排队中",
  running: "运行中",
  done: "已完成",
  success: "成功",
  failed: "失败",
  cancelled: "已取消",
  pending: "待处理",
  unknown: "未知",
};

function pdLabel(value) {
  const key = String(value || "").trim();
  return PD_LABELS[key] || key || "-";
}

function pdFormatMetricUnit(value, divisor, suffix) {
  const scaled = Number(value || 0) / divisor;
  const rounded = Math.round(scaled * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`;
}

function pdNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  const absolute = Math.abs(n);
  if (absolute >= 100000000) return pdFormatMetricUnit(n, 100000000, "亿");
  if (absolute >= 1000000) return pdFormatMetricUnit(n, 1000000, "m");
  if (absolute >= 10000) return pdFormatMetricUnit(n, 10000, "w");
  if (absolute >= 1000) return pdFormatMetricUnit(n, 1000, "k");
  return String(Math.round(n));
}

function pdDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString("zh-CN", { timeZone: PERSONA_DASHBOARD_TIME_ZONE, hour12: false });
  }
  const text = String(value || "").trim();
  if (!text) return "-";
  if (/^\d{13}$/.test(text)) {
    const date = new Date(Number(text));
    if (!Number.isNaN(date.getTime())) return date.toLocaleString("zh-CN", { timeZone: PERSONA_DASHBOARD_TIME_ZONE, hour12: false });
  }
  if (/^\d{10}$/.test(text)) {
    const date = new Date(Number(text) * 1000);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString("zh-CN", { timeZone: PERSONA_DASHBOARD_TIME_ZONE, hour12: false });
  }
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date.toLocaleString("zh-CN", { timeZone: PERSONA_DASHBOARD_TIME_ZONE, hour12: false });
  return text;
}

function pdEntries(value) {
  return Object.entries(value || {})
    .map(([label, count]) => ({ label: pdLabel(label), value: Number(count || 0) }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);
}

function pdPlatformFilter() {
  return String(personaDashboardPlatform || "").trim().toLowerCase();
}

function pdIsWebVisiblePlatform(value) {
  const platform = String(value || "").trim().toLowerCase();
  return !!platform && platform !== "telegram";
}

function pdPlatformLabel(value) {
  const platform = String(value || "").trim().toLowerCase();
  if (!platform) return "全部平台";
  if (platform === "threads") return "Threads";
  if (platform === "instagram") return "Instagram";
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

function pdPlatformIcon(value) {
  if (typeof renderAccountPoolPlatformIcon === "function") {
    return renderAccountPoolPlatformIcon(value);
  }
  if (!String(value || "").trim()) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"></rect><rect x="14" y="4" width="6" height="6" rx="1"></rect><rect x="4" y="14" width="6" height="6" rx="1"></rect><rect x="14" y="14" width="6" height="6" rx="1"></rect></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"></circle></svg>';
}

function pdDashboardPlatforms(data) {
  const platforms = new Set(["threads", "instagram"]);
  (data && data.personas || []).forEach((persona) => {
    (persona.hot_platforms || []).forEach((item) => {
      if (pdIsWebVisiblePlatform(item && item.platform)) platforms.add(String(item.platform).trim().toLowerCase());
    });
    Object.keys((persona.counts && persona.counts.platform_posts) || {}).forEach((platform) => {
      if (pdIsWebVisiblePlatform(platform)) platforms.add(String(platform).trim().toLowerCase());
    });
  });
  return ["", ...Array.from(platforms).filter(pdIsWebVisiblePlatform).sort()];
}

function pdRenderDashboardPlatformTabs(data) {
  const host = pdEl("personaDashboardPlatformTabs");
  if (!host) return;
  const platforms = pdDashboardPlatforms(data);
  if (personaDashboardPlatform && !platforms.includes(personaDashboardPlatform)) personaDashboardPlatform = "";
  const selectedPlatform = personaDashboardPlatform;
  const renderPlatformOption = (platform) => {
    const isActive = selectedPlatform === platform;
    return `
      <button
        class="${isActive ? "is-active" : ""}"
        type="button"
        role="option"
        aria-selected="${isActive ? "true" : "false"}"
        data-persona-dashboard-platform-option="${pdEscape(platform)}"
      >
        ${pdPlatformIcon(platform)}
        <strong>${pdEscape(pdPlatformLabel(platform))}</strong>
      </button>
    `;
  };
  host.innerHTML = `
    <div class="persona-dashboard-platform-picker">
      <button
        id="personaDashboardPlatformPickerTrigger"
        class="persona-dashboard-platform-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded="${personaDashboardPlatformPickerOpen ? "true" : "false"}"
      >
        ${pdPlatformIcon(selectedPlatform)}
        <strong>${pdEscape(pdPlatformLabel(selectedPlatform))}</strong>
        <svg class="persona-dashboard-platform-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"></path></svg>
      </button>
      ${personaDashboardPlatformPickerOpen ? `
        <div class="persona-dashboard-platform-menu" role="listbox" aria-label="选择平台">
          <div class="account-pool-platforms account-pool-platform-tabs persona-dashboard-platform-options">
            ${platforms.map(renderPlatformOption).join("")}
          </div>
        </div>
      ` : ""}
    </div>
  `;
  pdEl("personaDashboardPlatformPickerTrigger")?.addEventListener("click", (event) => {
    event.stopPropagation();
    personaDashboardPlatformPickerOpen = !personaDashboardPlatformPickerOpen;
    pdRenderDashboard();
  });
  host.querySelectorAll("[data-persona-dashboard-platform-option]").forEach((node) => {
    node.addEventListener("click", () => {
      personaDashboardPlatform = String(node.getAttribute("data-persona-dashboard-platform-option") || "");
      personaDashboardPlatformPickerOpen = false;
      pdRenderDashboard();
    });
  });
}

function pdCloseDashboardPlatformPicker() {
  if (!personaDashboardPlatformPickerOpen) return;
  personaDashboardPlatformPickerOpen = false;
  pdRenderDashboard();
}

function pdFilterTrend(rows) {
  return rows || [];
}

function pdPersonaHot(persona) {
  const platform = pdPlatformFilter();
  const base = persona.hot || {};
  if (!platform) return base;
  const rows = (persona.hot_platforms || []).filter((item) => String(item.platform || "").toLowerCase() === platform);
  if (!rows.length) return {
    likes: 0,
    comments: 0,
    shares: 0,
    reposts: 0,
    recent_views: 0,
    post_views: 0,
    hot_score: 0,
  };
  return rows.reduce((sum, row) => {
    sum.likes += Number(row.likes || 0);
    sum.comments += Number(row.comments || 0);
    sum.shares += Number(row.shares || 0);
    sum.reposts += Number(row.reposts || 0);
    sum.recent_views += Number(row.recent_views || 0);
    sum.post_views += Number(row.post_views || 0);
    sum.hot_score += Number(row.likes || 0) + Number(row.comments || 0) + Number(row.shares || 0) + Number(row.reposts || 0) + Number(row.post_views || 0);
    return sum;
  }, { likes: 0, comments: 0, shares: 0, reposts: 0, recent_views: 0, post_views: 0, hot_score: 0 });
}

function pdVisibleSummary(visiblePersonas) {
  const summary = {
    persona_count: visiblePersonas.length,
    post_count: 0,
    published_count: 0,
    total_interactions: 0,
    recent_views: 0,
    post_views: 0,
    hot_score: 0,
  };
  visiblePersonas.forEach((persona) => {
    const counts = persona.counts || {};
    const hot = pdPersonaHot(persona);
    summary.post_count += Number(counts.posts || 0);
    summary.published_count += Number(counts.published || 0);
    summary.recent_views += Number(hot.recent_views || 0);
    summary.post_views += Number(hot.post_views || 0);
    summary.hot_score += Number(hot.hot_score || 0);
    summary.total_interactions += Number(hot.likes || 0) + Number(hot.comments || 0) + Number(hot.shares || 0) + Number(hot.reposts || 0);
  });
  return summary;
}

function pdBuildFilteredCharts(visiblePersonas, data) {
  const selectedPlatform = pdPlatformFilter();
  const platformDistribution = {};
  const engagement = { likes: 0, comments: 0, shares: 0, reposts: 0 };
  const taskStatus = {};
  const coverage = { complete: 0, partial_or_unknown: 0, none: 0 };

  visiblePersonas.forEach((persona) => {
    const hot = pdPersonaHot(persona);
    Object.keys(engagement).forEach((key) => { engagement[key] += Number(hot[key] || 0); });
    (persona.hot_platforms || []).filter((item) => {
      return !selectedPlatform || String(item.platform || "").trim().toLowerCase() === selectedPlatform;
    }).forEach((item) => {
      const platform = String(item.platform || "").trim();
      if (pdIsWebVisiblePlatform(platform)) platformDistribution[platform] = (platformDistribution[platform] || 0) + 1;
    });
    Object.keys((persona.counts && persona.counts.platform_posts) || {}).forEach((platform) => {
      const count = Number(persona.counts.platform_posts[platform] || 0);
      if (
        count > 0
        && pdIsWebVisiblePlatform(platform)
        && (!selectedPlatform || String(platform || "").trim().toLowerCase() === selectedPlatform)
      ) platformDistribution[platform] = (platformDistribution[platform] || 0) + count;
    });
    const platforms = (persona.hot_platforms || []).filter((item) => (
      pdIsWebVisiblePlatform(item.platform)
      && (!selectedPlatform || String(item.platform || "").trim().toLowerCase() === selectedPlatform)
    ));
    if (!platforms.length) coverage.none += 1;
    else if (platforms.some((item) => item.complete)) coverage.complete += 1;
    else coverage.partial_or_unknown += 1;
    Object.entries((persona.queue && persona.queue.by_status) || {}).forEach(([status, count]) => {
      taskStatus[status] = (taskStatus[status] || 0) + Number(count || 0);
    });
  });

  return {
    platform_distribution: platformDistribution,
    engagement_mix: engagement,
    task_status_distribution: taskStatus,
    hot_coverage: coverage,
    trend: pdFilterTrend(
      selectedPlatform
        ? ((data.charts && data.charts.platform_trend && data.charts.platform_trend[selectedPlatform]) || [])
        : (data.charts && data.charts.trend),
    ),
  };
}

function pdRenderChartPlaceholder(kind = "bars", message = "暂无可展示数据") {
  const shape = kind === "donut"
    ? `<div class="persona-chart-placeholder-donut" aria-hidden="true"><i></i><span>0</span></div>`
    : kind === "line"
      ? `<svg class="persona-chart-placeholder-line" viewBox="0 0 240 76" aria-hidden="true" focusable="false"><path d="M8 60 L54 44 L96 50 L142 24 L188 38 L232 12" /></svg>`
      : `<div class="persona-chart-placeholder-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>`;
  return `<div class="persona-chart-placeholder persona-chart-placeholder--${pdEscape(kind)}" role="img" aria-label="${pdEscape(message)}">
    ${shape}
    <span>${pdEscape(message)}</span>
  </div>`;
}

function pdRenderBarChart(hostId, rows) {
  const host = pdEl(hostId);
  if (!host) return;
  const items = (rows || [])
    .filter((row) => Number(row.value || 0) > 0)
    .sort((left, right) => Number(right.value || 0) - Number(left.value || 0))
    .slice(0, 12);
  if (!items.length) {
    host.innerHTML = pdRenderChartPlaceholder("bars", "暂无热度数据");
    return;
  }
  const max = Math.max(...items.map((row) => Number(row.value || 0)), 1);
  host.innerHTML = `
    <div class="persona-bar-list">
      ${items.map((row, index) => {
        const pct = Math.max(3, Math.round((Number(row.value || 0) / max) * 100));
        return `
          <div class="persona-bar-row">
            <div class="persona-bar-label"><span>${index + 1}</span>${pdEscape(row.label || row.name || "-")}</div>
            <div class="persona-bar-track"><div class="persona-bar-fill" style="width:${pct}%"></div></div>
            <div class="persona-bar-value">${pdEscape(pdNumber(row.value))}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function pdRenderDonutChart(hostId, entries) {
  const host = pdEl(hostId);
  if (!host) return;
  const rows = pdEntries(entries);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (!total) {
    host.innerHTML = pdRenderChartPlaceholder("donut", "暂无分布数据");
    return;
  }
  const colors = ["var(--accent)", "#d8992b", "#3f8d67", "#ba554f", "#7b6a9b", "#4f7775"];
  let cursor = 0;
  const segments = rows.map((row, index) => {
    const start = cursor;
    const size = (row.value / total) * 100;
    cursor += size;
    return `${colors[index % colors.length]} ${start}% ${cursor}%`;
  }).join(", ");
  host.innerHTML = `
    <div class="persona-donut-wrap">
      <div class="persona-donut" style="background: conic-gradient(${segments})">
        <div><strong>${pdNumber(total)}</strong><span>总计</span></div>
      </div>
      <div class="persona-donut-legend">
        ${rows.map((row, index) => `
          <div><span style="background:${colors[index % colors.length]}"></span>${pdEscape(row.label)}<b>${pdEscape(pdNumber(row.value))}</b></div>
        `).join("")}
      </div>
    </div>
  `;
}

function pdRenderTrendChart(hostId, rows) {
  const host = pdEl(hostId);
  if (!host) return;
  const items = (rows || []).slice(-30);
  if (!items.length) {
    host.innerHTML = pdRenderChartPlaceholder("line", "暂无走势数据");
    return;
  }
  const width = 720;
  const height = 220;
  const pad = 28;
  const series = [
    { key: "published", label: "发布", color: "var(--accent)" },
    { key: "post_views", label: "帖子浏览", color: "#d8992b" },
    { key: "likes", label: "点赞", color: "#3f8d67" },
  ];
  const max = Math.max(1, ...items.flatMap((row) => series.map((s) => Number(row[s.key] || 0))));
  const x = (index) => pad + (items.length === 1 ? 0 : (index / (items.length - 1)) * (width - pad * 2));
  const y = (value) => height - pad - (Number(value || 0) / max) * (height - pad * 2);
  const pathFor = (key) => items.map((row, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(row[key]).toFixed(1)}`).join(" ");
  host.innerHTML = `
    <svg class="persona-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="流量走势图">
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" class="persona-axis" />
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" class="persona-axis" />
      ${series.map((s) => `<path d="${pathFor(s.key)}" fill="none" stroke="${s.color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />`).join("")}
      ${items.map((row, index) => `<text x="${x(index)}" y="${height - 6}" text-anchor="middle">${pdEscape(String(row.date || "").slice(5))}</text>`).join("")}
    </svg>
    <div class="persona-line-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("")}</div>
  `;
}

function pdRenderSummary(visiblePersonas) {
  const host = pdEl("personaDashboardSummary");
  if (!host) return;
  const summary = pdVisibleSummary(visiblePersonas);
  const cards = [
    { label: "人设", value: summary.persona_count, hint: "全局人设归档，不受平台切换影响" },
    { label: "帖子", value: summary.post_count, hint: "全局归档帖子，不受平台切换影响" },
    { label: "发布", value: summary.published_count, hint: "全局发布归档，不受平台切换影响" },
    { label: "互动", value: summary.total_interactions, hint: "点赞、评论、转发、分享" },
    { label: "主页浏览", value: summary.recent_views, hint: "账号主页级浏览" },
    { label: "逐帖浏览", value: summary.post_views, hint: "逐帖浏览，不与主页浏览合并" },
    { label: "热度", value: summary.hot_score, hint: "逐帖浏览 + 点赞 + 评论 + 分享 + 转发" },
  ];
  host.innerHTML = cards.map((card) => `
    <div class="kpi persona-kpi" title="${pdEscape(card.hint)}">
      <div class="label">${pdEscape(card.label)}</div>
      <div class="num">${pdEscape(pdNumber(card.value))}</div>
    </div>
  `).join("");
}

function pdRenderDashboard() {
  const data = personaDashboardData;
  const empty = pdEl("personaDashboardEmpty");
  const meta = pdEl("personaDashboardMeta");
  const overview = pdEl("personaOverviewPane");
  if (!data || !empty) return;
  pdRenderDashboardPlatformTabs(data);
  const visible = data.personas || [];
  const charts = pdBuildFilteredCharts(visible, data);
  pdRenderSummary(visible);
  pdRenderBarChart("personaHotRankChart", visible.map((item) => ({ label: item.name, value: pdPersonaHot(item).hot_score })));
  pdRenderDonutChart("personaPlatformChart", charts.platform_distribution);
  pdRenderDonutChart("personaCoverageChart", charts.hot_coverage);
  pdRenderTrendChart("personaTrendChart", charts.trend);
  pdRenderDonutChart("personaEngagementChart", charts.engagement_mix);
  pdRenderDonutChart("personaTaskStatusChart", charts.task_status_distribution);
  if (overview) overview.style.display = "grid";
  if (meta) meta.textContent = `当前显示 ${visible.length} / ${(data.personas || []).length} 个人设`;
  empty.style.display = visible.length ? "none" : "block";
}

function pdSetMsg(text, type = "ok") {
  const msg = pdEl("personaDashboardMsg");
  if (!msg) return;
  msg.textContent = text || "";
  msg.className = text ? `msg ${type}` : "msg";
}

function pdSetRefreshControlState(status = "idle", progress = 0) {
  const button = pdEl("btnPersonaDashboardSync");
  const label = pdEl("personaDashboardSyncStatus");
  if (!button) return;
  const normalized = String(status || "idle").trim().toLowerCase();
  const active = normalized === "queued" || normalized === "running";
  const done = normalized === "done" || normalized === "success" || normalized === "completed";
  const failed = normalized === "failed" || normalized === "error";
  const value = Math.max(0, Math.min(100, Number(progress) || 0));
  button.disabled = active;
  button.classList.toggle("is-loading", active);
  button.classList.toggle("is-complete", done);
  button.classList.toggle("is-failed", failed);
  button.dataset.progress = String(value);
  button.style.setProperty("--sync-progress", `${value}%`);
  button.setAttribute("aria-busy", active ? "true" : "false");
  if (label) label.textContent = "数据刷新";
  const title = active ? `同步中 ${value}%` : (done ? "同步完成" : (failed ? "同步失败，点击重试" : "同步全部数据"));
  button.title = title;
  button.setAttribute("aria-label", title);
}

function pdDashboardViewCacheIsFresh() {
  return Boolean(
    personaDashboardData
    && personaDashboardLastLoadedAt
    && Date.now() - personaDashboardLastLoadedAt < PD_DASHBOARD_VIEW_CACHE_MS,
  );
}

async function pdLoadDashboard(options = {}) {
  const silent = Boolean(options && options.silent);
  if (personaDashboardLoadPromise) {
    return personaDashboardLoadPromise;
  }
  const request = (async () => {
    if (!silent) pdSetMsg("正在加载人设数据...", "ok");
    try {
      const data = await pdApi("/api/persona_dashboard/overview");
      personaDashboardData = data;
      personaDashboardLastLoadedAt = Date.now();
      const updated = pdEl("personaDashboardUpdated");
      if (updated) {
        const latest = data.summary && data.summary.latest_data_at;
        updated.textContent = `缓存读取：${pdDate(data.updated_at)} · 最近数据：${pdDate(latest)}`;
      }
      if (!silent) pdSetMsg("");
      pdRenderDashboard();
      return data;
    } catch (err) {
      if (!silent) pdSetMsg(String((err && (err.detail || err.message)) || err || "加载失败"), "err");
      return null;
    }
  })();
  personaDashboardLoadPromise = request;
  try {
    return await request;
  } finally {
    if (personaDashboardLoadPromise === request) personaDashboardLoadPromise = null;
  }
}

function pdStartAutoPoll() {
  if (personaDashboardAutoPollTimer) window.clearInterval(personaDashboardAutoPollTimer);
  personaDashboardAutoPollTimer = window.setInterval(() => {
    if (document.hidden) return;
    pdLoadDashboard({ silent: true });
  }, 60000);
}

function pdStopAutoPoll() {
  if (!personaDashboardAutoPollTimer) return;
  window.clearInterval(personaDashboardAutoPollTimer);
  personaDashboardAutoPollTimer = 0;
}

async function pdStartRefresh() {
  if (personaDashboardRefreshTask) return;
  pdSetRefreshControlState("queued", 0);
  try {
    pdSetMsg("");
    const task = await pdApi("/api/persona_dashboard/refresh", {
      method: "POST",
      body: { archive_id: "" },
    });
    personaDashboardRefreshTask = task.id;
    pdSetRefreshControlState("queued", Number(task.progress || 0));
    pdPollRefresh(task.id);
  } catch (err) {
    pdSetRefreshControlState("failed", 0);
    pdSetMsg(String((err && (err.detail || err.message)) || err || "启动刷新失败"), "err");
  }
}

async function pdPollRefresh(taskId) {
  if (!taskId || taskId !== personaDashboardRefreshTask) return;
  try {
    const task = await pdApi(`/api/persona_dashboard/refresh/${encodeURIComponent(taskId)}`);
    const progress = Number(task.progress || 0);
    pdSetRefreshControlState(task.status, progress);
    const running = ["queued", "running"].includes(String(task.status));
    if (task.status === "failed") pdSetMsg("同步失败", "err");
    else pdSetMsg("");
    if (running) {
      window.setTimeout(() => pdPollRefresh(taskId), 2500);
      return;
    }
    personaDashboardRefreshTask = "";
    await pdLoadDashboard();
    if (task.status === "failed") {
      pdSetMsg("同步失败，请稍后重试。", "err");
    } else {
      pdSetMsg("");
    }
  } catch (err) {
    personaDashboardRefreshTask = "";
    pdSetRefreshControlState("failed", 0);
    pdSetMsg(String((err && (err.detail || err.message)) || err || "查询刷新状态失败"), "err");
  }
}

function pdBindDashboard(root) {
  if (!root || personaDashboardBoundRoot === root) return;
  personaDashboardBoundRoot = root;
  document.addEventListener("click", (event) => {
    if (!personaDashboardPlatformPickerOpen) return;
    const picker = pdEl("personaDashboardPlatformTabs")?.querySelector(".persona-dashboard-platform-picker");
    if (picker?.contains(event.target)) return;
    pdCloseDashboardPlatformPicker();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") pdCloseDashboardPlatformPicker();
  });
  const refresh = pdEl("btnPersonaDashboardSync");
  if (refresh) refresh.addEventListener("click", pdStartRefresh);
}

function pdMountDashboard(root) {
  if (!root) return;
  personaDashboardRoot = root;
  pdBindDashboard(root);
  if (personaDashboardData) {
    pdRenderDashboard();
    if (!pdDashboardViewCacheIsFresh()) void pdLoadDashboard({ silent: true });
  } else {
    void pdLoadDashboard();
  }
  pdStartAutoPoll();
}

function pdUnmountDashboard() {
  personaDashboardPlatformPickerOpen = false;
  pdStopAutoPoll();
}

window.PersonaDashboard = {
  mount: pdMountDashboard,
  unmount: pdUnmountDashboard,
};

window.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("personaDashboardApp");
  const standalone = root && root.dataset.personaDashboardStandalone === "true";
  const activeConsoleView = root && root.closest("[data-panel='persona_dashboard']")?.classList.contains("is-active");
  if (standalone || activeConsoleView) pdMountDashboard(root);
});
