(() => {
  const THEME_STORAGE_KEY = "wk-console-theme";
  const LANGUAGE_STORAGE_KEY = "wk-console-language";
  const EVENT_THEME = "vecto:theme-change";
  const EVENT_LANGUAGE = "vecto:language-change";
  const EVENT_LOGOUT = "vecto:logout-request";
  const EVENT_ACCOUNT_MENU_OPEN = "vecto:account-menu-open";
  const EVENT_BILLING_REQUEST = "vecto:account-billing-request";
  const ADMIN_WORKSPACE_STORAGE_KEY = "vecto-admin-workspace-user-id";
  const ADMIN_CONTEXT_STORAGE_KEY = "vecto-admin-console-context";
  const DEFAULT_LANGUAGE = document.documentElement.lang === "zh-Hant" ? "zh-Hant" : "zh-Hans";
  let currentAccount = null;
  let currentSessionMode = "guest";
  let logoutPending = false;
  let logoutMessage = "";
  let proxyMarketBadgeRequest = 0;

  const copy = {
    "zh-Hans": {
      brandLocal: "维拓 / 维图",
      homeLabel: "Vecto 首页",
      navigationLabel: "站内导航",
      menu: "导航",
      skip: "跳至主要内容",
      solution: "解决方案",
      accounts: "三账号架构",
      scenarios: "应用场景",
      pricing: "订阅方案",
      proxyMarket: "代理商城",
      difference: "服务差异",
      console: "Web 控制台",
      login: "账号登录",
      guest: "游客申请",
      home: "返回首页",
      currentAccount: "当前登录账号",
      accountFallback: "账户",
      accountStatus: "已登录",
      accountRole: "普通账号",
      accountAdminRole: "管理员",
      accountManagedRole: "管理员代管",
      accountId: "账号 ID",
      logout: "退出登录",
      logoutPending: "正在退出...",
      logoutFailed: "退出失败，请重试。",
      globalSettings: "全局显示设置",
      personalSettings: "个人设置",
      appearance: "外观",
      languageSetting: "语言",
      themeLightState: "亮色",
      themeDarkState: "暗色",
      languageSimplifiedState: "简体中文",
      languageTraditionalState: "繁体中文",
      themeDark: "切换到暗色模式",
      themeLight: "切换到亮色模式",
      language: "切换到繁体中文",
      languageState: "简",
      billing: "订阅与算力",
      billingView: "查看详情",
      accountSettings: "账户设置",
      personalProfile: "个人信息",
      billingPoints: "算力余额",
      billingSubscription: "当前订阅",
      billingImages: "图片额度",
      billingPending: "待审批",
      publishToday: "今日发布",
      publishRemaining: "今日剩余发布额度",
      billingUnread: "尚未读取",
      billingLoading: "读取中…",
      billingReady: "已同步",
      billingPartial: "部分不可用",
      billingClick: "点击查看",
    },
    "zh-Hant": {
      brandLocal: "維拓 / 維圖",
      homeLabel: "Vecto 首頁",
      navigationLabel: "站內導覽",
      menu: "導覽",
      skip: "跳至主要內容",
      solution: "解決方案",
      accounts: "三帳架構",
      scenarios: "應用場景",
      pricing: "訂閱方案",
      proxyMarket: "代理商城",
      difference: "服務差異",
      console: "Web 控制台",
      login: "帳號登入",
      guest: "遊客申請",
      home: "返回首頁",
      currentAccount: "目前登入帳號",
      accountFallback: "帳戶",
      accountStatus: "已登入",
      accountRole: "一般帳號",
      accountAdminRole: "管理員",
      accountManagedRole: "管理員代管",
      accountId: "帳號 ID",
      logout: "退出登入",
      logoutPending: "正在退出...",
      logoutFailed: "退出失敗，請重試。",
      globalSettings: "全域顯示設定",
      personalSettings: "個人設定",
      appearance: "外觀",
      languageSetting: "語言",
      themeLightState: "亮色",
      themeDarkState: "暗色",
      languageSimplifiedState: "簡體中文",
      languageTraditionalState: "繁體中文",
      themeDark: "切換到暗色模式",
      themeLight: "切換到亮色模式",
      language: "切換到簡體中文",
      languageState: "繁",
      billing: "訂閱與算力",
      billingView: "查看詳情",
      accountSettings: "帳戶設定",
      personalProfile: "個人資訊",
      billingPoints: "算力餘額",
      billingSubscription: "目前訂閱",
      billingImages: "圖片額度",
      billingPending: "待審批",
      publishToday: "今日發布",
      publishRemaining: "今日剩餘發布額度",
      billingUnread: "尚未讀取",
      billingLoading: "讀取中…",
      billingReady: "已同步",
      billingPartial: "部分不可用",
      billingClick: "點擊查看",
    },
  };

  function storedValue(key, fallback) {
    try {
      return window.localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function sessionValue(key, fallback = "") {
    try {
      return window.sessionStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function writeSessionValue(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {}
  }

  function removeSessionValue(key) {
    try {
      window.sessionStorage.removeItem(key);
    } catch {}
  }

  function markAdminConsoleContext() {
    writeSessionValue(ADMIN_CONTEXT_STORAGE_KEY, "1");
  }

  function clearAdminConsoleContext() {
    removeSessionValue(ADMIN_CONTEXT_STORAGE_KEY);
    removeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY);
    if (currentSessionMode === "admin") {
      currentSessionMode = "guest";
      proxyMarketBadgeRequest += 1;
    }
  }

  function hasAdminConsoleContext() {
    return sessionValue(ADMIN_CONTEXT_STORAGE_KEY) === "1";
  }

  function storedAdminWorkspaceUserId() {
    return String(sessionValue(ADMIN_WORKSPACE_STORAGE_KEY) || "").trim();
  }

  function adminConsoleTarget(view = "", workspaceUserId = storedAdminWorkspaceUserId()) {
    const params = new URLSearchParams();
    if (view) params.set("view", view);
    if (workspaceUserId) params.set("manage_user_id", workspaceUserId);
    const query = params.toString();
    return query ? `/admin-console.html?${query}` : "/admin-console.html";
  }

  function currentTheme() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }

  function themeEnabled() {
    const page = document.querySelector("[data-site-header]")?.dataset.sitePage || "";
    return page === "console" || document.body?.classList.contains("page-admin");
  }

  function currentLanguage() {
    return document.documentElement.dataset.language === "zh-Hant" ? "zh-Hant" : "zh-Hans";
  }

  function writePreference(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  }

  function setTheme(theme, { emit = true, persist = true } = {}) {
    if (!themeEnabled()) {
      delete document.documentElement.dataset.theme;
      sync();
      return;
    }
    const nextTheme = theme === "dark" ? "dark" : "light";
    if (nextTheme === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    if (persist) writePreference(THEME_STORAGE_KEY, nextTheme);
    sync();
    if (emit) window.dispatchEvent(new CustomEvent(EVENT_THEME, { detail: { theme: nextTheme } }));
  }

  function setLanguage(language, { emit = true, persist = true } = {}) {
    const nextLanguage = language === "zh-Hant" ? "zh-Hant" : "zh-Hans";
    document.documentElement.dataset.language = nextLanguage;
    document.documentElement.lang = nextLanguage === "zh-Hant" ? "zh-Hant" : "zh-CN";
    if (persist) writePreference(LANGUAGE_STORAGE_KEY, nextLanguage);
    sync();
    if (emit) window.dispatchEvent(new CustomEvent(EVENT_LANGUAGE, { detail: { language: nextLanguage } }));
  }

  function navHref(page, hash) {
    return page === "home" ? hash : `/${hash}`;
  }

  function navLink({ key, href, current, className = "" }) {
    const busy = key === "console" ? " data-console-entry" : "";
    const active = current === key ? ' aria-current="page"' : "";
    const classAttribute = className ? ` class="${className}"` : "";
    return `<a${classAttribute} data-site-nav-key="${key}" href="${href}"${active}${busy}><span data-site-copy="${key}"></span></a>`;
  }

  function navigationLinks(page, current) {
    return [
      navLink({ key: "solution", href: navHref(page, "#solution"), current }),
      navLink({ key: "accounts", href: navHref(page, "#agents"), current }),
      navLink({ key: "scenarios", href: navHref(page, "#scenarios"), current }),
      navLink({ key: "pricing", href: "/subscription.html", current }),
      navLink({ key: "proxyMarket", href: "/proxy-market.html", current }),
      navLink({ key: "difference", href: navHref(page, "#service-difference"), current }),
      navLink({ key: "console", href: "/console.html", current }),
    ].join("");
  }

  function themeIcon() {
    return `<svg class="site-theme-icon site-theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg><svg class="site-theme-icon site-theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 15.2A8.5 8.5 0 0 1 8.8 3.5 8.7 8.7 0 1 0 20.5 15.2Z"></path></svg>`;
  }

  function languageIcon() {
    return `<svg class="site-language-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21M12 3C9.6 5.5 8.4 8.5 8.4 12s1.2 6.5 3.6 9"></path></svg><span class="site-language-state" data-site-language-state></span>`;
  }

  function menuIcon() {
    return `<svg class="site-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14"></path></svg>`;
  }

  function accountIcon(className = "") {
    const classAttribute = className ? ` class="${className}"` : "";
    return `<svg${classAttribute} viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"></circle><path d="M5 20c.8-4 3.1-6 7-6s6.2 2 7 6"></path></svg>`;
  }

  function safeAvatarUrl(account) {
    const value = String(account?.avatar_url || account?.avatarUrl || "").trim();
    const lower = value.toLowerCase();
    if (!value) return "";
    if (lower.startsWith("data:image/") || lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("/assets/") || lower.startsWith("/uploads/")) return value;
    return "";
  }

  function renderAccountAvatar(node, className = "") {
    if (!node) return;
    const avatarUrl = safeAvatarUrl(currentAccount);
    node.textContent = "";
    if (avatarUrl) {
      const image = document.createElement("img");
      image.src = avatarUrl;
      image.alt = "";
      if (className) image.className = className;
      node.appendChild(image);
      return;
    }
    node.innerHTML = accountIcon(className);
  }

  function accountPreferencesMarkup(page = "console") {
    const themePreference = page === "console" ? `<button id="themeToggle" class="site-account-preference" type="button" data-site-theme-toggle>
        <span class="site-account-preference-icon" aria-hidden="true">${themeIcon()}</span>
      </button>` : "";
    return `<div class="site-account-preferences" data-site-personal-controls>
      <span class="site-account-section-label" data-site-copy="personalSettings"></span>
      ${themePreference}
      <button id="languageToggle" class="site-account-preference" type="button" data-site-language-toggle>
        <span class="site-account-preference-icon" aria-hidden="true">${languageIcon()}</span>
      </button>
    </div>`;
  }

  function accountMenuMarkup(page = "console") {
    return `<div class="site-account-menu" data-site-account-menu>
      <button class="site-user" type="button" aria-controls="siteAccountPopover" aria-haspopup="dialog" aria-expanded="false" data-site-user-title data-site-account-trigger>
        <span class="site-user-avatar" data-site-account-avatar>${accountIcon()}</span><span id="consoleMeName" data-site-account-name></span><svg class="site-user-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"></path></svg>
      </button>
      <div id="siteAccountPopover" class="site-account-popover" data-site-account-popover hidden role="dialog" aria-label="个人信息">
        <div class="site-account-summary">
          <span class="site-account-avatar" aria-hidden="true" data-site-account-avatar>${accountIcon()}</span>
          <span class="site-account-identity"><strong data-site-account-name></strong><span data-site-account-role></span></span>
          <span class="site-account-status"><i aria-hidden="true"></i><span data-site-copy="accountStatus"></span></span>
        </div>
        <div class="site-account-detail"><span data-site-copy="accountId"></span><strong data-site-account-id>-</strong></div>
        <div class="site-account-tags" data-site-account-tags hidden></div>
        <section class="site-account-billing" data-site-account-billing aria-labelledby="siteAccountBillingTitle"${page === "console" ? "" : " hidden"}>
          <div class="site-account-section-head">
            <span id="siteAccountBillingTitle" data-site-copy="billing"></span>
            <span class="site-account-billing-state" data-site-billing-status data-site-copy="billingUnread">尚未读取</span>
          </div>
          <div class="site-account-billing-grid" aria-live="polite">
            <div class="site-account-billing-card"><span data-site-copy="billingPoints">算力余额</span><strong data-site-billing-points>—</strong></div>
            <div class="site-account-billing-card"><span data-site-copy="billingSubscription">当前订阅</span><strong data-site-billing-subscription>—</strong></div>
            <div class="site-account-billing-card"><span data-site-copy="billingImages">图片额度</span><strong data-site-billing-images>—</strong></div>
            <div class="site-account-billing-card"><span data-site-copy="billingPending">待审批</span><strong data-site-billing-pending>—</strong></div>
            <div class="site-account-billing-card"><span data-site-copy="publishToday">今日发布</span><strong data-site-publish-used>—</strong></div>
            <div class="site-account-billing-card"><span data-site-copy="publishRemaining">剩余额度</span><strong data-site-publish-remaining>—</strong></div>
          </div>
          <div class="site-account-action-row">
            <button type="button" data-site-open-billing data-site-copy="billingView"></button>
            <button type="button" data-site-open-settings data-site-copy="personalProfile"></button>
          </div>
        </section>
        ${accountPreferencesMarkup(page)}
        <button class="site-account-logout" type="button" data-site-account-logout><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M14 8l4 4-4 4M18 12H9"></path></svg><span data-site-copy="logout"></span></button>
        <span class="site-account-message" role="status" aria-live="polite" data-site-account-message></span>
      </div>
    </div>`;
  }

  function renderMobileMenu(page, current, mode) {
    const extraLink = mode === "authenticated"
      ? ""
      : navLink({ key: "guest", href: page === "home" ? "#contact" : "/#contact", current, className: "site-mobile-menu-extra" });
    return `<details class="site-mobile-menu" data-site-mobile-menu><summary class="site-menu-toggle" data-site-menu-toggle>${menuIcon()}<span data-site-copy="menu"></span></summary><nav class="site-mobile-menu-panel" data-site-navigation>${navigationLinks(page, current)}${extraLink}</nav></details>`;
  }

  function renderActions(mode, page, current) {
    const controls = `<div class="site-global-controls" data-site-global-controls><button id="languageToggle" class="site-icon-button site-language-button" type="button" data-site-language-toggle>${languageIcon()}</button></div>`;
    const mobileMenu = renderMobileMenu(page, current, mode);
    if (mode === "authenticated") {
      return `${mobileMenu}${accountMenuMarkup(page)}`;
    }
    return `${mobileMenu}${controls}<button class="header-login" type="button" data-open-login><span data-site-copy="login"></span></button><a class="header-action site-guest-action" href="${page === "home" ? "#contact" : "/#contact"}"><span data-site-copy="guest"></span></a>`;
  }

  function fallbackMarkup(page, mode, current) {
    return `
      <a class="brand" href="/" data-site-home-label>
        <span class="brand-logo-frame" aria-hidden="true"><img class="brand-logo" src="/assets/opc/vecto-logo-ui-icon.png?v=20260711" alt="" width="1024" height="1024" /></span>
        <span class="brand-text"><span class="brand-name">Vecto</span><span class="brand-local" data-site-copy="brandLocal"></span></span>
      </a>
      <nav class="site-nav" data-site-navigation>${navigationLinks(page, current)}</nav>
      <div class="header-actions">${renderActions(mode, page, current)}</div>`;
  }

  function syncMenuState(menu) {
    const toggle = menu.querySelector("[data-site-menu-toggle]");
    if (toggle) toggle.setAttribute("aria-expanded", menu.open ? "true" : "false");
  }

  function setAccountMenuOpen(menu, open, { restoreFocus = false } = {}) {
    if (!menu) return;
    const trigger = menu.querySelector("[data-site-account-trigger]");
    const popover = menu.querySelector("[data-site-account-popover]");
    if (!trigger || !popover) return;
    const nextOpen = Boolean(open);
    const shouldRestoreFocus = !nextOpen && restoreFocus && popover.contains(document.activeElement);
    trigger.setAttribute("aria-expanded", nextOpen ? "true" : "false");
    popover.hidden = !nextOpen;
    menu.classList.toggle("is-open", nextOpen);
    if (nextOpen) {
      document.querySelectorAll("[data-site-mobile-menu][open]").forEach((mobileMenu) => mobileMenu.removeAttribute("open"));
      window.dispatchEvent(new CustomEvent(EVENT_ACCOUNT_MENU_OPEN, { detail: { account: currentAccount } }));
    } else if (shouldRestoreFocus) {
      trigger.focus({ preventScroll: true });
    }
  }

  function accountRoleLabel(account, labels) {
    if (account?.acting_admin) return labels.accountManagedRole;
    return account?.is_admin ? labels.accountAdminRole : labels.accountRole;
  }

  function syncAccount() {
    const labels = copy[currentLanguage()];
    const username = String(currentAccount?.full_name || currentAccount?.display_name || currentAccount?.username || "").trim() || labels.accountFallback;
    const tagText = String(currentAccount?.profile_tags || currentAccount?.profileTags || "").trim();
    const tags = tagText
      ? tagText.split(/[,，\n]+/).map((item) => item.trim()).filter(Boolean).slice(0, 8)
      : [];
    document.querySelectorAll("[data-site-account-name]").forEach((node) => node.textContent = username);
    document.querySelectorAll("[data-site-account-role]").forEach((node) => node.textContent = accountRoleLabel(currentAccount, labels));
    document.querySelectorAll("[data-site-account-id]").forEach((node) => {
      node.textContent = currentAccount?.id ? `#${currentAccount.id}` : "-";
    });
    document.querySelectorAll("[data-site-account-avatar]").forEach((node) => {
      renderAccountAvatar(node, node.classList.contains("site-user-avatar") ? "" : "");
    });
    document.querySelectorAll("[data-site-account-tags]").forEach((node) => {
      node.hidden = tags.length === 0;
      node.replaceChildren(...tags.map((tag) => {
        const item = document.createElement("span");
        item.textContent = tag;
        return item;
      }));
    });
  }

  function setAccount(account) {
    currentAccount = account && typeof account === "object" ? { ...account } : null;
    syncAccount();
  }

  function setLogoutPending(pending, message = "") {
    logoutPending = Boolean(pending);
    logoutMessage = message ? String(message) : "";
    const labels = copy[currentLanguage()];
    document.querySelectorAll("[data-site-account-logout]").forEach((button) => {
      button.disabled = logoutPending;
      button.setAttribute("aria-busy", logoutPending ? "true" : "false");
      const label = button.querySelector("span");
      if (label) label.textContent = logoutPending ? labels.logoutPending : labels.logout;
    });
    document.querySelectorAll("[data-site-account-message]").forEach((node) => {
      node.textContent = logoutMessage;
    });
  }

  async function logoutPublicSession() {
    try {
      const headers = new Headers({ Accept: "application/json" });
      if (currentSessionMode === "admin") headers.set("X-Admin-Console", "1");
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.detail || copy[currentLanguage()].logoutFailed);
      }
      setAccount(null);
      if (currentSessionMode === "admin") clearAdminConsoleContext();
      currentSessionMode = "guest";
      window.location.reload();
    } catch (error) {
      setLogoutPending(false, error?.message || copy[currentLanguage()].logoutFailed);
    }
  }

  function bindPreferenceControls(root) {
    root.querySelectorAll("[data-site-theme-toggle]").forEach((button) => {
      if (button.dataset.sitePreferenceReady === "true") return;
      button.dataset.sitePreferenceReady = "true";
      button.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
    });
    root.querySelectorAll("[data-site-language-toggle]").forEach((button) => {
      if (button.dataset.sitePreferenceReady === "true") return;
      button.dataset.sitePreferenceReady = "true";
      button.addEventListener("click", () => setLanguage(currentLanguage() === "zh-Hant" ? "zh-Hans" : "zh-Hant"));
    });
  }

  function bindAccountMenus(header) {
    header.querySelectorAll("[data-site-account-menu]").forEach((menu) => {
      if (menu.dataset.siteAccountReady === "true") return;
      menu.dataset.siteAccountReady = "true";
      let hoverCloseTimer = 0;
      const trigger = menu.querySelector("[data-site-account-trigger]");
      const popover = menu.querySelector("[data-site-account-popover]");
      const cancelHoverClose = () => {
        if (hoverCloseTimer) window.clearTimeout(hoverCloseTimer);
        hoverCloseTimer = 0;
      };
      const scheduleHoverClose = () => {
        cancelHoverClose();
        hoverCloseTimer = window.setTimeout(() => {
          if (!menu.matches(":hover") && !popover?.contains(document.activeElement)) {
            setAccountMenuOpen(menu, false);
          }
        }, 140);
      };
      trigger?.addEventListener("click", () => {
        cancelHoverClose();
        setAccountMenuOpen(menu, trigger.getAttribute("aria-expanded") !== "true", { restoreFocus: true });
      });
      menu.addEventListener("pointerenter", (event) => {
        if (event.pointerType && event.pointerType !== "mouse") return;
        cancelHoverClose();
        setAccountMenuOpen(menu, true);
      });
      menu.addEventListener("pointerleave", (event) => {
        if (event.pointerType && event.pointerType !== "mouse") return;
        scheduleHoverClose();
      });
      menu.addEventListener("focusin", (event) => {
        // Focusing the trigger happens before a mouse click. Let the click
        // handler own the toggle so focusin cannot immediately close it.
        if (event.target === trigger) return;
        cancelHoverClose();
        setAccountMenuOpen(menu, true);
      });
      menu.addEventListener("focusout", (event) => {
        if (!menu.contains(event.relatedTarget)) scheduleHoverClose();
      });
      menu.querySelector("[data-site-open-billing]")?.addEventListener("click", () => {
        setAccountMenuOpen(menu, false);
        openAccountConsoleView("billing");
      });
      menu.querySelector("[data-site-open-settings]")?.addEventListener("click", () => {
        setAccountMenuOpen(menu, false);
        openProfilePage();
      });
      menu.querySelector("[data-site-account-logout]")?.addEventListener("click", () => {
        setLogoutPending(true);
        if (header.dataset.siteMode === "public") {
          void logoutPublicSession();
          return;
        }
        window.dispatchEvent(new CustomEvent(EVENT_LOGOUT));
      });
    });
  }

  function openAccountConsoleView(view) {
    const targetView = "billing";
    const pageWorkspaceUserId = String(document.querySelector('meta[name="admin-workspace-user-id"]')?.content || "").trim();
    const isAdminConsole = document.querySelector('meta[name="admin-console-session"]')?.content === "1";
    const adminWorkspaceUserId = pageWorkspaceUserId || storedAdminWorkspaceUserId();
    if (window.location.pathname === "/console.html" || window.location.pathname === "/admin-console.html") {
      window.dispatchEvent(new CustomEvent(EVENT_BILLING_REQUEST));
      return;
    }
    if (isAdminConsole || currentSessionMode === "admin" || hasAdminConsoleContext() || adminWorkspaceUserId) {
      window.location.assign(adminConsoleTarget(targetView, adminWorkspaceUserId));
      return;
    }
    window.location.assign(`/console.html?${new URLSearchParams({ view: targetView }).toString()}`);
  }

  function openProfilePage() {
    const isAdminConsole = document.querySelector('meta[name="admin-console-session"]')?.content === "1";
    const adminContext = isAdminConsole || currentSessionMode === "admin" || hasAdminConsoleContext();
    window.location.assign(adminContext ? "/admin-profile.html" : "/profile.html");
  }

  function syncAdminWorkspaceContext() {
    const adminSessionMeta = document.querySelector('meta[name="admin-console-session"]');
    if (!adminSessionMeta) return;
    const isAdminConsole = adminSessionMeta.content === "1";
    if (!isAdminConsole) {
      clearAdminConsoleContext();
      return;
    }
    markAdminConsoleContext();
    currentSessionMode = "admin";
    const workspaceUserId = String(document.querySelector('meta[name="admin-workspace-user-id"]')?.content || "").trim();
    if (workspaceUserId) writeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY, workspaceUserId);
    else removeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY);
  }

  function showAuthenticatedAccount(header, account) {
    if (!header || header.dataset.siteMode !== "public") return;
    const actions = header.querySelector(".header-actions");
    if (!actions) return;
    actions.querySelectorAll("[data-open-login], .site-guest-action").forEach((node) => node.remove());
    actions.querySelectorAll(":scope > .site-global-controls").forEach((node) => node.remove());
    actions.querySelectorAll(".site-mobile-menu-extra").forEach((node) => node.remove());
    if (!actions.querySelector("[data-site-account-menu]")) {
      actions.insertAdjacentHTML("beforeend", accountMenuMarkup(header.dataset.sitePage || "home"));
    }
    actions.querySelector("[data-site-account-billing]")?.toggleAttribute(
      "hidden",
      header.dataset.sitePage !== "console",
    );
    header.dataset.siteAuthState = "authenticated";
    bindPreferenceControls(header);
    bindAccountMenus(header);
    setAccount(account);
    sync();
  }

  function showGuestAccount(header) {
    if (!header || header.dataset.siteMode !== "public") return;
    header.dataset.siteAuthState = "guest";
    currentSessionMode = "guest";
    proxyMarketBadgeRequest += 1;
    sync();
  }

  async function fetchSessionAccount({ admin = false, workspaceUserId = "" } = {}) {
    const headers = new Headers({ Accept: "application/json" });
    if (admin) headers.set("X-Admin-Console", "1");
    if (admin && workspaceUserId) headers.set("X-Admin-Workspace-User-ID", workspaceUserId);
    const response = await fetch("/api/auth/me", {
      credentials: "include",
      cache: "no-store",
      headers,
    });
    if (!response.ok) return { response, account: null };
    return { response, account: await response.json() };
  }

  async function resolvePublicSession() {
    if (hasAdminConsoleContext()) {
      let workspaceUserId = storedAdminWorkspaceUserId();
      let adminResult = await fetchSessionAccount({ admin: true, workspaceUserId });
      if (workspaceUserId && [400, 404].includes(adminResult.response.status)) {
        removeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY);
        workspaceUserId = "";
        adminResult = await fetchSessionAccount({ admin: true });
      }
      if (adminResult.response.ok && adminResult.account) {
        markAdminConsoleContext();
        return {
          mode: "admin",
          account: adminResult.account,
          workspaceUserId,
          path: "/admin-console.html",
        };
      }
      if ([401, 403].includes(adminResult.response.status)) {
        clearAdminConsoleContext();
      } else {
        throw new Error(`Admin session validation failed: HTTP ${adminResult.response.status}`);
      }
    }

    const userResult = await fetchSessionAccount();
    if (userResult.response.ok && userResult.account) {
      return {
        mode: "user",
        account: userResult.account,
        workspaceUserId: "",
        path: "/console.html",
      };
    }
    return { mode: "guest", account: null, workspaceUserId: "", path: "" };
  }

  async function openConsoleEntry(link, { onUnauthorized } = {}) {
    link?.setAttribute("aria-busy", "true");
    try {
      if (window.location.pathname === "/admin-profile.html") {
        removeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY);
        markAdminConsoleContext();
      }
      const session = await resolvePublicSession();
      if (session.mode === "admin") {
        window.location.assign(adminConsoleTarget("", session.workspaceUserId));
        return session;
      }
      if (session.mode === "user") {
        window.location.assign(session.path);
        return session;
      }
      if (typeof onUnauthorized === "function") onUnauthorized();
      return session;
    } catch {
      if (hasAdminConsoleContext()) {
        window.location.assign(adminConsoleTarget());
        return null;
      }
      if (typeof onUnauthorized === "function") onUnauthorized();
      return null;
    } finally {
      link?.removeAttribute("aria-busy");
    }
  }

  async function hydratePublicSession(header) {
    if (!header || header.dataset.siteMode !== "public") return null;
    try {
      const session = await resolvePublicSession();
      if (!session.account) {
        showGuestAccount(header);
        return null;
      }
      currentSessionMode = session.mode === "admin" ? "admin" : "user";
      showAuthenticatedAccount(header, session.account);
      void syncProxyMarketBadge();
      return session.account;
    } catch {
      showGuestAccount(header);
      return null;
    }
  }

  function mount(header) {
    if (!header || header.dataset.siteReady === "true") return header;
    const page = header.dataset.sitePage || "home";
    const mode = header.dataset.siteMode || (page === "console" ? "authenticated" : "public");
    const resolvedMode = mode === "public" ? page : mode;
    const current = page === "pricing" || page === "console" || page === "proxyMarket" ? page : "";

    if (mode === "public" && !header.dataset.siteAuthState) header.dataset.siteAuthState = "pending";

    if (!header.querySelector(".brand")) {
      header.innerHTML = fallbackMarkup(page, resolvedMode, current);
    }

    header.dataset.siteReady = "true";
    header.dataset.i18nSkip = "true";
    bindPreferenceControls(header);
    header.querySelectorAll("[data-site-mobile-menu]").forEach((menu) => {
      syncMenuState(menu);
      menu.addEventListener("toggle", () => {
        syncMenuState(menu);
        if (menu.open) header.querySelectorAll("[data-site-account-menu]").forEach((accountMenu) => setAccountMenuOpen(accountMenu, false));
      });
      menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => menu.removeAttribute("open")));
    });
    bindAccountMenus(header);
    sync();
    if (mode === "public") void hydratePublicSession(header);
    return header;
  }

  function sync() {
    const language = currentLanguage();
    const labels = copy[language];
    document.querySelectorAll("[data-site-copy]").forEach((node) => {
      const key = node.dataset.siteCopy;
      if (Object.prototype.hasOwnProperty.call(labels, key)) node.textContent = labels[key];
    });
    document.querySelectorAll("[data-site-home-label]").forEach((node) => node.setAttribute("aria-label", labels.homeLabel));
    document.querySelectorAll("[data-site-navigation]").forEach((node) => node.setAttribute("aria-label", labels.navigationLabel));
    document.querySelectorAll("[data-site-global-controls]").forEach((node) => node.setAttribute("aria-label", labels.globalSettings));
    document.querySelectorAll("[data-site-personal-controls]").forEach((node) => node.setAttribute("aria-label", labels.personalSettings));
    document.querySelectorAll("[data-site-account-popover]").forEach((node) => node.setAttribute("aria-label", labels.personalProfile));
    document.querySelectorAll("[data-site-console-label]").forEach((node) => node.setAttribute("aria-label", labels.console));
    document.querySelectorAll("[data-site-user-title]").forEach((node) => node.title = labels.currentAccount);
    document.querySelectorAll("[data-site-account-name]").forEach((node) => {
      const value = node.textContent.trim();
      if (!value || value === copy["zh-Hans"].accountFallback || value === copy["zh-Hant"].accountFallback) {
        node.textContent = labels.accountFallback;
      }
    });
    document.querySelectorAll("[data-site-theme-toggle]").forEach((button) => {
      const label = currentTheme() === "dark" ? labels.themeLight : labels.themeDark;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", currentTheme() === "dark" ? "true" : "false");
    });
    document.querySelectorAll("[data-site-language-toggle]").forEach((button) => {
      button.title = labels.language;
      button.setAttribute("aria-label", labels.language);
      button.setAttribute("aria-pressed", language === "zh-Hant" ? "true" : "false");
    });
    document.querySelectorAll("[data-site-language-state]").forEach((node) => node.textContent = labels.languageState);
    document.querySelectorAll("[data-site-theme-state]").forEach((node) => {
      node.textContent = currentTheme() === "dark" ? labels.themeDarkState : labels.themeLightState;
    });
    document.querySelectorAll("[data-site-language-preference-state]").forEach((node) => {
      node.textContent = language === "zh-Hant" ? labels.languageTraditionalState : labels.languageSimplifiedState;
    });
    syncAccount();
    setLogoutPending(logoutPending, logoutMessage);
  }

  async function syncProxyMarketBadge() {
    const requestId = ++proxyMarketBadgeRequest;
    if (currentSessionMode === "guest") return;
    const headers = new Headers({ Accept: "application/json" });
    if (currentSessionMode === "admin") {
      headers.set("X-Admin-Console", "1");
      const workspaceUserId = storedAdminWorkspaceUserId();
      if (workspaceUserId) headers.set("X-Admin-Workspace-User-ID", workspaceUserId);
    }
    try {
      const response = await fetch("/api/proxy-market/me", {
        credentials: "same-origin",
        headers,
      });
      if (requestId !== proxyMarketBadgeRequest) return;
      if (!response.ok) return;
      const payload = await response.json();
      if (requestId !== proxyMarketBadgeRequest) return;
      const count = Math.max(0, Number(payload?.unread_catalog_count || 0));
      document.querySelectorAll('[data-site-nav-key="proxyMarket"]').forEach((link) => {
        let badge = link.querySelector(".site-nav-badge");
        if (!badge && count > 0) {
          badge = document.createElement("span");
          badge.className = "site-nav-badge";
          link.appendChild(badge);
        }
        if (!badge) return;
        badge.textContent = count > 99 ? "99+" : String(count);
        badge.hidden = count <= 0;
      });
    } catch {}
  }

  document.addEventListener("click", (event) => {
    document.querySelectorAll("[data-site-mobile-menu][open]").forEach((menu) => {
      if (!menu.contains(event.target)) menu.removeAttribute("open");
    });
    document.querySelectorAll("[data-site-account-menu].is-open").forEach((menu) => {
      if (!menu.contains(event.target)) setAccountMenuOpen(menu, false);
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    document.querySelectorAll("[data-site-mobile-menu][open]").forEach((menu) => {
      menu.removeAttribute("open");
      menu.querySelector("[data-site-menu-toggle]")?.focus();
    });
    document.querySelectorAll("[data-site-account-menu].is-open").forEach((menu) => setAccountMenuOpen(menu, false, { restoreFocus: true }));
  });
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_STORAGE_KEY) {
      if (themeEnabled()) setTheme(event.newValue || "light", { persist: false });
      else delete document.documentElement.dataset.theme;
    }
    if (event.key === LANGUAGE_STORAGE_KEY) {
      setLanguage(event.newValue || DEFAULT_LANGUAGE, { persist: false });
    }
    if (event.key === null) {
      if (themeEnabled()) setTheme("light", { persist: false });
      else delete document.documentElement.dataset.theme;
      setLanguage(DEFAULT_LANGUAGE, { persist: false });
    }
    if (event.key === "vecto-proxy-market-read") void syncProxyMarketBadge();
  });
  window.addEventListener("vecto:proxy-market-read", () => void syncProxyMarketBadge());

  syncAdminWorkspaceContext();
  document.querySelectorAll("[data-site-header]").forEach(mount);
  if (themeEnabled()) setTheme(storedValue(THEME_STORAGE_KEY, "light"), { persist: false });
  else delete document.documentElement.dataset.theme;
  setLanguage(storedValue(LANGUAGE_STORAGE_KEY, DEFAULT_LANGUAGE), { persist: false });

  window.VectoSiteNavigation = {
    mount,
    sync,
    setTheme,
    setLanguage,
    setAccount,
    setLogoutPending,
    currentTheme,
    currentLanguage,
    themeEnabled,
    openConsoleEntry,
    markAdminConsoleContext,
    clearAdminConsoleContext,
    syncProxyMarketBadge,
  };
  window.dispatchEvent(new CustomEvent("vecto:navigation-ready"));
})();
