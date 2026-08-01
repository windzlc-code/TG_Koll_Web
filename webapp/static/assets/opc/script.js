const header = document.querySelector("[data-header]");
const loginModal = document.querySelector("#loginModal");
const authDialog = loginModal?.querySelector(".auth-dialog");
const GOOGLE_AUTH_FEEDBACK_STORAGE_KEY = "vecto-google-auth-feedback-pending";
const LOGIN_DEVICE_STORAGE_KEY = "vecto-login-device-id";

function loginDeviceId() {
  try {
    let value = String(localStorage.getItem(LOGIN_DEVICE_STORAGE_KEY) || "").trim();
    if (!value) {
      value = typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
      localStorage.setItem(LOGIN_DEVICE_STORAGE_KEY, value);
    }
    return value.slice(0, 128);
  } catch {
    return `web-session-${Date.now().toString(36)}`;
  }
}

function registrationPanelMarkup() {
  return `
    <section class="auth-register-view" data-auth-view="register" hidden>
      <p class="form-kicker">建立 Vecto 帳號</p>
      <h2 id="registerTitle">註冊 Vecto 帳號</h2>
      <p class="auth-copy" data-register-copy>設定登入資料後，再驗證電子信箱即可建立帳號。</p>
      <button class="auth-close auth-registration-page-back" type="button" data-register-back hidden aria-label="返回上一步" title="返回上一步">
        <svg class="auth-registration-back-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>
      </button>
      <form class="lead-form auth-registration-form" id="accountRegistrationForm" novalidate>
        <div class="auth-registration-panel">
          <section class="auth-registration-page" data-register-page="details">
            <div class="application-grid auth-registration-profile">
              <label class="field auth-placeholder-field" for="registerFullName"><span class="field-label">姓名</span><input id="registerFullName" name="full_name" autocomplete="name" minlength="2" maxlength="80" placeholder="請輸入姓名" aria-describedby="registerFullNameError" required /><small class="field-error" id="registerFullNameError"></small></label>
              <label class="field auth-placeholder-field" for="registerUsername"><span class="field-label">用户名</span><input id="registerUsername" name="username" autocomplete="username" maxlength="32" placeholder="3-32 位英文、數字或 ._-" aria-describedby="registerUsernameError" required /><small class="field-error" id="registerUsernameError"></small></label>
              <label class="field auth-placeholder-field" for="registerPassword"><span class="field-label">登入密碼</span><span class="auth-password-field"><input id="registerPassword" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="256" placeholder="至少 8 位" aria-describedby="registerPasswordError" required /><button class="auth-password-toggle" type="button" data-register-password-toggle data-target="registerPassword" aria-label="顯示登入密碼" title="顯示登入密碼" aria-controls="registerPassword" aria-pressed="false"><svg class="auth-eye-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="3"></circle><path class="auth-eye-slash" d="M4 20L20 4"></path></svg></button></span><small class="field-error" id="registerPasswordError"></small></label>
              <label class="field auth-placeholder-field" for="registerPasswordConfirmation"><span class="field-label">再次確認密碼</span><span class="auth-password-field"><input id="registerPasswordConfirmation" name="password_confirmation" type="password" autocomplete="new-password" minlength="8" maxlength="256" placeholder="請再次輸入密碼" aria-describedby="registerPasswordConfirmationError" required /><button class="auth-password-toggle" type="button" data-register-password-toggle data-target="registerPasswordConfirmation" aria-label="顯示確認密碼" title="顯示確認密碼" aria-controls="registerPasswordConfirmation" aria-pressed="false"><svg class="auth-eye-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="3"></circle><path class="auth-eye-slash" d="M4 20L20 4"></path></svg></button></span><small class="field-error" id="registerPasswordConfirmationError"></small></label>
              <label class="field auth-placeholder-field" for="registerCompany"><span class="field-label">公司 / 團隊（選填）</span><input id="registerCompany" name="company" autocomplete="organization" maxlength="120" placeholder="請輸入公司或團隊名稱" aria-describedby="registerCompanyError" /><small class="field-error" id="registerCompanyError"></small></label>
              <label class="field auth-placeholder-field" for="registerUseCase"><span class="field-label">預計使用情境</span><select id="registerUseCase" name="use_case" aria-describedby="registerUseCaseError" required><option value="">請選擇預計使用情境</option><option value="OPC導入">OPC 導入與三帳代營運</option><option value="算力計費">算力計費與預算規劃</option><option value="私域轉化">獨立站與私域轉化閉環</option><option value="企業多套">企業多套 OPC 批量部署</option></select><small class="field-error" id="registerUseCaseError"></small></label>
            </div>
            <button class="submit-button auth-primary auth-registration-next" type="button" data-register-next><span>下一步</span><span aria-hidden="true">→</span></button>
          </section>
          <section class="auth-registration-page" data-register-page="email" hidden>
            <div class="auth-email-action">
              <label class="field auth-placeholder-field" for="registerEmail"><span class="field-label">電子信箱</span><input id="registerEmail" name="email" type="email" autocomplete="email" maxlength="254" placeholder="name@example.com" aria-describedby="registerEmailError" required /><small class="field-error" id="registerEmailError"></small></label>
              <button class="auth-verification-button" type="button" data-register-verification data-state="idle">發送驗證碼</button>
            </div>
            <p class="auth-verification-status" id="registerVerificationStatus" data-state="info" role="status" aria-live="polite">輸入電子信箱後即可發送驗證碼。</p>
            <label class="field auth-placeholder-field auth-verification-code" for="registerVerificationCode"><span class="field-label">信箱驗證碼</span><input id="registerVerificationCode" name="verification_code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="請輸入 6 位數字驗證碼" aria-describedby="registerVerificationCodeError" required /><small class="field-error" id="registerVerificationCodeError"></small></label>
            <label class="consent auth-registration-consent" for="registerConsent"><input id="registerConsent" name="consent" type="checkbox" required /><span>我已閱讀並同意《用戶服務協議》和《隱私政策》，並同意平台為提供帳號註冊、身分驗證及帳戶管理服務而處理必要的個人資訊。</span></label>
            <button class="submit-button" type="submit"><span>驗證並建立帳號</span><span aria-hidden="true">→</span></button>
          </section>
        </div>
        <p class="form-status auth-form-status" id="formStatus" role="status" aria-live="polite"></p>
      </form>
      <button class="auth-guest-link auth-switch-button" type="button" data-open-login>已有帳號？返回登入</button>
    </section>`;
}

