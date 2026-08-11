(function collectorConsoleBootstrap() {
  "use strict";

  const root = document.documentElement;
  const page = String(root.dataset.collectorPage || "").trim();
  const $ = (id) => document.getElementById(id);
  const MAX_ROWS = 80;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function safeText(value, fallback = "—", maximum = 120) {
    const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    return (text || fallback).slice(0, maximum);
  }

  function detailMessage(payload, fallback = "请求未完成") {
    const detail = payload && typeof payload === "object" ? payload.detail : "";
    if (typeof detail === "string") return safeText(detail, fallback, 180);
    if (detail && typeof detail === "object" && typeof detail.message === "string") {
      return safeText(detail.message, fallback, 180);
    }
    return fallback;
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch (_error) {
      payload = {};
    }
    if (!response.ok) {
      const error = new Error(detailMessage(payload, `请求失败（${response.status}）`));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload && typeof payload === "object" ? payload : {};
  }

  async function safeRequest(url) {
    try {
      return { ok: true, data: await requestJson(url) };
    } catch (error) {
      return {
        ok: false,
        status: Number(error && error.status) || 0,
        message: safeText(error && error.message, "接口暂不可用", 160),
      };
    }
  }

  function toEpoch(value) {
    const numeric = Number(value || 0);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatTime(value) {
    const epoch = toEpoch(value);
    if (!epoch) return "未记录";
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(epoch));
    } catch (_error) {
      return "已记录";
    }
  }

  function statusTone(status) {
    const value = String(status || "").toLowerCase();
    if (["ok", "ready", "healthy", "success", "completed", "active", "authorized"].includes(value)) return "is-ok";
    if (["failed", "error", "banned", "expired", "abnormal", "disabled", "cancelled"].includes(value)) return "is-error";
    return "is-warning";
  }

  function statusLabel(status) {
    const value = String(status || "unknown").toLowerCase();
    const labels = {
      ready: "可用", ready_unverified: "待复检", healthy: "健康", watch: "观察中",
      queued: "排队中", running: "执行中", success: "成功", completed: "已完成",
      failed: "失败", cancelled: "已取消", need_manual: "需人工", pending_login: "待登录",
      needs_login: "需登录", missing: "缺失", expired: "已过期", degraded: "降级",
      abnormal: "异常", banned: "受限", disabled: "已停用", unknown: "未知",
    };
    return labels[value] || safeText(value, "未知", 28);
  }

  function showNotice(message, error = false) {
    const node = $("collectorNotice");
    if (!node) return;
    node.hidden = !message;
    node.textContent = message || "";
    node.classList.toggle("is-error", Boolean(error));
  }

  function initLogin() {
    const form = $("collectorLoginForm");
    if (!form) return;
    const message = $("collectorLoginMessage");
    const submit = form.querySelector('button[type="submit"]');

    safeRequest("/api/auth/me").then((result) => {
      if (result.ok && Boolean(result.data && result.data.is_admin)) {
        window.location.replace("/collector-admin.html");
      }
    });

    async function submitLogin(forceTakeover) {
      const username = safeText($("collectorUsername")?.value, "", 160);
      const password = String($("collectorPassword")?.value || "");
      const mfaCode = safeText($("collectorMfaCode")?.value, "", 32);
      if (!username || !password) {
        message.textContent = "请输入管理员账号和密码。";
        return;
      }
      submit.disabled = true;
      message.textContent = "正在校验管理员身份…";
      message.classList.remove("is-success");
      try {
        const payload = await requestJson("/api/auth/admin-login", {
          method: "POST",
          body: JSON.stringify({
            username,
            password,
            mfa_code: mfaCode,
            remember_me: Boolean($("collectorRemember")?.checked),
            force_takeover: Boolean(forceTakeover),
          }),
        });
        if (!Boolean(payload.is_admin)) throw new Error("此入口仅允许管理员账号登录。");
        message.textContent = "身份校验通过，正在进入采集节点…";
        message.classList.add("is-success");
        if (Boolean(payload.must_change_password)) {
          window.location.assign("/change-password.html?admin_console=1&return_url=%2Fcollector-admin.html");
        } else {
          window.location.assign("/collector-admin.html");
        }
      } catch (error) {
        const detail = error && error.payload && error.payload.detail;
        const code = detail && typeof detail === "object" ? String(detail.code || "") : "";
        if (!forceTakeover && ["session_conflict", "active_session_exists"].includes(code)) {
          if (window.confirm("检测到该管理员已有活动会话。是否撤销旧会话并继续登录？")) {
            submit.disabled = false;
            await submitLogin(true);
            return;
          }
        }
        message.textContent = safeText(error && error.message, "登录失败，请检查账号、密码或动态验证码。", 180);
      } finally {
        submit.disabled = false;
      }
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitLogin(false);
    });
  }

  const dashboardState = {
    overview: null,
    profiles: null,
    crm: null,
    health: null,
  };

  function setView(view, updateHash = true) {
    const target = String(view || "overview");
    const panel = document.querySelector(`[data-collector-panel="${CSS.escape(target)}"]`);
    if (!panel) return;
    document.querySelectorAll("[data-collector-panel]").forEach((node) => node.classList.toggle("is-active", node === panel));
    document.querySelectorAll("[data-collector-view]").forEach((node) => {
      const active = node.dataset.collectorView === target;
      node.classList.toggle("is-active", active);
      node.setAttribute("aria-current", active ? "page" : "false");
    });
    if (updateHash) window.history.replaceState(null, "", `#${target}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderAccounts(overview) {
    const accounts = Array.isArray(overview?.accounts) ? overview.accounts.slice(0, MAX_ROWS) : [];
    const body = $("collectorAccountsBody");
    if (!body) return;
    if (!accounts.length) {
      body.innerHTML = '<tr><td colspan="5">当前管理员采集账号池暂无数据。</td></tr>';
      return;
    }
    body.innerHTML = accounts.map((account) => {
      const status = safeText(account.effective_status || account.status, "unknown", 32);
      const platform = safeText(account.platform, "unknown", 24);
      const username = safeText(account.username || account.display_name, "未命名账号", 80);
      const proxyBound = account.proxy_configured === true;
      return `<tr>
        <td><span class="collector-table-primary">${escapeHtml(username)}</span><span class="collector-table-secondary">${escapeHtml(platform.toUpperCase())}</span></td>
        <td><span class="collector-status-pill ${statusTone(status)}">${escapeHtml(statusLabel(status))}</span></td>
        <td>${proxyBound ? '<span class="collector-status-pill is-ok">已绑定</span>' : '<span class="collector-status-pill is-warning">未绑定</span>'}</td>
        <td>${Boolean(account.totp_configured) ? '<span class="collector-status-pill is-ok">已配置</span>' : '<span class="collector-status-pill">未配置</span>'}</td>
        <td>${escapeHtml(formatTime(account.status_checked_at || account.updated_at))}</td>
      </tr>`;
    }).join("");
  }

  function renderProxies(overview) {
    const proxies = Array.isArray(overview?.proxies) ? overview.proxies.slice(0, MAX_ROWS) : [];
    const body = $("collectorProxiesBody");
    if (!body) return;
    if (!proxies.length) {
      body.innerHTML = '<tr><td colspan="5">当前管理员采集节点暂无代理资源。</td></tr>';
      return;
    }
    body.innerHTML = proxies.map((proxy) => {
      const status = safeText(proxy.status || proxy.health_status, "unknown", 32);
      const region = [proxy.country, proxy.region, proxy.city].map((item) => safeText(item, "", 36)).filter(Boolean).join(" / ") || "未标记";
      return `<tr>
        <td><span class="collector-table-primary">${escapeHtml(safeText(proxy.name || proxy.display_name, "未命名代理", 80))}</span></td>
        <td>${escapeHtml(safeText(proxy.proxy_type || proxy.protocol, "—", 20).toUpperCase())}</td>
        <td>${escapeHtml(region)}</td>
        <td><span class="collector-status-pill ${statusTone(status)}">${escapeHtml(statusLabel(status))}</span></td>
        <td>${escapeHtml(formatTime(proxy.last_check_at || proxy.health_checked_at || proxy.updated_at))}</td>
      </tr>`;
    }).join("");
  }

  function renderTasks(overview) {
    const tasks = Array.isArray(overview?.tasks) ? overview.tasks.slice(0, MAX_ROWS) : [];
    const body = $("collectorTasksBody");
    if (!body) return;
    if (!tasks.length) {
      body.innerHTML = '<tr><td colspan="5">当前没有采集或 CRM 执行任务。</td></tr>';
      return;
    }
    body.innerHTML = tasks.map((task) => {
      const status = safeText(task.status, "unknown", 32);
      const taskId = safeText(task.id, "—", 80);
      return `<tr>
        <td><span class="collector-table-primary">${escapeHtml(safeText(task.task_type || task.type, "未分类任务", 64))}</span></td>
        <td>${escapeHtml(safeText(task.platform, "—", 24))}<span class="collector-table-secondary">${escapeHtml(safeText(task.account_username || task.account_id, "未指定账号", 72))}</span></td>
        <td><span class="collector-status-pill ${statusTone(status)}">${escapeHtml(statusLabel(status))}</span></td>
        <td>${escapeHtml(formatTime(task.created_at))}</td>
        <td><code>${escapeHtml(taskId.length > 22 ? `${taskId.slice(0, 10)}…${taskId.slice(-8)}` : taskId)}</code></td>
      </tr>`;
    }).join("");
  }

  function renderOverview(overview) {
    const summary = overview?.summary && typeof overview.summary === "object" ? overview.summary : {};
    const accounts = Array.isArray(overview?.accounts) ? overview.accounts : [];
    const tasks = Array.isArray(overview?.tasks) ? overview.tasks : [];
    const accountCount = Number(summary.account_count ?? accounts.length) || 0;
    const readyCount = Number(summary.ready_account_count ?? accounts.filter((item) => String(item.effective_status || item.status) === "ready").length) || 0;
    const activeCount = Number(summary.running_count || 0) + Number(summary.queued_count || 0);
    if ($("metricAccounts")) $("metricAccounts").textContent = String(accountCount);
    if ($("metricReadyAccounts")) $("metricReadyAccounts").textContent = String(readyCount);
    if ($("metricActiveTasks")) $("metricActiveTasks").textContent = String(activeCount || tasks.filter((item) => ["queued", "running"].includes(String(item.status))).length);
    if ($("metricAccountsHint")) $("metricAccountsHint").textContent = accountCount ? "管理员采集账号，不含用户账号" : "尚未建立管理员采集账号";
    renderAccounts(overview);
    renderProxies(overview);
    renderTasks(overview);
  }

  function renderProfiles(payload) {
    const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
    const summary = payload?.summary && typeof payload.summary === "object" ? payload.summary : {};
    if ($("metricCookieProfiles")) $("metricCookieProfiles").textContent = String(Number(summary.authorizedProfileCount ?? 0));
    const hot = $("collectorHotProfiles");
    if (hot) {
      hot.innerHTML = profiles.length
        ? profiles.map((profile) => {
          const health = safeText(profile.authHealth, "unknown", 24);
          const label = safeText(profile.label || profile.platform || profile.key, "未命名平台", 48);
          return `<span class="collector-mini-pill ${statusTone(health)}">${escapeHtml(label)} · ${escapeHtml(statusLabel(health))}</span>`;
        }).join("")
        : '<span class="collector-mini-pill">暂无抓取登录态</span>';
    }
    const cards = $("collectorCookieCards");
    if (!cards) return;
    if (!profiles.length) {
      cards.innerHTML = "<p>当前未检测到 Threads / Instagram Cookie 配置。</p>";
      return;
    }
    cards.innerHTML = profiles.map((profile) => {
      const health = safeText(profile.authHealth, "unknown", 24);
      const label = safeText(profile.label || profile.platform || profile.key, "未命名平台", 48);
      const platform = safeText(profile.platform || profile.sourceKey || profile.key, "unknown", 36);
      const validCount = Math.max(0, Number(profile.validCookieCount || 0));
      const expiredCount = Math.max(0, Number(profile.expiredCookieCount || 0));
      return `<article class="collector-resource-card">
        <header><span class="collector-panel-index">${escapeHtml(platform.toUpperCase())}</span><span class="collector-status-pill ${statusTone(health)}">${escapeHtml(statusLabel(health))}</span></header>
        <h2>${escapeHtml(label)}</h2>
        <p>仅展示服务端计算后的授权健康摘要。</p>
        <dl><div><dt>有效 Cookie</dt><dd>${escapeHtml(validCount)}</dd></div><div><dt>已过期</dt><dd>${escapeHtml(expiredCount)}</dd></div></dl>
      </article>`;
    }).join("");
  }

  function checkCard(key, label, passed, detail) {
    return `<article class="collector-check-card ${passed ? "is-ok" : "is-error"}"><small>${escapeHtml(key)}</small><strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span></article>`;
  }

  function renderCrm(payload, requestOk) {
    const checks = payload?.checks && typeof payload.checks === "object" ? payload.checks : {};
    const ready = requestOk && Boolean(payload?.ready);
    const status = $("overviewCrmStatus");
    if (status) {
      status.classList.toggle("is-ok", ready);
      status.classList.toggle("is-error", !requestOk);
      status.querySelector("span").textContent = requestOk ? (ready ? "CRM 运行检查通过" : "CRM 可访问，部分检查降级") : "CRM 健康接口暂不可用";
    }
    const entries = [
      ["CRM-DB", "数据库结构", Boolean(checks.database && checks.database_schema), checks.database_schema ? "核心 CRM 表结构完整" : "结构检查未通过"],
      ["CRM-UI", "静态工作台", Boolean(checks.static_html && checks.static_assets), checks.static_assets ? "CRM 页面与构建资源可用" : "静态资源需要检查"],
      ["CRM-RUN", "调度与执行", Boolean(checks.scheduler_lease && checks.worker_adapter_registered), checks.scheduler_lease ? "调度租约与执行适配器在线" : "调度或执行适配器降级"],
      ["CRM-DATA", "媒体与磁盘", Boolean(checks.media_writable && checks.disk_ok), checks.disk_ok ? "证据目录可写，磁盘容量正常" : "媒体目录或磁盘容量异常"],
      ["CRM-SIGN", "跟踪签名", Boolean(checks.tracking_secret), checks.tracking_secret ? "签名配置可用" : "跟踪签名尚未就绪"],
      ["CRM-MODE", "模块边界", requestOk, "完整 CRM 留在管理员采集节点"],
    ];
    const container = $("collectorCrmChecks");
    if (container) container.innerHTML = entries.map((entry) => checkCard(...entry)).join("");
  }

  function renderSystem(healthResult, crmResult, overviewResult, profileResult) {
    const systemOk = healthResult.ok && Boolean(healthResult.data?.ok);
    const checks = [
      ["SYS-API", "采集控制面", systemOk, systemOk ? "主服务健康接口响应正常" : healthResult.message || "健康接口不可用"],
      ["SYS-CRM", "CRM 模块", crmResult.ok, crmResult.ok ? "完整 CRM 健康接口可访问" : crmResult.message || "CRM 接口不可用"],
      ["SYS-POOL", "管理员账号池", overviewResult.ok, overviewResult.ok ? "账号与任务安全摘要可读取" : overviewResult.message || "账号池接口不可用"],
      ["SYS-AUTH", "热点登录态", profileResult.ok, profileResult.ok ? "抓取 Cookie 健康摘要可读取" : profileResult.message || "Cookie 接口不可用"],
      ["BOUNDARY", "人设全量刷新", true, "固定由新机执行；旧机只接收最小抓取快照"],
      ["SECURITY", "凭据展示", true, "本页不读取或展示密码、Cookie 值、TOTP 密钥"],
    ];
    const container = $("collectorSystemChecks");
    if (container) container.innerHTML = checks.map((entry) => checkCard(...entry)).join("");
    const badge = $("collectorSystemBadge");
    if (badge) {
      const allCore = healthResult.ok && crmResult.ok && overviewResult.ok;
      badge.textContent = allCore ? "CONTROL ONLINE" : "PARTIAL DATA";
      badge.classList.toggle("is-ok", allCore);
      badge.classList.toggle("is-error", !allCore);
    }
  }

  async function refreshDashboard() {
    showNotice("正在刷新采集节点安全摘要…");
    const [healthResult, crmResult, collectorResult, overviewResult, profileResult] = await Promise.all([
      safeRequest("/api/health"),
      safeRequest("/api/admin/modules/crm/health"),
      safeRequest("/api/admin/collector/overview"),
      safeRequest("/api/persona_dashboard/automation/overview"),
      safeRequest("/api/admin/sentiment/browser_auth/profiles"),
    ]);
    const legacyOverview = overviewResult.ok ? overviewResult.data : {};
    const collectorConfigured = collectorResult.ok && collectorResult.data?.configured === true;
    const mergedOverview = collectorConfigured
      ? {
          ...legacyOverview,
          summary: { ...(legacyOverview.summary || {}), ...(collectorResult.data.summary || {}) },
          accounts: Array.isArray(collectorResult.data.accounts) ? collectorResult.data.accounts : [],
        }
      : legacyOverview;
    dashboardState.health = healthResult.ok ? healthResult.data : null;
    dashboardState.crm = crmResult.ok ? crmResult.data : null;
    dashboardState.overview = (overviewResult.ok || collectorConfigured) ? mergedOverview : null;
    dashboardState.profiles = profileResult.ok ? profileResult.data : null;

    if (overviewResult.ok || collectorConfigured) renderOverview(mergedOverview);
    else {
      renderOverview({ summary: {}, accounts: [], proxies: [], tasks: [] });
    }
    if (profileResult.ok) renderProfiles(profileResult.data);
    else renderProfiles({ profiles: [], summary: {} });
    renderCrm(crmResult.ok ? crmResult.data : {}, crmResult.ok);
    const poolHealthResult = collectorConfigured ? collectorResult : overviewResult;
    renderSystem(healthResult, crmResult, poolHealthResult, profileResult);

    const hotStatus = $("overviewHotStatus");
    if (hotStatus) {
      hotStatus.classList.toggle("is-ok", profileResult.ok);
      hotStatus.classList.toggle("is-error", !profileResult.ok);
      hotStatus.querySelector("span").textContent = profileResult.ok ? "热点抓取配置可读取" : "热点配置摘要暂不可用";
    }
    const failures = [healthResult, crmResult, poolHealthResult, profileResult].filter((item) => !item.ok);
    showNotice(
      failures.length ? `部分只读接口暂不可用（${failures.length}/4），其他模块仍可独立使用。` : "",
      failures.length > 0,
    );
  }

  async function refreshTasksOnly() {
    const result = await safeRequest("/api/persona_dashboard/automation/overview");
    if (result.ok) {
      dashboardState.overview = result.data;
      renderOverview(result.data);
      showNotice("");
    } else {
      showNotice(`任务摘要刷新失败：${result.message}`, true);
    }
  }

  function initClock() {
    const clock = $("collectorClock");
    if (!clock) return;
    const update = () => {
      try {
        clock.textContent = `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date())} CST`;
      } catch (_error) {
        clock.textContent = "CST";
      }
    };
    update();
    window.setInterval(update, 1000);
  }

  async function initDashboard() {
    initClock();
    const auth = await safeRequest("/api/auth/me");
    if (!auth.ok || !Boolean(auth.data && auth.data.is_admin)) {
      window.location.replace("/collector-login.html?return_url=%2Fcollector-admin.html");
      return;
    }
    const operator = $("collectorOperator");
    if (operator) operator.textContent = `管理员 / ${safeText(auth.data.username, "已登录", 48)}`;

    document.querySelectorAll("[data-collector-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.collectorView)));
    document.querySelectorAll("[data-collector-view-jump]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.collectorViewJump)));
    $("collectorRefreshAll")?.addEventListener("click", refreshDashboard);
    $("collectorRefreshTasks")?.addEventListener("click", refreshTasksOnly);
    $("collectorLogout")?.addEventListener("click", async () => {
      try { await requestJson("/api/auth/logout", { method: "POST", body: "{}" }); } catch (_error) { /* redirect still clears the UI session */ }
      window.location.replace("/collector-login.html");
    });
    const initial = String(window.location.hash || "").replace(/^#/, "");
    setView(initial || "overview", false);
    await refreshDashboard();
  }

  if (page === "login") initLogin();
  if (page === "dashboard") initDashboard();
})();
