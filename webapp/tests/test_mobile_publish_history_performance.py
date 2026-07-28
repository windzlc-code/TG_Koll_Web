from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")


def function_source(name: str, next_name: str) -> str:
    start = CONSOLE_JS.index(f"function {name}")
    end = CONSOLE_JS.index(f"function {next_name}", start)
    return CONSOLE_JS[start:end]


class MobilePublishHistoryPerformanceTests(unittest.TestCase):
    def test_mobile_history_uses_a_small_initial_batch_and_skips_hidden_preview(self):
        selection = function_source("renderPublishHistorySelectionList", "renderPublishHistoryPreview")
        panel = function_source("renderPublishHistoryPanel", "syncPublishHistoryRefreshDom")

        self.assertIn("MOBILE_PUBLISH_HISTORY_BATCH_SIZE", selection)
        self.assertIn("isMobileTweetStreamMode() ? \"\" : renderPublishHistoryPreview(persona)", panel)

    def test_history_media_sources_are_hydrated_after_the_navigation_frame(self):
        media_button = function_source("renderMediaPreviewButton", "personaDraftMediaItems")
        history_selection = function_source("renderPublishHistorySelectionList", "renderPublishHistoryPreview")

        self.assertIn("data-deferred-media-src", media_button)
        self.assertIn("scheduleDeferredMediaHydration", CONSOLE_JS)
        self.assertIn("DEFERRED_MEDIA_HYDRATION_DELAY_MS = 180", CONSOLE_JS)
        self.assertIn("new IntersectionObserver", CONSOLE_JS)
        self.assertIn("deferLoad: isMobileTweetStreamMode()", history_selection)

    def test_history_mode_does_not_load_unrelated_draft_posts(self):
        renderer = function_source("renderSimpleFlowModule", "fillSimpleAccounts")

        self.assertIn('publishMode !== "publish_history"', renderer)
        self.assertLess(renderer.index("const publishMode = normalizedPublishMode(branch);"), renderer.index("loadPersonaDraftPosts"))


if __name__ == "__main__":
    unittest.main()
