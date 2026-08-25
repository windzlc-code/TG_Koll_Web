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
  assert.match(app, /className="crm-chart-grid"/);
  assert.match(app, /DonutChart/);
  assert.match(app, /LineChart/);
  assert.match(charts, /conic-gradient/);
  assert.match(charts, /crm-line-chart/);
  assert.match(charts, /crm-chart-placeholder/);
  assert.match(charts, /persona-chart-placeholder-line|M8 60 L54 44/);
  assert.doesNotMatch(app, /className="crm-action-grid"/);
  assert.doesNotMatch(app, /crm-priority-panel/);
  assert.doesNotMatch(app, /crm-flow-board/);
  assert.match(i18n, /pipelineCollect: "发现客户"/);
  assert.match(i18n, /navItems: \{ overview: "总览"/);
});

test("CRM exposes the twelve required work views", async () => {
  const app = await read("src/App.tsx");
  const expected = ["overview", "collect", "pools", "public", "outreach", "groups", "relationships", "tasks", "schedules", "templates", "accounts", "settings"];
  for (const view of expected) assert.match(app, new RegExp(`"${view}"`));
  assert.match(app, /window\.location\.hash/);
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
  assert.match(hook, /document\.visibilityState === "visible" \? 8_000 : 20_000/);
  assert.match(hook, /Math\.min\(60_000/);
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
  assert.match(app, /animatePageSlide/);
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
  assert.match(app, /crm-filter-bar/);
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
  assert.match(app, /crm-account-track/);
  assert.match(app, /loginAssistant/);
  assert.match(css, /\.crm-account-platforms/);
  assert.match(css, /\.crm-account-track/);
  assert.match(css, /body\.crm-page \.crm-account-card-action--login/);
  assert.match(app, /navigate\(next, \{ direction, panel: true \}\)/);
  assert.match(app, /className="crm-view"/);
  assert.match(app, /className="crm-panel-strip"/);
  assert.match(app, /if \(panel\) return/);
  assert.match(app, /animatePageSlide\(viewStage\.current/);
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
  for (const component of ["PoolsView", "TemplatesView", "SchedulesView", "AnalyticsView", "StructuredEvidence"]) {
    assert.match(app, new RegExp(component));
    assert.match(views, new RegExp(`function ${component}`));
  }
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
});

test("workflow wizard preserves the legacy prepare-review-confirm operation order", async () => {
  const wizard = await read("src/WorkflowWizard.tsx");
  const api = await read("src/api.ts");
  for (const operation of ["collectSteps", "engageSteps", "relationSteps", "prepareCollection", "preparePublicDrafts", "preflight", "consent"]) {
    assert.match(wizard, new RegExp(operation));
  }
  assert.match(wizard, /selectedLeadIds/);
  assert.match(wizard, /instagram_group_create/);
  assert.match(wizard, /run_once:\s*true/);
  assert.match(api, /\/api\/crm\/v1\/comments\/drafts/);
  assert.match(api, /\/api\/crm\/v1\/hotspots\/search/);
  assert.doesNotMatch(wizard, /fakeProgress|simulated|setInterval/i);
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
  assert.match(wizard, /payload:\s*\{\s*run_once:\s*true,[\s\S]+actions:\s*executableActions/);
  assert.match(wizard, /account_id:\s*accountId/);
  assert.doesNotMatch(views, /createResource\("schedules",\s*\{[\s\S]{0,180}payload:\s*\{\s*\}/);
  assert.match(views, /const preflight = await crmApi\.preflight/);
  assert.match(views, /crmApi\.runSchedule\(id,\s*\{\s*confirmed:\s*true,\s*preflight_token:/);
  assert.match(api, /stopSchedule/);
});

test("OPC history, pool maintenance and takeover recovery have real API paths", async () => {
  const app = await read("src/App.tsx");
  const views = await read("src/BusinessViews.tsx");
  const api = await read("src/api.ts");
  assert.match(api, /\/api\/crm\/v1\/opc\/history\/import/);
  assert.match(views, /crmApi\.queryOpcHistory/);
  assert.match(views, /crmApi\.importOpcHistory/);
  assert.match(views, /crmApi\.updateResource\("pools"/);
  assert.match(views, /crmApi\.deduplicatePoolMembers/);
  for (const state of ["pending_login", "needs_login", "need_verification", "cookie_expired"]) assert.match(app, new RegExp(state));
  assert.match(app, /crmApi\.verifyAccount/);
  assert.match(app, /crmApi\.taskAction\(id,\s*"reconcile"\)/);
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
});
