from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")
CONSOLE_CSS = (ROOT / "webapp" / "static" / "assets" / "console.css").read_text(encoding="utf-8")
REFRESH_SCRIPT = (ROOT / "tool_r18" / "scripts" / "skills" / "persona-dashboard-refresh.ts").read_text(encoding="utf-8")
ARCHIVE_STORE = (ROOT / "tool_r18" / "src" / "runtime" / "node" / "persona-archive-store.ts").read_text(encoding="utf-8")


def function_source(name: str, next_name: str) -> str:
    start = CONSOLE_JS.index(f"function {name}")
    end = CONSOLE_JS.index(f"function {next_name}", start)
    return CONSOLE_JS[start:end]


class ConsolePublishHistoryHotDataTests(unittest.TestCase):
    def test_persona_workspace_moves_platform_metrics_into_identity_and_shows_published_posts(self):
        metrics = function_source("personaPlatformMetricSummary", "renderPersonaPlatformMetricStrip")
        panel = function_source("renderPersonaDataPanel", "renderPersonaProfileIdentity")
        identity = function_source("renderPersonaProfileIdentity", "renderPersonaContentOverview")

        self.assertIn("hot_platforms", metrics)
        self.assertIn("followers", metrics)
        self.assertIn("post_views", metrics)
        self.assertIn("interactions", metrics)
        self.assertIn("published", metrics)
        self.assertIn("row?.account_id", metrics)
        self.assertIn("const metricRows = account ? accountRows : platformRows;", metrics)
        self.assertIn("const metricPublished = metricRows.reduce", metrics)
        self.assertIn("published: metricPublished || publishedRows.length", metrics)
        self.assertIn("return !account;", metrics)
        self.assertIn("人设发布推文", panel)
        self.assertIn("renderPersonaPlatformMetricStrip(persona)", identity)
        self.assertIn("renderPersonaPublishHistoryEmptyState", CONSOLE_JS)
        self.assertIn("暂无已发布推文", CONSOLE_JS)
        self.assertIn("发布后将在这里展示", CONSOLE_JS)
        self.assertNotIn('data-persona-data-tab="hot"', CONSOLE_JS)
        self.assertNotIn('data-persona-data-tab="history"', CONSOLE_JS)
        self.assertNotIn("人设历史推文", CONSOLE_JS)
        self.assertIn(".persona-profile-platform-metrics {", CONSOLE_CSS)
        self.assertIn(".persona-history-empty-state {", CONSOLE_CSS)

    def test_persona_history_merges_dashboard_metrics_with_real_task_history(self):
        merge = function_source("personaMergedHistoryRows", "personaHistoryContentParts")
        history = function_source("renderPersonaHistoryDataContent", "renderPersonaDataPanel")

        self.assertIn("personaPublishHistoryRows(persona)", merge)
        self.assertIn("personaDashboardDetail(persona)?.post_metrics", merge)
        self.assertIn("personaHistoryIdentityKeys", merge)
        self.assertIn("renderPublishHistorySelectionList(persona, {", history)
        self.assertIn("loadPersonaDashboardOverview()", history)
        self.assertIn('streamKey: `persona-data-history:', history)
        self.assertIn('streamTarget: "persona-detail"', history)

    def test_persona_history_mobile_stream_does_not_jump_to_publishing_module(self):
        selection = function_source("renderPublishHistorySelectionList", "renderPublishHistoryPreview")
        history = function_source("renderPersonaHistoryDataContent", "renderPersonaDataPanel")

        self.assertIn('options.streamTarget || "publishing"', selection)
        self.assertIn('streamTarget: "persona-detail"', history)
        self.assertIn("rows.length ?", history)
        self.assertIn("renderPersonaPublishHistoryEmptyState()", history)
        self.assertIn(".persona-profile-platform-metrics small {", CONSOLE_CSS)
        self.assertIn("font-size: 10px;", CONSOLE_CSS)
        self.assertIn("font-size: 13px;", CONSOLE_CSS)
        self.assertIn("font-weight: 500;", CONSOLE_CSS)

    def test_platform_switch_updates_logo_metrics_and_account_settings_together(self):
        linked = function_source("setPersonaContentPlatform", "personaPostContentPlatform")
        account_handler = CONSOLE_JS[
            CONSOLE_JS.index('const personaAccountPlatform = event.target.closest("[data-persona-account-platform]")'):
            CONSOLE_JS.index('const personaAccountOpenLogin = event.target.closest("[data-persona-account-open-login]")')
        ]
        swipe = function_source("bindPersonaAccountPlatformSwipe", "bindAccountPoolAccountToPersona")

        self.assertIn("state.personaAutomationPlatform = nextPlatform", linked)
        self.assertIn("transitionPersonaAccountPlatform(", account_handler)
        self.assertIn("bindAccountPoolPlatformSwipe(host, {", swipe)
        self.assertIn("createPersonaAccountPlatformMotion(persona, next, direction)", swipe)

    def test_persona_history_reuses_dashboard_filters_and_keeps_archive_only_rows_read_only(self):
        filters = function_source("renderPersonaHistoryFilters", "renderPersonaHistoryDataContent")
        history_rows = function_source("personaFilteredHistoryRows", "personaPlatformMetricSummary")
        selection = function_source("renderPublishHistorySelectionList", "renderPublishHistoryPreview")

        self.assertIn('data-persona-history-filter="content"', filters)
        self.assertIn('data-persona-history-filter="sort"', filters)
        self.assertNotIn('data-persona-history-filter="platform"', filters)
        self.assertEqual(filters.count("persona-history-filter-trigger"), 2)
        self.assertIn("renderPersonaHistoryContentFilterIcon()", filters)
        self.assertIn("renderPersonaHistorySortFilterIcon()", filters)
        self.assertIn("const platform = personaContentPlatform(persona);", history_rows)
        self.assertNotIn("filters.platform", history_rows)
        self.assertIn('value="hot_desc"', filters)
        self.assertIn('value="time_desc"', filters)
        self.assertIn('record.__dashboard_metric_only ? ""', selection)

    def test_history_list_preview_uses_one_reach_metric_and_hides_compact_only_fields(self):
        selection = function_source("renderPublishHistorySelectionList", "renderPublishHistoryPreview")
        metrics = function_source("publishHistoryMetricEntries", "formatPublishHistoryMetricUnit")

        self.assertIn(
            'renderPublishHistoryMetrics(record, "publish-history-card-metrics")',
            selection,
        )
        self.assertIn("renderAccountPoolPlatformIcon(platform)", selection)
        self.assertNotIn("renderMediaTypeBadge(mediaItems)", selection)
        self.assertNotIn("publish-history-card-media", selection)
        self.assertNotIn("<strong>${esc(publishHistoryRecordTitle", selection)
        self.assertIn("热度 / 浏览", metrics)
        self.assertNotIn('["浏览", source.views]', metrics)
        self.assertIn(".publish-history-card-metrics", CONSOLE_CSS)
        self.assertIn(
            "grid-template-columns: repeat(5, minmax(0, 1fr));",
            CONSOLE_CSS,
        )
        self.assertIn("-webkit-line-clamp: 2;", CONSOLE_CSS)
        self.assertIn(".publish-history-card-platform", CONSOLE_CSS)
        self.assertIn(".publish-history-card-requeue", CONSOLE_CSS)

    def test_history_detail_places_one_row_of_hot_metrics_before_the_post_content(self):
        detail = function_source("openPublishHistoryRecordModal", "requeuePublishHistoryRecord")

        self.assertIn(
            'renderPublishHistoryMetrics(record, "publish-history-modal-metrics")',
            detail,
        )
        self.assertLess(
            detail.index('renderPublishHistoryMetrics(record, "publish-history-modal-metrics")'),
            detail.index("<p>"),
        )
        self.assertIn(
            ".publish-history-modal-card .publish-history-metrics",
            CONSOLE_CSS,
        )

    def test_history_metric_units_cover_thousands_ten_thousands_millions_and_hundred_millions(self):
        formatter = function_source("publishHistoryMetricText", "renderPublishHistoryMetrics")

        self.assertIn("absolute >= 100000000", formatter)
        self.assertIn('formatPublishHistoryMetricUnit(number, 100000000, "亿")', formatter)
        self.assertIn("absolute >= 1000000", formatter)
        self.assertIn('formatPublishHistoryMetricUnit(number, 1000000, "m")', formatter)
        self.assertIn("absolute >= 10000", formatter)
        self.assertIn('formatPublishHistoryMetricUnit(number, 10000, "w")', formatter)
        self.assertIn("absolute >= 1000", formatter)
        self.assertIn('formatPublishHistoryMetricUnit(number, 1000, "k")', formatter)
        self.assertNotIn('notation: "compact"', formatter)

    def test_publish_history_renders_full_hot_metrics_and_manual_refresh(self):
        preview = function_source("renderPublishHistoryPreview", "renderPublishHistoryPanel")
        metrics = function_source("publishHistoryMetricEntries", "renderPublishHistoryMetrics")
        panel = function_source("renderPublishHistoryPanel", "requeuePublishHistoryRecord")

        self.assertIn("hot_metrics", preview)
        for label in ("热度 / 浏览", "点赞", "评论", "分享", "转发"):
            self.assertIn(label, metrics)
        self.assertIn("data-publish-history-refresh", panel)
        self.assertIn("renderPublishHistoryRefreshContent", panel)
        refresh_content = function_source("renderPublishHistoryRefreshContent", "renderPersonaHistoryFilters")
        self.assertIn("刷新数据", refresh_content)
        self.assertIn("renderRefreshIcon()", refresh_content)

    def test_publish_history_renders_source_link_and_account_mismatch_notice(self):
        selection = function_source("renderPublishHistorySelectionList", "renderPublishHistoryPreview")
        preview = function_source("renderPublishHistoryPreview", "renderPublishHistoryPanel")
        detail = function_source("openPublishHistoryRecordModal", "requeuePublishHistoryRecord")

        self.assertIn("renderPublishHistoryAccountWarning(record)", selection)
        self.assertIn("renderPublishHistoryAccountWarning(activeRecord)", preview)
        self.assertIn("renderPublishHistoryAccountWarning(record)", detail)
        self.assertIn("renderPublishHistorySourceLink(publishedUrl, { showUrl: true })", detail)
        self.assertIn("renderSourceLinkIcon()", selection)
        self.assertIn(".publish-history-source-url", CONSOLE_CSS)
        self.assertIn(".publish-history-account-warning", CONSOLE_CSS)

    def test_manual_hot_refresh_uses_authenticated_source_and_reloads_history(self):
        refresh = function_source("refreshPublishHistoryHotData", "publishGroupSelectionState")

        self.assertIn('api("/api/persona_dashboard/refresh"', refresh)
        self.assertIn('source: "browser"', refresh)
        self.assertIn("/api/persona_dashboard/refresh/${encodeURIComponent(taskId)}", refresh)
        self.assertIn("loadPersonaPublishHistory(cleanPersonaId, { force: true })", refresh)
        self.assertIn("publishHistoryRefreshPersonaId = cleanPersonaId", refresh)
        self.assertIn("syncPublishHistoryRefreshDom", refresh)
        self.assertEqual(refresh.count('renderSimpleFlowModule("publishing")'), 1)

    def test_refresh_progress_is_scoped_to_the_selected_persona(self):
        panel = function_source("renderPublishHistoryPanel", "syncPublishHistoryRefreshDom")
        sync = function_source("syncPublishHistoryRefreshDom", "openPublishHistoryRecordModal")
        self.assertIn("publishHistoryRefreshPersonaId === personaId", panel)
        self.assertIn("ownsRefresh ? state.publishHistoryRefreshStatus : null", panel)
        self.assertIn("data-publish-history-refresh-status", panel)
        self.assertIn("button.innerHTML = renderPublishHistoryRefreshContent", sync)

    def test_sidebar_items_have_theme_aware_dividers(self):
        self.assertIn(".console-page .module-accordion-item + .module-accordion-item", CONSOLE_CSS)
        self.assertIn(".console-page .console-nav > button:not(.nav-parent-toggle)::before", CONSOLE_CSS)
        self.assertIn(".console-page .sidebar-bottom-actions", CONSOLE_CSS)
        self.assertIn("var(--line)", CONSOLE_CSS)
        self.assertIn("pointer-events: none", CONSOLE_CSS)

    def test_full_refresh_script_installs_primary_archive_bridge(self):
        self.assertIn("installNodePersonaArchiveBridge", REFRESH_SCRIPT)
        self.assertIn("installNodePersonaArchiveBridge();", REFRESH_SCRIPT)
        self.assertIn("updatePersonaArchiveThreadsHotMetrics", REFRESH_SCRIPT)
        self.assertIn(".then(() => process.exit(0))", REFRESH_SCRIPT)
        self.assertIn("sentimentAuthStatusIsUsable", REFRESH_SCRIPT)
        self.assertIn('["healthy", "watch"]', REFRESH_SCRIPT)
        self.assertIn("authorizationNeedsRefresh !== true", REFRESH_SCRIPT)
        self.assertIn("withArchiveFileLock", ARCHIVE_STORE)
        self.assertIn("threads_binding_changed", ARCHIVE_STORE)

    def test_publish_history_rejects_unsafe_external_links(self):
        preview = function_source("renderPublishHistoryPreview", "renderPublishHistoryPanel")
        self.assertIn("safeExternalHttpUrl", preview)
        self.assertNotIn('String(activeRecord?.source_url', preview)

    def test_custom_proxy_idempotency_fingerprint_is_not_written_to_dom(self):
        self.assertIn("const accountProxyCustomRequestState = new WeakMap()", CONSOLE_JS)
        self.assertNotIn("dataset.proxyCustomRequestFingerprint", CONSOLE_JS)


if __name__ == "__main__":
    unittest.main()
