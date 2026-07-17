const header = document.querySelector("[data-header]");
const applicationForm = document.querySelector("#contact");
const applicationStatus = document.querySelector("#formStatus");
const loginModal = document.querySelector("#loginModal");
const loginForm = document.querySelector("#homeLoginForm");
const loginStatus = document.querySelector("#loginStatus");
const loginPassword = document.querySelector("#loginPassword");
const loginPasswordToggle = document.querySelector("[data-login-password-toggle]");
const loginRemember = loginForm?.elements?.remember_me || null;
const loginTakeover = document.querySelector("[data-login-takeover]");
let loginReturnFocus = null;

const publicI18nTextOriginals = new WeakMap();
const publicI18nAttributeOriginals = new WeakMap();
const publicDocumentTitle = document.title;
let publicLanguageObserver = null;
let traditionalToSimplifiedCharacters = null;
let traditionalToSimplifiedPhrases = null;
let simplifiedToTraditionalCharacters = null;
let simplifiedToTraditionalPhrases = null;

const PUBLIC_I18N_MARKER = "data-i18n-ui";
const PUBLIC_I18N_DYNAMIC_MARKER = "data-i18n-dynamic";
const PUBLIC_I18N_SKIP_SELECTOR = "[data-i18n-skip], [data-site-header], script, style, textarea";
const PUBLIC_I18N_ATTRIBUTES = ["title", "aria-label", "placeholder", "data-mobile-label"];

const traditionalToSimplifiedOverrides = [
  ["帳號", "账号"],
  ["帳戶", "账户"],
  ["三帳", "三账号"],
  ["登入", "登录"],
  ["目前", "当前"],
  ["營運", "运营"],
  ["後台", "后台"],
  ["回覆", "回复"],
  ["佇列", "队列"],
];

const simplifiedToTraditionalOverrides = [
  ["Web 任务控制台", "Web 任務控制台"],
  ["头发", "頭髮"],
  ["发型", "髮型"],
  ["理发", "理髮"],
  ["美发", "美髮"],
  ["长发", "長髮"],
  ["短发", "短髮"],
  ["白发", "白髮"],
  ["皇后", "皇后"],
  ["太后", "太后"],
  ["王后", "王后"],
  ["干杯", "乾杯"],
  ["饼干", "餅乾"],
  ["干燥", "乾燥"],
  ["干净", "乾淨"],
  ["干脆", "乾脆"],
  ["晒干", "曬乾"],
  ["风干", "風乾"],
  ["烘干", "烘乾"],
  ["干涉", "干涉"],
  ["干预", "干預"],
  ["干扰", "干擾"],
  ["若干", "若干"],
  ["账号", "帳號"],
  ["控制台", "控制台"],
  ["控制", "控制"],
  ["後台", "後台"],
  ["后台", "後台"],
  ["回复", "回覆"],
  ["当前", "目前"],
  ["批量", "批次"],
  ["创建", "建立"],
];

function parseOpenCcDictionary(dictionary) {
  if (typeof dictionary !== "string") return [];
  return dictionary.split("|").flatMap((entry) => {
    const separator = entry.indexOf(" ");
    if (separator <= 0) return [];
    return [[entry.slice(0, separator), entry.slice(separator + 1)]];
  });
}

function getTraditionalToSimplifiedCharacters() {
  if (traditionalToSimplifiedCharacters) return traditionalToSimplifiedCharacters;
  traditionalToSimplifiedCharacters = new Map(parseOpenCcDictionary(window.VectoOpenCcTsCharacters));
  return traditionalToSimplifiedCharacters;
}

function getTraditionalToSimplifiedPhrases() {
  if (traditionalToSimplifiedPhrases) return traditionalToSimplifiedPhrases;
  traditionalToSimplifiedPhrases = [
    ...traditionalToSimplifiedOverrides,
    ...parseOpenCcDictionary(window.VectoOpenCcTsPhrases),
  ]
    .sort((left, right) => right[0].length - left[0].length);
  return traditionalToSimplifiedPhrases;
}

