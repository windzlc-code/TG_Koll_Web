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
      backToConsole: "返回推文工作台",
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
      redeemCode: "兑换码",
      redeemDialogTitle: "兑换积分",
      redeemDialogHelp: "输入管理员提供的兑换码，核验成功后积分会立即到账。",
      redeemCodeLabel: "兑换码",
      redeemCodePlaceholder: "请输入兑换码",
      confirmRedeem: "确认兑换",
      redeeming: "正在兑换…",
      redeemSuccess: "兑换成功",
      redeemSuccessMessage: "已到账 {added} 点，当前共有 {balance} 点。",
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
      myInvitation: "我的邀请",
      myInvitationHelp: "生成邀请码和邀请链接，查看奖励记录。",
      invitationProgram: "邀请计划",
      inviteFriends: "邀请好友加入 Vecto",
      invitationSummary: "生成专属邀请码或链接。新用户完成注册绑定后，双方会按当前规则获得奖励。",
      invitationBenefits: "邀请计划特点",
      invitationBenefitBoth: "双方都有奖励",
      invitationBenefitTrack: "奖励记录可追踪",
      invitationBenefitSecure: "注册绑定更安心",
      backToProfile: "返回个人资料",
      invitationCode: "我的邀请码",
      invitationCodeHint: "你的专属邀请凭证",
      notGenerated: "尚未生成",
      generated: "已生成",
      generateInvitation: "生成邀请码",
      generatingInvitation: "生成中…",
      copyCode: "复制邀请码",
      invitationLink: "邀请好友链接",
      invitationLinkHelp: "可直接发送给好友",
      invitationShareHint: "分享文案与专属链接已组合",
      invitationShareMessage: "邀请好友分享文案",
      invitationShareCopy: "我正在使用 Vecto 管理社媒内容，邀请你一起来体验。通过我的专属链接注册，完成绑定后双方都可按当前活动规则获得奖励：\n{link}",
      copyLink: "复制分享文案与链接",
      invitationJourney: "邀请流程",
      invitationJourneyShare: "分享邀请码或链接",
      invitationJourneyRegister: "好友完成新账号注册",
      invitationJourneyReward: "双方奖励写入账户",
      invitationRecords: "邀请记录",
      invitationRecordsEmpty: "暂无邀请记录",
      invitationRecordRole: "邀请人：{inviter} · 受邀人：{invitee}",
      invitationPagination: "邀请记录翻页",
      invitationPageSummary: "第 {page} / {pages} 页 · 共 {total} 条",
      previousPage: "上一页",
      nextPage: "下一页",
      invitationDisabled: "邀请活动当前已停用，暂时不能生成或复制邀请码。",
      rewardSettled: "积分已结算",
      permissionPending: "权限待开通",
      invitationPending: "待使用",
      invitationRevoked: "已失效",
      invitationRules: "活动说明",
      inviterRewardPending: "邀请人奖励以当前活动规则为准。",
      inviteeRewardPending: "受邀人完成新账号注册后获得对应奖励。",
      inviterRewardRule: "每成功邀请 1 名新用户，邀请人获得 {points} 点。",
      inviteeRewardRule: "受邀人完成注册绑定后获得 {points} 点。",
      invitationRuleOnce: "每个新账号只能绑定一次邀请码，不能邀请自己。",
      invitationRuleAudit: "奖励及权限变动均写入记录，以后台审核结果为准。",
      permissionRewards: "其他权限奖励",
      permissionRewardsPending: "订阅、额度与功能权限框架已预留，暂未启用。",
      invitationProfileEyebrow: "邀请中心",
      invitationProfileTitle: "我的邀请码",
      invitationProfileDescription: "分享专属邀请码或链接，并查看邀请关系与奖励到账记录。",
      invitationLoadFailed: "邀请信息读取失败。",
      invitationCreated: "邀请码已生成。",
      invitationCopied: "已复制。",
      invitationCopyFailed: "复制失败，请手动复制。",
    },
    "zh-Hant": {
      pageTitle: "個人資料 - Vecto",
      skipToMain: "跳至主要內容",
      accountProfile: "帳號資料",
      personalProfile: "個人資料",
      profileDescription: "設定顯示名稱和頭像。登入用户名及帳號權限不會因此改變。",
      backToConsole: "返回推文工作台",
      profileSettings: "個人資料設定",
      avatar: "頭像",
      uploadAvatar: "上傳新頭像",
      avatarHelp: "點擊頭像右下角的加號上傳，最大 512KB。",
      displayName: "顯示名稱",
      displayNamePlaceholder: "請輸入顯示名稱",
      displayNameHelp: "顯示在右上角帳號資訊中，不會修改登入用户名。",
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
      redeemCode: "兌換碼",
      redeemDialogTitle: "兌換積分",
      redeemDialogHelp: "輸入管理員提供的兌換碼，核驗成功後積分會立即到帳。",
      redeemCodeLabel: "兌換碼",
      redeemCodePlaceholder: "請輸入兌換碼",
      confirmRedeem: "確認兌換",
      redeeming: "正在兌換…",
      redeemSuccess: "兌換成功",
      redeemSuccessMessage: "已到帳 {added} 點，目前共有 {balance} 點。",
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
      loginUsername: "登入用户名",
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
      myInvitation: "我的邀請",
      myInvitationHelp: "產生邀請碼和邀請連結，查看獎勵記錄。",
      invitationProgram: "邀請計畫",
      inviteFriends: "邀請好友加入 Vecto",
      invitationSummary: "產生專屬邀請碼或連結。新用戶完成註冊綁定後，雙方會按目前規則獲得獎勵。",
      invitationBenefits: "邀請計畫特點",
      invitationBenefitBoth: "雙方都有獎勵",
      invitationBenefitTrack: "獎勵記錄可追蹤",
      invitationBenefitSecure: "註冊綁定更安心",
      backToProfile: "返回個人資料",
      invitationCode: "我的邀請碼",
      invitationCodeHint: "你的專屬邀請憑證",
      notGenerated: "尚未產生",
      generated: "已產生",
      generateInvitation: "產生邀請碼",
      generatingInvitation: "產生中…",
      copyCode: "複製邀請碼",
      invitationLink: "邀請好友連結",
      invitationLinkHelp: "可直接傳送給好友",
      invitationShareHint: "分享文案與專屬連結已組合",
      invitationShareMessage: "邀請好友分享文案",
      invitationShareCopy: "我正在使用 Vecto 管理社群內容，邀請你一起來體驗。透過我的專屬連結註冊，完成綁定後雙方都可按目前活動規則獲得獎勵：\n{link}",
      copyLink: "複製分享文案與連結",
      invitationJourney: "邀請流程",
      invitationJourneyShare: "分享邀請碼或連結",
      invitationJourneyRegister: "好友完成新帳號註冊",
      invitationJourneyReward: "雙方獎勵寫入帳戶",
      invitationRecords: "邀請記錄",
      invitationRecordsEmpty: "暫無邀請記錄",
      invitationRecordRole: "邀請人：{inviter} · 受邀人：{invitee}",
      invitationPagination: "邀請記錄翻頁",
      invitationPageSummary: "第 {page} / {pages} 頁 · 共 {total} 條",
      previousPage: "上一頁",
      nextPage: "下一頁",
      invitationDisabled: "邀請活動目前已停用，暫時不能產生或複製邀請碼。",
      rewardSettled: "積分已結算",
      permissionPending: "權限待開通",
      invitationPending: "待使用",
      invitationRevoked: "已失效",
      invitationRules: "活動說明",
      inviterRewardPending: "邀請人獎勵以目前活動規則為準。",
      inviteeRewardPending: "受邀人完成新帳號註冊後獲得對應獎勵。",
      inviterRewardRule: "每成功邀請 1 名新用戶，邀請人獲得 {points} 點。",
      inviteeRewardRule: "受邀人完成註冊綁定後獲得 {points} 點。",
      invitationRuleOnce: "每個新帳號只能綁定一次邀請碼，不能邀請自己。",
      invitationRuleAudit: "獎勵及權限變動均寫入記錄，以後台審核結果為準。",
      permissionRewards: "其他權限獎勵",
      permissionRewardsPending: "訂閱、額度與功能權限框架已預留，暫未啟用。",
      invitationProfileEyebrow: "邀請中心",
      invitationProfileTitle: "我的邀請碼",
      invitationProfileDescription: "分享專屬邀請碼或連結，並查看邀請關係與獎勵到帳記錄。",
      invitationLoadFailed: "邀請資訊讀取失敗。",
      invitationCreated: "邀請碼已產生。",
      invitationCopied: "已複製。",
      invitationCopyFailed: "複製失敗，請手動複製。",
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
    view: "profile",
    invitation: null,
    invitationLoading: false,
    invitationStatus: null,
    invitationOffset: 0,
    invitationLimit: 10,
    invitationTotal: 0,
    invitationNextOffset: 0,
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

  function renderInvitationStatus(language = currentProfileLanguage()) {
    const node = $("profileInvitationStatus");
    if (!node) return;
    const status = state.invitationStatus;
    node.textContent = !status
      ? ""
      : status.key
        ? profileText(status.key, status.variables, language)
        : convertProfileUiText(status.message, language);
    node.classList.toggle("is-success", status?.type === "success");
    node.classList.toggle("is-error", status?.type === "error");
  }

  function setInvitationStatus(message = "", type = "") {
    state.invitationStatus = message ? { message: String(message), type } : null;
    renderInvitationStatus();
  }

  function setInvitationStatusKey(key = "", type = "", variables = {}) {
    state.invitationStatus = key ? { key, type, variables } : null;
    renderInvitationStatus();
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
    const generating = Boolean(state.invitationLoading && !invitationCode());
    setProfileCopy($("profileGenerateInvitation"), generating ? "generatingInvitation" : "generateInvitation", "textContent", {}, nextLanguage);
    renderInvitationRules(nextLanguage);
    renderInvitationStatus(nextLanguage);
    renderProfileViewCopy(nextLanguage);
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

  function normalizedInvitationPayload(payload = {}) {
    const invitation = payload?.invitation && typeof payload.invitation === "object" ? payload.invitation : {};
    const settings = payload?.settings && typeof payload.settings === "object"
      ? payload.settings
      : invitation?.settings && typeof invitation.settings === "object" ? invitation.settings : {};
    return {
      ...payload,
      ...invitation,
      settings,
      records: Array.isArray(payload?.records)
        ? payload.records
        : Array.isArray(payload?.items) ? payload.items : Array.isArray(invitation?.records) ? invitation.records : [],
    };
  }

  function invitationCode() {
    const codePayload = state.invitation?.code;
    return String(
      state.invitation?.invite_code
      || state.invitation?.invitation_code
      || (codePayload && typeof codePayload === "object" ? codePayload.code : codePayload)
      || "",
    ).trim();
  }

  function invitationLink() {
    const code = invitationCode();
    const provided = String(state.invitation?.share_url || state.invitation?.invite_url || state.invitation?.invite_link || state.invitation?.url || "").trim();
    if (provided) return provided;
    if (!code) return "";
    const target = new URL("/", window.location.origin);
    target.searchParams.set("register", "1");
    target.searchParams.set("invite_code", code);
    return target.toString();
  }

  function invitationShareText(link = invitationLink()) {
    const normalizedLink = String(link || "").trim();
    return normalizedLink ? profileText("invitationShareCopy", { link: normalizedLink }) : "";
  }

  function invitationRewardPoints(side) {
    const settings = state.invitation?.settings || {};
    const rewards = state.invitation?.rewards || {};
    return Number(
      settings?.[`${side}_reward_points`]
      ?? settings?.[`${side}_points`]
      ?? rewards?.[`${side}_reward_points`]
      ?? rewards?.[`${side}_points`]
      ?? state.invitation?.[`${side}_reward_points`]
      ?? state.invitation?.[`${side}_points`]
      ?? 0,
    );
  }

  function formatInvitationPoints(value) {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric)) return "0";
    return new Intl.NumberFormat(currentProfileLanguage() === "zh-Hant" ? "zh-TW" : "zh-CN", { maximumFractionDigits: 2 }).format(numeric);
  }

  function formatInvitationTime(value) {
    const raw = String(value || "").trim();
    if (!raw) return "—";
    const numeric = Number(raw);
    const date = new Date(Number.isFinite(numeric) && numeric > 0 && numeric < 1e12 ? numeric * 1000 : raw);
    if (Number.isNaN(date.getTime())) return raw;
    return new Intl.DateTimeFormat(currentProfileLanguage() === "zh-Hant" ? "zh-TW" : "zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function renderInvitationRules(language = currentProfileLanguage()) {
    const inviterPoints = invitationRewardPoints("inviter");
    const inviteePoints = invitationRewardPoints("invitee");
    setProfileCopy(
      $("profileInviterRewardRule"),
      inviterPoints > 0 ? "inviterRewardRule" : "inviterRewardPending",
      "textContent",
      { points: formatInvitationPoints(inviterPoints) },
      language,
    );
    setProfileCopy(
      $("profileInviteeRewardRule"),
      inviteePoints > 0 ? "inviteeRewardRule" : "inviteeRewardPending",
      "textContent",
      { points: formatInvitationPoints(inviteePoints) },
      language,
    );
  }

  function invitationRecordName(item) {
    const invitee = item?.invitee && typeof item.invitee === "object" ? item.invitee : {};
    return String(item?.invitee_username || item?.invitee_name || invitee.username || invitee.full_name || invitee.name || "").trim()
      || (currentProfileLanguage() === "zh-Hant" ? "尚未註冊" : "尚未注册");
  }

  function invitationRecordPartyName(item, side) {
    const nested = item?.[side] && typeof item[side] === "object" ? item[side] : {};
    if (String(item?.viewer_role || "").toLowerCase() === side && state.account?.username) {
      return String(state.account.username);
    }
    const value = String(item?.[`${side}_username`] || item?.[`${side}_name`] || nested.username || nested.full_name || nested.name || "").trim();
    if (value) return value;
    return side === "inviter"
      ? (state.account?.username || "—")
      : (currentProfileLanguage() === "zh-Hant" ? "尚未註冊" : "尚未注册");
  }

  function invitationRecordStatus(item) {
    const raw = String(item?.internal_status || item?.status || "").trim().toLowerCase();
    if (raw === "pending_permission") return "pending_permission";
    if (["rewarded", "completed", "redeemed", "bound", "used"].includes(raw) || item?.rewarded_at) return "rewarded";
    if (["revoked", "expired", "invalid", "disabled"].includes(raw)) return "revoked";
    return "pending";
  }

  function renderInvitationRecords(records = []) {
    const list = $("profileInvitationRecordList");
    if (!list) return;
    list.replaceChildren();
    const rows = Array.isArray(records) ? records : [];
    $("profileInvitationRecordCount").textContent = String(state.invitationTotal || rows.length);
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "profile-invitation-empty";
      empty.textContent = profileText("invitationRecordsEmpty");
      list.appendChild(empty);
      return;
    }
    rows.forEach((item) => {
      const record = document.createElement("article");
      record.className = "profile-invitation-record";
      const name = document.createElement("strong");
      name.textContent = invitationRecordName(item);
      const status = document.createElement("span");
      const recordStatus = invitationRecordStatus(item);
      const statusKey = recordStatus === "pending_permission"
        ? "permissionPending"
        : recordStatus === "rewarded" ? "rewardSettled" : recordStatus === "revoked" ? "invitationRevoked" : "invitationPending";
      status.textContent = profileText(statusKey);
      const role = document.createElement("small");
      role.className = "profile-invitation-record-role";
      role.textContent = profileText("invitationRecordRole", {
        inviter: invitationRecordPartyName(item, "inviter"),
        invitee: invitationRecordPartyName(item, "invitee"),
      });
      const detail = document.createElement("small");
      const viewerRole = String(item?.viewer_role || "inviter").toLowerCase() === "invitee" ? "invitee" : "inviter";
      const points = Number(item?.[`${viewerRole}_reward_points`] ?? item?.[`${viewerRole}_points`] ?? item?.reward_points ?? 0);
      const time = item?.bound_at || item?.used_at || item?.completed_at || item?.rewarded_at || item?.created_at;
      detail.textContent = recordStatus === "pending_permission"
        ? `${formatInvitationTime(time)} · ${profileText("permissionPending")}`
        : `${formatInvitationTime(time)} · ${formatInvitationPoints(points)} ${currentProfileLanguage() === "zh-Hant" ? "點" : "点"}`;
      record.append(name, status, role, detail);
      list.appendChild(record);
    });
  }

  function renderInvitationPagination() {
    const total = Math.max(0, Number(state.invitationTotal || 0));
    const limit = Math.max(1, Number(state.invitationLimit || 10));
    const offset = Math.max(0, Number(state.invitationOffset || 0));
    const page = Math.floor(offset / limit) + 1;
    const pages = Math.max(1, Math.ceil(total / limit));
    if ($("profileInvitationPaginationSummary")) {
      $("profileInvitationPaginationSummary").textContent = profileText("invitationPageSummary", { page, pages, total });
    }
    if ($("profileInvitationPrevious")) $("profileInvitationPrevious").disabled = state.invitationLoading || offset <= 0;
    if ($("profileInvitationNext")) {
      $("profileInvitationNext").disabled = state.invitationLoading || !state.invitationNextOffset || offset + limit >= total;
    }
  }

  function renderInvitationWorkspace() {
    const code = invitationCode();
    const link = invitationLink();
    const shareText = invitationShareText(link);
    const enabled = state.invitation?.enabled !== false;
    if ($("profileInvitationAvailability")) $("profileInvitationAvailability").hidden = enabled;
    if ($("profileInvitationCode")) $("profileInvitationCode").value = code || "—";
    if ($("profileInvitationLink")) $("profileInvitationLink").value = shareText || "—";
    setProfileCopy($("profileInvitationCodeState"), code ? "generated" : "notGenerated");
    if ($("profileGenerateInvitation")) {
      $("profileGenerateInvitation").hidden = Boolean(code);
      $("profileGenerateInvitation").disabled = state.invitationLoading || !enabled;
    }
    if ($("profileCopyInvitationCode")) $("profileCopyInvitationCode").disabled = !enabled || !code;
    if ($("profileCopyInvitationLink")) $("profileCopyInvitationLink").disabled = !enabled || !link;
    renderInvitationRecords(state.invitation?.records || []);
    renderInvitationPagination();
    renderInvitationRules();
  }

  function renderProfileViewCopy(language = currentProfileLanguage()) {
    const invitationView = state.view === "invitation";
    setProfileCopy($("profileHeadingEyebrow"), invitationView ? "invitationProfileEyebrow" : "accountProfile", "textContent", {}, language);
    setProfileCopy($("profileHeadingTitle"), invitationView ? "invitationProfileTitle" : "personalProfile", "textContent", {}, language);
    setProfileCopy($("profileHeadingDescription"), invitationView ? "invitationProfileDescription" : "profileDescription", "textContent", {}, language);
    document.title = profileText(invitationView ? "invitationProfileTitle" : "pageTitle", {}, language);
  }

  async function setProfileView(view, { updateUrl = false } = {}) {
    const invitationView = !isAdminSession && view === "invitation";
    state.view = invitationView ? "invitation" : "profile";
    document.body.classList.toggle("is-invitation-view", invitationView);
    if ($("profileForm")) $("profileForm").hidden = invitationView;
    if ($("profileInvitationWorkspace")) $("profileInvitationWorkspace").hidden = !invitationView;
    renderProfileViewCopy();
    if (updateUrl) {
      const target = new URL(window.location.href);
      if (invitationView) target.searchParams.set("view", "invitation");
      else target.searchParams.delete("view");
      window.history.pushState({ profileView: state.view }, "", `${target.pathname}${target.search}${target.hash}`);
    }
    if (invitationView && !state.invitation) await loadInvitation();
  }

  async function loadInvitation({ force = false, offset = state.invitationOffset } = {}) {
    if (state.invitationLoading || (state.invitation && !force)) return state.invitation;
    state.invitationOffset = Math.max(0, Number(offset || 0));
    state.invitationLoading = true;
    setInvitationStatus();
    renderInvitationWorkspace();
    try {
      const query = new URLSearchParams({
        limit: String(state.invitationLimit),
        offset: String(state.invitationOffset),
      });
      state.invitation = normalizedInvitationPayload(await api(`/api/invitations/me?${query}`));
      state.invitationTotal = Math.max(0, Number(state.invitation?.total || 0));
      state.invitationOffset = Math.max(0, Number(state.invitation?.offset ?? state.invitationOffset));
      state.invitationLimit = Math.max(1, Number(state.invitation?.limit || state.invitationLimit));
      state.invitationNextOffset = Math.max(0, Number(state.invitation?.next_offset || 0));
      renderInvitationWorkspace();
      return state.invitation;
    } catch (error) {
      if (handleSessionBoundary(error)) return null;
      setInvitationStatus(error.message || profileText("invitationLoadFailed"), "error");
      return null;
    } finally {
      state.invitationLoading = false;
      renderInvitationWorkspace();
    }
  }

  async function generateInvitation() {
    if (state.invitationLoading) return;
    if (state.invitation?.enabled === false) {
      setInvitationStatusKey("invitationDisabled", "error");
      renderInvitationWorkspace();
      return;
    }
    state.invitationLoading = true;
    setInvitationStatus();
    renderInvitationWorkspace();
    try {
      const created = normalizedInvitationPayload(await api("/api/invitations/code", { method: "POST" }));
      state.invitation = {
        ...(state.invitation || {}),
        ...created,
        settings: Object.keys(created.settings || {}).length ? created.settings : (state.invitation?.settings || {}),
        records: created.records?.length ? created.records : (state.invitation?.records || []),
      };
      setInvitationStatusKey("invitationCreated", "success");
      renderInvitationWorkspace();
    } catch (error) {
      if (handleSessionBoundary(error)) return;
      setInvitationStatus(error.message || profileText("invitationLoadFailed"), "error");
    } finally {
      state.invitationLoading = false;
      renderInvitationWorkspace();
    }
  }

  async function copyInvitationValue(value, input) {
    if (state.invitation?.enabled === false) {
      setInvitationStatusKey("invitationDisabled", "error");
      return;
    }
    const text = String(value || "").trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setInvitationStatusKey("invitationCopied", "success");
    } catch (_) {
      input?.focus();
      input?.select();
      setInvitationStatusKey("invitationCopyFailed", "error");
    }
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
    if ($("profileInvitationEntry")) $("profileInvitationEntry").hidden = isAdminSession;
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
      window.VectoSiteNavigation?.announceAuthSessionChange?.("logout");
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
  $("profileInvitationEntry")?.addEventListener("click", (event) => {
    event.preventDefault();
    void setProfileView("invitation", { updateUrl: true });
  });
  $("profileInvitationBack")?.addEventListener("click", () => {
    void setProfileView("profile", { updateUrl: true });
  });
  $("profileGenerateInvitation")?.addEventListener("click", () => void generateInvitation());
  $("profileCopyInvitationCode")?.addEventListener("click", () => {
    void copyInvitationValue(invitationCode(), $("profileInvitationCode"));
  });
  $("profileCopyInvitationLink")?.addEventListener("click", () => {
    void copyInvitationValue(invitationShareText(), $("profileInvitationLink"));
  });
  $("profileInvitationPrevious")?.addEventListener("click", () => {
    void loadInvitation({ force: true, offset: Math.max(0, state.invitationOffset - state.invitationLimit) });
  });
  $("profileInvitationNext")?.addEventListener("click", () => {
    if (!state.invitationNextOffset) return;
    void loadInvitation({ force: true, offset: state.invitationNextOffset });
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
  window.addEventListener("popstate", () => {
    const requestedView = new URLSearchParams(window.location.search).get("view");
    void setProfileView(requestedView === "invitation" ? "invitation" : "profile");
  });
  window.VectoProfileI18n = {
    applyLanguage: applyProfileLanguage,
    currentLanguage: currentProfileLanguage,
    text: profileText,
  };
  applyProfileLanguage();
  void (async () => {
    await loadProfile();
    const requestedView = new URLSearchParams(window.location.search).get("view");
    await setProfileView(requestedView === "invitation" ? "invitation" : "profile");
  })();
})();
