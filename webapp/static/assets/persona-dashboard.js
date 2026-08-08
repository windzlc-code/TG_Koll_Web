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
let personaDashboardPersonaIndex = 0;
let personaDashboardTrendRange = "day";
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
  const preferred = ["threads", "instagram"];
  const extra = Array.from(platforms)
    .filter((platform) => pdIsWebVisiblePlatform(platform) && !preferred.includes(platform))
    .sort();
  return ["", ...preferred.filter((platform) => platforms.has(platform)), ...extra];
}

function pdPlatformCount(values, platform) {
  const selected = String(platform || "").trim().toLowerCase();
  if (!selected) return 0;
  return Object.entries(values || {}).reduce((sum, [key, value]) => (
    String(key || "").trim().toLowerCase() === selected ? sum + Number(value || 0) : sum
  ), 0);
}

function pdPersonaSupportsPlatform(persona, platform = pdPlatformFilter()) {
  const selected = String(platform || "").trim().toLowerCase();
  if (!selected) return true;
  const counts = persona && persona.counts || {};
  const accounts = Array.isArray(counts.platform_accounts) ? counts.platform_accounts : [];
  return accounts.some((item) => String(item || "").trim().toLowerCase() === selected)
    || pdPlatformCount(counts.platform_posts, selected) > 0
    || pdPlatformCount(counts.platform_published, selected) > 0
    || (persona && persona.hot_platforms || []).some((item) => String(item && item.platform || "").trim().toLowerCase() === selected);
}

function pdRenderDashboardContext(data) {
  const host = pdEl("personaDashboardContext");
  if (!host) return;
  const platforms = pdDashboardPlatforms(data);
  if (personaDashboardPlatform && !platforms.includes(personaDashboardPlatform)) personaDashboardPlatform = "";
  const activeIndex = Math.max(0, platforms.indexOf(pdPlatformFilter()));
  host.innerHTML = `
    <div class="persona-dashboard-context-viewport" data-persona-dashboard-context-viewport>
      <div class="persona-dashboard-context-track" role="tablist" aria-label="平台筛选">
        ${platforms.map((platform) => {
          const isActive = personaDashboardPlatform === platform;
          return `<button
            class="persona-dashboard-context-tab ${isActive ? "is-active" : ""}"
            type="button"
            role="tab"
            aria-selected="${isActive ? "true" : "false"}"
            tabindex="${isActive ? "0" : "-1"}"
            data-platform="${pdEscape(platform || "all")}"
            data-persona-dashboard-platform-option="${pdEscape(platform)}"
          ><span class="persona-dashboard-context-logo" aria-hidden="true">${pdPlatformIcon(platform)}</span><strong>${pdEscape(pdPlatformLabel(platform))}</strong></button>`;
        }).join("")}
      </div>
    </div>
  `;

  const viewport = host.querySelector("[data-persona-dashboard-context-viewport]");
  const selectPlatform = (platform) => {
    const nextPlatform = String(platform || "");
    if (nextPlatform === personaDashboardPlatform) return;
    personaDashboardPlatform = nextPlatform;
    pdRenderDashboard();
  };
  host.querySelectorAll("[data-persona-dashboard-platform-option]").forEach((node) => {
    node.addEventListener("click", () => selectPlatform(node.getAttribute("data-persona-dashboard-platform-option")));
  });
  if (!viewport) return;

  let scrollTimer = 0;
  const settlePlatform = () => {
    if (!viewport.clientWidth) return;
    const nextIndex = Math.max(0, Math.min(platforms.length - 1, Math.round(viewport.scrollLeft / viewport.clientWidth)));
    selectPlatform(platforms[nextIndex]);
  };
  viewport.addEventListener("scroll", () => {
    if (viewport.dataset.ready !== "true") return;
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(settlePlatform, 90);
  }, { passive: true });
  window.requestAnimationFrame(() => {
    viewport.scrollLeft = activeIndex * viewport.clientWidth;
    viewport.dataset.ready = "true";
  });
}

function pdFilterTrend(rows) {
  return rows || [];
}

