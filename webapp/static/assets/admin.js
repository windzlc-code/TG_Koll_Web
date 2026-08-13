function el(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const node = el(id);
  if (!node) return;
  node.textContent = String(value == null ? "" : value);
}

const ADMIN_TIME_ZONE = "Asia/Shanghai";

function shanghaiDateTimeParts(value, includeTime = false) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const options = {
    timeZone: ADMIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  if (includeTime) Object.assign(options, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", options)
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function formatShanghaiDateInputValue(value) {
  const parts = shanghaiDateTimeParts(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : "";
}

function formatShanghaiDateTimeInputValue(value) {
  const parts = shanghaiDateTimeParts(value, true);
  return parts ? `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` : "";
}

const ADMIN_I18N_MARKER = "data-admin-i18n-ui";
const ADMIN_I18N_ATTRIBUTES = ["title", "aria-label", "placeholder"];
const ADMIN_I18N_SKIP_SELECTOR = [
  "[data-admin-i18n-skip]",
  "script",
  "style",
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
  "#taskInspectBody",
  "#taskInspectSub",
  "#userDetailBody",
  "#userDetailSub",
].join(", ");
const ADMIN_DYNAMIC_USER_CONTENT_SELECTOR = [
  "input",
  "textarea",
  "pre",
  "code",
  ".admin-user-account-cell > strong",
  ".admin-user-company-cell",
  ".admin-task-error",
  ".admin-user-detail-item > strong",
  "#taskInspectSub",
  "#userDetailSub",
].join(", ");
const ADMIN_DYNAMIC_UI_TEXT_PATTERN = /(?:账号|账户|用户|客户|管理员|验证|邮箱|密码|最近|绑定|记录|任务|推文|配图|图片|单任务|请求|赠送|登录|设备|异常|失败|代理|静态|住宅|机房|编辑|设置|当前|申请|关注|状态|检测|同步|打开|手动|授权|浏览|获取|处理|保存|删除|详情|查看|启用|停用|算力|配置|创建|更新|刷新|操作|流程|原因|成功|加载|消息|通知|方案|库存|发布|归档|恢复|选择|筛选|暂无|尚无|未绑|未获取|已配置|需处理)/;
const ADMIN_ZH_HANT_PHRASES = [
  ["连接与查询", "連線與查詢"],
  ["加密密钥检查", "加密金鑰檢查"],
  ["数据库", "資料庫"],
  ["未启用", "未啟用"],
  ["已启用", "已啟用"],
  ["账号", "帳號"],
  ["账户", "帳戶"],
  ["运营", "營運"],
  ["后台", "後台"],
  ["信息", "資訊"],
  ["配置", "設定"],
  ["设置", "設定"],
  ["默认", "預設"],
  ["创建", "建立"],
  ["日志", "日誌"],
  ["密钥", "金鑰"],
  ["备注", "備註"],
  ["用户", "使用者"],
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

function markAdminDynamicUiElement(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return node;
  node.setAttribute(ADMIN_I18N_MARKER, "true");
  translateAdminLanguage(node, currentAdminLanguage());
  return node;
}

function createAdminDynamicUiText(value, tagName = "span") {
  const node = document.createElement(tagName);
  node.textContent = String(value == null ? "" : value);
  return markAdminDynamicUiElement(node);
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

function shouldMarkAdminDynamicUiText(node, parent = node?.parentElement) {
  const text = String(node?.nodeValue || "").trim();
  if (!text || !parent || parent.closest(ADMIN_DYNAMIC_USER_CONTENT_SELECTOR)) return false;
  return text.length <= 120 && ADMIN_DYNAMIC_UI_TEXT_PATTERN.test(text);
}

function markAdminDynamicUi(root) {
  if (!root) return;
  markAdminStaticUi(root);
  if (root.nodeType === Node.TEXT_NODE) {
    if (shouldMarkAdminDynamicUiText(root, root.parentElement)) {
      markAdminDynamicUiElement(root.parentElement);
    }
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return shouldMarkAdminDynamicUiText(node, node.parentElement)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  while (walker.nextNode()) markAdminDynamicUiElement(walker.currentNode.parentElement);
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
          markAdminDynamicUi(node);
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
  const languageMenu = el("adminLanguageMenu");
  const languageToggle = el("adminLanguageToggle");
  const languagePanel = el("adminLanguagePanel");
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
  proxyMarket: "代理 IP",
  pricing: "套餐与客户额度",
  crm: "CRM 模块",
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

const SENSITIVE_RUNTIME_INPUT_IDS = [
  "rtLlmApiKeyGpt",
  "rtImageGeminiApiKey",
  "rtVideoRunningHubPersonalApiKey",
  "rtVideoRunningHubEnterpriseApiKey",
  "rtVideoMiniMaxApiKey",
];
const SENSITIVE_PROVIDER_INPUT_IDS = [
  "proxyProviderApiKey",
  "proxyProviderApiSecret",
  "proxyProviderWebhookSecret",
];
const PROVIDER_SECRET_MASK = "••••••••••••••••";

const RUNTIME_SECRET_API_NAMES = {
  rtLlmApiKeyGpt: "llm_api_key_gpt",
  rtImageGeminiApiKey: "image_model_provider_api_key_gemini",
  rtNewPersonaRunningHubApiKey: "new_persona_runninghub_api_key",
  rtVideoRunningHubPersonalApiKey: "runninghub_personal_api_key",
  rtVideoRunningHubEnterpriseApiKey: "runninghub_enterprise_api_key",
  rtVideoMiniMaxApiKey: "minimax_api_key",
};
const VIDEO_IMAGE_MODEL_OPTIONS = [
  "gpt image 2",
  "openai/gpt-image-2-official",
  "nano banana 2",
  "google/nano-banana-2-official",
  "nano banana pro",
  "google/nano-banana-pro-official",
];
const VIDEO_IMAGE_MODEL_DEFAULTS = ["gpt image 2", "nano banana 2", "nano banana pro"];
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

function hasSavedProviderSecret(inputId) {
  const input = el(inputId);
  return !!input
    && input.dataset.providerSecretConfigured === "true"
    && input.value === input.dataset.providerSecretMask;
}

function providerSecretInputValue(inputId) {
  const input = el(inputId);
  if (!input || hasSavedProviderSecret(inputId)) return "";
  return input.value.trim();
}

function setProviderSecretInputState(inputId, configured, labelText) {
  const input = el(inputId);
  if (!input) return;
  const isConfigured = !!configured;
  input.type = "password";
  input.value = isConfigured ? PROVIDER_SECRET_MASK : "";
  input.dataset.providerSecretConfigured = isConfigured ? "true" : "false";
  input.dataset.providerSecretMask = isConfigured ? PROVIDER_SECRET_MASK : "";
  input.classList.toggle("is-saved-runtime-secret", isConfigured);
  input.placeholder = isConfigured
    ? `已保存，输入新 ${labelText} 后替换`
    : `输入 ${labelText}${inputId === "proxyProviderWebhookSecret" ? "（可选）" : ""}`;
  const button = getSensitiveToggleButton(inputId);
  if (button) {
    updateSensitiveToggleVisual(button, false);
    button.disabled = isConfigured;
    button.title = isConfigured ? "密钥已加密保存，不回显原值" : "显示";
    button.setAttribute("aria-label", isConfigured ? "密钥已加密保存" : "显示密钥内容");
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
    void refreshSentimentCookieProfilesIfActive({ force: true });
  }
  if (nextPage === "pricing") {
    void ensureBillingLoaded();
  }
  if (nextPage === "crm") void loadCrmAdminModule();
  if (nextPage === "overview") void loadGovernanceDashboard();
  if (nextPage === "taxonomy") void loadTaxonomyWorkspace();
  if (nextPage === "audit") void loadAuditEvents();
  if (nextPage === "security") void loadSecurityAlerts();
  if (nextPage === "serviceAccounts") void loadServiceAccounts();
  if (nextPage === "proxyMarket") void loadProxyMarketWorkspace();
  if (nextPage === "runtime") {
    void loadProxyProviderCredentialStatus().catch((error) => {
      setMsg("proxyProviderCredentialMsg", `供应商凭据状态读取失败：${getErrorMessage(error)}`, false);
    });
  }
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

function renderCrmHealth(payload) {
  const node = el("crmHealthSummary");
  if (!node) return;
  const settings = payload?.settings || {};
  const checks = payload?.checks || {};
  const rows = [
    ["综合状态", payload?.status || "unknown"],
    ["环境硬开关", settings.hard_enabled ? "已启用" : "未启用"],
    ["数据库", checks.database ? "正常" : "异常"],
    ["CRM 数据结构", checks.database_schema ? "完整" : "缺表或版本异常"],
    ["CRM 静态资源", checks.static_html && checks.static_assets ? "正常" : "异常"],
    ["媒体目录", checks.media_writable ? "可写" : "不可写"],
    ["磁盘", checks.disk_ok ? `${Number(checks.disk_free_bytes || 0).toLocaleString("zh-CN")} bytes 可用` : "空间不足"],
    ["追踪签名密钥", checks.tracking_secret ? "已配置" : "未配置"],
    ["社媒 Worker", checks.worker_adapter_registered ? "已注册" : "未注册"],
    ["计费适配器", checks.billing_adapter_registered ? "已注册" : "未注册"],
    ["调度器租约", checks.scheduler_lease ? "正常" : "未持有"],
    ["全局开关", settings.enabled ? "已启用" : "未启用"],
    ["维护模式", settings.maintenance ? "开启" : "关闭"],
    ["紧急暂停", settings.emergency_pause ? "开启" : "关闭"],
    ["待人工复核动作", Number(payload?.unknown_actions || 0).toLocaleString("zh-CN")],
  ];
  node.replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement("div");
    const strong = document.createElement("strong");
    const span = document.createElement("span");
    strong.textContent = label;
    span.textContent = value;
    row.append(strong, span);
    return row;
  }));
}

async function loadCrmImportStatus(userId = el("crmImportUserId")?.value) {
  const targetId = Math.max(0, Number(userId || 0));
  const query = targetId ? `?user_id=${encodeURIComponent(targetId)}` : "";
  const payload = await api(`/api/admin/modules/crm/import-status${query}`);
  const node = el("crmImportStatus");
  if (node) node.textContent = JSON.stringify(payload?.items || [], null, 2);
  return payload;
}

async function loadCrmAdminModule() {
  try {
    const [settings, health] = await Promise.all([
      api("/api/admin/modules/crm"),
      api("/api/admin/modules/crm/health"),
    ]);
    if (el("crmGlobalEnabled")) el("crmGlobalEnabled").checked = Boolean(settings?.enabled);
    if (el("crmMaintenance")) el("crmMaintenance").checked = Boolean(settings?.maintenance);
    if (el("crmEmergencyPause")) el("crmEmergencyPause").checked = Boolean(settings?.emergency_pause);
    renderCrmHealth(health);
    setMsg("crmGlobalMsg", settings?.hard_enabled ? "CRM 策略已同步。" : "环境硬开关 CRM_ENABLED 尚未启用。", Boolean(settings?.hard_enabled));
    await loadCrmImportStatus();
  } catch (err) {
    setMsg("crmGlobalMsg", getErrorMessage(err), false);
  }
}

async function saveCrmGlobalSettings(event) {
  event.preventDefault();
  const desired = {
    enabled: Boolean(el("crmGlobalEnabled")?.checked),
    maintenance: Boolean(el("crmMaintenance")?.checked),
    emergency_pause: Boolean(el("crmEmergencyPause")?.checked),
  };
  let confirmed = false;
  if (!desired.enabled || desired.maintenance || desired.emergency_pause) {
    const decision = await requestAdminPublicAction({ title: "确认 CRM 策略暂停", message: "关闭模块、开启维护或紧急暂停会让后续 CRM 父流程按策略暂停。确认保存吗？", confirmLabel: "确认保存并暂停", tone: "danger" });
    if (!decision.confirmed) return;
    confirmed = true;
  }
  try {
    const payload = await api("/api/admin/modules/crm", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...desired, confirmed }),
    });
    setMsg("crmGlobalMsg", `CRM 策略已保存；策略暂停流程 ${Number(payload?.paused_workflows || 0)} 个。`, true);
    await loadCrmAdminModule();
  } catch (err) {
    setMsg("crmGlobalMsg", getErrorMessage(err), false);
  }
}

let crmUserAccessLoadedId = 0;
let crmUserAccessLoadedEnabled = false;

function resetCrmUserAccessEditor() {
  crmUserAccessLoadedId = 0;
  crmUserAccessLoadedEnabled = false;
  if (el("btnCrmUserAccessSave")) el("btnCrmUserAccessSave").disabled = true;
  setMsg("crmUserAccessMsg", "请先读取该客户当前授权。", true);
}

async function loadCrmUserAccess() {
  const userId = Math.max(0, Number(el("crmUserAccessId")?.value || 0));
  if (!userId) return setMsg("crmUserAccessMsg", "请填写有效客户 ID。", false);
  if (el("btnCrmUserAccessSave")) el("btnCrmUserAccessSave").disabled = true;
  try {
    const payload = await api(`/api/admin/users/${userId}/modules/crm`);
    const enabled = Boolean(payload?.user_access ?? payload?.enabled);
    crmUserAccessLoadedId = userId;
    crmUserAccessLoadedEnabled = enabled;
    if (el("crmUserAccessEnabled")) el("crmUserAccessEnabled").checked = enabled;
    if (el("btnCrmUserAccessSave")) el("btnCrmUserAccessSave").disabled = false;
    setMsg("crmUserAccessMsg", `已读取客户 ${userId}：CRM ${enabled ? "已授权" : "未授权"}。`, true);
  } catch (err) {
    crmUserAccessLoadedId = 0;
    setMsg("crmUserAccessMsg", getErrorMessage(err), false);
  }
}

async function saveCrmUserAccess(event) {
  event.preventDefault();
  const userId = Math.max(0, Number(el("crmUserAccessId")?.value || 0));
  if (!userId) return setMsg("crmUserAccessMsg", "请填写有效客户 ID。", false);
  if (userId !== crmUserAccessLoadedId) return setMsg("crmUserAccessMsg", "客户 ID 已变化，请重新读取当前授权后再保存。", false);
  const enabled = Boolean(el("crmUserAccessEnabled")?.checked);
  if (crmUserAccessLoadedEnabled && !enabled) {
    const decision = await requestAdminPublicAction({
      title: "回收 CRM 权限",
      message: `回收客户 ${userId} 的 CRM 权限后，后续父流程会按策略暂停。确认继续吗？`,
      confirmLabel: "确认回收权限",
      tone: "danger",
    });
    if (!decision.confirmed) return;
  }
  try {
    const payload = await api(`/api/admin/users/${userId}/modules/crm`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    crmUserAccessLoadedEnabled = Boolean(payload?.enabled);
    if (el("crmUserAccessEnabled")) el("crmUserAccessEnabled").checked = crmUserAccessLoadedEnabled;
    setMsg("crmUserAccessMsg", payload?.enabled ? "已授予 CRM 权限。" : "已回收 CRM 权限并暂停后续流程。", true);
  } catch (err) {
    setMsg("crmUserAccessMsg", getErrorMessage(err), false);
  }
}

async function runCrmImportDryRun(event) {
  event.preventDefault();
  const userId = Math.max(0, Number(el("crmImportUserId")?.value || 0));
  const source = String(el("crmImportSource")?.value || "").trim();
  if (!userId || !source) return setMsg("crmImportMsg", "请填写目标客户 ID 和导入源文件名。", false);
  try {
    const payload = await api("/api/admin/modules/crm/import/dry-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, source }),
    });
    if (el("crmImportBatchId")) el("crmImportBatchId").value = payload?.id || "";
    setMsg("crmImportMsg", `dry-run 完成：${payload?.id || "未返回批次 ID"}`, true);
    await loadCrmImportStatus(userId);
  } catch (err) {
    setMsg("crmImportMsg", getErrorMessage(err), false);
  }
}

async function activateCrmImport(event) {
  event.preventDefault();
  const userId = Math.max(0, Number(el("crmImportUserId")?.value || 0));
  const batchId = String(el("crmImportBatchId")?.value || "").trim();
  if (!userId || !batchId) return setMsg("crmImportMsg", "请填写目标客户 ID 和批次 ID。", false);
  let status;
  try { status = await loadCrmImportStatus(userId); } catch (err) { return setMsg("crmImportMsg", getErrorMessage(err), false); }
  const batch = (status?.items || []).find((item) => String(item?.id || "") === batchId);
  const blocking = batch?.report?.blocking_errors || [];
  if (!batch || String(batch.status || "") !== "dry_run") return setMsg("crmImportMsg", "批次不存在或不是可激活的 dry-run 状态。", false);
  if (blocking.length) return setMsg("crmImportMsg", `批次仍有 ${blocking.length} 个阻断错误，不能激活。`, false);
  const decision = await requestAdminPublicAction({ title: "激活 CRM 历史数据", message: `将批次 ${batchId} 激活到客户 ${userId}。源哈希：${String(batch.source_sha256 || "未知").slice(0, 16)}…，确认继续吗？`, confirmLabel: "确认激活", tone: "danger" });
  if (!decision.confirmed) return;
  try {
    const payload = await api("/api/admin/modules/crm/import/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, batch_id: batchId, confirmed: true }),
    });
    setMsg("crmImportMsg", `导入批次 ${payload?.id || batchId} 已激活。`, true);
    await loadCrmImportStatus(userId);
  } catch (err) {
    setMsg("crmImportMsg", getErrorMessage(err), false);
  }
}

async function dismissCrmImport() {
  const userId = Math.max(0, Number(el("crmImportUserId")?.value || 0));
  const batchId = String(el("crmImportBatchId")?.value || "").trim();
  if (!userId || !batchId) return setMsg("crmImportMsg", "请填写目标客户 ID 和批次 ID。", false);
  const decision = await requestAdminPublicAction({ title: "废弃 CRM 导入批次", message: `将清理批次 ${batchId} 尚未激活的 staging 数据，并重新计算迁移锁。确认继续吗？`, confirmLabel: "确认废弃", tone: "danger" });
  if (!decision.confirmed) return;
  try {
    await api(`/api/admin/modules/crm/import/${encodeURIComponent(batchId)}/dismiss`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId, confirmed: true }) });
    setMsg("crmImportMsg", `批次 ${batchId} 已废弃，迁移状态已重算。`, true); await loadCrmImportStatus(userId); await loadCrmAdminModule();
  } catch (err) { setMsg("crmImportMsg", getErrorMessage(err), false); }
}

function showAdminPublicPrompt({ title = "操作提示", message = "", ok = true, busy = false } = {}) {
  const modal = el("adminPublicPromptModal");
  if (!modal) return;
  setText("adminPublicPromptTitle", title);
  setMsg("adminPublicPromptMessage", message, ok);
  modal.dataset.busy = busy ? "true" : "false";
  modal.style.display = "grid";
  modal.setAttribute("aria-hidden", "false");
  [el("btnAdminPublicPromptClose"), el("btnAdminPublicPromptDone")].forEach((button) => {
    if (button) button.disabled = busy;
  });
  window.setTimeout(() => {
    (busy ? el("adminPublicPromptDialog") : el("btnAdminPublicPromptDone"))?.focus();
  }, 0);
}

function closeAdminPublicPrompt() {
  const modal = el("adminPublicPromptModal");
  if (!modal || modal.getAttribute("aria-hidden") === "true" || modal.dataset.busy === "true") return;
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
}

let adminPublicActionResolver = null;
let adminPublicActionRestoreFocus = null;

function settleAdminPublicAction(outcome) {
  const modal = el("adminPublicActionModal");
  const resolve = adminPublicActionResolver;
  const value = String(el("adminPublicActionInput")?.value || "");
  adminPublicActionResolver = null;
  if (modal) {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }
  const restoreFocus = adminPublicActionRestoreFocus;
  adminPublicActionRestoreFocus = null;
  if (restoreFocus instanceof HTMLElement && restoreFocus.isConnected) restoreFocus.focus();
  if (resolve) {
    resolve({
      confirmed: outcome === "confirm",
      cancelled: outcome === "cancel",
      dismissed: outcome !== "confirm" && outcome !== "cancel",
      value,
    });
  }
}

function requestAdminPublicAction({
  title = "确认操作",
  message = "",
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "primary",
  inputLabel = "",
  inputValue = "",
  inputPlaceholder = "",
} = {}) {
  const modal = el("adminPublicActionModal");
  if (!modal) return Promise.resolve({ confirmed: false, value: "" });
  if (adminPublicActionResolver) settleAdminPublicAction("dismiss");
  adminPublicActionRestoreFocus = document.activeElement;
  setText("adminPublicActionTitle", title);
  setText("adminPublicActionMessage", message);
  setText("btnAdminPublicActionConfirm", confirmLabel);
  setText("btnAdminPublicActionCancel", cancelLabel);
  setMsg("adminPublicActionMsg", "");
  const confirmButton = el("btnAdminPublicActionConfirm");
  if (confirmButton) confirmButton.className = tone === "danger" ? "danger" : "primary";
  const inputField = el("adminPublicActionInputField");
  const input = el("adminPublicActionInput");
  if (inputField) inputField.hidden = !inputLabel;
  setText("adminPublicActionInputLabel", inputLabel);
  if (input) {
    input.value = inputValue;
    input.placeholder = inputPlaceholder;
  }
  modal.style.display = "grid";
  modal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => {
    (inputLabel ? input : confirmButton)?.focus();
  }, 0);
  return new Promise((resolve) => {
    adminPublicActionResolver = resolve;
  });
}

function clearAccountMsgs() {
  setMsg("accountUsernameMsg", "");
  setMsg("accountPasswordMsg", "");
}

function getErrorMessage(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  if (err.detail?.code === "auth_provider_not_configured") {
    return err.detail.provider === "google"
      ? "Google OAuth 凭据尚未配置，不能启用 Google 登录。"
      : "邮箱发件凭据尚未配置，不能启用邮箱验证码注册。";
  }
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
    const config = { ...resp.runtime_config };
    for (const key of ("auth_email_delivery_configured auth_email_smtp_configured auth_google_oauth_configured".split(" "))) {
      if (Object.prototype.hasOwnProperty.call(resp, key)) config[key] = resp[key];
    }
    return config;
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
  text: { buttonId: "btnCheckLlmKey", inputId: "rtLlmApiKeyGpt", baseUrlId: "rtLlmBaseUrl", statusId: "rtLlmKeyStatus", modelStatusId: "rtLlmModelStatus", label: "文字模型" },
  image: { buttonId: "btnCheckImageKey", inputId: "rtImageGeminiApiKey", baseUrlId: "rtImageBaseUrl", statusId: "rtImageKeyStatus", modelStatusId: "rtImageModelStatus", label: "图片模型" },
};

