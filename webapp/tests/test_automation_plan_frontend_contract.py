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

    def test_automation_plan_uses_half_hour_selects_and_server_api(self):
        panel = function_source("renderAutomationTaskPlanPanel", "normalizePublishContentSource")
        self.assertIn("预约时间", panel)
        self.assertIn("data-automation-plan-time", CONSOLE_JS)
        self.assertIn("normalizeAutomationPlanReservations", CONSOLE_JS)
        self.assertIn("const maximum = 1410 - remaining * 30", CONSOLE_JS)
        self.assertIn("for (let minutes = floor; minutes <= ceiling; minutes += 30)", CONSOLE_JS)
        self.assertIn('mode: draft.mode', CONSOLE_JS)
        self.assertIn("/api/persona_dashboard/automation/plans", CONSOLE_JS)
        self.assertIn("social_automation_plans", DB_PY)
        self.assertIn("_reconcile_social_automation_plans()", API_PY)

    def test_list_and_loop_modes_use_svg_icons_and_persisted_cycles(self):
        self.assertIn('data-automation-plan-mode="${mode}"', CONSOLE_JS)
        self.assertIn('aria-pressed="${draft.mode === mode ? "true" : "false"}"', CONSOLE_JS)
        self.assertIn("renderAutomationModeIcon", CONSOLE_JS)
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
        self.assertIn("automationPlanAccountIds: {}", CONSOLE_JS)
        self.assertIn("function automationPlanDraftKey", CONSOLE_JS)
        self.assertIn("function activeAutomationPlanTransientState", CONSOLE_JS)
        self.assertIn('kind: "automation_plan"', CONSOLE_JS)
        self.assertNotIn("automationPlanDraft:", CONSOLE_JS)

    def test_platform_payloads_and_required_fields_are_safe(self):
        options = function_source("automationPlanTaskOptions", "automationPlanTaskLabel")
        instagram = options[options.index('=== "instagram"'):].split("\n  }\n  return [", 1)[0]
        self.assertNotIn('["publish_post", "发布内容"]', instagram)
        params = function_source("renderAutomationPlanItemParams", "renderAutomationPlanRows")
        self.assertIn('data-automation-plan-param="target_urls"', params)
        self.assertIn("养号留言模板", params)
        submit = function_source("automationPlanSubmissionItem", "submitAutomationPlan")
        self.assertIn("params.target_urls = splitLines", submit)
        self.assertIn("params.reply_templates = splitLines", submit)
        self.assertNotIn("_automation_item_id", submit)
        self.assertIn("validateAutomationPlanDraft", CONSOLE_JS)

    def test_plan_history_is_scoped_and_load_errors_are_visible(self):
        history = function_source("renderAutomationPlanHistory", "renderAutomationTaskPlanPanel")
        self.assertIn("plan?.persona_id", history)
        self.assertIn("automationPlansError", history)
        self.assertIn("automationPlansLoading", CONSOLE_JS)


if __name__ == "__main__":
    unittest.main()
