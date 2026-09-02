import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSinglePollScheduler, isModulePolicyError, mergeCursorPage, mergePolledItems } from "../src/runtime-helpers.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("CRM overview exposes preview charts and no other-page task launchers", async () => {
  const app = await read("src/App.tsx");
  const i18n = await read("src/i18n.ts");
  const charts = await read("src/charts.tsx");
  const present = await read("src/present.ts");
  const css = await read("src/styles.css");
  assert.match(app, /className="crm-chart-grid"/);
  assert.match(app, /useState<TrendRange>\("day"\)/);
  assert.match(app, /chartRangeDay/);
  assert.match(app, /chartRangeMonth/);
  assert.match(app, /chartRangeYear/);
  assert.match(app, /DonutChart/);
  assert.match(app, /LineChart/);
  assert.match(charts, /conic-gradient/);
  assert.match(charts, /crm-line-chart/);
  assert.match(charts, /role="tablist"/);
  assert.match(charts, /aria-selected=\{range === value\}/);
  assert.doesNotMatch(charts, /crm-line-point-value/);
  assert.match(charts, /crm-chart-placeholder/);
  assert.match(charts, /persona-chart-placeholder-line|M8 60 L54 44/);
  assert.match(present, /export type TrendRange = "day" \| "month" \| "year"/);
  assert.match(present, /workflowTrend/);
  assert.match(css, /\.crm-overview-title \{[\s\S]*?justify-content:\s*center/);
  assert.match(css, /\.crm-metrics \{[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.crm-trend-range/);
  assert.doesNotMatch(app, /className="crm-action-grid"/);
  assert.doesNotMatch(app, /crm-priority-panel/);
  assert.doesNotMatch(app, /crm-flow-board/);
  assert.match(i18n, /pipelineCollect: "发现客户"/);
  assert.match(i18n, /navItems: \{ overview: "总览"/);
});

test("CRM exposes the canonical work views without duplicating system AI settings", async () => {
  const app = await read("src/App.tsx");
  const expected = ["overview", "collect", "pools", "public", "outreach", "groups", "tasks", "analytics", "schedules", "templates", "accounts", "settings"];
  for (const view of expected) assert.match(app, new RegExp(`"${view}"`));
  assert.doesNotMatch(app, /DestinationsView/);
  assert.doesNotMatch(app, /AiSettingsView/);
  assert.match(app, /window\.location\.hash/);
});

test("settings use one tab boundary and templates render as compact cards with shared detail and edit windows", async () => {
  const app = await read("src/App.tsx");
  const business = await read("src/BusinessViews.tsx");
  const css = await read("src/styles.css");

  assert.doesNotMatch(app, /<div className="crm-panel-head"><div><span className="crm-kicker">\{messages\.accountHealth\}/);
  assert.doesNotMatch(business, /<PageHeader title=\{t\.templates\}/);
  assert.doesNotMatch(business, /<PageHeader title=\{t\.schedules\}/);
  assert.doesNotMatch(business, /selectedTemplateId|previewImageUrl:|crm-template-picker|crm-template-inline-editor/);
  assert.match(business, /crm-template-list/);
  assert.match(business, /crm-template-list-card/);
  assert.match(business, /setInspectingTemplate/);
  assert.match(business, /setTemplateEditOpen/);
  assert.match(business, /<ConsoleModal title=\{t\.templateDetails\}/);
  assert.match(business, /<ConsoleModal title=\{draft\.id \? t\.edit : t\.newTemplate\}/);
  assert.match(business, /\{t\.viewDetails\}/);
  assert.match(business, /\{t\.edit\}/);
  assert.match(business, /className="crm-template-list-delete"/);
  assert.match(business, /onClick=\{\(\) => void remove\(row\)\}/);
  assert.match(business, /templateTypeOptions\(language, draft\.template_type\)/);
  assert.match(business, /outreach: \["私信触达", "私訊觸達"\]/);
  assert.match(business, /className="persona-compose-media-upload upload-zone crm-field--wide"/);
  assert.match(business, /data-upload-dropzone/);
  assert.match(business, /className="account-pool-add-button persona-compose-media-upload-trigger persona-media-empty-picker"/);
  assert.match(business, /className="persona-media-empty-picker-copy"/);
  assert.doesNotMatch(business, /crm-template-upload-button|crm-template-field-label/);
  assert.match(business, /className="crm-settings-toolbar crm-settings-toolbar--actions crm-template-create-toolbar"/);
  assert.match(app, /className="crm-settings-toolbar crm-settings-toolbar--actions crm-account-add-toolbar"/);
  assert.match(business, /<Icon name="plus"/);
  assert.match(await read("src/icons.tsx"), /plus: <path d="M12 5v14M5 12h14"/);
  assert.match(css, /\.crm-template-list/);
  assert.match(css, /\.crm-template-list-card/);
  assert.match(css, /\.crm-template-detail-modal/);
  assert.match(css, /\.crm-template-list-actions\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.persona-compose-media-upload\.upload-zone/);
  assert.match(css, /\.persona-compose-media-upload \.account-pool-add-button\.persona-compose-media-upload-trigger/);
  assert.match(css, /\.crm-template-create-toolbar[^}]*width:\s*100%/s);
  assert.match(css, /\.crm-account-add-toolbar[^}]*width:\s*100%/s);
});

test("API adapter is same-origin, authenticated and preserves admin workspace", async () => {
  const api = await read("src/api.ts");
  assert.doesNotMatch(api, /localhost|127\.0\.0\.1|:8090|:8091|:3000/);
  assert.match(api, /credentials:\s*"include"/);
  assert.match(api, /X-Admin-Workspace-User-ID/);
  assert.match(api, /X-Admin-Console/);
  assert.match(api, /\/api\/crm\/v1\/bootstrap/);
  assert.match(api, /\/api\/persona_dashboard\/automation\/browser_sessions/);
});

