const $ = (id) => document.getElementById(id);
const THEME_STORAGE_KEY = "wk-console-theme";

try {
  if (window.localStorage.getItem(THEME_STORAGE_KEY) === "dark") {
    document.documentElement.dataset.theme = "dark";
  }
} catch {}

const state = {
  view: "workspace",
  activeModule: "personas",
  workspaceMenuOpen: true,
  setupStatus: null,
  generationType: "text_to_image",
  personaGroup: "content",
  personaPanels: {
    content: "generate",
    settings: "profile",
    account: "binding",
    data: "queue",
  },
  personaAutomationPlatform: "threads",
  personaStrategySelection: {
    threads_comment_reply: "comment_recent_2d",
    threads_hot_reply: "hot_posts",
    threads_warmup: "tg_default",
  },
  preferredAccountId: "",
  simpleBranches: {},
  files: [],
  publishFiles: [],
  socialFiles: [],
  tasks: [],
  personas: [],
  personaProfiles: {},
  personaCollections: { groups: [], assigned_persona_ids: [] },
  personaListEditorId: "",
  personaNewGroupName: "",
  personaMemories: {},
  personaImageLibraries: {},
  personaDraftPosts: {},
  personaPublishHistories: {},
  personaPublishAccountIds: {},
  personaPublishResults: {},
  personaPublishWatchers: {},
  personaAutomationResults: {},
  personaAutomationWatchers: {},
  personaMediaTasks: {},
  personaForms: {},
  renderedPersonaId: "",
  personaCreateMode: false,
  personaLinkPresetId: "",
  selectedPersonaId: "",
  selectedPersonaPostId: "",
  socialAccounts: [],
  socialTasks: [],
  events: null,
  mediaPreviewGroups: {},
  mediaPreviewSeq: 0,
  mediaLightbox: {
    groupId: "",
    index: 0,
  },
};

window.__personaNewGroupName = window.__personaNewGroupName || "";

function runtimeConfigStatus() {
  return state.setupStatus?.runtime_config || {};
}

function personaGeneratePreflight() {
  const runtime = runtimeConfigStatus();
  const hasBaseUrl = Boolean(String(runtime.llm_base_url || "").trim());
  const hasApiKey = Boolean(runtime.llm_api_key_configured || runtime.llm_api_key_gpt_configured);
  const hasModel = Boolean(
    String(runtime.llm_model_priority_order || "").trim()
    || String(runtime.llm_default_model_gpt || "").trim()
    || String(runtime.llm_default_model || "").trim()
  );
  const issues = [];
  if (!hasBaseUrl) issues.push("未配置文本模型 API Base URL");
  if (!hasApiKey) issues.push("未配置文本模型 API Key");
  if (!hasModel) issues.push("未配置文本模型默认模型");
  return { ready: issues.length === 0, issues };
}

function resolvedPersonaGenerateBranch(profile, generateForm = {}) {
  const explicit = String(generateForm?.contentBranch || "").trim().toLowerCase();
  if (explicit === "r18") return "r18";
  if (explicit === "nonr18") return "nonr18";
  return profile?.is_workflow_persona ? "nonr18" : "nonr18";
}

function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function syncThemeToggle() {
  const button = $("themeToggle");
  if (!button) return;
  const isDark = currentTheme() === "dark";
  button.textContent = isDark ? "亮色" : "暗色";
  button.title = isDark ? "切换到亮色模式" : "切换到暗色模式";
  button.setAttribute("aria-pressed", isDark ? "true" : "false");
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  if (nextTheme === "dark") document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  } catch {}
  syncThemeToggle();
}

function toggleTheme() {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
}

function ensureThemeToggle() {
  const actions = document.querySelector(".topbar-actions");
  const refreshButton = $("refreshAll");
  if (!actions || !refreshButton) return null;
  let button = $("themeToggle");
  if (!button) {
    button = document.createElement("button");
    button.id = "themeToggle";
    button.type = "button";
    actions.insertBefore(button, refreshButton);
  }
  syncThemeToggle();
  return button;
}

const modules = [
  { id: "generation", label: "生成 / 编辑任务", hint: "文生图、图生图、修图、换脸、视频", callback: "后台自动提交" },
  { id: "personas", label: "我的人设", hint: "人设列表、详情、推文、设置", callback: "后台自动读取" },
  { id: "publishing", label: "发布与排程", hint: "立即发布、矩阵发布、定时、队列", callback: "后台自动排队" },
  { id: "automation", label: "指纹浏览器自动化", hint: "浏览器账号登录、检测、养号、回复", callback: "后台自动执行" },
];

const taskMeta = {
  text_to_image: { title: "文生图", minImages: 0, files: "无需文件，填写 Prompt 后直接生成图片。", callback: "后台自动提交" },
  image_generate: { title: "图片生成", minImages: 1, files: "单图参考上传 1 张图，双图参考上传 2 张图。", callback: "后台自动提交" },
  single_image_edit: { title: "单图编辑", minImages: 1, files: "上传 1 张原图，填写编辑指令。", callback: "后台自动提交" },
  get_nano_banana: { title: "图片编辑", minImages: 2, files: "上传 2 张图片：原图 + 参考图。", callback: "后台自动提交" },
  face_swap: { title: "人物换脸", minImages: 2, files: "上传 2 张图片：目标图 + 人脸参考图。", callback: "后台自动提交" },
  video_i2v: { title: "图生视频", minImages: 1, files: "上传 1 张首帧参考图，可选音频。", callback: "后台自动提交" },
  get_gemini: { title: "素材解析", minImages: 0, files: "发送图片或视频，并附上需要解析的问题。", callback: "后台自动提交" },
};

const personaGroups = {
  content: {
    label: "内容与发布",
    defaultStep: "generate",
  },
  settings: {
    label: "人设设置",
    defaultStep: "profile",
  },
  account: {
    label: "浏览器账号",
    defaultStep: "binding",
  },
  data: {
    label: "数据与队列",
    defaultStep: "queue",
  },
};

const moduleDefaultBranch = {
  publishing: "publish_post",
  automation: "open_login",
};

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "include", ...options });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { detail: text }; }
  if (!response.ok) throw data;
  return data;
}

function showMsg(id, text, ok = true) {
  const node = $(id);
  if (!node) return;
  node.textContent = text || "";
  node.className = `notice ${ok ? "ok" : "bad"}`;
}

function showMsgHtml(id, html, ok = true) {
  const node = $(id);
  if (!node) return;
  node.innerHTML = html || "";
  node.className = `notice ${ok ? "ok" : "bad"}`;
}

function closeConsoleModal(result) {
  const modal = $("consoleModal");
  if (!modal) return;
  const resolver = modal.__resolve;
  modal.remove();
  if (typeof resolver === "function") resolver(result);
}