function googleSetupPanelMarkup() {
  return `
    <section class="auth-google-setup-view" data-auth-view="google-setup" hidden>
      <p class="form-kicker">Google 帳號設定</p>
      <h2 id="googleSetupTitle">建立唯一用户名</h2>
      <p class="auth-copy">Google 信箱已完成驗證。設定一個不重複的用户名，即可完成登入。</p>
      <form class="lead-form auth-google-setup-form" id="googleSetupForm" novalidate>
        <label class="field" for="googleSetupUsername"><span>用户名</span><input id="googleSetupUsername" name="username" autocomplete="username" placeholder="3-32 位英文、數字或 ._-" aria-describedby="googleSetupUsernameError" required /><small class="field-error" id="googleSetupUsernameError"></small></label>
        <button class="submit-button" type="submit"><span>完成帳號設定</span><span aria-hidden="true">→</span></button>
        <p class="form-status auth-form-status" id="googleSetupStatus" role="status" aria-live="polite"></p>
      </form>
    </section>`;
}

if (authDialog && !authDialog.querySelector("[data-auth-view='register']")) {
  authDialog.insertAdjacentHTML("beforeend", registrationPanelMarkup());
}
if (authDialog && !authDialog.querySelector("[data-auth-view='google-setup']")) {
  authDialog.insertAdjacentHTML("beforeend", googleSetupPanelMarkup());
}

const applicationForm = document.querySelector("#accountRegistrationForm");
const applicationStatus = document.querySelector("#formStatus");
const registerVerificationStatus = document.querySelector("#registerVerificationStatus");
const registerVerificationButton = applicationForm?.querySelector("[data-register-verification]");
const registerPages = [...(applicationForm?.querySelectorAll("[data-register-page]") || [])];
const registerNextButton = applicationForm?.querySelector("[data-register-next]");
const registerBackButton = authDialog?.querySelector("[data-register-back]");
const registerTitle = authDialog?.querySelector("#registerTitle");
const registerCopy = authDialog?.querySelector("[data-register-copy]");
const registerPasswordToggles = [...(applicationForm?.querySelectorAll("[data-register-password-toggle]") || [])];
const loginForm = document.querySelector("#homeLoginForm");
const loginStatus = document.querySelector("#loginStatus");
const loginPassword = document.querySelector("#loginPassword");
const loginPasswordToggle = document.querySelector("[data-login-password-toggle]");
const loginRemember = loginForm?.elements?.remember_me || null;
const loginTakeover = document.querySelector("[data-login-takeover]");
const registerView = authDialog?.querySelector("[data-auth-view='register']");
const googleSetupView = authDialog?.querySelector("[data-auth-view='google-setup']");
const googleSetupForm = document.querySelector("#googleSetupForm");
const googleSetupStatus = document.querySelector("#googleSetupStatus");
const loginViewElements = authDialog
  ? [...authDialog.children].filter((element) => !element.matches(".auth-close, [data-auth-view='register'], [data-auth-view='google-setup']"))
  : [];
let loginReturnFocus = null;
let registerChallengeId = "";
let registerChallengeEmail = "";
let registerResendTimer = 0;
let registerPage = "details";
let registrationPolicyEnabled = null;
let googleLoginButton = null;

function ensureLoginAuthEnhancements() {
  if (!loginForm) return;
  const identifierInput = loginForm.elements?.username;
  const identifierLabel = identifierInput?.closest(".field")?.querySelector(":scope > span");
  if (identifierLabel) identifierLabel.textContent = "電子信箱或用户名";
  if (identifierInput) {
    identifierInput.placeholder = "name@example.com 或用户名";
  }
  if (loginForm.querySelector("[data-google-login]")) {
    googleLoginButton = loginForm.querySelector("[data-google-login]");
    return;
  }
  const divider = document.createElement("div");
  divider.className = "auth-provider-divider";
  divider.dataset.googleLoginContainer = "";
  const dividerLabel = document.createElement("span");
  dividerLabel.textContent = "或";
  divider.append(dividerLabel);

  googleLoginButton = document.createElement("button");
  googleLoginButton.className = "auth-google-button";
  googleLoginButton.type = "button";
  googleLoginButton.dataset.googleLogin = "";
  googleLoginButton.setAttribute("aria-label", "使用 Google 帳號登入");
  const icon = document.createElement("img");
  icon.className = "auth-google-mark";
  icon.src = "/assets/opc/google-g-gradient.svg";
  icon.alt = "";
  icon.width = 20;
  icon.height = 20;
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = "使用 Google 帳號登入";
  googleLoginButton.append(icon, label);

  const submitButton = loginForm.querySelector(".submit-button");
  if (submitButton) submitButton.after(divider, googleLoginButton);
  else loginForm.append(divider, googleLoginButton);
}