function pdPersonaHot(persona, platformOverride = pdPlatformFilter()) {
  const platform = String(platformOverride || "").trim().toLowerCase();
  const base = persona.hot || {};
  if (!platform && Object.prototype.hasOwnProperty.call(base, "hot_score")) return base;
  const rows = (persona.hot_platforms || []).filter((item) => (
    !platform || String(item.platform || "").toLowerCase() === platform
  ));
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

function pdPersonaFollowers(persona, platformOverride = pdPlatformFilter()) {
  const platform = String(platformOverride || "").trim().toLowerCase();
  const accountFollowers = new Map();
  (persona && persona.hot_platforms || []).forEach((item, index) => {
    const itemPlatform = String(item && item.platform || "").trim().toLowerCase();
    if (platform && itemPlatform !== platform) return;
    const identity = String(item && (item.account_id || item.username) || index).trim().toLowerCase();
    const key = `${itemPlatform}:${identity}`;
    accountFollowers.set(key, Math.max(accountFollowers.get(key) || 0, Number(item && item.followers || 0)));
  });
  return Array.from(accountFollowers.values()).reduce((sum, value) => sum + value, 0);
}

function pdPlatformPalette(platform = pdPlatformFilter()) {
  const value = String(platform || "").trim().toLowerCase();
  if (value === "threads") return ["#050505", "#2563eb", "#f59e0b"];
  if (value === "instagram") return ["#c13584", "#405de6", "#f77737"];
  return ["#243b53", "#0f8a8a", "#e59d18"];
}

function pdVisibleSummary(visiblePersonas) {
  const selectedPlatform = pdPlatformFilter();
  const summary = {
    persona_count: visiblePersonas.length,
    follower_count: 0,
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
    summary.follower_count += pdPersonaFollowers(persona, selectedPlatform);
    summary.post_count += selectedPlatform ? pdPlatformCount(counts.platform_posts, selectedPlatform) : Number(counts.posts || 0);
    summary.published_count += selectedPlatform ? pdPlatformCount(counts.platform_published, selectedPlatform) : Number(counts.published || 0);
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

function pdRenderPersonaHeatCarousel(hostId, personas, platforms) {
  const host = pdEl(hostId);
  if (!host) return;
  const items = Array.isArray(personas) ? personas : [];
  if (!items.length) {
    host.innerHTML = pdRenderChartPlaceholder("bars", "暂无热度数据");
    return;
  }
  personaDashboardPersonaIndex = Math.max(0, Math.min(items.length - 1, personaDashboardPersonaIndex));
  const selectedPlatform = pdPlatformFilter();
  const platformRows = (platforms || []).filter(Boolean);
  const metricRows = items.flatMap((persona) => [
    Number(pdPersonaHot(persona, "").hot_score || 0),
    ...platformRows.map((platform) => Number(pdPersonaHot(persona, platform).hot_score || 0)),
  ]);
  const max = Math.max(1, ...metricRows);
  host.innerHTML = `
    <div class="persona-heat-carousel-toolbar">
      <span><b data-persona-heat-current>${personaDashboardPersonaIndex + 1}</b> / ${items.length}</span>
      <div class="persona-heat-carousel-actions">
        <button type="button" data-persona-heat-step="-1" aria-label="上一个人设" ${personaDashboardPersonaIndex === 0 ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>
        </button>
        <button type="button" data-persona-heat-step="1" aria-label="下一个人设" ${personaDashboardPersonaIndex === items.length - 1 ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
        </button>
      </div>
    </div>
    <div class="persona-heat-carousel" data-persona-heat-carousel>
      ${items.map((persona, index) => {
        const total = Number(pdPersonaHot(persona, selectedPlatform).hot_score || 0);
        const platformTotal = Number(pdPersonaHot(persona, "").hot_score || 0);
        const platformTotalPct = platformTotal > 0 ? Math.max(3, Math.round((platformTotal / max) * 100)) : 0;
        const heatLabel = selectedPlatform ? `${pdPlatformLabel(selectedPlatform)}热度` : "总热度";
        return `<article class="persona-heat-card" data-persona-heat-index="${index}">
          <header><strong>${pdEscape(persona.name || "未命名人设")}</strong><span>${pdEscape(heatLabel)} <b>${pdEscape(pdNumber(total))}</b></span></header>
          <div class="persona-heat-platform-list">
            <div class="persona-heat-platform-row ${selectedPlatform ? "" : "is-highlighted"}" data-platform="all">
              <span class="persona-heat-platform-label">${pdPlatformIcon("")}<b>全部平台</b></span>
              <span class="persona-heat-platform-track"><i style="width:${platformTotalPct}%"></i></span>
              <strong>${pdEscape(pdNumber(platformTotal))}</strong>
            </div>
            ${platformRows.map((platform) => {
              const value = Number(pdPersonaHot(persona, platform).hot_score || 0);
              const pct = value > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0;
              return `<div class="persona-heat-platform-row ${selectedPlatform === platform ? "is-highlighted" : ""}" data-platform="${pdEscape(platform)}">
                <span class="persona-heat-platform-label">${pdPlatformIcon(platform)}<b>${pdEscape(pdPlatformLabel(platform))}</b></span>
                <span class="persona-heat-platform-track"><i style="width:${pct}%"></i></span>
                <strong>${pdEscape(pdNumber(value))}</strong>
              </div>`;
            }).join("")}
          </div>
        </article>`;
      }).join("")}
    </div>
  `;
  const carousel = host.querySelector("[data-persona-heat-carousel]");
  let programmaticScrollTimer = 0;
  const updateCurrentIndex = (index) => {
    const next = Math.max(0, Math.min(items.length - 1, index));
    personaDashboardPersonaIndex = next;
    const current = host.querySelector("[data-persona-heat-current]");
    if (current) current.textContent = String(next + 1);
    host.querySelectorAll("[data-persona-heat-step]").forEach((button) => {
      const step = Number(button.dataset.personaHeatStep || 0);
      button.disabled = (step < 0 && next === 0) || (step > 0 && next === items.length - 1);
    });
    return next;
  };
  const scrollToIndex = (index, behavior = "smooth") => {
    const next = updateCurrentIndex(index);
    const card = carousel?.querySelector(`[data-persona-heat-index="${next}"]`);
    if (!card || !carousel) return;
    const targetLeft = card.offsetLeft;
    if (behavior === "smooth") {
      if (programmaticScrollTimer) window.clearTimeout(programmaticScrollTimer);
      programmaticScrollTimer = window.setTimeout(() => {
        programmaticScrollTimer = 0;
      }, 420);
    }
    if (Math.abs(carousel.scrollLeft - targetLeft) > 1) carousel.scrollTo({ left: targetLeft, behavior });
  };
  host.querySelectorAll("[data-persona-heat-step]").forEach((button) => {
    button.addEventListener("click", () => scrollToIndex(personaDashboardPersonaIndex + Number(button.dataset.personaHeatStep || 0)));
  });
  let scrollFrame = 0;
  carousel?.addEventListener("scroll", () => {
    if (programmaticScrollTimer) return;
    if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
    scrollFrame = window.requestAnimationFrame(() => {
      const cards = Array.from(carousel.querySelectorAll("[data-persona-heat-index]"));
      const center = carousel.scrollLeft + carousel.clientWidth / 2;
      const nearest = cards.reduce((best, card) => (
        Math.abs(card.offsetLeft + card.offsetWidth / 2 - center) < Math.abs(best.offsetLeft + best.offsetWidth / 2 - center) ? card : best
      ), cards[0]);
      if (nearest) updateCurrentIndex(Number(nearest.dataset.personaHeatIndex || 0));
    });
  }, { passive: true });
  window.requestAnimationFrame(() => scrollToIndex(personaDashboardPersonaIndex, "auto"));
}

function pdRenderDonutChart(hostId, entries, options = {}) {
  const host = pdEl(hostId);
  if (!host) return;
  const rows = pdEntries(entries);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (!total) {
    host.innerHTML = pdRenderChartPlaceholder("donut", "暂无分布数据");
    return;
  }
  const colors = rows.map((row, index) => {
    const platform = String(row.label || "").trim().toLowerCase();
    if (options.platformColors && platform === "threads") return "#050505";
    if (options.platformColors && platform === "instagram") return "#c13584";
    return ["var(--accent)", "#d8992b", "#3f8d67", "#ba554f", "#7b6a9b", "#4f7775"][index % 6];
  });
  let cursor = 0;
  const segments = rows.map((row, index) => {
    const start = cursor;
    const size = (row.value / total) * 100;
    cursor += size;
    return `${colors[index]} ${start}% ${cursor}%`;
  }).join(", ");
  host.innerHTML = `
    <div class="persona-donut-wrap">
      <div class="persona-donut" style="background: conic-gradient(${segments})">
        <div><strong>${pdNumber(total)}</strong><span>总计</span></div>
      </div>
      <div class="persona-donut-legend">
        ${rows.map((row, index) => `
          <div class="${options.platformColors ? "is-platform" : ""}"${options.platformColors ? ` data-platform="${pdEscape(String(row.label || "").trim().toLowerCase())}"` : ""}>${options.platformColors ? `${pdPlatformIcon(row.label)}<em>${pdEscape(pdPlatformLabel(row.label))}</em>` : `<span style="background:${colors[index]}"></span><em>${pdEscape(row.label)}</em>`}<b>${pdEscape(pdNumber(row.value))}</b></div>
        `).join("")}
      </div>
    </div>
  `;
}

function pdAggregateTrendRows(rows, range = personaDashboardTrendRange) {
  const safeRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => /^\d{4}-\d{2}-\d{2}/.test(String(row && row.date || "")))
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
  const keyFor = (row) => {
    const date = String(row.date || "");
    if (range === "year") return date.slice(0, 4);
    if (range === "month") return date.slice(0, 7);
    return date.slice(0, 10);
  };
  const grouped = new Map();
  safeRows.forEach((row) => {
    const key = keyFor(row);
    if (!key) return;
    const current = grouped.get(key) || {
      date: key,
      published: 0,
      post_views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      reposts: 0,
      followers: 0,
      hot_score: 0,
      snapshot_count: 0,
    };
    ["published", "post_views", "likes", "comments", "shares", "reposts"].forEach((field) => {
      current[field] += Number(row[field] || 0);
    });
    if (Number(row.snapshot_count || 0) > 0) {
      current.followers = Number(row.followers || 0);
      current.hot_score = Number(row.hot_score || 0);
      current.snapshot_count += Number(row.snapshot_count || 0);
    }
    grouped.set(key, current);
  });
  const limits = { day: 30, month: 12, year: 5 };
  const groupedRows = Array.from(grouped.values()).sort((left, right) => String(left.date).localeCompare(String(right.date)));
  if (!groupedRows.length) return [];
  const limit = limits[range] || 30;
  const latest = new Date(`${safeRows[safeRows.length - 1].date.slice(0, 10)}T00:00:00Z`);
  const keys = [];
  for (let offset = limit - 1; offset >= 0; offset -= 1) {
    const cursor = new Date(latest);
    if (range === "year") cursor.setUTCFullYear(cursor.getUTCFullYear() - offset);
    else if (range === "month") cursor.setUTCMonth(cursor.getUTCMonth() - offset);
    else cursor.setUTCDate(cursor.getUTCDate() - offset);
    keys.push(range === "year" ? String(cursor.getUTCFullYear()) : cursor.toISOString().slice(0, range === "month" ? 7 : 10));
  }
  return keys.map((date) => grouped.get(date) || {
    date,
    published: 0,
    post_views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    reposts: 0,
    followers: 0,
    hot_score: 0,
    snapshot_count: 0,
  });
}

function pdRenderTrendChart(hostId, rows) {
  const host = pdEl(hostId);
  if (!host) return;
  const items = pdAggregateTrendRows(rows);
  const rangeOptions = [["day", "日"], ["month", "月"], ["year", "年"]];
  const colors = pdPlatformPalette();
  const series = [
    { key: "published", label: "发布", color: colors[0] },
    { key: "post_views", label: "逐帖浏览", color: colors[1] },
    { key: "engagement", label: "互动", color: colors[2] },
    { key: "followers", label: "粉丝", color: "#16a36a" },
    { key: "hot_score", label: "热度", color: pdPlatformFilter() === "instagram" ? "#833ab4" : "#dc335f" },
  ];
  const rangeControls = () => `<div class="persona-trend-range" role="tablist" aria-label="趋势时间范围">
    ${rangeOptions.map(([value, label]) => `<button type="button" role="tab" class="${personaDashboardTrendRange === value ? "is-active" : ""}" aria-selected="${personaDashboardTrendRange === value ? "true" : "false"}" data-persona-trend-range="${value}">${label}</button>`).join("")}
  </div>`;
  const legend = () => `<div class="persona-line-legend">${series.map((item) => `<span><i style="background:${item.color}"></i>${item.label}</span>`).join("")}</div>`;
  if (!items.length) {
    host.innerHTML = `${pdRenderChartPlaceholder("line", "暂无走势数据")}<div class="persona-trend-footer">${rangeControls()}${legend()}</div>`;
    host.querySelectorAll("[data-persona-trend-range]").forEach((button) => {
      button.addEventListener("click", () => {
        personaDashboardTrendRange = String(button.dataset.personaTrendRange || "day");
        pdRenderTrendChart(hostId, rows);
      });
    });
    return;
  }
  const width = 720;
  const height = 250;
  const pad = { top: 20, right: 18, bottom: 38, left: 52 };
  const normalizedItems = items.map((row) => ({
    ...row,
    engagement: Number(row.likes || 0) + Number(row.comments || 0) + Number(row.shares || 0) + Number(row.reposts || 0),
  }));
  const max = Math.max(1, ...normalizedItems.flatMap((row) => series.map((s) => Number(row[s.key] || 0))));
  const x = (index) => pad.left + (normalizedItems.length === 1 ? (width - pad.left - pad.right) / 2 : (index / (normalizedItems.length - 1)) * (width - pad.left - pad.right));
  const y = (value) => height - pad.bottom - (Number(value || 0) / max) * (height - pad.top - pad.bottom);
  const normalizedPathFor = (key) => normalizedItems.map((row, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(row[key]).toFixed(1)}`).join(" ");
  const labelFor = (date) => personaDashboardTrendRange === "day" ? String(date).slice(5) : String(date);
  const labelStep = Math.max(1, Math.ceil(normalizedItems.length / 6));
  host.innerHTML = `
    <svg class="persona-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="流量走势图">
      ${[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
        const gridY = y(max * ratio);
        return `<line x1="${pad.left}" y1="${gridY}" x2="${width - pad.right}" y2="${gridY}" class="persona-grid-line" />
          <text x="${pad.left - 8}" y="${gridY + 4}" text-anchor="end">${pdEscape(pdNumber(max * ratio))}</text>`;
      }).join("")}
      <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" class="persona-axis" />
      ${series.map((s) => `<path d="${normalizedPathFor(s.key)}" fill="none" stroke="${s.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        ${normalizedItems.map((row, index) => `<circle cx="${x(index)}" cy="${y(row[s.key])}" r="3.5" fill="${s.color}" />`).join("")}`).join("")}
      ${normalizedItems.map((row, index) => (index % labelStep === 0 || index === normalizedItems.length - 1) ? `<text x="${x(index)}" y="${height - 10}" text-anchor="middle">${pdEscape(labelFor(row.date))}</text>` : "").join("")}
    </svg>
    <div class="persona-trend-footer">
      ${rangeControls()}
      ${legend()}
    </div>
  `;
  host.querySelectorAll("[data-persona-trend-range]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = String(button.dataset.personaTrendRange || "day");
      if (next === personaDashboardTrendRange) return;
      personaDashboardTrendRange = next;
      pdRenderTrendChart(hostId, rows);
    });
  });
}

function pdRenderSummary(visiblePersonas) {
  const host = pdEl("personaDashboardSummary");
  if (!host) return;
  const summary = pdVisibleSummary(visiblePersonas);
  const cards = [
    { label: "粉丝", value: summary.follower_count, hint: "当前平台账号粉丝总数" },
    { label: "帖子", value: summary.post_count, hint: "当前平台归档帖子" },
    { label: "发布", value: summary.published_count, hint: "当前平台发布归档" },
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
  const overview = pdEl("personaOverviewPane");
  if (!data || !empty) return;
  pdRenderDashboardContext(data);
  const visible = (data.personas || []).filter((persona) => pdPersonaSupportsPlatform(persona));
  const charts = pdBuildFilteredCharts(visible, data);
  pdRenderSummary(visible);
  pdRenderPersonaHeatCarousel("personaHotRankChart", visible, pdDashboardPlatforms(data));
  pdRenderDonutChart("personaPlatformChart", charts.platform_distribution, { platformColors: true });
  pdRenderDonutChart("personaCoverageChart", charts.hot_coverage);
  pdRenderTrendChart("personaTrendChart", charts.trend);
  pdRenderDonutChart("personaEngagementChart", charts.engagement_mix);
  pdRenderDonutChart("personaTaskStatusChart", charts.task_status_distribution);
  if (overview) overview.style.display = "grid";
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

function pdDashboardDataIsComplete(data) {
  return Boolean(
    data
    && Array.isArray(data.personas)
    && data.charts
    && Array.isArray(data.charts.trend)
    && data.charts.platform_trend,
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
  const refresh = pdEl("btnPersonaDashboardSync");
  if (refresh) refresh.addEventListener("click", pdStartRefresh);
}

function pdMountDashboard(root) {
  if (!root) return;
  personaDashboardRoot = root;
  pdBindDashboard(root);
  if (personaDashboardData) {
    pdRenderDashboard();
    if (!pdDashboardDataIsComplete(personaDashboardData) || !pdDashboardViewCacheIsFresh()) {
      void pdLoadDashboard({ silent: true });
    }
  } else {
    void pdLoadDashboard();
  }
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