function openConsoleModal({ title = "确认操作", message = "", inputLabel = "", inputValue = "", confirmText = "确定", cancelText = "取消", danger = false } = {}) {
  closeConsoleModal(null);
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.id = "consoleModal";
    modal.className = "console-modal";
    modal.__resolve = resolve;
    modal.innerHTML = `
      <div class="console-modal-backdrop" data-console-modal-cancel></div>
      <section class="console-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="consoleModalTitle">
        <div class="console-modal-head">
          <strong id="consoleModalTitle">${esc(title)}</strong>
        </div>
        ${message ? `<p>${esc(message)}</p>` : ""}
        ${inputLabel ? `
          <label>${esc(inputLabel)}
            <input id="consoleModalInput" value="${esc(inputValue)}" />
          </label>
        ` : ""}
        <div class="console-modal-actions">
          <button type="button" data-console-modal-cancel>${esc(cancelText)}</button>
          <button type="button" class="${danger ? "danger" : "primary"}" data-console-modal-confirm>${esc(confirmText)}</button>
        </div>
      </section>
    `;
    document.body.appendChild(modal);
    const input = $("consoleModalInput");
    if (input) {
      input.focus();
      input.select();
    } else {
      modal.querySelector("[data-console-modal-confirm]")?.focus();
    }
    modal.addEventListener("click", (event) => {
      if (event.target.closest("[data-console-modal-cancel]")) {
        closeConsoleModal(null);
      }
      if (event.target.closest("[data-console-modal-confirm]")) {
        closeConsoleModal(input ? input.value : true);
      }
    });
    modal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeConsoleModal(null);
      if (event.key === "Enter" && input) closeConsoleModal(input.value);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function numberText(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

function formatTime(value) {
  if (!value) return "-";
  const number = Number(value);
  const date = Number.isFinite(number) && number > 100000 ? new Date(number * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function timeValue(value) {
  if (value == null || value === "") return 0;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number > 100000 ? number * 1000 : number;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function fileKind(file) {
  const name = String(file?.name || "").toLowerCase();
  if (/\.(png|jpg|jpeg|webp|gif|bmp)$/.test(name)) return "image";
  if (/\.(mp4|mov|avi|mkv|webm)$/.test(name)) return "video";
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/.test(name)) return "audio";
  return "file";
}

function statusLabel(status) {
  const map = {
    queued: "排队中",
    running: "执行中",
    success: "成功",
    failed: "失败",
    cancelled: "已取消",
    need_manual: "需人工",
    pending_login: "待登录",
    ready: "可用",
    open_login: "打开登录",
    check_login: "检测登录",
    publish_post: "发布内容",
    threads_warmup: "Threads 养号",
    threads_auto_reply: "Threads 自动回复",
  };
  return map[String(status || "")] || String(status || "-");
}

function logStageLabel(stage, level) {
  const key = String(stage || level || "").trim();
  const map = {
    queued: "排队中",
    running: "执行中",
    success: "成功",
    failed: "失败",
    cancelled: "已取消",
    need_manual: "需人工处理",
    screenshot: "截图",
    completion_node: "完成节点",
    threads_auto_reply_open: "打开 Threads",
    threads_comment_reply_open: "打开目标帖子",
    threads_reply_button: "打开回复框",
    threads_reply_focus: "聚焦输入框",
    threads_reply_submit: "提交回复",
    threads_hot_post_open: "打开热点帖子",
    threads_hot_post_reply_button: "打开热点回复框",
    threads_hot_post_reply_focus: "聚焦热点输入框",
    threads_hot_post_reply_submit: "提交热点回复",
    threads_auto_reply_backfill: "补定位",
    open_login: "打开登录",
    check_login: "检查登录",
    publish_post: "发布内容",
    browse_feed: "浏览 Feed",
    browse_profile: "浏览主页",
    threads_warmup: "Threads 养号",
    threads_auto_reply: "Threads 自动回复",
    info: "日志",
    warn: "警告",
    error: "错误",
  };
  return map[key] || statusLabel(key) || "日志";
}

function currentModule() {
  return modules.find((item) => item.id === state.activeModule) || modules[0];
}

function selectedPersona() {
  return state.personas.find((item) => String(item.id) === String(state.selectedPersonaId)) || state.personas[0] || null;
}

function selectedPersonaProfile() {
  const persona = selectedPersona();
  if (!persona) return null;
  return state.personaProfiles[String(persona.id)] || null;
}

function personaDraftPosts(persona = selectedPersona()) {
  if (!persona) return [];
  return state.personaDraftPosts[String(persona.id)] || [];
}

function selectedPersonaPost(persona = selectedPersona()) {
  const posts = personaDraftPosts(persona);
  const wanted = String($("personaDraftPostSelect")?.value || state.selectedPersonaPostId || "").trim();
  if (wanted && posts.some((item) => String(item.id) === wanted)) {
    return posts.find((item) => String(item.id) === wanted) || null;
  }
  return posts[0] || null;
}

function sortPersonaDraftPosts(posts) {
  return [...(Array.isArray(posts) ? posts : [])].sort((left, right) => {
    const leftTime = Math.max(
      timeValue(left?.published_at),
      timeValue(left?.updated_at),
      timeValue(left?.created_at),
    );
    const rightTime = Math.max(
      timeValue(right?.published_at),
      timeValue(right?.updated_at),
      timeValue(right?.created_at),
    );
    if (rightTime !== leftTime) return rightTime - leftTime;
    return String(right?.id || "").localeCompare(String(left?.id || ""));
  });
}

function sortPersonaPublishHistory(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort((left, right) => {
    const leftTime = Math.max(
      timeValue(left?.published_at),
      timeValue(left?.captured_at),
      timeValue(left?.updated_at),
      timeValue(left?.created_at),
    );
    const rightTime = Math.max(
      timeValue(right?.published_at),
      timeValue(right?.captured_at),
      timeValue(right?.updated_at),
      timeValue(right?.created_at),
    );
    if (rightTime !== leftTime) return rightTime - leftTime;
    return String(right?.id || "").localeCompare(String(left?.id || ""));
  });
}

function personaDraftOptionLabel(post, index = 0) {
  const title = String(post?.title || "").trim() || `未命名草稿 ${index + 1}`;
  const stamp = formatTime(post?.published_at || post?.updated_at || post?.created_at);
  return `${title} · ${stamp}`;
}

function personaHiddenPublishHistoryCount(persona = selectedPersona()) {
  if (!persona) return 0;
  return Math.max(0, Number(persona?.counts?.published_hidden || 0));
}

function personaFormState(personaId) {
  const key = String(personaId || "").trim();
  if (!key) {
    return {
      generate: { mode: "ai", count: 3, targetWords: 120, contentBranch: "", textModelBranch: "", contentTimeSlot: "", prompt: "", selectedMemoryIds: [] },
      draft: { title: "", content: "" },
      media: { taskType: "text_to_image", prompt: "", aspectRatio: "1:1", resolution: "720p", duration: 2, replaceExisting: false },
      images: { prompt: "", aspectRatio: "1:1" },
    };
  }
  if (!state.personaForms[key]) {
    state.personaForms[key] = {
      generate: {
        mode: "ai",
        count: 3,
        targetWords: 120,
        contentBranch: "",
        textModelBranch: "",
        contentTimeSlot: "",
        prompt: "",
        selectedMemoryIds: [],
      },
      draft: {
        title: "",
        content: "",
      },
      media: {
        taskType: "text_to_image",
        prompt: "",
        aspectRatio: "1:1",
        resolution: "720p",
        duration: 2,
        replaceExisting: false,
      },
      images: {
        prompt: "",
        aspectRatio: "1:1",
      },
    };
  }
  return state.personaForms[key];
}

function snapshotPersonaCurrentForm() {
  const key = String(state.renderedPersonaId || "").trim();
  if (!key) return;
  const form = personaFormState(key);
  if ($("personaGenerateMode")) form.generate.mode = String($("personaGenerateMode")?.value || "ai");
  if ($("personaGenerateCount")) form.generate.count = Number($("personaGenerateCount")?.value || form.generate.count || 3);
  if ($("personaGenerateTargetWords")) form.generate.targetWords = Number($("personaGenerateTargetWords")?.value || form.generate.targetWords || 120);
  if ($("personaGeneratePaidEnabled")) form.generate.contentBranch = $("personaGeneratePaidEnabled")?.checked ? "r18" : "nonr18";
  if ($("personaGenerateModelBranch")) form.generate.textModelBranch = String($("personaGenerateModelBranch")?.value || "");
  if ($("personaGenerateTimeSlot")) form.generate.contentTimeSlot = String($("personaGenerateTimeSlot")?.value || "");
  if ($("personaGeneratePrompt")) form.generate.prompt = String($("personaGeneratePrompt")?.value || "");
  if (document.querySelector("[data-persona-memory-id]")) {
    form.generate.selectedMemoryIds = [...document.querySelectorAll("[data-persona-memory-id]:checked")]
      .map((node) => node.getAttribute("data-persona-memory-id") || "")
      .filter(Boolean);
  }
  if ($("personaDraftTitle")) form.draft.title = String($("personaDraftTitle")?.value || "");
  if ($("personaDraftContent")) form.draft.content = String($("personaDraftContent")?.value || "");
  if ($("personaMediaTaskPrompt")) form.media.prompt = String($("personaMediaTaskPrompt")?.value || "");
  if ($("personaMediaAspectRatio")) form.media.aspectRatio = String($("personaMediaAspectRatio")?.value || "1:1");
  if ($("personaMediaResolution")) form.media.resolution = String($("personaMediaResolution")?.value || "720p");
  if ($("personaMediaDuration")) form.media.duration = Number($("personaMediaDuration")?.value || form.media.duration || 2);
  if ($("personaMediaReplaceExisting")) form.media.replaceExisting = Boolean($("personaMediaReplaceExisting")?.checked);
  if ($("personaImagePrompt")) form.images.prompt = String($("personaImagePrompt")?.value || "");
  if ($("personaImageAspectRatio")) form.images.aspectRatio = String($("personaImageAspectRatio")?.value || "1:1");
}

function personaImageLibraryState(personaId) {
  return state.personaImageLibraries[String(personaId || "").trim()] || null;
}

function personaMediaTaskKey(personaId, postId) {
  return `${String(personaId || "").trim()}:${String(postId || "").trim()}`;
}

function personaMediaTaskState(personaId, postId) {
  return state.personaMediaTasks[personaMediaTaskKey(personaId, postId)] || null;
}

function fallbackPersonaProfile(persona) {
  const threads = persona?.threads_account || {};
  return {
    id: String(persona?.id || ""),
    name: String(persona?.name || ""),
    content: String(persona?.content || ""),
    threads_handle: String(threads.handle || ""),
    tweet_style_sample: "",
    tweet_style_profile: "",
    active_link_preset_id: "",
    link_presets: [],
    image_count: Number(persona?.counts?.images || 0),
    has_reference_images: Number(persona?.counts?.images || 0) > 0,
    is_workflow_persona: false,
    _fallback: true,
  };
}

function personaAccounts(persona, platform = "") {
  const personaId = String(persona?.id || "").trim();
  const currentPlatform = String(platform || "").trim().toLowerCase();
  return state.socialAccounts.filter((item) => {
    if (String(item.persona_id || "").trim() !== personaId) return false;
    if (!currentPlatform) return true;
    return String(item.platform || "").trim().toLowerCase() === currentPlatform;
  });
}

function accountForPersona(persona) {
  if (!persona) return null;
  return personaAccounts(persona)[0] || null;
}

function publishAccountForPersona(persona) {
  const accounts = uniqueAccountOptions(personaAccounts(persona).filter((account) => {
    const platform = String(account.platform || "").trim().toLowerCase();
    const status = String(account.status || "").trim().toLowerCase();
    return (platform === "threads" || platform === "instagram") && status === "ready";
  }));
  return accounts.find((account) => String(account.platform || "").trim().toLowerCase() === "threads")
    || accounts.find((account) => String(account.platform || "").trim().toLowerCase() === "instagram")
    || accounts[0]
    || null;
}

function publishAccountsForPersona(persona) {
  return uniqueAccountOptions(personaAccounts(persona).filter((account) => {
    const platform = String(account.platform || "").trim().toLowerCase();
    const status = String(account.status || "").trim().toLowerCase();
    return (platform === "threads" || platform === "instagram") && status === "ready";
  }));
}

function selectedPublishAccountForPersona(persona) {
  if (!persona) return null;
  const accounts = publishAccountsForPersona(persona);
  if (!accounts.length) return null;
  const personaId = String(persona.id || "");
  const selectedId = String($("personaPublishAccountSelect")?.value || state.personaPublishAccountIds[personaId] || "").trim();
  const selected = accounts.find((account) => String(account.id || "") === selectedId);
  if (selected) return selected;
  const fallback = publishAccountForPersona(persona);
  if (fallback) state.personaPublishAccountIds[personaId] = String(fallback.id || "");
  return fallback;
}

function publishPlatformLabel(account) {
  const platform = String(account?.platform || "").trim().toLowerCase();
  return platform === "threads" ? "Threads" : "Instagram";
}

function publishPlatformHint(account) {
  const platform = String(account?.platform || "").trim().toLowerCase();
  if (platform === "threads") return "当前走 Threads 浏览器发布，正文必填，素材可选。";
  return "当前走 Instagram 浏览器发布，至少需要上传一份媒体素材。";
}

function latestSuccessfulSocialTask(accountId, taskTypes) {
  const cleanAccountId = String(accountId || "").trim();
  const wanted = new Set((taskTypes || []).map((item) => String(item || "").trim()));
  if (!cleanAccountId || !wanted.size) return null;
  const tasks = (state.socialTasks || []).filter((task) =>
    String(task?.account_id || "").trim() === cleanAccountId
    && String(task?.status || "").trim() === "success"
    && wanted.has(String(task?.task_type || "").trim())
  );
  if (!tasks.length) return null;
  tasks.sort((a, b) => Number(b.finished_at || b.updated_at || b.created_at || 0) - Number(a.finished_at || a.updated_at || a.created_at || 0));
  return tasks[0] || null;
}

function personaPublishPreflight(account) {
  const accountId = String(account?.id || "").trim();
  return {
    login: latestSuccessfulSocialTask(accountId, ["check_login", "open_login"]),
    warmup: latestSuccessfulSocialTask(accountId, ["threads_warmup"]),
    reply: latestSuccessfulSocialTask(accountId, ["threads_auto_reply"]),
  };
}

function personaPublishPreflightRows(account) {
  const platform = String(account?.platform || "").trim().toLowerCase();
  const preflight = personaPublishPreflight(account);
  const rows = [
    {
      label: "登录检查",
      ok: Boolean(preflight.login),
      text: preflight.login
        ? `最近成功：${formatTime(preflight.login.finished_at || preflight.login.updated_at || preflight.login.created_at)}`
        : "未找到成功记录。发布前必须先执行一次登录检查。",
    },
  ];
  if (platform === "threads") {
    rows.push(
      {
        label: "最近养号",
        ok: Boolean(preflight.warmup),
        text: preflight.warmup
          ? `最近成功：${formatTime(preflight.warmup.finished_at || preflight.warmup.updated_at || preflight.warmup.created_at)}`
          : "未找到成功记录，建议发布前先跑一次养号。",
      },
      {
        label: "最近回复",
        ok: Boolean(preflight.reply),
        text: preflight.reply
          ? `最近成功：${formatTime(preflight.reply.finished_at || preflight.reply.updated_at || preflight.reply.created_at)}`
          : "未找到成功记录，建议发布前先跑一次自动回复。",
      },
    );
  }
  return rows;
}

function renderPersonaPublishPreflight(account) {
  if (!account) return "";
  const rows = personaPublishPreflightRows(account);
  return `
    <div class="compact-list">
      ${rows.map((row) => `
        <article class="compact-row compact-row-log">
          <strong>${esc(row.label)}</strong>
          <p>${esc(row.text)}</p>
          <span>${row.ok ? "已就绪" : "待处理"}</span>
        </article>`).join("")}
    </div>
  `;
}

function uniqueAccountOptions(accounts) {
  const seen = new Set();
  return (accounts || []).filter((account) => {
    const username = String(account.username || account.account_username || "").trim().toLowerCase();
    const key = [
      String(account.platform || ""),
      username || String(account.id || "").trim().toLowerCase(),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function personaBindingLabel(persona) {
  const account = accountForPersona(persona);
  const handle = String(persona?.threads_account?.handle || "").trim();
  const profileName = String(account?.username || account?.account_username || "").trim();
  if (handle) return `Threads 主页 · ${handle}`;
  if (profileName) return `执行账号 · ${profileName}`;
  return "未绑定";
}

function personaExecutionAccountLabel(persona) {
  const account = accountForPersona(persona);
  const profileName = String(account?.username || account?.account_username || "").trim();
  const handle = String(persona?.threads_account?.handle || "").trim();
  return profileName || handle || "未绑定执行账号";
}

function currentPersonaGroupStep(groupKey, profile) {
  const options = personaGroupStepOptions(groupKey, profile);
  const current = state.personaPanels[groupKey] || personaGroups[groupKey]?.defaultStep || options[0]?.[0] || "";
  if (options.some(([value]) => value === current)) return current;
  return options[0]?.[0] || "";
}

function setPersonaGroupStep(groupKey, step, profile) {
  const next = currentPersonaGroupStep(groupKey, profile);
  if (!step) {
    state.personaPanels[groupKey] = next;
    return next;
  }
  const options = personaGroupStepOptions(groupKey, profile);
  state.personaPanels[groupKey] = options.some(([value]) => value === step) ? step : next;
  return state.personaPanels[groupKey];
}

function personaGroupStepLabel(groupKey, step, profile) {
  const pair = personaGroupStepOptions(groupKey, profile).find(([value]) => value === step);
  return pair ? pair[1] : "-";
}

function selectedPersonaAutomationPlatform() {
  const value = String($("personaAutoPlatform")?.value || state.personaAutomationPlatform || "threads").trim().toLowerCase();
  return value === "instagram" ? "instagram" : "threads";
}

function personaAutomationAccounts(persona, platform = "") {
  return personaAccounts(persona, platform || selectedPersonaAutomationPlatform());
}

function selectedPersonaAutomationAccount(persona, platform = selectedPersonaAutomationPlatform()) {
  const accounts = personaAutomationAccounts(persona, platform);
  const currentId = String($("personaAutoAccount")?.value || state.preferredAccountId || "").trim();
  if (currentId && accounts.some((item) => String(item.id) === currentId)) {
    return accounts.find((item) => String(item.id) === currentId) || null;
  }
  return accounts[0] || null;
}

var PERSONA_THREADS_STRATEGIES = {
  threads_comment_reply: [
    { id: "comment_recent_2d", label: "评论回复：最近 2 天", payload: { strategy_id: "comment_recent_2d", max_posts: 5, max_replies: 3, max_age_days: 2, reply_scope: "comments" } },
    { id: "comment_recent_7d", label: "评论回复：最近 7 天", payload: { strategy_id: "comment_recent_7d", max_posts: 5, max_replies: 3, max_age_days: 7, reply_scope: "comments" } },
    { id: "comment_custom", label: "自定义评论回复", payload: { strategy_id: "comment_custom", max_posts: 5, max_replies: 3, max_age_days: 2, reply_scope: "comments" } },
  ],
  threads_hot_reply: [
    { id: "hot_posts", label: "热点推文：默认", payload: { strategy_id: "hot_posts", max_posts: 5, max_replies: 3, max_age_days: 30, min_views: 0, reply_scope: "hot_posts" } },
    { id: "hot_recent_7d", label: "热点推文：最近 7 天", payload: { strategy_id: "hot_recent_7d", max_posts: 5, max_replies: 3, max_age_days: 7, min_views: 0, reply_scope: "hot_posts" } },
    { id: "hot_views_1000", label: "热点推文：浏览 1000+", payload: { strategy_id: "hot_views_1000", max_posts: 5, max_replies: 3, max_age_days: 30, min_views: 1000, reply_scope: "hot_posts" } },
    { id: "hot_custom", label: "自定义热点回复", payload: { strategy_id: "hot_custom", max_posts: 5, max_replies: 3, max_age_days: 30, min_views: 0, reply_scope: "hot_posts" } },
  ],
  threads_warmup: [
    { id: "tg_default", label: "默认养号", payload: { strategy_id: "tg_default", browse_limit: 30, scroll_times: 30, like_limit: 16, max_comments: 0, comment_chance: 0 } },
    { id: "browse_only", label: "保守养号：只浏览", payload: { strategy_id: "browse_only", browse_limit: 30, scroll_times: 30, like_limit: 0, max_comments: 0, comment_chance: 0 } },
    { id: "like_comment", label: "互动养号：点赞 + 留言", payload: { strategy_id: "like_comment", browse_limit: 30, scroll_times: 30, like_limit: 16, max_comments: 8, comment_chance: 100 } },
    { id: "warmup_custom", label: "自定义养号", payload: { strategy_id: "warmup_custom", browse_limit: 30, scroll_times: 30, like_limit: 0, max_comments: 0, comment_chance: 0 } },
  ],
};
globalThis.PERSONA_THREADS_STRATEGIES = PERSONA_THREADS_STRATEGIES;

function selectedPersonaStrategyId(group) {
  return state.personaStrategySelection[group] || (PERSONA_THREADS_STRATEGIES[group]?.[0]?.id || "");
}

function setPersonaStrategyId(group, id) {
  const options = PERSONA_THREADS_STRATEGIES[group] || [];
  const next = options.some((item) => item.id === id) ? id : (options[0]?.id || "");
  state.personaStrategySelection[group] = next;
  return next;
}

function personaThreadsStrategy(group) {
  const selectedId = selectedPersonaStrategyId(group);
  const options = PERSONA_THREADS_STRATEGIES[group] || [];
  return options.find((item) => item.id === selectedId) || options[0] || null;
}

function personaThreadsStrategyOptionsHtml(group) {
  const selectedId = selectedPersonaStrategyId(group);
  return (PERSONA_THREADS_STRATEGIES[group] || []).map((item) => (
    `<option value="${esc(item.id)}" ${item.id === selectedId ? "selected" : ""}>${esc(item.label)}</option>`
  )).join("");
}

function personaThreadsStrategyIsCustom(group) {
  return String(selectedPersonaStrategyId(group)).endsWith("_custom");
}

function personaThreadsStrategyDetail(group) {
  const persona = selectedPersona();
  const strategy = personaThreadsStrategy(group);
  if (!strategy || !persona) return "";
  return `
    <div class="form-grid">
      <div class="persona-inline-panel">
        <p>${esc(persona.content || "暂无人设描述。")}</p>
      </div>
      <div class="persona-inline-panel">
        <p>帖子 ${numberText(persona.counts?.posts)} · 已发布 ${numberText(persona.counts?.published)} · 素材图 ${numberText(persona.counts?.images)}</p>
        <p>这里会按当前人设、账号和策略生成执行任务。</p>
      </div>
    </div>`;
}

function setView(view) {
  state.view = view;
  if (view !== "workspace") state.workspaceMenuOpen = false;
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  document.querySelectorAll("[data-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === view));
  const titles = {
    workspace: "任务工作台",
    tasks: "任务队列",
    social: "浏览器发布",
    accounts: "执行账号管理",
    settings: "系统状态",
  };
  $("viewTitle").textContent = titles[view] || "控制台";
  updateWorkspaceFlow();
  if (view === "tasks") loadTasks();
  if (view === "social" || view === "accounts" || view === "settings") loadSocial();
}

function updateWorkspaceFlow() {
  const flow = $("workspaceFlow");
  const button = document.querySelector('[data-view="workspace"]');
  if (!flow || !button) return;
  const open = state.workspaceMenuOpen && state.view === "workspace";
  flow.classList.toggle("is-open", open);
  button.setAttribute("aria-expanded", open ? "true" : "false");
}

function renderModuleMenu() {
  updateWorkspaceFlow();
  $("moduleMenu").innerHTML = `<div class="module-accordion">${modules.map((item) => {
    const isActive = item.id === state.activeModule;
    return `
      <div class="module-accordion-item">
        <button type="button" class="module-trigger ${isActive ? "is-active" : ""}" data-module="${esc(item.id)}">
          <span class="module-trigger-text">
            <span>${esc(item.label)}</span>
            <small>${esc(item.hint)}</small>
          </span>
        </button>
      </div>
    `;
  }).join("")}</div>`;
}

function syncModuleMenuState() {
  updateWorkspaceFlow();
  document.querySelectorAll("[data-module]").forEach((button) => {
    const moduleId = button.dataset.module;
    const isActive = moduleId === state.activeModule;
    button.classList.toggle("is-active", isActive);
  });
}

function setMenuClickHighlight(button, leaveScope = button) {
  if (!button) return;
  document.querySelectorAll(".is-click-highlight").forEach((node) => {
    if (node !== button) node.classList.remove("is-click-highlight");
  });
  button.classList.add("is-click-highlight");
  const clear = () => {
    button.classList.remove("is-click-highlight");
    leaveScope.removeEventListener("mouseleave", clear);
  };
  leaveScope.addEventListener("mouseleave", clear, { once: true });
}

function setModule(moduleId) {
  state.activeModule = moduleId;
  renderWorkspace();
}

function selectedBranch(moduleId) {
  if (moduleId === "generation") return state.generationType;
  if (moduleId === "personas") return state.personaGroup;
  return state.simpleBranches[moduleId] || moduleDefaultBranch[moduleId] || "";
}

function renderWorkspace(renderMenu = true) {
  const module = currentModule();
  closePersonaMediaLightbox();
  resetMediaPreviewGroups();
  if (renderMenu) renderModuleMenu();
  else syncModuleMenuState();
  $("moduleTitle").textContent = module.label;
  $("moduleEyebrow").textContent = module.id === "personas" ? "人设流程" : "Web 流程";
  $("moduleCallback").textContent = "";
  $("moduleCallback").style.display = "none";
  if (module.id === "generation") renderGenerationModule();
  else if (module.id === "personas") renderPersonaModule();
  else renderSimpleFlowModule(module.id);
  renderConfirmSummary();
}

function renderGenerationModule() {
  $("moduleBody").innerHTML = `
    <div class="form-grid persona-module-controls">
      <label>任务类型
        <select id="taskType">
          <option value="text_to_image">文生图</option>
          <option value="image_generate">图片生成</option>
          <option value="single_image_edit">单图编辑</option>
          <option value="get_nano_banana">图片编辑</option>
          <option value="face_swap">人物换脸</option>
          <option value="video_i2v">图生视频</option>
          <option value="get_gemini">素材解析</option>
        </select>
      </label>
      <label>完成后分支
        <select id="taskBranch">
          <option value="new">新建任务</option>
          <option value="toolr18_task_r18_text_to_image_reroll">重新生成图片</option>
          <option value="toolr18_task_r18_text_to_image_continue">继续生成图片</option>
          <option value="r18_image_edit_continue">继续编辑结果图</option>
          <option value="r18_rerun_latest">重跑最近任务</option>
        </select>
      </label>
      <label>提示词模式
        <select id="promptMode">
          <option value="grok">Grok 改写并预览</option>
          <option value="custom">输入自定义提示词</option>
          <option value="free">AI 自由发挥</option>
        </select>
      </label>
      <label data-generation-field="ratio">图像比例
        <select id="taskAspectRatio">
          <option value="auto">自动</option><option value="1:1">1:1</option><option value="3:4">3:4</option>
          <option value="4:3">4:3</option><option value="9:16">9:16</option><option value="16:9">16:9</option>
        </select>
      </label>
      <label data-generation-field="mode">参考模式
        <select id="taskMode">
          <option value="single_reference">单图参考</option>
          <option value="dual_reference">双图参考</option>
        </select>
      </label>
      <label data-generation-field="video">清晰度
        <select id="taskResolution"><option value="720p">720p</option><option value="1080p">1080p</option></select>
      </label>
      <label data-generation-field="video">时长
        <input id="taskDuration" type="number" min="2" max="15" value="2" />
      </label>
      <label data-generation-field="qa">文生图 QA
        <select id="taskQa"><option value="on">开启自动 QA</option><option value="off">关闭自动 QA</option></select>
      </label>
      <label data-generation-field="highres">最终分辨率
        <select id="taskFinalResolution"><option value="on">开启最终高清</option><option value="off">关闭最终高清</option></select>
      </label>
      <label data-generation-field="lora">人设 LoRA
        <select id="taskPersonaLora"><option value="off">不使用人设 LoRA</option><option value="auto">自动选择人设 LoRA</option></select>
      </label>
      <label data-generation-field="video">图生视频音频
        <select id="taskAudioMode"><option value="skip">跳过音频</option><option value="upload">上传音频</option><option value="keep">沿用已有音频</option></select>
      </label>
    </div>
    <label>Prompt / 指令</label>
    <textarea id="taskPrompt" rows="7" placeholder="填写任务指令，Web 会按当前类型提交到已有后台。"></textarea>
    <label data-generation-field="video">负面提示词</label>
    <input id="taskNegativePrompt" data-generation-field="video" placeholder="可选，用于图生视频或远程工作流" />
    <div class="upload-zone" id="uploadZone">
      <input id="taskFiles" type="file" multiple hidden />
      <div><strong>拖拽或点击上传素材</strong><p id="uploadHint"></p></div>
    </div>
    <div class="file-strip" id="fileStrip"></div>
    <div class="flow-box" id="generationBrief"></div>
    <div class="command-actions">
      <button id="submitTask" type="button" class="primary">确认执行</button>
      <button id="clearCommand" type="button">清空</button>
    </div>
  `;
  $("taskType").value = state.generationType;
  bindGenerationEvents();
  updateGenerationFields();
  renderFiles();
}

function bindGenerationEvents() {
  $("taskType").addEventListener("change", () => {
    state.generationType = $("taskType").value;
    updateGenerationFields();
    renderConfirmSummary();
  });
  ["taskBranch", "promptMode", "taskAspectRatio", "taskQa", "taskFinalResolution", "taskPersonaLora", "taskMode", "taskResolution", "taskDuration"].forEach((id) => {
    const node = $(id);
    if (node) node.addEventListener("change", renderConfirmSummary);
  });
  $("taskPrompt").addEventListener("input", renderConfirmSummary);
  $("uploadZone").addEventListener("click", () => $("taskFiles").click());
  $("uploadZone").addEventListener("dragover", (event) => { event.preventDefault(); $("uploadZone").classList.add("dragging"); });
  $("uploadZone").addEventListener("dragleave", () => $("uploadZone").classList.remove("dragging"));
  $("uploadZone").addEventListener("drop", (event) => {
    event.preventDefault();
    $("uploadZone").classList.remove("dragging");
    addFiles(event.dataTransfer.files);
  });
  $("taskFiles").addEventListener("change", (event) => addFiles(event.target.files));
  $("fileStrip").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-file]");
    if (!button) return;
    state.files.splice(Number(button.dataset.removeFile), 1);
    renderFiles();
  });
  $("submitTask").addEventListener("click", () => submitGenerationTask().catch((error) => showMsg("commandMsg", error.detail || error.message || "提交失败", false)));
  $("clearCommand").addEventListener("click", () => {
    state.files = [];
    $("taskPrompt").value = "";
    $("taskNegativePrompt").value = "";
    renderFiles();
    renderConfirmSummary();
  });
}

function updateGenerationFields() {
  const type = $("taskType").value;
  const show = (selector, visible) => document.querySelectorAll(selector).forEach((node) => { node.style.display = visible ? "" : "none"; });
  show('[data-generation-field="mode"]', type === "image_generate");
  show('[data-generation-field="video"]', type === "video_i2v");
  show('[data-generation-field="ratio"]', ["text_to_image", "image_generate"].includes(type));
  show('[data-generation-field="qa"]', type === "text_to_image");
  show('[data-generation-field="highres"]', ["text_to_image", "image_generate"].includes(type));
  show('[data-generation-field="lora"]', ["text_to_image", "image_generate"].includes(type));
  const meta = taskMeta[type] || taskMeta.text_to_image;
  $("uploadHint").textContent = meta.files;
  $("generationBrief").innerHTML = `<span>执行方式</span><strong>${esc(meta.callback)}</strong><span>${esc(meta.files)}</span>`;
}

function renderPersonaGroupPanel(groupKey, step, persona, account, profile) {
  if (groupKey === "content") return renderPersonaContentPanel(persona, account, profile, step);
  if (groupKey === "settings") return renderPersonaSettingsPanelV2(persona, account, profile, step);
  if (groupKey === "account") return renderPersonaAccountPanel(persona, account, profile, step);
  return renderPersonaDataPanel(persona, profile, step);
}

function personaHistoryRows(persona, limit = 8) {
  const rows = personaPublishHistoryRows(persona);
  return rows.slice(0, limit);
}

function renderPersonaHistoryRows(rows, { hiddenCount = 0 } = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    return `<div class="empty-state">${hiddenCount > 0 ? `当前还没有正式发布历史；已过滤 ${hiddenCount} 条登录或预检记录。` : "当前还没有发布历史。"}</div>`;
  }
  return `<div class="compact-list">${rows.map((row) => {
    const action = String(
      row.title
      || statusLabel(row.automation_task_type || row.task_type || row.taskType || "")
      || row.platform
      || "发布记录"
    ).trim();
    const content = String(row.content || row.caption || row.text || row.reply_text || row.source_url || "").trim();
    const platform = String(row.platform || row.publishPlatform || "").trim();
    const status = String(row.status || "").trim();
    const publishedUrl = String(row.source_url || row.published_url || row.url || row.post_url || "").trim();
    const historyMedia = personaHistoryMediaItems(row);
    const time = row.published_at || row.finished_at || row.updated_at || row.created_at || "";
    const meta = [platform, status ? statusLabel(status) : "", formatTime(time)].filter(Boolean).join(" · ");
    return `
      <article class="compact-row">
        <strong>${esc(action || "发布记录")}</strong>
        <p>${esc(content || "该记录没有正文或链接摘要。")}</p>
        ${renderPersonaMediaPreview(historyMedia, { compact: true })}
        <span>${esc(meta)}</span>
        ${publishedUrl ? `<div class="row-actions">
          ${publishedUrl ? `<a href="${esc(publishedUrl)}" target="_blank" rel="noopener">查看来源</a>` : ""}
        </div>` : ""}
      </article>`;
  }).join("")}</div>`;
}

function directMediaPreviewUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\/api\/persona_dashboard\/personas\/[^/]+\/(?:posts|publish_history)\/[^/]+\/media\/\d+$/i.test(text)) {
    return "";
  }
  if (/^\/api\/persona_dashboard\/automation\/screenshots\/screenshot\?/i.test(text)) {
    return "";
  }
  if (/^(?:https?:)?\/\//i.test(text)) return text;
  if (/^(?:data:|blob:|\/api\/)/i.test(text)) return text;
  return "";
}

function legacyMediaPreviewReason(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/armcloud\.net\/api\/agent\/pad\/screenshot/i.test(text) || /\/api\/agent\/pad\/screenshot\?/i.test(text)) {
    return "历史云机截图链接已失效";
  }
  return "";
}

function guessMediaType(value, fallback = "") {
  const text = String(value || "").trim().toLowerCase();
  const typ = String(fallback || "").trim().toLowerCase();
  if (typ === "video" || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(text)) return "video";
  if (typ === "audio" || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(text)) return "audio";
  return "image";
}

function mediaKindLabel(type) {
  if (type === "video") return "视频";
  if (type === "audio") return "音频";
  return "图片";
}

function resetMediaPreviewGroups() {
  state.mediaPreviewGroups = {};
  state.mediaPreviewSeq = 0;
}

function registerMediaPreviewGroup(items) {
  const rows = Array.isArray(items)
    ? items.filter((item) => item && item.previewUrl && !item.unavailable)
    : [];
  if (!rows.length) return "";
  const keys = Object.keys(state.mediaPreviewGroups || {});
  if (keys.length >= 160) {
    for (const key of keys.slice(0, keys.length - 120)) {
      delete state.mediaPreviewGroups[key];
    }
  }
  const id = `media-group-${++state.mediaPreviewSeq}`;
  state.mediaPreviewGroups[id] = rows.map((item) => ({
    previewUrl: String(item.previewUrl || "").trim(),
    type: String(item.type || "image").trim() || "image",
    label: String(item.label || "").trim(),
  }));
  return id;
}

function renderMediaPreviewButton(item, groupId, index, {
  className = "persona-media-card",
  frameClass = "persona-media-frame",
  caption = "",
} = {}) {
  const label = String(item?.label || "").trim();
  const type = String(item?.type || "image").trim() || "image";
  const text = caption || mediaKindLabel(type);
  return `
    <button
      type="button"
      class="${esc(className)}"
      data-media-preview-group="${esc(groupId)}"
      data-media-preview-index="${esc(index)}"
      data-media-preview-type="${esc(type)}"
      data-media-preview-label="${esc(label || text)}">
      ${type === "video"
        ? `<video class="${esc(frameClass)}" src="${esc(item.previewUrl)}" muted playsinline preload="metadata" onerror="handlePersonaMediaFrameError(this)"></video>`
        : type === "audio"
          ? `<div class="${esc(frameClass)} ${esc(frameClass)}--audio"><strong>音频</strong><small>点击站内预览</small></div>`
          : `<img class="${esc(frameClass)}" src="${esc(item.previewUrl)}" alt="${esc(label || "media")}" loading="lazy" onerror="handlePersonaMediaFrameError(this)" />`}
      <span>${esc(text)}</span>
    </button>
  `;
}

function personaDraftMediaItems(personaId, post = {}) {
  const baseItems = Array.isArray(post.media_items) && post.media_items.length
    ? post.media_items
    : (() => {
      const fallbackUrl = String(post.media_url || "").trim();
      const screenshotUrl = String(post.screenshot_url || "").trim();
      const fallbackReason = legacyMediaPreviewReason(fallbackUrl);
      const screenshotReason = legacyMediaPreviewReason(screenshotUrl);
      if (fallbackUrl && directMediaPreviewUrl(fallbackUrl)) {
        return [{ url: fallbackUrl, type: post.media_type || "", label: post.media_type || "media", preview_url: fallbackUrl }];
      }
      if (fallbackUrl) {
        return [{ url: fallbackUrl, type: post.media_type || "", label: post.media_type || "media", unavailable: true, reason: fallbackReason || "原始媒体文件不存在" }];
      }
      if (screenshotUrl && directMediaPreviewUrl(screenshotUrl)) {
        return [{ url: screenshotUrl, type: "image", label: "screenshot", preview_url: screenshotUrl }];
      }
      if (screenshotUrl) {
        return [{ url: screenshotUrl, type: "image", label: "screenshot", unavailable: true, reason: screenshotReason || "截图文件不存在" }];
      }
      return [];
    })();
  const items = baseItems.map((item, index) => {
    const url = String(item?.url || "").trim();
    if (!url) return null;
    if (item?.unavailable) {
      return {
        url,
        previewUrl: "",
        type: guessMediaType(url, item?.type || post.media_type || ""),
        label: String(item?.label || item?.type || "").trim(),
        unavailable: true,
        reason: String(item?.reason || "").trim() || "原始媒体文件不存在",
      };
    }
    const previewUrl = String(item?.preview_url || "").trim()
      || directMediaPreviewUrl(url)
      || `/api/persona_dashboard/personas/${encodeURIComponent(personaId)}/posts/${encodeURIComponent(post.id || "")}/media/${index}`;
    const reason = legacyMediaPreviewReason(url);
    if (!previewUrl || reason) {
      return {
        url,
        previewUrl: "",
        type: guessMediaType(url, item?.type || post.media_type || ""),
        label: String(item?.label || item?.type || "").trim(),
        unavailable: true,
        reason: reason || "原始媒体文件不存在",
      };
    }
    return {
      url,
      previewUrl,
      type: guessMediaType(url, item?.type || post.media_type || ""),
      label: String(item?.label || item?.type || "").trim(),
    };
  }).filter(Boolean);
  if (post.screenshot_url && !items.some((item) => item.previewUrl === post.screenshot_url || item.url === post.screenshot_url)) {
    const screenshotUrl = String(post.screenshot_url).trim();
    const reason = legacyMediaPreviewReason(screenshotUrl);
    items.push({
      url: screenshotUrl,
      previewUrl: reason ? "" : screenshotUrl,
      type: "image",
      label: "screenshot",
      unavailable: Boolean(reason),
      reason,
    });
  }
  return items;
}

function personaHistoryMediaItems(row = {}) {
  const items = [];
  const baseItems = Array.isArray(row.media_items) ? row.media_items : [];
  baseItems.forEach((item) => {
    const url = String(item?.url || "").trim();
    const previewUrl = String(item?.preview_url || "").trim() || directMediaPreviewUrl(url);
    if (!url) return;
    const reason = legacyMediaPreviewReason(url);
    items.push({
      url,
      previewUrl: reason ? "" : previewUrl,
      type: guessMediaType(url, item?.type || ""),
      label: String(item?.label || item?.type || "").trim(),
      unavailable: Boolean(reason || !previewUrl),
      reason: reason || (!previewUrl ? "媒体链接已失效" : ""),
    });
  });
  const screenshotUrl = String(row.screenshot_url || "").trim();
  if (screenshotUrl && !items.some((item) => item.previewUrl === screenshotUrl || item.url === screenshotUrl)) {
    const reason = legacyMediaPreviewReason(screenshotUrl);
    items.push({
      url: screenshotUrl,
      previewUrl: reason ? "" : screenshotUrl,
      type: "image",
      label: "screenshot",
      unavailable: Boolean(reason),
      reason,
    });
  }
  return items;
}

function renderPersonaMediaPreview(items, { compact = false } = {}) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return "";
  const visibleRows = rows.slice(0, compact ? 3 : 6);
  const groupId = registerMediaPreviewGroup(rows);
  let previewIndex = 0;
  return `<div class="persona-media-grid ${compact ? "is-compact" : ""}">${visibleRows.map((item) => `
    ${item.unavailable || !item.previewUrl ? `
      <div class="persona-media-card is-unavailable">
        <div class="persona-media-frame persona-media-frame--empty">
          <strong>媒体不可预览</strong>
          <small>${esc(item.reason || "原始文件已失效")}</small>
        </div>
        <span>${esc(mediaKindLabel(item.type))}</span>
      </div>
    ` : `
      ${renderMediaPreviewButton(item, groupId, previewIndex++, { className: "persona-media-card", frameClass: "persona-media-frame" })}
    `}
  `).join("")}</div>`;
}

function ensurePersonaMediaLightbox() {
  let node = $("personaMediaLightbox");
  if (node) return node;
  node = document.createElement("div");
  node.id = "personaMediaLightbox";
  node.className = "persona-media-lightbox";
  node.hidden = true;
  node.innerHTML = `
    <div class="persona-media-lightbox-backdrop" data-media-lightbox-close></div>
    <div class="persona-media-lightbox-dialog" role="dialog" aria-modal="true" aria-label="媒体预览">
      <button type="button" class="persona-media-lightbox-close" data-media-lightbox-close aria-label="关闭预览">关闭</button>
      <div class="persona-media-lightbox-meta">
        <strong id="personaMediaLightboxTitle">媒体预览</strong>
        <span id="personaMediaLightboxCounter"></span>
      </div>
      <div class="persona-media-lightbox-body" id="personaMediaLightboxBody"></div>
      <div class="persona-media-lightbox-actions">
        <button type="button" id="personaMediaPrev" data-media-lightbox-prev>上一张</button>
        <button type="button" id="personaMediaNext" data-media-lightbox-next>下一张</button>
      </div>
    </div>
  `;
  document.body.appendChild(node);
  node.addEventListener("click", (event) => {
    if (event.target.closest("[data-media-lightbox-close]")) closePersonaMediaLightbox();
    if (event.target.closest("[data-media-lightbox-prev]")) movePersonaMediaLightbox(-1);
    if (event.target.closest("[data-media-lightbox-next]")) movePersonaMediaLightbox(1);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !node.hidden) closePersonaMediaLightbox();
  });
  return node;
}

function closePersonaMediaLightbox() {
  const node = $("personaMediaLightbox");
  if (!node) return;
  node.hidden = true;
  const body = $("personaMediaLightboxBody");
  if (body) body.innerHTML = "";
  state.mediaLightbox.groupId = "";
  state.mediaLightbox.index = 0;
}

function syncPersonaMediaLightboxNav(total, index) {
  const counter = $("personaMediaLightboxCounter");
  const prev = $("personaMediaPrev");
  const next = $("personaMediaNext");
  if (counter) counter.textContent = total > 1 ? `${index + 1} / ${total}` : "";
  if (prev) prev.disabled = total <= 1 || index <= 0;
  if (next) next.disabled = total <= 1 || index >= total - 1;
}

function renderPersonaMediaLightboxCurrent() {
  const groupId = String(state.mediaLightbox.groupId || "");
  const index = Number(state.mediaLightbox.index || 0);
  const items = state.mediaPreviewGroups[groupId] || [];
  const item = items[index];
  if (!item?.previewUrl) {
    closePersonaMediaLightbox();
    return;
  }
  const node = ensurePersonaMediaLightbox();
  const title = $("personaMediaLightboxTitle");
  const body = $("personaMediaLightboxBody");
  if (!body) return;
  if (title) title.textContent = item.label || `${mediaKindLabel(item.type)}预览`;
  body.innerHTML = item.type === "video"
    ? `<video class="persona-media-lightbox-frame" src="${esc(item.previewUrl)}" controls autoplay playsinline preload="metadata" onerror="handlePersonaMediaLightboxError(this, '视频加载失败，原始文件可能已失效。')"></video>`
    : item.type === "audio"
      ? `<audio class="persona-media-lightbox-audio" src="${esc(item.previewUrl)}" controls autoplay onerror="handlePersonaMediaLightboxError(this, '音频加载失败，原始文件可能已失效。')"></audio>`
      : `<img class="persona-media-lightbox-frame" src="${esc(item.previewUrl)}" alt="${esc(item.label || "媒体预览")}" onerror="handlePersonaMediaLightboxError(this, '图片加载失败，原始文件可能已失效。')" />`;
  syncPersonaMediaLightboxNav(items.length, index);
  node.hidden = false;
}

function openPersonaMediaLightbox(groupId, index = 0) {
  const items = state.mediaPreviewGroups[String(groupId || "")] || [];
  if (!items.length) return;
  state.mediaLightbox.groupId = String(groupId || "");
  state.mediaLightbox.index = Math.max(0, Math.min(Number(index || 0), items.length - 1));
  renderPersonaMediaLightboxCurrent();
}

function movePersonaMediaLightbox(step) {
  const groupId = String(state.mediaLightbox.groupId || "");
  const items = state.mediaPreviewGroups[groupId] || [];
  if (!items.length) return;
  const nextIndex = state.mediaLightbox.index + Number(step || 0);
  if (nextIndex < 0 || nextIndex >= items.length) return;
  state.mediaLightbox.index = nextIndex;
  renderPersonaMediaLightboxCurrent();
}

function handlePersonaMediaFrameError(node) {
  if (!node) return;
  const placeholder = document.createElement("div");
  placeholder.className = "persona-media-frame persona-media-frame--empty";
  placeholder.innerHTML = "<strong>媒体已失效</strong><small>源文件无法加载</small>";
  node.replaceWith(placeholder);
  const host = placeholder.closest(".persona-media-card");
  if (host) {
    host.classList.add("is-unavailable");
    host.removeAttribute("data-media-preview-group");
    host.removeAttribute("data-media-preview-index");
    host.removeAttribute("data-media-preview-type");
    host.removeAttribute("data-media-preview-label");
  }
}

function handlePersonaMediaLightboxError(node, message) {
  const body = $("personaMediaLightboxBody");
  if (!body) return;
  body.innerHTML = `<div class="persona-media-lightbox-empty">${esc(message || "媒体加载失败")}</div>`;
}

window.handlePersonaMediaFrameError = handlePersonaMediaFrameError;
window.handlePersonaMediaLightboxError = handlePersonaMediaLightboxError;

function renderPersonaDraftRows(posts) {
  if (!posts.length) return `<div class="empty-state">当前还没有推文草稿。先新建一条，再进入发布步骤。</div>`;
  const personaId = String(selectedPersona()?.id || "");
  return `<div class="compact-list persona-draft-grid">${posts.map((post) => `
    <article
      class="compact-row persona-draft-card ${String(post.id) === String(state.selectedPersonaPostId) ? "is-selected" : ""}"
      data-persona-select-post="${esc(post.id)}"
      role="button"
      tabindex="0"
      aria-pressed="${String(post.id) === String(state.selectedPersonaPostId) ? "true" : "false"}"
    >
      <div class="persona-draft-card-head">
        <strong>${esc(post.title || "未命名草稿")}</strong>
        <span class="persona-draft-card-time">${esc(formatTime(post.published_at || post.updated_at || post.created_at))}</span>
      </div>
      <p>${esc(String(post.content || "").slice(0, 220))}</p>
      ${renderPersonaMediaPreview(personaDraftMediaItems(personaId, post), { compact: true })}
      <div class="persona-draft-card-footer">
        <small>${String(post.id) === String(state.selectedPersonaPostId) ? "当前已选中" : "点击卡片选中"}</small>
        ${String(post.id) === String(state.selectedPersonaPostId) ? `<button type="button" class="primary" data-persona-route-step="content:publish">带入发布步骤</button>` : ""}
      </div>
    </article>
  `).join("")}</div>`;
}

function renderPersonaMemoryOptions(persona, selectedIds = []) {
  const rows = state.personaMemories[String(persona.id)] || [];
  if (!Array.isArray(rows) || !rows.length) {
    return `<div class="empty-state">当前还没有可选人设记忆，留空也可以直接生成。</div>`;
  }
  const selected = new Set((selectedIds || []).map((item) => String(item || "")));
  return `
    <div class="persona-memory-panel">
      <div class="persona-memory-toolbar">
        <strong>已选 <span id="personaMemorySelectedCount">${selected.size}</span> / ${rows.length}</strong>
        <label class="persona-memory-search">
          <input id="personaMemorySearch" type="search" placeholder="筛选记忆内容" />
        </label>
        <div class="persona-memory-actions">
          <button type="button" data-persona-memory-bulk="all">全选</button>
          <button type="button" data-persona-memory-bulk="clear">清空</button>
        </div>
      </div>
      <div class="persona-memory-grid">
        ${rows.map((row) => {
          const isSelected = selected.has(String(row.id || ""));
          const summary = String(row.summary || "未命名记忆");
          return `
            <label class="persona-memory-card ${isSelected ? "is-selected" : ""}" data-persona-memory-search="${esc(summary.toLowerCase())}">
              <input
                class="persona-memory-input"
                type="checkbox"
                data-persona-memory-id="${esc(row.id)}"
                ${isSelected ? "checked" : ""}
              />
              <span class="persona-memory-check" aria-hidden="true"></span>
              <span class="persona-memory-copy">
                <strong>${esc(summary)}</strong>
                <small>${esc(formatTime(row.date || ""))}</small>
              </span>
            </label>`;
        }).join("")}
      </div>
    </div>`;
}

function syncPersonaMemorySelectionState() {
  const cards = [...document.querySelectorAll(".persona-memory-card")];
  cards.forEach((card) => {
    const input = card.querySelector("[data-persona-memory-id]");
    card.classList.toggle("is-selected", Boolean(input?.checked));
  });
  const countNode = $("personaMemorySelectedCount");
  if (countNode) {
    countNode.textContent = String(document.querySelectorAll("[data-persona-memory-id]:checked").length);
  }
}

function applyPersonaMemoryFilter(value = "") {
  const keyword = String(value || "").trim().toLowerCase();
  document.querySelectorAll(".persona-memory-card").forEach((card) => {
    const haystack = String(card.getAttribute("data-persona-memory-search") || "");
    const visible = !keyword || haystack.includes(keyword);
    card.hidden = !visible;
  });
}

function personaMemoryRows(persona = selectedPersona()) {
  if (!persona) return [];
  return state.personaMemories[String(persona.id)] || [];
}

function personaPublishHistoryRows(persona = selectedPersona()) {
  if (!persona) return [];
  const key = String(persona.id);
  const fallbackRows = sortPersonaPublishHistory(Array.isArray(persona.publish_history) ? persona.publish_history : []);
  if (Array.isArray(state.personaPublishHistories[key])) {
    const cachedRows = state.personaPublishHistories[key];
    if (cachedRows.length || !fallbackRows.length) return cachedRows;
  }
  return fallbackRows;
}

function personaPublishPreview(post) {
  if (!post) return `<div class="empty-state">请先在“推文草稿”里创建并选中一条推文。</div>`;
  const personaId = String(selectedPersona()?.id || "");
  return `
    <div class="flow-box">
      <span>当前草稿</span>
      <strong>${esc(post.title || "未命名草稿")}</strong>
      <span>${esc(String(post.content || "").slice(0, 240) || "暂无正文")}</span>
      ${renderPersonaMediaPreview(personaDraftMediaItems(personaId, post))}
    </div>
  `;
}

function personaProfilePresets(profile) {
  return Array.isArray(profile?.link_presets) ? profile.link_presets : [];
}

function selectedPersonaPreset(profile) {
  const presets = personaProfilePresets(profile);
  const wanted = String(state.personaLinkPresetId || "").trim();
  if (wanted && presets.some((item) => String(item.id) === wanted)) return presets.find((item) => String(item.id) === wanted) || null;
  const active = String(profile?.active_link_preset_id || "").trim();
  if (active && presets.some((item) => String(item.id) === active)) return presets.find((item) => String(item.id) === active) || null;
  return presets[0] || null;
}

function personaAutomationTaskTypesForStep(step) {
  if (step === "login") return ["open_login", "check_login"];
  if (step === "reply_comment" || step === "reply_hot") return ["threads_auto_reply"];
  if (step === "warmup") return ["threads_warmup"];
  return [];
}

function personaAutomationResultKey(accountId, step) {
  return `${String(accountId || "").trim()}:${String(step || "").trim()}`;
}

function personaSettingsLoadingPanel() {
  return `<div class="persona-inline-panel"><strong>正在加载人设设置...</strong><p>人设 profile 载入后，这里会显示可编辑设置。</p></div>`;
}

function renderPersonaAccountPanel(persona, account, profile, step) {
  return renderPersonaAccountPanelV2(persona, account, profile, step);
}

function renderPersonaSettingsPanelV2(persona, account, profile, step) {
  if (!profile) return personaSettingsLoadingPanel();
  const presets = personaProfilePresets(profile);
  const selectedPreset = selectedPersonaPreset(profile);
  const selectedPresetId = String(selectedPreset?.id || "");
  const currentStep = step || "profile";
  if (currentStep === "images") {
    const form = personaFormState(persona.id).images;
    const library = personaImageLibraryState(persona.id);
    const currentReferenceItem = (Array.isArray(library?.items) ? library.items : []).find((item) => item && item.is_reference) || null;
    const currentReferenceUrl = String(currentReferenceItem?.preview_url || library?.current_reference_url || "").trim();
    return `
      <div class="persona-inline-panel">
        <div class="persona-head-copy">
          <strong>人设图</strong>
          <span class="persona-panel-intro">生成并管理当前人设的参考图。</span>
        </div>
        ${currentReferenceUrl ? `
          <div class="persona-inline-panel persona-inline-panel--nested">
            <strong>当前参考图</strong>
            ${renderPersonaMediaPreview([{ previewUrl: currentReferenceUrl, url: currentReferenceUrl, type: "image", label: "当前参考图" }])}
          </div>
        ` : `<div class="empty-state">当前还没有参考图，先生成一张。</div>`}
        <div class="form-grid persona-detail-controls">
          <label>图像比例
            <select id="personaImageAspectRatio">
              <option value="1:1" ${String(form.aspectRatio || "1:1") === "1:1" ? "selected" : ""}>1:1</option>
              <option value="3:4" ${String(form.aspectRatio || "") === "3:4" ? "selected" : ""}>3:4</option>
              <option value="4:3" ${String(form.aspectRatio || "") === "4:3" ? "selected" : ""}>4:3</option>
              <option value="9:16" ${String(form.aspectRatio || "") === "9:16" ? "selected" : ""}>9:16</option>
              <option value="16:9" ${String(form.aspectRatio || "") === "16:9" ? "selected" : ""}>16:9</option>
            </select>
          </label>
        </div>
        <label>人设图补充提示
          <textarea id="personaImagePrompt" rows="4" placeholder="可选，留空则按当前人设内容生成。">${esc(form.prompt || "")}</textarea>
        </label>
        <div class="row-actions">
          <button type="button" class="primary" data-persona-generate-image>${currentReferenceUrl ? "重新生成人设图" : "生成人设图"}</button>
        </div>
        <div class="persona-inline-panel persona-inline-panel--nested">
          <strong>图库预览</strong>
          ${renderPersonaImageLibraryGrid(library)}
        </div>
      </div>`;
  }
  if (currentStep === "style") {
    return `
      <div class="persona-inline-panel">
        <strong>推文风格</strong>
        <label>风格样例
          <textarea id="personaTweetStyleSample" rows="8" placeholder="粘贴一条代表性推文，保存后自动提取风格。">${esc(profile.tweet_style_sample || "")}</textarea>
        </label>
        <div class="flow-box"><span>提取结果</span><strong>${esc(profile.tweet_style_profile || "尚未提取")}</strong></div>
        <div class="row-actions">
          <button type="button" data-persona-save-style>保存风格</button>
          <button type="button" data-persona-clear-style ${profile.tweet_style_sample ? "" : "disabled"}>清空风格</button>
        </div>
      </div>`;
  }
  if (currentStep === "links") {
    return `
      <div class="persona-inline-panel">
        <strong>链接设置</strong>
        <label>模板列表
          <select id="personaLinkPresetSelect">
            ${presets.length ? presets.map((item) => `<option value="${esc(item.id)}" ${String(item.id) === selectedPresetId ? "selected" : ""}>${esc(item.name || item.id)}${String(profile.active_link_preset_id || "") === String(item.id) ? " · 当前启用" : ""}</option>`).join("") : `<option value="">暂无链接模板</option>`}
          </select>
        </label>
        <div class="form-grid">
          <label>模板名称
            <input id="personaLinkPresetName" value="${esc(selectedPreset?.name || "")}" placeholder="模板名称" />
          </label>
          <label>链接地址
            <input id="personaLinkPresetUrl" value="${esc(selectedPreset?.link_url || "")}" placeholder="https://example.com" />
          </label>
        </div>
        <label>结尾文案
          <textarea id="personaLinkPresetEnding" rows="4" placeholder="发布时附加在推文结尾。">${esc(selectedPreset?.ending_text || "")}</textarea>
        </label>
        <div class="row-actions">
          <button type="button" data-persona-add-preset>新增模板</button>
          <button type="button" data-persona-save-preset ${selectedPreset ? "" : "disabled"}>保存模板</button>
          <button type="button" data-persona-delete-preset ${selectedPreset ? "" : "disabled"}>删除模板</button>
          <button type="button" data-persona-activate-preset ${selectedPreset ? "" : "disabled"}>设为当前启用</button>
        </div>
      </div>`;
  }
  if (currentStep === "delete") {
    return `
      <div class="persona-inline-panel">
        <strong>删除人设</strong>
        <p>这里只保留真实可用的删除接口。工作流人设不允许删除，普通人设删除后不可恢复。</p>
        <div class="row-actions">
          <button type="button" class="danger" data-persona-delete ${profile.is_workflow_persona ? "disabled" : ""}>删除当前人设</button>
        </div>
      </div>`;
  }
  return `
    <div class="persona-inline-panel">
      <strong>基础资料</strong>
      <div class="form-grid">
        <label>人设名称
          <input id="personaProfileName" value="${esc(profile.name || persona.name || persona.id)}" />
        </label>
      </div>
      <label>人设简介
        <textarea id="personaProfileContent" rows="8" placeholder="编辑并保存当前人设简介。">${esc(profile.content || persona.content || "")}</textarea>
      </label>
      <div class="row-actions">
        <button type="button" data-persona-save-profile>保存资料</button>
      </div>
    </div>`;
}

function renderPersonaAccountPanelV2(persona, account, profile, step) {
  const currentStep = step || "binding";
  const platform = selectedPersonaAutomationPlatform();
  const accounts = personaAutomationAccounts(persona, platform);
  const selectedAccount = selectedPersonaAutomationAccount(persona, platform);
  const selectedAccountId = String(selectedAccount?.id || "");
  const taskResultKey = personaAutomationResultKey(selectedAccountId, currentStep);
  const taskResultHtml = state.personaAutomationResults[taskResultKey] || `<div class="empty-state">提交后，这里会显示任务状态、截图和执行日志。</div>`;
  const threads = persona.threads_account || {};
  const credentialsMask = selectedAccount?.login_password_configured ? "已保存密码，留空则沿用" : "登录密码";
  const isThreads = platform === "threads";
  const strategyGroup = currentStep === "reply_hot"
    ? "threads_hot_reply"
    : currentStep === "warmup"
      ? "threads_warmup"
      : "threads_comment_reply";
  const strategy = personaThreadsStrategy(strategyGroup);
  const customStrategy = personaThreadsStrategyIsCustom(strategyGroup);
  const basePanel = `
    <div class="form-grid">
      <label>执行平台
        <select id="personaAutoPlatform">
          <option value="threads" ${platform === "threads" ? "selected" : ""}>Threads</option>
          <option value="instagram" ${platform === "instagram" ? "selected" : ""}>Instagram</option>
        </select>
      </label>
      <label>执行账号
        <select id="personaAutoAccount">
          ${accounts.length ? accounts.map((item) => `<option value="${esc(item.id)}" ${String(item.id) === selectedAccountId ? "selected" : ""}>${esc(item.username || item.id)} · ${esc(statusLabel(item.status || ""))}</option>`).join("") : `<option value="">当前平台暂无账号</option>`}
        </select>
      </label>
    </div>
    ${selectedAccount ? "" : `<div class="empty-state">当前平台还没有执行账号。请先绑定账号。</div>`}
  `;
  if (currentStep === "binding") {
    return `
      ${basePanel}
      <div class="form-grid">
        <div class="persona-inline-panel">
          <strong>Threads 主页标识</strong>
          <p>这里只保存当前人设对应的 Threads 主页用户名，不会创建浏览器执行账号。</p>
          <label>Threads 用户名
            <input id="personaThreadsHandle" value="${esc(threads.handle || profile?.threads_handle || "")}" placeholder="Threads 用户名 / handle" />
          </label>
          <div class="row-actions">
            <button type="button" data-persona-save-threads>保存绑定</button>
            <button type="button" data-persona-unbind-threads ${threads.handle ? "" : "disabled"}>解绑</button>
          </div>
        </div>
        <div class="persona-inline-panel">
          <strong>绑定浏览器执行账号</strong>
          <p>这里才会创建真正用于登录、养号、自动回复和发布的浏览器执行账号。</p>
          <label>${platform === "threads" ? "Threads 用户名" : "Instagram 用户名"}
            <input id="personaAutoUsername" value="" placeholder="${platform === "threads" ? "Threads 用户名 / handle" : "Instagram 用户名"}" />
          </label>
          <div class="row-actions">
            <button type="button" data-persona-create-account>绑定新账号</button>
          </div>
        </div>
      </div>
    `;
  }
  if (currentStep === "login") {
    return `
      ${basePanel}
      <div class="persona-inline-panel">
        <strong>登录与检查</strong>
        <div class="form-grid">
          <label>登录账号
            <input id="personaAutoLoginUsername" value="${esc(selectedAccount?.login_username || selectedAccount?.username || "")}" placeholder="账号 / 邮箱 / 手机号" />
          </label>
          <label>登录密码
            <input id="personaAutoLoginPassword" type="password" value="" placeholder="${esc(credentialsMask)}" />
          </label>
        </div>
        <div class="row-actions">
          <button type="button" data-persona-save-login ${selectedAccount ? "" : "disabled"}>保存登录资料</button>
          <button type="button" data-persona-clear-login ${selectedAccount?.login_password_configured ? "" : "disabled"}>删除登录资料</button>
          <button type="button" data-persona-open-login ${selectedAccount ? "" : "disabled"}>打开登录窗口</button>
          <button type="button" data-persona-auto-login ${selectedAccount ? "" : "disabled"}>自动登录</button>
          <button type="button" data-persona-check-login ${selectedAccount ? "" : "disabled"}>检查登录</button>
        </div>
        <div id="personaAutomationResult">${taskResultHtml}</div>
      </div>
    `;
  }
  if (!isThreads) {
    return `
      ${basePanel}
      <div class="persona-inline-panel">
        <strong>${currentStep === "warmup" ? "养号" : "自动回复"}</strong>
        <p>当前步骤只支持 Threads。请把执行平台切换到 Threads 后再操作。</p>
      </div>
    `;
  }
  if (currentStep === "reply_comment" || currentStep === "reply_hot") {
    const defaultPayload = strategy?.payload || {};
    return `
      ${basePanel}
      <div class="persona-inline-panel">
        <strong>${currentStep === "reply_hot" ? "自动回复热点推文" : "自动回复评论"}</strong>
        <label>策略
          <select id="personaStrategySelect" data-strategy-group="${esc(strategyGroup)}">
            ${personaThreadsStrategyOptionsHtml(strategyGroup)}
          </select>
        </label>
        ${customStrategy ? `
          <div class="form-grid">
            <label>查看天数
              <input id="personaAutoMaxAgeDays" type="number" min="1" max="365" value="${esc(defaultPayload.max_age_days || (currentStep === "reply_hot" ? 30 : 2))}" />
            </label>
            <label>扫描篇数
              <input id="personaAutoMaxPosts" type="number" min="1" max="20" value="${esc(defaultPayload.max_posts || 5)}" />
            </label>
            <label>回复上限
              <input id="personaAutoMaxReplies" type="number" min="1" max="10" value="${esc(defaultPayload.max_replies || 3)}" />
            </label>
            ${currentStep === "reply_hot" ? `<label>最低浏览
              <input id="personaAutoMinViews" type="number" min="0" max="999999999" value="${esc(defaultPayload.min_views || 0)}" />
            </label>` : ""}
          </div>
          ${currentStep === "reply_hot" ? `<label>指定目标 URL
            <textarea id="personaAutoTargetUrls" rows="3" placeholder="可选，多个链接换行填写。"></textarea>
          </label>` : ""}
          <label>固定回复内容
            <textarea id="personaAutoReplyText" rows="3" placeholder="留空则按当前人设自动生成。"></textarea>
          </label>
        ` : ""}
        ${personaThreadsStrategyDetail(strategyGroup)}
        <div class="row-actions">
          <button type="button" data-persona-run-threads="${currentStep === "reply_hot" ? "reply_hot" : "reply_comment"}" ${selectedAccount ? "" : "disabled"}>提交自动回复任务</button>
        </div>
      </div>
    `;
  }
  const warmupPayload = strategy?.payload || {};
  return `
    ${basePanel}
    <div class="persona-inline-panel">
      <strong>养号</strong>
      <label>策略
        <select id="personaStrategySelect" data-strategy-group="threads_warmup">
          ${personaThreadsStrategyOptionsHtml("threads_warmup")}
        </select>
      </label>
      ${customStrategy ? `
        <div class="form-grid">
          <label>浏览篇数上限
            <input id="personaAutoBrowseLimit" type="number" min="1" max="300" value="${esc(warmupPayload.browse_limit || warmupPayload.scroll_times || 30)}" />
          </label>
          <label>点赞上限
            <input id="personaAutoLikeLimit" type="number" min="0" max="100" value="${esc(warmupPayload.like_limit || 0)}" />
          </label>
          <label>留言上限
            <input id="personaAutoMaxComments" type="number" min="0" max="50" value="${esc(warmupPayload.max_comments || 0)}" />
          </label>
        </div>
        <label>养号留言模板
          <textarea id="personaAutoReplyText" rows="3" placeholder="可选，多条换行。留空则按人设自动生成。"></textarea>
        </label>
      ` : ""}
      ${personaThreadsStrategyDetail("threads_warmup")}
      <div class="row-actions">
        <button type="button" data-persona-run-threads="warmup" ${selectedAccount ? "" : "disabled"}>提交养号任务</button>
      </div>
    </div>
  `;
}

function renderPersonaDataPanel(persona, profile, step) {
  const hot = persona.hot || {};
  if (step === "queue") {
    const personaTasks = state.socialTasks.filter((item) => String(item.persona_id || "") === String(persona.id || "")).slice(0, 10);
    return `
      <div class="persona-inline-panel">
        ${personaTasks.length ? `<div class="compact-list">${personaTasks.map((task) => `
          <article class="compact-row">
            <strong>${esc(statusLabel(task.task_type || ""))}</strong>
            <p>${esc(statusLabel(task.status || ""))} \u00b7 ${esc(task.account_username || task.account_id || "")}</p>
            <span>${esc(formatTime(task.updated_at || task.created_at || ""))}</span>
          </article>
        `).join("")}</div>` : `<div class="empty-state">\u5f53\u524d\u4eba\u8bbe\u6682\u65e0\u81ea\u52a8\u5316\u4efb\u52a1\u3002</div>`}
        <div class="row-actions">
          <button type="button" data-persona-clear-tasks>\u6e05\u7406\u8be5\u4eba\u8bbe\u81ea\u52a8\u5316\u961f\u5217</button>
        </div>
      </div>`;
  }
  return `
    <div class="form-grid">
      <div class="persona-inline-panel">
        <p>\u70ed\u5ea6 ${numberText(hot.hot_score)} \u00b7 \u70b9\u8d5e ${numberText(hot.likes)} \u00b7 \u8bc4\u8bba ${numberText(hot.comments)} \u00b7 \u5206\u4eab ${numberText(hot.shares)} \u00b7 \u8f6c\u53d1 ${numberText(hot.reposts)}</p>
      </div>
      <div class="persona-inline-panel">
        <p>\u66f4\u5b8c\u6574\u7684\u65e5\u5fd7\u3001\u81ea\u52a8\u5316\u622a\u56fe\u548c\u6863\u6848\u53ea\u5728\u5de6\u4e0b\u89d2\u7684\u201c\u4eba\u8bbe\u770b\u677f\u201d\u5165\u53e3\u4e2d\u67e5\u770b\u3002</p>
      </div>
    </div>`;
}

function currentBranch(moduleId) {
  return selectedBranch(moduleId);
}

function selectedSocialAccount(accountId) {
  return state.socialAccounts.find((account) => String(account.id) === String(accountId || "")) || null;
}

function platformForAccount(accountId) {
  const account = selectedSocialAccount(accountId);
  return account?.platform || "threads";
}

function taskOptionsForPlatform(platform) {
  if (platform === "instagram") {
    return [
      ["open_login", "打开登录"],
      ["check_login", "检查登录"],
      ["browse_feed", "浏览 Feed"],
      ["browse_profile", "浏览主页"],
      ["publish_post", "发布内容"],
      ["comment_post", "评论帖子"],
      ["reply_comment", "回复评论"],
      ["like_post", "点赞帖子"],
      ["share_post", "分享帖子"],
    ];
  }
  return [
    ["open_login", "打开登录"],
    ["check_login", "检查登录"],
    ["browse_feed", "浏览 Feed"],
    ["publish_post", "发布内容"],
    ["threads_warmup", "Threads 养号"],
    ["threads_auto_reply", "Threads 自动回复"],
  ];
}

function optionTags(options, selectedValue) {
  return options.map(([value, label]) => `<option value="${esc(value)}" ${value === selectedValue ? "selected" : ""}>${esc(label)}</option>`).join("");
}

function personaOptionTags() {
  return state.personas.length
    ? state.personas.map((persona) => `<option value="${esc(persona.id)}" ${String(persona.id) === String(state.selectedPersonaId) ? "selected" : ""}>${esc(persona.name || persona.id)} · ${esc(personaBindingLabel(persona))}</option>`).join("")
    : `<option value="">暂无人设</option>`;
}

function accountOptionTags() {
  const accounts = uniqueAccountOptions(state.socialAccounts);
  return accounts.length
    ? accounts.map((account) => `<option value="${esc(account.id)}" data-platform="${esc(account.platform || "")}">${esc(account.username || account.id)} · ${esc(account.platform || "-")}</option>`).join("")
    : `<option value="">暂无账号</option>`;
}

function syncStandaloneSocialForm() {
  const account = selectedSocialAccount($("socialAccount")?.value);
  const platform = account?.platform || $("socialPlatform")?.value || "threads";
  if ($("socialPlatform")) $("socialPlatform").value = platform;
  const select = $("socialTaskType");
  if (!select) return;
  const options = taskOptionsForPlatform(platform);
  const current = select.value;
  const next = options.some(([value]) => value === current) ? current : options[0][0];
  select.innerHTML = optionTags(options, next);
}

function renderSimpleFlowModule(moduleId) {
  const branch = currentBranch(moduleId);
  const personaAccount = accountForPersona(selectedPersona());
  const firstAccount = state.preferredAccountId || personaAccount?.id || state.socialAccounts[0]?.id || "";
  const accountId = $("simpleAccount")?.value || firstAccount;
  const platform = platformForAccount(accountId);
  const taskOptions = taskOptionsForPlatform(platform);
  const selectedTask = taskOptions.some(([value]) => value === branch) ? branch : taskOptions[0][0];
  const commonAccount = `
    <label>执行账号
      <select id="simpleAccount">${accountOptionTags()}</select>
    </label>`;
  const scheduleField = `
    <label>发布时间
      <input id="simpleScheduleAt" placeholder="留空立即执行 / 2026-07-04 21:30" />
    </label>`;
  const contentBox = `
    <label>内容</label>
    <textarea id="simpleContent" rows="4" placeholder="发布正文、评论内容或回复模板。"></textarea>`;
  const targetField = `
    <label>目标 URL / 用户名</label>
    <input id="simpleTargetUrl" placeholder="评论、点赞、分享、浏览主页时填写" />`;
  const targetListField = `
    <label>目标 URL 列表</label>
    <textarea id="simpleTargetUrls" rows="3" placeholder="热点回复可选，多个链接换行填写。"></textarea>`;
  let body = "";
  if (moduleId === "publishing") {
    const selectedPersonaForPublish = state.personas.find((item) => String(item.id) === String($("simplePersona")?.value || state.selectedPersonaId || "")) || selectedPersona();
    const publishAccount = publishAccountForPersona(selectedPersonaForPublish);
    body = `
      <div class="form-grid">
        <label>发布方式
          <select id="simplePublishMode">
            <option value="publish_now">立即发布</option>
            <option value="schedule_publish">定时发布</option>
          </select>
        </label>
        <label>人设
          <select id="simplePersona">${personaOptionTags()}</select>
        </label>
      </div>
      ${publishAccount ? `<div class="flow-box"><span>发布账号</span><strong>${esc(publishAccount.username || publishAccount.id)}</strong><span>${esc(publishPlatformHint(publishAccount))}</span></div>` : `<div class="empty-state">当前人设还没有可发布的 Threads 或 Instagram 执行账号。请先到“我的人设 > 浏览器账号”里绑定。</div>`}
      ${scheduleField}
      ${contentBox}
      <label>素材
        <input id="simpleMediaFiles" type="file" multiple accept="image/*,video/*" />
      </label>
      <input id="simplePrimary" type="hidden" value="publish_post" />`;
  } else if (moduleId === "automation") {
    const needsTarget = ["browse_profile", "comment_post", "reply_comment", "like_post", "share_post"].includes(selectedTask);
    const needsContent = ["publish_post", "comment_post", "reply_comment", "threads_auto_reply"].includes(selectedTask);
    const needsMedia = selectedTask === "publish_post";
    const showTargetList = selectedTask === "threads_auto_reply";
    body = `
      ${commonAccount}
      <label>任务类型
        <select id="simplePrimary">${optionTags(taskOptions, selectedTask)}</select>
      </label>
      ${needsTarget ? targetField : ""}
      ${needsContent ? contentBox : ""}
      ${needsMedia ? `<label>素材<input id="simpleMediaFiles" type="file" multiple accept="image/*,video/*" /></label>` : ""}
      ${showTargetList ? targetListField : ""}`;
  } else {
    body = `
      <div class="form-grid">
        <label>状态
          <select id="simplePrimary">
            <option value="pending">待执行</option>
            <option value="failed">失败</option>
            <option value="scheduled">定时</option>
          </select>
        </label>
        <label>平台
          <select id="simplePlatform">
            <option value="all">全部</option>
            <option value="threads">Threads</option>
            <option value="instagram">Instagram</option>
          </select>
        </label>
      </div>`;
  }
  const actionLabel = moduleId === "queue" ? "打开任务队列" : "确认执行";
  $("moduleBody").innerHTML = `
    ${body}
    <div class="command-actions"><button id="executeSimpleFlow" type="button" class="primary">${esc(actionLabel)}</button></div>
  `;
  if ($("simpleAccount") && accountId) $("simpleAccount").value = accountId;
  if ($("simplePublishMode")) {
    const modes = ["publish_now", "matrix_start", "schedule_publish"];
    $("simplePublishMode").value = modes.includes(branch) ? branch : "publish_now";
  }
  bindSimpleFlowInputs(moduleId);
  $("executeSimpleFlow").addEventListener("click", () => executeSimpleFlow().catch((error) => showMsg("commandMsg", error.detail || error.message || "执行失败", false)));
}

function bindSimpleFlowInputs(moduleId) {
  ["simplePrimary", "simplePublishMode", "simpleAccount", "simplePersona", "simpleScheduleAt", "simpleContent", "simpleTargetUrl", "simpleMediaFiles", "simpleTargetUrls"].forEach((id) => {
    const node = $(id);
    if (!node) return;
    node.addEventListener(node.tagName === "TEXTAREA" || node.tagName === "INPUT" ? "input" : "change", () => {
      if (id === "simplePrimary" || id === "simplePublishMode") state.simpleBranches[moduleId] = node.value;
      if (id === "simplePrimary" && moduleId === "automation") {
        renderSimpleFlowModule(moduleId);
        return;
      }
      if (id === "simplePersona" && moduleId === "publishing") {
        state.selectedPersonaId = node.value || state.selectedPersonaId;
        renderSimpleFlowModule(moduleId);
        return;
      }
      if (id === "simpleAccount" && moduleId === "automation") renderSimpleFlowModule(moduleId);
      renderConfirmSummary();
    });
  });
}

function fillSimpleAccounts() {
  const select = $("simpleAccount");
  if (!select) return;
  const accounts = uniqueAccountOptions(state.socialAccounts);
  select.innerHTML = accounts.length
    ? accounts.map((account) => `<option value="${esc(account.id)}">${esc(account.username || account.id)} · ${esc(account.platform)}</option>`).join("")
    : `<option value="">暂无账号</option>`;
}


function renderConfirmSummary() {
  const module = currentModule();
  let rows = [["当前入口", module.label]];
  if (state.activeModule === "generation" && $("taskType")) {
    const meta = taskMeta[$("taskType").value] || taskMeta.text_to_image;
    rows = rows.concat([
      ["任务类型", meta.title],
      ["素材", state.files.length ? `${state.files.length} 个文件` : "未选择"],
      ["最终动作", "提交生成任务"],
    ]);
  } else if (state.activeModule === "personas") {
    const persona = selectedPersona();
    const groupKey = state.personaGroup || "content";
    const profile = selectedPersonaProfile();
    const step = currentPersonaGroupStep(groupKey, profile);
    const finalAction = {
      generate: "提交人设草稿生成任务",
      media: "生成媒体或更新当前草稿媒体",
      overview: "查看当前人设资料",
      posts: "新建或选择推文草稿",
      history: "查看发布历史",
      publish: "提交浏览器发布任务",
      login: "保存凭证或提交登录任务",
      reply_comment: "提交 Threads 评论回复任务",
      reply_hot: "提交 Threads 热点回复任务",
      warmup: "提交 Threads 养号任务",
      delete: "删除当前人设",
      queue: "查看或清理该人设自动化队列",
      metrics: "查看当前人设热点数据",
    }[step] || "显示当前步骤的参数面板";
    rows = rows.concat([
      ["当前人设", persona ? persona.name : "未选择"],
      ["当前步骤", personaGroupStepLabel(groupKey, step, profile)],
      ["最终动作", finalAction],
    ]);
  } else if (state.activeModule === "publishing" || state.activeModule === "automation") {
    const persona = state.personas.find((item) => String(item.id) === String($("simplePersona")?.value || state.selectedPersonaId)) || selectedPersona();
    const account = state.activeModule === "publishing"
      ? publishAccountForPersona(persona)
      : selectedSocialAccount($("simpleAccount")?.value);
    rows = rows.concat([
      [state.activeModule === "publishing" ? "发布方式" : "任务类型", $("simplePublishMode")?.selectedOptions?.[0]?.textContent || $("simplePrimary")?.selectedOptions?.[0]?.textContent || selectedBranch(state.activeModule)],
      [state.activeModule === "publishing" ? "发布账号" : "账号", account ? String(account.username || account.id) : "未选择"],
      ["最终动作", "提交浏览器任务"],
    ]);
  } else {
    rows = rows.concat([
      ["队列筛选", $("simplePrimary")?.selectedOptions?.[0]?.textContent || "-"],
      ["最终动作", "打开任务队列并执行取消或重试"],
    ]);
  }
  const host = $("confirmSummary");
  if (!host) return;
  host.innerHTML = rows.map(([label, value]) => `
    <div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>
  `).join("");
}


function renderFiles() {
  const host = $("fileStrip");
  if (!host) return;
  if (!state.files.length) {
    host.innerHTML = `<span class="empty-line">未选择文件</span>`;
    return;
  }
  host.innerHTML = state.files.map((file, index) => `
    <div class="file-chip"><span>${esc(file.name)}</span><small>${esc(fileKind(file))}</small><button type="button" data-remove-file="${index}">移除</button></div>
  `).join("");
  renderConfirmSummary();
}

function addFiles(files) {
  const seen = new Set(state.files.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  Array.from(files || []).forEach((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!seen.has(key)) {
      state.files.push(file);
      seen.add(key);
    }
  });
  renderFiles();
}

function appendEvent(kind, message) {
  const host = $("eventStream");
  if (!host) return;
  const row = document.createElement("div");
  row.className = `event-row ${kind || "info"}`;
  row.innerHTML = `<span>${esc(kind || "info")}</span><p>${esc(message || "")}</p>`;
  host.prepend(row);
}

function syncWatchingTaskChip(taskId = "") {
  const chip = $("watchingTask");
  if (!chip) return;
  const cleanId = String(taskId || "").trim();
  if (!cleanId) {
    chip.textContent = "";
    chip.hidden = true;
    return;
  }
  chip.textContent = `监听中 ${cleanId.slice(0, 8)}`;
  chip.hidden = false;
}

function watchTask(taskId) {
  if (state.events) state.events.close();
  syncWatchingTaskChip(taskId);
  state.events = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`, { withCredentials: true });
  state.events.onmessage = (event) => {
    let payload = {};
    try { payload = JSON.parse(event.data || "{}"); } catch {}
    const kind = String(payload.kind || payload.status || "progress");
    appendEvent(kind, payload.message || payload.detail || kind);
    if (["success", "failed"].includes(kind)) {
      state.events.close();
      state.events = null;
      syncWatchingTaskChip("");
      loadTasks();
    }
  };
  state.events.onerror = () => {
    appendEvent("warn", "事件流已断开，可在任务队列继续查看结果。");
    if (state.events) state.events.close();
    state.events = null;
    syncWatchingTaskChip("");
  };
}

function buildTaskPayload() {
  const type = $("taskType").value;
  const prompt = $("taskPrompt").value.trim();
  const payload = {
    prompt,
    prompt_text: prompt,
    message: prompt,
    negative_prompt: $("taskNegativePrompt")?.value.trim() || "",
    tg_prompt_mode: $("promptMode").value,
    tg_web_branch: $("taskBranch").value,
    aspect_ratio: $("taskAspectRatio")?.value || "auto",
    text_to_image_auto_qa_enabled: $("taskQa")?.value !== "off",
    final_resolution_enabled: $("taskFinalResolution")?.value !== "off",
    persona_lora_mode: $("taskPersonaLora")?.value || "off",
  };
  if (type === "image_generate") payload.mode = $("taskMode").value;
  if (type === "video_i2v") {
    payload.resolution = $("taskResolution").value;
    payload.duration_seconds = Number($("taskDuration").value || 2);
    payload.audio_mode = $("taskAudioMode").value;
  }
  return payload;
}

async function submitGenerationTask() {
  const type = $("taskType").value;
  const prompt = $("taskPrompt").value.trim();
  if (!prompt && !["image_generate"].includes(type)) {
    showMsg("commandMsg", "请先填写任务指令。", false);
    return;
  }
  const imageCount = state.files.filter((file) => fileKind(file) === "image").length;
  const requiredImages = taskMeta[type]?.minImages || 0;
  if (imageCount < requiredImages) {
    showMsg("commandMsg", `该任务至少需要 ${requiredImages} 张图片。`, false);
    return;
  }
  const form = new FormData();
  form.append("task_type", type);
  form.append("params_json", JSON.stringify(buildTaskPayload()));
  state.files.forEach((file) => form.append("files", file, file.name));
  showMsg("commandMsg", "正在提交任务...", true);
  const result = await api("/api/tasks/submit", { method: "POST", body: form });
  appendEvent("queued", `任务已创建：${result.id}`);
  showMsg("commandMsg", `任务已提交：${result.id}`, true);
  watchTask(result.id);
  await loadTasks();
}

async function submitPersonaPublishTask() {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  const post = selectedPersonaPost(persona);
  if (!post) {
    showMsg("commandMsg", "请先创建并选中一条推文草稿。", false);
    return;
  }
  const account = selectedPublishAccountForPersona(persona);
  if (!account) {
    showMsg("commandMsg", "当前人设没有可发布的 Threads 或 Instagram 账号，请先绑定账号。", false);
    return;
  }
  const preflight = personaPublishPreflight(account);
  if (!preflight.login) {
    showMsg("commandMsg", "发布前请先完成一次登录检查，确认当前执行账号仍然可用。", false);
    return;
  }
  const platform = String(account.platform || "instagram").trim().toLowerCase() || "instagram";
  const mediaPaths = await uploadAutomationMedia(filesFromInput("personaPublishFiles"), "commandMsg");
  if (platform === "instagram" && !mediaPaths.length) {
    showMsg("commandMsg", "Instagram 发布至少需要上传一份媒体素材。", false);
    return;
  }
  const scheduledAt = $("personaPublishScheduleAt")?.value.trim() || "";
  showMsg("commandMsg", `正在提交 ${publishPlatformLabel(account)} 发布任务到浏览器执行队列...`, true);
  const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts/${encodeURIComponent(post.id)}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account_id: account.id,
      platform,
      scheduled_at: scheduledAt || undefined,
      media_paths: mediaPaths,
      priority: 50,
      max_retries: 2,
    }),
  });
  const task = result.task || {};
  const taskId = String(task.id || "").trim();
  state.personaPublishResults[String(persona.id)] = renderPersonaPublishResult(task, []);
  updatePersonaPublishResultView(persona.id);
  appendEvent("persona", `${persona.name || persona.id} 已提交发布任务：${taskId || "-"}`);
  showMsg("commandMsg", `发布任务已提交：${taskId || "-"}`, true);
  if (taskId) watchPersonaPublishTask(taskId, persona.id).catch((error) => {
    state.personaPublishResults[String(persona.id)] = `<div class="persona-warning-inline">${esc(error?.detail || error?.message || "任务结果轮询失败")}</div>`;
    updatePersonaPublishResultView(persona.id);
  });
  await loadSocial();
}

async function savePersonaThreadsBinding() {
  const persona = selectedPersona();
  const username = $("personaThreadsHandle")?.value.trim().replace(/^@+/, "") || "";
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  if (!username) {
    showMsg("commandMsg", "请先填写 Threads 用户名。", false);
    return;
  }
  showMsg("commandMsg", "正在保存 Threads 绑定...", true);
  await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/threads_binding`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  appendEvent("persona", `${persona.name || persona.id} 已保存 Threads 绑定：${username}`);
  showMsg("commandMsg", "Threads 绑定已保存。", true);
  await loadPersonas();
}

async function unbindPersonaThreadsBinding() {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  showMsg("commandMsg", "正在解绑 Threads 绑定...", true);
  await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/threads_binding`, { method: "DELETE" });
  appendEvent("persona", `${persona.name || persona.id} 已解绑 Threads 绑定`);
  showMsg("commandMsg", "Threads 绑定已解绑。", true);
  await loadPersonas();
}

async function patchPersonaProfile(payload) {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return null;
  }
  const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  state.personaProfiles[String(persona.id)] = result;
  await loadPersonas();
  return result;
}

async function savePersonaProfileFields() {
  const result = await patchPersonaProfile({
    name: $("personaProfileName")?.value.trim() || "",
    content: $("personaProfileContent")?.value.trim() || "",
  });
  if (result) showMsg("commandMsg", "人设资料已保存。", true);
}

async function savePersonaTweetStyle() {
  const result = await patchPersonaProfile({ tweet_style_sample: $("personaTweetStyleSample")?.value || "" });
  if (result) showMsg("commandMsg", "推文风格已保存。", true);
}

async function clearPersonaTweetStyle() {
  const result = await patchPersonaProfile({ tweet_style_sample: "" });
  if (result) showMsg("commandMsg", "推文风格已清空。", true);
}

function draftPersonaPresetList(profile, mutate) {
  const presets = personaProfilePresets(profile).map((item) => ({
    id: item.id,
    name: item.name || "",
    link_url: item.link_url || "",
    ending_text: item.ending_text || "",
    enabled: item.enabled !== false,
  }));
  mutate(presets);
  return presets;
}

async function savePersonaPresetList(nextPresets, activeId = null) {
  const payload = { link_presets: nextPresets };
  if (activeId !== null) payload.active_link_preset_id = activeId;
  const result = await patchPersonaProfile(payload);
  if (result) {
    state.personaLinkPresetId = String(result.active_link_preset_id || nextPresets[0]?.id || "");
    showMsg("commandMsg", "链接模板已保存。", true);
  }
}

async function addPersonaPreset() {
  const profile = selectedPersonaProfile();
  if (!profile) return;
  const nextId = `preset-${Date.now().toString(36)}`;
  const nextPresets = draftPersonaPresetList(profile, (presets) => {
    presets.push({ id: nextId, name: "新模板", link_url: "", ending_text: "", enabled: true });
  });
  state.personaLinkPresetId = nextId;
  await savePersonaPresetList(nextPresets, String(profile.active_link_preset_id || nextId));
}

async function savePersonaPreset() {
  const profile = selectedPersonaProfile();
  const preset = selectedPersonaPreset(profile);
  if (!profile || !preset) return;
  const nextPresets = draftPersonaPresetList(profile, (presets) => {
    const index = presets.findIndex((item) => String(item.id) === String(preset.id));
    if (index >= 0) {
      presets[index] = {
        ...presets[index],
        name: $("personaLinkPresetName")?.value.trim() || presets[index].name || "模板",
        link_url: $("personaLinkPresetUrl")?.value.trim() || "",
        ending_text: $("personaLinkPresetEnding")?.value.trim() || "",
      };
    }
  });
  await savePersonaPresetList(nextPresets, String(profile.active_link_preset_id || preset.id));
}

async function deletePersonaPreset() {
  const profile = selectedPersonaProfile();
  const preset = selectedPersonaPreset(profile);
  if (!profile || !preset) return;
  const nextPresets = draftPersonaPresetList(profile, (presets) => {
    const index = presets.findIndex((item) => String(item.id) === String(preset.id));
    if (index >= 0) presets.splice(index, 1);
  });
  const nextActive = nextPresets.some((item) => String(item.id) === String(profile.active_link_preset_id || ""))
    ? String(profile.active_link_preset_id || "")
    : (nextPresets[0]?.id || "");
  state.personaLinkPresetId = nextActive;
  await savePersonaPresetList(nextPresets, nextActive);
}

async function activatePersonaPreset() {
  const profile = selectedPersonaProfile();
  const preset = selectedPersonaPreset(profile);
  if (!profile || !preset) return;
  await savePersonaPresetList(draftPersonaPresetList(profile, () => {}), String(preset.id));
}

async function deleteSelectedPersona() {
  const persona = selectedPersona();
  const profile = selectedPersonaProfile();
  if (!persona || !profile) return;
  if (profile.is_workflow_persona) {
    showMsg("commandMsg", "工作流人设不允许在 Web 控制台删除。", false);
    return;
  }
  const confirmed = await openConsoleModal({
    title: "删除人设",
    message: `确认删除人设「${persona.name || persona.id}」？删除后不可恢复。`,
    confirmText: "删除",
    danger: true,
  });
  if (!confirmed) return;
  await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}`, { method: "DELETE" });
  showMsg("commandMsg", "人设已删除。", true);
  state.selectedPersonaId = "";
  state.personaCreateMode = false;
  await loadPersonas();
}

