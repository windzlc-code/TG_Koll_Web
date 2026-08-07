import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
STATIC_ROOT = REPO_ROOT / "webapp" / "static"


class FrontendTimezoneContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin = (STATIC_ROOT / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.console = (STATIC_ROOT / "assets" / "console.js").read_text(encoding="utf-8")
        cls.dashboard = (STATIC_ROOT / "assets" / "persona-dashboard.js").read_text(encoding="utf-8")
        cls.automation_log = (STATIC_ROOT / "persona-automation-log.html").read_text(encoding="utf-8")

    @staticmethod
    def _function_source(source: str, name: str) -> str:
        start = source.index(f"function {name}(")
        next_function = source.find("\nfunction ", start + 1)
        return source[start:] if next_function < 0 else source[start:next_function]

    def test_admin_dates_and_default_governance_range_use_shanghai(self):
        self.assertIn('const ADMIN_TIME_ZONE = "Asia/Shanghai";', self.admin)
        for name in ("formatTime", "formatAdminDate", "formatBillingTime"):
            self.assertIn("timeZone: ADMIN_TIME_ZONE", self._function_source(self.admin, name))
        self.assertIn("formatShanghaiDateInputValue", self._function_source(self.admin, "syncGovernanceRangeControls"))
        self.assertNotIn("getTimezoneOffset", self._function_source(self.admin, "syncGovernanceRangeControls"))
        self.assertIn("formatShanghaiDateTimeInputValue", self._function_source(self.admin, "localInputFromTimestamp"))
        self.assertIn("formatShanghaiDateTimeInputValue", self._function_source(self.admin, "setDefaultServiceAccountExpiry"))
        self.assertIn('`${value}:00+08:00`', self._function_source(self.admin, "timestampFromLocalInput"))

    def test_console_date_formatters_use_shanghai_without_touching_numeric_formatting(self):
        for name in ("formatTime", "formatScheduledTime", "accountTotpDateLabel"):
            self.assertIn("timeZone: SHANGHAI_TIME_ZONE", self._function_source(self.console, name))
        checked_at = re.search(r"checkedDate\.toLocaleString\([^;]+", self.console)
        self.assertIsNotNone(checked_at)
        self.assertIn("timeZone: SHANGHAI_TIME_ZONE", checked_at.group(0))
        chart_date = re.search(r"new Date\(time\)\.toLocaleDateString\([^;]+", self.console)
        self.assertIsNotNone(chart_date)
        self.assertIn("timeZone: SHANGHAI_TIME_ZONE", chart_date.group(0))
        numeric_format = self._function_source(self.console, "numberText")
        self.assertIn("n.toLocaleString()", numeric_format)
        self.assertNotIn("timeZone", numeric_format)

    def test_secondary_frontends_use_shanghai_for_every_displayed_date(self):
        self.assertIn('const PERSONA_DASHBOARD_TIME_ZONE = "Asia/Shanghai";', self.dashboard)
        self.assertNotRegex(self.dashboard, r"date\.toLocaleString\(\s*\)")
        self.assertGreaterEqual(self.dashboard.count("timeZone: PERSONA_DASHBOARD_TIME_ZONE"), 4)

        self.assertIn('const AUTOMATION_LOG_TIME_ZONE = "Asia/Shanghai";', self.automation_log)
        self.assertIn("timeZone: AUTOMATION_LOG_TIME_ZONE", self.automation_log)



if __name__ == "__main__":
    unittest.main()