test("blocked legacy capabilities cannot create fake write workflows", async () => {
  const app = await read("src/App.tsx");
  const types = await read("src/types.ts");
  assert.match(app, /direct_message_batch/);
  assert.match(app, /bootstrap\.capabilities/);
  assert.match(app, /writeViews\.has\(view\) && enabled/);
  assert.match(app, /const proposedActions = \[\{/);
  assert.match(app, /crmApi\.preflight/);
  assert.match(app, /preflight_token/);
  assert.match(app, /billing_reservation|sku, quantity: 1/);
  assert.match(types, /"equivalent" \| "adapted" \| "blocked"/);
});

test("task progress is polled from the API without simulated timers", async () => {
  const hook = await read("src/useTaskPolling.ts");
  const app = await read("src/App.tsx");
  const types = await read("src/types.ts");
  assert.match(hook, /document\.visibilityState === "visible" \? 8_000 : 20_000/);
  assert.match(hook, /Math\.min\(60_000/);
  assert.match(hook, /useLayoutEffect/);
  assert.match(hook, /seedPage\.has_more === false/);
  assert.match(app, /bootstrap\.task_page/);
  assert.match(types, /task_page\?: \{ next_cursor\?: string \| null; has_more\?: boolean \}/);
  assert.match(app, /messages\.noSimulatedProgress/);
  assert.doesNotMatch(app, /setInterval\([^)]*progress|fakeProgress|mockProgress/i);
});

test("CRM palette contains no rejected legacy green or gold tokens", async () => {
  const css = await read("src/styles.css");
  const rejected = ["#0a817f", "#77d8c3", "#087f72", "rgba(119, 216, 195", "rgba(35, 134, 111", "gold", "teal", "emerald", "lime"];
  for (const token of rejected) assert.equal(css.toLowerCase().includes(token.toLowerCase()), false, `rejected token: ${token}`);
  assert.match(css, /--crm-accent-strong:\s*var\(--public-cool-dark, #253746\)/);
  assert.match(css, /--crm-complete:\s*#356b91/);
});

test("both Chinese catalogs cover navigation and operational states", async () => {
  const i18n = await read("src/i18n.ts");
  assert.match(i18n, /"zh-Hans"/);
  assert.match(i18n, /"zh-Hant"/);
  for (const key of ["forbidden", "maintenance", "degraded", "needsLogin", "manualRequired", "unknown", "views"]) {
    assert.ok((i18n.match(new RegExp(`${key}:`, "g"))?.length || 0) >= 2, `${key} must exist in both catalogs`);
  }
});

test("cursor pages append without duplicates and polling preserves loaded history", () => {
  const first = [{ task_id: "new", status: "queued" }, { task_id: "old", status: "completed" }];
  const paged = mergeCursorPage(first, [{ task_id: "old", status: "completed" }, { task_id: "older", status: "completed" }]);
  assert.deepEqual(paged.map((item) => item.task_id), ["new", "old", "older"]);
  const refreshed = mergePolledItems(paged, [{ task_id: "new", status: "running" }]);
  assert.equal(refreshed.find((item) => item.task_id === "new").status, "running");
  assert.deepEqual(refreshed.map((item) => item.task_id), ["new", "old", "older"]);
});

test("task detail loading and pagination preserve historical provenance and safe fallbacks", async () => {
  const app = await read("src/App.tsx");
  const hook = await read("src/useTaskPolling.ts");
  const observer = await read("src/useIntersectionLoadMore.ts");
  const css = await read("src/styles.css");
  const i18n = await read("src/i18n.ts");

  assert.match(app, /function LegacyTaskTrace/);
  assert.match(app, /legacy_trace/);
  assert.match(app, /legacyImportedNotice/);
  assert.match(app, /original_status: "原始状态"/);
  assert.match(app, /run: "任务执行"/);
  assert.match(app, /target="_blank" rel="noreferrer noopener"/);
  assert.match(app, /detailState === "loading"/);
  assert.match(app, /evidenceError/);
  assert.match(app, /key=\{selectedTaskId\}/);
  assert.match(app, /useIntersectionLoadMore/);
  assert.match(observer, /IntersectionObserver/);
  assert.match(observer, /observer\.disconnect\(\)/);
  assert.match(app, /crm-task-load-sentinel/);
  assert.match(app, /loadMoreError/);
  assert.match(app, /selectedTaskId/);
  assert.match(app, /allowedHosts = \["threads\.com", "threads\.net", "instagram\.com"\]/);
  assert.match(app, /\(!legacyTrace \|\| detailSteps\.length > 0 \|\| detailActions\.length > 0\)/);
  assert.doesNotMatch(app, /\{hasMore && <div className="crm-pagination"><button[^>]+onClick=\{onLoadMore\}/);

  assert.match(hook, /loadMoreInFlight/);
  assert.match(hook, /payload\.has_more === false/);
  assert.match(hook, /next === requestedCursor/);
  assert.match(hook, /loadMoreError/);
  assert.match(css, /\.crm-task-load-sentinel/);
  assert.match(css, /\.crm-legacy-trace/);
  assert.match(i18n, /legacyImportedNotice/);
  assert.match(i18n, /allTasksLoaded/);
});

test("poll scheduler coalesces overlapping visibility refreshes", async () => {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const releases = [];
  const scheduler = createSinglePollScheduler({
    run: () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return new Promise((resolve) => releases.push(() => { active -= 1; resolve(); }));
    },
    getDelay: () => 1000,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const first = scheduler.trigger();
  void scheduler.trigger();
  void scheduler.trigger();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  releases.shift()();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.stop();
});

test("policy failures are fail-closed and unknown actions expose review API", async () => {
  assert.equal(isModulePolicyError({ status: 403, body: { code: "crm_module_unavailable" } }), true);
  assert.equal(isModulePolicyError({ status: 500 }), false);
  const api = await read("src/api.ts");
  const app = await read("src/App.tsx");
  assert.match(api, /actions\/\$\{encodeURIComponent\(actionId\)\}\/review/);
  assert.match(api, /state, evidence/);
  assert.match(app, /crmApi\.reviewAction/);
  assert.match(app, /action\.state === "unknown"/);
});

test("frontend document supplements are represented by accessible, persistent UI", async () => {
  const app = await read("src/App.tsx");
  const css = await read("src/styles.css");
  assert.match(app, /const navViews:/);
  assert.match(app, /crm-mobile-dock/);
  assert.match(css, /--crm-mobile-dock-height/);
  const motion = await read("src/segment-motion.ts");
  assert.match(css, /cubic-bezier\(\.2, \.72, \.2, 1\)/);
  assert.match(css, /is-segment-background-sliding/);
  assert.match(css, /--public-action-gradient/);
  assert.match(app, /applySegmentPill/);
  assert.match(app, /crm-compact-tabs-pill/);
  assert.match(app, /crm-nav-strip/);
  assert.match(motion, /translate3d\(\$\{direction \* 100\}%, 0, 0\)/);
  assert.match(motion, /max-width: 980px/);
  assert.match(app, /messages\.viewRecord/);
  assert.match(app, /crm-record-detail/);
  assert.match(app, /openInspect/);
  assert.match(css, /\.crm-view/);
  assert.match(css, /\.crm-chart-placeholder/);
  assert.match(css, /overflow-x:\s*clip/);
  assert.match(app, /crm-mobile-dock-track/);
  assert.match(app, /crm-mobile-dock-pill/);
  assert.match(app, /applyDockPill/);
  assert.match(css, /\.crm-mobile-dock-pill/);
  assert.match(css, /\.crm-compact-tabs-pill/);
  assert.match(css, /\.crm-account-card-platform/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /\.crm-mobile-dock button\.is-active \{[\s\S]*?background:\s*transparent;/);
  assert.match(app, /role="tablist"/);
  assert.match(app, /role="tab"/);
  assert.match(app, /aria-selected=/);
  assert.match(app, /crm-record-toolbar/);
  assert.match(app, /crm-evidence-timeline/);
  assert.match(app, /managed_by_admin/);
  assert.doesNotMatch(app, /crm-banner--login/);
  assert.doesNotMatch(app, /crm-task-strip/);
  assert.match(app, /from "\.\/present"/);
  assert.match(app, /crm-chart-grid/);
  assert.match(app, /taskTitle\(/);
  assert.doesNotMatch(app, /task\.title \|\| task\.name \|\| task\.kind \|\| task\.task_id/);
  assert.match(css, /\.crm-donut/);
  assert.match(css, /\.crm-line-chart/);
  assert.match(css, /\.crm-mix-bar/);
  assert.match(css, /\.crm-member-grid/);
  assert.match(app, /applySegmentPill/);
  assert.match(app, /crm-account-card-platform/);
  assert.match(app, /crm-account-platforms/);
  assert.doesNotMatch(app, /data-account-platform="all"/);
  assert.match(app, /consoleOpenLoginHref/);
  assert.match(app, /confirmOpenConsoleLogin/);
  assert.doesNotMatch(app, /AiSettingsView/);
  assert.match(app, /collectTabs: ViewId\[\] = \["collect", "pools"\]/);
  assert.match(app, /if \(value === "ai"\) return "collect"/);
  assert.match(app, /settingTabs/);
  assert.match(app, /onCollectMode/);
  assert.match(app, /crm-account-card-action--login/);
  assert.match(app, /rotation\?\.locked/);
  assert.match(app, /!needsLogin/);
  assert.match(app, /open_login/);
  assert.match(app, /\/console.html/);
  assert.doesNotMatch(app, /verifyLogin/);
  assert.doesNotMatch(app, /crm-live-browser/);
  const api = await read("src/api.ts");
  assert.doesNotMatch(api, /crm-open-login:/);
  assert.doesNotMatch(api, /account_check/);
  assert.match(css, /\.crm-account-platforms/);
  assert.match(css, /body\.crm-page \.crm-account-card-action--login/);
  assert.match(app, /navigate\(next, \{ direction, panel: true \}\)/);
  assert.match(app, /className="crm-view"/);
  assert.match(app, /className="crm-panel-strip"/);
  assert.match(app, /className="crm-nav-strip"/);
  assert.match(app, /inspectDetailRows/);
  assert.match(css, /\.crm-nav-strip/);
  assert.match(css, /\.crm-panel-clip/);
  assert.match(css, /\.crm-panel-strip/);
  assert.match(app, /account-status-icon/);
  assert.match(app, /AccountStatusChip/);
  assert.match(css, /\.status\.ready/);
  assert.match(css, /\.account-status-icon/);
  assert.match(app, /cancelTaskConfirm/);
  assert.match(app, /role="progressbar"/);
  assert.match(css, /--crm-sidebar-width:\s*188px/);
  assert.match(css, /@media \(max-width: 980px\)/);
  assert.doesNotMatch(css, /font-size:\s*(?:9|10|11)px|font:\s*(?:9|10|11)px/);
  const confirm = await read("src/confirm-dialog.tsx");
  const business = await read("src/BusinessViews.tsx");
  assert.doesNotMatch(business, /export function AiSettingsView/);
  assert.match(business, /crm-collect-modes/);
  assert.match(css, /\.crm-collect-modes\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.doesNotMatch(css, /\.crm-collect-modes\s*\{[^}]*repeat\(3,/s);
  assert.match(business, /crm-template-media/);
  assert.match(business, /crmApi\.mediaContent/);
  assert.match(api, /mediaContent:/);
  assert.match(api, /requestBlob/);
  assert.match(css, /\.crm-template-thumb/);
  const wizard = await read("src/WorkflowWizard.tsx");
  assert.match(wizard, /crmApi\.analyzeDemand/);
  const present = await read("src/present.ts");
  assert.match(confirm, /createPortal/);
  assert.match(confirm, /className="console-modal"/);
  assert.match(confirm, /onCloseRef\.current = onClose/);
  assert.doesNotMatch(confirm, /}, \[onClose\]\);/);
  assert.match(wizard, /onCloseRef\.current = onClose/);
  assert.doesNotMatch(wizard, /}, \[onClose, view\]\);/);
  assert.doesNotMatch(app, /}, \[onClose, view\]\);/);
  assert.match(app, /requestConfirm/);
  assert.match(app, /ConfirmHost/);
  assert.doesNotMatch(app, /window\.confirm/);
  assert.doesNotMatch(business, /window\.confirm/);
  assert.match(css, /\.console-modal \{/);
  assert.match(css, /place-items:\s*center/);
  assert.match(css, /\.crm-nav-page\[aria-hidden="true"\]/);
  assert.match(css, /\.crm-member-grid/);
  assert.match(css, /\.crm-member-tag/);
  assert.match(css, /--status-success-bg/);
  assert.match(business, /crm-member-card/);
  assert.match(business, /crm-member-tag/);
  assert.match(business, /crm-member-portrait/);
  assert.match(business, /crm-member-detail-section/);
  assert.match(business, /crm-member-detail-block/);
  assert.match(business, /detailIdentity/);
  assert.match(app, /clearPageScrollLock/);
  assert.match(css, /overflow-x:\s*clip/);
  assert.match(business, /localizeMemberKey/);
  assert.match(business, /isInternalTagKey/);
  assert.match(business, /isOpaqueUserValue/);
  assert.match(present, /platform_user_key/);
  assert.match(present, /isEnglishMachineLabel/);
  assert.match(business, /crm-member-platforms/);
  assert.match(business, /platformFilter/);
  assert.match(business, /memberPreview\(/);
  assert.match(business, /viewMember/);
  assert.match(business, /memberDetail/);
  assert.match(business, /setInspecting/);
  assert.match(business, /crm-pool-toolbar/);
  assert.match(business, /setEditOpen\(true\)/);
  assert.match(business, /title=\{t\.editPool\}/);
  assert.match(business, /crm-pool-launch/);
  assert.doesNotMatch(business, /createTask/);
  assert.match(business, /choosePool/);
  assert.match(business, /pickPool/);
  assert.doesNotMatch(business, /crm-opc-history/);
  assert.doesNotMatch(business, /opcHistory/);
  assert.doesNotMatch(business, /<details className="crm-pool-settings"/);
  assert.match(app, /CollectionView language=\{language\} onCollectMode=/);
  assert.match(app, /PoolsView language=\{language\} onEngage=/);
  assert.doesNotMatch(app, /PoolsView language=\{language\} onCollectMode=/);
  assert.match(app, /CompactTabs items=\{collectTabs\}/);
  assert.match(app, /SubpageStrip items=\{collectTabs\}/);
  assert.doesNotMatch(app, /PoolsView language=\{language\} onCreate=/);
  assert.match(app, /settingTabs: ViewId\[\] = \["accounts", "templates", "schedules"\]/);
  assert.match(app, /if \(value === "destinations" \|\| value === "ai-config"\) return "accounts"/);
  assert.doesNotMatch(business, /export function DestinationsView/);
  assert.doesNotMatch(api, /\/api\/admin\/runtime_config/);
  assert.doesNotMatch(api, /saveAiSettings/);
  assert.match(app, /engageTabs: ViewId\[\] = \["public", "outreach", "groups"\]/);
  assert.doesNotMatch(app, /taskTabs:/);
  assert.doesNotMatch(app, /<AnalyticsView/);
  assert.match(app, /crm-task-overview-grid/);
  assert.doesNotMatch(app, /crm-task-detail-page/);
  assert.match(app, /<ConsoleModal title=\{messages\.taskDetailTitle\}/);
  assert.match(app, /<TaskCard task=\{selectedTask\}[\s\S]*?detailMode/);
  assert.match(app, /taskFilterGroup/);
  assert.match(app, /taskSortCreated/);
  assert.match(app, /triggerIcon="filter"/);
  assert.match(app, /triggerIcon="sort"/);
  assert.match(app, /crm-task-section-toolbar/);
  assert.match(app, /crm-task-card-progress-cell/);
  assert.match(app, /className="unified-action-icon-button" title=\{messages\.inspectTask\}/);
  assert.match(app, /onOpen=\{\(\) => openTask/);
  assert.doesNotMatch(app, /window\.scrollTo\(\{ top: 0, behavior: "auto" \}\)/);
  assert.match(app, /onClick=\{openFromCard\}/);
  assert.match(app, /event\.target instanceof Element && event\.target\.closest\("button, a, input, textarea, select"\)/);
  assert.doesNotMatch(app, /crm-analytics-fold/);
  assert.match(app, /SelectMenu/);
  assert.match(wizard, /SelectMenu/);
  assert.match(business, /SelectMenu/);
  assert.match(css, /\.crm-select-panel/);
  assert.match(css, /\.crm-select--icon/);
  assert.match(css, /\.crm-task-overview-grid \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(css, /\.crm-task-overview-grid \{ grid-template-columns: repeat\(2,/);
  assert.match(css, /\.crm-task-card \{[\s\S]*?grid-template-columns: minmax\(0, 1\.35fr\) minmax\(72px, \.45fr\) auto/);
  assert.match(css, /-webkit-line-clamp:\s*2/);
  assert.doesNotMatch(business, /<select value=\{poolId\}/);
  assert.match(app, /startWorkflow\(workflow, \{ execution: "schedule" \}\)/);
  assert.match(app, /messages\.dualPlatform/);
  assert.match(business, /\["collect", "public", "outreach", "groups"\]/);
  assert.match(wizard, /collectExecution|data-collect-execution/);
  assert.match(wizard, /execution === "schedule"/);
  const icons = await read("src/icons.tsx");
  const selectMenu = await read("src/select-menu.tsx");
  assert.match(icons, /filter: <path d="M4 5h16/);
  assert.match(icons, /sort: <>/);
  assert.match(selectMenu, /const menuWidth = triggerIcon[\s\S]*?Math\.min\(240, window\.innerWidth - 16\)[\s\S]*?: Math\.min\(rect\.width, window\.innerWidth - 16\)/);
  assert.match(selectMenu, /const left = triggerIcon[\s\S]*?rect\.right - menuWidth[\s\S]*?: Math\.max\(8, Math\.min\(rect\.left/);
  assert.match(icons, /"back"/);
  assert.match(icons, /m15 19-7-7 7-7/);
  assert.match(confirm, /onBack\?: \(\) => void/);
  assert.match(confirm, /name="back"/);
  assert.match(confirm, /unified-action-icon-button/);
  assert.match(wizard, /onBack=\{step > 1 \? goBack : undefined\}/);
  assert.doesNotMatch(wizard, /t\.switchMode/);
  assert.match(wizard, /platformHint\(collectPlatformNames\)/);
  assert.match(wizard, /days === 1 \? "今天" : `近\$\{days\}天`/);
  assert.match(css, /:is\(\.crm-account-platforms, \.crm-member-platforms, \.crm-platform-fieldset\)/);
  assert.match(css, /crm-platform-fieldset\) button\[data-account-platform="instagram"\]\.is-active/);
  assert.match(css, /crm-platform-fieldset\) button\[data-account-platform="threads"\]\.is-active/);
  assert.doesNotMatch(css, /\.crm-wizard-assistant \{[^}]*border-left:\s*3px/);
  assert.doesNotMatch(css, /\.crm-wizard-progress > span \{ display: none/);
  assert.match(css, /\.crm-wizard-hint/);
  assert.match(app, /if \(value === "relationships"\) return "outreach"/);
  assert.doesNotMatch(app, /<AiSettingsView/);
  assert.doesNotMatch(business, /tags\.map\(\(tag\) => <span className="crm-chip"/);
});

test("each executable workflow view has an explicit action mapping", async () => {
  const app = await read("src/App.tsx");
  assert.match(app, /outreach:\s*\{\s*actionType:\s*"direct_message"/);
  assert.match(app, /groups:\s*\{\s*actionType:\s*"threads_group_invite_post"/);
  assert.doesNotMatch(app, /view === "collect"[^;]+threads_group_invite_post/);
});

test("dedicated CRM business views use real REST contracts", async () => {
  const app = await read("src/App.tsx");
  const api = await read("src/api.ts");
  const views = await read("src/BusinessViews.tsx");
  const wizard = await read("src/WorkflowWizard.tsx");
  for (const component of ["CollectionView", "PoolsView", "TemplatesView", "SchedulesView", "StructuredEvidence", "PublicEngageView"]) {
    assert.match(app, new RegExp(component));
    assert.match(views, new RegExp(`function ${component}`));
  }
  assert.match(views, /function AnalyticsView/);
  assert.match(api, /comments\/progress/);
  assert.match(app, /onEngage=/);
  assert.match(wizard, /WorkflowSeed/);
  assert.match(api, /pools\/\$\{encodeURIComponent\(poolId\)\}\/members/);
  assert.match(api, /method: "PATCH"/);
  assert.match(api, /\/api\/crm\/v1\/media/);
  assert.match(api, /schedules\/\$\{encodeURIComponent\(scheduleId\)\}\/run/);
  assert.match(api, /\/api\/crm\/v1\/analytics/);
  assert.match(api, /tasks\/\$\{encodeURIComponent\(taskId\)\}\/evidence/);
  assert.doesNotMatch(views, /mock|fakeProgress|setInterval/);
});

test("business views preserve bilingual, responsive, no-green UI", async () => {
  const views = await read("src/BusinessViews.tsx");
  const css = await read("src/styles.css");
  assert.match(views, /"zh-Hans"/);
  assert.match(views, /"zh-Hant"/);
  assert.match(css, /\.crm-split-workspace/);
  assert.match(css, /\.crm-data-table/);
  assert.match(css, /\.crm-structured-evidence/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(`${views}\n${css}`, /teal|emerald|lime|#0a817f|#77d8c3/i);
  assert.match(views, /poolInsightCards/);
  assert.match(views, /function MixBar/);
  assert.doesNotMatch(views, /Object\.entries\(snapshot\)/);
  assert.doesNotMatch(views, /content_hash/);
  assert.doesNotMatch(views, /JSON\.stringify\(evidence/);
  const present = await read("src/present.ts");
  assert.match(present, /export function isTechnicalId/);
  assert.match(present, /export function cronFriendly/);
  assert.match(present, /export function poolInsightCards/);
  assert.match(present, /export function mixParts/);
  assert.match(present, /export function eventPreviewLabel/);
  assert.match(present, /public_comment_reply_monitor_started/);
  assert.match(present, /export function localizeStoredTitle/);
  assert.match(present, /历史每日采集/);
  assert.match(present, /\^login\\s\+@/);
  assert.match(css, /\.crm-task-card \{[\s\S]*?min-height:\s*54px/);
  assert.match(css, /body\.crm-page \.row-actions button[\s\S]*?min-height:\s*32px/);
  assert.match(css, /body\.crm-page \.unified-action-icon-button/);
  assert.match(css, /\.task-status-text \{/);
  assert.match(css, /\.crm-compact-tabs button \{[\s\S]*?min-height:\s*30px/);
});

test("public engagement removes opaque exclusion copy and renders selectable tags as restrained static gradients", async () => {
  const views = await read("src/BusinessViews.tsx");
  const css = await read("src/styles.css");
  assert.doesNotMatch(views, /为什么不是全部名单|為什麼不是全部名單|重复原文|重複原文/);
  assert.doesNotMatch(views, /whyParts|exclusionEntries/);
  assert.match(views, /aria-pressed=\{active\}/);
  assert.match(css, /\.crm-engage-tags \.crm-chip-row button \{[\s\S]*?--crm-tag-idle-gradient:/);
  assert.match(css, /--crm-tag-selected-gradient:/);
  assert.match(css, /var\(--vecto-action-static-gradient/);
  assert.match(css, /\.crm-engage-tags \.crm-chip-row button \{[\s\S]*?background-image:\s*var\(--crm-tag-idle-gradient\)/);
  assert.match(css, /\.crm-engage-tags \.crm-chip-row button\.is-active \{[\s\S]*?background-image:\s*var\(--crm-tag-selected-gradient\)/);
  assert.match(css, /--crm-tag-idle-gradient:\s*linear-gradient\(112deg,\s*#f5f7f8/);
  assert.doesNotMatch(css, /crmEngageTagFlow|--vecto-action-running-gradient/);
  assert.match(views, /const poolTagCategoryOrder/);
  assert.match(views, /function groupPoolTagOptions/);
  assert.match(views, /split\(\/\[:：\]\//);
  assert.match(views, /crm-engage-tag-group/);
  assert.match(views, /tagGroups\.map/);
  assert.match(css, /\.crm-engage-tag-groups/);
  assert.match(css, /\.crm-engage-tag-group-head/);
});

test("workflow wizard preserves the legacy prepare-review-confirm operation order", async () => {
  const wizard = await read("src/WorkflowWizard.tsx");
  const api = await read("src/api.ts");
  for (const operation of ["collectSteps", "engageSteps", "prepareCollection", "preparePublicDrafts", "preflight", "consent"]) {
    assert.match(wizard, new RegExp(operation));
  }
  assert.match(wizard, /selectedLeadIds/);
  assert.match(wizard, /const seededPool = seed\?\.poolId === poolId/);
  assert.match(wizard, /setStep\(view === "public" && seed\?\.poolId \? 2 : 1\)/);
  assert.match(wizard, /crm-wizard-seed-summary/);
  assert.match(wizard, /instagram_group_create/);
  assert.match(wizard, /run_once:\s*!daily/);
  assert.match(api, /\/api\/crm\/v1\/comments\/drafts/);
  assert.match(api, /\/api\/crm\/v1\/hotspots\/search/);
  assert.doesNotMatch(wizard, /fakeProgress|simulated|setInterval/i);
});

test("workflow customer counter separates checked customers from the final execution cap", async () => {
  const wizard = await read("src/WorkflowWizard.tsx");

  assert.match(wizard, /selected:\s*\(count: number\)\s*=>\s*`已选择 \$\{count\} 位客户`/);
  assert.match(wizard, /executing:\s*\(count: number\)\s*=>\s*`实际执行 \$\{count\} 位客户`/);
  assert.match(wizard, /t\.selected\(selectedMembers\.length\)/);
  assert.doesNotMatch(wizard, /t\.selected\(effectiveRecipients\.length\)/);
  assert.match(wizard, /t\.executing\(effectiveRecipients\.length\)/);
});

test("collection wizard keeps the form stable while bootstrap resources load", async () => {
  const wizard = await read("src/WorkflowWizard.tsx");

  assert.match(wizard, /className="crm-wizard-body" aria-busy=\{busy === "load"\}/);
  assert.match(wizard, /busy === "load" && view !== "collect"/);
  assert.doesNotMatch(wizard, /\{busy === "load" && <p className="crm-quiet-empty">/);
});

test("collection modes use larger inputs, concise guidance and the shared platform states", async () => {
  const wizard = await read("src/WorkflowWizard.tsx");
  const css = await read("src/styles.css");

  assert.match(wizard, /className="crm-field crm-field--wide crm-collect-primary-input"/);
  assert.match(css, /\.crm-wizard-body \.crm-collect-primary-input textarea\s*\{[^}]*min-height:\s*112px/s);
  assert.match(css, /\.crm-collect-form \.crm-field input\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /:is\(\.crm-account-platforms, \.crm-member-platforms, \.crm-platform-fieldset\)/);
  assert.match(css, /\.crm-platform-fieldset[^\n]*button\[data-account-platform="instagram"\]\.is-active[\s\S]*?var\(--instagram-platform-gradient\)/);
  assert.match(css, /\.crm-platform-fieldset[^\n]*button\[data-account-platform="threads"\]\.is-active[\s\S]*?background:\s*#000/);
  assert.doesNotMatch(wizard, /只会在该平台采集，不会跨平台混标|沒有可驗證時間的資料不會混入結果|没有可验证时间的资料不会混入结果/);
  assert.match(wizard, /系统根据链接自动识别平台|系統根據連結自動識別平台/);
});

test("write workflows expose server preflight results before second confirmation", async () => {
  const wizard = await read("src/WorkflowWizard.tsx");
  const api = await read("src/api.ts");
  for (const field of ["allowed_count", "duplicate_count", "blocked_count", "total_points", "decisions", "expires_at"]) {
    assert.match(`${wizard}\n${api}`, new RegExp(field));
  }
  assert.match(wizard, /!preflightResult[\s\S]+crmApi\.preflight/);
  assert.match(wizard, /preflightResult[\s\S]+crm-consent/);
  assert.match(wizard, /confirmAfterPreflight/);
  assert.match(wizard, /preflight_token:\s*preflightResult\?\.preflight_token/);
});

test("schedule creation and manual runs preserve complete actions and fresh approval", async () => {
  const wizard = await read("src/WorkflowWizard.tsx");
  const views = await read("src/BusinessViews.tsx");
  const api = await read("src/api.ts");
  assert.match(wizard, /payload:\s*\{\s*run_once:\s*!daily,[\s\S]+actions:\s*executableActions/);
  assert.match(wizard, /account_id:\s*accountId/);
  assert.doesNotMatch(views, /createResource\("schedules",\s*\{[\s\S]{0,180}payload:\s*\{\s*\}/);
  assert.match(views, /const preflight = await crmApi\.preflight/);
  assert.match(views, /crmApi\.runSchedule\(id,\s*\{\s*confirmed:\s*true,\s*preflight_token:/);
  assert.match(api, /stopSchedule/);
});

test("pool maintenance and takeover recovery keep the collection flow focused", async () => {
  const app = await read("src/App.tsx");
  const views = await read("src/BusinessViews.tsx");
  const api = await read("src/api.ts");
  const css = await read("src/styles.css");
  assert.doesNotMatch(views, /crmApi\.(queryOpcHistory|importOpcHistory)/);
  assert.doesNotMatch(views, /OPC (历史|歷史)客户/);
  assert.match(app, /collectTabs: ViewId\[\] = \["collect", "pools"\]/);
  assert.match(views, /export function CollectionView/);
  assert.match(views, /export function PoolsView\(\{ language, onEngage \}/);
  assert.match(views, /onEngage\(selectedId\)/);
  assert.match(views, /initialPoolId/);
  assert.match(views, /POOL_NAME_MAX_LENGTH = 32/);
  assert.match(views, /maxLength=\{POOL_NAME_MAX_LENGTH\}/);
  assert.match(views, /poolNameLabel\(fullName, id\)/);
  assert.match(views, /function memberProfileUrl/);
  assert.match(views, /https:\/\/www\.threads\.com\/@\$\{encodeURIComponent\(handle\)\}/);
  assert.match(views, /target="_blank" rel="noreferrer noopener"/);
  assert.match(views, /const verifiedMembers = members\.filter/);
  assert.match(css, /\.crm-pool-list > button strong[\s\S]*white-space: nowrap/);
  assert.match(css, /\.crm-member-profile-link/);
  assert.match(views, /crmApi\.updateResource\("pools"/);
  assert.match(views, /crmApi\.deduplicatePoolMembers/);
  assert.match(views, /publicToast\(t\.poolSaved\)/);
  assert.match(views, /className="crm-pool-toolbar"[\s\S]*?t\.choosePool[\s\S]*?t\.editPool/);
  assert.doesNotMatch(views, /className="crm-pool-settings"/);
  assert.match(views, /fitPoolTags/);
  assert.match(views, /ref=\{fitPoolTags\}/);
  assert.match(css, /\.crm-pool-toolbar \{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.crm-pool-editor textarea \{[\s\S]*?overflow-y:\s*hidden/);
  assert.match(views, /poolSaved:\s*"客户池已保存"/);
  assert.match(views, /crm-panel-title-row/);
  assert.match(views, /unified-action-icon-button[\s\S]*Icon name="refresh"/);
  assert.match(css, /\.crm-panel-title-row/);
  assert.match(css, /\.crm-inline-actions \.crm-primary-button/);
  for (const state of ["pending_login", "needs_login", "need_verification", "cookie_expired"]) assert.match(app, new RegExp(state));
  assert.match(app, /confirmOpenConsoleLogin/);
  assert.match(app, /crmApi\.taskAction\(id,\s*"reconcile"\)/);
});

test("task data restores the real OPC history pool beside live tasks without returning it to the pool toolbar", async () => {
  const app = await read("src/App.tsx");
  const views = await read("src/BusinessViews.tsx");
  const api = await read("src/api.ts");
  const css = await read("src/styles.css");

  assert.match(app, /type TaskDataMode = "live" \| "history"/);
  assert.match(app, /messages\.realTimeTasks/);
  assert.match(app, /OPC (历史池|歷史池)/);
  assert.match(app, /<OpcHistoryView/);
  assert.match(app, /crmApi\.opcHistorySummary/);
  assert.match(app, /crmApi\.queryOpcHistory/);
  assert.match(app, /crmApi\.importOpcHistory/);
  assert.match(app, /idempotencyKey: `crm-opc-import:\$\{window\.crypto\.randomUUID\(\)\}`/);
  assert.match(api, /\/api\/crm\/v1\/opc\/history\/summary/);
  assert.match(api, /\/api\/crm\/v1\/opc\/history\/query/);
  assert.match(api, /\/api\/crm\/v1\/opc\/history\/import/);
  assert.doesNotMatch(views, /crmApi\.(queryOpcHistory|importOpcHistory)/);
  assert.doesNotMatch(views, /OPC (历史|歷史)客户/);
  assert.match(css, /\.crm-task-data-tabs/);
  assert.match(css, /\.crm-opc-history-center/);
});

test("legacy public follow-up and Instagram group management are reachable from the UI", async () => {
  const app = await read("src/App.tsx");
  const wizard = await read("src/WorkflowWizard.tsx");
  const views = await read("src/BusinessViews.tsx");
  for (const action of ["public_comment", "public_reply", "followup_reply", "nurture_reply"]) {
    assert.match(wizard, new RegExp(action));
  }
  assert.match(wizard, /action_type:\s*publicAction/);
  assert.match(app, /<GroupsView/);
  for (const action of ["instagram_group_post", "instagram_group_settings_update", "instagram_group_members_add", "instagram_group_members_inspect", "instagram_group_status_inspect"]) {
    assert.match(views, new RegExp(action));
  }
  assert.match(views, /crmApi\.preflight/);
  assert.match(views, /preflight_token:\s*preflight\.preflight_token/);
  assert.match(views, /selectedInstagramAccountId/);
  assert.match(views, /t\.executionAccount/);
});

test("outreach and group records share one compact filter popover without exposing relationship internals", async () => {
  const app = await read("src/App.tsx");
  const wizard = await read("src/WorkflowWizard.tsx");
  const views = await read("src/BusinessViews.tsx");
  const selectMenu = await read("src/select-menu.tsx");
  const present = await read("src/present.ts");
  const css = await read("src/styles.css");

  assert.match(app, /engageTabs: ViewId\[\] = \["public", "outreach", "groups"\]/);
  assert.match(app, /if \(value === "relationships"\) return "outreach"/);
  assert.doesNotMatch(app, /<ResourceList view="relationships"/);
  assert.doesNotMatch(wizard, /WizardView[^\n]+"relationships"/);
  assert.match(wizard, /verifyOutreachRelationships/);
  assert.match(wizard, /crmApi\.verifyRelationships/);
  assert.match(wizard, /relationshipTaskId/);
  assert.doesNotMatch(wizard, /relationshipQueued\} · \{relationshipTaskId/);

  assert.match(selectMenu, /export function FilterMenu/);
  assert.match(selectMenu, /<Icon name="filter"/);
  assert.match(app, /<FilterMenu[^>]+triggerLabel=\{messages\.filterRecords\}/);
  assert.doesNotMatch(app, /<div className="crm-filter-bar"/);
  assert.match(app, /if \(!type\) return false/);
  assert.doesNotMatch(app, /\|\| !type/);

  assert.match(views, /<FilterMenu[^>]+triggerLabel=\{t\.filterGroups\}/);
  assert.match(views, /groupQuery/);
  assert.match(views, /groupPlatformFilter/);
  assert.match(views, /groupStatusFilter/);
  assert.match(views, /visibleGroups\.map/);
  assert.match(views, /crm-group-account-picker/);
  assert.match(views, /instagramGroupsExist/);
  assert.match(views, /instagramEnabled && instagramGroupsExist/);
  assert.match(views, /暂无已验证 Instagram Direct 群组/);
  assert.match(views, /function businessAccountReady/);
  assert.match(views, /account\.needs_login/);
  assert.match(views, /cookie_expired/);
  assert.match(views, /need_verification/);

  assert.match(wizard, /memberPlatform\(row\) === groupMode/);
  assert.match(wizard, /setGroupMode\("instagram"\); setSelected\(new Set\(\)\)/);
  assert.match(present, /relationshipStatusLabel/);
  assert.match(present, /follows_sender/);
  assert.match(present, /mutual/);
  assert.match(present, /none: \["双方未建立关注关系", "雙方未建立關注關係"\]/);
  assert.doesNotMatch(app, /Object\.entries\(payload\)/);
  assert.match(css, /\.crm-filter-menu-panel/);
});

test("engagement pages rely on the shared tab labels without duplicate headings or decorative refresh controls", async () => {
  const app = await read("src/App.tsx");
  const views = await read("src/BusinessViews.tsx");
  const css = await read("src/styles.css");

  assert.doesNotMatch(views, /<PageHeader title=\{t\.title\}/);
  assert.doesNotMatch(views, /<PageHeader title=\{t\.groups\}/);
  assert.match(app, /view === "outreach"[\s\S]*?className="crm-engage-toolbar"[\s\S]*?: <div className="crm-panel-head"/);
  assert.match(views, /className="crm-engage-toolbar"[\s\S]*?t\.newGroup/);
  assert.match(css, /\.crm-engage-toolbar/);
  assert.match(app, /crm-inline-error[\s\S]*?Icon name="refresh"[\s\S]*?messages\.retry/);
  assert.match(views, /function ErrorBox[\s\S]*?Icon name="refresh"[\s\S]*?labels\[language\]\.retry/);
});

test("streamlined CRM keeps the user-visible core flow without unsafe legacy controls", async () => {
  const app = await read("src/App.tsx");
  const wizard = await read("src/WorkflowWizard.tsx");
  const views = await read("src/BusinessViews.tsx");
  const css = await read("src/styles.css");
  assert.match(wizard, /trustFirstTitle/);
  assert.match(wizard, /trust_first:\s*true/);
  assert.match(wizard, /question_hook/);
  assert.match(wizard, /offer_hook/);
  assert.match(wizard, /group_invite/);
  assert.match(wizard, /scheduleCadence === "daily"/);
  assert.match(wizard, /schedule_cadence:\s*daily \? "daily" : "once"/);
  assert.doesNotMatch(wizard, /destination_id:\s*destinationId/);
  assert.doesNotMatch(views, /runMode|一键连续分批|一鍵連續分批/);
  assert.match(app, /followup\.kind/);
  assert.match(app, /nurture_reply/);
  assert.match(app, /visibleTasks/);
  assert.match(css, /\.crm-wizard-policy-card/);
  assert.match(css, /\.crm-strategy-cards/);
  assert.match(wizard, /collectInput\?: string/);
  assert.doesNotMatch(views, /aiContinue|带入采集设置|帶入採集設定/);
  assert.match(wizard, /hasPersonaAnalysis/);
  for (const field of ["targetPersona", "customerIntent", "mainNeed", "painPoint", "segments", "scenarios"]) assert.match(wizard, new RegExp(field));
  assert.match(wizard, /analysisGroups/);
  assert.match(wizard, /collectSteps:\s*\["填写设置", "确认启动"\]/);
  assert.match(wizard, /view === "collect" \? 2/);
  assert.doesNotMatch(wizard, /crm-wizard-choices|crm-wizard-choice/);
  assert.doesNotMatch(css, /\.crm-wizard-choices|\.crm-wizard-choice/);
  assert.doesNotMatch(views, /服务器分析可用|伺服器分析可用|未配置模型时使用本机规则备援|未配置模型時使用本機規則備援/);
});

test("CRM action feedback reuses the console public top status-card template", async () => {
  const app = await read("src/App.tsx");
  const views = await read("src/BusinessViews.tsx");
  const toast = await read("src/public-toast.tsx");
  const css = await read("src/styles.css");

  assert.match(app, /<PublicToastHost\s*\/>/);
  assert.match(app, /publicToast\(messages\.submitted,\s*\{\s*status:\s*"queued"/);
  assert.match(views, /publicToast\(t\.poolSaved/);
  assert.match(views, /publicToast\(t\.uploaded/);
  assert.match(views, /publicToast\(t\.taskCreated,\s*\{\s*status:\s*"queued"/);
  assert.match(toast, /id="toastHost" className="toast-host"/);
  assert.match(toast, /className="toast-message-status-icon"/);
  assert.match(toast, /className="toast-message-close"/);
  assert.match(toast, /PUBLIC_TOAST_DURATION = 5_000/);
  assert.match(css, /\.toast-host\s*\{[^}]*right:\s*16px;[^}]*top:\s*max\(16px, env\(safe-area-inset-top\)\)/s);
  assert.match(css, /\.toast-message\s*\{[^}]*grid-template-columns:\s*24px minmax\(0, 1fr\) 28px;[^}]*min-height:\s*56px/s);
  assert.doesNotMatch(app, /crm-toast|setToast\(/);
  assert.doesNotMatch(views, /crm-success-note[^\n]*notice|setNotice\(/);
  assert.doesNotMatch(css, /\.crm-toast\s*\{|@keyframes crm-toast/);
});

test("workflow template selection clears stale content and renders visual preview cards", async () => {
  const wizard = await read("src/WorkflowWizard.tsx");
  const selectMenu = await read("src/select-menu.tsx");

  assert.match(wizard, /setContent\(template \? String\(template\.content \|\| ""\) : ""\)/);
  assert.match(wizard, /templatePreviewUrls/);
  assert.match(wizard, /previewImageUrl:\s*templatePreviewUrls\[mediaIds\[0\]\]/);
  assert.match(wizard, /previewCard:\s*true/);
  assert.match(wizard, /plain:\s*true/);
  assert.doesNotMatch(wizard, /previewText:/);
  assert.match(selectMenu, /crm-select-option--plain/);
  assert.match(wizard, /选择客户，填写私信，再选择执行方式。/);
  assert.doesNotMatch(wizard, /先选客户、再绑定模板，最后选择样本、批次或排程/);
});
