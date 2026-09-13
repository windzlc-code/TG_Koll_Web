from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VIDEO_HTML = (ROOT / "webapp" / "static" / "video.html").read_text(encoding="utf-8")
VIDEO_PAGE = (ROOT / "webapp" / "static" / "assets" / "video-page.js").read_text(encoding="utf-8")
VIDEO_EDITOR = (ROOT / "webapp" / "static" / "assets" / "video-editor.js").read_text(encoding="utf-8")
VIDEO_RECORDS = (ROOT / "webapp" / "static" / "assets" / "video-records.js").read_text(encoding="utf-8")
VIDEO_ICONS = (ROOT / "webapp" / "static" / "assets" / "video-icons.js").read_text(encoding="utf-8")
VIDEO_EDITOR_CSS = (ROOT / "webapp" / "static" / "assets" / "video-editor.css").read_text(encoding="utf-8")
SERVER = (ROOT / "webapp" / "server.py").read_text(encoding="utf-8")


class VideoEditorFrontendContractTests(unittest.TestCase):
    def test_editor_assets_are_versioned_and_loaded(self):
        self.assertIn('/assets/video-editor.css?v=__VIDEO_EDITOR_CSS_VERSION__', VIDEO_HTML)
        self.assertIn('/assets/video-editor.js?v=__VIDEO_EDITOR_JS_VERSION__', VIDEO_HTML)
        self.assertIn('/assets/video-records.js?v=__VIDEO_RECORDS_JS_VERSION__', VIDEO_HTML)
        self.assertIn('/assets/video-icons.js?v=__VIDEO_ICONS_JS_VERSION__', VIDEO_HTML)
        self.assertIn('"__VIDEO_EDITOR_CSS_VERSION__": _asset_version("assets", "video-editor.css")', SERVER)
        self.assertIn('"__VIDEO_EDITOR_JS_VERSION__": _asset_version("assets", "video-editor.js")', SERVER)
        self.assertIn('"__VIDEO_RECORDS_JS_VERSION__": _asset_version("assets", "video-records.js")', SERVER)
        self.assertIn('"__VIDEO_ICONS_JS_VERSION__": _asset_version("assets", "video-icons.js")', SERVER)
        self.assertIn('id="videoEditorRoot"', VIDEO_HTML)

    def test_records_and_editor_share_one_left_navigation_workspace(self):
        self.assertIn('const STUDIO_MODULE = { id: "video_editor", label: "视频记录与剪辑" }', VIDEO_PAGE)
        self.assertIn('{ label: "视频资产", items: [STUDIO_MODULE] }', VIDEO_PAGE)
        self.assertNotIn('const RECORDS_MODULE', VIDEO_PAGE)
        self.assertNotIn('nav-parent-toggle', VIDEO_HTML)
        self.assertNotIn('id="videoWorkspaceFlow"', VIDEO_HTML)
        self.assertIn('id="videoStudioPanel"', VIDEO_HTML)
        self.assertIn('data-studio-tab="records"', VIDEO_HTML)
        self.assertIn('data-studio-tab="editor"', VIDEO_HTML)
        self.assertIn('data-studio-page="records"', VIDEO_HTML)
        self.assertIn('data-studio-page="editor"', VIDEO_HTML)
        self.assertIn('id="videoRecordsRoot"', VIDEO_HTML)
        self.assertIn('window.VideoWorkbench?.deactivate?.()', VIDEO_PAGE)
        self.assertIn('window.VideoRecords?.activate?.()', VIDEO_PAGE)
        self.assertIn('window.VideoEditor?.activate?.({ assetId:', VIDEO_PAGE)
        self.assertIn('window.VideoPage = { navigate, showStudioTab }', VIDEO_PAGE)
        self.assertIn('requested === "video_records"', VIDEO_PAGE)
        self.assertNotIn('"video_editor",\n  ];', VIDEO_EDITOR)

    def test_asset_project_and_export_closure_is_wired(self):
        for contract in (
            '`${API}/assets/upload`',
            '`${API}/projects/${encodeURIComponent(state.project.id)}`',
            '`${API}/projects/${encodeURIComponent(state.project.id)}/export`',
            '`${API}/exports/${encodeURIComponent(state.exportJob.id)}`',
            'data-timeline-drop',
            'data-clip-split',
            'data-editor-preview',
            'url.searchParams.set("admin_console", "1")',
            'url.searchParams.set("admin_workspace_user_id", ADMIN_WORKSPACE_USER_ID)',
            'beforeunload',
            'data-timeline-zoom',
            'data-trim-handle',
            'data-timeline-playhead',
            'data-timeline-undo',
            'data-clip-duplicate',
            'event.key.toLowerCase() === "b"',
        ):
            self.assertIn(contract, VIDEO_EDITOR)

    def test_generation_records_are_server_paginated_and_open_in_editor(self):
        for contract in (
            'page_size: String(state.pageSize)',
            'source_type',
            'data-record-page',
            'data-record-menu-toggle',
            'data-record-edit',
            'window.VideoPage?.showStudioTab?.("editor"',
        ):
            self.assertIn(contract, VIDEO_RECORDS)

    def test_actions_use_accessible_standard_svg_icons(self):
        self.assertIn('viewBox="0 0 24 24"', VIDEO_ICONS)
        self.assertIn('stroke="currentColor"', VIDEO_ICONS)
        self.assertIn('aria-hidden="true"', VIDEO_ICONS)
        self.assertIn('focusable="false"', VIDEO_ICONS)
        self.assertIn('function renderBrand(name, className = "")', VIDEO_ICONS)
        self.assertIn('data-brand-logo="${name}"', VIDEO_ICONS)
        generic_icons = VIDEO_ICONS.split("const brandIcons", 1)[0]
        for legacy_platform_icon in ("wechat", "weibo", "qq", "channels", "facebook", "instagram", "youtube", "whatsapp", "telegram", "linkedin", "reddit"):
            self.assertNotIn(f"    {legacy_platform_icon}:", generic_icons)
        for brand_color in ("#07c160", "#fa9d3b", "#e6162d", "#1ebafc", "#ff2442", "#00a1d6", "#0866ff", "#25f4ee", "#fe2c55", "#ff0000", "#25d366", "#229ed9", "#0a66c2", "#ff4500"):
            self.assertIn(brand_color, VIDEO_ICONS)
        for contract in ('icon("edit")', 'icon("eye")', 'icon("download")', 'icon("scissors")', 'icon("share")'):
            self.assertIn(contract, VIDEO_RECORDS)
        for contract in ('icon("undo")', 'icon("redo")', 'icon("trimLeft")', 'icon("zoomIn")', 'icon("fit")'):
            self.assertIn(contract, VIDEO_EDITOR)
        self.assertIn('aria-expanded=', VIDEO_RECORDS)
        for contract in (
            'data-record-share-toggle',
            'data-share-platform-group="domestic"',
            'data-share-platform-group="international"',
            'navigator.canShare?.({ files: [file] })',
            'triggerDownload(item)',
            'creator.douyin.com',
            'creator.rednote.com',
            'member.bilibili.com',
            'tiktokstudio/upload',
            'youtube.com/upload',
        ):
            self.assertIn(contract, VIDEO_RECORDS)
        self.assertIn('brandIcon(platform.id)', VIDEO_RECORDS)
        self.assertNotIn('icon: "music"', VIDEO_RECORDS)
        self.assertNotIn('icon: "book"', VIDEO_RECORDS)
        self.assertNotIn('icon: "tv"', VIDEO_RECORDS)
        self.assertIn('.video-share-platform-grid .video-brand-icon', VIDEO_EDITOR_CSS)
        self.assertIn('grid-template-columns: repeat(4, minmax(0, 1fr))', VIDEO_EDITOR_CSS)
        self.assertIn('aspect-ratio: 4 / 3', VIDEO_EDITOR_CSS)

    def test_editor_has_desktop_and_mobile_layouts(self):
        self.assertIn("grid-template-columns: minmax(250px, 296px) minmax(430px, 1fr) minmax(230px, 270px)", VIDEO_EDITOR_CSS)
        self.assertIn("@media (max-width: 900px)", VIDEO_EDITOR_CSS)
        self.assertIn("@media (max-width: 620px)", VIDEO_EDITOR_CSS)
        self.assertIn(".video-preview-modal", VIDEO_EDITOR_CSS)


if __name__ == "__main__":
    unittest.main()
