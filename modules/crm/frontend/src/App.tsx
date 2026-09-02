import { Children, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { CrmApiError, adminWorkspaceContext, crmApi, payloadItems } from "./api";
import { catalog, localizedError, operationCatalog, readLanguage, type Messages } from "./i18n";
import { Icon } from "./icons";
import { PlatformLogo, normalizePlatform, platformLabel } from "./platform";
import { CollectionView, GroupsView, MixBar, PoolsView, PublicEngageView, SchedulesView, StructuredEvidence, TemplatesView } from "./BusinessViews";
import { BarChart, DonutChart, LineChart } from "./charts";
import { chartColor, eventPreviewLabel, groupEventMix, humanText, isEnglishMachineLabel, isOpaqueUserValue, isTechnicalId, isTechnicalKey, localizeStoredTitle, metricLabel, mixFromValues, mixParts, relationshipStatusLabel, taskTitle, workflowLabel, workflowTrend, type TrendRange } from "./present";
import { useTaskPolling } from "./useTaskPolling";
import { useIntersectionLoadMore } from "./useIntersectionLoadMore";
import { WorkflowWizard, type WizardView, type WorkflowSeed } from "./WorkflowWizard";
import { mergeCursorPage } from "./runtime-helpers.js";
import { applyDockPill, applySegmentPill, prefersReducedMotion } from "./segment-motion";
import { ConfirmHost, ConsoleModal, clearPageScrollLock, requestConfirm } from "./confirm-dialog";
import { FilterMenu, SelectMenu } from "./select-menu";
import { PublicToastHost, publicToast } from "./public-toast";
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
  "tasks", "analytics", "schedules", "templates", "accounts", "settings",
];

type NavViewId = "overview" | "collect" | "public" | "tasks" | "settings";
const navViews: NavViewId[] = ["overview", "collect", "public", "tasks", "settings"];
const viewAliases: Partial<Record<ViewId, ViewId>> = {
  pools: "collect",
  outreach: "public",
  groups: "public",
  analytics: "tasks",
  schedules: "settings",
  templates: "settings",
  accounts: "settings",
};
const collectTabs: ViewId[] = ["collect", "pools"];
const engageTabs: ViewId[] = ["public", "outreach", "groups"];
const settingTabs: ViewId[] = ["accounts", "templates", "schedules"];

const endpointByView: Partial<Record<ViewId, string>> = {
  collect: "hotspots",
  pools: "pools",
  public: "events",
  outreach: "tasks",
  groups: "groups",
  schedules: "schedules",
  templates: "templates",
};

const writeViews = new Set<ViewId>(["collect", "public", "outreach", "groups"]);
const workflowActionByView: Partial<Record<ViewId, { actionType: string; write: boolean; sku?: string }>> = {
  collect: { actionType: "collect_profile", write: false },
  public: { actionType: "public_comment", write: true, sku: "threads_auto_reply_batch" },
  outreach: { actionType: "direct_message", write: true, sku: "crm_direct_message_batch" },
  groups: { actionType: "threads_group_invite_post", write: true, sku: "crm_group_invite_batch" },
};
const capabilityByView: Partial<Record<ViewId, string>> = {
  collect: "customer_collection",
  public: "public_interaction",
  outreach: "direct_message_batch",
  groups: "threads_community_post",
};
const activeStatuses = new Set(["queued", "running", "manual_required", "paused_by_user", "paused_by_policy", "unknown", "awaiting_confirmation"]);

function navViewOf(view: ViewId): NavViewId {
  return (viewAliases[view] || view) as NavViewId;
}

