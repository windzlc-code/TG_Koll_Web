function el(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const node = el(id);
  if (!node) return;
  node.textContent = String(value == null ? "" : value);
}

const ADMIN_I18N_MARKER = "data-admin-i18n-ui";
const ADMIN_I18N_ATTRIBUTES = ["title", "aria-label", "placeholder"];
const ADMIN_I18N_SKIP_SELECTOR = [
  "[data-admin-i18n-skip]",
  "script",
  "style",
  "textarea",
  "pre",
  "code",
  "tbody",
  ".msg",
  ".task-list",
  ".admin-health-list",
  ".admin-taxonomy-list",
  ".admin-security-list",
  ".admin-session-list",
  ".admin-password-history-list",
  "#adminName",
  "#adminSessionName",
  "#adminSessionId",
  "#adminSessionCreatedAt",
  "#taskInspectBody",
  "#taskInspectSub",
  "#userDetailBody",
  "#userDetailSub",
].join(", ");
const ADMIN_ZH_HANT_PHRASES = [
  ["账号", "帳號"],
  ["账户", "帳戶"],
  ["运营", "營運"],
  ["后台", "後台"],
  ["信息", "資訊"],
  ["配置", "設定"],
  ["默认", "預設"],
  ["创建", "建立"],
  ["日志", "日誌"],
  ["动态验证码", "動態驗證碼"],
  ["二维码", "QR Code"],
].sort((left, right) => right[0].length - left[0].length);

const adminI18nTextOriginals = new WeakMap();
const adminI18nAttributeOriginals = new WeakMap();
let adminZhHantCharacterMap = null;
let adminLanguageObserver = null;
let adminDocumentTitleSource = document.title;

function currentAdminLanguage() {
  return document.documentElement.dataset.language === "zh-Hant" ? "zh-Hant" : "zh-Hans";
}

function getAdminZhHantCharacterMap() {
  if (adminZhHantCharacterMap) return adminZhHantCharacterMap;
  adminZhHantCharacterMap = new Map();
  const dictionary = window.VectoOpenCcStCharacters;
  if (typeof dictionary !== "string") return adminZhHantCharacterMap;
  dictionary.split("|").forEach((entry) => {
    const separator = entry.indexOf(" ");
    if (separator <= 0) return;
    adminZhHantCharacterMap.set(entry.slice(0, separator), entry.slice(separator + 1));
  });
  return adminZhHantCharacterMap;
}

function toAdminTraditionalChinese(value) {
  let text = String(value || "");
  const protectedPhrases = [];
  ADMIN_ZH_HANT_PHRASES.forEach(([source, target], index) => {
    if (!text.includes(source)) return;
    const token = `\uE300${index}\uE301`;
    text = text.split(source).join(token);
    protectedPhrases.push([token, target]);
  });
  const characters = getAdminZhHantCharacterMap();
  text = Array.from(text).map((character) => characters.get(character) || character).join("");
  protectedPhrases.forEach(([token, target]) => {
    text = text.split(token).join(target);
  });
  return text;
}

function adminTranslatedValue(value, language = currentAdminLanguage()) {
  return language === "zh-Hant" ? toAdminTraditionalChinese(value) : String(value || "");
}

function markAdminUiElement(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE || node.closest(ADMIN_I18N_SKIP_SELECTOR)) return;
  node.setAttribute(ADMIN_I18N_MARKER, "true");
}

function markAdminStaticUi(root = document.body) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    markAdminUiElement(root.parentElement);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim() || node.parentElement?.closest(ADMIN_I18N_SKIP_SELECTOR)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) markAdminUiElement(walker.currentNode.parentElement);
  root.querySelectorAll("[title], [aria-label], [placeholder]").forEach(markAdminUiElement);
}

function translateAdminTextNode(node, language) {
  if (!node?.nodeValue?.trim() || !node.parentElement?.matches(`[${ADMIN_I18N_MARKER}]`)) return;
  if (!adminI18nTextOriginals.has(node)) adminI18nTextOriginals.set(node, node.nodeValue);
  const original = adminI18nTextOriginals.get(node);
  const translated = adminTranslatedValue(original, language);
  if (node.nodeValue !== translated) node.nodeValue = translated;
}

function translateAdminAttributes(node, language) {
  if (!node?.matches?.(`[${ADMIN_I18N_MARKER}]`)) return;
  ADMIN_I18N_ATTRIBUTES.forEach((attribute) => {
    if (!node.hasAttribute(attribute)) return;
    let originals = adminI18nAttributeOriginals.get(node);
    if (!originals) {
      originals = {};
      adminI18nAttributeOriginals.set(node, originals);
    }
    if (!Object.prototype.hasOwnProperty.call(originals, attribute)) originals[attribute] = node.getAttribute(attribute) || "";
    const translated = adminTranslatedValue(originals[attribute], language);
    if (node.getAttribute(attribute) !== translated) node.setAttribute(attribute, translated);
  });
}

function adminUiElements(root) {
  if (!root) return [];
  if (root.nodeType === Node.TEXT_NODE) {
    return root.parentElement?.matches(`[${ADMIN_I18N_MARKER}]`) ? [root.parentElement] : [];
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return [];
  const elements = [];
  if (root.nodeType === Node.ELEMENT_NODE && root.matches(`[${ADMIN_I18N_MARKER}]`)) elements.push(root);
  root.querySelectorAll?.(`[${ADMIN_I18N_MARKER}]`).forEach((node) => elements.push(node));
  return elements;
}

function translateAdminLanguage(root = document.body, language = currentAdminLanguage()) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    translateAdminTextNode(root, language);
    return;
  }
  adminUiElements(root).forEach((node) => {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) translateAdminTextNode(child, language);
    });
    translateAdminAttributes(node, language);
  });
  document.title = adminTranslatedValue(adminDocumentTitleSource, language);
}

function refreshAdminUiTextSource(node, language) {
  if (!node?.nodeValue?.trim() || !node.parentElement?.matches(`[${ADMIN_I18N_MARKER}]`)) return;
  const current = node.nodeValue;
  const previous = adminI18nTextOriginals.get(node);
  const translatedPrevious = previous === undefined ? null : adminTranslatedValue(previous, language);
  if (previous !== undefined && current === translatedPrevious) return;
  adminI18nTextOriginals.set(node, current);
  translateAdminTextNode(node, language);
}

function refreshAdminUiAttributeSource(node, attribute, language) {
  if (!node?.matches?.(`[${ADMIN_I18N_MARKER}]`) || !ADMIN_I18N_ATTRIBUTES.includes(attribute)) return;
  let originals = adminI18nAttributeOriginals.get(node);
  if (!originals) {
    originals = {};
    adminI18nAttributeOriginals.set(node, originals);
  }
  const current = node.getAttribute(attribute) || "";
  const previous = originals[attribute];
  const translatedPrevious = previous === undefined ? null : adminTranslatedValue(previous, language);
  if (previous !== undefined && current === translatedPrevious) return;
  originals[attribute] = current;
  translateAdminAttributes(node, language);
}

function startAdminLanguageObserver() {
  if (adminLanguageObserver || !document.body) return;
  adminLanguageObserver = new MutationObserver((mutations) => {
    const language = currentAdminLanguage();
    mutations.forEach((mutation) => {
      if (mutation.type === "attributes") {
        refreshAdminUiAttributeSource(mutation.target, mutation.attributeName, language);
      } else if (mutation.type === "characterData") {
        refreshAdminUiTextSource(mutation.target, language);
      } else {
        mutation.addedNodes.forEach((node) => {
          markAdminStaticUi(node);
          translateAdminLanguage(node, language);
        });
      }
    });
  });
  adminLanguageObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ADMIN_I18N_ATTRIBUTES,
    characterData: true,
    childList: true,
    subtree: true,
  });
}

function setAdminDocumentTitle(source) {
  adminDocumentTitleSource = String(source || "");
  document.title = adminTranslatedValue(adminDocumentTitleSource);
}

function syncAdminPreferenceControls() {
  const language = currentAdminLanguage();
  const isDark = document.documentElement.dataset.theme === "dark";
  const themeToggle = el("adminThemeToggle");
  if (themeToggle) {
    const label = isDark ? "切换到亮色模式" : "切换到暗色模式";
    themeToggle.setAttribute("aria-label", adminTranslatedValue(label, language));
    themeToggle.setAttribute("title", adminTranslatedValue(label, language));
    themeToggle.setAttribute("aria-pressed", isDark ? "true" : "false");
  }
  const languageToggle = el("adminLanguageToggle");
  if (languageToggle) {
    const label = adminTranslatedValue("选择界面语言", language);
    languageToggle.setAttribute("aria-label", label);
    languageToggle.setAttribute("title", label);
  }
  document.querySelectorAll("[data-admin-language]").forEach((option) => {
    option.setAttribute("aria-checked", option.dataset.adminLanguage === language ? "true" : "false");
  });
}

function setAdminLanguageMenuOpen(open, { restoreFocus = false } = {}) {
  const menu = el("adminLanguageMenu");
  const toggle = el("adminLanguageToggle");
  const panel = el("adminLanguagePanel");
  if (!menu || !toggle || !panel) return;
  const nextOpen = Boolean(open);
  const shouldRestoreFocus = Boolean(!nextOpen && restoreFocus && panel.contains(document.activeElement));
  toggle.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  panel.hidden = !nextOpen;
  panel.setAttribute("aria-hidden", nextOpen ? "false" : "true");
  menu.classList.toggle("is-open", nextOpen);
  if (nextOpen) {
    setAdminProfileMenuOpen(false);
    const selected = panel.querySelector(`[data-admin-language="${currentAdminLanguage()}"]`);
    window.requestAnimationFrame(() => selected?.focus({ preventScroll: true }));
  } else if (shouldRestoreFocus) {
    toggle.focus({ preventScroll: true });
  }
}

function applyAdminLanguage(language) {
  const nextLanguage = language === "zh-Hant" ? "zh-Hant" : "zh-Hans";
  translateAdminLanguage(document.body, nextLanguage);
  syncAdminPreferenceControls();
}

function bindAdminPreferenceControls() {
  const themeToggle = el("adminThemeToggle");
  const languageMenu = el("adminLanguageMenu");
  const languageToggle = el("adminLanguageToggle");
  const languagePanel = el("adminLanguagePanel");
  themeToggle?.addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    window.VectoSiteNavigation?.setTheme(nextTheme);
  });
  languageToggle?.addEventListener("click", () => {
    setAdminLanguageMenuOpen(languageToggle.getAttribute("aria-expanded") !== "true", { restoreFocus: true });
  });
  languagePanel?.querySelectorAll("[data-admin-language]").forEach((option) => {
    option.addEventListener("click", () => {
      window.VectoSiteNavigation?.setLanguage(option.dataset.adminLanguage);
      setAdminLanguageMenuOpen(false, { restoreFocus: true });
    });
  });
  document.addEventListener("click", (event) => {
    if (languageToggle?.getAttribute("aria-expanded") === "true" && !languageMenu?.contains(event.target)) {
      setAdminLanguageMenuOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && languageToggle?.getAttribute("aria-expanded") === "true") {
      event.preventDefault();
      setAdminLanguageMenuOpen(false, { restoreFocus: true });
    }
  });
  window.addEventListener("vecto:theme-change", syncAdminPreferenceControls);
  window.addEventListener("vecto:language-change", (event) => applyAdminLanguage(event.detail?.language));
  syncAdminPreferenceControls();
}

const ADMIN_PAGE_LABELS = {
  overview: "运营概览",
  users: "客户账号",
  taxonomy: "客户治理",
  tasks: "生成记录",
  audit: "审计日志",
  security: "安全告警",
  serviceAccounts: "服务账号",
  proxyMarket: "代理商城",
  pricing: "额度与计费",
  runtime: "系统配置",
  sentimentCookies: "舆情 Cookie",
  account: "账号设置",
};
const ADMIN_MOBILE_NAV_QUERY = "(max-width: 760px)";
const adminMobileNavMedia = window.matchMedia?.(ADMIN_MOBILE_NAV_QUERY);

function isAdminMobileNavMode() {
  return Boolean(adminMobileNavMedia?.matches);
}

function setAdminMobileNavOpen(open, { restoreFocus = false } = {}) {
  const toggle = el("adminMobileNavToggle");
  const drawer = el("adminMobileDrawer");
  const backdrop = el("adminMobileNavBackdrop");
  const main = document.querySelector(".page-admin .main");
  if (!toggle || !drawer || !backdrop || !document.body) return;
  const nextOpen = Boolean(open && isAdminMobileNavMode());
  const shouldRestoreFocus = Boolean(!nextOpen && (restoreFocus || drawer.contains(document.activeElement)));
  document.body.classList.toggle("admin-mobile-nav-open", nextOpen);
  toggle.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  toggle.setAttribute("aria-label", nextOpen ? "关闭后台栏目菜单" : "打开后台栏目菜单");
  toggle.inert = nextOpen;
  drawer.setAttribute("aria-hidden", isAdminMobileNavMode() && !nextOpen ? "true" : "false");
  drawer.inert = Boolean(isAdminMobileNavMode() && !nextOpen);
  if (main) main.inert = nextOpen;
  backdrop.hidden = !nextOpen;
  if (nextOpen) {
    setAdminProfileMenuOpen(false);
    setAdminLanguageMenuOpen(false);
    const focusTarget = drawer.querySelector("[data-page].is-active") || drawer.querySelector("[data-page]");
    window.requestAnimationFrame(() => focusTarget?.focus({ preventScroll: true }));
  } else if (shouldRestoreFocus) {
    toggle.focus({ preventScroll: true });
  }
}

function bindAdminMobileNavigation() {
  const toggle = el("adminMobileNavToggle");
  const closeButton = el("adminMobileNavClose");
  const backdrop = el("adminMobileNavBackdrop");
  if (!toggle || !closeButton || !backdrop) return;
  toggle.addEventListener("click", () => {
    setAdminMobileNavOpen(toggle.getAttribute("aria-expanded") !== "true", { restoreFocus: true });
  });
  closeButton.addEventListener("click", () => setAdminMobileNavOpen(false, { restoreFocus: true }));
  backdrop.addEventListener("click", () => setAdminMobileNavOpen(false, { restoreFocus: true }));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && document.body.classList.contains("admin-mobile-nav-open")) {
      const drawer = el("adminMobileDrawer");
      const focusable = Array.from(drawer?.querySelectorAll("button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])") || [])
        .filter((node) => !node.inert && node.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first && last && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
    }
    if (event.key === "Escape" && document.body.classList.contains("admin-mobile-nav-open")) {
      setAdminMobileNavOpen(false, { restoreFocus: true });
    }
  });
  const syncMode = () => setAdminMobileNavOpen(false);
  if (typeof adminMobileNavMedia?.addEventListener === "function") adminMobileNavMedia.addEventListener("change", syncMode);
  else adminMobileNavMedia?.addListener?.(syncMode);
  setAdminMobileNavOpen(false);
}

function setAdminProfileMenuOpen(open, { restoreFocus = false } = {}) {
  const toggle = el("adminProfileToggle");
  const panel = el("adminProfilePanel");
  if (!toggle || !panel) return;
  const nextOpen = Boolean(open);
  const shouldRestoreFocus = Boolean(!nextOpen && restoreFocus && panel.contains(document.activeElement));
  toggle.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  toggle.setAttribute("aria-label", nextOpen ? "关闭管理员中心" : "打开管理员中心");
  panel.hidden = !nextOpen;
  panel.setAttribute("aria-hidden", nextOpen ? "false" : "true");
  if (nextOpen) {
    setAdminLanguageMenuOpen(false);
    window.requestAnimationFrame(() => el("btnAdminAccountSettings")?.focus({ preventScroll: true }));
  } else if (shouldRestoreFocus) {
    toggle.focus({ preventScroll: true });
  }
}

function bindAdminProfileMenu() {
  const shell = el("adminProfileMenu");
  const toggle = el("adminProfileToggle");
  const panel = el("adminProfilePanel");
  if (!shell || !toggle || !panel) return;
  toggle.addEventListener("click", () => {
    setAdminProfileMenuOpen(toggle.getAttribute("aria-expanded") !== "true", { restoreFocus: true });
  });
  el("adminProfileClose")?.addEventListener("click", () => {
    setAdminProfileMenuOpen(false, { restoreFocus: true });
  });
  el("btnAdminAccountSettings")?.addEventListener("click", () => {
    const changed = setActiveAdminPage("account");
    if (changed !== false) {
      setAdminProfileMenuOpen(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });
  document.addEventListener("click", (event) => {
    if (toggle.getAttribute("aria-expanded") === "true" && !shell.contains(event.target)) {
      setAdminProfileMenuOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      event.preventDefault();
      setAdminProfileMenuOpen(false, { restoreFocus: true });
    }
  });
}

const SENSITIVE_RUNTIME_INPUT_IDS = [
  "rtLlmApiKeyGpt",
  "rtImageGeminiApiKey",
  "rtMuleRouterApiKey",
];

const RUNTIME_SECRET_API_NAMES = {
  rtLlmApiKeyGpt: "llm_api_key_gpt",
  rtImageGeminiApiKey: "image_model_provider_api_key_gemini",
  rtNewPersonaRunningHubApiKey: "new_persona_runninghub_api_key",
  rtMuleRouterApiKey: "mulerouter_api_key",
};
const SENSITIVE_EYE_ICON_SVG = `
  <svg class="sensitive-eye-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>
    <circle cx="12" cy="12" r="3"></circle>
    <path class="sensitive-eye-slash" d="M4 20L20 4"></path>
  </svg>`;
function getSensitiveToggleButton(inputId) {
  return document.querySelector(`.sensitive-toggle-btn[data-target="${inputId}"], [data-secret-target="${inputId}"]`);
}

function updateSensitiveToggleVisual(button, visible) {
  if (!button) return;
  button.innerHTML = SENSITIVE_EYE_ICON_SVG;
  button.classList.toggle("is-visible", !!visible);
  button.setAttribute("aria-pressed", visible ? "true" : "false");
  button.setAttribute("aria-label", visible ? "隐藏密钥内容" : "显示密钥内容");
  button.title = visible ? "隐藏" : "显示";
}

function hasSavedRuntimeSecret(inputId) {
  const input = el(inputId);
  return !!input && input.dataset.runtimeSecretSaved === "true";
}

function runtimeSecretInputValue(inputId) {
  const input = el(inputId);
  if (!input || hasSavedRuntimeSecret(inputId)) return "";
  return input.value.trim();
}

function setRuntimeSecretInputState(inputId, configured, maskedValue) {
  const input = el(inputId);
  if (!input) return;
  const isConfigured = !!configured;
  const mask = isConfigured ? String(maskedValue || "") : "";
  input.type = "password";
  input.value = mask;
  input.dataset.runtimeSecretSaved = isConfigured ? "true" : "false";
  input.dataset.runtimeSecretMask = mask;
  input.classList.toggle("is-saved-runtime-secret", isConfigured);
  input.placeholder = isConfigured ? "已保存 API Key，输入新 Key 后替换" : input.dataset.emptyPlaceholder || input.placeholder;
  const button = getSensitiveToggleButton(inputId);
  if (button) {
    updateSensitiveToggleVisual(button, false);
  }
}

function normalizeAdminPage(value) {
  const raw = String(value || "").replace(/^#/, "").trim();
  const mapped = ADMIN_PAGE_ALIASES[raw] || raw.replace(/^admin-/, "");
  return ADMIN_PAGES.has(mapped) ? mapped : "overview";
}

function readAdminPageFromHash() {
  return normalizeAdminPage(location.hash || "");
}

function setActiveAdminPage(page, updateHash = true) {
  const nextPage = normalizeAdminPage(page);
  if ((adminState.userPasswordResetInFlight || adminState.userPasswordSetInFlight) && nextPage !== adminState.activePage) {
    setMsg("userDetailMsg", "密码正在保存，请等待操作完成后再切换页面。", false);
    if (!updateHash) {
      history.replaceState(null, "", `#admin-${adminState.activePage}`);
    }
    return false;
  }
  if (nextPage !== adminState.activePage) {
    clearRevealedUserPassword();
    clearUserPasswordReset();
    clearServiceCredential();
    clearAdminCreateStepUp();
  }
  adminState.activePage = nextPage;
  const pageLabel = nextPage === "users" && adminState.userListRole === "admin"
    ? "管理员账号"
    : (ADMIN_PAGE_LABELS[nextPage] || "运营概览");
  document.querySelectorAll("[data-page]").forEach((node) => {
    const active = String(node.dataset.page || "") === nextPage;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelectorAll("[data-page-view]").forEach((node) => {
    const active = String(node.dataset.pageView || "") === nextPage;
    node.classList.toggle("is-active", active);
    node.style.display = active ? "" : "none";
    node.setAttribute("aria-hidden", active ? "false" : "true");
  });
  setText("adminCurrentPageLabel", pageLabel);
  setText("adminMobileCurrentLabel", pageLabel);
  setText("adminMobileDrawerCurrentLabel", pageLabel);
  setAdminDocumentTitle(`${pageLabel} - 运营后台 - Web 素材生成平台`);
  const targetHash = `admin-${nextPage}`;
  if (updateHash && String(location.hash || "").replace(/^#/, "") !== targetHash) {
    location.hash = targetHash;
  }
  if (nextPage === "sentimentCookies") {
    void refreshSentimentCookieProfilesIfActive();
  }
  if (nextPage === "pricing") {
    void ensureBillingLoaded();
  }
  if (nextPage === "overview") void loadGovernanceDashboard();
  if (nextPage === "taxonomy") void loadTaxonomyWorkspace();
  if (nextPage === "audit") void loadAuditEvents();
  if (nextPage === "security") void loadSecurityAlerts();
  if (nextPage === "serviceAccounts") void loadServiceAccounts();
  if (nextPage === "proxyMarket") void loadProxyMarketWorkspace();
  return true;
}

function clearStoredAdminWorkspaceContext() {
  try { window.sessionStorage.removeItem("vecto-admin-workspace-user-id"); } catch (_) {}
  try { window.sessionStorage.removeItem("vecto-admin-console-context"); } catch (_) {}
}

function markAdminConsoleContext() {
  try { window.sessionStorage.setItem("vecto-admin-console-context", "1"); } catch (_) {}
}

async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set("X-Admin-Console", "1");
  const res = await fetch(path, { credentials: "include", cache: "no-store", ...opts, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { detail: text || `HTTP ${res.status}` };
  }
  if (res.status === 401) {
    clearStoredAdminWorkspaceContext();
    window.location.replace("/admin");
    throw data || { detail: "管理员登录已过期" };
  }
  if (!res.ok) throw data || { detail: `HTTP ${res.status}` };
  return data;
}

function setMsg(id, message, ok = true) {
  const node = el(id);
  if (!node) return;
  node.textContent = message || "";
  node.className = `msg ${ok ? "ok" : "err"}`;
}

function clearAccountMsgs() {
  setMsg("accountUsernameMsg", "");
  setMsg("accountPasswordMsg", "");
}

function getErrorMessage(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  if (typeof err.detail?.message === "string" && err.detail.message.trim()) return err.detail.message.trim();
  if (typeof err.detail === "string" && err.detail.trim()) return err.detail.trim();
  if (typeof err.message === "string" && err.message.trim()) return err.message.trim();
  return String(err);
}

function formatRuntimeConfigError(action, err) {
  const detail = getErrorMessage(err);
  if (detail.includes("运行配置文件")) return `${action}失败：${detail}`;
  return `${action}运行配置失败：${detail}`;
}

function runtimeConfigResponseToConfig(resp) {
  if (resp && typeof resp.runtime_config === "object" && resp.runtime_config) {
    return resp.runtime_config;
  }
  if (resp && typeof resp === "object") return resp;
  return null;
}

function parseModelList(value) {
  return String(value || "")
    .split(/\s*[,，\n]+\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stringifyModelList(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(", ");
}

const RUNTIME_MODEL_DRAFT_KEY = "runtime_model_candidates_draft_v1";
const NEW_PERSONA_RUNNINGHUB_API_PRESETS = {
  "2046514150500524033": {
    kind: "text-to-image",
    endpoint: "/rhart-image-g-2/text-to-image",
    label: "全能图片G-2.0-文生图-低价渠道版",
    detailUrl: "https://www.runninghub.cn/call-api/api-detail/2046514150500524033",
  },
  "2027192837726294017": {
    kind: "text-to-image",
    endpoint: "/rhart-image-n-g31-flash/text-to-image",
    label: "全能图片V2-文生图-低价渠道版",
    detailUrl: "https://www.runninghub.cn/call-api/api-detail/2027192837726294017",
  },
  "2046503667076751361": {
    kind: "image-to-image",
    endpoint: "/rhart-image-g-2/image-to-image",
    label: "全能图片G-2.0-图生图-低价渠道版",
    detailUrl: "https://www.runninghub.cn/call-api/api-detail/2046503667076751361",
  },
  "2027196343409463297": {
    kind: "image-to-image",
    endpoint: "/rhart-image-n-g31-flash/image-to-image",
    label: "全能图片V2-图生图-低价渠道版",
    detailUrl: "https://www.runninghub.cn/call-api/api-detail/2027196343409463297",
  },
};

const RUNNINGHUB_SLOT_FIELDS = {
  persona: {
    kind: "text-to-image",
    selectId: "rtNewPersonaPersonaT2iPreset",
    detailInputId: "rtNewPersonaPersonaT2iDetailUrl",
    endpointInputId: "rtNewPersonaPersonaT2iEndpoint",
    statusId: "rtNewPersonaPersonaT2iStatus",
    successText: "人设图文生图链路已切换并保存。",
  },
  tweet: {
    kind: "image-to-image",
    selectId: "rtNewPersonaTweetI2iPreset",
    detailInputId: "rtNewPersonaTweetI2iDetailUrl",
    endpointInputId: "rtNewPersonaTweetI2iEndpoint",
    statusId: "rtNewPersonaTweetI2iStatus",
    successText: "推文配图图生图链路已切换并保存。",
  },
};

function runningHubPresetOptions(kind) {
  return Object.entries(NEW_PERSONA_RUNNINGHUB_API_PRESETS)
    .filter(([, preset]) => preset.kind === kind);
}

function runningHubPresetIdFromValues(kind, detailUrl, endpoint) {
  const normalizedEndpoint = String(endpoint || "").trim();
  const match = runningHubPresetOptions(kind).find(([, preset]) => preset.endpoint && preset.endpoint === normalizedEndpoint);
  if (match) return match[0];
  const detailId = runningHubDetailId(detailUrl);
  if (detailId && NEW_PERSONA_RUNNINGHUB_API_PRESETS[detailId]?.kind === kind) return detailId;
  return "";
}

function renderRunningHubPresetSelect(slotName) {
  const slot = RUNNINGHUB_SLOT_FIELDS[slotName];
  if (!slot) return;
  const select = el(slot.selectId);
  if (!select) return;
  const detailInput = el(slot.detailInputId);
  const endpointInput = el(slot.endpointInputId);
  const currentId = runningHubPresetIdFromValues(slot.kind, detailInput?.value, endpointInput?.value);
  const options = runningHubPresetOptions(slot.kind);
  const savedDetail = String(detailInput?.value || "").trim();
  const savedEndpoint = String(endpointInput?.value || "").trim();
  const savedCustomOption = !currentId && (savedDetail || savedEndpoint)
    ? `<option value="__custom_saved" selected>当前已保存 API（自定义/未收录）</option>`
    : "";
  select.innerHTML = savedCustomOption + options.map(([id, preset]) => {
    const selected = id === currentId ? " selected" : "";
    return `<option value="${escapeHtml(id)}"${selected}>${escapeHtml(preset.label)}</option>`;
  }).join("");
  if (!currentId && !savedCustomOption && options[0]) {
    select.value = options[0][0];
    applyRunningHubPresetToHidden(slotName, false);
  }
  select.dataset.appliedValue = select.value || "";
  updateRunningHubPresetStatus(slotName);
}

function applyRunningHubPresetToHidden(slotName, updateStatus = true) {
  const slot = RUNNINGHUB_SLOT_FIELDS[slotName];
  if (!slot) return false;
  const select = el(slot.selectId);
  const preset = select ? NEW_PERSONA_RUNNINGHUB_API_PRESETS[select.value] : null;
  if (!preset || preset.kind !== slot.kind || !preset.endpoint) {
    updateRunningHubPresetStatus(slotName, "该 API 暂不可用，未应用。");
    return false;
  }
  const detailInput = el(slot.detailInputId);
  const endpointInput = el(slot.endpointInputId);
  if (detailInput) detailInput.value = preset.detailUrl;
  if (endpointInput) endpointInput.value = preset.endpoint;
  if (updateStatus) updateRunningHubPresetStatus(slotName);
  return true;
}

function updateRunningHubPresetStatus(slotName, overrideText = "") {
  const slot = RUNNINGHUB_SLOT_FIELDS[slotName];
  if (!slot) return;
  const status = el(slot.statusId);
  const select = el(slot.selectId);
  const preset = select ? NEW_PERSONA_RUNNINGHUB_API_PRESETS[select.value] : null;
  if (!status) return;
  if (overrideText) {
    status.textContent = overrideText;
    return;
  }
  if (select?.value === "__custom_saved") {
    const endpoint = String(el(slot.endpointInputId)?.value || "").trim();
    status.textContent = endpoint ? `当前使用：已保存自定义 API（${endpoint}）` : "当前使用：已保存自定义 API";
    return;
  }
  if (!preset) {
    status.textContent = "尚未选择 RunningHub API。";
    return;
  }
  status.textContent = preset.endpoint
    ? `当前使用：${preset.label}`
    : `${preset.label} 缺少 Endpoint，无法调用。`;
}

async function switchRunningHubPreset(slotName) {
  const slot = RUNNINGHUB_SLOT_FIELDS[slotName];
  if (!slot || !applyRunningHubPresetToHidden(slotName)) return;
  const select = el(slot.selectId);
  if (select) select.dataset.appliedValue = select.value || "";
  try {
    await saveRuntime();
    setMsg("runtimeMsg", slot.successText, true);
  } catch (err) {
    setMsg("runtimeMsg", getErrorMessage(err), false);
  }
}

async function checkRunningHubKey() {
  const button = el("btnCheckRunningHubKey");
  if (!button) return;
  const apiKey = runtimeSecretInputValue("rtNewPersonaRunningHubApiKey");
  if (!apiKey && !hasSavedRuntimeSecret("rtNewPersonaRunningHubApiKey")) {
    setMsg("rtRunningHubKeyStatus", "请先填写 RunningHub API Key。", false);
    return;
  }
  button.disabled = true;
  button.textContent = "检测中...";
  setMsg("rtRunningHubKeyStatus", "正在检测当前 Key...", true);
  try {
    const result = await api("/api/admin/runninghub/key_status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "runninghub", api_key: apiKey }),
    });
    setMsg("rtRunningHubKeyStatus", result.message || "检测完成。", result.valid === true && result.usable !== false);
  } catch (error) {
    setMsg("rtRunningHubKeyStatus", error.detail || error.message || "RunningHub 检测失败。", false);
  } finally {
    button.disabled = false;
    button.textContent = "检测 Key";
  }
}

const MODEL_PROVIDER_KEY_CHECKS = {
  text: { buttonId: "btnCheckLlmKey", inputId: "rtLlmApiKeyGpt", baseUrlId: "rtLlmBaseUrl", statusId: "rtLlmKeyStatus", label: "文字模型" },
  image: { buttonId: "btnCheckImageKey", inputId: "rtImageGeminiApiKey", baseUrlId: "rtImageBaseUrl", statusId: "rtImageKeyStatus", label: "图片模型" },
};

async function checkModelProviderKey(type) {
  const config = MODEL_PROVIDER_KEY_CHECKS[type];
  const button = config ? el(config.buttonId) : null;
  if (!config || !button) return;
  const baseUrl = el(config.baseUrlId)?.value.trim() || "";
  const apiKey = runtimeSecretInputValue(config.inputId);
  if (!baseUrl || (!apiKey && !hasSavedRuntimeSecret(config.inputId))) {
    setMsg(config.statusId, "请先填写 API Base URL 和 API Key。", false);
    return;
  }
  setButtonLoading(config.buttonId, true, "检测中...");
  setMsg(config.statusId, `正在检测${config.label} Key...`, true);
  try {
    const result = await api("/api/admin/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, provider: "openai-compatible", base_url: baseUrl, api_key: apiKey }),
    });
    const count = Array.isArray(result.models) ? result.models.length : 0;
    setMsg(config.statusId, count ? `Key 有效，已识别 ${count} 个可用模型。` : "Key 有效，接口连接成功。", true);
  } catch (error) {
    setMsg(config.statusId, error.detail || error.message || `${config.label} Key 检测失败。`, false);
  } finally {
    setButtonLoading(config.buttonId, false);
  }
}

function bindRunningHubPresetSelect(slotName) {
  const slot = RUNNINGHUB_SLOT_FIELDS[slotName];
  const select = slot ? el(slot.selectId) : null;
  if (!select) return;
  const handle = () => switchRunningHubPreset(slotName);
  select.addEventListener("change", handle);
  select.addEventListener("input", handle);
  select.addEventListener("click", () => {
    setTimeout(() => {
      if ((select.value || "") !== (select.dataset.appliedValue || "")) handle();
    }, 0);
  });
}

function runningHubDetailId(value) {
  const text = String(value || "").trim();
  const match = text.match(/api-detail\/(\d{10,})/) || text.match(/\b(\d{10,})\b/);
  return match ? match[1] : "";
}

function uniqueItems(items) {
  return Array.from(new Set((Array.isArray(items) ? items : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)));
}

function isGrokModel(model) {
  return /grok/i.test(String(model || "").trim());
}

function isGeminiImageModel(model) {
  return /(?:gemini|imagen|image)/i.test(String(model || "").trim());
}

function grokModelItems(items) {
  return uniqueItems(items);
}

function imageModelItems(items) {
  return uniqueItems(items).filter(Boolean);
}

function readModelDraft() {
  try {
    const raw = localStorage.getItem(RUNTIME_MODEL_DRAFT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeModelDraft() {
  try {
    localStorage.setItem(RUNTIME_MODEL_DRAFT_KEY, JSON.stringify({
      llmGeminiModels: [],
      llmGptModels: grokModelItems(adminState.llmGptModels),
      imageGeminiModels: imageModelItems(adminState.imageGeminiModels),
    }));
  } catch {
    // localStorage can be unavailable in private browsing; config save still works.
  }
}

function clearModelDraft() {
  try {
    localStorage.removeItem(RUNTIME_MODEL_DRAFT_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function mergeModelDraft() {
  const draft = readModelDraft();
  if (!draft) return false;
  let changed = false;
  ["llmGptModels", "imageGeminiModels"].forEach((key) => {
    const before = uniqueItems(adminState[key]);
    const after = key.startsWith("llm")
      ? grokModelItems([...before, ...(Array.isArray(draft[key]) ? draft[key] : [])])
      : imageModelItems([...before, ...(Array.isArray(draft[key]) ? draft[key] : [])]);
    adminState[key] = after;
    if (after.length !== before.length) changed = true;
  });
  return changed;
}

function normalizeWorkflowChain(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : String(value || "")
      .replace(/->/g, ",")
      .replace(/>/g, ",")
      .split(",");
  const items = source
    .map((item) => {
      if (item && typeof item === "object") {
        const stage = parseWorkflowStage(item);
        return buildWorkflowStageValue(stage.type, stage.value);
      }
      return String(item || "").trim();
    })
    .filter(Boolean);
  if (items.length) return items;
  return (Array.isArray(fallback) ? fallback : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

const CLOSED_LLM_STAGE_PREFIX = "closed_llm_model:";

function parseWorkflowStage(item) {
  if (item && typeof item === "object") {
    const type = String(item.type || item.provider || "").trim();
    const value = String(item.value || item.model || item.workflow_id || item.id || "").trim();
    if (["closed_llm_model", "closed_text_model", "llm_model", "text_model"].includes(type)) {
      return { type: "closed_llm_model", value };
    }
    return { type: "runninghub_workflow", value };
  }
  const text = String(item || "").trim();
  if (text.startsWith(CLOSED_LLM_STAGE_PREFIX)) {
    return { type: "closed_llm_model", value: text.slice(CLOSED_LLM_STAGE_PREFIX.length).trim() };
  }
  return { type: "runninghub_workflow", value: text };
}

function buildWorkflowStageValue(type, value) {
  const stageValue = String(value || "").trim();
  if (!stageValue) return "";
  if (type === "closed_llm_model") return `${CLOSED_LLM_STAGE_PREFIX}${stageValue}`;
  return stageValue;
}

function looksLikeLegacyWorkflowId(value) {
  return /^\d{10,}$/.test(String(value || "").trim());
}

function llmModelOptions() {
  return grokModelItems(adminState.llmGptModels);
}

function imageModelOptions() {
  return imageModelItems(adminState.imageGeminiModels);
}

function modelCatalogForPriority(type) {
  if (type === "image") return imageModelOptions();
  return llmModelOptions();
}

function normalizePriorityList(priorityItems, catalogItems, fallbackItems) {
  const normalized = [];
  const seen = new Set();
  const addItem = (value) => {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    normalized.push(text);
  };
  (Array.isArray(priorityItems) ? priorityItems : []).forEach(addItem);
  (Array.isArray(catalogItems) ? catalogItems : []).forEach(addItem);
  if (normalized.length === 0) {
    (Array.isArray(fallbackItems) ? fallbackItems : []).forEach(addItem);
  }
  return normalized;
}

function syncPriorityModelsFromCatalog(type) {
  if (type === "image") {
    const explicitPriority = imageModelItems(adminState.imagePriorityModels);
    adminState.imagePriorityModels = normalizePriorityList(
      explicitPriority.length ? explicitPriority : imageModelOptions(),
      [],
      ["gemini-3-pro-image-preview"],
    );
    return;
  }
  const normalizeLlmPriorityKey = (key) => {
    const explicitPriority = grokModelItems(adminState[key]);
    adminState[key] = normalizePriorityList(
      explicitPriority,
      [],
      [],
    );
  };
  normalizeLlmPriorityKey("llmPriorityModels");
}

function defaultClosedLlmModel(priorityKey = "llmPriorityModels") {
  const priority = grokModelItems(adminState[priorityKey]);
  return priority[0] || llmModelOptions()[0] || "";
}

function normalizeWorkflowStageForType(type, value) {
  const stageType = String(type || "runninghub_workflow").trim();
  const text = String(value || "").trim();
  if (stageType === "closed_llm_model") {
    return looksLikeLegacyWorkflowId(text) || !text ? defaultClosedLlmModel() : text;
  }
  return (
    text.startsWith(CLOSED_LLM_STAGE_PREFIX)
  ) ? "" : text;
}

function lastWorkflowStep(items) {
  const normalized = normalizeWorkflowChain(items);
  return normalized.length ? normalized[normalized.length - 1] : "";
}

function renderModelList(listKey, wrapId) {
  const wrap = el(wrapId);
  if (!wrap) return;
  wrap.innerHTML = "";
  (Array.isArray(adminState[listKey]) ? adminState[listKey] : []).forEach((model, index) => {
    const chip = document.createElement("div");
    chip.className = "admin-model-chip";
    chip.innerHTML = `<span>${escapeHtml(model)}</span><button type="button" class="ghost admin-model-chip-remove" data-list="${escapeHtml(listKey)}" data-idx="${index}" aria-label="删除模型">×</button>`;
    wrap.appendChild(chip);
  });
}

function renderPriorityModelList(listKey, wrapId) {
  const wrap = el(wrapId);
  if (!wrap) return;
  wrap.innerHTML = "";
  (Array.isArray(adminState[listKey]) ? adminState[listKey] : []).forEach((model, index) => {
    const chip = document.createElement("div");
    chip.className = "admin-model-chip";
    chip.innerHTML = `
      <span>${escapeHtml(model)}</span>
      <div class="admin-model-chip-actions">
        <button type="button" class="ghost admin-model-chip-order" data-priority-list="${escapeHtml(listKey)}" data-priority-idx="${index}" data-priority-action="up" aria-label="上移">↑</button>
        <button type="button" class="ghost admin-model-chip-order" data-priority-list="${escapeHtml(listKey)}" data-priority-idx="${index}" data-priority-action="down" aria-label="下移">↓</button>
        <button type="button" class="ghost admin-model-chip-remove" data-list="${escapeHtml(listKey)}" data-idx="${index}" aria-label="删除模型">×</button>
      </div>`;
    wrap.appendChild(chip);
  });
}

function renderPriorityModelListSafe(listKey, wrapId) {
  const wrap = el(wrapId);
  if (!wrap) return;
  wrap.innerHTML = "";
  (Array.isArray(adminState[listKey]) ? adminState[listKey] : []).forEach((model, index) => {
    const chip = document.createElement("div");
    chip.className = "admin-model-chip";
    const escapedListKey = escapeHtml(listKey);
    chip.innerHTML = `
      <span>${escapeHtml(model)}</span>
      <div class="admin-model-chip-actions">
        <button type="button" class="ghost admin-model-chip-order" data-priority-list="${escapedListKey}" data-priority-idx="${index}" data-priority-action="up" aria-label="上移">↑</button>
        <button type="button" class="ghost admin-model-chip-order" data-priority-list="${escapedListKey}" data-priority-idx="${index}" data-priority-action="down" aria-label="下移">↓</button>
        <button type="button" class="ghost admin-model-chip-remove" data-list="${escapedListKey}" data-idx="${index}" aria-label="删除模型">×</button>
      </div>`;
    wrap.appendChild(chip);
  });
}

function renderAllModelLists() {
  syncPriorityModelsFromCatalog("llm");
  syncPriorityModelsFromCatalog("image");
  renderModelList("llmGptModels", "rtLlmGptModelList");
  renderPriorityModelListSafe("llmPriorityModels", "rtLlmPriorityModelList");
  renderModelList("imageGeminiModels", "rtImageGeminiModelList");
  renderPriorityModelListSafe("imagePriorityModels", "rtImagePriorityModelList");
  renderModelSummaries();
}

function firstModel(listKey) {
  const items = Array.isArray(adminState[listKey]) ? adminState[listKey] : [];
  const first = String(items[0] || "").trim();
  return first;
}

function buildModelSummary(geminiListKey, gptListKey, label) {
  const priorityKey = "llmPriorityModels";
  const priority = Array.isArray(adminState[priorityKey]) ? adminState[priorityKey] : [];
  if (priority.length > 0) return `当前默认执行：按优先级顺序依次尝试，当前首选 ${priority[0]}`;
  const geminiModel = firstModel(geminiListKey);
  const gptModel = firstModel(gptListKey);
  if (geminiModel) return `当前默认执行：${label}优先使用 ${geminiModel}`;
  if (gptModel) return `当前默认执行：${label}回退使用 ${gptModel}`;
  return `当前默认执行：未配置 ${label}候选模型`;
}





function addModelFromInput(listKey, inputId) {
  const input = el(inputId);
  if (!input) return;
  const value = String(input.value || "").trim();
  if (!value) return;
  if (!Array.isArray(adminState[listKey])) {
    adminState[listKey] = [];
  }
  if (!adminState[listKey].includes(value)) {
    adminState[listKey].push(value);
    if (listKey === "llmGptModels") {
      syncPriorityModelsFromCatalog("llm");
    } else if (listKey === "imageGeminiModels") {
      syncPriorityModelsFromCatalog("image");
    }
    writeModelDraft();
    renderAllModelLists();
  }
  input.value = "";
}

function setLlmModelPickerStatus(message, isError = false) {
  const picker = el("rtLlmGrokModelPicker");
  if (!picker) return;
  picker.hidden = false;
  picker.innerHTML = `<div class="admin-model-picker-status${isError ? " error" : ""}">${escapeHtml(message)}</div>`;
}

function hideLlmModelPicker() {
  const picker = el("rtLlmGrokModelPicker");
  if (picker) picker.hidden = true;
  adminState.llmModelPickerTargetListKey = "";
}

function placeLlmModelPickerNear(triggerId) {
  const picker = el("rtLlmGrokModelPicker");
  const trigger = el(triggerId);
  const editor = trigger?.closest(".admin-model-list-editor");
  if (picker && editor && picker.parentElement !== editor) {
    editor.appendChild(picker);
  }
}

function placeImageModelPickerNear(triggerId) {
  const picker = el("rtImageGeminiModelPicker");
  const trigger = el(triggerId);
  const editor = trigger?.closest(".admin-model-list-editor");
  if (picker && editor && picker.parentElement !== editor) {
    editor.appendChild(picker);
  }
}

function modelVendor(model) {
  const text = String(model || "").trim();
  const lower = text.toLowerCase();
  if (!text) return "其他";
  if (lower.includes("openai") || lower.startsWith("gpt") || /^o[1345](?:[-_.]|$)/i.test(text)) return "OpenAI";
  if (lower.includes("anthropic") || lower.includes("claude")) return "Anthropic";
  if (lower.includes("google") || lower.includes("gemini") || lower.includes("imagen")) return "Google";
  if (lower.includes("xai") || lower.includes("grok")) return "xAI";
  if (lower.includes("qwen")) return "Qwen";
  if (lower.includes("deepseek")) return "DeepSeek";
  if (lower.includes("doubao") || lower.includes("bytedance") || lower.includes("seedream") || lower.includes("seedance")) return "ByteDance";
  if (lower.includes("glm")) return "GLM";
  if (lower.includes("minimax")) return "MiniMax";
  if (lower.includes("mistral")) return "Mistral";
  if (lower.includes("flux")) return "Flux";
  if (lower.includes("dall-e")) return "DALL-E";
  if (lower.includes("wan")) return "Wan";
  if (lower.includes("kling")) return "Kling";
  if (lower.includes("hailuo")) return "Hailuo";
  if (lower.includes("veo")) return "Veo";
  const first = text.split(/[/:_.-]/).find(Boolean) || text;
  return first.slice(0, 24);
}

function renderSearchableModelPicker(picker, items, dataAttrName, emptyMessage, placeholder = "搜尋模型") {
  if (!picker) return;
  const options = uniqueItems(items).sort((a, b) => a.localeCompare(b));
  picker.hidden = false;
  if (!options.length) {
    picker.innerHTML = `<div class="admin-model-picker-status">${escapeHtml(emptyMessage)}</div>`;
    return;
  }
  const vendors = uniqueItems(options.map((model) => modelVendor(model))).sort((a, b) => a.localeCompare(b));
  picker.innerHTML = `
    <div class="admin-model-picker-toolbar">
      <div class="admin-model-picker-count" data-model-picker-count>共 ${options.length} 个可用模型</div>
      <select class="admin-model-picker-vendor" data-model-picker-vendor>
        <option value="">全部厂商</option>
        ${vendors.map((vendor) => `<option value="${escapeHtml(vendor)}">${escapeHtml(vendor)}</option>`).join("")}
      </select>
    </div>
    <input class="admin-model-picker-search" type="search" placeholder="${escapeHtml(placeholder)}" data-model-picker-search>
    <div class="admin-model-picker-options">
      ${options
        .map((model) => `<button type="button" class="ghost admin-model-picker-option" data-vendor="${escapeHtml(modelVendor(model))}" data-${dataAttrName}="${escapeHtml(model)}">${escapeHtml(model)}</button>`)
        .join("")}
    </div>
  `;
  filterModelPickerOptions(picker, "");
}

function filterModelPickerOptions(picker, query) {
  if (!picker) return;
  const normalized = String(query || "").trim().toLowerCase();
  const selectedVendor = String(picker.querySelector("[data-model-picker-vendor]")?.value || "");
  let visibleCount = 0;
  picker.querySelectorAll(".admin-model-picker-option").forEach((button) => {
    const text = String(button.textContent || "").toLowerCase();
    const vendor = String(button.dataset.vendor || "");
    const visible = !(normalized && !text.includes(normalized)) && !(selectedVendor && vendor !== selectedVendor);
    button.hidden = !visible;
    if (visible) visibleCount += 1;
  });
  const countNode = picker.querySelector("[data-model-picker-count]");
  if (countNode) countNode.textContent = `显示 ${visibleCount} / ${picker.querySelectorAll(".admin-model-picker-option").length} 个可用模型`;
}

function bindModelPickerFilters(pickerId) {
  const picker = el(pickerId);
  if (!picker) return;
  picker.addEventListener("input", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.dataset.modelPickerSearch !== undefined) {
      filterModelPickerOptions(picker, target.value);
    }
  });
  picker.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.dataset.modelPickerVendor !== undefined) {
      const query = picker.querySelector("[data-model-picker-search]")?.value || "";
      filterModelPickerOptions(picker, query);
    }
  });
}

function activeTextModelPriorityListKey() {
  return "llmPriorityModels";
}

function addModelToFront(listKey, model) {
  const value = String(model || "").trim();
  if (!value) return;
  if (!Array.isArray(adminState[listKey])) adminState[listKey] = [];
  adminState[listKey] = [value, ...adminState[listKey].filter((item) => item !== value)];
}

function addLlmModelFromPicker(model) {
  const value = String(model || "").trim();
  if (!value) return;
  if (adminState.llmModelPickerTargetListKey) {
    addLlmPriorityModelFromPicker(adminState.llmModelPickerTargetListKey, value);
    return;
  }
  if (!Array.isArray(adminState.llmGptModels)) adminState.llmGptModels = [];
  if (!adminState.llmGptModels.includes(value)) adminState.llmGptModels.push(value);
  addModelToFront("llmPriorityModels", value);
  syncPriorityModelsFromCatalog("llm");
  writeModelDraft();
  renderAllModelLists();
  hideLlmModelPicker();
  setMsg("runtimeMsg", `已加入文字模型：${value}`, true);
}

function addLlmPriorityModelFromPicker(listKey, model) {
  const value = String(model || "").trim();
  if (!value) return;
  if (listKey !== "llmPriorityModels") return;
  addModelToFront(listKey, value);
  if (!Array.isArray(adminState.llmGptModels)) adminState.llmGptModels = [];
  if (!adminState.llmGptModels.includes(value)) adminState.llmGptModels.push(value);
  addModelToFront("llmPriorityModels", value);
  adminState.llmModelPickerTargetListKey = "";
  syncPriorityModelsFromCatalog("llm");
  writeModelDraft();
  renderAllModelLists();
  hideLlmModelPicker();
  setMsg("runtimeMsg", `已加入调用顺序：${value}`, true);
}

function openLlmPriorityModelPicker(listKey) {
  const picker = el("rtLlmGrokModelPicker");
  if (!picker) return;
  const triggerId = "btnAddLlmPriorityModel";
  placeLlmModelPickerNear(triggerId);
  const candidates = uniqueItems(adminState.llmGptModels);
  if (!candidates.length) {
    adminState.llmModelPickerTargetListKey = "";
    setLlmModelPickerStatus("请先点击「识别模型」取得候选模型，或先在候选模型中添加一个模型。", true);
    return;
  }
  adminState.llmModelPickerTargetListKey = listKey;
  renderSearchableModelPicker(picker, candidates, "llm-model", "暂无候选文字模型", "搜索候选模型");
}

function renderAvailableLlmModels(models) {
  const picker = el("rtLlmGrokModelPicker");
  if (!picker) return;
  adminState.llmModelPickerTargetListKey = "";
  renderSearchableModelPicker(picker, uniqueItems(Array.isArray(models) ? models : []), "llm-model", "没有查询到可用文字模型", "搜索文字模型");
}

async function toggleAvailableLlmModels() {
  const picker = el("rtLlmGrokModelPicker");
  if (!picker) return;
  placeLlmModelPickerNear("btnBrowseLlmGrokModels");
  if (!picker.hidden && picker.children.length > 0) {
    hideLlmModelPicker();
    return;
  }
  const baseUrl = el("rtLlmBaseUrl").value.trim();
  const apiKey = runtimeSecretInputValue("rtLlmApiKeyGpt") || el("rtLlmApiKeyGemini").value.trim();
  if (!baseUrl || (!apiKey && !hasSavedRuntimeSecret("rtLlmApiKeyGpt"))) {
    setLlmModelPickerStatus("请先填写 API Base URL 和 API Key", true);
    return;
  }
  setLlmModelPickerStatus("正在识别当前 API 支持的文字模型...");
  try {
    const resp = await api("/api/admin/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "text", provider: "openai-compatible", base_url: baseUrl, api_key: apiKey }),
    });
    renderAvailableLlmModels(resp.models || []);
  } catch (err) {
    setLlmModelPickerStatus(err.detail || err.message || String(err), true);
  }
}

function addPriorityModelFromInput(listKey, inputId, type) {
  const input = el(inputId);
  if (!input) return;
  const value = String(input.value || "").trim();
  if (!value) return;
  if (!Array.isArray(adminState[listKey])) {
    adminState[listKey] = [];
  }
  if (!adminState[listKey].includes(value)) {
    adminState[listKey].push(value);
  }
  syncPriorityModelsFromCatalog(type);
  writeModelDraft();
  renderAllModelLists();
  input.value = "";
}

function setImageModelPickerStatus(message, isError = false) {
  const picker = el("rtImageGeminiModelPicker");
  if (!picker) return;
  picker.hidden = false;
  picker.innerHTML = `<div class="admin-model-picker-status${isError ? " error" : ""}">${escapeHtml(message)}</div>`;
}

function hideImageModelPicker() {
  const picker = el("rtImageGeminiModelPicker");
  if (picker) picker.hidden = true;
  adminState.imageModelPickerTargetListKey = "";
}

function addImageModelFromPicker(model) {
  const value = String(model || "").trim();
  if (!value) return;
  if (!Array.isArray(adminState.imageGeminiModels)) adminState.imageGeminiModels = [];
  if (!adminState.imageGeminiModels.includes(value)) adminState.imageGeminiModels.push(value);
  addModelToFront("imagePriorityModels", value);
  adminState.imageModelPickerTargetListKey = "";
  syncPriorityModelsFromCatalog("image");
  writeModelDraft();
  renderAllModelLists();
  hideImageModelPicker();
  setMsg("runtimeMsg", `已加入图片模型：${value}`, true);
}

function openImagePriorityModelPicker() {
  const picker = el("rtImageGeminiModelPicker");
  if (!picker) return;
  placeImageModelPickerNear("btnAddImagePriorityModel");
  const candidates = uniqueItems(adminState.imageGeminiModels);
  if (!candidates.length) {
    adminState.imageModelPickerTargetListKey = "";
    setImageModelPickerStatus("请先点击「识别模型」取得候选图片模型。", true);
    return;
  }
  adminState.imageModelPickerTargetListKey = "imagePriorityModels";
  renderSearchableModelPicker(picker, candidates, "image-model", "暂无候选图片模型", "搜索候选图片模型");
}





function renderAvailableImageModels(models) {
  const picker = el("rtImageGeminiModelPicker");
  if (!picker) return;
  adminState.imageModelPickerTargetListKey = "";
  renderSearchableModelPicker(
    picker,
    uniqueItems(Array.isArray(models) ? models : []),
    "image-model",
    "没有查询到可用图片模型",
    "搜索图片模型",
  );
}

async function toggleAvailableImageModels() {
  const picker = el("rtImageGeminiModelPicker");
  if (!picker) return;
  placeImageModelPickerNear("btnBrowseImageGeminiModels");
  if (!picker.hidden && picker.children.length > 0) {
    hideImageModelPicker();
    return;
  }
  const baseUrl = el("rtImageBaseUrl").value.trim();
  const apiKey = runtimeSecretInputValue("rtImageGeminiApiKey");
  if (!baseUrl || (!apiKey && !hasSavedRuntimeSecret("rtImageGeminiApiKey"))) {
    setImageModelPickerStatus("请先填写 API Base URL 和 API Key", true);
    return;
  }
  setImageModelPickerStatus("正在识别当前 API 支持的图片模型...");
  try {
    const resp = await api("/api/admin/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "image", provider: "openai-compatible", base_url: baseUrl, api_key: apiKey }),
    });
    renderAvailableImageModels(resp.models || []);
  } catch (err) {
    setImageModelPickerStatus(err.detail || err.message || String(err), true);
  }
}

function setVideoModelPickerStatus(message, isError = false) {
  const picker = el("rtVideoModelPicker");
  if (!picker) return;
  picker.hidden = false;
  picker.innerHTML = `<div class="admin-model-picker-status${isError ? " error" : ""}">${escapeHtml(message)}</div>`;
}

function hideVideoModelPicker() {
  const picker = el("rtVideoModelPicker");
  if (picker) picker.hidden = true;
}

function renderAvailableVideoModels(models) {
  const picker = el("rtVideoModelPicker");
  if (!picker) return;
  renderSearchableModelPicker(
    picker,
    uniqueItems(Array.isArray(models) ? models : []),
    "video-model",
    "没有查询到可用视频模型",
    "搜索视频模型",
  );
}

function applyVideoModel(model) {
  const value = String(model || "").trim();
  if (!value) return;
  const input = el("rtMuleRouterWanI2vModelName");
  if (input) input.value = value;
  const endpointInput = el("rtMuleRouterWanI2vEndpoint");
  if (endpointInput) {
    const current = String(endpointInput.value || "").trim();
    if (/\/vendors\/[^/]+\/v\d+\//i.test(current) && /\/generation(?:[/?#]|$)/i.test(current)) {
      endpointInput.value = current.replace(/(\/vendors\/[^/]+\/v\d+\/)([^/?#]+)(\/generation.*)$/i, `$1${value}$3`);
    }
  }
  hideVideoModelPicker();
  setMsg("runtimeMsg", `已选择视频模型：${value}`, true);
}

async function toggleAvailableVideoModels() {
  const picker = el("rtVideoModelPicker");
  if (!picker) return;
  if (!picker.hidden && picker.children.length > 0) {
    hideVideoModelPicker();
    return;
  }
  const baseUrl = el("rtMuleRouterBaseUrl").value.trim();
  const apiKey = el("rtMuleRouterApiKey").value.trim();
  const endpoint = el("rtMuleRouterWanI2vEndpoint").value.trim();
  setVideoModelPickerStatus("正在识别当前 API 支持的视频模型...");
  try {
    const resp = await api("/api/admin/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "video", provider: "openai-compatible", base_url: baseUrl, api_key: apiKey, endpoint }),
    });
    renderAvailableVideoModels(resp.models || []);
  } catch (err) {
    setVideoModelPickerStatus(err.detail || err.message || String(err), true);
  }
}

function bindModelTabs() {
  const tabs = Array.from(document.querySelectorAll("[data-model-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-model-panel]"));
  if (!tabs.length || !panels.length) return;
  const activate = (name) => {
    tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.modelTab === name));
    panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.modelPanel === name));
  };
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activate(tab.dataset.modelTab || "text"));
  });
  activate(tabs.find((tab) => tab.classList.contains("is-active"))?.dataset.modelTab || "text");
}



function bindRunningHubSlotTabs() {
  const tabs = Array.from(document.querySelectorAll("[data-runninghub-slot-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-runninghub-slot-panel]"));
  if (!tabs.length || !panels.length) return;
  const activate = (name) => {
    tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.runninghubSlotTab === name));
    panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.runninghubSlotPanel === name));
  };
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activate(tab.dataset.runninghubSlotTab || "persona"));
  });
  activate(tabs.find((tab) => tab.classList.contains("is-active"))?.dataset.runninghubSlotTab || "persona");
}

