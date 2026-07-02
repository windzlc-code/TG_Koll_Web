function pdEl(id) {
  return document.getElementById(id);
}

async function pdApi(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
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

let personaDashboardData = null;
let personaDashboardSelectedId = "__overview__";
let personaDashboardPostPage = 1;
let personaDashboardPageSize = Number(localStorage.getItem("personaDashboardPageSize") || 10) || 10;
let personaDashboardRefreshTask = "";
let personaDashboardAccountPlatform = localStorage.getItem("personaDashboardAccountPlatform") || "threads";
let personaDashboardTabPage = 1;
let personaDashboardPostModalKey = "";
let personaDashboardGalleryIndex = -1;
let personaDashboardAutoPollTimer = 0;
let personaDashboardPostSort = localStorage.getItem("personaDashboardPostSort") || "hot_desc";
let personaDashboardPostTypeFilter = localStorage.getItem("personaDashboardPostTypeFilter") || "all";
let personaDashboardAutomation = { accounts: [], proxies: [], tasks: [], summary: {}, worker: {} };
let personaDashboardAutomationPane = localStorage.getItem("personaDashboardAutomationPane") || "tasks";
let personaDashboardAutomationLogTaskId = "";
let personaDashboardAutomationLogData = null;
let personaDashboardAutomationLogTimer = 0;
let personaDashboardAutomationGalleryIndex = -1;
let personaDashboardVisiblePasswordAccountId = "";
let personaDashboardSelectedAutomationAccountId = "";
let personaDashboardPasswordDrafts = {};
let personaDashboardPasswordDirtyAccountIds = {};
const PERSONA_DASHBOARD_SAVED_PASSWORD_MASK = "********";

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

function pdRangeDays() {
  const range = String((pdEl("personaDashboardRange") && pdEl("personaDashboardRange").value) || "all").trim();
  const days = Number(range || 0);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

function pdDateInRange(value) {
  const days = pdRangeDays();
  if (!days) return true;
  const ts = new Date(value || 0).getTime();
  if (!Number.isFinite(ts)) return false;
  return ts >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function pdPlatformFilter() {
  return String((pdEl("personaDashboardPlatform") && pdEl("personaDashboardPlatform").value) || "").trim().toLowerCase();
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
  const range = String((pdEl("personaDashboardRange") && pdEl("personaDashboardRange").value) || "all");
  const rangeLabel = range === "all" || !range ? "全部时间" : `最近 ${range} 天`;
  return `平台：${platform || "全部"} · 时间：${rangeLabel} · 内容：${pdPostTypeLabel(personaDashboardPostTypeFilter)} · 排序：${pdPostSortLabel(personaDashboardPostSort)}`;
}

function pdFilterTrend(rows) {
  return (rows || []).filter((row) => pdDateInRange(row.date));
}

function pdFilteredPostRows(persona) {
  const platform = pdPlatformFilter();
  const sort = String(personaDashboardPostSort || "hot_desc");
  const dir = sort.endsWith("_asc") ? 1 : -1;
  return (persona.post_metrics || []).filter((row) => {
    if (platform && String(row.platform || "").toLowerCase() !== platform) return false;
    if (!pdDateInRange(row.published_at || row.captured_at)) return false;
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
  const padSet = new Set();
  const summary = {
    persona_count: visiblePersonas.length,
    post_count: 0,
    published_count: 0,
    image_count: 0,
    bound_pad_count: 0,
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
    if (persona.bound_pad_code) padSet.add(String(persona.bound_pad_code));
  });
  summary.bound_pad_count = padSet.size;
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
      if (platform) platformDistribution[platform] = (platformDistribution[platform] || 0) + 1;
    });
    Object.keys((persona.counts && persona.counts.platform_posts) || {}).forEach((platform) => {
      const count = Number(persona.counts.platform_posts[platform] || 0);
      if (count > 0) platformDistribution[platform] = (platformDistribution[platform] || 0) + count;
    });
    const platforms = persona.hot_platforms || [];
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

function pdRenderBarChart(hostId, rows) {
  const host = pdEl(hostId);
  if (!host) return;
  const items = (rows || []).filter((row) => Number(row.value || 0) > 0).slice(0, 12);
  if (!items.length) {
    host.innerHTML = `<div class="persona-chart-empty">暂无可展示数据</div>`;
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
    host.innerHTML = `<div class="persona-chart-empty">暂无可展示数据</div>`;
    return;
  }
  const colors = ["#2563eb", "#f59e0b", "#16a34a", "#dc2626", "#7c3aed", "#0f766e"];
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
    host.innerHTML = `<div class="persona-chart-empty">暂无走势数据</div>`;
    return;
  }
  const width = 720;
  const height = 220;
  const pad = 28;
  const series = [
    { key: "published", label: "发布", color: "#2563eb" },
    { key: "post_views", label: "帖子浏览", color: "#f59e0b" },
    { key: "likes", label: "点赞", color: "#16a34a" },
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
  const search = String((pdEl("personaDashboardSearch") && pdEl("personaDashboardSearch").value) || "").trim().toLowerCase();
  const platform = pdPlatformFilter();
  const pad = String((pdEl("personaDashboardPad") && pdEl("personaDashboardPad").value) || "").trim();
  const haystack = [persona.name, persona.content, persona.bound_pad_code, persona.bound_pad_name, persona.owner_bot_name, persona.threads_account && persona.threads_account.handle].join(" ").toLowerCase();
  if (search && !haystack.includes(search)) return false;
  if (pad && String(persona.bound_pad_code || "") !== pad) return false;
  if (platform) {
    const platforms = (persona.hot_platforms || []).map((item) => String(item.platform || "").toLowerCase());
    const platformPosts = Object.keys((persona.counts && persona.counts.platform_posts) || {}).map((item) => item.toLowerCase());
    if (!platforms.includes(platform) && !platformPosts.includes(platform)) return false;
  }
  return pdDateInRange(persona.updated_at || persona.created_at);
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
    { label: "绑定设备", value: summary.bound_pad_count, hint: "当前筛选设备数" },
    { label: "总互动量", value: summary.total_interactions, hint: "点赞、评论、转发、分享" },
    { label: "账号主页浏览", value: summary.recent_views, hint: "账号主页级浏览" },
    { label: "逐帖浏览合计", value: summary.post_views, hint: "逐帖浏览，不与主页浏览合并" },
    { label: "筛选热度", value: summary.hot_score, hint: "逐帖浏览 + 点赞 + 评论 + 分享 + 转发" },
  ];
  host.innerHTML = cards.map((card) => `
    <div class="kpi persona-kpi">
      <div class="label">${pdEscape(card.label)}</div>
      <div class="num">${pdEscape(pdNumber(card.value))}</div>
      <div class="small">${pdEscape(card.hint)}</div>
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
        ${row.published_url ? `<a class="ghost" href="${pdEscape(row.published_url)}" target="_blank" rel="noopener">打开</a>` : `<span class="small">-</span>`}
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

function pdAutomationRecordsForPersona(persona) {
  return (persona.publish_history || []).filter((row) => String(row.automation_task_type || row.task_type || "") !== "open_login");
}

function pdRenderAutomationRecordRows(persona) {
  const rows = pdAutomationRecordsForPersona(persona);
  return rows.slice(0, 40).map((row) => {
    const taskId = String(row.automation_task_id || row.automationTaskId || row.id || "");
    return `
      <tr>
        <td>${pdEscape(row.platform || "-")}</td>
        <td class="persona-auto-record-content">
          <div>${pdEscape(row.title || pdAutomationTaskLabel(row.automation_task_type || row.task_type) || "操作记录")}</div>
          <small>${pdEscape(String(row.content || row.source_url || "").slice(0, 160))}</small>
        </td>
        <td>${pdEscape(pdDate(row.published_at || row.captured_at))}</td>
        <td><span class="persona-auto-status persona-auto-status-${pdEscape(row.status || "success")}">${pdEscape(row.status || "success")}</span></td>
        <td><div class="persona-auto-row-actions">
          ${taskId.startsWith("social_task_") ? `<button class="ghost" type="button" data-auto-logs="${pdEscape(taskId)}">日志</button>` : (row.published_url ? `<a class="ghost" href="${pdEscape(row.published_url)}" target="_blank" rel="noopener">打开</a>` : `<span class="small">-</span>`)}
        </div></td>
      </tr>
    `;
  }).join("");
}

function pdRenderPersonaCard(persona) {
  const hot = pdPersonaHot(persona);
  const counts = persona.counts || {};
  const rows = pdFilteredPostRows(persona);
  const pageSize = Math.max(5, Math.min(100, Number(personaDashboardPageSize || 10)));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  personaDashboardPostPage = Math.max(1, Math.min(pageCount, Number(personaDashboardPostPage || 1)));
  const start = (personaDashboardPostPage - 1) * pageSize;
  const threads = persona.threads_account || {};
  const accountPlatform = String(personaDashboardAccountPlatform || "threads").toLowerCase();
  const isThreadsPlatform = accountPlatform === "threads";
  const platforms = (persona.hot_platforms || []).map((item) => `
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
        ${pdRenderTelegramContentBadges(row)}
      </td>
      <td class="persona-post-time">${pdEscape(pdDate(row.published_at || row.captured_at))}</td>
      <td class="persona-post-number">${pdEscape(pdNumber(row.like_count))}</td>
      <td class="persona-post-number">${pdEscape(pdNumber(row.comment_count))}</td>
      <td class="persona-post-number">${pdEscape(pdNumber(row.share_count || row.repost_count))}</td>
      <td class="persona-post-number">${pdEscape(pdNumber(row.view_count))}</td>
      <td class="persona-post-actions">
        <button class="ghost" type="button" data-post-view="${pdEscape(row.post_key || "")}">查看</button>
        <button class="ghost persona-post-delete" type="button" data-post-delete="${pdEscape(row.post_key || "")}">删除</button>
      </td>
    </tr>
  `).join("");
  return `
    <article class="persona-detail-card">
      <div class="persona-detail-head">
        <div>
          <h3>${pdEscape(persona.name || "未命名人设")}</h3>
          <div class="small">设备：${pdEscape(persona.bound_pad_name || persona.bound_pad_code || "未绑定")} · 机器人：${pdEscape(persona.owner_bot_name || "-")}</div>
        </div>
        <div class="persona-account-compact">
          <div class="persona-account-title">
            <label for="personaAccountPlatform">账号平台</label>
            <span>${isThreadsPlatform ? "绑定后可刷新该账号热点" : "当前仅展示平台切换"}</span>
          </div>
          <div class="persona-account-grid">
            <select id="personaAccountPlatform">
              <option value="threads" ${isThreadsPlatform ? "selected" : ""}>Threads</option>
              <option value="telegram" ${accountPlatform === "telegram" ? "selected" : ""}>Telegram</option>
            </select>
            <input id="personaThreadsInput" type="text" value="${isThreadsPlatform ? pdEscape(threads.handle || "") : ""}" placeholder="${isThreadsPlatform ? "username" : "暂未接入 Telegram 绑定"}" ${isThreadsPlatform ? "" : "disabled"} />
          </div>
          <div class="persona-account-actions">
            <button class="ghost" type="button" id="personaBindThreadsBtn" ${isThreadsPlatform ? "" : "disabled"}>保存</button>
            <button class="ghost persona-unbind-btn" type="button" id="personaUnbindThreadsBtn" ${isThreadsPlatform && threads.handle ? "" : "disabled"}>解绑</button>
            <button class="primary" type="button" id="personaRefreshCurrentBtn">刷新人设</button>
            <button class="primary persona-hot-refresh-btn" type="button" id="personaRefreshBoundHotBtn" ${isThreadsPlatform && threads.handle ? "" : "disabled"}>刷新热点</button>
          </div>
        </div>
        <div class="persona-score">
          <span>热度</span>
          <strong>${pdEscape(pdNumber(hot.hot_score))}</strong>
          <small>${pdEscape(persona.hot_score_formula || "热度 = 逐帖浏览 + 点赞 + 评论 + 分享 + 转发")}</small>
        </div>
      </div>
      ${pdPersonaWarnings(persona)}
      <div class="persona-bind-hint">
        <span>${isThreadsPlatform ? "没有绑定时无法抓取该人设账号热点；刷新会使用服务器端已保存的浏览器授权。" : "Telegram 账号绑定和热点抓取暂未接入；切回 Threads 可保存、解绑和刷新热点。"}</span>
      </div>
      <div class="persona-detail-grid">
        <div><span>帖子</span><strong>${pdEscape(pdNumber(counts.posts))}</strong></div>
        <div><span>发布</span><strong>${pdEscape(pdNumber(counts.published))}</strong></div>
        <div><span>互动</span><strong>${pdEscape(pdNumber(Number(hot.likes || 0) + Number(hot.comments || 0) + Number(hot.shares || 0) + Number(hot.reposts || 0)))}</strong></div>
        <div><span>账号主页浏览</span><strong>${pdEscape(pdNumber(hot.recent_views))}</strong></div>
        <div><span>逐帖浏览</span><strong>${pdEscape(pdNumber(hot.post_views))}</strong></div>
      </div>
      <div class="persona-content-preview">${pdEscape(persona.content || "暂无人设描述")}</div>
      <div class="persona-platform-list">${platforms || `<div class="small">暂无平台热点指标</div>`}</div>
      ${pdRenderAutomationPanel(persona)}
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
      ${pdRenderAutomationLogModal()}
    </article>
  `;
}

function pdPersonaKey(persona, index = 0) {
  return String((persona && (persona.id || persona.name || persona.bound_pad_code)) || `persona-${index}`);
}

function pdAutomationAccountsForPersona(persona) {
  const key = String((persona && persona.id) || "").trim();
  return (personaDashboardAutomation.accounts || []).filter((account) => String(account.persona_id || "") === key);
}

function pdSelectedAutomationPlatform() {
  const select = pdEl("personaAutoPlatform");
  const value = String((select && select.value) || personaDashboardAccountPlatform || "threads").trim().toLowerCase();
  return value === "instagram" ? "instagram" : "threads";
}

function pdAutomationAccountsForPlatform(persona, platform) {
  const current = String(platform || pdSelectedAutomationPlatform()).toLowerCase();
  return pdAutomationAccountsForPersona(persona).filter((account) => String(account.platform || "").toLowerCase() === current);
}

function pdAutomationTasksForPersona(persona) {
  const accountIds = new Set(pdAutomationAccountsForPersona(persona).map((account) => String(account.id || "")));
  return (personaDashboardAutomation.tasks || []).filter((task) => {
    if (!accountIds.has(String(task.account_id || ""))) return false;
    const payload = task.payload && typeof task.payload === "object" ? task.payload : {};
    return !(String(task.task_type || "") === "open_login" && payload.auto_submit !== true);
  }).slice(0, 8);
}

function pdAutomationStatusLabel(value) {
  return ({
    pending_login: "待登录",
    ready: "可执行",
    need_verification: "需人工验证",
    cookie_expired: "登录失效",
    disabled: "已停用",
    queued: "排队中",
    running: "执行中",
    success: "成功",
    failed: "失败",
    cancelled: "已取消",
    need_manual: "需人工处理",
    open_login: "打开登录",
    check_login: "检查登录",
    browse_feed: "浏览首页",
    browse_profile: "浏览主页",
    publish_post: "发帖",
    comment_post: "评论",
    reply_comment: "回复",
    like_post: "点赞",
    share_post: "分享",
    repost_post: "转发",
    threads_warmup: "Threads 养号",
    threads_auto_reply: "Threads 自动回复",
  }[String(value || "")] || String(value || "-"));
}

function pdRenderAutomationPanel(persona) {
  const platform = personaDashboardAccountPlatform === "instagram" ? "instagram" : "threads";
  const allAccounts = pdAutomationAccountsForPersona(persona);
  const accounts = pdAutomationAccountsForPlatform(persona, platform);
  const tasks = pdAutomationTasksForPersona(persona);
  const proxies = personaDashboardAutomation.proxies || [];
  const preferredAccountId = accounts.some((account) => String(account.id || "") === personaDashboardSelectedAutomationAccountId)
    ? personaDashboardSelectedAutomationAccountId
    : String((accounts[0] && accounts[0].id) || "");
  const selectedAccount = accounts.find((account) => String(account.id || "") === preferredAccountId) || accounts[0] || null;
  const selectedAccountId = String((selectedAccount && selectedAccount.id) || "");
  const selectedProxyId = String((selectedAccount && selectedAccount.proxy_id) || "");
  const savedLoginUsername = String((selectedAccount && selectedAccount.login_username) || (selectedAccount && selectedAccount.username) || "");
  const hasSavedLoginPassword = !!(selectedAccount && selectedAccount.login_password_configured);
  const savedLoginPassword = pdAutomationPasswordDisplayValue(selectedAccountId, selectedAccount);
  const savedLoginAt = Number((selectedAccount && selectedAccount.login_credentials_updated_at) || 0);
  const passwordCanReveal = !!String(personaDashboardPasswordDrafts[selectedAccountId] || "");
  const passwordCanToggle = !!selectedAccountId && (passwordCanReveal || hasSavedLoginPassword);
  const passwordVisible = passwordCanReveal && String(personaDashboardVisiblePasswordAccountId || "") === selectedAccountId;
  const readyCount = accounts.filter((account) => account.status === "ready").length;
  const platformLabel = platform === "threads" ? "Threads" : "Instagram";
  const usernamePlaceholder = platform === "threads" ? "threads username / handle" : "instagram username";
  const accountOptions = accounts.map((account) => `
    <option value="${pdEscape(account.id)}">${pdEscape(account.username || account.id)} · ${pdEscape(pdAutomationStatusLabel(account.status))}</option>
  `).join("");
  const accountOptionsFixed = accounts.map((account) => {
    const accountId = String(account.id || "");
    return `<option value="${pdEscape(accountId)}" ${accountId === preferredAccountId ? "selected" : ""}>${pdEscape(account.username || accountId)} - ${pdEscape(pdAutomationStatusLabel(account.status))}</option>`;
  }).join("");
  const proxyOptions = proxies.map((proxy) => `
    <option value="${pdEscape(proxy.id)}" ${String(proxy.id) === selectedProxyId ? "selected" : ""}>${pdEscape(proxy.name || `${proxy.proxy_type}://${proxy.host}:${proxy.port}`)}</option>
  `).join("");
  const activeAutomationPane = personaDashboardAutomationPane === "records" ? "records" : "tasks";
  const recordRows = pdRenderAutomationRecordRows(persona);
  const recordCount = pdAutomationRecordsForPersona(persona).length;
  const taskRows = tasks.map((task) => `
    <tr>
      <td>${pdEscape(pdAutomationStatusLabel(task.task_type))}</td>
      <td><span class="persona-auto-status persona-auto-status-${pdEscape(task.status)}">${pdEscape(pdAutomationStatusLabel(task.status))}</span></td>
      <td>${pdEscape(pdDate((task.updated_at || task.created_at || 0) * 1000))}</td>
      <td><div class="persona-auto-result" title="${pdEscape(task.error || (task.result && (task.result.url || task.result.screenshot_path)) || "-")}">${pdEscape(task.error || (task.result && (task.result.url || task.result.screenshot_path)) || "-")}</div></td>
      <td><div class="persona-auto-row-actions">
        <button class="ghost" type="button" data-auto-logs="${pdEscape(task.id)}">日志</button>
        ${["queued", "running"].includes(String(task.status || "")) ? `<button class="ghost persona-auto-cancel" type="button" data-auto-cancel="${pdEscape(task.id)}">取消</button>` : ""}
      </div></td>
    </tr>
  `).join("");
  return `
    <section class="persona-auto-panel">
      <div class="persona-auto-head">
        <div>
          <h4>社媒自动化执行</h4>
          <div class="small">Instagram / Threads · Camoufox Profile · 住宅代理 · 有头模式</div>
        </div>
        <div class="persona-auto-kpis">
          <span>账号 ${pdEscape(String(allAccounts.length))}</span>
          <span>可执行 ${pdEscape(String(readyCount))}</span>
          <span>队列 ${pdEscape(String((personaDashboardAutomation.summary || {}).queued_count || 0))}</span>
        </div>
      </div>
      <div class="persona-auto-grid">
        <div class="persona-auto-box">
          <label>执行平台</label>
          <select id="personaAutoPlatform">
            <option value="threads" ${platform === "threads" ? "selected" : ""}>Threads</option>
            <option value="instagram" ${platform === "instagram" ? "selected" : ""}>Instagram</option>
          </select>
          <label>${pdEscape(platformLabel)} 账号</label>
          <div class="persona-auto-inline">
            <input id="personaAutoUsername" type="text" placeholder="${pdEscape(usernamePlaceholder)}" value="${pdEscape((accounts[0] && accounts[0].username) || "")}" />
            <button class="ghost" type="button" id="personaAutoCreateAccount">绑定</button>
          </div>
          <label>住宅代理</label>
          <div class="persona-auto-inline">
            <select id="personaAutoProxy"><option value="">不绑定代理</option>${proxyOptions}</select>
            <button class="ghost" type="button" id="personaAutoCheckProxy" ${proxies.length ? "" : "disabled"}>检测代理</button>
          </div>
          <div class="persona-auto-inline">
            <input id="personaAutoProxyUrl" type="text" placeholder="socks5://user:pass@host:port" />
            <button class="ghost" type="button" id="personaAutoCreateProxy">新增代理</button>
          </div>
          <label>执行账号</label>
          <select id="personaAutoAccount">${accountOptionsFixed || `<option value="">暂无账号，先绑定</option>`}</select>
          <label>自动登录资料</label>
          <div class="persona-auto-login-fields">
            <input id="personaAutoLoginUsername" type="text" name="persona_auto_login_${pdEscape(selectedAccountId || "none")}" placeholder="${pdEscape(platformLabel)} 登录账号/邮箱/手机号" value="${pdEscape(savedLoginUsername)}" autocomplete="off" data-lpignore="true" data-1p-ignore="true" />
            <div class="persona-auto-password-wrap">
              <input id="personaAutoLoginPassword" type="${passwordVisible ? "text" : "password"}" name="persona_auto_password_${pdEscape(selectedAccountId || "none")}" data-account-id="${pdEscape(selectedAccountId)}" data-saved-mask="${hasSavedLoginPassword && !passwordCanReveal ? "1" : "0"}" placeholder="${hasSavedLoginPassword ? "已保存密码" : "登录密码，可选择长期保存"}" value="${pdEscape(savedLoginPassword)}" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" />
              <button class="persona-auto-eye ${passwordVisible ? "is-visible" : ""}" type="button" id="personaAutoTogglePassword" aria-label="${passwordVisible ? "隐藏密码" : "显示密码"}" title="${passwordVisible ? "隐藏密码" : "显示密码"}" ${passwordCanToggle ? "" : "disabled"}>
                <svg class="persona-auto-eye-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                  <path class="persona-auto-eye-slash" d="M4 20L20 4"></path>
                </svg>
              </button>
            </div>
          </div>
          <div class="persona-auto-inline persona-auto-credential-tools">
            <span class="persona-auto-credential-state ${hasSavedLoginPassword ? "is-saved" : "is-empty"}">${hasSavedLoginPassword ? `已保存密码${savedLoginAt ? ` · ${pdEscape(pdDate(savedLoginAt * 1000))}` : ""}` : "未保存登录资料"}</span>
            <button class="ghost" type="button" id="personaAutoSaveLogin" ${accounts.length ? "" : "disabled"}>保存登录资料</button>
            <button class="ghost" type="button" id="personaAutoClearLogin" ${hasSavedLoginPassword ? "" : "disabled"}>删除登录资料</button>
          </div>
          <div class="persona-auto-actions">
            <button class="ghost" type="button" data-auto-account-action="open_login" ${accounts.length ? "" : "disabled"}>打开登录窗口</button>
            <button class="ghost" type="button" data-auto-login="1" ${accounts.length ? "" : "disabled"}>自动登录</button>
            <button class="ghost" type="button" data-auto-account-action="check_login" ${accounts.length ? "" : "disabled"}>检查登录</button>
            <button class="ghost" type="button" data-auto-task="${platform === "threads" ? "threads_warmup" : "browse_feed"}" ${accounts.length ? "" : "disabled"}>${platform === "threads" ? "养号" : "浏览首页"}</button>
          </div>
        </div>
        <div class="persona-auto-box persona-auto-box-wide">
          ${platform === "threads" ? `
            <label>Threads 自动化方式</label>
            <div class="small">不需要手填指定内容。养号会自动浏览首页并少量互动；自动回复会读取当前人设内容生成回复候选后执行。</div>
            <div class="persona-auto-actions">
              <button class="primary" type="button" data-auto-task="threads_auto_reply" ${accounts.length ? "" : "disabled"}>按人设自动回复</button>
              <button class="ghost" type="button" data-auto-task="threads_warmup" ${accounts.length ? "" : "disabled"}>养号</button>
            </div>
          ` : `
            <label>目标 URL / 主页 username</label>
            <input id="personaAutoTarget" type="text" placeholder="https://www.instagram.com/p/xxxx/ 或 username" />
            <label>正文 / 评论 / 回复</label>
            <textarea id="personaAutoText" rows="3" placeholder="发帖 Caption、评论内容或回复内容"></textarea>
            <label>媒体路径</label>
            <input id="personaAutoMedia" type="text" placeholder="本地图片/视频路径，多个用英文逗号分隔" />
            <div class="persona-auto-actions">
              <button class="primary" type="button" data-auto-task="publish_post" ${accounts.length ? "" : "disabled"}>发帖</button>
              <button class="ghost" type="button" data-auto-task="browse_profile" ${accounts.length ? "" : "disabled"}>浏览主页</button>
              <button class="ghost" type="button" data-auto-task="like_post" ${accounts.length ? "" : "disabled"}>点赞</button>
              <button class="ghost" type="button" data-auto-task="comment_post" ${accounts.length ? "" : "disabled"}>评论</button>
              <button class="ghost" type="button" data-auto-task="reply_comment" ${accounts.length ? "" : "disabled"}>回复</button>
              <button class="ghost" type="button" data-auto-task="share_post" ${accounts.length ? "" : "disabled"}>分享</button>
              <button class="ghost" type="button" data-auto-task="repost_post" ${accounts.length ? "" : "disabled"} title="Instagram Web 不提供真实转发接口，任务会记录为不支持">转发</button>
            </div>
          `}
        </div>
      </div>
      <div class="persona-auto-table-wrap persona-auto-log-shell">
        <div class="persona-auto-log-switch" role="tablist" aria-label="自动化日志与操作记录">
          <button class="${activeAutomationPane === "tasks" ? "is-active" : ""}" type="button" role="tab" aria-selected="${activeAutomationPane === "tasks" ? "true" : "false"}" data-auto-pane="tasks">任务日志 <span>${pdEscape(String(tasks.length))}</span></button>
          <button class="${activeAutomationPane === "records" ? "is-active" : ""}" type="button" role="tab" aria-selected="${activeAutomationPane === "records" ? "true" : "false"}" data-auto-pane="records">操作记录 <span>${pdEscape(String(recordCount))}</span></button>
        </div>
        ${activeAutomationPane === "records" ? `
          <table class="persona-auto-table persona-auto-record-table">
            <thead><tr><th>平台</th><th>内容</th><th>时间</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>${recordRows || `<tr><td colspan="5">暂无网页发布或操作记录</td></tr>`}</tbody>
          </table>
        ` : `
        <table class="persona-auto-table">
          <thead><tr><th>任务</th><th>状态</th><th>更新时间</th><th>结果 / 错误</th><th>操作</th></tr></thead>
          <tbody>${taskRows || `<tr><td colspan="5">暂无自动化任务</td></tr>`}</tbody>
        </table>
        `}
      </div>
    </section>
  `;
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
  return Array.isArray(row.media_items) ? row.media_items.filter((item) => item && item.url) : [];
}

function pdPostComposition(row) {
  const media = pdPostMediaItems(row);
  const imageCount = media.filter((item) => pdMediaType(item) === "image").length;
  const videoCount = media.filter((item) => pdMediaType(item) === "video").length;
  const otherCount = Math.max(0, media.length - imageCount - videoCount);
  const hasText = Boolean(String(row.full_content || row.content || "").trim());
  return { hasText, imageCount, videoCount, otherCount, totalMedia: media.length };
}

function pdRenderTelegramContentBadges(row) {
  const parts = pdPostComposition(row);
  const badges = [];
  badges.push(`<span class="${parts.hasText ? "is-on" : "is-off"}">文字${parts.hasText ? "" : " 0"}</span>`);
  badges.push(`<span class="${parts.imageCount ? "is-on" : "is-off"}">图片 ${pdEscape(String(parts.imageCount))}</span>`);
  badges.push(`<span class="${parts.videoCount ? "is-on" : "is-off"}">视频 ${pdEscape(String(parts.videoCount))}</span>`);
  if (parts.otherCount) badges.push(`<span class="is-on">其他 ${pdEscape(String(parts.otherCount))}</span>`);
  return `<div class="persona-post-content-badges" aria-label="Telegram 内容组成">${badges.join("")}</div>`;
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

function pdAutomationLogMediaUrl(taskId, index) {
  return `/api/persona_dashboard/automation/tasks/${encodeURIComponent(taskId)}/media/${encodeURIComponent(index)}`;
}

function pdAutomationScreenshotUrl(path) {
  const name = String(path || "").split(/[\\/]/).pop();
  return name ? `/api/persona_dashboard/automation/screenshots/${encodeURIComponent(name)}` : "";
}

function pdAutomationLogImages(task, logs) {
  const result = (task && task.result) || {};
  const items = [];
  [result.screenshot_path, ...(result.replyScreenshots || [])].filter(Boolean).forEach((path, index) => {
    items.push({ label: `结果截图 ${index + 1}`, url: pdAutomationScreenshotUrl(path), path });
  });
  (logs || []).forEach((row) => {
    if (row.screenshot_url && pdAutomationLogIsCheckpointScreenshot(row)) items.push({ label: `${pdAutomationLogStepText(row)}截图`, url: row.screenshot_url, path: row.screenshot_path });
  });
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url || item.path;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pdAutomationLogIsCheckpointScreenshot(row) {
  const stage = String((row && row.stage) || "");
  return new Set([
    "auto_login_start",
    "auto_login_form_filled",
    "login_verification_required",
    "login_invalid_credentials",
    "login_wait_timeout",
    "login_complete",
    "completion_node",
    "check_login",
    "browse_feed",
    "threads_warmup",
    "threads_auto_reply_done",
    "publish_done",
    "comment_done",
    "reply_done",
    "like_done",
    "already_liked",
    "share_done",
    "failed",
  ]).has(stage);
}

function pdAutomationLogStepText(row) {
  const stage = String((row && row.stage) || "");
  const task = row && row.data && row.data.task_type ? pdAutomationStatusLabel(row.data.task_type) : "";
  const map = {
    queued: "任务已加入队列，等待执行",
    running: "Worker 已领取任务，准备开始",
    prepare: "正在准备自动化任务",
    browser_launch: "正在启动指纹浏览器",
    open_login: "正在打开登录页面",
    check_login: "正在检查登录状态",
    auto_login_start: "开始自动登录",
    auto_login_continue: "正在处理 Threads / Instagram 登录入口",
    auto_login_find_inputs: "正在查找账号和密码输入框",
    auto_login_type_username: "正在输入账号",
    auto_login_type_password: "正在输入密码",
    auto_login_form_filled: "账号密码已填写完成",
    auto_login_submit: "已提交登录，等待平台返回结果",
    login_ready_confirm: "正在确认登录状态是否稳定",
    login_verification_required: "平台要求验证码或安全验证，需要人工处理",
    login_complete: "登录完成，已截图",
    completion_node: "任务完成节点已识别",
    threads_warmup: "Threads 养号动作执行中",
    threads_auto_reply: "Threads 自动回复执行中",
    threads_reply_button: "正在打开回复输入框",
    threads_reply_focus: "正在聚焦回复输入框",
    threads_reply_submit: "正在提交回复",
    success: "任务已完成",
    failed: "任务失败",
    need_manual: "需要人工介入",
    cancel: "任务已取消",
    force_stop: "已强制关闭浏览器",
  };
  if (map[stage]) return map[stage];
  if (task && stage === "queued") return `${task} 已加入队列`;
  return String((row && row.message) || stage || "正在执行");
}

function pdAutomationLogDetailText(row) {
  const data = (row && row.data) || {};
  const stage = String((row && row.stage) || "");
  const parts = [];
  if (data.username) parts.push(`账号：${data.username}`);
  if (data.url) parts.push(`页面：${data.url}`);
  if (data.clicked !== undefined) parts.push(data.clicked ? "已点击入口按钮" : "未找到入口按钮");
  if (data.clicked_submit_button !== undefined) parts.push(data.clicked_submit_button ? "已点击提交按钮" : "已使用回车提交");
  if (data.hold_seconds) parts.push(`保留窗口：${data.hold_seconds} 秒`);
  if (data.liked !== undefined) parts.push(`点赞：${data.liked}`);
  if (data.scrolled !== undefined) parts.push(`滚动：${data.scrolled}`);
  if (data.replied !== undefined) parts.push(`回复：${data.replied}`);
  if (data.scannedPosts !== undefined) parts.push(`扫描帖子：${data.scannedPosts}`);
  if (data.completionReason) parts.push(`完成原因：${data.completionReason}`);
  if (!parts.length && stage === "queued") parts.push("等待后台 Worker 执行");
  if (!parts.length && stage === "running") parts.push("任务已被后台 Worker 领取");
  if (!parts.length && stage === "prepare") parts.push("正在初始化任务参数");
  if (!parts.length && stage === "browser_launch") parts.push("正在启动并加载独立浏览器 Profile");
  if (!parts.length && stage === "success") parts.push("任务已完成并保存结果");
  if (!parts.length && stage === "failed") parts.push("任务失败，请查看当前步骤或截图");
  if (!parts.length && stage === "need_manual") parts.push("需要人工完成页面上的验证或确认");
  if (!parts.length && stage === "cancel") parts.push("用户已取消任务");
  return parts.join(" · ");
}

function pdAutomationTaskSummary(task) {
  const payload = (task && task.payload) || {};
  const result = (task && task.result) || {};
  const parts = [];
  if (payload.login_username) parts.push(`登录账号：${payload.login_username}`);
  if (payload.auto_submit) parts.push("模式：自动输入账号密码");
  if (payload.max_posts) parts.push(`最多扫描：${payload.max_posts} 条`);
  if (payload.max_replies) parts.push(`目标回复：${payload.max_replies} 条`);
  if (payload.scroll_times) parts.push(`滚动次数：${payload.scroll_times}`);
  if (result.replied !== undefined) parts.push(`已回复：${result.replied}`);
  if (result.scannedPosts !== undefined) parts.push(`已扫描：${result.scannedPosts}`);
  if (result.completionReason) parts.push(`完成原因：${result.completionReason}`);
  if (!parts.length) parts.push("暂无额外参数");
  return parts;
}

function pdAutomationLogScreenshot(row) {
  const url = row && row.screenshot_url;
  if (!url || !pdAutomationLogIsCheckpointScreenshot(row)) return "";
  const images = pdAutomationLogImages((personaDashboardAutomationLogData || {}).task, (personaDashboardAutomationLogData || {}).logs || []);
  const index = Math.max(0, images.findIndex((item) => item.url === url));
  return `
    <button class="persona-auto-log-shot" type="button" data-auto-gallery-index="${pdEscape(String(index))}">
      <img src="${pdEscape(url)}" alt="步骤截图" loading="lazy" />
      <span>点击放大截图</span>
    </button>
  `;
}

function pdRenderAutomationLogMedia(task, logs) {
  const payload = (task && task.payload) || {};
  const taskId = String((task && task.id) || personaDashboardAutomationLogTaskId || "");
  const items = pdAutomationLogImages(task, logs);
  (payload.media_paths || []).forEach((path, index) => {
    items.push({ label: `任务媒体 ${index + 1}`, url: pdAutomationLogMediaUrl(taskId, index), path });
  });
  const seen = new Set();
  const html = items.filter((item) => {
    const key = item.url || item.path;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((item) => {
    const galleryIndex = pdAutomationLogImages(task, logs).findIndex((image) => image.url === item.url);
    const imageButton = galleryIndex >= 0;
    return `
    <${imageButton ? "button" : "a"} class="persona-auto-log-media-item" ${imageButton ? `type="button" data-auto-gallery-index="${pdEscape(String(galleryIndex))}"` : `href="${pdEscape(item.url)}" target="_blank" rel="noopener"`}>
      ${imageButton ? `<img src="${pdEscape(item.url)}" alt="${pdEscape(item.label)}" loading="lazy" />` : ""}
      <strong>${pdEscape(item.label)}</strong>
      <span>点击预览</span>
    </${imageButton ? "button" : "a"}>`;
  }).join("");
  return html || `<div class="small">暂无媒体或截图</div>`;
}

function pdRenderAutomationLogGallery(task, logs) {
  const images = pdAutomationLogImages(task, logs);
  if (!images.length || personaDashboardAutomationGalleryIndex < 0) return "";
  const index = Math.max(0, Math.min(images.length - 1, Number(personaDashboardAutomationGalleryIndex) || 0));
  const item = images[index] || {};
  return `
    <div class="persona-post-gallery persona-auto-image-gallery" role="dialog" aria-modal="true" aria-label="自动化截图相册">
      <div class="persona-post-gallery-card">
        <div class="persona-post-gallery-head">
          <div>
            <strong>截图相册</strong>
            <span>${pdEscape(item.label || "截图")} · 第 ${pdEscape(String(index + 1))} / ${pdEscape(String(images.length))} 张</span>
          </div>
          <button class="ghost" type="button" id="personaAutoGalleryClose">关闭相册</button>
        </div>
        <div class="persona-post-gallery-stage">
          <img src="${pdEscape(item.url || "")}" alt="${pdEscape(item.label || "截图")}" />
        </div>
        <div class="persona-post-gallery-actions">
          <button class="ghost" type="button" id="personaAutoGalleryPrev" ${index <= 0 ? "disabled" : ""}>上一张</button>
          <div class="persona-post-gallery-dots">
            ${images.map((image, dotIndex) => `<button type="button" class="${dotIndex === index ? "is-active" : ""}" data-auto-gallery-dot="${dotIndex}" aria-label="查看第 ${dotIndex + 1} 张截图">${dotIndex + 1}</button>`).join("")}
          </div>
          <button class="ghost" type="button" id="personaAutoGalleryNext" ${index >= images.length - 1 ? "disabled" : ""}>下一张</button>
        </div>
      </div>
    </div>
  `;
}

function pdRenderAutomationLogModal() {
  if (!personaDashboardAutomationLogTaskId) return "";
  const data = personaDashboardAutomationLogData || {};
  const task = data.task || (personaDashboardAutomation.tasks || []).find((item) => String(item.id || "") === personaDashboardAutomationLogTaskId) || { id: personaDashboardAutomationLogTaskId };
  const logs = data.logs || [];
  const current = logs.length ? logs[logs.length - 1] : null;
  const taskSummary = pdAutomationTaskSummary(task);
  return `
    <div class="persona-auto-log-modal" role="dialog" aria-modal="true" aria-label="自动化任务日志">
      <div class="persona-auto-log-card">
        <div class="persona-auto-log-head">
          <div>
            <strong>自动化任务日志</strong>
            <span>${pdEscape(task.platform || "-")} / ${pdEscape(task.task_type || "-")} / ${pdEscape(task.id || "")}</span>
          </div>
          <div class="persona-auto-row-actions">
            <button class="ghost" type="button" id="personaAutoLogRefresh">刷新</button>
            <button class="ghost" type="button" id="personaAutoLogClose">关闭</button>
          </div>
        </div>
        <div class="persona-auto-log-layout">
          <section class="persona-auto-log-panel">
            <h4>当前步骤</h4>
            <div class="persona-auto-current-step persona-auto-current-step-${pdEscape((current && current.level) || task.status || "")}">
              <strong>${pdEscape(current ? pdAutomationLogStepText(current) : pdAutomationStatusLabel(task.status || "queued"))}</strong>
              <span>${pdEscape(current ? pdAutomationLogDetailText(current) : "等待任务开始")}</span>
              ${current ? pdAutomationLogScreenshot(current) : ""}
            </div>
            <h4>任务信息</h4>
            <div class="persona-auto-log-meta">
              ${[
                ["平台", task.platform || "-"],
                ["任务", pdAutomationStatusLabel(task.task_type)],
                ["状态", pdAutomationStatusLabel(task.status)],
                ["更新时间", pdDate((task.updated_at || task.created_at || 0) * 1000)],
                ["错误", task.error || "-"],
              ].map(([label, value]) => `<div><span>${pdEscape(label)}</span><strong>${pdEscape(value)}</strong></div>`).join("")}
            </div>
            <h4>任务摘要</h4>
            <div class="persona-auto-log-summary">
              ${taskSummary.map((item) => `<span>${pdEscape(item)}</span>`).join("")}
            </div>
            <h4>截图预览</h4>
            <div class="persona-auto-log-media">${pdRenderAutomationLogMedia(task, logs)}</div>
          </section>
          <section class="persona-auto-log-panel">
            <h4>完整过程</h4>
            <div class="persona-auto-log-list">
              ${logs.map((row) => `
                <article class="persona-auto-log-item">
                  <div class="persona-auto-log-item-head">
                    <span>${pdEscape(pdDate((row.created_at || 0) * 1000))}</span>
                    <strong>${pdEscape(pdAutomationLogStepText(row))}</strong>
                  </div>
                  ${pdAutomationLogDetailText(row) ? `<div class="persona-auto-log-message">${pdEscape(pdAutomationLogDetailText(row))}</div>` : ""}
                  ${pdAutomationLogScreenshot(row)}
                </article>
              `).join("") || `<div class="small">暂无日志</div>`}
            </div>
          </section>
        </div>
      </div>
      ${pdRenderAutomationLogGallery(task, logs)}
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
          ${label === "原始链接" ? `<a href="${pdEscape(value)}" target="_blank" rel="noreferrer">${pdEscape(value)}</a>` : `<strong>${pdEscape(value)}</strong>`}
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
          <h4>Telegram 内容组成</h4>
          ${pdRenderTelegramContentBadges(row)}
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
      <strong>分栏</strong>
      <span>${pdEscape(String(visiblePersonas.length))} 人设</span>
    </div>
    <div class="persona-tab-list">
      <div class="persona-tab-section persona-tab-section-system">
      <button class="persona-tab ${personaDashboardSelectedId === "__overview__" ? "is-active" : ""}" type="button" data-persona-id="__overview__">
        <span class="persona-tab-index">总</span>
        <span class="persona-tab-main"><strong>总览首页</strong><span>全部图表与指标</span></span>
        <span class="persona-tab-metrics"><b>${pdEscape(pdNumber((personaDashboardData.summary || {}).persona_count))}</b><span>人设</span></span>
      </button>
      </div>
      <div class="persona-tab-section persona-tab-section-personas">
      ${tabPersonas.map((persona, pageIndex) => {
        const index = tabStart + pageIndex;
        const hot = persona.hot || {};
        const counts = persona.counts || {};
        const key = pdPersonaKey(persona, index);
        const active = selectedPersona && pdPersonaKey(selectedPersona, index) === key;
        return `
          <button class="persona-tab ${active ? "is-active" : ""}" type="button" data-persona-id="${pdEscape(key)}">
            <span class="persona-tab-index">${index + 1}</span>
            <span class="persona-tab-main">
              <strong>${pdEscape(persona.name || "未命名人设")}</strong>
              <span>${pdEscape(persona.bound_pad_name || persona.bound_pad_code || "未绑定设备")}</span>
            </span>
            <span class="persona-tab-metrics">
              <b>${pdEscape(pdNumber(hot.hot_score))}</b>
              <span>${pdEscape(pdNumber(counts.published))} 发布</span>
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
        <span class="persona-tab-main"><strong>设置</strong><span>分页、刷新与显示数量</span></span>
        <span class="persona-tab-metrics"><b>${pdEscape(String(personaDashboardPageSize))}</b><span>每页</span></span>
      </button>
      </div>
    </div>
  `;
  tabs.querySelectorAll("[data-persona-id]").forEach((node) => {
    node.addEventListener("click", () => {
      const nextPersonaId = String(node.getAttribute("data-persona-id") || "");
      if (nextPersonaId !== personaDashboardSelectedId) {
        personaDashboardSelectedAutomationAccountId = "";
        personaDashboardVisiblePasswordAccountId = "";
        personaDashboardPasswordDrafts = {};
        personaDashboardPasswordDirtyAccountIds = {};
      }
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
        <div class="small">调整单个人设推文表的分页数量，并可手动刷新全部已绑定账号。</div>
      </div>
      <label for="personaPageSizeInput">每页推文数量</label>
      <div class="persona-settings-row">
        <input id="personaPageSizeInput" type="number" min="5" max="100" step="5" value="${pdEscape(String(personaDashboardPageSize))}" />
        <button class="primary" type="button" id="personaPageSizeApply">应用</button>
      </div>
      <div class="persona-settings-row persona-settings-row-left">
        <button class="primary" type="button" id="personaRefreshAllBtn">全量刷新全部已绑定人设</button>
        <span class="small">会逐个读取已绑定 Threads 用户名的人设；无绑定的人设会跳过并提示。</span>
      </div>
      <div class="small">可设置 5 到 100 条。刷新过程中可留在页面查看任务状态。</div>
    </div>
  `;
  const apply = pdEl("personaPageSizeApply");
  if (apply) {
    apply.addEventListener("click", () => {
      const input = pdEl("personaPageSizeInput");
      const next = Math.max(5, Math.min(100, Number(input && input.value) || 10));
      personaDashboardPageSize = next;
      personaDashboardPostPage = 1;
      localStorage.setItem("personaDashboardPageSize", String(next));
      pdRenderDashboard();
    });
  }
  const refreshAll = pdEl("personaRefreshAllBtn");
  if (refreshAll) refreshAll.addEventListener("click", () => pdStartRefresh(""));
}

function pdRenderDashboard() {
  const data = personaDashboardData;
  const list = pdEl("personaDashboardList");
  const empty = pdEl("personaDashboardEmpty");
  const meta = pdEl("personaDashboardMeta");
  const overview = pdEl("personaOverviewPane");
  const settings = pdEl("personaDashboardSettings");
  if (!data || !list || !empty) return;
  const visible = (data.personas || []).filter(pdMatches);
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
  const bind = pdEl("personaBindThreadsBtn");
  const unbind = pdEl("personaUnbindThreadsBtn");
  const accountPlatform = pdEl("personaAccountPlatform");
  const refreshCurrent = pdEl("personaRefreshCurrentBtn");
  const refreshBoundHot = pdEl("personaRefreshBoundHotBtn");
  const modalClose = pdEl("personaPostModalClose");
  const autoLogClose = pdEl("personaAutoLogClose");
  const autoLogRefresh = pdEl("personaAutoLogRefresh");
  const autoGalleryClose = pdEl("personaAutoGalleryClose");
  const autoGalleryPrev = pdEl("personaAutoGalleryPrev");
  const autoGalleryNext = pdEl("personaAutoGalleryNext");
  const postSort = pdEl("personaPostSort");
  const postTypeFilter = pdEl("personaPostTypeFilter");
  if (prev) prev.addEventListener("click", () => { personaDashboardPostPage -= 1; pdRenderDashboard(); });
  if (next) next.addEventListener("click", () => { personaDashboardPostPage += 1; pdRenderDashboard(); });
  if (bind && selected) bind.addEventListener("click", () => pdBindThreads(selected));
  if (unbind && selected) unbind.addEventListener("click", () => pdUnbindThreads(selected));
  if (accountPlatform) {
    accountPlatform.addEventListener("change", () => {
      personaDashboardAccountPlatform = String(accountPlatform.value || "threads");
      localStorage.setItem("personaDashboardAccountPlatform", personaDashboardAccountPlatform);
      pdRenderDashboard();
    });
  }
  if (refreshCurrent && selected) refreshCurrent.addEventListener("click", () => pdStartRefresh(selected.id, "已请求刷新当前人设..."));
  if (refreshBoundHot && selected) refreshBoundHot.addEventListener("click", () => pdStartRefresh(selected.id, "已请求刷新该绑定账号的全量热点信息..."));
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
  if (autoLogClose) autoLogClose.addEventListener("click", () => {
    personaDashboardAutomationLogTaskId = "";
    personaDashboardAutomationLogData = null;
    personaDashboardAutomationGalleryIndex = -1;
    pdStopAutomationLogPoll();
    pdRenderDashboard();
  });
  if (autoLogRefresh) autoLogRefresh.addEventListener("click", () => {
    pdRefreshAutomationLogModal(personaDashboardAutomationLogTaskId);
  });
  if (autoGalleryClose) autoGalleryClose.addEventListener("click", () => {
    personaDashboardAutomationGalleryIndex = -1;
    pdRenderDashboard();
  });
  if (autoGalleryPrev) autoGalleryPrev.addEventListener("click", () => {
    personaDashboardAutomationGalleryIndex -= 1;
    pdRenderDashboard();
  });
  if (autoGalleryNext) autoGalleryNext.addEventListener("click", () => {
    personaDashboardAutomationGalleryIndex += 1;
    pdRenderDashboard();
  });
  list.querySelectorAll("[data-auto-gallery-index]").forEach((node) => {
    node.addEventListener("click", () => {
      personaDashboardAutomationGalleryIndex = Number(node.getAttribute("data-auto-gallery-index") || 0);
      pdRenderDashboard();
    });
  });
  list.querySelectorAll("[data-auto-gallery-dot]").forEach((node) => {
    node.addEventListener("click", () => {
      personaDashboardAutomationGalleryIndex = Number(node.getAttribute("data-auto-gallery-dot") || 0);
      pdRenderDashboard();
    });
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
  if (selected) {
    pdBindAutomationEvents(selected, list);
    pdScheduleAutomationPasswordNormalize();
  }
}

function pdSyncPadFilter(data) {
  const select = pdEl("personaDashboardPad");
  if (!select) return;
  const current = select.value;
  const pads = Array.from(new Set((data.personas || []).map((item) => String(item.bound_pad_code || "").trim()).filter(Boolean))).sort();
  select.innerHTML = `<option value="">全部设备</option>${pads.map((pad) => `<option value="${pdEscape(pad)}">${pdEscape(pad)}</option>`).join("")}`;
  if (pads.includes(current)) select.value = current;
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
    await pdLoadAutomationOverview({ silent: true });
    pdSyncPadFilter(data);
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

async function pdLoadAutomationOverview(options = {}) {
  try {
    const data = await pdApi("/api/persona_dashboard/automation/overview");
    personaDashboardAutomation = data || { accounts: [], proxies: [], tasks: [], summary: {}, worker: {} };
  } catch (err) {
    if (!(options && options.silent)) {
      pdSetMsg(String((err && (err.detail || err.message)) || err || "自动化模块加载失败"), "err");
    }
    personaDashboardAutomation = { accounts: [], proxies: [], tasks: [], summary: {}, worker: {} };
  }
}

async function pdOpenAutomationLogModal(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return;
  personaDashboardAutomationLogTaskId = id;
  personaDashboardAutomationLogData = null;
  pdRenderDashboard();
  pdStartAutomationLogPoll();
  await pdRefreshAutomationLogModal(id);
}

async function pdRefreshAutomationLogModal(taskId) {
  const id = String(taskId || personaDashboardAutomationLogTaskId || "").trim();
  if (!id) return;
  const scrollPanel = document.querySelector(".persona-auto-log-layout .persona-auto-log-panel:nth-child(2)");
  const scrollState = scrollPanel ? {
    top: scrollPanel.scrollTop,
    bottom: scrollPanel.scrollHeight - scrollPanel.scrollTop - scrollPanel.clientHeight < 48,
  } : null;
  try {
    const [taskData, logData] = await Promise.all([
      pdApi(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(id)}`),
      pdApi(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(id)}/logs`),
    ]);
    personaDashboardAutomationLogData = { task: taskData.task || null, logs: logData.logs || [] };
    pdRenderDashboard();
    if (scrollState) {
      requestAnimationFrame(() => {
        const nextPanel = document.querySelector(".persona-auto-log-layout .persona-auto-log-panel:nth-child(2)");
        if (!nextPanel) return;
        nextPanel.scrollTop = scrollState.bottom ? nextPanel.scrollHeight : scrollState.top;
      });
    }
  } catch (err) {
    pdSetMsg(String((err && (err.detail || err.message)) || err || "读取日志失败"), "err");
  }
}

function pdStartAutomationLogPoll() {
  if (personaDashboardAutomationLogTimer) window.clearInterval(personaDashboardAutomationLogTimer);
  personaDashboardAutomationLogTimer = window.setInterval(() => {
    if (!personaDashboardAutomationLogTaskId || document.hidden) return;
    pdRefreshAutomationLogModal(personaDashboardAutomationLogTaskId);
  }, 3000);
}

function pdStopAutomationLogPoll() {
  if (personaDashboardAutomationLogTimer) window.clearInterval(personaDashboardAutomationLogTimer);
  personaDashboardAutomationLogTimer = 0;
}

function pdSelectedAutomationAccountId() {
  const select = pdEl("personaAutoAccount");
  return String((select && select.value) || "").trim();
}

function pdSelectedAutomationAccount() {
  const id = pdSelectedAutomationAccountId();
  return (personaDashboardAutomation.accounts || []).find((account) => String(account.id || "") === id) || null;
}

function pdAutomationPasswordDisplayValue(accountId, account = null) {
  const draft = String(personaDashboardPasswordDrafts[accountId] || "");
  if (draft) return draft;
  return account && account.login_password_configured ? PERSONA_DASHBOARD_SAVED_PASSWORD_MASK : "";
}

function pdAutomationPasswordIsSavedMask(value) {
  return String(value || "") === PERSONA_DASHBOARD_SAVED_PASSWORD_MASK;
}

function pdAutomationTypedPassword(accountId) {
  const input = pdEl("personaAutoLoginPassword");
  const value = String((input && input.value) || "");
  if (!personaDashboardPasswordDirtyAccountIds[accountId]) return "";
  if (pdAutomationPasswordIsSavedMask(value)) return "";
  return value;
}

async function pdRevealSavedAutomationPassword(accountId) {
  const data = await pdApi(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(accountId)}/credentials`);
  const password = String(data.login_password || "");
  if (!password) return "";
  personaDashboardPasswordDrafts[accountId] = password;
  delete personaDashboardPasswordDirtyAccountIds[accountId];
  return password;
}

function pdNormalizeAutomationPasswordField() {
  const input = pdEl("personaAutoLoginPassword");
  if (!input) return;
  const accountId = pdSelectedAutomationAccountId();
  const account = pdSelectedAutomationAccount();
  const expected = pdAutomationPasswordDisplayValue(accountId, account);
  if (document.activeElement === input && input.value !== expected) return;
  if (input.value !== expected) input.value = expected;
  const toggle = pdEl("personaAutoTogglePassword");
  const hasRevealableDraft = !!String(personaDashboardPasswordDrafts[accountId] || "");
  input.setAttribute("data-saved-mask", account && account.login_password_configured && !hasRevealableDraft ? "1" : "0");
  if (toggle) {
    toggle.disabled = !(hasRevealableDraft || (account && account.login_password_configured));
    toggle.classList.toggle("is-visible", hasRevealableDraft && input.type === "text");
    toggle.setAttribute("aria-label", input.type === "text" ? "隐藏密码" : "显示密码");
    toggle.setAttribute("title", input.type === "text" ? "隐藏密码" : "显示密码");
  }
  if (!expected) {
    input.type = "password";
    personaDashboardVisiblePasswordAccountId = "";
    if (toggle) {
      toggle.classList.remove("is-visible");
      toggle.setAttribute("aria-label", "显示密码");
      toggle.setAttribute("title", "显示密码");
    }
  }
}

function pdScheduleAutomationPasswordNormalize() {
  window.setTimeout(pdNormalizeAutomationPasswordField, 50);
  window.setTimeout(pdNormalizeAutomationPasswordField, 300);
  window.setTimeout(pdNormalizeAutomationPasswordField, 1000);
}

function pdAutomationPayload(taskType, persona = null, platform = "") {
  const target = String((pdEl("personaAutoTarget") && pdEl("personaAutoTarget").value) || "").trim();
  const text = String((pdEl("personaAutoText") && pdEl("personaAutoText").value) || "").trim();
  const mediaText = String((pdEl("personaAutoMedia") && pdEl("personaAutoMedia").value) || "").trim();
  const mediaPaths = mediaText.split(",").map((item) => item.trim()).filter(Boolean);
  const payload = {};
  if (taskType === "publish_post") {
    payload.caption = text;
    payload.media_paths = mediaPaths;
    payload.warmup = true;
  } else if (taskType === "browse_profile") {
    if (/^https?:\/\//i.test(target)) payload.target_url = target;
    else payload.username = target;
  } else if (taskType === "comment_post") {
    payload.target_url = target;
    payload.comment = text;
  } else if (taskType === "reply_comment") {
    payload.target_url = target;
    payload.reply = text;
  } else if (["like_post", "share_post", "repost_post"].includes(taskType)) {
    payload.target_url = target;
  } else if (taskType === "browse_feed") {
    payload.scroll_times = 2;
  } else if (taskType === "threads_warmup") {
    payload.scroll_times = 6;
    payload.like_limit = 2;
    payload.persona_name = (persona && persona.name) || "";
  } else if (taskType === "threads_auto_reply") {
    payload.max_posts = 5;
    payload.max_replies = 3;
    payload.max_age_days = 2;
    payload.persona_name = (persona && persona.name) || "";
  }
  if (platform) payload.platform = platform;
  return payload;
}

function pdValidateAutomationPayload(taskType, payload) {
  if (taskType === "publish_post" && !(payload.media_paths || []).length) return "发帖需要填写至少一个媒体路径。";
  if (["comment_post", "reply_comment"].includes(taskType) && !payload.target_url) return "评论/回复需要填写目标帖子 URL。";
  if (["comment_post", "reply_comment"].includes(taskType) && !(payload.comment || payload.reply)) return "评论/回复需要填写正文。";
  if (["like_post", "share_post", "repost_post"].includes(taskType) && !payload.target_url) return "点赞/分享/转发需要填写目标帖子 URL。";
  if (taskType === "browse_profile" && !payload.target_url && !payload.username) return "浏览主页需要填写 URL 或 username。";
  return "";
}

function pdLooksLikeNonPasswordText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  const chineseMatches = text.match(/[\u4e00-\u9fff]/g) || [];
  if (chineseMatches.length >= 3) return true;
  return /(看不到|消失|不然|怎么|为什么|placeholder|password here|说明文字)/i.test(text);
}

function pdParseProxyUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("代理格式必须类似 socks5://user:pass@host:port 或 http://host:port");
  }
  const proxyType = url.protocol.replace(":", "").toLowerCase();
  if (!["http", "https", "socks5"].includes(proxyType)) {
    throw new Error("代理类型仅支持 http、https、socks5");
  }
  return {
    name: `${proxyType}://${url.hostname}:${url.port}`,
    proxy_type: proxyType,
    host: url.hostname,
    port: Number(url.port || 0),
    username: decodeURIComponent(url.username || ""),
    password: decodeURIComponent(url.password || ""),
  };
}

function pdBindAutomationEvents(persona, root) {
  root.querySelectorAll("[data-auto-pane]").forEach((node) => {
    node.addEventListener("click", () => {
      const pane = String(node.getAttribute("data-auto-pane") || "tasks");
      personaDashboardAutomationPane = pane === "records" ? "records" : "tasks";
      localStorage.setItem("personaDashboardAutomationPane", personaDashboardAutomationPane);
      pdRenderDashboard();
    });
  });
  const platformSelect = pdEl("personaAutoPlatform");
  if (platformSelect) {
    platformSelect.addEventListener("change", () => {
      personaDashboardAccountPlatform = pdSelectedAutomationPlatform();
      personaDashboardSelectedAutomationAccountId = "";
      personaDashboardVisiblePasswordAccountId = "";
      personaDashboardPasswordDrafts = {};
      personaDashboardPasswordDirtyAccountIds = {};
      localStorage.setItem("personaDashboardAccountPlatform", personaDashboardAccountPlatform);
      pdRenderDashboard();
    });
  }
  const createProxy = pdEl("personaAutoCreateProxy");
  if (createProxy) {
    createProxy.addEventListener("click", async () => {
      try {
        const payload = pdParseProxyUrl(pdEl("personaAutoProxyUrl") && pdEl("personaAutoProxyUrl").value);
        if (!payload || !payload.host || !payload.port) {
          pdSetMsg("请填写完整代理 URL。", "err");
          return;
        }
        pdSetMsg("正在新增住宅代理...", "ok");
        await pdApi("/api/persona_dashboard/automation/proxies", { method: "POST", body: payload });
        await pdLoadAutomationOverview();
        pdSetMsg("代理已新增，可在绑定账号时选择。", "ok");
        pdRenderDashboard();
      } catch (err) {
        pdSetMsg(String((err && (err.detail || err.message)) || err || "新增代理失败"), "err");
      }
    });
  }
  const checkProxy = pdEl("personaAutoCheckProxy");
  if (checkProxy) {
    checkProxy.addEventListener("click", async () => {
      const proxyId = String((pdEl("personaAutoProxy") && pdEl("personaAutoProxy").value) || "").trim();
      if (!proxyId) {
        pdSetMsg("请先选择要检测的住宅代理。", "err");
        return;
      }
      try {
        pdSetMsg("正在检测住宅代理出口...", "ok");
        const data = await pdApi(`/api/persona_dashboard/automation/proxies/${encodeURIComponent(proxyId)}/check`, { method: "POST" });
        await pdLoadAutomationOverview();
        const result = (data.proxy && data.proxy.last_check_result) || {};
        const ip = result.ip ? `，出口 IP ${result.ip}` : "";
        pdSetMsg(`代理检测完成：${pdAutomationStatusLabel(data.proxy && data.proxy.status)}${ip}`, "ok");
        pdRenderDashboard();
      } catch (err) {
        pdSetMsg(String((err && (err.detail || err.message)) || err || "代理检测失败"), "err");
      }
    });
  }
  const create = pdEl("personaAutoCreateAccount");
  if (create) {
    create.addEventListener("click", async () => {
      const username = String((pdEl("personaAutoUsername") && pdEl("personaAutoUsername").value) || "").trim().replace(/^@/, "");
      const platform = pdSelectedAutomationPlatform();
      const platformLabel = platform === "threads" ? "Threads" : "Instagram";
      if (!username) {
        pdSetMsg(`请先填写 ${platformLabel} username。`, "err");
        return;
      }
      try {
        const proxyId = String((pdEl("personaAutoProxy") && pdEl("personaAutoProxy").value) || "").trim();
        pdSetMsg(`正在绑定 ${platformLabel} 自动化账号...`, "ok");
        await pdApi("/api/persona_dashboard/automation/accounts", {
          method: "POST",
          body: { persona_id: persona.id, platform, username, proxy_id: proxyId },
        });
        await pdLoadAutomationOverview();
        pdSetMsg("账号已绑定。下一步请打开登录窗口完成一次人工登录。", "ok");
        pdRenderDashboard();
      } catch (err) {
        pdSetMsg(String((err && (err.detail || err.message)) || err || "账号绑定失败"), "err");
      }
    });
  }
  const accountSelect = pdEl("personaAutoAccount");
  if (accountSelect) {
    accountSelect.addEventListener("change", () => {
      personaDashboardSelectedAutomationAccountId = String(accountSelect.value || "");
      personaDashboardVisiblePasswordAccountId = "";
      const account = pdSelectedAutomationAccount();
      const usernameInput = pdEl("personaAutoLoginUsername");
      const passwordInput = pdEl("personaAutoLoginPassword");
      if (usernameInput) usernameInput.value = String((account && account.login_username) || (account && account.username) || "");
      if (passwordInput) {
        passwordInput.value = pdAutomationPasswordDisplayValue(personaDashboardSelectedAutomationAccountId, account);
        passwordInput.type = "password";
        passwordInput.name = `persona_auto_password_${personaDashboardSelectedAutomationAccountId || "none"}`;
        passwordInput.autocomplete = "new-password";
        passwordInput.setAttribute("data-account-id", personaDashboardSelectedAutomationAccountId);
        passwordInput.setAttribute("data-saved-mask", account && account.login_password_configured && !personaDashboardPasswordDrafts[personaDashboardSelectedAutomationAccountId] ? "1" : "0");
        passwordInput.placeholder = account && account.login_password_configured ? "已保存密码" : "登录密码，可选择长期保存";
      }
      pdScheduleAutomationPasswordNormalize();
    });
  }
  const passwordField = pdEl("personaAutoLoginPassword");
  if (passwordField) {
    passwordField.addEventListener("focus", () => {
      if (pdAutomationPasswordIsSavedMask(passwordField.value) && passwordField.getAttribute("data-saved-mask") === "1") {
        passwordField.select();
      }
    });
    passwordField.addEventListener("input", () => {
      const accountId = pdSelectedAutomationAccountId();
      if (!accountId) return;
      personaDashboardPasswordDrafts[accountId] = String(passwordField.value || "");
      personaDashboardPasswordDirtyAccountIds[accountId] = true;
      passwordField.setAttribute("data-saved-mask", "0");
    });
  }
  const togglePassword = pdEl("personaAutoTogglePassword");
  if (togglePassword) {
    togglePassword.addEventListener("click", async () => {
      const accountId = pdSelectedAutomationAccountId();
      const account = pdSelectedAutomationAccount();
      const passwordInput = pdEl("personaAutoLoginPassword");
      if (!passwordInput) return;
      let hasPassword = !!String(personaDashboardPasswordDrafts[accountId] || "");
      if (!hasPassword && account && account.login_password_configured) {
        try {
          togglePassword.disabled = true;
          const revealed = await pdRevealSavedAutomationPassword(accountId);
          hasPassword = !!revealed;
          if (revealed) {
            passwordInput.value = revealed;
            passwordInput.setAttribute("data-saved-mask", "0");
          }
        } catch (err) {
          pdSetMsg(String((err && (err.detail || err.message)) || err || "读取已保存密码失败"), "err");
        } finally {
          togglePassword.disabled = false;
        }
      }
      if (!hasPassword) return;
      const willShow = passwordInput.type === "password";
      personaDashboardVisiblePasswordAccountId = willShow ? accountId : "";
      passwordInput.type = willShow ? "text" : "password";
      togglePassword.classList.toggle("is-visible", willShow);
      togglePassword.setAttribute("aria-label", willShow ? "隐藏密码" : "显示密码");
      togglePassword.setAttribute("title", willShow ? "隐藏密码" : "显示密码");
    });
  }
  const saveLogin = pdEl("personaAutoSaveLogin");
  if (saveLogin) {
    saveLogin.addEventListener("click", async () => {
      const accountId = pdSelectedAutomationAccountId();
      const account = pdSelectedAutomationAccount();
      const loginUsername = String((pdEl("personaAutoLoginUsername") && pdEl("personaAutoLoginUsername").value) || "").trim();
      const loginPassword = pdAutomationTypedPassword(accountId);
      if (!accountId) {
        pdSetMsg("请先选择执行账号。", "err");
        return;
      }
      if (!loginUsername) {
        pdSetMsg("请填写要保存的登录账号。", "err");
        return;
      }
      if (!loginPassword && !(account && account.login_password_configured)) {
        pdSetMsg("首次保存登录资料需要填写密码。", "err");
        return;
      }
      try {
        if (loginPassword && pdLooksLikeNonPasswordText(loginPassword)) {
          pdSetMsg("密码框里像是说明文字，不会保存。请填写真实登录密码。", "err");
          return;
        }
        const body = { login_username: loginUsername };
        if (loginPassword) body.login_password = loginPassword;
        pdSetMsg("正在保存自动登录资料...", "ok");
        await pdApi(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(accountId)}`, {
          method: "PATCH",
          body,
        });
        personaDashboardVisiblePasswordAccountId = "";
        if (loginPassword) personaDashboardPasswordDrafts[accountId] = loginPassword;
        else if (account && account.login_password_configured) delete personaDashboardPasswordDrafts[accountId];
        delete personaDashboardPasswordDirtyAccountIds[accountId];
        if (pdEl("personaAutoLoginPassword")) pdEl("personaAutoLoginPassword").type = "password";
        await pdLoadAutomationOverview();
        pdSetMsg("自动登录资料已保存。", "ok");
        pdRenderDashboard();
      } catch (err) {
        pdSetMsg(String((err && (err.detail || err.message)) || err || "保存登录资料失败"), "err");
      }
    });
  }
  const clearLogin = pdEl("personaAutoClearLogin");
  if (clearLogin) {
    clearLogin.addEventListener("click", async () => {
      const accountId = pdSelectedAutomationAccountId();
      if (!accountId) {
        pdSetMsg("请先选择执行账号。", "err");
        return;
      }
      try {
        pdSetMsg("正在删除自动登录资料...", "ok");
        await pdApi(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(accountId)}`, {
          method: "PATCH",
          body: { clear_login_credentials: true },
        });
        personaDashboardVisiblePasswordAccountId = "";
        delete personaDashboardPasswordDrafts[accountId];
        delete personaDashboardPasswordDirtyAccountIds[accountId];
        if (pdEl("personaAutoLoginPassword")) {
          pdEl("personaAutoLoginPassword").value = "";
          pdEl("personaAutoLoginPassword").type = "password";
        }
        await pdLoadAutomationOverview();
        pdSetMsg("自动登录资料已删除。", "ok");
        pdRenderDashboard();
      } catch (err) {
        pdSetMsg(String((err && (err.detail || err.message)) || err || "删除登录资料失败"), "err");
      }
    });
  }
  root.querySelectorAll("[data-auto-account-action]").forEach((node) => {
    node.addEventListener("click", async () => {
      const action = String(node.getAttribute("data-auto-account-action") || "");
      const accountId = pdSelectedAutomationAccountId();
      if (!accountId) {
        pdSetMsg("请先选择执行账号。", "err");
        return;
      }
      try {
        pdSetMsg("正在创建账号状态任务...", "ok");
        const created = await pdApi(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(accountId)}/${encodeURIComponent(action)}`, {
          method: "POST",
        });
        await pdLoadAutomationOverview();
        pdSetMsg(action === "open_login" ? "已打开登录窗口，请在有头浏览器里完成登录。" : "已创建登录检查任务。", "ok");
        pdRenderDashboard();
      } catch (err) {
        pdSetMsg(String((err && (err.detail || err.message)) || err || "创建任务失败"), "err");
      }
    });
  });
  root.querySelectorAll("[data-auto-login]").forEach((node) => {
    node.addEventListener("click", async () => {
      const accountId = pdSelectedAutomationAccountId();
      const account = pdSelectedAutomationAccount();
      const platform = pdSelectedAutomationPlatform();
      const loginUsername = String((pdEl("personaAutoLoginUsername") && pdEl("personaAutoLoginUsername").value) || (account && account.username) || "").trim();
      const loginPassword = pdAutomationTypedPassword(accountId);
      const hasSavedLoginPassword = !!(account && account.login_password_configured);
      if (!accountId) {
        pdSetMsg("请先选择执行账号。", "err");
        return;
      }
      if (!loginUsername || (!loginPassword && !hasSavedLoginPassword)) {
        pdSetMsg("请填写登录账号和密码，或先保存长期登录资料。遇到验证码时系统会保持窗口打开等待人工处理。", "err");
        return;
      }
      try {
        pdSetMsg("正在创建自动登录任务...", "ok");
        if (loginPassword && pdLooksLikeNonPasswordText(loginPassword)) {
          pdSetMsg("密码框里像是说明文字，不会用于自动登录。请填写真实登录密码。", "err");
          return;
        }
        const created = await pdApi("/api/persona_dashboard/automation/tasks", {
          method: "POST",
          body: {
            persona_id: persona.id,
            account_id: accountId,
            platform,
            task_type: "open_login",
            priority: 20,
            max_retries: 0,
            payload: {
              auto_submit: true,
              login_username: loginUsername,
              ...(loginPassword ? { login_password: loginPassword } : {}),
              login_wait_seconds: 600,
            },
          },
        });
        personaDashboardVisiblePasswordAccountId = "";
        if (loginPassword) personaDashboardPasswordDrafts[accountId] = loginPassword;
        else if (hasSavedLoginPassword) delete personaDashboardPasswordDrafts[accountId];
        delete personaDashboardPasswordDirtyAccountIds[accountId];
        if (pdEl("personaAutoLoginPassword")) pdEl("personaAutoLoginPassword").type = "password";
        await pdLoadAutomationOverview();
        pdSetMsg("自动登录任务已创建。普通账号密码会自动输入；验证码/安全验证时请在打开的窗口里人工处理。", "ok");
        pdRenderDashboard();
      } catch (err) {
        pdSetMsg(String((err && (err.detail || err.message)) || err || "自动登录任务创建失败"), "err");
      }
    });
  });
  root.querySelectorAll("[data-auto-task]").forEach((node) => {
    node.addEventListener("click", async () => {
      const taskType = String(node.getAttribute("data-auto-task") || "");
      const accountId = pdSelectedAutomationAccountId();
      const platform = pdSelectedAutomationPlatform();
      if (!accountId) {
        pdSetMsg("请先选择执行账号。", "err");
        return;
      }
      const payload = pdAutomationPayload(taskType, persona, platform);
      const validation = pdValidateAutomationPayload(taskType, payload);
      if (validation) {
        pdSetMsg(validation, "err");
        return;
      }
      try {
        pdSetMsg("正在创建社媒自动化任务...", "ok");
        await pdApi("/api/persona_dashboard/automation/tasks", {
          method: "POST",
          body: { persona_id: persona.id, account_id: accountId, platform, task_type: taskType, payload },
        });
        await pdLoadAutomationOverview();
        pdSetMsg("任务已进入自动化队列。", "ok");
        pdRenderDashboard();
      } catch (err) {
        pdSetMsg(String((err && (err.detail || err.message)) || err || "创建任务失败"), "err");
      }
    });
  });
  root.querySelectorAll("[data-auto-logs]").forEach((node) => {
    node.addEventListener("click", () => {
      const taskId = String(node.getAttribute("data-auto-logs") || "");
      if (!taskId) return;
      pdOpenAutomationLogModal(taskId);
    });
  });
  root.querySelectorAll("[data-auto-cancel]").forEach((node) => {
    node.addEventListener("click", async () => {
      const taskId = String(node.getAttribute("data-auto-cancel") || "");
      if (!taskId) return;
      try {
        pdSetMsg("正在取消任务并关闭浏览器...", "ok");
        await pdApi(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(taskId)}/cancel`, {
          method: "POST",
          body: { reason: "用户从网页强制取消" },
        });
        await pdLoadAutomationOverview();
        pdSetMsg("任务已取消。执行中的浏览器上下文已发送关闭信号。", "ok");
        pdRenderDashboard();
      } catch (err) {
        pdSetMsg(String((err && (err.detail || err.message)) || err || "取消任务失败"), "err");
      }
    });
  });
}

async function pdBindThreads(persona) {
  const input = pdEl("personaThreadsInput");
  const username = input ? input.value : "";
  try {
    pdSetMsg("正在保存 Threads 绑定...", "ok");
    await pdApi(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/threads_binding`, {
      method: "POST",
      body: { username },
    });
    pdSetMsg("绑定已保存。可以点击刷新当前人设抓取数据。", "ok");
    await pdLoadDashboard();
  } catch (err) {
    pdSetMsg(String((err && (err.detail || err.message)) || err || "保存绑定失败"), "err");
  }
}

async function pdUnbindThreads(persona) {
  try {
    pdSetMsg("正在解除 Threads 绑定...", "ok");
    await pdApi(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/threads_binding`, {
      method: "DELETE",
    });
    pdSetMsg("账号绑定已解除，旧账号热点缓存已清理。", "ok");
    await pdLoadDashboard();
  } catch (err) {
    pdSetMsg(String((err && (err.detail || err.message)) || err || "解除绑定失败"), "err");
  }
}

async function pdDeletePost(persona, postKey) {
  const ok = window.confirm("确认删除这条推文记录？删除后会立即从当前看板缓存中移除。");
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

window.addEventListener("DOMContentLoaded", () => {
  const refresh = pdEl("btnPersonaDashboardRefresh");
  const refreshAll = pdEl("btnPersonaDashboardRefreshAll");
  if (refresh) refresh.addEventListener("click", () => pdLoadDashboard());
  if (refreshAll) refreshAll.addEventListener("click", () => pdStartRefresh(""));
  ["personaDashboardSearch", "personaDashboardPlatform", "personaDashboardPad", "personaDashboardRange"].forEach((id) => {
    const node = pdEl(id);
    if (!node) return;
    node.addEventListener(id === "personaDashboardSearch" ? "input" : "change", () => {
      personaDashboardPostPage = 1;
      personaDashboardTabPage = 1;
      pdRenderDashboard();
    });
  });
  pdLoadDashboard();
  pdStartAutoPoll();
});
