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
  forcePasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMsg("", true);
    const submit = forcePasswordForm.querySelector("button[type='submit']");
    if (submit?.disabled) return;
    if (submit) submit.disabled = true;
    try {
      await submitForcedPasswordChange(forcePasswordForm);
    } catch (error) {
      setMsg(error.detail || String(error), false);
      if (submit) submit.disabled = false;
    }
  });
});
