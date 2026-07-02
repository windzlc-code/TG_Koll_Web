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
  const payload = {
    username: form.username.value.trim(),
    password: form.password.value,
  };
  const me = await api("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (me && me.is_admin) {
    location.href = "/admin.html#admin-overview";
    return;
  }
  location.href = "/index.html#app-generate";
}

async function submitRegister(form) {
  const payload = {
    username: form.username.value.trim(),
    password: form.password.value,
  };
  const me = await api("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (me && me.is_admin) {
    location.href = "/admin.html#admin-overview";
    return;
  }
  location.href = "/index.html#app-generate";
}

document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("loginForm");
  const registerForm = document.getElementById("registerForm");

  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setMsg("", true);
      try {
        await submitLogin(loginForm);
      } catch (err) {
        setMsg(err.detail || String(err), false);
      }
    });
  }

  if (registerForm) {
    registerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setMsg("", true);
      try {
        await submitRegister(registerForm);
      } catch (err) {
        setMsg(err.detail || String(err), false);
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