function closeModelPickersOnOutsideClick(target) {
  const pickerPairs = [
    ["rtLlmGrokModelPicker", "btnBrowseLlmGrokModels"],
    ["rtImageGeminiModelPicker", "btnBrowseImageGeminiModels"],
    ["rtVideoModelPicker", "btnBrowseVideoModels"],
  ];
  pickerPairs.forEach(([pickerId, triggerId]) => {
    const picker = el(pickerId);
    if (!picker || picker.hidden) return;
    if (target.closest(`#${pickerId}`) || target.closest(`#${triggerId}`)) return;
    picker.hidden = true;
  });
}

const TASK_POLL_INTERVAL_MS = 10000;
const SENTIMENT_COOKIE_POLL_INTERVAL_MS = 10000;
const GOVERNANCE_POLL_INTERVAL_MS = 30000;
const taskState = {
  rows: [],
  inspectText: "",
};
const adminState = {
  rechargeTarget: null,
  selectedUser: null,
  userDetailRequestId: 0,
  userListRequestId: 0,
  userListPage: 1,
  userListPageSize: 20,
  userListTotal: 0,
  userListRole: "customer",
  userListFilters: {},
  selectedUserIds: new Set(),
  userBatchPreview: null,
  userCustomerCount: 0,
  userAdminCount: 0,
  userPasswordResetRequestId: 0,
  userPasswordResetUserId: null,
  userPasswordResetInFlight: false,
  userPasswordResetTimer: null,
  userPasswordSetRequestId: 0,
  userPasswordSetUserId: null,
  userPasswordSetInFlight: false,
  userPasswordRevealRequestId: 0,
  userPasswordRevealUserId: null,
  userPasswordRevealInFlight: false,
  userPasswordRevealTimer: null,
  userReviewInFlight: false,
  userDetailReturnFocus: null,
  userDetailInertElements: [],
  activePage: "overview",
  llmGeminiModels: [],
  llmGptModels: [],
  llmPriorityModels: [],
  llmModelPickerTargetListKey: "",
  imageGeminiModels: [],
  imagePriorityModels: [],
  imageModelPickerTargetListKey: "",
  workflowChains: {},
  sentimentCookieProfiles: [],
  sentimentCookieRefreshPromise: null,
  billingCatalogVersions: [],
  billingActiveCatalog: null,
  billingCatalogDraftId: null,
  billingOrderRows: [],
  billingPendingCount: 0,
  billingOrderOffset: 0,
  billingOrderHasMore: false,
  billingOrderRequestSequence: 0,
  billingOrderLoading: false,
  billingSelectedUserId: null,
  billingWalletPoints: new Map(),
  billingUnlimitedUsers: new Map(),
  billingLoaded: false,
  billingLoadingPromise: null,
  governanceLoadingPromise: null,
  governanceRequestId: 0,
  governanceLastPayload: null,
  governanceCharts: new Map(),
  auditRows: [],
  securityRows: [],
  serviceAccountRows: [],
  proxyMarketItemRows: [],
  proxyMarketAllocationRows: [],
  proxyMarketSelectedItemId: null,
  proxyMarketSettings: null,
  proxyMarketLoadingPromise: null,
  customerGroupRows: [],
  customerTagRows: [],
  taxonomyLoadingPromise: null,
  serviceCredentialTimer: null,
  mfaStatus: null,
  mfaSetup: null,
};
const REMOTE_COMFY_TASKS = [
  ["text_to_image", "文字生成图片"],
  ["persona_post_image", "推文生成配图"],
];
const TASK_TYPE_LABELS = { text_to_image: "文字生成图片", persona_post_image: "推文生成配图" };
const ADMIN_PAGES = new Set(["overview", "users", "taxonomy", "tasks", "audit", "security", "serviceAccounts", "proxyMarket", "pricing", "runtime", "sentimentCookies", "account"]);
const ADMIN_PAGE_ALIASES = {
  secOverview: "overview",
  secUsers: "users",
  secTaxonomy: "taxonomy",
  secTasks: "tasks",
  secAudit: "audit",
  secSecurity: "security",
  secServiceAccounts: "serviceAccounts",
  secProxyMarket: "proxyMarket",
  secPricing: "pricing",
  secRuntime: "runtime",
  secSentimentCookies: "sentimentCookies",
  secAccount: "account",
};
const WORKFLOW_CHAIN_META = [];
const WORKFLOW_CHAIN_META_BY_KEY = Object.fromEntries(
  WORKFLOW_CHAIN_META.map((item) => [item.key, item]),
);
const WORKFLOW_CHAIN_CONTAINER_IDS = Object.fromEntries(
  WORKFLOW_CHAIN_META.map((item) => [item.key, item.containerId]),
);

function syncWorkflowChainFromDom(key) {
  const container = el(WORKFLOW_CHAIN_CONTAINER_IDS[key]);
  if (!container) return normalizeWorkflowChain(adminState.workflowChains[key]);
  const values = Array.from(container.querySelectorAll(".workflow-step-row"))
    .map((row) => {
      const input = row.querySelector(`[data-chain-input="${key}"]`);
      const typeNode = row.querySelector(`[data-chain-type="${key}"]`);
      const modelNode = row.querySelector(`[data-chain-model="${key}"]`);
      const value = input ? String(input.value || "").trim() : "";
      const modelValue = modelNode ? String(modelNode.value || "").trim() : "";
      const type = typeNode ? String(typeNode.value || "runninghub_workflow") : "runninghub_workflow";
      return buildWorkflowStageValue(type, normalizeWorkflowStageForType(type, modelNode ? modelValue : value));
    });
  adminState.workflowChains[key] = values.length ? values : [""];
  return adminState.workflowChains[key];
}

function renderWorkflowChain(key) {
  const container = el(WORKFLOW_CHAIN_CONTAINER_IDS[key]);
  if (!container) return;
  const meta = WORKFLOW_CHAIN_META_BY_KEY[key] || {};
  const rawItems = Array.isArray(adminState.workflowChains[key]) ? adminState.workflowChains[key] : [];
  const items = rawItems.length ? rawItems : [""];
  adminState.workflowChains[key] = items;
  container.innerHTML = items.map((value, index) => {
    const stage = parseWorkflowStage(value);
    const typeOptions = [];
    if (meta.supportsClosedLlmModel) {
      typeOptions.push(`<option value="closed_llm_model"${stage.type === "closed_llm_model" ? " selected" : ""}>闭源文字模型</option>`);
    }
    const stageTypeOptions = typeOptions.length > 1
      ? `
        <select class="workflow-step-type" data-chain-type="${key}" data-idx="${index}" aria-label="步骤类型">
          ${typeOptions.join("")}
        </select>
      `
      : "";
    const modelOptions = stage.type === "closed_llm_model" ? llmModelOptions() : [];
    let stageValue = stage.value;
    if (stage.type === "closed_llm_model") {
      stageValue = normalizeWorkflowStageForType(stage.type, stage.value);
      if (stageValue && !modelOptions.includes(stageValue)) modelOptions.push(stageValue);
    }
    let valueControl = "";
    if (stage.type === "closed_llm_model") {
      valueControl = `
        <select class="workflow-step-value" data-chain-model="${key}" data-idx="${index}" aria-label="选择文字模型">
          ${modelOptions.map((model) => `<option value="${escapeHtml(model)}"${model === stageValue ? " selected" : ""}>${escapeHtml(model)}</option>`).join("")}
        </select>
      `;
    } else {
      valueControl = `
        <input
          type="text"
          value="${escapeHtml(stageValue)}"
          data-chain-input="${key}"
          data-idx="${index}"
          placeholder="Workflow ID"
        >
      `;
    }
    return `
    <div class="workflow-step-item">
      <div class="workflow-step-row${stageTypeOptions ? " workflow-step-row-with-type" : ""}">
        <span class="workflow-step-index">步骤 ${index + 1}</span>
        ${stageTypeOptions}
        ${valueControl}
        <div class="workflow-step-actions">
          <button type="button" class="ghost workflow-step-btn" data-workflow-action="insert" data-chain="${key}" data-idx="${index}" aria-label="在后面新增一步">+</button>
          <button type="button" class="ghost workflow-step-btn" data-workflow-action="remove" data-chain="${key}" data-idx="${index}" aria-label="删除当前步骤">-</button>
        </div>
      </div>
      ${index < items.length - 1 ? '<div class="workflow-step-sep">&gt;</div>' : ""}
    </div>
  `;
  }).join("");
}

function renderAllWorkflowChains() {
  WORKFLOW_CHAIN_META.forEach((item) => renderWorkflowChain(item.key));
}

function insertWorkflowChainStep(key, index) {
  const items = syncWorkflowChainFromDom(key).slice();
  items.splice(index + 1, 0, "");
  adminState.workflowChains[key] = items;
  renderWorkflowChain(key);
}

function removeWorkflowChainStep(key, index) {
  const items = syncWorkflowChainFromDom(key).slice();
  if (items.length <= 1) {
    adminState.workflowChains[key] = [""];
  } else {
    items.splice(index, 1);
    adminState.workflowChains[key] = items.length ? items : [""];
  }
  renderWorkflowChain(key);
}

function collectWorkflowChains() {
  const result = {};
  WORKFLOW_CHAIN_META.forEach((item) => {
    result[item.key] = normalizeWorkflowChain(syncWorkflowChainFromDom(item.key));
  });
  return result;
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] || ch));
}

function safeJson(value) {
  try {
    return JSON.stringify(value == null ? {} : value, null, 2);
  } catch {
    return String(value == null ? "" : value);
  }
}

function formatTime(ts) {
  if (!ts) return "-";
  return new Date(Number(ts) * 1000).toLocaleString();
}