ensureLoginAuthEnhancements();

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
  [applicationStatus, registerVerificationStatus, loginStatus, loginPasswordToggle, ...document.querySelectorAll(".field-error")]
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
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    data = { detail: text || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    data.httpStatus = response.status;
    data.requestPath = path;
    throw data;
  }
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
      verification: detail.verification && typeof detail.verification === "object"
        ? detail.verification
        : null,
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

function setAuthStatus(element, message = "", state = "") {
  if (!element) return;
  element.textContent = String(message || "");
  if (state) element.dataset.state = state;
  else delete element.dataset.state;
}

function validRegistrationUsername(value) {
  return /^[A-Za-z0-9._-]{3,32}$/.test(String(value || "").trim());
}

function validateRegistrationEmail({ showFieldError = true } = {}) {
  const input = applicationForm?.elements?.email;
  if (!input) return false;
  const valid = Boolean(input.value.trim()) && input.validity.valid;
  if (showFieldError) {
    setFieldError(input, valid ? "" : "請輸入格式正確且可收信的電子信箱。");
  }
  return valid;
}

function validateRegistrationProfile({ focusInvalid = true } = {}) {
  if (!applicationForm) return false;
  const fullName = applicationForm.elements.full_name.value.trim();
  const company = applicationForm.elements.company.value.trim();
  const useCase = applicationForm.elements.use_case.value.trim();
  const password = applicationForm.elements.password.value;
  const passwordConfirmation = applicationForm.elements.password_confirmation.value;
  const checks = [
    [applicationForm.elements.full_name, fullName.length >= 2 && fullName.length <= 80, "姓名需要 2-80 個字元。"],
    [applicationForm.elements.username, validRegistrationUsername(applicationForm.elements.username.value), "用户名需要 3-32 位英文、數字或 ._-。"],
    [applicationForm.elements.password, password.length >= 8 && password.length <= 256, "密碼需要 8-256 位。"],
    [applicationForm.elements.password_confirmation, password === passwordConfirmation && Boolean(passwordConfirmation), "兩次輸入的密碼不一致。"],
    [applicationForm.elements.company, company.length <= 120, "公司或團隊名稱不能超過 120 個字元。"],
    [applicationForm.elements.use_case, Boolean(useCase), "請選擇預計使用情境。"],
  ];
  let firstInvalid = null;
  checks.forEach(([input, passed, message]) => {
    setFieldError(input, passed ? "" : message);
    if (!passed && !firstInvalid) firstInvalid = input;
  });
  if (firstInvalid && focusInvalid) firstInvalid.focus();
  if (firstInvalid) {
    setAuthStatus(applicationStatus, "請先完成帳號資料，再進入信箱驗證。", "error");
    return false;
  }
  setAuthStatus(applicationStatus);
  return true;
}

function setRegistrationPage(page, { focus = true } = {}) {
  const nextPage = page === "email" ? "email" : "details";
  registerPage = nextPage;
  registerPages.forEach((panel) => {
    panel.hidden = panel.dataset.registerPage !== nextPage;
  });
  if (registerBackButton) {
    registerBackButton.hidden = nextPage !== "email";
  }
  if (registerTitle) {
    registerTitle.textContent = nextPage === "email" ? "驗證電子信箱" : "註冊 Vecto 帳號";
  }
  if (registerCopy) {
    registerCopy.textContent = nextPage === "email"
      ? "輸入可正常收信的電子信箱，取得驗證碼後即可完成註冊。"
      : "設定登入資料後，再驗證電子信箱即可建立帳號。";
  }
  if (nextPage === "email") {
    updateRegisterEmailMessage();
  }
  if (!focus) return;
  const target = nextPage === "details"
    ? applicationForm?.elements?.full_name
    : applicationForm?.elements?.email;
  window.setTimeout(() => target?.focus(), 40);
}

function openRegistrationEmailPage() {
  if (!validateRegistrationProfile()) return;
  setRegistrationPage("email");
}

function validateRegistrationVerification() {
  if (!applicationForm || !registerChallengeId) {
    setAuthStatus(applicationStatus, "請先發送並取得信箱驗證碼。", "error");
    return false;
  }
  const verificationCodeValid = /^\d{6}$/.test(applicationForm.elements.verification_code.value.trim());
  let valid = validateRegistrationEmail();
  setFieldError(
    applicationForm.elements.verification_code,
    verificationCodeValid ? "" : "請輸入 6 位數字驗證碼。",
  );
  if (!verificationCodeValid) valid = false;
  if (!applicationForm.elements.consent.checked) {
    applicationForm.elements.consent.closest(".consent")?.classList.add("is-invalid");
    setAuthStatus(applicationStatus, "請先同意提交資料以建立帳號。", "error");
    valid = false;
  } else {
    applicationForm.elements.consent.closest(".consent")?.classList.remove("is-invalid");
  }
  return valid;
}

