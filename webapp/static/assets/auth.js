const AUTH_LANGUAGE_STORAGE_KEY = "wk-console-language";
const AUTH_COPY = {
  "zh-Hans": {
    pageTitle: "设置新密码 - Vecto", securityKicker: "Vecto 账号安全", stageTitle: "首次登录需要设置新密码",
    stageCopy: "管理员生成的临时密码只用于首次验证。完成修改后，账号才会进入 Web 任务控制台。",
    temporaryPassword: "临时密码", temporaryPasswordHint: "输入管理员提供的临时密码进行身份确认。",
    newPassword: "新密码", newPasswordHint: "使用至少 8 位且不易猜测的新密码。", cardTitle: "设置新密码",
    cardCopy: "完成后将直接进入 Web 任务控制台", verificationEmailPrefix: "验证码将发送到已验证邮箱：",
    sendCode: "发送邮箱验证码", emailCode: "邮箱验证码", confirmPassword: "确认新密码",
    saveAndContinue: "保存并进入控制台", backToLogin: "返回用户登录", retryCode: "重新发送验证码",
    resendAfter: (seconds) => `${seconds} 秒后可重发`, googleStageTitle: "为 Google 账号设置本地密码",
    googleStageCopy: "通过已验证邮箱确认身份，设置后即可使用邮箱或用户名加密码登录。",
    googleCardTitle: "设置本地登录密码", invalidCodeRequest: "验证码请求无效，请重试",
    codeSent: "验证码已发送，请在 10 分钟内完成设置。", codeSendFailed: "验证码发送失败",
    passwordTooShort: (length) => `新密码至少 ${length} 位`, passwordMismatch: "两次输入的新密码不一致",
    sendCodeFirst: "请先发送邮箱验证码", invalidCode: "请输入 6 位邮箱验证码",
    accountStateFailed: "无法读取账号认证状态", genericError: "操作失败，请稍后再试",
  },
  "zh-Hant": {
    pageTitle: "設定新密碼 - Vecto", securityKicker: "Vecto 帳號安全", stageTitle: "首次登入需要設定新密碼",
    stageCopy: "管理員產生的臨時密碼只用於首次驗證。完成修改後，帳號才會進入 Web 任務控制台。",
    temporaryPassword: "臨時密碼", temporaryPasswordHint: "輸入管理員提供的臨時密碼進行身分確認。",
    newPassword: "新密碼", newPasswordHint: "使用至少 8 位且不易猜測的新密碼。", cardTitle: "設定新密碼",
    cardCopy: "完成後將直接進入 Web 任務控制台", verificationEmailPrefix: "驗證碼將傳送到已驗證電子郵件：",
    sendCode: "傳送電子郵件驗證碼", emailCode: "電子郵件驗證碼", confirmPassword: "確認新密碼",
    saveAndContinue: "儲存並進入控制台", backToLogin: "返回使用者登入", retryCode: "重新傳送驗證碼",
    resendAfter: (seconds) => `${seconds} 秒後可重新傳送`, googleStageTitle: "為 Google 帳號設定本機密碼",
    googleStageCopy: "透過已驗證電子郵件確認身分，設定後即可使用電子郵件或用户名加密碼登入。",
    googleCardTitle: "設定本機登入密碼", invalidCodeRequest: "驗證碼請求無效，請重試",
    codeSent: "驗證碼已傳送，請在 10 分鐘內完成設定。", codeSendFailed: "驗證碼傳送失敗",
    passwordTooShort: (length) => `新密碼至少 ${length} 位`, passwordMismatch: "兩次輸入的新密碼不一致",
    sendCodeFirst: "請先傳送電子郵件驗證碼", invalidCode: "請輸入 6 位電子郵件驗證碼",
    accountStateFailed: "無法讀取帳號驗證狀態", genericError: "操作失敗，請稍後再試",
  },
};

function authLanguage() {
  try { return window.localStorage.getItem(AUTH_LANGUAGE_STORAGE_KEY) === "zh-Hant" ? "zh-Hant" : "zh-Hans"; }
  catch { return "zh-Hans"; }
}

