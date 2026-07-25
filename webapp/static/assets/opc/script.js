const header = document.querySelector("[data-header]");
const loginModal = document.querySelector("#loginModal");
const authDialog = loginModal?.querySelector(".auth-dialog");

function registrationPanelMarkup() {
  return `
    <section class="auth-register-view" data-auth-view="register" hidden>
      <p class="form-kicker">帳號註冊</p>
      <h2 id="registerTitle">註冊遊客帳號</h2>
      <p class="auth-copy">設定登入帳號並提交基本資料。管理員審核通過後，即可使用本次設定的帳號密碼登入 Web 任務控制台。</p>
      <form class="lead-form auth-registration-form" id="accountRegistrationForm" novalidate>
        <div class="application-grid">
          <label class="field" for="fullName"><span>姓名</span><input id="fullName" name="fullName" autocomplete="name" placeholder="請輸入姓名" aria-describedby="fullNameError" required /><small class="field-error" id="fullNameError"></small></label>
          <label class="field" for="username"><span>登入帳號</span><input id="username" name="username" autocomplete="username" placeholder="3-32 位英文、數字或 ._-" aria-describedby="usernameError" required /><small class="field-error" id="usernameError"></small></label>
          <label class="field" for="applyPassword"><span>登入密碼</span><input id="applyPassword" name="password" type="password" autocomplete="new-password" minlength="8" placeholder="至少 8 位" aria-describedby="applyPasswordError" required /><small class="field-error" id="applyPasswordError"></small></label>
          <label class="field" for="email"><span>電子信箱</span><input id="email" name="email" type="email" autocomplete="email" placeholder="name@company.com" aria-describedby="emailError" /><small class="field-error" id="emailError"></small></label>
        </div>
        <div class="application-grid">
          <label class="field" for="company"><span>公司 / 團隊</span><input id="company" name="company" type="text" autocomplete="organization" placeholder="公司或團隊名稱（選填）" /><small class="field-error"></small></label>
          <label class="field" for="phone"><span>聯絡電話</span><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="請輸入可聯絡的電話" aria-describedby="phoneError" required /><small class="field-error" id="phoneError"></small></label>
        </div>
        <label class="field" for="interest"><span>預計使用情境</span><select id="interest" name="useCase"><option value="OPC導入">OPC 導入與三帳代營運</option><option value="算力計費">算力計費與預算規劃</option><option value="私域轉化">獨立站與私域轉化閉環</option><option value="企業多套">企業多套 OPC 批量部署</option></select></label>
        <label class="consent" for="consent"><input id="consent" name="consent" type="checkbox" required /><span>我同意提交以上資料供管理員審核帳號註冊資格。</span></label>
        <button class="submit-button" type="submit"><span>提交註冊申請</span><span aria-hidden="true">→</span></button>
        <p class="form-note">提交後需等待管理員審核，不會立即登入。審核通過後請返回登入頁使用本次設定的帳號密碼。</p>
        <p class="form-status" id="formStatus" role="status" aria-live="polite"></p>
      </form>
      <button class="auth-guest-link auth-switch-button" type="button" data-open-login>已有帳號？返回登入</button>
    </section>`;
}

if (authDialog && !authDialog.querySelector("[data-auth-view='register']")) {
  authDialog.insertAdjacentHTML("beforeend", registrationPanelMarkup());
}

const applicationForm = document.querySelector("#accountRegistrationForm");
const applicationStatus = document.querySelector("#formStatus");
const loginForm = document.querySelector("#homeLoginForm");
const loginStatus = document.querySelector("#loginStatus");
const loginPassword = document.querySelector("#loginPassword");
const loginPasswordToggle = document.querySelector("[data-login-password-toggle]");
const loginRemember = loginForm?.elements?.remember_me || null;
const loginTakeover = document.querySelector("[data-login-takeover]");
const registerView = authDialog?.querySelector("[data-auth-view='register']");
const loginViewElements = authDialog
  ? [...authDialog.children].filter((element) => !element.matches(".auth-close, [data-auth-view='register']"))
  : [];
