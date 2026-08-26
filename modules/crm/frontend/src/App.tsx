import { Children, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { CrmApiError, adminWorkspaceContext, crmApi, payloadItems } from "./api";
import { catalog, localizedError, operationCatalog, readLanguage, type Messages } from "./i18n";
import { Icon } from "./icons";
import { PlatformLogo, normalizePlatform, platformLabel } from "./platform";
import { AnalyticsView, DestinationsView, GroupsView, MixBar, PoolsView, SchedulesView, StructuredEvidence, TemplatesView } from "./BusinessViews";
import { BarChart, DonutChart, LineChart } from "./charts";
import { chartColor, dailyTrend, eventPreviewLabel, groupEventMix, humanText, isEnglishMachineLabel, isOpaqueUserValue, isTechnicalId, isTechnicalKey, metricLabel, mixFromValues, mixParts, taskTitle, workflowLabel } from "./present";
import { useTaskPolling } from "./useTaskPolling";
import { WorkflowWizard, type WizardView } from "./WorkflowWizard";
import { mergeCursorPage } from "./runtime-helpers.js";
import { applyDockPill, applySegmentPill, prefersReducedMotion } from "./segment-motion";
import { ConfirmHost, ConsoleModal, clearPageScrollLock, requestConfirm } from "./confirm-dialog";
import type { BootstrapPayload, CrmAccount, CrmAction, CrmStep, CrmTask, Language, ViewId } from "./types";

declare global {
  interface Window {
    VectoSiteNavigation?: {
      setAccount?: (account: Record<string, unknown>) => void;
      currentLanguage?: () => Language;
    };
  }
}

const viewIds: ViewId[] = [
  "overview", "collect", "pools", "public", "outreach", "groups",
  "relationships", "tasks", "schedules", "templates", "accounts", "settings",
];

type NavViewId = "overview" | "collect" | "public" | "tasks" | "settings";
const navViews: NavViewId[] = ["overview", "collect", "public", "tasks", "settings"];
const viewAliases: Partial<Record<ViewId, ViewId>> = {
  pools: "collect",
  outreach: "public",
  groups: "public",
  schedules: "tasks",
  templates: "settings",
  accounts: "settings",
  relationships: "settings",
};
const engageTabs: ViewId[] = ["public", "outreach", "groups"];
const taskTabs: ViewId[] = ["tasks", "schedules"];
const settingTabs: ViewId[] = ["accounts", "templates", "settings", "relationships"];

const endpointByView: Partial<Record<ViewId, string>> = {
  collect: "hotspots",
  pools: "pools",
  public: "events",
  outreach: "tasks",
  groups: "groups",
  relationships: "relationships",
  schedules: "schedules",
  templates: "templates",
  settings: "destinations",
};

const writeViews = new Set<ViewId>(["collect", "public", "outreach", "groups", "relationships"]);
const workflowActionByView: Partial<Record<ViewId, { actionType: string; write: boolean; sku?: string }>> = {
  collect: { actionType: "collect_profile", write: false },
  public: { actionType: "public_comment", write: true, sku: "threads_auto_reply_batch" },
  outreach: { actionType: "direct_message", write: true, sku: "crm_direct_message_batch" },
  groups: { actionType: "threads_group_invite_post", write: true, sku: "crm_group_invite_batch" },
  relationships: { actionType: "relationship_verify", write: false },
};
const capabilityByView: Partial<Record<ViewId, string>> = {
  collect: "customer_collection",
  public: "public_interaction",
  outreach: "direct_message_batch",
  groups: "threads_community_post",
  relationships: "relationship_live_verify",
};
const activeStatuses = new Set(["queued", "running", "manual_required", "paused_by_user", "paused_by_policy", "unknown", "awaiting_confirmation"]);

function navViewOf(view: ViewId): NavViewId {
  return (viewAliases[view] || view) as NavViewId;
}

function hashView(): ViewId {
  const value = window.location.hash.replace(/^#\/?/, "") as ViewId;
  return viewIds.includes(value) ? value : "overview";
}

function displayValue(value: unknown): string {
  return humanText(value);
}

function itemId(item: Record<string, unknown>, index: number) {
  return String(item.id || item.task_id || item.legacy_id || item.username || index);
}

function itemTitle(item: Record<string, unknown>, fallback: string, language: Language = "zh-Hans") {
  const person = humanText(item.preview_user || item.username || item.display_name, "");
  if (person && person !== "—") return person.startsWith("@") ? person : `@${person}`;
  const eventName = eventPreviewLabel(String(item.event_type || item.preview_text || ""), language);
  if (eventName) return eventName;
  return taskTitle(item, fallback, language);
}

function localizedDate(value: unknown, language: Language) {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = typeof value === "number" || /^\d+$/.test(String(value)) ? Number(value) : NaN;
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(String(value));
  if (Number.isNaN(date.getTime())) return displayValue(value);
  const timeZone = document.documentElement.dataset.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  return new Intl.DateTimeFormat(language === "zh-Hant" ? "zh-Hant" : "zh-Hans", {
    dateStyle: "medium", timeStyle: "short", timeZone,
  }).format(date);
}

function itemMeta(item: Record<string, unknown>, language: Language) {
  const rawPreview = String(item.preview_text || item.content || item.message || item.description || item.summary || "").trim();
  const mappedPreview = rawPreview ? eventPreviewLabel(rawPreview, language) : "";
  const preview = mappedPreview || humanText(rawPreview, "");
  if (preview && preview !== "—") return preview;
  const kind = item.kind || item.type || item.workflow_type || item.event_type;
  if (kind) {
    const label = eventPreviewLabel(String(kind), language) || workflowLabel(String(kind), language);
    if (label && !/^[a-z0-9_]+$/i.test(label)) return label;
  }
  return localizedDate(item.occurred_at || item.updated_at || item.created_at, language);
}

function statusTone(status = "") {
  const normalized = status.toLowerCase();
  if (["completed", "confirmed", "verified", "active", "ready", "healthy"].includes(normalized)) return "complete";
  if (["failed", "error", "cancelled", "blocked"].includes(normalized)) return "danger";
  if (["manual_required", "unknown", "needs_login", "warning"].includes(normalized)) return "warning";
  if (["running", "queued", "submitted"].includes(normalized)) return "active";
  return "neutral";
}

function statusText(status: string | undefined, messages: Messages) {
  if (!status) return "—";
  return messages.statuses[status as keyof typeof messages.statuses] || status;
}

function operationText(value: string | undefined, messages: Messages) {
  const key = String(value || "");
  return (messages.operationLabels as Record<string, string>)[key] || workflowLabel(key, document.documentElement.lang === "zh-Hant" ? "zh-Hant" : "zh-Hans") || messages.platformAction;
}

function StatePage({ icon = "warning", title, description, action }: { icon?: "warning" | "signal"; title: string; description: string; action?: React.ReactNode }) {
  return <main id="crm-main" className="crm-state-page" tabIndex={-1}>
    <div className="crm-state-symbol"><Icon name={icon} /></div>
    <p className="crm-eyebrow">Vecto CRM</p>
    <h1>{title}</h1>
    <p>{description}</p>
    {action && <div className="crm-state-actions">{action}</div>}
  </main>;
}

function LoadingPage({ messages }: { messages: Messages }) {
  return <main id="crm-main" className="crm-state-page crm-loading-page" aria-busy="true" aria-live="polite">
    <div className="crm-loader" aria-hidden="true"><span /><span /><span /></div>
    <h1>{messages.loading}</h1>
    <p>{messages.loadingHint}</p>
  </main>;
}

function Metric({ label, value, note }: { label: string; value: unknown; note?: string }) {
  return <article className="crm-metric">
    <span>{label}</span>
    <strong>{displayValue(value)}</strong>
    {note && <small>{note}</small>}
  </article>;
}

function StatusBadge({ status, messages }: { status?: string; messages: Messages }) {
  return <span className={`crm-status crm-status--${statusTone(status)}`}><i aria-hidden="true" />{statusText(status, messages)}</span>;
}

function AccountHealthIcon({ tone }: { tone: "healthy" | "warning" | "danger" }) {
  if (tone === "healthy") return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16.5 9" /></svg>;
  if (tone === "warning") return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v4" /><path d="M12 16.5h.01" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6" /><path d="m15 9-6 6" /></svg>;
}

function AccountStatusChip({ account, messages }: { account: CrmAccount; messages: Messages }) {
  const needsLogin = accountNeedsTakeover(account);
  const raw = String(account.health_status || account.status || "").toLowerCase();
  const blocked = ["banned", "disabled", "blocked", "suspended", "risk_control", "abnormal"].includes(raw);
  const statusClass = needsLogin ? "pending_login" : blocked ? "abnormal" : "ready";
  const tone: "healthy" | "warning" | "danger" = needsLogin ? "warning" : blocked ? "danger" : "healthy";
  const label = needsLogin ? messages.loggedOut : blocked ? messages.statuses.banned : messages.statuses.alive;
  return <span className={`status ${statusClass}`} title={label}>
    <span className={`account-status-icon is-${tone}`} aria-hidden="true"><AccountHealthIcon tone={tone} /></span>
    <span className="account-status-label">{label}</span>
  </span>;
}

function SubpageStrip({ items, value, children }: { items: ViewId[]; value: ViewId; children: ReactNode }) {
  const index = Math.max(0, items.indexOf(value));
  const pages = Children.toArray(children);
  return <div className="crm-panel-clip">
    <div className="crm-panel-strip" style={{ transform: `translate3d(${-index * 100}%, 0, 0)` }}>
      {items.map((id, pageIndex) => <div className="crm-subpage" key={id} aria-hidden={id !== value} inert={id !== value ? true : undefined}>{pages[pageIndex]}</div>)}
    </div>
  </div>;
}

type NavigateOptions = { direction?: number; panel?: boolean };

function CompactTabs({ items, value, messages, navigate, label }: { items: ViewId[]; value: ViewId; messages: Messages; navigate: (view: ViewId, options?: NavigateOptions) => void; label: string }) {
  const group = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const pillReady = useRef(false);
  const select = (next: ViewId) => {
    if (next === value) return;
    const fromIndex = items.indexOf(value);
    const toIndex = items.indexOf(next);
    const direction = toIndex === fromIndex || fromIndex < 0 || toIndex < 0 ? 0 : toIndex > fromIndex ? 1 : -1;
    navigate(next, { direction, panel: true });
    window.requestAnimationFrame(() => document.getElementById(`crm-tab-${next}`)?.focus({ preventScroll: true }));
  };
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, current: ViewId) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = items.indexOf(current);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    select(items[nextIndex]);
  };
  useLayoutEffect(() => {
    applySegmentPill(group.current, pill.current, Math.max(0, items.indexOf(value)), !pillReady.current);
    pillReady.current = true;
  }, [items, value]);
  useEffect(() => {
    const sync = () => applySegmentPill(group.current, pill.current, Math.max(0, items.indexOf(value)), true);
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [items, value]);
  return <div ref={group} className="crm-compact-tabs" role="tablist" aria-label={label}>
    <span ref={pill} className="crm-compact-tabs-pill" aria-hidden="true" />
    {items.map((id) => <button id={`crm-tab-${id}`} type="button" role="tab" aria-selected={value === id} tabIndex={value === id ? 0 : -1} className={value === id ? "is-active" : ""} key={id} onKeyDown={(event) => move(event, id)} onClick={() => select(id)}>{messages.views[id][0]}</button>)}
  </div>;
}

function safeBrowserTarget(rawUrl: string) {
  const url = new URL(rawUrl, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error("crm.errors.browserSessionInvalid");
  return `${url.pathname}${url.search}${url.hash}`;
}

async function openLoginSession(accountId: string, language: Language) {
  const popup = window.open("about:blank", "_blank");
  if (popup) popup.opener = null;
  try {
    const result = await crmApi.openLogin(accountId);
    const immediate = result.live_browser_url || result.session_url;
    if (immediate) {
      const target = safeBrowserTarget(immediate);
      if (popup) popup.location.replace(target);
      else window.location.assign(target);
      return;
    }
    if (!result.task_id) throw new Error(operationCatalog[language].browserTimeout);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const detail = await crmApi.task(result.task_id);
      const steps = Array.isArray(detail.steps) ? detail.steps as Array<Record<string, unknown>> : [];
      const socialIds = new Set(steps.map((step) => String(step.social_task_id || "")).filter(Boolean));
      const sessions = (await crmApi.browserSessions()).sessions || [];
      const session = sessions.find((item) => socialIds.has(String(item.task_id || "")) && item.browser_ready !== false);
      const sessionId = String(session?.id || session?.session_id || "");
      if (sessionId) {
        const context = adminWorkspaceContext();
        const query = new URLSearchParams();
        if (context.isAdmin) query.set("admin_console", "1");
        if (context.workspaceId) query.set("admin_workspace_user_id", context.workspaceId);
        const target = `/api/persona_dashboard/automation/browser_sessions/${encodeURIComponent(sessionId)}/kasm/${query.size ? `?${query}` : ""}`;
        if (popup) popup.location.replace(target);
        else window.location.assign(target);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    }
    throw new Error(operationCatalog[language].browserTimeout);
  } catch (error) {
    popup?.close();
    throw error;
  }
}

const takeoverAccountStates = new Set(["pending_login", "needs_login", "need_verification", "cookie_expired", "expired", "abnormal"]);

function accountNeedsTakeover(account: CrmAccount) {
  return Boolean(account.needs_login) || takeoverAccountStates.has(String(account.status || "").toLowerCase()) || takeoverAccountStates.has(String(account.health_status || "").toLowerCase());
}

function accountIsReady(account: CrmAccount | undefined) {
  if (!account || accountNeedsTakeover(account)) return false;
  return String(account.status || "").toLowerCase() === "ready" && !["banned", "disabled"].includes(String(account.health_status || "").toLowerCase());
}

type AccountTrack = {
  accountId: string;
  kind: "open_login" | "account_check";
  taskId: string;
  status: string;
  phase: "queued" | "running" | "ready" | "done" | "failed";
  browserUrl?: string;
};

function accountTrackPhase(kind: AccountTrack["kind"], status: string, browserUrl?: string): AccountTrack["phase"] {
  if (["completed", "confirmed"].includes(status)) return "done";
  if (["failed", "cancelled", "unknown"].includes(status)) return "failed";
  if (kind === "open_login" && browserUrl) return "ready";
  if (status === "running" || status === "manual_required") return "running";
  return "queued";
}

function liveBrowserHref(sessionId: string) {
  const context = adminWorkspaceContext();
  const query = new URLSearchParams();
  if (context.isAdmin) query.set("admin_console", "1");
  if (context.workspaceId) query.set("admin_workspace_user_id", context.workspaceId);
  return `/api/persona_dashboard/automation/browser_sessions/${encodeURIComponent(sessionId)}/kasm/${query.size ? `?${query}` : ""}`;
}

async function waitForWorkflow(taskId: string, attempts = 90) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const task = await crmApi.task(taskId);
    const status = String(task.status || "");
    if (["completed", "failed", "cancelled", "manual_required", "unknown"].includes(status)) return task;
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  throw new Error("crm.errors.browserTimeout");
}

function taskDetailActions(detail: Record<string, unknown> | null): CrmAction[] {
  return detail && Array.isArray(detail.actions) ? detail.actions as CrmAction[] : [];
}

function taskDetailSteps(detail: Record<string, unknown> | null): CrmStep[] {
  return detail && Array.isArray(detail.steps) ? detail.steps as CrmStep[] : [];
}

function manualAccountId(detail: Record<string, unknown> | null) {
  for (const action of taskDetailActions(detail)) {
    if (action.account_id) return String(action.account_id);
  }
  for (const step of taskDetailSteps(detail)) {
    if (step.payload?.account_id) return String(step.payload.account_id);
  }
  const input = detail?.input as Record<string, unknown> | undefined;
  return String(input?.account_id || "");
}

function needsLoginTakeover(detail: Record<string, unknown> | null) {
  if (!detail) return false;
  const diagnostic = JSON.stringify({
    status: detail.status, reason: detail.manual_reason || detail.reason_code,
    actions: taskDetailActions(detail).map((item) => ({ type: item.action_type, error: item.error_code })),
    steps: taskDetailSteps(detail).map((item) => ({ type: item.step_type, error: item.error_code, status: item.status })),
  }).toLowerCase();
  return Boolean(detail.needs_login) || diagnostic.includes("needs_login") || diagnostic.includes("account_needs_login") || diagnostic.includes("open_login");
}

function TaskCard({ task, messages, language, onAction, onChanged }: { task: CrmTask; messages: Messages; language: Language; onAction: (task: CrmTask, action: "pause" | "resume" | "cancel" | "retry" | "confirm") => void; onChanged: () => void }) {
  const id = String(task.task_id || task.id || "");
  const status = String(task.status || "queued");
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [manualBusy, setManualBusy] = useState("");
  const [manualError, setManualError] = useState("");
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [followup, setFollowup] = useState<{ action: CrmAction; comment: string; sourceUrl: string; preflight?: Awaited<ReturnType<typeof crmApi.preflight>> } | null>(null);
  const [followupConfirmed, setFollowupConfirmed] = useState(false);
  const hasRealProgress = typeof task.progress === "number" || (typeof task.processed === "number" && typeof task.total === "number" && task.total > 0);
  const progress = typeof task.progress === "number" ? task.progress : task.total ? Math.round(((task.processed || 0) / task.total) * 100) : null;
  const loadDetail = async (showBusy = true) => {
    if (showBusy) setManualBusy("detail");
    setManualError("");
    try {
      const [taskDetail, evidencePayload] = await Promise.all([
        crmApi.task(id),
        crmApi.taskEvidence(id).catch(() => ({ items: [], evidence: [] })),
      ]);
      const evidenceItems = evidencePayload.items || evidencePayload.evidence || [];
      const evidenceByAction = new Map(evidenceItems.map((item) => [String(item.action_id || item.id || ""), item]));
      const taskActions = Array.isArray(taskDetail.actions) ? taskDetail.actions as Array<Record<string, unknown>> : [];
      const actions = taskActions.length
        ? taskActions.map((action) => {
          const evidenceRow = evidenceByAction.get(String(action.id || action.action_id || ""));
          return evidenceRow ? { ...action, state: evidenceRow.state || action.state, evidence: evidenceRow.evidence || action.evidence || {} } : action;
        })
        : evidenceItems.map((item) => ({ id: item.action_id || item.id, state: item.state, evidence: item.evidence || {} }));
      setDetail({ ...taskDetail, actions, evidence: evidenceItems });
      if (showBusy) setDetailOpen(true);
    } catch (error) {
      setManualError(localizedError(error, messages));
    } finally {
      if (showBusy) setManualBusy("");
    }
  };
  useEffect(() => {
    if (!detailOpen) return;
    const timer = window.setInterval(() => { void loadDetail(false); }, 5_000);
    return () => window.clearInterval(timer);
  }, [detailOpen, id]);
  const removeTask = async () => {
    if (!await requestConfirm({
      title: messages.deleteTitle,
      message: language === "zh-Hant" ? "確認刪除此終態任務？" : "确认删除这个终态任务？",
      confirmText: messages.ok,
      cancelText: messages.cancel,
      danger: true,
    })) return;
    setManualBusy("delete"); setManualError("");
    try { await crmApi.deleteTask(id, true); onChanged(); }
    catch (error) { setManualError(localizedError(error, messages)); }
    finally { setManualBusy(""); }
  };
  const prepareFollowupDraft = async (action: CrmAction) => {
    const actionId = String(action.id || action.action_id || ""); if (!actionId) return;
    setManualBusy(`followup:${actionId}`); setManualError("");
    try {
      const result = await crmApi.generateFollowupDraft({ taskId: id, itemId: actionId, mentionSourceAuthor: true, locale: language });
      const draft = (result.draft && typeof result.draft === "object" ? result.draft : {}) as Record<string, unknown>;
      setFollowup({ action, comment: String(draft.comment || ""), sourceUrl: String(draft.sourcePostUrl || action.target_key || action.payload?.target_url || "") });
      setFollowupConfirmed(false);
    } catch (error) { setManualError(localizedError(error, messages)); }
    finally { setManualBusy(""); }
  };
  const submitFollowup = async () => {
    if (!followup || followup.comment.trim().length < 2) return;
    const sourceActionId = String(followup.action.id || followup.action.action_id || "");
    const action = { action_type: "followup_reply", account_id: String(followup.action.account_id || ""), target_key: followup.sourceUrl, content: followup.comment.trim(), payload: { target_url: followup.sourceUrl, content: followup.comment.trim(), parent_workflow_id: id, source_action_id: sourceActionId, lead_id: followup.action.payload?.lead_id || "" } };
    setManualBusy("followup-submit"); setManualError("");
    try {
      if (!followup.preflight) { const preflight = await crmApi.preflight({ workflow_type: "followup", actions: [action] }); setFollowup({ ...followup, preflight }); setFollowupConfirmed(false); return; }
      if (!followupConfirmed) return;
      await crmApi.createWorkflow({ workflow_type: "followup", title: language === "zh-Hant" ? "針對性跟進回覆" : "针对性跟进回复", idempotency_key: `crm-followup:${sourceActionId}:${window.crypto.randomUUID()}`, input: { parent_workflow_id: id, source_action_id: sourceActionId }, actions: followup.preflight.actions?.length ? followup.preflight.actions : [action], preflight_token: followup.preflight.preflight_token, confirmed: true });
      setFollowup(null); setFollowupConfirmed(false); onChanged();
    } catch (error) { setManualError(localizedError(error, messages)); }
    finally { setManualBusy(""); }
  };
  const review = async (action: CrmAction, desired: "confirmed" | "failed") => {
    const actionId = String(action.id || action.action_id || "");
    if (!actionId) return;
    const reviewNote = String(reviewNotes[actionId] || "").trim();
    if (!reviewNote) return;
    if (desired === "failed" && !await requestConfirm({
      title: messages.confirmTitle,
      message: messages.reviewFailedConfirm,
      confirmText: messages.ok,
      cancelText: messages.cancel,
      danger: true,
    })) return;
    setManualBusy(actionId);
    setManualError("");
    try {
      await crmApi.reviewAction(id, actionId, desired, { ...(action.evidence || {}), manual_review_note: reviewNote, reviewed_from: "crm_spa" });
      setDetail(await crmApi.task(id));
      onChanged();
    } catch (error) {
      setManualError(localizedError(error, messages));
    } finally {
      setManualBusy("");
    }
  };
  const restoreAfterLogin = async () => {
    if (!accountId) return;
    setManualBusy("restore"); setManualError("");
    try {
      const verification = await crmApi.verifyAccount(accountId);
      const verified = await waitForWorkflow(verification.task_id);
      if (String(verified.status || "") !== "completed") throw new Error(String(verified.error_detail || verified.error_code || "crm.errors.accountNeedsLogin"));
      await crmApi.taskAction(id, "reconcile");
      setDetail(await crmApi.task(id));
      onChanged();
    } catch (error) { setManualError(localizedError(error, messages)); }
    finally { setManualBusy(""); }
  };
  const unknownActions = taskDetailActions(detail).filter((action) => action.state === "unknown");
  const detailActions = taskDetailActions(detail);
  const detailSteps = taskDetailSteps(detail);
  const accountId = manualAccountId(detail);
  const loginRequired = needsLoginTakeover(detail) && Boolean(accountId);
  return <article className="crm-task-card">
    <div className="crm-task-card-head">
      <div><strong>{taskTitle(task as Record<string, unknown>, messages.untitledTask, language)}</strong><small>{humanText(task.account_username, "") || localizedDate(task.updated_at || task.created_at, language)}</small></div>
      <StatusBadge status={status} messages={messages} />
    </div>
    {task.message && <p>{task.message}</p>}
    {hasRealProgress && progress !== null && <div className="crm-progress" role="progressbar" aria-label={messages.taskProgress} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, progress))}><span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} /></div>}
    <div className="crm-task-foot">
      <span>{task.account_username || localizedDate(task.updated_at || task.created_at, language) || messages.noSimulatedProgress}</span>
      <span className="crm-inline-actions">
        {status === "running" && <button type="button" onClick={() => onAction(task, "pause")}>{messages.pause}</button>}
        {status.startsWith("paused") && <button type="button" onClick={() => onAction(task, "resume")}>{messages.resume}</button>}
        {status === "failed" && <button type="button" onClick={() => onAction(task, "retry")}>{messages.retryAction}</button>}
        {status === "awaiting_confirmation" && <button type="button" onClick={() => onAction(task, "confirm")}>{messages.confirmTask}</button>}
        <button type="button" disabled={manualBusy === "detail"} aria-expanded={detailOpen} onClick={() => detailOpen ? setDetailOpen(false) : void loadDetail()}>{detailOpen ? messages.hideTaskDetails : messages.inspectTask}</button>
        {["awaiting_confirmation", "queued", "running", "manual_required", "paused_by_user", "paused_by_policy"].includes(status) && <button type="button" onClick={() => onAction(task, "cancel")}>{messages.cancel}</button>}
        {["completed", "failed", "cancelled"].includes(status) && <button type="button" disabled={manualBusy === "delete"} onClick={() => void removeTask()}>{language === "zh-Hant" ? "刪除" : "删除"}</button>}
      </span>
    </div>
    {manualError && <div className="crm-inline-error" role="alert"><Icon name="warning" />{manualError}</div>}
    {detailOpen && <div className="crm-manual-panel">
      <section className="crm-evidence-timeline" aria-labelledby={`crm-evidence-${id}`}>
        <h3 id={`crm-evidence-${id}`}>{messages.evidenceTimeline}</h3>
        {!detailSteps.length && !detailActions.length ? <p>{messages.noEvidence}</p> : <ol>
          {detailSteps.map((step, index) => <li key={String(step.id || step.social_task_id || index)}>
            <span className="crm-timeline-mark" aria-hidden="true" />
            <div><strong>{operationText(step.step_type, messages) || `${messages.taskStep} ${index + 1}`}</strong><small>{(messages.errors as Record<string, string>)[String(step.error_code || "")] || messages.noEvidence}</small></div>
            <StatusBadge status={String(step.status || "queued")} messages={messages} />
          </li>)}
          {detailActions.map((action, index) => <li key={String(action.id || action.action_id || index)}>
            <span className="crm-timeline-mark" aria-hidden="true" />
            <div><strong>{operationText(action.action_type, messages) || `${messages.platformAction} ${index + 1}`}</strong><small>{(action.evidence && Object.keys(action.evidence).length ? messages.evidenceAvailable : messages.noEvidence)}</small></div>
            <StatusBadge status={String(action.state || "planned")} messages={messages} />
          </li>)}
        </ol>}
      </section>
      {detailActions.filter((action) => action.state !== "unknown" && action.evidence && Object.keys(action.evidence).length > 0).map((action, index) => <section className="crm-evidence-card" key={`evidence-${String(action.id || action.action_id || index)}`}>
        <strong>{operationText(action.action_type, messages)}</strong>
        <span><StatusBadge status={action.state} messages={messages} /></span>
        <StructuredEvidence evidence={action.evidence || {}} language={language} />
        {action.state === "confirmed" && ["public_comment", "public_reply"].includes(String(action.action_type || "")) && <button className="crm-secondary-button" type="button" disabled={manualBusy === `followup:${String(action.id || action.action_id || "")}`} onClick={() => void prepareFollowupDraft(action)}>{language === "zh-Hant" ? "AI 針對性補充" : "AI 针对性补充"}</button>}
      </section>)}
      {loginRequired && <button className="crm-secondary-button" type="button" disabled={manualBusy === "login"} onClick={() => {
        setManualBusy("login");
        void openLoginSession(accountId, language).catch((error) => setManualError(localizedError(error, messages))).finally(() => setManualBusy(""));
      }}><Icon name="external" />{messages.openAccountLogin}</button>}
      {loginRequired && <button className="crm-primary-button" type="button" disabled={manualBusy === "restore"} onClick={() => void restoreAfterLogin()}><Icon name="refresh" />{manualBusy === "restore" ? messages.restoringTask : messages.restoreOriginalTask}</button>}
      {unknownActions.map((action) => {
        const actionId = String(action.id || action.action_id || "");
        const note = String(reviewNotes[actionId] || "");
        return <section className="crm-evidence-card" key={actionId}>
        <strong>{action.action_type || messages.unknown}</strong>
        <span><StatusBadge status={action.state} messages={messages} /></span>
        <small>{messages.evidence}</small>
        <StructuredEvidence evidence={action.evidence || {}} language={language} />
        <label className="crm-field"><span>{messages.reviewNote}</span><textarea rows={3} value={note} onChange={(event) => setReviewNotes((current) => ({ ...current, [actionId]: event.target.value }))} placeholder={messages.reviewNotePlaceholder} /></label>
        <div className="crm-inline-actions">
          <button type="button" disabled={!note.trim() || manualBusy === actionId} onClick={() => void review(action, "confirmed")}>{messages.confirmEvidence}</button>
          <button type="button" disabled={!note.trim() || manualBusy === actionId} onClick={() => void review(action, "failed")}>{messages.markFailed}</button>
        </div>
      </section>;})}
      {["manual_required", "unknown"].includes(status) && !loginRequired && !unknownActions.length && <p>{messages.noManualAction}</p>}
    </div>}
    {followup && <ConsoleModal title={language === "zh-Hant" ? "針對性跟進回覆" : "针对性跟进回复"} labelledBy={`crm-followup-${id}`} onClose={() => setFollowup(null)} actions={<><button type="button" onClick={() => setFollowup(null)}>{messages.cancel}</button><button type="button" className="primary" disabled={Boolean(manualBusy) || !followup.comment.trim() || Boolean(followup.preflight && !followupConfirmed)} onClick={() => void submitFollowup()}>{followup.preflight ? (language === "zh-Hant" ? "確認並建立" : "确认并创建") : (language === "zh-Hant" ? "執行預檢" : "执行预检")}</button></>}>
      <label className="crm-field"><span>{language === "zh-Hant" ? "可編輯草稿" : "可编辑草稿"}</span><textarea rows={6} value={followup.comment} onChange={(event) => { setFollowup({ ...followup, comment: event.target.value, preflight: undefined }); setFollowupConfirmed(false); }} /></label>
      {followup.preflight && <div className="crm-preflight-review"><dl><div><dt>{language === "zh-Hant" ? "可執行" : "可执行"}</dt><dd>{followup.preflight.allowed_count ?? followup.preflight.actions?.length ?? 0}</dd></div><div><dt>{language === "zh-Hant" ? "預計扣點" : "预计扣点"}</dt><dd>{followup.preflight.quote?.total_points ?? 0}</dd></div></dl><label className="crm-consent"><input type="checkbox" checked={followupConfirmed} onChange={(event) => setFollowupConfirmed(event.target.checked)} /><span>{language === "zh-Hant" ? "我已核對來源證據與補充內容" : "我已核对来源证据与补充内容"}</span></label></div>}
    </ConsoleModal>}
  </article>;
}