function getSimplifiedToTraditionalCharacters() {
  if (simplifiedToTraditionalCharacters) return simplifiedToTraditionalCharacters;
  simplifiedToTraditionalCharacters = new Map(parseOpenCcDictionary(window.VectoOpenCcStCharacters));
  return simplifiedToTraditionalCharacters;
}

function getSimplifiedToTraditionalPhrases() {
  if (simplifiedToTraditionalPhrases) return simplifiedToTraditionalPhrases;
  const reversedOpenCcPhrases = parseOpenCcDictionary(window.VectoOpenCcTsPhrases)
    .map(([traditional, simplified]) => [simplified, traditional]);
  simplifiedToTraditionalPhrases = [
    ...simplifiedToTraditionalOverrides,
    ...reversedOpenCcPhrases,
  ].sort((left, right) => right[0].length - left[0].length);
  return simplifiedToTraditionalPhrases;
}

function convertWithProtectedPhrases(value, phrases, characters, tokenBase) {
  let text = String(value || "");
  const protectedPhrases = [];
  [...phrases].sort((left, right) => right[0].length - left[0].length).forEach(([source, target], index) => {
    if (!text.includes(source)) return;
    const token = `${tokenBase}${index}\uE1FF`;
    text = text.split(source).join(token);
    protectedPhrases.push([token, target]);
  });
  text = Array.from(text).map((character) => characters.get(character) || character).join("");
  protectedPhrases.forEach(([token, target]) => {
    text = text.split(token).join(target);
  });
  return text;
}

function toSimplifiedChinese(value) {
  return convertWithProtectedPhrases(
    value,
    getTraditionalToSimplifiedPhrases(),
    getTraditionalToSimplifiedCharacters(),
    "\uE100",
  );
}

function toTraditionalChinese(value) {
  return convertWithProtectedPhrases(
    value,
    getSimplifiedToTraditionalPhrases(),
    getSimplifiedToTraditionalCharacters(),
    "\uE200",
  );
}

function publicUiElements(root) {
  if (!root) return [];
  if (root.nodeType === Node.TEXT_NODE) {
    const parent = root.parentElement;
    return parent?.matches(`[${PUBLIC_I18N_MARKER}]`) ? [parent] : [];
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return [];
  const elements = [];
  if (root.nodeType === Node.ELEMENT_NODE && root.matches(`[${PUBLIC_I18N_MARKER}]`)) elements.push(root);
  root.querySelectorAll?.(`[${PUBLIC_I18N_MARKER}]`).forEach((node) => elements.push(node));
  return elements;
}

function markPublicUiElement(node, { dynamic = false } = {}) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE || node.closest(PUBLIC_I18N_SKIP_SELECTOR)) return;
  node.setAttribute(PUBLIC_I18N_MARKER, "true");
  if (dynamic) node.setAttribute(PUBLIC_I18N_DYNAMIC_MARKER, "true");
}

function markPublicStaticUi(root = document.body) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim() || node.parentElement?.closest(PUBLIC_I18N_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) markPublicUiElement(walker.currentNode.parentElement);
  root.querySelectorAll("[title], [aria-label], [placeholder], [data-mobile-label]").forEach((node) => markPublicUiElement(node));
  [applicationStatus, loginStatus, loginPasswordToggle, ...document.querySelectorAll(".field-error")]
    .forEach((node) => markPublicUiElement(node, { dynamic: true }));
}

function translatePublicTextNode(node, language) {
  const parent = node?.parentElement;
  if (!node?.nodeValue?.trim() || !parent?.matches(`[${PUBLIC_I18N_MARKER}]`)) return;
  if (!publicI18nTextOriginals.has(node)) publicI18nTextOriginals.set(node, node.nodeValue);
  const original = publicI18nTextOriginals.get(node);
  const translated = language === "zh-Hans"
    ? toSimplifiedChinese(original)
    : parent.hasAttribute(PUBLIC_I18N_DYNAMIC_MARKER) ? toTraditionalChinese(original) : original;
  if (node.nodeValue !== translated) node.nodeValue = translated;
}

