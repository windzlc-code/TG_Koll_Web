const $ = (id) => document.getElementById(id);
const THEME_STORAGE_KEY = "wk-console-theme";
const LANGUAGE_STORAGE_KEY = "wk-console-language";
const PERSONA_LIST_PAGE_SIZE_KEY = "wk-persona-list-page-size";
const PERSONA_POST_PAGE_SIZE_KEY = "wk-persona-post-page-size";
const PERSONA_GENERATE_COUNT_KEY = "wk-persona-generate-count";
const PERSONA_GENERATE_TARGET_WORDS_KEY = "wk-persona-generate-target-words";
const PERSONA_MEDIA_IMAGE_COUNT_KEY = "wk-persona-media-image-count";
const PERSONA_HOT_IMPORTS_STORAGE_KEY = "wk-persona-hot-imports";
const PERSONA_CONSOLE_OVERVIEW_CACHE_KEY = "wk-persona-console-overview-cache";
const SOCIAL_ACCOUNTS_CACHE_KEY = "wk-social-accounts-cache";
const PERSONA_POSTS_CACHE_PREFIX = "wk-persona-posts-cache";
const TASK_QUEUE_PERSONA_PAGE_SIZE_KEY = "wk-task-queue-persona-page-size";
const TASK_QUEUE_REGULAR_PAGE_SIZE_KEY = "wk-task-queue-regular-page-size";
const LIVE_BROWSER_LAYOUT_KEY = "wk-live-browser-layout";
const MOBILE_NAV_QUERY = "(max-width: 980px)";
const ADMIN_WORKSPACE_USER_ID = String(document.querySelector('meta[name="admin-workspace-user-id"]')?.content || "").trim();
const ADMIN_CONSOLE_SESSION = document.querySelector('meta[name="admin-console-session"]')?.content === "1";

function adminWorkspaceRequestOptions(options = {}) {
  if (!ADMIN_WORKSPACE_USER_ID && !ADMIN_CONSOLE_SESSION) return options;
  const headers = new Headers(options.headers || {});
  if (ADMIN_WORKSPACE_USER_ID) headers.set("X-Admin-Workspace-User-ID", ADMIN_WORKSPACE_USER_ID);
  if (ADMIN_CONSOLE_SESSION) headers.set("X-Admin-Console", "1");
  return { ...options, headers };
}

function adminWorkspaceUrl(value) {
  const text = String(value || "").trim();
  if ((!ADMIN_WORKSPACE_USER_ID && !ADMIN_CONSOLE_SESSION) || !text || !text.startsWith("/api/")) return text;
  const url = new URL(text, location.origin);
  if (ADMIN_WORKSPACE_USER_ID) url.searchParams.set("admin_workspace_user_id", ADMIN_WORKSPACE_USER_ID);
  if (ADMIN_CONSOLE_SESSION) url.searchParams.set("admin_console", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}

function adminWorkspaceLiveBrowserUrl(value) {
  const decorated = adminWorkspaceUrl(value);
  if ((!ADMIN_WORKSPACE_USER_ID && !ADMIN_CONSOLE_SESSION) || !decorated || !decorated.startsWith("/api/")) return decorated;
  const url = new URL(decorated, location.origin);
  const nestedPath = String(url.searchParams.get("path") || "").trim();
  if (!nestedPath) return `${url.pathname}${url.search}${url.hash}`;
  const hadLeadingSlash = nestedPath.startsWith("/");
  const nestedUrl = new URL(nestedPath, location.origin);
  if (nestedUrl.pathname.startsWith("/api/")) {
    if (ADMIN_WORKSPACE_USER_ID) nestedUrl.searchParams.set("admin_workspace_user_id", ADMIN_WORKSPACE_USER_ID);
    if (ADMIN_CONSOLE_SESSION) nestedUrl.searchParams.set("admin_console", "1");
    const renderedPath = `${nestedUrl.pathname}${nestedUrl.search}${nestedUrl.hash}`;
    url.searchParams.set("path", hadLeadingSlash ? renderedPath : renderedPath.replace(/^\//, ""));
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function renderAdminWorkspaceBanner() {
  const workspace = window.__CONSOLE_BOOTSTRAP__?.admin_workspace;
  const banner = $("adminWorkspaceBanner");
  if (!banner || !ADMIN_WORKSPACE_USER_ID || !workspace) return;
  const username = $("adminWorkspaceUsername");
  if (username) username.textContent = workspace.target_username || `ID ${workspace.target_user_id || ADMIN_WORKSPACE_USER_ID}`;
  const status = $("adminWorkspaceStatus");
  if (status) {
    status.hidden = !workspace.archived;
    status.textContent = workspace.archived ? "已归档" : "";
  }
  banner.hidden = false;
  banner.classList.toggle("is-archived", Boolean(workspace.archived));
}

function purgeLegacyTenantContentCaches() {
  try {
    window.localStorage.removeItem(PERSONA_HOT_IMPORTS_STORAGE_KEY);
    window.localStorage.removeItem(PERSONA_CONSOLE_OVERVIEW_CACHE_KEY);
    window.localStorage.removeItem(SOCIAL_ACCOUNTS_CACHE_KEY);
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = String(window.localStorage.key(index) || "");
      if (key === PERSONA_POSTS_CACHE_PREFIX || key.startsWith(`${PERSONA_POSTS_CACHE_PREFIX}:`)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {}
}

purgeLegacyTenantContentCaches();

try {
  if (window.localStorage.getItem(THEME_STORAGE_KEY) === "dark") {
    document.documentElement.dataset.theme = "dark";
  }
} catch {}

try {
  const storedLanguage = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  document.documentElement.dataset.language = storedLanguage === "zh-Hant" ? "zh-Hant" : "zh-Hans";
} catch {
  document.documentElement.dataset.language = "zh-Hans";
}

function storedPersonaListPageSize() {
  try {
    const value = Number(window.localStorage.getItem(PERSONA_LIST_PAGE_SIZE_KEY) || 20);
    return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : 20, 5), 80);
  } catch {
    return 20;
  }
}

function storedPersonaPostPageSize() {
  try {
    const value = Number(window.localStorage.getItem(PERSONA_POST_PAGE_SIZE_KEY) || 10);
    return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : 10, 5), 80);
  } catch {
    return 10;
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

function storedPersonaMediaImageCount() {
  try {
    const value = Number(window.localStorage.getItem(PERSONA_MEDIA_IMAGE_COUNT_KEY) || 1);
    return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : 1, 1), 8);
  } catch {
    return 1;
  }
}

function storedTaskQueuePersonaPageSize() {
  try {
    const value = Number(window.localStorage.getItem(TASK_QUEUE_PERSONA_PAGE_SIZE_KEY) || 12);
    return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : 12, 1), 100);
  } catch {
    return 12;
  }
}

function storedTaskQueueRegularPageSize() {
  try {
    const value = Number(window.localStorage.getItem(TASK_QUEUE_REGULAR_PAGE_SIZE_KEY) || 20);
    return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : 20, 1), 100);
  } catch {
    return 20;
  }
}

function normalizeLiveBrowserLayout(value = "grid") {
  return String(value || "").trim().toLowerCase() === "list" ? "list" : "grid";
}

function storedLiveBrowserLayout() {
  try {
    return normalizeLiveBrowserLayout(window.localStorage.getItem(LIVE_BROWSER_LAYOUT_KEY) || "grid");
  } catch {
    return "grid";
  }
}

function storedPersonaHotImports() {
  return {};
}

function storedPersonaConsoleOverview() {
  return null;
}

function savePersonaConsoleOverview(data) {
  return data;
}

function storedSocialAccountsSnapshot() {
  return null;
}

function saveSocialAccountsSnapshot({ accounts = state.socialAccounts, browserSessions = state.socialBrowserSessions } = {}) {
  return { accounts, browserSessions };
}

function hydrateSocialAccountsFromCache() {
  const cached = storedSocialAccountsSnapshot();
  if (!cached) return false;
  state.socialAccounts = cached.accounts || [];
  state.socialBrowserSessions = Array.isArray(cached.browser_sessions) ? cached.browser_sessions : [];
  return true;
}

function personaPostCacheKey(personaId, source = "posts") {
  const cleanId = String(personaId || "").trim();
  const cleanSource = String(source || "posts").trim() === "favorites" ? "favorites" : "posts";
  return `${PERSONA_POSTS_CACHE_PREFIX}:${cleanId}:${cleanSource}`;
}

function storedPersonaPostRows(personaId, source = "posts") {
  return null;
}

function savePersonaPostRows(personaId, source = "posts", rows = []) {
  return { personaId, source, rows };
}

function hydratePersonaPostRowsFromCache(personaId, source = "posts") {
  const cleanId = String(personaId || "").trim();
  if (!cleanId) return false;
  const cleanSource = String(source || "posts").trim() === "favorites" ? "favorites" : "posts";
  const rows = storedPersonaPostRows(cleanId, cleanSource);
  if (!Array.isArray(rows)) return false;
  if (cleanSource === "favorites") {
    state.personaFavoritePosts[cleanId] = sortPersonaDraftPosts(rows);
    syncPersonaSelectedPostIds({ id: cleanId }, "favorites", state.personaFavoritePosts[cleanId]);
  } else {
    state.personaDraftPosts[cleanId] = sortPersonaDraftPosts(visiblePersonaDraftPosts(rows));
    syncPersonaSelectedPostIds({ id: cleanId }, "posts", state.personaDraftPosts[cleanId]);
    syncPersonaHotImportPosts(cleanId, state.personaDraftPosts[cleanId]);
  }
  return true;
}

function applyPersonaOverviewPostRows(persona) {
  const personaId = String(persona?.id || "").trim();
  if (!personaId) return;
  if (Array.isArray(persona.draft_posts)) {
    const posts = sortPersonaDraftPosts(visiblePersonaDraftPosts(persona.draft_posts));
    state.personaDraftPosts[personaId] = posts;
    syncPersonaSelectedPostIds({ id: personaId }, "posts", posts);
    syncPersonaHotImportPosts(personaId, posts);
    savePersonaPostRows(personaId, "posts", posts);
  }
  if (Array.isArray(persona.favorite_posts)) {
    const favorites = sortPersonaDraftPosts(persona.favorite_posts);
    state.personaFavoritePosts[personaId] = favorites;
    syncPersonaSelectedPostIds({ id: personaId }, "favorites", favorites);
    savePersonaPostRows(personaId, "favorites", favorites);
  }
}

const initialConsoleParams = new URLSearchParams(window.location.search);
const initialConsoleView = initialConsoleParams.get("view");
const initialAccountBrowserPanel = initialConsoleParams.get("browser_panel");
const state = {
  view: ["workspace", "tasks", "accounts", "settings", "billing", "console_settings", "persona_dashboard"].includes(initialConsoleView) ? initialConsoleView : "workspace",
  activeModule: "personas",
  transientWorkspaceLeaveAcknowledgement: "",
  transientWorkspaceAllowNextUnload: false,
  accountBrowserPanel: initialAccountBrowserPanel === "browsers" ? "browsers" : "accounts",
  liveBrowserExpandedSessionId: "",
  workspaceMenuOpen: true,
  currentUser: null,
  setupStatus: null,
  billing: {
    summary: null,
    orders: [],
    ledger: [],
    loaded: false,
    loading: false,
    cancellingOrderId: "",
    errors: {},
  },
  personaGroup: "settings",
  personaPanels: {
    content: "generate",
    settings: "profile",
  },
  personaAutomationPlatform: "threads",
  personaStrategySelection: {
    threads_comment_reply: "comment_recent_2d",
    threads_hot_reply: "hot_posts",
    threads_warmup: "tg_default",
  },
  preferredAccountId: "",
  simpleBranches: {},
  simpleFlowPending: false,
  simpleFlowPendingModule: "",
  simpleFlowPendingStartedAt: 0,
  publishFiles: [],
  socialFiles: [],
  tasks: [],
  personas: [],
  workspaceBootstrapPending: false,
  workspaceBootstrapNoticeVisible: false,
  workspaceBootstrapTimer: 0,
  personaProfiles: {},
  personaCollections: { groups: [], assigned_persona_ids: [] },
  personaCollectionTogglePending: new Set(),
  personaListEditorId: "",
  personaListEditorMode: "",
  personaListPage: 1,
  personaListPageSize: storedPersonaListPageSize(),
  personaBulkMode: false,
  personaBulkScope: "personas",
  personaBulkSelectedIds: new Set(),
  personaBulkSelectedGroupIds: new Set(),
  personaBulkDeleting: false,
  personaPostPageSize: storedPersonaPostPageSize(),
  personaGenerateCountDefault: storedPersonaGenerateCount(),
  personaGenerateTargetWordsDefault: storedPersonaGenerateTargetWords(),
  personaMediaImageCountDefault: storedPersonaMediaImageCount(),
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
  personaFetches: {
    profiles: {},
    draftPosts: {},
    favoritePosts: {},
    memories: {},
    publishHistories: {},
  },
  personaImageLibraries: {},
  personaDraftPosts: {},
  personaFavoritePosts: {},
  personaSelectedPostIds: {},
  personaPostSources: {},
  personaPostPages: {},
  personaPublishHistories: {},
  personaPublishAccountIds: {},
  personaPublishResults: {},
  personaPublishWatchers: {},
  personaAutomationResults: {},
  personaAutomationWatchers: {},
  accountPoolPlatform: "threads",
  accountPoolAccountId: "",
  accountPoolSelectedAccountIds: [],
  accountPoolPersonaId: "",
  accountPoolBinding: false,
  accountPasswordValues: {},
  accountPasswordVisible: {},
  personaAccountEditingIds: {},
  accountPoolCreateOpen: false,
  accountPoolCreateDraft: {},
  proxyPoolPage: 1,
  proxyPoolPageSize: 10,
  personaMediaTasks: {},
  personaGenerateRuns: {},
  personaDetailRenderTimer: 0,
  personaHotImports: storedPersonaHotImports(),
  personaHotCandidateResults: {},
  personaForms: {},
  personaProfileModes: {},
  personaProfileRegenDrafts: {},
  personaLinkPresetPages: {},
  personaDraftViewModes: {},
  personaSelectedMediaIndexes: {},
  matrixPublish: {
    personaIds: [],
    source: "posts",
    perPersonaCount: 1,
    platform: "threads",
    scheduledAt: "",
    initialized: false,
  },
  personaPublishScheduleValues: {},
  renderedPersonaId: "",
  personaCreateMode: false,
  personaCreate: null,
  actionLocks: {},
  personaCreateBusy: {
    manual: false,
    keywords: false,
    aiCreate: false,
    profileContent: false,
  },
  personaCreateKeywordController: null,
  personaLinkPresetId: "",
  selectedPersonaId: "",
  selectedPersonaPostId: "",
  selectedPersonaPostAuto: false,
  selectedPersonaPostSource: "posts",
  taskQueuePanel: "persona",
  taskQueuePersonaPage: 1,
  taskQueueRegularPage: 1,
  taskQueuePersonaPageSize: storedTaskQueuePersonaPageSize(),
  taskQueueRegularPageSize: storedTaskQueueRegularPageSize(),
  browserPreferences: null,
  browserRecommendation: null,
  browserDurationDrafts: {},
  taskQueueSelectedPersonaIds: new Set(),
  taskQueueSelectedRegularIds: new Set(),
  taskQueueRefreshTimer: 0,
  accountStatusRefreshTimer: 0,
  liveBrowserRefreshTimer: 0,
  socialTaskToastRefreshTimer: 0,
  socialTaskScheduleWakeTimer: 0,
  publishTimingMode: "immediate",
  publishSchedulePreset: "custom",
  publishScheduleParts: null,
  publishContentSource: "posts",
  publishSelectedPostIds: {},
  publishPreviewPostId: "",
  publishHistoryPreviewId: "",
  publishCustomContent: "",
  socialTasksFetch: null,
  socialRefreshFetch: null,
  liveBrowserSessionsFetch: null,
  socialCancelAllPending: false,
  socialAccounts: [],
  socialProxies: [],
  socialTasks: [],
  socialTaskToastStatuses: {},
  socialTaskToastLabels: {},
  socialTaskToastKeys: {},
  socialTaskToastBatches: {},
  socialTaskToastTransitions: {},
  suppressedSocialTaskPromptIds: new Set(),
  socialTaskPersonaRefreshSignatures: {},
  socialBrowserSessions: [],
  dailyPublishPolicy: { limit: 15, used: 0, remaining: 15, locked: false, waived: false, day: "" },
  dailyPublishWarningDay: "",
  dailyPublishPolicyRequestSeq: 0,
  dailyPublishPolicyAppliedSeq: 0,
  dailyPublishWarningPromise: null,
  dailyPublishPendingWarning: null,
  liveBrowserLayout: storedLiveBrowserLayout(),
  browserPreferencesDirty: false,
  browserPolicySyncRevision: 0,
  browserPolicyLoaded: false,
  browserPolicyLoading: false,
  browserRecommendationRefreshing: false,
  browserAutoConfiguring: false,
  events: null,
  mediaPreviewGroups: {},
  mediaPreviewSeq: 0,
  mediaLightbox: {
    groupId: "",
    index: 0,
    scale: 1,
    x: 0,
    y: 0,
    dragging: false,
    dragX: 0,
    dragY: 0,
    startX: 0,
    startY: 0,
  },
};

let tenantStateGeneration = 0;
let consoleIdentityReady = false;
let consoleBoundaryNavigationActive = false;
let identityRevalidationPromise = null;

function consoleUserId(value) {
  return String(value == null ? "" : value).trim();
}

function maskConsoleForIdentityRevalidation() {
  // Keep the current layout mounted while /api/me is checked. Setting
  // `hidden` on <html> removes the whole document from layout, which makes
  // the browser clamp scrollY to 0 and produces a visible white flash.
  const root = document.documentElement;
  if (!root) return;
  if (root.dataset) root.dataset.consoleIdentityChecking = "true";
  else root.hidden = true;
}

function unmaskConsoleAfterIdentityRevalidation() {
  if (consoleBoundaryNavigationActive) return;
  const root = document.documentElement;
  if (!root) return;
  if (root.dataset) delete root.dataset.consoleIdentityChecking;
  else root.hidden = false;
}

function consoleBootstrapUserId() {
  return consoleUserId(
    window.__CONSOLE_BOOTSTRAP_USER_ID__ ?? window.__CONSOLE_BOOTSTRAP__?.user_id,
  );
}

function discardConsoleBootstrap() {
  try {
    window.__CONSOLE_BOOTSTRAP__ = null;
  } catch {}
}

function clearTenantInMemoryState() {
  tenantStateGeneration += 1;
  consoleIdentityReady = false;

  if (state.events) state.events.close?.();
  if (state.personaCreateKeywordController) {
    state.personaCreateKeywordController.abort?.(new DOMException("Session boundary", "AbortError"));
  }
  if (state.workspaceBootstrapTimer) window.clearTimeout(state.workspaceBootstrapTimer);
  if (state.personaDetailRenderTimer) window.clearTimeout(state.personaDetailRenderTimer);
  if (state.taskQueueRefreshTimer) window.clearInterval(state.taskQueueRefreshTimer);
  if (state.accountStatusRefreshTimer) window.clearInterval(state.accountStatusRefreshTimer);
  if (state.liveBrowserRefreshTimer) window.clearInterval(state.liveBrowserRefreshTimer);
  if (state.socialTaskToastRefreshTimer) window.clearInterval(state.socialTaskToastRefreshTimer);
  if (state.socialTaskScheduleWakeTimer) window.clearTimeout(state.socialTaskScheduleWakeTimer);
  Object.values(state.socialTaskToastTransitions || {}).forEach((transition) => {
    if (transition?.timer) window.clearTimeout(transition.timer);
  });

  state.currentUser = null;
  state.setupStatus = null;
  state.billing = {
    summary: null,
    orders: [],
    ledger: [],
    loaded: false,
    loading: false,
    cancellingOrderId: "",
    errors: {},
  };
  state.publishFiles = [];
  state.socialFiles = [];
  state.tasks = [];
  state.personas = [];
  state.personaProfiles = {};
  state.personaCollections = { groups: [], assigned_persona_ids: [] };
  state.personaCollectionTogglePending = new Set();
  state.personaBulkSelectedIds = new Set();
  state.personaBulkSelectedGroupIds = new Set();
  state.personaMemories = {};
  state.personaFetches = {
    profiles: {},
    draftPosts: {},
    favoritePosts: {},
    memories: {},
    publishHistories: {},
  };
  state.personaImageLibraries = {};
  state.personaDraftPosts = {};
  state.personaFavoritePosts = {};
  state.personaSelectedPostIds = {};
  state.personaPostSources = {};
  state.personaPostPages = {};
  state.personaPublishHistories = {};
  state.personaPublishAccountIds = {};
  state.personaPublishResults = {};
  state.personaPublishWatchers = {};
  state.personaAutomationResults = {};
  state.personaAutomationWatchers = {};
  state.accountPoolAccountId = "";
  state.accountPoolSelectedAccountIds = [];
  state.accountPoolPersonaId = "";
  state.accountPoolBinding = false;
  state.accountPasswordValues = {};
  state.accountPasswordVisible = {};
  state.personaAccountEditingIds = {};
  state.accountPoolCreateDraft = {};
  state.personaMediaTasks = {};
  state.personaGenerateRuns = {};
  state.personaHotImports = {};
  state.personaHotCandidateResults = {};
  state.personaForms = {};
  state.personaProfileModes = {};
  state.personaProfileRegenDrafts = {};
  state.personaLinkPresetPages = {};
  state.personaDraftViewModes = {};
  state.personaSelectedMediaIndexes = {};
  state.personaPublishScheduleValues = {};
  state.personaCreate = null;
  state.personaCreateKeywordController = null;
  state.actionLocks = {};
  state.selectedPersonaId = "";
  state.selectedPersonaPostId = "";
  state.taskQueueSelectedPersonaIds = new Set();
  state.taskQueueSelectedRegularIds = new Set();
  state.publishSelectedPostIds = {};
  state.publishPreviewPostId = "";
  state.publishHistoryPreviewId = "";
  state.publishCustomContent = "";
  state.socialTasksFetch = null;
  state.socialRefreshFetch = null;
  state.liveBrowserSessionsFetch = null;
  state.socialCancelAllPending = false;
  state.socialAccounts = [];
  state.socialProxies = [];
  state.socialTasks = [];
  state.socialTaskToastStatuses = {};
  state.socialTaskToastLabels = {};
  state.socialTaskToastKeys = {};
  state.socialTaskToastBatches = {};
  state.socialTaskToastTransitions = {};
  state.suppressedSocialTaskPromptIds = new Set();
  state.socialTaskPersonaRefreshSignatures = {};
  state.socialBrowserSessions = [];
  state.dailyPublishPolicy = { limit: 15, used: 0, remaining: 15, locked: false, waived: false, day: "" };
  state.dailyPublishWarningDay = "";
  state.dailyPublishPolicyRequestSeq = 0;
  state.dailyPublishPolicyAppliedSeq = 0;
  state.dailyPublishWarningPromise = null;
  state.dailyPublishPendingWarning = null;
  state.browserPreferences = null;
  state.browserRecommendation = null;
  state.browserDurationDrafts = {};
  state.browserPreferencesDirty = false;
  state.browserPolicySyncRevision += 1;
  state.browserPolicyLoaded = false;
  state.browserPolicyLoading = false;
  state.browserRecommendationRefreshing = false;
  state.browserAutoConfiguring = false;
  state.liveBrowserExpandedSessionId = "";
  state.liveBrowserRefreshTokens = {};
  state.events = null;
  state.mediaPreviewGroups = {};
  state.renderedPersonaId = "";
  state.workspaceBootstrapTimer = 0;
  state.personaDetailRenderTimer = 0;
  state.taskQueueRefreshTimer = 0;
  state.accountStatusRefreshTimer = 0;
  state.liveBrowserRefreshTimer = 0;
  state.socialTaskToastRefreshTimer = 0;
  state.socialTaskScheduleWakeTimer = 0;
  state.matrixPublish = {
    personaIds: [],
    source: "posts",
    perPersonaCount: 1,
    platform: "threads",
    scheduledAt: "",
    initialized: false,
  };
  discardConsoleBootstrap();
  window.PersonaDashboard?.unmount?.();
}

function clearStoredAdminWorkspaceContext() {
  try { window.sessionStorage.removeItem("vecto-admin-workspace-user-id"); } catch (_) {}
}

function handleSessionBoundary(status) {
  const normalizedStatus = Number(status || 0);
  if (![401, 428].includes(normalizedStatus)) return false;
  if (consoleBoundaryNavigationActive) return true;
  consoleBoundaryNavigationActive = true;
  clearTenantInMemoryState();
  const isAdminConsole = typeof ADMIN_CONSOLE_SESSION !== "undefined" && ADMIN_CONSOLE_SESSION;
  if (isAdminConsole) clearStoredAdminWorkspaceContext();
  window.location.replace(normalizedStatus === 428 ? "/change-password.html" : (isAdminConsole ? "/admin" : "/login.html"));
  return true;
}

function reloadForIdentityChange() {
  if (consoleBoundaryNavigationActive) return;
  consoleBoundaryNavigationActive = true;
  clearTenantInMemoryState();
  window.location.reload();
}

function tenantArrayFallback(error, currentValue = []) {
  if (consoleBoundaryNavigationActive || error?.stale || [401, 428].includes(Number(error?.status || 0))) return [];
  return Array.isArray(currentValue) ? currentValue : [];
}

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
  // Runtime credentials are intentionally administrator-only.  A normal user
  // cannot read them, so an absent admin snapshot must not be treated as a
  // missing-model error or block persona generation.
  if (!state.currentUser?.is_admin) return { ready: true, issues: [] };
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
  if (busy.profileContent) return "AI 生成简介";
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
  if (window.VectoSiteNavigation) {
    window.VectoSiteNavigation.sync();
    return;
  }
  const button = $("themeToggle");
  if (!button) return;
  const isDark = currentTheme() === "dark";
  const label = isDark ? "切换到亮色模式" : "切换到暗色模式";
  button.classList.add("theme-toggle");
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", isDark ? "true" : "false");
  button.innerHTML = `<span class="theme-toggle-icon" aria-hidden="true"></span>`;
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

const mobileNavMedia = window.matchMedia?.(MOBILE_NAV_QUERY);

function isMobileNavMode() {
  return Boolean(mobileNavMedia?.matches);
}

function setMobileNavOpen(open, { restoreFocus = false } = {}) {
  const toggle = $("mobileNavToggle");
  const sidebar = $("consoleSidebar");
  const backdrop = $("consoleNavBackdrop");
  const main = document.querySelector(".console-main");
  const toastHost = $("toastHost");
  if (!toggle || !sidebar || !backdrop || !document.body) return;
  const nextOpen = Boolean(open && isMobileNavMode());
  const shouldRestoreFocus = Boolean(!nextOpen && (restoreFocus || sidebar.contains(document.activeElement)));
  document.body.classList.toggle("mobile-nav-open", nextOpen);
  toggle.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  setConsoleUiAttribute(toggle, "aria-label", nextOpen ? "关闭导航" : "打开导航");
  sidebar.setAttribute("aria-hidden", isMobileNavMode() && !nextOpen ? "true" : "false");
  sidebar.inert = Boolean(isMobileNavMode() && !nextOpen);
  if (main) main.inert = nextOpen;
  if (toastHost) toastHost.inert = nextOpen;
  backdrop.hidden = !nextOpen;
  if (nextOpen) {
    window.requestAnimationFrame(() => sidebar.querySelector("button.is-active, button, a")?.focus({ preventScroll: true }));
  } else if (shouldRestoreFocus) {
    toggle.focus({ preventScroll: true });
  }
}

function bindMobileNavigation() {
  const toggle = $("mobileNavToggle");
  const closeButton = $("mobileNavClose");
  const sidebar = $("consoleSidebar");
  const backdrop = $("consoleNavBackdrop");
  if (!toggle || !closeButton || !sidebar || !backdrop) return;
  toggle.addEventListener("click", () => {
    setMobileNavOpen(toggle.getAttribute("aria-expanded") !== "true", { restoreFocus: true });
  });
  backdrop.addEventListener("click", () => setMobileNavOpen(false, { restoreFocus: true }));
  closeButton.addEventListener("click", () => setMobileNavOpen(false, { restoreFocus: true }));
  sidebar.addEventListener("click", (event) => {
    if (!isMobileNavMode()) return;
    const target = event.target.closest("button, a");
    if (!target) return;
    if (target.matches(".nav-parent-toggle") && state.view === "workspace") return;
    if (target.matches("[data-module], [data-workspace-view]")) {
      window.requestAnimationFrame(() => setMobileNavOpen(false));
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("mobile-nav-open")) {
      setMobileNavOpen(false, { restoreFocus: true });
    }
  });
  const syncMode = () => setMobileNavOpen(false);
  if (typeof mobileNavMedia?.addEventListener === "function") mobileNavMedia.addEventListener("change", syncMode);
  else mobileNavMedia?.addListener?.(syncMode);
  setMobileNavOpen(false);
}

const zhHantPhraseMap = [
  ["Web 任务控制台", "Web 任務控制台"],
  ["头发", "頭髮"],
  ["发型", "髮型"],
  ["理发", "理髮"],
  ["美发", "美髮"],
  ["长发", "長髮"],
  ["短发", "短髮"],
  ["白发", "白髮"],
  ["皇后", "皇后"],
  ["太后", "太后"],
  ["王后", "王后"],
  ["干杯", "乾杯"],
  ["饼干", "餅乾"],
  ["干燥", "乾燥"],
  ["干净", "乾淨"],
  ["干脆", "乾脆"],
  ["晒干", "曬乾"],
  ["风干", "風乾"],
  ["烘干", "烘乾"],
  ["干涉", "干涉"],
  ["干预", "干預"],
  ["干扰", "干擾"],
  ["若干", "若干"],
  ["控制台", "控制台"],
  ["控制", "控制"],
  ["运营后台", "營運後台"],
  ["统一 Web 操作面板", "統一 Web 操作面板"],
  ["后台自动", "後台自動"],
  ["任务工作台", "任務工作台"],
  ["任务队列", "任務佇列"],
  ["执行账号", "執行帳號"],
  ["账号设置", "帳號設定"],
  ["账号", "帳號"],
  ["指纹浏览器", "指紋瀏覽器"],
  ["网页登录", "網頁登入"],
  ["登录", "登入"],
  ["检测", "檢測"],
  ["养号", "養號"],
  ["回复", "回覆"],
  ["系统状态", "系統狀態"],
  ["我的人设", "我的人設"],
  ["人设列表", "人設列表"],
  ["详情", "詳情"],
  ["类型", "類型"],
  ["人设设置", "人設設定"],
  ["当前人设", "目前人設"],
  ["新建人设", "新建人設"],
  ["创建分组", "建立分組"],
  ["分组", "分組"],
  ["未分组", "未分組"],
  ["空分组", "空分組"],
  ["矩阵发布", "矩陣發布"],
  ["发布人设", "發布人設"],
  ["单选当前发布对象", "單選目前發布物件"],
  ["草稿发布", "草稿發布"],
  ["批量发布", "批次發布"],
  ["定时", "定時"],
  ["发布", "發布"],
  ["刷新", "重新整理"],
  ["亮色", "亮色"],
  ["暗色", "暗色"],
  ["设置", "設定"],
  ["绑定", "綁定"],
  ["未绑定", "未綁定"],
  ["复制", "複製"],
  ["简体中文", "簡體中文"],
  ["繁体中文", "繁體中文"],
  ["控製台", "控制台"],
  ["浏覽器", "瀏覽器"],
  ["複制", "複製"],
];

const zhHantCharMap = {
  设: "設", 置: "置", 号: "號", 账: "帳", 览: "覽", 发: "發", 布: "布", 队: "隊", 列: "列",
  任: "任", 务: "務", 态: "態", 当: "當", 前: "前", 对: "對", 象: "象", 选: "選", 择: "擇",
  创: "創", 建: "建", 组: "組", 阵: "陣", 时: "時", 批: "批", 量: "量", 后: "後", 台: "台",
  运: "運", 营: "營", 动: "動", 简: "簡", 体: "體", 繁: "繁", 汉: "漢", 个: "個", 条: "條",
  页: "頁", 图: "圖", 媒: "媒", 览: "覽", 删: "刪", 除: "除", 编: "編", 辑: "輯", 开: "開",
  启: "啟", 闭: "閉", 拟: "擬", 验: "驗", 证: "證", 认: "認", 阅: "閱", 复: "複", 制: "製",
  写: "寫", 录: "錄", 关: "關", 联: "聯", 导: "導", 入: "入", 输: "輸", 出: "出", 预: "預",
  览: "覽", 热: "熱", 点: "點", 抓: "抓", 取: "取", 候: "候", 补: "補", 词: "詞", 结: "結",
  果: "果", 库: "庫", 转: "轉", 换: "換", 语: "語", 言: "言", 详: "詳", 纹: "紋", 绑: "綁",
};

let zhHantCharacterMap = null;

function getZhHantCharacterMap() {
  if (zhHantCharacterMap) return zhHantCharacterMap;
  zhHantCharacterMap = new Map(Object.entries(zhHantCharMap));
  const dictionary = window.VectoOpenCcStCharacters;
  if (typeof dictionary !== "string") return zhHantCharacterMap;
  dictionary.split("|").forEach((entry) => {
    const separator = entry.indexOf(" ");
    if (separator <= 0) return;
    zhHantCharacterMap.set(entry.slice(0, separator), entry.slice(separator + 1));
  });
  return zhHantCharacterMap;
}

const i18nTextOriginals = new WeakMap();
const i18nAttrOriginals = new WeakMap();
let languageObserver = null;

const CONSOLE_I18N_MARKER = "data-i18n-ui";
const CONSOLE_I18N_SKIP_SELECTOR = "[data-i18n-skip], [data-site-header], script, style, textarea";
const CONSOLE_I18N_ATTRIBUTES = ["title", "aria-label", "placeholder", "data-mobile-label"];
const CONSOLE_DYNAMIC_UI_IDS = new Set([
  "mobileNavClose",
  "mobileNavToggle",
  "viewTitle",
  "moduleEyebrow",
  "moduleTitle",
  "refreshAll",
  "openAdmin",
  "accountBrowserAccountsTab",
  "accountBrowserProxiesTab",
  "refreshAccounts",
  "workerState",
  "refreshBilling",
  "btnPersonaDashboardRefresh",
  "btnPersonaDashboardRefreshAll",
]);

function currentLanguage() {
  return document.documentElement.dataset.language === "zh-Hant" ? "zh-Hant" : "zh-Hans";
}

function markConsoleUiElement(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE || node.closest(CONSOLE_I18N_SKIP_SELECTOR)) return;
  node.setAttribute(CONSOLE_I18N_MARKER, "true");
}

function markConsoleStaticUi(root = document.body) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!node.nodeValue?.trim() || parent?.closest(CONSOLE_I18N_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      if (parent?.id && !CONSOLE_DYNAMIC_UI_IDS.has(parent.id)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) markConsoleUiElement(walker.currentNode.parentElement);
  root.querySelectorAll("[title], [aria-label], [placeholder], [data-mobile-label]")
    .forEach((node) => markConsoleUiElement(node));
}

function consoleUiElements(root) {
  if (!root) return [];
  if (root.nodeType === Node.TEXT_NODE) {
    const parent = root.parentElement;
    return parent?.matches(`[${CONSOLE_I18N_MARKER}]`) ? [parent] : [];
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return [];
  const elements = [];
  if (root.nodeType === Node.ELEMENT_NODE && root.matches(`[${CONSOLE_I18N_MARKER}]`)) elements.push(root);
  root.querySelectorAll?.(`[${CONSOLE_I18N_MARKER}]`).forEach((node) => elements.push(node));
  return elements;
}

function toTraditionalChinese(value) {
  let text = String(value || "");
  const protectedPhrases = [];
  [...zhHantPhraseMap]
    .sort((left, right) => right[0].length - left[0].length)
    .forEach(([source, target], index) => {
      if (!text.includes(source)) return;
      const token = `\uE000${index}\uE001`;
      text = text.split(source).join(token);
      protectedPhrases.push([token, target]);
    });
  const characters = getZhHantCharacterMap();
  text = Array.from(text).map((char) => characters.get(char) || char).join("");
  protectedPhrases.forEach(([token, target]) => {
    text = text.split(token).join(target);
  });
  return text;
}

function translateTextNode(node, language) {
  if (!node?.nodeValue?.trim() || !node.parentElement?.matches(`[${CONSOLE_I18N_MARKER}]`)) return;
  if (!i18nTextOriginals.has(node)) i18nTextOriginals.set(node, node.nodeValue);
  const original = i18nTextOriginals.get(node);
  node.nodeValue = language === "zh-Hant" ? toTraditionalChinese(original) : original;
}

function translateElementAttributes(node, language) {
  if (!node?.matches?.(`[${CONSOLE_I18N_MARKER}]`) || node.closest(CONSOLE_I18N_SKIP_SELECTOR)) return;
  CONSOLE_I18N_ATTRIBUTES.forEach((attr) => {
    if (!node.hasAttribute(attr)) return;
    let originals = i18nAttrOriginals.get(node);
    if (!originals) {
      originals = {};
      i18nAttrOriginals.set(node, originals);
    }
    if (!Object.prototype.hasOwnProperty.call(originals, attr)) originals[attr] = node.getAttribute(attr) || "";
    const original = originals[attr] || "";
    node.setAttribute(attr, language === "zh-Hant" ? toTraditionalChinese(original) : original);
  });
}

function refreshConsoleUiAttributeSource(node, attr, language) {
  if (!node?.matches?.(`[${CONSOLE_I18N_MARKER}]`) || !CONSOLE_I18N_ATTRIBUTES.includes(attr)) return;
  let originals = i18nAttrOriginals.get(node);
  if (!originals) {
    originals = {};
    i18nAttrOriginals.set(node, originals);
  }
  const current = node.getAttribute(attr) || "";
  const previous = originals[attr];
  const translatedPrevious = previous === undefined
    ? null
    : language === "zh-Hant" ? toTraditionalChinese(previous) : previous;
  if (previous !== undefined && current === translatedPrevious) return;
  originals[attr] = current;
  const translated = language === "zh-Hant" ? toTraditionalChinese(current) : current;
  if (current !== translated) node.setAttribute(attr, translated);
}

function refreshConsoleUiTextSource(node, language) {
  if (!node?.nodeValue?.trim() || !node.parentElement?.matches(`[${CONSOLE_I18N_MARKER}]`)) return;
  const current = node.nodeValue;
  const previous = i18nTextOriginals.get(node);
  const translatedPrevious = previous === undefined
    ? null
    : language === "zh-Hant" ? toTraditionalChinese(previous) : previous;
  if (previous !== undefined && current === translatedPrevious) return;
  i18nTextOriginals.set(node, current);
  translateTextNode(node, language);
}

function setConsoleUiAttribute(node, attr, sourceValue) {
  if (!node) return;
  markConsoleUiElement(node);
  let originals = i18nAttrOriginals.get(node);
  if (!originals) {
    originals = {};
    i18nAttrOriginals.set(node, originals);
  }
  originals[attr] = String(sourceValue || "");
  node.setAttribute(attr, currentLanguage() === "zh-Hant" ? toTraditionalChinese(originals[attr]) : originals[attr]);
}

function translateConsoleLanguage(root = document.body, language = currentLanguage()) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root, language);
    return;
  }
  consoleUiElements(root).forEach((node) => {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) translateTextNode(child, language);
    });
    translateElementAttributes(node, language);
  });
  document.title = language === "zh-Hant" ? toTraditionalChinese("Web 任务控制台") : "Web 任务控制台";
}

function syncLanguageToggle() {
  if (window.VectoSiteNavigation) {
    window.VectoSiteNavigation.sync();
    return;
  }
  const button = $("languageToggle");
  if (!button) return;
  const isTraditional = currentLanguage() === "zh-Hant";
  button.title = isTraditional ? "切換到簡體中文" : "切换到繁体中文";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", isTraditional ? "true" : "false");
  button.innerHTML = `<span class="language-toggle-icon" aria-hidden="true"></span><span>${isTraditional ? "繁體" : "简体"}</span>`;
}

function applyLanguage(language) {
  const nextLanguage = language === "zh-Hant" ? "zh-Hant" : "zh-Hans";
  document.documentElement.dataset.language = nextLanguage;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
  } catch {}
  syncLanguageToggle();
  translateConsoleLanguage(document.body, nextLanguage);
}

function ensureLanguageToggle() {
  const button = $("languageToggle");
  syncLanguageToggle();
  return button;
}

function startLanguageObserver() {
  if (languageObserver || !document.body) return;
  languageObserver = new MutationObserver((mutations) => {
    const language = currentLanguage();
    mutations.forEach((mutation) => {
      if (mutation.type === "attributes") {
        refreshConsoleUiAttributeSource(mutation.target, mutation.attributeName, language);
        return;
      }
      if (mutation.type === "characterData") {
        refreshConsoleUiTextSource(mutation.target, language);
        return;
      }
      mutation.addedNodes.forEach((node) => translateConsoleLanguage(node, language));
    });
  });
  languageObserver.observe(document.body, {
    attributes: true,
    attributeFilter: CONSOLE_I18N_ATTRIBUTES,
    characterData: true,
    childList: true,
    subtree: true,
  });
}

function ensureThemeToggle() {
  const button = $("themeToggle");
  syncThemeToggle();
  return button;
}

const modules = [
  { id: "personas", label: "我的人设", hint: "人设列表、详情、推文、账号", callback: "后台自动读取" },
  { id: "tweet_generation", label: "推文生成", hint: "新建推文、草稿库、收藏", callback: "后台自动读取" },
  { id: "publishing", label: "发布", hint: "草稿发布、批量发布、定时发布", callback: "后台自动排队" },
  { id: "accounts", label: "账号管理自动化", hint: "账号池、自动回复、养号", view: "accounts", panels: ["accounts", "proxies"] },
  { id: "browser_list", label: "浏览器列表", hint: "实时浏览器窗口、人工接管", view: "accounts", panel: "browsers" },
];

const taskMeta = {
  text_to_image: { title: "文生图", minImages: 0, files: "无需文件，填写 Prompt 后直接生成图片。", callback: "后台自动提交" },
  persona_post_image: { title: "推文配图", minImages: 0, files: "基于当前草稿正文和人设参考图生成预览图片。", callback: "后台自动提交" },
};

const personaGroups = {
  settings: {
    label: "人设设置",
    defaultStep: "profile",
  },
  content: {
    label: "推文生成",
    defaultStep: "generate",
  },
};

const moduleDefaultBranch = {
  publishing: "publish_now",
  automation: "binding",
};

function isPersonaWorkspaceModule(moduleId = state.activeModule) {
  return ["personas", "tweet_generation"].includes(String(moduleId || ""));
}

function personaModuleDefaultGroup(moduleId = state.activeModule) {
  return moduleId === "tweet_generation" ? "content" : "settings";
}

function showPersonaGroupTabs(moduleId = state.activeModule) {
  return false;
}

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
  const requestGeneration = tenantStateGeneration;
  let response;
  try {
    response = await fetch(path, { credentials: "include", ...adminWorkspaceRequestOptions(options) });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
    throw { detail: localizeConsoleMessage(error?.message || "网络请求失败", 0), status: 0 };
  }
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { detail: text }; }
  if (!response.ok) {
    handleSessionBoundary(response.status);
    const detail = localizeConsoleMessage(data?.detail || data?.message || text || "", response.status);
    if (response.status === 429 && isDailyPublishLimitMessage(detail)) {
      let scheduledRequest = false;
      try {
        const requestBody = typeof options?.body === "string" ? JSON.parse(options.body) : options?.body;
        scheduledRequest = Boolean(requestBody?.scheduled_at);
      } catch {}
      const lockedPolicy = normalizeDailyPublishPolicy({
        ...state.dailyPublishPolicy,
        limit: Number(state.dailyPublishPolicy?.limit || 15),
        used: Math.max(Number(state.dailyPublishPolicy?.used || 0), Number(state.dailyPublishPolicy?.limit || 15)),
        remaining: 0,
        locked: true,
        message: detail,
      });
      if (!scheduledRequest) {
        updateDailyPublishPolicy(lockedPolicy, {
          notify: false,
          requestSeq: beginDailyPublishPolicyRequest(),
          force: true,
        });
      }
      void showDailyPublishLimitWarning(lockedPolicy);
      const refreshRequestSeq = beginDailyPublishPolicyRequest();
      void api("/api/persona_dashboard/automation/publish_policy?requested_count=0")
        .then((result) => updateDailyPublishPolicy(result?.publish_policy || result, { notify: false, requestSeq: refreshRequestSeq }))
        .catch(() => {});
    }
    if (data && typeof data === "object") {
      data.detail = detail;
      data.status = response.status;
    } else {
      data = { detail, status: response.status };
    }
    throw data;
  }
  if (requestGeneration !== tenantStateGeneration || consoleBoundaryNavigationActive) {
    throw { detail: "会话已切换，正在重新加载。", status: 409, stale: true };
  }
  return data;
}

async function apiWithTimeout(path, options = {}, timeoutMs = 90000) {
  const externalSignal = options.signal || null;
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason || new DOMException("Request aborted", "AbortError"));
  if (externalSignal) {
    if (externalSignal.aborted) abortFromExternal();
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }
  const timer = window.setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), Math.max(1000, Number(timeoutMs) || 90000));
  try {
    return await api(path, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      const reason = String(controller.signal.reason?.message || error?.message || "");
      if (/cancel/i.test(reason)) throw { detail: "已取消操作。", status: 499 };
      throw { detail: "请求超时，请稍后重试或改用手动输入。", status: 408 };
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", abortFromExternal);
  }
}

function localizeConsoleMessage(text, status = 0) {
  if (Array.isArray(text)) {
    const messages = text
      .map((item) => localizeValidationMessage(item, status))
      .filter(Boolean);
    return messages.length ? messages.join("；") : localizeConsoleMessage("", status);
  }
  if (text && typeof text === "object") {
    if (Array.isArray(text.detail)) return localizeConsoleMessage(text.detail, status);
    return localizeConsoleMessage(text.detail || text.message || text.msg || JSON.stringify(text), status);
  }
  const raw = String(text || "").trim();
  const exactMap = {
    "Method Not Allowed": "请求方式不正确",
    "Not Found": "请求的内容不存在",
    "Unauthorized": "登录已失效，请重新登录",
    "Forbidden": "当前没有权限执行这个操作",
    "Bad Request": "请求参数不正确",
    "Internal Server Error": "服务处理失败，请稍后重试",
    "Failed to fetch": "网络请求失败，请检查服务是否正常。",
    "NetworkError when attempting to fetch resource.": "网络请求失败，请检查服务是否正常。",
    "Request aborted": "请求已取消。",
    "Request timed out": "请求超时，请稍后重试。",
    "Field required": "缺少必填信息。",
    "field required": "缺少必填信息。",
    "post not found": "草稿已发布或已不存在，请刷新草稿库。",
    "persona_id 必填": "账号池新增账号不需要先选择人设，请刷新页面后重试。",
    "账号 username 必填": "请填写账号用户名。",
    "username 必填": "请填写账号用户名。",
  };
  if (exactMap[raw]) return exactMap[raw];
  const lower = raw.toLowerCase();
  if (/insufficient balance|insufficient credits?|quota exceeded|credits? exhausted|payment required|http\s*402|\b402\s+(?:client\s+)?error\b/i.test(raw)) {
    return "当前账户或上游生成服务额度不足，请补充余额或降低任务参数后重试。";
  }
  if (lower.startsWith("using text input mode:")) {
    const mode = raw.split(":").slice(1).join(":").trim();
    const modeLabel = { paste: "粘贴", fill: "填充", type: "逐字输入" }[mode.toLowerCase()] || mode;
    return `正在使用${modeLabel}模式输入文本。`;
  }
  if (/persona_id\s*(必填|required|field required)/i.test(raw)) return "账号池新增账号不需要先选择人设，请刷新页面后重试。";
  if (/field required/i.test(raw)) return "缺少必填信息。";
  if (/input should be/i.test(raw)) return "输入内容格式不正确。";
  if (/failed to fetch|networkerror/i.test(raw)) return "网络请求失败，请检查服务是否正常。";
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

function localizeValidationMessage(item, status = 0) {
  if (!item || typeof item !== "object") return localizeConsoleMessage(item, status);
  const raw = String(item.msg || item.message || item.detail || "").trim();
  const loc = Array.isArray(item.loc) ? item.loc : [];
  const field = loc.length ? String(loc[loc.length - 1] || "") : "";
  const fieldLabel = {
    persona_id: "人设",
    platform: "平台",
    username: "账号用户名",
    display_name: "显示名称",
    profile_dir: "浏览器资料目录",
    login_username: "登录账号",
    login_password: "登录密码",
    password: "密码",
    account_id: "账号",
    task_type: "任务类型",
  }[field] || "信息";
  if (field === "persona_id" && /field required|required|必填/i.test(raw)) {
    return "账号池新增账号不需要先选择人设，请刷新页面后重试。";
  }
  if (/field required/i.test(raw)) return `${fieldLabel}为必填项。`;
  if (/input should be/i.test(raw)) return `${fieldLabel}格式不正确。`;
  return localizeConsoleMessage(raw || JSON.stringify(item), status);
}

function eventKindLabel(kind) {
  return {
    ready: "已就绪",
    info: "提示",
    detail: "详情",
    progress: "进行中",
    queued: "已排队",
    success: "成功",
    standby: "待机中",
    failed: "失败",
    cancelled: "已取消",
    error: "错误",
    warn: "警告",
    warning: "警告",
    browser: "浏览器",
    persona: "人设",
    screenshot: "截图",
  }[String(kind || "").trim()] || String(kind || "提示").trim() || "提示";
}

const toastTimers = new WeakMap();
const toastSwitchTimers = new WeakMap();
const toastSwitchCleanupTimers = new WeakMap();
const toastRemovalTimers = new WeakMap();
const deliveredToastStateKeys = new Set();
const uploadPreviewUrls = new WeakMap();
let pendingToastRequest = null;
let toastReplacementInProgress = false;
const TOAST_REPLACEMENT_DURATION = 180;
const TOAST_DURATION = 5000;

function ensureToastHost() {
  let host = $("toastHost");
  if (host) return host;
  host = document.createElement("div");
  host.id = "toastHost";
  host.className = "toast-host";
  host.setAttribute("aria-live", "polite");
  host.setAttribute("aria-atomic", "false");
  document.body.appendChild(host);
  return host;
}

function clearToastSwitchTimers(toast) {
  const switchTimer = toastSwitchTimers.get(toast);
  if (switchTimer) window.clearTimeout(switchTimer);
  toastSwitchTimers.delete(toast);
  const cleanupTimer = toastSwitchCleanupTimers.get(toast);
  if (cleanupTimer) window.clearTimeout(cleanupTimer);
  toastSwitchCleanupTimers.delete(toast);
}

function clearToastRemovalTimer(toast) {
  const removalTimer = toastRemovalTimers.get(toast);
  if (removalTimer) window.clearTimeout(removalTimer);
  toastRemovalTimers.delete(toast);
}

function scheduleToastExpiry(toast) {
  const existingTimer = toastTimers.get(toast);
  if (existingTimer) window.clearTimeout(existingTimer);
  toastTimers.set(toast, window.setTimeout(() => dismissToast(toast), TOAST_DURATION));
}

function dismissToast(toast, options = {}) {
  if (!toast) return;
  clearToastSwitchTimers(toast);
  clearToastRemovalTimer(toast);
  if (options.manual && toast.dataset.toastStateKey) deliveredToastStateKeys.add(toast.dataset.toastStateKey);
  const timer = toastTimers.get(toast);
  if (timer) window.clearTimeout(timer);
  toastTimers.delete(toast);
  toast.classList.add("is-leaving");
  const reduceMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  const removalTimer = window.setTimeout(() => {
    toastRemovalTimers.delete(toast);
    toast.remove();
  }, reduceMotion ? 0 : 180);
  toastRemovalTimers.set(toast, removalTimer);
}

function removeToastNow(toast) {
  if (!toast) return;
  clearToastSwitchTimers(toast);
  clearToastRemovalTimer(toast);
  const timer = toastTimers.get(toast);
  if (timer) window.clearTimeout(timer);
  toastTimers.delete(toast);
  toast.remove();
}

function dismissToastByKey(key, options = {}) {
  const toastKey = String(key || "").trim();
  if (!toastKey) return;
  const host = $("toastHost");
  if (!host) return;
  Array.from(host.children)
    .filter((item) => item.dataset.toastKey === toastKey)
    .forEach((toast) => dismissToast(toast, options));
}

function toastTargetForKind(kind, options = {}) {
  const normalized = String(kind || "").trim();
  if (options.target && typeof options.target === "object") return options.target;
  if (options.taskId) {
    return {
      view: "tasks",
      taskPanel: options.taskPanel || "regular",
      taskId: String(options.taskId || "").trim(),
      personaId: String(options.personaId || "").trim(),
      openDetail: Boolean(options.openDetail),
    };
  }
  if (["queued", "queue", "progress", "running"].includes(normalized)) {
    return { view: "tasks", taskPanel: options.taskPanel || "persona" };
  }
  if (["persona"].includes(normalized)) {
    return { view: "workspace", module: "personas" };
  }
  if (["browser"].includes(normalized)) {
    return { view: "social" };
  }
  return null;
}

function normalizeToastStatus(status, ok = true, persistent = false) {
  const normalized = String(status || "").trim().toLowerCase();
  if (["queued", "running", "progress", "success", "failed", "error", "cancelled", "need_manual", "warning", "warn"].includes(normalized)) {
    return normalized;
  }
  if (persistent) return "running";
  return ok ? "success" : "failed";
}

function toastTimestampMs(value) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":")
    : [minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function applyToastMeta(toast, { key, ok, message, target, status, scheduled }) {
  if (!toast) return;
  const normalizedStatus = normalizeToastStatus(status, ok);
  const terminal = ["success", "failed", "error", "cancelled", "warning", "warn"].includes(normalizedStatus)
    || normalizedStatus === "need_manual";
  toast.className = [
    "toast-message",
    ok ? "is-ok" : "is-bad",
    target ? "is-clickable" : "",
    terminal ? "is-terminal" : "is-active",
    `is-status-${normalizedStatus}`,
  ].filter(Boolean).join(" ");
  toast.dataset.toastKey = key;
  toast.dataset.toastStateKey = `${key}:${normalizedStatus}`;
  toast.dataset.toastStatus = normalizedStatus;
  if (typeof scheduled === "boolean") {
    toast.dataset.toastScheduled = scheduled ? "true" : "false";
  } else {
    delete toast.dataset.toastScheduled;
  }
  if (target) {
    toast.dataset.toastTarget = JSON.stringify(target);
    toast.setAttribute("role", "button");
    toast.tabIndex = 0;
    toast.title = target.taskId ? "点击打开任务队列" : "点击跳转到相关页面";
  } else {
    delete toast.dataset.toastTarget;
    toast.setAttribute("role", ok ? "status" : "alert");
    toast.removeAttribute("tabindex");
    toast.removeAttribute("title");
  }
  const messageNode = toast.querySelector(".toast-message-text");
  if (messageNode) messageNode.textContent = message;
}

async function openToastTarget(rawTarget) {
  let target = rawTarget;
  if (typeof rawTarget === "string") {
    try { target = JSON.parse(rawTarget); } catch { target = null; }
  }
  if (!target || typeof target !== "object") return;
  const view = String(target.view || "").trim();
  const moduleId = String(target.module || "").trim();
  const targetPersonaId = String(target.personaId || "").trim();
  const targetAction = String(target.action || "").trim();
  if (targetAction === "persona_image_generation" && targetPersonaId) {
    if (!(await confirmLeaveTransientWorkspaceState())) return;
    await openPersonaImageGeneration(targetPersonaId);
    return;
  }
  if (view) {
    if (state.view === "workspace" && isPersonaWorkspaceModule() && view !== "workspace" && !(await canLeaveCurrentPersonaDraftEdit("leave"))) return;
    if (state.view === "workspace" && view !== "workspace" && !(await confirmLeaveTransientWorkspaceState())) return;
    setView(view);
  }
  if (targetPersonaId) {
    if (state.personas.some((persona) => String(persona.id || "") === targetPersonaId)) {
      state.selectedPersonaId = targetPersonaId;
    }
    state.taskQueuePersonaPage = 1;
  }
  if (view === "workspace" && moduleId) {
    if (moduleId !== state.activeModule && isPersonaWorkspaceModule() && !(await canLeaveCurrentPersonaDraftEdit("leave"))) return;
    if (moduleId !== state.activeModule && !(await confirmLeaveTransientWorkspaceState())) return;
    state.workspaceMenuOpen = true;
    setModule(moduleId);
  }
  if (moduleId === "queue" || view === "tasks") {
    if (target.taskPanel) state.taskQueuePanel = target.taskPanel === "regular" ? "regular" : "persona";
    await loadTasks().catch(() => {});
    if (target.taskId && (target.openDetail || target.taskPanel === "regular")) {
      await showTaskDetail(String(target.taskId || "")).catch((error) => {
        showToast(error?.detail || error?.message || "任务详情查询失败。", false, {
          key: `task-detail-error:${target.taskId}`,
          target: { view: "tasks", taskPanel: target.taskPanel || "regular" },
        });
      });
    }
  }
}

function createToast(request) {
  const { host, toastKey, ok, message, target, status, scheduled } = request;
  const toast = document.createElement("div");
  toast.innerHTML = `
    <span class="toast-message-body">
      <span class="toast-message-text">${esc(message)}</span>
    </span>
    <button type="button" class="toast-message-close" aria-label="关闭提示">×</button>
  `;
  applyToastMeta(toast, { key: toastKey, ok, message, target, status, scheduled });
  host.appendChild(toast);
  toast.querySelector(".toast-message-close")?.addEventListener("click", (event) => {
    event.stopPropagation();
    dismissToast(toast, { manual: true });
  });
  toast.addEventListener("click", (event) => {
    if (event.target.closest(".toast-message-close")) return;
    openToastTarget(toast.dataset.toastTarget || "").catch(() => {});
  });
  toast.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    if (!toast.dataset.toastTarget) return;
    event.preventDefault();
    openToastTarget(toast.dataset.toastTarget || "").catch(() => {});
  });
  scheduleToastExpiry(toast);
  return toast;
}

function removeToastsBeforeInsert(host, nextToastKey) {
  const outgoing = Array.from(host.children);
  if (!outgoing.length) return false;
  toastReplacementInProgress = true;
  const reduceMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  outgoing.forEach((toast) => {
    clearToastSwitchTimers(toast);
    clearToastRemovalTimer(toast);
    const timer = toastTimers.get(toast);
    if (timer) window.clearTimeout(timer);
    toastTimers.delete(toast);
    toast.classList.remove("is-leaving", "is-switching-out", "is-switching-in");
    toast.classList.add("is-replacing-out");
  });
  window.setTimeout(() => {
    outgoing.forEach((toast) => toast.remove());
    toastReplacementInProgress = false;
    flushPendingToast();
  }, reduceMotion ? 0 : TOAST_REPLACEMENT_DURATION);
  return true;
}

function flushPendingToast() {
  const request = pendingToastRequest;
  if (!request || toastReplacementInProgress) return null;
  if (removeToastsBeforeInsert(request.host, request.toastKey)) return null;
  pendingToastRequest = null;
  return createToast(request);
}

function showToast(text, ok = true, options = {}) {
  const message = String(text || "").trim();
  if (!message) return null;
  const host = ensureToastHost();
  const toastKey = String(options.key || `${ok ? "ok" : "bad"}:${message}`);
  const target = toastTargetForKind(options.kind || "", options);
  const status = normalizeToastStatus(options.status || options.kind, ok);
  const existingToast = Array.from(host.children).find((item) => item.dataset.toastKey === toastKey);
  const toastStateKey = `${toastKey}:${status}`;
  const deliverOnce = Boolean(options.oncePerState || options.taskId);
  if (deliverOnce && !existingToast && deliveredToastStateKeys.has(toastStateKey)) return null;
  const scheduled = typeof options.scheduled === "boolean" ? options.scheduled : undefined;
  const request = { host, toastKey, ok, message, target, status, scheduled };
  if (deliverOnce) deliveredToastStateKeys.add(toastStateKey);

  if (existingToast && !toastReplacementInProgress) {
    const previousMessage = existingToast.querySelector(".toast-message-text")?.textContent || "";
    const presentationChanged = previousMessage !== message
      || String(existingToast.dataset.toastStatus || "") !== status;
    const activeTaskStatuses = new Set(["queued", "running", "progress"]);
    const isActiveTaskRefresh = Boolean(options.taskId) && activeTaskStatuses.has(status);
    const isTaskRefresh = (!presentationChanged && Boolean(options.taskId)) || isActiveTaskRefresh;
    if (isTaskRefresh) {
      // A polling refresh must not revive a toast that has reached its
      // five-second expiry; otherwise the three-second task poll keeps it on
      // screen forever.
      if (existingToast.classList.contains("is-leaving")) return existingToast;
      // keep the existing DOM and class list intact. Re-applying meta here
      // restarts the CSS entry animation on every browser-task poll, which
      // looks like the toast is repeatedly disappearing and reappearing.
      return existingToast;
    }
  }

  // The host is intentionally single-message: each new operation withdraws the
  // previous card before the new card enters, instead of mutating it in place.
  pendingToastRequest = request;
  return flushPendingToast() || existingToast;
}

function defaultToastTargetForMessage(id) {
  const cleanId = String(id || "").trim();
  if (cleanId === "taskQueueMsg") {
    return { view: "tasks", taskPanel: state.taskQueuePanel || "persona" };
  }
  if (cleanId === "commandMsg" && state.view === "workspace") {
    return { view: "workspace", module: state.activeModule || "personas" };
  }
  if (cleanId === "socialMsg") return { view: "accounts" };
  return null;
}

function showMsg(id, text, ok = true, options = {}) {
  const node = $(id);
  if (node) {
    node.textContent = "";
    node.className = "notice";
  }
  showToast(text, ok, {
    ...options,
    target: options.target || defaultToastTargetForMessage(id),
  });
}

function showMsgHtml(id, html, ok = true) {
  const node = $(id);
  if (node) {
    node.innerHTML = "";
    node.className = "notice";
  }
  const temp = document.createElement("div");
  temp.innerHTML = html || "";
  showToast(temp.textContent || "", ok);
}

function clearMsg(id) {
  const node = $(id);
  if (!node) return;
  node.textContent = "";
  node.className = "notice";
}

function clearConsoleNotices() {
  clearMsg("commandMsg");
  clearMsg("taskQueueMsg");
  clearMsg("socialMsg");
  clearMsg("billingMsg");
  clearMsg("consoleSettingsMsg");
}

function closeConsoleModal(result) {
  const modal = $("consoleModal");
  if (!modal) return;
  const resolver = modal.__resolve;
  if (typeof modal.__cleanup === "function") modal.__cleanup();
  modal.remove();
  if (typeof resolver === "function") resolver(result);
  if (state.dailyPublishPendingWarning && !state.dailyPublishWarningPromise) {
    const pending = state.dailyPublishPendingWarning;
    state.dailyPublishPendingWarning = null;
    window.setTimeout(() => void showDailyPublishLimitWarning(pending), 0);
  }
}

function openConsoleModal({ title = "确认操作", message = "", contentHtml = "", inputLabel = "", inputValue = "", fields = [], confirmText = "确定", cancelText = "取消", danger = false, showCancel = true, extraActions = [], modalKey = "" } = {}) {
  closeConsoleModal(null);
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.id = "consoleModal";
    modal.className = "console-modal";
    modal.dataset.modalKey = String(modalKey || "");
    modal.__resolve = resolve;
    modal.innerHTML = `
      <div class="console-modal-backdrop" data-console-modal-cancel></div>
      <section class="console-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="consoleModalTitle">
        <div class="console-modal-head">
          <strong id="consoleModalTitle">${esc(title)}</strong>
        </div>
        ${message ? `<p>${esc(message)}</p>` : ""}
        ${contentHtml ? `<div class="console-modal-content">${contentHtml}</div>` : ""}
        ${inputLabel ? `
          <label>${esc(inputLabel)}
            <input id="consoleModalInput" value="${esc(inputValue)}" />
          </label>
        ` : ""}
        ${Array.isArray(fields) && fields.length ? `
          <div class="console-modal-fields">
            ${fields.map((field) => `
              <label>${esc(field?.label || "")}
                ${field?.multiline
                  ? `<textarea data-console-modal-field="${esc(field?.name || "")}" rows="3" placeholder="${esc(field?.placeholder || "")}">${esc(field?.value || "")}</textarea>`
                  : `<input data-console-modal-field="${esc(field?.name || "")}" type="${esc(field?.type || "text")}" value="${esc(field?.value || "")}" placeholder="${esc(field?.placeholder || "")}" ${field?.required ? "required" : ""} />`}
              </label>
            `).join("")}
          </div>
        ` : ""}
        <div class="console-modal-actions">
          ${showCancel ? `<button type="button" data-console-modal-cancel>${esc(cancelText)}</button>` : ""}
          ${Array.isArray(extraActions) ? extraActions.map((action) => `<button type="button" class="${action?.danger ? "danger" : ""}" data-console-modal-value="${esc(action?.value || "")}">${esc(action?.text || "")}</button>`).join("") : ""}
          <button type="button" class="${danger ? "danger" : "primary"}" data-console-modal-confirm>${esc(confirmText)}</button>
        </div>
      </section>
    `;
    document.body.appendChild(modal);
    modal.querySelectorAll("strong, p, label, button, [title], [aria-label], [placeholder]").forEach(markConsoleUiElement);
    translateConsoleLanguage(modal, currentLanguage());
    const input = $("consoleModalInput");
    const fieldInputs = [...modal.querySelectorAll("[data-console-modal-field]")];
    const firstInput = input || fieldInputs[0];
    if (firstInput) {
      firstInput.focus();
      if (typeof firstInput.select === "function") firstInput.select();
    } else {
      modal.querySelector("[data-console-modal-confirm]")?.focus();
    }
    modal.addEventListener("click", (event) => {
      if (event.target.closest("[data-console-modal-cancel]")) {
        closeConsoleModal(null);
      }
      const valueButton = event.target.closest("[data-console-modal-value]");
      if (valueButton) {
        closeConsoleModal(valueButton.dataset.consoleModalValue || "");
      }
      if (event.target.closest("[data-console-modal-confirm]")) {
        const missing = fieldInputs.find((field) => field.required && !String(field.value || "").trim());
        if (missing) {
          missing.focus();
          return;
        }
        const result = fieldInputs.length
          ? Object.fromEntries(fieldInputs.map((field) => [field.dataset.consoleModalField || "", field.value]))
          : (input ? input.value : true);
        closeConsoleModal(result);
      }
    });
    modal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeConsoleModal(null);
      if (event.key === "Enter" && input) closeConsoleModal(input.value);
    });
  });
}

const DAILY_PUBLISH_LIMIT_WARNING = "超过 15 篇会有封号风险，系统已强制禁止继续发布。";

function normalizeDailyPublishPolicy(value = {}) {
  const limit = Math.max(1, Number(value?.limit || 15));
  const used = Math.max(0, Number(value?.used || 0));
  const remaining = Math.max(0, Number.isFinite(Number(value?.remaining)) ? Number(value.remaining) : limit - used);
  const waived = Boolean(value?.waived);
  return {
    ...value,
    limit,
    used,
    remaining,
    requested: Math.max(0, Number(value?.requested || 0)),
    waived,
    check_failed: Boolean(!waived && value?.check_failed),
    locked: Boolean(!waived && (value?.locked || value?.check_failed || used >= limit)),
    request_blocked: Boolean(!waived && value?.request_blocked),
    day: String(value?.day || ""),
  };
}

function isDailyPublishLimitMessage(value) {
  const text = String(value || "");
  return text.includes("15") && (text.includes("封号风险") || text.includes("封號風險"));
}

function dailyPublishIsLocked(policy = state.dailyPublishPolicy) {
  const normalized = normalizeDailyPublishPolicy(policy);
  return Boolean(!normalized.waived && normalized.locked);
}

function dailyPublishActionAttrs() {
  const locked = dailyPublishIsLocked();
  return `data-daily-publish-action="true" aria-disabled="${locked ? "true" : "false"}"${locked ? ` title="${esc(DAILY_PUBLISH_LIMIT_WARNING)}"` : ""}`;
}

function applyDailyPublishButtonLocks(root = document) {
  const locked = dailyPublishIsLocked();
  root?.querySelectorAll?.("[data-daily-publish-action]").forEach((button) => {
    button.classList.toggle("is-daily-publish-locked", locked);
    button.setAttribute("aria-disabled", locked ? "true" : "false");
    button.toggleAttribute("data-daily-publish-locked", locked);
    if (locked) button.setAttribute("title", DAILY_PUBLISH_LIMIT_WARNING);
    else if (button.getAttribute("title") === DAILY_PUBLISH_LIMIT_WARNING) button.removeAttribute("title");
  });
}

async function showDailyPublishLimitWarning(policy = state.dailyPublishPolicy) {
  const normalized = normalizeDailyPublishPolicy(policy);
  if (state.dailyPublishWarningPromise) return state.dailyPublishWarningPromise;
  const activeModal = $("consoleModal");
  if (activeModal && activeModal.dataset.modalKey !== "daily-publish-limit") {
    state.dailyPublishPendingWarning = normalized;
    return false;
  }
  const message = String(normalized.message || DAILY_PUBLISH_LIMIT_WARNING);
  const warningPromise = openConsoleModal({
    title: "发布风险警告",
    message,
    contentHtml: `
      <div class="daily-publish-risk-panel" role="alert">
        <strong>今日发布额度：${esc(`${normalized.used} / ${normalized.limit}`)}</strong>
        <p>为降低社媒账号被封禁的风险，系统不会继续创建发布任务。管理员操作不受此限制。</p>
      </div>`,
    confirmText: "我知道了",
    showCancel: false,
    modalKey: "daily-publish-limit",
  }).then(() => false);
  state.dailyPublishWarningPromise = warningPromise;
  return warningPromise.finally(() => {
    if (state.dailyPublishWarningPromise === warningPromise) state.dailyPublishWarningPromise = null;
  });
}

function beginDailyPublishPolicyRequest() {
  state.dailyPublishPolicyRequestSeq += 1;
  return state.dailyPublishPolicyRequestSeq;
}

function updateDailyPublishPolicy(value, { notify = true, requestSeq = 0, force = false } = {}) {
  if (!value || typeof value !== "object") return state.dailyPublishPolicy;
  const cleanRequestSeq = Math.max(0, Number(requestSeq || 0));
  if (!force && cleanRequestSeq && cleanRequestSeq < state.dailyPublishPolicyAppliedSeq) return state.dailyPublishPolicy;
  if (cleanRequestSeq) state.dailyPublishPolicyAppliedSeq = Math.max(state.dailyPublishPolicyAppliedSeq, cleanRequestSeq);
  const previous = normalizeDailyPublishPolicy(state.dailyPublishPolicy);
  const next = normalizeDailyPublishPolicy(value);
  state.dailyPublishPolicy = next;
  applyDailyPublishButtonLocks();
  if (notify && next.locked && !next.waived && (!previous.locked || state.dailyPublishWarningDay !== next.day)) {
    state.dailyPublishWarningDay = next.day || "current";
    void showDailyPublishLimitWarning(next);
  }
  return next;
}

async function ensureDailyPublishCapacity(requestedCount = 1, { scheduledAt = "" } = {}) {
  const requested = Math.max(1, Number(requestedCount || 1));
  let policy = normalizeDailyPublishPolicy(state.dailyPublishPolicy);
  const requestSeq = beginDailyPublishPolicyRequest();
  try {
    const query = new URLSearchParams({ requested_count: String(requested) });
    if (scheduledAt) query.set("scheduled_at", String(scheduledAt));
    const result = await api(`/api/persona_dashboard/automation/publish_policy?${query.toString()}`);
    policy = normalizeDailyPublishPolicy(result?.publish_policy || result || policy);
    if (!scheduledAt) updateDailyPublishPolicy(policy, { notify: false, requestSeq });
  } catch (error) {
    if (Number(error?.status || 0) === 401 || Number(error?.status || 0) === 403) throw error;
    if (policy.waived) return true;
    policy = updateDailyPublishPolicy({
      ...policy,
      locked: true,
      check_failed: true,
      message: "暂时无法确认今日发布额度，系统已暂停发布，请稍后重试。",
    }, { notify: false, requestSeq, force: true });
    return showDailyPublishLimitWarning(policy);
  }
  if (policy.waived || (!policy.locked && !policy.request_blocked && requested <= policy.remaining)) return true;
  return showDailyPublishLimitWarning(policy);
}

function renderDailyPublishLimitBanner() {
  const policy = normalizeDailyPublishPolicy(state.dailyPublishPolicy);
  if (policy.waived) return "";
  const tone = policy.locked ? "is-locked" : (policy.remaining <= 3 ? "is-warning" : "is-normal");
  return `
    <div class="daily-publish-limit-banner ${tone}">
      <div><strong>每日发布保护</strong><span>今日 ${esc(`${policy.used} / ${policy.limit}`)} 篇</span></div>
      <p>${policy.locked ? esc(DAILY_PUBLISH_LIMIT_WARNING) : `今日还可发布 ${esc(String(policy.remaining))} 篇。达到上限后系统会锁定全部发布入口。`}</p>
    </div>`;
}

window.VectoPublishRiskGuard = {
  apply: applyDailyPublishButtonLocks,
  beginRequest: beginDailyPublishPolicyRequest,
  ensureCapacity: ensureDailyPublishCapacity,
  isLocked: dailyPublishIsLocked,
  showWarning: showDailyPublishLimitWarning,
  updatePolicy: updateDailyPublishPolicy,
};

function handleDailyPublishActionGate(event) {
  const action = event.target?.closest?.("[data-daily-publish-action]");
  if (!action || !dailyPublishIsLocked()) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  void showDailyPublishLimitWarning();
  return true;
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

function formatScheduledTime(value) {
  if (!value) return "-";
  const timestamp = timeValue(value);
  const date = new Date(timestamp);
  return !timestamp || Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleString("zh-CN", { timeZone: SHANGHAI_TIME_ZONE, hour12: false });
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
    account_confirmation_required: "需确认关联账号",
    need_verification: "需验证",
    cookie_expired: "登录已过期",
    transient_error: "登录页面异常",
    disabled: "已禁用",
    ready: "可用",
    open_login: "登录流程",
    check_login: "登录状态同步",
    publish_post: "发布内容",
    persona_post_image: "推文配图",
    threads_warmup: "Threads 养号",
    threads_auto_reply: "Threads 自动回复",
    browse_feed: "浏览动态",
    login_wait_timeout: "登录等待超时",
    browser_launch: "启动浏览器",
    prepare: "准备执行",
    preparing: "准备执行",
  };
  return map[String(status || "")] || String(status || "-");
}

function statusTone(status) {
  const key = String(status || "").trim();
  if (["success", "ready", "standby"].includes(key)) return "success";
  if (["failed", "error", "cookie_expired", "transient_error", "login_wait_timeout"].includes(key)) return "error";
  if (["queued", "scheduled", "pending"].includes(key)) return "queued";
  if (["need_manual", "pending_login", "account_confirmation_required", "need_verification"].includes(key)) return "manual";
  if (["running", "checking", "browser_launch", "prepare", "preparing", "progress"].includes(key)) return "active";
  if (["cancelled", "disabled", "unknown"].includes(key)) return "muted";
  return "muted";
}

function renderStatusText(status, { className = "" } = {}) {
  const key = String(status || "").trim();
  const classes = ["task-status-text", `is-${statusTone(key)}`, className].filter(Boolean).join(" ");
  return `<span class="${esc(classes)}">${esc(statusLabel(key))}</span>`;
}

function accountLastLoginCheckLabel(account) {
  if (!account) return "上次检测：未知 · 尚未检测";
  const status = String(account.status || "unknown").trim();
  const checkedAt = Number(account.last_login_check_at || 0);
  const checkedDate = checkedAt > 0 ? new Date(checkedAt * 1000) : null;
  const checkedTime = checkedDate && !Number.isNaN(checkedDate.getTime())
    ? checkedDate.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    : "尚未检测";
  return `上次检测：${statusLabel(status)} · ${checkedTime}`;
}

function accountStatusClassNames(status) {
  const key = String(status || "unknown").trim();
  return key === "account_confirmation_required" ? `${key} need_verification` : key;
}

function renderAccountStatusChip(account, { emptyLabel = "未选择" } = {}) {
  if (!account) return `<span class="task-status-text is-muted account-status-chip">${esc(emptyLabel)}</span>`;
  const accountId = String(account.id || "");
  const key = String(account.status || "unknown").trim();
  const classes = ["task-status-text", `is-${statusTone(key)}`, "account-status-chip"].join(" ");
  const label = accountLastLoginCheckLabel(account);
  return `<span class="${esc(classes)}" data-account-status-for="${esc(accountId)}" title="${esc(label)}">${esc(label)}</span>`;
}

function renderAccountFieldHead(label, account, options = {}) {
  return `
    <span class="account-field-head">
      <span>${esc(label)}</span>
      ${renderAccountStatusChip(account, options)}
    </span>`;
}

function accountDisplayName(account) {
  return String(account?.username || account?.account_username || account?.id || "").trim() || "未命名账号";
}

function accountTotpStatusLabel(status = "", configured = false) {
  const key = String(status || "").trim().toLowerCase();
  if (!configured) return "2FA 未配置";
  if (key === "verified") return "2FA 已验证";
  if (key === "pending") return "2FA 待验证";
  if (["invalid", "error"].includes(key)) return "2FA 异常";
  if (key === "disabled") return "2FA 已停用";
  return "2FA 已配置";
}

function renderAccountTotpBadge(account) {
  const accountId = String(account?.id || "");
  const configured = Boolean(account?.totp_configured);
  const status = String(account?.totp_status || "").trim().toLowerCase();
  const label = accountTotpStatusLabel(status, configured);
  return `<span class="account-totp-badge" data-account-totp-for="${esc(accountId)}" data-totp-status="${esc(status)}" ${configured ? "" : "hidden"} title="${esc(label)}">${esc(label)}</span>`;
}

function updateAccountTotpBadgeNode(node, account) {
  if (!node || !account) return;
  const configured = Boolean(account.totp_configured ?? account.configured);
  const status = String(account.totp_status ?? account.status ?? "");
  const label = accountTotpStatusLabel(status, configured);
  node.hidden = !configured;
  node.dataset.totpStatus = status.trim().toLowerCase();
  node.textContent = label;
  node.title = label;
}

function updateAccountTotpBadgeViews(accountId = "", totp = null) {
  const cleanId = String(accountId || "").trim();
  const account = totp || accountById(cleanId);
  if (!cleanId || !account) return;
  document.querySelectorAll("[data-account-totp-for]").forEach((node) => {
    if (String(node.dataset.accountTotpFor || "") !== cleanId) return;
    updateAccountTotpBadgeNode(node, account);
  });
}

function applyAccountTotpState(accountId = "", totp = {}) {
  const cleanId = String(accountId || "").trim();
  if (!cleanId) return null;
  const account = accountById(cleanId);
  if (!account) return null;
  if (Object.prototype.hasOwnProperty.call(totp, "configured")) account.totp_configured = Boolean(totp.configured);
  if (Object.prototype.hasOwnProperty.call(totp, "status")) account.totp_status = String(totp.status || "");
  if (Object.prototype.hasOwnProperty.call(totp, "updated_at")) account.totp_updated_at = totp.updated_at;
  if (Object.prototype.hasOwnProperty.call(totp, "last_verified_at")) account.totp_last_verified_at = totp.last_verified_at;
  updateAccountTotpBadgeViews(cleanId, account);
  return account;
}

function queuePlatformLabel(platform) {
  const key = String(platform || "").trim().toLowerCase();
  if (key === "threads") return "Threads";
  if (key === "instagram") return "Instagram";
  return key || "-";
}

function platformLabel(platform) {
  return queuePlatformLabel(platform);
}

function sanitizeTaskUserMessage(value, { fallback = "步骤已记录。" } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  const exactMap = {
    "Cleaned stale browser profile lock files": "已清理失效的浏览器配置锁文件。",
    "Starting social automation task": "自动化任务开始执行。",
    "Launching Camoufox persistent profile": "正在启动指纹浏览器环境。",
    "KasmVNC live browser monitor started": "实时浏览器监控已启动。",
    "Live browser monitor initialization failed; continuing without monitor.": "实时浏览器监控初始化失败，已继续普通执行。",
    "Live browser entered standby; it can be closed manually or automatically later.": "实时浏览器已进入待机状态，可手动关闭或等待自动关闭。",
    "Live browser standby failed; closed through the normal flow.": "实时浏览器待机失败，已按原流程关闭。",
    "Live browser viewport has been synchronized": "已同步实时监控窗口尺寸。",
    "Live browser viewport synchronization failed; continuing task": "实时监控窗口尺寸同步失败，继续执行任务。",
    "Manual login task lost its live worker; requeued to verify the current browser profile.": "登录任务的实时执行进程已断开，系统已重新排队检查当前浏览器登录状态。",
    "Manual login task recovered because the account is already ready.": "已恢复登录任务：当前账号已经处于登录成功状态。",
    "Browser is open for login": "登录窗口已打开，请在浏览器中完成登录。",
    "No usable initial cookies were available for this profile": "当前浏览器配置没有可用的初始 Cookie。",
    "Imported initial cookies into the browser profile": "已导入初始 Cookie 到浏览器配置。",
    "Failed to import initial cookies into the browser profile": "导入初始 Cookie 到浏览器配置失败。",
    "Failed to back up stale browser profile": "备份旧浏览器配置失败。",
    "Login form has been filled": "登录表单已填写完成。",
    "Login inputs were not visible for automatic credential input": "自动输入登录资料时未找到账号或密码输入框。",
    "Login form submitted; waiting for ready state or verification": "登录表单已提交，正在等待登录成功或平台验证。",
    "Typing username into login form": "正在输入账号。",
    "Typing password into login form": "正在输入密码。",
    "Automatic credential typing failed": "自动输入登录资料失败。",
    "Verification or security challenge is visible; waiting for manual intervention in the open browser": "检测到验证码或安全验证，请在浏览器窗口中人工完成验证。",
    "Ready state was not stable yet": "登录状态暂未稳定，正在继续确认。",
    "Threads authenticated UI is visible": "已识别到 Threads 登录后的页面。",
    "Threads login prompt is visible": "检测到 Threads 登录提示。",
    "Threads login form is visible": "检测到 Threads 登录表单。",
    "Threads login page is visible": "检测到 Threads 登录页面。",
    "Instagram login page is visible": "检测到 Instagram 登录页面。",
    "Login form is visible": "检测到登录表单。",
    "Verification or challenge text is visible": "检测到验证码或安全验证提示。",
    "Screenshot captured": "系统已记录当前页面截图。",
    "Clicking target": "正在点击目标位置。",
    "Target comment text was not found before replying": "回复前未找到目标评论文本。",
    "No persona-relevant reply candidate was available": "未找到符合当前人设的回复候选内容。",
    "No Threads hot-post targets were available": "当前没有可用的 Threads 热点帖子目标。",
    "Replied with persona text": "已使用人设文案完成回复。",
    "Replied to Threads hot post": "已回复 Threads 热点帖子。",
    "Commented during Threads warmup": "Threads 养号过程中已发布评论。",
    "Starting Threads warmup from persona automation settings": "开始按人设自动化设置执行 Threads 养号。",
    "Starting persona-driven Threads auto reply": "开始执行人设驱动的 Threads 自动回复。",
    "Starting Threads hot-post auto reply": "开始执行 Threads 热点帖子自动回复。",
    "Like backfill failed; switching target": "补点赞失败，继续切换目标。",
    "Comment backfill failed; switching target": "补评论失败，继续切换目标。",
    "Comment target was not found; continuing browse": "未定位到评论目标，继续浏览。",
    "Reply target was not found; switching target": "未定位到回复目标，继续切换目标。",
    "Reply backfill failed; switching target": "补回复失败，继续切换目标。",
  };
  if (exactMap[raw]) return exactMap[raw];
  if (lower.startsWith("using text input mode:")) {
    const mode = raw.split(":").slice(1).join(":").trim();
    const modeLabel = { paste: "粘贴", fill: "填充", type: "逐字输入" }[mode.toLowerCase()] || mode;
    return `正在使用${modeLabel}模式输入文本。`;
  }
  if (lower.includes("manual login window timed out")) {
    return "登录流程等待超时，请重新发起发布或自动化任务，或检查当前账号是否已经跳转到登录验证页面。";
  }
  if (lower.includes("manual login task lost its live worker")) {
    return "登录任务的实时执行进程已断开，系统已重新排队检查当前浏览器登录状态。";
  }
  if (lower.includes("manual login task recovered")) {
    return "已恢复登录任务：当前账号已经处于登录成功状态。";
  }
  if (lower.includes("browser is open for manual login")) {
    return "登录窗口已打开，请在浏览器中完成登录。";
  }
  if (lower.includes("browser is open for login")) {
    return "登录窗口已打开，请在浏览器中完成登录。";
  }
  if (lower.includes("launching camoufox") || lower.includes("persistent profile")) {
    return "正在启动浏览器环境。";
  }
  if (lower.includes("starting social automation task")) {
    return "自动化任务开始执行。";
  }
  if (lower.includes("cleaned stale browser profile lock")) {
    return "已清理失效的浏览器配置锁文件。";
  }
  if (lower.includes("failed to clean stale profile lock")) {
    return "清理浏览器配置锁文件失败，请检查浏览器是否仍在运行。";
  }
  if (lower.includes("profile lock is active")) {
    return "检测到浏览器配置锁，可能还有浏览器窗口正在运行。";
  }
  if (lower.includes("kasmvnc") && lower.includes("started")) {
    return "实时浏览器监控已启动。";
  }
  if (lower.includes("live browser") && lower.includes("unavailable")) {
    return "实时浏览器监控依赖不可用，已回退到普通浏览器执行。";
  }
  if (lower.includes("live browser") && lower.includes("standby")) {
    return lower.includes("failed")
      ? "实时浏览器待机失败，已按原流程关闭。"
      : "实时浏览器已进入待机状态，可手动关闭或等待自动关闭。";
  }
  if (lower.includes("live browser viewport")) {
    return lower.includes("failed") ? "实时监控窗口尺寸同步失败，继续执行任务。" : "已同步实时监控窗口尺寸。";
  }
  if (lower.includes("login inputs were not visible")) {
    return "未找到账号或密码输入框，请在浏览器中确认当前登录页面。";
  }
  if (lower.includes("typing username")) {
    return "正在输入账号。";
  }
  if (lower.includes("typing password")) {
    return "正在输入密码。";
  }
  if (lower.includes("login form submitted")) {
    return "登录表单已提交，正在等待登录成功或平台验证。";
  }
  if (lower.includes("verification") || lower.includes("challenge")) {
    return "检测到验证码或安全验证，请在浏览器窗口中人工完成验证。";
  }
  if (lower.includes("saved credentials were rejected")) {
    return "保存的登录资料被平台判定不正确，请在打开的浏览器里人工修正后继续。";
  }
  if (lower.includes("automatic login flow could not confirm completion")) {
    return "自动流程未能确认登录完成，请在浏览器中人工处理或取消任务。";
  }
  if (lower.includes("login window was closed before login was confirmed")) {
    return "登录窗口已关闭，未检测到登录成功。请重新启动登录任务。";
  }
  if (lower.includes("manual login status updated")) {
    return "人工登录状态已更新。";
  }
  if (lower.includes("authenticated ui")) {
    return "已识别到登录后的页面。";
  }
  if (lower.includes("worker") && raw.includes("领取")) {
    return "任务已进入执行流程。";
  }
  if (lower.startsWith("opening ")) {
    return "正在打开目标页面。";
  }
  if (lower.includes("login page") && lower.includes("visible")) {
    return "检测到登录页面，系统会在发布或自动化任务中发起登录流程。";
  }
  if (lower.includes("login prompt") && lower.includes("visible")) {
    return raw.includes("自动流程未能确认登录完成")
      ? "自动流程未能确认登录完成：检测到平台登录提示，请在浏览器中完成登录。"
      : "检测到平台登录提示，请在浏览器中完成登录。";
  }
  if (lower.includes("login form") && lower.includes("visible")) {
    return "检测到登录表单，请在浏览器中完成登录。";
  }
  if (lower.includes("redirected to") && (lower.includes("instagram.com") || lower.includes("threads.com"))) {
    return "登录流程发生页面跳转，系统已记录当前页面截图。";
  }
  if (lower.includes("timeout")) {
    return "操作等待超时，请查看截图确认当前页面状态后重试。";
  }
  if (lower.includes("screenshot")) {
    return "系统已记录当前页面截图。";
  }
  let text = raw
    .replace(/screenshot\s*=\s*[^\s;，。]+/gi, "截图已保存")
    .replace(/https?:\/\/[^\s;，。]+/gi, "页面链接")
    .replace(/[A-Za-z]:\\[^\s;，。]+/g, "本地截图")
    .replace(/(?:app_id|state|code|scope|redirect_uri|response_type|logger_id|request_id|enable_fb_login|force_authentication|force_consent)=[^\s;&]+/gi, "")
    .replace(/[?&](?:app_id|state|code|scope|redirect_uri|response_type|logger_id|request_id|enable_fb_login|force_authentication|force_consent)=[^\s;&]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/(?:页面链接\s*){2,}/g, "页面链接")
    .trim();
  if (!text) return fallback;
  if (text.length > 180) text = `${text.slice(0, 180)}...`;
  return text;
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
    threads_publish_open: "打开 Threads 发布页面",
    threads_publish_focus: "聚焦 Threads 发布输入框",
    threads_publish_cleanup: "清理 Threads 发帖弹窗",
    threads_publish_open_after_baseline: "重新打开 Threads 发布页面",
    threads_publish_baseline: "读取 Threads 发布前主页基线",
    threads_publish_baseline_failed: "读取 Threads 发布前主页基线失败",
    threads_publish_media_baseline: "读取 Threads 发布前状态",
    threads_publish_media_baseline_failed: "读取 Threads 发布前状态失败",
    threads_publish_text_input: "输入 Threads 发布文案",
    threads_publish_text_input_retry: "重试输入 Threads 发布文案",
    threads_publish_media_picker: "选择 Threads 媒体文件",
    threads_publish_submit: "提交 Threads 发布",
    threads_publish_submit_dom_failed: "提交 Threads 发布失败",
    threads_publish_profile: "打开 Threads 个人主页",
    threads_publish_profile_open_slow: "Threads 个人主页加载较慢",
    threads_publish_unconfirmed: "Threads 发布结果待确认",
    threads_publish_confirmation_failed: "Threads 发布自动确认失败",
    threads_auto_reply_backfill: "补定位",
    open_login: "登录流程",
    check_login: "登录状态同步",
    publish_post: "发布内容",
    browse_feed: "浏览动态",
    browse_profile: "浏览主页",
    login_wait_timeout: "登录等待超时",
    browser_launch: "启动浏览器",
    profile_lock_cleanup: "清理配置锁",
    profile_lock_cleanup_failed: "清理配置锁失败",
    profile_lock_active: "配置锁占用",
    profile_rebuild_failed: "配置备份失败",
    cookie_import: "导入登录状态",
    cookie_import_failed: "导入登录状态失败",
    live_browser_ready: "监控已启动",
    live_browser_viewport: "同步监控尺寸",
    live_browser_viewport_failed: "同步监控尺寸失败",
    live_browser_error: "监控初始化失败",
    live_browser_unavailable: "监控不可用",
    live_browser_standby: "浏览器待机",
    live_browser_standby_failed: "浏览器待机失败",
    resume_manual_login: "恢复登录检测",
    prepare: "准备执行",
    threads_warmup: "Threads 养号",
    threads_warmup_comment: "养号评论",
    threads_warmup_backfill: "补养号目标",
    threads_like_candidate: "选择点赞目标",
    threads_open_post: "打开帖子",
    threads_read_post: "阅读帖子",
    threads_return_feed: "返回动态",
    threads_auto_reply: "Threads 自动回复",
    threads_auto_reply_skip: "跳过回复",
    threads_auto_reply_backfill: "补回复目标",
    threads_hot_post_auto_reply: "热点自动回复",
    threads_hot_post_reply_skip: "跳过热点回复",
    auto_login_start: "开始自动登录",
    auto_login_continue: "处理登录入口",
    auto_login_find_inputs: "查找登录输入框",
    auto_login_inputs_missing: "未找到输入框",
    auto_login_type_username: "输入账号",
    auto_login_type_password: "输入密码",
    auto_login_type_failed: "自动输入失败",
    auto_login_form_filled: "登录表单已填写",
    auto_login_submit: "提交登录表单",
    login_ready_confirm: "确认登录状态",
    login_verification_required: "需要平台验证",
    login_complete: "登录完成",
    open_login_poll: "轮询登录状态",
    publish_upload: "上传媒体",
    threads_publish_upload: "上传 Threads 媒体",
    publish_next_1: "发布下一步",
    publish_next_2: "发布确认",
    publish_confirm: "确认发布结果",
    threads_publish_confirm: "确认 Threads 发布",
    reply_target: "定位回复目标",
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
  return visiblePersonaDraftPosts(state.personaDraftPosts[String(persona.id)] || []);
}

function personaFavoritePosts(persona = selectedPersona()) {
  if (!persona) return [];
  return state.personaFavoritePosts[String(persona.id)] || [];
}

function personaOverviewDraftCount(persona) {
  return Math.max(0, Number(persona?.counts?.posts || persona?.counts?.drafts || 0));
}

function personaOverviewFavoriteCount(persona) {
  return Math.max(0, Number(persona?.counts?.favorites || 0));
}

function isPublishedPersonaPost(post) {
  return Boolean(String(post?.published_at || post?.publishedAt || "").trim());
}

function visiblePersonaDraftPosts(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((post) => !isPublishedPersonaPost(post));
}

function personaPostSource(persona = selectedPersona()) {
  const key = String(persona?.id || state.selectedPersonaId || "default");
  return state.personaPostSources[key] === "favorites" ? "favorites" : "posts";
}

function setPersonaPostSource(source, persona = selectedPersona()) {
  const key = String(persona?.id || state.selectedPersonaId || "default");
  const next = source === "favorites" ? "favorites" : "posts";
  state.personaPostSources[key] = next;
  state.selectedPersonaPostSource = next;
}

function personaSourcePosts(persona = selectedPersona(), source = personaPostSource(persona)) {
  return source === "favorites" ? personaFavoritePosts(persona) : personaDraftPosts(persona);
}

function setSelectedPersonaPostId(postId = "", { auto = false } = {}) {
  const next = String(postId || "").trim();
  state.selectedPersonaPostId = next;
  state.selectedPersonaPostAuto = Boolean(next && auto);
  return next;
}

function personaPostSelectionKey(persona = selectedPersona(), source = personaPostSource(persona)) {
  const personaId = String(persona?.id || state.selectedPersonaId || "default").trim() || "default";
  const sourceKey = source === "favorites" ? "favorites" : "posts";
  return `${personaId}:${sourceKey}`;
}

function personaSelectedPostIds(persona = selectedPersona(), source = personaPostSource(persona)) {
  return state.personaSelectedPostIds[personaPostSelectionKey(persona, source)] || [];
}

function setPersonaSelectedPostIds(persona = selectedPersona(), source = personaPostSource(persona), ids = []) {
  const key = personaPostSelectionKey(persona, source);
  const clean = Array.from(new Set((ids || []).map((item) => String(item || "").trim()).filter(Boolean)));
  if (clean.length) state.personaSelectedPostIds[key] = clean;
  else delete state.personaSelectedPostIds[key];
  return clean;
}

function syncPersonaSelectedPostIds(persona = selectedPersona(), source = personaPostSource(persona), rows = personaSourcePosts(persona, source)) {
  const valid = new Set((rows || []).map((item) => String(item.id || "").trim()).filter(Boolean));
  const next = personaSelectedPostIds(persona, source).filter((id) => valid.has(id));
  setPersonaSelectedPostIds(persona, source, next);
  return next;
}

function selectedPersonaPost(persona = selectedPersona(), options = {}) {
  const posts = personaSourcePosts(persona);
  const wanted = String(state.selectedPersonaPostId || $("personaDraftPostSelect")?.value || "").trim();
  if (wanted && posts.some((item) => String(item.id) === wanted)) {
    if (options.requireExplicit && state.selectedPersonaPostAuto) return null;
    return posts.find((item) => String(item.id) === wanted) || null;
  }
  if (options.requireExplicit) return null;
  return posts[0] || null;
}

function personaMediaTargetPost(persona = selectedPersona()) {
  if (!persona) return { source: "posts", post: null };
  const draft = personaFormState(persona.id).draft || {};
  const editingPostId = String(draft.editingPostId || "").trim();
  if (editingPostId) {
    const source = draft.editingSource === "favorites" ? "favorites" : "posts";
    const post = personaSourcePosts(persona, source).find((item) => String(item.id) === editingPostId) || null;
    return { source, post };
  }
  const source = personaPostSource(persona);
  return { source, post: selectedPersonaPost(persona) };
}

function personaMediaSelectionKey(personaId, source, postId) {
  return `${String(personaId || "").trim()}:${source === "favorites" ? "favorites" : "posts"}:${String(postId || "").trim()}`;
}

function selectedPersonaMediaIndex(personaId, source, postId, total = 0) {
  const count = Math.max(0, Number(total || 0));
  if (!count) return -1;
  const key = personaMediaSelectionKey(personaId, source, postId);
  const index = Number.parseInt(String(state.personaSelectedMediaIndexes[key] ?? "0"), 10);
  return Math.min(Math.max(Number.isFinite(index) ? index : 0, 0), count - 1);
}

function setSelectedPersonaMediaIndex(personaId, source, postId, index = 0) {
  const key = personaMediaSelectionKey(personaId, source, postId);
  const next = Math.max(0, Number.parseInt(String(index || 0), 10) || 0);
  state.personaSelectedMediaIndexes[key] = next;
  return next;
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
  const title = personaDraftDisplayTitle(post, index, personaSourcePosts());
  const stamp = formatTime(post?.published_at || post?.updated_at || post?.created_at);
  return `${hotMeta ? "[热点] " : ""}${title} · ${stamp}`;
}

function personaDraftDisplayTitle(post, index = 0, rows = []) {
  const title = String(post?.title || "").trim();
  if (/^第\d+篇$/.test(title)) {
    const total = Array.isArray(rows) && rows.length ? rows.length : Math.max(1, Number(index || 0) + 1);
    return `第${Math.max(1, total - Number(index || 0))}篇`;
  }
  return title || `未命名草稿 ${Number(index || 0) + 1}`;
}

function personaDraftDisplayTitleForPost(post, rows = personaSourcePosts(), fallbackIndex = 0) {
  const list = Array.isArray(rows) ? rows : [];
  const postId = String(post?.id || "").trim();
  const index = postId ? list.findIndex((item) => String(item?.id || "").trim() === postId) : -1;
  return personaDraftDisplayTitle(post, index >= 0 ? index : fallbackIndex, list);
}

function personaHiddenPublishHistoryCount(persona = selectedPersona()) {
  if (!persona) return 0;
  return Math.max(0, Number(persona?.counts?.published_hidden || 0));
}

function personaFormState(personaId) {
  const key = String(personaId || "").trim();
  if (!key) {
    return {
      generate: { mode: "ai", composeMode: "tweet", count: storedPersonaGenerateCount(), targetWords: storedPersonaGenerateTargetWords(), contentTimeSlot: "", prompt: "", selectedMemoryIds: [], hotSelectedIds: [], hotPreviewId: "", hotEditingCandidateId: "", hotPrompt: "", hotSearchMode: "strict", hotFreshnessDays: 7, hotDeletedMediaByCandidate: {}, hotEditedContentByCandidate: {}, hotSelectedMediaIndexByCandidate: {}, hotReplacementFilesByCandidate: {}, hotReplacementPoolByCandidate: {}, hotSelectedReplacementPoolIdByCandidate: {} },
      draft: defaultPersonaDraftForm(),
      media: { taskType: "persona_post_image", contentMode: "draft", manualContent: "", prompt: "", imageCount: storedPersonaMediaImageCount(), aspectRatio: "1:1", resolution: "720p", duration: 2, replaceExisting: false },
      images: { prompt: "", aspectRatio: "1:1" },
    };
  }
  if (!state.personaForms[key]) {
    state.personaForms[key] = {
      generate: {
        mode: "ai",
        composeMode: "tweet",
        count: storedPersonaGenerateCount(),
        targetWords: storedPersonaGenerateTargetWords(),
        contentTimeSlot: "",
        prompt: "",
        selectedMemoryIds: [],
        hotSelectedIds: [],
        hotPreviewId: "",
        hotEditingCandidateId: "",
        hotPrompt: "",
        hotSearchMode: "strict",
        hotFreshnessDays: 7,
        hotDeletedMediaByCandidate: {},
        hotEditedContentByCandidate: {},
        hotSelectedMediaIndexByCandidate: {},
        hotReplacementFilesByCandidate: {},
        hotReplacementPoolByCandidate: {},
        hotSelectedReplacementPoolIdByCandidate: {},
      },
      draft: defaultPersonaDraftForm(),
      media: {
        taskType: "persona_post_image",
        operationMode: "replace",
        contentMode: "draft",
        manualContent: "",
        prompt: "",
        imageCount: storedPersonaMediaImageCount(),
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
  const generate = state.personaForms[key].generate;
  if (!generate.hotReplacementFilesByCandidate || typeof generate.hotReplacementFilesByCandidate !== "object") {
    generate.hotReplacementFilesByCandidate = {};
  }
  if (!generate.hotSelectedMediaIndexByCandidate || typeof generate.hotSelectedMediaIndexByCandidate !== "object") {
    generate.hotSelectedMediaIndexByCandidate = {};
  }
  if (!generate.hotReplacementPoolByCandidate || typeof generate.hotReplacementPoolByCandidate !== "object") {
    generate.hotReplacementPoolByCandidate = {};
  }
  if (!generate.hotSelectedReplacementPoolIdByCandidate || typeof generate.hotSelectedReplacementPoolIdByCandidate !== "object") {
    generate.hotSelectedReplacementPoolIdByCandidate = {};
  }
  return state.personaForms[key];
}

function defaultPersonaDraftForm(overrides = {}) {
  return {
    title: "",
    content: "",
    editingPostId: "",
    editingSource: "posts",
    originalTitle: "",
    originalContent: "",
    originalMediaSignature: "",
    mediaItems: [],
    mediaOps: [],
    dirty: false,
    rewriteSourcePostId: "",
    ...overrides,
  };
}

function normalizePersonaDraftForm(form) {
  if (!form || typeof form !== "object") return defaultPersonaDraftForm();
  return defaultPersonaDraftForm(form);
}

function syncPersonaDraftDirty(draft) {
  if (!draft || !String(draft.editingPostId || "").trim()) {
    if (draft) draft.dirty = false;
    return false;
  }
  const mediaOps = Array.isArray(draft.mediaOps) ? draft.mediaOps : [];
  const dirty = String(draft.title || "") !== String(draft.originalTitle || "")
    || String(draft.content || "") !== String(draft.originalContent || "")
    || mediaOps.length > 0;
  draft.dirty = dirty;
  return dirty;
}

function isPersonaDraftDirty(personaId) {
  const form = personaFormState(personaId);
  form.draft = normalizePersonaDraftForm(form.draft);
  const draft = form.draft;
  return Boolean(String(draft.editingPostId || "").trim() && syncPersonaDraftDirty(draft));
}

function personaDraftEditState(personaId) {
  const form = personaFormState(personaId);
  form.draft = normalizePersonaDraftForm(form.draft);
  const draft = form.draft;
  return {
    editing: Boolean(String(draft.editingPostId || "").trim()),
    dirty: Boolean(String(draft.editingPostId || "").trim() && syncPersonaDraftDirty(draft)),
    rewritePending: Boolean(String(draft.rewriteSourcePostId || "").trim()),
  };
}

function currentPersonaDraftEditPersonaId() {
  const ids = [state.renderedPersonaId, state.selectedPersonaId]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return ids.find((id, index) => ids.indexOf(id) === index && (() => {
    const status = personaDraftEditState(id);
    return status.editing || status.rewritePending;
  })()) || "";
}

async function confirmSaveDraftEditBeforeLeave() {
  const action = await openConsoleModal({
    title: "保存当前修改？",
    message: "当前草稿有未保存修改。可以保存修改、放弃本次修改并退出，或返回继续编辑。",
    confirmText: "保存修改",
    cancelText: "返回编辑",
    extraActions: [
      { text: "放弃修改并退出", value: "discard", danger: true },
    ],
  });
  if (action === true) return "save";
  if (action === "discard") return "discard";
  return "cancel";
}

async function canLeavePersonaDraftEdit(personaId, targetStep = "") {
  if (String(state.renderedPersonaId || "") === String(personaId || "")) {
    snapshotPersonaCurrentForm();
  }
  const status = personaDraftEditState(personaId);
  if (status.rewritePending && (targetStep === "media" || targetStep === "generate_media")) {
    showMsg("commandMsg", "当前是 AI 重写新草稿状态，请先生成并选择新草稿后再进入配图。", false);
    return false;
  }
  if (status.dirty) {
    const action = await confirmSaveDraftEditBeforeLeave();
    if (action === "save") createPersonaDraftPost().catch((error) => showMsg("commandMsg", error.detail || error.message || "保存修改失败", false));
    if (action === "discard") {
      discardPersonaDraftEdit(personaId);
      return true;
    }
    return false;
  }
  discardPersonaDraftEdit(personaId);
  return true;
}

async function canLeaveCurrentPersonaDraftEdit(targetStep = "leave") {
  const personaId = currentPersonaDraftEditPersonaId();
  return personaId ? canLeavePersonaDraftEdit(personaId, targetStep) : true;
}

function updatePersonaDraftEditVisualState() {
  const key = String(state.renderedPersonaId || "").trim();
  if (!key || !$("personaDraftTitle") && !$("personaDraftContent")) return;
  const form = personaFormState(key);
  form.draft = normalizePersonaDraftForm(form.draft);
  form.draft.title = String($("personaDraftTitle")?.value || "");
  form.draft.content = String($("personaDraftContent")?.value || "");
  const dirty = syncPersonaDraftDirty(form.draft);
  const panel = document.querySelector(".persona-generate-panel.is-editing-draft");
  const section = document.querySelector(".persona-production-section.is-editing-draft");
  const chip = document.querySelector(".persona-edit-state-chip");
  if (panel) panel.classList.toggle("is-dirty", dirty);
  if (section) section.classList.toggle("is-dirty", dirty);
  if (chip) {
    chip.classList.toggle("is-warning", dirty);
    chip.classList.toggle("is-ready", !dirty);
    chip.textContent = dirty ? "未保存修改" : "编辑中";
  }
}

function persistPersonaHotImports() {
  return state.personaHotImports;
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
      original_content: String(sourceMeta.original_content || "").trim(),
      platform: String(sourceMeta.platform || "").trim() || "threads",
      published_at: sourceMeta.published_at || "",
      captured_at: sourceMeta.captured_at || sourceMeta.published_at || "",
      hot_score: personaHotMetricNumber(sourceMeta.hotScore, sourceMeta.hot_score),
      metrics: sourceMeta.metrics && typeof sourceMeta.metrics === "object" ? sourceMeta.metrics : {},
      engagement: sourceMeta.engagement && typeof sourceMeta.engagement === "object" ? sourceMeta.engagement : {},
      view_count: personaHotViewMetric({ metrics: sourceMeta.metrics, engagement: sourceMeta.engagement }),
      like_count: personaHotMetricNumber(sourceMeta.engagement?.likeCount, sourceMeta.metrics?.like_count, sourceMeta.metrics?.likeCount, sourceMeta.metrics?.likes),
      comment_count: personaHotMetricNumber(sourceMeta.engagement?.commentCount, sourceMeta.metrics?.comment_count, sourceMeta.metrics?.commentCount, sourceMeta.metrics?.comments),
      share_count: personaHotMetricNumber(sourceMeta.metrics?.send_count, sourceMeta.engagement?.sendCount, sourceMeta.metrics?.reshare_count, sourceMeta.metrics?.share_count, sourceMeta.metrics?.shareCount, sourceMeta.metrics?.shares, sourceMeta.engagement?.shareCount),
      repost_count: personaHotMetricNumber(sourceMeta.engagement?.repostCount, sourceMeta.metrics?.repost_count, sourceMeta.metrics?.repostCount, sourceMeta.metrics?.reposts),
      warnings: Array.isArray(sourceMeta.warnings) ? sourceMeta.warnings : [],
      media_items: Array.isArray(sourceMeta.media_items) ? sourceMeta.media_items : [],
    };
  }
  return personaHotImportStore(personaId)[postKey] || null;
}

function personaHotMetricNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function personaHotMetricSummary(candidate) {
  const fields = [
    ["热度", personaHotMetricNumber(candidate?.hot_score, candidate?.hotScore, candidate?.score)],
    ["浏览", personaHotMetricNumber(candidate?.view_count, candidate?.engagement?.viewCount, candidate?.metrics?.view_count, candidate?.metrics?.viewCount, candidate?.metrics?.views)],
    ["点赞", personaHotMetricNumber(candidate?.like_count, candidate?.engagement?.likeCount, candidate?.metrics?.like_count, candidate?.metrics?.likeCount, candidate?.metrics?.likes)],
    ["评论", personaHotMetricNumber(candidate?.comment_count, candidate?.engagement?.commentCount, candidate?.metrics?.comment_count, candidate?.metrics?.commentCount, candidate?.metrics?.comments)],
    ["转发", personaHotMetricNumber(candidate?.repost_count, candidate?.engagement?.repostCount, candidate?.metrics?.repost_count, candidate?.metrics?.repostCount, candidate?.metrics?.reposts)],
    ["分享", personaHotMetricNumber(candidate?.metrics?.send_count, candidate?.engagement?.sendCount, candidate?.share_count, candidate?.metrics?.share_count, candidate?.metrics?.shareCount, candidate?.metrics?.shares, candidate?.engagement?.shareCount)],
  ];
  return fields.map(([label, value]) => `${label} ${numberText(value ?? 0)}`).join(" · ");
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
  const explicitScore = personaHotMetricNumber(row?.hot_score, row?.hotScore, row?.score);
  if (explicitScore !== null) return explicitScore;
  const views = personaHotViewMetric(row) || 0;
  const interactions = (personaHotMetricNumber(row?.like_count, row?.engagement?.likeCount, row?.metrics?.like_count, row?.metrics?.likeCount, row?.metrics?.likes) || 0)
    + (personaHotMetricNumber(row?.comment_count, row?.engagement?.commentCount, row?.metrics?.comment_count, row?.metrics?.commentCount, row?.metrics?.comments) || 0)
    + (personaHotMetricNumber(row?.repost_count, row?.engagement?.repostCount, row?.metrics?.repost_count, row?.metrics?.repostCount, row?.metrics?.reposts) || 0)
    + (personaHotMetricNumber(row?.metrics?.send_count, row?.engagement?.sendCount, row?.metrics?.reshare_count, row?.send_count, row?.share_count, row?.metrics?.share_count, row?.metrics?.shareCount, row?.metrics?.shares, row?.engagement?.shareCount) || 0);
  return Math.max(views, interactions);
}

function personaHotMetricNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function personaHotViewMetric(candidate) {
  return personaHotMetricNumber(
    candidate?.view_count,
    candidate?.viewCount,
    candidate?.views,
    candidate?.play_count,
    candidate?.playCount,
    candidate?.engagement?.viewCount,
    candidate?.engagement?.views,
    candidate?.engagement?.playCount,
    candidate?.metrics?.view_count,
    candidate?.metrics?.viewCount,
    candidate?.metrics?.views,
    candidate?.metrics?.play_count,
    candidate?.metrics?.playCount,
  );
}

function personaHotMetricSummary(candidate) {
  const fields = [
    ["热度", personaHotMetricNumber(candidate?.hot_score, candidate?.hotScore, candidate?.score)],
    ["浏览", personaHotViewMetric(candidate)],
    ["点赞", personaHotMetricNumber(candidate?.like_count, candidate?.engagement?.likeCount, candidate?.metrics?.like_count, candidate?.metrics?.likeCount, candidate?.metrics?.likes)],
    ["评论", personaHotMetricNumber(candidate?.comment_count, candidate?.engagement?.commentCount, candidate?.metrics?.comment_count, candidate?.metrics?.commentCount, candidate?.metrics?.comments)],
    ["转发", personaHotMetricNumber(candidate?.repost_count, candidate?.engagement?.repostCount, candidate?.metrics?.repost_count, candidate?.metrics?.repostCount, candidate?.metrics?.reposts)],
    ["分享", personaHotMetricNumber(candidate?.metrics?.send_count, candidate?.engagement?.sendCount, candidate?.metrics?.reshare_count, candidate?.send_count, candidate?.share_count, candidate?.metrics?.share_count, candidate?.metrics?.shareCount, candidate?.metrics?.shares, candidate?.engagement?.shareCount)],
  ];
  return fields.map(([label, value]) => `${label} ${value === null ? "未获取" : numberText(value)}`).join(" · ");
}

function normalizePersonaHotSearchMode(value) {
  return String(value || "").trim() === "normal" ? "normal" : "strict";
}

function personaHotSearchModeLabel(value) {
  return normalizePersonaHotSearchMode(value) === "normal" ? "普通" : "严格";
}

function normalizePersonaHotFreshnessDays(value) {
  const days = Math.round(Number(value));
  return Number.isFinite(days) ? Math.min(15, Math.max(0, days)) : 0;
}

function personaHotFreshnessLabel(value) {
  const days = normalizePersonaHotFreshnessDays(value);
  return days > 0 ? `${days} 天内` : "不限时间";
}

function personaHotCandidates(persona = selectedPersona()) {
  const personaKey = String(persona?.id || "").trim();
  const fetchedRows = state.personaHotCandidateResults[personaKey]?.candidates;
  const rows = Array.isArray(fetchedRows) ? fetchedRows : [];
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
      hot_score: personaHotMetricNumber(row.hot_score, row.hotScore),
      warnings: Array.isArray(row.warnings) ? row.warnings : [],
      keywords: Array.isArray(row.keywords) ? row.keywords : [],
      metrics: row.metrics && typeof row.metrics === "object" ? row.metrics : {},
      engagement: row.engagement && typeof row.engagement === "object" ? row.engagement : {},
      view_count: personaHotViewMetric(row),
      like_count: personaHotMetricNumber(row.like_count, row.engagement?.likeCount, row.metrics?.like_count, row.metrics?.likeCount, row.metrics?.likes),
      comment_count: personaHotMetricNumber(row.comment_count, row.engagement?.commentCount, row.metrics?.comment_count, row.metrics?.commentCount, row.metrics?.comments),
      share_count: personaHotMetricNumber(row.metrics?.send_count, row.engagement?.sendCount, row.metrics?.reshare_count, row.send_count, row.share_count, row.metrics?.share_count, row.metrics?.shareCount, row.metrics?.shares, row.engagement?.shareCount),
      repost_count: personaHotMetricNumber(row.repost_count, row.engagement?.repostCount, row.metrics?.repost_count, row.metrics?.repostCount, row.metrics?.reposts),
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
    hot_score: personaHotMetricNumber(candidate?.hot_score, candidate?.score),
    metrics: candidate?.metrics && typeof candidate.metrics === "object" ? candidate.metrics : {},
    engagement: candidate?.engagement && typeof candidate.engagement === "object" ? candidate.engagement : {},
    view_count: personaHotMetricNumber(candidate?.view_count),
    like_count: personaHotMetricNumber(candidate?.like_count),
    comment_count: personaHotMetricNumber(candidate?.comment_count),
    share_count: personaHotMetricNumber(candidate?.share_count),
    repost_count: personaHotMetricNumber(candidate?.repost_count),
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

function personaHotCandidateMediaSignature(candidate) {
  return JSON.stringify(personaHotCandidateMediaItems(candidate).map((item) => [
    String(item.url || item.previewUrl || "").trim(),
    String(item.type || "").trim(),
  ]));
}

function reconcilePersonaHotMediaStateAfterRefresh(personaId, previousCandidates = [], nextCandidates = []) {
  const form = personaFormState(personaId).generate;
  const previousById = new Map((previousCandidates || []).map((candidate) => [personaHotCandidateKey(candidate), candidate]));
  (nextCandidates || []).forEach((candidate) => {
    const candidateId = personaHotCandidateKey(candidate);
    const previous = previousById.get(candidateId);
    if (!candidateId || !previous) return;
    const mediaItems = personaHotCandidateMediaItems(candidate);
    if (personaHotCandidateMediaSignature(previous) !== personaHotCandidateMediaSignature(candidate)) {
      delete form.hotDeletedMediaByCandidate?.[candidateId];
      delete form.hotSelectedMediaIndexByCandidate?.[candidateId];
      clearPersonaHotReplacementFiles(personaId, candidateId);
      clearPersonaHotReplacementPool(personaId, candidateId);
      return;
    }
    const mediaCount = mediaItems.length;
    const deleted = personaHotDeletedMediaSet(personaId, candidateId);
    setPersonaHotDeletedMediaSet(personaId, candidateId, new Set([...deleted].filter((index) => index < mediaCount)));
    personaHotReplacementEntries(personaId, candidateId).forEach((entry) => {
      if (entry.index >= mediaCount) setPersonaHotReplacementFile(personaId, candidateId, entry.index, null);
    });
    if (!mediaCount) delete form.hotSelectedMediaIndexByCandidate?.[candidateId];
    else if (Object.prototype.hasOwnProperty.call(form.hotSelectedMediaIndexByCandidate || {}, candidateId)) {
      form.hotSelectedMediaIndexByCandidate[candidateId] = Math.min(
        Math.max(Number(form.hotSelectedMediaIndexByCandidate[candidateId]) || 0, 0),
        mediaCount - 1,
      );
    }
  });
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
  state.transientWorkspaceLeaveAcknowledgement = "";
}

function personaHotSelectedMediaIndex(personaId, candidateId, mediaCount = 0) {
  const form = personaFormState(personaId).generate;
  const key = String(candidateId || "").trim();
  const count = Math.max(0, Number(mediaCount || 0));
  const requested = Number(form.hotSelectedMediaIndexByCandidate?.[key]);
  if (!count) return -1;
  return Number.isInteger(requested) ? Math.min(Math.max(requested, 0), count - 1) : 0;
}

function setPersonaHotSelectedMediaIndex(personaId, candidateId, index) {
  const form = personaFormState(personaId).generate;
  if (!form.hotSelectedMediaIndexByCandidate || typeof form.hotSelectedMediaIndexByCandidate !== "object") {
    form.hotSelectedMediaIndexByCandidate = {};
  }
  const key = String(candidateId || "").trim();
  const nextIndex = Number(index);
  if (!key || !Number.isInteger(nextIndex) || nextIndex < 0) return;
  form.hotSelectedMediaIndexByCandidate[key] = nextIndex;
}

function personaHotReplacementEntries(personaId, candidateId) {
  const form = personaFormState(personaId).generate;
  const key = String(candidateId || "").trim();
  const stored = form.hotReplacementFilesByCandidate?.[key];
  if (!stored || typeof stored !== "object") return [];
  const entries = Array.isArray(stored)
    ? stored.map((file, index) => [index, file])
    : Object.entries(stored);
  return entries.map(([rawIndex, value]) => {
    const index = Number(rawIndex);
    const file = value?.file || value;
    if (!Number.isInteger(index) || index < 0 || !file) return null;
    return {
      index,
      file,
      previewUrl: String(value?.previewUrl || "").trim(),
    };
  }).filter(Boolean).sort((left, right) => left.index - right.index);
}

function setPersonaHotReplacementFile(personaId, candidateId, index, file = null) {
  const form = personaFormState(personaId).generate;
  if (!form.hotReplacementFilesByCandidate || typeof form.hotReplacementFilesByCandidate !== "object") {
    form.hotReplacementFilesByCandidate = {};
  }
  const key = String(candidateId || "").trim();
  const mediaIndex = Number(index);
  if (!key || !Number.isInteger(mediaIndex) || mediaIndex < 0) return;
  const current = form.hotReplacementFilesByCandidate[key];
  const replacements = current && !Array.isArray(current) && typeof current === "object" ? current : {};
  const previous = replacements[mediaIndex];
  if (previous?.previewUrl) URL.revokeObjectURL(previous.previewUrl);
  if (file) {
    replacements[mediaIndex] = { file, previewUrl: URL.createObjectURL(file) };
    form.hotReplacementFilesByCandidate[key] = replacements;
  } else {
    delete replacements[mediaIndex];
    if (Object.keys(replacements).length) form.hotReplacementFilesByCandidate[key] = replacements;
    else delete form.hotReplacementFilesByCandidate[key];
  }
  state.transientWorkspaceLeaveAcknowledgement = "";
}

function clearPersonaHotReplacementFiles(personaId, candidateId) {
  personaHotReplacementEntries(personaId, candidateId).forEach((entry) => {
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  });
  const form = personaFormState(personaId).generate;
  delete form.hotReplacementFilesByCandidate?.[String(candidateId || "").trim()];
}

function personaHotReplacementPool(personaId, candidateId) {
  const form = personaFormState(personaId).generate;
  const key = String(candidateId || "").trim();
  const rows = form.hotReplacementPoolByCandidate?.[key];
  return Array.isArray(rows) ? rows.filter((entry) => entry?.id && entry?.file) : [];
}

function personaHotSelectedReplacementPoolEntry(personaId, candidateId) {
  const form = personaFormState(personaId).generate;
  const key = String(candidateId || "").trim();
  const selectedId = String(form.hotSelectedReplacementPoolIdByCandidate?.[key] || "").trim();
  return personaHotReplacementPool(personaId, key).find((entry) => String(entry.id) === selectedId) || null;
}

function setPersonaHotSelectedReplacementPoolId(personaId, candidateId, entryId = "") {
  const form = personaFormState(personaId).generate;
  if (!form.hotSelectedReplacementPoolIdByCandidate || typeof form.hotSelectedReplacementPoolIdByCandidate !== "object") {
    form.hotSelectedReplacementPoolIdByCandidate = {};
  }
  const key = String(candidateId || "").trim();
  const cleanEntryId = String(entryId || "").trim();
  if (!key) return;
  if (cleanEntryId) form.hotSelectedReplacementPoolIdByCandidate[key] = cleanEntryId;
  else delete form.hotSelectedReplacementPoolIdByCandidate?.[key];
}

function addPersonaHotReplacementPoolFiles(personaId, candidateId, files = []) {
  const form = personaFormState(personaId).generate;
  if (!form.hotReplacementPoolByCandidate || typeof form.hotReplacementPoolByCandidate !== "object") {
    form.hotReplacementPoolByCandidate = {};
  }
  const key = String(candidateId || "").trim();
  if (!key) return [];
  const current = personaHotReplacementPool(personaId, key);
  const signatures = new Set(current.map((entry) => `${entry.file.name}:${entry.file.size}:${entry.file.lastModified}`));
  const added = Array.from(files || []).filter((file) => {
    const kind = fileKind(file);
    return file && (kind === "image" || kind === "video");
  }).filter((file) => {
    const signature = `${file.name}:${file.size}:${file.lastModified}`;
    if (signatures.has(signature)) return false;
    signatures.add(signature);
    return true;
  }).map((file, index) => ({
    id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 9)}`,
    file,
    previewUrl: URL.createObjectURL(file),
  }));
  if (!added.length) return [];
  form.hotReplacementPoolByCandidate[key] = [...current, ...added];
  setPersonaHotSelectedReplacementPoolId(personaId, key, added[0].id);
  state.transientWorkspaceLeaveAcknowledgement = "";
  return added;
}

function removePersonaHotReplacementPoolEntry(personaId, candidateId, entryId) {
  const form = personaFormState(personaId).generate;
  const key = String(candidateId || "").trim();
  const cleanEntryId = String(entryId || "").trim();
  const rows = personaHotReplacementPool(personaId, key);
  const removed = rows.find((entry) => String(entry.id) === cleanEntryId);
  if (removed?.file) {
    personaHotReplacementEntries(personaId, key)
      .filter((entry) => entry.file === removed.file)
      .forEach((entry) => setPersonaHotReplacementFile(personaId, key, entry.index, null));
  }
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  const nextRows = rows.filter((entry) => String(entry.id) !== cleanEntryId);
  if (nextRows.length) form.hotReplacementPoolByCandidate[key] = nextRows;
  else delete form.hotReplacementPoolByCandidate?.[key];
  if (String(form.hotSelectedReplacementPoolIdByCandidate?.[key] || "") === cleanEntryId) {
    setPersonaHotSelectedReplacementPoolId(personaId, key, nextRows[0]?.id || "");
  }
  state.transientWorkspaceLeaveAcknowledgement = "";
}

function clearPersonaHotReplacementPool(personaId, candidateId) {
  personaHotReplacementPool(personaId, candidateId).forEach((entry) => {
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  });
  const form = personaFormState(personaId).generate;
  const key = String(candidateId || "").trim();
  delete form.hotReplacementPoolByCandidate?.[key];
  delete form.hotSelectedReplacementPoolIdByCandidate?.[key];
}

function discardPersonaHotMediaEdits(personaId) {
  const form = personaFormState(personaId).generate;
  const candidateIds = new Set([
    ...Object.keys(form.hotDeletedMediaByCandidate || {}),
    ...Object.keys(form.hotReplacementFilesByCandidate || {}),
    ...Object.keys(form.hotReplacementPoolByCandidate || {}),
    ...Object.keys(form.hotSelectedMediaIndexByCandidate || {}),
    ...Object.keys(form.hotSelectedReplacementPoolIdByCandidate || {}),
  ]);
  candidateIds.forEach((candidateId) => {
    clearPersonaHotReplacementFiles(personaId, candidateId);
    clearPersonaHotReplacementPool(personaId, candidateId);
  });
  form.hotDeletedMediaByCandidate = {};
  form.hotSelectedMediaIndexByCandidate = {};
  form.hotReplacementFilesByCandidate = {};
  form.hotReplacementPoolByCandidate = {};
  form.hotSelectedReplacementPoolIdByCandidate = {};
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
  if (String(form.hotEditingCandidateId || "").trim() !== key) return;
  if (!form.hotEditedContentByCandidate || typeof form.hotEditedContentByCandidate !== "object") {
    form.hotEditedContentByCandidate = {};
  }
  const content = String(textarea.value || "");
  if (String(form.hotEditedContentByCandidate[key] || "") !== content) {
    state.transientWorkspaceLeaveAcknowledgement = "";
  }
  form.hotEditedContentByCandidate[key] = content;
}

function startPersonaHotCandidateEdit(persona, candidateId) {
  const cleanCandidateId = String(candidateId || "").trim();
  const candidate = personaHotCandidates(persona).find((item) => personaHotCandidateKey(item) === cleanCandidateId);
  if (!persona || !candidate) return;
  const form = personaFormState(persona.id).generate;
  if (!form.hotEditedContentByCandidate || typeof form.hotEditedContentByCandidate !== "object") {
    form.hotEditedContentByCandidate = {};
  }
  if (!Object.prototype.hasOwnProperty.call(form.hotEditedContentByCandidate, cleanCandidateId)) {
    form.hotEditedContentByCandidate[cleanCandidateId] = String(candidate.full_content || candidate.content || "");
  }
  form.hotEditingCandidateId = cleanCandidateId;
  form.hotPreviewId = cleanCandidateId;
  renderPersonaDetail();
  window.requestAnimationFrame(() => $("personaHotPreviewContent")?.focus());
}

function cancelPersonaHotCandidateEdit(persona, candidateId) {
  const cleanCandidateId = String(candidateId || "").trim();
  if (!persona || !cleanCandidateId) return;
  const form = personaFormState(persona.id).generate;
  delete form.hotEditedContentByCandidate?.[cleanCandidateId];
  delete form.hotDeletedMediaByCandidate?.[cleanCandidateId];
  delete form.hotSelectedMediaIndexByCandidate?.[cleanCandidateId];
  clearPersonaHotReplacementFiles(persona.id, cleanCandidateId);
  clearPersonaHotReplacementPool(persona.id, cleanCandidateId);
  if (String(form.hotEditingCandidateId || "").trim() === cleanCandidateId) form.hotEditingCandidateId = "";
  state.transientWorkspaceLeaveAcknowledgement = "";
  renderPersonaDetail();
  renderConfirmSummary();
}

function renderPersonaHotMediaPreview(persona, candidate, { editing = false } = {}) {
  const mediaItems = personaHotCandidateMediaItems(candidate);
  if (!mediaItems.length) return `<div class="empty-state">当前热点候选没有媒体。</div>`;
  const candidateId = personaHotCandidateKey(candidate);
  const deleted = personaHotDeletedMediaSet(persona?.id, candidateId);
  const replacements = new Map(personaHotReplacementEntries(persona?.id, candidateId).map((entry) => [entry.index, entry]));
  const displayItems = mediaItems.map((item, index) => {
    const replacement = replacements.get(index);
    if (!replacement?.previewUrl) return item;
    return {
      previewUrl: replacement.previewUrl,
      url: replacement.previewUrl,
      type: guessMediaType(replacement.file?.name || "", replacement.file?.type || ""),
      label: replacement.file?.name || `替换媒体 ${index + 1}`,
      pending: true,
    };
  });
  const previewRows = displayItems
    .map((item, sourceIndex) => ({ item, sourceIndex }))
    .filter(({ item, sourceIndex }) => !deleted.has(sourceIndex) && item?.previewUrl && !item?.unavailable);
  const previewGroupId = registerMediaPreviewGroup(previewRows.map(({ item }) => item));
  const previewIndexBySource = new Map(previewRows.map(({ sourceIndex }, previewIndex) => [sourceIndex, previewIndex]));
  const selectedIndex = personaHotSelectedMediaIndex(persona?.id, candidateId, mediaItems.length);
  return `
    <div class="persona-media-grid persona-hot-media-grid" aria-label="热点媒体编辑">
      ${displayItems.map((item, index) => {
        const isDeleted = deleted.has(index);
        const isSelected = editing && index === selectedIndex;
        const replacement = replacements.get(index);
        const previewIndex = previewIndexBySource.get(index);
        return `
          <div
            class="persona-hot-media-item ${isSelected ? "is-selected" : ""} ${isDeleted ? "is-deleted" : ""} ${replacement ? "has-replacement" : ""}"
            ${editing ? `data-persona-hot-media-select="${esc(candidateId)}"` : ""}
            data-persona-hot-media-index="${esc(index)}"
          >
            ${item.unavailable || !item.previewUrl
              ? `<div class="persona-media-card is-static is-unavailable">
                  <div class="persona-media-frame persona-media-frame--empty">
                    <strong>媒体不可预览</strong>
                    <small>${esc(item.reason || "原始文件已失效")}</small>
                  </div>
                  <span>${esc(mediaKindLabel(item.type))}</span>
                </div>`
              : renderMediaPreviewButton(item, "", index, {
                  className: "persona-media-card",
                  frameClass: "persona-media-frame",
                  caption: `${mediaKindLabel(item.type)} ${index + 1}`,
                  interactive: false,
                })}
            <div class="persona-hot-media-actions">
              ${!isDeleted && previewGroupId && Number.isInteger(previewIndex) ? `<button
                type="button"
                class="persona-hot-media-action is-view"
                data-media-preview-group="${esc(previewGroupId)}"
                data-media-preview-index="${esc(previewIndex)}"
                title="查看媒体"
                aria-label="查看第 ${index + 1} 个媒体"
              >${renderEyeIcon()}</button>` : ""}
              ${editing && !isDeleted ? `<button
                type="button"
                class="persona-hot-media-action is-replace"
                data-persona-hot-media-replace="${esc(candidateId)}"
                data-persona-hot-media-index="${esc(index)}"
                title="替换媒体"
                aria-label="替换第 ${index + 1} 个媒体"
              >${renderReplaceIcon()}</button>` : ""}
              ${editing ? `<button
                type="button"
                class="persona-hot-media-action ${isDeleted ? "is-restore" : "is-remove"}"
                data-persona-hot-media-toggle="${esc(candidateId)}"
                data-persona-hot-media-index="${esc(index)}"
                title="${isDeleted ? "恢复媒体" : "删除媒体"}"
                aria-label="${isDeleted ? `恢复第 ${index + 1} 个媒体` : `删除第 ${index + 1} 个媒体`}"
              >${isDeleted ? renderUndoIcon() : renderTrashIcon()}</button>` : ""}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderPersonaHotOrigin(meta, { compact = false } = {}) {
  if (!meta) return "";
  const mediaItems = personaHotCandidateMediaItems(meta);
  if (compact) {
    return `<span class="persona-hot-origin-badge persona-hot-origin-badge--compact">热点导入</span>`;
  }
  return `
    <div class="persona-hot-origin">
      <div class="persona-hot-origin-head">
        <span class="persona-hot-origin-badge">热点导入</span>
        ${renderMediaTypeBadge(mediaItems)}
        <small>${esc((meta.platform || "threads").toUpperCase())}${meta.captured_at ? ` · ${esc(formatTime(meta.captured_at))}` : ""}</small>
      </div>
      <p>${esc(meta.source_summary || "该草稿来自已抓取热点内容。")}</p>
      <div class="persona-hot-origin-meta">
        <small>${esc(personaHotMetricSummary(meta))}</small>
        ${meta.source_url ? `<a href="${esc(meta.source_url)}" target="_blank" rel="noopener">查看原帖</a>` : ""}
      </div>
    </div>
  `;
}

function renderPersonaHotMetricStrip(meta, postId = "") {
  if (!meta) return "";
  const metrics = [
    ["热度", meta.hot_score],
    ["浏览", meta.view_count],
    ["点赞", meta.like_count],
    ["评论", meta.comment_count],
    ["转发", meta.repost_count],
    ["分享", meta.share_count],
  ];
  return `
    <div class="persona-hot-metric-strip">
      <div class="persona-hot-metric-values">
        ${metrics.map(([label, value]) => `<span><small>${esc(label)}</small><strong>${esc(numberText(value ?? 0))}</strong></span>`).join("")}
      </div>
      <button type="button" class="persona-hot-refresh-button" data-persona-refresh-hot-post="${esc(postId)}" title="刷新热点数据" aria-label="刷新热点数据">
        ${renderRefreshIcon()}
      </button>
    </div>`;
}

function renderPersonaHotInfo(meta, postId = "") {
  if (!meta) return "";
  const tooltip = [
    `平台：${String(meta.platform || "threads").toUpperCase()}`,
    meta.published_at ? `发布时间：${formatTime(meta.published_at)}` : "",
    meta.captured_at ? `抓取时间：${formatTime(meta.captured_at)}` : "",
    `热点数据：${personaHotMetricSummary(meta)}`,
  ].filter(Boolean).join("\n");
  return `
    <span class="persona-hot-list-tools">
      <span class="persona-hot-info" tabindex="0" aria-label="查看热点数据提示">
        ${renderInfoIcon()}
        <span class="persona-hot-info-tooltip" role="tooltip">${esc(tooltip)}</span>
      </span>
      <button type="button" class="persona-hot-refresh-button" data-persona-refresh-hot-post="${esc(postId)}" title="刷新热点数据" aria-label="刷新热点数据">
        ${renderRefreshIcon()}
      </button>
    </span>`;
}

function renderPersonaHotDetail(meta) {
  if (!meta) return "";
  const warnings = Array.isArray(meta.warnings) ? meta.warnings.filter(Boolean) : [];
  return `
    <div class="persona-hot-detail">
      ${renderPersonaHotOrigin(meta)}
      ${meta.original_content ? `<div class="persona-hot-detail-block"><strong>热点原文</strong><p>${esc(meta.original_content)}</p></div>` : ""}
      ${warnings.length ? `<div class="persona-hot-detail-block"><strong>抓取提示</strong><p>${esc(warnings.join("\n"))}</p></div>` : ""}
    </div>`;
}

function personaPostFavoriteMatchId(post = {}) {
  return String(
    post.source_post_id
    || post.sourcePostId
    || post.original_post_id
    || post.originalPostId
    || post.post_id
    || post.postId
    || post.id
    || ""
  ).trim();
}

function isPersonaPostFavorited(persona, post = {}, source = personaPostSource(persona)) {
  if (source === "favorites") return true;
  const currentId = personaPostFavoriteMatchId(post);
  if (!currentId) return false;
  return personaFavoritePosts(persona).some((favorite) => personaPostFavoriteMatchId(favorite) === currentId);
}

function personaFavoriteRecordForPost(persona, post = {}) {
  const currentId = personaPostFavoriteMatchId(post);
  if (!currentId) return null;
  return personaFavoritePosts(persona).find((favorite) => personaPostFavoriteMatchId(favorite) === currentId) || null;
}

function snapshotPersonaCurrentForm() {
  const key = String(state.renderedPersonaId || "").trim();
  if (!key) return;
  const form = personaFormState(key);
  if ($("personaGenerateMode")) form.generate.mode = String($("personaGenerateMode")?.value || "ai");
  if ($("personaGenerateTimeSlot")) form.generate.contentTimeSlot = String($("personaGenerateTimeSlot")?.value || "");
  if ($("personaGenerateCount")) form.generate.count = Math.min(Math.max(Number.parseInt(String($("personaGenerateCount")?.value || ""), 10) || storedPersonaGenerateCount(), 1), 20);
  if ($("personaGenerateTargetWords")) form.generate.targetWords = Math.min(Math.max(Number.parseInt(String($("personaGenerateTargetWords")?.value || ""), 10) || storedPersonaGenerateTargetWords(), 10), 2000);
  if ($("personaGeneratePrompt")) form.generate.prompt = String($("personaGeneratePrompt")?.value || "");
  if (document.querySelector("[data-persona-memory-id]")) {
    form.generate.selectedMemoryIds = [...document.querySelectorAll("[data-persona-memory-id]:checked")]
      .map((node) => node.getAttribute("data-persona-memory-id") || "")
      .filter(Boolean);
  }
  form.draft = normalizePersonaDraftForm(form.draft);
  if ($("personaDraftTitle")) form.draft.title = String($("personaDraftTitle")?.value || "");
  if ($("personaDraftContent")) form.draft.content = String($("personaDraftContent")?.value || "");
  syncPersonaDraftDirty(form.draft);
  if ($("personaMediaManualContent")) form.media.manualContent = String($("personaMediaManualContent")?.value || "");
  if ($("personaMediaTaskPrompt")) form.media.prompt = String($("personaMediaTaskPrompt")?.value || "");
  if ($("personaMediaAspectRatio")) form.media.aspectRatio = String($("personaMediaAspectRatio")?.value || "1:1");
  if ($("personaMediaImageCount")) form.media.imageCount = Math.min(Math.max(Number.parseInt(String($("personaMediaImageCount")?.value || ""), 10) || storedPersonaMediaImageCount(), 1), 8);
  if ($("personaMediaResolution")) form.media.resolution = String($("personaMediaResolution")?.value || "720p");
  if ($("personaMediaDuration")) form.media.duration = Number($("personaMediaDuration")?.value || form.media.duration || 2);
  if ($("personaMediaReplaceExisting")) form.media.replaceExisting = Boolean($("personaMediaReplaceExisting")?.checked);
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

function personaAccountHealth(persona) {
  const accounts = personaAccounts(persona).filter(isPublishPlatformAccount);
  if (!accounts.length) return { tone: "unbound", label: "未绑定平台账号" };
  const unavailable = new Set(["disabled", "banned", "blocked", "suspended", "platform_restricted", "unavailable"]);
  const details = accounts.map((account) => `${publishPlatformLabel(account)}：${statusLabel(account.status || "unknown")}`).join("；");
  if (accounts.some((account) => unavailable.has(String(account.status || "").trim().toLowerCase()))) {
    return { tone: "danger", label: `存在不可用平台账号；${details}` };
  }
  if (accounts.every((account) => String(account.status || "").trim().toLowerCase() === "ready")) {
    return { tone: "healthy", label: `所绑定平台账号均正常；${details}` };
  }
  return { tone: "warning", label: `存在异常平台账号；${details}` };
}

function renderPersonaAccountHealthIcon(health) {
  if (health?.tone === "healthy") return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"></circle><path d="m8 12 2.5 2.5L16.5 9"></path></svg>`;
  if (health?.tone === "warning") return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3 2.8 20h18.4L12 3Z"></path><path d="M12 9v4"></path><path d="M12 16.5h.01"></path></svg>`;
  if (health?.tone === "danger") return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"></circle><path d="m9 9 6 6"></path><path d="m15 9-6 6"></path></svg>`;
  return "";
}

function accountForPersona(persona) {
  if (!persona) return null;
  return personaAccounts(persona)[0] || null;
}

function isPublishPlatformAccount(account) {
  const platform = String(account?.platform || "").trim().toLowerCase();
  return platform === "threads" || platform === "instagram";
}

function isReadyPublishAccount(account) {
  return isPublishPlatformAccount(account) && String(account?.status || "").trim().toLowerCase() === "ready";
}

function canSubmitPublishWithAccount(account) {
  return isPublishPlatformAccount(account) && String(account?.status || "").trim().toLowerCase() !== "disabled";
}

function publishPlatformAccountsForPersona(persona) {
  return uniqueAccountOptions(personaAccounts(persona).filter(isPublishPlatformAccount));
}

function preferredPublishAccount(accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  return rows.find((account) => String(account.platform || "").trim().toLowerCase() === "threads")
    || rows.find((account) => String(account.platform || "").trim().toLowerCase() === "instagram")
    || rows[0]
    || null;
}

function publishAccountsForPersona(persona) {
  return uniqueAccountOptions(personaAccounts(persona).filter(isReadyPublishAccount));
}

function publishAccountForPersona(persona) {
  const readyAccounts = publishAccountsForPersona(persona);
  if (readyAccounts.length) return preferredPublishAccount(readyAccounts);
  return preferredPublishAccount(publishPlatformAccountsForPersona(persona));
}

function selectedPublishAccountForPersona(persona) {
  if (!persona) return null;
  const accounts = publishPlatformAccountsForPersona(persona);
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

function publishAccountBlockMessage(account) {
  const status = String(account?.status || "").trim().toLowerCase();
  if (status === "cookie_expired") return "当前发布账号登录已过期，提交发布后系统会自动打开浏览器执行登录流程。";
  if (status === "pending_login") return "当前发布账号还未完成登录，提交发布后系统会自动打开浏览器执行登录流程。";
  if (status === "account_confirmation_required") return "当前发布账号已识别登录资料，但仍需确认关联账号后才能继续。";
  if (status === "need_verification") return "当前发布账号需要验证，提交发布后系统会自动打开浏览器并等待处理。";
  if (status === "disabled") return "当前发布账号已停用，请到账号管理自动化启用或更换账号后再发布。";
  return "当前发布账号将由系统在发布流程中自动检测登录状态。";
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

function actionLockStartedAt(...parts) {
  const value = state.actionLocks[actionLockKey(...parts)];
  return toastTimestampMs(value?.startedAt || value?.started_at || value);
}

function actionTaskStartedAt(task, ...lockParts) {
  return toastTimestampMs(task?.started_at || task?.startedAt || task?.created_at || task?.createdAt)
    || actionLockStartedAt(...lockParts)
    || Date.now();
}

let actionElapsedTimer = 0;
let actionElapsedSyncFrame = 0;

function syncActionElapsedTimers() {
  document.querySelectorAll("[data-action-elapsed]").forEach((node) => {
    const startedAt = toastTimestampMs(node.dataset.actionElapsed);
    const elapsed = formatElapsed(Math.max(0, Date.now() - (startedAt || Date.now())));
    node.textContent = elapsed;
    node.setAttribute("aria-label", `已用时 ${elapsed}`);
  });
  const hasActiveTimer = Boolean(document.querySelector("[data-action-elapsed]"));
  if (!hasActiveTimer && actionElapsedTimer) {
    window.clearInterval(actionElapsedTimer);
    actionElapsedTimer = 0;
  }
  if (hasActiveTimer && !actionElapsedTimer) {
    actionElapsedTimer = window.setInterval(syncActionElapsedTimers, 1000);
  }
}

function scheduleActionElapsedSync() {
  if (actionElapsedSyncFrame) return;
  actionElapsedSyncFrame = window.requestAnimationFrame(() => {
    actionElapsedSyncFrame = 0;
    syncActionElapsedTimers();
  });
}

function renderBusyButtonContent(label, busy, startedAt = 0) {
  if (!busy) return esc(label);
  scheduleActionElapsedSync();
  const resolvedStartedAt = toastTimestampMs(startedAt) || Date.now();
  const elapsed = formatElapsed(Math.max(0, Date.now() - resolvedStartedAt));
  return `<span class="task-button-busy"><svg class="task-button-spinner" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5"></path></svg><span>${esc(label)}</span><time data-action-elapsed="${esc(resolvedStartedAt)}" aria-label="已用时 ${esc(elapsed)}">${esc(elapsed)}</time></span>`;
}

function setActionLocked(parts, locked = true) {
  const key = Array.isArray(parts) ? actionLockKey(...parts) : String(parts || "");
  if (!key) return;
  if (locked) state.actionLocks[key] = { startedAt: Date.now() };
  else delete state.actionLocks[key];
  scheduleActionElapsedSync();
}

function activeTaskStatus(status) {
  return ["queued", "running", "need_manual"].includes(String(status || "").trim());
}

function isUnfinishedTask(task) {
  if (!task || typeof task !== "object") return false;
  return !Number(task.finished_at || task.finishedAt || 0);
}

function activeSocialAutomationTask(task) {
  const status = String(task?.status || "").trim();
  if (["queued", "running"].includes(status)) return true;
  return status === "need_manual" && isUnfinishedTask(task);
}

function socialTaskPayload(task) {
  let payload = task?.payload || task?.payload_json || {};
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload || "{}"); } catch (_) { payload = {}; }
  }
  return payload && typeof payload === "object" ? payload : {};
}

function isRecentFinishedTask(task, maxAgeSeconds = 900) {
  const finishedAt = Number(task?.finished_at || task?.finishedAt || 0);
  if (!finishedAt) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - finishedAt) <= maxAgeSeconds;
}

function shouldRefreshPersonaForPublishTask(task, previousTask) {
  const status = String(task?.status || "").trim();
  if (String(task?.task_type || "").trim() !== "publish_post" || status !== "success") return false;
  const payload = socialTaskPayload(task);
  const personaId = String(task?.persona_id || payload.persona_id || payload.archive_id || "").trim();
  if (!personaId) return false;
  const signature = `${status}:${Number(task?.finished_at || task?.finishedAt || 0)}:${String(task?.updated_at || task?.updatedAt || "")}`;
  const taskId = String(task?.id || "").trim();
  if (taskId && state.socialTaskPersonaRefreshSignatures[taskId] === signature) return false;
  const previousStatus = String(previousTask?.status || "").trim();
  return ["queued", "running", "need_manual"].includes(previousStatus) || !previousTask || isRecentFinishedTask(task);
}

function syncPublishedPostLocalState(task) {
  const payload = socialTaskPayload(task);
  const personaId = String(task?.persona_id || payload.persona_id || payload.archive_id || "").trim();
  const postId = String(payload.archive_post_id || "").trim();
  const source = String(payload.archive_post_source || "posts").trim() === "favorites" ? "favorites" : "posts";
  if (!personaId || !postId || source === "favorites") return;
  const rows = visiblePersonaDraftPosts(state.personaDraftPosts[personaId] || [])
    .filter((post) => String(post.id || "") !== postId);
  state.personaDraftPosts[personaId] = rows;
  syncPersonaSelectedPostIds({ id: personaId }, "posts", rows);
  if (String(state.selectedPersonaPostId || "") === postId) {
    const nextPost = personaDraftPosts({ id: personaId })[0] || personaFavoritePosts({ id: personaId })[0] || null;
    setSelectedPersonaPostId(nextPost?.id || "", { auto: true });
  }
  const selectionKey = publishSelectionKey({ id: personaId }, "posts");
  state.publishSelectedPostIds[selectionKey] = (state.publishSelectedPostIds[selectionKey] || []).filter((id) => String(id) !== postId);
  if (String(state.publishPreviewPostId || "") === postId) state.publishPreviewPostId = "";
}

async function refreshPersonaAfterPublishTasks(tasks = [], previousById = new Map()) {
  const pending = new Map();
  for (const task of tasks) {
    if (!shouldRefreshPersonaForPublishTask(task, previousById.get(String(task?.id || "")))) continue;
    const payload = socialTaskPayload(task);
    const personaId = String(task?.persona_id || payload.persona_id || payload.archive_id || "").trim();
    const source = String(payload.archive_post_source || "posts").trim() === "favorites" ? "favorites" : "posts";
    if (!personaId) continue;
    const taskId = String(task?.id || "").trim();
    if (taskId) {
      state.socialTaskPersonaRefreshSignatures[taskId] = `${String(task?.status || "")}:${Number(task?.finished_at || task?.finishedAt || 0)}:${String(task?.updated_at || task?.updatedAt || "")}`;
    }
    syncPublishedPostLocalState(task);
    pending.set(personaId, source);
  }
  if (!pending.size) return;
  await loadPersonas().catch(() => {});
  await Promise.all(Array.from(pending.entries()).flatMap(([personaId, source]) => [
    loadPersonaDraftPosts(personaId).catch(() => []),
    source === "favorites" ? loadPersonaFavoritePosts(personaId).catch(() => []) : Promise.resolve([]),
    loadPersonaPublishHistory(personaId, { force: true }).catch(() => []),
  ]));
  for (const personaId of pending.keys()) schedulePersonaDetailRender(personaId);
  if (state.view === "accounts" || isPersonaWorkspaceModule() || state.activeModule === "publishing") renderActivePersonaListSurface();
}

function blockingTaskStatus(status) {
  return ["queued", "running"].includes(String(status || "").trim());
}

function toastKindForTaskStatus(status) {
  const normalized = String(status || "").trim();
  if (["success", "failed", "cancelled", "need_manual", "queued", "running", "progress"].includes(normalized)) return normalized;
  return "progress";
}

function socialTaskToastLaneKey(task) {
  if (String(task?.task_type || "").trim() !== "publish_post") return "";
  const personaId = String(task?.persona_id || "").trim();
  const accountId = String(task?.account_id || "").trim();
  if (!personaId && !accountId) return "";
  return `social-task:publish:${personaId || "none"}:${accountId || "none"}`;
}

function socialTaskToastKey(taskId, task = null) {
  const cleanTaskId = String(taskId || "").trim();
  return state.socialTaskToastKeys[cleanTaskId] || socialTaskToastLaneKey(task) || `social-task:${cleanTaskId}`;
}

function socialTaskPromptSuppressed(task) {
  const taskId = String(task?.id || "").trim();
  if (!taskId) return false;
  if (!state.suppressedSocialTaskPromptIds?.has(taskId)) return false;
  if (["success", "failed", "cancelled"].includes(String(task?.status || "").trim())) {
    state.suppressedSocialTaskPromptIds.delete(taskId);
    return false;
  }
  return true;
}

function socialTaskToastTerminal(task) {
  const status = socialTaskPresentationStatus(task);
  // `need_manual` intentionally keeps its backend task open so the live
  // browser can remain available. It is nevertheless terminal for the toast:
  // automatic execution has stopped and the user should not see a running
  // timer indefinitely while deciding whether to take over.
  return ["success", "failed", "cancelled", "need_manual"].includes(status);
}

function clearDeliveredToastStates(toastKey) {
  const prefix = `${String(toastKey || "").trim()}:`;
  if (!prefix || prefix === ":") return;
  Array.from(deliveredToastStateKeys).forEach((stateKey) => {
    if (stateKey.startsWith(prefix)) deliveredToastStateKeys.delete(stateKey);
  });
}

function registerSocialTaskToastBatch(batchKey, tasks = []) {
  const cleanKey = String(batchKey || "").trim();
  const rows = (tasks || []).filter((task) => task?.id);
  if (!cleanKey || !rows.length) return;
  const taskIds = rows.map((task) => String(task.id));
  const previous = state.socialTaskToastBatches[cleanKey] || { taskIds: [], tasks: {} };
  const hasNewTask = taskIds.some((taskId) => !previous.taskIds.includes(taskId));
  const previousBatchFinished = previous.taskIds.length > 0
    && previous.taskIds.every((taskId) => socialTaskToastTerminal(previous.tasks?.[taskId]));
  if (hasNewTask && previousBatchFinished) clearDeliveredToastStates(cleanKey);
  state.socialTaskToastBatches[cleanKey] = {
    taskIds,
    tasks: {
      ...previous.tasks,
      ...Object.fromEntries(rows.map((task) => [String(task.id), previous.tasks?.[String(task.id)] || task])),
    },
  };
  taskIds.forEach((taskId) => { state.socialTaskToastKeys[taskId] = cleanKey; });
}

function resolveSocialTaskToast(task) {
  const incomingId = String(task?.id || "").trim();
  const key = socialTaskToastKey(incomingId, task);
  const batch = state.socialTaskToastBatches[key];
  if (!batch) return { task, key };
  const previousOrdered = batch.taskIds.map((taskId) => batch.tasks[taskId]).filter(Boolean);
  const currentBefore = previousOrdered.find((item) => String(item?.status || "").trim() === "running")
    || previousOrdered.find((item) => !socialTaskToastTerminal(item));
  batch.tasks[incomingId] = { ...(batch.tasks[incomingId] || {}), ...task };
  const ordered = batch.taskIds.map((taskId) => batch.tasks[taskId]).filter(Boolean);
  const incoming = batch.tasks[incomingId];
  const active = ordered.find((item) => String(item?.status || "").trim() === "running")
    || ordered.find((item) => !socialTaskToastTerminal(item));
  const failed = ordered.find((item) => ["failed", "cancelled"].includes(String(item?.status || "").trim()));
  if (String(currentBefore?.id || "") === incomingId && socialTaskToastTerminal(incoming) && active) {
    return { task: incoming, key, nextTask: active, transition: true };
  }
  return { task: active || failed || ordered[ordered.length - 1] || task, key };
}

function registerSocialTaskToastLanes(tasks = []) {
  const lanes = new Map();
  (tasks || []).forEach((task) => {
    const taskId = String(task?.id || "").trim();
    const laneKey = socialTaskToastLaneKey(task);
    if (!taskId || !laneKey) return;
    const mappedKey = state.socialTaskToastKeys[taskId] || "";
    if (!activeSocialAutomationTask(task) && mappedKey !== laneKey) return;
    if (mappedKey && mappedKey !== laneKey) return;
    if (!lanes.has(laneKey)) lanes.set(laneKey, []);
    lanes.get(laneKey).push(task);
  });
  lanes.forEach((rows, laneKey) => {
    rows.sort((left, right) => toastTimestampMs(left?.created_at) - toastTimestampMs(right?.created_at));
    rows.forEach((task, index) => {
      const taskId = String(task?.id || "").trim();
      const accountLabel = String(task?.account_username || task?.account_display_name || task?.account_id || "").trim();
      state.socialTaskToastLabels[taskId] = `${index + 1}/${rows.length} 篇${accountLabel ? ` · ${accountLabel}` : ""}`;
    });
    registerSocialTaskToastBatch(laneKey, rows);
  });
}

function socialTaskToastMessage(task) {
  const typeLabel = statusLabel(task?.task_type || "自动化任务");
  const taskId = String(task?.id || "").trim();
  const accountLabel = String(state.socialTaskToastLabels[taskId] || task?.account_username || task?.account_display_name || task?.account_id || "").trim();
  const suffix = accountLabel ? ` · ${accountLabel}` : "";
  const status = socialTaskPresentationStatus(task);
  if (isFutureScheduledSocialTask(task)) return `${typeLabel}定时等待${suffix} · 计划 ${formatScheduledTime(task.scheduled_at)}`;
  if (status === "success") return `${typeLabel}已完成${suffix}`;
  if (status === "failed") return `${typeLabel}执行失败${suffix}`;
  if (status === "cancelled") return `${typeLabel}已取消${suffix}`;
  if (status === "need_manual") return `${typeLabel}需要人工处理${suffix}`;
  if (status === "running") return `${typeLabel}执行中${suffix}`;
  return `${typeLabel}已排队${suffix}`;
}

function syncSocialTaskToast(task, { force = false } = {}) {
  const incomingTaskId = String(task?.id || "").trim();
  if (!incomingTaskId) return;
  if (socialTaskPromptSuppressed(task)) {
    dismissToastByKey(socialTaskToastKey(incomingTaskId, task), { manual: true });
    return;
  }
  const resolved = resolveSocialTaskToast(task);
  task = resolved.task;
  const taskId = String(task?.id || "").trim();
  const status = socialTaskPresentationStatus(task);
  const previous = state.socialTaskToastStatuses[taskId] || "";
  state.socialTaskToastStatuses[incomingTaskId] = socialTaskPresentationStatus(
    state.socialTaskToastBatches[resolved.key]?.tasks?.[incomingTaskId] || task,
  );
  state.socialTaskToastStatuses[taskId] = status;
  const key = resolved.key;
  const activeTransition = state.socialTaskToastTransitions[key];
  if (!resolved.transition && activeTransition?.until > Date.now()) return;
  const existing = Array.from(ensureToastHost().children).find((item) => item.dataset.toastKey === key);
  const waitingForSchedule = isFutureScheduledSocialTask(task);
  const terminal = socialTaskToastTerminal(task);
  const changedToTerminal = terminal && previous && previous !== status;
  if (!force && !existing && !changedToTerminal) return;
  showToast(socialTaskToastMessage(task), !["failed", "cancelled"].includes(status), {
    key,
    kind: toastKindForTaskStatus(status),
    taskId,
    taskPanel: task?.persona_id ? "persona" : "regular",
    personaId: task?.persona_id || "",
    scheduled: waitingForSchedule,
  });
  if (resolved.transition && resolved.nextTask) {
    if (activeTransition?.timer) window.clearTimeout(activeTransition.timer);
    const until = Date.now() + 1400;
    const timer = window.setTimeout(() => {
      if (state.socialTaskToastTransitions[key]?.timer !== timer) return;
      delete state.socialTaskToastTransitions[key];
      syncSocialTaskToast(resolved.nextTask, { force: true });
    }, 1400);
    state.socialTaskToastTransitions[key] = { until, timer };
  }
  syncSocialTaskToastAutoRefresh();
}

function syncSocialTaskToasts(tasks = []) {
  registerSocialTaskToastLanes(tasks);
  tasks.forEach((task) => syncSocialTaskToast(task, {
    force: Boolean(socialTaskToastLaneKey(task)) && activeSocialAutomationTask(task),
  }));
  syncSocialTaskToastAutoRefresh();
}

function hasActiveSocialTaskToast() {
  return (state.socialTasks || []).some((task) => (
    activeSocialAutomationTask(task)
    && !isFutureScheduledSocialTask(task)
  ));
}

function syncSocialTaskScheduleWake() {
  if (state.socialTaskScheduleWakeTimer) {
    window.clearTimeout(state.socialTaskScheduleWakeTimer);
    state.socialTaskScheduleWakeTimer = 0;
  }
  const nextScheduledAt = (state.socialTasks || [])
    .filter((task) => isFutureScheduledSocialTask(task))
    .map((task) => timeValue(task.scheduled_at))
    .filter((value) => value > Date.now())
    .sort((a, b) => a - b)[0] || 0;
  if (!nextScheduledAt) return;
  const delay = Math.min(Math.max(nextScheduledAt - Date.now() + 1000, 1000), 2_147_000_000);
  state.socialTaskScheduleWakeTimer = window.setTimeout(() => {
    state.socialTaskScheduleWakeTimer = 0;
    loadAutomationTasksShared().catch(() => {});
  }, delay);
}

function syncSocialTaskToastAutoRefresh() {
  if (document.hidden || !hasActiveSocialTaskToast()) {
    if (state.socialTaskToastRefreshTimer) {
      window.clearInterval(state.socialTaskToastRefreshTimer);
      state.socialTaskToastRefreshTimer = 0;
    }
    if (document.hidden && state.socialTaskScheduleWakeTimer) {
      window.clearTimeout(state.socialTaskScheduleWakeTimer);
      state.socialTaskScheduleWakeTimer = 0;
    }
    if (!document.hidden) syncSocialTaskScheduleWake();
    return;
  }
  if (state.socialTaskScheduleWakeTimer) {
    window.clearTimeout(state.socialTaskScheduleWakeTimer);
    state.socialTaskScheduleWakeTimer = 0;
  }
  if (state.socialTaskToastRefreshTimer) return;
  state.socialTaskToastRefreshTimer = window.setInterval(() => {
    if (document.hidden || !hasActiveSocialTaskToast()) {
      syncSocialTaskToastAutoRefresh();
      return;
    }
    loadAutomationTasksShared().catch(() => {});
  }, 3000);
}

function activeSocialTaskFor({ accountId = "", personaId = "", taskType = "", postId = "", postSource = "" } = {}) {
  const cleanAccountId = String(accountId || "").trim();
  const cleanPersonaId = String(personaId || "").trim();
  const cleanTaskType = String(taskType || "").trim();
  const cleanPostId = String(postId || "").trim();
  const cleanPostSource = String(postSource || "").trim();
  return (state.socialTasks || []).find((task) => {
    if (!blockingTaskStatus(task?.status)) return false;
    if (cleanAccountId && String(task?.account_id || "").trim() !== cleanAccountId) return false;
    if (cleanPersonaId && String(task?.persona_id || "").trim() !== cleanPersonaId) return false;
    if (cleanTaskType && String(task?.task_type || "").trim() !== cleanTaskType) return false;
    if (cleanPostId) {
      const payload = task?.payload && typeof task.payload === "object" ? task.payload : {};
      if (String(payload.archive_post_id || "").trim() !== cleanPostId) return false;
      if (cleanPostSource && String(payload.archive_post_source || "posts").trim() !== cleanPostSource) return false;
    }
    return true;
  }) || null;
}

function socialTaskLoginDependency(task) {
  const payload = socialTaskPayload(task);
  const loginTaskId = String(payload.login_task_id || "").trim();
  if (!loginTaskId) return null;
  return (state.socialTasks || []).find((candidate) => String(candidate?.id || "").trim() === loginTaskId) || null;
}

function mergeSocialTaskState(...tasks) {
  const next = Array.isArray(state.socialTasks) ? state.socialTasks.slice() : [];
  tasks.flat().filter((task) => task?.id).forEach((task) => {
    const taskId = String(task.id || "").trim();
    const index = next.findIndex((candidate) => String(candidate?.id || "").trim() === taskId);
    if (index >= 0) next[index] = { ...next[index], ...task };
    else next.unshift(task);
  });
  state.socialTasks = next;
  return next;
}

function socialTaskWaitsForManualLogin(task) {
  if (String(task?.task_type || "").trim() !== "publish_post") return false;
  if (String(task?.status || "").trim() !== "queued") return false;
  return String(socialTaskLoginDependency(task)?.status || "").trim() === "need_manual";
}

function socialTaskPresentationStatus(task) {
  return socialTaskWaitsForManualLogin(task) ? "need_manual" : String(task?.status || "").trim();
}

function personaMediaTaskIsActive(personaId, postId, taskType = "") {
  const taskState = personaMediaTaskState(personaId, postId);
  if (!taskState || !activeTaskStatus(taskState.status)) return false;
  if (!taskType) return true;
  return String(taskState.taskType || taskState.detail?.type || "").trim() === String(taskType || "").trim();
}

function personaMediaTaskStartedAt(personaId, postId, taskType = "") {
  const taskState = personaMediaTaskState(personaId, postId);
  const taskStartedAt = taskState && (!taskType || String(taskState.taskType || taskState.detail?.type || "").trim() === String(taskType || "").trim())
    ? actionTaskStartedAt(taskState.detail || {}, "media_task", personaId, postId, taskType)
    : 0;
  return taskStartedAt || actionLockStartedAt("media_task", personaId, postId, taskType);
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
  const toastKey = socialTaskToastKey(cleanTaskId);
  const result = await api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(cleanTaskId)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "user_cancel" }),
  });
  showMsg(messageId, "自动化任务已发送停止请求。", true, {
    key: toastKey,
    kind: "cancelled",
    taskId: cleanTaskId,
    taskPanel: "persona",
  });
  window.setTimeout(() => dismissToastByKey(toastKey), 4200);
  await loadSocial().catch(() => {});
  return result;
}

async function cancelAllSocialAutomationTasks(messageId = "socialMsg") {
  if (state.socialCancelAllPending) return null;
  state.socialCancelAllPending = true;
  syncSocialCancelAllButtons();
  try {
    const result = await api("/api/persona_dashboard/automation/tasks/cancel_all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "user_cancel_all" }),
    });
    const cancelledCount = Math.max(0, Number(result.cancelled_count || 0));
    showMsg(messageId, cancelledCount ? `已停止 ${cancelledCount} 个自动化任务。` : "当前没有正在运行或排队的自动化任务。", true, {
      key: "social-task:cancel-all",
      kind: "cancelled",
      taskPanel: "persona",
    });
    window.setTimeout(() => dismissToastByKey("social-task:cancel-all"), 4200);
    await Promise.all([
      loadSocial({ force: true }).catch(() => {}),
      loadTasks().catch(() => {}),
    ]);
    return result;
  } finally {
    state.socialCancelAllPending = false;
    syncSocialCancelAllButtons();
  }
}

function taskQueueSet(kind) {
  return kind === "regular" ? state.taskQueueSelectedRegularIds : state.taskQueueSelectedPersonaIds;
}

function taskQueueRowsForKind(kind) {
  if (kind === "regular") return Array.isArray(state.tasks) ? state.tasks : [];
  const persona = selectedPersona();
  return persona ? personaAutomationTasksFor(persona.id) : [];
}

function syncTaskQueueSelection(kind) {
  const set = taskQueueSet(kind);
  const validIds = new Set(taskQueueRowsForKind(kind).map((task) => String(task.id || "")).filter(Boolean));
  Array.from(set).forEach((id) => {
    if (!validIds.has(String(id))) set.delete(id);
  });
}

function taskQueueSelectionSummary(kind) {
  syncTaskQueueSelection(kind);
  const rows = taskQueueRowsForKind(kind);
  const set = taskQueueSet(kind);
  const total = rows.length;
  const selected = Array.from(set).filter((id) => rows.some((task) => String(task.id || "") === String(id))).length;
  return { rows, total, selected, allSelected: total > 0 && selected === total };
}

async function deleteRegularTaskRecord(taskId, messageId = "taskQueueMsg") {
  const cleanTaskId = String(taskId || "").trim();
  if (!cleanTaskId) return null;
  await api(`/api/tasks/${encodeURIComponent(cleanTaskId)}`, { method: "DELETE" });
  state.taskQueueSelectedRegularIds.delete(cleanTaskId);
  showMsg(messageId, "任务记录已删除。", true);
  await loadTasks().catch(() => {});
  return true;
}

async function deleteSocialTaskRecord(taskId, messageId = "taskQueueMsg") {
  const cleanTaskId = String(taskId || "").trim();
  if (!cleanTaskId) return null;
  await api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(cleanTaskId)}`, { method: "DELETE" });
  state.taskQueueSelectedPersonaIds.delete(cleanTaskId);
  showMsg(messageId, "自动化记录已删除。", true);
  await Promise.all([loadSocial().catch(() => {}), loadTasks().catch(() => {})]);
  return true;
}

async function deleteSocialAccountRecord(accountId, messageId = "socialMsg") {
  const cleanAccountId = String(accountId || "").trim();
  if (!cleanAccountId) return null;
  await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(cleanAccountId)}`, { method: "DELETE" });
  showMsg(messageId, "执行账号已删除。", true);
  await loadSocial().catch(() => {});
  renderWorkspace();
  return true;
}

async function dedupeSocialAccountRecords(messageId = "socialMsg") {
  const result = await api("/api/persona_dashboard/automation/accounts/dedupe", { method: "POST" });
  const deletedCount = Number(result.deleted_count || 0);
  const skippedCount = Array.isArray(result.skipped_ids) ? result.skipped_ids.length : 0;
  const suffix = skippedCount ? `，${skippedCount} 条有进行中任务已跳过。` : "。";
  showMsg(messageId, deletedCount ? `已清理 ${deletedCount} 条过期重复账号${suffix}` : `没有可清理的过期重复账号${suffix}`, true);
  await loadSocial().catch(() => {});
  renderWorkspace();
  return result;
}

async function deleteSelectedTaskQueueRecords(kind, messageId = "taskQueueMsg") {
  syncTaskQueueSelection(kind);
  const selectedIds = Array.from(taskQueueSet(kind)).filter(Boolean);
  if (!selectedIds.length) {
    showMsg(messageId, "请先选择要删除的记录。", false);
    return;
  }
  const ok = await confirmDangerAction(`确定删除已选中的 ${selectedIds.length} 条记录吗？删除后不可恢复。`, {
    title: "清空选中记录",
    confirmText: "清空选中",
  });
  if (!ok) return;
  const endpoint = kind === "regular"
    ? (id) => `/api/tasks/${encodeURIComponent(id)}`
    : (id) => `/api/persona_dashboard/automation/tasks/${encodeURIComponent(id)}`;
  const results = await Promise.allSettled(selectedIds.map((id) => api(endpoint(id), { method: "DELETE" })));
  const success = results.filter((item) => item.status === "fulfilled").length;
  const failed = results.length - success;
  const set = taskQueueSet(kind);
  selectedIds.forEach((id, index) => {
    if (results[index]?.status === "fulfilled") set.delete(id);
  });
  await Promise.all([loadTasks().catch(() => {}), kind === "persona" ? loadSocial().catch(() => {}) : Promise.resolve()]);
  showMsg(messageId, failed ? `已删除 ${success} 条，${failed} 条未删除。运行中或排队中的通用任务需要先停止。` : `已删除 ${success} 条记录。`, failed === 0);
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
  if (value === "account_confirmation_required") return 4;
  if (value === "need_verification") return 4;
  if (value === "pending_login") return 3;
  if (value === "cookie_expired") return 2;
  if (value === "transient_error") return 2;
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

function renderPersonaExecutionAccountBadge(persona) {
  const account = accountForPersona(persona);
  const profileName = String(account?.username || account?.account_username || "").trim();
  const handle = String(persona?.threads_account?.handle || "").trim();
  const accountLabel = profileName || handle || "未绑定执行账号";
  const hasExecutionAccount = Boolean(account?.id || profileName || handle);
  const label = `执行账号：${accountLabel}`;
  return `<span class="persona-status-chip ${hasExecutionAccount ? "is-ready" : "is-warning"}">${esc(label)}</span>`;
}

function currentPersonaGroupStep(groupKey, profile) {
  const options = personaGroupStepOptions(groupKey, profile);
  const current = state.personaPanels[groupKey] || personaGroups[groupKey]?.defaultStep || options[0]?.[0] || "";
  if (options.some(([value]) => value === current)) return current;
  return options[0]?.[0] || "";
}

function normalizedPersonaGroupKey(groupKey = state.personaGroup || "settings") {
  return Object.prototype.hasOwnProperty.call(personaGroups, String(groupKey || "").trim()) ? String(groupKey || "").trim() : "settings";
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
  return value || "threads";
}

function personaAutomationAccounts(persona, platform = "") {
  return personaAccounts(persona, platform || selectedPersonaAutomationPlatform());
}

function personaAutomationPlatformOptions(persona) {
  const seen = new Set();
  const rows = [];
  const supported = new Set(["threads", "instagram"]);
  const push = (platform) => {
    const value = String(platform || "").trim().toLowerCase();
    if (!value || !supported.has(value) || seen.has(value)) return;
    seen.add(value);
    rows.push(value);
  };
  push("threads");
  push("instagram");
  personaAccounts(persona).forEach((account) => push(account.platform));
  state.socialAccounts.forEach((account) => push(account.platform));
  return rows;
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

function billingObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

function billingRows(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  const source = billingObject(payload);
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key];
    if (Array.isArray(source.data?.[key])) return source.data[key];
  }
  if (Array.isArray(source.data)) return source.data;
  return [];
}

function billingCurrency(item = {}, root = {}) {
  return String(item.currency || root.currency || "TWD").toUpperCase();
}

function billingMoney(item = {}, root = {}) {
  const cents = item.price_ntd_cents ?? item.amount_ntd_cents ?? item.price_cents ?? item.amount_cents;
  const major = cents != null ? Number(cents) / 100 : Number(item.price_ntd ?? item.amount_ntd ?? item.price ?? item.amount ?? 0);
  const currency = billingCurrency(item, root);
  const symbols = { TWD: "NT$", USD: "US$", CNY: "CN¥", RMB: "CN¥" };
  const amount = Number.isFinite(major) ? major : 0;
  return `${symbols[currency] || `${currency} `}${amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

function billingStatusMeta(status) {
  const clean = String(status || "pending").toLowerCase();
  const labels = {
    pending: "待审批",
    approved: "已生效",
    active: "生效中",
    paid: "已付款",
    rejected: "已驳回",
    cancelled: "已取消",
    canceled: "已取消",
    expired: "已到期",
  };
  const tone = ["approved", "active", "paid"].includes(clean)
    ? "is-success"
    : ["rejected", "cancelled", "canceled", "expired"].includes(clean) ? "is-danger" : "is-warning";
  return { clean, label: labels[clean] || status || "待审批", tone };
}

function billingSummaryData() {
  const source = billingObject(state.billing.summary);
  const summary = billingObject(source.summary || source.data || source);
  const wallet = billingObject(summary.wallet || summary.balance);
  const subscriptions = billingRows(summary, ["subscriptions"]);
  const subscription = billingObject(summary.active_subscription || summary.subscription || subscriptions.find((item) => String(item?.status || "active") === "active") || subscriptions[0]);
  const imageQuota = billingObject(summary.free_images || summary.image_quota || summary.images);
  const imageGrants = billingRows(summary, ["image_grants", "grants"]);
  const imageRemaining = summary.image_remaining
    ?? summary.remaining_images
    ?? imageQuota.total_remaining
    ?? imageQuota.remaining_count
    ?? imageQuota.remaining
    ?? imageGrants.reduce((total, item) => total + Number(item?.remaining_count || item?.remaining || 0), 0);
  const creditPoints = summary.points ?? summary.credit_balance ?? wallet.points ?? wallet.amount ?? ((summary.credit_units ?? wallet.credit_units) != null ? Number(summary.credit_units ?? wallet.credit_units) / 100 : 0);
  const pendingOrders = summary.pending_orders_count
    ?? summary.pending_order_count
    ?? billingRows(state.billing.orders, ["orders", "items", "results"]).filter((item) => String(item?.status || "pending") === "pending").length;
  return { summary, wallet, subscription, imageQuota, imageRemaining, creditPoints, pendingOrders };
}

function renderBillingSummary() {
  const host = $("billingSummary");
  if (!host) return;
  if (state.billing.loading && !state.billing.loaded) {
    host.innerHTML = Array.from({ length: 4 }, () => '<div class="billing-loading">正在读取</div>').join("");
    return;
  }
  const { summary, wallet, subscription, imageQuota, imageRemaining, creditPoints, pendingOrders } = billingSummaryData();
  const subscriptionStatus = Object.keys(subscription).length ? billingStatusMeta(subscription.status || "active") : null;
  const periodEnd = subscription.current_period_end || subscription.period_end || subscription.expires_at;
  const billingMode = summary.billing_mode || wallet.billing_mode;
  const legacyMode = billingMode === "legacy";
  const planName = subscription.plan_name
    || subscription.name
    || subscription.plan_sku
    || (legacyMode ? "存量账号" : (summary.subscription_active ? "已启用" : "暂无订阅"));
  const cards = [
    { label: "算力余额", value: `${numberText(creditPoints)} 点`, note: billingMode === "legacy" ? "旧版计费模式" : "可用算力" },
    { label: "当前订阅", value: planName, note: legacyMode ? "免订阅过渡模式" : (periodEnd ? `有效至 ${formatTime(periodEnd)}` : (subscriptionStatus?.label || (summary.subscription_active ? "生效中" : "尚未生效"))) },
    { label: "图片额度", value: `${numberText(imageRemaining)} 张`, note: imageQuota.monthly_remaining != null ? `月度 ${numberText(imageQuota.monthly_remaining)} · 长期 ${numberText(imageQuota.permanent_remaining)}` : "优先抵扣免费额度" },
    { label: "待审批申请", value: numberText(pendingOrders), note: "等待管理员审批" },
  ];
  host.innerHTML = cards.map((card) => `<article class="billing-summary-card"><span>${esc(card.label)}</span><strong>${esc(card.value)}</strong><small>${esc(card.note)}</small></article>`).join("");
}

function renderPersonalBillingSummary() {
  const host = document.querySelector("[data-site-account-billing]");
  if (!host) return;
  const traditional = currentLanguage() === "zh-Hant";
  const billingCopy = {
    loading: traditional ? "讀取中…" : "读取中…",
    click: traditional ? "點擊查看" : "点击查看",
    ready: traditional ? "已同步" : "已同步",
    partial: traditional ? "部分不可用" : "部分不可用",
  };
  const statusNode = host.querySelector("[data-site-billing-status]");
  const pointsNode = host.querySelector("[data-site-billing-points]");
  const subscriptionNode = host.querySelector("[data-site-billing-subscription]");
  const imagesNode = host.querySelector("[data-site-billing-images]");
  const pendingNode = host.querySelector("[data-site-billing-pending]");
  if (state.billing.loading && !state.billing.loaded) {
    if (statusNode) statusNode.textContent = billingCopy.loading;
    [pointsNode, subscriptionNode, imagesNode, pendingNode].forEach((node) => {
      if (node) node.textContent = "…";
    });
    return;
  }
  if (!state.billing.loaded) {
    if (statusNode) statusNode.textContent = billingCopy.click;
    return;
  }
  const { summary, wallet, subscription, imageRemaining, creditPoints, pendingOrders } = billingSummaryData();
  const billingMode = summary.billing_mode || wallet.billing_mode;
  const planName = subscription.plan_name
    || subscription.name
    || subscription.plan_sku
    || (billingMode === "legacy" ? "存量账号" : (summary.subscription_active ? "已启用" : "暂无订阅"));
  if (statusNode) statusNode.textContent = Object.keys(state.billing.errors || {}).length ? billingCopy.partial : billingCopy.ready;
  if (pointsNode) pointsNode.textContent = `${numberText(creditPoints)} 点`;
  if (subscriptionNode) subscriptionNode.textContent = planName;
  if (imagesNode) imagesNode.textContent = `${numberText(imageRemaining)} 张`;
  if (pendingNode) pendingNode.textContent = numberText(pendingOrders);
}

function renderBillingOrders() {
  const host = $("billingOrders");
  if (!host) return;
  if (state.billing.loading && !state.billing.loaded) {
    host.innerHTML = '<div class="billing-loading">正在加载申请...</div>';
    return;
  }
  const orders = billingRows(state.billing.orders, ["orders", "items", "results"]);
  if (!orders.length) {
    const detail = state.billing.errors.orders?.detail || "暂无方案申请记录。";
    host.innerHTML = `<div class="billing-empty">${esc(detail)}</div>`;
    return;
  }
  host.innerHTML = orders.slice(0, 12).map((order) => {
    const snapshot = billingObject(order.price_snapshot || order.price_snapshot_json);
    const snapshotItem = billingObject(snapshot.item);
    const status = billingStatusMeta(order.status);
    const id = String(order.id || order.order_id || "");
    const cancelable = order.can_cancel === true || status.clean === "pending";
    const busy = state.billing.cancellingOrderId === id;
    return `<article class="billing-order-card">
      <div class="billing-order-head"><div><strong>${esc(snapshotItem.name || snapshot.name || order.name || order.sku || "方案申请")}</strong><div class="billing-order-meta"><span>${esc(id || "-")}</span><span>${esc(formatTime(order.created_at))}</span></div></div><span class="billing-status ${status.tone}">${esc(status.label)}</span></div>
      ${order.payment_reference ? `<p class="billing-order-meta">旧版附加资料：${esc(order.payment_reference)}</p>` : ""}
      <div class="billing-order-foot"><strong>${esc(billingMoney({ amount_ntd_cents: order.amount_ntd_cents ?? order.amount_cents, currency: order.currency }, {}))}</strong>${cancelable ? `<button type="button" class="danger" data-billing-cancel-order="${esc(id)}" ${busy ? "disabled" : ""}>${busy ? "取消中..." : "取消申请"}</button>` : ""}</div>
    </article>`;
  }).join("");
}

function renderBillingLedger() {
  const host = $("billingLedger");
  if (!host) return;
  if (state.billing.loading && !state.billing.loaded) {
    host.innerHTML = '<div class="billing-loading">正在加载流水...</div>';
    return;
  }
  const rows = billingRows(state.billing.ledger, ["ledger", "entries", "items", "results"]);
  if (!rows.length) {
    const detail = state.billing.errors.ledger?.detail || "暂无余额变动记录。";
    host.innerHTML = `<div class="billing-empty">${esc(detail)}</div>`;
    return;
  }
  host.innerHTML = rows.slice(0, 16).map((entry) => {
    const amount = Number(entry.asset_type === "credit" && entry.amount_points != null ? entry.amount_points : (entry.amount_units ?? entry.amount ?? 0));
    const asset = String(entry.asset_type || entry.asset || "credit");
    const unit = asset === "image" ? "张" : asset === "subscription" ? "期" : "点";
    const eventLabels = { opening_balance: "期初余额", reserve: "任务预扣", release: "预扣返还", reservation_refund: "任务退款", order_credit: "申请批准入账", credit_pack_approved: "储值申请批准入账", credit_pack_bonus: "储值赠送图片", subscription_period_approved: "订阅申请批准生效", admin_adjustment: "人工调整", image_grant: "图片额度入账", settled: "任务结算" };
    const label = entry.label || entry.description || entry.event_name || eventLabels[entry.event_type] || entry.event_type || "余额调整";
    const sign = amount > 0 ? "+" : "";
    const balanceAfter = entry.asset_type === "credit" && entry.balance_after_points != null ? entry.balance_after_points : entry.balance_after_units;
    return `<div class="billing-ledger-row"><div class="billing-ledger-copy"><strong>${esc(label)}</strong><time>${esc(formatTime(entry.created_at))}${balanceAfter != null ? ` · 余额 ${esc(numberText(balanceAfter))}` : ""}</time></div><span class="billing-ledger-amount ${amount > 0 ? "is-positive" : amount < 0 ? "is-negative" : ""}">${esc(`${sign}${numberText(amount)} ${unit}`)}</span></div>`;
  }).join("");
}

function renderBilling() {
  renderPersonalBillingSummary();
  renderBillingSummary();
  renderBillingOrders();
  renderBillingLedger();
}

async function loadBilling({ force = false } = {}) {
  if (state.billing.loading || (state.billing.loaded && !force)) return;
  state.billing.loading = true;
  state.billing.errors = {};
  renderBilling();
  const requests = {
    summary: api("/api/billing/summary"),
    orders: api("/api/billing/orders"),
    ledger: api("/api/billing/ledger"),
  };
  const keys = Object.keys(requests);
  const results = await Promise.allSettled(Object.values(requests));
  results.forEach((result, index) => {
    const key = keys[index];
    if (result.status === "fulfilled") state.billing[key] = result.value;
    else state.billing.errors[key] = result.reason || { detail: "加载失败" };
  });
  state.billing.loading = false;
  state.billing.loaded = true;
  renderBilling();
}

async function cancelBillingOrder(orderId) {
  if (!orderId || state.billing.cancellingOrderId) return;
  const confirmed = await openConsoleModal({
    title: "取消方案申请",
    message: "取消后该申请将不再进入管理员审批，确定继续吗？",
    confirmText: "取消申请",
    danger: true,
  });
  if (!confirmed) return;
  state.billing.cancellingOrderId = orderId;
  renderBillingOrders();
  try {
    await api(`/api/billing/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST" });
    state.billing.loaded = false;
    await loadBilling({ force: true });
    showMsg("billingMsg", "方案申请已取消", true, { target: { view: "billing" } });
  } catch (error) {
    showMsg("billingMsg", error.detail || error.message || "取消申请失败", false, { target: { view: "billing" } });
  } finally {
    state.billing.cancellingOrderId = "";
    renderBillingOrders();
  }
}

function syncPersonaDashboardStyles(view) {
  const stylesheet = $("personaDashboardStyles");
  if (!stylesheet) return;
  stylesheet.media = view === "persona_dashboard" ? "all" : "not all";
}

function setView(view) {
  const scrollSnapshot = snapshotConsoleScrollState();
  const layoutLocks = captureConsoleLayoutLocks();
  try {
  if (state.liveBrowserExpandedSessionId) closeLiveBrowserLargeModal({ restoreFocus: false });
  clearAccountPasswordRevealState();
  state.personaAccountEditingIds = {};
  clearConsoleNotices();
  state.view = view;
  syncPersonaDashboardStyles(view);
  syncTaskQueueAutoRefresh();
  syncAccountStatusAutoRefresh();
  syncLiveBrowserAutoRefresh();
  if (!["workspace", "accounts"].includes(view)) state.workspaceMenuOpen = false;
  document.querySelectorAll("[data-view]").forEach((button) => {
    const isActive = button.dataset.view === view;
    button.classList.toggle("is-active", isActive);
    if (button.dataset.view === "workspace") {
      button.classList.toggle("has-active-child", ["workspace", "accounts"].includes(view));
    }
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === view));
  const titles = {
    workspace: "任务工作台",
    tasks: "任务队列",
    social: "浏览器发布",
    accounts: state.accountBrowserPanel === "browsers" ? "浏览器列表" : "账号管理自动化",
    settings: "系统状态",
    billing: "订阅与算力",
    console_settings: "设置",
    persona_dashboard: "人设看板",
  };
  $("viewTitle").textContent = titles[view] || "控制台";
  const personaTopbarActions = $("personaDashboardTopbarActions");
  if (personaTopbarActions) personaTopbarActions.hidden = view !== "persona_dashboard";
  updateWorkspaceFlow();
  if ($("moduleMenu")) syncModuleMenuState();
  if (view === "console_settings") renderConsoleSettingsPage();
  if (view === "persona_dashboard") window.PersonaDashboard?.mount?.($("personaDashboardApp"));
  else window.PersonaDashboard?.unmount?.();
  if (view === "tasks") loadTasks();
  if (view === "billing") loadBilling().catch(() => {});
  if (view === "social" || view === "accounts" || view === "settings") loadSocial();
  syncTaskQueueAutoRefresh();
  syncAccountStatusAutoRefresh();
  setMobileNavOpen(false);
  } finally {
    restoreConsoleScrollState(scrollSnapshot);
    releaseConsoleLayoutLocks(layoutLocks);
  }
}

function syncTaskQueueAutoRefresh() {
  const shouldRun = !document.hidden && (state.view === "tasks" || (state.view === "workspace" && state.activeModule === "queue"));
  if (!shouldRun) {
    if (state.taskQueueRefreshTimer) {
      window.clearInterval(state.taskQueueRefreshTimer);
      state.taskQueueRefreshTimer = 0;
    }
    return;
  }
  if (state.taskQueueRefreshTimer) return;
  state.taskQueueRefreshTimer = window.setInterval(() => {
    if (document.hidden || !(state.view === "tasks" || (state.view === "workspace" && state.activeModule === "queue"))) {
      syncTaskQueueAutoRefresh();
      return;
    }
    loadTasks().catch(() => {});
  }, 5000);
}

function shouldRefreshAccountStatus() {
  if (["social", "accounts", "settings"].includes(state.view)) return true;
  return state.view === "workspace" && (isPersonaWorkspaceModule() || ["publishing", "automation"].includes(state.activeModule));
}

async function refreshAccountStatusOnce() {
  if (!shouldRefreshAccountStatus()) return;
  await refreshSocialAccountsOnly();
}

function syncAccountStatusAutoRefresh() {
  if (document.hidden || !shouldRefreshAccountStatus()) {
    if (state.accountStatusRefreshTimer) {
      window.clearInterval(state.accountStatusRefreshTimer);
      state.accountStatusRefreshTimer = 0;
    }
    return;
  }
  if (state.accountStatusRefreshTimer) return;
  state.accountStatusRefreshTimer = window.setInterval(() => {
    if (document.hidden || !shouldRefreshAccountStatus()) {
      syncAccountStatusAutoRefresh();
      return;
    }
    refreshAccountStatusOnce().catch(() => {});
  }, 3000);
}

function shouldRefreshLiveBrowserSessions() {
  return !document.hidden && state.view === "accounts" && state.accountBrowserPanel === "browsers";
}

function syncLiveBrowserAutoRefresh() {
  if (!shouldRefreshLiveBrowserSessions()) {
    if (state.liveBrowserRefreshTimer) {
      window.clearInterval(state.liveBrowserRefreshTimer);
      state.liveBrowserRefreshTimer = 0;
    }
    return;
  }
  if (state.liveBrowserRefreshTimer) return;
  refreshLiveBrowserSessionsOnly().catch(() => {});
  state.liveBrowserRefreshTimer = window.setInterval(() => {
    if (!shouldRefreshLiveBrowserSessions()) {
      syncLiveBrowserAutoRefresh();
      return;
    }
    refreshLiveBrowserSessionsOnly().catch(() => {});
  }, 2000);
}

function setWorkspaceModule(moduleId) {
  state.workspaceMenuOpen = true;
  if (state.view !== "workspace") setView("workspace");
  setModule(moduleId);
}

function personaListScrollSnapshotKey(node, index) {
  const shell = node?.closest?.(".persona-list-shell");
  const context = shell ? String(shell.className || "") : "";
  return `${context}:${index}`;
}

function snapshotPersonaListScrolls() {
  return Array.from(document.querySelectorAll(".persona-list-scroll")).map((node, index) => ({
    index,
    key: personaListScrollSnapshotKey(node, index),
    top: node.scrollTop || 0,
  }));
}

function snapshotConsoleScrollState() {
  const moduleBody = $("moduleBody");
  const main = document.querySelector(".console-main");
  const personaList = moduleBody?.querySelector(".persona-list-scroll");
  const publishPreviewTabs = moduleBody?.querySelector(".publish-preview-tabs");
  const publishPostList = moduleBody?.querySelector(".publish-post-list");
  const personaHotGrid = moduleBody?.querySelector(".persona-hot-grid");
  const personaHotPreview = moduleBody?.querySelector(".persona-hot-preview-card");
  const personaHotLayout = moduleBody?.querySelector(".persona-hot-layout");
  return {
    windowX: window.scrollX || 0,
    windowY: window.scrollY || 0,
    mainTop: main?.scrollTop || 0,
    moduleTop: moduleBody?.scrollTop || 0,
    personaListTop: personaList?.scrollTop || 0,
    publishPreviewTabsTop: publishPreviewTabs?.scrollTop || 0,
    publishPostListTop: publishPostList?.scrollTop || 0,
    personaHotGridTop: personaHotGrid?.scrollTop || 0,
    personaHotPreviewTop: personaHotPreview?.scrollTop || 0,
    personaHotPreviewKey: String(personaHotPreview?.dataset?.personaHotPreviewKey || ""),
    personaHotLayoutTop: personaHotLayout ? personaHotLayout.getBoundingClientRect().top : null,
    personaListScrolls: snapshotPersonaListScrolls(),
  };
}

function captureConsoleLayoutLocks() {
  return [$('moduleBody'), $('personaDetail')]
    .filter(Boolean)
    .map((node) => {
      const height = Math.ceil(node.getBoundingClientRect().height || 0);
      if (height <= 0) return null;
      const previous = node.style.minHeight;
      node.style.minHeight = `${Math.max(height, node.offsetHeight || 0)}px`;
      return { node, previous };
    })
    .filter(Boolean);
}

function releaseConsoleLayoutLocks(locks = []) {
  if (!locks.length) return;
  const release = () => {
    locks.forEach(({ node, previous }) => {
      if (node?.isConnected) node.style.minHeight = previous;
    });
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(release));
}

function restoreConsoleScrollState(snapshot) {
  if (!snapshot) return;
  const apply = () => {
    const moduleBody = $("moduleBody");
    const main = document.querySelector(".console-main");
    const personaList = moduleBody?.querySelector(".persona-list-scroll");
    const publishPreviewTabs = moduleBody?.querySelector(".publish-preview-tabs");
    const publishPostList = moduleBody?.querySelector(".publish-post-list");
    const personaHotGrid = moduleBody?.querySelector(".persona-hot-grid");
    const personaHotPreview = moduleBody?.querySelector(".persona-hot-preview-card");
    const personaHotLayout = moduleBody?.querySelector(".persona-hot-layout");
    if (main) main.scrollTop = snapshot.mainTop || 0;
    if (moduleBody) moduleBody.scrollTop = snapshot.moduleTop || 0;
    if (personaList) personaList.scrollTop = snapshot.personaListTop || 0;
    if (publishPreviewTabs) publishPreviewTabs.scrollTop = snapshot.publishPreviewTabsTop || 0;
    if (publishPostList) publishPostList.scrollTop = snapshot.publishPostListTop || 0;
    if (personaHotGrid) personaHotGrid.scrollTop = snapshot.personaHotGridTop || 0;
    if (
      personaHotPreview
      && String(personaHotPreview.dataset?.personaHotPreviewKey || "") === String(snapshot.personaHotPreviewKey || "")
    ) {
      personaHotPreview.scrollTop = snapshot.personaHotPreviewTop || 0;
    }
    const currentPersonaScrolls = Array.from(document.querySelectorAll(".persona-list-scroll"));
    (snapshot.personaListScrolls || []).forEach((item) => {
      const target = currentPersonaScrolls.find((node, index) => personaListScrollSnapshotKey(node, index) === item.key)
        || currentPersonaScrolls[item.index];
      if (target) target.scrollTop = item.top || 0;
    });
    if (personaHotLayout && Number.isFinite(snapshot.personaHotLayoutTop)) {
      const topDelta = personaHotLayout.getBoundingClientRect().top - snapshot.personaHotLayoutTop;
      if (Math.abs(topDelta) > 0.5) window.scrollBy(0, topDelta);
    } else {
      window.scrollTo(snapshot.windowX || 0, snapshot.windowY || 0);
    }
  };
  apply();
  window.requestAnimationFrame(apply);
}

async function confirmDangerAction(message, { title = "确认删除", confirmText = "删除" } = {}) {
  return Boolean(await openConsoleModal({
    title,
    message,
    confirmText,
    cancelText: "取消",
    danger: true,
    showCancel: true,
  }));
}

function withConsoleScrollPreserved(callback) {
  const snapshot = snapshotConsoleScrollState();
  const layoutLocks = captureConsoleLayoutLocks();
  try {
    return callback();
  } finally {
    restoreConsoleScrollState(snapshot);
    releaseConsoleLayoutLocks(layoutLocks);
  }
}

function updateWorkspaceFlow() {
  const flow = $("workspaceFlow");
  const button = document.querySelector('[data-view="workspace"]');
  if (!flow || !button) return;
  const open = state.workspaceMenuOpen && ["workspace", "accounts"].includes(state.view);
  flow.classList.toggle("is-open", open);
  button.setAttribute("aria-expanded", open ? "true" : "false");
}

function renderModuleMenu() {
  updateWorkspaceFlow();
  $("moduleMenu").innerHTML = `<div class="module-accordion">${modules.map((item) => {
    const itemPanel = String(item.panel || "");
    const itemPanels = Array.isArray(item.panels) ? item.panels.map((panel) => String(panel || "")) : [];
    const isActive = item.view
      ? (item.view === state.view && (itemPanel ? itemPanel === state.accountBrowserPanel : (!itemPanels.length || itemPanels.includes(state.accountBrowserPanel))))
      : (state.view === "workspace" && item.id === state.activeModule);
    return `
      <div class="module-accordion-item">
        <button type="button" class="module-trigger ${isActive ? "is-active" : ""}" ${item.view ? `data-workspace-view="${esc(item.view)}" data-workspace-module="${esc(item.id)}"${itemPanel ? ` data-workspace-panel="${esc(itemPanel)}"` : ""}` : `data-module="${esc(item.id)}"`}>
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
    const isActive = state.view === "workspace" && moduleId === state.activeModule;
    button.classList.toggle("is-active", isActive);
  });
  document.querySelectorAll("[data-workspace-view]").forEach((button) => {
    const itemPanel = String(button.dataset.workspacePanel || "");
    const itemId = String(button.dataset.workspaceModule || "");
    const item = modules.find((entry) => String(entry.id || "") === itemId);
    const itemPanels = Array.isArray(item?.panels) ? item.panels.map((panel) => String(panel || "")) : [];
    button.classList.toggle("is-active", button.dataset.workspaceView === state.view && (itemPanel ? itemPanel === state.accountBrowserPanel : (!itemPanels.length || itemPanels.includes(state.accountBrowserPanel))));
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
  const previousModule = state.activeModule;
  state.activeModule = moduleId;
  if (isPersonaWorkspaceModule(moduleId) && moduleId !== previousModule) {
    state.personaGroup = personaModuleDefaultGroup(moduleId);
    setPersonaGroupStep(state.personaGroup, state.personaPanels[state.personaGroup] || personaGroups[state.personaGroup]?.defaultStep || "", selectedPersonaProfile());
  }
  renderWorkspace();
  syncTaskQueueAutoRefresh();
  syncAccountStatusAutoRefresh();
  syncLiveBrowserAutoRefresh();
}

function selectedBranch(moduleId) {
  if (isPersonaWorkspaceModule(moduleId)) return state.personaGroup;
  return state.simpleBranches[moduleId] || moduleDefaultBranch[moduleId] || "";
}

function renderWorkspace(renderMenu = true) {
  return withConsoleScrollPreserved(() => {
  const module = currentModule();
  closePersonaMediaLightbox();
  resetMediaPreviewGroups();
  if (renderMenu) renderModuleMenu();
  else syncModuleMenuState();
  $("moduleTitle").textContent = module.label;
  $("moduleEyebrow").textContent = isPersonaWorkspaceModule(module.id) ? "人设流程" : "Web 流程";
  const modulePanel = $("moduleBody").closest(".module-panel");
  modulePanel?.classList.toggle("is-persona-module", isPersonaWorkspaceModule(module.id));
  modulePanel?.classList.toggle("is-publishing-module", module.id === "publishing");
  $("moduleCallback").textContent = "";
  $("moduleCallback").style.display = "none";
  if (isPersonaWorkspaceModule(module.id)) renderPersonaModule();
  else renderSimpleFlowModule(module.id);
  renderConfirmSummary();
  });
}

function beginWorkspaceBootstrapLoading() {
  state.workspaceBootstrapPending = true;
  state.workspaceBootstrapNoticeVisible = false;
  if (state.workspaceBootstrapTimer) clearTimeout(state.workspaceBootstrapTimer);
  state.workspaceBootstrapTimer = window.setTimeout(() => {
    state.workspaceBootstrapTimer = 0;
    if (!state.workspaceBootstrapPending) return;
    state.workspaceBootstrapNoticeVisible = true;
    if (state.view === "workspace" && isPersonaWorkspaceModule()) renderWorkspace(false);
  }, 320);
}

function finishWorkspaceBootstrapLoading() {
  if (state.workspaceBootstrapTimer) clearTimeout(state.workspaceBootstrapTimer);
  state.workspaceBootstrapTimer = 0;
  state.workspaceBootstrapPending = false;
  state.workspaceBootstrapNoticeVisible = false;
}

function renderWorkspaceBootstrapLoading() {
  const noticeClass = state.workspaceBootstrapNoticeVisible ? " is-notice-visible" : "";
  return `
    <section class="workspace-bootstrap-loading${noticeClass}" role="status" aria-live="polite" aria-busy="true">
      <div class="workspace-bootstrap-placeholder" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <div class="workspace-bootstrap-notice">
        <span class="workspace-bootstrap-spinner" aria-hidden="true"></span>
        <div>
          <strong>正在加载工作台</strong>
          <p>正在加载人设列表，账号和草稿数据会继续同步。</p>
        </div>
      </div>
    </section>`;
}

let workspaceRenderRaf = 0;

function scheduleWorkspaceRender(renderMenu = false) {
  if (workspaceRenderRaf) return;
  workspaceRenderRaf = window.requestAnimationFrame(() => {
    workspaceRenderRaf = 0;
    renderWorkspace(renderMenu);
  });
}

function renderPersonaGroupPanel(groupKey, step, persona, account, profile) {
  if (groupKey === "content") return renderPersonaContentPanel(persona, account, profile, step);
  if (groupKey === "settings") return renderPersonaSettingsPanelV2(persona, account, profile, step);
  return renderPersonaContentPanel(persona, account, profile, step);
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
  if (/^\/api\//i.test(text)) return adminWorkspaceUrl(text);
  if (/^(?:data:|blob:)/i.test(text)) return text;
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

function mediaTypeBadgeInfo(items = []) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return { label: "纯文本", count: 0, kind: "text" };
  let images = 0;
  let videos = 0;
  let audios = 0;
  let others = 0;
  rows.forEach((item) => {
    const type = guessMediaType(item?.url || item?.previewUrl || item?.preview_url || "", item?.type || "");
    if (type === "video") videos += 1;
    else if (type === "audio") audios += 1;
    else if (type === "image") images += 1;
    else others += 1;
  });
  const total = rows.length;
  const pieces = [];
  if (images) pieces.push("图片");
  if (videos) pieces.push("视频");
  if (audios) pieces.push("音频");
  if (others) pieces.push("媒体");
  const label = pieces.length ? pieces.join("+") : "媒体";
  return { label: total > 1 ? `${label} ${total}` : label, count: total, kind: videos ? "video" : images ? "image" : audios ? "audio" : "media" };
}

function renderMediaTypeBadge(items = [], { className = "" } = {}) {
  const info = mediaTypeBadgeInfo(items);
  return `<span class="persona-media-type-badge persona-media-type-badge--${esc(info.kind)} ${esc(className)}">${esc(info.label)}</span>`;
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
    previewUrl: adminWorkspaceUrl(item.previewUrl),
    originalUrl: adminWorkspaceUrl(item.originalUrl || item.original_url || item.previewUrl),
    type: String(item.type || "image").trim() || "image",
    label: String(item.label || "").trim(),
  }));
  return id;
}

function renderMediaPreviewButton(item, groupId, index, {
  className = "persona-media-card",
  frameClass = "persona-media-frame",
  caption = "",
  interactive = true,
} = {}) {
  const label = String(item?.label || "").trim();
  const type = String(item?.type || "image").trim() || "image";
  const text = caption || mediaKindLabel(type);
  const displayUrl = adminWorkspaceUrl(item?.thumbnailUrl || item?.thumbnail_url || item?.previewUrl);
  const rootTag = interactive ? "button" : "div";
  return `
    <${rootTag}
      ${interactive ? "type=\"button\"" : ""}
      class="${esc(className)}${interactive ? "" : " is-static"}"
      ${interactive ? `data-media-preview-group="${esc(groupId)}" data-media-preview-index="${esc(index)}" data-media-preview-type="${esc(type)}" data-media-preview-label="${esc(label || text)}"` : ""}>
      ${type === "video"
        ? `<video class="${esc(frameClass)}" src="${esc(displayUrl)}" muted playsinline preload="metadata" onerror="handlePersonaMediaFrameError(this)"></video>`
        : type === "audio"
          ? `<div class="${esc(frameClass)} ${esc(frameClass)}--audio"><strong>音频</strong><small>点击站内预览</small></div>`
          : `<img class="${esc(frameClass)}" src="${esc(displayUrl)}" alt="${esc(label || "media")}" loading="lazy" onerror="handlePersonaMediaFrameError(this)" />`}
      <span>${esc(text)}</span>
    </${rootTag}>
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

function personaEditablePostMediaItems(personaId, post = {}) {
  return personaDraftMediaItems(personaId, post).filter((item) => {
    const label = String(item?.label || "").trim().toLowerCase();
    const url = String(item?.url || item?.previewUrl || "").trim();
    return label !== "screenshot" && !url.includes("/automation/screenshots/");
  });
}

function personaMediaSignature(items = []) {
  return JSON.stringify((Array.isArray(items) ? items : []).map((item) => ({
    url: String(item?.url || "").trim(),
    type: String(item?.type || "").trim(),
    label: String(item?.label || "").trim(),
  })));
}

function clonePersonaDraftMediaItem(item = {}) {
  return {
    url: String(item?.url || "").trim(),
    previewUrl: String(item?.previewUrl || item?.preview_url || item?.url || "").trim(),
    type: guessMediaType(String(item?.url || item?.previewUrl || item?.preview_url || "").trim(), item?.type || ""),
    label: String(item?.label || item?.type || "").trim(),
    unavailable: Boolean(item?.unavailable),
    reason: String(item?.reason || "").trim(),
    pending: Boolean(item?.pending),
  };
}

function filePersonaDraftMediaItem(file) {
  const previewUrl = URL.createObjectURL(file);
  return {
    url: previewUrl,
    previewUrl,
    type: guessMediaType(file?.name || "", file?.type || ""),
    label: file?.name || "待保存媒体",
    pending: true,
    file,
  };
}

function personaDraftMediaPreviewItems(persona, source, post = {}) {
  const personaId = String(persona?.id || "").trim();
  const rows = personaEditablePostMediaItems(personaId, post);
  const draft = personaFormState(personaId).draft || {};
  if (
    personaId
    && String(draft.editingPostId || "").trim() === String(post?.id || "").trim()
    && (draft.editingSource === "favorites" ? "favorites" : "posts") === (source === "favorites" ? "favorites" : "posts")
    && Array.isArray(draft.mediaItems)
  ) {
    return draft.mediaItems.map(clonePersonaDraftMediaItem);
  }
  return rows;
}

function isPublishContentMediaItem(item = {}) {
  const label = String(item?.label || "").trim().toLowerCase();
  const url = String(item?.url || "").trim();
  const previewUrl = String(item?.previewUrl || item?.preview_url || "").trim();
  const combined = `${url} ${previewUrl}`.toLowerCase().replaceAll("\\", "/");
  if (label === "screenshot") return false;
  if (combined.includes("/automation/screenshots/")) return false;
  if (combined.includes("/publish_done_")) return false;
  return true;
}

function personaPublishPostMediaItems(personaId, post = {}) {
  return personaDraftMediaItems(personaId, post).filter(isPublishContentMediaItem);
}

function personaHistoryMediaItems(row = {}) {
  const items = [];
  const baseItems = Array.isArray(row.media_items) ? row.media_items : [];
  baseItems.filter(isPublishContentMediaItem).forEach((item) => {
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

function renderPersonaDraftDetailMedia(items = []) {
  const rows = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!rows.length) return "";
  const groupId = registerMediaPreviewGroup(rows.filter((item) => item?.previewUrl && !item.unavailable));
  let previewIndex = 0;
  return `
    <div class="persona-draft-detail-media-expanded" aria-label="媒体文件">
      <span>媒体文件</span>
      <div class="persona-draft-detail-media-list">
        ${rows.map((item) => item.unavailable || !item.previewUrl
          ? `<div class="persona-draft-detail-media-item is-unavailable">
              <div class="persona-draft-detail-media-frame persona-media-frame--empty">
                <strong>媒体不可预览</strong>
                <small>${esc(item.reason || "原始文件已失效")}</small>
              </div>
              <span>${esc(mediaKindLabel(item.type))}</span>
            </div>`
          : renderMediaPreviewButton(item, groupId, previewIndex++, {
              className: "persona-draft-detail-media-item",
              frameClass: "persona-draft-detail-media-frame",
            })
        ).join("")}
      </div>
    </div>`;
}

function renderPersonaDraftCardMediaSlot(items = []) {
  const rows = (Array.isArray(items) ? items : []).filter((item) => item && (item.previewUrl || item.unavailable));
  if (!rows.length) {
    return `<div class="persona-draft-card-media-slot is-empty" aria-label="无媒体"><span>无媒体</span></div>`;
  }
  const previewRows = rows.filter((item) => item?.previewUrl && !item.unavailable);
  const first = previewRows[0] || rows[0];
  const countBadge = rows.length > 1 ? `<strong class="persona-draft-card-media-count">${esc(rows.length)}</strong>` : "";
  if (!first?.previewUrl || first.unavailable) {
    return `
      <div class="persona-draft-card-media-slot is-unavailable" aria-label="媒体不可预览">
        <span>${esc(mediaKindLabel(first?.type))}</span>
        ${countBadge}
      </div>`;
  }
  const groupId = registerMediaPreviewGroup(previewRows);
  return renderMediaPreviewButton(first, groupId, 0, {
    className: "persona-draft-card-media-slot",
    frameClass: "persona-draft-card-media-frame",
    caption: mediaKindLabel(first.type),
  }).replace("</button>", `${countBadge}</button>`);
}

function renderPublishPreviewMedia(items = []) {
  const rows = (Array.isArray(items) ? items : []).filter((item) => item && (item.previewUrl || item.unavailable));
  if (!rows.length) return `<div class="publish-preview-media-empty">当前内容没有媒体文件。</div>`;
  const previewRows = rows.filter((item) => item?.previewUrl && !item.unavailable);
  const typeSummary = Array.from(new Set(rows.map((item) => mediaKindLabel(item?.type)).filter(Boolean))).join(" / ") || "媒体";
  const groupId = registerMediaPreviewGroup(previewRows);
  return `
    <div class="publish-preview-media-list" aria-label="${esc(`${rows.length} 个${typeSummary}`)}">
      <div class="publish-preview-media-summary">${esc(rows.length)} 个 · ${esc(typeSummary)}</div>
      ${rows.map((item, index) => {
        if (!item?.previewUrl || item.unavailable) {
          return `
            <div class="publish-preview-media-single is-unavailable" aria-label="媒体不可预览">
              <div class="persona-media-frame persona-media-frame--empty">
                <strong>媒体不可预览</strong>
                <small>${esc(item?.reason || "原始文件已失效")}</small>
              </div>
              <span class="publish-preview-media-badge">第 ${esc(index + 1)} 个</span>
            </div>`;
        }
        const previewIndex = Math.max(0, previewRows.indexOf(item));
        return `
          <div class="publish-preview-media-single">
            ${renderMediaPreviewButton(item, groupId, previewIndex, {
              className: "publish-preview-media-button",
              frameClass: "publish-preview-media-frame",
            })}
            <span class="publish-preview-media-badge">第 ${esc(index + 1)} 个 · ${esc(mediaKindLabel(item.type))}</span>
          </div>`;
      }).join("")}
    </div>`;
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
        <button type="button" id="personaMediaReset" data-media-lightbox-reset>复位</button>
        <button type="button" id="personaMediaPrev" data-media-lightbox-prev>上一张</button>
        <button type="button" id="personaMediaNext" data-media-lightbox-next>下一张</button>
      </div>
    </div>
  `;
  document.body.appendChild(node);
  node.addEventListener("click", (event) => {
    if (event.target.closest("[data-media-lightbox-close]")) closePersonaMediaLightbox();
    if (event.target.closest("[data-media-lightbox-reset]")) resetPersonaMediaLightboxTransform();
    if (event.target.closest("[data-media-lightbox-prev]")) movePersonaMediaLightbox(-1);
    if (event.target.closest("[data-media-lightbox-next]")) movePersonaMediaLightbox(1);
  });
  node.addEventListener("wheel", handlePersonaMediaLightboxWheel, { passive: false });
  node.addEventListener("pointerdown", handlePersonaMediaLightboxPointerDown);
  document.addEventListener("pointermove", handlePersonaMediaLightboxPointerMove, { passive: false });
  document.addEventListener("pointerup", handlePersonaMediaLightboxPointerUp);
  document.addEventListener("pointercancel", handlePersonaMediaLightboxPointerUp);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !node.hidden) closePersonaMediaLightbox();
  });
  return node;
}

function mediaLightboxImage() {
  return $("personaMediaLightboxBody")?.querySelector("[data-media-lightbox-zoomable]");
}

function applyPersonaMediaLightboxTransform() {
  const image = mediaLightboxImage();
  if (!image) return;
  const scale = Math.min(Math.max(Number(state.mediaLightbox.scale || 1), 0.4), 6);
  const x = Number(state.mediaLightbox.x || 0);
  const y = Number(state.mediaLightbox.y || 0);
  state.mediaLightbox.scale = scale;
  image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}

function resetPersonaMediaLightboxTransform() {
  state.mediaLightbox.scale = 1;
  state.mediaLightbox.x = 0;
  state.mediaLightbox.y = 0;
  state.mediaLightbox.dragging = false;
  applyPersonaMediaLightboxTransform();
}

function handlePersonaMediaLightboxWheel(event) {
  const node = $("personaMediaLightbox");
  if (!node || node.hidden || !mediaLightboxImage()) return;
  event.preventDefault();
  const current = Math.min(Math.max(Number(state.mediaLightbox.scale || 1), 0.4), 6);
  const next = Math.min(Math.max(current * (event.deltaY < 0 ? 1.12 : 0.88), 0.4), 6);
  if (Math.abs(next - current) < 0.001) return;
  state.mediaLightbox.scale = next;
  applyPersonaMediaLightboxTransform();
}

function handlePersonaMediaLightboxPointerDown(event) {
  const image = mediaLightboxImage();
  if (!image || !event.target.closest?.(".persona-media-lightbox-body")) return;
  event.preventDefault();
  state.mediaLightbox.dragging = true;
  state.mediaLightbox.dragX = event.clientX;
  state.mediaLightbox.dragY = event.clientY;
  state.mediaLightbox.startX = Number(state.mediaLightbox.x || 0);
  state.mediaLightbox.startY = Number(state.mediaLightbox.y || 0);
  image.classList.add("is-dragging");
  image.setPointerCapture?.(event.pointerId);
}

function handlePersonaMediaLightboxPointerMove(event) {
  if (!state.mediaLightbox.dragging || !mediaLightboxImage()) return;
  event.preventDefault();
  state.mediaLightbox.x = Number(state.mediaLightbox.startX || 0) + event.clientX - Number(state.mediaLightbox.dragX || 0);
  state.mediaLightbox.y = Number(state.mediaLightbox.startY || 0) + event.clientY - Number(state.mediaLightbox.dragY || 0);
  applyPersonaMediaLightboxTransform();
}

function handlePersonaMediaLightboxPointerUp() {
  if (!state.mediaLightbox.dragging) return;
  state.mediaLightbox.dragging = false;
  mediaLightboxImage()?.classList.remove("is-dragging");
}

function closePersonaMediaLightbox() {
  const node = $("personaMediaLightbox");
  if (!node) return;
  node.hidden = true;
  const body = $("personaMediaLightboxBody");
  if (body) body.innerHTML = "";
  state.mediaLightbox.groupId = "";
  state.mediaLightbox.index = 0;
  resetPersonaMediaLightboxTransform();
}

function syncPersonaMediaLightboxNav(total, index) {
  const counter = $("personaMediaLightboxCounter");
  const prev = $("personaMediaPrev");
  const next = $("personaMediaNext");
  const reset = $("personaMediaReset");
  if (counter) counter.textContent = total > 1 ? `${index + 1} / ${total}` : "";
  if (prev) prev.disabled = total <= 1 || index <= 0;
  if (next) next.disabled = total <= 1 || index >= total - 1;
  if (reset) reset.disabled = !mediaLightboxImage();
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
  const sourceUrl = String(item.originalUrl || item.previewUrl || "").trim();
  resetPersonaMediaLightboxTransform();
  body.innerHTML = item.type === "video"
    ? `<video class="persona-media-lightbox-frame" src="${esc(sourceUrl)}" controls autoplay playsinline preload="metadata" onerror="handlePersonaMediaLightboxError(this, '视频加载失败，原始文件可能已失效。')"></video>`
    : item.type === "audio"
      ? `<audio class="persona-media-lightbox-audio" src="${esc(sourceUrl)}" controls autoplay onerror="handlePersonaMediaLightboxError(this, '音频加载失败，原始文件可能已失效。')"></audio>`
      : `<img class="persona-media-lightbox-frame is-zoomable" data-media-lightbox-zoomable src="${esc(sourceUrl)}" alt="${esc(item.label || "媒体预览")}" draggable="false" onerror="handlePersonaMediaLightboxError(this, '图片加载失败，原始文件可能已失效。')" />`;
  applyPersonaMediaLightboxTransform();
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

function closePersonaDraftMenus(except = null) {
  document.querySelectorAll(".persona-draft-more.is-open").forEach((menu) => {
    if (except && menu === except) return;
    menu.classList.remove("is-open");
    menu.closest(".persona-draft-table-row, .persona-draft-card")?.classList.remove("is-menu-open");
    menu.closest(".persona-inline-panel")?.classList.remove("is-menu-open");
    menu.closest(".persona-draft-table")?.classList.remove("is-menu-open");
    menu.closest(".persona-workbench-shell")?.classList.remove("is-menu-open");
  });
}

function renderPersonaDraftRows(posts, source = personaPostSource(), allRows = posts) {
  const isFavoriteSource = source === "favorites";
  if (!posts.length) return `<div class="empty-state">${isFavoriteSource ? "当前还没有收藏推文。可以在草稿里点击收藏，或从 Bot 同步已有收藏。" : "当前还没有推文草稿。先新建一条，再进入发布步骤。"}</div>`;
  const mode = personaDraftViewMode();
  const personaId = String(selectedPersona()?.id || "");
  const selectedIds = new Set(syncPersonaSelectedPostIds(selectedPersona(), source, posts));
  if (mode === "list") return renderPersonaDraftTableRows(posts, personaId, allRows);
  return `<div class="compact-list persona-draft-grid">${posts.map((post, index) => {
    const hotMeta = personaHotImportMeta(personaId, post.id);
    const mediaItems = personaDraftMediaPreviewItems(selectedPersona(), source, post);
    const isChecked = selectedIds.has(String(post.id || ""));
    const isSelected = String(post.id) === String(state.selectedPersonaPostId);
    const displayTitle = personaDraftDisplayTitleForPost(post, allRows, index);
    return `
    <article
      class="compact-row persona-draft-card ${isSelected ? "is-selected" : ""}"
      data-persona-select-post="${esc(post.id)}"
      role="button"
      tabindex="0"
      aria-pressed="${isSelected ? "true" : "false"}"
    >
      ${renderPersonaFavoriteStar(post, { source, className: "persona-draft-card-star" })}
      <div class="persona-draft-card-head">
        <label class="persona-post-bulk-toggle" data-persona-bulk-post-toggle="${esc(post.id)}" data-persona-bulk-post-source="${esc(source)}" aria-label="勾选用于批量操作">
          <input
            type="checkbox"
            data-persona-bulk-post-id="${esc(post.id)}"
            data-persona-bulk-post-source="${esc(source)}"
            ${isChecked ? "checked" : ""}
          />
          <span>勾选</span>
        </label>
        <strong>${esc(displayTitle)}</strong>
        ${renderMediaTypeBadge(mediaItems)}
        ${hotMeta ? renderPersonaHotOrigin(hotMeta, { compact: true }) : ""}
        <span class="persona-draft-card-time">${esc(formatTime(post.published_at || post.updated_at || post.created_at))}</span>
      </div>
      <div class="persona-draft-card-body">
        ${renderPersonaDraftCardMediaSlot(mediaItems)}
        <div class="persona-draft-card-copy">
          <p>${esc(String(post.content || "").slice(0, 170))}</p>
          ${hotMeta ? renderPersonaHotMetricStrip(hotMeta, post.id) : ""}
        </div>
      </div>
      <div class="persona-draft-card-footer">
        <small>${isSelected ? "当前已选中" : "点击卡片选中"}</small>
        <div class="row-actions persona-draft-card-actions">
          ${renderPersonaDraftPostActions(post, { source, isSelected, includeFavorite: false })}
        </div>
      </div>
    </article>
  `;
  }).join("")}</div>`;
}

function personaDraftViewMode(personaId = String(selectedPersona()?.id || state.selectedPersonaId || "default")) {
  return state.personaDraftViewModes[String(personaId || "default")] === "list" ? "list" : "grid";
}

function setPersonaDraftViewMode(mode, personaId = String(selectedPersona()?.id || state.selectedPersonaId || "default")) {
  state.personaDraftViewModes[String(personaId || "default")] = mode === "list" ? "list" : "grid";
}

function personaPostPageKey(persona = selectedPersona(), source = personaPostSource(persona)) {
  return `${String(persona?.id || "default")}::${source === "favorites" ? "favorites" : "posts"}`;
}

function personaPostPageInfo(persona = selectedPersona(), source = personaPostSource(persona), rows = []) {
  const pageSize = Math.min(Math.max(Number(state.personaPostPageSize || 10), 5), 80);
  const totalItems = Array.isArray(rows) ? rows.length : 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const key = personaPostPageKey(persona, source);
  const page = Math.min(Math.max(Number(state.personaPostPages[key] || 1), 1), totalPages);
  state.personaPostPages[key] = page;
  const start = (page - 1) * pageSize;
  return {
    key,
    page,
    pageSize,
    totalPages,
    totalItems,
    items: (Array.isArray(rows) ? rows : []).slice(start, start + pageSize),
  };
}

function setPersonaPostPage(persona = selectedPersona(), source = personaPostSource(persona), page = 1) {
  state.personaPostPages[personaPostPageKey(persona, source)] = Math.max(1, Number(page || 1));
}

function ensurePersonaPostPageForPost(persona = selectedPersona(), source = personaPostSource(persona), postId = "", rows = personaSourcePosts(persona, source)) {
  const cleanPostId = String(postId || "").trim();
  const index = (Array.isArray(rows) ? rows : []).findIndex((post) => String(post.id || "") === cleanPostId);
  if (index < 0) return;
  const pageSize = Math.min(Math.max(Number(state.personaPostPageSize || 10), 5), 80);
  setPersonaPostPage(persona, source, Math.floor(index / pageSize) + 1);
}

function renderPersonaPostPager(pageInfo, source) {
  if (!pageInfo || Number(pageInfo.totalItems || 0) <= Number(pageInfo.pageSize || 10)) return "";
  const { page, totalPages, pageSize, totalItems } = pageInfo;
  return `
    <div class="persona-list-pager persona-post-pager" aria-label="${source === "favorites" ? "收藏分页" : "草稿分页"}">
      <button type="button" data-persona-post-page="first" title="首页" aria-label="首页" ${page <= 1 ? "disabled" : ""}><span class="ui-arrow-icon ui-arrow-icon--double-left" aria-hidden="true"></span></button>
      <button type="button" data-persona-post-page="prev" title="上页" aria-label="上页" ${page <= 1 ? "disabled" : ""}><span class="ui-arrow-icon ui-arrow-icon--left" aria-hidden="true"></span></button>
      <span>${esc(`${page} / ${totalPages} · 每页 ${pageSize} · 共 ${totalItems}`)}</span>
      <button type="button" data-persona-post-page="next" title="下页" aria-label="下页" ${page >= totalPages ? "disabled" : ""}><span class="ui-arrow-icon ui-arrow-icon--right" aria-hidden="true"></span></button>
      <button type="button" data-persona-post-page="last" title="尾页" aria-label="尾页" ${page >= totalPages ? "disabled" : ""}><span class="ui-arrow-icon ui-arrow-icon--double-right" aria-hidden="true"></span></button>
    </div>`;
}

function renderPersonaDraftViewToggle(mode) {
  const activeMode = mode === "list" ? "list" : "grid";
  return `
    <div class="persona-draft-view-toggle" aria-label="草稿显示模式">
      <button type="button" class="${activeMode === "grid" ? "is-active" : ""}" data-persona-draft-view="grid" title="格子布局" aria-label="格子布局">
        <span class="persona-draft-mode-icon persona-draft-mode-icon--grid" aria-hidden="true"></span>
      </button>
      <button type="button" class="${activeMode === "list" ? "is-active" : ""}" data-persona-draft-view="list" title="列表表格" aria-label="列表表格">
        <span class="persona-draft-mode-icon persona-draft-mode-icon--list" aria-hidden="true"></span>
      </button>
    </div>`;
}

function renderPersonaFavoriteStar(post, { source = personaPostSource(), className = "" } = {}) {
  const persona = selectedPersona();
  const isFavoriteSource = source === "favorites";
  const favoriteRecord = isFavoriteSource ? post : personaFavoriteRecordForPost(persona, post);
  const isFavorited = isFavoriteSource || Boolean(favoriteRecord);
  const favoriteAction = isFavorited && favoriteRecord?.id
    ? `data-persona-delete-favorite="${esc(favoriteRecord.id)}"`
    : `data-persona-favorite-post="${esc(post.id)}"`;
  return `
    <button
      type="button"
      class="persona-favorite-star ${isFavorited ? "is-active" : ""} ${esc(className)}"
      ${favoriteAction}
      data-persona-favorite-inline="true"
      title="${isFavorited ? "取消收藏" : "收藏"}"
      aria-label="${isFavorited ? "取消收藏" : "收藏"}"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 3.4l2.45 5.15 5.55.82-4.02 3.98.95 5.62L12 16.27 7.07 18.97l.95-5.62L4 9.37l5.55-.82L12 3.4z"></path>
      </svg>
    </button>`;
}

function renderPersonaDraftPostActions(post, { source = personaPostSource(), isSelected = false, includeFavorite = true } = {}) {
  const isFavoriteSource = source === "favorites";
  return `
    <div class="persona-draft-actions-inline">
      <button type="button" data-persona-view-post="${esc(post.id)}">查看</button>
      ${includeFavorite ? renderPersonaFavoriteStar(post, { source }) : ""}
      <div class="persona-draft-more">
        <button type="button" class="persona-draft-more-trigger" data-persona-draft-menu-toggle="${esc(post.id)}" title="更多操作" aria-label="更多操作">...</button>
        <div class="persona-draft-more-menu">
          <button type="button" data-persona-edit-post="${esc(post.id)}">${isFavoriteSource ? "编辑收藏" : "编辑草稿"}</button>
          ${isFavoriteSource
            ? `<button type="button" class="danger" data-persona-delete-favorite="${esc(post.id)}">移出收藏</button>`
            : `<button type="button" class="danger" data-persona-delete-post="${esc(post.id)}">删除草稿</button>`}
        </div>
      </div>
      <button type="button" class="primary" data-persona-open-publishing="${esc(post.id)}" ${dailyPublishActionAttrs()}>${source === "favorites" ? "发布收藏" : "发布"}</button>
    </div>`;
}

function renderPersonaDraftTableRows(posts, personaId, allRows = posts) {
  const source = personaPostSource();
  const selectedIds = new Set(syncPersonaSelectedPostIds(selectedPersona(), source, posts));
  return `
    <div class="persona-draft-table" role="table" aria-label="草稿列表">
      <div class="persona-draft-table-head" role="row">
        <span>勾选</span>
        <span>序号</span>
        <span>草稿</span>
        <span>更新时间</span>
        <span>内容</span>
        <span>状态</span>
        <span>操作</span>
      </div>
      ${posts.map((post, index) => {
        const postId = String(post.id || "");
        const isSelected = postId === String(state.selectedPersonaPostId || "");
        const isChecked = selectedIds.has(postId);
        const hotMeta = personaHotImportMeta(personaId, post.id);
        const mediaItems = personaDraftMediaPreviewItems(selectedPersona(), source, post);
        const fullIndex = allRows.findIndex((item) => String(item?.id || "") === postId);
        const displayTitle = hotMeta
          ? `第${Math.max(1, allRows.length - (fullIndex >= 0 ? fullIndex : index))}篇`
          : personaDraftDisplayTitleForPost(post, allRows, index);
        return `
          <article
            class="persona-draft-table-row ${isSelected ? "is-selected" : ""}"
            role="row"
            data-persona-select-post="${esc(post.id)}"
            tabindex="0"
            aria-pressed="${isSelected ? "true" : "false"}"
          >
            <div class="persona-draft-table-cell persona-draft-table-check" role="cell">
              <label class="persona-post-bulk-toggle" data-persona-bulk-post-toggle="${esc(post.id)}" data-persona-bulk-post-source="${esc(source)}" aria-label="勾选用于批量操作">
                <input
                  type="checkbox"
                  data-persona-bulk-post-id="${esc(post.id)}"
                  data-persona-bulk-post-source="${esc(source)}"
                  ${isChecked ? "checked" : ""}
                />
                <span>勾选</span>
              </label>
            </div>
            <div class="persona-draft-table-cell persona-draft-table-index" role="cell" data-mobile-label="序号">${esc(index + 1)}</div>
            <div class="persona-draft-table-cell persona-draft-table-title ${hotMeta ? "is-hot-import" : ""}" role="cell" data-mobile-label="草稿">
              <strong>${esc(displayTitle)}</strong>
              ${renderMediaTypeBadge(mediaItems)}
              ${hotMeta ? renderPersonaHotOrigin(hotMeta, { compact: true }) : ""}
              ${hotMeta ? renderPersonaHotInfo(hotMeta, post.id) : ""}
            </div>
            <div class="persona-draft-table-cell persona-draft-table-time" role="cell" data-mobile-label="更新时间">${esc(formatTime(post.published_at || post.updated_at || post.created_at))}</div>
            <div class="persona-draft-table-cell persona-draft-table-content" role="cell" data-mobile-label="内容">${esc(String(post.content || "").slice(0, 48))}</div>
            <div class="persona-draft-table-cell" role="cell" data-mobile-label="状态"><span class="module-chip ${isSelected ? "is-dark" : ""}">${isSelected ? "当前选中" : "待选择"}</span></div>
            <div class="persona-draft-table-actions" role="cell" data-mobile-label="操作">
              ${renderPersonaDraftPostActions(post, { source, isSelected })}
            </div>
          </article>`;
      }).join("")}
    </div>`;
}

function renderPersonaPostBulkActions(persona, source, rows) {
  const cleanSource = source === "favorites" ? "favorites" : "posts";
  const selectedIds = syncPersonaSelectedPostIds(persona, cleanSource, rows);
  const selectedCount = selectedIds.length;
  const actionLabel = cleanSource === "favorites" ? "批量移出" : "批量删除";
  return `
    <div class="persona-post-bulk-actions">
      <strong>已勾选 ${selectedCount} / ${rows.length}</strong>
      <div class="row-actions">
        <button type="button" data-persona-post-bulk="all" data-persona-post-bulk-source="${esc(cleanSource)}">全选</button>
        <button type="button" data-persona-post-bulk="clear" data-persona-post-bulk-source="${esc(cleanSource)}">清空</button>
        <button type="button" class="danger" data-persona-post-bulk="delete" data-persona-post-bulk-source="${esc(cleanSource)}" ${selectedCount ? "" : "disabled"}>${actionLabel}</button>
      </div>
    </div>`;
}

async function viewPersonaDraftPost(postId = "") {
  const persona = selectedPersona();
  const source = personaPostSource(persona);
  const posts = personaSourcePosts(persona, source);
  const post = posts.find((item) => String(item.id) === String(postId || "")) || posts.find((item) => String(item.id) === String(state.selectedPersonaPostId || "")) || posts[0];
  if (!persona || !post) return;
  const hotMeta = personaHotImportMeta(String(persona.id || ""), post.id);
  const mediaItems = personaDraftMediaItems(String(persona.id || ""), post);
  await openConsoleModal({
    title: source === "favorites" ? "收藏详情" : "草稿详情",
    contentHtml: `
      <div class="console-modal-detail persona-draft-detail-modal">
        <div><span>${source === "favorites" ? "收藏标题" : "草稿标题"}</span><strong>${esc(personaDraftDisplayTitleForPost(post, posts))}</strong></div>
        <div><span>所属人设</span><strong>${esc(persona.name || "未命名人设")}</strong></div>
        <div><span>内容类型</span>${renderMediaTypeBadge(mediaItems)}</div>
        <div><span>时间信息</span><strong>${esc(formatTime(post.published_at || post.updated_at || post.created_at))}</strong></div>
        <div><span>当前状态</span><strong>${esc(String(post.id) === String(state.selectedPersonaPostId || "") ? "当前选中" : "待选择")}</strong></div>
        ${hotMeta ? `<div class="persona-draft-detail-hot"><span>热点数据</span>${renderPersonaHotDetail(hotMeta)}</div>` : ""}
        <div class="persona-draft-detail-content">
          <span>推文正文</span>
          <p>${esc(String(post.content || "暂无正文"))}</p>
          ${renderPersonaDraftDetailMedia(mediaItems)}
        </div>
      </div>
    `,
    confirmText: "关闭",
    showCancel: false,
  });
}

async function refreshPersonaHotPost(postId = "", trigger = null) {
  const persona = selectedPersona();
  const cleanPostId = String(postId || "").trim();
  if (!persona || !cleanPostId) return;
  if (trigger) {
    trigger.disabled = true;
    trigger.classList.add("is-loading");
  }
  try {
    const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts/${encodeURIComponent(cleanPostId)}/hot_metrics/refresh`, { method: "POST" });
    const updated = result?.post;
    if (!updated?.id) throw new Error("热点数据刷新后未返回草稿。");
    const key = String(persona.id);
    state.personaDraftPosts[key] = (state.personaDraftPosts[key] || []).map((post) => String(post.id) === cleanPostId ? updated : post);
    savePersonaPostRows(key, "posts", state.personaDraftPosts[key]);
    renderPersonaDetail();
    renderConfirmSummary();
    showMsg("commandMsg", "热点数据已更新。", true);
  } finally {
    if (trigger?.isConnected) {
      trigger.disabled = false;
      trigger.classList.remove("is-loading");
    }
  }
}

function renderPersonaMemoryOptions(persona, selectedIds = []) {
  const rows = state.personaMemories[String(persona.id)] || [];
  const safeRows = Array.isArray(rows) ? rows : [];
  const selected = new Set((selectedIds || []).map((item) => String(item || "")));
  return `
    <div class="persona-memory-panel">
      <div class="persona-memory-toolbar">
        <strong>已选 <span id="personaMemorySelectedCount">${selected.size}</span> / ${safeRows.length}</strong>
        <label class="persona-memory-search">
          <input id="personaMemorySearch" type="search" placeholder="筛选记忆内容" />
        </label>
        <div class="persona-memory-actions" aria-label="人设记忆操作">
          <button type="button" data-persona-create-memory title="新建记忆" aria-label="新建记忆">${renderPlusIcon()}</button>
          <button type="button" data-persona-memory-bulk="all" title="全选记忆" aria-label="全选记忆" ${safeRows.length ? "" : "disabled"}>${renderSelectAllIcon()}</button>
          <button type="button" data-persona-memory-bulk="clear" title="清空选择" aria-label="清空选择" ${selected.size ? "" : "disabled"}>${renderClearSelectionIcon()}</button>
        </div>
      </div>
      ${safeRows.length ? `<div class="persona-memory-grid">
        ${safeRows.map((row, index) => {
          const isSelected = selected.has(String(row.id || ""));
          const summary = String(row.summary || "未命名记忆");
          return `
            <article class="persona-memory-card ${isSelected ? "is-selected" : ""}" data-persona-memory-search="${esc(summary.toLowerCase())}">
              <label class="persona-memory-card-main">
                <span class="persona-memory-index">${esc(index + 1)}</span>
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
              </label>
              <button type="button" class="danger persona-memory-delete" data-persona-delete-memory="${esc(row.id)}" title="删除记忆" aria-label="删除记忆">${renderTrashIcon()}</button>
            </article>`;
        }).join("")}
      </div>` : `<div class="empty-state">当前还没有可选人设记忆，点击“新建记忆”图标即可添加。</div>`}
    </div>`;
}

function syncPersonaMemorySelectionState() {
  const cards = [...document.querySelectorAll(".persona-memory-card")];
  cards.forEach((card) => {
    const input = card.querySelector("[data-persona-memory-id]");
    card.classList.toggle("is-selected", Boolean(input?.checked));
  });
  const countNode = $("personaMemorySelectedCount");
  const selectedCount = document.querySelectorAll("[data-persona-memory-id]:checked").length;
  if (countNode) {
    countNode.textContent = String(selectedCount);
  }
  const clearButton = document.querySelector('[data-persona-memory-bulk="clear"]');
  if (clearButton) clearButton.disabled = selectedCount === 0;
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
    if (cachedRows.length || !fallbackRows.length) return cachedRows.filter(isPublishHistoryPostRecord);
  }
  return fallbackRows.filter(isPublishHistoryPostRecord);
}

function isPublishHistoryPostRecord(record = {}) {
  if (!record || typeof record !== "object") return false;
  const taskType = String(record.automation_task_type || record.automationTaskType || record.task_type || record.taskType || "").trim().toLowerCase();
  if (taskType && taskType !== "publish_post") return false;
  const hasMedia = [record.media_items, record.mediaItems, record.media, record.attachments]
    .some((items) => Array.isArray(items) && items.length > 0)
    || Boolean(String(record.media_url || record.mediaUrl || record.image_url || record.imageUrl || record.video_url || record.videoUrl || "").trim());
  return Boolean(String(record.content || record.caption || "").trim() || hasMedia);
}

function personaPublishPreview(post) {
  if (!post) return `<div class="empty-state">请先在“推文草稿”里创建并选中一条推文。</div>`;
  const personaId = String(selectedPersona()?.id || "");
  const hotMeta = personaHotImportMeta(personaId, post.id);
  return `
    <div class="flow-box">
      <span>当前草稿</span>
      <strong>${esc(personaDraftDisplayTitleForPost(post))}</strong>
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

function personaPresetById(profile, presetId) {
  const target = String(presetId || "").trim();
  if (!target) return null;
  return personaProfilePresets(profile).find((item) => String(item.id) === target) || null;
}

function personaLinkPageKey() {
  return String(selectedPersona()?.id || state.selectedPersonaId || "default");
}

function personaLinkPresetPage(totalItems = 0) {
  const key = personaLinkPageKey();
  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(Number(totalItems || 0) / pageSize));
  const page = Math.min(Math.max(Number(state.personaLinkPresetPages[key] || 1), 1), totalPages);
  state.personaLinkPresetPages[key] = page;
  return { key, page, pageSize, totalPages };
}

function setPersonaLinkPresetPage(page) {
  const key = personaLinkPageKey();
  state.personaLinkPresetPages[key] = Math.max(Number(page || 1), 1);
}

function renderPersonaLinkPresetPager(pageInfo, totalItems) {
  if (Number(totalItems || 0) <= pageInfo.pageSize) return "";
  const page = Number(pageInfo.page || 1);
  const totalPages = Number(pageInfo.totalPages || 1);
  return `
    <div class="persona-link-pager">
      <span>${esc(page)} / ${esc(totalPages)} · 每页 ${esc(pageInfo.pageSize)}</span>
      <button type="button" data-persona-link-page="first" ${page <= 1 ? "disabled" : ""}>首页</button>
      <button type="button" data-persona-link-page="prev" ${page <= 1 ? "disabled" : ""}>上页</button>
      <button type="button" data-persona-link-page="next" ${page >= totalPages ? "disabled" : ""}>下页</button>
      <button type="button" data-persona-link-page="last" ${page >= totalPages ? "disabled" : ""}>尾页</button>
    </div>`;
}

function renderPersonaLinkPresetTable(profile, presets, selectedPresetId) {
  if (!presets.length) {
    return `<div class="empty-state">暂无链接模板。左侧填写参数后新增。</div>`;
  }
  const activeId = String(profile?.active_link_preset_id || "").trim();
  const pageInfo = personaLinkPresetPage(presets.length);
  const pagePresets = presets.slice((pageInfo.page - 1) * pageInfo.pageSize, pageInfo.page * pageInfo.pageSize);
  return `
    <div class="persona-link-table-wrap">
      <div class="persona-link-table" role="table" aria-label="链接模板列表">
        <div class="persona-link-table-head" role="row">
          <span>序号</span>
          <span>模板</span>
          <span>链接</span>
          <span>结尾文案</span>
          <span>状态</span>
          <span>操作</span>
        </div>
        ${pagePresets.map((item, index) => {
          const presetId = String(item.id || "").trim();
          const isSelected = presetId === String(selectedPresetId || "");
          const isActive = presetId === activeId;
          const displayIndex = (pageInfo.page - 1) * pageInfo.pageSize + index + 1;
          return `
            <article class="persona-link-row ${isSelected ? "is-selected" : ""}" role="row" data-persona-select-preset="${esc(presetId)}">
              <div class="persona-link-cell persona-link-index" role="cell">${esc(displayIndex)}</div>
              <div class="persona-link-cell persona-link-name" role="cell">
                <strong>${esc(item.name || presetId || "链接模板")}</strong>
              </div>
              <div class="persona-link-cell" role="cell">${item.link_url ? `<a href="${esc(item.link_url)}" target="_blank" rel="noreferrer">${esc(item.link_url)}</a>` : `<span class="muted">未填写</span>`}</div>
              <div class="persona-link-cell persona-link-ending" role="cell">${esc(item.ending_text || "未填写")}</div>
              <div class="persona-link-cell" role="cell">
                <span class="module-chip ${isActive ? "is-dark" : ""}">${isActive ? "当前启用" : "未启用"}</span>
              </div>
              <div class="persona-link-actions" role="cell">
                <button type="button" data-persona-view-preset="${esc(presetId)}">查看</button>
                <button type="button" class="danger" data-persona-delete-preset-id="${esc(presetId)}">删除</button>
              </div>
            </article>`;
        }).join("")}
      </div>
    </div>
    ${renderPersonaLinkPresetPager(pageInfo, presets.length)}`;
}

function personaAutomationTaskTypesForStep(step) {
  if (step === "login") return ["open_login"];
  if (step === "reply_comment" || step === "reply_hot") return ["threads_auto_reply"];
  if (step === "warmup") return ["threads_warmup"];
  if (["open_login", "browse_feed", "browse_profile", "comment_post", "reply_comment", "like_post", "share_post", "threads_auto_reply"].includes(String(step || ""))) return [String(step)];
  return [];
}

function personaAutomationResultKey(accountId, step) {
  return `${String(accountId || "").trim()}:${String(step || "").trim()}`;
}

function personaSettingsLoadingPanel() {
  return `<div class="persona-inline-panel"><strong>正在加载人设设置...</strong><p>人设 profile 载入后，这里会显示可编辑设置。</p></div>`;
}

function renderPersonaAccountPanel(persona, account, profile, step) {
  const accounts = personaAccounts(persona);
  return `
    <div class="persona-inline-panel persona-account-summary-panel">
      <strong>账号设置已统一管理</strong>
      <p>登录状态、养号、自动回复等操作已集中到“账号管理自动化”。这里仅保留当前人设的账号状态概览。</p>
      <div class="persona-metrics persona-account-summary-metrics">
        <div><span>执行账号</span><strong>${esc(`${accounts.length} 个`)}</strong></div>
        <div><span>可发布账号</span><strong>${esc(`${publishAccountsForPersona(persona).length} 个`)}</strong></div>
        <div><span>当前账号</span><strong>${esc(account ? (account.username || account.id) : "未选择")}</strong></div>
      </div>
      ${accounts.length ? `
        <div class="compact-list">
          ${accounts.map((item) => `
            <article class="compact-row">
              <strong>${esc(item.username || item.id)}</strong>
              <p>${esc(`${platformLabel(item.platform || "")} · ${statusLabel(item.status || "")}`)}</p>
            </article>`).join("")}
        </div>
      ` : `<div class="empty-state">当前人设还没有绑定浏览器执行账号。</div>`}
      <div class="row-actions">
        <button type="button" class="primary" data-open-unified-automation>进入账号管理自动化</button>
      </div>
    </div>`;
}

function personaProfileMode(personaId) {
  const key = String(personaId || "").trim();
  const mode = key ? state.personaProfileModes[key] : "";
  return ["edit", "style"].includes(mode) ? mode : "overview";
}

function renderPersonaProfileModeTabs(mode) {
  const activeMode = ["edit", "style"].includes(mode) ? mode : "overview";
  return `<div class="persona-step-tabs persona-subflow-tabs persona-profile-mode-tabs automation-capsule-tabs" role="tablist" aria-label="基础资料视图">${[
    ["overview", "内容概览"],
    ["edit", "编辑资料"],
    ["style", "推文风格"],
  ].map(([value, label]) => `
    <button
      type="button"
      class="${activeMode === value ? "is-active" : ""}"
      data-persona-profile-mode="${esc(value)}"
      role="tab"
      aria-selected="${activeMode === value ? "true" : "false"}"
    >${esc(label)}</button>
  `).join("")}</div>`;
}

function renderPersonaHotSummaryCard(persona) {
  const hot = persona?.hot || {};
  const stats = [
    ["热度", Number(hot.hot_score || 0)],
    ["点赞", Number(hot.likes || 0)],
    ["评论", Number(hot.comments || 0)],
    ["分享", Number(hot.shares || 0)],
    ["转发", Number(hot.reposts || 0)],
  ];
  const hasHotData = stats.some(([, value]) => Number(value || 0) > 0);
  return `
    <aside class="persona-hot-summary-card">
      <div class="persona-hot-summary-head">
        <span>热点数据</span>
        <strong>${hasHotData ? "已同步" : "暂无热点统计"}</strong>
      </div>
      <div class="persona-hot-summary-metrics">
        ${stats.map(([label, value]) => `
          <div>
            <span>${esc(label)}</span>
            <strong>${esc(numberText(value))}</strong>
          </div>
        `).join("")}
      </div>
    </aside>`;
}

function renderPersonaContentOverview(persona, account, profile) {
  const drafts = personaDraftPosts(persona);
  const historyRows = personaPublishHistoryRows(persona);
  const accounts = uniqueAccountOptions(personaAccounts(persona));
  const publishAccount = publishAccountForPersona(persona);
  const personaId = String(persona?.id || "");
  const draftCount = Array.isArray(state.personaDraftPosts[personaId]) ? drafts.length : personaOverviewDraftCount(persona);
  const accountCount = accounts.length || Math.max(0, Number(persona?.counts?.accounts || 0));
  const latestDraft = sortPersonaDraftPosts(drafts)[0] || null;
  const latestHistory = historyRows[0] || null;
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
        <div><span>草稿</span><strong>${esc(draftCount)}</strong></div>
        <div><span>已发布</span><strong>${esc(Number(persona?.counts?.published || historyRows.length || 0))}</strong></div>
        <div><span>账号</span><strong>${esc(accountCount)}</strong></div>
      </div>
      <div class="form-grid">
        <div class="flow-box">
          <span>执行账号</span>
          <strong>${esc(account ? `${account.username || account.id} · ${platformLabel(account.platform || "")}` : "未绑定")}</strong>
          <span>${esc(account ? `${statusLabel(account.status || "")}${accounts.length > 1 ? ` · 共 ${accounts.length} 个账号` : ""}` : "到“账号管理自动化”绑定账号")}</span>
          <span>${esc(publishAccount ? (isReadyPublishAccount(publishAccount) ? `可发布：${publishPlatformLabel(publishAccount)} · ${publishPlatformHint(publishAccount)}` : publishAccountBlockMessage(publishAccount)) : "还没有绑定发布账号")}</span>
        </div>
        <div class="flow-box">
          <span>最近草稿</span>
          <strong>${esc(latestDraft ? personaDraftDisplayTitleForPost(latestDraft, drafts) : "暂无草稿")}</strong>
          <span>${esc(latestDraft ? formatTime(latestDraft.updated_at || latestDraft.created_at) : "先到推文生成里新建推文")}</span>
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

function renderPersonaImagePanel(persona) {
  const imageRunState = personaGenerateRunState(persona.id);
  const imageBusy = isActionLocked("persona", persona.id, "image_generate")
    || (String(imageRunState?.kind || "") === "persona_image" && String(imageRunState?.status || "") === "running");
  const imageBusyStartedAt = actionTaskStartedAt(imageRunState, "persona", persona.id, "image_generate");
  const library = personaImageLibraryState(persona.id);
  const libraryItems = Array.isArray(library?.items) ? library.items : [];
  const hasImages = libraryItems.length > 0;
  const hasCurrentReference = Boolean(
    String(library?.current_reference_url || "").trim()
    || libraryItems.some((item) => item && (item.is_reference || item.isReference))
  );
  const imageIntro = hasCurrentReference
    ? "当前已有可用人设图，重新生成会产出新图，原图库仍会保留。"
    : (hasImages ? "图库里已有历史图，可以先设为当前，也可以重新生成一张。" : "先生成一张人设图，生成后会进入图库。");
  const generateLabel = imageBusy
    ? "正在生成..."
    : (hasCurrentReference ? "重新生成人设图" : "生成人设图");
  return `
    <div class="persona-profile-section" id="personaImageGenerationSection" data-persona-image-generation-section>
      <div class="persona-head-copy">
        <strong>人设图</strong>
        <span class="persona-panel-intro">${esc(imageIntro)}</span>
      </div>
      <div class="row-actions">
        <button type="button" class="primary" data-persona-generate-image ${imageBusy ? "disabled" : ""}>${renderBusyButtonContent(generateLabel, imageBusy, imageBusyStartedAt)}</button>
        <input id="personaImageUploadFile" type="file" accept=".png,.jpg,.jpeg,.webp,.bmp,.gif,.tif,.tiff,.heic" data-persona-upload-image-file hidden />
      </div>
      <div class="persona-inline-panel persona-inline-panel--nested">
        <strong>图库预览</strong>
        ${renderPersonaImageLibraryGrid(library)}
      </div>
    </div>`;
}

function renderPersonaSettingsPanelV2(persona, account, profile, step) {
  const effectiveProfile = profile || fallbackPersonaProfile(persona);
  if (!profile && persona?.id) loadPersonaProfile(persona.id).catch(() => {});
  profile = effectiveProfile;
  const presets = personaProfilePresets(profile);
  const selectedPreset = selectedPersonaPreset(profile);
  const selectedPresetId = String(selectedPreset?.id || "");
  const currentStep = step || "profile";
  if (currentStep === "account") {
    return `
      <div class="persona-inline-panel">
        <div class="persona-head-copy">
          <strong>账号设置</strong>
          <span class="persona-panel-intro">集中查看和编辑当前人设可用账号；账号绑定统一在账号管理自动化中维护。</span>
        </div>
        ${renderPersonaAccountPanelV2(persona, account, profile, "binding")}
      </div>`;
  }
  if (currentStep === "links") {
    return `
      <div class="persona-inline-panel">
        <div class="persona-head-copy">
          <strong>链接设置</strong>
          <span class="persona-panel-intro">左侧编辑模板参数，右侧查看和管理全部模板。</span>
        </div>
        <div class="persona-link-layout">
          <section class="persona-link-editor">
            <div class="persona-head-copy">
              <strong>${selectedPreset ? "编辑模板" : "新增模板"}</strong>
              <span class="persona-panel-intro">${selectedPreset ? "修改当前选中的链接模板。" : "填写后新增为链接模板。"}</span>
            </div>
            <label>模板名称
              <input id="personaLinkPresetName" value="${esc(selectedPreset?.name || "")}" placeholder="例如：预约咨询" />
            </label>
            <label>链接地址
              <input id="personaLinkPresetUrl" value="${esc(selectedPreset?.link_url || "")}" placeholder="https://example.com" />
            </label>
            <label>结尾文案
              <textarea id="personaLinkPresetEnding" rows="5" placeholder="发布时附加在推文结尾。">${esc(selectedPreset?.ending_text || "")}</textarea>
            </label>
            <div class="row-actions persona-link-editor-actions">
              <button type="button" class="primary" data-persona-add-preset>新增模板</button>
              <button type="button" data-persona-save-preset ${selectedPreset ? "" : "disabled"}>保存当前</button>
              <button type="button" data-persona-activate-preset ${selectedPreset ? "" : "disabled"}>设为启用</button>
            </div>
          </section>
          <section class="persona-link-list-panel">
            <div class="persona-link-list-head">
              <div>
                <strong>模板列表</strong>
                <span>${esc(presets.length)} 个模板</span>
              </div>
              <span class="module-chip">${selectedPreset ? `正在编辑：${selectedPreset.name || selectedPreset.id}` : "未选择"}</span>
            </div>
            ${renderPersonaLinkPresetTable(profile, presets, selectedPresetId)}
          </section>
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
  const regenState = state.personaProfileRegenDrafts[String(persona.id || "")];
  const isProfileRegenEditing = Boolean(regenState?.active);
  const profileEditName = isProfileRegenEditing
    ? String(regenState.name || "")
    : String(profile.name || persona.name || persona.id);
  const profileEditContent = isProfileRegenEditing
    ? String(regenState.content || "")
    : String(profile.content || persona.content || "");
  return `
    <div class="persona-inline-panel">
      <div class="persona-head-copy">
        <strong>基础资料</strong>
        <span class="persona-panel-intro">集中查看人设内容概览，右侧同步展示热点概览，也可以切换到编辑资料。</span>
      </div>
      <div class="persona-profile-overview-bar">
        ${renderPersonaProfileModeTabs(profileMode)}
        ${renderPersonaHotSummaryCard(persona)}
      </div>
      ${profileMode === "edit" ? `
        <div class="persona-profile-edit-layout">
          <section class="persona-profile-edit-main ${isProfileRegenEditing ? "is-regen-editing" : ""}">
            ${isProfileRegenEditing ? `
              <div class="persona-temp-edit-toolbar">
                <span>临时编辑中：填写新的生成方向后确认生成。</span>
                <div class="persona-temp-edit-actions">
                  <button type="button" data-persona-clear-profile-regen>清空</button>
                  <button type="button" data-persona-exit-profile-regen>退出编辑</button>
                </div>
              </div>
            ` : ""}
            <div class="form-grid">
              <label>人设名称
                <input id="personaProfileName" value="${esc(profileEditName)}" />
              </label>
            </div>
            <label>
              <span class="persona-profile-field-head">
                <span>人设简介</span>
              </span>
              <textarea
                id="personaProfileContent"
                class="${isProfileRegenEditing ? "persona-profile-regen-input" : ""}"
                rows="10"
                placeholder="${isProfileRegenEditing ? "输入新的方向、身份、语气和内容边界，用于重新生成人设简介。" : "编辑并保存当前人设简介。"}"
              >${esc(profileEditContent)}</textarea>
            </label>
            <div class="row-actions">
              <button type="button" class="primary" data-persona-save-profile ${isProfileRegenEditing ? "disabled" : ""}>保存资料</button>
              <button type="button" data-persona-regenerate-profile-content aria-busy="${state.personaCreateBusy?.profileContent ? "true" : "false"}" ${state.personaCreateBusy?.profileContent ? "disabled" : ""}>${state.personaCreateBusy?.profileContent ? "正在生成..." : (isProfileRegenEditing ? "确认生成" : "AI 重新生成")}</button>
            </div>
          </section>
          <aside class="persona-profile-image-side">
            ${renderPersonaImagePanel(persona)}
          </aside>
        </div>
      ` : profileMode === "style" ? `
        <div class="persona-inline-panel persona-inline-panel--nested">
          <strong>推文风格</strong>
          <label>风格样例
            <textarea id="personaTweetStyleSample" rows="8" placeholder="粘贴一条代表性推文，保存后自动提取风格。">${esc(profile.tweet_style_sample || "")}</textarea>
          </label>
          <div class="flow-box"><span>提取结果</span><strong>${esc(profile.tweet_style_profile || "尚未提取")}</strong></div>
          <div class="row-actions">
            <button type="button" data-persona-save-style>保存风格</button>
            <button type="button" data-persona-clear-style ${profile.tweet_style_sample ? "" : "disabled"}>清空风格</button>
          </div>
        </div>
      ` : renderPersonaContentOverview(persona, account, profile)}
    </div>`;
}

function renderPersonaAccountPanelV2(persona, account, profile, step) {
  const platform = selectedPersonaAutomationPlatform();
  const accounts = personaAutomationAccounts(persona, platform);
  const selectedAccount = selectedPersonaAutomationAccount(persona, platform);
  const platformOptions = personaAutomationPlatformOptions(persona);
  const renderPlatformTab = (value) => {
    const rows = personaAutomationAccounts(persona, value);
    return `<button type="button" class="${platform === value ? "is-active" : ""}" data-persona-account-platform="${esc(value)}">
      <strong>${esc(platformLabel(value))}</strong>
      <span>${esc(`${rows.length} 个账号`)}</span>
    </button>`;
  };
  return `
    <div class="persona-account-pool-layout">
      <section class="account-pool-platform-panel persona-account-platform-panel">
        <div class="account-pool-section-head">
          <strong>平台</strong>
          <span>切换账号池</span>
        </div>
        <div class="account-pool-platforms" aria-label="账号平台">
          ${platformOptions.map(renderPlatformTab).join("")}
        </div>
      </section>
      <section class="account-pool-account-panel persona-account-pool-panel">
        <div class="account-pool-section-head">
          <strong>账号</strong>
          <span>${esc(selectedAccount ? `当前账号：${accountDisplayName(selectedAccount)}` : "当前平台暂无已绑定账号")}</span>
        </div>
        <div class="account-pool-list">
          ${accounts.length ? accounts.map((item) => renderAccountPoolCard(item, {
            variant: "persona-settings",
            active: String(item.id || "") === String(selectedAccount?.id || ""),
          })).join("") : `<div class="empty-state">当前平台没有可用账号。请到账号管理自动化的账号池中添加或绑定账号。</div>`}
        </div>
      </section>
    </div>
  `;
}

function personaAutomationTasksFor(personaId, limit = 0) {
  const rows = state.socialTasks
    .filter((item) => String(item.persona_id || "") === String(personaId || ""))
    .sort((left, right) => timeValue(right.updated_at || right.created_at || 0) - timeValue(left.updated_at || left.created_at || 0));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

function paginateTaskQueueRows(rows, page = 1, pageSize = 1) {
  const cleanPageSize = Math.max(1, Number(pageSize || 1));
  const totalItems = Array.isArray(rows) ? rows.length : 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / cleanPageSize));
  const currentPage = Math.min(Math.max(Number(page || 1), 1), totalPages);
  const start = (currentPage - 1) * cleanPageSize;
  return {
    items: (rows || []).slice(start, start + cleanPageSize),
    page: currentPage,
    pageSize: cleanPageSize,
    totalItems,
    totalPages,
  };
}

function renderTaskQueuePager(kind, pageInfo) {
  return `
    <div class="persona-list-pager task-queue-pager">
      <button type="button" data-task-queue-page="${esc(`${kind}:prev`)}" title="上一页" aria-label="上一页" ${pageInfo.page <= 1 ? "disabled" : ""}><span class="ui-arrow-icon ui-arrow-icon--left" aria-hidden="true"></span></button>
      <span>${esc(`${pageInfo.page} / ${pageInfo.totalPages} · 共 ${pageInfo.totalItems} 条`)}</span>
      <button type="button" data-task-queue-page="${esc(`${kind}:next`)}" title="下一页" aria-label="下一页" ${pageInfo.page >= pageInfo.totalPages ? "disabled" : ""}><span class="ui-arrow-icon ui-arrow-icon--right" aria-hidden="true"></span></button>
    </div>`;
}

function renderTaskQueuePanelTabs(active = "persona") {
  const tabs = [
    ["persona", "人设队列"],
    ["regular", "通用队列"],
  ];
  return `<div class="persona-step-tabs task-queue-panel-tabs" aria-label="任务队列切换">${tabs.map(([value, label]) => `
    <button
      type="button"
      class="${active === value ? "is-active" : ""}"
      data-task-queue-panel="${esc(value)}"
    >${esc(label)}</button>
  `).join("")}</div>`;
}

function renderTaskQueueBulkControls(kind) {
  const summary = taskQueueSelectionSummary(kind);
  return `
    <div class="task-queue-bulk-controls" aria-label="批量操作">
      <button type="button" data-task-queue-select-all="${esc(kind)}" ${summary.total ? "" : "disabled"}>${summary.allSelected ? "取消全选" : "全选当前页"}</button>
      <span class="task-queue-selection-count">${esc(`已选 ${summary.selected} / ${summary.total}`)}</span>
      <button type="button" class="danger" data-task-queue-delete-selected="${esc(kind)}" ${summary.selected ? "" : "disabled"}>删除选中</button>
    </div>`;
}

function renderTrashIcon() {
  return `<svg class="ui-trash-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M3 6h18"></path>
    <path d="M8 6V4h8v2"></path>
    <path d="M6 6l1 15h10l1-15"></path>
    <path d="M10 11v6"></path>
    <path d="M14 11v6"></path>
  </svg>`;
}

function renderPlusIcon() {
  return `<svg class="ui-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 5v14"></path>
    <path d="M5 12h14"></path>
  </svg>`;
}

function renderSelectAllIcon() {
  return `<svg class="ui-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="4" y="4" width="16" height="16" rx="3"></rect>
    <path d="m8 12 2.5 2.5L16 9"></path>
  </svg>`;
}

function renderClearSelectionIcon() {
  return `<svg class="ui-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="4" y="4" width="16" height="16" rx="3"></rect>
    <path d="m9 9 6 6"></path>
    <path d="m15 9-6 6"></path>
  </svg>`;
}

function renderEyeIcon() {
  return `<svg class="ui-eye-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>
    <circle cx="12" cy="12" r="2.5"></circle>
  </svg>`;
}

function renderExpandIcon(expanded = false) {
  return expanded
    ? `<svg class="ui-expand-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M9 4v5H4"></path><path d="m4 9 5-5"></path>
        <path d="M15 20v-5h5"></path><path d="m20 15-5 5"></path>
      </svg>`
    : `<svg class="ui-expand-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M9 4H4v5"></path><path d="m4 4 5 5"></path>
        <path d="M15 20h5v-5"></path><path d="m20 20-5-5"></path>
      </svg>`;
}

function renderRefreshIcon() {
  return `<svg class="ui-action-icon ui-refresh-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M21 12a9 9 0 0 0-15.17-6.49L3 8"></path>
    <path d="M3 3v5h5"></path>
    <path d="M3 12a9 9 0 0 0 15.17 6.49L21 16"></path>
    <path d="M16 16h5v5"></path>
  </svg>`;
}

function renderInfoIcon() {
  return `<svg class="ui-action-icon ui-info-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="10"></circle>
    <path d="M12 16v-4"></path>
    <path d="M12 8h.01"></path>
  </svg>`;
}

function renderReplaceIcon() {
  return `<svg class="ui-replace-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M20 7h-8a5 5 0 0 0-5 5"></path>
    <path d="m17 4 3 3-3 3"></path>
    <path d="M4 17h8a5 5 0 0 0 5-5"></path>
    <path d="m7 20-3-3 3-3"></path>
  </svg>`;
}

function renderUndoIcon() {
  return `<svg class="ui-undo-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path>
    <path d="M3 3v5h5"></path>
  </svg>`;
}

function isFutureScheduledSocialTask(task) {
  return String(task?.status || "").trim() === "queued"
    && timeValue(task?.scheduled_at) > Date.now() + 1000;
}

function renderSocialQueueTaskStatus(task) {
  if (!isFutureScheduledSocialTask(task)) return renderStatusText(socialTaskPresentationStatus(task));
  return `<span class="task-status-text is-queued">定时等待</span>`;
}

function socialTaskDisplayStatus(task) {
  return isFutureScheduledSocialTask(task) ? "定时等待" : statusLabel(socialTaskPresentationStatus(task));
}

function socialQueueTaskTime(task) {
  if (isFutureScheduledSocialTask(task)) return `计划 ${formatScheduledTime(task.scheduled_at)}`;
  return formatTime(task.updated_at || task.created_at || "");
}

function renderPersonaQueueRows(rows) {
  return rows.map((task) => `
    <article class="compact-row task-persona-queue-row">
      <label class="task-queue-check-label task-queue-row-check">
        <input type="checkbox" data-task-queue-select="persona:${esc(task.id)}" ${state.taskQueueSelectedPersonaIds.has(String(task.id || "")) ? "checked" : ""} />
        <span class="sr-only">选择</span>
      </label>
      <div class="task-persona-queue-type" data-mobile-label="任务">
        <strong>${esc(statusLabel(task.task_type || ""))}</strong>
      </div>
      <div class="task-persona-queue-platform" data-mobile-label="平台">${esc(queuePlatformLabel(task.platform || ""))}</div>
      <div class="task-persona-queue-account" data-mobile-label="账号">${esc(task.account_username || task.account_id || "-")}</div>
      <div class="task-persona-queue-time" data-mobile-label="时间">${esc(socialQueueTaskTime(task))}</div>
      <div data-mobile-label="状态">${renderSocialQueueTaskStatus(task)}</div>
      <div class="row-actions" data-mobile-label="操作">
        <button type="button" data-social-log="${esc(task.id)}">日志</button>
        ${task.status === "failed" && task?.result?.retryable !== false ? `<button type="button" data-social-retry="${esc(task.id)}">重试</button>` : ""}
        ${activeSocialAutomationTask(task) ? `<button type="button" class="muted" data-social-cancel="${esc(task.id)}">取消</button>` : ""}
        <button type="button" class="danger task-queue-delete-button" data-social-delete="${esc(task.id)}" title="删除" aria-label="删除">${renderTrashIcon()}</button>
      </div>
    </article>
  `).join("");
}

function renderTaskQueuePersonaSelectorCard(persona) {
  const queueRows = personaAutomationTasksFor(persona.id);
  const selected = String(persona.id || "") === String(selectedPersona()?.id || "");
  const activeCount = queueRows.filter(activeSocialAutomationTask).length;
  return `
    <article class="persona-list-card task-persona-card ${selected ? "is-active" : ""}">
      <button type="button" class="persona-list-item" data-task-persona-select="${esc(persona.id)}">
        <span class="persona-card-title">
          <strong>${esc(persona.name || persona.id || "未命名人设")}</strong>
          ${renderPersonaKindBadge(persona)}
          <span class="persona-kind-badge">${esc(`${queueRows.length} 条`)}</span>
        </span>
        <small>${esc(personaExecutionAccountLabel(persona))}</small>
        <small>${esc(activeCount ? `执行中 ${activeCount} 条` : "当前无执行中任务")}</small>
      </button>
    </article>`;
}

function renderTaskQueuePersonaSelector() {
  const current = selectedPersona();
  return `
    <aside class="persona-list-shell task-queue-persona-shell">
      <div class="persona-inline-panel persona-list-toolbar">
        <div class="persona-list-head persona-list-head--queue">
          <div class="persona-head-copy">
            <strong>人设队列</strong>
            <span>点击切换右侧人设自动化队列</span>
          </div>
          <div class="task-queue-sidebar-tools">
            <button type="button" data-task-refresh>刷新队列</button>
            <span>${esc(`${state.personas.length} 个`)}</span>
          </div>
        </div>
      </div>
      <div class="persona-list-scroll">
        <div class="persona-list-stack">
          ${state.personas.length ? state.personas.map((persona) => renderTaskQueuePersonaSelectorCard(persona)).join("") : `<div class="empty-state">当前还没有人设。</div>`}
        </div>
      </div>
      <div class="persona-inline-panel task-queue-persona-meta">
        <strong>${esc(current?.name || "未选择人设")}</strong>
        <span>${esc(current ? `当前查看 ${personaAutomationTasksFor(current.id).length} 条自动化任务` : "选中一张人设卡后查看对应队列")}</span>
      </div>
    </aside>`;
}

function renderTaskQueueView() {
  const persona = selectedPersona();
  const personaPageSize = Math.min(Math.max(Number(state.taskQueuePersonaPageSize || 12), 1), 100);
  const regularPageSize = Math.min(Math.max(Number(state.taskQueueRegularPageSize || 20), 1), 100);
  const personaPageInfo = paginateTaskQueueRows(
    persona ? personaAutomationTasksFor(persona.id) : [],
    state.taskQueuePersonaPage,
    personaPageSize,
  );
  state.taskQueuePersonaPage = personaPageInfo.page;
  const personaTasks = personaPageInfo.items;
  const regularPageInfo = paginateTaskQueueRows(
    state.tasks,
    state.taskQueueRegularPage,
    regularPageSize,
  );
  state.taskQueueRegularPage = regularPageInfo.page;
  const regularTasksHtml = regularPageInfo.totalItems ? regularPageInfo.items.map((task) => `
    <article class="compact-row task-row">
      <label class="task-queue-check-label task-queue-row-check">
        <input type="checkbox" data-task-queue-select="regular:${esc(task.id)}" ${state.taskQueueSelectedRegularIds.has(String(task.id || "")) ? "checked" : ""} />
        <span class="sr-only">选择</span>
      </label>
      <div data-mobile-label="任务"><strong>${esc(task.workflow_name || task.type || "任务")}</strong><span>${esc(task.id)}</span></div>
      <div data-mobile-label="创建时间">${esc(formatTime(task.created_at))}</div>
      <div data-mobile-label="状态">${renderStatusText(task.status || "")}</div>
      <div class="row-actions" data-mobile-label="操作">
        <button type="button" data-detail="${esc(task.id)}">详情</button>
        ${task.has_download ? `<a href="${esc(adminWorkspaceUrl(`/api/tasks/${encodeURIComponent(task.id)}/download`))}">下载</a>` : ""}
        ${task.status === "failed" ? `<button type="button" data-retry="${esc(task.id)}">重试</button>` : ""}
        ${activeSocialAutomationTask(task) ? `<button type="button" class="danger" data-cancel-task="${esc(task.id)}">停止</button>` : ""}
        <button type="button" class="danger task-queue-delete-button" data-delete-task="${esc(task.id)}" title="删除" aria-label="删除">${renderTrashIcon()}</button>
      </div>
    </article>
  `).join("") : `<div class="empty-state">当前还没有通用任务。</div>`;
  const currentPanel = state.taskQueuePanel === "regular" ? "regular" : "persona";
  const panel = currentPanel === "regular"
    ? {
      title: "通用任务队列",
      description: "这里继续保留原有的 Web 任务列表，用于查看详情、下载、重试和停止。",
      actions: `<div class="task-queue-actionbar">${renderTaskQueueBulkControls("regular")}</div>`,
      extraActions: "",
      body: `<div class="task-table-inner task-table-inner--regular">
        <div class="task-table-head"><span>勾选</span><span>任务</span><span>创建时间</span><span>状态</span><span>操作</span></div>
        ${regularTasksHtml}
      </div>`,
      pager: renderTaskQueuePager("regular", regularPageInfo),
    }
    : {
      title: "当前人设自动化队列",
      description: persona ? `这里统一查看「${persona.name || persona.id}」的浏览器自动化任务，不再单独放在人设页签里。` : "先在右侧点选一个人设，这里会同步显示对应自动化队列。",
      actions: `
        <div class="task-queue-actionbar">
          <button type="button" data-task-open-persona>${persona ? "打开当前人设" : "去选择人设"}</button>
          ${renderTaskQueueBulkControls("persona")}
          ${persona ? `<button type="button" class="danger" data-task-clear-persona-queue="${esc(persona.id)}">删除全部记录</button>` : ""}
        </div>`,
      extraActions: "",
      body: persona
        ? (
          personaTasks.length
            ? `<div class="compact-list task-persona-queue-list">
                <div class="task-table-head task-table-head--persona"><span>勾选</span><span>任务</span><span>平台</span><span>账号</span><span>时间</span><span>状态</span><span>操作</span></div>
                ${renderPersonaQueueRows(personaTasks)}
              </div>`
            : `<div class="empty-state">当前人设暂无自动化任务。</div>`
        )
        : `<div class="empty-state">当前还没有选中的人设。</div>`,
      pager: renderTaskQueuePager("persona", personaPageInfo),
    };
  return `
    <div class="task-queue-layout">
      <div class="persona-step-shell task-queue-shell">
        ${renderTaskQueuePanelTabs(currentPanel)}
        <section class="task-panel-section task-panel-section--shared">
          <div class="task-panel-section-head">
            <div>
              <strong>${panel.title}</strong>
              <p>${esc(panel.description)}</p>
            </div>
            ${panel.actions ? `<div class="task-panel-section-controls">${panel.actions}</div>` : ""}
          </div>
          ${panel.body}
          <div class="task-panel-section-foot">${panel.pager}</div>
        </section>
      </div>
      ${renderTaskQueuePersonaSelector()}
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

function taskOptionsForPlatform(platform, { includePublish = false } = {}) {
  if (platform === "instagram") {
    const options = [
      ["browse_feed", "浏览 Feed"],
      ["browse_profile", "浏览主页"],
      ["comment_post", "评论帖子"],
      ["reply_comment", "回复评论"],
      ["like_post", "点赞帖子"],
      ["share_post", "分享帖子"],
    ];
    if (includePublish) options.splice(4, 0, ["publish_post", "发布内容"]);
    return options;
  }
  const options = [
    ["browse_feed", "浏览 Feed"],
    ["threads_warmup", "Threads 养号"],
    ["threads_auto_reply", "Threads 自动回复"],
  ];
  if (includePublish) options.splice(3, 0, ["publish_post", "发布内容"]);
  return options;
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
    ? accounts.map((account) => `<option value="${esc(account.id)}" data-platform="${esc(account.platform || "")}">${esc(accountDisplayName(account))}</option>`).join("")
    : `<option value="">暂无账号</option>`;
}

function renderAutomationPersonaTabs() {
  if (!state.personas.length) return `<div class="empty-state">暂无人设，请先创建人设。</div>`;
  return `
    <div class="automation-tab-strip" aria-label="切换人设">
      ${state.personas.map((persona) => {
        const selected = String(persona.id || "") === String(state.selectedPersonaId || selectedPersona()?.id || "");
        const accounts = personaAccounts(persona);
        return `
          <button type="button" class="automation-tab ${selected ? "is-active" : ""}" data-automation-persona="${esc(persona.id)}">
            <strong>${esc(persona.name || persona.id)}</strong>
            <span>${esc(accounts.length ? `${accounts.length} 个账号` : "未绑定账号")}</span>
          </button>`;
      }).join("")}
    </div>`;
}

function renderAutomationAccountTabs(persona, platform) {
  const accounts = personaAutomationAccounts(persona, platform);
  if (!accounts.length) {
    return `<div class="empty-line">当前人设还没有 ${esc(platformLabel(platform))} 执行账号。</div>`;
  }
  const selectedAccount = selectedPersonaAutomationAccount(persona, platform) || accounts[0];
  return `
    <div class="automation-account-tabs" aria-label="切换执行账号">
      ${accounts.map((account) => {
        const selected = String(account.id || "") === String(selectedAccount?.id || "");
        return `
          <button type="button" class="automation-account-tab ${selected ? "is-active" : ""}" data-automation-account="${esc(account.id)}">
            <span>${esc(accountDisplayName(account))}</span>
            ${renderAccountStatusChip(account)}
          </button>`;
      }).join("")}
    </div>`;
}

function renderAutomationStepTabs(activeStep) {
  const steps = [
    ["binding", "账号绑定"],
    ["reply_comment", "自动回复评论"],
    ["reply_hot", "自动回复热点"],
    ["warmup", "养号"],
  ];
  return `
    <div class="automation-capsule-tabs automation-step-tabs" aria-label="切换自动化操作">
      ${steps.map(([value, label]) => `<button type="button" class="${activeStep === value ? "is-active" : ""}" data-automation-step="${esc(value)}">${esc(label)}</button>`).join("")}
    </div>`;
}

function renderUnifiedAutomationModule() {
  const persona = selectedPersona();
  const currentStep = ["binding", "reply_comment", "reply_hot", "warmup"].includes(currentBranch("automation"))
    ? currentBranch("automation")
    : "binding";
  const platform = selectedPersonaAutomationPlatform();
  const accounts = persona ? personaAutomationAccounts(persona, platform) : [];
  const selectedAccount = persona ? selectedPersonaAutomationAccount(persona, platform) : null;
  const selectedAccountId = String(selectedAccount?.id || "");
  const replyTask = selectedAccountId ? activeSocialTaskFor({ accountId: selectedAccountId, taskType: "threads_auto_reply" }) : null;
  const warmupTask = selectedAccountId ? activeSocialTaskFor({ accountId: selectedAccountId, taskType: "threads_warmup" }) : null;
  const replyBusy = Boolean(selectedAccountId) && (isActionLocked("social", selectedAccountId, "threads_auto_reply") || replyTask);
  const warmupBusy = Boolean(selectedAccountId) && (isActionLocked("social", selectedAccountId, "threads_warmup") || warmupTask);
  const replyBusyStartedAt = actionTaskStartedAt(replyTask, "social", selectedAccountId, "threads_auto_reply");
  const warmupBusyStartedAt = actionTaskStartedAt(warmupTask, "social", selectedAccountId, "threads_warmup");
  const credentialsMask = selectedAccount?.login_password_configured ? "已保存密码，留空则沿用" : "登录密码";
  const threadsOnlyNotice = platform !== "threads" && ["reply_comment", "reply_hot", "warmup"].includes(currentStep)
    ? `<div class="empty-state">当前操作只支持 Threads。请先切换到 Threads 平台。</div>`
    : "";
  const strategyGroup = currentStep === "reply_hot"
    ? "threads_hot_reply"
    : currentStep === "warmup"
      ? "threads_warmup"
      : "threads_comment_reply";
  const strategy = personaThreadsStrategy(strategyGroup);
  const customStrategy = personaThreadsStrategyIsCustom(strategyGroup);
  const payload = strategy?.payload || {};
  let operationPanel = "";
  if (!persona) {
    operationPanel = `<div class="empty-state">请先创建并选择人设。</div>`;
  } else if (currentStep === "binding") {
    operationPanel = `
      <div class="automation-operation-card">
        <strong>浏览器执行账号</strong>
        <p>用于登录、发布、养号和自动回复。绑定后会出现在上方账号切换里。</p>
        <label>${esc(platformLabel(platform))} 执行账号
          <input id="personaAutoUsername" value="" placeholder="${platform === "threads" ? "Threads 用户名 / handle" : "Instagram 用户名"}" />
        </label>
        <div class="row-actions automation-capsule-actions">
          <button type="button" data-persona-create-account>绑定账号</button>
        </div>
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
        </div>
      </div>`;
  } else if (currentStep === "reply_comment" || currentStep === "reply_hot") {
    operationPanel = threadsOnlyNotice || `
      <div class="automation-operation-card">
        <strong>${currentStep === "reply_hot" ? "自动回复热点推文" : "自动回复评论"}</strong>
        <label>策略
          <select id="personaStrategySelect" data-strategy-group="${esc(strategyGroup)}">
            ${personaThreadsStrategyOptionsHtml(strategyGroup)}
          </select>
        </label>
        ${customStrategy ? `
          <div class="form-grid">
            <label>查看天数
              <input id="personaAutoMaxAgeDays" type="number" min="1" max="365" value="${esc(payload.max_age_days || (currentStep === "reply_hot" ? 30 : 2))}" />
            </label>
            <label>扫描篇数
              <input id="personaAutoMaxPosts" type="number" min="1" max="20" value="${esc(payload.max_posts || 5)}" />
            </label>
            <label>回复上限
              <input id="personaAutoMaxReplies" type="number" min="1" max="10" value="${esc(payload.max_replies || 3)}" />
            </label>
            ${currentStep === "reply_hot" ? `<label>最低浏览
              <input id="personaAutoMinViews" type="number" min="0" max="999999999" value="${esc(payload.min_views || 0)}" />
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
          <button type="button" data-persona-run-threads="${currentStep === "reply_hot" ? "reply_hot" : "reply_comment"}" aria-busy="${replyBusy ? "true" : "false"}" ${selectedAccount && !replyBusy ? "" : "disabled"}>${replyBusy ? renderBusyButtonContent("自动回复执行中", true, replyBusyStartedAt) : "提交自动回复任务"}</button>
        </div>
      </div>`;
  } else {
    operationPanel = threadsOnlyNotice || `
      <div class="automation-operation-card">
        <strong>养号</strong>
        <label>策略
          <select id="personaStrategySelect" data-strategy-group="threads_warmup">
            ${personaThreadsStrategyOptionsHtml("threads_warmup")}
          </select>
        </label>
        ${customStrategy ? `
          <div class="form-grid">
            <label>浏览篇数上限
              <input id="personaAutoBrowseLimit" type="number" min="1" max="300" value="${esc(payload.browse_limit || payload.scroll_times || 30)}" />
            </label>
            <label>点赞上限
              <input id="personaAutoLikeLimit" type="number" min="0" max="100" value="${esc(payload.like_limit || 0)}" />
            </label>
            <label>留言上限
              <input id="personaAutoMaxComments" type="number" min="0" max="50" value="${esc(payload.max_comments || 0)}" />
            </label>
          </div>
          <label>养号留言模板
            <textarea id="personaAutoReplyText" rows="3" placeholder="可选，多条换行。留空则按人设自动生成。"></textarea>
          </label>
        ` : ""}
        ${personaThreadsStrategyDetail("threads_warmup")}
        <div class="row-actions">
          <button type="button" data-persona-run-threads="warmup" aria-busy="${warmupBusy ? "true" : "false"}" ${selectedAccount && !warmupBusy ? "" : "disabled"}>${warmupBusy ? renderBusyButtonContent("养号执行中", true, warmupBusyStartedAt) : "提交养号任务"}</button>
        </div>
      </div>`;
  }
  return `
    <div class="automation-workspace publish-workspace">
      <section class="publish-config-panel automation-config-panel">
        <section class="automation-switch-panel">
          <div class="automation-section-head">
            <strong>平台与账号</strong>
            <span>${esc(persona ? `${accounts.length} 个当前平台账号` : "未选择人设")}</span>
          </div>
          <div class="automation-capsule-tabs automation-platform-tabs" aria-label="选择平台">
            <button type="button" class="${platform === "threads" ? "is-active" : ""}" data-automation-platform="threads">Threads</button>
            <button type="button" class="${platform === "instagram" ? "is-active" : ""}" data-automation-platform="instagram">Instagram</button>
          </div>
          ${persona ? renderAutomationAccountTabs(persona, platform) : ""}
        </section>
        <section class="automation-work-panel">
          ${renderAutomationStepTabs(currentStep)}
          ${operationPanel}
        </section>
      </section>
      ${renderAutomationPersonaSidebar()}
    </div>`;
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
  (uploadPreviewUrls.get(input) || []).forEach((url) => URL.revokeObjectURL(url));
  uploadPreviewUrls.set(input, []);
  const files = Array.from(input.files || []);
  if (!files.length) {
    host.innerHTML = "未选择文件";
    host.classList.remove("has-preview");
    return;
  }
  const previewUrls = [];
  uploadPreviewUrls.set(input, previewUrls);
  host.classList.add("has-preview");
  host.innerHTML = files.map((file) => {
    const type = fileKind(file);
    const typeLabel = type === "image" ? "图片" : type === "video" ? "视频" : type === "audio" ? "音频" : "文件";
    let preview = `<div class="file-preview-frame file-preview-frame--empty">${esc(typeLabel)}</div>`;
    if (type === "image" || type === "video") {
      const url = URL.createObjectURL(file);
      previewUrls.push(url);
      preview = type === "image"
        ? `<img class="file-preview-frame" src="${esc(url)}" alt="${esc(file.name)}" />`
        : `<video class="file-preview-frame" src="${esc(url)}" muted playsinline></video>`;
    }
    return `
      <span class="file-chip file-chip--preview">
        ${preview}
        <span class="file-chip-copy">
          <strong>${esc(file.name)}</strong>
          <small>${esc(typeLabel)} · ${esc(formatUploadFileSize(file.size))}</small>
        </span>
      </span>
    `;
  }).join("");
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

function personaImageUploadDropzoneFromEvent(event) {
  return event.target?.closest?.("[data-persona-upload-image-dropzone]") || null;
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

function publishModeLabel(mode) {
  return ({
    publish_now: "普通发布",
    schedule_publish: "普通发布",
    matrix_start: "矩阵发布",
    publish_history: "发布历史",
  })[mode] || "普通发布";
}

function normalizedPublishMode(mode) {
  if (mode === "matrix_start") return "matrix_start";
  if (mode === "publish_history") return "publish_history";
  return "publish_now";
}

function renderPublishModeTabs(mode) {
  const current = normalizedPublishMode(mode);
  const modes = [
    ["publish_now", "普通发布"],
    ["matrix_start", "矩阵发布"],
    ["publish_history", "发布历史"],
  ];
  return `
    <div class="publish-mode-tabs" aria-label="发布方式">
      <input id="simplePublishMode" type="hidden" value="${esc(current)}" />
      ${modes.map(([value, label]) => `
        <button
          type="button"
          class="${current === value ? "is-active" : ""}"
          data-simple-publish-mode="${esc(value)}"
          aria-pressed="${current === value ? "true" : "false"}"
        >${esc(label)}</button>
      `).join("")}
    </div>`;
}

function renderPublishAccountBadge(account) {
  if (!account) {
    return `<div class="publish-account-badge is-empty"><span>发布账号</span><strong>未绑定</strong><em>到账号管理自动化绑定</em></div>`;
  }
  const ready = isReadyPublishAccount(account);
  return `
    <div class="publish-account-badge ${ready ? "" : "is-empty"}">
      <span>发布账号</span>
      <strong>${esc(accountDisplayName(account))}</strong>
      ${ready ? "" : `<em>${esc(statusLabel(account.status || ""))}</em>`}
    </div>`;
}

function renderPublishHeaderRow(mode, account) {
  return `
    <div class="publish-header-row">
      <div class="publish-header-main">
        <strong class="publish-inline-title">发布</strong>
        ${renderPublishModeTabs(mode)}
      </div>
      ${renderPublishAccountBadge(account)}
    </div>`;
}

function padSchedulePart(value, size = 2) {
  return String(value || "").padStart(size, "0");
}

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

function dateToScheduleParts(date) {
  const safe = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(safe).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return {
    year: String(formatted.year || safe.getUTCFullYear()),
    month: padSchedulePart(formatted.month || safe.getUTCMonth() + 1),
    day: padSchedulePart(formatted.day || safe.getUTCDate()),
    hour: padSchedulePart(formatted.hour || safe.getUTCHours()),
    minute: padSchedulePart(formatted.minute || safe.getUTCMinutes()),
  };
}

function schedulePartsToShanghaiIso(parts) {
  const year = Number(parts?.year);
  const month = Number(parts?.month);
  const day = Number(parts?.day);
  const hour = Number(parts?.hour);
  const minute = Number(parts?.minute);
  const calendarTime = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const calendar = new Date(calendarTime);
  if (
    !Number.isFinite(calendarTime)
    || calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day
    || calendar.getUTCHours() !== hour
    || calendar.getUTCMinutes() !== minute
  ) return "";
  // Shanghai has a fixed UTC+8 offset, so the wall-clock input is stable
  // regardless of the browser or container time zone.
  return new Date(calendarTime - 8 * 60 * 60 * 1000).toISOString();
}

function scheduleCalendarParts(parts, daysAhead, hour, minute) {
  const calendar = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + daysAhead));
  return {
    year: String(calendar.getUTCFullYear()),
    month: padSchedulePart(calendar.getUTCMonth() + 1),
    day: padSchedulePart(calendar.getUTCDate()),
    hour: padSchedulePart(hour),
    minute: padSchedulePart(minute),
  };
}

function schedulePresetParts(preset) {
  const now = new Date();
  const key = String(preset || "custom");
  if (key === "in_30m") return dateToScheduleParts(new Date(now.getTime() + 30 * 60 * 1000));
  if (key === "in_1h") return dateToScheduleParts(new Date(now.getTime() + 60 * 60 * 1000));
  if (key === "tomorrow_09") {
    return scheduleCalendarParts(dateToScheduleParts(now), 1, 9, 0);
  }
  if (key === "tomorrow_21") {
    return scheduleCalendarParts(dateToScheduleParts(now), 1, 21, 0);
  }
  return null;
}

function currentPublishScheduleParts() {
  const existing = state.publishScheduleParts && typeof state.publishScheduleParts === "object" ? state.publishScheduleParts : null;
  const fallback = new Date(Date.now() + 30 * 60 * 1000);
  const parts = existing || dateToScheduleParts(fallback);
  return {
    year: String(parts.year || new Date().getFullYear()),
    month: padSchedulePart(Math.min(Math.max(Number(parts.month || 1), 1), 12)),
    day: padSchedulePart(Math.min(Math.max(Number(parts.day || 1), 1), 31)),
    hour: padSchedulePart(Math.min(Math.max(Number(parts.hour || 0), 0), 23)),
    minute: padSchedulePart(Math.min(Math.max(Number(parts.minute || 0), 0), 59)),
  };
}

function composePublishScheduleAt() {
  if (state.publishTimingMode !== "scheduled") return "";
  return schedulePartsToShanghaiIso(currentPublishScheduleParts());
}

function publishScheduleDisplayText() {
  if (state.publishTimingMode !== "scheduled") return "";
  const parts = currentPublishScheduleParts();
  return `${padSchedulePart(parts.year, 4)}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function normalizeScheduleValueForApi(value) {
  const raw = String(value || "").trim();
  if (!raw || /^\d+$/.test(raw)) return raw;
  const naiveMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (naiveMatch) {
    return schedulePartsToShanghaiIso({
      year: naiveMatch[1],
      month: naiveMatch[2],
      day: naiveMatch[3],
      hour: naiveMatch[4],
      minute: naiveMatch[5],
    }) || raw;
  }
  const parsed = new Date(raw.includes("T") ? raw : raw.replace(" ", "T"));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : raw;
}

function syncPublishScheduleStateFromInputs() {
  const parts = currentPublishScheduleParts();
  ["year", "month", "day", "hour", "minute"].forEach((key) => {
    const node = $(`simpleSchedule${key[0].toUpperCase()}${key.slice(1)}`);
    if (node) parts[key] = node.value;
  });
  state.publishScheduleParts = parts;
  const hidden = $("simpleScheduleAt");
  if (hidden) hidden.value = composePublishScheduleAt();
}

function updatePublishSchedulePreview() {
  const preview = document.querySelector("[data-publish-schedule-preview]");
  if (!preview) return;
  const scheduledAt = composePublishScheduleAt();
  const scheduledDisplay = publishScheduleDisplayText();
  preview.innerHTML = scheduledAt
    ? `将按 <strong>${esc(scheduledDisplay)}</strong>（上海时间）创建定时发布任务。`
    : "确认执行后会立即提交发布任务。";
}

function renderPublishScheduleControls(rawMode = "") {
  if (rawMode === "schedule_publish") state.publishTimingMode = "scheduled";
  const timingMode = state.publishTimingMode === "scheduled" ? "scheduled" : "immediate";
  const parts = currentPublishScheduleParts();
  const scheduledAt = timingMode === "scheduled" ? composePublishScheduleAt() : "";
  const scheduledDisplay = timingMode === "scheduled" ? publishScheduleDisplayText() : "";
  return `
    <div class="publish-schedule-panel">
      <div class="publish-schedule-head">
        <div class="publish-schedule-title">
          <label>发布时间</label>
          <div class="publish-mode-tabs publish-time-tabs" aria-label="发布时间">
            ${[
              ["immediate", "立即发布"],
              ["scheduled", "定时发布"],
            ].map(([value, label]) => `
              <button
                type="button"
                class="${timingMode === value ? "is-active" : ""}"
                data-publish-timing-mode="${esc(value)}"
                aria-pressed="${timingMode === value ? "true" : "false"}"
              >${esc(label)}</button>
            `).join("")}
          </div>
        </div>
      </div>
      <input id="simpleScheduleAt" type="hidden" value="${esc(scheduledAt)}" />
      ${timingMode === "scheduled" ? `
        <div class="publish-schedule-grid">
          <label>快捷选择
            <select id="simpleSchedulePreset">
              ${optionTags([
                ["custom", "自定义时间"],
                ["in_30m", "30 分钟后"],
                ["in_1h", "1 小时后"],
                ["tomorrow_09", "明天 09:00"],
                ["tomorrow_21", "明天 21:00"],
              ], state.publishSchedulePreset || "custom")}
            </select>
          </label>
          <label>年
            <input id="simpleScheduleYear" inputmode="numeric" maxlength="4" value="${esc(padSchedulePart(parts.year, 4))}" />
          </label>
          <label>月
            <input id="simpleScheduleMonth" type="number" min="1" max="12" value="${esc(Number(parts.month))}" />
          </label>
          <label>日
            <input id="simpleScheduleDay" type="number" min="1" max="31" value="${esc(Number(parts.day))}" />
          </label>
          <label>时
            <input id="simpleScheduleHour" type="number" min="0" max="23" value="${esc(Number(parts.hour))}" />
          </label>
          <label>分钟
            <input id="simpleScheduleMinute" type="number" min="0" max="59" value="${esc(Number(parts.minute))}" />
          </label>
        </div>
        <div class="publish-schedule-preview" data-publish-schedule-preview>将按 <strong>${esc(scheduledDisplay)}</strong>（上海时间）创建定时发布任务。</div>
      ` : `<div class="publish-schedule-preview" data-publish-schedule-preview>确认执行后会立即提交发布任务。</div>`}
    </div>`;
}

function normalizePublishContentSource(source = state.publishContentSource) {
  const key = String(source || "").trim();
  if (key === "custom") return "custom";
  if (key === "favorites") return "favorites";
  return "posts";
}

function publishContentSourceLabel(source = state.publishContentSource) {
  return ({
    custom: "自定义",
    posts: "草稿",
    favorites: "收藏",
  })[normalizePublishContentSource(source)] || "草稿";
}

function publishSelectionKey(persona = selectedPersona(), source = state.publishContentSource) {
  return `${String(persona?.id || "default")}::${normalizePublishContentSource(source)}`;
}

function publishSourceRows(persona = selectedPersona(), source = state.publishContentSource) {
  const cleanSource = normalizePublishContentSource(source);
  if (cleanSource === "favorites") return personaFavoritePosts(persona);
  if (cleanSource === "posts") return personaDraftPosts(persona);
  return [];
}

function syncPublishSelectedPostIds(persona = selectedPersona(), source = state.publishContentSource, rows = publishSourceRows(persona, source)) {
  const cleanSource = normalizePublishContentSource(source);
  if (cleanSource === "custom") return [];
  const valid = new Set((rows || []).map((post) => String(post.id || "")).filter(Boolean));
  const key = publishSelectionKey(persona, cleanSource);
  const hasStoredSelection = Array.isArray(state.publishSelectedPostIds[key]);
  let selected = hasStoredSelection ? state.publishSelectedPostIds[key].map((id) => String(id || "")).filter((id) => valid.has(id)) : [];
  if (!selected.length && !hasStoredSelection) {
    const preferred = String(state.selectedPersonaPostId || "");
    if (valid.has(preferred)) selected = [preferred];
    else if ((rows || [])[0]?.id) selected = [String(rows[0].id)];
  }
  state.publishSelectedPostIds[key] = selected;
  return selected;
}

function setPublishSelectedPostIds(persona = selectedPersona(), source = state.publishContentSource, ids = []) {
  const cleanSource = normalizePublishContentSource(source);
  const rows = publishSourceRows(persona, cleanSource);
  const selected = new Set((ids || []).map((id) => String(id || "")).filter(Boolean));
  const next = rows.map((post) => String(post.id || "")).filter((id) => id && selected.has(id));
  state.publishSelectedPostIds[publishSelectionKey(persona, cleanSource)] = next;
  if (next[0]) setSelectedPersonaPostId(next[0]);
  if (!next.includes(String(state.publishPreviewPostId || ""))) state.publishPreviewPostId = next[0] || "";
}

function clearPublishSelectionForPersona(persona = selectedPersona()) {
  if (!persona) return;
  ["posts", "favorites"].forEach((source) => {
    state.publishSelectedPostIds[publishSelectionKey(persona, source)] = [];
  });
  state.publishPreviewPostId = "";
  setSelectedPersonaPostId("");
}

function selectedPublishPosts(persona = selectedPersona(), source = state.publishContentSource) {
  const rows = publishSourceRows(persona, source);
  const selected = new Set(syncPublishSelectedPostIds(persona, source, rows));
  return rows.filter((post) => selected.has(String(post.id || "")));
}

function activePublishPreviewPost(posts = []) {
  const rows = Array.isArray(posts) ? posts : [];
  if (!rows.length) {
    state.publishPreviewPostId = "";
    return null;
  }
  const active = rows.find((post) => String(post.id || "") === String(state.publishPreviewPostId || "")) || rows[0];
  state.publishPreviewPostId = String(active.id || "");
  return active;
}

function renderPublishContentSourceTabs(source = state.publishContentSource) {
  const current = normalizePublishContentSource(source);
  return `
    <div class="publish-mode-tabs publish-source-tabs" aria-label="发布来源">
      ${[
        ["custom", "自定义"],
        ["posts", "草稿"],
        ["favorites", "收藏"],
      ].map(([value, label]) => `
        <button
          type="button"
          class="${current === value ? "is-active" : ""}"
          data-publish-content-source="${esc(value)}"
          aria-pressed="${current === value ? "true" : "false"}"
        >${esc(label)}</button>
      `).join("")}
    </div>`;
}

function renderPublishSourceActions(persona = selectedPersona(), source = state.publishContentSource) {
  const cleanSource = normalizePublishContentSource(source);
  if (cleanSource === "custom") return "";
  const rows = publishSourceRows(persona, cleanSource);
  const selectedCount = syncPublishSelectedPostIds(persona, cleanSource, rows).length;
  return `
    <div class="publish-source-actions">
      <span>已选 ${esc(selectedCount)} / ${esc(rows.length)}</span>
      <div>
        <button type="button" data-publish-source-select="all" ${rows.length ? "" : "disabled"}>全选</button>
        <button type="button" data-publish-source-select="clear" ${selectedCount ? "" : "disabled"}>清空</button>
      </div>
    </div>`;
}

function renderPublishPreviewCard(activePost, sourceRows = [], persona = selectedPersona()) {
  const activeMediaItems = activePost
    ? personaPublishPostMediaItems(String(persona?.id || ""), activePost)
    : [];
  return `
    <article class="publish-preview-card">
      <div class="publish-preview-card-head">
        <strong>${esc(activePost ? personaDraftDisplayTitleForPost(activePost, sourceRows) : "待发布内容")}</strong>
        ${renderMediaTypeBadge(activeMediaItems)}
      </div>
      <p>${esc(String(activePost?.content || "").trim() || "当前内容为空。")}</p>
      ${renderPublishPreviewMedia(activeMediaItems)}
    </article>`;
}

function renderPublishPostSelectionList(persona = selectedPersona(), source = state.publishContentSource) {
  const cleanSource = normalizePublishContentSource(source);
  if (cleanSource === "custom") {
    return `<div class="empty-state">自定义模式不需要选择草稿，右侧直接输入发布内容。</div>`;
  }
  const rows = publishSourceRows(persona, cleanSource);
  const selectedIds = new Set(syncPublishSelectedPostIds(persona, cleanSource, rows));
  if (!rows.length) return `<div class="empty-state">当前还没有${cleanSource === "favorites" ? "收藏内容" : "草稿"}。</div>`;
  const personaId = String(persona?.id || "");
  return `
    <div class="publish-post-list">
      ${rows.map((post, index) => {
        const postId = String(post.id || "");
        const checked = selectedIds.has(postId);
        const mediaItems = personaPublishPostMediaItems(personaId, post);
        const hotMeta = personaHotImportMeta(personaId, post.id);
        return `
          <article class="publish-post-card ${checked ? "is-selected" : ""}" data-publish-post-card="${esc(postId)}">
            <label class="publish-post-card-main">
              <input type="checkbox" data-publish-post-id="${esc(postId)}" ${checked ? "checked" : ""} />
              <span class="publish-persona-check ${checked ? "is-checked" : ""}" aria-hidden="true"></span>
              <span class="publish-post-card-index">${esc(index + 1)}</span>
              <span class="publish-post-card-copy">
                <span class="publish-post-card-head">
                  <strong>${esc(personaDraftDisplayTitleForPost(post, rows, index))}</strong>
                  ${renderMediaTypeBadge(mediaItems)}
                </span>
                <span class="publish-post-card-meta">${esc(formatTime(post.published_at || post.updated_at || post.created_at))}${hotMeta ? " · 热点导入" : ""}</span>
                <span class="publish-post-card-snippet">${esc(String(post.content || "").replace(/\s+/g, " ").slice(0, 86) || "当前内容为空。")}</span>
              </span>
            </label>
          </article>`;
      }).join("")}
    </div>`;
}

function renderPublishContentPreview(persona = selectedPersona(), source = state.publishContentSource) {
  const cleanSource = normalizePublishContentSource(source);
  if (cleanSource === "custom") {
    return `
      <section class="publish-content-preview">
        <div class="publish-panel-head">
          <strong>发布内容展示</strong>
          <span>自定义输入</span>
        </div>
        <textarea id="simpleContent" rows="8" placeholder="直接输入本次要发布的正文。">${esc(state.publishCustomContent || "")}</textarea>
        ${renderUploadDropzone("simpleMediaFiles", { label: "上传素材", hint: "拖动图片或视频到这里，或点击选择。发布内容会读取这里的文件。" })}
      </section>`;
  }
  const sourceRows = publishSourceRows(persona, cleanSource);
  const selectedPosts = selectedPublishPosts(persona, cleanSource);
  const activePost = activePublishPreviewPost(selectedPosts);
  return `
    <section class="publish-content-preview">
      <div class="publish-panel-head">
        <strong>发布内容展示</strong>
        <span>${esc(publishContentSourceLabel(cleanSource))} · 已选 ${selectedPosts.length} 条</span>
      </div>
      ${selectedPosts.length ? `
        <div class="publish-preview-tabs-layout">
          <div class="publish-preview-tabs" aria-label="发布内容标签页">
            ${selectedPosts.map((post, index) => {
              const postId = String(post.id || "");
              const active = postId === String(activePost?.id || "");
              return `
                <button
                  type="button"
                  class="${active ? "is-active" : ""}"
                  data-publish-preview-post="${esc(postId)}"
                  aria-pressed="${active ? "true" : "false"}"
                >
                  <span class="publish-preview-tab-index">${esc(index + 1)}</span>
                  <span class="publish-preview-tab-copy">
                    <strong>${esc(personaDraftDisplayTitleForPost(post, sourceRows, index))}</strong>
                    <span>${esc(`第${index + 1}篇`)}</span>
                  </span>
                </button>`;
            }).join("")}
          </div>
          ${renderPublishPreviewCard(activePost, sourceRows, persona)}
        </div>
      ` : `<div class="empty-state">请先在左侧选择要发布的内容。</div>`}
      <input id="simpleContent" type="hidden" value="${esc(activePost?.content || "")}" />
    </section>`;
}

function renderPublishContentPanel(persona = selectedPersona()) {
  const source = normalizePublishContentSource();
  return `
    <div class="publish-content-layout">
      ${renderPublishContentPreview(persona, source)}
      <section class="publish-post-picker">
        <div class="publish-panel-head">
          <strong>发布来源</strong>
          <span>${esc(publishContentSourceLabel(source))}</span>
        </div>
        <div class="publish-source-controls">
          ${renderPublishContentSourceTabs(source)}
          ${renderPublishSourceActions(persona, source)}
        </div>
        ${renderPublishPostSelectionList(persona, source)}
      </section>
    </div>`;
}

function publishHistoryRecordTitle(record, index = 0) {
  return String(
    record?.title
    || statusLabel(record?.automation_task_type || record?.task_type || record?.taskType || "")
    || record?.platform
    || `第 ${index + 1} 条发布记录`
  ).trim();
}

function publishHistoryRecordTime(record) {
  return record?.published_at || record?.finished_at || record?.captured_at || record?.updated_at || record?.created_at || "";
}

function activePublishHistoryRecord(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    state.publishHistoryPreviewId = "";
    return null;
  }
  const active = list.find((record) => String(record.id || "") === String(state.publishHistoryPreviewId || "")) || list[0];
  state.publishHistoryPreviewId = String(active.id || "");
  return active;
}

function renderPublishHistorySelectionList(persona = selectedPersona()) {
  const rows = personaPublishHistoryRows(persona);
  if (!rows.length) return `<div class="empty-state">当前人设还没有发布历史。</div>`;
  const activeId = String(state.publishHistoryPreviewId || rows[0]?.id || "");
  return `
    <div class="publish-post-list">
      ${rows.map((record, index) => {
        const recordId = String(record.id || "");
        const active = recordId === activeId;
        const mediaItems = personaHistoryMediaItems(record);
        const platform = String(record.platform || record.publishPlatform || "").trim();
        const status = String(record.status || "").trim();
        const meta = [platform, status ? statusLabel(status) : "", formatTime(publishHistoryRecordTime(record))].filter(Boolean).join(" · ");
        return `
          <article class="publish-post-card publish-history-card ${active ? "is-selected" : ""}" data-publish-history-card="${esc(recordId)}">
            <div class="publish-history-card-main">
              <span class="publish-post-card-index">${esc(index + 1)}</span>
              <span class="publish-post-card-copy">
                <span class="publish-post-card-head">
                  <strong>${esc(publishHistoryRecordTitle(record, index))}</strong>
                  ${renderMediaTypeBadge(mediaItems)}
                </span>
                <span class="publish-post-card-meta">${esc(meta || "发布记录")}</span>
                <span class="publish-post-card-snippet">${esc(String(record.content || record.caption || record.text || record.source_url || "").replace(/\s+/g, " ").slice(0, 86) || "该记录没有正文摘要。")}</span>
              </span>
            </div>
          </article>`;
      }).join("")}
    </div>`;
}

function renderPublishHistoryPreview(persona = selectedPersona()) {
  const rows = personaPublishHistoryRows(persona);
  const activeRecord = activePublishHistoryRecord(rows);
  const activeMediaItems = activeRecord ? personaHistoryMediaItems(activeRecord) : [];
  const publishedUrl = String(activeRecord?.source_url || activeRecord?.published_url || activeRecord?.url || activeRecord?.post_url || "").trim();
  const metrics = activeRecord ? [
    ["点赞", activeRecord.likes],
    ["评论", activeRecord.comments],
    ["转发", activeRecord.shares],
    ["浏览", activeRecord.views],
  ].filter(([, value]) => Number(value || 0) > 0) : [];
  return `
    <section class="publish-content-preview publish-history-preview">
      <div class="publish-panel-head">
        <strong>发布历史展示</strong>
        <span>已发布 ${rows.length} 条</span>
      </div>
      ${rows.length ? `
        <div class="publish-preview-tabs-layout">
          <article class="publish-preview-card">
            <div class="publish-preview-card-head">
              <strong>${esc(publishHistoryRecordTitle(activeRecord, 0) || "发布记录")}</strong>
              ${renderMediaTypeBadge(activeMediaItems)}
            </div>
            <div class="publish-history-meta">
              <span>${esc(String(activeRecord?.platform || "平台未知"))}</span>
              <span>${esc(formatTime(publishHistoryRecordTime(activeRecord)) || "时间未知")}</span>
              ${activeRecord?.status ? `<span>${esc(statusLabel(activeRecord.status))}</span>` : ""}
            </div>
            <p>${esc(String(activeRecord?.content || activeRecord?.caption || activeRecord?.text || activeRecord?.source_url || "").trim() || "该记录没有正文或链接摘要。")}</p>
            ${metrics.length ? `<div class="publish-history-metrics">${metrics.map(([label, value]) => `<span>${esc(label)} ${esc(value)}</span>`).join("")}</div>` : ""}
            <div class="row-actions publish-history-actions">
              ${publishedUrl ? `<a href="${esc(publishedUrl)}" target="_blank" rel="noopener">查看来源</a>` : ""}
              <button type="button" data-publish-history-requeue="${esc(String(activeRecord?.id || ""))}">重入队</button>
            </div>
            ${renderPublishPreviewMedia(activeMediaItems)}
          </article>
        </div>
      ` : `<div class="empty-state">当前人设还没有发布历史。</div>`}
    </section>`;
}

function renderPublishHistoryPanel(persona = selectedPersona()) {
  return `
    <div class="publish-content-layout">
      ${renderPublishHistoryPreview(persona)}
      <section class="publish-post-picker">
        <div class="publish-panel-head">
          <strong>发布历史</strong>
          <span>${esc(persona?.name || "当前人设")}</span>
        </div>
        <div class="publish-history-note">这里只查看当前人设的已发布记录，不会创建新的发布任务。</div>
        ${renderPublishHistorySelectionList(persona)}
      </section>
    </div>`;
}

async function requeuePublishHistoryRecord(historyId = "", persona = selectedPersona()) {
  const cleanPersonaId = String(persona?.id || "").trim();
  const cleanHistoryId = String(historyId || state.publishHistoryPreviewId || "").trim();
  if (!cleanPersonaId || !cleanHistoryId) {
    showMsg("commandMsg", "请先选择一条发布历史。", false);
    return;
  }
  const lockParts = ["publish_history_requeue", cleanPersonaId, cleanHistoryId];
  if (isActionLocked(...lockParts)) {
    showMsg("commandMsg", "该发布历史正在重入队，请等待当前操作完成。", false);
    return;
  }
  setActionLocked(lockParts, true);
  try {
    showMsg("commandMsg", "正在将发布历史重入草稿队列...", true);
    const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(cleanPersonaId)}/publish_history/${encodeURIComponent(cleanHistoryId)}/requeue`, {
      method: "POST",
    });
    await Promise.all([
      loadPersonaDraftPosts(cleanPersonaId, { force: true }).catch(() => []),
      loadPersonaPublishHistory(cleanPersonaId, { force: true }).catch(() => []),
      loadPersonas().catch(() => {}),
    ]);
    const postTitle = String(result?.post?.title || "发布历史").trim();
    showMsg("commandMsg", `已重入队：${postTitle}`, true);
    if (state.activeModule === "publishing") renderSimpleFlowModule("publishing");
  } catch (error) {
    showMsg("commandMsg", error.detail || error.message || "重入队失败", false);
  } finally {
    setActionLocked(lockParts, false);
  }
}

function publishGroupSelectionState(personaIds = [], selectedIds = []) {
  const ids = (personaIds || []).map((id) => String(id || "")).filter(Boolean);
  const selected = new Set((selectedIds || []).map((id) => String(id || "")));
  const count = ids.filter((id) => selected.has(id)).length;
  return {
    count,
    total: ids.length,
    all: ids.length > 0 && count === ids.length,
    partial: count > 0 && count < ids.length,
  };
}

function renderPublishPersonaCollectionList(mode, selectedIds) {
  return renderPersonaCollectionList({
    context: "publishing",
    publishMode: mode,
    selectedIds,
    allowEdit: false,
    allowGroupEdit: true,
    allowReorder: true,
  });
}

function personaCollectionListNodes() {
  const groups = personaCollectionGroups();
  const assigned = personaAssignedIds();
  const ungrouped = orderedUngroupedPersonas(assigned);
  return [
    ...groups.map((group) => ({ type: "group", group })),
    ...ungrouped.map((persona) => ({ type: "persona", persona })),
  ];
}

function visiblePersonaCollectionListNodes(options = {}) {
  const pageSize = Math.min(Math.max(Number(state.personaListPageSize || 20), 5), 80);
  const nodes = options.groupsOnly === true
    ? personaCollectionGroups().map((group) => ({ type: "group", group }))
    : personaCollectionListNodes();
  const totalPages = Math.max(1, Math.ceil(nodes.length / pageSize));
  state.personaListPage = Math.min(Math.max(Number(state.personaListPage || 1), 1), totalPages);
  const start = (state.personaListPage - 1) * pageSize;
  return {
    pageSize,
    totalPages,
    currentPage: state.personaListPage,
    nodes: nodes.slice(start, start + pageSize),
  };
}

function personaIdsFromCollectionNodes(nodes = [], map = personaByIdMap()) {
  const ids = new Set();
  (Array.isArray(nodes) ? nodes : []).forEach((node) => {
    if (node?.type === "persona" && node.persona?.id) {
      ids.add(String(node.persona.id));
      return;
    }
    if (node?.type === "group") {
      (node.group?.persona_ids || []).forEach((id) => {
        const cleanId = String(id || "").trim();
        if (cleanId && map.has(cleanId)) ids.add(cleanId);
      });
    }
  });
  return Array.from(ids);
}

function personaBulkSelectedSet() {
  if (!(state.personaBulkSelectedIds instanceof Set)) {
    state.personaBulkSelectedIds = new Set(Array.isArray(state.personaBulkSelectedIds) ? state.personaBulkSelectedIds : []);
  }
  const validIds = new Set(state.personas.map((persona) => String(persona.id || "")).filter(Boolean));
  Array.from(state.personaBulkSelectedIds).forEach((id) => {
    if (!validIds.has(String(id || ""))) state.personaBulkSelectedIds.delete(id);
  });
  return state.personaBulkSelectedIds;
}

function visiblePersonaBulkIds() {
  return personaIdsFromCollectionNodes(visiblePersonaCollectionListNodes().nodes);
}

function personaBulkScope() {
  return state.personaBulkScope === "groups" ? "groups" : "personas";
}

function personaBulkSelectedGroupSet() {
  if (!(state.personaBulkSelectedGroupIds instanceof Set)) {
    state.personaBulkSelectedGroupIds = new Set(Array.isArray(state.personaBulkSelectedGroupIds) ? state.personaBulkSelectedGroupIds : []);
  }
  const validIds = new Set(personaCollectionGroups().map((group) => String(group.id || "")).filter(Boolean));
  Array.from(state.personaBulkSelectedGroupIds).forEach((id) => {
    if (!validIds.has(String(id || ""))) state.personaBulkSelectedGroupIds.delete(id);
  });
  return state.personaBulkSelectedGroupIds;
}

function visiblePersonaBulkGroupIds() {
  return visiblePersonaCollectionListNodes({ groupsOnly: true }).nodes
    .map((node) => String(node?.group?.id || "").trim())
    .filter(Boolean);
}

function setPersonaBulkSelection(personaIds = [], selected = true) {
  const selectedIds = personaBulkSelectedSet();
  (Array.isArray(personaIds) ? personaIds : []).forEach((personaId) => {
    const cleanId = String(personaId || "").trim();
    if (!cleanId) return;
    if (selected) selectedIds.add(cleanId);
    else selectedIds.delete(cleanId);
  });
}

function setPersonaBulkGroupSelection(groupIds = [], selected = true) {
  const selectedIds = personaBulkSelectedGroupSet();
  (Array.isArray(groupIds) ? groupIds : []).forEach((groupId) => {
    const cleanId = String(groupId || "").trim();
    if (!cleanId) return;
    if (selected) selectedIds.add(cleanId);
    else selectedIds.delete(cleanId);
  });
}

function syncPersonaBulkCheckboxes() {
  document.querySelectorAll("[data-persona-bulk-group]").forEach((input) => {
    input.indeterminate = input.dataset.personaBulkPartial === "true";
  });
}

function visiblePublishPersonaIdsForRefresh(mode = state.simpleBranches.publishing) {
  const current = normalizedPublishMode(mode);
  const ids = new Set(personaIdsFromCollectionNodes(visiblePersonaCollectionListNodes().nodes));
  if (current === "matrix_start") matrixPublishSelectedIds().forEach((id) => ids.add(String(id || "")));
  const selectedId = currentPublishingPersonaId();
  if (selectedId) ids.add(selectedId);
  return Array.from(ids).filter((id) => state.personas.some((persona) => String(persona.id || "") === id));
}

function ensurePublishingPersonaSidebarContent(mode = state.simpleBranches.publishing) {
  const personaIds = visiblePublishPersonaIdsForRefresh(mode);
  const pending = personaIds.flatMap((personaId) => {
    const tasks = [];
    if (!Array.isArray(state.personaDraftPosts[personaId])) tasks.push(loadPersonaDraftPosts(personaId).catch(() => []));
    if (!Array.isArray(state.personaFavoritePosts[personaId])) tasks.push(loadPersonaFavoritePosts(personaId).catch(() => []));
    return tasks;
  });
  if (!pending.length) return;
  Promise.all(pending).then(() => {
    if (state.activeModule === "publishing" && normalizedPublishMode(state.simpleBranches.publishing) === normalizedPublishMode(mode)) {
      renderSimpleFlowModule("publishing");
    }
  }).catch(() => {});
}

function renderAutomationPersonaCollectionList() {
  return renderPersonaCollectionList({
    context: "automation",
    selectedIds: [String(state.selectedPersonaId || "")].filter(Boolean),
    allowEdit: false,
    allowGroupEdit: false,
    allowReorder: false,
  });
}

function renderPublishPersonaSidebar(mode) {
  const current = normalizedPublishMode(mode);
  const isMatrix = current === "matrix_start";
  const selectedIds = isMatrix ? matrixPublishSelectedIds() : [String(state.selectedPersonaId || "")].filter(Boolean);
  ensurePublishingPersonaSidebarContent(current);
  return `
    <aside class="persona-list-shell publish-persona-shell">
      <div class="persona-inline-panel persona-list-toolbar">
        <div class="persona-list-head persona-list-head--queue">
          <strong>${isMatrix ? "矩阵人设" : "发布人设"}</strong>
          <span>${isMatrix ? `${selectedIds.length} 个已选` : "单选当前发布对象"}</span>
        </div>
        <div class="persona-list-actions publish-persona-create-actions">
          <button type="button" data-persona-create-group>创建分组</button>
        </div>
        ${isMatrix ? `
          <div class="publish-persona-toolbar">
            <button type="button" data-matrix-select-all>全选</button>
            <button type="button" data-matrix-clear>清空</button>
          </div>
        ` : ""}
      </div>
      ${renderPublishPersonaCollectionList(current, selectedIds)}
    </aside>`;
}

function renderAutomationPersonaSidebar() {
  return `
    <aside class="persona-list-shell publish-persona-shell automation-persona-shell">
      <div class="persona-inline-panel persona-list-toolbar">
        <div class="persona-list-head persona-list-head--queue">
          <strong>自动化人设</strong>
          <span>单选当前操作对象</span>
        </div>
      </div>
      ${renderAutomationPersonaCollectionList()}
    </aside>`;
}

function selectPublishingPersona(personaId) {
  const cleanId = String(personaId || "").trim();
  if (!cleanId || !state.personas.some((persona) => String(persona.id) === cleanId)) return;
  const previousId = String(state.selectedPersonaId || "");
  state.selectedPersonaId = cleanId;
  if (cleanId !== previousId) clearPublishSelectionForPersona(selectedPersona());
  else setSelectedPersonaPostId("");
  state.preferredAccountId = accountForPersona(selectedPersona())?.id || "";
  const persona = selectedPersona();
  if (persona && !state.personaDraftPosts[cleanId]) {
    loadPersonaDraftPosts(cleanId).then(() => {
      if (state.activeModule === "publishing") renderSimpleFlowModule("publishing");
    }).catch(() => {});
  }
  if (persona && !Array.isArray(state.personaPublishHistories[cleanId])) {
    loadPersonaPublishHistory(cleanId).then(() => {
      if (state.activeModule === "publishing" && normalizedPublishMode(state.simpleBranches.publishing) === "publish_history") renderSimpleFlowModule("publishing");
    }).catch(() => {});
  }
}

function resetPersonaWorkspaceStateOnSwitch(personaId) {
  const cleanId = String(personaId || "").trim();
  state.personaCreateMode = false;
  state.personaGroup = "settings";
  state.personaPanels.settings = "profile";
  state.personaPanels.content = personaGroups.content?.defaultStep || "generate";
  state.selectedPersonaPostSource = "posts";
  setSelectedPersonaPostId("");
  if (cleanId) {
    state.personaPostSources[cleanId] = "posts";
    state.personaProfileModes[cleanId] = "overview";
    delete state.personaProfileRegenDrafts[cleanId];
    resetPersonaDraftEditor(cleanId);
  }
  state.personaListEditorId = "";
  state.personaListEditorMode = "";
  state.personaLinkPresetId = "";
  closePersonaDraftMenus();
  removePersonaCardEditorPortal();
}

function toggleMatrixPersonaId(personaId) {
  const id = String(personaId || "").trim();
  if (!id) return;
  const selected = new Set(matrixPublishSelectedIds());
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  state.matrixPublish.personaIds = sortPersonaIdsByPublishOrder(Array.from(selected));
  state.matrixPublish.initialized = true;
}

function toggleMatrixGroupId(groupId) {
  const cleanGroupId = String(groupId || "").trim();
  if (!cleanGroupId) return;
  const group = personaCollectionGroups().find((item) => String(item.id || "") === cleanGroupId);
  if (!group) return;
  const ids = (group.persona_ids || []).map((id) => String(id || "")).filter(Boolean);
  if (!ids.length) return;
  const selected = new Set(matrixPublishSelectedIds());
  const selection = publishGroupSelectionState(ids, Array.from(selected));
  if (selection.all) ids.forEach((id) => selected.delete(id));
  else ids.forEach((id) => selected.add(id));
  state.matrixPublish.personaIds = sortPersonaIdsByPublishOrder(Array.from(selected));
  state.matrixPublish.initialized = true;
}

function renderSimpleFlowModule(moduleId) {
  return withConsoleScrollPreserved(() => {
  if (moduleId === "publishing") removePersonaCardEditorPortal();
  const branch = currentBranch(moduleId);
  const personaAccount = accountForPersona(selectedPersona());
  const firstAccount = state.preferredAccountId || personaAccount?.id || state.socialAccounts[0]?.id || "";
  const accountId = $("simpleAccount")?.value || firstAccount;
  const currentAccount = selectedSocialAccount(accountId);
  const platform = platformForAccount(accountId);
  const taskOptions = taskOptionsForPlatform(platform, { includePublish: moduleId === "publishing" });
  const selectedTask = taskOptions.some(([value]) => value === branch) ? branch : taskOptions[0][0];
  const commonAccount = `
    <label class="account-field">
      ${renderAccountFieldHead("执行账号", currentAccount)}
      <select id="simpleAccount">${accountOptionTags()}</select>
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
    const publishMode = normalizedPublishMode(branch);
    const publishAccount = publishAccountForPersona(selectedPersonaForPublish);
    const modeTabs = renderPublishHeaderRow(publishMode, publishAccount);
    if (publishMode === "publish_history" && selectedPersonaForPublish && !Array.isArray(state.personaPublishHistories[String(selectedPersonaForPublish.id)])) {
      loadPersonaPublishHistory(selectedPersonaForPublish.id).then(() => {
        if (state.activeModule === "publishing" && normalizedPublishMode(state.simpleBranches.publishing) === "publish_history") {
          renderSimpleFlowModule("publishing");
        }
      }).catch(() => {});
    }
    if (publishMode === "matrix_start") {
      body = `
        <div class="publish-workspace">
          <section class="publish-config-panel">
            ${modeTabs}
            ${renderMatrixPublishPanel()}
          </section>
          ${renderPublishPersonaSidebar(publishMode)}
        </div>`;
    } else if (publishMode === "publish_history") {
      body = `
        <div class="publish-workspace">
          <section class="publish-config-panel">
            ${modeTabs}
            ${renderPublishHistoryPanel(selectedPersonaForPublish)}
          </section>
          ${renderPublishPersonaSidebar(publishMode)}
        </div>`;
    } else {
      const publishSource = normalizePublishContentSource();
      if (selectedPersonaForPublish && publishSource === "favorites" && !state.personaFavoritePosts[String(selectedPersonaForPublish.id)]) {
        loadPersonaFavoritePosts(selectedPersonaForPublish.id).then(() => {
          if (state.activeModule === "publishing") renderSimpleFlowModule("publishing");
        }).catch(() => {});
      }
      body = `
        <div class="publish-workspace">
          <section class="publish-config-panel">
            ${modeTabs}
            ${renderPublishScheduleControls(branch)}
            ${renderPublishContentPanel(selectedPersonaForPublish)}
            <input id="simplePrimary" type="hidden" value="publish_post" />
          </section>
          ${renderPublishPersonaSidebar(publishMode)}
        </div>`;
    }
  } else if (moduleId === "automation") {
    body = renderUnifiedAutomationModule();
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
  const publishModeForAction = moduleId === "publishing" ? normalizedPublishMode(branch) : "";
  const actionLabel = moduleId === "queue" ? "打开任务队列" : (moduleId === "publishing" && publishModeForAction === "matrix_start" ? "提交矩阵发布" : "确认执行");
  const actionBusy = Boolean(state.simpleFlowPending && state.simpleFlowPendingModule === moduleId);
  const actionBlocked = Boolean(state.simpleFlowPending && !actionBusy);
  const actionHtml = moduleId === "automation" || publishModeForAction === "publish_history" ? "" : `<div class="command-actions ${moduleId === "publishing" ? "publish-command-actions" : ""}"><button id="executeSimpleFlow" type="button" class="primary" aria-busy="${actionBusy ? "true" : "false"}" ${moduleId === "publishing" ? dailyPublishActionAttrs() : ""} ${actionBusy || actionBlocked ? "disabled" : ""}>${actionBusy ? renderBusyButtonContent(`${actionLabel}中`, true, state.simpleFlowPendingStartedAt) : (actionBlocked ? "其他任务执行中" : (moduleId === "publishing" && dailyPublishIsLocked() ? "今日发布已锁定" : esc(actionLabel)))}</button></div>`;
  $("moduleBody").innerHTML = `
    ${moduleId === "publishing" ? renderDailyPublishLimitBanner() : ""}
    ${body}
    ${actionHtml}
  `;
  if ($("simpleAccount") && accountId) $("simpleAccount").value = accountId;
  if ($("simplePublishMode")) {
    const modes = ["publish_now", "matrix_start", "publish_history"];
    $("simplePublishMode").value = modes.includes(branch) ? branch : "publish_now";
  }
  bindSimpleFlowInputs(moduleId);
  applyDailyPublishButtonLocks($("moduleBody"));
  if (moduleId === "publishing" && normalizedPublishMode(branch) === "matrix_start") {
    document.querySelector("[data-matrix-select-all]")?.addEventListener("click", () => {
      state.matrixPublish.personaIds = publishOrderedPersonaIds();
      state.matrixPublish.initialized = true;
      renderSimpleFlowModule("publishing");
    });
    document.querySelector("[data-matrix-clear]")?.addEventListener("click", () => {
      state.matrixPublish.personaIds = [];
      state.matrixPublish.initialized = true;
      renderSimpleFlowModule("publishing");
    });
  }
  if ($("executeSimpleFlow")) $("executeSimpleFlow").addEventListener("click", async () => {
    if (state.simpleFlowPending) return;
    state.simpleFlowPending = true;
    state.simpleFlowPendingModule = moduleId;
    state.simpleFlowPendingStartedAt = Date.now();
    const trigger = $("executeSimpleFlow");
    if (trigger) {
      trigger.disabled = true;
      trigger.setAttribute("aria-busy", "true");
      trigger.innerHTML = renderBusyButtonContent(`${actionLabel}中`, true, state.simpleFlowPendingStartedAt);
    }
    try {
      await executeSimpleFlow();
    } catch (error) {
      showMsg("commandMsg", error.detail || error.message || "执行失败", false, {
        key: error?.toastKey || undefined,
        kind: "failed",
      });
    } finally {
      state.simpleFlowPending = false;
      state.simpleFlowPendingModule = "";
      state.simpleFlowPendingStartedAt = 0;
      if (!isPersonaWorkspaceModule(state.activeModule)) renderSimpleFlowModule(state.activeModule);
    }
  });
  });
}

function bindSimpleFlowInputs(moduleId) {
  [
    "simplePrimary",
    "simplePublishMode",
    "simpleAccount",
    "simplePersona",
    "simpleDraftPost",
    "simpleScheduleAt",
    "simpleSchedulePreset",
    "simpleScheduleYear",
    "simpleScheduleMonth",
    "simpleScheduleDay",
    "simpleScheduleHour",
    "simpleScheduleMinute",
    "simpleContent",
    "simpleTargetUrl",
    "simpleMediaFiles",
    "simpleTargetUrls",
  ].forEach((id) => {
    const node = $(id);
    if (!node) return;
    node.addEventListener(node.tagName === "TEXTAREA" || node.tagName === "INPUT" ? "input" : "change", async () => {
      if (id === "simplePrimary") state.simpleBranches[moduleId] = node.value;
      if (id === "simpleContent" && moduleId === "publishing" && normalizePublishContentSource() === "custom") {
        state.publishCustomContent = node.value || "";
      }
      if (id === "simplePublishMode" && moduleId === "publishing") {
        const previousMode = normalizedPublishMode(state.simpleBranches.publishing);
        const nextMode = normalizedPublishMode(node.value || "publish_now");
        if (nextMode !== previousMode && !(await confirmLeaveTransientWorkspaceState())) {
          node.value = previousMode;
          state.simpleBranches.publishing = previousMode;
          return;
        }
        state.simpleBranches.publishing = nextMode;
        renderSimpleFlowModule(moduleId);
        return;
      }
      if (id === "simpleSchedulePreset" && moduleId === "publishing") {
        state.publishSchedulePreset = node.value || "custom";
        const presetParts = schedulePresetParts(state.publishSchedulePreset);
        if (presetParts) state.publishScheduleParts = presetParts;
        renderSimpleFlowModule(moduleId);
        return;
      }
      if (id.startsWith("simpleSchedule") && id !== "simpleScheduleAt" && moduleId === "publishing") {
        state.publishSchedulePreset = "custom";
        if ($("simpleSchedulePreset")) $("simpleSchedulePreset").value = "custom";
        syncPublishScheduleStateFromInputs();
        updatePublishSchedulePreview();
        renderConfirmSummary();
        return;
      }
      if (id === "simplePrimary" && moduleId === "automation") {
        renderSimpleFlowModule(moduleId);
        return;
      }
      if (id === "simplePersona" && moduleId === "publishing") {
        const nextPersonaId = String(node.value || state.selectedPersonaId || "");
        const previousPersonaId = String(state.selectedPersonaId || "");
        if (nextPersonaId !== previousPersonaId && !(await confirmLeaveTransientWorkspaceState())) {
          node.value = previousPersonaId;
          return;
        }
        state.selectedPersonaId = node.value || state.selectedPersonaId;
        setSelectedPersonaPostId("");
        renderSimpleFlowModule(moduleId);
        return;
      }
      if (id === "simpleDraftPost" && moduleId === "publishing") {
        setSelectedPersonaPostId(node.value || "");
        renderSimpleFlowModule(moduleId);
        return;
      }
      if (id === "simpleAccount" && moduleId === "automation") renderSimpleFlowModule(moduleId);
      renderConfirmSummary();
    });
  });
  if (moduleId === "publishing") {
    document.querySelectorAll("[data-simple-publish-mode]").forEach((node) => {
      node.addEventListener("click", async () => {
        const nextMode = normalizedPublishMode(node.dataset.simplePublishMode || "publish_now");
        const previousMode = normalizedPublishMode(state.simpleBranches.publishing);
        if (nextMode !== previousMode && !(await confirmLeaveTransientWorkspaceState())) return;
        state.simpleBranches.publishing = nextMode;
        state.publishHistoryPreviewId = "";
        renderSimpleFlowModule("publishing");
      });
    });
    document.querySelectorAll("[data-publish-timing-mode]").forEach((node) => {
      node.addEventListener("click", () => {
        const nextMode = node.dataset.publishTimingMode === "scheduled" ? "scheduled" : "immediate";
        state.publishTimingMode = nextMode;
        if (nextMode === "scheduled" && !state.publishScheduleParts) state.publishScheduleParts = currentPublishScheduleParts();
        renderSimpleFlowModule("publishing");
      });
    });
    document.querySelectorAll("[data-publish-content-source]").forEach((node) => {
      node.addEventListener("click", async () => {
        const previousSource = normalizePublishContentSource();
        const nextSource = normalizePublishContentSource(node.dataset.publishContentSource || "posts");
        if (nextSource !== previousSource && !(await confirmLeaveTransientWorkspaceState())) return;
        state.publishContentSource = nextSource;
        renderSimpleFlowModule("publishing");
      });
    });
    document.querySelectorAll("[data-publish-source-select]").forEach((node) => {
      node.addEventListener("click", () => {
        const persona = selectedPersona();
        const source = normalizePublishContentSource();
        const rows = publishSourceRows(persona, source);
        const action = String(node.dataset.publishSourceSelect || "");
        setPublishSelectedPostIds(persona, source, action === "all" ? rows.map((post) => String(post.id || "")).filter(Boolean) : []);
        renderSimpleFlowModule("publishing");
      });
    });
    document.querySelectorAll("[data-publish-post-id]").forEach((node) => {
      node.addEventListener("change", () => {
        const persona = selectedPersona();
        const source = normalizePublishContentSource();
        const rows = publishSourceRows(persona, source);
        const selected = new Set(syncPublishSelectedPostIds(persona, source, rows));
        const postId = String(node.dataset.publishPostId || "").trim();
        if (node.checked) selected.add(postId);
        else selected.delete(postId);
        setPublishSelectedPostIds(persona, source, Array.from(selected));
        renderSimpleFlowModule("publishing");
      });
    });
    document.querySelectorAll("[data-publish-post-card]").forEach((node) => {
      node.addEventListener("click", (event) => {
        if (event.target.closest("input, button, a, select, textarea")) return;
        const persona = selectedPersona();
        const source = normalizePublishContentSource();
        const rows = publishSourceRows(persona, source);
        const postId = String(node.dataset.publishPostCard || "").trim();
        const selected = new Set(syncPublishSelectedPostIds(persona, source, rows));
        if (selected.has(postId)) selected.delete(postId);
        else selected.add(postId);
        setPublishSelectedPostIds(persona, source, Array.from(selected));
        renderSimpleFlowModule("publishing");
      });
    });
    document.querySelectorAll("[data-publish-preview-post]").forEach((node) => {
      node.addEventListener("click", () => {
        state.publishPreviewPostId = String(node.dataset.publishPreviewPost || "").trim();
        // Preview tabs only change the active post. Keep the surrounding
        // publish workspace and its scroll containers mounted to avoid a
        // full module repaint and the resulting scroll jump/white flash.
        if (!syncPublishPreviewSelectionDom()) renderSimpleFlowModule("publishing");
      });
    });
    document.querySelectorAll("[data-publish-history-card]").forEach((node) => {
      node.addEventListener("click", () => {
        state.publishHistoryPreviewId = String(node.dataset.publishHistoryCard || "").trim();
        renderSimpleFlowModule("publishing");
      });
    });
    document.querySelectorAll("[data-publish-history-requeue]").forEach((node) => {
      node.addEventListener("click", () => {
        requeuePublishHistoryRecord(node.dataset.publishHistoryRequeue || "").catch(() => {});
      });
    });
    document.querySelectorAll("[data-publish-use-persona]").forEach((node) => {
      node.addEventListener("click", async () => {
        const personaId = node.dataset.publishUsePersona || "";
        const mode = normalizedPublishMode($("simplePublishMode")?.value || state.simpleBranches.publishing);
        if (mode === "matrix_start") {
          toggleMatrixPersonaId(personaId);
          renderSimpleFlowModule("publishing");
          return;
        }
        if (String(personaId || "") !== String(state.selectedPersonaId || "") && !(await confirmLeaveTransientWorkspaceState())) return;
        selectPublishingPersona(personaId);
        renderSimpleFlowModule("publishing");
      });
    });
    document.querySelectorAll("[data-publish-open-persona]").forEach((node) => {
      node.addEventListener("click", async () => {
        if (!(await confirmLeaveTransientWorkspaceState())) return;
        selectPublishingPersona(node.dataset.publishOpenPersona || "");
        state.activeModule = "tweet_generation";
        state.personaGroup = "content";
        state.personaPanels.content = "posts";
        renderWorkspace();
      });
    });
    document.querySelectorAll("[data-publish-bind-persona]").forEach((node) => {
      node.addEventListener("click", async () => {
        if (!(await confirmLeaveTransientWorkspaceState())) return;
        selectPublishingPersona(node.dataset.publishBindPersona || "");
        state.activeModule = "personas";
        state.personaGroup = "settings";
        state.personaPanels.settings = "account";
        renderWorkspace();
      });
    });
    document.querySelectorAll("[data-publish-group-select]").forEach((node) => {
      node.addEventListener("click", () => {
        const groupId = String(node.dataset.publishGroupSelect || "").trim();
        const group = personaCollectionGroups().find((item) => String(item.id || "") === groupId);
        if (!group) return;
        const ids = (group.persona_ids || []).map((id) => String(id || "")).filter(Boolean);
        const selected = new Set(matrixPublishSelectedIds());
        const selection = publishGroupSelectionState(ids, Array.from(selected));
        if (selection.all) ids.forEach((id) => selected.delete(id));
        else ids.forEach((id) => selected.add(id));
        state.matrixPublish.personaIds = sortPersonaIdsByPublishOrder(Array.from(selected));
        state.matrixPublish.initialized = true;
        renderSimpleFlowModule("publishing");
      });
    });
  }
  ["matrixPublishSource", "matrixPublishPlatform", "matrixPublishCount", "simpleScheduleAt"].forEach((id) => {
    const node = $(id);
    if (!node || (id === "simpleScheduleAt" && !$("matrixPublishSource"))) return;
    node.addEventListener(node.tagName === "INPUT" ? "input" : "change", () => {
      updateMatrixPublishStateFromForm();
      if (id !== "simpleScheduleAt") renderSimpleFlowModule(moduleId);
    });
  });
  if (moduleId === "automation") {
    document.querySelectorAll("[data-automation-persona]").forEach((node) => {
      node.addEventListener("click", () => {
        const personaId = String(node.dataset.automationPersona || "").trim();
        if (!personaId) return;
        state.selectedPersonaId = personaId;
        state.preferredAccountId = accountForPersona(selectedPersona())?.id || "";
        setSelectedPersonaPostId("");
        renderSimpleFlowModule("automation");
      });
    });
    document.querySelectorAll("[data-automation-platform]").forEach((node) => {
      node.addEventListener("click", () => {
        state.personaAutomationPlatform = node.dataset.automationPlatform === "instagram" ? "instagram" : "threads";
        state.preferredAccountId = "";
        renderSimpleFlowModule("automation");
      });
    });
    document.querySelectorAll("[data-automation-account]").forEach((node) => {
      node.addEventListener("click", () => {
        state.preferredAccountId = node.dataset.automationAccount || "";
        renderSimpleFlowModule("automation");
      });
    });
    document.querySelectorAll("[data-automation-step]").forEach((node) => {
      node.addEventListener("click", () => {
        const step = String(node.dataset.automationStep || "binding");
        state.simpleBranches.automation = ["binding", "reply_comment", "reply_hot", "warmup"].includes(step) ? step : "binding";
        renderSimpleFlowModule("automation");
      });
    });
  }
  document.querySelectorAll("[data-matrix-persona]").forEach((node) => {
    node.addEventListener("change", () => {
      updateMatrixPublishStateFromForm();
      renderSimpleFlowModule(moduleId);
    });
  });
}

function fillSimpleAccounts() {
  const select = $("simpleAccount");
  if (!select) return;
  const accounts = uniqueAccountOptions(state.socialAccounts);
  select.innerHTML = accounts.length
    ? accounts.map((account) => `<option value="${esc(account.id)}">${esc(accountDisplayName(account))}</option>`).join("")
    : `<option value="">暂无账号</option>`;
}


function renderConfirmSummary() {
  const module = currentModule();
  let rows = [["当前入口", module.label]];
  if (isPersonaWorkspaceModule()) {
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
    }[step] || "显示当前步骤的参数面板";
    rows = rows.concat([
      ["当前人设", persona ? persona.name : "未选择"],
      ["当前步骤", personaGroupStepLabel(groupKey, step, profile)],
      ["最终动作", finalAction],
    ]);
  } else if (state.activeModule === "publishing" || state.activeModule === "automation") {
    const persona = state.personas.find((item) => String(item.id) === String($("simplePersona")?.value || state.selectedPersonaId)) || selectedPersona();
    const automationStep = currentBranch("automation");
    const account = state.activeModule === "publishing"
      ? publishAccountForPersona(persona)
      : selectedPersonaAutomationAccount(persona, selectedPersonaAutomationPlatform());
    rows = rows.concat([
      [state.activeModule === "publishing" ? "发布方式" : "当前操作", state.activeModule === "publishing" ? publishModeLabel($("simplePublishMode")?.value || state.simpleBranches.publishing) : personaGroupStepLabel("account", automationStep, selectedPersonaProfile())],
      ...(state.activeModule === "automation" ? [["当前人设", persona ? persona.name : "未选择"]] : []),
      [state.activeModule === "publishing" ? "发布账号" : "账号", account ? String(account.username || account.id) : "未选择"],
      ["最终动作", state.activeModule === "publishing" ? "提交发布任务" : "在统一自动化面板执行"],
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


function appendEvent(kind, message, options = {}) {
  const localized = localizeConsoleMessage(message || "");
  if (!localized) return;
  const eventKind = String(kind || "info").trim() || "info";
  const host = $("eventStream");
  if (host) host.replaceChildren();
  const ok = !["error", "failed", "warn", "warning"].includes(eventKind);
  showToast(`${eventKindLabel(eventKind)}：${localized}`, ok, {
    key: options.key || (options.taskId ? `task:${options.taskId}` : `event:${eventKind}:${localized}`),
    kind: eventKind,
    taskId: options.taskId,
    taskPanel: options.taskPanel,
    personaId: options.personaId,
    openDetail: options.openDetail,
    target: options.target,
  });
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

function watchTask(taskId, options = {}) {
  if (state.events) state.events.close();
  const suppressDisconnectWarning = Boolean(options.suppressDisconnectWarning);
  const onDone = typeof options.onDone === "function" ? options.onDone : null;
  const onError = typeof options.onError === "function" ? options.onError : null;
  syncWatchingTaskChip(taskId);
  const source = new EventSource(adminWorkspaceUrl(`/api/tasks/${encodeURIComponent(taskId)}/events`), { withCredentials: true });
  let settled = false;
  const closeWatcher = () => {
    source.close();
    if (state.events !== source) return;
    state.events = null;
    syncWatchingTaskChip("");
  };
  const settleTask = (payload, status) => {
    if (settled) return;
    settled = true;
    closeWatcher();
    if (onDone) onDone({ ...payload, status });
    loadTasks();
  };
  state.events = source;
  const handleTaskEvent = (event) => {
    let payload = {};
    try { payload = JSON.parse(event.data || "{}"); } catch {}
    const kind = String(payload.kind || payload.status || "progress");
    const dataStatus = String(payload?.data?.status || "").trim();
    const terminalStatus = ["success", "failed", "cancelled"].includes(dataStatus) ? dataStatus : "";
    const eventKind = terminalStatus || kind;
    const taskError = eventKind === "failed"
      ? String(payload?.data?.error || payload?.error || "").trim()
      : "";
    appendEvent(eventKind, taskError || payload.message || payload.detail || eventKind, {
      key: `task:${taskId}`,
      taskId,
      taskPanel: options.taskPanel || "regular",
    });
    if (["success", "failed", "cancelled"].includes(eventKind)) {
      settleTask(payload, eventKind);
    }
  };
  source.onmessage = handleTaskEvent;
  ["queued", "running", "progress", "log", "done", "analysis", "warning"].forEach((eventName) => {
    source.addEventListener(eventName, handleTaskEvent);
  });
  source.onerror = async () => {
    if (settled || state.events !== source) {
      source.close();
      return;
    }
    source.close();
    try {
      const task = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
      const taskStatus = String(task?.status || "").trim();
      if (["success", "failed", "cancelled"].includes(taskStatus)) {
        const taskError = taskStatus === "failed" ? String(task?.error || task?.detail || "").trim() : "";
        appendEvent(taskStatus, taskError || task?.message || `任务已${taskStatus === "success" ? "完成" : "结束"}。`, {
          key: `task:${taskId}`,
          taskId,
          taskPanel: options.taskPanel || "regular",
        });
        settleTask({ kind: "done", data: task }, taskStatus);
        return;
      }
    } catch {}
    if (settled || state.events !== source) return;
    if (!suppressDisconnectWarning) appendEvent("warn", "事件流已断开，可在任务队列继续查看结果。");
    closeWatcher();
    if (onError) onError();
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
    showMsg("commandMsg", "请先创建并选中一条推文。", false);
    return;
  }
  const source = personaPostSource(persona);
  const sourceLabel = source === "favorites" ? "收藏推文" : "草稿";
  const account = selectedPublishAccountForPersona(persona);
  if (!account) {
    await promptPersonaAccountBinding(persona);
    return;
  }
  if (!canSubmitPublishWithAccount(account)) {
    showMsg("commandMsg", publishAccountBlockMessage(account), false);
    return;
  }
  const lockParts = ["publish", source, persona.id, post.id, account.id];
  if (isActionLocked(...lockParts) || activeSocialTaskFor({ accountId: account.id, personaId: persona.id, taskType: "publish_post", postId: post.id, postSource: source })) {
    showMsg("commandMsg", `当前${sourceLabel}已经有发布任务在队列或执行中，请等待完成后再重复提交。`, false);
    return;
  }
  const platform = String(account.platform || "instagram").trim().toLowerCase() || "instagram";
  const scheduledAt = normalizeScheduleValueForApi($("personaPublishScheduleAt")?.value);
  if (!(await ensureDailyPublishCapacity(1, { scheduledAt }))) return;
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
    const mediaPaths = await uploadAutomationMedia(filesFromInput("personaPublishFiles"), "commandMsg");
    const postMediaItems = Array.isArray(post.media_items) ? post.media_items : [];
    if (platform === "instagram" && !mediaPaths.length && !postMediaItems.length) {
      showMsg("commandMsg", `Instagram 发布至少需要上传一份媒体，或先给当前${sourceLabel}添加媒体。`, false);
      return;
    }
    showMsg("commandMsg", `正在提交 ${publishPlatformLabel(account)} 发布任务到浏览器执行队列...`, true);
    const postSourcePath = source === "favorites" ? "favorites" : "posts";
    const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/${postSourcePath}/${encodeURIComponent(post.id)}/publish`, {
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
    const waitingForSchedule = isFutureScheduledSocialTask(task);
    mergeSocialTaskState(result.login_task, task);
    state.personaPublishResults[String(persona.id)] = renderPersonaPublishResult(task, []);
    updatePersonaPublishResultView(persona.id);
    if (taskId) {
      registerSocialTaskToastBatch(socialTaskToastLaneKey(task), [task]);
      syncSocialTaskToast(task, { force: true });
      if (!waitingForSchedule) refreshLiveBrowserSessionsSoon(taskId, 40, 500);
    }
    if (taskId && !waitingForSchedule) watchPersonaPublishTask(taskId, persona.id).catch((error) => {
      state.personaPublishResults[String(persona.id)] = `<div class="persona-warning-inline">${esc(error?.detail || error?.message || "任务结果轮询失败")}</div>`;
      updatePersonaPublishResultView(persona.id);
    });
    await loadSocial();
  } finally {
    setActionLocked(lockParts, false);
    if (isPersonaWorkspaceModule()) renderPersonaDetail();
  }
}

async function submitPublishContentTasks(accountId = "", persona = selectedPersona(), messageId = "commandMsg") {
  const source = normalizePublishContentSource();
  if (source === "custom") {
    return createSocialTask("publish_post", accountId, persona?.id || "", messageId);
  }
  if (!persona) {
    showMsg(messageId, "请先选择一个人设。", false);
    return null;
  }
  const account = publishAccountForPersona(persona);
  const cleanAccountId = String(accountId || account?.id || "").trim();
  if (!cleanAccountId || !account) {
    await promptPersonaAccountBinding(persona);
    return null;
  }
  if (!canSubmitPublishWithAccount(account)) {
    showMsg(messageId, publishAccountBlockMessage(account), false);
    return null;
  }
  const rows = publishSourceRows(persona, source);
  const selectedIds = syncPublishSelectedPostIds(persona, source, rows);
  const selectedInSourceOrder = rows.map((post) => String(post.id || "")).filter((id) => selectedIds.includes(id));
  const posts = rows.filter((post) => selectedInSourceOrder.includes(String(post.id || "")));
  if (!posts.length) {
    showMsg(messageId, `请先选择要发布的${publishContentSourceLabel(source)}。`, false);
    return null;
  }
  const platform = String(account.platform || "threads").trim().toLowerCase() || "threads";
  const scheduledAt = normalizeScheduleValueForApi($("simpleScheduleAt")?.value);
  if (!(await ensureDailyPublishCapacity(posts.length, { scheduledAt }))) return null;
  const lockParts = ["publish_content", source, persona.id, cleanAccountId, selectedInSourceOrder.join("_"), scheduledAt || "now"];
  const batchToastKey = socialTaskToastLaneKey({
    task_type: "publish_post",
    persona_id: persona.id,
    account_id: cleanAccountId,
  });
  if (isActionLocked(...lockParts)) {
    showMsg(messageId, "当前发布任务正在提交，请等待当前操作完成。", false);
    return null;
  }
  for (const post of posts) {
    if (activeSocialTaskFor({ accountId: cleanAccountId, personaId: persona.id, taskType: "publish_post", postId: post.id, postSource: source })) {
      showMsg(messageId, `已选${publishContentSourceLabel(source)}中存在正在队列或执行中的发布任务，请等待完成后再提交。`, false);
      return null;
    }
  }
  setActionLocked(lockParts, true);
  try {
    const mediaPaths = await uploadAutomationMedia(filesFromInput("simpleMediaFiles"), messageId);
    if (platform === "instagram") {
      const missingMedia = posts.find((post) => !mediaPaths.length && !(Array.isArray(post.media_items) && post.media_items.length));
      if (missingMedia) {
        showMsg(messageId, "Instagram 发布至少需要上传素材，或选择已有媒体的草稿/收藏。", false);
        return null;
      }
    }
    const postSourcePath = source === "favorites" ? "favorites" : "posts";
    showMsg(messageId, `正在提交 ${posts.length} 条${publishContentSourceLabel(source)}发布任务...`, true, {
      key: batchToastKey,
      kind: "queued",
    });
    const results = [];
    for (const [index, post] of posts.entries()) {
      const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/${postSourcePath}/${encodeURIComponent(post.id)}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: cleanAccountId,
          platform,
          scheduled_at: scheduledAt || undefined,
          media_paths: mediaPaths,
          priority: 50,
          max_retries: 2,
        }),
      });
      results.push(result);
      const task = result?.task;
      if (task?.id) {
        mergeSocialTaskState(result?.login_task, task);
        state.socialTaskToastLabels[String(task.id)] = `${index + 1}/${posts.length} 篇 · ${account.username || account.display_name || ""}`;
        registerSocialTaskToastBatch(batchToastKey, results.map((item) => item?.task).filter(Boolean));
        syncSocialTaskToast(task, { force: true });
        if (!isFutureScheduledSocialTask(task)) refreshLiveBrowserSessionsSoon(String(task.id), 40, 500);
      }
    }
    const immediateTasks = results.map((item) => item?.task).filter((task) => task?.id && !isFutureScheduledSocialTask(task));
    const immediateTaskIds = immediateTasks.map((task) => String(task.id));
    if (immediateTaskIds.length) {
      watchPersonaPublishTaskSequence(immediateTaskIds, persona.id).catch((error) => {
        showMsg(messageId, error?.detail || error?.message || "连续发布状态跟踪失败", false, {
          key: socialTaskToastKey(immediateTaskIds[0]),
          kind: "failed",
        });
      });
    }
    await loadSocial();
    await loadPersonaDraftPosts(persona.id, { force: true }).catch(() => {});
    if (source === "favorites") await loadPersonaFavoritePosts(persona.id, { force: true }).catch(() => {});
    return results;
  } catch (error) {
    if (error && typeof error === "object") {
      try { error.toastKey = batchToastKey; } catch (_) {}
    }
    throw error;
  } finally {
    setActionLocked(lockParts, false);
    if (state.activeModule === "publishing") renderSimpleFlowModule("publishing");
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
  refreshAutomationWorkSurface();
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
  refreshAutomationWorkSurface();
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

function personaProfileRegenState(personaId) {
  return state.personaProfileRegenDrafts[String(personaId || "")] || null;
}

function enterPersonaProfileRegenEdit(persona) {
  const key = String(persona?.id || "");
  if (!key) return;
  const name = String($("personaProfileName")?.value || persona.name || "").trim();
  const content = String($("personaProfileContent")?.value || persona.content || "").trim();
  state.personaProfileRegenDrafts[key] = {
    active: true,
    originalName: name,
    originalContent: content,
    name,
    content,
  };
  renderPersonaDetail();
  window.requestAnimationFrame(() => {
    $("personaProfileContent")?.focus();
  });
  showMsg("commandMsg", "已进入临时编辑状态，请填写新的生成方向后点击“确认生成”。", true);
}

function clearPersonaProfileRegenEdit(personaId) {
  const key = String(personaId || selectedPersona()?.id || "");
  const regenState = personaProfileRegenState(key);
  if (!key || !regenState?.active) return;
  state.personaProfileRegenDrafts[key] = {
    ...regenState,
    name: "",
    content: "",
  };
  renderPersonaDetail();
  window.requestAnimationFrame(() => {
    $("personaProfileName")?.focus();
  });
  showMsg("commandMsg", "已清空临时名称和简介，退出编辑可恢复原内容。", true);
}

function exitPersonaProfileRegenEdit(personaId) {
  const key = String(personaId || selectedPersona()?.id || "");
  if (!key) return;
  delete state.personaProfileRegenDrafts[key];
  renderPersonaDetail();
  showMsg("commandMsg", "已退出临时编辑，原简介已恢复。", true);
}

async function regeneratePersonaProfileContent() {
  const busyKind = personaCreateBusyKind();
  if (busyKind) {
    showMsg("commandMsg", `${busyKind}正在执行，请等待当前任务完成。`, false);
    return;
  }
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  const regenState = personaProfileRegenState(persona.id);
  if (!regenState?.active) {
    enterPersonaProfileRegenEdit(persona);
    return;
  }
  const name = String($("personaProfileName")?.value || persona.name || "").trim();
  const currentContent = String($("personaProfileContent")?.value || "").trim();
  if (!name) {
    showMsg("commandMsg", "请先填写人设名称。", false);
    return;
  }
  if (!currentContent) {
    showMsg("commandMsg", "请先填写新的生成方向。", false);
    $("personaProfileContent")?.focus();
    return;
  }
  const prompt = currentContent;
  state.personaCreateBusy.profileContent = true;
  try {
    showMsg("commandMsg", "正在重新生成人设简介...", true);
    const result = await api("/api/persona_dashboard/personas/ai_profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, prompt }),
    });
    const nextContent = String(result.content || "").trim();
    if (!nextContent) {
      showMsg("commandMsg", "AI 没有返回可用简介，请调整当前简介后再试。", false);
      return;
    }
    delete state.personaProfileRegenDrafts[String(persona.id || "")];
    const field = $("personaProfileContent");
    if (field) field.value = nextContent;
    const key = String(persona.id || "");
    if (state.personaProfiles[key]) {
      state.personaProfiles[key] = { ...state.personaProfiles[key], name, content: nextContent };
    }
    showMsg("commandMsg", "已重新生成并填入编辑框，确认无误后保存资料。", true);
  } finally {
    state.personaCreateBusy.profileContent = false;
    if (isPersonaWorkspaceModule()) renderPersonaDetail();
  }
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

function readPersonaPresetForm() {
  return {
    name: $("personaLinkPresetName")?.value.trim() || "",
    link_url: $("personaLinkPresetUrl")?.value.trim() || "",
    ending_text: $("personaLinkPresetEnding")?.value.trim() || "",
  };
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
  const form = readPersonaPresetForm();
  if (!form.link_url && !form.ending_text) {
    showMsg("commandMsg", "请先填写链接地址或结尾文案。", false);
    return;
  }
  const nextId = `preset-${Date.now().toString(36)}`;
  const nextPresets = draftPersonaPresetList(profile, (presets) => {
    presets.push({
      id: nextId,
      name: form.name || "链接模板",
      link_url: form.link_url,
      ending_text: form.ending_text,
      enabled: true,
    });
  });
  state.personaLinkPresetId = nextId;
  setPersonaLinkPresetPage(Math.ceil(nextPresets.length / 20));
  await savePersonaPresetList(nextPresets, String(profile.active_link_preset_id || nextId));
}

async function savePersonaPreset() {
  const profile = selectedPersonaProfile();
  const preset = selectedPersonaPreset(profile);
  if (!profile || !preset) return;
  const form = readPersonaPresetForm();
  if (!form.link_url && !form.ending_text) {
    showMsg("commandMsg", "请先填写链接地址或结尾文案。", false);
    return;
  }
  const nextPresets = draftPersonaPresetList(profile, (presets) => {
    const index = presets.findIndex((item) => String(item.id) === String(preset.id));
    if (index >= 0) {
      presets[index] = {
        ...presets[index],
        name: form.name || presets[index].name || "链接模板",
        link_url: form.link_url,
        ending_text: form.ending_text,
      };
    }
  });
  await savePersonaPresetList(nextPresets, String(profile.active_link_preset_id || preset.id));
}

async function deletePersonaPreset(presetId = "") {
  const profile = selectedPersonaProfile();
  const preset = personaPresetById(profile, presetId) || selectedPersonaPreset(profile);
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

async function activatePersonaPreset(presetId = "") {
  const profile = selectedPersonaProfile();
  const preset = personaPresetById(profile, presetId) || selectedPersonaPreset(profile);
  if (!profile || !preset) return;
  state.personaLinkPresetId = String(preset.id || "");
  await savePersonaPresetList(draftPersonaPresetList(profile, () => {}), String(preset.id));
}

async function viewPersonaPreset(presetId = "") {
  const profile = selectedPersonaProfile();
  const preset = personaPresetById(profile, presetId) || selectedPersonaPreset(profile);
  if (!profile || !preset) return;
  const isActive = String(profile.active_link_preset_id || "") === String(preset.id || "");
  await openConsoleModal({
    title: "链接模板详情",
    contentHtml: `
      <div class="console-modal-detail">
        <div><span>模板名称</span><strong>${esc(preset.name || "链接模板")}</strong></div>
        <div><span>状态</span><strong>${esc(isActive ? "当前启用" : "未启用")}</strong></div>
        <div><span>链接地址</span><strong>${preset.link_url ? `<a href="${esc(preset.link_url)}" target="_blank" rel="noreferrer">${esc(preset.link_url)}</a>` : "未填写"}</strong></div>
        <div><span>结尾文案</span><p>${esc(preset.ending_text || "未填写")}</p></div>
      </div>
    `,
    confirmText: "关闭",
    showCancel: false,
  });
}

async function deleteSelectedPersona(personaId = "") {
  const persona = personaId
    ? state.personas.find((item) => String(item.id) === String(personaId || ""))
    : selectedPersona();
  if (!persona) return;
  state.personaListEditorId = "";
  state.personaListEditorMode = "";
  removePersonaCardEditorPortal();
  const confirmed = await openConsoleModal({
    title: "删除人设",
    message: `确认删除人设「${persona.name || persona.id}」？删除后不可恢复。`,
    confirmText: "删除",
    danger: true,
  });
  if (!confirmed) return;
  await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}`, { method: "DELETE" });
  showMsg("commandMsg", "人设已删除。", true);
  if (String(state.selectedPersonaId || "") === String(persona.id || "")) {
    state.selectedPersonaId = "";
    setSelectedPersonaPostId("");
    state.personaCreateMode = false;
  }
  if (String(state.personaListEditorId || "") === String(persona.id || "")) {
    state.personaListEditorId = "";
    state.personaListEditorMode = "";
  }
  await loadPersonas();
}

async function deleteBulkSelectedPersonas() {
  if (state.personaBulkDeleting) return;
  const selectedIds = Array.from(personaBulkSelectedSet());
  if (!selectedIds.length) return;
  const confirmed = await openConsoleModal({
    title: "批量删除人设",
    message: `确认删除已选的 ${selectedIds.length} 个人设？人设档案、草稿、发布记录、分组和记忆关联将一并清理，且不可恢复。`,
    confirmText: `删除 ${selectedIds.length} 个`,
    danger: true,
  });
  if (!confirmed) return;

  state.personaBulkDeleting = true;
  renderPersonaModule();
  try {
    const result = await api("/api/persona_dashboard/personas/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona_ids: selectedIds }),
    });
    const deletedIds = new Set((result.deleted_ids || selectedIds).map((id) => String(id || "")));
    [
      state.personaProfiles,
      state.personaMemories,
      state.personaImageLibraries,
      state.personaDraftPosts,
      state.personaFavoritePosts,
      state.personaSelectedPostIds,
      state.personaPostSources,
      state.personaPostPages,
      state.personaPublishHistories,
      state.personaPublishAccountIds,
      state.personaPublishResults,
      state.personaAutomationResults,
    ].forEach((cache) => {
      if (!cache || typeof cache !== "object") return;
      deletedIds.forEach((id) => delete cache[id]);
    });
    Object.values(state.personaFetches || {}).forEach((cache) => {
      deletedIds.forEach((id) => delete cache?.[id]);
    });
    if (deletedIds.has(String(state.selectedPersonaId || ""))) {
      state.selectedPersonaId = "";
      setSelectedPersonaPostId("");
      state.personaCreateMode = false;
    }
    state.personaBulkSelectedIds = new Set();
    state.personaBulkMode = false;
    await loadPersonas();
    showMsg("commandMsg", `已删除 ${Number(result.deleted_count || deletedIds.size)} 个人设。`, true);
  } finally {
    state.personaBulkDeleting = false;
    if (state.personaBulkMode) renderPersonaModule();
  }
}

async function deleteBulkSelectedPersonaGroups() {
  if (state.personaBulkDeleting) return;
  const selectedIds = Array.from(personaBulkSelectedGroupSet());
  if (!selectedIds.length) return;
  const confirmed = await openConsoleModal({
    title: "批量删除分组",
    message: `确认删除已选的 ${selectedIds.length} 个分组？组内人设不会删除，将自动转为未分组。`,
    confirmText: `删除 ${selectedIds.length} 个`,
    danger: true,
  });
  if (!confirmed) return;

  state.personaBulkDeleting = true;
  renderPersonaModule();
  try {
    const result = await api("/api/persona_dashboard/groups/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_ids: selectedIds }),
    });
    state.personaBulkSelectedGroupIds = new Set();
    state.personaBulkMode = false;
    await loadPersonas();
    showMsg("commandMsg", `已删除 ${Number(result.deleted_count || selectedIds.length)} 个分组，组内人设已转为未分组。`, true);
  } finally {
    state.personaBulkDeleting = false;
    if (state.personaBulkMode) renderPersonaModule();
  }
}

async function duplicatePersonaArchive(personaId = "") {
  const cleanId = String(personaId || "").trim();
  const persona = state.personas.find((item) => String(item.id || "") === cleanId);
  if (!persona) return;
  state.personaListEditorId = "";
  state.personaListEditorMode = "";
  removePersonaCardEditorPortal();
  const confirmed = await openConsoleModal({
    title: "复制人设",
    message: `确认复制人设「${persona.name || persona.id}」？系统会直接拷贝当前人设数据并生成一份副本。`,
    confirmText: "复制",
  });
  if (!confirmed) return;
  showMsg("commandMsg", "正在复制人设...", true);
  const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(cleanId)}/duplicate`, { method: "POST" });
  const profile = result?.profile && typeof result.profile === "object" ? result.profile : null;
  if (profile?.id) {
    const newId = String(profile.id);
    state.selectedPersonaId = newId;
    setSelectedPersonaPostId("");
    delete state.personaDraftPosts[newId];
    delete state.personaFavoritePosts[newId];
    delete state.personaPublishHistories[newId];
    delete state.personaMemories[newId];
    delete state.personaImageLibraries[newId];
  }
  await loadPersonas();
  if (profile?.id) state.selectedPersonaId = String(profile.id);
  renderActivePersonaListSurface();
  renderConfirmSummary();
  showMsg("commandMsg", `已复制人设：${profile?.name || `${persona.name || persona.id} 副本`}`, true);
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
  refreshAutomationWorkSurface();
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
    showMsg("commandMsg", `${kind === "warmup" ? "养号" : "自动回复"}任务已提交：${result.task?.id || ""}`, true, {
      key: result.task?.id ? socialTaskToastKey(result.task.id, result.task) : undefined,
      kind: "queued",
      taskId: result.task?.id || "",
      taskPanel: "persona",
      personaId: persona.id,
    });
  } finally {
    setActionLocked(lockParts, false);
    refreshAutomationWorkSurface();
  }
}

async function clearPersonaAutomationTasks() {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  await clearPersonaAutomationTasksFor(persona.id, "commandMsg");
}

async function clearPersonaAutomationTasksFor(personaId, messageId = "commandMsg") {
  const cleanPersonaId = String(personaId || "").trim();
  if (!cleanPersonaId) {
    showMsg(messageId, "请先选择一个人设。", false);
    return;
  }
  await api(`/api/persona_dashboard/automation/tasks?persona_id=${encodeURIComponent(cleanPersonaId)}`, { method: "DELETE" });
  showMsg(messageId, "该人设的自动化队列记录已删除。", true);
  await loadSocial();
  if (state.view === "tasks") await loadTasks().catch(() => {});
}

async function openPersonaAccountBindingPage(persona = selectedPersona(), account = null) {
  const personaId = String(persona?.id || state.selectedPersonaId || "").trim();
  const targetAccount = account || publishAccountForPersona(persona) || accountForPersona(persona);
  if (personaId) {
    state.selectedPersonaId = personaId;
    state.accountPoolPersonaId = personaId;
  }
  if (targetAccount?.platform) state.accountPoolPlatform = normalizeAccountPoolPlatform(targetAccount.platform);
  if (targetAccount?.id) {
    state.accountPoolAccountId = String(targetAccount.id || "");
    state.accountPoolSelectedAccountIds = [String(targetAccount.id || "")];
  }
  state.accountBrowserPanel = "accounts";
  setView("accounts");
  await loadSocial().catch(() => {});
  renderWorkspace();
  renderSocialAccounts();
  window.requestAnimationFrame(() => {
    const target = targetAccount?.id
      ? Array.from(document.querySelectorAll("[data-account-pool-account]")).find((item) => String(item.dataset.accountPoolAccount || "") === String(targetAccount.id))
      : document.querySelector("[data-account-pool-create]");
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  });
  return true;
}

async function promptPersonaAccountBinding(persona = selectedPersona()) {
  const account = publishAccountForPersona(persona);
  const confirmed = await openConsoleModal({
    title: account ? "管理发布账号" : "绑定发布账号",
    message: account ? publishAccountBlockMessage(account) : "当前人设还没有绑定 Threads 或 Instagram 执行账号。请到账号管理自动化绑定账号后再发布。",
    confirmText: account ? "继续处理" : "绑定账号",
    cancelText: "取消",
  });
  if (!confirmed) return false;
  return openPersonaAccountBindingPage(persona, account);
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
    const personaId = state.activeModule === "publishing"
      ? (selectedPersona()?.id || "")
      : ($("simplePersona")?.value || selectedPersona()?.id || "");
    if (state.activeModule === "publishing") {
      const currentPublishMode = normalizedPublishMode($("simplePublishMode")?.value || state.simpleBranches.publishing);
      if (currentPublishMode === "publish_history") {
        showMsg("commandMsg", "发布历史仅用于查看记录，不会创建发布任务。", false);
        return;
      }
      if (currentPublishMode === "matrix_start") {
        await submitMatrixPublishTask("commandMsg");
        return;
      }
      const persona = state.personas.find((item) => String(item.id) === String(personaId)) || selectedPersona();
      accountId = publishAccountForPersona(persona)?.id || "";
      if (normalizePublishContentSource() !== "custom") {
        const result = await submitPublishContentTasks(accountId, persona, "commandMsg");
        const resultItems = Array.isArray(result) ? result : (result ? [result] : []);
        const resultTasks = resultItems.map((item) => item?.task).filter((task) => task?.id);
        const createdTasks = Array.isArray(result?.created) ? result.created : [];
        const taskIds = [
          ...resultTasks.map((task) => String(task.id || "").trim()),
          ...createdTasks.map((task) => String(task?.id || "").trim()),
        ].filter(Boolean);
        return;
      }
    }
    if (!accountId) {
      if (state.activeModule === "publishing") {
        const persona = state.personas.find((item) => String(item.id) === String(personaId)) || selectedPersona();
        await promptPersonaAccountBinding(persona);
        return;
      }
      showMsg("commandMsg", "请先选择执行账号。", false);
      return;
    }
    const taskType = $("simplePrimary")?.value || selectedBranch(state.activeModule);
    const result = await createSocialTask(taskType, accountId, personaId, "commandMsg");
    const taskId = String(result?.task?.id || "").trim();
    if (taskId) {
      appendEvent("queued", `${taskType} 已提交到指纹浏览器任务队列`, {
        key: socialTaskToastKey(taskId, result?.task),
        taskId,
        taskPanel: personaId ? "persona" : "regular",
        personaId,
      });
    }
    return;
  }
  setView("workspace");
}

async function loadMe() {
  const meName = $("consoleMeName");
  try {
    const me = await api("/api/me");
    if (me.must_change_password) {
      handleSessionBoundary(428);
      return null;
    }
    state.currentUser = me;
    if (meName) meName.textContent = me.username || "-";
    window.VectoSiteNavigation?.setAccount(me);
    if (me.is_admin) $("openAdmin").hidden = false;
    return me;
  } catch (error) {
    state.currentUser = null;
    window.VectoSiteNavigation?.setAccount(null);
    if (meName) meName.textContent = "本地控制台";
    $("openAdmin").hidden = true;
    if (!consoleBoundaryNavigationActive) {
      appendEvent("error", error.detail || error.message || "本地控制台会话不可用");
    }
    throw error;
  }
}

async function revalidateConsoleIdentity() {
  if (!consoleIdentityReady || consoleBoundaryNavigationActive) return null;
  maskConsoleForIdentityRevalidation();
  if (identityRevalidationPromise) return identityRevalidationPromise;
  const expectedUserId = consoleUserId(state.currentUser?.id);
  identityRevalidationPromise = api("/api/me")
    .then((me) => {
      if (me.must_change_password) {
        handleSessionBoundary(428);
        return null;
      }
      if (!expectedUserId || consoleUserId(me.id) !== expectedUserId) {
        reloadForIdentityChange();
        return null;
      }
      state.currentUser = me;
      const meName = $("consoleMeName");
      if (meName) meName.textContent = me.username || "-";
      window.VectoSiteNavigation?.setAccount(me);
      unmaskConsoleAfterIdentityRevalidation();
      return me;
    })
    .catch((error) => {
      if (!consoleBoundaryNavigationActive && !error?.stale) {
        appendEvent("warning", error.detail || error.message || "会话身份校验失败");
      }
      unmaskConsoleAfterIdentityRevalidation();
      return null;
    })
    .finally(() => {
      identityRevalidationPromise = null;
    });
  return identityRevalidationPromise;
}

let consoleLogoutPending = false;

async function logoutConsoleSession() {
  if (consoleLogoutPending || consoleBoundaryNavigationActive) return;
  consoleLogoutPending = true;
  window.VectoSiteNavigation?.setLogoutPending(true);
  try {
    await api("/api/auth/logout", { method: "POST" });
    consoleBoundaryNavigationActive = true;
    clearTenantInMemoryState();
    purgeLegacyTenantContentCaches();
    if (ADMIN_CONSOLE_SESSION) clearStoredAdminWorkspaceContext();
    window.VectoSiteNavigation?.setAccount(null);
    window.location.replace(ADMIN_CONSOLE_SESSION ? "/admin" : "/");
  } catch (error) {
    consoleLogoutPending = false;
    const message = error?.detail || error?.message || "退出失败，请重试。";
    window.VectoSiteNavigation?.setLogoutPending(false, message);
    showToast(message, false);
  }
}

async function loadSetupStatus() {
  try {
    state.setupStatus = { runtime_config: await api("/api/admin/runtime_config") };
  } catch (error) {
    state.setupStatus = null;
    appendEvent("warning", error.detail || error.message || "读取运行配置失败");
  }
}

function schedulePersonaDetailRender(personaId = "") {
  const key = String(personaId || "").trim();
  if (!isPersonaWorkspaceModule() || (key && key !== String(state.selectedPersonaId || ""))) return;
  if (state.personaDetailRenderTimer) clearTimeout(state.personaDetailRenderTimer);
  state.personaDetailRenderTimer = setTimeout(() => {
    state.personaDetailRenderTimer = 0;
    if (isPersonaWorkspaceModule() && (!key || key === String(state.selectedPersonaId || ""))) {
      renderPersonaDetail();
    }
  }, 80);
}

function handlePersonaImageLibraryWheel(event) {
  const scroller = event.target.closest?.(".persona-image-library-grid");
  if (!scroller) return;
  const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
  if (maxScrollLeft <= 1) return;
  const verticalDelta = Number(event.deltaY || 0);
  const horizontalDelta = Number(event.deltaX || 0);
  const dominantDelta = Math.abs(horizontalDelta) > Math.abs(verticalDelta) ? horizontalDelta : verticalDelta;
  if (!dominantDelta) return;
  const nextLeft = Math.min(Math.max(scroller.scrollLeft + dominantDelta, 0), maxScrollLeft);
  if (nextLeft === scroller.scrollLeft) return;
  event.preventDefault();
  scroller.scrollLeft = nextLeft;
}

function applyPersonaOverviewData(data, { fromCache = false } = {}) {
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
  Object.keys(state.personaFavoritePosts).forEach((id) => {
    if (!validIds.has(id)) delete state.personaFavoritePosts[id];
  });
  Object.keys(state.personaSelectedPostIds).forEach((key) => {
    const [personaId] = String(key || "").split(":");
    if (!validIds.has(personaId)) delete state.personaSelectedPostIds[key];
  });
  Object.keys(state.personaPostSources).forEach((id) => {
    if (!validIds.has(id)) delete state.personaPostSources[id];
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
  state.personas.forEach(applyPersonaOverviewPostRows);
  if (state.selectedPersonaId) {
    Promise.all([
      loadPersonaProfile(state.selectedPersonaId).catch(() => {}),
      loadPersonaDraftPosts(state.selectedPersonaId).catch(() => {}),
      loadPersonaFavoritePosts(state.selectedPersonaId).catch(() => {}),
      loadPersonaMemories(state.selectedPersonaId).catch(() => {}),
      loadPersonaPublishHistory(state.selectedPersonaId).catch(() => {}),
    ]).catch(() => {});
  }
  if (state.view === "accounts" || isPersonaWorkspaceModule() || state.activeModule === "publishing" || state.activeModule === "automation") renderActivePersonaListSurface();
  if (!fromCache) savePersonaConsoleOverview(data);
}

function hydratePersonaOverviewFromCache() {
  const cached = storedPersonaConsoleOverview();
  if (!cached || !Array.isArray(cached.personas) || !cached.personas.length) return false;
  applyPersonaOverviewData(cached, { fromCache: true });
  return true;
}

function hydratePersonaOverviewFromBootstrap(currentUser = state.currentUser) {
  const bootstrap = window.__CONSOLE_BOOTSTRAP__;
  const expectedUserId = consoleBootstrapUserId();
  const currentUserId = consoleUserId(currentUser?.id);
  if (!expectedUserId || !currentUserId || expectedUserId !== currentUserId) {
    discardConsoleBootstrap();
    return false;
  }
  if (!bootstrap || typeof bootstrap !== "object" || !Array.isArray(bootstrap.personas) || !bootstrap.personas.length) {
    discardConsoleBootstrap();
    return false;
  }
  applyPersonaOverviewData(bootstrap);
  discardConsoleBootstrap();
  return true;
}

async function loadPersonas() {
  const data = await api("/api/persona_dashboard/console_overview")
    .catch(() => api("/api/persona_dashboard/overview"))
    .catch(() => ({ personas: [] }));
  applyPersonaOverviewData(data);
}

async function refreshPersonaCollections(message = "") {
  await loadPersonas();
  if (state.activeModule === "publishing") renderSimpleFlowModule("publishing");
  if (message) showMsg("commandMsg", message, true);
}

function currentPublishingPersonaId() {
  return String($("simplePersona")?.value || state.selectedPersonaId || selectedPersona()?.id || "").trim();
}

async function refreshCurrentPublishingPersonaContent({ force = false } = {}) {
  const personaIds = visiblePublishPersonaIdsForRefresh();
  if (!personaIds.length) return [];
  const tasks = personaIds.flatMap((personaId) => [
    loadPersonaDraftPosts(personaId, { force }).catch(() => []),
    loadPersonaFavoritePosts(personaId, { force }).catch(() => []),
    loadPersonaPublishHistory(personaId, { force }).catch(() => []),
  ]);
  const result = await Promise.all(tasks);
  if (state.activeModule === "publishing") renderSimpleFlowModule("publishing");
  return result;
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

function normalizeBrowserPreferences(value) {
  const raw = value && typeof value === "object" ? value : {};
  const completionPolicy = String(raw.completion_policy || "immediate_close") === "review_hold" ? "review_hold" : "immediate_close";
  const rawReviewHoldSeconds = Number(raw.review_hold_seconds);
  const reviewHoldSeconds = Math.min(Math.max(Math.round(Number.isFinite(rawReviewHoldSeconds) ? rawReviewHoldSeconds : 30), 10), 300);
  const rawStandbySeconds = Number(raw.standby_seconds);
  const standbySeconds = Math.min(Math.max(Math.round(Number.isFinite(rawStandbySeconds) ? rawStandbySeconds : 0), 0), 3600);
  const rawAutoCloseSeconds = Number(raw.auto_close_seconds);
  const autoCloseSeconds = Math.min(Math.max(Math.round(Number.isFinite(rawAutoCloseSeconds) ? rawAutoCloseSeconds : reviewHoldSeconds), 10), 86400);
  const rawManualTimeout = Number(raw.manual_timeout_seconds);
  const manualTimeout = Math.min(Math.max(Math.round(Number.isFinite(rawManualTimeout) ? rawManualTimeout : 900), 300), 1800);
  const rawRequestedConcurrency = Number(raw.requested_concurrency);
  const requestedConcurrency = Math.min(Math.max(Math.round(Number.isFinite(rawRequestedConcurrency) ? rawRequestedConcurrency : 2), 1), 12);
  return {
    completion_policy: completionPolicy,
    review_hold_seconds: reviewHoldSeconds,
    standby_seconds: standbySeconds,
    auto_close_seconds: autoCloseSeconds,
    manual_timeout_seconds: manualTimeout,
    requested_concurrency: requestedConcurrency,
    text_input_mode: String(raw.text_input_mode || "paste") === "type" ? "type" : "paste",
  };
}

function browserDurationLabel(seconds = 0) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value === 0) return "不额外等待";
  if (value % 3600 === 0) return `${value / 3600} 小时`;
  if (value % 60 === 0) return `${value / 60} 分钟`;
  return `${value} 秒`;
}

function browserDurationOptions(current, presets, forceCustom = false) {
  const currentValue = Number(current) || 0;
  const usesPreset = !forceCustom && presets.includes(currentValue);
  return `${presets.map((value) => `<option value="${value}" ${usesPreset && currentValue === value ? "selected" : ""}>${esc(browserDurationLabel(value))}</option>`).join("")}<option value="custom" ${usesPreset ? "" : "selected"}>自定义时间</option>`;
}

function browserDurationValue(selectId, customInputId, fallback) {
  const select = $(selectId);
  if (!select) return fallback;
  if (select.value !== "custom") return select.value;
  return $(customInputId)?.value ?? fallback;
}

function browserDurationControlState(field, current, presets) {
  const draft = state.browserDurationDrafts?.[field] || null;
  const currentValue = Number(current) || 0;
  return {
    usesCustom: draft?.mode ? draft.mode === "custom" : !presets.includes(currentValue),
    rawValue: draft && Object.hasOwn(draft, "rawValue") ? String(draft.rawValue) : String(currentValue),
  };
}

function updateBrowserDurationDraft(field, values) {
  state.browserDurationDrafts ||= {};
  state.browserDurationDrafts[field] = {
    ...(state.browserDurationDrafts[field] || {}),
    ...values,
  };
}

function syncBrowserDurationCustomField(select, { focus = false } = {}) {
  if (!select) return;
  const input = $(select.dataset.browserDurationCustomInput || "");
  const wrapper = input?.closest(".browser-duration-custom");
  const usesCustom = select.value === "custom";
  const field = String(input?.dataset.browserDurationField || "");
  if (field) updateBrowserDurationDraft(field, { mode: usesCustom ? "custom" : "preset" });
  if (wrapper) wrapper.hidden = !usesCustom;
  if (input) {
    input.disabled = select.disabled || !usesCustom;
    if (usesCustom && focus) {
      input.focus();
      input.select();
    }
  }
  updateBrowserPreferencesDraft();
}

function browserPreferencesResponseValue(result) {
  const response = result && typeof result === "object" ? result : {};
  return normalizeBrowserPreferences(response.preferences || response.browser_preferences || response.settings || response);
}

function browserRecommendationResponseValue(result) {
  const response = result && typeof result === "object" ? result : {};
  const legacy = response.recommendation || response.browser_recommendation;
  if (legacy && typeof legacy === "object") return legacy;
  const environment = response.environment && typeof response.environment === "object" ? response.environment : {};
  const recommended = response.recommended && typeof response.recommended === "object" ? response.recommended : {};
  const limits = response.limits && typeof response.limits === "object" ? response.limits : {};
  return {
    ...environment,
    recommended,
    reasons: Array.isArray(response.reasons) ? response.reasons : [],
    limits: {
      recommended_concurrency: recommended.requested_concurrency,
      global_max_concurrency: limits.global_max_concurrency,
      manual_timeout_minutes: Number(recommended.manual_timeout_seconds || 0) / 60 || undefined,
    },
  };
}

function browserResourceLevelLabel(value = "") {
  const level = String(value || "").trim().toLowerCase();
  return ({ low: "资源紧张", limited: "资源紧张", medium: "资源均衡", balanced: "资源均衡", high: "资源充足", strong: "资源充足", ample: "资源充足" })[level]
    || String(value || "待检测");
}

function browserEffectiveLimitLabel(key = "") {
  return ({
    requested_concurrency: "请求并发",
    recommended_concurrency: "建议并发",
    global_max_concurrency: "系统并发上限",
    manual_timeout_minutes: "人工接管分钟",
    effective_concurrency: "有效并发",
    max_concurrency: "并发上限",
    browser_concurrency: "浏览器并发",
    manual_sessions: "人工接管窗口",
    memory_mb: "可用内存 MB",
  })[String(key || "")] || String(key || "").replaceAll("_", " ");
}

function renderBrowserRecommendationCard() {
  const recommendation = state.browserRecommendation || {};
  const reasons = Array.isArray(recommendation.reasons) ? recommendation.reasons : [];
  const limits = recommendation.effective_limits || recommendation.effectiveLimits || recommendation.limits || {};
  const limitEntries = limits && typeof limits === "object" ? Object.entries(limits) : [];
  const loading = state.browserRecommendationRefreshing || state.browserPolicyLoading;
  return `
    <article class="browser-recommendation-card" aria-busy="${loading ? "true" : "false"}">
      <div class="browser-recommendation-head">
        <div>
          <span>环境建议</span>
          <strong>${esc(loading && !state.browserRecommendation ? "正在检测环境" : browserResourceLevelLabel(recommendation.resource_level))}</strong>
        </div>
        <div class="browser-recommendation-actions">
          <button type="button" data-browser-recommendation-refresh aria-busy="${state.browserRecommendationRefreshing ? "true" : "false"}" ${loading ? "disabled" : ""}>${state.browserRecommendationRefreshing ? "检测中" : "重新检测"}</button>
          <button type="button" class="primary" data-browser-auto-configure aria-busy="${state.browserAutoConfiguring ? "true" : "false"}" ${state.browserAutoConfiguring || loading ? "disabled" : ""}>${state.browserAutoConfiguring ? "配置中" : "一键配置"}</button>
        </div>
      </div>
      <p>${esc(recommendation.summary || (loading ? "正在评估当前设备可用资源。" : "检测后会给出适合当前环境的浏览器策略。"))}</p>
      <div class="browser-effective-limits" aria-label="有效限制">
        ${limitEntries.length ? limitEntries.map(([key, value]) => `<span><b>${esc(browserEffectiveLimitLabel(key))}</b>${esc(value)}</span>`).join("") : "<span class=\"is-empty\">有效限制等待检测</span>"}
      </div>
      ${reasons.length ? `<ul>${reasons.map((reason) => `<li>${esc(typeof reason === "string" ? reason : reason?.summary || reason?.message || "")}</li>`).join("")}</ul>` : ""}
    </article>
  `;
}

function syncPublishPreviewSelectionDom() {
  const persona = selectedPersona();
  const source = normalizePublishContentSource();
  if (!persona || source === "custom") return false;
  const sourceRows = publishSourceRows(persona, source);
  const selectedPosts = selectedPublishPosts(persona, source);
  const activePost = activePublishPreviewPost(selectedPosts);
  document.querySelectorAll("[data-publish-preview-post]").forEach((node) => {
    const active = String(node.dataset.publishPreviewPost || "") === String(activePost?.id || "");
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const card = document.querySelector(".publish-preview-card");
  if (card) card.outerHTML = renderPublishPreviewCard(activePost, sourceRows, persona);
  const content = $("simpleContent");
  if (content) content.value = String(activePost?.content || "");
  renderConfirmSummary();
  return true;
}

function renderConsoleSettingsPage() {
  const host = $("consoleSettingsBody");
  if (!host) return;
  const taskPersonaPageSize = Math.min(Math.max(Number(state.taskQueuePersonaPageSize || 12), 1), 100);
  const taskRegularPageSize = Math.min(Math.max(Number(state.taskQueueRegularPageSize || 20), 1), 100);
  const personaPostPageSize = Math.min(Math.max(Number(state.personaPostPageSize || 10), 5), 80);
  const preferences = normalizeBrowserPreferences(state.browserPreferences || {});
  const standbyPresets = [0, 30, 60, 120, 300, 600, 1800, 3600];
  const autoClosePresets = [10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 43200, 86400];
  const manualTimeoutPresets = [300, 600, 900, 1800];
  const standbyControl = browserDurationControlState("standby_seconds", preferences.standby_seconds, standbyPresets);
  const autoCloseControl = browserDurationControlState("auto_close_seconds", preferences.auto_close_seconds, autoClosePresets);
  const manualTimeoutControl = browserDurationControlState("manual_timeout_seconds", preferences.manual_timeout_seconds, manualTimeoutPresets);
  host.innerHTML = `
    <div class="console-settings-page">
      <div class="console-settings-actions">
        <span>浏览器策略按当前用户保存；分页设置仅保存在本机浏览器。</span>
        <button type="button" class="primary" id="saveConsoleSettings">保存设置</button>
      </div>
      <section class="console-settings-group">
        <div class="console-settings-group-head">
          <strong>列表与分页</strong>
          <span>控制人设、草稿收藏和任务队列的分页展示数量。</span>
        </div>
        <div class="console-settings-grid">
          <label class="console-setting-card"><span>人设列表每页数量</span><input id="settingsPersonaPageSize" type="number" min="5" max="80" step="1" value="${esc(state.personaListPageSize || 20)}" /></label>
          <label class="console-setting-card"><span>草稿收藏每页数量</span><input id="settingsPersonaPostPageSize" type="number" min="5" max="80" step="1" value="${esc(personaPostPageSize)}" /></label>
          <label class="console-setting-card"><span>人设队列每页数量</span><input id="settingsTaskQueuePersonaPageSize" type="number" min="1" max="100" step="1" value="${esc(taskPersonaPageSize)}" /></label>
          <label class="console-setting-card"><span>通用队列每页数量</span><input id="settingsTaskQueueRegularPageSize" type="number" min="1" max="100" step="1" value="${esc(taskRegularPageSize)}" /></label>
        </div>
      </section>
      <section class="console-settings-group browser-policy-group">
        <div class="console-settings-group-head">
          <strong>浏览器执行策略</strong>
          <span>这些设置跟随当前用户，用于控制任务完成、人工接管和并发行为。</span>
        </div>
        <div class="console-settings-grid browser-policy-grid">
          <div class="console-setting-card console-setting-card-wide">
            <span>任务完成后</span>
            <div class="automation-capsule-tabs console-input-mode-tabs" aria-label="任务完成策略">
              <button type="button" class="${preferences.completion_policy === "immediate_close" ? "is-active" : ""}" data-browser-completion-policy="immediate_close">立即关闭</button>
              <button type="button" class="${preferences.completion_policy === "review_hold" ? "is-active" : ""}" data-browser-completion-policy="review_hold">保留检查</button>
            </div>
            <em>保留检查仅供检查，不提升速度。</em>
          </div>
          <label class="console-setting-card ${preferences.completion_policy === "review_hold" ? "" : "is-disabled"}">
            <span>完成后待机时间</span>
            <div class="browser-duration-control">
              <select id="settingsBrowserStandbySeconds" data-browser-duration-select data-browser-duration-custom-input="settingsBrowserStandbyCustomSeconds" data-browser-preference-field ${preferences.completion_policy === "review_hold" ? "" : "disabled"}>
                ${browserDurationOptions(preferences.standby_seconds, standbyPresets, standbyControl.usesCustom)}
              </select>
              <div class="browser-duration-custom" ${standbyControl.usesCustom ? "" : "hidden"}>
                <input id="settingsBrowserStandbyCustomSeconds" data-browser-duration-field="standby_seconds" data-browser-preference-field type="number" min="0" max="3600" step="1" value="${esc(standbyControl.rawValue)}" ${preferences.completion_policy === "review_hold" && standbyControl.usesCustom ? "" : "disabled"} />
                <span>秒</span>
              </div>
            </div>
            <em>任务结束后先保留实时窗口，最长可设 1 小时。</em>
          </label>
          <label class="console-setting-card ${preferences.completion_policy === "review_hold" ? "" : "is-disabled"}">
            <span>待机后自动关闭</span>
            <div class="browser-duration-control">
              <select id="settingsBrowserAutoCloseSeconds" data-browser-duration-select data-browser-duration-custom-input="settingsBrowserAutoCloseCustomSeconds" data-browser-preference-field ${preferences.completion_policy === "review_hold" ? "" : "disabled"}>
                ${browserDurationOptions(preferences.auto_close_seconds, autoClosePresets, autoCloseControl.usesCustom)}
              </select>
              <div class="browser-duration-custom" ${autoCloseControl.usesCustom ? "" : "hidden"}>
                <input id="settingsBrowserAutoCloseCustomSeconds" data-browser-duration-field="auto_close_seconds" data-browser-preference-field type="number" min="10" max="86400" step="1" value="${esc(autoCloseControl.rawValue)}" ${preferences.completion_policy === "review_hold" && autoCloseControl.usesCustom ? "" : "disabled"} />
                <span>秒</span>
              </div>
            </div>
            <em>总保留时间为待机时间与自动关闭时间之和。</em>
          </label>
          <label class="console-setting-card">
            <span>人工接管超时</span>
            <div class="browser-duration-control">
              <select id="settingsManualTimeoutSeconds" data-browser-duration-select data-browser-duration-custom-input="settingsManualTimeoutCustomSeconds" data-browser-preference-field>
                ${browserDurationOptions(preferences.manual_timeout_seconds, manualTimeoutPresets, manualTimeoutControl.usesCustom)}
              </select>
              <div class="browser-duration-custom" ${manualTimeoutControl.usesCustom ? "" : "hidden"}>
                <input id="settingsManualTimeoutCustomSeconds" data-browser-duration-field="manual_timeout_seconds" data-browser-preference-field type="number" min="300" max="1800" step="1" value="${esc(manualTimeoutControl.rawValue)}" ${manualTimeoutControl.usesCustom ? "" : "disabled"} />
                <span>秒</span>
              </div>
            </div>
            <em>可自定义 5 到 30 分钟内的任意秒数。</em>
          </label>
          <label class="console-setting-card">
            <span>请求并发任务数</span>
            <input id="settingsRequestedConcurrency" data-browser-preference-field type="number" min="1" max="12" step="1" value="${esc(preferences.requested_concurrency)}" />
            <em>实际并发会受环境建议中的有效限制约束。</em>
          </label>
          <div class="console-setting-card">
            <span>发布正文输入方式</span>
            <div class="automation-capsule-tabs console-input-mode-tabs" aria-label="发布正文输入方式">
              <button type="button" class="${preferences.text_input_mode === "paste" ? "is-active" : ""}" data-browser-text-input-mode="paste">复制粘贴</button>
              <button type="button" class="${preferences.text_input_mode === "type" ? "is-active" : ""}" data-browser-text-input-mode="type">逐字输入</button>
            </div>
          </div>
          ${renderBrowserRecommendationCard()}
        </div>
      </section>
    </div>
  `;
  if (!state.browserPolicyLoaded && !state.browserPolicyLoading) loadBrowserPolicySettings();
}

function updateBrowserPreferencesDraft() {
  const current = normalizeBrowserPreferences(state.browserPreferences || {});
  state.browserPreferences = normalizeBrowserPreferences({
    ...current,
    standby_seconds: browserDurationValue("settingsBrowserStandbySeconds", "settingsBrowserStandbyCustomSeconds", current.standby_seconds),
    auto_close_seconds: browserDurationValue("settingsBrowserAutoCloseSeconds", "settingsBrowserAutoCloseCustomSeconds", current.auto_close_seconds),
    review_hold_seconds: Math.min(Number(browserDurationValue("settingsBrowserAutoCloseSeconds", "settingsBrowserAutoCloseCustomSeconds", current.auto_close_seconds)), 300),
    manual_timeout_seconds: browserDurationValue("settingsManualTimeoutSeconds", "settingsManualTimeoutCustomSeconds", current.manual_timeout_seconds),
    requested_concurrency: $("settingsRequestedConcurrency")?.value ?? current.requested_concurrency,
  });
  state.browserPreferencesDirty = true;
  return state.browserPreferences;
}

function setBrowserPreferenceChoice(field, value) {
  const current = updateBrowserPreferencesDraft();
  state.browserPreferences = normalizeBrowserPreferences({ ...current, [field]: value });
  state.browserPreferencesDirty = true;
  renderConsoleSettingsPage();
}

function refreshConsoleSettingsDependents() {
  if ((isPersonaWorkspaceModule() || state.activeModule === "publishing") && $("moduleBody")) {
    renderActivePersonaListSurface();
  }
  if (state.view === "tasks" && $("taskTable")) {
    $("taskTable").innerHTML = renderTaskQueueView();
  }
  if (state.view === "workspace" && state.activeModule === "queue" && $("moduleBody")) {
    renderWorkspace(false);
  }
}

async function saveConsoleSettingsPage() {
  const pageSize = Math.min(Math.max(Number.parseInt(String($("settingsPersonaPageSize")?.value || ""), 10) || 20, 5), 80);
  const personaPostPageSize = Math.min(Math.max(Number.parseInt(String($("settingsPersonaPostPageSize")?.value || ""), 10) || 10, 5), 80);
  const taskPersonaPageSize = Math.min(Math.max(Number.parseInt(String($("settingsTaskQueuePersonaPageSize")?.value || ""), 10) || 12, 1), 100);
  const taskRegularPageSize = Math.min(Math.max(Number.parseInt(String($("settingsTaskQueueRegularPageSize")?.value || ""), 10) || 20, 1), 100);
  const customDurationInputs = Array.from(document.querySelectorAll("#consoleSettingsBody [data-browser-duration-field]:not(:disabled)"));
  const invalidDurationInput = customDurationInputs.find((input) => {
    const value = Number(input.value);
    return !input.value.trim() || !Number.isInteger(value) || value < Number(input.min) || value > Number(input.max);
  });
  if (invalidDurationInput) {
    invalidDurationInput.focus();
    showMsg("consoleSettingsMsg", `请输入 ${invalidDurationInput.min} 到 ${invalidDurationInput.max} 之间的整数秒数。`, false);
    return;
  }
  const browserPreferences = updateBrowserPreferencesDraft();
  state.personaListPageSize = pageSize;
  state.personaPostPageSize = personaPostPageSize;
  state.taskQueuePersonaPageSize = taskPersonaPageSize;
  state.taskQueueRegularPageSize = taskRegularPageSize;
  state.personaListPage = 1;
  state.personaPostPages = {};
  state.taskQueuePersonaPage = 1;
  state.taskQueueRegularPage = 1;
  try {
    window.localStorage.setItem(PERSONA_LIST_PAGE_SIZE_KEY, String(pageSize));
    window.localStorage.setItem(PERSONA_POST_PAGE_SIZE_KEY, String(personaPostPageSize));
    window.localStorage.setItem(TASK_QUEUE_PERSONA_PAGE_SIZE_KEY, String(taskPersonaPageSize));
    window.localStorage.setItem(TASK_QUEUE_REGULAR_PAGE_SIZE_KEY, String(taskRegularPageSize));
  } catch {}
  try {
    const result = await api("/api/persona_dashboard/automation/browser_preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(browserPreferences),
    });
    state.browserPreferences = browserPreferencesResponseValue(result);
    state.browserPreferencesDirty = false;
    state.browserDurationDrafts = {};
  } catch (error) {
    showMsg("consoleSettingsMsg", error.detail || error.message || "分页设置已保存在本机，但浏览器策略保存失败。", false);
    return;
  }
  renderConsoleSettingsPage();
  refreshConsoleSettingsDependents();
  showMsg("consoleSettingsMsg", "设置已保存。", true);
}

async function loadBrowserPolicySettings(options) {
  const recommendationOnly = Boolean(options?.recommendationOnly);
  const syncRevision = ++state.browserPolicySyncRevision;
  state.browserPolicyLoading = !recommendationOnly;
  state.browserRecommendationRefreshing = recommendationOnly;
  if (state.view === "console_settings" && $("consoleSettingsBody")) renderConsoleSettingsPage();
  try {
    if (recommendationOnly) {
      const recommendationResult = await api("/api/persona_dashboard/automation/browser_recommendation");
      if (syncRevision === state.browserPolicySyncRevision) state.browserRecommendation = browserRecommendationResponseValue(recommendationResult);
    } else {
      const [preferencesResult, recommendationResult] = await Promise.all([
        api("/api/persona_dashboard/automation/browser_preferences"),
        api("/api/persona_dashboard/automation/browser_recommendation"),
      ]);
      if (syncRevision !== state.browserPolicySyncRevision) return;
      if (!state.browserPreferencesDirty) {
        state.browserPreferences = browserPreferencesResponseValue(preferencesResult);
        state.browserDurationDrafts = {};
      }
      state.browserRecommendation = browserRecommendationResponseValue(recommendationResult);
    }
  } catch (error) {
    if (recommendationOnly) showMsg("consoleSettingsMsg", error.detail || error.message || "环境重新检测失败。", false);
  } finally {
    if (syncRevision !== state.browserPolicySyncRevision) return;
    state.browserPolicyLoaded = true;
    state.browserPolicyLoading = false;
    state.browserRecommendationRefreshing = false;
    if (state.view === "console_settings" && $("consoleSettingsBody")) renderConsoleSettingsPage();
  }
}

async function autoConfigureBrowserPreferences() {
  state.browserAutoConfiguring = true;
  renderConsoleSettingsPage();
  try {
    await api("/api/persona_dashboard/automation/browser_preferences/auto_configure", { method: "POST" });
    state.browserPreferencesDirty = false;
    state.browserDurationDrafts = {};
    state.browserPolicyLoaded = false;
    await loadBrowserPolicySettings();
    showMsg("consoleSettingsMsg", "已按当前环境完成一键配置。", true);
  } catch (error) {
    showMsg("consoleSettingsMsg", error.detail || error.message || "一键配置失败。", false);
  } finally {
    state.browserAutoConfiguring = false;
    if (state.view === "console_settings" && $("consoleSettingsBody")) renderConsoleSettingsPage();
  }
}

function syncPersonaCollectionCollapseDom(groupId, collapsed, pending = false) {
  const cleanGroupId = String(groupId || "");
  if (!cleanGroupId) return;
  document.querySelectorAll(`[data-persona-folder="${CSS.escape(cleanGroupId)}"]`).forEach((folder) => {
    const children = folder.querySelector(":scope > .persona-layer-children");
    if (children) {
      const contentHeight = Math.max(children.scrollHeight || 0, children.getBoundingClientRect().height || 0);
      if (contentHeight) children.style.setProperty("--persona-folder-content-height", `${Math.ceil(contentHeight)}px`);
    }
    folder.classList.toggle("is-collapsed", collapsed);
    folder.classList.toggle("is-pending", pending);
    folder.querySelectorAll("[data-persona-toggle-folder]").forEach((button) => {
      button.disabled = pending;
      button.setAttribute("aria-expanded", collapsed ? "false" : "true");
      button.setAttribute("aria-label", collapsed ? "展开分组" : "收起分组");
      const status = button.querySelector(".persona-folder-copy > small");
      if (status && !button.querySelector("[data-matrix-group]")) status.textContent = collapsed ? "已收起" : "已展开";
    });
  });
}

async function togglePersonaCollection(groupId) {
  const group = (state.personaCollections?.groups || []).find((item) => String(item.id) === String(groupId));
  if (!group || state.personaCollectionTogglePending.has(String(group.id))) return;
  const previousCollapsed = Boolean(group.collapsed);
  const nextCollapsed = !previousCollapsed;
  const pendingId = String(group.id);
  state.personaCollectionTogglePending.add(pendingId);
  group.collapsed = nextCollapsed;
  syncPersonaCollectionCollapseDom(group.id, nextCollapsed, true);
  try {
    const result = await api(`/api/persona_dashboard/groups/${encodeURIComponent(group.id)}/collapse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collapsed: nextCollapsed }),
    });
    if (result?.group && typeof result.group === "object") Object.assign(group, result.group);
    syncPersonaCollectionCollapseDom(group.id, Boolean(group.collapsed), false);
  } catch (error) {
    group.collapsed = previousCollapsed;
    syncPersonaCollectionCollapseDom(group.id, previousCollapsed, false);
    throw error;
  } finally {
    state.personaCollectionTogglePending.delete(pendingId);
  }
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

async function renamePersonaArchive(personaId) {
  const cleanId = String(personaId || "").trim();
  const persona = state.personas.find((item) => String(item.id || "") === cleanId);
  if (!persona) return;
  const name = await openConsoleModal({
    title: "重命名人设",
    inputLabel: "人设名称",
    inputValue: persona.name || "",
    confirmText: "保存",
  });
  if (name === null) return;
  const cleanName = String(name || "").trim();
  if (!cleanName) {
    showMsg("commandMsg", "人设名称不能为空。", false);
    return;
  }
  const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(cleanId)}/name`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: cleanName }),
  });
  const nextName = String(result?.persona?.name || cleanName).trim();
  state.personas = state.personas.map((item) => (
    String(item.id || "") === cleanId ? { ...item, name: nextName } : item
  ));
  if (state.personaProfiles[cleanId]) state.personaProfiles[cleanId] = { ...state.personaProfiles[cleanId], name: nextName };
  state.personaListEditorId = "";
  state.personaListEditorMode = "";
  removePersonaCardEditorPortal();
  renderActivePersonaListSurface();
  renderConfirmSummary();
  await refreshPersonaCollections("已重命名人设。");
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
  state.personaListEditorId = "";
  state.personaListEditorMode = "";
  removePersonaCardEditorPortal();
  await refreshPersonaCollections("已加入分组。");
}

async function removePersonaFromCollection(personaId, groupId) {
  if (!personaId || !groupId) return;
  await api(`/api/persona_dashboard/groups/${encodeURIComponent(groupId)}/personas/${encodeURIComponent(personaId)}`, { method: "DELETE" });
  state.personaListEditorId = "";
  state.personaListEditorMode = "";
  removePersonaCardEditorPortal();
  await refreshPersonaCollections("已移出分组。");
}

async function ungroupPersona(personaId) {
  const groups = personaGroupsForPersona(personaId);
  await Promise.all(groups.map((group) => api(`/api/persona_dashboard/groups/${encodeURIComponent(group.id)}/personas/${encodeURIComponent(personaId)}`, { method: "DELETE" })));
  state.personaListEditorId = "";
  state.personaListEditorMode = "";
  removePersonaCardEditorPortal();
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
  animatePersonaListRender(renderActivePersonaListSurface);
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
  renderActivePersonaListSurface();
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
  if (target.closest?.(".persona-card-edit, .persona-card-menu, .persona-card-submenu, .publish-persona-actions, input, select, textarea, a")) return null;
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
  const drag = state.personaPointerDrag || {};
  const scrollHost = drag.source?.closest?.(".persona-list-shell")?.querySelector(".persona-list-scroll")
    || $("moduleBody")?.querySelector(".persona-list-scroll")
    || $("accountGrid")?.querySelector(".persona-list-scroll");
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
    const x = drag.currentX || drag.lockX || drag.startX;
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
  drag.targetGroupId = drag.fromGroupId;
  drag.beforeId = "";
  drag.ghost = createPersonaPointerGhost(drag.source, event.clientX, event.clientY);
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
  updatePersonaPointerDropTarget(drag.currentX || drag.lockX || drag.startX, drag.currentY);
  const nextModel = movePersonaInCollectionModel(personaCollectionModel(), drag.id, drag.targetGroupId, drag.beforeId);
  const targetGroupId = drag.targetGroupId;
  cleanupPersonaPointerDrag();
  if (!nextModel) return;
  setPersonaCollectionModel(nextModel);
  renderActivePersonaListSurface();
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
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (!drag.active && Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
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
  if (!force && state.personaFetches.profiles[key]) return state.personaFetches.profiles[key];
  const persona = state.personas.find((item) => String(item.id) === key) || null;
  if (persona) state.personaProfiles[key] = fallbackPersonaProfile(persona);
  const request = (async () => {
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
    schedulePersonaDetailRender(key);
    return profile;
  })().finally(() => {
    if (state.personaFetches.profiles[key] === request) delete state.personaFetches.profiles[key];
  });
  state.personaFetches.profiles[key] = request;
  return request;
}

function automationScreenshotUrlFromPath(pathValue) {
  const value = String(pathValue || "").trim();
  if (!value) return "";
  if (value.startsWith("/api/")) return directMediaPreviewUrl(value);
  const parts = value.split(/[\\/]/).filter(Boolean);
  const filename = parts[parts.length - 1] || "";
  const screenshotUrl = filename ? `/api/persona_dashboard/automation/screenshots/${encodeURIComponent(filename)}` : "";
  return screenshotUrl ? adminWorkspaceUrl(screenshotUrl) : "";
}

function automationScreenshotThumbnailUrl(urlValue) {
  const value = String(urlValue || "").trim();
  if (!value || !value.startsWith("/api/persona_dashboard/automation/screenshots/")) return value;
  return `${value}${value.includes("?") ? "&" : "?"}thumbnail=1`;
}

function isAutomationResultScreenshotStage(stageValue) {
  return new Set([
    "publish_done", "comment_done", "reply_done", "like_done", "already_liked",
    "share_done", "threads_auto_reply_done", "threads_warmup", "browse_feed", "check_login", "login_complete",
  ]).has(String(stageValue || "").trim());
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
    if (!isAutomationResultScreenshotStage(log.stage)) continue;
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
  const presentationStatus = socialTaskPresentationStatus(task);
  const waitsForManualLogin = socialTaskWaitsForManualLogin(task);
  const screenshotUrl = latestSocialTaskScreenshot(task, logs);
  const publishedUrl = String(result.published_url || result.publishedUrl || result.url || result.post_url || "").trim();
  const recentLogs = (logs || []).slice(-4).reverse();
  const terminal = ["success", "failed", "cancelled", "need_manual"].includes(presentationStatus);
  const canCancel = activeTaskStatus(task.status);
  const screenshotReason = legacyMediaPreviewReason(screenshotUrl);
  const screenshotItem = screenshotUrl && !screenshotReason
    ? { previewUrl: screenshotUrl, originalUrl: screenshotUrl, thumbnailUrl: automationScreenshotThumbnailUrl(screenshotUrl), type: "image", label: "任务截图" }
    : null;
  const screenshotGroupId = screenshotUrl && !screenshotReason
    ? registerMediaPreviewGroup([screenshotItem])
    : "";
  return `
    <div class="persona-inline-panel persona-publish-result-card">
      <div class="flow-box">
        <span>任务状态</span>
        <strong>${esc(statusLabel(presentationStatus))}</strong>
        <span>${esc(task.id || "")}</span>
      </div>
      ${waitsForManualLogin ? `<div class="persona-warning-inline">发布任务正在等待账号人工验证，请在浏览器窗口完成验证后继续。</div>` : ""}
      ${task.error ? `<div class="persona-warning-inline">${esc(task.error)}</div>` : ""}
      ${publishedUrl || canCancel ? `<div class="row-actions">
        ${publishedUrl ? `<a href="${esc(publishedUrl)}" target="_blank" rel="noopener">查看任务结果</a>` : ""}
        ${canCancel ? `<button type="button" class="danger" data-persona-cancel-social-task="${esc(task.id)}">停止任务</button>` : ""}
      </div>` : ""}
      ${screenshotUrl
        ? (screenshotReason
          ? `<div class="publish-result-link is-unavailable"><div class="persona-media-frame persona-media-frame--empty"><strong>媒体不可预览</strong><small>${esc(screenshotReason)}</small></div></div>`
          : renderMediaPreviewButton(screenshotItem, screenshotGroupId, 0, { className: "publish-result-link", frameClass: "publish-result-image", caption: "任务截图" }))
        : `<div class="empty-state">${terminal ? "当前任务没有返回截图。" : "执行中，截图生成后会显示在这里。"}</div>`}
      ${recentLogs.length ? `<div class="compact-list">${recentLogs.map((log) => `
        <article class="compact-row compact-row-log">
          <strong>${esc(logStageLabel(log.stage, log.level))}</strong>
          <p>${esc(taskLogMessage(log))}</p>
          <span>${esc(formatTime(log.created_at || ""))}</span>
        </article>`).join("")}</div>` : ""}
    </div>`;
}

function taskLogMessage(log = {}) {
  const raw = log.message || log.detail || log.error || "";
  if (raw) return sanitizeTaskUserMessage(raw);
  const data = log.data && typeof log.data === "object" ? log.data : {};
  if (data.screenshot_url || data.screenshotUrl || data.screenshot_path || data.screenshotPath) return "已生成执行截图";
  if (data.published_url || data.publishedUrl || data.post_url) return "已返回发布结果链接";
  if (data.error) return sanitizeTaskUserMessage(data.error);
  if (data.task_type) return `执行 ${statusLabel(data.task_type)}`;
  return Object.keys(data).length ? "步骤已完成，详情见下方截图或结果信息。" : "无日志内容";
}

function taskResultUrl(task = {}) {
  const result = task.result && typeof task.result === "object"
    ? task.result
    : (task.output && typeof task.output === "object" ? task.output : {});
  return String(result.published_url || result.publishedUrl || result.url || result.post_url || result.result_url || "").trim();
}

function taskScreenshotFromValue(value) {
  const text = String(value || "").trim();
  const direct = directMediaPreviewUrl(text);
  if (direct) return direct;
  if (/social_automation[\\/]+screenshots|[\\/]screenshots[\\/]|screenshot_/i.test(text)) {
    return automationScreenshotUrlFromPath(text);
  }
  return "";
}

function collectTaskScreenshots(task = {}, logs = []) {
  const rows = [];
  const seen = new Set();
  const push = (value, label = "任务截图", time = "", meta = {}) => {
    const url = taskScreenshotFromValue(value);
    if (!url || seen.has(url)) return;
    seen.add(url);
    rows.push({ previewUrl: url, originalUrl: url, thumbnailUrl: automationScreenshotThumbnailUrl(url), url, type: "image", label, time, ...meta });
  };
  const pushMedia = (item, index = 0, labelPrefix = "任务图片") => {
    if (!item) return;
    const value = item.preview_url || item.previewUrl || item.url || item.image_url || item.imageUrl || item.path || item.file_path || item.filePath || "";
    const label = item.label || item.name || item.filename || `${labelPrefix} ${index + 1}`;
    push(value, label, item.created_at || item.time || "");
  };
  const taskMediaUrl = (index = 0) => task?.id ? `/api/tasks/${encodeURIComponent(task.id)}/media/${encodeURIComponent(index)}` : "";
  const result = task?.result && typeof task.result === "object"
    ? task.result
    : (task?.output && typeof task.output === "object" ? task.output : {});
  const taskMediaItems = Array.isArray(task.media_items) ? task.media_items : [];
  const resultMediaItems = Array.isArray(result.media_items) ? result.media_items : [];
  const hasExplicitMedia = taskMediaItems.length || resultMediaItems.length;
  taskMediaItems.forEach((item, index) => pushMedia(item, index, "任务图片"));
  resultMediaItems.forEach((item, index) => pushMedia(item, index, "输出图片"));
  if (!hasExplicitMedia) {
    (Array.isArray(result.image_urls) ? result.image_urls : []).forEach((item, index) => push(item, `输出图片 ${index + 1}`, task.finished_at || task.updated_at || ""));
    (Array.isArray(result.image_paths) ? result.image_paths : []).forEach((item, index) => push(taskMediaUrl(index) || item, `输出图片 ${index + 1}`, task.finished_at || task.updated_at || ""));
    push(result.image_url || result.imageUrl, "输出图片", task.finished_at || task.updated_at || "");
    push(result.download_path || result.downloadPath ? (taskMediaUrl(0) || result.download_path || result.downloadPath) : "", "输出文件", task.finished_at || task.updated_at || "");
  }
  push(result.screenshot_url || result.screenshotUrl, "最终截图", task.finished_at || task.updated_at || "", { source: "result" });
  push(result.screenshot_path || result.screenshotPath || result.screenshot, "最终截图", task.finished_at || task.updated_at || "", { source: "result" });
  (Array.isArray(result.checkpoints) ? result.checkpoints : []).forEach((checkpoint, index) => {
    push(
      checkpoint?.screenshot_url || checkpoint?.screenshotUrl || checkpoint?.screenshot_path || checkpoint?.screenshotPath || checkpoint?.screenshot,
      checkpoint?.label || checkpoint?.stage || `步骤截图 ${index + 1}`,
      checkpoint?.created_at || checkpoint?.time || "",
    );
  });
  (Array.isArray(logs) ? logs : []).forEach((log, index) => {
    const data = log?.data && typeof log.data === "object" ? log.data : {};
    const snapshot = data.output_snapshot && typeof data.output_snapshot === "object" ? data.output_snapshot : {};
    push(
      log?.screenshot_url || log?.screenshotUrl || log?.screenshot_path || log?.screenshotPath || data.screenshot_url || data.screenshotUrl || data.screenshot_path || data.screenshotPath || snapshot.screenshot_url || snapshot.screenshotUrl || snapshot.screenshot_path || snapshot.screenshotPath || snapshot.download_path || snapshot.downloadPath,
      logStageLabel(log?.stage, log?.level) || `日志截图 ${index + 1}`,
      log?.created_at || log?.ts || "",
      { source: "log", stage: String(log?.stage || "") },
    );
  });
  if (String(task?.task_type || "") === "publish_post" && String(task?.status || "") === "success") {
    const finalScreenshot = rows.find((item) => item.source === "result")
      || rows.slice().reverse().find((item) => item.source === "log" && item.stage === "publish_done");
    return finalScreenshot ? [finalScreenshot] : [];
  }
  return rows;
}

function renderTaskScreenshotGallery(items = [], { emptyText = "当前任务还没有截图。" } = {}) {
  const rows = (Array.isArray(items) ? items : []).filter((item) => item?.previewUrl);
  if (!rows.length) return `<div class="empty-state">${esc(emptyText)}</div>`;
  const groupId = registerMediaPreviewGroup(rows);
  return `
    <div class="task-screenshot-gallery">
      ${rows.map((item, index) => renderMediaPreviewButton(item, groupId, index, {
        className: "task-screenshot-card",
        frameClass: "task-screenshot-frame",
        caption: `${item.label || "任务截图"}${item.time ? ` · ${formatTime(item.time)}` : ""}`,
      })).join("")}
    </div>`;
}

function renderTaskDetailField(label, value, { wide = false, code = false } = {}) {
  const text = value === undefined || value === null || value === "" ? "-" : String(value);
  return `
    <div class="${wide ? "is-wide" : ""}">
      <span>${esc(label)}</span>
      ${code ? `<code>${esc(text)}</code>` : `<strong>${esc(text)}</strong>`}
    </div>`;
}

function renderTaskDetailStatusField(status, label = "") {
  return `
    <div>
      <span>状态</span>
      <strong class="task-detail-status is-${esc(statusTone(status))}">${esc(label || statusLabel(status || ""))}</strong>
    </div>`;
}

function renderTaskDetailLogs(logs = [], { limit = 30, hideScreenshots = false } = {}) {
  const rows = (Array.isArray(logs) ? logs : []).slice(-limit).reverse();
  return `
    <section class="task-detail-log-list">
      <div class="task-detail-section-head">
        <strong>执行日志</strong>
        <span>${esc(`${rows.length} 条`)}</span>
      </div>
      ${rows.length ? rows.map((log) => {
        const screenshotUrl = hideScreenshots ? "" : taskScreenshotFromValue(log.screenshot_url || log.screenshot_path || "");
        const screenshotItem = screenshotUrl ? { previewUrl: screenshotUrl, originalUrl: screenshotUrl, thumbnailUrl: automationScreenshotThumbnailUrl(screenshotUrl), url: screenshotUrl, type: "image", label: logStageLabel(log.stage, log.level) } : null;
        const screenshotGroupId = screenshotItem ? registerMediaPreviewGroup([screenshotItem]) : "";
        return `
          <article class="task-detail-log-item">
            <div>
              <strong>${esc(logStageLabel(log.stage, log.level))}</strong>
              <span>${esc(formatTime(log.created_at || log.ts || ""))}</span>
            </div>
            <p>${esc(taskLogMessage(log))}</p>
            ${screenshotItem ? renderMediaPreviewButton(screenshotItem, screenshotGroupId, 0, {
              className: "task-log-screenshot-button",
              frameClass: "task-log-screenshot-frame",
              caption: "查看截图",
            }) : ""}
          </article>`;
      }).join("") : `<div class="empty-state">暂无日志。</div>`}
    </section>`;
}

function renderTaskDetailLayout(task = {}, logs = [], {
  kind = "regular",
  title = "任务",
  downloadUrl = "",
} = {}) {
  const resultUrl = taskResultUrl(task);
  const presentationStatus = kind === "social" ? socialTaskPresentationStatus(task) : String(task.status || "");
  const screenshots = collectTaskScreenshots(task, logs);
  const previewCountLabel = kind === "regular" ? `${screenshots.length} 张图片` : `${screenshots.length} 张截图`;
  const fields = kind === "social"
    ? [
      renderTaskDetailField("任务类型", statusLabel(task.task_type || task.workflow_name || task.type || title)),
      renderTaskDetailStatusField(presentationStatus, socialTaskDisplayStatus(task)),
      renderTaskDetailField("平台", queuePlatformLabel(task.platform || "")),
      renderTaskDetailField("账号", task.account_username || task.account_id || "-"),
      task.scheduled_at ? renderTaskDetailField("计划执行", formatScheduledTime(task.scheduled_at)) : "",
      renderTaskDetailField("更新时间", formatTime(task.updated_at || task.finished_at || task.created_at || "")),
      task.error ? renderTaskDetailField("错误信息", sanitizeTaskUserMessage(task.error), { wide: true }) : "",
    ].filter(Boolean).join("")
    : [
      renderTaskDetailField("任务类型", statusLabel(task.task_type || task.workflow_name || task.type || title)),
      renderTaskDetailField("任务 ID", task.id || ""),
      renderTaskDetailStatusField(task.status || ""),
      renderTaskDetailField("创建时间", formatTime(task.created_at || "")),
      renderTaskDetailField("更新时间", formatTime(task.updated_at || task.finished_at || task.created_at || "")),
      task.error ? renderTaskDetailField("错误信息", sanitizeTaskUserMessage(task.error), { wide: true }) : "",
    ].filter(Boolean).join("");
  return `
    <div class="console-modal-detail task-detail-modal task-detail-modal--stacked">
      <section class="task-detail-summary-card">
        <span>${esc(kind === "social" ? "自动化任务" : "任务详情")}</span>
        <strong class="task-detail-status is-${esc(statusTone(presentationStatus))}">${esc((kind === "social" ? socialTaskDisplayStatus(task) : statusLabel(task.status || "")) || title)}</strong>
        <p>${esc(task.workflow_name || statusLabel(task.task_type || task.type || "") || task.id || "")}</p>
      </section>
      <section class="task-detail-field-grid">
        ${fields}
      </section>
      ${(downloadUrl || resultUrl || screenshots.length) ? `
        <section class="task-detail-result-panel">
          <div class="task-detail-section-head">
            <strong>结果预览</strong>
            <span>${esc(screenshots.length ? previewCountLabel : "链接")}</span>
          </div>
          <div class="row-actions">
            ${downloadUrl ? `<a href="${esc(adminWorkspaceUrl(downloadUrl))}">下载结果文件</a>` : ""}
            ${resultUrl ? `<a href="${esc(resultUrl)}" target="_blank" rel="noopener">查看任务结果</a>` : ""}
          </div>
          ${renderTaskScreenshotGallery(screenshots)}
        </section>` : ""}
      ${renderTaskDetailLogs(logs, {
        limit: kind === "social" ? 30 : 12,
        hideScreenshots: String(task?.task_type || "") === "publish_post" && String(task?.status || "") === "success",
      })}
    </div>`;
}

function updatePersonaPublishResultView(personaId) {
  const currentPersonaId = String(selectedPersona()?.id || "");
  if (String(personaId || "") !== currentPersonaId) return;
  const host = $("personaPublishResult");
  if (!host) return;
  host.innerHTML = state.personaPublishResults[currentPersonaId] || `<div class="empty-state">提交后，这里会显示任务状态、截图和发布结果。</div>`;
}

function refreshAutomationWorkSurface() {
  if (state.activeModule === "automation") renderSimpleFlowModule("automation");
  else if (state.view === "accounts") renderSocialAccounts();
  else if (isPersonaWorkspaceModule()) renderPersonaDetail();
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
  const activeStep = state.activeModule === "automation" ? currentBranch("automation") : "";
  if (activeStep !== step) return;
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
      syncSocialTaskToast(task, { force: true });
      if (["success", "failed", "cancelled"].includes(String(task.status || ""))) {
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
      syncSocialTaskToast(task, { force: true });
      if (["success", "failed", "cancelled"].includes(String(task.status || ""))) {
        delete state.personaPublishWatchers[key];
        await Promise.all([
          loadSocial().catch(() => {}),
          loadPersonas().catch(() => {}),
          loadPersonaDraftPosts(key, { force: true }).catch(() => []),
          loadPersonaFavoritePosts(key, { force: true }).catch(() => []),
          loadPersonaPublishHistory(key, { force: true }).catch(() => []),
        ]);
        let payload = task.payload || task.payload_json || {};
        if (typeof payload === "string") {
          try { payload = JSON.parse(payload || "{}"); } catch (_) { payload = {}; }
        }
        if (!payload || typeof payload !== "object") payload = {};
        const publishedPostId = String(payload.archive_post_id || "").trim();
        const publishedSource = String(payload.archive_post_source || "posts").trim();
        if (String(task.status || "") === "success" && publishedPostId && publishedSource !== "favorites") {
          const currentDraftRows = visiblePersonaDraftPosts(state.personaDraftPosts[key] || [])
            .filter((post) => String(post.id || "") !== publishedPostId);
          state.personaDraftPosts[key] = currentDraftRows;
          syncPersonaSelectedPostIds({ id: key }, "posts", currentDraftRows);
          if (String(state.selectedPersonaPostId || "") === publishedPostId) {
            const nextPost = personaDraftPosts({ id: key })[0] || personaFavoritePosts({ id: key })[0] || null;
            setSelectedPersonaPostId(nextPost?.id || "", { auto: true });
          }
          const selectionKey = publishSelectionKey({ id: key }, "posts");
          state.publishSelectedPostIds[selectionKey] = (state.publishSelectedPostIds[selectionKey] || []).filter((id) => String(id) !== publishedPostId);
          if (String(state.publishPreviewPostId || "") === publishedPostId) state.publishPreviewPostId = "";
        }
        schedulePersonaDetailRender(key);
        return;
      }
    }
    await sleep(2000);
  }
}

async function refreshPersonaPublishSequenceState(personaId) {
  const key = String(personaId || "").trim();
  if (!key) return;
  await Promise.all([
    loadSocial().catch(() => {}),
    loadPersonas().catch(() => {}),
    loadPersonaDraftPosts(key, { force: true }).catch(() => []),
    loadPersonaFavoritePosts(key, { force: true }).catch(() => []),
    loadPersonaPublishHistory(key, { force: true }).catch(() => []),
  ]);
}

function socialTaskScheduledAtMs(task) {
  const raw = task?.scheduled_at;
  if (raw === undefined || raw === null || raw === "") return 0;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

function personaPublishWatchDeadline(task, startedAt) {
  const baseDeadline = startedAt + 8 * 60 * 1000;
  const scheduledAt = socialTaskScheduledAtMs(task);
  return scheduledAt ? Math.max(baseDeadline, scheduledAt + 10 * 60 * 1000) : baseDeadline;
}

async function watchPersonaPublishTaskSequence(taskIds = [], personaId = "") {
  const key = String(personaId || "").trim();
  const ids = (taskIds || []).map((id) => String(id || "").trim()).filter(Boolean);
  if (!key || !ids.length) return;
  const sequenceToken = `sequence:${Date.now()}:${ids.join("|")}`;
  state.personaPublishWatchers[key] = sequenceToken;
  try {
    for (const taskId of ids) {
      if (state.personaPublishWatchers[key] !== sequenceToken) return;
      const startedAt = Date.now();
      const knownTask = (state.socialTasks || []).find((task) => String(task?.id || "") === taskId) || null;
      let deadline = personaPublishWatchDeadline(knownTask, startedAt);
      let lastStatus = "";
      let lastLogs = [];
      let completed = false;
      while (Date.now() < deadline) {
        if (state.personaPublishWatchers[key] !== sequenceToken) return;
        const taskData = await api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(taskId)}`).catch(() => null);
        const task = taskData?.task || null;
        if (!task) {
          await sleep(2000);
          continue;
        }
        deadline = Math.max(deadline, personaPublishWatchDeadline(task, startedAt));
        const status = String(task.status || "").trim().toLowerCase();
        const terminal = ["success", "failed", "cancelled"].includes(status);
        const taskPayload = task?.payload && typeof task.payload === "object" ? task.payload : {};
        const waitingForLoginDependency = status === "queued" && Boolean(taskPayload.auto_login_before_publish && taskPayload.login_task_id);
        if (status === "need_manual" || waitingForLoginDependency) {
          deadline = Math.max(deadline, Date.now() + 10 * 60 * 1000);
        }
        const statusChanged = status !== lastStatus;
        if (statusChanged || terminal) {
          const logData = await api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(taskId)}/logs`).catch(() => ({ logs: lastLogs }));
          lastLogs = Array.isArray(logData?.logs) ? logData.logs : lastLogs;
        }
        state.personaPublishResults[key] = renderPersonaPublishResult(task, lastLogs);
        updatePersonaPublishResultView(key);
        if (statusChanged) {
          syncSocialTaskToast(task, { force: true });
        }
        lastStatus = status;
        if (terminal) {
          if (status !== "success") {
            throw new Error(`连续发布任务 ${taskId.slice(0, 8)} 状态为${statusLabel(status)}，已停止跟踪后续任务。`);
          }
          completed = true;
          break;
        }
        await sleep(["queued", "pending", "scheduled"].includes(status) ? 5000 : 2000);
      }
      if (!completed) {
        const message = `连续发布任务 ${taskId.slice(0, 8)} 状态跟踪超时，已停止跟踪后续任务。`;
        state.personaPublishResults[key] = `<div class="persona-warning-inline">${esc(message)}</div>`;
        updatePersonaPublishResultView(key);
        appendEvent("warning", message, {
          key: socialTaskToastKey(taskId),
          taskId,
          taskPanel: "persona",
          personaId,
        });
        throw new Error(message);
      }
    }
    await refreshPersonaPublishSequenceState(key);
  } catch (error) {
    await refreshPersonaPublishSequenceState(key);
    throw error;
  } finally {
    if (state.personaPublishWatchers[key] === sequenceToken) delete state.personaPublishWatchers[key];
  }
}

async function loadPersonaDraftPosts(personaId, { force = false } = {}) {
  const key = String(personaId || "").trim();
  if (!key) return [];
  if (!Array.isArray(state.personaDraftPosts[key])) hydratePersonaPostRowsFromCache(key, "posts");
  if (!force && Array.isArray(state.personaDraftPosts[key])) return state.personaDraftPosts[key];
  if (!force && state.personaFetches.draftPosts[key]) return state.personaFetches.draftPosts[key];
  const request = api(`/api/persona_dashboard/personas/${encodeURIComponent(key)}/posts`)
    .catch(() => ({ posts: [] }))
    .then((data) => {
      const posts = sortPersonaDraftPosts(visiblePersonaDraftPosts(Array.isArray(data.posts) ? data.posts : []));
      state.personaDraftPosts[key] = posts;
      savePersonaPostRows(key, "posts", posts);
      syncPersonaSelectedPostIds({ id: key }, "posts", posts);
      syncPersonaHotImportPosts(key, posts);
      const currentSelected = String(state.selectedPersonaPostId || "").trim();
      if (String(state.selectedPersonaId || "") === key && !posts.some((post) => String(post.id) === currentSelected)) {
        setSelectedPersonaPostId(posts[0]?.id || "", { auto: true });
      }
      schedulePersonaDetailRender(key);
      return posts;
    })
    .finally(() => {
      if (state.personaFetches.draftPosts[key] === request) delete state.personaFetches.draftPosts[key];
    });
  state.personaFetches.draftPosts[key] = request;
  return request;
}

async function loadPersonaFavoritePosts(personaId, { force = false } = {}) {
  const key = String(personaId || "").trim();
  if (!key) return [];
  if (!Array.isArray(state.personaFavoritePosts[key])) hydratePersonaPostRowsFromCache(key, "favorites");
  if (!force && Array.isArray(state.personaFavoritePosts[key])) return state.personaFavoritePosts[key];
  if (!force && state.personaFetches.favoritePosts[key]) return state.personaFetches.favoritePosts[key];
  const request = api(`/api/persona_dashboard/personas/${encodeURIComponent(key)}/favorites`)
    .catch(() => ({ favorites: [] }))
    .then((data) => {
      const posts = sortPersonaDraftPosts(Array.isArray(data.favorites) ? data.favorites : []);
      state.personaFavoritePosts[key] = posts;
      savePersonaPostRows(key, "favorites", posts);
      syncPersonaSelectedPostIds({ id: key }, "favorites", posts);
      const currentSelected = String(state.selectedPersonaPostId || "").trim();
      if (String(state.selectedPersonaId || "") === key && personaPostSource({ id: key }) === "favorites" && !posts.some((post) => String(post.id) === currentSelected)) {
        setSelectedPersonaPostId(posts[0]?.id || "", { auto: true });
      }
      schedulePersonaDetailRender(key);
      return posts;
    })
    .finally(() => {
      if (state.personaFetches.favoritePosts[key] === request) delete state.personaFetches.favoritePosts[key];
    });
  state.personaFetches.favoritePosts[key] = request;
  return request;
}

async function loadPersonaMemories(personaId, { force = false } = {}) {
  const key = String(personaId || "").trim();
  if (!key) return [];
  if (!force && Array.isArray(state.personaMemories[key])) return state.personaMemories[key];
  if (!force && state.personaFetches.memories[key]) return state.personaFetches.memories[key];
  const request = api(`/api/persona_dashboard/personas/${encodeURIComponent(key)}/memories`)
    .catch(() => ({ memories: [] }))
    .then((data) => {
      const rows = Array.isArray(data.memories) ? data.memories : [];
      state.personaMemories[key] = rows;
      schedulePersonaDetailRender(key);
      return rows;
    })
    .finally(() => {
      if (state.personaFetches.memories[key] === request) delete state.personaFetches.memories[key];
    });
  state.personaFetches.memories[key] = request;
  return request;
}

async function deletePersonaMemoryEntry(memoryId = "") {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  const cleanMemoryId = String(memoryId || "").trim();
  const row = personaMemoryRows(persona).find((item) => String(item.id || "").trim() === cleanMemoryId);
  if (!cleanMemoryId || !row) {
    showMsg("commandMsg", "当前记忆不存在或已删除。", false);
    return;
  }
  const confirmed = await openConsoleModal({
    title: "删除记忆",
    message: `确认删除“${String(row.summary || "未命名记忆").trim() || "未命名记忆"}”吗？这条内容会从可选记忆里移除。`,
    confirmText: "删除",
    cancelText: "取消",
    danger: true,
  });
  if (!confirmed) return;
  showMsg("commandMsg", "正在删除记忆...", true);
  await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/memories/${encodeURIComponent(cleanMemoryId)}`, {
    method: "DELETE",
  });
  const generateForm = personaFormState(persona.id).generate;
  generateForm.selectedMemoryIds = (Array.isArray(generateForm.selectedMemoryIds) ? generateForm.selectedMemoryIds : [])
    .filter((item) => String(item || "").trim() !== cleanMemoryId);
  await loadPersonaMemories(persona.id, { force: true });
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", "记忆已删除。", true);
}

async function createPersonaMemoryEntry() {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  const summary = await openConsoleModal({
    title: "新建人设记忆",
    message: "填写一条可在生成推文时选用的人设记忆。",
    inputLabel: "记忆内容",
    confirmText: "保存记忆",
    cancelText: "取消",
  });
  if (summary === null) return;
  const cleanSummary = String(summary || "").trim();
  if (!cleanSummary) {
    showMsg("commandMsg", "人设记忆内容不能为空。", false);
    return;
  }
  showMsg("commandMsg", "正在保存人设记忆...", true);
  const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/memories`, {
    method: "POST",
    body: JSON.stringify({ summary: cleanSummary }),
  });
  const memoryId = String(result.memory?.id || "").trim();
  const generateForm = personaFormState(persona.id).generate;
  if (memoryId) {
    generateForm.selectedMemoryIds = Array.from(new Set([
      ...(Array.isArray(generateForm.selectedMemoryIds) ? generateForm.selectedMemoryIds : []),
      memoryId,
    ]));
  }
  await loadPersonaMemories(persona.id, { force: true });
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", "人设记忆已新建并选中。", true);
}

async function loadPersonaImageLibrary(personaId, { force = false } = {}) {
  const key = String(personaId || "").trim();
  if (!key) return null;
  if (!force && state.personaImageLibraries[key]) return state.personaImageLibraries[key];
  const data = await api(`/api/persona_dashboard/personas/${encodeURIComponent(key)}/images`).catch(() => ({ ok: true, items: [], current_reference_url: "" }));
  state.personaImageLibraries[key] = data;
  schedulePersonaDetailRender(key);
  return data;
}

async function loadPersonaPublishHistory(personaId, { force = false } = {}) {
  const key = String(personaId || "").trim();
  if (!key) return [];
  if (!force && Array.isArray(state.personaPublishHistories[key])) return state.personaPublishHistories[key];
  if (!force && state.personaFetches.publishHistories[key]) return state.personaFetches.publishHistories[key];
  const fallbackPersona = state.personas.find((item) => String(item.id) === key) || null;
  const fallbackRows = sortPersonaPublishHistory(Array.isArray(fallbackPersona?.publish_history) ? fallbackPersona.publish_history : []);
  const request = api(`/api/persona_dashboard/personas/${encodeURIComponent(key)}/publish_history`)
    .catch(() => ({ publish_history: fallbackRows }))
    .then((data) => {
      const apiRows = Array.isArray(data.publish_history) ? data.publish_history : [];
      const rows = sortPersonaPublishHistory(apiRows.length ? apiRows : fallbackRows);
      state.personaPublishHistories[key] = rows;
      schedulePersonaDetailRender(key);
      return rows;
    })
    .finally(() => {
      if (state.personaFetches.publishHistories[key] === request) delete state.personaFetches.publishHistories[key];
    });
  state.personaFetches.publishHistories[key] = request;
  return request;
}

async function loadAutomationTasksShared({ force = false } = {}) {
  if (!force && state.socialTasksFetch) return state.socialTasksFetch;
  const previousById = new Map((state.socialTasks || []).map((task) => [String(task?.id || ""), task]));
  const publishPolicyRequestSeq = beginDailyPublishPolicyRequest();
  const request = api("/api/persona_dashboard/automation/tasks?limit=80")
    .catch((error) => ({ tasks: tenantArrayFallback(error, state.socialTasks) }))
    .then(async (data) => {
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      state.socialTasks = tasks;
      if (data?.publish_policy) updateDailyPublishPolicy(data.publish_policy, { requestSeq: publishPolicyRequestSeq });
      syncSocialTaskToasts(tasks);
      await refreshPersonaAfterPublishTasks(tasks, previousById);
      return { tasks };
    })
    .finally(() => {
      if (state.socialTasksFetch === request) state.socialTasksFetch = null;
    });
  state.socialTasksFetch = request;
  return request;
}

async function activateCreatedPersona(personaId, { group = "settings", step = "profile", profileMode = "" } = {}) {
  state.selectedPersonaId = personaId || state.selectedPersonaId;
  setSelectedPersonaPostId("");
  state.personaGroup = group;
  if (group === "settings") state.personaPanels.settings = step;
  if (group === "content") state.personaPanels.content = step;
  if (group === "settings" && step === "profile") {
    state.personaProfileModes[String(state.selectedPersonaId || "")] = ["edit", "style"].includes(profileMode) ? profileMode : "overview";
  }
  state.personaCreateMode = false;
  await loadPersonas();
  await loadPersonaProfile(state.selectedPersonaId, { force: true }).catch(() => {});
  await loadPersonaDraftPosts(state.selectedPersonaId, { force: true }).catch(() => {});
  if (group === "settings" && step === "profile" && personaProfileMode(state.selectedPersonaId) === "edit") {
    await loadPersonaImageLibrary(state.selectedPersonaId, { force: true }).catch(() => {});
  }
  renderConfirmSummary();
}

function scrollToPersonaImageGeneration() {
  window.requestAnimationFrame(() => {
    const target = $("personaImageGenerationSection") || document.querySelector("[data-persona-image-generation-section]");
    if (!target) return;
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    target.querySelector("[data-persona-generate-image]")?.focus({ preventScroll: true });
  });
}

async function openPersonaImageGeneration(personaId) {
  const cleanPersonaId = String(personaId || state.selectedPersonaId || "").trim();
  if (!cleanPersonaId) {
    showMsg("commandMsg", "还没有可生成图片的人设。", false);
    return;
  }
  state.activeModule = "personas";
  await activateCreatedPersona(cleanPersonaId, { group: "settings", step: "profile", profileMode: "edit" });
  renderWorkspace();
  scrollToPersonaImageGeneration();
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
  state.personaCreateKeywordController = new AbortController();
  renderPersonaDetail();
  try {
    showMsg("commandMsg", "正在提炼人设方向关键词...", true);
    const result = await apiWithTimeout("/api/persona_dashboard/personas/ai_keywords", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, prompt }),
      signal: state.personaCreateKeywordController.signal,
    }, 90000);
    createState.aiStep = "keywords";
    createState.aiKeywords = Array.isArray(result.keywords) ? result.keywords : [];
    createState.aiSelectedKeywords = [];
    createState.aiResult = null;
    renderPersonaDetail();
    showMsg("commandMsg", "已提炼出人设方向关键词。", true);
  } catch (error) {
    if (error?.name === "AbortError" || error?.status === 499) {
      showMsg("commandMsg", "已取消关键词提炼。", true);
    } else {
      showMsg("commandMsg", error?.detail || "关键词提炼失败，请稍后重试。", false);
    }
  } finally {
    state.personaCreateBusy.keywords = false;
    state.personaCreateKeywordController = null;
    if (state.personaCreateMode) renderPersonaDetail();
  }
}

function cancelPersonaCreateKeywords() {
  const controller = state.personaCreateKeywordController;
  if (controller && !controller.signal.aborted) {
    controller.abort(new DOMException("Request cancelled", "AbortError"));
  }
  state.personaCreateBusy.keywords = false;
  state.personaCreateKeywordController = null;
  showMsg("commandMsg", "已取消关键词提炼。", true);
  if (state.personaCreateMode) renderPersonaDetail();
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
  const personaForm = personaFormState(persona.id);
  const form = personaForm.generate;
  const draft = normalizePersonaDraftForm(personaForm.draft);
  const defaults = personaGenerateDefaults();
  const count = Math.min(Math.max(Number(form.count || defaults.count), 1), 20);
  const targetWords = Math.min(Math.max(Number(form.targetWords || defaults.targetWords), 10), 2000);
  form.count = count;
  form.targetWords = targetWords;
  const payload = {
    count,
    prompt: String(form.prompt || "").trim(),
    target_words: targetWords,
    content_time_slot: String(form.contentTimeSlot || "").trim(),
    selected_memory_ids: Array.isArray(form.selectedMemoryIds) ? form.selectedMemoryIds : [],
  };
  const rewriteSourcePostId = String(draft.rewriteSourcePostId || "").trim();
  if (rewriteSourcePostId) {
    payload.rewrite_source_post_id = rewriteSourcePostId;
    payload.rewrite_source_title = String(draft.title || draft.originalTitle || "").trim();
    payload.rewrite_source_content = String(draft.content || draft.originalContent || "").trim();
  }
  return payload;
}

function personaGenerateRunState(personaId) {
  return state.personaGenerateRuns[String(personaId || "").trim()] || null;
}

function setPersonaGenerateRunState(personaId, patch = {}) {
  const key = String(personaId || "").trim();
  if (!key) return null;
  const current = personaGenerateRunState(key) || {};
  const suppressToast = Boolean(patch.suppressToast || patch.silent);
  const nextPatch = { ...patch };
  delete nextPatch.suppressToast;
  delete nextPatch.silent;
  if (
    nextPatch.status === "running"
    && !nextPatch.startedAt
    && (current.status !== "running" || String(current.kind || "") !== String(nextPatch.kind || current.kind || ""))
  ) {
    nextPatch.startedAt = new Date().toISOString();
  }
  state.personaGenerateRuns[key] = {
    ...current,
    ...nextPatch,
    updatedAt: new Date().toISOString(),
  };
  if (!suppressToast) showPersonaGenerateRunToast(key, state.personaGenerateRuns[key]);
  return state.personaGenerateRuns[key];
}

function clearPersonaGenerateRunState(personaId) {
  const key = String(personaId || "").trim();
  if (key) delete state.personaGenerateRuns[key];
}

function personaGenerateRunDisplay(persona, runState) {
  if (!persona || !runState) return null;
  const status = String(runState.status || "").trim();
  const kind = String(runState.kind || "draft").trim();
  const isRunning = status === "running";
  const isError = status === "error";
  const isSuccess = status === "success";
  const isDraft = kind === "draft";
  const rows = isSuccess && isDraft ? personaGeneratedPreviewPosts(persona, runState) : [];
  const fallbackSuccess = isDraft
    ? `图文草稿已生成 ${Number(runState.generatedCount || rows.length || 0)} 条`
    : "操作已完成";
  const label = String(runState.message || "").trim() || (isRunning
    ? (isDraft ? "图文草稿生成中" : "处理中")
    : (isError ? (isDraft ? "图文草稿生成失败" : "操作失败") : fallbackSuccess));
  const title = isRunning && isDraft
    ? `预计生成 ${Number(runState.count || 0) || personaGenerateDefaults().count} 条，目标约 ${Number(runState.targetWords || 0) || personaGenerateDefaults().targetWords} 字`
    : (isError ? String(runState.error || "请稍后重试。") : label);
  return { status, kind, isRunning, isError, isSuccess, isDraft, label, title };
}

function showPersonaGenerateRunToast(personaId, runState) {
  const persona = state.personas.find((item) => String(item?.id || "") === String(personaId || ""));
  const display = personaGenerateRunDisplay(persona, runState);
  if (!display?.label) return;
  const kind = String(runState?.kind || "").trim();
  const target = kind === "persona_image"
    ? {
      view: "workspace",
      module: "personas",
      personaId,
      action: "persona_image_generation",
    }
    : {
      view: "workspace",
      module: "tweet_generation",
      personaId,
    };
  const ok = !display.isError;
  const message = display.isError && runState?.error
    ? `${display.label}：${runState.error}`
    : display.label;
  showToast(message, ok, {
    key: `persona-generate:${personaId}:${display.kind}`,
    kind: display.isRunning ? "running" : (display.isError ? "error" : "success"),
    target,
  });
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
  const draftState = personaDraftEditState(persona.id);
  const isRewriteRun = Boolean(draftState.editing && draftState.rewritePending);
  const profile = selectedPersonaProfile();
  const preflight = personaGeneratePreflight();
  if (!preflight.ready) {
    showMsg("commandMsg", `${preflight.issues.join(" / ")}，请先补齐配置。`, false);
    return;
  }
  const payload = generatePersonaPayloadFromState(persona, profile);
  setPersonaGenerateRunState(persona.id, {
    kind: isRewriteRun ? "rewrite" : "draft",
    status: "running",
    message: isRewriteRun ? "正在 AI 重写当前推文" : "正在按当前人设生成图文草稿",
    count: payload.count,
    targetWords: payload.target_words,
    prompt: payload.prompt,
    posts: [],
    postIds: [],
    error: "",
    startedAt: new Date().toISOString(),
  });
  clearMsg("commandMsg");
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
    const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/generate_posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await loadPersonaDraftPosts(persona.id, { force: true });
    const generatedPosts = Array.isArray(result.posts) ? result.posts : [];
    const generatedIds = new Set(generatedPosts.map((post) => String(post?.id || "")).filter(Boolean));
    const latestGenerated = personaDraftPosts(persona).find((post) => generatedIds.has(String(post?.id || "")));
    setSelectedPersonaPostId(latestGenerated?.id || generatedPosts[0]?.id || "");
    personaFormState(persona.id).draft = defaultPersonaDraftForm();
    setPersonaPostSource("posts", persona);
    setPersonaGenerateRunState(persona.id, {
      kind: isRewriteRun ? "rewrite" : "draft",
      status: "success",
      message: isRewriteRun
        ? `已重写生成 ${result.generated_count || generatedPosts.length || 0} 条推文候选`
        : `已生成 ${result.generated_count || generatedPosts.length || 0} 条图文草稿`,
      generatedCount: result.generated_count || generatedPosts.length || 0,
      posts: generatedPosts,
      postIds: Array.from(generatedIds),
      error: "",
    });
    renderConfirmSummary();
  } catch (error) {
    setPersonaGenerateRunState(persona.id, {
      kind: isRewriteRun ? "rewrite" : "draft",
      status: "error",
      message: "图文草稿生成失败",
      error: error.detail || error.message || "生成失败",
    });
    throw error;
  } finally {
    setActionLocked(lockParts, false);
    if (isPersonaWorkspaceModule()) renderPersonaDetail();
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
  const editingSource = form.editingSource === "favorites" ? "favorites" : "posts";
  const queuedMediaOps = editingPostId && Array.isArray(form.mediaOps) ? [...form.mediaOps] : [];
  const pendingMediaFiles = filesFromInput("personaPostMediaUploadFiles");
  const hasExistingMedia = Boolean(editingPostId && Array.isArray(form.mediaItems) && form.mediaItems.length);
  const hasMediaContent = pendingMediaFiles.length > 0 || hasExistingMedia;
  if (!content && !hasMediaContent) {
    showMsg("commandMsg", "请填写推文正文或上传至少一个媒体文件。", false);
    return;
  }
  const initialMediaPaths = !editingPostId && pendingMediaFiles.length
    ? await uploadAutomationMedia(pendingMediaFiles, "commandMsg")
    : [];
  if (!editingPostId && pendingMediaFiles.length && !initialMediaPaths.length) {
    showMsg("commandMsg", "媒体上传失败，请重新选择文件后再保存。", false);
    return;
  }
  const preparedMediaOps = editingPostId
    ? await preparePersonaDraftMediaOps(queuedMediaOps, pendingMediaFiles)
    : [];
  showMsg("commandMsg", editingPostId ? `正在保存${editingSource === "favorites" ? "收藏" : "草稿"}修改...` : "正在保存推文草稿...", true);
  const result = await api(
    editingPostId
      ? `/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/${editingSource === "favorites" ? "favorites" : "posts"}/${encodeURIComponent(editingPostId)}`
      : `/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts`,
    {
      method: editingPostId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content, media_paths: initialMediaPaths, media_ops: preparedMediaOps }),
    },
  );
  const savedPostId = result.id || editingPostId || "";
  setSelectedPersonaPostId(savedPostId);
  setPersonaPostSource(editingPostId ? editingSource : "posts", persona);
  state.personaPanels.content = "posts";
  personaFormState(persona.id).draft = defaultPersonaDraftForm();
  if ($("personaDraftTitle")) $("personaDraftTitle").value = "";
  if ($("personaDraftContent")) $("personaDraftContent").value = "";
  await Promise.all([
    loadPersonaDraftPosts(persona.id, { force: true }),
    loadPersonaFavoritePosts(persona.id, { force: true }).catch(() => []),
  ]);
  renderPersonaDetail();
  renderConfirmSummary();
  const mediaSuffix = queuedMediaOps.length
    ? `，并更新 ${queuedMediaOps.length} 项媒体操作`
    : (pendingMediaFiles.length ? `，并追加 ${pendingMediaFiles.length} 个媒体文件` : "");
  showMsg("commandMsg", editingPostId ? `${editingSource === "favorites" ? "收藏" : "草稿"}已更新：${result.title || result.id || "-"}${mediaSuffix}` : `草稿已保存：${result.title || result.id || "-"}${mediaSuffix}`, true);
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
  const previousCandidates = personaHotCandidates(persona);
  form.hotSearchMode = normalizePersonaHotSearchMode(form.hotSearchMode);
  form.hotFreshnessDays = normalizePersonaHotFreshnessDays(form.hotFreshnessDays);
  setPersonaGenerateRunState(persona.id, {
    kind: "hot",
    status: "running",
    message: refresh ? "热点候选刷新中" : "热点候选抓取中",
    error: "",
  });
  clearMsg("commandMsg");
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
    const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/hot_candidates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refresh: Boolean(refresh),
        limit: 10,
        search_mode: form.hotSearchMode,
        freshness_days: form.hotFreshnessDays,
      }),
    });
    state.personaHotCandidateResults[String(persona.id)] = {
      candidates: Array.isArray(result.candidates) ? result.candidates : [],
      keywords: Array.isArray(result.keywords) ? result.keywords : [],
      cookie_statuses: Array.isArray(result.cookie_statuses) ? result.cookie_statuses : [],
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      search_mode: normalizePersonaHotSearchMode(result.search_mode || form.hotSearchMode),
      freshness_days: normalizePersonaHotFreshnessDays(result.freshness_days ?? form.hotFreshnessDays),
      fetched_at: new Date().toISOString(),
    };
    const nextCandidates = personaHotCandidates(persona);
    reconcilePersonaHotMediaStateAfterRefresh(persona.id, previousCandidates, nextCandidates);
    state.transientWorkspaceLeaveAcknowledgement = "";
    const candidateIds = nextCandidates.map((item) => String(item.candidate_id || "").trim()).filter(Boolean);
    const candidateIdSet = new Set(candidateIds);
    form.hotSelectedIds = (form.hotSelectedIds || []).filter((item) => candidateIds.includes(String(item || "").trim()));
    form.hotPreviewId = candidateIds.includes(String(form.hotPreviewId || "").trim()) ? String(form.hotPreviewId || "").trim() : (candidateIds[0] || "");
    if (!candidateIdSet.has(String(form.hotEditingCandidateId || "").trim())) form.hotEditingCandidateId = "";
    Object.keys(form.hotReplacementFilesByCandidate || {}).forEach((candidateId) => {
      if (!candidateIdSet.has(candidateId)) clearPersonaHotReplacementFiles(persona.id, candidateId);
    });
    Object.keys(form.hotReplacementPoolByCandidate || {}).forEach((candidateId) => {
      if (!candidateIdSet.has(candidateId)) clearPersonaHotReplacementPool(persona.id, candidateId);
    });
    ["hotDeletedMediaByCandidate", "hotEditedContentByCandidate", "hotSelectedMediaIndexByCandidate", "hotSelectedReplacementPoolIdByCandidate"].forEach((field) => {
      const current = form[field] && typeof form[field] === "object" ? form[field] : {};
      form[field] = Object.fromEntries(Object.entries(current).filter(([candidateId]) => candidateIdSet.has(candidateId)));
    });
    setPersonaGenerateRunState(persona.id, {
      kind: "hot",
      status: "success",
      message: `热点候选已获取 ${candidateIds.length} 条`,
      generatedCount: candidateIds.length,
      error: "",
    });
  } catch (error) {
    setPersonaGenerateRunState(persona.id, {
      kind: "hot",
      status: "error",
      message: "热点候选抓取失败",
      error: error.detail || error.message || "抓取失败",
    });
    throw error;
  } finally {
    setActionLocked(lockParts, false);
    if (isPersonaWorkspaceModule()) {
      renderPersonaDetail();
      renderConfirmSummary();
    }
  }
}

async function submitPersonaHotDraftImport(persona, selected, { replacementOpsByCandidate = {} } = {}) {
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
  const form = personaFormState(persona.id).generate;
  let replacementCount = 0;
  try {
    for (let index = 0; index < selected.length; index += 1) {
      const candidateId = personaHotCandidateKey(selected[index]);
      const operations = Array.isArray(replacementOpsByCandidate[candidateId])
        ? replacementOpsByCandidate[candidateId].filter((item) => item?.file && Number.isInteger(item?.replaceIndex) && item.replaceIndex >= 0)
        : [];
      const postId = createdIds[index] || "";
      if (!postId || !operations.length) continue;
      for (const operation of operations) {
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await savePersonaPostMediaFiles({
              persona,
              postId,
              source: "posts",
              files: [operation.file],
              replaceIndex: operation.replaceIndex,
            });
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < 3) await sleep(300 * (2 ** (attempt - 1)));
          }
        }
        if (lastError) throw lastError;
        replacementCount += 1;
      }
    }
  } catch (error) {
    const rollbackResults = await Promise.allSettled(createdIds.map((postId) => api(
      `/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts/by_id/${encodeURIComponent(postId)}`,
      { method: "DELETE" },
    )));
    await loadPersonaDraftPosts(persona.id, { force: true }).catch(() => []);
    const rollbackFailures = rollbackResults.filter((item) => item.status === "rejected").length;
    const wrapped = new Error(
      rollbackFailures
        ? `媒体替换失败，且有 ${rollbackFailures} 条草稿未能自动撤销，请检查草稿库后再重试。`
        : "媒体替换连续失败，已自动撤销本次草稿导入，可以直接重试。",
    );
    wrapped.detail = wrapped.message;
    wrapped.cause = error;
    throw wrapped;
  }
  const importedIds = new Set(selected.map(personaHotCandidateKey).filter(Boolean));
  form.hotSelectedIds = [];
  if (!form.hotPreviewId) form.hotPreviewId = personaHotCandidateKey(selected[0]);
  if (importedIds.has(String(form.hotEditingCandidateId || "").trim())) form.hotEditingCandidateId = "";
  importedIds.forEach((candidateId) => {
    delete form.hotDeletedMediaByCandidate?.[candidateId];
    delete form.hotEditedContentByCandidate?.[candidateId];
    delete form.hotSelectedMediaIndexByCandidate?.[candidateId];
    clearPersonaHotReplacementFiles(persona.id, candidateId);
    clearPersonaHotReplacementPool(persona.id, candidateId);
  });
  state.transientWorkspaceLeaveAcknowledgement = "";
  await loadPersonaDraftPosts(persona.id, { force: true });
  const importedCount = result.imported_count || createdIds.length || 0;
  setPersonaGenerateRunState(persona.id, {
    kind: "hot_import",
    status: "success",
    message: `热点草稿已导入 ${importedCount} 条`,
    generatedCount: importedCount,
    postIds: createdIds,
    error: "",
  });
  renderPersonaDetail();
  renderConfirmSummary();
  await openConsoleModal({
    title: "热点草稿已导入",
    message: `已将 ${importedCount} 条热点推文保存到当前人设草稿库${replacementCount ? `，并替换 ${replacementCount} 个媒体文件` : ""}。页面会保持在热点处理区，你可以继续选择、编辑或替换媒体。`,
    confirmText: "继续处理热点",
    showCancel: false,
  });
  return { ...result, createdIds, replacementCount };
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
  const applyCurrentEdits = requestedIds.length === 0;
  if (applyCurrentEdits) snapshotPersonaHotPreviewContent();
  const replacementOpsByCandidate = {};
  const prepared = selected.map((candidate) => {
    if (!applyCurrentEdits) return candidate;
    const candidateId = personaHotCandidateKey(candidate);
    const deleted = personaHotDeletedMediaSet(persona.id, candidateId);
    const originalMediaItems = personaHotCandidateMediaItems(candidate);
    const mediaItems = originalMediaItems.filter((_, index) => !deleted.has(index));
    const sourceToEffectiveIndex = new Map();
    let effectiveIndex = 0;
    originalMediaItems.forEach((_, sourceIndex) => {
      if (deleted.has(sourceIndex)) return;
      sourceToEffectiveIndex.set(sourceIndex, effectiveIndex);
      effectiveIndex += 1;
    });
    const replacementOps = personaHotReplacementEntries(persona.id, candidateId)
      .map((entry) => ({
        file: entry.file,
        replaceIndex: sourceToEffectiveIndex.get(entry.index),
      }))
      .filter((entry) => entry.file && Number.isInteger(entry.replaceIndex));
    if (replacementOps.length) replacementOpsByCandidate[candidateId] = replacementOps;
    const editedContent = personaHotEditedContent(persona.id, candidate).trim();
    return {
      ...candidate,
      content: editedContent.slice(0, 280),
      full_content: editedContent,
      media_items: mediaItems,
    };
  });
  setPersonaGenerateRunState(persona.id, {
    kind: "hot_import",
    status: "running",
    message: `热点草稿导入中 ${selected.length} 条`,
    error: "",
  });
  clearMsg("commandMsg");
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
    await submitPersonaHotDraftImport(persona, prepared, { replacementOpsByCandidate });
  } catch (error) {
    setPersonaGenerateRunState(persona.id, {
      kind: "hot_import",
      status: "error",
      message: "热点草稿导入失败",
      error: error.detail || error.message || "导入失败",
    });
    throw error;
  } finally {
    setActionLocked(lockParts, false);
    if (isPersonaWorkspaceModule()) renderPersonaDetail();
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
  setPersonaGenerateRunState(persona.id, {
    kind: "hot_import",
    status: "running",
    message: "热点草稿导入中",
    error: "",
  });
  clearMsg("commandMsg");
  setActionLocked(lockParts, true);
  renderPersonaDetail();
  try {
    const deleted = personaHotDeletedMediaSet(persona.id, cleanCandidateId);
    const originalMediaItems = personaHotCandidateMediaItems(candidate);
    const mediaItems = originalMediaItems.filter((_, index) => !deleted.has(index));
    const sourceToEffectiveIndex = new Map();
    let effectiveIndex = 0;
    originalMediaItems.forEach((_, sourceIndex) => {
      if (deleted.has(sourceIndex)) return;
      sourceToEffectiveIndex.set(sourceIndex, effectiveIndex);
      effectiveIndex += 1;
    });
    const replacementOps = personaHotReplacementEntries(persona.id, cleanCandidateId)
      .map((entry) => ({
        file: entry.file,
        replaceIndex: sourceToEffectiveIndex.get(entry.index),
      }))
      .filter((entry) => entry.file && Number.isInteger(entry.replaceIndex));
    await submitPersonaHotDraftImport(persona, [{
      ...candidate,
      content: editedContent.slice(0, 280),
      full_content: editedContent,
      media_items: mediaItems,
    }], {
      replacementOpsByCandidate: replacementOps.length ? { [cleanCandidateId]: replacementOps } : {},
    });
  } catch (error) {
    setPersonaGenerateRunState(persona.id, {
      kind: "hot_import",
      status: "error",
      message: "热点草稿导入失败",
      error: error.detail || error.message || "导入失败",
    });
    throw error;
  } finally {
    setActionLocked(lockParts, false);
    if (isPersonaWorkspaceModule()) renderPersonaDetail();
  }
}

function resetPersonaDraftEditor(personaId) {
  resetPersonaNewDraftComposer(personaId);
}

function discardPersonaDraftEdit(personaId) {
  const form = personaFormState(personaId);
  form.generate.mode = "custom";
  form.draft = defaultPersonaDraftForm();
}

function clearPersonaDraftEdit(personaId) {
  if (String(state.renderedPersonaId || "") === String(personaId || "")) {
    state.renderedPersonaId = "";
  }
  const form = personaFormState(personaId);
  form.generate.mode = "custom";
  form.draft = normalizePersonaDraftForm(form.draft);
  form.draft.title = "";
  form.draft.content = "";
  if ($("personaDraftTitle")) $("personaDraftTitle").value = "";
  if ($("personaDraftContent")) $("personaDraftContent").value = "";
  syncPersonaDraftDirty(form.draft);
  updatePersonaDraftEditVisualState();
}

async function exitPersonaDraftEdit(personaId) {
  if (String(state.renderedPersonaId || "") === String(personaId || "")) {
    snapshotPersonaCurrentForm();
  }
  const status = personaDraftEditState(personaId);
  if (status.dirty) {
    const action = await confirmSaveDraftEditBeforeLeave();
    if (action === "save") createPersonaDraftPost().catch((error) => showMsg("commandMsg", error.detail || error.message || "保存修改失败", false));
    if (action === "discard") {
      discardPersonaDraftEdit(personaId);
      state.personaPanels.content = "posts";
      return true;
    }
    return false;
  }
  discardPersonaDraftEdit(personaId);
  state.personaPanels.content = "posts";
  return true;
}

function resetPersonaNewDraftComposer(personaId) {
  const form = personaFormState(personaId);
  form.generate.mode = "ai";
  form.draft = defaultPersonaDraftForm();
}

function openPersonaDraftEditor(postId) {
  const persona = selectedPersona();
  if (!persona) return;
  const source = personaPostSource(persona);
  const post = personaSourcePosts(persona, source).find((item) => String(item.id) === String(postId || "").trim());
  if (!post) {
    showMsg("commandMsg", source === "favorites" ? "当前收藏不存在或已移出。" : "当前草稿不存在或已被删除。", false);
    return;
  }
  const form = personaFormState(persona.id);
  const originalMediaItems = personaEditablePostMediaItems(persona.id, post).map(clonePersonaDraftMediaItem);
  form.generate.mode = "custom";
  form.draft = defaultPersonaDraftForm({
    title: String(post.title || "").trim(),
    content: String(post.content || ""),
    editingPostId: String(post.id || "").trim(),
    editingSource: source,
    originalTitle: String(post.title || "").trim(),
    originalContent: String(post.content || ""),
    originalMediaSignature: personaMediaSignature(originalMediaItems),
    mediaItems: originalMediaItems,
    mediaOps: [],
    dirty: false,
  });
  setPersonaPostSource(source, persona);
  setSelectedPersonaPostId(post.id || state.selectedPersonaPostId || "");
  state.personaGroup = "content";
  state.personaPanels.content = "generate";
  renderPersonaDetail();
  renderConfirmSummary();
}

async function deletePersonaDraftPost(postId = "") {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  const source = personaFormState(persona.id).draft.editingSource === "favorites" || personaPostSource(persona) === "favorites" ? "favorites" : "posts";
  if (source === "favorites") {
    await deletePersonaFavoritePost(postId);
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
    message: `确认删除“${personaDraftDisplayTitleForPost(post, personaDraftPosts(persona))}”吗？`,
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

async function deletePersonaSelectedPosts(source = personaPostSource(), ids = []) {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  const cleanSource = source === "favorites" ? "favorites" : "posts";
  const rows = personaSourcePosts(persona, cleanSource);
  const selectedIds = Array.from(new Set((ids && ids.length ? ids : personaSelectedPostIds(persona, cleanSource))
    .map((item) => String(item || "").trim())
    .filter((id) => rows.some((post) => String(post.id || "").trim() === id))));
  if (!selectedIds.length) {
    showMsg("commandMsg", cleanSource === "favorites" ? "请先勾选要移出的收藏。" : "请先勾选要删除的草稿。", false);
    return;
  }
  const confirmed = await openConsoleModal({
    title: cleanSource === "favorites" ? "批量移出收藏" : "批量删除草稿",
    message: cleanSource === "favorites"
      ? `确认将已勾选的 ${selectedIds.length} 条收藏移出吗？原草稿不会被删除。`
      : `确认删除已勾选的 ${selectedIds.length} 条草稿吗？`,
    confirmText: cleanSource === "favorites" ? "批量移出" : "批量删除",
    cancelText: "取消",
    danger: true,
  });
  if (!confirmed) return;
  showMsg("commandMsg", cleanSource === "favorites" ? "正在批量移出收藏..." : "正在批量删除草稿...", true);
  for (const postId of selectedIds) {
    if (cleanSource === "favorites") {
      await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/favorites/${encodeURIComponent(postId)}`, {
        method: "DELETE",
      });
    } else {
      await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts/by_id/${encodeURIComponent(postId)}`, {
        method: "DELETE",
      });
      deletePersonaHotImportMeta(persona.id, postId);
    }
  }
  setPersonaSelectedPostIds(persona, cleanSource, []);
  resetPersonaDraftEditor(persona.id);
  if ($("personaDraftTitle")) $("personaDraftTitle").value = "";
  if ($("personaDraftContent")) $("personaDraftContent").value = "";
  if (cleanSource === "favorites") {
    await loadPersonaFavoritePosts(persona.id, { force: true });
    const favoriteRows = personaFavoritePosts(persona);
    setSelectedPersonaPostId(favoriteRows[0]?.id || "", { auto: true });
    setPersonaPostSource(favoriteRows.length ? "favorites" : "posts", persona);
  } else {
    await Promise.all([
      loadPersonaDraftPosts(persona.id, { force: true }),
      loadPersonaPublishHistory(persona.id, { force: true }).catch(() => []),
    ]);
    const draftRows = personaDraftPosts(persona);
    setSelectedPersonaPostId(draftRows[0]?.id || "", { auto: true });
    if (!draftRows.length && personaPostSource(persona) === "posts" && personaFavoritePosts(persona).length) {
      setPersonaPostSource("favorites", persona);
      setSelectedPersonaPostId(personaFavoritePosts(persona)[0]?.id || "", { auto: true });
    }
  }
  state.personaPanels.content = personaDraftPosts(persona).length || personaFavoritePosts(persona).length ? "posts" : "generate";
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", cleanSource === "favorites" ? "已批量移出收藏。" : "已批量删除草稿。", true);
}

async function addPersonaFavoritePost(postId = "", { preserveSource = false } = {}) {
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
  const lockParts = ["persona", persona.id, "favorite_post", cleanPostId];
  if (isActionLocked(...lockParts)) return;
  setActionLocked(lockParts, true);
  try {
    const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/favorites/${encodeURIComponent(cleanPostId)}`, {
      method: "POST",
    });
    const nextFavorites = sortPersonaDraftPosts(Array.isArray(result.favorites) ? result.favorites : []);
    state.personaFavoritePosts[String(persona.id)] = nextFavorites;
    syncPersonaSelectedPostIds(persona, "favorites", nextFavorites);
    if (!preserveSource) {
      setPersonaPostSource("favorites", persona);
      setSelectedPersonaPostId(result.post?.id || nextFavorites[0]?.id || state.selectedPersonaPostId || "");
    } else {
      setPersonaPostSource("posts", persona);
      setSelectedPersonaPostId(cleanPostId);
    }
    state.personaPanels.content = "posts";
    renderPersonaDetail();
    renderConfirmSummary();
    showMsg("commandMsg", result.exists ? "这条内容已经在收藏里。" : "已加入收藏。", true, { key: `favorite:${persona.id}:${cleanPostId}` });
  } catch (error) {
    const detail = String(error?.detail || error?.message || "").trim();
    if (error?.status === 404 || /post not found|草稿已发布|不存在/.test(detail)) {
      await loadPersonaDraftPosts(persona.id, { force: true }).catch(() => []);
      const rows = personaDraftPosts(persona);
      if (!rows.some((item) => String(item.id) === cleanPostId)) {
        setSelectedPersonaPostId(rows[0]?.id || "", { auto: true });
      }
      state.personaPanels.content = rows.length || personaFavoritePosts(persona).length ? "posts" : "generate";
      renderPersonaDetail();
      renderConfirmSummary();
      showMsg("commandMsg", "草稿已发布或已不存在，已刷新草稿库。", false, { key: `favorite-missing:${persona.id}:${cleanPostId}` });
      return;
    }
    throw error;
  } finally {
    setActionLocked(lockParts, false);
  }
}

async function deletePersonaFavoritePost(postId = "", { preserveSource = false } = {}) {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  const cleanPostId = String(postId || state.selectedPersonaPostId || "").trim();
  const post = personaFavoritePosts(persona).find((item) => String(item.id) === cleanPostId);
  if (!post) {
    showMsg("commandMsg", "当前收藏不存在或已移出。", false);
    return;
  }
  const lockParts = ["persona", persona.id, "delete_favorite", cleanPostId];
  if (isActionLocked(...lockParts)) return;
  setActionLocked(lockParts, true);
  try {
    const confirmed = await openConsoleModal({
      title: "移出收藏",
      message: `确认将“${personaDraftDisplayTitleForPost(post, personaFavoritePosts(persona))}”移出收藏吗？原草稿不会被删除。`,
      confirmText: "移出",
      cancelText: "取消",
      danger: true,
    });
    if (!confirmed) return;
    const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/favorites/${encodeURIComponent(cleanPostId)}`, {
      method: "DELETE",
    });
    resetPersonaDraftEditor(persona.id);
    const nextFavorites = sortPersonaDraftPosts(Array.isArray(result.favorites) ? result.favorites : []);
    state.personaFavoritePosts[String(persona.id)] = nextFavorites;
    syncPersonaSelectedPostIds(persona, "favorites", nextFavorites);
    if (!preserveSource) {
      setSelectedPersonaPostId(nextFavorites[0]?.id || "", { auto: true });
      setPersonaPostSource(nextFavorites.length ? "favorites" : "posts", persona);
    } else {
      setPersonaPostSource("posts", persona);
    }
    state.personaPanels.content = "posts";
    renderPersonaDetail();
    renderConfirmSummary();
    showMsg("commandMsg", "已移出收藏。", true, { key: `favorite:${persona.id}:${cleanPostId}` });
  } finally {
    setActionLocked(lockParts, false);
  }
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
  setActionLocked(lockParts, true);
  setPersonaGenerateRunState(persona.id, {
    kind: "persona_image",
    status: "running",
    message: "人设图生成中",
    error: "",
  });
  clearMsg("commandMsg");
  renderPersonaDetail();
  try {
    const body = new FormData();
    body.append("task_type", "persona_image");
    body.append("params_json", JSON.stringify({
      related_persona_id: persona.id,
      aspect_ratio: "1:1",
      mode: "person",
    }));
    const result = await api("/api/tasks/submit", {
      method: "POST",
      body,
    });
    const taskId = String(result.id || "").trim();
    if (!taskId) throw new Error("人设图生成任务没有返回任务 ID。");
    appendEvent("queued", `人设图生成任务已创建：${taskId}`, {
      key: `task:${taskId}`,
      taskId,
      taskPanel: "regular",
      personaId: persona.id,
      openDetail: true,
    });
    setPersonaGenerateRunState(persona.id, {
      kind: "persona_image",
      status: "running",
      message: "人设图生成任务已提交",
      taskId,
      error: "",
    });
    watchTask(taskId, {
      suppressDisconnectWarning: true,
      taskPanel: "regular",
      onDone: async (payload) => {
        const doneKind = String(payload?.status || payload?.data?.status || payload?.kind || "").trim();
        const ok = doneKind === "success";
        await Promise.all([
          loadPersonaImageLibrary(persona.id, { force: true }).catch(() => {}),
          loadPersonas().catch(() => {}),
          loadPersonaProfile(persona.id, { force: true }).catch(() => {}),
        ]);
        setPersonaGenerateRunState(persona.id, {
          kind: "persona_image",
          status: ok ? "success" : "error",
          message: ok ? "人设图已生成" : "人设图生成失败",
          taskId,
          error: ok ? "" : (payload?.data?.error || payload?.error || payload?.message || payload?.detail || "生成失败"),
        });
        setActionLocked(lockParts, false);
        if (isPersonaWorkspaceModule()) renderPersonaDetail();
      },
      onError: () => {
        setActionLocked(lockParts, false);
        setPersonaGenerateRunState(persona.id, {
          kind: "persona_image",
          status: "error",
          message: "人设图任务监听已断开",
          taskId,
          error: "可在通用队列继续查看任务状态。",
        });
        if (isPersonaWorkspaceModule()) renderPersonaDetail();
      },
    });
    await loadTasks().catch(() => {});
    renderPersonaDetail();
  } catch (error) {
    setActionLocked(lockParts, false);
    setPersonaGenerateRunState(persona.id, {
      kind: "persona_image",
      status: "error",
      message: "人设图生成失败",
      error: error.detail || error.message || "生成失败",
    });
    throw error;
  } finally {
    if (isPersonaWorkspaceModule()) renderPersonaDetail();
  }
}

async function applyPersonaReferenceImage(imageId) {
  const persona = selectedPersona();
  const cleanImageId = String(imageId || "").trim();
  if (!persona || !cleanImageId) return;
  const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/images/${encodeURIComponent(cleanImageId)}/apply`, {
    method: "POST",
  });
  state.personaImageLibraries[String(persona.id)] = result;
  await Promise.all([
    loadPersonas(),
    loadPersonaProfile(persona.id, { force: true }).catch(() => {}),
  ]);
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", "当前人设图已切换。", true);
}

async function replacePersonaLibraryImage(imageId, file) {
  const persona = selectedPersona();
  const cleanImageId = String(imageId || "").trim();
  if (!persona || !cleanImageId || !file) return;
  const form = new FormData();
  form.append("image", file, file.name || "persona-image");
  showMsg("commandMsg", "正在上传并替换人设图...", true);
  const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/images/${encodeURIComponent(cleanImageId)}/replace`, {
    method: "POST",
    body: form,
  });
  state.personaImageLibraries[String(persona.id)] = result;
  await Promise.all([
    loadPersonas(),
    loadPersonaProfile(persona.id, { force: true }).catch(() => {}),
  ]);
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", "自定义人设图已替换。", true);
}

function isPersonaImageFile(file) {
  return /\.(png|jpe?g|webp|bmp|gif|tiff?|heic)$/i.test(String(file?.name || ""));
}

async function uploadPersonaReferenceImage(file) {
  const persona = selectedPersona();
  if (!persona || !file) return;
  if (!isPersonaImageFile(file)) {
    throw new Error("请上传图片文件。");
  }
  const form = new FormData();
  form.append("image", file, file.name || "persona-image");
  showMsg("commandMsg", "正在上传自定义人设图...", true);
  const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/images/upload`, {
    method: "POST",
    body: form,
  });
  state.personaImageLibraries[String(persona.id)] = result;
  await Promise.all([
    loadPersonas(),
    loadPersonaProfile(persona.id, { force: true }).catch(() => {}),
  ]);
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", "自定义人设图已上传并设为当前参考图。", true);
}

async function deletePersonaLibraryImage(imageId) {
  const persona = selectedPersona();
  const cleanImageId = String(imageId || "").trim();
  if (!persona || !cleanImageId) return;
  const result = await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/images/${encodeURIComponent(cleanImageId)}`, {
    method: "DELETE",
  });
  state.personaImageLibraries[String(persona.id)] = result;
  await Promise.all([
    loadPersonas(),
    loadPersonaProfile(persona.id, { force: true }).catch(() => {}),
  ]);
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", "人设图已删除。", true);
}

async function refreshPersonaMediaTask(personaId, postId, taskId) {
  const detail = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
  const key = personaMediaTaskKey(personaId, postId);
  const status = String(detail.status || "").trim();
  const errorText = String(detail.error || "").trim();
  const previousStatus = String(state.personaMediaTasks[key]?.status || "").trim();
  const terminalStatuses = ["success", "failed", "cancelled"];
  const becameTerminal = terminalStatuses.includes(status) && !terminalStatuses.includes(previousStatus);
  const taskTitle = taskMeta[String(detail.type || state.personaMediaTasks[key]?.taskType || "persona_post_image")]?.title || statusLabel(detail.type || "") || "生成任务";
  state.personaMediaTasks[key] = {
    taskId,
    taskType: String(detail.type || "").trim(),
    status,
    detail,
  };
  if (becameTerminal) {
    const ok = status === "success";
    appendEvent(ok ? "success" : (status === "failed" ? "failed" : "cancelled"), `${taskTitle}：${statusLabel(status)}`, {
      key: `task:${taskId}`,
      taskId,
      taskPanel: "regular",
      personaId,
    });
    setPersonaGenerateRunState(personaId, {
      kind: "media",
      status: ok ? "success" : "error",
      message: ok ? `${taskTitle}已完成` : `${taskTitle}${statusLabel(status)}`,
      taskId,
      error: ok ? "" : (errorText || statusLabel(status)),
      suppressToast: true,
    });
    dismissToastByKey(`persona-generate:${personaId}:media`);
  }
  if (errorText && ["failed", "cancelled"].includes(status)) {
    showToast(errorText, false, {
      key: `persona-media-task:${taskId}:${status}:${errorText}`,
    });
  }
  if (
    String(selectedPersona()?.id || "") === String(personaId || "")
    && String(selectedPersonaPost()?.id || "") === String(postId || "")
    && isPersonaWorkspaceModule()
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
      if (String(selectedPersona()?.id || "") === String(personaId || "") && isPersonaWorkspaceModule()) {
        renderPersonaDetail();
        renderConfirmSummary();
      }
      return;
    }
    await sleep(2000);
  }
}

async function submitPersonaMediaTask() {
  const persona = selectedPersona();
  const profile = selectedPersonaProfile();
  const { post } = personaMediaTargetPost(persona);
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
  const draftSourceText = String(post.content || "").trim();
  const contentMode = String(form.contentMode || "draft") === "manual" ? "manual" : "draft";
  const manualContent = String(form.manualContent || "").trim();
  const generationContent = contentMode === "manual" ? manualContent : draftSourceText;
  const prompt = contentMode === "manual" ? "" : String(form.prompt || "").trim();
  const desiredImageCount = Math.min(Math.max(Number(form.imageCount || state.personaMediaImageCountDefault || storedPersonaMediaImageCount() || 1), 1), 8);
  form.imageCount = desiredImageCount;
  if (taskType === "persona_post_image" && contentMode === "manual" && !generationContent) {
    showMsg("commandMsg", "请先输入自定义生成内容。", false);
    return;
  }
  if (taskType === "persona_post_image" && contentMode !== "manual" && !generationContent && !prompt) {
    showMsg("commandMsg", "当前草稿没有正文，请补充提示词后再生成。", false);
    return;
  }
  const params = compactPayload({
    prompt,
    prompt_text: prompt,
    message: prompt,
    custom_prompt: prompt,
    generation_content: generationContent,
    content_source_mode: contentMode,
    manual_content: contentMode === "manual" ? manualContent : "",
    image_count: desiredImageCount,
    persona_enabled: true,
    persona_label: String(persona.name || profile.name || "").trim(),
    tg_generation_context: String(profile.content || persona.content || "").trim(),
    tg_use_llm_prompt: true,
    related_persona_id: String(persona.id || "").trim(),
    related_post_id: String(post.id || "").trim(),
    draft_source_text: draftSourceText,
    aspect_ratio: taskType === "persona_post_image" ? String(form.aspectRatio || "1:1") : undefined,
  });
  const body = new FormData();
  body.append("task_type", taskType);
  body.append("params_json", JSON.stringify(params));
  files.forEach((file) => body.append("files", file, file.name));
  setActionLocked(lockParts, true);
  setPersonaGenerateRunState(persona.id, {
    kind: "media",
    status: "running",
    message: "推文配图任务提交中",
    error: "",
  });
  clearMsg("commandMsg");
  renderPersonaDetail();
  try {
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
    appendEvent("queued", `推文配图任务已创建：${result.id}`, {
      key: `task:${result.id}`,
      taskId: result.id,
      taskPanel: "regular",
    });
    watchTask(result.id, {
      suppressDisconnectWarning: true,
      taskPanel: "regular",
      onDone: () => refreshPersonaMediaTask(persona.id, post.id, result.id).catch(() => {}),
    });
    refreshPersonaMediaTask(persona.id, post.id, result.id).catch(() => {});
    watchPersonaMediaTask(persona.id, post.id, result.id).catch(() => {});
    await loadTasks().catch(() => {});
    setPersonaGenerateRunState(persona.id, {
      kind: "media",
      status: "running",
      message: "推文配图任务已提交，等待生成完成",
      taskId: String(result.id || "").trim(),
      error: "",
    });
  } catch (error) {
    setPersonaGenerateRunState(persona.id, {
      kind: "media",
      status: "error",
      message: "推文配图任务提交失败",
      error: error.detail || error.message || "提交失败",
    });
    throw error;
  } finally {
    setActionLocked(lockParts, false);
    if (isPersonaWorkspaceModule()) renderPersonaDetail();
  }
}

async function attachPersonaTaskMediaToPost(replaceExisting = false) {
  const persona = selectedPersona();
  const { post } = personaMediaTargetPost(persona);
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
  delete state.personaMediaTasks[personaMediaTaskKey(persona.id, post.id)];
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", replaceExisting ? "任务结果已替换当前草稿媒体。" : "任务结果已追加到当前草稿。", true);
}

async function savePersonaPostMediaFiles({
  persona,
  postId,
  source = "posts",
  files = [],
  replaceExisting = false,
  replaceIndex = null,
} = {}) {
  const cleanPostId = String(postId || "").trim();
  const mediaFiles = Array.from(files || []).filter(Boolean);
  if (!persona || !cleanPostId || !mediaFiles.length) return null;
  const body = new FormData();
  body.append("replace_existing", replaceExisting ? "1" : "0");
  if (replaceIndex !== null && replaceIndex !== undefined && replaceIndex !== "") {
    body.append("replace_index", String(replaceIndex));
  }
  mediaFiles.forEach((file) => body.append("files", file, file.name));
  return api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/${source === "favorites" ? "favorites" : "posts"}/${encodeURIComponent(cleanPostId)}/media/upload`, {
    method: "POST",
    body,
  });
}

function queuePersonaDraftMediaChange(action, { index = -1, files = [] } = {}) {
  const persona = selectedPersona();
  const { source, post } = personaMediaTargetPost(persona);
  if (!persona || !post) {
    showMsg("commandMsg", source === "favorites" ? "请先选中一条收藏。" : "请先选中一条草稿。", false);
    return false;
  }
  const draft = personaFormState(persona.id).draft;
  const isEditingTarget = String(draft.editingPostId || "").trim() === String(post.id || "").trim()
    && (draft.editingSource === "favorites" ? "favorites" : "posts") === (source === "favorites" ? "favorites" : "posts");
  if (!isEditingTarget) return false;
  if (!Array.isArray(draft.mediaItems)) {
    draft.mediaItems = personaEditablePostMediaItems(persona.id, post).map(clonePersonaDraftMediaItem);
  }
  if (!Array.isArray(draft.mediaOps)) draft.mediaOps = [];
  const mediaFiles = Array.from(files || []).filter(Boolean);
  const current = draft.mediaItems;
  if (action === "append") {
    if (!mediaFiles.length) {
      showMsg("commandMsg", "请先选择要追加的媒体文件。", false);
      return true;
    }
    current.push(...mediaFiles.map(filePersonaDraftMediaItem));
    draft.mediaOps.push({ type: "append", files: mediaFiles });
    showMsg("commandMsg", `已临时追加 ${mediaFiles.length} 个媒体，保存修改后生效。`, true);
  } else if (action === "replace") {
    if (!mediaFiles.length) {
      showMsg("commandMsg", "请先选择要替换的媒体文件。", false);
      return true;
    }
    const requestedIndex = Number.parseInt(String(index ?? ""), 10);
    const safeIndex = Number.isFinite(requestedIndex)
      ? Math.min(Math.max(requestedIndex, 0), current.length - 1)
      : selectedPersonaMediaIndex(persona.id, source, post.id, current.length);
    if (safeIndex < 0) {
      showMsg("commandMsg", "当前没有可替换的媒体。", false);
      return true;
    }
    current.splice(safeIndex, 1, ...mediaFiles.map(filePersonaDraftMediaItem));
    draft.mediaOps.push({ type: "replace", index: safeIndex, files: mediaFiles });
    setSelectedPersonaMediaIndex(persona.id, source, post.id, safeIndex);
    showMsg("commandMsg", `已临时替换第 ${safeIndex + 1} 个媒体，保存修改后生效。`, true);
  } else if (action === "delete") {
    const requestedIndex = Number.parseInt(String(index ?? ""), 10);
    const safeIndex = Number.isFinite(requestedIndex)
      ? Math.min(Math.max(requestedIndex, 0), current.length - 1)
      : selectedPersonaMediaIndex(persona.id, source, post.id, current.length);
    if (safeIndex < 0) {
      showMsg("commandMsg", "当前没有可删除的媒体。", false);
      return true;
    }
    current.splice(safeIndex, 1);
    draft.mediaOps.push({ type: "delete", index: safeIndex });
    setSelectedPersonaMediaIndex(persona.id, source, post.id, Math.max(0, Math.min(safeIndex, current.length - 1)));
    showMsg("commandMsg", `已临时删除第 ${safeIndex + 1} 个媒体，保存修改后生效。`, true);
  }
  syncPersonaDraftDirty(draft);
  if ($("personaPostMediaUploadFiles")) {
    $("personaPostMediaUploadFiles").value = "";
    syncUploadDropzone($("personaPostMediaUploadFiles"));
  }
  renderPersonaDetail();
  renderConfirmSummary();
  return true;
}

async function preparePersonaDraftMediaOps(ops = [], pendingFiles = []) {
  const prepared = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    const type = ["append", "replace", "delete"].includes(String(op?.type || "")) ? String(op.type) : "";
    if (!type) continue;
    const files = Array.from(op?.files || []).filter(Boolean);
    const mediaPaths = files.length ? await uploadAutomationMedia(files, "commandMsg") : [];
    if (files.length && mediaPaths.length !== files.length) throw new Error("部分媒体上传失败，请重新选择后保存。");
    prepared.push({ type, index: Number(op?.index ?? -1), media_paths: mediaPaths });
  }
  const trailingFiles = Array.from(pendingFiles || []).filter(Boolean);
  if (trailingFiles.length) {
    const mediaPaths = await uploadAutomationMedia(trailingFiles, "commandMsg");
    if (mediaPaths.length !== trailingFiles.length) throw new Error("部分媒体上传失败，请重新选择后保存。");
    prepared.push({ type: "append", index: -1, media_paths: mediaPaths });
  }
  return prepared;
}

async function uploadPersonaPostMedia(replaceExisting = false, replaceIndex = null) {
  const persona = selectedPersona();
  const { source, post } = personaMediaTargetPost(persona);
  if (!persona || !post) {
    showMsg("commandMsg", source === "favorites" ? "请先选中一条收藏。" : "请先选中一条草稿。", false);
    return;
  }
  const files = filesFromInput("personaPostMediaUploadFiles");
  if (!files.length) {
    showMsg("commandMsg", "请先选择要上传的媒体文件。", false);
    return;
  }
  if (queuePersonaDraftMediaChange(replaceIndex !== null && replaceIndex !== undefined && replaceIndex !== "" ? "replace" : "append", { index: replaceIndex, files })) return;
  const sourceLabel = source === "favorites" ? "收藏" : "草稿";
  const replacingSingle = replaceIndex !== null && replaceIndex !== undefined && replaceIndex !== "";
  showMsg("commandMsg", replacingSingle ? `正在替换第 ${Number(replaceIndex) + 1} 个${sourceLabel}媒体...` : (replaceExisting ? `正在替换${sourceLabel}媒体...` : `正在追加${sourceLabel}媒体...`), true);
  await savePersonaPostMediaFiles({ persona, postId: post.id, source, files, replaceExisting, replaceIndex });
  if ($("personaPostMediaUploadFiles")) {
    $("personaPostMediaUploadFiles").value = "";
    syncUploadDropzone($("personaPostMediaUploadFiles"));
  }
  if (source === "favorites") await loadPersonaFavoritePosts(persona.id, { force: true });
  else await loadPersonaDraftPosts(persona.id, { force: true });
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", replacingSingle ? `第 ${Number(replaceIndex) + 1} 个${sourceLabel}媒体已替换。` : (replaceExisting ? `${sourceLabel}媒体已替换。` : `${sourceLabel}媒体已追加。`), true);
}

async function deletePersonaPostMedia(index) {
  const persona = selectedPersona();
  const { source, post } = personaMediaTargetPost(persona);
  if (!persona || !post) {
    showMsg("commandMsg", source === "favorites" ? "请先选中一条收藏。" : "请先选中一条草稿。", false);
    return;
  }
  if (queuePersonaDraftMediaChange("delete", { index })) return;
  const sourceLabel = source === "favorites" ? "收藏" : "草稿";
  showMsg("commandMsg", `正在删除${sourceLabel}媒体...`, true);
  await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/${source === "favorites" ? "favorites" : "posts"}/${encodeURIComponent(post.id)}/media/${encodeURIComponent(index)}`, {
    method: "DELETE",
  });
  if (source === "favorites") await loadPersonaFavoritePosts(persona.id, { force: true });
  else await loadPersonaDraftPosts(persona.id, { force: true });
  renderPersonaDetail();
  renderConfirmSummary();
  showMsg("commandMsg", `${sourceLabel}媒体已删除。`, true);
}

function personaIsWorkflow(persona, profile = null) {
  void persona;
  void profile;
  return false;
}

function personaKindLabel(persona, profile = null) {
  void persona;
  void profile;
  return "";
}

function renderPersonaSelectOptions(personas) {
  return (personas || []).map((persona) => {
    const segments = [persona.name || persona.id, personaKindLabel(persona), personaBindingLabel(persona)].filter((item) => String(item || "").trim());
    return `<option value="${esc(persona.id)}" ${String(persona.id) === String(state.selectedPersonaId) ? "selected" : ""}>${esc(segments.join(" · "))}</option>`;
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
  return "";
}

function personaCardEditorMode(personaId) {
  const editorId = String(state.personaListEditorId || "");
  if (editorId !== String(personaId || "")) return "";
  return String(state.personaListEditorMode || "");
}

function renderPersonaCardEditorMenu(persona, currentGroups, availableGroups) {
  const personaId = String(persona.id || "");
  const mode = personaCardEditorMode(personaId);
  const submenu = mode === "add" && availableGroups.length ? `
    <div class="persona-card-submenu" data-persona-editor-submenu="${esc(personaId)}">
      <div class="persona-menu-tabs" aria-label="选择加入分组">
        ${availableGroups.map((group) => `
          <button type="button" class="persona-menu-tab persona-menu-tab--action" data-persona-add-to-group="${esc(personaId)}" data-group-id="${esc(group.id)}">
            <span>${esc(group.name)}</span>
          </button>
        `).join("")}
      </div>
    </div>` : "";
  const currentGroup = currentGroups[0] || null;
  const actionButtons = [
    availableGroups.length ? `
        <button type="button" class="persona-menu-tab persona-menu-tab--submenu ${mode === "add" ? "is-active" : ""}" data-persona-editor-mode="${esc(personaId)}:add">
          <span>加入分组</span>
        </button>` : "",
    currentGroup ? `
        <button type="button" class="persona-menu-tab persona-menu-tab--action" data-persona-remove-from-group="${esc(personaId)}" data-group-id="${esc(currentGroup.id)}">
          <span>移出分组</span>
        </button>` : "",
    `
        <button type="button" class="persona-menu-tab persona-menu-tab--action" data-persona-rename="${esc(personaId)}">
          <span>重命名人设</span>
        </button>`,
    `
        <button type="button" class="persona-menu-tab persona-menu-tab--action" data-persona-duplicate="${esc(personaId)}">
          <span>复制人设</span>
        </button>`,
    `
        <button type="button" class="persona-menu-tab persona-menu-tab--action persona-menu-tab--danger" data-persona-delete data-persona-delete-id="${esc(personaId)}">
          <span>删除人设</span>
        </button>`,
  ].join("");
  return `
    <div class="persona-card-menu" data-persona-editor-menu="${esc(personaId)}">
      <div class="persona-menu-tabs" aria-label="人设操作">
${actionButtons}
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
  const submenuWidth = Math.min(190, Math.max(156, window.innerWidth - margin * 2));
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
  submenu.classList.add("is-positioned");
}

function renderActivePersonaListSurface() {
  return withConsoleScrollPreserved(() => {
    if (state.view === "accounts") {
      renderSocialAccounts();
      return;
    }
    if (state.activeModule === "publishing" || state.activeModule === "automation") {
      renderSimpleFlowModule(state.activeModule);
      return;
    }
    renderPersonaModule();
  });
}

function schedulePersonaCardEditorMenuPosition() {
  if (!isPersonaWorkspaceModule()) return;
  positionPersonaCardEditorMenu();
  requestAnimationFrame(positionPersonaCardEditorMenu);
}

function handlePersonaCardEditorPortalClick(event) {
  if (event.currentTarget?.id !== "personaCardEditorPortal") return;
  const personaEditorBack = event.target.closest("[data-persona-editor-back]");
  if (personaEditorBack) {
    const personaId = personaEditorBack.dataset.personaEditorBack || "";
    if (state.personaListEditorId === personaId) {
      state.personaListEditorMode = "";
      renderActivePersonaListSurface();
    }
    return;
  }
  const personaEditorMode = event.target.closest("[data-persona-editor-mode]");
  if (personaEditorMode) {
    if (personaEditorMode.disabled) return;
    const [personaId, mode] = String(personaEditorMode.dataset.personaEditorMode || "").split(":");
    if (personaId) {
      state.personaListEditorId = personaId;
      state.personaListEditorMode = mode || "";
      renderActivePersonaListSurface();
    }
    return;
  }
  const addToGroup = event.target.closest("[data-persona-add-to-group]");
  if (addToGroup) {
    addPersonaToCollection(addToGroup.dataset.personaAddToGroup || "", addToGroup.dataset.groupId || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "加入分组失败", false));
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
    return;
  }
  const renamePersonaButton = event.target.closest("[data-persona-rename]");
  if (renamePersonaButton) {
    renamePersonaArchive(renamePersonaButton.dataset.personaRename || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "重命名人设失败", false));
    return;
  }
  const duplicatePersonaButton = event.target.closest("[data-persona-duplicate]");
  if (duplicatePersonaButton) {
    duplicatePersonaArchive(duplicatePersonaButton.dataset.personaDuplicate || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "复制人设失败", false));
    return;
  }
  const deletePersonaButton = event.target.closest("[data-persona-delete]");
  if (deletePersonaButton) {
    deleteSelectedPersona(deletePersonaButton.dataset.personaDeleteId || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "删除人设失败", false));
    return;
  }
}

function removePersonaCardEditorPortal() {
  document.getElementById("personaCardEditorPortal")?.remove();
}

function renderPersonaCardEditorPortal() {
  removePersonaCardEditorPortal();
  const personaId = String(state.personaListEditorId || "");
  if (!personaId || personaId.startsWith("group:") || !isPersonaWorkspaceModule()) return;
  const persona = state.personas.find((item) => String(item.id || "") === personaId);
  if (!persona) return;
  const currentGroups = personaGroupsForPersona(persona.id);
  const availableGroups = personaCollectionGroups().filter((group) => !currentGroups.some((item) => item.id === group.id));
  const portal = document.createElement("div");
  portal.id = "personaCardEditorPortal";
  portal.className = "persona-editor-portal";
  portal.innerHTML = renderPersonaCardEditorMenu(persona, currentGroups, availableGroups);
  portal.addEventListener("click", handlePersonaCardEditorPortalClick);
  document.body.appendChild(portal);
  schedulePersonaCardEditorMenuPosition();
}

function renderPersonaCard(persona, groupId = "", options = {}) {
  const publishMode = normalizedPublishMode(options.publishMode || "");
  const isPublishContext = options.context === "publishing";
  const isAutomationContext = options.context === "automation";
  const isAccountPoolContext = options.context === "account_pool";
  const isSideListContext = isPublishContext || isAutomationContext || isAccountPoolContext;
  const batchMode = options.batchMode === true && !isSideListContext;
  const bulkDisabled = batchMode && options.bulkDisabled === true;
  const allowEdit = options.allowEdit !== false && !isSideListContext && !batchMode;
  const allowReorder = options.allowReorder !== false && !batchMode;
  const isMatrix = isPublishContext && publishMode === "matrix_start";
  const selectedIds = Array.isArray(options.selectedIds) ? options.selectedIds.map((id) => String(id || "")) : [];
  const selected = batchMode
    ? selectedIds.includes(String(persona.id || ""))
    : String(persona.id || "") === String(state.selectedPersonaId || "");
  const publishSelected = isMatrix || isAccountPoolContext ? selectedIds.includes(String(persona.id || "")) : selected;
  const editing = allowEdit && String(state.personaListEditorId || "") === String(persona.id || "");
  const dragging = allowReorder && String(state.personaDrag?.id || "") === String(persona.id || "") && state.personaDrag?.type === "persona";
  const currentGroups = personaGroupsForPersona(persona.id);
  const ungrouped = !currentGroups.length;
  const account = isPublishContext ? publishAccountForPersona(persona) : (publishAccountsForPersona(persona)[0] || null);
  const publishAccountLabel = account
    ? `${accountDisplayName(account)}${isReadyPublishAccount(account) ? "" : ` · ${statusLabel(account.status || "unknown")}`}`
    : "没有可用发布账号";
  const personaId = String(persona.id || "");
  const draftCacheLoaded = Array.isArray(state.personaDraftPosts[personaId]);
  const favoriteCacheLoaded = Array.isArray(state.personaFavoritePosts[personaId]);
  const drafts = personaDraftPosts(persona);
  const favorites = personaFavoritePosts(persona);
  const draftCount = draftCacheLoaded ? drafts.length : personaOverviewDraftCount(persona);
  const favoriteCount = favoriteCacheLoaded ? favorites.length : personaOverviewFavoriteCount(persona);
  const availableDraftCount = draftCacheLoaded
    ? drafts.filter((post) => !String(post.published_at || post.publishedAt || "").trim()).length
    : draftCount;
  const accountPoolSelectedCount = isAccountPoolContext ? accountPoolSelectedIds().length : 0;
  const showSelectionCheck = isMatrix;
  const accountHealth = personaAccountHealth(persona);
  return `
    <article
      class="persona-list-card ${allowReorder ? "persona-draggable-card" : ""} persona-account-health--${esc(accountHealth.tone)} ${isSideListContext ? "publish-persona-card" : ""} ${isAutomationContext ? "automation-persona-card" : ""} ${batchMode ? "is-bulk-selecting" : ""} ${batchMode && selected ? "is-bulk-selected" : ""} ${publishSelected ? "is-active" : ""} ${editing ? "is-editing" : ""} ${dragging ? "is-dragging" : ""}"
      data-persona-card="${esc(persona.id)}"
      ${allowReorder ? `data-persona-drag-persona="${esc(persona.id)}"` : ""}
      data-group-id="${esc(groupId)}"
      draggable="false"
    >
      ${batchMode ? `<label class="persona-bulk-check" title="选择${esc(persona.name || persona.id || "人设")}">
        <input type="checkbox" data-persona-bulk-check="${esc(persona.id)}" ${selected ? "checked" : ""} aria-label="选择${esc(persona.name || persona.id || "人设")}" ${bulkDisabled ? "disabled" : ""} />
      </label>` : ""}
      <button type="button" class="persona-list-item ${showSelectionCheck ? "publish-persona-select-item" : "persona-list-item--status"}" ${batchMode ? `data-persona-bulk-toggle="${esc(persona.id)}" aria-pressed="${selected ? "true" : "false"}" ${bulkDisabled ? "disabled" : ""}` : `data-persona-select="${esc(persona.id)}"`}>
        ${showSelectionCheck ? `<span class="publish-persona-check ${publishSelected ? "is-checked" : ""}" aria-hidden="true"></span>` : ""}
        <span class="persona-card-copy ${isMatrix ? "publish-persona-copy" : ""}">
          <span class="persona-card-title">
            <strong>${esc(persona.name || persona.id || "未命名人设")}</strong>
            ${renderPersonaKindBadge(persona)}
            ${isMatrix && ungrouped ? `<span class="persona-kind-badge persona-ungrouped-badge">未分组</span>` : ""}
            ${isMatrix && accountHealth.tone !== "unbound" ? `<span class="persona-account-health-icon is-${esc(accountHealth.tone)}" title="${esc(accountHealth.label)}" aria-label="${esc(accountHealth.label)}">${renderPersonaAccountHealthIcon(accountHealth)}</span>` : ""}
          </span>
          <small>${esc(isPublishContext ? publishAccountLabel : (isAutomationContext || isAccountPoolContext ? (personaAccounts(persona).length ? `${personaAccounts(persona).length} 个执行账号` : "未绑定执行账号") : personaExecutionAccountLabel(persona)))}</small>
          ${isPublishContext ? `
            <span class="publish-persona-stats">
              <span>草稿 ${esc(availableDraftCount)}/${esc(draftCount)}</span>
              <span>收藏 ${esc(favoriteCount)}</span>
            </span>
          ` : ""}
        </span>
        ${isMatrix ? "" : `<span class="persona-card-status">
          ${ungrouped ? `<span class="persona-kind-badge persona-ungrouped-badge">未分组</span>` : ""}
          ${accountHealth.tone === "unbound" ? "" : `<span class="persona-account-health-icon is-${esc(accountHealth.tone)}" title="${esc(accountHealth.label)}" aria-label="${esc(accountHealth.label)}">${renderPersonaAccountHealthIcon(accountHealth)}</span>`}
        </span>`}
      </button>
      ${isMatrix ? `<input class="publish-persona-hidden-check" type="checkbox" data-matrix-persona value="${esc(persona.id)}" ${publishSelected ? "checked" : ""} aria-hidden="true" tabindex="-1" />` : ""}
      ${isAccountPoolContext ? `<button type="button" class="account-pool-bind-persona" data-account-pool-bind-persona="${esc(persona.id)}" title="绑定所选账号" aria-label="绑定所选账号" ${accountPoolSelectedCount === 1 && !state.accountPoolBinding ? "" : "disabled"}>
        <svg class="ui-link-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
        </svg>
      </button>` : ""}
      ${isPublishContext ? "" : (allowEdit ? `<button type="button" class="persona-card-edit" data-persona-edit="${esc(persona.id)}" title="编辑分组" aria-label="编辑分组">...</button>` : "")}
    </article>`;
}

function renderPersonaFolder(group, map, options = {}) {
  const publishMode = normalizedPublishMode(options.publishMode || "");
  const isPublishContext = options.context === "publishing";
  const isAutomationContext = options.context === "automation";
  const isAccountPoolContext = options.context === "account_pool";
  const isSideListContext = isPublishContext || isAutomationContext || isAccountPoolContext;
  const batchMode = options.batchMode === true && !isSideListContext;
  const groupBatchMode = batchMode && options.groupBatchMode === true;
  const bulkDisabled = batchMode && options.bulkDisabled === true;
  const allowEdit = options.allowEdit !== false && !isSideListContext && !batchMode;
  const allowGroupEdit = options.allowGroupEdit === true || allowEdit;
  const allowReorder = options.allowReorder !== false && !batchMode;
  const isMatrix = isPublishContext && publishMode === "matrix_start";
  const selectedIds = Array.isArray(options.selectedIds) ? options.selectedIds.map((id) => String(id || "")) : [];
  const selectedGroupIds = Array.isArray(options.selectedGroupIds) ? options.selectedGroupIds.map((id) => String(id || "")) : [];
  const personas = (group.persona_ids || []).map((id) => map.get(String(id))).filter(Boolean);
  const hasPersonas = personas.length > 0;
  const collapsed = Boolean(group.collapsed);
  const editing = allowGroupEdit && String(state.personaListEditorId || "") === `group:${String(group.id || "")}`;
  const selection = publishGroupSelectionState(group.persona_ids || [], selectedIds);
  const groupSelected = groupBatchMode && selectedGroupIds.includes(String(group.id || ""));
  return `
    <div class="persona-layer-group ${isSideListContext ? "publish-persona-group" : ""} ${isAutomationContext ? "automation-persona-group" : ""} ${collapsed ? "is-collapsed" : ""} ${hasPersonas ? "" : "is-empty"}" data-persona-folder="${esc(group.id)}" ${allowReorder ? `data-persona-drop-zone="${esc(group.id)}"` : ""}>
      <div class="persona-list-card persona-folder-card ${isSideListContext ? "publish-folder-card" : ""} ${isAutomationContext ? "automation-folder-card" : ""} ${batchMode && (groupBatchMode || hasPersonas) ? "is-bulk-selecting" : ""} ${groupBatchMode && groupSelected ? "is-bulk-selected" : ""} ${!groupBatchMode && batchMode && (selection.all || selection.partial) ? "is-bulk-selected" : ""} ${!groupBatchMode && selection.all ? "is-active" : ""} ${!groupBatchMode && selection.partial ? "is-partial" : ""} ${editing ? "is-editing" : ""}" data-persona-folder-card="${esc(group.id)}">
        ${groupBatchMode ? `<label class="persona-bulk-check persona-bulk-check--group" title="选择分组${esc(group.name)}">
          <input type="checkbox" data-persona-bulk-group-check="${esc(group.id)}" ${groupSelected ? "checked" : ""} aria-label="选择分组${esc(group.name)}" ${bulkDisabled ? "disabled" : ""} />
        </label>` : (batchMode && hasPersonas ? `<label class="persona-bulk-check persona-bulk-check--group" title="选择分组${esc(group.name)}内全部人设">
          <input type="checkbox" data-persona-bulk-group="${esc(group.id)}" data-persona-bulk-partial="${selection.partial ? "true" : "false"}" ${selection.all ? "checked" : ""} aria-label="选择${esc(group.name)}内全部人设" ${bulkDisabled ? "disabled" : ""} />
        </label>` : "")}
        ${hasPersonas ? `
        <button type="button" class="persona-folder-main" ${groupBatchMode ? `data-persona-bulk-group-toggle="${esc(group.id)}" aria-label="${groupSelected ? "取消选择" : "选择"}分组${esc(group.name)}" aria-pressed="${groupSelected ? "true" : "false"}" ${bulkDisabled ? "disabled" : ""}` : `data-persona-toggle-folder="${esc(group.id)}" aria-label="${collapsed ? "展开分组" : "收起分组"}" aria-expanded="${collapsed ? "false" : "true"}"`}>
          ${isMatrix ? `<span class="publish-persona-check ${selection.all ? "is-checked" : ""} ${selection.partial ? "is-partial" : ""}" data-matrix-group="${esc(group.id)}" aria-hidden="true"></span>` : `<span class="persona-folder-caret" aria-hidden="true"></span>`}
          <span class="persona-folder-copy">
            <span class="persona-card-title">
              <strong>${esc(group.name)}</strong>
              <span class="persona-kind-badge persona-group-badge">分组</span>
              <span class="persona-kind-badge">${personas.length} 个</span>
            </span>
            <small>${groupBatchMode ? "删除分组后人设保留" : (isMatrix ? `已选 ${selection.count}/${selection.total}` : (collapsed ? "已收起" : "已展开"))}</small>
          </span>
        </button>
        ` : `
        <${groupBatchMode ? "button type=\"button\"" : "div"} class="persona-folder-main persona-folder-main--static" ${groupBatchMode ? `data-persona-bulk-group-toggle="${esc(group.id)}" aria-label="${groupSelected ? "取消选择" : "选择"}空分组${esc(group.name)}" aria-pressed="${groupSelected ? "true" : "false"}" ${bulkDisabled ? "disabled" : ""}` : `aria-label="空分组"`}>
          <span class="persona-folder-copy">
            <span class="persona-card-title">
              <strong>${esc(group.name)}</strong>
              <span class="persona-kind-badge persona-group-badge">分组</span>
              <span class="persona-kind-badge persona-empty-group-badge">0 个</span>
            </span>
            <small>空分组</small>
          </span>
        </${groupBatchMode ? "button" : "div"}>
        `}
        ${allowGroupEdit ? `<button type="button" class="persona-card-edit" data-persona-edit-group="${esc(group.id)}" title="编辑分组" aria-label="编辑分组">...</button>` : ""}
        ${allowGroupEdit && editing ? `
          <div class="persona-card-menu persona-card-menu--group">
            <div class="persona-menu-tabs" aria-label="分组操作">
              <button type="button" class="persona-menu-tab persona-menu-tab--action" data-persona-rename-group="${esc(group.id)}">
                <span>重命名</span>
              </button>
              <button type="button" class="persona-menu-tab persona-menu-tab--action" data-persona-delete-group="${esc(group.id)}">
                <span>删除分组</span>
              </button>
            </div>
          </div>
        ` : ""}
      </div>
      ${!groupBatchMode && (hasPersonas || allowReorder) ? `<div class="persona-layer-children ${hasPersonas ? "" : "persona-layer-children--empty-drop"}" ${allowReorder ? `data-persona-drop-zone="${esc(group.id)}"` : ""}>${hasPersonas ? personas.map((persona) => renderPersonaCard(persona, group.id, options)).join("") : ""}</div>` : ""}
    </div>`;
}

function renderPersonaCollectionList(options = {}) {
  const isPublishContext = options.context === "publishing";
  const isAutomationContext = options.context === "automation";
  const isAccountPoolContext = options.context === "account_pool";
  const isSideListContext = isPublishContext || isAutomationContext || isAccountPoolContext;
  const allowReorder = options.allowReorder !== false;
  const map = personaByIdMap();
  const { pageSize, totalPages, currentPage, nodes: visibleNodes } = visiblePersonaCollectionListNodes({ groupsOnly: options.groupBatchMode === true });
  const pager = `
    <div class="persona-list-pager">
      <button type="button" data-persona-list-page="first" title="首页" aria-label="首页" ${currentPage <= 1 ? "disabled" : ""}><span class="ui-arrow-icon ui-arrow-icon--double-left" aria-hidden="true"></span></button>
      <button type="button" data-persona-list-page="prev" title="上页" aria-label="上页" ${currentPage <= 1 ? "disabled" : ""}><span class="ui-arrow-icon ui-arrow-icon--left" aria-hidden="true"></span></button>
      <span>${esc(`${currentPage} / ${totalPages} · 每页 ${pageSize}`)}</span>
      <button type="button" data-persona-list-page="next" title="下页" aria-label="下页" ${currentPage >= totalPages ? "disabled" : ""}><span class="ui-arrow-icon ui-arrow-icon--right" aria-hidden="true"></span></button>
      <button type="button" data-persona-list-page="last" title="尾页" aria-label="尾页" ${currentPage >= totalPages ? "disabled" : ""}><span class="ui-arrow-icon ui-arrow-icon--double-right" aria-hidden="true"></span></button>
    </div>
  `;
  return `
    <div class="persona-list-scroll">
      <div class="persona-list-stack ${isSideListContext ? "publish-persona-stack" : ""}" ${allowReorder ? `data-persona-drop-zone="root"` : ""}>
        ${visibleNodes.map((node) => node.type === "group" ? renderPersonaFolder(node.group, map, options) : renderPersonaCard(node.persona, "", options)).join("")}
      </div>
    </div>
    ${pager}`;
}

function personaListTotalPages(pageSize = Number(state.personaListPageSize || 20)) {
  const groups = personaCollectionGroups();
  if (state.personaBulkMode && personaBulkScope() === "groups") {
    const cleanPageSize = Math.min(Math.max(Number(pageSize || 20), 5), 80);
    return Math.max(1, Math.ceil(groups.length / cleanPageSize));
  }
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
  if (groupKey === "settings") {
    const tabs = [
      ["profile", "基础资料"],
      ["links", "链接设置"],
      ["account", "账号设置"],
    ];
    return `<div class="persona-step-tabs" id="personaStepTabs" aria-label="当前分组的二级页签">${tabs.map(([value, label]) => `
      <button
        type="button"
        class="${value === step ? "is-active" : ""}"
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

function renderPersonaMediaContentModeTabs(mode) {
  const activeMode = mode === "manual" ? "manual" : "draft";
  const tabs = [
    ["draft", "根据图文生成"],
    ["manual", "自定义"],
  ];
  return `<div class="persona-step-tabs persona-subflow-tabs">${tabs.map(([value, label]) => `
      <button
        type="button"
        class="${activeMode === value ? "is-active" : ""}"
        data-persona-media-content-mode="${esc(value)}"
      >${esc(label)}</button>
  `).join("")}</div>`;
}

function renderPersonaHotReplacementPool(personaId, candidateId) {
  const rows = personaHotReplacementPool(personaId, candidateId);
  if (!rows.length) return `<div class="persona-hot-replacement-empty">暂未添加待替换媒体。</div>`;
  const selected = personaHotSelectedReplacementPoolEntry(personaId, candidateId);
  const previewGroupId = registerMediaPreviewGroup(rows.map((entry) => ({
    previewUrl: entry.previewUrl,
    url: entry.previewUrl,
    type: guessMediaType(entry.file?.name || "", entry.file?.type || ""),
    label: entry.file?.name || "待替换媒体",
  })));
  return `
    <div class="persona-hot-replacement-pool" aria-label="待替换媒体">
      ${rows.map((entry, index) => {
        const kind = fileKind(entry.file);
        const isSelected = String(selected?.id || "") === String(entry.id);
        return `
          <div class="persona-hot-replacement-item ${isSelected ? "is-selected" : ""}">
            <button
              type="button"
              class="persona-hot-replacement-thumb"
              data-persona-hot-replacement-pool-select="${esc(candidateId)}"
              data-persona-hot-replacement-pool-id="${esc(entry.id)}"
              title="选择 ${esc(entry.file?.name || `媒体 ${index + 1}`)}"
              aria-label="${isSelected ? "已选择" : "选择"}待替换媒体 ${index + 1}"
            >
              ${kind === "video"
                ? `<video src="${esc(entry.previewUrl)}" muted playsinline preload="metadata"></video>`
                : `<img src="${esc(entry.previewUrl)}" alt="${esc(entry.file?.name || `待替换媒体 ${index + 1}`)}" />`}
              ${isSelected ? `<span class="persona-hot-replacement-selected" aria-hidden="true">${renderSelectAllIcon()}</span>` : ""}
            </button>
            <div class="persona-hot-replacement-actions">
              <button
                type="button"
                class="persona-hot-media-action is-view"
                data-media-preview-group="${esc(previewGroupId)}"
                data-media-preview-index="${esc(index)}"
                title="查看媒体"
                aria-label="查看待替换媒体 ${index + 1}"
              >${renderEyeIcon()}</button>
              <button
                type="button"
                class="persona-hot-media-action is-remove"
                data-persona-hot-replacement-pool-remove="${esc(candidateId)}"
                data-persona-hot-replacement-pool-id="${esc(entry.id)}"
                title="移除待替换媒体"
                aria-label="移除待替换媒体 ${index + 1}"
              >${renderTrashIcon()}</button>
            </div>
            <small title="${esc(entry.file?.name || "")}">${esc(entry.file?.name || `媒体 ${index + 1}`)}</small>
          </div>`;
      }).join("")}
    </div>`;
}

function renderPersonaHotCandidatePreview(candidate) {
  if (!candidate) return `<div class="empty-state">从左侧热点候选里选一条，这里会显示正文预览和来源。</div>`;
  const persona = selectedPersona();
  const candidateId = personaHotCandidateKey(candidate);
  const form = personaFormState(persona?.id).generate;
  const isEditing = String(form.hotEditingCandidateId || "").trim() === candidateId;
  const mediaItems = personaHotCandidateMediaItems(candidate);
  const replacementEntries = personaHotReplacementEntries(persona?.id, candidateId);
  const selectedMediaIndex = personaHotSelectedMediaIndex(persona?.id, candidateId, mediaItems.length);
  const selectedReplacement = replacementEntries.find((entry) => entry.index === selectedMediaIndex) || null;
  return `
    <div class="persona-hot-preview-card ${isEditing ? "is-editing-draft" : ""}" data-persona-hot-preview-key="${esc(`${persona?.id || ""}:${candidateId}`)}">
      ${isEditing ? `<div class="persona-temp-edit-toolbar persona-temp-edit-toolbar--hint"><span>热点推文编辑中，确认内容和媒体后再导入。</span></div>` : ""}
      <div class="persona-hot-preview-head">
        <strong>${esc((candidate.platform || "threads").toUpperCase())}</strong>
        ${renderMediaTypeBadge(mediaItems)}
        <small>${esc(formatTime(candidate.captured_at || candidate.published_at || ""))}</small>
      </div>
      <label>${isEditing ? "编辑导入正文" : "导入正文"}
        <textarea id="personaHotPreviewContent" rows="7" ${isEditing ? "" : "readonly"}>${esc(personaHotEditedContent(persona?.id, candidate))}</textarea>
      </label>
      <div class="persona-hot-preview-meta">
        <small>${esc(personaHotMetricSummary(candidate))}</small>
        ${candidate.source_url ? `<a href="${esc(candidate.source_url)}" target="_blank" rel="noopener">打开原帖</a>` : ""}
      </div>
      ${renderPersonaHotMediaPreview(persona, candidate, { editing: isEditing })}
      ${isEditing && mediaItems.length ? `<div class="persona-media-edit-pane persona-media-edit-pane--upload">
        ${renderUploadDropzone("personaHotReplacementFiles", {
          label: "添加待替换媒体",
          hint: "可拖入或选择多个文件。先选择下方缩略图，再点击原媒体上的替换图标。",
          multiple: true,
        })}
        <div class="persona-hot-replacement-head">
          <small>${esc(personaHotSelectedReplacementPoolEntry(persona?.id, candidateId) ? `已选择待替换文件；目标媒体 ${selectedMediaIndex + 1}` : "添加文件后，先选择一个待替换媒体。")}</small>
          ${selectedReplacement ? `<button type="button" class="persona-hot-media-action is-restore" data-persona-hot-media-replacement-clear="${esc(candidateId)}" data-persona-hot-media-index="${esc(selectedMediaIndex)}" title="撤销当前替换" aria-label="撤销第 ${selectedMediaIndex + 1} 个媒体的替换">${renderUndoIcon()}</button>` : ""}
        </div>
        ${renderPersonaHotReplacementPool(persona?.id, candidateId)}
      </div>` : ""}
    </div>
    <div class="row-actions persona-hot-preview-actions">
      ${isEditing
        ? `<button type="button" data-persona-cancel-hot-edit="${esc(candidateId)}">取消编辑</button>
           <button type="button" class="primary" data-persona-confirm-hot-import="${esc(candidateId)}">确认导入</button>`
        : `<button type="button" class="primary" data-persona-import-hot-one="${esc(candidateId)}">直接导入</button>
           <button type="button" data-persona-start-hot-edit="${esc(candidateId)}">编辑后使用</button>`}
    </div>
  `;
}

function renderPersonaHotCandidatePicker(persona, form) {
  const hotState = state.personaHotCandidateResults[String(persona?.id || "").trim()] || {};
  const candidates = personaHotCandidates(persona);
  const selectedIds = new Set((form.hotSelectedIds || []).map((item) => String(item || "").trim()).filter(Boolean));
  const preview = personaHotPreviewCandidate(persona);
  const previewEditing = Boolean(preview && String(form.hotEditingCandidateId || "").trim() === personaHotCandidateKey(preview));
  const keywords = Array.isArray(hotState.keywords) ? hotState.keywords : [];
  const warnings = Array.isArray(hotState.warnings) ? hotState.warnings : [];
  const cookieStatuses = Array.isArray(hotState.cookie_statuses) ? hotState.cookie_statuses : [];
  const hotBusy = isActionLocked("persona", persona?.id || "", "hot_candidates");
  const hotBusyStartedAt = actionLockStartedAt("persona", persona?.id || "", "hot_candidates");
  form.hotSearchMode = normalizePersonaHotSearchMode(form.hotSearchMode || hotState.search_mode);
  form.hotFreshnessDays = normalizePersonaHotFreshnessDays(hotState.freshness_days ?? form.hotFreshnessDays);
  const hotMode = form.hotSearchMode;
  const hotFreshnessDays = form.hotFreshnessDays;
  return `
    <div class="persona-hot-filters">
      <div class="persona-head-copy">
        <strong>热点抓取</strong>
        <span>按当前人设和已有记忆自动抓取 Threads / Instagram 热点候选。</span>
      </div>
      <div class="persona-hot-mode-row">
        <div class="automation-capsule-tabs persona-hot-mode-tabs" aria-label="热点抓取方式">
          ${[
            ["normal", "普通"],
            ["strict", "严格"],
          ].map(([value, label]) => `
            <button type="button" data-persona-hot-search-mode="${esc(value)}" class="${hotMode === value ? "is-active" : ""}" ${hotBusy ? "disabled" : ""}>${esc(label)}</button>
          `).join("")}
        </div>
        <small>${hotMode === "normal" ? "泛垂直：覆盖同领域宽泛热点" : "垂直：更贴合当前人设关键词"}</small>
      </div>
      <div class="row-actions">
        <label class="persona-hot-freshness-control" title="输入 0 表示不限时间">
          <span>新鲜度</span>
          <input type="number" min="0" max="15" step="1" value="${esc(hotFreshnessDays)}" data-persona-hot-freshness-days ${hotBusy ? "disabled" : ""} aria-label="热点新鲜度天数">
          <span data-persona-hot-freshness-unit>${hotFreshnessDays > 0 ? "天内" : "不限"}</span>
        </label>
        <button type="button" class="primary" data-persona-fetch-hot ${hotBusy ? "disabled" : ""}>${hotBusy ? renderBusyButtonContent("正在抓取热点", true, hotBusyStartedAt) : "抓取热点"}</button>
        <button type="button" data-persona-fetch-hot-refresh ${!hotBusy ? "" : "disabled"}>${hotBusy ? "正在刷新..." : "刷新候选"}</button>
      </div>
    </div>
    ${(keywords.length || warnings.length || cookieStatuses.length) ? `
      <div class="persona-inline-panel persona-inline-panel--nested">
        ${keywords.length ? `<div class="persona-hot-status-row"><strong>本次关键词</strong><span>${esc(keywords.join(" / "))}</span></div>` : ""}
        <div class="persona-hot-status-row"><strong>抓取方式</strong><span>${esc(personaHotSearchModeLabel(hotState.search_mode || hotMode))}</span></div>
        <div class="persona-hot-status-row"><strong>新鲜度</strong><span>${esc(personaHotFreshnessLabel(hotState.freshness_days ?? hotFreshnessDays))}</span></div>
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
            const mediaItems = personaHotCandidateMediaItems(candidate);
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
                    ${renderMediaTypeBadge(mediaItems)}
                    <small>${esc(formatTime(candidate.captured_at || candidate.published_at || ""))}</small>
                  </span>
                  <span class="persona-hot-card-copy">${esc(candidate.full_content || candidate.summary)}</span>
                  <span class="persona-hot-card-metrics">${esc(personaHotMetricSummary(candidate))}</span>
                </button>
              </article>
            `;
          }).join("")}
        </div>
      </section>
      <section class="persona-hot-preview ${previewEditing ? "is-editing-draft" : ""}">
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
  return [["persona_post_image", "根据图文生成"]];
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

function renderPersonaGenerateComposeTabs(mode) {
  const activeMode = ["tweet_media", "custom"].includes(mode) ? mode : "tweet";
  const tabs = [
    ["tweet", "只生成推文"],
    ["tweet_media", "根据推文生成配图"],
    ["custom", "自定义"],
  ];
  return `<div class="persona-compose-toggle" aria-label="新建推文档位">${tabs.map(([value, label]) => `
    <button
      type="button"
      class="${activeMode === value ? "is-active" : ""}"
      data-persona-compose-mode="${esc(value)}"
    >${esc(label)}</button>
  `).join("")}</div>`;
}

function renderPersonaMediaOperationTabs(mode) {
  const activeMode = mode === "generate" ? "generate" : "replace";
  const tabs = [
    ["replace", "替换媒体"],
    ["generate", "生成媒体"],
  ];
  return `<div class="persona-media-operation-toggle" aria-label="媒体操作">${tabs.map(([value, label]) => `
    <button
      type="button"
      class="${activeMode === value ? "is-active" : ""}"
      data-persona-media-operation="${esc(value)}"
    >${esc(label)}</button>
  `).join("")}</div>`;
}

function renderPersonaMediaComposerPlaceholder() {
  return `
    <section class="persona-compose-media-side persona-production-section">
      <div class="persona-inline-panel persona-inline-panel--nested">
        <strong>配图步骤待开启</strong>
        <div class="empty-state">当前只生成推文。需要配图时，选择左侧“根据推文生成配图”。</div>
      </div>
    </section>`;
}

function renderPersonaInlineMediaComposer(persona, profile, generateForm, mediaForm, post, postMediaItems, sourceLabel, isFavoriteMedia) {
  const stepHead = `
    <div class="persona-production-step-head">
      <span>第2步</span>
      <strong>生成配图</strong>
      <p>选择草稿后生成配图，也可以上传、追加或替换当前草稿媒体。</p>
    </div>`;
  if (!post) {
    const isCustomCompose = String(generateForm.composeMode || "").trim() === "custom";
    return `
      <section class="persona-compose-media-side persona-production-section">
        ${stepHead}
        <div class="persona-inline-panel persona-inline-panel--nested">
          <strong>${isCustomCompose ? "上传媒体" : "推文配图"}</strong>
          ${isCustomCompose ? `
            ${renderUploadDropzone("personaPostMediaUploadFiles", {
              label: "选择媒体文件",
              hint: "支持图片或视频；可单独保存媒体，也可以和左侧正文组合保存。",
            })}
            <div class="row-actions persona-media-upload-actions">
              <button type="button" class="primary" data-persona-create-post>保存自定义草稿</button>
            </div>
          ` : `<div class="empty-state">先保存或生成一条草稿，再根据草稿正文生成配图。</div>`}
        </div>
      </section>`;
  }
  const mediaTaskOptions = personaMediaTaskOptions(profile, generateForm);
  const currentTaskType = mediaTaskOptions.some(([value]) => value === String(mediaForm.taskType || ""))
    ? String(mediaForm.taskType || "")
    : String(mediaTaskOptions[0]?.[0] || "persona_post_image");
  mediaForm.taskType = currentTaskType;
  mediaForm.contentMode = String(mediaForm.contentMode || "draft") === "manual" ? "manual" : "draft";
  mediaForm.imageCount = Math.min(Math.max(Number(mediaForm.imageCount || state.personaMediaImageCountDefault || 1), 1), 8);
  const mediaMeta = taskMeta[currentTaskType] || taskMeta.persona_post_image || taskMeta.text_to_image;
  const showAspectRatio = currentTaskType === "persona_post_image";
  const showVideoOptions = false;
  const uploadAccept = "image/*";
  const showSourceUpload = Number(mediaMeta.minImages || 0) > 0;
  const mediaBusy = !isFavoriteMedia && post && (isActionLocked("media_task", persona.id, post.id, currentTaskType) || personaMediaTaskIsActive(persona.id, post.id, currentTaskType));
  const mediaBusyStartedAt = personaMediaTaskStartedAt(persona.id, post?.id || "", currentTaskType);
  const operationMode = isFavoriteMedia ? "replace" : (mediaForm.operationMode === "generate" ? "generate" : "replace");
  return `
    <section class="persona-compose-media-side persona-production-section">
      ${stepHead}
      <div class="persona-inline-panel persona-inline-panel--nested">
        <strong>当前${esc(sourceLabel)}正文</strong>
        ${renderPersonaHotOrigin(personaHotImportMeta(persona.id, post.id), { compact: true })}
        <p>${esc(String(post.content || "").trim() || `当前${sourceLabel}没有正文。`)}</p>
      </div>
      <div class="persona-inline-panel persona-inline-panel--nested persona-media-operation-panel">
        ${isFavoriteMedia ? `<strong>收藏媒体</strong>` : renderPersonaMediaOperationTabs(operationMode)}
        ${operationMode === "replace" ? `
          <div class="persona-media-operation-pane">
            <strong>媒体编辑</strong>
            ${isFavoriteMedia ? `<span class="persona-panel-intro">收藏内容支持上传、替换和删除媒体；生成新的配图请先复制为草稿后处理。</span>` : ""}
            <div class="persona-media-edit-split">
              <div class="persona-media-edit-pane persona-media-edit-pane--list">
                <strong>当前媒体</strong>
                ${renderPersonaEditableMediaGrid(postMediaItems, { personaId: persona.id, source: isFavoriteMedia ? "favorites" : "posts", postId: post.id })}
              </div>
              <div class="persona-media-edit-pane persona-media-edit-pane--upload">
                ${renderUploadDropzone("personaPostMediaUploadFiles", { label: "上传媒体", hint: `拖动图片或视频到这里，或点击选择。可追加到${sourceLabel}；选中左侧缩略图可替换。` })}
                <div class="row-actions persona-media-upload-actions">
                  <button type="button" class="primary" data-persona-upload-post-media="append">追加</button>
                  ${postMediaItems.length ? `<button type="button" data-persona-replace-post-media="${esc(selectedPersonaMediaIndex(persona.id, isFavoriteMedia ? "favorites" : "posts", post.id, postMediaItems.length))}">替换</button>` : ""}
                  ${postMediaItems.length ? `<button type="button" class="danger" data-persona-delete-post-media="${esc(selectedPersonaMediaIndex(persona.id, isFavoriteMedia ? "favorites" : "posts", post.id, postMediaItems.length))}">删除</button>` : ""}
                </div>
              </div>
            </div>
          </div>
        ` : `
          <div class="persona-media-operation-pane">
            <strong>生成媒体</strong>
            ${renderPersonaMediaContentModeTabs(mediaForm.contentMode)}
            <div class="form-grid persona-detail-controls persona-media-generation-controls">
              <label>生成张数
                <input id="personaMediaImageCount" type="number" min="1" max="8" step="1" value="${esc(mediaForm.imageCount)}" />
              </label>
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
            ${mediaForm.contentMode === "manual" ? `<label>手动生成内容
              <textarea id="personaMediaManualContent" rows="5" placeholder="输入要用于生成配图的内容。">${esc(mediaForm.manualContent || "")}</textarea>
            </label>` : ""}
            ${mediaForm.contentMode === "manual" ? "" : `<label>补充提示词
              <textarea id="personaMediaTaskPrompt" rows="5" placeholder="可留空；补充图文生成要求。">${esc(mediaForm.prompt || "")}</textarea>
            </label>`}
            ${showSourceUpload ? renderUploadDropzone("personaMediaTaskFiles", {
              label: "上传素材",
              accept: uploadAccept,
              hint: mediaMeta.files || "拖动任务需要的素材到这里，或点击选择。",
            }) : ""}
            <div class="row-actions">
              <button type="button" class="primary" data-persona-run-media-task ${mediaBusy ? "disabled" : ""}>${mediaBusy ? renderBusyButtonContent("配图任务执行中", true, mediaBusyStartedAt) : "生成预览"}</button>
            </div>
            <div class="persona-inline-panel persona-inline-panel--nested">
              <strong>任务结果预览</strong>
              ${renderPersonaMediaTaskResult(persona.id, post.id)}
            </div>
          </div>
        `}
      </div>
    </section>`;
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

function renderPersonaEditableMediaGrid(items, options = {}) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return `<div class="empty-state">当前草稿还没有媒体。</div>`;
  const groupId = registerMediaPreviewGroup(rows.filter((item) => item && item.previewUrl && !item.unavailable));
  let previewIndex = 0;
  const personaId = String(options.personaId || selectedPersona()?.id || "").trim();
  const source = options.source === "favorites" ? "favorites" : "posts";
  const postId = String(options.postId || personaMediaTargetPost(selectedPersona()).post?.id || "").trim();
  const selectedIndex = selectedPersonaMediaIndex(personaId, source, postId, rows.length);
  return `<div class="persona-edit-media-grid" role="listbox" aria-label="当前媒体缩略图列表">${rows.map((item, index) => {
    const isSelected = index === selectedIndex;
    return `
    <div class="persona-edit-media-card ${isSelected ? "is-selected" : ""}" data-persona-select-post-media="${esc(index)}" role="option" aria-selected="${isSelected ? "true" : "false"}">
      <div class="persona-edit-media-card-head">
        <span>${esc(`第 ${index + 1} 个媒体`)}</span>
        ${isSelected ? `<small>已选中</small>` : ""}
      </div>
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
    </div>
  `;}).join("")}</div>`;
}

function updatePersonaEditableMediaSelectionDom(card, index) {
  const selectedIndex = Math.max(0, Number.parseInt(String(index || 0), 10) || 0);
  const grid = card?.closest?.(".persona-edit-media-grid");
  if (!grid) return;
  grid.querySelectorAll(".persona-edit-media-card").forEach((item) => {
    const isSelected = Number.parseInt(String(item.dataset.personaSelectPostMedia || "0"), 10) === selectedIndex;
    item.classList.toggle("is-selected", isSelected);
    item.setAttribute("aria-selected", isSelected ? "true" : "false");
    const head = item.querySelector(".persona-edit-media-card-head");
    const marker = head?.querySelector("small");
    if (isSelected && head && !marker) {
      head.insertAdjacentHTML("beforeend", "<small>已选中</small>");
    } else if (!isSelected && marker) {
      marker.remove();
    }
  });
  const panel = grid.closest(".persona-media-operation-panel, .persona-media-workspace, .persona-content-panel, #moduleBody") || document;
  panel.querySelectorAll("[data-persona-replace-post-media]").forEach((button) => {
    button.dataset.personaReplacePostMedia = String(selectedIndex);
  });
  panel.querySelectorAll("[data-persona-delete-post-media]").forEach((button) => {
    button.dataset.personaDeletePostMedia = String(selectedIndex);
  });
}

function renderPersonaImageLibraryGrid(library) {
  const rows = Array.isArray(library?.items) ? library.items : [];
  const previewable = rows
    .map((item) => ({
      id: String(item.id || "").trim(),
      previewUrl: String(item.preview_url || item.image_url || "").trim(),
      type: "image",
      label: String(item.prompt || item.created_at || "人设图").trim() || "人设图",
      isReference: Boolean(item.is_reference || item.isReference),
      createdAt: String(item.created_at || "").trim(),
    }))
    .filter((item) => item.previewUrl);
  if (!previewable.length) {
    return `
      <div class="persona-image-library-grid persona-image-library-grid--empty">
        <div class="persona-image-library-card persona-image-library-card--empty">
          <button type="button" class="persona-image-upload-placeholder" data-persona-upload-image-dropzone data-persona-upload-image-trigger aria-label="上传自定义人设图">
            <span class="persona-image-upload-placeholder-icon">${renderPlusIcon()}</span>
            <strong>上传自定义人设图</strong>
            <small>拖拽图片到这里，或点击选择</small>
            <small class="persona-image-upload-placeholder-tip">建议优先使用三视图</small>
          </button>
          <small class="persona-image-library-meta-placeholder">未上传人设图</small>
          <div class="persona-image-library-actions persona-image-library-actions--placeholder" aria-hidden="true">
            <span class="persona-image-library-action-placeholder persona-image-library-apply"></span>
            <span class="persona-image-library-action-placeholder"></span>
            <span class="persona-image-library-action-placeholder"></span>
          </div>
        </div>
      </div>`;
  }
  const groupId = registerMediaPreviewGroup(previewable);
  return `<div class="persona-image-library-grid">${previewable.map((item, index) => `
    <div class="persona-image-library-card ${item.isReference ? "is-reference" : ""}">
      ${renderMediaPreviewButton(item, groupId, index, {
        className: "persona-image-library-preview",
        frameClass: "persona-image-library-frame",
        caption: item.isReference ? "当前参考图" : "历史图",
      })}
      <small>${esc(item.createdAt ? formatTime(item.createdAt) : "")}</small>
      <div class="row-actions persona-image-library-actions">
        <button type="button" class="primary persona-image-library-apply" data-persona-apply-image="${esc(item.id)}" ${item.isReference || !item.id ? "disabled" : ""}>${item.isReference ? "当前使用" : "设为当前"}</button>
        <button type="button" data-persona-replace-image="${esc(item.id)}" ${!item.id ? "disabled" : ""}>替换</button>
        <button type="button" class="danger" data-persona-delete-image="${esc(item.id)}" ${!item.id ? "disabled" : ""}>删除</button>
      </div>
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
  const missingPersonaImage = /人设图/.test(String(detail.error || "")) && !items.length;
  return `
    <div class="compact-list">
      <article class="compact-row compact-row-log">
        <strong>${esc(taskMeta[String(detail.type || taskState.taskType || "persona_post_image")]?.title || "媒体任务")}</strong>
        <p>${esc(statusLabel(status))} · ${esc(taskState.taskId)}</p>
        <span>${esc(formatTime(detail.finished_at || detail.updated_at || detail.created_at || ""))}</span>
      </article>
    </div>
    ${items.length ? renderPersonaMediaPreview(items) : `<div class="empty-state">${terminal ? "任务已结束，但还没有可预览的媒体结果。" : "任务执行中，结果返回后会自动显示在这里。"}</div>`}
    <div class="row-actions">
      ${missingPersonaImage ? `<button type="button" class="primary" data-persona-open-image-settings="${esc(personaId)}">去生成人设图</button>` : ""}
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
            <span>下一步可以继续补资料，或直接生成人设图。</span>
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
            <button type="button" class="primary" data-persona-create-ai-keywords aria-busy="${aiKeywordsBusy ? "true" : "false"}" ${anyCreateBusy ? "disabled" : ""}>${aiKeywordsBusy ? "正在提炼关键词..." : (anyCreateBusy ? `${busyLabel}中` : "下一步：提炼关键词")}</button>
            ${aiKeywordsBusy ? `<button type="button" data-persona-create-ai-cancel-keywords>取消</button>` : ""}
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
              <button type="button" class="primary" data-persona-create-ai-submit aria-busy="${aiCreateBusy ? "true" : "false"}" ${anyCreateBusy ? "disabled" : ""}>${aiCreateBusy ? "正在生成人设..." : (anyCreateBusy ? `${busyLabel}中` : "确认并生成人设")}</button>
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
          <button type="button" class="primary" data-persona-create aria-busy="${manualBusy ? "true" : "false"}" ${anyCreateBusy ? "disabled" : ""}>${manualBusy ? "正在创建人设..." : (anyCreateBusy ? `${busyLabel}中` : "直接创建人设")}</button>
        </div>
      `}
    </div>
  `;
}

function personaGroupStepOptions(groupKey, profile) {
  if (groupKey === "content") {
    return [
      ["generate", "新建推文"],
      ["posts", "草稿库"],
    ];
  }
  if (groupKey === "settings") {
    return [
      ["profile", "基础资料"],
      ["links", "链接设置"],
      ["account", "账号设置"],
    ];
  }
  if (groupKey === "account") {
    return [
      ["binding", "账号概览"],
    ];
  }
  return [["overview", "概览"]];
}

function renderPersonaModule() {
  return withConsoleScrollPreserved(() => {
  if (state.workspaceBootstrapPending && !state.personas.length) {
    removePersonaCardEditorPortal();
    $("moduleBody").innerHTML = renderWorkspaceBootstrapLoading();
    return;
  }
  const current = selectedPersona();
  const bulkGroups = personaCollectionGroups();
  const groupBulkMode = state.personaBulkMode && personaBulkScope() === "groups";
  const bulkSelectedIds = groupBulkMode ? personaBulkSelectedGroupSet() : personaBulkSelectedSet();
  const currentPageIds = state.personaBulkMode
    ? (groupBulkMode ? visiblePersonaBulkGroupIds() : visiblePersonaBulkIds())
    : [];
  const currentPageAllSelected = currentPageIds.length > 0 && currentPageIds.every((id) => bulkSelectedIds.has(String(id)));
  const bulkTotal = groupBulkMode ? bulkGroups.length : state.personas.length;
  const hasCollectionEntries = groupBulkMode ? bulkGroups.length > 0 : (state.personas.length > 0 || bulkGroups.length > 0);
  removePersonaCardEditorPortal();
  $("moduleBody").innerHTML = `
    <div class="persona-console-layout">
      <section class="persona-workbench-shell">
        <div class="persona-detail" id="personaDetail"></div>
      </section>
      <aside class="persona-list-shell">
        <div class="persona-inline-panel persona-list-toolbar">
          <div class="persona-list-head">
            <div class="persona-head-copy">
              <strong>人设列表</strong>
              <span>${state.personaBulkMode ? (groupBulkMode ? "选择要删除的分组" : "选择要删除的人设") : "集中查看、选择和管理"}</span>
            </div>
            <span aria-live="polite">${esc(state.personaBulkMode ? `已选 ${bulkSelectedIds.size} / ${bulkTotal}` : `${state.personas.length} 个`)}</span>
          </div>
          <div class="persona-list-actions ${state.personaBulkMode ? "persona-list-actions--bulk" : ""}" ${state.personaBulkDeleting ? `aria-busy="true"` : ""}>
            ${state.personaBulkMode ? `
              <div class="persona-bulk-scope" role="group" aria-label="批量管理对象">
                <button type="button" data-persona-bulk-scope="personas" class="${groupBulkMode ? "" : "is-active"}" aria-pressed="${groupBulkMode ? "false" : "true"}" ${state.personaBulkDeleting ? "disabled" : ""}>人设</button>
                <button type="button" data-persona-bulk-scope="groups" class="${groupBulkMode ? "is-active" : ""}" aria-pressed="${groupBulkMode ? "true" : "false"}" ${state.personaBulkDeleting ? "disabled" : ""}>分组</button>
              </div>
              <button type="button" data-persona-bulk-page ${currentPageIds.length && !state.personaBulkDeleting ? "" : "disabled"}>${currentPageAllSelected ? renderClearSelectionIcon() : renderSelectAllIcon()}<span>${currentPageAllSelected ? "取消本页" : "全选本页"}</span></button>
              <button type="button" data-persona-bulk-clear ${bulkSelectedIds.size && !state.personaBulkDeleting ? "" : "disabled"}>${renderClearSelectionIcon()}<span>清空选择</span></button>
              <button type="button" class="danger" data-persona-bulk-delete ${bulkSelectedIds.size && !state.personaBulkDeleting ? "" : "disabled"}>${renderTrashIcon()}<span>${state.personaBulkDeleting ? "正在删除" : `${groupBulkMode ? "删除分组" : "删除"} (${bulkSelectedIds.size})`}</span></button>
              <button type="button" data-persona-bulk-exit ${state.personaBulkDeleting ? "disabled" : ""}>${renderClearSelectionIcon()}<span>完成</span></button>
            ` : `
              <button type="button" class="primary" data-persona-open-create>新建人设</button>
              <button type="button" data-persona-create-group>创建分组</button>
              <button type="button" data-persona-bulk-start>${renderSelectAllIcon()}<span>批量管理</span></button>
            `}
          </div>
        </div>
        ${hasCollectionEntries ? `
          ${renderPersonaCollectionList({
            batchMode: state.personaBulkMode,
            groupBatchMode: groupBulkMode,
            selectedIds: Array.from(groupBulkMode ? personaBulkSelectedSet() : bulkSelectedIds),
            selectedGroupIds: Array.from(groupBulkMode ? bulkSelectedIds : personaBulkSelectedGroupSet()),
            bulkDisabled: state.personaBulkDeleting,
            allowEdit: !state.personaBulkMode,
            allowGroupEdit: !state.personaBulkMode,
            allowReorder: !state.personaBulkMode,
          })}
        ` : `<div class="empty-state">${groupBulkMode ? "当前没有可管理的分组。" : "当前还没有人设，先点击“新建人设”。"}</div>`}
      </aside>
    </div>
  `;
  if (state.personaCreateMode || !current) renderPersonaDetail();
  else renderPersonaDetail();
  renderPersonaCardEditorPortal();
  syncPersonaBulkCheckboxes();
  });
}

function personaGeneratedPreviewPosts(persona, runState) {
  const ids = new Set((Array.isArray(runState?.postIds) ? runState.postIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean));
  const storedRows = personaDraftPosts(persona);
  const storedMatches = ids.size ? storedRows.filter((post) => ids.has(String(post?.id || "").trim())) : [];
  const resultRows = Array.isArray(runState?.posts) ? runState.posts : [];
  const merged = [];
  const seen = new Set();
  [...storedMatches, ...resultRows].forEach((post) => {
    const id = String(post?.id || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    merged.push(post);
  });
  return merged;
}

function renderPersonaGenerateStatusText(persona) {
  const runState = personaGenerateRunState(persona?.id);
  if (!persona || !runState) return "";
  const status = String(runState.status || "").trim();
  const kind = String(runState.kind || "draft").trim();
  const isRunning = status === "running";
  const isError = status === "error";
  const isSuccess = status === "success";
  const isDraft = kind === "draft";
  const rows = isSuccess && isDraft ? personaGeneratedPreviewPosts(persona, runState) : [];
  const fallbackSuccess = isDraft
    ? `图文草稿已生成 ${Number(runState.generatedCount || rows.length || 0)} 条`
    : "操作已完成";
  const label = String(runState.message || "").trim() || (isRunning
    ? (isDraft ? "图文草稿生成中" : "处理中")
    : (isError ? (isDraft ? "图文草稿生成失败" : "操作失败") : fallbackSuccess));
  const title = isRunning && isDraft
    ? `预计生成 ${Number(runState.count || 0) || personaGenerateDefaults().count} 条，目标约 ${Number(runState.targetWords || 0) || personaGenerateDefaults().targetWords} 字`
    : (isError ? String(runState.error || "请稍后重试。") : label);
  return `
    <span
      class="persona-generate-status-text ${isRunning ? "is-running" : ""} ${isSuccess ? "is-success" : ""} ${isError ? "is-error" : ""}"
      title="${esc(title)}"
      aria-live="polite"
    >
      <span class="persona-generate-status-label">${esc(label)}</span>
      ${isRunning ? `<span class="persona-generate-status-ellipsis" aria-hidden="true">...</span>` : ""}
    </span>
  `;
}

function renderPersonaGeneratePreviewDock(persona) {
  const runState = personaGenerateRunState(persona?.id);
  if (!persona || !runState || String(runState.kind || "draft") !== "draft" || String(runState.status || "") !== "success") return "";
  const rows = personaGeneratedPreviewPosts(persona, runState);
  if (!rows.length) return "";
  return `
    <div class="persona-generated-preview-dock">
      <div class="persona-generated-preview-dock-head">
        <div>
          <strong>生成结果预览</strong>
          <p>已生成 ${esc(Number(runState.generatedCount || rows.length || 0))} 条，结果已同步到草稿库。</p>
        </div>
        <div class="row-actions">
          <button type="button" data-persona-clear-generate-preview="${esc(persona.id)}">关闭预览</button>
        </div>
      </div>
      <div class="persona-generated-preview-grid">
        ${rows.map((post, index) => {
          const selected = String(post.id || "") === String(state.selectedPersonaPostId || "");
          return `
            <article
              class="persona-generated-preview-card ${selected ? "is-selected" : ""}"
              data-persona-generated-card="${esc(post.id)}"
              role="button"
              tabindex="0"
              aria-pressed="${selected ? "true" : "false"}"
            >
              <div class="persona-draft-card-head">
                <strong>${esc(personaDraftDisplayTitle(post, index, rows))}</strong>
                <span class="persona-draft-card-time">${esc(formatTime(post.published_at || post.updated_at || post.created_at))}</span>
              </div>
              <p>${esc(post.content || post.full_content || "暂无正文。")}</p>
              <div class="persona-draft-card-footer">
                <small>${selected ? "当前已选中" : "生成结果预览"}</small>
                <div class="row-actions persona-draft-card-actions">
                  <button type="button" data-persona-generated-view="${esc(post.id)}">查看</button>
                  <button type="button" data-persona-generated-media="${esc(post.id)}">生成配图</button>
                </div>
              </div>
            </article>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

async function viewPersonaGeneratedPost(postId = "") {
  const activePreview = activePersonaGeneratePreview();
  const post = activePreview?.rows.find((item) => String(item.id || "") === String(postId || ""));
  if (!activePreview || !post) return;
  const content = String(post.content || post.full_content || "").trim() || "暂无正文。";
  await openConsoleModal({
    title: "推文完整内容",
    contentHtml: `
      <div class="console-modal-detail persona-draft-detail-modal">
        <div><span>推文标题</span><strong>${esc(personaDraftDisplayTitleForPost(post, activePreview.rows))}</strong></div>
        <div><span>生成时间</span><strong>${esc(formatTime(post.published_at || post.updated_at || post.created_at))}</strong></div>
        <div class="persona-draft-detail-content">
          <span>推文正文</span>
          <p>${esc(content)}</p>
        </div>
      </div>
    `,
    confirmText: "关闭",
    showCancel: false,
  });
}

function activePersonaGeneratePreview(persona = selectedPersona()) {
  const runState = personaGenerateRunState(persona?.id);
  if (!persona || !runState || String(runState.kind || "draft") !== "draft" || String(runState.status || "") !== "success") return null;
  const rows = personaGeneratedPreviewPosts(persona, runState);
  return rows.length ? { persona, runState, rows } : null;
}

async function confirmLeavePersonaGeneratePreview() {
  const activePreview = activePersonaGeneratePreview();
  if (!activePreview) return true;
  const confirmed = await openConsoleModal({
    title: "退出当前预览？",
    message: "生成结果预览正在显示。确定后会关闭当前预览，再继续跳转或切换；已生成内容仍保留在草稿库。",
    confirmText: "退出并继续",
    cancelText: "留在预览",
  });
  if (!confirmed) return false;
  clearPersonaGenerateRunState(activePreview.persona.id);
  return true;
}

function activeMediaTaskResultPreview(persona = selectedPersona()) {
  if (!persona) return null;
  const { post } = personaMediaTargetPost(persona);
  if (!post) return null;
  const taskState = personaMediaTaskState(persona.id, post.id);
  if (!taskState?.taskId) return null;
  const status = String(taskState.detail?.status || taskState.status || "").trim();
  if (status !== "success") return null;
  const items = taskOutputMediaItems(taskState.detail || {});
  return items.length ? { persona, post, taskState, items } : null;
}

function activePersonaCreateResultPreview() {
  if (!state.personaCreateMode) return null;
  const createState = ensurePersonaCreateState();
  const aiResult = createState.aiResult && typeof createState.aiResult === "object" ? createState.aiResult : null;
  return aiResult?.id ? { createState, aiResult } : null;
}

function transientWorkspaceFingerprint(kind, value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    if (
      typeof item.name === "string"
      && Number.isFinite(Number(item.size))
      && Number.isFinite(Number(item.lastModified))
    ) {
      return {
        name: item.name,
        size: Number(item.size),
        type: String(item.type || ""),
        lastModified: Number(item.lastModified),
      };
    }
    return Object.keys(item).sort().reduce((result, key) => {
      result[key] = normalize(item[key]);
      return result;
    }, {});
  };
  return `${kind}:${JSON.stringify(normalize(value))}`;
}

function activeHotCandidateTransientState(persona = selectedPersona()) {
  if (!persona || !isPersonaWorkspaceModule()) return null;
  const form = personaFormState(persona.id).generate;
  const selectedIds = (Array.isArray(form.hotSelectedIds) ? form.hotSelectedIds : []).map((item) => String(item || "").trim()).filter(Boolean);
  const edited = form.hotEditedContentByCandidate && typeof form.hotEditedContentByCandidate === "object"
    ? Object.entries(form.hotEditedContentByCandidate).some(([candidateId, content]) => {
      const candidate = personaHotCandidates(persona).find((item) => personaHotCandidateKey(item) === String(candidateId || ""));
      if (!candidate) return String(content || "").trim();
      return String(content || "") !== String(candidate.full_content || candidate.content || "该热点没有完整正文。");
    })
    : false;
  const deletedMedia = form.hotDeletedMediaByCandidate && typeof form.hotDeletedMediaByCandidate === "object"
    ? Object.values(form.hotDeletedMediaByCandidate).some((rows) => Array.isArray(rows) && rows.length)
    : false;
  const replacementMedia = form.hotReplacementFilesByCandidate && typeof form.hotReplacementFilesByCandidate === "object"
    ? Object.values(form.hotReplacementFilesByCandidate).some((rows) => (
        Array.isArray(rows) ? rows.length > 0 : Boolean(rows && typeof rows === "object" && Object.keys(rows).length)
      ))
    : false;
  const stagedReplacementMedia = form.hotReplacementPoolByCandidate && typeof form.hotReplacementPoolByCandidate === "object"
    ? Object.values(form.hotReplacementPoolByCandidate).some((rows) => Array.isArray(rows) && rows.length)
    : false;
  const textRetained = Boolean(selectedIds.length || edited);
  const mediaEdited = deletedMedia || replacementMedia || stagedReplacementMedia;
  if (!selectedIds.length && !edited && !deletedMedia && !replacementMedia && !stagedReplacementMedia) return null;
  return {
    persona,
    selectedIds,
    edited,
    deletedMedia,
    replacementMedia,
    stagedReplacementMedia,
    textRetained,
    mediaEdited,
    guardKey: transientWorkspaceFingerprint("hot_candidates", {
      personaId: String(persona.id || ""),
      selectedIds,
      editedContent: form.hotEditedContentByCandidate || {},
      deletedMedia: form.hotDeletedMediaByCandidate || {},
      replacementMedia: form.hotReplacementFilesByCandidate || {},
      replacementPool: form.hotReplacementPoolByCandidate || {},
    }),
  };
}

function activePublishCustomTransientState() {
  if (state.activeModule !== "publishing") return null;
  const mode = normalizedPublishMode($("simplePublishMode")?.value || state.simpleBranches.publishing);
  const source = normalizePublishContentSource();
  if (mode !== "publish_now" && mode !== "schedule_publish") return null;
  if (source !== "custom") return null;
  const content = String($("simpleContent")?.value || state.publishCustomContent || "").trim();
  const files = filesFromInput("simpleMediaFiles");
  return (content || files.length) ? { content, fileCount: files.length } : null;
}

function activeMatrixPublishTransientState() {
  if (state.activeModule !== "publishing") return null;
  const mode = normalizedPublishMode($("simplePublishMode")?.value || state.simpleBranches.publishing);
  if (mode !== "matrix_start") return null;
  if ($("matrixPublishSource") || $("matrixPublishPlatform") || $("matrixPublishCount")) {
    updateMatrixPublishStateFromForm();
  }
  const selectedIds = matrixPublishSelectedIds();
  const source = String(state.matrixPublish.source || "posts");
  const platform = String(state.matrixPublish.platform || "threads");
  const perPersonaCount = Number(state.matrixPublish.perPersonaCount || 1);
  const scheduleAt = String($("simpleScheduleAt")?.value || "").trim();
  const changedFromDefault = selectedIds.length > 1 || source !== "posts" || platform !== "threads" || perPersonaCount !== 1 || Boolean(scheduleAt);
  return changedFromDefault ? { selectedIds, source, platform, perPersonaCount, scheduleAt } : null;
}

function activeTransientWorkspaceState() {
  const generatePreview = activePersonaGeneratePreview();
  if (generatePreview) {
    return {
      kind: "generated_preview",
      title: "退出当前预览？",
      message: "生成结果预览正在显示。确定后会关闭当前预览，再继续跳转或切换；已生成内容仍保留在草稿库。",
      confirmText: "退出并继续",
      cancelText: "留在预览",
      clear: () => clearPersonaGenerateRunState(generatePreview.persona.id),
    };
  }
  const mediaTaskResult = activeMediaTaskResultPreview();
  if (mediaTaskResult) {
    return {
      kind: "media_task_result",
      title: "离开媒体结果？",
      message: "媒体生成结果还没有追加或替换到当前草稿。确定离开后，本次结果预览会保留在任务记录中，但当前回写流程会被中断。",
      confirmText: "离开并继续",
      cancelText: "继续处理",
    };
  }
  const createResult = activePersonaCreateResultPreview();
  if (createResult) {
    return {
      kind: "persona_create_result",
      title: "离开新人设结果？",
      message: "AI 新建人设结果还停留在当前预览中。确定离开后仍会保留已创建的人设，但当前结果面板会关闭。",
      confirmText: "离开并继续",
      cancelText: "继续查看",
      clear: () => {
        state.personaCreateMode = false;
      },
    };
  }
  const hotState = activeHotCandidateTransientState();
  if (hotState) {
    return {
      kind: "hot_candidates",
      title: hotState.mediaEdited ? "放弃图片修改并离开？" : "暂时离开热点处理？",
      message: hotState.mediaEdited
        ? (hotState.textRetained
          ? "当前热点候选中有尚未导入草稿的图片修改。离开后，图片删除、替换和待替换文件将全部放弃并恢复为抓取原图，不会保存到草稿；正文选择与编辑仅保留在当前页面。返回“热点抓取”可继续处理，刷新或关闭页面可能导致正文内容丢失。"
          : "当前热点候选中有尚未导入草稿的图片修改。离开后，图片删除、替换和待替换文件将全部放弃并恢复为抓取原图，不会保存到草稿或继续保留在页面。")
        : "当前热点候选中有尚未导入草稿的选择或正文编辑。暂时离开后，这些内容仅保留在当前页面；返回“热点抓取”可继续处理。刷新或关闭页面可能导致内容丢失。",
      confirmText: hotState.mediaEdited ? "放弃图片修改并离开" : "暂时离开",
      cancelText: "返回处理",
      guardKey: hotState.guardKey,
      danger: hotState.mediaEdited,
      clear: hotState.mediaEdited ? () => discardPersonaHotMediaEdits(hotState.persona.id) : null,
      acknowledgeRemainingState: hotState.mediaEdited,
    };
  }
  const publishCustom = activePublishCustomTransientState();
  if (publishCustom) {
    return {
      kind: "publish_custom",
      title: "离开自定义发布？",
      message: `当前自定义发布内容${publishCustom.fileCount ? `和 ${publishCustom.fileCount} 个上传素材` : ""}还没有提交。确定离开后，上传选择可能需要重新选择。`,
      confirmText: "离开并继续",
      cancelText: "继续编辑",
    };
  }
  const matrixState = activeMatrixPublishTransientState();
  if (matrixState) {
    return {
      kind: "matrix_publish",
      title: "离开矩阵发布配置？",
      message: "当前矩阵发布配置还没有提交。确定离开后会保留当前页面状态，但本次提交预览不会继续停留。",
      confirmText: "离开并继续",
      cancelText: "继续配置",
    };
  }
  return null;
}

async function confirmLeaveTransientWorkspaceState({ allowNextUnload = false } = {}) {
  const activeState = activeTransientWorkspaceState();
  if (!activeState) return true;
  if (
    activeState.guardKey
    && activeState.guardKey === state.transientWorkspaceLeaveAcknowledgement
  ) {
    if (allowNextUnload) state.transientWorkspaceAllowNextUnload = true;
    return true;
  }
  const confirmed = await openConsoleModal({
    title: activeState.title,
    message: activeState.message,
    confirmText: activeState.confirmText || "继续",
    cancelText: activeState.cancelText || "取消",
    danger: Boolean(activeState.danger),
  });
  if (!confirmed) return false;
  if (typeof activeState.clear === "function") {
    activeState.clear();
    const remainingState = activeState.acknowledgeRemainingState
      ? activeTransientWorkspaceState()
      : null;
    state.transientWorkspaceLeaveAcknowledgement = remainingState?.guardKey || "";
  } else if (activeState.guardKey) {
    state.transientWorkspaceLeaveAcknowledgement = activeState.guardKey;
  }
  if (allowNextUnload) state.transientWorkspaceAllowNextUnload = true;
  return true;
}

function selectGeneratedPreviewPost(postId) {
  const persona = selectedPersona();
  const cleanPostId = String(postId || "").trim();
  if (!persona || !cleanPostId) return;
  setPersonaPostSource("posts", persona);
  setSelectedPersonaPostId(cleanPostId);
  renderPersonaDetail();
  renderConfirmSummary();
}

function renderPersonaDetail() {
  const scrollSnapshot = snapshotConsoleScrollState();
  const layoutLocks = captureConsoleLayoutLocks();
  try {
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
  if (!state.personaFavoritePosts[String(persona.id)]) loadPersonaFavoritePosts(persona.id).catch(() => {});
  const groupKey = normalizedPersonaGroupKey(state.activeModule === "tweet_generation" ? "content" : (state.personaGroup || personaModuleDefaultGroup()));
  state.personaGroup = groupKey;
  const step = currentPersonaGroupStep(groupKey, profile);
  if (groupKey === "content" && step === "generate" && !Array.isArray(state.personaMemories[String(persona.id)])) {
    loadPersonaMemories(persona.id).catch(() => {});
  }
  if (groupKey === "settings" && step === "profile" && personaProfileMode(persona.id) === "edit" && !personaImageLibraryState(persona.id)) {
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
  const account = accountForPersona(persona);
  const drafts = personaDraftPosts(persona);
  const favorites = personaFavoritePosts(persona);
  const personaId = String(persona.id || "");
  const draftCount = Array.isArray(state.personaDraftPosts[personaId]) ? drafts.length : personaOverviewDraftCount(persona);
  const favoriteCount = Array.isArray(state.personaFavoritePosts[personaId]) ? favorites.length : personaOverviewFavoriteCount(persona);
  const groupPanel = renderPersonaGroupPanel(groupKey, step, persona, account, profile);
  const canDelete = Boolean(profile);
  $("personaDetail").innerHTML = `
    <div class="persona-inline-panel is-flat">
      <div class="persona-workbench-head">
        <div class="persona-summary-meta">
          <strong>${esc(persona.name || "未命名人设")}</strong>
          <span>${esc(`类型：${personaKindLabel(persona, profile)}`)}</span>
          ${renderPersonaExecutionAccountBadge(persona)}
          <span>${esc(`草稿 ${draftCount} 条`)}</span>
          <span>${esc(`收藏 ${favoriteCount} 条`)}</span>
        </div>
        <div class="persona-quick-actions">
          ${canDelete ? `<button type="button" class="danger" data-persona-delete>删除当前人设</button>` : ""}
        </div>
      </div>
      ${showPersonaGroupTabs() ? renderPersonaGroupTabs(profile) : ""}
    </div>
    <div class="persona-step-shell">
      ${renderPersonaStepTabs(groupKey, profile)}
      ${groupPanel}
    </div>
    ${renderPersonaGeneratePreviewDock(persona)}
  `;
  state.renderedPersonaId = String(persona.id || "");
  } finally {
    restoreConsoleScrollState(scrollSnapshot);
    releaseConsoleLayoutLocks(layoutLocks);
  }
}

function renderPersonaContentPanel(persona, account, profile, step) {
  const panel = step || "overview";
  const drafts = personaDraftPosts(persona);
  const favorites = personaFavoritePosts(persona);
  const postSource = personaPostSource(persona);
  const sourceRows = personaSourcePosts(persona, postSource);
  const memoryRows = personaMemoryRows(persona);
  const publishResult = state.personaPublishResults[String(persona.id)] || "";
  const form = personaFormState(persona.id);
  const generateForm = form.generate;
  const draftForm = form.draft;
  const isWorkflowPersona = false;
  const showTimeSlot = false;
  const generateMode = ["custom", "hot"].includes(String(generateForm.mode || "").trim()) ? String(generateForm.mode || "").trim() : "ai";
  const isEditingDraft = Boolean(String(draftForm.editingPostId || "").trim());
  const editingSource = draftForm.editingSource === "favorites" ? "favorites" : "posts";
  const editingRows = personaSourcePosts(persona, editingSource);
  const editingDraft = isEditingDraft ? editingRows.find((post) => String(post.id) === String(draftForm.editingPostId || "").trim()) || null : null;
  const editingHotMeta = editingDraft ? personaHotImportMeta(persona.id, editingDraft.id) : null;
  const editingDirty = isEditingDraft && syncPersonaDraftDirty(draftForm);
  const isRewriteMode = isEditingDraft && generateMode === "ai";
  const preflight = personaGeneratePreflight();
  const hiddenHistoryCount = personaHiddenPublishHistoryCount(persona);
  const hiddenHistoryHint = hiddenHistoryCount > 0 ? ` 当前另有 ${hiddenHistoryCount} 条登录或预检记录，未计入发布历史。` : "";
  const generateDefaults = personaGenerateDefaults();
  const editingSourceLabel = editingSource === "favorites" ? "收藏" : "草稿";
  const generateTitle = generateMode === "hot" ? "新建推文" : (isEditingDraft ? `编辑${editingSourceLabel}` : "新建推文");
  const canComposeMedia = generateMode !== "hot";
  const composeModeValue = String(generateForm.composeMode || "tweet");
  const composeMode = canComposeMedia && ["tweet_media", "custom"].includes(composeModeValue) ? composeModeValue : "tweet";
  const currentGenerateCount = Math.min(Math.max(Number(generateForm.count || generateDefaults.count), 1), 20);
  generateForm.count = currentGenerateCount;
  generateForm.targetWords = Math.min(Math.max(Number(generateForm.targetWords || generateDefaults.targetWords), 10), 2000);
  const selectedPostBase = selectedPersonaPost(persona, { requireExplicit: panel === "generate" && ["tweet_media", "custom"].includes(composeMode) });
  const selectedPost = isEditingDraft ? editingDraft : selectedPostBase;
  const selectedSourceLabel = (isEditingDraft ? editingSource : postSource) === "favorites" ? "收藏" : "草稿";
  const selectedPostMediaItems = selectedPost ? personaDraftMediaPreviewItems(persona, postSource, selectedPost) : [];
  const generateIntro = generateMode === "hot"
    ? ""
    : (isEditingDraft
      ? `这里处理当前${editingSourceLabel}的正文修改。媒体、移出和 AI 重写都从这里进入，不再堆在列表里。`
      : `这里处理推文内容。已识别 ${memoryRows.length} 条可选记忆。`);
  const generateBusy = isActionLocked("persona", persona.id, "generate_posts");
  const hotImportBusy = isActionLocked("persona", persona.id, "hot_import");

  if (panel === "generate") {
    return `
      <div class="persona-inline-panel persona-generate-panel ${isEditingDraft ? "is-editing-draft" : ""} ${editingDirty ? "is-dirty" : ""}">
        ${isEditingDraft ? `
          <div class="persona-temp-edit-toolbar persona-temp-edit-toolbar--hint">
            <span>临时编辑中：修改草稿内容后保存，或清空、退出当前编辑。</span>
          </div>
        ` : ""}
        <div class="persona-head-copy persona-head-copy--split">
          <div class="persona-head-copy-main">
            <strong>${esc(generateTitle)}</strong>
            ${generateIntro ? `<span class="persona-panel-intro">${esc(generateIntro)}</span>` : ""}
          </div>
        </div>
        <div class="persona-compose-workspace ${canComposeMedia ? "has-media" : ""}">
          <section class="persona-compose-post-side persona-production-section ${isEditingDraft ? "is-editing-draft" : ""} ${editingDirty ? "is-dirty" : ""}">
            <div class="persona-production-step-head">
              <span>第1步</span>
              <div class="persona-production-step-title">
                <strong>生成推文</strong>
                ${isEditingDraft ? `
                  <div class="persona-temp-edit-actions persona-temp-edit-actions--inline">
                    <button type="button" data-persona-clear-draft-edit>清空</button>
                    <button type="button" data-persona-exit-draft-edit>退出编辑</button>
                  </div>
                ` : ""}
              </div>
              <p>先生成或录入推文正文，保存后可进入右侧配图步骤。</p>
            </div>
            ${canComposeMedia ? renderPersonaGenerateComposeTabs(composeMode) : ""}
            ${composeMode === "custom" ? "" : renderPersonaGenerateModeTabs(generateMode, { isEditingDraft })}
            ${composeMode !== "custom" && generateMode === "ai" ? `
              <div class="persona-generate-current-settings">
                <label>本次生成数量
                  <input id="personaGenerateCount" type="number" min="1" max="20" step="1" value="${esc(currentGenerateCount)}" />
                </label>
                <label>目标字数
                  <input id="personaGenerateTargetWords" type="number" min="10" max="2000" step="10" value="${esc(generateForm.targetWords)}" />
                </label>
              </div>
            ` : ""}
        ${composeMode === "custom" || generateMode === "custom" ? `
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
              <button type="button" class="danger" data-persona-delete-post="${esc(draftForm.editingPostId)}">${editingSource === "favorites" ? "移出收藏" : "删除草稿"}</button>
            ` : `
              <button type="button" data-persona-route-step="content:posts">查看草稿</button>
            `}
          </div>
        ` : generateMode === "hot" ? `
          ${renderPersonaHotCandidatePicker(persona, generateForm)}
          ${personaHotCandidates(persona).length ? `<div class="row-actions">
            <button type="button" class="primary" data-persona-import-hot-drafts ${personaHotSelectedCandidates(persona).length && !hotImportBusy ? "" : "disabled"}>${hotImportBusy ? renderBusyButtonContent("正在导入热点", true, actionLockStartedAt("persona", persona.id, "hot_import")) : "导入到当前人设草稿库"}</button>
            <button type="button" data-persona-route-step="content:posts">查看草稿</button>
          </div>` : ""}
        ` : `
          <label>${isRewriteMode ? "重写参考内容" : "本次提示词"}
            <textarea id="personaGeneratePrompt" rows="5" placeholder="${esc(isRewriteMode ? "这里会带入当前正在编辑的推文正文，可继续补充重写要求。" : "留空则按当前人设自由生成。")}">${esc(generateForm.prompt || "")}</textarea>
          </label>
          ${!preflight.ready ? `<div class="persona-warning-inline">${esc(preflight.issues.join(" / "))}，请先补齐配置。</div>` : ""}
          <label>可选人设记忆（已识别 ${esc(memoryRows.length)} 条）</label>
          ${renderPersonaMemoryOptions(persona, generateForm.selectedMemoryIds || [])}
          <div class="row-actions">
            <button type="button" class="primary" data-persona-generate-posts ${preflight.ready && !generateBusy ? "" : "disabled"}>${generateBusy ? renderBusyButtonContent(isRewriteMode ? "正在重写推文" : "正在生成草稿", true, actionLockStartedAt("persona", persona.id, "generate_posts")) : (isRewriteMode ? "AI 重写推文" : "自动生成草稿")}</button>
            ${isRewriteMode ? "" : `<button type="button" data-persona-route-step="content:posts">查看草稿</button>`}
          </div>
        `}
          </section>
          ${canComposeMedia ? (["tweet_media", "custom"].includes(composeMode)
            ? renderPersonaInlineMediaComposer(persona, profile, generateForm, form.media, selectedPost, selectedPostMediaItems, selectedSourceLabel, postSource === "favorites")
            : renderPersonaMediaComposerPlaceholder()) : ""}
        </div>
      </div>`;
  }

  if (panel === "media") {
    const mediaForm = form.media;
    const post = selectedPost;
    const mediaRows = sourceRows;
    const isFavoriteMedia = postSource === "favorites";
    const sourceLabel = isFavoriteMedia ? "收藏" : "草稿";
    const postMediaItems = post ? personaDraftMediaPreviewItems(persona, isFavoriteMedia ? "favorites" : "posts", post) : [];
    const mediaTaskOptions = personaMediaTaskOptions(profile, generateForm);
    const currentTaskType = mediaTaskOptions.some(([value]) => value === String(mediaForm.taskType || ""))
      ? String(mediaForm.taskType || "")
      : String(mediaTaskOptions[0]?.[0] || "persona_post_image");
    mediaForm.taskType = currentTaskType;
    mediaForm.contentMode = String(mediaForm.contentMode || "draft") === "manual" ? "manual" : "draft";
    mediaForm.imageCount = Math.min(Math.max(Number(mediaForm.imageCount || state.personaMediaImageCountDefault || 1), 1), 8);
    const mediaMeta = taskMeta[currentTaskType] || taskMeta.persona_post_image || taskMeta.text_to_image;
    const showAspectRatio = currentTaskType === "persona_post_image";
    const showVideoOptions = false;
    const uploadAccept = "image/*";
    const showSourceUpload = Number(mediaMeta.minImages || 0) > 0;
    const mediaBusy = post && (isActionLocked("media_task", persona.id, post.id, currentTaskType) || personaMediaTaskIsActive(persona.id, post.id, currentTaskType));
    const mediaBusyStartedAt = post ? personaMediaTaskStartedAt(persona.id, post.id, currentTaskType) : 0;
    return `
      <div class="persona-inline-panel">
        <div class="persona-head-copy">
          <strong>推文配图 / 媒体</strong>
        </div>
        <div class="persona-draft-toolbar">
          <label>当前${sourceLabel}
            <select id="personaDraftPostSelect">
              ${mediaRows.length ? mediaRows.map((post, index) => `<option value="${esc(post.id)}" ${String(post.id) === String(state.selectedPersonaPostId || mediaRows[0]?.id || "") ? "selected" : ""}>${esc(personaDraftOptionLabel(post, index))}</option>`).join("") : `<option value="">当前还没有${sourceLabel}</option>`}
            </select>
          </label>
          <div class="row-actions">
            <button type="button" data-persona-route-step="content:generate">返回新建推文</button>
            <button type="button" data-persona-route-step="content:posts">查看列表</button>
          </div>
        </div>
        ${post ? `
          <div class="persona-media-workspace">
            <section class="persona-media-column">
              <div class="persona-inline-panel persona-inline-panel--nested">
                <strong>当前${sourceLabel}正文</strong>
                ${renderPersonaHotOrigin(personaHotImportMeta(persona.id, post.id), { compact: true })}
                <p>${esc(String(post.content || "").trim() || `当前${sourceLabel}没有正文。`)}</p>
              </div>
              <div class="persona-inline-panel persona-inline-panel--nested">
                <strong>媒体编辑</strong>
                <div class="persona-media-edit-split">
                  <div class="persona-media-edit-pane persona-media-edit-pane--list">
                    <strong>当前媒体</strong>
                    ${renderPersonaEditableMediaGrid(postMediaItems, { personaId: persona.id, source: isFavoriteMedia ? "favorites" : "posts", postId: post.id })}
                  </div>
                  <div class="persona-media-edit-pane persona-media-edit-pane--upload">
                    ${renderUploadDropzone("personaPostMediaUploadFiles", { label: "上传媒体", hint: `拖动图片或视频到这里，或点击选择。可追加到${sourceLabel}；选中左侧缩略图可替换。` })}
                    <div class="row-actions persona-media-upload-actions">
                      <button type="button" class="primary" data-persona-upload-post-media="append">追加</button>
                      ${postMediaItems.length ? `<button type="button" data-persona-replace-post-media="${esc(selectedPersonaMediaIndex(persona.id, isFavoriteMedia ? "favorites" : "posts", post.id, postMediaItems.length))}">替换</button>` : ""}
                      ${postMediaItems.length ? `<button type="button" class="danger" data-persona-delete-post-media="${esc(selectedPersonaMediaIndex(persona.id, isFavoriteMedia ? "favorites" : "posts", post.id, postMediaItems.length))}">删除</button>` : ""}
                    </div>
                  </div>
                </div>
              </div>
            </section>
            <section class="persona-media-column">
              ${isFavoriteMedia ? `
              <div class="persona-inline-panel persona-inline-panel--nested">
                <strong>收藏媒体</strong>
                <span class="persona-panel-intro">收藏内容支持上传、替换和删除媒体；生成新的配图请先复制为草稿后处理。</span>
              </div>
              ` : `
              <div class="persona-inline-panel persona-inline-panel--nested">
                <strong>生成媒体</strong>
                ${renderPersonaMediaContentModeTabs(mediaForm.contentMode)}
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
                ${mediaForm.contentMode === "manual" ? `<label>手动生成内容
                  <textarea id="personaMediaManualContent" rows="5" placeholder="输入要用于生成配图的内容。">${esc(mediaForm.manualContent || "")}</textarea>
                </label>` : ""}
                ${mediaForm.contentMode === "manual" ? "" : `<label>补充提示词
                  <textarea id="personaMediaTaskPrompt" rows="5" placeholder="可留空；补充图文生成要求。">${esc(mediaForm.prompt || "")}</textarea>
                </label>`}
                ${showSourceUpload ? renderUploadDropzone("personaMediaTaskFiles", {
                  label: "上传素材",
                  accept: uploadAccept,
                  hint: mediaMeta.files || "拖动任务需要的素材到这里，或点击选择。",
                }) : ""}
                <div class="row-actions">
                  <button type="button" class="primary" data-persona-run-media-task aria-busy="${mediaBusy ? "true" : "false"}" ${mediaBusy ? "disabled" : ""}>${mediaBusy ? renderBusyButtonContent("配图任务执行中", true, mediaBusyStartedAt) : "生成预览"}</button>
                </div>
              </div>
              <div class="persona-inline-panel persona-inline-panel--nested">
                <strong>任务结果预览</strong>
                ${renderPersonaMediaTaskResult(persona.id, post.id)}
              </div>
              `}
            </section>
          </div>
        ` : `<div class="empty-state">当前还没有${sourceLabel}。先选择内容，再回来处理媒体。</div>`}
      </div>`;
  }

  if (panel === "posts") {
    const draftViewMode = personaDraftViewMode(persona.id);
    const postPageInfo = personaPostPageInfo(persona, postSource, sourceRows);
    if (!state.personaFavoritePosts[String(persona.id)]) loadPersonaFavoritePosts(persona.id).catch(() => {});
    return `
      <div class="persona-inline-panel">
        <div class="persona-head-copy">
          <strong>${postSource === "favorites" ? "收藏推文" : "草稿库"}</strong>
          <span class="persona-panel-intro">${esc(`这里集中查看并选择待发布内容。当前草稿 ${drafts.length} 条，收藏 ${favorites.length} 条。`)}</span>
        </div>
        <div class="persona-source-toggle" aria-label="内容来源">
          <button type="button" class="${postSource === "posts" ? "is-active" : ""}" data-persona-post-source="posts">草稿</button>
          <button type="button" class="${postSource === "favorites" ? "is-active" : ""}" data-persona-post-source="favorites">收藏</button>
        </div>
        <div class="persona-draft-toolbar">
          <label>${postSource === "favorites" ? "收藏快速选择" : "草稿快速选择"}
            <select id="personaDraftPostSelect">
              ${sourceRows.length ? sourceRows.map((post, index) => `<option value="${esc(post.id)}" ${String(post.id) === String(state.selectedPersonaPostId || sourceRows[0]?.id || "") ? "selected" : ""}>${esc(personaDraftOptionLabel(post, index))}</option>`).join("") : `<option value="">${postSource === "favorites" ? "当前还没有收藏" : "当前还没有草稿"}</option>`}
            </select>
          </label>
          ${sourceRows.length ? renderPersonaPostBulkActions(persona, postSource, sourceRows) : ""}
          <div class="row-actions">
            <button type="button" data-persona-open-new-draft ${personaDraftEditState(persona.id).editing ? "disabled" : ""}>新建草稿</button>
            ${selectedPost ? `<button type="button" data-persona-edit-post="${esc(selectedPost.id)}">编辑</button>` : ""}
            ${selectedPost ? `<button type="button" class="primary" data-persona-open-publishing ${dailyPublishActionAttrs()}>进入发布</button>` : ""}
            ${renderPersonaDraftViewToggle(draftViewMode)}
          </div>
        </div>
        ${renderPersonaDraftRows(postPageInfo.items, postSource, sourceRows)}
        ${renderPersonaPostPager(postPageInfo, postSource)}
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
    const publishAccounts = publishPlatformAccountsForPersona(persona);
    const publishAccount = selectedPublishAccountForPersona(persona);
    const publishHint = publishPlatformHint(publishAccount);
    const publishSource = personaPostSource(persona);
    const publishSourceLabel = publishSource === "favorites" ? "收藏推文" : "草稿";
    const publishCanSubmit = canSubmitPublishWithAccount(publishAccount);
    const publishTask = publishCanSubmit && selectedPost
      ? activeSocialTaskFor({ accountId: publishAccount.id, personaId: persona.id, taskType: "publish_post", postId: selectedPost.id, postSource: publishSource })
      : null;
    const publishBusy = publishCanSubmit && selectedPost
      ? (isActionLocked("publish", publishSource, persona.id, selectedPost.id, publishAccount.id) || publishTask)
      : false;
    const publishWaitsForManualLogin = Boolean(publishTask && socialTaskWaitsForManualLogin(publishTask));
    const publishBusyStartedAt = actionTaskStartedAt(publishTask, "publish", publishSource, persona.id, selectedPost?.id || "", publishAccount?.id || "");
    const publishScheduleAt = String(state.personaPublishScheduleValues[String(persona.id)] || "");
    return `
      <div class="persona-inline-panel persona-publish-panel">
        <div class="persona-head-copy">
          <strong>发布前检查</strong>
          <span class="persona-panel-intro">${esc(publishAccount ? (isReadyPublishAccount(publishAccount) ? `${publishPlatformLabel(publishAccount)} · ${publishHint}` : publishAccountBlockMessage(publishAccount)) : "当前人设还没有绑定 Threads 或 Instagram 执行账号。请到账号管理自动化绑定账号后再发布。")}</span>
        </div>
        ${renderPersonaPublishPreflight(publishAccount)}
        <div class="form-grid persona-detail-controls">
          <label class="account-field">
            ${renderAccountFieldHead("发布账号", publishAccount)}
            <select id="personaPublishAccountSelect" ${publishAccounts.length ? "" : "disabled"}>
              ${publishAccounts.length ? publishAccounts.map((entry) => `<option value="${esc(entry.id)}" ${String(entry.id) === String(publishAccount?.id || "") ? "selected" : ""}>${esc(accountDisplayName(entry))}</option>`).join("") : `<option value="">当前没有可发布账号</option>`}
            </select>
          </label>
          <label>发布${publishSourceLabel}
            <select id="personaDraftPostSelect" ${sourceRows.length ? "" : "disabled"}>
              ${sourceRows.length ? sourceRows.map((post, index) => `<option value="${esc(post.id)}" ${String(post.id) === String(state.selectedPersonaPostId || sourceRows[0]?.id || "") ? "selected" : ""}>${esc(personaDraftOptionLabel(post, index))}</option>`).join("") : `<option value="">当前还没有可发布内容</option>`}
            </select>
          </label>
          <label>发布时间
            <input id="personaPublishScheduleAt" value="${esc(publishScheduleAt)}" placeholder="留空立即发布 / 2026-07-04 21:30" />
          </label>
        </div>
        ${personaPublishPreview(selectedPost)}
        ${renderUploadDropzone("personaPublishFiles", { label: "发布素材", hint: publishHint || "拖动图片或视频到这里，或点击选择。" })}
        <div class="row-actions">
          <button type="button" class="primary" data-persona-publish-submit ${dailyPublishActionAttrs()} ${(publishCanSubmit && selectedPost && !publishBusy) ? "" : "disabled"}>${dailyPublishIsLocked() ? "今日发布已锁定" : (publishWaitsForManualLogin ? "等待人工验证" : (publishBusy ? renderBusyButtonContent("发布任务执行中", true, publishBusyStartedAt) : "发布内容"))}</button>
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
  const [data, socialTasksData] = await Promise.all([
    api("/api/tasks"),
    loadAutomationTasksShared(),
  ]);
  state.tasks = Array.isArray(data.items) ? data.items : (Array.isArray(data.tasks) ? data.tasks : []);
  state.socialTasks = Array.isArray(socialTasksData.tasks) ? socialTasksData.tasks : (Array.isArray(state.socialTasks) ? state.socialTasks : []);
  const host = $("taskTable");
  host.innerHTML = renderTaskQueueView();
}

async function showTaskDetail(id) {
  const task = await api(`/api/tasks/${encodeURIComponent(id)}`);
  const logs = Array.isArray(task.logs) ? task.logs : [];
  await openConsoleModal({
    title: "任务详情",
    contentHtml: renderTaskDetailLayout(task, logs, {
      kind: "regular",
      title: task.workflow_name || task.type || "任务",
      downloadUrl: task.has_download ? `/api/tasks/${encodeURIComponent(task.id || id)}/download` : "",
    }),
    confirmText: "关闭",
    showCancel: false,
  });
}

async function loadSocialOverview() {
  const publishPolicyRequestSeq = beginDailyPublishPolicyRequest();
  const overview = await api("/api/persona_dashboard/automation/overview");
  if (overview?.publish_policy) updateDailyPublishPolicy(overview.publish_policy, { requestSeq: publishPolicyRequestSeq });
  const worker = overview.worker || overview.worker_state || {};
  $("workerState").textContent = worker.running ? "运行中" : (worker.enabled === false ? "已关闭" : "待命");
  $("workerDetail").textContent = worker.last_error || `最近任务：${worker.last_task_id || "-"}`;
  return overview;
}

async function fetchSocialDataShared({ force = false } = {}) {
  if (force) {
    while (state.socialRefreshFetch) {
      await state.socialRefreshFetch.catch(() => {});
    }
  } else if (state.socialRefreshFetch) {
    return state.socialRefreshFetch;
  }
  const request = Promise.all([
    loadSocialOverview().catch(() => ({})),
    api("/api/persona_dashboard/automation/accounts").catch((error) => ({ accounts: tenantArrayFallback(error, state.socialAccounts) })),
    api("/api/persona_dashboard/automation/proxies").catch((error) => ({ proxies: tenantArrayFallback(error, state.socialProxies) })),
    loadAutomationTasksShared({ force }).catch((error) => ({ tasks: tenantArrayFallback(error, state.socialTasks) })),
  ]).then(([overview, accountsData, proxiesData, tasksData]) => {
    state.socialBrowserSessions = Array.isArray(overview.browser_sessions) ? overview.browser_sessions : tenantArrayFallback(null, state.socialBrowserSessions);
    state.socialAccounts = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];
    state.socialProxies = Array.isArray(proxiesData.proxies)
      ? proxiesData.proxies
      : (Array.isArray(overview.proxies) ? overview.proxies : tenantArrayFallback(null, state.socialProxies));
    state.socialTasks = Array.isArray(tasksData.tasks) ? tasksData.tasks : [];
    saveSocialAccountsSnapshot();
    return overview;
  }).finally(() => {
    if (state.socialRefreshFetch === request) state.socialRefreshFetch = null;
  });
  state.socialRefreshFetch = request;
  return request;
}

async function loadSocial({ render = true, force = false } = {}) {
  const overview = await fetchSocialDataShared({ force });
  if (render) {
    clearAccountPasswordRevealState();
    renderSocialAccounts();
    renderSocialTasks();
    syncStandaloneSocialForm();
    if (isPersonaWorkspaceModule()) renderPersonaModule();
    if (state.activeModule && ["publishing", "automation"].includes(state.activeModule)) renderSimpleFlowModule(state.activeModule);
  } else {
    syncStandaloneSocialForm();
  }
  syncAccountStatusAutoRefresh();
  return overview;
}

async function refreshSocialAccountsOnly({ force = false, includeOverview = false } = {}) {
  if (includeOverview) {
    await fetchSocialDataShared({ force });
  } else {
    const accountsData = await api("/api/persona_dashboard/automation/accounts")
      .catch((error) => ({ accounts: tenantArrayFallback(error, state.socialAccounts) }));
    state.socialAccounts = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];
    saveSocialAccountsSnapshot();
  }
  updateAccountStatusViews();
  if (includeOverview) renderLiveBrowserSessions();
}

async function refreshLiveBrowserSessionsOnly() {
  if (state.liveBrowserSessionsFetch) return state.liveBrowserSessionsFetch;
  const request = api("/api/persona_dashboard/automation/browser_sessions")
    .then((data) => {
      state.socialBrowserSessions = Array.isArray(data?.sessions) ? data.sessions : [];
      renderLiveBrowserSessions();
      return state.socialBrowserSessions;
    })
    .finally(() => {
      if (state.liveBrowserSessionsFetch === request) state.liveBrowserSessionsFetch = null;
    });
  state.liveBrowserSessionsFetch = request;
  return request;
}

function refreshLiveBrowserSessionsSoon(taskId = "", attempts = 16, delayMs = 500) {
  const token = `${Date.now()}:${Math.random()}`;
  const targetTaskId = String(taskId || "").trim();
  const refreshKey = targetTaskId || "__all__";
  state.liveBrowserRefreshTokens ||= {};
  state.liveBrowserRefreshTokens[refreshKey] = token;
  let observedTarget = Boolean(targetTaskId && (state.socialBrowserSessions || [])
    .some((session) => String(session?.task_id || "") === targetTaskId));
  const isCurrent = () => state.liveBrowserRefreshTokens?.[refreshKey] === token;
  const finish = () => {
    if (isCurrent()) delete state.liveBrowserRefreshTokens[refreshKey];
  };
  const run = async (attempt) => {
    if (!isCurrent()) return;
    await refreshLiveBrowserSessionsOnly().catch(() => {});
    const sessions = Array.isArray(state.socialBrowserSessions) ? state.socialBrowserSessions : [];
    const matched = targetTaskId
      ? sessions.find((session) => String(session.task_id || "") === targetTaskId)
      : sessions[0];
    if (matched) observedTarget = true;
    const found = !targetTaskId || Boolean(matched);
    const takeoverPending = Boolean(matched) && liveBrowserLoginMode(matched) === "switching";
    const targetTask = targetTaskId
      ? (state.socialTasks || []).find((task) => String(task?.id || "") === targetTaskId)
      : null;
    const taskFinished = Boolean(targetTask)
      && !["queued", "running", "need_manual"].includes(String(targetTask?.status || "").trim());
    if (!isCurrent()) return;
    if (targetTaskId && !matched && (observedTarget || taskFinished)) {
      finish();
      return;
    }
    if (found && !takeoverPending) {
      finish();
      return;
    }
    if (attempt >= attempts && takeoverPending) {
      if (takeoverPending) {
        matched.login_mode = "takeover_timeout";
        matched.input_allowed = false;
        renderLiveBrowserSessions();
        showMsg("socialMsg", "自动登录未能及时停止，请重试人工接管或停止进程。", false);
      }
      finish();
      return;
    }
    if (attempt >= attempts && !observedTarget) {
      finish();
      return;
    }
    window.setTimeout(() => run(attempt + 1), delayMs);
  };
  window.setTimeout(() => run(1), 250);
}

function openLiveBrowserTaskView(taskId = "") {
  const cleanTaskId = String(taskId || "").trim();
  state.accountBrowserPanel = "browsers";
  setView("accounts");
  setAccountBrowserPanel("browsers");
  refreshLiveBrowserSessionsSoon(cleanTaskId);
}

function updateAccountStatusViews() {
  const accountById = new Map((state.socialAccounts || []).map((account) => [String(account.id || ""), account]));
  document.querySelectorAll("[data-account-status-for]").forEach((node) => {
    const account = accountById.get(String(node.dataset.accountStatusFor || ""));
    const status = String(account?.status || "unknown").trim();
    node.className = node.classList.contains("status")
      ? `status ${accountStatusClassNames(status)}`
      : `task-status-text is-${statusTone(status)} account-status-chip`;
    const label = accountLastLoginCheckLabel(account);
    node.textContent = label;
    node.title = label;
  });
  ["simpleAccount", "socialAccount", "personaAutoAccount", "personaPublishAccountSelect"].forEach((id) => {
    const select = $(id);
    if (!select) return;
    Array.from(select.options || []).forEach((option) => {
      const account = accountById.get(String(option.value || ""));
      if (account) option.textContent = accountDisplayName(account);
    });
  });
  document.querySelectorAll("[data-account-proxy-for]").forEach((node) => {
    const account = accountById.get(String(node.dataset.accountProxyFor || ""));
    if (account) node.textContent = accountResidentialProxyLabel(account);
  });
  document.querySelectorAll("[data-account-proxy-picker]").forEach((button) => {
    const account = accountById.get(String(button.dataset.accountProxyPicker || ""));
    if (account) button.textContent = String(account.proxy_id || "").trim() ? "切换代理" : "选择代理";
  });
  document.querySelectorAll("[data-account-totp-for]").forEach((node) => {
    const account = accountById.get(String(node.dataset.accountTotpFor || ""));
    if (account) updateAccountTotpBadgeNode(node, account);
  });
}

const accountPoolPlatforms = [
  ["threads", "Threads"],
  ["instagram", "Instagram"],
];

function normalizeAccountPoolPlatform(platform = state.accountPoolPlatform) {
  const value = String(platform || "").trim().toLowerCase();
  return accountPoolPlatforms.some(([id]) => id === value) ? value : "threads";
}

function accountPoolAccounts(platform = state.accountPoolPlatform) {
  const cleanPlatform = normalizeAccountPoolPlatform(platform);
  return (state.socialAccounts || [])
    .filter((account) => String(account.platform || "").trim().toLowerCase() === cleanPlatform)
    .sort((a, b) => Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0));
}

function selectedAccountPoolAccount() {
  const accounts = accountPoolAccounts();
  if (!accounts.length) {
    state.accountPoolAccountId = "";
    state.accountPoolSelectedAccountIds = [];
    return null;
  }
  const selectedIds = new Set(accountPoolSelectedIds());
  if (!selectedIds.size) {
    state.accountPoolAccountId = "";
    return null;
  }
  const current = accounts.find((account) =>
    selectedIds.has(String(account.id || "")) && String(account.id || "") === String(state.accountPoolAccountId || "")
  );
  const account = current || accounts.find((item) => selectedIds.has(String(item.id || ""))) || null;
  state.accountPoolAccountId = account ? String(account.id || "") : "";
  return account;
}

function accountPoolSelectedIds() {
  const available = new Set(accountPoolAccounts().map((account) => String(account.id || "")));
  const selected = (Array.isArray(state.accountPoolSelectedAccountIds) ? state.accountPoolSelectedAccountIds : [])
    .map((id) => String(id || "").trim())
    .filter((id, index, list) => id && available.has(id) && list.indexOf(id) === index);
  state.accountPoolSelectedAccountIds = selected;
  return selected;
}

function selectedAccountPoolAccounts() {
  const selectedIds = new Set(accountPoolSelectedIds());
  return accountPoolAccounts().filter((account) => selectedIds.has(String(account.id || "")));
}

function toggleAccountPoolAccount(accountId = "") {
  const cleanId = String(accountId || "").trim();
  if (!cleanId) return;
  const selected = new Set(accountPoolSelectedIds());
  if (selected.has(cleanId)) selected.delete(cleanId);
  else selected.add(cleanId);
  state.accountPoolSelectedAccountIds = Array.from(selected);
  state.accountPoolAccountId = cleanId;
  const account = accountPoolAccounts().find((item) => String(item.id || "") === cleanId);
  setAccountPoolAutomationContext(account);
}

function selectAccountPoolAccount(accountId = "") {
  const cleanId = String(accountId || "").trim();
  if (!cleanId) return;
  const account = accountPoolAccounts().find((item) => String(item.id || "") === cleanId);
  if (!account) return;
  state.accountPoolAccountId = cleanId;
  state.accountPoolSelectedAccountIds = [cleanId];
  setAccountPoolAutomationContext(account);
}

function clearAccountPoolAccountSelection() {
  state.accountPoolAccountId = "";
  state.accountPoolSelectedAccountIds = [];
}

function clearAccountPoolPersonaSelection() {
  state.accountPoolPersonaId = "";
}

function selectAccountPoolPersona(personaId = "") {
  const cleanId = String(personaId || "").trim();
  if (!cleanId) return;
  state.accountPoolPersonaId = cleanId;
  renderSocialAccounts();
}

function renderAccountPoolPlatformTabs() {
  const active = normalizeAccountPoolPlatform();
  return `
    <section class="account-pool-platform-panel">
      <div class="account-pool-section-head">
        <strong>平台</strong>
        <span>先选平台</span>
      </div>
      <div class="account-pool-platforms" aria-label="平台">
        ${accountPoolPlatforms.map(([value, label]) => {
          const count = accountPoolAccounts(value).length;
          return `<button type="button" class="${active === value ? "is-active" : ""}" data-account-pool-platform="${esc(value)}">
            <strong>${esc(label)}</strong>
            <span>${esc(`${count} 个账号`)}</span>
          </button>`;
        }).join("")}
      </div>
    </section>`;
}

function accountById(accountId = "") {
  const cleanId = String(accountId || "").trim();
  if (!cleanId) return null;
  return state.socialAccounts.find((item) => String(item.id || "") === cleanId)
    || accountPoolAccounts().find((item) => String(item.id || "") === cleanId)
    || null;
}

function accountPasswordMask(account) {
  return account?.login_password_configured ? "••••••••" : "未设置";
}

function accountPasswordStateKey(accountId = "", scope = "pool") {
  return `${scope}:${String(accountId || "").trim()}`;
}

function clearAccountPasswordRevealState() {
  state.accountPasswordValues = {};
  state.accountPasswordVisible = {};
}

function clearAccountPasswordReveal(accountId = "", scope = "pool") {
  const cleanId = String(accountId || "").trim();
  if (!cleanId) return;
  delete state.accountPasswordValues[cleanId];
  delete state.accountPasswordVisible[accountPasswordStateKey(cleanId, scope)];
}

function isPersonaAccountEditing(accountId = "") {
  return Boolean(state.personaAccountEditingIds[String(accountId || "").trim()]);
}

function setPersonaAccountEditing(accountId = "", editing = false) {
  const cleanId = String(accountId || "").trim();
  if (!cleanId) return;
  if (editing) state.personaAccountEditingIds[cleanId] = true;
  else delete state.personaAccountEditingIds[cleanId];
}

function renderAccountPasswordField(account, { scope = "persona", inputId = "" } = {}) {
  const accountId = String(account?.id || "");
  const passwordScope = scope || "persona";
  const visibilityKey = accountPasswordStateKey(accountId, passwordScope);
  const revealed = Boolean(state.accountPasswordVisible[visibilityKey]);
  const password = String(state.accountPasswordValues[accountId] || "");
  const buttonLabel = revealed ? "隐藏登录密码" : "显示登录密码";
  const modalClass = passwordScope === "pool-edit" ? " account-password-field--modal" : "";
  return `<label class="persona-account-inline-field persona-account-inline-field--password${modalClass}">
    <span>登录密码</span>
    <span class="account-password-display account-password-display--input" data-account-password-display="${esc(accountId)}" data-account-password-scope="${passwordScope}" data-password-visible="${revealed ? "true" : "false"}">
      <input class="account-inline-password-input" ${inputId ? `id="${esc(inputId)}"` : ""} data-account-password-input ${passwordScope === "persona" ? "data-persona-account-password" : ""} ${passwordScope === "pool-edit" ? "data-account-pool-edit-password" : ""} type="${revealed ? "text" : "password"}" value="${esc(revealed ? password : "")}" placeholder="${esc(accountPasswordMask(account))}" autocomplete="new-password" />
      <button type="button" class="account-password-toggle" data-account-password-toggle="${esc(accountId)}" aria-label="${buttonLabel}" title="${buttonLabel}" aria-pressed="${revealed ? "true" : "false"}">${renderEyeIcon()}</button>
    </span>
  </label>`;
}

async function toggleAccountPasswordVisibility(button) {
  const accountId = String(button?.dataset.accountPasswordToggle || "").trim();
  const account = accountById(accountId);
  if (!account) throw new Error("账号不存在，请刷新后重试。");
  const wrapper = button.closest("[data-account-password-display]");
  const input = wrapper?.querySelector("[data-account-password-input]") || null;
  const scope = String(wrapper?.dataset.accountPasswordScope || (input ? "persona" : "pool"));
  const visibilityKey = accountPasswordStateKey(accountId, scope);
  const wasVisible = button.dataset.passwordVisible === "true" || wrapper?.dataset.passwordVisible === "true";
  const nextVisible = !wasVisible;
  let password = input?.value || String(state.accountPasswordValues[accountId] || "");
  if (nextVisible && !password && account.login_password_configured) {
    const result = await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(accountId)}/credentials`, {
      cache: "no-store",
    });
    password = String(result?.login_password || "");
    if (!password) {
      showMsg(scope === "pool-edit" || scope === "pool" ? "socialMsg" : "commandMsg", "当前账号没有已保存的登录密码。", false);
      return;
    }
    state.accountPasswordValues[accountId] = password;
  }
  state.accountPasswordVisible[visibilityKey] = nextVisible;
  button.dataset.passwordVisible = nextVisible ? "true" : "false";
  button.setAttribute("aria-pressed", nextVisible ? "true" : "false");
  button.setAttribute("aria-label", nextVisible ? "隐藏登录密码" : "显示登录密码");
  button.setAttribute("title", nextVisible ? "隐藏登录密码" : "显示登录密码");
  if (wrapper) wrapper.dataset.passwordVisible = nextVisible ? "true" : "false";
  if (input) {
    if (nextVisible && !input.value && password) input.value = password;
    input.type = nextVisible ? "text" : "password";
    if (!nextVisible && input.dataset.passwordDirty !== "true") {
      input.value = "";
      delete state.accountPasswordValues[accountId];
    }
    return;
  }
  const value = wrapper?.querySelector("strong");
  if (value) value.textContent = nextVisible && password ? password : accountPasswordMask(account);
  if (!nextVisible) delete state.accountPasswordValues[accountId];
}

async function savePersonaAccountCard(accountId = "", button = null) {
  const cleanId = String(accountId || "").trim();
  const card = button?.closest("[data-persona-account-card]");
  if (!cleanId || !card) return false;
  const value = (field) => String(card.querySelector(`[data-persona-account-field="${field}"]`)?.value || "").trim();
  const account = accountById(cleanId);
  const username = String(account?.username || "").trim().replace(/^@+/, "");
  if (!username) throw new Error("请填写账号用户名。");
  const passwordInput = card.querySelector("[data-persona-account-password]");
  const loginPassword = passwordInput?.dataset.passwordDirty === "true" ? String(passwordInput.value || "") : "";
  const payload = {
    login_username: value("login_username") || username,
  };
  if (loginPassword) payload.login_password = loginPassword;
  if (button) button.disabled = true;
  try {
    const result = await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(cleanId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.accountPasswordVisible[accountPasswordStateKey(cleanId, "persona")] = false;
    setPersonaAccountEditing(cleanId, false);
    state.preferredAccountId = String(result?.account?.id || cleanId);
    await loadSocial({ force: true });
    renderSocialAccounts();
    if (isPersonaWorkspaceModule()) renderPersonaDetail();
    showMsg("commandMsg", "账号已保存。", true);
    return true;
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

async function clearPersonaAccountLogin(accountId = "", button = null) {
  const cleanId = String(accountId || "").trim();
  if (!cleanId) return false;
  if (button) button.disabled = true;
  try {
    await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(cleanId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear_login_credentials: true }),
    });
    clearAccountPasswordRevealState();
    await loadSocial({ force: true });
    renderSocialAccounts();
    if (isPersonaWorkspaceModule()) renderPersonaDetail();
    showMsg("commandMsg", "登录资料已清除。", true);
    return true;
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

function renderAccountPoolCard(account, { variant = "pool", active = false, checked = false, persona = null } = {}) {
  const accountId = String(account?.id || "");
  if (variant === "persona-settings") {
    if (!isPersonaAccountEditing(accountId)) {
      return `<article class="account-card account-pool-card persona-account-pool-card persona-account-pool-card--summary ${active ? "is-active" : ""}" data-persona-account-card="${esc(accountId)}" role="button" tabindex="0" aria-pressed="${active ? "true" : "false"}">
        <div class="account-pool-card-main">
          <span class="account-pool-card-copy">
            <strong>${esc(accountDisplayName(account))}</strong>
            <span class="account-pool-card-subline"><small>${esc(platformLabel(account.platform || "threads"))}</small><span class="status ${esc(accountStatusClassNames(account.status))}" data-account-status-for="${esc(accountId)}" title="${esc(accountLastLoginCheckLabel(account))}">${esc(accountLastLoginCheckLabel(account))}</span>${renderAccountTotpBadge(account)}</span>
          </span>
        </div>
        <div class="persona-account-summary-meta" aria-label="账号重要信息">
          ${String(account.login_username || "").trim() && String(account.login_username || "").trim() !== String(account.username || "").trim() ? `<span><small>登录账号</small><strong>${esc(account.login_username)}</strong></span>` : ""}
          <span><small>浏览器环境</small><strong>${esc(account.profile_dir ? "已配置" : "未配置")}</strong></span>
          <span><small>代理 IP</small><strong data-account-proxy-for="${esc(accountId)}">${esc(accountResidentialProxyLabel(account))}</strong></span>
        </div>
        <div class="row-actions persona-account-summary-actions">
          <button type="button" class="primary" data-persona-account-open-login="${esc(accountId)}">打开登录</button>
          <button type="button" data-persona-account-start-edit="${esc(accountId)}">编辑</button>
        </div>
      </article>`;
    }
    return `<article class="account-card account-pool-card persona-account-pool-card persona-account-pool-card--inline-edit ${active ? "is-active" : ""}" data-persona-account-card="${esc(accountId)}" role="button" tabindex="0" aria-pressed="${active ? "true" : "false"}">
      <div class="account-pool-card-main">
        <span class="account-pool-card-copy">
          <strong>${esc(accountDisplayName(account))}</strong>
          <span class="account-pool-card-subline"><small>${esc(platformLabel(account.platform || "threads"))}</small><span class="status ${esc(accountStatusClassNames(account.status))}" data-account-status-for="${esc(accountId)}" title="${esc(accountLastLoginCheckLabel(account))}">${esc(accountLastLoginCheckLabel(account))}</span>${renderAccountTotpBadge(account)}</span>
        </span>
      </div>
      <div class="persona-account-inline-fields" aria-label="账号资料">
        <label class="persona-account-inline-field">
          <span>登录账号</span>
          <input data-persona-account-field="login_username" value="${esc(account.login_username || account.username || "")}" placeholder="登录账号" autocomplete="off" />
        </label>
        ${renderAccountPasswordField(account)}
      </div>
      <div class="row-actions persona-account-inline-actions">
        <button type="button" data-persona-account-save="${esc(accountId)}">保存账号</button>
        <button type="button" data-persona-account-cancel-edit="${esc(accountId)}">取消编辑</button>
        <button type="button" class="danger" data-persona-account-clear-login="${esc(accountId)}" ${account.login_password_configured ? "" : "disabled"}>清除登录资料</button>
      </div>
    </article>`;
  }
  return `<article class="account-card account-pool-card ${active ? "is-active" : ""} ${checked ? "is-checked" : ""}" data-account-pool-account="${esc(accountId)}" role="button" tabindex="0" aria-pressed="${active ? "true" : "false"}">
    <label class="account-pool-card-check" aria-label="多选账号">
      <input type="checkbox" data-account-pool-check="${esc(accountId)}" ${checked ? "checked" : ""} />
      <span aria-hidden="true"></span>
    </label>
    <div class="account-pool-card-main">
      <span class="account-pool-card-copy">
        <strong title="${esc(account.username || accountId)}">${esc(account.username || accountId)}</strong>
        <small>${esc(account.display_name && account.display_name !== account.username ? account.display_name : platformLabel(account.platform || "threads"))}</small>
      </span>
      <span class="account-pool-card-flags">
        <span class="status ${esc(accountStatusClassNames(account.status))}" data-account-status-for="${esc(accountId)}" title="${esc(accountLastLoginCheckLabel(account))}">${esc(accountLastLoginCheckLabel(account))}</span>
        ${renderAccountTotpBadge(account)}
      </span>
    </div>
    <strong class="account-pool-bound-persona ${persona ? "is-bound" : "is-unbound"}" title="${esc(persona ? `已绑定：${persona.name || persona.id}` : "未绑定人设")}">${esc(persona ? `已绑定：${persona.name || persona.id}` : "未绑定人设")}</strong>
    <div class="account-card-meta">
      <span>${esc(account.profile_dir ? "已配置浏览器环境" : "未配置浏览器环境")}</span>
      <span data-account-proxy-for="${esc(accountId)}">${esc(accountResidentialProxyLabel(account))}</span>
    </div>
    <div class="row-actions">
      <button type="button" class="primary" data-social-open-login="${esc(accountId)}">打开登录</button>
      <button type="button" data-account-proxy-picker="${esc(accountId)}">${account?.proxy_id ? "切换代理" : "选择代理"}</button>
      <button type="button" data-account-pool-edit="${esc(accountId)}">编辑</button>
      <button type="button" data-account-pool-unbind="${esc(accountId)}" ${account.persona_id ? "" : "disabled"}>解绑</button>
      <button type="button" class="danger" data-social-delete-account="${esc(accountId)}">删除账号</button>
    </div>
  </article>`;
}

function renderAccountPoolCards(accounts, selectedAccount) {
  const selectedIds = new Set(accountPoolSelectedIds());
  const selectedCount = selectedIds.size;
  const addButton = `<button type="button" class="account-pool-add-button" data-account-pool-add>
    <span aria-hidden="true"></span>
    <strong>添加账号</strong>
  </button>`;
  const editToolbar = `<div class="account-pool-edit-toolbar" role="toolbar" aria-label="账号编辑操作">
    <span class="account-pool-selection-count">${esc(selectedCount ? `已选 ${selectedCount} 个` : "未选择")}</span>
    <button type="button" data-account-pool-copy-selected title="复制账号" aria-label="复制账号" ${selectedCount ? "" : "disabled"}><span aria-hidden="true"></span></button>
    <button type="button" data-account-pool-select-all title="全选账号" aria-label="全选账号" ${accounts.length ? "" : "disabled"}><span aria-hidden="true"></span></button>
    <button type="button" data-account-pool-clear-selected title="取消选择" aria-label="取消选择" ${selectedCount ? "" : "disabled"}><span aria-hidden="true"></span></button>
    <button type="button" class="danger" data-account-pool-delete-selected title="删除账号" aria-label="删除账号" ${selectedCount ? "" : "disabled"}><span aria-hidden="true"></span></button>
    ${addButton}
  </div>`;
  if (!accounts.length) return `
    <section class="account-pool-account-panel">
      <div class="account-pool-section-head">
        <strong>账号</strong>
        ${editToolbar}
      </div>
      <div class="empty-state">当前平台还没有账号。点击添加账号后填写账号信息。</div>
    </section>`;
  return `
    <section class="account-pool-account-panel">
      <div class="account-pool-section-head">
        <strong>账号</strong>
        ${editToolbar}
      </div>
      <div class="account-pool-list">
      ${accounts.map((account) => {
        const accountId = String(account.id || "");
        return renderAccountPoolCard(account, {
          active: String(selectedAccount?.id || state.accountPoolAccountId || "") === accountId,
          checked: selectedIds.has(accountId),
          persona: state.personas.find((item) => String(item.id || "") === String(account.persona_id || "")),
        });
      }).join("")}
      </div>
    </section>`;
}

function accountPoolAutomationMode() {
  const mode = String(state.simpleBranches.account_automation || "reply_comment").trim();
  return ["reply_comment", "reply_hot", "warmup"].includes(mode) ? mode : "reply_comment";
}

function setAccountPoolAutomationContext(account) {
  if (!account) return;
  state.preferredAccountId = String(account.id || "");
  state.personaAutomationPlatform = normalizeAccountPoolPlatform(account.platform || "threads");
  if (account.persona_id) state.selectedPersonaId = String(account.persona_id || "");
}

function buildAccountPoolThreadsTaskPayload(kind) {
  const strategyGroup = kind === "reply_hot"
    ? "threads_hot_reply"
    : kind === "warmup"
      ? "threads_warmup"
      : "threads_comment_reply";
  const strategy = personaThreadsStrategy(strategyGroup);
  const payload = { ...(strategy?.payload || {}) };
  if (kind === "reply_comment" || kind === "reply_hot") {
    if (personaThreadsStrategyIsCustom(strategyGroup)) {
      payload.max_age_days = numberField("accountPoolAutoMaxAgeDays", payload.max_age_days || (kind === "reply_hot" ? 30 : 2));
      payload.max_posts = numberField("accountPoolAutoMaxPosts", payload.max_posts || 5);
      payload.max_replies = numberField("accountPoolAutoMaxReplies", payload.max_replies || 3);
      if (kind === "reply_hot") {
        payload.min_views = numberField("accountPoolAutoMinViews", payload.min_views || 0);
        payload.target_urls = splitLines($("accountPoolAutoTargetUrls")?.value || "");
      }
      const replyTemplates = splitLines($("accountPoolAutoReplyText")?.value || "");
      if (replyTemplates.length) payload.reply_templates = replyTemplates;
    }
    return payload;
  }
  if (personaThreadsStrategyIsCustom(strategyGroup)) {
    payload.browse_limit = numberField("accountPoolAutoBrowseLimit", payload.browse_limit || payload.scroll_times || 30);
    payload.scroll_times = payload.browse_limit;
    payload.like_limit = numberField("accountPoolAutoLikeLimit", payload.like_limit || 0);
    payload.max_comments = numberField("accountPoolAutoMaxComments", payload.max_comments || 0);
    payload.comment_chance = Number(payload.max_comments || 0) > 0 ? 100 : 0;
    const replyTemplates = splitLines($("accountPoolAutoReplyText")?.value || "");
    if (replyTemplates.length) payload.reply_templates = replyTemplates;
  }
  return payload;
}

function renderAccountPoolAutomationPanel(selectedAccount) {
  const mode = accountPoolAutomationMode();
  const steps = [
    ["reply_comment", "自动回复评论"],
    ["reply_hot", "自动回复热点"],
    ["warmup", "养号"],
  ];
  const platform = String(selectedAccount?.platform || normalizeAccountPoolPlatform()).trim().toLowerCase();
  const persona = selectedAccount?.persona_id
    ? state.personas.find((item) => String(item.id || "") === String(selectedAccount.persona_id || ""))
    : null;
  const strategyGroup = mode === "reply_hot"
    ? "threads_hot_reply"
    : mode === "warmup"
      ? "threads_warmup"
      : "threads_comment_reply";
  const strategy = personaThreadsStrategy(strategyGroup);
  const customStrategy = personaThreadsStrategyIsCustom(strategyGroup);
  const payload = strategy?.payload || {};
  const taskType = mode === "warmup" ? "threads_warmup" : "threads_auto_reply";
  const activeTask = selectedAccount?.id ? activeSocialTaskFor({ accountId: selectedAccount.id, taskType }) : null;
  const busy = Boolean(selectedAccount?.id) && (isActionLocked("social", selectedAccount.id, taskType) || activeTask);
  const busyStartedAt = actionTaskStartedAt(activeTask, "social", selectedAccount?.id || "", taskType);
  let body = "";
  if (!selectedAccount) {
    body = `<div class="empty-state">请先在左侧选择一个账号。</div>`;
  } else if (platform !== "threads") {
    body = `<div class="empty-state">自动回复和养号当前只支持 Threads 账号。请切换到 Threads 平台。</div>`;
  } else if (!persona) {
    body = `<div class="empty-state">当前账号还没有绑定人设。请先在右侧人设列表点击绑定。</div>`;
  } else if (mode === "reply_comment" || mode === "reply_hot") {
    body = `
      <div class="automation-operation-card account-pool-automation-card">
        <strong>${mode === "reply_hot" ? "自动回复热点推文" : "自动回复评论"}</strong>
        <p>当前账号：${esc(accountDisplayName(selectedAccount))} · 人设：${esc(persona.name || persona.id)}</p>
        <label>策略
          <select id="accountPoolAutoStrategySelect" data-account-pool-automation-strategy="${esc(strategyGroup)}">
            ${personaThreadsStrategyOptionsHtml(strategyGroup)}
          </select>
        </label>
        ${customStrategy ? `
          <div class="form-grid">
            <label>查看天数
              <input id="accountPoolAutoMaxAgeDays" type="number" min="1" max="365" value="${esc(payload.max_age_days || (mode === "reply_hot" ? 30 : 2))}" />
            </label>
            <label>扫描篇数
              <input id="accountPoolAutoMaxPosts" type="number" min="1" max="20" value="${esc(payload.max_posts || 5)}" />
            </label>
            <label>回复上限
              <input id="accountPoolAutoMaxReplies" type="number" min="1" max="10" value="${esc(payload.max_replies || 3)}" />
            </label>
            ${mode === "reply_hot" ? `<label>最低浏览
              <input id="accountPoolAutoMinViews" type="number" min="0" max="999999999" value="${esc(payload.min_views || 0)}" />
            </label>` : ""}
          </div>
          ${mode === "reply_hot" ? `<label>指定目标 URL
            <textarea id="accountPoolAutoTargetUrls" rows="3" placeholder="可选，多个链接换行填写。"></textarea>
          </label>` : ""}
          <label>固定回复内容
            <textarea id="accountPoolAutoReplyText" rows="3" placeholder="留空则按当前人设自动生成。"></textarea>
          </label>
        ` : ""}
        ${personaThreadsStrategyDetail(strategyGroup)}
        <div class="row-actions">
          <button type="button" data-account-pool-run-threads="${esc(mode)}" aria-busy="${busy ? "true" : "false"}" ${busy ? "disabled" : ""}>${busy ? renderBusyButtonContent("自动回复执行中", true, busyStartedAt) : "提交自动回复任务"}</button>
        </div>
      </div>`;
  } else {
    body = `
      <div class="automation-operation-card account-pool-automation-card">
        <strong>养号</strong>
        <p>当前账号：${esc(accountDisplayName(selectedAccount))} · 人设：${esc(persona.name || persona.id)}</p>
        <label>策略
          <select id="accountPoolAutoStrategySelect" data-account-pool-automation-strategy="threads_warmup">
            ${personaThreadsStrategyOptionsHtml("threads_warmup")}
          </select>
        </label>
        ${customStrategy ? `
          <div class="form-grid">
            <label>浏览篇数上限
              <input id="accountPoolAutoBrowseLimit" type="number" min="1" max="300" value="${esc(payload.browse_limit || payload.scroll_times || 30)}" />
            </label>
            <label>点赞上限
              <input id="accountPoolAutoLikeLimit" type="number" min="0" max="100" value="${esc(payload.like_limit || 0)}" />
            </label>
            <label>留言上限
              <input id="accountPoolAutoMaxComments" type="number" min="0" max="50" value="${esc(payload.max_comments || 0)}" />
            </label>
          </div>
          <label>养号留言模板
            <textarea id="accountPoolAutoReplyText" rows="3" placeholder="可选，多条换行。留空则按人设自动生成。"></textarea>
          </label>
        ` : ""}
        ${personaThreadsStrategyDetail("threads_warmup")}
        <div class="row-actions">
          <button type="button" data-account-pool-run-threads="warmup" aria-busy="${busy ? "true" : "false"}" ${busy ? "disabled" : ""}>${busy ? renderBusyButtonContent("养号执行中", true, busyStartedAt) : "提交养号任务"}</button>
        </div>
      </div>`;
  }
  return `
    <section class="account-pool-automation-panel">
      <div class="account-pool-section-head">
        <strong>自动化模式</strong>
        <span>${selectedAccount ? esc(accountDisplayName(selectedAccount)) : "未选择账号"}</span>
      </div>
      <div class="automation-capsule-tabs account-pool-automation-tabs" aria-label="切换自动化模式">
        ${steps.map(([value, label]) => `<button type="button" class="${mode === value ? "is-active" : ""}" data-account-pool-automation-mode="${esc(value)}">${esc(label)}</button>`).join("")}
      </div>
      ${body}
    </section>`;
}

function renderAccountPoolAutomationPanel(selectedAccount) {
  const mode = accountPoolAutomationMode();
  const steps = [
    ["reply_comment", "自动回复评论"],
    ["reply_hot", "自动回复热点"],
    ["warmup", "养号"],
  ];
  const platform = String(selectedAccount?.platform || normalizeAccountPoolPlatform()).trim().toLowerCase();
  const persona = selectedAccount?.persona_id
    ? state.personas.find((item) => String(item.id || "") === String(selectedAccount.persona_id || ""))
    : null;
  const strategyGroup = mode === "reply_hot"
    ? "threads_hot_reply"
    : mode === "warmup"
      ? "threads_warmup"
      : "threads_comment_reply";
  const payload = personaThreadsStrategy(strategyGroup)?.payload || {};
  const taskType = mode === "warmup" ? "threads_warmup" : "threads_auto_reply";
  const activeTask = selectedAccount?.id ? activeSocialTaskFor({ accountId: selectedAccount.id, taskType }) : null;
  const busy = Boolean(selectedAccount?.id) && (isActionLocked("social", selectedAccount.id, taskType) || activeTask);
  const busyStartedAt = actionTaskStartedAt(activeTask, "social", selectedAccount?.id || "", taskType);
  const contextMeta = selectedAccount && persona ? `
    <div class="account-pool-automation-meta">
      <span>账号：${esc(accountDisplayName(selectedAccount))}</span>
      <span>人设：${esc(persona.name || persona.id)}</span>
    </div>` : "";
  let body = "";
  if (!selectedAccount) {
    body = `<div class="empty-state">请先在左侧选择一个账号。</div>`;
  } else if (platform !== "threads") {
    body = `<div class="empty-state">自动回复和养号当前只支持 Threads 账号，请切换到 Threads 平台。</div>`;
  } else if (!persona) {
    body = `<div class="empty-state">当前账号还没有绑定人设，请先在右侧人设列表点击绑定。</div>`;
  } else if (mode === "reply_comment" || mode === "reply_hot") {
    body = `
      <div class="automation-operation-card account-pool-automation-card">
        <strong>${mode === "reply_hot" ? "自动回复热点" : "自动回复评论"}</strong>
        ${contextMeta}
        <label class="account-pool-param-field account-pool-param-field--wide">策略
          <select id="accountPoolAutoStrategySelect" data-account-pool-automation-strategy="${esc(strategyGroup)}">
            ${personaThreadsStrategyOptionsHtml(strategyGroup)}
          </select>
        </label>
        <div class="account-pool-param-grid">
          <label class="account-pool-param-field">查看天数
            <input id="accountPoolAutoMaxAgeDays" type="number" min="1" max="365" value="${esc(payload.max_age_days || (mode === "reply_hot" ? 30 : 2))}" />
          </label>
          <label class="account-pool-param-field">扫描篇数
            <input id="accountPoolAutoMaxPosts" type="number" min="1" max="20" value="${esc(payload.max_posts || 5)}" />
          </label>
          <label class="account-pool-param-field">回复上限
            <input id="accountPoolAutoMaxReplies" type="number" min="1" max="10" value="${esc(payload.max_replies || 3)}" />
          </label>
          ${mode === "reply_hot" ? `<label class="account-pool-param-field">最低浏览
            <input id="accountPoolAutoMinViews" type="number" min="0" max="999999999" value="${esc(payload.min_views || 0)}" />
          </label>` : ""}
        </div>
        ${mode === "reply_hot" ? `<label class="account-pool-param-field account-pool-param-field--wide">指定目标 URL
          <textarea id="accountPoolAutoTargetUrls" rows="3" placeholder="可选，多个链接换行填写。"></textarea>
        </label>` : ""}
        <label class="account-pool-param-field account-pool-param-field--wide">固定回复内容
          <textarea id="accountPoolAutoReplyText" rows="3" placeholder="留空则按当前人设自动生成。"></textarea>
        </label>
        <div class="row-actions">
          <button type="button" data-account-pool-run-threads="${esc(mode)}" aria-busy="${busy ? "true" : "false"}" ${busy ? "disabled" : ""}>${busy ? renderBusyButtonContent("任务执行中", true, busyStartedAt) : "提交自动化任务"}</button>
        </div>
      </div>`;
  } else {
    body = `
      <div class="automation-operation-card account-pool-automation-card">
        <strong>养号</strong>
        ${contextMeta}
        <label class="account-pool-param-field account-pool-param-field--wide">策略
          <select id="accountPoolAutoStrategySelect" data-account-pool-automation-strategy="threads_warmup">
            ${personaThreadsStrategyOptionsHtml("threads_warmup")}
          </select>
        </label>
        <div class="account-pool-param-grid">
          <label class="account-pool-param-field">浏览篇数上限
            <input id="accountPoolAutoBrowseLimit" type="number" min="1" max="300" value="${esc(payload.browse_limit || payload.scroll_times || 30)}" />
          </label>
          <label class="account-pool-param-field">点赞上限
            <input id="accountPoolAutoLikeLimit" type="number" min="0" max="100" value="${esc(payload.like_limit || 0)}" />
          </label>
          <label class="account-pool-param-field">留言上限
            <input id="accountPoolAutoMaxComments" type="number" min="0" max="50" value="${esc(payload.max_comments || 0)}" />
          </label>
        </div>
        <label class="account-pool-param-field account-pool-param-field--wide">养号留言模板
          <textarea id="accountPoolAutoReplyText" rows="3" placeholder="可选，多条换行。留空则按人设自动生成。"></textarea>
        </label>
        <div class="row-actions">
          <button type="button" data-account-pool-run-threads="warmup" aria-busy="${busy ? "true" : "false"}" ${busy ? "disabled" : ""}>${busy ? renderBusyButtonContent("养号执行中", true, busyStartedAt) : "提交养号任务"}</button>
        </div>
      </div>`;
  }
  return `
    <section class="account-pool-automation-panel">
      <div class="account-pool-section-head">
        <strong>自动化模式</strong>
        <span>${selectedAccount ? esc(accountDisplayName(selectedAccount)) : "未选择账号"}</span>
      </div>
      <div class="automation-capsule-tabs account-pool-automation-tabs" aria-label="切换自动化模式">
        ${steps.map(([value, label]) => `<button type="button" class="${mode === value ? "is-active" : ""}" data-account-pool-automation-mode="${esc(value)}">${esc(label)}</button>`).join("")}
      </div>
      ${body}
    </section>`;
}

function accountPoolStrategyParamSummary(group) {
  const payload = personaThreadsStrategy(group)?.payload || {};
  const rows = [];
  if (group === "threads_comment_reply" || group === "threads_hot_reply") {
    rows.push(["查看天数", payload.max_age_days || (group === "threads_hot_reply" ? 30 : 2)]);
    rows.push(["扫描篇数", payload.max_posts || 5]);
    rows.push(["回复上限", payload.max_replies || 3]);
    if (group === "threads_hot_reply") rows.push(["最低浏览", payload.min_views || 0]);
  } else {
    rows.push(["浏览篇数上限", payload.browse_limit || payload.scroll_times || 30]);
    rows.push(["点赞上限", payload.like_limit || 0]);
    rows.push(["留言上限", payload.max_comments || 0]);
  }
  return `<div class="account-pool-strategy-summary">${rows.map(([label, value]) => `
    <span><strong>${esc(label)}</strong><em>${esc(value)}</em></span>
  `).join("")}</div>`;
}

function renderAccountPoolAutomationPanel(selectedAccount) {
  const mode = accountPoolAutomationMode();
  const steps = [
    ["reply_comment", "自动回复评论"],
    ["reply_hot", "自动回复热点"],
    ["warmup", "养号"],
  ];
  const platform = String(selectedAccount?.platform || normalizeAccountPoolPlatform()).trim().toLowerCase();
  const persona = selectedAccount?.persona_id
    ? state.personas.find((item) => String(item.id || "") === String(selectedAccount.persona_id || ""))
    : null;
  const strategyGroup = mode === "reply_hot"
    ? "threads_hot_reply"
    : mode === "warmup"
      ? "threads_warmup"
      : "threads_comment_reply";
  const payload = personaThreadsStrategy(strategyGroup)?.payload || {};
  const customStrategy = personaThreadsStrategyIsCustom(strategyGroup);
  const taskType = mode === "warmup" ? "threads_warmup" : "threads_auto_reply";
  const busy = Boolean(selectedAccount?.id) && (isActionLocked("social", selectedAccount.id, taskType) || activeSocialTaskFor({ accountId: selectedAccount.id, taskType }));
  const contextMeta = selectedAccount && persona ? `
    <div class="account-pool-automation-meta">
      <span>账号：${esc(accountDisplayName(selectedAccount))}</span>
      <span>人设：${esc(persona.name || persona.id)}</span>
    </div>` : "";
  let body = "";
  if (!selectedAccount) {
    body = `<div class="empty-state">请先在左侧选择一个账号。</div>`;
  } else if (platform !== "threads") {
    body = `<div class="empty-state">自动回复和养号当前只支持 Threads 账号，请切换到 Threads 平台。</div>`;
  } else if (!persona) {
    body = `<div class="empty-state">当前账号还没有绑定人设，请先在右侧人设列表点击绑定。</div>`;
  } else if (mode === "reply_comment" || mode === "reply_hot") {
    body = `
      <div class="automation-operation-card account-pool-automation-card">
        <strong>${mode === "reply_hot" ? "自动回复热点" : "自动回复评论"}</strong>
        ${contextMeta}
        <label class="account-pool-param-field account-pool-param-field--wide">策略
          <select id="accountPoolAutoStrategySelect" data-account-pool-automation-strategy="${esc(strategyGroup)}">
            ${personaThreadsStrategyOptionsHtml(strategyGroup)}
          </select>
        </label>
        ${customStrategy ? `
          <div class="account-pool-param-grid">
            <label class="account-pool-param-field">查看天数
              <input id="accountPoolAutoMaxAgeDays" type="number" min="1" max="365" value="${esc(payload.max_age_days || (mode === "reply_hot" ? 30 : 2))}" />
            </label>
            <label class="account-pool-param-field">扫描篇数
              <input id="accountPoolAutoMaxPosts" type="number" min="1" max="20" value="${esc(payload.max_posts || 5)}" />
            </label>
            <label class="account-pool-param-field">回复上限
              <input id="accountPoolAutoMaxReplies" type="number" min="1" max="10" value="${esc(payload.max_replies || 3)}" />
            </label>
            ${mode === "reply_hot" ? `<label class="account-pool-param-field">最低浏览
              <input id="accountPoolAutoMinViews" type="number" min="0" max="999999999" value="${esc(payload.min_views || 0)}" />
            </label>` : ""}
          </div>
          ${mode === "reply_hot" ? `<label class="account-pool-param-field account-pool-param-field--wide">指定目标 URL
            <textarea id="accountPoolAutoTargetUrls" rows="3" placeholder="可选，多个链接换行填写。"></textarea>
          </label>` : ""}
          <label class="account-pool-param-field account-pool-param-field--wide">固定回复内容
            <textarea id="accountPoolAutoReplyText" rows="3" placeholder="留空则按当前人设自动生成。"></textarea>
          </label>
        ` : accountPoolStrategyParamSummary(strategyGroup)}
        <div class="row-actions">
          <button type="button" data-account-pool-run-threads="${esc(mode)}" aria-busy="${busy ? "true" : "false"}" ${busy ? "disabled" : ""}>${busy ? "任务执行中" : "提交自动化任务"}</button>
        </div>
      </div>`;
  } else {
    body = `
      <div class="automation-operation-card account-pool-automation-card">
        <strong>养号</strong>
        ${contextMeta}
        <label class="account-pool-param-field account-pool-param-field--wide">策略
          <select id="accountPoolAutoStrategySelect" data-account-pool-automation-strategy="threads_warmup">
            ${personaThreadsStrategyOptionsHtml("threads_warmup")}
          </select>
        </label>
        ${customStrategy ? `
          <div class="account-pool-param-grid">
            <label class="account-pool-param-field">浏览篇数上限
              <input id="accountPoolAutoBrowseLimit" type="number" min="1" max="300" value="${esc(payload.browse_limit || payload.scroll_times || 30)}" />
            </label>
            <label class="account-pool-param-field">点赞上限
              <input id="accountPoolAutoLikeLimit" type="number" min="0" max="100" value="${esc(payload.like_limit || 0)}" />
            </label>
            <label class="account-pool-param-field">留言上限
              <input id="accountPoolAutoMaxComments" type="number" min="0" max="50" value="${esc(payload.max_comments || 0)}" />
            </label>
          </div>
          <label class="account-pool-param-field account-pool-param-field--wide">养号留言模板
            <textarea id="accountPoolAutoReplyText" rows="3" placeholder="可选，多条换行。留空则按人设自动生成。"></textarea>
          </label>
        ` : accountPoolStrategyParamSummary("threads_warmup")}
        <div class="row-actions">
          <button type="button" data-account-pool-run-threads="warmup" aria-busy="${busy ? "true" : "false"}" ${busy ? "disabled" : ""}>${busy ? "养号执行中" : "提交养号任务"}</button>
        </div>
      </div>`;
  }
  return `
    <section class="account-pool-automation-panel">
      <div class="account-pool-section-head">
        <strong>自动化模式</strong>
        <span>${selectedAccount ? esc(accountDisplayName(selectedAccount)) : "未选择账号"}</span>
      </div>
      <div class="automation-capsule-tabs account-pool-automation-tabs" aria-label="切换自动化模式">
        ${steps.map(([value, label]) => `<button type="button" class="${mode === value ? "is-active" : ""}" data-account-pool-automation-mode="${esc(value)}">${esc(label)}</button>`).join("")}
      </div>
      ${body}
    </section>`;
}

function accountPoolFieldValue(id = "") {
  return String($(`accountPool${id}`)?.value || "").trim();
}

function accountPoolDraftValue(key = "") {
  return String(state.accountPoolCreateDraft?.[key] || "");
}

function socialProxyById(proxyId = "") {
  const cleanId = String(proxyId || "").trim();
  return (state.socialProxies || []).find((proxy) => String(proxy.id || "") === cleanId) || null;
}

function accountResidentialProxy(account = null) {
  return socialProxyById(account?.proxy_id || "") || account?.residential_proxy || null;
}

function accountResidentialProxyLabel(account = null) {
  const proxy = accountResidentialProxy(account);
  if (!proxy) return "未使用代理 IP";
  const checkedIp = String(proxy.last_check_result?.response?.ip || "").trim();
  const endpoint = checkedIp || String(proxy.host || "").trim();
  const region = String(proxy.country || "").trim();
  const status = String(proxy.status || "").toLowerCase() === "failed" ? "检测失败" : "住宅 IP";
  return `${status}：${endpoint || "已配置"}${region ? ` · ${region}` : ""}`;
}

function proxySelectOptions(options, selected = "") {
  const value = String(selected || "").trim().toLowerCase();
  const known = options.some(([key]) => key === value);
  const preserved = value && !known ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>` : "";
  return preserved + options.map(([key, label]) => `<option value="${esc(key)}" ${value === key ? "selected" : ""}>${esc(label)}</option>`).join("");
}

function proxyDatetimeInputValue(value = "") {
  if (!value) return "";
  const number = Number(value);
  const date = Number.isFinite(number) && number > 100000 ? new Date(number * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function proxySourceOptions(current = "") {
  return proxySelectOptions([
    ["manual", "手动录入"],
    ["owlproxy", "OwlProxy"],
    ["provider", "其他购买代理"],
    ["self_owned", "自有代理"],
  ], current || "manual");
}

function sharedProxyFieldsHtml(prefix, proxy = null) {
  const protocol = ["socks5", "http", "https"].includes(proxyProtocol(proxy).toLowerCase()) ? proxyProtocol(proxy).toLowerCase() : "auto";
  const source = String(proxy?.source || "manual");
  const expiryMode = Number(proxy?.expires_at || 0) > 0 ? "custom" : "permanent";
  return `
    <label><span>代理名称</span><input id="${esc(prefix)}Name" value="${esc(proxy?.name || "")}" placeholder="检测后自动生成，也可手动填写" /></label>
    <label><span>代理类型</span><select id="${esc(prefix)}Protocol">${proxySelectOptions([["auto", "自动检测（推荐）"], ["http", "HTTP"], ["socks5", "SOCKS5"], ["https", "HTTPS"]], protocol)}</select></label>
    <label><span>代理方式</span><select id="${esc(prefix)}ConnectionMode"><option value="proxy" selected>Proxy（代理服务器）</option></select></label>
    <label><span>供应商 / 来源</span><select id="${esc(prefix)}Source">${proxySourceOptions(source)}</select></label>
    <label><span>持有方式</span><select id="${esc(prefix)}PurchaseStatus">${proxySelectOptions([["owned", "自有"], ["leased", "租用"]], proxy?.purchase_status || "owned")}</select></label>
    <label><span>服务器地址</span><input id="${esc(prefix)}Host" value="${esc(proxy?.host || "")}" placeholder="208.113.11.225 或 proxy.example.com" autocomplete="off" /></label>
    <label><span>服务端口</span><input id="${esc(prefix)}Port" type="number" min="1" max="65535" value="${esc(proxy?.port || "")}" placeholder="1080" /></label>
    <label><span>认证账号（可选）</span><input id="${esc(prefix)}Username" value="" placeholder="${proxy?.username_configured ? "留空则沿用已保存账号" : "代理认证账号"}" autocomplete="off" /></label>
    <label><span>认证密码（可选）</span><input id="${esc(prefix)}Password" type="password" value="" placeholder="${proxy?.password_configured ? "留空则沿用已保存密码" : "代理认证密码"}" autocomplete="new-password" /></label>
    <label><span>有效期</span><select id="${esc(prefix)}ExpiryMode" data-proxy-expiry-mode data-proxy-expiry-target="${esc(prefix)}ExpiresAtWrap">${proxySelectOptions([["permanent", "长期"], ["30", "30 天"], ["90", "90 天"], ["180", "180 天"], ["custom", "自定义时间"]], expiryMode)}</select></label>
    <label id="${esc(prefix)}ExpiresAtWrap" ${expiryMode === "custom" ? "" : "hidden"}><span>自定义有效期</span><input id="${esc(prefix)}ExpiresAt" type="datetime-local" value="${esc(proxyDatetimeInputValue(proxy?.expires_at))}" /></label>
    <label class="proxy-form-note"><span>备注（可选）</span><textarea id="${esc(prefix)}Note" rows="3" placeholder="用途或续费信息">${esc(proxy?.note || "")}</textarea></label>
    <div class="proxy-network-check">
      <button type="button" data-proxy-inline-test="${esc(prefix)}" data-proxy-inline-id="${esc(proxy?.id || "")}">${renderRefreshIcon()}<span>网络检测</span></button>
      <div id="${esc(prefix)}CheckResult" class="proxy-check-result" hidden></div>
    </div>`;
}

function sharedProxyPayload(prefix, proxy = null) {
  const host = String($(`${prefix}Host`)?.value || "").trim();
  const port = Number.parseInt(String($(`${prefix}Port`)?.value || ""), 10);
  if (!host || !Number.isFinite(port) || port < 1 || port > 65535) {
    showMsg("socialMsg", "请填写有效的静态住宅代理 Host 和端口。", false);
    return null;
  }
  if (/:\/\/|[\/?#@]|\s/.test(host) || (/^[^\[\]]+:[0-9]+$/.test(host) && !host.includes("::"))) {
    showMsg("socialMsg", "服务器地址只能填写裸 IP 或域名，请勿包含协议、端口、路径或账号。", false);
    return null;
  }
  const expiryMode = String($(`${prefix}ExpiryMode`)?.value || "permanent");
  let expiresAt = 0;
  if (["30", "90", "180"].includes(expiryMode)) expiresAt = Math.floor(Date.now() / 1000) + (Number(expiryMode) * 86400);
  if (expiryMode === "custom") {
    expiresAt = $(`${prefix}ExpiresAt`)?.value ? Math.floor(new Date($(`${prefix}ExpiresAt`).value).getTime() / 1000) : 0;
    if (!expiresAt) {
      showMsg("socialMsg", "请选择自定义有效时间", false);
      return null;
    }
  }
  const payload = {
    ip_type: "static_residential",
    name: String($(`${prefix}Name`)?.value || "").trim(),
    proxy_type: String($(`${prefix}Protocol`)?.value || "socks5").trim().toLowerCase(),
    connection_mode: String($(`${prefix}ConnectionMode`)?.value || "proxy").trim().toLowerCase(),
    source: String($(`${prefix}Source`)?.value || "manual").trim(),
    purchase_status: String($(`${prefix}PurchaseStatus`)?.value || "owned").trim(),
    host,
    port,
    expires_at: expiresAt,
    note: String($(`${prefix}Note`)?.value || "").trim(),
    status: "pending",
  };
  const username = String($(`${prefix}Username`)?.value || "").trim();
  if (username || !proxy?.username_configured) payload.username = username;
  const password = String($(`${prefix}Password`)?.value || "");
  if (password) payload.password = password;
  return payload;
}

function proxyCheckRequestPayload(payload = {}, proxyId = "") {
  const data = { ...payload };
  if (data.protocol && !data.proxy_type) data.proxy_type = data.protocol;
  return {
    proxy_id: String(proxyId || "").trim(),
    proxy_type: String(data.proxy_type || "socks5").trim().toLowerCase(),
    connection_mode: String(data.connection_mode || "proxy").trim().toLowerCase(),
    host: String(data.host || "").trim(),
    port: Number(data.port || 0),
    ...(Object.prototype.hasOwnProperty.call(data, "username") ? { username: String(data.username || "").trim() } : {}),
    ...(Object.prototype.hasOwnProperty.call(data, "password") ? { password: String(data.password || "") } : {}),
  };
}

function proxyResidentialStatusLabel(value = "") {
  return { verified: "住宅属性通过", rejected: "非住宅网络", unknown: "住宅属性待确认" }[String(value || "").toLowerCase()] || "住宅属性待确认";
}

function renderProxyCheckResult(targetId = "", result = null) {
  const target = $(targetId);
  if (!target) return;
  const response = result?.response && typeof result.response === "object" ? result.response : {};
  const connection = response.connection && typeof response.connection === "object" ? response.connection : {};
  const location = [response.country || response.country_code, response.region, response.city].filter(Boolean).join(" · ") || "未识别";
  const ok = Boolean(result?.ok);
  target.hidden = false;
  target.classList.toggle("is-success", ok);
  target.classList.toggle("is-error", !ok);
  target.innerHTML = `
    <div class="proxy-check-result-head"><strong>${ok ? "检测通过" : "检测未通过"}</strong><span>${esc(proxyResidentialStatusLabel(result?.residential_status))}</span></div>
    <dl>
      <div><dt>代理出口</dt><dd>${esc(result?.exit_ip || response.ip || "-")}</dd></div>
      <div><dt>位置</dt><dd>${esc(location)}</dd></div>
      <div><dt>运营商</dt><dd>${esc(connection.isp || connection.org || "未识别")}</dd></div>
      <div><dt>延迟</dt><dd>${Number.isFinite(Number(result?.latency_ms)) ? `${Number(result.latency_ms)} ms` : "-"}</dd></div>
      <div><dt>识别协议</dt><dd>${esc(String(result?.detected_proxy_type || "-").toUpperCase())}</dd></div>
      <div><dt>代理链路</dt><dd>${result?.route_verified === true ? "已确认" : result?.route_verified === false ? "未通过" : "待确认"}</dd></div>
      <div><dt>静态一致性</dt><dd>${result?.static_consistent === true ? "一致" : result?.static_consistent === false ? "不一致" : "待确认"}</dd></div>
    </dl>
    ${result?.error ? `<p>${esc(result.error)}</p>` : ""}`;
}

function proxyNameCanAutofill(value = "", payload = {}) {
  const current = String(value || "").trim();
  if (!current) return true;
  const host = String(payload.host || "").trim();
  const port = Number(payload.port || 0);
  if (!host || !port) return false;
  return ["http", "https", "socks5"].some((protocol) => current.toLowerCase() === `${protocol}://${host}:${port}`.toLowerCase());
}

function applyProxyDetectionAutofill(prefix = "", result = null, payload = {}) {
  if (!prefix || !result?.ok) return;
  const detectedProtocol = String(result.detected_proxy_type || payload.proxy_type || "").trim().toLowerCase();
  const protocolInput = $(`${prefix}Protocol`);
  if (protocolInput && ["http", "https", "socks5"].includes(detectedProtocol)) protocolInput.value = detectedProtocol;
  if (detectedProtocol) payload.proxy_type = detectedProtocol;

  const nameInput = $(`${prefix}Name`);
  if (!nameInput || !proxyNameCanAutofill(nameInput.value, payload)) return;
  const response = result.response && typeof result.response === "object" ? result.response : {};
  const country = String(response.country_code || response.country || "").trim();
  const location = String(response.city || response.region || "").trim();
  const exitIp = String(result.exit_ip || response.ip || "").trim();
  const label = [country, location, exitIp].filter(Boolean).join(" · ");
  if (!label) return;
  nameInput.value = `[静态住宅] ${label}`;
  payload.name = nameInput.value;
}

async function testProxyConfiguration(payload = {}, proxyId = "", resultTargetId = "", formPrefix = "") {
  const selectedProtocol = String(payload.proxy_type || "auto").trim().toLowerCase();
  const candidates = selectedProtocol === "auto" ? ["http", "socks5", "https"] : [selectedProtocol];
  let result = {};
  for (const protocol of candidates) {
    const candidate = { ...payload, proxy_type: protocol };
    const response = await api("/api/persona_dashboard/automation/proxies/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proxyCheckRequestPayload(candidate, proxyId)),
    });
    result = { ...(response?.result || {}) };
    result.detected_proxy_type = result.ok ? protocol : "";
    if (result.ok) {
      payload.proxy_type = protocol;
      applyProxyDetectionAutofill(formPrefix, result, payload);
      break;
    }
  }
  if (resultTargetId) renderProxyCheckResult(resultTargetId, result);
  return result;
}

async function testProxyForm(prefix = "", proxy = null) {
  const payload = sharedProxyPayload(prefix, proxy);
  if (!payload) return null;
  const result = await testProxyConfiguration(payload, proxy?.id || "", `${prefix}CheckResult`, prefix);
  showMsg("socialMsg", result.ok ? "代理网络检测通过。" : (result.error || "代理网络检测未通过。"), Boolean(result.ok));
  return result;
}

function accountResidentialProxyFormHtml(prefix, proxy = null) {
  const enabled = Boolean(proxy);
  return `
    <section class="account-residential-proxy">
      <div class="account-residential-proxy-head">
        <label class="account-proxy-enable">
          <input id="${esc(prefix)}ProxyEnabled" type="checkbox" data-account-proxy-enabled="${esc(prefix)}" ${enabled ? "checked" : ""} />
          <span>使用静态住宅代理</span>
        </label>
        <span class="status">可选</span>
      </div>
      <fieldset id="${esc(prefix)}ProxyFields" class="account-proxy-grid" ${enabled ? "" : "hidden disabled"}>
        ${sharedProxyFieldsHtml(`${prefix}Proxy`, proxy)}
      </fieldset>
    </section>`;
}

function accountResidentialProxyPayload(prefix, accountName = "", proxy = null) {
  if (!$(`${prefix}ProxyEnabled`)?.checked) return undefined;
  const payload = sharedProxyPayload(`${prefix}Proxy`, proxy);
  if (!payload) return null;
  payload.protocol = payload.proxy_type;
  delete payload.proxy_type;
  if (!payload.name) payload.name = `[静态住宅] ${String(accountName || payload.host).trim()}`;
  return payload;
}

function syncAccountResidentialProxyFields(prefix) {
  const enabled = Boolean($(`${prefix}ProxyEnabled`)?.checked);
  const fields = $(`${prefix}ProxyFields`);
  if (!fields) return;
  fields.hidden = !enabled;
  fields.disabled = !enabled;
}

async function verifyAccountResidentialProxy(proxyId = "") {
  const cleanId = String(proxyId || "").trim();
  if (!cleanId) return false;
  const result = await api(`/api/persona_dashboard/automation/proxies/${encodeURIComponent(cleanId)}/check`, { method: "POST" });
  return Boolean(result?.proxy?.last_check_result?.ok);
}

function syncAccountPoolCreateDraftFromForm() {
  state.accountPoolCreateDraft = {
    username: accountPoolFieldValue("Username"),
    login_username: accountPoolFieldValue("LoginUsername"),
    login_password: String($("accountPoolLoginPassword")?.value || ""),
    display_name: accountPoolFieldValue("DisplayName"),
    profile_dir: accountPoolFieldValue("ProfileDir"),
    proxy_type: accountPoolFieldValue("ProxyType"),
    proxy_host: accountPoolFieldValue("ProxyHost"),
    proxy_port: accountPoolFieldValue("ProxyPort"),
    proxy_username: accountPoolFieldValue("ProxyUsername"),
    proxy_password: String($("accountPoolProxyPassword")?.value || ""),
    proxy_confirmed: Boolean($("accountPoolProxyConfirmed")?.checked),
    proxy_enabled: Boolean($("accountPoolProxyEnabled")?.checked),
  };
}

function resetAccountPoolCreateForm() {
  state.accountPoolCreateOpen = false;
  state.accountPoolCreateDraft = {};
}

function renderAccountPoolCreatePanel() {
  return "";
}

function accountPoolCreateFormHtml() {
  const platform = normalizeAccountPoolPlatform();
  const platformLabel = accountPoolPlatforms.find(([value]) => value === platform)?.[1] || platform;
  return `
    <div class="account-pool-create-modal-body">
      <p>当前平台：${esc(platformLabel)}</p>
      <div class="account-create-form account-create-form--modal">
          <label>
            <span>账号用户名</span>
            <input id="accountPoolUsername" value="${esc(accountPoolDraftValue("username"))}" placeholder="例如：liliacvuiy575" autocomplete="off" />
          </label>
          <label>
            <span>登录账号（可选）</span>
            <input id="accountPoolLoginUsername" value="${esc(accountPoolDraftValue("login_username"))}" placeholder="默认同账号用户名" autocomplete="off" />
          </label>
          <label>
            <span>登录密码（可选）</span>
            <input id="accountPoolLoginPassword" type="password" value="${esc(accountPoolDraftValue("login_password"))}" placeholder="用于自动登录，可稍后再填" autocomplete="new-password" />
          </label>
          <label>
            <span>显示名称（可选）</span>
            <input id="accountPoolDisplayName" value="${esc(accountPoolDraftValue("display_name"))}" placeholder="用于区分账号，可留空" autocomplete="off" />
          </label>
      </div>
      ${accountResidentialProxyFormHtml("accountPool")}
    </div>`;
}

function openAccountPoolCreateModal() {
  resetAccountPoolCreateForm();
  closeConsoleModal(null);
  const modal = document.createElement("div");
  modal.id = "consoleModal";
  modal.className = "console-modal";
  modal.innerHTML = `
    <div class="console-modal-backdrop" data-account-pool-create-modal-cancel></div>
    <section class="console-modal-dialog account-pool-create-modal" role="dialog" aria-modal="true" aria-labelledby="accountPoolCreateModalTitle">
      <div class="console-modal-head">
        <strong id="accountPoolCreateModalTitle">添加账号</strong>
      </div>
      <div class="console-modal-content">
        ${accountPoolCreateFormHtml()}
      </div>
      <div class="console-modal-actions">
        <button type="button" data-account-pool-create-modal-cancel>取消</button>
        <button type="button" class="primary" data-account-pool-create-modal-save>保存账号</button>
      </div>
    </section>`;
  document.body.appendChild(modal);
  syncAccountResidentialProxyFields("accountPool");
  $("accountPoolUsername")?.focus();

  const close = () => {
    modal.remove();
    resetAccountPoolCreateForm();
  };

  modal.addEventListener("click", (event) => {
    if (event.target.closest("[data-account-pool-create-modal-cancel]")) {
      close();
      return;
    }
    const testButton = event.target.closest("[data-proxy-inline-test]");
    if (testButton) {
      testButton.disabled = true;
      testProxyForm("accountPoolProxy")
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "代理检测失败", false))
        .finally(() => { testButton.disabled = false; });
      return;
    }
    const saveButton = event.target.closest("[data-account-pool-create-modal-save]");
    if (saveButton) {
      saveButton.disabled = true;
      saveAccountPoolCreateForm()
        .then((saved) => {
          if (saved !== false) close();
          else saveButton.disabled = false;
        })
        .catch((error) => {
          saveButton.disabled = false;
          showMsg("socialMsg", error.detail || error.message || "添加账号失败", false);
        });
    }
  });
  modal.addEventListener("change", (event) => {
    if (event.target.closest('[data-account-proxy-enabled="accountPool"]')) syncAccountResidentialProxyFields("accountPool");
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

async function saveAccountPoolCreateForm() {
  syncAccountPoolCreateDraftFromForm();
  const platform = normalizeAccountPoolPlatform();
  const payload = {
    platform,
    username: accountPoolDraftValue("username").trim().replace(/^@+/, ""),
    display_name: accountPoolDraftValue("display_name").trim(),
    profile_dir: accountPoolDraftValue("profile_dir").trim(),
    login_username: accountPoolDraftValue("login_username").trim(),
    login_password: accountPoolDraftValue("login_password"),
  };
  if (!payload.username) {
    showMsg("socialMsg", "请填写账号用户名。", false);
    return false;
  }
  const residentialProxy = accountResidentialProxyPayload("accountPool", payload.username);
  if ($("accountPoolProxyEnabled")?.checked && !residentialProxy) return false;
  if (residentialProxy) {
    const preflight = await testProxyConfiguration(residentialProxy, "", "accountPoolProxyCheckResult", "accountPoolProxy");
    if (!preflight.ok) {
      showMsg("socialMsg", preflight.error || "静态住宅代理检测未通过，账号尚未保存。", false);
      return false;
    }
    payload.residential_proxy = residentialProxy;
  }
  const result = await api("/api/persona_dashboard/automation/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const account = result?.account || {};
  let proxyOk = true;
  if (residentialProxy) {
    try {
      proxyOk = await verifyAccountResidentialProxy(account.proxy_id);
    } catch (_error) {
      proxyOk = false;
    }
  }
  state.accountPoolPlatform = normalizeAccountPoolPlatform(account.platform || payload.platform);
  state.accountPoolAccountId = String(account.id || "");
  state.accountPoolSelectedAccountIds = account.id ? [String(account.id)] : [];
  resetAccountPoolCreateForm();
  await loadSocial();
  if (!proxyOk) {
    showMsg("socialMsg", "账号已保存，但住宅代理检测失败；修复代理前不会执行自动化任务。", false);
    return true;
  }
  showMsg("socialMsg", residentialProxy ? "账号和静态住宅代理已保存。" : "账号已保存。", true);
  return true;
}

function accountPoolSelectedAccountsForAction() {
  const selectedIds = new Set(accountPoolSelectedIds());
  return accountPoolAccounts().filter((account) => selectedIds.has(String(account.id || "")));
}

async function copyAccountPoolSelectedAccounts() {
  const rows = accountPoolSelectedAccountsForAction();
  if (!rows.length) {
    showMsg("socialMsg", "请先勾选账号。", false);
    return;
  }
  const text = rows.map((account) => [
    `平台：${account.platform || ""}`,
    `账号：${account.username || ""}`,
    `显示名：${account.display_name || ""}`,
    `状态：${statusLabel(account.status)}`,
    `ID：${account.id || ""}`,
  ].join("\n")).join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  showMsg("socialMsg", `已复制 ${rows.length} 个账号信息。`, true);
}

function selectAllAccountPoolAccounts() {
  const ids = accountPoolAccounts().map((account) => String(account.id || "")).filter(Boolean);
  state.accountPoolSelectedAccountIds = ids;
  if (!state.accountPoolAccountId && ids.length) state.accountPoolAccountId = ids[0];
  const account = selectedAccountPoolAccount();
  setAccountPoolAutomationContext(account);
  renderSocialAccounts();
}

async function deleteSelectedAccountPoolAccounts() {
  const rows = accountPoolSelectedAccountsForAction();
  if (!rows.length) {
    showMsg("socialMsg", "请先勾选要删除的账号。", false);
    return;
  }
  const ok = await confirmDangerAction(`确定删除已勾选的 ${rows.length} 个执行账号吗？相关自动化记录也会一起删除。`, {
    title: "批量删除账号",
    confirmText: "删除账号",
  });
  if (!ok) return;
  let deleted = 0;
  for (const account of rows) {
    await deleteSocialAccountRecord(account.id, "socialMsg");
    deleted += 1;
  }
  state.accountPoolSelectedAccountIds = [];
  state.accountPoolAccountId = "";
  showMsg("socialMsg", `已删除 ${deleted} 个账号。`, true);
  await loadSocial();
  renderSocialAccounts();
}

function accountProxyEligibility(proxy = null, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!proxy) return { eligible: true, reason: "" };
  if (String(proxy.ip_type || "").trim().toLowerCase() !== "static_residential") {
    return { eligible: false, reason: "仅支持静态住宅 IP" };
  }
  const expiresAt = Number(proxy.expires_at || 0);
  if (expiresAt > 0 && expiresAt <= Number(nowSeconds || 0)) {
    return { eligible: false, reason: "已过期" };
  }
  if (String(proxy.status || "").trim().toLowerCase() !== "active") {
    return { eligible: false, reason: proxyStatusLabel(proxy.status) || "未启用" };
  }
  const checkResult = proxy.last_check_result && typeof proxy.last_check_result === "object"
    ? proxy.last_check_result
    : {};
  if (Number(proxy.last_check_at || 0) <= 0 || checkResult.ok !== true) {
    return { eligible: false, reason: "未通过网络检测" };
  }
  return { eligible: true, reason: "可使用" };
}

function accountProxyBindingChanged(originalProxyId = "", selectedProxyId = "") {
  return String(originalProxyId || "").trim() !== String(selectedProxyId || "").trim();
}

function accountProxyOptionCardsHtml(selectedProxyId = "", { scope = "modal" } = {}) {
  const selectedId = String(selectedProxyId || "").trim();
  const rows = proxyPoolRows();
  const option = (proxy = null) => {
    const proxyId = String(proxy?.id || "").trim();
    const selected = proxyId === selectedId;
    const eligibility = accountProxyEligibility(proxy);
    const endpoint = proxy
      ? [String(proxy.host || "").trim(), String(proxy.port || "").trim()].filter(Boolean).join(":") || "未填写地址"
      : "账号将直接连接网络";
    const location = proxy
      ? [String(proxy.country || "").trim(), String(proxy.city || proxy.region || "").trim()].filter(Boolean).join(" · ") || "位置待识别"
      : "随时可以重新选择代理 IP";
    const exitIp = proxy ? proxyExitIp(proxy) : "";
    const title = proxy ? String(proxy.name || (exitIp !== "-" ? exitIp : "") || endpoint).trim() : "不使用代理";
    const detail = proxy
      ? `${proxyProtocol(proxy)} · ${eligibility.eligible ? "可使用" : `不可选：${eligibility.reason}`} · 已绑 ${proxyBoundAccountCount(proxy)} 个账号`
      : "清除当前账号的代理绑定";
    return `<button type="button" class="account-proxy-option ${selected ? "is-selected" : ""}" data-account-proxy-choice="${esc(proxyId)}" data-account-proxy-choice-scope="${esc(scope)}" aria-pressed="${selected ? "true" : "false"}" ${eligibility.eligible ? "" : "disabled aria-disabled=\"true\""}>
      <span class="account-proxy-option-check" aria-hidden="true"></span>
      <strong>${esc(title)}</strong>
      <span>${esc(endpoint)}</span>
      <small>${esc(location)}</small>
      <small>${esc(detail)}</small>
    </button>`;
  };
  return `<div class="account-proxy-options" data-account-proxy-options role="group" aria-label="选择代理 IP">
    ${option(null)}
    ${rows.map((proxy) => option(proxy)).join("")}
  </div>`;
}

function updateAccountProxyChoice(modal, proxyId = "") {
  if (!modal) return;
  const selectedId = String(proxyId || "").trim();
  const proxy = socialProxyById(selectedId);
  if (selectedId && !accountProxyEligibility(proxy).eligible) return false;
  modal.dataset.selectedProxyId = selectedId;
  if (Object.hasOwn(modal.dataset, "originalProxyId")) {
    modal.dataset.accountProxyDirty = accountProxyBindingChanged(modal.dataset.originalProxyId || "", selectedId) ? "true" : "false";
  }
  modal.querySelectorAll("[data-account-proxy-choice]").forEach((button) => {
    const selected = String(button.dataset.accountProxyChoice || "").trim() === selectedId;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
  const summary = modal.querySelector("[data-account-proxy-selection-summary]");
  if (summary) {
    const exitIp = proxy ? proxyExitIp(proxy) : "";
    summary.textContent = proxy ? `已选择：${proxy.name || (exitIp !== "-" ? exitIp : "") || proxy.host}` : "已选择：不使用代理";
  }
  return true;
}

async function reconcileAccountProxyBindingConflict(modal, accountId = "", error = null) {
  if (!modal || Number(error?.status || 0) !== 409) return false;
  await fetchSocialDataShared({ force: true });
  updateAccountStatusViews();
  const latestAccount = accountById(accountId);
  if (!latestAccount) return false;
  const originalProxyId = String(modal.dataset.originalProxyId || "").trim();
  const latestProxyId = String(latestAccount.proxy_id || "").trim();
  if (!accountProxyBindingChanged(originalProxyId, latestProxyId)) return false;
  const scope = modal.querySelector("[data-account-proxy-choice]")?.dataset.accountProxyChoiceScope || "modal";
  const options = modal.querySelector("[data-account-proxy-options]");
  if (options) options.outerHTML = accountProxyOptionCardsHtml(latestProxyId, { scope });
  modal.dataset.originalProxyId = latestProxyId;
  updateAccountProxyChoice(modal, latestProxyId);
  const summary = modal.querySelector("[data-account-proxy-selection-summary]");
  if (summary) summary.textContent = "代理绑定已在其他页面更新，请重新选择。";
  return true;
}

async function saveAccountProxyBinding(accountId = "", proxyId = "", expectedProxyId = "") {
  const cleanAccountId = String(accountId || "").trim();
  if (!cleanAccountId) return false;
  const selectedProxyId = String(proxyId || "").trim();
  const result = await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(cleanAccountId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(selectedProxyId
      ? { proxy_id: selectedProxyId, expected_proxy_id: String(expectedProxyId || "").trim() }
      : { clear_residential_proxy: true, expected_proxy_id: String(expectedProxyId || "").trim() }),
  });
  state.accountPoolAccountId = String(result.account?.id || cleanAccountId);
  await loadSocial({ force: true });
  renderSocialAccounts();
  if (isPersonaWorkspaceModule()) renderPersonaDetail();
  showMsg("socialMsg", selectedProxyId ? "代理 IP 已绑定。" : "代理 IP 已解绑。", true);
  return true;
}

function openAccountProxyPickerModal(accountId = "") {
  const account = accountById(accountId);
  if (!account) {
    showMsg("socialMsg", "账号不存在，请刷新后重试。", false);
    return;
  }
  closeConsoleModal(null);
  const modal = document.createElement("div");
  modal.id = "consoleModal";
  modal.className = "console-modal";
  modal.dataset.selectedProxyId = String(account.proxy_id || "").trim();
  modal.dataset.originalProxyId = String(account.proxy_id || "").trim();
  modal.dataset.accountProxyDirty = "false";
  modal.innerHTML = `
    <div class="console-modal-backdrop"></div>
    <section class="console-modal-dialog account-proxy-picker-modal" role="dialog" aria-modal="true" aria-labelledby="accountProxyPickerTitle">
      <div class="console-modal-head">
        <div><strong id="accountProxyPickerTitle">选择代理 IP</strong><p>${esc(accountDisplayName(account))} · 一个账号同时只绑定一个代理</p></div>
      </div>
      <div class="console-modal-content">
        <p data-account-proxy-selection-summary>${account.proxy_id ? `当前绑定：${esc(accountResidentialProxyLabel(account))}` : "当前未使用代理 IP"}</p>
        ${accountProxyOptionCardsHtml(account.proxy_id || "", { scope: "modal" })}
      </div>
      <div class="console-modal-actions">
        <button type="button" data-account-proxy-picker-cancel>取消</button>
        <button type="button" class="primary" data-account-proxy-picker-save="${esc(account.id)}">确认绑定</button>
      </div>
    </section>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener("click", (event) => {
    const choice = event.target.closest("[data-account-proxy-choice]");
    if (choice) {
      if (choice.disabled) return;
      updateAccountProxyChoice(modal, choice.dataset.accountProxyChoice || "");
      return;
    }
    if (event.target.closest("[data-account-proxy-picker-cancel]")) {
      close();
      return;
    }
    const save = event.target.closest("[data-account-proxy-picker-save]");
    if (!save) return;
    if (modal.dataset.accountProxyDirty !== "true") {
      close();
      return;
    }
    save.disabled = true;
    saveAccountProxyBinding(
      save.dataset.accountProxyPickerSave || "",
      modal.dataset.selectedProxyId || "",
      modal.dataset.originalProxyId || "",
    )
      .then((saved) => {
        if (saved !== false) close();
        else save.disabled = false;
      })
      .catch(async (error) => {
        save.disabled = false;
        const reconciled = await reconcileAccountProxyBindingConflict(modal, save.dataset.accountProxyPickerSave || "", error);
        showMsg("socialMsg", reconciled ? "代理绑定已更新，请重新选择。" : (error.detail || error.message || "代理绑定失败"), false);
      });
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

function renderAccountProxyPickerPanel(account = null) {
  const proxyId = String(account?.proxy_id || "").trim();
  return `<section class="account-residential-proxy account-proxy-picker-panel">
    <div class="account-residential-proxy-head">
      <div><strong>代理 IP</strong><span data-account-proxy-selection-summary>${esc(proxyId ? accountResidentialProxyLabel(account) : "未使用代理 IP")}</span></div>
      <button type="button" data-account-proxy-inline-toggle aria-expanded="false">${proxyId ? "切换代理" : "选择代理"}</button>
    </div>
    <div class="account-proxy-inline-options" data-account-proxy-inline-options hidden>
      ${accountProxyOptionCardsHtml(proxyId, { scope: "edit" })}
    </div>
  </section>`;
}

function renderAccountTotpSection(account = null) {
  return `<section class="account-totp-section" data-account-totp-section>
    <div class="account-totp-head">
      <div>
        <strong>两步验证 (2FA)</strong>
        <span>支持 Base32 密钥或 otpauth URI</span>
      </div>
      <span class="account-totp-state" data-account-totp-state></span>
    </div>
    <div class="account-totp-body" data-account-totp-body></div>
  </section>`;
}

function accountTotpTimestampMs(value) {
  if (value == null || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function accountTotpDateLabel(value) {
  const timestamp = accountTotpTimestampMs(value);
  if (!timestamp) return "尚无记录";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function createAccountTotpController(modal, account) {
  const accountId = String(account?.id || "").trim();
  const basePath = `/api/persona_dashboard/automation/accounts/${encodeURIComponent(accountId)}/totp`;
  const section = modal.querySelector("[data-account-totp-section]");
  const body = section?.querySelector("[data-account-totp-body]");
  const stateNode = section?.querySelector("[data-account-totp-state]");
  const requestController = new AbortController();
  let closed = false;
  let countdownTimer = 0;
  let boundaryTimer = 0;
  let viewGeneration = 0;
  let lastTotp = null;
  let lastCode = null;
  let lastCodeReceivedAt = 0;

  const clearCodeTimers = () => {
    if (countdownTimer) window.clearInterval(countdownTimer);
    if (boundaryTimer) window.clearTimeout(boundaryTimer);
    countdownTimer = 0;
    boundaryTimer = 0;
  };

  const setState = (status = "", configured = false) => {
    if (!stateNode) return;
    stateNode.textContent = accountTotpStatusLabel(status, configured);
    stateNode.dataset.totpStatus = String(status || "").trim().toLowerCase();
    stateNode.classList.toggle("is-configured", configured);
  };

  const setMessage = (message = "", tone = "") => {
    const node = body?.querySelector("[data-account-totp-message]");
    if (!node) return;
    node.textContent = String(message || "");
    node.dataset.tone = tone;
    node.hidden = !message;
  };

  const renderEntry = ({ configured = false, message = "" } = {}) => {
    clearCodeTimers();
    viewGeneration += 1;
    setState(account?.totp_status, configured);
    if (!body) return;
    body.innerHTML = `
      <div class="account-totp-entry">
        <label>
          <span>${configured ? "新的 2FA 密钥" : "2FA 密钥"}</span>
          <input type="password" data-account-totp-secret placeholder="输入 Base32 或 otpauth://..." autocomplete="off" autocapitalize="off" spellcheck="false" />
        </label>
        <div class="account-totp-entry-actions">
          ${configured ? `<button type="button" data-account-totp-update-cancel>取消</button>` : ""}
          <button type="button" class="primary" data-account-totp-submit>${configured ? "更新 2FA" : "添加 2FA"}</button>
        </div>
      </div>
      <p class="account-totp-message" data-account-totp-message hidden></p>`;
    if (message) setMessage(message, "success");
    body.querySelector("[data-account-totp-secret]")?.focus();
  };

  const renderCodeCard = (totp = {}, currentCode = null) => {
    clearCodeTimers();
    setState(totp?.status, true);
    if (!body) return;
    body.innerHTML = `
      <div class="account-totp-code-card">
        <div class="account-totp-code-main">
          <span>当前验证码</span>
          <strong data-account-totp-code>------</strong>
        </div>
        <div class="account-totp-countdown">
          <span>剩余时间</span>
          <strong data-account-totp-countdown>同步中</strong>
        </div>
        <dl class="account-totp-meta">
          <div><dt>更新时间</dt><dd data-account-totp-updated>尚无记录</dd></div>
          <div><dt>最近验证</dt><dd data-account-totp-verified>尚无记录</dd></div>
        </dl>
        <div class="account-totp-code-actions">
          <button type="button" data-account-totp-update>更新密钥</button>
          <button type="button" class="danger" data-account-totp-delete>移除 2FA</button>
        </div>
      </div>
      <p class="account-totp-message" data-account-totp-message hidden></p>`;
    body.querySelector("[data-account-totp-updated]").textContent = accountTotpDateLabel(totp?.updated_at);
    body.querySelector("[data-account-totp-verified]").textContent = accountTotpDateLabel(totp?.last_verified_at);
    if (currentCode) {
      body.querySelector("[data-account-totp-code]").textContent = String(currentCode.code || "------");
    }
  };

  const scheduleAtBoundary = (currentCode = {}, responseReceivedAt = Date.now()) => {
    const countdown = body?.querySelector("[data-account-totp-countdown]");
    if (!countdown) return;
    const serverTime = accountTotpTimestampMs(currentCode.server_time);
    const validForMs = Math.max(0, Number(currentCode.valid_for_seconds || 0) * 1000);
    const expiresAt = accountTotpTimestampMs(currentCode.expires_at)
      || (serverTime && validForMs ? serverTime + validForMs : 0);
    if (!serverTime || !expiresAt) {
      countdown.textContent = "时间不可用";
      return;
    }
    const serverNow = () => serverTime + (Date.now() - responseReceivedAt);
    const updateCountdown = () => {
      const remaining = Math.max(0, expiresAt - serverNow());
      countdown.textContent = `${Math.ceil(remaining / 1000)} 秒`;
    };
    updateCountdown();
    countdownTimer = window.setInterval(updateCountdown, 250);
    boundaryTimer = window.setTimeout(() => {
      clearCodeTimers();
      void refreshCode();
    }, Math.max(50, expiresAt - serverNow() + 50));
  };

  const refreshCode = async () => {
    const requestGeneration = ++viewGeneration;
    try {
      const result = await api(`${basePath}/code`, {
        cache: "no-store",
        signal: requestController.signal,
      });
      if (closed || requestGeneration !== viewGeneration) return;
      const totp = result?.totp || {};
      applyAccountTotpState(accountId, totp);
      if (totp.configured === false) {
        lastTotp = null;
        lastCode = null;
        lastCodeReceivedAt = 0;
        renderEntry({ configured: false });
        return;
      }
      lastTotp = totp;
      lastCode = result?.current_code || {};
      lastCodeReceivedAt = Date.now();
      renderCodeCard(lastTotp, lastCode);
      scheduleAtBoundary(lastCode, lastCodeReceivedAt);
    } catch (error) {
      if (closed || error?.name === "AbortError" || requestGeneration !== viewGeneration) return;
      if (Number(error?.status || 0) === 404) {
        const cleared = {
          configured: false,
          status: "disabled",
          updated_at: null,
          last_verified_at: null,
        };
        applyAccountTotpState(accountId, cleared);
        lastTotp = null;
        lastCode = null;
        lastCodeReceivedAt = 0;
        renderEntry({ configured: false });
        return;
      }
      clearCodeTimers();
      const code = body?.querySelector("[data-account-totp-code]");
      const countdown = body?.querySelector("[data-account-totp-countdown]");
      if (code) code.textContent = "------";
      if (countdown) countdown.textContent = "同步失败";
      setMessage(error.detail || error.message || "读取验证码失败。", "error");
    }
  };

  const submit = async (button) => {
    const input = body?.querySelector("[data-account-totp-secret]");
    const secretOrUri = String(input?.value || "").trim();
    if (!secretOrUri) {
      setMessage("请输入 Base32 密钥或 otpauth URI。", "error");
      input?.focus();
      return;
    }
    if (input) input.value = "";
    const requestGeneration = ++viewGeneration;
    button.disabled = true;
    setMessage("");
    try {
      const result = await api(basePath, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret_or_uri: secretOrUri }),
        signal: requestController.signal,
      });
      if (closed || requestGeneration !== viewGeneration) return;
      const totp = result?.totp || {
        configured: true,
        status: "configured",
        updated_at: Date.now() / 1000,
        last_verified_at: account?.totp_last_verified_at || null,
      };
      applyAccountTotpState(accountId, totp);
      const currentCode = result?.current_code || null;
      if (currentCode) {
        lastTotp = totp;
        lastCode = currentCode;
        lastCodeReceivedAt = Date.now();
        renderCodeCard(lastTotp, lastCode);
        scheduleAtBoundary(lastCode, lastCodeReceivedAt);
      } else {
        renderCodeCard(totp);
        await refreshCode();
      }
    } catch (error) {
      if (closed || error?.name === "AbortError" || requestGeneration !== viewGeneration) return;
      setMessage(error.detail || error.message || "保存 2FA 失败。", "error");
      body?.querySelector("[data-account-totp-secret]")?.focus();
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  };

  const remove = async (button) => {
    if (button.dataset.totpConfirm !== "true") {
      button.dataset.totpConfirm = "true";
      button.textContent = "确认移除";
      setMessage("再次点击确认移除该账号的 2FA。", "warning");
      return;
    }
    const requestGeneration = ++viewGeneration;
    clearCodeTimers();
    button.disabled = true;
    try {
      const result = await api(basePath, {
        method: "DELETE",
        signal: requestController.signal,
      });
      if (closed || requestGeneration !== viewGeneration) return;
      const cleared = result?.totp || {
        configured: false,
        status: "disabled",
        updated_at: null,
        last_verified_at: null,
      };
      applyAccountTotpState(accountId, cleared);
      lastTotp = null;
      lastCode = null;
      lastCodeReceivedAt = 0;
      renderEntry({ configured: false, message: "2FA 已移除。" });
    } catch (error) {
      if (closed || error?.name === "AbortError" || requestGeneration !== viewGeneration) return;
      button.disabled = false;
      setMessage(error.detail || error.message || "移除 2FA 失败。", "error");
    }
  };

  if (account?.totp_configured) {
    renderCodeCard({
      configured: true,
      status: account.totp_status,
      updated_at: account.totp_updated_at,
      last_verified_at: account.totp_last_verified_at,
    });
    void refreshCode();
  } else {
    renderEntry();
  }

  return {
    submit,
    remove,
    showUpdate() {
      renderEntry({ configured: true });
    },
    cancelUpdate() {
      if (lastCode) {
        renderCodeCard(lastTotp || {}, lastCode);
        scheduleAtBoundary(lastCode, lastCodeReceivedAt);
        return;
      }
      renderCodeCard({
        configured: true,
        status: account.totp_status,
        updated_at: account.totp_updated_at,
        last_verified_at: account.totp_last_verified_at,
      });
      void refreshCode();
    },
    close() {
      if (closed) return;
      closed = true;
      viewGeneration += 1;
      clearCodeTimers();
      requestController.abort();
    },
  };
}

function openAccountPoolEditModal(accountId = "") {
  const account = accountPoolAccounts().find((item) => String(item.id || "") === String(accountId || ""))
    || state.socialAccounts.find((item) => String(item.id || "") === String(accountId || ""));
  if (!account) {
    showMsg("socialMsg", "账号不存在，请刷新后重试。", false);
    return;
  }
  closeConsoleModal(null);
  const modal = document.createElement("div");
  modal.id = "consoleModal";
  modal.className = "console-modal";
  modal.dataset.selectedProxyId = String(account.proxy_id || "").trim();
  modal.dataset.originalProxyId = String(account.proxy_id || "").trim();
  modal.dataset.accountProxyDirty = "false";
  modal.innerHTML = `
    <div class="console-modal-backdrop" data-account-pool-edit-cancel></div>
    <section class="console-modal-dialog account-pool-create-modal" role="dialog" aria-modal="true" aria-labelledby="accountPoolEditModalTitle">
      <div class="console-modal-head">
        <strong id="accountPoolEditModalTitle">编辑账号</strong>
      </div>
      <div class="console-modal-content">
        <div class="account-pool-create-modal-body">
          <p>平台：${esc(platformLabel(account.platform || normalizeAccountPoolPlatform()))}</p>
          <div class="account-create-form account-create-form--modal">
            <label>
              <span>账号用户名</span>
              <input id="accountPoolEditUsername" value="${esc(account.username || "")}" placeholder="例如：liliacvuiy575" autocomplete="off" />
            </label>
            <label>
              <span>登录账号（可选）</span>
              <input id="accountPoolEditLoginUsername" value="${esc(account.login_username || account.username || "")}" placeholder="默认同账号用户名" autocomplete="off" />
            </label>
            ${renderAccountPasswordField(account, { scope: "pool-edit", inputId: "accountPoolEditLoginPassword" })}
            <label>
              <span>显示名称（可选）</span>
              <input id="accountPoolEditDisplayName" value="${esc(account.display_name || "")}" placeholder="用于区分账号，可留空" autocomplete="off" />
            </label>
          </div>
          ${renderAccountTotpSection(account)}
          ${renderAccountProxyPickerPanel(account)}
        </div>
      </div>
      <div class="console-modal-actions">
        <button type="button" data-account-pool-edit-cancel>取消</button>
        <button type="button" class="primary" data-account-pool-edit-save="${esc(account.id)}">保存修改</button>
      </div>
    </section>`;
  document.body.appendChild(modal);
  const totpController = createAccountTotpController(modal, account);
  $("accountPoolEditUsername")?.focus();
  modal.__cleanup = () => {
    totpController.close();
    clearAccountPasswordReveal(account.id, "pool-edit");
  };
  const close = () => {
    modal.__cleanup();
    modal.remove();
  };
  modal.addEventListener("click", (event) => {
    const totpSubmit = event.target.closest("[data-account-totp-submit]");
    if (totpSubmit) {
      void totpController.submit(totpSubmit);
      return;
    }
    if (event.target.closest("[data-account-totp-update]")) {
      totpController.showUpdate();
      return;
    }
    if (event.target.closest("[data-account-totp-update-cancel]")) {
      totpController.cancelUpdate();
      return;
    }
    const totpDelete = event.target.closest("[data-account-totp-delete]");
    if (totpDelete) {
      void totpController.remove(totpDelete);
      return;
    }
    const passwordToggle = event.target.closest("[data-account-password-toggle]");
    if (passwordToggle) {
      toggleAccountPasswordVisibility(passwordToggle)
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "读取登录密码失败", false));
      return;
    }
    if (event.target.closest("[data-account-pool-edit-cancel]")) {
      close();
      return;
    }
    const toggle = event.target.closest("[data-account-proxy-inline-toggle]");
    if (toggle) {
      const options = modal.querySelector("[data-account-proxy-inline-options]");
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      if (options) options.hidden = expanded;
      return;
    }
    const choice = event.target.closest("[data-account-proxy-choice]");
    if (choice) {
      if (choice.disabled) return;
      updateAccountProxyChoice(modal, choice.dataset.accountProxyChoice || "");
      return;
    }
    const saveButton = event.target.closest("[data-account-pool-edit-save]");
    if (!saveButton) return;
    saveButton.disabled = true;
    saveAccountPoolEditForm(saveButton.dataset.accountPoolEditSave || "")
      .then((saved) => {
        if (saved !== false) close();
        else saveButton.disabled = false;
      })
      .catch(async (error) => {
        saveButton.disabled = false;
        const reconciled = await reconcileAccountProxyBindingConflict(modal, saveButton.dataset.accountPoolEditSave || "", error);
        showMsg("socialMsg", reconciled ? "代理绑定已更新，其他编辑内容仍保留，请确认后重新保存。" : (error.detail || error.message || "保存账号失败"), false);
      });
  });
  modal.addEventListener("input", (event) => {
    const passwordInput = event.target.closest?.("[data-account-password-input]");
    if (passwordInput) passwordInput.dataset.passwordDirty = "true";
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

async function saveAccountPoolEditForm(accountId = "") {
  const cleanId = String(accountId || "").trim();
  if (!cleanId) return false;
  const account = accountById(cleanId);
  const username = String($("accountPoolEditUsername")?.value || "").trim().replace(/^@+/, "");
  if (!username) {
    showMsg("socialMsg", "请填写账号用户名。", false);
    return false;
  }
  const payload = {
    username,
    display_name: String($("accountPoolEditDisplayName")?.value || "").trim(),
    login_username: String($("accountPoolEditLoginUsername")?.value || "").trim() || username,
  };
  const loginPasswordInput = $("accountPoolEditLoginPassword");
  const loginPassword = loginPasswordInput?.dataset.passwordDirty === "true" ? String(loginPasswordInput.value || "") : "";
  if (loginPassword) payload.login_password = loginPassword;
  const editModal = $("consoleModal");
  const selectedProxyId = String(editModal?.dataset.selectedProxyId || "").trim();
  const originalProxyId = String(editModal?.dataset.originalProxyId || account?.proxy_id || "").trim();
  if (accountProxyBindingChanged(originalProxyId, selectedProxyId)) {
    payload.expected_proxy_id = originalProxyId;
    if (selectedProxyId) payload.proxy_id = selectedProxyId;
    else payload.clear_residential_proxy = true;
  }
  const result = await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(cleanId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  state.accountPoolAccountId = String(result.account?.id || cleanId);
  await loadSocial({ force: true });
  renderSocialAccounts();
  if (isPersonaWorkspaceModule()) renderPersonaDetail();
  showMsg("socialMsg", "账号资料已保存。", true);
  return true;
}

function renderAccountPoolPersonaSidebar(selectedAccount) {
  const boundPersonaId = String(selectedAccount?.persona_id || "");
  const targetPersonaId = String(state.accountPoolPersonaId || boundPersonaId || "").trim();
  const selectedCount = accountPoolSelectedIds().length;
  return `
    <aside class="persona-list-shell account-pool-persona-shell">
      <div class="persona-inline-panel persona-list-toolbar">
        <div class="persona-list-head persona-list-head--queue">
          <div>
            <strong>人设列表</strong>
            <span>${esc(selectedCount === 1 ? "已选 1 个账号，点击绑定" : selectedCount > 1 ? "同一平台只能选择 1 个账号绑定" : "先选择一个账号，再点绑定")}</span>
          </div>
          <span>${esc(`${state.personas.length} 个`)}</span>
        </div>
      </div>
      ${renderPersonaCollectionList({
        context: "account_pool",
        selectedIds: targetPersonaId ? [targetPersonaId] : [],
        allowEdit: false,
        allowGroupEdit: false,
        allowReorder: true,
      })}
    </aside>`;
}

function renderAccountPool() {
  state.accountPoolPlatform = normalizeAccountPoolPlatform();
  const accounts = accountPoolAccounts();
  const selectedAccount = selectedAccountPoolAccount();
  return `
    <div class="account-pool-layout">
      <section class="account-pool-main">
        <div class="account-pool-head">
          <div>
            <strong>账号池</strong>
            <span>平台和账号分开选择，再到右侧人设列表绑定。</span>
          </div>
        </div>
        <div class="account-pool-body">
          ${renderAccountPoolPlatformTabs()}
          ${renderAccountPoolCards(accounts, selectedAccount)}
          ${renderAccountPoolAutomationPanel(selectedAccount)}
          ${renderAccountPoolCreatePanel()}
        </div>
      </section>
      ${renderAccountPoolPersonaSidebar(selectedAccount)}
    </div>`;
}

async function bindAccountPoolAccountToPersona(personaId = "") {
  if (state.accountPoolBinding) return;
  const cleanPersonaId = String(personaId || "").trim();
  if (!cleanPersonaId) return;
  const accounts = selectedAccountPoolAccounts();
  if (!accounts.length) {
    showMsg("socialMsg", "请先选择要绑定的账号。", false);
    return;
  }
  if (accounts.length !== 1) {
    showMsg("socialMsg", "同一人设在同一平台只能绑定一个账号，请只勾选一个账号。", false);
    return;
  }
  const account = accounts[0];
  const replacedAccount = (state.socialAccounts || []).find((item) => (
    String(item.id || "") !== String(account.id || "")
    && String(item.persona_id || "").trim() === cleanPersonaId
    && String(item.platform || "").trim().toLowerCase() === String(account.platform || "").trim().toLowerCase()
  ));
  state.accountPoolBinding = true;
  renderSocialAccounts();
  try {
    await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(account.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona_id: cleanPersonaId, replace_existing_binding: true }),
    });
    state.accountPoolAccountId = String(account.id || "");
    await loadSocial({ force: true });
    showMsg("socialMsg", replacedAccount ? "已切换人设绑定账号。" : "账号已绑定到人设。", true);
  } finally {
    state.accountPoolBinding = false;
    renderSocialAccounts();
  }
}

async function runAccountPoolThreadsTask(kind) {
  const mode = ["reply_comment", "reply_hot", "warmup"].includes(String(kind || "")) ? String(kind || "") : accountPoolAutomationMode();
  const account = selectedAccountPoolAccount();
  const persona = account?.persona_id
    ? state.personas.find((item) => String(item.id || "") === String(account.persona_id || ""))
    : null;
  if (!account) {
    showMsg("socialMsg", "请先选择一个 Threads 执行账号。", false);
    return;
  }
  if (String(account.platform || "").trim().toLowerCase() !== "threads") {
    showMsg("socialMsg", "自动回复和养号当前只支持 Threads 账号。", false);
    return;
  }
  if (!persona) {
    showMsg("socialMsg", "请先把当前账号绑定到一个人设。", false);
    return;
  }
  setAccountPoolAutomationContext(account);
  const taskType = mode === "warmup" ? "threads_warmup" : "threads_auto_reply";
  const lockParts = ["social", account.id, taskType];
  if (isActionLocked(...lockParts) || activeSocialTaskFor({ accountId: account.id, taskType })) {
    showMsg("socialMsg", `该账号已有${mode === "warmup" ? "养号" : "自动回复"}任务在队列或执行中，请等待完成。`, false);
    return;
  }
  const payload = buildAccountPoolThreadsTaskPayload(mode);
  setActionLocked(lockParts, true);
  renderSocialAccounts();
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
        payload,
      }),
    });
    showMsg("socialMsg", `${mode === "warmup" ? "养号" : "自动回复"}任务已提交：${result.task?.id || ""}`, true, {
      key: result.task?.id ? socialTaskToastKey(result.task.id, result.task) : undefined,
      kind: "queued",
      taskId: result.task?.id || "",
      taskPanel: "persona",
      personaId: persona.id,
    });
  } finally {
    setActionLocked(lockParts, false);
    renderSocialAccounts();
  }
}

async function unbindAccountPoolAccount(accountId = "") {
  const cleanAccountId = String(accountId || "").trim();
  if (!cleanAccountId) return;
  await api(`/api/persona_dashboard/automation/accounts/${encodeURIComponent(cleanAccountId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona_id: "" }),
  });
  showMsg("socialMsg", "账号已解绑。", true);
  await loadSocial();
}

function proxyPoolRows() {
  return Array.isArray(state.socialProxies) ? state.socialProxies : [];
}

function proxyProtocol(proxy = {}) {
  return String(proxy?.protocol || proxy?.proxy_type || "-").trim().toUpperCase();
}

function proxyExitIp(proxy = {}) {
  return String(proxy.exit_ip || proxy.last_check_result?.response?.ip || proxy.last_check_result?.ip || "-").trim() || "-";
}

function proxyBoundAccountCount(proxy = {}) {
  const explicit = Number(proxy.bound_account_count ?? proxy.bound_accounts_count ?? proxy.accounts_count);
  if (Number.isFinite(explicit)) return explicit;
  const proxyId = String(proxy.id || "");
  return (state.socialAccounts || []).filter((account) => String(account.proxy_id || "") === proxyId).length;
}

function proxyStatusLabel(value = "") {
  const clean = String(value || "").trim().toLowerCase();
  return { active: "正常", inactive: "停用", disabled: "停用", failed: "异常", checking: "检测中", pending: "待检测" }[clean] || (value || "-");
}

function proxySourceLabel(value = "") {
  const clean = String(value || "").trim().toLowerCase();
  return { manual: "手动录入", owlproxy: "OwlProxy", provider: "其他购买代理", self_owned: "自有代理" }[clean] || (value || "-");
}

function proxyPurchaseStatusLabel(value = "") {
  return { owned: "自有", leased: "租用" }[String(value || "").trim().toLowerCase()] || "自有";
}

function proxyIpTypeLabel(value = "") {
  return String(value || "static_residential").trim().toLowerCase() === "static_residential" ? "静态住宅" : String(value || "-");
}

function renderEditIcon() {
  return `<svg class="ui-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M4 20h4L19 9l-4-4L4 16v4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
    <path d="m13.5 6.5 4 4" fill="none" stroke="currentColor" stroke-width="1.8" />
  </svg>`;
}

function renderProxyPool() {
  const root = $("proxyPool");
  if (!root) return;
  const rows = proxyPoolRows();
  const pageSize = [10, 20, 50].includes(Number(state.proxyPoolPageSize)) ? Number(state.proxyPoolPageSize) : 10;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  state.proxyPoolPage = Math.min(Math.max(Number(state.proxyPoolPage || 1), 1), totalPages);
  const page = state.proxyPoolPage;
  const offset = (page - 1) * pageSize;
  const pageRows = rows.slice(offset, offset + pageSize);
  const columns = ["序号", "分组", "IP 类型", "来源", "购买状态", "代理名称", "代理资讯", "备注", "代理状态", "代理归属", "出口 IP", "已绑账号", "代理协议", "有效时间", "操作"];
  root.innerHTML = `
    <section class="proxy-pool-panel">
      <div class="proxy-pool-head">
        <div><strong>代理 IP</strong><span>独立维护代理信息并查看账号绑定情况。</span></div>
        <button type="button" class="primary proxy-pool-add" data-proxy-add>${renderPlusIcon()}<span>新增代理</span></button>
      </div>
      <div class="proxy-table-wrap">
        <div class="proxy-table" role="table" aria-label="代理 IP 列表">
          <div class="proxy-table-row proxy-table-row--head" role="row">${columns.map((column) => `<span role="columnheader">${column}</span>`).join("")}</div>
          ${pageRows.length ? pageRows.map((proxy, index) => {
            const endpoint = [String(proxy.host || "").trim(), String(proxy.port || "").trim()].filter(Boolean).join(":") || "-";
            const country = String(proxy.country || "").trim() || "待识别";
            const authLabel = proxy.username_configured || proxy.password_configured ? "需认证" : "无认证";
            return `<div class="proxy-table-row" role="row">
              <span role="cell" class="proxy-detail-cell proxy-numeric" data-mobile-label="序号">${offset + index + 1}</span>
              <span role="cell" class="proxy-detail-cell" data-mobile-label="分组">未分组</span>
              <span role="cell" class="proxy-detail-cell" data-mobile-label="IP 类型">${esc(proxyIpTypeLabel(proxy.ip_type))}</span>
              <span role="cell" class="proxy-detail-cell" data-mobile-label="来源">${esc(proxySourceLabel(proxy.source))}</span>
              <span role="cell" class="proxy-detail-cell" data-mobile-label="购买状态">${esc(proxyPurchaseStatusLabel(proxy.purchase_status))}</span>
              <span role="cell" class="proxy-detail-cell" data-mobile-label="代理名称"><strong>${esc(proxy.name || endpoint)}</strong></span>
              <span role="cell" class="proxy-detail-cell" data-mobile-label="代理资讯"><strong>${esc(endpoint)}</strong><small>${esc(authLabel)}</small></span>
              <span role="cell" class="proxy-detail-cell" data-mobile-label="备注">${esc(proxy.note || "-")}</span>
              <span role="cell" class="proxy-detail-cell proxy-status-stack" data-mobile-label="代理状态"><span class="status ${esc(proxy.status || "")}">${esc(proxyStatusLabel(proxy.status))}</span><small>${proxy.last_check_at ? esc(formatTime(proxy.last_check_at)) : "未检测"}</small></span>
              <span role="cell" class="proxy-detail-cell" data-mobile-label="代理归属">${esc(country)}</span>
              <span role="cell" class="proxy-detail-cell" data-mobile-label="出口 IP">${esc(proxyExitIp(proxy))}</span>
              <span role="cell" class="proxy-detail-cell proxy-numeric" data-mobile-label="已绑账号">${proxyBoundAccountCount(proxy)}</span>
              <span role="cell" class="proxy-detail-cell" data-mobile-label="代理协议">${esc(proxyProtocol(proxy))}</span>
              <span role="cell" class="proxy-detail-cell proxy-numeric" data-mobile-label="有效时间">${proxy.expires_at ? esc(formatTime(proxy.expires_at)) : "长期"}</span>
              <span role="cell" class="proxy-table-actions" data-mobile-label="操作">
                <button type="button" data-proxy-check="${esc(proxy.id)}" title="检测代理" aria-label="检测代理">${renderRefreshIcon()}</button>
                <button type="button" data-proxy-edit="${esc(proxy.id)}" title="编辑代理" aria-label="编辑代理">${renderEditIcon()}</button>
                <button type="button" class="danger" data-proxy-delete="${esc(proxy.id)}" title="${proxyBoundAccountCount(proxy) ? "代理已绑定账号，不能删除" : "删除代理"}" aria-label="删除代理" ${proxyBoundAccountCount(proxy) ? "disabled" : ""}>${renderTrashIcon()}</button>
              </span>
            </div>`;
          }).join("") : `<div class="empty-state proxy-pool-empty">暂无代理 IP，点击新增代理开始配置。</div>`}
        </div>
      </div>
      <div class="proxy-pager">
        <label>每页
          <select data-proxy-page-size>${[10, 20, 50].map((size) => `<option value="${size}" ${pageSize === size ? "selected" : ""}>${size}</option>`).join("")}</select>
        </label>
        <span>共 ${rows.length} 条 · 第 ${page} / ${totalPages} 页</span>
        <div>
          <button type="button" data-proxy-page="prev" title="上一页" aria-label="上一页" ${page <= 1 ? "disabled" : ""}><span class="ui-arrow-icon ui-arrow-icon--left" aria-hidden="true"></span></button>
          <button type="button" data-proxy-page="next" title="下一页" aria-label="下一页" ${page >= totalPages ? "disabled" : ""}><span class="ui-arrow-icon ui-arrow-icon--right" aria-hidden="true"></span></button>
        </div>
      </div>
    </section>`;
}

function proxyFormPayload(proxy = null) {
  return sharedProxyPayload("proxyForm", proxy);
}

function openProxyModal(proxyId = "") {
  const proxy = proxyId ? socialProxyById(proxyId) : null;
  if (proxyId && !proxy) {
    showMsg("socialMsg", "代理不存在，请刷新后重试。", false);
    return;
  }
  closeConsoleModal(null);
  const modal = document.createElement("div");
  modal.id = "consoleModal";
  modal.className = "console-modal";
  modal.innerHTML = `
    <div class="console-modal-backdrop" data-proxy-modal-cancel></div>
    <section class="console-modal-dialog proxy-edit-modal" role="dialog" aria-modal="true" aria-labelledby="proxyModalTitle">
      <div class="console-modal-head"><strong id="proxyModalTitle">${proxy ? "编辑代理" : "新增代理"}</strong></div>
      <div class="console-modal-content proxy-edit-modal-content">
        <div class="proxy-form-grid">
          ${sharedProxyFieldsHtml("proxyForm", proxy)}
        </div>
      </div>
      <div class="console-modal-actions"><button type="button" data-proxy-modal-cancel>取消</button><button type="button" class="primary" data-proxy-modal-save="${esc(proxy?.id || "")}">保存代理</button></div>
    </section>`;
  document.body.appendChild(modal);
  const cachedResult = proxy?.last_check_result && typeof proxy.last_check_result === "object" ? proxy.last_check_result : null;
  if (cachedResult?.ok) {
    const previewResult = { ...cachedResult, detected_proxy_type: proxy.proxy_type };
    renderProxyCheckResult("proxyFormCheckResult", previewResult);
    applyProxyDetectionAutofill("proxyForm", previewResult, {
      proxy_type: proxy.proxy_type,
      host: proxy.host,
      port: proxy.port,
      name: proxy.name,
    });
  }
  $("proxyFormProtocol")?.focus();
  const close = () => modal.remove();
  modal.addEventListener("click", (event) => {
    if (event.target.closest("[data-proxy-modal-cancel]")) { close(); return; }
    const testButton = event.target.closest("[data-proxy-inline-test]");
    if (testButton) {
      testButton.disabled = true;
      testProxyForm("proxyForm", proxy)
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "代理检测失败", false))
        .finally(() => { testButton.disabled = false; });
      return;
    }
    const save = event.target.closest("[data-proxy-modal-save]");
    if (!save) return;
    const payload = proxyFormPayload(proxy);
    if (!payload) return;
    save.disabled = true;
    const id = String(save.dataset.proxyModalSave || "").trim();
    testProxyConfiguration(payload, id, "proxyFormCheckResult", "proxyForm").then((preflight) => {
      if (!preflight.ok) {
        save.disabled = false;
        showMsg("socialMsg", preflight.error || "代理检测未通过，配置尚未保存。", false);
        return null;
      }
      return api(id ? `/api/persona_dashboard/automation/proxies/${encodeURIComponent(id)}` : "/api/persona_dashboard/automation/proxies", {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      });
    }).then(async (data) => {
      if (!data) return;
      close();
      const savedId = String(data?.proxy?.id || id || "").trim();
      let detected = false;
      if (savedId) {
        try {
          const checked = await api(`/api/persona_dashboard/automation/proxies/${encodeURIComponent(savedId)}/check`, { method: "POST" });
          detected = Boolean(checked?.proxy?.last_check_result?.ok);
        } catch (_error) {
          detected = false;
        }
      }
      await refreshProxyPool();
      showMsg("socialMsg", detected ? `${id ? "代理已更新" : "代理已新增"}，出口 IP 和国家已自动识别。` : `${id ? "代理已更新" : "代理已新增"}，自动检测未通过，请检查连接参数后重试。`, detected);
    }).catch((error) => {
      save.disabled = false;
      showMsg("socialMsg", error.detail || error.message || "保存代理失败", false);
    });
  });
  modal.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
}

async function refreshProxyPool() {
  const data = await api("/api/persona_dashboard/automation/proxies");
  state.socialProxies = Array.isArray(data.proxies) ? data.proxies : [];
  renderProxyPool();
}

async function checkProxy(proxyId = "") {
  const cleanId = String(proxyId || "").trim();
  if (!cleanId) return;
  const result = await api(`/api/persona_dashboard/automation/proxies/${encodeURIComponent(cleanId)}/check`, { method: "POST" });
  await refreshProxyPool();
  const ok = Boolean(result?.proxy?.last_check_result?.ok);
  showMsg("socialMsg", ok ? "代理检测正常。" : "代理检测失败，请检查地址、协议或认证信息。", ok);
}

async function deleteProxy(proxyId = "") {
  const cleanId = String(proxyId || "").trim();
  const proxy = socialProxyById(cleanId);
  if (!cleanId || !proxy) return;
  const ok = await confirmDangerAction(`确定删除代理“${proxy.name || proxy.host || cleanId}”吗？`, { title: "删除代理", confirmText: "删除代理" });
  if (!ok) return;
  await api(`/api/persona_dashboard/automation/proxies/${encodeURIComponent(cleanId)}`, { method: "DELETE" });
  await refreshProxyPool();
  showMsg("socialMsg", "代理已删除。", true);
}

function renderSocialAccounts() {
  return withConsoleScrollPreserved(() => {
  syncAccountBrowserPanel();
  const select = $("socialAccount");
  if (select) {
    const accounts = uniqueAccountOptions(state.socialAccounts);
    select.innerHTML = accounts.length
      ? accounts.map((account) => `<option value="${esc(account.id)}" data-platform="${esc(account.platform)}">${esc(accountDisplayName(account))}</option>`).join("")
      : `<option value="">暂无账号</option>`;
    syncStandaloneSocialForm();
  }
  const grid = $("accountGrid");
  renderProxyPool();
  if (state.accountBrowserPanel === "browsers") renderLiveBrowserSessions();
  if (!grid) return;
  grid.innerHTML = renderAccountPool();
  });
}

function setAccountBrowserPanel(panel = "accounts") {
  const scrollSnapshot = snapshotConsoleScrollState();
  const layoutLocks = captureConsoleLayoutLocks();
  try {
  const normalized = ["accounts", "proxies", "browsers"].includes(panel) ? panel : "accounts";
  if (normalized !== "accounts") resetAccountPoolCreateForm();
  state.accountBrowserPanel = normalized;
  syncAccountBrowserPanel();
  if ($("moduleMenu")) syncModuleMenuState();
  if (normalized === "browsers") renderLiveBrowserSessions();
  syncLiveBrowserAutoRefresh();
  } finally {
    restoreConsoleScrollState(scrollSnapshot);
    releaseConsoleLayoutLocks(layoutLocks);
  }
}

function syncAccountBrowserPanel() {
  const active = ["accounts", "proxies", "browsers"].includes(state.accountBrowserPanel) ? state.accountBrowserPanel : "accounts";
  if (active !== "accounts" && state.accountPoolCreateOpen) resetAccountPoolCreateForm();
  const shell = $("accountBrowserShell");
  if (shell) shell.dataset.accountBrowserPanel = active;
  if (state.view === "accounts" && $("viewTitle")) {
    $("viewTitle").textContent = active === "browsers" ? "浏览器列表" : "账号管理自动化";
  }
  const refreshButton = $("refreshAccounts");
  if (refreshButton) {
    const label = active === "proxies" ? "刷新代理" : (active === "browsers" ? "刷新浏览器" : "刷新账号");
    refreshButton.textContent = label;
    refreshButton.setAttribute("aria-label", label);
  }
  document.querySelectorAll("[data-account-browser-tab]").forEach((button) => {
    const selected = String(button.dataset.accountBrowserTab || "") === active;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
  document.querySelectorAll("[data-account-browser-page]").forEach((page) => {
    const selected = String(page.dataset.accountBrowserPage || "") === active;
    page.classList.toggle("is-active", selected);
    page.hidden = !selected;
  });
}

function renderLiveBrowserSessions() {
  const host = $("liveBrowserSessions");
  if (!host) return;
  const sessions = Array.isArray(state.socialBrowserSessions) ? state.socialBrowserSessions : [];
  const layout = normalizeLiveBrowserLayout(state.liveBrowserLayout);
  let panel = host.querySelector(".live-browser-panel");
  if (!panel) {
    if (state.liveBrowserExpandedSessionId) closeLiveBrowserLargeModal({ restoreFocus: false });
    host.innerHTML = `
    <section class="live-browser-panel is-empty" data-live-browser-count="0" data-live-browser-view="${esc(layout)}">
      <div class="live-browser-head">
        <div>
          <strong>实时浏览器监控</strong>
          <span data-live-browser-panel-hint></span>
        </div>
        <div class="live-browser-head-actions">
          <button type="button" class="danger" data-social-cancel-all disabled>停止全部任务</button>
          ${renderLiveBrowserLayoutToggle(layout)}
        </div>
      </div>
      <div class="live-browser-grid"></div>
    </section>
  `;
    panel = host.querySelector(".live-browser-panel");
  }
  const grid = panel?.querySelector(".live-browser-grid");
  if (!panel || !grid) return;
  panel.classList.toggle("is-empty", !sessions.length);
  panel.dataset.liveBrowserCount = String(sessions.length);
  panel.dataset.liveBrowserView = layout;
  const panelHint = panel.querySelector("[data-live-browser-panel-hint]");
  if (panelHint) panelHint.textContent = liveBrowserPanelHint(sessions);

  const cardsById = new Map(Array.from(grid.querySelectorAll("[data-live-browser-card]"))
    .map((card) => [String(card.dataset.liveBrowserCard || ""), card]));
  const desiredIds = new Set(sessions.map((session) => liveBrowserSessionId(session)));
  if (state.liveBrowserExpandedSessionId && !desiredIds.has(String(state.liveBrowserExpandedSessionId))) {
    closeLiveBrowserLargeModal({ restoreFocus: false });
  }
  cardsById.forEach((card, sessionId) => {
    if (!desiredIds.has(sessionId)) card.remove();
  });
  sessions.forEach((session) => {
    const sessionId = liveBrowserSessionId(session);
    const structureKey = liveBrowserSessionStructureKey(session);
    let expanded = String(state.liveBrowserExpandedSessionId || "") === sessionId;
    let card = cardsById.get(sessionId) || null;
    if (!card && expanded) {
      closeLiveBrowserLargeModal({ restoreFocus: false });
      expanded = false;
    }
    if (!card) {
      card = createLiveBrowserSessionCard(session);
      insertLiveBrowserSessionCard(grid, card);
    } else if (!expanded && card.dataset.liveBrowserStructureKey !== structureKey) {
      const replacement = createLiveBrowserSessionCard(session);
      card.replaceWith(replacement);
      card = replacement;
    }
    updateLiveBrowserSessionCard(card, session);
    if (expanded) {
      card.classList.add("is-live-browser-modal");
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-modal", "true");
      card.setAttribute("aria-labelledby", liveBrowserDialogTitleId(sessionId));
    }
  });
  syncLiveBrowserPlaceholders(grid, sessions.length);
  if (state.liveBrowserExpandedSessionId) {
    const expandedCard = grid.querySelector(`[data-live-browser-card="${CSS.escape(String(state.liveBrowserExpandedSessionId))}"]`);
    isolateLiveBrowserModalBackground(expandedCard, document.querySelector("[data-live-browser-modal-backdrop]"));
  }
  syncSocialCancelAllButtons();
}

function liveBrowserSessionId(session) {
  return String(session?.id || session?.session_id || "");
}

function liveBrowserSessionStructureKey(session) {
  return JSON.stringify([
    // The public Kasm/noVNC URL is session-scoped. Query/path tokens can be
    // refreshed by polling, but rebuilding the card for those changes
    // destroys the iframe and resets the remote page scroll position.
    liveBrowserSessionId(session),
    Math.max(1, Number(session?.width || 1280)),
    Math.max(1, Number(session?.height || 720)),
  ]);
}

function createLiveBrowserSessionCard(session) {
  const template = document.createElement("template");
  template.innerHTML = renderLiveBrowserSession(session).trim();
  const card = template.content.firstElementChild;
  card.dataset.liveBrowserStructureKey = liveBrowserSessionStructureKey(session);
  return card;
}

function syncSocialCancelAllButtons() {
  const activeTaskCount = (Array.isArray(state.socialTasks) ? state.socialTasks : [])
    .filter((task) => activeSocialAutomationTask(task)).length;
  document.querySelectorAll("[data-social-cancel-all]").forEach((button) => {
    const pending = Boolean(state.socialCancelAllPending);
    button.disabled = pending || !activeTaskCount;
    button.setAttribute("aria-busy", pending ? "true" : "false");
    button.textContent = pending ? "停止中..." : "停止全部任务";
  });
}

function updateLiveBrowserSessionCard(card, session) {
  if (!card) return;
  const sessionId = liveBrowserSessionId(session);
  const status = liveBrowserTaskStatus(session);
  const presentationStatus = liveBrowserPresentationStatus(session);
  const sessionStatus = liveBrowserSessionStatus(session);
  const tone = statusTone(presentationStatus || "running");
  const statusToneClass = presentationStatus === "success" ? "success" : (tone === "success" ? "muted" : tone);
  const interactionAllowed = canInteractWithLiveBrowser(session);
  const canCloseWindow = Boolean(sessionId) && sessionStatus === "standby";
  const canStopTask = Boolean(session.task_id) && ["queued", "running", "need_manual"].includes(status);
  const title = `${session.account_username || session.account_id || "执行账号"} · ${statusLabel(session.task_type || "浏览器任务")}`;
  const meta = `${session.platform || "-"} · ${session.display || "-"} · ${session.width || 720}x${session.height || 1280}`;

  card.dataset.liveBrowserCard = sessionId;
  ["active", "queued", "manual", "success", "error", "muted"].forEach((name) => {
    card.classList.toggle(`is-status-${name}`, statusToneClass === name);
  });
  card.classList.toggle("is-interaction-enabled", interactionAllowed);
  card.classList.toggle("is-interaction-locked", !interactionAllowed);
  const titleNode = card.querySelector("[data-live-browser-title]");
  if (titleNode) {
    titleNode.id = liveBrowserDialogTitleId(sessionId);
    titleNode.textContent = title;
  }
  const metaNode = card.querySelector("[data-live-browser-meta]");
  if (metaNode) metaNode.textContent = meta;
  const iframe = card.querySelector("iframe");
  if (iframe) iframe.title = title;
  const statusNode = card.querySelector("[data-live-browser-status]");
  if (statusNode) {
    statusNode.className = `status ${presentationStatus}`;
    statusNode.textContent = liveBrowserPresentationLabel(session);
  }
  const expandButton = card.querySelector("[data-live-browser-fullscreen]");
  if (expandButton) {
    const expanded = String(state.liveBrowserExpandedSessionId || "") === sessionId;
    expandButton.disabled = false;
    expandButton.setAttribute("aria-label", expanded ? "收起窗口" : "放大窗口");
    expandButton.setAttribute("title", expanded ? "收起窗口" : "放大窗口");
    expandButton.setAttribute("aria-pressed", expanded ? "true" : "false");
    expandButton.innerHTML = renderExpandIcon(expanded);
  }
  card.querySelector("[data-live-browser-text]")?.toggleAttribute("disabled", !interactionAllowed);
  card.querySelector("[data-live-browser-type]")?.toggleAttribute("disabled", !interactionAllowed);
  card.querySelector("[data-live-browser-key]")?.toggleAttribute("disabled", !interactionAllowed);
  const closeButton = card.querySelector("[data-live-browser-close]");
  if (closeButton) {
    closeButton.hidden = !canCloseWindow;
    closeButton.disabled = !canCloseWindow;
  }
  const stopButton = card.querySelector("[data-social-cancel]");
  if (stopButton) {
    stopButton.dataset.socialCancel = String(session.task_id || "");
    stopButton.hidden = !canStopTask;
    stopButton.disabled = !canStopTask;
  }
  const loginMode = liveBrowserLoginMode(session);
  card.querySelectorAll(".live-browser-mode-toggle button").forEach((button) => {
    const buttonMode = button.dataset.liveBrowserMode || "automatic";
    const active = buttonMode === loginMode;
    button.classList.toggle("is-active", active);
    button.classList.toggle("is-pending", buttonMode === "manual" && ["switching", "takeover_timeout"].includes(loginMode));
    button.setAttribute("aria-pressed", active ? "true" : "false");
    if (buttonMode === "manual") {
      button.dataset.liveBrowserModeSession = sessionId;
      button.textContent = loginMode === "switching" ? "再次强制接管" : (loginMode === "takeover_timeout" ? "重试接管" : "人工接管");
      button.disabled = !sessionId || !["running", "need_manual"].includes(status);
    } else {
      button.disabled = true;
    }
  });
  const note = card.querySelector(".live-browser-interaction-note");
  if (note) note.textContent = liveBrowserInteractionHint(session);
}

function renderLiveBrowserLayoutToggle(layout = state.liveBrowserLayout) {
  const activeLayout = normalizeLiveBrowserLayout(layout);
  return `
    <div class="persona-draft-view-toggle live-browser-layout-toggle" aria-label="浏览器窗口布局">
      <button type="button" class="${activeLayout === "grid" ? "is-active" : ""}" data-live-browser-layout="grid" title="格子布局" aria-label="格子布局" aria-pressed="${activeLayout === "grid" ? "true" : "false"}">
        <span class="persona-draft-mode-icon persona-draft-mode-icon--grid" aria-hidden="true"></span>
      </button>
      <button type="button" class="${activeLayout === "list" ? "is-active" : ""}" data-live-browser-layout="list" title="列表布局" aria-label="列表布局" aria-pressed="${activeLayout === "list" ? "true" : "false"}">
        <span class="persona-draft-mode-icon persona-draft-mode-icon--list" aria-hidden="true"></span>
      </button>
    </div>`;
}

function setLiveBrowserLayout(layout = "grid") {
  const nextLayout = normalizeLiveBrowserLayout(layout);
  state.liveBrowserLayout = nextLayout;
  try {
    window.localStorage.setItem(LIVE_BROWSER_LAYOUT_KEY, nextLayout);
  } catch {}
  const panel = $("liveBrowserSessions")?.querySelector(".live-browser-panel");
  if (panel) panel.dataset.liveBrowserView = nextLayout;
  document.querySelectorAll("[data-live-browser-layout]").forEach((button) => {
    const active = String(button.dataset.liveBrowserLayout || "") === nextLayout;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function syncLiveBrowserPlaceholders(grid, sessionCount = 0) {
  if (!grid) return;
  const desiredCount = Math.max(0, Math.min(2, 2 - Number(sessionCount || 0)));
  const existing = Array.from(grid.querySelectorAll("[data-live-browser-placeholder]"));
  existing.slice(desiredCount).forEach((node) => node.remove());
  const missingCount = Math.max(0, desiredCount - existing.length);
  if (!missingCount) return;
  const startIndex = existing.length + 1;
  const markup = Array.from({ length: missingCount }, (_, index) => renderLiveBrowserPlaceholder(startIndex + index)).join("");
  grid.insertAdjacentHTML("beforeend", markup);
}

function insertLiveBrowserSessionCard(grid, card) {
  if (!grid || !card) return;
  const firstPlaceholder = grid.querySelector("[data-live-browser-placeholder]");
  grid.insertBefore(card, firstPlaceholder || null);
}

function renderLiveBrowserPlaceholder(index = 1) {
  return `
    <article class="live-browser-card live-browser-placeholder" data-live-browser-placeholder aria-label="实时浏览器占位框 ${index}">
      <div class="live-browser-placeholder-body">
        <strong>等待浏览器窗口 ${index}</strong>
        <span>运行账号登录或发布任务后，实时画面会添加到这里。</span>
      </div>
    </article>
  `;
}

function liveBrowserTaskStatus(session) {
  return String(session?.task_status || session?.status || "running").trim().toLowerCase() || "running";
}

function isManualOpenLoginSession(session) {
  return String(session?.task_type || "").trim().toLowerCase() === "open_login"
    && ["running", "need_manual"].includes(liveBrowserTaskStatus(session))
    && Boolean(session?.input_allowed);
}

function liveBrowserLoginMode(session) {
  if (String(session?.task_type || "").trim().toLowerCase() !== "open_login") return "";
  const mode = String(session?.login_mode || "").trim().toLowerCase();
  if (mode === "switching") return "switching";
  if (mode === "takeover_timeout") return "takeover_timeout";
  if (mode === "manual") return "manual";
  return isManualOpenLoginSession(session) || liveBrowserTaskStatus(session) === "need_manual" ? "manual" : "automatic";
}

function renderLiveBrowserModeToggle(session) {
  if (String(session?.task_type || "").trim().toLowerCase() !== "open_login") return "";
  const sessionId = liveBrowserSessionId(session);
  const mode = liveBrowserLoginMode(session);
  const active = ["running", "need_manual"].includes(liveBrowserTaskStatus(session));
  const switching = mode === "switching";
  const takeoverTimedOut = mode === "takeover_timeout";
  return `
    <div class="live-browser-mode-toggle" role="group" aria-label="登录操作模式">
      <button type="button" class="${mode === "automatic" ? "is-active" : ""}" aria-pressed="${mode === "automatic" ? "true" : "false"}" disabled>自动登录</button>
      <button type="button" class="${mode === "manual" ? "is-active" : ""}${switching || takeoverTimedOut ? " is-pending" : ""}" data-live-browser-mode="manual" data-live-browser-mode-session="${esc(sessionId)}" aria-pressed="${mode === "manual" ? "true" : "false"}" ${active && sessionId ? "" : "disabled"}>${switching ? "再次强制接管" : (takeoverTimedOut ? "重试接管" : "人工接管")}</button>
    </div>`;
}

function liveBrowserIsReady(session) {
  if (Object.prototype.hasOwnProperty.call(session || {}, "browser_ready")) {
    return Boolean(session?.browser_ready);
  }
  return true;
}

function isOpenLoginBrowserStarting(session) {
  return String(session?.task_type || "").trim().toLowerCase() === "open_login"
    && liveBrowserTaskStatus(session) === "running"
    && !liveBrowserIsReady(session);
}

function liveBrowserPresentationStatus(session) {
  if (isOpenLoginBrowserStarting(session)) return "browser_launch";
  return isManualOpenLoginSession(session) ? "need_manual" : liveBrowserTaskStatus(session);
}

function liveBrowserPresentationLabel(session) {
  if (isOpenLoginBrowserStarting(session)) return "Camoufox 启动中";
  return isManualOpenLoginSession(session) ? "人工登录" : statusLabel(liveBrowserTaskStatus(session));
}

function liveBrowserSessionStatus(session) {
  return String(session?.status || "running").trim().toLowerCase() || "running";
}

function liveBrowserPanelHint(sessions = []) {
  if (!Array.isArray(sessions) || !sessions.length) {
    return "暂无运行中的浏览器窗口。发布或自动化任务运行后会自动追加到下方。";
  }
  const manualCount = sessions.filter((session) => canInteractWithLiveBrowser(session)).length;
  if (manualCount > 0) {
    return `${sessions.length} 个浏览器正在运行，其中 ${manualCount} 个需要人工处理，可在对应窗口操作。`;
  }
  return `${sessions.length} 个浏览器正在运行，当前仅展示实时画面；进入人工处理状态后才可操作。`;
}

function liveBrowserInteractionHint(session) {
  const taskStatus = liveBrowserTaskStatus(session);
  const sessionStatus = liveBrowserSessionStatus(session);
  if (sessionStatus === "standby") return "任务已完成，浏览器处于待机状态，可等待系统自动关闭。";
  if (isOpenLoginBrowserStarting(session)) return "Camoufox 指纹浏览器正在启动，窗口就绪后即可人工操作。";
  if (liveBrowserLoginMode(session) === "switching") return "正在停止自动登录操作，确认后将开放人工输入。";
  if (liveBrowserLoginMode(session) === "takeover_timeout") return "自动登录未能及时停止，人工输入仍保持锁定；可重试接管或停止进程。";
  if (isManualOpenLoginSession(session)) return "当前处于人工登录，可以直接操作浏览器窗口。";
  if (taskStatus === "need_manual") return "当前需要人工处理，可以直接操作浏览器窗口。";
  return "自动化执行中，当前仅展示实时画面，暂不允许人工输入。";
}

function canInteractWithLiveBrowser(session) {
  return liveBrowserIsReady(session)
    && (Boolean(session?.input_allowed) || liveBrowserTaskStatus(session) === "need_manual");
}

function liveBrowserIframeLoadingMode() {
  return !document.hidden && state.accountBrowserPanel === "browsers" ? "eager" : "lazy";
}

function renderLiveBrowserSession(session) {
  const url = liveBrowserSessionUrl(session);
  const title = `${session.account_username || session.account_id || "执行账号"} · ${statusLabel(session.task_type || "浏览器任务")}`;
  const sessionId = liveBrowserSessionId(session);
  const width = Math.max(1, Number(session.width || 1280));
  const height = Math.max(1, Number(session.height || 720));
  const orientationClass = height > width ? " is-portrait" : " is-landscape";
  const status = liveBrowserTaskStatus(session);
  const presentationStatus = liveBrowserPresentationStatus(session);
  const sessionStatus = liveBrowserSessionStatus(session);
  const normalizedStatus = status.trim().toLowerCase();
  const canStopTask = session.task_id && ["queued", "running", "need_manual"].includes(normalizedStatus);
  const tone = statusTone(presentationStatus);
  const statusClass = presentationStatus === "success"
    ? " is-status-success"
    : ` is-status-${tone === "success" ? "muted" : tone}`;
  const interactionAllowed = canInteractWithLiveBrowser(session);
  const interactionClass = interactionAllowed ? " is-interaction-enabled" : " is-interaction-locked";
  const interactionHint = liveBrowserInteractionHint(session);
  const canCloseWindow = sessionId && sessionStatus === "standby";
  return `
    <article class="live-browser-card${orientationClass}${interactionClass}${statusClass}" data-live-browser-card="${esc(sessionId)}" style="--live-browser-width: ${width}; --live-browser-height: ${height}; --live-browser-ratio: ${width} / ${height};">
      <div class="live-browser-card-head">
        <div>
          <strong id="${esc(liveBrowserDialogTitleId(sessionId))}" data-live-browser-title>${esc(title)}</strong>
          <span data-live-browser-meta>${esc(`${session.platform || "-"} · ${session.display || "-"} · ${session.width || 720}x${session.height || 1280}`)}</span>
        </div>
        <div class="live-browser-card-actions">
          ${renderLiveBrowserModeToggle(session)}
          <button type="button" class="live-browser-expand-button" data-live-browser-fullscreen="${esc(sessionId)}" title="放大窗口" aria-label="放大窗口" aria-pressed="false">${renderExpandIcon()}</button>
          <button type="button" data-live-browser-close="${esc(sessionId)}" ${canCloseWindow ? "" : "hidden disabled"}>关闭窗口</button>
          <button type="button" class="danger" data-social-cancel="${esc(session.task_id || "")}" ${canStopTask ? "" : "hidden disabled"}>停止进程</button>
          <span class="status ${esc(presentationStatus)}" data-live-browser-status>${esc(liveBrowserPresentationLabel(session))}</span>
        </div>
      </div>
      <div class="live-browser-frame">
        <iframe
          title="${esc(title)}"
          src="${esc(url)}"
          loading="${liveBrowserIframeLoadingMode()}"
          referrerpolicy="no-referrer"
          allow="clipboard-read; clipboard-write"
          allowfullscreen
        ></iframe>
        <div class="live-browser-lock" aria-hidden="true"><span>自动化执行中，等待进入人工处理状态后再操作。</span></div>
      </div>
      <div class="live-browser-tools" data-live-browser-tools="${esc(sessionId)}">
        <input
          type="text"
          data-live-browser-text="${esc(sessionId)}"
          placeholder="输入验证码或文本"
          autocomplete="off"
          ${interactionAllowed ? "" : "disabled"}
        />
        <button type="button" data-live-browser-type="${esc(sessionId)}" ${interactionAllowed ? "" : "disabled"}>发送</button>
        <button type="button" data-live-browser-key="${esc(sessionId)}" data-live-browser-key-value="Enter" ${interactionAllowed ? "" : "disabled"}>回车</button>
        <button type="button" data-live-browser-screenshot="${esc(sessionId)}" ${sessionId ? "" : "disabled"}>截图</button>
      </div>
      <div class="live-browser-interaction-note">${esc(interactionHint)}</div>
    </article>
  `;
}

let liveBrowserModalTrigger = null;
let liveBrowserModalInertNodes = [];

function liveBrowserDialogTitleId(sessionId = "") {
  const safeId = String(sessionId || "active").replace(/[^a-zA-Z0-9_-]/g, "-");
  return `live-browser-dialog-title-${safeId || "active"}`;
}

function releaseLiveBrowserModalBackground() {
  liveBrowserModalInertNodes.forEach((node) => {
    if (node?.isConnected) node.removeAttribute("inert");
  });
  liveBrowserModalInertNodes = [];
}

function isolateLiveBrowserModalBackground(card, backdrop) {
  releaseLiveBrowserModalBackground();
  if (!card?.isConnected) return;
  let branch = card;
  while (branch?.parentElement && branch.parentElement !== document.documentElement) {
    const parent = branch.parentElement;
    Array.from(parent.children).forEach((sibling) => {
      if (sibling === branch || sibling === backdrop || sibling.hasAttribute("inert")) return;
      sibling.setAttribute("inert", "");
      liveBrowserModalInertNodes.push(sibling);
    });
    branch = parent;
  }
}

function trapLiveBrowserModalFocus(event) {
  if (event.key !== "Tab" || !state.liveBrowserExpandedSessionId) return;
  const card = document.querySelector(".live-browser-card.is-live-browser-modal");
  if (!card) return;
  const focusable = Array.from(card.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], iframe, [tabindex]:not([tabindex='-1'])"))
    .filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
  if (!focusable.length) {
    event.preventDefault();
    card.focus();
    return;
  }
  const active = document.activeElement;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!card.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

function closeLiveBrowserLargeModal({ restoreFocus = true } = {}) {
  const expandedId = String(state.liveBrowserExpandedSessionId || "");
  const card = expandedId
    ? document.querySelector(`[data-live-browser-card="${CSS.escape(expandedId)}"]`)
    : document.querySelector(".live-browser-card.is-live-browser-modal");
  card?.classList.remove("is-live-browser-modal");
  card?.removeAttribute("role");
  card?.removeAttribute("aria-modal");
  card?.removeAttribute("aria-labelledby");
  card?.removeAttribute("tabindex");
  document.querySelector("[data-live-browser-modal-backdrop]")?.remove();
  releaseLiveBrowserModalBackground();
  document.body.classList.remove("live-browser-modal-open");
  state.liveBrowserExpandedSessionId = "";
  const expandButton = card?.querySelector("[data-live-browser-fullscreen]");
  if (expandButton) {
    expandButton.setAttribute("aria-label", "放大窗口");
    expandButton.setAttribute("title", "放大窗口");
    expandButton.setAttribute("aria-pressed", "false");
    expandButton.innerHTML = renderExpandIcon(false);
  }
  const focusTarget = liveBrowserModalTrigger?.isConnected
    ? liveBrowserModalTrigger
    : card?.querySelector("[data-live-browser-fullscreen]");
  if (restoreFocus && focusTarget?.isConnected) focusTarget.focus();
  liveBrowserModalTrigger = null;
}

function requestLiveBrowserFullscreen(sessionId = "", trigger = null) {
  const cards = Array.from(document.querySelectorAll("[data-live-browser-card]"));
  const card = cards.find((node) => String(node.dataset.liveBrowserCard || "") === String(sessionId || ""));
  const iframe = card?.querySelector("iframe");
  if (!iframe) return;
  if (String(state.liveBrowserExpandedSessionId || "") === String(sessionId || "")) {
    closeLiveBrowserLargeModal();
    return;
  }
  closeLiveBrowserLargeModal({ restoreFocus: false });
  const shell = $("accountBrowserShell") || document.body;
  const backdrop = document.createElement("div");
  backdrop.className = "live-browser-modal-backdrop";
  backdrop.dataset.liveBrowserModalBackdrop = "";
  backdrop.dataset.liveBrowserModalClose = "";
  shell.appendChild(backdrop);
  liveBrowserModalTrigger = trigger instanceof HTMLElement ? trigger : null;
  state.liveBrowserExpandedSessionId = String(sessionId || "");
  card.classList.add("is-live-browser-modal");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", liveBrowserDialogTitleId(sessionId));
  card.setAttribute("tabindex", "-1");
  document.body.classList.add("live-browser-modal-open");
  isolateLiveBrowserModalBackground(card, backdrop);
  const session = state.socialBrowserSessions.find((item) => liveBrowserSessionId(item) === String(sessionId || ""));
  if (session) updateLiveBrowserSessionCard(card, session);
  card.querySelector("iframe")?.focus();
}

async function closeLiveBrowserSession(sessionId = "") {
  const cleanSessionId = String(sessionId || "").trim();
  if (!cleanSessionId) return;
  await api(`/api/persona_dashboard/automation/browser_sessions/${encodeURIComponent(cleanSessionId)}/close`, { method: "POST" });
  state.socialBrowserSessions = (Array.isArray(state.socialBrowserSessions) ? state.socialBrowserSessions : [])
    .filter((session) => String(session?.id || session?.session_id || "") !== cleanSessionId);
  renderLiveBrowserSessions();
  await refreshSocialAccountsOnly({ force: true });
}

async function setLiveBrowserMode(sessionId = "", mode = "manual") {
  const cleanSessionId = String(sessionId || "").trim();
  const cleanMode = String(mode || "").trim().toLowerCase();
  if (!cleanSessionId || cleanMode !== "manual") return;
  const session = (state.socialBrowserSessions || []).find((item) => liveBrowserSessionId(item) === cleanSessionId);
  const taskId = String(session?.task_id || "").trim();
  if (taskId) {
    state.suppressedSocialTaskPromptIds.add(taskId);
    dismissToastByKey(socialTaskToastKey(taskId), { manual: true });
  }
  if (session && liveBrowserLoginMode(session) === "manual" && Boolean(session.input_allowed)) {
    renderLiveBrowserSessions();
    syncSocialTaskToastAutoRefresh();
    return;
  }
  if (session) {
    session.login_mode = "switching";
    session.input_allowed = false;
  }
  renderLiveBrowserSessions();
  syncSocialTaskToastAutoRefresh();
  let result;
  try {
    result = await api(`/api/persona_dashboard/automation/browser_sessions/${encodeURIComponent(cleanSessionId)}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "manual" }),
    });
  } catch (error) {
    const status = Number(error?.status || 0);
    const definitelyRejected = status >= 400 && status < 500;
    if (definitelyRejected) {
      if (taskId) state.suppressedSocialTaskPromptIds.delete(taskId);
      if (session) session.login_mode = "automatic";
    } else if (taskId) {
      refreshLiveBrowserSessionsSoon(taskId, 40, 500);
    }
    if (session) session.input_allowed = false;
    renderLiveBrowserSessions();
    syncSocialTaskToastAutoRefresh();
    throw error;
  }
  if (session) {
    session.login_mode = result?.acknowledged ? "manual" : "switching";
    session.input_allowed = Boolean(result?.acknowledged) && liveBrowserIsReady(session);
  }
  renderLiveBrowserSessions();
  if (taskId) refreshLiveBrowserSessionsSoon(taskId, 40, 500);
  await refreshSocialAccountsOnly({ force: true, includeOverview: true }).catch(() => {});
}

function liveBrowserToolInput(sessionId = "") {
  const cleanSessionId = String(sessionId || "").trim();
  if (!cleanSessionId) return null;
  return Array.from(document.querySelectorAll("[data-live-browser-text]"))
    .find((node) => String(node.dataset.liveBrowserText || "") === cleanSessionId) || null;
}

async function sendLiveBrowserText(sessionId = "", { pressEnter = false } = {}) {
  const cleanSessionId = String(sessionId || "").trim();
  if (!cleanSessionId) return;
  const input = liveBrowserToolInput(cleanSessionId);
  const text = String(input?.value || "");
  if (!text && !pressEnter) {
    showMsg("socialMsg", "请输入要发送到浏览器的文本。", false);
    return;
  }
  await api(`/api/persona_dashboard/automation/browser_sessions/${encodeURIComponent(cleanSessionId)}/type`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, press_enter: Boolean(pressEnter) }),
  });
  if (input && text) input.value = "";
  showMsg("socialMsg", pressEnter ? "已发送文本并回车。" : "已发送文本到浏览器。", true);
}

async function pressLiveBrowserKey(sessionId = "", key = "Enter") {
  const cleanSessionId = String(sessionId || "").trim();
  if (!cleanSessionId) return;
  await api(`/api/persona_dashboard/automation/browser_sessions/${encodeURIComponent(cleanSessionId)}/key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  showMsg("socialMsg", "已发送按键。", true);
}

async function captureLiveBrowserScreenshot(sessionId = "") {
  const cleanSessionId = String(sessionId || "").trim();
  if (!cleanSessionId) return;
  const result = await api(`/api/persona_dashboard/automation/browser_sessions/${encodeURIComponent(cleanSessionId)}/screenshot`, {
    method: "POST",
  });
  showMsg("socialMsg", "已完成浏览器截图。", true);
  const screenshotUrl = directMediaPreviewUrl(result.screenshot_url || result.screenshotUrl);
  if (screenshotUrl) {
    const groupId = registerMediaPreviewGroup([{ previewUrl: screenshotUrl, type: "image", label: "浏览器截图" }]);
    openMediaLightbox(groupId, 0);
  }
  await loadSocial().catch(() => {});
}

function liveBrowserSessionUrl(session) {
  if (session.view_path) return adminWorkspaceLiveBrowserUrl(session.view_path);
  if (session.novnc_path) return adminWorkspaceLiveBrowserUrl(session.novnc_path);
  const publicUrl = String(session.public_url || "").trim();
  const base = publicUrl || `${location.protocol || "http:"}//${location.hostname}:${session.web_port}`;
  const params = new URLSearchParams({
    autoconnect: "1",
    resize: "scale",
    reconnect: "1",
    quality: "5",
    dynamic_quality_min: "3",
    dynamic_quality_max: "7",
    jpeg_video_quality: "5",
    webp_video_quality: "4",
    video_quality: "1",
    video_time: "1",
    video_out_time: "1",
    video_scaling: "1",
    max_video_resolution_x: "960",
    max_video_resolution_y: "540",
    framerate: "24",
    compression: "2",
    enable_webp: "1",
    enable_webrtc: "0",
    enable_threading: "1",
  });
  if (session.password) params.set("password", String(session.password));
  return `${base.replace(/\/+$/, "")}/vnc.html?${params.toString()}`;
}

function renderSocialTasks() {
  const host = $("socialTaskList");
  if (!host) return;
  host.innerHTML = state.socialTasks.length ? state.socialTasks.map((task) => `
    <article class="social-task">
      <div><strong>${esc(statusLabel(task.task_type))}</strong><span>${esc(task.platform)} · ${esc(task.account_username || task.account_id || "")}</span></div>
      <span class="status ${esc(socialTaskPresentationStatus(task))}">${esc(statusLabel(socialTaskPresentationStatus(task)))}</span>
      <div class="row-actions">
        <button type="button" data-social-preview="${esc(task.id)}">预览</button>
        <button type="button" data-social-log="${esc(task.id)}">日志</button>
        ${task.status === "failed" && task?.result?.retryable !== false ? `<button type="button" data-social-retry="${esc(task.id)}">重试</button>` : ""}
        ${activeSocialAutomationTask(task) ? `<button type="button" data-social-cancel="${esc(task.id)}">取消</button>` : ""}
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

function validateTaskForPlatform(taskType, platform, { includePublish = false } = {}) {
  if (taskType === "open_login") return ["threads", "instagram"].includes(String(platform || "").trim().toLowerCase());
  const allowed = taskOptionsForPlatform(platform, { includePublish }).map(([value]) => value);
  return allowed.includes(taskType);
}

function publishOrderedPersonaIds() {
  const ids = [];
  const seen = new Set();
  const pushId = (id) => {
    const cleanId = String(id || "").trim();
    if (!cleanId || seen.has(cleanId) || !state.personas.some((persona) => String(persona.id) === cleanId)) return;
    ids.push(cleanId);
    seen.add(cleanId);
  };
  personaCollectionGroups().forEach((group) => {
    (group.persona_ids || []).forEach(pushId);
  });
  orderedUngroupedPersonas(personaAssignedIds()).forEach((persona) => pushId(persona.id));
  state.personas.forEach((persona) => pushId(persona.id));
  return ids;
}

function sortPersonaIdsByPublishOrder(ids = []) {
  const selected = new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean));
  return publishOrderedPersonaIds().filter((id) => selected.has(id));
}

function matrixPublishSelectedIds() {
  const current = Array.isArray(state.matrixPublish?.personaIds) ? state.matrixPublish.personaIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
  if (state.matrixPublish?.initialized) return sortPersonaIdsByPublishOrder(current);
  const selected = selectedPersona();
  return selected ? [String(selected.id || "")].filter(Boolean) : [];
}

function updateMatrixPublishStateFromForm() {
  const selectedIds = Array.from(document.querySelectorAll("[data-matrix-persona]:checked")).map((node) => String(node.value || "").trim()).filter(Boolean);
  state.matrixPublish = {
    ...state.matrixPublish,
    personaIds: sortPersonaIdsByPublishOrder(selectedIds),
    source: $("matrixPublishSource")?.value || state.matrixPublish.source || "posts",
    perPersonaCount: Math.min(Math.max(Number($("matrixPublishCount")?.value || state.matrixPublish.perPersonaCount || 1), 1), 20),
    platform: $("matrixPublishPlatform")?.value || state.matrixPublish.platform || "threads",
    scheduledAt: $("simpleScheduleAt")?.value ?? state.matrixPublish.scheduledAt ?? "",
    initialized: true,
  };
}

function ensureMatrixDraftLoads(personaIds) {
  (personaIds || []).forEach((personaId) => {
    if (!state.personaDraftPosts[String(personaId || "")]) {
      loadPersonaDraftPosts(personaId).then(() => {
        if (state.activeModule === "publishing" && $("simplePublishMode")?.value === "matrix_start") {
          renderSimpleFlowModule("publishing");
        }
      }).catch(() => {});
    }
  });
}

function ensureMatrixFavoriteLoads(personaIds) {
  (personaIds || []).forEach((personaId) => {
    if (!state.personaFavoritePosts[String(personaId || "")]) {
      loadPersonaFavoritePosts(personaId).then(() => {
        if (state.activeModule === "publishing" && $("simplePublishMode")?.value === "matrix_start") {
          renderSimpleFlowModule("publishing");
        }
      }).catch(() => {});
    }
  });
}

function renderMatrixPublishPanel() {
  const selectedIds = matrixPublishSelectedIds();
  if (!state.matrixPublish.initialized && selectedIds.length) {
    state.matrixPublish.personaIds = selectedIds;
    state.matrixPublish.initialized = true;
  }
  const source = state.matrixPublish.source || "posts";
  if (source === "favorites") ensureMatrixFavoriteLoads(selectedIds);
  else ensureMatrixDraftLoads(selectedIds);
  const perCount = Math.min(Math.max(Number(state.matrixPublish.perPersonaCount || 1), 1), 20);
  const platform = state.matrixPublish.platform || "threads";
  const scheduledAt = String(state.matrixPublish.scheduledAt || "");
  const rows = selectedIds.map((personaId) => {
    const persona = state.personas.find((item) => String(item.id) === String(personaId));
    const account = publishAccountsForPersona(persona).find((item) => String(item.platform || "").toLowerCase() === platform) || null;
    const posts = source === "favorites"
      ? personaFavoritePosts(persona)
      : personaDraftPosts(persona).filter((post) => !String(post.published_at || post.publishedAt || "").trim());
    const previewPosts = posts.slice(0, perCount);
    return `
      <tr>
        <td>${esc(persona?.name || personaId)}</td>
        <td>${account ? esc(account.username || account.id) : "<span class=\"muted\">无可用账号</span>"}</td>
        <td>${posts.length} 条</td>
        <td>${previewPosts.length ? previewPosts.map((post, index) => esc(personaDraftDisplayTitleForPost(post, posts, index) || post.content || post.id).slice(0, 34)).join("<br>") : "<span class=\"muted\">暂无可用内容</span>"}</td>
      </tr>
    `;
  }).join("");
  return `
    <div class="matrix-publish-panel">
      <div class="form-grid">
        <label>发布来源
          <select id="matrixPublishSource">
            <option value="posts" ${source === "posts" ? "selected" : ""}>草稿库</option>
            <option value="favorites" ${source === "favorites" ? "selected" : ""}>收藏推文</option>
          </select>
        </label>
        <label>执行平台
          <select id="matrixPublishPlatform">
            <option value="threads" ${platform === "threads" ? "selected" : ""}>Threads</option>
            <option value="instagram" ${platform === "instagram" ? "selected" : ""}>Instagram</option>
          </select>
        </label>
        <label>每个人设发布数量
          <input id="matrixPublishCount" type="number" min="1" max="20" value="${esc(perCount)}" />
        </label>
        <label>发布时间
          <input id="simpleScheduleAt" value="${esc(scheduledAt)}" placeholder="留空立即执行 / 2026-07-04 21:30" />
        </label>
      </div>
      <div class="matrix-preview">
        <div class="matrix-toolbar"><strong>提交预览</strong><span class="muted">将创建 ${selectedIds.length * perCount} 条以内的发布任务</span></div>
        <table class="mini-table">
          <thead><tr><th>人设</th><th>账号</th><th>可发布</th><th>预览内容</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4">请选择人设。</td></tr>`}</tbody>
        </table>
      </div>
      <input id="simplePrimary" type="hidden" value="publish_post" />
    </div>
  `;
}

async function submitMatrixPublishTask(messageId = "commandMsg") {
  updateMatrixPublishStateFromForm();
  const personaIds = matrixPublishSelectedIds();
  if (!personaIds.length) {
    showMsg(messageId, "请至少选择一个人设。", false);
    return null;
  }
  const source = state.matrixPublish.source || "posts";
  const platform = state.matrixPublish.platform || "threads";
  const perPersonaCount = Math.min(Math.max(Number(state.matrixPublish.perPersonaCount || 1), 1), 20);
  const lockParts = ["matrix_publish", source, platform, personaIds.join("_")];
  if (isActionLocked(...lockParts)) {
    showMsg(messageId, "矩阵发布正在提交，请等待当前操作完成。", false);
    return null;
  }
  const scheduledAt = normalizeScheduleValueForApi($("simpleScheduleAt")?.value);
  const requestedCount = personaIds.reduce((total, personaId) => {
    const persona = state.personas.find((item) => String(item.id || "") === String(personaId || ""));
    if (!persona) return total;
    const available = publishSourceRows(persona, source).filter((post) => (
      String(post?.id || "").trim()
      && !String(post?.publishedAt || post?.published_at || "").trim()
      && (String(post?.content || "").trim() || (Array.isArray(post?.media_items) && post.media_items.length))
    )).length;
    return total + Math.min(available, perPersonaCount);
  }, 0);
  if (requestedCount > 0 && !(await ensureDailyPublishCapacity(requestedCount, { scheduledAt }))) return null;
  setActionLocked(lockParts, true);
  renderSimpleFlowModule("publishing");
  try {
    showMsg(messageId, "正在提交矩阵发布任务...", true);
    const result = await api("/api/persona_dashboard/matrix_publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_ids: personaIds,
        source,
        platform,
        per_persona_count: perPersonaCount,
        scheduled_at: scheduledAt || undefined,
        priority: 50,
        max_retries: 2,
      }),
    });
    const created = Array.isArray(result.created) ? result.created : [];
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    const errors = Array.isArray(result.errors) ? result.errors : [];
    created.forEach((item) => mergeSocialTaskState(item?.login_task, item?.task || item));
    const matrixToastTarget = { view: "tasks", taskPanel: "persona" };
    const matrixToastKey = `matrix-publish:${result.batch_id || Date.now()}`;
    showMsg(messageId, `矩阵发布已提交 ${created.length} 条任务，跳过 ${skipped.length} 条，失败 ${errors.length} 条。`, created.length > 0, {
      kind: created.length > 0 ? "queued" : "failed",
      target: matrixToastTarget,
      key: matrixToastKey,
    });
    appendEvent(created.length > 0 ? "info" : "failed", `矩阵发布批次 ${result.batch_id || "-"}：创建 ${created.length} 条，跳过 ${skipped.length} 条，失败 ${errors.length} 条`, {
      target: matrixToastTarget,
      key: matrixToastKey,
    });
    const immediateCreated = created.filter((item) => !isFutureScheduledSocialTask(item?.task || item));
    const taskIdsByPersona = new Map();
    immediateCreated.forEach((item) => {
      const taskId = String(item?.task?.id || item?.id || "").trim();
      const personaId = String(item?.persona_id || item?.task?.persona_id || "").trim();
      if (!taskId || !personaId) return;
      taskIdsByPersona.set(personaId, [...(taskIdsByPersona.get(personaId) || []), taskId]);
    });
    taskIdsByPersona.forEach((taskIds, personaId) => {
      watchPersonaPublishTaskSequence(taskIds, personaId).catch((error) => {
        showMsg(messageId, error?.detail || error?.message || "矩阵发布状态跟踪失败", false);
      });
    });
    await loadSocial();
    return result;
  } finally {
    setActionLocked(lockParts, false);
    if (state.activeModule === "publishing") renderSimpleFlowModule("publishing");
  }
}

async function createSocialTask(taskType = $("socialTaskType")?.value, accountId = $("socialAccount")?.value || $("simpleAccount")?.value, personaId = "", messageId = "socialMsg") {
  if (!accountId) {
    showMsg(messageId, "请先选择执行账号。", false);
    return;
  }
  const selected = selectedSocialAccount(accountId);
  const platform = selected?.platform || $("socialPlatform")?.value || "threads";
  const allowPublishTask = taskType === "publish_post" && state.activeModule === "publishing";
  if (!validateTaskForPlatform(taskType, platform, { includePublish: allowPublishTask })) {
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
  const targetUrls = $("simpleTargetUrls")?.value || $("socialTargetUrls")?.value || "";
  const scheduledAt = normalizeScheduleValueForApi($("simpleScheduleAt")?.value);
  const mediaFiles = [
    ...filesFromInput("simpleMediaFiles"),
    ...filesFromInput("socialMediaFiles"),
  ];
  const loginWaitSeconds = taskType === "open_login" ? 3600 : 180;
  let mediaPaths = [];
  if (taskType === "publish_post" && !(await ensureDailyPublishCapacity(1, { scheduledAt }))) return null;
  setActionLocked(lockParts, true);
  if (state.activeModule && ["publishing", "automation"].includes(state.activeModule)) renderSimpleFlowModule(state.activeModule);
  renderSocialAccounts();
  if (taskType === "publish_post") {
    try {
      mediaPaths = await uploadAutomationMedia(mediaFiles, messageId);
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
        auto_submit: taskType === "open_login" ? Boolean(selected?.login_password_configured) : undefined,
        media_paths: mediaPaths,
        target_urls: splitLines(targetUrls),
        login_wait_seconds: loginWaitSeconds,
        reply_templates: splitLines(content),
      });
      const payload = compactPayload({
        ...defaultPayloadForTask(taskType),
        ...userPayload,
      });
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
      const waitingForSchedule = isFutureScheduledSocialTask(result.task);
      showMsg(messageId, waitingForSchedule ? `浏览器任务已定时：${formatScheduledTime(result.task?.scheduled_at)}` : `浏览器任务已提交：${result.task?.id || ""}`, true, {
        key: result.task?.id ? socialTaskToastKey(result.task.id, result.task) : undefined,
        kind: "queued",
        taskId: result.task?.id || "",
        taskPanel: cleanPersonaId ? "persona" : "regular",
        personaId: cleanPersonaId,
      });
      if (!waitingForSchedule) refreshLiveBrowserSessionsSoon(String(result.task?.id || ""));
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
      auto_submit: taskType === "open_login" ? Boolean(selected?.login_password_configured) : undefined,
      media_paths: mediaPaths,
      target_urls: splitLines(targetUrls),
      login_wait_seconds: loginWaitSeconds,
      reply_templates: splitLines(content),
    });
    const payload = compactPayload({
      ...defaultPayloadForTask(taskType),
      ...userPayload,
    });
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
    const waitingForSchedule = isFutureScheduledSocialTask(result.task);
      showMsg(messageId, waitingForSchedule ? `浏览器任务已定时：${formatScheduledTime(result.task?.scheduled_at)}` : `浏览器任务已提交：${result.task?.id || ""}`, true, {
      key: result.task?.id ? socialTaskToastKey(result.task.id, result.task) : undefined,
      kind: "queued",
      taskId: result.task?.id || "",
      taskPanel: cleanPersonaId ? "persona" : "regular",
      personaId: cleanPersonaId,
    });
    if (!waitingForSchedule) refreshLiveBrowserSessionsSoon(String(result.task?.id || ""), 60, 500);
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
  const logs = Array.isArray(data.logs) ? data.logs : [];
  const task = data.task || state.socialTasks.find((item) => String(item.id || "") === String(id || "")) || {};
  await openConsoleModal({
    title: "自动化日志",
    contentHtml: renderTaskDetailLayout(task, logs, {
      kind: "social",
      title: statusLabel(task.task_type || task.type || "自动化任务"),
    }),
    confirmText: "关闭",
    showCancel: false,
  });
}

async function openPersonalConsoleView(view) {
  if (!view || view === state.view) return;
  if (state.view === "workspace" && isPersonaWorkspaceModule() && !(await canLeaveCurrentPersonaDraftEdit("leave"))) return;
  if (state.view === "workspace" && !(await confirmLeaveTransientWorkspaceState())) return;
  setView(view);
}

function bindEvents() {
  document.addEventListener("click", handleDailyPublishActionGate, true);
  ensureThemeToggle();
  ensureLanguageToggle();
  window.addEventListener("vecto:theme-change", (event) => applyTheme(event.detail?.theme));
  window.addEventListener("vecto:language-change", (event) => applyLanguage(event.detail?.language));
  window.addEventListener("vecto:account-menu-open", () => {
    renderPersonalBillingSummary();
    loadBilling().catch(() => {});
  });
  window.addEventListener("vecto:account-billing-request", () => {
    openPersonalConsoleView("billing").catch(() => {});
  });
  window.addEventListener("vecto:account-settings-request", () => {
    openPersonalConsoleView("console_settings").catch(() => {});
  });
  markConsoleStaticUi();
  startLanguageObserver();
  applyLanguage(currentLanguage());
  bindMobileNavigation();
  document.addEventListener("visibilitychange", () => {
    syncSocialTaskToastAutoRefresh();
    syncTaskQueueAutoRefresh();
    syncAccountStatusAutoRefresh();
    syncLiveBrowserAutoRefresh();
  });
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", async () => {
    const nextView = button.dataset.view;
    if (nextView === "workspace" && state.view === "workspace") {
      setMenuClickHighlight(button, button);
      state.workspaceMenuOpen = !state.workspaceMenuOpen;
      updateWorkspaceFlow();
      return;
    }
    if (state.view === "workspace" && isPersonaWorkspaceModule() && nextView !== "workspace" && !(await canLeaveCurrentPersonaDraftEdit("leave"))) return;
    if (state.view === "workspace" && nextView !== "workspace" && !(await confirmLeaveTransientWorkspaceState())) return;
    setMenuClickHighlight(button, button);
    if (nextView === "workspace") state.workspaceMenuOpen = true;
    setView(nextView);
  }));
  $("refreshBilling")?.addEventListener("click", () => loadBilling({ force: true }).catch((error) => {
    showMsg("billingMsg", error.detail || error.message || "刷新计费信息失败", false, { target: { view: "billing" } });
  }));
  $("billingOrders")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-billing-cancel-order]");
    if (button) cancelBillingOrder(button.dataset.billingCancelOrder || "");
  });
  $("moduleMenu").addEventListener("click", async (event) => {
    const viewButton = event.target.closest("[data-workspace-view]");
    if (viewButton) {
      const nextView = viewButton.dataset.workspaceView || "workspace";
      if (nextView !== state.view && isPersonaWorkspaceModule() && !(await canLeaveCurrentPersonaDraftEdit("leave"))) return;
      if (nextView !== state.view && !(await confirmLeaveTransientWorkspaceState())) return;
      setMenuClickHighlight(viewButton, viewButton.closest(".module-accordion-item") || viewButton);
      state.workspaceMenuOpen = true;
      if (nextView === "accounts") {
        setAccountBrowserPanel(viewButton.dataset.workspacePanel || "accounts");
      }
      setView(nextView);
      return;
    }
    const button = event.target.closest("[data-module]");
    if (button) {
      if (button.dataset.module !== state.activeModule && state.view === "workspace" && isPersonaWorkspaceModule() && !(await canLeaveCurrentPersonaDraftEdit("leave"))) return;
      if (button.dataset.module !== state.activeModule && state.view === "workspace" && !(await confirmLeaveTransientWorkspaceState())) return;
      setMenuClickHighlight(button, button.closest(".module-accordion-item") || button);
      if (state.view !== "workspace") {
        state.workspaceMenuOpen = true;
        setView("workspace");
      }
      setModule(button.dataset.module);
    }
  });
  document.addEventListener("click", (event) => {
    const modalPreviewButton = event.target.closest?.("[data-media-preview-group]");
    if (modalPreviewButton && !$("moduleBody")?.contains(modalPreviewButton)) {
      openPersonaMediaLightbox(
        modalPreviewButton.dataset.mediaPreviewGroup || "",
        Number(modalPreviewButton.dataset.mediaPreviewIndex || 0),
      );
      return;
    }
    if (!event.target.closest?.(".persona-draft-more")) closePersonaDraftMenus();
    if (
      isPersonaWorkspaceModule()
      && state.personaListEditorId
      && !event.target.closest(".persona-card-menu")
      && !event.target.closest(".persona-card-submenu")
      && !event.target.closest("[data-persona-edit]")
      && !event.target.closest("[data-persona-edit-group]")
      && !event.target.closest(".persona-list-card")
    ) {
      state.personaListEditorId = "";
      state.personaListEditorMode = "";
      renderActivePersonaListSurface();
    }
  });
  document.addEventListener("change", (event) => {
    const expiryMode = event.target?.closest?.("[data-proxy-expiry-mode]");
    if (expiryMode) {
      const target = $(expiryMode.dataset.proxyExpiryTarget || "");
      if (target) target.hidden = expiryMode.value !== "custom";
      return;
    }
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
  document.addEventListener("dragenter", (event) => {
    const zone = personaImageUploadDropzoneFromEvent(event);
    if (!zone) return;
    event.preventDefault();
    zone.classList.add("is-dragging");
  });
  document.addEventListener("dragover", (event) => {
    const zone = personaImageUploadDropzoneFromEvent(event);
    if (!zone) return;
    event.preventDefault();
    zone.classList.add("is-dragging");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", (event) => {
    const zone = personaImageUploadDropzoneFromEvent(event);
    if (!zone || zone.contains(event.relatedTarget)) return;
    zone.classList.remove("is-dragging");
  });
  document.addEventListener("drop", (event) => {
    const zone = personaImageUploadDropzoneFromEvent(event);
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove("is-dragging");
    const file = Array.from(event.dataTransfer?.files || []).find((item) => isPersonaImageFile(item));
    if (!file) {
      showMsg("commandMsg", "请拖入图片文件。", false);
      return;
    }
    uploadPersonaReferenceImage(file).catch((error) => showMsg("commandMsg", error.detail || error.message || "上传人设图失败", false));
  });
  $("moduleBody").addEventListener("dragstart", (event) => {
    if (event.target.closest?.("[data-persona-drag-persona]")) event.preventDefault();
  });
  $("moduleBody").addEventListener("pointerdown", handlePersonaPointerDown);
  if ($("accountGrid")) {
    $("accountGrid").addEventListener("dragstart", (event) => {
      if (event.target.closest?.("[data-persona-drag-persona]")) event.preventDefault();
    });
    $("accountGrid").addEventListener("pointerdown", handlePersonaPointerDown);
  }
  document.addEventListener("pointermove", handlePersonaPointerMove, { passive: false });
  document.addEventListener("pointerup", handlePersonaPointerUp, { passive: false });
  document.addEventListener("pointercancel", handlePersonaPointerCancel);
  document.addEventListener("wheel", handlePersonaImageLibraryWheel, { passive: false });
  $("moduleBody").addEventListener("scroll", schedulePersonaCardEditorMenuPosition, true);
  window.addEventListener("resize", schedulePersonaCardEditorMenuPosition);
  window.addEventListener("beforeunload", (event) => {
    const activeState = activeTransientWorkspaceState();
    if (!activeState) return;
    if (state.transientWorkspaceAllowNextUnload) {
      state.transientWorkspaceAllowNextUnload = false;
      return;
    }
    event.preventDefault();
    event.returnValue = "";
  });
  $("moduleBody").addEventListener("click", async (event) => {
    if (Date.now() < Number(state.personaSuppressClickUntil || 0)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const startPersonaBulk = event.target.closest("[data-persona-bulk-start]");
    if (startPersonaBulk) {
      state.personaBulkMode = true;
      state.personaBulkScope = "personas";
      state.personaBulkSelectedIds = new Set();
      state.personaBulkSelectedGroupIds = new Set();
      state.personaListEditorId = "";
      state.personaListEditorMode = "";
      renderPersonaModule();
      return;
    }
    const personaBulkScopeButton = event.target.closest("[data-persona-bulk-scope]");
    if (personaBulkScopeButton && !state.personaBulkDeleting) {
      state.personaBulkScope = personaBulkScopeButton.dataset.personaBulkScope === "groups" ? "groups" : "personas";
      state.personaListPage = 1;
      renderPersonaModule();
      return;
    }
    if (event.target.closest("[data-persona-bulk-exit]")) {
      state.personaBulkMode = false;
      state.personaBulkScope = "personas";
      state.personaBulkSelectedIds = new Set();
      state.personaBulkSelectedGroupIds = new Set();
      renderPersonaModule();
      return;
    }
    if (event.target.closest("[data-persona-bulk-clear]")) {
      if (personaBulkScope() === "groups") state.personaBulkSelectedGroupIds = new Set();
      else state.personaBulkSelectedIds = new Set();
      renderPersonaModule();
      return;
    }
    if (event.target.closest("[data-persona-bulk-page]")) {
      const groupMode = personaBulkScope() === "groups";
      const pageIds = groupMode ? visiblePersonaBulkGroupIds() : visiblePersonaBulkIds();
      const selectedIds = groupMode ? personaBulkSelectedGroupSet() : personaBulkSelectedSet();
      const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(String(id)));
      if (groupMode) setPersonaBulkGroupSelection(pageIds, !allSelected);
      else setPersonaBulkSelection(pageIds, !allSelected);
      renderPersonaModule();
      return;
    }
    if (event.target.closest("[data-persona-bulk-delete]")) {
      const operation = personaBulkScope() === "groups" ? deleteBulkSelectedPersonaGroups : deleteBulkSelectedPersonas;
      operation().catch((error) => showMsg("commandMsg", error.detail || error.message || "批量删除失败", false));
      return;
    }
    const personaBulkCheck = event.target.closest("[data-persona-bulk-check]");
    if (personaBulkCheck) {
      setPersonaBulkSelection([personaBulkCheck.dataset.personaBulkCheck || ""], personaBulkCheck.checked);
      renderPersonaModule();
      return;
    }
    const personaBulkGroup = event.target.closest("[data-persona-bulk-group]");
    if (personaBulkGroup && personaBulkScope() === "personas") {
      const group = personaCollectionGroups().find((item) => String(item.id || "") === String(personaBulkGroup.dataset.personaBulkGroup || ""));
      setPersonaBulkSelection(group?.persona_ids || [], personaBulkGroup.checked);
      renderPersonaModule();
      return;
    }
    const personaBulkGroupCheck = event.target.closest("[data-persona-bulk-group-check]");
    if (personaBulkGroupCheck && personaBulkScope() === "groups") {
      setPersonaBulkGroupSelection([personaBulkGroupCheck.dataset.personaBulkGroupCheck || ""], personaBulkGroupCheck.checked);
      renderPersonaModule();
      return;
    }
    const personaBulkGroupToggle = event.target.closest("[data-persona-bulk-group-toggle]");
    if (personaBulkGroupToggle && personaBulkScope() === "groups") {
      const groupId = String(personaBulkGroupToggle.dataset.personaBulkGroupToggle || "");
      setPersonaBulkGroupSelection([groupId], !personaBulkSelectedGroupSet().has(groupId));
      renderPersonaModule();
      return;
    }
    const personaBulkToggle = event.target.closest("[data-persona-bulk-toggle]");
    if (personaBulkToggle && personaBulkScope() === "personas") {
      const personaId = String(personaBulkToggle.dataset.personaBulkToggle || "");
      setPersonaBulkSelection([personaId], !personaBulkSelectedSet().has(personaId));
      renderPersonaModule();
      return;
    }
    const editableMediaCard = event.target.closest(".persona-edit-media-card[data-persona-select-post-media]");
    if (
      editableMediaCard
      && !event.target.closest("[data-persona-replace-post-media]")
      && !event.target.closest("[data-persona-delete-post-media]")
    ) {
      const persona = selectedPersona();
      const target = personaMediaTargetPost(persona);
      if (persona && target.post) {
        const selectedIndex = editableMediaCard.dataset.personaSelectPostMedia || "0";
        setSelectedPersonaMediaIndex(persona.id, target.source, target.post.id, selectedIndex);
        updatePersonaEditableMediaSelectionDom(editableMediaCard, selectedIndex);
      }
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
    if (event.target.closest("[data-persona-create-memory]")) {
      createPersonaMemoryEntry().catch((error) => showMsg("commandMsg", error.detail || error.message || "新建记忆失败", false));
      return;
    }
    const postBulkButton = event.target.closest("[data-persona-post-bulk]");
    if (postBulkButton) {
      const persona = selectedPersona();
      if (!persona) return;
      const source = postBulkButton.dataset.personaPostBulkSource === "favorites" ? "favorites" : "posts";
      if (postBulkButton.dataset.personaPostBulk === "delete") {
        deletePersonaSelectedPosts(source).catch((error) => showMsg("commandMsg", error.detail || error.message || "批量操作失败", false));
        return;
      }
      const rows = personaSourcePosts(persona, source);
      setPersonaSelectedPostIds(
        persona,
        source,
        postBulkButton.dataset.personaPostBulk === "all" ? rows.map((post) => String(post.id || "").trim()).filter(Boolean) : [],
      );
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    const deleteMemoryButton = event.target.closest("[data-persona-delete-memory]");
    if (deleteMemoryButton) {
      deletePersonaMemoryEntry(deleteMemoryButton.dataset.personaDeleteMemory || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "删除记忆失败", false));
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
      suggestPersonaCreateKeywords().catch((error) => {
        if (Number(error?.status || 0) === 499) return;
        showMsg("commandMsg", error.detail || error.message || "提炼关键词失败", false);
      });
      return;
    }
    if (event.target.closest("[data-persona-create-ai-cancel-keywords]")) {
      cancelPersonaCreateKeywords();
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
      openPersonaImageGeneration(personaId).catch((error) => showMsg("commandMsg", error.detail || error.message || "打开编辑资料失败", false));
      return;
    }
    if (event.target.closest("[data-persona-create-ai-reset]")) {
      state.personaCreate = defaultPersonaCreateState();
      renderPersonaDetail();
      return;
    }
    if (event.target.closest("[data-persona-generate-posts]")) {
      generatePersonaDraftPosts().catch(() => {});
      return;
    }
    const generatedViewButton = event.target.closest("[data-persona-generated-view]");
    if (generatedViewButton) {
      viewPersonaGeneratedPost(generatedViewButton.dataset.personaGeneratedView || "").catch(() => {});
      return;
    }
    const generatedMediaButton = event.target.closest("[data-persona-generated-media]");
    if (generatedMediaButton) {
      const persona = selectedPersona();
      if (persona) {
        setPersonaPostSource("posts", persona);
        setSelectedPersonaPostId(generatedMediaButton.dataset.personaGeneratedMedia || "");
        const form = personaFormState(persona.id);
        form.generate.composeMode = "tweet_media";
        form.media.operationMode = "generate";
        form.media.contentMode = "draft";
        state.personaGroup = "content";
        state.personaPanels.content = "generate";
        renderPersonaDetail();
        renderConfirmSummary();
      }
      return;
    }
    const generatedPreviewCard = event.target.closest("[data-persona-generated-card]");
    if (generatedPreviewCard && !event.target.closest("button, a, input, select, textarea")) {
      selectGeneratedPreviewPost(generatedPreviewCard.dataset.personaGeneratedCard || "");
      return;
    }
    const clearGeneratePreviewButton = event.target.closest("[data-persona-clear-generate-preview]");
    if (clearGeneratePreviewButton) {
      clearPersonaGenerateRunState(clearGeneratePreviewButton.dataset.personaClearGeneratePreview || selectedPersona()?.id || "");
      renderPersonaDetail();
      renderConfirmSummary();
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
    const hotSearchModeButton = event.target.closest("[data-persona-hot-search-mode]");
    if (hotSearchModeButton) {
      const persona = selectedPersona();
      if (persona) {
        snapshotPersonaCurrentForm();
        personaFormState(persona.id).generate.hotSearchMode = normalizePersonaHotSearchMode(hotSearchModeButton.dataset.personaHotSearchMode);
        renderPersonaDetail();
        renderConfirmSummary();
      }
      return;
    }
    if (event.target.closest("[data-persona-fetch-hot]")) {
      fetchPersonaHotCandidates(false).catch(() => {});
      return;
    }
    if (event.target.closest("[data-persona-fetch-hot-refresh]")) {
      fetchPersonaHotCandidates(true).catch(() => {});
      return;
    }
    if (event.target.closest("[data-persona-import-hot-drafts]")) {
      importPersonaHotDrafts().catch(() => {});
      return;
    }
    const hotReplacementPoolSelect = event.target.closest("[data-persona-hot-replacement-pool-select]");
    if (hotReplacementPoolSelect) {
      const persona = selectedPersona();
      if (!persona) return;
      snapshotPersonaHotPreviewContent();
      const candidateId = String(hotReplacementPoolSelect.dataset.personaHotReplacementPoolSelect || "").trim();
      const entryId = String(hotReplacementPoolSelect.dataset.personaHotReplacementPoolId || "").trim();
      if (!candidateId || !entryId) return;
      setPersonaHotSelectedReplacementPoolId(persona.id, candidateId, entryId);
      renderPersonaDetail();
      return;
    }
    const hotReplacementPoolRemove = event.target.closest("[data-persona-hot-replacement-pool-remove]");
    if (hotReplacementPoolRemove) {
      const persona = selectedPersona();
      if (!persona) return;
      snapshotPersonaHotPreviewContent();
      const candidateId = String(hotReplacementPoolRemove.dataset.personaHotReplacementPoolRemove || "").trim();
      const entryId = String(hotReplacementPoolRemove.dataset.personaHotReplacementPoolId || "").trim();
      if (!candidateId || !entryId) return;
      removePersonaHotReplacementPoolEntry(persona.id, candidateId, entryId);
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    const hotMediaReplace = event.target.closest("[data-persona-hot-media-replace]");
    if (hotMediaReplace) {
      const persona = selectedPersona();
      if (!persona) return;
      snapshotPersonaHotPreviewContent();
      const candidateId = String(hotMediaReplace.dataset.personaHotMediaReplace || "").trim();
      const index = Number(hotMediaReplace.dataset.personaHotMediaIndex);
      if (!candidateId || !Number.isInteger(index) || index < 0) return;
      setPersonaHotSelectedMediaIndex(persona.id, candidateId, index);
      const selectedPoolEntry = personaHotSelectedReplacementPoolEntry(persona.id, candidateId);
      if (!selectedPoolEntry?.file) {
        showMsg("commandMsg", "请先添加并选择一个待替换媒体，再点击原媒体上的替换图标。", false);
        renderPersonaDetail();
        return;
      }
      setPersonaHotReplacementFile(persona.id, candidateId, index, selectedPoolEntry.file);
      const deleted = personaHotDeletedMediaSet(persona.id, candidateId);
      if (deleted.delete(index)) setPersonaHotDeletedMediaSet(persona.id, candidateId, deleted);
      renderPersonaDetail();
      renderConfirmSummary();
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
      else {
        deleted.add(index);
        setPersonaHotReplacementFile(persona.id, candidateId, index, null);
      }
      setPersonaHotDeletedMediaSet(persona.id, candidateId, deleted);
      renderPersonaDetail();
      return;
    }
    const hotMediaSelect = event.target.closest("[data-persona-hot-media-select]");
    if (hotMediaSelect) {
      const persona = selectedPersona();
      if (!persona) return;
      snapshotPersonaHotPreviewContent();
      const candidateId = String(hotMediaSelect.dataset.personaHotMediaSelect || "").trim();
      const index = Number(hotMediaSelect.dataset.personaHotMediaIndex);
      if (!candidateId || !Number.isInteger(index) || index < 0) return;
      setPersonaHotSelectedMediaIndex(persona.id, candidateId, index);
      renderPersonaDetail();
      return;
    }
    const clearHotReplacement = event.target.closest("[data-persona-hot-media-replacement-clear]");
    if (clearHotReplacement) {
      const persona = selectedPersona();
      if (!persona) return;
      snapshotPersonaHotPreviewContent();
      setPersonaHotReplacementFile(
        persona.id,
        clearHotReplacement.dataset.personaHotMediaReplacementClear || "",
        Number(clearHotReplacement.dataset.personaHotMediaIndex),
        null,
      );
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    const importOneHotButton = event.target.closest("[data-persona-import-hot-one]");
    if (importOneHotButton) {
      const candidateId = String(importOneHotButton.dataset.personaImportHotOne || "").trim();
      importPersonaHotDrafts(candidateId ? [candidateId] : []).catch(() => {});
      return;
    }
    const startHotEditButton = event.target.closest("[data-persona-start-hot-edit]");
    if (startHotEditButton) {
      const persona = selectedPersona();
      const candidateId = String(startHotEditButton.dataset.personaStartHotEdit || "").trim();
      if (persona && candidateId) startPersonaHotCandidateEdit(persona, candidateId);
      return;
    }
    const cancelHotEditButton = event.target.closest("[data-persona-cancel-hot-edit]");
    if (cancelHotEditButton) {
      const persona = selectedPersona();
      const candidateId = String(cancelHotEditButton.dataset.personaCancelHotEdit || "").trim();
      if (persona && candidateId) cancelPersonaHotCandidateEdit(persona, candidateId);
      return;
    }
    const confirmHotImportButton = event.target.closest("[data-persona-confirm-hot-import]");
    if (confirmHotImportButton) {
      const candidateId = String(confirmHotImportButton.dataset.personaConfirmHotImport || "").trim();
      snapshotPersonaHotPreviewContent();
      importEditedPersonaHotDraft(candidateId).catch(() => {});
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
      state.transientWorkspaceLeaveAcknowledgement = "";
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
      const candidateId = String(hotPreviewButton.dataset.personaHotPreview || "").trim();
      const form = personaFormState(persona.id).generate;
      form.hotSelectedIds = candidateId ? [candidateId] : [];
      form.hotPreviewId = candidateId;
      state.transientWorkspaceLeaveAcknowledgement = "";
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    if (event.target.closest("[data-persona-open-new-draft]")) {
      const persona = selectedPersona();
      if (!persona) return;
      const draftState = personaDraftEditState(persona.id);
      if (draftState.editing || draftState.rewritePending) {
        showMsg("commandMsg", "当前正在编辑草稿，请先保存或放弃修改后再新建草稿。", false);
        return;
      }
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
    const deletePostButton = event.target.closest("[data-persona-delete-post]");
    if (deletePostButton) {
      deletePersonaDraftPost(deletePostButton.dataset.personaDeletePost || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "删除草稿失败", false));
      return;
    }
    if (event.target.closest("[data-persona-discard-draft-edit]")) {
      const persona = selectedPersona();
      if (persona) {
        discardPersonaDraftEdit(persona.id);
        state.personaPanels.content = "posts";
        renderPersonaDetail();
        renderConfirmSummary();
        showMsg("commandMsg", "已放弃本次修改。", true);
      }
      return;
    }
    if (event.target.closest("[data-persona-clear-draft-edit]")) {
      const persona = selectedPersona();
      if (persona) {
        clearPersonaDraftEdit(persona.id);
        renderPersonaDetail();
        renderConfirmSummary();
        showMsg("commandMsg", "已清空当前草稿编辑内容。", true);
      }
      return;
    }
    if (event.target.closest("[data-persona-exit-draft-edit]")) {
      const persona = selectedPersona();
      if (persona) {
        const exited = await exitPersonaDraftEdit(persona.id);
        renderPersonaDetail();
        renderConfirmSummary();
        if (exited) showMsg("commandMsg", "已退出当前草稿编辑。", true);
      }
      return;
    }
    const mediaOperationButton = event.target.closest("[data-persona-media-operation]");
    if (mediaOperationButton) {
      const persona = selectedPersona();
      const personaId = String(persona?.id || state.renderedPersonaId || state.selectedPersonaId || "").trim();
      if (personaId) {
        snapshotPersonaCurrentForm();
        personaFormState(personaId).media.operationMode = mediaOperationButton.dataset.personaMediaOperation === "generate" ? "generate" : "replace";
        renderPersonaDetail();
        renderConfirmSummary();
      }
      return;
    }
    const mediaContentModeButton = event.target.closest("[data-persona-media-content-mode]");
    if (mediaContentModeButton) {
      const persona = selectedPersona();
      const personaId = String(persona?.id || state.renderedPersonaId || state.selectedPersonaId || "").trim();
      if (personaId) {
        snapshotPersonaCurrentForm();
        const mode = String(mediaContentModeButton.dataset.personaMediaContentMode || "draft");
        personaFormState(personaId).media.contentMode = mode === "manual" ? "manual" : "draft";
        renderPersonaDetail();
        renderConfirmSummary();
      }
      return;
    }
    if (event.target.closest("[data-persona-run-media-task]")) {
      submitPersonaMediaTask().catch(() => {});
      return;
    }
    if (event.target.closest("[data-persona-attach-task-media]")) {
      const button = event.target.closest("[data-persona-attach-task-media]");
      attachPersonaTaskMediaToPost(button?.dataset.personaAttachTaskMedia === "replace").catch((error) => showMsg("commandMsg", error.detail || error.message || "保存媒体失败", false));
      return;
    }
    const selectPostMedia = event.target.closest("[data-persona-select-post-media]");
    if (selectPostMedia && !event.target.closest("button")) {
      const persona = selectedPersona();
      const target = personaMediaTargetPost(persona);
      if (persona && target.post) {
        const selectedIndex = selectPostMedia.dataset.personaSelectPostMedia || "0";
        setSelectedPersonaMediaIndex(persona.id, target.source, target.post.id, selectedIndex);
        updatePersonaEditableMediaSelectionDom(selectPostMedia, selectedIndex);
      }
      return;
    }
    const replacePostMedia = event.target.closest("[data-persona-replace-post-media]");
    if (replacePostMedia) {
      uploadPersonaPostMedia(false, replacePostMedia.dataset.personaReplacePostMedia || "0").catch((error) => showMsg("commandMsg", error.detail || error.message || "替换媒体失败", false));
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
    const matrixGroupToggle = event.target.closest("[data-matrix-group]");
    if (matrixGroupToggle) {
      toggleMatrixGroupId(matrixGroupToggle.dataset.matrixGroup || "");
      renderSimpleFlowModule("publishing");
      renderConfirmSummary();
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
      renderActivePersonaListSurface();
      return;
    }
    const editCollectionGroup = event.target.closest("[data-persona-edit-group]");
    if (editCollectionGroup) {
      const groupId = editCollectionGroup.dataset.personaEditGroup || "";
      const editorId = groupId ? `group:${groupId}` : "";
      state.personaListEditorId = state.personaListEditorId === editorId ? "" : editorId;
      state.personaListEditorMode = "";
      renderActivePersonaListSurface();
      return;
    }
    const personaEditorBack = event.target.closest("[data-persona-editor-back]");
    if (personaEditorBack) {
      const personaId = personaEditorBack.dataset.personaEditorBack || "";
      if (state.personaListEditorId === personaId) {
        state.personaListEditorMode = "";
        renderActivePersonaListSurface();
      }
      return;
    }
    const personaEditorMode = event.target.closest("[data-persona-editor-mode]");
    if (personaEditorMode) {
      if (personaEditorMode.disabled) return;
      const [personaId, mode] = String(personaEditorMode.dataset.personaEditorMode || "").split(":");
      if (personaId) {
        state.personaListEditorId = personaId;
        state.personaListEditorMode = mode || "";
        renderActivePersonaListSurface();
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
      renderActivePersonaListSurface();
      return;
    }
    const openPublishingButton = event.target.closest("[data-persona-open-publishing]");
    if (openPublishingButton) {
      if (dailyPublishIsLocked()) {
        await showDailyPublishLimitWarning();
        return;
      }
      if (!(await confirmLeaveTransientWorkspaceState())) return;
      const persona = selectedPersona();
      if (persona) {
        const postId = String(openPublishingButton.dataset.personaOpenPublishing || "").trim();
        const source = personaPostSource(persona);
        if (postId) {
          setSelectedPersonaPostId(postId);
          state.publishContentSource = source === "favorites" ? "favorites" : "posts";
          setPublishSelectedPostIds(persona, state.publishContentSource, [postId]);
          ensurePersonaPostPageForPost(persona, source, postId);
        }
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
        const persona = selectedPersona();
        const targetStep = groupKey === "content" && step === "media" ? "generate_media" : step;
        if (persona && groupKey === "content" && !(await canLeavePersonaDraftEdit(persona.id, targetStep))) return;
        if (!(await confirmLeaveTransientWorkspaceState())) return;
        clearMsg("commandMsg");
        state.personaGroup = groupKey;
        if (persona && groupKey === "content" && step === "media") {
          personaFormState(persona.id).generate.composeMode = "tweet_media";
          state.personaPanels[groupKey] = "generate";
        } else {
          state.personaPanels[groupKey] = step;
        }
        renderPersonaDetail();
        renderConfirmSummary();
      }
    }
    const draftViewButton = event.target.closest("[data-persona-draft-view]");
    if (draftViewButton) {
      const persona = selectedPersona();
      if (persona) {
        setPersonaDraftViewMode(draftViewButton.dataset.personaDraftView || "grid", persona.id);
        renderPersonaDetail();
        renderConfirmSummary();
      }
      return;
    }
    const postSourceButton = event.target.closest("[data-persona-post-source]");
    if (postSourceButton) {
      const persona = selectedPersona();
      if (persona) {
        if (!(await canLeavePersonaDraftEdit(persona.id, "posts"))) return;
        const source = postSourceButton.dataset.personaPostSource === "favorites" ? "favorites" : "posts";
        setPersonaPostSource(source, persona);
        setPersonaPostPage(persona, source, 1);
        if (source === "favorites") {
          loadPersonaFavoritePosts(persona.id).catch(() => {});
        }
        const rows = personaSourcePosts(persona, source);
        setSelectedPersonaPostId(rows[0]?.id || "", { auto: true });
        resetPersonaDraftEditor(persona.id);
        renderPersonaDetail();
        renderConfirmSummary();
      }
      return;
    }
    const draftMenuToggle = event.target.closest("[data-persona-draft-menu-toggle]");
    if (draftMenuToggle) {
      const menu = draftMenuToggle.closest(".persona-draft-more");
      const opening = !menu?.classList.contains("is-open");
      closePersonaDraftMenus(menu);
      if (menu) {
        menu.classList.toggle("is-open", opening);
        menu.closest(".persona-draft-table-row, .persona-draft-card")?.classList.toggle("is-menu-open", opening);
        menu.closest(".persona-inline-panel")?.classList.toggle("is-menu-open", opening);
        menu.closest(".persona-draft-table")?.classList.toggle("is-menu-open", opening);
        menu.closest(".persona-workbench-shell")?.classList.toggle("is-menu-open", opening);
      }
      return;
    }
    const postPageButton = event.target.closest("[data-persona-post-page]");
    if (postPageButton) {
      const persona = selectedPersona();
      if (persona) {
        const source = personaPostSource(persona);
        const rows = personaSourcePosts(persona, source);
        const pageInfo = personaPostPageInfo(persona, source, rows);
        const action = String(postPageButton.dataset.personaPostPage || "");
        if (action === "first") setPersonaPostPage(persona, source, 1);
        if (action === "prev") setPersonaPostPage(persona, source, Math.max(1, pageInfo.page - 1));
        if (action === "next") setPersonaPostPage(persona, source, Math.min(pageInfo.totalPages, pageInfo.page + 1));
        if (action === "last") setPersonaPostPage(persona, source, pageInfo.totalPages);
        renderPersonaDetail();
        renderConfirmSummary();
      }
      return;
    }
    const viewDraftPostButton = event.target.closest("[data-persona-view-post]");
    if (viewDraftPostButton) {
      viewPersonaDraftPost(viewDraftPostButton.dataset.personaViewPost || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "查看草稿失败", false));
      return;
    }
    const refreshHotPostButton = event.target.closest("[data-persona-refresh-hot-post]");
    if (refreshHotPostButton) {
      refreshPersonaHotPost(refreshHotPostButton.dataset.personaRefreshHotPost || "", refreshHotPostButton)
        .catch((error) => showMsg("commandMsg", error.detail || error.message || "热点数据刷新失败", false));
      return;
    }
    const favoritePostButton = event.target.closest("[data-persona-favorite-post]");
    if (favoritePostButton) {
      const preserveSource = favoritePostButton.dataset.personaFavoriteInline === "true";
      addPersonaFavoritePost(favoritePostButton.dataset.personaFavoritePost || "", { preserveSource }).catch((error) => showMsg("commandMsg", error.detail || error.message || "收藏失败", false));
      return;
    }
    const deleteFavoriteButton = event.target.closest("[data-persona-delete-favorite]");
    if (deleteFavoriteButton) {
      const preserveSource = deleteFavoriteButton.dataset.personaFavoriteInline === "true" && personaPostSource() === "posts";
      deletePersonaFavoritePost(deleteFavoriteButton.dataset.personaDeleteFavorite || "", { preserveSource }).catch((error) => showMsg("commandMsg", error.detail || error.message || "移出收藏失败", false));
      return;
    }
    const draftCard = event.target.closest("[data-persona-select-post]");
    if (draftCard && !event.target.closest("button, a, input, select, textarea")) {
      const persona = selectedPersona();
      if (persona && !(await canLeavePersonaDraftEdit(persona.id, "posts"))) return;
      clearMsg("commandMsg");
      setSelectedPersonaPostId(draftCard.dataset.personaSelectPost || "");
      renderPersonaDetail();
      renderConfirmSummary();
    }
    const personaSelectButton = event.target.closest("[data-persona-select]") || (
      event.target.closest(".persona-card-edit, .persona-card-menu, .persona-card-submenu, button, a, input, label, select, textarea")
        ? null
        : event.target.closest("[data-persona-card]")
    );
    if (personaSelectButton) {
      const nextPersonaId = personaSelectButton.dataset.personaSelect || personaSelectButton.dataset.personaCard || "";
      if (state.view === "accounts" && personaSelectButton.closest(".account-pool-persona-shell")) {
        state.accountPoolPersonaId = String(nextPersonaId || "");
        renderSocialAccounts();
        return;
      }
      if (state.activeModule === "publishing") {
        const mode = normalizedPublishMode($("simplePublishMode")?.value || state.simpleBranches.publishing);
        if (mode === "matrix_start") toggleMatrixPersonaId(nextPersonaId);
        else selectPublishingPersona(nextPersonaId);
        state.personaListEditorId = "";
        state.personaListEditorMode = "";
        withConsoleScrollPreserved(() => renderSimpleFlowModule("publishing"));
        renderConfirmSummary();
        return;
      }
      if (state.activeModule === "automation") {
        clearMsg("commandMsg");
        const previousPersonaId = String(state.selectedPersonaId || "");
        state.selectedPersonaId = nextPersonaId;
        if (nextPersonaId !== previousPersonaId) {
          state.preferredAccountId = accountForPersona(selectedPersona())?.id || "";
          state.personaListEditorId = "";
          state.personaListEditorMode = "";
        }
        withConsoleScrollPreserved(() => renderSimpleFlowModule("automation"));
        renderConfirmSummary();
        return;
      }
      if (!(await canLeaveCurrentPersonaDraftEdit("leave"))) return;
      if (nextPersonaId !== String(state.selectedPersonaId || "") && !(await confirmLeaveTransientWorkspaceState())) return;
      clearMsg("commandMsg");
      const previousPersonaId = String(state.selectedPersonaId || "");
      state.selectedPersonaId = nextPersonaId;
      if (nextPersonaId !== previousPersonaId) resetPersonaWorkspaceStateOnSwitch(nextPersonaId);
      else setSelectedPersonaPostId("");
      state.preferredAccountId = accountForPersona(selectedPersona())?.id || "";
      renderPersonaModule();
      renderConfirmSummary();
      Promise.all([
        loadPersonaProfile(state.selectedPersonaId, { force: true }).catch(() => {}),
        loadPersonaDraftPosts(state.selectedPersonaId, { force: true }).catch(() => {}),
        loadPersonaFavoritePosts(state.selectedPersonaId, { force: true }).catch(() => {}),
        loadPersonaMemories(state.selectedPersonaId, { force: true }).catch(() => {}),
        loadPersonaPublishHistory(state.selectedPersonaId, { force: true }).catch(() => {}),
      ]).catch(() => {});
    }
    if (event.target.closest("[data-persona-open-create]")) {
      if (state.activeModule === "publishing") return;
      if (!(await canLeaveCurrentPersonaDraftEdit("leave"))) return;
      if (!(await confirmLeaveTransientWorkspaceState())) return;
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
      const groupKey = personaGroupButton.dataset.personaGroup || "content";
      if (groupKey !== state.personaGroup && !(await canLeaveCurrentPersonaDraftEdit(groupKey === "content" ? (state.personaPanels.content || "generate") : "leave"))) return;
      if (groupKey !== state.personaGroup && !(await confirmLeaveTransientWorkspaceState())) return;
      clearMsg("commandMsg");
      state.personaGroup = groupKey;
      setPersonaGroupStep(groupKey, state.personaPanels[groupKey] || personaGroups[groupKey]?.defaultStep || "", selectedPersonaProfile());
      renderPersonaDetail();
      renderConfirmSummary();
    }
    const personaStepButton = event.target.closest("[data-persona-step]");
    if (personaStepButton) {
      const [groupKey, step] = String(personaStepButton.dataset.personaStep || "").split(":");
      if (groupKey && step) {
        const persona = selectedPersona();
        if (persona && groupKey === "content" && !(await canLeavePersonaDraftEdit(persona.id, step))) return;
        const currentStep = currentPersonaGroupStep(groupKey, selectedPersonaProfile());
        if ((groupKey !== state.personaGroup || step !== currentStep) && !(await confirmLeaveTransientWorkspaceState())) return;
        clearMsg("commandMsg");
        state.personaGroup = groupKey;
        if (persona && groupKey === "content" && step === "generate") {
          resetPersonaNewDraftComposer(persona.id);
        }
        setPersonaGroupStep(groupKey, step, selectedPersonaProfile());
        renderPersonaDetail();
        renderConfirmSummary();
      }
    }
    const generateModeButton = event.target.closest("[data-persona-generate-mode]");
    if (generateModeButton) {
      const persona = selectedPersona();
      if (persona) {
        const nextMode = generateModeButton.dataset.personaGenerateMode || "ai";
        const form = personaFormState(persona.id);
        form.draft = normalizePersonaDraftForm(form.draft);
        const editingPostId = String(form.draft.editingPostId || "").trim();
        if (editingPostId && nextMode === "hot") {
          showMsg("commandMsg", "当前正在编辑草稿，热点抓取已锁定。请先保存或放弃修改。", false);
          return;
        }
        clearMsg("commandMsg");
        if (editingPostId && nextMode === "ai") {
          snapshotPersonaCurrentForm();
          form.generate.prompt = String(form.draft.content || "").trim();
          form.draft.rewriteSourcePostId = editingPostId;
        } else if (nextMode !== "custom" && !(await canLeavePersonaDraftEdit(persona.id, "generate"))) {
          return;
        }
        form.generate.mode = nextMode;
        renderPersonaDetail();
        renderConfirmSummary();
      }
    }
    const composeModeButton = event.target.closest("[data-persona-compose-mode]");
    if (composeModeButton) {
      const persona = selectedPersona();
      if (persona) {
        snapshotPersonaCurrentForm();
        const nextComposeMode = ["tweet_media", "custom"].includes(composeModeButton.dataset.personaComposeMode)
          ? composeModeButton.dataset.personaComposeMode
          : "tweet";
        const form = personaFormState(persona.id);
        form.generate.composeMode = nextComposeMode;
        if (nextComposeMode === "custom") form.generate.mode = "custom";
        state.personaGroup = "content";
        state.personaPanels.content = "generate";
        renderPersonaDetail();
        renderConfirmSummary();
      }
      return;
    }
    const openImageSettingsButton = event.target.closest("[data-persona-open-image-settings]");
    if (openImageSettingsButton) {
      const personaId = String(openImageSettingsButton.dataset.personaOpenImageSettings || state.selectedPersonaId || "");
      if (!personaId) {
        showMsg("commandMsg", "还没有可生成图片的人设。", false);
        return;
      }
      if (!(await confirmLeaveTransientWorkspaceState())) return;
      openPersonaImageGeneration(personaId)
        .catch((error) => showMsg("commandMsg", error.detail || error.message || "打开人设图设置失败", false));
      return;
    }
    const profileModeButton = event.target.closest("[data-persona-profile-mode]");
    if (profileModeButton) {
      const persona = selectedPersona();
      if (persona) {
        const mode = String(profileModeButton.dataset.personaProfileMode || "");
        state.personaPanels.settings = "profile";
        state.personaProfileModes[String(persona.id)] = ["edit", "style"].includes(mode) ? mode : "overview";
        renderPersonaDetail();
        renderConfirmSummary();
      }
    }
    const mediaTaskButton = event.target.closest("[data-persona-media-task]");
    if (mediaTaskButton) {
      const persona = selectedPersona();
      const personaId = String(persona?.id || state.renderedPersonaId || state.selectedPersonaId || "").trim();
      if (personaId) {
        snapshotPersonaCurrentForm();
        personaFormState(personaId).media.taskType = mediaTaskButton.dataset.personaMediaTask || "persona_post_image";
        renderPersonaDetail();
        renderConfirmSummary();
      }
      return;
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
    if (event.target.closest("[data-persona-exit-profile-regen]")) {
      exitPersonaProfileRegenEdit(selectedPersona()?.id || "");
      return;
    }
    if (event.target.closest("[data-persona-clear-profile-regen]")) {
      clearPersonaProfileRegenEdit(selectedPersona()?.id || "");
      return;
    }
    if (event.target.closest("[data-persona-regenerate-profile-content]")) regeneratePersonaProfileContent().catch((error) => showMsg("commandMsg", error.detail || error.message || "AI 生成简介失败", false));
    if (event.target.closest("[data-persona-save-threads]")) savePersonaThreadsBinding().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-unbind-threads]")) unbindPersonaThreadsBinding().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-save-style]")) savePersonaTweetStyle().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-clear-style]")) clearPersonaTweetStyle().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    const uploadPersonaImage = event.target.closest("[data-persona-upload-image-trigger]");
    if (uploadPersonaImage) {
      const input = $("personaImageUploadFile");
      if (input) {
        delete input.dataset.personaReplaceImage;
        input.click();
      }
      return;
    }
    const applyPersonaImage = event.target.closest("[data-persona-apply-image]");
    if (applyPersonaImage) applyPersonaReferenceImage(applyPersonaImage.dataset.personaApplyImage || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "切换人设图失败", false));
    const replacePersonaImage = event.target.closest("[data-persona-replace-image]");
    if (replacePersonaImage) {
      const input = $("personaImageUploadFile");
      if (input) {
        input.dataset.personaReplaceImage = replacePersonaImage.dataset.personaReplaceImage || "";
        input.click();
      }
      return;
    }
    const deletePersonaImage = event.target.closest("[data-persona-delete-image]");
    if (deletePersonaImage) {
      const imageId = deletePersonaImage.dataset.personaDeleteImage || "";
      const isCurrent = deletePersonaImage.closest(".persona-image-library-card")?.classList.contains("is-reference");
      const message = isCurrent
        ? "确定删除当前人设图吗？系统会自动切换到最新的历史图；没有历史图时将清空当前参考图。"
        : "确定删除这张历史人设图吗？删除后不可恢复。";
      confirmDangerAction(message, { title: "删除人设图", confirmText: "删除图片" })
        .then((ok) => {
          if (!ok) return;
          return deletePersonaLibraryImage(imageId);
        })
        .catch((error) => showMsg("commandMsg", error.detail || error.message || "删除人设图失败", false));
      return;
    }
    const linkPageButton = event.target.closest("[data-persona-link-page]");
    if (linkPageButton) {
      const profile = selectedPersonaProfile();
      const pageInfo = personaLinkPresetPage(personaProfilePresets(profile).length);
      const action = String(linkPageButton.dataset.personaLinkPage || "");
      if (action === "first") setPersonaLinkPresetPage(1);
      if (action === "prev") setPersonaLinkPresetPage(pageInfo.page - 1);
      if (action === "next") setPersonaLinkPresetPage(pageInfo.page + 1);
      if (action === "last") setPersonaLinkPresetPage(pageInfo.totalPages);
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    const viewPreset = event.target.closest("[data-persona-view-preset]");
    if (viewPreset) {
      viewPersonaPreset(viewPreset.dataset.personaViewPreset || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "查看失败", false));
      return;
    }
    const activatePresetId = event.target.closest("[data-persona-activate-preset-id]");
    if (activatePresetId) {
      activatePersonaPreset(activatePresetId.dataset.personaActivatePresetId || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
      return;
    }
    const deletePresetId = event.target.closest("[data-persona-delete-preset-id]");
    if (deletePresetId) {
      deletePersonaPreset(deletePresetId.dataset.personaDeletePresetId || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
      return;
    }
    const selectPreset = event.target.closest("[data-persona-select-preset]");
    if (selectPreset) {
      state.personaLinkPresetId = selectPreset.dataset.personaSelectPreset || "";
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    if (event.target.closest("[data-persona-add-preset]")) addPersonaPreset().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-save-preset]")) savePersonaPreset().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-delete-preset]")) deletePersonaPreset().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-activate-preset]")) activatePersonaPreset().catch((error) => showMsg("commandMsg", error.detail || error.message || "操作失败", false));
    if (event.target.closest("[data-persona-create-account]")) createPersonaAutomationAccount().catch((error) => showMsg("commandMsg", error.detail || error.message || "绑定账号失败", false));
    if (event.target.closest("[data-persona-save-login]")) savePersonaAutomationLogin().catch((error) => showMsg("commandMsg", error.detail || error.message || "保存登录资料失败", false));
    if (event.target.closest("[data-persona-clear-login]")) clearPersonaAutomationLogin().catch((error) => showMsg("commandMsg", error.detail || error.message || "删除登录资料失败", false));
    const personaOpenLogin = event.target.closest("[data-persona-open-login]");
    if (personaOpenLogin) {
      const persona = selectedPersona();
      const accountId = String(personaOpenLogin.dataset.personaOpenLogin || selectedPersonaAutomationAccount(persona)?.id || "").trim();
      createSocialTask("open_login", accountId, persona?.id || "", "commandMsg")
        .catch((error) => showMsg("commandMsg", error.detail || error.message || "打开登录失败", false));
    }
    if (event.target.closest("[data-open-unified-automation]")) {
      if (!(await confirmLeaveTransientWorkspaceState())) return;
      const account = accountForPersona(selectedPersona());
      if (account?.platform) state.accountPoolPlatform = normalizeAccountPoolPlatform(account.platform);
      if (account?.id) {
        state.accountPoolAccountId = String(account.id || "");
        state.accountPoolSelectedAccountIds = [String(account.id || "")];
        state.preferredAccountId = String(account.id || "");
      }
      setView("accounts");
      return;
    }
    const accountPasswordToggle = event.target.closest("[data-account-password-toggle]");
    if (accountPasswordToggle) {
      event.stopPropagation();
      toggleAccountPasswordVisibility(accountPasswordToggle)
        .catch((error) => showMsg(accountPasswordToggle.closest("[data-account-pool-account]") ? "socialMsg" : "commandMsg", error.detail || error.message || "读取登录密码失败", false));
      return;
    }
    const personaAccountSave = event.target.closest("[data-persona-account-save]");
    if (personaAccountSave) {
      savePersonaAccountCard(personaAccountSave.dataset.personaAccountSave || "", personaAccountSave)
        .catch((error) => showMsg("commandMsg", error.detail || error.message || "保存账号失败", false));
      return;
    }
    const personaAccountStartEdit = event.target.closest("[data-persona-account-start-edit]");
    if (personaAccountStartEdit) {
      setPersonaAccountEditing(personaAccountStartEdit.dataset.personaAccountStartEdit || "", true);
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    const personaAccountCancelEdit = event.target.closest("[data-persona-account-cancel-edit]");
    if (personaAccountCancelEdit) {
      clearAccountPasswordRevealState();
      setPersonaAccountEditing(personaAccountCancelEdit.dataset.personaAccountCancelEdit || "", false);
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    const personaAccountClearLogin = event.target.closest("[data-persona-account-clear-login]");
    if (personaAccountClearLogin) {
      clearPersonaAccountLogin(personaAccountClearLogin.dataset.personaAccountClearLogin || "", personaAccountClearLogin)
        .catch((error) => showMsg("commandMsg", error.detail || error.message || "清除登录资料失败", false));
      return;
    }
    const personaAccountEdit = event.target.closest("[data-persona-account-edit]");
    if (personaAccountEdit) {
      openAccountPoolEditModal(personaAccountEdit.dataset.personaAccountEdit || "");
      return;
    }
    const personaAccountPlatform = event.target.closest("[data-persona-account-platform]");
    if (personaAccountPlatform) {
      clearAccountPasswordRevealState();
      state.personaAccountEditingIds = {};
      state.personaAutomationPlatform = String(personaAccountPlatform.dataset.personaAccountPlatform || "").trim().toLowerCase() === "instagram" ? "instagram" : "threads";
      state.preferredAccountId = "";
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    const personaAccountOpenLogin = event.target.closest("[data-persona-account-open-login]");
    if (personaAccountOpenLogin) {
      const persona = selectedPersona();
      const accountId = String(personaAccountOpenLogin.dataset.personaAccountOpenLogin || "").trim();
      createSocialTask("open_login", accountId, persona?.id || "", "commandMsg")
        .catch((error) => showMsg("commandMsg", error.detail || error.message || "打开登录失败", false));
      return;
    }
    const personaAccountCard = event.target.closest("[data-persona-account-card]");
    if (personaAccountCard && !event.target.closest("button, a, input, select, textarea, label")) {
      clearAccountPasswordRevealState();
      state.preferredAccountId = String(personaAccountCard.dataset.personaAccountCard || "");
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    const deletePersonaButton = event.target.closest("[data-persona-delete]");
    if (deletePersonaButton) {
      deleteSelectedPersona(deletePersonaButton.dataset.personaDeleteId || "").catch((error) => showMsg("commandMsg", error.detail || error.message || "删除人设失败", false));
      return;
    }
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
      renderActivePersonaListSurface();
    }
  });
  $("moduleBody").addEventListener("change", async (event) => {
    if (event.target?.matches?.("[data-persona-hot-freshness-days]")) {
      const persona = selectedPersona();
      if (!persona) return;
      const days = normalizePersonaHotFreshnessDays(event.target.value);
      personaFormState(persona.id).generate.hotFreshnessDays = days;
      event.target.value = String(days);
      const unit = event.target.parentElement?.querySelector?.("[data-persona-hot-freshness-unit]");
      if (unit) unit.textContent = days > 0 ? "天内" : "不限";
      renderConfirmSummary();
      return;
    }
    if (event.target?.id === "personaHotReplacementFiles") {
      const persona = selectedPersona();
      const candidate = personaHotPreviewCandidate(persona);
      const candidateId = personaHotCandidateKey(candidate);
      if (!persona || !candidateId) return;
      snapshotPersonaHotPreviewContent();
      const files = Array.from(event.target.files || []).filter(Boolean);
      if (!files.length) return;
      addPersonaHotReplacementPoolFiles(persona.id, candidateId, files);
      event.target.value = "";
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    if (event.target?.matches?.("[data-persona-upload-image-file]")) {
      const file = event.target.files?.[0] || null;
      const imageId = String(event.target.dataset.personaReplaceImage || "").trim();
      event.target.value = "";
      delete event.target.dataset.personaReplaceImage;
      if (!file) return;
      const upload = imageId ? replacePersonaLibraryImage(imageId, file) : uploadPersonaReferenceImage(file);
      upload.catch((error) => showMsg("commandMsg", error.detail || error.message || (imageId ? "替换人设图失败" : "上传人设图失败"), false));
      return;
    }
    if (event.target?.matches?.("[data-persona-memory-id]")) {
      snapshotPersonaCurrentForm();
      syncPersonaMemorySelectionState();
      renderConfirmSummary();
    }
    if (event.target?.matches?.("[data-persona-bulk-post-id]")) {
      const persona = selectedPersona();
      if (!persona) return;
      const source = event.target.getAttribute("data-persona-bulk-post-source") === "favorites" ? "favorites" : "posts";
      const postId = String(event.target.getAttribute("data-persona-bulk-post-id") || "").trim();
      const selected = new Set(personaSelectedPostIds(persona, source));
      if (event.target.checked) selected.add(postId);
      else selected.delete(postId);
      setPersonaSelectedPostIds(persona, source, Array.from(selected));
      renderPersonaDetail();
      renderConfirmSummary();
      return;
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
      state.transientWorkspaceLeaveAcknowledgement = "";
      if (event.target.checked || !form.hotPreviewId) form.hotPreviewId = candidateId;
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
      const persona = selectedPersona();
      if (persona && !(await canLeavePersonaDraftEdit(persona.id, "posts"))) {
        const current = String(state.selectedPersonaPostId || "").trim();
        if (current) event.target.value = current;
        return;
      }
      setSelectedPersonaPostId(event.target.value || "");
      ensurePersonaPostPageForPost(persona, personaPostSource(persona), state.selectedPersonaPostId);
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
      refreshAutomationWorkSurface();
      renderConfirmSummary();
    }
    if (event.target?.id === "personaAutoAccount") {
      state.preferredAccountId = event.target.value || "";
      refreshAutomationWorkSurface();
      renderConfirmSummary();
    }
    if (event.target?.id === "personaStrategySelect") {
      const strategyGroup = String(event.target.dataset.strategyGroup || "");
      if (strategyGroup) setPersonaStrategyId(strategyGroup, event.target.value || "");
      refreshAutomationWorkSurface();
      renderConfirmSummary();
    }
  });
  $("moduleBody").addEventListener("input", (event) => {
    if (event.target?.id === "personaPublishScheduleAt") {
      const personaId = String(selectedPersona()?.id || "").trim();
      if (personaId) state.personaPublishScheduleValues[personaId] = event.target.value || "";
      return;
    }
    if (event.target?.id === "personaHotPreviewContent") {
      snapshotPersonaHotPreviewContent();
      renderConfirmSummary();
      return;
    }
    if (event.target?.id === "personaNewGroupName") {
      state.personaNewGroupName = event.target.value || "";
      window.__personaNewGroupName = state.personaNewGroupName;
    }
    if (event.target?.id === "personaDraftTitle" || event.target?.id === "personaDraftContent") {
      updatePersonaDraftEditVisualState();
      renderConfirmSummary();
    }
    if (event.target?.id === "personaMemorySearch") {
      applyPersonaMemoryFilter(event.target.value || "");
    }
  });
  $("refreshAll")?.addEventListener("click", () => {
    const refreshPublishing = state.activeModule === "publishing";
    if (state.view === "billing") loadBilling({ force: true }).catch(() => {});
    renderWorkspace(false);
    loadTasks().then(() => scheduleWorkspaceRender(false)).catch(() => {});
    loadPersonas().then(() => scheduleWorkspaceRender(false)).catch(() => {});
    if (state.currentUser?.is_admin) {
      loadSetupStatus().then(() => scheduleWorkspaceRender(false)).catch(() => {});
    }
    loadSocial({ render: false }).then(() => {
      updateAccountStatusViews();
      scheduleWorkspaceRender(false);
    }).catch(() => {});
    if (refreshPublishing) refreshCurrentPublishingPersonaContent({ force: false }).catch(() => {});
  });
  if ($("refreshTasks")) $("refreshTasks").addEventListener("click", () => loadTasks().then(renderWorkspace));
  if ($("refreshSocialTasks")) $("refreshSocialTasks").addEventListener("click", () => loadSocial().then(renderWorkspace));
  if ($("refreshAccounts")) $("refreshAccounts").addEventListener("click", () => loadSocial().then(renderWorkspace));
  $("taskTable").addEventListener("click", (event) => {
    const selectionInput = event.target.closest("[data-task-queue-select]");
    if (selectionInput) {
      const [kind, id] = String(selectionInput.dataset.taskQueueSelect || "").split(":");
      const set = taskQueueSet(kind);
      if (selectionInput.checked) set.add(String(id || ""));
      else set.delete(String(id || ""));
      $("taskTable").innerHTML = renderTaskQueueView();
      return;
    }
    const selectAllInput = event.target.closest("[data-task-queue-select-all]");
    if (selectAllInput) {
      const kind = String(selectAllInput.dataset.taskQueueSelectAll || "");
      const set = taskQueueSet(kind);
      const rows = taskQueueRowsForKind(kind);
      const summary = taskQueueSelectionSummary(kind);
      if (!summary.allSelected) rows.forEach((task) => task.id && set.add(String(task.id)));
      else rows.forEach((task) => task.id && set.delete(String(task.id)));
      $("taskTable").innerHTML = renderTaskQueueView();
      return;
    }
    const deleteSelected = event.target.closest("[data-task-queue-delete-selected]");
    if (deleteSelected) {
      deleteSelectedTaskQueueRecords(deleteSelected.dataset.taskQueueDeleteSelected || "", "taskQueueMsg")
        .catch((error) => showMsg("taskQueueMsg", error.detail || error.message || "清空选中失败", false));
      return;
    }
    const taskRefreshButton = event.target.closest("[data-task-refresh]");
    if (taskRefreshButton) {
      loadTasks().then(renderWorkspace);
      return;
    }
    const taskQueuePanelButton = event.target.closest("[data-task-queue-panel]");
    if (taskQueuePanelButton) {
      state.taskQueuePanel = taskQueuePanelButton.dataset.taskQueuePanel === "regular" ? "regular" : "persona";
      $("taskTable").innerHTML = renderTaskQueueView();
      return;
    }
    const taskQueuePageButton = event.target.closest("[data-task-queue-page]");
    if (taskQueuePageButton) {
      const [kind, action] = String(taskQueuePageButton.dataset.taskQueuePage || "").split(":");
      if (kind === "persona") {
        const pageSize = Math.min(Math.max(Number(state.taskQueuePersonaPageSize || 12), 1), 100);
        const totalPages = Math.max(1, Math.ceil(personaAutomationTasksFor(selectedPersona()?.id).length / pageSize));
        if (action === "prev") state.taskQueuePersonaPage = Math.max(1, Number(state.taskQueuePersonaPage || 1) - 1);
        if (action === "next") state.taskQueuePersonaPage = Math.min(totalPages, Number(state.taskQueuePersonaPage || 1) + 1);
      }
      if (kind === "regular") {
        const pageSize = Math.min(Math.max(Number(state.taskQueueRegularPageSize || 20), 1), 100);
        const totalPages = Math.max(1, Math.ceil((state.tasks || []).length / pageSize));
        if (action === "prev") state.taskQueueRegularPage = Math.max(1, Number(state.taskQueueRegularPage || 1) - 1);
        if (action === "next") state.taskQueueRegularPage = Math.min(totalPages, Number(state.taskQueueRegularPage || 1) + 1);
      }
      $("taskTable").innerHTML = renderTaskQueueView();
      return;
    }
    const taskPersonaSelect = event.target.closest("[data-task-persona-select]");
    if (taskPersonaSelect) {
      state.selectedPersonaId = taskPersonaSelect.dataset.taskPersonaSelect || "";
      setSelectedPersonaPostId("");
      state.taskQueuePersonaPage = 1;
      $("taskTable").innerHTML = renderTaskQueueView();
      return;
    }
    const openPersona = event.target.closest("[data-task-open-persona]");
    if (openPersona) {
      state.workspaceMenuOpen = true;
      setView("workspace");
      setModule("personas");
      return;
    }
    const clearPersonaQueue = event.target.closest("[data-task-clear-persona-queue]");
    if (clearPersonaQueue) {
      confirmDangerAction("确定删除该人设的全部自动化队列记录吗？删除后不可恢复。", {
        title: "删除全部记录",
        confirmText: "删除全部",
      }).then((ok) => {
        if (!ok) return;
        clearPersonaAutomationTasksFor(clearPersonaQueue.dataset.taskClearPersonaQueue || "", "taskQueueMsg")
          .catch((error) => showMsg("taskQueueMsg", error.detail || error.message || "清理队列失败", false));
      });
      return;
    }
    const socialRetry = event.target.closest("[data-social-retry]");
    if (socialRetry) {
      api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(socialRetry.dataset.socialRetry)}/retry`, { method: "POST" })
        .then(() => Promise.all([loadSocial().catch(() => {}), loadTasks().catch(() => {})]))
        .then(() => showMsg("taskQueueMsg", "自动化任务已重新排队。", true))
        .catch((error) => showMsg("taskQueueMsg", error.detail || error.message || "重试失败", false));
      return;
    }
    const socialCancel = event.target.closest("[data-social-cancel]");
    if (socialCancel) {
      cancelSocialAutomationTask(socialCancel.dataset.socialCancel, "taskQueueMsg").catch((error) => showMsg("taskQueueMsg", error.detail || error.message || "停止任务失败", false));
      return;
    }
    const socialDelete = event.target.closest("[data-social-delete]");
    if (socialDelete) {
      confirmDangerAction("确定删除这条自动化记录吗？删除后不可恢复。").then((ok) => {
        if (!ok) return;
        deleteSocialTaskRecord(socialDelete.dataset.socialDelete || "", "taskQueueMsg")
          .catch((error) => showMsg("taskQueueMsg", error.detail || error.message || "删除记录失败", false));
      });
      return;
    }
    const socialPreview = event.target.closest("[data-social-preview]");
    if (socialPreview) {
      openLiveBrowserTaskView(socialPreview.dataset.socialPreview || "");
      return;
    }
    const socialLog = event.target.closest("[data-social-log]");
    if (socialLog) {
      showSocialLog(socialLog.dataset.socialLog || "").catch((error) => showMsg("taskQueueMsg", error.detail || error.message || "查看日志失败", false));
      return;
    }
    const button = event.target.closest("button");
    if (!button) return;
    const id = button.dataset.detail || button.dataset.retry || button.dataset.cancelTask || button.dataset.deleteTask;
    if (button.dataset.detail) showTaskDetail(id).catch((error) => appendEvent("error", error.detail || error.message));
    if (button.dataset.retry) api(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" }).then(loadTasks);
    if (button.dataset.cancelTask) cancelRegularTask(id, "commandMsg").catch((error) => showMsg("commandMsg", error.detail || error.message || "停止任务失败", false));
    if (button.dataset.deleteTask) {
      confirmDangerAction("确定删除这条任务记录吗？删除后不可恢复。").then((ok) => {
        if (!ok) return;
        deleteRegularTaskRecord(id, "taskQueueMsg")
          .catch((error) => showMsg("taskQueueMsg", error.detail || error.message || "删除记录失败", false));
      });
    }
  });
  $("moduleBody").addEventListener("input", (event) => {
    const passwordInput = event.target.closest?.("[data-account-password-input]");
    if (passwordInput) passwordInput.dataset.passwordDirty = "true";
  });
  $("moduleBody").addEventListener("keydown", (event) => {
    const personaAccountCard = event.target.closest?.("[data-persona-account-card]");
    if (personaAccountCard && ["Enter", " "].includes(event.key)) {
      if (event.target.closest("button, a, input, select, textarea, label")) return;
      event.preventDefault();
      state.preferredAccountId = String(personaAccountCard.dataset.personaAccountCard || "");
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    const generatedPreviewCard = event.target.closest?.("[data-persona-generated-card]");
    if (!generatedPreviewCard || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    selectGeneratedPreviewPost(generatedPreviewCard.dataset.personaGeneratedCard || "");
  });
  if ($("submitSocialTask")) $("submitSocialTask").addEventListener("click", () => createSocialTask().catch((error) => showMsg("socialMsg", error.detail || error.message || "提交失败", false)));
  if ($("socialAccount")) $("socialAccount").addEventListener("change", syncStandaloneSocialForm);
  if ($("socialPlatform")) $("socialPlatform").addEventListener("change", syncStandaloneSocialForm);
  if ($("runSocialOnce")) $("runSocialOnce").addEventListener("click", () => api("/api/persona_dashboard/automation/worker/run_once", { method: "POST" }).then(loadSocial).catch((error) => showMsg("socialMsg", error.detail || error.message || "执行失败", false)));
  if ($("accountBrowserShell")) $("accountBrowserShell").addEventListener("click", (event) => {
    if (event.target.closest("[data-live-browser-modal-close]")) {
      closeLiveBrowserLargeModal();
      return;
    }
    const tab = event.target.closest("[data-account-browser-tab]");
    if (tab) {
      setAccountBrowserPanel(tab.dataset.accountBrowserTab || "accounts");
      return;
    }
    const accountPasswordToggle = event.target.closest("[data-account-password-toggle]");
    if (accountPasswordToggle) {
      event.stopPropagation();
      toggleAccountPasswordVisibility(accountPasswordToggle)
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "读取登录密码失败", false));
      return;
    }
    if (event.target.closest("[data-proxy-add]")) {
      openProxyModal();
      return;
    }
    const proxyCheck = event.target.closest("[data-proxy-check]");
    if (proxyCheck) {
      checkProxy(proxyCheck.dataset.proxyCheck || "").catch((error) => showMsg("socialMsg", error.detail || error.message || "代理检测失败", false));
      return;
    }
    const proxyEdit = event.target.closest("[data-proxy-edit]");
    if (proxyEdit) {
      openProxyModal(proxyEdit.dataset.proxyEdit || "");
      return;
    }
    const proxyDelete = event.target.closest("[data-proxy-delete]");
    if (proxyDelete) {
      deleteProxy(proxyDelete.dataset.proxyDelete || "").catch((error) => showMsg("socialMsg", error.detail || error.message || "删除代理失败", false));
      return;
    }
    const proxyPage = event.target.closest("[data-proxy-page]");
    if (proxyPage) {
      const totalPages = Math.max(1, Math.ceil(proxyPoolRows().length / Number(state.proxyPoolPageSize || 10)));
      state.proxyPoolPage = proxyPage.dataset.proxyPage === "prev"
        ? Math.max(1, Number(state.proxyPoolPage || 1) - 1)
        : Math.min(totalPages, Number(state.proxyPoolPage || 1) + 1);
      renderProxyPool();
      return;
    }
    const liveBrowserLayout = event.target.closest("[data-live-browser-layout]");
    if (liveBrowserLayout) {
      setLiveBrowserLayout(liveBrowserLayout.dataset.liveBrowserLayout || "grid");
      return;
    }
    const cancelAll = event.target.closest("[data-social-cancel-all]");
    if (cancelAll) {
      cancelAllSocialAutomationTasks("socialMsg")
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "停止全部任务失败", false));
      return;
    }
    const accountPoolBind = event.target.closest("[data-account-pool-bind-persona]");
    if (accountPoolBind) {
      bindAccountPoolAccountToPersona(accountPoolBind.dataset.accountPoolBindPersona || "")
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "绑定账号失败", false));
      return;
    }
    const accountPoolBindCard = event.target.closest("[data-persona-card]");
    if (accountPoolBindCard && accountPoolBindCard.closest(".account-pool-persona-shell")) {
      const bindButton = accountPoolBindCard.querySelector("[data-account-pool-bind-persona]");
      if (bindButton && !bindButton.disabled) {
        const rect = bindButton.getBoundingClientRect();
        const inBindArea = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (inBindArea) {
          bindAccountPoolAccountToPersona(bindButton.dataset.accountPoolBindPersona || "")
            .catch((error) => showMsg("socialMsg", error.detail || error.message || "绑定账号失败", false));
          return;
        }
      }
    }
    const accountPersonaSelect = event.target.closest("[data-persona-select]") || (
      event.target.closest(".persona-card-edit, .persona-card-menu, .persona-card-submenu, button, a, input, select, textarea")
        ? null
        : event.target.closest("[data-persona-card]")
    );
    if (accountPersonaSelect && accountPersonaSelect.closest(".account-pool-persona-shell")) {
      state.accountPoolPersonaId = String(accountPersonaSelect.dataset.personaSelect || accountPersonaSelect.dataset.personaCard || "");
      renderSocialAccounts();
      return;
    }
    const accountToggleFolder = event.target.closest("[data-persona-toggle-folder]");
    if (accountToggleFolder && accountToggleFolder.closest(".account-pool-persona-shell")) {
      togglePersonaCollection(accountToggleFolder.dataset.personaToggleFolder || "")
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "操作失败", false));
      return;
    }
    const accountListPage = event.target.closest("[data-persona-list-page]");
    if (accountListPage && accountListPage.closest(".account-pool-persona-shell")) {
      const total = personaListTotalPages();
      const action = accountListPage.dataset.personaListPage || "";
      if (action === "first") state.personaListPage = 1;
      if (action === "prev") state.personaListPage = Math.max(1, Number(state.personaListPage || 1) - 1);
      if (action === "next") state.personaListPage = Math.min(total, Number(state.personaListPage || 1) + 1);
      if (action === "last") state.personaListPage = total;
      renderSocialAccounts();
      return;
    }
    const accountAutomationMode = event.target.closest("[data-account-pool-automation-mode]");
    if (accountAutomationMode) {
      const mode = String(accountAutomationMode.dataset.accountPoolAutomationMode || "reply_comment");
      state.simpleBranches.account_automation = ["reply_comment", "reply_hot", "warmup"].includes(mode) ? mode : "reply_comment";
      const account = selectedAccountPoolAccount();
      setAccountPoolAutomationContext(account);
      renderSocialAccounts();
      return;
    }
    const accountRunThreads = event.target.closest("[data-account-pool-run-threads]");
    if (accountRunThreads) {
      runAccountPoolThreadsTask(accountRunThreads.dataset.accountPoolRunThreads || "")
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "提交任务失败", false));
      return;
    }
    const accountCopySelected = event.target.closest("[data-account-pool-copy-selected]");
    if (accountCopySelected) {
      copyAccountPoolSelectedAccounts().catch((error) => showMsg("socialMsg", error.detail || error.message || "复制账号失败", false));
      return;
    }
    const accountSelectAll = event.target.closest("[data-account-pool-select-all]");
    if (accountSelectAll) {
      selectAllAccountPoolAccounts();
      return;
    }
    const accountClearSelected = event.target.closest("[data-account-pool-clear-selected]");
    if (accountClearSelected) {
      clearAccountPoolAccountSelection();
      renderSocialAccounts();
      return;
    }
    const accountDeleteSelected = event.target.closest("[data-account-pool-delete-selected]");
    if (accountDeleteSelected) {
      deleteSelectedAccountPoolAccounts().catch((error) => showMsg("socialMsg", error.detail || error.message || "删除账号失败", false));
      return;
    }
    const platform = event.target.closest("[data-account-pool-platform]");
    if (platform) {
      state.accountPoolPlatform = normalizeAccountPoolPlatform(platform.dataset.accountPoolPlatform || "");
      state.accountPoolAccountId = "";
      state.accountPoolSelectedAccountIds = [];
      resetAccountPoolCreateForm();
      renderSocialAccounts();
      return;
    }
    const accountAdd = event.target.closest("[data-account-pool-add]");
    if (accountAdd) {
      openAccountPoolCreateModal();
      return;
    }
    const accountCreateCancel = event.target.closest("[data-account-pool-create-cancel]");
    if (accountCreateCancel) {
      resetAccountPoolCreateForm();
      renderSocialAccounts();
      return;
    }
    const accountCreateSave = event.target.closest("[data-account-pool-create-save]");
    if (accountCreateSave) {
      saveAccountPoolCreateForm().catch((error) => showMsg("socialMsg", error.detail || error.message || "添加账号失败", false));
      return;
    }
    const accountCheckTarget = event.target.closest(".account-pool-card-check");
    if (accountCheckTarget) {
      event.preventDefault();
      const accountCheck = accountCheckTarget.querySelector("[data-account-pool-check]");
      if (!accountCheck) return;
      toggleAccountPoolAccount(accountCheck.dataset.accountPoolCheck || "");
      renderSocialAccounts();
      return;
    }
    const accountEdit = event.target.closest("[data-account-pool-edit]");
    if (accountEdit) {
      openAccountPoolEditModal(accountEdit.dataset.accountPoolEdit || "");
      return;
    }
    const accountProxyPicker = event.target.closest("[data-account-proxy-picker]");
    if (accountProxyPicker) {
      openAccountProxyPickerModal(accountProxyPicker.dataset.accountProxyPicker || "");
      return;
    }
    const openLogin = event.target.closest("[data-social-open-login]");
    if (openLogin) {
      const accountId = String(openLogin.dataset.socialOpenLogin || "").trim();
      const account = selectedSocialAccount(accountId);
      createSocialTask("open_login", accountId, account?.persona_id || "", "socialMsg")
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "打开登录失败", false));
      return;
    }
    const accountCard = event.target.closest("[data-account-pool-account]");
    const accountAction = event.target.closest("[data-social-open-login], [data-account-proxy-picker], [data-account-pool-edit], [data-account-pool-unbind], [data-social-delete-account], .account-pool-card-check");
    if (accountCard && !accountAction) {
      selectAccountPoolAccount(accountCard.dataset.accountPoolAccount || "");
      renderSocialAccounts();
      return;
    }
    const accountPanelBlank = event.target.closest(".account-pool-account-panel");
    if (accountPanelBlank && !event.target.closest(".account-pool-card, button, a, input, select, textarea, label")) {
      clearAccountPoolAccountSelection();
      renderSocialAccounts();
      return;
    }
    const personaPanelBlank = event.target.closest(".account-pool-persona-shell");
    if (personaPanelBlank && !event.target.closest("[data-persona-card], [data-persona-folder-card], button, a, input, select, textarea, label")) {
      clearAccountPoolPersonaSelection();
      renderSocialAccounts();
      return;
    }
    const accountUnbind = event.target.closest("[data-account-pool-unbind]");
    if (accountUnbind) {
      unbindAccountPoolAccount(accountUnbind.dataset.accountPoolUnbind || "")
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "解绑账号失败", false));
      return;
    }
    const dedupe = event.target.closest("[data-social-dedupe-accounts]");
    const deleteAccount = event.target.closest("[data-social-delete-account]");
    if (dedupe) {
      confirmDangerAction("确定清理过期重复账号吗？系统会保留同平台同用户名中状态最好或最近更新的一条。", {
        title: "清理重复账号",
        confirmText: "清理重复",
      }).then((ok) => {
        if (!ok) return;
        dedupeSocialAccountRecords("socialMsg").catch((error) => showMsg("socialMsg", error.detail || error.message || "清理重复账号失败", false));
      });
    }
    if (deleteAccount) {
      confirmDangerAction("确定删除这个执行账号吗？相关历史自动化记录也会一起删除。", {
        title: "删除执行账号",
        confirmText: "删除账号",
      }).then((ok) => {
        if (!ok) return;
        deleteSocialAccountRecord(deleteAccount.dataset.socialDeleteAccount || "", "socialMsg")
          .catch((error) => showMsg("socialMsg", error.detail || error.message || "删除账号失败", false));
      });
    }
    const liveBrowserMode = event.target.closest("[data-live-browser-mode]");
    if (liveBrowserMode) {
      setLiveBrowserMode(
        liveBrowserMode.dataset.liveBrowserModeSession || "",
        liveBrowserMode.dataset.liveBrowserMode || "manual",
      ).catch((error) => showMsg("socialMsg", error.detail || error.message || "切换人工接管失败", false));
      return;
    }
    const fullscreen = event.target.closest("[data-live-browser-fullscreen]");
    if (fullscreen) {
      requestLiveBrowserFullscreen(fullscreen.dataset.liveBrowserFullscreen || "", fullscreen);
      return;
    }
    const closeLiveBrowser = event.target.closest("[data-live-browser-close]");
    if (closeLiveBrowser) {
      closeLiveBrowserSession(closeLiveBrowser.dataset.liveBrowserClose || "")
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "关闭浏览器窗口失败", false));
      return;
    }
    const liveBrowserType = event.target.closest("[data-live-browser-type]");
    if (liveBrowserType) {
      sendLiveBrowserText(liveBrowserType.dataset.liveBrowserType || "")
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "发送文本失败", false));
      return;
    }
    const liveBrowserKey = event.target.closest("[data-live-browser-key]");
    if (liveBrowserKey) {
      pressLiveBrowserKey(liveBrowserKey.dataset.liveBrowserKey || "", liveBrowserKey.dataset.liveBrowserKeyValue || "Enter")
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "发送按键失败", false));
      return;
    }
    const liveBrowserScreenshot = event.target.closest("[data-live-browser-screenshot]");
    if (liveBrowserScreenshot) {
      captureLiveBrowserScreenshot(liveBrowserScreenshot.dataset.liveBrowserScreenshot || "")
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "浏览器截图失败", false));
      return;
    }
    const cancel = event.target.closest("[data-social-cancel]");
    if (cancel) cancelSocialAutomationTask(cancel.dataset.socialCancel, "socialMsg").catch((error) => showMsg("socialMsg", error.detail || error.message || "停止任务失败", false));
  });
  if ($("accountBrowserShell")) $("accountBrowserShell").addEventListener("keydown", (event) => {
    const liveBrowserInput = event.target.closest("[data-live-browser-text]");
    if (liveBrowserInput && event.key === "Enter") {
      event.preventDefault();
      sendLiveBrowserText(liveBrowserInput.dataset.liveBrowserText || "", { pressEnter: true })
        .catch((error) => showMsg("socialMsg", error.detail || error.message || "发送文本失败", false));
      return;
    }
    if (!["Enter", " "].includes(event.key)) return;
    if (event.target.closest("button, a, input, select, textarea")) return;
    const accountCard = event.target.closest("[data-account-pool-account]");
    if (!accountCard || !event.target.closest(".account-pool-card")) return;
    event.preventDefault();
    selectAccountPoolAccount(accountCard.dataset.accountPoolAccount || "");
    renderSocialAccounts();
  });
  document.addEventListener("keydown", (event) => {
    trapLiveBrowserModalFocus(event);
    if (event.key === "Escape" && state.liveBrowserExpandedSessionId) {
      event.preventDefault();
      closeLiveBrowserLargeModal();
    }
  });
  if ($("accountBrowserShell")) $("accountBrowserShell").addEventListener("input", (event) => {
    if (event.target.closest(".account-pool-create-panel")) syncAccountPoolCreateDraftFromForm();
  });
  if ($("accountBrowserShell")) $("accountBrowserShell").addEventListener("change", (event) => {
    const proxyPageSize = event.target.closest("[data-proxy-page-size]");
    if (proxyPageSize) {
      state.proxyPoolPageSize = [10, 20, 50].includes(Number(proxyPageSize.value)) ? Number(proxyPageSize.value) : 10;
      state.proxyPoolPage = 1;
      renderProxyPool();
      return;
    }
    const strategySelect = event.target.closest("[data-account-pool-automation-strategy]");
    if (!strategySelect) return;
    const strategyGroup = String(strategySelect.dataset.accountPoolAutomationStrategy || "");
    if (strategyGroup) setPersonaStrategyId(strategyGroup, strategySelect.value || "");
    renderSocialAccounts();
  });
  if ($("socialTaskList")) $("socialTaskList").addEventListener("click", (event) => {
    const preview = event.target.closest("[data-social-preview]");
    const log = event.target.closest("[data-social-log]");
    const retry = event.target.closest("[data-social-retry]");
    const cancel = event.target.closest("[data-social-cancel]");
    if (preview) openLiveBrowserTaskView(preview.dataset.socialPreview || "");
    if (log) showSocialLog(log.dataset.socialLog);
    if (retry) api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(retry.dataset.socialRetry)}/retry`, { method: "POST" }).then(loadSocial);
    if (cancel) cancelSocialAutomationTask(cancel.dataset.socialCancel, "socialMsg").catch((error) => showMsg("socialMsg", error.detail || error.message || "停止任务失败", false));
  });
  $("openAdmin").addEventListener("click", async () => {
    if (!(await confirmLeaveTransientWorkspaceState({ allowNextUnload: true }))) return;
    clearTenantInMemoryState();
    location.href = "/admin.html";
  });
  $("consoleSettingsBody").addEventListener("click", (event) => {
    const completionPolicy = event.target.closest("[data-browser-completion-policy]");
    if (completionPolicy) {
      setBrowserPreferenceChoice("completion_policy", completionPolicy.dataset.browserCompletionPolicy || "immediate_close");
      return;
    }
    const inputMode = event.target.closest("[data-browser-text-input-mode]");
    if (inputMode) {
      setBrowserPreferenceChoice("text_input_mode", inputMode.dataset.browserTextInputMode || "paste");
      return;
    }
    if (event.target.closest("[data-browser-recommendation-refresh]")) {
      loadBrowserPolicySettings({ recommendationOnly: true });
      return;
    }
    if (event.target.closest("[data-browser-auto-configure]")) {
      autoConfigureBrowserPreferences();
      return;
    }
    if (event.target.closest("#saveConsoleSettings")) saveConsoleSettingsPage();
  });
  $("consoleSettingsBody").addEventListener("input", (event) => {
    const durationInput = event.target.closest("[data-browser-duration-field]");
    if (durationInput) {
      updateBrowserDurationDraft(durationInput.dataset.browserDurationField, { mode: "custom", rawValue: durationInput.value });
    }
    if (event.target.closest("[data-browser-preference-field]")) updateBrowserPreferencesDraft();
  });
  $("consoleSettingsBody").addEventListener("change", (event) => {
    const durationSelect = event.target.closest("[data-browser-duration-select]");
    if (durationSelect) {
      syncBrowserDurationCustomField(durationSelect, { focus: durationSelect.value === "custom" });
      return;
    }
    const durationInput = event.target.closest("[data-browser-duration-field]");
    if (durationInput) {
      updateBrowserPreferencesDraft();
      return;
    }
    if (event.target.closest("[data-browser-preference-field]")) updateBrowserPreferencesDraft();
  });
}

let identityRevalidationEventsBound = false;

function bindIdentityRevalidationEvents() {
  if (identityRevalidationEventsBound) return;
  identityRevalidationEventsBound = true;
  window.addEventListener("pageshow", () => {
    revalidateConsoleIdentity();
  });
  window.addEventListener("focus", () => {
    revalidateConsoleIdentity();
  });
}

async function init() {
  renderAdminWorkspaceBanner();
  applyTheme(currentTheme());
  ensurePersonaMediaLightbox();
  beginWorkspaceBootstrapLoading();
  const me = await loadMe();
  if (!me || consoleBoundaryNavigationActive) return;
  const expectedBootstrapUserId = consoleBootstrapUserId();
  if (expectedBootstrapUserId && expectedBootstrapUserId !== consoleUserId(me.id)) {
    reloadForIdentityChange();
    return;
  }
  consoleIdentityReady = true;
  bindIdentityRevalidationEvents();
  const hasPersonaBootstrap = hydratePersonaOverviewFromBootstrap(me);
  bindEvents();
  setView(state.view);
  renderWorkspace();
  if (me.is_admin) {
    loadSetupStatus().catch(() => {});
  } else {
    state.setupStatus = null;
  }
  loadTasks().catch(() => {});
  loadSocial({ render: false }).then(() => {
    updateAccountStatusViews();
    if (!hasPersonaBootstrap || isPersonaWorkspaceModule() || state.activeModule === "publishing" || state.activeModule === "automation") scheduleWorkspaceRender(false);
  }).catch(() => {});
  loadPersonas().then(() => {
    if (state.activeModule === "publishing") refreshCurrentPublishingPersonaContent({ force: false }).catch(() => []);
  }).catch(() => {}).finally(() => {
    finishWorkspaceBootstrapLoading();
    scheduleWorkspaceRender(false);
  });
}

window.addEventListener("vecto:logout-request", () => {
  void logoutConsoleSession();
});
window.addEventListener("vecto:navigation-ready", () => {
  if (state.currentUser) window.VectoSiteNavigation?.setAccount(state.currentUser);
});

init().catch((error) => {
  appendEvent("error", error.detail || error.message || "控制台初始化失败");
});
