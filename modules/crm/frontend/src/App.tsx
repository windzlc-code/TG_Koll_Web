import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CrmApiError, adminWorkspaceContext, crmApi, payloadItems } from "./api";
import { catalog, localizedError, operationCatalog, readLanguage, type Messages } from "./i18n";
import { Icon } from "./icons";
import { PlatformChip, PlatformLogo, platformLabel } from "./platform";
import { AnalyticsView, DestinationsView, GroupsView, MixBar, PoolsView, SchedulesView, StructuredEvidence, TemplatesView } from "./BusinessViews";
import { humanText, mixFromValues, mixParts, taskTitle, workflowLabel } from "./present";
import { useTaskPolling } from "./useTaskPolling";
import { WorkflowWizard, type WizardView } from "./WorkflowWizard";
import { mergeCursorPage } from "./runtime-helpers.js";
import { animatePageSlide, applyDockPill, navigationDirection, prefersReducedMotion, useSegmentSlide } from "./segment-motion";
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
  const descriptive = item.description || item.summary || item.platform;
  if (descriptive) return humanText(descriptive);
  const kind = item.kind || item.type || item.workflow_type;
  if (kind) return workflowLabel(String(kind), language);
  return localizedDate(item.updated_at || item.created_at, language);
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

function CompactTabs({ items, value, messages, navigate, label }: { items: ViewId[]; value: ViewId; messages: Messages; navigate: (view: ViewId, options?: { direction?: number }) => void; label: string }) {
  const group = useRef<HTMLDivElement>(null);
  const segment = useSegmentSlide();
  const select = (next: ViewId, button?: HTMLButtonElement | null) => {
    if (next === value) return;
    const node = group.current;
    const current = node?.querySelector<HTMLButtonElement>("button.is-active, button[aria-selected='true']");
    const target = button || node?.querySelector<HTMLButtonElement>(`#crm-tab-${next}`);
    const buttons = node ? [...node.querySelectorAll<HTMLButtonElement>("button")] : [];
    const direction = navigationDirection(buttons, current || null, target || null);
    segment.start(node, current || null, target || null, () => {
      navigate(next, { direction });
      window.requestAnimationFrame(() => document.getElementById(`crm-tab-${next}`)?.focus());
    });
  };
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, current: ViewId) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = items.indexOf(current);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    select(items[nextIndex], event.currentTarget);
  };
  return <div ref={group} className={segment.groupClass("crm-compact-tabs")} style={segment.groupStyle()} role="tablist" aria-label={label}>
    {items.map((id, index) => <button id={`crm-tab-${id}`} type="button" role="tab" aria-selected={value === id} tabIndex={value === id ? 0 : -1} className={segment.buttonClass(index, value === id)} key={id} onKeyDown={(event) => move(event, id)} onClick={(event) => select(id, event.currentTarget)}>{messages.views[id][0]}</button>)}
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
    if (!window.confirm(language === "zh-Hant" ? "確認刪除此終態任務？" : "确认删除这个终态任务？")) return;
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
    if (desired === "failed" && !window.confirm(messages.reviewFailedConfirm)) return;
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
    {followup && <div className="crm-editor-sheet" role="dialog" aria-modal="true" aria-labelledby={`crm-followup-${id}`}><div className="crm-editor-head"><h3 id={`crm-followup-${id}`}>{language === "zh-Hant" ? "針對性跟進回覆" : "针对性跟进回复"}</h3><button className="crm-icon-button" type="button" aria-label={messages.cancel} onClick={() => setFollowup(null)}><Icon name="close" /></button></div><label className="crm-field"><span>{language === "zh-Hant" ? "可編輯草稿" : "可编辑草稿"}</span><textarea rows={6} value={followup.comment} onChange={(event) => { setFollowup({ ...followup, comment: event.target.value, preflight: undefined }); setFollowupConfirmed(false); }} /></label>{followup.preflight && <div className="crm-preflight-review"><dl><div><dt>{language === "zh-Hant" ? "可執行" : "可执行"}</dt><dd>{followup.preflight.allowed_count ?? followup.preflight.actions?.length ?? 0}</dd></div><div><dt>{language === "zh-Hant" ? "預計扣點" : "预计扣点"}</dt><dd>{followup.preflight.quote?.total_points ?? 0}</dd></div></dl><label className="crm-consent"><input type="checkbox" checked={followupConfirmed} onChange={(event) => setFollowupConfirmed(event.target.checked)} /><span>{language === "zh-Hant" ? "我已核對來源證據與補充內容" : "我已核对来源证据与补充内容"}</span></label></div>}<div className="crm-modal-actions"><button className="crm-secondary-button" type="button" onClick={() => setFollowup(null)}>{messages.cancel}</button><button className="crm-primary-button" type="button" disabled={Boolean(manualBusy) || !followup.comment.trim() || Boolean(followup.preflight && !followupConfirmed)} onClick={() => void submitFollowup()}>{followup.preflight ? (language === "zh-Hant" ? "確認並建立" : "确认并创建") : (language === "zh-Hant" ? "執行預檢" : "执行预检")}</button></div></div>}
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

