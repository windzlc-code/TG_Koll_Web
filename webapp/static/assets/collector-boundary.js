(() => {
  document.documentElement.dataset.deploymentRole = "collector";
  const replacements = new Map([
    ["\u6cbb\u7406\u6982\u89c8", "\u91c7\u96c6\u8282\u70b9\u6982\u89c8"],
    ["\u4f18\u5148\u5904\u7406\u5ba2\u6237\u8d26\u53f7\u3001\u751f\u6210\u8bb0\u5f55\u548c\u989d\u5ea6\u7b56\u7565\uff0c\u4f9b\u5e94\u5546\u914d\u7f6e\u96c6\u4e2d\u653e\u5728\u540e\u6bb5\u7ef4\u62a4\u3002", "\u96c6\u4e2d\u7ef4\u62a4\u91c7\u96c6\u8d26\u53f7\u6c60\u3001\u4ee3\u7406\u3001CRM\u3001\u70ed\u70b9\u6293\u53d6\u4e0e\u8fd0\u884c\u914d\u7f6e\uff0c\u7528\u6237\u4ea7\u54c1\u529f\u80fd\u7531\u4e3b\u7ad9\u8d1f\u8d23\u3002"],
    ["\u4efb\u52a1\u63a7\u5236\u53f0", "\u91c7\u96c6\u63a7\u5236\u53f0"],
    ["Vecto OS \u8fd0\u8425\u5de5\u4f5c\u533a", "Vecto OS \u7ba1\u7406\u5458\u91c7\u96c6\u8282\u70b9"],
    ["\u4efb\u52a1\u5de5\u4f5c\u53f0", "\u91c7\u96c6\u5de5\u4f5c\u53f0"],
    ["\u7d20\u6750\u751f\u6210\u540e\u53f0", "\u91c7\u96c6\u8282\u70b9\u540e\u53f0"],
    ["\u8fd0\u8425\u4e0e\u914d\u7f6e\u4e2d\u5fc3", "\u91c7\u96c6\u4e0e\u8d26\u53f7\u57fa\u7840\u8bbe\u65bd"],
    ["CRM \u6a21\u5757", "CRM \u540e\u7aef"],
  ]);
  const replaceExactText = () => document.querySelectorAll("h1,h2,h3,p,span,strong,div,button").forEach((node) => {
    if (node.children.length) return;
    const current = String(node.textContent || "").trim();
    if (replacements.has(current)) node.textContent = replacements.get(current);
  });
  const enforceAdminPageBoundary = () => {
    if (!document.body.classList.contains("page-admin")) return;
    const allowed = new Set(["overview", "runtime", "sentimentCookies"]);
    const current = String(location.hash || "").replace(/^#admin-/, "");
    if (current && !allowed.has(current)) location.hash = "#admin-overview";
  };
  const pruneAdminOverview = () => {
    const hiddenLabels = new Set(["\u5ba2\u6237\u603b\u6570","\u542f\u7528\u5ba2\u6237","\u5f85\u5ba1\u6838\u8d26\u53f7","\u6d3b\u8dc3\u4f1a\u8bdd","\u6709\u6548\u8ba2\u9605","\u5ba2\u6237\u7b97\u529b\u4f59\u989d\u603b\u8ba1","\u7528\u6237\u603b\u6d88\u8017\u989d\u5ea6","\u90ae\u4ef6\u53d1\u9001\u6c47\u603b","\u6bcf\u65e5\u90ae\u4ef6\u4e0a\u9650\u9884\u89c8","\u5ba2\u6237\u8d8b\u52bf","\u8ba1\u8d39\u8d8b\u52bf","\u8d26\u53f7\u751f\u547d\u5468\u671f","\u8ba2\u9605\u5206\u5e03","\u5f85\u5ba1\u6838\u5ba2\u6237","\u5373\u5c06\u5230\u671f\u8ba2\u9605","\u540e\u53f0\u6279\u91cf\u4f5c\u4e1a","\u8ba1\u8d39\u6267\u884c"]);
    document.querySelectorAll("#secOverview strong, #secOverview span").forEach((node) => {
      if (hiddenLabels.has(String(node.textContent || "").trim())) node.closest("article")?.classList.add("collector-boundary-hidden");
    });
    document.querySelectorAll('#secOverview [data-page-jump="users"], #secOverview [data-page-jump="tasks"], #secOverview [data-page-jump="audit"]').forEach((node) => node.remove());
    document.querySelector('#adminPublicLinks a[href="/?admin_console=1"]')?.classList.add("collector-boundary-hidden");
  };
  const cleanCollectorWorkspaceMenu = () => {
    const collectorLabels = new Map([
      ["tweet_generation", "\u70ed\u70b9\u6293\u53d6"],
      ["accounts", "\u8d26\u53f7\u4e0e\u767b\u5f55"],
    ]);
    document.querySelectorAll("#moduleMenu .module-trigger").forEach((button) => {
      const moduleId = String(button.dataset.module || button.dataset.workspaceModule || "").trim();
      const expectedLabel = collectorLabels.get(moduleId);
      const label = button.querySelector(".module-trigger-text > span");
      if (expectedLabel && label && label.textContent !== expectedLabel) label.textContent = expectedLabel;
      const empty = !String(button.textContent || "").trim();
      button.closest(".module-accordion-item")?.classList.toggle("collector-boundary-hidden", empty);
    });
  };
  const collectorHomeCopy = {"hans": {"visualTitle": "Vecto", "visualMeta": "\u7ba1\u7406\u5458\u91c7\u96c6\u57fa\u7840\u8bbe\u65bd", "kicker": "VECTO OS \u00b7 \u91c7\u96c6\u8282\u70b9", "title": "CRM \u4e0e\u70ed\u70b9\u91c7\u96c6\u8fd0\u8425\u4e2d\u5fc3", "lede": "\u672c\u8282\u70b9\u4ec5\u4f9b\u7ba1\u7406\u5458\u7ef4\u62a4\u91c7\u96c6\u8d26\u53f7\u6c60\u3001\u4ee3\u7406\u73af\u5883\u3001CRM \u4e0e\u70ed\u70b9\u6570\u636e\u3002\u7528\u6237\u4ea7\u54c1\u3001\u4eba\u8bbe\u5237\u65b0\u548c\u5185\u5bb9\u751f\u6210\u7531\u4e3b\u7ad9\u8d1f\u8d23\u3002", "login": "\u7ba1\u7406\u5458\u767b\u5f55", "console": "\u70ed\u70b9\u6293\u53d6\u4e0e\u8d26\u53f7\u6c60", "crm": "CRM \u5de5\u4f5c\u53f0", "admin": "\u91c7\u96c6\u8282\u70b9\u540e\u53f0", "chips": ["\u7ba1\u7406\u5458\u4e13\u7528", "\u8d26\u53f7\u73af\u5883\u9694\u79bb", "\u4efb\u52a1\u53ef\u8ffd\u8e2a", "\u5173\u952e\u6b65\u9aa4\u53ef\u63a5\u7ba1"], "loginTitle": "\u7ba1\u7406\u5458\u767b\u5f55", "loginCopy": "\u4ec5\u9650\u91c7\u96c6\u8282\u70b9\u7ba1\u7406\u5458\u767b\u5f55\u3002\u767b\u5f55\u540e\u53ef\u8fdb\u5165 CRM\u3001\u70ed\u70b9\u6293\u53d6\u548c\u7ba1\u7406\u5458\u8d26\u53f7\u6c60\u3002", "username": "\u7ba1\u7406\u5458\u8d26\u53f7", "submit": "\u767b\u5f55\u5e76\u8fdb\u5165\u91c7\u96c6\u8282\u70b9"}, "hant": {"visualTitle": "Vecto", "visualMeta": "\u7ba1\u7406\u54e1\u63a1\u96c6\u57fa\u790e\u8a2d\u65bd", "kicker": "VECTO OS \u00b7 \u63a1\u96c6\u7bc0\u9ede", "title": "CRM \u8207\u71b1\u9ede\u63a1\u96c6\u71df\u904b\u4e2d\u5fc3", "lede": "\u672c\u7bc0\u9ede\u50c5\u4f9b\u7ba1\u7406\u54e1\u7dad\u8b77\u63a1\u96c6\u5e33\u865f\u6c60\u3001\u4ee3\u7406\u74b0\u5883\u3001CRM \u8207\u71b1\u9ede\u8cc7\u6599\u3002\u7528\u6236\u7522\u54c1\u3001\u4eba\u8a2d\u5237\u65b0\u548c\u5167\u5bb9\u751f\u6210\u7531\u4e3b\u7ad9\u8ca0\u8cac\u3002", "login": "\u7ba1\u7406\u54e1\u767b\u5165", "console": "\u71b1\u9ede\u6293\u53d6\u8207\u5e33\u865f\u6c60", "crm": "CRM \u5de5\u4f5c\u53f0", "admin": "\u63a1\u96c6\u7bc0\u9ede\u5f8c\u53f0", "chips": ["\u7ba1\u7406\u54e1\u5c08\u7528", "\u5e33\u865f\u74b0\u5883\u9694\u96e2", "\u4efb\u52d9\u53ef\u8ffd\u8e64", "\u95dc\u9375\u6b65\u9a5f\u53ef\u63a5\u7ba1"], "loginTitle": "\u7ba1\u7406\u54e1\u767b\u5165", "loginCopy": "\u50c5\u9650\u63a1\u96c6\u7bc0\u9ede\u7ba1\u7406\u54e1\u767b\u5165\u3002\u767b\u5165\u5f8c\u53ef\u9032\u5165 CRM\u3001\u71b1\u9ede\u6293\u53d6\u548c\u7ba1\u7406\u54e1\u5e33\u865f\u6c60\u3002", "username": "\u7ba1\u7406\u54e1\u5e33\u865f", "submit": "\u767b\u5165\u4e26\u9032\u5165\u63a1\u96c6\u7bc0\u9ede"}};
  const pruneCollectorHome = () => {
    if (!document.body.classList.contains("home-canvas")) return;
    const header = document.querySelector("[data-site-header]");
    const authenticated = header?.dataset.siteAuthState === "authenticated" || header?.dataset.siteAuthState === "auth";
    if (authenticated) {
      if (document.body.dataset.collectorHomeRedirected === "true") return;
      document.body.dataset.collectorHomeRedirected = "true";
      window.location.replace("/admin-console.html");
      return;
    }
    document.body.dataset.loginRedirect = "/admin-console.html";
    document.body.classList.remove("modal-open");
    document.querySelectorAll(".auth-register-view, [data-open-register]").forEach((node) => node.remove());
    document.querySelector(".site-footer")?.remove();
    const main = document.querySelector("main#top");
    const dialog = document.querySelector("#loginModal .auth-dialog") || document.querySelector(".collector-login-card");
    if (!main || !dialog) return;
    let shell = main.querySelector(".collector-login-shell");
    if (!shell) {
      main.replaceChildren();
      main.insertAdjacentHTML("afterbegin", `<section class="collector-login-shell" aria-labelledby="loginTitle">
        <div class="collector-login-visual" aria-hidden="true">
          <img src="/assets/opc/home/hero-account-isolation.jpg" alt="" width="1800" height="1289">
          <div><strong>Vecto</strong><span>\u7ba1\u7406\u5458\u91c7\u96c6\u57fa\u7840\u8bbe\u65bd</span></div>
        </div>
        <div class="collector-login-form-host"></div>
      </section>`);
      shell = main.querySelector(".collector-login-shell");
      shell.querySelector(".collector-login-form-host")?.appendChild(dialog);
      dialog.classList.add("collector-login-card");
      dialog.removeAttribute("role");
      dialog.removeAttribute("aria-modal");
      dialog.querySelector("[data-close-login]")?.remove();
      document.querySelector("#loginModal")?.remove();
    }
    const language = /Hant|TW|HK/i.test(String(document.documentElement.lang || "")) ? "hant" : "hans";
    const labels = collectorHomeCopy[language];
    const title = dialog.querySelector("#loginTitle");
    const copy = dialog.querySelector(".auth-copy");
    const username = dialog.querySelector('label[for="loginUsername"] > span');
    const submit = dialog.querySelector('#homeLoginForm button[type="submit"] > span');
    if (title) title.textContent = labels.loginTitle;
    if (copy) copy.textContent = language === "hant"
      ? "\u767b\u5165\u5f8c\u76f4\u63a5\u9032\u5165\u7d71\u4e00\u63a1\u96c6\u63a7\u5236\u53f0\u3002CRM \u524d\u7aef\u5df2\u4e0b\u7dda\uff0c\u670d\u52d9\u7531\u4e3b\u7ad9\u8abf\u7528\u3002"
      : "\u767b\u5f55\u540e\u76f4\u63a5\u8fdb\u5165\u7edf\u4e00\u91c7\u96c6\u63a7\u5236\u53f0\u3002CRM \u524d\u7aef\u5df2\u4e0b\u7ebf\uff0c\u670d\u52a1\u7531\u4e3b\u7ad9\u8c03\u7528\u3002";
    if (username) username.textContent = labels.username;
    if (submit) submit.textContent = language === "hant" ? "\u767b\u5165\u7d71\u4e00\u63a7\u5236\u53f0" : "\u767b\u5f55\u7edf\u4e00\u63a7\u5236\u53f0";
  };

  const pruneCollectorCrmEntries = () => {
    document.querySelectorAll(
      '[data-crm-entry], a[href^="/crm.html"], #adminPrimaryNav [data-page="crm"], [data-collector-admin-page="crm"], [data-page-view="crm"], #secCrm'
    ).forEach((node) => node.remove());
  };

  const pruneCollectorUnusedProxyMarket = () => {
    document.querySelectorAll(
      '#adminPrimaryNav [data-page="proxyMarket"], [data-collector-admin-page="proxyMarket"], [data-page-view="proxyMarket"], #secProxyMarket, #proxyMarketShareModal, #accountBrowserProxiesTab, #accountBrowserProxiesPage'
    ).forEach((node) => node.remove());
  };

  const collectorAdminPages = new Map([
    ["overview", "运营概览"],
    ["runtime", "系统配置"],
    ["sentimentCookies", "舆情 Cookie"],
  ]);
  const collectorRoute = () => {
    const match = String(location.hash || "").match(/^#operations(?:\/([A-Za-z]+))?$/);
    const page = match && collectorAdminPages.has(match[1]) ? match[1] : "overview";
    return { operations: Boolean(match), page };
  };
  const setCollectorSidebarSelection = (operations, page) => {
    document.querySelectorAll("[data-collector-admin-page]").forEach((button) => {
      const active = operations && button.dataset.collectorAdminPage === page;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    document.querySelectorAll("#moduleMenu .module-trigger").forEach((button) => {
      button.classList.toggle("collector-surface-muted", operations);
      if (operations) {
        button.classList.remove("is-active");
        button.setAttribute("aria-current", "false");
      }
    });
  };
  const switchCollectorSurface = (surface, { updateHash = true, page = "overview" } = {}) => {
    if (!document.body.classList.contains("console-page")) return;
    const operations = surface === "operations";
    const safePage = collectorAdminPages.has(page) ? page : "overview";
    document.body.classList.toggle("collector-operations-active", operations);
    setCollectorSidebarSelection(operations, safePage);
    const panel = document.querySelector("#collectorOperationsSurface");
    if (panel) {
      panel.hidden = !operations;
      if (operations) {
        const frame = panel.querySelector("iframe");
        const frameHash = `#admin-${safePage}`;
        if (frame && frame.dataset.collectorAdminPage !== safePage) {
        frame.dataset.collectorAdminPage = safePage;
        frame.src = `/admin.html?embedded=1${frameHash}`;
      }
      }
    }
    if (updateHash) history.replaceState({}, "", operations ? `#operations/${safePage}` : location.pathname + location.search);
    if (updateHash && window.matchMedia("(max-width: 980px)").matches) document.querySelector("#mobileNavClose")?.click();
  };

  const pruneCollectorAccountMenu = () => {
    document.querySelectorAll(".site-account-profile-fields, [data-site-account-billing], [data-site-workspace-actions]").forEach((node) => node.remove());
    document.querySelectorAll(".site-account-avatar-action[data-site-open-settings]").forEach((button) => {
      const avatar = document.createElement("span");
      avatar.className = "site-account-avatar collector-account-avatar";
      avatar.setAttribute("data-site-account-avatar", "");
      avatar.innerHTML = button.innerHTML;
      button.replaceWith(avatar);
    });
    document.querySelectorAll("[data-site-account-popover]").forEach((popover) => popover.classList.add("collector-account-popover"));
  };

  const installCollectorUnifiedConsole = () => {
    if (!document.body.classList.contains("console-page")) return;
    const applyCollectorTitle = () => { document.title = "Vecto \u7edf\u4e00\u91c7\u96c6\u63a7\u5236\u53f0"; };
    applyCollectorTitle();
    if (!document.body.dataset.collectorTitleReady) {
      document.body.dataset.collectorTitleReady = "true";
      window.addEventListener("load", applyCollectorTitle, { once: true });
      window.setTimeout(applyCollectorTitle, 0);
      window.setTimeout(applyCollectorTitle, 600);
      const titleNode = document.querySelector("title");
      if (titleNode) new MutationObserver(() => {
        if (document.title !== "Vecto \u7edf\u4e00\u91c7\u96c6\u63a7\u5236\u53f0") applyCollectorTitle();
      }).observe(titleNode, { childList: true, characterData: true, subtree: true });
    }
    const headerNav = document.querySelector('.site-header > .site-nav');
    if (headerNav && headerNav.dataset.collectorUnified !== "true") {
      headerNav.dataset.collectorUnified = "true";
      headerNav.setAttribute("aria-label", "统一采集控制台");
      headerNav.innerHTML = `<span class="collector-header-context">统一采集控制台</span>`;
    }
    const consoleNav = document.querySelector("#consoleSidebar .console-nav");
    if (consoleNav && consoleNav.dataset.collectorAdminNavReady !== "true") {
      consoleNav.dataset.collectorAdminNavReady = "true";
      consoleNav.insertAdjacentHTML("beforeend", `<button id="collectorOperationsToggle" type="button" class="nav-parent-toggle" aria-expanded="true"><span>运营后台</span><span class="nav-toggle-arrow" aria-hidden="true"></span></button><div id="collectorOperationsFlow" class="sidebar-flow is-open collector-operations-flow"><div class="sidebar-flow-divider" aria-hidden="true"></div><div class="module-menu collector-admin-menu" aria-label="运营后台导航">${[...collectorAdminPages].map(([page, label]) => `<button type="button" class="module-trigger" data-collector-admin-page="${page}"><span class="module-trigger-text"><span>${label}</span></span></button>`).join("")}</div></div>`);
      const toggle = consoleNav.querySelector("#collectorOperationsToggle");
      const flow = consoleNav.querySelector("#collectorOperationsFlow");
      toggle?.addEventListener("click", () => {
        const expanded = toggle.getAttribute("aria-expanded") !== "false";
        toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
        flow?.classList.toggle("is-open", !expanded);
      });
      consoleNav.addEventListener("click", (event) => {
        const button = event.target.closest("[data-collector-admin-page]");
        if (button) switchCollectorSurface("operations", { page: button.dataset.collectorAdminPage });
        else if (event.target.closest("#moduleMenu .module-trigger")) switchCollectorSurface("console");
      });
    }
    if (!document.body.dataset.collectorWindowSidebarReady) {
      document.body.dataset.collectorWindowSidebarReady = "true";
      window.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target.closest(".site-header .site-menu-toggle") : null;
        if (!target || !window.matchMedia("(max-width: 980px)").matches) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (typeof window.setMobileNavOpen === "function") window.setMobileNavOpen(true);
      }, true);
    }
    const mobileSiteMenu = document.querySelector(".site-header .site-menu-toggle");
    if (mobileSiteMenu && mobileSiteMenu.dataset.collectorSidebarReady !== "true") {
      mobileSiteMenu.dataset.collectorSidebarReady = "true";
      mobileSiteMenu.setAttribute("aria-controls", "consoleSidebar");
      mobileSiteMenu.addEventListener("click", (event) => {
        if (!window.matchMedia("(max-width: 980px)").matches) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (typeof window.setMobileNavOpen === "function") window.setMobileNavOpen(true);
        else document.querySelector("#mobileNavToggle")?.click();
      }, true);
    }
    const main = document.querySelector("#main-content");
    if (main && !main.querySelector("#collectorOperationsSurface")) {
      main.insertAdjacentHTML("beforeend", `<section id="collectorOperationsSurface" class="collector-operations-surface" aria-label="\u8fd0\u8425\u540e\u53f0" hidden><iframe title="\u8fd0\u8425\u540e\u53f0"></iframe></section>`);
    }
    const dock = document.querySelector("#mobileTaskDock");
    if (dock && !dock.querySelector('[data-collector-surface="operations"]')) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.collectorSurface = "operations";
      button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM8 9h8M8 13h8M8 17h5"></path></svg><span>\u8fd0\u8425\u540e\u53f0</span>`;
      button.addEventListener("click", () => switchCollectorSurface("operations"));
      dock.appendChild(button);
    }
    if (!document.body.dataset.collectorAdminCaptureReady) {
      document.body.dataset.collectorAdminCaptureReady = "true";
      document.addEventListener("click", (event) => {
        if (event.target.closest("#openAdmin")) {
          event.preventDefault();
          event.stopImmediatePropagation();
          switchCollectorSurface("operations", { page: collectorRoute().page });
          return;
        }
        if (event.target.closest('#mobileTaskDock button:not([data-collector-surface])')) {
          switchCollectorSurface("console");
        }
      }, true);
      window.addEventListener("hashchange", () => { const route = collectorRoute(); switchCollectorSurface(route.operations ? "operations" : "console", { updateHash: false, page: route.page }); });
    }
    if (document.body.dataset.collectorSurfaceReady !== "true") {
      document.body.dataset.collectorSurfaceReady = "true";
      const route = collectorRoute();
      switchCollectorSurface(route.operations ? "operations" : "console", { updateHash: false, page: route.page });
    }
  };

  const PERSONA_PRODUCT_SELECTORS = [
    '[data-view="persona_dashboard"]',
    ".persona-dashboard-view",
    "#personaDashboardApp",
    ".sidebar-bottom-actions",
    '.account-pool-bound-persona',
    ".account-pool-persona-shell",
    "#accountPoolPersonaSidebar",
    ".account-pool-layout--standalone [data-persona-mobile-list-toggle]",
    ".account-pool-layout--standalone .persona-mobile-list-toggle",
    ".account-pool-layout--standalone .persona-mobile-drawer",
    ".account-pool-layout--standalone .persona-mobile-drawer-backdrop",
    "[data-account-pool-bind-persona]",
  ];
  const stripPersonaProductSurfaces = () => {
    document.querySelectorAll(PERSONA_PRODUCT_SELECTORS.join(",")).forEach((node) => node.remove());
    document.querySelectorAll('#moduleMenu [data-module="personas"], #moduleMenu [data-module="publishing"]').forEach((button) => {
      button.closest(".module-accordion-item")?.remove();
    });
    document.querySelectorAll('#mobileTaskDock [data-workspace-view="persona_dashboard"], #mobileTaskDock [data-module="personas"], #mobileTaskDock [data-module="publishing"]').forEach((node) => node.remove());
  };
  const installCollectorLoginMonitorTab = () => {
    const tabs = document.querySelector(".account-browser-tabs");
    if (!tabs || tabs.querySelector("#accountBrowserBrowsersTab")) return;
    const proxiesTab = tabs.querySelector("#accountBrowserProxiesTab");
    const button = document.createElement("button");
    button.id = "accountBrowserBrowsersTab";
    button.type = "button";
    button.dataset.accountBrowserTab = "browsers";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "false");
    button.setAttribute("aria-controls", "accountBrowserBrowsersPage");
    button.textContent = "登录监控";
    const accountsTab = tabs.querySelector("#accountBrowserAccountsTab, [data-account-browser-tab='accounts']");
    if (accountsTab) accountsTab.after(button);
    else if (proxiesTab) proxiesTab.before(button);
    else tabs.appendChild(button);
    proxiesTab?.remove();
    document.querySelector("#accountBrowserProxiesPage")?.remove();
  };
  if (!window.__collectorPersonaBindGuard) {
    window.__collectorPersonaBindGuard = true;
    document.addEventListener("click", (event) => {
      const bind = event.target.closest?.("[data-account-pool-bind-persona], .account-pool-persona-shell, .account-pool-bound-persona, [data-persona-mobile-list-toggle]");
      if (!bind) return;
      if (!bind.closest?.(".account-pool-layout, .account-browser-shell, .account-pool-persona-shell")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }
  const enforceStandaloneAdmin = () => {
    if (!document.body.classList.contains("page-admin")) return;
    const embedded = window.self !== window.top;
    if (!embedded) {
      if (document.body.dataset.collectorStandaloneRedirected === "true") return;
      document.body.dataset.collectorStandaloneRedirected = "true";
      window.location.replace("/admin-console.html#operations");
      return;
    }
    document.documentElement.dataset.collectorEmbeddedAdmin = "true";
    document.body.classList.add("collector-embedded-admin");
  };
  const applyDom = () => {
    replaceExactText(); cleanCollectorWorkspaceMenu(); enforceAdminPageBoundary(); pruneAdminOverview(); pruneCollectorHome(); pruneCollectorCrmEntries(); pruneCollectorUnusedProxyMarket(); pruneCollectorAccountMenu(); installCollectorUnifiedConsole(); installCollectorLoginMonitorTab(); stripPersonaProductSurfaces();
  };
  const applyRedirectsOnce = () => {
    if (document.body.dataset.collectorRedirectsReady === "true") return;
    document.body.dataset.collectorRedirectsReady = "true";
    enforceStandaloneAdmin();
  };
  const boot = () => { applyRedirectsOnce(); applyDom(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true }); else boot();
  let queued = false;
  new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; applyDom(); }); }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("hashchange", enforceAdminPageBoundary);
})();