let loginReturnFocus = null;

function ensureLoginMfaField() {
  if (!loginForm) return null;
  const existing = loginForm.querySelector("[data-login-mfa]");
  if (existing) return existing;
  const field = document.createElement("label");
  field.className = "field auth-mfa-field";
  field.dataset.loginMfa = "";
  field.hidden = true;
  field.innerHTML = '<span>动态验证码</span><input name="mfa_code" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" maxlength="32" placeholder="管理员已启用 MFA 时填写" />';
  const rememberField = loginForm.querySelector("[data-login-remember]");
  if (rememberField) rememberField.before(field);
  else loginForm.append(field);
  return field;
}

const loginMfaField = ensureLoginMfaField();

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

function markPublicStaticUi(root = document.body, { dynamic = false } = {}) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    if (root.nodeValue?.trim() && !root.parentElement?.closest(PUBLIC_I18N_SKIP_SELECTOR)) {
      markPublicUiElement(root.parentElement, { dynamic });
    }
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim() || node.parentElement?.closest(PUBLIC_I18N_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) markPublicUiElement(walker.currentNode.parentElement, { dynamic });
  const attributeNodes = [];
  if (root.nodeType === Node.ELEMENT_NODE && root.matches("[title], [aria-label], [placeholder], [data-mobile-label]")) {
    attributeNodes.push(root);
  }
  root.querySelectorAll?.("[title], [aria-label], [placeholder], [data-mobile-label]")
    .forEach((node) => attributeNodes.push(node));
  attributeNodes.forEach((node) => markPublicUiElement(node, { dynamic }));
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
      mutation.addedNodes.forEach((node) => {
        markPublicStaticUi(node, { dynamic: true });
        translatePublicLanguage(node, language);
      });
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

function setAuthView(view) {
  const registering = view === "register";
  loginViewElements.forEach((element) => {
    element.hidden = registering;
  });
  if (registerView) registerView.hidden = !registering;
  authDialog?.classList.toggle("is-registering", registering);
  authDialog?.setAttribute("aria-labelledby", registering ? "registerTitle" : "loginTitle");
  if (loginStatus) loginStatus.textContent = "";
  if (applicationStatus) applicationStatus.textContent = "";
  if (loginTakeover) loginTakeover.hidden = true;
}

function openLogin(event) {
  if (!loginModal) return;
  if (!loginModal.classList.contains("is-open")) {
    loginReturnFocus = event?.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  setAuthView("login");
  loginModal.classList.add("is-open");
  loginModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  window.setTimeout(() => document.querySelector("#loginUsername")?.focus(), 40);
}

function openRegister(event) {
  if (!loginModal || !registerView) return;
  event?.preventDefault?.();
  if (!loginModal.classList.contains("is-open")) {
    loginReturnFocus = event?.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  setAuthView("register");
  loginModal.classList.add("is-open");
  loginModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  window.setTimeout(() => applicationForm?.elements?.fullName?.focus(), 40);
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
  if (returnFocus?.isConnected) {
    const closedMobileMenu = returnFocus.closest("[data-site-mobile-menu]:not([open])");
    const focusTarget = closedMobileMenu?.querySelector("[data-site-menu-toggle]")
      || (returnFocus.getClientRects().length ? returnFocus : null);
    focusTarget?.focus();
  }
}

function openRequestedLogin() {
  if (!loginModal) return;
  const currentUrl = new URL(window.location.href);
  const loginRequested = currentUrl.searchParams.get("login") === "1";
  const registerRequested = currentUrl.searchParams.get("register") === "1";
  if (!loginRequested && !registerRequested) return;
  if (loginRequested) {
    const fallback = String(document.body.dataset.loginRedirect || "/console.html");
    document.body.dataset.loginRedirect = safeLoginReturnUrl(
      currentUrl.searchParams.get("return_url"),
      fallback,
    );
  }
  currentUrl.searchParams.delete("login");
  currentUrl.searchParams.delete("register");
  currentUrl.searchParams.delete("return_url");
  window.history.replaceState({}, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
  if (registerRequested) openRegister();
  else openLogin();
}

document.addEventListener("click", (event) => {
  const registerTrigger = event.target instanceof Element
    ? event.target.closest("[data-open-register]")
    : null;
  if (registerTrigger) {
    event.preventDefault();
    openRegister({ currentTarget: registerTrigger });
    return;
  }
  const loginTrigger = event.target instanceof Element
    ? event.target.closest("[data-open-login]")
    : null;
  if (loginTrigger) openLogin({ currentTarget: loginTrigger });
});
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
    applicationStatus.textContent = result.message || "註冊申請已提交，請等待管理員審核。";
    applicationForm.reset();
  } catch (error) {
    applicationStatus.textContent = error.detail || "註冊申請提交失敗，請稍後再試。";
  } finally {
    submit.disabled = false;
  }
});