function statusPill(status) {
  const s = String(status || "").trim() || "unknown";
  const labels = { success: "已完成", failed: "失败", queued: "排队中", running: "生成中" };
  if (s === "success") return `<span class="pill success" data-admin-i18n-ui="true">${escapeHtml(labels[s])}</span>`;
  if (s === "failed") return `<span class="pill failed" data-admin-i18n-ui="true">${escapeHtml(labels[s])}</span>`;
  if (s === "queued") return `<span class="pill queued" data-admin-i18n-ui="true">${escapeHtml(labels[s])}</span>`;
  return `<span class="pill running" data-admin-i18n-ui="true">${escapeHtml(labels[s] || s)}</span>`;
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function taskStatusDetail(t) {
  const total = Number(t && t.total_count);
  const success = Number(t && t.success_count);
  const failed = Number(t && t.failed_count);
  const firstError = oneLine((t && t.first_error) || (t && t.error) || "");
  if (total > 0) {
    const parts = [`成功 ${success}/${total}`];
    if (failed > 0) parts.push(`失败 ${failed}`);
    if (firstError) parts.push(`首个失败：${firstError}`);
    return parts.join(" | ");
  }
  return firstError || "";
}

function taskStatusCell(t) {
  const detail = taskStatusDetail(t);
  return `${statusPill(t.status)}${detail ? `<div class="small">${detail}</div>` : ""}`;
}

function runninghubCell(t) {
  const ids = Array.isArray(t && t.runninghub_task_ids)
    ? t.runninghub_task_ids.map((x) => oneLine(x)).filter(Boolean)
    : [];
  if (!ids.length) {
    const single = oneLine(t && t.runninghub_task_id);
    return single || "-";
  }
  return ids.map((id) => `<div class="small">${id}</div>`).join("");
}

function runninghubList(t) {
  const ids = Array.isArray(t && t.runninghub_task_ids)
    ? t.runninghub_task_ids.map((x) => oneLine(x)).filter(Boolean)
    : [];
  if (ids.length) return ids;
  const single = oneLine(t && t.runninghub_task_id);
  return single ? [single] : [];
}

function buildExecutionTraceText(groups) {
  const items = Array.isArray(groups) ? groups : [];
  const lines = [];
  items.forEach((group) => {
    if (!group || typeof group !== "object") return;
    lines.push(`${group.title || "执行链路"}`);
    if (group.status) lines.push(`  状态：${group.status}`);
    if (group.message) lines.push(`  说明：${group.message}`);
    if (group.final_output_path) lines.push(`  最终产物：${group.final_output_path}`);
    const steps = Array.isArray(group.steps) ? group.steps : [];
    steps.forEach((step) => {
      if (!step || typeof step !== "object") return;
      const stepParts = [
        `步骤 ${step.step || "-"}`,
        step.workflow_id ? `流程=${step.workflow_id}` : "",
        step.runninghub_task_id ? `任务=${step.runninghub_task_id}` : "",
        step.status ? `状态=${step.status}` : "",
      ].filter(Boolean);
      lines.push(`  - ${stepParts.join(" | ")}`);
      if (step.input_ref) lines.push(`    输入：${step.input_ref}`);
      if (step.output_path) lines.push(`    输出：${step.output_path}`);
      if (step.uploaded_ref) lines.push(`    续链上传：${step.uploaded_ref}`);
      if (step.message) lines.push(`    说明：${step.message}`);
    });
    lines.push("");
  });
  return lines.filter((line, index, arr) => !(line === "" && arr[index - 1] === "")).join("\n").trim();
}

function buildExecutionTraceHtml(groups) {
  const items = Array.isArray(groups) ? groups : [];
  if (!items.length) {
    return `<div class="task-empty task-empty-inline">暂无执行链路详情</div>`;
  }
  return items.map((group) => {
    const steps = Array.isArray(group && group.steps) ? group.steps : [];
    const stepsHtml = steps.length
      ? steps.map((step) => {
        const meta = [
          step.workflow_id ? `流程：${oneLine(step.workflow_id)}` : "",
          step.runninghub_task_id ? `任务：${oneLine(step.runninghub_task_id)}` : "",
          step.status ? `状态：${oneLine(step.status)}` : "",
        ].filter(Boolean);
        const refs = [
          step.input_ref ? `输入：${oneLine(step.input_ref)}` : "",
          step.output_path ? `输出：${oneLine(step.output_path)}` : "",
          step.uploaded_ref ? `续链上传：${oneLine(step.uploaded_ref)}` : "",
          step.message ? `说明：${oneLine(step.message)}` : "",
        ].filter(Boolean);
        return `
          <article class="inspect-log-item">
            <div class="inspect-log-meta">
              <span>步骤 ${escapeHtml(String(step.step || "-"))}</span>
              ${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
            </div>
            ${refs.length ? `<div class="inspect-log-extra">${escapeHtml(refs.join(" | "))}</div>` : ""}
          </article>
        `;
      }).join("")
      : `<div class="task-empty task-empty-inline">暂无步骤明细</div>`;
    return `
        <div class="inspect-section-title">${escapeHtml(group.title || "执行链路")}</div>
        ${group.final_output_path ? `<div class="small" style="margin-bottom:8px">最终产物：${escapeHtml(oneLine(group.final_output_path))}</div>` : ""}
        ${group.message ? `<div class="small" style="margin-bottom:8px">说明：${escapeHtml(oneLine(group.message))}</div>` : ""}
        <div class="inspect-log-list">${stepsHtml}</div>
    `;
  }).join("");
}

function workflowCell(t) {
  const workflowName = oneLine(t.workflow_name || t.type || "-");
  const workflowId = oneLine(t.workflow_id || "-");
  const taskType = taskTypeLabel(t.type);
  return `
    <div><strong>${workflowName}</strong></div>
    <div class="small">生成类型：${taskType}</div>
    <div class="small">内部流程编号：${workflowId}</div>
  `;
}

function taskTypeLabel(taskType) {
  const key = String(taskType || "").trim();
  return TASK_TYPE_LABELS[key] || key || "-";
}

function taskActionOptions(task) {
  const status = String((task && task.status) || "");
  const options = [
    `<option value="">请选择</option>`,
    `<option value="detail">查看生成详情</option>`,
    `<option value="logs">查看处理记录</option>`,
    `<option value="export_logs">导出处理记录</option>`,
  ];
  if (task && task.has_download) {
    options.push(`<option value="download">下载结果</option>`);
  }
  if (String(status || "") === "failed") {
    options.push(`<option value="retry">重新生成</option>`);
  }
  options.push(`<option value="delete_task">删除生成记录</option>`);
  return options.join("");
}

function buildTaskDetailText(data) {
  const logs = Array.isArray(data.logs) ? data.logs : [];
  const executionTraceText = buildExecutionTraceText(data.execution_trace);
  const lines = [
    `生成编号：${data.id || "-"}`,
    `客户ID：${data.user_id || "-"}`,
    `生成类型：${taskTypeLabel(data.type)}`,
    `内部流程：${data.workflow_name || "-"}`,
    `内部流程编号：${data.workflow_id || "-"}`,
    `链路摘要：${data.workflow_chain_summary || "-"}`,
    `供应商记录编号：${data.runninghub_task_id || "-"}`,
    `供应商记录编号列表：${Array.isArray(data.runninghub_task_ids) && data.runninghub_task_ids.length ? data.runninghub_task_ids.join(", ") : "-"}`,
    `状态：${data.status || "-"}`,
    `批量结果：${data.total_count ? `成功 ${data.success_count || 0}/${data.total_count}，失败 ${data.failed_count || 0}` : "-"}`,
    `额度消耗(分)：${data.cost_cents || 0}`,
    `创建时间：${formatTime(data.created_at)}`,
    `更新时间：${formatTime(data.updated_at)}`,
    `错误：${data.error || "-"}`,
    `最近分析：${data.analysis_summary || "-"}`,
    "",
    "输入：",
    JSON.stringify(data.input || {}, null, 2),
    "",
    "输出：",
    JSON.stringify(data.output || {}, null, 2),
    "",
    "用量：",
    JSON.stringify(data.usage || {}, null, 2),
    "",
    "执行链路：",
    executionTraceText || "暂无执行链路详情",
    "",
    "详细处理记录：",
  ];
  logs.forEach((it) => {
    lines.push(`[${formatTime(it.created_at)}] [${it.kind}] ${oneLine(it.message || "-")}`);
    if (it && it.data && typeof it.data === "object") lines.push(JSON.stringify(it.data, null, 2));
  });
  if (!logs.length) lines.push("暂无详细处理记录");
  return lines.join("\n");
}

function buildTaskLogsText(payload) {
  const task = payload.task || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const analysisSummary = oneLine(task.analysis_summary || "");
  const lines = [
    `生成编号：${task.id || "-"}`,
    `生成类型：${taskTypeLabel(task.type)}`,
    `内部流程：${task.workflow_name || "-"}`,
    `内部流程编号：${task.workflow_id || "-"}`,
    `供应商记录编号：${task.runninghub_task_id || "-"}`,
    `供应商记录编号列表：${Array.isArray(task.runninghub_task_ids) && task.runninghub_task_ids.length ? task.runninghub_task_ids.join(", ") : "-"}`,
    `状态：${task.status || "-"}`,
    `批量结果：${task.total_count ? `成功 ${task.success_count || 0}/${task.total_count}，失败 ${task.failed_count || 0}` : "-"}`,
    `错误：${task.error || "-"}`,
    `最近分析：${analysisSummary || "-"}`,
    "",
    "处理记录：",
  ];
  items.forEach((it) => {
    const data = it.data || {};
    const suffix = [
      data.stage ? `阶段=${oneLine(data.stage)}` : "",
      data.status ? `状态=${oneLine(data.status)}` : "",
      data.source ? `来源=${oneLine(data.source)}` : "",
      data.item_index ? `子项=${data.item_index}` : "",
      data.item_id ? `子项ID=${oneLine(data.item_id)}` : "",
      data.runninghub_task_id ? `供应商记录编号=${oneLine(data.runninghub_task_id)}` : "",
      data.error ? `错误=${oneLine(data.error)}` : "",
    ].filter(Boolean);
    lines.push(`[${formatTime(it.created_at)}] [${it.kind}] ${oneLine(it.message)}${suffix.length ? ` | ${suffix.join(" | ")}` : ""}`);
    if (Object.keys(data).length) lines.push(`  data: ${safeJson(data)}`);
  });
  if (!items.length) lines.push("暂无处理记录");
  return lines.join("\n");
}

function inspectItem(label, value) {
  return `
    <div class="inspect-item">
      <div class="inspect-label">${escapeHtml(label)}</div>
      <div class="inspect-value">${escapeHtml(value || "-")}</div>
    </div>
  `;
}

function inspectItemHtml(label, html) {
  return `
    <div class="inspect-item">
      <div class="inspect-label">${escapeHtml(label)}</div>
      <div class="inspect-value">${html || "-"}</div>
    </div>
  `;
}

function buildTaskDetailHtml(data) {
  const batchText = Number(data && data.total_count) > 0
    ? `成功 ${data.success_count || 0}/${data.total_count || 0}，失败 ${data.failed_count || 0}`
    : "-";
  const firstError = oneLine((data && data.error) || "");
  const logs = Array.isArray(data && data.logs) ? data.logs : [];
  const executionTraceHtml = buildExecutionTraceHtml(data && data.execution_trace);
  const logsHtml = logs.length
    ? logs.map((it) => {
      const detail = it && it.data && typeof it.data === "object" ? safeJson(it.data) : "";
      return `
        <article class="inspect-log-item">
          <div class="inspect-log-meta">
            <span>${escapeHtml(formatTime(it.created_at))}</span>
            <span>${escapeHtml(it.kind || "-")}</span>
          </div>
          <div class="inspect-log-text">${escapeHtml(oneLine(it.message || "-"))}</div>
          ${detail ? `<pre class="inspect-pre" style="margin-top:8px">${escapeHtml(detail)}</pre>` : ""}
        </article>
      `;
    }).join("")
    : `<div class="task-empty task-empty-inline">暂无详细处理记录</div>`;
  return `
    <div class="inspect-stack">
      <div class="inspect-grid">
        ${inspectItem("生成编号", data.id)}
        ${inspectItem("客户ID", data.user_id)}
        ${inspectItem("生成类型", taskTypeLabel(data.type))}
        ${inspectItem("内部流程", data.workflow_name)}
        ${inspectItem("内部流程编号", data.workflow_id)}
        ${inspectItem("链路摘要", data.workflow_chain_summary)}
        ${inspectItemHtml("状态", statusPill(data.status))}
        ${inspectItem("供应商记录编号", data.runninghub_task_id)}
        ${inspectItem("供应商记录编号列表", Array.isArray(data.runninghub_task_ids) && data.runninghub_task_ids.length ? data.runninghub_task_ids.join(", ") : "-")}
        ${inspectItem("批量结果", batchText)}
        ${inspectItem("额度消耗(分)", data.cost_cents || 0)}
        ${inspectItem("创建时间", formatTime(data.created_at))}
        ${inspectItem("更新时间", formatTime(data.updated_at))}
        ${inspectItem("结果下载", data.has_download ? "可下载" : "暂无结果文件")}
      </div>
      ${firstError ? `<div class="inspect-note inspect-note-bad">错误：${escapeHtml(firstError)}</div>` : ""}
      ${data.analysis_summary ? `<div class="inspect-note">最近分析：${escapeHtml(oneLine(data.analysis_summary))}</div>` : ""}
      ${String(data.status || "") === "failed" ? `<div class="row" style="margin-top:4px"><button class="primary" type="button" data-act="analyze_error" data-id="${escapeHtml(data.id)}">错误分析</button></div>` : ""}
      <div class="inspect-section">
        <div class="inspect-section-title">输入</div>
        <pre class="inspect-pre">${escapeHtml(safeJson(data.input || {}))}</pre>
      </div>
      <div class="inspect-section">
        <div class="inspect-section-title">输出</div>
        <pre class="inspect-pre">${escapeHtml(safeJson(data.output || {}))}</pre>
      </div>
      <div class="inspect-section">
        <div class="inspect-section-title">用量</div>
        <pre class="inspect-pre">${escapeHtml(safeJson(data.usage || {}))}</pre>
      </div>
      <div class="inspect-section">
        <div class="inspect-section-title">执行链路</div>
        ${executionTraceHtml}
      </div>
      <div class="inspect-section">
        <div class="inspect-section-title">详细处理记录</div>
        <div class="inspect-log-list">${logsHtml}</div>
      </div>
    </div>
  `;
}

function buildTaskLogsHtml(payload) {
  const task = payload && payload.task ? payload.task : {};
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const batchText = Number(task && task.total_count) > 0
    ? `成功 ${task.success_count || 0}/${task.total_count || 0}，失败 ${task.failed_count || 0}`
    : "-";
  const logsHtml = items.length
    ? items.map((it) => {
      const data = it && it.data && typeof it.data === "object" ? it.data : {};
      const extra = [];
      if (data.stage) extra.push(`阶段=${oneLine(data.stage)}`);
      if (data.status) extra.push(`状态=${oneLine(data.status)}`);
      if (data.source) extra.push(`来源=${oneLine(data.source)}`);
      if (data.workflow_name) extra.push(`内部流程=${data.workflow_name}`);
      if (data.workflow_id) extra.push(`内部流程编号=${data.workflow_id}`);
      if (data.runninghub_task_id) extra.push(`供应商记录编号=${data.runninghub_task_id}`);
      if (data.item_index) extra.push(`子项=${data.item_index}`);
      if (data.item_id) extra.push(`子项ID=${oneLine(data.item_id)}`);
      if (data.error) extra.push(`错误=${oneLine(data.error)}`);
      return `
        <article class="inspect-log-item">
          <div class="inspect-log-meta">
            <span>${escapeHtml(formatTime(it.created_at))}</span>
            <span>${escapeHtml(it.kind || "-")}</span>
          </div>
          <div class="inspect-log-text">${escapeHtml(oneLine(it.message || "-"))}</div>
          ${extra.length ? `<div class="inspect-log-extra">${escapeHtml(extra.join(" | "))}</div>` : ""}
          ${Object.keys(data).length ? `<pre class="inspect-pre" style="margin-top:8px">${escapeHtml(safeJson(data))}</pre>` : ""}
        </article>
      `;
    }).join("")
    : `<div class="task-empty task-empty-inline">暂无处理记录</div>`;
  return `
    <div class="inspect-stack">
      <div class="inspect-grid">
        ${inspectItem("生成编号", task.id)}
        ${inspectItem("生成类型", taskTypeLabel(task.type))}
        ${inspectItem("内部流程", task.workflow_name)}
        ${inspectItemHtml("状态", statusPill(task.status))}
        ${inspectItem("内部流程编号", task.workflow_id)}
        ${inspectItem("供应商记录编号", task.runninghub_task_id)}
        ${inspectItem("批量结果", batchText)}
        ${inspectItem("错误", task.error || "-")}
      </div>
      ${task.analysis_summary ? `<div class="inspect-note">最近分析：${escapeHtml(oneLine(task.analysis_summary))}</div>` : ""}
      ${String(task.status || "") === "failed" ? `<div class="row" style="margin-top:4px"><button class="primary" type="button" data-act="analyze_error" data-id="${escapeHtml(task.id)}">错误分析</button></div>` : ""}
      <div class="inspect-section">
        <div class="inspect-section-title">处理时间线</div>
        <div class="inspect-log-list">${logsHtml}</div>
      </div>
    </div>
  `;
}

function openTaskInspectModal({ title, subtitle, html, rawText }) {
  const modal = el("taskInspectModal");
  if (!modal) return;
  el("taskInspectTitle").textContent = title || "生成详情";
  el("taskInspectSub").textContent = subtitle || "-";
  el("taskInspectBody").innerHTML = html || "";
  taskState.inspectText = rawText || "";
  modal.style.display = "grid";
  modal.setAttribute("aria-hidden", "false");
}

function closeTaskInspectModal() {
  const modal = el("taskInspectModal");
  if (!modal) return;
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
  taskState.inspectText = "";
}

async function copyTaskInspectText() {
  if (!taskState.inspectText) {
    setMsg("taskMsg", "当前没有可复制内容", false);
    return;
  }
  await navigator.clipboard.writeText(taskState.inspectText);
  setMsg("taskMsg", "已复制当前生成内容", true);
}

function syncSelectOptions(id, values, defaultLabel) {
  const node = el(id);
  if (!node) return;
  const current = String(node.value || "");
  const options = [`<option value="">${escapeHtml(defaultLabel)}</option>`]
    .concat(values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`));
  node.innerHTML = options.join("");
  node.value = values.includes(current) ? current : "";
}

function getTaskFilterValues() {
  return {
    search: String((el("taskSearch") && el("taskSearch").value) || "").trim().toLowerCase(),
    status: String((el("taskStatusFilter") && el("taskStatusFilter").value) || "").trim(),
    workflow: String((el("taskWorkflowFilter") && el("taskWorkflowFilter").value) || "").trim(),
    user: String((el("taskUserFilter") && el("taskUserFilter").value) || "").trim(),
  };
}

function taskSearchText(task) {
  return [
    task && task.id,
    task && task.username,
    task && task.user_id,
    task && task.workflow_name,
    task && task.workflow_id,
    task && task.workflow_chain_summary,
    task && task.type,
    task && task.runninghub_task_id,
    ...(Array.isArray(task && task.runninghub_task_ids) ? task.runninghub_task_ids : []),
    task && task.error,
    task && task.first_error,
  ].map((value) => oneLine(value)).join(" ").toLowerCase();
}

function filterTasks(rows) {
  const filters = getTaskFilterValues();
  return rows.filter((task) => {
    if (filters.search && !taskSearchText(task).includes(filters.search)) return false;
    if (filters.status && String(task.status || "") !== filters.status) return false;
    if (filters.workflow && String(task.workflow_name || task.type || "") !== filters.workflow) return false;
    if (filters.user && String(task.username || task.user_id || "") !== filters.user) return false;
    return true;
  });
}

function renderTaskSummary(allRows, visibleRows) {
  const host = el("taskSummary");
  if (!host) return;
  const activeCount = visibleRows.filter((row) => ["queued", "running"].includes(String(row.status || ""))).length;
  const successCount = visibleRows.filter((row) => String(row.status || "") === "success").length;
  const failedCount = visibleRows.filter((row) => String(row.status || "") === "failed").length;
  const downloadCount = visibleRows.filter((row) => !!row.has_download).length;
  const cards = [
    { label: "当前显示", value: visibleRows.length, hint: `全部记录 ${allRows.length}` },
    { label: "运行中 / 排队", value: activeCount, hint: "running + queued" },
    { label: "已成功", value: successCount, hint: "已完成记录" },
    { label: "可下载结果", value: downloadCount, hint: `失败 ${failedCount}` },
  ];
  host.innerHTML = cards.map((card) => `
    <div class="kpi task-kpi">
      <div class="label">${escapeHtml(card.label)}</div>
      <div class="num">${escapeHtml(String(card.value))}</div>
      <div class="small">${escapeHtml(card.hint)}</div>
    </div>
  `).join("");
}

function taskActionButtons(task) {
  const taskType = String((task && task.type) || "");
  const buttons = [
    `<button class="ghost task-action-btn" type="button" data-admin-i18n-ui="true" data-act="detail" data-id="${escapeHtml(task.id)}">详情</button>`,
    `<button class="ghost task-action-btn" type="button" data-admin-i18n-ui="true" data-act="logs" data-id="${escapeHtml(task.id)}">处理记录</button>`,
    `<button class="ghost task-action-btn" type="button" data-admin-i18n-ui="true" data-act="export_logs" data-id="${escapeHtml(task.id)}">导出</button>`,
  ];
  if (task && task.has_download) {
    buttons.push(`<button class="blue task-action-btn" type="button" data-admin-i18n-ui="true" data-act="download" data-id="${escapeHtml(task.id)}">下载结果</button>`);
  }
  if (String((task && task.status) || "") === "failed") {
    buttons.push(`<button class="primary task-action-btn" type="button" data-admin-i18n-ui="true" data-act="retry" data-id="${escapeHtml(task.id)}">重试</button>`);
  }
  buttons.push(`<button class="ghost task-action-btn" type="button" data-admin-i18n-ui="true" data-act="delete_task" data-id="${escapeHtml(task.id)}">删除</button>`);
  return buttons.join("");
}

function renderTaskCard(task) {
  const status = String(task.status || "").trim() || "unknown";
  const workflowName = oneLine(task.workflow_name || task.type || "-");
  const taskType = taskTypeLabel(task.type);
  const workflowId = oneLine(task.workflow_id || "-");
  const workflowChainSummary = oneLine(task.workflow_chain_summary || "");
  const userName = oneLine(task.username || task.user_id || "-");
  const batchText = Number(task.total_count) > 0
    ? `成功 ${task.success_count || 0}/${task.total_count || 0}，失败 ${task.failed_count || 0}`
    : "单任务";
  const runninghubIds = runninghubList(task);
  const errorText = oneLine(task.first_error || task.error || "");
  return `
    <article class="task-card task-card-status-${escapeHtml(status)}">
      <div class="task-card-head">
        <div class="task-card-main">
          <div class="task-card-title-row">
            <div class="task-card-title">${escapeHtml(workflowName)}</div>
            ${statusPill(task.status)}
          </div>
          <div class="task-card-subtitle"><span data-admin-i18n-ui="true">生成类型：</span>${escapeHtml(taskType)} · <span data-admin-i18n-ui="true">客户：</span>${escapeHtml(userName)}</div>
          ${workflowChainSummary ? `<div class="small" style="margin-top:4px"><span data-admin-i18n-ui="true">链路摘要：</span>${escapeHtml(workflowChainSummary)}</div>` : ""}
        </div>
        <div class="task-card-actions">
          ${taskActionButtons(task)}
        </div>
      </div>
      <div class="task-chip-row">
        <span class="meta-chip"><span data-admin-i18n-ui="true">生成编号：</span>${escapeHtml(task.id)}</span>
        <span class="meta-chip"><span data-admin-i18n-ui="true">内部流程编号：</span>${escapeHtml(workflowId)}</span>
        <span class="meta-chip"><span data-admin-i18n-ui="true">创建时间：</span>${escapeHtml(formatTime(task.created_at))}</span>
        <span class="meta-chip"><span data-admin-i18n-ui="true">额度消耗：</span>${escapeHtml(String(task.cost_cents || 0))} <span data-admin-i18n-ui="true">分</span></span>
      </div>
      <div class="task-card-grid">
        <div class="task-card-item">
          <div class="task-card-label" data-admin-i18n-ui="true">批量进度</div>
          <div class="task-card-value" data-admin-i18n-ui="true">${escapeHtml(batchText)}</div>
        </div>
        <div class="task-card-item">
          <div class="task-card-label" data-admin-i18n-ui="true">更新时间</div>
          <div class="task-card-value">${escapeHtml(formatTime(task.updated_at || task.created_at))}</div>
        </div>
        <div class="task-card-item task-card-item-wide">
          <div class="task-card-label" data-admin-i18n-ui="true">供应商记录</div>
          <div class="task-card-value task-card-rh">
            ${runninghubIds.length
              ? runninghubIds.map((id) => `<span class="meta-chip meta-chip-code">${escapeHtml(id)}</span>`).join("")
              : `<span class="small" data-admin-i18n-ui="true">暂无供应商记录编号</span>`}
          </div>
        </div>
      </div>
      ${errorText ? `<div class="task-card-alert"><span data-admin-i18n-ui="true">错误：</span>${escapeHtml(errorText)}</div>` : ""}
    </article>
  `;
}

function renderTasks() {
  const allRows = Array.isArray(taskState.rows) ? taskState.rows : [];
  const visibleRows = filterTasks(allRows);
  const list = el("taskList");
  const empty = el("taskEmpty");
  const meta = el("taskMetaLine");
  if (!list || !empty || !meta) return;
  renderTaskSummary(allRows, visibleRows);
  meta.textContent = visibleRows.length === allRows.length
    ? `共 ${allRows.length} 条生成记录，按创建时间倒序展示`
    : `显示 ${visibleRows.length} / ${allRows.length} 条生成记录`;
  empty.style.display = visibleRows.length ? "none" : "block";
  list.innerHTML = visibleRows.map((task) => renderTaskCard(task)).join("");
}

function setButtonLoading(buttonId, loading, loadingText) {
  const button = el(buttonId);
  if (!button) return;
  if (loading) {
    if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
    button.disabled = true;
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");
    button.textContent = loadingText || button.dataset.idleText || "";
  } else {
    button.disabled = false;
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
    if (button.dataset.idleText) button.textContent = button.dataset.idleText;
  }
}

function initSensitiveInputToggles() {
  SENSITIVE_RUNTIME_INPUT_IDS.forEach((id) => {
    const input = el(id);
    if (!input || input.type === "hidden" || input.closest(".sensitive-input-wrap")) return;
    input.type = "password";
    input.autocomplete = "off";
    input.setAttribute("spellcheck", "false");
    const wrapper = document.createElement("div");
    wrapper.className = "sensitive-input-wrap";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    input.classList.add("sensitive-input");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost sensitive-toggle-btn";
    button.dataset.target = id;
    button.innerHTML = SENSITIVE_EYE_ICON_SVG;
    button.setAttribute("aria-label", "\u663e\u793a\u5bc6\u94a5\u5185\u5bb9");
    button.title = "\u663e\u793a";
    button.setAttribute("aria-pressed", "false");
    wrapper.appendChild(button);
  });
}

function initRuntimeSecretMaskInputs() {
  [...SENSITIVE_RUNTIME_INPUT_IDS, "rtNewPersonaRunningHubApiKey"].forEach((id) => {
    const input = el(id);
    if (!input || input.dataset.runtimeSecretMaskBound === "true") return;
    input.dataset.runtimeSecretMaskBound = "true";
    input.autocomplete = "off";
    input.setAttribute("spellcheck", "false");
    if (!input.dataset.emptyPlaceholder) input.dataset.emptyPlaceholder = input.placeholder || "";
    updateSensitiveToggleVisual(getSensitiveToggleButton(id), input.type === "text");
    input.addEventListener("focus", () => {
      if (hasSavedRuntimeSecret(id) && input.type === "password") input.select();
    });
    input.addEventListener("input", () => {
      if (input.value === input.dataset.runtimeSecretMask) return;
      input.dataset.runtimeSecretSaved = "false";
      input.classList.remove("is-saved-runtime-secret");
      const button = getSensitiveToggleButton(id);
      if (button) {
        updateSensitiveToggleVisual(button, input.type === "text");
      }
    });
  });
}

async function toggleSensitiveInput(button) {
  const input = el(button.dataset.target || button.dataset.secretTarget || "");
  if (!input) return;
  if (hasSavedRuntimeSecret(input.id)) {
    if (input.type === "text") {
      input.type = "password";
      input.value = input.dataset.runtimeSecretMask || "";
      updateSensitiveToggleVisual(button, false);
      return;
    }
    const secretName = RUNTIME_SECRET_API_NAMES[input.id];
    if (!secretName) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const response = await api(`/api/admin/runtime_config/secrets/${encodeURIComponent(secretName)}`, { method: "POST" });
      const value = String(response?.value || "");
      if (!value) throw new Error("API Key 尚未配置");
      input.value = value;
      input.type = "text";
      updateSensitiveToggleVisual(button, true);
      setMsg("runtimeMsg", "API Key 已显示，再次点击图标可隐藏。", true);
    } catch (error) {
      setMsg("runtimeMsg", error.detail || error.message || "读取 API Key 失败", false);
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
    return;
  }
  const willShow = input.type === "password";
  input.type = willShow ? "text" : "password";
  updateSensitiveToggleVisual(button, willShow);
  input.focus();
}

async function ensureAdmin() {
  const me = await api("/api/me");
  if (!me.is_admin) {
    location.href = "/admin-console.html";
    return null;
  }
  el("adminName").textContent = me.username;
  setText("adminSessionName", me.username || "管理员");
  setText("adminSessionId", me.id ? `#${me.id}` : "-");
  setText("adminSessionCreatedAt", formatTime(me.created_at));
  if (el("accCurrentUsername")) el("accCurrentUsername").value = me.username || "";
  return me;
}

async function logoutAdmin() {
  const button = el("btnAdminLogout");
  const message = el("adminLogoutMsg");
  if (!button || button.disabled) return;
  const idleText = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "正在退出...";
  if (message) message.textContent = "";
  try {
    await api("/api/auth/logout", { method: "POST" });
    clearStoredAdminWorkspaceContext();
    window.location.replace("/admin");
  } catch (err) {
    if (message) message.textContent = getErrorMessage(err);
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = idleText;
  }
}

function runtimeFormToPayload() {
  const workflowChains = collectWorkflowChains();
  adminState.llmGeminiModels = [];
  adminState.llmGptModels = grokModelItems(adminState.llmGptModels);
  adminState.llmPriorityModels = grokModelItems(adminState.llmPriorityModels);
  adminState.imageGeminiModels = imageModelItems(adminState.imageGeminiModels);
  adminState.imagePriorityModels = imageModelItems(adminState.imagePriorityModels);
  const llmGrokModels = stringifyModelList(adminState.llmGptModels);
  const llmPriorityModels = stringifyModelList(adminState.llmPriorityModels);
  const imageGeminiModels = stringifyModelList(adminState.imageGeminiModels);
  const imagePriorityModels = stringifyModelList(adminState.imagePriorityModels);
  return {
    image_generate_mode_default: "closed_model_api",
    image_generate_workflow_ids: [],
    llm_base_url: el("rtLlmBaseUrl").value.trim(),
    llm_api_key_gemini: "",
    llm_api_key_gpt: runtimeSecretInputValue("rtLlmApiKeyGpt"),
    llm_api_key: runtimeSecretInputValue("rtLlmApiKeyGpt"),
    llm_default_model_gemini: "",
    llm_default_model_gpt: llmGrokModels,
    llm_default_model: llmGrokModels,
    llm_model_priority_order: llmPriorityModels,
    image_model_provider_base_url: el("rtImageBaseUrl").value.trim(),
    image_model_provider_api_key_gemini: runtimeSecretInputValue("rtImageGeminiApiKey"),
    image_model_default_model_gemini: imageGeminiModels,
    image_model_default_model: imageGeminiModels,
    image_model_priority_order: imagePriorityModels || imageGeminiModels,
    new_persona_runninghub_base_url: el("rtNewPersonaRunningHubBaseUrl") ? el("rtNewPersonaRunningHubBaseUrl").value.trim() : "",
    new_persona_runninghub_api_key: runtimeSecretInputValue("rtNewPersonaRunningHubApiKey"),
    new_persona_runninghub_persona_t2i_detail_url: el("rtNewPersonaPersonaT2iDetailUrl") ? el("rtNewPersonaPersonaT2iDetailUrl").value.trim() : "",
    new_persona_runninghub_persona_t2i_endpoint: el("rtNewPersonaPersonaT2iEndpoint") ? el("rtNewPersonaPersonaT2iEndpoint").value.trim() : "",
    new_persona_runninghub_tweet_i2i_detail_url: el("rtNewPersonaTweetI2iDetailUrl") ? el("rtNewPersonaTweetI2iDetailUrl").value.trim() : "",
    new_persona_runninghub_tweet_i2i_endpoint: el("rtNewPersonaTweetI2iEndpoint") ? el("rtNewPersonaTweetI2iEndpoint").value.trim() : "",
    mulerouter_api_name: el("rtMuleRouterApiName") ? el("rtMuleRouterApiName").value.trim() : "",
    mulerouter_api_key: runtimeSecretInputValue("rtMuleRouterApiKey"),
    mulerouter_base_url: el("rtMuleRouterBaseUrl") ? el("rtMuleRouterBaseUrl").value.trim() : "",
    mulerouter_wan_i2v_model: el("rtMuleRouterWanI2vModelName") ? el("rtMuleRouterWanI2vModelName").value.trim() : "",
    mulerouter_wan_i2v_endpoint: el("rtMuleRouterWanI2vEndpoint") ? el("rtMuleRouterWanI2vEndpoint").value.trim() : "",
    mulerouter_wan_i2v_negative_prompt: el("rtMuleRouterWanI2vNegativePrompt") ? el("rtMuleRouterWanI2vNegativePrompt").value.trim() : "",
    video_app_id: "",
    cleanup_enabled: !!el("rtCleanupEnabled").checked,
    cleanup_time: el("rtCleanupTime").value || "03:30",
    cleanup_retention_days: Number(el("rtCleanupRetentionDays").value || 7),
    auth_remember_login_enabled: !!el("rtRememberLoginEnabled").checked,
    auth_remember_login_default: !!el("rtRememberLoginDefault").checked,
    auth_remember_login_days: Number(el("rtRememberLoginDays").value || 30),
    auth_session_hours: Number(el("rtSessionHours").value || 12),
  };
}

function fillRuntimeForm(data) {
  const v = data || {};
  const hasRuntimeField = (key) => Object.prototype.hasOwnProperty.call(v, key);
  el("rtLlmBaseUrl").value = v.llm_base_url || "http://202.90.21.53:3008";
  el("rtLlmApiKeyGemini").value = "";
  setRuntimeSecretInputState("rtLlmApiKeyGpt", v.llm_api_key_gpt_configured || v.llm_api_key_configured, v.llm_api_key_gpt_masked || v.llm_api_key_masked);
  adminState.llmGeminiModels = [];
  adminState.llmGptModels = grokModelItems([
    ...parseModelList(v.llm_default_model_gpt || ""),
    ...parseModelList(v.llm_model_priority_order || ""),
    ...parseModelList(v.llm_default_model || ""),
  ]);
  adminState.llmPriorityModels = grokModelItems(
    hasRuntimeField("llm_model_priority_order")
      ? parseModelList(v.llm_model_priority_order)
      : adminState.llmGptModels,
  );
  el("rtImageBaseUrl").value = v.image_model_provider_base_url || "http://202.90.21.53:3008";
  setRuntimeSecretInputState("rtImageGeminiApiKey", v.image_model_provider_api_key_gemini_configured, v.image_model_provider_api_key_gemini_masked);
  if (el("rtNewPersonaRunningHubBaseUrl")) el("rtNewPersonaRunningHubBaseUrl").value = v.new_persona_runninghub_base_url || "https://www.runninghub.ai";
  setRuntimeSecretInputState("rtNewPersonaRunningHubApiKey", v.new_persona_runninghub_api_key_configured, v.new_persona_runninghub_api_key_masked);
  if (el("rtNewPersonaPersonaT2iDetailUrl")) el("rtNewPersonaPersonaT2iDetailUrl").value = v.new_persona_runninghub_persona_t2i_detail_url || "https://www.runninghub.cn/call-api/api-detail/2046514150500524033";
  if (el("rtNewPersonaPersonaT2iEndpoint")) el("rtNewPersonaPersonaT2iEndpoint").value = v.new_persona_runninghub_persona_t2i_endpoint || "/rhart-image-g-2/text-to-image";
  if (el("rtNewPersonaTweetI2iDetailUrl")) el("rtNewPersonaTweetI2iDetailUrl").value = v.new_persona_runninghub_tweet_i2i_detail_url || "https://www.runninghub.cn/call-api/api-detail/2046503667076751361";
  if (el("rtNewPersonaTweetI2iEndpoint")) el("rtNewPersonaTweetI2iEndpoint").value = v.new_persona_runninghub_tweet_i2i_endpoint || "/rhart-image-g-2/image-to-image";
  renderRunningHubPresetSelect("persona");
  renderRunningHubPresetSelect("tweet");
  adminState.imageGeminiModels = imageModelItems([
    ...parseModelList(v.image_model_default_model_gemini || ""),
    ...parseModelList(v.image_model_default_model || ""),
  ]);
  adminState.imagePriorityModels = imageModelItems(v.image_model_priority_order ? parseModelList(v.image_model_priority_order) : adminState.imageGeminiModels);
  if (el("rtMuleRouterApiName")) el("rtMuleRouterApiName").value = v.mulerouter_api_name || "";
  setRuntimeSecretInputState("rtMuleRouterApiKey", v.mulerouter_api_key_configured, v.mulerouter_api_key_masked);
  if (el("rtMuleRouterBaseUrl")) el("rtMuleRouterBaseUrl").value = v.mulerouter_base_url || "";
  if (el("rtMuleRouterWanI2vModelName")) el("rtMuleRouterWanI2vModelName").value = v.mulerouter_wan_i2v_model || "";
  if (el("rtMuleRouterWanI2vEndpoint")) el("rtMuleRouterWanI2vEndpoint").value = v.mulerouter_wan_i2v_endpoint || "";
  if (el("rtMuleRouterWanI2vNegativePrompt")) el("rtMuleRouterWanI2vNegativePrompt").value = v.mulerouter_wan_i2v_negative_prompt || "";
  syncPriorityModelsFromCatalog("llm");
  const restoredModelDraft = mergeModelDraft();
  renderAllModelLists();
  if (restoredModelDraft) {
    setMsg("runtimeMsg", "已恢复浏览器中的未保存候选模型草稿，请确认后点击保存运行配置。", true);
  }
  adminState.workflowChains = {};
  renderAllWorkflowChains();
  el("rtCleanupEnabled").checked = v.cleanup_enabled !== false;
  el("rtCleanupTime").value = v.cleanup_time || "03:30";
  el("rtCleanupRetentionDays").value = String(v.cleanup_retention_days || 7);
  el("rtRememberLoginEnabled").checked = v.auth_remember_login_enabled !== false;
  el("rtRememberLoginDefault").checked = v.auth_remember_login_default === true;
  el("rtRememberLoginDays").value = String(v.auth_remember_login_days || 30);
  el("rtSessionHours").value = String(v.auth_session_hours || 12);
}

async function loadRuntime() {
  const cfg = runtimeConfigResponseToConfig(await api("/api/admin/runtime_config"));
  fillRuntimeForm(cfg);
  return cfg;
}

async function saveRuntime() {
  const payload = runtimeFormToPayload();
  const resp = await api("/api/admin/runtime_config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const cfg = runtimeConfigResponseToConfig(resp);
  clearModelDraft();
  if (cfg) fillRuntimeForm(cfg);
  return cfg;
}

function sentimentCookieHealthLabel(health) {
  const map = {
    healthy: "正常",
    watch: "需关注",
    degraded: "需处理",
    expired: "已过期",
    missing: "未授权",
    unknown: "未知",
  };
  return map[health] || health || "-";
}

function sentimentCookieActionLabel(action) {
  const map = {
    keep: "",
    "authorize-profile": "登录后同步",
    "reauthorize-profile": "重新登录并同步",
    "refresh-profile-cookies": "重新同步 Cookie",
    "refresh-before-expiry": "即将过期，请重新同步",
    "retry-later": "系统正在自动重试",
  };
  return map[action] || "";
}

function sentimentCookieStatusDetails(profile) {
  const savedCookieCount = Number(profile?.cookieCount || 0);
  const validCookieCount = Number(profile?.validCookieCount || 0);
  const key = String(profile?.key || profile?.platform || "").trim().toLowerCase();
  const requiresSessionid = key === "threads";
  const ordinaryCookieSaved = savedCookieCount > 0;
  const ordinaryCookieReady = validCookieCount > 0;
  const cookieNames = Array.isArray(profile?.cookieNames) ? profile.cookieNames : [];
  const sessionidSaved = requiresSessionid && (
    typeof profile?.sessionidSaved === "boolean"
      ? profile.sessionidSaved
      : cookieNames.some((name) => String(name || "").trim().toLowerCase() === "sessionid")
  );
  const items = [{
    label: "Cookie",
    value: ordinaryCookieSaved ? `已保存 ${savedCookieCount}` : "未保存",
    state: ordinaryCookieSaved ? "ready" : "missing",
  }];
  if (!requiresSessionid) {
    return { items, hint: sentimentCookieActionLabel(profile?.recommendedAction), checkedAt: "" };
  }
  const liveStatus = String(profile?.liveAuthStatus || "").trim();
  const checkedAt = profile?.liveAuthCheckedAt ? formatAdminDate(profile.liveAuthCheckedAt) : "";
  items.push({ label: "sessionid", value: sessionidSaved ? "已保存" : "未保存", state: sessionidSaved ? "ready" : "missing" });
  if (sessionidSaved) {
    const liveState = liveStatus === "verified"
      ? { value: "可用", state: "ready" }
      : liveStatus === "invalid" || liveStatus === "missing_sessionid"
        ? { value: "需重新登录", state: "missing" }
        : liveStatus === "probe_failed"
          ? { value: "自动重试中", state: "warning" }
          : liveStatus
            ? { value: "状态未知", state: "warning" }
            : { value: ordinaryCookieReady ? "等待检测" : "需重新登录", state: ordinaryCookieReady ? "warning" : "missing" };
    items.push({ label: "登录状态", ...liveState });
  }
  return {
    items,
    hint: sentimentCookieActionLabel(sessionidSaved ? profile?.liveAuthAction : "authorize-profile"),
    checkedAt,
  };
}

function formatAdminDate(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString("zh-CN", { hour12: false });
}

const SENTIMENT_COOKIE_PROFILE_PRIORITY = ["threads", "instagram", "xiaohongshusearch", "facebooksearch", "xsearch"];
const SENTIMENT_COOKIE_PROFILE_ALIASES = {
  threads: "threads",
  instagram: "instagram",
  x: "xsearch",
  xsearch: "xsearch",
  twitter: "xsearch",
  facebook: "facebooksearch",
  facebooksearch: "facebooksearch",
  fb: "facebooksearch",
  xiaohongshu: "xiaohongshusearch",
  xiaohongshusearch: "xiaohongshusearch",
  rednote: "xiaohongshusearch",
  xhs: "xiaohongshusearch",
};

function sentimentCookieProfileCanonicalKey(profile) {
  for (const field of ["key", "platform", "sourceKey"]) {
    const raw = String(profile?.[field] || "").trim();
    if (!raw) continue;
    const compact = raw.replace(/[\s_-]+/g, "").toLowerCase();
    const key = SENTIMENT_COOKIE_PROFILE_ALIASES[raw.toLowerCase()] || SENTIMENT_COOKIE_PROFILE_ALIASES[compact] || compact;
    if (SENTIMENT_COOKIE_PROFILE_PRIORITY.includes(key)) return key;
  }
  return "";
}

function preferredSentimentCookieProfiles(profiles) {
  const rows = Array.isArray(profiles) ? profiles : [];
  return rows
    .filter((profile) => SENTIMENT_COOKIE_PROFILE_PRIORITY.includes(sentimentCookieProfileCanonicalKey(profile)))
    .sort((a, b) => {
      const ak = sentimentCookieProfileCanonicalKey(a);
      const bk = sentimentCookieProfileCanonicalKey(b);
      const ai = SENTIMENT_COOKIE_PROFILE_PRIORITY.includes(ak) ? SENTIMENT_COOKIE_PROFILE_PRIORITY.indexOf(ak) : 99;
      const bi = SENTIMENT_COOKIE_PROFILE_PRIORITY.includes(bk) ? SENTIMENT_COOKIE_PROFILE_PRIORITY.indexOf(bk) : 99;
      if (ai !== bi) return ai - bi;
      return ak.localeCompare(bk);
    });
}

function renderSentimentCookieProfiles(payload) {
  const profiles = preferredSentimentCookieProfiles(payload?.profiles || []);
  adminState.sentimentCookieProfiles = profiles;
  const summary = payload?.summary || {};
  const summaryNode = el("sentimentCookieSummary");
  if (summaryNode) {
    summaryNode.innerHTML = `
      <div class="overview-pod"><div class="overview-label">已授权</div><div class="overview-value">${Number(summary.authorizedProfileCount || 0)}</div></div>
      <div class="overview-pod"><div class="overview-label">需处理</div><div class="overview-value">${Number(summary.needsRefreshProfileCount || 0)}</div></div>
      <div class="overview-pod"><div class="overview-label">有效 Cookie</div><div class="overview-value">${Number(summary.validCookieCount || 0)}</div></div>
      <div class="overview-pod"><div class="overview-label">过期 Cookie</div><div class="overview-value">${Number(summary.expiredCookieCount || 0)}</div></div>
    `;
  }
  const select = el("sentimentCookieProfile");
  if (select) {
    const previous = select.value;
    select.innerHTML = profiles.map((profile) => {
      const key = String(profile.key || profile.platform || "");
      const label = `${profile.label || key} (${sentimentCookieHealthLabel(profile.authHealth)})`;
      return `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`;
    }).join("");
    if (previous && profiles.some((profile) => String(profile.key || profile.platform || "") === previous)) {
      select.value = previous;
    }
  }
  const body = el("sentimentCookieBody");
  if (body) {
    body.innerHTML = profiles.map((profile) => {
      const key = String(profile.key || profile.platform || "");
      const cookieNames = (Array.isArray(profile.cookieNames) ? profile.cookieNames : []).slice(0, 12);
      const nameText = cookieNames.length ? cookieNames.join(", ") : "-";
      const statusDetails = sentimentCookieStatusDetails(profile);
      const statusItems = Array.isArray(statusDetails.items) ? statusDetails.items : [];
      return `
        <tr>
          <td><strong>${escapeHtml(profile.label || key)}</strong><div class="small">${escapeHtml(profile.domain || profile.platform || "")}</div></td>
          <td>
            <span class="badge ${escapeHtml(profile.authHealth || "unknown")}">${escapeHtml(sentimentCookieHealthLabel(profile.authHealth))}</span>
            <div class="sentiment-cookie-state-list">
              ${statusItems.map((item) => `
                <span class="sentiment-cookie-state-pill ${escapeHtml(item.state || "unknown")}">
                  <span>${escapeHtml(item.label || "状态")}</span>
                  <strong>${escapeHtml(item.value || "-")}</strong>
                </span>
              `).join("")}
            </div>
            ${statusDetails.hint ? `<div class="sentiment-cookie-hint">${escapeHtml(statusDetails.hint)}</div>` : ""}
            ${statusDetails.checkedAt ? `<div class="sentiment-cookie-updated">检测于 ${escapeHtml(statusDetails.checkedAt)}</div>` : ""}
          </td>
          <td>${Number(profile.validCookieCount || 0)} / ${Number(profile.expiredCookieCount || 0)}</td>
          <td>${Number(profile.expiringSoonCookieCount || 0)}<div class="small">${escapeHtml(profile.nearestExpiresAt || "")}</div></td>
          <td>${escapeHtml(formatAdminDate(profile.lastAuthorizedAt))}</td>
          <td class="sentiment-cookie-names">${escapeHtml(nameText)}</td>
          <td class="sentiment-cookie-actions">
            <button type="button" class="ghost" data-act="sentiment_cookie_pick" data-id="${escapeHtml(key)}">手动填 Cookie</button>
            <button type="button" class="ghost" data-act="sentiment_cookie_open" data-id="${escapeHtml(key)}">打开</button>
          </td>
        </tr>
      `;
    }).join("");
  }
}

function selectedSentimentCookieProfile(profileKey = "") {
  const key = String(profileKey || el("sentimentCookieProfile")?.value || "").trim();
  const profiles = Array.isArray(adminState.sentimentCookieProfiles) ? adminState.sentimentCookieProfiles : [];
  return profiles.find((profile) => String(profile.key || profile.platform || "") === key) || profiles[0] || null;
}

function sentimentCookieAuthUrl(profile) {
  if (!profile) return "";
  const urls = Array.isArray(profile.authUrls) ? profile.authUrls.map((item) => String(item || "").trim()).filter(Boolean) : [];
  const primary = String(profile.authUrl || "").trim();
  return primary || urls[0] || (profile.domain ? `https://${String(profile.domain).replace(/^\.+/, "")}/` : "");
}

function openSentimentCookieAuthPage(profileKey = "") {
  const profile = selectedSentimentCookieProfile(profileKey);
  const url = sentimentCookieAuthUrl(profile);
  if (!url) throw new Error("当前平台没有配置授权页。");
  if (el("sentimentCookieProfile") && profile) el("sentimentCookieProfile").value = String(profile.key || profile.platform || "");
  window.open(url, "_blank", "noopener");
  setMsg("sentimentCookieMsg", `已打开 ${profile?.label || profile?.key || "当前平台"} 授权页。登录完成后在浏览器授权助手中同步当前站点。`, true);
}

async function copySentimentCookieHelperBase() {
  const base = window.location.origin;
  await navigator.clipboard.writeText(base);
  setMsg("sentimentCookieMsg", `已复制助手接口地址：${base}`, true);
}

async function copySentimentCookieExtensionUrl() {
  await navigator.clipboard.writeText("chrome://extensions/");
  setMsg("sentimentCookieMsg", "已复制扩展管理页地址：chrome://extensions/。浏览器限制网页直接打开该地址，请粘贴到地址栏进入。", true);
}

async function copySentimentCookieHelperToken() {
  const payload = await api("/api/admin/sentiment/browser_auth/helper_token");
  const token = String(payload?.token || "").trim();
  if (!token) throw new Error("未取得同步令牌，请刷新后台后重试。");
  await navigator.clipboard.writeText(token);
  setMsg("sentimentCookieMsg", "已复制同步令牌。请粘贴到浏览器授权助手的同步令牌输入框并保存。", true);
}

async function rotateSentimentCookieHelperToken() {
  const payload = await api("/api/admin/sentiment/browser_auth/helper_token/rotate", { method: "POST" });
  const token = String(payload?.token || "").trim();
  if (!token) throw new Error("同步令牌轮换失败，请稍后重试。");
  await navigator.clipboard.writeText(token);
  setMsg("sentimentCookieMsg", "同步令牌已轮换并复制。新版授权助手会自动刷新后台配置；如果同步提示令牌失效，请在助手中保存新令牌或重新加载新版助手。", true);
}

function sentimentDownloadFilename(disposition) {
  const text = String(disposition || "");
  const utf8Match = text.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const match = text.match(/filename="?([^";]+)"?/i);
  return match ? match[1] : "opinx-browser-auth-helper.zip";
}

async function downloadSentimentCookieHelper() {
  setMsg("sentimentCookieMsg", "正在生成授权助手下载包...");
  const response = await fetch("/browser-auth-extension/download", {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("登录已过期，请重新登录后台后再下载授权助手。");
    if (response.status === 403) throw new Error("当前账号没有管理员权限，无法下载授权助手。");
    const text = await response.text().catch(() => "");
    throw new Error(text || `授权助手下载失败：HTTP ${response.status}`);
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error("授权助手下载包为空，请刷新页面后重试。");
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = sentimentDownloadFilename(response.headers.get("content-disposition"));
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  setMsg("sentimentCookieMsg", "授权助手 zip 已开始下载。建议优先按安装说明加载固定目录；zip 只作为备用安装包。", true);
}
function setSentimentCookieLiveState(text, state = "ready") {
  const node = el("sentimentCookieLiveState");
  const shell = node?.closest(".sentiment-cookie-live");
  if (node) node.textContent = String(text || "自动更新中");
  if (shell) shell.dataset.state = state;
}

async function loadSentimentCookieProfiles() {
  if (adminState.sentimentCookieRefreshPromise) return adminState.sentimentCookieRefreshPromise;
  adminState.sentimentCookieRefreshPromise = (async () => {
    const payload = await api("/api/admin/sentiment/browser_auth/profiles");
    renderSentimentCookieProfiles(payload);
    if (el("sentimentCookieMsg")?.classList.contains("err")) {
      setMsg("sentimentCookieMsg", "");
    }
    const updatedAt = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setSentimentCookieLiveState(`已更新 ${updatedAt}`, "ready");
    return payload;
  })();
  try {
    return await adminState.sentimentCookieRefreshPromise;
  } finally {
    adminState.sentimentCookieRefreshPromise = null;
  }
}

async function refreshSentimentCookieProfilesIfActive() {
  if (document.hidden || adminState.activePage !== "sentimentCookies") return null;
  try {
    return await loadSentimentCookieProfiles();
  } catch {
    setSentimentCookieLiveState("更新失败，自动重试中", "warning");
    return null;
  }
}

async function saveSentimentCookieProfile() {
  const profileKey = String(el("sentimentCookieProfile")?.value || "").trim();
  const cookiesText = String(el("sentimentCookieText")?.value || "").trim();
  const note = String(el("sentimentCookieNote")?.value || "").trim();
  if (!profileKey) throw new Error("请选择授权平台。");
  if (!cookiesText) throw new Error("请粘贴 Cookie 内容。");
  const resp = await api(`/api/admin/sentiment/browser_auth/profiles/${encodeURIComponent(profileKey)}/cookies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cookies_text: cookiesText, note }),
  });
  if (el("sentimentCookieText")) el("sentimentCookieText").value = "";
  await loadSentimentCookieProfiles();
  return resp;
}

async function clearSentimentCookieProfile() {
  const profileKey = String(el("sentimentCookieProfile")?.value || "").trim();
  if (!profileKey) throw new Error("请选择授权平台。");
  if (!confirm(`确认清空 ${profileKey} 的 Cookie 吗？清空后该平台真实扫描会失效，直到重新授权。`)) return null;
  const resp = await api(`/api/admin/sentiment/browser_auth/profiles/${encodeURIComponent(profileKey)}/cookies`, {
    method: "DELETE",
  });
  await loadSentimentCookieProfiles();
  return resp;
}

async function loadPricing() {
  const p = await api("/api/admin/pricing");
  el("priceRhCoins").value = p.rh_coins_per_10rmb;
  el("priceUsdRmb").value = p.usd_to_rmb;
  el("priceNanoUsd").value = p.nano_usd_per_image;
  el("priceGemIn").value = p.gemini_input_usd_per_1m;
  el("priceGemOut").value = p.gemini_output_usd_per_1m;
}

async function savePricing() {
  const payload = {
    rh_coins_per_10rmb: Number(el("priceRhCoins").value || 2500),
    usd_to_rmb: Number(el("priceUsdRmb").value || 7.2),
    nano_usd_per_image: Number(el("priceNanoUsd").value || 0.134),
    gemini_input_usd_per_1m: Number(el("priceGemIn").value || 4.0),
    gemini_output_usd_per_1m: Number(el("priceGemOut").value || 18.0),
  };
  await api("/api/admin/pricing", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function billingList(payload, keys) {
  const roots = [payload, payload?.data].filter((item) => item && typeof item === "object");
  for (const root of roots) {
    for (const key of keys) {
      if (Array.isArray(root[key])) return root[key];
    }
  }
  return Array.isArray(payload) ? payload : [];
}

function billingCatalogOf(version) {
  const raw = version?.catalog ?? version?.catalog_json ?? version?.data ?? null;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatBillingTime(value) {
  if (value === null || value === undefined || value === "") return "-";
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 100000000000 ? numeric : numeric * 1000)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function formatBillingUnits(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.trunc(amount).toLocaleString("zh-CN") : "0";
}

function formatBillingPoints(value) {
  const points = Number(value);
  return Number.isFinite(points)
    ? points.toLocaleString("zh-CN", { maximumFractionDigits: 6 })
    : "0";
}

function formatBillingNtd(cents) {
  const value = Number(cents || 0) / 100;
  return `NT$ ${value.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const BILLING_STATUS_LABELS = {
  draft: "草稿",
  active: "使用中",
  retired: "已停用",
  pending: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
  cancelled: "已取消",
  legacy: "旧额度模式",
  enforced: "商业计费",
};

function createBillingStatus(status) {
  const normalized = String(status || "unknown").toLowerCase();
  const badge = document.createElement("span");
  badge.className = `admin-billing-status is-${normalized.replace(/[^a-z0-9_-]/g, "")}`;
  badge.textContent = BILLING_STATUS_LABELS[normalized] || status || "未知";
  return badge;
}

function createBillingCell(value, className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = String(value === null || value === undefined || value === "" ? "-" : value);
  return cell;
}

function createBillingAction(label, action, id, tone = "ghost") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${tone} admin-compact-button`;
  button.textContent = label;
  button.dataset.billingAction = action;
  button.dataset.id = String(id || "");
  return button;
}

function renderBillingCatalog(payload) {
  const versions = billingList(payload, ["versions", "items", "catalog_versions"]);
  const active = payload?.active_version
    || payload?.active
    || payload?.data?.active_version
    || versions.find((item) => String(item.status || "").toLowerCase() === "active")
    || null;
  adminState.billingCatalogVersions = versions;
  adminState.billingActiveCatalog = active;

  const activeSummary = el("billingCatalogActive");
  if (activeSummary) {
    activeSummary.replaceChildren();
    if (active) {
      const title = document.createElement("strong");
      title.textContent = `当前版本 v${active.version_number ?? active.version ?? active.id ?? "-"}`;
      const meta = document.createElement("span");
      meta.textContent = `生效于 ${formatBillingTime(active.effective_at || active.published_at)}`;
      activeSummary.append(title, createBillingStatus("active"), meta);
    } else {
      activeSummary.textContent = "当前没有已发布目录";
    }
  }

  const body = el("billingCatalogBody");
  if (!body) return;
  body.replaceChildren();
  if (!versions.length) {
    const row = document.createElement("tr");
    const cell = createBillingCell("暂无目录版本", "admin-billing-empty");
    cell.colSpan = 5;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  versions.forEach((version) => {
    const row = document.createElement("tr");
    const versionLabel = `v${version.version_number ?? version.version ?? version.id ?? "-"}`;
    row.appendChild(createBillingCell(versionLabel, "admin-billing-strong"));
    const statusCell = document.createElement("td");
    statusCell.appendChild(createBillingStatus(version.status));
    row.appendChild(statusCell);
    row.appendChild(createBillingCell(formatBillingTime(version.effective_at || version.published_at)));
    row.appendChild(createBillingCell(formatBillingTime(version.created_at)));
    const actionCell = document.createElement("td");
    actionCell.className = "admin-billing-actions";
    const inspectButton = createBillingAction("查看", "catalog-inspect", version.id);
    inspectButton.dataset.versionIndex = String(adminState.billingCatalogVersions.indexOf(version));
    actionCell.appendChild(inspectButton);
    if (String(version.status || "").toLowerCase() === "draft") {
      actionCell.appendChild(createBillingAction("发布", "catalog-publish", version.id, "primary"));
    }
    row.appendChild(actionCell);
    body.appendChild(row);
  });
}

async function loadBillingCatalog() {
  const body = el("billingCatalogBody");
  body?.setAttribute("aria-busy", "true");
  setMsg("billingCatalogMsg", "");
  try {
    const payload = await api("/api/admin/billing/catalog/versions");
    renderBillingCatalog(payload || {});
    return payload;
  } finally {
    body?.removeAttribute("aria-busy");
  }
}

function useBillingCatalog(version) {
  const catalog = billingCatalogOf(version);
  if (!catalog) {
    setMsg("billingCatalogMsg", "该版本没有可读取的目录 JSON", false);
    return;
  }
  adminState.billingCatalogDraftId = String(version.status || "").toLowerCase() === "draft"
    ? String(version.id || "")
    : null;
  el("billingCatalogJson").value = JSON.stringify(catalog, null, 2);
  if (el("btnCreateCatalogDraft")) {
    el("btnCreateCatalogDraft").textContent = adminState.billingCatalogDraftId ? "保存草稿" : "保存新草稿";
  }
  setMsg("billingCatalogMsg", `已载入版本 v${version.version_number ?? version.version ?? version.id ?? "-"}`, true);
}

async function createBillingCatalogDraft() {
  const raw = String(el("billingCatalogJson")?.value || "").trim();
  if (!raw) throw new Error("请填写目录 JSON");
  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch (err) {
    throw new Error(`目录 JSON 格式错误：${err.message}`);
  }
  if (!catalog || Array.isArray(catalog) || typeof catalog !== "object") {
    throw new Error("目录 JSON 顶层必须是对象");
  }
  let draftId = String(adminState.billingCatalogDraftId || "");
  if (!draftId) {
    const draft = await api("/api/admin/billing/catalog/versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: String(adminState.billingActiveCatalog?.id || "") }),
    });
    draftId = String(draft?.id || draft?.item?.id || draft?.data?.id || "");
    if (!draftId) throw new Error("新草稿已创建，但接口未返回草稿 ID");
  }
  await api(`/api/admin/billing/catalog/versions/${encodeURIComponent(draftId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ catalog }),
  });
  adminState.billingCatalogDraftId = draftId;
  await loadBillingCatalog();
  if (el("btnCreateCatalogDraft")) el("btnCreateCatalogDraft").textContent = "保存草稿";
  setMsg("billingCatalogMsg", "目录草稿已保存", true);
}

async function publishBillingCatalog(versionId) {
  if (!versionId || !confirm("确认发布该商业目录版本吗？发布后客户购买页将使用此版本。")) return;
  await api(`/api/admin/billing/catalog/versions/${encodeURIComponent(versionId)}/publish`, {
    method: "POST",
  });
  adminState.billingCatalogDraftId = null;
  if (el("btnCreateCatalogDraft")) el("btnCreateCatalogDraft").textContent = "保存新草稿";
  await loadBillingCatalog();
  setMsg("billingCatalogMsg", "目录版本已发布", true);
}

function renderBillingOrders(payload, { append = false, requestOffset = 0 } = {}) {
  const orders = billingList(payload, ["orders", "items"]);
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const metaValue = (key) => payload?.[key] ?? data?.[key];
  const numericMeta = (key) => {
    const value = metaValue(key);
    if (value === null || value === undefined || value === "") return Number.NaN;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : Number.NaN;
  };
  const rows = append ? [...adminState.billingOrderRows] : [];
  const rowIndexes = new Map(rows.map((order, index) => [String(order?.id || ""), index]).filter(([id]) => id));
  orders.forEach((order) => {
    const id = String(order?.id || "");
    if (id && rowIndexes.has(id)) {
      rows[rowIndexes.get(id)] = order;
      return;
    }
    if (id) rowIndexes.set(id, rows.length);
    rows.push(order);
  });
  adminState.billingOrderRows = rows;
  const currentFilter = String(el("billingOrderStatus")?.value || "pending");
  const pendingCount = Number(
    metaValue("global_pending_count")
      ?? metaValue("pending_count"),
  );
  if (Number.isFinite(pendingCount)) {
    adminState.billingPendingCount = Math.max(0, pendingCount);
  } else if (currentFilter === "pending") {
    adminState.billingPendingCount = rows.filter((order) => String(order.status || "pending") === "pending").length;
  }
  setText("billingPendingSummary", `待审批 ${adminState.billingPendingCount}`);

  const responseOffset = numericMeta("offset");
  const nextOffset = numericMeta("next_offset");
  const total = Number.isFinite(numericMeta("total")) ? numericMeta("total") : numericMeta("total_count");
  const resolvedOffset = Number.isFinite(responseOffset) ? Math.max(0, responseOffset) : Math.max(0, requestOffset);
  adminState.billingOrderOffset = Number.isFinite(nextOffset)
    ? Math.max(0, nextOffset)
    : resolvedOffset + orders.length;
  const hasMoreValue = metaValue("has_more");
  adminState.billingOrderHasMore = typeof hasMoreValue === "boolean"
    ? hasMoreValue
    : (Number.isFinite(total) ? adminState.billingOrderOffset < total : false);
  setText(
    "billingOrderPageSummary",
    Number.isFinite(total) ? `已加载 ${rows.length} / ${Math.max(0, total)} 条` : `已加载 ${rows.length} 条`,
  );
  const loadMore = el("btnLoadMoreBillingOrders");
  if (loadMore) {
    loadMore.hidden = !adminState.billingOrderHasMore;
    loadMore.disabled = adminState.billingOrderLoading;
  }

  const body = el("billingOrderBody");
  if (!body) return;
  body.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = createBillingCell(currentFilter === "all" ? "暂无方案申请" : "当前状态下没有方案申请", "admin-billing-empty");
    cell.colSpan = 7;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  rows.forEach((order) => {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const orderId = document.createElement("strong");
    orderId.textContent = String(order.id || "-");
    const user = document.createElement("span");
    user.textContent = `${order.username || order.user_name || "客户"} · ID ${order.user_id ?? "-"}`;
    identity.append(orderId, user);
    row.appendChild(identity);
    row.appendChild(createBillingCell(`${order.sku || "-"} × ${order.quantity || 1}`));
    row.appendChild(createBillingCell(formatBillingNtd(order.amount_ntd_cents), "admin-billing-money"));
    const application = document.createElement("td");
    const summary = document.createElement("strong");
    summary.textContent = String(order.note || "线上方案申请");
    const detail = document.createElement("span");
    const legacyPayment = [order.payer_name, order.payment_reference].filter(Boolean).join(" · ");
    detail.textContent = legacyPayment ? `旧版附加资料：${legacyPayment}` : "在线申请";
    application.append(summary, detail);
    if (order.proof_path) {
      const proof = document.createElement("span");
      proof.textContent = `旧版附件：${String(order.proof_path)}`;
      application.appendChild(proof);
    }
    row.appendChild(application);
    const status = String(order.status || "pending").toLowerCase();
    const statusCell = document.createElement("td");
    statusCell.appendChild(createBillingStatus(status));
    row.appendChild(statusCell);
    row.appendChild(createBillingCell(formatBillingTime(order.created_at)));
    const actions = document.createElement("td");
    actions.className = "admin-billing-actions";
    if (status === "pending") {
      actions.append(
        createBillingAction("拒绝", "order-reject", order.id, "danger"),
        createBillingAction("批准", "order-approve", order.id, "primary"),
      );
    } else {
      actions.textContent = order.review_note || "已处理";
    }
    row.appendChild(actions);
    body.appendChild(row);
  });
}

async function loadBillingOrders({ append = false } = {}) {
  if (append && adminState.billingOrderLoading) return null;
  const status = String(el("billingOrderStatus")?.value || "pending");
  const requestOffset = append ? adminState.billingOrderOffset : 0;
  if (!append) {
    adminState.billingOrderRows = [];
    adminState.billingOrderOffset = 0;
    adminState.billingOrderHasMore = false;
    setText("billingOrderPageSummary", "正在加载申请...");
  }
  const query = new URLSearchParams({ limit: "200", offset: String(requestOffset) });
  if (status !== "all") query.set("status", status);
  const requestSequence = ++adminState.billingOrderRequestSequence;
  const body = el("billingOrderBody");
  body?.setAttribute("aria-busy", "true");
  adminState.billingOrderLoading = true;
  const loadMore = el("btnLoadMoreBillingOrders");
  if (loadMore) {
    loadMore.disabled = true;
    if (!append) loadMore.hidden = true;
    if (append) loadMore.textContent = "加载中...";
  }
  if (!append) setMsg("billingOrderMsg", "");
  try {
    const payload = await api(`/api/admin/billing/orders?${query.toString()}`);
    if (
      requestSequence !== adminState.billingOrderRequestSequence
      || status !== String(el("billingOrderStatus")?.value || "pending")
    ) return null;
    renderBillingOrders(payload || {}, { append, requestOffset });
    return payload;
  } catch (error) {
    if (
      requestSequence !== adminState.billingOrderRequestSequence
      || status !== String(el("billingOrderStatus")?.value || "pending")
    ) return null;
    throw error;
  } finally {
    if (requestSequence === adminState.billingOrderRequestSequence) {
      adminState.billingOrderLoading = false;
      body?.removeAttribute("aria-busy");
      if (loadMore) {
        loadMore.disabled = false;
        loadMore.textContent = "加载更多";
        loadMore.hidden = !adminState.billingOrderHasMore;
      }
    }
  }
}

async function reviewBillingOrder(orderId, status) {
  const label = status === "approved" ? "批准" : "拒绝";
  const note = prompt(`${label}方案申请 ${orderId}。请输入审批备注（可留空）：`, "");
  if (note === null) return;
  if (!confirm(`确认${label}方案申请 ${orderId} 吗？${status === "approved" ? "批准后客户权益将立即生效。" : ""}`)) return;
  const action = status === "approved" ? "approve" : "reject";
  await api(`/api/admin/billing/orders/${encodeURIComponent(orderId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: note.trim() }),
  });
  await loadBillingOrders();
  setMsg("billingOrderMsg", `方案申请已${label}`, true);
}

function createBillingSummaryItem(label, value, tone = "") {
  const item = document.createElement("div");
  item.className = `admin-billing-summary-item${tone ? ` is-${tone}` : ""}`;
  const title = document.createElement("span");
  title.textContent = label;
  const content = document.createElement("strong");
  content.textContent = value;
  item.append(title, content);
  return item;
}

function normalizeBillingUnlimited(value) {
  if (value === true || value === 1) return true;
  return ["1", "true", "yes", "unlimited"].includes(String(value ?? "").trim().toLowerCase());
}

function billingUnlimitedFrom(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of ["unlimited_compute", "unlimited"]) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        return normalizeBillingUnlimited(source[key]);
      }
    }
  }
  return sources.some((source) => String(source?.billing_mode || "").trim().toLowerCase() === "unlimited");
}

function renderUserBilling(payload, userId) {
  const root = payload?.data && typeof payload.data === "object" ? payload.data : (payload || {});
  const summaryData = root.summary && typeof root.summary === "object" ? root.summary : root;
  const user = root.user || {};
  const wallet = summaryData.wallet || summaryData.billing_wallet || {};
  const subscriptions = billingList(summaryData, ["subscriptions", "subscription_items"]);
  const grants = billingList(summaryData, ["image_grants", "grants"]);
  const ledger = billingList(root, ["ledger", "ledger_items", "entries"]);
  const availableImages = Number(summaryData.free_images?.total_remaining ?? summaryData.available_image_count ?? summaryData.image_balance ?? grants.reduce(
    (total, grant) => total + Math.max(0, Number(grant.remaining_count || 0)),
    0,
  ));
  const activeSubscriptions = Number.isFinite(Number(summaryData.active_subscription_count))
    ? Number(summaryData.active_subscription_count)
    : subscriptions.filter((item) => String(item.status || "active") === "active").length;
  const creditPoints = Number(summaryData.points ?? wallet.points ?? wallet.credit_points ?? (wallet.credit_units != null ? Number(wallet.credit_units) / 100 : (summaryData.credit_units != null ? Number(summaryData.credit_units) / 100 : 0)));
  const billingMode = String(wallet.billing_mode || summaryData.billing_mode || "legacy");
  const unlimited = billingUnlimitedFrom(summaryData, wallet, user, root);

  adminState.billingSelectedUserId = Number(user.id || root.user_id || userId);
  adminState.billingUnlimitedUsers.set(String(adminState.billingSelectedUserId), unlimited);
  if (el("billingUserId")) el("billingUserId").value = String(adminState.billingSelectedUserId);
  const summary = el("billingUserSummary");
  summary.replaceChildren(
    createBillingSummaryItem("客户", `${user.username || root.username || `ID ${adminState.billingSelectedUserId}`}`),
    createBillingSummaryItem("算力点余额", unlimited ? "∞" : formatBillingPoints(creditPoints), unlimited || creditPoints > 0 ? "positive" : "neutral"),
    createBillingSummaryItem("可用图片", `${formatBillingUnits(availableImages)} 张`, availableImages > 0 ? "positive" : "neutral"),
    createBillingSummaryItem("有效订阅", `${activeSubscriptions} 个`),
    createBillingSummaryItem("计费模式", BILLING_STATUS_LABELS[billingMode] || billingMode),
  );

  const body = el("billingLedgerBody");
  body.replaceChildren();
  if (!ledger.length) {
    const row = document.createElement("tr");
    const cell = createBillingCell("暂无计费流水", "admin-billing-empty");
    cell.colSpan = 6;
    row.appendChild(cell);
    body.appendChild(row);
  } else {
    ledger.forEach((entry) => {
      const row = document.createElement("tr");
      const amount = Number(entry.amount_points ?? entry.amount_units ?? 0);
      const balanceAfter = Number(entry.balance_after_points ?? entry.balance_after_units ?? 0);
      row.appendChild(createBillingCell(formatBillingTime(entry.created_at)));
      row.appendChild(createBillingCell(entry.asset_type || "-"));
      row.appendChild(createBillingCell(entry.event_type || entry.type || "-"));
      row.appendChild(createBillingCell(`${amount > 0 ? "+" : ""}${amount.toLocaleString("zh-CN", { maximumFractionDigits: 6 })}`, amount > 0 ? "admin-billing-positive" : (amount < 0 ? "admin-billing-negative" : "")));
      row.appendChild(createBillingCell(unlimited ? "∞" : balanceAfter.toLocaleString("zh-CN", { maximumFractionDigits: 6 })));
      row.appendChild(createBillingCell(entry.order_id || entry.ref_id || entry.ref_type || "-", "admin-billing-reference"));
      body.appendChild(row);
    });
  }
  el("billingUserPlaceholder").hidden = true;
  el("billingUserWorkspace").hidden = false;
  const unlimitedInput = el("billingAdjustmentUnlimited");
  if (unlimitedInput) unlimitedInput.checked = unlimited;
  syncBillingAdjustmentType();
}

async function loadUserBilling(userId = el("billingUserId")?.value) {
  const targetUserId = Math.floor(Number(userId || 0));
  if (targetUserId <= 0) throw new Error("请输入有效的客户 ID");
  setMsg("billingUserMsg", "");
  el("billingUserWorkspace")?.setAttribute("aria-busy", "true");
  try {
    const payload = await api(`/api/admin/users/${targetUserId}/billing`);
    renderUserBilling(payload || {}, targetUserId);
    return payload;
  } finally {
    el("billingUserWorkspace")?.removeAttribute("aria-busy");
  }
}

async function submitBillingAdjustment() {
  const userId = Math.floor(Number(adminState.billingSelectedUserId || el("billingUserId")?.value || 0));
  const adjustmentType = String(el("billingAdjustmentType")?.value || "credit");
  const amount = Number(el("billingAdjustmentAmount")?.value || 0);
  const unlimited = adjustmentType === "credit" && Boolean(el("billingAdjustmentUnlimited")?.checked);
  const note = String(el("billingAdjustmentNote")?.value || "").trim();
  if (userId <= 0) throw new Error("请先查询客户计费详情");
  if (!note) throw new Error("请填写调整原因");
  if (adjustmentType === "subscription") {
    const quantity = Math.floor(amount);
    if (!Number.isInteger(amount) || quantity < 1 || quantity > 50) throw new Error("订阅套数必须是 1-50 的整数");
    if (!confirm(`确认给客户 ID ${userId} 人工开通 ${quantity} 套月度订阅吗？`)) return;
    await api(`/api/admin/users/${userId}/billing/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity, renewal_subscription_ids: [], note }),
    });
  } else {
    const deltaPoints = unlimited ? 0 : amount;
    const wasUnlimited = adminState.billingUnlimitedUsers.get(String(userId)) === true;
    if (!Number.isFinite(deltaPoints) || (!unlimited && deltaPoints === 0 && !wasUnlimited)) {
      throw new Error("调整算力点必须是非零数值");
    }
    const actionText = unlimited
      ? "设为无限算力"
      : (wasUnlimited && deltaPoints === 0
        ? "关闭无限算力"
        : `调整 ${deltaPoints > 0 ? "+" : ""}${deltaPoints} 点并使用普通算力`);
    if (!confirm(`确认将客户 ID ${userId} ${actionText}吗？`)) return;
    const adjustmentPayload = { delta_points: deltaPoints, reason: note };
    if (unlimited) adjustmentPayload.unlimited = true;
    else if (wasUnlimited) adjustmentPayload.unlimited = false;
    await api(`/api/admin/users/${userId}/billing/adjustments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(adjustmentPayload),
    });
  }
  el("billingAdjustmentAmount").value = "";
  el("billingAdjustmentNote").value = "";
  await loadUserBilling(userId);
  setMsg("billingUserMsg", "人工调整已完成并写入审计流水", true);
  await loadUsers();
}

function syncBillingAdjustmentType() {
  const isSubscription = String(el("billingAdjustmentType")?.value || "credit") === "subscription";
  const unlimitedInput = el("billingAdjustmentUnlimited");
  if (isSubscription && unlimitedInput) unlimitedInput.checked = false;
  if (unlimitedInput) unlimitedInput.disabled = isSubscription;
  const unlimited = !isSubscription && Boolean(unlimitedInput?.checked);
  const amount = el("billingAdjustmentAmount");
  const wasUnlimited = adminState.billingUnlimitedUsers.get(String(adminState.billingSelectedUserId || "")) === true;
  setText("billingAdjustmentAmountLabel", isSubscription ? "订阅套数" : "调整算力点");
  if (amount) {
    amount.disabled = unlimited;
    if (unlimited) amount.value = "";
    amount.step = isSubscription ? "1" : "0.000001";
    amount.min = isSubscription ? "1" : "";
    amount.max = isSubscription ? "50" : "";
    amount.placeholder = isSubscription
      ? "1-50 个月"
      : (unlimited ? "无限模式无需填写" : (wasUnlimited ? "填 0 仅关闭无限，正负数同时调整" : "正数增加，负数扣减"));
  }
}

async function loadBillingWorkspace() {
  setMsg("billingWorkspaceMsg", "");
  const results = await Promise.allSettled([loadBillingCatalog(), loadBillingOrders()]);
  const failures = results.filter((result) => result.status === "rejected");
  adminState.billingLoaded = failures.length === 0;
  if (failures.length) {
    const message = failures.map((result) => getErrorMessage(result.reason)).filter(Boolean).join("；");
    setMsg("billingWorkspaceMsg", message || "计费数据读取失败", false);
  }
  return results;
}

function ensureBillingLoaded(force = false) {
  if (!force && adminState.billingLoaded) return Promise.resolve();
  if (adminState.billingLoadingPromise) return adminState.billingLoadingPromise;
  adminState.billingLoadingPromise = loadBillingWorkspace()
    .finally(() => { adminState.billingLoadingPromise = null; });
  return adminState.billingLoadingPromise;
}

const ADMIN_USER_ICONS = {
  detail: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>',
  billing: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6m-6 4h6m-6 4h4"/></svg>',
  balance: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M3 7h15a3 3 0 0 1 3 3v8H3V7Z"/><path d="M3 7V5h14v2M16 12h5"/><circle cx="16" cy="12" r="1"/></svg>',
  disable: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M12 3v8"/><path d="M7.1 5.7a8 8 0 1 0 9.8 0"/></svg>',
  enable: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.7-1.5M12 14v3"/></svg>',
  archive: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 7h16v13H4V7Z"/><path d="M3 3h18v4H3V3Zm6 9h6"/></svg>',
  restore: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 7h16v13H4V7Z"/><path d="M3 3h18v4H3V3Zm6 10 3-3 3 3m-3-3v6"/></svg>',
  delete: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 7h16M9 3h6l1 4H8l1-4ZM7 7l1 14h8l1-14M10 11v6m4-6v6"/></svg>',
};

function createAdminUserBadge(text, tone) {
  const badge = document.createElement("span");
  badge.className = `admin-user-badge admin-user-badge-${tone}`;
  badge.textContent = text;
  return badge;
}

function syncUserRoleView() {
  const role = adminState.userListRole === "admin" ? "admin" : "customer";
  document.querySelectorAll("[data-user-role]").forEach((button) => {
    const active = button.dataset.userRole === role;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const isAdmin = role === "admin";
  setText("newUserNameLabel", isAdmin ? "管理员用户名" : "客户用户名");
  setText("newUserPasswordLabel", `登录密码（至少 ${isAdmin ? 12 : 8} 位）`);
  if (el("newUserName")) el("newUserName").placeholder = isAdmin ? "manager001" : "customer001";
  if (el("newUserPassword")) el("newUserPassword").minLength = isAdmin ? 12 : 8;
  if (el("newUserBalanceField")) el("newUserBalanceField").hidden = isAdmin;
  if (el("adminCreateStepUpPanel")) el("adminCreateStepUpPanel").hidden = !isAdmin;
  if (!isAdmin) clearAdminCreateStepUp();
  const createButtonLabel = el("btnCreateUser")?.querySelector("span");
  if (createButtonLabel) createButtonLabel.textContent = isAdmin ? "创建管理员账号" : "创建客户账号";
  const pending = document.querySelector(".admin-pending-count");
  if (pending instanceof HTMLElement) pending.hidden = isAdmin;
  if (adminState.activePage === "users") {
    const pageLabel = isAdmin ? "管理员账号" : "客户账号";
    setText("adminCurrentPageLabel", pageLabel);
    document.title = `${pageLabel} - 运营后台 - Web 素材生成平台`;
  }
  syncUserBatchSelection();
}

function renderUserPagination() {
  const total = Math.max(0, Number(adminState.userListTotal || 0));
  const pageSize = Math.max(1, Number(adminState.userListPageSize || 20));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number(adminState.userListPage || 1)), totalPages);
  adminState.userListPage = page;
  const roleLabel = adminState.userListRole === "admin" ? "管理员账号" : "客户账号";
  setText("adminUserPaginationSummary", `共 ${total} 个${roleLabel}`);
  setText("adminUserPageIndicator", `第 ${page} / ${totalPages} 页`);
  if (el("btnUserPagePrev")) el("btnUserPagePrev").disabled = page <= 1;
  if (el("btnUserPageNext")) el("btnUserPageNext").disabled = page >= totalPages;
}

const USER_LIFECYCLE_META = {
  pending: ["待审核", "pending"],
  active: ["正常使用", "enabled"],
  rejected: ["已拒绝", "rejected"],
  suspended: ["临时停用", "disabled"],
  locked: ["安全锁定", "locked"],
  archived: ["只读归档", "archived"],
  deleted: ["软删除", "deleted"],
};

function readUserListFilters() {
  return {
    query: String(el("adminUserQuery")?.value || "").trim(),
    lifecycle_status: String(el("adminUserLifecycle")?.value || ""),
    risk_level: String(el("adminUserRisk")?.value || ""),
    subscription_status: adminState.userListRole === "customer" ? String(el("adminUserSubscription")?.value || "") : "",
    online: String(el("adminUserOnline")?.value || ""),
  };
}

function syncUserBatchSelection() {
  const isCustomer = adminState.userListRole === "customer";
  const batchBar = el("adminUserBatchBar");
  if (batchBar) batchBar.hidden = !isCustomer;
  document.querySelectorAll(".admin-customer-filter").forEach((node) => { node.hidden = !isCustomer; });
  setText("adminSelectedUserCount", adminState.selectedUserIds.size);
  document.querySelectorAll("input[data-user-select]").forEach((input) => {
    input.checked = adminState.selectedUserIds.has(String(input.dataset.userSelect || ""));
  });
  const selectable = Array.from(document.querySelectorAll("input[data-user-select]"));
  const selectAll = el("adminSelectAllUsers");
  if (selectAll) {
    selectAll.hidden = !isCustomer;
    selectAll.checked = Boolean(selectable.length) && selectable.every((input) => input.checked);
    selectAll.indeterminate = selectable.some((input) => input.checked) && !selectAll.checked;
  }
  const action = String(el("adminUserBatchAction")?.value || "");
  if (el("adminBatchGroupField")) el("adminBatchGroupField").hidden = action !== "assign_group";
  if (el("adminBatchTagsField")) el("adminBatchTagsField").hidden = action !== "add_tags";
  if (el("btnRunUserBatch")) el("btnRunUserBatch").disabled = !adminState.userBatchPreview;
}

function clearUserBatchSelection() {
  adminState.selectedUserIds.clear();
  adminState.userBatchPreview = null;
  setMsg("adminUserBatchMsg", "");
  syncUserBatchSelection();
}

function buildUserBatchPayload(preview) {
  return {
    action: String(el("adminUserBatchAction")?.value || ""),
    user_ids: Array.from(adminState.selectedUserIds, (value) => Number(value)),
    reason: String(el("adminUserBatchReason")?.value || "").trim(),
    group_id: String(el("adminUserBatchGroup")?.value || ""),
    tag_ids: Array.from(el("adminUserBatchTags")?.selectedOptions || [], (option) => String(option.value)),
    preview: Boolean(preview),
  };
}

function userBatchSignature(payload) {
  return JSON.stringify({
    action: payload.action,
    user_ids: [...payload.user_ids].sort((a, b) => a - b),
    reason: payload.reason,
    group_id: payload.group_id,
    tag_ids: [...payload.tag_ids].sort(),
  });
}

async function previewUserBatchAction() {
  const payload = buildUserBatchPayload(true);
  if (!payload.action) throw new Error("请选择批量操作");
  if (!payload.user_ids.length) throw new Error("请先勾选客户账号");
  if (payload.reason.length < 2) throw new Error("请填写至少 2 个字符的操作原因");
  if (payload.action === "assign_group" && !payload.group_id) throw new Error("请选择客户分组");
  if (payload.action === "add_tags" && !payload.tag_ids.length) throw new Error("请至少选择一个客户标签");
  const result = await api("/api/admin/users/batch-actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  adminState.userBatchPreview = { ...payload, matched: Number(result.matched || 0) };
  setMsg("adminUserBatchMsg", `影响预览：匹配 ${Number(result.matched || 0)} 个客户。确认账号与操作原因无误后再执行。`, true);
  syncUserBatchSelection();
}

async function runUserBatchAction() {
  const current = buildUserBatchPayload(false);
  const preview = adminState.userBatchPreview;
  if (!preview || userBatchSignature(current) !== userBatchSignature(preview)) {
    adminState.userBatchPreview = null;
    syncUserBatchSelection();
    throw new Error("操作内容已变化，请重新预览影响");
  }
  const label = el("adminUserBatchAction")?.selectedOptions?.[0]?.textContent || current.action;
  if (!confirm(`确认对 ${preview.matched} 个客户执行“${label}”吗？`)) return;
  const result = await api("/api/admin/users/batch-actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(current),
  });
  setMsg("adminUserBatchMsg", `作业完成：成功 ${Number(result.success || 0)}，失败 ${Number(result.failed || 0)}，跳过 ${Number(result.skipped || 0)}。`, Number(result.failed || 0) === 0);
  adminState.selectedUserIds.clear();
  adminState.userBatchPreview = null;
  syncUserBatchSelection();
  await Promise.all([loadUsers(), loadGovernanceDashboard({ force: true })]);
}

async function loadUsers(page = adminState.userListPage) {
  const pageSize = Math.max(1, Number(adminState.userListPageSize || 20));
  const requestedPage = Math.max(1, Math.floor(Number(page || 1)));
  adminState.userListPage = requestedPage;
  const requestId = ++adminState.userListRequestId;
  const role = adminState.userListRole === "admin" ? "admin" : "customer";
  const filters = adminState.userListFilters;
  const params = new URLSearchParams({
    role,
    limit: String(pageSize),
    offset: String((requestedPage - 1) * pageSize),
  });
  Object.entries(filters).forEach(([key, value]) => { if (value !== "" && value !== null && value !== undefined) params.set(key, String(value)); });
  const body = el("userBody");
  body?.setAttribute("aria-busy", "true");
  let payload;
  try {
    payload = await api(`/api/admin/users?${params.toString()}`);
  } finally {
    if (requestId === adminState.userListRequestId) body?.removeAttribute("aria-busy");
  }
  if (requestId !== adminState.userListRequestId) return;
  const rows = payload.items || [];
  const total = Number.isFinite(Number(payload.total)) ? Math.max(0, Number(payload.total)) : rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (requestedPage > totalPages) {
    adminState.userListPage = totalPages;
    return loadUsers(totalPages);
  }
  adminState.userListPage = requestedPage;
  adminState.userListTotal = total;
  adminState.userCustomerCount = Math.max(0, Number(payload.customer_count || 0));
  adminState.userAdminCount = Math.max(0, Number(payload.admin_count || 0));
  setText("adminUserCount", adminState.userCustomerCount);
  setText("overviewUserCount", adminState.userCustomerCount);
  setText("overviewUserCountMirror", adminState.userCustomerCount);
  setText("adminCustomerCount", adminState.userCustomerCount);
  setText("adminManagerCount", adminState.userAdminCount);
  const pendingCount = Number.isFinite(Number(payload.pending_count))
    ? Number(payload.pending_count)
    : rows.filter((user) => user.approval_status === "pending").length;
  setText("adminPendingCount", pendingCount);
  syncUserRoleView();
  renderUserPagination();

  const activeAction = document.activeElement?.closest?.("button[data-act]");
  const focusSelector = activeAction
    ? `button[data-act="${activeAction.dataset.act}"][data-id="${activeAction.dataset.id}"]`
    : "";
  body.replaceChildren();
  if (!rows.length) {
    const emptyRow = document.createElement("tr");
    const emptyCell = document.createElement("td");
    emptyCell.className = "admin-user-empty";
    emptyCell.colSpan = 10;
    emptyCell.textContent = role === "admin" ? "暂无管理员账号" : "暂无客户账号";
    emptyRow.appendChild(emptyCell);
    body.appendChild(emptyRow);
    return;
  }
  rows.forEach((u) => {
    const tr = document.createElement("tr");
    const role = u.is_admin ? "管理员" : "客户";
    const lifecycle = String(u.lifecycle_status || (Number(u.deleted_at || 0) > 0 ? "deleted" : (u.is_disabled ? "suspended" : "active")));
    const [state, stateTone] = USER_LIFECYCLE_META[lifecycle] || [lifecycle || "未知", "disabled"];
    const archived = lifecycle === "archived" || lifecycle === "deleted";
    const selectCell = document.createElement("td");
    selectCell.className = "admin-user-select-cell";
    if (!u.is_admin) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.userSelect = String(u.id);
      checkbox.setAttribute("aria-label", `选择客户 ${u.username}`);
      checkbox.checked = adminState.selectedUserIds.has(String(u.id));
      selectCell.appendChild(checkbox);
    }
    tr.appendChild(selectCell);
    const accountCell = document.createElement("td");
    accountCell.className = "admin-user-account-cell";
    const accountName = document.createElement("strong");
    accountName.textContent = String(u.username || "-");
    const accountId = document.createElement("span");
    accountId.textContent = `ID ${u.id}`;
    accountCell.append(accountName, accountId);
    tr.appendChild(accountCell);

    const companyCell = document.createElement("td");
    companyCell.className = "admin-user-company-cell";
    companyCell.textContent = [u.full_name, u.company].filter(Boolean).join(" / ") || "-";
    tr.appendChild(companyCell);

    const roleCell = document.createElement("td");
    roleCell.appendChild(createAdminUserBadge(role, u.is_admin ? "admin" : "customer"));
    tr.appendChild(roleCell);

    const stateCell = document.createElement("td");
    stateCell.appendChild(createAdminUserBadge(state, stateTone));
    tr.appendChild(stateCell);

    [u.persona_count, u.created_post_count, u.published_post_count].forEach((value) => {
      const td = document.createElement("td");
      td.className = "admin-user-stat-cell";
      td.textContent = String(Math.max(0, Number(value || 0)));
      tr.appendChild(td);
    });

    const balanceCell = document.createElement("td");
    balanceCell.className = "admin-user-balance-cell";
    const unlimited = billingUnlimitedFrom(u, u.wallet, u.billing_wallet);
    const responsePoints = u.credit_units !== null && u.credit_units !== undefined
      ? Number(u.credit_units) / 100
      : (u.points ?? u.wallet?.points ?? u.billing_wallet?.points);
    if (!u.is_admin && responsePoints !== null && responsePoints !== undefined && Number.isFinite(Number(responsePoints))) {
      adminState.billingWalletPoints.set(String(u.id), Number(responsePoints));
    }
    if (!u.is_admin) adminState.billingUnlimitedUsers.set(String(u.id), unlimited);
    const walletPoints = adminState.billingWalletPoints.get(String(u.id));
    balanceCell.textContent = u.is_admin ? "-" : (unlimited ? "∞" : (walletPoints === undefined ? "-" : formatBillingPoints(walletPoints)));
    if (unlimited) {
      balanceCell.title = "无限算力";
      balanceCell.setAttribute("aria-label", "无限算力");
    }
    tr.appendChild(balanceCell);

    const actions = document.createElement("td");
    actions.className = "admin-user-actions";
    const addAction = (label, act, icon, extra = {}) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ghost admin-user-icon-button${act === "archive_user" ? " is-danger" : ""}`;
      button.innerHTML = ADMIN_USER_ICONS[icon] || ADMIN_USER_ICONS.detail;
      button.setAttribute("aria-label", `${label}：${u.username}`);
      button.title = label;
      button.dataset.act = act;
      button.dataset.id = String(u.id);
      Object.entries(extra).forEach(([key, value]) => { button.dataset[key] = String(value); });
      actions.appendChild(button);
    };
    addAction("查看详情", "user_detail", "detail");
    if (!u.is_admin) addAction("计费详情", "billing_detail", "billing", { name: u.username });
    if (!archived && lifecycle === "active") {
      if (!u.is_admin) addAction("人工调整算力点", "recharge", "balance", { name: u.username, unlimited: unlimited ? 1 : 0 });
      addAction(u.is_disabled ? "启用" : "禁用", "toggle", u.is_disabled ? "enable" : "disable", { disabled: u.is_disabled ? 1 : 0 });
    }
    if (!u.is_admin) {
      if (lifecycle === "deleted") addAction("恢复账号", "restore_user", "restore", { name: u.username });
      else addAction("软删除账号", "archive_user", "delete", { name: u.username });
    }
    tr.appendChild(actions);
    body.appendChild(tr);
  });
  syncUserBatchSelection();
  if (focusSelector) body.querySelector(focusSelector)?.focus();
}