async function createPersonaAutomationAccount() {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  const platform = selectedPersonaAutomationPlatform();
  const username = String($("personaAutoUsername")?.value || "").trim().replace(/^@+/, "");
  if (!username) {
    showMsg("commandMsg", `请先填写 ${platform === "threads" ? "Threads" : "Instagram"} 用户名。`, false);
    return;
  }
  const result = await api("/api/persona_dashboard/automation/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona_id: persona.id, platform, username }),
  });
  state.preferredAccountId = result.account?.id || "";
  showMsg("commandMsg", "浏览器执行账号已创建并绑定。", true);
  await loadSocial();
}

async function savePersonaAutomationLogin() {
  const persona = selectedPersona();
  const account = selectedPersonaAutomationAccount(persona);
  if (!account) {
    showMsg("commandMsg", "请先选择执行账号。", false);
    return;
  }
  const loginUsername = String($("personaAutoLoginUsername")?.value || account.username || "").trim();
  const loginPassword = String($("personaAutoLoginPassword")?.value || "");
  if (!loginUsername) {
    showMsg("commandMsg", "请先填写登录账号。", false);
    return;
  }
  if (!loginPassword && !account.login_password_configured) {
    showMsg("commandMsg", "请填写登录账号和密码，或先保存长期登录资料。", false);
    return;
  }
  const payload = { login_username: loginUsername };
  if (loginPassword) payload.login_password = loginPassword;
  await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(account.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if ($("personaAutoLoginPassword")) $("personaAutoLoginPassword").value = "";
  showMsg("commandMsg", "登录资料已保存。", true);
  await loadSocial();
}

async function clearPersonaAutomationLogin() {
  const persona = selectedPersona();
  const account = selectedPersonaAutomationAccount(persona);
  if (!account) {
    showMsg("commandMsg", "请先选择执行账号。", false);
    return;
  }
  await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(account.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clear_login_credentials: true }),
  });
  if ($("personaAutoLoginPassword")) $("personaAutoLoginPassword").value = "";
  showMsg("commandMsg", "登录资料已删除。", true);
  await loadSocial();
}