function setProviderKeyStatus(id, status) {
  const node = el(id);
  if (!node) return;
  const current = status || {};
  const checked = current.checked === true;
  const ok = checked && current.valid === true && current.usable !== false;
  node.textContent = current.message || "未返回独立的凭据状态。";
  node.className = `msg ${checked ? (ok ? "ok" : "err") : (current.error ? "err" : "")}`.trim();
}

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
  setMsg(config.statusId, "正在检测凭据与账户状态...", true);
  setMsg(config.modelStatusId, "正在读取模型目录...", true);
  try {
    const result = await api("/api/admin/provider_key_status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, provider: "openai-compatible", base_url: baseUrl, api_key: apiKey }),
    });
    const keyStatus = result.key_status || {};
    const modelStatus = result.model_status || {};
    setProviderKeyStatus(config.statusId, keyStatus);
    setMsg(config.modelStatusId, modelStatus.message || "未返回模型目录检测结果。", modelStatus.ok === true);
  } catch (error) {
    setMsg(config.statusId, error.detail || error.message || `${config.label} Key 检测失败。`, false);
    setMsg(config.modelStatusId, "模型目录未完成检测。", false);
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

function videoImageModelItems(items) {
  return uniqueItems(items).filter((model) => VIDEO_IMAGE_MODEL_OPTIONS.includes(model));
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
      videoImagePriorityModels: videoImageModelItems(adminState.videoImagePriorityModels),
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
  ["llmGptModels", "imageGeminiModels", "videoImagePriorityModels"].forEach((key) => {
    const before = uniqueItems(adminState[key]);
    const after = key.startsWith("llm")
      ? grokModelItems([...before, ...(Array.isArray(draft[key]) ? draft[key] : [])])
      : key === "videoImagePriorityModels"
        ? videoImageModelItems([...before, ...(Array.isArray(draft[key]) ? draft[key] : [])])
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
  renderPriorityModelListSafe("videoImagePriorityModels", "rtVideoImagePriorityModelList");
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

function bindModelTabs() {
  const tabs = Array.from(document.querySelectorAll("[data-model-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-model-panel]"));
  if (!tabs.length || !panels.length) return;
  const activate = (name) => {
    tabs.forEach((tab) => {
      const active = tab.dataset.modelTab === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
    });
    panels.forEach((panel) => {
      const active = panel.dataset.modelPanel === name;
      panel.classList.toggle("is-active", active);
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-hidden", active ? "false" : "true");
    });
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
  ];
  pickerPairs.forEach(([pickerId, triggerId]) => {
    const picker = el(pickerId);
    if (!picker || picker.hidden) return;
    if (target.closest(`#${pickerId}`) || target.closest(`#${triggerId}`)) return;
    picker.hidden = true;
  });
}

const TASK_POLL_INTERVAL_MS = 10000;
const GOVERNANCE_POLL_INTERVAL_MS = 30000;
const SENTIMENT_COOKIE_POLL_INTERVAL_MS = 300000;
const EMAIL_DELIVERY_MANUAL_LIMIT_MAX = 10000000;
const EMAIL_DELIVERY_POLICY_SAVE_TIMEOUT_MS = 30000;
const taskState = {
  rows: [],
  inspectText: "",
  page: 1,
  pageSize: 20,
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
  userBatchSelectionMeta: new Map(),
  userBatchCreditShortcuts: [],
  userBatchAction: "",
  userBatchIdempotencyKey: "",
  userBatchInFlight: false,
  userBatchSelectionInFlight: false,
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
  userAuthMethodsInFlight: false,
  googleOauthConfigured: false,
  userDetailReturnFocus: null,
  userDetailInertElements: [],
  activePage: "overview",
  llmGeminiModels: [],
  llmGptModels: [],
  llmPriorityModels: [],
  llmModelPickerTargetListKey: "",
  imageGeminiModels: [],
  imagePriorityModels: [],
  videoImagePriorityModels: [],
  imageModelPickerTargetListKey: "",
  workflowChains: {},
  sentimentCookieProfiles: [],
  sentimentCookieRefreshPromise: null,
  sentimentCookieRefreshForced: false,
  billingCatalogVersions: [],
  billingActiveCatalog: null,
  billingCatalogDraftId: null,
  billingCatalogWorking: null,
  billingCatalogWorkingVersion: null,
  billingCatalogEditorTab: "subscriptions",
  billingCatalogSaving: false,
  billingCatalogPublishing: false,
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
  emailDeliveryOverview: null,
  emailDeliveryPolicySaving: false,
  emailDeliveryPolicySaveController: null,
  emailDeliveryPolicyAbortReason: "",
  emailDeliveryPolicyReturnFocus: null,
  auditRows: [],
  auditListPage: 1,
  auditListPageSize: 20,
  auditListTotal: 0,
  securityRows: [],
  securityListPage: 1,
  securityListPageSize: 20,
  serviceAccountRows: [],
  proxyMarketItemRows: [],
  proxyMarketAllocationRows: [],
  proxyPurchasedAssetRows: [],
  proxyMarketInventory: { count: 0, capacity: 0, remaining: null },
  proxyMarketRecordsView: "inventory",
  proxyMarketSelectedItemId: null,
  proxyMarketInspectRequestId: 0,
  proxyMarketEditorBusy: false,
  proxyMarketSettings: null,
  proxyMarketLoadingPromise: null,
  proxyPurchaseConfig: null,
  proxyPurchaseProviderOptions: null,
  proxyProviderCredentialStatus: null,
  proxyPurchaseOrders: [],
  customerGroupRows: [],
  customerTagRows: [],
  taxonomyLoadingPromise: null,
  serviceCredentialTimer: null,
  mfaStatus: null,
  mfaSetup: null,
};
const REMOTE_COMFY_TASKS = [
  ["persona_post_image", "推文生成配图"],
];
const TASK_TYPE_LABELS = {
  create_video: "数字人口播视频",
  ecommerce_short_video: "广告 / 种草视频",
  video_language_replace: "视频语种更换",
  replace_model: "视频模特替换",
  replace_product: "视频商品替换",
  image_generate: "图片素材生成",
  persona_post_image: "推文生成配图",
  persona_post_generation: "AI 推文草稿生成",
};
const ADMIN_PAGES = new Set(["overview", "users", "taxonomy", "tasks", "audit", "security", "serviceAccounts", "proxyMarket", "pricing", "crm", "runtime", "sentimentCookies", "account"]);
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
  secCrm: "crm",
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
  return new Date(Number(ts) * 1000).toLocaleString("zh-CN", { timeZone: ADMIN_TIME_ZONE, hour12: false });
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

function renderTaskRow(task) {
  const status = String(task.status || "").trim() || "unknown";
  const workflowName = oneLine(task.workflow_name || task.type || "-");
  const taskType = taskTypeLabel(task.type);
  const workflowId = oneLine(task.workflow_id || "-");
  const userName = oneLine(task.username || task.user_id || "-");
  const batchText = Number(task.total_count) > 0
    ? `成功 ${task.success_count || 0}/${task.total_count || 0}，失败 ${task.failed_count || 0}`
    : "单任务";
  const errorText = oneLine(task.first_error || task.error || "");
  return `
    <tr class="admin-task-row task-card-status-${escapeHtml(status)}">
      <td class="admin-task-id-cell">
        <strong>${escapeHtml(task.id)}</strong>
        <span><span data-admin-i18n-ui="true">流程：</span>${escapeHtml(workflowId)}</span>
      </td>
      <td class="admin-task-type-cell">
        <strong>${escapeHtml(workflowName)}</strong>
        <span>${escapeHtml(taskType)}</span>
        ${errorText ? `<span class="admin-task-error" title="${escapeHtml(errorText)}"><span data-admin-i18n-ui="true">错误：</span>${escapeHtml(errorText)}</span>` : ""}
      </td>
      <td>${escapeHtml(userName)}</td>
      <td>${statusPill(task.status)}</td>
      <td>${escapeHtml(batchText)}</td>
      <td>${escapeHtml(String(task.cost_cents || 0))} <span data-admin-i18n-ui="true">分</span></td>
      <td>
        <time>${escapeHtml(formatTime(task.created_at))}</time>
        <span><span data-admin-i18n-ui="true">更新：</span>${escapeHtml(formatTime(task.updated_at || task.created_at))}</span>
      </td>
      <td><div class="admin-task-table-actions">${taskActionButtons(task)}</div></td>
    </tr>
  `;
}

function renderTasks() {
  const allRows = Array.isArray(taskState.rows) ? taskState.rows : [];
  const visibleRows = filterTasks(allRows);
  const pageSize = Math.max(1, Number(taskState.pageSize || 20));
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  taskState.page = Math.min(Math.max(1, Number(taskState.page || 1)), totalPages);
  const pageStart = (taskState.page - 1) * pageSize;
  const pageRows = visibleRows.slice(pageStart, pageStart + pageSize);
  const list = el("taskList");
  const tableShell = el("taskTableShell");
  const empty = el("taskEmpty");
  const meta = el("taskMetaLine");
  const pagination = el("taskPagination");
  if (!list || !empty || !meta) return;
  renderTaskSummary(allRows, visibleRows);
  meta.textContent = visibleRows.length === allRows.length
    ? `共 ${allRows.length} 条生成记录，按创建时间倒序展示 · 第 ${taskState.page} / ${totalPages} 页`
    : `筛选到 ${visibleRows.length} / ${allRows.length} 条生成记录 · 第 ${taskState.page} / ${totalPages} 页`;
  empty.style.display = visibleRows.length ? "none" : "block";
  if (tableShell) tableShell.style.display = visibleRows.length ? "block" : "none";
  list.innerHTML = pageRows.map((task) => renderTaskRow(task)).join("");
  if (pagination) pagination.hidden = !visibleRows.length;
  setText("taskPaginationSummary", `共 ${visibleRows.length} 条生成记录 · 每页 ${pageSize} 条`);
  setText("taskPageIndicator", `第 ${taskState.page} / ${totalPages} 页`);
  if (el("btnTaskPagePrev")) el("btnTaskPagePrev").disabled = taskState.page <= 1;
  if (el("btnTaskPageNext")) el("btnTaskPageNext").disabled = taskState.page >= totalPages;
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
  [...SENSITIVE_RUNTIME_INPUT_IDS, ...SENSITIVE_PROVIDER_INPUT_IDS].forEach((id) => {
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

function initProviderSecretMaskInputs() {
  SENSITIVE_PROVIDER_INPUT_IDS.forEach((id) => {
    const input = el(id);
    if (!input || input.dataset.providerSecretMaskBound === "true") return;
    input.dataset.providerSecretMaskBound = "true";
    input.addEventListener("focus", () => {
      if (hasSavedProviderSecret(id)) input.select();
    });
    input.addEventListener("input", () => {
      if (input.value === input.dataset.providerSecretMask) return;
      input.dataset.providerSecretConfigured = "false";
      input.classList.remove("is-saved-runtime-secret");
      const button = getSensitiveToggleButton(id);
      if (button) {
        button.disabled = false;
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
  const navigation = window.VectoSiteNavigation;
  const accountHost = el("adminSharedAccountHost");
  if (navigation && accountHost) {
    navigation.markAdminConsoleContext?.();
    navigation.mountAccountMenu?.(accountHost, { page: "console" });
    navigation.setAccount?.(me);
  }
  if (el("accCurrentUsername")) el("accCurrentUsername").value = me.username || "";
  return me;
}

function runtimeFormToPayload() {
  const workflowChains = collectWorkflowChains();
  adminState.llmGeminiModels = [];
  adminState.llmGptModels = grokModelItems(adminState.llmGptModels);
  adminState.llmPriorityModels = grokModelItems(adminState.llmPriorityModels);
  adminState.imageGeminiModels = imageModelItems(adminState.imageGeminiModels);
  adminState.imagePriorityModels = imageModelItems(adminState.imagePriorityModels);
  adminState.videoImagePriorityModels = videoImageModelItems(adminState.videoImagePriorityModels);
  const llmGrokModels = stringifyModelList(adminState.llmGptModels);
  const llmPriorityModels = stringifyModelList(adminState.llmPriorityModels);
  const imageGeminiModels = stringifyModelList(adminState.imageGeminiModels);
  const imagePriorityModels = stringifyModelList(adminState.imagePriorityModels);
  const videoImagePriorityModels = stringifyModelList(adminState.videoImagePriorityModels.length ? adminState.videoImagePriorityModels : VIDEO_IMAGE_MODEL_DEFAULTS);
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
    runninghub_personal_api_key: runtimeSecretInputValue("rtVideoRunningHubPersonalApiKey"),
    runninghub_enterprise_api_key: runtimeSecretInputValue("rtVideoRunningHubEnterpriseApiKey"),
    digital_human_oral_hot_topic_mode: el("rtVideoOralHotTopicMode")?.value || "strong",
    video_image_model_priority_order: videoImagePriorityModels,
    minimax_api_key: runtimeSecretInputValue("rtVideoMiniMaxApiKey"),
    minimax_base_url: "https://api.minimaxi.com",
    minimax_tts_model: el("rtVideoMiniMaxTtsModel")?.value.trim() || "speech-2.8-hd",
    minimax_tts_voice_id: el("rtVideoMiniMaxTtsVoiceId")?.value.trim() || "male-qn-qingse",
    cleanup_enabled: !!el("rtCleanupEnabled").checked,
    cleanup_time: el("rtCleanupTime").value || "03:30",
    cleanup_retention_days: Number(el("rtCleanupRetentionDays").value || 7),
    browser_cache_cleanup_enabled: !!el("rtBrowserCacheCleanupEnabled")?.checked,
    browser_cache_cleanup_interval_days: Math.min(365, Math.max(1, Number(el("rtBrowserCacheCleanupIntervalDays")?.value || 15))),
    browser_cache_cleanup_size_trigger_enabled: !!el("rtBrowserCacheCleanupSizeTriggerEnabled")?.checked,
    browser_cache_cleanup_size_threshold_mb: Math.min(102400, Math.max(256, Math.round(Number(el("rtBrowserCacheCleanupSizeThresholdGb")?.value || 2) * 1024))),
    browser_cache_cleanup_min_disk_free_mb: Math.min(102400, Math.max(512, Math.round(Number(el("rtBrowserCacheCleanupMinDiskFreeGb")?.value || 5) * 1024))),
    auth_remember_login_enabled: !!el("rtRememberLoginEnabled").checked,
    auth_remember_login_default: !!el("rtRememberLoginDefault").checked,
    auth_remember_login_days: Number(el("rtRememberLoginDays").value || 30),
    auth_session_hours: Number(el("rtSessionHours").value || 12),
    auth_email_registration_enabled: !!el("rtEmailRegistrationEnabled")?.checked,
    auth_google_login_enabled: !!el("rtGoogleLoginEnabled")?.checked,
  };
}

function syncRuntimeAuthProviderAvailability() {
  const googleToggle = el("rtGoogleLoginEnabled");
  const status = el("rtGoogleAuthStatus");
  if (!googleToggle || !status) return;
  const configured = Boolean(adminState.googleOauthConfigured);
  googleToggle.disabled = !configured && !googleToggle.checked;
  if (configured) {
    status.textContent = "Google OAuth 凭据已配置，可安全启用授权登录。";
    status.dataset.state = "ready";
  } else if (googleToggle.checked) {
    status.textContent = "Google OAuth 凭据未配置，当前入口不可用；请关闭开关并保存。";
    status.dataset.state = "warning";
  } else {
    status.textContent = "Google OAuth 凭据未配置，完成服务器配置后才能开启。";
    status.dataset.state = "unavailable";
  }
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
  setRuntimeSecretInputState("rtVideoRunningHubPersonalApiKey", v.runninghub_personal_api_key_configured, v.runninghub_personal_api_key_masked);
  setRuntimeSecretInputState("rtVideoRunningHubEnterpriseApiKey", v.runninghub_enterprise_api_key_configured, v.runninghub_enterprise_api_key_masked);
  if (el("rtVideoOralHotTopicMode")) el("rtVideoOralHotTopicMode").value = ["off", "soft", "strong"].includes(v.digital_human_oral_hot_topic_mode) ? v.digital_human_oral_hot_topic_mode : "strong";
  if (el("rtVideoMiniMaxBaseUrl")) el("rtVideoMiniMaxBaseUrl").value = "https://api.minimaxi.com";
  setRuntimeSecretInputState("rtVideoMiniMaxApiKey", v.minimax_api_key_configured, v.minimax_api_key_masked);
  if (el("rtVideoMiniMaxTtsModel")) el("rtVideoMiniMaxTtsModel").value = v.minimax_tts_model || "speech-2.8-hd";
  if (el("rtVideoMiniMaxTtsVoiceId")) el("rtVideoMiniMaxTtsVoiceId").value = v.minimax_tts_voice_id || "male-qn-qingse";
  renderRunningHubPresetSelect("persona");
  renderRunningHubPresetSelect("tweet");
  adminState.imageGeminiModels = imageModelItems([
    ...parseModelList(v.image_model_default_model_gemini || ""),
    ...parseModelList(v.image_model_default_model || ""),
  ]);
  adminState.imagePriorityModels = imageModelItems(v.image_model_priority_order ? parseModelList(v.image_model_priority_order) : adminState.imageGeminiModels);
  adminState.videoImagePriorityModels = videoImageModelItems(parseModelList(v.video_image_model_priority_order || VIDEO_IMAGE_MODEL_DEFAULTS.join(", ")));
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
  if (el("rtBrowserCacheCleanupEnabled")) {
    el("rtBrowserCacheCleanupEnabled").checked = v.browser_cache_cleanup_enabled !== false;
  }
  if (el("rtBrowserCacheCleanupIntervalDays")) {
    el("rtBrowserCacheCleanupIntervalDays").value = String(v.browser_cache_cleanup_interval_days || 15);
  }
  if (el("rtBrowserCacheCleanupSizeTriggerEnabled")) {
    el("rtBrowserCacheCleanupSizeTriggerEnabled").checked = v.browser_cache_cleanup_size_trigger_enabled !== false;
  }
  if (el("rtBrowserCacheCleanupSizeThresholdGb")) {
    const thresholdMb = Math.min(102400, Math.max(256, Number(v.browser_cache_cleanup_size_threshold_mb || 2048)));
    el("rtBrowserCacheCleanupSizeThresholdGb").value = String(Number((thresholdMb / 1024).toFixed(2)));
  }
  if (el("rtBrowserCacheCleanupMinDiskFreeGb")) {
    const minDiskFreeMb = Math.min(102400, Math.max(512, Number(v.browser_cache_cleanup_min_disk_free_mb || 5120)));
    el("rtBrowserCacheCleanupMinDiskFreeGb").value = String(Number((minDiskFreeMb / 1024).toFixed(2)));
  }
  renderBrowserCacheCleanupStatus(v);
  el("rtRememberLoginEnabled").checked = v.auth_remember_login_enabled !== false;
  el("rtRememberLoginDefault").checked = v.auth_remember_login_default === true;
  el("rtRememberLoginDays").value = String(v.auth_remember_login_days || 30);
  el("rtSessionHours").value = String(v.auth_session_hours || 12);
  if (el("rtEmailRegistrationEnabled")) {
    el("rtEmailRegistrationEnabled").checked = v.auth_email_registration_enabled === true;
  }
  if (hasRuntimeField("auth_google_oauth_configured")) {
    adminState.googleOauthConfigured = v.auth_google_oauth_configured === true;
  }
  if (el("rtGoogleLoginEnabled")) {
    el("rtGoogleLoginEnabled").checked = v.auth_google_login_enabled === true;
  }
  syncRuntimeAuthProviderAvailability();
}

function browserCacheCleanupObject(source) {
  if (!source || typeof source !== "object") return {};
  const nested = source.browser_cache_cleanup_status || source.browser_cache_cleanup || source.result;
  return nested && typeof nested === "object" ? { ...source, ...nested } : source;
}

function browserCacheCleanupCount(value) {
  if (Array.isArray(value)) return value.length;
  return Math.max(0, Number(value) || 0);
}

function browserCacheCleanupDate(value) {
  if (value == null || value === "") return "-";
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 100000000000 ? numeric * 1000 : numeric)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { timeZone: ADMIN_TIME_ZONE, hour12: false });
}

function browserCacheCleanupBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = "B";
  for (const candidate of units) {
    amount /= 1024;
    unit = candidate;
    if (amount < 1024) break;
  }
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${unit}`;
}

function browserCacheCleanupStatusLabel(value, enabled = true) {
  if (!enabled) return "已停用";
  const status = String(value || "idle").trim().toLowerCase();
  const labels = {
    never: "等待首次计划执行",
    idle: "等待计划执行",
    pending: "等待计划执行",
    running: "正在安全清理",
    success: "最近清理成功",
    completed: "最近清理成功",
    partial: "本轮安全清理未完整完成",
    skipped: "本轮已安全延后",
    deferred: "检测到浏览器任务，本轮已延后",
    skipped_busy: "本轮已安全延后",
    disabled: "已停用",
    failed: "最近清理失败",
    error: "最近清理失败",
  };
  return labels[status] || "等待状态更新";
}

function browserCacheCleanupTriggerLabel(value) {
  const reason = String(value || "").trim().toLowerCase();
  const labels = {
    manual: "管理员手动执行",
    interval: "计划周期到期",
    schedule: "计划周期到期",
    scheduled: "计划周期到期",
    scheduled_interval: "计划周期到期",
    size_threshold: "缓存达到容量阈值",
    cache_size: "缓存达到容量阈值",
    capacity_threshold: "缓存达到容量阈值",
    low_disk_free: "可用磁盘低于安全线",
    disk_free: "可用磁盘低于安全线",
    low_disk: "可用磁盘低于安全线",
    "capacity_threshold+low_disk": "缓存达阈值且磁盘空间偏低",
    startup: "首次计划执行",
  };
  return labels[reason] || (reason ? "系统容量策略触发" : "-");
}

function renderBrowserCacheCleanupStatus(source) {
  if (!el("browserCacheCleanupStatus")) return;
  const data = browserCacheCleanupObject(source);
  const enabled = data.browser_cache_cleanup_enabled !== false;
  const intervalDays = Math.min(365, Math.max(1, Number(data.browser_cache_cleanup_interval_days || 15)));
  const lastRun = data.browser_cache_cleanup_last_run_at ?? data.last_run_at ?? data.finished_at ?? data.completed_at;
  let nextRun = data.browser_cache_cleanup_next_run_at ?? data.next_run_at;
  if (!nextRun && enabled && lastRun) {
    const numeric = Number(lastRun);
    const lastDate = Number.isFinite(numeric)
      ? new Date(numeric < 100000000000 ? numeric * 1000 : numeric)
      : new Date(lastRun);
    if (!Number.isNaN(lastDate.getTime())) nextRun = new Date(lastDate.getTime() + intervalDays * 86400000);
  }
  const reclaimed = data.browser_cache_cleanup_last_reclaimed_bytes
    ?? data.reclaimed_bytes
    ?? data.freed_bytes
    ?? 0;
  const rawStatus = data.browser_cache_cleanup_last_status ?? data.status;
  const totalBytes = data.browser_cache_cleanup_last_total_bytes ?? data.last_total_bytes ?? data.total_bytes;
  const diskFreeBytes = data.browser_cache_cleanup_last_disk_free_bytes ?? data.last_disk_free_bytes ?? data.disk_free_bytes;
  const lastCheckAt = data.browser_cache_cleanup_last_check_at ?? data.last_check_at;
  const triggerReason = data.browser_cache_cleanup_last_trigger_reason ?? data.last_trigger_reason ?? data.trigger_reason;
  setText("browserCacheCleanupStatus", browserCacheCleanupStatusLabel(rawStatus, enabled));
  setText("browserCacheCleanupLastRun", lastRun ? browserCacheCleanupDate(lastRun) : "尚未执行");
  setText("browserCacheCleanupNextRun", enabled ? (nextRun ? browserCacheCleanupDate(nextRun) : "等待首次计划") : "已停用");
  setText("browserCacheCleanupReclaimed", browserCacheCleanupBytes(reclaimed));
  setText(
    "browserCacheCleanupCapacity",
    !lastCheckAt && !(Number(totalBytes) > 0) && !(Number(diskFreeBytes) > 0)
      ? "尚未检测"
      : `缓存 ${totalBytes == null ? "-" : browserCacheCleanupBytes(totalBytes)} · 可用 ${diskFreeBytes == null ? "-" : browserCacheCleanupBytes(diskFreeBytes)}`,
  );
  setText("browserCacheCleanupTriggerReason", browserCacheCleanupTriggerLabel(triggerReason));
}

async function runBrowserCacheCleanupNow() {
  const button = el("btnRunBrowserCacheCleanup");
  if (!button || button.disabled) return;
  const decision = await requestAdminPublicAction({
    title: "立即清理浏览器缓存",
    message: "只会清理可重建的 cache2。检测到任何浏览器任务时本轮会整体延后，Cookie、登录状态和站点存储不会被删除。",
    confirmLabel: "开始安全清理",
  });
  if (!decision.confirmed) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "正在检查并清理…";
  setMsg("browserCacheCleanupMsg", "正在检查浏览器任务；如有任务运行，本轮清理将整体延后。", true);
  try {
    const result = await api("/api/admin/browser-cache-cleanup/run", { method: "POST" });
    renderBrowserCacheCleanupStatus(result);
    const data = browserCacheCleanupObject(result);
    const status = String(data.status || "").toLowerCase();
    const deferred = data.deferred === true || ["deferred", "skipped", "skipped_busy"].includes(status);
    const reclaimed = data.reclaimed_bytes ?? data.freed_bytes ?? data.browser_cache_cleanup_last_reclaimed_bytes ?? 0;
    const cleaned = browserCacheCleanupCount(data.deleted_count ?? data.cleaned_profile_count ?? data.cleaned_profiles ?? data.cleaned_count);
    if (deferred) {
      setMsg("browserCacheCleanupMsg", "检测到正在执行的浏览器任务，本轮缓存清理已整体延后，不影响当前任务。", true);
    } else if (data.ok === false) {
      setMsg("browserCacheCleanupMsg", `浏览器缓存清理未完成：${String(data.message || "请稍后重试")}`, false);
    } else {
      setMsg("browserCacheCleanupMsg", `安全清理完成：删除 ${cleaned} 个 cache2 目录，回收 ${browserCacheCleanupBytes(reclaimed)}。`, true);
    }
    try {
      const refreshed = runtimeConfigResponseToConfig(await api("/api/admin/runtime_config"));
      renderBrowserCacheCleanupStatus(refreshed || result);
    } catch (_) {}
  } catch (error) {
    setMsg("browserCacheCleanupMsg", `浏览器缓存清理失败：${getErrorMessage(error)}`, false);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = originalText;
  }
}

async function loadRuntime() {
  const cfg = runtimeConfigResponseToConfig(await api("/api/admin/runtime_config"));
  fillRuntimeForm(cfg);
  return cfg;
}

let socialAutomationBrowserSettings = null;

async function loadSocialAutomationPolicy() {
  const [publishResponse, browserResponse] = await Promise.all([
    api("/api/admin/social_publish_policy"),
    api("/api/persona_dashboard/automation/browser_settings"),
  ]);
  const publishPolicy = publishResponse?.policy || publishResponse || {};
  const browserSettings = browserResponse?.settings || browserResponse || {};
  socialAutomationBrowserSettings = browserSettings;
  if (el("rtSocialDailyPublishLimit")) {
    el("rtSocialDailyPublishLimit").value = String(publishPolicy.limit || 15);
  }
  if (el("rtSocialGlobalConcurrency")) {
    el("rtSocialGlobalConcurrency").value = String(browserSettings.max_concurrency || 3);
  }
  if (el("rtPersonaHotFetchCooldownMinutes")) {
    el("rtPersonaHotFetchCooldownMinutes").value = String(publishPolicy.hot_fetch_cooldown_minutes ?? 0);
  }
  return { publishPolicy, browserSettings };
}

async function saveSocialAutomationPolicy() {
  const dailyLimit = Number.parseInt(String(el("rtSocialDailyPublishLimit")?.value || ""), 10);
  const globalConcurrency = Number.parseInt(String(el("rtSocialGlobalConcurrency")?.value || ""), 10);
  const hotFetchCooldownMinutes = Number.parseInt(String(el("rtPersonaHotFetchCooldownMinutes")?.value || ""), 10);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 200) {
    throw new Error("普通用户每日发布上限必须是 1 到 200 之间的整数。");
  }
  if (!Number.isInteger(globalConcurrency) || globalConcurrency < 1 || globalConcurrency > 4) {
    throw new Error("普通用户全局并发上限必须是 1 到 4 之间的整数。");
  }
  if (!Number.isInteger(hotFetchCooldownMinutes) || hotFetchCooldownMinutes < 0 || hotFetchCooldownMinutes > 1440) {
    throw new Error("热点抓取冷却必须是 0 到 1440 之间的整数分钟。");
  }
  const currentBrowserSettings = socialAutomationBrowserSettings
    || (await api("/api/persona_dashboard/automation/browser_settings"))?.settings
    || {};
  const [publishResponse, browserResponse] = await Promise.all([
    api("/api/admin/social_publish_policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: dailyLimit,
        hot_fetch_cooldown_minutes: hotFetchCooldownMinutes,
      }),
    }),
    api("/api/persona_dashboard/automation/browser_settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        standby_seconds: Number(currentBrowserSettings.standby_seconds || 0),
        auto_close_seconds: Number(currentBrowserSettings.auto_close_seconds || 30),
        max_concurrency: globalConcurrency,
        text_input_mode: currentBrowserSettings.text_input_mode || "paste",
      }),
    }),
  ]);
  socialAutomationBrowserSettings = browserResponse?.settings || currentBrowserSettings;
  return { publishResponse, browserResponse };
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
    "retry-later": "请手动刷新重试",
    "manual-refresh": "请点击刷新状态检测",
  };
  return map[action] || "";
}

function sentimentCookieStatusDetails(profile) {
  const savedCookieCount = Number(profile?.cookieCount || 0);
  const validCookieCount = Number(profile?.validCookieCount || 0);
  const key = sentimentCookieProfileCanonicalKey(profile)
    || String(profile?.key || profile?.platform || "").trim().toLowerCase();
  const ordinaryCookieSaved = savedCookieCount > 0;
  const ordinaryCookieReady = validCookieCount > 0;
  const cookieNames = new Set(
    (Array.isArray(profile?.cookieNames) ? profile.cookieNames : [])
      .map((name) => String(name || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const validCookieNames = new Set(
    (Array.isArray(profile?.validCookieNames) ? profile.validCookieNames : [])
      .map((name) => String(name || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const credentialByPlatform = {
    threads: { label: "sessionid", names: ["sessionid"] },
    instagram: { label: "sessionid", names: ["sessionid"] },
    xiaohongshusearch: { label: "web_session", names: ["web_session"] },
    facebooksearch: { label: "c_user", names: ["c_user"] },
    xsearch: { label: "auth_token", names: ["auth_token"] },
  };
  const credential = credentialByPlatform[key] || { label: "登录凭证", names: [] };
  const credentialSaved = (
    credential.names.some((name) => cookieNames.has(name))
  );
  const credentialReady = (
    (credential.label === "sessionid" && profile?.sessionidSaved === true)
    || credential.names.some((name) => validCookieNames.has(name))
  );
  const liveStatus = String(profile?.liveAuthStatus || "").trim();
  const reportsLiveAuth = key === "threads" || key === "instagram";
  const checkedAt = reportsLiveAuth && profile?.liveAuthCheckedAt
    ? formatAdminDate(profile.liveAuthCheckedAt)
    : "";
  let loginState;
  if (reportsLiveAuth) {
    loginState = liveStatus === "verified"
      ? { value: "登录有效", state: "ready" }
      : liveStatus === "invalid" || liveStatus === "missing_sessionid"
        ? { value: "登录已失效", state: "missing" }
        : liveStatus === "probe_failed"
          ? { value: "检测异常", state: "warning" }
          : liveStatus === "pending_manual_check"
            ? { value: "待手动检测", state: "warning" }
          : liveStatus
            ? { value: "待确认", state: "warning" }
            : credentialReady
              ? { value: ordinaryCookieReady ? "待实时检测" : "登录已失效", state: ordinaryCookieReady ? "warning" : "missing" }
              : { value: "未获取", state: "inactive" };
  } else if (credentialReady && ordinaryCookieReady) {
    loginState = { value: "未实时检测", state: "warning" };
  } else if (ordinaryCookieSaved && !ordinaryCookieReady) {
    loginState = { value: "已过期", state: "missing" };
  } else {
    loginState = { value: "未获取", state: "inactive" };
  }
  const liveSearchStatus = String(profile?.liveSearchStatus || "").trim();
  let liveSearchState;
  if (!reportsLiveAuth) {
    liveSearchState = { value: "未检测", state: "inactive" };
  } else if (liveSearchStatus === "available" || profile?.liveSearchUsable === true) {
    liveSearchState = { value: "可用", state: "ready" };
  } else if (liveSearchStatus === "unavailable" || profile?.liveSearchUsable === false) {
    liveSearchState = { value: "不可用", state: "missing" };
  } else if (liveSearchStatus === "limited") {
    liveSearchState = { value: "平台限流", state: "warning" };
  } else if (liveSearchStatus === "probe_failed") {
    liveSearchState = { value: "检测异常", state: "warning" };
  } else {
    liveSearchState = { value: "待手动检测", state: "warning" };
  }
  const items = [
    {
      label: "Cookie",
      value: ordinaryCookieSaved ? `已保存 ${savedCookieCount}` : "未获取",
      state: ordinaryCookieSaved ? "ready" : "inactive",
    },
    {
      label: credential.label,
      value: credentialReady ? "已保存" : credentialSaved ? "已过期" : "未获取",
      state: credentialReady ? "ready" : credentialSaved ? "missing" : "inactive",
    },
    { label: "登录状态", ...loginState },
  ];
  if (reportsLiveAuth) items.push({ label: "实时热点搜索", ...liveSearchState });
  return {
    items,
    hint: sentimentCookieActionLabel(
      credentialReady
        ? (reportsLiveAuth ? profile?.liveAuthAction : profile?.recommendedAction)
        : "authorize-profile",
    ),
    liveMessage: reportsLiveAuth
      ? String(profile?.liveSearchMessage || profile?.liveAuthMessage || "").trim()
      : "",
    checkedAt,
  };
}

function formatAdminDate(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString("zh-CN", { timeZone: ADMIN_TIME_ZONE, hour12: false });
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
            ${statusDetails.liveMessage ? `<div class="sentiment-cookie-hint">${escapeHtml(statusDetails.liveMessage)}</div>` : ""}
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
    headers: { "X-Admin-Console": "1" },
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
  if (node) node.textContent = String(text || "等待自动检测");
  if (shell) shell.dataset.state = state;
}

async function loadSentimentCookieProfiles({ force = false } = {}) {
  if (adminState.sentimentCookieRefreshPromise) {
    const pending = adminState.sentimentCookieRefreshPromise;
    if (!force || adminState.sentimentCookieRefreshForced) return pending;
    await pending.catch(() => null);
    return loadSentimentCookieProfiles({ force: true });
  }
  adminState.sentimentCookieRefreshForced = force;
  adminState.sentimentCookieRefreshPromise = (async () => {
    if (force) setSentimentCookieLiveState("自动检测中...", "checking");
    const payload = await api(`/api/admin/sentiment/browser_auth/profiles${force ? "?force=true" : ""}`);
    renderSentimentCookieProfiles(payload);
    if (el("sentimentCookieMsg")?.classList.contains("err")) {
      setMsg("sentimentCookieMsg", "");
    }
    const updatedAt = new Date().toLocaleTimeString("zh-CN", { timeZone: ADMIN_TIME_ZONE, hour12: false });
    const checked = (Array.isArray(payload?.profiles) ? payload.profiles : []).some((profile) => (
      String(profile?.liveSearchCheckedAt || profile?.liveAuthCheckedAt || "").trim()
    ));
    setSentimentCookieLiveState(
      force || checked ? `已更新 ${updatedAt}` : "等待自动检测",
      force || checked ? "ready" : "warning",
    );
    return payload;
  })();
  try {
    return await adminState.sentimentCookieRefreshPromise;
  } finally {
    adminState.sentimentCookieRefreshPromise = null;
    adminState.sentimentCookieRefreshForced = false;
  }
}

async function refreshSentimentCookieProfilesIfActive({ force = true } = {}) {
  if (document.hidden || adminState.activePage !== "sentimentCookies") return null;
  try {
    return await loadSentimentCookieProfiles({ force });
  } catch {
    setSentimentCookieLiveState("读取失败，请手动刷新重试", "warning");
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
  const decision = await requestAdminPublicAction({
    title: "清空授权 Cookie",
    message: `确认清空 ${profileKey} 的 Cookie 吗？清空后该平台真实扫描会失效，直到重新授权。`,
    confirmLabel: "确认清空",
    tone: "danger",
  });
  if (!decision.confirmed) return null;
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
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { timeZone: ADMIN_TIME_ZONE, hour12: false });
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

function formatBillingCatalogNtd(value) {
  const amount = Number(value || 0);
  return `NT$ ${Number.isFinite(amount) ? amount.toLocaleString("zh-TW", { maximumFractionDigits: 2 }) : "0"}`;
}

function cloneBillingCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return {};
  if (typeof structuredClone === "function") return structuredClone(catalog);
  return JSON.parse(JSON.stringify(catalog));
}

function billingCatalogVersionLabel(version) {
  return `v${version?.version_number ?? version?.version ?? version?.id ?? "-"}`;
}

function billingCatalogRecordLabel(version) {
  const number = version?.version_number ?? version?.version;
  return Number.isFinite(Number(number)) ? `第 ${Number(number)} 次保存` : "已保存方案";
}

function billingCatalogPlanSummary(catalog) {
  const subscriptions = Array.isArray(catalog?.subscriptions) ? catalog.subscriptions : [];
  const subscription = catalog?.subscription && typeof catalog.subscription === "object"
    ? catalog.subscription
    : (subscriptions[0] || {});
  return {
    name: String(subscription.name || "未命名套餐"),
    price: Number(subscription.price_ntd || 0),
    periodMonths: Number(subscription.period_months || 0),
    accounts: Number(subscription.threads_accounts || 0),
    images: Number(subscription.monthly_free_images || 0),
    planCount: subscriptions.length,
  };
}

const BILLING_CATALOG_EDITOR_TABS = new Set(["subscriptions", "packages", "actions", "automation"]);

function setBillingCatalogEditorTab(tabName, { focus = false } = {}) {
  const nextTab = BILLING_CATALOG_EDITOR_TABS.has(String(tabName || ""))
    ? String(tabName)
    : "subscriptions";
  adminState.billingCatalogEditorTab = nextTab;
  document.querySelectorAll("[data-billing-editor-tab]").forEach((button) => {
    const selected = button.dataset.billingEditorTab === nextTab;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  });
  document.querySelectorAll("[data-billing-editor-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.billingEditorPanel !== nextTab;
  });
}

function setBillingCatalogInput(id, value) {
  const input = el(id);
  if (input) input.value = value === null || value === undefined ? "" : String(value);
}

function createBillingCatalogField(labelText, value, {
  type = "number",
  step = "1",
  field,
  itemType,
  itemIndex,
  className = "",
} = {}) {
  const label = document.createElement("label");
  label.className = `admin-billing-field${className ? ` ${className}` : ""}`;
  const caption = document.createElement("span");
  caption.textContent = labelText;
  const input = document.createElement("input");
  input.type = type;
  input.value = value === null || value === undefined ? "" : String(value);
  if (type === "number") {
    input.min = "0";
    input.step = step;
    input.inputMode = step === "1" ? "numeric" : "decimal";
  }
  input.dataset.billingField = field;
  input.dataset.billingItemType = itemType;
  input.dataset.billingItemIndex = String(itemIndex);
  label.append(caption, input);
  return label;
}

function createBillingCatalogTextarea(labelText, value, { field, itemType, itemIndex } = {}) {
  const label = document.createElement("label");
  label.className = "admin-billing-field admin-billing-field-wide";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  const textarea = document.createElement("textarea");
  textarea.rows = 4;
  textarea.value = value === null || value === undefined ? "" : String(value);
  textarea.dataset.billingField = field;
  textarea.dataset.billingItemType = itemType;
  textarea.dataset.billingItemIndex = String(itemIndex);
  label.append(caption, textarea);
  return label;
}

function renderBillingCatalogForm(catalog, version) {
  const working = cloneBillingCatalog(catalog);
  const fallbackSubscription = working.subscription && typeof working.subscription === "object"
    ? working.subscription
    : {};
  working.subscriptions = Array.isArray(working.subscriptions) && working.subscriptions.length
    ? working.subscriptions
    : [fallbackSubscription];
  const defaultSku = String(fallbackSubscription.sku || working.subscriptions[0]?.sku || "");
  const defaultSubscription = working.subscriptions.find((item) => String(item?.sku || "") === defaultSku)
    || working.subscriptions[0]
    || {};
  working.subscription = { ...defaultSubscription };
  working.packages = Array.isArray(working.packages) ? working.packages : [];
  working.actions = Array.isArray(working.actions) ? working.actions : [];
  working.automation_modules = Array.isArray(working.automation_modules) ? working.automation_modules : [];
  working.billing_rules = Array.isArray(working.billing_rules) ? working.billing_rules : [];
  adminState.billingCatalogWorking = working;
  adminState.billingCatalogWorkingVersion = version || null;

  setBillingCatalogInput("billingPointUnit", working.point_unit_ntd ?? 0);

  const catalogTimezone = el("billingCatalogTimezone");
  if (catalogTimezone) catalogTimezone.textContent = String(working.timezone || "Asia/Shanghai");
  const subscriptionCount = el("billingCatalogSubscriptionCount");
  if (subscriptionCount) {
    const personalCount = working.subscriptions.filter((item) => String(item?.sku || "").startsWith("vanguard_personal_")).length;
    const enterpriseCount = working.subscriptions.filter((item) => String(item?.sku || "").startsWith("vanguard_enterprise_")).length;
    subscriptionCount.textContent = `个人 ${personalCount} · 企业 ${enterpriseCount}`;
  }
  const packageCount = el("billingCatalogPackageCount");
  if (packageCount) packageCount.textContent = `${working.packages.length} 个`;
  const actionCount = el("billingCatalogActionCount");
  if (actionCount) actionCount.textContent = `${working.actions.length} 项`;

  const status = el("billingCatalogEditorStatus");
  if (status) {
    status.textContent = version
      ? "正在修改已保存的套餐"
      : "正在设置新套餐";
  }

  const subscriptionList = el("billingSubscriptionEditorList");
  subscriptionList?.replaceChildren();
  const subscriptionGroups = new Map();
  [
    ["personal", "个人轻量版", "1 个综合账号 · 月标准价 NT$2,000"],
    ["enterprise", "企业版", "3 个分工账号 · 月标准价 NT$6,000"],
  ].forEach(([key, label, description]) => {
    const group = document.createElement("section");
    group.className = "admin-billing-subscription-group";
    const heading = document.createElement("div");
    heading.className = "admin-billing-subscription-group-head";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = label;
    const detail = document.createElement("span");
    detail.textContent = description;
    copy.append(title, detail);
    const count = document.createElement("span");
    count.textContent = `${working.subscriptions.filter((item) => String(item?.sku || "").startsWith(`vanguard_${key}_`)).length} 个周期`;
    heading.append(copy, count);
    const grid = document.createElement("div");
    grid.className = "admin-billing-subscription-grid";
    group.append(heading, grid);
    subscriptionGroups.set(key, grid);
    subscriptionList?.appendChild(group);
  });
  working.subscriptions.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "admin-billing-package-card admin-billing-subscription-card";
    card.setAttribute("data-billing-subscription-index", String(index));
    const title = document.createElement("div");
    title.className = "admin-billing-item-title";
    const titleStrong = document.createElement("strong");
    titleStrong.textContent = String(item.name || `订阅方案 ${index + 1}`);
    const sku = document.createElement("span");
    sku.textContent = `${String(item.sku || "未设置 SKU")}${String(item.sku || "") === defaultSku ? " · 默认方案" : ""}`;
    title.append(titleStrong, sku);
    const fields = document.createElement("div");
    fields.className = "admin-billing-field-grid admin-billing-item-fields";
    fields.append(
      createBillingCatalogField("套餐名称", item.name || "", { type: "text", field: "name", itemType: "subscription", itemIndex: index, className: "admin-billing-field-wide" }),
      createBillingCatalogField("当前周期总价（NT$）", item.price_ntd ?? 0, { field: "price_ntd", itemType: "subscription", itemIndex: index }),
      createBillingCatalogField("月标准价（NT$）", item.monthly_price_ntd ?? 0, { field: "monthly_price_ntd", itemType: "subscription", itemIndex: index }),
      createBillingCatalogField("周期（月）", item.period_months ?? 0, { field: "period_months", itemType: "subscription", itemIndex: index }),
      createBillingCatalogField("可绑定账号", item.threads_accounts ?? 0, { field: "threads_accounts", itemType: "subscription", itemIndex: index }),
      createBillingCatalogField("每月免费图片", item.monthly_free_images ?? 0, { field: "monthly_free_images", itemType: "subscription", itemIndex: index }),
      createBillingCatalogField("适合对象", item.audience || "", { type: "text", field: "audience", itemType: "subscription", itemIndex: index, className: "admin-billing-field-wide" }),
      createBillingCatalogField("账号定位", item.account_positioning || "", { type: "text", field: "account_positioning", itemType: "subscription", itemIndex: index, className: "admin-billing-field-wide" }),
      createBillingCatalogTextarea("套餐包含内容（每行一项）", Array.isArray(item.features) ? item.features.join("\n") : "", { field: "features", itemType: "subscription", itemIndex: index }),
    );
    card.append(title, fields);
    const groupKey = String(item?.sku || "").startsWith("vanguard_personal_") ? "personal" : "enterprise";
    (subscriptionGroups.get(groupKey) || subscriptionList)?.appendChild(card);
  });

  const ruleList = el("billingCatalogRuleList");
  ruleList?.replaceChildren();
  working.billing_rules.forEach((item) => {
    const card = document.createElement("article");
    card.className = "admin-billing-rule-card";
    const title = document.createElement("strong");
    title.textContent = String(item?.name || "通用规则");
    const description = document.createElement("span");
    description.textContent = String(item?.description || "");
    card.append(title, description);
    ruleList?.appendChild(card);
  });

  const packageList = el("billingPackageEditorList");
  packageList?.replaceChildren();
  working.packages.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "admin-billing-package-card";
    card.dataset.billingPackageIndex = String(index);
    const title = document.createElement("div");
    title.className = "admin-billing-item-title";
    const titleStrong = document.createElement("strong");
    titleStrong.textContent = `储值包 ${index + 1}`;
    const total = document.createElement("span");
    total.dataset.billingPackageTotal = String(index);
    total.textContent = `客户获得 ${formatBillingPoints(item.total_points ?? (Number(item.paid_points || 0) + Number(item.bonus_points || 0)))} 点`;
    title.append(titleStrong, total);
    const fields = document.createElement("div");
    fields.className = "admin-billing-field-grid admin-billing-item-fields";
    fields.append(
      createBillingCatalogField("名称", item.name || "", { type: "text", field: "name", itemType: "package", itemIndex: index, className: "admin-billing-field-wide" }),
      createBillingCatalogField("售价（NT$）", item.price_ntd ?? 0, { field: "price_ntd", itemType: "package", itemIndex: index }),
      createBillingCatalogField("基础点数", item.paid_points ?? 0, { field: "paid_points", itemType: "package", itemIndex: index }),
      createBillingCatalogField("赠送点数", item.bonus_points ?? 0, { field: "bonus_points", itemType: "package", itemIndex: index }),
      createBillingCatalogField("赠送图片", item.bonus_images ?? 0, { field: "bonus_images", itemType: "package", itemIndex: index }),
    );
    card.append(title, fields);
    packageList?.appendChild(card);
  });
  if (packageList && !working.packages.length) {
    packageList.textContent = "当前方案没有储值包。";
    packageList.classList.add("is-empty");
  } else {
    packageList?.classList.remove("is-empty");
  }

  const actionList = el("billingActionEditorList");
  actionList?.replaceChildren();
  working.actions.forEach((item, index) => {
    const row = document.createElement("article");
    row.className = "admin-billing-action-card";
    row.dataset.billingActionIndex = String(index);
    row.append(
      createBillingCatalogField("功能名称", item.name || "", { type: "text", field: "name", itemType: "action", itemIndex: index, className: "admin-billing-field-wide" }),
      createBillingCatalogField("每次使用所需点数", item.points ?? 0, { step: "0.01", field: "points", itemType: "action", itemIndex: index }),
      createBillingCatalogField("使用次数说明", item.unit || "", { type: "text", field: "unit", itemType: "action", itemIndex: index }),
    );
    const toggle = document.createElement("label");
    toggle.className = "admin-billing-action-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.implemented !== false;
    checkbox.dataset.billingField = "implemented";
    checkbox.dataset.billingItemType = "action";
    checkbox.dataset.billingItemIndex = String(index);
    const toggleText = document.createElement("span");
    toggleText.textContent = "允许客户使用";
    toggle.append(checkbox, toggleText);
    row.appendChild(toggle);
    actionList?.appendChild(row);
  });
  if (actionList && !working.actions.length) {
    actionList.textContent = "当前套餐没有单独收费的功能。";
    actionList.classList.add("is-empty");
  } else {
    actionList?.classList.remove("is-empty");
  }

  const automationList = el("billingAutomationEditorList");
  automationList?.replaceChildren();
  const actionBySku = new Map(working.actions.map((item) => [String(item?.sku || ""), item]));
  working.automation_modules.forEach((item) => {
    const card = document.createElement("article");
    card.className = "admin-billing-automation-card";
    const copy = document.createElement("div");
    copy.className = "admin-billing-automation-copy";
    const title = document.createElement("strong");
    title.textContent = String(item?.name || item?.key || "自动化任务");
    const description = document.createElement("span");
    description.textContent = String(item?.description || "由自动化任务运行时按此规则结算");
    copy.append(title, description);

    const billing = document.createElement("div");
    billing.className = "admin-billing-automation-charge";
    const mode = String(item?.billing_mode || item?.mode || "").toLowerCase();
    const actionSku = String(item?.action_sku || item?.sku || "");
    const action = actionBySku.get(actionSku);
    if (mode === "free" || !actionSku) {
      billing.textContent = "免费开放";
      billing.classList.add("is-free");
    } else if (action) {
      billing.textContent = `${formatBillingPoints(action.points)} 点 / ${String(action.unit || "次")}`;
    } else {
      billing.textContent = "待配置计费项";
      billing.classList.add("is-warning");
    }
    card.append(copy, billing);
    automationList?.appendChild(card);
  });
  if (automationList && !working.automation_modules.length) {
    automationList.textContent = "当前目录尚未配置自动化任务映射。";
    automationList.classList.add("is-empty");
  } else {
    automationList?.classList.remove("is-empty");
  }
  const automationCount = el("billingCatalogAutomationCount");
  if (automationCount) automationCount.textContent = `${working.automation_modules.length} 项`;
  setBillingCatalogEditorTab(adminState.billingCatalogEditorTab);
}

function billingCatalogNumber(id, label, { integer = false } = {}) {
  const input = el(id);
  const raw = String(input?.value || "").trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`请正确填写“${label}”`);
  }
  return value;
}

function readBillingCatalogForm() {
  const catalog = cloneBillingCatalog(adminState.billingCatalogWorking);
  catalog.point_unit_ntd = billingCatalogNumber("billingPointUnit", "1 点算力参考价");

  const readDynamicNumber = (input, label) => {
    const value = Number(String(input.value || "").trim());
    if (!Number.isFinite(value) || value < 0) throw new Error(`请正确填写“${label}”`);
    return value;
  };
  document.querySelectorAll("#billingSubscriptionEditorList [data-billing-subscription-index]").forEach((card) => {
    const index = Number(card.dataset.billingSubscriptionIndex);
    const item = { ...(catalog.subscriptions?.[index] || {}) };
    card.querySelectorAll("[data-billing-field]").forEach((input) => {
      const field = input.dataset.billingField;
      if (field === "features") {
        item.features = String(input.value || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      } else if (input.type === "number") {
        item[field] = readDynamicNumber(input, `订阅方案 ${index + 1}`);
      } else {
        item[field] = String(input.value || "").trim();
      }
    });
    if (!item.name) throw new Error(`请填写“订阅方案 ${index + 1} 名称”`);
    if (![3, 6, 12].includes(Number(item.period_months))) throw new Error(`订阅方案 ${index + 1} 的周期必须为 3、6 或 12 个月`);
    const expectedTotal = Number(item.monthly_price_ntd) * Number(item.period_months);
    if (Math.abs(Number(item.price_ntd) - expectedTotal) > 0.000001) {
      throw new Error(`订阅方案 ${index + 1} 的周期总价必须等于月标准价 × 周期月数`);
    }
    catalog.subscriptions[index] = item;
  });
  const defaultSku = String(catalog.subscription?.sku || catalog.subscriptions?.[0]?.sku || "");
  const defaultSubscription = catalog.subscriptions.find((item) => String(item?.sku || "") === defaultSku);
  if (!defaultSubscription) throw new Error("默认订阅方案不存在");
  catalog.subscription = { ...defaultSubscription };
  document.querySelectorAll("#billingPackageEditorList [data-billing-package-index]").forEach((card) => {
    const index = Number(card.dataset.billingPackageIndex);
    const item = { ...(catalog.packages?.[index] || {}) };
    card.querySelectorAll("[data-billing-field]").forEach((input) => {
      const field = input.dataset.billingField;
      item[field] = input.type === "number"
        ? readDynamicNumber(input, `储值包 ${index + 1}`)
        : String(input.value || "").trim();
    });
    item.total_points = Number(item.paid_points || 0) + Number(item.bonus_points || 0);
    catalog.packages[index] = item;
  });
  document.querySelectorAll("#billingActionEditorList [data-billing-action-index]").forEach((card) => {
    const index = Number(card.dataset.billingActionIndex);
    const item = { ...(catalog.actions?.[index] || {}) };
    card.querySelectorAll("[data-billing-field]").forEach((input) => {
      const field = input.dataset.billingField;
      if (input.type === "checkbox") item[field] = input.checked;
      else if (input.type === "number") item[field] = readDynamicNumber(input, `功能使用费用 ${index + 1}`);
      else item[field] = String(input.value || "").trim();
    });
    catalog.actions[index] = item;
  });
  return catalog;
}

const BILLING_STATUS_LABELS = {
  draft: "草稿",
  active: "使用中",
  retired: "已停用",
  pending: "待审批",
  approved: "已批准",
  refunded: "已冲销",
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

function renderBillingAdjustmentSubscriptionOptions(catalog) {
  const select = el("billingAdjustmentSubscriptionSku");
  if (!select) return;
  const currentSku = String(select.value || "");
  const subscriptions = Array.isArray(catalog?.subscriptions) ? catalog.subscriptions : [];
  select.replaceChildren();
  subscriptions.forEach((item) => {
    const option = document.createElement("option");
    option.value = String(item?.sku || "");
    option.textContent = `${String(item?.name || item?.sku || "订阅方案")} · ${Number(item?.period_months || 0)} 个月 / ${formatBillingCatalogNtd(item?.price_ntd)}`;
    select.appendChild(option);
  });
  if (subscriptions.some((item) => String(item?.sku || "") === currentSku)) select.value = currentSku;
  else if (catalog?.subscription?.sku) select.value = String(catalog.subscription.sku);
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
      const catalog = billingCatalogOf(active);
      const summary = billingCatalogPlanSummary(catalog);
      title.textContent = `当前客户套餐 · 共 ${summary.planCount} 个方案`;
      const meta = document.createElement("span");
      const automationCount = Array.isArray(catalog?.automation_modules) ? catalog.automation_modules.length : 0;
      meta.textContent = `默认：${summary.name} · 当前周期总价 ${formatBillingCatalogNtd(summary.price)} / ${summary.periodMonths} 个月 · ${summary.accounts} 个账号 · 每月 ${summary.images} 张免费图片 · ${automationCount} 项自动化规则 · ${String(catalog?.timezone || "Asia/Shanghai")}`;
      activeSummary.append(title, createBillingStatus("active"), meta);
      renderBillingAdjustmentSubscriptionOptions(catalog);
    } else {
      activeSummary.textContent = "当前没有已发布方案";
      renderBillingAdjustmentSubscriptionOptions(null);
    }
  }

  const body = el("billingCatalogBody");
  if (!body) return;
  body.replaceChildren();
  if (!versions.length) {
    const row = document.createElement("tr");
    const cell = createBillingCell("还没有保存过套餐", "admin-billing-empty");
    cell.colSpan = 5;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  versions.forEach((version) => {
    const row = document.createElement("tr");
    const versionLabel = billingCatalogRecordLabel(version);
    row.appendChild(createBillingCell(versionLabel, "admin-billing-strong"));
    const statusCell = document.createElement("td");
    statusCell.appendChild(createBillingStatus(version.status));
    row.appendChild(statusCell);
    row.appendChild(createBillingCell(formatBillingTime(version.effective_at || version.published_at)));
    row.appendChild(createBillingCell(formatBillingTime(version.created_at)));
    const actionCell = document.createElement("td");
    actionCell.className = "admin-billing-actions";
    const inspectButton = createBillingAction("编辑设置", "catalog-inspect", version.id);
    inspectButton.dataset.versionIndex = String(adminState.billingCatalogVersions.indexOf(version));
    actionCell.appendChild(inspectButton);
    if (String(version.status || "").toLowerCase() === "draft") {
      actionCell.appendChild(createBillingAction("发布给客户", "catalog-publish", version.id, "primary"));
    }
    row.appendChild(actionCell);
    body.appendChild(row);
  });
  if (!adminState.billingCatalogWorking) {
    useBillingCatalog(active || versions[0], { silent: true });
  }
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

function useBillingCatalog(version, { silent = false } = {}) {
  const catalog = billingCatalogOf(version);
  if (!catalog) {
    setMsg("billingCatalogMsg", "该记录没有可读取的套餐设置", false);
    return;
  }
  adminState.billingCatalogDraftId = String(version.status || "").toLowerCase() === "draft"
    ? String(version.id || "")
    : null;
  renderBillingCatalogForm(catalog, version);
  if (el("btnCreateCatalogDraft")) {
    el("btnCreateCatalogDraft").textContent = "保存修改";
  }
  if (!silent) setMsg("billingCatalogMsg", "套餐设置已载入，可以修改后保存", true);
}

async function createBillingCatalogDraft() {
  if (adminState.billingCatalogSaving) return;
  const saveButton = el("btnCreateCatalogDraft");
  adminState.billingCatalogSaving = true;
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "正在保存...";
  }
  try {
    const catalog = readBillingCatalogForm();
    let draftId = String(adminState.billingCatalogDraftId || "");
    if (!draftId) {
      const draft = await api("/api/admin/billing/catalog/versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: String(adminState.billingActiveCatalog?.id || "") }),
      });
      draftId = String(draft?.id || draft?.item?.id || draft?.data?.id || "");
      if (!draftId) throw new Error("套餐记录已创建，但系统没有返回记录编号");
    }
    await api(`/api/admin/billing/catalog/versions/${encodeURIComponent(draftId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalog }),
    });
    adminState.billingCatalogDraftId = draftId;
    await loadBillingCatalog();
    const savedVersion = adminState.billingCatalogVersions.find((item) => String(item.id || "") === draftId);
    if (savedVersion) useBillingCatalog(savedVersion, { silent: true });
    setMsg("billingCatalogMsg", "套餐设置已保存，确认无误后可在左侧发布给客户", true);
  } finally {
    adminState.billingCatalogSaving = false;
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "保存修改";
    }
  }
}

async function publishBillingCatalog(versionId) {
  if (adminState.billingCatalogPublishing) return;
  const version = adminState.billingCatalogVersions.find((item) => String(item.id || "") === String(versionId || ""));
  const summary = billingCatalogPlanSummary(billingCatalogOf(version));
  if (!versionId) return;
  const decision = await requestAdminPublicAction({
    title: "发布订阅方案",
    message: `确认将共 ${summary.planCount} 个订阅方案发布给客户吗？\n\n默认方案：${summary.name}\n当前周期总价：${formatBillingCatalogNtd(summary.price)} / ${summary.periodMonths} 个月\n账号容量：${summary.accounts} 个\n每月免费图片：${summary.images} 张`,
    confirmLabel: "确认发布",
  });
  if (!decision.confirmed) return;
  const publishButtons = [...document.querySelectorAll('[data-billing-action="catalog-publish"]')];
  adminState.billingCatalogPublishing = true;
  publishButtons.forEach((button) => { button.disabled = true; });
  try {
    await api(`/api/admin/billing/catalog/versions/${encodeURIComponent(versionId)}/publish`, {
      method: "POST",
    });
    adminState.billingCatalogDraftId = null;
    adminState.billingCatalogWorking = null;
    adminState.billingCatalogWorkingVersion = null;
    if (el("btnCreateCatalogDraft")) el("btnCreateCatalogDraft").textContent = "保存修改";
    await loadBillingCatalog();
    setMsg("billingCatalogMsg", "套餐已发布，客户购买页已更新", true);
  } finally {
    adminState.billingCatalogPublishing = false;
    publishButtons.forEach((button) => { button.disabled = false; });
  }
}

function billingCatalogProductName(sku, order = {}) {
  const explicit = order.product_name || order.plan_name || order.item_name || order.package_name || order.sku_name;
  if (explicit) return String(explicit);
  const catalogs = [
    billingCatalogOf(adminState.billingActiveCatalog),
    ...adminState.billingCatalogVersions.map((item) => billingCatalogOf(item)),
  ].filter(Boolean);
  for (const catalog of catalogs) {
    const subscriptionItem = (Array.isArray(catalog.subscriptions) ? catalog.subscriptions : [])
      .find((item) => String(item?.sku || "") === String(sku || ""));
    if (subscriptionItem) return String(subscriptionItem.name || "订阅套餐");
    if (String(catalog.subscription?.sku || "") === String(sku || "")) {
      return String(catalog.subscription?.name || "月度套餐");
    }
    const packageItem = (Array.isArray(catalog.packages) ? catalog.packages : [])
      .find((item) => String(item?.sku || "") === String(sku || ""));
    if (packageItem) return String(packageItem.name || "算力储值包");
  }
  return "客户购买方案";
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
    row.appendChild(createBillingCell(`${billingCatalogProductName(order.sku, order)} × ${order.quantity || 1}`));
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
    } else if (status === "approved") {
      actions.append(
        createBillingAction("冲销权益", "order-refund", order.id, "danger"),
      );
    } else {
      actions.textContent = order.refund_note || order.review_note || "已处理";
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
  const decision = await requestAdminPublicAction({
    title: `${label}方案申请`,
    message: `确认${label}方案申请 ${orderId} 吗？${status === "approved" ? "批准后客户权益将立即生效。" : ""}`,
    confirmLabel: `确认${label}`,
    tone: status === "approved" ? "primary" : "danger",
    inputLabel: "审批备注（可留空）",
    inputPlaceholder: "填写本次审批说明",
  });
  if (!decision.confirmed) return;
  const action = status === "approved" ? "approve" : "reject";
  await api(`/api/admin/billing/orders/${encodeURIComponent(orderId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: decision.value.trim() }),
  });
  await loadBillingOrders();
  setMsg("billingOrderMsg", `方案申请已${label}`, true);
}

async function refundBillingOrder(orderId) {
  const decision = await requestAdminPublicAction({
    title: "冲销已批准订单",
    message: `确认冲销订单 ${orderId} 已发放且尚可安全回收的权益吗？此操作只处理平台内权益，支付渠道退款仍需另行完成。`,
    confirmLabel: "确认冲销",
    tone: "danger",
    inputLabel: "冲销原因（必填）",
    inputPlaceholder: "例如：重复付款、拒付或误批准",
  });
  if (!decision.confirmed) return;
  const note = decision.value.trim();
  if (!note) throw new Error("请填写冲销原因");
  await api(`/api/admin/billing/orders/${encodeURIComponent(orderId)}/refund`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  await loadBillingOrders();
  if (adminState.billingSelectedUserId) await loadUserBilling(adminState.billingSelectedUserId);
  setMsg("billingOrderMsg", "订单权益已冲销，支付渠道退款请按实际支付方式另行处理", true);
}

async function terminateBillingSubscription(subscriptionId) {
  const decision = await requestAdminPublicAction({
    title: "终止客户订阅",
    message: `确认立即终止订阅 ${subscriptionId} 吗？尚未使用的订阅图片权益会同时撤销。`,
    confirmLabel: "确认终止",
    tone: "danger",
    inputLabel: "终止原因（必填）",
    inputPlaceholder: "填写本次终止订阅的原因",
  });
  if (!decision.confirmed) return;
  const note = decision.value.trim();
  if (!note) throw new Error("请填写终止原因");
  await api(`/api/admin/billing/subscriptions/${encodeURIComponent(subscriptionId)}/terminate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  await loadUserBilling(adminState.billingSelectedUserId);
  setMsg("billingUserMsg", "订阅已终止，剩余订阅权益已撤销", true);
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
  const subscriptionBody = el("billingSubscriptionBody");
  subscriptionBody?.replaceChildren();
  if (subscriptionBody && !subscriptions.length) {
    const row = document.createElement("tr");
    const cell = createBillingCell("暂无订阅记录", "admin-billing-empty");
    cell.colSpan = 5;
    row.appendChild(cell);
    subscriptionBody.appendChild(row);
  } else if (subscriptionBody) {
    subscriptions.forEach((subscription) => {
      const row = document.createElement("tr");
      const status = String(subscription.status || "expired").toLowerCase();
      row.appendChild(createBillingCell(subscription.id || "-"));
      row.appendChild(createBillingCell(subscription.plan_sku || "-"));
      const statusCell = document.createElement("td");
      statusCell.appendChild(createBillingStatus(status));
      row.appendChild(statusCell);
      row.appendChild(createBillingCell(formatBillingTime(subscription.current_period_end)));
      const actions = document.createElement("td");
      actions.className = "admin-billing-actions";
      if (status === "active") {
        actions.appendChild(createBillingAction("终止订阅", "subscription-terminate", subscription.id, "danger"));
      } else {
        actions.textContent = "无需操作";
      }
      row.appendChild(actions);
      subscriptionBody.appendChild(row);
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
    const subscriptionSku = String(el("billingAdjustmentSubscriptionSku")?.value || "").trim();
    if (!Number.isInteger(amount) || quantity < 1 || quantity > 50) throw new Error("订阅套数必须是 1-50 的整数");
    if (!subscriptionSku) throw new Error("请选择订阅方案");
    const subscriptionName = String(el("billingAdjustmentSubscriptionSku")?.selectedOptions?.[0]?.textContent || subscriptionSku);
    const decision = await requestAdminPublicAction({
      title: "开通订阅方案",
      message: `确认给客户 ID ${userId} 人工开通 ${quantity} 套“${subscriptionName}”吗？每套按所选方案周期生效。`,
      confirmLabel: "确认开通",
    });
    if (!decision.confirmed) return;
    await api(`/api/admin/users/${userId}/billing/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: subscriptionSku, quantity, renewal_subscription_ids: [], note }),
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
    const decision = await requestAdminPublicAction({
      title: "调整客户算力",
      message: `确认将客户 ID ${userId} ${actionText}吗？`,
      confirmLabel: "确认调整",
    });
    if (!decision.confirmed) return;
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
  const subscriptionSku = el("billingAdjustmentSubscriptionSku");
  const subscriptionSkuLabel = el("billingAdjustmentSubscriptionSkuLabel");
  if (subscriptionSku) {
    subscriptionSku.hidden = !isSubscription;
    subscriptionSku.disabled = !isSubscription;
  }
  if (subscriptionSkuLabel) subscriptionSkuLabel.hidden = !isSubscription;
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
      ? "1-50 套（每套按所选周期开通）"
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
  detail: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  billing: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h8M8 9h2"/></svg>',
  archive: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 7h16v13H4V7Z"/><path d="M3 3h18v4H3V3Zm6 9h6"/></svg>',
  restore: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 7h16v13H4V7Z"/><path d="M3 3h18v4H3V3Zm6 10 3-3 3 3m-3-3v6"/></svg>',
  delete: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg>',
};

function createAdminUserBadge(text, tone) {
  const badge = document.createElement("span");
  badge.className = `admin-user-badge admin-user-badge-${tone}`;
  badge.textContent = text;
  return markAdminDynamicUiElement(badge);
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

function normalizeUserAuthMethods(user = {}) {
  const methods = user.auth_methods && typeof user.auth_methods === "object" && !Array.isArray(user.auth_methods)
    ? user.auth_methods
    : {};
  const password = methods.password && typeof methods.password === "object" ? methods.password : {};
  const google = methods.google && typeof methods.google === "object" ? methods.google : {};
  const hasOwn = (source, key) => Object.prototype.hasOwnProperty.call(source || {}, key);
  const passwordConfigured = hasOwn(password, "configured")
    ? Boolean(password.configured)
    : Boolean(user.password_configured);
  const passwordEnabled = hasOwn(password, "enabled")
    ? Boolean(password.enabled)
    : (hasOwn(user, "password_login_enabled") ? Boolean(user.password_login_enabled) : passwordConfigured);
  const googleBound = hasOwn(google, "bound")
    ? Boolean(google.bound)
    : Boolean(user.google_identity_bound || user.google_bound);
  const googleEnabled = hasOwn(google, "enabled")
    ? Boolean(google.enabled)
    : (hasOwn(user, "google_login_enabled") ? Boolean(user.google_login_enabled) : googleBound);
  return { passwordConfigured, passwordEnabled, googleBound, googleEnabled };
}

function userLoginMethodLabel(method) {
  const normalized = String(method || "").trim().toLowerCase();
  if (normalized === "password") return "密码";
  if (normalized === "google") return "Google";
  if (normalized === "email_registration") return "邮箱注册";
  return normalized || "尚无记录";
}

function userAuthMethodsLabel(user = {}) {
  const auth = normalizeUserAuthMethods(user);
  const active = [];
  if (auth.passwordEnabled) active.push("密码");
  if (auth.googleEnabled) active.push("Google");
  return active.length ? active.join(" + ") : "无可用登录方式";
}

function readUserListFilters() {
  return {
    query: String(el("adminUserQuery")?.value || "").trim(),
    lifecycle_status: String(el("adminUserLifecycle")?.value || ""),
    risk_level: String(el("adminUserRisk")?.value || ""),
    subscription_status: adminState.userListRole === "customer" ? String(el("adminUserSubscription")?.value || "") : "",
    online: String(el("adminUserOnline")?.value || ""),
    auth_method: adminState.userListRole === "customer" ? String(el("adminUserAuthMethod")?.value || "") : "",
    email_status: adminState.userListRole === "customer" ? String(el("adminUserEmailStatus")?.value || "") : "",
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
    selectAll.disabled = adminState.userBatchSelectionInFlight;
    selectAll.checked = adminState.userListTotal > 0
      && adminState.selectedUserIds.size >= adminState.userListTotal;
    selectAll.indeterminate = adminState.selectedUserIds.size > 0 && !selectAll.checked;
  }
  document.querySelectorAll("[data-user-batch-action]").forEach((button) => {
    button.setAttribute("aria-pressed", "false");
    button.disabled = adminState.userBatchInFlight
      || adminState.userBatchSelectionInFlight
      || !userBatchActionAvailable(button.dataset.userBatchAction);
  });
}

function rememberUserBatchSelectionMeta(user = {}) {
  const id = String(user.id || "");
  if (!id || user.is_admin) return;
  adminState.userBatchSelectionMeta.set(id, {
    lifecycle: String(user.lifecycle_status || (Number(user.deleted_at || 0) > 0 ? "deleted" : (user.is_disabled ? "suspended" : "active"))),
    approval: String(user.approval_status || ""),
  });
}

function userBatchActionAvailable(action) {
  if (!adminState.selectedUserIds.size) return false;
  if (action === "add_credit") return true;
  const selected = Array.from(adminState.selectedUserIds, (id) => adminState.userBatchSelectionMeta.get(String(id)))
    .filter(Boolean);
  if (action === "enable") {
    return selected.some((item) => item.approval === "approved" && item.lifecycle !== "active");
  }
  if (action === "suspend") {
    return selected.some((item) => item.lifecycle === "active");
  }
  return false;
}

function clearUserBatchSelection() {
  adminState.selectedUserIds.clear();
  adminState.userBatchAction = "";
  adminState.userBatchIdempotencyKey = "";
  syncUserBatchSelection();
}

function createUserBatchIdempotencyKey() {
  if (typeof window.crypto?.randomUUID === "function") return `admin-batch-${window.crypto.randomUUID()}`;
  return `admin-batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function resetUserBatchRequest() {
  adminState.userBatchIdempotencyKey = "";
}

const USER_BATCH_ACTION_CONFIG = Object.freeze({
  add_credit: {
    title: "调整算力",
    subtitle: "将已选客户的算力点替换为指定数值",
    confirmLabel: "确认调整",
    reasonPlaceholder: "选填，例如：人工调整账号算力",
  },
  enable: {
    title: "启用账号",
    subtitle: "恢复已选客户的账号使用权限",
    confirmLabel: "确认启用",
    reasonPlaceholder: "选填，可填写本次启用账号的原因",
  },
  suspend: {
    title: "停用账号",
    subtitle: "临时停用已选客户的账号使用权限",
    confirmLabel: "确认停用",
    reasonPlaceholder: "选填，可填写本次停用账号的原因",
  },
});

const ADMIN_CREDIT_SHORTCUTS_STORAGE_KEY = "wk-admin-credit-shortcuts-v1";
const DEFAULT_ADMIN_CREDIT_SHORTCUTS = Object.freeze([
  Object.freeze({ id: "default-small", name: "小额额度", points: 100 }),
  Object.freeze({ id: "default-standard", name: "常规额度", points: 500 }),
  Object.freeze({ id: "default-batch", name: "批量额度", points: 1000 }),
]);

function normalizeAdminCreditShortcut(item = {}) {
  const points = Math.round(Number(item.points || 0) * 1_000_000) / 1_000_000;
  const name = String(item.name || "").trim().slice(0, 16);
  if (!name || !Number.isFinite(points) || points < 0 || points > 1_000_000) return null;
  return {
    id: String(item.id || createUserBatchIdempotencyKey()),
    name,
    points,
  };
}

function loadAdminCreditShortcuts() {
  try {
    const raw = localStorage.getItem(ADMIN_CREDIT_SHORTCUTS_STORAGE_KEY);
    if (raw === null) {
      adminState.userBatchCreditShortcuts = DEFAULT_ADMIN_CREDIT_SHORTCUTS.map((item) => ({ ...item }));
      return;
    }
    const parsed = JSON.parse(raw);
    adminState.userBatchCreditShortcuts = Array.isArray(parsed)
      ? parsed.map(normalizeAdminCreditShortcut).filter(Boolean).slice(0, 12)
      : DEFAULT_ADMIN_CREDIT_SHORTCUTS.map((item) => ({ ...item }));
  } catch {
    adminState.userBatchCreditShortcuts = DEFAULT_ADMIN_CREDIT_SHORTCUTS.map((item) => ({ ...item }));
  }
}

function persistAdminCreditShortcuts() {
  try {
    localStorage.setItem(ADMIN_CREDIT_SHORTCUTS_STORAGE_KEY, JSON.stringify(adminState.userBatchCreditShortcuts));
  } catch {
    // The shortcuts still work for the current page when browser storage is unavailable.
  }
}

function renderAdminCreditShortcuts() {
  const list = el("adminUserBatchCreditShortcutList");
  if (!list) return;
  list.replaceChildren();
  adminState.userBatchCreditShortcuts.forEach((shortcut) => {
    const item = document.createElement("div");
    item.className = "admin-credit-shortcut";
    item.setAttribute("role", "listitem");
    const applyButton = document.createElement("button");
    applyButton.type = "button";
    applyButton.className = "admin-credit-shortcut-apply";
    applyButton.dataset.creditShortcutApply = shortcut.id;
    applyButton.setAttribute("aria-label", `填入 ${shortcut.name} ${shortcut.points} 点`);
    const name = document.createElement("span");
    name.textContent = shortcut.name;
    const points = document.createElement("strong");
    points.textContent = `${Number(shortcut.points).toLocaleString()} 点`;
    applyButton.append(name, points);
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "admin-credit-shortcut-remove";
    removeButton.dataset.creditShortcutRemove = shortcut.id;
    removeButton.setAttribute("aria-label", `删除快捷标签 ${shortcut.name}`);
    removeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>';
    item.append(applyButton, removeButton);
    list.appendChild(markAdminDynamicUiElement(item));
  });
}

function syncAdminCreditShortcutToggle(open) {
  const toggle = el("btnAdminUserBatchCreditShortcutAdd");
  if (!toggle) return;
  const path = toggle.querySelector("svg path");
  const label = toggle.querySelector("span");
  if (path) path.setAttribute("d", open ? "M6 6l12 12M18 6 6 18" : "M12 5v14M5 12h14");
  if (label) label.textContent = open ? "收起自定义" : "自定义标签";
  toggle.setAttribute("aria-label", open ? "收起自定义标签表单" : "打开自定义标签表单");
  toggle.setAttribute("aria-expanded", String(open));
}

function toggleAdminCreditShortcutForm(forceOpen = null) {
  const form = el("adminUserBatchCreditShortcutForm");
  if (!form) return;
  const open = forceOpen === null ? form.hidden : Boolean(forceOpen);
  form.hidden = !open;
  syncAdminCreditShortcutToggle(open);
  if (open) el("adminUserBatchCreditShortcutName")?.focus();
}

function applyAdminCreditShortcut(shortcutId) {
  const shortcut = adminState.userBatchCreditShortcuts.find((item) => item.id === String(shortcutId || ""));
  const credit = el("adminUserBatchCredit");
  if (!shortcut || !credit) return;
  if (el("adminUserBatchUnlimited")) el("adminUserBatchUnlimited").checked = false;
  syncUserBatchUnlimitedMode();
  credit.value = String(shortcut.points);
  credit.focus();
  setText("adminUserBatchCreditShortcutMsg", "");
}

function removeAdminCreditShortcut(shortcutId) {
  adminState.userBatchCreditShortcuts = adminState.userBatchCreditShortcuts
    .filter((item) => item.id !== String(shortcutId || ""));
  persistAdminCreditShortcuts();
  renderAdminCreditShortcuts();
}

function saveAdminCreditShortcut() {
  const nameInput = el("adminUserBatchCreditShortcutName");
  const pointsInput = el("adminUserBatchCreditShortcutPoints");
  const name = String(nameInput?.value || "").trim();
  const points = Math.round(Number(pointsInput?.value || 0) * 1_000_000) / 1_000_000;
  if (!name || !Number.isFinite(points) || points < 0 || points > 1_000_000) {
    setText("adminUserBatchCreditShortcutMsg", "请填写标签名和 0–1,000,000 之间的算力点。");
    return;
  }
  if (adminState.userBatchCreditShortcuts.length >= 12) {
    setText("adminUserBatchCreditShortcutMsg", "最多保存 12 个快捷标签。");
    return;
  }
  if (adminState.userBatchCreditShortcuts.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
    setText("adminUserBatchCreditShortcutMsg", "标签名已存在，请换一个名称。");
    return;
  }
  const shortcut = normalizeAdminCreditShortcut({
    id: typeof window.crypto?.randomUUID === "function" ? window.crypto.randomUUID() : createUserBatchIdempotencyKey(),
    name,
    points,
  });
  if (!shortcut) return;
  adminState.userBatchCreditShortcuts.push(shortcut);
  persistAdminCreditShortcuts();
  renderAdminCreditShortcuts();
  if (nameInput) nameInput.value = "";
  if (pointsInput) pointsInput.value = "";
  setText("adminUserBatchCreditShortcutMsg", "");
  toggleAdminCreditShortcutForm(false);
}

function openUserBatchModal(action) {
  const normalizedAction = String(action || "");
  const config = USER_BATCH_ACTION_CONFIG[normalizedAction];
  if (!config) return;
  if (!adminState.selectedUserIds.size) {
    setMsg("userMsg", "请先勾选需要操作的客户账号。", false);
    return;
  }
  if (!userBatchActionAvailable(normalizedAction)) {
    setMsg("userMsg", "所选账号当前没有可执行此操作的状态。", false);
    return;
  }
  adminState.userBatchAction = normalizedAction;
  resetUserBatchRequest();
  setText("adminUserBatchModalTitle", config.title);
  setText("adminUserBatchModalSub", config.subtitle);
  setText("adminUserBatchModalCount", adminState.selectedUserIds.size);
  setText("btnAdminUserBatchConfirm", config.confirmLabel);
  if (el("adminUserBatchUnlimitedField")) el("adminUserBatchUnlimitedField").hidden = normalizedAction !== "add_credit";
  if (el("adminUserBatchUnlimited")) el("adminUserBatchUnlimited").checked = false;
  if (el("adminUserBatchCreditField")) el("adminUserBatchCreditField").hidden = normalizedAction !== "add_credit";
  if (el("adminUserBatchCredit")) el("adminUserBatchCredit").value = normalizedAction === "add_credit" ? "1000" : "";
  if (el("adminUserBatchCreditShortcuts")) el("adminUserBatchCreditShortcuts").hidden = normalizedAction !== "add_credit";
  loadAdminCreditShortcuts();
  renderAdminCreditShortcuts();
  toggleAdminCreditShortcutForm(false);
  syncUserBatchUnlimitedMode();
  if (el("adminUserBatchReason")) {
    el("adminUserBatchReason").value = "";
    el("adminUserBatchReason").placeholder = config.reasonPlaceholder;
  }
  setMsg("adminUserBatchModalMsg", "");
  const modal = el("adminUserBatchModal");
  if (!modal) return;
  modal.style.display = "grid";
  modal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => {
    (normalizedAction === "add_credit" ? el("adminUserBatchCredit") : el("adminUserBatchReason"))?.focus();
  }, 0);
}

function closeUserBatchModal() {
  if (adminState.userBatchInFlight) return;
  const modal = el("adminUserBatchModal");
  if (!modal) return;
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
  adminState.userBatchAction = "";
  resetUserBatchRequest();
}

function buildUserBatchPayload(preview) {
  const payload = {
    action: String(adminState.userBatchAction || ""),
    user_ids: Array.from(adminState.selectedUserIds, (value) => Number(value)),
    reason: String(el("adminUserBatchReason")?.value || "").trim(),
    delta_points: String(el("adminUserBatchCredit")?.value || "").trim() === ""
      ? null
      : Number(el("adminUserBatchCredit").value),
    idempotency_key: adminState.userBatchIdempotencyKey,
    preview: Boolean(preview),
  };
  if (payload.action === "add_credit") payload.unlimited = Boolean(el("adminUserBatchUnlimited")?.checked);
  return payload;
}

function syncUserBatchUnlimitedMode() {
  const unlimited = Boolean(el("adminUserBatchUnlimited")?.checked);
  const credit = el("adminUserBatchCredit");
  if (!credit) return;
  credit.disabled = unlimited;
  credit.placeholder = unlimited ? "无限模式无需填写" : "输入新的算力点";
  if (unlimited) credit.value = "";
}

async function previewUserBatchAction() {
  if (!adminState.userBatchIdempotencyKey) {
    adminState.userBatchIdempotencyKey = createUserBatchIdempotencyKey();
  }
  const payload = buildUserBatchPayload(true);
  if (!payload.action) throw new Error("请选择批量操作");
  if (!payload.user_ids.length) throw new Error("请先勾选客户账号");
  if (
    payload.action === "add_credit"
    && !payload.unlimited
    && (payload.delta_points === null || !Number.isFinite(payload.delta_points) || payload.delta_points < 0)
  ) {
    throw new Error("请输入 0 或更大的最终算力点，或选择无限算力");
  }
  const result = await api("/api/admin/users/batch-actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return result;
}

async function submitUserBatchModal() {
  if (adminState.userBatchInFlight) return;
  adminState.userBatchInFlight = true;
  syncUserBatchSelection();
  const confirmButton = el("btnAdminUserBatchConfirm");
  if (confirmButton) confirmButton.disabled = true;
  setMsg("adminUserBatchModalMsg", "正在校验并执行操作...");
  let result = null;
  try {
    const previewResult = await previewUserBatchAction();
    const current = buildUserBatchPayload(false);
    if (Number(previewResult.matched || 0) !== current.user_ids.length) {
      throw new Error("部分账号状态已变化，请关闭窗口后重新选择");
    }
    result = await api("/api/admin/users/batch-actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(current),
    });
    const replayNote = result.idempotent_replay ? "（重复请求已安全复用原作业）" : "";
    const message = `作业完成${replayNote}：成功 ${Number(result.success || 0)}，失败 ${Number(result.failed || 0)}，跳过 ${Number(result.skipped || 0)}。`;
    setMsg("userMsg", message, Number(result.failed || 0) === 0);
    adminState.selectedUserIds.clear();
    adminState.userBatchAction = "";
    resetUserBatchRequest();
    const modal = el("adminUserBatchModal");
    if (modal) {
      modal.style.display = "none";
      modal.setAttribute("aria-hidden", "true");
    }
  } catch (error) {
    setMsg("adminUserBatchModalMsg", getErrorMessage(error), false);
    throw error;
  } finally {
    adminState.userBatchInFlight = false;
    if (confirmButton) confirmButton.disabled = false;
    syncUserBatchSelection();
  }
  if (result) await Promise.all([loadUsers(), loadGovernanceDashboard({ force: true })]);
}

function buildAdminUserListParams({ limit, offset }) {
  const role = adminState.userListRole === "admin" ? "admin" : "customer";
  const params = new URLSearchParams({
    role,
    limit: String(limit),
    offset: String(offset),
  });
  Object.entries(adminState.userListFilters).forEach(([key, value]) => {
    if (value !== "" && value !== null && value !== undefined) params.set(key, String(value));
  });
  return params;
}

async function selectAllFilteredUsers() {
  const total = Math.max(0, Number(adminState.userListTotal || 0));
  if (total > 5000) throw new Error("筛选结果超过 5000 个，请缩小筛选范围后再全选");
  adminState.selectedUserIds.clear();
  const pageSize = 1000;
  for (let offset = 0; offset < total; offset += pageSize) {
    const params = buildAdminUserListParams({ limit: pageSize, offset });
    const payload = await api(`/api/admin/users?${params.toString()}`);
    const rows = Array.isArray(payload.items) ? payload.items : [];
    rows.forEach((user) => {
      if (!user.is_admin) {
        adminState.selectedUserIds.add(String(user.id));
        rememberUserBatchSelectionMeta(user);
      }
    });
    if (rows.length < pageSize) break;
  }
  resetUserBatchRequest();
}

async function loadUsers(page = adminState.userListPage) {
  const pageSize = Math.max(1, Number(adminState.userListPageSize || 20));
  const requestedPage = Math.max(1, Math.floor(Number(page || 1)));
  adminState.userListPage = requestedPage;
  const requestId = ++adminState.userListRequestId;
  const role = adminState.userListRole === "admin" ? "admin" : "customer";
  const params = buildAdminUserListParams({
    limit: pageSize,
    offset: (requestedPage - 1) * pageSize,
  });
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
    emptyCell.colSpan = 11;
    emptyCell.textContent = role === "admin" ? "暂无管理员账号" : "暂无客户账号";
    markAdminDynamicUiElement(emptyCell);
    emptyRow.appendChild(emptyCell);
    body.appendChild(emptyRow);
    return;
  }
  rows.forEach((u) => {
    rememberUserBatchSelectionMeta(u);
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
      markAdminDynamicUiElement(checkbox);
      checkbox.checked = adminState.selectedUserIds.has(String(u.id));
      selectCell.appendChild(checkbox);
    }
    tr.appendChild(selectCell);
    const accountCell = document.createElement("td");
    accountCell.className = "admin-user-account-cell";
    const accountName = document.createElement("strong");
    accountName.id = `admin-user-name-${u.id}`;
    accountName.textContent = String(u.username || "-");
    const accountId = document.createElement("span");
    accountId.textContent = `ID ${u.id}`;
    const accountEmail = document.createElement("span");
    accountEmail.className = "admin-user-account-email";
    accountEmail.textContent = u.verified_email ? String(u.verified_email) : "未绑定验证邮箱";
    accountCell.append(accountName, accountId, accountEmail);
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

    const auth = normalizeUserAuthMethods(u);
    const authCell = document.createElement("td");
    authCell.className = "admin-user-auth-cell";
    const authBadges = document.createElement("div");
    authBadges.className = "admin-user-auth-badges";
    authBadges.appendChild(createAdminUserBadge(
      auth.passwordConfigured ? (auth.passwordEnabled ? "密码" : "密码停用") : "无密码",
      auth.passwordEnabled ? "enabled" : "disabled",
    ));
    authBadges.appendChild(createAdminUserBadge(
      auth.googleBound ? (auth.googleEnabled ? "Google" : "Google 停用") : "未绑 Google",
      auth.googleEnabled ? "enabled" : "disabled",
    ));
    const lastMethod = document.createElement("span");
    lastMethod.textContent = `最近：${userLoginMethodLabel(u.last_login_method)}`;
    authCell.append(authBadges, lastMethod);
    tr.appendChild(authCell);

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
      markAdminDynamicUiElement(balanceCell);
    }
    tr.appendChild(balanceCell);

    const actions = document.createElement("td");
    actions.className = "admin-user-actions";
    const addAction = (label, act, icon, extra = {}) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ghost admin-user-icon-button${act === "archive_user" ? " is-danger" : ""}`;
      button.innerHTML = ADMIN_USER_ICONS[icon] || ADMIN_USER_ICONS.detail;
      const actionLabel = createAdminDynamicUiText(label);
      actionLabel.id = `admin-user-action-${u.id}-${act}`;
      actionLabel.className = "admin-user-action-label";
      button.appendChild(actionLabel);
      button.setAttribute("aria-labelledby", `${actionLabel.id} ${accountName.id}`);
      button.title = label;
      button.dataset.act = act;
      button.dataset.id = String(u.id);
      Object.entries(extra).forEach(([key, value]) => { button.dataset[key] = String(value); });
      markAdminDynamicUiElement(button);
      actions.appendChild(button);
    };
    addAction("查看", "user_detail", "detail");
    if (!u.is_admin) addAction("详情", "billing_detail", "billing", { name: u.username });
    if (!u.is_admin) {
      if (lifecycle === "deleted") addAction("恢复", "restore_user", "restore", { name: u.username });
      else addAction("删除", "archive_user", "delete", { name: u.username });
    }
    tr.appendChild(actions);
    body.appendChild(tr);
  });
  syncUserBatchSelection();
  if (focusSelector) body.querySelector(focusSelector)?.focus();
}

function detailRow(label, value, field = "") {
  const row = document.createElement("div");
  row.className = "admin-user-detail-item";
  if (field) row.dataset.userDetailField = field;
  const title = document.createElement("span");
  const content = document.createElement("strong");
  title.textContent = label;
  content.textContent = String(value === null || value === undefined || value === "" ? "-" : value);
  row.append(title, content);
  return row;
}

function syncSelectedUserAuthControls() {
  const user = adminState.selectedUser;
  const section = el("userAuthSection");
  if (!section) return;
  const hidden = !user || !!user.is_admin;
  section.hidden = hidden;
  if (hidden) return;
  const auth = normalizeUserAuthMethods(user);
  const archived = Number(user.deleted_at || 0) > 0 || ["archived", "deleted"].includes(String(user.lifecycle_status || ""));
  const busy = Boolean(adminState.userAuthMethodsInFlight);
  const passwordToggle = el("userPasswordLoginEnabled");
  const googleToggle = el("userGoogleLoginEnabled");
  const saveButton = el("btnSaveUserAuthMethods");
  const unlinkButton = el("btnUnlinkUserGoogle");
  const verifiedEmail = String(user.verified_email || "");
  const verifiedAt = Number(user.email_verified_at || 0);

  setText("userVerifiedEmail", verifiedEmail || "未绑定");
  setText(
    "userVerifiedEmailMeta",
    verifiedEmail && verifiedAt ? `验证于 ${formatTime(verifiedAt)}` : "该账号没有可用于登录的已验证邮箱",
  );
  const emailBadge = el("userEmailVerificationBadge");
  if (emailBadge) {
    emailBadge.textContent = verifiedEmail ? "已验证" : "未验证";
    emailBadge.className = `admin-user-badge admin-user-badge-${verifiedEmail ? "enabled" : "disabled"}`;
  }

  if (passwordToggle) {
    passwordToggle.checked = auth.passwordEnabled;
    passwordToggle.disabled = busy || archived || !auth.passwordConfigured;
  }
  setText(
    "userPasswordAuthHint",
    auth.passwordConfigured
      ? (auth.passwordEnabled ? "已启用邮箱或用户名 + 密码登录" : "已配置密码，但当前禁止密码登录")
      : "尚未设置本地密码，请先在下方设置密码",
  );

  if (googleToggle) {
    googleToggle.checked = auth.googleEnabled;
    googleToggle.disabled = busy || archived || !auth.googleBound;
  }
  setText(
    "userGoogleAuthHint",
    auth.googleBound
      ? (auth.googleEnabled ? "已绑定且允许 Google 登录" : "已绑定，但当前禁止 Google 登录")
      : "尚未绑定 Google 身份",
  );

  if (saveButton) {
    saveButton.disabled = busy || archived;
    saveButton.textContent = busy ? "正在保存..." : "保存认证设置";
  }
  if (unlinkButton) {
    unlinkButton.hidden = !auth.googleBound;
    unlinkButton.disabled = busy || archived || !auth.passwordEnabled;
    unlinkButton.title = auth.passwordEnabled
      ? "解除该账号的 Google 身份绑定"
      : "解绑前必须先启用密码登录，避免用户失去全部登录方式";
  }
}

function applySelectedUserAuthMethods(authMethods) {
  if (!adminState.selectedUser || !authMethods || typeof authMethods !== "object") return;
  adminState.selectedUser.auth_methods = authMethods;
  const password = authMethods.password;
  if (password && typeof password === "object") {
    adminState.selectedUser.password_configured = Boolean(password.configured);
    adminState.selectedUser.password_login_enabled = Boolean(password.enabled);
  }
  const google = authMethods.google;
  if (google && typeof google === "object") {
    adminState.selectedUser.google_identity_bound = Boolean(google.bound);
    adminState.selectedUser.google_login_enabled = Boolean(google.enabled);
  }
  const authSummary = document.querySelector('[data-user-detail-field="auth-methods"] strong');
  if (authSummary) authSummary.textContent = userAuthMethodsLabel(adminState.selectedUser);
}

async function saveSelectedUserAuthMethods() {
  const user = adminState.selectedUser;
  if (!user?.id || user.is_admin || adminState.userAuthMethodsInFlight) return;
  const current = normalizeUserAuthMethods(user);
  const next = {
    password_login_enabled: Boolean(el("userPasswordLoginEnabled")?.checked),
    google_login_enabled: Boolean(el("userGoogleLoginEnabled")?.checked),
  };
  if (next.password_login_enabled && !current.passwordConfigured) {
    setMsg("userAuthMethodMsg", "该账号尚未设置本地密码，不能启用密码登录。", false);
    return;
  }
  if (next.google_login_enabled && !current.googleBound) {
    setMsg("userAuthMethodMsg", "该账号尚未绑定 Google 身份，不能启用 Google 登录。", false);
    return;
  }
  if (!next.password_login_enabled && !next.google_login_enabled) {
    setMsg("userAuthMethodMsg", "必须至少保留一种可用登录方式。", false);
    return;
  }
  if (
    next.password_login_enabled === current.passwordEnabled
    && next.google_login_enabled === current.googleEnabled
  ) {
    setMsg("userAuthMethodMsg", "认证设置没有变化。", true);
    return;
  }
  const decision = await requestAdminPublicAction({
    title: "更新登录方式",
    message: `确认更新账号 ${user.username || user.id} 的登录方式吗？被停用的方式将立即无法用于新登录。`,
    confirmLabel: "确认更新",
  });
  if (!decision.confirmed) {
    syncSelectedUserAuthControls();
    return;
  }
  const targetUserId = String(user.id);
  adminState.userAuthMethodsInFlight = true;
  setMsg("userAuthMethodMsg", "");
  syncSelectedUserAuthControls();
  syncUserDetailActionState();
  try {
    const result = await api(`/api/admin/users/${encodeURIComponent(targetUserId)}/auth-methods`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (!selectedUserStillMatches(targetUserId)) return;
    applySelectedUserAuthMethods(result.auth_methods || {
      password: { configured: current.passwordConfigured, enabled: next.password_login_enabled },
      google: { bound: current.googleBound, enabled: next.google_login_enabled },
    });
    setMsg("userAuthMethodMsg", "认证方式已更新。", true);
    await loadUsers();
  } catch (error) {
    if (selectedUserStillMatches(targetUserId)) {
      setMsg("userAuthMethodMsg", getErrorMessage(error), false);
      syncSelectedUserAuthControls();
    }
  } finally {
    adminState.userAuthMethodsInFlight = false;
    if (selectedUserStillMatches(targetUserId)) {
      syncSelectedUserAuthControls();
      syncUserDetailActionState();
    }
  }
}

async function unlinkSelectedUserGoogle() {
  const user = adminState.selectedUser;
  if (!user?.id || user.is_admin || adminState.userAuthMethodsInFlight) return;
  const current = normalizeUserAuthMethods(user);
  if (!current.googleBound) return;
  if (!current.passwordEnabled) {
    setMsg("userAuthMethodMsg", "请先启用密码登录，再解绑 Google，避免用户失去全部登录方式。", false);
    return;
  }
  const decision = await requestAdminPublicAction({
    title: "解绑 Google 身份",
    message: `确认解绑账号 ${user.username || user.id} 的 Google 身份吗？解绑后只能使用邮箱或用户名密码登录。`,
    confirmLabel: "确认解绑",
    tone: "danger",
  });
  if (!decision.confirmed) return;
  const targetUserId = String(user.id);
  adminState.userAuthMethodsInFlight = true;
  setMsg("userAuthMethodMsg", "");
  syncSelectedUserAuthControls();
  syncUserDetailActionState();
  try {
    const result = await api(`/api/admin/users/${encodeURIComponent(targetUserId)}/oauth-identities/google`, {
      method: "DELETE",
    });
    if (!selectedUserStillMatches(targetUserId)) return;
    applySelectedUserAuthMethods(result.auth_methods || {
      password: { configured: current.passwordConfigured, enabled: current.passwordEnabled },
      google: { bound: false, enabled: false },
    });
    setMsg("userAuthMethodMsg", "Google 身份已解绑。", true);
    await loadUsers();
  } catch (error) {
    if (selectedUserStillMatches(targetUserId)) setMsg("userAuthMethodMsg", getErrorMessage(error), false);
  } finally {
    adminState.userAuthMethodsInFlight = false;
    if (selectedUserStillMatches(targetUserId)) {
      syncSelectedUserAuthControls();
      syncUserDetailActionState();
    }
  }
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
  const decision = await requestAdminPublicAction({
    title: "查看当前密码",
    message: `确认查看账号 ${user.username || user.id} 的当前登录密码吗？请确保周围没有无关人员。`,
    confirmLabel: "确认查看",
  });
  if (!decision.confirmed) return;
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
  const busy = adminState.userPasswordResetInFlight
    || adminState.userPasswordSetInFlight
    || adminState.userAuthMethodsInFlight;
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
  syncSelectedUserAuthControls();
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
  const decision = await requestAdminPublicAction({
    title: "修改登录密码",
    message: `确认修改账号 ${user.username || user.id} 的登录密码吗？该账号现有登录会话会立即失效。`,
    confirmLabel: "确认修改",
  });
  if (!decision.confirmed) return;

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
    adminState.selectedUser.password_configured = true;
    if (adminState.selectedUser.auth_methods?.password) {
      adminState.selectedUser.auth_methods.password.configured = true;
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
  const decision = await requestAdminPublicAction({
    title: "重置登录密码",
    message: `确认重置账号 ${user.username || user.id} 的登录密码吗？该账号现有登录会话会立即失效。`,
    confirmLabel: "确认重置",
    tone: "danger",
  });
  if (!decision.confirmed) return;
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
    adminState.selectedUser.password_configured = true;
    if (adminState.selectedUser.auth_methods?.password) {
      adminState.selectedUser.auth_methods.password.configured = true;
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
    container.appendChild(markAdminDynamicUiElement(createEmptyState("该账号没有登录会话")));
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  items.forEach((item) => {
    const active = !Number(item.revoked_at || 0) && Number(item.expires_at || 0) > now;
    const row = document.createElement("div");
    row.className = "admin-session-item";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.append(
      item.device_id ? String(item.device_id) : createAdminDynamicUiText("未知设备"),
      " · ",
      item.ip_address ? String(item.ip_address) : createAdminDynamicUiText("未知 IP"),
    );
    const detail = document.createElement("span");
    detail.append(
      item.user_agent ? oneLine(item.user_agent) : createAdminDynamicUiText("未知客户端"),
      " · ",
      createAdminDynamicUiText("最近活动"),
      ` ${formatTime(item.last_seen_at || item.created_at)} · `,
    );
    if (item.revoked_at) {
      detail.append(createAdminDynamicUiText("撤销于"), ` ${formatTime(item.revoked_at)}`);
      if (item.revoke_reason) detail.append(" · ", String(item.revoke_reason));
    } else {
      detail.append(createAdminDynamicUiText("到期"), ` ${formatTime(item.expires_at)}`);
    }
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
  const decision = await requestAdminPublicAction({
    title: "撤销登录会话",
    message: `确认撤销账号 ${user.username || user.id} 的全部有效登录会话吗？`,
    confirmLabel: "确认撤销",
    tone: "danger",
  });
  if (!decision.confirmed) return;
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
    container.appendChild(markAdminDynamicUiElement(createEmptyState("没有可恢复的密码历史")));
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
    if (Number(item.restored_at || 0)) {
      detail.append(
        createAdminDynamicUiText("已于"),
        ` ${formatTime(item.restored_at)} `,
        createAdminDynamicUiText("恢复"),
      );
    } else {
      detail.append(
        createAdminDynamicUiText("有效至"),
        ` ${formatTime(item.expires_at)} · `,
        createAdminDynamicUiText("操作者"),
        " ",
        item.actor_user_id ? String(item.actor_user_id) : createAdminDynamicUiText("用户本人"),
      );
    }
    copy.append(title, detail);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = available ? "恢复此密码" : "不可恢复";
    button.disabled = !available;
    button.dataset.passwordRestore = String(item.id || "");
    markAdminDynamicUiElement(button);
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
  const decision = await requestAdminPublicAction({
    title: "恢复历史密码",
    message: `确认恢复账号 ${user.username || user.id} 的历史密码吗？该账号现有登录会话会立即失效。`,
    confirmLabel: "确认恢复",
    tone: "danger",
  });
  if (!decision.confirmed) return;
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
  const decision = await requestAdminPublicAction({
    title: "永久删除客户",
    message: `最后确认：永久删除 ${user.username} 及其全部关联资源？此操作无法撤销。`,
    confirmLabel: "永久删除",
    tone: "danger",
  });
  if (!decision.confirmed) return;
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
  if (adminState.userPasswordResetInFlight || adminState.userPasswordSetInFlight || adminState.userAuthMethodsInFlight) {
    setMsg("userDetailMsg", "账号设置正在保存，请等待操作完成后再切换账号。", false);
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
    detailRow("资料邮箱", user.email),
    detailRow("已验证登录邮箱", user.verified_email || "未绑定"),
    detailRow("邮箱验证时间", user.email_verified_at ? formatTime(user.email_verified_at) : "尚未验证"),
    detailRow("联系电话", user.phone),
    detailRow("账号角色", user.is_admin ? "管理员" : "客户"),
    detailRow("账号状态", (USER_LIFECYCLE_META[String(user.lifecycle_status || "")] || [user.is_disabled ? "已禁用" : "已启用"])[0]),
    detailRow(
      "密码状态",
      user.password_configured
        ? (user.password_reveal_available === false ? "已设置（历史账号，重置后可查看）" : "已设置")
        : "未设置",
    ),
    detailRow("可用认证方式", userAuthMethodsLabel(user), "auth-methods"),
    detailRow("最近登录方式", userLoginMethodLabel(user.last_login_method)),
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
  setMsg("userAuthMethodMsg", "");
  syncSelectedUserAuthControls();
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
  if (adminState.userPasswordResetInFlight || adminState.userPasswordSetInFlight || adminState.userAuthMethodsInFlight) {
    setMsg("userDetailMsg", "账号设置正在保存，完成前不能关闭此窗口。", false);
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
  setMsg("userAuthMethodMsg", "");
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
  if (lastUpdated) lastUpdated.textContent = `最近刷新：${new Date().toLocaleTimeString("zh-CN", { timeZone: ADMIN_TIME_ZONE, hour12: false })}`;
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
  return markAdminDynamicUiElement(badge);
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
    "series-success": { border: "#356b91", background: "rgba(53, 107, 145, 0.10)" },
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
    ["数据库", health.database || "unknown", "连接与查询", true],
    [
      "密码保险库",
      vault.healthy ? "healthy" : "degraded",
      vault.error || vault.status || "加密密钥检查",
      !vault.error && !vault.status,
    ],
    [
      "计费执行",
      health.billing_enforcement ? "active" : "disabled",
      health.billing_enforcement ? "已启用" : "未启用",
      true,
    ],
  ];
  container.replaceChildren();
  rows.forEach(([name, status, detail, detailIsUi]) => {
    const row = document.createElement("div");
    row.className = "admin-health-row";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.appendChild(createAdminDynamicUiText(name));
    const description = document.createElement("span");
    if (detailIsUi) description.appendChild(createAdminDynamicUiText(detail));
    else description.textContent = String(detail || "-");
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
  const emailDelivery = payload.email_delivery || {};
  adminState.emailDeliveryOverview = emailDelivery;
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
  setText("govKpiConsumedTotal", Number(summary.lifetime_consumed_points || 0));
  const emailRequests = Math.max(0, Number(emailDelivery.requests_today || 0));
  const emailLocalGuard = Math.max(0, Number(emailDelivery.local_guard_units || 0));
  const emailAccountedRequests = emailRequests + emailLocalGuard;
  const emailDelivered = Math.max(0, Number(emailDelivery.delivered_today || 0));
  const emailFailed = Math.max(0, Number(emailDelivery.failed_today || 0));
  setText("govKpiEmailSummary", emailAccountedRequests);
  setText(
    "govKpiEmailSummaryMeta",
    `今日投递 ${emailDelivered} · 失败 ${emailFailed}${emailLocalGuard ? ` · 待同步 ${emailLocalGuard}` : ""}`,
  );
  const effectiveEmailLimit = Number(emailDelivery.effective_daily_limit);
  const hasEmailLimit = Number.isFinite(effectiveEmailLimit) && effectiveEmailLimit > 0;
  setText("govKpiEmailLimit", hasEmailLimit ? effectiveEmailLimit : "不可用");
  const emailLimitParts = [];
  if (hasEmailLimit) {
    emailLimitParts.push(`已用 ${emailAccountedRequests}`);
    emailLimitParts.push(`剩余 ${Math.max(0, Number(emailDelivery.remaining_today || 0))}`);
  }
  emailLimitParts.push(emailDelivery.mode === "manual" ? "自定义" : "自动同步");
  if (emailDelivery.stale) emailLimitParts.push("数据延迟");
  setText("govKpiEmailLimitMeta", emailLimitParts.join(" · "));
  setText("adminAlertCount", Number(summary.open_alerts || 0));
  const healthLabel = governanceLabel(summary.service_health || "unknown");
  setText("govKpiHealth", healthLabel);
  setText("govKpiHealthMeta", health.password_vault?.healthy === false ? "密码保险库异常" : "关键依赖可用");
  const healthKpi = el("govKpiHealth")?.closest(".admin-governance-kpi");
  healthKpi?.classList.toggle("is-danger", String(summary.service_health) !== "healthy");
  healthKpi?.classList.toggle("is-health", String(summary.service_health) === "healthy");
  updateGovernanceChart("governanceUsersChart", payload.trends?.users || [], [
    { key: "created", className: "series-blue" },
    { key: "activated", className: "series-success" },
  ]);
  updateGovernanceChart("governanceTasksChart", payload.trends?.tasks || [], [
    { key: "success", className: "series-success" },
    { key: "failed", className: "series-red" },
  ]);
  updateGovernanceChart("governanceBillingChart", payload.trends?.billing || [], [
    { key: "credited_units", className: "series-blue" },
    { key: "consumed_units", className: "series-red" },
    { key: "refunded_units", className: "series-success" },
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
  setText("governanceUpdatedAt", generatedAt ? `数据时间：${formatTime(generatedAt)}` : `刷新于 ${new Date().toLocaleTimeString("zh-CN", { timeZone: ADMIN_TIME_ZONE, hour12: false })}`);
}

function syncEmailDeliveryPolicyFields() {
  const mode = String(el("emailDeliveryLimitMode")?.value || "auto");
  const manualField = el("emailDeliveryManualLimitField");
  if (manualField) manualField.hidden = mode !== "manual";
  const manualInput = el("emailDeliveryManualLimit");
  if (manualInput) manualInput.setCustomValidity("");
}

function emailDeliveryPolicyPreviewText(overview = {}) {
  const requests = Math.max(0, Number(overview.requests_today || 0))
    + Math.max(0, Number(overview.local_guard_units || 0));
  const remaining = Number(overview.provider_remaining_credits);
  const remainingText = Number.isFinite(remaining) && remaining >= 0 ? String(remaining) : "未知";
  return `今日请求 ${requests} · Brevo 可用额度 ${remainingText}`;
}

function validateEmailDeliveryManualLimit(value) {
  const normalized = String(value == null ? "" : value).trim();
  if (!normalized) return "请输入自定义每日上限。";
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1) return "自定义每日上限必须是大于 0 的整数。";
  if (parsed > EMAIL_DELIVERY_MANUAL_LIMIT_MAX) {
    return "自定义每日上限不能超过 10,000,000 封。";
  }
  return "";
}

function formatEmailDeliveryPolicyError(error) {
  const details = Array.isArray(error?.detail) ? error.detail : null;
  if (details?.length) {
    const manualIssue = details.find((issue) => {
      const location = Array.isArray(issue?.loc) ? issue.loc : [];
      return location.includes("manual_daily_limit");
    });
    if (manualIssue) {
      const type = String(manualIssue.type || "");
      const maximum = Number(manualIssue.ctx?.le);
      if (type.includes("less_than_equal") || maximum === EMAIL_DELIVERY_MANUAL_LIMIT_MAX) {
        return "自定义每日上限不能超过 10,000,000 封。";
      }
      if (type.includes("missing")) return "请输入自定义每日上限。";
      return "自定义每日上限必须是 1 至 10,000,000 之间的整数。";
    }
    const modeIssue = details.find((issue) => {
      const location = Array.isArray(issue?.loc) ? issue.loc : [];
      return location.includes("mode");
    });
    if (modeIssue) return "请选择有效的邮件额度模式。";
    return "提交的额度设置不符合要求，请检查后重试。";
  }
  if (typeof error?.detail?.message === "string" && error.detail.message.trim()) {
    return error.detail.message.trim();
  }
  if (typeof error?.detail === "string" && error.detail.trim()) return error.detail.trim();
  if (typeof error?.message === "string" && error.message.trim()) return error.message.trim();
  return "邮件额度策略保存失败，请稍后重试。";
}

function emailDeliveryPolicyFocusableElements() {
  const dialog = el("emailDeliveryPolicyDialog");
  if (!dialog) return [];
  return Array.from(dialog.querySelectorAll(
    'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((node) => (
    !node.hidden
    && node.getAttribute("aria-hidden") !== "true"
    && node.getClientRects().length > 0
  ));
}

function handleEmailDeliveryPolicyModalKeydown(event) {
  const modal = el("emailDeliveryPolicyModal");
  if (!modal || modal.getAttribute("aria-hidden") === "true") return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeEmailDeliveryPolicyModal();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = emailDeliveryPolicyFocusableElements();
  if (!focusable.length) {
    event.preventDefault();
    el("emailDeliveryPolicyDialog")?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openEmailDeliveryPolicyModal() {
  const modal = el("emailDeliveryPolicyModal");
  if (!modal) return;
  adminState.emailDeliveryPolicyReturnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : el("btnEmailDeliveryPolicy");
  const overview = adminState.emailDeliveryOverview || {};
  const mode = overview.mode === "manual" ? "manual" : "auto";
  if (el("emailDeliveryLimitMode")) el("emailDeliveryLimitMode").value = mode;
  if (el("emailDeliveryManualLimit")) {
    el("emailDeliveryManualLimit").value = Number(overview.manual_daily_limit) > 0
      ? String(Math.trunc(Number(overview.manual_daily_limit)))
      : "";
  }
  setText("emailDeliveryPolicyPreview", emailDeliveryPolicyPreviewText(overview));
  setText(
    "emailDeliveryPolicySyncMeta",
    overview.synced_at
      ? `${overview.stale ? "最近一次有效同步" : "最近同步"}：${formatTime(overview.synced_at)}`
      : "尚未取得 Brevo 配额，请检查服务端配置。",
  );
  setMsg(
    "emailDeliveryPolicyMsg",
    overview.sync_error ? `同步失败：${overview.sync_error}` : "",
    !overview.sync_error,
  );
  syncEmailDeliveryPolicyFields();
  modal.style.display = "grid";
  modal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => el("emailDeliveryLimitMode")?.focus(), 0);
}

function closeEmailDeliveryPolicyModal() {
  const modal = el("emailDeliveryPolicyModal");
  if (!modal) return;
  const controller = adminState.emailDeliveryPolicySaveController;
  if (modal.getAttribute("aria-hidden") === "true" && !controller) return;
  if (controller && !controller.signal.aborted) {
    adminState.emailDeliveryPolicyAbortReason = "cancelled";
    controller.abort();
  }
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
  const returnFocus = adminState.emailDeliveryPolicyReturnFocus;
  adminState.emailDeliveryPolicyReturnFocus = null;
  window.setTimeout(() => {
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    else el("btnEmailDeliveryPolicy")?.focus();
  }, 0);
}

async function saveEmailDeliveryPolicy() {
  if (adminState.emailDeliveryPolicySaving) return;
  const mode = String(el("emailDeliveryLimitMode")?.value || "auto");
  const manualInput = el("emailDeliveryManualLimit");
  const manualValidation = mode === "manual"
    ? validateEmailDeliveryManualLimit(manualInput?.value)
    : "";
  if (manualInput) manualInput.setCustomValidity(manualValidation);
  if (manualValidation) {
    setMsg("emailDeliveryPolicyMsg", manualValidation, false);
    manualInput?.reportValidity();
    manualInput?.focus();
    return;
  }
  const manualValue = Number(manualInput?.value || 0);
  adminState.emailDeliveryPolicySaving = true;
  adminState.emailDeliveryPolicyAbortReason = "";
  const controller = new AbortController();
  adminState.emailDeliveryPolicySaveController = controller;
  const timeoutId = window.setTimeout(() => {
    if (controller.signal.aborted) return;
    adminState.emailDeliveryPolicyAbortReason = "timeout";
    controller.abort();
  }, EMAIL_DELIVERY_POLICY_SAVE_TIMEOUT_MS);
  const saveButton = el("btnEmailDeliveryPolicySave");
  if (saveButton) saveButton.disabled = true;
  setMsg("emailDeliveryPolicyMsg", "正在保存并同步 Brevo 额度…");
  try {
    const result = await api("/api/admin/email-delivery-policy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        manual_daily_limit: mode === "manual" ? manualValue : null,
      }),
      signal: controller.signal,
    });
    adminState.emailDeliveryOverview = result?.email_delivery || adminState.emailDeliveryOverview;
    setMsg("emailDeliveryPolicyMsg", "邮件额度策略已更新。", true);
    void loadGovernanceDashboard({ force: true }).catch(() => {});
    window.setTimeout(() => closeEmailDeliveryPolicyModal(), 250);
  } catch (error) {
    const abortReason = adminState.emailDeliveryPolicyAbortReason;
    if (abortReason === "timeout") {
      setMsg("emailDeliveryPolicyMsg", "保存等待超过 30 秒，请确认网络或 Brevo 服务状态后重试。", false);
    } else if (abortReason !== "cancelled") {
      setMsg("emailDeliveryPolicyMsg", `保存失败：${formatEmailDeliveryPolicyError(error)}`, false);
    }
  } finally {
    window.clearTimeout(timeoutId);
    if (adminState.emailDeliveryPolicySaveController === controller) {
      adminState.emailDeliveryPolicySaveController = null;
      adminState.emailDeliveryPolicyAbortReason = "";
    }
    adminState.emailDeliveryPolicySaving = false;
    if (saveButton) saveButton.disabled = false;
  }
}

function syncGovernanceRangeControls() {
  const custom = String(el("governanceRange")?.value || "30") === "custom";
  const endInput = el("governanceEndDate");
  const startInput = el("governanceStartDate");
  if (startInput && !startInput.value) startInput.value = formatShanghaiDateInputValue(new Date(Date.now() - 29 * 86400000));
  if (endInput && !endInput.value) endInput.value = formatShanghaiDateInputValue(new Date());
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
  const pageSize = Math.max(1, Number(adminState.auditListPageSize || 20));
  const page = Math.max(1, Number(adminState.auditListPage || 1));
  const query = new URLSearchParams({
    limit: String(pageSize),
    offset: String((page - 1) * pageSize),
  });
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
  const total = Math.max(0, Number(payload.total || rows.length));
  const pageSize = Math.max(1, Number(adminState.auditListPageSize || 20));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  adminState.auditListTotal = total;
  adminState.auditListPage = Math.min(Math.max(1, Number(adminState.auditListPage || 1)), totalPages);
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
  setText("auditResultSummary", `第 ${adminState.auditListPage} / ${totalPages} 页 · 共 ${total} 条`);
  if (el("auditPagination")) el("auditPagination").hidden = !total;
  setText("auditPaginationSummary", `共 ${total} 条审计日志 · 每页 ${pageSize} 条`);
  setText("auditPageIndicator", `第 ${adminState.auditListPage} / ${totalPages} 页`);
  if (el("btnAuditPagePrev")) el("btnAuditPagePrev").disabled = adminState.auditListPage <= 1;
  if (el("btnAuditPageNext")) el("btnAuditPageNext").disabled = adminState.auditListPage >= totalPages;
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
  const pageSize = Math.max(1, Number(adminState.securityListPageSize || 20));
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  adminState.securityListPage = Math.min(
    Math.max(1, Number(adminState.securityListPage || 1)),
    totalPages,
  );
  const pageStart = (adminState.securityListPage - 1) * pageSize;
  const pageRows = rows.slice(pageStart, pageStart + pageSize);
  adminState.securityRows = rows;
  container.replaceChildren();
  if (!rows.length) {
    container.appendChild(markAdminDynamicUiElement(createEmptyState("当前筛选条件下没有安全告警")));
    if (el("securityPagination")) el("securityPagination").hidden = true;
    return;
  }
  pageRows.forEach((item) => {
    const article = document.createElement("article");
    article.className = `admin-security-alert is-${String(item.severity || "low").toLowerCase()}`;
    const copy = document.createElement("div");
    copy.className = "admin-security-alert-copy";
    const title = document.createElement("strong");
    if (item.title || item.alert_type) title.textContent = String(item.title || item.alert_type);
    else title.appendChild(createAdminDynamicUiText("安全告警"));
    const summary = document.createElement("span");
    if (item.summary) summary.textContent = oneLine(item.summary);
    else summary.appendChild(createAdminDynamicUiText("无摘要"));
    copy.append(title, summary);
    const meta = document.createElement("div");
    meta.className = "admin-security-alert-meta";
    meta.append(createGovernanceBadge(item.severity), createGovernanceBadge(item.status));
    const seen = document.createElement("span");
    seen.append(
      createAdminDynamicUiText("最近："),
      formatTime(item.last_seen_at || item.updated_at),
      " · ",
      createAdminDynamicUiText("用户"),
      ` ${item.target_user_id || "-"}`,
    );
    meta.appendChild(seen);
    const actions = document.createElement("div");
    actions.className = "admin-security-alert-actions";
    const status = document.createElement("select");
    status.setAttribute("aria-label", `${title.textContent} 状态`);
    markAdminDynamicUiElement(status);
    ["open", "acknowledged", "investigating", "resolved", "ignored"].forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = governanceLabel(value);
      option.selected = String(item.status) === value;
      markAdminDynamicUiElement(option);
      status.appendChild(option);
    });
    const note = document.createElement("input");
    note.maxLength = 2000;
    note.placeholder = "处置备注";
    note.setAttribute("aria-label", `处置备注 ${item.id}`);
    markAdminDynamicUiElement(note);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "保存";
    save.dataset.securitySave = String(item.id || "");
    save.dataset.statusControl = "";
    markAdminDynamicUiElement(save);
    actions.append(status, note, save);
    article.append(copy, meta, actions);
    container.appendChild(article);
  });
  if (el("securityPagination")) el("securityPagination").hidden = false;
  setText("securityPaginationSummary", `共 ${rows.length} 条安全告警 · 每页 ${pageSize} 条`);
  setText("securityPageIndicator", `第 ${adminState.securityListPage} / ${totalPages} 页`);
  if (el("btnSecurityPagePrev")) el("btnSecurityPagePrev").disabled = adminState.securityListPage <= 1;
  if (el("btnSecurityPageNext")) el("btnSecurityPageNext").disabled = adminState.securityListPage >= totalPages;
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
  const date = value ? new Date(`${value}:00+08:00`) : null;
  return date && Number.isFinite(date.getTime()) ? Math.floor(date.getTime() / 1000) : 0;
}

function localInputFromTimestamp(value) {
  const date = new Date(Number(value || 0) * 1000);
  if (!Number(value) || !Number.isFinite(date.getTime())) return "";
  return formatShanghaiDateTimeInputValue(date);
}

function setDefaultServiceAccountExpiry() {
  const input = el("serviceAccountExpiresAt");
  if (!input || input.value) return;
  const expires = new Date(Date.now() + 30 * 86400000);
  input.value = formatShanghaiDateTimeInputValue(expires);
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
    cell.appendChild(markAdminDynamicUiElement(createEmptyState("尚未创建服务账号")));
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
    purpose.setAttribute("aria-label", `用途 ${item.id}`);
    markAdminDynamicUiElement(purpose);
    purposeCell.appendChild(purpose);
    row.appendChild(purposeCell);
    const scopeCell = document.createElement("td");
    const scopes = document.createElement("input");
    scopes.value = (item.allowed_scopes || []).join(", ");
    scopes.setAttribute("aria-label", `权限范围 ${item.id}`);
    markAdminDynamicUiElement(scopes);
    scopeCell.appendChild(scopes);
    row.appendChild(scopeCell);
    const statusCell = document.createElement("td");
    const status = document.createElement("select");
    status.setAttribute("aria-label", `服务账号状态 ${item.id}`);
    markAdminDynamicUiElement(status);
    ["active", "disabled", "revoked"].forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = governanceLabel(value);
      option.selected = String(item.status) === value;
      markAdminDynamicUiElement(option);
      status.appendChild(option);
    });
    statusCell.appendChild(status);
    row.appendChild(statusCell);
    const timeCell = document.createElement("td");
    const expires = document.createElement("input");
    expires.type = "datetime-local";
    expires.value = localInputFromTimestamp(item.expires_at);
    expires.setAttribute("aria-label", `到期时间 ${item.id}`);
    markAdminDynamicUiElement(expires);
    const lastUsed = document.createElement("span");
    if (item.last_used_at) {
      lastUsed.append(
        createAdminDynamicUiText("最近使用"),
        ` ${formatTime(item.last_used_at)} · ${item.last_used_ip || "-"}`,
      );
    } else {
      lastUsed.appendChild(createAdminDynamicUiText("尚未使用"));
    }
    timeCell.append(expires, lastUsed);
    row.appendChild(timeCell);
    const actionCell = document.createElement("td");
    actionCell.className = "admin-service-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "保存";
    save.dataset.serviceSave = String(item.id || "");
    markAdminDynamicUiElement(save);
    const rotate = document.createElement("button");
    rotate.type = "button";
    rotate.className = "ghost";
    rotate.textContent = "轮换";
    rotate.dataset.serviceRotate = String(item.id || "");
    rotate.disabled = String(item.status || "") === "revoked";
    markAdminDynamicUiElement(rotate);
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
  const decision = await requestAdminPublicAction({
    title: "轮换服务凭证",
    message: "轮换后旧凭证会立即失效，确认继续吗？",
    confirmLabel: "确认轮换",
    tone: "danger",
  });
  if (!decision.confirmed) return;
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

const PROXY_MARKET_SMART_FIELD_ALIASES = {
  protocol: "proxy_type", proxytype: "proxy_type", type: "proxy_type",
  协议: "proxy_type", 代理协议: "proxy_type", 代理类型: "proxy_type",
  host: "host", hostname: "host", server: "host", serveraddress: "host", address: "host", ip: "host",
  主机: "host", 地址: "host", 服务器: "host", 服务器地址: "host",
  port: "port", 端口: "port",
  username: "username", user: "username", account: "username", login: "username",
  用户名: "username", 用户: "username", 账号: "username",
  password: "password", passwd: "password", pass: "password", pwd: "password", 密码: "password",
  country: "country", countrycode: "country", 国家: "country", 国家地区: "country",
  region: "region", state: "region", province: "region", 地区: "region", 州: "region", 省: "region", 州省: "region",
  city: "city", 城市: "city",
  isp: "isp", operator: "isp", carrier: "isp", 运营商: "isp", 供应商: "isp",
  sku: "sku",
  name: "display_name", displayname: "display_name", 名称: "display_name", 显示名称: "display_name",
  provider: "provider_key", providerkey: "provider_key", 供应商键: "provider_key",
  expires: "expires_at", expiry: "expires_at", expiresat: "expires_at", 到期: "expires_at", 到期时间: "expires_at",
  pricecents: "display_price_cents", 售价分: "display_price_cents",
  currency: "currency", 币种: "currency",
  billingcycle: "billing_cycle", 计费周期: "billing_cycle",
  tags: "tags", 标签: "tags",
  usecases: "use_cases", 用途: "use_cases", 适用场景: "use_cases",
  description: "description", note: "description", 说明: "description", 公开说明: "description",
};

function normalizeProxyMarketSmartKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_.\-/]+/g, "");
}

function normalizeProxyMarketProtocol(value) {
  const clean = String(value || "").trim().toLowerCase().replace(/:$/, "");
  if (["socks", "socks5", "socks5h"].includes(clean)) return "socks5";
  if (clean === "http") return "http";
  if (clean === "https") return "https";
  return "";
}

function decodeProxyMarketCredential(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function proxyMarketCountryAliasKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}

const PROXY_MARKET_ISO_COUNTRY_CODES = `
  AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
  BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
  CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
  DE DJ DK DM DO DZ
  EC EE EG EH ER ES ET
  FI FJ FK FM FO FR
  GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
  HK HM HN HR HT HU
  ID IE IL IM IN IO IQ IR IS IT
  JE JM JO JP
  KE KG KH KI KM KN KP KR KW KY KZ
  LA LB LC LI LK LR LS LT LU LV LY
  MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
  NA NC NE NF NG NI NL NO NP NR NU NZ
  OM
  PA PE PF PG PH PK PL PM PN PR PS PT PW PY
  QA
  RE RO RS RU RW
  SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
  TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
  UA UG UM US UY UZ
  VA VC VE VG VI VN VU
  WF WS
  YE YT
  ZA ZM ZW
`.trim().split(/\s+/);

const PROXY_MARKET_COUNTRY_ALIASES = new Map([
  [["tw", "taiwan", "台湾", "台灣", "中国台湾", "中國台灣"], "TW", "台湾"],
  [["cn", "china", "中国", "中國", "中国大陆", "中國大陸"], "CN", "中国"],
  [["hk", "hong kong", "香港"], "HK", "香港"],
  [["mo", "macau", "macao", "澳门", "澳門"], "MO", "澳门"],
  [["jp", "japan", "日本"], "JP", "日本"],
  [["kr", "south korea", "korea", "韩国", "韓國"], "KR", "韩国"],
  [["sg", "singapore", "新加坡"], "SG", "新加坡"],
  [["my", "malaysia", "马来西亚", "馬來西亞"], "MY", "马来西亚"],
  [["th", "thailand", "泰国", "泰國"], "TH", "泰国"],
  [["vn", "vietnam", "越南"], "VN", "越南"],
  [["ph", "philippines", "菲律宾", "菲律賓"], "PH", "菲律宾"],
  [["id", "indonesia", "印度尼西亚", "印度尼西亞", "印尼"], "ID", "印度尼西亚"],
  [["in", "india", "印度"], "IN", "印度"],
  [["us", "usa", "united states", "united states of america", "美国", "美國"], "US", "美国"],
  [["ca", "canada", "加拿大"], "CA", "加拿大"],
  [["mx", "mexico", "墨西哥"], "MX", "墨西哥"],
  [["br", "brazil", "巴西"], "BR", "巴西"],
  [["ar", "argentina", "阿根廷"], "AR", "阿根廷"],
  [["cl", "chile", "智利"], "CL", "智利"],
  [["co", "colombia", "哥伦比亚", "哥倫比亞"], "CO", "哥伦比亚"],
  [["gb", "uk", "united kingdom", "great britain", "英国", "英國"], "GB", "英国"],
  [["ie", "ireland", "爱尔兰", "愛爾蘭"], "IE", "爱尔兰"],
  [["fr", "france", "法国", "法國"], "FR", "法国"],
  [["de", "germany", "德国", "德國"], "DE", "德国"],
  [["es", "esp", "spain", "espana", "españa", "西班牙"], "ES", "西班牙"],
  [["pt", "portugal", "葡萄牙"], "PT", "葡萄牙"],
  [["it", "italy", "意大利", "义大利", "義大利"], "IT", "意大利"],
  [["nl", "netherlands", "holland", "荷兰", "荷蘭"], "NL", "荷兰"],
  [["be", "belgium", "比利时", "比利時"], "BE", "比利时"],
  [["ch", "switzerland", "瑞士"], "CH", "瑞士"],
  [["at", "austria", "奥地利", "奧地利"], "AT", "奥地利"],
  [["se", "sweden", "瑞典"], "SE", "瑞典"],
  [["no", "norway", "挪威"], "NO", "挪威"],
  [["dk", "denmark", "丹麦", "丹麥"], "DK", "丹麦"],
  [["fi", "finland", "芬兰", "芬蘭"], "FI", "芬兰"],
  [["pl", "poland", "波兰", "波蘭"], "PL", "波兰"],
  [["cz", "czechia", "czech republic", "捷克"], "CZ", "捷克"],
  [["ro", "romania", "罗马尼亚", "羅馬尼亞"], "RO", "罗马尼亚"],
  [["ru", "russia", "俄罗斯", "俄羅斯"], "RU", "俄罗斯"],
  [["ua", "ukraine", "乌克兰", "烏克蘭"], "UA", "乌克兰"],
  [["tr", "turkey", "turkiye", "土耳其"], "TR", "土耳其"],
  [["au", "australia", "澳大利亚", "澳大利亞", "澳洲"], "AU", "澳大利亚"],
  [["nz", "new zealand", "新西兰", "紐西蘭"], "NZ", "新西兰"],
  [["ae", "uae", "united arab emirates", "阿联酋", "阿聯酋"], "AE", "阿联酋"],
  [["sa", "saudi arabia", "沙特阿拉伯", "沙烏地阿拉伯"], "SA", "沙特阿拉伯"],
  [["za", "south africa", "南非"], "ZA", "南非"],
].flatMap(([aliases, code, label]) => (
  aliases.map((alias) => [proxyMarketCountryAliasKey(alias), { code, label }])
)));

function buildProxyMarketIntlCountryAliases() {
  const aliases = new Map();
  const ambiguous = new Set();
  const displayNames = [];
  if (typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function") {
    ["zh-CN", "zh-TW", "en", "es", "pt", "fr", "de", "it", "ja", "ko", "ru"].forEach((locale) => {
      try {
        displayNames.push(new Intl.DisplayNames([locale], { type: "region" }));
      } catch {
        // Keep ISO-code recognition available when a locale is unavailable.
      }
    });
  }
  PROXY_MARKET_ISO_COUNTRY_CODES.forEach((code) => {
    const localizedNames = displayNames
      .map((formatter) => formatter.of(code))
      .filter((name) => name && name.toUpperCase() !== code);
    const entry = {
      code,
      label: localizedNames[0]
        || [...PROXY_MARKET_COUNTRY_ALIASES.values()].find((country) => country.code === code)?.label
        || code,
    };
    aliases.set(proxyMarketCountryAliasKey(code), entry);
    localizedNames.forEach((name) => {
      const key = proxyMarketCountryAliasKey(name);
      if (!key || ambiguous.has(key)) return;
      const existing = aliases.get(key);
      if (existing && existing.code !== code) {
        aliases.delete(key);
        ambiguous.add(key);
        return;
      }
      aliases.set(key, entry);
    });
  });
  return aliases;
}

const PROXY_MARKET_INTL_COUNTRY_ALIASES = buildProxyMarketIntlCountryAliases();

function normalizeProxyMarketCountry(value) {
  const clean = String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(
      /^(?:国家\s*(?:\/|或)?\s*地区|國家\s*(?:\/|或)?\s*地區|国家|國家|地区|地區|country(?:\s*\/\s*region)?|region)\s*[:=-]?\s*/i,
      "",
    )
    .replace(/\s*(?:国家|國家|地区|地區|country|region)\s*$/i, "")
    .trim();
  const key = proxyMarketCountryAliasKey(clean);
  return PROXY_MARKET_COUNTRY_ALIASES.get(key)
    || PROXY_MARKET_INTL_COUNTRY_ALIASES.get(key)
    || null;
}

function proxyPurchaseCountryLabel(country = {}, fallbackCode = "") {
  const item = country && typeof country === "object" ? country : {};
  const code = String(
    item.code || item.country_code || item.id || item.value || fallbackCode || "",
  ).trim().toUpperCase();
  const rawName = String(
    item.name || item.label || item.country_name || item.country || (typeof country === "string" ? country : "") || code,
  ).trim();
  const normalized = normalizeProxyMarketCountry(code) || normalizeProxyMarketCountry(rawName);
  if (normalized?.code === "TW") return "中国台湾";
  return normalized?.label || rawName || code || "待识别地区";
}

function inferProxyMarketProviderKey(hosts) {
  const ignoredLabels = new Set(["api", "direct", "gateway", "gw", "proxy", "res", "residential", "static"]);
  for (const rawHost of hosts || []) {
    const host = String(rawHost || "").trim().toLowerCase();
    if (!host || /^[\d.]+$/.test(host) || host.includes(":")) continue;
    const labels = host.split(".").filter(Boolean);
    const candidates = labels.slice(0, -1).filter((label) => !ignoredLabels.has(label));
    if (candidates.length) return candidates[candidates.length - 1].replace(/[^a-z0-9_-]+/g, "");
  }
  return "";
}

function isProxyMarketLiteralHost(host) {
  const clean = String(host || "").trim().replace(/^\[|\]$/g, "");
  if (clean.includes(":")) return true;
  const octets = clean.split(".");
  return (
    octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function parseProxyMarketEndpoint(value) {
  const raw = String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
  if (!raw) return {};
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      const proxyType = normalizeProxyMarketProtocol(parsed.protocol);
      if (
        !proxyType
        || !parsed.hostname
        || (parsed.pathname && parsed.pathname !== "/")
        || parsed.search
        || parsed.hash
      ) return {};
      const defaultPort = proxyType === "http" ? 80 : proxyType === "https" ? 443 : 1080;
      return {
        proxy_type: proxyType,
        host: parsed.hostname.replace(/^\[|\]$/g, ""),
        port: Number(parsed.port || defaultPort),
        username: decodeProxyMarketCredential(parsed.username),
        password: decodeProxyMarketCredential(parsed.password),
        _credentials_specified: true,
      };
    } catch {
      return {};
    }
  }
  let match = raw.match(/^([^:@\s]+):([^@\s]*)@(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/);
  if (match) {
    return {
      host: match[3].replace(/^\[|\]$/g, ""),
      port: Number(match[4]),
      username: decodeProxyMarketCredential(match[1]),
      password: decodeProxyMarketCredential(match[2]),
      _credentials_specified: true,
    };
  }
  match = raw.match(/^(\[[^\]]+\]|[^:\s|]+)[|:](\d{1,5})[|:]([^:|]*)[|:](.*)$/);
  if (match) {
    return {
      host: match[1].replace(/^\[|\]$/g, ""),
      port: Number(match[2]),
      username: decodeProxyMarketCredential(match[3]),
      password: decodeProxyMarketCredential(match[4]),
      _credentials_specified: true,
    };
  }
  match = raw.match(/^(\[[^\]]+\]|[^:\s|]+)[|:](\d{1,5})$/);
  if (match) {
    return {
      host: match[1].replace(/^\[|\]$/g, ""),
      port: Number(match[2]),
      username: "",
      password: "",
      _credentials_specified: true,
    };
  }
  return {};
}

function flattenProxyMarketSmartObject(value, output = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  Object.entries(value).forEach(([key, fieldValue]) => {
    if (fieldValue && typeof fieldValue === "object" && !Array.isArray(fieldValue)) {
      flattenProxyMarketSmartObject(fieldValue, output);
      return;
    }
    const mapped = PROXY_MARKET_SMART_FIELD_ALIASES[normalizeProxyMarketSmartKey(key)];
    if (mapped && fieldValue !== null && fieldValue !== undefined) output[mapped] = fieldValue;
  });
  return output;
}

function parseProxyMarketSmartInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return {};
  let parsed = {};
  const errors = [];
  let inputMode = "endpoint";
  if (raw.startsWith("{")) {
    inputMode = "structured";
    try {
      parsed = flattenProxyMarketSmartObject(JSON.parse(raw));
    } catch {
      errors.push("JSON 格式无法识别");
    }
  } else {
    const hasPairSeparators = /\n/.test(raw);
    let matchedPair = false;
    const nonemptySegments = raw.split(/\r?\n/).filter((segment) => segment.trim());
    let matchedPairCount = 0;
    nonemptySegments.forEach((segment) => {
      const pair = segment.match(/^\s*([^:=：]+?)\s*([:=：])\s*(.*?)\s*$/);
      if (!pair) return;
      const mapped = PROXY_MARKET_SMART_FIELD_ALIASES[normalizeProxyMarketSmartKey(pair[1])];
      if (!mapped || (pair[2] === ":" && !hasPairSeparators)) return;
      matchedPair = true;
      matchedPairCount += 1;
      if (pair[3] !== "" || mapped === "username" || mapped === "password") parsed[mapped] = pair[3];
    });
    if (matchedPair && matchedPairCount === nonemptySegments.length) {
      inputMode = "structured";
    } else {
      const lines = raw
        .split(/\r?\n/)
        .map((line, index) => ({ value: line.trim(), lineNumber: index + 1 }))
        .filter((line) => line.value);
      if (lines.length > 1) {
        inputMode = "multi_endpoint";
        const endpoints = [];
        const countries = [];
        lines.forEach((line) => {
          const endpoint = parseProxyMarketEndpoint(line.value);
          if (endpoint.host && endpoint.port) {
            endpoints.push({ ...endpoint, _line: line.lineNumber });
            return;
          }
          const country = normalizeProxyMarketCountry(line.value);
          if (country) {
            countries.push(country);
            return;
          }
          errors.push(`第 ${line.lineNumber} 行无法识别`);
        });
        if (endpoints.length) {
          const literalEndpoints = endpoints.filter((endpoint) => isProxyMarketLiteralHost(endpoint.host));
          let primaryEndpoint = null;
          if (literalEndpoints.length === 1) {
            primaryEndpoint = literalEndpoints[0];
          } else if (literalEndpoints.length > 1) {
            errors.push("输入中包含多个 IP 主连接，请每次只填写一个库存代理");
          } else if (endpoints.length === 1) {
            primaryEndpoint = endpoints[0];
          } else {
            errors.push("输入中包含多个域名连接，无法自动判断主连接，请每次只填写一个");
          }
          parsed = primaryEndpoint ? { ...primaryEndpoint } : {};
          delete parsed._line;
          const primaryUsername = String(parsed.username || "");
          const primaryPassword = String(parsed.password || "");
          const inconsistentCredentials = primaryEndpoint && endpoints.find((endpoint) => (
            endpoint !== primaryEndpoint
            && (
            String(endpoint.username || "") !== primaryUsername
            || String(endpoint.password || "") !== primaryPassword
            )
          ));
          if (inconsistentCredentials) {
            errors.push(`第 ${inconsistentCredentials._line} 行的账号或密码与主连接不一致`);
          }
          const providerEndpoints = primaryEndpoint
            ? endpoints.filter((endpoint) => endpoint !== primaryEndpoint)
            : [];
          const providerKey = inferProxyMarketProviderKey(
            providerEndpoints.map((endpoint) => endpoint.host),
          );
          if (providerKey) parsed.provider_key = providerKey;
          if (countries.length) {
            const countryCodes = new Set(countries.map((country) => country.code));
            if (countryCodes.size > 1) errors.push("输入中包含多个不同国家或地区");
            else parsed.country = countries[0].code;
          }
          parsed._country_label = countries[0]?.label || "";
          parsed._provider_endpoint_count = providerEndpoints.length;
        }
      } else {
        parsed = parseProxyMarketEndpoint(raw);
      }
    }
  }
  const hasOwn = (field) => Object.prototype.hasOwnProperty.call(parsed, field);
  if (inputMode === "structured") {
    parsed._username_specified = hasOwn("username");
    parsed._password_specified = hasOwn("password");
    parsed._credentials_specified = parsed._username_specified || parsed._password_specified;
  } else if (parsed.host && parsed.port) {
    parsed._username_specified = true;
    parsed._password_specified = true;
    parsed._credentials_specified = true;
  }
  const connectionFields = ["proxy_type", "host", "port", "username", "password"];
  const hasConnectionInput = connectionFields.some((field) => hasOwn(field));
  if (hasOwn("proxy_type")) {
    const protocol = normalizeProxyMarketProtocol(parsed.proxy_type);
    if (protocol) parsed.proxy_type = protocol;
    else errors.push("代理协议仅支持 SOCKS5、HTTP 或 HTTPS");
  }
  if (hasOwn("host")) {
    parsed.host = String(parsed.host || "").trim().replace(/^\[|\]$/g, "");
    if (!parsed.host || /\s/.test(parsed.host)) errors.push("代理主机格式无效");
  }
  if (hasOwn("port")) {
    const port = Number(parsed.port);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) parsed.port = port;
    else errors.push("代理端口必须是 1-65535 的整数");
  }
  if (hasConnectionInput && (!hasOwn("host") || !hasOwn("port"))) {
    errors.push("连接信息必须同时包含主机和端口");
  }
  if (!Object.keys(parsed).some((field) => !field.startsWith("_")) && !errors.length) {
    errors.push("未识别到有效代理字段，请检查格式");
  }
  if (parsed.expires_at) {
    const numericExpiry = Number(parsed.expires_at);
    const expiresAt = Number.isFinite(numericExpiry)
      ? (numericExpiry < 1_000_000_000_000 ? numericExpiry * 1000 : numericExpiry)
      : Date.parse(String(parsed.expires_at));
    if (Number.isFinite(expiresAt) && expiresAt > 0) {
      parsed.expires_at = localInputFromTimestamp(Math.floor(expiresAt / 1000));
    } else {
      errors.push("到期时间格式无法识别");
    }
  }
  if (parsed.display_price_cents !== undefined) {
    const price = Math.round(Number(parsed.display_price_cents));
    if (Number.isFinite(price) && price >= 0) parsed.display_price_cents = price;
    else errors.push("售价（分）必须为非负整数");
  }
  if (errors.length) parsed._errors = errors;
  return parsed;
}

function proxyMarketStableHash(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function proxyMarketGeneratedSku(host, port, proxyType = "", providerKey = "") {
  const normalizedHost = String(host || "").trim().toLowerCase();
  const normalizedPort = Number(port || 0);
  const fingerprint = [
    normalizeProxyMarketProtocol(proxyType) || "proxy",
    normalizedHost,
    normalizedPort,
    String(providerKey || "").trim(),
  ].join("|");
  const hostLabel = normalizedHost.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "proxy";
  return `IP-${hostLabel}-${normalizedPort}-${proxyMarketStableHash(fingerprint)}`
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function setProxyMarketSmartResult(message, state = "") {
  const node = el("proxyMarketSmartResult");
  if (!node) return;
  node.textContent = message || "";
  if (state) node.dataset.state = state;
  else delete node.dataset.state;
}

function syncProxyMarketEditorActions() {
  const busy = Boolean(adminState.proxyMarketEditorBusy);
  const form = el("proxyMarketItemForm");
  if (form?.elements) {
    Array.from(form.elements).forEach((control) => {
      if (!control || typeof control.disabled !== "boolean") return;
      control.disabled = busy || (
        control.id === "proxyMarketSku"
        && Boolean(adminState.proxyMarketSelectedItemId)
      );
    });
  }
  if (el("btnCancelProxyMarketEdit")) el("btnCancelProxyMarketEdit").disabled = busy;
  if (el("btnSaveProxyMarketItem")) el("btnSaveProxyMarketItem").disabled = busy;
  if (el("btnPublishProxyMarketItem")) el("btnPublishProxyMarketItem").disabled = busy;
}

function setProxyMarketEditorBusy(busy) {
  adminState.proxyMarketEditorBusy = Boolean(busy);
  syncProxyMarketEditorActions();
}

async function applyProxyMarketSmartInput({ quiet = false } = {}) {
  const input = el("proxyMarketSmartInput");
  if (!input?.value?.trim()) return null;
  const rawInput = input.value;
  const parsed = parseProxyMarketSmartInput(rawInput);
  if (parsed._errors?.length) {
    setProxyMarketSmartResult(parsed._errors.join("；"), "error");
    return null;
  }
  let switchedToNew = false;
  const selectedId = String(adminState.proxyMarketSelectedItemId || "");
  const selectedItem = (Array.isArray(adminState.proxyMarketItemRows) ? adminState.proxyMarketItemRows : [])
    .find((item) => String(item?.id || "") === selectedId);
  const parsedHost = String(parsed.host || "").trim().toLowerCase();
  const parsedPort = Number(parsed.port || 0);
  const selectedHost = String(selectedItem?.host || "").trim().toLowerCase();
  const selectedPort = Number(selectedItem?.port || 0);
  const endpointChanged = Boolean(
    selectedItem
    && parsedHost
    && parsedPort
    && (parsedHost !== selectedHost || parsedPort !== selectedPort)
  );
  if (endpointChanged) {
    const decision = await requestAdminPublicAction({
      title: "发现新的代理地址",
      message: `当前正在编辑 ${selectedItem.sku || selectedItem.id}，识别到的是另一条代理地址。\n\n选择“新建库存”将保留原记录；选择“覆盖当前”才会继续修改当前库存。`,
      confirmLabel: "新建库存",
      cancelLabel: "覆盖当前",
    });
    if (decision.confirmed) {
      resetProxyMarketEditor();
      if (input) input.value = rawInput;
      switchedToNew = true;
    } else if (!decision.cancelled) {
      return null;
    }
  }
  const previousHost = el("proxyMarketHost")?.value?.trim() || "";
  const previousPort = Number(el("proxyMarketPort")?.value || 0);
  const previousProxyType = el("proxyMarketProxyType")?.value || "";
  const previousProviderKey = el("proxyMarketProviderKey")?.value || "";
  const previousCountry = el("proxyMarketCountry")?.value?.trim() || "";
  const currentSku = el("proxyMarketSku")?.value?.trim() || "";
  const currentDisplayName = el("proxyMarketDisplayName")?.value?.trim() || "";
  const skuCanAutofill = !currentSku || (
    previousHost
    && previousPort
    && currentSku === proxyMarketGeneratedSku(
      previousHost,
      previousPort,
      previousProxyType,
      previousProviderKey,
    )
  );
  const displayNameCanAutofill = !currentDisplayName || (
    previousHost
    && (
      currentDisplayName === `${previousHost} 静态住宅代理`
      || currentDisplayName === `${normalizeProxyMarketCountry(previousCountry)?.label || previousCountry}静态住宅代理`
      || currentDisplayName === `${previousHost} 代理IP`
      || currentDisplayName === `${normalizeProxyMarketCountry(previousCountry)?.label || previousCountry}代理IP`
    )
  );
  const fieldMap = {
    proxy_type: "proxyMarketProxyType", host: "proxyMarketHost", port: "proxyMarketPort",
    username: "proxyMarketUsername", password: "proxyMarketPassword",
    country: "proxyMarketCountry", region: "proxyMarketRegion", city: "proxyMarketCity", isp: "proxyMarketIsp",
    sku: "proxyMarketSku", display_name: "proxyMarketDisplayName", provider_key: "proxyMarketProviderKey",
    expires_at: "proxyMarketExpiresAt", display_price_cents: "proxyMarketPriceCents",
    currency: "proxyMarketCurrency", billing_cycle: "proxyMarketBillingCycle",
    tags: "proxyMarketTags", use_cases: "proxyMarketUseCases", description: "proxyMarketDescription",
  };
  const applied = [];
  Object.entries(fieldMap).forEach(([field, id]) => {
    if (parsed[field] === undefined || parsed[field] === null || parsed[field] === "") return;
    const control = el(id);
    if (!control || control.disabled) return;
    control.value = Array.isArray(parsed[field]) ? parsed[field].join(", ") : String(parsed[field]);
    applied.push(field);
  });
  if (parsed._username_specified && el("proxyMarketUsername")) {
    el("proxyMarketUsername").value = String(parsed.username || "");
    applied.push("username");
  }
  if (parsed._password_specified && el("proxyMarketPassword")) {
    el("proxyMarketPassword").value = String(parsed.password || "");
    applied.push("password");
  }
  if (parsed._credentials_specified) {
    applied.push("credentials");
  }
  const host = String(parsed.host || el("proxyMarketHost")?.value || "").trim();
  const port = Number(parsed.port || el("proxyMarketPort")?.value || 0);
  if (!adminState.proxyMarketSelectedItemId && host && port && skuCanAutofill) {
    el("proxyMarketSku").value = proxyMarketGeneratedSku(
      host,
      port,
      el("proxyMarketProxyType")?.value || "",
      el("proxyMarketProviderKey")?.value || "",
    );
    applied.push("sku");
  }
  if (host && displayNameCanAutofill) {
    const countryLabel = parsed._country_label
      || normalizeProxyMarketCountry(parsed.country || el("proxyMarketCountry")?.value)?.label
      || "";
    el("proxyMarketDisplayName").value = countryLabel
      ? `${countryLabel}代理IP`
      : `${host} 代理IP`;
    applied.push("display_name");
  }
  if (!applied.length) {
    if (!quiet && input?.value?.trim()) setProxyMarketSmartResult("未识别到有效代理字段，请检查格式。", "error");
    return null;
  }
  setText("proxyMarketEditorHint", "智能识别已更新字段；点击“检测并发布”会先验证连接，再替换线上配置。");
  if (input) input.value = "";
  const labels = [];
  if (parsed.proxy_type) labels.push(String(parsed.proxy_type).toUpperCase());
  if (parsed.host) labels.push("主机");
  if (parsed.port) labels.push("端口");
  if (parsed._username_specified && parsed.username) labels.push("账号");
  if (parsed._password_specified && parsed.password) labels.push("密码（已隐藏）");
  if (
    parsed._username_specified
    && parsed._password_specified
    && !parsed.username
    && !parsed.password
  ) labels.push("无认证");
  const metadataLabels = { country: "国家", region: "地区", city: "城市", isp: "ISP" };
  Object.entries(metadataLabels).forEach(([field, label]) => { if (parsed[field]) labels.push(label); });
  if (parsed.provider_key) labels.push("供应商");
  if (parsed._provider_endpoint_count) labels.push(`${parsed._provider_endpoint_count} 个供应商入口`);
  const primaryHint = parsed._provider_endpoint_count
    ? "；IP 行作为主连接，域名行仅用于识别供应商"
    : "";
  const modeHint = switchedToNew ? "；已自动切换为新建库存，原记录未修改" : "";
  setProxyMarketSmartResult(`已填充${labels.length ? `：${labels.join("、")}` : "可识别字段"}${primaryHint}${modeHint}；原始代理串已从输入框清除。`, "success");
  setText("proxyMarketEditorHint", "智能识别结果尚未保存；连接与凭据需通过真实检测后才会发布。");
  return parsed;
}

async function inspectProxyMarketConnection() {
  if (el("proxyMarketSmartInput")?.value?.trim()) {
    setProxyMarketSmartResult("请先点击“识别并填充”，确认字段后再执行检测。", "error");
    return null;
  }
  const host = el("proxyMarketHost")?.value?.trim() || "";
  const port = Number(el("proxyMarketPort")?.value || 0);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    setProxyMarketSmartResult("请先提供有效的主机和 1-65535 端口。", "error");
    return null;
  }
  const requestId = ++adminState.proxyMarketInspectRequestId;
  const itemId = String(adminState.proxyMarketSelectedItemId || "");
  const proxyType = el("proxyMarketProxyType")?.value || "socks5";
  const username = String(el("proxyMarketUsername")?.value || "");
  const password = String(el("proxyMarketPassword")?.value || "");
  const connectionStillMatches = () => (
    requestId === adminState.proxyMarketInspectRequestId
    && itemId === String(adminState.proxyMarketSelectedItemId || "")
    && proxyType === (el("proxyMarketProxyType")?.value || "socks5")
    && host === (el("proxyMarketHost")?.value?.trim() || "")
    && port === Number(el("proxyMarketPort")?.value || 0)
    && username === String(el("proxyMarketUsername")?.value || "")
    && password === String(el("proxyMarketPassword")?.value || "")
  );
  const button = el("btnInspectProxyMarketConnection");
  if (button) button.disabled = true;
  setProxyMarketSmartResult("正在进行真实网络检测并识别地区、城市和 ISP...");
  try {
    const result = await api("/api/admin/proxy-market/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item_id: itemId,
        proxy_type: proxyType,
        host,
        port,
        username,
        password,
      }),
    });
    if (!connectionStillMatches()) return null;
    const check = result?.check || {};
    const detected = check.detected || {};
    [
      ["proxyMarketCountry", detected.country],
      ["proxyMarketRegion", detected.region],
      ["proxyMarketCity", detected.city],
      ["proxyMarketIsp", detected.isp],
    ].forEach(([id, value]) => {
      if (el(id) && String(value || "").trim()) el(id).value = String(value).trim();
    });
    setText("proxyMarketEditorHint", "检测已自动填写地区字段；点击“检测并发布”会再次验证连接并原子发布。");
    const location = [detected.country_name || detected.country, detected.region, detected.city].filter(Boolean).join(" / ");
    setProxyMarketSmartResult(
      `检测通过${location ? `：${location}` : ""}${detected.isp ? ` · ${detected.isp}` : ""}${Number(check.latency_ms || 0) ? ` · ${Number(check.latency_ms)} ms` : ""}`,
      "success",
    );
    return result;
  } catch (error) {
    if (connectionStillMatches()) setProxyMarketSmartResult(`检测失败：${getErrorMessage(error)}`, "error");
    throw error;
  } finally {
    if (button && requestId === adminState.proxyMarketInspectRequestId) button.disabled = false;
  }
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
  button.setAttribute("aria-label", `${label} ${String(itemId || "")}`);
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
  return markAdminDynamicUiElement(button);
}

function proxyMarketAvailabilityText(item) {
  if (item?.available) return "公共代理池可领取";
  const reason = String(item?.availability_reason || "");
  if (reason === "health_stale") return "检测已过期，需重新检测发布";
  if (reason === "health_failed") return "检测失败，需重新检测发布";
  if (reason === "health_pending") return "尚未通过真实检测";
  if (reason === "expired") return "代理已到期";
  if (reason === "status_maintenance") return "维护中，暂不可领取";
  if (reason === "status_allocated") return "已被领取";
  if (reason === "status_disabled") return "已停用";
  if (reason === "status_archived") return "已归档";
  if (reason === "status_draft") return "草稿未发布";
  return "当前不可领取";
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
      || ["health_stale", "expired"].includes(String(item.availability_reason))
    )).length,
  );
}

function renderProxyMarketItems(payload = {}) {
  const body = el("proxyMarketItemBody");
  if (!body) return;
  const rows = Array.isArray(payload.items) ? payload.items : [];
  const inventory = payload.inventory && typeof payload.inventory === "object"
    ? payload.inventory
    : { count: rows.filter((item) => String(item.status) !== "archived").length, capacity: 0, remaining: null };
  const inventoryCount = Math.max(0, Number(inventory.count || 0));
  const inventoryCapacity = Math.max(0, Number(inventory.capacity || 0));
  adminState.proxyMarketItemRows = rows;
  adminState.proxyMarketInventory = {
    count: inventoryCount,
    capacity: inventoryCapacity,
    remaining: inventoryCapacity === 0 ? null : Math.max(0, inventoryCapacity - inventoryCount),
  };
  renderProxyMarketStats(rows);
  setText("proxyMarketInventoryTabCount", rows.length);
  setText(
    "proxyMarketInventorySummary",
    `当前筛选 ${rows.length} 条 · 有效库存 ${inventoryCount} / ${inventoryCapacity === 0 ? "不限量" : `上限 ${inventoryCapacity}`}`,
  );
  const newButton = el("btnNewProxyMarketItem");
  if (newButton) {
    const atCapacity = inventoryCapacity > 0 && inventoryCount >= inventoryCapacity;
    newButton.disabled = atCapacity;
    newButton.title = atCapacity ? `库存已达到管理员设置的上限（${inventoryCapacity} 条）` : "";
  }
  body.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.appendChild(markAdminDynamicUiElement(createEmptyState("当前筛选条件下没有代理库存")));
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
    const ipType = String(item.ip_type || "static_residential").trim().toLowerCase();
    const typeLabel = ipType === "datacenter" ? "机房 IP" : "静态住宅 IP";
    const locationText = [typeLabel, proxyPurchaseCountryLabel(item.country), item.region, item.city, item.isp].filter(Boolean).join(" · ");
    if (locationText) location.textContent = locationText;
    else location.appendChild(createAdminDynamicUiText("未标注地区"));
    endpointCell.append(endpoint, location);
    row.appendChild(endpointCell);

    const healthCell = document.createElement("td");
    healthCell.appendChild(createProxyMarketBadge(item.health_status));
    const healthMeta = document.createElement("span");
    if (item.last_check_at) {
      healthMeta.textContent = `${Number(item.latency_ms || 0)} ms · ${formatTime(item.last_check_at)}`;
    } else {
      healthMeta.appendChild(createAdminDynamicUiText("尚未检测"));
    }
    healthCell.appendChild(healthMeta);
    row.appendChild(healthCell);

    const statusCell = document.createElement("td");
    statusCell.appendChild(createProxyMarketBadge(item.status));
    const statusMeta = document.createElement("span");
    statusMeta.appendChild(createAdminDynamicUiText(proxyMarketAvailabilityText(item)));
    statusCell.appendChild(statusMeta);
    row.appendChild(statusCell);

    const priceCell = document.createElement("td");
    const price = document.createElement("strong");
    price.textContent = `${formatProxyMarketPrice(item)} / ${item.billing_cycle || "month"}`;
    const expiry = document.createElement("span");
    if (item.expires_at) {
      expiry.append(createAdminDynamicUiText("到期"), ` ${formatTime(item.expires_at)}`);
    } else {
      expiry.appendChild(createAdminDynamicUiText("未设置到期时间"));
    }
    priceCell.append(price, expiry);
    row.appendChild(priceCell);

    const actionCell = document.createElement("td");
    const actionRow = document.createElement("div");
    actionRow.className = "proxy-market-table-actions";
    const edit = createProxyMarketIconButton(
      "编辑代理",
      "edit",
      item.id,
      '<path d="M4 20h4l11-11-4-4L4 16v4Z"></path><path d="m13.5 6.5 4 4"></path>',
    );
    const publish = createProxyMarketIconButton(
      Number(item.published_at || 0) ? "重新检测并发布" : "检测并发布",
      "publish",
      item.id,
      '<circle cx="12" cy="12" r="9"></circle><path d="m8 12 2.5 2.5L16 9"></path>',
      "primary",
    );
    publish.disabled = String(item.status || "") === "archived";
    const status = document.createElement("select");
    status.dataset.proxyMarketStatus = String(item.id || "");
    status.setAttribute("aria-label", `库存状态 ${item.id}`);
    markAdminDynamicUiElement(status);
    const currentStatus = String(item.status || "draft");
    const statusOptions = currentStatus === "draft" || !Number(item.published_at || 0)
      ? ["draft", "active", "disabled"]
      : currentStatus === "allocated"
        ? ["allocated", "maintenance", "disabled"]
        : ["active", "maintenance", "disabled"];
    statusOptions.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = PROXY_MARKET_STATUS_LABELS[value];
      option.selected = currentStatus === value;
      option.disabled = value === "allocated";
      markAdminDynamicUiElement(option);
      status.appendChild(option);
    });
    if (currentStatus === "archived") {
      const option = document.createElement("option");
      option.value = "archived";
      option.textContent = PROXY_MARKET_STATUS_LABELS.archived;
      option.selected = true;
      markAdminDynamicUiElement(option);
      status.prepend(option);
      status.disabled = true;
    }
    const archive = createProxyMarketIconButton(
      "归档代理",
      "archive",
      item.id,
      '<path d="M4 7h16v13H4Z"></path><path d="M3 4h18v3H3ZM9 11h6"></path>',
      "danger",
    );
    archive.disabled = String(item.status) === "archived";
    actionRow.append(edit, publish, status, archive);
    actionCell.appendChild(actionRow);
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
  setText("proxyMarketAllocationTabCount", rows.length);
  setText("proxyMarketAllocationSummary", `显示 ${rows.length} 条分配记录`);
  body.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.appendChild(markAdminDynamicUiElement(createEmptyState("当前筛选条件下没有分配记录")));
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
    const usageCell = document.createElement("td");
    usageCell.append(
      String(Number(item.bound_account_count || 0)),
      " ",
      createAdminDynamicUiText("个绑定账号"),
    );
    const usageMeta = document.createElement("span");
    usageMeta.append(
      String(Number(item.running_task_count || 0)),
      " ",
      createAdminDynamicUiText("个运行任务"),
      ` · ${item.social_proxy_id || ""}`,
    );
    usageCell.appendChild(usageMeta);
    row.appendChild(usageCell);
    const timeCell = document.createElement("td");
    timeCell.append(String(formatTime(item.claimed_at)));
    const timeMeta = document.createElement("span");
    timeMeta.append(createAdminDynamicUiText("更新"), ` ${formatTime(item.updated_at || item.claimed_at)}`);
    timeCell.appendChild(timeMeta);
    row.appendChild(timeCell);
    const actionCell = document.createElement("td");
    if (String(item.status) === "active") {
      const revoke = createProxyMarketIconButton(
        "回收代理",
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

function setProxyMarketRecordsView(view) {
  const normalized = ["inventory", "allocations", "purchased"].includes(view) ? view : "inventory";
  adminState.proxyMarketRecordsView = normalized;
  const pairs = [
    ["inventory", "proxyMarketInventoryTab", "proxyMarketInventoryPanel"],
    ["allocations", "proxyMarketAllocationTab", "proxyMarketAllocationPanel"],
    ["purchased", "proxyMarketPurchasedTab", "proxyMarketPurchasedPanel"],
  ];
  pairs.forEach(([name, tabId, panelId]) => {
    const active = normalized === name;
    const tab = el(tabId);
    const panel = el(panelId);
    tab?.classList.toggle("is-active", active);
    tab?.setAttribute("aria-selected", active ? "true" : "false");
    tab?.setAttribute("tabindex", active ? "0" : "-1");
    if (panel) panel.hidden = !active;
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

function renderProxyPurchasedAssets(payload = {}) {
  const body = el("proxyMarketPurchasedBody");
  if (!body) return;
  const rows = Array.isArray(payload.items) ? payload.items : [];
  adminState.proxyPurchasedAssetRows = rows;
  setText("proxyMarketPurchasedTabCount", rows.length);
  setText("proxyMarketPurchasedSummary", `显示 ${rows.length} 个用户自购代理`);
  body.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.appendChild(markAdminDynamicUiElement(createEmptyState("当前筛选条件下没有用户自购代理")));
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  rows.forEach((item) => {
    const row = document.createElement("tr");
    appendCell(row, item.full_name || item.username || `用户 ${item.user_id || "-"}`, `${item.username || ""} · ID ${item.user_id || "-"}`);
    appendCell(
      row,
      `${String(item.proxy_type || "").toUpperCase()} ${item.host || "-"}:${Number(item.port || 0) || "-"}`,
      [proxyPurchaseCountryLabel(item.country), item.region, item.city, item.isp].filter(Boolean).join(" · ") || "未标注地区",
    );
    appendCell(row, item.order_id || "-", item.provider_proxy_id ? `供应商代理 ${item.provider_proxy_id}` : "等待供应商返回");
    appendCell(
      row,
      item.proxy_status || item.order_status || "unknown",
      item.renewal_enabled ? `自动续费 · ${item.renewal_status || "已开启"}` : "自动续费未开启",
    );
    appendCell(
      row,
      `${Number(item.bound_account_count || 0)} 个账号`,
      item.expires_at ? `到期 ${formatTime(item.expires_at)}` : "未返回到期时间",
    );
    body.appendChild(row);
  });
}

async function loadProxyPurchasedAssets() {
  const body = el("proxyMarketPurchasedBody");
  body?.setAttribute("aria-busy", "true");
  try {
    const query = new URLSearchParams();
    const search = String(el("proxyMarketPurchasedQuery")?.value || "").trim();
    const status = String(el("proxyMarketPurchasedStatus")?.value || "").trim();
    if (search) query.set("query", search);
    if (status) query.set("status", status);
    const suffix = query.toString();
    const endpoint = "/api/admin/proxy-purchases/assets";
    const payload = await api(`${endpoint}${suffix ? `?${suffix}` : ""}`);
    renderProxyPurchasedAssets(payload || {});
    setMsg("proxyMarketPurchasedMsg", "");
    return payload;
  } catch (error) {
    setMsg("proxyMarketPurchasedMsg", `用户自购代理读取失败：${getErrorMessage(error)}`, false);
    throw error;
  } finally {
    body?.removeAttribute("aria-busy");
  }
}

function renderProxyMarketSettings(payload = {}) {
  const settings = payload.settings && typeof payload.settings === "object" ? payload.settings : payload;
  adminState.proxyMarketSettings = settings || {};
  if (el("proxyMarketInventoryCapacity")) {
    el("proxyMarketInventoryCapacity").value = String(Number(settings?.inventory_capacity ?? 0));
  }
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
    setMsg("proxyMarketSettingsMsg", `代理设置读取失败：${getErrorMessage(error)}`, false);
    throw error;
  }
}

function proxyPurchaseConfigValue(config, ...keys) {
  for (const key of keys) {
    if (config?.[key] !== undefined && config?.[key] !== null) return config[key];
  }
  return "";
}

function setProxyPurchaseSelectOptions(selectId, options, { valueKey = "value", labelKey = "label", emptyLabel = "请选择" } = {}) {
  const select = el(selectId);
  if (!select) return;
  const previous = String(select.value || "");
  select.replaceChildren();
  if (emptyLabel) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = emptyLabel;
    select.appendChild(empty);
  }
  (Array.isArray(options) ? options : []).forEach((item) => {
    const value = typeof item === "object" ? item?.[valueKey] : item;
    const label = typeof item === "object" ? item?.[labelKey] : item;
    if (value === undefined || value === null || String(value) === "") return;
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = String(label || value);
    select.appendChild(option);
  });
  if (Array.from(select.options).some((option) => option.value === previous)) select.value = previous;
}

function renderProxyPurchaseConfig(payload = {}) {
  const config = payload?.draft || payload?.config || payload || {};
  const setupDefaults = config?.setup_defaults && typeof config.setup_defaults === "object" ? config.setup_defaults : {};
  adminState.proxyPurchaseConfig = config;
  const values = {
    proxyPurchaseServiceId: proxyPurchaseConfigValue(config, "service_id", "default_service_id"),
    proxyPurchasePlanId: proxyPurchaseConfigValue(config, "plan_id"),
    proxyPurchaseDefaultCountry: proxyPurchaseConfigValue(config, "default_country", "country") || setupDefaults.country || "",
    proxyPurchaseDefaultPeriod: proxyPurchaseConfigValue(config, "default_period", "period") || 1,
    proxyPurchaseMinPeriod: proxyPurchaseConfigValue(config, "min_period_months") || 1,
    proxyPurchaseMaxPeriod: proxyPurchaseConfigValue(config, "max_period_months") || 1,
    proxyPurchaseFxMode: proxyPurchaseConfigValue(config, "fx_rate_mode") || "auto",
    proxyPurchaseManualFxRate: proxyPurchaseConfigValue(config, "manual_usd_to_ntd_rate", "usd_to_ntd_rate") || 35,
    proxyPurchaseProfitNtd: proxyPurchaseConfigValue(config, "profit_ntd") || 0,
    proxyPurchaseEnabled: String(Boolean(proxyPurchaseConfigValue(config, "live_purchasing_enabled", "enabled"))),
  };
  Object.entries(values).forEach(([id, value]) => {
    const control = el(id);
    if (control && value !== "") control.value = String(value);
  });
  if (Object.prototype.hasOwnProperty.call(payload || {}, "credential_status")) {
    renderProxyProviderCredentialStatus(payload?.credential_status || {});
  }
  syncProxyPurchaseFxMode();
}

function syncProxyPurchaseFxMode() {
  const manual = el("proxyPurchaseFxMode")?.value === "manual";
  const field = el("proxyPurchaseManualFxField");
  const input = el("proxyPurchaseManualFxRate");
  if (field) field.hidden = !manual;
  if (input) input.disabled = !manual;
}

function renderProxyPurchaseExchangeRate(payload = {}) {
  const rate = Number(payload?.rate);
  const reference = Number(payload?.reference_rate || payload?.rate);
  setText("proxyPurchaseFxRate", Number.isFinite(rate) ? `1 USD = ${rate.toFixed(4)} TWD` : "暂时不可用");
  const fetchedAt = Number(payload?.fetched_at || 0);
  const updated = fetchedAt ? new Date(fetchedAt * 1000).toLocaleString("zh-CN", { hour12: false }) : "未刷新";
  const mode = payload?.mode === "manual" ? "手动上调" : "自动同步";
  const referenceCopy = Number.isFinite(reference) && reference !== rate ? ` · 市场参考 ${reference.toFixed(4)}` : "";
  setText("proxyPurchaseFxMeta", `${mode}${referenceCopy} · ${updated}${payload?.stale ? " · 使用缓存" : ""}`);
}

async function loadProxyPurchaseExchangeRate({ refresh = false } = {}) {
  setText("proxyPurchaseFxMeta", refresh ? "正在刷新市场参考汇率..." : "正在读取市场参考汇率...");
  const payload = await api(`/api/admin/proxy-purchases/exchange-rate${refresh ? "?refresh=true" : ""}`);
  renderProxyPurchaseExchangeRate(payload || {});
  return payload;
}

function renderProxyProviderCredentialStatus(status = {}) {
  adminState.proxyProviderCredentialStatus = status;
  const configured = status?.configured === true;
  const verified = status?.verified === true;
  const label = verified ? "已验证" : configured ? "已保存，待验证" : "未配置";
  setText("proxyProviderCredentialSummary", label);
  [
    ["proxyProviderApiKey", status?.api_key_configured === true, "API Key"],
    ["proxyProviderApiSecret", status?.api_secret_configured === true, "API Secret"],
    ["proxyProviderWebhookSecret", status?.webhook_secret_configured === true, "Webhook Secret"],
  ].forEach(([id, isConfigured, labelText]) => {
    setProviderSecretInputState(id, isConfigured, labelText);
  });
  const readiness = el("proxyPurchaseReadiness");
  const reasons = [];
  if (!configured) reasons.push("尚未配置供应商 API 凭据");
  else if (!verified) reasons.push("供应商凭据尚未验证");
  if (status?.staged) reasons.push("存在尚未启用的凭据版本");
  if (status?.last_error_code) reasons.push(`最近错误：${status.last_error_code}`);
  if (verified && Object.prototype.hasOwnProperty.call(status, "live_purchasing_enabled") && !status.live_purchasing_enabled) {
    reasons.push("用户采购尚未开放");
  }
  if (readiness) {
    readiness.hidden = reasons.length === 0;
    readiness.textContent = reasons.join("；");
  }
  const providerTab = document.querySelector('[data-model-tab="proxy-provider"]');
  if (providerTab) providerTab.classList.toggle("has-attention", !configured || !verified || !!status?.staged || !!status?.last_error_code);
}

async function loadProxyProviderCredentialStatus() {
  const payload = await api("/api/admin/proxy-purchases/provider-credentials");
  renderProxyProviderCredentialStatus(payload || {});
  return payload;
}

function proxyProviderSetupValueSummary(value) {
  if (Array.isArray(value)) return `${value.length} 项`;
  if (value && typeof value === "object") return `${Object.keys(value).length} 组`;
  if (typeof value === "boolean") return value ? "支持" : "不支持";
  if (value === undefined || value === null || value === "") return "—";
  return String(value);
}

function renderProxyProviderFieldMap(payload = {}) {
  const grid = el("proxyProviderFieldGrid");
  if (!grid) return;
  const setup = payload?.setup && typeof payload.setup === "object" ? payload.setup : {};
  const rows = [
    ["公开产品", Array.isArray(payload?.services) ? `${payload.services.length} 项` : "0 项"],
    ["可售地区", proxyProviderSetupValueSummary(setup.countries || setup.regions)],
    ["可售城市", proxyProviderSetupValueSummary(setup.cities)],
    ["ISP", proxyProviderSetupValueSummary(setup.isps || setup.isp)],
    ["套餐包", proxyProviderSetupValueSummary(setup.packages || setup.package)],
    ["周期", proxyProviderSetupValueSummary(setup.periods || setup.period)],
    ["协议", proxyProviderSetupValueSummary(setup.protocols || setup.protocol)],
    ["认证", proxyProviderSetupValueSummary(setup.authentications || setup.authentication || setup.auth)],
  ];
  grid.replaceChildren();
  rows.forEach(([label, value]) => {
    const item = document.createElement("div");
    item.className = "proxy-provider-field-item";
    const title = document.createElement("strong");
    title.textContent = label;
    const content = document.createElement("span");
    content.textContent = value;
    content.title = value;
    item.append(title, content);
    grid.appendChild(item);
  });
  const serviceCount = Array.isArray(payload?.services) ? payload.services.length : 0;
  const countrySummary = proxyProviderSetupValueSummary(setup.countries || setup.regions);
  const balanceSummary = payload?.balance === undefined || payload?.balance === null
    ? ""
    : ` · 余额 ${Number(payload.balance).toLocaleString("zh-CN", { maximumFractionDigits: 4 })} USD`;
  setText("proxyProviderFieldRevision", `${serviceCount} 产品 · ${countrySummary}${balanceSummary}`);
}

function proxyPurchaseServiceLabel(service = {}) {
  const plan = service.plan_name || service.plan?.name || service.plan_id || "";
  return [service.name || service.label || service.service_name || service.id, plan].filter(Boolean).join(" · ");
}

function renderProxyPurchaseProviderOptions(payload = {}) {
  adminState.proxyPurchaseProviderOptions = payload;
  const supportedServices = (Array.isArray(payload?.services) ? payload.services : []).filter((service) => (
    String(service?.id || service?.service_id || "") === "static-residential-ipv4"
  ));
  const services = supportedServices.map((service) => ({
    value: service?.id || service?.service_id || service?.plan_id,
    label: proxyPurchaseServiceLabel(service),
  }));
  if (!services.length) services.push({ value: "static-residential-ipv4", label: "静态住宅 IPv4" });
  setProxyPurchaseSelectOptions("proxyPurchaseServiceId", services, { emptyLabel: "" });
  if (el("proxyPurchaseServiceId")) el("proxyPurchaseServiceId").value = "static-residential-ipv4";

  const plans = [];
  supportedServices.forEach((service) => {
    const nestedPlans = Array.isArray(service?.plans) ? service.plans : [];
    nestedPlans.forEach((plan) => plans.push({
      value: plan?.id || plan?.plan_id || plan?.value,
      label: [service?.name || service?.label, plan?.name || plan?.label || plan?.id].filter(Boolean).join(" · "),
    }));
    if (!nestedPlans.length && (service?.plan_id || service?.plan?.id)) {
      plans.push({ value: service.plan_id || service.plan.id, label: service.plan_name || service.plan?.name || service.plan_id || service.plan.id });
    }
  });
  setProxyPurchaseSelectOptions("proxyPurchasePlanId", plans, { emptyLabel: "使用产品默认套餐" });
  if (!String(adminState.proxyPurchaseConfig?.plan_id || "") && payload?.selected_plan_id && el("proxyPurchasePlanId")) {
    el("proxyPurchasePlanId").value = String(payload.selected_plan_id);
  }

  const setup = payload?.setup || {};
  const rawCountries = setup.countries || setup.regions || payload?.regions || [];
  const countries = (Array.isArray(rawCountries) ? rawCountries : []).map((country) => ({
    value: country?.code || country?.id || country?.value || country,
    label: proxyPurchaseCountryLabel(country),
  }));
  setProxyPurchaseSelectOptions("proxyPurchaseDefaultCountry", countries, { emptyLabel: "使用首个可售地区" });

  const rawPeriods = setup.periods || setup.period || payload?.periods || [1];
  const monthPeriods = Array.isArray(rawPeriods)
    ? rawPeriods
    : Array.isArray(rawPeriods?.months)
      ? rawPeriods.months
      : rawPeriods && typeof rawPeriods === "object"
        ? []
        : [rawPeriods];
  if (!monthPeriods.some((period) => Number(period?.value || period?.months || period) === 1)) monthPeriods.unshift(1);
  const periods = monthPeriods.map((period) => ({
    value: period?.value || period?.months || period,
    label: `${period?.label || period?.value || period?.months || period} 个月`,
  }));
  setProxyPurchaseSelectOptions("proxyPurchaseDefaultPeriod", periods, { emptyLabel: "" });
  setProxyPurchaseSelectOptions("proxyPurchaseMinPeriod", periods, { emptyLabel: "" });
  setProxyPurchaseSelectOptions("proxyPurchaseMaxPeriod", periods, { emptyLabel: "" });
  renderProxyProviderFieldMap(payload);
  const selectedProviderPlan = String(el("proxyPurchasePlanId")?.value || "");
  renderProxyPurchaseConfig({ config: adminState.proxyPurchaseConfig || {} });
  if (!String(adminState.proxyPurchaseConfig?.plan_id || "") && selectedProviderPlan && el("proxyPurchasePlanId")) {
    el("proxyPurchasePlanId").value = selectedProviderPlan;
  }
}

async function loadProxyPurchaseConfig() {
  const payload = await api("/api/admin/proxy-purchases/config");
  renderProxyPurchaseConfig(payload || {});
  return payload;
}

async function loadProxyPurchaseProviderOptions({ serviceId, planId, persist = false } = {}) {
  setMsg("proxyPurchaseConfigMsg", "正在同步供应商公开产品与选项...");
  try {
    const selectedService = String(serviceId || el("proxyPurchaseServiceId")?.value || "static-residential-ipv4");
    const selectedPlan = String(planId === undefined ? el("proxyPurchasePlanId")?.value || "" : planId);
    const query = new URLSearchParams({ service_id: selectedService });
    if (selectedPlan) query.set("plan_id", selectedPlan);
    const payload = await api(`/api/admin/proxy-purchases/provider-options${persist ? "/sync" : ""}?${query.toString()}`, {
      method: persist ? "POST" : "GET",
    });
    renderProxyPurchaseProviderOptions(payload || {});
    setMsg("proxyPurchaseConfigMsg", "供应商选项已同步", true);
    return payload;
  } catch (error) {
    setMsg("proxyPurchaseConfigMsg", `供应商同步失败：${getErrorMessage(error)}`, false);
    throw error;
  }
}

function resetProxyProviderCredentialInputs() {
  renderProxyProviderCredentialStatus(adminState.proxyProviderCredentialStatus || {});
}

async function testProxyProviderCredentials({ useInputs = true } = {}) {
  const apiKey = useInputs ? providerSecretInputValue("proxyProviderApiKey") : "";
  const apiSecret = useInputs ? providerSecretInputValue("proxyProviderApiSecret") : "";
  setMsg("proxyProviderCredentialMsg", "正在从服务端验证供应商鉴权与公开字段...");
  const payload = await api("/api/admin/proxy-purchases/provider-credentials/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      api_secret: apiSecret,
    }),
  });
  setMsg(
    "proxyProviderCredentialMsg",
    `连接成功：发现 ${Number(payload?.service_count || 0)} 个公开产品${payload?.balance ? `，余额 ${payload.balance} USD` : ""}`,
    true,
  );
  return payload;
}

async function saveProxyProviderCredentials() {
  const form = el("proxyProviderCredentialForm");
  if (!form?.reportValidity()) return false;
  form.setAttribute("aria-busy", "true");
  setMsg("proxyProviderCredentialMsg", "正在加密保存供应商凭据...");
  try {
    const saved = await api("/api/admin/proxy-purchases/provider-credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: providerSecretInputValue("proxyProviderApiKey"),
        api_secret: providerSecretInputValue("proxyProviderApiSecret"),
        webhook_secret: providerSecretInputValue("proxyProviderWebhookSecret"),
      }),
    });
    renderProxyProviderCredentialStatus(saved || {});
    await loadProxyPurchaseProviderOptions({
      serviceId: "static-residential-ipv4",
      planId: "",
      persist: true,
    });
    setMsg("proxyProviderCredentialMsg", "凭据已加密保存，连接测试和供应商字段同步均已完成", true);
    return true;
  } finally {
    form.removeAttribute("aria-busy");
    resetProxyProviderCredentialInputs();
  }
}

function proxyPurchaseConfigPayload() {
  const setupDefaults = {
    country: String(el("proxyPurchaseDefaultCountry")?.value || ""),
  };
  return {
    provider: "proxy-cheap",
    service_id: String(el("proxyPurchaseServiceId")?.value || ""),
    plan_id: String(el("proxyPurchasePlanId")?.value || ""),
    default_country: String(el("proxyPurchaseDefaultCountry")?.value || ""),
    default_period: Math.max(1, Number(el("proxyPurchaseDefaultPeriod")?.value || 1)),
    min_period_months: Math.max(1, Number(el("proxyPurchaseMinPeriod")?.value || 1)),
    max_period_months: Math.max(1, Number(el("proxyPurchaseMaxPeriod")?.value || 1)),
    quantity: 1,
    setup_defaults: setupDefaults,
    pricing_mode: "supplier_plus_profit_ntd",
    fx_rate_mode: String(el("proxyPurchaseFxMode")?.value || "auto"),
    manual_usd_to_ntd_rate: Number(el("proxyPurchaseManualFxRate")?.value || 35),
    profit_ntd: Number(el("proxyPurchaseProfitNtd")?.value || 0),
    live_purchasing_enabled: el("proxyPurchaseEnabled")?.value === "true",
  };
}

async function saveProxyPurchaseConfig() {
  const form = el("proxyPurchaseConfigForm");
  if (!form?.reportValidity()) return false;
  const minimumPeriod = Number(el("proxyPurchaseMinPeriod")?.value || 1);
  const maximumPeriod = Number(el("proxyPurchaseMaxPeriod")?.value || 1);
  if (minimumPeriod > maximumPeriod) {
    setMsg("proxyPurchaseConfigMsg", "最短购买时长不能大于最长购买时长", false);
    el("proxyPurchaseMinPeriod")?.focus();
    return false;
  }
  form.setAttribute("aria-busy", "true");
  setMsg("proxyPurchaseConfigMsg", "正在保存采购配置草稿...");
  try {
    const payload = await api("/api/admin/proxy-purchases/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proxyPurchaseConfigPayload()),
    });
    renderProxyPurchaseConfig(payload || {});
    setMsg("proxyPurchaseConfigMsg", "采购配置草稿已保存，发布前不会影响用户购买", true);
    return payload;
  } finally {
    form.removeAttribute("aria-busy");
  }
}

async function publishProxyPurchaseConfig() {
  const form = el("proxyPurchaseConfigForm");
  if (!form?.reportValidity()) return false;
  form.setAttribute("aria-busy", "true");
  setMsg("proxyPurchaseConfigMsg", "正在校验成本与利润约束并发布...");
  try {
    const saved = await saveProxyPurchaseConfig();
    if (!saved) return false;
    const payload = await api("/api/admin/proxy-purchases/config/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    renderProxyPurchaseConfig(payload || {});
    setMsg("proxyPurchaseConfigMsg", "供应商采购配置已发布", true);
    return payload;
  } finally {
    form.removeAttribute("aria-busy");
  }
}

function renderProxyPurchaseOrders(payload = {}) {
  const body = el("proxyPurchaseOrderBody");
  if (!body) return;
  const orders = Array.isArray(payload?.items) ? payload.items : [];
  adminState.proxyPurchaseOrders = orders;
  body.replaceChildren();
  setText("proxyPurchaseOrderSummary", `共 ${orders.length.toLocaleString("zh-CN")} 条采购订单`);
  if (!orders.length) {
    const row = document.createElement("tr");
    const cell = createBillingCell("暂无供应商采购订单");
    cell.colSpan = 7;
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  orders.forEach((order) => {
    const row = document.createElement("tr");
    row.appendChild(createBillingCell(order.id));
    row.appendChild(createBillingCell([
      order.user_id ? `#${order.user_id}` : "-",
      proxyPurchaseCountryLabel({ name: order.country_name, code: order.country }),
      order.city_name || order.city || "",
    ].filter(Boolean).join(" · ")));
    row.appendChild(createBillingCell(order.vendor_price === undefined ? "-" : `${order.vendor_price} ${order.currency || "USD"}`));
    row.appendChild(createBillingCell(order.charge_points === undefined ? "-" : `${Number(order.charge_points).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 点`));
    row.appendChild(createBillingCell([
      order.status || "pending",
      order.renewal_status ? `续费：${order.renewal_status}` : "",
    ].filter(Boolean).join(" / ")));
    row.appendChild(createBillingCell([formatBillingTime(order.created_at), formatBillingTime(order.updated_at)].join(" / ")));
    const actionCell = document.createElement("td");
    const actionWrap = document.createElement("div");
    actionWrap.className = "proxy-purchase-order-actions";
    [
      ["reconcile", "对账"],
      ["bind", "绑定"],
      ["confirm_not_created", "确认未创建"],
      ...(String(order.error_code || "") === "PROVIDER_REFUND_UNCONFIRMED"
        ? [["confirm_provider_refunded", "确认供应商已退款"]]
        : []),
    ].forEach(([action, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost admin-compact-button";
      button.dataset.proxyPurchaseOrderId = String(order.id || "");
      button.dataset.proxyPurchaseAction = action;
      button.textContent = label;
      actionWrap.appendChild(button);
    });
    if (["provider_unknown", "extending"].includes(String(order.renewal_status || ""))) {
      [
        ["renewal_reconcile", "核对续费"],
        ["renewal_confirm_not_extended", "确认未续费"],
      ].forEach(([action, label]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost admin-compact-button";
        button.dataset.proxyPurchaseOrderId = String(order.id || "");
        button.dataset.proxyPurchaseAction = action;
        button.textContent = label;
        actionWrap.appendChild(button);
      });
    }
    actionCell.appendChild(actionWrap);
    row.appendChild(actionCell);
    body.appendChild(row);
  });
}

async function loadProxyPurchaseOrders() {
  const body = el("proxyPurchaseOrderBody");
  body?.setAttribute("aria-busy", "true");
  try {
    const payload = await api("/api/admin/proxy-purchases/orders");
    renderProxyPurchaseOrders(payload || {});
    setMsg("proxyPurchaseOrderMsg", "");
    return payload;
  } catch (error) {
    setMsg("proxyPurchaseOrderMsg", `采购订单读取失败：${getErrorMessage(error)}`, false);
    throw error;
  } finally {
    body?.removeAttribute("aria-busy");
  }
}

function selectProxyPurchaseOrderResolution(orderId, action) {
  if (el("proxyPurchaseResolutionOrderId")) el("proxyPurchaseResolutionOrderId").value = String(orderId || "");
  if (el("proxyPurchaseResolutionAction")) el("proxyPurchaseResolutionAction").value = String(action || "reconcile");
  const providerInput = el("proxyPurchaseResolutionProviderOrderId");
  if (providerInput) {
    providerInput.required = action === "bind";
    providerInput.disabled = String(action || "").startsWith("renewal_");
    if (action !== "bind") providerInput.value = "";
  }
  el("proxyPurchaseResolutionReason")?.focus();
}

async function resolveProxyPurchaseOrder() {
  const form = el("proxyPurchaseOrderResolutionForm");
  const orderId = String(el("proxyPurchaseResolutionOrderId")?.value || "").trim();
  const action = String(el("proxyPurchaseResolutionAction")?.value || "reconcile");
  if (!orderId || !form?.reportValidity()) return false;
  const renewalAction = action.startsWith("renewal_");
  const apiAction = renewalAction ? action.slice("renewal_".length) : action;
  const body = {
    action: apiAction,
    provider_order_id: renewalAction ? undefined : String(el("proxyPurchaseResolutionProviderOrderId")?.value || "").trim(),
    reason: String(el("proxyPurchaseResolutionReason")?.value || "").trim(),
    admin_password: String(el("proxyPurchaseResolutionPassword")?.value || ""),
    totp_code: String(el("proxyPurchaseResolutionTotp")?.value || "").trim(),
  };
  form.setAttribute("aria-busy", "true");
  setMsg("proxyPurchaseOrderMsg", `正在执行订单 ${orderId} 的人工处置...`);
  try {
    const endpoint = renewalAction
      ? `/api/admin/proxy-purchases/orders/${encodeURIComponent(orderId)}/renewal/resolve`
      : `/api/admin/proxy-purchases/orders/${encodeURIComponent(orderId)}/resolve`;
    if (renewalAction) delete body.provider_order_id;
    const payload = await api(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (el("proxyPurchaseResolutionPassword")) el("proxyPurchaseResolutionPassword").value = "";
    if (el("proxyPurchaseResolutionTotp")) el("proxyPurchaseResolutionTotp").value = "";
    await loadProxyPurchaseOrders();
    const actualStatus = String(payload?.order?.status || "未知状态");
    setMsg("proxyPurchaseOrderMsg", `订单 ${orderId} 处置完成，当前实际状态：${actualStatus}`, true);
    return payload;
  } finally {
    form.removeAttribute("aria-busy");
  }
}

async function loadProxyMarketWorkspace() {
  if (adminState.proxyMarketLoadingPromise) return adminState.proxyMarketLoadingPromise;
  setProxyMarketRecordsView(adminState.proxyMarketRecordsView);
  const section = el("secProxyMarket");
  section?.classList.add("proxy-market-loading");
  const request = Promise.allSettled([
    loadProxyMarketItems(),
    loadProxyMarketAllocations(),
    loadProxyPurchasedAssets(),
    loadProxyMarketSettings(),
    loadProxyPurchaseConfig().then(() => loadProxyPurchaseProviderOptions({
      serviceId: "static-residential-ipv4",
      planId: String(el("proxyPurchasePlanId")?.value || ""),
    })),
    loadProxyPurchaseExchangeRate(),
    loadProxyPurchaseOrders(),
  ]).finally(() => {
    section?.classList.remove("proxy-market-loading");
    if (adminState.proxyMarketLoadingPromise === request) adminState.proxyMarketLoadingPromise = null;
  });
  adminState.proxyMarketLoadingPromise = request;
  return request;
}

function resetProxyMarketEditor({ focus = false } = {}) {
  adminState.proxyMarketInspectRequestId += 1;
  adminState.proxyMarketSelectedItemId = null;
  el("proxyMarketItemForm")?.reset();
  if (el("btnInspectProxyMarketConnection")) el("btnInspectProxyMarketConnection").disabled = false;
  if (el("proxyMarketSku")) el("proxyMarketSku").disabled = false;
  if (el("proxyMarketCurrency")) el("proxyMarketCurrency").value = "TWD";
  if (el("proxyMarketPriceCents")) el("proxyMarketPriceCents").value = "0";
  if (el("proxyMarketProxyType")) el("proxyMarketProxyType").value = "socks5";
  if (el("proxyMarketBillingCycle")) el("proxyMarketBillingCycle").value = "month";
  setText("proxyMarketEditorTitle", "新建代理");
  setText("proxyMarketEditorHint", "可先保存草稿，或直接点击“检测并发布”完成真实检测和发布。");
  setText("proxyMarketEditorState", "当前为新建模式");
  setText("proxyMarketCredentialNote", "后台不会回显已保存凭据。编辑时空密码不会覆盖原密码。");
  setProxyMarketSmartResult("粘贴内容会保留，请点击“识别并填充”开始解析。");
  setMsg("proxyMarketItemMsg", "");
  setProxyMarketEditorBusy(false);
  if (focus) {
    el("proxyMarketEditor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => el("proxyMarketSku")?.focus(), 250);
  }
}

function editProxyMarketItem(itemId, { focus = true } = {}) {
  const item = proxyMarketItemById(itemId);
  if (!item) return;
  adminState.proxyMarketInspectRequestId += 1;
  adminState.proxyMarketSelectedItemId = String(item.id || "");
  if (el("btnInspectProxyMarketConnection")) el("btnInspectProxyMarketConnection").disabled = false;
  if (el("proxyMarketSmartInput")) el("proxyMarketSmartInput").value = "";
  setProxyMarketSmartResult("可粘贴新连接信息覆盖候选字段；已保存凭据不会回显。");
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
  syncProxyMarketEditorActions();
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
  setProxyMarketEditorBusy(true);
  setMsg("proxyMarketItemMsg", publish ? "正在保存、检测并发布代理..." : "正在保存代理库存...");
  if (publish) {
    showAdminPublicPrompt({
      title: "代理检测与发布",
      message: "正在保存当前配置并执行真实连接检测，检测通过后会自动发布。",
      busy: true,
    });
  }
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
      applyProxyMarketItemLocally(result?.item, {
        id: itemId,
        status: "active",
        health_status: "healthy",
      });
    }
    if (el("proxyMarketUsername")) el("proxyMarketUsername").value = "";
    if (el("proxyMarketPassword")) el("proxyMarketPassword").value = "";
    const successMessage = publish
      ? `真实检测通过，代理已发布${Number(result?.check?.latency_ms || 0) ? `，延迟 ${Number(result.check.latency_ms)} ms` : ""}`
      : "代理库存已保存";
    await refreshProxyMarketItemsAfterWrite("proxyMarketItemMsg", successMessage);
    if (publish) {
      showAdminPublicPrompt({
        title: "检测发布完成",
        message: successMessage,
        ok: true,
      });
    }
    return result;
  } catch (error) {
    if (publish) {
      const prefix = error?.proxyMarketDraftSaved
        ? "草稿已保存并保留在编辑器中；检测发布失败"
        : error?.proxyMarketChangesSaved
          ? "库存修改已保存；检测发布失败"
          : "检测发布失败";
      showAdminPublicPrompt({
        title: "检测发布失败",
        message: `${prefix}：${getErrorMessage(error)}`,
        ok: false,
      });
      try { error.adminPublicPromptShown = true; } catch (_) {}
    }
    throw error;
  } finally {
    setProxyMarketEditorBusy(false);
  }
}

async function publishProxyMarketRow(itemId, button) {
  const item = proxyMarketItemById(itemId);
  if (!item) return;
  if (String(item.status || "") === "archived") {
    throw new Error("已归档的代理不能重新检测发布");
  }
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  setMsg("proxyMarketMsg", `正在重新检测并发布 ${item.sku || item.id}...`);
  showAdminPublicPrompt({
    title: "代理检测与发布",
    message: `正在使用已保存配置检测 ${item.sku || item.id}，检测通过后会自动发布。`,
    busy: true,
  });
  try {
    const result = await api(`/api/admin/proxy-market/items/${encodeURIComponent(item.id)}/test-and-publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proxyMarketPublishPayload(item)),
    });
    applyProxyMarketItemLocally(result?.item, {
      ...item,
      status: "active",
      health_status: "healthy",
    });
    await refreshProxyMarketItemsAfterWrite(
      "proxyMarketMsg",
      `${item.sku || item.id} 已通过检测并重新发布`,
    );
    showAdminPublicPrompt({
      title: "检测发布完成",
      message: `${item.sku || item.id} 已通过检测并自动发布${Number(result?.check?.latency_ms || 0) ? `，延迟 ${Number(result.check.latency_ms)} ms` : ""}。`,
      ok: true,
    });
    return result;
  } catch (error) {
    if (button instanceof HTMLSelectElement) button.value = String(item.status || "");
    showAdminPublicPrompt({
      title: "检测发布失败",
      message: getErrorMessage(error),
      ok: false,
    });
    try { error.adminPublicPromptShown = true; } catch (_) {}
    throw error;
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

async function updateProxyMarketStatus(itemId, status, control) {
  const item = proxyMarketItemById(itemId);
  if (!item || status === String(item.status || "")) return;
  if (status === "active") return publishProxyMarketRow(itemId, control);
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
    showAdminPublicPrompt({
      title: "库存状态已更新",
      message: `${item.sku || item.id} 已切换为${PROXY_MARKET_STATUS_LABELS[updated?.status || status] || updated?.status || status}。`,
      ok: true,
    });
  } finally {
    control.disabled = false;
  }
}

async function archiveProxyMarketItem(itemId, button) {
  const item = proxyMarketItemById(itemId);
  if (!item) return;
  const decision = await requestAdminPublicAction({
    title: "归档代理库存",
    message: `确认归档 ${item.sku || item.id} 吗？代理池将停止展示，关联代理也会被禁用。`,
    confirmLabel: "确认归档",
    tone: "danger",
  });
  if (!decision.confirmed) return;
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
  const decision = await requestAdminPublicAction({
    title: "回收客户代理",
    message: `确认回收客户 ${allocation.username || allocation.user_id || "-"} 的 ${allocation.sku || allocation.item_id || "代理"} 吗？${impact}`,
    confirmLabel: "确认回收",
    tone: "danger",
  });
  if (!decision.confirmed) return;
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
  const inventoryCapacity = Math.round(Number(el("proxyMarketInventoryCapacity")?.value));
  const claimLimit = Math.round(Number(el("proxyMarketDefaultClaimLimit")?.value));
  const healthHours = Number(el("proxyMarketHealthMaxAgeHours")?.value);
  if (!Number.isSafeInteger(inventoryCapacity) || inventoryCapacity < 0) throw new Error("库存容量上限需为非负整数，0 表示不限量");
  if (!Number.isSafeInteger(claimLimit) || claimLimit < 0) throw new Error("每客户默认领取上限需为非负整数");
  if (!Number.isFinite(healthHours) || healthHours < (5 / 60) || healthHours > 168) throw new Error("健康有效时长需在 5 分钟至 168 小时之间");
  const payload = {
    inventory_capacity: inventoryCapacity,
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
  setMsg("proxyMarketSettingsMsg", "代理池库存、领取与健康策略已保存", true);
  return result;
}

async function saveProxyMarketUserLimit() {
  const userId = Math.round(Number(el("proxyMarketLimitUserId")?.value || 0));
  const rawLimit = String(el("proxyMarketUserClaimLimit")?.value || "").trim();
  const claimLimit = rawLimit === "" ? null : Math.round(Number(rawLimit));
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("请输入有效的客户 ID");
  if (claimLimit !== null && (!Number.isSafeInteger(claimLimit) || claimLimit < 0)) {
    throw new Error("客户单独领取上限需为非负整数，留空可恢复默认");
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
    container.appendChild(markAdminDynamicUiElement(
      createEmptyState(kind === "group" ? "尚未创建客户分组" : "尚未创建客户标签"),
    ));
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
      markAdminDynamicUiElement(option);
      color.appendChild(option);
    });
    const count = document.createElement("span");
    count.className = "admin-taxonomy-count";
    count.append(
      String(Number(item.member_count || 0)),
      " ",
      createAdminDynamicUiText("位客户"),
    );
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ghost";
    save.textContent = "保存";
    save.dataset.taxonomySave = String(item.id || "");
    save.dataset.taxonomyKind = kind;
    markAdminDynamicUiElement(save);
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
    window.open(`/api/tasks/${id}/download?admin_console=1`, "_blank");
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
    const decision = await requestAdminPublicAction({
      title: "删除生成记录",
      message: `确认删除生成记录 ${id} 吗？`,
      confirmLabel: "确认删除",
      tone: "danger",
    });
    if (!decision.confirmed) return true;
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
  el("billingCatalogEditorTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-billing-editor-tab]");
    if (!button) return;
    setBillingCatalogEditorTab(button.dataset.billingEditorTab, { focus: true });
  });
  el("billingCatalogEditorTabs")?.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll("#billingCatalogEditorTabs button[data-billing-editor-tab]")];
    const currentIndex = tabs.indexOf(event.target.closest("button[data-billing-editor-tab]"));
    if (currentIndex < 0 || !tabs.length) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    setBillingCatalogEditorTab(tabs[nextIndex].dataset.billingEditorTab, { focus: true });
  });
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
      setMsg("billingCatalogMsg", "当前还没有已发布的套餐设置", false);
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
    setMsg("billingOrderMsg", "");
    try {
      if (button.dataset.billingAction === "order-refund") {
        await refundBillingOrder(button.dataset.id);
      } else {
        const status = button.dataset.billingAction === "order-approve" ? "approved" : "rejected";
        await reviewBillingOrder(button.dataset.id, status);
      }
    } catch (err) {
      setMsg("billingOrderMsg", getErrorMessage(err), false);
    }
  });
  el("billingSubscriptionBody")?.addEventListener("click", async (event) => {
    const button = event.target.closest('button[data-billing-action="subscription-terminate"]');
    if (!button) return;
    event.stopPropagation();
    setMsg("billingUserMsg", "");
    try {
      await terminateBillingSubscription(button.dataset.id);
    } catch (err) {
      setMsg("billingUserMsg", getErrorMessage(err), false);
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
  el("btnCrmAdminRefresh")?.addEventListener("click", () => void loadCrmAdminModule());
  el("crmGlobalSettingsForm")?.addEventListener("submit", saveCrmGlobalSettings);
  el("btnCrmUserAccessLoad")?.addEventListener("click", () => void loadCrmUserAccess());
  el("crmUserAccessId")?.addEventListener("input", resetCrmUserAccessEditor);
  el("crmUserAccessForm")?.addEventListener("submit", saveCrmUserAccess);
  el("crmImportDryRunForm")?.addEventListener("submit", runCrmImportDryRun);
  el("crmImportActivateForm")?.addEventListener("submit", activateCrmImport);
  el("btnCrmImportDismiss")?.addEventListener("click", () => void dismissCrmImport());
  el("btnCrmEmergencyPause")?.addEventListener("click", async () => {
    const decision = await requestAdminPublicAction({
      title: "紧急暂停 CRM",
      message: "当前提交中的单动作将按安全边界收尾，其余 CRM 父流程会暂停。确认继续吗？",
      confirmLabel: "确认紧急暂停",
      tone: "danger",
    });
    if (!decision.confirmed) return;
    try {
      const payload = await api("/api/admin/modules/crm/emergency-pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
      setMsg("crmGlobalMsg", `已紧急暂停；暂停流程 ${Number(payload?.paused_workflows || 0)} 个。`, true);
      await loadCrmAdminModule();
    } catch (err) {
      setMsg("crmGlobalMsg", getErrorMessage(err), false);
    }
  });
  bindModelTabs();
  bindTextModelContentTabs();
  bindRunningHubSlotTabs();
  el("btnRefreshGovernance")?.addEventListener("click", () => void loadGovernanceDashboard({ force: true }));
  el("governanceRange")?.addEventListener("change", () => { syncGovernanceRangeControls(); void loadGovernanceDashboard({ force: true }); });
  el("governanceStartDate")?.addEventListener("change", () => void loadGovernanceDashboard({ force: true }));
  el("governanceEndDate")?.addEventListener("change", () => void loadGovernanceDashboard({ force: true }));
  el("btnEmailDeliveryPolicy")?.addEventListener("click", openEmailDeliveryPolicyModal);
  el("btnEmailDeliveryPolicyClose")?.addEventListener("click", closeEmailDeliveryPolicyModal);
  el("btnEmailDeliveryPolicyCancel")?.addEventListener("click", closeEmailDeliveryPolicyModal);
  el("btnEmailDeliveryPolicySave")?.addEventListener("click", () => void saveEmailDeliveryPolicy());
  el("emailDeliveryLimitMode")?.addEventListener("change", syncEmailDeliveryPolicyFields);
  el("emailDeliveryPolicyModal")?.addEventListener("keydown", handleEmailDeliveryPolicyModalKeydown);
  syncGovernanceRangeControls();
  el("btnRefreshAudit")?.addEventListener("click", () => {
    adminState.auditListPage = 1;
    void loadAuditEvents();
  });
  el("btnExportAudit")?.addEventListener("click", () => void exportAuditEvents());
  el("auditFilterForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    adminState.auditListPage = 1;
    void loadAuditEvents();
  });
  el("btnRefreshSecurity")?.addEventListener("click", () => {
    adminState.securityListPage = 1;
    void loadSecurityAlerts();
  });
  el("securityFilterForm")?.addEventListener("change", () => {
    adminState.securityListPage = 1;
    void loadSecurityAlerts();
  });
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
    setMsg("proxyMarketMsg", "正在刷新代理 IP...");
    await loadProxyMarketWorkspace();
  });
  el("proxyPurchaseConfigForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveProxyPurchaseConfig();
    } catch (error) {
      setMsg("proxyPurchaseConfigMsg", getErrorMessage(error), false);
    }
  });
  el("btnPublishProxyPurchaseConfig")?.addEventListener("click", async () => {
    try {
      await publishProxyPurchaseConfig();
    } catch (error) {
      setMsg("proxyPurchaseConfigMsg", getErrorMessage(error), false);
    }
  });
  el("btnRefreshProxyPurchaseProvider")?.addEventListener("click", async () => {
    try { await loadProxyPurchaseProviderOptions({ persist: true }); } catch {}
  });
  el("btnRefreshProxyPurchaseFx")?.addEventListener("click", async () => {
    try { await loadProxyPurchaseExchangeRate({ refresh: true }); } catch (error) {
      setText("proxyPurchaseFxMeta", `刷新失败：${getErrorMessage(error)}`);
    }
  });
  el("proxyPurchaseFxMode")?.addEventListener("change", syncProxyPurchaseFxMode);
  el("proxyProviderCredentialForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await saveProxyProviderCredentials(); } catch (error) {
      setMsg("proxyProviderCredentialMsg", getErrorMessage(error), false);
    }
  });
  el("btnTestProxyProviderCredentials")?.addEventListener("click", async () => {
    try { await testProxyProviderCredentials({ useInputs: true }); } catch (error) {
      setMsg("proxyProviderCredentialMsg", getErrorMessage(error), false);
    }
  });
  el("proxyPurchaseServiceId")?.addEventListener("change", async () => {
    if (el("proxyPurchasePlanId")) el("proxyPurchasePlanId").value = "";
    try {
      await loadProxyPurchaseProviderOptions({
        serviceId: "static-residential-ipv4",
        planId: "",
      });
    } catch {}
  });
  el("proxyPurchasePlanId")?.addEventListener("change", async () => {
    try {
      await loadProxyPurchaseProviderOptions({
        serviceId: "static-residential-ipv4",
        planId: String(el("proxyPurchasePlanId")?.value || ""),
      });
    } catch {}
  });
  el("btnRefreshProxyPurchaseOrders")?.addEventListener("click", async () => {
    try { await loadProxyPurchaseOrders(); } catch {}
  });
  el("proxyPurchaseOrderBody")?.addEventListener("click", async (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("button[data-proxy-purchase-order-id]")
      : null;
    if (!(button instanceof HTMLButtonElement)) return;
    selectProxyPurchaseOrderResolution(
      button.dataset.proxyPurchaseOrderId || "",
      button.dataset.proxyPurchaseAction || "reconcile",
    );
  });
  el("proxyPurchaseResolutionAction")?.addEventListener("change", () => {
    selectProxyPurchaseOrderResolution(
      String(el("proxyPurchaseResolutionOrderId")?.value || ""),
      String(el("proxyPurchaseResolutionAction")?.value || "reconcile"),
    );
  });
  el("proxyPurchaseOrderResolutionForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await resolveProxyPurchaseOrder();
    } catch (error) {
      setMsg("proxyPurchaseOrderMsg", getErrorMessage(error), false);
    }
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
  el("btnPasteProxyMarketSmartInput")?.addEventListener("click", async () => {
    try {
      const value = await navigator.clipboard.readText();
      if (!value.trim()) {
        setProxyMarketSmartResult("剪贴板中没有可识别的文本。", "error");
        return;
      }
      if (el("proxyMarketSmartInput")) el("proxyMarketSmartInput").value = value;
      setProxyMarketSmartResult("内容已粘贴，请点击“识别并填充”开始解析。");
      el("proxyMarketSmartInput")?.focus();
    } catch {
      el("proxyMarketSmartInput")?.focus();
      setProxyMarketSmartResult("浏览器未允许读取剪贴板，请手动粘贴后识别。", "error");
    }
  });
  el("btnParseProxyMarketSmartInput")?.addEventListener("click", () => {
    void applyProxyMarketSmartInput().catch((error) => {
      setProxyMarketSmartResult(getErrorMessage(error), "error");
    });
  });
  el("btnInspectProxyMarketConnection")?.addEventListener("click", async () => {
    try {
      await inspectProxyMarketConnection();
    } catch {}
  });
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
      if (!error?.adminPublicPromptShown) {
        showAdminPublicPrompt({
          title: "检测发布失败",
          message: `${prefix}：${getErrorMessage(error)}`,
          ok: false,
        });
      }
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
      if (!error?.adminPublicPromptShown) {
        showAdminPublicPrompt({ title: "代理操作失败", message: getErrorMessage(error), ok: false });
      }
    }
  });
  el("proxyMarketItemBody")?.addEventListener("change", async (event) => {
    const control = event.target;
    if (!(control instanceof HTMLSelectElement) || !control.dataset.proxyMarketStatus) return;
    try {
      await updateProxyMarketStatus(control.dataset.proxyMarketStatus, control.value, control);
    } catch (error) {
      setMsg("proxyMarketMsg", getErrorMessage(error), false);
      if (!error?.adminPublicPromptShown) {
        showAdminPublicPrompt({ title: "状态切换失败", message: getErrorMessage(error), ok: false });
      }
    }
  });
  el("proxyMarketRecordsTabs")?.addEventListener("click", (event) => {
    const tab = event.target instanceof Element
      ? event.target.closest("button[data-proxy-market-records-view]")
      : null;
    if (!(tab instanceof HTMLButtonElement)) return;
    setProxyMarketRecordsView(tab.dataset.proxyMarketRecordsView || "inventory");
  });
  el("proxyMarketRecordsTabs")?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [
      el("proxyMarketInventoryTab"),
      el("proxyMarketAllocationTab"),
      el("proxyMarketPurchasedTab"),
    ].filter((tab) => tab instanceof HTMLButtonElement);
    if (!tabs.length) return;
    const currentIndex = Math.max(0, tabs.indexOf(document.activeElement));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setProxyMarketRecordsView(nextTab.dataset.proxyMarketRecordsView || "inventory");
    nextTab.focus();
  });
  el("proxyMarketAllocationStatus")?.addEventListener("change", async () => {
    try {
      await loadProxyMarketAllocations();
    } catch {}
  });
  el("proxyMarketPurchasedQuery")?.addEventListener("change", async () => {
    try { await loadProxyPurchasedAssets(); } catch {}
  });
  el("proxyMarketPurchasedStatus")?.addEventListener("change", async () => {
    try { await loadProxyPurchasedAssets(); } catch {}
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
    setMsg("proxyMarketSettingsMsg", "正在保存代理策略...");
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
  el("btnSaveRuntime").addEventListener("click", async () => {
    setMsg("runtimeMsg", "");
    try {
      await saveRuntime();
      setMsg("runtimeMsg", "运行配置已保存，并已按本地配置文件内容回填表单", true);
    } catch (err) {
      setMsg("runtimeMsg", formatRuntimeConfigError("保存", err), false);
    }
  });
  el("btnSaveSocialAutomationPolicy")?.addEventListener("click", async () => {
    const button = el("btnSaveSocialAutomationPolicy");
    setMsg("socialAutomationPolicyMsg", "");
    if (button) button.disabled = true;
    try {
      await saveSocialAutomationPolicy();
      await loadSocialAutomationPolicy();
      setMsg("socialAutomationPolicyMsg", "社媒自动化保护参数已保存。", true);
    } catch (error) {
      setMsg("socialAutomationPolicyMsg", getErrorMessage(error), false);
    } finally {
      if (button) button.disabled = false;
    }
  });
  el("rtGoogleLoginEnabled")?.addEventListener("change", syncRuntimeAuthProviderAvailability);
  el("btnRunBrowserCacheCleanup")?.addEventListener("click", () => void runBrowserCacheCleanupNow());

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
  if (el("btnAddVideoImagePriorityModel")) {
    el("btnAddVideoImagePriorityModel").addEventListener("click", (event) => {
      event.stopPropagation();
      const model = String(el("rtVideoImageModelCandidate")?.value || "").trim();
      if (!VIDEO_IMAGE_MODEL_OPTIONS.includes(model)) return;
      if (!adminState.videoImagePriorityModels.includes(model)) {
        adminState.videoImagePriorityModels.push(model);
        writeModelDraft();
        renderAllModelLists();
      }
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
  el("adminSelectAllUsers")?.addEventListener("change", async (event) => {
    if (!event.currentTarget.checked) {
      clearUserBatchSelection();
      return;
    }
    adminState.userBatchSelectionInFlight = true;
    resetUserBatchRequest();
    syncUserBatchSelection();
    try {
      await selectAllFilteredUsers();
    } catch (error) {
      adminState.selectedUserIds.clear();
      event.currentTarget.checked = false;
      setMsg("userMsg", getErrorMessage(error), false);
    } finally {
      adminState.userBatchSelectionInFlight = false;
      syncUserBatchSelection();
    }
  });
  el("userBody")?.addEventListener("change", (event) => {
    const input = event.target.closest?.("input[data-user-select]");
    if (!input) return;
    const id = String(input.dataset.userSelect || "");
    if (input.checked) adminState.selectedUserIds.add(id);
    else adminState.selectedUserIds.delete(id);
    resetUserBatchRequest();
    syncUserBatchSelection();
  });
  document.querySelectorAll("[data-user-batch-action]").forEach((button) => {
    button.addEventListener("click", () => openUserBatchModal(button.dataset.userBatchAction));
  });
  el("btnAdminUserBatchClose")?.addEventListener("click", closeUserBatchModal);
  el("btnAdminUserBatchCancel")?.addEventListener("click", closeUserBatchModal);
  el("adminUserBatchUnlimited")?.addEventListener("change", syncUserBatchUnlimitedMode);
  el("btnAdminUserBatchCreditShortcutAdd")?.addEventListener("click", () => toggleAdminCreditShortcutForm());
  el("adminUserBatchCreditShortcutForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveAdminCreditShortcut();
  });
  el("adminUserBatchCreditShortcutList")?.addEventListener("click", (event) => {
    const removeButton = event.target.closest?.("[data-credit-shortcut-remove]");
    if (removeButton) {
      removeAdminCreditShortcut(removeButton.dataset.creditShortcutRemove);
      return;
    }
    const applyButton = event.target.closest?.("[data-credit-shortcut-apply]");
    if (applyButton) applyAdminCreditShortcut(applyButton.dataset.creditShortcutApply);
  });
  el("btnAdminUserBatchConfirm")?.addEventListener("click", async () => {
    try {
      await submitUserBatchModal();
    } catch {
      // Error details are displayed inside the modal.
    }
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
      taskState.page = 1;
      renderTasks();
    });
  });

  if (el("btnTaskFilterReset")) {
    el("btnTaskFilterReset").addEventListener("click", () => {
      if (el("taskSearch")) el("taskSearch").value = "";
      if (el("taskStatusFilter")) el("taskStatusFilter").value = "";
      if (el("taskWorkflowFilter")) el("taskWorkflowFilter").value = "";
      if (el("taskUserFilter")) el("taskUserFilter").value = "";
      taskState.page = 1;
      renderTasks();
    });
  }

  el("btnTaskPagePrev")?.addEventListener("click", () => {
    taskState.page = Math.max(1, Number(taskState.page || 1) - 1);
    renderTasks();
  });
  el("btnTaskPageNext")?.addEventListener("click", () => {
    taskState.page = Number(taskState.page || 1) + 1;
    renderTasks();
  });
  el("btnAuditPagePrev")?.addEventListener("click", () => {
    if (adminState.auditListPage <= 1) return;
    adminState.auditListPage -= 1;
    void loadAuditEvents();
  });
  el("btnAuditPageNext")?.addEventListener("click", () => {
    const totalPages = Math.max(
      1,
      Math.ceil(Number(adminState.auditListTotal || 0) / Number(adminState.auditListPageSize || 20)),
    );
    if (adminState.auditListPage >= totalPages) return;
    adminState.auditListPage += 1;
    void loadAuditEvents();
  });
  el("btnSecurityPagePrev")?.addEventListener("click", () => {
    adminState.securityListPage = Math.max(1, Number(adminState.securityListPage || 1) - 1);
    renderSecurityAlerts({ items: adminState.securityRows });
  });
  el("btnSecurityPageNext")?.addEventListener("click", () => {
    adminState.securityListPage = Number(adminState.securityListPage || 1) + 1;
    renderSecurityAlerts({ items: adminState.securityRows });
  });

  if (el("btnSentimentCookieRefresh")) {
    el("btnSentimentCookieRefresh").addEventListener("click", async () => {
      setButtonLoading("btnSentimentCookieRefresh", true, "检测中");
      setMsg("sentimentCookieMsg", "正在执行平台实时状态检测...");
      try {
        await loadSentimentCookieProfiles({ force: true });
        setMsg("sentimentCookieMsg", "平台实时状态检测已完成。", true);
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      } finally {
        setButtonLoading("btnSentimentCookieRefresh", false);
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
  el("btnAdminPublicPromptClose")?.addEventListener("click", closeAdminPublicPrompt);
  el("btnAdminPublicPromptDone")?.addEventListener("click", closeAdminPublicPrompt);
  el("btnAdminPublicActionClose")?.addEventListener("click", () => settleAdminPublicAction("dismiss"));
  el("btnAdminPublicActionCancel")?.addEventListener("click", () => settleAdminPublicAction("cancel"));
  el("btnAdminPublicActionConfirm")?.addEventListener("click", () => settleAdminPublicAction("confirm"));
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
  if (el("btnUserDetailClose")) {
    el("btnUserDetailClose").addEventListener("click", closeUserDetailModal);
  }
  el("btnSaveUserAuthMethods")?.addEventListener("click", () => void saveSelectedUserAuthMethods());
  el("btnUnlinkUserGoogle")?.addEventListener("click", () => void unlinkSelectedUserGoogle());
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
      const decision = await requestAdminPublicAction({
        title: "拒绝账号申请",
        message: "确认拒绝该账号的使用申请吗？",
        confirmLabel: "确认拒绝",
        tone: "danger",
      });
      if (!decision.confirmed) return;
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
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el("adminPublicActionModal")?.getAttribute("aria-hidden") === "false") {
      e.preventDefault();
      settleAdminPublicAction("dismiss");
      return;
    }
    if (trapUserDetailFocus(e)) return;
    if (e.key === "Escape") {
      closeAdminPublicPrompt();
      closeUserBatchModal();
      closeTaskInspectModal();
      closeRechargeModal();
      closeUserDetailModal();
      closeEmailDeliveryPolicyModal();
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
      const decision = await requestAdminPublicAction({
        title: "删除客户账号",
        message: `确认删除客户 ${name} 吗？账号身份将立即下线，但人设、推文、任务、额度流水和其他业务数据都会保留，可由管理员恢复。`,
        confirmLabel: "确认删除",
        tone: "danger",
      });
      if (!decision.confirmed) return;
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
      const decision = await requestAdminPublicAction({
        title: "恢复客户账号",
        message: `确认恢复客户 ${name} 的登录权限吗？`,
        confirmLabel: "确认恢复",
      });
      if (!decision.confirmed) return;
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
  try {
    const me = await ensureAdmin();
    if (!me) return;
    initSensitiveInputToggles();
    initRuntimeSecretMaskInputs();
    initProviderSecretMaskInputs();
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
    await loadSocialAutomationPolicy();
    setMsg("socialAutomationPolicyMsg", "");
  } catch (err) {
    setMsg("socialAutomationPolicyMsg", getErrorMessage(err), false);
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
    if (!document.hidden && adminState.activePage === "overview") void loadGovernanceDashboard({ force: true });
  }, GOVERNANCE_POLL_INTERVAL_MS);
  setInterval(() => {
    void refreshSentimentCookieProfilesIfActive({ force: true });
  }, SENTIMENT_COOKIE_POLL_INTERVAL_MS);
});

window.addEventListener("hashchange", () => {
  setActiveAdminPage(readAdminPageFromHash(), false);
});

window.addEventListener("storage", (event) => {
  if (event.key === "vecto-auth-session-changed") window.location.reload();
});