function detailRow(label, value) {
  const row = document.createElement("div");
  row.className = "admin-user-detail-item";
  const title = document.createElement("span");
  const content = document.createElement("strong");
  title.textContent = label;
  content.textContent = String(value === null || value === undefined || value === "" ? "-" : value);
  row.append(title, content);
  return row;
}

function clearUserPasswordReset() {
  if (adminState.userPasswordResetTimer) {
    window.clearTimeout(adminState.userPasswordResetTimer);
    adminState.userPasswordResetTimer = null;
  }
  if (el("userPasswordResultValue")) el("userPasswordResultValue").value = "";
  if (el("userPasswordResult")) el("userPasswordResult").hidden = true;
}

function scheduleUserPasswordResetClear() {
  if (adminState.userPasswordResetTimer) window.clearTimeout(adminState.userPasswordResetTimer);
  adminState.userPasswordResetTimer = window.setTimeout(() => {
    clearUserPasswordReset();
    setMsg("userDetailMsg", "临时密码已自动清除。", true);
  }, 60000);
}

function clearManualUserPassword(options = {}) {
  const { keepOpen = false } = options;
  const form = el("userPasswordManualForm");
  if (el("userPasswordManualValue")) el("userPasswordManualValue").value = "";
  if (el("userPasswordManualConfirm")) el("userPasswordManualConfirm").value = "";
  setMsg("userPasswordManualMsg", "");
  if (form && !keepOpen) form.hidden = true;
  if (el("btnOpenSetUserPassword")) {
    el("btnOpenSetUserPassword").setAttribute("aria-expanded", keepOpen ? "true" : "false");
  }
}