function EmptyState({ messages, view, actionLabel, onAction, filtered = false }: { messages: Messages; view: ViewId; actionLabel?: string; onAction?: () => void; filtered?: boolean }) {
  return <div className="crm-empty empty-state--rich">
    <Icon name={view} />
    <div>
      <strong>{filtered ? messages.noFilterResults : messages.empty}</strong>
      <span>{filtered ? messages.noFilterResultsHint : messages.emptyHints[view]}</span>
    </div>
    {actionLabel && onAction && <button className="crm-primary-button" type="button" onClick={onAction}>{actionLabel}</button>}
  </div>;
}

function isReachRecord(item: Record<string, unknown>, view: ViewId) {
  const type = String(item.event_type || item.kind || item.workflow_type || "").toLowerCase();
  const text = String(item.preview_text || item.content || item.message || "").toLowerCase();
  const hay = `${type} ${text}`;
  if (view === "public") {
    if (/pool|persona |business pools|deduplication|scope audited|tags updated|consolidated|task deleted|task_deleted/.test(hay)) return false;
    if (/(^| )collect( |$|_)/.test(hay) && !/public|comment|reply|outreach|message|engagement/.test(hay)) return false;
    return /public|outreach|comment|reply|direct_message|engagement|group|message|互动|留言|私信/.test(hay);
  }
  if (view === "outreach") return /outreach|direct_message|dm_|私信|message/.test(hay) || !type;
  return true;
}