function authText(key, ...args) {
  const value = AUTH_COPY[authLanguage()][key] ?? AUTH_COPY["zh-Hans"][key] ?? key;
  return typeof value === "function" ? value(...args) : value;
}

function applyAuthLanguage() {
  const language = authLanguage();
  document.documentElement.lang = language;
  document.documentElement.dataset.language = language;
  document.title = authText("pageTitle");
  document.querySelectorAll("[data-auth-i18n]").forEach((node) => {
    node.textContent = authText(node.dataset.authI18n);
  });
  if (verifiedPasswordSetupState.enabled) {
    document.querySelector(".auth-stage-title").textContent = authText("googleStageTitle");
    document.querySelector(".auth-stage-copy").textContent = authText("googleStageCopy");
    document.querySelector(".auth-title").textContent = authText("googleCardTitle");
  }
}

async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (adminConsolePasswordChangeActive()) headers.set("X-Admin-Console", "1");
  const res = await fetch(path, { credentials: "include", ...opts, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { detail: text || `HTTP ${res.status}` };
  }
  if (!res.ok) throw data || { detail: `HTTP ${res.status}` };
  return data;
}

function setMsg(text, ok) {
  const el = document.getElementById("authMsg");
  if (!el) return;
  el.textContent = text || "";
  el.className = `msg ${ok ? "ok" : "err"}`;
}

function adminConsolePasswordChangeActive() {
  try {
    return new URLSearchParams(window.location.search).get("admin_console") === "1";
  } catch {
    return false;
  }
}

function safeAuthReturnUrl(fallback = "/console.html", role = adminConsolePasswordChangeActive() ? "admin" : "user") {
  const value = String(new URLSearchParams(window.location.search).get("return_url") || "").trim();
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) {
    return fallback;
  }
  try {
    const target = new URL(value, window.location.origin);
    if (target.origin !== window.location.origin) return fallback;
    const adminParameters = ["admin_console", "admin_workspace_user_id", "manage_user_id", "return_manage_user_id"];
    if (role !== "admin") {
      if (target.pathname.startsWith("/admin") || target.pathname === "/api/admin" || target.pathname.startsWith("/api/admin/") || adminParameters.some((key) => target.searchParams.has(key))) {
        return fallback;
      }
    } else {
      if (target.pathname === "/console.html") target.pathname = "/admin-console.html";
      if (target.pathname === "/profile.html") target.pathname = "/admin-profile.html";
      if (!(target.pathname.startsWith("/admin") || target.pathname === "/api/admin" || target.pathname.startsWith("/api/admin/"))) {
        target.searchParams.set("admin_console", "1");
      }
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return fallback;
  }
}

const verifiedPasswordSetupState = {
  enabled: false,
  email: "",
  challengeId: "",
  resendTimer: 0,
};

function authErrorMessage(error, fallback = authText("genericError")) {
  const detail = error?.detail ?? error;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    return String(detail.message || detail.code || fallback);
  }
  return String(error || fallback);
}

function startPasswordSetupResendCountdown(button, seconds) {
  window.clearInterval(verifiedPasswordSetupState.resendTimer);
  let remaining = Math.max(Number(seconds || 60), 1);
  button.disabled = true;
  button.textContent = authText("resendAfter", remaining);
  verifiedPasswordSetupState.resendTimer = window.setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      button.textContent = authText("resendAfter", remaining);
      return;
    }
    window.clearInterval(verifiedPasswordSetupState.resendTimer);
    button.disabled = false;
    button.textContent = authText("retryCode");
  }, 1000);
}

