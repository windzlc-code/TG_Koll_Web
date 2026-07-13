const header = document.querySelector("[data-header]");
const applicationForm = document.querySelector("#contact");
const applicationStatus = document.querySelector("#formStatus");
const loginModal = document.querySelector("#loginModal");
const loginForm = document.querySelector("#homeLoginForm");
const loginStatus = document.querySelector("#loginStatus");
let loginReturnFocus = null;

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
    [form.password, form.password.value.length >= 6, "密碼至少需要 6 位。"],
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
  window.setTimeout(() => document.querySelector("#loginUsername")?.focus(), 40);
}

function closeLogin() {
  if (!loginModal?.classList.contains("is-open")) return;
  loginModal.classList.remove("is-open");
  loginModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  const returnFocus = loginReturnFocus;
  loginReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}

document.querySelectorAll("[data-open-login]").forEach((button) => button.addEventListener("click", openLogin));
document.querySelectorAll("[data-close-login]").forEach((button) => button.addEventListener("click", closeLogin));
loginModal?.addEventListener("click", (event) => {
  if (event.target === loginModal) closeLogin();
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

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginStatus.textContent = "";
  const submit = loginForm.querySelector("button[type='submit']");
  submit.disabled = true;
  try {
    await api("/api/auth/user-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: loginForm.username.value.trim(),
        password: loginForm.password.value,
      }),
    });
    window.location.assign("/console.html");
  } catch (error) {
    loginStatus.textContent = error.detail || "登入失敗，請檢查帳號與密碼。";
    submit.disabled = false;
  }
});

applicationForm?.querySelectorAll("input").forEach((input) => {
  input.addEventListener("input", () => setFieldError(input, ""));
});
window.addEventListener("scroll", setHeaderState, { passive: true });
setHeaderState();