function summaryFromDetail(detail: unknown, language: Language) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return "";
  const row = detail as Record<string, unknown>;
  const named = humanText(row.name || row.title || row.comment || row.content, "");
  if (named && named !== "—") return named;
  const labels: Array<[string, string]> = language === "zh-Hant"
    ? [["published", "已發佈"], ["submitted", "已提交"], ["processed", "已處理"], ["replied", "已回覆"], ["failed", "失敗"], ["remaining", "剩餘"], ["total", "總計"]]
    : [["published", "已发布"], ["submitted", "已提交"], ["processed", "已处理"], ["replied", "已回复"], ["failed", "失败"], ["remaining", "剩余"], ["total", "总计"]];
  return labels.filter(([key]) => row[key] !== undefined && row[key] !== null && Number.isFinite(Number(row[key]))).map(([key, label]) => `${label} ${Number(row[key])}`).slice(0, 6).join(" · ");
}

function inspectPayload(detail: Record<string, unknown>, language: Language = "zh-Hans") {
  const nested = [detail.payload, detail.input, detail.result, detail.evidence].filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const merged: Record<string, unknown> = { ...detail };
  for (const row of nested) Object.assign(merged, row);
  const deeper = [merged.detail, merged.evidence].filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  for (const row of deeper) {
    if (!merged.content) merged.content = row.content || row.comment || row.name || row.title || summaryFromDetail(row, language);
    if (!merged.username) merged.username = row.username || row.display_name;
  }
  if (typeof merged.detail === "string" && !merged.content) merged.content = merged.detail;
  if (!merged.content) merged.content = summaryFromDetail(merged.detail, language);
  return merged;
}

