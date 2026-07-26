(() => {
  const LANGUAGE_STORAGE_KEY = "wk-console-language";
  const EVENT_THEME = "vecto:theme-change";
  const EVENT_LANGUAGE = "vecto:language-change";
  const EVENT_LOGOUT = "vecto:logout-request";
  const EVENT_ACCOUNT_MENU_OPEN = "vecto:account-menu-open";
  const EVENT_NOTIFICATION_MENU_OPEN = "vecto:notification-menu-open";
  const EVENT_BILLING_REQUEST = "vecto:account-billing-request";
  const EVENT_CONSOLE_VIEW_REQUEST = "vecto:account-console-view-request";
  const NOTIFICATION_STORAGE_KEY = "vecto-notifications-updated";
  const NOTIFICATION_POLL_MS = 15000;
  const ADMIN_WORKSPACE_STORAGE_KEY = "vecto-admin-workspace-user-id";
  const ADMIN_CONTEXT_STORAGE_KEY = "vecto-admin-console-context";
  const DEFAULT_LANGUAGE = document.documentElement.lang === "zh-Hant" ? "zh-Hant" : "zh-Hans";
  let currentAccount = null;
  let currentSessionMode = "guest";
  let logoutPending = false;
  let logoutMessage = "";
  let proxyMarketBadgeRequest = 0;
  let accountBillingRequest = 0;
  let notificationRequest = 0;
  let notificationPollTimer = 0;
  const accountPanelCloseTimers = new WeakMap();
  const notificationPanelCloseTimers = new WeakMap();
  const mobileMenuCloseTimers = new WeakMap();
  const mobileMenuIsolation = new WeakMap();
  const accountBillingState = {
    identityKey: "",
    loading: false,
    loaded: false,
    partial: false,
    summary: {},
    orders: {},
  };
  const notificationState = {
    identityKey: "",
    items: [],
    unread: { system: 0, official: 0, interaction: 0, total: 0 },
    activeCategory: "system",
    loading: false,
    loaded: false,
  };

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
      console: "控制台",
      adminConsole: "运营后台",
      aboutVecto: "了解 Vecto",
      login: "登录",
      guest: "账号注册",
      home: "返回首页",
      currentAccount: "当前登录账号",
      accountFallback: "账户",
      accountStatus: "已登录",
      accountRole: "普通账号",
      accountAdminRole: "管理员",
      accountManagedRole: "管理员代管",
      accountId: "账号 ID",
      accountClose: "关闭个人信息",
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
      publishToday: "今日任务",
      publishRemaining: "今日剩余任务额度",
      billingUnread: "尚未读取",
      billingLoading: "读取中…",
      billingReady: "已同步",
      billingPartial: "部分不可用",
      billingClick: "点击查看",
      billingLegacyPlan: "存量账号",
      billingActivePlan: "已启用",
      billingNoPlan: "暂无订阅",
      billingUnlimited: "不限",
      billingPointUnit: "点",
      billingImageUnit: "张",
      billingPostUnit: "篇",
      profileSignature: "个人简介",
      profileSignatureEmpty: "暂未填写个人简介",
      profileTags: "个人标签",
      profileTagsEmpty: "暂未添加个人标签",
      notificationCenter: "通知中心",
      notificationSystem: "系统消息",
      notificationOfficial: "官方消息",
      notificationInteraction: "互动消息",
      notificationClose: "关闭通知中心",
      notificationEmpty: "暂无消息",
      notificationLoading: "正在读取消息…",
      notificationUnread: "新消息",
      notificationMarkAllRead: "全部已读",
      notificationBroadcast: "重要通知",
      notificationAction: "查看详情",
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
      console: "控制台",
      adminConsole: "營運後台",
      aboutVecto: "了解 Vecto",
      login: "登入",
      guest: "帳號註冊",
      home: "返回首頁",
      currentAccount: "目前登入帳號",
      accountFallback: "帳戶",
      accountStatus: "已登入",
      accountRole: "一般帳號",
      accountAdminRole: "管理員",
      accountManagedRole: "管理員代管",
      accountId: "帳號 ID",
      accountClose: "關閉個人資訊",
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
      publishToday: "今日任務",
      publishRemaining: "今日剩餘任務額度",
      billingUnread: "尚未讀取",
      billingLoading: "讀取中…",
      billingReady: "已同步",
      billingPartial: "部分不可用",
      billingClick: "點擊查看",
      billingLegacyPlan: "存量帳號",
      billingActivePlan: "已啟用",
      billingNoPlan: "暫無訂閱",
      billingUnlimited: "不限",
      billingPointUnit: "點",
      billingImageUnit: "張",
      billingPostUnit: "篇",
      profileSignature: "個人簡介",
      profileSignatureEmpty: "暫未填寫個人簡介",
      profileTags: "個人標籤",
      profileTagsEmpty: "暫未添加個人標籤",
      notificationCenter: "通知中心",
      notificationSystem: "系統消息",
      notificationOfficial: "官方消息",
      notificationInteraction: "互動消息",
      notificationClose: "關閉通知中心",
      notificationEmpty: "暫無消息",
      notificationLoading: "正在讀取消息…",
      notificationUnread: "新消息",
      notificationMarkAllRead: "全部已讀",
      notificationBroadcast: "重要通知",
      notificationAction: "查看詳情",
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

  function seedExplicitAdminContext() {
    const params = new URLSearchParams(window.location.search || "");
    const explicitAdmin = params.get("admin_console") === "1";
    const workspaceUserId = String(
      params.get("admin_workspace_user_id") || params.get("manage_user_id") || "",
    ).trim();
    if (!explicitAdmin && !workspaceUserId) return;
    markAdminConsoleContext();
    if (workspaceUserId && publicPagePreservesAdminWorkspace()) {
      writeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY, workspaceUserId);
    } else if (explicitAdmin) {
      removeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY);
    }
  }

  function storedAdminWorkspaceUserId() {
    const stored = String(sessionValue(ADMIN_WORKSPACE_STORAGE_KEY) || "").trim();
    if (stored) return stored;
    if (window.location.pathname !== "/admin-profile.html") return "";
    const value = String(new URLSearchParams(window.location.search).get("return_manage_user_id") || "").trim();
    return /^\d+$/.test(value) && Number(value) > 0 ? value : "";
  }

  function adminConsoleTarget(view = "", workspaceUserId = "") {
    const params = new URLSearchParams();
    if (view) params.set("view", view);
    if (workspaceUserId) params.set("manage_user_id", workspaceUserId);
    const query = params.toString();
    return query ? `/admin-console.html?${query}` : "/admin-console.html";
  }

  function adminOperationalPublicTarget(value) {
    const text = String(value || "").trim();
    if (!text.startsWith("/")) return text;
    const adminContext = currentSessionMode === "admin" || hasAdminConsoleContext()
      || document.querySelector('meta[name="admin-console-session"]')?.content === "1";
    if (!adminContext) return text;
    const url = new URL(text, window.location.origin);
    url.searchParams.set("admin_console", "1");
    const workspaceUserId = storedAdminWorkspaceUserId();
    const preservesWorkspace = [
      "/",
      "/index.html",
      "/about-vecto.html",
      "/proxy-market.html",
      "/subscription.html",
      "/pricing.html",
    ].includes(url.pathname);
    if (workspaceUserId && preservesWorkspace) {
      url.searchParams.set("admin_workspace_user_id", workspaceUserId);
    } else {
      url.searchParams.delete("admin_workspace_user_id");
      url.searchParams.delete("manage_user_id");
    }
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function syncOperationalPublicTargets() {
    document.querySelectorAll(
      [
        '[data-site-home-label]',
        '[data-site-nav-key="solution"]',
        '[data-site-nav-key="aboutVecto"]',
        '[data-site-nav-key="proxyMarket"]',
        '[data-site-nav-key="pricing"]',
        '[data-site-subscription-entry]',
        'a[href^="/about-vecto.html"]',
        'a[href^="/proxy-market.html"]',
        'a[href^="/subscription.html"]',
        'a[href^="/pricing.html"]',
      ].join(", "),
    ).forEach((link) => {
      link.setAttribute("href", adminOperationalPublicTarget(link.getAttribute("href") || "/"));
    });
  }

  function publicPagePreservesAdminWorkspace() {
    const page = document.querySelector("[data-site-header]")?.dataset.sitePage || "";
    return ["home", "aboutVecto", "proxyMarket", "pricing"].includes(page)
      || (window.location.pathname === "/admin-profile.html" && Boolean(storedAdminWorkspaceUserId()));
  }

  function syncConsoleEntryTargets() {
    const adminSessionMeta = document.querySelector('meta[name="admin-console-session"]')?.content === "1";
    const adminContext = adminSessionMeta || currentSessionMode === "admin" || hasAdminConsoleContext();
    const workspaceUserId = adminContext && publicPagePreservesAdminWorkspace()
      ? storedAdminWorkspaceUserId()
      : "";
    const target = adminContext ? adminConsoleTarget("", workspaceUserId) : "/console.html";
    document.querySelectorAll("[data-console-entry]").forEach((link) => {
      link.setAttribute("href", target);
      if (link.dataset.siteConsoleBoundaryReady === "true") return;
      link.dataset.siteConsoleBoundaryReady = "true";
      link.addEventListener("click", () => {
        const isAdminEntry = document.querySelector('meta[name="admin-console-session"]')?.content === "1"
          || currentSessionMode === "admin"
          || hasAdminConsoleContext();
        if (!isAdminEntry) return;
        if (!publicPagePreservesAdminWorkspace()) removeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY);
        markAdminConsoleContext();
        link.setAttribute("href", adminConsoleTarget("", workspaceUserId));
      });
    });
  }

  function syncPublicAdminEntry() {
    const labels = copy[currentLanguage()];
    const isAdmin = currentSessionMode === "admin"
      && (currentAccount?.is_admin === true || Number(currentAccount?.is_admin) === 1);
    document.querySelectorAll('[data-site-header][data-site-mode="public"]').forEach((header) => {
      const actions = header.querySelector(".header-actions");
      if (!actions) return;
      let entry = actions.querySelector(":scope > [data-site-admin-entry]");
      if (!isAdmin) {
        entry?.remove();
        return;
      }
      if (!entry) {
        entry = document.createElement("button");
        entry.type = "button";
        entry.className = "site-admin-entry";
        entry.dataset.siteAdminEntry = "true";
        entry.addEventListener("click", () => {
          removeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY);
          markAdminConsoleContext();
          window.location.assign("/admin.html");
        });
        const notificationMenu = actions.querySelector(":scope > [data-site-notification-menu]");
        const accountMenu = actions.querySelector(":scope > [data-site-account-menu]");
        if (notificationMenu) notificationMenu.before(entry);
        else if (accountMenu) accountMenu.before(entry);
        else actions.appendChild(entry);
      }
      entry.hidden = false;
      entry.textContent = labels.adminConsole;
      entry.setAttribute("aria-label", labels.adminConsole);
    });
  }

  function currentTheme() {
    return "light";
  }

  function themeEnabled() {
    return false;
  }

  function currentLanguage() {
    return document.documentElement.dataset.language === "zh-Hant" ? "zh-Hant" : "zh-Hans";
  }

  function writePreference(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  }

  function setTheme(_theme, { emit = true } = {}) {
    const nextTheme = "light";
    document.documentElement.dataset.theme = nextTheme;
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
    const register = key === "guest" ? " data-open-register" : "";
    const active = current === key ? ' aria-current="page"' : "";
    const classAttribute = className ? ` class="${className}"` : "";
    return `<a${classAttribute} data-site-nav-key="${key}" href="${href}"${active}${busy}${register}><span data-site-copy="${key}"></span></a>`;
  }

  function navigationLinks(page, current) {
    return [
      navLink({ key: "solution", href: navHref(page, "#solution"), current }),
      navLink({ key: "proxyMarket", href: "/proxy-market.html", current }),
      navLink({ key: "console", href: "/console.html", current }),
      navLink({ key: "aboutVecto", href: "/about-vecto.html", current }),
    ].join("");
  }

  function languageIcon() {
    return `<svg class="site-language-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21M12 3C9.6 5.5 8.4 8.5 8.4 12s1.2 6.5 3.6 9"></path></svg><span class="site-language-state" data-site-language-state></span>`;
  }

  function subscriptionIcon() {
    return `<svg class="site-subscription-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"></path><path d="M4 9h16M8 14h3"></path><path d="m17.5 12.5.7 1.4 1.6.2-1.2 1.1.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.1 1.6-.2z"></path></svg>`;
  }

  function subscriptionControl(page = "") {
    const active = page === "pricing" ? ' aria-current="page"' : "";
    return `<a class="site-icon-button site-subscription-link" href="/subscription.html"${active} data-site-subscription-entry aria-label="" title="">${subscriptionIcon()}</a>`;
  }

  function notificationIcon() {
    return `<svg class="site-notification-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path></svg>`;
  }

  function notificationMenuMarkup() {
    return `<div class="site-notification-menu" data-site-notification-menu>
      <button class="site-icon-button site-notification-trigger" type="button" aria-controls="siteNotificationPopover" aria-haspopup="dialog" aria-expanded="false" data-site-notification-trigger>
        ${notificationIcon()}<span class="site-notification-dot" data-site-notification-dot hidden></span>
      </button>
      <aside id="siteNotificationPopover" class="site-notification-popover" data-site-notification-popover hidden role="dialog">
        <div class="site-notification-head">
          <strong data-site-copy="notificationCenter"></strong>
          <button class="site-notification-close" type="button" data-site-notification-close>${closeIcon()}</button>
        </div>
        <div class="site-notification-tabs" role="tablist">
          <button type="button" role="tab" data-site-notification-category="system" data-site-copy="notificationSystem"></button>
          <button type="button" role="tab" data-site-notification-category="official" data-site-copy="notificationOfficial"></button>
          <button type="button" role="tab" data-site-notification-category="interaction" data-site-copy="notificationInteraction"></button>
        </div>
        <div class="site-notification-list" data-site-notification-list aria-live="polite"></div>
        <button class="site-notification-read-all" type="button" data-site-notification-read-all data-site-copy="notificationMarkAllRead"></button>
      </aside>
    </div>`;
  }

  function menuIcon() {
    return `<svg class="site-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14"></path></svg>`;
  }

  function closeIcon() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>`;
  }

  function mobileMenuItemIcon(key) {
    const paths = {
      solution: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"></path><path d="m18.5 16 .7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"></path>',
      proxyMarket: '<path d="M12 21s6-5.6 6-11a6 6 0 0 0-12 0c0 5.4 6 11 6 11Z"></path><circle cx="12" cy="10" r="2"></circle>',
      pricing: '<rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="M4 9h16M8 14h3"></path><path d="m16 12 .7 1.4 1.6.2-1.2 1.1.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.1 1.6-.2z"></path>',
      console: '<rect x="4" y="4" width="6" height="6" rx="1"></rect><rect x="14" y="4" width="6" height="6" rx="1"></rect><rect x="4" y="14" width="6" height="6" rx="1"></rect><path d="M15 17h5M17.5 14.5v5"></path>',
      aboutVecto: '<circle cx="12" cy="12" r="8"></circle><path d="M12 10v5M12 7h.01"></path>',
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[key] || paths.solution}</svg>`;
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
    return `<div class="site-account-preferences" data-site-personal-controls>
      <span class="site-account-section-label" data-site-copy="personalSettings"></span>
      <button id="languageToggle" class="site-account-preference" type="button" data-site-language-toggle>
        <span class="site-account-preference-icon" aria-hidden="true">${languageIcon()}</span>
      </button>
    </div>`;
  }

  function accountMenuMarkup(page = "console") {
    const workspaceActions = page === "console"
      ? `<div class="site-account-action-row site-account-workspace-actions" aria-label="控制台快捷操作">
          <button type="button" data-site-open-console-view="tasks">任务队列</button>
          <button type="button" data-site-open-console-view="console_settings">设置</button>
        </div>`
      : "";
    return `<div class="site-account-menu" data-site-account-menu>
      <button class="site-user" type="button" aria-controls="siteAccountPopover" aria-haspopup="dialog" aria-expanded="false" data-site-user-title data-site-account-trigger>
        <span class="site-user-avatar" data-site-account-avatar>${accountIcon()}</span><span id="consoleMeName" data-site-account-name></span><svg class="site-user-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"></path></svg>
      </button>
      <div id="siteAccountPopover" class="site-account-popover" data-site-account-popover hidden role="dialog" aria-label="个人信息">
        <div class="site-account-summary">
          <span class="site-account-avatar" aria-hidden="true" data-site-account-avatar>${accountIcon()}</span>
          <span class="site-account-identity">
            <strong data-site-account-name></strong>
            <span data-site-account-role></span>
            <span class="site-account-id-line"><span data-site-copy="accountId"></span><strong data-site-account-id>-</strong></span>
          </span>
          <span class="site-account-status"><i aria-hidden="true"></i><span data-site-copy="accountStatus"></span></span>
          <button class="site-account-close" type="button" aria-label="" title="" data-site-account-close>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>
          </button>
        </div>
        <div class="site-account-profile-fields">
          <div class="site-account-profile-field">
            <span class="site-account-profile-label" data-site-copy="profileSignature"></span>
            <p data-site-account-signature data-site-copy="profileSignatureEmpty"></p>
          </div>
          <div class="site-account-profile-field">
            <span class="site-account-profile-label" data-site-copy="profileTags"></span>
            <div class="site-account-tags" data-site-account-tags><span class="site-account-placeholder" data-site-copy="profileTagsEmpty"></span></div>
          </div>
        </div>
        <section class="site-account-billing" data-site-account-billing aria-labelledby="siteAccountBillingTitle">
          <div class="site-account-section-head">
            <span id="siteAccountBillingTitle" data-site-copy="billing"></span>
            <span class="site-account-billing-state" data-site-billing-status data-site-copy="billingUnread">尚未读取</span>
          </div>
          <div class="site-account-billing-grid" aria-live="polite">
            <div class="site-account-billing-card"><span data-site-copy="billingPoints">算力余额</span><strong data-site-billing-points>—</strong></div>
            <div class="site-account-billing-card"><span data-site-copy="billingSubscription">当前订阅</span><strong data-site-billing-subscription>—</strong></div>
            <div class="site-account-billing-card"><span data-site-copy="billingImages">图片额度</span><strong data-site-billing-images>—</strong></div>
            <div class="site-account-billing-card"><span data-site-copy="billingPending">待审批</span><strong data-site-billing-pending>—</strong></div>
            <div class="site-account-billing-card"><span data-site-copy="publishToday">今日任务</span><strong data-site-publish-used>—</strong></div>
            <div class="site-account-billing-card"><span data-site-copy="publishRemaining">剩余额度</span><strong data-site-publish-remaining>—</strong></div>
          </div>
          <div class="site-account-action-row">
            <button type="button" data-site-open-billing data-site-copy="billingView"></button>
            <button type="button" data-site-open-settings data-site-copy="personalProfile"></button>
            <button type="button" data-site-open-subscription data-site-copy="pricing"></button>
          </div>
        </section>
        ${workspaceActions}
        ${accountPreferencesMarkup(page)}
        <div class="site-account-footer">
          <button class="site-account-logout" type="button" data-site-account-logout><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M14 8l4 4-4 4M18 12H9"></path></svg><span data-site-copy="logout"></span></button>
          <span class="site-account-message" role="status" aria-live="polite" data-site-account-message></span>
        </div>
      </div>
    </div>`;
  }

  function mobileNavigationLinks(page, current) {
    return [
      { key: "solution", href: navHref(page, "#solution") },
      { key: "proxyMarket", href: "/proxy-market.html" },
      { key: "pricing", href: "/subscription.html" },
      { key: "console", href: "/console.html" },
      { key: "aboutVecto", href: "/about-vecto.html" },
    ].map(({ key, href }) => {
      const active = current === key ? ' aria-current="page"' : "";
      const consoleEntry = key === "console" ? " data-console-entry" : "";
      return `<a class="site-mobile-menu-link" data-site-nav-key="${key}" href="${href}"${active}${consoleEntry}><span class="site-mobile-menu-link-icon">${mobileMenuItemIcon(key)}</span><span data-site-copy="${key}"></span><svg class="site-mobile-menu-link-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg></a>`;
    }).join("");
  }

  function renderMobileMenu(page, current) {
    return `<div class="site-mobile-menu" data-site-mobile-menu>
      <button class="site-menu-toggle" type="button" aria-controls="siteMobileMenuDrawer" aria-expanded="false" data-site-menu-toggle>${menuIcon()}<span data-site-copy="menu"></span></button>
      <div class="site-mobile-menu-backdrop" data-site-mobile-menu-backdrop hidden>
        <aside id="siteMobileMenuDrawer" class="site-mobile-menu-panel" aria-label="站内导航" data-site-navigation>
          <div class="site-mobile-menu-panel-head"><span data-site-copy="navigationLabel"></span><button class="site-mobile-menu-close" type="button" aria-label="关闭导航" data-site-mobile-menu-close>${closeIcon()}</button></div>
          <nav class="site-mobile-menu-links">${mobileNavigationLinks(page, current)}</nav>
        </aside>
      </div>
    </div>`;
  }

  function installMobileMenu(header, page, current) {
    if (!header) return null;
    const template = document.createElement("template");
    template.innerHTML = renderMobileMenu(page, current).trim();
    const nextMenu = template.content.firstElementChild;
    if (!nextMenu) return null;
    const existingMenu = header.querySelector("[data-site-mobile-menu]");
    if (existingMenu) existingMenu.replaceWith(nextMenu);
    const brand = header.querySelector(":scope > .brand");
    const existingBranding = brand?.closest(".site-header-branding");
    if (existingBranding) {
      if (!existingBranding.contains(nextMenu)) existingBranding.prepend(nextMenu);
      return nextMenu;
    }
    if (!brand) return nextMenu;
    const branding = document.createElement("div");
    branding.className = "site-header-branding";
    brand.replaceWith(branding);
    branding.append(nextMenu, brand);
    return nextMenu;
  }

  function renderActions(mode, page, current) {
    const controls = `<div class="site-global-controls" data-site-global-controls><button id="languageToggle" class="site-icon-button site-language-button" type="button" data-site-language-toggle>${languageIcon()}</button></div>`;
    if (mode === "authenticated") {
      return `${subscriptionControl(page)}${notificationMenuMarkup()}${accountMenuMarkup(page)}`;
    }
    return `${subscriptionControl(page)}${controls}<button class="header-login" type="button" data-open-login><span data-site-copy="login"></span></button>`;
  }

  function fallbackMarkup(page, mode, current) {
    return `
      <div class="site-header-branding">${renderMobileMenu(page, current)}<a class="brand" href="/" data-site-home-label>
        <span class="brand-logo-frame" aria-hidden="true"><img class="brand-logo" src="/assets/opc/vecto-logo-ui-icon.png?v=20260711" alt="" width="1024" height="1024" /></span>
        <span class="brand-text"><span class="brand-name">Vecto</span><span class="brand-local" data-site-copy="brandLocal"></span></span>
      </a></div>
      <nav class="site-nav" data-site-navigation>${navigationLinks(page, current)}</nav>
      <div class="header-actions">${renderActions(mode, page, current)}</div>`;
  }

  function installUnifiedAccountMenu(header, page = "console") {
    const actions = header?.querySelector(".header-actions");
    if (!actions) return null;
    const template = document.createElement("template");
    template.innerHTML = accountMenuMarkup(page).trim();
    const nextMenu = template.content.firstElementChild;
    if (!nextMenu) return null;
    const existingMenu = actions.querySelector("[data-site-account-menu]");
    if (existingMenu) existingMenu.replaceWith(nextMenu);
    else actions.appendChild(nextMenu);
    return nextMenu;
  }

  function mountAccountMenu(host, { page = "home" } = {}) {
    if (!host) return null;
    const template = document.createElement("template");
    template.innerHTML = accountMenuMarkup(page).trim();
    const nextMenu = template.content.firstElementChild;
    if (!nextMenu) return null;
    host.replaceChildren(nextMenu);
    host.dataset.siteAccountHost = "true";
    bindPreferenceControls(host);
    bindAccountMenus(host);
    sync();
    return nextMenu;
  }

  function installUnifiedNotificationMenu(header) {
    const actions = header?.querySelector(".header-actions");
    if (!actions) return null;
    const template = document.createElement("template");
    template.innerHTML = notificationMenuMarkup().trim();
    const nextMenu = template.content.firstElementChild;
    if (!nextMenu) return null;
    const existingMenu = actions.querySelector("[data-site-notification-menu]");
    if (existingMenu) existingMenu.replaceWith(nextMenu);
    else {
      const accountMenu = actions.querySelector("[data-site-account-menu]");
      if (accountMenu) accountMenu.before(nextMenu);
      else actions.appendChild(nextMenu);
    }
    return nextMenu;
  }

  function syncMenuState(menu) {
    const toggle = menu.querySelector("[data-site-menu-toggle]");
    if (toggle) toggle.setAttribute("aria-expanded", menu.classList.contains("is-open") ? "true" : "false");
  }

  function cancelMobileMenuClose(menu) {
    const pending = mobileMenuCloseTimers.get(menu);
    if (!pending) return;
    window.clearTimeout(pending.timeoutId);
    pending.backdrop.removeEventListener("transitionend", pending.onTransitionEnd);
    mobileMenuCloseTimers.delete(menu);
  }

  function setMobileMenuBackgroundInert(menu, active) {
    if (!menu) return;
    if (active) {
      if (mobileMenuIsolation.has(menu)) return;
      const isolated = [];
      let current = menu;
      while (current?.parentElement) {
        const parent = current.parentElement;
        Array.from(parent.children).forEach((sibling) => {
          if (sibling === current || sibling.inert) return;
          sibling.inert = true;
          isolated.push(sibling);
        });
        if (parent === document.body) break;
        current = parent;
      }
      mobileMenuIsolation.set(menu, isolated);
      document.body.classList.add("site-mobile-menu-active");
      return;
    }
    const isolated = mobileMenuIsolation.get(menu) || [];
    isolated.forEach((sibling) => {
      sibling.inert = false;
    });
    mobileMenuIsolation.delete(menu);
    if (!document.querySelector("[data-site-mobile-menu].is-open, [data-site-mobile-menu].is-closing")) {
      document.body.classList.remove("site-mobile-menu-active");
    }
  }

  function finishMobileMenuClose(menu, backdrop) {
    cancelMobileMenuClose(menu);
    if (!menu.classList.contains("is-closing")) return;
    backdrop.hidden = true;
    menu.classList.remove("is-closing");
    menu.closest(".site-header")?.classList.remove("site-mobile-menu-open");
    setMobileMenuBackgroundInert(menu, false);
  }

  function setMobileMenuOpen(menu, open, { restoreFocus = false } = {}) {
    if (!menu) return;
    const toggle = menu.querySelector("[data-site-menu-toggle]");
    const backdrop = menu.querySelector("[data-site-mobile-menu-backdrop]");
    if (!toggle || !backdrop) return;
    const nextOpen = Boolean(open);
    const shouldRestoreFocus = !nextOpen && restoreFocus && backdrop.contains(document.activeElement);
    cancelMobileMenuClose(menu);
    if (nextOpen) {
      backdrop.hidden = false;
      menu.classList.remove("is-closing");
      menu.closest(".site-header")?.classList.add("site-mobile-menu-open");
      window.requestAnimationFrame(() => menu.classList.add("is-open"));
      toggle.setAttribute("aria-expanded", "true");
      setMobileMenuBackgroundInert(menu, true);
      document.querySelectorAll("[data-site-account-menu].is-open").forEach((accountMenu) => setAccountMenuOpen(accountMenu, false));
      document.querySelectorAll("[data-site-notification-menu].is-open").forEach((notificationMenu) => setNotificationMenuOpen(notificationMenu, false));
      return;
    }
    menu.classList.remove("is-open");
    syncMenuState(menu);
    if (backdrop.hidden) {
      menu.classList.remove("is-closing");
      menu.closest(".site-header")?.classList.remove("site-mobile-menu-open");
      setMobileMenuBackgroundInert(menu, false);
    } else {
      menu.classList.add("is-closing");
      const completeClose = () => finishMobileMenuClose(menu, backdrop);
      const onTransitionEnd = (event) => {
        if (event.target !== backdrop || event.propertyName !== "opacity") return;
        completeClose();
      };
      backdrop.addEventListener("transitionend", onTransitionEnd);
      const timeoutId = window.setTimeout(completeClose, 340);
      mobileMenuCloseTimers.set(menu, { timeoutId, backdrop, onTransitionEnd });
    }
    if (shouldRestoreFocus) toggle.focus({ preventScroll: true });
  }

  function bindMobileMenus(header) {
    header.querySelectorAll("[data-site-mobile-menu]").forEach((menu) => {
      if (menu.dataset.siteMobileMenuReady === "true") return;
      menu.dataset.siteMobileMenuReady = "true";
      const toggle = menu.querySelector("[data-site-menu-toggle]");
      const backdrop = menu.querySelector("[data-site-mobile-menu-backdrop]");
      toggle?.addEventListener("click", () => setMobileMenuOpen(menu, !menu.classList.contains("is-open"), { restoreFocus: true }));
      menu.querySelector("[data-site-mobile-menu-close]")?.addEventListener("click", () => setMobileMenuOpen(menu, false, { restoreFocus: true }));
      backdrop?.addEventListener("click", (event) => {
        if (event.target === backdrop) setMobileMenuOpen(menu, false, { restoreFocus: true });
      });
      menu.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => setMobileMenuOpen(menu, false)));
    });
  }

  function syncAccountPanelScrollLock() {
    const panelActive = Boolean(document.querySelector(
      "[data-site-account-menu].is-open, [data-site-account-menu].is-closing, [data-site-notification-menu].is-open, [data-site-notification-menu].is-closing",
    ));
    document.body.classList.toggle("site-account-panel-active", panelActive);
  }

  function cancelAccountPanelClose(menu) {
    const pending = accountPanelCloseTimers.get(menu);
    if (!pending) return;
    window.clearTimeout(pending.timeoutId);
    pending.popover.removeEventListener("transitionend", pending.onTransitionEnd);
    accountPanelCloseTimers.delete(menu);
  }

  function finishAccountPanelClose(menu, popover) {
    cancelAccountPanelClose(menu);
    if (!menu.classList.contains("is-closing")) return;
    popover.hidden = true;
    menu.classList.remove("is-closing");
    menu.closest(".site-header")?.classList.remove("site-account-menu-open");
    syncAccountPanelScrollLock();
  }

  function setAccountMenuOpen(menu, open, { restoreFocus = false } = {}) {
    if (!menu) return;
    const trigger = menu.querySelector("[data-site-account-trigger]");
    const popover = menu.querySelector("[data-site-account-popover]");
    if (!trigger || !popover) return;
    const nextOpen = Boolean(open);
    const shouldRestoreFocus = !nextOpen && restoreFocus && popover.contains(document.activeElement);
    cancelAccountPanelClose(menu);
    trigger.setAttribute("aria-expanded", nextOpen ? "true" : "false");
    if (nextOpen) {
      menu.closest(".site-header")?.classList.toggle("site-account-menu-open", true);
      popover.hidden = false;
      menu.classList.remove("is-closing");
      window.requestAnimationFrame(() => {
        if (trigger.getAttribute("aria-expanded") === "true") menu.classList.add("is-open");
      });
      syncAccountPanelScrollLock();
      document.querySelectorAll("[data-site-mobile-menu].is-open").forEach((mobileMenu) => setMobileMenuOpen(mobileMenu, false));
      document.querySelectorAll("[data-site-notification-menu].is-open").forEach((notificationMenu) => setNotificationMenuOpen(notificationMenu, false));
      window.dispatchEvent(new CustomEvent(EVENT_ACCOUNT_MENU_OPEN, { detail: { account: currentAccount } }));
      return;
    }
    menu.classList.remove("is-open");
    if (popover.hidden) {
      menu.classList.remove("is-closing");
      menu.closest(".site-header")?.classList.toggle("site-account-menu-open", false);
      syncAccountPanelScrollLock();
    } else {
      menu.classList.add("is-closing");
      // Keep the header stacking context above the workspace until the
      // rightward exit transition has fully completed.
      menu.closest(".site-header")?.classList.toggle("site-account-menu-open", true);
      const completeClose = () => finishAccountPanelClose(menu, popover);
      const onTransitionEnd = (event) => {
        if (event.target !== popover || event.propertyName !== "transform") return;
        completeClose();
      };
      popover.addEventListener("transitionend", onTransitionEnd);
      const timeoutId = window.setTimeout(completeClose, 460);
      accountPanelCloseTimers.set(menu, { timeoutId, popover, onTransitionEnd });
      syncAccountPanelScrollLock();
    }
    if (shouldRestoreFocus) trigger.focus({ preventScroll: true });
  }

  function cancelNotificationPanelClose(menu) {
    const pending = notificationPanelCloseTimers.get(menu);
    if (!pending) return;
    window.clearTimeout(pending.timeoutId);
    pending.popover.removeEventListener("transitionend", pending.onTransitionEnd);
    notificationPanelCloseTimers.delete(menu);
  }

  function finishNotificationPanelClose(menu, popover) {
    cancelNotificationPanelClose(menu);
    if (!menu.classList.contains("is-closing")) return;
    popover.hidden = true;
    menu.classList.remove("is-closing");
    menu.closest(".site-header")?.classList.remove("site-notification-menu-open");
    syncAccountPanelScrollLock();
  }

  function setNotificationMenuOpen(menu, open, { restoreFocus = false } = {}) {
    if (!menu) return;
    const trigger = menu.querySelector("[data-site-notification-trigger]");
    const popover = menu.querySelector("[data-site-notification-popover]");
    if (!trigger || !popover) return;
    const nextOpen = Boolean(open);
    const shouldRestoreFocus = !nextOpen && restoreFocus && popover.contains(document.activeElement);
    cancelNotificationPanelClose(menu);
    trigger.setAttribute("aria-expanded", nextOpen ? "true" : "false");
    if (nextOpen) {
      menu.closest(".site-header")?.classList.add("site-notification-menu-open");
      popover.hidden = false;
      menu.classList.remove("is-closing");
      window.requestAnimationFrame(() => {
        if (trigger.getAttribute("aria-expanded") === "true") menu.classList.add("is-open");
      });
      syncAccountPanelScrollLock();
      document.querySelectorAll("[data-site-mobile-menu].is-open").forEach((mobileMenu) => setMobileMenuOpen(mobileMenu, false));
      document.querySelectorAll("[data-site-account-menu].is-open").forEach((accountMenu) => setAccountMenuOpen(accountMenu, false));
      void markNotificationsRead({ all: true });
      window.dispatchEvent(new CustomEvent(EVENT_NOTIFICATION_MENU_OPEN));
      return;
    }
    menu.classList.remove("is-open");
    if (popover.hidden) {
      menu.classList.remove("is-closing");
      menu.closest(".site-header")?.classList.remove("site-notification-menu-open");
      syncAccountPanelScrollLock();
    } else {
      menu.classList.add("is-closing");
      menu.closest(".site-header")?.classList.add("site-notification-menu-open");
      const completeClose = () => finishNotificationPanelClose(menu, popover);
      const onTransitionEnd = (event) => {
        if (event.target !== popover || event.propertyName !== "transform") return;
        completeClose();
      };
      popover.addEventListener("transitionend", onTransitionEnd);
      const timeoutId = window.setTimeout(completeClose, 460);
      notificationPanelCloseTimers.set(menu, { timeoutId, popover, onTransitionEnd });
      syncAccountPanelScrollLock();
    }
    if (shouldRestoreFocus) trigger.focus({ preventScroll: true });
  }

  function accountRoleLabel(account, labels) {
    if (account?.acting_admin) return labels.accountManagedRole;
    return account?.is_admin ? labels.accountAdminRole : labels.accountRole;
  }

  function syncAccount() {
    const labels = copy[currentLanguage()];
    const username = String(currentAccount?.full_name || currentAccount?.display_name || currentAccount?.username || "").trim() || labels.accountFallback;
    const signature = String(currentAccount?.profile_signature || currentAccount?.profileSignature || "").trim();
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
    document.querySelectorAll("[data-site-account-signature]").forEach((node) => {
      node.dataset.siteCopy = signature ? "" : "profileSignatureEmpty";
      node.textContent = signature || labels.profileSignatureEmpty;
      node.classList.toggle("is-placeholder", !signature);
    });
    document.querySelectorAll("[data-site-account-tags]").forEach((node) => {
      if (!tags.length) {
        const placeholder = document.createElement("span");
        placeholder.className = "site-account-placeholder";
        placeholder.dataset.siteCopy = "profileTagsEmpty";
        placeholder.textContent = labels.profileTagsEmpty;
        node.replaceChildren(placeholder);
        return;
      }
      node.replaceChildren(...tags.map((tag) => {
        const item = document.createElement("span");
        item.textContent = tag;
        return item;
      }));
    });
    renderAccountBilling();
    syncConsoleEntryTargets();
    syncPublicAdminEntry();
  }

  function setAccount(account) {
    const previousIdentity = accountBillingState.identityKey;
    const previousNotificationIdentity = notificationState.identityKey;
    currentAccount = account && typeof account === "object" ? { ...account } : null;
    const nextIdentity = accountBillingIdentityKey();
    if (previousIdentity !== nextIdentity) {
      accountBillingRequest += 1;
      accountBillingState.identityKey = nextIdentity;
      accountBillingState.loading = false;
      accountBillingState.loaded = false;
      accountBillingState.partial = false;
      accountBillingState.summary = {};
      accountBillingState.orders = {};
    }
    if (previousNotificationIdentity !== nextIdentity) {
      notificationRequest += 1;
      notificationState.identityKey = nextIdentity;
      notificationState.items = [];
      notificationState.unread = { system: 0, official: 0, interaction: 0, total: 0 };
      notificationState.activeCategory = "system";
      notificationState.loading = false;
      notificationState.loaded = false;
    }
    syncAccount();
    if (currentAccount && currentSessionMode !== "guest") {
      void loadAccountBilling();
      startNotificationPolling();
      void loadNotifications();
    } else {
      stopNotificationPolling();
      renderNotifications();
    }
  }

  function accountBillingIdentityKey() {
    if (!currentAccount?.id) return "";
    const workspaceUserId = currentSessionMode === "admin" ? storedAdminWorkspaceUserId() : "";
    return `${currentSessionMode}:${workspaceUserId || currentAccount.id}`;
  }

  function accountRequestHeaders() {
    const headers = new Headers({ Accept: "application/json" });
    if (currentSessionMode === "admin") {
      headers.set("X-Admin-Console", "1");
      const workspaceUserId = storedAdminWorkspaceUserId();
      if (workspaceUserId) headers.set("X-Admin-Workspace-User-ID", workspaceUserId);
    }
    return headers;
  }

  async function fetchAccountJson(path) {
    const response = await fetch(path, {
      credentials: "include",
      cache: "no-store",
      headers: accountRequestHeaders(),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(String(payload?.detail || payload?.message || `HTTP ${response.status}`));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function notificationNumber(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function normalizeNotificationUnread(value) {
    const unread = value && typeof value === "object" ? value : {};
    return {
      system: notificationNumber(unread.system),
      official: notificationNumber(unread.official),
      interaction: notificationNumber(unread.interaction),
      total: notificationNumber(unread.total),
    };
  }

  function safeNotificationActionUrl(value) {
    const clean = String(value || "").trim();
    if (!clean) return "";
    try {
      const parsed = new URL(clean, window.location.origin);
      if (!["http:", "https:"].includes(parsed.protocol)) return "";
      if (parsed.origin !== window.location.origin && !/^https?:\/\//i.test(clean)) return "";
      return parsed.href;
    } catch {
      return "";
    }
  }

  function notificationDateLabel(value) {
    const seconds = notificationNumber(value);
    if (!seconds) return "";
    try {
      return new Intl.DateTimeFormat(currentLanguage() === "zh-Hant" ? "zh-Hant" : "zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(seconds * 1000));
    } catch {
      return "";
    }
  }

  function notificationCategoryLabel(category, labels) {
    return {
      system: labels.notificationSystem,
      official: labels.notificationOfficial,
      interaction: labels.notificationInteraction,
    }[category] || labels.notificationSystem;
  }

  function notificationAnnounceKey(item) {
    return `vecto-notification-announced:${notificationState.identityKey || "user"}:${notificationNumber(item?.id)}`;
  }

  function createNotificationItem(item) {
    const labels = copy[currentLanguage()];
    const card = document.createElement("article");
    card.className = "site-notification-item";
    card.classList.toggle("is-unread", !item.read);
    card.dataset.siteNotificationId = String(notificationNumber(item.id));

    const meta = document.createElement("div");
    meta.className = "site-notification-item-meta";
    const category = document.createElement("span");
    category.textContent = notificationCategoryLabel(item.category, labels);
    const time = document.createElement("time");
    time.textContent = notificationDateLabel(item.created_at);
    meta.append(category, time);

    const title = document.createElement("strong");
    title.className = "site-notification-item-title";
    title.textContent = String(item.title || labels.notificationCenter);
    const body = document.createElement("p");
    body.className = "site-notification-item-body";
    body.textContent = String(item.body || "");
    card.append(meta, title);
    if (body.textContent) card.append(body);

    const actionUrl = safeNotificationActionUrl(item.action?.url);
    if (actionUrl) {
      const action = document.createElement("a");
      action.className = "site-notification-item-action";
      action.href = actionUrl;
      action.textContent = String(item.action?.label || labels.notificationAction);
      action.addEventListener("click", () => void markNotificationsRead({ ids: [item.id] }));
      card.append(action);
    }
    card.addEventListener("click", () => {
      if (!item.read) void markNotificationsRead({ ids: [item.id] });
    });
    return card;
  }

  function renderNotifications() {
    const labels = copy[currentLanguage()];
    const totalUnread = notificationNumber(notificationState.unread.total);
    document.querySelectorAll("[data-site-notification-trigger]").forEach((button) => {
      button.title = labels.notificationCenter;
      button.setAttribute("aria-label", totalUnread
        ? `${labels.notificationCenter}，${totalUnread} 条${labels.notificationUnread}`
        : labels.notificationCenter);
    });
    document.querySelectorAll("[data-site-notification-dot]").forEach((dot) => {
      dot.hidden = totalUnread <= 0;
      dot.setAttribute("aria-label", totalUnread ? `${totalUnread} ${labels.notificationUnread}` : "");
    });
    document.querySelectorAll("[data-site-notification-close]").forEach((button) => {
      button.title = labels.notificationClose;
      button.setAttribute("aria-label", labels.notificationClose);
    });
    document.querySelectorAll("[data-site-notification-category]").forEach((button) => {
      const category = button.dataset.siteNotificationCategory || "system";
      const active = category === notificationState.activeCategory;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
      const count = notificationNumber(notificationState.unread[category]);
      let badge = button.querySelector(".site-notification-tab-count");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "site-notification-tab-count";
        button.append(badge);
      }
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.hidden = count <= 0;
    });
    document.querySelectorAll("[data-site-notification-list]").forEach((list) => {
      if (notificationState.loading && !notificationState.loaded) {
        const status = document.createElement("p");
        status.className = "site-notification-empty";
        status.textContent = labels.notificationLoading;
        list.replaceChildren(status);
        return;
      }
      const items = notificationState.items.filter((item) => item.category === notificationState.activeCategory);
      if (!items.length) {
        const status = document.createElement("p");
        status.className = "site-notification-empty";
        status.textContent = labels.notificationEmpty;
        list.replaceChildren(status);
        return;
      }
      list.replaceChildren(...items.map(createNotificationItem));
    });
    document.querySelectorAll("[data-site-notification-read-all]").forEach((button) => {
      button.disabled = totalUnread <= 0;
    });
  }

  function closeNotificationBroadcast() {
    document.querySelectorAll("[data-site-notification-broadcast]").forEach((node) => node.remove());
  }

  function showNotificationBroadcast(item) {
    if (!item || item.read || !notificationNumber(item.id)) return;
    const announceKey = notificationAnnounceKey(item);
    if (window.sessionStorage.getItem(announceKey) === "1") return;
    window.sessionStorage.setItem(announceKey, "1");
    closeNotificationBroadcast();
    const labels = copy[currentLanguage()];
    const overlay = document.createElement("div");
    overlay.className = "site-notification-broadcast";
    overlay.dataset.siteNotificationBroadcast = "true";
    overlay.innerHTML = `<section class="site-notification-broadcast-dialog" role="alertdialog" aria-modal="true">
      <div class="site-notification-broadcast-head">
        <span>${notificationIcon()}</span>
        <strong></strong>
        <button type="button">${closeIcon()}</button>
      </div>
      <h2></h2>
      <p></p>
      <div class="site-notification-broadcast-actions"></div>
    </section>`;
    overlay.querySelector(".site-notification-broadcast-head strong").textContent = labels.notificationBroadcast;
    overlay.querySelector("h2").textContent = String(item.title || labels.notificationCenter);
    overlay.querySelector("p").textContent = String(item.body || "");
    const actions = overlay.querySelector(".site-notification-broadcast-actions");
    const actionUrl = safeNotificationActionUrl(item.action?.url);
    if (actionUrl) {
      const action = document.createElement("a");
      action.href = actionUrl;
      action.textContent = String(item.action?.label || labels.notificationAction);
      actions.append(action);
    }
    const close = () => {
      void markNotificationsRead({ ids: [item.id] });
      overlay.remove();
    };
    overlay.querySelector("button").setAttribute("aria-label", labels.notificationClose);
    overlay.querySelector("button").addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    document.body.append(overlay);
    overlay.querySelector("button").focus({ preventScroll: true });
  }

  async function loadNotifications({ announce = true, force = false } = {}) {
    if (!currentAccount || currentSessionMode === "guest") return null;
    if (notificationState.loading && !force) return null;
    const requestId = ++notificationRequest;
    notificationState.loading = true;
    renderNotifications();
    try {
      const payload = await fetchAccountJson("/api/notifications?limit=100");
      if (requestId !== notificationRequest) return null;
      notificationState.items = Array.isArray(payload?.items) ? payload.items : [];
      notificationState.unread = normalizeNotificationUnread(payload?.unread);
      notificationState.loaded = true;
      notificationState.loading = false;
      renderNotifications();
      if (announce && !document.hidden) {
        const latestUnread = notificationState.items.find((item) => !item.read);
        if (latestUnread) showNotificationBroadcast(latestUnread);
      }
      return payload;
    } catch {
      if (requestId !== notificationRequest) return null;
      notificationState.loading = false;
      renderNotifications();
      return null;
    }
  }

  async function markNotificationsRead({ ids = [], category = "", all = false } = {}) {
    if (!currentAccount || currentSessionMode === "guest") return null;
    const cleanIds = [...new Set(ids.map(notificationNumber).filter(Boolean))];
    const previousItems = notificationState.items;
    const previousUnread = notificationState.unread;
    const matches = (item) => all
      || (category && item.category === category)
      || cleanIds.includes(notificationNumber(item.id));
    const markedItems = previousItems.map((item) => matches(item) ? { ...item, read: true } : item);
    notificationRequest += 1;
    notificationState.loading = false;
    notificationState.items = markedItems;
    notificationState.unread = {
      system: markedItems.filter((item) => item.category === "system" && !item.read).length,
      official: markedItems.filter((item) => item.category === "official" && !item.read).length,
      interaction: markedItems.filter((item) => item.category === "interaction" && !item.read).length,
      total: markedItems.filter((item) => !item.read).length,
    };
    renderNotifications();
    const headers = accountRequestHeaders();
    headers.set("Content-Type", "application/json");
    try {
      const response = await fetch("/api/notifications/read", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ ids: cleanIds, category, all }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error("notification read failed");
      if (payload?.unread && typeof payload.unread === "object") {
        notificationState.unread = normalizeNotificationUnread(payload.unread);
      }
      renderNotifications();
      try {
        window.localStorage.setItem(NOTIFICATION_STORAGE_KEY, `${Date.now()}`);
      } catch {}
      return payload;
    } catch {
      notificationState.items = previousItems;
      notificationState.unread = previousUnread;
      renderNotifications();
      return null;
    }
  }

  function startNotificationPolling() {
    if (notificationPollTimer) return;
    notificationPollTimer = window.setInterval(() => {
      if (!document.hidden) void loadNotifications();
    }, NOTIFICATION_POLL_MS);
  }

  function stopNotificationPolling() {
    if (!notificationPollTimer) return;
    window.clearInterval(notificationPollTimer);
    notificationPollTimer = 0;
  }

  function accountNumber(value) {
    const number = Number(value || 0);
    return new Intl.NumberFormat(currentLanguage() === "zh-Hant" ? "zh-Hant" : "zh-CN", {
      maximumFractionDigits: 2,
    }).format(Number.isFinite(number) ? number : 0);
  }

  function renderAccountBilling() {
    const labels = copy[currentLanguage()];
    const summary = accountBillingState.summary || {};
    const orders = accountBillingState.orders || {};
    const publishPolicy = currentAccount?.publish_policy || {};
    const subscriptions = Array.isArray(summary.subscriptions) ? summary.subscriptions : [];
    const activeSubscription = subscriptions.find((item) => String(item?.status || "").toLowerCase() === "active")
      || subscriptions[0]
      || {};
    const billingMode = String(summary.billing_mode || "").toLowerCase();
    const unlimited = Boolean(summary.effective_unlimited || summary.unlimited_compute || summary.admin_waived);
    const planName = activeSubscription.plan_name
      || activeSubscription.name
      || activeSubscription.plan_sku
      || (billingMode === "legacy"
        ? labels.billingLegacyPlan
        : (summary.subscription_active ? labels.billingActivePlan : labels.billingNoPlan));
    const imageRemaining = summary.free_images?.total_remaining ?? 0;
    const pendingOrders = orders.pending_count ?? orders.pending_orders_count ?? 0;
    const publishWaived = Boolean(publishPolicy.waived);
    const publishUsed = Number(publishPolicy.used || 0);
    const publishLimit = Number(publishPolicy.limit || 0);
    const publishRemaining = Number(publishPolicy.remaining ?? Math.max(0, publishLimit - publishUsed));

    document.querySelectorAll("[data-site-account-billing]").forEach((host) => {
      const statusNode = host.querySelector("[data-site-billing-status]");
      const pointsNode = host.querySelector("[data-site-billing-points]");
      const subscriptionNode = host.querySelector("[data-site-billing-subscription]");
      const imagesNode = host.querySelector("[data-site-billing-images]");
      const pendingNode = host.querySelector("[data-site-billing-pending]");
      const publishUsedNode = host.querySelector("[data-site-publish-used]");
      const publishRemainingNode = host.querySelector("[data-site-publish-remaining]");
      if (accountBillingState.loading && !accountBillingState.loaded) {
        if (statusNode) statusNode.textContent = labels.billingLoading;
        [pointsNode, subscriptionNode, imagesNode, pendingNode].forEach((node) => {
          if (node) node.textContent = "…";
        });
      } else if (accountBillingState.loaded) {
        if (statusNode) statusNode.textContent = accountBillingState.partial ? labels.billingPartial : labels.billingReady;
        if (pointsNode) pointsNode.textContent = unlimited
          ? labels.billingUnlimited
          : `${accountNumber(summary.points)} ${labels.billingPointUnit}`;
        if (subscriptionNode) subscriptionNode.textContent = planName;
        if (imagesNode) imagesNode.textContent = `${accountNumber(imageRemaining)} ${labels.billingImageUnit}`;
        if (pendingNode) pendingNode.textContent = accountNumber(pendingOrders);
      } else if (statusNode) {
        statusNode.textContent = labels.billingUnread;
      }
      if (publishUsedNode) publishUsedNode.textContent = publishWaived
        ? labels.billingUnlimited
        : `${accountNumber(publishUsed)} / ${accountNumber(publishLimit)}`;
      if (publishRemainingNode) publishRemainingNode.textContent = publishWaived
        ? labels.billingUnlimited
        : `${accountNumber(publishRemaining)} ${labels.billingPostUnit}`;
    });
  }

  async function loadAccountBilling({ force = false } = {}) {
    const identityKey = accountBillingIdentityKey();
    if (!identityKey || currentSessionMode === "guest") return;
    if (accountBillingState.loading || (!force && accountBillingState.loaded && accountBillingState.identityKey === identityKey)) return;
    const requestId = ++accountBillingRequest;
    accountBillingState.identityKey = identityKey;
    accountBillingState.loading = true;
    accountBillingState.partial = false;
    renderAccountBilling();
    const requests = [
      fetchAccountJson("/api/auth/me"),
      fetchAccountJson("/api/billing/summary"),
      fetchAccountJson("/api/billing/orders?limit=1"),
    ];
    const [accountResult, summaryResult, ordersResult] = await Promise.allSettled(requests);
    if (requestId !== accountBillingRequest || identityKey !== accountBillingIdentityKey()) return;
    accountBillingState.loading = false;
    accountBillingState.loaded = true;
    accountBillingState.partial = [accountResult, summaryResult, ordersResult].some((result) => result.status === "rejected");
    if (accountResult.status === "fulfilled") {
      currentAccount = { ...(currentAccount || {}), ...(accountResult.value || {}) };
      syncAccount();
      window.dispatchEvent(new CustomEvent("vecto:account-data-refresh", { detail: { account: currentAccount } }));
    }
    if (summaryResult.status === "fulfilled") accountBillingState.summary = summaryResult.value || {};
    if (ordersResult.status === "fulfilled") accountBillingState.orders = ordersResult.value || {};
    renderAccountBilling();
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

  function publicLogoutLocation() {
    const url = new URL(window.location.href);
    ["login", "return_url", "admin_console", "admin_workspace_user_id", "manage_user_id"].forEach((key) => {
      url.searchParams.delete(key);
    });
    return `${url.pathname}${url.search}${url.hash}`;
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
      window.location.replace(publicLogoutLocation());
    } catch (error) {
      setLogoutPending(false, error?.message || copy[currentLanguage()].logoutFailed);
    }
  }

  function bindPreferenceControls(root) {
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
      const trigger = menu.querySelector("[data-site-account-trigger]");
      trigger?.addEventListener("click", () => {
        setAccountMenuOpen(menu, trigger.getAttribute("aria-expanded") !== "true", { restoreFocus: true });
      });
      menu.querySelector("[data-site-account-close]")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setAccountMenuOpen(menu, false, { restoreFocus: true });
      });
      menu.addEventListener("pointerenter", (event) => {
        if (event.pointerType && event.pointerType !== "mouse") return;
        // The profile is now a full-page drawer; do not open or dismiss it
        // simply because the pointer crosses the compact header control.
      });
      menu.addEventListener("focusin", (event) => {
        // Focusing the trigger happens before a mouse click. Let the click
        // handler own the toggle so focusin cannot immediately close it.
        if (event.target === trigger) return;
        setAccountMenuOpen(menu, true);
      });
      menu.querySelector("[data-site-open-billing]")?.addEventListener("click", () => {
        setAccountMenuOpen(menu, false);
        openAccountConsoleView("billing");
      });
      menu.querySelector("[data-site-open-settings]")?.addEventListener("click", () => {
        setAccountMenuOpen(menu, false);
        openProfilePage();
      });
      menu.querySelector("[data-site-open-subscription]")?.addEventListener("click", () => {
        setAccountMenuOpen(menu, false);
        window.location.assign(adminOperationalPublicTarget("/subscription.html"));
      });
      menu.querySelectorAll("[data-site-open-console-view]").forEach((button) => {
        button.addEventListener("click", () => {
          const view = String(button.dataset.siteOpenConsoleView || "");
          if (!["tasks", "console_settings"].includes(view)) return;
          setAccountMenuOpen(menu, false);
          window.dispatchEvent(new CustomEvent(EVENT_CONSOLE_VIEW_REQUEST, { detail: { view } }));
        });
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

  function bindNotificationMenus(header) {
    header.querySelectorAll("[data-site-notification-menu]").forEach((menu) => {
      if (menu.dataset.siteNotificationReady === "true") return;
      menu.dataset.siteNotificationReady = "true";
      const trigger = menu.querySelector("[data-site-notification-trigger]");
      trigger?.addEventListener("click", () => {
        setNotificationMenuOpen(menu, trigger.getAttribute("aria-expanded") !== "true", { restoreFocus: true });
      });
      menu.querySelector("[data-site-notification-close]")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setNotificationMenuOpen(menu, false, { restoreFocus: true });
      });
      menu.querySelectorAll("[data-site-notification-category]").forEach((button) => {
        button.addEventListener("click", () => {
          const category = String(button.dataset.siteNotificationCategory || "");
          if (!["system", "official", "interaction"].includes(category)) return;
          notificationState.activeCategory = category;
          renderNotifications();
        });
      });
      menu.querySelector("[data-site-notification-read-all]")?.addEventListener("click", () => {
        void markNotificationsRead({ all: true });
      });
    });
  }

  function openAccountConsoleView(view) {
    const targetView = "billing";
    const isAdminConsole = document.querySelector('meta[name="admin-console-session"]')?.content === "1";
    if (window.location.pathname === "/console.html" || window.location.pathname === "/admin-console.html") {
      window.dispatchEvent(new CustomEvent(EVENT_BILLING_REQUEST));
      return;
    }
    if (isAdminConsole || currentSessionMode === "admin" || hasAdminConsoleContext()) {
      const workspaceUserId = publicPagePreservesAdminWorkspace() ? storedAdminWorkspaceUserId() : "";
      if (!workspaceUserId) removeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY);
      window.location.assign(adminConsoleTarget(targetView, workspaceUserId));
      return;
    }
    window.location.assign(`/console.html?${new URLSearchParams({ view: targetView }).toString()}`);
  }

  function openProfilePage() {
    const isAdminConsole = document.querySelector('meta[name="admin-console-session"]')?.content === "1";
    const adminContext = isAdminConsole || currentSessionMode === "admin" || hasAdminConsoleContext();
    if (!adminContext) {
      window.location.assign("/profile.html");
      return;
    }
    const workspaceUserId = storedAdminWorkspaceUserId();
    const params = new URLSearchParams();
    if (workspaceUserId) params.set("return_manage_user_id", workspaceUserId);
    window.location.assign(`/admin-profile.html${params.size ? `?${params}` : ""}`);
  }

  function syncAdminWorkspaceContext() {
    const adminSessionMeta = document.querySelector('meta[name="admin-console-session"]');
    if (!adminSessionMeta) {
      if (!publicPagePreservesAdminWorkspace() || !hasAdminConsoleContext()) {
        removeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY);
      }
      return;
    }
    const isAdminConsole = adminSessionMeta.content === "1";
    if (!isAdminConsole) {
      clearAdminConsoleContext();
      currentSessionMode = "user";
      return;
    }
    markAdminConsoleContext();
    currentSessionMode = "admin";
    const workspaceUserId = String(document.querySelector('meta[name="admin-workspace-user-id"]')?.content || "").trim()
      || (window.location.pathname === "/admin-profile.html" ? storedAdminWorkspaceUserId() : "");
    if (workspaceUserId) writeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY, workspaceUserId);
    else removeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY);
  }

  function showAuthenticatedAccount(header, account) {
    if (!header || header.dataset.siteMode !== "public") return;
    const actions = header.querySelector(".header-actions");
    if (!actions) return;
    actions.querySelectorAll("[data-open-login]").forEach((node) => node.remove());
    actions.querySelectorAll(":scope > .site-global-controls").forEach((node) => node.remove());
    installUnifiedAccountMenu(header, header.dataset.sitePage || "home");
    installUnifiedNotificationMenu(header);
    header.dataset.siteAuthState = "authenticated";
    bindPreferenceControls(header);
    bindAccountMenus(header);
    bindNotificationMenus(header);
    setAccount(account);
    sync();
  }

  function showGuestAccount(header) {
    if (!header || header.dataset.siteMode !== "public") return;
    header.querySelectorAll("[data-site-notification-menu]").forEach((node) => node.remove());
    header.dataset.siteAuthState = "guest";
    currentSessionMode = "guest";
    setAccount(null);
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
      const preserveWorkspace = publicPagePreservesAdminWorkspace();
      const workspaceUserId = preserveWorkspace ? storedAdminWorkspaceUserId() : "";
      if (!preserveWorkspace) removeSessionValue(ADMIN_WORKSPACE_STORAGE_KEY);
      const adminResult = await fetchSessionAccount({ admin: true, workspaceUserId });
      if (adminResult.response.ok && adminResult.account) {
        markAdminConsoleContext();
        return {
          mode: "admin",
          account: adminResult.account,
          workspaceUserId,
          path: adminConsoleTarget("", workspaceUserId),
        };
      }
      throw new Error(`Admin session validation failed: HTTP ${adminResult.response.status}`);
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
      // A remembered admin workspace can outlive its admin cookie.  Do not
      // bounce that stale context through /admin again: /admin redirects back
      // to this public login view and creates a navigation loop.
      if (hasAdminConsoleContext()) clearAdminConsoleContext();
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
      // The admin session may have expired while the public page was open.
      // Clear only the stale client-side marker and stay on the login page.
      // Redirecting to /admin here loops back to ?login=1 forever.
      if (hasAdminConsoleContext()) clearAdminConsoleContext();
      showGuestAccount(header);
      return null;
    }
  }

  async function refreshPublicSession() {
    const headers = [...document.querySelectorAll("[data-site-header]")]
      .filter((entry) => entry.dataset.siteMode === "public");
    const accounts = await Promise.all(headers.map((entry) => hydratePublicSession(entry)));
    return accounts.find(Boolean) || null;
  }

  function mount(header) {
    if (!header || header.dataset.siteReady === "true") return header;
    const page = header.dataset.sitePage || "home";
    const mode = header.dataset.siteMode || (page === "console" ? "authenticated" : "public");
    const resolvedMode = mode === "public" ? page : mode;
    const current = ["pricing", "console", "proxyMarket", "aboutVecto"].includes(page) ? page : "";

    if (mode === "public" && !header.dataset.siteAuthState) header.dataset.siteAuthState = "pending";

    if (!header.querySelector(".brand")) {
      header.innerHTML = fallbackMarkup(page, resolvedMode, current);
    }
    installMobileMenu(header, page, current);
    if (mode === "authenticated") {
      installUnifiedAccountMenu(header, page);
      installUnifiedNotificationMenu(header);
    }

    header.dataset.siteReady = "true";
    header.dataset.i18nSkip = "true";
    bindPreferenceControls(header);
    bindMobileMenus(header);
    bindAccountMenus(header);
    bindNotificationMenus(header);
    sync();
    if (mode === "public") void hydratePublicSession(header);
    return header;
  }

  seedExplicitAdminContext();

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
    document.querySelectorAll("[data-site-subscription-entry]").forEach((node) => {
      node.title = labels.pricing;
      node.setAttribute("aria-label", labels.pricing);
    });
    document.querySelectorAll("[data-site-personal-controls]").forEach((node) => node.setAttribute("aria-label", labels.personalSettings));
    document.querySelectorAll("[data-site-account-popover]").forEach((node) => node.setAttribute("aria-label", labels.personalProfile));
    document.querySelectorAll("[data-site-account-close]").forEach((node) => {
      node.title = labels.accountClose;
      node.setAttribute("aria-label", labels.accountClose);
    });
    document.querySelectorAll("[data-site-console-label]").forEach((node) => node.setAttribute("aria-label", labels.console));
    document.querySelectorAll("[data-site-user-title]").forEach((node) => node.title = labels.currentAccount);
    document.querySelectorAll("[data-site-account-name]").forEach((node) => {
      const value = node.textContent.trim();
      if (!value || value === copy["zh-Hans"].accountFallback || value === copy["zh-Hant"].accountFallback) {
        node.textContent = labels.accountFallback;
      }
    });
    syncOperationalPublicTargets();
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
    renderNotifications();
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
    document.querySelectorAll("[data-site-account-menu].is-open").forEach((menu) => {
      if (!menu.contains(event.target)) setAccountMenuOpen(menu, false);
    });
    document.querySelectorAll("[data-site-notification-menu].is-open").forEach((menu) => {
      if (!menu.contains(event.target)) setNotificationMenuOpen(menu, false);
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    document.querySelectorAll("[data-site-mobile-menu].is-open").forEach((menu) => setMobileMenuOpen(menu, false, { restoreFocus: true }));
    document.querySelectorAll("[data-site-account-menu].is-open").forEach((menu) => setAccountMenuOpen(menu, false, { restoreFocus: true }));
    document.querySelectorAll("[data-site-notification-menu].is-open").forEach((menu) => setNotificationMenuOpen(menu, false, { restoreFocus: true }));
  });
  window.addEventListener("storage", (event) => {
    if (event.key === LANGUAGE_STORAGE_KEY) {
      setLanguage(event.newValue || DEFAULT_LANGUAGE, { persist: false });
    }
    if (event.key === null) {
      setTheme("light", { persist: false });
      setLanguage(DEFAULT_LANGUAGE, { persist: false });
    }
    if (event.key === "vecto-proxy-market-read") void syncProxyMarketBadge();
    if (event.key === NOTIFICATION_STORAGE_KEY) void loadNotifications({ force: true, announce: false });
  });
  window.addEventListener("vecto:proxy-market-read", () => void syncProxyMarketBadge());
  window.addEventListener(EVENT_ACCOUNT_MENU_OPEN, () => void loadAccountBilling({ force: true }));
  window.addEventListener(EVENT_NOTIFICATION_MENU_OPEN, () => void loadNotifications({ force: true, announce: false }));
  window.addEventListener("vecto:notifications-updated", () => void loadNotifications({ force: true, announce: false }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void loadNotifications({ force: true });
  });

  syncAdminWorkspaceContext();
  document.querySelectorAll("[data-site-header]").forEach(mount);
  setTheme("light", { persist: false });
  setLanguage(storedValue(LANGUAGE_STORAGE_KEY, DEFAULT_LANGUAGE), { persist: false });

  window.VectoSiteNavigation = {
    mount,
    mountAccountMenu,
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
    refreshPublicSession,
    syncProxyMarketBadge,
    refreshNotifications: () => loadNotifications({ force: true }),
  };
  window.dispatchEvent(new CustomEvent("vecto:navigation-ready"));
})();