async function submitPersonaLoginTask(autoSubmit = false) {
  const persona = selectedPersona();
  const account = selectedPersonaAutomationAccount(persona);
  if (!persona || !account) {
    showMsg("commandMsg", "请先选择执行账号。", false);
    return;
  }
  if (!autoSubmit) {
    const result = await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(account.id)}/open_login`, { method: "POST" });
    const task = result.task || {};
    const taskId = String(task.id || "").trim();
    state.personaAutomationResults[personaAutomationResultKey(account.id, "login")] = renderSocialTaskResult(task, [], "提交后，这里会显示任务状态、截图和执行日志。");
    updatePersonaAutomationResultView(account.id, "login");
    if (taskId) watchPersonaAutomationTask(taskId, account.id, "login").catch(() => {});
    showMsg("commandMsg", `登录窗口任务已提交：${result.task?.id || ""}`, true);
    await loadSocial();
    return;
  }
  const loginUsername = String($("personaAutoLoginUsername")?.value || account.login_username || account.username || "").trim();
  const loginPassword = String($("personaAutoLoginPassword")?.value || "");
  if (!loginUsername || (!loginPassword && !account.login_password_configured)) {
    showMsg("commandMsg", "请填写登录账号和密码，或先保存长期登录资料。", false);
    return;
  }
  const payload = {
    auto_submit: true,
    login_username: loginUsername,
    login_wait_seconds: 600,
  };
  if (loginPassword) payload.login_password = loginPassword;
  const result = await api("/api/persona_dashboard/automation/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      persona_id: persona.id,
      account_id: account.id,
      platform: account.platform || selectedPersonaAutomationPlatform(),
      task_type: "open_login",
      priority: 20,
      max_retries: 0,
      payload,
    }),
  });
  {
    const task = result.task || {};
    const taskId = String(task.id || "").trim();
    state.personaAutomationResults[personaAutomationResultKey(account.id, "login")] = renderSocialTaskResult(task, [], "提交后，这里会显示任务状态、截图和执行日志。");
    updatePersonaAutomationResultView(account.id, "login");
    if (taskId) watchPersonaAutomationTask(taskId, account.id, "login").catch(() => {});
  }
  showMsg("commandMsg", `自动登录任务已提交：${result.task?.id || ""}`, true);
  if ($("personaAutoLoginPassword")) $("personaAutoLoginPassword").value = "";
  await loadSocial();
}

async function checkPersonaLogin() {
  const persona = selectedPersona();
  const account = selectedPersonaAutomationAccount(persona);
  if (!account) {
    showMsg("commandMsg", "请先选择执行账号。", false);
    return;
  }
  const result = await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(account.id)}/check_login`, { method: "POST" });
  const task = result.task || {};
  const taskId = String(task.id || "").trim();
  state.personaAutomationResults[personaAutomationResultKey(account.id, "login")] = renderSocialTaskResult(task, [], "提交后，这里会显示任务状态、截图和执行日志。");
  updatePersonaAutomationResultView(account.id, "login");
  if (taskId) watchPersonaAutomationTask(taskId, account.id, "login").catch(() => {});
  showMsg("commandMsg", `登录检查任务已提交：${result.task?.id || ""}`, true);
  await loadSocial();
}