function inspectDetailRows(inspect: Record<string, unknown>, view: ViewId, messages: Messages, language: Language): Array<[string, string]> {
  const payload = inspectPayload(inspect, language);
  const kind = eventPreviewLabel(String(inspect.event_type || inspect.workflow_type || inspect.kind || inspect.type || ""), language) || itemTitle(inspect, messages.views[view][0], language);
  const target = humanText(payload.preview_user || payload.recipient || payload.recipient_username || payload.username || payload.display_name, "");
  const content = eventPreviewLabel(String(payload.preview_text || payload.content || payload.comment || payload.message || payload.instruction || payload.text || payload.source_text || ""), language)
    || humanText(payload.preview_text || payload.content || payload.comment || payload.message || payload.instruction || payload.text || payload.source_text, "");
  const result = summaryFromDetail(payload.detail, language) || summaryFromDetail(payload, language);
  const shown = new Set(["event_type", "workflow_type", "kind", "type", "status", "state", "preview_user", "preview_text", "content", "comment", "message", "instruction", "text", "source_text", "recipient", "recipient_username", "username", "display_name", "occurred_at", "updated_at", "created_at", "payload", "input", "result", "evidence", "detail", "steps", "actions"]);
  const rows: Array<[string, string]> = [
    [messages.views[view][0], kind],
    [messages.recordTarget, target],
    [messages.status, statusText(String(inspect.status || inspect.state || payload.status || ""), messages)],
    [messages.recordTime, localizedDate(inspect.occurred_at || inspect.updated_at || inspect.created_at, language)],
    [messages.recordContent, content && content !== "—" ? content : ""],
    [messages.recordResult, result && result !== content ? result : ""],
  ];
  for (const [key, value] of Object.entries(payload)) {
    if (shown.has(key) || isTechnicalKey(key) || /^(active|enabled|ok|schema_version)$/i.test(key)) continue;
    if (value && typeof value === "object") {
      const nested = summaryFromDetail(value as Record<string, unknown>, language);
      const nestedLabel = metricLabel(key, language);
      if (nested && !isOpaqueUserValue(nested) && !isEnglishMachineLabel(nestedLabel)) rows.push([nestedLabel, nested]);
      continue;
    }
    const text = eventPreviewLabel(String(value || ""), language) || humanText(value, "");
    const label = metricLabel(key, language);
    if (!text || text === "—" || isTechnicalId(text) || isOpaqueUserValue(text) || isEnglishMachineLabel(label) || isEnglishMachineLabel(text)) continue;
    rows.push([label, text]);
    shown.add(key);
  }
  return rows.filter(([, value]) => value && value !== "—");
}

