let personaDashboardRoot = null;
let personaDashboardBoundRoot = null;
const PD_ADMIN_WORKSPACE_USER_ID = String(document.querySelector('meta[name="admin-workspace-user-id"]')?.content || "").trim();
const PD_ADMIN_CONSOLE_SESSION = document.querySelector('meta[name="admin-console-session"]')?.content === "1";

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

let personaDashboardData = null;
let personaDashboardSelectedId = "__overview__";
let personaDashboardPostPage = 1;
let personaDashboardPageSize = Number(localStorage.getItem("personaDashboardPageSize") || 10) || 10;
let personaDashboardRefreshTask = "";
let personaDashboardPlatform = "";
let personaDashboardTabPage = 1;
let personaDashboardPostModalKey = "";
let personaDashboardGalleryIndex = -1;
let personaDashboardAutoPollTimer = 0;
let personaDashboardPostSort = localStorage.getItem("personaDashboardPostSort") || "hot_desc";
let personaDashboardPostTypeFilter = localStorage.getItem("personaDashboardPostTypeFilter") || "all";
const personaDashboardInitialParams = new URLSearchParams(window.location.search || "");
const personaDashboardInitialPersonaId = String(personaDashboardInitialParams.get("persona_id") || personaDashboardInitialParams.get("persona") || "").trim();
let personaDashboardInitialPersonaApplied = false;

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

function pdNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(Math.round(n));
}

function pdDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  }
  const text = String(value || "").trim();
  if (!text) return "-";
  if (/^\d{13}$/.test(text)) {
    const date = new Date(Number(text));
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  }
  if (/^\d{10}$/.test(text)) {
    const date = new Date(Number(text) * 1000);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  }
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date.toLocaleString();
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
  host.innerHTML = platforms.map((platform) => `
    <button
      class="account-pool-platform-tab ${personaDashboardPlatform === platform ? "is-active" : ""}"
      type="button"
      role="tab"
      aria-selected="${personaDashboardPlatform === platform ? "true" : "false"}"
      data-persona-dashboard-platform="${pdEscape(platform)}"
    >
      ${pdPlatformIcon(platform)}
      <span>${pdEscape(pdPlatformLabel(platform))}</span>
    </button>
  `).join("");
  host.querySelectorAll("[data-persona-dashboard-platform]").forEach((node) => {
    node.addEventListener("click", () => {
      personaDashboardPlatform = String(node.getAttribute("data-persona-dashboard-platform") || "");
      personaDashboardPostPage = 1;
      personaDashboardTabPage = 1;
      pdRenderDashboard();
    });
  });
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
  if (sort.startsWith("shares_")) return Number(row.share_count || row.repost_count || 0);
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
    shares_desc: "转发/分享最多",
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

