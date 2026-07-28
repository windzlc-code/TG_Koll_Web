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
        self.assertIn('<span>时间</span>', panel)
        self.assertIn('<span>任务</span><div class="automation-plan-draft-actions">', panel)
        self.assertIn("data-automation-plan-draft-preview", panel)
        self.assertIn("data-automation-plan-draft-clear", panel)
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

    def test_plan_config_hides_persona_description_and_removes_the_outer_frame(self):
        strategy_detail = function_source("personaThreadsStrategyDetail", "billingObject")
        automation_module = function_source("renderUnifiedAutomationModule", "renderUploadDropzone")

        self.assertIn("{ includePersonaContent = true } = {}", strategy_detail)
        self.assertIn("if (!includePersonaContent) return summary;", strategy_detail)
        self.assertIn('includePersonaContent: actionMode !== "plan"', automation_module)
        config_style = CONSOLE_CSS.split(
            ".automation-plan-task-config-modal .automation-plan-shared-config {", 1
        )[1].split("}", 1)[0]
        self.assertIn("border: 0;", config_style)
        self.assertIn("background: transparent;", config_style)
        normal_config = function_source("openAutomationPlanNormalPublishConfigurator", "openAutomationPlanTaskConfigurator")
        self.assertNotIn("链接", normal_config)
        self.assertNotIn("草稿内容", normal_config)

    def test_plan_rows_remain_two_columns_on_mobile(self):
        rows = function_source("renderAutomationPlanRows", "automationPlanStatusLabel")
        self.assertIn("automation-plan-time-cell", rows)
        self.assertIn("automation-plan-time-control", rows)
        self.assertIn("automation-plan-task-cell", rows)
        self.assertNotIn('<span class="automation-plan-field-label">任务</span>', rows)
        self.assertNotIn('</b> 时间</span>', rows)
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
        details = function_source("openAutomationPlanTaskDetails", "automationPlanTaskContent")
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

    def test_scheduled_social_log_routes_plan_tasks_back_to_automation(self):
        start = CONSOLE_JS.index("async function showSocialLog")
        end = CONSOLE_JS.index("async function openPersonalConsoleView", start)
        social_log = CONSOLE_JS[start:end]
        editor_start = CONSOLE_JS.index("async function openScheduledSocialTaskEditor")
        editor_end = CONSOLE_JS.index("async function openPersonalConsoleView", editor_start)
        editor = CONSOLE_JS[editor_start:editor_end]

        self.assertIn("isFutureScheduledSocialTask(task)", social_log)
        self.assertIn('extraActions: canEditScheduledTask ? [{ value: "edit", text: "编辑任务", primary: true }] : []', social_log)
        self.assertIn("if (action === \"edit\") await openScheduledSocialTaskEditor(task);", social_log)
        self.assertIn("const isAutomationPlanTask", editor)
        self.assertIn("if (isAutomationPlanTask(task, payload))", editor)
        self.assertLess(
            editor.index("if (isAutomationPlanTask(task, payload))"),
            editor.index('if (taskType === "publish_post")'),
        )
        self.assertIn('setWorkspaceModule("publishing")', editor)
        self.assertIn('state.simpleBranches.publishing = "automation_tasks"', editor)

    def test_selected_task_uses_replace_icon_and_plan_run_states_are_visible(self):
        rows = function_source("renderAutomationPlanRows", "automationPlanStatusLabel")
        self.assertIn('selectedTask ? renderReplaceIcon() : renderPlusIcon()', rows)
        run_rows = function_source("renderAutomationPlanRunRows", "renderAutomationPlanHistory")
        self.assertIn("automationPlanRunTasks(plan)", run_rows)
        self.assertIn("automationPlanRunState(task)", run_rows)
        self.assertIn("automationPlanRunSequence(task)", run_rows)
        self.assertIn("automationPlanAnimationStyle(stateKey)", run_rows)
        self.assertIn("automationPlanStatusLabel(task?.status)", run_rows)
        self.assertIn("automation-plan-run-index", run_rows)
        run_tasks = function_source("automationPlanRunTasks", "automationPlanRunState")
        self.assertIn("Array.isArray(plan?.tasks)", run_tasks)
        self.assertIn("return embeddedTasks", run_tasks)
        self.assertIn('if (["running", "need_manual"].includes(status)) return "running"', CONSOLE_JS)
        self.assertIn('if (["preparing", "queued"].includes(status)) return "queued"', CONSOLE_JS)
        self.assertIn('if (status === "canceled") return "cancelled"', CONSOLE_JS)
        self.assertIn("renderAutomationPlanRunRows(plan)", CONSOLE_JS)
        self.assertIn(".automation-plan-run-row.is-success .automation-plan-run-index", CONSOLE_CSS)
        self.assertIn(".automation-plan-run-row.is-completed .automation-plan-run-index", CONSOLE_CSS)
        self.assertIn(".automation-plan-run-row.is-failed .automation-plan-run-index", CONSOLE_CSS)
        self.assertIn(".automation-plan-run-row.is-cancelled .automation-plan-run-index", CONSOLE_CSS)
        self.assertIn("border-color: var(--danger);", CONSOLE_CSS)
        self.assertIn("automationPlanRunSpin", CONSOLE_CSS)
        self.assertIn("automationPlanQueuePulse", CONSOLE_CSS)
        self.assertIn("transform: scale(1.55)", CONSOLE_CSS)
        self.assertIn("animation-delay: var(--automation-plan-animation-delay, 0ms);", CONSOLE_CSS)
        self.assertIn("prefers-reduced-motion", CONSOLE_CSS)
        self.assertIn(".automation-plan-run-row.is-running .automation-plan-run-index", CONSOLE_CSS)
        self.assertIn("color: var(--ink);", CONSOLE_CSS)
        self.assertIn("var(--status-queued-ink)", CONSOLE_CSS)
        self.assertIn("var(--status-success-ink)", CONSOLE_CSS)

    def test_plan_history_is_compact_and_has_working_browser_and_delete_actions(self):
        history = function_source("renderAutomationPlanHistory", "renderAutomationTaskPlanPanel")
        browser_link = function_source("renderAutomationPlanBrowserLink", "renderAutomationPlanRunRows")
        card_action = function_source("renderAutomationPlanCardAction", "renderAutomationPlanRunRows")
        self.assertNotIn('.join(" → ")', history)
        self.assertIn("renderAutomationPlanCardActions(plan)", history)
        self.assertIn("automation-plan-status is-${", history)
        self.assertIn('completed: "已完成"', CONSOLE_JS)
        self.assertIn('taskForStatuses(["running", "need_manual"])', browser_link)
        self.assertIn('taskForStatuses(["preparing", "queued"])', browser_link)
        self.assertIn("data-automation-plan-browser-task", browser_link)
        self.assertIn("renderBrowserLaunchIcon()", browser_link)
        self.assertIn(".automation-plan-browser-link.unified-action-icon-button", CONSOLE_CSS)
        self.assertIn("color: var(--ink);", CONSOLE_CSS)
        self.assertIn("box-shadow: none;", CONSOLE_CSS)
        self.assertIn(".automation-plan-status.is-completed", CONSOLE_CSS)
        self.assertIn("data-automation-plan-select", history)
        self.assertIn("data-automation-plan-delete", card_action)
        self.assertIn("renderTrashIcon()", card_action)
        card_actions = function_source("renderAutomationPlanCardActions", "renderAutomationPlanRunRows")
        self.assertIn("data-automation-plan-view-run-details", card_actions)
        self.assertIn("renderFormListIcon()", card_actions)

    def test_plan_detail_overviews_show_configuration_and_runtime_fields(self):
        draft_preview = function_source("openAutomationPlanDraftPreview", "clearAutomationPlanDraft")
        run_details = function_source("openAutomationPlanRunDetails", "renderAutomationPlanCardActions")
        form_rows = function_source("renderAutomationPlanDetailFormRows", "automationPlanPlanItemForTask")
        strategy_labels = function_source("automationPlanStrategyFieldLabel", "automationPlanStrategyFieldValue")
        strategy_fields = function_source("renderAutomationPlanStrategyFields", "renderAutomationPlanDetailFormRows")
        panel = function_source("renderAutomationTaskPlanPanel", "normalizePublishContentSource")
        self.assertIn("renderAutomationPlanDetailFormRows(items)", draft_preview)
        self.assertIn("automationPlanPlanItemForTask(plan, task)", run_details)
        self.assertIn("renderAutomationPlanStrategyFields(detailItem)", form_rows)
        self.assertIn("strategy_id", strategy_labels)
        self.assertIn("reply_templates", strategy_labels)
        self.assertIn("Object.entries(params)", strategy_fields)
        self.assertIn('"strategy_label"', strategy_fields)
        self.assertIn('"comment_chance"', strategy_fields)
        self.assertIn('strategy?.label || "已配置策略"', CONSOLE_JS)
        self.assertNotIn('strategy.label}（${String(value)}）', CONSOLE_JS)
        self.assertNotIn("当前状态", form_rows)
        self.assertNotIn("任务状态", form_rows)
        self.assertIn("任务内容", form_rows)
        self.assertIn("automationPlanTaskContent(task)", form_rows)
        self.assertNotIn("<strong>无人值守计划</strong>", panel)
        self.assertIn("renderFormListIcon()", panel)

    def test_active_plan_stop_control_spans_the_history_card_grid(self):
        start = CONSOLE_CSS.index(".automation-plan-card > [data-automation-plan-cancel]")
        end = CONSOLE_CSS.index("}", start) + 1
        stop_control = CONSOLE_CSS[start:end]
        self.assertIn("grid-column: 1 / -1;", stop_control)
        self.assertIn("width: 100%;", stop_control)

    def test_plan_refresh_button_is_removed_and_bulk_delete_is_bound(self):
        panel = function_source("renderAutomationTaskPlanPanel", "normalizePublishContentSource")
        bindings = function_source("renderSimpleFlowModule", "fillSimpleAccounts")
        self.assertNotIn("data-automation-plans-refresh", panel)
        self.assertNotIn("[data-automation-plans-refresh]", bindings)
        self.assertIn("[data-automation-plan-browser-task]", bindings)
        self.assertIn("openLiveBrowserTaskView", bindings)
        self.assertIn("[data-automation-plan-delete]", bindings)
        self.assertIn("[data-automation-plan-delete-selected]", bindings)
        self.assertIn("[data-automation-plan-select-all]", bindings)
        self.assertIn("deleteAutomationPlanRecord", bindings)
        self.assertIn("deleteSelectedAutomationPlanRecords", bindings)

    def test_plan_delete_api_is_terminal_only_and_cleans_associated_rows(self):
        self.assertIn("class SocialAutomationPlanDeletePayload", API_PY)
        self.assertIn("def delete_social_automation_plans(", API_PY)
        self.assertIn("DELETE FROM social_automation_logs", API_PY)
        self.assertIn("DELETE FROM social_automation_tasks", API_PY)
        self.assertIn("DELETE FROM social_automation_plans", API_PY)
        self.assertIn('status IN (\'active\', \'materializing\')', API_PY)
        self.assertIn('status IN (\'preparing\', \'queued\', \'running\', \'need_manual\')', API_PY)
        self.assertIn('@app.delete("/api/persona_dashboard/automation/plans/{plan_id}")', API_PY)
        self.assertIn('@app.post("/api/persona_dashboard/automation/plans/batch-delete")', API_PY)

    def test_cancel_refreshes_plan_and_task_statuses_together(self):
        cancel = function_source("cancelAutomationPlan", "activateCreatedPersona")
        self.assertIn("const result = await api(", cancel)
        self.assertIn("result?.plan", cancel)
        self.assertIn("loadAutomationTasksShared({ force: true })", cancel)
        self.assertIn("loadAutomationPlansShared({ force: true })", cancel)
        plans = function_source("loadAutomationPlansShared", "automationPlanSubmissionItem")
        self.assertIn("if (!force) return state.automationPlansFetch;", plans)
        self.assertIn("await state.automationPlansFetch.catch(() => {});", plans)
        tasks = function_source("loadAutomationTasksShared", "loadAutomationPlansShared")
        self.assertIn("if (!force) return state.socialTasksFetch;", tasks)
        self.assertIn("await state.socialTasksFetch.catch(() => {});", tasks)

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
        self.assertIn("!account || !draft.items.length || busy ? \"disabled\"", panel)
        self.assertNotIn("selectedAccount ? \"\" : \"disabled\"", action)
        self.assertIn("绑定账号后再创建计划", configurator)
        self.assertIn('const unboundKey = automationPlanDraftKey(personaId, "")', current)
        self.assertIn("state.automationPlanDrafts[unboundKey]", current)
        self.assertIn(".automation-plan-time-picker,\n.automation-plan-task-value", CONSOLE_CSS)

    def test_plan_history_is_scoped_and_load_errors_are_visible(self):
        history = function_source("renderAutomationPlanHistory", "renderAutomationTaskPlanPanel")
        scope = function_source("automationPlansForPersona", "syncAutomationPlanSelection")
        self.assertIn("plan?.persona_id", scope)
        self.assertIn("automationPlansError", history)
        self.assertIn("automationPlansLoading", CONSOLE_JS)

    def test_plan_without_detailed_configuration_does_not_trigger_leave_guard(self):
        guard = function_source("activeAutomationPlanTransientState", "activeTransientWorkspaceState")
        self.assertIn("rows.some((item) => Boolean(item.configured))", guard)
        self.assertNotIn('draft.mode === "loop"', guard)
        self.assertNotIn("rows.length !== 1", guard)
        self.assertNotIn("reservationMinutes", guard)
        self.assertNotIn("item.taskType", guard)
        self.assertNotIn("item.params", guard)
        self.assertNotIn("defaultTaskType", guard)

    def test_plan_starts_empty_and_the_last_task_can_be_removed(self):
        draft_factory = function_source("createAutomationPlanDraft", "currentAutomationPlanDraft")
        current = function_source("currentAutomationPlanDraft", "automationReservationLabel")
        rows = function_source("renderAutomationPlanRows", "automationPlanStatusLabel")
        bindings = function_source("renderSimpleFlowModule", "fillSimpleAccounts")

        self.assertIn("items: [],", draft_factory)
        self.assertNotIn("draft.items = [automationPlanDefaultItem", current)
        self.assertNotIn('draft.items.length === 1 && !selectedTask ? "disabled"', rows)
        self.assertIn("draft.items.splice(index, 1);", bindings)
        self.assertNotIn("draft.items = [automationPlanDefaultItem", bindings)
        self.assertNotIn("const itemIndex = draft.items.length;", bindings)
        self.assertNotIn("openAutomationPlanTaskPicker(itemIndex)", bindings)

    def test_plan_mode_switch_updates_the_draft_without_waiting_for_button_animation(self):
        bindings = function_source("renderSimpleFlowModule", "fillSimpleAccounts")
        mode_bindings = bindings.split('document.querySelectorAll("[data-automation-plan-mode]")', 1)[1].split(
            'document.querySelectorAll("[data-automation-plan-time]")', 1
        )[0]

        self.assertIn('node.addEventListener("click", (event) => {', mode_bindings)
        self.assertIn("event.__vectoSegmentSlideHandled = true;", mode_bindings)
        self.assertIn('draft.mode = node.dataset.automationPlanMode === "loop" ? "loop" : "list";', mode_bindings)
        self.assertNotIn("await waitForSegmentedBackgroundSlide", mode_bindings)

    def test_reopening_task_picker_or_configurator_cleans_up_previous_modal_handlers(self):
        normal_config = function_source("openAutomationPlanNormalPublishConfigurator", "openAutomationPlanTaskConfigurator")
        automation_config = function_source("openAutomationPlanTaskConfigurator", "openAutomationPlanTaskDetails")
        picker = function_source("openAutomationPlanTaskPicker", "renderAutomationPlanRows")

        self.assertNotIn('onNormalPublishConfigure', normal_config)
        self.assertIn('void request.then((confirmed) => {', normal_config)
        self.assertIn('if (!confirmed) return;', normal_config)
        self.assertIn('item.taskType = "normal_publish";', normal_config)
        self.assertIn('item.configured = true;', normal_config)
        self.assertIn('const onAutomationTaskConfigure = (event) => {', automation_config)
        self.assertIn('modal?.removeEventListener("click", onAutomationTaskConfigure);', automation_config)
        self.assertIn('modal?.removeEventListener("change", onAutomationTaskConfigureChange);', automation_config)
        self.assertIn('const onAutomationTaskPick = (event) => {', picker)
        self.assertIn('modal?.removeEventListener("click", onAutomationTaskPick);', picker)


if __name__ == "__main__":
    unittest.main()