function hashView(): ViewId {
  const value = window.location.hash.replace(/^#\/?/, "");
  if (value === "ai") return "collect";
  if (value === "relationships") return "outreach";
  if (value === "destinations" || value === "ai-config") return "accounts";
  return viewIds.includes(value as ViewId) ? value as ViewId : "overview";
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
  const language = document.documentElement.lang === "zh-Hant" ? "zh-Hant" : "zh-Hans";
  return messages.statuses[status as keyof typeof messages.statuses] || relationshipStatusLabel(status, language) || messages.statuses.unknown;
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

function statusChipTone(status = "") {
  const tone = statusTone(status);
  if (tone === "complete") return "is-success";
  if (tone === "danger") return "is-error";
  if (tone === "warning") return "is-manual";
  if (tone === "active") return String(status).toLowerCase() === "queued" ? "is-queued" : "is-running";
  return "is-muted";
}

function StatusBadge({ status, messages }: { status?: string; messages: Messages }) {
  return <span className={`task-status-text ${statusChipTone(status)}`}>{statusText(status, messages)}</span>;
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

function consoleAccountsHref(accountId = "") {
  const context = adminWorkspaceContext();
  const query = new URLSearchParams();
  query.set("view", "accounts");
  if (accountId) query.set("open_login", accountId);
  if (context.isAdmin) query.set("admin_console", "1");
  if (context.workspaceId) query.set("admin_workspace_user_id", context.workspaceId);
  return `/console.html?${query}`;
}

function consoleOpenLoginHref(accountId: string) {
  return consoleAccountsHref(accountId);
}

async function confirmOpenConsoleLogin(accountId: string, messages: Messages) {
  const id = String(accountId || "").trim();
  if (!id) return;
  if (!await requestConfirm({
    title: messages.openLogin,
    message: messages.openLoginConfirm,
    confirmText: messages.openLoginGo,
    cancelText: messages.cancel,
  })) return;
  window.location.assign(consoleOpenLoginHref(id));
}

const takeoverAccountStates = new Set(["pending_login", "needs_login", "need_verification", "cookie_expired", "expired", "abnormal"]);

function accountNeedsTakeover(account: CrmAccount) {
  return Boolean(account.needs_login) || takeoverAccountStates.has(String(account.status || "").toLowerCase()) || takeoverAccountStates.has(String(account.health_status || "").toLowerCase());
}

function taskDetailActions(detail: Record<string, unknown> | null): CrmAction[] {
  return detail && Array.isArray(detail.actions) ? detail.actions as CrmAction[] : [];
}

function taskDetailSteps(detail: Record<string, unknown> | null): CrmStep[] {
  return detail && Array.isArray(detail.steps) ? detail.steps as CrmStep[] : [];
}

type LegacyTrace = {
  source?: string;
  kind?: string;
  summary?: Record<string, string | number | boolean | null>;
  steps?: Array<{ key?: string; status?: string; count?: number; warning?: string }>;
  keyword_evidence?: Array<{ query?: string; count?: number; source_url?: string; warning?: string }>;
  records?: Array<{
    username?: string;
    keyword?: string;
    text?: string;
    permalink?: string;
    profile_url?: string;
    source_url?: string;
    timestamp?: string | number;
    platform?: string;
  }>;
  source_details_missing?: boolean;
};

function legacyTraceOf(detail: Record<string, unknown> | null): LegacyTrace | null {
  const trace = detail?.legacy_trace;
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return null;
  const normalized = trace as LegacyTrace;
  return normalized.source === "legacy_import" ? normalized : null;
}

function safeExternalUrl(value: unknown) {
  const url = String(value || "").trim();
  if (!/^https:\/\//i.test(url)) return "";
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const allowedHosts = ["threads.com", "threads.net", "instagram.com"];
    return parsed.protocol === "https:" && allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? parsed.href : "";
  } catch {
    return "";
  }
}

const legacySummaryLabels: Record<Language, Record<string, string>> = {
  "zh-Hans": {
    original_status: "原始状态", trigger: "触发方式", date_key: "采集日期", started_at: "开始时间", finished_at: "完成时间",
    error: "异常说明", keywords_total: "关键词数量", keywords_truncated: "关键词是否截断", records_total: "采集结果数量",
    records_truncated: "结果是否截断", warning_count: "警告数量", sender_username: "采集账号", daily_quota: "每日配额",
    limit: "每关键词数量", search_mode: "搜索排序", search_type: "搜索类型", media_filter: "媒体筛选", mode: "采集方式",
    pool_id: "客户池", progress: "完成进度", collected: "已采集", duplicates_removed: "已去重", filtered_out: "已过滤",
    instagram: "Instagram 结果", matched: "匹配数量", mortgage: "房贷相关", raw_matches: "原始匹配", threads: "Threads 结果",
    name: "集合名称", platform: "平台", created_at: "建立时间", contact_count: "客户数量", post_count: "帖子数量",
    tag_count: "标签数量", tags: "标签",
  },
  "zh-Hant": {
    original_status: "原始狀態", trigger: "觸發方式", date_key: "採集日期", started_at: "開始時間", finished_at: "完成時間",
    error: "異常說明", keywords_total: "關鍵詞數量", keywords_truncated: "關鍵詞是否截斷", records_total: "採集結果數量",
    records_truncated: "結果是否截斷", warning_count: "警告數量", sender_username: "採集帳號", daily_quota: "每日配額",
    limit: "每關鍵詞數量", search_mode: "搜尋排序", search_type: "搜尋類型", media_filter: "媒體篩選", mode: "採集方式",
    pool_id: "客戶池", progress: "完成進度", collected: "已採集", duplicates_removed: "已去重", filtered_out: "已過濾",
    instagram: "Instagram 結果", matched: "匹配數量", mortgage: "房貸相關", raw_matches: "原始匹配", threads: "Threads 結果",
    name: "集合名稱", platform: "平台", created_at: "建立時間", contact_count: "客戶數量", post_count: "貼文數量",
    tag_count: "標籤數量", tags: "標籤",
  },
};

const legacyStepLabels: Record<Language, Record<string, string>> = {
  "zh-Hans": { run: "任务执行", keyword_evidence: "关键词查询", records: "采集结果", collection_metrics: "采集统计", collection_contacts: "客户提取", collection_posts: "帖子来源", legacy_step: "历史步骤" },
  "zh-Hant": { run: "任務執行", keyword_evidence: "關鍵詞查詢", records: "採集結果", collection_metrics: "採集統計", collection_contacts: "客戶提取", collection_posts: "貼文來源", legacy_step: "歷史步驟" },
};

function legacySummaryValue(key: string, value: string | number | boolean | null, messages: Messages, language: Language) {
  if (key === "original_status") return statusText(String(value || ""), messages);
  if (["date_key", "started_at", "finished_at", "created_at"].includes(key)) return localizedDate(value, language);
  if (key === "platform") return platformLabel(normalizePlatform(value));
  const values: Record<Language, Record<string, string>> = {
    "zh-Hans": { manual: "手动", schedule: "定时排程", top: "热门优先", recent: "最新优先", keyword: "关键词", all: "全部", image: "图片", video: "视频", no_media: "纯文字" },
    "zh-Hant": { manual: "手動", schedule: "定時排程", top: "熱門優先", recent: "最新優先", keyword: "關鍵詞", all: "全部", image: "圖片", video: "影片", no_media: "純文字" },
  };
  return values[language][String(value || "").toLowerCase()] || humanText(value);
}

function LegacyTaskTrace({ trace, messages, language }: { trace: LegacyTrace; messages: Messages; language: Language }) {
  const summary = Object.entries(trace.summary || {}).filter(([, value]) => value !== null && value !== undefined && value !== "");
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  const keywords = Array.isArray(trace.keyword_evidence) ? trace.keyword_evidence : [];
  const records = Array.isArray(trace.records) ? trace.records : [];
  return <section className="crm-legacy-trace" aria-labelledby="crmLegacyTraceTitle">
    <div className="crm-legacy-trace-notice" role="note"><Icon name="warning" /><div><strong id="crmLegacyTraceTitle">{messages.legacyImportedNotice}</strong>{trace.kind && <small>{workflowLabel(trace.kind, language)}</small>}</div></div>
    {summary.length > 0 && <section>
      <h3>{messages.legacyTraceSummary}</h3>
      <dl className="crm-legacy-summary">{summary.map(([key, value]) => <div key={key}><dt>{legacySummaryLabels[language][key] || metricLabel(key, language)}</dt><dd>{legacySummaryValue(key, value, messages, language)}</dd></div>)}</dl>
    </section>}
    {steps.length > 0 && <section>
      <h3>{messages.legacyTraceSteps}</h3>
      <ol className="crm-legacy-steps">{steps.map((step, index) => <li key={`${String(step.key || "step")}-${index}`}>
        <span className="crm-timeline-mark" aria-hidden="true" />
        <div><strong>{legacyStepLabels[language][String(step.key || "")] || eventPreviewLabel(String(step.key || ""), language) || workflowLabel(String(step.key || ""), language) || `${messages.taskStep} ${index + 1}`}</strong>{step.warning && <small>{step.warning}</small>}</div>
        <span className="crm-legacy-step-result">{typeof step.count === "number" ? step.count : ""}{step.status && <StatusBadge status={step.status} messages={messages} />}</span>
      </li>)}</ol>
    </section>}
    {keywords.length > 0 && <section>
      <h3>{messages.legacyKeywordEvidence}</h3>
      <div className="crm-legacy-keywords">{keywords.map((item, index) => {
        const sourceUrl = safeExternalUrl(item.source_url);
        return <article key={`${String(item.query || "keyword")}-${index}`}><div><strong>{humanText(item.query, "—")}</strong>{item.warning && <small>{item.warning}</small>}</div>{typeof item.count === "number" && <span>{item.count}</span>}{sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer noopener"><Icon name="external" />{messages.legacySourceLink}</a>}</article>;
      })}</div>
    </section>}
    {records.length > 0 && <section>
      <h3>{messages.legacyCollectedRecords}</h3>
      <div className="crm-legacy-records">{records.map((record, index) => {
        const username = String(record.username || "").replace(/^@/, "");
        const links: Array<{ href: string; label: string }> = [
          { href: safeExternalUrl(record.profile_url), label: messages.legacyProfileLink },
          { href: safeExternalUrl(record.permalink), label: messages.legacyContentLink },
          { href: safeExternalUrl(record.source_url), label: messages.legacySourceLink },
        ].filter((item, linkIndex, all) => Boolean(item.href) && all.findIndex((candidate) => candidate.href === item.href) === linkIndex);
        const platform = record.platform ? platformLabel(normalizePlatform(record.platform)) : "";
        return <article key={`${username || String(record.permalink || record.source_url || "record")}-${index}`}>
          <div className="crm-legacy-record-head"><strong>{username ? `@${username}` : `${messages.legacyCollectedRecords} ${index + 1}`}</strong><small>{[platform, record.timestamp ? localizedDate(record.timestamp, language) : ""].filter(Boolean).join(" · ")}</small></div>
          {record.keyword && <span className="crm-member-tag">{record.keyword}</span>}
          {record.text && <p>{record.text}</p>}
          {links.length > 0 && <div className="crm-inline-actions">{links.map((link) => <a href={link.href} target="_blank" rel="noreferrer noopener" key={link.href}><Icon name="external" />{link.label}</a>)}</div>}
        </article>;
      })}</div>
    </section>}
    {trace.source_details_missing && <p className="crm-legacy-source-missing"><Icon name="warning" />{messages.legacySourceDetailsMissing}</p>}
  </section>;
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

function TaskCard({ task, messages, language, onAction, onChanged, detailMode = false, onOpen, onDeleted }: { task: CrmTask; messages: Messages; language: Language; onAction: (task: CrmTask, action: "pause" | "resume" | "cancel" | "retry" | "confirm") => void; onChanged: () => void; detailMode?: boolean; onOpen?: () => void; onDeleted?: () => void }) {
  const id = String(task.task_id || task.id || "");
  const status = String(task.status || "queued");
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [detailOpen, setDetailOpen] = useState(detailMode);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "ready" | "error">(detailMode ? "loading" : "idle");
  const [detailError, setDetailError] = useState("");
  const [evidenceError, setEvidenceError] = useState("");
  const [manualBusy, setManualBusy] = useState("");
  const [manualError, setManualError] = useState("");
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [followup, setFollowup] = useState<{ action: CrmAction; kind: "followup_reply" | "nurture_reply"; comment: string; sourceUrl: string; preflight?: Awaited<ReturnType<typeof crmApi.preflight>> } | null>(null);
  const [followupConfirmed, setFollowupConfirmed] = useState(false);
  const detailRequestGeneration = useRef(0);
  const detailRequestInFlight = useRef(false);
  const hasRealProgress = typeof task.progress === "number" || (typeof task.processed === "number" && typeof task.total === "number" && task.total > 0);
  const progress = typeof task.progress === "number" ? task.progress : task.total ? Math.round(((task.processed || 0) / task.total) * 100) : null;
  const loadDetail = async (showBusy = true) => {
    if (!id || detailRequestInFlight.current) return;
    const generation = ++detailRequestGeneration.current;
    detailRequestInFlight.current = true;
    if (showBusy) {
      setManualBusy("detail");
      setDetailState("loading");
      setDetailError("");
    }
    try {
      const [taskDetail, evidenceResult] = await Promise.all([
        crmApi.task(id),
        crmApi.taskEvidence(id)
          .then((payload) => ({ payload, error: null as unknown }))
          .catch((error: unknown) => ({ payload: null, error })),
      ]);
      if (generation !== detailRequestGeneration.current) return;
      const evidenceItems = evidenceResult.payload?.items || evidenceResult.payload?.evidence || [];
      const evidenceByAction = new Map(evidenceItems.map((item) => [String(item.action_id || item.id || ""), item]));
      const taskActions = Array.isArray(taskDetail.actions) ? taskDetail.actions as Array<Record<string, unknown>> : [];
      const actions = taskActions.length
        ? taskActions.map((action) => {
          const evidenceRow = evidenceByAction.get(String(action.id || action.action_id || ""));
          return evidenceRow ? { ...action, state: evidenceRow.state || action.state, evidence: evidenceRow.evidence || action.evidence || {} } : action;
        })
        : evidenceItems.map((item) => ({ id: item.action_id || item.id, state: item.state, evidence: item.evidence || {} }));
      setDetail({ ...taskDetail, actions, evidence: evidenceItems });
      setDetailState("ready");
      setDetailError("");
      setEvidenceError(evidenceResult.error ? localizedError(evidenceResult.error, messages) : "");
      if (showBusy) setDetailOpen(true);
    } catch (error) {
      if (generation !== detailRequestGeneration.current) return;
      if (showBusy) {
        setDetailState("error");
        setDetailError(localizedError(error, messages));
      }
    } finally {
      if (generation === detailRequestGeneration.current) {
        detailRequestInFlight.current = false;
        if (showBusy) setManualBusy("");
      }
    }
  };
  useEffect(() => {
    if (!detailOpen) return;
    const timer = window.setInterval(() => { void loadDetail(false); }, 5_000);
    return () => window.clearInterval(timer);
  }, [detailOpen, id]);
  useEffect(() => {
    if (!detailMode) return;
    setDetailOpen(true);
    void loadDetail();
  }, [detailMode, id]);
  useEffect(() => () => {
    detailRequestGeneration.current += 1;
    detailRequestInFlight.current = false;
  }, []);
  const removeTask = async () => {
    if (!await requestConfirm({
      title: messages.deleteTitle,
      message: messages.taskDeleteHint,
      confirmText: messages.ok,
      cancelText: messages.cancel,
      danger: true,
    })) return;
    setManualBusy("delete"); setManualError("");
    try { await crmApi.deleteTask(id, true); onChanged(); onDeleted?.(); }
    catch (error) { setManualError(localizedError(error, messages)); }
    finally { setManualBusy(""); }
  };
  const prepareFollowupDraft = async (action: CrmAction, kind: "followup_reply" | "nurture_reply") => {
    const actionId = String(action.id || action.action_id || ""); if (!actionId) return;
    setManualBusy(`followup:${actionId}`); setManualError("");
    try {
      const result = await crmApi.generateFollowupDraft({ taskId: id, itemId: actionId, mentionSourceAuthor: true, locale: language });
      const draft = (result.draft && typeof result.draft === "object" ? result.draft : {}) as Record<string, unknown>;
      setFollowup({ action, kind, comment: String(draft.comment || ""), sourceUrl: String(draft.sourcePostUrl || action.target_key || action.payload?.target_url || "") });
      setFollowupConfirmed(false);
    } catch (error) { setManualError(localizedError(error, messages)); }
    finally { setManualBusy(""); }
  };
  const submitFollowup = async () => {
    if (!followup || followup.comment.trim().length < 2) return;
    const sourceActionId = String(followup.action.id || followup.action.action_id || "");
    const action = { action_type: followup.kind, account_id: String(followup.action.account_id || ""), target_key: followup.sourceUrl, content: followup.comment.trim(), payload: { target_url: followup.sourceUrl, content: followup.comment.trim(), parent_workflow_id: id, source_action_id: sourceActionId, lead_id: followup.action.payload?.lead_id || "" } };
    setManualBusy("followup-submit"); setManualError("");
    try {
      if (!followup.preflight) { const preflight = await crmApi.preflight({ workflow_type: "followup", actions: [action] }); setFollowup({ ...followup, preflight }); setFollowupConfirmed(false); return; }
      if (!followupConfirmed) return;
      const workflowTitle = followup.kind === "nurture_reply"
        ? (language === "zh-Hant" ? "持續互動培育" : "持续互动培育")
        : (language === "zh-Hant" ? "針對性跟進回覆" : "针对性跟进回复");
      await crmApi.createWorkflow({ workflow_type: followup.kind, title: workflowTitle, idempotency_key: `crm-${followup.kind}:${sourceActionId}:${window.crypto.randomUUID()}`, input: { parent_workflow_id: id, source_action_id: sourceActionId }, actions: followup.preflight.actions?.length ? followup.preflight.actions : [action], preflight_token: followup.preflight.preflight_token, confirmed: true });
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
    setManualBusy("restore"); setManualError("");
    try {
      await crmApi.taskAction(id, "reconcile");
      setDetail(await crmApi.task(id));
      onChanged();
    } catch (error) { setManualError(localizedError(error, messages)); }
    finally { setManualBusy(""); }
  };
  const unknownActions = taskDetailActions(detail).filter((action) => action.state === "unknown");
  const detailActions = taskDetailActions(detail);
  const detailSteps = taskDetailSteps(detail);
  const legacyTrace = legacyTraceOf(detail);
  const accountId = manualAccountId(detail);
  const loginRequired = needsLoginTakeover(detail) && Boolean(accountId);
  const title = taskTitle(task as Record<string, unknown>, messages.untitledTask, language);
  const username = humanText(task.account_username, "");
  const when = localizedDate(task.updated_at || task.created_at, language);
  const showUsername = Boolean(username && username !== "—" && !title.includes(username.replace(/^@/, "")));
  const meta = [when, showUsername ? (username.startsWith("@") ? username : `@${username}`) : ""].filter(Boolean).join(" · ");
  const rawMessage = String(task.message || "").trim();
  const message = rawMessage ? localizeStoredTitle(rawMessage, language) : "";
  const showMessage = Boolean(message && message !== title && /[\u3400-\u9fff]/.test(message));
  const processed = Number(task.processed || 0);
  const total = Number(task.total || 0);
  const hasSummary = total > 0 || Number(task.evidence_count || 0) > 0;
  const hasTaskMetrics = (hasRealProgress && progress !== null) || hasSummary;
  const openFromCard = (event: ReactMouseEvent<HTMLElement>) => {
    if (!onOpen || detailMode) return;
    if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select")) return;
    onOpen();
  };
  return <article
    className={`crm-task-card${detailMode ? " crm-task-card--detail" : ""}${!detailMode && !hasTaskMetrics ? " crm-task-card--no-progress" : ""}${!detailMode && onOpen ? " is-interactive" : ""}`}
    onClick={openFromCard}
  >
    <div className="crm-task-card-main">
      <div className="crm-task-card-head">
        <div><strong>{title}</strong><small>{meta}</small></div>
        <StatusBadge status={status} messages={messages} />
      </div>
      {showMessage && <p>{message}</p>}
    </div>
    {hasTaskMetrics && <div className="crm-task-card-progress-cell">
      {hasRealProgress && progress !== null && <div className="crm-progress" role="progressbar" aria-label={messages.taskProgress} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, progress))}><span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} /></div>}
      {hasSummary && <div className="crm-task-card-summary">
        {total > 0 && <span>{messages.taskProgressSummary(processed, total)}</span>}
        {Number(task.evidence_count || 0) > 0 && <span>{messages.evidenceAvailable} {Number(task.evidence_count)}</span>}
      </div>}
    </div>}
    <div className="crm-task-foot">
      <div className="row-actions">
        {detailMode && status === "running" && <button type="button" onClick={() => onAction(task, "pause")}>{messages.pause}</button>}
        {detailMode && status.startsWith("paused") && <button type="button" onClick={() => onAction(task, "resume")}>{messages.resume}</button>}
        {detailMode && status === "failed" && <button type="button" onClick={() => onAction(task, "retry")}>{messages.retryAction}</button>}
        {detailMode && status === "awaiting_confirmation" && <button type="button" onClick={() => onAction(task, "confirm")}>{messages.confirmTask}</button>}
        {!detailMode && onOpen && <button type="button" className="unified-action-icon-button" title={messages.inspectTask} aria-label={messages.inspectTask} onClick={onOpen}><Icon name="arrow" /></button>}
        {detailMode && ["awaiting_confirmation", "queued", "running", "manual_required", "paused_by_user", "paused_by_policy"].includes(status) && <button type="button" className="muted" onClick={() => onAction(task, "cancel")}>{messages.cancel}</button>}
        {["completed", "failed", "cancelled"].includes(status) && <button type="button" className="danger unified-action-icon-button" disabled={manualBusy === "delete"} title={language === "zh-Hant" ? "刪除" : "删除"} aria-label={language === "zh-Hant" ? "刪除" : "删除"} onClick={() => void removeTask()}><Icon name="trash" className="ui-trash-icon" /></button>}
      </div>
    </div>
    {manualError && <div className="crm-inline-error" role="alert"><Icon name="warning" />{manualError}</div>}
    {detailMode && detailState === "loading" && <div className="crm-list-skeleton crm-task-detail-loading" aria-live="polite"><span>{messages.loadingData}</span><i /><i /></div>}
    {detailMode && detailState === "error" && <div className="crm-inline-error" role="alert"><Icon name="warning" /><span>{detailError || messages.dataError}</span><button type="button" onClick={() => void loadDetail()}><Icon name="refresh" />{messages.retry}</button></div>}
    {detailMode && detailState === "ready" && legacyTrace && <LegacyTaskTrace trace={legacyTrace} messages={messages} language={language} />}
    {detailMode && detailOpen && detailState === "ready" && (!legacyTrace || detailSteps.length > 0 || detailActions.length > 0 || Boolean(evidenceError) || loginRequired || unknownActions.length > 0) && <div className="crm-manual-panel">
      {evidenceError && <div className="crm-inline-error" role="alert"><Icon name="warning" /><span>{messages.evidenceUnavailable}<small>{evidenceError}</small></span><button type="button" onClick={() => void loadDetail()}><Icon name="refresh" />{messages.retry}</button></div>}
      {(!legacyTrace || detailSteps.length > 0 || detailActions.length > 0) && <section className="crm-evidence-timeline" aria-labelledby={`crm-evidence-${id}`}>
        <h3 id={`crm-evidence-${id}`}>{messages.evidenceTimeline}</h3>
        {!detailSteps.length && !detailActions.length ? <p>{evidenceError ? messages.evidenceUnavailable : messages.noEvidence}</p> : <ol>
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
      </section>}
      {detailActions.filter((action) => action.state !== "unknown" && action.evidence && Object.keys(action.evidence).length > 0).map((action, index) => <section className="crm-evidence-card" key={`evidence-${String(action.id || action.action_id || index)}`}>
        <strong>{operationText(action.action_type, messages)}</strong>
        <span><StatusBadge status={action.state} messages={messages} /></span>
        <StructuredEvidence evidence={action.evidence || {}} language={language} />
        {action.state === "confirmed" && ["public_comment", "public_reply"].includes(String(action.action_type || "")) && <div className="crm-inline-actions">
          <button className="crm-secondary-button" type="button" disabled={manualBusy === `followup:${String(action.id || action.action_id || "")}`} onClick={() => void prepareFollowupDraft(action, "followup_reply")}>{language === "zh-Hant" ? "針對性跟進" : "针对性跟进"}</button>
          <button className="crm-secondary-button" type="button" disabled={manualBusy === `followup:${String(action.id || action.action_id || "")}`} onClick={() => void prepareFollowupDraft(action, "nurture_reply")}>{language === "zh-Hant" ? "持續互動" : "持续互动"}</button>
        </div>}
      </section>)}
      {loginRequired && <button className="crm-secondary-button" type="button" disabled={manualBusy === "login"} onClick={() => {
        setManualBusy("login");
        void confirmOpenConsoleLogin(accountId, messages).finally(() => setManualBusy(""));
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
    {followup && <ConsoleModal title={followup.kind === "nurture_reply" ? (language === "zh-Hant" ? "持續互動培育" : "持续互动培育") : (language === "zh-Hant" ? "針對性跟進回覆" : "针对性跟进回复")} labelledBy={`crm-followup-${id}`} onClose={() => setFollowup(null)} actions={<><button type="button" onClick={() => setFollowup(null)}>{messages.cancel}</button><button type="button" className="primary" disabled={Boolean(manualBusy) || !followup.comment.trim() || Boolean(followup.preflight && !followupConfirmed)} onClick={() => void submitFollowup()}>{followup.preflight ? (language === "zh-Hant" ? "確認並建立" : "确认并创建") : (language === "zh-Hant" ? "檢查目標與計費" : "检查目标与计费")}</button></>}>
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
  if (view === "outreach") {
    if (!type) return false;
    if (/collect|hotspot|persona|pool|group|public_comment|public_reply/.test(type)) return false;
    return /(^|_)(outreach|direct_message|dm)(_|$)/.test(type) || /私信/.test(type);
  }
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
  const rows: Array<[string, string]> = [
    [messages.views[view][0], kind],
    [messages.recordTarget, target],
    [messages.status, statusText(String(inspect.status || inspect.state || payload.status || ""), messages)],
    [messages.recordTime, localizedDate(inspect.occurred_at || inspect.updated_at || inspect.created_at, language)],
    [messages.recordContent, content && content !== "—" ? content : ""],
    [messages.recordResult, result && result !== content ? result : ""],
  ];
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
    {view === "outreach"
      ? writeViews.has(view) && enabled && <div className="crm-engage-toolbar"><button className="crm-primary-button" type="button" onClick={onCreate}>{messages.create}</button></div>
      : <div className="crm-panel-head"><div><span className="crm-kicker">{messages.workspace}</span><h2>{messages.views[view][0]}</h2></div>{writeViews.has(view) && enabled && <button className="crm-primary-button" type="button" onClick={onCreate}>{messages.create}</button>}</div>}
    {!enabled && <div className="crm-inline-error" role="status"><Icon name="warning" /><span>{blockedHint}</span></div>}
    {enabled && advisory && <div className="crm-banner crm-banner--partial" role="status"><Icon name="warning" /><span>{advisory}</span></div>}
    {state === "loading" && <div className="crm-list-skeleton" aria-live="polite"><span>{messages.loadingData}</span><i /><i /><i /></div>}
    {state === "error" && <div className="crm-inline-error" role="alert"><Icon name="warning" /><span>{loadError?.message || messages.dataError}{loadError?.retryable && <small>{messages.retryableHint}</small>}</span><button type="button" onClick={() => void load()}><Icon name="refresh" />{messages.retry}</button></div>}
    {state === "ready" && loadError && <div className="crm-inline-error" role="alert"><Icon name="warning" /><span>{loadError.message}</span><button type="button" onClick={() => void load(nextCursor)}><Icon name="refresh" />{messages.retry}</button></div>}
    {state === "ready" && visibleItems.length > 0 && <div className="crm-record-toolbar">
      <span>{filteredItems.length}/{visibleItems.length}</span>
      <FilterMenu triggerLabel={messages.filterRecords} active={filtersActive}>
        <label className="crm-filter-menu-search"><span>{messages.search}</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={messages.searchPlaceholder} /></label>
        <fieldset className="crm-filter-menu-options"><legend>{messages.status}</legend>
          {[{ value: "", label: messages.allStatuses }, ...statuses.map((status) => ({ value: status, label: statusText(status, messages) }))].map((option) => <button type="button" className={statusFilter === option.value ? "is-active" : ""} aria-pressed={statusFilter === option.value} key={option.value || "all"} onClick={() => setStatusFilter(option.value)}>{option.label}</button>)}
        </fieldset>
        {filtersActive && <button className="crm-filter-menu-clear" type="button" onClick={clearFilters}>{messages.clearFilters}</button>}
      </FilterMenu>
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
  const [trendRange, setTrendRange] = useState<TrendRange>("day");
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
  const analyticsTrend = analytics.workflow_trend && typeof analytics.workflow_trend === "object"
    ? (analytics.workflow_trend as Record<TrendRange, unknown>)[trendRange]
    : null;
  const trend = Array.isArray(analyticsTrend) && analyticsTrend.length
    ? analyticsTrend.map((row) => {
      const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
      return {
        date: String(item.date || ""),
        created: Number(item.created || 0),
        completed: Number(item.completed || 0),
        failed: Number(item.failed || 0),
      };
    })
    : workflowTrend(tasks as Array<Record<string, unknown>>, trendRange);
  const trendSeries = [
    { key: "created", label: messages.chartCreated, color: chartColor(0), values: trend.map((row) => row.created) },
    { key: "completed", label: messages.chartCompleted, color: chartColor(1), values: trend.map((row) => row.completed) },
    { key: "failed", label: messages.chartFailed, color: chartColor(4), values: trend.map((row) => row.failed) },
  ];

  return <>
    <header className="crm-overview-title"><h1>{messages.views.overview[0]}</h1></header>
    <section className="crm-metrics" aria-label={messages.views.overview[0]}>
      <Metric label={messages.metrics.leads} value={leadCount} />
      <Metric label={messages.metrics.pools} value={poolCount} />
      <Metric label={messages.metrics.active} value={summary.active_tasks ?? active.length} />
      <Metric label={messages.metrics.manual} value={summary.manual_required ?? manual.length} />
    </section>
    <section className="crm-chart-grid" aria-label={messages.views.overview[0]}>
      <LineChart
        title={messages.chartTrend}
        hint={messages.chartTrendHints[trendRange]}
        labels={trend.map((row) => row.date)}
        series={trendSeries}
        empty={messages.chartEmpty}
        range={trendRange}
        rangeLabel={messages.chartRangeLabel}
        rangeOptions={[
          { value: "day", label: messages.chartRangeDay },
          { value: "month", label: messages.chartRangeMonth },
          { value: "year", label: messages.chartRangeYear },
        ]}
        valueLabel={messages.chartTaskUnit}
        onRangeChange={setTrendRange}
      />
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
  const [resetting, setResetting] = useState("");
  const [error, setError] = useState("");
  const visibleAccounts = accounts.filter((account) => normalizePlatform(account.platform) === platformFilter);
  const loadAccounts = useCallback(async () => {
    const payload = await crmApi.list("accounts");
    const next = payloadItems(payload) as CrmAccount[];
    setAccounts(next); setLoading(false);
    return next;
  }, []);
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const payload = await crmApi.list("accounts");
        if (!active) return;
        setAccounts(payloadItems(payload) as CrmAccount[]);
        setLoading(false);
      } catch (nextError) {
        if (!active) return;
        setError(localizedError(nextError, messages));
        setLoading(false);
      }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 3_000);
    const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [messages.dataError]);
  useEffect(() => {
    if (!accounts.length) return;
    if (visibleAccounts.length) return;
    const fallback = normalizePlatform(accounts[0]?.platform) === "instagram" ? "instagram" : "threads";
    if (fallback !== platformFilter) setPlatformFilter(fallback);
  }, [accounts, platformFilter, visibleAccounts.length]);
  const openLogin = async (account: CrmAccount) => {
    const id = String(account.id || "");
    if (!id) return;
    setOpening(id);
    setError("");
    try {
      await confirmOpenConsoleLogin(id, messages);
    } finally {
      setOpening("");
    }
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
    <div className="crm-settings-toolbar crm-settings-toolbar--actions crm-account-add-toolbar"><button className="crm-secondary-button" type="button" onClick={() => void requestConfirm({ title: messages.addAccountConsole, message: messages.addAccountConfirm, confirmText: messages.addAccountConsole, cancelText: messages.cancel }).then((ok) => { if (ok) window.location.assign(consoleAccountsHref()); })}>{messages.addAccountConsole}</button></div>
    {accounts.length > 0 && <div className="crm-account-summary" aria-label={messages.accountHealth}>
      <span><b>{new Set(accounts.map((item) => String(item.username || item.id || "").replace(/^@/, "").toLowerCase()).filter(Boolean)).size}</b><small>{messages.accountTotal}</small></span>
      <span><b>{Array.from(accounts.reduce((map, item) => {
        const key = String(item.username || "").replace(/^@/, "").toLowerCase();
        if (!key) return map;
        const current = map.get(key) || { threads: false, instagram: false };
        if (normalizePlatform(item.platform) === "instagram") current.instagram = !accountNeedsTakeover(item);
        else current.threads = !accountNeedsTakeover(item);
        map.set(key, current);
        return map;
      }, new Map<string, { threads: boolean; instagram: boolean }>()).values()).filter((item) => item.threads && item.instagram).length}</b><small>{messages.accountDualReady}</small></span>
      <span><b>{accounts.filter((item) => accountNeedsTakeover(item)).length}</b><small>{messages.accountNeedsAction}</small></span>
    </div>}
    <div className="crm-account-platforms" role="tablist" aria-label={messages.platformFilter}>
      <button type="button" role="tab" aria-selected={platformFilter === "threads"} className={platformFilter === "threads" ? "is-active" : ""} data-account-platform="threads" onClick={() => setPlatformFilter("threads")}><PlatformLogo platform="threads" /><strong>Threads</strong></button>
      <button type="button" role="tab" aria-selected={platformFilter === "instagram"} className={platformFilter === "instagram" ? "is-active" : ""} data-account-platform="instagram" onClick={() => setPlatformFilter("instagram")}><PlatformLogo platform="instagram" /><strong>Instagram</strong></button>
    </div>
    {error && <div className="crm-inline-error" role="alert"><Icon name="warning" /><span>{error}</span><button type="button" onClick={() => { setError(""); setLoading(true); void loadAccounts().catch((nextError) => { setError(localizedError(nextError, messages)); setLoading(false); }); }}><Icon name="refresh" />{messages.retry}</button></div>}
    {loading ? <div className="crm-list-skeleton" aria-live="polite"><span>{messages.loadingData}</span><i /><i /></div> : !accounts.length ? <EmptyState messages={messages} view="accounts" /> : !visibleAccounts.length ? <p className="crm-quiet-empty">{messages.noPlatformAccounts}</p> : <div className="crm-account-grid">{visibleAccounts.map((account, index) => {
      const needsLogin = accountNeedsTakeover(account);
      const username = account.username || account.display_name || `${messages.accountFallback} ${index + 1}`;
      const platformName = platformLabel(account.platform) || messages.platformFallback;
      const handle = String(account.username || "").replace(/^@/, "").toLowerCase();
      const dualReady = Boolean(handle) && accounts.some((item) => {
        const otherHandle = String(item.username || "").replace(/^@/, "").toLowerCase();
        return otherHandle === handle && normalizePlatform(item.platform) !== normalizePlatform(account.platform) && !accountNeedsTakeover(item) && !needsLogin;
      });
      return <article className="crm-account-card" data-account-platform={String(account.platform || "").toLowerCase()} key={String(account.id || account.username || index)}>
        <div className="crm-account-card-main">
          <span className="crm-account-card-platform">
            <PlatformLogo platform={account.platform} />
            <span>{platformName}</span>
          </span>
          <strong title={username}>{username}</strong>
          {dualReady && <span className="crm-chip">{messages.dualPlatform}</span>}
          <AccountStatusChip account={account} messages={messages} />
        </div>
        <div className="crm-account-card-actions">
          <button className="crm-account-card-action crm-account-card-action--login" type="button" disabled={opening === String(account.id)} onClick={() => void openLogin(account)}><Icon name="external" />{opening === String(account.id) ? messages.submitting : messages.openLogin}</button>
          {Boolean(account.rotation?.locked) && !needsLogin && <button className="crm-account-card-action" type="button" disabled={resetting === String(account.id)} title={messages.resetRotationHint} onClick={() => void resetRotation(account)}><Icon name="refresh" />{resetting === String(account.id) ? messages.submitting : messages.resetRotation}</button>}
        </div>
      </article>;
    })}</div>}
  </section>;
}

type TaskFilter = "" | "attention" | "active" | "completed" | "failed";

function taskFilterGroup(statusValue: unknown): Exclude<TaskFilter, ""> {
  const status = String(statusValue || "queued");
  if (["queued", "running"].includes(status)) return "active";
  if (status === "completed") return "completed";
  if (["failed", "cancelled"].includes(status)) return "failed";
  return "attention";
}

type TaskDataMode = "live" | "history";

const opcHistoryCopy = {
  "zh-Hans": {
    title: "OPC 历史池", runs: "OPC 历史任务", rows: "历史采集记录", unique: "去重可用账号",
    search: "搜索账号、内容或关键词", searchPlaceholder: "例如：房贷需求、品牌经营、账号名称", keywords: "热门历史标签",
    keywordHint: "可多选；查询会取并集，同平台同账号只保留一条。", platform: "筛选平台", status: "筛选触达状态",
    allPlatforms: "全部平台", allStatuses: "全部状态", fresh: "全新名单", contacted: "曾触达", failed: "失败记录",
    excludeExisting: "排除当前客户池已有账号", excludeInteracted: "排除已有互动记录", preview: "预览符合人数",
    previewing: "正在查询…", import: "合并去重并保存客户池", importing: "正在导入…", matched: "符合去重账号",
    imported: "已建立 OPC 历史客户池", empty: "当前条件没有匹配的 OPC 历史账号", loadError: "OPC 历史读取失败",
    category: "OPC 历史精选客户池", clear: "清除标签",
  },
  "zh-Hant": {
    title: "OPC 歷史池", runs: "OPC 歷史任務", rows: "歷史採集記錄", unique: "去重可用帳號",
    search: "搜尋帳號、內容或關鍵詞", searchPlaceholder: "例如：房貸需求、品牌經營、帳號名稱", keywords: "熱門歷史標籤",
    keywordHint: "可多選；查詢會取聯集，同平台同帳號只保留一筆。", platform: "篩選平台", status: "篩選觸達狀態",
    allPlatforms: "全部平台", allStatuses: "全部狀態", fresh: "全新名單", contacted: "曾觸達", failed: "失敗記錄",
    excludeExisting: "排除目前客戶池已有帳號", excludeInteracted: "排除已有互動記錄", preview: "預覽符合人數",
    previewing: "正在查詢…", import: "合併去重並儲存客戶池", importing: "正在匯入…", matched: "符合去重帳號",
    imported: "已建立 OPC 歷史客戶池", empty: "目前條件沒有匹配的 OPC 歷史帳號", loadError: "OPC 歷史讀取失敗",
    category: "OPC 歷史精選客戶池", clear: "清除標籤",
  },
} as const;

function OpcHistoryView({ language, onChanged }: { language: Language; onChanged: () => void }) {
  const copy = opcHistoryCopy[language];
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [search, setSearch] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [platform, setPlatform] = useState("");
  const [contact, setContact] = useState("");
  const [excludeExisting, setExcludeExisting] = useState(true);
  const [excludeInteracted, setExcludeInteracted] = useState(true);
  const [preview, setPreview] = useState<{ total: number; rows: Array<Record<string, unknown>> } | null>(null);
  const [busy, setBusy] = useState<"summary" | "preview" | "import" | "">("summary");
  const [error, setError] = useState("");
  const loadSummary = useCallback(async () => {
    setBusy("summary"); setError("");
    try { setSummary(await crmApi.opcHistorySummary(language)); }
    catch (next) { setError(next instanceof CrmApiError && next.body.message ? String(next.body.message) : copy.loadError); }
    finally { setBusy(""); }
  }, [copy.loadError, language]);
  useEffect(() => { void loadSummary(); }, [loadSummary]);
  const topKeywords = Array.isArray(summary?.topKeywords)
    ? summary.topKeywords.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
  const queryPayload = () => ({ search: search.trim(), platform, contact, keywords, keywordMode: "any", limit: 100, locale: language });
  const runPreview = async () => {
    setBusy("preview"); setError("");
    try {
      const result = await crmApi.queryOpcHistory(queryPayload());
      const rows = Array.isArray(result.data) ? result.data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
      setPreview({ total: Number(result.total || 0), rows });
    } catch (next) { setError(next instanceof CrmApiError && next.body.message ? String(next.body.message) : copy.loadError); setPreview(null); }
    finally { setBusy(""); }
  };
  const importHistory = async () => {
    if (!preview?.total) return;
    setBusy("import"); setError("");
    try {
      const category = `${copy.category}${keywords.length ? ` · ${keywords.slice(0, 2).join("＋")}` : ""}`.slice(0, 32);
      const result = await crmApi.importOpcHistory({
        ...queryPayload(), limit: 2000, category, excludeExisting, excludeInteracted,
        tags: keywords.map((keyword) => `${language === "zh-Hant" ? "關鍵詞" : "关键词"}:${keyword}`),
        idempotencyKey: `crm-opc-import:${window.crypto.randomUUID()}`,
      });
      publicToast(`${copy.imported} · ${Number(result.importedCount || 0)}`);
      onChanged();
      await loadSummary();
    } catch (next) {
      const empty = next instanceof CrmApiError && (next.status === 409 || /opc_history_empty|opcHistoryEmpty/i.test(`${next.body.code || ""} ${next.body.message_key || ""}`));
      setError(empty ? copy.empty : next instanceof CrmApiError && next.body.message ? String(next.body.message) : copy.loadError);
    } finally { setBusy(""); }
  };
  return <section className="crm-opc-history-center" aria-busy={Boolean(busy)}>
    <div className="crm-opc-history-summary" aria-label={copy.title}>
      <div><strong>{Number(summary?.runs || 0)}</strong><span>{copy.runs}</span></div>
      <div><strong>{Number(summary?.rows || 0)}</strong><span>{copy.rows}</span></div>
      <div><strong>{Number(summary?.uniqueLeads || 0)}</strong><span>{copy.unique}</span></div>
    </div>
    {error && <div className="crm-inline-error" role="alert"><Icon name="warning" /><span>{error}</span><button type="button" onClick={() => void loadSummary()}>{messagesForLanguage(language).retry}</button></div>}
    <label className="crm-field crm-opc-history-search"><span>{copy.search}</span><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPreview(null); }} placeholder={copy.searchPlaceholder} /></label>
    <div className="crm-opc-history-keywords">
      <div className="crm-opc-history-label"><strong>{copy.keywords}</strong><small>{copy.keywordHint}</small>{keywords.length > 0 && <button type="button" onClick={() => { setKeywords([]); setPreview(null); }}>{copy.clear}</button>}</div>
      <div className="crm-chip-row">{topKeywords.slice(0, 16).map((item) => { const name = String(item.name || ""); const active = keywords.includes(name); return <button type="button" className={active ? "is-active" : ""} aria-pressed={active} key={name} onClick={() => { setKeywords((current) => current.includes(name) ? current.filter((value) => value !== name) : [...current, name]); setPreview(null); }}>{name} · {Number(item.count || 0)}</button>; })}</div>
    </div>
    <div className="crm-opc-history-controls">
      <SelectMenu triggerIcon="filter" triggerLabel={copy.platform} active={Boolean(platform)} value={platform} onChange={(value) => { setPlatform(value); setPreview(null); }} options={[{ value: "", label: copy.allPlatforms }, { value: "instagram", label: "Instagram" }, { value: "threads", label: "Threads" }]} />
      <SelectMenu triggerIcon="filter" triggerLabel={copy.status} active={Boolean(contact)} value={contact} onChange={(value) => { setContact(value); setPreview(null); }} options={[{ value: "", label: copy.allStatuses }, { value: "new", label: copy.fresh }, { value: "contacted", label: copy.contacted }, { value: "failed", label: copy.failed }]} />
      <label className="crm-consent"><input type="checkbox" checked={excludeExisting} onChange={(event) => setExcludeExisting(event.target.checked)} /><span>{copy.excludeExisting}</span></label>
      <label className="crm-consent"><input type="checkbox" checked={excludeInteracted} onChange={(event) => setExcludeInteracted(event.target.checked)} /><span>{copy.excludeInteracted}</span></label>
    </div>
    {preview && <div className="crm-opc-history-preview" role="status"><strong>{copy.matched} · {preview.total}</strong><span>{preview.total ? preview.rows.slice(0, 8).map((row) => `@${String(row.username || "")}`).join(" · ") : copy.empty}</span></div>}
    <div className="crm-opc-history-actions"><button className="crm-secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void runPreview()}>{busy === "preview" ? copy.previewing : copy.preview}</button><button className="crm-primary-button" type="button" disabled={Boolean(busy) || !preview?.total} onClick={() => void importHistory()}>{busy === "import" ? copy.importing : copy.import}</button></div>
  </section>;
}

function messagesForLanguage(language: Language) { return catalog[language]; }

function TasksView({ tasks, pollError, messages, language, onAction, onChanged, active, hasMore, loadingMore, loadMoreError, paginationStarted, onLoadMore }: { tasks: CrmTask[]; pollError: boolean; messages: Messages; language: Language; onAction: (task: CrmTask, action: "pause" | "resume" | "cancel" | "retry" | "confirm") => void; onChanged: () => void; active: boolean; hasMore: boolean; loadingMore: boolean; loadMoreError: boolean; paginationStarted: boolean; onLoadMore: () => void }) {
  const [mode, setMode] = useState<TaskDataMode>("live");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskFilter>("");
  const [sortOrder, setSortOrder] = useState<"created" | "updated">("created");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const selectedTask = tasks.find((task) => String(task.task_id || task.id || "") === selectedTaskId);
  const { sentinelRef, supported: intersectionSupported } = useIntersectionLoadMore({ enabled: active && mode === "live" && hasMore && !loadMoreError && !selectedTaskId, loading: loadingMore, onLoadMore });
  const openTask = (taskId: string) => setSelectedTaskId(taskId);
  const closeTask = () => setSelectedTaskId("");
  const counts = useMemo(() => ({
    total: tasks.length,
    active: tasks.filter((task) => taskFilterGroup(task.status) === "active").length,
    attention: tasks.filter((task) => taskFilterGroup(task.status) === "attention").length,
    completed: tasks.filter((task) => taskFilterGroup(task.status) === "completed").length,
  }), [tasks]);
  const visibleTasks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (statusFilter && taskFilterGroup(task.status) !== statusFilter) return false;
      if (!normalized) return true;
      return [task.title, task.name, task.task_id, task.id, task.kind, task.account_username]
        .some((value) => String(value || "").toLowerCase().includes(normalized));
    }).sort((left, right) => {
      const leftValue = sortOrder === "updated" ? left.updated_at || left.created_at : left.created_at || left.updated_at;
      const rightValue = sortOrder === "updated" ? right.updated_at || right.created_at : right.created_at || right.updated_at;
      return (Date.parse(String(rightValue || "")) || 0) - (Date.parse(String(leftValue || "")) || 0);
    });
  }, [query, sortOrder, statusFilter, tasks]);
  return <section className="crm-panel">
    <div className="crm-panel-head crm-task-panel-head"><div><h2>{messages.views.tasks[0]}</h2><p>{messages.noSimulatedProgress}</p></div><span className={`crm-live-indicator ${pollError ? "is-offline" : ""}`}><i />{pollError ? messages.partial : messages.live}</span></div>
    {tasks.length > 0 && <div className="crm-task-overview-grid" aria-label={messages.views.tasks[0]}>
      <div><strong>{counts.total}</strong><span>{messages.taskTotal}</span></div>
      <div><strong>{counts.active}</strong><span>{messages.taskActive}</span></div>
      <div><strong>{counts.attention}</strong><span>{messages.taskAttention}</span></div>
      <div><strong>{counts.completed}</strong><span>{messages.taskCompleted}</span></div>
    </div>}
    <div className="crm-task-data-tabs" role="tablist" aria-label={messages.views.tasks[0]}><button type="button" role="tab" aria-selected={mode === "live"} className={mode === "live" ? "is-active" : ""} onClick={() => setMode("live")}>{messages.realTimeTasks}<span>{tasks.length}</span></button><button type="button" role="tab" aria-selected={mode === "history"} className={mode === "history" ? "is-active" : ""} onClick={() => { setMode("history"); setSelectedTaskId(""); }}>{language === "zh-Hant" ? "OPC 歷史池" : "OPC 历史池"}</button></div>
    {mode === "history" ? <OpcHistoryView language={language} onChanged={onChanged} /> : <>
    {tasks.length > 0 && <div className="crm-task-section-toolbar">
      <div className="crm-task-section-head"><h3>{messages.realTimeTasks}</h3><span>{tasks.length}</span></div>
      <div className="crm-task-filter-bar" role="search" aria-label={messages.filterRecords}>
        {(query || statusFilter || sortOrder !== "created") && <span className="crm-task-result-count" title={messages.taskResultCount(visibleTasks.length, tasks.length)}>{visibleTasks.length}/{tasks.length}</span>}
        <label className="crm-task-search"><Icon name="search" /><input type="search" aria-label={messages.search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={messages.search} /></label>
        <SelectMenu triggerIcon="filter" triggerLabel={messages.taskFilter} active={Boolean(statusFilter)} value={statusFilter} onChange={(value) => setStatusFilter(value as TaskFilter)} placeholder={messages.taskFilterAll} options={[{ value: "", label: messages.taskFilterAll }, { value: "attention", label: messages.taskFilterAttention }, { value: "active", label: messages.taskFilterActive }, { value: "completed", label: messages.taskFilterCompleted }, { value: "failed", label: messages.taskFilterFailed }]} />
        <SelectMenu triggerIcon="sort" triggerLabel={messages.taskSort} active={sortOrder !== "created"} value={sortOrder} onChange={(value) => setSortOrder(value as "created" | "updated")} options={[{ value: "created", label: messages.taskSortCreated }, { value: "updated", label: messages.taskSortUpdated }]} />
        {(query || statusFilter || sortOrder !== "created") && <button className="crm-task-filter-reset unified-action-icon-button" type="button" title={messages.clearFilters} aria-label={messages.clearFilters} onClick={() => { setQuery(""); setStatusFilter(""); setSortOrder("created"); }}><Icon name="close" /></button>}
      </div>
    </div>}
    {!tasks.length ? <EmptyState messages={messages} view="tasks" /> : !visibleTasks.length ? <EmptyState messages={messages} view="tasks" filtered /> : <div className="crm-task-list">{visibleTasks.map((task, index) => <TaskCard task={task} messages={messages} language={language} onAction={onAction} onChanged={onChanged} onOpen={() => openTask(String(task.task_id || task.id || ""))} key={String(task.task_id || task.id || index)} />)}</div>}
    {hasMore && !selectedTaskId && <div className="crm-task-load-sentinel">
      <span ref={sentinelRef} role="status" aria-live="polite" aria-busy={loadingMore}>{loadingMore ? messages.loadingMore : messages.scrollToLoad}</span>
      {loadMoreError && <div className="crm-inline-error" role="alert"><Icon name="warning" /><span>{messages.dataError}</span><button className="crm-secondary-button" type="button" disabled={loadingMore} onClick={onLoadMore}><Icon name="refresh" />{messages.retry}</button></div>}
      {!intersectionSupported && !loadMoreError && <button className="crm-secondary-button" type="button" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? messages.loadingMore : messages.loadMore}</button>}
    </div>}
    {!hasMore && paginationStarted && tasks.length > 0 && <p className="crm-task-load-complete" role="status" aria-live="polite">{messages.allTasksLoaded}</p>}
    </>}
    {selectedTask && <ConsoleModal title={messages.taskDetailTitle} labelledBy="crmTaskDetailTitle" onClose={closeTask} wide>
      <TaskCard task={selectedTask} key={selectedTaskId} messages={messages} language={language} onAction={onAction} onChanged={onChanged} onDeleted={closeTask} detailMode />
    </ConsoleModal>}
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
  return <ConsoleModal title={messages.workflowTitle} labelledBy="crmWorkflowTitle" onClose={onClose} dialogRef={dialog} actions={<><button type="button" onClick={onClose}>{messages.cancel}</button><button type="button" className="primary" disabled={!instruction.trim() || !target.trim() || !accountId || (Boolean(workflowActionByView[view]?.write) && !consent) || submitting} onClick={() => void submit()}>{submitting ? messages.submitting : messages.confirm}</button></>}>
      <label className="crm-field"><span>{labels.account}</span><SelectMenu value={accountId} onChange={setAccountId} placeholder={labels.selectAccount} options={[{ value: "", label: labels.selectAccount }, ...accounts.map((account) => ({ value: String(account.id), label: `${account.display_name || account.username} · ${account.platform}` }))]} /></label>
      <label className="crm-field"><span>{labels.target}</span><input value={target} onChange={(event) => setTarget(event.target.value)} placeholder={labels.targetPlaceholder} /></label>
      <label className="crm-field"><span>{messages.workflowInstruction}</span><textarea rows={5} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={messages.workflowPlaceholder} /></label>
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
  const [workflowSeed, setWorkflowSeed] = useState<WorkflowSeed | null>(null);
  const [preferredPublicPoolId, setPreferredPublicPoolId] = useState("");

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
  const { tasks, pollError, refresh: refreshTasks, loadMore: loadMoreTasks, hasMore: hasMoreTasks, loadingMore: loadingMoreTasks, loadMoreError: loadMoreTasksError, paginationStarted: taskPaginationStarted } = useTaskPolling(bootstrap.tasks, handlePolicyFailure, bootstrapState === "ready", bootstrap.task_page);
  const closeWorkflow = useCallback(() => { setWorkflowView(null); setWorkflowSeed(null); }, []);

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
      publicToast(localizedError(error, messages), { status: "failed" });
    }
  };

  if (bootstrapState === "loading") return <LoadingPage messages={messages} />;
  if (bootstrapState === "forbidden") return <StatePage title={messages.forbidden} description={messages.forbiddenHint} action={<a className="crm-secondary-button" href="/console.html">{messages.console}</a>} />;
  if (bootstrapState === "maintenance") return <StatePage icon="signal" title={messages.maintenance} description={bootstrap.module?.message || messages.maintenanceHint} action={<button className="crm-primary-button" type="button" onClick={() => void loadBootstrap()}>{messages.retry}</button>} />;
  if (bootstrapState === "error") return <StatePage title={messages.unavailable} description={messages.loadingHint} action={<button className="crm-primary-button" type="button" onClick={() => void loadBootstrap()}><Icon name="refresh" />{messages.retry}</button>} />;

  const activeNav = navViewOf(view);
  const startWorkflow = (next: ViewId, seed?: WorkflowSeed | null) => {
    if (viewEnabled(next) && ["collect", "public", "outreach", "groups"].includes(next)) {
      setWorkflowSeed(seed || null);
      setWorkflowView(next as WizardView);
    }
  };

  return <div className="crm-app">
    <div className={`crm-sidebar-backdrop ${drawerOpen ? "is-open" : ""}`} aria-hidden={!drawerOpen} onClick={() => setDrawerOpen(false)} />
    <aside ref={sidebar} id="crmSidebar" className={`crm-sidebar ${drawerOpen ? "is-open" : ""}`} aria-label={messages.product} aria-hidden={isCompact && !drawerOpen ? "true" : undefined} inert={isCompact && !drawerOpen ? true : undefined}>
      <div className="crm-sidebar-head"><div className="crm-monogram">CRM</div><strong>{messages.productShort}</strong><button className="unified-action-icon-button crm-sidebar-close" type="button" onClick={() => setDrawerOpen(false)} aria-label={messages.closeNav} title={messages.closeNav}><Icon name="close" className="ui-action-icon" /></button></div>
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
            {!viewEnabled("collect") && <div className="crm-inline-error" role="status"><Icon name="warning" /><span>{`${operationCatalog[language].blocked}。${operationCatalog[language].blockedHint}`}</span></div>}
            {viewAdvisory("collect") && <div className="crm-banner crm-banner--partial" role="status"><Icon name="warning" /><span>{viewAdvisory("collect")}</span></div>}
            <CompactTabs items={collectTabs} value={collectTabs.includes(view) ? view : "collect"} messages={messages} navigate={navigate} label={messages.navItems.collect} />
            <SubpageStrip items={collectTabs} value={collectTabs.includes(view) ? view : "collect"}>
              <CollectionView language={language} onCollectMode={viewEnabled("collect") ? (mode) => startWorkflow("collect", { collectMode: mode }) : undefined} />
              <PoolsView language={language} onEngage={(poolId) => { setPreferredPublicPoolId(poolId); navigate("public"); }} />
            </SubpageStrip>
          </div>
          <div className="crm-nav-page" aria-hidden={activeNav !== "public"} inert={activeNav !== "public" ? true : undefined}>
            <CompactTabs items={engageTabs} value={engageTabs.includes(view) ? view : "public"} messages={messages} navigate={navigate} label={messages.navItems.public} />
            <SubpageStrip items={engageTabs} value={engageTabs.includes(view) ? view : "public"}>
              <PublicEngageView language={language} enabled={viewEnabled("public")} blockedHint={`${operationCatalog[language].blocked}。${operationCatalog[language].blockedHint}`} initialPoolId={preferredPublicPoolId} onStart={(seed) => startWorkflow("public", seed)} />
              <ResourceList view="outreach" messages={messages} language={language} enabled={viewEnabled("outreach")} blockedHint={`${operationCatalog[language].blocked}。${operationCatalog[language].blockedHint}`} advisory={viewAdvisory("outreach")} onCreate={() => startWorkflow("outreach")} />
              <GroupsView language={language} instagramEnabled={bootstrap.capabilities?.instagram_group_management?.enabled === true} advisory={viewAdvisory("groups")} onCreate={() => setWorkflowView("groups")} />
            </SubpageStrip>
          </div>
          <div className="crm-nav-page" aria-hidden={activeNav !== "tasks"} inert={activeNav !== "tasks" ? true : undefined}>
            <TasksView tasks={tasks} pollError={pollError} messages={messages} language={language} onAction={(task, action) => void taskAction(task, action)} onChanged={() => void refreshTasks()} active={activeNav === "tasks"} hasMore={hasMoreTasks} loadingMore={loadingMoreTasks} loadMoreError={loadMoreTasksError} paginationStarted={taskPaginationStarted} onLoadMore={() => void loadMoreTasks()} />
          </div>
          <div className="crm-nav-page" aria-hidden={activeNav !== "settings"} inert={activeNav !== "settings" ? true : undefined}>
            <CompactTabs items={settingTabs} value={settingTabs.includes(view) ? view : "accounts"} messages={messages} navigate={navigate} label={messages.views.settings[0]} />
            <SubpageStrip items={settingTabs} value={settingTabs.includes(view) ? view : "accounts"}>
              <AccountsView accounts={bootstrap.accounts || []} messages={messages} language={language} />
              <TemplatesView language={language} />
              <SchedulesView language={language} onCreate={(workflow) => startWorkflow(workflow, { execution: "schedule" })} />
            </SubpageStrip>
          </div>
        </div>
      </div>
      </div>
    </main>
    <WorkflowWizard view={workflowView} messages={messages} language={language} capabilities={bootstrap.capabilities} seed={workflowSeed} onClose={closeWorkflow} onCreated={() => { publicToast(messages.submitted, { status: "queued", onClick: () => navigate("tasks") }); void refreshTasks(); }} />
    <ConfirmHost titleLabel={messages.confirmTitle} okLabel={messages.ok} cancelLabel={messages.cancel} />
    <PublicToastHost />
    <nav ref={dockRef} className="crm-mobile-dock" aria-label={messages.product} style={{ ["--crm-mobile-dock-item-count" as string]: String(navViews.length) }}>
      <span className="crm-mobile-dock-track" aria-hidden="true"><span ref={dockPillRef} className="crm-mobile-dock-pill" /></span>
      <div className="crm-mobile-dock-items">
        {navViews.map((id) => <button type="button" key={id} className={activeNav === id ? "is-active" : ""} aria-current={activeNav === id ? "page" : undefined} onClick={(event) => goDock(id, event.currentTarget)}><Icon name={id} /><span>{messages.navItems[id]}</span></button>)}
      </div>
    </nav>
  </div>;
}