function ResourceList({ view, messages, language, enabled, blockedHint, advisory, onCreate }: { view: ViewId; messages: Messages; language: Language; enabled: boolean; blockedHint: string; advisory?: string; onCreate: () => void }) {
  const resource = endpointByView[view];
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loadError, setLoadError] = useState<{ message: string; requestId: string; retryable: boolean } | null>(null);
  const [inspect, setInspect] = useState<Record<string, unknown> | null>(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const openInspect = async (item: Record<string, unknown>, index: number) => {
    const id = itemId(item, index);
    setInspect(item);
    setInspectBusy(true);
    try {
      const full = view === "outreach" || resource === "tasks"
        ? await crmApi.task(id)
        : await crmApi.resource(String(resource || view), id);
      setInspect({ ...item, ...full });
    } catch {
      setInspect(item);
    } finally {
      setInspectBusy(false);
    }
  };

  const load = useCallback(async (cursor = "") => {
    if (!resource) return;
    if (cursor) setLoadingMore(true);
    else setState("loading");
    setLoadError(null);
    try {
      const payload = await crmApi.list(resource, cursor);
      const incoming = payloadItems(payload);
      setItems((current) => mergeCursorPage(current, incoming, !cursor) as Array<Record<string, unknown>>);
      setNextCursor(String(payload.next_cursor || ""));
      setState("ready");
    } catch (error) {
      const apiError = error instanceof CrmApiError ? error : null;
      setLoadError({
        message: localizedError(error, messages),
        requestId: String(apiError?.body.request_id || ""),
        retryable: Boolean(apiError?.body.retryable),
      });
      setState(cursor ? "ready" : "error");
    } finally {
      setLoadingMore(false);
    }
  }, [messages, resource]);

  useEffect(() => { void load(""); }, [load]);

  const visibleItems = useMemo(() => items.filter((item) => isReachRecord(item, view)), [items, view]);
  useEffect(() => {
    if (state !== "ready" || loadingMore || !nextCursor || visibleItems.length >= 8 || items.length >= 400) return;
    void load(nextCursor);
  }, [state, loadingMore, nextCursor, visibleItems.length, items.length, load]);
  const statuses = useMemo(() => [...new Set(visibleItems.map((item) => String(item.status || item.state || "").trim()).filter(Boolean))].sort(), [visibleItems]);
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(language);
    return visibleItems.filter((item, index) => {
      const status = String(item.status || item.state || "").trim();
      if (statusFilter && status !== statusFilter) return false;
      if (!needle) return true;
      return `${itemTitle(item, `${messages.views[view][0]} ${index + 1}`, language)} ${itemMeta(item, language)}`.toLocaleLowerCase(language).includes(needle);
    });
  }, [visibleItems, language, messages.views, query, statusFilter, view]);
  const filtersActive = Boolean(query.trim() || statusFilter);
  const clearFilters = () => { setQuery(""); setStatusFilter(""); };

  return <section id={`crm-panel-${view}`} className="crm-panel crm-resource-panel" aria-busy={state === "loading"}>
    <div className="crm-panel-head">
      <div><span className="crm-kicker">{messages.workspace}</span><h2>{messages.views[view][0]}</h2></div>
      {writeViews.has(view) && enabled && <button className="crm-primary-button" type="button" onClick={onCreate}>{messages.create}</button>}
    </div>
    {!enabled && <div className="crm-inline-error" role="status"><Icon name="warning" /><span>{blockedHint}</span></div>}
    {enabled && advisory && <div className="crm-banner crm-banner--partial" role="status"><Icon name="warning" /><span>{advisory}</span></div>}
    {state === "loading" && <div className="crm-list-skeleton" aria-live="polite"><span>{messages.loadingData}</span><i /><i /><i /></div>}
    {state === "error" && <div className="crm-inline-error" role="alert"><Icon name="warning" /><span>{loadError?.message || messages.dataError}{loadError?.retryable && <small>{messages.retryableHint}</small>}</span><button type="button" onClick={() => void load()}><Icon name="refresh" />{messages.retry}</button></div>}
    {state === "ready" && loadError && <div className="crm-inline-error" role="alert"><Icon name="warning" /><span>{loadError.message}</span><button type="button" onClick={() => void load(nextCursor)}><Icon name="refresh" />{messages.retry}</button></div>}
    {state === "ready" && visibleItems.length > 0 && <div className="crm-filter-bar" role="search" aria-label={messages.filterRecords}>
      <label><span>{messages.search}</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={messages.searchPlaceholder} /></label>
      <label><span>{messages.status}</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">{messages.allStatuses}</option>{statuses.map((status) => <option key={status} value={status}>{statusText(status, messages)}</option>)}</select></label>
      {filtersActive && <button className="crm-secondary-button" type="button" onClick={clearFilters}>{messages.clearFilters}</button>}
    </div>}
    {state === "ready" && !visibleItems.length && <EmptyState messages={messages} view={view} actionLabel={writeViews.has(view) && enabled ? messages.create : undefined} onAction={writeViews.has(view) && enabled ? onCreate : undefined} />}
    {state === "ready" && visibleItems.length > 0 && !filteredItems.length && <EmptyState messages={messages} view={view} filtered actionLabel={messages.clearFilters} onAction={clearFilters} />}
    {state === "ready" && filteredItems.length > 0 && <>
      <MixBar parts={mixFromValues(filteredItems.map((item) => item.status || item.state), language)} />
      <div className="crm-record-list">
      {filteredItems.map((item, index) => {
        const status = String(item.status || item.state || "");
        const body = humanText(item.preview_text || item.content || item.message, "");
        return <article className="crm-record" key={itemId(item, index)}>
          <span className="crm-record-icon"><Icon name={view} /></span>
          <span className="crm-record-copy">
            <strong>{itemTitle(item, `${messages.views[view][0]} ${index + 1}`, language)}</strong>
            {body && body !== "—" ? <small className="crm-record-body">{eventPreviewLabel(body, language) || body}</small> : null}
            <small>{itemMeta(item, language) === body ? localizedDate(item.occurred_at || item.updated_at || item.created_at, language) : itemMeta(item, language)}</small>
          </span>
          {status && <StatusBadge status={status} messages={messages} />}
          <button className="crm-secondary-button" type="button" onClick={() => void openInspect(item, index)}>{messages.viewRecord}</button>
        </article>;
      })}
      </div>
    </>}
    {state === "ready" && nextCursor && visibleItems.length > 0 && <div className="crm-pagination"><button className="crm-secondary-button" type="button" disabled={loadingMore} onClick={() => void load(nextCursor)}>{loadingMore ? messages.loadingMore : messages.loadMore}</button></div>}
    {inspect && <ConsoleModal title={messages.recordDetail} labelledBy="crmRecordDetailTitle" onClose={() => setInspect(null)} actions={<button type="button" className="primary" onClick={() => setInspect(null)}>{messages.cancel}</button>}>
      {inspectBusy ? <p className="crm-quiet-empty">{messages.loadingData}</p> : <dl className="crm-record-detail">
        {(inspectDetailRows(inspect, view, messages, language).length ? inspectDetailRows(inspect, view, messages, language) : [[messages.recordContent, messages.noRecordBody] as [string, string]]).map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>}
    </ConsoleModal>}
  </section>;
}