function buildPersonaThreadsTaskPayload(kind) {
  const strategyGroup = kind === "reply_hot"
    ? "threads_hot_reply"
    : kind === "warmup"
      ? "threads_warmup"
      : "threads_comment_reply";
  const strategy = personaThreadsStrategy(strategyGroup);
  const payload = { ...(strategy?.payload || {}) };
  if (kind === "reply_comment" || kind === "reply_hot") {
    if (personaThreadsStrategyIsCustom(strategyGroup)) {
      payload.max_age_days = numberField("personaAutoMaxAgeDays", payload.max_age_days || (kind === "reply_hot" ? 30 : 2));
      payload.max_posts = numberField("personaAutoMaxPosts", payload.max_posts || 5);
      payload.max_replies = numberField("personaAutoMaxReplies", payload.max_replies || 3);
      if (kind === "reply_hot") {
        payload.min_views = numberField("personaAutoMinViews", payload.min_views || 0);
        payload.target_urls = splitLines($("personaAutoTargetUrls")?.value || "");
      }
    }
    const replyTemplates = splitLines($("personaAutoReplyText")?.value || "");
    if (replyTemplates.length) payload.reply_templates = replyTemplates;
    return payload;
  }
  if (personaThreadsStrategyIsCustom(strategyGroup)) {
    payload.browse_limit = numberField("personaAutoBrowseLimit", payload.browse_limit || payload.scroll_times || 30);
    payload.scroll_times = payload.browse_limit;
    payload.like_limit = numberField("personaAutoLikeLimit", payload.like_limit || 0);
    payload.max_comments = numberField("personaAutoMaxComments", payload.max_comments || 0);
    payload.comment_chance = Number(payload.max_comments || 0) > 0 ? 100 : 0;
  }
  const replyTemplates = splitLines($("personaAutoReplyText")?.value || "");
  if (replyTemplates.length) payload.reply_templates = replyTemplates;
  return payload;
}

async function runPersonaThreadsTask(kind) {
  const persona = selectedPersona();
  const account = selectedPersonaAutomationAccount(persona, "threads");
  if (!persona || !account) {
    showMsg("commandMsg", "请先绑定并选择 Threads 执行账号。", false);
    return;
  }
  const taskType = kind === "warmup" ? "threads_warmup" : "threads_auto_reply";
  const result = await api("/api/persona_dashboard/automation/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      persona_id: persona.id,
      account_id: account.id,
      platform: "threads",
      task_type: taskType,
      priority: 50,
      max_retries: 2,
      payload: buildPersonaThreadsTaskPayload(kind),
    }),
  });
  {
    const task = result.task || {};
    const taskId = String(task.id || "").trim();
    const step = currentPersonaGroupStep("account", selectedPersonaProfile()) || (kind === "warmup" ? "warmup" : kind);
    state.personaAutomationResults[personaAutomationResultKey(account.id, step)] = renderSocialTaskResult(task, [], "提交后，这里会显示任务状态、截图和执行日志。");
    updatePersonaAutomationResultView(account.id, step);
    if (taskId) watchPersonaAutomationTask(taskId, account.id, step).catch(() => {});
  }
  showMsg("commandMsg", `${kind === "warmup" ? "养号" : "自动回复"}任务已提交：${result.task?.id || ""}`, true);
  await loadSocial();
}

async function clearPersonaAutomationTasks() {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  await api(`/api/persona_dashboard/automation/tasks?persona_id=${encodeURIComponent(persona.id)}`, { method: "DELETE" });
  showMsg("commandMsg", "该人设的自动化队列已清理。", true);
  await loadSocial();
}

async function executeSimpleFlow() {
  if (state.activeModule === "queue") {
    setView("tasks");
    await loadTasks();
    await loadSocial();
    showMsg("commandMsg", "已打开任务队列。取消、重试和日志都在对应任务行内执行。", true);
    return;
  }
  if (state.activeModule === "publishing" || state.activeModule === "automation") {
    let accountId = $("simpleAccount")?.value || "";
    const personaId = $("simplePersona")?.value || selectedPersona()?.id || "";
    if (state.activeModule === "publishing") {
      const persona = state.personas.find((item) => String(item.id) === String(personaId)) || selectedPersona();
      accountId = publishAccountForPersona(persona)?.id || "";
    }
    if (!accountId) {
      showMsg("commandMsg", state.activeModule === "publishing" ? "当前人设没有可用的 Threads 或 Instagram 执行账号。" : "请先选择执行账号。", false);
      return;
    }
    const taskType = $("simplePrimary")?.value || selectedBranch(state.activeModule);
    await createSocialTask(taskType, accountId, personaId, "commandMsg");
    appendEvent("browser", `${taskType} 已提交到指纹浏览器任务队列`);
    return;
  }
  setView("workspace");
}

async function loadMe() {
  try {
    const me = await api("/api/me");
    $("consoleMeName").textContent = me.username || "-";
    if (me.is_admin) $("openAdmin").hidden = false;
  } catch (error) {
    $("consoleMeName").textContent = "本地控制台";
    $("openAdmin").hidden = true;
    appendEvent("error", error.detail || error.message || "本地控制台会话不可用");
  }
}

async function loadSetupStatus() {
  try {
    state.setupStatus = await api("/api/quick_setup/status");
  } catch (error) {
    state.setupStatus = null;
    appendEvent("warning", error.detail || error.message || "读取运行配置失败");
  }
}

async function loadPersonas() {
  const data = await api("/api/persona_dashboard/overview").catch(() => ({ personas: [] }));
  state.personas = Array.isArray(data.personas) ? data.personas : [];
  state.personaCollections = data.persona_groups && Array.isArray(data.persona_groups.groups)
    ? data.persona_groups
    : { groups: [], assigned_persona_ids: [] };
  if (!state.selectedPersonaId && state.personas[0]) state.selectedPersonaId = state.personas[0].id;
  if (!state.personas.some((item) => String(item.id) === String(state.selectedPersonaId)) && state.personas[0]) {
    state.selectedPersonaId = state.personas[0].id;
  }
  const validIds = new Set(state.personas.map((item) => String(item.id)));
  Object.keys(state.personaProfiles).forEach((id) => {
    if (!validIds.has(id)) delete state.personaProfiles[id];
  });
  Object.keys(state.personaMemories).forEach((id) => {
    if (!validIds.has(id)) delete state.personaMemories[id];
  });
  Object.keys(state.personaDraftPosts).forEach((id) => {
    if (!validIds.has(id)) delete state.personaDraftPosts[id];
  });
  Object.keys(state.personaPublishHistories).forEach((id) => {
    if (!validIds.has(id)) delete state.personaPublishHistories[id];
  });
  Object.keys(state.personaForms).forEach((id) => {
    if (!validIds.has(id)) delete state.personaForms[id];
  });
  Object.keys(state.personaPublishResults).forEach((id) => {
    if (!validIds.has(id)) delete state.personaPublishResults[id];
  });
  Object.keys(state.personaPublishWatchers).forEach((id) => {
    if (!validIds.has(id)) delete state.personaPublishWatchers[id];
  });
  if (state.selectedPersonaId) {
    Promise.all([
      loadPersonaProfile(state.selectedPersonaId).catch(() => {}),
      loadPersonaDraftPosts(state.selectedPersonaId).catch(() => {}),
      loadPersonaMemories(state.selectedPersonaId).catch(() => {}),
      loadPersonaPublishHistory(state.selectedPersonaId).catch(() => {}),
    ]).catch(() => {});
  }
  if (state.activeModule === "personas") renderPersonaModule();
}

async function refreshPersonaCollections(message = "") {
  await loadPersonas();
  if (message) showMsg("commandMsg", message, true);
}

async function createPersonaCollection(name, personaId = "") {
  const cleanName = String(name || "").trim();
  if (!cleanName) {
    showMsg("commandMsg", "请先填写分组名称。", false);
    return null;
  }
  const result = await api("/api/persona_dashboard/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: cleanName }),
  });
  const group = result.group || null;
  if (group && personaId) {
    await api(`/api/persona_dashboard/groups/${encodeURIComponent(group.id)}/personas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona_id: personaId }),
    });
  }
  if (!personaId) {
    state.personaNewGroupName = "";
    window.__personaNewGroupName = "";
  }
  await refreshPersonaCollections(personaId ? "已新建分组并加入人设。" : "已新建分组。");
  return group;
}

function bindPersonaGroupCreateControl() {
  const input = $("personaNewGroupName");
  const button = $("personaCreateGroupButton");
  if (!input || !button) return;
  const syncName = () => {
    state.personaNewGroupName = input.value || "";
    window.__personaNewGroupName = state.personaNewGroupName;
  };
  const submit = (event) => {
    event.preventDefault();
    event.stopPropagation();
    syncName();
    createPersonaCollection(input.value || state.personaNewGroupName || window.__personaNewGroupName || "").catch((error) => {
      showMsg("commandMsg", error.detail || error.message || "建组失败", false);
    });
  };
  button.addEventListener("click", submit);
  input.addEventListener("input", syncName);
  input.addEventListener("change", syncName);
  input.addEventListener("blur", syncName);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit(event);
  });
}

async function togglePersonaCollection(groupId) {
  const group = personaCollectionGroups().find((item) => String(item.id) === String(groupId));
  if (!group) return;
  await api(`/api/persona_dashboard/groups/${encodeURIComponent(group.id)}/collapse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ collapsed: !group.collapsed }),
  });
  await refreshPersonaCollections();
}

async function renamePersonaCollection(groupId) {
  const group = personaCollectionGroups().find((item) => String(item.id) === String(groupId));
  if (!group) return;
  const name = await openConsoleModal({
    title: "重命名分组",
    inputLabel: "分组名称",
    inputValue: group.name || "",
    confirmText: "保存",
  });
  if (name === null) return;
  await api(`/api/persona_dashboard/groups/${encodeURIComponent(group.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await refreshPersonaCollections("已重命名分组。");
}

async function deletePersonaCollection(groupId) {
  const group = personaCollectionGroups().find((item) => String(item.id) === String(groupId));
  if (!group) return;
  const confirmed = await openConsoleModal({
    title: "删除分组",
    message: `删除分组「${group.name}」？人设不会被删除。`,
    confirmText: "删除",
    danger: true,
  });
  if (!confirmed) return;
  await api(`/api/persona_dashboard/groups/${encodeURIComponent(group.id)}`, { method: "DELETE" });
  await refreshPersonaCollections("已删除分组，人设已回到未分组或其他组。");
}

async function addPersonaToCollection(personaId, groupId) {
  if (!personaId || !groupId) {
    showMsg("commandMsg", "请先选择分组。", false);
    return;
  }
  await api(`/api/persona_dashboard/groups/${encodeURIComponent(groupId)}/personas`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona_id: personaId }),
  });
  state.personaListEditorId = personaId;
  await refreshPersonaCollections("已加入分组。");
}

async function removePersonaFromCollection(personaId, groupId) {
  if (!personaId || !groupId) return;
  await api(`/api/persona_dashboard/groups/${encodeURIComponent(groupId)}/personas/${encodeURIComponent(personaId)}`, { method: "DELETE" });
  state.personaListEditorId = personaId;
  await refreshPersonaCollections("已移出分组。");
}

async function ungroupPersona(personaId) {
  const groups = personaGroupsForPersona(personaId);
  await Promise.all(groups.map((group) => api(`/api/persona_dashboard/groups/${encodeURIComponent(group.id)}/personas/${encodeURIComponent(personaId)}`, { method: "DELETE" })));
  state.personaListEditorId = personaId;
  await refreshPersonaCollections("已单独拆出。");
}

async function loadPersonaProfile(personaId, { force = false } = {}) {
  const key = String(personaId || "").trim();
  if (!key) return null;
  if (!force && state.personaProfiles[key]) return state.personaProfiles[key];
  const persona = state.personas.find((item) => String(item.id) === key) || null;
  if (persona) state.personaProfiles[key] = fallbackPersonaProfile(persona);
  let profile = null;
  try {
    profile = await api(`/api/persona_dashboard/personas/${encodeURIComponent(key)}/profile`);
  } catch (error) {
    if (error?.detail && String(error.detail).includes("不存在") && persona) {
      profile = fallbackPersonaProfile(persona);
      appendEvent("persona", `人设 ${persona.name || persona.id} 暂无独立 profile，已改用概览数据兜底。`);
    } else {
      throw error;
    }
  }
  state.personaProfiles[key] = profile;
  if (!state.personaLinkPresetId || key === String(state.selectedPersonaId || "")) {
    const presets = Array.isArray(profile.link_presets) ? profile.link_presets : [];
    const activeId = String(profile.active_link_preset_id || "").trim();
    state.personaLinkPresetId = (activeId && presets.some((item) => String(item.id) === activeId))
      ? activeId
      : (presets[0]?.id || "");
  }
  if (state.activeModule === "personas" && key === String(state.selectedPersonaId || "")) renderPersonaDetail();
  return profile;
}

function automationScreenshotUrlFromPath(pathValue) {
  const value = String(pathValue || "").trim();
  if (!value) return "";
  if (value.startsWith("/api/")) return directMediaPreviewUrl(value);
  const parts = value.split(/[\\/]/).filter(Boolean);
  const filename = parts[parts.length - 1] || "";
  return filename ? `/api/persona_dashboard/automation/screenshots/${encodeURIComponent(filename)}` : "";
}

function latestSocialTaskScreenshot(task, logs = []) {
  const result = task?.result || {};
  const direct = directMediaPreviewUrl(result.screenshot_url || result.screenshotUrl);
  if (direct) return direct;
  const directFromPath = automationScreenshotUrlFromPath(result.screenshot_path || result.screenshotPath || result.screenshot);
  if (directFromPath) return directFromPath;
  const checkpoints = Array.isArray(result.checkpoints) ? result.checkpoints : [];
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index] || {};
    const checkpointUrl = directMediaPreviewUrl(checkpoint.screenshot_url || checkpoint.screenshotUrl);
    if (checkpointUrl) return checkpointUrl;
    const checkpointPath = automationScreenshotUrlFromPath(checkpoint.screenshot_path || checkpoint.screenshotPath || checkpoint.screenshot);
    if (checkpointPath) return checkpointPath;
  }
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index] || {};
    const logUrl = directMediaPreviewUrl(log.screenshot_url);
    if (logUrl) return logUrl;
    const logPath = automationScreenshotUrlFromPath(log.screenshot_path);
    if (logPath) return logPath;
  }
  return "";
}

function renderPersonaPublishResult(task, logs = []) {
  return renderSocialTaskResult(task, logs, "提交后，这里会显示任务状态、截图和发布结果。");
}

function renderSocialTaskResult(task, logs = [], emptyText = "提交后，这里会显示任务状态、截图和执行结果。") {
  if (!task || !task.id) return `<div class="empty-state">${esc(emptyText)}</div>`;
  const result = task.result || {};
  const screenshotUrl = latestSocialTaskScreenshot(task, logs);
  const publishedUrl = String(result.published_url || result.publishedUrl || result.url || result.post_url || "").trim();
  const recentLogs = (logs || []).slice(-4).reverse();
  const terminal = ["success", "failed", "cancelled", "need_manual"].includes(String(task.status || ""));
  const screenshotReason = legacyMediaPreviewReason(screenshotUrl);
  const screenshotGroupId = screenshotUrl && !screenshotReason
    ? registerMediaPreviewGroup([{ previewUrl: screenshotUrl, type: "image", label: "任务截图" }])
    : "";
  return `
    <div class="persona-inline-panel persona-publish-result-card">
      <div class="flow-box">
        <span>任务状态</span>
        <strong>${esc(statusLabel(task.status || ""))}</strong>
        <span>${esc(task.id || "")}</span>
      </div>
      ${task.error ? `<div class="persona-warning-inline">${esc(task.error)}</div>` : ""}
      ${publishedUrl ? `<div class="row-actions"><a href="${esc(publishedUrl)}" target="_blank" rel="noopener">查看任务结果</a></div>` : ""}
      ${screenshotUrl
        ? (screenshotReason
          ? `<div class="publish-result-link is-unavailable"><div class="persona-media-frame persona-media-frame--empty"><strong>媒体不可预览</strong><small>${esc(screenshotReason)}</small></div></div>`
          : renderMediaPreviewButton({ previewUrl: screenshotUrl, type: "image", label: "任务截图" }, screenshotGroupId, 0, { className: "publish-result-link", frameClass: "publish-result-image", caption: "任务截图" }))
        : `<div class="empty-state">${terminal ? "当前任务没有返回截图。" : "执行中，截图生成后会显示在这里。"}</div>`}
      ${recentLogs.length ? `<div class="compact-list">${recentLogs.map((log) => `
        <article class="compact-row compact-row-log">
          <strong>${esc(logStageLabel(log.stage, log.level))}</strong>
          <p>${esc(log.message || JSON.stringify(log.data || {}))}</p>
          <span>${esc(formatTime(log.created_at || ""))}</span>
        </article>`).join("")}</div>` : ""}
    </div>`;
}

function updatePersonaPublishResultView(personaId) {
  const currentPersonaId = String(selectedPersona()?.id || "");
  if (String(personaId || "") !== currentPersonaId) return;
  const host = $("personaPublishResult");
  if (!host) return;
  host.innerHTML = state.personaPublishResults[currentPersonaId] || `<div class="empty-state">提交后，这里会显示任务状态、截图和发布结果。</div>`;
}

function latestAutomationTaskForAccount(accountId, step) {
  const cleanAccountId = String(accountId || "").trim();
  const taskTypes = personaAutomationTaskTypesForStep(step);
  if (!cleanAccountId || !taskTypes.length) return null;
  const tasks = (state.socialTasks || []).filter((task) =>
    String(task?.account_id || "").trim() === cleanAccountId
    && taskTypes.includes(String(task?.task_type || "").trim())
  );
  if (!tasks.length) return null;
  tasks.sort((a, b) => Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0));
  return tasks[0] || null;
}

function updatePersonaAutomationResultView(accountId, step) {
  const persona = selectedPersona();
  const account = selectedPersonaAutomationAccount(persona, selectedPersonaAutomationPlatform());
  if (!account || String(account.id || "") !== String(accountId || "")) return;
  const profile = selectedPersonaProfile();
  if (currentPersonaGroupStep("account", profile) !== step) return;
  const host = $("personaAutomationResult");
  if (!host) return;
  host.innerHTML = state.personaAutomationResults[personaAutomationResultKey(accountId, step)]
    || `<div class="empty-state">提交后，这里会显示任务状态、截图和执行日志。</div>`;
}

async function ensurePersonaAutomationResultLoaded(accountId, step) {
  const key = personaAutomationResultKey(accountId, step);
  if (!accountId || !step || state.personaAutomationResults[key]) return;
  const task = latestAutomationTaskForAccount(accountId, step);
  if (!task || !task.id) return;
  state.personaAutomationResults[key] = renderSocialTaskResult(task, [], "提交后，这里会显示任务状态、截图和执行日志。");
  updatePersonaAutomationResultView(accountId, step);
  const logsData = await api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(task.id)}/logs`).catch(() => ({ logs: [] }));
  const logs = Array.isArray(logsData?.logs) ? logsData.logs : [];
  state.personaAutomationResults[key] = renderSocialTaskResult(task, logs, "提交后，这里会显示任务状态、截图和执行日志。");
  updatePersonaAutomationResultView(accountId, step);
}

async function watchPersonaAutomationTask(taskId, accountId, step) {
  const key = personaAutomationResultKey(accountId, step);
  if (!key || !taskId) return;
  state.personaAutomationWatchers[key] = taskId;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (state.personaAutomationWatchers[key] !== taskId) return;
    const [taskData, logData] = await Promise.all([
      api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(taskId)}`).catch(() => null),
      api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(taskId)}/logs`).catch(() => ({ logs: [] })),
    ]);
    const task = taskData?.task || null;
    const logs = Array.isArray(logData?.logs) ? logData.logs : [];
    if (task) {
      state.personaAutomationResults[key] = renderSocialTaskResult(task, logs, "提交后，这里会显示任务状态、截图和执行日志。");
      updatePersonaAutomationResultView(accountId, step);
      if (["success", "failed", "cancelled", "need_manual"].includes(String(task.status || ""))) {
        delete state.personaAutomationWatchers[key];
        await loadSocial().catch(() => {});
        await loadPersonas().catch(() => {});
        return;
      }
    }
    await sleep(2000);
  }
}

function latestPersonaPublishTask(personaId) {
  const key = String(personaId || "").trim();
  if (!key) return null;
  const tasks = (state.socialTasks || []).filter((task) =>
    String(task?.persona_id || "").trim() === key && String(task?.task_type || "").trim() === "publish_post"
  );
  if (!tasks.length) return null;
  tasks.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
  return tasks[0] || null;
}

