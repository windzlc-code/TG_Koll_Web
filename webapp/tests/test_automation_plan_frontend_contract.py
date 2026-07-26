from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")
CONSOLE_CSS = (ROOT / "webapp" / "static" / "assets" / "console.css").read_text(encoding="utf-8")
DB_PY = (ROOT / "webapp" / "db.py").read_text(encoding="utf-8")
API_PY = (ROOT / "webapp" / "social_automation_api.py").read_text(encoding="utf-8")


def function_source(name: str, next_name: str) -> str:
    start = CONSOLE_JS.index(f"function {name}")
    end = CONSOLE_JS.index(f"function {next_name}", start)
    return CONSOLE_JS[start:end]


class AutomationPlanFrontendContractTests(unittest.TestCase):
    def test_task_navigation_places_automation_between_matrix_and_history(self):
        tabs = function_source("renderPublishModeTabs", "renderPublishHeaderRow")
        self.assertLess(tabs.index('["matrix_start", "矩阵任务"]'), tabs.index('["automation_tasks", "自动化任务"]'))
        self.assertLess(tabs.index('["automation_tasks", "自动化任务"]'), tabs.index('["publish_history", "任务历史"]'))
        self.assertIn('repeat(4, minmax(0, 1fr))', CONSOLE_CSS)

    def test_old_task_time_controls_are_removed_from_normal_matrix_and_persona_publish(self):
        self.assertNotIn("任务时间", CONSOLE_JS)
        self.assertNotIn("renderPublishScheduleControls", CONSOLE_JS)
        self.assertNotIn("simpleScheduleAt", CONSOLE_JS)
        self.assertNotIn("personaPublishScheduleAt", CONSOLE_JS)

    def test_automation_plan_uses_inline_scrollable_half_hour_dropdown_and_server_api(self):
        panel = function_source("renderAutomationTaskPlanPanel", "normalizePublishContentSource")
        self.assertIn("<span>时间</span><span>任务</span>", panel)
        self.assertIn("data-automation-plan-time", CONSOLE_JS)
        self.assertIn("function openAutomationPlanTimePicker", CONSOLE_JS)
        self.assertIn('data-automation-plan-time-option="${minutes}"', CONSOLE_JS)
        picker = function_source("openAutomationPlanTimePicker", "renderAutomationModeIcon")
        self.assertNotIn("openConsoleModal", picker)
        self.assertNotIn('modalKey: "automation-plan-time-picker"', CONSOLE_JS)
        self.assertIn('data-automation-plan-time-menu="${index}"', CONSOLE_JS)
        self.assertIn('aria-expanded="${timeMenuOpen ? "true" : "false"}"', CONSOLE_JS)
        self.assertIn(".automation-plan-time-dropdown", CONSOLE_CSS)
        self.assertIn("overflow-y: auto", CONSOLE_CSS)
        self.assertNotIn("<select data-automation-plan-time", CONSOLE_JS)
        self.assertIn("normalizeAutomationPlanReservations", CONSOLE_JS)
        self.assertIn("const maximum = 1440 - remaining * 30", CONSOLE_JS)
        self.assertIn("for (let minutes = minimum; minutes <= maximum; minutes += 30)", CONSOLE_JS)
        self.assertIn("draft.items.length >= 49", CONSOLE_JS)
        self.assertIn("max_length=49", API_PY)
        self.assertIn("Number(item.reservationMinutes) > 1440", CONSOLE_JS)
        self.assertIn('mode: draft.mode', CONSOLE_JS)
        self.assertIn("/api/persona_dashboard/automation/plans", CONSOLE_JS)
        self.assertIn("social_automation_plans", DB_PY)
        self.assertIn("_reconcile_social_automation_plans()", API_PY)

    def test_reservation_labels_are_relative_to_plan_confirmation(self):
        labels = function_source("automationReservationLabel", "normalizeAutomationPlanReservations")
        self.assertIn('if (!value) return "立即执行"', labels)
        self.assertIn('return `${value} 分钟后`', labels)
        self.assertIn('" 30 分钟"', labels)
        self.assertNotIn("new Date", labels)
        self.assertNotIn("toLocaleString", labels)
        self.assertNotIn("SHANGHAI_TIME_ZONE", labels)
        self.assertNotIn(" · ", labels)

    def test_list_and_loop_modes_use_svg_icons_and_persisted_cycles(self):
        self.assertIn('data-automation-plan-mode="${mode}"', CONSOLE_JS)
        self.assertIn('aria-pressed="${draft.mode === mode ? "true" : "false"}"', CONSOLE_JS)
        self.assertIn("renderAutomationModeIcon", CONSOLE_JS)
        self.assertIn('class="automation-capsule-tabs automation-plan-mode"', CONSOLE_JS)
        self.assertIn(".automation-capsule-tabs.automation-plan-mode", CONSOLE_CSS)
        self.assertIn("_automation_plan_cycle", API_PY)
        self.assertIn("cycle_index", API_PY)

    def test_account_pool_no_longer_mounts_the_automation_panel(self):
        start = CONSOLE_JS.index("function renderAccountPool()")
        end = CONSOLE_JS.index("async function bindAccountPoolAccountToPersona", start)
        account_pool = CONSOLE_JS[start:end]
        self.assertNotIn("renderAccountPoolAutomationPanel", account_pool)
        self.assertNotIn("data-account-pool-automation-mode", account_pool)
        self.assertNotIn("function renderAccountPoolAutomationPanel", CONSOLE_JS)
        self.assertNotIn("function runAccountPoolThreadsTask", CONSOLE_JS)
        self.assertNotIn("accountPoolAutomationMode", CONSOLE_JS)
        self.assertNotIn("account-pool-automation-panel", CONSOLE_CSS)

    def test_automation_drafts_are_isolated_and_guarded(self):
        self.assertIn("automationPlanDrafts: {}", CONSOLE_JS)
        self.assertNotIn("automationPlanAccountIds", CONSOLE_JS)
        self.assertIn("function automationPlanDraftKey", CONSOLE_JS)
        self.assertIn("function activeAutomationPlanTransientState", CONSOLE_JS)
        self.assertIn('kind: "automation_plan"', CONSOLE_JS)
        self.assertNotIn("automationPlanDraft:", CONSOLE_JS)

    def test_plan_reuses_existing_task_configuration_instead_of_duplicate_fields(self):
        options = function_source("automationPlanTaskOptions", "automationPlanTaskLabel")
        self.assertNotIn('["publish_post", "发布内容"]', options)
        self.assertNotIn('["browse_feed", "浏览动态"]', options)
        self.assertIn('["normal_publish", "普通任务"]', options)
        self.assertNotIn("function renderAutomationPlanItemParams", CONSOLE_JS)
        self.assertNotIn("data-automation-plan-param", CONSOLE_JS)
        self.assertNotIn("data-automation-plan-expand", CONSOLE_JS)
        self.assertNotIn(".automation-plan-params", CONSOLE_CSS)
        self.assertNotIn(".automation-plan-param-grid", CONSOLE_CSS)
        self.assertIn('renderUnifiedAutomationModule({ embedded: true, actionMode: "plan" })', CONSOLE_JS)
        self.assertIn('data-automation-plan-add-configured="${esc(kind)}"', CONSOLE_JS)
        self.assertIn("buildPersonaThreadsTaskPayload(kind)", CONSOLE_JS)
        self.assertIn("cloneAutomationPlanPayload(buildPersonaThreadsTaskPayload(kind))", CONSOLE_JS)
        self.assertIn("function openAutomationPlanTaskPicker", CONSOLE_JS)
        self.assertIn('data-automation-plan-task-picker="${index}"', CONSOLE_JS)
        self.assertIn('data-automation-plan-task-option="${esc(taskType)}"', CONSOLE_JS)
        self.assertIn("openAutomationPlanTaskPicker(Number(node.dataset.automationPlanTaskPicker))", CONSOLE_JS)
        self.assertNotIn('data-automation-plan-task="${index}"', CONSOLE_JS)
        picker = function_source("openAutomationPlanTaskPicker", "renderAutomationPlanRows")
        picker_options = picker.split("const request = openConsoleModal", 1)[0]
        self.assertNotIn('["browse_feed", "浏览动态"]', picker)
        self.assertIn('["normal_publish", "普通任务"]', picker)
        self.assertIn('["automation_mode", "自动化模式"]', picker)
        self.assertNotIn('["threads_reply_comment"', picker_options)
        self.assertNotIn('["threads_reply_hot"', picker_options)
        self.assertNotIn('["threads_warmup"', picker_options)
        self.assertIn('hasExistingAutomationTask ? null : { initialStep: "warmup" }', picker)
        self.assertNotIn('item.taskType = "threads_warmup"', picker)
        self.assertIn("automationPlanPickerTaskType(item) === taskType", picker)
        self.assertIn("openAutomationPlanNormalPublishConfigurator(index)", picker)
        current = function_source("currentAutomationPlanDraft", "automationReservationLabel")
        self.assertIn('String(item?.taskType || "") !== "browse_feed"', current)
        self.assertIn('item.taskType = ""', current)
        submit = function_source("automationPlanSubmissionItem", "submitAutomationPlan")
        self.assertIn("cloneAutomationPlanPayload(item.params || {})", submit)
        self.assertNotIn("boundedAutomationPlanNumber", submit)
        self.assertNotIn("_automation_item_id", submit)
        self.assertIn("validateAutomationPlanDraft", CONSOLE_JS)
        normal_config = function_source("openAutomationPlanNormalPublishConfigurator", "openAutomationPlanTaskConfigurator")
        self.assertIn('data-automation-plan-normal-publish-count', normal_config)
        self.assertIn('[1, 2, 3, 4, 5]', normal_config)
        self.assertNotIn("链接", normal_config)
        self.assertNotIn("草稿内容", normal_config)

    def test_plan_rows_remain_two_columns_on_mobile(self):
        rows = function_source("renderAutomationPlanRows", "automationPlanStatusLabel")
        self.assertIn("automation-plan-time-cell", rows)
        self.assertIn("automation-plan-task-cell", rows)
        self.assertIn('data-automation-plan-view-details="${index}"', rows)
        self.assertIn("renderEyeIcon()", rows)
        self.assertIn("renderPlusIcon()", rows)
        self.assertIn('aria-label="${selectedTask ? "更换任务" : "添加任务"}"', rows)
        self.assertIn('aria-label="查看任务明细"', rows)
        self.assertIn("unified-action-icon-button", rows)
        self.assertIn("border: 0", CONSOLE_CSS)
        self.assertGreaterEqual(CONSOLE_CSS.count("grid-template-columns: repeat(2, minmax(0, 1fr));"), 2)
        self.assertNotIn("grid-template-columns: 28px minmax(0, 1fr) 38px", CONSOLE_CSS)

    def test_every_selected_plan_task_has_a_working_details_route(self):
        details = function_source("openAutomationPlanTaskDetails", "automationPlanPickerTaskType")
        self.assertIn("openAutomationPlanTaskConfigurator(index)", details)
        self.assertIn("automationPlanTaskDescription", details)
        self.assertIn('taskType === "normal_publish"', details)
        self.assertIn("automationPlanNormalPublishCount", details)
        self.assertNotIn("browse_limit", details)
        self.assertNotIn("scroll_times", details)
        self.assertIn("openConsoleModal", details)
        self.assertIn('extraActions: [{ value: "edit", text: "编辑任务", primary: true }]', details)
        self.assertIn('action !== "edit"', details)
        bindings = function_source("renderSimpleFlowModule", "fillSimpleAccounts")
        self.assertIn("[data-automation-plan-view-details]", bindings)
        self.assertIn("openAutomationPlanTaskDetails", bindings)

    def test_selected_task_uses_replace_icon_and_plan_run_states_are_visible(self):
        rows = function_source("renderAutomationPlanRows", "automationPlanStatusLabel")
        self.assertIn('selectedTask ? renderReplaceIcon() : renderPlusIcon()', rows)
        run_rows = function_source("renderAutomationPlanRunRows", "renderAutomationPlanHistory")
        self.assertIn("automationPlanRunTasks(plan)", run_rows)
        self.assertIn("automationPlanRunState(task)", run_rows)
        self.assertIn("automation-plan-run-index", run_rows)
        self.assertIn('if (["running", "need_manual"].includes(status)) return "running"', CONSOLE_JS)
        self.assertIn('if (["preparing", "queued"].includes(status)) return "queued"', CONSOLE_JS)
        self.assertIn("renderAutomationPlanRunRows(plan)", CONSOLE_JS)
        self.assertIn("automationPlanRunSpin", CONSOLE_CSS)
        self.assertIn("automationPlanQueuePulse", CONSOLE_CSS)
        self.assertIn("prefers-reduced-motion", CONSOLE_CSS)

    def test_active_plan_reuses_existing_status_refresh_for_live_queue_feedback(self):
        refresh = function_source("refreshAccountStatusOnce", "syncAccountStatusAutoRefresh")
        publishing = function_source("renderSimpleFlowModule", "fillSimpleAccounts")
        self.assertIn('normalizedPublishMode(state.simpleBranches.publishing) === "automation_tasks"', refresh)
        self.assertIn("Promise.all([loadAutomationTasksShared(), loadAutomationPlansShared()])", refresh)
        self.assertIn("if (!state.socialTasksFetch) loadAutomationTasksShared().catch(() => {});", publishing)

    def test_normal_publish_is_plan_only_and_expands_before_worker_execution(self):
        self.assertIn('AUTOMATION_PLAN_NORMAL_PUBLISH_TASK = "normal_publish"', API_PY)
        self.assertNotIn('"normal_publish",\n    "comment_post"', API_PY)
        self.assertIn("_expand_automation_plan_normal_publish_item", API_PY)
        self.assertIn('expanded_item["task_type"] = "publish_post"', API_PY)
        self.assertIn('"publish_sequence_total": len(drafts)', API_PY)
        self.assertIn("_expand_automation_plan_items(", API_PY)
        submit = function_source("automationPlanSubmissionItem", "submitAutomationPlan")
        self.assertIn('taskType === "normal_publish"', submit)
        self.assertIn("publish_count: automationPlanNormalPublishCount(item)", submit)

    def test_plan_uses_bound_account_automatically_and_only_renders_a_notice(self):
        current = function_source("currentAutomationPlanDraft", "automationReservationLabel")
        panel = function_source("renderAutomationTaskPlanPanel", "normalizePublishContentSource")
        self.assertIn("publishAccountForPersona(persona)", current)
        self.assertNotIn("selectedAccountId", current)
        self.assertNotIn('id="automationPlanAccount"', panel)
        self.assertNotIn("<select", panel)
        self.assertIn("automation-plan-account-notice", panel)
        self.assertIn("当前人设未绑定执行账号", panel)

    def test_plan_configuration_remains_available_before_account_binding(self):
        rows = function_source("renderAutomationPlanRows", "automationPlanStatusLabel")
        panel = function_source("renderAutomationTaskPlanPanel", "normalizePublishContentSource")
        action = function_source("renderPersonaAutomationAction", "renderUnifiedAutomationModule")
        configurator = function_source("openAutomationPlanTaskConfigurator", "openAutomationPlanTaskDetails")
        current = function_source("currentAutomationPlanDraft", "automationReservationLabel")
        self.assertNotIn("hasAccount ? \"\" : \"disabled\"", rows)
        self.assertNotIn("!account || draft.items.length", panel)
        self.assertIn("!account || busy ? \"disabled\"", panel)
        self.assertNotIn("selectedAccount ? \"\" : \"disabled\"", action)
        self.assertIn("绑定账号后再创建计划", configurator)
        self.assertIn('const unboundKey = automationPlanDraftKey(personaId, "")', current)
        self.assertIn("state.automationPlanDrafts[unboundKey]", current)
        self.assertIn(".automation-plan-time-picker,\n.automation-plan-task-value", CONSOLE_CSS)

    def test_plan_history_is_scoped_and_load_errors_are_visible(self):
        history = function_source("renderAutomationPlanHistory", "renderAutomationTaskPlanPanel")
        self.assertIn("plan?.persona_id", history)
        self.assertIn("automationPlansError", history)
        self.assertIn("automationPlansLoading", CONSOLE_JS)

    def test_untouched_empty_plan_does_not_trigger_leave_guard(self):
        guard = function_source("activeAutomationPlanTransientState", "activeTransientWorkspaceState")
        self.assertIn('Boolean(String(item.taskType || ""))', guard)
        self.assertNotIn("defaultTaskType", guard)


if __name__ == "__main__":
    unittest.main()