function translatePublicAttributes(node, language) {
  if (!node?.matches?.(`[${PUBLIC_I18N_MARKER}]`) || node.closest(PUBLIC_I18N_SKIP_SELECTOR)) return;
  PUBLIC_I18N_ATTRIBUTES.forEach((attribute) => {
    if (!node.hasAttribute(attribute)) return;
    let originals = publicI18nAttributeOriginals.get(node);
    if (!originals) {
      originals = {};
      publicI18nAttributeOriginals.set(node, originals);
    }
    if (!Object.prototype.hasOwnProperty.call(originals, attribute)) originals[attribute] = node.getAttribute(attribute) || "";
    const original = originals[attribute];
    const translated = language === "zh-Hans"
      ? toSimplifiedChinese(original)
      : node.hasAttribute(PUBLIC_I18N_DYNAMIC_MARKER) ? toTraditionalChinese(original) : original;
    if (node.getAttribute(attribute) !== translated) node.setAttribute(attribute, translated);
  });
}

function translatedPublicAttributeValue(node, original, language) {
  if (language === "zh-Hans") return toSimplifiedChinese(original);
  return node.hasAttribute(PUBLIC_I18N_DYNAMIC_MARKER) ? toTraditionalChinese(original) : original;
}

function refreshPublicUiAttributeSource(node, attribute, language) {
  if (!node?.matches?.(`[${PUBLIC_I18N_MARKER}]`) || !PUBLIC_I18N_ATTRIBUTES.includes(attribute)) return;
  let originals = publicI18nAttributeOriginals.get(node);
  if (!originals) {
    originals = {};
    publicI18nAttributeOriginals.set(node, originals);
  }
  const current = node.getAttribute(attribute) || "";
  const previous = originals[attribute];
  if (previous !== undefined && current === translatedPublicAttributeValue(node, previous, language)) return;
  originals[attribute] = current;
  const translated = translatedPublicAttributeValue(node, current, language);
  if (current !== translated) node.setAttribute(attribute, translated);
}

function refreshPublicUiTextSource(node, language) {
  if (!node?.nodeValue?.trim() || !node.parentElement?.matches(`[${PUBLIC_I18N_MARKER}]`)) return;
  const current = node.nodeValue;
  const previous = publicI18nTextOriginals.get(node);
  const translatedPrevious = previous === undefined
    ? null
    : language === "zh-Hans"
      ? toSimplifiedChinese(previous)
      : node.parentElement.hasAttribute(PUBLIC_I18N_DYNAMIC_MARKER) ? toTraditionalChinese(previous) : previous;
  if (previous !== undefined && current === translatedPrevious) return;
  publicI18nTextOriginals.set(node, current);
  translatePublicTextNode(node, language);
}

function setPublicUiAttribute(node, attribute, sourceValue) {
  if (!node) return;
  markPublicUiElement(node, { dynamic: true });
  let originals = publicI18nAttributeOriginals.get(node);
  if (!originals) {
    originals = {};
    publicI18nAttributeOriginals.set(node, originals);
  }
  originals[attribute] = String(sourceValue || "");
  const language = window.VectoSiteNavigation?.currentLanguage() || "zh-Hant";
  const translated = language === "zh-Hans"
    ? toSimplifiedChinese(originals[attribute])
    : toTraditionalChinese(originals[attribute]);
  node.setAttribute(attribute, translated);
}

function translatePublicLanguage(root = document.body, language = window.VectoSiteNavigation?.currentLanguage() || "zh-Hant") {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    translatePublicTextNode(root, language);
    return;
  }
  publicUiElements(root).forEach((node) => {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) translatePublicTextNode(child, language);
    });
    translatePublicAttributes(node, language);
  });
  document.title = language === "zh-Hans" ? toSimplifiedChinese(publicDocumentTitle) : publicDocumentTitle;
}

function applyPublicLanguage(language) {
  const nextLanguage = language === "zh-Hant" ? "zh-Hant" : "zh-Hans";
  translatePublicLanguage(document.body, nextLanguage);
}

