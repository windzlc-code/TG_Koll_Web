let personaDashboardRoot = null;
let personaDashboardBoundRoot = null;
const PD_ADMIN_WORKSPACE_USER_ID = String(document.querySelector('meta[name="admin-workspace-user-id"]')?.content || "").trim();
const PD_ADMIN_CONSOLE_SESSION = document.querySelector('meta[name="admin-console-session"]')?.content === "1";
const PERSONA_DASHBOARD_TIME_ZONE = "Asia/Shanghai";

function pdEl(id) {
  return personaDashboardRoot?.querySelector(`#${id}`) || document.getElementById(id);
}

function pdAdminWorkspaceUrl(value) {
  const text = String(value || "").trim();
  if ((!PD_ADMIN_WORKSPACE_USER_ID && !PD_ADMIN_CONSOLE_SESSION) || !text) return text;
  try {
    const url = new URL(text, window.location.href);
    if (url.origin !== window.location.origin) return text;
    if (PD_ADMIN_WORKSPACE_USER_ID) url.searchParams.set("admin_workspace_user_id", PD_ADMIN_WORKSPACE_USER_ID);
    if (PD_ADMIN_CONSOLE_SESSION) url.searchParams.set("admin_console", "1");
    if (/^[a-z][a-z\d+.-]*:/i.test(text)) return url.href;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return text;
  }
}

function pdSafeLinkUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, window.location.origin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    if (url.origin !== window.location.origin) return url.href;
    return pdAdminWorkspaceUrl(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    return "";
  }
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

function pdPromptDialog(options = {}) {
  const title = String(options.title || "操作确认");
  const message = String(options.message || "");
  const confirmText = String(options.confirmText || "确认");
  const cancelText = String(options.cancelText || "取消");
  const tone = String(options.tone || "default");
  const showCancel = options.showCancel !== false;
  const existing = document.querySelector(".persona-prompt-modal");
  if (existing) existing.remove();
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = `persona-prompt-modal persona-prompt-modal-${tone}`;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", title);
    modal.innerHTML = `
      <div class="persona-prompt-card">
        <div class="persona-prompt-head">
          <strong>${pdEscape(title)}</strong>
          <button class="persona-prompt-icon" type="button" data-prompt-action="cancel" aria-label="关闭">×</button>
        </div>
        <div class="persona-prompt-body">${pdEscape(message)}</div>
        <div class="persona-prompt-actions">
          ${showCancel ? `<button class="ghost" type="button" data-prompt-action="cancel">${pdEscape(cancelText)}</button>` : ""}
          <button class="primary" type="button" data-prompt-action="confirm">${pdEscape(confirmText)}</button>
        </div>
      </div>
    `;
    const close = (value) => {
      document.removeEventListener("keydown", onKeydown);
      modal.remove();
      resolve(value);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") close(false);
    };
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close(false);
    });
    modal.querySelectorAll("[data-prompt-action]").forEach((node) => {
      node.addEventListener("click", () => close(node.getAttribute("data-prompt-action") === "confirm"));
    });
    document.addEventListener("keydown", onKeydown);
    document.body.appendChild(modal);
    const primary = modal.querySelector("[data-prompt-action='confirm']");
    if (primary) primary.focus();
  });
}

function pdConfirm(message, options = {}) {
  return pdPromptDialog({ ...options, message, showCancel: true });
}

const pdInitialDashboardData = window.__PERSONA_DASHBOARD_BOOTSTRAP__ || window.__CONSOLE_BOOTSTRAP__;
let personaDashboardData = pdInitialDashboardData && Array.isArray(pdInitialDashboardData.personas)
  ? pdInitialDashboardData
  : null;
let personaDashboardSelectedId = "__overview__";
let personaDashboardPostPage = 1;
let personaDashboardPageSize = Number(localStorage.getItem("personaDashboardPageSize") || 10) || 10;
let personaDashboardRefreshTask = "";
let personaDashboardPlatform = "";
let personaDashboardPlatformPickerOpen = false;
let personaDashboardTabPage = 1;
let personaDashboardPostModalKey = "";
let personaDashboardGalleryIndex = -1;
let personaDashboardAutoPollTimer = 0;
let personaDashboardLastLoadedAt = personaDashboardData ? Date.now() : 0;
let personaDashboardLoadPromise = null;
let personaDashboardPostSort = localStorage.getItem("personaDashboardPostSort") || "hot_desc";
let personaDashboardPostTypeFilter = localStorage.getItem("personaDashboardPostTypeFilter") || "all";
const PD_DASHBOARD_VIEW_CACHE_MS = 60 * 1000;
const PD_MOBILE_TWEET_STREAM_QUERY = "(max-width: 760px)";
const personaDashboardInitialParams = new URLSearchParams(window.location.search || "");
const personaDashboardInitialPersonaId = String(personaDashboardInitialParams.get("persona_id") || personaDashboardInitialParams.get("persona") || "").trim();
let personaDashboardInitialPersonaApplied = false;
let personaDashboardMobilePostKey = "";
let personaDashboardMobilePostLimit = 0;
let personaDashboardMobilePostObserver = null;
let personaDashboardMobilePostPending = false;

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
      personaDashboardPostPage = 1;
      personaDashboardTabPage = 1;
      pdRenderDashboard();
    });
  });
}

function pdCloseDashboardPlatformPicker() {
  if (!personaDashboardPlatformPickerOpen) return;
  personaDashboardPlatformPickerOpen = false;
  pdRenderDashboard();
}

function pdPostHeat(row) {
  return Number(row.view_count || 0)
    + Number(row.like_count || 0)
    + Number(row.comment_count || 0)
    + Number(row.share_count || 0)
    + Number(row.repost_count || 0);
}