function clearUserStepUp() {
  if (el("userStepUpAdminPassword")) el("userStepUpAdminPassword").value = "";
  if (el("userStepUpTotpCode")) el("userStepUpTotpCode").value = "";
  if (el("userStepUpReason")) el("userStepUpReason").value = "";
}

function readAdminStepUp({
  adminPasswordId,
  totpCodeId,
  reasonId,
  messageTarget = "userDetailMsg",
} = {}) {
  const payload = {
    admin_password: String(el(adminPasswordId)?.value || ""),
    totp_code: String(el(totpCodeId)?.value || "").trim(),
    reason: String(el(reasonId)?.value || "").trim(),
  };
  if (!payload.admin_password) {
    setMsg(messageTarget, "请输入管理员当前密码。", false);
    el(adminPasswordId)?.focus();
    return null;
  }
  if (!payload.totp_code) {
    setMsg(messageTarget, "请输入动态验证码或恢复码。", false);
    el(totpCodeId)?.focus();
    return null;
  }
  if (payload.reason.length < 2) {
    setMsg(messageTarget, "请填写至少 2 个字符的操作原因。", false);
    el(reasonId)?.focus();
    return null;
  }
  return payload;
}

function readUserStepUp(messageTarget = "userDetailMsg") {
  return readAdminStepUp({
    adminPasswordId: "userStepUpAdminPassword",
    totpCodeId: "userStepUpTotpCode",
    reasonId: "userStepUpReason",
    messageTarget,
  });
}

function setManualUserPasswordFormOpen(open) {
  const form = el("userPasswordManualForm");
  if (!form || adminState.userPasswordSetInFlight) return;
  if (open) {
    clearUserPasswordReset();
    clearRevealedUserPassword();
    clearManualUserPassword({ keepOpen: true });
    form.hidden = false;
    el("btnOpenSetUserPassword")?.setAttribute("aria-expanded", "true");
    window.setTimeout(() => el("userPasswordManualValue")?.focus(), 0);
    return;
  }
  clearManualUserPassword();
  el("btnOpenSetUserPassword")?.focus();
}

function clearRevealedUserPassword(options = {}) {
  const { message = "", isSuccess = false } = options;
  adminState.userPasswordRevealRequestId += 1;
  adminState.userPasswordRevealUserId = null;
  adminState.userPasswordRevealInFlight = false;
  if (adminState.userPasswordRevealTimer) {
    window.clearTimeout(adminState.userPasswordRevealTimer);
    adminState.userPasswordRevealTimer = null;
  }
  const input = el("userPasswordRevealValue");
  if (input) input.value = "";
  if (el("userPasswordRevealResult")) el("userPasswordRevealResult").hidden = true;
  if (el("btnHideUserPassword")) el("btnHideUserPassword").hidden = true;
  syncUserDetailActionState();
  if (message) setMsg("userDetailMsg", message, isSuccess);
}

function scheduleRevealedUserPasswordClear() {
  if (adminState.userPasswordRevealTimer) window.clearTimeout(adminState.userPasswordRevealTimer);
  adminState.userPasswordRevealTimer = window.setTimeout(() => {
    clearRevealedUserPassword({ message: "当前密码已自动隐藏并清除。", isSuccess: true });
  }, 60000);
}

function setUserPasswordRevealAvailability(available) {
  const user = adminState.selectedUser;
  if (user) {
    user.password_reveal_available = available;
    user.password_reveal_status = available === false ? "unavailable" : "available";
  }
  const hint = el("userPasswordRevealHint");
  if (!hint) return;
  hint.textContent = available === false
    ? "该历史账号没有可查看的密码，请使用重置功能生成新密码。"
    : "点击查看后需再次确认管理员操作。";
}

async function revealSelectedUserPassword() {
  const user = adminState.selectedUser;
  if (!user?.id || user.is_admin || adminState.userPasswordRevealInFlight) return;
  const stepUp = readUserStepUp();
  if (!stepUp) return;
  if (!confirm(`确认查看账号 ${user.username || user.id} 的当前登录密码吗？请确保周围没有无关人员。`)) return;
  clearRevealedUserPassword();
  const targetUserId = String(user.id);
  const requestId = ++adminState.userPasswordRevealRequestId;
  adminState.userPasswordRevealInFlight = true;
  adminState.userPasswordRevealUserId = targetUserId;
  syncUserDetailActionState();
  try {
    const response = await api(`/api/admin/users/${user.id}/reveal-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stepUp),
    });
    const modalOpen = el("userDetailModal")?.getAttribute("aria-hidden") === "false";
    const responseStillCurrent = requestId === adminState.userPasswordRevealRequestId
      && targetUserId === String(adminState.userPasswordRevealUserId || "")
      && targetUserId === String(adminState.selectedUser?.id || "")
      && modalOpen
      && !document.hidden;
    if (!responseStillCurrent) return;
    if (Number(response.updated_at || 0) > 0) {
      adminState.selectedUser.updated_at = Number(response.updated_at);
    }
    setUserPasswordRevealAvailability(response.available !== false);
    if (response.available === false || !response.password) {
      clearRevealedUserPassword({ message: "该历史账号没有可查看的密码，请先重置并将新密码安全交付给用户。" });
      return;
    }
    el("userPasswordRevealValue").value = String(response.password);
    el("userPasswordRevealResult").hidden = false;
    el("btnHideUserPassword").hidden = false;
    clearUserStepUp();
    setMsg("userDetailMsg", "当前密码已显示，将在 60 秒后自动清除。", true);
    scheduleRevealedUserPasswordClear();
  } finally {
    if (requestId === adminState.userPasswordRevealRequestId) {
      adminState.userPasswordRevealInFlight = false;
      adminState.userPasswordRevealUserId = null;
      syncUserDetailActionState();
    }
  }
}

function setUserDetailBackgroundInert(enabled) {
  const modal = el("userDetailModal");
  if (!modal) return;
  if (enabled) {
    if (adminState.userDetailInertElements.length) return;
    adminState.userDetailInertElements = Array.from(document.body.children).filter((node) => {
      return node instanceof HTMLElement && node !== modal && !node.inert;
    });
    adminState.userDetailInertElements.forEach((node) => { node.inert = true; });
    return;
  }
  adminState.userDetailInertElements.forEach((node) => { node.inert = false; });
  adminState.userDetailInertElements = [];
}

function userDetailFocusableElements() {
  const modal = el("userDetailModal");
  if (!modal || modal.getAttribute("aria-hidden") === "true") return [];
  return Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))
    .filter((node) => node instanceof HTMLElement && !node.hidden && node.getClientRects().length > 0);
}

function trapUserDetailFocus(event) {
  if (event.key !== "Tab") return false;
  const focusable = userDetailFocusableElements();
  if (!focusable.length) return false;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!focusable.includes(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return true;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

function syncUserDetailActionState() {
  const user = adminState.selectedUser;
  const busy = adminState.userPasswordResetInFlight || adminState.userPasswordSetInFlight;
  if (el("btnUserDetailClose")) el("btnUserDetailClose").disabled = busy;
  if (el("btnManageUserWorkspace")) {
    el("btnManageUserWorkspace").hidden = !user || !!user.is_admin;
    el("btnManageUserWorkspace").disabled = busy || !user || !!user.is_admin;
    el("btnManageUserWorkspace").textContent = Number(user?.deleted_at || 0) > 0 ? "查看归档数据" : "登录用户控制台";
  }
  if (el("btnResetUserPassword")) el("btnResetUserPassword").disabled = busy || !user || !!user.is_admin;
  if (el("btnOpenSetUserPassword")) el("btnOpenSetUserPassword").disabled = busy || !user || !!user.is_admin;
  if (el("btnCancelSetUserPassword")) el("btnCancelSetUserPassword").disabled = busy;
  if (el("btnSaveSetUserPassword")) {
    el("btnSaveSetUserPassword").disabled = busy || !user || !!user.is_admin;
    el("btnSaveSetUserPassword").textContent = adminState.userPasswordSetInFlight ? "正在保存..." : "保存新密码";
  }
  if (el("userPasswordManualValue")) el("userPasswordManualValue").disabled = busy;
  if (el("userPasswordManualConfirm")) el("userPasswordManualConfirm").disabled = busy;
  if (el("userStepUpAdminPassword")) el("userStepUpAdminPassword").disabled = busy;
  if (el("userStepUpTotpCode")) el("userStepUpTotpCode").disabled = busy;
  if (el("userStepUpReason")) el("userStepUpReason").disabled = busy;
  if (el("btnRevealUserPassword")) {
    el("btnRevealUserPassword").disabled = busy
      || adminState.userPasswordRevealInFlight
      || !user
      || !!user.is_admin
      || user.password_reveal_available === false;
    el("btnRevealUserPassword").textContent = adminState.userPasswordRevealInFlight ? "正在读取..." : "查看当前密码";
  }
  if (el("btnHideUserPassword")) el("btnHideUserPassword").disabled = busy;
  if (el("btnCopyRevealedUserPassword")) el("btnCopyRevealedUserPassword").disabled = busy;
  if (el("btnRefreshUserSessions")) el("btnRefreshUserSessions").disabled = busy || !user;
  if (el("btnRevokeUserSessions")) el("btnRevokeUserSessions").disabled = busy || !user;
  if (el("btnRefreshPasswordHistory")) el("btnRefreshPasswordHistory").disabled = busy || !user || !!user.is_admin;
  const archived = Number(user?.deleted_at || 0) > 0;
  if (el("btnApproveUser")) el("btnApproveUser").disabled = busy || archived || !user || !!user.is_admin || user.approval_status === "approved";
  if (el("btnRejectUser")) el("btnRejectUser").disabled = busy || archived || !user || !!user.is_admin || user.approval_status !== "pending";
}

async function setSelectedUserPassword() {
  const user = adminState.selectedUser;
  if (!user?.id || user.is_admin || adminState.userPasswordSetInFlight || adminState.userPasswordResetInFlight) return;
  const password = String(el("userPasswordManualValue")?.value || "");
  const confirmation = String(el("userPasswordManualConfirm")?.value || "");
  if (password.length < 8 || password.length > 256) {
    setMsg("userPasswordManualMsg", "密码长度需为 8-256 位。", false);
    el("userPasswordManualValue")?.focus();
    return;
  }
  if (password !== confirmation) {
    setMsg("userPasswordManualMsg", "两次输入的密码不一致。", false);
    el("userPasswordManualConfirm")?.focus();
    return;
  }
  const stepUp = readUserStepUp("userPasswordManualMsg");
  if (!stepUp) return;
  if (!confirm(`确认修改账号 ${user.username || user.id} 的登录密码吗？该账号现有登录会话会立即失效。`)) return;

  const targetUserId = String(user.id);
  const requestId = ++adminState.userPasswordSetRequestId;
  adminState.userPasswordSetInFlight = true;
  adminState.userPasswordSetUserId = targetUserId;
  setMsg("userPasswordManualMsg", "");
  clearUserPasswordReset();
  clearRevealedUserPassword();
  syncUserDetailActionState();
  try {
    const response = await api(`/api/admin/users/${user.id}/set-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password,
        ...stepUp,
        expected_updated_at: Number(user.updated_at || 0),
      }),
    });
    const modalOpen = el("userDetailModal")?.getAttribute("aria-hidden") === "false";
    const responseStillCurrent = requestId === adminState.userPasswordSetRequestId
      && targetUserId === String(adminState.userPasswordSetUserId || "")
      && targetUserId === String(adminState.selectedUser?.id || "")
      && modalOpen;
    if (!responseStillCurrent) return;
    if (Number(response.updated_at || 0) > 0) {
      adminState.selectedUser.updated_at = Number(response.updated_at);
    }
    setUserPasswordRevealAvailability(true);
    clearManualUserPassword();
    clearUserStepUp();
    setMsg("userDetailMsg", "登录密码已修改，旧密码和该用户的现有登录会话已失效。", true);
    el("btnOpenSetUserPassword")?.focus();
  } finally {
    if (requestId === adminState.userPasswordSetRequestId) {
      adminState.userPasswordSetInFlight = false;
      adminState.userPasswordSetUserId = null;
      syncUserDetailActionState();
    }
  }
}

async function resetSelectedUserPassword() {
  const user = adminState.selectedUser;
  if (!user?.id || user.is_admin || adminState.userPasswordResetInFlight) return;
  const stepUp = readUserStepUp();
  if (!stepUp) return;
  if (!confirm(`确认重置账号 ${user.username || user.id} 的登录密码吗？该账号现有登录会话会立即失效。`)) return;
  const targetUserId = String(user.id);
  const requestId = ++adminState.userPasswordResetRequestId;
  adminState.userPasswordResetInFlight = true;
  adminState.userPasswordResetUserId = targetUserId;
  clearRevealedUserPassword();
  syncUserDetailActionState();
  el("userDetailDialog")?.focus();
  try {
    clearUserPasswordReset();
    const response = await api(`/api/admin/users/${user.id}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_updated_at: Number(user.updated_at || 0), ...stepUp }),
    });
    const modalOpen = el("userDetailModal")?.getAttribute("aria-hidden") === "false";
    const responseStillCurrent = requestId === adminState.userPasswordResetRequestId
      && targetUserId === String(adminState.userPasswordResetUserId || "")
      && targetUserId === String(adminState.selectedUser?.id || "")
      && modalOpen;
    if (!responseStillCurrent) return;
    if (Number(response.updated_at || 0) > 0) {
      adminState.selectedUser.updated_at = Number(response.updated_at);
    }
    clearRevealedUserPassword();
    setUserPasswordRevealAvailability(true);
    el("userPasswordResultValue").value = String(response.temporary_password || "");
    el("userPasswordResult").hidden = false;
    scheduleUserPasswordResetClear();
    clearUserStepUp();
    setMsg("userDetailMsg", "密码已重置，旧登录会话已失效。请立即复制并安全交付给用户。", true);
  } finally {
    if (requestId === adminState.userPasswordResetRequestId) {
      adminState.userPasswordResetInFlight = false;
      adminState.userPasswordResetUserId = null;
      syncUserDetailActionState();
    }
  }
}

function renderUserSessions(payload = {}) {
  const container = el("userSessionList");
  if (!container) return;
  const items = Array.isArray(payload.items) ? payload.items : [];
  container.replaceChildren();
  if (!items.length) {
    container.appendChild(createEmptyState("该账号没有登录会话"));
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  items.forEach((item) => {
    const active = !Number(item.revoked_at || 0) && Number(item.expires_at || 0) > now;
    const row = document.createElement("div");
    row.className = "admin-session-item";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${item.device_id || "未知设备"} · ${item.ip_address || "未知 IP"}`;
    const detail = document.createElement("span");
    const ended = item.revoked_at ? `撤销于 ${formatTime(item.revoked_at)}${item.revoke_reason ? ` · ${item.revoke_reason}` : ""}` : `到期 ${formatTime(item.expires_at)}`;
    detail.textContent = `${oneLine(item.user_agent || "未知客户端")} · 最近活动 ${formatTime(item.last_seen_at || item.created_at)} · ${ended}`;
    copy.append(title, detail);
    row.append(copy, createGovernanceBadge(active ? "active" : (item.revoked_at ? "revoked" : "expired"), active ? "success" : "neutral"));
    container.appendChild(row);
  });
}

async function loadSelectedUserSessions() {
  const user = adminState.selectedUser;
  if (!user?.id) return null;
  const expectedId = String(user.id);
  try {
    const payload = await api(`/api/admin/users/${user.id}/sessions`);
    if (String(adminState.selectedUser?.id || "") !== expectedId) return null;
    renderUserSessions(payload || {});
    return payload;
  } catch (error) {
    const container = el("userSessionList");
    container?.replaceChildren(createEmptyState(`会话读取失败：${getErrorMessage(error)}`));
    return null;
  }
}

async function revokeSelectedUserSessions() {
  const user = adminState.selectedUser;
  if (!user?.id) return;
  const targetUserId = String(user.id);
  if (!confirm(`确认撤销账号 ${user.username || user.id} 的全部有效登录会话吗？`)) return;
  const button = el("btnRevokeUserSessions");
  if (button) button.disabled = true;
  try {
    const result = await api(`/api/admin/users/${encodeURIComponent(targetUserId)}/sessions/revoke`, { method: "POST" });
    if (!selectedUserStillMatches(targetUserId)) return;
    await loadSelectedUserSessions();
    if (!selectedUserStillMatches(targetUserId)) return;
    setMsg("userDetailMsg", `已撤销 ${Number(result.revoked_count || 0)} 个有效会话。`, true);
  } catch (error) {
    if (selectedUserStillMatches(targetUserId)) setMsg("userDetailMsg", getErrorMessage(error), false);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderPasswordHistory(payload = {}) {
  const container = el("userPasswordHistoryList");
  if (!container) return;
  const items = Array.isArray(payload.items) ? payload.items : [];
  container.replaceChildren();
  if (!items.length) {
    container.appendChild(createEmptyState("没有可恢复的密码历史"));
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  items.forEach((item) => {
    const available = Number(item.expires_at || 0) > now && !Number(item.restored_at || 0);
    const row = document.createElement("div");
    row.className = "admin-password-history-item";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${formatTime(item.created_at)} · ${item.source || "password_change"}`;
    const detail = document.createElement("span");
    detail.textContent = Number(item.restored_at || 0)
      ? `已于 ${formatTime(item.restored_at)} 恢复`
      : `有效至 ${formatTime(item.expires_at)} · 操作者 ${item.actor_user_id || "用户本人"}`;
    copy.append(title, detail);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = available ? "恢复此密码" : "不可恢复";
    button.disabled = !available;
    button.dataset.passwordRestore = String(item.id || "");
    row.append(copy, button);
    container.appendChild(row);
  });
}

async function loadSelectedPasswordHistory() {
  const user = adminState.selectedUser;
  if (!user?.id || user.is_admin) return null;
  const expectedId = String(user.id);
  try {
    const payload = await api(`/api/admin/users/${user.id}/password-history`);
    if (String(adminState.selectedUser?.id || "") !== expectedId) return null;
    renderPasswordHistory(payload || {});
    return payload;
  } catch (error) {
    const container = el("userPasswordHistoryList");
    container?.replaceChildren(createEmptyState(`密码历史读取失败：${getErrorMessage(error)}`));
    return null;
  }
}

async function restoreSelectedUserPassword(historyId, button) {
  const user = adminState.selectedUser;
  if (!user?.id || user.is_admin || !historyId) return;
  const targetUserId = String(user.id);
  const stepUp = readUserStepUp();
  if (!stepUp) return;
  if (!confirm(`确认恢复账号 ${user.username || user.id} 的历史密码吗？该账号现有登录会话会立即失效。`)) return;
  button.disabled = true;
  try {
    const response = await api(`/api/admin/users/${encodeURIComponent(targetUserId)}/restore-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history_id: historyId, expected_updated_at: Number(user.updated_at || 0), ...stepUp }),
    });
    if (!selectedUserStillMatches(targetUserId)) return;
    if (Number(response.updated_at || 0) > 0) adminState.selectedUser.updated_at = Number(response.updated_at);
    clearUserStepUp();
    clearRevealedUserPassword();
    await Promise.all([loadSelectedPasswordHistory(), loadSelectedUserSessions()]);
    if (!selectedUserStillMatches(targetUserId)) return;
    setMsg("userDetailMsg", "历史密码已恢复，现有登录会话已撤销。", true);
  } catch (error) {
    if (selectedUserStillMatches(targetUserId)) setMsg("userDetailMsg", getErrorMessage(error), false);
  } finally {
    button.disabled = false;
  }
}

function selectedUserStillMatches(userId) {
  return String(adminState.selectedUser?.id || "") === String(userId || "");
}

async function loadSelectedUserPurgePreview() {
  const user = adminState.selectedUser;
  if (!user?.id || user.is_admin) return;
  const payload = await api(`/api/admin/users/${user.id}/purge-preview`);
  if (String(adminState.selectedUser?.id || "") !== String(user.id)) return;
  const preview = el("userPurgePreview");
  const form = el("userPurgeForm");
  preview?.replaceChildren();
  const resources = payload.resources || {};
  Object.entries(resources).forEach(([key, value]) => {
    const item = document.createElement("span");
    item.textContent = `${({ personas: "人设", persona_groups: "人设分组", social_accounts: "社媒账号", social_proxies: "代理", social_tasks: "自动化任务", tasks: "生成任务", billing_ledger: "账单流水", subscriptions: "订阅", orders: "订单" })[key] || key} ${Number(value || 0)}`;
    preview?.appendChild(item);
  });
  const summary = document.createElement("strong");
  summary.textContent = `共 ${Number(payload.total_resources || 0)} 条关联资源，永久删除后无法恢复。`;
  preview?.prepend(summary);
  if (preview) preview.hidden = false;
  if (form) form.hidden = !payload.ready;
  if (el("userPurgeUsername")) el("userPurgeUsername").placeholder = `输入 ${user.username}`;
  if (!payload.ready) throw new Error("账号尚未完成软删除，不能进入永久删除流程");
}