function registrationErrorField(code) {
  if (!applicationForm) return null;
  const normalized = String(code || "").toLowerCase();
  if (["email_invalid", "invalid_email", "email_in_use", "email_already_registered", "unsupported_email_provider", "email_not_allowed"].includes(normalized)) {
    return applicationForm.elements.email;
  }
  if ([
    "verification_code_invalid",
    "code_invalid",
    "verification_code_expired",
    "challenge_expired",
    "challenge_invalid",
    "challenge_not_found",
    "challenge_mismatch",
    "challenge_not_sent",
    "challenge_consumed",
    "challenge_invalidated",
    "challenge_attempts_exceeded",
    "verification_attempts_exceeded",
  ].includes(normalized)) {
    return applicationForm.elements.verification_code;
  }
  if (["username_taken", "username_exists", "username_invalid", "invalid_username"].includes(normalized)) {
    return applicationForm.elements.username;
  }
  if (["full_name_invalid", "invalid_full_name"].includes(normalized)) {
    return applicationForm.elements.full_name;
  }
  if (["company_invalid", "invalid_company"].includes(normalized)) {
    return applicationForm.elements.company;
  }
  if (["use_case_invalid", "invalid_use_case"].includes(normalized)) {
    return applicationForm.elements.use_case;
  }
  if (["password_invalid", "weak_password"].includes(normalized)) {
    return applicationForm.elements.password;
  }
  return null;
}

function registrationStatusMessage(error, fallback) {
  const detail = apiErrorDetail(error);
  const code = detail.code.toLowerCase();
  const status = Number(error?.httpStatus || 0);
  if (status === 404 || /^not found$/i.test(detail.message)) {
    return "驗證碼服務暫時不可用，請重新整理頁面後再試。";
  }
  if (code === "resend_too_soon") {
    return "請等待倒數結束後再重新發送驗證碼。";
  }
  if (code === "email_rate_limited") {
    return "此信箱取得驗證碼的次數過多，請稍後再試。";
  }
  if (code === "ip_rate_limited") {
    return "目前網路取得驗證碼的次數過多，請稍後再試。";
  }
  if (status >= 500) {
    return "驗證碼目前無法寄出，請稍後再試。";
  }
  return detail.message || fallback;
}

function showRegistrationError(error, fallback, statusTarget = applicationStatus) {
  const detail = apiErrorDetail(error);
  const message = registrationStatusMessage(error, fallback);
  const target = registrationErrorField(detail.code);
  const verificationField = Boolean(target && ["email", "verification_code"].includes(target.name));
  const useStatusOnly = statusTarget === registerVerificationStatus && verificationField;
  if (target) {
    setRegistrationPage(verificationField ? "email" : "details", { focus: false });
    setFieldError(target, useStatusOnly ? "" : message);
    window.setTimeout(() => target.focus(), 40);
  }
  setAuthStatus(statusTarget, target && !useStatusOnly ? "" : message, "error");
}