function pdPostTime(row) {
  const ts = new Date(row.published_at || row.captured_at || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function pdPostSortNumber(row, sort) {
  if (sort.startsWith("time_")) return pdPostTime(row);
  if (sort.startsWith("likes_")) return Number(row.like_count || 0);
  if (sort.startsWith("comments_")) return Number(row.comment_count || 0);
  if (sort.startsWith("reposts_")) return Number(row.repost_count || 0);
  if (sort.startsWith("shares_")) return Number(row.share_count || 0);
  if (sort.startsWith("views_")) return Number(row.view_count || 0);
  return pdPostHeat(row);
}

function pdPostMatchesType(row) {
  const type = String(personaDashboardPostTypeFilter || "all");
  if (type === "all") return true;
  const parts = pdPostComposition(row);
  if (type === "text") return parts.hasText;
  if (type === "image") return parts.imageCount > 0;
  if (type === "video") return parts.videoCount > 0;
  if (type === "media") return parts.totalMedia > 0;
  return true;
}

function pdPostSortLabel(value) {
  return ({
    hot_desc: "热度最高",
    hot_asc: "热度最低",
    time_desc: "发布时间最新",
    time_asc: "发布时间最早",
    likes_desc: "点赞最多",
    comments_desc: "评论最多",
    reposts_desc: "转发最多",
    shares_desc: "分享最多",
    views_desc: "逐帖浏览最多",
  }[String(value || "")] || "热度最高");
}

function pdPostTypeLabel(value) {
  return ({
    all: "全部内容",
    text: "有文字",
    image: "有图片",
    video: "有视频",
    media: "有媒体",
  }[String(value || "")] || "全部内容");
}

function pdFilterTrend(rows) {
  return rows || [];
}

function pdFilteredPostRows(persona) {
  const platform = pdPlatformFilter();
  const sort = String(personaDashboardPostSort || "hot_desc");
  const dir = sort.endsWith("_asc") ? 1 : -1;
  return (persona.post_metrics || []).filter((row) => {
    if (!pdIsWebVisiblePlatform(row.platform)) return false;
    if (platform && String(row.platform || "").toLowerCase() !== platform) return false;
    return pdPostMatchesType(row);
  }).sort((a, b) => {
    const diff = pdPostSortNumber(a, sort) - pdPostSortNumber(b, sort);
    if (diff !== 0) return diff * dir;
    return (pdPostTime(a) - pdPostTime(b)) * -1;
  });
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

function pdMatches() {
  // Platform tabs refine platform-specific posts and engagement only.  The
  // persona archive is a shared source of truth, so changing platforms must
  // never make its total or its selectable personas disappear.
  return true;
}

function pdRenderSummary(data, visiblePersonas) {
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

function pdPersonaWarnings(persona) {
  const warnings = (persona.warnings || []).filter(Boolean);
  if (!warnings.length) return "";
  const accountUnbound = warnings.some((item) => /未绑定|绑定账号|用户名/.test(String(item || "")));
  const summary = accountUnbound ? "账号未绑定 · 热点待同步" : "热点数据待刷新";
  return `
    <div class="persona-warning-summary" title="${pdEscape(warnings.join("；"))}">${pdEscape(summary)}</div>
  `;
}

function pdRenderPublishHistory(persona) {
  const history = (persona.publish_history || []).filter((row) => String(row.automation_task_type || row.task_type || "") !== "open_login");
  const rows = history.slice(0, 20).map((row) => `
    <tr>
      <td class="persona-post-platform">${pdEscape(row.platform || "-")}</td>
      <td class="persona-post-source">
        <div>${pdEscape(row.title || "发布记录")}</div>
        <small>${pdEscape(String(row.content || "").slice(0, 160))}</small>
      </td>
      <td class="persona-post-time">${pdEscape(pdDate(row.published_at))}</td>
      <td>${pdEscape(row.status || "success")}</td>
      <td class="persona-post-actions">
        ${pdSafeLinkUrl(row.published_url) ? `<a class="ghost" href="${pdEscape(pdSafeLinkUrl(row.published_url))}" target="_blank" rel="noopener">打开</a>` : `<span class="small">-</span>`}
      </td>
    </tr>
  `).join("");
  return `
    <div class="persona-table-wrap">
      <div class="persona-table-toolbar">
        <div class="persona-table-title">
          <strong>网页发布 / 操作记录</strong>
          <span>最近 ${pdEscape(String(history.length))} 条</span>
        </div>
      </div>
      <table class="persona-post-table">
        <thead><tr><th>平台</th><th>内容</th><th>时间</th><th>状态</th><th>链接</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5">暂无网页发布或操作记录</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

function pdIsMobileTweetStreamMode() {
  return Boolean(window.matchMedia?.(PD_MOBILE_TWEET_STREAM_QUERY).matches);
}

function pdMobilePostStreamInfo(persona, rows, pageSize) {
  const key = [
    pdPersonaKey(persona),
    pdPlatformFilter() || "all",
    personaDashboardPostTypeFilter,
    personaDashboardPostSort,
    pageSize,
  ].join("::");
  if (key !== personaDashboardMobilePostKey) {
    personaDashboardMobilePostKey = key;
    personaDashboardMobilePostLimit = pageSize;
  }
  const loaded = Math.min(rows.length, Math.max(pageSize, Number(personaDashboardMobilePostLimit || pageSize)));
  personaDashboardMobilePostLimit = loaded;
  return {
    key,
    loaded,
    total: rows.length,
    hasMore: loaded < rows.length,
  };
}

function pdRenderPostTableRow(row) {
  return `
    <tr>
      <td class="persona-post-platform" data-label="平台">
        <span class="persona-post-platform-name">${pdEscape(row.platform || "-")}</span>
        ${pdRenderPostContentBadges(row)}
      </td>
      <td class="persona-post-source" data-label="推文内容">
        <div>${pdEscape(String(row.content || row.source_url || "-"))}</div>
      </td>
      <td class="persona-post-time" data-label="发布时间">${pdEscape(pdDate(row.published_at || row.captured_at))}</td>
      <td class="persona-post-number" data-label="点赞">${pdEscape(pdNumber(row.like_count))}</td>
      <td class="persona-post-number" data-label="评论">${pdEscape(pdNumber(row.comment_count))}</td>
      <td class="persona-post-number" data-label="转发">${pdEscape(pdNumber(row.repost_count))}</td>
      <td class="persona-post-number" data-label="分享">${pdEscape(pdNumber(row.share_count))}</td>
      <td class="persona-post-number" data-label="逐帖浏览">${pdEscape(pdNumber(row.view_count))}</td>
      <td class="persona-post-actions" data-label="操作">
        <button class="ghost" type="button" data-post-view="${pdEscape(row.post_key || "")}">查看</button>
        <button class="ghost persona-post-delete persona-selection-icon-button" type="button" data-post-delete="${pdEscape(row.post_key || "")}" title="删除" aria-label="删除">${renderTrashIcon()}</button>
      </td>
    </tr>
  `;
}

function pdRenderMobilePostStreamStatus(stream) {
  if (!stream.total) return "";
  return `
    <div class="persona-mobile-post-stream ${stream.hasMore ? "" : "is-complete"}" aria-live="polite">
      <span>已显示 ${pdEscape(stream.loaded)} / 共 ${pdEscape(stream.total)} 条</span>
      ${stream.hasMore ? `
        <span data-persona-mobile-post-sentinel>继续下滑加载</span>
        <button type="button" data-persona-mobile-post-load hidden>继续加载</button>
      ` : `<span>已全部加载</span>`}
    </div>
  `;
}

function pdDisconnectMobilePostStream() {
  personaDashboardMobilePostObserver?.disconnect();
  personaDashboardMobilePostObserver = null;
}

function pdBindPostRowActions(root, persona) {
  root?.querySelectorAll("[data-post-view]:not([data-post-action-bound])").forEach((node) => {
    node.dataset.postActionBound = "true";
    node.addEventListener("click", () => {
      personaDashboardPostModalKey = String(node.getAttribute("data-post-view") || "");
      personaDashboardGalleryIndex = -1;
      pdRenderDashboard();
    });
  });
  root?.querySelectorAll("[data-post-delete]:not([data-post-action-bound])").forEach((node) => {
    node.dataset.postActionBound = "true";
    node.addEventListener("click", () => {
      const postKey = String(node.getAttribute("data-post-delete") || "");
      if (persona && postKey) pdDeletePost(persona, postKey);
    });
  });
}

function pdLoadNextMobilePostBatch(persona) {
  if (!pdIsMobileTweetStreamMode() || personaDashboardMobilePostPending) return;
  const rows = pdFilteredPostRows(persona);
  const pageSize = Math.max(5, Math.min(100, Number(personaDashboardPageSize || 10)));
  const current = Math.min(rows.length, Math.max(pageSize, Number(personaDashboardMobilePostLimit || pageSize)));
  if (current >= rows.length) return;
  const triggerStreamKey = personaDashboardMobilePostKey;
  const triggerRoot = personaDashboardRoot;
  let committed = false;
  personaDashboardMobilePostPending = true;
  const status = pdEl("personaDashboardList")?.querySelector("[data-persona-mobile-post-sentinel]");
  if (status) {
    status.classList.add("is-loading");
    status.innerHTML = renderMobileTweetStreamLoadingIndicator();
  }
  lockMobileTweetStreamScroll();
  const startedAt = performance.now();
  pdDisconnectMobilePostStream();
  finishMobileTweetStreamLoading(startedAt, () => {
    if (
      !status?.isConnected
      || !status.getClientRects().length
      || triggerRoot !== personaDashboardRoot
      || triggerStreamKey !== personaDashboardMobilePostKey
      || !pdIsMobileTweetStreamMode()
    ) return;
    const next = Math.min(rows.length, current + pageSize);
    const body = pdEl("personaDashboardList")?.querySelector(".persona-post-table tbody");
    if (body) body.insertAdjacentHTML("beforeend", rows.slice(current, next).map(pdRenderPostTableRow).join(""));
    personaDashboardMobilePostLimit = next;
    const streamHost = pdEl("personaDashboardList")?.querySelector(".persona-mobile-post-stream");
    if (streamHost) {
      streamHost.outerHTML = pdRenderMobilePostStreamStatus({
        loaded: next,
        total: rows.length,
        hasMore: next < rows.length,
      });
    }
    pdBindPostRowActions(pdEl("personaDashboardList"), persona);
    committed = true;
  }, () => {
    personaDashboardMobilePostPending = false;
    if (committed) pdBindMobilePostStream(persona);
  });
}

function pdBindMobilePostStream(persona) {
  pdDisconnectMobilePostStream();
  if (!pdIsMobileTweetStreamMode() || !persona) return;
  const sentinel = pdEl("personaDashboardList")?.querySelector("[data-persona-mobile-post-sentinel]");
  if (!sentinel) return;
  if (!("IntersectionObserver" in window)) {
    const fallback = pdEl("personaDashboardList")?.querySelector("[data-persona-mobile-post-load]");
    if (fallback) {
      fallback.hidden = false;
      fallback.addEventListener("click", () => pdLoadNextMobilePostBatch(persona), { once: true });
    }
    return;
  }
  personaDashboardMobilePostObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) pdLoadNextMobilePostBatch(persona);
  }, MOBILE_TWEET_STREAM_OBSERVER_OPTIONS);
  personaDashboardMobilePostObserver.observe(sentinel);
}

function pdRenderPersonaCard(persona) {
  const hot = pdPersonaHot(persona);
  const counts = persona.counts || {};
  const rows = pdFilteredPostRows(persona);
  const pageSize = Math.max(5, Math.min(100, Number(personaDashboardPageSize || 10)));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  personaDashboardPostPage = Math.max(1, Math.min(pageCount, Number(personaDashboardPostPage || 1)));
  const start = (personaDashboardPostPage - 1) * pageSize;
  const mobileStream = pdMobilePostStreamInfo(persona, rows, pageSize);
  const mobile = pdIsMobileTweetStreamMode();
  const metrics = [
    ["帖子", counts.posts],
    ["发布", counts.published],
    ["互动", Number(hot.likes || 0) + Number(hot.comments || 0) + Number(hot.shares || 0) + Number(hot.reposts || 0)],
    ["主页浏览", hot.recent_views],
    ["逐帖浏览", hot.post_views],
  ];
  const visibleRows = mobile ? rows.slice(0, mobileStream.loaded) : rows.slice(start, start + pageSize);
  const postRows = visibleRows.map(pdRenderPostTableRow).join("");
  return `
    <article class="persona-detail-card">
      <div class="persona-detail-head">
        <div>
          <h3>${pdEscape(persona.name || "未命名人设")}</h3>
        </div>
        <div class="persona-score">
          <span>热度</span>
          <strong>${pdEscape(pdNumber(hot.hot_score))}</strong>
        </div>
      </div>
      ${pdPersonaWarnings(persona)}
      <div class="persona-detail-grid persona-detail-grid--compact">
        ${metrics.map((metric) => `<div><span>${pdEscape(metric[0])}</span><strong>${pdEscape(pdNumber(metric[1]))}</strong></div>`).join("")}
      </div>
      <div class="persona-table-wrap">
        <div class="persona-table-toolbar">
          <div class="persona-post-controls">
            <label>
              <span>内容</span>
              <select id="personaPostTypeFilter">
                <option value="all" ${personaDashboardPostTypeFilter === "all" ? "selected" : ""}>全部内容</option>
                <option value="text" ${personaDashboardPostTypeFilter === "text" ? "selected" : ""}>有文字</option>
                <option value="image" ${personaDashboardPostTypeFilter === "image" ? "selected" : ""}>有图片</option>
                <option value="video" ${personaDashboardPostTypeFilter === "video" ? "selected" : ""}>有视频</option>
                <option value="media" ${personaDashboardPostTypeFilter === "media" ? "selected" : ""}>有媒体</option>
              </select>
            </label>
            <label>
              <span>排序</span>
              <select id="personaPostSort">
                <option value="hot_desc" ${personaDashboardPostSort === "hot_desc" ? "selected" : ""}>热度最高</option>
                <option value="hot_asc" ${personaDashboardPostSort === "hot_asc" ? "selected" : ""}>热度最低</option>
                <option value="time_desc" ${personaDashboardPostSort === "time_desc" ? "selected" : ""}>发布时间最新</option>
                <option value="time_asc" ${personaDashboardPostSort === "time_asc" ? "selected" : ""}>发布时间最早</option>
                <option value="likes_desc" ${personaDashboardPostSort === "likes_desc" ? "selected" : ""}>点赞最多</option>
                <option value="comments_desc" ${personaDashboardPostSort === "comments_desc" ? "selected" : ""}>评论最多</option>
                <option value="reposts_desc" ${personaDashboardPostSort === "reposts_desc" ? "selected" : ""}>转发最多</option>
                <option value="shares_desc" ${personaDashboardPostSort === "shares_desc" ? "selected" : ""}>分享最多</option>
                <option value="views_desc" ${personaDashboardPostSort === "views_desc" ? "selected" : ""}>逐帖浏览最多</option>
              </select>
            </label>
          </div>
          <span>${mobile
            ? `已显示 ${pdEscape(String(mobileStream.loaded))} / 共 ${pdEscape(String(rows.length))} 条`
            : `第 ${pdEscape(String(personaDashboardPostPage))} / ${pdEscape(String(pageCount))} 页 · 共 ${pdEscape(String(rows.length))} 条`}</span>
        </div>
        <table class="persona-post-table">
          <thead><tr><th>平台</th><th>推文内容 / 来源</th><th>发布时间</th><th>点赞</th><th>评论</th><th>转发</th><th>分享</th><th>逐帖浏览</th><th>操作</th></tr></thead>
          <tbody>${postRows || `<tr class="persona-post-empty"><td colspan="9">暂无发送推文指标</td></tr>`}</tbody>
        </table>
      </div>
      ${mobile ? pdRenderMobilePostStreamStatus(mobileStream) : `<div class="persona-pager">
        <button class="ghost" type="button" id="personaPostPrev" ${personaDashboardPostPage <= 1 ? "disabled" : ""}>上一页</button>
        <span>每页 ${pdEscape(String(pageSize))} 条</span>
        <button class="ghost" type="button" id="personaPostNext" ${personaDashboardPostPage >= pageCount ? "disabled" : ""}>下一页</button>
      </div>`}
      ${pdRenderPostModal(persona)}
    </article>
  `;
}

function pdPersonaKey(persona, index = 0) {
  return String((persona && (persona.id || persona.name)) || `persona-${index}`);
}

function pdFindPostRow(persona, postKey) {
  const key = String(postKey || "");
  return (pdFilteredPostRows(persona) || []).find((row) => String(row.post_key || "") === key) || null;
}

function pdMediaType(item) {
  const text = `${(item && item.type) || ""} ${(item && item.url) || ""} ${(item && item.original_url) || ""}`.toLowerCase();
  if (/(video|mp4|mov|m4v|webm)/.test(text)) return "video";
  if (/(image|photo|png|jpe?g|webp|gif)/.test(text)) return "image";
  return "link";
}

function pdPostMediaItems(row) {
  return Array.isArray(row.media_items)
    ? row.media_items.filter((item) => item && (item.url || item.mediaUrl || item.media_url)).map((item) => {
      const rawUrl = String(item.url || item.mediaUrl || item.media_url || "").trim();
      const previewUrl = String(item.preview_url || item.previewUrl || "").trim();
      const rawLabel = String(item.label || "").trim();
      const genericLabel = /^(?:media|mediaurl|mediaitem|mediaitems|attachment|attachments)$/i.test(rawLabel);
      return {
        ...item,
        original_url: rawUrl,
        url: pdAdminWorkspaceUrl(previewUrl || (item.unavailable ? "" : rawUrl)),
        label: genericLabel ? "" : rawLabel,
      };
    })
    : [];
}

function pdPostComposition(row) {
  const media = pdPostMediaItems(row);
  const imageCount = media.filter((item) => pdMediaType(item) === "image").length;
  const videoCount = media.filter((item) => pdMediaType(item) === "video").length;
  const otherCount = Math.max(0, media.length - imageCount - videoCount);
  const hasText = Boolean(String(row.full_content || row.content || "").trim());
  return { hasText, imageCount, videoCount, otherCount, totalMedia: media.length };
}

function pdRenderPostContentBadges(row) {
  const parts = pdPostComposition(row);
  const badges = [];
  badges.push(`<span class="${parts.hasText ? "is-on" : "is-off"}">文字${parts.hasText ? "" : " 0"}</span>`);
  badges.push(`<span class="${parts.imageCount ? "is-on" : "is-off"}">图片 ${pdEscape(String(parts.imageCount))}</span>`);
  badges.push(`<span class="${parts.videoCount ? "is-on" : "is-off"}">视频 ${pdEscape(String(parts.videoCount))}</span>`);
  if (parts.otherCount) badges.push(`<span class="is-on">其他 ${pdEscape(String(parts.otherCount))}</span>`);
  return `<div class="persona-post-content-badges" aria-label="内容组成">${badges.join("")}</div>`;
}

function pdRenderPostMedia(row) {
  const items = pdPostMediaItems(row);
  if (!items.length) {
    return `<div class="persona-post-media-empty">暂无媒体文件</div>`;
  }
  return `
    <div class="persona-post-media-grid ${items.length === 1 ? "persona-post-media-grid-single" : ""}">
      ${items.map((item, index) => {
        const url = String(item.url || "");
        const type = pdMediaType(item);
        const label = item.label || `媒体 ${index + 1}`;
        if (item.unavailable || !url) {
          return `<div class="persona-post-media-empty persona-post-media-unavailable"><strong>${pdEscape(label)}</strong><span>${pdEscape(item.reason || "媒体预览暂不可用")}</span></div>`;
        }
        if (type === "image") {
          return `<button class="persona-post-media-item" type="button" data-post-media-index="${index}" aria-label="站内查看${pdEscape(label)}"><img src="${pdEscape(url)}" alt="${pdEscape(label)}" loading="lazy" /></button>`;
        }
        if (type === "video") {
          return `<button class="persona-post-media-item persona-post-media-video" type="button" data-post-media-index="${index}" aria-label="站内查看${pdEscape(label)}"><video src="${pdEscape(url)}" preload="metadata" muted playsinline></video><span>站内查看视频</span></button>`;
        }
        return `<button class="persona-post-media-link" type="button" data-post-media-index="${index}" aria-label="站内查看${pdEscape(label)}">${pdEscape(label || url)}</button>`;
      }).join("")}
    </div>
  `;
}

function pdRenderPostGallery(row) {
  const items = pdPostMediaItems(row);
  if (!items.length || personaDashboardGalleryIndex < 0) return "";
  const index = Math.max(0, Math.min(items.length - 1, Number(personaDashboardGalleryIndex) || 0));
  const item = items[index] || {};
  const url = String(item.url || "");
  const type = pdMediaType(item);
  const label = item.label || `媒体 ${index + 1}`;
  let body = `<div class="persona-post-gallery-fallback">${pdEscape(url || "暂无媒体地址")}</div>`;
  if (type === "image") {
    body = `<img src="${pdEscape(url)}" alt="${pdEscape(label)}" />`;
  } else if (type === "video") {
    body = `<video src="${pdEscape(url)}" controls autoplay playsinline preload="metadata"></video>`;
  }
  return `
    <div class="persona-post-gallery" role="dialog" aria-modal="true" aria-label="站内媒体相册">
      <div class="persona-post-gallery-card">
        <div class="persona-post-gallery-head">
          <div>
            <strong>媒体相册</strong>
            <span>${pdEscape(label)} · 第 ${pdEscape(String(index + 1))} / ${pdEscape(String(items.length))} 个</span>
          </div>
          <button class="ghost" type="button" id="personaPostGalleryClose">关闭相册</button>
        </div>
        <div class="persona-post-gallery-stage">
          ${body}
        </div>
        <div class="persona-post-gallery-actions">
          <button class="ghost" type="button" id="personaPostGalleryPrev" ${index <= 0 ? "disabled" : ""}>上一张</button>
          <div class="persona-post-gallery-dots">
            ${items.map((media, dotIndex) => `<button type="button" class="${dotIndex === index ? "is-active" : ""}" data-post-gallery-index="${dotIndex}" aria-label="查看第 ${dotIndex + 1} 个媒体">${dotIndex + 1}</button>`).join("")}
          </div>
          <button class="ghost" type="button" id="personaPostGalleryNext" ${index >= items.length - 1 ? "disabled" : ""}>下一张</button>
        </div>
      </div>
    </div>
  `;
}

function pdRenderPostInfo(row) {
  const items = [
    ["平台", row.platform || "-"],
    ["发布时间", pdDate(row.published_at)],
    ["采集时间", pdDate(row.captured_at)],
    ["原始链接", row.source_url || ""],
    ["帖子编号", row.id || row.code || row.pk || ""],
  ].filter((item) => String(item[1] || "").trim());
  return `
    <div class="persona-post-info-list">
      ${items.map(([label, value]) => `
        <div>
          <span>${pdEscape(label)}</span>
          ${label === "原始链接" && pdSafeLinkUrl(value) ? `<a href="${pdEscape(pdSafeLinkUrl(value))}" target="_blank" rel="noreferrer">${pdEscape(value)}</a>` : `<strong>${pdEscape(value)}</strong>`}
        </div>
      `).join("")}
    </div>
  `;
}

function pdRenderPostModal(persona) {
  const row = personaDashboardPostModalKey ? pdFindPostRow(persona, personaDashboardPostModalKey) : null;
  if (!row) return "";
  return `
    <div class="persona-post-modal" role="dialog" aria-modal="true" aria-label="推文详情">
      <div class="persona-post-modal-card">
        <div class="persona-post-modal-head">
          <div>
            <strong>推文详情</strong>
            <span>${pdEscape(row.platform || "-")} · ${pdEscape(row.published_at || row.captured_at || "无时间")}</span>
          </div>
          <button class="ghost" type="button" id="personaPostModalClose">关闭</button>
        </div>
        <div class="persona-post-modal-grid">
          <div><span>点赞</span><strong>${pdEscape(pdNumber(row.like_count))}</strong></div>
          <div><span>评论</span><strong>${pdEscape(pdNumber(row.comment_count))}</strong></div>
          <div><span>转发</span><strong>${pdEscape(pdNumber(row.repost_count))}</strong></div>
          <div><span>分享</span><strong>${pdEscape(pdNumber(row.share_count))}</strong></div>
          <div><span>逐帖浏览</span><strong>${pdEscape(pdNumber(row.view_count))}</strong></div>
        </div>
        <section class="persona-post-section">
          <h4>内容组成</h4>
          ${pdRenderPostContentBadges(row)}
        </section>
        <section class="persona-post-section">
          <h4>完整推文内容</h4>
          <div class="persona-post-full-content">${pdEscape(row.full_content || row.content || "暂无内容")}</div>
        </section>
        <section class="persona-post-section">
          <h4>媒体文件</h4>
          ${pdRenderPostMedia(row)}
        </section>
        <section class="persona-post-section">
          <h4>相关信息</h4>
          ${pdRenderPostInfo(row)}
        </section>
        ${pdRenderPostGallery(row)}
      </div>
    </div>
  `;
}

function pdRenderPersonaTabs(visiblePersonas, selectedPersona) {
  const tabs = pdEl("personaDashboardTabs");
  if (!tabs) return;
  const selectedLabel = selectedPersona?.name
    || (personaDashboardSelectedId === "__settings__" ? "显示设置" : "总览首页");
  tabs.innerHTML = `
    <button id="personaDashboardPickerTrigger" class="persona-dashboard-picker-trigger" type="button" aria-haspopup="dialog">
      <span><small>人设数据 · ${pdEscape(String(visiblePersonas.length))} 人设</small><strong>${pdEscape(selectedLabel)}</strong></span>
      <span class="persona-dashboard-picker-action">查看
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
      </span>
    </button>
  `;
  pdEl("personaDashboardPickerTrigger")?.addEventListener("click", () => {
    pdOpenPersonaDashboardPicker(visiblePersonas, selectedPersona);
  });
}

function pdOpenPersonaDashboardPicker(visiblePersonas, selectedPersona) {
  if (typeof openConsoleModal !== "function") return;
  const overview = {
    id: "__overview__",
    index: "总",
    title: "总览首页",
    meta: "全部人设数据",
  };
  const personas = visiblePersonas.map((persona, index) => {
    const handle = String(persona.threads_account?.handle || "").trim();
    return {
      id: pdPersonaKey(persona, index),
      index: String(index + 1),
      title: persona.name || "未命名人设",
      meta: handle ? `Threads · ${handle}` : "账号未绑定",
      accountBound: Boolean(handle),
    };
  });
  const settings = {
    id: "__settings__",
    index: "设",
    title: "显示设置",
    meta: "推文分页数量",
  };
  const renderOption = (option, type) => {
    const active = String(option.id) === String(personaDashboardSelectedId);
    return `
      <button
        class="persona-dashboard-picker-option persona-dashboard-picker-option--${type} ${active ? "is-active" : ""} ${option.accountBound === false ? "is-account-unbound" : option.accountBound === true ? "is-account-bound" : ""}"
        type="button"
        data-dashboard-persona-picker="${pdEscape(option.id)}"
        aria-pressed="${active ? "true" : "false"}"
      >
        <span class="persona-dashboard-picker-index">${pdEscape(option.index)}</span>
        <span class="persona-dashboard-picker-copy"><strong>${pdEscape(option.title)}</strong><span>${pdEscape(option.meta)}</span></span>
      </button>
    `;
  };
  void openConsoleModal({
    title: "查看人设数据",
    message: "选择需要查看的人设或总览数据。",
    contentHtml: `
      <div class="persona-dashboard-picker-modal">
        <div class="persona-dashboard-picker-tabs" role="list">
          <section class="persona-dashboard-picker-section persona-dashboard-picker-section--overview" aria-label="总览">
            <div class="persona-dashboard-picker-section-label"><span>总览数据</span></div>
            ${renderOption(overview, "overview")}
          </section>
          <section class="persona-dashboard-picker-section persona-dashboard-picker-section--personas" aria-label="人设列表">
            <div class="persona-dashboard-picker-section-label"><span>普通人设</span><small>${pdEscape(String(personas.length))} 个</small></div>
            <div class="persona-dashboard-picker-personas">
              ${personas.map((persona) => renderOption(persona, "persona")).join("")}
            </div>
          </section>
          <section class="persona-dashboard-picker-section persona-dashboard-picker-section--settings" aria-label="设置">
            <div class="persona-dashboard-picker-section-label"><span>显示设置</span></div>
            ${renderOption(settings, "settings")}
          </section>
        </div>
      </div>
    `,
    showCancel: false,
    showConfirm: false,
    modalKey: "persona-dashboard-picker",
  });
  const modal = document.querySelector('.console-modal[data-modal-key="persona-dashboard-picker"]');
  if (!modal) return;
  modal.querySelectorAll("[data-dashboard-persona-picker]").forEach((node) => {
    node.addEventListener("click", () => {
      const nextPersonaId = String(node.getAttribute("data-dashboard-persona-picker") || "");
      personaDashboardSelectedId = nextPersonaId;
      personaDashboardPostPage = 1;
      if (typeof closeConsoleModal === "function") closeConsoleModal(null, modal);
      else modal.remove();
      pdRenderDashboard();
    });
  });
}

function pdRenderSettings() {
  const settings = pdEl("personaDashboardSettings");
  if (!settings) return;
  settings.innerHTML = `
    <div class="persona-settings-card">
      <div>
        <h3>设置</h3>
        <div class="small">这里只保留看板本身的显示设置；全量刷新统一使用页面右上角入口。</div>
      </div>
      <label for="personaPageSizeInput">每页推文数量</label>
      <div class="persona-settings-row">
        <input id="personaPageSizeInput" type="number" min="5" max="100" step="5" value="${pdEscape(String(personaDashboardPageSize))}" />
      </div>
      <div class="small">可设置 5 到 100 条，修改后会立即生效。</div>
    </div>
  `;
  const input = pdEl("personaPageSizeInput");
  if (input) {
    const applyPageSize = () => {
      const next = Math.max(5, Math.min(100, Number(input.value) || 10));
      if (Number(input.value) !== next) input.value = String(next);
      if (personaDashboardPageSize === next) return;
      personaDashboardPageSize = next;
      personaDashboardPostPage = 1;
      localStorage.setItem("personaDashboardPageSize", String(next));
      pdRenderDashboard();
    };
    input.addEventListener("change", applyPageSize);
    input.addEventListener("blur", applyPageSize);
  }
}

function pdApplyInitialPersonaSelection(visible) {
  if (personaDashboardInitialPersonaApplied || !personaDashboardInitialPersonaId || !Array.isArray(visible) || !visible.length) return;
  const index = visible.findIndex((persona, itemIndex) => {
    const key = pdPersonaKey(persona, itemIndex);
    return String(persona.id || "") === personaDashboardInitialPersonaId || String(key) === personaDashboardInitialPersonaId;
  });
  if (index < 0) {
    personaDashboardInitialPersonaApplied = true;
    return;
  }
  personaDashboardSelectedId = pdPersonaKey(visible[index], index);
  personaDashboardTabPage = Math.floor(index / 10) + 1;
  personaDashboardInitialPersonaApplied = true;
}

function pdRenderDashboard() {
  const data = personaDashboardData;
  const list = pdEl("personaDashboardList");
  const empty = pdEl("personaDashboardEmpty");
  const meta = pdEl("personaDashboardMeta");
  const overview = pdEl("personaOverviewPane");
  const settings = pdEl("personaDashboardSettings");
  if (!data || !list || !empty) return;
  pdRenderDashboardPlatformTabs(data);
  const visible = (data.personas || []).filter(pdMatches);
  pdApplyInitialPersonaSelection(visible);
  let selected = visible.find((persona, index) => pdPersonaKey(persona, index) === String(personaDashboardSelectedId || ""));
  if (!["__overview__", "__settings__"].includes(personaDashboardSelectedId) && !selected && visible.length) {
    selected = visible[0];
    personaDashboardSelectedId = pdPersonaKey(selected, 0);
  }
  const charts = pdBuildFilteredCharts(visible, data);
  pdRenderSummary(data, visible);
  pdRenderBarChart("personaHotRankChart", visible.map((item) => ({ label: item.name, value: pdPersonaHot(item).hot_score })));
  pdRenderDonutChart("personaPlatformChart", charts.platform_distribution);
  pdRenderDonutChart("personaCoverageChart", charts.hot_coverage);
  pdRenderTrendChart("personaTrendChart", charts.trend);
  pdRenderDonutChart("personaEngagementChart", charts.engagement_mix);
  pdRenderDonutChart("personaTaskStatusChart", charts.task_status_distribution);
  pdRenderPersonaTabs(visible, selected);
  pdRenderSettings();
  const mode = personaDashboardSelectedId;
  if (overview) overview.style.display = mode === "__overview__" ? "grid" : "none";
  if (settings) settings.style.display = mode === "__settings__" ? "grid" : "none";
  list.style.display = selected && mode !== "__overview__" && mode !== "__settings__" ? "grid" : "none";
  if (meta) meta.textContent = selected ? `当前显示 ${visible.length} / ${(data.personas || []).length} 个人设 · 已选：${selected.name || "未命名人设"}` : `当前显示 ${visible.length} / ${(data.personas || []).length} 个人设`;
  empty.style.display = visible.length ? "none" : "block";
  list.innerHTML = selected ? pdRenderPersonaCard(selected) : "";
  const prev = pdEl("personaPostPrev");
  const next = pdEl("personaPostNext");
  const modalClose = pdEl("personaPostModalClose");
  const postSort = pdEl("personaPostSort");
  const postTypeFilter = pdEl("personaPostTypeFilter");
  if (prev) prev.addEventListener("click", () => { personaDashboardPostPage -= 1; pdRenderDashboard(); });
  if (next) next.addEventListener("click", () => { personaDashboardPostPage += 1; pdRenderDashboard(); });
  if (postSort) {
    postSort.addEventListener("change", () => {
      personaDashboardPostSort = String(postSort.value || "hot_desc");
      localStorage.setItem("personaDashboardPostSort", personaDashboardPostSort);
      personaDashboardPostPage = 1;
      pdRenderDashboard();
    });
  }
  if (postTypeFilter) {
    postTypeFilter.addEventListener("change", () => {
      personaDashboardPostTypeFilter = String(postTypeFilter.value || "all");
      localStorage.setItem("personaDashboardPostTypeFilter", personaDashboardPostTypeFilter);
      personaDashboardPostPage = 1;
      pdRenderDashboard();
    });
  }
  if (modalClose) modalClose.addEventListener("click", () => {
    personaDashboardPostModalKey = "";
    personaDashboardGalleryIndex = -1;
    pdRenderDashboard();
  });
  pdBindPostRowActions(list, selected);
  pdBindMobilePostStream(selected);
  list.querySelectorAll("[data-post-media-index]").forEach((node) => {
    node.addEventListener("click", () => {
      personaDashboardGalleryIndex = Number(node.getAttribute("data-post-media-index") || 0);
      pdRenderDashboard();
    });
  });
  const galleryClose = pdEl("personaPostGalleryClose");
  const galleryPrev = pdEl("personaPostGalleryPrev");
  const galleryNext = pdEl("personaPostGalleryNext");
  if (galleryClose) galleryClose.addEventListener("click", () => { personaDashboardGalleryIndex = -1; pdRenderDashboard(); });
  if (galleryPrev) galleryPrev.addEventListener("click", () => { personaDashboardGalleryIndex -= 1; pdRenderDashboard(); });
  if (galleryNext) galleryNext.addEventListener("click", () => { personaDashboardGalleryIndex += 1; pdRenderDashboard(); });
  list.querySelectorAll("[data-post-gallery-index]").forEach((node) => {
    node.addEventListener("click", () => {
      personaDashboardGalleryIndex = Number(node.getAttribute("data-post-gallery-index") || 0);
      pdRenderDashboard();
    });
  });
}

function pdSetMsg(text, type = "ok") {
  const msg = pdEl("personaDashboardMsg");
  if (!msg) return;
  msg.textContent = text || "";
  msg.className = text ? `msg ${type}` : "msg";
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

async function pdDeletePost(persona, postKey) {
  const ok = await pdConfirm("确认删除这条推文记录？删除后会立即从当前看板缓存中移除。", { title: "删除推文记录", confirmText: "删除", tone: "danger" });
  if (!ok) return;
  try {
    pdSetMsg("正在删除推文记录...", "ok");
    await pdApi(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts/${encodeURIComponent(postKey)}`, {
      method: "DELETE",
    });
    personaDashboardPostModalKey = "";
    pdSetMsg("推文记录已删除，正在刷新看板...", "ok");
    await pdLoadDashboard();
  } catch (err) {
    pdSetMsg(String((err && (err.detail || err.message)) || err || "删除推文失败"), "err");
  }
}

async function pdStartRefresh(archiveId, message) {
  try {
    pdSetMsg(message || (archiveId ? "已请求刷新当前人设..." : "已请求全量刷新..."), "ok");
    const task = await pdApi("/api/persona_dashboard/refresh", {
      method: "POST",
      body: { archive_id: archiveId || "" },
    });
    personaDashboardRefreshTask = task.id;
    pdPollRefresh(task.id);
  } catch (err) {
    pdSetMsg(String((err && (err.detail || err.message)) || err || "启动刷新失败"), "err");
  }
}

async function pdPollRefresh(taskId) {
  if (!taskId || taskId !== personaDashboardRefreshTask) return;
  try {
    const task = await pdApi(`/api/persona_dashboard/refresh/${encodeURIComponent(taskId)}`);
    const status = pdLabel(task.status);
    const progress = Number(task.progress || 0);
    const step = task.step ? `步骤：${task.step} · ` : "";
    const elapsed = task.elapsed_seconds ? ` · 已执行 ${task.elapsed_seconds} 秒` : "";
    pdSetMsg(`刷新任务：${status} · ${step}进度 ${progress}%${elapsed}。${task.message || ""}`, task.status === "failed" ? "err" : "ok");
    if (["queued", "running"].includes(String(task.status))) {
      window.setTimeout(() => pdPollRefresh(taskId), 2500);
      return;
    }
    personaDashboardRefreshTask = "";
    await pdLoadDashboard();
    if (task.status === "failed") {
      pdSetMsg(`刷新失败：${task.message || "请检查浏览器授权或账号绑定。"}`, "err");
    } else {
      pdSetMsg("刷新完成，数据已重新读取。", "ok");
    }
  } catch (err) {
    personaDashboardRefreshTask = "";
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
  const refresh = pdEl("btnPersonaDashboardRefresh");
  const refreshAll = pdEl("btnPersonaDashboardRefreshAll");
  if (refresh) refresh.addEventListener("click", () => pdLoadDashboard());
  if (refreshAll) refreshAll.addEventListener("click", () => pdStartRefresh(""));
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
  pdDisconnectMobilePostStream();
  personaDashboardMobilePostPending = false;
  cancelMobileTweetStreamLoading();
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
