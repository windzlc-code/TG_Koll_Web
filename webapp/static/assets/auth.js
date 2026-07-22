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
  if (!res.ok) {
    throw data || { detail: `HTTP ${res.status}` };
  }
  return data;
}

function setMsg(text, ok) {
  const el = document.getElementById("authMsg");
  if (!el) return;
  el.textContent = text || "";
  el.className = `msg ${ok ? "ok" : "err"}`;
}

function apiErrorDetail(error) {
  const detail = error?.detail;
  if (typeof detail === "string" && detail.trim()) return { code: "", message: detail.trim() };
  if (detail && typeof detail === "object") {
    return {
      code: String(detail.code || "").trim(),
      message: String(detail.message || detail.detail || "").trim(),
    };
  }
  return { code: "", message: String(error || "").trim() };
}

function safeAuthReturnUrl(fallback = "/console.html") {
  const value = String(new URLSearchParams(window.location.search).get("return_url") || "").trim();
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) {
    return fallback;
  }
  try {
    const target = new URL(value, window.location.origin);
    if (target.origin !== window.location.origin) return fallback;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return fallback;
  }
}

function adminConsolePasswordChangeActive() {
  try {
    return new URLSearchParams(window.location.search).get("admin_console") === "1";
  } catch {
    return false;
  }
}

function forcedPasswordChangeTarget(returnUrl, admin = false) {
  const params = new URLSearchParams({ return_url: returnUrl });
  if (admin) params.set("admin_console", "1");
  return `/change-password.html?${params.toString()}`;
}

function browserDeviceId() {
  const key = "vecto-device-id";
  try {
    let value = localStorage.getItem(key) || "";
    if (!value) {
      value = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(key, value);
    }
    return value.slice(0, 128);
  } catch {
    return "";
  }
}

async function submitLogin(form, forceTakeover = false) {
  const loginRole = form.dataset.loginRole === "admin" ? "admin" : "user";
  const payload = {
    username: form.username.value.trim(),
    password: form.password.value,
    remember_me: Boolean(form.remember_me?.checked),
    force_takeover: loginRole === "user" && Boolean(forceTakeover),
    mfa_code: loginRole === "admin" ? String(form.mfa_code?.value || "").trim() : "",
    device_id: browserDeviceId(),
  };
  const result = await api(`/api/auth/${loginRole}-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (result?.must_change_password) {
    const admin = loginRole === "admin";
    const returnUrl = safeAuthReturnUrl(admin ? "/admin" : "/console.html");
    location.href = forcedPasswordChangeTarget(returnUrl, admin);
    return;
  }
  location.href = safeAuthReturnUrl(loginRole === "admin" ? "/admin" : "/console.html");
}

function setPasswordVisibility(button, revealed) {
  const input = document.getElementById(button.getAttribute("aria-controls") || "");
  if (!input) return;
  input.type = revealed ? "text" : "password";
  button.classList.toggle("is-visible", revealed);
  button.setAttribute("aria-pressed", revealed ? "true" : "false");
  button.setAttribute("aria-label", revealed ? "隐藏密码" : "显示密码");
  button.title = revealed ? "隐藏密码" : "显示密码";
}

async function loadAuthPolicy(form) {
  if (!form?.remember_me) return;
  try {
    const policy = await api("/api/auth/policy");
    const enabled = policy.remember_login_enabled !== false;
    form.remember_me.disabled = !enabled;
    form.remember_me.checked = enabled && policy.remember_login_default === true;
    const field = form.querySelector("[data-auth-remember]");
    if (field) field.hidden = !enabled;
  } catch {
    form.remember_me.checked = false;
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
  await api("/api/auth/change_password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_password: currentPassword, new_password: newPassword }),
  });
  location.href = safeAuthReturnUrl(admin ? "/admin" : "/console.html");
}

async function submitRegister(form) {
  const payload = {
    username: form.username.value.trim(),
    password: form.password.value,
  };
  const result = await api("/api/auth/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  setMsg(result.message || "申请已提交，请等待管理员授权后登录", true);
}

document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("loginForm") || document.getElementById("adminLoginForm");
  const registerForm = document.getElementById("registerForm");
  const forcePasswordForm = document.getElementById("forcePasswordForm");

  if (loginForm) {
    const takeover = document.querySelector("[data-auth-login-takeover]");
    loadAuthPolicy(loginForm);
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setMsg("", true);
      const submit = loginForm.querySelector("button[type='submit']");
      if (submit?.disabled) return;
      if (submit) submit.disabled = true;
      try {
        await submitLogin(loginForm, false);
      } catch (err) {
        const detail = apiErrorDetail(err);
        setMsg(detail.message || "登录失败，请检查账号与密码", false);
        if (detail.code === "mfa_code_invalid") loginForm.mfa_code?.focus();
        if (takeover) takeover.hidden = detail.code !== "SESSION_CONFLICT";
        if (submit) submit.disabled = false;
      }
    });
    takeover?.addEventListener("click", async () => {
      if (takeover.disabled) return;
      takeover.disabled = true;
      setMsg("", true);
      try {
        await submitLogin(loginForm, true);
      } catch (err) {
        const detail = apiErrorDetail(err);
        setMsg(detail.message || "强制登录失败，请稍后再试", false);
        takeover.disabled = false;
      }
    });
    loginForm.addEventListener("input", () => {
      if (takeover) takeover.hidden = true;
    });
  }

  document.querySelectorAll("[data-auth-password-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.getAttribute("aria-controls") || "");
      setPasswordVisibility(button, input?.type === "password");
      input?.focus({ preventScroll: true });
    });
  });

  if (registerForm) {
    registerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setMsg("", true);
      const submit = registerForm.querySelector("button[type='submit']");
      if (submit?.disabled) return;
      if (submit) submit.disabled = true;
      try {
        await submitRegister(registerForm);
      } catch (err) {
        setMsg(err.detail || String(err), false);
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }

  if (forcePasswordForm) {
    if (adminConsolePasswordChangeActive()) {
      forcePasswordForm.new_password.minLength = 12;
      forcePasswordForm.confirm_password.minLength = 12;
      document.querySelector(".auth-quick-setup-link")?.setAttribute("href", "/admin");
    }
    forcePasswordForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setMsg("", true);
      const submit = forcePasswordForm.querySelector("button[type='submit']");
      if (submit?.disabled) return;
      if (submit) submit.disabled = true;
      try {
        await submitForcedPasswordChange(forcePasswordForm);
      } catch (err) {
        setMsg(err.detail || String(err), false);
        if (submit) submit.disabled = false;
      }
    });
  }

  const toRegister = document.getElementById("toRegister");
  if (toRegister) {
    toRegister.addEventListener("click", () => {
      location.href = "/register.html";
    });
  }

  const toLogin = document.getElementById("toLogin");
  if (toLogin) {
    toLogin.addEventListener("click", () => {
      location.href = "/login.html";
    });
  }
});