async function purgeSelectedUser(event) {
  event?.preventDefault();
  const user = adminState.selectedUser;
  if (!user?.id || user.is_admin) return;
  const payload = {
    confirm_username: String(el("userPurgeUsername")?.value || "").trim(),
    admin_password: String(el("userPurgeAdminPassword")?.value || ""),
    totp_code: String(el("userPurgeTotpCode")?.value || "").trim(),
    reason: String(el("userPurgeReason")?.value || "").trim(),
  };
  if (payload.confirm_username !== String(user.username || "")) throw new Error("请输入完整客户用户名确认");
  if (!payload.admin_password || !payload.totp_code) throw new Error("请输入管理员密码和动态验证码");
  if (payload.reason.length < 2) throw new Error("请填写至少 2 个字符的永久删除原因");
  if (!confirm(`最后确认：永久删除 ${user.username} 及其全部关联资源？此操作无法撤销。`)) return;
  const result = await api(`/api/admin/users/${user.id}/purge`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (result.ok === false) throw new Error(`清理未完成：${(result.cleanup_pending || []).join("、") || "存在运行中资源"}`);
  closeUserDetailModal();
  await Promise.all([loadUsers(), loadGovernanceDashboard({ force: true })]);
  setMsg("userMsg", `客户 ${user.username} 及关联数据已永久删除。`, true);
}

async function openUserDetailModal(id) {
  if (adminState.userPasswordResetInFlight || adminState.userPasswordSetInFlight) {
    setMsg("userDetailMsg", "密码正在保存，请等待操作完成后再切换账号。", false);
    return;
  }
  clearRevealedUserPassword();
  clearUserStepUp();
  adminState.userDetailReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const requestId = ++adminState.userDetailRequestId;
  const response = await api(`/api/admin/users/${id}`);
  if (requestId !== adminState.userDetailRequestId) return;
  const user = response.user || {};
  const resourceCounts = response.resource_counts || {};
  adminState.selectedUser = user;
  el("userDetailSub").textContent = `${user.username || "-"} · ID ${user.id || "-"}`;
  const body = el("userDetailBody");
  body.replaceChildren(
    detailRow("登录账号", user.username),
    detailRow("账号 ID", user.id),
    detailRow("姓名", user.full_name),
    detailRow("公司 / 团队", user.company),
    detailRow("电子邮箱", user.email),
    detailRow("联系电话", user.phone),
    detailRow("账号角色", user.is_admin ? "管理员" : "客户"),
    detailRow("账号状态", (USER_LIFECYCLE_META[String(user.lifecycle_status || "")] || [user.is_disabled ? "已禁用" : "已启用"])[0]),
    detailRow(
      "密码状态",
      user.password_configured
        ? (user.password_reveal_available === false ? "已设置（历史账号，重置后可查看）" : "已设置")
        : "未设置",
    ),
    detailRow("申请类型", user.account_type === "guest" ? "游客申请" : "后台创建"),
    detailRow("审核状态", user.approval_status),
    detailRow(
      "算力点余额",
      user.is_admin
        ? "-"
        : (billingUnlimitedFrom(user, user.wallet, user.billing_wallet) || adminState.billingUnlimitedUsers.get(String(user.id)) === true
          ? "无限"
          : (adminState.billingWalletPoints.has(String(user.id))
          ? `${formatBillingPoints(adminState.billingWalletPoints.get(String(user.id)))} 算力点`
          : "请在计费详情查看")),
    ),
    detailRow("最后登录", user.last_login_at ? formatTime(user.last_login_at) : "尚未登录"),
    detailRow("创建时间", user.created_at ? formatTime(user.created_at) : "-"),
    detailRow("更新时间", user.updated_at ? formatTime(user.updated_at) : "-"),
    detailRow("授权时间", user.approved_at ? formatTime(user.approved_at) : "尚未授权"),
    detailRow("授权管理员", user.approved_by_username ? `${user.approved_by_username} · ID ${user.approved_by}` : "-"),
    detailRow("删除状态", Number(user.deleted_at || 0) > 0 ? `已软删除 · ${formatTime(user.deleted_at)}` : "正常"),
    detailRow("人设 / 分组", `${Number(resourceCounts.personas || 0)} / ${Number(resourceCounts.persona_groups || 0)}`),
    detailRow("社媒账号 / 代理", `${Number(resourceCounts.social_accounts || 0)} / ${Number(resourceCounts.social_proxies || 0)}`),
    detailRow("自动化任务", Number(resourceCounts.social_tasks || 0)),
  );
  const useCase = detailRow("使用情境", user.use_case);
  useCase.classList.add("admin-user-detail-item-wide");
  body.appendChild(useCase);
  clearUserPasswordReset();
  clearManualUserPassword();
  setUserPasswordRevealAvailability(user.password_reveal_available);
  el("userPasswordSection").hidden = !!user.is_admin;
  el("userPasswordHistorySection").hidden = !!user.is_admin;
  const purgeSection = el("userPurgeSection");
  if (purgeSection) purgeSection.hidden = !!user.is_admin || String(user.lifecycle_status || "") !== "deleted";
  if (el("userPurgePreview")) { el("userPurgePreview").hidden = true; el("userPurgePreview").replaceChildren(); }
  if (el("userPurgeForm")) { el("userPurgeForm").hidden = true; el("userPurgeForm").reset(); }
  el("userSessionList")?.replaceChildren(createEmptyState("正在读取会话..."));
  el("userPasswordHistoryList")?.replaceChildren(createEmptyState("正在读取密码历史..."));
  el("userApprovalNote").value = user.admin_note || "";
  setMsg("userDetailMsg", "");
  el("userDetailModal").style.display = "grid";
  el("userDetailModal").setAttribute("aria-hidden", "false");
  setUserDetailBackgroundInert(true);
  syncUserDetailActionState();
  void Promise.all([loadSelectedUserSessions(), loadSelectedPasswordHistory()]);
  window.setTimeout(() => el("btnUserDetailClose")?.focus(), 0);
}

function closeUserDetailModal() {
  const modal = el("userDetailModal");
  if (!modal || modal.getAttribute("aria-hidden") === "true") return;
  if (adminState.userPasswordResetInFlight || adminState.userPasswordSetInFlight) {
    setMsg("userDetailMsg", "密码正在保存，完成前不能关闭此窗口。", false);
    el("userDetailDialog")?.focus();
    return false;
  }
  adminState.userDetailRequestId += 1;
  adminState.userPasswordResetRequestId += 1;
  adminState.userPasswordResetUserId = null;
  adminState.userPasswordSetRequestId += 1;
  adminState.userPasswordSetUserId = null;
  clearRevealedUserPassword();
  clearUserPasswordReset();
  clearManualUserPassword();
  clearUserStepUp();
  el("userSessionList")?.replaceChildren();
  el("userPasswordHistoryList")?.replaceChildren();
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
  setUserDetailBackgroundInert(false);
  adminState.selectedUser = null;
  const returnFocus = adminState.userDetailReturnFocus;
  adminState.userDetailReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus();
  return true;
}

async function reviewSelectedUser(approvalStatus) {
  const user = adminState.selectedUser;
  if (!user?.id || adminState.userReviewInFlight) return;
  adminState.userReviewInFlight = true;
  el("btnApproveUser").disabled = true;
  el("btnRejectUser").disabled = true;
  try {
    await api(`/api/admin/users/${user.id}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approval_status: approvalStatus,
        expected_approval_status: user.approval_status,
        admin_note: el("userApprovalNote").value.trim(),
      }),
    });
    closeUserDetailModal();
    await loadUsers();
    setMsg("userMsg", approvalStatus === "approved" ? "账号已授权并启用" : "账号申请已拒绝", true);
  } finally {
    adminState.userReviewInFlight = false;
    if (adminState.selectedUser) {
      const archived = Number(user.deleted_at || 0) > 0;
      el("btnApproveUser").disabled = archived || !!user.is_admin || user.approval_status === "approved";
      el("btnRejectUser").disabled = archived || !!user.is_admin || user.approval_status !== "pending";
    }
  }
}

async function loadTasks() {
  const rows = (await api("/api/admin/tasks?limit=300")).items || [];
  taskState.rows = rows;
  const total = rows.length;
  const failed = rows.filter((row) => String(row.status || "") === "failed").length;
  const running = rows.filter((row) => ["running", "queued"].includes(String(row.status || ""))).length;
  setText("adminTaskCount", total);
  setText("overviewTaskCount", total);
  setText("overviewTaskCountMirror", total);
  setText("overviewFailedCount", failed);
  setText("overviewFailedCountMirror", failed);
  setText("overviewRunningCount", running);
  setText("overviewRunningCountMirror", running);
  syncSelectOptions(
    "taskStatusFilter",
    Array.from(new Set(rows.map((row) => String(row.status || "").trim()).filter(Boolean))).sort(),
    "全部状态",
  );
  syncSelectOptions(
    "taskWorkflowFilter",
    Array.from(new Set(rows.map((row) => String(row.workflow_name || row.type || "").trim()).filter(Boolean))).sort(),
    "全部类型",
  );
  syncSelectOptions(
    "taskUserFilter",
    Array.from(new Set(rows.map((row) => String(row.username || row.user_id || "").trim()).filter(Boolean))).sort(),
    "全部客户",
  );
  renderTasks();
  const lastUpdated = el("taskLastUpdated");
  if (lastUpdated) lastUpdated.textContent = `最近刷新：${new Date().toLocaleTimeString()}`;
}

function governanceTone(value) {
  const normalized = String(value || "").toLowerCase();
  if (["critical", "high", "failed", "failure", "denied", "locked", "degraded", "unhealthy", "revoked"].includes(normalized)) return "danger";
  if (["medium", "pending", "open", "acknowledged", "investigating", "expiring", "suspended"].includes(normalized)) return "warning";
  if (["healthy", "success", "succeeded", "active", "enabled", "resolved", "completed"].includes(normalized)) return "success";
  if (["low", "info", "running", "queued"].includes(normalized)) return "info";
  return "neutral";
}

function governanceLabel(value) {
  const normalized = String(value || "").toLowerCase();
  return ({
    critical: "严重", high: "高", medium: "中", low: "低",
    healthy: "健康", degraded: "降级", unhealthy: "异常",
    open: "开放", acknowledged: "已确认", investigating: "调查中", resolved: "已解决", ignored: "已忽略",
    success: "成功", failed: "失败", denied: "拒绝", active: "活跃", pending: "待处理",
    suspended: "已停用", archived: "已归档", deleted: "已软删除", locked: "已锁定", disabled: "已禁用", revoked: "已撤销",
    expiring: "即将到期", expired: "已到期", legacy: "Legacy", running: "运行中", idle: "空闲", manual: "人工接管", error: "异常", reclaimable: "待回收",
  })[normalized] || String(value || "-");
}

function createGovernanceBadge(value, tone = governanceTone(value)) {
  const badge = document.createElement("span");
  badge.className = `admin-semantic-badge is-${tone}`;
  badge.textContent = governanceLabel(value);
  return badge;
}

function createEmptyState(message) {
  const node = document.createElement("div");
  node.className = "admin-empty-state";
  node.textContent = message;
  return node;
}

function updateGovernanceChart(canvasId, rows, series) {
  const canvas = el(canvasId);
  if (!canvas || typeof globalThis.Chart !== "function") return;
  const items = Array.isArray(rows) ? rows : [];
  const palette = {
    "series-blue": { border: "#2563eb", background: "rgba(37, 99, 235, 0.10)" },
    "series-green": { border: "#0f9d78", background: "rgba(15, 157, 120, 0.10)" },
    "series-red": { border: "#dc2626", background: "rgba(220, 38, 38, 0.08)" },
  };
  const labels = {
    created: "新增客户", activated: "启用客户", active_logins: "活跃登录",
    success: "成功", failed: "失败", cancelled: "取消", running: "运行中",
    credited_units: "充值", consumed_units: "消费", refunded_units: "退款", adjusted_units: "管理员调整",
  };
  const datasets = series.map((item) => {
    const colors = palette[item.className] || palette["series-blue"];
    const unitScale = item.key.endsWith("_units") ? 100 : 1;
    return {
      label: labels[item.key] || item.key,
      data: items.map((row) => Math.max(0, Number(row?.[item.key] || 0)) / unitScale),
      borderColor: colors.border,
      backgroundColor: colors.background,
      borderWidth: 2,
      pointRadius: items.length > 45 ? 0 : 2,
      pointHoverRadius: 4,
      fill: true,
      tension: 0.22,
    };
  });
  const summary = series.map((item) => {
    const unitScale = item.key.endsWith("_units") ? 100 : 1;
    const total = items.reduce((sum, row) => sum + Math.max(0, Number(row?.[item.key] || 0)) / unitScale, 0);
    return `${labels[item.key] || item.key} ${total}`;
  }).join("，");
  setText(`${canvasId}Summary`, items.length ? summary : "暂无趋势数据");
  const existing = adminState.governanceCharts.get(canvasId);
  if (existing) {
    existing.data.labels = items.map((row) => String(row?.day || "").slice(5));
    existing.data.datasets = datasets;
    existing.update("none");
    return;
  }
  const chart = new globalThis.Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels: items.map((row) => String(row?.day || "").slice(5)), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } },
        tooltip: { enabled: true },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } },
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "rgba(100, 116, 139, 0.16)" } },
      },
    },
  });
  adminState.governanceCharts.set(canvasId, chart);
}

function renderGovernanceDistribution(containerId, rows, labelMap = {}) {
  const container = el(containerId);
  if (!container) return;
  const items = Array.isArray(rows) ? rows : [];
  container.replaceChildren();
  if (!items.length) {
    container.appendChild(createEmptyState("暂无分布数据"));
    return;
  }
  const max = Math.max(1, ...items.map((item) => Number(item.value || 0)));
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "admin-distribution-row";
    const label = document.createElement("span");
    const key = String(item.label || "unknown");
    label.textContent = labelMap[key] || governanceLabel(key);
    const track = document.createElement("div");
    track.className = "admin-distribution-track";
    const fill = document.createElement("div");
    fill.className = `admin-distribution-fill is-${governanceTone(key)}`;
    fill.style.width = `${Math.max(4, Number(item.value || 0) / max * 100)}%`;
    track.appendChild(fill);
    const value = document.createElement("strong");
    value.textContent = String(Number(item.value || 0));
    row.append(label, track, value);
    container.appendChild(row);
  });
}

function renderGovernanceHealth(health = {}) {
  const container = el("governanceHealthList");
  if (!container) return;
  const vault = health.password_vault || {};
  const rows = [
    ["数据库", health.database || "unknown", "连接与查询"],
    ["密码保险库", vault.healthy ? "healthy" : "degraded", vault.error || vault.status || "加密密钥检查"],
    ["计费执行", health.billing_enforcement ? "active" : "disabled", health.billing_enforcement ? "已启用" : "未启用"],
  ];
  container.replaceChildren();
  rows.forEach(([name, status, detail]) => {
    const row = document.createElement("div");
    row.className = "admin-health-row";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = name;
    const description = document.createElement("span");
    description.textContent = String(detail || "-");
    copy.append(title, description);
    row.append(copy, createGovernanceBadge(status));
    container.appendChild(row);
  });
}

function renderGovernanceQueue(containerId, items, emptyMessage, renderItem) {
  const container = el(containerId);
  if (!container) return;
  container.replaceChildren();
  if (!Array.isArray(items) || !items.length) {
    container.appendChild(createEmptyState(emptyMessage));
    return;
  }
  items.forEach((item) => container.appendChild(renderItem(item)));
}

function governanceQueueItem(title, detail, badgeValue, badgeTone) {
  const row = document.createElement("div");
  row.className = "admin-queue-item";
  const copy = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = String(title || "-");
  const meta = document.createElement("span");
  meta.textContent = String(detail || "-");
  copy.append(strong, meta);
  row.append(copy, createGovernanceBadge(badgeValue, badgeTone));
  return row;
}

function renderGovernanceDashboard(payload = {}) {
  const summary = payload.summary || {};
  const health = payload.health || {};
  setText("govKpiCustomers", Number(summary.customers || 0));
  setText("govKpiCustomersMeta", `${Number(summary.active || 0)} 个活跃 · ${Number(summary.disabled || 0)} 个停用`);
  setText("govKpiActive", Number(summary.active || 0));
  setText("govKpiActiveMeta", `停用 ${Number(summary.disabled || 0)} · 锁定 ${Number(summary.locked || 0)}`);
  setText("govKpiPending", Number(summary.pending || 0));
  setText("govKpiSessions", Number(summary.active_sessions || 0));
  setText("govKpiRunning", Number(summary.running_tasks || 0));
  setText("govKpiSuccess", Number(summary.success_today || 0));
  setText("govKpiFailed", Number(summary.failed_today || 0));
  setText("govKpiAlerts", Number(summary.open_alerts || 0));
  setText("govKpiSubscriptions", Number(summary.active_subscriptions || 0));
  setText("govKpiWallet", Number(summary.wallet_points || 0));
  setText("govKpiWalletMeta", `当期消耗 ${Number(summary.consumed_points || 0)} 点`);
  setText("adminAlertCount", Number(summary.open_alerts || 0));
  const healthLabel = governanceLabel(summary.service_health || "unknown");
  setText("govKpiHealth", healthLabel);
  setText("govKpiHealthMeta", health.password_vault?.healthy === false ? "密码保险库异常" : "关键依赖可用");
  const healthKpi = el("govKpiHealth")?.closest(".admin-governance-kpi");
  healthKpi?.classList.toggle("is-danger", String(summary.service_health) !== "healthy");
  healthKpi?.classList.toggle("is-health", String(summary.service_health) === "healthy");
  updateGovernanceChart("governanceUsersChart", payload.trends?.users || [], [
    { key: "created", className: "series-blue" },
    { key: "activated", className: "series-green" },
  ]);
  updateGovernanceChart("governanceTasksChart", payload.trends?.tasks || [], [
    { key: "success", className: "series-green" },
    { key: "failed", className: "series-red" },
  ]);
  updateGovernanceChart("governanceBillingChart", payload.trends?.billing || [], [
    { key: "credited_units", className: "series-blue" },
    { key: "consumed_units", className: "series-red" },
    { key: "refunded_units", className: "series-green" },
  ]);
  renderGovernanceDistribution("governanceLifecycleDistribution", payload.distributions?.lifecycle || [], {
    active: "活跃", pending: "待审核", suspended: "已停用", archived: "已归档", deleted: "已软删除", locked: "已锁定", rejected: "已拒绝",
  });
  renderGovernanceDistribution("governanceAlertDistribution", payload.distributions?.alerts || []);
  renderGovernanceDistribution("governanceSubscriptionDistribution", payload.distributions?.subscriptions || []);
  renderGovernanceDistribution("governanceBrowserDistribution", payload.distributions?.browsers || []);
  renderGovernanceHealth(health);
  renderGovernanceQueue("governancePendingQueue", payload.queues?.pending_users, "没有待审核客户", (item) =>
    governanceQueueItem(item.username, `${item.full_name || item.company || "未填写资料"} · ${formatTime(item.created_at)}`, "pending"));
  renderGovernanceQueue("governanceFailureQueue", payload.queues?.failed_tasks, "近期没有失败任务", (item) =>
    governanceQueueItem(item.id, `${oneLine(item.error || "无错误摘要")} · ${formatTime(item.updated_at)}`, "failed"));
  renderGovernanceQueue("governanceSecurityQueue", payload.queues?.security_alerts, "没有开放安全告警", (item) =>
    governanceQueueItem(item.title, `用户 ${item.target_user_id || "-"} · ${formatTime(item.last_seen_at)}`, item.severity));
  renderGovernanceQueue("governanceAuditQueue", payload.queues?.recent_audits, "暂无审计事件", (item) =>
    governanceQueueItem(item.action, `操作者 ${item.actor_user_id || "-"} · ${formatTime(item.created_at)}`, item.risk_level));
  renderGovernanceQueue("governanceBrowserQueue", payload.queues?.manual_browsers, "没有待人工接管的浏览器", (item) =>
    governanceQueueItem(item.title, `${item.task_id || item.session_id || "-"} · ${governanceLabel(item.task_status)}`, "manual", "warning"));
  renderGovernanceQueue("governanceSubscriptionQueue", payload.queues?.expiring_subscriptions, "7 天内没有到期订阅", (item) =>
    governanceQueueItem(item.plan_sku, `用户 ${item.user_id || "-"} · ${formatTime(item.current_period_end)}`, "expiring"));
  renderGovernanceQueue("governancePasswordQueue", payload.queues?.password_operations, "暂无密码敏感操作", (item) =>
    governanceQueueItem(item.action, `目标 ${item.target_user_id || "-"} · ${formatTime(item.created_at)}`, item.risk_level));
  renderGovernanceQueue("governanceBatchQueue", payload.queues?.batch_jobs, "暂无批量作业", (item) =>
    governanceQueueItem(item.action, `成功 ${item.success_count || 0} · 失败 ${item.failed_count || 0} · 跳过 ${item.skipped_count || 0}`, item.status));
  const generatedAt = Number(payload.generated_at || 0);
  setText("governanceUpdatedAt", generatedAt ? `数据时间：${formatTime(generatedAt)}` : `刷新于 ${new Date().toLocaleTimeString()}`);
}

function syncGovernanceRangeControls() {
  const custom = String(el("governanceRange")?.value || "30") === "custom";
  const localDateValue = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const endInput = el("governanceEndDate");
  const startInput = el("governanceStartDate");
  if (startInput && !startInput.value) startInput.value = localDateValue(new Date(Date.now() - 29 * 86400000));
  if (endInput && !endInput.value) endInput.value = localDateValue(new Date());
  if (startInput) startInput.hidden = !custom;
  if (endInput) endInput.hidden = !custom;
  syncGovernanceChartRangeLabels();
}

function governanceRangeLabel() {
  const range = String(el("governanceRange")?.value || "30");
  if (range !== "custom") return `近 ${["7", "30", "90"].includes(range) ? range : "30"} 天`;
  const start = String(el("governanceStartDate")?.value || "");
  const end = String(el("governanceEndDate")?.value || "");
  return start && end ? `${start} 至 ${end}` : "自定义范围";
}

function syncGovernanceChartRangeLabels() {
  const rangeLabel = governanceRangeLabel();
  setText("governanceUsersRangeLabel", `${rangeLabel}新增与启用`);
  setText("governanceTasksRangeLabel", `${rangeLabel}成功与失败`);
  setText("governanceBillingRangeLabel", `${rangeLabel}充值、消费与退款`);
  el("governanceUsersChart")?.setAttribute("aria-label", `${rangeLabel}客户新增与启用趋势`);
  el("governanceTasksChart")?.setAttribute("aria-label", `${rangeLabel}任务成功与失败趋势`);
  el("governanceBillingChart")?.setAttribute("aria-label", `${rangeLabel}算力充值消费退款趋势`);
}

async function loadGovernanceDashboard({ force = false } = {}) {
  if (adminState.governanceLoadingPromise && !force) return adminState.governanceLoadingPromise;
  const button = el("btnRefreshGovernance");
  if (button) button.disabled = true;
  const query = new URLSearchParams();
  const range = String(el("governanceRange")?.value || "30");
  if (range === "custom") {
    const start = String(el("governanceStartDate")?.value || "");
    const end = String(el("governanceEndDate")?.value || "");
    const startAt = Date.parse(`${start}T00:00:00+08:00`);
    const endAt = Date.parse(`${end}T23:59:59+08:00`);
    if (Number.isFinite(startAt) && Number.isFinite(endAt) && startAt <= endAt) {
      query.set("start_at", String(Math.floor(startAt / 1000)));
      query.set("end_at", String(Math.floor(endAt / 1000)));
    } else {
      setMsg("governanceMsg", "请选择有效的自定义日期范围", false);
      if (button) button.disabled = false;
      return null;
    }
  } else {
    query.set("days", ["7", "30", "90"].includes(range) ? range : "30");
  }
  syncGovernanceChartRangeLabels();
  const requestId = ++adminState.governanceRequestId;
  const request = api(`/api/admin/dashboard?${query.toString()}`)
    .then((payload) => {
      if (requestId !== adminState.governanceRequestId) return null;
      adminState.governanceLastPayload = payload || {};
      renderGovernanceDashboard(payload || {});
      setMsg("governanceMsg", "");
      return payload;
    })
    .catch((error) => {
      if (requestId !== adminState.governanceRequestId) return null;
      setMsg("governanceMsg", `治理概览刷新失败：${getErrorMessage(error)}`, false);
      return null;
    })
    .finally(() => {
      if (button && requestId === adminState.governanceRequestId) button.disabled = false;
      if (adminState.governanceLoadingPromise === request) adminState.governanceLoadingPromise = null;
    });
  adminState.governanceLoadingPromise = request;
  return request;
}

function appendCell(row, primary, secondary = "") {
  const cell = document.createElement("td");
  const strong = document.createElement("strong");
  strong.textContent = String(primary === null || primary === undefined || primary === "" ? "-" : primary);
  cell.appendChild(strong);
  if (secondary) {
    const meta = document.createElement("span");
    meta.textContent = String(secondary);
    cell.appendChild(meta);
  }
  row.appendChild(cell);
  return cell;
}

function auditQuery() {
  const query = new URLSearchParams({ limit: "200", offset: "0" });
  const values = {
    actor_user_id: el("auditActorId")?.value,
    target_user_id: el("auditTargetId")?.value,
    action: el("auditAction")?.value?.trim(),
    outcome: el("auditOutcome")?.value,
    risk_level: el("auditRisk")?.value,
  };
  Object.entries(values).forEach(([key, value]) => {
    if (String(value || "").trim()) query.set(key, String(value).trim());
  });
  return query;
}

function renderAuditEvents(payload = {}) {
  const body = el("auditBody");
  if (!body) return;
  const rows = Array.isArray(payload.items) ? payload.items : [];
  adminState.auditRows = rows;
  body.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.appendChild(createEmptyState("当前筛选条件下没有审计事件"));
    row.appendChild(cell);
    body.appendChild(row);
  } else {
    rows.forEach((item) => {
      const row = document.createElement("tr");
      appendCell(row, formatTime(item.created_at), item.request_id ? `请求 ${item.request_id}` : "");
      appendCell(row, item.action, `${item.resource_type || "resource"} · ${item.resource_id || "-"}`);
      appendCell(row, item.actor_username || `ID ${item.actor_user_id || "-"}`, item.ip_address || "");
      appendCell(row, item.target_username || `ID ${item.target_user_id || "-"}`);
      const risk = document.createElement("td");
      risk.appendChild(createGovernanceBadge(item.risk_level));
      row.appendChild(risk);
      const outcome = document.createElement("td");
      outcome.appendChild(createGovernanceBadge(item.outcome));
      row.appendChild(outcome);
      appendCell(row, oneLine(item.reason || item.error_code || "-"), item.user_agent || "");
      body.appendChild(row);
    });
  }
  setText("auditResultSummary", `显示 ${rows.length} / ${Number(payload.total || rows.length)} 条`);
}

async function loadAuditEvents() {
  const body = el("auditBody");
  body?.setAttribute("aria-busy", "true");
  try {
    const payload = await api(`/api/admin/audit/events?${auditQuery().toString()}`);
    renderAuditEvents(payload || {});
    setMsg("auditMsg", "");
    return payload;
  } catch (error) {
    setMsg("auditMsg", `审计日志读取失败：${getErrorMessage(error)}`, false);
    return null;
  } finally {
    body?.removeAttribute("aria-busy");
  }
}

async function exportAuditEvents() {
  const button = el("btnExportAudit");
  if (button) button.disabled = true;
  try {
    const response = await fetch("/api/admin/audit/export", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "X-Admin-Console": "1" },
    });
    if (!response.ok) throw new Error(`导出失败：HTTP ${response.status}`);
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = match?.[1] || "vecto-audit.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    setMsg("auditMsg", "审计日志已导出", true);
  } catch (error) {
    setMsg("auditMsg", getErrorMessage(error), false);
  } finally {
    if (button) button.disabled = false;
  }
}

function renderSecurityAlerts(payload = {}) {
  const container = el("securityAlertList");
  if (!container) return;
  const rows = Array.isArray(payload.items) ? payload.items : [];
  adminState.securityRows = rows;
  container.replaceChildren();
  if (!rows.length) {
    container.appendChild(createEmptyState("当前筛选条件下没有安全告警"));
    return;
  }
  rows.forEach((item) => {
    const article = document.createElement("article");
    article.className = `admin-security-alert is-${String(item.severity || "low").toLowerCase()}`;
    const copy = document.createElement("div");
    copy.className = "admin-security-alert-copy";
    const title = document.createElement("strong");
    title.textContent = String(item.title || item.alert_type || "安全告警");
    const summary = document.createElement("span");
    summary.textContent = oneLine(item.summary || "无摘要");
    copy.append(title, summary);
    const meta = document.createElement("div");
    meta.className = "admin-security-alert-meta";
    meta.append(createGovernanceBadge(item.severity), createGovernanceBadge(item.status));
    const seen = document.createElement("span");
    seen.textContent = `最近：${formatTime(item.last_seen_at || item.updated_at)} · 用户 ${item.target_user_id || "-"}`;
    meta.appendChild(seen);
    const actions = document.createElement("div");
    actions.className = "admin-security-alert-actions";
    const status = document.createElement("select");
    status.setAttribute("aria-label", `${title.textContent} 状态`);
    ["open", "acknowledged", "investigating", "resolved", "ignored"].forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = governanceLabel(value);
      option.selected = String(item.status) === value;
      status.appendChild(option);
    });
    const note = document.createElement("input");
    note.maxLength = 2000;
    note.placeholder = "处置备注";
    note.setAttribute("aria-label", `${title.textContent} 处置备注`);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "保存";
    save.dataset.securitySave = String(item.id || "");
    save.dataset.statusControl = "";
    actions.append(status, note, save);
    article.append(copy, meta, actions);
    container.appendChild(article);
  });
}

async function loadSecurityAlerts() {
  const query = new URLSearchParams({ limit: "200" });
  if (el("securityStatus")?.value) query.set("status", el("securityStatus").value);
  if (el("securitySeverity")?.value) query.set("severity", el("securitySeverity").value);
  try {
    const payload = await api(`/api/admin/security/alerts?${query.toString()}`);
    renderSecurityAlerts(payload || {});
    setMsg("securityMsg", "");
    return payload;
  } catch (error) {
    setMsg("securityMsg", `安全告警读取失败：${getErrorMessage(error)}`, false);
    return null;
  }
}

async function saveSecurityAlert(button) {
  const article = button.closest(".admin-security-alert");
  const status = article?.querySelector("select")?.value || "open";
  const note = article?.querySelector("input")?.value?.trim() || "";
  button.disabled = true;
  try {
    await api(`/api/admin/security/alerts/${encodeURIComponent(button.dataset.securitySave || "")}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, note }),
    });
    await Promise.all([loadSecurityAlerts(), loadGovernanceDashboard({ force: true })]);
    setMsg("securityMsg", "告警状态已更新", true);
  } catch (error) {
    setMsg("securityMsg", getErrorMessage(error), false);
  } finally {
    button.disabled = false;
  }
}

function parseScopeInput(value) {
  return [...new Set(String(value || "").split(/[，,\s]+/).map((item) => item.trim()).filter(Boolean))];
}

function timestampFromLocalInput(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? Math.floor(date.getTime() / 1000) : 0;
}

function localInputFromTimestamp(value) {
  const date = new Date(Number(value || 0) * 1000);
  if (!Number(value) || !Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function setDefaultServiceAccountExpiry() {
  const input = el("serviceAccountExpiresAt");
  if (!input || input.value) return;
  const expires = new Date(Date.now() + 30 * 86400000);
  expires.setMinutes(expires.getMinutes() - expires.getTimezoneOffset());
  input.value = expires.toISOString().slice(0, 16);
}

function renderServiceAccounts(payload = {}) {
  const body = el("serviceAccountBody");
  if (!body) return;
  const rows = Array.isArray(payload.items) ? payload.items : [];
  adminState.serviceAccountRows = rows;
  body.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.appendChild(createEmptyState("尚未创建服务账号"));
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  rows.forEach((item) => {
    const row = document.createElement("tr");
    appendCell(row, item.name, item.id);
    const purposeCell = document.createElement("td");
    const purpose = document.createElement("input");
    purpose.value = String(item.purpose || "");
    purpose.maxLength = 500;
    purpose.setAttribute("aria-label", `${item.name} 用途`);
    purposeCell.appendChild(purpose);
    row.appendChild(purposeCell);
    const scopeCell = document.createElement("td");
    const scopes = document.createElement("input");
    scopes.value = (item.allowed_scopes || []).join(", ");
    scopes.setAttribute("aria-label", `${item.name} 权限范围`);
    scopeCell.appendChild(scopes);
    row.appendChild(scopeCell);
    const statusCell = document.createElement("td");
    const status = document.createElement("select");
    ["active", "disabled", "revoked"].forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = governanceLabel(value);
      option.selected = String(item.status) === value;
      status.appendChild(option);
    });
    statusCell.appendChild(status);
    row.appendChild(statusCell);
    const timeCell = document.createElement("td");
    const expires = document.createElement("input");
    expires.type = "datetime-local";
    expires.value = localInputFromTimestamp(item.expires_at);
    expires.setAttribute("aria-label", `${item.name} 到期时间`);
    const lastUsed = document.createElement("span");
    lastUsed.textContent = item.last_used_at ? `最近使用 ${formatTime(item.last_used_at)} · ${item.last_used_ip || "-"}` : "尚未使用";
    timeCell.append(expires, lastUsed);
    row.appendChild(timeCell);
    const actionCell = document.createElement("td");
    actionCell.className = "admin-service-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "保存";
    save.dataset.serviceSave = String(item.id || "");
    const rotate = document.createElement("button");
    rotate.type = "button";
    rotate.className = "ghost";
    rotate.textContent = "轮换";
    rotate.dataset.serviceRotate = String(item.id || "");
    rotate.disabled = String(item.status || "") === "revoked";
    actionCell.append(save, rotate);
    row.appendChild(actionCell);
    body.appendChild(row);
  });
}

async function loadServiceAccounts() {
  try {
    const payload = await api("/api/admin/service-accounts");
    renderServiceAccounts(payload || {});
    setMsg("serviceAccountMsg", "");
    return payload;
  } catch (error) {
    setMsg("serviceAccountMsg", `服务账号读取失败：${getErrorMessage(error)}`, false);
    return null;
  }
}

