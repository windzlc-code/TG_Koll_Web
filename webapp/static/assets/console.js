const $ = (id) => document.getElementById(id);
const THEME_STORAGE_KEY = "wk-console-theme";
const PERSONA_LIST_PAGE_SIZE_KEY = "wk-persona-list-page-size";
const PERSONA_GENERATE_COUNT_KEY = "wk-persona-generate-count";
const PERSONA_GENERATE_TARGET_WORDS_KEY = "wk-persona-generate-target-words";
const PERSONA_HOT_IMPORTS_STORAGE_KEY = "wk-persona-hot-imports";

try {
  if (window.localStorage.getItem(THEME_STORAGE_KEY) === "dark") {
    document.documentElement.dataset.theme = "dark";
  }
} catch {}

function storedPersonaListPageSize() {
  try {
    const value = Number(window.localStorage.getItem(PERSONA_LIST_PAGE_SIZE_KEY) || 20);
    return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : 20, 5), 80);
  } catch {
    return 20;
  }
}

function storedPersonaGenerateCount() {
  try {
    const value = Number(window.localStorage.getItem(PERSONA_GENERATE_COUNT_KEY) || 3);
    return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : 3, 1), 20);
  } catch {
    return 3;
  }
}

function storedPersonaGenerateTargetWords() {
  try {
    const value = Number(window.localStorage.getItem(PERSONA_GENERATE_TARGET_WORDS_KEY) || 120);
    return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : 120, 10), 2000);
  } catch {
    return 120;
  }
}

function storedPersonaHotImports() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PERSONA_HOT_IMPORTS_STORAGE_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

