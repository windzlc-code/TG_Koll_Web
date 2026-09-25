/* Copied from collector console 账号与登录 (account-pool) for admin merge. */
(function () {
  if (typeof api !== "function" || typeof el !== "function") return;

  const PLATFORMS = [["threads", "Threads"], ["instagram", "Instagram"]];
  const SHANGHAI_TZ = "Asia/Shanghai";
  const state = {
    accounts: [],
    platform: "threads",
    selectedIds: [],
    selectedId: "",
    tab: "accounts",
    sessionId: "",
    sessions: [],
    liveBrowserLayout: (function () {
      try { return window.localStorage.getItem("wk-live-browser-layout") === "list" ? "list" : "grid"; } catch (_) { return "grid"; }
    }()),
    liveBrowserExpandedSessionId: "",
    pollTimer: 0,
    totpTimer: 0,
  };

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function platformLabel(platform) {
    return String(platform || "").toLowerCase() === "instagram" ? "Instagram" : "Threads";
  }

  function renderAccountPoolPlatformIcon(platform = "") {
    const value = String(platform || "").trim().toLowerCase();
    if (value === "instagram") {
      return `<svg class="platform-outline-icon platform-outline-icon--instagram" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <rect x="3.5" y="3.5" width="17" height="17" rx="5"></rect>
      <circle cx="12" cy="12" r="4"></circle>
      <circle cx="17.35" cy="6.75" r=".8" fill="currentColor" stroke="none"></circle>
    </svg>`;
    }
    return `<svg class="platform-brand-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M18.263 11.097c-.03-3.486-1.92-5.586-5.111-5.586-2.13 0-3.922.963-4.863 2.499l2.062 1.438c.535-.843 1.272-1.543 2.628-1.543 1.528 0 2.318.85 2.544 2.431a15 15 0 0 0-2.236-.173c-4.125 0-6.068 1.867-6.068 4.336s1.943 3.99 4.804 3.99c3.139 0 5.013-2.115 5.781-4.735.798.361 1.348 1.204 1.348 2.47 0 3.387-3.907 5.232-7.22 5.232-4.885 0-8.077-3.207-8.077-8.424 0-6.392 4.223-10.487 9.9-10.487 3.808 0 5.69 1.671 6.97 3.914l2.108-1.475C21.44 2.078 18.331 0 13.663 0 6.227 0 1.168 5.277 1.168 12.934c0 7 4.953 11.066 10.856 11.066 4.878 0 9.809-2.846 9.809-7.716 0-2.545-1.46-4.231-3.569-5.187m-6.33 4.855c-1.077 0-2.026-.512-2.026-1.453 0-1.483 1.822-1.934 3.606-1.934.678 0 1.34.045 1.927.173-.422 1.927-1.671 3.215-3.508 3.214Z"></path>
    </svg>`;
  }

  function renderClipboardIcon() {
    return `<svg class="ui-action-icon ui-clipboard-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="8" y="8" width="11" height="12" rx="2"></rect>
    <path d="M16 8V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1"></path>
  </svg>`;
  }

  function renderTrashIcon() {
    return `<svg class="ui-trash-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M3 6h18"></path>
    <path d="M8 6V4h8v2"></path>
    <path d="M6 6l1 14h10l1-14"></path>
    <path d="M10 11v6"></path>
    <path d="M14 11v6"></path>
  </svg>`;
  }

  function renderSelectAllIcon() {
    return `<svg class="ui-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="4" y="4" width="16" height="16" rx="4"></rect>
    <path d="m8 12 2.5 2.5L16 9"></path>
  </svg>`;
  }

  function renderClearSelectionIcon() {
    return `<svg class="ui-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="4" y="4" width="16" height="16" rx="4"></rect>
    <path d="m8 16 8-8"></path>
  </svg>`;
  }

  function renderEyeIcon() {
    return `<svg class="ui-eye-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
    <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" fill="none" stroke="currentColor" stroke-width="1.8"></path>
    <circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"></circle>
  </svg>`;
  }

  function renderReplaceIcon() {
    return `<svg class="ui-action-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
    <path d="M4 12a8 8 0 0 1 13.3-6" fill="none" stroke="currentColor" stroke-width="1.8"></path>
    <path d="M20 12a8 8 0 0 1-13.3 6" fill="none" stroke="currentColor" stroke-width="1.8"></path>
    <path d="M16.5 3.5v4h4M7.5 20.5v-4h-4" fill="none" stroke="currentColor" stroke-width="1.8"></path>
  </svg>`;
  }

  function renderModalCloseButton(attr) {
    return `<button type="button" class="console-modal-close" ${attr} title="关闭" aria-label="关闭">
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="m6 6 12 12" fill="none" stroke="currentColor" stroke-width="1.9"></path><path d="m18 6-12 12" fill="none" stroke="currentColor" stroke-width="1.9"></path></svg>
  </button>`;
  }

  function renderPersonaAccountHealthIcon(health) {
    if (health?.tone === "healthy") return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"></circle><path d="m8 12 2.5 2.5L16.5 9"></path></svg>`;
    if (health?.tone === "warning") return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3 2.8 20h18.4L12 3Z"></path><path d="M12 9v4"></path><path d="M12 16.5h.01"></path></svg>`;
    if (health?.tone === "danger") return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"></circle><path d="m9 9 6 6"></path><path d="m15 9-6 6"></path></svg>`;
    return "";
  }

  function accountDisplayedStatus(account) {
    return String(account?.status || "pending_login").trim().toLowerCase();
  }

  function accountStatusDisplayLabel(status) {
    const key = String(status || "").trim().toLowerCase();
    if (["ready", "ready_unverified", "success", "standby"].includes(key)) return "已登录";
    if (["risk_control", "disabled", "banned", "blocked", "suspended", "platform_restricted", "unavailable"].includes(key)) return "账号封控";
    return "未登录";
  }

  function accountStatusClassNames(status) {
    const key = String(status || "unknown").trim().toLowerCase();
    if (key === "ready") return "ready";
    if (["pending_login", "cookie_expired"].includes(key)) return "pending_login";
    if (["risk_control", "disabled", "banned", "blocked", "suspended"].includes(key)) return "abnormal";
    return "pending_login";
  }

  function accountStatusIconTone(status) {
    const key = String(status || "").trim().toLowerCase();
    if (["ready", "ready_unverified", "success", "standby"].includes(key)) return "healthy";
    if (["risk_control", "disabled", "banned", "blocked", "suspended"].includes(key)) return "danger";
    return "warning";
  }

  function formatCheckedAt(unix) {
    const n = Number(unix || 0);
    if (!n) return "未检测";
    try {
      return new Date(n * 1000).toLocaleString("zh-CN", {
        timeZone: SHANGHAI_TZ,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    } catch (_) {
      return "未检测";
    }
  }

  function accountLastLoginCheckLabel(account) {
    if (!account) return "未知 · 未检测";
    const status = accountDisplayedStatus(account);
    const checkedAt = Number(account.last_login_check_at || account.updated_at || 0);
    return `${accountStatusDisplayLabel(status)} · ${formatCheckedAt(checkedAt)}`;
  }

  function accountTotpStatusLabel(status, configured) {
    const key = String(status || "").trim().toLowerCase();
    if (!configured) return "2FA 未配置";
    if (key === "verified") return "2FA 已验证";
    if (key === "pending") return "2FA 待验证";
    if (["invalid", "error"].includes(key)) return "2FA 异常";
    if (key === "disabled") return "2FA 已停用";
    return "2FA 已验证";
  }

  function renderAccountTotpBadge(account) {
    const accountId = String(account?.id || "");
    const configured = Boolean(account?.totp_configured);
    const status = String(account?.totp_status || (configured ? "verified" : "")).trim().toLowerCase();
    const label = accountTotpStatusLabel(status, configured);
    return `<span class="account-totp-badge" data-account-totp-for="${esc(accountId)}" data-totp-status="${esc(status)}" ${configured ? "" : "hidden"} title="${esc(label)}">${esc(label)}</span>`;
  }

  function renderAccountStatusContent(account) {
    const status = accountDisplayedStatus(account);
    const iconTone = accountStatusIconTone(status);
    return `<span class="account-status-icon is-${esc(iconTone)}" aria-hidden="true">${renderPersonaAccountHealthIcon({ tone: iconTone })}</span><span class="account-status-label">${esc(accountLastLoginCheckLabel(account))}</span>`;
  }

  function looksLikeExitIp(value) {
    const text = String(value || "").trim();
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return true;
    return text.includes(":") && !/proxy-cheap|thehub/i.test(text);
  }

  function accountResidentialProxyLabel(account) {
    const exitIp = String(account?.proxy_exit_ip || "").trim();
    if (exitIp) return `住宅 IP：${exitIp}`;
    const host = String(account?.proxy_host || "").trim();
    if (host && looksLikeExitIp(host)) return `住宅 IP：${host}`;
    if (account?.proxy_id) return "住宅 IP：已绑定，待检测出口";
    return "未使用代理 IP";
  }

  function collectorAccounts() {
    return (state.accounts || []).filter((item) => {
      if (!item.is_admin_owned) return false;
      const provider = String(item.auth_provider || "browser").trim().toLowerCase() || "browser";
      if (["bundle", "oauth", "threads_oauth", "instagram_oauth", "meta"].includes(provider)) return false;
      const platform = String(item.platform || "").trim().toLowerCase();
      return platform === "threads" || platform === "instagram";
    });
  }

  function platformAccounts() {
    return collectorAccounts().filter((item) => String(item.platform || "threads").toLowerCase() === state.platform);
  }

  function renderAccountPoolOps(accounts) {
    const selectedIds = new Set(state.selectedIds.map(String));
    const selectedCount = selectedIds.size;
    const allSelected = Boolean(accounts.length) && selectedCount === accounts.length;
    const selectionAction = allSelected ? "clear" : "all";
    const selectionLabel = allSelected ? "取消全选" : "全选账号";
    return `
    <div class="account-pool-ops">
      <button type="button" class="account-pool-add-button" data-account-pool-add id="btnFingerprintAddAccount">
        <span aria-hidden="true"></span>
        <strong>添加账号</strong>
      </button>
      <div class="account-pool-edit-toolbar" role="toolbar" aria-label="账号编辑操作">
        <span class="account-pool-selection-count">${esc(selectedCount ? `已选 ${selectedCount} 个` : "未选择")}</span>
        <button type="button" data-account-pool-copy-selected title="复制账号卡" aria-label="复制账号卡" ${selectedCount ? "" : "disabled"}><span aria-hidden="true"></span></button>
        <button type="button" class="bulk-selection-icon-button" data-account-pool-selection="${selectionAction}" title="${selectionLabel}" aria-label="${selectionLabel}" ${accounts.length ? "" : "disabled"}>${allSelected ? renderClearSelectionIcon() : renderSelectAllIcon()}</button>
        <button type="button" class="danger unified-action-icon-button" data-account-pool-delete-selected title="删除账号" aria-label="删除账号" ${selectedCount ? "" : "disabled"}>${renderTrashIcon()}</button>
      </div>
    </div>`;
  }

  function renderAccountPoolPlatformTabs(accounts) {
    return `
    <section class="account-pool-platform-panel">
      <div class="account-pool-section-head">
        <strong>操作</strong>
      </div>
      ${renderAccountPoolOps(accounts)}
      <div class="account-pool-platforms account-pool-platform-tabs" data-account-pool-platform-tabs role="tablist" aria-label="平台">
        ${PLATFORMS.map(([value, label]) => {
          const isActive = state.platform === value;
          return `<button type="button" class="${isActive ? "is-active" : ""}" data-account-pool-platform="${esc(value)}" role="tab" aria-selected="${isActive ? "true" : "false"}" aria-label="${esc(label)}">
            ${renderAccountPoolPlatformIcon(value)}
            <strong>${esc(label)}</strong>
          </button>`;
        }).join("")}
      </div>
    </section>`;
  }

  function renderAccountPoolCardFields(account, { selectionControl = "", includeCopyButton = false } = {}) {
    const accountId = String(account?.id || "");
    const platform = String(account?.platform || "threads").toLowerCase();
    const platformCopy = platformLabel(platform);
    return `<span class="account-pool-card-main">
    ${selectionControl}
    <small class="account-pool-card-platform">
      ${renderAccountPoolPlatformIcon(platform)}
      <span>${esc(platformCopy)}</span>
    </small>
    <span class="account-pool-card-copy">
      <span class="account-pool-card-title-line">
        <strong title="${esc(account.username || accountId)}">${esc(account.username || accountId)}</strong>
        ${includeCopyButton ? `<button type="button" class="account-pool-card-copy-button" data-account-pool-copy-card="${esc(accountId)}" title="复制账号字段" aria-label="复制账号字段">${renderClipboardIcon()}</button>` : ""}
      </span>
    </span>
    <span class="account-pool-card-flags">
      <span class="status ${esc(accountStatusClassNames(accountDisplayedStatus(account)))}" data-account-status-for="${esc(accountId)}" title="${esc(accountLastLoginCheckLabel(account))}">${renderAccountStatusContent(account)}</span>
      ${renderAccountTotpBadge(account)}
    </span>
  </span>`;
  }

  function renderAccountPoolCardActions(account) {
    const accountId = String(account?.id || "");
    const proxyLabel = account?.proxy_id ? "切换代理" : "选择代理";
    const loginDisabled = String(account?.auth_provider || "browser").toLowerCase() === "bundle" ? "disabled" : "";
    return `<div class="row-actions">
    <button type="button" class="primary" data-fp-login="${esc(accountId)}" ${loginDisabled}>自动登录</button>
    <button type="button" data-fp-proxy="${esc(accountId)}">${proxyLabel}</button>
    <button type="button" data-fp-edit="${esc(accountId)}" ${loginDisabled}>编辑</button>
    <button type="button" class="danger" data-fp-delete="${esc(accountId)}">删除</button>
  </div>`;
  }

  function renderAccountPoolCard(account, { active = false, checked = false } = {}) {
    const accountId = String(account?.id || "");
    const accountPlatform = String(account?.platform || "threads").toLowerCase();
    const selectionControl = `<label class="account-pool-card-check" aria-label="多选账号">
      <input type="checkbox" data-account-pool-check="${esc(accountId)}" ${checked ? "checked" : ""} />
      <span aria-hidden="true"></span>
    </label>`;
    return `<article class="account-card account-pool-card ${active ? "is-active" : ""} ${checked ? "is-checked" : ""}" data-account-platform="${esc(accountPlatform)}" data-account-pool-account="${esc(accountId)}" role="button" tabindex="0" aria-pressed="${active ? "true" : "false"}">
    ${renderAccountPoolCardFields(account, { selectionControl, includeCopyButton: true })}
    <div class="account-card-meta">
      <span data-account-proxy-for="${esc(accountId)}">${esc(accountResidentialProxyLabel(account))}</span>
    </div>
    ${renderAccountPoolCardActions(account)}
  </article>`;
  }

  function renderAccountPoolCards(accounts) {
    const selectedIds = new Set(state.selectedIds.map(String));
    const list = accounts.length
      ? accounts.map((item) => renderAccountPoolCard(item, {
        active: state.selectedId === item.id,
        checked: selectedIds.has(item.id),
      })).join("")
      : `<div class="account-pool-empty-state" role="status">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="8" r="3.5"></circle><path d="M5.5 20c.65-3.28 2.72-5 6.5-5s5.85 1.72 6.5 5"></path><path d="M18.2 5.8v4.1M16.15 7.85h4.1"></path></svg>
            <strong>暂无账号</strong>
            <span>点击左侧添加账号，开始配置当前平台</span>
          </div>`;
    return `
    <section class="account-pool-account-panel">
      <div class="account-pool-section-head">
        <strong>账号</strong>
        <span class="account-pool-count">${esc(`${accounts.length} 个`)}</span>
      </div>
      <div class="account-pool-content-window">
        <div class="account-pool-content">
          <div class="account-pool-list account-pool-list--grid">${list}</div>
        </div>
      </div>
    </section>`;
  }

  function pulseAccountPoolPlatformContent() {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    const content = document.querySelector("#fpAccountGrid .account-pool-content-window > .account-pool-content");
    if (!content || !content.querySelector(".account-pool-card")) return;
    content.classList.remove("is-platform-refresh-pulse");
    void content.offsetWidth;
    content.classList.add("is-platform-refresh-pulse");
    window.setTimeout(() => content.classList.remove("is-platform-refresh-pulse"), 760);
  }

  function renderPool() {
    const host = el("fpAccountGrid");
    if (!host) return;
    const accounts = platformAccounts();
    host.innerHTML = `
    <div class="account-pool-layout account-pool-layout--standalone">
      <section class="account-pool-main">
        <div class="account-pool-body">
          ${renderAccountPoolPlatformTabs(accounts)}
          ${renderAccountPoolCards(accounts)}
        </div>
      </section>
    </div>`;
  }

  function sessionViewerUrl(session) {
    const raw = String(session?.view_path || session?.kasm_path || session?.novnc_path || session?.kasm_url || "").trim();
    if (!raw) return "";
    if (/[?&]admin_console=/.test(raw)) return raw;
    return raw + (raw.includes("?") ? "&" : "?") + "admin_console=1";
  }

  function liveBrowserSessionId(session) {
    return String(session?.id || session?.session_id || "");
  }

  function loginMonitorSessions(sessions) {
    return (Array.isArray(sessions) ? sessions : []).filter((session) => ["open_login", "check_login"].includes(String(session?.task_type || "").trim().toLowerCase()));
  }

  function normalizeLiveBrowserLayout(layout) {
    return String(layout || "").trim().toLowerCase() === "list" ? "list" : "grid";
  }

  function liveBrowserPanelHint(sessions) {
    if (!sessions.length) {
      return "暂无运行中的自动登录窗口。点击账号池中的自动登录后，实时画面会显示在这里。";
    }
    return `${sessions.length} 个自动登录窗口正在运行，当前仅展示实时画面；需要验证时可人工接管。`;
  }

  function renderLiveBrowserLayoutToggle(layout) {
    const activeLayout = normalizeLiveBrowserLayout(layout);
    return `
    <div class="persona-draft-view-toggle live-browser-layout-toggle" aria-label="浏览器窗口布局">
      <button type="button" class="${activeLayout === "grid" ? "is-active" : ""}" data-live-browser-layout="grid" title="格子布局" aria-label="格子布局" aria-pressed="${activeLayout === "grid" ? "true" : "false"}">
        <span class="persona-draft-mode-icon persona-draft-mode-icon--grid" aria-hidden="true"></span>
      </button>
      <button type="button" class="${activeLayout === "list" ? "is-active" : ""}" data-live-browser-layout="list" title="列表布局" aria-label="列表布局" aria-pressed="${activeLayout === "list" ? "true" : "false"}">
        <span class="persona-draft-mode-icon persona-draft-mode-icon--list" aria-hidden="true"></span>
      </button>
    </div>`;
  }

  function renderLiveBrowserPlaceholder(index) {
    return `
    <article class="live-browser-card live-browser-placeholder" data-live-browser-placeholder aria-label="实时浏览器占位框 ${index}">
      <div class="live-browser-placeholder-body">
        <strong>等待登录窗口 ${index}</strong>
        <span>从账号池启动自动登录后，实时画面会添加到这里。</span>
      </div>
    </article>`;
  }

  function liveBrowserStatusLabel(session) {
    const status = String(session?.task_status || session?.status || "running").trim().toLowerCase();
    if (status === "need_manual") return "人工登录";
    if (status === "queued") return "排队中";
    if (status === "success") return "已完成";
    if (status === "failed") return "失败";
    if (status === "standby") return "待机";
    if (session?.browser_ready === false) return "Camoufox 启动中";
    return "运行中";
  }

  function renderExpandIcon() {
    return `<svg class="ui-expand-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M9 3H3v6M15 3h6v6M9 21H3v-6M21 15v6h-6" fill="none" stroke="currentColor" stroke-width="1.8"></path></svg>`;
  }

  function renderLiveBrowserSession(session) {
    const sessionId = liveBrowserSessionId(session);
    const url = sessionViewerUrl(session);
    const account = collectorAccounts().find((item) => item.id === session.account_id) || {};
    const username = String(session.account_username || account.username || session.account_id || "未获取");
    const platform = platformLabel(session.platform || account.platform || "");
    const width = Math.max(1, Number(session.width || 1280));
    const height = Math.max(1, Number(session.height || 720));
    const orientationClass = height > width ? " is-portrait" : " is-landscape";
    const title = `账号：${username}`;
    const status = liveBrowserStatusLabel(session);
    const proxyHost = String(account.proxy_host || "").trim();
    return `
    <article class="live-browser-card${orientationClass}" data-live-browser-card="${esc(sessionId)}" style="--live-browser-width: ${width}; --live-browser-height: ${height}; --live-browser-ratio: ${width} / ${height};">
      <div class="live-browser-card-head">
        <div class="live-browser-card-identity">
          <strong data-live-browser-title>${esc(title)}</strong>
          <span>平台：${esc(platform)}</span>
        </div>
        <div class="live-browser-card-actions">
          <button type="button" class="live-browser-expand-button" data-live-browser-fullscreen="${esc(sessionId)}" title="放大窗口" aria-label="放大窗口">${renderExpandIcon()}</button>
          <button type="button" data-live-browser-close="${esc(sessionId)}">关闭窗口</button>
          <span class="status running" data-live-browser-status>${esc(status)}</span>
        </div>
      </div>
      <div class="live-browser-frame">
        <iframe title="${esc(title)}" src="${esc(url || "about:blank")}" loading="eager" referrerpolicy="no-referrer" allow="clipboard-read; clipboard-write" allowfullscreen></iframe>
      </div>
      <div class="live-browser-interaction-note">
        <div class="live-browser-interaction-context">
          <span>当前模式：自动登录</span>
          <span>当前 IP：${esc(proxyHost || "未使用代理 IP")}</span>
        </div>
        <span>从账号池启动自动登录后，实时画面会显示在这里。</span>
      </div>
    </article>`;
  }

  function renderLiveBrowserSessions() {
    const host = el("fpLiveBrowserSessions");
    if (!host) return;
    const sessions = loginMonitorSessions(state.sessions);
    const layout = normalizeLiveBrowserLayout(state.liveBrowserLayout);
    const placeholders = Array.from({ length: Math.max(0, 2 - sessions.length) }, (_, index) => renderLiveBrowserPlaceholder(index + 1)).join("");
    host.innerHTML = `
    <section class="live-browser-panel ${sessions.length ? "" : "is-empty"}" data-live-browser-count="${sessions.length}" data-live-browser-view="${esc(layout)}">
      <div class="live-browser-head">
        <div>
          <strong>自动登录监控</strong>
          <span data-live-browser-panel-hint>${esc(liveBrowserPanelHint(sessions))}</span>
        </div>
        <div class="live-browser-head-actions">
          ${renderLiveBrowserLayoutToggle(layout)}
        </div>
      </div>
      <div class="live-browser-grid">
        ${sessions.map((item) => renderLiveBrowserSession(item)).join("")}
        ${placeholders}
      </div>
    </section>`;
  }

  function stopPoll() {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = 0;
    }
  }

  async function refreshSessions() {
    const payload = await api("/api/admin/fingerprint-login/sessions");
    state.sessions = loginMonitorSessions(payload?.sessions);
    if (state.tab === "monitor") renderLiveBrowserSessions();
    return state.sessions;
  }

  function startPoll() {
    stopPoll();
    state.pollTimer = window.setInterval(() => { void refreshSessions().catch(() => null); }, 2500);
  }

  async function loadAccounts() {
    setMsg("fingerprintLoginMsg", "");
    try {
      const payload = await api("/api/admin/fingerprint-login/accounts");
      state.accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
      renderPool();
      await refreshSessions().catch(() => null);
    } catch (error) {
      setMsg("fingerprintLoginMsg", getErrorMessage(error), false);
    }
  }

  function setTab(tab) {
    state.tab = tab === "monitor" ? "monitor" : "accounts";
    const shell = el("secFingerprintLogin");
    if (shell) shell.dataset.accountBrowserPanel = state.tab === "monitor" ? "browsers" : "accounts";
    if (state.tab === "monitor") {
      renderLiveBrowserSessions();
      startPoll();
    }
    document.querySelectorAll("#secFingerprintLogin [data-fp-tab]").forEach((node) => {
      node.classList.toggle("is-active", node.dataset.fpTab === state.tab);
    });
    document.querySelectorAll("#secFingerprintLogin [data-fp-panel]").forEach((node) => {
      const active = node.dataset.fpPanel === state.tab;
      node.classList.toggle("is-active", active);
      node.hidden = !active;
    });
  }

  function closeCollectorModal() {
    document.getElementById("fpCollectorModal")?.remove();
    if (state.totpTimer) {
      window.clearInterval(state.totpTimer);
      state.totpTimer = 0;
    }
  }

  function isStickyAccount(account) {
    return Boolean(account?.proxy_id) && String(account?.proxy_source || "").toLowerCase() === "collector_sticky";
  }

  function proxySimpleChoicesHtml(account, choice) {
    const selected = choice === "sticky" ? "sticky" : "none";
    const exitIp = String(account?.proxy_exit_ip || "").trim();
    const expiresAt = Number(account?.proxy_expires_at || 0);
    let expiry = "待分配";
    if (expiresAt > 0) {
      try {
        expiry = new Date(expiresAt * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
      } catch (_) {}
    }
    const stickyDetail = isStickyAccount(account)
      ? `当前出口 ${exitIp || "已检测"} · 本轮至 ${expiry}`
      : "确认后自动检测并绑定独享会话";
    return `<div class="account-proxy-options account-proxy-simple-choices" data-account-proxy-options role="radiogroup" aria-label="选择代理">
    <button type="button" class="account-proxy-option ${selected === "none" ? "is-selected" : ""}" data-account-proxy-choice="none" aria-pressed="${selected === "none" ? "true" : "false"}">
      <span class="account-proxy-option-check" aria-hidden="true"></span>
      <strong>不使用代理</strong>
      <span>账号将直接连接网络</span>
      <small>随时可以重新选择</small>
    </button>
    <button type="button" class="account-proxy-option ${selected === "sticky" ? "is-selected" : ""}" data-account-proxy-choice="sticky" aria-pressed="${selected === "sticky" ? "true" : "false"}">
      <span class="account-proxy-option-check" aria-hidden="true"></span>
      <strong>使用粘性 IP</strong>
      <span>账号独享会话 · 30 分钟自动换会话</span>
      <small>${esc(stickyDetail)}</small>
    </button>
  </div>`;
  }

  function openProxyPicker(accountId) {
    const account = state.accounts.find((item) => item.id === accountId);
    if (!account) return;
    closeCollectorModal();
    const initial = isStickyAccount(account) ? "sticky" : "none";
    const modal = document.createElement("div");
    modal.id = "fpCollectorModal";
    modal.className = "console-modal";
    modal.dataset.selectedProxyChoice = initial;
    modal.innerHTML = `
      <div class="console-modal-backdrop" data-fp-modal-cancel></div>
      <section class="console-modal-dialog account-proxy-picker-modal account-proxy-picker-modal--simple" role="dialog" aria-modal="true">
        <div class="console-modal-head">
          <div><strong>选择代理 IP</strong><p>${esc(account.username || account.id)} · 一个账号同时只绑定一个代理</p></div>
          ${renderModalCloseButton("data-fp-modal-cancel")}
        </div>
        <div class="console-modal-content">
          <p class="account-proxy-picker-summary" data-account-proxy-selection-summary>${isStickyAccount(account) ? `当前绑定：${esc(accountResidentialProxyLabel(account))}` : "当前未使用代理 IP"}</p>
          ${proxySimpleChoicesHtml(account, initial)}
        </div>
        <div class="console-modal-actions">
          <button type="button" class="primary" data-fp-proxy-save="${esc(account.id)}">确认绑定</button>
          <button type="button" data-fp-modal-cancel>取消</button>
        </div>
      </section>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", async (event) => {
      const choice = event.target.closest("[data-account-proxy-choice]");
      if (choice) {
        const next = choice.dataset.accountProxyChoice === "sticky" ? "sticky" : "none";
        modal.dataset.selectedProxyChoice = next;
        modal.querySelectorAll("[data-account-proxy-choice]").forEach((btn) => {
          const on = btn.dataset.accountProxyChoice === next;
          btn.classList.toggle("is-selected", on);
          btn.setAttribute("aria-pressed", on ? "true" : "false");
        });
        const summary = modal.querySelector("[data-account-proxy-selection-summary]");
        if (summary) summary.textContent = next === "sticky" ? "已选择：使用粘性 IP" : "已选择：不使用代理";
        return;
      }
      if (event.target.closest("[data-fp-modal-cancel]")) {
        closeCollectorModal();
        return;
      }
      const save = event.target.closest("[data-fp-proxy-save]");
      if (!save) return;
      if (modal.dataset.accountProxyStickyBusy === "true") return;
      const selectedChoice = modal.dataset.selectedProxyChoice || "none";
      modal.dataset.accountProxyStickyBusy = "true";
      modal.querySelectorAll("[data-account-proxy-choice], [data-fp-proxy-save], [data-fp-modal-cancel]").forEach((btn) => { btn.disabled = true; });
      const summary = modal.querySelector("[data-account-proxy-selection-summary]");
      if (summary && selectedChoice === "sticky") summary.textContent = "正在检测出口 IP…";
      try {
        await api(`/api/admin/fingerprint-login/accounts/${encodeURIComponent(save.dataset.fpProxySave)}/proxy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ choice: selectedChoice }),
        });
        closeCollectorModal();
        await loadAccounts();
      } catch (error) {
        setMsg("fingerprintLoginMsg", getErrorMessage(error), false);
        if (modal.isConnected) {
          delete modal.dataset.accountProxyStickyBusy;
          modal.querySelectorAll("[data-account-proxy-choice], [data-fp-proxy-save], [data-fp-modal-cancel]").forEach((btn) => { btn.disabled = false; });
          if (summary) summary.textContent = "粘性 IP 绑定失败，请重试";
        }
      }
    });
  }

  function totpDateLabel(value) {
    const n = Number(value || 0);
    if (!n) return "尚无记录";
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toLocaleString("zh-CN", {
      timeZone: SHANGHAI_TZ,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  function startTotpClock(modal, accountId) {
    if (state.totpTimer) window.clearInterval(state.totpTimer);
    const tick = async () => {
      if (!modal.isConnected) {
        window.clearInterval(state.totpTimer);
        return;
      }
      try {
        const payload = await api(`/api/admin/fingerprint-login/accounts/${encodeURIComponent(accountId)}/totp/code`);
        const totp = payload.totp || {};
        const current = payload.current_code || {};
        const body = modal.querySelector("[data-account-totp-body]");
        const stateNode = modal.querySelector("[data-account-totp-state]");
        if (stateNode) {
          stateNode.textContent = accountTotpStatusLabel(totp.status, true);
          stateNode.classList.add("is-configured");
          stateNode.dataset.totpStatus = totp.status || "verified";
        }
        if (!body) return;
        if (!body.querySelector("[data-account-totp-code-card]")) {
          body.innerHTML = `
        <div class="account-totp-code-card" data-account-totp-code-card>
          <div class="account-totp-code-main">
            <span>当前验证码</span>
            <div class="account-totp-code-value">
              <strong data-account-totp-code>------</strong>
              <button type="button" data-account-totp-copy title="复制验证码">${renderClipboardIcon()}</button>
            </div>
          </div>
          <div class="account-totp-countdown" data-account-totp-ring-wrap>
            <svg viewBox="0 0 42 42" aria-hidden="true"><circle class="account-totp-ring-track" cx="21" cy="21" r="16" pathLength="100"></circle><circle class="account-totp-ring-value" data-account-totp-ring cx="21" cy="21" r="16" pathLength="100"></circle></svg>
            <span><strong data-account-totp-countdown>--</strong><small>秒</small></span>
          </div>
          <dl class="account-totp-meta"><div><dt>更新时间</dt><dd data-account-totp-updated>尚无记录</dd></div></dl>
          <div class="account-totp-code-actions">
            <button type="button" class="account-inline-action" data-account-totp-update>${renderReplaceIcon()}<span>更新密钥</span></button>
            <button type="button" class="danger account-inline-action" data-account-totp-delete>${renderTrashIcon()}<span>移除 2FA</span></button>
          </div>
        </div>`;
        }
        const remain = Math.max(0, Number(current.valid_for_seconds || (current.expires_at - Math.floor(Date.now() / 1000)) || 0));
        const period = Number(current.period_seconds || 30);
        body.querySelector("[data-account-totp-code]").textContent = current.code || "------";
        body.querySelector("[data-account-totp-countdown]").textContent = String(remain);
        body.querySelector("[data-account-totp-updated]").textContent = totpDateLabel(totp.updated_at);
        const ring = body.querySelector("[data-account-totp-ring]");
        if (ring) ring.style.strokeDashoffset = String(100 - Math.round((remain / period) * 100));
        const wrap = body.querySelector("[data-account-totp-ring-wrap]");
        if (wrap) wrap.dataset.urgent = remain <= 5 ? "true" : "false";
      } catch (_) {
        const body = modal.querySelector("[data-account-totp-body]");
        if (body && !body.querySelector("[data-account-totp-entry]")) {
          body.innerHTML = `<div class="account-totp-entry" data-account-totp-entry>
            <label><span>2FA 密钥</span><input data-account-totp-secret placeholder="输入 Base32 或 otpauth://..." autocomplete="off"></label>
            <div class="account-totp-entry-actions"><button type="button" class="primary" data-account-totp-submit>添加 2FA</button></div>
          </div>`;
        }
      }
    };
    void tick();
    state.totpTimer = window.setInterval(tick, 1000);
  }

  function openEditor(account) {
    closeCollectorModal();
    const editing = Boolean(account?.id);
    const platform = account?.platform || state.platform;
    const modal = document.createElement("div");
    modal.id = "fpCollectorModal";
    modal.className = "console-modal";
    modal.innerHTML = `
      <div class="console-modal-backdrop" data-fp-modal-cancel></div>
      <section class="console-modal-dialog account-pool-create-modal" role="dialog" aria-modal="true">
        <div class="console-modal-head">
          <strong>${editing ? "编辑账号" : "添加账号"}</strong>
          <div class="account-pool-create-modal-head-actions">
            ${renderModalCloseButton("data-fp-modal-cancel")}
          </div>
        </div>
        <div class="console-modal-content">
          <div class="account-pool-create-modal-body">
            <div class="account-pool-editor-platform">
              <span>平台：</span>${renderAccountPoolPlatformIcon(platform)}<strong>${esc(platformLabel(platform))}</strong>
            </div>
            <div class="account-create-form account-create-form--modal">
              <label><span>账号用户名</span><input id="fpEditorUsername" value="${esc(account?.username || "")}" placeholder="例如：liliacvuiy575" autocomplete="off"></label>
              <label class="persona-account-inline-field persona-account-inline-field--password account-password-field--modal">
                <span>登录密码</span>
                <span class="account-password-display account-password-display--input">
                  <input id="fpEditorPassword" class="account-inline-password-input" type="password" value="" placeholder="${editing ? "••••••••" : "用于自动登录，可稍后再填"}" autocomplete="new-password">
                  <button type="button" class="account-password-toggle" data-fp-password-toggle="${esc(account?.id || "")}" title="显示登录密码">${renderEyeIcon()}</button>
                </span>
              </label>
            </div>
            <section class="account-totp-section" data-account-totp-section>
              <div class="account-totp-head">
                <div><strong>两步验证 (2FA)</strong><span>支持 Base32 密钥或 otpauth URI</span></div>
                <span class="account-totp-state" data-account-totp-state>${account?.totp_configured ? accountTotpStatusLabel(account.totp_status, true) : "2FA 未配置"}</span>
              </div>
              <div class="account-totp-body" data-account-totp-body></div>
            </section>
            <section class="account-residential-proxy account-proxy-picker-panel">
              <div class="account-residential-proxy-head">
                <div class="account-proxy-inline-summary"><strong>代理 IP</strong><span>${esc(accountResidentialProxyLabel(account || {}))}</span></div>
                ${editing ? `<button type="button" class="account-proxy-inline-open" data-fp-open-proxy="${esc(account.id)}">${account?.proxy_id ? "切换代理" : "选择代理"}</button>` : `<span class="account-proxy-inline-hint">保存账号后可选择粘性 IP</span>`}
              </div>
            </section>
          </div>
        </div>
        <div class="console-modal-actions">
          <button type="button" class="primary" data-fp-editor-save="${esc(account?.id || "")}" data-fp-editor-platform="${esc(platform)}">${editing ? "保存修改" : "保存账号"}</button>
          <button type="button" data-fp-modal-cancel>取消</button>
        </div>
      </section>`;
    document.body.appendChild(modal);
    if (editing && account.totp_configured) startTotpClock(modal, account.id);
    else {
      modal.querySelector("[data-account-totp-body]").innerHTML = `<div class="account-totp-entry">
        <label><span>2FA 密钥</span><input data-account-totp-secret placeholder="输入 Base32 或 otpauth://..." autocomplete="off"></label>
        <div class="account-totp-entry-actions"><button type="button" class="primary" data-account-totp-submit>添加 2FA</button></div>
      </div>`;
    }
    modal.addEventListener("click", async (event) => {
      if (event.target.closest("[data-fp-modal-cancel]")) {
        closeCollectorModal();
        return;
      }
      const toggle = event.target.closest("[data-fp-password-toggle]");
      if (toggle && toggle.dataset.fpPasswordToggle) {
        const input = modal.querySelector("#fpEditorPassword");
        try {
          const cred = await api(`/api/admin/fingerprint-login/accounts/${encodeURIComponent(toggle.dataset.fpPasswordToggle)}/credentials`);
          input.type = input.type === "password" ? "text" : "password";
          if (input.type === "text") input.value = cred.login_password || "";
        } catch (error) {
          setMsg("fingerprintLoginMsg", getErrorMessage(error), false);
        }
        return;
      }
      const copy = event.target.closest("[data-account-totp-copy]");
      if (copy) {
        const code = modal.querySelector("[data-account-totp-code]")?.textContent || "";
        if (code && code !== "------") navigator.clipboard?.writeText(code);
        return;
      }
      const update = event.target.closest("[data-account-totp-update]");
      if (update && account?.id) {
        modal.querySelector("[data-account-totp-body]").innerHTML = `<div class="account-totp-entry">
          <label><span>新的 2FA 密钥</span><input data-account-totp-secret placeholder="输入 Base32 或 otpauth://..." autocomplete="off"></label>
          <div class="account-totp-entry-actions"><button type="button" class="primary" data-account-totp-submit>更新 2FA</button><button type="button" data-account-totp-cancel-update>取消</button></div>
        </div>`;
        return;
      }
      if (event.target.closest("[data-account-totp-cancel-update]") && account?.id) {
        startTotpClock(modal, account.id);
        return;
      }
      const submitTotp = event.target.closest("[data-account-totp-submit]");
      if (submitTotp && account?.id) {
        const secret = modal.querySelector("[data-account-totp-secret]")?.value || "";
        try {
          await api(`/api/admin/fingerprint-login/accounts/${encodeURIComponent(account.id)}/totp`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ secret_or_uri: secret }),
          });
          startTotpClock(modal, account.id);
        } catch (error) {
          setMsg("fingerprintLoginMsg", getErrorMessage(error), false);
        }
        return;
      }
      const delTotp = event.target.closest("[data-account-totp-delete]");
      if (delTotp && account?.id) {
        if (!window.confirm("确定移除 2FA？")) return;
        try {
          await api(`/api/admin/fingerprint-login/accounts/${encodeURIComponent(account.id)}/totp`, { method: "DELETE" });
          await loadAccounts();
          const fresh = state.accounts.find((item) => item.id === account.id);
          closeCollectorModal();
          openEditor(fresh);
        } catch (error) {
          setMsg("fingerprintLoginMsg", getErrorMessage(error), false);
        }
        return;
      }
      const openProxy = event.target.closest("[data-fp-open-proxy]");
      if (openProxy) {
        closeCollectorModal();
        openProxyPicker(openProxy.dataset.fpOpenProxy);
        return;
      }
      const save = event.target.closest("[data-fp-editor-save]");
      if (!save) return;
      const body = {
        platform: save.dataset.fpEditorPlatform || platform,
        username: modal.querySelector("#fpEditorUsername")?.value || "",
        login_password: modal.querySelector("#fpEditorPassword")?.value || "",
      };
      try {
        if (save.dataset.fpEditorSave) {
          await api(`/api/admin/fingerprint-login/accounts/${encodeURIComponent(save.dataset.fpEditorSave)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        } else {
          const totpSecret = modal.querySelector("[data-account-totp-secret]")?.value || "";
          await api("/api/admin/fingerprint-login/accounts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, totp_secret: totpSecret }),
          });
          state.platform = body.platform;
        }
        closeCollectorModal();
        await loadAccounts();
      } catch (error) {
        setMsg("fingerprintLoginMsg", getErrorMessage(error), false);
      }
    });
  }

  async function startLogin(accountId) {
    state.selectedId = accountId;
    state.sessionId = "";
    setTab("monitor");
    const payload = await api(`/api/admin/fingerprint-login/accounts/${encodeURIComponent(accountId)}/open_login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_submit: true }),
    });
    setMsg("fingerprintLoginMsg", `已创建登录任务 ${payload?.task?.id || ""}。`, true);
    startPoll();
    await refreshSessions().catch(() => null);
  }

  async function allocateProxy(accountId) {
    const payload = await api(`/api/admin/fingerprint-login/accounts/${encodeURIComponent(accountId)}/sticky-proxy`, { method: "POST" });
    setMsg("fingerprintLoginMsg", `已分配粘性代理，出口 ${payload.exit_ip || "-"}。`, true);
    await loadAccounts();
  }

  async function deleteAccount(accountId) {
    const account = state.accounts.find((item) => item.id === accountId);
    if (!window.confirm(`确定删除账号 ${account?.username || accountId}？`)) return;
    await api(`/api/admin/fingerprint-login/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    state.selectedIds = state.selectedIds.filter((id) => id !== accountId);
    await loadAccounts();
  }

  async function deleteSelected() {
    if (!state.selectedIds.length) return;
    if (!window.confirm(`确定删除已选 ${state.selectedIds.length} 个账号？`)) return;
    for (const id of [...state.selectedIds]) {
      await api(`/api/admin/fingerprint-login/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
    }
    state.selectedIds = [];
    await loadAccounts();
  }

  function copySelected() {
    const rows = collectorAccounts().filter((item) => state.selectedIds.includes(item.id));
    const text = rows.map((item) => `${item.platform}\t${item.username}`).join("\n");
    if (text) navigator.clipboard?.writeText(text);
  }

  function copyCard(accountId) {
    const account = state.accounts.find((item) => item.id === accountId);
    if (!account) return;
    navigator.clipboard?.writeText(String(account.username || ""));
  }

  async function closeSession(sessionId) {
    const id = String(sessionId || state.sessionId || "").trim();
    if (!id) return;
    await api(`/api/admin/fingerprint-login/sessions/${encodeURIComponent(id)}/close`, { method: "POST" });
    state.sessionId = "";
    await refreshSessions();
  }

  function toggleLiveBrowserFullscreen(sessionId) {
    const card = document.querySelector(`[data-live-browser-card="${CSS.escape(String(sessionId || ""))}"]`);
    if (!card) return;
    const expanded = String(state.liveBrowserExpandedSessionId || "") === String(sessionId || "");
    document.querySelectorAll(".live-browser-card.is-live-browser-modal").forEach((node) => node.classList.remove("is-live-browser-modal"));
    document.querySelector("[data-live-browser-modal-backdrop]")?.remove();
    document.body.classList.remove("live-browser-modal-open");
    if (expanded) {
      state.liveBrowserExpandedSessionId = "";
      return;
    }
    state.liveBrowserExpandedSessionId = String(sessionId || "");
    const backdrop = document.createElement("div");
    backdrop.className = "live-browser-modal-backdrop";
    backdrop.dataset.liveBrowserModalBackdrop = "1";
    document.body.appendChild(backdrop);
    document.body.classList.add("live-browser-modal-open");
    card.classList.add("is-live-browser-modal");
  }

  function bind() {
    if (document.body.dataset.fingerprintLoginBound === "true") return;
    document.body.dataset.fingerprintLoginBound = "true";
    const root = el("secFingerprintLogin");
    if (!root) return;
    root.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-fp-tab]");
      if (tab) {
        setTab(tab.dataset.fpTab);
        return;
      }
      const platform = event.target.closest("[data-account-pool-platform]");
      if (platform) {
        const next = platform.dataset.accountPoolPlatform || "threads";
        if (next !== state.platform) {
          state.platform = next;
          state.selectedIds = [];
          state.selectedId = "";
          renderPool();
          pulseAccountPoolPlatformContent();
        }
        return;
      }
      const add = event.target.closest("[data-account-pool-add]");
      if (add) {
        openEditor(null);
        return;
      }
      const check = event.target.closest("[data-account-pool-check]");
      if (check) {
        event.stopPropagation();
        const id = check.dataset.accountPoolCheck;
        if (check.checked) {
          if (!state.selectedIds.includes(id)) state.selectedIds.push(id);
        } else {
          state.selectedIds = state.selectedIds.filter((item) => item !== id);
        }
        renderPool();
        return;
      }
      const selectAll = event.target.closest("[data-account-pool-selection]");
      if (selectAll) {
        const action = selectAll.dataset.accountPoolSelection;
        state.selectedIds = action === "all" ? platformAccounts().map((item) => item.id) : [];
        renderPool();
        return;
      }
      const copySel = event.target.closest("[data-account-pool-copy-selected]");
      if (copySel) {
        copySelected();
        return;
      }
      const delSel = event.target.closest("[data-account-pool-delete-selected]");
      if (delSel) {
        void deleteSelected().catch((error) => setMsg("fingerprintLoginMsg", getErrorMessage(error), false));
        return;
      }
      const copyCardBtn = event.target.closest("[data-account-pool-copy-card]");
      if (copyCardBtn) {
        event.preventDefault();
        event.stopPropagation();
        copyCard(copyCardBtn.dataset.accountPoolCopyCard);
        return;
      }
      const login = event.target.closest("[data-fp-login]");
      if (login) {
        void startLogin(login.dataset.fpLogin).catch((error) => setMsg("fingerprintLoginMsg", getErrorMessage(error), false));
        return;
      }
      const proxy = event.target.closest("[data-fp-proxy]");
      if (proxy) {
        openProxyPicker(proxy.dataset.fpProxy);
        return;
      }
      const edit = event.target.closest("[data-fp-edit]");
      if (edit) {
        const account = state.accounts.find((item) => item.id === edit.dataset.fpEdit);
        openEditor(account || null);
        return;
      }
      const del = event.target.closest("[data-fp-delete]");
      if (del) {
        void deleteAccount(del.dataset.fpDelete).catch((error) => setMsg("fingerprintLoginMsg", getErrorMessage(error), false));
        return;
      }
      const accountAction = event.target.closest("[data-fp-login], [data-fp-proxy], [data-fp-edit], [data-fp-delete], [data-account-pool-copy-card], [data-account-pool-check], .account-pool-card-check");
      const card = event.target.closest("[data-account-pool-account]");
      if (card && !accountAction) {
        const id = card.dataset.accountPoolAccount || "";
        state.selectedId = id;
        state.selectedIds = id ? [id] : [];
        renderPool();
        return;
      }
      const layoutBtn = event.target.closest("[data-live-browser-layout]");
      if (layoutBtn) {
        state.liveBrowserLayout = normalizeLiveBrowserLayout(layoutBtn.dataset.liveBrowserLayout);
        try { window.localStorage.setItem("wk-live-browser-layout", state.liveBrowserLayout); } catch (_) {}
        renderLiveBrowserSessions();
        return;
      }
      const closeBtn = event.target.closest("[data-live-browser-close]");
      if (closeBtn) {
        void closeSession(closeBtn.dataset.liveBrowserClose).catch((error) => setMsg("fingerprintLoginMsg", getErrorMessage(error), false));
        return;
      }
      const expandBtn = event.target.closest("[data-live-browser-fullscreen]");
      if (expandBtn) {
        toggleLiveBrowserFullscreen(expandBtn.dataset.liveBrowserFullscreen);
        return;
      }
      if (event.target.closest("[data-live-browser-modal-backdrop]")) {
        toggleLiveBrowserFullscreen(state.liveBrowserExpandedSessionId);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (state.liveBrowserExpandedSessionId) {
          toggleLiveBrowserFullscreen(state.liveBrowserExpandedSessionId);
          return;
        }
        closeCollectorModal();
      }
    });
  }

  window.loadFingerprintLoginAccounts = loadAccounts;

  function init() {
    bind();
    const page = String(location.hash || "").replace(/^#/, "").replace(/^admin-/, "");
    if (page === "fingerprintLogin") void loadAccounts();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