async function ensurePersonaPublishResultLoaded(personaId) {
  const key = String(personaId || "").trim();
  if (!key || state.personaPublishResults[key]) return;
  const task = latestPersonaPublishTask(key);
  if (!task || !task.id) return;
  state.personaPublishResults[key] = renderPersonaPublishResult(task, []);
  updatePersonaPublishResultView(key);
  const logsData = await api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(task.id)}/logs`).catch(() => ({ logs: [] }));
  const logs = Array.isArray(logsData?.logs) ? logsData.logs : [];
  state.personaPublishResults[key] = renderPersonaPublishResult(task, logs);
  updatePersonaPublishResultView(key);
}

async function watchPersonaPublishTask(taskId, personaId) {
  const key = String(personaId || "").trim();
  if (!key || !taskId) return;
  state.personaPublishWatchers[key] = taskId;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (state.personaPublishWatchers[key] !== taskId) return;
    const [taskData, logData] = await Promise.all([
      api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(taskId)}`).catch(() => null),
      api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(taskId)}/logs`).catch(() => ({ logs: [] })),
    ]);
    const task = taskData?.task || null;
    const logs = Array.isArray(logData?.logs) ? logData.logs : [];
    if (task) {
      state.personaPublishResults[key] = renderPersonaPublishResult(task, logs);
      updatePersonaPublishResultView(key);
      if (["success", "failed", "cancelled", "need_manual"].includes(String(task.status || ""))) {
        delete state.personaPublishWatchers[key];
        await loadSocial().catch(() => {});
        await loadPersonas().catch(() => {});
        return;
      }
    }
    await sleep(2000);
  }
}

async function loadPersonaDraftPosts(personaId, { force = false } = {}) {
  const key = String(personaId || "").trim();
  if (!key) return [];
  if (!force && Array.isArray(state.personaDraftPosts[key])) return state.personaDraftPosts[key];
  const data = await api(`/api/persona_dashboard/personas/${encodeURIComponent(key)}/posts`).catch(() => ({ posts: [] }));
  const posts = sortPersonaDraftPosts(Array.isArray(data.posts) ? data.posts : []);
  state.personaDraftPosts[key] = posts;
  const currentSelected = String(state.selectedPersonaPostId || "").trim();
  if (!posts.some((post) => String(post.id) === currentSelected)) {
    state.selectedPersonaPostId = posts[0]?.id || "";
  }
  if (state.activeModule === "personas" && key === String(state.selectedPersonaId || "")) renderPersonaDetail();
  return posts;
}

async function loadPersonaMemories(personaId, { force = false } = {}) {
  const key = String(personaId || "").trim();
  if (!key) return [];
  if (!force && Array.isArray(state.personaMemories[key])) return state.personaMemories[key];
  const data = await api(`/api/persona_dashboard/personas/${encodeURIComponent(key)}/memories`).catch(() => ({ memories: [] }));
  const rows = Array.isArray(data.memories) ? data.memories : [];
  state.personaMemories[key] = rows;
  if (state.activeModule === "personas" && key === String(state.selectedPersonaId || "")) renderPersonaDetail();
  return rows;
}

async function loadPersonaImageLibrary(personaId, { force = false } = {}) {
  const key = String(personaId || "").trim();
  if (!key) return null;
  if (!force && state.personaImageLibraries[key]) return state.personaImageLibraries[key];
  const data = await api(`/api/persona_dashboard/personas/${encodeURIComponent(key)}/images`).catch(() => ({ ok: true, items: [], current_reference_url: "", is_workflow_persona: false }));
  state.personaImageLibraries[key] = data;
  if (state.activeModule === "personas" && key === String(state.selectedPersonaId || "")) renderPersonaDetail();
  return data;
}

async function loadPersonaPublishHistory(personaId, { force = false } = {}) {
  const key = String(personaId || "").trim();
  if (!key) return [];
  if (!force && Array.isArray(state.personaPublishHistories[key])) return state.personaPublishHistories[key];
  const fallbackPersona = state.personas.find((item) => String(item.id) === key) || null;
  const fallbackRows = sortPersonaPublishHistory(Array.isArray(fallbackPersona?.publish_history) ? fallbackPersona.publish_history : []);
  const data = await api(`/api/persona_dashboard/personas/${encodeURIComponent(key)}/publish_history`).catch(() => ({ publish_history: fallbackRows }));
  const apiRows = Array.isArray(data.publish_history) ? data.publish_history : [];
  const rows = sortPersonaPublishHistory(apiRows.length ? apiRows : fallbackRows);
  state.personaPublishHistories[key] = rows;
  if (state.activeModule === "personas" && key === String(state.selectedPersonaId || "")) renderPersonaDetail();
  return rows;
}

async function createPersonaArchive() {
  const name = $("personaCreateName")?.value.trim() || "";
  const content = $("personaCreateContent")?.value.trim() || "";
  if (!name) {
    showMsg("commandMsg", "请先填写人设名称。", false);
    return;
  }
  if (!content) {
    showMsg("commandMsg", "请先填写人设简介。", false);
    return;
  }
  showMsg("commandMsg", "正在新建人设...", true);
  const result = await api("/api/persona_dashboard/personas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, content }),
  });
  state.selectedPersonaId = result.id || state.selectedPersonaId;
  state.selectedPersonaPostId = "";
  state.personaGroup = "content";
  state.personaPanels.content = "generate";
  state.personaCreateMode = false;
  if ($("personaCreateName")) $("personaCreateName").value = "";
  if ($("personaCreateContent")) $("personaCreateContent").value = "";
  showMsg("commandMsg", `人设已创建：${result.name || result.id || "-"}`, true);
  await loadPersonas();
  await loadPersonaProfile(state.selectedPersonaId, { force: true }).catch(() => {});
  await loadPersonaDraftPosts(state.selectedPersonaId, { force: true }).catch(() => {});
  renderConfirmSummary();
}

function generatePersonaPayloadFromState(persona, profile = selectedPersonaProfile()) {
  const form = personaFormState(persona.id).generate;
  const contentBranch = resolvedPersonaGenerateBranch(profile, form);
  return {
    count: Number(form.count || 3),
    prompt: String(form.prompt || "").trim(),
    target_words: Number(form.targetWords || 120),
    content_branch: contentBranch,
    text_model_branch: contentBranch === "r18" ? "paid" : "free",
    content_time_slot: String(form.contentTimeSlot || "").trim(),
    selected_memory_ids: Array.isArray(form.selectedMemoryIds) ? form.selectedMemoryIds : [],
  };
}

async function generatePersonaDraftPosts() {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  snapshotPersonaCurrentForm();
  const profile = selectedPersonaProfile();
  const preflight = personaGeneratePreflight();
  if (!preflight.ready) {
    showMsg("commandMsg", `${preflight.issues.join(" / ")}，请先补齐配置。`, false);
    return;
  }
  const payload = generatePersonaPayloadFromState(persona, profile);
  showMsg("commandMsg", "正在按当前人设自动生成草稿...", true);
  const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/generate_posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await loadPersonaDraftPosts(persona.id, { force: true });
  const generatedPosts = Array.isArray(result.posts) ? result.posts : [];
  const generatedIds = new Set(generatedPosts.map((post) => String(post?.id || "")).filter(Boolean));
  const latestGenerated = personaDraftPosts(persona).find((post) => generatedIds.has(String(post?.id || "")));
  state.selectedPersonaPostId = latestGenerated?.id || generatedPosts[0]?.id || state.selectedPersonaPostId;
  state.personaPanels.content = "posts";
  renderConfirmSummary();
  showMsg("commandMsg", `已生成草稿 ${result.generated_count || generatedPosts.length || 0} 条。`, true);
}

async function createPersonaDraftPost() {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  snapshotPersonaCurrentForm();
  const form = personaFormState(persona.id).draft;
  const title = String(form.title || "").trim();
  const content = String(form.content || "").trim();
  if (!content) {
    showMsg("commandMsg", "请先填写推文正文。", false);
    return;
  }
  showMsg("commandMsg", "正在保存推文草稿...", true);
  const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, content }),
  });
  state.selectedPersonaPostId = result.id || "";
  state.personaPanels.content = "posts";
  personaFormState(persona.id).draft = { title: "", content: "" };
  if ($("personaDraftTitle")) $("personaDraftTitle").value = "";
  if ($("personaDraftContent")) $("personaDraftContent").value = "";
  await loadPersonaDraftPosts(persona.id, { force: true });
  renderConfirmSummary();
  showMsg("commandMsg", `草稿已保存：${result.title || result.id || "-"}`, true);
}

async function submitPersonaImageGeneration() {
  const persona = selectedPersona();
  const profile = selectedPersonaProfile();
  if (!persona || !profile) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  if (profile.is_workflow_persona) {
    showMsg("commandMsg", "工作流人设不需要单独生成人设图。", false);
    return;
  }
  snapshotPersonaCurrentForm();
  const form = personaFormState(persona.id).images;
  showMsg("commandMsg", "正在生成人设图...", true);
  const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/images/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: String(form.prompt || "").trim(),
      aspect_ratio: String(form.aspectRatio || "1:1"),
      mode: "person",
    }),
  });
  state.personaImageLibraries[String(persona.id)] = result;
  await Promise.all([
    loadPersonas(),
    loadPersonaProfile(persona.id, { force: true }).catch(() => {}),
  ]);
  renderPersonaDetail();
  showMsg("commandMsg", "人设图已生成并写入图库。", true);
}

async function refreshPersonaMediaTask(personaId, postId, taskId) {
  const detail = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
  const key = personaMediaTaskKey(personaId, postId);
  state.personaMediaTasks[key] = {
    taskId,
    taskType: String(detail.type || "").trim(),
    status: String(detail.status || "").trim(),
    detail,
  };
  if (
    String(selectedPersona()?.id || "") === String(personaId || "")
    && String(selectedPersonaPost()?.id || "") === String(postId || "")
    && state.personaGroup === "content"
    && currentPersonaGroupStep("content", selectedPersonaProfile()) === "media"
  ) {
    renderPersonaDetail();
    renderConfirmSummary();
  }
  return detail;
}

async function watchPersonaMediaTask(personaId, postId, taskId) {
  const key = personaMediaTaskKey(personaId, postId);
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const current = state.personaMediaTasks[key];
    if (!current || String(current.taskId || "") !== String(taskId || "")) return;
    const detail = await refreshPersonaMediaTask(personaId, postId, taskId).catch(() => null);
    const status = String(detail?.status || "").trim();
    if (["success", "failed", "cancelled"].includes(status)) {
      await loadTasks().catch(() => {});
      return;
    }
    await sleep(2000);
  }
}

async function submitPersonaMediaTask() {
  const persona = selectedPersona();
  const profile = selectedPersonaProfile();
  const post = selectedPersonaPost(persona);
  if (!persona || !profile || !post) {
    showMsg("commandMsg", "请先选中一条草稿。", false);
    return;
  }
  snapshotPersonaCurrentForm();
  const form = personaFormState(persona.id).media;
  const taskType = String(form.taskType || "text_to_image");
  const files = filesFromInput("personaMediaTaskFiles");
  const imageCount = files.filter((file) => fileKind(file) === "image").length;
  const minImages = Number(taskMeta[taskType]?.minImages || 0);
  if (imageCount < minImages) {
    showMsg("commandMsg", `当前任务至少需要 ${minImages} 张图片素材。`, false);
    return;
  }
  const fallbackPrompt = String(post.content || "").trim();
  const prompt = String(form.prompt || "").trim() || fallbackPrompt;
  if (["text_to_image", "video_i2v"].includes(taskType) && !prompt) {
    showMsg("commandMsg", "当前草稿没有正文，请补充提示词后再生成。", false);
    return;
  }
  const params = compactPayload({
    prompt,
    prompt_text: prompt,
    message: prompt,
    persona_enabled: true,
    persona_label: String(persona.name || profile.name || "").trim(),
    tg_generation_context: String(profile.content || persona.content || "").trim(),
    tg_use_llm_prompt: true,
    related_persona_id: String(persona.id || "").trim(),
    related_post_id: String(post.id || "").trim(),
    draft_source_text: fallbackPrompt,
    aspect_ratio: ["text_to_image", "image_generate"].includes(taskType) ? String(form.aspectRatio || "1:1") : undefined,
    resolution: taskType === "video_i2v" ? String(form.resolution || "720p") : undefined,
    duration_seconds: taskType === "video_i2v" ? Math.min(Math.max(Number(form.duration || 2), 2), 15) : undefined,
  });
  const body = new FormData();
  body.append("task_type", taskType);
  body.append("params_json", JSON.stringify(params));
  files.forEach((file) => body.append("files", file, file.name));
  showMsg("commandMsg", "正在提交推文配图任务...", true);
  const result = await api("/api/tasks/submit", { method: "POST", body });
  const key = personaMediaTaskKey(persona.id, post.id);
  state.personaMediaTasks[key] = {
    taskId: String(result.id || "").trim(),
    taskType,
    status: "queued",
    detail: {
      id: String(result.id || "").trim(),
      type: taskType,
      status: "queued",
      media_items: [],
    },
  };
  renderPersonaDetail();
  renderConfirmSummary();
  appendEvent("queued", `推文配图任务已创建：${result.id}`);
  watchTask(result.id);
  refreshPersonaMediaTask(persona.id, post.id, result.id).catch(() => {});
  watchPersonaMediaTask(persona.id, post.id, result.id).catch(() => {});
  await loadTasks().catch(() => {});
  showMsg("commandMsg", `推文配图任务已提交：${result.id}`, true);
}

async function attachPersonaTaskMediaToPost(replaceExisting = false) {
  const persona = selectedPersona();
  const post = selectedPersonaPost(persona);
  if (!persona || !post) {
    showMsg("commandMsg", "请先选中一条草稿。", false);
    return;
  }
  snapshotPersonaCurrentForm();
  const taskState = personaMediaTaskState(persona.id, post.id);
  if (!taskState?.taskId) {
    showMsg("commandMsg", "当前还没有可回写的媒体任务结果。", false);
    return;
  }
  showMsg("commandMsg", "正在把任务结果写回草稿媒体...", true);
  await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts/${encodeURIComponent(post.id)}/media/from_task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task_id: taskState.taskId,
      replace_existing: Boolean(replaceExisting),
    }),
  });
  await loadPersonaDraftPosts(persona.id, { force: true });
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", replaceExisting ? "任务结果已替换当前草稿媒体。" : "任务结果已追加到当前草稿。", true);
}

async function uploadPersonaPostMedia(replaceExisting = false) {
  const persona = selectedPersona();
  const post = selectedPersonaPost(persona);
  if (!persona || !post) {
    showMsg("commandMsg", "请先选中一条草稿。", false);
    return;
  }
  const files = filesFromInput("personaPostMediaUploadFiles");
  if (!files.length) {
    showMsg("commandMsg", "请先选择要上传的媒体文件。", false);
    return;
  }
  const body = new FormData();
  body.append("replace_existing", replaceExisting ? "1" : "0");
  files.forEach((file) => body.append("files", file, file.name));
  showMsg("commandMsg", replaceExisting ? "正在替换草稿媒体..." : "正在追加草稿媒体...", true);
  await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts/${encodeURIComponent(post.id)}/media/upload`, {
    method: "POST",
    body,
  });
  if ($("personaPostMediaUploadFiles")) $("personaPostMediaUploadFiles").value = "";
  await loadPersonaDraftPosts(persona.id, { force: true });
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", replaceExisting ? "草稿媒体已替换。" : "草稿媒体已追加。", true);
}