function loginFocusableElements() {
  if (!loginModal) return [];
  return [...loginModal.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
    .filter((node) => !node.hidden && node.getClientRects().length > 0);
}

function setAuthView(view) {
  const registering = view === "register";
  const completingGoogle = view === "google-setup";
  loginViewElements.forEach((element) => {
    element.hidden = registering || completingGoogle;
  });
  if (registerView) registerView.hidden = !registering;
  if (googleSetupView) googleSetupView.hidden = !completingGoogle;
  authDialog?.classList.toggle("is-registering", registering);
  authDialog?.classList.toggle("is-google-setup", completingGoogle);
  authDialog?.setAttribute("aria-labelledby", completingGoogle ? "googleSetupTitle" : registering ? "registerTitle" : "loginTitle");
  setAuthStatus(loginStatus);
  setAuthStatus(applicationStatus);
  if (registering) updateRegisterEmailMessage();
  else setAuthStatus(registerVerificationStatus);
  setAuthStatus(googleSetupStatus);
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
  setRegistrationPage("details", { focus: false });
  loginModal.classList.add("is-open");
  loginModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  window.setTimeout(() => applicationForm?.elements?.full_name?.focus(), 40);
}

function openGoogleSetup() {
  if (!loginModal || !googleSetupView) return;
  setAuthView("google-setup");
  loginModal.classList.add("is-open");
  loginModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  window.setTimeout(() => googleSetupForm?.elements?.username?.focus(), 40);
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

function setupRegisterPasswordToggle(toggle) {
  const input = document.getElementById(toggle?.dataset?.target || "");
  if (!input) return;
  toggle.addEventListener("click", () => {
    const revealed = input.type === "password";
    input.type = revealed ? "text" : "password";
    toggle.classList.toggle("is-visible", revealed);
    toggle.setAttribute("aria-pressed", revealed ? "true" : "false");
    const label = revealed ? "隱藏密碼" : "顯示密碼";
    setPublicUiAttribute(toggle, "aria-label", label);
    setPublicUiAttribute(toggle, "title", label);
    input.focus({ preventScroll: true });
  });
}

registerPasswordToggles.forEach(setupRegisterPasswordToggle);

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
  const googleSetupRequested = currentUrl.searchParams.get("google_setup") === "1";
  const oauthError = String(currentUrl.searchParams.get("oauth_error") || "").trim().toLowerCase();
  if (!loginRequested && !registerRequested && !googleSetupRequested) return;
  if (loginRequested) {
    const fallback = String(document.body.dataset.loginRedirect || "/console.html");
    document.body.dataset.loginRedirect = safeLoginReturnUrl(
      currentUrl.searchParams.get("return_url"),
      fallback,
    );
  }
  if (googleSetupRequested) {
    try {
      window.sessionStorage.removeItem(GOOGLE_AUTH_FEEDBACK_STORAGE_KEY);
    } catch {}
    document.body.dataset.googleReturnUrl = safeLoginReturnUrl(
      currentUrl.searchParams.get("return_url"),
      "/",
    );
  }
  if (oauthError) {
    try {
      window.sessionStorage.removeItem(GOOGLE_AUTH_FEEDBACK_STORAGE_KEY);
    } catch {}
  }
  currentUrl.searchParams.delete("login");
  currentUrl.searchParams.delete("register");
  currentUrl.searchParams.delete("google_setup");
  currentUrl.searchParams.delete("oauth_error");
  currentUrl.searchParams.delete("return_url");
  window.history.replaceState({}, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
  if (googleSetupRequested) openGoogleSetup();
  else if (registerRequested) openRegister();
  else {
    openLogin();
    if (oauthError) {
      const oauthMessages = {
        provider_denied: "你已取消 Google 授权，请重试。",
        oauth_state_invalid: "Google 登录请求已过期，请重新开始登录。",
        google_verification_failed: "Google 身份验证失败，请重试。",
        google_login_disabled: "此账号的 Google 登录已被管理员停用。",
        google_login_unavailable: "Google 登录当前不可用，请稍后重试。",
        google_identity_conflict: "此 Google 账号已绑定其他用户。",
        account_unavailable: "账号当前不可登录，请联系管理员。",
      };
      setAuthStatus(
        loginStatus,
        oauthMessages[oauthError] || "Google 登录失败，请重试。",
        "error",
      );
    }
  }
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

function registrationEmailIsValid() {
  const input = applicationForm?.elements?.email;
  return Boolean(input?.value.trim()) && input.validity.valid;
}

function updateRegisterEmailMessage() {
  const input = applicationForm?.elements?.email;
  if (!input || !registerVerificationStatus) return;
  const email = input.value.trim();
  if (!email) {
    setAuthStatus(registerVerificationStatus, "輸入電子信箱後即可發送驗證碼。", "info");
    return;
  }
  if (!input.validity.valid) {
    setAuthStatus(registerVerificationStatus, "請輸入格式正確且可收信的電子信箱。", "error");
    return;
  }
  if (registerChallengeId && email.toLowerCase() === registerChallengeEmail) return;
  setAuthStatus(registerVerificationStatus, "電子信箱格式正確，可以發送驗證碼。", "info");
}

function updateRegisterVerificationAvailability() {
  if (!registerVerificationButton) return;
  const state = registerVerificationButton.dataset.state || "idle";
  const busy = state === "sending" || state === "countdown";
  const available = registrationPolicyEnabled !== false;
  const emailValid = registrationEmailIsValid();
  registerVerificationButton.dataset.registrationEnabled = String(available);
  registerVerificationButton.disabled = busy || !available || !emailValid;
}

function resetRegistrationChallenge({ keepEmail = true } = {}) {
  window.clearInterval(registerResendTimer);
  registerResendTimer = 0;
  registerChallengeId = "";
  registerChallengeEmail = "";
  if (!keepEmail && applicationForm?.elements?.email) applicationForm.elements.email.value = "";
  if (applicationForm?.elements?.verification_code) applicationForm.elements.verification_code.value = "";
  if (registerVerificationButton) {
    registerVerificationButton.dataset.state = "idle";
    registerVerificationButton.textContent = "發送驗證碼";
    registerVerificationButton.removeAttribute("aria-busy");
    updateRegisterVerificationAvailability();
  }
}

function startRegisterResendCountdown(seconds, expiresMinutes) {
  if (!registerVerificationButton) return;
  window.clearInterval(registerResendTimer);
  let remaining = Math.max(1, Math.round(Number(seconds) || 60));
  const render = () => {
    const registrationAvailable = registrationPolicyEnabled !== false;
    const expiry = Math.max(1, Math.round(Number(expiresMinutes) || 10));
    registerVerificationButton.disabled = remaining > 0 || !registrationAvailable;
    registerVerificationButton.dataset.state = remaining > 0 ? "countdown" : "ready";
    registerVerificationButton.textContent = remaining > 0 ? `${remaining} 秒後可重發` : "重新發送驗證碼";
    registerVerificationButton.removeAttribute("aria-busy");
    setAuthStatus(
      registerVerificationStatus,
      remaining > 0
        ? `驗證碼已寄出，${remaining} 秒後可重新發送；有效時間約 ${expiry} 分鐘。`
        : `驗證碼已寄出，可以重新發送；請在 ${expiry} 分鐘內完成驗證。`,
      remaining > 0 ? "success" : "info",
    );
  };
  render();
  registerResendTimer = window.setInterval(() => {
    remaining -= 1;
    render();
    if (remaining <= 0) {
      window.clearInterval(registerResendTimer);
      registerResendTimer = 0;
    }
  }, 1000);
}

async function sendRegistrationVerification() {
  if (!applicationForm || !registerVerificationButton) return;
  if (!validateRegistrationEmail({ showFieldError: false })) {
    setFieldError(applicationForm.elements.email, "");
    updateRegisterEmailMessage();
    applicationForm.elements.email.focus();
    return;
  }
  const email = applicationForm.elements.email.value.trim();
  const defaultText = registerVerificationButton.textContent;
  setAuthStatus(registerVerificationStatus, "正在發送驗證碼…", "info");
  registerVerificationButton.disabled = true;
  registerVerificationButton.dataset.state = "sending";
  registerVerificationButton.textContent = "發送中…";
  registerVerificationButton.setAttribute("aria-busy", "true");
  try {
    const result = await api("/api/auth/email-verification/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, purpose: "register" }),
    });
    const challengeId = String(result?.challenge_id || "").trim();
    if (!challengeId) {
      throw { detail: { code: "challenge_missing", message: "驗證服務未回傳有效憑證，請稍後再試。" } };
    }
    registerChallengeId = challengeId;
    registerChallengeEmail = email.toLowerCase();
    const expiresMinutes = Math.max(1, Math.round((Number(result?.expires_in) || 600) / 60));
    startRegisterResendCountdown(result?.resend_after, expiresMinutes);
    window.setTimeout(() => applicationForm.elements.verification_code?.focus(), 40);
  } catch (error) {
    registerVerificationButton.textContent = defaultText;
    registerVerificationButton.dataset.state = registerChallengeId ? "ready" : "idle";
    registerVerificationButton.removeAttribute("aria-busy");
    updateRegisterVerificationAvailability();
    showRegistrationError(error, "驗證碼發送失敗，請稍後再試。", registerVerificationStatus);
  }
}

registerVerificationButton?.addEventListener("click", sendRegistrationVerification);
registerNextButton?.addEventListener("click", openRegistrationEmailPage);
registerBackButton?.addEventListener("click", () => setRegistrationPage("details"));

applicationForm?.elements?.email?.addEventListener("input", () => {
  setFieldError(applicationForm.elements.email, "");
  updateRegisterVerificationAvailability();
  const email = applicationForm.elements.email.value.trim().toLowerCase();
  if (registerChallengeId && email !== registerChallengeEmail) {
    resetRegistrationChallenge();
    setAuthStatus(registerVerificationStatus, "信箱已變更，請重新發送驗證碼。", "info");
    return;
  }
  updateRegisterEmailMessage();
});
applicationForm?.elements?.email?.addEventListener("change", updateRegisterVerificationAvailability);

applicationForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthStatus(applicationStatus);
  if (registerPage !== "email") {
    openRegistrationEmailPage();
    return;
  }
  if (!validateRegistrationProfile({ focusInvalid: false })) {
    setRegistrationPage("details");
    return;
  }
  if (!validateRegistrationVerification()) return;
  const submit = applicationForm.querySelector("button[type='submit']");
  submit.disabled = true;
  try {
    await api("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: applicationForm.elements.email.value.trim(),
        challenge_id: registerChallengeId,
        verification_code: applicationForm.elements.verification_code.value.trim(),
        full_name: applicationForm.elements.full_name.value.trim(),
        username: applicationForm.elements.username.value.trim(),
        password: applicationForm.elements.password.value,
        company: applicationForm.elements.company.value.trim(),
        use_case: applicationForm.elements.use_case.value,
        consent: applicationForm.elements.consent.checked,
      }),
    });
    window.VectoSiteNavigation?.announceAuthSessionChange?.("registration");
    await window.VectoSiteNavigation?.refreshPublicSession?.();
    applicationForm.reset();
    resetRegistrationChallenge({ keepEmail: false });
    setRegistrationPage("details", { focus: false });
    closeLogin();
    await window.VectoSiteNavigation?.showAuthFeedback?.({
      kind: "success",
      title: "帳號建立成功，5 點算力已到帳",
      message: "歡迎加入 Vecto。贈送算力已放入你的帳戶，可用於 AI 推文與配圖等功能。接下來先建立第一個人設，我們會一步一步帶你完成設定。",
      actionText: "開始使用",
    });
  } catch (error) {
    showRegistrationError(error, "帳號建立失敗，請檢查資料後再試。");
  } finally {
    submit.disabled = false;
  }
});