function startPublicLanguageObserver() {
  if (publicLanguageObserver || !document.body) return;
  publicLanguageObserver = new MutationObserver((mutations) => {
    const language = window.VectoSiteNavigation?.currentLanguage() || "zh-Hant";
    mutations.forEach((mutation) => {
      if (mutation.type === "attributes") {
        refreshPublicUiAttributeSource(mutation.target, mutation.attributeName, language);
        return;
      }
      if (mutation.type === "characterData") {
        refreshPublicUiTextSource(mutation.target, language);
        return;
      }
      mutation.addedNodes.forEach((node) => translatePublicLanguage(node, language));
    });
  });
  publicLanguageObserver.observe(document.body, {
    attributes: true,
    attributeFilter: PUBLIC_I18N_ATTRIBUTES,
    characterData: true,
    childList: true,
    subtree: true,
  });
}

function setHeaderState() {
  header?.classList.toggle("is-scrolled", window.scrollY > 12);
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "include", ...options });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text || `HTTP ${response.status}` };
  }
  if (!response.ok) throw data;
  return data;
}

function apiErrorDetail(error) {
  const detail = error?.detail;
  if (typeof detail === "string" && detail.trim()) {
    return { code: "", message: detail.trim() };
  }
  if (detail && typeof detail === "object") {
    return {
      code: String(detail.code || "").trim(),
      message: String(detail.message || detail.detail || "").trim(),
    };
  }
  return { code: "", message: "" };
}

function setFieldError(input, message) {
  const field = input.closest(".field");
  const error = field?.querySelector(".field-error");
  field?.classList.toggle("is-invalid", Boolean(message));
  input.setAttribute("aria-invalid", message ? "true" : "false");
  if (error) error.textContent = message;
}

function validateApplication(form) {
  const checks = [
    [form.fullName, form.fullName.value.trim().length >= 2, "請填寫姓名。"],
    [form.username, /^[A-Za-z0-9._-]{3,32}$/.test(form.username.value.trim()), "帳號需為 3-32 位英文、數字或 ._-。"],
    [form.password, form.password.value.length >= 8, "密碼至少需要 8 位。"],
    [form.phone, form.phone.value.trim().length >= 6, "請填寫可聯絡的電話。"],
  ];
  let valid = true;
  checks.forEach(([input, passed, message]) => {
    setFieldError(input, passed ? "" : message);
    if (!passed) valid = false;
  });
  if (form.email.value && !form.email.validity.valid) {
    setFieldError(form.email, "電子信箱格式不正確。");
    valid = false;
  } else {
    setFieldError(form.email, "");
  }
  if (!form.consent.checked) {
    applicationStatus.textContent = "請先同意提交資料供帳號審核。";
    valid = false;
  }
  return valid;
}