async function deletePersonaPostMedia(index) {
  const persona = selectedPersona();
  const post = selectedPersonaPost(persona);
  if (!persona || !post) {
    showMsg("commandMsg", "请先选中一条草稿。", false);
    return;
  }
  showMsg("commandMsg", "正在删除草稿媒体...", true);
  await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts/${encodeURIComponent(post.id)}/media/${encodeURIComponent(index)}`, {
    method: "DELETE",
  });
  await loadPersonaDraftPosts(persona.id, { force: true });
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", "草稿媒体已删除。", true);
}

function personaIsWorkflow(persona, profile = null) {
  if (typeof profile?.is_workflow_persona === "boolean") return profile.is_workflow_persona;
  if (typeof persona?.is_workflow_persona === "boolean") return persona.is_workflow_persona;
  return String(persona?.id || "").startsWith("workflow-persona-");
}

function personaKindLabel(persona, profile = null) {
  return personaIsWorkflow(persona, profile) ? "工作流" : "普通";
}

function renderPersonaSelectOptions(personas) {
  return (personas || []).map((persona) => {
    const kind = personaIsWorkflow(persona) ? "工作流" : "普通";
    return `<option value="${esc(persona.id)}" ${String(persona.id) === String(state.selectedPersonaId) ? "selected" : ""}>${esc(persona.name || persona.id)} · ${esc(kind)} · ${esc(personaBindingLabel(persona))}</option>`;
  }).join("");
}

function personaByIdMap() {
  return new Map(state.personas.map((persona) => [String(persona.id || ""), persona]));
}

function personaCollectionGroups() {
  const map = personaByIdMap();
  return (state.personaCollections?.groups || []).map((group) => ({
    ...group,
    persona_ids: (group.persona_ids || []).filter((id) => map.has(String(id))),
  }));
}

function personaAssignedIds() {
  const ids = new Set();
  personaCollectionGroups().forEach((group) => {
    (group.persona_ids || []).forEach((id) => ids.add(String(id)));
  });
  return ids;
}

function personaGroupsForPersona(personaId) {
  const id = String(personaId || "");
  return personaCollectionGroups().filter((group) => (group.persona_ids || []).some((item) => String(item) === id));
}

function renderPersonaKindBadge(persona) {
  return personaIsWorkflow(persona)
    ? `<span class="persona-kind-badge is-workflow">工作流</span>`
    : `<span class="persona-kind-badge">普通</span>`;
}

function renderPersonaCard(persona, groupId = "") {
  const selected = String(persona.id || "") === String(state.selectedPersonaId || "");
  const editing = String(state.personaListEditorId || "") === String(persona.id || "");
  const currentGroups = personaGroupsForPersona(persona.id);
  const availableGroups = personaCollectionGroups().filter((group) => !currentGroups.some((item) => item.id === group.id));
  const ungrouped = !currentGroups.length;
  return `
    <article class="persona-list-card ${selected ? "is-active" : ""} ${editing ? "is-editing" : ""}" data-persona-card="${esc(persona.id)}">
      <button type="button" class="persona-list-item" data-persona-select="${esc(persona.id)}">
        <span class="persona-card-title">
          <strong>${esc(persona.name || persona.id || "未命名人设")}</strong>
          ${renderPersonaKindBadge(persona)}
          ${ungrouped ? `<span class="persona-kind-badge persona-ungrouped-badge">未分组</span>` : ""}
        </span>
        <small>${esc(personaExecutionAccountLabel(persona))}</small>
      </button>
      <button type="button" class="persona-card-edit" data-persona-edit="${esc(persona.id)}" title="编辑分组" aria-label="编辑分组">...</button>
      ${editing ? `
        <div class="persona-card-menu">
          <label>加入已有组
            <select data-persona-add-group-select="${esc(persona.id)}">
              <option value="">选择分组</option>
              ${availableGroups.map((group) => `<option value="${esc(group.id)}">${esc(group.name)}</option>`).join("")}
            </select>
          </label>
          <button type="button" data-persona-add-selected-group="${esc(persona.id)}">加入</button>
          ${currentGroups.length ? `
            <div class="persona-editor-groups">
              ${currentGroups.map((group) => `
                <button type="button" data-persona-remove-from-group="${esc(persona.id)}" data-group-id="${esc(group.id)}">移出 ${esc(group.name)}</button>
              `).join("")}
            </div>
            <button type="button" data-persona-ungroup-all="${esc(persona.id)}">单独拆出来</button>
          ` : `<span class="persona-editor-empty">当前未加入任何组。</span>`}
        </div>
      ` : ""}
    </article>`;
}

function renderPersonaFolder(group, map) {
  const personas = (group.persona_ids || []).map((id) => map.get(String(id))).filter(Boolean);
  const collapsed = Boolean(group.collapsed);
  return `
    <div class="persona-layer-group ${collapsed ? "is-collapsed" : ""}">
      <div class="persona-layer-row persona-layer-row--group">
        <button type="button" class="persona-layer-toggle" data-persona-toggle-folder="${esc(group.id)}">${collapsed ? "展开" : "收起"}</button>
        <strong>${esc(group.name)}</strong>
        <span>${personas.length} 个</span>
        <button type="button" data-persona-rename-group="${esc(group.id)}">重命名</button>
        <button type="button" data-persona-delete-group="${esc(group.id)}">删除</button>
      </div>
      ${collapsed ? "" : `<div class="persona-layer-children">${personas.length ? personas.map((persona) => renderPersonaCard(persona, group.id)).join("") : `<div class="persona-layer-empty">这个组还没有人设。</div>`}</div>`}
    </div>`;
}

function renderPersonaUngrouped(personas) {
  if (!personas.length) return "";
  return personas.map((persona) => renderPersonaCard(persona)).join("");
}

function renderPersonaCollectionList() {
  const map = personaByIdMap();
  const groups = personaCollectionGroups();
  const assigned = personaAssignedIds();
  const ungrouped = state.personas.filter((persona) => !assigned.has(String(persona.id || "")));
  return `
    <div class="persona-list-stack">
      ${groups.map((group) => renderPersonaFolder(group, map)).join("")}
      ${renderPersonaUngrouped(ungrouped)}
    </div>`;
}

function renderPersonaGroupTabs(profile) {
  return `<div class="persona-group-tabs">${Object.entries(personaGroups).map(([key, group]) => `
    <button
      type="button"
      class="${state.personaGroup === key ? "is-active" : ""}"
      data-persona-group="${esc(key)}"
    >${esc(group.label)}</button>
  `).join("")}</div>`;
}

function renderPersonaStepTabs(groupKey, profile) {
  const step = currentPersonaGroupStep(groupKey, profile);
  if (groupKey === "content") {
    const tabs = [
      ["generate", "新建推文"],
      ["media", "推文配图 / 媒体"],
      ["overview", "人设内容"],
      ["posts", "草稿与历史"],
      ["publish", "选择草稿进入发布"],
    ];
    return `<div class="persona-step-tabs">${tabs.map(([value, label]) => `
      <button
        type="button"
        class="${(value === "posts" ? ["posts", "history"].includes(step) : value === step) ? "is-active" : ""}"
        data-persona-step="${esc(groupKey)}:${esc(value)}"
      >${esc(label)}</button>
    `).join("")}</div>`;
  }
  return `<div class="persona-step-tabs">${personaGroupStepOptions(groupKey, profile).map(([value, label]) => `
    <button
      type="button"
      class="${value === step ? "is-active" : ""}"
      data-persona-step="${esc(groupKey)}:${esc(value)}"
    >${esc(label)}</button>
  `).join("")}</div>`;
}

function renderPersonaPostsViewTabs(drafts, historyRows, activeStep) {
  const tabs = [
    ["posts", `待发布草稿 ${drafts.length}`],
    ["history", `发布历史 ${historyRows.length}`],
  ];
  return `<div class="persona-step-tabs">${tabs.map(([value, label]) => `
    <button
      type="button"
      class="${activeStep === value ? "is-active" : ""}"
      data-persona-step="content:${esc(value)}"
    >${esc(label)}</button>
  `).join("")}</div>`;
}

function renderPersonaGenerateModeTabs(mode) {
  const activeMode = mode === "custom" ? "custom" : "ai";
  const tabs = [
    ["ai", "AI 生成"],
    ["custom", "自定义输入"],
  ];
  return `<div class="persona-step-tabs persona-subflow-tabs">${tabs.map(([value, label]) => `
      <button
        type="button"
        class="${activeMode === value ? "is-active" : ""}"
        data-persona-generate-mode="${esc(value)}"
      >${esc(label)}</button>
  `).join("")}</div>`;
}

function personaMediaTaskOptions() {
  return [
    ["text_to_image", "根据推文生图"],
    ["image_generate", "图片生成"],
    ["single_image_edit", "单图编辑"],
    ["get_nano_banana", "双图编辑"],
    ["face_swap", "人物换脸"],
    ["video_i2v", "图生视频"],
  ];
}

function renderPersonaMediaTaskTabs(taskType) {
  const active = String(taskType || "text_to_image");
  return `<div class="persona-step-tabs persona-subflow-tabs">${personaMediaTaskOptions().map(([value, label]) => `
    <button
      type="button"
      class="${active === value ? "is-active" : ""}"
      data-persona-media-task="${esc(value)}"
    >${esc(label)}</button>
  `).join("")}</div>`;
}

function taskOutputMediaItems(detail = {}) {
  const rows = Array.isArray(detail?.media_items) ? detail.media_items : [];
  return rows.map((item) => {
    const previewUrl = String(item?.preview_url || item?.url || "").trim();
    if (!previewUrl) return null;
    return {
      url: previewUrl,
      previewUrl,
      type: guessMediaType(previewUrl, item?.type || ""),
      label: String(item?.label || item?.type || "").trim() || mediaKindLabel(guessMediaType(previewUrl, item?.type || "")),
    };
  }).filter(Boolean);
}

function renderPersonaEditableMediaGrid(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return `<div class="empty-state">当前草稿还没有媒体。</div>`;
  const groupId = registerMediaPreviewGroup(rows.filter((item) => item && item.previewUrl && !item.unavailable));
  let previewIndex = 0;
  return `<div class="persona-edit-media-grid">${rows.map((item, index) => `
    <div class="persona-edit-media-card">
      ${item.unavailable || !item.previewUrl ? `
        <div class="persona-media-frame persona-media-frame--empty">
          <strong>媒体不可预览</strong>
          <small>${esc(item.reason || "原始文件已失效")}</small>
        </div>
      ` : `
        ${renderMediaPreviewButton(item, groupId, previewIndex++, {
          className: "persona-edit-media-preview",
          frameClass: "persona-media-frame",
          caption: mediaKindLabel(item.type),
        })}
      `}
      <div class="row-actions persona-edit-media-actions">
        <button type="button" data-persona-delete-post-media="${esc(index)}">删除</button>
      </div>
    </div>
  `).join("")}</div>`;
}

function renderPersonaImageLibraryGrid(library) {
  const rows = Array.isArray(library?.items) ? library.items : [];
  if (!rows.length) return `<div class="empty-state">当前还没有人设图。生成后会在这里直接预览。</div>`;
  const previewable = rows
    .map((item) => ({
      previewUrl: String(item.preview_url || item.image_url || "").trim(),
      type: "image",
      label: String(item.prompt || item.created_at || "人设图").trim() || "人设图",
      isReference: Boolean(item.is_reference),
      createdAt: String(item.created_at || "").trim(),
    }))
    .filter((item) => item.previewUrl);
  const groupId = registerMediaPreviewGroup(previewable);
  return `<div class="persona-image-library-grid">${previewable.map((item, index) => `
    <div class="persona-image-library-card ${item.isReference ? "is-reference" : ""}">
      ${renderMediaPreviewButton(item, groupId, index, {
        className: "persona-image-library-preview",
        frameClass: "persona-image-library-frame",
        caption: item.isReference ? "当前参考图" : "历史图",
      })}
      <small>${esc(item.createdAt ? formatTime(item.createdAt) : "")}</small>
    </div>
  `).join("")}</div>`;
}

function renderPersonaMediaTaskResult(personaId, postId) {
  const taskState = personaMediaTaskState(personaId, postId);
  if (!taskState?.taskId) return `<div class="empty-state">提交生成任务后，这里会显示结果预览，并可直接回写到当前草稿。</div>`;
  const detail = taskState.detail || {};
  const items = taskOutputMediaItems(detail);
  const status = String(detail.status || taskState.status || "queued").trim();
  const terminal = ["success", "failed", "cancelled"].includes(status);
  return `
    <div class="compact-list">
      <article class="compact-row compact-row-log">
        <strong>${esc(taskMeta[String(detail.type || taskState.taskType || "text_to_image")]?.title || "媒体任务")}</strong>
        <p>${esc(statusLabel(status))} · ${esc(taskState.taskId)}</p>
        <span>${esc(formatTime(detail.finished_at || detail.updated_at || detail.created_at || ""))}</span>
      </article>
    </div>
    ${detail.error ? `<div class="persona-warning-inline">${esc(detail.error)}</div>` : ""}
    ${items.length ? renderPersonaMediaPreview(items) : `<div class="empty-state">${terminal ? "任务已结束，但还没有可预览的媒体结果。" : "任务执行中，结果返回后会自动显示在这里。"}</div>`}
    <div class="row-actions">
      <button type="button" class="primary" data-persona-attach-task-media="append" ${items.length ? "" : "disabled"}>追加到当前草稿</button>
      <button type="button" data-persona-attach-task-media="replace" ${items.length ? "" : "disabled"}>替换当前草稿媒体</button>
    </div>
  `;
}

function renderPersonaCreateWorkbench() {
  return `
    <div class="persona-inline-panel persona-create-workbench is-flat">
      <div class="persona-workbench-head">
        <div class="persona-head-copy">
          <strong>新建普通人设</strong>
          <span>这里只创建普通人设。工作流人设仍由后端档案同步。</span>
        </div>
        <div class="persona-quick-actions">
          <button type="button" data-persona-cancel-create>返回人设详情</button>
        </div>
      </div>
      <label>人设名称
        <input id="personaCreateName" placeholder="例如：咖啡馆主理人" />
      </label>
      <label>人设简介
        <textarea id="personaCreateContent" rows="8" placeholder="填写普通人设的背景、内容方向和说话方式。"></textarea>
      </label>
      <div class="row-actions">
        <button type="button" class="primary" data-persona-create>新建普通人设</button>
      </div>
    </div>
  `;
}

function personaGroupStepOptions(groupKey, profile) {
  const workflowPersona = Boolean(profile?.is_workflow_persona);
  if (groupKey === "content") {
    return workflowPersona
      ? [
          ["generate", "新建推文"],
          ["media", "推文配图 / 媒体"],
          ["overview", "人设内容"],
          ["posts", "查看推文 / 草稿库"],
          ["history", "发布历史"],
          ["publish", "选择草稿进入发布"],
        ]
      : [
          ["generate", "新建推文"],
          ["media", "推文配图 / 媒体"],
          ["overview", "人设内容"],
          ["posts", "查看推文 / 草稿库"],
          ["history", "发布历史"],
          ["publish", "选择草稿进入发布"],
        ];
  }
  if (groupKey === "settings") {
    return workflowPersona
      ? [
          ["profile", "基础资料"],
          ["style", "推文风格"],
          ["links", "链接设置"],
        ]
      : [
          ["profile", "基础资料"],
          ["images", "人设图"],
          ["style", "推文风格"],
          ["links", "链接设置"],
          ["delete", "删除当前人设"],
        ];
  }
  if (groupKey === "account") {
    return [
      ["binding", "账号绑定"],
      ["login", "登录与检查"],
      ["reply_comment", "自动回复评论"],
      ["reply_hot", "自动回复热点推文"],
      ["warmup", "养号"],
    ];
  }
  if (groupKey === "data") {
    return [
      ["metrics", "热点数据"],
      ["queue", "自动化队列"],
    ];
  }
  return [["overview", "概览"]];
}

function renderPersonaModule() {
  const current = selectedPersona();
  $("moduleBody").innerHTML = `
    <div class="persona-console-layout">
      <section class="persona-workbench-shell">
        <div class="persona-detail" id="personaDetail"></div>
      </section>
      <aside class="persona-list-shell">
        <div class="persona-inline-panel persona-list-toolbar">
          <div class="persona-list-head">
            <div>
              <strong>人设列表</strong>
              <span>集中查看、选择和管理</span>
            </div>
            <span>${esc(`${state.personas.length} 个`)}</span>
          </div>
          <button type="button" class="primary" data-persona-open-create>新建人设</button>
          <div class="persona-new-group-row">
            <input id="personaNewGroupName" value="${esc(state.personaNewGroupName || window.__personaNewGroupName || "")}" placeholder="新建分组，例如：房产矩阵" />
            <button id="personaCreateGroupButton" type="button" data-persona-create-group>建组</button>
          </div>
        </div>
        ${state.personas.length ? `
          ${renderPersonaCollectionList()}
        ` : `<div class="empty-state">当前还没有人设，先点击“新建人设”。</div>`}
      </aside>
    </div>
  `;
  bindPersonaGroupCreateControl();
  if (state.personaCreateMode || !current) renderPersonaDetail();
  else renderPersonaDetail();
}

function renderPersonaDetail() {
  snapshotPersonaCurrentForm();
  const persona = selectedPersona();
  if (state.personaCreateMode) {
    state.renderedPersonaId = "";
    $("personaDetail").innerHTML = renderPersonaCreateWorkbench();
    return;
  }
  if (!persona) {
    state.renderedPersonaId = "";
    $("personaDetail").innerHTML = `
      <div class="persona-inline-panel is-flat">
        <strong>请选择一个人设</strong>
        <p>右侧人设列表只负责选择和管理；中间工作区会根据当前人设显示具体参数与操作。</p>
        <div class="row-actions">
          <button type="button" class="primary" data-persona-open-create>新建人设</button>
        </div>
      </div>`;
    return;
  }
  const profile = selectedPersonaProfile();
  if (!profile) loadPersonaProfile(persona.id).catch(() => {});
  if (!state.personaDraftPosts[String(persona.id)]) loadPersonaDraftPosts(persona.id).catch(() => {});
  const groupKey = state.personaGroup || "content";
  state.personaGroup = groupKey;
  const step = currentPersonaGroupStep(groupKey, profile);
  if (groupKey === "content" && step === "generate" && !Array.isArray(state.personaMemories[String(persona.id)])) {
    loadPersonaMemories(persona.id).catch(() => {});
  }
  if (groupKey === "settings" && step === "images" && !personaImageLibraryState(persona.id)) {
    loadPersonaImageLibrary(persona.id).catch(() => {});
  }
  if (groupKey === "content" && step === "publish") {
    ensurePersonaPublishResultLoaded(persona.id).catch(() => {});
  }
  if (groupKey === "content" && (step === "posts" || step === "history") && !Array.isArray(state.personaPublishHistories[String(persona.id)])) {
    loadPersonaPublishHistory(persona.id).catch(() => {});
  }
  if (groupKey === "account" && ["login", "reply_comment", "reply_hot", "warmup"].includes(step)) {
    const platform = selectedPersonaAutomationPlatform();
    const selectedAccount = selectedPersonaAutomationAccount(persona, platform);
    if (selectedAccount?.id) ensurePersonaAutomationResultLoaded(selectedAccount.id, step).catch(() => {});
  }
  const warnings = Array.isArray(persona.warnings) ? persona.warnings : [];
  const account = accountForPersona(persona);
  const drafts = personaDraftPosts(persona);
  const showWarnings = warnings.length && groupKey !== "content";
  const groupPanel = renderPersonaGroupPanel(groupKey, step, persona, account, profile);
  const canDelete = Boolean(profile && !profile.is_workflow_persona);
  $("personaDetail").innerHTML = `
    <div class="persona-inline-panel is-flat">
      <div class="persona-workbench-head">
        <div class="persona-summary-meta">
          <strong>${esc(persona.name || "未命名人设")}</strong>
          <span>${esc(`类型：${personaKindLabel(persona, profile)}`)}</span>
          <span>${esc(`执行账号：${personaExecutionAccountLabel(persona)}`)}</span>
          <span>${esc(`草稿 ${drafts.length} 条`)}</span>
        </div>
        <div class="persona-quick-actions">
          ${canDelete ? `<button type="button" data-persona-delete>删除人设</button>` : ""}
        </div>
      </div>
      ${renderPersonaGroupTabs(profile)}
      ${renderPersonaStepTabs(groupKey, profile)}
    </div>
    ${showWarnings ? `<div class="persona-warning-inline">${warnings.map(esc).join(" / ")}</div>` : ""}
    ${groupPanel}
  `;
  state.renderedPersonaId = String(persona.id || "");
}

function renderPersonaContentPanel(persona, account, profile, step) {
  const panel = step || "overview";
  const drafts = personaDraftPosts(persona);
  const memoryRows = personaMemoryRows(persona);
  const selectedPost = selectedPersonaPost(persona);
  const publishResult = state.personaPublishResults[String(persona.id)] || "";
  const form = personaFormState(persona.id);
  const generateForm = form.generate;
  const draftForm = form.draft;
  const isWorkflowPersona = personaIsWorkflow(persona, profile);
  const contentBranch = resolvedPersonaGenerateBranch(profile, generateForm);
  const paidWorkflowBranch = isWorkflowPersona && contentBranch === "r18";
  const showTimeSlot = isWorkflowPersona && contentBranch === "nonr18";
  const generateMode = String(generateForm.mode || "ai") === "custom" ? "custom" : "ai";
  const preflight = personaGeneratePreflight();
  const hiddenHistoryCount = personaHiddenPublishHistoryCount(persona);
  const hiddenHistoryHint = hiddenHistoryCount > 0 ? ` 当前另有 ${hiddenHistoryCount} 条登录或预检记录，未计入发布历史。` : "";

  if (panel === "generate") {
    return `
      <div class="persona-inline-panel">
        <div class="persona-head-copy persona-head-copy--split">
          <div class="persona-head-copy-main">
            <strong>新建推文</strong>
            <span class="persona-panel-intro">${esc(isWorkflowPersona ? `这里处理推文内容。工作流人设可额外勾选付费内容；配图和媒体操作已归到“推文配图 / 媒体”。已识别 ${memoryRows.length} 条可选记忆。` : `这里处理推文内容。配图和媒体操作已归到“推文配图 / 媒体”。已识别 ${memoryRows.length} 条可选记忆。`)}</span>
          </div>
          ${isWorkflowPersona ? `
            <label class="persona-toggle-chip">
              <input id="personaGeneratePaidEnabled" type="checkbox" ${paidWorkflowBranch ? "checked" : ""} />
              <span>付费内容</span>
            </label>
          ` : ""}
        </div>
        <div class="form-grid persona-detail-controls">
          <label>生成数量
            <input id="personaGenerateCount" type="number" min="1" max="20" value="${esc(generateForm.count || 3)}" />
          </label>
          <label>目标字数
            <input id="personaGenerateTargetWords" type="number" min="10" max="2000" value="${esc(generateForm.targetWords || 120)}" />
          </label>
          ${showTimeSlot ? `<label>早晚文案
            <select id="personaGenerateTimeSlot">
              <option value="" ${!generateForm.contentTimeSlot ? "selected" : ""}>自动</option>
              <option value="morning" ${generateForm.contentTimeSlot === "morning" ? "selected" : ""}>早上</option>
              <option value="night" ${generateForm.contentTimeSlot === "night" ? "selected" : ""}>晚上</option>
            </select>
          </label>` : ""}
        </div>
        ${renderPersonaGenerateModeTabs(generateMode)}
        ${generateMode === "custom" ? `
          <label>草稿标题（可选）
            <input id="personaDraftTitle" value="${esc(draftForm.title || "")}" placeholder="例如：今日主题帖" />
          </label>
          <label>自定义正文
            <textarea id="personaDraftContent" rows="6" placeholder="直接输入本次要保存的推文正文。">${esc(draftForm.content || "")}</textarea>
          </label>
          <div class="row-actions">
            <button type="button" class="primary" data-persona-create-post>保存草稿</button>
            <button type="button" data-persona-route-step="content:posts">查看草稿</button>
          </div>
        ` : `
          <label>本次提示词
            <textarea id="personaGeneratePrompt" rows="5" placeholder="留空则按当前人设自由生成。">${esc(generateForm.prompt || "")}</textarea>
          </label>
          ${!preflight.ready ? `<div class="persona-warning-inline">${esc(preflight.issues.join(" / "))}，请先补齐配置。</div>` : ""}
          <label>可选人设记忆（已识别 ${esc(memoryRows.length)} 条）</label>
          ${renderPersonaMemoryOptions(persona, generateForm.selectedMemoryIds || [])}
          <div class="row-actions">
            <button type="button" class="primary" data-persona-generate-posts ${preflight.ready ? "" : "disabled"}>自动生成草稿</button>
            <button type="button" data-persona-route-step="content:posts">查看草稿</button>
            <button type="button" data-persona-route-step="content:media">进入配图</button>
          </div>
        `}
      </div>`;
  }

  if (panel === "media") {
    const mediaForm = form.media;
    const post = selectedPost;
    const postMediaItems = post ? personaDraftMediaItems(String(persona.id || ""), post) : [];
    const currentTaskType = String(mediaForm.taskType || "text_to_image");
    const mediaMeta = taskMeta[currentTaskType] || taskMeta.text_to_image;
    const showAspectRatio = ["text_to_image", "image_generate"].includes(currentTaskType);
    const showVideoOptions = currentTaskType === "video_i2v";
    const uploadAccept = currentTaskType === "video_i2v" ? "image/*,audio/*" : "image/*";
    return `
      <div class="persona-inline-panel">
        <div class="persona-head-copy">
          <strong>推文配图 / 媒体</strong>
          <span class="persona-panel-intro">先选草稿，再生成、上传、替换或删除媒体。结果会直接回写到当前草稿。</span>
        </div>
        <div class="persona-draft-toolbar">
          <label>当前草稿
            <select id="personaDraftPostSelect">
              ${drafts.length ? drafts.map((post, index) => `<option value="${esc(post.id)}" ${String(post.id) === String(state.selectedPersonaPostId || drafts[0]?.id || "") ? "selected" : ""}>${esc(personaDraftOptionLabel(post, index))}</option>`).join("") : `<option value="">当前还没有草稿</option>`}
            </select>
          </label>
          <div class="row-actions">
            <button type="button" data-persona-route-step="content:generate">返回新建推文</button>
            <button type="button" data-persona-route-step="content:posts">查看草稿库</button>
          </div>
        </div>
        ${post ? `
          <div class="persona-media-workspace">
            <section class="persona-media-column">
              <div class="persona-inline-panel persona-inline-panel--nested">
                <strong>当前草稿正文</strong>
                <p>${esc(String(post.content || "").trim() || "当前草稿没有正文。")}</p>
              </div>
              <div class="persona-inline-panel persona-inline-panel--nested">
                <strong>当前媒体</strong>
                ${renderPersonaEditableMediaGrid(postMediaItems)}
                <label>上传媒体
                  <input id="personaPostMediaUploadFiles" type="file" multiple accept="image/*,video/*" />
                </label>
                <div class="row-actions">
                  <button type="button" class="primary" data-persona-upload-post-media="append">追加到草稿</button>
                  <button type="button" data-persona-upload-post-media="replace">替换草稿媒体</button>
                </div>
              </div>
            </section>
            <section class="persona-media-column">
              <div class="persona-inline-panel persona-inline-panel--nested">
                <strong>生成媒体</strong>
                <span class="persona-panel-intro">默认带入当前草稿正文。只有需要补充时再填写说明。</span>
                ${renderPersonaMediaTaskTabs(currentTaskType)}
                <div class="form-grid persona-detail-controls">
                  ${showAspectRatio ? `<label>图像比例
                    <select id="personaMediaAspectRatio">
                      <option value="1:1" ${String(mediaForm.aspectRatio || "1:1") === "1:1" ? "selected" : ""}>1:1</option>
                      <option value="3:4" ${String(mediaForm.aspectRatio || "") === "3:4" ? "selected" : ""}>3:4</option>
                      <option value="4:3" ${String(mediaForm.aspectRatio || "") === "4:3" ? "selected" : ""}>4:3</option>
                      <option value="9:16" ${String(mediaForm.aspectRatio || "") === "9:16" ? "selected" : ""}>9:16</option>
                      <option value="16:9" ${String(mediaForm.aspectRatio || "") === "16:9" ? "selected" : ""}>16:9</option>
                    </select>
                  </label>` : ""}
                  ${showVideoOptions ? `<label>视频分辨率
                    <select id="personaMediaResolution">
                      <option value="720p" ${String(mediaForm.resolution || "720p") === "720p" ? "selected" : ""}>720p</option>
                      <option value="1080p" ${String(mediaForm.resolution || "") === "1080p" ? "selected" : ""}>1080p</option>
                    </select>
                  </label>` : ""}
                  ${showVideoOptions ? `<label>时长（秒）
                    <input id="personaMediaDuration" type="number" min="2" max="15" value="${esc(mediaForm.duration || 2)}" />
                  </label>` : ""}
                </div>
                <label>补充提示词
                  <textarea id="personaMediaTaskPrompt" rows="5" placeholder="留空则直接按当前草稿正文生成。">${esc(mediaForm.prompt || "")}</textarea>
                </label>
                <label>上传素材
                  <input id="personaMediaTaskFiles" type="file" multiple accept="${esc(uploadAccept)}" />
                  <small>${esc(mediaMeta.files || "根据当前任务类型上传必要素材。")}</small>
                </label>
                <div class="row-actions">
                  <button type="button" class="primary" data-persona-run-media-task>生成预览</button>
                </div>
              </div>
              <div class="persona-inline-panel persona-inline-panel--nested">
                <strong>任务结果预览</strong>
                ${renderPersonaMediaTaskResult(persona.id, post.id)}
              </div>
            </section>
          </div>
        ` : `<div class="empty-state">当前还没有草稿。先新建推文，再回来处理配图和媒体。</div>`}
      </div>`;
  }

  if (panel === "posts") {
    const historyRows = personaPublishHistoryRows(persona);
    return `
      <div class="persona-inline-panel">
        <div class="persona-head-copy">
          <strong>草稿库</strong>
          <span class="persona-panel-intro">${esc(`这里集中查看并选择待发布草稿。新建或编辑草稿请回到“新建推文”；当前草稿 ${drafts.length} 条，发布历史 ${historyRows.length} 条。${hiddenHistoryHint}`)}</span>
        </div>
        ${renderPersonaPostsViewTabs(drafts, historyRows, "posts")}
        <div class="persona-draft-toolbar">
          <label>草稿快速选择
            <select id="personaDraftPostSelect">
              ${drafts.length ? drafts.map((post, index) => `<option value="${esc(post.id)}" ${String(post.id) === String(state.selectedPersonaPostId || drafts[0]?.id || "") ? "selected" : ""}>${esc(personaDraftOptionLabel(post, index))}</option>`).join("") : `<option value="">当前还没有草稿</option>`}
            </select>
          </label>
          <div class="row-actions">
            <button type="button" data-persona-route-step="content:generate">新建或编辑草稿</button>
            ${selectedPost ? `<button type="button" class="primary" data-persona-route-step="content:publish">带入发布步骤</button>` : ""}
          </div>
        </div>
        ${renderPersonaDraftRows(drafts)}
      </div>`;
  }

  if (panel === "history") {
    const historyRows = personaPublishHistoryRows(persona);
    return `
      <div class="persona-inline-panel">
        <div class="persona-head-copy">
          <strong>发布历史</strong>
          <span class="persona-panel-intro">${esc(`这里集中查看当前人设的已发布记录。当前草稿 ${drafts.length} 条，发布历史 ${historyRows.length} 条。${hiddenHistoryHint}`)}</span>
        </div>
        ${renderPersonaPostsViewTabs(drafts, historyRows, "history")}
        ${renderPersonaHistoryRows(historyRows, { hiddenCount: hiddenHistoryCount })}
      </div>`;
  }

  if (panel === "publish") {
    const publishAccounts = publishAccountsForPersona(persona);
    const publishAccount = selectedPublishAccountForPersona(persona);
    const publishHint = publishPlatformHint(publishAccount);
    return `
      <div class="persona-inline-panel persona-publish-panel">
        <div class="persona-head-copy">
          <strong>发布前检查</strong>
          <span class="persona-panel-intro">${esc(publishAccount ? `${publishPlatformLabel(publishAccount)} · ${publishHint}` : "当前人设还没有可发布的 Threads 或 Instagram 执行账号。先到“执行账号管理”或“我的人设 > 浏览器账号”里绑定，再提交发布。")}</span>
        </div>
        ${renderPersonaPublishPreflight(publishAccount)}
        <div class="form-grid persona-detail-controls">
          <label>发布账号
            <select id="personaPublishAccountSelect" ${publishAccounts.length ? "" : "disabled"}>
              ${publishAccounts.length ? publishAccounts.map((entry) => `<option value="${esc(entry.id)}" ${String(entry.id) === String(publishAccount?.id || "") ? "selected" : ""}>${esc(entry.username || entry.id)} · ${esc(publishPlatformLabel(entry))} · ${esc(statusLabel(entry.status || ""))}</option>`).join("") : `<option value="">当前没有可发布账号</option>`}
            </select>
          </label>
          <label>发布草稿
            <select id="personaDraftPostSelect" ${drafts.length ? "" : "disabled"}>
              ${drafts.length ? drafts.map((post, index) => `<option value="${esc(post.id)}" ${String(post.id) === String(state.selectedPersonaPostId || drafts[0]?.id || "") ? "selected" : ""}>${esc(personaDraftOptionLabel(post, index))}</option>`).join("") : `<option value="">当前还没有草稿</option>`}
            </select>
          </label>
          <label>发布时间
            <input id="personaPublishScheduleAt" placeholder="留空立即发布 / 2026-07-04 21:30" />
          </label>
        </div>
        ${personaPublishPreview(selectedPost)}
        <label>发布素材
          <input id="personaPublishFiles" type="file" multiple accept="image/*,video/*" />
          <small>${esc(publishHint)}</small>
        </label>
        <div class="row-actions">
          <button type="button" class="primary" data-persona-publish-submit ${(publishAccount && selectedPost) ? "" : "disabled"}>发布内容</button>
        </div>
        <div id="personaPublishResult">${publishResult || `<div class="empty-state">提交后，这里会显示任务状态、截图和发布结果。</div>`}</div>
      </div>`;
  }

  return `
    <div class="form-grid">
      <div class="persona-inline-panel">
        <p>${esc(persona.content || "暂无人设描述。")}</p>
      </div>
      <div class="persona-inline-panel">
        <p>帖子 ${numberText(persona.counts?.posts)} · 已发布 ${numberText(persona.counts?.published)} · 素材图 ${numberText(persona.counts?.images)}</p>
        <p>当前主链路只保留：人设信息、草稿创建、选择草稿发布、自动化执行结果。</p>
      </div>
    </div>`;
}

async function loadTasks() {
  const data = await api("/api/tasks");
  state.tasks = Array.isArray(data.items) ? data.items : (Array.isArray(data.tasks) ? data.tasks : []);
  const host = $("taskTable");
  if (!state.tasks.length) {
    host.innerHTML = `<div class="empty-state">还没有任务。</div>`;
    return;
  }
  host.innerHTML = state.tasks.map((task) => `
    <article class="task-row">
      <div><strong>${esc(task.workflow_name || task.type || "任务")}</strong><span>${esc(task.id)}</span></div>
      <div><span class="status ${esc(task.status)}">${esc(statusLabel(task.status))}</span></div>
      <div>${esc(formatTime(task.created_at))}</div>
      <div class="row-actions">
        <button type="button" data-watch="${esc(task.id)}">监听</button>
        <button type="button" data-detail="${esc(task.id)}">详情</button>
        ${task.has_download ? `<a href="/api/tasks/${encodeURIComponent(task.id)}/download">下载</a>` : ""}
        ${task.status === "failed" ? `<button type="button" data-retry="${esc(task.id)}">重试</button>` : ""}
      </div>
    </article>
  `).join("");
}

async function showTaskDetail(id) {
  const task = await api(`/api/tasks/${encodeURIComponent(id)}`);
  appendEvent("detail", `${task.type || "任务"} / ${task.status || "-"} / ${task.error || "无错误"}`);
  setView("workspace");
}

async function loadSocialOverview() {
  const overview = await api("/api/persona_dashboard/automation/overview");
  const worker = overview.worker || overview.worker_state || {};
  $("workerState").textContent = worker.running ? "运行中" : (worker.enabled === false ? "已关闭" : "待命");
  $("workerDetail").textContent = worker.last_error || `最近任务：${worker.last_task_id || "-"}`;
  return overview;
}

async function loadSocial() {
  const [overview, accountsData, tasksData] = await Promise.all([
    loadSocialOverview().catch(() => ({})),
    api("/api/persona_dashboard/automation/accounts").catch(() => ({ accounts: [] })),
    api("/api/persona_dashboard/automation/tasks?limit=80").catch(() => ({ tasks: [] })),
  ]);
  state.socialAccounts = accountsData.accounts || [];
  state.socialTasks = tasksData.tasks || [];
  renderSocialAccounts();
  renderSocialTasks();
  syncStandaloneSocialForm();
  if (state.activeModule === "personas") renderPersonaModule();
  if (state.activeModule && ["publishing", "automation"].includes(state.activeModule)) renderSimpleFlowModule(state.activeModule);
  return overview;
}

function renderSocialAccounts() {
  const select = $("socialAccount");
  if (select) {
    const accounts = uniqueAccountOptions(state.socialAccounts);
    select.innerHTML = accounts.length
      ? accounts.map((account) => `<option value="${esc(account.id)}" data-platform="${esc(account.platform)}">${esc(account.username || account.id)} · ${esc(account.platform)}</option>`).join("")
      : `<option value="">暂无账号</option>`;
    syncStandaloneSocialForm();
  }
  const grid = $("accountGrid");
  if (!grid) return;
  grid.innerHTML = state.socialAccounts.length ? state.socialAccounts.map((account) => `
    <article class="account-card">
      <div><strong>${esc(account.username || account.id)}</strong><span>${esc(account.platform || "-")}</span></div>
      <p>${esc(account.profile_dir || "未配置浏览器环境")}</p>
      <div class="row-actions">
        <button type="button" data-social-open-login="${esc(account.id)}">打开登录</button>
        <button type="button" data-social-check-login="${esc(account.id)}">检查登录</button>
      </div>
      <span class="status ${esc(account.status)}">${esc(statusLabel(account.status))}</span>
    </article>
  `).join("") : `<div class="empty-state">暂无执行账号，请先在人设看板或接口中添加账号。</div>`;
}

function renderSocialTasks() {
  const host = $("socialTaskList");
  if (!host) return;
  host.innerHTML = state.socialTasks.length ? state.socialTasks.map((task) => `
    <article class="social-task">
      <div><strong>${esc(statusLabel(task.task_type))}</strong><span>${esc(task.platform)} · ${esc(task.account_username || task.account_id || "")}</span></div>
      <span class="status ${esc(task.status)}">${esc(statusLabel(task.status))}</span>
      <div class="row-actions">
        <button type="button" data-social-log="${esc(task.id)}">日志</button>
        ${task.status === "failed" ? `<button type="button" data-social-retry="${esc(task.id)}">重试</button>` : ""}
        ${["queued", "running", "need_manual"].includes(String(task.status)) ? `<button type="button" data-social-cancel="${esc(task.id)}">取消</button>` : ""}
      </div>
    </article>
  `).join("") : `<div class="empty-state">暂无浏览器自动化任务。</div>`;
}


function numberField(id, fallback = undefined) {
  const node = $(id);
  if (!node || node.value === "") return fallback;
  const value = Number(node.value);
  return Number.isFinite(value) ? value : fallback;
}

function splitLines(value) {
  return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function filesFromInput(id) {
  const node = $(id);
  return node?.files ? Array.from(node.files) : [];
}

async function uploadAutomationMedia(files, messageId) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return [];
  showMsg(messageId, "正在上传素材...", true);
  const form = new FormData();
  list.forEach((file) => form.append("files", file));
  const data = await api("/api/persona_dashboard/automation/media", {
    method: "POST",
    body: form,
  });
  return (data.files || []).map((item) => String(item.path || "")).filter(Boolean);
}

function compactPayload(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && value !== "";
  }));
}

function defaultPayloadForTask(taskType) {
  if (taskType === "threads_warmup") {
    return {
      strategy_id: "tg_default",
      browse_limit: 30,
      scroll_times: 30,
      like_limit: 16,
      max_comments: 0,
      comment_chance: 0,
      require_persona_relevance: false,
    };
  }
  if (taskType === "threads_auto_reply") {
    return {
      strategy_id: "comment_recent_2d",
      reply_scope: "comments",
      max_posts: 5,
      max_replies: 3,
      max_age_days: 2,
      require_persona_relevance: true,
    };
  }
  if (taskType === "browse_feed") {
    return { scroll_times: 5, browse_limit: 5 };
  }
  return {};
}

function validateTaskForPlatform(taskType, platform) {
  const allowed = taskOptionsForPlatform(platform).map(([value]) => value);
  return allowed.includes(taskType);
}

async function createSocialTask(taskType = $("socialTaskType")?.value, accountId = $("socialAccount")?.value || $("simpleAccount")?.value, personaId = "", messageId = "socialMsg") {
  if (!accountId) {
    showMsg(messageId, "请先选择执行账号。", false);
    return;
  }
  const selected = selectedSocialAccount(accountId);
  const platform = selected?.platform || $("socialPlatform")?.value || "threads";
  if (!validateTaskForPlatform(taskType, platform)) {
    showMsg(messageId, `${platformLabel(platform)} 当前不支持「${statusLabel(taskType)}」，请切换到可执行任务类型。`, false);
    return;
  }
  const content = $("socialContent")?.value.trim() || $("simpleContent")?.value.trim() || "";
  const targetUrl = $("socialTargetUrl")?.value.trim() || $("simpleTargetUrl")?.value.trim() || "";
  let mediaPaths = [];
  if (taskType === "publish_post") {
    mediaPaths = await uploadAutomationMedia([
      ...filesFromInput("simpleMediaFiles"),
      ...filesFromInput("socialMediaFiles"),
    ], messageId);
  }
  if (taskType === "publish_post" && platform === "instagram" && mediaPaths.length === 0) {
    showMsg(messageId, "Instagram 发布至少需要上传一份媒体素材。", false);
    return;
  }
  if (["comment_post", "reply_comment", "like_post", "share_post", "browse_profile"].includes(taskType) && !targetUrl) {
    showMsg(messageId, `「${statusLabel(taskType)}」必须填写目标 URL 或用户名。`, false);
    return;
  }
  const userPayload = compactPayload({
    content,
    caption: content,
    comment: content,
    text: content,
    reply: content,
    reply_text: content,
    target_url: targetUrl,
    post_url: targetUrl,
    username: taskType === "browse_profile" ? targetUrl : "",
    media_paths: mediaPaths,
    target_urls: splitLines($("simpleTargetUrls")?.value || $("socialTargetUrls")?.value || ""),
    login_wait_seconds: 180,
    reply_templates: splitLines(content),
  });
  const payload = compactPayload({
    ...defaultPayloadForTask(taskType),
    ...userPayload,
  });
  const scheduledAt = $("simpleScheduleAt")?.value.trim() || "";
  const result = await api("/api/persona_dashboard/automation/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account_id: accountId,
      persona_id: personaId || selected?.persona_id || "",
      platform,
      task_type: taskType,
      scheduled_at: scheduledAt || undefined,
      priority: 0,
      max_retries: 2,
      payload,
    }),
  });
  showMsg(messageId, `浏览器任务已提交：${result.task?.id || ""}`, true);
  await loadSocial();
  return result;
}

async function showSocialLog(id) {
  const data = await api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(id)}/logs`);
  const host = $("eventStream");
  if (host) host.innerHTML = "";
  setView("workspace");
  (data.logs || []).slice(-12).reverse().forEach((log) => {
    appendEvent(log.stage || log.level, log.message || JSON.stringify(log.data || {}));
    if (log.screenshot_url) appendEvent("screenshot", log.screenshot_url);
  });
}