function pdCurrentPostFilterText() {
  const platform = pdPlatformFilter();
  return `平台：${pdPlatformLabel(platform)} · 内容：${pdPostTypeLabel(personaDashboardPostTypeFilter)} · 排序：${pdPostSortLabel(personaDashboardPostSort)}`;
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
  const platformDistribution = {};
  const engagement = { likes: 0, comments: 0, shares: 0, reposts: 0 };
  const taskStatus = {};
  const coverage = { complete: 0, partial_or_unknown: 0, none: 0 };

  visiblePersonas.forEach((persona) => {
    const hot = pdPersonaHot(persona);
    Object.keys(engagement).forEach((key) => { engagement[key] += Number(hot[key] || 0); });
    (persona.hot_platforms || []).forEach((item) => {
      const platform = String(item.platform || "").trim();
      if (pdIsWebVisiblePlatform(platform)) platformDistribution[platform] = (platformDistribution[platform] || 0) + 1;
    });
    Object.keys((persona.counts && persona.counts.platform_posts) || {}).forEach((platform) => {
      const count = Number(persona.counts.platform_posts[platform] || 0);
      if (count > 0 && pdIsWebVisiblePlatform(platform)) platformDistribution[platform] = (platformDistribution[platform] || 0) + count;
    });
    const platforms = (persona.hot_platforms || []).filter((item) => pdIsWebVisiblePlatform(item.platform));
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
    trend: pdFilterTrend(data.charts && data.charts.trend),
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
  const items = (rows || []).filter((row) => Number(row.value || 0) > 0).slice(0, 12);
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

function pdMatches(persona) {
  const platform = pdPlatformFilter();
  if (platform) {
    const platforms = (persona.hot_platforms || [])
      .map((item) => String(item.platform || "").toLowerCase())
      .filter((item) => pdIsWebVisiblePlatform(item));
    const platformPosts = Object.keys((persona.counts && persona.counts.platform_posts) || {})
      .map((item) => item.toLowerCase())
      .filter((item) => pdIsWebVisiblePlatform(item));
    if (!platforms.includes(platform) && !platformPosts.includes(platform)) return false;
  }
  return true;
}

function pdRenderSummary(data, visiblePersonas) {
  const host = pdEl("personaDashboardSummary");
  if (!host) return;
  const globalSummary = data.summary || {};
  const summary = pdVisibleSummary(visiblePersonas);
  const cards = [
    { label: "人设总数", value: summary.persona_count, hint: `全部 ${globalSummary.persona_count || 0}` },
    { label: "已生成帖子", value: summary.post_count, hint: "当前筛选归档帖子" },
    { label: "已发布", value: summary.published_count, hint: "当前筛选发布记录" },
    { label: "总互动量", value: summary.total_interactions, hint: "点赞、评论、转发、分享" },
    { label: "账号主页浏览", value: summary.recent_views, hint: "账号主页级浏览" },
    { label: "逐帖浏览合计", value: summary.post_views, hint: "逐帖浏览，不与主页浏览合并" },
    { label: "筛选热度", value: summary.hot_score, hint: "逐帖浏览 + 点赞 + 评论 + 分享 + 转发" },
  ];
  host.innerHTML = cards.map((card) => `
    <div class="kpi persona-kpi" title="${pdEscape(card.hint)}">
      <div class="label">${pdEscape(card.label)}</div>
      <div class="num">${pdEscape(pdNumber(card.value))}</div>
    </div>
  `).join("");
}

function pdPersonaWarnings(persona) {
  const warnings = persona.warnings || [];
  if (!warnings.length) return "";
  return `
    <div class="persona-warning-list">
      ${warnings.map((item) => `<div class="persona-warning-item">${pdEscape(item)}</div>`).join("")}
    </div>
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

function pdRenderPersonaCard(persona) {
  const hot = pdPersonaHot(persona);
  const counts = persona.counts || {};
  const rows = pdFilteredPostRows(persona);
  const pageSize = Math.max(5, Math.min(100, Number(personaDashboardPageSize || 10)));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  personaDashboardPostPage = Math.max(1, Math.min(pageCount, Number(personaDashboardPostPage || 1)));
  const start = (personaDashboardPostPage - 1) * pageSize;
  const platforms = (persona.hot_platforms || []).filter((item) => pdIsWebVisiblePlatform(item.platform)).map((item) => `
    <div class="persona-platform-row">
      <strong>${pdEscape(item.platform || "-")}</strong>
      <span>账号主页浏览 ${pdEscape(pdNumber(item.recent_views))}</span>
      <span>逐帖浏览 ${pdEscape(pdNumber(item.post_views))}</span>
      <span>赞 ${pdEscape(pdNumber(item.likes))}</span>
      <span>评 ${pdEscape(pdNumber(item.comments))}</span>
      <span>${item.complete ? "完整" : "部分/未知"}</span>
    </div>
  `).join("");
  const postRows = rows.slice(start, start + pageSize).map((row) => `
    <tr>
      <td class="persona-post-platform">${pdEscape(row.platform || "-")}</td>
      <td class="persona-post-source">
        <div>${pdEscape(String(row.content || row.source_url || "-").slice(0, 120))}</div>
        ${pdRenderPostContentBadges(row)}
      </td>
      <td class="persona-post-time">${pdEscape(pdDate(row.published_at || row.captured_at))}</td>
      <td class="persona-post-number">${pdEscape(pdNumber(row.like_count))}</td>
      <td class="persona-post-number">${pdEscape(pdNumber(row.comment_count))}</td>
      <td class="persona-post-number">${pdEscape(pdNumber(row.share_count || row.repost_count))}</td>
      <td class="persona-post-number">${pdEscape(pdNumber(row.view_count))}</td>
      <td class="persona-post-actions">
        <button class="ghost" type="button" data-post-view="${pdEscape(row.post_key || "")}">查看</button>
        <button class="ghost persona-post-delete persona-selection-icon-button" type="button" data-post-delete="${pdEscape(row.post_key || "")}" title="删除" aria-label="删除">${renderTrashIcon()}</button>
      </td>
    </tr>
  `).join("");
  return `
    <article class="persona-detail-card">
      <div class="persona-detail-head">
        <div>
          <h3>${pdEscape(persona.name || "未命名人设")}</h3>
        </div>
        <div class="persona-score">
          <span>热度</span>
          <strong>${pdEscape(pdNumber(hot.hot_score))}</strong>
          <small>${pdEscape(persona.hot_score_formula || "热度 = 逐帖浏览 + 点赞 + 评论 + 分享 + 转发")}</small>
        </div>
      </div>
      ${pdPersonaWarnings(persona)}
      <div class="persona-detail-grid">
        <div><span>帖子</span><strong>${pdEscape(pdNumber(counts.posts))}</strong></div>
        <div><span>发布</span><strong>${pdEscape(pdNumber(counts.published))}</strong></div>
        <div><span>互动</span><strong>${pdEscape(pdNumber(Number(hot.likes || 0) + Number(hot.comments || 0) + Number(hot.shares || 0) + Number(hot.reposts || 0)))}</strong></div>
        <div><span>账号主页浏览</span><strong>${pdEscape(pdNumber(hot.recent_views))}</strong></div>
        <div><span>逐帖浏览</span><strong>${pdEscape(pdNumber(hot.post_views))}</strong></div>
      </div>
      <div class="persona-content-preview">${pdEscape(persona.content || "暂无人设描述")}</div>
      <div class="persona-platform-list">${platforms || `<div class="small">暂无平台热点指标</div>`}</div>
      <div class="persona-table-wrap">
        <div class="persona-table-toolbar">
          <div class="persona-table-title">
            <strong>发送推文指标</strong>
            <span>${pdEscape(pdCurrentPostFilterText())}</span>
          </div>
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
                <option value="shares_desc" ${personaDashboardPostSort === "shares_desc" ? "selected" : ""}>转发/分享最多</option>
                <option value="views_desc" ${personaDashboardPostSort === "views_desc" ? "selected" : ""}>逐帖浏览最多</option>
              </select>
            </label>
          </div>
          <span>第 ${pdEscape(String(personaDashboardPostPage))} / ${pdEscape(String(pageCount))} 页 · 共 ${pdEscape(String(rows.length))} 条</span>
        </div>
        <table class="persona-post-table">
          <thead><tr><th>平台</th><th>推文内容 / 来源</th><th>发布时间</th><th>点赞</th><th>评论</th><th>转发/分享</th><th>逐帖浏览</th><th>操作</th></tr></thead>
          <tbody>${postRows || `<tr><td colspan="8">暂无发送推文指标</td></tr>`}</tbody>
        </table>
      </div>
      <div class="persona-pager">
        <button class="ghost" type="button" id="personaPostPrev" ${personaDashboardPostPage <= 1 ? "disabled" : ""}>上一页</button>
        <span>每页 ${pdEscape(String(pageSize))} 条</span>
        <button class="ghost" type="button" id="personaPostNext" ${personaDashboardPostPage >= pageCount ? "disabled" : ""}>下一页</button>
      </div>
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
  const text = `${(item && item.type) || ""} ${(item && item.url) || ""}`.toLowerCase();
  if (/(video|mp4|mov|m4v|webm)/.test(text)) return "video";
  if (/(image|photo|png|jpe?g|webp|gif)/.test(text)) return "image";
  return "link";
}

function pdPostMediaItems(row) {
  return Array.isArray(row.media_items)
    ? row.media_items.filter((item) => item && item.url).map((item) => ({ ...item, url: pdAdminWorkspaceUrl(item.url) }))
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
          <div><span>转发/分享</span><strong>${pdEscape(pdNumber(row.share_count || row.repost_count))}</strong></div>
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
  const tabPageSize = 10;
  const tabPageCount = Math.max(1, Math.ceil(visiblePersonas.length / tabPageSize));
  personaDashboardTabPage = Math.max(1, Math.min(tabPageCount, Number(personaDashboardTabPage || 1)));
  const tabStart = (personaDashboardTabPage - 1) * tabPageSize;
  const tabPersonas = visiblePersonas.slice(tabStart, tabStart + tabPageSize);
  tabs.innerHTML = `
    <div class="persona-tab-rail-head">
      <strong>人设</strong>
      <span>${pdEscape(String(visiblePersonas.length))} 人设</span>
    </div>
    <div class="persona-tab-list">
      <div class="persona-tab-section persona-tab-section-system">
      <button class="persona-tab ${personaDashboardSelectedId === "__overview__" ? "is-active" : ""}" type="button" data-persona-id="__overview__">
        <span class="persona-tab-index">总</span>
        <span class="persona-tab-main"><strong>总览</strong><span>全部人设数据</span></span>
      </button>
      </div>
      <div class="persona-tab-section persona-tab-section-personas">
      ${tabPersonas.map((persona, pageIndex) => {
        const index = tabStart + pageIndex;
        const key = pdPersonaKey(persona, index);
        const active = selectedPersona && pdPersonaKey(selectedPersona, index) === key;
        const handle = String(persona.threads_account && persona.threads_account.handle || "").trim();
        return `
          <button class="persona-tab ${active ? "is-active" : ""}" type="button" data-persona-id="${pdEscape(key)}">
            <span class="persona-tab-index">${index + 1}</span>
            <span class="persona-tab-main">
              <strong>${pdEscape(persona.name || "未命名人设")}</strong>
              <span>${pdEscape(handle ? `Threads · ${handle}` : "未绑定账号")}</span>
            </span>
          </button>
        `;
      }).join("")}
      ${visiblePersonas.length > tabPageSize ? `
        <div class="persona-tab-pager">
          <button class="ghost" type="button" id="personaTabPrev" ${personaDashboardTabPage <= 1 ? "disabled" : ""}>上一页</button>
          <span>第 ${pdEscape(String(personaDashboardTabPage))} / ${pdEscape(String(tabPageCount))} 页</span>
          <button class="ghost" type="button" id="personaTabNext" ${personaDashboardTabPage >= tabPageCount ? "disabled" : ""}>下一页</button>
        </div>
      ` : ""}
      </div>
      <div class="persona-tab-section persona-tab-section-system persona-tab-section-bottom">
      <button class="persona-tab persona-tab-settings ${personaDashboardSelectedId === "__settings__" ? "is-active" : ""}" type="button" data-persona-id="__settings__">
        <span class="persona-tab-index">设</span>
        <span class="persona-tab-main"><strong>显示设置</strong><span>推文分页数量</span></span>
      </button>
      </div>
    </div>
  `;
  tabs.querySelectorAll("[data-persona-id]").forEach((node) => {
    node.addEventListener("click", () => {
      const nextPersonaId = String(node.getAttribute("data-persona-id") || "");
      personaDashboardSelectedId = nextPersonaId;
      personaDashboardPostPage = 1;
      pdRenderDashboard();
    });
  });
  const tabPrev = pdEl("personaTabPrev");
  const tabNext = pdEl("personaTabNext");
  if (tabPrev) tabPrev.addEventListener("click", () => { personaDashboardTabPage -= 1; pdRenderDashboard(); });
  if (tabNext) tabNext.addEventListener("click", () => { personaDashboardTabPage += 1; pdRenderDashboard(); });
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
  pdRenderBarChart("personaHotRankChart", visible.map((item) => ({ label: item.name, value: item.hot && item.hot.hot_score })));
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
  list.querySelectorAll("[data-post-view]").forEach((node) => {
    node.addEventListener("click", () => {
      personaDashboardPostModalKey = String(node.getAttribute("data-post-view") || "");
      personaDashboardGalleryIndex = -1;
      pdRenderDashboard();
    });
  });
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
  list.querySelectorAll("[data-post-delete]").forEach((node) => {
    node.addEventListener("click", () => {
      const postKey = String(node.getAttribute("data-post-delete") || "");
      if (selected && postKey) pdDeletePost(selected, postKey);
    });
  });
}

function pdSetMsg(text, type = "ok") {
  const msg = pdEl("personaDashboardMsg");
  if (!msg) return;
  msg.textContent = text || "";
  msg.className = text ? `msg ${type}` : "msg";
}

async function pdLoadDashboard(options = {}) {
  const silent = Boolean(options && options.silent);
  if (!silent) pdSetMsg("正在加载人设数据...", "ok");
  try {
    const data = await pdApi("/api/persona_dashboard/overview");
    personaDashboardData = data;
    const updated = pdEl("personaDashboardUpdated");
    if (updated) {
      const latest = data.summary && data.summary.latest_data_at;
      updated.textContent = `缓存读取：${pdDate(data.updated_at)} · 最近数据：${pdDate(latest)}`;
    }
    if (!silent) pdSetMsg("");
    pdRenderDashboard();
  } catch (err) {
    if (!silent) pdSetMsg(String((err && (err.detail || err.message)) || err || "加载失败"), "err");
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
  const refresh = pdEl("btnPersonaDashboardRefresh");
  const refreshAll = pdEl("btnPersonaDashboardRefreshAll");
  if (refresh) refresh.addEventListener("click", () => pdLoadDashboard());
  if (refreshAll) refreshAll.addEventListener("click", () => pdStartRefresh(""));
}

function pdMountDashboard(root) {
  if (!root) return;
  personaDashboardRoot = root;
  pdBindDashboard(root);
  pdLoadDashboard();
  pdStartAutoPoll();
}

function pdUnmountDashboard() {
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