function ResourceList({ view, messages, language, enabled, blockedHint, advisory, onCreate }: { view: ViewId; messages: Messages; language: Language; enabled: boolean; blockedHint: string; advisory?: string; onCreate: () => void }) {
  const resource = endpointByView[view];
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loadError, setLoadError] = useState<{ message: string; requestId: string; retryable: boolean } | null>(null);

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

  const statuses = useMemo(() => [...new Set(items.map((item) => String(item.status || item.state || "").trim()).filter(Boolean))].sort(), [items]);
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(language);
    return items.filter((item, index) => {
      const status = String(item.status || item.state || "").trim();
      if (statusFilter && status !== statusFilter) return false;
      if (!needle) return true;
      return `${itemTitle(item, `${messages.views[view][0]} ${index + 1}`, language)} ${itemMeta(item, language)}`.toLocaleLowerCase(language).includes(needle);
    });
  }, [items, language, messages.views, query, statusFilter, view]);
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
    {state === "ready" && items.length > 0 && <div className="crm-filter-bar" role="search" aria-label={messages.filterRecords}>
      <label><span>{messages.search}</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={messages.searchPlaceholder} /></label>
      <label><span>{messages.status}</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">{messages.allStatuses}</option>{statuses.map((status) => <option key={status} value={status}>{statusText(status, messages)}</option>)}</select></label>
      {filtersActive && <button className="crm-secondary-button" type="button" onClick={clearFilters}>{messages.clearFilters}</button>}
    </div>}
    {state === "ready" && !items.length && <EmptyState messages={messages} view={view} actionLabel={writeViews.has(view) && enabled ? messages.create : undefined} onAction={writeViews.has(view) && enabled ? onCreate : undefined} />}
    {state === "ready" && items.length > 0 && !filteredItems.length && <EmptyState messages={messages} view={view} filtered actionLabel={messages.clearFilters} onAction={clearFilters} />}
    {state === "ready" && filteredItems.length > 0 && <>
      <MixBar parts={mixFromValues(filteredItems.map((item) => item.status || item.state), language)} />
      <div className="crm-record-list">
      {filteredItems.map((item, index) => {
        const status = String(item.status || item.state || "");
        return <article className="crm-record" key={itemId(item, index)}>
          <span className="crm-record-icon"><Icon name={view} /></span>
          <span className="crm-record-copy"><strong>{itemTitle(item, `${messages.views[view][0]} ${index + 1}`, language)}</strong><small>{itemMeta(item, language)}</small></span>
          {status && <StatusBadge status={status} messages={messages} />}
        </article>;
      })}
      </div>
    </>}
    {state === "ready" && nextCursor && <div className="crm-pagination"><button className="crm-secondary-button" type="button" disabled={loadingMore} onClick={() => void load(nextCursor)}>{loadingMore ? messages.loadingMore : messages.loadMore}</button></div>}
  </section>;
}