function Overview({ bootstrap, tasks, messages, language }: { bootstrap: BootstrapPayload; tasks: CrmTask[]; messages: Messages; language: Language }) {
  const summary = bootstrap.summary || bootstrap.counts || {};
  const active = tasks.filter((task) => activeStatuses.has(String(task.status || "")));
  const manual = tasks.filter((task) => ["manual_required", "unknown"].includes(String(task.status || "")));
  const leadCount = Number(summary.leads ?? summary.lead_count ?? 0);
  const poolCount = Number(summary.pools ?? summary.pool_count ?? 0);
  const [analytics, setAnalytics] = useState<Record<string, unknown>>({});
  useEffect(() => { void crmApi.analytics().then(setAnalytics).catch(() => setAnalytics({})); }, []);
  const statusSource = Object.keys(analytics.workflow_statuses && typeof analytics.workflow_statuses === "object" ? analytics.workflow_statuses as object : {}).length
    ? Object.entries((analytics.workflow_statuses || {}) as Record<string, number>).map(([key, count]) => [key, Number(count) || 0] as [string, number])
    : Object.entries(tasks.reduce((counts, task) => {
      const status = String(task.status || "queued");
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {} as Record<string, number>));
  const taskMix = mixParts(statusSource, language);
  const funnelMix = mixParts(
    ["submitted", "confirmed", "delivered", "read", "replied", "engaged", "clicked", "failed"]
      .map((key) => [key, Number((analytics.funnel as Record<string, number> | undefined)?.[key] || 0)] as [string, number])
      .filter(([, count]) => count > 0),
    language,
  );
  const eventMix = groupEventMix(
    Object.entries((analytics.event_types || {}) as Record<string, number>).map(([key, count]) => [key, Number(count) || 0]),
    language,
  );
  const trend = dailyTrend(tasks as Array<Record<string, unknown>>);
  const trendSeries = [
    { key: "created", label: messages.chartCreated, color: chartColor(0, "complete"), values: trend.map((row) => row.created) },
    { key: "completed", label: messages.chartCompleted, color: chartColor(1, "active"), values: trend.map((row) => row.completed) },
    { key: "failed", label: messages.chartFailed, color: chartColor(4, "danger"), values: trend.map((row) => row.failed) },
  ];

  return <>
    <section className="crm-overview-hero">
      <div>
        <p className="crm-flow-kicker">{messages.flowKicker}</p>
        <h1>{messages.views.overview[0]}</h1>
        <p>{messages.flowHint}</p>
      </div>
    </section>
    <section className="crm-metrics" aria-label={messages.views.overview[0]}>
      <Metric label={messages.metrics.leads} value={leadCount} />
      <Metric label={messages.metrics.pools} value={poolCount} />
      <Metric label={messages.metrics.active} value={summary.active_tasks ?? active.length} />
      <Metric label={messages.metrics.manual} value={summary.manual_required ?? manual.length} />
    </section>
    <section className="crm-chart-grid" aria-label={messages.flowKicker}>
      <LineChart title={messages.chartTrend} hint={messages.chartTrendHint} labels={trend.map((row) => row.date)} series={trendSeries} empty={messages.chartEmpty} />
      <DonutChart title={messages.mixTasks} hint={messages.chartTasksHint} parts={taskMix} totalLabel={messages.chartTotal} empty={messages.chartEmpty} />
      <DonutChart title={messages.chartFunnel} hint={messages.chartFunnelHint} parts={funnelMix} totalLabel={messages.chartTotal} empty={messages.chartEmpty} />
      <BarChart title={messages.chartEvents} hint={messages.chartEventsHint} parts={eventMix} empty={messages.chartEmpty} />
    </section>
  </>;
}

function AccountsView({ accounts: seedAccounts, messages, language }: { accounts: CrmAccount[]; messages: Messages; language: Language }) {
  const [accounts, setAccounts] = useState<CrmAccount[]>(seedAccounts);
  const [platformFilter, setPlatformFilter] = useState<"threads" | "instagram">("threads");
  const [loading, setLoading] = useState(!seedAccounts.length);
  const [opening, setOpening] = useState("");
  const [verifying, setVerifying] = useState("");
  const [resetting, setResetting] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [track, setTrack] = useState<AccountTrack | null>(null);
  const visibleAccounts = accounts.filter((account) => normalizePlatform(account.platform) === platformFilter);
  const loadAccounts = useCallback(async () => {
    const payload = await crmApi.list("accounts");
    const next = payloadItems(payload) as CrmAccount[];
    setAccounts(next); setLoading(false);
    return next;
  }, []);
  useEffect(() => {
    let active = true;
    void crmApi.list("accounts").then((payload) => {
      if (!active) return;
      setAccounts(payloadItems(payload) as CrmAccount[]);
      setLoading(false);
    }).catch((nextError) => {
      if (!active) return;
      setError(localizedError(nextError, messages));
      setLoading(false);
    });
    return () => { active = false; };
  }, [messages.dataError]);
  useEffect(() => {
    if (!accounts.length) return;
    if (visibleAccounts.length) return;
    const fallback = normalizePlatform(accounts[0]?.platform) === "instagram" ? "instagram" : "threads";
    if (fallback !== platformFilter) setPlatformFilter(fallback);
  }, [accounts, platformFilter, visibleAccounts.length]);
  useEffect(() => {
    if (!track?.taskId) return;
    const taskId = track.taskId;
    const kind = track.kind;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const detail = await crmApi.task(taskId);
        if (cancelled) return;
        const status = String(detail.status || "queued");
        let foundUrl = "";
        if (kind === "open_login") {
          const steps = taskDetailSteps(detail);
          const socialIds = new Set(steps.map((step) => String(step.social_task_id || "")).filter(Boolean));
          const sessions = (await crmApi.browserSessions()).sessions || [];
          const session = sessions.find((item) => (socialIds.has(String(item.task_id || "")) || String(item.task_id || "") === taskId) && item.browser_ready !== false);
          const sessionId = String(session?.id || session?.session_id || "");
          if (sessionId) foundUrl = liveBrowserHref(sessionId);
        }
        setTrack((current) => {
          if (!current || current.taskId !== taskId) return current;
          const browserUrl = current.browserUrl || foundUrl;
          return { ...current, status, browserUrl, phase: accountTrackPhase(kind, status, browserUrl) };
        });
        if (["completed", "failed", "cancelled", "unknown"].includes(status)) {
          await loadAccounts();
          if (status === "completed") setNotice(messages.loginVerified);
          return;
        }
        timer = window.setTimeout(() => { void tick(); }, 1_000);
      } catch (nextError) {
        if (!cancelled) setError(localizedError(nextError, messages));
      }
    };
    timer = window.setTimeout(() => { void tick(); }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [track?.taskId, track?.kind, loadAccounts, messages]);
  const openLogin = async (account: CrmAccount) => {
    const id = String(account.id || "");
    if (!id) return;
    setOpening(id);
    setError(""); setNotice("");
    try {
      const result = await crmApi.openLogin(id);
      if (!result.task_id) throw new Error(operationCatalog[language].browserTimeout);
      setTrack({ accountId: id, kind: "open_login", taskId: result.task_id, status: "queued", phase: "queued" });
    } catch (nextError) {
      setError(localizedError(nextError, messages));
    } finally {
      setOpening("");
    }
  };
  const verifyLogin = async (account: CrmAccount) => {
    const id = String(account.id || ""); if (!id) return;
    setVerifying(id); setError(""); setNotice("");
    try {
      const result = await crmApi.verifyAccount(id);
      setTrack({ accountId: id, kind: "account_check", taskId: result.task_id, status: result.status || "queued", phase: "queued" });
    } catch (nextError) { setError(localizedError(nextError, messages)); }
    finally { setVerifying(""); }
  };
  const resetRotation = async (account: CrmAccount) => {
    const id = String(account.id || "");
    if (!id) return;
    const copy = language === "zh-Hant"
      ? "確認已完成人工關注或帳號處置，並重置此帳號的私訊輪換鎖定？"
      : "确认已完成人工关注或账号处置，并重置此账号的私信轮换锁定？";
    if (!await requestConfirm({
      title: messages.confirmTitle,
      message: copy,
      confirmText: messages.ok,
      cancelText: messages.cancel,
      danger: true,
    })) return;
    setResetting(id);
    try {
      await crmApi.resetRotation(id);
      await loadAccounts();
    } catch (nextError) {
      setError(localizedError(nextError, messages));
    } finally {
      setResetting("");
    }
  };
  return <section className="crm-panel">
    <div className="crm-panel-head"><div><span className="crm-kicker">{messages.accountHealth}</span><h2>{messages.views.accounts[0]}</h2></div></div>
    <div className="crm-account-platforms" role="tablist" aria-label={messages.platformFilter}>
      <button type="button" role="tab" aria-selected={platformFilter === "threads"} className={platformFilter === "threads" ? "is-active" : ""} data-account-platform="threads" onClick={() => setPlatformFilter("threads")}><PlatformLogo platform="threads" /><strong>Threads</strong></button>
      <button type="button" role="tab" aria-selected={platformFilter === "instagram"} className={platformFilter === "instagram" ? "is-active" : ""} data-account-platform="instagram" onClick={() => setPlatformFilter("instagram")}><PlatformLogo platform="instagram" /><strong>Instagram</strong></button>
    </div>
    {error && <div className="crm-inline-error" role="alert"><Icon name="warning" /><span>{error}</span><button type="button" onClick={() => { setError(""); setLoading(true); void loadAccounts().catch((nextError) => { setError(localizedError(nextError, messages)); setLoading(false); }); }}><Icon name="refresh" />{messages.retry}</button></div>}
    {loading ? <div className="crm-list-skeleton" aria-live="polite"><span>{messages.loadingData}</span><i /><i /></div> : !accounts.length ? <EmptyState messages={messages} view="accounts" /> : !visibleAccounts.length ? <p className="crm-quiet-empty">{messages.noPlatformAccounts}</p> : <div className="crm-account-grid">{visibleAccounts.map((account, index) => {
      const needsLogin = accountNeedsTakeover(account);
      const username = account.username || account.display_name || `${messages.accountFallback} ${index + 1}`;
      const platformName = platformLabel(account.platform) || messages.platformFallback;
      return <article className="crm-account-card" data-account-platform={String(account.platform || "").toLowerCase()} key={String(account.id || account.username || index)}>
        <div className="crm-account-card-main">
          <span className="crm-account-card-platform">
            <PlatformLogo platform={account.platform} />
            <span>{platformName}</span>
          </span>
          <strong title={username}>{username}</strong>
          <AccountStatusChip account={account} messages={messages} />
        </div>
        <div className="crm-account-card-actions">
          {needsLogin && <button className="crm-account-card-action crm-account-card-action--login" type="button" disabled={opening === String(account.id) || verifying === String(account.id) || track?.accountId === String(account.id)} onClick={() => void openLogin(account)}><Icon name="external" />{opening === String(account.id) ? messages.submitting : messages.openLogin}</button>}
          <button className="crm-account-card-action" type="button" disabled={verifying === String(account.id) || opening === String(account.id) || track?.accountId === String(account.id)} onClick={() => void verifyLogin(account)}><Icon name="refresh" />{verifying === String(account.id) ? messages.verifyingLogin : messages.verifyLogin}</button>
          {account.rotation?.locked && <button className="crm-account-card-action" type="button" disabled={resetting === String(account.id)} onClick={() => void resetRotation(account)}><Icon name="refresh" />{resetting === String(account.id) ? messages.submitting : (language === "zh-Hant" ? "重置私訊輪換" : "重置私信轮换")}</button>}
        </div>
        {track?.accountId === String(account.id) && <div className="crm-account-track" role="status">
          <strong>{track.kind === "open_login" ? messages.loginAssistant : messages.verifyAssistant}</strong>
          <small>{messages.accountTrack[track.phase]}</small>
          <div className={`crm-progress ${track.phase === "failed" ? "is-failed" : ""}`} role="progressbar" aria-label={messages.taskProgress}><span className={track.phase === "done" || track.phase === "failed" ? "is-settled" : "is-live"} /></div>
          <div className="crm-account-track-actions">
            {track.browserUrl && <a className="crm-account-card-action crm-account-card-action--login" href={track.browserUrl} target="_blank" rel="noopener noreferrer">{messages.openLiveView}</a>}
            <button className="crm-account-card-action" type="button" onClick={() => { window.location.hash = "tasks"; }}>{messages.viewLoginTask}</button>
            {(track.phase === "done" || track.phase === "failed") && <button className="crm-account-card-action" type="button" onClick={() => setTrack(null)}>{messages.cancel}</button>}
          </div>
        </div>}
      </article>;
    })}</div>}
    {notice && <div className="crm-success-note" role="status"><Icon name="check" />{notice}</div>}
  </section>;
}

function TasksView({ tasks, pollError, messages, language, onAction, onChanged, hasMore, loadingMore, onLoadMore }: { tasks: CrmTask[]; pollError: boolean; messages: Messages; language: Language; onAction: (task: CrmTask, action: "pause" | "resume" | "cancel" | "retry" | "confirm") => void; onChanged: () => void; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void }) {
  return <section className="crm-panel">
    <div className="crm-panel-head"><div><span className="crm-kicker">{messages.liveOrchestration}</span><h2>{messages.views.tasks[0]}</h2><p>{messages.noSimulatedProgress}</p></div><span className={`crm-live-indicator ${pollError ? "is-offline" : ""}`}><i />{pollError ? messages.partial : messages.live}</span></div>
    {!tasks.length ? <EmptyState messages={messages} view="tasks" /> : <div className="crm-task-list">{tasks.map((task, index) => <TaskCard task={task} messages={messages} language={language} onAction={onAction} onChanged={onChanged} key={String(task.task_id || task.id || index)} />)}</div>}
    {hasMore && <div className="crm-pagination"><button className="crm-secondary-button" type="button" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? messages.loadingMore : messages.loadMore}</button></div>}
  </section>;
}

