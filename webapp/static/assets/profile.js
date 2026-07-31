(() => {
  const isAdminSession = document.querySelector('meta[name="admin-console-session"]')?.content === "1";
  const ADMIN_WORKSPACE_STORAGE_KEY = "vecto-admin-workspace-user-id";
  const ADMIN_CONTEXT_STORAGE_KEY = "vecto-admin-console-context";
  const PROFILE_LANGUAGE_STORAGE_KEY = "wk-console-language";
  const PROFILE_COPY = {
    "zh-Hans": {
      pageTitle: "个人资料 - Vecto",
      skipToMain: "跳至主要内容",
      accountProfile: "账号资料",
      personalProfile: "个人资料",
      profileDescription: "设置显示名称和头像。登录用户名及账号权限不会因此改变。",
      backToConsole: "返回控制台",
      profileSettings: "个人资料设置",
      avatar: "头像",
      uploadAvatar: "上传新头像",
      avatarHelp: "点击头像右下角的加号上传，最大 512KB。",
      displayName: "显示名称",
      displayNamePlaceholder: "请输入显示名称",
      displayNameHelp: "显示在右上角账号信息中，不会修改登录用户名。",
      signature: "个性签名",
      signaturePlaceholder: "填写一句对外展示的个人签名",
      signatureHelp: "最多 280 个字符，会显示在账号资料中。",
      personalTags: "个人标签",
      addedTags: "已添加标签",
      tagsPlaceholder: "输入标签",
      addTag: "添加标签",
      tagsHelp: "点击加号添加，最多展示 8 个标签。",
      phone: "手机号",
      phonePlaceholder: "填写联系电话",
      email: "邮箱",
      changePassword: "修改密码",
      passwordDialogTitle: "通过邮箱修改密码",
      passwordDialogHelp: "验证码将发送至已验证的账号邮箱。",
      sendVerificationCode: "发送验证码",
      verificationCode: "邮箱验证码",
      verificationCodePlaceholder: "输入 6 位验证码",
      newPassword: "新密码",
      confirmNewPassword: "确认新密码",
      resetPassword: "确认修改密码",
      passwordMismatch: "两次输入的新密码不一致。",
      passwordCodeRequired: "请先发送并填写邮箱验证码。",
      passwordCodeSent: "验证码已发送，请查收邮箱。",
      passwordChanged: "密码已修改，请使用新密码登录。",
      readonlyAccountInfo: "只读账号信息",
      loginUsername: "登录用户名",
      accountId: "账号 ID",
      accountType: "账号类型",
      saveProfile: "保存个人资料",
      requestFailed: "请求失败（{status}）",
      removeTag: "移除标签 {tag}",
      tagAlreadyExists: "标签已存在。",
      accountFallback: "账户",
      adminRole: "管理员",
      customerRole: "普通账号",
      profileLoadFailed: "个人资料读取失败。",
      selectImageFile: "请选择图片文件。",
      avatarTooLarge: "头像图片不能超过 512KB。",
      avatarLoaded: "头像已载入，保存后生效。",
      avatarReadFailed: "头像读取失败，请重新选择。",
      displayNameLength: "显示名称需要 2 至 80 个字符。",
      savingProfile: "保存中…",
      profileSaved: "个人资料已保存。",
      profileSaveFailed: "个人资料保存失败。",
      logoutFailed: "退出失败，请重试。",
      understood: "知道了",
    },
    "zh-Hant": {
      pageTitle: "個人資料 - Vecto",
      skipToMain: "跳至主要內容",
      accountProfile: "帳號資料",
      personalProfile: "個人資料",
      profileDescription: "設定顯示名稱和頭像。登入使用者名稱及帳號權限不會因此改變。",
      backToConsole: "返回控制台",
      profileSettings: "個人資料設定",
      avatar: "頭像",
      uploadAvatar: "上傳新頭像",
      avatarHelp: "點擊頭像右下角的加號上傳，最大 512KB。",
      displayName: "顯示名稱",
      displayNamePlaceholder: "請輸入顯示名稱",
      displayNameHelp: "顯示在右上角帳號資訊中，不會修改登入使用者名稱。",
      signature: "個性簽名",
      signaturePlaceholder: "填寫一句對外展示的個人簽名",
      signatureHelp: "最多 280 個字元，會顯示在帳號資料中。",
      personalTags: "個人標籤",
      addedTags: "已新增標籤",
      tagsPlaceholder: "輸入標籤",
      addTag: "新增標籤",
      tagsHelp: "點擊加號新增，最多顯示 8 個標籤。",
      phone: "手機號碼",
      phonePlaceholder: "填寫聯絡電話",
      email: "電子郵件",
      changePassword: "修改密碼",
      passwordDialogTitle: "透過電子郵件修改密碼",
      passwordDialogHelp: "驗證碼將發送至已驗證的帳號電子郵件。",
      sendVerificationCode: "發送驗證碼",
      verificationCode: "電子郵件驗證碼",
      verificationCodePlaceholder: "輸入 6 位驗證碼",
      newPassword: "新密碼",
      confirmNewPassword: "確認新密碼",
      resetPassword: "確認修改密碼",
      passwordMismatch: "兩次輸入的新密碼不一致。",
      passwordCodeRequired: "請先發送並填寫電子郵件驗證碼。",
      passwordCodeSent: "驗證碼已發送，請查收電子郵件。",
      passwordChanged: "密碼已修改，請使用新密碼登入。",
      readonlyAccountInfo: "唯讀帳號資訊",
      loginUsername: "登入使用者名稱",
      accountId: "帳號 ID",
      accountType: "帳號類型",
      saveProfile: "儲存個人資料",
      requestFailed: "請求失敗（{status}）",
      removeTag: "移除標籤 {tag}",
      tagAlreadyExists: "標籤已存在。",
      accountFallback: "帳號",
      adminRole: "管理員",
      customerRole: "一般帳號",
      profileLoadFailed: "個人資料讀取失敗。",
      selectImageFile: "請選擇圖片檔案。",
      avatarTooLarge: "頭像圖片不能超過 512KB。",
      avatarLoaded: "頭像已載入，儲存後生效。",
      avatarReadFailed: "頭像讀取失敗，請重新選擇。",
      displayNameLength: "顯示名稱需要 2 至 80 個字元。",
      savingProfile: "儲存中…",
      profileSaved: "個人資料已儲存。",
      profileSaveFailed: "個人資料儲存失敗。",
      logoutFailed: "登出失敗，請重試。",
      understood: "知道了",
    },
  };
  const PROFILE_I18N_ATTRIBUTES = {
    "data-profile-i18n-aria-label": "aria-label",
    "data-profile-i18n-placeholder": "placeholder",
    "data-profile-i18n-title": "title",
  };
  let profileStCharacters = null;
  let profileTsCharacters = null;
  let profileTsPhrases = null;
  const returnManageUserId = (() => {
    if (!isAdminSession) return "";
    const value = String(new URLSearchParams(window.location.search).get("return_manage_user_id") || "").trim();
    return /^\d+$/.test(value) && Number(value) > 0 ? value : "";
  })();
  const AVATAR_MAX_BYTES = 512 * 1024;
  const state = {
    account: null,
    avatarUrl: "",
    tags: [],
    saving: false,
    dirty: false,
    status: null,
  };
  const $ = (id) => document.getElementById(id);

  function currentProfileLanguage() {
    const navigationLanguage = window.VectoSiteNavigation?.currentLanguage?.();
    if (navigationLanguage === "zh-Hant") return "zh-Hant";
    if (navigationLanguage === "zh-Hans") return "zh-Hans";
    if (document.documentElement.dataset.language === "zh-Hant") return "zh-Hant";
    try {
      return localStorage.getItem(PROFILE_LANGUAGE_STORAGE_KEY) === "zh-Hant" ? "zh-Hant" : "zh-Hans";
    } catch (_) {
      return "zh-Hans";
    }
  }

  function profileText(key, variables = {}, language = currentProfileLanguage()) {
    const labels = PROFILE_COPY[language] || PROFILE_COPY["zh-Hans"];
    const template = String(labels[key] ?? PROFILE_COPY["zh-Hans"][key] ?? key);
    return template.replace(/\{(\w+)\}/g, (_, name) => String(variables[name] ?? ""));
  }

  function parseOpenCcDictionary(dictionary) {
    if (typeof dictionary !== "string") return [];
    return dictionary.split("|").flatMap((entry) => {
      const separator = entry.indexOf(" ");
      if (separator <= 0) return [];
      return [[entry.slice(0, separator), entry.slice(separator + 1)]];
    });
  }

  function convertProfileUiText(value, language = currentProfileLanguage()) {
    let text = String(value || "");
    if (!text) return "";
    if (language === "zh-Hant") {
      if (!profileStCharacters) {
        profileStCharacters = new Map(parseOpenCcDictionary(window.VectoOpenCcStCharacters));
      }
      return Array.from(text).map((character) => profileStCharacters.get(character) || character).join("");
    }
    if (!profileTsCharacters) {
      profileTsCharacters = new Map(parseOpenCcDictionary(window.VectoOpenCcTsCharacters));
    }
    if (!profileTsPhrases) {
      profileTsPhrases = parseOpenCcDictionary(window.VectoOpenCcTsPhrases)
        .sort((left, right) => right[0].length - left[0].length);
    }
    const protectedPhrases = [];
    profileTsPhrases.forEach(([traditional, simplified], index) => {
      if (!text.includes(traditional)) return;
      const token = `\uE300${index}\uE3FF`;
      text = text.split(traditional).join(token);
      protectedPhrases.push([token, simplified]);
    });
    text = Array.from(text).map((character) => profileTsCharacters.get(character) || character).join("");
    protectedPhrases.forEach(([token, simplified]) => {
      text = text.split(token).join(simplified);
    });
    return text;
  }

  function setProfileCopy(
    node,
    key,
    attribute = "textContent",
    variables = {},
    language = currentProfileLanguage(),
  ) {
    if (!node) return;
    const value = profileText(key, variables, language);
    if (attribute === "textContent") node.textContent = value;
    else node.setAttribute(attribute, value);
  }

  function renderStatus(language = currentProfileLanguage()) {
    const node = $("profileStatus");
    if (!node) return;
    const status = state.status;
    node.textContent = !status
      ? ""
      : status.key
        ? profileText(status.key, status.variables, language)
        : convertProfileUiText(status.message, language);
    node.classList.toggle("is-success", status?.type === "success");
    node.classList.toggle("is-error", status?.type === "error");
  }

  function setStatus(message = "", type = "") {
    state.status = message ? { message: String(message), type } : null;
    renderStatus();
  }

  function setStatusKey(key = "", type = "", variables = {}) {
    state.status = key ? { key, type, variables } : null;
    renderStatus();
  }

  function renderAccountLanguage(language = currentProfileLanguage()) {
    const username = String(state.account?.username || "").trim();
    const fullNameInput = $("profileFullName");
    if (fullNameInput) {
      fullNameInput.placeholder = username || profileText("accountFallback", {}, language);
    }
    const role = $("profileAccountRole");
    if (role && state.account) {
      role.textContent = profileText(
        Number(state.account.is_admin || 0) === 1 ? "adminRole" : "customerRole",
        {},
        language,
      );
    }
    renderTags(language);
  }

  function applyProfileLanguage(language = currentProfileLanguage()) {
    const nextLanguage = language === "zh-Hant" ? "zh-Hant" : "zh-Hans";
    document.querySelectorAll("[data-profile-i18n]").forEach((node) => {
      setProfileCopy(node, node.dataset.profileI18n, "textContent", {}, nextLanguage);
    });
    Object.entries(PROFILE_I18N_ATTRIBUTES).forEach(([marker, attribute]) => {
      document.querySelectorAll(`[${marker}]`).forEach((node) => {
        setProfileCopy(node, node.getAttribute(marker), attribute, {}, nextLanguage);
      });
    });
    if (state.account) renderAccountLanguage(nextLanguage);
    setProfileCopy(
      $("profileSave"),
      state.saving ? "savingProfile" : "saveProfile",
      "textContent",
      {},
      nextLanguage,
    );
    renderStatus(nextLanguage);
    document.documentElement.lang = nextLanguage === "zh-Hant" ? "zh-Hant" : "zh-CN";
  }

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
        : String(detail?.message || payload?.message || profileText("requestFailed", { status: response.status }));
      const error = new Error(message);
      error.status = response.status;
      error.code = typeof detail === "object" ? String(detail?.code || "") : "";
      throw error;
    }
    return payload;
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
    document.querySelector(".profile-avatar-icon-add")?.toggleAttribute("hidden", Boolean(state.avatarUrl));
    document.querySelector(".profile-avatar-icon-replace")?.toggleAttribute("hidden", !state.avatarUrl);
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

  function renderTags(language = currentProfileLanguage()) {
    const list = $("profileTagList");
    const hidden = $("profileTags");
    if (hidden) hidden.value = state.tags.join(", ");
    if (!list) return;
    list.replaceChildren(...state.tags.map((tag, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "profile-tag-chip";
      button.dataset.profileTagRemove = String(index);
      button.title = profileText("removeTag", { tag }, language);
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
      setStatusKey("tagAlreadyExists", "error");
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
    $("profileUsername").textContent = String(account?.username || "-");
    $("profileAccountId").textContent = account?.id ? `#${account.id}` : "-";
    $("profileAccountEmail").textContent = String(account?.email || "-").trim() || "-";
    $("profileBackLink").href = isAdminSession
      ? `/admin-console.html${returnManageUserId ? `?manage_user_id=${encodeURIComponent(returnManageUserId)}` : ""}`
      : "/console.html";
    window.VectoSiteNavigation?.setAccount(account);
    renderAvatar();
    renderAccountLanguage();
  }

  function redirectToLogin() {
    const returnUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const entry = isAdminSession ? "/admin" : "/?login=1";
    const separator = entry.includes("?") ? "&" : "?";
    window.location.replace(`${entry}${separator}return_url=${encodeURIComponent(returnUrl)}`);
  }

  function handleSessionBoundary(error) {
    const status = Number(error?.status || 0);
    if (status === 401) {
      redirectToLogin();
      return true;
    }
    if (status === 428) {
      const returnUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.replace(
        error?.code === "mfa_setup_required" && isAdminSession
          ? "/admin#account"
          : isAdminSession
            ? `/change-password.html?admin_console=1&return_url=${encodeURIComponent(returnUrl)}`
            : `/change-password.html?return_url=${encodeURIComponent(returnUrl)}`,
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
      if (error.message) setStatus(error.message, "error");
      else setStatusKey("profileLoadFailed", "error");
    }
  }

  function readAvatarFile(file) {
    if (!file) return;
    if (!String(file.type || "").startsWith("image/")) {
      setStatusKey("selectImageFile", "error");
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setStatusKey("avatarTooLarge", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.avatarUrl = String(reader.result || "");
      state.dirty = true;
      renderAvatar();
      setStatusKey("avatarLoaded");
    };
    reader.onerror = () => setStatusKey("avatarReadFailed", "error");
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
      setStatusKey("displayNameLength", "error");
      return;
    }
    state.saving = true;
    $("profileSave").disabled = true;
    setProfileCopy($("profileSave"), "savingProfile");
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
      window.VectoSiteNavigation?.setAccount(state.account);
      setStatusKey("profileSaved", "success");
    } catch (error) {
      if (handleSessionBoundary(error)) return;
      if (error.message) setStatus(error.message, "error");
      else setStatusKey("profileSaveFailed", "error");
    } finally {
      state.saving = false;
      $("profileSave").disabled = false;
      setProfileCopy($("profileSave"), "saveProfile");
    }
  }

  async function logout() {
    window.VectoSiteNavigation?.setLogoutPending(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
      const logoutFeedback = window.VectoSiteNavigation?.authFeedbackCopyByTime?.("logout") || {
        kind: "logout",
        title: "退出成功，再见",
        message: "辛苦了，期待下次见面。",
        actionText: profileText("understood"),
      };
      await window.VectoSiteNavigation?.showAuthFeedback?.(logoutFeedback);
      window.location.replace("/");
    } catch (error) {
      window.VectoSiteNavigation?.setLogoutPending(
        false,
        error.message ? convertProfileUiText(error.message) : profileText("logoutFailed"),
      );
    }
  }

  function openPasswordResetDialog() {
    const email = String(state.account?.email || "").trim();
    if (!email) {
      setStatus("请先在个人资料中保存已验证的邮箱。", "error");
      return;
    }
    const language = currentProfileLanguage();
    const showAuthFeedback = window.VectoSiteNavigation?.showAuthFeedback;
    if (typeof showAuthFeedback !== "function") {
      setStatus(profileText("profileSaveFailed", {}, language), "error");
      return;
    }
    showAuthFeedback({
      kind: "success",
      title: profileText("passwordDialogTitle", {}, language),
      message: profileText("passwordDialogHelp", {}, language),
      actionText: false,
      dialogClass: "is-form",
      contentHtml: `<form class="site-auth-feedback-form" novalidate>
        <div class="site-auth-feedback-email"><span>${profileText("email", {}, language)}</span><strong data-password-email></strong></div>
        <label><span>${profileText("verificationCode", {}, language)}</span><div class="site-auth-feedback-code-row"><input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="${profileText("verificationCodePlaceholder", {}, language)}" required /><button type="button" class="site-auth-feedback-form-action" data-password-send>${profileText("sendVerificationCode", {}, language)}</button></div></label>
        <label><span>${profileText("newPassword", {}, language)}</span><input name="password" type="password" minlength="8" maxlength="256" autocomplete="new-password" required /></label>
        <label><span>${profileText("confirmNewPassword", {}, language)}</span><input name="confirmPassword" type="password" minlength="8" maxlength="256" autocomplete="new-password" required /></label>
        <p class="site-auth-feedback-form-status" role="status" aria-live="polite"></p>
        <button type="submit" class="site-auth-feedback-form-action is-primary" data-password-submit>${profileText("resetPassword", {}, language)}</button>
      </form>`,
      onOpen(modal, close) {
        const form = modal.querySelector(".site-auth-feedback-form");
        const fields = form.elements;
        modal.querySelector("[data-password-email]").textContent = email;
        const status = modal.querySelector(".site-auth-feedback-form-status");
        const send = modal.querySelector("[data-password-send]");
        const submit = modal.querySelector("[data-password-submit]");
        let challengeId = "";
        const setDialogStatus = (key = "", tone = "") => {
          status.textContent = key ? profileText(key, {}, language) : "";
          status.className = `site-auth-feedback-form-status${tone ? ` is-${tone}` : ""}`;
        };
        send.addEventListener("click", async () => {
          send.disabled = true;
          setDialogStatus("");
          try {
            const result = await api("/api/auth/email-verification/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, purpose: "password_setup" }) });
            challengeId = String(result?.challenge_id || "");
            setDialogStatus("passwordCodeSent", "success");
            fields.code.focus();
          } catch (error) {
            status.textContent = error.message || profileText("profileSaveFailed", {}, language);
            status.className = "site-auth-feedback-form-status is-error";
          } finally {
            send.disabled = false;
          }
        });
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!challengeId || !String(fields.code.value || "").trim()) {
            setDialogStatus("passwordCodeRequired", "error");
            return;
          }
          if (fields.password.value !== fields.confirmPassword.value) {
            setDialogStatus("passwordMismatch", "error");
            return;
          }
          submit.disabled = true;
          setDialogStatus("");
          try {
            await api("/api/auth/password/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge_id: challengeId, verification_code: String(fields.code.value || "").trim(), new_password: fields.password.value }) });
            close();
            await showAuthFeedback({ kind: "success", title: profileText("passwordChanged", {}, language), message: "", actionText: profileText("understood", {}, language) });
          } catch (error) {
            status.textContent = error.message || profileText("profileSaveFailed", {}, language);
            status.className = "site-auth-feedback-form-status is-error";
          } finally {
            submit.disabled = false;
          }
        });
        send.focus({ preventScroll: true });
      },
    });
  }

  $("profileAvatarButton")?.addEventListener("click", () => $("profileAvatarFile")?.click());
  $("profileAvatarFile")?.addEventListener("change", (event) => {
    readAvatarFile(event.target.files?.[0]);
    event.target.value = "";
  });
  $("profileChangePassword")?.addEventListener("click", openPasswordResetDialog);
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
      if (returnManageUserId) sessionStorage.setItem(ADMIN_WORKSPACE_STORAGE_KEY, returnManageUserId);
      else sessionStorage.removeItem(ADMIN_WORKSPACE_STORAGE_KEY);
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
  window.addEventListener("vecto:language-change", (event) => {
    applyProfileLanguage(event.detail?.language);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === PROFILE_LANGUAGE_STORAGE_KEY) {
      applyProfileLanguage(event.newValue);
    }
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !state.saving && !state.dirty) void loadProfile();
  });
  window.VectoProfileI18n = {
    applyLanguage: applyProfileLanguage,
    currentLanguage: currentProfileLanguage,
    text: profileText,
  };
  applyProfileLanguage();
  void loadProfile();
})();