async function createServiceAccount() {
  const stepUp = readServiceAccountStepUp();
  if (!stepUp) return;
  const payload = {
    name: el("serviceAccountName")?.value?.trim() || "",
    purpose: el("serviceAccountPurpose")?.value?.trim() || "",
    allowed_scopes: parseScopeInput(el("serviceAccountScopes")?.value),
    expires_at: timestampFromLocalInput(el("serviceAccountExpiresAt")?.value),
    ...stepUp,
  };
  if (payload.name.length < 2) throw new Error("服务账号名称至少 2 个字符");
  if (!payload.expires_at) throw new Error("请选择服务凭据到期时间");
  const result = await api("/api/admin/service-accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  el("serviceCredentialValue").value = String(result.credential || "");
  el("serviceCredentialResult").hidden = false;
  scheduleServiceCredentialClear();
  el("serviceAccountForm")?.reset();
  setDefaultServiceAccountExpiry();
  clearServiceAccountStepUp();
  await loadServiceAccounts();
  setMsg("serviceAccountMsg", "服务账号已创建，请立即保存一次性凭证", true);
}

async function saveServiceAccount(button) {
  const row = button.closest("tr");
  const controls = row ? Array.from(row.querySelectorAll("input, select")) : [];
  const [purpose, scopes, status, expires] = controls;
  const stepUp = readServiceAccountStepUp();
  if (!stepUp) return;
  button.disabled = true;
  try {
    await api(`/api/admin/service-accounts/${encodeURIComponent(button.dataset.serviceSave || "")}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        purpose: purpose?.value?.trim() || "",
        allowed_scopes: parseScopeInput(scopes?.value),
        status: status?.value || "active",
        expires_at: timestampFromLocalInput(expires?.value),
        ...stepUp,
      }),
    });
    await loadServiceAccounts();
    clearServiceAccountStepUp();
    setMsg("serviceAccountMsg", "服务账号已更新", true);
  } catch (error) {
    setMsg("serviceAccountMsg", getErrorMessage(error), false);
  } finally {
    button.disabled = false;
  }
}

async function rotateServiceAccount(button) {
  const payload = readServiceAccountStepUp();
  if (!payload) return;
  if (!confirm("轮换后旧凭证会立即失效，确认继续吗？")) return;
  button.disabled = true;
  try {
    const result = await api(`/api/admin/service-accounts/${encodeURIComponent(button.dataset.serviceRotate || "")}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    el("serviceCredentialValue").value = String(result.credential || "");
    el("serviceCredentialResult").hidden = false;
    scheduleServiceCredentialClear();
    clearServiceAccountStepUp();
    await loadServiceAccounts();
    setMsg("serviceAccountMsg", "凭证已轮换，请立即保存新凭证", true);
  } catch (error) {
    setMsg("serviceAccountMsg", getErrorMessage(error), false);
  } finally {
    button.disabled = false;
  }
}

function clearServiceCredential() {
  if (adminState.serviceCredentialTimer) {
    window.clearTimeout(adminState.serviceCredentialTimer);
    adminState.serviceCredentialTimer = null;
  }
  if (el("serviceCredentialValue")) el("serviceCredentialValue").value = "";
  if (el("serviceCredentialResult")) el("serviceCredentialResult").hidden = true;
}

function scheduleServiceCredentialClear() {
  if (adminState.serviceCredentialTimer) window.clearTimeout(adminState.serviceCredentialTimer);
  adminState.serviceCredentialTimer = window.setTimeout(() => {
    clearServiceCredential();
    setMsg("serviceAccountMsg", "一次性凭证已自动清除", true);
  }, 60000);
}

function readServiceAccountStepUp() {
  const payload = {
    admin_password: String(el("serviceRotateAdminPassword")?.value || ""),
    totp_code: String(el("serviceRotateTotpCode")?.value || "").trim(),
    reason: String(el("serviceRotateReason")?.value || "").trim(),
  };
  if (!payload.admin_password) return setMsg("serviceAccountMsg", "请输入管理员当前密码", false);
  if (!payload.totp_code) return setMsg("serviceAccountMsg", "请输入动态验证码或恢复码", false);
  if (payload.reason.length < 2) return setMsg("serviceAccountMsg", "请输入至少 2 个字符的操作原因", false);
  return payload;
}

function clearServiceAccountStepUp() {
  ["serviceRotateAdminPassword", "serviceRotateTotpCode", "serviceRotateReason"].forEach((id) => { if (el(id)) el(id).value = ""; });
}

const PROXY_MARKET_STATUS_LABELS = {
  draft: "草稿",
  active: "已发布",
  allocated: "已分配",
  maintenance: "维护中",
  disabled: "已禁用",
  archived: "已归档",
  pending: "待检测",
  healthy: "健康",
  failed: "检测失败",
  released: "已释放",
  revoked: "已回收",
};

function proxyMarketTone(value) {
  const status = String(value || "").toLowerCase();
  if (["healthy", "active"].includes(status)) return "success";
  if (["pending", "draft", "maintenance"].includes(status)) return "warning";
  if (["failed", "disabled", "revoked"].includes(status)) return "danger";
  if (["allocated"].includes(status)) return "info";
  return "neutral";
}

function createProxyMarketBadge(value) {
  const badge = createGovernanceBadge(value, proxyMarketTone(value));
  badge.textContent = PROXY_MARKET_STATUS_LABELS[String(value || "").toLowerCase()] || String(value || "-");
  return badge;
}

function parseProxyMarketList(value) {
  return [...new Set(String(value || "").split(/[,，\n]+/).map((item) => item.trim()).filter(Boolean))];
}

function proxyMarketItemById(itemId) {
  return adminState.proxyMarketItemRows.find((item) => String(item.id || "") === String(itemId || "")) || null;
}

function applyProxyMarketItemLocally(item, fallback = {}) {
  const candidate = { ...fallback, ...(item && typeof item === "object" ? item : {}) };
  const itemId = String(candidate.id || "").trim();
  if (!itemId) return null;
  const rows = [...adminState.proxyMarketItemRows];
  const index = rows.findIndex((row) => String(row.id || "") === itemId);
  candidate.id = itemId;
  if (index >= 0) rows[index] = { ...rows[index], ...candidate };
  else rows.unshift(candidate);
  renderProxyMarketItems({ items: rows });
  return proxyMarketItemById(itemId);
}

async function refreshProxyMarketItemsAfterWrite(messageId, successMessage) {
  try {
    await loadProxyMarketItems();
    setMsg(messageId, successMessage, true);
    return true;
  } catch (error) {
    setMsg(messageId, `${successMessage}，但列表刷新失败：${getErrorMessage(error)}`, true);
    return false;
  }
}

function formatProxyMarketPrice(item) {
  const cents = Math.max(0, Number(item?.display_price_cents || 0));
  const amount = (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${String(item?.currency || "TWD").toUpperCase()} ${amount}`;
}

function createProxyMarketIconButton(label, action, itemId, icon, className = "ghost") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${className} proxy-market-icon-button`;
  button.dataset.proxyMarketAction = action;
  button.dataset.id = String(itemId || "");
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
  return button;
}

function renderProxyMarketStats(rows) {
  const items = Array.isArray(rows) ? rows : [];
  setText("proxyMarketStatTotal", items.length);
  setText("proxyMarketStatAvailable", items.filter((item) => Boolean(item.available)).length);
  setText("proxyMarketStatHealthy", items.filter((item) => String(item.health_status) === "healthy").length);
  setText("proxyMarketStatAllocated", items.filter((item) => String(item.status) === "allocated").length);
  setText(
    "proxyMarketStatAttention",
    items.filter((item) => (
      ["pending", "failed"].includes(String(item.health_status))
      || ["maintenance", "disabled"].includes(String(item.status))
    )).length,
  );
}

function renderProxyMarketItems(payload = {}) {
  const body = el("proxyMarketItemBody");
  if (!body) return;
  const rows = Array.isArray(payload.items) ? payload.items : [];
  adminState.proxyMarketItemRows = rows;
  renderProxyMarketStats(rows);
  setText("proxyMarketInventorySummary", `显示 ${rows.length} 条库存`);
  body.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.appendChild(createEmptyState("当前筛选条件下没有代理库存"));
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  rows.forEach((item) => {
    const row = document.createElement("tr");
    appendCell(row, item.sku || item.id, item.display_name || "未设置显示名称");

    const endpointCell = document.createElement("td");
    const endpoint = document.createElement("strong");
    endpoint.className = "proxy-market-endpoint";
    endpoint.textContent = `${String(item.proxy_type || "").toUpperCase()} ${item.host || "-"}:${Number(item.port || 0) || "-"}`;
    const location = document.createElement("span");
    location.textContent = [item.country, item.region, item.city, item.isp].filter(Boolean).join(" · ") || "未标注地区";
    endpointCell.append(endpoint, location);
    row.appendChild(endpointCell);

    const healthCell = document.createElement("td");
    healthCell.appendChild(createProxyMarketBadge(item.health_status));
    const healthMeta = document.createElement("span");
    healthMeta.textContent = item.last_check_at
      ? `${Number(item.latency_ms || 0)} ms · ${formatTime(item.last_check_at)}`
      : "尚未检测";
    healthCell.appendChild(healthMeta);
    row.appendChild(healthCell);

    const statusCell = document.createElement("td");
    statusCell.appendChild(createProxyMarketBadge(item.status));
    const statusMeta = document.createElement("span");
    statusMeta.textContent = item.available ? "公共商城可领取" : "当前不可领取";
    statusCell.appendChild(statusMeta);
    row.appendChild(statusCell);

    const priceCell = document.createElement("td");
    const price = document.createElement("strong");
    price.textContent = `${formatProxyMarketPrice(item)} / ${item.billing_cycle || "month"}`;
    const expiry = document.createElement("span");
    expiry.textContent = item.expires_at ? `到期 ${formatTime(item.expires_at)}` : "未设置到期时间";
    priceCell.append(price, expiry);
    row.appendChild(priceCell);

    const actionCell = document.createElement("td");
    actionCell.className = "proxy-market-table-actions";
    const edit = createProxyMarketIconButton(
      `编辑 ${item.sku || item.id}`,
      "edit",
      item.id,
      '<path d="M4 20h4l11-11-4-4L4 16v4Z"></path><path d="m13.5 6.5 4 4"></path>',
    );
    const publish = createProxyMarketIconButton(
      `真实检测并发布 ${item.sku || item.id}`,
      "publish",
      item.id,
      '<circle cx="12" cy="12" r="9"></circle><path d="m8 12 2.5 2.5L16 9"></path>',
      "primary",
    );
    publish.disabled = String(item.status) === "archived";
    const status = document.createElement("select");
    status.dataset.proxyMarketStatus = String(item.id || "");
    status.setAttribute("aria-label", `${item.sku || item.id} 库存状态`);
    const currentStatus = String(item.status || "draft");
    const statusOptions = currentStatus === "draft" || !Number(item.published_at || 0)
      ? ["draft", "disabled"]
      : currentStatus === "allocated"
        ? ["allocated", "maintenance", "disabled"]
        : ["active", "maintenance", "disabled"];
    statusOptions.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = PROXY_MARKET_STATUS_LABELS[value];
      option.selected = currentStatus === value;
      option.disabled = value === "allocated";
      status.appendChild(option);
    });
    if (currentStatus === "archived") {
      const option = document.createElement("option");
      option.value = "archived";
      option.textContent = PROXY_MARKET_STATUS_LABELS.archived;
      option.selected = true;
      status.prepend(option);
      status.disabled = true;
    }
    const archive = createProxyMarketIconButton(
      `归档 ${item.sku || item.id}`,
      "archive",
      item.id,
      '<path d="M4 7h16v13H4Z"></path><path d="M3 4h18v3H3ZM9 11h6"></path>',
      "danger",
    );
    archive.disabled = String(item.status) === "archived";
    actionCell.append(edit, publish, status, archive);
    row.appendChild(actionCell);
    body.appendChild(row);
  });
}

function proxyMarketItemQuery() {
  const query = new URLSearchParams();
  const values = {
    query: el("proxyMarketQuery")?.value?.trim(),
    status: el("proxyMarketStatusFilter")?.value,
    health_status: el("proxyMarketHealthFilter")?.value,
  };
  Object.entries(values).forEach(([key, value]) => {
    if (String(value || "").trim()) query.set(key, String(value).trim());
  });
  return query.toString();
}

async function loadProxyMarketItems() {
  const body = el("proxyMarketItemBody");
  body?.setAttribute("aria-busy", "true");
  try {
    const query = proxyMarketItemQuery();
    const payload = await api(`/api/admin/proxy-market/items${query ? `?${query}` : ""}`);
    renderProxyMarketItems(payload || {});
    setMsg("proxyMarketMsg", "");
    return payload;
  } catch (error) {
    setMsg("proxyMarketMsg", `代理库存读取失败：${getErrorMessage(error)}`, false);
    throw error;
  } finally {
    body?.removeAttribute("aria-busy");
  }
}

function renderProxyMarketAllocations(payload = {}) {
  const body = el("proxyMarketAllocationBody");
  if (!body) return;
  const rows = Array.isArray(payload.items) ? payload.items : [];
  adminState.proxyMarketAllocationRows = rows;
  setText("proxyMarketAllocationSummary", `显示 ${rows.length} 条分配记录`);
  body.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.appendChild(createEmptyState("当前筛选条件下没有分配记录"));
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  rows.forEach((item) => {
    const row = document.createElement("tr");
    appendCell(row, item.username || `用户 ${item.user_id || "-"}`, `用户 ID ${item.user_id || "-"}`);
    appendCell(row, item.display_name || item.sku || item.item_id, item.proxy_name || item.sku || "");
    const statusCell = document.createElement("td");
    statusCell.appendChild(createProxyMarketBadge(item.status));
    row.appendChild(statusCell);
    appendCell(
      row,
      `${Number(item.bound_account_count || 0)} 个绑定账号`,
      `${Number(item.running_task_count || 0)} 个运行任务 · ${item.social_proxy_id || ""}`,
    );
    appendCell(row, formatTime(item.claimed_at), `更新 ${formatTime(item.updated_at || item.claimed_at)}`);
    const actionCell = document.createElement("td");
    if (String(item.status) === "active") {
      const revoke = createProxyMarketIconButton(
        `回收 ${item.display_name || item.sku || item.id}`,
        "revoke",
        item.id,
        '<path d="M4 4v6h6"></path><path d="M5.5 15a7 7 0 1 0 .6-7.7L4 10"></path>',
        "danger",
      );
      actionCell.appendChild(revoke);
    } else {
      actionCell.textContent = "-";
    }
    row.appendChild(actionCell);
    body.appendChild(row);
  });
}

async function loadProxyMarketAllocations() {
  const body = el("proxyMarketAllocationBody");
  body?.setAttribute("aria-busy", "true");
  try {
    const query = new URLSearchParams();
    if (el("proxyMarketAllocationStatus")?.value) query.set("status", el("proxyMarketAllocationStatus").value);
    const suffix = query.toString();
    const payload = await api(`/api/admin/proxy-market/allocations${suffix ? `?${suffix}` : ""}`);
    renderProxyMarketAllocations(payload || {});
    setMsg("proxyMarketAllocationMsg", "");
    return payload;
  } catch (error) {
    setMsg("proxyMarketAllocationMsg", `分配记录读取失败：${getErrorMessage(error)}`, false);
    throw error;
  } finally {
    body?.removeAttribute("aria-busy");
  }
}

function renderProxyMarketSettings(payload = {}) {
  const settings = payload.settings && typeof payload.settings === "object" ? payload.settings : payload;
  adminState.proxyMarketSettings = settings || {};
  if (el("proxyMarketDefaultClaimLimit")) {
    el("proxyMarketDefaultClaimLimit").value = String(Number(settings?.default_claim_limit ?? 3));
  }
  if (el("proxyMarketHealthMaxAgeHours")) {
    const hours = Number(settings?.health_max_age_seconds ?? 86400) / 3600;
    el("proxyMarketHealthMaxAgeHours").value = String(Number(hours.toFixed(4)));
  }
}

async function loadProxyMarketSettings() {
  try {
    const payload = await api("/api/admin/proxy-market/settings");
    renderProxyMarketSettings(payload || {});
    setMsg("proxyMarketSettingsMsg", "");
    return payload;
  } catch (error) {
    setMsg("proxyMarketSettingsMsg", `商城设置读取失败：${getErrorMessage(error)}`, false);
    throw error;
  }
}

async function loadProxyMarketWorkspace() {
  if (adminState.proxyMarketLoadingPromise) return adminState.proxyMarketLoadingPromise;
  const section = el("secProxyMarket");
  section?.classList.add("proxy-market-loading");
  const request = Promise.allSettled([
    loadProxyMarketItems(),
    loadProxyMarketAllocations(),
    loadProxyMarketSettings(),
  ]).finally(() => {
    section?.classList.remove("proxy-market-loading");
    if (adminState.proxyMarketLoadingPromise === request) adminState.proxyMarketLoadingPromise = null;
  });
  adminState.proxyMarketLoadingPromise = request;
  return request;
}

function resetProxyMarketEditor({ focus = false } = {}) {
  adminState.proxyMarketSelectedItemId = null;
  el("proxyMarketItemForm")?.reset();
  if (el("proxyMarketSku")) el("proxyMarketSku").disabled = false;
  if (el("proxyMarketCurrency")) el("proxyMarketCurrency").value = "TWD";
  if (el("proxyMarketPriceCents")) el("proxyMarketPriceCents").value = "0";
  if (el("proxyMarketProxyType")) el("proxyMarketProxyType").value = "socks5";
  if (el("proxyMarketBillingCycle")) el("proxyMarketBillingCycle").value = "month";
  setText("proxyMarketEditorTitle", "新建代理");
  setText("proxyMarketEditorHint", "先保存草稿，或直接执行真实检测并发布。");
  setText("proxyMarketEditorState", "当前为新建模式");
  setText("proxyMarketCredentialNote", "后台不会回显已保存凭据。编辑时空密码不会覆盖原密码。");
  setMsg("proxyMarketItemMsg", "");
  if (focus) {
    el("proxyMarketEditor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => el("proxyMarketSku")?.focus(), 250);
  }
}

function editProxyMarketItem(itemId, { focus = true } = {}) {
  const item = proxyMarketItemById(itemId);
  if (!item) return;
  adminState.proxyMarketSelectedItemId = String(item.id || "");
  const values = {
    proxyMarketSku: item.sku,
    proxyMarketDisplayName: item.display_name,
    proxyMarketProviderKey: item.provider_key,
    proxyMarketProxyType: item.proxy_type || "socks5",
    proxyMarketHost: item.host,
    proxyMarketPort: item.port,
    proxyMarketExpiresAt: localInputFromTimestamp(item.expires_at),
    proxyMarketUsername: "",
    proxyMarketPassword: "",
    proxyMarketCountry: item.country,
    proxyMarketRegion: item.region,
    proxyMarketCity: item.city,
    proxyMarketIsp: item.isp,
    proxyMarketPriceCents: item.display_price_cents,
    proxyMarketCurrency: item.currency || "TWD",
    proxyMarketBillingCycle: item.billing_cycle || "month",
    proxyMarketTags: (item.tags || []).join(", "),
    proxyMarketUseCases: (item.use_cases || []).join(", "),
    proxyMarketDescription: item.description,
  };
  Object.entries(values).forEach(([id, value]) => {
    if (el(id)) el(id).value = String(value ?? "");
  });
  if (el("proxyMarketSku")) el("proxyMarketSku").disabled = true;
  setText("proxyMarketEditorTitle", `编辑 ${item.sku || item.id}`);
  setText("proxyMarketEditorHint", "元数据可直接保存；连接、端口与新凭据只有真实检测成功后才会替换线上配置。");
  setText("proxyMarketEditorState", `库存状态：${PROXY_MARKET_STATUS_LABELS[item.status] || item.status || "-"} · 版本 ${Number(item.version || 1)}`);
  const configured = [];
  if (item.username_configured) configured.push("用户名");
  if (item.password_configured) configured.push("密码");
  setText(
    "proxyMarketCredentialNote",
    configured.length
      ? `已配置${configured.join("和")}，内容不会回显；输入新值会在检测成功后替换，空密码保留原密码。`
      : "当前未保存认证凭据；如代理需要认证，请在检测发布前填写。",
  );
  setMsg("proxyMarketItemMsg", "");
  if (focus) {
    el("proxyMarketEditor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => el("proxyMarketDisplayName")?.focus(), 250);
  }
}

function readProxyMarketItemForm() {
  const form = el("proxyMarketItemForm");
  if (!form?.reportValidity()) return null;
  const payload = {
    sku: el("proxyMarketSku")?.value?.trim() || "",
    display_name: el("proxyMarketDisplayName")?.value?.trim() || "",
    provider_key: el("proxyMarketProviderKey")?.value?.trim() || "",
    proxy_type: el("proxyMarketProxyType")?.value || "socks5",
    host: el("proxyMarketHost")?.value?.trim() || "",
    port: Number(el("proxyMarketPort")?.value || 0),
    username: String(el("proxyMarketUsername")?.value || ""),
    password: String(el("proxyMarketPassword")?.value || ""),
    country: el("proxyMarketCountry")?.value?.trim() || "",
    region: el("proxyMarketRegion")?.value?.trim() || "",
    city: el("proxyMarketCity")?.value?.trim() || "",
    isp: el("proxyMarketIsp")?.value?.trim() || "",
    ip_type: "static_residential",
    description: el("proxyMarketDescription")?.value?.trim() || "",
    tags: parseProxyMarketList(el("proxyMarketTags")?.value),
    use_cases: parseProxyMarketList(el("proxyMarketUseCases")?.value),
    display_price_cents: Math.max(0, Math.round(Number(el("proxyMarketPriceCents")?.value || 0))),
    currency: el("proxyMarketCurrency")?.value?.trim()?.toUpperCase() || "TWD",
    billing_cycle: el("proxyMarketBillingCycle")?.value || "month",
    expires_at: timestampFromLocalInput(el("proxyMarketExpiresAt")?.value),
  };
  if (!adminState.proxyMarketSelectedItemId && !/^[A-Za-z0-9._-]{2,80}$/.test(payload.sku)) {
    setMsg("proxyMarketItemMsg", "SKU 需为 2-80 位字母、数字、点、下划线或短横线", false);
    return null;
  }
  return payload;
}

function proxyMarketPatchPayload(payload) {
  return {
    display_name: payload.display_name,
    provider_key: payload.provider_key,
    country: payload.country,
    region: payload.region,
    city: payload.city,
    isp: payload.isp,
    description: payload.description,
    tags: payload.tags,
    use_cases: payload.use_cases,
    display_price_cents: payload.display_price_cents,
    currency: payload.currency,
    billing_cycle: payload.billing_cycle,
    expires_at: payload.expires_at,
  };
}

function proxyMarketPublishPayload(payload) {
  const result = {
    proxy_type: payload.proxy_type,
    host: payload.host,
    port: payload.port,
    expires_at: payload.expires_at,
  };
  if (payload.username) result.username = payload.username;
  if (payload.password) result.password = payload.password;
  return result;
}

async function saveProxyMarketItem({ publish = false } = {}) {
  const payload = readProxyMarketItemForm();
  if (!payload) return null;
  const selectedId = adminState.proxyMarketSelectedItemId;
  const createdDraft = !selectedId;
  const existingItem = selectedId ? proxyMarketItemById(selectedId) : null;
  const saveButton = el("btnSaveProxyMarketItem");
  const publishButton = el("btnPublishProxyMarketItem");
  if (saveButton) saveButton.disabled = true;
  if (publishButton) publishButton.disabled = true;
  setMsg("proxyMarketItemMsg", publish ? "正在执行真实连接检测..." : "正在保存代理库存...");
  try {
    let result;
    if (selectedId) {
      result = await api(`/api/admin/proxy-market/items/${encodeURIComponent(selectedId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proxyMarketPatchPayload(payload)),
      });
    } else {
      result = await api("/api/admin/proxy-market/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const itemId = String(result?.item?.id || selectedId || "");
    if (!itemId) throw new Error("代理库存已保存，但响应缺少草稿 ID");
    applyProxyMarketItemLocally(result?.item, {
      ...(existingItem || {}),
      id: itemId,
      sku: payload.sku,
      ...proxyMarketPatchPayload(payload),
      proxy_type: payload.proxy_type,
      host: payload.host,
      port: payload.port,
      ip_type: "static_residential",
      status: existingItem?.status || "draft",
      health_status: existingItem?.health_status || "pending",
    });
    adminState.proxyMarketSelectedItemId = itemId;
    editProxyMarketItem(itemId, { focus: false });
    if (publish) {
      try {
        result = await api(`/api/admin/proxy-market/items/${encodeURIComponent(itemId)}/test-and-publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(proxyMarketPublishPayload(payload)),
        });
      } catch (error) {
        error.proxyMarketDraftSaved = createdDraft;
        error.proxyMarketChangesSaved = true;
        throw error;
      }
      applyProxyMarketItemLocally(result?.item, { id: itemId });
      editProxyMarketItem(itemId, { focus: false });
    }
    if (el("proxyMarketUsername")) el("proxyMarketUsername").value = "";
    if (el("proxyMarketPassword")) el("proxyMarketPassword").value = "";
    const successMessage = publish
      ? `真实检测通过，代理已发布${Number(result?.item?.latency_ms || 0) ? `，延迟 ${Number(result.item.latency_ms)} ms` : ""}`
      : "代理库存已保存";
    await refreshProxyMarketItemsAfterWrite("proxyMarketItemMsg", successMessage);
    return result;
  } finally {
    if (saveButton) saveButton.disabled = false;
    if (publishButton) publishButton.disabled = false;
  }
}

async function publishProxyMarketRow(itemId, button) {
  const item = proxyMarketItemById(itemId);
  if (!item) return;
  if (!confirm(`将对 ${item.sku || item.id} 执行真实连接检测，成功后立即发布，确认继续吗？`)) return;
  button.disabled = true;
  setMsg("proxyMarketMsg", `正在检测 ${item.sku || item.id}...`);
  try {
    const result = await api(`/api/admin/proxy-market/items/${encodeURIComponent(item.id)}/test-and-publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proxy_type: item.proxy_type,
        host: item.host,
        port: Number(item.port || 0),
        expires_at: Number(item.expires_at || 0),
      }),
    });
    applyProxyMarketItemLocally(result?.item, {
      ...item,
      status: "active",
      health_status: "healthy",
    });
    await refreshProxyMarketItemsAfterWrite(
      "proxyMarketMsg",
      `真实检测通过，${item.sku || item.id} 已发布，延迟 ${Number(result?.item?.latency_ms || 0)} ms`,
    );
  } finally {
    button.disabled = false;
  }
}

async function updateProxyMarketStatus(itemId, status, control) {
  const item = proxyMarketItemById(itemId);
  if (!item || status === String(item.status || "")) return;
  control.disabled = true;
  try {
    let result;
    try {
      result = await api(`/api/admin/proxy-market/items/${encodeURIComponent(itemId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
    } catch (error) {
      control.value = String(item.status || "");
      throw error;
    }
    const updated = applyProxyMarketItemLocally(result?.item, { ...item, status });
    if (updated) control.value = String(updated.status || status);
    await refreshProxyMarketItemsAfterWrite(
      "proxyMarketMsg",
      `${item.sku || item.id} 已切换为${PROXY_MARKET_STATUS_LABELS[updated?.status || status] || updated?.status || status}`,
    );
  } finally {
    control.disabled = false;
  }
}

async function archiveProxyMarketItem(itemId, button) {
  const item = proxyMarketItemById(itemId);
  if (!item) return;
  if (!confirm(`确认归档 ${item.sku || item.id} 吗？商城将停止展示，关联代理也会被禁用。`)) return;
  button.disabled = true;
  try {
    const result = await api(`/api/admin/proxy-market/items/${encodeURIComponent(itemId)}/archive`, { method: "POST" });
    applyProxyMarketItemLocally(result?.item, { ...item, status: "archived", available: false });
    if (String(adminState.proxyMarketSelectedItemId || "") === String(itemId)) resetProxyMarketEditor();
    await refreshProxyMarketItemsAfterWrite("proxyMarketMsg", `${item.sku || item.id} 已归档`);
  } finally {
    button.disabled = false;
  }
}

async function revokeProxyMarketAllocation(allocationId, button) {
  const allocation = adminState.proxyMarketAllocationRows.find((item) => String(item.id || "") === String(allocationId || ""));
  if (!allocation) return;
  const boundCount = Number(allocation.bound_account_count || 0);
  const taskCount = Number(allocation.running_task_count || 0);
  const impact = boundCount || taskCount
    ? `\n\n此操作会停止 ${taskCount} 个运行任务，并解除 ${boundCount} 个账号绑定。`
    : "";
  if (!confirm(`确认回收客户 ${allocation.username || allocation.user_id || "-"} 的 ${allocation.sku || allocation.item_id || "代理"} 吗？${impact}`)) return;
  button.disabled = true;
  try {
    await api(`/api/admin/proxy-market/allocations/${encodeURIComponent(allocationId)}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm_impact: true }),
    });
    await Promise.all([loadProxyMarketAllocations(), loadProxyMarketItems()]);
    setMsg("proxyMarketAllocationMsg", "代理分配已回收", true);
  } finally {
    button.disabled = false;
  }
}

async function saveProxyMarketSettings() {
  const claimLimit = Math.round(Number(el("proxyMarketDefaultClaimLimit")?.value));
  const healthHours = Number(el("proxyMarketHealthMaxAgeHours")?.value);
  if (!Number.isFinite(claimLimit) || claimLimit < 0 || claimLimit > 100) throw new Error("默认领取上限需在 0-100 之间");
  if (!Number.isFinite(healthHours) || healthHours < (5 / 60) || healthHours > 168) throw new Error("健康有效时长需在 5 分钟至 168 小时之间");
  const payload = {
    default_claim_limit: claimLimit,
    health_max_age_seconds: Math.max(300, Math.min(604800, Math.round(healthHours * 3600))),
  };
  const result = await api("/api/admin/proxy-market/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  renderProxyMarketSettings(result || {});
  await loadProxyMarketItems();
  setMsg("proxyMarketSettingsMsg", "代理商城领取与健康策略已保存", true);
  return result;
}

async function saveProxyMarketUserLimit() {
  const userId = Math.round(Number(el("proxyMarketLimitUserId")?.value || 0));
  const rawLimit = String(el("proxyMarketUserClaimLimit")?.value || "").trim();
  const claimLimit = rawLimit === "" ? null : Math.round(Number(rawLimit));
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("请输入有效的客户 ID");
  if (claimLimit !== null && (!Number.isInteger(claimLimit) || claimLimit < 0 || claimLimit > 100)) {
    throw new Error("客户单独上限需在 0-100 之间，留空可恢复默认");
  }
  const result = await api(`/api/admin/users/${encodeURIComponent(userId)}/proxy-market-limit`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim_limit_override: claimLimit }),
  });
  setMsg(
    "proxyMarketUserLimitMsg",
    claimLimit === null
      ? `客户 ${userId} 已恢复默认额度，当前上限 ${Number(result?.claim_limit || 0)}`
      : `客户 ${userId} 的领取上限已设为 ${Number(result?.claim_limit || claimLimit)}`,
    true,
  );
  return result;
}

function renderTaxonomyList(containerId, items, kind) {
  const container = el(containerId);
  if (!container) return;
  container.replaceChildren();
  if (!items.length) {
    container.appendChild(createEmptyState(kind === "group" ? "尚未创建客户分组" : "尚未创建客户标签"));
    return;
  }
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = `admin-taxonomy-item${kind === "tag" ? " is-tag" : ""}`;
    const name = document.createElement("input");
    name.value = String(item.name || "");
    name.maxLength = 80;
    row.appendChild(name);
    if (kind === "group") {
      const description = document.createElement("input");
      description.value = String(item.description || "");
      description.maxLength = 500;
      row.appendChild(description);
    }
    const color = document.createElement("select");
    ["neutral", "blue", "green", "amber", "red"].forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = ({ neutral: "中性", blue: "蓝色", green: "绿色", amber: "橙色", red: "红色" })[value];
      option.selected = String(item.color || "neutral") === value;
      color.appendChild(option);
    });
    const count = document.createElement("span");
    count.className = "admin-taxonomy-count";
    count.textContent = `${Number(item.member_count || 0)} 位客户`;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ghost";
    save.textContent = "保存";
    save.dataset.taxonomySave = String(item.id || "");
    save.dataset.taxonomyKind = kind;
    row.append(color, count, save);
    container.appendChild(row);
  });
}

async function loadTaxonomyWorkspace() {
  if (adminState.taxonomyLoadingPromise) return adminState.taxonomyLoadingPromise;
  const request = Promise.all([api("/api/admin/customer-groups"), api("/api/admin/tags")])
    .then(([groups, tags]) => {
      adminState.customerGroupRows = groups?.items || [];
      adminState.customerTagRows = tags?.items || [];
      renderTaxonomyList("customerGroupList", adminState.customerGroupRows, "group");
      renderTaxonomyList("customerTagList", adminState.customerTagRows, "tag");
      const groupSelect = el("adminUserBatchGroup");
      if (groupSelect) {
        const selected = groupSelect.value;
        groupSelect.replaceChildren(new Option("选择客户分组", ""));
        adminState.customerGroupRows.forEach((item) => groupSelect.add(new Option(String(item.name || item.id), String(item.id))));
        groupSelect.value = selected;
      }
      const tagSelect = el("adminUserBatchTags");
      if (tagSelect) {
        const selected = new Set(Array.from(tagSelect.selectedOptions, (option) => option.value));
        tagSelect.replaceChildren();
        adminState.customerTagRows.forEach((item) => {
          const option = new Option(String(item.name || item.id), String(item.id));
          option.selected = selected.has(option.value);
          tagSelect.add(option);
        });
      }
      setMsg("taxonomyMsg", "");
      return { groups, tags };
    })
    .catch((error) => {
      setMsg("taxonomyMsg", `客户治理数据读取失败：${getErrorMessage(error)}`, false);
      return null;
    })
    .finally(() => {
      if (adminState.taxonomyLoadingPromise === request) adminState.taxonomyLoadingPromise = null;
    });
  adminState.taxonomyLoadingPromise = request;
  return request;
}

async function createTaxonomyItem(kind) {
  const isGroup = kind === "group";
  const payload = {
    name: el(isGroup ? "customerGroupName" : "customerTagName")?.value?.trim() || "",
    color: el(isGroup ? "customerGroupColor" : "customerTagColor")?.value || "neutral",
  };
  if (isGroup) payload.description = el("customerGroupDescription")?.value?.trim() || "";
  if (!payload.name) throw new Error("名称不能为空");
  await api(isGroup ? "/api/admin/customer-groups" : "/api/admin/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  el(isGroup ? "customerGroupForm" : "customerTagForm")?.reset();
  await loadTaxonomyWorkspace();
}

async function saveTaxonomyItem(button) {
  const kind = button.dataset.taxonomyKind;
  const row = button.closest(".admin-taxonomy-item");
  const controls = row ? Array.from(row.querySelectorAll("input, select")) : [];
  const payload = kind === "group"
    ? { name: controls[0]?.value?.trim() || "", description: controls[1]?.value?.trim() || "", color: controls[2]?.value || "neutral" }
    : { name: controls[0]?.value?.trim() || "", color: controls[1]?.value || "neutral" };
  if (!payload.name) return setMsg("taxonomyMsg", "名称不能为空", false);
  button.disabled = true;
  try {
    const base = kind === "group" ? "/api/admin/customer-groups" : "/api/admin/tags";
    await api(`${base}/${encodeURIComponent(button.dataset.taxonomySave || "")}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await loadTaxonomyWorkspace();
    setMsg("taxonomyMsg", "客户治理词表已更新", true);
  } catch (error) {
    setMsg("taxonomyMsg", getErrorMessage(error), false);
  } finally {
    button.disabled = false;
  }
}

function renderMfaStatus(status = {}) {
  adminState.mfaStatus = status;
  const banner = el("adminMfaBanner");
  if (!banner) return;
  const needsSetup = Boolean(status.required && !status.enabled);
  banner.hidden = !needsSetup;
  if (needsSetup) {
    const deadline = Number(status.required_after || 0);
    setText(
      "adminMfaBannerText",
      status.setup_pending
        ? "动态验证设置尚未完成，请重新生成密钥并验证。"
        : (deadline && deadline > Math.floor(Date.now() / 1000)
          ? `请在 ${formatTime(deadline)} 前完成登记，敏感操作将使用动态验证码。`
          : "敏感操作需要管理员密码和动态验证码，请立即完成 MFA 登记。"),
    );
  }
}

async function loadMfaStatus() {
  try {
    const status = await api("/api/auth/mfa");
    renderMfaStatus(status || {});
    return status;
  } catch (error) {
    setMsg("adminMfaMsg", `MFA 状态读取失败：${getErrorMessage(error)}`, false);
    return null;
  }
}

function setMfaModalOpen(open) {
  const modal = el("adminMfaModal");
  if (!modal) return;
  modal.style.display = open ? "grid" : "none";
  modal.setAttribute("aria-hidden", open ? "false" : "true");
  if (open) {
    setMsg("adminMfaMsg", "");
    window.setTimeout(() => (adminState.mfaSetup ? el("adminMfaVerifyCode") : el("btnStartMfaSetup"))?.focus(), 0);
  } else {
    adminState.mfaSetup = null;
    if (el("adminMfaSecret")) el("adminMfaSecret").value = "";
    if (el("adminMfaUri")) el("adminMfaUri").value = "";
    if (el("adminMfaRecoveryCodes")) el("adminMfaRecoveryCodes").textContent = "";
    if (el("adminMfaVerifyCode")) el("adminMfaVerifyCode").value = "";
    if (el("adminMfaSetupDetails")) el("adminMfaSetupDetails").hidden = true;
    if (el("adminMfaIntro")) el("adminMfaIntro").hidden = false;
    if (el("btnCopyMfaSetup")) el("btnCopyMfaSetup").hidden = true;
    if (el("btnVerifyMfaSetup")) el("btnVerifyMfaSetup").hidden = true;
  }
}

async function startMfaSetup() {
  const button = el("btnStartMfaSetup");
  if (button) button.disabled = true;
  try {
    const currentPassword = String(el("adminMfaCurrentPassword")?.value || "");
    if (!currentPassword) throw new Error("请输入管理员当前密码");
    const setup = await api("/api/auth/mfa/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: currentPassword }),
    });
    el("adminMfaCurrentPassword").value = "";
    adminState.mfaSetup = setup || {};
    el("adminMfaSecret").value = String(setup.secret || "");
    el("adminMfaUri").value = String(setup.otpauth_uri || "");
    el("adminMfaRecoveryCodes").textContent = (setup.recovery_codes || []).join("\n");
    el("adminMfaIntro").hidden = true;
    el("adminMfaSetupDetails").hidden = false;
    el("btnCopyMfaSetup").hidden = false;
    el("btnVerifyMfaSetup").hidden = false;
    setMsg("adminMfaMsg", "密钥已生成。请先保存恢复码，再输入身份验证器中的动态验证码。", true);
    el("adminMfaVerifyCode")?.focus();
  } catch (error) {
    setMsg("adminMfaMsg", getErrorMessage(error), false);
  } finally {
    if (button) button.disabled = false;
  }
}

async function verifyMfaSetup() {
  const code = String(el("adminMfaVerifyCode")?.value || "").trim();
  if (code.length < 6) {
    setMsg("adminMfaMsg", "请输入身份验证器中的动态验证码。", false);
    return el("adminMfaVerifyCode")?.focus();
  }
  const button = el("btnVerifyMfaSetup");
  if (button) button.disabled = true;
  try {
    await api("/api/auth/mfa/verify-setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    await loadMfaStatus();
    setMsg("adminMfaMsg", "动态验证已启用。", true);
    window.setTimeout(() => setMfaModalOpen(false), 700);
  } catch (error) {
    setMsg("adminMfaMsg", getErrorMessage(error), false);
  } finally {
    if (button) button.disabled = false;
  }
}

async function copyMfaSetup() {
  const setup = adminState.mfaSetup || {};
  const text = [
    `设置密钥：${setup.secret || ""}`,
    `URI：${setup.otpauth_uri || ""}`,
    "恢复码：",
    ...(setup.recovery_codes || []),
  ].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    setMsg("adminMfaMsg", "设置资料已复制。", true);
  } catch {
    setMsg("adminMfaMsg", "复制失败，请手动保存密钥和恢复码。", false);
  }
}

async function createUser() {
  const isAdmin = adminState.userListRole === "admin";
  const payload = {
    username: el("newUserName").value.trim(),
    password: el("newUserPassword").value,
    is_admin: isAdmin,
    balance_cents: isAdmin ? 0 : Number(el("newUserBalance").value || 0),
  };
  if (!payload.username) throw new Error(`${isAdmin ? "管理员" : "客户"}用户名不能为空`);
  const minimumPasswordLength = payload.is_admin ? 12 : 8;
  if (!payload.password || payload.password.length < minimumPasswordLength) {
    throw new Error(`密码至少 ${minimumPasswordLength} 位`);
  }
  if (payload.is_admin) {
    const stepUp = readAdminStepUp({
      adminPasswordId: "adminCreateAdminPassword",
      totpCodeId: "adminCreateTotpCode",
      reasonId: "adminCreateReason",
      messageTarget: "userMsg",
    });
    if (!stepUp) return false;
    Object.assign(payload, stepUp);
  }
  await api("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  el("newUserName").value = "";
  el("newUserPassword").value = "";
  el("newUserBalance").value = "0";
  clearAdminCreateStepUp();
  return true;
}

function clearAdminCreateStepUp() {
  ["adminCreateAdminPassword", "adminCreateTotpCode", "adminCreateReason"].forEach((id) => {
    if (el(id)) el(id).value = "";
  });
}

async function runTaskAction(act, id) {
  if (act === "detail") {
    const data = await api(`/api/tasks/${id}`);
    openTaskInspectModal({
      title: "生成详情",
      subtitle: `${data.workflow_name || data.type || "任务"} · ${data.id || id}`,
      html: buildTaskDetailHtml(data),
      rawText: buildTaskDetailText(data),
    });
    return true;
  }
  if (act === "logs") {
    const data = await api(`/api/admin/tasks/${id}/logs?limit=500`);
    openTaskInspectModal({
      title: "处理记录",
      subtitle: `${(data.task && (data.task.workflow_name || data.task.type)) || "任务"} · ${id}`,
      html: buildTaskLogsHtml(data),
      rawText: buildTaskLogsText(data),
    });
    return true;
  }
  if (act === "export_logs") {
    window.open(`/api/admin/tasks/${id}/logs/export`, "_blank");
    return true;
  }
  if (act === "download") {
    window.open(`/api/tasks/${id}/download`, "_blank");
    return true;
  }
  if (act === "analyze_error") {
    setMsg("taskMsg", "");
    try {
      await api(`/api/admin/tasks/${id}/analyze_error`, { method: "POST" });
      const data = await api(`/api/tasks/${id}`);
      openTaskInspectModal({
        title: "生成详情",
        subtitle: `${data.workflow_name || data.type || "任务"} · ${data.id || id}`,
        html: buildTaskDetailHtml(data),
        rawText: buildTaskLogsText({ task: data, items: data.logs || [] }),
      });
      setMsg("taskMsg", "错误分析已生成", true);
      await loadTasks();
    } catch (err) {
      setMsg("taskMsg", err.detail || err.message || String(err), false);
    }
    return true;
  }
  if (act === "retry") {
    setMsg("taskMsg", "");
    try {
      const resp = await api(`/api/tasks/${id}/retry`, { method: "POST" });
      setMsg("taskMsg", `已创建重试记录，新生成编号：${resp.id}`, true);
      await loadTasks();
    } catch (err) {
      setMsg("taskMsg", err.detail || err.message || String(err), false);
    }
    return true;
  }
  if (act === "retry_resume") {
    setMsg("taskMsg", "");
    try {
      const resp = await api(`/api/tasks/${id}/retry_resume`, { method: "POST" });
      setMsg("taskMsg", `已创建断点重试记录，新生成编号：${resp.id}`, true);
      await loadTasks();
    } catch (err) {
      setMsg("taskMsg", err.detail || err.message || String(err), false);
    }
    return true;
  }
  if (act === "delete_task") {
    if (!confirm(`确认删除生成记录 ${id} 吗？`)) return true;
    await api(`/api/admin/tasks/${id}`, { method: "DELETE" });
    await loadTasks();
    return true;
  }
  return false;
}

function syncRechargeUnlimitedMode() {
  const target = adminState.rechargeTarget || {};
  const unlimited = Boolean(el("rechargeUnlimited")?.checked);
  const amount = el("rechargeAmount");
  if (!amount) return;
  amount.disabled = unlimited;
  amount.min = target.unlimited ? "0" : "1";
  amount.placeholder = unlimited ? "无限模式无需填写" : (target.unlimited ? "填 0 仅关闭无限" : "输入增加点数");
  if (unlimited) amount.value = "";
}

function openRechargeModal(id, name, unlimited = false) {
  adminState.rechargeTarget = {
    id: String(id || ""),
    name: String(name || id || ""),
    unlimited: normalizeBillingUnlimited(unlimited),
  };
  if (el("rechargeSub")) el("rechargeSub").textContent = `客户：${adminState.rechargeTarget.name} · 此入口为人工算力调整`;
  if (el("rechargeUnlimited")) el("rechargeUnlimited").checked = adminState.rechargeTarget.unlimited;
  if (el("rechargeAmount")) el("rechargeAmount").value = adminState.rechargeTarget.unlimited ? "0" : "1000";
  if (el("rechargeNote")) el("rechargeNote").value = "人工算力调整";
  syncRechargeUnlimitedMode();
  setMsg("rechargeMsg", "");
  const modal = el("rechargeModal");
  if (modal) {
    modal.style.display = "grid";
    modal.setAttribute("aria-hidden", "false");
  }
}

function closeRechargeModal() {
  const modal = el("rechargeModal");
  if (modal) {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }
  adminState.rechargeTarget = null;
}

async function submitRecharge() {
  const target = adminState.rechargeTarget;
  if (!target || !target.id) return;
  const amount = Number(el("rechargeAmount").value || 0);
  const unlimited = Boolean(el("rechargeUnlimited")?.checked);
  const note = String(el("rechargeNote").value || "").trim();
  if (!unlimited && (!Number.isInteger(amount) || amount < (target.unlimited ? 0 : 1))) {
    setMsg("rechargeMsg", target.unlimited ? "算力点必须为 0 或正整数" : "算力点必须为正整数", false);
    return;
  }
  const rechargePayload = { amount_cents: unlimited ? 0 : amount, note };
  if (unlimited) rechargePayload.unlimited = true;
  else if (target.unlimited) rechargePayload.unlimited = false;
  const response = await api(`/api/admin/users/${target.id}/recharge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rechargePayload),
  });
  const responseUnlimited = Object.prototype.hasOwnProperty.call(response || {}, "unlimited_compute")
    ? normalizeBillingUnlimited(response.unlimited_compute)
    : (Object.prototype.hasOwnProperty.call(response || {}, "unlimited")
      ? normalizeBillingUnlimited(response.unlimited)
      : unlimited);
  adminState.billingUnlimitedUsers.set(String(target.id), responseUnlimited);
  const walletPoints = Number(response.points);
  if (Number.isFinite(walletPoints)) {
    adminState.billingWalletPoints.set(String(target.id), walletPoints);
  }
  setMsg(
    "rechargeMsg",
    responseUnlimited
      ? "人工算力调整已完成，当前账户：无限算力"
      : Number.isFinite(walletPoints)
      ? `人工算力调整已完成，当前钱包点数：${formatBillingPoints(walletPoints)} 算力点`
      : "人工算力调整已完成",
    true,
  );
  try {
    await loadUsers();
  } catch (err) {
    setMsg("userMsg", `算力点已调整，但账号列表刷新失败：${getErrorMessage(err)}`, false);
  }
}

function bindBillingActions() {
  el("btnRefreshBilling")?.addEventListener("click", async () => {
    setMsg("billingWorkspaceMsg", "");
    await ensureBillingLoaded(true);
  });
  el("btnReloadBillingCatalog")?.addEventListener("click", async () => {
    try {
      await loadBillingCatalog();
    } catch (err) {
      setMsg("billingCatalogMsg", getErrorMessage(err), false);
    }
  });
  el("btnUseActiveCatalog")?.addEventListener("click", () => {
    if (!adminState.billingActiveCatalog) {
      setMsg("billingCatalogMsg", "当前没有可载入的已发布目录", false);
      return;
    }
    useBillingCatalog(adminState.billingActiveCatalog);
  });
  el("billingCatalogDraftForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMsg("billingCatalogMsg", "");
    try {
      await createBillingCatalogDraft();
    } catch (err) {
      setMsg("billingCatalogMsg", getErrorMessage(err), false);
    }
  });
  el("billingCatalogBody")?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-billing-action]");
    if (!button) return;
    event.stopPropagation();
    const action = button.dataset.billingAction;
    try {
      if (action === "catalog-inspect") {
        const version = adminState.billingCatalogVersions[Number(button.dataset.versionIndex || -1)];
        if (version) useBillingCatalog(version);
      } else if (action === "catalog-publish") {
        await publishBillingCatalog(button.dataset.id);
      }
    } catch (err) {
      setMsg("billingCatalogMsg", getErrorMessage(err), false);
    }
  });

  el("btnReloadBillingOrders")?.addEventListener("click", async () => {
    try {
      await loadBillingOrders();
    } catch (err) {
      setMsg("billingOrderMsg", getErrorMessage(err), false);
    }
  });
  el("btnLoadMoreBillingOrders")?.addEventListener("click", async () => {
    try {
      await loadBillingOrders({ append: true });
    } catch (err) {
      setMsg("billingOrderMsg", getErrorMessage(err), false);
    }
  });
  el("billingOrderStatus")?.addEventListener("change", async () => {
    try {
      await loadBillingOrders();
    } catch (err) {
      setMsg("billingOrderMsg", getErrorMessage(err), false);
    }
  });
  el("billingOrderBody")?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-billing-action]");
    if (!button) return;
    event.stopPropagation();
    const status = button.dataset.billingAction === "order-approve" ? "approved" : "rejected";
    setMsg("billingOrderMsg", "");
    try {
      await reviewBillingOrder(button.dataset.id, status);
    } catch (err) {
      setMsg("billingOrderMsg", getErrorMessage(err), false);
    }
  });

  el("billingUserLookupForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMsg("billingUserMsg", "");
    try {
      await loadUserBilling();
    } catch (err) {
      setMsg("billingUserMsg", getErrorMessage(err), false);
    }
  });
  el("billingAdjustmentForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMsg("billingUserMsg", "");
    try {
      await submitBillingAdjustment();
    } catch (err) {
      setMsg("billingUserMsg", getErrorMessage(err), false);
    }
  });
  el("billingAdjustmentType")?.addEventListener("change", syncBillingAdjustmentType);
  el("billingAdjustmentUnlimited")?.addEventListener("change", syncBillingAdjustmentType);
}

function bindActions() {
  bindBillingActions();
  bindModelTabs();
  bindTextModelContentTabs();
  bindRunningHubSlotTabs();
  el("btnRefreshGovernance")?.addEventListener("click", () => void loadGovernanceDashboard({ force: true }));
  el("governanceRange")?.addEventListener("change", () => { syncGovernanceRangeControls(); void loadGovernanceDashboard({ force: true }); });
  el("governanceStartDate")?.addEventListener("change", () => void loadGovernanceDashboard({ force: true }));
  el("governanceEndDate")?.addEventListener("change", () => void loadGovernanceDashboard({ force: true }));
  syncGovernanceRangeControls();
  el("btnRefreshAudit")?.addEventListener("click", () => void loadAuditEvents());
  el("btnExportAudit")?.addEventListener("click", () => void exportAuditEvents());
  el("auditFilterForm")?.addEventListener("submit", (event) => { event.preventDefault(); void loadAuditEvents(); });
  el("btnRefreshSecurity")?.addEventListener("click", () => void loadSecurityAlerts());
  el("securityFilterForm")?.addEventListener("change", () => void loadSecurityAlerts());
  el("btnRefreshServiceAccounts")?.addEventListener("click", () => void loadServiceAccounts());
  setDefaultServiceAccountExpiry();
  el("serviceAccountForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await createServiceAccount(); } catch (error) { setMsg("serviceAccountMsg", getErrorMessage(error), false); }
  });
  el("btnCopyServiceCredential")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(el("serviceCredentialValue")?.value || "");
      setMsg("serviceAccountMsg", "一次性凭证已复制", true);
    } catch { setMsg("serviceAccountMsg", "复制失败，请手动复制已选中的凭证", false); }
  });
  el("btnHideServiceCredential")?.addEventListener("click", () => {
    clearServiceCredential();
  });
  el("btnRefreshProxyMarket")?.addEventListener("click", async () => {
    setMsg("proxyMarketMsg", "正在刷新代理商城...");
    await loadProxyMarketWorkspace();
  });
  el("proxyMarketFilterForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await loadProxyMarketItems();
    } catch {}
  });
  el("btnResetProxyMarketFilters")?.addEventListener("click", async () => {
    ["proxyMarketQuery", "proxyMarketStatusFilter", "proxyMarketHealthFilter"].forEach((id) => {
      if (el(id)) el(id).value = "";
    });
    try {
      await loadProxyMarketItems();
    } catch {}
  });
  el("btnNewProxyMarketItem")?.addEventListener("click", () => resetProxyMarketEditor({ focus: true }));
  el("btnCancelProxyMarketEdit")?.addEventListener("click", () => resetProxyMarketEditor({ focus: true }));
  el("proxyMarketItemForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveProxyMarketItem();
    } catch (error) {
      setMsg("proxyMarketItemMsg", getErrorMessage(error), false);
    }
  });
  el("btnPublishProxyMarketItem")?.addEventListener("click", async () => {
    try {
      await saveProxyMarketItem({ publish: true });
    } catch (error) {
      const prefix = error?.proxyMarketDraftSaved
        ? "草稿已保存并保留在编辑器中；检测发布失败"
        : error?.proxyMarketChangesSaved
          ? "库存修改已保存；检测发布失败"
          : "检测发布失败";
      setMsg("proxyMarketItemMsg", `${prefix}：${getErrorMessage(error)}`, false);
    }
  });
  el("proxyMarketItemBody")?.addEventListener("click", async (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-proxy-market-action]") : null;
    if (!(button instanceof HTMLButtonElement)) return;
    const itemId = button.dataset.id || "";
    try {
      if (button.dataset.proxyMarketAction === "edit") editProxyMarketItem(itemId);
      if (button.dataset.proxyMarketAction === "publish") await publishProxyMarketRow(itemId, button);
      if (button.dataset.proxyMarketAction === "archive") await archiveProxyMarketItem(itemId, button);
    } catch (error) {
      setMsg("proxyMarketMsg", getErrorMessage(error), false);
    }
  });
  el("proxyMarketItemBody")?.addEventListener("change", async (event) => {
    const control = event.target;
    if (!(control instanceof HTMLSelectElement) || !control.dataset.proxyMarketStatus) return;
    try {
      await updateProxyMarketStatus(control.dataset.proxyMarketStatus, control.value, control);
    } catch (error) {
      setMsg("proxyMarketMsg", getErrorMessage(error), false);
    }
  });
  el("proxyMarketAllocationStatus")?.addEventListener("change", async () => {
    try {
      await loadProxyMarketAllocations();
    } catch {}
  });
  el("proxyMarketAllocationBody")?.addEventListener("click", async (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-proxy-market-action='revoke']") : null;
    if (!(button instanceof HTMLButtonElement)) return;
    try {
      await revokeProxyMarketAllocation(button.dataset.id || "", button);
    } catch (error) {
      setMsg("proxyMarketAllocationMsg", getErrorMessage(error), false);
    }
  });
  el("proxyMarketSettingsForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMsg("proxyMarketSettingsMsg", "正在保存商城策略...");
    try {
      await saveProxyMarketSettings();
    } catch (error) {
      setMsg("proxyMarketSettingsMsg", getErrorMessage(error), false);
    }
  });
  el("proxyMarketUserLimitForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMsg("proxyMarketUserLimitMsg", "正在保存客户领取额度...");
    try {
      await saveProxyMarketUserLimit();
    } catch (error) {
      setMsg("proxyMarketUserLimitMsg", getErrorMessage(error), false);
    }
  });
  resetProxyMarketEditor();
  el("btnRefreshTaxonomy")?.addEventListener("click", () => void loadTaxonomyWorkspace());
  el("customerGroupForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await createTaxonomyItem("group"); setMsg("taxonomyMsg", "客户分组已创建", true); } catch (error) { setMsg("taxonomyMsg", getErrorMessage(error), false); }
  });
  el("customerTagForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await createTaxonomyItem("tag"); setMsg("taxonomyMsg", "客户标签已创建", true); } catch (error) { setMsg("taxonomyMsg", getErrorMessage(error), false); }
  });
  el("btnRefreshUserSessions")?.addEventListener("click", () => void loadSelectedUserSessions());
  el("btnRevokeUserSessions")?.addEventListener("click", () => void revokeSelectedUserSessions());
  el("btnRefreshPasswordHistory")?.addEventListener("click", () => void loadSelectedPasswordHistory());
  el("btnLoadUserPurgePreview")?.addEventListener("click", async () => {
    try { await loadSelectedUserPurgePreview(); } catch (error) { setMsg("userDetailMsg", getErrorMessage(error), false); }
  });
  el("userPurgeForm")?.addEventListener("submit", async (event) => {
    try { await purgeSelectedUser(event); } catch (error) { event.preventDefault(); setMsg("userDetailMsg", getErrorMessage(error), false); }
  });
  el("btnOpenMfaSetup")?.addEventListener("click", () => setMfaModalOpen(true));
  el("btnCloseMfaSetup")?.addEventListener("click", () => setMfaModalOpen(false));
  el("btnStartMfaSetup")?.addEventListener("click", () => void startMfaSetup());
  el("btnVerifyMfaSetup")?.addEventListener("click", () => void verifyMfaSetup());
  el("btnCopyMfaSetup")?.addEventListener("click", () => void copyMfaSetup());
  el("adminMfaVerifyCode")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void verifyMfaSetup(); }
  });
  el("adminMfaModal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) setMfaModalOpen(false);
  });
  el("btnAdminLogout")?.addEventListener("click", logoutAdmin);
  el("btnSaveRuntime").addEventListener("click", async () => {
    setMsg("runtimeMsg", "");
    try {
      await saveRuntime();
      setMsg("runtimeMsg", "运行配置已保存，并已按本地配置文件内容回填表单", true);
    } catch (err) {
      setMsg("runtimeMsg", formatRuntimeConfigError("保存", err), false);
    }
  });

  [
    ["btnAddLlmGptModel", "rtLlmGptModelInput", "llmGptModels"],
  ].forEach(([buttonId, inputId, listKey]) => {
    if (el(buttonId)) {
      el(buttonId).addEventListener("click", () => addModelFromInput(listKey, inputId));
    }
    if (el(inputId)) {
      el(inputId).addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          addModelFromInput(listKey, inputId);
        }
      });
    }
  });

  if (el("btnBrowseLlmGrokModels")) {
    el("btnBrowseLlmGrokModels").addEventListener("click", toggleAvailableLlmModels);
  }
  if (el("rtLlmGrokModelPicker")) {
    el("rtLlmGrokModelPicker").addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const model = target.dataset.llmModel || "";
      if (model) addLlmModelFromPicker(model);
    });
    bindModelPickerFilters("rtLlmGrokModelPicker");
  }
  if (el("btnBrowseImageGeminiModels")) {
    el("btnBrowseImageGeminiModels").addEventListener("click", toggleAvailableImageModels);
  }
  if (el("rtImageGeminiModelPicker")) {
    el("rtImageGeminiModelPicker").addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const model = target.dataset.imageModel || "";
      if (model) addImageModelFromPicker(model);
    });
    bindModelPickerFilters("rtImageGeminiModelPicker");
  }
  if (el("btnBrowseVideoModels")) {
    el("btnBrowseVideoModels").addEventListener("click", toggleAvailableVideoModels);
  }
  bindRunningHubPresetSelect("persona");
  bindRunningHubPresetSelect("tweet");
  if (el("btnCheckRunningHubKey")) {
    el("btnCheckRunningHubKey").addEventListener("click", checkRunningHubKey);
  }
  Object.entries(MODEL_PROVIDER_KEY_CHECKS).forEach(([type, config]) => {
    el(config.buttonId)?.addEventListener("click", () => checkModelProviderKey(type));
  });
  document.querySelectorAll("[data-secret-target]").forEach((button) => {
    button.addEventListener("click", () => {
      toggleSensitiveInput(button);
    });
  });
  if (el("btnApplyVideoModel")) {
    el("btnApplyVideoModel").addEventListener("click", () => applyVideoModel(el("rtMuleRouterWanI2vModelName")?.value));
  }
  if (el("rtVideoModelPicker")) {
    el("rtVideoModelPicker").addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const model = target.dataset.videoModel || "";
      if (model) applyVideoModel(model);
    });
    bindModelPickerFilters("rtVideoModelPicker");
  }

  [
    ["btnAddLlmPriorityModel", "llmPriorityModels"],
  ].forEach(([buttonId, listKey]) => {
    if (el(buttonId)) {
      el(buttonId).addEventListener("click", (event) => {
        event.stopPropagation();
        openLlmPriorityModelPicker(listKey);
      });
    }
  });

  if (el("btnAddImagePriorityModel")) {
    el("btnAddImagePriorityModel").addEventListener("click", (event) => {
      event.stopPropagation();
      openImagePriorityModelPicker();
    });
  }

  el("btnSavePricing").addEventListener("click", async () => {
    setMsg("pricingMsg", "");
    try {
      await savePricing();
      setMsg("pricingMsg", "计费参数已保存", true);
    } catch (err) {
      setMsg("pricingMsg", err.detail || String(err), false);
    }
  });

  el("btnCreateUser").addEventListener("click", async () => {
    setMsg("userMsg", "");
    try {
      const created = await createUser();
      if (!created) return;
      setMsg("userMsg", `${adminState.userListRole === "admin" ? "管理员" : "客户"}账号已创建`, true);
      await loadUsers();
    } catch (err) {
      setMsg("userMsg", err.detail || err.message || String(err), false);
    }
  });

  el("adminUserFilterForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    adminState.userListFilters = readUserListFilters();
    adminState.userListPage = 1;
    clearUserBatchSelection();
    try { await loadUsers(1); } catch (error) { setMsg("userMsg", getErrorMessage(error), false); }
  });
  el("btnResetUserFilters")?.addEventListener("click", async () => {
    el("adminUserFilterForm")?.reset();
    adminState.userListFilters = {};
    adminState.userListPage = 1;
    clearUserBatchSelection();
    try { await loadUsers(1); } catch (error) { setMsg("userMsg", getErrorMessage(error), false); }
  });
  el("adminSelectAllUsers")?.addEventListener("change", (event) => {
    document.querySelectorAll("input[data-user-select]").forEach((input) => {
      const id = String(input.dataset.userSelect || "");
      if (event.currentTarget.checked) adminState.selectedUserIds.add(id);
      else adminState.selectedUserIds.delete(id);
    });
    adminState.userBatchPreview = null;
    syncUserBatchSelection();
  });
  el("userBody")?.addEventListener("change", (event) => {
    const input = event.target.closest?.("input[data-user-select]");
    if (!input) return;
    const id = String(input.dataset.userSelect || "");
    if (input.checked) adminState.selectedUserIds.add(id);
    else adminState.selectedUserIds.delete(id);
    adminState.userBatchPreview = null;
    syncUserBatchSelection();
  });
  el("adminUserBatchAction")?.addEventListener("change", async () => {
    adminState.userBatchPreview = null;
    syncUserBatchSelection();
    if (["assign_group", "add_tags"].includes(String(el("adminUserBatchAction")?.value || ""))) await loadTaxonomyWorkspace();
  });
  ["adminUserBatchReason", "adminUserBatchGroup", "adminUserBatchTags"].forEach((id) => {
    el(id)?.addEventListener("change", () => { adminState.userBatchPreview = null; syncUserBatchSelection(); });
    el(id)?.addEventListener("input", () => { adminState.userBatchPreview = null; syncUserBatchSelection(); });
  });
  el("btnClearUserSelection")?.addEventListener("click", clearUserBatchSelection);
  el("btnPreviewUserBatch")?.addEventListener("click", async () => {
    try { await previewUserBatchAction(); } catch (error) { setMsg("adminUserBatchMsg", getErrorMessage(error), false); }
  });
  el("btnRunUserBatch")?.addEventListener("click", async () => {
    try { await runUserBatchAction(); } catch (error) { setMsg("adminUserBatchMsg", getErrorMessage(error), false); }
  });

  document.querySelectorAll("[data-user-role]").forEach((button) => {
    button.addEventListener("click", async () => {
      const nextRole = button.dataset.userRole === "admin" ? "admin" : "customer";
      if (nextRole === adminState.userListRole) return;
      adminState.userListRole = nextRole;
      adminState.userListPage = 1;
      adminState.userListFilters = readUserListFilters();
      if (nextRole === "admin") adminState.userListFilters.subscription_status = "";
      clearUserBatchSelection();
      syncUserRoleView();
      setMsg("userMsg", "");
      try {
        await loadUsers(1);
      } catch (err) {
        setMsg("userMsg", getErrorMessage(err), false);
      }
    });
  });

  if (el("btnChangePassword")) {
    el("btnChangePassword").addEventListener("click", async () => {
      clearAccountMsgs();
      const oldPwd = el("accOldPassword").value || "";
      const newPwd = el("accNewPassword").value || "";
      const newPwd2 = el("accNewPassword2").value || "";
      if (!oldPwd) return setMsg("accountPasswordMsg", "请填写原密码", false);
      if (!newPwd || newPwd.length < 12) return setMsg("accountPasswordMsg", "管理员新密码至少 12 位", false);
      if (newPwd !== newPwd2) return setMsg("accountPasswordMsg", "两次输入的新密码不一致", false);
      try {
        await api("/api/auth/change_password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }),
        });
        el("accOldPassword").value = "";
        el("accNewPassword").value = "";
        el("accNewPassword2").value = "";
        setMsg("accountPasswordMsg", "密码已修改", true);
      } catch (err) {
        setMsg("accountPasswordMsg", err.detail || String(err), false);
      }
    });
  }

  if (el("btnChangeUsername")) {
    el("btnChangeUsername").addEventListener("click", async () => {
      clearAccountMsgs();
      const newUsername = (el("accNewUsername").value || "").trim();
      const pwd = el("accUsernamePassword").value || "";
      if (!newUsername) return setMsg("accountUsernameMsg", "请填写新用户名", false);
      if (newUsername.length < 3 || newUsername.length > 32) return setMsg("accountUsernameMsg", "新用户名长度需在 3-32 之间", false);
      if (!/^[a-zA-Z0-9._-]+$/.test(newUsername)) return setMsg("accountUsernameMsg", "新用户名仅支持字母/数字/.-_", false);
      if (!pwd) return setMsg("accountUsernameMsg", "请填写当前密码用于确认", false);
      try {
        await api("/api/auth/change_username", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd, new_username: newUsername }),
        });
        el("accUsernamePassword").value = "";
        el("accNewUsername").value = "";
        const me = await api("/api/me");
        el("adminName").textContent = me.username;
        if (el("accCurrentUsername")) el("accCurrentUsername").value = me.username || "";
        setMsg("accountUsernameMsg", "用户名已修改", true);
      } catch (err) {
        setMsg("accountUsernameMsg", err.detail || String(err), false);
      }
    });
  }

  if (el("btnTaskRefresh")) {
    el("btnTaskRefresh").addEventListener("click", async () => {
      try {
        setMsg("taskMsg", "");
        await loadTasks();
      } catch (err) {
        setMsg("taskMsg", err.detail || err.message || String(err), false);
      }
    });
  }

  ["taskSearch", "taskStatusFilter", "taskWorkflowFilter", "taskUserFilter"].forEach((id) => {
    const node = el(id);
    if (!node) return;
    node.addEventListener(id === "taskSearch" ? "input" : "change", () => {
      renderTasks();
    });
  });

  if (el("btnTaskFilterReset")) {
    el("btnTaskFilterReset").addEventListener("click", () => {
      if (el("taskSearch")) el("taskSearch").value = "";
      if (el("taskStatusFilter")) el("taskStatusFilter").value = "";
      if (el("taskWorkflowFilter")) el("taskWorkflowFilter").value = "";
      if (el("taskUserFilter")) el("taskUserFilter").value = "";
      renderTasks();
    });
  }

  if (el("btnSentimentCookieRefresh")) {
    el("btnSentimentCookieRefresh").addEventListener("click", async () => {
      setMsg("sentimentCookieMsg", "正在刷新舆情 Cookie 状态...");
      try {
        await loadSentimentCookieProfiles();
        setMsg("sentimentCookieMsg", "舆情 Cookie 状态已刷新。", true);
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnSentimentCookieOpenAuth")) {
    el("btnSentimentCookieOpenAuth").addEventListener("click", () => {
      try {
        openSentimentCookieAuthPage();
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnSentimentCookieDownloadHelper")) {
    el("btnSentimentCookieDownloadHelper").addEventListener("click", async () => {
      try {
        await downloadSentimentCookieHelper();
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnSentimentCookieCopyBase")) {
    el("btnSentimentCookieCopyBase").addEventListener("click", async () => {
      try {
        await copySentimentCookieHelperBase();
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnSentimentCookieCopyExtensionUrl")) {
    el("btnSentimentCookieCopyExtensionUrl").addEventListener("click", async () => {
      try {
        await copySentimentCookieExtensionUrl();
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnSentimentCookieSave")) {
    el("btnSentimentCookieSave").addEventListener("click", async () => {
      setMsg("sentimentCookieMsg", "正在保存授权 Cookie...");
      try {
        const resp = await saveSentimentCookieProfile();
        setMsg("sentimentCookieMsg", `已保存 ${Number(resp?.savedCookieCount || 0)} 个 Cookie。`, true);
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnSentimentCookieClear")) {
    el("btnSentimentCookieClear").addEventListener("click", async () => {
      setMsg("sentimentCookieMsg", "");
      try {
        const resp = await clearSentimentCookieProfile();
        if (resp) setMsg("sentimentCookieMsg", "当前平台 Cookie 已清空。", true);
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
    });
  }

  if (el("btnTaskInspectClose")) {
    el("btnTaskInspectClose").addEventListener("click", () => closeTaskInspectModal());
  }
  if (el("btnTaskInspectDone")) {
    el("btnTaskInspectDone").addEventListener("click", () => closeTaskInspectModal());
  }
  if (el("btnTaskInspectCopy")) {
    el("btnTaskInspectCopy").addEventListener("click", async () => {
      try {
        await copyTaskInspectText();
      } catch (err) {
        setMsg("taskMsg", err.message || String(err), false);
      }
    });
  }
  if (el("taskInspectModal")) {
    el("taskInspectModal").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeTaskInspectModal();
    });
  }
  if (el("btnRechargeClose")) {
    el("btnRechargeClose").addEventListener("click", () => closeRechargeModal());
  }
  if (el("btnRechargeSubmit")) {
    el("btnRechargeSubmit").addEventListener("click", async () => {
      setMsg("rechargeMsg", "");
      try {
        await submitRecharge();
      } catch (err) {
        setMsg("rechargeMsg", err.detail || err.message || String(err), false);
      }
    });
  }
  el("rechargeUnlimited")?.addEventListener("change", syncRechargeUnlimitedMode);
  if (el("rechargeModal")) {
    el("rechargeModal").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeRechargeModal();
    });
  }
  if (el("btnUserDetailClose")) {
    el("btnUserDetailClose").addEventListener("click", closeUserDetailModal);
  }
  if (el("btnManageUserWorkspace")) {
    el("btnManageUserWorkspace").addEventListener("click", () => {
      const user = adminState.selectedUser;
      if (!user?.id || user.is_admin) return;
      window.location.assign(`/admin-console.html?manage_user_id=${encodeURIComponent(user.id)}`);
    });
  }
  if (el("btnApproveUser")) {
    el("btnApproveUser").addEventListener("click", async () => {
      try {
        await reviewSelectedUser("approved");
      } catch (err) {
        setMsg("userDetailMsg", err.detail || err.message || String(err), false);
      }
    });
  }
  if (el("btnRejectUser")) {
    el("btnRejectUser").addEventListener("click", async () => {
      if (!confirm("确认拒绝该账号的使用申请吗？")) return;
      try {
        await reviewSelectedUser("rejected");
      } catch (err) {
        setMsg("userDetailMsg", err.detail || err.message || String(err), false);
      }
    });
  }
  if (el("btnResetUserPassword")) {
    el("btnResetUserPassword").addEventListener("click", async () => {
      try {
        await resetSelectedUserPassword();
      } catch (err) {
        setMsg("userDetailMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnOpenSetUserPassword")) {
    el("btnOpenSetUserPassword").addEventListener("click", () => {
      setManualUserPasswordFormOpen(el("userPasswordManualForm")?.hidden !== false);
    });
  }
  if (el("btnCancelSetUserPassword")) {
    el("btnCancelSetUserPassword").addEventListener("click", () => setManualUserPasswordFormOpen(false));
  }
  if (el("userPasswordManualForm")) {
    el("userPasswordManualForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await setSelectedUserPassword();
      } catch (err) {
        setMsg("userPasswordManualMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnRevealUserPassword")) {
    el("btnRevealUserPassword").addEventListener("click", async () => {
      try {
        await revealSelectedUserPassword();
      } catch (err) {
        clearRevealedUserPassword();
        setMsg("userDetailMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnHideUserPassword")) {
    el("btnHideUserPassword").addEventListener("click", () => {
      clearRevealedUserPassword({ message: "当前密码已隐藏并清除。", isSuccess: true });
      el("btnRevealUserPassword")?.focus();
    });
  }
  if (el("btnCopyRevealedUserPassword")) {
    el("btnCopyRevealedUserPassword").addEventListener("click", async () => {
      const passwordInput = el("userPasswordRevealValue");
      const password = String(passwordInput?.value || "");
      if (!password) return;
      try {
        await navigator.clipboard.writeText(password);
        setMsg("userDetailMsg", "当前密码已复制。", true);
      } catch {
        passwordInput?.focus();
        passwordInput?.select();
        setMsg("userDetailMsg", "复制失败，请手动复制已选中的密码。", false);
      }
    });
  }
  if (el("btnCopyUserPassword")) {
    el("btnCopyUserPassword").addEventListener("click", async () => {
      const passwordInput = el("userPasswordResultValue");
      const password = String(passwordInput?.value || "");
      if (!password) return;
      try {
        await navigator.clipboard.writeText(password);
        setMsg("userDetailMsg", "临时密码已复制。", true);
      } catch {
        passwordInput?.focus();
        passwordInput?.select();
        setMsg("userDetailMsg", "复制失败，请手动复制已选中的临时密码。", false);
      }
    });
  }
  if (el("btnUserPagePrev")) {
    el("btnUserPagePrev").addEventListener("click", async () => {
      if (adminState.userListPage <= 1) return;
      try {
        await loadUsers(adminState.userListPage - 1);
      } catch (err) {
        setMsg("userMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnUserPageNext")) {
    el("btnUserPageNext").addEventListener("click", async () => {
      const totalPages = Math.max(1, Math.ceil(adminState.userListTotal / adminState.userListPageSize));
      if (adminState.userListPage >= totalPages) return;
      try {
        await loadUsers(adminState.userListPage + 1);
      } catch (err) {
        setMsg("userMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("userDetailModal")) {
    el("userDetailModal").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeUserDetailModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (trapUserDetailFocus(e)) return;
    if (e.key === "Escape") {
      closeTaskInspectModal();
      closeRechargeModal();
      closeUserDetailModal();
      setMfaModalOpen(false);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearRevealedUserPassword();
      clearUserPasswordReset();
      clearServiceCredential();
      clearAdminCreateStepUp();
      if (!adminState.userPasswordSetInFlight) clearManualUserPassword();
      if (el("adminMfaModal")?.getAttribute("aria-hidden") === "false") setMfaModalOpen(false);
      return;
    }
    void refreshSentimentCookieProfilesIfActive();
  });
  document.addEventListener("change", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const chainKey = target.dataset ? String(target.dataset.chainType || "") : "";
    if (chainKey && WORKFLOW_CHAIN_CONTAINER_IDS[chainKey]) {
      syncWorkflowChainFromDom(chainKey);
      renderWorkflowChain(chainKey);
    }
  });

  document.querySelectorAll("[data-page]").forEach((node) => {
    node.addEventListener("click", () => {
      const changed = setActiveAdminPage(node.dataset.page || "overview");
      if (changed !== false) setAdminMobileNavOpen(false, { restoreFocus: true });
    });
  });

  document.addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    closeModelPickersOnOutsideClick(target);
    const sensitiveToggle = target.closest(".sensitive-toggle-btn");
    if (sensitiveToggle instanceof HTMLElement) {
      toggleSensitiveInput(sensitiveToggle);
      return;
    }
    const btn = target.closest("button") || target;
    if (btn.dataset?.pageJump) {
      setActiveAdminPage(btn.dataset.pageJump);
      return;
    }
    if (btn.dataset?.securitySave) {
      await saveSecurityAlert(btn);
      return;
    }
    if (btn.dataset?.serviceSave) {
      await saveServiceAccount(btn);
      return;
    }
    if (btn.dataset?.serviceRotate) {
      await rotateServiceAccount(btn);
      return;
    }
    if (btn.dataset?.taxonomySave) {
      await saveTaxonomyItem(btn);
      return;
    }
    if (btn.dataset?.passwordRestore) {
      await restoreSelectedUserPassword(btn.dataset.passwordRestore, btn);
      return;
    }
    if (btn.classList.contains("admin-model-chip-remove")) {
      const idx = Number(btn.dataset.idx || -1);
      const listName = String(btn.dataset.list || "");
      const list = adminState[listName];
      if (idx >= 0 && Array.isArray(list)) {
        const [removedModel] = list.splice(idx, 1);
        if (listName === "llmGptModels") {
          ["llmPriorityModels"].forEach((priorityKey) => {
            if (Array.isArray(adminState[priorityKey])) {
              adminState[priorityKey] = adminState[priorityKey].filter((model) => model !== removedModel);
            }
          });
          syncPriorityModelsFromCatalog("llm");
        } else if (listName === "llmPriorityModels") {
          syncPriorityModelsFromCatalog("llm");
        } else if (listName === "imageGeminiModels" || listName === "imagePriorityModels") {
          syncPriorityModelsFromCatalog("image");
        }
        writeModelDraft();
        renderAllModelLists();
      }
      return;
    }
    if (btn.dataset.priorityAction) {
      const action = String(btn.dataset.priorityAction || "");
      const listName = String(btn.dataset.priorityList || "");
      const idx = Number(btn.dataset.priorityIdx || -1);
      const list = adminState[listName];
      if (!Array.isArray(list) || idx < 0 || idx >= list.length) return;
      if (action === "up" && idx > 0) {
        const item = list[idx];
        list[idx] = list[idx - 1];
        list[idx - 1] = item;
      } else if (action === "down" && idx < list.length - 1) {
        const item = list[idx];
        list[idx] = list[idx + 1];
        list[idx + 1] = item;
      }
      if (listName === "llmPriorityModels") syncPriorityModelsFromCatalog("llm");
      if (listName === "imagePriorityModels") syncPriorityModelsFromCatalog("image");
      writeModelDraft();
      renderAllModelLists();
      return;
    }
    if (btn.dataset.workflowAction) {
      const idx = Number(btn.dataset.idx || -1);
      const chainKey = String(btn.dataset.chain || "");
      if (idx < 0 || !WORKFLOW_CHAIN_CONTAINER_IDS[chainKey]) return;
      if (btn.dataset.workflowAction === "insert") {
        insertWorkflowChainStep(chainKey, idx);
      } else if (btn.dataset.workflowAction === "remove") {
        removeWorkflowChainStep(chainKey, idx);
      }
      return;
    }
    if (!btn.dataset) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if (!act || !id) return;

    try {
      if (await runTaskAction(act, id, btn)) return;
    } catch (err) {
      setMsg("taskMsg", err.detail || err.message || String(err), false);
      return;
    }
    if (act === "recharge") {
      openRechargeModal(id, btn.dataset.name || id, btn.dataset.unlimited);
      return;
    }
    if (act === "billing_detail") {
      setActiveAdminPage("pricing", true);
      if (el("billingUserId")) el("billingUserId").value = id;
      try {
        await loadUserBilling(id);
        el("billingUserTitle")?.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (err) {
        setMsg("billingUserMsg", getErrorMessage(err), false);
      }
      return;
    }
    if (act === "user_detail") {
      try {
        await openUserDetailModal(id);
      } catch (err) {
        setMsg("userMsg", getErrorMessage(err), false);
      }
      return;
    }
    if (act === "toggle") {
      const disabled = String(btn.dataset.disabled || "0") === "1";
      try {
        await api(`/api/admin/users/${id}/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_disabled: !disabled }),
        });
        await loadUsers();
      } catch (err) {
        setMsg("userMsg", getErrorMessage(err), false);
      }
      return;
    }
    if (act === "archive_user") {
      const name = btn.dataset.name || id;
      if (!confirm(`确认软删除客户 ${name} 吗？账号身份将立即下线，但人设、推文、任务、额度流水和其他业务数据都会保留，可由管理员恢复。`)) return;
      try {
        await api(`/api/admin/users/${id}`, { method: "DELETE" });
        await loadUsers();
        await loadTasks();
      } catch (err) {
        setMsg("userMsg", getErrorMessage(err), false);
      }
      return;
    }
    if (act === "restore_user") {
      const name = btn.dataset.name || id;
      if (!confirm(`确认恢复客户 ${name} 的登录权限吗？`)) return;
      try {
        await api(`/api/admin/users/${id}/restore`, { method: "POST" });
        await loadUsers();
      } catch (err) {
        setMsg("userMsg", getErrorMessage(err), false);
      }
      return;
    }
    if (act === "sentiment_cookie_pick") {
      if (el("sentimentCookieProfile")) el("sentimentCookieProfile").value = id;
      if (el("sentimentCookieText")) el("sentimentCookieText").focus();
      setActiveAdminPage("sentimentCookies");
      return;
    }
    if (act === "sentiment_cookie_open") {
      try {
        openSentimentCookieAuthPage(id);
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
      setActiveAdminPage("sentimentCookies");
      return;
    }
    if (act === "delete_task") {
      return;
    }
  });
}