function Overview({ bootstrap, tasks, messages, language, navigate, onCreate }: { bootstrap: BootstrapPayload; tasks: CrmTask[]; messages: Messages; language: Language; navigate: (view: ViewId) => void; onCreate: (view: ViewId) => void }) {
  const summary = bootstrap.summary || bootstrap.counts || {};
  const active = tasks.filter((task) => activeStatuses.has(String(task.status || "")));
  const manual = tasks.filter((task) => ["manual_required", "unknown"].includes(String(task.status || "")));
  const completed = tasks.filter((task) => String(task.status || "") === "completed").length;
  const leadCount = Number(summary.leads ?? summary.lead_count ?? 0);
  const poolCount = Number(summary.pools ?? summary.pool_count ?? 0);
  const flowValues = [leadCount, poolCount, active.length, manual.length, completed];
  const flowGoes = [
    () => onCreate("collect"),
    () => navigate("collect"),
    () => onCreate("public"),
    () => navigate("tasks"),
    () => navigate("tasks"),
  ];
  const actions = [
    { id: "collect" as ViewId, title: messages.views.collect[0], hint: messages.pipelineCollectHint, run: () => onCreate("collect") },
    { id: "outreach" as ViewId, title: messages.views.outreach[0], hint: messages.views.outreach[1], run: () => onCreate("outreach") },
    { id: "public" as ViewId, title: messages.views.public[0], hint: messages.views.public[1], run: () => onCreate("public") },
    { id: "groups" as ViewId, title: messages.views.groups[0], hint: messages.views.groups[1], run: () => onCreate("groups") },
    { id: "tasks" as ViewId, title: messages.views.tasks[0], hint: messages.views.tasks[1], run: () => navigate("tasks") },
  ];
  const taskMix = mixParts(
    Object.entries(tasks.reduce((counts, task) => {
      const status = String(task.status || "queued");
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {} as Record<string, number>)),
    language,
  );

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
    <section className="crm-flow-board" aria-label={messages.flowKicker}>
      <ol>
        {messages.flowSteps.map((step, index) => <li key={step[0]}>
          <button type="button" onClick={flowGoes[index]}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div><strong>{step[0]}</strong><small>{step[1]}</small></div>
            <b>{displayValue(flowValues[index])}</b>
          </button>
        </li>)}
      </ol>
    </section>
    {taskMix.length > 0 && <MixBar title={messages.mixTasks} parts={taskMix} />}
    <section className="crm-action-grid" aria-label={messages.acquisitionPath}>
      {actions.map((step) => <button type="button" className="crm-action-card" key={step.id} onClick={step.run}>
        <span className="crm-pipeline-icon" aria-hidden="true"><Icon name={step.id} /></span>
        <strong>{step.title}</strong>
        <small>{step.hint}</small>
      </button>)}
    </section>
    <section className="crm-panel crm-priority-panel">
      <div className="crm-panel-head"><div><h2>{messages.priority}</h2></div><button className="crm-text-button" onClick={() => navigate("tasks")}>{messages.viewTasks}<Icon name="arrow" /></button></div>
      {!manual.length && !active.length ? <EmptyState messages={messages} view="tasks" /> : <div className="crm-compact-tasks">
        {[...manual, ...active].slice(0, 5).map((task, index) => <button type="button" key={String(task.task_id || task.id || index)} onClick={() => navigate("tasks")}><span><strong>{taskTitle(task as Record<string, unknown>, messages.untitledTask, language)}</strong><small>{humanText(task.message, "") || localizedDate(task.updated_at || task.created_at, language)}</small></span><StatusBadge status={String(task.status || "queued")} messages={messages} /></button>)}
      </div>}
    </section>
  </>;
}

function AccountsView({ accounts: seedAccounts, messages, language }: { accounts: CrmAccount[]; messages: Messages; language: Language }) {
  const [accounts, setAccounts] = useState<CrmAccount[]>(seedAccounts);
  const [loading, setLoading] = useState(!seedAccounts.length);
  const [opening, setOpening] = useState("");
  const [verifying, setVerifying] = useState("");
  const [resetting, setResetting] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
  const openLogin = async (account: CrmAccount) => {
    const id = String(account.id || "");
    if (!id) return;
    setOpening(id);
    setError(""); setNotice("");
    try {
      await openLoginSession(id, language);
      setOpening(""); setVerifying(id);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const next = await loadAccounts();
        if (accountIsReady(next.find((item) => String(item.id) === id))) { setNotice(messages.loginVerified); return; }
        await new Promise((resolve) => window.setTimeout(resolve, 5_000));
      }
      throw new Error(operationCatalog[language].browserTimeout);
    } catch (nextError) {
      setError(localizedError(nextError, messages));
    } finally {
      setOpening(""); setVerifying("");
    }
  };
  const verifyLogin = async (account: CrmAccount) => {
    const id = String(account.id || ""); if (!id) return;
    setVerifying(id); setError(""); setNotice("");
    try {
      const result = await crmApi.verifyAccount(id);
      const task = await waitForWorkflow(result.task_id);
      if (String(task.status || "") !== "completed") throw new Error(String(task.error_detail || task.error_code || "crm.errors.accountNeedsLogin"));
      await loadAccounts(); setNotice(messages.loginVerified);
    } catch (nextError) { setError(localizedError(nextError, messages)); }
    finally { setVerifying(""); }
  };
  const resetRotation = async (account: CrmAccount) => {
    const id = String(account.id || "");
    if (!id) return;
    const copy = language === "zh-Hant"
      ? "確認已完成人工關注或帳號處置，並重置此帳號的私訊輪換鎖定？"
      : "确认已完成人工关注或账号处置，并重置此账号的私信轮换锁定？";
    if (!window.confirm(copy)) return;
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
    {error && <div className="crm-inline-error" role="alert"><Icon name="warning" /><span>{error}</span><button type="button" onClick={() => { setError(""); setLoading(true); void loadAccounts().catch((nextError) => { setError(localizedError(nextError, messages)); setLoading(false); }); }}><Icon name="refresh" />{messages.retry}</button></div>}
    {loading ? <div className="crm-list-skeleton" aria-live="polite"><span>{messages.loadingData}</span><i /><i /></div> : !accounts.length ? <EmptyState messages={messages} view="accounts" /> : <div className="crm-account-grid">{accounts.map((account, index) => {
      const accountState = account.health_status || account.status || "ready";
      const needsLogin = accountNeedsTakeover(account);
      return <article className="crm-account-card" data-account-platform={String(account.platform || "").toLowerCase()} key={String(account.id || account.username || index)}>
        <div className="crm-account-avatar" aria-hidden="true"><PlatformLogo platform={account.platform} /></div>
        <div><strong>{account.display_name || account.username || `${messages.accountFallback} ${index + 1}`}</strong><PlatformChip platform={account.platform} label={platformLabel(account.platform) || messages.platformFallback} /></div>
        <StatusBadge status={needsLogin ? "needs_login" : accountState} messages={messages} />
        {account.rotation?.locked && <button className="crm-secondary-button" type="button" disabled={resetting === String(account.id)} onClick={() => void resetRotation(account)}><Icon name="refresh" />{resetting === String(account.id) ? messages.submitting : (language === "zh-Hant" ? "重置私訊輪換" : "重置私信轮换")}</button>}
        {needsLogin && <button className="crm-secondary-button" type="button" disabled={opening === String(account.id) || verifying === String(account.id)} onClick={() => void openLogin(account)}><Icon name="external" />{opening === String(account.id) ? messages.submitting : messages.openLogin}</button>}
        <button className="crm-secondary-button" type="button" disabled={verifying === String(account.id) || opening === String(account.id)} onClick={() => void verifyLogin(account)}><Icon name="refresh" />{verifying === String(account.id) ? messages.verifyingLogin : messages.verifyLogin}</button>
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
  const dialog = useRef<HTMLDivElement>(null);
  const idempotencyKey = useRef("");
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
      if (event.key === "Escape") onClose();
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
  }, [onClose, view]);
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
  return <div className="crm-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <div className="crm-modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="crmWorkflowTitle">
      <div className="crm-modal-head"><div><span className="crm-kicker">{messages.views[view][0]}</span><h2 id="crmWorkflowTitle">{messages.workflowTitle}</h2></div><button className="crm-icon-button" type="button" onClick={onClose} aria-label={messages.cancel}><Icon name="close" /></button></div>
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
      <div className="crm-modal-actions"><button className="crm-secondary-button" type="button" onClick={onClose}>{messages.cancel}</button><button className="crm-primary-button" type="button" disabled={(view !== "relationships" && !instruction.trim()) || !target.trim() || !accountId || (Boolean(workflowActionByView[view]?.write) && !consent) || submitting} onClick={() => void submit()}>{submitting ? messages.submitting : messages.confirm}</button></div>
    </div>
  </div>;
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
  const pageSlide = useRef(0);
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

  const navigate = (next: ViewId, options?: { direction?: number }) => {
    window.location.hash = next;
    pageSlide.current = options?.direction || 0;
    setView(next);
    setDrawerOpen(false);
    window.requestAnimationFrame(() => document.getElementById("crm-main")?.focus({ preventScroll: true }));
  };

  useLayoutEffect(() => {
    const direction = pageSlide.current;
    if (!direction) return;
    pageSlide.current = 0;
    if (!isCompact) return;
    animatePageSlide(mainRef.current, direction);
  }, [view, isCompact]);

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
    navigate(next);
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
    if (action === "cancel" && !window.confirm(messages.cancelTaskConfirm)) return;
    if (action === "confirm" && !window.confirm(messages.confirmTaskConfirm)) return;
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
      {bootstrap.workspace?.managed_by_admin && <div className="crm-banner crm-banner--workspace" role="status"><Icon name="accounts" /><span><strong>{messages.managedWorkspace}</strong>{messages.managedWorkspaceDetail(bootstrap.workspace.username || String(bootstrap.workspace.user_id || "—"), bootstrap.workspace.user_id)}</span><a className="crm-secondary-button" href="/admin.html">{messages.exitWorkspace}</a></div>}
      {partial && <div className="crm-banner crm-banner--partial" role="status"><Icon name="warning" /><span>{messages.partial}</span><button type="button" onClick={() => { void loadBootstrap(); void refreshTasks(); }}><Icon name="refresh" />{messages.retry}</button></div>}
      {bootstrap.module?.degraded && <div className="crm-banner crm-banner--degraded" role="alert"><Icon name="signal" /><span><strong>{messages.degraded}</strong>{messages.degradedHint}</span></div>}
      {view === "overview" && <Overview bootstrap={bootstrap} tasks={tasks} messages={messages} language={language} navigate={navigate} onCreate={startWorkflow} />}
      {activeNav === "collect" && <>
        <div className="crm-module-toolbar">
          <h2>{messages.views.collect[0]}</h2>
          {viewEnabled("collect") && <button className="crm-primary-button" type="button" onClick={() => startWorkflow("collect")}><Icon name="collect" />{messages.create}</button>}
        </div>
        {!viewEnabled("collect") && <div className="crm-inline-error" role="status"><Icon name="warning" /><span>{`${operationCatalog[language].blocked}。${operationCatalog[language].blockedHint}`}</span></div>}
        {viewAdvisory("collect") && <div className="crm-banner crm-banner--partial" role="status"><Icon name="warning" /><span>{viewAdvisory("collect")}</span></div>}
        <PoolsView language={language} />
      </>}
      {activeNav === "public" && <>
        <CompactTabs items={engageTabs} value={engageTabs.includes(view) ? view : "public"} messages={messages} navigate={navigate} label={messages.navItems.public} />
        {view === "groups"
          ? <GroupsView language={language} instagramEnabled={bootstrap.capabilities?.instagram_group_management?.enabled === true} advisory={viewAdvisory("groups")} onCreate={() => setWorkflowView("groups")} />
          : <ResourceList key={view} view={engageTabs.includes(view) ? view : "public"} messages={messages} language={language} enabled={viewEnabled(engageTabs.includes(view) ? view : "public")} blockedHint={`${operationCatalog[language].blocked}。${operationCatalog[language].blockedHint}`} advisory={viewAdvisory(engageTabs.includes(view) ? view : "public")} onCreate={() => startWorkflow(engageTabs.includes(view) ? view : "public")} />}
      </>}
      {activeNav === "tasks" && <>
        <CompactTabs items={taskTabs} value={view === "schedules" ? "schedules" : "tasks"} messages={messages} navigate={navigate} label={messages.views.tasks[0]} />
        {view === "schedules"
          ? <SchedulesView language={language} onCreate={(workflow) => setWorkflowView(workflow)} />
          : <>
            <TasksView tasks={tasks} pollError={pollError} messages={messages} language={language} onAction={(task, action) => void taskAction(task, action)} onChanged={() => void refreshTasks()} hasMore={hasMoreTasks} loadingMore={loadingMoreTasks} onLoadMore={() => void loadMoreTasks()} />
            <details className="crm-analytics-fold"><summary>{language === "zh-Hant" ? "營運分析" : "运营分析"}</summary><AnalyticsView language={language} /></details>
          </>}
      </>}
      {activeNav === "settings" && <>
        <CompactTabs items={settingTabs} value={settingTabs.includes(view) ? view : "accounts"} messages={messages} navigate={navigate} label={messages.views.settings[0]} />
        {(view === "templates") && <TemplatesView language={language} />}
        {(view === "settings") && <DestinationsView language={language} />}
        {(view === "relationships") && <ResourceList key="relationships" view="relationships" messages={messages} language={language} enabled={viewEnabled("relationships")} blockedHint={`${operationCatalog[language].blocked}。${operationCatalog[language].blockedHint}`} advisory={viewAdvisory("relationships")} onCreate={() => startWorkflow("relationships")} />}
        {(view === "accounts" || !settingTabs.includes(view)) && <AccountsView accounts={bootstrap.accounts || []} messages={messages} language={language} />}
      </>}
    </main>
    <WorkflowWizard view={workflowView} messages={messages} language={language} capabilities={bootstrap.capabilities} onClose={closeWorkflow} onCreated={() => { setToast(messages.submitted); void refreshTasks(); }} />
    {toast && <div className="crm-toast" role="status">{toast}</div>}
    <nav ref={dockRef} className="crm-mobile-dock" aria-label={messages.product} style={{ ["--crm-mobile-dock-item-count" as string]: String(navViews.length) }}>
      <span className="crm-mobile-dock-track" aria-hidden="true"><span ref={dockPillRef} className="crm-mobile-dock-pill" /></span>
      <div className="crm-mobile-dock-items">
        {navViews.map((id) => <button type="button" key={id} className={activeNav === id ? "is-active" : ""} aria-current={activeNav === id ? "page" : undefined} onClick={(event) => goDock(id, event.currentTarget)}><Icon name={id} /><span>{messages.navItems[id]}</span></button>)}
      </div>
    </nav>
  </div>;
}
