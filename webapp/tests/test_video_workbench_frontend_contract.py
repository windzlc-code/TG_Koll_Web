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

    def test_quiet_task_polling_updates_only_task_panel_without_replacing_form(self):
        self.assertIn("function renderTaskPanelOnly()", self.workbench_js)
        self.assertIn("current.replaceWith(next)", self.workbench_js)
        self.assertIn("if (!quiet) render();", self.workbench_js)
        self.assertIn("if (quiet) renderTaskPanelOnly();", self.workbench_js)
        polling = self.workbench_js.split("async function loadTasks({ quiet = false } = {})", 1)[1].split("function syncPolling()", 1)[0]
        self.assertNotIn('state.taskWarning = "";\n    render();', polling)

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
        self.assertIn('const PILL_SELECT_KEYS = new Set(["digital_human_content_mode", "ecommerce_video_mode", "replace_mode", "subject_generate_mode"])', self.workbench_js)
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

    def test_visible_fields_follow_original_frontend_allowlist(self):
        for field_name in (
            "digital_human_content_mode",
            "product_name",
            "product_details",
            "oral_target_duration_seconds",
            "target_language",
            "minimax_tts_model",
            "speech_text",
            "ratio",
            "image_resolution",
            "digital_human_short_mode",
            "ecommerce_video_mode",
            "ecommerce_seeding_template",
            "duration",
            "resolution",
            "ecommerce_short_video_model",
            "ecommerce_ad_style",
            "copy_text",
            "script_text",
            "opening_insert_text",
            "ending_insert_text",
            "output_size",
            "nano_images",
            "replace_mode",
            "subject_generate_mode",
        ):
            self.assertIn(f'"{field_name}"', self.workbench_js)

    def test_invented_or_internal_generation_controls_are_not_exposed(self):
        fallback_contract = self.workbench_js.split("const FALLBACK_MODULES = {", 1)[1].split("\n  };", 1)[0]
        for field_name in (
            "source_language",
            "translation_notes",
            "preserve_layout",
            "negative_prompt",
            "duration_mode",
            "model_choice",
            "camera_video",
            "nano_prompt",
            "subtitles_enabled",
            "subtitle_template",
            "start_seconds",
            "width",
            "height",
            "frame",
        ):
            self.assertNotIn(f'("{field_name}"', fallback_contract)

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
        self.assertIn('placement: "voice"', self.workbench_js)
        self.assertIn(".video-voice-inline-fields", self.workbench_css)

    def test_seeding_mode_keeps_original_modes_and_templates_without_fake_storyboard(self):
        self.assertIn('select("ecommerce_video_mode", "视频模式"', self.workbench_js)
        self.assertIn('{ value: "ad_video", label: "广告视频模式" }', self.workbench_js)
        self.assertIn('{ value: "seeding_video", label: "种草视频模式" }', self.workbench_js)
        for template in ("template_b", "template_d", "template_f"):
            self.assertIn(f'value: "{template}"', self.workbench_js)
        self.assertIn('values.content_mode = seeding ? "planting" : "advertising"', self.workbench_js)
        self.assertNotIn("function buildStoryboard", self.workbench_js)
        self.assertNotIn("storyboard_confirmed", self.workbench_js)

    def test_language_script_parser_and_timestamp_editor_are_wired(self):
        self.assertIn("function parseTimedScript", self.workbench_js)
        self.assertIn('request("/api/video/language-script/parse"', self.workbench_js)
        self.assertIn("srtPattern", self.workbench_js)
        self.assertIn('textarea("script_text", "原文台词"', self.workbench_js)
        self.assertIn("第一步会自动解析原视频台词和时间戳", self.workbench_js)
        self.assertIn("subtitle_segments", self.workbench_js)
        self.assertIn("script_segments", self.workbench_js)
        self.assertIn("submitValues.source_segments =", self.workbench_js)
        self.assertIn("values.video_tts_model = values.minimax_tts_model", self.workbench_js)
        self.assertIn("data-video-parse-script", self.workbench_js)
        self.assertIn("data-video-timeline-field", self.workbench_js)
        self.assertIn("data-video-add-timeline", self.workbench_js)
        self.assertIn(".video-timeline-row", self.workbench_css)

    def test_subtitle_controls_are_not_exposed_in_initial_generation_form(self):
        fallback_contract = self.workbench_js.split("const FALLBACK_MODULES = {", 1)[1].split("\n  };", 1)[0]
        self.assertNotIn('checkbox("subtitles_enabled"', fallback_contract)
        self.assertNotIn('select("subtitle_template"', fallback_contract)
        self.assertIn("values.add_subtitles = true", self.workbench_js)
        self.assertIn("values.subtitle_enabled = true", self.workbench_js)

    def test_video_subject_replace_selects_and_submits_subject_kind(self):
        self.assertIn('select("replace_mode", "替换模式"', self.workbench_js)
        self.assertIn('{ value: "model", label: "模特替换" }', self.workbench_js)
        self.assertIn('{ value: "product", label: "商品替换" }', self.workbench_js)
        self.assertIn('values.subject_kind = values.replace_mode === "product" ? "product" : "model"', self.workbench_js)
        self.assertIn('body.append("params_json", JSON.stringify({ ...submitValues', self.workbench_js)

    def test_language_replace_exposes_automatic_transcription_and_translation(self):
        self.assertIn("第一步会自动解析原视频台词和时间戳", self.workbench_js)
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
        self.assertIn('select("subject_generate_mode", "生成模式"', subject_generate)
        self.assertIn('{ value: "character", label: "数字人生成" }', subject_generate)
        self.assertIn('{ value: "product", label: "产品图生成" }', subject_generate)
        self.assertIn('default: "character"', subject_generate)

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
