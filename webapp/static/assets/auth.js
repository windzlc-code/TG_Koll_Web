async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "include", ...opts });
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

async function submitLogin(form) {
  const loginRole = form.dataset.loginRole === "admin" ? "admin" : "user";
  const payload = {
    username: form.username.value.trim(),
    password: form.password.value,
    remember_me: Boolean(form.remember_me?.checked),
  };
  const result = await api(`/api/auth/${loginRole}-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (loginRole === "user" && result?.must_change_password) {
    location.href = "/change-password.html";
    return;
  }
  location.href = loginRole === "admin" ? "/admin" : "/console.html";
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
  if (newPassword.length < 8) throw { detail: "新密码至少 8 位" };
  if (newPassword !== confirmation) throw { detail: "两次输入的新密码不一致" };
  await api("/api/auth/change_password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_password: currentPassword, new_password: newPassword }),
  });
  location.href = "/console.html";
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
    loadAuthPolicy(loginForm);
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setMsg("", true);
      const submit = loginForm.querySelector("button[type='submit']");
      if (submit?.disabled) return;
      if (submit) submit.disabled = true;
      try {
        await submitLogin(loginForm);
      } catch (err) {
        setMsg(err.detail || String(err), false);
        if (submit) submit.disabled = false;
      }
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
