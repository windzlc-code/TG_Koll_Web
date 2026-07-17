(() => {
  const isAdminSession = document.querySelector('meta[name="admin-console-session"]')?.content === "1";
  const state = { account: null, avatarUrl: "", saving: false };
  const $ = (id) => document.getElementById(id);

  function requestHeaders(extra = {}) {
    const headers = new Headers(extra);
    headers.set("Accept", "application/json");
    if (isAdminSession) headers.set("X-Admin-Console", "1");
    return headers;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: "include",
      cache: "no-store",
      headers: requestHeaders(options.headers || {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.detail;
      const message = typeof detail === "string"
        ? detail
        : String(detail?.message || payload?.message || `请求失败（${response.status}）`);
      const error = new Error(message);
      error.status = response.status;
      error.code = typeof detail === "object" ? String(detail?.code || "") : "";
      throw error;
    }
    return payload;
  }

  function setStatus(message = "", type = "") {
    const node = $("profileStatus");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("is-success", type === "success");
    node.classList.toggle("is-error", type === "error");
  }

  function accountInitial() {
    return String(state.account?.full_name || state.account?.username || "V").trim().slice(0, 1).toUpperCase() || "V";
  }

  function renderAvatar() {
    const preview = $("profileAvatarPreview");
    if (!preview) return;
    preview.textContent = "";
    if (state.avatarUrl) {
      const image = document.createElement("img");
      image.src = state.avatarUrl;
      image.alt = "";
      preview.appendChild(image);
    } else {
      preview.textContent = accountInitial();
    }
    $("profileAvatarRemove")?.toggleAttribute("hidden", !state.avatarUrl);
  }

  function renderAccount(account) {
    state.account = account;
    state.avatarUrl = String(account?.avatar_url || "").trim();
    $("profileFullName").value = String(account?.full_name || "").trim();
    $("profileFullName").placeholder = String(account?.username || "账户");
    $("profileUsername").textContent = String(account?.username || "-");
    $("profileAccountId").textContent = account?.id ? `#${account.id}` : "-";
    $("profileAccountRole").textContent = Number(account?.is_admin || 0) === 1 ? "管理员" : "普通账号";
    $("profileBackLink").href = isAdminSession ? "/admin-console.html" : "/console.html";
    window.VectoSiteNavigation?.setAccount(account);
    renderAvatar();
  }

  function redirectToLogin() {
    window.location.replace(isAdminSession ? "/admin" : "/login.html");
  }

  function handleSessionBoundary(error) {
    const status = Number(error?.status || 0);
    if (status === 401) {
      redirectToLogin();
      return true;
    }
    if (status === 428) {
      window.location.replace(
        error?.code === "mfa_setup_required" && isAdminSession
          ? "/admin#account"
          : "/change-password.html",
      );
      return true;
    }
    return false;
  }

  async function loadProfile() {
    try {
      renderAccount(await api("/api/me"));
    } catch (error) {
      if (handleSessionBoundary(error)) return;
      setStatus(error.message || "个人资料读取失败。", "error");
    }
  }

  function readAvatarFile(file) {
    if (!file) return;
    if (!String(file.type || "").startsWith("image/")) {
      setStatus("请选择图片文件。", "error");
      return;
    }
    if (file.size > 140 * 1024) {
      setStatus("头像图片不能超过 140KB。", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.avatarUrl = String(reader.result || "");
      renderAvatar();
      setStatus("头像已载入，保存后生效。");
    };
    reader.onerror = () => setStatus("头像读取失败，请重新选择。", "error");
    reader.readAsDataURL(file);
  }

  async function saveProfile(event) {
    event.preventDefault();
    if (state.saving) return;
    const fullName = String($("profileFullName")?.value || "").trim();
    if (fullName && (fullName.length < 2 || fullName.length > 80)) {
      setStatus("显示名称需要 2 至 80 个字符。", "error");
      return;
    }
    state.saving = true;
    $("profileSave").disabled = true;
    $("profileSave").textContent = "保存中…";
    setStatus("");
    try {
      const result = await api("/api/me/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full_name: fullName, avatar_url: state.avatarUrl }),
      });
      renderAccount({ ...(state.account || {}), ...(result.profile || result || {}) });
      setStatus("个人资料已保存。", "success");
    } catch (error) {
      if (handleSessionBoundary(error)) return;
      setStatus(error.message || "个人资料保存失败。", "error");
    } finally {
      state.saving = false;
      $("profileSave").disabled = false;
      $("profileSave").textContent = "保存个人资料";
    }
  }

  async function logout() {
    window.VectoSiteNavigation?.setLogoutPending(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
      window.location.replace(isAdminSession ? "/admin" : "/login.html");
    } catch (error) {
      window.VectoSiteNavigation?.setLogoutPending(false, error.message || "退出失败，请重试。");
    }
  }

  $("profileAvatarButton")?.addEventListener("click", () => $("profileAvatarFile")?.click());
  $("profileAvatarFile")?.addEventListener("change", (event) => {
    readAvatarFile(event.target.files?.[0]);
    event.target.value = "";
  });
  $("profileAvatarRemove")?.addEventListener("click", () => {
    state.avatarUrl = "";
    renderAvatar();
    setStatus("头像将在保存后移除。");
  });
  $("profileForm")?.addEventListener("submit", saveProfile);
  window.addEventListener("vecto:logout-request", () => void logout());
  window.addEventListener("vecto:navigation-ready", () => {
    if (state.account) window.VectoSiteNavigation?.setAccount(state.account);
  });
  void loadProfile();
})();