const state = {
  view: "workspace",
  activeModule: "personas",
  workspaceMenuOpen: true,
  setupStatus: null,
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
  publishFiles: [],
  socialFiles: [],
  tasks: [],
  personas: [],
  personaProfiles: {},
  personaCollections: { groups: [], assigned_persona_ids: [] },
  personaListEditorId: "",
  personaListEditorMode: "",
  personaListPage: 1,
  personaListPageSize: storedPersonaListPageSize(),
  personaGenerateCountDefault: storedPersonaGenerateCount(),
  personaGenerateTargetWordsDefault: storedPersonaGenerateTargetWords(),
  personaNewGroupName: "",
  personaDrag: {
    type: "",
    id: "",
    fromGroupId: "",
    targetGroupId: "",
    beforeId: "",
  },
  personaPointerDrag: {
    active: false,
    pending: false,
    id: "",
    fromGroupId: "",
    pointerId: 0,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    lockX: 0,
    targetGroupId: "",
    beforeId: "",
    source: null,
    ghost: null,
  },
  personaDropState: {
    placeholder: null,
    zoneId: null,
    beforeId: null,
    zone: null,
  },
  personaPointerRaf: 0,
  personaDragSaveSeq: 0,
  personaSuppressClickUntil: 0,
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
  personaHotImports: storedPersonaHotImports(),
  personaHotCandidateResults: {},
  personaForms: {},
  personaProfileModes: {},
  renderedPersonaId: "",
  personaCreateMode: false,
  personaCreate: null,
  actionLocks: {},
  personaCreateBusy: {
    manual: false,
    keywords: false,
    aiCreate: false,
  },
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

function personaGenerateDefaults() {
  return {
    count: Math.min(Math.max(Number(state.personaGenerateCountDefault || 3), 1), 20),
    targetWords: Math.min(Math.max(Number(state.personaGenerateTargetWordsDefault || 120), 10), 2000),
  };
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
  return "nonr18";
}

function defaultPersonaCreateState() {
  return {
    mode: "ai",
    aiStep: "input",
    aiName: "",
    aiPrompt: "",
    aiKeywords: [],
    aiSelectedKeywords: [],
    aiResult: null,
    manualName: "",
    manualContent: "",
  };
}

function ensurePersonaCreateState() {
  if (!state.personaCreate || typeof state.personaCreate !== "object") {
    state.personaCreate = defaultPersonaCreateState();
  }
  return state.personaCreate;
}

function personaCreateBusyKind() {
  const busy = state.personaCreateBusy || {};
  if (busy.aiCreate) return "AI 生成人设";
  if (busy.keywords) return "关键词提炼";
  if (busy.manual) return "手动创建人设";
  return "";
}

function personaCreateIsBusy() {
  return Boolean(personaCreateBusyKind());
}

function snapshotPersonaCreateInputs() {
  const createState = ensurePersonaCreateState();
  const aiName = $("personaCreateAiName");
  const aiPrompt = $("personaCreateAiPrompt");
  const manualName = $("personaCreateName");
  const manualContent = $("personaCreateContent");
  if (aiName) createState.aiName = aiName.value || "";
  if (aiPrompt) createState.aiPrompt = aiPrompt.value || "";
  if (manualName) createState.manualName = manualName.value || "";
  if (manualContent) createState.manualContent = manualContent.value || "";
  return createState;
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
  { id: "personas", label: "我的人设", hint: "人设列表、详情、推文、设置", callback: "后台自动读取" },
  { id: "publishing", label: "发布 / 矩阵发布", hint: "草稿发布、批量发布、定时、队列", callback: "后台自动排队" },
  { id: "automation", label: "指纹浏览器自动化", hint: "浏览器账号登录、检测、养号、回复", callback: "后台自动执行" },
];

const taskMeta = {
  text_to_image: { title: "文生图", minImages: 0, files: "无需文件，填写 Prompt 后直接生成图片。", callback: "后台自动提交" },
  persona_post_image: { title: "推文配图", minImages: 0, files: "基于当前草稿正文和人设参考图生成预览图片。", callback: "后台自动提交" },
};

const personaGroups = {
  content: {
    label: "内容生产",
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
  publishing: "publish_now",
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
  if (!response.ok) {
    const detail = localizeConsoleMessage(data?.detail || text || "", response.status);
    if (data && typeof data === "object") {
      data.detail = detail;
      data.status = response.status;
    } else {
      data = { detail, status: response.status };
    }
    throw data;
  }
  return data;
}

function localizeConsoleMessage(text, status = 0) {
  const raw = String(text || "").trim();
  const exactMap = {
    "Method Not Allowed": "请求方式不正确",
    "Not Found": "请求的内容不存在",
    "Unauthorized": "登录已失效，请重新登录",
    "Forbidden": "当前没有权限执行这个操作",
    "Bad Request": "请求参数不正确",
    "Internal Server Error": "服务处理失败，请稍后重试",
  };
  if (exactMap[raw]) return exactMap[raw];
  if (raw) return raw;
  const statusMap = {
    400: "请求参数不正确",
    401: "登录已失效，请重新登录",
    403: "当前没有权限执行这个操作",
    404: "请求的内容不存在",
    405: "请求方式不正确",
    500: "服务处理失败，请稍后重试",
  };
  return statusMap[Number(status) || 0] || "操作失败";
}

function eventKindLabel(kind) {
  return {
    ready: "已就绪",
    info: "提示",
    detail: "详情",
    progress: "进行中",
    queued: "已排队",
    success: "成功",
    failed: "失败",
    error: "错误",
    warn: "警告",
    warning: "警告",
    browser: "浏览器",
    persona: "人设",
    screenshot: "截图",
  }[String(kind || "").trim()] || String(kind || "提示").trim() || "提示";
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

function clearMsg(id) {
  const node = $(id);
  if (!node) return;
  node.textContent = "";
  node.className = "notice";
}

function clearConsoleNotices() {
  clearMsg("commandMsg");
  clearMsg("socialMsg");
  clearMsg("consoleSettingsMsg");
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
    persona_post_image: "推文配图",
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
  const hotMeta = personaHotImportMeta(String(selectedPersona()?.id || ""), post?.id);
  const title = String(post?.title || "").trim() || `未命名草稿 ${index + 1}`;
  const stamp = formatTime(post?.published_at || post?.updated_at || post?.created_at);
  return `${hotMeta ? "[热点] " : ""}${title} · ${stamp}`;
}

function personaHiddenPublishHistoryCount(persona = selectedPersona()) {
  if (!persona) return 0;
  return Math.max(0, Number(persona?.counts?.published_hidden || 0));
}

function personaFormState(personaId) {
  const key = String(personaId || "").trim();
  if (!key) {
    return {
      generate: { mode: "ai", count: 3, targetWords: 120, contentTimeSlot: "", prompt: "", selectedMemoryIds: [], hotSelectedIds: [], hotPreviewId: "", hotPrompt: "", hotDeletedMediaByCandidate: {}, hotEditedContentByCandidate: {} },
      draft: { title: "", content: "", editingPostId: "" },
      media: { taskType: "persona_post_image", prompt: "", aspectRatio: "1:1", resolution: "720p", duration: 2, replaceExisting: false },
      images: { prompt: "", aspectRatio: "1:1" },
    };
  }
  if (!state.personaForms[key]) {
    state.personaForms[key] = {
      generate: {
        mode: "ai",
        count: 3,
        targetWords: 120,
        contentTimeSlot: "",
        prompt: "",
        selectedMemoryIds: [],
        hotSelectedIds: [],
        hotPreviewId: "",
        hotPrompt: "",
        hotDeletedMediaByCandidate: {},
        hotEditedContentByCandidate: {},
      },
      draft: {
        title: "",
        content: "",
        editingPostId: "",
      },
      media: {
        taskType: "persona_post_image",
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

function persistPersonaHotImports() {
  try {
    window.localStorage.setItem(PERSONA_HOT_IMPORTS_STORAGE_KEY, JSON.stringify(state.personaHotImports || {}));
  } catch {}
}

function personaHotImportStore(personaId) {
  const key = String(personaId || "").trim();
  if (!key) return {};
  if (!state.personaHotImports[key] || typeof state.personaHotImports[key] !== "object") {
    state.personaHotImports[key] = {};
  }
  return state.personaHotImports[key];
}

function personaHotImportMeta(personaId, postId) {
  const personaKey = String(personaId || "").trim();
  const postKey = String(postId || "").trim();
  const posts = state.personaDraftPosts[personaKey] || [];
  const post = posts.find((item) => String(item?.id || "").trim() === postKey);
  const sourceMeta = post?.source_meta && typeof post.source_meta === "object" ? post.source_meta : null;
  if (sourceMeta && String(sourceMeta.source || "").trim() === "sentiment_hot_import") {
    return {
      kind: "hot_import",
      imported_at: String(post?.created_at || post?.updated_at || "").trim(),
      source_url: String(sourceMeta.source_url || "").trim(),
      source_summary: normalizedTextSnippet(sourceMeta.original_content || "", 140) || normalizedTextSnippet(sourceMeta.source_url || "", 140),
      platform: String(sourceMeta.platform || "").trim() || "threads",
      captured_at: sourceMeta.captured_at || sourceMeta.published_at || "",
      view_count: Number(sourceMeta.engagement?.viewCount || sourceMeta.metrics?.viewCount || sourceMeta.metrics?.views || 0),
      like_count: Number(sourceMeta.engagement?.likeCount || sourceMeta.metrics?.likeCount || sourceMeta.metrics?.likes || 0),
      comment_count: Number(sourceMeta.engagement?.commentCount || sourceMeta.metrics?.commentCount || sourceMeta.metrics?.comments || 0),
      share_count: Number(sourceMeta.engagement?.shareCount || sourceMeta.metrics?.shareCount || sourceMeta.metrics?.shares || 0),
      repost_count: Number(sourceMeta.metrics?.repostCount || sourceMeta.metrics?.reposts || 0),
    };
  }
  return personaHotImportStore(personaId)[postKey] || null;
}

function setPersonaHotImportMeta(personaId, postId, meta) {
  const key = String(postId || "").trim();
  if (!key) return;
  personaHotImportStore(personaId)[key] = meta && typeof meta === "object" ? meta : {};
  persistPersonaHotImports();
}

function deletePersonaHotImportMeta(personaId, postId) {
  const personaKey = String(personaId || "").trim();
  const postKey = String(postId || "").trim();
  if (!personaKey || !postKey) return;
  const store = personaHotImportStore(personaKey);
  if (!Object.prototype.hasOwnProperty.call(store, postKey)) return;
  delete store[postKey];
  if (!Object.keys(store).length) delete state.personaHotImports[personaKey];
  persistPersonaHotImports();
}

function syncPersonaHotImportPosts(personaId, posts = []) {
  const personaKey = String(personaId || "").trim();
  if (!personaKey) return;
  const store = personaHotImportStore(personaKey);
  const validIds = new Set((Array.isArray(posts) ? posts : []).map((item) => String(item?.id || "").trim()).filter(Boolean));
  let changed = false;
  Object.keys(store).forEach((postId) => {
    if (!validIds.has(postId)) {
      delete store[postId];
      changed = true;
    }
  });
  if (!Object.keys(store).length) delete state.personaHotImports[personaKey];
  if (changed) persistPersonaHotImports();
}

function normalizedTextSnippet(value, maxLength = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…` : text;
}

function personaHotCandidateId(row, index = 0) {
  return String(
    row?.post_key
    || row?.source_url
    || row?.id
    || row?.pk
    || row?.code
    || `hot-${index}`
  ).trim();
}

function personaHotCandidateScore(row) {
  return Number(
    row?.hot_score
    || row?.view_count
    || row?.metrics?.viewCount
    || row?.metrics?.views
    || 0
  )
    + Number(row?.like_count || row?.engagement?.likeCount || row?.metrics?.likeCount || row?.metrics?.likes || 0)
    + Number(row?.comment_count || row?.engagement?.commentCount || row?.metrics?.commentCount || row?.metrics?.comments || 0)
    + Number(row?.share_count || row?.engagement?.shareCount || row?.metrics?.shareCount || row?.metrics?.shares || 0)
    + Number(row?.repost_count || row?.metrics?.repostCount || row?.metrics?.reposts || 0);
}

function personaHotCandidates(persona = selectedPersona()) {
  const personaKey = String(persona?.id || "").trim();
  const fetchedRows = state.personaHotCandidateResults[personaKey]?.candidates;
  const rows = Array.isArray(fetchedRows) && fetchedRows.length
    ? fetchedRows
    : (Array.isArray(persona?.post_metrics) ? persona.post_metrics : []);
  const deduped = new Map();
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object") return;
    const id = personaHotCandidateId(row, index);
    if (!id || deduped.has(id)) return;
    deduped.set(id, {
      ...row,
      candidate_id: id,
      summary: normalizedTextSnippet(row.summary || row.full_content || row.content || "", 120) || "该热点没有可预览正文",
      full_content: String(row.full_content || row.content || "").trim(),
      source_url: String(row.source_url || row.sourceUrl || "").trim(),
      platform: String(row.platform || "").trim() || "threads",
      score: personaHotCandidateScore(row),
      captured_at: row.captured_at || row.published_at || "",
      hot_score: Number(row.hot_score || 0),
      warnings: Array.isArray(row.warnings) ? row.warnings : [],
      keywords: Array.isArray(row.keywords) ? row.keywords : [],
      metrics: row.metrics && typeof row.metrics === "object" ? row.metrics : {},
      engagement: row.engagement && typeof row.engagement === "object" ? row.engagement : {},
      view_count: Number(row.view_count || row.engagement?.viewCount || row.metrics?.viewCount || row.metrics?.views || 0),
      like_count: Number(row.like_count || row.engagement?.likeCount || row.metrics?.likeCount || row.metrics?.likes || 0),
      comment_count: Number(row.comment_count || row.engagement?.commentCount || row.metrics?.commentCount || row.metrics?.comments || 0),
      share_count: Number(row.share_count || row.engagement?.shareCount || row.metrics?.shareCount || row.metrics?.shares || 0),
      repost_count: Number(row.repost_count || row.metrics?.repostCount || row.metrics?.reposts || 0),
      media_items: Array.isArray(row.media_items) ? row.media_items : [],
    });
  });
  return [...deduped.values()].sort((left, right) => {
    const scoreDiff = Number(right.score || 0) - Number(left.score || 0);
    if (scoreDiff) return scoreDiff;
    return timeValue(right.captured_at || right.published_at) - timeValue(left.captured_at || left.published_at);
  });
}

function personaHotPreviewCandidate(persona = selectedPersona()) {
  if (!persona) return null;
  const form = personaFormState(persona.id).generate;
  const candidates = personaHotCandidates(persona);
  if (!candidates.length) return null;
  const previewId = String(form.hotPreviewId || "").trim();
  const preview = candidates.find((item) => item.candidate_id === previewId);
  if (preview) return preview;
  const selectedId = String((form.hotSelectedIds || [])[0] || "").trim();
  return candidates.find((item) => item.candidate_id === selectedId) || candidates[0];
}

function personaHotSelectedCandidates(persona = selectedPersona()) {
  if (!persona) return [];
  const selectedIds = new Set((personaFormState(persona.id).generate.hotSelectedIds || []).map((item) => String(item || "").trim()).filter(Boolean));
  return personaHotCandidates(persona).filter((item) => selectedIds.has(item.candidate_id));
}

function personaHotImportMetaFromCandidate(candidate) {
  return {
    kind: "hot_import",
    imported_at: new Date().toISOString(),
    source_url: String(candidate?.source_url || "").trim(),
    source_summary: normalizedTextSnippet(candidate?.full_content || candidate?.content || "", 140) || normalizedTextSnippet(candidate?.source_url || "", 140),
    platform: String(candidate?.platform || "").trim() || "threads",
    captured_at: candidate?.captured_at || candidate?.published_at || "",
    view_count: Number(candidate?.view_count || 0),
    like_count: Number(candidate?.like_count || 0),
    comment_count: Number(candidate?.comment_count || 0),
    share_count: Number(candidate?.share_count || 0),
    repost_count: Number(candidate?.repost_count || 0),
  };
}

function personaHotCandidateMediaItems(candidate) {
  const rows = Array.isArray(candidate?.media_items) ? candidate.media_items : [];
  return rows.map((item) => {
    const previewUrl = String(item?.previewUrl || item?.preview_url || item?.url || "").trim();
    if (!previewUrl) return null;
    return {
      previewUrl,
      url: previewUrl,
      type: guessMediaType(previewUrl, item?.type || ""),
      label: String(item?.label || item?.type || "热点媒体").trim() || "热点媒体",
    };
  }).filter(Boolean);
}

function personaHotCandidateKey(candidate) {
  return String(candidate?.candidate_id || candidate?.id || "").trim();
}

function personaHotDeletedMediaSet(personaId, candidateId) {
  const form = personaFormState(personaId).generate;
  if (!form.hotDeletedMediaByCandidate || typeof form.hotDeletedMediaByCandidate !== "object") {
    form.hotDeletedMediaByCandidate = {};
  }
  const key = String(candidateId || "").trim();
  const rows = Array.isArray(form.hotDeletedMediaByCandidate[key]) ? form.hotDeletedMediaByCandidate[key] : [];
  return new Set(rows.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 0));
}

function setPersonaHotDeletedMediaSet(personaId, candidateId, indexes) {
  const form = personaFormState(personaId).generate;
  if (!form.hotDeletedMediaByCandidate || typeof form.hotDeletedMediaByCandidate !== "object") {
    form.hotDeletedMediaByCandidate = {};
  }
  const key = String(candidateId || "").trim();
  const clean = Array.from(indexes || [])
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0)
    .sort((left, right) => left - right);
  if (clean.length) form.hotDeletedMediaByCandidate[key] = clean;
  else delete form.hotDeletedMediaByCandidate[key];
}

function personaHotEditedContent(personaId, candidate) {
  const form = personaFormState(personaId).generate;
  if (!form.hotEditedContentByCandidate || typeof form.hotEditedContentByCandidate !== "object") {
    form.hotEditedContentByCandidate = {};
  }
  const key = personaHotCandidateKey(candidate);
  return Object.prototype.hasOwnProperty.call(form.hotEditedContentByCandidate, key)
    ? String(form.hotEditedContentByCandidate[key] || "")
    : String(candidate?.full_content || candidate?.content || "该热点没有完整正文。");
}

function snapshotPersonaHotPreviewContent() {
  const persona = selectedPersona();
  const textarea = document.querySelector("#personaHotPreviewContent");
  if (!persona || !textarea) return;
  const candidate = personaHotPreviewCandidate(persona);
  const key = personaHotCandidateKey(candidate);
  if (!key) return;
  const form = personaFormState(persona.id).generate;
  if (!form.hotEditedContentByCandidate || typeof form.hotEditedContentByCandidate !== "object") {
    form.hotEditedContentByCandidate = {};
  }
  form.hotEditedContentByCandidate[key] = String(textarea.value || "");
}

function renderPersonaHotMediaDeleteControls(persona, candidate) {
  const mediaItems = personaHotCandidateMediaItems(candidate);
  if (!mediaItems.length) return `<div class="empty-state">当前热点候选没有媒体。</div>`;
  const candidateId = personaHotCandidateKey(candidate);
  const deleted = personaHotDeletedMediaSet(persona?.id, candidateId);
  return `
    <div class="persona-hot-media-toolbar">
      <strong>媒体处理</strong>
      <span>已标记删除 ${esc(deleted.size)} / ${esc(mediaItems.length)} 个，未标记的媒体会随草稿保留。</span>
      <div class="row-actions">
        <button type="button" data-persona-hot-media-bulk="all" data-persona-hot-media-candidate="${esc(candidateId)}">全选删除</button>
        <button type="button" data-persona-hot-media-bulk="clear" data-persona-hot-media-candidate="${esc(candidateId)}">清空选择</button>
      </div>
    </div>
    <div class="persona-hot-media-delete-list">
      ${mediaItems.map((item, index) => {
        const isDeleted = deleted.has(index);
        return `
          <button
            type="button"
            class="persona-hot-media-delete-item ${isDeleted ? "is-deleted" : ""}"
            data-persona-hot-media-toggle="${esc(candidateId)}"
            data-persona-hot-media-index="${esc(index)}"
          >
            <span>${esc(item.label || mediaKindLabel(item.type))}</span>
            <strong>${isDeleted ? "将删除" : "保留"}</strong>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderPersonaHotOrigin(meta, { compact = false } = {}) {
  if (!meta) return "";
  const scoreBits = [
    `浏览 ${numberText(meta.view_count || 0)}`,
    `点赞 ${numberText(meta.like_count || 0)}`,
    `评论 ${numberText(meta.comment_count || 0)}`,
  ];
  if (!compact) {
    scoreBits.push(`分享 ${numberText(meta.share_count || 0)}`);
    scoreBits.push(`转发 ${numberText(meta.repost_count || 0)}`);
  }
  return `
    <div class="persona-hot-origin ${compact ? "is-compact" : ""}">
      <div class="persona-hot-origin-head">
        <span class="persona-hot-origin-badge">热点导入</span>
        <small>${esc((meta.platform || "threads").toUpperCase())}${meta.captured_at ? ` · ${esc(formatTime(meta.captured_at))}` : ""}</small>
      </div>
      <p>${esc(meta.source_summary || "该草稿来自已抓取热点内容。")}</p>
      <div class="persona-hot-origin-meta">
        <small>${esc(scoreBits.filter(Boolean).join(" · "))}</small>
        ${meta.source_url ? `<a href="${esc(meta.source_url)}" target="_blank" rel="noopener">查看原帖</a>` : ""}
      </div>
    </div>
  `;
}

function snapshotPersonaCurrentForm() {
  const key = String(state.renderedPersonaId || "").trim();
  if (!key) return;
  const form = personaFormState(key);
  if ($("personaGenerateMode")) form.generate.mode = String($("personaGenerateMode")?.value || "ai");
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

function actionLockKey(...parts) {
  return parts.map((item) => String(item ?? "").trim().replace(/\s+/g, "_")).join(":");
}

function isActionLocked(...parts) {
  return Boolean(state.actionLocks[actionLockKey(...parts)]);
}

function setActionLocked(parts, locked = true) {
  const key = Array.isArray(parts) ? actionLockKey(...parts) : String(parts || "");
  if (!key) return;
  if (locked) state.actionLocks[key] = true;
  else delete state.actionLocks[key];
}

function activeTaskStatus(status) {
  return ["queued", "running", "need_manual"].includes(String(status || "").trim());
}

function activeSocialTaskFor({ accountId = "", personaId = "", taskType = "", postId = "" } = {}) {
  const cleanAccountId = String(accountId || "").trim();
  const cleanPersonaId = String(personaId || "").trim();
  const cleanTaskType = String(taskType || "").trim();
  const cleanPostId = String(postId || "").trim();
  return (state.socialTasks || []).find((task) => {
    if (!activeTaskStatus(task?.status)) return false;
    if (cleanAccountId && String(task?.account_id || "").trim() !== cleanAccountId) return false;
    if (cleanPersonaId && String(task?.persona_id || "").trim() !== cleanPersonaId) return false;
    if (cleanTaskType && String(task?.task_type || "").trim() !== cleanTaskType) return false;
    if (cleanPostId) {
      const payload = task?.payload && typeof task.payload === "object" ? task.payload : {};
      if (String(payload.archive_post_id || "").trim() !== cleanPostId) return false;
    }
    return true;
  }) || null;
}

function personaMediaTaskIsActive(personaId, postId, taskType = "") {
  const taskState = personaMediaTaskState(personaId, postId);
  if (!taskState || !activeTaskStatus(taskState.status)) return false;
  if (!taskType) return true;
  return String(taskState.taskType || taskState.detail?.type || "").trim() === String(taskType || "").trim();
}

async function cancelRegularTask(taskId, messageId = "commandMsg") {
  const cleanTaskId = String(taskId || "").trim();
  if (!cleanTaskId) return null;
  const result = await api(`/api/tasks/${encodeURIComponent(cleanTaskId)}/cancel`, { method: "POST" });
  showMsg(messageId, result.cancelled ? "任务已发送停止请求。" : (result.message || "任务已结束，无需停止。"), true);
  await loadTasks().catch(() => {});
  return result;
}

async function cancelSocialAutomationTask(taskId, messageId = "commandMsg") {
  const cleanTaskId = String(taskId || "").trim();
  if (!cleanTaskId) return null;
  const result = await api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(cleanTaskId)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "user_cancel" }),
  });
  showMsg(messageId, "自动化任务已发送停止请求。", true);
  await loadSocial().catch(() => {});
  return result;
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

function accountOptionKey(account) {
  const username = String(account?.username || account?.account_username || "").trim().toLowerCase();
  return [
    String(account?.platform || "").trim().toLowerCase(),
    username || String(account?.id || "").trim().toLowerCase(),
  ].join("|");
}

function accountStatusRank(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "ready") return 5;
  if (value === "need_verification") return 4;
  if (value === "pending_login") return 3;
  if (value === "cookie_expired") return 2;
  if (value === "disabled") return 1;
  return 0;
}

function mergedAccountCards(accounts) {
  const groups = new Map();
  (accounts || []).forEach((account) => {
    const key = accountOptionKey(account);
    if (!key || key === "|") return;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { ...account, binding_count: 1, account_ids: [account.id].filter(Boolean) });
      return;
    }
    current.binding_count += 1;
    if (account.id) current.account_ids.push(account.id);
    const currentScore = accountStatusRank(current.status);
    const nextScore = accountStatusRank(account.status);
    const currentTime = Number(current.updated_at || current.created_at || 0);
    const nextTime = Number(account.updated_at || account.created_at || 0);
    if (nextScore > currentScore || (nextScore === currentScore && nextTime > currentTime)) {
      groups.set(key, { ...account, binding_count: current.binding_count, account_ids: current.account_ids });
    }
  });
  return Array.from(groups.values());
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
  clearConsoleNotices();
  state.view = view;
  if (view !== "workspace") state.workspaceMenuOpen = false;
  document.querySelectorAll("[data-view]").forEach((button) => {
    const isActive = button.dataset.view === view;
    button.classList.toggle("is-active", isActive);
    if (button.dataset.view === "workspace") {
      button.classList.toggle("has-active-child", view === "workspace");
    }
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === view));
  const titles = {
    workspace: "任务工作台",
    tasks: "任务队列",
    social: "浏览器发布",
    accounts: "执行账号管理",
    settings: "系统状态",
    console_settings: "通用设置",
  };
  $("viewTitle").textContent = titles[view] || "控制台";
  updateWorkspaceFlow();
  if (view === "console_settings") renderConsoleSettingsPage();
  if (view === "tasks") loadTasks();
  if (view === "social" || view === "accounts" || view === "settings") loadSocial();
}

function setWorkspaceModule(moduleId) {
  state.workspaceMenuOpen = true;
  if (state.view !== "workspace") setView("workspace");
  setModule(moduleId);
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
  clearMsg("commandMsg");
  state.activeModule = moduleId;
  renderWorkspace();
}

function selectedBranch(moduleId) {
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
  $("moduleBody").closest(".module-panel")?.classList.toggle("is-persona-module", module.id === "personas");
  $("moduleCallback").textContent = "";
  $("moduleCallback").style.display = "none";
  if (module.id === "personas") renderPersonaModule();
  else renderSimpleFlowModule(module.id);
  renderConfirmSummary();
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
  return `<div class="compact-list persona-draft-grid">${posts.map((post) => {
    const hotMeta = personaHotImportMeta(personaId, post.id);
    return `
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
      ${hotMeta ? renderPersonaHotOrigin(hotMeta, { compact: true }) : ""}
      <p>${esc(String(post.content || "").slice(0, 220))}</p>
      <div class="persona-draft-card-footer">
        <small>${String(post.id) === String(state.selectedPersonaPostId) ? "当前已选中" : "点击卡片选中"}</small>
        <div class="row-actions persona-draft-card-actions">
          <button type="button" data-persona-edit-post="${esc(post.id)}">编辑草稿</button>
          ${String(post.id) === String(state.selectedPersonaPostId) ? `<button type="button" class="primary" data-persona-open-publishing>进入发布 / 矩阵发布</button>` : ""}
        </div>
      </div>
    </article>
  `;
  }).join("")}</div>`;
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
  const hotMeta = personaHotImportMeta(personaId, post.id);
  return `
    <div class="flow-box">
      <span>当前草稿</span>
      <strong>${esc(post.title || "未命名草稿")}</strong>
      ${hotMeta ? renderPersonaHotOrigin(hotMeta, { compact: true }) : ""}
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

function personaProfileMode(personaId) {
  const key = String(personaId || "").trim();
  const mode = key ? state.personaProfileModes[key] : "";
  return mode === "edit" ? "edit" : "overview";
}

function renderPersonaProfileModeTabs(mode) {
  const activeMode = mode === "edit" ? "edit" : "overview";
  return `<div class="persona-step-tabs persona-subflow-tabs persona-profile-mode-tabs">${[
    ["overview", "内容概览"],
    ["edit", "编辑资料"],
  ].map(([value, label]) => `
    <button
      type="button"
      class="${activeMode === value ? "is-active" : ""}"
      data-persona-profile-mode="${esc(value)}"
    >${esc(label)}</button>
  `).join("")}</div>`;
}

function renderPersonaContentOverview(persona, account, profile) {
  const drafts = personaDraftPosts(persona);
  const historyRows = personaPublishHistoryRows(persona);
  const accounts = uniqueAccountOptions(personaAccounts(persona));
  const publishAccount = publishAccountForPersona(persona);
  const latestDraft = sortPersonaDraftPosts(drafts)[0] || null;
  const latestHistory = historyRows[0] || null;
  const personaId = String(persona?.id || "");
  const latestTask = [...state.socialTasks]
    .filter((task) => String(task.persona_id || "") === personaId)
    .sort((left, right) => Math.max(timeValue(right.updated_at), timeValue(right.created_at)) - Math.max(timeValue(left.updated_at), timeValue(left.created_at)))[0] || null;
  const content = String(profile?.content || persona?.content || "").trim();
  return `
    <div class="persona-overview-grid">
      <div class="flow-box persona-overview-summary">
        <span>人设简介</span>
        <strong>${esc(profile?.name || persona?.name || "未命名人设")}</strong>
        <p>${esc(content || "当前还没有人设简介。")}</p>
      </div>
      <div class="persona-overview-stats">
        <div><span>草稿</span><strong>${esc(drafts.length)}</strong></div>
        <div><span>已发布</span><strong>${esc(Number(persona?.counts?.published || historyRows.length || 0))}</strong></div>
        <div><span>账号</span><strong>${esc(accounts.length)}</strong></div>
      </div>
      <div class="form-grid">
        <div class="flow-box">
          <span>执行账号</span>
          <strong>${esc(account ? `${account.username || account.id} · ${account.platform || "-"}` : "未绑定")}</strong>
          <span>${esc(publishAccount ? `可发布：${publishPlatformLabel(publishAccount)} · ${publishPlatformHint(publishAccount)}` : "还没有可发布账号")}</span>
        </div>
        <div class="flow-box">
          <span>最近草稿</span>
          <strong>${esc(latestDraft?.title || "暂无草稿")}</strong>
          <span>${esc(latestDraft ? formatTime(latestDraft.updated_at || latestDraft.created_at) : "先到内容生产里新建推文")}</span>
        </div>
        <div class="flow-box">
          <span>最近发布</span>
          <strong>${esc(latestHistory?.title || latestHistory?.content || "暂无发布记录")}</strong>
          <span>${esc(latestHistory ? formatTime(latestHistory.published_at || latestHistory.created_at || latestHistory.captured_at) : "发布后会在这里显示")}</span>
        </div>
        <div class="flow-box">
          <span>最近自动化</span>
          <strong>${esc(latestTask ? statusLabel(latestTask.task_type || latestTask.status || "") : "暂无任务")}</strong>
          <span>${esc(latestTask ? `${statusLabel(latestTask.status || "")} · ${formatTime(latestTask.updated_at || latestTask.created_at)}` : "登录、养号、回复任务会在这里汇总")}</span>
        </div>
      </div>
    </div>`;
}

function renderPersonaSettingsPanelV2(persona, account, profile, step) {
  if (!profile) return personaSettingsLoadingPanel();
  const presets = personaProfilePresets(profile);
  const selectedPreset = selectedPersonaPreset(profile);
  const selectedPresetId = String(selectedPreset?.id || "");
  const currentStep = step || "profile";
  if (currentStep === "images") {
    const form = personaFormState(persona.id).images;
    const imageBusy = isActionLocked("persona", persona.id, "image_generate");
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
            <button type="button" class="primary" data-persona-generate-image ${imageBusy ? "disabled" : ""}>${imageBusy ? "正在生成人设图..." : (currentReferenceUrl ? "重新生成人设图" : "生成人设图")}</button>
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
        <p>这里只保留真实可用的删除接口。删除后不可恢复。</p>
        <div class="row-actions">
          <button type="button" class="danger" data-persona-delete>删除当前人设</button>
        </div>
      </div>`;
  }
  const profileMode = personaProfileMode(persona.id);
  return `
    <div class="persona-inline-panel">
      <div class="persona-head-copy">
        <strong>基础资料</strong>
        <span class="persona-panel-intro">集中查看人设内容概览，也可以切换到编辑资料。</span>
      </div>
      ${renderPersonaProfileModeTabs(profileMode)}
      ${profileMode === "edit" ? `
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
      ` : renderPersonaContentOverview(persona, account, profile)}
    </div>`;
}

function renderPersonaAccountPanelV2(persona, account, profile, step) {
  const currentStep = step || "binding";
  const platform = selectedPersonaAutomationPlatform();
  const accounts = personaAutomationAccounts(persona, platform);
  const selectedAccount = selectedPersonaAutomationAccount(persona, platform);
  const selectedAccountId = String(selectedAccount?.id || "");
  const loginBusy = Boolean(selectedAccountId) && (isActionLocked("social", selectedAccountId, "open_login") || activeSocialTaskFor({ accountId: selectedAccountId, taskType: "open_login" }));
  const checkBusy = Boolean(selectedAccountId) && (isActionLocked("social", selectedAccountId, "check_login") || activeSocialTaskFor({ accountId: selectedAccountId, taskType: "check_login" }));
  const replyBusy = Boolean(selectedAccountId) && (isActionLocked("social", selectedAccountId, "threads_auto_reply") || activeSocialTaskFor({ accountId: selectedAccountId, taskType: "threads_auto_reply" }));
  const warmupBusy = Boolean(selectedAccountId) && (isActionLocked("social", selectedAccountId, "threads_warmup") || activeSocialTaskFor({ accountId: selectedAccountId, taskType: "threads_warmup" }));
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
          <button type="button" data-persona-open-login ${selectedAccount && !loginBusy ? "" : "disabled"}>${loginBusy ? "登录任务执行中" : "打开登录窗口"}</button>
          <button type="button" data-persona-auto-login ${selectedAccount && !loginBusy ? "" : "disabled"}>${loginBusy ? "登录任务执行中" : "自动登录"}</button>
          <button type="button" data-persona-check-login ${selectedAccount && !checkBusy ? "" : "disabled"}>${checkBusy ? "检查执行中" : "检查登录"}</button>
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
          <button type="button" data-persona-run-threads="${currentStep === "reply_hot" ? "reply_hot" : "reply_comment"}" ${selectedAccount && !replyBusy ? "" : "disabled"}>${replyBusy ? "自动回复执行中" : "提交自动回复任务"}</button>
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
        <button type="button" data-persona-run-threads="warmup" ${selectedAccount && !warmupBusy ? "" : "disabled"}>${warmupBusy ? "养号执行中" : "提交养号任务"}</button>
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

function renderUploadDropzone(id, {
  label = "上传媒体",
  accept = "image/*,video/*",
  hint = "拖动文件到这里，或点击选择文件。",
  multiple = true,
} = {}) {
  return `
    <label class="upload-zone" data-upload-dropzone for="${esc(id)}">
      <input class="upload-zone-input" id="${esc(id)}" type="file" ${multiple ? "multiple" : ""} accept="${esc(accept)}" />
      <strong>${esc(label)}</strong>
      <p>${esc(hint || "拖动文件到这里，或点击选择文件。")}</p>
      <div class="file-strip" data-upload-file-list="${esc(id)}">未选择文件</div>
    </label>`;
}

function formatUploadFileSize(size) {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 KB";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function syncUploadDropzone(input) {
  if (!input) return;
  const zone = input.closest("[data-upload-dropzone]");
  if (!zone) return;
  const host = zone.querySelector(`[data-upload-file-list="${CSS.escape(input.id)}"]`);
  if (!host) return;
  const files = Array.from(input.files || []);
  host.innerHTML = files.length
    ? files.map((file) => `<span class="file-chip"><strong>${esc(file.name)}</strong><small>${esc(formatUploadFileSize(file.size))}</small></span>`).join("")
    : "未选择文件";
}

function setUploadDropzoneFiles(zone, fileList) {
  const input = zone?.querySelector?.("input[type='file']");
  if (!input || !fileList) return;
  const transfer = new DataTransfer();
  const files = Array.from(fileList || []).filter(Boolean);
  const selected = input.multiple ? files : files.slice(0, 1);
  selected.forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  syncUploadDropzone(input);
}

function uploadDropzoneFromEvent(event) {
  return event.target?.closest?.("[data-upload-dropzone]") || null;
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
    if (selectedPersonaForPublish && !state.personaDraftPosts[String(selectedPersonaForPublish.id)]) {
      loadPersonaDraftPosts(selectedPersonaForPublish.id).then(() => {
        if (state.activeModule === "publishing") renderSimpleFlowModule("publishing");
      }).catch(() => {});
    }
    const publishAccount = publishAccountForPersona(selectedPersonaForPublish);
    const drafts = personaDraftPosts(selectedPersonaForPublish);
    const selectedDraft = drafts.find((post) => String(post.id) === String(state.selectedPersonaPostId || "")) || drafts[0] || null;
    body = `
      <div class="form-grid">
        <label>发布方式
          <select id="simplePublishMode">
            <option value="publish_now">立即发布</option>
            <option value="matrix_start">矩阵发布</option>
            <option value="schedule_publish">定时发布</option>
          </select>
        </label>
        <label>人设
          <select id="simplePersona">${personaOptionTags()}</select>
        </label>
      </div>
      ${publishAccount ? `<div class="flow-box"><span>发布账号</span><strong>${esc(publishAccount.username || publishAccount.id)}</strong><span>${esc(publishPlatformHint(publishAccount))}</span></div>` : `<div class="empty-state">当前人设还没有可发布的 Threads 或 Instagram 执行账号。请先到“我的人设 > 浏览器账号”里绑定。</div>`}
      <label>发布草稿
        <select id="simpleDraftPost" ${drafts.length ? "" : "disabled"}>
          ${drafts.length ? drafts.map((post, index) => `<option value="${esc(post.id)}" ${String(post.id) === String(selectedDraft?.id || "") ? "selected" : ""}>${esc(personaDraftOptionLabel(post, index))}</option>`).join("") : `<option value="">当前还没有草稿</option>`}
        </select>
      </label>
      ${scheduleField}
      <label>内容</label>
      <textarea id="simpleContent" rows="4" placeholder="发布正文、评论内容或回复模板。">${esc(selectedDraft?.content || "")}</textarea>
      ${renderUploadDropzone("simpleMediaFiles", { label: "上传素材", hint: "拖动图片或视频到这里，或点击选择。发布内容会读取这里的文件。" })}
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
      ${needsMedia ? renderUploadDropzone("simpleMediaFiles", { label: "上传素材", hint: "拖动图片或视频到这里，或点击选择。Instagram 发布至少需要一份媒体。" }) : ""}
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
  ["simplePrimary", "simplePublishMode", "simpleAccount", "simplePersona", "simpleDraftPost", "simpleScheduleAt", "simpleContent", "simpleTargetUrl", "simpleMediaFiles", "simpleTargetUrls"].forEach((id) => {
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
        state.selectedPersonaPostId = "";
        renderSimpleFlowModule(moduleId);
        return;
      }
      if (id === "simpleDraftPost" && moduleId === "publishing") {
        state.selectedPersonaPostId = node.value || "";
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
  if (state.activeModule === "personas") {
    const persona = selectedPersona();
    const groupKey = state.personaGroup || "content";
    const profile = selectedPersonaProfile();
    const step = currentPersonaGroupStep(groupKey, profile);
    const finalAction = {
      generate: "提交人设草稿生成任务",
      media: "生成媒体或更新当前草稿媒体",
      overview: "查看当前人设资料",
      posts: "新建或选择推文草稿",
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


function appendEvent(kind, message) {
  const host = $("eventStream");
  if (!host) return;
  const row = document.createElement("div");
  row.className = `event-row ${kind || "info"}`;
  row.innerHTML = `<span>${esc(eventKindLabel(kind))}</span><p>${esc(localizeConsoleMessage(message || ""))}</p>`;
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
  const lockParts = ["publish", persona.id, post.id, account.id];
  if (isActionLocked(...lockParts) || activeSocialTaskFor({ accountId: account.id, personaId: persona.id, taskType: "publish_post", postId: post.id })) {
    showMsg("commandMsg", "当前草稿已经有发布任务在队列或执行中，请等待完成后再重复提交。", false);
    return;
  }
  const preflight = personaPublishPreflight(account);
  if (!preflight.login) {
    showMsg("commandMsg", "发布前请先完成一次登录检查，确认当前执行账号仍然可用。", false);
    return;
  }
  const platform = String(account.platform || "instagram").trim().toLowerCase() || "instagram";
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
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
  } finally {
    setActionLocked(lockParts, false);
    if (state.activeModule === "personas") renderPersonaDetail();
  }
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
  const lockParts = ["social", account.id, "open_login"];
  if (isActionLocked(...lockParts) || activeSocialTaskFor({ accountId: account.id, taskType: "open_login" })) {
    showMsg("commandMsg", "该账号已有登录任务在队列或执行中，请等待完成。", false);
    return;
  }
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  if (!autoSubmit) {
    try {
      const result = await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(account.id)}/open_login`, { method: "POST" });
      const task = result.task || {};
      const taskId = String(task.id || "").trim();
      state.personaAutomationResults[personaAutomationResultKey(account.id, "login")] = renderSocialTaskResult(task, [], "提交后，这里会显示任务状态、截图和执行日志。");
      updatePersonaAutomationResultView(account.id, "login");
      if (taskId) watchPersonaAutomationTask(taskId, account.id, "login").catch(() => {});
      showMsg("commandMsg", `登录窗口任务已提交：${result.task?.id || ""}`, true);
      await loadSocial();
      return;
    } finally {
      setActionLocked(lockParts, false);
      if (state.activeModule === "personas") renderPersonaDetail();
    }
  }
  const loginUsername = String($("personaAutoLoginUsername")?.value || account.login_username || account.username || "").trim();
  const loginPassword = String($("personaAutoLoginPassword")?.value || "");
  if (!loginUsername || (!loginPassword && !account.login_password_configured)) {
    setActionLocked(lockParts, false);
    renderPersonaDetail();
    showMsg("commandMsg", "请填写登录账号和密码，或先保存长期登录资料。", false);
    return;
  }
  const payload = {
    auto_submit: true,
    login_username: loginUsername,
    login_wait_seconds: 600,
  };
  if (loginPassword) payload.login_password = loginPassword;
  try {
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
  } finally {
    setActionLocked(lockParts, false);
    if (state.activeModule === "personas") renderPersonaDetail();
  }
}

async function checkPersonaLogin() {
  const persona = selectedPersona();
  const account = selectedPersonaAutomationAccount(persona);
  if (!account) {
    showMsg("commandMsg", "请先选择执行账号。", false);
    return;
  }
  const lockParts = ["social", account.id, "check_login"];
  if (isActionLocked(...lockParts) || activeSocialTaskFor({ accountId: account.id, taskType: "check_login" })) {
    showMsg("commandMsg", "该账号已有登录检查任务在队列或执行中，请等待完成。", false);
    return;
  }
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
    const result = await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(account.id)}/check_login`, { method: "POST" });
    const task = result.task || {};
    const taskId = String(task.id || "").trim();
    state.personaAutomationResults[personaAutomationResultKey(account.id, "login")] = renderSocialTaskResult(task, [], "提交后，这里会显示任务状态、截图和执行日志。");
    updatePersonaAutomationResultView(account.id, "login");
    if (taskId) watchPersonaAutomationTask(taskId, account.id, "login").catch(() => {});
    showMsg("commandMsg", `登录检查任务已提交：${result.task?.id || ""}`, true);
    await loadSocial();
  } finally {
    setActionLocked(lockParts, false);
    if (state.activeModule === "personas") renderPersonaDetail();
  }
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
  const lockParts = ["social", account.id, taskType];
  if (isActionLocked(...lockParts) || activeSocialTaskFor({ accountId: account.id, taskType })) {
    showMsg("commandMsg", `该账号已有${kind === "warmup" ? "养号" : "自动回复"}任务在队列或执行中，请等待完成。`, false);
    return;
  }
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
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
  } finally {
    setActionLocked(lockParts, false);
    if (state.activeModule === "personas") renderPersonaDetail();
  }
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
      if (($("simplePublishMode")?.value || "") === "matrix_start") {
        showMsg("commandMsg", "矩阵发布入口已移到外层，分组批量队列接入后在这里提交。", false);
        return;
      }
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

async function openPersonaCollectionCreateModal() {
  const name = await openConsoleModal({
    title: "创建分组",
    inputLabel: "分组名称",
    inputValue: state.personaNewGroupName || window.__personaNewGroupName || "",
    confirmText: "创建",
  });
  if (name === null) return;
  state.personaNewGroupName = name || "";
  window.__personaNewGroupName = state.personaNewGroupName;
  await createPersonaCollection(name);
}

function renderConsoleSettingsPage() {
  const host = $("consoleSettingsBody");
  if (!host) return;
  const generateDefaults = personaGenerateDefaults();
  host.innerHTML = `
    <div class="console-settings-page">
      <div class="console-settings-toolbar">
        <div class="persona-head-copy">
          <strong>全部设置</strong>
          <span>修改下方参数后统一保存，保存结果会应用到对应功能模块。</span>
        </div>
        <button type="button" class="primary" id="saveConsoleSettings">保存全部设置</button>
      </div>
      <section class="persona-inline-panel">
        <div class="persona-head-copy">
          <strong>人设列表</strong>
          <span>控制右侧人设列表的分页和展示数量。</span>
        </div>
        <div class="form-grid">
          <label>每页显示数量
            <input id="settingsPersonaPageSize" type="number" min="5" max="80" step="1" value="${esc(state.personaListPageSize || 20)}" />
          </label>
        </div>
      </section>
      <section class="persona-inline-panel">
        <div class="persona-head-copy">
          <strong>新建推文</strong>
          <span>统一控制 AI 自动生成草稿时的默认条数和目标字数。</span>
        </div>
        <div class="form-grid">
          <label>默认生成数量
            <input id="settingsPersonaGenerateCount" type="number" min="1" max="20" step="1" value="${esc(generateDefaults.count)}" />
          </label>
          <label>默认目标字数
            <input id="settingsPersonaTargetWords" type="number" min="10" max="2000" step="10" value="${esc(generateDefaults.targetWords)}" />
          </label>
        </div>
      </section>
    </div>
  `;
}

function refreshConsoleSettingsDependents() {
  if (state.activeModule === "personas" && $("moduleBody")) {
    renderPersonaModule();
  }
}

function saveConsoleSettingsPage() {
  const pageSize = Math.min(Math.max(Number.parseInt(String($("settingsPersonaPageSize")?.value || ""), 10) || 20, 5), 80);
  const generateCount = Math.min(Math.max(Number.parseInt(String($("settingsPersonaGenerateCount")?.value || ""), 10) || 3, 1), 20);
  const targetWords = Math.min(Math.max(Number.parseInt(String($("settingsPersonaTargetWords")?.value || ""), 10) || 120, 10), 2000);
  state.personaListPageSize = pageSize;
  state.personaGenerateCountDefault = generateCount;
  state.personaGenerateTargetWordsDefault = targetWords;
  state.personaListPage = 1;
  try {
    window.localStorage.setItem(PERSONA_LIST_PAGE_SIZE_KEY, String(pageSize));
    window.localStorage.setItem(PERSONA_GENERATE_COUNT_KEY, String(generateCount));
    window.localStorage.setItem(PERSONA_GENERATE_TARGET_WORDS_KEY, String(targetWords));
  } catch {}
  renderConsoleSettingsPage();
  refreshConsoleSettingsDependents();
  showMsg("consoleSettingsMsg", "通用设置已保存。", true);
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

function personaListAnimationKey(node) {
  if (node?.dataset?.personaCard) return `persona:${node.dataset.personaCard}`;
  if (node?.dataset?.personaFolder) return `group:${node.dataset.personaFolder}`;
  return "";
}

function animatePersonaListRender(mutator) {
  const host = $("moduleBody");
  const before = new Map();
  if (host) {
    host.querySelectorAll("[data-persona-card], [data-persona-folder]").forEach((node) => {
      const key = personaListAnimationKey(node);
      if (key) before.set(key, node.getBoundingClientRect());
    });
  }
  mutator();
  if (!host || !before.size) return;
  const animated = [];
  host.querySelectorAll("[data-persona-card], [data-persona-folder]").forEach((node) => {
    const key = personaListAnimationKey(node);
    const oldRect = before.get(key);
    if (!oldRect) return;
    const newRect = node.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    node.style.transition = "none";
    node.style.transform = `translate(${dx}px, ${dy}px)`;
    animated.push(node);
  });
  requestAnimationFrame(() => {
    animated.forEach((node) => {
      node.style.transition = "";
      node.style.transform = "";
      node.classList.add("is-settling");
      window.setTimeout(() => node.classList.remove("is-settling"), 260);
    });
  });
}

function personaCollectionModel() {
  const groups = personaCollectionGroups().map((group) => ({
    id: String(group.id || ""),
    persona_ids: (group.persona_ids || []).map((id) => String(id || "")).filter(Boolean),
  }));
  const assigned = new Set(groups.flatMap((group) => group.persona_ids));
  const ungrouped_persona_ids = orderedUngroupedPersonas(assigned).map((persona) => String(persona.id || "")).filter(Boolean);
  return { groups, ungrouped_persona_ids };
}

function setPersonaCollectionModel(model) {
  const previousGroups = new Map(personaCollectionGroups().map((group) => [String(group.id || ""), group]));
  const groups = (model.groups || []).map((group) => ({
    ...(previousGroups.get(String(group.id || "")) || { id: String(group.id || ""), name: "分组", collapsed: false }),
    persona_ids: (group.persona_ids || []).map((id) => String(id || "")).filter(Boolean),
  }));
  const assigned = new Set(groups.flatMap((group) => group.persona_ids || []));
  state.personaCollections = {
    ...(state.personaCollections || {}),
    groups,
    assigned_persona_ids: Array.from(assigned).sort(),
    ungrouped_persona_ids: (model.ungrouped_persona_ids || []).map((id) => String(id || "")).filter((id) => id && !assigned.has(id)),
  };
}

function movePersonaInCollectionModel(model, personaId, targetGroupId, beforeId = "") {
  const cleanPersonaId = String(personaId || "");
  if (!cleanPersonaId) return null;
  const cleanTargetGroupId = String(targetGroupId || "");
  const cleanBeforeId = String(beforeId || "");
  const next = {
    groups: (model.groups || []).map((group) => ({
      id: String(group.id || ""),
      persona_ids: (group.persona_ids || []).map((id) => String(id || "")).filter((id) => id && id !== cleanPersonaId),
    })),
    ungrouped_persona_ids: (model.ungrouped_persona_ids || []).map((id) => String(id || "")).filter((id) => id && id !== cleanPersonaId),
  };
  const targetList = cleanTargetGroupId
    ? next.groups.find((group) => group.id === cleanTargetGroupId)?.persona_ids
    : next.ungrouped_persona_ids;
  if (!targetList) return null;
  const beforeIndex = cleanBeforeId ? targetList.indexOf(cleanBeforeId) : -1;
  if (beforeIndex >= 0) targetList.splice(beforeIndex, 0, cleanPersonaId);
  else targetList.push(cleanPersonaId);
  return next;
}

async function savePersonaCollectionModel(model, message = "排序已保存。") {
  const seq = Number(state.personaDragSaveSeq || 0) + 1;
  state.personaDragSaveSeq = seq;
  const result = await api("/api/persona_dashboard/groups/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(model),
  });
  if (seq !== state.personaDragSaveSeq) return;
  state.personaCollections = result && Array.isArray(result.groups)
    ? result
    : state.personaCollections;
  showMsg("commandMsg", message, true);
  animatePersonaListRender(renderPersonaModule);
}

function clearPersonaDropVisuals({ keepPlaceholder = false } = {}) {
  if (!keepPlaceholder) {
    const placeholder = state.personaDropState?.placeholder;
    if (placeholder?.parentNode) placeholder.parentNode.removeChild(placeholder);
    document.querySelectorAll(".persona-drop-placeholder").forEach((node) => node.remove());
  }
  document.querySelectorAll(".is-drag-over").forEach((node) => node.classList.remove("is-drag-over"));
  state.personaDropState = {
    placeholder: keepPlaceholder ? state.personaDropState?.placeholder || null : null,
    zoneId: null,
    beforeId: null,
    zone: null,
  };
}

function personaDropListElement(zone) {
  if (!zone) return null;
  if (zone.classList.contains("persona-layer-group")) return zone.querySelector(".persona-layer-children");
  return zone;
}

function personaDropZoneId(zone) {
  const value = String(zone?.dataset?.personaDropZone || "");
  return value === "root" ? "" : value;
}

function personaDropZoneFromTarget(target) {
  return target?.closest?.("[data-persona-drop-zone]") || null;
}

function personaDropZoneAtPoint(x, y) {
  const zones = Array.from(document.querySelectorAll("[data-persona-drop-zone]"))
    .map((zone) => ({ zone, rect: zone.getBoundingClientRect() }))
    .filter(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
    .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
  return zones[0]?.zone || null;
}

function personaDropBeforeId(zone, clientY, draggedId) {
  const list = personaDropListElement(zone);
  if (!list) return "";
  const cards = Array.from(list.querySelectorAll(".persona-list-card[data-persona-card]"))
    .filter((card) => card.parentElement === list && String(card.dataset.personaCard || "") !== String(draggedId || ""));
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return String(card.dataset.personaCard || "");
  }
  return "";
}

function movePersonaDropPlaceholder(zone, beforeId) {
  const list = personaDropListElement(zone);
  if (!list) return;
  const zoneId = personaDropZoneId(zone);
  const cleanBeforeId = String(beforeId || "");
  const previous = state.personaDropState || {};
  const previousList = personaDropListElement(previous.zone);
  if (
    previous.placeholder
    && previous.placeholder.parentNode
    && previous.zoneId === zoneId
    && previous.beforeId === cleanBeforeId
    && previousList === list
  ) {
    return;
  }
  if (previous.zone !== zone || previousList !== list) {
    clearPersonaDropVisuals({ keepPlaceholder: true });
  }
  zone.classList.add("is-drag-over");
  list.classList.add("is-drag-over");
  const placeholder = previous.placeholder || document.createElement("div");
  if (!placeholder.className) placeholder.className = "persona-drop-placeholder";
  const beforeNode = beforeId ? Array.from(list.querySelectorAll(".persona-list-card[data-persona-card]")).find((node) => String(node.dataset.personaCard || "") === String(beforeId)) : null;
  if (placeholder.parentNode !== list || placeholder.nextSibling !== (beforeNode || null)) {
    list.insertBefore(placeholder, beforeNode || null);
  }
  state.personaDropState = { placeholder, zoneId, beforeId: cleanBeforeId, zone };
}

function handlePersonaDragStart(event) {
  const card = event.target.closest?.("[data-persona-drag-persona]");
  if (!card || event.target.closest?.(".persona-card-edit, .persona-card-menu, .persona-card-submenu")) return;
  const personaId = String(card.dataset.personaDragPersona || "");
  if (!personaId) return;
  state.personaListEditorId = "";
  state.personaListEditorMode = "";
  removePersonaCardEditorPortal();
  state.personaDrag = {
    type: "persona",
    id: personaId,
    fromGroupId: String(card.dataset.groupId || ""),
    targetGroupId: String(card.dataset.groupId || ""),
    beforeId: "",
  };
  card.classList.add("is-dragging");
  document.body.classList.add("persona-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", personaId);
  requestAnimationFrame(() => {
    if (state.personaDrag?.id === personaId) card.classList.add("is-drag-source-hidden");
  });
}

function handlePersonaDragOver(event) {
  if (state.personaDrag?.type !== "persona") return;
  const zone = personaDropZoneFromTarget(event.target);
  if (!zone) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const beforeId = personaDropBeforeId(zone, event.clientY, state.personaDrag.id);
  state.personaDrag.targetGroupId = personaDropZoneId(zone);
  state.personaDrag.beforeId = beforeId;
  movePersonaDropPlaceholder(zone, beforeId);
}

function handlePersonaDrop(event) {
  if (state.personaDrag?.type !== "persona") return;
  const zone = personaDropZoneFromTarget(event.target);
  if (!zone) return;
  event.preventDefault();
  const personaId = state.personaDrag.id;
  const targetGroupId = personaDropZoneId(zone);
  const beforeId = personaDropBeforeId(zone, event.clientY, personaId);
  const nextModel = movePersonaInCollectionModel(personaCollectionModel(), personaId, targetGroupId, beforeId);
  state.personaDrag = { type: "", id: "", fromGroupId: "", targetGroupId: "", beforeId: "" };
  document.body.classList.remove("persona-dragging");
  document.querySelectorAll(".persona-list-card.is-dragging, .persona-list-card.is-drag-source-hidden").forEach((node) => node.classList.remove("is-dragging", "is-drag-source-hidden"));
  clearPersonaDropVisuals();
  if (!nextModel) return;
  setPersonaCollectionModel(nextModel);
  renderPersonaModule();
  const targetName = targetGroupId
    ? personaCollectionGroups().find((group) => String(group.id || "") === targetGroupId)?.name || "分组"
    : "未分组";
  savePersonaCollectionModel(nextModel, `已移动到${targetName}。`).catch((error) => {
    showMsg("commandMsg", error.detail || error.message || "拖拽保存失败", false);
    loadPersonas().catch(() => {});
  });
}

function handlePersonaDragEnd() {
  state.personaDrag = { type: "", id: "", fromGroupId: "", targetGroupId: "", beforeId: "" };
  document.body.classList.remove("persona-dragging");
  clearPersonaDropVisuals();
  document.querySelectorAll(".persona-list-card.is-dragging, .persona-list-card.is-drag-source-hidden").forEach((node) => node.classList.remove("is-dragging", "is-drag-source-hidden"));
}

function defaultPersonaPointerDrag() {
  return {
    active: false,
    pending: false,
    id: "",
    fromGroupId: "",
    pointerId: 0,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    lockX: 0,
    targetGroupId: "",
    beforeId: "",
    source: null,
    ghost: null,
  };
}

function cleanupPersonaPointerDrag() {
  const drag = state.personaPointerDrag || {};
  if (state.personaPointerRaf) {
    cancelAnimationFrame(state.personaPointerRaf);
    state.personaPointerRaf = 0;
  }
  if (drag.ghost?.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
  if (drag.source) {
    drag.source.classList.remove("is-pointer-dragging", "is-dragging", "is-drag-source-hidden");
    try {
      drag.source.releasePointerCapture?.(drag.pointerId);
    } catch {}
  }
  document.body.classList.remove("persona-touch-dragging");
  clearPersonaDropVisuals();
  state.personaPointerDrag = defaultPersonaPointerDrag();
}

function personaPointerDragCardFromTarget(target) {
  const card = target?.closest?.("[data-persona-drag-persona]");
  if (!card) return null;
  if (target.closest?.(".persona-card-edit, .persona-card-menu, .persona-card-submenu, input, select, textarea, a")) return null;
  return card;
}

function createPersonaPointerGhost(card, x, y) {
  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add("persona-pointer-ghost");
  ghost.classList.remove("is-active", "is-editing", "is-dragging", "is-pointer-dragging", "is-drag-source-hidden");
  ghost.style.width = `${rect.width}px`;
  ghost.style.left = "0";
  ghost.style.top = "0";
  document.body.appendChild(ghost);
  updatePersonaPointerGhost(ghost, x, y);
  return ghost;
}

function updatePersonaPointerGhost(ghost, x, y) {
  if (!ghost) return;
  ghost.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -50%) scale(1.02)`;
}

function scrollPersonaListDuringPointerDrag(y) {
  const scrollHost = $("moduleBody")?.querySelector(".persona-list-scroll");
  if (!scrollHost) return;
  const rect = scrollHost.getBoundingClientRect();
  const edge = 54;
  if (y < rect.top + edge) scrollHost.scrollTop -= Math.max(4, Math.round((rect.top + edge - y) / 4));
  if (y > rect.bottom - edge) scrollHost.scrollTop += Math.max(4, Math.round((y - (rect.bottom - edge)) / 4));
}

function updatePersonaPointerDropTarget(x, y) {
  const drag = state.personaPointerDrag || {};
  if (!drag.active) return;
  scrollPersonaListDuringPointerDrag(y);
  const target = document.elementFromPoint(x, y);
  const zone = personaDropZoneAtPoint(x, y) || personaDropZoneFromTarget(target);
  if (!zone) return;
  const beforeId = personaDropBeforeId(zone, y, drag.id);
  drag.targetGroupId = personaDropZoneId(zone);
  drag.beforeId = beforeId;
  movePersonaDropPlaceholder(zone, beforeId);
}

function schedulePersonaPointerDragFrame() {
  if (state.personaPointerRaf) return;
  state.personaPointerRaf = requestAnimationFrame(() => {
    state.personaPointerRaf = 0;
    const drag = state.personaPointerDrag || {};
    if (!drag.active) return;
    const x = drag.lockX || drag.startX || drag.currentX;
    updatePersonaPointerGhost(drag.ghost, x, drag.currentY);
    updatePersonaPointerDropTarget(x, drag.currentY);
  });
}

function startPersonaPointerDrag(event) {
  const drag = state.personaPointerDrag || {};
  if (!drag.pending || drag.active || drag.pointerId !== event.pointerId || !drag.source) return;
  drag.active = true;
  drag.currentX = event.clientX;
  drag.currentY = event.clientY;
  drag.lockX = drag.lockX || drag.startX || event.clientX;
  drag.targetGroupId = drag.fromGroupId;
  drag.beforeId = "";
  drag.ghost = createPersonaPointerGhost(drag.source, drag.lockX, event.clientY);
  drag.source.classList.add("is-pointer-dragging", "is-dragging", "is-drag-source-hidden");
  document.body.classList.add("persona-touch-dragging");
  schedulePersonaPointerDragFrame();
}

function finishPersonaPointerDrag() {
  const drag = state.personaPointerDrag || {};
  if (!drag.active) {
    cleanupPersonaPointerDrag();
    return;
  }
  state.personaSuppressClickUntil = Date.now() + 350;
  if (state.personaPointerRaf) {
    cancelAnimationFrame(state.personaPointerRaf);
    state.personaPointerRaf = 0;
  }
  updatePersonaPointerDropTarget(drag.lockX || drag.startX || drag.currentX, drag.currentY);
  const nextModel = movePersonaInCollectionModel(personaCollectionModel(), drag.id, drag.targetGroupId, drag.beforeId);
  const targetGroupId = drag.targetGroupId;
  cleanupPersonaPointerDrag();
  if (!nextModel) return;
  setPersonaCollectionModel(nextModel);
  renderPersonaModule();
  const targetName = targetGroupId
    ? personaCollectionGroups().find((group) => String(group.id || "") === targetGroupId)?.name || "分组"
    : "未分组";
  savePersonaCollectionModel(nextModel, `已移动到${targetName}。`).catch((error) => {
    showMsg("commandMsg", error.detail || error.message || "拖拽保存失败", false);
    loadPersonas().catch(() => {});
  });
}

function handlePersonaPointerDown(event) {
  if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
  const card = personaPointerDragCardFromTarget(event.target);
  if (!card) return;
  const rect = card.getBoundingClientRect();
  state.personaPointerDrag = {
    ...defaultPersonaPointerDrag(),
    pending: true,
    id: String(card.dataset.personaDragPersona || ""),
    fromGroupId: String(card.dataset.groupId || ""),
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    currentX: event.clientX,
    currentY: event.clientY,
    lockX: Math.round(rect.left + rect.width / 2),
    source: card,
  };
  try {
    card.setPointerCapture?.(event.pointerId);
  } catch {}
}

function handlePersonaPointerMove(event) {
  const drag = state.personaPointerDrag || {};
  if (!drag.pending || drag.pointerId !== event.pointerId) return;
  const dy = event.clientY - drag.startY;
  if (!drag.active && Math.abs(dy) < 8) return;
  event.preventDefault();
  if (!drag.active) startPersonaPointerDrag(event);
  drag.currentX = event.clientX;
  drag.currentY = event.clientY;
  schedulePersonaPointerDragFrame();
}

function handlePersonaPointerUp(event) {
  const drag = state.personaPointerDrag || {};
  if (!drag.pending || drag.pointerId !== event.pointerId) return;
  if (drag.active) event.preventDefault();
  finishPersonaPointerDrag();
}

function handlePersonaPointerCancel(event) {
  const drag = state.personaPointerDrag || {};
  if (!drag.pending || drag.pointerId !== event.pointerId) return;
  cleanupPersonaPointerDrag();
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
  const canCancel = activeTaskStatus(task.status);
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
      ${publishedUrl || canCancel ? `<div class="row-actions">
        ${publishedUrl ? `<a href="${esc(publishedUrl)}" target="_blank" rel="noopener">查看任务结果</a>` : ""}
        ${canCancel ? `<button type="button" class="danger" data-persona-cancel-social-task="${esc(task.id)}">停止任务</button>` : ""}
      </div>` : ""}
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
  syncPersonaHotImportPosts(key, posts);
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
  const data = await api(`/api/persona_dashboard/personas/${encodeURIComponent(key)}/images`).catch(() => ({ ok: true, items: [], current_reference_url: "" }));
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

async function activateCreatedPersona(personaId, { group = "settings", step = "profile" } = {}) {
  state.selectedPersonaId = personaId || state.selectedPersonaId;
  state.selectedPersonaPostId = "";
  state.personaGroup = group;
  if (group === "settings") state.personaPanels.settings = step;
  if (group === "content") state.personaPanels.content = step;
  state.personaCreateMode = false;
  await loadPersonas();
  await loadPersonaProfile(state.selectedPersonaId, { force: true }).catch(() => {});
  await loadPersonaDraftPosts(state.selectedPersonaId, { force: true }).catch(() => {});
  if (group === "settings" && step === "images") {
    await loadPersonaImageLibrary(state.selectedPersonaId, { force: true }).catch(() => {});
  }
  renderConfirmSummary();
}

async function createPersonaArchive() {
  const busyKind = personaCreateBusyKind();
  if (busyKind) {
    showMsg("commandMsg", `${busyKind}正在执行，请等待当前任务完成。`, false);
    return;
  }
  const createState = snapshotPersonaCreateInputs();
  const name = String(createState.manualName || "").trim();
  const content = String(createState.manualContent || "").trim();
  if (!name) {
    showMsg("commandMsg", "请先填写人设名称。", false);
    return;
  }
  if (!content) {
    showMsg("commandMsg", "请先填写人设简介。", false);
    return;
  }
  state.personaCreateBusy.manual = true;
  renderPersonaDetail();
  try {
    showMsg("commandMsg", "正在新建人设...", true);
    const result = await api("/api/persona_dashboard/personas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    });
    state.personaCreate = defaultPersonaCreateState();
    showMsg("commandMsg", `人设已创建：${result.name || result.id || "-"}`, true);
    await activateCreatedPersona(result.id || state.selectedPersonaId, { group: "settings", step: "profile" });
  } finally {
    state.personaCreateBusy.manual = false;
    if (state.personaCreateMode) renderPersonaDetail();
  }
}

async function suggestPersonaCreateKeywords() {
  const busyKind = personaCreateBusyKind();
  if (busyKind) {
    showMsg("commandMsg", `${busyKind}正在执行，请等待当前任务完成。`, false);
    return;
  }
  const createState = snapshotPersonaCreateInputs();
  const name = String(createState.aiName || "").trim();
  const prompt = String(createState.aiPrompt || "").trim();
  if (!name) {
    showMsg("commandMsg", "请先填写人设名称。", false);
    return;
  }
  if (!prompt) {
    showMsg("commandMsg", "请先填写人设提示词。", false);
    return;
  }
  state.personaCreateBusy.keywords = true;
  renderPersonaDetail();
  try {
    showMsg("commandMsg", "正在提炼人设方向关键词...", true);
    const result = await api("/api/persona_dashboard/personas/ai_keywords", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, prompt }),
    });
    createState.aiStep = "keywords";
    createState.aiKeywords = Array.isArray(result.keywords) ? result.keywords : [];
    createState.aiSelectedKeywords = [];
    createState.aiResult = null;
    renderPersonaDetail();
    showMsg("commandMsg", "已提炼出人设方向关键词。", true);
  } finally {
    state.personaCreateBusy.keywords = false;
    if (state.personaCreateMode) renderPersonaDetail();
  }
}

async function createPersonaArchiveWithAi() {
  const busyKind = personaCreateBusyKind();
  if (busyKind) {
    showMsg("commandMsg", `${busyKind}正在执行，请等待当前任务完成。`, false);
    return;
  }
  const createState = snapshotPersonaCreateInputs();
  const name = String(createState.aiName || "").trim();
  const prompt = String(createState.aiPrompt || "").trim();
  if (!name) {
    showMsg("commandMsg", "请先填写人设名称。", false);
    return;
  }
  if (!prompt) {
    showMsg("commandMsg", "请先填写人设提示词。", false);
    return;
  }
  state.personaCreateBusy.aiCreate = true;
  renderPersonaDetail();
  try {
    showMsg("commandMsg", "正在根据提示词生成人设...", true);
    const result = await api("/api/persona_dashboard/personas/ai_create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        prompt,
        selected_keywords: Array.isArray(createState.aiSelectedKeywords) ? createState.aiSelectedKeywords : [],
      }),
    });
    const profile = result.profile || {};
    createState.aiStep = "created";
    createState.aiResult = {
      id: profile.id || "",
      name: profile.name || name,
      content: profile.content || "",
      selectedKeywords: Array.isArray(result.selected_keywords) ? result.selected_keywords : [],
    };
    await loadPersonas();
    if (createState.aiResult.id) {
      state.selectedPersonaId = createState.aiResult.id;
      await loadPersonaProfile(createState.aiResult.id, { force: true }).catch(() => {});
    }
    renderPersonaDetail();
    showMsg("commandMsg", `AI 人设已创建：${createState.aiResult.name || "-"}`, true);
  } finally {
    state.personaCreateBusy.aiCreate = false;
    if (state.personaCreateMode) renderPersonaDetail();
  }
}

function generatePersonaPayloadFromState(persona, profile = selectedPersonaProfile()) {
  const form = personaFormState(persona.id).generate;
  const defaults = personaGenerateDefaults();
  return {
    count: defaults.count,
    prompt: String(form.prompt || "").trim(),
    target_words: defaults.targetWords,
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
  const lockParts = ["persona", persona.id, "generate_posts"];
  if (isActionLocked(...lockParts)) {
    showMsg("commandMsg", "当前人设正在生成草稿，请等待本次生成完成。", false);
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
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
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
  } finally {
    setActionLocked(lockParts, false);
    if (state.activeModule === "personas") renderPersonaDetail();
  }
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
  const editingPostId = String(form.editingPostId || "").trim();
  if (!content) {
    showMsg("commandMsg", "请先填写推文正文。", false);
    return;
  }
  showMsg("commandMsg", editingPostId ? "正在保存草稿修改..." : "正在保存推文草稿...", true);
  const result = await api(
    editingPostId
      ? `/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts/${encodeURIComponent(editingPostId)}`
      : `/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts`,
    {
      method: editingPostId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content }),
    },
  );
  state.selectedPersonaPostId = result.id || editingPostId || "";
  state.personaPanels.content = "posts";
  personaFormState(persona.id).draft = { title: "", content: "", editingPostId: "" };
  if ($("personaDraftTitle")) $("personaDraftTitle").value = "";
  if ($("personaDraftContent")) $("personaDraftContent").value = "";
  await loadPersonaDraftPosts(persona.id, { force: true });
  renderConfirmSummary();
  showMsg("commandMsg", editingPostId ? `草稿已更新：${result.title || result.id || "-"}` : `草稿已保存：${result.title || result.id || "-"}`, true);
}

async function fetchPersonaHotCandidates(refresh = false) {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  const lockParts = ["persona", persona.id, "hot_candidates"];
  if (isActionLocked(...lockParts)) {
    showMsg("commandMsg", "热点候选正在抓取，请等待当前抓取完成。", false);
    return;
  }
  snapshotPersonaCurrentForm();
  const form = personaFormState(persona.id).generate;
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
    showMsg("commandMsg", refresh ? "正在刷新热点候选..." : "正在抓取热点候选...", true);
    const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/hot_candidates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refresh: Boolean(refresh),
        limit: 10,
      }),
    });
    state.personaHotCandidateResults[String(persona.id)] = {
      candidates: Array.isArray(result.candidates) ? result.candidates : [],
      keywords: Array.isArray(result.keywords) ? result.keywords : [],
      cookie_statuses: Array.isArray(result.cookie_statuses) ? result.cookie_statuses : [],
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      fetched_at: new Date().toISOString(),
    };
    const candidateIds = personaHotCandidates(persona).map((item) => String(item.candidate_id || "").trim()).filter(Boolean);
    form.hotSelectedIds = (form.hotSelectedIds || []).filter((item) => candidateIds.includes(String(item || "").trim()));
    form.hotPreviewId = candidateIds.includes(String(form.hotPreviewId || "").trim()) ? String(form.hotPreviewId || "").trim() : (candidateIds[0] || "");
    form.hotDeletedMediaByCandidate = {};
    form.hotEditedContentByCandidate = {};
    renderPersonaDetail();
    renderConfirmSummary();
    showMsg("commandMsg", `已获取 ${candidateIds.length} 条热点候选。`, true);
  } finally {
    setActionLocked(lockParts, false);
    if (state.activeModule === "personas") renderPersonaDetail();
  }
}

async function submitPersonaHotDraftImport(persona, selected) {
  const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/hot_candidates/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      candidates: selected.map((candidate) => ({
        id: candidate.id || candidate.candidate_id,
        platform: candidate.platform,
        author: candidate.author || "",
        sourceUrl: candidate.source_url,
        content: candidate.full_content || candidate.content || "",
        hotScore: Number(candidate.hot_score || candidate.score || 0),
        metrics: candidate.metrics || {},
        engagement: candidate.engagement || {},
        publishedAt: candidate.published_at || "",
        capturedAt: candidate.captured_at || "",
        warnings: Array.isArray(candidate.warnings) ? candidate.warnings : [],
        media: Array.isArray(candidate.media_items) ? candidate.media_items.map((item) => ({
          url: item.url || item.preview_url || "",
          type: item.type || "",
        })) : [],
      })),
    }),
  });
  const createdIds = Array.isArray(result.posts) ? result.posts.map((item) => String(item?.id || "").trim()).filter(Boolean) : [];
  if (createdIds.length) state.selectedPersonaPostId = createdIds[0];
  const form = personaFormState(persona.id).generate;
  form.hotSelectedIds = [];
  form.hotPreviewId = "";
  form.hotDeletedMediaByCandidate = {};
  form.hotEditedContentByCandidate = {};
  await loadPersonaDraftPosts(persona.id, { force: true });
  state.personaPanels.content = "posts";
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", `已导入 ${result.imported_count || createdIds.length || 0} 条热点草稿。`, true);
}

async function importPersonaHotDrafts(candidateIds = null) {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  const lockParts = ["persona", persona.id, "hot_import"];
  if (isActionLocked(...lockParts)) {
    showMsg("commandMsg", "热点草稿正在导入，请等待当前导入完成。", false);
    return;
  }
  const requestedIds = Array.isArray(candidateIds)
    ? candidateIds.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const selected = (requestedIds.length
    ? personaHotCandidates(persona).filter((item) => requestedIds.includes(String(item.candidate_id || item.id || "").trim()))
    : personaHotSelectedCandidates(persona))
    .filter((item) => String(item.full_content || item.content || "").trim());
  if (!selected.length) {
    showMsg("commandMsg", "请先勾选至少一条带正文的热点候选。", false);
    return;
  }
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
    showMsg("commandMsg", `正在导入 ${selected.length} 条热点候选到草稿库...`, true);
    await submitPersonaHotDraftImport(persona, selected);
  } finally {
    setActionLocked(lockParts, false);
    if (state.activeModule === "personas") renderPersonaDetail();
  }
}

async function importEditedPersonaHotDraft(candidateId = "") {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  const cleanCandidateId = String(candidateId || "").trim();
  const candidate = personaHotCandidates(persona).find((item) => String(item.candidate_id || item.id || "").trim() === cleanCandidateId);
  if (!candidate) {
    showMsg("commandMsg", "当前热点候选不存在。", false);
    return;
  }
  const editedContent = String(document.querySelector("#personaHotPreviewContent")?.value || "").trim();
  if (!editedContent) {
    showMsg("commandMsg", "请先填写导入正文。", false);
    return;
  }
  const lockParts = ["persona", persona.id, "hot_import"];
  if (isActionLocked(...lockParts)) {
    showMsg("commandMsg", "热点草稿正在导入，请等待当前导入完成。", false);
    return;
  }
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
    showMsg("commandMsg", "正在导入当前编辑后的热点草稿...", true);
    const deleted = personaHotDeletedMediaSet(persona.id, cleanCandidateId);
    const mediaItems = personaHotCandidateMediaItems(candidate).filter((_, index) => !deleted.has(index));
    await submitPersonaHotDraftImport(persona, [{
      ...candidate,
      content: editedContent.slice(0, 280),
      full_content: editedContent,
      media_items: mediaItems,
    }]);
  } finally {
    setActionLocked(lockParts, false);
    if (state.activeModule === "personas") renderPersonaDetail();
  }
}

function resetPersonaDraftEditor(personaId) {
  const form = personaFormState(personaId);
  form.generate.mode = "custom";
  form.draft = { title: "", content: "", editingPostId: "" };
}

function openPersonaDraftEditor(postId) {
  const persona = selectedPersona();
  if (!persona) return;
  const post = personaDraftPosts(persona).find((item) => String(item.id) === String(postId || "").trim());
  if (!post) {
    showMsg("commandMsg", "当前草稿不存在或已被删除。", false);
    return;
  }
  const form = personaFormState(persona.id);
  form.generate.mode = "custom";
  form.draft = {
    title: String(post.title || "").trim(),
    content: String(post.content || ""),
    editingPostId: String(post.id || "").trim(),
  };
  state.selectedPersonaPostId = post.id || state.selectedPersonaPostId;
  state.personaGroup = "content";
  state.personaPanels.content = "generate";
  renderPersonaDetail();
  renderConfirmSummary();
}

function preparePersonaDraftRewrite(postId) {
  const persona = selectedPersona();
  if (!persona) return;
  const post = personaDraftPosts(persona).find((item) => String(item.id) === String(postId || "").trim());
  if (!post) {
    showMsg("commandMsg", "当前草稿不存在或已被删除。", false);
    return;
  }
  const form = personaFormState(persona.id);
  form.generate.mode = "ai";
  form.generate.prompt = String(post.content || "").trim();
  form.draft = { title: "", content: "", editingPostId: "" };
  state.selectedPersonaPostId = post.id || state.selectedPersonaPostId;
  state.personaGroup = "content";
  state.personaPanels.content = "generate";
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", "已带入当前草稿正文，可继续用 AI 重新生成新的推文候选。", true);
}

async function deletePersonaDraftPost(postId = "") {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  const cleanPostId = String(postId || state.selectedPersonaPostId || "").trim();
  const post = personaDraftPosts(persona).find((item) => String(item.id) === cleanPostId);
  if (!post) {
    showMsg("commandMsg", "当前草稿不存在或已被删除。", false);
    return;
  }
  const confirmed = await openConsoleModal({
    title: "删除草稿",
    message: `确认删除“${String(post.title || "未命名草稿").trim() || "未命名草稿"}”吗？`,
    confirmText: "删除",
    cancelText: "取消",
    danger: true,
  });
  if (!confirmed) return;
  showMsg("commandMsg", "正在删除草稿...", true);
  await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts/by_id/${encodeURIComponent(cleanPostId)}`, {
    method: "DELETE",
  });
  deletePersonaHotImportMeta(persona.id, cleanPostId);
  resetPersonaDraftEditor(persona.id);
  if ($("personaDraftTitle")) $("personaDraftTitle").value = "";
  if ($("personaDraftContent")) $("personaDraftContent").value = "";
  await Promise.all([
    loadPersonaDraftPosts(persona.id, { force: true }),
    loadPersonaPublishHistory(persona.id, { force: true }).catch(() => []),
  ]);
  state.personaPanels.content = personaDraftPosts(persona).length ? "posts" : "generate";
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", "草稿已删除。", true);
}

async function submitPersonaImageGeneration() {
  const persona = selectedPersona();
  const profile = selectedPersonaProfile();
  if (!persona || !profile) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  const lockParts = ["persona", persona.id, "image_generate"];
  if (isActionLocked(...lockParts)) {
    showMsg("commandMsg", "当前人设图正在生成，请等待本次生成完成。", false);
    return;
  }
  snapshotPersonaCurrentForm();
  const form = personaFormState(persona.id).images;
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
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
  } finally {
    setActionLocked(lockParts, false);
    if (state.activeModule === "personas") renderPersonaDetail();
  }
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
  const allowedTaskTypes = personaMediaTaskOptions(profile, personaFormState(persona.id).generate).map(([value]) => value);
  const taskType = allowedTaskTypes.includes(String(form.taskType || ""))
    ? String(form.taskType || "")
    : String(allowedTaskTypes[0] || "persona_post_image");
  form.taskType = taskType;
  const lockParts = ["media_task", persona.id, post.id, taskType];
  if (isActionLocked(...lockParts) || personaMediaTaskIsActive(persona.id, post.id, taskType)) {
    showMsg("commandMsg", "当前草稿已有同类型配图任务在队列或执行中，请等待完成后再提交。", false);
    return;
  }
  const files = filesFromInput("personaMediaTaskFiles");
  const imageCount = files.filter((file) => fileKind(file) === "image").length;
  const minImages = Number(taskMeta[taskType]?.minImages || 0);
  if (imageCount < minImages) {
    showMsg("commandMsg", `当前任务至少需要 ${minImages} 张图片素材。`, false);
    return;
  }
  const fallbackPrompt = String(post.content || "").trim();
  const prompt = String(form.prompt || "").trim() || fallbackPrompt;
  if (taskType === "persona_post_image" && !prompt) {
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
    aspect_ratio: taskType === "persona_post_image" ? String(form.aspectRatio || "1:1") : undefined,
  });
  const body = new FormData();
  body.append("task_type", taskType);
  body.append("params_json", JSON.stringify(params));
  files.forEach((file) => body.append("files", file, file.name));
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
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
  } finally {
    setActionLocked(lockParts, false);
    if (state.activeModule === "personas") renderPersonaDetail();
  }
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
  if ($("personaPostMediaUploadFiles")) {
    $("personaPostMediaUploadFiles").value = "";
    syncUploadDropzone($("personaPostMediaUploadFiles"));
  }
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
  void persona;
  void profile;
  return false;
}

function personaKindLabel(persona, profile = null) {
  void persona;
  void profile;
  return "普通";
}

function renderPersonaSelectOptions(personas) {
  return (personas || []).map((persona) => {
    const kind = "普通";
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

function orderedUngroupedPersonas(assigned = personaAssignedIds()) {
  const byId = personaByIdMap();
  const seen = new Set();
  const orderedIds = Array.isArray(state.personaCollections?.ungrouped_persona_ids)
    ? state.personaCollections.ungrouped_persona_ids.map((id) => String(id || ""))
    : [];
  const ordered = [];
  orderedIds.forEach((id) => {
    const persona = byId.get(id);
    if (persona && !assigned.has(id) && !seen.has(id)) {
      ordered.push(persona);
      seen.add(id);
    }
  });
  state.personas.forEach((persona) => {
    const id = String(persona.id || "");
    if (id && !assigned.has(id) && !seen.has(id)) {
      ordered.push(persona);
      seen.add(id);
    }
  });
  return ordered;
}

function renderPersonaKindBadge(persona) {
  void persona;
  return `<span class="persona-kind-badge">普通</span>`;
}

function personaCardEditorMode(personaId) {
  const editorId = String(state.personaListEditorId || "");
  if (editorId !== String(personaId || "")) return "";
  return String(state.personaListEditorMode || "");
}

function renderPersonaCardEditorMenu(persona, currentGroups, availableGroups) {
  const personaId = String(persona.id || "");
  const mode = personaCardEditorMode(personaId);
  const submenu = mode === "add" ? `
    <div class="persona-card-submenu" data-persona-editor-submenu="${esc(personaId)}">
      <div class="persona-menu-head">
        <button type="button" class="persona-menu-back" data-persona-editor-back="${esc(personaId)}" aria-label="返回操作选项">&lt;</button>
        <strong>加入分组</strong>
      </div>
      <div class="persona-menu-panel">
        <label>选择目标分组
          <select data-persona-add-group-select="${esc(personaId)}">
            <option value="">选择分组</option>
            ${availableGroups.map((group) => `<option value="${esc(group.id)}">${esc(group.name)}</option>`).join("")}
          </select>
        </label>
        <button type="button" data-persona-add-selected-group="${esc(personaId)}" ${availableGroups.length ? "" : "disabled"}>加入</button>
        ${availableGroups.length ? "" : `<span class="persona-editor-empty">暂无可加入的分组。</span>`}
      </div>
    </div>` : mode === "remove" ? `
    <div class="persona-card-submenu" data-persona-editor-submenu="${esc(personaId)}">
      <div class="persona-menu-head">
        <button type="button" class="persona-menu-back" data-persona-editor-back="${esc(personaId)}" aria-label="返回操作选项">&lt;</button>
        <strong>移出分组</strong>
      </div>
      <div class="persona-menu-panel">
        ${currentGroups.length ? `
          <div class="persona-editor-groups">
            ${currentGroups.map((group) => `
              <button type="button" data-persona-remove-from-group="${esc(personaId)}" data-group-id="${esc(group.id)}">移出 ${esc(group.name)}</button>
            `).join("")}
          </div>
          <button type="button" data-persona-ungroup-all="${esc(personaId)}">单独拆出来</button>
        ` : `<span class="persona-editor-empty">当前未加入任何组。</span>`}
      </div>
    </div>` : "";
  return `
    <div class="persona-card-menu" data-persona-editor-menu="${esc(personaId)}">
      <div class="persona-menu-tabs" aria-label="人设操作">
        <button type="button" class="persona-menu-tab ${mode === "add" ? "is-active" : ""}" data-persona-editor-mode="${esc(personaId)}:add">
          <span>加入分组</span>
          <small>${availableGroups.length ? `${availableGroups.length} 个可选` : "暂无可选"}</small>
        </button>
        <button type="button" class="persona-menu-tab ${mode === "remove" ? "is-active" : ""}" data-persona-editor-mode="${esc(personaId)}:remove">
          <span>移出分组</span>
          <small>${currentGroups.length ? `${currentGroups.length} 个已加入` : "未加入"}</small>
        </button>
        <button type="button" class="persona-menu-tab" data-persona-ungroup-all="${esc(personaId)}" ${currentGroups.length ? "" : "disabled"}>
          <span>单独拆出来</span>
          <small>${currentGroups.length ? "移出所有组" : "无需操作"}</small>
        </button>
      </div>
    </div>
    ${submenu}`;
}

function positionPersonaCardEditorMenu() {
  const personaId = String(state.personaListEditorId || "");
  if (!personaId || personaId.startsWith("group:") || !$("moduleBody")) return;
  const card = $("moduleBody").querySelector(`[data-persona-card="${CSS.escape(personaId)}"]`);
  const editButton = card?.querySelector("[data-persona-edit]");
  const menu = document.querySelector(`[data-persona-editor-menu="${CSS.escape(personaId)}"]`);
  if (!editButton || !menu) return;
  const gap = 8;
  const margin = 10;
  const buttonRect = editButton.getBoundingClientRect();
  const menuWidth = Math.min(190, Math.max(156, window.innerWidth - margin * 2));
  const menuHeight = menu.offsetHeight || 128;
  const top = Math.min(Math.max(margin, buttonRect.bottom + gap), Math.max(margin, window.innerHeight - menuHeight - margin));
  const left = Math.min(Math.max(margin, buttonRect.right - menuWidth), Math.max(margin, window.innerWidth - menuWidth - margin));
  menu.style.setProperty("--persona-menu-left", `${Math.round(left)}px`);
  menu.style.setProperty("--persona-menu-top", `${Math.round(top)}px`);
  menu.style.setProperty("--persona-menu-width", `${Math.round(menuWidth)}px`);
  const submenu = document.querySelector(`[data-persona-editor-submenu="${CSS.escape(personaId)}"]`);
  if (!submenu) return;
  const menuRect = menu.getBoundingClientRect();
  const renderedMenuLeft = menuRect.left;
  const renderedMenuWidth = menuRect.width || menuWidth;
  const submenuWidth = Math.min(218, Math.max(180, window.innerWidth - margin * 2));
  const submenuHeight = submenu.offsetHeight || 128;
  const rightLeft = renderedMenuLeft + renderedMenuWidth + gap;
  const hasRightRoom = rightLeft + submenuWidth <= window.innerWidth - margin;
  const leftLeft = renderedMenuLeft - submenuWidth - gap;
  const hasLeftRoom = leftLeft >= margin;
  let submenuLeft = rightLeft;
  let submenuTop = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - submenuHeight - margin));
  let placement = "right";
  if (!hasRightRoom && hasLeftRoom) {
    submenuLeft = leftLeft;
    placement = "left";
  } else if (!hasRightRoom) {
    submenuLeft = Math.min(Math.max(margin, renderedMenuLeft), Math.max(margin, window.innerWidth - submenuWidth - margin));
    const menuBottom = menuRect.bottom;
    const belowTop = menuBottom + gap;
    const aboveTop = menuRect.top - submenuHeight - gap;
    submenuTop = belowTop + submenuHeight <= window.innerHeight - margin ? belowTop : Math.max(margin, aboveTop);
    placement = belowTop + submenuHeight <= window.innerHeight - margin ? "below" : "above";
  }
  submenu.classList.toggle("is-left", placement === "left");
  submenu.classList.toggle("is-stacked", placement === "below" || placement === "above");
  submenu.style.setProperty("--persona-submenu-left", `${Math.round(submenuLeft)}px`);
  submenu.style.setProperty("--persona-submenu-top", `${Math.round(submenuTop)}px`);
  submenu.style.setProperty("--persona-submenu-width", `${Math.round(submenuWidth)}px`);
}

function schedulePersonaCardEditorMenuPosition() {
  if (state.activeModule !== "personas") return;
  requestAnimationFrame(positionPersonaCardEditorMenu);
}

function handlePersonaCardEditorPortalClick(event) {
  if (!event.target.closest?.("#personaCardEditorPortal")) return;
  const personaEditorBack = event.target.closest("[data-persona-editor-back]");
  if (personaEditorBack) {
    const personaId = personaEditorBack.dataset.personaEditorBack || "";
    if (state.personaListEditorId === personaId) {
      state.personaListEditorMode = "";
      renderPersonaModule();
    }
    return;
  }
  const personaEditorMode = event.target.closest("[data-persona-editor-mode]");
  if (personaEditorMode) {
    const [personaId, mode] = String(personaEditorMode.dataset.personaEditorMode || "").split(":");
    if (personaId) {
      state.personaListEditorId = personaId;
      state.personaListEditorMode = mode || "";
      renderPersonaModule();
    }
    return;
  }
  const addSelectedGroup = event.target.closest("[data-persona-add-selected-group]");
  if (addSelectedGroup) {
    const personaId = addSelectedGroup.dataset.personaAddSelectedGroup || "";
    const select = document.querySelector(`#personaCardEditorPortal [data-persona-add-group-select="${CSS.escape(personaId)}"]`);
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
  }
}

function removePersonaCardEditorPortal() {
  document.getElementById("personaCardEditorPortal")?.remove();
}

function renderPersonaCardEditorPortal() {
  removePersonaCardEditorPortal();
  const personaId = String(state.personaListEditorId || "");
  if (!personaId || personaId.startsWith("group:") || state.activeModule !== "personas") return;
  const persona = state.personas.find((item) => String(item.id || "") === personaId);
  if (!persona) return;
  const currentGroups = personaGroupsForPersona(persona.id);
  const availableGroups = personaCollectionGroups().filter((group) => !currentGroups.some((item) => item.id === group.id));
  const portal = document.createElement("div");
  portal.id = "personaCardEditorPortal";
  portal.className = "persona-editor-portal";
  portal.innerHTML = renderPersonaCardEditorMenu(persona, currentGroups, availableGroups);
  document.body.appendChild(portal);
  schedulePersonaCardEditorMenuPosition();
}

function renderPersonaCard(persona, groupId = "") {
  const selected = String(persona.id || "") === String(state.selectedPersonaId || "");
  const editing = String(state.personaListEditorId || "") === String(persona.id || "");
  const dragging = String(state.personaDrag?.id || "") === String(persona.id || "") && state.personaDrag?.type === "persona";
  const currentGroups = personaGroupsForPersona(persona.id);
  const availableGroups = personaCollectionGroups().filter((group) => !currentGroups.some((item) => item.id === group.id));
  const ungrouped = !currentGroups.length;
  return `
    <article
      class="persona-list-card persona-draggable-card ${selected ? "is-active" : ""} ${editing ? "is-editing" : ""} ${dragging ? "is-dragging" : ""}"
      data-persona-card="${esc(persona.id)}"
      data-persona-drag-persona="${esc(persona.id)}"
      data-group-id="${esc(groupId)}"
      draggable="false"
    >
      <button type="button" class="persona-list-item" data-persona-select="${esc(persona.id)}">
        <span class="persona-card-title">
          <strong>${esc(persona.name || persona.id || "未命名人设")}</strong>
          ${renderPersonaKindBadge(persona)}
          ${ungrouped ? `<span class="persona-kind-badge persona-ungrouped-badge">未分组</span>` : ""}
        </span>
        <small>${esc(personaExecutionAccountLabel(persona))}</small>
      </button>
      <button type="button" class="persona-card-edit" data-persona-edit="${esc(persona.id)}" title="编辑分组" aria-label="编辑分组">...</button>
    </article>`;
}

function renderPersonaFolder(group, map) {
  const personas = (group.persona_ids || []).map((id) => map.get(String(id))).filter(Boolean);
  const collapsed = Boolean(group.collapsed);
  const editing = String(state.personaListEditorId || "") === `group:${String(group.id || "")}`;
  return `
    <div class="persona-layer-group ${collapsed ? "is-collapsed" : ""}" data-persona-folder="${esc(group.id)}" data-persona-drop-zone="${esc(group.id)}">
      <div class="persona-list-card persona-folder-card ${editing ? "is-editing" : ""}" data-persona-folder-card="${esc(group.id)}">
        <button type="button" class="persona-folder-main" data-persona-toggle-folder="${esc(group.id)}" aria-label="${collapsed ? "展开分组" : "收起分组"}">
          <span class="persona-folder-caret"></span>
          <span class="persona-folder-copy">
            <span class="persona-card-title">
              <strong>${esc(group.name)}</strong>
              <span class="persona-kind-badge">组</span>
              <span class="persona-kind-badge">${personas.length} 个</span>
            </span>
            <small>${collapsed ? "已收起" : "已展开"}</small>
          </span>
        </button>
        <button type="button" class="persona-card-edit" data-persona-edit-group="${esc(group.id)}" title="编辑分组" aria-label="编辑分组">...</button>
        ${editing ? `
          <div class="persona-card-menu persona-card-menu--group">
            <button type="button" data-persona-rename-group="${esc(group.id)}">重命名</button>
            <button type="button" data-persona-delete-group="${esc(group.id)}">删除分组</button>
          </div>
        ` : ""}
      </div>
      <div class="persona-layer-children" data-persona-drop-zone="${esc(group.id)}">${personas.length ? personas.map((persona) => renderPersonaCard(persona, group.id)).join("") : `<div class="persona-layer-empty">这个组还没有人设。</div>`}</div>
    </div>`;
}

function renderPersonaCollectionList() {
  const map = personaByIdMap();
  const groups = personaCollectionGroups();
  const assigned = personaAssignedIds();
  const ungrouped = orderedUngroupedPersonas(assigned);
  const pageSize = Math.min(Math.max(Number(state.personaListPageSize || 20), 5), 80);
  const nodes = [
    ...groups.map((group) => ({ type: "group", group })),
    ...ungrouped.map((persona) => ({ type: "persona", persona })),
  ];
  const totalPages = Math.max(1, Math.ceil(nodes.length / pageSize));
  state.personaListPage = Math.min(Math.max(Number(state.personaListPage || 1), 1), totalPages);
  const start = (state.personaListPage - 1) * pageSize;
  const visibleNodes = nodes.slice(start, start + pageSize);
  const pager = `
    <div class="persona-list-pager">
      <button type="button" data-persona-list-page="first" ${state.personaListPage <= 1 ? "disabled" : ""}>首页</button>
      <button type="button" data-persona-list-page="prev" ${state.personaListPage <= 1 ? "disabled" : ""}>上页</button>
      <span>${esc(`${state.personaListPage} / ${totalPages} · 每页 ${pageSize}`)}</span>
      <button type="button" data-persona-list-page="next" ${state.personaListPage >= totalPages ? "disabled" : ""}>下页</button>
      <button type="button" data-persona-list-page="last" ${state.personaListPage >= totalPages ? "disabled" : ""}>尾页</button>
    </div>
  `;
  return `
    <div class="persona-list-scroll">
      <div class="persona-list-stack" data-persona-drop-zone="root">
        ${visibleNodes.map((node) => node.type === "group" ? renderPersonaFolder(node.group, map) : renderPersonaCard(node.persona)).join("")}
      </div>
    </div>
    ${pager}`;
}

function personaListTotalPages(pageSize = Number(state.personaListPageSize || 20)) {
  const groups = personaCollectionGroups();
  const assigned = personaAssignedIds();
  const ungroupedCount = state.personas.filter((persona) => !assigned.has(String(persona.id || ""))).length;
  const cleanPageSize = Math.min(Math.max(Number(pageSize || 20), 5), 80);
  return Math.max(1, Math.ceil((groups.length + ungroupedCount) / cleanPageSize));
}

function renderPersonaGroupTabs(profile) {
  return `<div class="persona-group-tabs">${Object.entries(personaGroups).map(([key, group]) => `
    <button
      type="button"
      class="${state.personaGroup === key ? "is-active" : ""}"
      data-persona-group="${esc(key)}"
      aria-controls="personaStepTabs"
      title="${esc(`切换到${group.label}分组`)}"
    >${esc(group.label)}</button>
  `).join("")}</div>`;
}

function renderPersonaStepTabs(groupKey, profile) {
  const step = currentPersonaGroupStep(groupKey, profile);
  if (groupKey === "content") {
    const tabs = [
      ["generate", "新建推文"],
      ["media", "推文配图 / 媒体"],
      ["posts", "草稿库"],
    ];
    return `<div class="persona-step-tabs" id="personaStepTabs" aria-label="当前分组的二级页签">${tabs.map(([value, label]) => `
      <button
        type="button"
        class="${(value === "posts" ? ["posts", "history"].includes(step) : value === step) ? "is-active" : ""}"
        data-persona-step="${esc(groupKey)}:${esc(value)}"
      >${esc(label)}</button>
    `).join("")}</div>`;
  }
  return `<div class="persona-step-tabs" id="personaStepTabs" aria-label="当前分组的二级页签">${personaGroupStepOptions(groupKey, profile).map(([value, label]) => `
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
  const activeMode = mode === "custom" || mode === "hot" ? mode : "ai";
  const tabs = [
    ["ai", "AI 生成"],
    ["custom", "自定义输入"],
    ["hot", "热点抓取"],
  ];
  return `<div class="persona-step-tabs persona-subflow-tabs">${tabs.map(([value, label]) => `
      <button
        type="button"
        class="${activeMode === value ? "is-active" : ""}"
        data-persona-generate-mode="${esc(value)}"
      >${esc(label)}</button>
  `).join("")}</div>`;
}

function renderPersonaHotCandidatePreview(candidate) {
  if (!candidate) return `<div class="empty-state">从左侧热点候选里选一条，这里会显示正文预览和来源。</div>`;
  const persona = selectedPersona();
  const candidateId = personaHotCandidateKey(candidate);
  const metrics = [
    `浏览 ${numberText(candidate.view_count || 0)}`,
    `点赞 ${numberText(candidate.like_count || 0)}`,
    `评论 ${numberText(candidate.comment_count || 0)}`,
    `分享 ${numberText(candidate.share_count || 0)}`,
    `转发 ${numberText(candidate.repost_count || 0)}`,
  ];
  return `
    <div class="persona-hot-preview-card">
      <div class="persona-hot-preview-head">
        <strong>${esc((candidate.platform || "threads").toUpperCase())}</strong>
        <small>${esc(formatTime(candidate.captured_at || candidate.published_at || ""))}</small>
      </div>
      <label>导入正文（可改）
        <textarea id="personaHotPreviewContent" rows="7">${esc(personaHotEditedContent(persona?.id, candidate))}</textarea>
      </label>
      <div class="persona-hot-preview-meta">
        <small>${esc(metrics.join(" · "))}</small>
        ${candidate.source_url ? `<a href="${esc(candidate.source_url)}" target="_blank" rel="noopener">打开原帖</a>` : ""}
      </div>
      ${renderPersonaMediaPreview(personaHotCandidateMediaItems(candidate))}
      ${renderPersonaHotMediaDeleteControls(persona, candidate)}
      <div class="row-actions">
        <button type="button" class="primary" data-persona-import-hot-one="${esc(candidateId)}">直接使用这条</button>
        <button type="button" data-persona-import-hot-edit="${esc(candidateId)}">编辑后使用</button>
      </div>
    </div>
  `;
}

function renderPersonaHotCandidatePicker(persona, form) {
  const hotState = state.personaHotCandidateResults[String(persona?.id || "").trim()] || {};
  const candidates = personaHotCandidates(persona);
  const selectedIds = new Set((form.hotSelectedIds || []).map((item) => String(item || "").trim()).filter(Boolean));
  const preview = personaHotPreviewCandidate(persona);
  const keywords = Array.isArray(hotState.keywords) ? hotState.keywords : [];
  const warnings = Array.isArray(hotState.warnings) ? hotState.warnings : [];
  const cookieStatuses = Array.isArray(hotState.cookie_statuses) ? hotState.cookie_statuses : [];
  const hotBusy = isActionLocked("persona", persona?.id || "", "hot_candidates");
  return `
    <div class="persona-hot-filters">
      <div class="persona-head-copy">
        <strong>热点抓取</strong>
        <span>按当前人设和已有记忆自动抓取 Threads / Instagram 热点候选。</span>
      </div>
      <div class="row-actions">
        <button type="button" class="primary" data-persona-fetch-hot ${hotBusy ? "disabled" : ""}>${hotBusy ? "正在抓取热点..." : "抓取热点"}</button>
        <button type="button" data-persona-fetch-hot-refresh ${candidates.length && !hotBusy ? "" : "disabled"}>${hotBusy ? "正在刷新..." : "刷新候选"}</button>
      </div>
    </div>
    ${(keywords.length || warnings.length || cookieStatuses.length) ? `
      <div class="persona-inline-panel persona-inline-panel--nested">
        ${keywords.length ? `<div class="persona-hot-status-row"><strong>本次关键词</strong><span>${esc(keywords.join(" / "))}</span></div>` : ""}
        ${cookieStatuses.length ? `<div class="persona-hot-status-row"><strong>Cookie 状态</strong><span>${esc(cookieStatuses.map((item) => `${item.label || item.platform || "-"}：${item.message || item.health || "-"}`).join(" / "))}</span></div>` : ""}
        ${warnings.length ? `<div class="persona-warning-inline">${warnings.map(esc).join(" / ")}</div>` : ""}
      </div>
    ` : ""}
    ${candidates.length ? `<div class="persona-hot-layout">
      <section class="persona-hot-list">
        <div class="persona-hot-toolbar">
          <strong>候选 ${candidates.length} 条</strong>
          <div class="row-actions">
            <button type="button" data-persona-hot-bulk="all">全选</button>
            <button type="button" data-persona-hot-bulk="clear">清空</button>
          </div>
        </div>
        <div class="persona-hot-grid">
          ${candidates.map((candidate) => {
            const checked = selectedIds.has(candidate.candidate_id);
            const previewing = String(preview?.candidate_id || "") === String(candidate.candidate_id);
            return `
              <article class="persona-hot-card ${checked ? "is-selected" : ""} ${previewing ? "is-preview" : ""}">
                <input
                  type="checkbox"
                  class="persona-hot-card-check"
                  data-persona-hot-candidate-id="${esc(candidate.candidate_id)}"
                  ${checked ? "checked" : ""}
                />
                <button type="button" class="persona-hot-card-main" data-persona-hot-preview="${esc(candidate.candidate_id)}">
                  <span class="persona-hot-card-head">
                    <strong>${esc((candidate.platform || "threads").toUpperCase())}</strong>
                    <small>${esc(formatTime(candidate.captured_at || candidate.published_at || ""))}</small>
                  </span>
                  <span class="persona-hot-card-copy">${esc(candidate.summary)}</span>
                  <span class="persona-hot-card-metrics">${esc(`浏览 ${numberText(candidate.view_count || 0)} · 点赞 ${numberText(candidate.like_count || 0)} · 评论 ${numberText(candidate.comment_count || 0)}`)}</span>
                </button>
              </article>
            `;
          }).join("")}
        </div>
      </section>
      <section class="persona-hot-preview">
        <div class="persona-hot-toolbar">
          <strong>单条预览</strong>
          <small>${esc(`已选 ${selectedIds.size} 条`)}</small>
        </div>
        ${renderPersonaHotCandidatePreview(preview)}
      </section>
    </div>` : `<div class="empty-state">还没有热点候选。点击“抓取热点”，系统会按当前人设和已有记忆自动抓取 Threads / Instagram 热点候选。</div>`}
  `;
}

function personaMediaTaskOptions(profile, generateForm = {}) {
  return [["persona_post_image", "根据推文生图"]];
}

function renderPersonaMediaTaskTabs(profile, generateForm, taskType) {
  const options = personaMediaTaskOptions(profile, generateForm);
  const active = String(taskType || options[0]?.[0] || "persona_post_image");
  return `<div class="persona-step-tabs persona-subflow-tabs">${options.map(([value, label]) => `
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
  const canCancel = activeTaskStatus(status);
  return `
    <div class="compact-list">
      <article class="compact-row compact-row-log">
        <strong>${esc(taskMeta[String(detail.type || taskState.taskType || "persona_post_image")]?.title || "媒体任务")}</strong>
        <p>${esc(statusLabel(status))} · ${esc(taskState.taskId)}</p>
        <span>${esc(formatTime(detail.finished_at || detail.updated_at || detail.created_at || ""))}</span>
      </article>
    </div>
    ${detail.error ? `<div class="persona-warning-inline">${esc(detail.error)}</div>` : ""}
    ${items.length ? renderPersonaMediaPreview(items) : `<div class="empty-state">${terminal ? "任务已结束，但还没有可预览的媒体结果。" : "任务执行中，结果返回后会自动显示在这里。"}</div>`}
    <div class="row-actions">
      <button type="button" class="primary" data-persona-attach-task-media="append" ${items.length ? "" : "disabled"}>追加到当前草稿</button>
      <button type="button" data-persona-attach-task-media="replace" ${items.length ? "" : "disabled"}>替换当前草稿媒体</button>
      ${canCancel ? `<button type="button" class="danger" data-persona-cancel-media-task="${esc(taskState.taskId)}">停止任务</button>` : ""}
    </div>
  `;
}

function renderPersonaCreateWorkbench() {
  const createState = ensurePersonaCreateState();
  const createBusy = state.personaCreateBusy || {};
  const aiKeywords = Array.isArray(createState.aiKeywords) ? createState.aiKeywords : [];
  const aiSelectedKeywords = Array.isArray(createState.aiSelectedKeywords) ? createState.aiSelectedKeywords : [];
  const aiResult = createState.aiResult && typeof createState.aiResult === "object" ? createState.aiResult : null;
  const aiReadyToCreate = Boolean(String(createState.aiName || "").trim() && String(createState.aiPrompt || "").trim());
  const aiInputsLocked = createState.aiStep !== "input" && aiKeywords.length > 0;
  const aiKeywordsBusy = Boolean(createBusy.keywords);
  const aiCreateBusy = Boolean(createBusy.aiCreate);
  const manualBusy = Boolean(createBusy.manual);
  const anyCreateBusy = personaCreateIsBusy();
  const busyLabel = personaCreateBusyKind();
  const selectedKeywordHint = aiSelectedKeywords.length
    ? `已选 ${aiSelectedKeywords.length} / 2`
    : "可选 0 到 2 个关键词";
  const keywordsMarkup = aiKeywords.length
    ? `
      <div class="persona-keyword-grid">
        ${aiKeywords.map((keyword) => {
          const active = aiSelectedKeywords.includes(keyword);
          return `<button type="button" class="${active ? "is-active" : ""}" data-persona-create-ai-keyword="${esc(keyword)}" ${aiCreateBusy ? "disabled" : ""}>${esc(keyword)}</button>`;
        }).join("")}
      </div>
    `
    : `<div class="empty-state">还没有提炼出关键词，请先填写名称和提示词。</div>`;
  const resultMarkup = aiResult
    ? `
      <div class="persona-inline-panel persona-create-result is-flat">
        <div class="persona-workbench-head">
          <div class="persona-head-copy">
            <strong>AI 人设已生成</strong>
            <span>下一步和 Bot 一样，先进入详情继续补资料，或直接转到人设图。</span>
          </div>
          <span class="module-chip">已创建</span>
        </div>
        <div class="persona-create-result-copy">
          <strong>${esc(aiResult.name || createState.aiName || "-")}</strong>
          <p>${esc(aiResult.content || "已生成结构化人设内容，可进入详情继续调整。")}</p>
          ${aiResult.selectedKeywords?.length ? `
            <div class="persona-step-tabs">
              ${aiResult.selectedKeywords.map((keyword) => `<button type="button" class="is-active" disabled>${esc(keyword)}</button>`).join("")}
            </div>
          ` : ""}
        </div>
        <div class="persona-quick-actions">
          <button type="button" class="primary" data-persona-create-ai-open-profile>进入人设详情</button>
          <button type="button" data-persona-create-ai-open-images>生成人设图</button>
          <button type="button" data-persona-create-ai-reset>继续新建</button>
        </div>
      </div>
    `
    : "";
  return `
    <div class="persona-inline-panel persona-create-workbench is-flat">
      <div class="persona-workbench-head">
        <div class="persona-head-copy">
          <strong>新建人设</strong>
          <span>先填名称和提示词，再确认关键词后创建。</span>
        </div>
        <div class="persona-quick-actions">
          <button type="button" data-persona-cancel-create>返回人设详情</button>
        </div>
      </div>
      <div class="persona-step-tabs">
        <button type="button" class="${createState.mode === "ai" ? "is-active" : ""}" data-persona-create-mode="ai" ${anyCreateBusy ? "disabled" : ""}>AI 生成</button>
        <button type="button" class="${createState.mode === "manual" ? "is-active" : ""}" data-persona-create-mode="manual" ${anyCreateBusy ? "disabled" : ""}>手动输入</button>
      </div>
      ${createState.mode === "ai" ? `
        <label>人设名称
          <input id="personaCreateAiName" value="${esc(createState.aiName || "")}" placeholder="例如：咖啡馆主理人" ${aiInputsLocked ? "readonly aria-readonly=\"true\"" : ""} />
        </label>
        <label>人设提示词
          <textarea id="personaCreateAiPrompt" rows="7" placeholder="描述身份、性格、内容方向、语气、受众和图片风格。" ${aiInputsLocked ? "readonly aria-readonly=\"true\"" : ""}>${esc(createState.aiPrompt || "")}</textarea>
        </label>
        ${createState.aiStep === "input" ? `
          <div class="row-actions">
            <button type="button" class="primary" data-persona-create-ai-keywords ${anyCreateBusy ? "disabled" : ""}>${aiKeywordsBusy ? "正在提炼关键词..." : (anyCreateBusy ? `${busyLabel}中` : "下一步：提炼关键词")}</button>
          </div>
        ` : `
          <div class="persona-inline-panel is-flat">
            <div class="persona-create-keyword-section">
              <div class="persona-workbench-head">
                <div class="persona-head-copy">
                  <strong>方向关键词</strong>
                  <span>${selectedKeywordHint}</span>
                </div>
                <span class="module-chip">${esc(createState.aiStep === "created" ? "已完成" : "步骤 3/3")}</span>
              </div>
              ${keywordsMarkup}
            </div>
            <div class="persona-create-actions">
              <button type="button" data-persona-create-ai-back ${aiCreateBusy ? "disabled" : ""}>返回修改提示词</button>
              <button type="button" data-persona-create-ai-clear ${aiSelectedKeywords.length && !aiCreateBusy ? "" : "disabled"}>清空选择</button>
              <button type="button" class="primary" data-persona-create-ai-submit ${anyCreateBusy ? "disabled" : ""}>${aiCreateBusy ? "正在生成人设..." : (anyCreateBusy ? `${busyLabel}中` : "确认并生成人设")}</button>
            </div>
          </div>
          ${resultMarkup}
        `}
      ` : `
        <label>人设名称
          <input id="personaCreateName" value="${esc(createState.manualName || "")}" placeholder="例如：咖啡馆主理人" />
        </label>
        <label>人设简介
          <textarea id="personaCreateContent" rows="8" placeholder="填写人设的背景、内容方向和说话方式。">${esc(createState.manualContent || "")}</textarea>
        </label>
        <div class="row-actions">
          <button type="button" class="primary" data-persona-create ${anyCreateBusy ? "disabled" : ""}>${manualBusy ? "正在创建人设..." : (anyCreateBusy ? `${busyLabel}中` : "直接创建人设")}</button>
        </div>
      `}
    </div>
  `;
}

function personaGroupStepOptions(groupKey, profile) {
  if (groupKey === "content") {
    return [
      ["generate", "新建推文"],
      ["media", "推文配图 / 媒体"],
      ["posts", "草稿库"],
    ];
  }
  if (groupKey === "settings") {
    return [
      ["profile", "基础资料"],
      ["images", "人设图"],
      ["style", "推文风格"],
      ["links", "链接设置"],
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
  removePersonaCardEditorPortal();
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
          <div class="persona-list-actions">
            <button type="button" class="primary" data-persona-open-create>新建人设</button>
            <button type="button" data-persona-create-group>创建分组</button>
          </div>
        </div>
        ${state.personas.length ? `
          ${renderPersonaCollectionList()}
        ` : `<div class="empty-state">当前还没有人设，先点击“新建人设”。</div>`}
      </aside>
    </div>
  `;
  if (state.personaCreateMode || !current) renderPersonaDetail();
  else renderPersonaDetail();
  renderPersonaCardEditorPortal();
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
  if (groupKey === "settings" && step === "profile") {
    if (!personaImageLibraryState(persona.id)) loadPersonaImageLibrary(persona.id).catch(() => {});
    if (!Array.isArray(state.personaPublishHistories[String(persona.id)])) loadPersonaPublishHistory(persona.id).catch(() => {});
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
  const canDelete = Boolean(profile);
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
          ${canDelete ? `<button type="button" class="danger" data-persona-delete>删除当前人设</button>` : ""}
        </div>
      </div>
      ${renderPersonaGroupTabs(profile)}
    </div>
    ${showWarnings ? `<div class="persona-warning-inline">${warnings.map(esc).join(" / ")}</div>` : ""}
    <div class="persona-step-shell">
      ${renderPersonaStepTabs(groupKey, profile)}
      ${groupPanel}
    </div>
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
  const isWorkflowPersona = false;
  const showTimeSlot = false;
  const generateMode = ["custom", "hot"].includes(String(generateForm.mode || "").trim()) ? String(generateForm.mode || "").trim() : "ai";
  const isEditingDraft = Boolean(String(draftForm.editingPostId || "").trim());
  const editingDraft = isEditingDraft ? drafts.find((post) => String(post.id) === String(draftForm.editingPostId || "").trim()) || selectedPost : null;
  const editingHotMeta = editingDraft ? personaHotImportMeta(persona.id, editingDraft.id) : null;
  const preflight = personaGeneratePreflight();
  const hiddenHistoryCount = personaHiddenPublishHistoryCount(persona);
  const hiddenHistoryHint = hiddenHistoryCount > 0 ? ` 当前另有 ${hiddenHistoryCount} 条登录或预检记录，未计入发布历史。` : "";
  const generateDefaults = personaGenerateDefaults();
  const generateTitle = generateMode === "hot" ? "新建推文" : (isEditingDraft ? "编辑草稿" : "新建推文");
  const generateIntro = generateMode === "hot"
    ? "这里直接走 Bot 同源的热点抓取链路，先抓候选，再多选导入当前人设草稿库。"
    : (isEditingDraft
      ? "这里处理当前草稿的正文修改。配图、媒体、删除和 AI 重写都从这里进入，不再放在草稿列表里。"
      : `这里处理推文内容。配图和媒体操作已归到“推文配图 / 媒体”。已识别 ${memoryRows.length} 条可选记忆。`);
  const generateBusy = isActionLocked("persona", persona.id, "generate_posts");
  const hotImportBusy = isActionLocked("persona", persona.id, "hot_import");

  if (panel === "generate") {
    return `
      <div class="persona-inline-panel">
        <div class="persona-head-copy persona-head-copy--split">
          <div class="persona-head-copy-main">
            <strong>${esc(generateTitle)}</strong>
            <span class="persona-panel-intro">${esc(generateIntro)}</span>
          </div>
        </div>
        ${renderPersonaGenerateModeTabs(generateMode)}
        ${generateMode === "ai" ? `<div class="persona-panel-intro">当前按通用设置生成：每次 ${esc(generateDefaults.count)} 条，目标约 ${esc(generateDefaults.targetWords)} 字。</div>` : ""}
        ${generateMode === "custom" ? `
          ${isEditingDraft && editingDraft ? `
            <div class="persona-inline-panel persona-inline-panel--nested persona-draft-editing-banner">
              <strong>${esc(editingDraft.title || "未命名草稿")}</strong>
              <span class="persona-panel-intro">${esc(formatTime(editingDraft.published_at || editingDraft.updated_at || editingDraft.created_at))}</span>
            </div>
          ` : ""}
          ${editingHotMeta ? renderPersonaHotOrigin(editingHotMeta) : ""}
          <label>草稿标题（可选）
            <input id="personaDraftTitle" value="${esc(draftForm.title || "")}" placeholder="例如：今日主题帖" />
          </label>
          <label>自定义正文
            <textarea id="personaDraftContent" rows="6" placeholder="直接输入本次要保存的推文正文。">${esc(draftForm.content || "")}</textarea>
          </label>
          <div class="row-actions">
            <button type="button" class="primary" data-persona-create-post>${isEditingDraft ? "保存修改" : "保存草稿"}</button>
            ${isEditingDraft ? `
              <button type="button" data-persona-ai-rewrite-post="${esc(draftForm.editingPostId)}">AI 重写推文</button>
              <button type="button" data-persona-route-step="content:media">推文配图 / 媒体</button>
              <button type="button" class="danger" data-persona-delete-post="${esc(draftForm.editingPostId)}">删除草稿</button>
              <button type="button" data-persona-route-step="content:posts">返回草稿库</button>
            ` : `
              <button type="button" data-persona-route-step="content:posts">查看草稿</button>
            `}
          </div>
        ` : generateMode === "hot" ? `
          <div class="persona-inline-panel persona-inline-panel--nested">
            <strong>热点抓取</strong>
            <span class="persona-panel-intro">这里直接走 Bot 同源的热点抓取链路，先抓候选，再多选导入当前人设草稿库。</span>
          </div>
          ${renderPersonaHotCandidatePicker(persona, generateForm)}
          <div class="row-actions">
            <button type="button" class="primary" data-persona-import-hot-drafts ${personaHotSelectedCandidates(persona).length && !hotImportBusy ? "" : "disabled"}>${hotImportBusy ? "正在导入热点..." : "导入到当前人设草稿库"}</button>
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
            <button type="button" class="primary" data-persona-generate-posts ${preflight.ready && !generateBusy ? "" : "disabled"}>${generateBusy ? "正在生成草稿..." : "自动生成草稿"}</button>
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
    const mediaTaskOptions = personaMediaTaskOptions(profile, generateForm);
    const currentTaskType = mediaTaskOptions.some(([value]) => value === String(mediaForm.taskType || ""))
      ? String(mediaForm.taskType || "")
      : String(mediaTaskOptions[0]?.[0] || "persona_post_image");
    mediaForm.taskType = currentTaskType;
    const mediaMeta = taskMeta[currentTaskType] || taskMeta.persona_post_image || taskMeta.text_to_image;
    const showAspectRatio = currentTaskType === "persona_post_image";
    const showVideoOptions = false;
    const uploadAccept = "image/*";
    const showSourceUpload = Number(mediaMeta.minImages || 0) > 0;
    const mediaIntro = "这里只提供“根据推文生图”。";
    const mediaBusy = post && (isActionLocked("media_task", persona.id, post.id, currentTaskType) || personaMediaTaskIsActive(persona.id, post.id, currentTaskType));
    return `
      <div class="persona-inline-panel">
        <div class="persona-head-copy">
          <strong>推文配图 / 媒体</strong>
          <span class="persona-panel-intro">${esc(mediaIntro)}</span>
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
                ${renderPersonaHotOrigin(personaHotImportMeta(persona.id, post.id), { compact: true })}
                <p>${esc(String(post.content || "").trim() || "当前草稿没有正文。")}</p>
              </div>
              <div class="persona-inline-panel persona-inline-panel--nested">
                <strong>当前媒体</strong>
                ${renderPersonaEditableMediaGrid(postMediaItems)}
                ${renderUploadDropzone("personaPostMediaUploadFiles", { label: "上传媒体", hint: "拖动图片或视频到这里，或点击选择。可追加或替换当前草稿媒体。" })}
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
                ${renderPersonaMediaTaskTabs(profile, generateForm, currentTaskType)}
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
                ${showSourceUpload ? renderUploadDropzone("personaMediaTaskFiles", {
                  label: "上传素材",
                  accept: uploadAccept,
                  hint: mediaMeta.files || "拖动任务需要的素材到这里，或点击选择。",
                }) : ""}
                <div class="row-actions">
                  <button type="button" class="primary" data-persona-run-media-task ${mediaBusy ? "disabled" : ""}>${mediaBusy ? "配图任务执行中" : "生成预览"}</button>
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
    return `
      <div class="persona-inline-panel">
        <div class="persona-head-copy">
          <strong>草稿库</strong>
          <span class="persona-panel-intro">${esc(`这里集中查看并选择待发布草稿。新建或编辑草稿请回到“新建推文”；发布和矩阵发布已统一移到外层入口。当前草稿 ${drafts.length} 条。`)}</span>
        </div>
        <div class="persona-draft-toolbar">
          <label>草稿快速选择
            <select id="personaDraftPostSelect">
              ${drafts.length ? drafts.map((post, index) => `<option value="${esc(post.id)}" ${String(post.id) === String(state.selectedPersonaPostId || drafts[0]?.id || "") ? "selected" : ""}>${esc(personaDraftOptionLabel(post, index))}</option>`).join("") : `<option value="">当前还没有草稿</option>`}
            </select>
          </label>
          <div class="row-actions">
            <button type="button" data-persona-open-new-draft>新建或编辑草稿</button>
            ${selectedPost ? `<button type="button" data-persona-edit-post="${esc(selectedPost.id)}">编辑草稿</button>` : ""}
            ${selectedPost ? `<button type="button" class="primary" data-persona-open-publishing>进入发布 / 矩阵发布</button>` : ""}
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
    const publishBusy = publishAccount && selectedPost
      ? (isActionLocked("publish", persona.id, selectedPost.id, publishAccount.id) || activeSocialTaskFor({ accountId: publishAccount.id, personaId: persona.id, taskType: "publish_post", postId: selectedPost.id }))
      : false;
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
        ${renderUploadDropzone("personaPublishFiles", { label: "发布素材", hint: publishHint || "拖动图片或视频到这里，或点击选择。" })}
        <div class="row-actions">
          <button type="button" class="primary" data-persona-publish-submit ${(publishAccount && selectedPost && !publishBusy) ? "" : "disabled"}>${publishBusy ? "发布任务执行中" : "发布内容"}</button>
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
        <p>当前主链路只保留：人设信息、草稿创建、素材处理、自动化执行结果；发布和矩阵发布统一在外层入口执行。</p>
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
        ${activeTaskStatus(task.status) ? `<button type="button" class="danger" data-cancel-task="${esc(task.id)}">停止</button>` : ""}
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
  const accounts = mergedAccountCards(state.socialAccounts);
  grid.innerHTML = accounts.length ? accounts.map((account) => {
    const loginBusy = isActionLocked("social", account.id, "open_login", account.persona_id || "standalone")
      || isActionLocked("social", account.id, "open_login")
      || activeSocialTaskFor({ accountId: account.id, taskType: "open_login" });
    const checkBusy = isActionLocked("social", account.id, "check_login", account.persona_id || "standalone")
      || isActionLocked("social", account.id, "check_login")
      || activeSocialTaskFor({ accountId: account.id, taskType: "check_login" });
    return `
      <article class="account-card">
        <div><strong>${esc(account.username || account.id)}</strong><span> · ${esc(account.platform || "-")}</span></div>
        <p>${esc(account.profile_dir || "未配置浏览器环境")}</p>
        ${Number(account.binding_count || 0) > 1 ? `<p>已合并 ${Number(account.binding_count || 0)} 个人设绑定，当前操作使用状态最好的账号记录。</p>` : ""}
        <div class="row-actions">
          <button type="button" data-social-open-login="${esc(account.id)}" ${loginBusy ? "disabled" : ""}>${loginBusy ? "登录任务执行中" : "打开登录"}</button>
          <button type="button" data-social-check-login="${esc(account.id)}" ${checkBusy ? "disabled" : ""}>${checkBusy ? "检查执行中" : "检查登录"}</button>
        </div>
        <span class="status ${esc(account.status)}">${esc(statusLabel(account.status))}</span>
      </article>
    `;
  }).join("") : `<div class="empty-state">暂无执行账号，请先在人设看板或接口中添加账号。</div>`;
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
  const cleanPersonaId = String(personaId || selected?.persona_id || "").trim();
  const lockParts = ["social", accountId, taskType, cleanPersonaId || "standalone"];
  if (isActionLocked(...lockParts) || activeSocialTaskFor({ accountId, taskType })) {
    showMsg(messageId, `该账号已有「${statusLabel(taskType)}」任务在队列或执行中，请等待完成。`, false);
    return;
  }
  const content = $("socialContent")?.value.trim() || $("simpleContent")?.value.trim() || "";
  const targetUrl = $("socialTargetUrl")?.value.trim() || $("simpleTargetUrl")?.value.trim() || "";
  let mediaPaths = [];
  setActionLocked(lockParts, true);
  if (state.activeModule && ["publishing", "automation"].includes(state.activeModule)) renderSimpleFlowModule(state.activeModule);
  renderSocialAccounts();
  if (taskType === "publish_post") {
    try {
      mediaPaths = await uploadAutomationMedia([
        ...filesFromInput("simpleMediaFiles"),
        ...filesFromInput("socialMediaFiles"),
      ], messageId);
      if (platform === "instagram" && mediaPaths.length === 0) {
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
          persona_id: cleanPersonaId,
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
    } finally {
      setActionLocked(lockParts, false);
      if (state.activeModule && ["publishing", "automation"].includes(state.activeModule)) renderSimpleFlowModule(state.activeModule);
      renderSocialAccounts();
    }
  }
  try {
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
        persona_id: cleanPersonaId,
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
  } finally {
    setActionLocked(lockParts, false);
    if (state.activeModule && ["publishing", "automation"].includes(state.activeModule)) renderSimpleFlowModule(state.activeModule);
    renderSocialAccounts();
  }
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
  document.addEventListener("click", (event) => {
    if (
      state.activeModule === "personas"
      && state.personaListEditorId
      && !event.target.closest(".persona-card-menu")
      && !event.target.closest(".persona-card-submenu")
      && !event.target.closest("[data-persona-edit]")
      && !event.target.closest("[data-persona-edit-group]")
      && !event.target.closest(".persona-list-card")
    ) {
      state.personaListEditorId = "";
      state.personaListEditorMode = "";
      renderPersonaModule();
    }
  });
  document.addEventListener("change", (event) => {
    const input = event.target?.closest?.(".upload-zone-input");
    if (input) syncUploadDropzone(input);
  });
  document.addEventListener("dragenter", (event) => {
    const zone = uploadDropzoneFromEvent(event);
    if (!zone) return;
    event.preventDefault();
    zone.classList.add("dragging");
  });
  document.addEventListener("dragover", (event) => {
    const zone = uploadDropzoneFromEvent(event);
    if (!zone) return;
    event.preventDefault();
    zone.classList.add("dragging");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", (event) => {
    const zone = uploadDropzoneFromEvent(event);
    if (!zone || zone.contains(event.relatedTarget)) return;
    zone.classList.remove("dragging");
  });
  document.addEventListener("drop", (event) => {
    const zone = uploadDropzoneFromEvent(event);
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove("dragging");
    setUploadDropzoneFiles(zone, event.dataTransfer?.files);
  });
  $("moduleBody").addEventListener("dragstart", (event) => {
    if (event.target.closest?.("[data-persona-drag-persona]")) event.preventDefault();
  });
  $("moduleBody").addEventListener("pointerdown", handlePersonaPointerDown);
  document.addEventListener("pointermove", handlePersonaPointerMove, { passive: false });
  document.addEventListener("pointerup", handlePersonaPointerUp, { passive: false });
  document.addEventListener("pointercancel", handlePersonaPointerCancel);
  document.addEventListener("click", handlePersonaCardEditorPortalClick);
  $("moduleBody").addEventListener("scroll", schedulePersonaCardEditorMenuPosition, true);
  window.addEventListener("resize", schedulePersonaCardEditorMenuPosition);
  $("moduleBody").addEventListener("click", (event) => {
    if (Date.now() < Number(state.personaSuppressClickUntil || 0)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
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
      openPersonaCollectionCreateModal().catch((error) => {
        showMsg("commandMsg", error.detail || error.message || "创建分组失败", false);
      });
      return;
    }
    if (event.target.closest("[data-persona-create]")) {
      createPersonaArchive().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
      return;
    }
    const createModeButton = event.target.closest("[data-persona-create-mode]");
    if (createModeButton) {
      const busyKind = personaCreateBusyKind();
      if (busyKind) {
        showMsg("commandMsg", `${busyKind}正在执行，请等待当前任务完成。`, false);
        return;
      }
      const createState = snapshotPersonaCreateInputs();
      createState.mode = createModeButton.dataset.personaCreateMode === "manual" ? "manual" : "ai";
      renderPersonaDetail();
      return;
    }
    if (event.target.closest("[data-persona-create-ai-keywords]")) {
      suggestPersonaCreateKeywords().catch((error) => showMsg("commandMsg", error.detail || error.message || "提炼关键词失败", false));
      return;
    }
    const createKeywordButton = event.target.closest("[data-persona-create-ai-keyword]");
    if (createKeywordButton) {
      const createState = snapshotPersonaCreateInputs();
      const keyword = String(createKeywordButton.dataset.personaCreateAiKeyword || "").trim();
      if (!keyword) return;
      const selected = new Set(Array.isArray(createState.aiSelectedKeywords) ? createState.aiSelectedKeywords : []);
      if (selected.has(keyword)) {
        selected.delete(keyword);
      } else {
        if (selected.size >= 2) {
          showMsg("commandMsg", "最多选择 2 个关键词。", false);
          return;
        }
        selected.add(keyword);
      }
      createState.aiSelectedKeywords = Array.from(selected);
      renderPersonaDetail();
      return;
    }
    if (event.target.closest("[data-persona-create-ai-clear]")) {
      const createState = ensurePersonaCreateState();
      createState.aiSelectedKeywords = [];
      renderPersonaDetail();
      return;
    }
    if (event.target.closest("[data-persona-create-ai-back]")) {
      const createState = snapshotPersonaCreateInputs();
      createState.aiStep = "input";
      createState.aiKeywords = [];
      createState.aiSelectedKeywords = [];
      createState.aiResult = null;
      renderPersonaDetail();
      return;
    }
    if (event.target.closest("[data-persona-create-ai-submit]")) {
      createPersonaArchiveWithAi().catch((error) => showMsg("commandMsg", error.detail || error.message || "AI 新建人设失败", false));
      return;
    }
    if (event.target.closest("[data-persona-create-ai-open-profile]")) {
      const createState = ensurePersonaCreateState();
      const personaId = String(createState.aiResult?.id || state.selectedPersonaId || "");
      if (!personaId) {
        showMsg("commandMsg", "还没有可进入的人设详情。", false);
        return;
      }
      activateCreatedPersona(personaId, { group: "settings", step: "profile" }).catch((error) => showMsg("commandMsg", error.detail || error.message || "打开人设详情失败", false));
      return;
    }
    if (event.target.closest("[data-persona-create-ai-open-images]")) {
      const createState = ensurePersonaCreateState();
      const personaId = String(createState.aiResult?.id || state.selectedPersonaId || "");
      if (!personaId) {
        showMsg("commandMsg", "还没有可生成图片的人设。", false);
        return;
      }
      activateCreatedPersona(personaId, { group: "settings", step: "images" }).catch((error) => showMsg("commandMsg", error.detail || error.message || "切换到人设图失败", false));
      return;
    }
    if (event.target.closest("[data-persona-create-ai-reset]")) {
      state.personaCreate = defaultPersonaCreateState();
      renderPersonaDetail();
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
    if (event.target.closest("[data-persona-fetch-hot]")) {
      fetchPersonaHotCandidates(false).catch((error) => showMsg("commandMsg", error.detail || error.message || "抓取热点失败", false));
      return;
    }
    if (event.target.closest("[data-persona-fetch-hot-refresh]")) {
      fetchPersonaHotCandidates(true).catch((error) => showMsg("commandMsg", error.detail || error.message || "刷新热点失败", false));
      return;
    }
    if (event.target.closest("[data-persona-import-hot-drafts]")) {
      importPersonaHotDrafts().catch((error) => showMsg("commandMsg", error.detail || error.message || "导入热点草稿失败", false));
      return;
    }
    const hotMediaToggle = event.target.closest("[data-persona-hot-media-toggle]");
    if (hotMediaToggle) {
      const persona = selectedPersona();
      if (!persona) return;
      snapshotPersonaHotPreviewContent();
      const candidateId = String(hotMediaToggle.dataset.personaHotMediaToggle || "").trim();
      const index = Number(hotMediaToggle.dataset.personaHotMediaIndex);
      if (!candidateId || !Number.isInteger(index) || index < 0) return;
      const deleted = personaHotDeletedMediaSet(persona.id, candidateId);
      if (deleted.has(index)) deleted.delete(index);
      else deleted.add(index);
      setPersonaHotDeletedMediaSet(persona.id, candidateId, deleted);
      renderPersonaDetail();
      return;
    }
    const hotMediaBulk = event.target.closest("[data-persona-hot-media-bulk]");
    if (hotMediaBulk) {
      const persona = selectedPersona();
      if (!persona) return;
      snapshotPersonaHotPreviewContent();
      const candidateId = String(hotMediaBulk.dataset.personaHotMediaCandidate || "").trim();
      const candidate = personaHotCandidates(persona).find((item) => personaHotCandidateKey(item) === candidateId);
      if (!candidate) return;
      const mediaCount = personaHotCandidateMediaItems(candidate).length;
      setPersonaHotDeletedMediaSet(
        persona.id,
        candidateId,
        hotMediaBulk.dataset.personaHotMediaBulk === "all" ? new Set(Array.from({ length: mediaCount }, (_, index) => index)) : new Set(),
      );
      renderPersonaDetail();
      return;
    }
    const importOneHotButton = event.target.closest("[data-persona-import-hot-one]");
    if (importOneHotButton) {
      const candidateId = String(importOneHotButton.dataset.personaImportHotOne || "").trim();
      importPersonaHotDrafts(candidateId ? [candidateId] : []).catch((error) => showMsg("commandMsg", error.detail || error.message || "导入热点草稿失败", false));
      return;
    }
    const importEditedHotButton = event.target.closest("[data-persona-import-hot-edit]");
    if (importEditedHotButton) {
      const candidateId = String(importEditedHotButton.dataset.personaImportHotEdit || "").trim();
      importEditedPersonaHotDraft(candidateId).catch((error) => showMsg("commandMsg", error.detail || error.message || "导入热点草稿失败", false));
      return;
    }
    const hotBulkButton = event.target.closest("[data-persona-hot-bulk]");
    if (hotBulkButton) {
      const persona = selectedPersona();
      if (!persona) return;
      const form = personaFormState(persona.id).generate;
      form.hotSelectedIds = hotBulkButton.dataset.personaHotBulk === "all"
        ? personaHotCandidates(persona).map((item) => item.candidate_id)
        : [];
      if (!form.hotPreviewId) form.hotPreviewId = form.hotSelectedIds[0] || "";
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    const hotPreviewButton = event.target.closest("[data-persona-hot-preview]");
    if (hotPreviewButton) {
      const persona = selectedPersona();
      if (!persona) return;
      snapshotPersonaHotPreviewContent();
      personaFormState(persona.id).generate.hotPreviewId = String(hotPreviewButton.dataset.personaHotPreview || "").trim();
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    if (event.target.closest("[data-persona-open-new-draft]")) {
      const persona = selectedPersona();
      if (!persona) return;
      resetPersonaDraftEditor(persona.id);
      state.personaGroup = "content";
      state.personaPanels.content = "generate";
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    const editPostButton = event.target.closest("[data-persona-edit-post]");
    if (editPostButton) {
      openPersonaDraftEditor(editPostButton.dataset.personaEditPost || "");
      return;
    }
    const rewritePostButton = event.target.closest("[data-persona-ai-rewrite-post]");
    if (rewritePostButton) {
      preparePersonaDraftRewrite(rewritePostButton.dataset.personaAiRewritePost || "");
      return;
    }
    const deletePostButton = event.target.closest("[data-persona-delete-post]");
    if (deletePostButton) {
      deletePersonaDraftPost(deletePostButton.dataset.personaDeletePost || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "删除草稿失败", false));
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
      const closing = state.personaListEditorId === personaId;
      state.personaListEditorId = closing ? "" : personaId;
      state.personaListEditorMode = "";
      renderPersonaModule();
      return;
    }
    const editCollectionGroup = event.target.closest("[data-persona-edit-group]");
    if (editCollectionGroup) {
      const groupId = editCollectionGroup.dataset.personaEditGroup || "";
      const editorId = groupId ? `group:${groupId}` : "";
      state.personaListEditorId = state.personaListEditorId === editorId ? "" : editorId;
      state.personaListEditorMode = "";
      renderPersonaModule();
      return;
    }
    const personaEditorBack = event.target.closest("[data-persona-editor-back]");
    if (personaEditorBack) {
      const personaId = personaEditorBack.dataset.personaEditorBack || "";
      if (state.personaListEditorId === personaId) {
        state.personaListEditorMode = "";
        renderPersonaModule();
      }
      return;
    }
    const personaEditorMode = event.target.closest("[data-persona-editor-mode]");
    if (personaEditorMode) {
      const [personaId, mode] = String(personaEditorMode.dataset.personaEditorMode || "").split(":");
      if (personaId) {
        state.personaListEditorId = personaId;
        state.personaListEditorMode = mode || "";
        renderPersonaModule();
      }
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
    const listPageButton = event.target.closest("[data-persona-list-page]");
    if (listPageButton) {
      const totalPages = personaListTotalPages();
      const action = listPageButton.dataset.personaListPage || "";
      if (action === "first") state.personaListPage = 1;
      if (action === "prev") state.personaListPage = Math.max(1, Number(state.personaListPage || 1) - 1);
      if (action === "next") state.personaListPage = Math.min(totalPages, Number(state.personaListPage || 1) + 1);
      if (action === "last") state.personaListPage = totalPages;
      state.personaListEditorId = "";
      state.personaListEditorMode = "";
      renderPersonaModule();
      return;
    }
    if (event.target.closest("[data-persona-open-publishing]")) {
      const persona = selectedPersona();
      if (persona) {
        state.selectedPersonaId = persona.id;
        state.simpleBranches.publishing = "publish_now";
      }
      setWorkspaceModule("publishing");
      return;
    }
    const routeStepButton = event.target.closest("[data-persona-route-step]");
    if (routeStepButton) {
      const [groupKey, step] = String(routeStepButton.dataset.personaRouteStep || "").split(":");
      if (groupKey && step) {
        clearMsg("commandMsg");
        state.personaGroup = groupKey;
        state.personaPanels[groupKey] = step;
        renderPersonaDetail();
        renderConfirmSummary();
      }
    }
    const draftCard = event.target.closest("[data-persona-select-post]");
    if (draftCard && !event.target.closest("button, a, input, select, textarea")) {
      clearMsg("commandMsg");
      state.selectedPersonaPostId = draftCard.dataset.personaSelectPost || "";
      renderPersonaDetail();
      renderConfirmSummary();
    }
    const personaSelectButton = event.target.closest("[data-persona-select]") || (
      event.target.closest(".persona-card-edit, .persona-card-menu, .persona-card-submenu, button, a, input, select, textarea")
        ? null
        : event.target.closest("[data-persona-card]")
    );
    if (personaSelectButton) {
      clearMsg("commandMsg");
      state.selectedPersonaId = personaSelectButton.dataset.personaSelect || personaSelectButton.dataset.personaCard || "";
      state.selectedPersonaPostId = "";
      state.personaCreateMode = false;
      state.personaGroup = "content";
      state.personaPanels.content = "generate";
      if (state.selectedPersonaId) resetPersonaDraftEditor(state.selectedPersonaId);
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
      clearMsg("commandMsg");
      state.personaCreate = defaultPersonaCreateState();
      state.personaCreateMode = true;
      renderPersonaDetail();
    }
    if (event.target.closest("[data-persona-cancel-create]")) {
      clearMsg("commandMsg");
      state.personaCreate = defaultPersonaCreateState();
      state.personaCreateMode = false;
      renderPersonaDetail();
    }
    const personaGroupButton = event.target.closest("[data-persona-group]");
    if (personaGroupButton) {
      clearMsg("commandMsg");
      const groupKey = personaGroupButton.dataset.personaGroup || "content";
      state.personaGroup = groupKey;
      setPersonaGroupStep(groupKey, state.personaPanels[groupKey] || personaGroups[groupKey]?.defaultStep || "", selectedPersonaProfile());
      renderPersonaDetail();
      renderConfirmSummary();
    }
    const personaStepButton = event.target.closest("[data-persona-step]");
    if (personaStepButton) {
      const [groupKey, step] = String(personaStepButton.dataset.personaStep || "").split(":");
      if (groupKey && step) {
        clearMsg("commandMsg");
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
        clearMsg("commandMsg");
        personaFormState(persona.id).generate.mode = generateModeButton.dataset.personaGenerateMode || "ai";
        renderPersonaDetail();
        renderConfirmSummary();
      }
    }
    const profileModeButton = event.target.closest("[data-persona-profile-mode]");
    if (profileModeButton) {
      const persona = selectedPersona();
      if (persona) {
        state.personaProfileModes[String(persona.id)] = profileModeButton.dataset.personaProfileMode === "edit" ? "edit" : "overview";
        renderPersonaDetail();
        renderConfirmSummary();
      }
    }
    const mediaTaskButton = event.target.closest("[data-persona-media-task]");
    if (mediaTaskButton) {
      const persona = selectedPersona();
      if (persona) {
        personaFormState(persona.id).media.taskType = mediaTaskButton.dataset.personaMediaTask || "persona_post_image";
        renderPersonaDetail();
        renderConfirmSummary();
      }
    }
    const cancelMediaTask = event.target.closest("[data-persona-cancel-media-task]");
    if (cancelMediaTask) {
      cancelRegularTask(cancelMediaTask.dataset.personaCancelMediaTask || "", "commandMsg").then(() => {
        const persona = selectedPersona();
        const post = selectedPersonaPost(persona);
        const taskId = String(cancelMediaTask.dataset.personaCancelMediaTask || "").trim();
        if (persona && post && taskId) {
          const key = personaMediaTaskKey(persona.id, post.id);
          const current = state.personaMediaTasks[key];
          if (String(current?.taskId || "") === taskId) {
            state.personaMediaTasks[key] = {
              ...current,
              status: "cancelled",
              detail: { ...(current.detail || {}), id: taskId, status: "cancelled" },
            };
          }
        }
        renderPersonaDetail();
        renderConfirmSummary();
      }).catch((error) => showMsg("commandMsg", error.detail || error.message || "停止任务失败", false));
      return;
    }
    const cancelSocialTask = event.target.closest("[data-persona-cancel-social-task]");
    if (cancelSocialTask) {
      cancelSocialAutomationTask(cancelSocialTask.dataset.personaCancelSocialTask || "", "commandMsg").then(() => {
        state.personaPublishResults = {};
        state.personaAutomationResults = {};
        renderPersonaDetail();
        renderConfirmSummary();
      }).catch((error) => showMsg("commandMsg", error.detail || error.message || "停止任务失败", false));
      return;
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
    if (
      state.personaListEditorId
      && !event.target.closest(".persona-card-menu")
      && !event.target.closest(".persona-card-submenu")
      && !event.target.closest("[data-persona-edit]")
      && !event.target.closest("[data-persona-edit-group]")
      && !event.target.closest(".persona-list-card")
    ) {
      state.personaListEditorId = "";
      state.personaListEditorMode = "";
      renderPersonaModule();
    }
  });
  $("moduleBody").addEventListener("change", (event) => {
    if (event.target?.matches?.("[data-persona-memory-id]")) {
      snapshotPersonaCurrentForm();
      syncPersonaMemorySelectionState();
      renderConfirmSummary();
    }
    if (event.target?.matches?.("[data-persona-hot-candidate-id]")) {
      const persona = selectedPersona();
      if (!persona) return;
      const form = personaFormState(persona.id).generate;
      const candidateId = String(event.target.getAttribute("data-persona-hot-candidate-id") || "").trim();
      const selected = new Set((form.hotSelectedIds || []).map((item) => String(item || "").trim()).filter(Boolean));
      if (event.target.checked) selected.add(candidateId);
      else selected.delete(candidateId);
      form.hotSelectedIds = Array.from(selected);
      if (!form.hotPreviewId) form.hotPreviewId = candidateId;
      renderPersonaDetail();
      renderConfirmSummary();
      return;
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
    const id = button.dataset.watch || button.dataset.detail || button.dataset.retry || button.dataset.cancelTask;
    if (button.dataset.watch) watchTask(id);
    if (button.dataset.detail) showTaskDetail(id).catch((error) => appendEvent("error", error.detail || error.message));
    if (button.dataset.retry) api(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" }).then(loadTasks);
    if (button.dataset.cancelTask) cancelRegularTask(id, "commandMsg").catch((error) => showMsg("commandMsg", error.detail || error.message || "停止任务失败", false));
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
    if (cancel) cancelSocialAutomationTask(cancel.dataset.socialCancel, "socialMsg").catch((error) => showMsg("socialMsg", error.detail || error.message || "停止任务失败", false));
  });
  $("openAdmin").addEventListener("click", () => { location.href = "/admin.html"; });
  $("consoleSettingsBody").addEventListener("click", (event) => {
    if (event.target.closest("#saveConsoleSettings")) saveConsoleSettingsPage();
  });
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
  await loadMe();
  await Promise.all([loadPersonas(), loadTasks(), loadSocial().catch(() => {}), loadSetupStatus()]);
  renderWorkspace();
}

init().catch((error) => {
  appendEvent("error", error.detail || error.message || "控制台初始化失败");
});
