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
        self.assertIn("visibleRows.map((task) => renderTaskRow(task))", self.script)

    def test_generation_table_has_scoped_column_layout(self):
        self.assertIn(".page-admin .admin-task-table {", self.styles)
        self.assertIn(".page-admin .admin-task-table-actions {", self.styles)
        self.assertIn(".page-admin .admin-task-table th:nth-child(8)", self.styles)

    def test_final_admin_theme_is_opaque_and_keeps_the_title_image(self):
        marker = "/* Keep one opaque admin theme last"
        self.assertIn(marker, self.fixed_light)
        final_admin_theme = self.fixed_light[self.fixed_light.index(marker) :]
        self.assertIn("background: #ffffff;", final_admin_theme)
        self.assertIn('url("/assets/opc/vecto-ai-cockpit.png")', final_admin_theme)
        self.assertNotIn("background-image: none", final_admin_theme)


if __name__ == "__main__":
    unittest.main()