function bindEvents() {
  const themeToggle = ensureThemeToggle();
  if (themeToggle) themeToggle.addEventListener("click", toggleTheme);
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    setMenuClickHighlight(button, button);
    const nextView = button.dataset.view;
    if (nextView === "workspace" && state.view === "workspace") {
      state.workspaceMenuOpen = !state.workspaceMenuOpen;
      updateWorkspaceFlow();
      return;
    }
    if (nextView === "workspace") state.workspaceMenuOpen = true;
    setView(nextView);
  }));
  $("moduleMenu").addEventListener("click", (event) => {
    const button = event.target.closest("[data-module]");
    if (button) {
      setMenuClickHighlight(button, button.closest(".module-accordion-item") || button);
      setModule(button.dataset.module);
    }
  });
  $("moduleBody").addEventListener("click", (event) => {
    const previewButton = event.target.closest("[data-media-preview-group]");
    if (previewButton) {
      openPersonaMediaLightbox(
        previewButton.dataset.mediaPreviewGroup || "",
        Number(previewButton.dataset.mediaPreviewIndex || 0),
      );
      return;
    }
    const memoryBulkButton = event.target.closest("[data-persona-memory-bulk]");
    if (memoryBulkButton) {
      const nextChecked = memoryBulkButton.dataset.personaMemoryBulk === "all";
      document.querySelectorAll("[data-persona-memory-id]").forEach((node) => {
        node.checked = nextChecked;
      });
      snapshotPersonaCurrentForm();
      syncPersonaMemorySelectionState();
      renderConfirmSummary();
      return;
    }
    if (event.target.closest("[data-persona-create-group]")) {
      createPersonaCollection($("personaNewGroupName")?.value || "").catch((error) => {
        showMsg("commandMsg", error.detail || error.message || "建组失败", false);
      });
      return;
    }
    if (event.target.closest("[data-persona-create]")) {
      createPersonaArchive().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
      return;
    }
    if (event.target.closest("[data-persona-generate-posts]")) {
      generatePersonaDraftPosts().catch((error) => showMsg("commandMsg", error.detail || error.message || "自动生成失败", false));
      return;
    }
    if (event.target.closest("[data-persona-generate-image]")) {
      submitPersonaImageGeneration().catch((error) => showMsg("commandMsg", error.detail || error.message || "生成人设图失败", false));
      return;
    }
    if (event.target.closest("[data-persona-create-post]")) {
      createPersonaDraftPost().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
      return;
    }
    if (event.target.closest("[data-persona-run-media-task]")) {
      submitPersonaMediaTask().catch((error) => showMsg("commandMsg", error.detail || error.message || "生成媒体失败", false));
      return;
    }
    if (event.target.closest("[data-persona-attach-task-media]")) {
      const button = event.target.closest("[data-persona-attach-task-media]");
      attachPersonaTaskMediaToPost(button?.dataset.personaAttachTaskMedia === "replace").catch((error) => showMsg("commandMsg", error.detail || error.message || "保存媒体失败", false));
      return;
    }
    const uploadPostMedia = event.target.closest("[data-persona-upload-post-media]");
    if (uploadPostMedia) {
      uploadPersonaPostMedia(uploadPostMedia.dataset.personaUploadPostMedia === "replace").catch((error) => showMsg("commandMsg", error.detail || error.message || "上传媒体失败", false));
      return;
    }
    const deletePostMedia = event.target.closest("[data-persona-delete-post-media]");
    if (deletePostMedia) {
      deletePersonaPostMedia(deletePostMedia.dataset.personaDeletePostMedia || "0").catch((error) => showMsg("commandMsg", error.detail || error.message || "删除媒体失败", false));
      return;
    }
    const toggleFolder = event.target.closest("[data-persona-toggle-folder]");
    if (toggleFolder) {
      togglePersonaCollection(toggleFolder.dataset.personaToggleFolder || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
      return;
    }
    const renameGroup = event.target.closest("[data-persona-rename-group]");
    if (renameGroup) {
      renamePersonaCollection(renameGroup.dataset.personaRenameGroup || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "重命名失败", false));
      return;
    }
    const deleteGroup = event.target.closest("[data-persona-delete-group]");
    if (deleteGroup) {
      deletePersonaCollection(deleteGroup.dataset.personaDeleteGroup || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "删除失败", false));
      return;
    }
    const editPersonaGroup = event.target.closest("[data-persona-edit]");
    if (editPersonaGroup) {
      const personaId = editPersonaGroup.dataset.personaEdit || "";
      state.personaListEditorId = state.personaListEditorId === personaId ? "" : personaId;
      renderPersonaModule();
      return;
    }
    const addSelectedGroup = event.target.closest("[data-persona-add-selected-group]");
    if (addSelectedGroup) {
      const personaId = addSelectedGroup.dataset.personaAddSelectedGroup || "";
      const select = Array.from($("moduleBody").querySelectorAll("[data-persona-add-group-select]")).find((node) => node.dataset.personaAddGroupSelect === personaId);
      addPersonaToCollection(personaId, select?.value || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "加入分组失败", false));
      return;
    }
    const removeFromGroup = event.target.closest("[data-persona-remove-from-group]");
    if (removeFromGroup) {
      removePersonaFromCollection(removeFromGroup.dataset.personaRemoveFromGroup || "", removeFromGroup.dataset.groupId || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "移出失败", false));
      return;
    }
    const ungroupAll = event.target.closest("[data-persona-ungroup-all]");
    if (ungroupAll) {
      ungroupPersona(ungroupAll.dataset.personaUngroupAll || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "拆出失败", false));
      return;
    }
    const routeStepButton = event.target.closest("[data-persona-route-step]");
    if (routeStepButton) {
      const [groupKey, step] = String(routeStepButton.dataset.personaRouteStep || "").split(":");
      if (groupKey && step) {
        state.personaGroup = groupKey;
        state.personaPanels[groupKey] = step;
        renderPersonaDetail();
        renderConfirmSummary();
      }
    }
    const draftCard = event.target.closest("[data-persona-select-post]");
    if (draftCard && !event.target.closest("button, a, input, select, textarea")) {
      state.selectedPersonaPostId = draftCard.dataset.personaSelectPost || "";
      renderPersonaDetail();
      renderConfirmSummary();
    }
    const personaSelectButton = event.target.closest("[data-persona-select]");
    if (personaSelectButton) {
      state.selectedPersonaId = personaSelectButton.dataset.personaSelect || "";
      state.selectedPersonaPostId = "";
      state.personaCreateMode = false;
      state.personaGroup = "content";
      state.personaPanels.content = "generate";
      state.preferredAccountId = accountForPersona(selectedPersona())?.id || "";
      state.personaLinkPresetId = "";
      renderPersonaModule();
      renderConfirmSummary();
      Promise.all([
        loadPersonaProfile(state.selectedPersonaId, { force: true }).catch(() => {}),
        loadPersonaDraftPosts(state.selectedPersonaId, { force: true }).catch(() => {}),
        loadPersonaMemories(state.selectedPersonaId, { force: true }).catch(() => {}),
        loadPersonaPublishHistory(state.selectedPersonaId, { force: true }).catch(() => {}),
      ]).catch(() => {});
    }
    if (event.target.closest("[data-persona-open-create]")) {
      state.personaCreateMode = true;
      renderPersonaDetail();
    }
    if (event.target.closest("[data-persona-cancel-create]")) {
      state.personaCreateMode = false;
      renderPersonaDetail();
    }
    const personaGroupButton = event.target.closest("[data-persona-group]");
    if (personaGroupButton) {
      state.personaGroup = personaGroupButton.dataset.personaGroup || "content";
      renderPersonaDetail();
      renderConfirmSummary();
    }
    const personaStepButton = event.target.closest("[data-persona-step]");
    if (personaStepButton) {
      const [groupKey, step] = String(personaStepButton.dataset.personaStep || "").split(":");
      if (groupKey && step) {
        state.personaGroup = groupKey;
        setPersonaGroupStep(groupKey, step, selectedPersonaProfile());
        renderPersonaDetail();
        renderConfirmSummary();
      }
    }
    const generateModeButton = event.target.closest("[data-persona-generate-mode]");
    if (generateModeButton) {
      const persona = selectedPersona();
      if (persona) {
        personaFormState(persona.id).generate.mode = generateModeButton.dataset.personaGenerateMode || "ai";
        renderPersonaDetail();
        renderConfirmSummary();
      }
    }
    const mediaTaskButton = event.target.closest("[data-persona-media-task]");
    if (mediaTaskButton) {
      const persona = selectedPersona();
      if (persona) {
        personaFormState(persona.id).media.taskType = mediaTaskButton.dataset.personaMediaTask || "text_to_image";
        renderPersonaDetail();
        renderConfirmSummary();
      }
    }
    if (event.target.closest("[data-persona-publish-submit]")) submitPersonaPublishTask().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-save-profile]")) savePersonaProfileFields().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-save-threads]")) savePersonaThreadsBinding().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-unbind-threads]")) unbindPersonaThreadsBinding().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-save-style]")) savePersonaTweetStyle().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-clear-style]")) clearPersonaTweetStyle().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-add-preset]")) addPersonaPreset().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-save-preset]")) savePersonaPreset().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-delete-preset]")) deletePersonaPreset().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-activate-preset]")) activatePersonaPreset().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-create-account]")) createPersonaAutomationAccount().catch((error) => showMsg("commandMsg", error.detail || error.message || "绑定账号失败", false));
    if (event.target.closest("[data-persona-save-login]")) savePersonaAutomationLogin().catch((error) => showMsg("commandMsg", error.detail || error.message || "保存登录资料失败", false));
    if (event.target.closest("[data-persona-clear-login]")) clearPersonaAutomationLogin().catch((error) => showMsg("commandMsg", error.detail || error.message || "删除登录资料失败", false));
    if (event.target.closest("[data-persona-open-login]")) submitPersonaLoginTask(false).catch((error) => showMsg("commandMsg", error.detail || error.message || "打开登录窗口失败", false));
    if (event.target.closest("[data-persona-auto-login]")) submitPersonaLoginTask(true).catch((error) => showMsg("commandMsg", error.detail || error.message || "自动登录失败", false));
    if (event.target.closest("[data-persona-check-login]")) checkPersonaLogin().catch((error) => showMsg("commandMsg", error.detail || error.message || "检查登录失败", false));
    if (event.target.closest("[data-persona-delete]")) deleteSelectedPersona().catch((error) => showMsg("commandMsg", error.detail || error.message || "删除人设失败", false));
    if (event.target.closest("[data-persona-clear-tasks]")) clearPersonaAutomationTasks().catch((error) => showMsg("commandMsg", error.detail || error.message || "清理队列失败", false));
    const runThreads = event.target.closest("[data-persona-run-threads]");
    if (runThreads) runPersonaThreadsTask(runThreads.dataset.personaRunThreads).catch((error) => showMsg("commandMsg", error.detail || error.message || "提交任务失败", false));
  });
  $("moduleBody").addEventListener("change", (event) => {
    if (event.target?.matches?.("[data-persona-memory-id]")) {
      snapshotPersonaCurrentForm();
      syncPersonaMemorySelectionState();
      renderConfirmSummary();
    }
    if (event.target?.id === "personaGeneratePaidEnabled") {
      snapshotPersonaCurrentForm();
      renderPersonaDetail();
      renderConfirmSummary();
    }
    if (event.target?.id === "personaGenerateMode") {
      snapshotPersonaCurrentForm();
      renderPersonaDetail();
      renderConfirmSummary();
    }
    if (event.target?.id === "personaDraftPostSelect") {
      state.selectedPersonaPostId = event.target.value || "";
      renderPersonaDetail();
      renderConfirmSummary();
    }
    if (event.target?.id === "personaPublishAccountSelect") {
      const personaId = String(selectedPersona()?.id || "").trim();
      if (personaId) state.personaPublishAccountIds[personaId] = event.target.value || "";
      renderPersonaDetail();
      renderConfirmSummary();
    }
    if (event.target?.id === "personaLinkPresetSelect") {
      state.personaLinkPresetId = event.target.value || "";
      renderPersonaDetail();
      renderConfirmSummary();
    }
    if (event.target?.id === "personaAutoPlatform") {
      state.personaAutomationPlatform = event.target.value === "instagram" ? "instagram" : "threads";
      state.preferredAccountId = "";
      renderPersonaDetail();
      renderConfirmSummary();
    }
    if (event.target?.id === "personaAutoAccount") {
      state.preferredAccountId = event.target.value || "";
      renderPersonaDetail();
      renderConfirmSummary();
    }
    if (event.target?.id === "personaStrategySelect") {
      const strategyGroup = String(event.target.dataset.strategyGroup || "");
      if (strategyGroup) setPersonaStrategyId(strategyGroup, event.target.value || "");
      renderPersonaDetail();
      renderConfirmSummary();
    }
  });
  $("moduleBody").addEventListener("input", (event) => {
    if (event.target?.id === "personaNewGroupName") {
      state.personaNewGroupName = event.target.value || "";
      window.__personaNewGroupName = state.personaNewGroupName;
    }
    if (event.target?.id === "personaMemorySearch") {
      applyPersonaMemoryFilter(event.target.value || "");
    }
  });
  $("refreshAll").addEventListener("click", () => Promise.all([loadTasks(), loadPersonas(), loadSocial().catch(() => {}), loadSetupStatus()]).then(renderWorkspace));
  if ($("refreshTasks")) $("refreshTasks").addEventListener("click", () => loadTasks().then(renderWorkspace));
  if ($("refreshSocialTasks")) $("refreshSocialTasks").addEventListener("click", () => loadSocial().then(renderWorkspace));
  if ($("refreshAccounts")) $("refreshAccounts").addEventListener("click", () => loadSocial().then(renderWorkspace));
  $("taskTable").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const id = button.dataset.watch || button.dataset.detail || button.dataset.retry;
    if (button.dataset.watch) watchTask(id);
    if (button.dataset.detail) showTaskDetail(id).catch((error) => appendEvent("error", error.detail || error.message));
    if (button.dataset.retry) api(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" }).then(loadTasks);
  });
  $("submitSocialTask").addEventListener("click", () => createSocialTask().catch((error) => showMsg("socialMsg", error.detail || error.message || "提交失败", false)));
  $("socialAccount").addEventListener("change", syncStandaloneSocialForm);
  if ($("socialPlatform")) $("socialPlatform").addEventListener("change", syncStandaloneSocialForm);
  if ($("runSocialOnce")) $("runSocialOnce").addEventListener("click", () => api("/api/persona_dashboard/automation/worker/run_once", { method: "POST" }).then(loadSocial).catch((error) => showMsg("socialMsg", error.detail || error.message || "执行失败", false)));
  $("accountGrid").addEventListener("click", (event) => {
    const open = event.target.closest("[data-social-open-login]");
    const check = event.target.closest("[data-social-check-login]");
    if (open) createSocialTask("open_login", open.dataset.socialOpenLogin);
    if (check) createSocialTask("check_login", check.dataset.socialCheckLogin);
  });
  $("socialTaskList").addEventListener("click", (event) => {
    const log = event.target.closest("[data-social-log]");
    const retry = event.target.closest("[data-social-retry]");
    const cancel = event.target.closest("[data-social-cancel]");
    if (log) showSocialLog(log.dataset.socialLog);
    if (retry) api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(retry.dataset.socialRetry)}/retry`, { method: "POST" }).then(loadSocial);
    if (cancel) api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(cancel.dataset.socialCancel)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "user_cancel" }) }).then(loadSocial);
  });
  $("openAdmin").addEventListener("click", () => { location.href = "/admin.html"; });
  $("consoleLogout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/console.html";
  });
}

async function init() {
  applyTheme(currentTheme());
  ensurePersonaMediaLightbox();
  bindEvents();
  renderWorkspace();
  appendEvent("ready", "Web 控制台已就绪。");
  await loadMe();
  await Promise.all([loadPersonas(), loadTasks(), loadSocial().catch(() => {}), loadSetupStatus()]);
  renderWorkspace();
}

init().catch((error) => {
  appendEvent("error", error.detail || error.message || "控制台初始化失败");
});
