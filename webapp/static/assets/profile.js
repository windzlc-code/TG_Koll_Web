(() => {
  const isAdminSession = document.querySelector('meta[name="admin-console-session"]')?.content === "1";
  const ADMIN_WORKSPACE_STORAGE_KEY = "vecto-admin-workspace-user-id";
  const ADMIN_CONTEXT_STORAGE_KEY = "vecto-admin-console-context";
  const AVATAR_MAX_BYTES = 512 * 1024;
  const state = { account: null, avatarUrl: "", tags: [], saving: false, dirty: false };
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

  function normalizeTags(value = "") {
    const items = Array.isArray(value) ? value : String(value || "").split(/[,，\n]+/);
    const tags = [];
    const seen = new Set();
    for (const item of items) {
      const tag = String(item || "").replace(/\s+/g, " ").trim().slice(0, 18);
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length >= 8) break;
    }
    return tags;
  }

  function renderTags() {
    const list = $("profileTagList");
    const hidden = $("profileTags");
    if (hidden) hidden.value = state.tags.join(", ");
    if (!list) return;
    list.replaceChildren(...state.tags.map((tag, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "profile-tag-chip";
      button.dataset.profileTagRemove = String(index);
      button.title = `移除标签 ${tag}`;
      const label = document.createElement("span");
      label.textContent = tag;
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M6 6l12 12M18 6 6 18");
      icon.appendChild(path);
      button.append(label, icon);
      return button;
    }));
  }

  function addTagFromInput() {
    const input = $("profileTagInput");
    const tag = String(input?.value || "").trim();
    if (!tag) return;
    const next = normalizeTags([...state.tags, tag]);
    if (next.length === state.tags.length && next.some((item) => item.toLowerCase() === tag.toLowerCase())) {
      setStatus("标签已存在。", "error");
      return;
    }
    state.tags = next;
    state.dirty = true;
    if (input) input.value = "";
    renderTags();
    setStatus("");
  }

  function renderAccount(account) {
    state.account = account;
    state.avatarUrl = String(account?.avatar_url || "").trim();
    state.tags = normalizeTags(account?.profile_tags || "");
    $("profileFullName").value = String(account?.full_name || "").trim();
    if ($("profileSignature")) $("profileSignature").value = String(account?.profile_signature || "").trim();
    if ($("profilePhone")) $("profilePhone").value = String(account?.phone || "").trim();
    if ($("profileEmail")) $("profileEmail").value = String(account?.email || "").trim();
    $("profileFullName").placeholder = String(account?.username || "账户");
    $("profileUsername").textContent = String(account?.username || "-");
    $("profileAccountId").textContent = account?.id ? `#${account.id}` : "-";
    $("profileAccountRole").textContent = Number(account?.is_admin || 0) === 1 ? "管理员" : "普通账号";
    $("profileBackLink").href = isAdminSession ? "/admin-console.html" : "/console.html";
    window.VectoSiteNavigation?.setAccount(account);
    renderAvatar();
    renderTags();
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
      state.dirty = false;
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
    if (file.size > AVATAR_MAX_BYTES) {
      setStatus("头像图片不能超过 512KB。", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.avatarUrl = String(reader.result || "");
      state.dirty = true;
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
    const profileSignature = String($("profileSignature")?.value || "").trim();
    const profileTags = state.tags.join(", ");
    const phone = String($("profilePhone")?.value || "").trim();
    const email = String($("profileEmail")?.value || "").trim();
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
        body: JSON.stringify({
          full_name: fullName,
          avatar_url: state.avatarUrl,
          profile_signature: profileSignature,
          profile_tags: profileTags,
          phone,
          email,
        }),
      });
      state.dirty = false;
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
    state.dirty = true;
    renderAvatar();
    setStatus("头像将在保存后移除。");
  });
  $("profileTagAdd")?.addEventListener("click", addTagFromInput);
  $("profileTagInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addTagFromInput();
    }
  });
  $("profileTagList")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-profile-tag-remove]");
    if (!button) return;
    const index = Number(button.dataset.profileTagRemove || -1);
    if (!Number.isInteger(index) || index < 0) return;
    state.tags.splice(index, 1);
    state.dirty = true;
    renderTags();
  });
  $("profileForm")?.addEventListener("input", () => {
    state.dirty = true;
  });
  $("profileForm")?.addEventListener("submit", saveProfile);
  if (isAdminSession) {
    try {
      sessionStorage.removeItem(ADMIN_WORKSPACE_STORAGE_KEY);
      sessionStorage.setItem(ADMIN_CONTEXT_STORAGE_KEY, "1");
    } catch (_) {}
  }
  window.addEventListener("vecto:logout-request", () => void logout());
  window.addEventListener("vecto:navigation-ready", () => {
    if (state.account) window.VectoSiteNavigation?.setAccount(state.account);
  });
  window.addEventListener("vecto:account-data-refresh", (event) => {
    if (!state.saving && !state.dirty && event.detail?.account) renderAccount(event.detail.account);
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !state.saving && !state.dirty) void loadProfile();
  });
  void loadProfile();
})();