function safeLoginReturnUrl(value, fallback = "/console.html") {
  const candidate = String(value || "").trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\") || /[\u0000-\u001f]/.test(candidate)) {
    return fallback;
  }
  try {
    const target = new URL(candidate, window.location.origin);
    if (target.origin !== window.location.origin) return fallback;
    const adminParameters = ["admin_console", "admin_workspace_user_id", "manage_user_id", "return_manage_user_id"];
    if (target.pathname.startsWith("/admin") || target.pathname === "/api/admin" || target.pathname.startsWith("/api/admin/") || adminParameters.some((key) => target.searchParams.has(key))) {
      return fallback;
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return fallback;
  }
}

async function submitUserLogin(forceTakeover = false) {
  if (!loginForm || !loginStatus) return;
  loginStatus.textContent = "";
  const submit = loginForm.querySelector("button[type='submit']");
  submit.disabled = true;
  if (loginTakeover) loginTakeover.disabled = true;
  try {
    const result = await api("/api/auth/portal-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: loginForm.username.value.trim(),
        password: loginForm.password.value,
        remember_me: Boolean(loginForm.remember_me?.checked),
        force_takeover: Boolean(forceTakeover),
        mfa_code: String(loginForm.mfa_code?.value || "").trim(),
      }),
    });
    const isAdmin = result?.is_admin === true;
    if (!isAdmin) {
      try {
        sessionStorage.removeItem("vecto-admin-console-context");
        sessionStorage.removeItem("vecto-admin-workspace-user-id");
      } catch {}
    }
    const pageRedirect = String(document.body.dataset.loginRedirect || "/console.html");
    const safeRedirect = isAdmin ? "/admin" : safeLoginReturnUrl(pageRedirect);
    const passwordTarget = isAdmin
      ? `/change-password.html?admin_console=1&return_url=${encodeURIComponent(safeRedirect)}`
      : `/change-password.html?return_url=${encodeURIComponent(safeRedirect)}`;
    window.location.assign(result?.must_change_password ? passwordTarget : safeRedirect);
  } catch (error) {
    const detail = apiErrorDetail(error);
    loginStatus.textContent = detail.message || "登入失敗，請檢查帳號與密碼。";
    if (loginMfaField && detail.code === "mfa_code_invalid") {
      loginMfaField.hidden = false;
      loginForm.mfa_code?.focus();
    }
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

openRequestedLogin();

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

function initHomeExperience() {
  if (!document.body.classList.contains("home-canvas")) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const revealItems = [...document.querySelectorAll("[data-home-reveal]")];
  if (reducedMotion || !("IntersectionObserver" in window)) {
    revealItems.forEach((item) => item.classList.add("is-visible"));
  } else {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -5%" });
    revealItems.forEach((item) => revealObserver.observe(item));
  }

  const hero = document.querySelector("[data-home-hero]");
  const heroViewport = hero?.querySelector("[data-home-hero-viewport]");
  const heroTrack = hero?.querySelector(".home-hero-track");
  const heroScenes = [...(heroTrack?.querySelectorAll("[data-home-hero-scene]") || [])];
  const heroTriggers = [...(hero?.querySelectorAll("[data-home-hero-trigger]") || [])];
  const heroPrev = hero?.querySelector("[data-home-hero-prev]");
  const heroNext = hero?.querySelector("[data-home-hero-next]");
  const heroStatus = hero?.querySelector("[data-home-hero-status]");
  if (heroTrack && heroViewport && heroScenes.length > 1 && heroScenes.length === heroTriggers.length) {
    const cloneCount = Math.min(3, heroScenes.length);
    const createLoopClone = (scene) => {
      const clone = scene.cloneNode(true);
      clone.classList.remove("is-active");
      clone.dataset.homeHeroClone = "true";
      clone.setAttribute("aria-hidden", "true");
      clone.inert = true;
      clone.querySelectorAll("[id]").forEach((item) => item.removeAttribute("id"));
      clone.querySelectorAll("a, button, input, select, textarea, video").forEach((item) => item.setAttribute("tabindex", "-1"));
      return clone;
    };
    const leadingClones = document.createDocumentFragment();
    heroScenes.slice(-cloneCount).forEach((scene) => leadingClones.append(createLoopClone(scene)));
    heroTrack.insertBefore(leadingClones, heroTrack.firstChild);
    const trailingClones = document.createDocumentFragment();
    heroScenes.slice(0, cloneCount).forEach((scene) => trailingClones.append(createLoopClone(scene)));
    heroTrack.append(trailingClones);
    const physicalScenes = [...heroTrack.querySelectorAll("[data-home-hero-scene]")];
    let activeHeroScene = 0;
    let activePhysicalScene = heroScenes[0];
    let heroInteractionPaused = false;
    let heroInView = true;
    let heroScrollTimer = 0;
    let heroLoopTimer = 0;
    let heroLoopFallbackTimer = 0;
    let heroAdvanceTimer = 0;
    let heroLoopJumping = false;
    const logicalIndexOf = (scene) => Number.parseInt(scene.dataset.homeHeroIndex || "0", 10);
    const nearestPhysicalScene = () => physicalScenes.reduce((nearest, scene) => (
      Math.abs(scene.offsetLeft - heroViewport.scrollLeft) < Math.abs(nearest.offsetLeft - heroViewport.scrollLeft) ? scene : nearest
    ), physicalScenes[0]);
    const scheduleHeroAdvance = () => {
      window.clearTimeout(heroAdvanceTimer);
      if (reducedMotion || heroInteractionPaused || !heroInView) return;
      heroAdvanceTimer = window.setTimeout(() => {
        if (document.hidden) {
          scheduleHeroAdvance();
          return;
        }
        stepHero(1, false);
        scheduleHeroAdvance();
      }, 6400);
    };
    const updateHeroState = (physicalScene) => {
      activePhysicalScene = physicalScene;
      activeHeroScene = logicalIndexOf(physicalScene);
      physicalScenes.forEach((scene) => {
        const isClone = scene.dataset.homeHeroClone === "true";
        const isActive = scene === activePhysicalScene;
        scene.classList.toggle("is-active", isActive);
        scene.setAttribute("aria-hidden", String(isClone || !isActive));
        scene.inert = isClone || !isActive;
        const video = scene.querySelector("[data-home-hero-video]");
        if (!video) return;
        const source = video.querySelector("source[data-src]");
        if (isActive && !isClone && source && !reducedMotion) {
          source.src = source.dataset.src;
          source.removeAttribute("data-src");
          video.load();
        }
        if (isActive && !isClone && heroInView && !document.hidden && !reducedMotion) video.play().catch(() => {});
        else video.pause();
      });
      heroTriggers.forEach((trigger, triggerIndex) => {
        const isActive = triggerIndex === activeHeroScene;
        trigger.classList.toggle("is-active", isActive);
        trigger.setAttribute("aria-pressed", String(isActive));
      });
    };
    const jumpToOriginal = (physicalScene) => {
      const original = heroScenes[logicalIndexOf(physicalScene)];
      heroLoopJumping = true;
      heroViewport.style.scrollBehavior = "auto";
      heroViewport.style.scrollSnapType = "none";
      heroViewport.scrollLeft = original.offsetLeft;
      updateHeroState(original);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        heroViewport.style.removeProperty("scroll-behavior");
        heroViewport.style.removeProperty("scroll-snap-type");
        heroLoopJumping = false;
      }));
    };
    const settleLoopClone = (physicalScene) => {
      window.clearTimeout(heroLoopTimer);
      if (physicalScene.dataset.homeHeroClone !== "true") return;
      heroLoopTimer = window.setTimeout(() => {
        if (activePhysicalScene === physicalScene) jumpToOriginal(physicalScene);
      }, reducedMotion ? 0 : 180);
    };
    const announceHeroScene = (index) => {
      if (heroStatus) heroStatus.textContent = heroTriggers[index]?.getAttribute("aria-label") || "";
    };
    const showHeroScene = (index, behavior = reducedMotion ? "auto" : "smooth", resetTimer = true) => {
      window.clearTimeout(heroLoopTimer);
      window.clearTimeout(heroLoopFallbackTimer);
      const nextIndex = (index + heroScenes.length) % heroScenes.length;
      const target = heroScenes[nextIndex];
      updateHeroState(target);
      heroViewport.scrollTo({ left: target.offsetLeft, behavior });
      if (resetTimer) announceHeroScene(nextIndex);
      if (resetTimer) scheduleHeroAdvance();
    };
    const stepHero = (direction, resetTimer = true) => {
      window.clearTimeout(heroLoopTimer);
      window.clearTimeout(heroLoopFallbackTimer);
      const physicalIndex = physicalScenes.indexOf(activePhysicalScene);
      const target = physicalScenes[Math.max(0, Math.min(physicalScenes.length - 1, physicalIndex + direction))];
      updateHeroState(target);
      heroViewport.scrollTo({ left: target.offsetLeft, behavior: reducedMotion ? "auto" : "smooth" });
      if (resetTimer) announceHeroScene(logicalIndexOf(target));
      if (target.dataset.homeHeroClone === "true") {
        heroLoopFallbackTimer = window.setTimeout(() => {
          if (activePhysicalScene !== target) return;
          jumpToOriginal(target);
        }, reducedMotion ? 0 : 900);
      }
      if (resetTimer) scheduleHeroAdvance();
    };
    const syncHeroFromScroll = () => {
      window.clearTimeout(heroScrollTimer);
      heroScrollTimer = window.setTimeout(() => {
        if (heroLoopJumping) return;
        const nearest = nearestPhysicalScene();
        updateHeroState(nearest);
        settleLoopClone(nearest);
        scheduleHeroAdvance();
      }, 110);
    };
    heroTriggers.forEach((trigger, index) => trigger.addEventListener("click", () => showHeroScene(index)));
    heroPrev?.addEventListener("click", () => stepHero(-1));
    heroNext?.addEventListener("click", () => stepHero(1));
    heroViewport.addEventListener("scroll", syncHeroFromScroll, { passive: true });
    updateHeroState(heroScenes[0]);
    window.requestAnimationFrame(() => jumpToOriginal(heroScenes[0]));
    if (!reducedMotion) {
      const pauseHero = () => { heroInteractionPaused = true; window.clearTimeout(heroAdvanceTimer); };
      const resumeHero = () => { heroInteractionPaused = false; scheduleHeroAdvance(); };
      hero.addEventListener("pointerenter", pauseHero, { passive: true });
      hero.addEventListener("pointerleave", resumeHero, { passive: true });
      hero.addEventListener("touchstart", pauseHero, { passive: true });
      hero.addEventListener("touchend", resumeHero, { passive: true });
      hero.addEventListener("focusin", pauseHero);
      hero.addEventListener("focusout", (event) => {
        if (!hero.contains(event.relatedTarget)) resumeHero();
      });
      if ("IntersectionObserver" in window) {
        const heroObserver = new IntersectionObserver(([entry]) => {
          heroInView = entry.isIntersecting;
          updateHeroState(activePhysicalScene);
          if (heroInView) scheduleHeroAdvance();
          else window.clearTimeout(heroAdvanceTimer);
        }, { threshold: 0.18 });
        heroObserver.observe(hero);
      }
      document.addEventListener("visibilitychange", () => {
        updateHeroState(activePhysicalScene);
        if (!document.hidden) scheduleHeroAdvance();
      });
      scheduleHeroAdvance();
    }
  }

  const flowBoard = document.querySelector("[data-home-flow]");
  if (flowBoard) {
    const flowSteps = [...flowBoard.querySelectorAll("li")];
    const runFlow = () => {
      flowBoard.classList.add("is-running");
      flowSteps.forEach((step, index) => {
        window.setTimeout(() => step.classList.add("is-active"), 180 + index * 220);
      });
    };
    if (reducedMotion || !("IntersectionObserver" in window)) {
      runFlow();
    } else {
      const flowObserver = new IntersectionObserver((entries, observer) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        runFlow();
        observer.disconnect();
      }, { threshold: 0.28 });
      flowObserver.observe(flowBoard);
    }
  }

  const rail = document.querySelector("[data-home-rail]");
  if (!reducedMotion && rail) {
    let railPaused = false;
    let railCycleWidth = 0;
    let railResetTimer = 0;
    const railCards = Array.from(rail.children);
    if (rail.scrollWidth > rail.clientWidth && railCards.length) {
      railCards.forEach((card) => {
        const clone = card.cloneNode(true);
        clone.setAttribute("aria-hidden", "true");
        clone.setAttribute("data-home-rail-clone", "");
        clone.inert = true;
        clone.querySelectorAll("a, button, input, select, textarea, [tabindex]").forEach((element) => element.setAttribute("tabindex", "-1"));
        rail.appendChild(clone);
      });
    }
    const updateRailCycle = () => {
      const firstClone = rail.querySelector("[data-home-rail-clone]");
      railCycleWidth = firstClone && railCards[0] ? firstClone.offsetLeft - railCards[0].offsetLeft : 0;
    };
    const normalizeRail = () => {
      if (!railCycleWidth || rail.scrollLeft < railCycleWidth) return;
      rail.scrollTo({ left: rail.scrollLeft - railCycleWidth, behavior: "auto" });
    };
    updateRailCycle();
    const pauseRail = () => { railPaused = true; };
    const resumeRail = () => { railPaused = false; };
    ["pointerenter", "focusin", "touchstart"].forEach((eventName) => rail.addEventListener(eventName, pauseRail, { passive: true }));
    ["pointerleave", "focusout", "touchend"].forEach((eventName) => rail.addEventListener(eventName, resumeRail, { passive: true }));
    rail.addEventListener("scroll", () => {
      window.clearTimeout(railResetTimer);
      railResetTimer = window.setTimeout(normalizeRail, 180);
    }, { passive: true });
    window.addEventListener("resize", updateRailCycle, { passive: true });
    window.setInterval(() => {
      if (railPaused || document.hidden || !railCycleWidth) return;
      rail.scrollTo({ left: rail.scrollLeft + Math.min(430, rail.clientWidth * 0.72), behavior: "smooth" });
      window.clearTimeout(railResetTimer);
      railResetTimer = window.setTimeout(normalizeRail, 900);
    }, 5200);
  }
}

window.addEventListener("scroll", setHeaderState, { passive: true });
window.addEventListener("vecto:language-change", (event) => applyPublicLanguage(event.detail?.language));
markPublicStaticUi();
applyPublicLanguage(window.VectoSiteNavigation?.currentLanguage() || "zh-Hant");
startPublicLanguageObserver();
loadLoginPolicy();
setHeaderState();
initHomeExperience();
