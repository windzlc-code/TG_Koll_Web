from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")
CONSOLE_CSS = (ROOT / "webapp" / "static" / "assets" / "console.css").read_text(encoding="utf-8")
REFRESH_SCRIPT = (ROOT / "tool_r18" / "scripts" / "skills" / "persona-dashboard-refresh.ts").read_text(encoding="utf-8")
HOT_IMPORTER = (ROOT / "tool_r18" / "src" / "lib" / "sentiment-hot-importer.ts").read_text(encoding="utf-8")
ARCHIVE_STORE = (ROOT / "tool_r18" / "src" / "runtime" / "node" / "persona-archive-store.ts").read_text(encoding="utf-8")


def function_source(name: str, next_name: str) -> str:
    start = CONSOLE_JS.index(f"function {name}")
    end = CONSOLE_JS.index(f"function {next_name}", start)
    return CONSOLE_JS[start:end]


class ConsolePublishHistoryHotDataTests(unittest.TestCase):
    def test_threads_full_profile_uses_authenticated_bootstrap_and_cursor_pagination(self):
        start = HOT_IMPORTER.index("async function fetchThreadsProfileHotMetricsHttp")
        end = HOT_IMPORTER.index("export async function fetchThreadsProfileLightMetrics", start)
        fetcher = HOT_IMPORTER[start:end]
        authenticated_bootstrap = fetcher[
            fetcher.index("authenticatedResponse = await requestSessionHttpText"):
            fetcher.index("authenticatedProfile = Boolean", fetcher.index("authenticatedResponse = await requestSessionHttpText"))
        ]

        self.assertIn("const response = authenticatedProfile && authenticatedResponse", fetcher)
        self.assertIn("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", authenticated_bootstrap)
        self.assertIn("cookies,", fetcher)
        self.assertIn("cookies: [],", fetcher)
        self.assertIn("paginateThreadsProfileGraphqlPages", fetcher)
        self.assertIn("cookies,\n        proxyUrl: platformProxyUrl(\"threads\"),\n        initialCursor", fetcher)
        self.assertIn("const profilePostSetComplete = authenticatedProfile", fetcher)
        self.assertIn("const complete = profilePostSetComplete && resolvedViews === postMetrics.length", fetcher)
        self.assertNotIn("activeCookies", fetcher)

    def test_post_order_badges_share_the_scaled_mobile_size(self):
        publish_index = CONSOLE_CSS[
            CONSOLE_CSS.index(".publish-post-card-index {"):
            CONSOLE_CSS.index(".publish-post-card-copy span", CONSOLE_CSS.index(".publish-post-card-index {"))
        ]
        generated_index = CONSOLE_CSS[
            CONSOLE_CSS.index(".persona-generated-selection-index,"):
            CONSOLE_CSS.index(".persona-generated-selection-index {", CONSOLE_CSS.index(".persona-generated-selection-index,"))
        ]

        for style in (publish_index, generated_index):
            self.assertIn("width: 19px;", style)
            self.assertIn("min-width: 19px;", style)
            self.assertIn("height: 19px;", style)
            self.assertIn("min-height: 19px;", style)
            self.assertIn("font-size: 9px;", style)

    def test_active_publish_entry_tab_has_distinct_type_scale(self):
        selector = ".console-page .shared-underline-tabs > button.is-active,"
        start = CONSOLE_CSS.index(selector)
        end = CONSOLE_CSS.index(".console-page .shared-underline-tabs > button.is-active::after", start)
        active_style = CONSOLE_CSS[start:end]

        self.assertIn("font-size: 16px;", active_style)
        self.assertIn("font-weight: 900;", active_style)

    def test_publish_sequence_syncs_each_success_without_shortening_later_task_deadlines(self):
        watcher = function_source("watchPersonaPublishTaskSequence", "loadPersonaDraftPosts")
        loop_start = watcher.index("for (const taskId of ids)")

        self.assertIn("syncPublishedPostLocalState(task);", watcher)
        self.assertIn("const startedAt = Date.now();", watcher[loop_start:])
        self.assertIn("personaPublishWatchDeadline(knownTask, startedAt)", watcher)

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
        self.assertNotIn("const metricPublished = metricRows.reduce", metrics)
        self.assertIn("published: publishedRows.length", metrics)
        self.assertIn("return !account;", metrics)
        self.assertIn("人设发布推文", panel)
        self.assertIn("personaHistoryAccountRestrictionNote(persona)", CONSOLE_JS)
        self.assertIn("当前执行账号处于账号封控状态", CONSOLE_JS)
        self.assertIn("renderPersonaPlatformMetricStrip(persona)", identity)
        self.assertIn("renderPersonaPublishHistoryEmptyState", CONSOLE_JS)
        self.assertIn("暂无已发布推文", CONSOLE_JS)
        self.assertIn("发布后将在这里展示", CONSOLE_JS)
        self.assertNotIn('data-persona-data-tab="hot"', CONSOLE_JS)
        self.assertNotIn('data-persona-data-tab="history"', CONSOLE_JS)
        self.assertNotIn("人设历史推文", CONSOLE_JS)
        self.assertIn(".persona-profile-platform-metrics {", CONSOLE_CSS)
        self.assertIn(".persona-history-empty-state {", CONSOLE_CSS)

    def test_persona_history_merges_only_verified_current_account_posts(self):
        dashboard_record = function_source("personaHistoryDashboardMetricRecord", "personaHistoryIdentityKeys")
        identity = function_source("personaHistoryIdentityKeys", "personaHistoryContentCompatible")
        merge = function_source("personaMergedHistoryRows", "personaHistoryContentParts")
        matcher = function_source("personaHistoryRowsMatch", "personaMergedHistoryRows")
        history = function_source("renderPersonaHistoryDataContent", "renderPersonaDataPanel")

        self.assertIn("personaPublishHistoryRows(persona)", merge)
        self.assertIn("personaDashboardDetail(persona)?.post_metrics", merge)
        self.assertIn("personaHistoryRowsMatch", merge)
        self.assertNotIn("record?.account_match?.matches_current !== false", merge)
        self.assertNotIn("merged.push(metric)", merge)
        self.assertIn("personaHistoryRowsMatch(record, metric)", merge)
        self.assertIn("normalizePersonaContentPlatform", matcher)
        self.assertIn("account_id", matcher)
        self.assertIn("account_username", matcher)
        self.assertIn("published_url", identity)
        self.assertIn("personaHistoryContentCompatible", matcher)
        self.assertIn("preferMetric", merge)
        self.assertIn("metricIsNewer", merge)
        self.assertNotIn("Number(currentHot[key] || 0) ||", merge)
        self.assertIn("row?.is_published_post !== true", dashboard_record)
        self.assertIn("published_url: String(row.source_url || \"\").trim()", dashboard_record)
        self.assertNotIn("source_url: String(row.source_url", dashboard_record)
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

        self.assertIn('key: "content"', filters)
        self.assertIn('key: "sort"', filters)
        self.assertIn('data-persona-history-filter-menu', filters)
        self.assertLess(filters.index("renderPublishHistoryToolbarEditMenu"), filters.index("persona-history-filters"))
        self.assertIn('class="persona-history-filter-options"', filters)
        self.assertIn('data-persona-history-filter-option="${key}"', filters)
        self.assertIn("max-height: min(176px, 36dvh);", CONSOLE_CSS)
        self.assertIn("overflow-y: auto;", CONSOLE_CSS)
        self.assertIn(".persona-profile-data-panel:has(.persona-history-filter-menu[open])", CONSOLE_CSS)
        self.assertIn("positionPersonaHistoryFilterMenu", CONSOLE_JS)
        self.assertNotIn('data-persona-history-filter="platform"', filters)
        self.assertIn("renderPersonaHistoryContentFilterIcon()", filters)
        self.assertIn("renderPersonaHistorySortFilterIcon()", filters)
        self.assertIn("const platform = personaContentPlatform(persona);", history_rows)
        self.assertNotIn("filters.platform", history_rows)
        self.assertIn('["hot_desc", "热度最高"]', filters)
        self.assertIn('["time_desc", "发布时间最新"]', filters)
        self.assertNotIn('record.__dashboard_metric_only ? ""', selection)
        self.assertIn("renderPublishHistoryCardEditMenu(recordId)", selection)
        self.assertIn('data-publish-history-requeue="${esc(recordId)}"', function_source("renderPublishHistoryCardEditMenu", "renderPersonaHistoryFilters"))

    def test_publish_history_defaults_to_published_time_and_refresh_cannot_reorder_it(self):
        sorter = function_source("sortPersonaPublishHistory", "personaDraftOptionLabel")
        filtered = function_source("personaFilteredHistoryRows", "personaPlatformMetricSummary")
        filters = function_source("renderPersonaHistoryFilters", "renderPersonaHistoryDataContent")

        self.assertIn("timeValue(publishHistoryRecordTime(left))", sorter)
        self.assertIn("timeValue(publishHistoryRecordTime(right))", sorter)
        self.assertNotIn("Math.max", sorter)
        self.assertIn('const sort = String(filters.sort || "time_desc")', filtered)
        self.assertIn('const defaultValue = key === "content" ? "all" : "time_desc"', filters)
        self.assertGreaterEqual(CONSOLE_JS.count('sort: "time_desc"'), 2)

    def test_history_list_preview_uses_one_reach_metric_and_hides_compact_only_fields(self):
        selection = function_source("renderPublishHistorySelectionList", "renderPublishHistoryPreview")
        metrics = function_source("publishHistoryMetricEntries", "formatPublishHistoryMetricUnit")

        self.assertIn(
            'renderPublishHistoryMetrics(record, "publish-history-card-metrics")',
            selection,
        )
        self.assertIn("renderAccountPoolPlatformIcon(platform)", selection)
        self.assertIn('data-account-platform="${esc(platform)}"', selection)
        self.assertIn('<span>${esc(platformName)}</span>', selection)
        self.assertNotIn("renderMediaTypeBadge(mediaItems)", selection)
        self.assertNotIn("publish-history-card-media", selection)
        self.assertNotIn("<strong>${esc(publishHistoryRecordTitle", selection)
        self.assertIn('"浏览"', metrics)
        self.assertNotIn('["浏览", source.views]', metrics)
        self.assertIn(".publish-history-card-metrics", CONSOLE_CSS)
        self.assertIn(
            "grid-template-columns: repeat(5, minmax(0, 1fr));",
            CONSOLE_CSS,
        )
        self.assertIn("-webkit-line-clamp: 2;", CONSOLE_CSS)
        self.assertIn(".publish-history-card-platform", CONSOLE_CSS)
        self.assertIn(".publish-history-card-requeue", CONSOLE_CSS)
        self.assertIn("renderPublishHistoryCardEditMenu(recordId)", selection)
        self.assertIn("<span>重回草稿</span>", function_source("renderPublishHistoryCardEditMenu", "renderPersonaHistoryFilters"))
        mobile_history_start = CONSOLE_CSS.index(".publish-history-card {\n    content-visibility: auto;")
        mobile_action_start = CONSOLE_CSS.index(".publish-history-card-action {", mobile_history_start)
        mobile_action_end = CONSOLE_CSS.index("}", mobile_action_start)
        mobile_action_style = CONSOLE_CSS[mobile_action_start:mobile_action_end]
        self.assertEqual(mobile_action_style.count("32px"), 4)
        mobile_requeue_start = CONSOLE_CSS.index(".publish-history-card-requeue {", mobile_action_end)
        mobile_requeue_end = CONSOLE_CSS.index("}", mobile_requeue_start)
        mobile_requeue_style = CONSOLE_CSS[mobile_requeue_start:mobile_requeue_end]
        self.assertIn("width: auto;", mobile_requeue_style)
        self.assertIn("min-width: max-content;", mobile_requeue_style)
        self.assertIn("padding: 0 7px;", mobile_requeue_style)
        self.assertIn(
            ':is(.account-pool-card, .publish-history-card)[data-account-platform="threads"] .account-pool-card-platform',
            CONSOLE_CSS,
        )
        self.assertIn(
            ':is(.account-pool-card, .publish-history-card)[data-account-platform="instagram"] .account-pool-card-platform',
            CONSOLE_CSS,
        )

    def test_history_mobile_card_places_tweet_before_hot_metrics(self):
        mobile_start = CONSOLE_CSS.index("@media (max-width: 760px)")
        mobile = CONSOLE_CSS[mobile_start:]
        snippet_start = mobile.index(".publish-history-card .publish-post-card-snippet {")
        snippet_end = mobile.index("}", snippet_start)
        metrics_start = mobile.index(".publish-history-card .publish-history-card-metrics {", snippet_start)
        metrics_end = mobile.index("}", metrics_start)

        self.assertIn("grid-row: 2;", mobile[snippet_start:snippet_end])
        self.assertIn("grid-row: 4;", mobile[metrics_start:metrics_end])

    def test_persona_history_desktop_keeps_actions_top_right_of_original_copy(self):
        panel_start = CONSOLE_CSS.index(".persona-history-data-panel .publish-history-card-main {")
        panel_end = CONSOLE_CSS.index(".console-page .persona-history-data-panel .publish-history-card-action,", panel_start)
        panel = CONSOLE_CSS[panel_start:panel_end]
        base_start = CONSOLE_CSS.index(".publish-history-card-main {\n  display: grid;")
        base_end = CONSOLE_CSS.index("}", CONSOLE_CSS.index("grid-template-columns:", base_start))
        base = CONSOLE_CSS[base_start:base_end + 1]

        self.assertIn("grid-template-columns: 28px minmax(0, 1fr);", base)
        self.assertNotIn("@media", CONSOLE_CSS[CONSOLE_CSS.rfind("}", 0, panel_start):panel_start])
        self.assertIn("grid-template-columns: 18px 28px minmax(0, 1fr) auto;", panel)
        self.assertIn("display: contents;", panel)
        warning_start = panel.index(".persona-history-data-panel .publish-history-card .publish-history-account-warning {")
        warning_end = panel.index("}", warning_start)
        self.assertIn("grid-row: 3;", panel[warning_start:warning_end])
        self.assertIn("grid-column: 3 / -1;", panel[warning_start:warning_end])
        actions_start = panel.index(".persona-history-data-panel .publish-history-card-actions {")
        actions_end = panel.index("}", actions_start)
        self.assertIn("grid-column: 4;", panel[actions_start:actions_end])
        self.assertIn("grid-row: 1;", panel[actions_start:actions_end])

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
        for label in ("浏览", "点赞", "评论", "分享", "转发"):
            self.assertIn(label, metrics)
        self.assertIn("data-publish-history-refresh", panel)
        self.assertIn("renderPublishHistoryToolbarEditMenu", panel)
        toolbar_edit = function_source("renderPublishHistoryToolbarEditMenu", "renderPublishHistoryCardEditMenu")
        self.assertNotIn("data-publish-history-recognize", toolbar_edit)
        self.assertIn("data-publish-history-select-all", toolbar_edit)
        self.assertIn("data-publish-history-clear-selection", toolbar_edit)
        self.assertIn("data-publish-history-delete-selected", toolbar_edit)
        self.assertNotIn("自动识别", toolbar_edit)
        self.assertIn("全选", toolbar_edit)
        self.assertIn("清空", toolbar_edit)
        self.assertIn("renderMoreIcon()", toolbar_edit)
        self.assertIn("persona-history-filter-icon", toolbar_edit)
        self.assertIn("renderSelectAllIcon()", toolbar_edit)
        self.assertIn("renderClearSelectionIcon()", toolbar_edit)
        self.assertIn("renderTrashIcon()", toolbar_edit)
        self.assertIn('popover.style.position = "fixed"', function_source("positionPublishHistoryEditMenu", "renderPersonaHistoryFilters"))
        self.assertIn("data-publish-history-toolbar-edit", toolbar_edit)
        self.assertIn("renderPublishHistoryRefreshContent", panel)
        refresh_content = function_source("renderPublishHistoryRefreshContent", "renderPersonaHistoryFilters")
        self.assertIn("刷新数据", refresh_content)
        self.assertIn("renderRefreshIcon()", refresh_content)

    def test_publish_history_renders_published_link_and_account_mismatch_notice(self):
        selection = function_source("renderPublishHistorySelectionList", "renderPublishHistoryPreview")
        preview = function_source("renderPublishHistoryPreview", "renderPublishHistoryPanel")
        detail = function_source("openPublishHistoryRecordModal", "requeuePublishHistoryRecord")

        self.assertIn("renderPublishHistoryAccountWarning(record)", selection)
        self.assertIn("renderPublishHistoryAccountWarning(activeRecord)", preview)
        self.assertIn("renderPublishHistoryAccountWarning(record)", detail)
        self.assertIn("renderPublishHistorySourceLink(publishedUrl, { showUrl: true, accountId: record.account_id || \"\" })", detail)
        self.assertIn('data-account-public-link="${esc(record.account_id || "")}"', selection)
        self.assertIn("safeExternalHttpUrl(record.published_url)", selection)
        self.assertIn("safeExternalHttpUrl(activeRecord?.published_url)", preview)
        self.assertIn("safeExternalHttpUrl(record.published_url)", detail)
        self.assertNotIn("record.source_url ||", selection)
        self.assertNotIn("activeRecord?.source_url ||", preview)
        self.assertIn("renderSourceLinkIcon()", selection)
        self.assertIn("renderPublishHistoryCardEditMenu(recordId)", selection)
        card_edit = function_source("renderPublishHistoryCardEditMenu", "renderPersonaHistoryFilters")
        self.assertIn("data-publish-history-delete", card_edit)
        self.assertIn("data-publish-history-card-edit", card_edit)
        self.assertIn("renderMoreIcon()", card_edit)
        self.assertIn("renderRequeueIcon()", card_edit)
        self.assertIn("data-publish-history-bulk-id", selection)
        self.assertIn("renderTrashIcon()", card_edit)
        self.assertIn(".publish-history-source-url", CONSOLE_CSS)
        self.assertIn(".publish-history-account-warning", CONSOLE_CSS)

    def test_unpublished_hot_draft_keeps_original_post_link(self):
        hot_origin = function_source("renderPersonaHotOrigin", "renderPersonaHotMetricStrip")

        self.assertIn("meta.source_url", hot_origin)
        self.assertIn("查看原帖", hot_origin)

    def test_publish_history_does_not_render_missing_views_as_zero(self):
        entries = function_source("publishHistoryMetricEntries", "formatPublishHistoryMetricUnit")
        metric_text = function_source("publishHistoryMetricText", "renderPublishHistoryMetrics")

        self.assertIn('source.views_available === false', entries)
        self.assertIn('viewUnavailable\n    ? null', entries)
        self.assertNotIn('source.matched === true ? "不适用" : null', entries)
        self.assertIn('["浏览",', entries)
        self.assertNotIn('source.views ?? source.hot_score', entries)
        self.assertIn('value === null', metric_text)
        self.assertIn('return "—"', metric_text)
        self.assertNotIn('"未获取"', metric_text)
        self.assertNotIn('"不适用"', metric_text)
        rendered_metrics = function_source("renderPublishHistoryMetrics", "publishHistoryAccountWarning")
        self.assertIn('value === null ? "—"', rendered_metrics)
        self.assertNotIn('"未获取"', rendered_metrics)
        dashboard_record = function_source("personaHistoryDashboardMetricRecord", "personaHistoryIdentityKeys")
        self.assertIn("complete: row.view_available === true", dashboard_record)

    def test_manual_refresh_only_targets_the_current_bound_threads_account(self):
        start = REFRESH_SCRIPT.index("function collectThreadsRefreshTargets")
        end = REFRESH_SCRIPT.index("function collectInstagramRefreshTargets", start)
        targets = REFRESH_SCRIPT[start:end]

        self.assertIn("binding.archiveId", targets)
        self.assertIn("archive?.id", targets)
        self.assertIn("if (currentBindings.length) return currentBindings;", targets)
        self.assertNotIn('source: "legacy_binding"', targets)
        self.assertIn("当前 Threads 没有绑定账号，无法刷新热点数据", REFRESH_SCRIPT)
        self.assertIn("页面上的数字是上次留下的缓存", REFRESH_SCRIPT)
        self.assertIn("const skippedOnly = results.length > 0 && results.every((item) => item.skipped);", REFRESH_SCRIPT)
        self.assertIn("threadsAccountPoolBindingIsCurrent", REFRESH_SCRIPT)
        self.assertIn("PERSONA_DASHBOARD_PREFETCHED_METRICS_B64", REFRESH_SCRIPT)
        self.assertIn("prefetchedProfileMetrics", REFRESH_SCRIPT)
        self.assertIn('prefetchedProfileMetrics("threads", username)', REFRESH_SCRIPT)
        self.assertIn("prefetched && isCompleteMetrics(prefetched)", REFRESH_SCRIPT)
        self.assertIn("const localMetrics = await fetchThreadsProfileHotMetrics(username);", REFRESH_SCRIPT)
        self.assertIn("postMetrics.length === scannedPosts", REFRESH_SCRIPT)
        self.assertIn("resolvedViews === postMetrics.length", REFRESH_SCRIPT)
        self.assertIn("Number(metrics?.viewMissingPosts || 0) === 0", REFRESH_SCRIPT)
        self.assertIn("fillMissingProfileIdentityMetrics", REFRESH_SCRIPT)
        self.assertIn("profileIdentityMetricPatch", REFRESH_SCRIPT)
        self.assertIn("fetchThreadsProfileIdentityMetrics", REFRESH_SCRIPT)
        self.assertIn("recentViewsWithPostFallback", REFRESH_SCRIPT)
        self.assertNotIn("PERSONA_DASHBOARD_COLLECTOR_HTTP_ONLY", REFRESH_SCRIPT)
        self.assertNotIn("missingCollectorProfileMetrics", REFRESH_SCRIPT)
        self.assertIn('replaceLegacyHandle: target.source === "account_pool"', REFRESH_SCRIPT)
        self.assertNotIn("archive?.publishHistory", targets)
        self.assertNotIn('"publish_history"', targets)
        self.assertNotIn("allowAdditionalHandle", REFRESH_SCRIPT)

        backfill_start = REFRESH_SCRIPT.index("async function backfillPublishedThreadsPostMetrics")
        backfill_end = REFRESH_SCRIPT.index("async function fetchThreadsProfileHotMetricsViaRssHub", backfill_start)
        backfill = REFRESH_SCRIPT[backfill_start:backfill_end]
        self.assertIn("postViewCount > 0 || postInteractions === 0", backfill)

        threads_refresh_start = REFRESH_SCRIPT.index("const key = hotMetricKey(username)")
        threads_refresh_end = REFRESH_SCRIPT.index("if (complete) nextMetric.snapshots", threads_refresh_start)
        threads_refresh = REFRESH_SCRIPT[threads_refresh_start:threads_refresh_end]
        self.assertIn("const hasFreshPostMetrics = complete && Array.isArray(metrics.postMetrics);", threads_refresh)
        self.assertIn("metrics.postMetrics.map((row: any) => ({ ...row }))", threads_refresh)
        self.assertNotIn("mergePostMetrics(previousMetrics, metrics.postMetrics)", threads_refresh)
        self.assertNotIn("await backfillPublishedThreadsPostMetrics", threads_refresh)
        self.assertIn("refreshedAt: metrics.refreshedAt", threads_refresh)
        self.assertIn("未更新帖子数据", threads_refresh)
        self.assertIn("ok: usable", REFRESH_SCRIPT)

    def test_manual_hot_refresh_uses_authenticated_source_and_reloads_history(self):
        refresh = function_source("refreshPublishHistoryHotData", "cancelPublishHistoryHotRefresh")

        self.assertIn('api("/api/persona_dashboard/refresh"', refresh)
        self.assertIn("personaHotRefreshBlockedReason(persona)", refresh)
        self.assertIn("chineseRefreshMessage", refresh)
        self.assertIn('source: "http_first"', refresh)
        self.assertIn("platform: personaContentPlatform(persona)", refresh)
        self.assertIn('argValue("platform")', REFRESH_SCRIPT)
        self.assertIn("requestedPlatform !== \"instagram\"", REFRESH_SCRIPT)
        self.assertIn("requestedPlatform !== \"threads\"", REFRESH_SCRIPT)
        self.assertIn("/api/persona_dashboard/refresh/${encodeURIComponent(taskId)}", refresh)
        self.assertIn("loadPersonaPublishHistory(cleanPersonaId, { force: true })", refresh)
        self.assertNotIn("backfillHistory", refresh)
        self.assertNotIn("publish_history/recognize", refresh)
        self.assertNotIn("function recognizePublishHistoryRecord", CONSOLE_JS)
        self.assertIn("publishHistoryRefreshPersonaId = cleanPersonaId", refresh)
        self.assertIn("syncPublishHistoryRefreshDom", refresh)
        self.assertEqual(refresh.count('renderSimpleFlowModule("publishing")'), 1)

    def test_publish_history_edit_menu_selects_visible_rows_and_can_clear_selection(self):
        selection = function_source("syncPublishHistoryBulkSelection", "deletePublishHistoryRecords")
        toolbar = function_source("renderPublishHistoryToolbarEditMenu", "renderPublishHistoryCardEditMenu")

        self.assertIn("function setPublishHistoryBulkSelection", selection)
        self.assertIn("visibleRecordIds", toolbar)
        self.assertIn("data-publish-history-select-all", CONSOLE_JS)
        self.assertIn("data-publish-history-clear-selection", CONSOLE_JS)
        self.assertIn("setPublishHistoryBulkSelection(personaFilteredHistoryRows(selectedPersona())", CONSOLE_JS)
        self.assertIn("setPublishHistoryBulkSelection([], false)", CONSOLE_JS)

    def test_publish_history_heat_sort_uses_all_visible_engagement_metrics(self):
        sort_value = function_source("personaHistorySortValue", "personaFilteredHistoryRows")
        filtered = function_source("personaFilteredHistoryRows", "personaPlatformMetricSummary")

        self.assertIn("metrics.hot_score", sort_value)
        for metric in ("views", "likes", "comments", "shares", "reposts"):
            self.assertIn(f"metrics.{metric}", sort_value)
        self.assertIn('const direction = sort.endsWith("_asc") ? 1 : -1;', filtered)
        self.assertIn("return difference * direction;", filtered)

    def test_refresh_progress_shows_a_cancel_button_beside_the_busy_control(self):
        filters = function_source("renderPersonaHistoryFilters", "renderPersonaHistoryDataContent")
        cancel = function_source("cancelPublishHistoryHotRefresh", "publishGroupSelectionState")
        self.assertIn("renderPublishHistoryRefreshCancel(refreshing)", filters)
        self.assertIn("data-publish-history-refresh-cancel", CONSOLE_JS)
        self.assertIn("/api/persona_dashboard/refresh/${encodeURIComponent(taskId)}/cancel", cancel)
        self.assertIn(".persona-history-refresh-cancel {", CONSOLE_CSS)

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