function buildLlmModelSummary() {
  const priority = grokModelItems(adminState.llmPriorityModels);
  if (priority.length) return `文字模型：${priority[0]}`;
  const model = llmModelOptions()[0] || "";
  if (model) return `文字模型：${model}`;
  return "未配置文字模型";
}

function renderModelSummaries() {
  const llmSummary = el("rtLlmModelSummary");
  if (llmSummary) llmSummary.textContent = buildLlmModelSummary();
  const imageSummary = el("rtImageModelSummary");
  if (imageSummary) {
    const priority = imageModelItems(adminState.imagePriorityModels);
    const first = priority[0] || imageModelOptions()[0] || "";
    imageSummary.textContent = first ? `图片模型：${first}` : "未配置图片模型";
  }
}

function bindTextModelContentTabs() {
  return;
}

window.addEventListener("DOMContentLoaded", async () => {
  markAdminConsoleContext();
  bindAdminMobileNavigation();
  markAdminStaticUi();
  startAdminLanguageObserver();
  bindAdminPreferenceControls();
  applyAdminLanguage(currentAdminLanguage());
  bindAdminProfileMenu();
  try {
    const me = await ensureAdmin();
    if (!me) return;
    initSensitiveInputToggles();
    initRuntimeSecretMaskInputs();
    bindActions();
    setActiveAdminPage(readAdminPageFromHash(), false);
  } catch {
    location.href = "/admin";
    return;
  }

  await Promise.allSettled([loadMfaStatus(), loadGovernanceDashboard()]);

  try {
    await loadRuntime();
    setMsg("runtimeMsg", "");
  } catch (err) {
    setMsg("runtimeMsg", formatRuntimeConfigError("读取", err), false);
  }

  try {
    await loadSentimentCookieProfiles();
    setMsg("sentimentCookieMsg", "");
  } catch (err) {
    setMsg("sentimentCookieMsg", getErrorMessage(err), false);
  }

  try {
    await loadPricing();
  } catch (err) {
    setMsg("pricingMsg", getErrorMessage(err), false);
  }

  try {
    await loadUsers();
  } catch (err) {
    setMsg("userMsg", getErrorMessage(err), false);
  }

  try {
    await loadTasks();
  } catch (err) {
    setMsg("taskMsg", getErrorMessage(err), false);
  }

  setInterval(async () => {
    try {
      const usersFocused = el("secUsers")?.contains(document.activeElement);
      const detailOpen = el("userDetailModal")?.getAttribute("aria-hidden") === "false";
      if (!usersFocused && !detailOpen) await loadUsers();
      if (!el("taskAutoRefresh") || el("taskAutoRefresh").checked) {
        await loadTasks();
      }
    } catch {
      // ignore
    }
  }, TASK_POLL_INTERVAL_MS);
  setInterval(() => {
    void refreshSentimentCookieProfilesIfActive();
  }, SENTIMENT_COOKIE_POLL_INTERVAL_MS);
  setInterval(() => {
    if (!document.hidden && adminState.activePage === "overview") void loadGovernanceDashboard({ force: true });
  }, GOVERNANCE_POLL_INTERVAL_MS);
});

window.addEventListener("hashchange", () => {
  setActiveAdminPage(readAdminPageFromHash(), false);
});
