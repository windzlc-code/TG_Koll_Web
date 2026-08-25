import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AdminTaskTableFrontendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "static" / "admin.html").read_text(encoding="utf-8")
        cls.script = (ROOT / "static" / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.styles = (ROOT / "static" / "assets" / "style.css").read_text(encoding="utf-8")
        cls.fixed_light = (ROOT / "static" / "assets" / "fixed-light.css").read_text(encoding="utf-8")

    def test_generation_records_use_the_shared_admin_table(self):
        self.assertIn('id="taskTableShell"', self.html)
        self.assertIn('class="table admin-task-table"', self.html)
        self.assertIn('<tbody id="taskList"></tbody>', self.html)
        self.assertIn("function renderTaskRow(task)", self.script)
        self.assertNotIn("function renderTaskCard(task)", self.script)
        self.assertIn("pageRows.map((task) => renderTaskRow(task))", self.script)
        self.assertIn("function taskPromptDisplay(task", self.script)
        self.assertIn('提示词：</span>${escapeHtml(taskPromptDisplay(task))}', self.script)
        self.assertIn("inspectItem(\"用户提示词\", taskPromptDisplay(data))", self.script)
        self.assertIn("inspectItem(\"发给模型的提示词\", taskPromptDisplay(data, { final: true }))", self.script)
        self.assertIn(".page-admin .admin-task-prompt {", self.styles)
        self.assertIn("生成编号 / 客户 / 类型 / 提示词 / 异常提示", self.html)

    def test_generation_table_has_scoped_column_layout(self):
        self.assertIn(".page-admin .admin-task-table {", self.styles)
        self.assertIn(".page-admin .admin-task-table-actions {", self.styles)
        self.assertIn(".page-admin .admin-task-table th:nth-child(8)", self.styles)

    def test_long_admin_lists_share_the_same_pagination_pattern(self):
        for prefix in ("task", "audit", "security"):
            self.assertIn(f'id="{prefix}Pagination"', self.html)
            self.assertIn(f'id="{prefix}PageIndicator"', self.html)
        self.assertIn("pageSize: 20", self.script)
        self.assertIn("auditListPageSize: 20", self.script)
        self.assertIn("securityListPageSize: 20", self.script)
        self.assertIn(".page-admin .admin-list-pagination[hidden]", self.styles)

    def test_desktop_workspace_is_capped_and_admin_utilities_are_aligned(self):
        self.assertIn("width: min(1480px, calc(100% - 48px));", self.styles)
        self.assertIn(".page-admin .admin-profile-menu {\n  display: flex;", self.styles)
        self.assertIn(".page-admin .admin-preference-button.admin-language-toggle {", self.styles)

    def test_final_admin_theme_is_opaque_and_keeps_the_title_image(self):
        marker = "/* Keep one opaque admin theme last"
        self.assertIn(marker, self.fixed_light)
        final_admin_theme = self.fixed_light[self.fixed_light.index(marker) :]
        self.assertIn("background: #ffffff;", final_admin_theme)
        self.assertIn('url("/assets/opc/vecto-ai-cockpit.png")', final_admin_theme)
        self.assertNotIn("background-image: none", final_admin_theme)


if __name__ == "__main__":
    unittest.main()