function WorkflowDialog({ view, messages, language, onClose, onCreated }: { view: ViewId | null; messages: Messages; language: Language; onClose: () => void; onCreated: (taskId: string) => void }) {
  const dialog = useRef<HTMLElement>(null);
  const idempotencyKey = useRef("");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [instruction, setInstruction] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [accounts, setAccounts] = useState<CrmAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [target, setTarget] = useState("");
  const labels = operationCatalog[language];
  useEffect(() => {
    if (!view) return;
    idempotencyKey.current = `crm-ui:${view}:${window.crypto.randomUUID()}`;
    void crmApi.list("accounts").then((payload) => {
      const next = payloadItems(payload) as CrmAccount[];
      const supported = view === "groups"
        ? next.filter((item) => String(item.platform || "").toLowerCase() === "threads")
        : view === "relationships"
          ? next.filter((item) => String(item.platform || "").toLowerCase() === "instagram")
          : next;
      setAccounts(supported);
      setAccountId(String(supported[0]?.id || ""));
    }).catch(() => setAccounts([]));
  }, [view]);
  useEffect(() => {
    if (!view) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.querySelector<HTMLElement>("select, input, textarea")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
      if (event.key !== "Tab" || !node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [view]);
  if (!view) return null;
  const submit = async () => {
    const workflowAction = view ? workflowActionByView[view] : undefined;
    if (!workflowAction) {
      setError(operationCatalog[language].blockedHint);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const { actionType, write, sku = "" } = workflowAction;
      if (view === "relationships") {
        const leadIds = target.split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean);
        const result = await crmApi.verifyRelationships({
          account_id: accountId,
          lead_ids: leadIds,
          idempotency_key: idempotencyKey.current,
        });
        onCreated(result.task_id);
        onClose();
        return;
      }
      const proposedActions = [{
        action_type: actionType,
        account_id: accountId,
        target_key: target.trim(),
        content: instruction.trim(),
        write,
        ...(sku ? { sku, quantity: 1 } : {}),
        payload: { target_url: target.trim(), content: instruction.trim() },
      }];
      const preflight = write
        ? await crmApi.preflight({ workflow_type: view, actions: proposedActions })
        : null;
      const result = await crmApi.createWorkflow({
        workflow_type: view,
        title: messages.views[view][0],
        idempotency_key: idempotencyKey.current,
        input: { instruction: instruction.trim(), account_id: accountId, target: target.trim() },
        actions: preflight?.actions?.length ? preflight.actions : proposedActions,
        ...(preflight ? { preflight_token: preflight.preflight_token } : {}),
        confirmed: consent,
      });
      onCreated(result.task_id);
      onClose();
    } catch (nextError) {
      setError(localizedError(nextError, messages));
    } finally {
      setSubmitting(false);
    }
  };
  return <ConsoleModal title={messages.workflowTitle} labelledBy="crmWorkflowTitle" onClose={onClose} dialogRef={dialog} actions={<><button type="button" onClick={onClose}>{messages.cancel}</button><button type="button" className="primary" disabled={(view !== "relationships" && !instruction.trim()) || !target.trim() || !accountId || (Boolean(workflowActionByView[view]?.write) && !consent) || submitting} onClick={() => void submit()}>{submitting ? messages.submitting : messages.confirm}</button></>}>
      <label className="crm-field"><span>{labels.account}</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">{labels.selectAccount}</option>{accounts.map((account) => <option key={String(account.id)} value={String(account.id)}>{account.display_name || account.username} · {account.platform}</option>)}</select></label>
      <label className="crm-field"><span>{labels.target}</span><input value={target} onChange={(event) => setTarget(event.target.value)} placeholder={labels.targetPlaceholder} /></label>
      {view !== "relationships" && <label className="crm-field"><span>{messages.workflowInstruction}</span><textarea rows={5} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={messages.workflowPlaceholder} /></label>}
      <section className="crm-confirmation-summary" aria-labelledby="crmConfirmationTitle">
        <h3 id="crmConfirmationTitle">{messages.confirmationSummary}</h3>
        <dl>
          <div><dt>{messages.summaryAction}</dt><dd>{messages.views[view][0]}</dd></div>
          <div><dt>{messages.summaryAccount}</dt><dd>{accounts.find((account) => String(account.id) === accountId)?.display_name || accounts.find((account) => String(account.id) === accountId)?.username || messages.notSelected}</dd></div>
          <div><dt>{messages.summaryTarget}</dt><dd>{target.trim() || messages.notSelected}</dd></div>
          <div><dt>{messages.summaryBilling}</dt><dd>{workflowActionByView[view]?.write ? messages.billingServerValidated : messages.readActionFree}</dd></div>
        </dl>
      </section>
      {workflowActionByView[view]?.write && <label className="crm-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>{messages.workflowConsent}</span></label>}
      {error && <div className="crm-inline-error" role="alert"><Icon name="warning" />{error}</div>}
    </ConsoleModal>;
}

export function App() {
  const [language, setLanguage] = useState<Language>(readLanguage());
  const messages = catalog[language];
  const [view, setView] = useState<ViewId>(hashView());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isCompact, setIsCompact] = useState(() => window.matchMedia("(max-width: 980px)").matches);
  const sidebar = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const dockPillRef = useRef<HTMLSpanElement>(null);
  const dockPillReady = useRef(false);
  const pageSlide = useRef({ direction: 0, panel: false });
  const viewStage = useRef<HTMLDivElement>(null);
  const drawerWasOpen = useRef(false);
  const [bootstrapState, setBootstrapState] = useState<"loading" | "ready" | "forbidden" | "maintenance" | "error">("loading");
  const [bootstrap, setBootstrap] = useState<BootstrapPayload>({});
  const [workflowView, setWorkflowView] = useState<WizardView | null>(null);
  const [toast, setToast] = useState("");

  const loadBootstrap = useCallback(async () => {
    setBootstrapState("loading");
    try {
      const [payload, account] = await Promise.all([
        crmApi.bootstrap(),
        crmApi.me().catch(() => null),
      ]);
      setBootstrap(payload);
      const reasons = payload.module?.reasons || [];
      const maintenance = payload.module?.maintenance || payload.module?.settings?.maintenance || reasons.includes("maintenance");
      if (maintenance) setBootstrapState("maintenance");
      else if (payload.module?.effective === false) setBootstrapState("forbidden");
      else setBootstrapState("ready");
      const sessionAccount = account || payload.account || payload.user;
      if (sessionAccount) window.VectoSiteNavigation?.setAccount?.(sessionAccount);
    } catch (error) {
      if (error instanceof CrmApiError && error.status === 403) setBootstrapState("forbidden");
      else if (error instanceof CrmApiError && [423, 503].includes(error.status) && error.body.code?.includes("maintenance")) setBootstrapState("maintenance");
      else setBootstrapState("error");
    }
  }, []);
  const handlePolicyFailure = useCallback(() => { void loadBootstrap(); }, [loadBootstrap]);
  const { tasks, pollError, refresh: refreshTasks, loadMore: loadMoreTasks, hasMore: hasMoreTasks, loadingMore: loadingMoreTasks } = useTaskPolling(bootstrap.tasks, handlePolicyFailure, bootstrapState === "ready");
  const closeWorkflow = useCallback(() => setWorkflowView(null), []);

  useEffect(() => { void loadBootstrap(); }, [loadBootstrap]);
  useEffect(() => {
    const onHash = () => setView(hashView());
    const onLanguage = (event: Event) => setLanguage((event as CustomEvent<{ language?: Language }>).detail?.language === "zh-Hant" ? "zh-Hant" : "zh-Hans");
    const onReady = () => {
      setLanguage(window.VectoSiteNavigation?.currentLanguage?.() || readLanguage());
      const account = bootstrap.account || bootstrap.user;
      if (account) window.VectoSiteNavigation?.setAccount?.(account);
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("vecto:language-change", onLanguage);
    window.addEventListener("vecto:navigation-ready", onReady);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("vecto:language-change", onLanguage);
      window.removeEventListener("vecto:navigation-ready", onReady);
    };
  }, [bootstrap.account, bootstrap.user]);

  useEffect(() => {
    document.body.classList.toggle("crm-drawer-open", drawerOpen);
    return () => document.body.classList.remove("crm-drawer-open");
  }, [drawerOpen]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 980px)");
    const syncCompact = () => setIsCompact(media.matches);
    media.addEventListener("change", syncCompact);
    return () => media.removeEventListener("change", syncCompact);
  }, []);

  useEffect(() => {
    if (!isCompact) return;
    if (drawerOpen) {
      drawerWasOpen.current = true;
      sidebar.current?.querySelector<HTMLElement>(".crm-sidebar-close")?.focus();
      const onEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape") setDrawerOpen(false);
        if (event.key !== "Tab") return;
        const node = sidebar.current;
        const focusable = node ? [...node.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')] : [];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      };
      document.addEventListener("keydown", onEscape);
      return () => document.removeEventListener("keydown", onEscape);
    }
    if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      document.getElementById("crm-main")?.focus({ preventScroll: true });
    }
  }, [drawerOpen, isCompact]);

  const navigate = (next: ViewId, options?: NavigateOptions) => {
    window.location.hash = next;
    pageSlide.current = { direction: options?.direction || 0, panel: Boolean(options?.panel) };
    setView(next);
    setDrawerOpen(false);
    clearPageScrollLock();
    window.scrollTo(0, 0);
  };

  useLayoutEffect(() => {
    clearPageScrollLock();
    window.scrollTo(0, 0);
  }, [view]);
  useLayoutEffect(() => {
    if (bootstrapState !== "ready") return;
    const index = Math.max(0, navViews.indexOf(navViewOf(view)));
    applyDockPill(dockRef.current, dockPillRef.current, index, !dockPillReady.current);
    dockPillReady.current = true;
  }, [view, bootstrapState]);

  useEffect(() => {
    if (bootstrapState !== "ready") return;
    const sync = () => applyDockPill(dockRef.current, dockPillRef.current, Math.max(0, navViews.indexOf(navViewOf(view))), true);
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [view, bootstrapState]);

  const goDock = (id: NavViewId, button: HTMLButtonElement) => {
    const next: ViewId = id === "settings" ? "accounts" : id;
    if (navViewOf(next) === navViewOf(view)) {
      window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
      return;
    }
    const from = navViews.indexOf(navViewOf(view));
    const to = navViews.indexOf(id);
    navigate(next, { direction: to === from ? 0 : to > from ? 1 : -1 });
  };

  const partial = Boolean(bootstrap.warnings?.length || pollError);
  const viewEnabled = (candidate: ViewId) => {
    const capability = capabilityByView[candidate];
    return !capability || bootstrap.capabilities?.[capability]?.enabled === true;
  };
  const viewAdvisory = (candidate: ViewId) => {
    const labels = operationCatalog[language];
    if (candidate === "collect" && bootstrap.capabilities?.opc_history_live_query?.enabled === false) return labels.collectLimited;
    if (candidate === "public" && bootstrap.capabilities?.ai_demand_analysis?.enabled === false) return labels.publicLimited;
    if (candidate === "groups" && bootstrap.capabilities?.instagram_group_management?.enabled === false) return labels.groupsLimited;
    return "";
  };

  const taskAction = async (task: CrmTask, action: "pause" | "resume" | "cancel" | "retry" | "confirm") => {
    const id = String(task.task_id || task.id || "");
    if (!id) return;
    if (action === "cancel" && !await requestConfirm({
      title: messages.confirmTitle,
      message: messages.cancelTaskConfirm,
      confirmText: messages.ok,
      cancelText: messages.cancel,
      danger: true,
    })) return;
    if (action === "confirm" && !await requestConfirm({
      title: messages.confirmTask,
      message: messages.confirmTaskConfirm,
      confirmText: messages.ok,
      cancelText: messages.cancel,
    })) return;
    try {
      await crmApi.taskAction(id, action);
      await refreshTasks();
    } catch (error) {
      setToast(localizedError(error, messages));
    }
  };

  if (bootstrapState === "loading") return <LoadingPage messages={messages} />;
  if (bootstrapState === "forbidden") return <StatePage title={messages.forbidden} description={messages.forbiddenHint} action={<a className="crm-secondary-button" href="/console.html">{messages.console}</a>} />;
  if (bootstrapState === "maintenance") return <StatePage icon="signal" title={messages.maintenance} description={bootstrap.module?.message || messages.maintenanceHint} action={<button className="crm-primary-button" type="button" onClick={() => void loadBootstrap()}>{messages.retry}</button>} />;
  if (bootstrapState === "error") return <StatePage title={messages.unavailable} description={messages.loadingHint} action={<button className="crm-primary-button" type="button" onClick={() => void loadBootstrap()}><Icon name="refresh" />{messages.retry}</button>} />;

  const activeNav = navViewOf(view);
  const startWorkflow = (next: ViewId) => {
    if (viewEnabled(next) && ["collect", "public", "outreach", "groups", "relationships"].includes(next)) setWorkflowView(next as WizardView);
  };

  return <div className="crm-app">
    <div className={`crm-sidebar-backdrop ${drawerOpen ? "is-open" : ""}`} aria-hidden={!drawerOpen} onClick={() => setDrawerOpen(false)} />
    <aside ref={sidebar} id="crmSidebar" className={`crm-sidebar ${drawerOpen ? "is-open" : ""}`} aria-label={messages.product} aria-hidden={isCompact && !drawerOpen ? "true" : undefined} inert={isCompact && !drawerOpen ? true : undefined}>
      <div className="crm-sidebar-head"><div className="crm-monogram">CRM</div><strong>{messages.productShort}</strong><button className="crm-icon-button crm-sidebar-close" type="button" onClick={() => setDrawerOpen(false)} aria-label={messages.closeNav}><Icon name="close" /></button></div>
      <nav className="crm-nav">
        {navViews.map((id) => <button type="button" key={id} className={activeNav === id ? "is-active" : ""} aria-current={activeNav === id ? "page" : undefined} onClick={() => navigate(id === "settings" ? "accounts" : id)}><Icon name={id} /><span>{messages.navItems[id]}</span></button>)}
      </nav>
    </aside>
    <main ref={mainRef} id="crm-main" className="crm-main" tabIndex={-1}>
      <div ref={viewStage} className="crm-view">
      {bootstrap.workspace?.managed_by_admin && <div className="crm-banner crm-banner--workspace" role="status"><Icon name="accounts" /><span><strong>{messages.managedWorkspace}</strong>{messages.managedWorkspaceDetail(bootstrap.workspace.username || String(bootstrap.workspace.user_id || "—"), bootstrap.workspace.user_id)}</span><a className="crm-secondary-button" href="/admin.html">{messages.exitWorkspace}</a></div>}
      {partial && <div className="crm-banner crm-banner--partial" role="status"><Icon name="warning" /><span>{messages.partial}</span><button type="button" onClick={() => { void loadBootstrap(); void refreshTasks(); }}><Icon name="refresh" />{messages.retry}</button></div>}
      {bootstrap.module?.degraded && <div className="crm-banner crm-banner--degraded" role="alert"><Icon name="signal" /><span><strong>{messages.degraded}</strong>{messages.degradedHint}</span></div>}
      <div className="crm-nav-clip">
        <div className="crm-nav-strip" style={{ transform: `translate3d(${-Math.max(0, navViews.indexOf(activeNav)) * 100}%, 0, 0)` }}>
          <div className="crm-nav-page" aria-hidden={activeNav !== "overview"} inert={activeNav !== "overview" ? true : undefined}>
            <Overview bootstrap={bootstrap} tasks={tasks} messages={messages} language={language} />
          </div>
          <div className="crm-nav-page" aria-hidden={activeNav !== "collect"} inert={activeNav !== "collect" ? true : undefined}>
            <div className="crm-module-toolbar">
              <h2>{messages.views.collect[0]}</h2>
            </div>
            {!viewEnabled("collect") && <div className="crm-inline-error" role="status"><Icon name="warning" /><span>{`${operationCatalog[language].blocked}。${operationCatalog[language].blockedHint}`}</span></div>}
            {viewAdvisory("collect") && <div className="crm-banner crm-banner--partial" role="status"><Icon name="warning" /><span>{viewAdvisory("collect")}</span></div>}
            <PoolsView language={language} onCreate={viewEnabled("collect") ? () => startWorkflow("collect") : undefined} />
          </div>
          <div className="crm-nav-page" aria-hidden={activeNav !== "public"} inert={activeNav !== "public" ? true : undefined}>
            <CompactTabs items={engageTabs} value={engageTabs.includes(view) ? view : "public"} messages={messages} navigate={navigate} label={messages.navItems.public} />
            <SubpageStrip items={engageTabs} value={engageTabs.includes(view) ? view : "public"}>
              <ResourceList view="public" messages={messages} language={language} enabled={viewEnabled("public")} blockedHint={`${operationCatalog[language].blocked}。${operationCatalog[language].blockedHint}`} advisory={viewAdvisory("public")} onCreate={() => startWorkflow("public")} />
              <ResourceList view="outreach" messages={messages} language={language} enabled={viewEnabled("outreach")} blockedHint={`${operationCatalog[language].blocked}。${operationCatalog[language].blockedHint}`} advisory={viewAdvisory("outreach")} onCreate={() => startWorkflow("outreach")} />
              <GroupsView language={language} instagramEnabled={bootstrap.capabilities?.instagram_group_management?.enabled === true} advisory={viewAdvisory("groups")} onCreate={() => setWorkflowView("groups")} />
            </SubpageStrip>
          </div>
          <div className="crm-nav-page" aria-hidden={activeNav !== "tasks"} inert={activeNav !== "tasks" ? true : undefined}>
            <CompactTabs items={taskTabs} value={view === "schedules" ? "schedules" : "tasks"} messages={messages} navigate={navigate} label={messages.views.tasks[0]} />
            <SubpageStrip items={taskTabs} value={view === "schedules" ? "schedules" : "tasks"}>
              <>
                <TasksView tasks={tasks} pollError={pollError} messages={messages} language={language} onAction={(task, action) => void taskAction(task, action)} onChanged={() => void refreshTasks()} hasMore={hasMoreTasks} loadingMore={loadingMoreTasks} onLoadMore={() => void loadMoreTasks()} />
                <details className="crm-analytics-fold"><summary>{language === "zh-Hant" ? "營運分析" : "运营分析"}</summary><AnalyticsView language={language} /></details>
              </>
              <SchedulesView language={language} onCreate={(workflow) => setWorkflowView(workflow)} />
            </SubpageStrip>
          </div>
          <div className="crm-nav-page" aria-hidden={activeNav !== "settings"} inert={activeNav !== "settings" ? true : undefined}>
            <CompactTabs items={settingTabs} value={settingTabs.includes(view) ? view : "accounts"} messages={messages} navigate={navigate} label={messages.views.settings[0]} />
            <SubpageStrip items={settingTabs} value={settingTabs.includes(view) ? view : "accounts"}>
              <AccountsView accounts={bootstrap.accounts || []} messages={messages} language={language} />
              <TemplatesView language={language} />
              <DestinationsView language={language} />
              <ResourceList view="relationships" messages={messages} language={language} enabled={viewEnabled("relationships")} blockedHint={`${operationCatalog[language].blocked}。${operationCatalog[language].blockedHint}`} advisory={viewAdvisory("relationships")} onCreate={() => startWorkflow("relationships")} />
            </SubpageStrip>
          </div>
        </div>
      </div>
      </div>
    </main>
    <WorkflowWizard view={workflowView} messages={messages} language={language} capabilities={bootstrap.capabilities} onClose={closeWorkflow} onCreated={() => { setToast(messages.submitted); void refreshTasks(); }} />
    <ConfirmHost titleLabel={messages.confirmTitle} okLabel={messages.ok} cancelLabel={messages.cancel} />
    {toast && <div className="crm-toast" role="status">{toast}</div>}
    <nav ref={dockRef} className="crm-mobile-dock" aria-label={messages.product} style={{ ["--crm-mobile-dock-item-count" as string]: String(navViews.length) }}>
      <span className="crm-mobile-dock-track" aria-hidden="true"><span ref={dockPillRef} className="crm-mobile-dock-pill" /></span>
      <div className="crm-mobile-dock-items">
        {navViews.map((id) => <button type="button" key={id} className={activeNav === id ? "is-active" : ""} aria-current={activeNav === id ? "page" : undefined} onClick={(event) => goDock(id, event.currentTarget)}><Icon name={id} /><span>{messages.navItems[id]}</span></button>)}
      </div>
    </nav>
  </div>;
}
