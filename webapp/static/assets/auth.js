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

function authErrorMessage(error, fallback = "操作失败，请稍后再试") {
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
  button.textContent = `${remaining} 秒后可重发`;
  verifiedPasswordSetupState.resendTimer = window.setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      button.textContent = `${remaining} 秒后可重发`;
      return;
    }
    window.clearInterval(verifiedPasswordSetupState.resendTimer);
    button.disabled = false;
    button.textContent = "重新发送验证码";
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
  if (title) title.textContent = "为 Google 账号设置本地密码";
  if (copy) copy.textContent = "通过已验证邮箱确认身份，设置后即可使用邮箱或用户名加密码登录。";
  if (cardTitle) cardTitle.textContent = "设置本地登录密码";
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
    if (!verifiedPasswordSetupState.challengeId) throw { detail: "验证码请求无效，请重试" };
    setMsg("验证码已发送，请在 10 分钟内完成设置。", true);
    startPasswordSetupResendCountdown(button, result?.resend_after);
    document.getElementById("passwordSetupCode")?.focus();
  } catch (error) {
    button.disabled = false;
    setMsg(authErrorMessage(error, "验证码发送失败"), false);
  }
}

async function submitForcedPasswordChange(form) {
  const currentPassword = form.old_password.value;
  const newPassword = form.new_password.value;
  const confirmation = form.confirm_password.value;
  const admin = adminConsolePasswordChangeActive();
  const minimumLength = admin ? 12 : 8;
  if (newPassword.length < minimumLength) throw { detail: `新密码至少 ${minimumLength} 位` };
  if (newPassword !== confirmation) throw { detail: "两次输入的新密码不一致" };
  if (verifiedPasswordSetupState.enabled) {
    const verificationCode = String(form.verification_code?.value || "").trim();
    if (!verifiedPasswordSetupState.challengeId) throw { detail: "请先发送邮箱验证码" };
    if (!/^[0-9]{6}$/.test(verificationCode)) throw { detail: "请输入 6 位邮箱验证码" };
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
  const forcePasswordForm = document.getElementById("forcePasswordForm");
  if (!forcePasswordForm) return;
  if (adminConsolePasswordChangeActive()) {
    forcePasswordForm.new_password.minLength = 12;
    forcePasswordForm.confirm_password.minLength = 12;
    document.querySelector(".auth-quick-setup-link")?.setAttribute("href", "/admin");
  }
  enableVerifiedPasswordSetup(forcePasswordForm).catch((error) => {
    setMsg(authErrorMessage(error, "无法读取账号认证状态"), false);
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