function loginFocusableElements() {
  if (!loginModal) return [];
  return [...loginModal.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
    .filter((node) => !node.hidden && node.getClientRects().length > 0);
}

function openLogin(event) {
  if (!loginModal) return;
  loginReturnFocus = event?.currentTarget instanceof HTMLElement
    ? event.currentTarget
    : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  loginModal.classList.add("is-open");
  loginModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  loginStatus.textContent = "";
  if (loginTakeover) loginTakeover.hidden = true;
  window.setTimeout(() => document.querySelector("#loginUsername")?.focus(), 40);
}

function setLoginPasswordRevealed(revealed) {
  if (!loginPassword || !loginPasswordToggle) return;
  loginPassword.type = revealed ? "text" : "password";
  loginPasswordToggle.classList.toggle("is-visible", revealed);
  loginPasswordToggle.setAttribute("aria-pressed", revealed ? "true" : "false");
  const label = revealed ? "隱藏密碼" : "顯示密碼";
  setPublicUiAttribute(loginPasswordToggle, "aria-label", label);
  setPublicUiAttribute(loginPasswordToggle, "title", label);
}

function closeLogin() {
  if (!loginModal?.classList.contains("is-open")) return;
  loginModal.classList.remove("is-open");
  loginModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  setLoginPasswordRevealed(false);
  const returnFocus = loginReturnFocus;
  loginReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}

document.querySelectorAll("[data-open-login]").forEach((button) => button.addEventListener("click", openLogin));
document.querySelectorAll("[data-console-entry]").forEach((link) => link.addEventListener("click", async (event) => {
  event.preventDefault();
  if (!window.VectoSiteNavigation?.openConsoleEntry) {
    openLogin({ currentTarget: link });
    return;
  }
  await window.VectoSiteNavigation.openConsoleEntry(link, {
    onUnauthorized: () => openLogin({ currentTarget: link }),
  });
}));
document.querySelectorAll("[data-close-login]").forEach((button) => button.addEventListener("click", closeLogin));
loginPasswordToggle?.addEventListener("click", () => {
  setLoginPasswordRevealed(loginPassword?.type === "password");
  loginPassword?.focus({ preventScroll: true });
});
document.addEventListener("keydown", (event) => {
  if (!loginModal?.classList.contains("is-open")) return;
  if (event.key === "Escape") {
    closeLogin();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = loginFocusableElements();
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

applicationForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  applicationStatus.textContent = "";
  if (!validateApplication(applicationForm)) return;
  const submit = applicationForm.querySelector("button[type='submit']");
  submit.disabled = true;
  try {
    const result = await api("/api/auth/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: applicationForm.fullName.value.trim(),
        username: applicationForm.username.value.trim(),
        password: applicationForm.password.value,
        email: applicationForm.email.value.trim(),
        phone: applicationForm.phone.value.trim(),
        company: applicationForm.company.value.trim(),
        use_case: applicationForm.useCase.value,
      }),
    });
    applicationStatus.textContent = result.message || "申請已提交，請等待管理員授權。";
    applicationForm.reset();
  } catch (error) {
    applicationStatus.textContent = error.detail || "提交失敗，請稍後再試。";
  } finally {
    submit.disabled = false;
  }
});

async function submitUserLogin(forceTakeover = false) {
  if (!loginForm || !loginStatus) return;
  loginStatus.textContent = "";
  const submit = loginForm.querySelector("button[type='submit']");
  submit.disabled = true;
  if (loginTakeover) loginTakeover.disabled = true;
  try {
    const result = await api("/api/auth/user-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: loginForm.username.value.trim(),
        password: loginForm.password.value,
        remember_me: Boolean(loginForm.remember_me?.checked),
        force_takeover: Boolean(forceTakeover),
      }),
    });
    const pageRedirect = String(document.body.dataset.loginRedirect || "/console.html");
    const safeRedirect = pageRedirect.startsWith("/") && !pageRedirect.startsWith("//") ? pageRedirect : "/console.html";
    window.location.assign(result?.must_change_password ? "/change-password.html" : safeRedirect);
  } catch (error) {
    const detail = apiErrorDetail(error);
    loginStatus.textContent = detail.message || "登入失敗，請檢查帳號與密碼。";
    if (loginTakeover) loginTakeover.hidden = detail.code !== "SESSION_CONFLICT";
    submit.disabled = false;
    if (loginTakeover) loginTakeover.disabled = false;
  }
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitUserLogin(false);
});

loginTakeover?.addEventListener("click", async () => {
  await submitUserLogin(true);
});

loginForm?.addEventListener("input", () => {
  if (loginTakeover) loginTakeover.hidden = true;
});

async function loadLoginPolicy() {
  if (!loginForm || !loginRemember) return;
  try {
    const policy = await api("/api/auth/policy");
    const enabled = policy.remember_login_enabled !== false;
    loginRemember.disabled = !enabled;
    loginRemember.checked = enabled && policy.remember_login_default === true;
    const rememberField = loginForm.querySelector("[data-login-remember]");
    if (rememberField) rememberField.hidden = !enabled;
  } catch {
    loginRemember.checked = false;
  }
}

applicationForm?.querySelectorAll("input").forEach((input) => {
  input.addEventListener("input", () => setFieldError(input, ""));
});
window.addEventListener("scroll", setHeaderState, { passive: true });
window.addEventListener("vecto:language-change", (event) => applyPublicLanguage(event.detail?.language));
markPublicStaticUi();
applyPublicLanguage(window.VectoSiteNavigation?.currentLanguage() || "zh-Hant");
startPublicLanguageObserver();
loadLoginPolicy();
setHeaderState();