googleLoginButton?.addEventListener("click", () => {
  const currentUrl = new URL(window.location.href);
  const returnUrl = safeLoginReturnUrl(
    `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
    "/",
  );
  try {
    window.sessionStorage.setItem(GOOGLE_AUTH_FEEDBACK_STORAGE_KEY, "1");
  } catch {}
  googleLoginButton.disabled = true;
  window.location.assign(`/api/auth/google/start?return_url=${encodeURIComponent(returnUrl)}`);
});

googleSetupForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthStatus(googleSetupStatus);
  const usernameInput = googleSetupForm.elements.username;
  if (!validRegistrationUsername(usernameInput.value)) {
    setFieldError(usernameInput, "用户名需為 3-32 位英文、數字或 ._-。");
    usernameInput.focus();
    return;
  }
  const submit = googleSetupForm.querySelector("button[type='submit']");
  submit.disabled = true;
  try {
    await api("/api/auth/google/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: usernameInput.value.trim() }),
    });
    window.VectoSiteNavigation?.announceAuthSessionChange?.("google-login");
    await window.VectoSiteNavigation?.refreshPublicSession?.();
    const returnUrl = safeLoginReturnUrl(document.body.dataset.googleReturnUrl, "/");
    googleSetupForm.reset();
    closeLogin();
    await window.VectoSiteNavigation?.showAuthFeedback?.({
      kind: "success",
      title: "Google 登入成功",
      message: "用户名已建立，歡迎回到 Vecto。",
      actionText: "開始使用",
    });
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (returnUrl !== currentUrl) window.location.assign(returnUrl);
  } catch (error) {
    const detail = apiErrorDetail(error);
    const message = detail.message || "無法完成 Google 帳號設定，請稍後再試。";
    if (["username_taken", "username_exists", "username_invalid", "invalid_username"].includes(detail.code.toLowerCase())) {
      setFieldError(usernameInput, message);
      usernameInput.focus();
    }
    setAuthStatus(googleSetupStatus, message, "error");
  } finally {
    submit.disabled = false;
  }
});

async function showLoginSecurityVerification(verification = {}, statusMessage = "", initialMethod = "") {
  const emailAvailable = verification?.email_available === true;
  const mfaAvailable = verification?.mfa_available === true || verification?.mfa_enabled === true;
  let method = initialMethod || (emailAvailable ? "email" : "mfa");
  if (method === "email" && !emailAvailable) method = "mfa";
  if (method === "mfa" && !mfaAvailable && emailAvailable) method = "email";
  return window.VectoSiteNavigation?.showAuthFeedback?.({
    kind: "success",
    title: "完成安全验证",
    message: emailAvailable
      ? "检测到新设备和新网络登录，请先验证账号邮箱。"
      : "邮箱验证暂不可用，请使用 MFA 完成验证。",
    actionText: false,
    dialogClass: "is-form",
    contentHtml: `<form class="site-auth-feedback-form" data-login-security-form>
      <div class="site-auth-feedback-email" data-login-security-email><span>验证码已发送至</span><strong></strong></div>
      <label><span data-login-security-label>邮箱验证码</span><input name="security_code" inputmode="numeric" autocomplete="one-time-code" maxlength="32" required></label>
      <p class="site-auth-feedback-form-status" data-login-security-status aria-live="polite"></p>
      <div class="site-auth-feedback-actions">
        <button type="button" class="site-auth-feedback-cancel" data-login-security-branch></button>
        <button type="submit" class="site-auth-feedback-confirm">验证并登录</button>
      </div>
    </form>`,
    onOpen(modal, close) {
      const form = modal.querySelector("[data-login-security-form]");
      const emailBlock = modal.querySelector("[data-login-security-email]");
      const emailValue = emailBlock?.querySelector("strong");
      const label = modal.querySelector("[data-login-security-label]");
      const input = form?.elements?.security_code;
      const status = modal.querySelector("[data-login-security-status]");
      const branch = modal.querySelector("[data-login-security-branch]");
      const renderMethod = () => {
        const usingEmail = method === "email";
        if (emailBlock) emailBlock.hidden = !usingEmail;
        if (emailValue) emailValue.textContent = String(verification?.masked_email || "账号邮箱");
        if (label) label.textContent = usingEmail ? "邮箱验证码" : "MFA 动态验证码或恢复码";
        if (input) {
          input.value = "";
          input.maxLength = usingEmail ? 6 : 32;
          input.inputMode = usingEmail ? "numeric" : "text";
          input.placeholder = usingEmail ? "请输入 6 位验证码" : "请输入 MFA 验证码";
        }
        if (branch) {
          branch.hidden = !(emailAvailable && mfaAvailable);
          branch.textContent = usingEmail ? "改用 MFA" : "返回邮箱验证";
        }
        if (status) {
          status.textContent = String(statusMessage || "");
          status.classList.toggle("is-error", Boolean(statusMessage));
        }
        input?.focus({ preventScroll: true });
      };
      branch?.addEventListener("click", () => {
        method = method === "email" ? "mfa" : "email";
        statusMessage = "";
        renderMethod();
      });
      form?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const code = String(input?.value || "").trim();
        if (!code) {
          if (status) {
            status.textContent = method === "email" ? "请输入邮箱验证码。" : "请输入 MFA 验证码。";
            status.classList.add("is-error");
          }
          input?.focus();
          return;
        }
        close();
        await submitUserLogin(true, { method, code, context: verification });
      });
      renderMethod();
    },
  });
}

async function submitUserLogin(forceTakeover = false, securityVerification = {}) {
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
        mfa_code: securityVerification.method === "mfa"
          ? String(securityVerification.code || "").trim()
          : String(loginForm.mfa_code?.value || "").trim(),
        device_id: loginDeviceId(),
        security_verification_method: String(securityVerification.method || ""),
        security_challenge_id: String(securityVerification.context?.challenge_id || ""),
        security_verification_code: securityVerification.method === "email"
          ? String(securityVerification.code || "")
          : "",
      }),
    });
    const isAdmin = result?.is_admin === true;
    if (!isAdmin) {
      try {
        sessionStorage.removeItem("vecto-admin-console-context");
        sessionStorage.removeItem("vecto-admin-workspace-user-id");
      } catch {}
    }
    window.VectoSiteNavigation?.announceAuthSessionChange?.("login");
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete("login");
    currentUrl.searchParams.delete("return_url");
    const safeRedirect = safeLoginReturnUrl(
      `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
      "/",
    );
    const passwordTarget = isAdmin
      ? `/change-password.html?admin_console=1&return_url=${encodeURIComponent(safeRedirect)}`
      : `/change-password.html?return_url=${encodeURIComponent(safeRedirect)}`;
    if (result?.must_change_password) {
      closeLogin();
      await window.VectoSiteNavigation?.showAuthFeedback?.({
        kind: "success",
        title: "登录验证成功",
        message: "为保护账号安全，请先设置新的登录密码。",
        actionText: "前往设置",
      });
      window.location.assign(passwordTarget);
      return;
    }
    if (isAdmin) window.VectoSiteNavigation?.markAdminConsoleContext?.();
    else window.VectoSiteNavigation?.clearAdminConsoleContext?.();
    await window.VectoSiteNavigation?.refreshPublicSession?.();
    closeLogin();
    const loginFeedback = window.VectoSiteNavigation?.authFeedbackCopyByTime?.("login") || {
      kind: "success",
      title: "登录成功，欢迎回来",
      message: "很高兴见到你，今天也一起把内容运营做得更顺畅。",
      actionText: "开始使用",
    };
    await window.VectoSiteNavigation?.showAuthFeedback?.(loginFeedback);
    window.history.replaceState({}, "", safeRedirect);
  } catch (error) {
    const detail = apiErrorDetail(error);
    loginStatus.textContent = detail.message || "登入失敗，請檢查帳號與密碼。";
    if (detail.code === "SECURITY_VERIFICATION_REQUIRED") {
      submit.disabled = false;
      if (loginTakeover) {
        loginTakeover.hidden = true;
        loginTakeover.disabled = false;
      }
      await showLoginSecurityVerification(detail.verification || {});
      return false;
    }
    if (securityVerification.context) {
      submit.disabled = false;
      if (loginTakeover) loginTakeover.disabled = false;
      await showLoginSecurityVerification(
        securityVerification.context,
        detail.message || "验证码无效，请重新输入。",
        securityVerification.method,
      );
      return false;
    }
    if (
      loginMfaField
      && detail.code === "mfa_code_invalid"
    ) {
      loginMfaField.hidden = false;
      loginForm.mfa_code?.focus();
    }
    const confirmationRequired = detail.code === "SESSION_CONFLICT";
    if (loginTakeover) {
      loginTakeover.hidden = !confirmationRequired;
      loginTakeover.textContent = "退出原设备并登录";
    }
    submit.disabled = false;
    if (loginTakeover) loginTakeover.disabled = false;
    await window.VectoSiteNavigation?.showAuthFeedback?.({
      kind: "error",
      title: "登录失败",
      message: detail.message || "请检查账号和密码后重试。",
      actionText: "返回继续填写",
    });
    return false;
  }
  return true;
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
  if (!loginForm) return;
  try {
    const policy = await api("/api/auth/policy");
    const enabled = policy.remember_login_enabled !== false;
    if (loginRemember) {
      loginRemember.disabled = !enabled;
      loginRemember.checked = enabled && policy.remember_login_default === true;
    }
    const rememberField = loginForm.querySelector("[data-login-remember]");
    if (rememberField) rememberField.hidden = !enabled;
    const googleEnabled = policy.google_login_enabled !== false;
    const googleContainer = loginForm.querySelector("[data-google-login-container]");
    if (googleLoginButton) {
      googleLoginButton.hidden = !googleEnabled;
      googleLoginButton.disabled = false;
    }
    if (googleContainer) googleContainer.hidden = !googleEnabled;

    const registrationEnabled = policy.email_registration_enabled !== false;
    registrationPolicyEnabled = registrationEnabled;
    document.querySelectorAll("[data-open-register]").forEach((trigger) => {
      trigger.hidden = !registrationEnabled;
      trigger.setAttribute("aria-disabled", registrationEnabled ? "false" : "true");
    });
    updateRegisterVerificationAvailability();
    if (!registrationEnabled && !registerView?.hidden) {
      setAuthStatus(applicationStatus, "信箱註冊目前暫停服務，請稍後再試。", "info");
    }
  } catch {
    registrationPolicyEnabled = null;
    updateRegisterVerificationAvailability();
    if (loginRemember) loginRemember.checked = false;
    const googleContainer = loginForm.querySelector("[data-google-login-container]");
    if (googleLoginButton) {
      googleLoginButton.hidden = false;
      googleLoginButton.disabled = false;
    }
    if (googleContainer) googleContainer.hidden = false;
  }
}