async function enableVerifiedPasswordSetup(form) {
  if (adminConsolePasswordChangeActive()) return;
  const account = await api("/api/auth/me");
  if (account?.password_login_enabled !== false || !account?.verified_email) return;
  verifiedPasswordSetupState.enabled = true;
  verifiedPasswordSetupState.email = String(account.verified_email);
  const currentFields = document.getElementById("currentPasswordFields");
  const verifiedFields = document.getElementById("verifiedPasswordSetup");
  const oldPassword = form.old_password;
  if (currentFields) currentFields.hidden = true;
  if (verifiedFields) verifiedFields.hidden = false;
  if (oldPassword) oldPassword.required = false;
  if (form.verification_code) form.verification_code.required = true;
  const emailLabel = document.getElementById("verifiedPasswordEmail");
  if (emailLabel) emailLabel.textContent = verifiedPasswordSetupState.email;
  const title = document.querySelector(".auth-stage-title");
  const copy = document.querySelector(".auth-stage-copy");
  const cardTitle = document.querySelector(".auth-title");
  if (title) title.textContent = authText("googleStageTitle");
  if (copy) copy.textContent = authText("googleStageCopy");
  if (cardTitle) cardTitle.textContent = authText("googleCardTitle");
}

async function sendPasswordSetupCode(button) {
  if (!verifiedPasswordSetupState.enabled || !verifiedPasswordSetupState.email) return;
  button.disabled = true;
  setMsg("", true);
  try {
    const result = await api("/api/auth/email-verification/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: verifiedPasswordSetupState.email,
        purpose: "set_password",
      }),
    });
    verifiedPasswordSetupState.challengeId = String(result?.challenge_id || "");
    if (!verifiedPasswordSetupState.challengeId) throw { detail: authText("invalidCodeRequest") };
    setMsg(authText("codeSent"), true);
    startPasswordSetupResendCountdown(button, result?.resend_after);
    document.getElementById("passwordSetupCode")?.focus();
  } catch (error) {
    button.disabled = false;
    setMsg(authErrorMessage(error, authText("codeSendFailed")), false);
  }
}

async function submitForcedPasswordChange(form) {
  const currentPassword = form.old_password.value;
  const newPassword = form.new_password.value;
  const confirmation = form.confirm_password.value;
  const admin = adminConsolePasswordChangeActive();
  const minimumLength = admin ? 12 : 8;
  if (newPassword.length < minimumLength) throw { detail: authText("passwordTooShort", minimumLength) };
  if (newPassword !== confirmation) throw { detail: authText("passwordMismatch") };
  if (verifiedPasswordSetupState.enabled) {
    const verificationCode = String(form.verification_code?.value || "").trim();
    if (!verifiedPasswordSetupState.challengeId) throw { detail: authText("sendCodeFirst") };
    if (!/^[0-9]{6}$/.test(verificationCode)) throw { detail: authText("invalidCode") };
    await api("/api/auth/password/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challenge_id: verifiedPasswordSetupState.challengeId,
        verification_code: verificationCode,
        new_password: newPassword,
      }),
    });
  } else {
    await api("/api/auth/change_password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_password: currentPassword, new_password: newPassword }),
    });
  }
  location.href = safeAuthReturnUrl(admin ? "/admin" : "/console.html", admin ? "admin" : "user");
}

document.addEventListener("DOMContentLoaded", () => {
  applyAuthLanguage();
  const forcePasswordForm = document.getElementById("forcePasswordForm");
  if (!forcePasswordForm) return;
  if (adminConsolePasswordChangeActive()) {
    forcePasswordForm.new_password.minLength = 12;
    forcePasswordForm.confirm_password.minLength = 12;
    document.querySelector(".auth-quick-setup-link")?.setAttribute("href", "/admin");
  }
  enableVerifiedPasswordSetup(forcePasswordForm).catch((error) => {
    setMsg(authErrorMessage(error, authText("accountStateFailed")), false);
  });
  document.getElementById("sendPasswordSetupCode")?.addEventListener("click", (event) => {
    sendPasswordSetupCode(event.currentTarget);
  });
  forcePasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMsg("", true);
    const submit = forcePasswordForm.querySelector("button[type='submit']");
    if (submit?.disabled) return;
    if (submit) submit.disabled = true;
    try {
      await submitForcedPasswordChange(forcePasswordForm);
    } catch (error) {
      setMsg(authErrorMessage(error), false);
      if (submit) submit.disabled = false;
    }
  });
});

window.addEventListener("vecto:language-change", applyAuthLanguage);
