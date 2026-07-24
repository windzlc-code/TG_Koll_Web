from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")
CONSOLE_CSS = (ROOT / "webapp" / "static" / "assets" / "console.css").read_text(encoding="utf-8")
SERVER_PY = (ROOT / "webapp" / "server.py").read_text(encoding="utf-8")


def function_source(name: str, next_name: str) -> str:
    start = CONSOLE_JS.index(f"function {name}")
    end = CONSOLE_JS.index(f"function {next_name}", start)
    return CONSOLE_JS[start:end]


class MatrixPublishFrontendContractTests(unittest.TestCase):
    def test_matrix_reuses_the_standard_schedule_component(self):
        panel = function_source("renderMatrixPublishPanel", "submitMatrixPublishTask")

        self.assertIn("renderPublishScheduleControls()", panel)
        self.assertNotIn('placeholder="留空立即执行', panel)

    def test_preview_keeps_requested_quantity_editable_and_marks_unavailable_personas(self):
        panel = function_source("renderMatrixPublishPanel", "submitMatrixPublishTask")
        candidates = function_source("matrixPublishCandidatePosts", "matrixPublishAvailabilityRows")

        self.assertIn('id="matrixPublishCount" type="number" min="1" max="20"', panel)
        self.assertIn("每人本次数量，最多 20 篇", panel)
        self.assertIn("submitPosts", candidates)
        self.assertIn("availableCount: detail.availablePosts.length", CONSOLE_JS)
        self.assertIn("submitCount: detail.submitPosts.length", CONSOLE_JS)
        self.assertIn(".mini-table tr.is-unavailable td", CONSOLE_CSS)
        self.assertIn("matrix-unavailable-copy", CONSOLE_CSS)

    def test_selected_personas_can_be_removed_individually_or_all_at_once(self):
        panel = function_source("renderMatrixPublishPanel", "submitMatrixPublishTask")

        self.assertIn("data-matrix-remove-persona", panel)
        self.assertIn("data-matrix-remove-all", panel)
        self.assertIn("matrix-current-publish", panel)
        self.assertIn("<th>当前发布</th>", panel)
        self.assertIn("Math.min(perCount, row.availableCount)", panel)
        self.assertNotIn("personaDraftDisplayTitleForPost(previewPosts", panel)
        self.assertIn("M3 6h18", panel)
        self.assertIn("button.matrix-persona-remove", CONSOLE_CSS)
        self.assertIn("var(--danger)", CONSOLE_CSS)
        self.assertIn("border: 1px solid var(--danger) !important", CONSOLE_CSS)
        self.assertIn("width: 29%", CONSOLE_CSS)
        self.assertNotIn("matrix-selection-head", panel)
        self.assertNotIn("matrix-persona-tabs", panel)

    def test_submit_confirms_and_excludes_zero_capacity_personas(self):
        submit = function_source("submitMatrixPublishTask", "createSocialTask")

        self.assertIn("部分人设不参与发布", submit)
        self.assertIn("const eligible = availability.filter((row) => row.submitCount > 0)", submit)
        self.assertIn("const personaIds = eligible.map", submit)

    def test_matrix_persona_selection_keeps_the_mobile_drawer_open(self):
        select_start = CONSOLE_JS.index('const personaSelectButton = event.target.closest("[data-persona-select]")')
        select_end = CONSOLE_JS.index('if (event.target.closest("[data-persona-open-create]"))', select_start)
        selection_handler = CONSOLE_JS[select_start:select_end]

        self.assertIn('if (mode === "matrix_start") toggleMatrixPersonaId(nextPersonaId);', selection_handler)
        self.assertNotIn('setPersonaMobileSidebarOpen(false)', selection_handler)

    def test_backend_skips_invalid_matrix_items_without_aborting_the_batch(self):
        matrix_start = SERVER_PY.index("def _publish_persona_matrix(")
        matrix_end = SERVER_PY.index("def _write_persona_archives_preserving_shape_unlocked", matrix_start)
        matrix = SERVER_PY[matrix_start:matrix_end]

        self.assertIn("skipped.append", matrix)
        self.assertIn("Instagram 发布需要先给草稿添加媒体", matrix)
        self.assertIn("已有发布任务在队列或执行中", matrix)
        self.assertIn("A missing or disabled account only affects this persona", matrix)


if __name__ == "__main__":
    unittest.main()
