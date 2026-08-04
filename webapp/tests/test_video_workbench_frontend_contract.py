import re
import unittest
from pathlib import Path


STATIC_ROOT = Path(__file__).resolve().parents[1] / "static"
CONSOLE_HTML = STATIC_ROOT / "console.html"
CONSOLE_JS = STATIC_ROOT / "assets" / "console.js"
CONSOLE_CSS = STATIC_ROOT / "assets" / "console.css"
WORKBENCH_JS = STATIC_ROOT / "assets" / "video-workbench.js"
WORKBENCH_CSS = STATIC_ROOT / "assets" / "video-workbench.css"

VIDEO_MODULES = (
    "digital_human_video",
    "ecommerce_short_video",
    "video_language_replace",
    "video_subject_replace",
    "ecommerce_image",
    "subject_replace",
    "poster_translate",
    "subject_generate",
)


class VideoWorkbenchFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = CONSOLE_HTML.read_text(encoding="utf-8")
        cls.console_js = CONSOLE_JS.read_text(encoding="utf-8")
        cls.console_css = CONSOLE_CSS.read_text(encoding="utf-8")
        cls.workbench_js = WORKBENCH_JS.read_text(encoding="utf-8")
        cls.workbench_css = WORKBENCH_CSS.read_text(encoding="utf-8")

    def test_console_loads_native_video_workspace_assets_and_panel(self):
        self.assertIn('/assets/video-workbench.css?v=__VIDEO_WORKBENCH_CSS_VERSION__', self.html)
        self.assertIn('/assets/video-workbench.js?v=__VIDEO_WORKBENCH_JS_VERSION__', self.html)
        self.assertIn('data-view="video_workspace" aria-expanded="false" hidden', self.html)
        self.assertIn('id="videoWorkspaceFlow" hidden', self.html)
        self.assertIn('.video-workbench-nav-toggle[hidden]', self.console_css)
        self.assertIn('data-panel="video_workspace"', self.html)
        self.assertIn('id="videoWorkspaceFlow"', self.html)
        self.assertIn('id="videoModuleMenu"', self.html)
        panel = self.html.split('data-panel="video_workspace"', 1)[1].split('</section>', 1)[0]
        self.assertNotIn("<iframe", panel.lower())

    def test_all_eight_video_modules_are_declared(self):
        for module_id in VIDEO_MODULES:
            self.assertIn(f'"{module_id}"', self.console_js)
            self.assertIn(f'"{module_id}"', self.workbench_js)
        order_match = re.search(r"const MODULE_ORDER = \[(.*?)\];", self.workbench_js, re.S)
        self.assertIsNotNone(order_match)
        self.assertEqual(order_match.group(1).count('"'), len(VIDEO_MODULES) * 2)

    def test_deep_link_and_navigation_contract_is_present(self):
        self.assertIn('const VIDEO_WORKBENCH_ENABLED = ADMIN_CONSOLE_SESSION', self.console_js)
        self.assertIn('entry.hidden = !VIDEO_WORKBENCH_ENABLED', self.console_js)
        self.assertIn('...(VIDEO_WORKBENCH_ENABLED ? [{ id: "video_workspace"', self.console_js)
        self.assertIn('initialConsoleParams.get("video_module")', self.console_js)
        self.assertIn('url.searchParams.set("view", "video_workspace")', self.console_js)
        self.assertIn('url.searchParams.set("video_module", state.activeVideoModule)', self.console_js)
        self.assertIn('openVideoWorkspace', self.console_js)
        self.assertIn('syncVideoModuleMenuState', self.console_js)
        self.assertIn('{ id: "video_workspace", label: "视频", view: "video_workspace" }', self.console_js)

    def test_module_planning_and_task_apis_are_used(self):
        self.assertIn('request("/api/video/modules")', self.workbench_js)
        self.assertGreaterEqual(self.workbench_js.count('request("/api/video/tasks"'), 2)
        self.assertIn('request("/api/tasks")', self.workbench_js)
        self.assertIn('body.append("params_json"', self.workbench_js)
        self.assertIn('body.append("video_module", module.id)', self.workbench_js)

    def test_drafts_and_leave_confirmation_protect_local_work(self):
        self.assertIn("wk-video-workbench-draft:", self.workbench_js)
        self.assertIn("window.localStorage.setItem", self.workbench_js)
        self.assertIn("window.localStorage.getItem", self.workbench_js)
        self.assertIn("function confirmLeave()", self.workbench_js)
        self.assertIn('window.addEventListener("beforeunload"', self.workbench_js)
        self.assertIn("canLeaveVideoWorkspace", self.console_js)

    def test_loading_empty_error_and_mobile_states_are_styled(self):
        for marker in (
            "video-workbench-state--loading",
            "video-workbench-state--empty",
            "video-workbench-state--error",
            "video-inline-error",
        ):
            self.assertIn(marker, self.workbench_js)
            self.assertIn(f".{marker}", self.workbench_css)
        self.assertIn("@media (max-width: 820px)", self.workbench_css)
        self.assertIn("position: sticky", self.workbench_css)
        self.assertIn("env(safe-area-inset-bottom", self.workbench_css)

    def test_module_navigation_uses_grouped_capsule_switcher(self):
        for marker in (
            'class="video-module-switcher"',
            'class="video-module-group-row"',
            'class="video-module-pills"',
            'class="video-module-tab',
        ):
            self.assertIn(marker, self.workbench_js)
        self.assertIn('role="tab"', self.workbench_js)
        self.assertIn('aria-selected=', self.workbench_js)
        self.assertIn("border-radius: 999px", self.workbench_css)
        self.assertNotIn(".video-module-strip", self.workbench_css)
        mobile_css = self.workbench_css.split("@media (max-width: 820px)", 1)[1]
        self.assertIn("scroll-snap-type: x proximity", mobile_css)
        self.assertIn("min-width: max-content", mobile_css)

    def test_primary_mode_switches_use_capsule_controls(self):
        self.assertIn('const PILL_SELECT_KEYS = new Set(["content_mode", "subject_kind", "mode", "duration_mode"])', self.workbench_js)
        self.assertIn('class="video-choice-pills"', self.workbench_js)
        self.assertIn('data-video-choice-field=', self.workbench_js)
        self.assertIn('role="radiogroup"', self.workbench_js)
        self.assertIn('role="radio"', self.workbench_js)
        self.assertIn(".video-choice-pill.is-active", self.workbench_css)

    def test_sidebar_keeps_original_full_width_console_navigation(self):
        self.assertNotIn(".video-module-menu .video-module-group", self.workbench_css)
        self.assertNotIn("grid-template-columns: repeat(2, minmax(0, 1fr))", self.workbench_css.split(".video-workbench-shell", 1)[0])
        self.assertNotIn(".video-module-menu .module-trigger {\n  min-height: 34px", self.workbench_css)
        self.assertIn('class="module-trigger" data-video-module=', self.console_js)

    def test_legacy_visible_form_fields_remain_available(self):
        for field_name in (
            "product_name",
            "style_hint",
            "speech_text",
            "prompt_text",
            "nano_prompt",
            "language",
            "speaker",
            "emotion",
            "duration_mode",
            "duration_seconds",
            "mode",
            "width",
            "height",
            "frame",
        ):
            self.assertIn(f'"{field_name}"', self.workbench_js)

    def test_voice_catalog_loads_with_local_fallback_and_inline_audio(self):
        self.assertIn('const VOICE_PRESETS_ENDPOINT = "/api/video/voice-presets"', self.workbench_js)
        self.assertIn('const VOICE_PRESETS_MANIFEST_URL = "/assets/voice_presets_manifest.json"', self.workbench_js)
        self.assertIn("async function loadVoicePresets", self.workbench_js)
        self.assertIn("ELEVENLABS_OFFICIAL_VOICE_PRESETS", self.workbench_js)
        self.assertIn('data-video-voice-select=', self.workbench_js)
        self.assertIn('data-video-voice-preview=', self.workbench_js)
        self.assertIn('<audio id="videoVoicePreview"', self.workbench_js)
        self.assertIn(".video-voice-list", self.workbench_css)
        self.assertIn(".video-voice-audio", self.workbench_css)

    def test_planting_storyboard_supports_preview_edit_confirm_and_regenerate(self):
        self.assertIn('select("content_mode", "内容模式"', self.workbench_js)
        self.assertIn("function buildStoryboard", self.workbench_js)
        self.assertIn("function regenerateStoryboard", self.workbench_js)
        self.assertIn("function confirmStoryboard", self.workbench_js)
        self.assertIn('data-video-storyboard-field=', self.workbench_js)
        self.assertIn("data-video-storyboard-confirm", self.workbench_js)
        self.assertIn("data-video-storyboard-generate", self.workbench_js)
        self.assertIn("storyboard_confirmed", self.workbench_js)
        self.assertIn("请先预览并确认种草故事板", self.workbench_js)
        self.assertIn(".video-storyboard-track", self.workbench_css)

    def test_language_script_parser_and_timestamp_editor_are_wired(self):
        self.assertIn("function parseTimedScript", self.workbench_js)
        self.assertIn('request("/api/video/language-script/parse"', self.workbench_js)
        self.assertIn("srtPattern", self.workbench_js)
        self.assertIn('textarea("target_script", "目标语言脚本"', self.workbench_js)
        self.assertIn("留空时自动识别并翻译原视频语音", self.workbench_js)
        self.assertNotIn("当前不会自动识别翻译", self.workbench_js)
        self.assertIn("subtitle_segments", self.workbench_js)
        self.assertIn("script_segments", self.workbench_js)
        self.assertIn("data-video-parse-script", self.workbench_js)
        self.assertIn("data-video-timeline-field", self.workbench_js)
        self.assertIn("data-video-add-timeline", self.workbench_js)
        self.assertIn(".video-timeline-row", self.workbench_css)

    def test_subtitle_enable_and_template_are_submitted_with_timeline_cues(self):
        self.assertIn("SUBTITLE_TEMPLATE_OPTIONS", self.workbench_js)
        for template in ("keyword_focus", "bilingual_dual", "handwritten_quote", "split_hook"):
            self.assertIn(f'value: "{template}"', self.workbench_js)
        self.assertIn('checkbox("subtitles_enabled", "生成并烧录字幕"', self.workbench_js)
        self.assertIn('select("subtitle_template", "字幕样式"', self.workbench_js)
        self.assertIn("submitValues.subtitles = {", self.workbench_js)
        self.assertIn("enabled: draft.values.subtitles_enabled !== false", self.workbench_js)

    def test_video_subject_replace_selects_and_submits_subject_kind(self):
        self.assertIn('select("subject_kind", "替换主体"', self.workbench_js)
        self.assertIn('{ value: "model", label: "人物 / 模特" }', self.workbench_js)
        self.assertIn('{ value: "product", label: "商品" }', self.workbench_js)
        self.assertIn('submitValues.subject_kind = draft.values.subject_kind === "product" ? "product" : "model"', self.workbench_js)
        self.assertIn('body.append("params_json", JSON.stringify({ ...submitValues', self.workbench_js)

    def test_language_replace_exposes_automatic_transcription_and_translation(self):
        self.assertIn("留空时自动识别并翻译原视频语音", self.workbench_js)
        self.assertIn("多模态模型自动转写并翻译", self.workbench_js)
        self.assertNotIn("当前不会从原视频自动识别或翻译台词", self.workbench_js)
        self.assertNotIn("请上传替换音频或填写目标语言脚本（当前不会自动识别翻译）", self.workbench_js)

    def test_task_results_keep_download_and_add_safe_inline_media_previews(self):
        self.assertIn("function safeHttpUrl(value)", self.workbench_js)
        self.assertIn('["http:", "https:"].includes(parsed.protocol)', self.workbench_js)
        self.assertIn("function hydrateTaskMedia(tasks)", self.workbench_js)
        self.assertIn('request(`/api/tasks/${encodeURIComponent(task.id)}`)', self.workbench_js)
        self.assertIn("function renderTaskMedia(task)", self.workbench_js)
        self.assertIn('class="video-task-media-item is-image"', self.workbench_js)
        self.assertIn('class="video-task-media-item is-video"', self.workbench_js)
        self.assertIn('class="video-task-media-item is-audio"', self.workbench_js)
        self.assertIn("controls preload=\"metadata\" playsinline", self.workbench_js)
        self.assertIn('class="video-task-download"', self.workbench_js)
        self.assertIn(".video-task-media", self.workbench_css)
        self.assertIn(".video-task-media-item audio", self.workbench_css)

    def test_subject_generate_exposes_digital_human_and_three_view_modes(self):
        subject_generate = self.workbench_js.split("subject_generate: {", 1)[1].split("  };", 1)[0]
        self.assertIn('select("mode", "生成模式"', subject_generate)
        self.assertIn('{ value: "digital_human_character", label: "数字人角色" }', subject_generate)
        self.assertIn('{ value: "three_view", label: "角色三视图" }', subject_generate)
        self.assertIn('default: "digital_human_character"', subject_generate)

    def test_segment_regeneration_and_failed_task_resume_contract(self):
        self.assertIn("endpointIndex: index + 1", self.workbench_js)
        resume = '/api/video/tasks/${encodeURIComponent(taskId)}/resume'
        retry = '/api/tasks/${encodeURIComponent(taskId)}/retry'
        self.assertIn(resume, self.workbench_js)
        self.assertIn(retry, self.workbench_js)
        self.assertLess(self.workbench_js.index(resume), self.workbench_js.index(retry))
        self.assertIn("catch (resumeError)", self.workbench_js)
        self.assertIn("data-video-regenerate-segment", self.workbench_js)
        self.assertIn("data-video-task-segment-regenerate", self.workbench_js)
        self.assertIn('/segments/${encodeURIComponent(segmentId)}/regenerate', self.workbench_js)
        self.assertIn("function regenerateDraftSegment", self.workbench_js)
        self.assertIn("function regenerateTaskSegment", self.workbench_js)

    def test_advanced_interactions_keep_scoped_mobile_layout(self):
        for marker in (
            ".video-advanced-card",
            ".video-voice-toolbar",
            ".video-storyboard-shot",
            ".video-timeline-editor",
            ".video-task-segments",
        ):
            self.assertIn(marker, self.workbench_css)
        mobile_css = self.workbench_css.split("@media (max-width: 520px)", 1)[1]
        self.assertIn(".video-voice-list", mobile_css)
        self.assertIn(".video-timeline-row", mobile_css)
        self.assertIn("grid-template-columns: 1fr", mobile_css)


if __name__ == "__main__":
    unittest.main()
