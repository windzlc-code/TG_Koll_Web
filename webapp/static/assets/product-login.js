(() => {
  const LOGIN_DEVICE_STORAGE_KEY = "vecto-login-device-id";
  const form = document.getElementById("productLoginForm");
  const status = document.getElementById("loginStatus");
  const passwordInput = document.getElementById("loginPassword");
  const passwordToggle = document.querySelector("[data-login-password-toggle]");
  const takeover = document.querySelector("[data-login-takeover]");
  const googleButton = document.querySelector("[data-google-login]");
  const mfaField = document.getElementById("loginMfaField");
  const mfaInput = document.getElementById("loginMfaCode");
  const fallbackRedirect = String(document.body.dataset.loginRedirect || "/console.html");

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

  function safeReturnUrl(value, fallback = fallbackRedirect) {
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

  function adminReturnUrl(value, fallback) {
    const target = safeReturnUrl(value, fallback);
    try {
      const url = new URL(target, window.location.origin);
      if (url.pathname === "/console.html") url.pathname = "/admin-console.html";
      else if (url.pathname === "/video.html") url.pathname = "/admin-video.html";
      else if (url.pathname === "/profile.html") url.pathname = "/admin-profile.html";
      else if (!(url.pathname.startsWith("/admin") || url.pathname === "/api/admin" || url.pathname.startsWith("/api/admin/"))) {
        url.searchParams.set("admin_console", "1");
      }
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return fallback;
    }
  }

  function requestedReturnUrl() {
    return safeReturnUrl(new URLSearchParams(window.location.search).get("return_url"), fallbackRedirect);
  }

  function setStatus(message, ok) {
    if (!status) return;
    status.textContent = message || "";
    status.className = `msg ${ok ? "ok" : message ? "err" : ""}`;
  }

  function apiErrorDetail(error) {
    const payload = error && typeof error === "object" ? error : {};
    const detail = payload.detail;
    if (detail && typeof detail === "object") {
      return {
        code: String(detail.code || payload.code || ""),
        message: String(detail.message || detail.detail || payload.message || ""),
        verification: detail.verification || payload.verification || {},
      };
    }
    return {
      code: String(payload.code || ""),
      message: String(detail || payload.message || ""),
      verification: payload.verification || {},
    };
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: "include", ...options });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { detail: text || `HTTP ${response.status}` };
    }
    if (!response.ok) {
      const error = data || { detail: `HTTP ${response.status}` };
      throw error;
    }
    return data;
  }

  function setPasswordRevealed(revealed) {
    if (!passwordInput || !passwordToggle) return;
    passwordInput.type = revealed ? "text" : "password";
    passwordToggle.classList.toggle("is-visible", revealed);
    passwordToggle.setAttribute("aria-pressed", revealed ? "true" : "false");
    const label = revealed ? "隐藏密码" : "显示密码";
    passwordToggle.setAttribute("aria-label", label);
    passwordToggle.setAttribute("title", label);
  }

  function showMfa(show) {
    if (mfaField) mfaField.hidden = !show;
    if (mfaInput) mfaInput.hidden = !show;
    if (show) mfaInput?.focus();
  }

  async function submitLogin(forceTakeover = false) {
    if (!form) return;
    setStatus("");
    const submit = form.querySelector("button[type='submit']");
    submit.disabled = true;
    if (takeover) takeover.disabled = true;
    if (googleButton) googleButton.disabled = true;
    try {
      const result = await api("/api/auth/portal-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.username.value.trim(),
          password: form.password.value,
          remember_me: Boolean(form.remember_me?.checked),
          force_takeover: Boolean(forceTakeover),
          mfa_code: String(form.mfa_code?.value || "").trim(),
          device_id: loginDeviceId(),
        }),
      });
      const isAdmin = result?.is_admin === true;
      const nextUrl = isAdmin ? adminReturnUrl(requestedReturnUrl(), fallbackRedirect) : requestedReturnUrl();
      const passwordTarget = isAdmin
        ? `/change-password.html?admin_console=1&return_url=${encodeURIComponent(nextUrl)}`
        : `/change-password.html?return_url=${encodeURIComponent(nextUrl)}`;
      window.VectoSiteNavigation?.announceAuthSessionChange?.("login");
      if (result?.must_change_password) {
        window.location.assign(passwordTarget);
        return;
      }
      if (isAdmin) window.VectoSiteNavigation?.markAdminConsoleContext?.();
      else window.VectoSiteNavigation?.clearAdminConsoleContext?.();
      window.location.assign(nextUrl);
    } catch (error) {
      const detail = apiErrorDetail(error);
      setStatus(detail.message || "登录失败，请检查账号与密码。");
      if (detail.code === "mfa_code_invalid" || detail.code === "SECURITY_VERIFICATION_REQUIRED") {
        showMfa(true);
      }
      if (takeover) {
        takeover.hidden = detail.code !== "SESSION_CONFLICT";
        takeover.disabled = false;
      }
      submit.disabled = false;
      if (googleButton) googleButton.disabled = false;
    }
  }

  passwordToggle?.addEventListener("click", () => {
    setPasswordRevealed(passwordInput?.type === "password");
    passwordInput?.focus({ preventScroll: true });
  });

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitLogin(false);
  });

  takeover?.addEventListener("click", () => {
    submitLogin(true);
  });

  googleButton?.addEventListener("click", () => {
    const returnUrl = requestedReturnUrl();
    googleButton.disabled = true;
    window.location.assign(`/api/auth/google/start?return_url=${encodeURIComponent(returnUrl)}`);
  });
})();