applicationForm?.querySelectorAll("input").forEach((input) => {
  input.addEventListener("input", () => setFieldError(input, ""));
});
applicationForm?.querySelectorAll("select").forEach((select) => {
  select.addEventListener("change", () => setFieldError(select, ""));
});
applicationForm?.elements?.consent?.addEventListener("change", () => {
  applicationForm.elements.consent.closest(".consent")?.classList.remove("is-invalid");
});
googleSetupForm?.elements?.username?.addEventListener("input", () => {
  setFieldError(googleSetupForm.elements.username, "");
  setAuthStatus(googleSetupStatus);
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
        scene.setAttribute("aria-hidden", String(isClone));
        scene.inert = isClone;
        const cardLink = scene.querySelector(".home-hero-card-shell");
        if (cardLink) cardLink.tabIndex = isActive && !isClone ? 0 : -1;
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
    const getNextRailOffset = () => {
      const firstOffset = railCards[0]?.offsetLeft || 0;
      return Array.from(rail.children)
        .map((card) => card.offsetLeft - firstOffset)
        .find((offset) => offset > rail.scrollLeft + 2);
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
      rail.scrollTo({ left: getNextRailOffset() ?? railCycleWidth, behavior: "smooth" });
      window.clearTimeout(railResetTimer);
      railResetTimer = window.setTimeout(normalizeRail, 900);
    }, 5200);
  }
}

window.addEventListener("scroll", setHeaderState, { passive: true });
window.addEventListener("vecto:language-change", (event) => applyPublicLanguage(event.detail?.language));
window.addEventListener("pageshow", updateRegisterVerificationAvailability);
updateRegisterVerificationAvailability();
window.setTimeout(updateRegisterVerificationAvailability, 160);
markPublicStaticUi();
applyPublicLanguage(window.VectoSiteNavigation?.currentLanguage() || "zh-Hant");
startPublicLanguageObserver();
loadLoginPolicy();
setHeaderState();
initHomeExperience();
