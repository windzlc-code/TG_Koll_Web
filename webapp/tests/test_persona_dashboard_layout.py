import re
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

import webapp.server as server

REPO_ROOT = Path(__file__).resolve().parents[2]
STATIC_ROOT = REPO_ROOT / "webapp" / "static"


class PersonaDashboardLayoutContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.markup = (STATIC_ROOT / "console.html").read_text(encoding="utf-8")
        cls.console_script = (STATIC_ROOT / "assets" / "console.js").read_text(encoding="utf-8")
        cls.dashboard_script = (STATIC_ROOT / "assets" / "persona-dashboard.js").read_text(encoding="utf-8")
        cls.styles = (STATIC_ROOT / "assets" / "console.css").read_text(encoding="utf-8")
        cls.dashboard_styles = (STATIC_ROOT / "assets" / "style.css").read_text(encoding="utf-8")
        cls.navigation_styles = (
            STATIC_ROOT / "assets" / "opc" / "site-navigation.css"
        ).read_text(encoding="utf-8")

    def test_refresh_controls_are_in_the_dashboard_view(self):
        dashboard_start = self.markup.index(
            '<section class="view persona-dashboard-view" data-panel="persona_dashboard">'
        )
        dashboard = self.markup[dashboard_start:]

        self.assertNotIn('<header class="console-topbar">', self.markup)
        self.assertIn('id="viewTitle" class="sr-only"', self.markup)
        self.assertIn('id="personaDashboardTopbarActions"', dashboard)
        self.assertIn('id="btnPersonaDashboardRefresh"', dashboard)
        self.assertIn('id="btnPersonaDashboardRefreshAll"', dashboard)
        self.assertNotIn('class="persona-dashboard-hero"', dashboard)
        self.assertIn(
            'personaTopbarActions.hidden = view !== "persona_dashboard";',
            self.console_script,
        )

    def test_empty_persona_workspace_has_a_mobile_first_run_guide_without_replacing_selection_copy(self):
        self.assertIn("personaOverviewLoaded: false", self.console_script)
        self.assertIn("state.personaOverviewLoaded = true", self.console_script)
        self.assertIn("persona-first-run-empty", self.console_script)
        self.assertIn("先创建你的第一个人设", self.console_script)
        self.assertIn("创建第一个人设", self.console_script)
        self.assertIn("请选择一个人设", self.console_script)
        self.assertIn(".console-page .persona-first-run-empty", self.styles)
        self.assertIn(".console-page .persona-detail .persona-first-run-actions button", self.styles)
        self.assertIn("width: min(100%, 300px);", self.styles)
        self.assertIn("min-height: 52px;", self.styles)

    def test_legacy_persona_automation_panel_is_fully_removed(self):
        self.assertNotIn("社媒自动化执行", self.dashboard_script)
        self.assertNotIn("pdRenderAutomationPanel", self.dashboard_script)
        self.assertNotIn("pdLoadAutomationOverview", self.dashboard_script)
        self.assertNotIn("persona-auto-", self.dashboard_script)
        self.assertNotIn("persona-auto-", self.dashboard_styles)
        self.assertNotIn("persona-strategy-", self.dashboard_styles)

    def test_dashboard_uses_account_pool_platform_picker_aligned_with_persona_data_without_legacy_filters_or_binding_form(self):
        dashboard_start = self.markup.index(
            '<section class="view persona-dashboard-view" data-panel="persona_dashboard">'
        )
        dashboard = self.markup[dashboard_start:]

        self.assertIn('id="personaDashboardPlatformTabs"', dashboard)
        self.assertIn("persona-dashboard-top-controls", dashboard)
        self.assertIn('id="personaDashboardTabs"', dashboard)
        self.assertNotIn('>平台<', dashboard)
        self.assertLess(
            dashboard.index("persona-dashboard-top-controls"),
            dashboard.index('id="personaDashboardMsg"'),
        )
        self.assertNotIn("personaDashboardSearch", dashboard)
        self.assertNotIn("personaDashboardRange", dashboard)
        self.assertNotIn('id="personaDashboardPlatform"', dashboard)

        self.assertIn("function pdRenderDashboardPlatformTabs(data)", self.dashboard_script)
        self.assertIn('id="personaDashboardPlatformPickerTrigger"', self.dashboard_script)
        self.assertIn("account-pool-platforms account-pool-platform-tabs persona-dashboard-platform-options", self.dashboard_script)
        self.assertIn("data-persona-dashboard-platform-option", self.dashboard_script)
        self.assertIn("pdPlatformIcon(platform)", self.dashboard_script)
        self.assertIn("platforms.map(renderPlatformOption)", self.dashboard_script)
        self.assertNotIn("pdBindThreads", self.dashboard_script)
        self.assertNotIn("pdUnbindThreads", self.dashboard_script)
        self.assertNotIn("persona-account-compact", self.dashboard_script)
        self.assertNotIn("personaDashboardAccountPlatform", self.dashboard_script)
        self.assertIn("persona-dashboard-platform-filter", self.styles)
        self.assertIn("persona-dashboard-top-controls", self.styles)
        self.assertIn("persona-dashboard-platform-trigger", self.styles)
        self.assertIn("persona-dashboard-platform-options", self.styles)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr));", self.styles)
        self.assertIn(".persona-dashboard-view .persona-dashboard-platform-menu", self.styles)
        self.assertIn("min-height: 50px;", self.styles)

    def test_platform_tabs_keep_the_full_persona_archive_visible(self):
        matcher_start = self.dashboard_script.index("function pdMatches()")
        matcher_end = self.dashboard_script.index("\nfunction pdRenderSummary", matcher_start)
        matcher = self.dashboard_script[matcher_start:matcher_end]

        self.assertIn("Platform tabs refine platform-specific posts and engagement only.", matcher)
        self.assertIn("return true;", matcher)
        self.assertNotIn("pdPlatformFilter()", matcher)
        self.assertIn("const visible = (data.personas || []).filter(pdMatches);", self.dashboard_script)

    def test_platform_tabs_filter_only_platform_metrics_not_global_archive_counts(self):
        summary_start = self.dashboard_script.index("function pdRenderSummary(data, visiblePersonas)")
        summary_end = self.dashboard_script.index("\nfunction pdPersonaWarnings", summary_start)
        summary = self.dashboard_script[summary_start:summary_end]
        charts_start = self.dashboard_script.index("function pdBuildFilteredCharts(visiblePersonas, data)")
        charts_end = self.dashboard_script.index("\nfunction pdMatches", charts_start)
        charts = self.dashboard_script[charts_start:charts_end]

        self.assertIn("全局人设归档，不受平台切换影响", summary)
        self.assertIn("全局归档帖子，不受平台切换影响", summary)
        self.assertIn("全局发布归档，不受平台切换影响", summary)
        self.assertIn("const selectedPlatform = pdPlatformFilter();", charts)
        self.assertIn("data.charts.platform_trend[selectedPlatform]", charts)
        self.assertIn("const platforms = (persona.hot_platforms || []).filter", charts)
        self.assertIn("value: pdPersonaHot(item).hot_score", self.dashboard_script)

    def test_dashboard_summary_and_persona_tabs_stay_compact_on_mobile(self):
        summary_start = self.dashboard_script.index("function pdRenderSummary(data, visiblePersonas)")
        summary_end = self.dashboard_script.index("\nfunction pdPersonaWarnings", summary_start)
        summary = self.dashboard_script[summary_start:summary_end]

        self.assertIn('class="kpi persona-kpi" title=', summary)
        self.assertNotIn('<div class="small">${pdEscape(card.hint)}</div>', summary)
        self.assertIn("display: flex;", self.styles)
        self.assertIn("grid-template-columns: 1fr;", self.styles)
        self.assertIn("overflow: visible;", self.styles)
        self.assertIn("width: 116px;", self.styles)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr));", self.styles)
        self.assertIn(".persona-dashboard-view .persona-chart-panel-wide {", self.styles)

    def test_persona_hot_detail_keeps_all_metrics_in_a_compact_grid(self):
        detail_start = self.dashboard_script.index("function pdPersonaWarnings(persona)")
        detail_end = self.dashboard_script.index("\nfunction pdPersonaKey", detail_start)
        detail = self.dashboard_script[detail_start:detail_end]

        self.assertIn('class="persona-warning-summary"', detail)
        self.assertIn('class="persona-detail-grid persona-detail-grid--compact"', detail)
        self.assertIn("const metrics = [", detail)
        self.assertIn("metrics.map((metric)", detail)
        self.assertIn("hot.recent_views", detail)
        self.assertIn("hot.post_views", detail)
        self.assertNotIn('class="persona-platform-list"', detail)
        self.assertNotIn('class="persona-content-preview"', detail)
        self.assertIn(".persona-detail-grid--compact", self.styles)

    def test_dashboard_metric_units_match_publish_history_units(self):
        number_start = self.dashboard_script.index("function pdNumber(value)")
        number_end = self.dashboard_script.index("\nfunction pdDate", number_start)
        formatter = self.dashboard_script[number_start:number_end]

        self.assertIn('pdFormatMetricUnit(n, 100000000, "亿")', formatter)
        self.assertIn('pdFormatMetricUnit(n, 1000000, "m")', formatter)
        self.assertIn('pdFormatMetricUnit(n, 10000, "w")', formatter)
        self.assertIn('pdFormatMetricUnit(n, 1000, "k")', formatter)
        self.assertNotIn('"万"', formatter)

    def test_post_cards_and_detail_split_reposts_from_shares_without_extra_heading(self):
        card_start = self.dashboard_script.index("function pdRenderPersonaCard(persona)")
        card_end = self.dashboard_script.index("\nfunction pdPersonaKey", card_start)
        row_start = self.dashboard_script.index("function pdRenderPostTableRow(row)")
        row_end = self.dashboard_script.index("\nfunction pdRenderMobilePostStreamStatus", row_start)
        card = self.dashboard_script[row_start:row_end] + self.dashboard_script[card_start:card_end]
        modal_start = self.dashboard_script.index("function pdRenderPostModal(persona)")
        modal_end = self.dashboard_script.index("\nfunction pdRenderPersonaTabs", modal_start)
        modal = self.dashboard_script[modal_start:modal_end]

        self.assertNotIn("<strong>发送推文指标</strong>", card)
        self.assertIn('data-label="转发">${pdEscape(pdNumber(row.repost_count))}', card)
        self.assertIn('data-label="分享">${pdEscape(pdNumber(row.share_count))}', card)
        self.assertNotIn('data-label="转发/分享"', card)
        self.assertIn('value="reposts_desc"', card)
        self.assertIn('value="shares_desc"', card)
        self.assertIn("<span>转发</span>", modal)
        self.assertIn("<span>分享</span>", modal)
        self.assertNotIn("<span>转发/分享</span>", modal)

    def test_mobile_dashboard_keeps_five_hot_metrics_and_post_metrics_in_compact_rows(self):
        mobile_start = self.styles.index("@media (max-width: 760px) {")
        mobile_styles = self.styles[mobile_start:]

        self.assertIn(
            ".persona-dashboard-view .persona-detail-grid--compact {\n"
            "    grid-template-columns: repeat(5, minmax(0, 1fr));",
            mobile_styles,
        )
        self.assertIn('"platform platform platform time actions"', mobile_styles)
        self.assertIn("grid-template-columns: repeat(5, minmax(0, 1fr));", mobile_styles)
        self.assertIn('"source source source source source"', mobile_styles)
        self.assertIn('"likes comments reposts shares views"', mobile_styles)
        self.assertIn('"meta-top meta-top meta-top meta-top meta-top"', mobile_styles)
        self.assertIn('"meta-bottom meta-bottom meta-bottom meta-bottom meta-bottom"', mobile_styles)
        self.assertIn("grid-area: meta-top;", mobile_styles)
        self.assertIn("grid-area: meta-bottom;", mobile_styles)
        self.assertIn(".persona-dashboard-view .persona-post-table td:nth-child(n + 4):nth-child(-n + 8) {", mobile_styles)
        self.assertIn(".persona-dashboard-view .persona-post-table td:nth-child(-n + 3)::before {", mobile_styles)
        self.assertIn("display: none;", mobile_styles)
        self.assertIn(".persona-dashboard-view .persona-post-content-badges {", mobile_styles)

    def test_mobile_post_filters_stay_inline_and_post_rows_need_no_horizontal_scroll(self):
        card_start = self.dashboard_script.index("function pdRenderPersonaCard(persona)")
        card_end = self.dashboard_script.index("\nfunction pdPersonaKey", card_start)
        row_start = self.dashboard_script.index("function pdRenderPostTableRow(row)")
        row_end = self.dashboard_script.index("\nfunction pdRenderMobilePostStreamStatus", row_start)
        card = self.dashboard_script[row_start:row_end] + self.dashboard_script[card_start:card_end]

        self.assertIn('data-label="平台"', card)
        self.assertIn('data-label="推文内容"', card)
        self.assertIn('data-label="发布时间"', card)
        self.assertIn('class="persona-post-platform-name"', card)
        self.assertIn('class="persona-post-platform" data-label="平台"', card)
        self.assertIn('class="persona-post-empty"', card)
        self.assertIn(".persona-dashboard-view .persona-post-controls {", self.styles)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr));", self.styles)
        self.assertIn(".persona-dashboard-view .persona-table-wrap {", self.styles)
        self.assertIn(".persona-dashboard-view .persona-post-table thead {", self.styles)
        self.assertIn(".persona-dashboard-view .persona-post-platform .persona-post-content-badges {", self.styles)
        self.assertIn("overflow: visible;", self.styles)

    def test_platform_picker_closes_on_outside_click_and_filter_summary_is_not_rendered(self):
        binder_start = self.dashboard_script.index("function pdBindDashboard(root)")
        binder_end = self.dashboard_script.index("\nfunction pdMountDashboard", binder_start)
        binder = self.dashboard_script[binder_start:binder_end]

        self.assertIn('document.addEventListener("click"', binder)
        self.assertIn('".persona-dashboard-platform-picker"', binder)
        self.assertIn('event.key === "Escape"', binder)
        self.assertIn("pdCloseDashboardPlatformPicker();", binder)
        self.assertNotIn("function pdCurrentPostFilterText()", self.dashboard_script)
        self.assertIn(".persona-post-actions .persona-post-delete {", self.dashboard_styles)
        delete_styles = self.dashboard_styles[self.dashboard_styles.index(".persona-post-delete {"):self.dashboard_styles.index(".persona-post-delete .ui-trash-icon {")]
        self.assertIn("border: 0;", delete_styles)
        self.assertNotIn("border: 1px solid #ef4444;", delete_styles)

    def test_platform_picker_trigger_does_not_reclose_from_the_same_click(self):
        picker_start = self.dashboard_script.index("function pdRenderDashboardPlatformTabs(data)")
        picker_end = self.dashboard_script.index(
            "\nfunction pdCloseDashboardPlatformPicker",
            picker_start,
        )
        picker = self.dashboard_script[picker_start:picker_end]

        self.assertIn(
            'pdEl("personaDashboardPlatformPickerTrigger")?.addEventListener("click", (event) => {',
            picker,
        )
        self.assertIn("event.stopPropagation();", picker)

    def test_persona_heat_ranking_is_sorted_from_high_to_low(self):
        chart_start = self.dashboard_script.index("function pdRenderBarChart(hostId, rows)")
        chart_end = self.dashboard_script.index("\nfunction pdRenderDonutChart", chart_start)
        chart = self.dashboard_script[chart_start:chart_end]

        self.assertIn(
            ".sort((left, right) => Number(right.value || 0) - Number(left.value || 0))",
            chart,
        )

    def test_post_detail_prefers_backend_preview_urls_and_does_not_render_schema_field_names(self):
        media_start = self.dashboard_script.index("function pdPostMediaItems(row)")
        media_end = self.dashboard_script.index("\nfunction pdPostComposition", media_start)
        media = self.dashboard_script[media_start:media_end]
        render_start = self.dashboard_script.index("function pdRenderPostMedia(row)")
        render_end = self.dashboard_script.index("\nfunction pdRenderPostGallery", render_start)
        renderer = self.dashboard_script[render_start:render_end]

        self.assertIn("item.preview_url || item.previewUrl", media)
        self.assertIn("original_url: rawUrl", media)
        self.assertIn("url: pdAdminWorkspaceUrl(previewUrl || (item.unavailable ? \"\" : rawUrl))", media)
        self.assertIn("genericLabel", media)
        self.assertIn("item.unavailable || !url", renderer)
        self.assertIn("persona-post-media-unavailable", renderer)
        self.assertIn(".persona-post-modal {\n  position: fixed;\n  inset: 0;\n  z-index: 6000;", self.dashboard_styles)

    def test_dashboard_media_uses_owner_scoped_route_and_hides_uncached_external_urls(self):
        row = {"id": "metric-1", "content": "same post"}
        post = {
            "id": "post-1",
            "content": "same post",
            "mediaItems": [{"url": "/tmp/post-1.jpg", "type": "image"}],
            "sourceMeta": {"originalMediaUrls": ["https://cdn.example.invalid/old.jpg"]},
        }

        items, context = server._related_dashboard_media_context(row, [post], [])

        self.assertEqual(context, {"post_id": "post-1", "source": "posts"})
        self.assertEqual([item["url"] for item in items], ["/tmp/post-1.jpg"])
        external = server._previewable_persona_media_items(
            [{"url": "https://cdn.example.invalid/old.jpg", "type": "image"}],
            archive_id="persona-1",
            allow_external=False,
        )
        self.assertTrue(external[0]["unavailable"])
        self.assertEqual(external[0]["reason"], "媒体未缓存到本地")

    def test_mobile_metric_context_wraps_without_ellipsis(self):
        title_start = self.styles.index(".persona-dashboard-view .persona-table-title {")
        title_end = self.styles.index(".persona-dashboard-view .persona-post-controls {", title_start)
        title_styles = self.styles[title_start:title_end]

        self.assertIn("white-space: normal;", title_styles)
        self.assertIn("overflow-wrap: anywhere;", title_styles)
        self.assertNotIn("text-overflow: ellipsis;", title_styles)

    def test_persona_data_selection_uses_a_common_modal_instead_of_a_horizontal_rail(self):
        renderer_start = self.dashboard_script.index("function pdRenderPersonaTabs(visiblePersonas, selectedPersona)")
        renderer_end = self.dashboard_script.index("\nfunction pdRenderSettings", renderer_start)
        renderer = self.dashboard_script[renderer_start:renderer_end]

        self.assertIn('id="personaDashboardPickerTrigger"', renderer)
        self.assertNotIn('class="persona-tab-list"', renderer)
        self.assertIn("function pdOpenPersonaDashboardPicker", renderer)
        self.assertIn('modalKey: "persona-dashboard-picker"', renderer)
        self.assertIn("data-dashboard-persona-picker", renderer)
        self.assertIn(".persona-dashboard-picker-trigger", self.styles)
        self.assertIn(".persona-dashboard-persona-control .persona-dashboard-picker-trigger strong", self.styles)
        self.assertIn("text-overflow: ellipsis;", self.styles)
        self.assertIn("white-space: nowrap;", self.styles)
        self.assertIn('data-modal-key="persona-dashboard-picker"', self.styles)

    def test_persona_picker_uses_consistent_cards_with_grouped_sections(self):
        picker_start = self.dashboard_script.index("function pdOpenPersonaDashboardPicker")
        picker_end = self.dashboard_script.index("\nfunction pdRenderSettings", picker_start)
        picker = self.dashboard_script[picker_start:picker_end]

        self.assertIn("persona-dashboard-picker-section--overview", picker)
        self.assertIn("persona-dashboard-picker-section--personas", picker)
        self.assertIn("persona-dashboard-picker-section--settings", picker)
        self.assertIn("persona-dashboard-picker-option--${type}", picker)
        self.assertIn('renderOption(overview, "overview")', picker)
        self.assertIn('renderOption(settings, "settings")', picker)
        self.assertIn("总览数据", picker)
        self.assertIn("普通人设", picker)
        self.assertIn("显示设置", picker)
        self.assertIn("accountBound: Boolean(handle)", picker)
        self.assertIn('"is-account-unbound"', picker)

        picker_start = self.styles.index(".persona-dashboard-picker-tabs {")
        picker_end = self.styles.index(".persona-dashboard-view .persona-tab {", picker_start)
        picker_styles = self.styles[picker_start:picker_end]
        self.assertIn(".persona-dashboard-picker-section:not(.persona-dashboard-picker-section--overview)", picker_styles)
        self.assertNotIn("border-style: dashed;", picker_styles)
        self.assertIn(".persona-dashboard-picker-option--overview {", picker_styles)
        self.assertIn(".persona-dashboard-picker-option--settings {", picker_styles)
        self.assertIn(".persona-dashboard-picker-option::after {", picker_styles)
        self.assertIn(".persona-dashboard-picker-copy span::before {", picker_styles)
        self.assertIn("linear-gradient(110deg", picker_styles)
        self.assertIn("text-overflow: ellipsis;", picker_styles)
        self.assertIn("#e3efed", picker_styles)
        self.assertIn("#1d3446", picker_styles)
        self.assertIn("#71979a", picker_styles)
        self.assertIn("background: #ffffff;", picker_styles)
        self.assertIn(".persona-dashboard-picker-option.is-account-unbound .persona-dashboard-picker-copy span::before", picker_styles)
        self.assertIn("background: #28465a;", picker_styles)
        self.assertIn("linear-gradient(110deg, #f5fbfa 0%, #eaf4f2 58%, #e3efed 100%)", picker_styles)
        self.assertNotIn("var(--brand-bg)", picker_styles)
        self.assertNotIn("#071112", picker_styles)

    def test_dashboard_does_not_render_device_or_bot_fields(self):
        self.assertNotIn("绑定设备", self.dashboard_script)
        self.assertNotIn("设备：", self.dashboard_script)
        self.assertNotIn("机器人：", self.dashboard_script)
        self.assertNotIn("bound_pad", self.dashboard_script)
        self.assertNotIn("owner_bot", self.dashboard_script)

    def test_admin_entry_is_beside_subscription_and_keeps_permission_gate(self):
        subscription = self.markup.index('class="site-icon-button site-subscription-link"')
        admin_entry = self.markup.index('id="openAdmin"')
        account_menu = self.markup.index('class="site-account-menu"')

        self.assertLess(subscription, admin_entry)
        self.assertLess(admin_entry, account_menu)
        self.assertIn(
            'class="site-admin-entry admin-only" data-site-copy="adminConsole" hidden>运营后台</button>',
            self.markup,
        )
        self.assertIn('if (me.is_admin) $("openAdmin").hidden = false;', self.console_script)

    def test_workspace_navigation_uses_titles_without_descriptions(self):
        self.assertNotIn('<small>${esc(item.hint)}</small>', self.console_script)
        self.assertNotIn('hint: "人设列表、详情、推文、账号"', self.console_script)
        self.assertIn('<span>${esc(item.label)}</span>', self.console_script)

    def test_memory_and_generated_preview_share_compact_cards_and_common_modal(self):
        self.assertIn('data-persona-view-memory="${esc(row.id)}">查看</button>', self.console_script)
        self.assertIn("async function viewPersonaMemoryEntry(memoryId = \"\")", self.console_script)
        self.assertIn('title: "人设记忆"', self.console_script)
        self.assertIn(
            'class="persona-memory-card persona-generated-preview-card ${selected ? "is-selected" : ""}"',
            self.console_script,
        )
        preview_position = self.console_script.index("${generatePreviewDock}")
        media_position = self.console_script.index(
            "? renderPersonaInlineMediaComposer",
            preview_position,
        )
        self.assertLess(preview_position, media_position)

    def test_new_persona_memory_uses_the_required_summary_field_and_json_request(self):
        start = self.console_script.index("async function createPersonaMemoryEntry()")
        end = self.console_script.index("\nasync function loadPersonaImageLibrary", start)
        memory_creator = self.console_script[start:end]

        self.assertIn('name: "summary"', memory_creator)
        self.assertIn('required: true', memory_creator)
        self.assertIn('multiline: true', memory_creator)
        self.assertIn('headers: { "Content-Type": "application/json" }', memory_creator)

    def test_memory_toolbar_discards_deleted_selections_and_ignores_disabled_bulk_controls(self):
        renderer_start = self.console_script.index("function renderPersonaMemoryOptions")
        renderer_end = self.console_script.index("\nfunction syncPersonaMemorySelectionState", renderer_start)
        renderer = self.console_script[renderer_start:renderer_end]
        bulk_start = self.console_script.index('const memoryBulkButton = event.target.closest("[data-persona-memory-bulk]");')
        bulk_end = self.console_script.index("\n    if (event.target.closest(\"[data-persona-create-memory]\"))", bulk_start)
        bulk_handler = self.console_script[bulk_start:bulk_end]

        self.assertIn("const rowIds = new Set(safeRows.map((row) => String(row?.id || \"\")));", renderer)
        self.assertIn(".filter((id) => rowIds.has(id))", renderer)
        self.assertIn('class="persona-memory-empty-hint">暂无可选记忆</span>', renderer)
        self.assertNotIn('<div class="empty-state">暂无可选记忆', renderer)
        self.assertIn("if (memoryBulkButton.disabled || memoryBulkButton.getAttribute(\"aria-disabled\") === \"true\") return;", bulk_handler)
        self.assertIn("align-items: center;", self.styles[self.styles.index(".persona-memory-actions {"):self.styles.index(".persona-memory-actions button {")])

    def test_persona_memory_actions_use_stable_single_color_borders(self):
        start = self.styles.index(".persona-memory-card:hover {")
        end = self.styles.index(".persona-media-workspace {")
        memory_styles = self.styles[start:end]

        self.assertIn("border-color: var(--hover-border);", memory_styles)
        self.assertIn("appearance: none;", memory_styles)
        self.assertIn("border: 1px solid var(--line);", memory_styles)
        self.assertIn(".persona-memory-card-actions > button:not(.danger):hover", memory_styles)
        self.assertIn(".persona-memory-card-actions > button.danger:active", memory_styles)
        self.assertIn("background: var(--panel-solid);", memory_styles)

    def test_mobile_draft_list_is_compact_and_grid_refresh_moves_beside_view(self):
        marker = "/* Responsive draft list density: keep rows as compact records instead of labeled field stacks. */"
        self.assertIn(marker, self.styles)
        mobile_styles = self.styles[self.styles.index(marker):]

        self.assertIn('"check index title actions"', mobile_styles)
        self.assertIn('"check index time actions"', mobile_styles)
        self.assertIn('"check index content actions"', mobile_styles)
        self.assertIn('.persona-draft-table-row > [data-mobile-label]::before', mobile_styles)
        self.assertIn('[data-mobile-label="状态"]', mobile_styles)
        self.assertIn(".persona-draft-action-hot-refresh", mobile_styles)
        self.assertIn("includeHotRefresh: Boolean(hotMeta)", self.console_script)
        self.assertLess(
            self.console_script.index('class="persona-hot-refresh-button persona-draft-action-hot-refresh"'),
            self.console_script.index('data-persona-view-post="${esc(post.id)}"'),
        )

    def test_common_media_viewers_center_media_on_dark_stages(self):
        self.assertIn('node.className = "persona-media-lightbox";', self.console_script)
        self.assertNotIn("openMediaLightbox(groupId, 0);", self.console_script)
        self.assertIn(
            'Number(previewButton.dataset.mediaPreviewIndex || 0),',
            self.console_script,
        )
        self.assertIn(".persona-media-lightbox {", self.styles)
        self.assertIn("position: fixed;", self.styles)
        self.assertIn("place-items: center;", self.styles)
        self.assertIn("--viewer-bg: #080a0b;", self.styles)
        self.assertIn("--viewer-surface: #111416;", self.styles)
        self.assertIn("background: var(--viewer-surface);", self.styles)
        self.assertIn("background: var(--viewer-bg);", self.styles)
        self.assertNotIn("background: #111817;", self.styles)
        self.assertNotIn("background: #050b0a;", self.styles)
        self.assertIn("object-fit: contain;", self.styles)
        self.assertIn("object-position: center;", self.styles)
        self.assertIn(".persona-post-gallery-card", self.dashboard_styles)
        self.assertIn("background: #111817;", self.dashboard_styles)
        self.assertIn(".persona-post-gallery-stage", self.dashboard_styles)
        self.assertIn("background: #050b0a;", self.dashboard_styles)
        self.assertIn("object-position: center;", self.dashboard_styles)

    def test_generation_and_media_result_actions_use_clear_compact_labels(self):
        self.assertIn('hasGenerateContent ? "AI 润色" : "AI 生成"', self.console_script)
        self.assertNotIn(">开始生成</button>", self.console_script)
        self.assertNotIn('"自动生成草稿"', self.console_script)
        self.assertNotIn('"AI 润色预览"', self.console_script)
        self.assertIn('taskState?.taskId ? "重新生成" : "生成预览"', self.console_script)
        self.assertIn(">添加至草稿</button>", self.console_script)
        self.assertIn(">替换</button>", self.console_script)
        self.assertNotIn(">覆盖全部媒体</button>", self.console_script)
        self.assertIn("persona-media-task-actions", self.console_script)
        self.assertIn(
            "renderPersonaMediaTaskResult(persona.id, post.id, { mediaBusy, mediaBusyStartedAt })",
            self.console_script,
        )
        self.assertIn(
            ".persona-media-task-actions {\n"
            "  display: grid;\n"
            "  grid-template-columns: repeat(3, minmax(0, 1fr));",
            self.styles,
        )
        self.assertIn(".persona-compose-media-stack", self.styles)
        self.assertIn("min-height: 60px;", self.styles)

    def test_generated_preview_queue_survives_media_generation_and_supports_media_selection(self):
        self.assertIn("personaGeneratedPreviews: {}", self.console_script)
        self.assertIn("function consumePersonaGeneratedPreviewPost(persona, postId)", self.console_script)
        self.assertIn("function renderPersonaTaskMediaPreview(taskState, items = [])", self.console_script)
        self.assertIn('data-persona-task-media-select="${esc(sourceIndex)}"', self.console_script)
        self.assertIn("media_indexes: selectedMediaIndexes", self.console_script)
        self.assertNotIn("data-persona-generated-media", self.console_script)
        self.assertIn(
            '${items.length && status === "success" ? `',
            self.console_script,
        )
        self.assertIn(".persona-task-media-card.is-selected", self.styles)
        self.assertIn(
            ".persona-task-media-select .ui-action-icon rect,\n"
            ".persona-task-media-select .ui-action-icon path",
            self.styles,
        )
        self.assertIn("stroke: currentColor;", self.styles)
        self.assertIn(
            ".console-page .persona-media-task-actions > [data-persona-run-media-task]",
            self.styles,
        )

    def test_mobile_task_dock_adds_home_and_omits_the_browser_shortcut(self):
        self.assertIn('id="mobileTaskDock"', self.markup)
        self.assertIn("function renderMobileTaskDock()", self.console_script)
        self.assertIn('const mobileDockItems = [', self.console_script)
        self.assertIn('{ id: "persona_dashboard", label: "首页", view: "persona_dashboard" }', self.console_script)
        self.assertIn('...modules.filter((item) => item.id !== "browser_list")', self.console_script)
        self.assertIn("mobileDockItems.map((item) =>", self.console_script)
        self.assertIn("renderMobileTaskIcon(item.id)", self.console_script)
        self.assertIn(
            '$("mobileTaskDock")?.addEventListener("click", handleWorkspaceModuleNavigation);',
            self.console_script,
        )
        for module_id in (
            "personas",
            "tweet_generation",
            "publishing",
            "accounts",
        ):
            with self.subTest(module_id=module_id):
                self.assertIn(f'{module_id}:', self.console_script)

        self.assertIn(
            'item.label === "账号管理" ? "账号池"',
            self.console_script,
        )
        self.assertIn("tweet_generation: '<path d=\"M12 5v14M5 12h14\"></path>'", self.console_script)

    def test_mobile_task_queue_uses_compact_persona_and_task_rows(self):
        marker = "/* Mobile task queue density: align queue cards with the compact persona list. */"
        self.assertIn(marker, self.styles)
        mobile_styles = self.styles[self.styles.index(marker):]

        self.assertIn(".task-queue-panel-tabs button", mobile_styles)
        self.assertIn("min-height: 32px;", mobile_styles)
        self.assertIn(".task-queue-persona-shell .persona-list-stack", mobile_styles)
        self.assertIn("gap: 4px;", mobile_styles)
        self.assertIn(".task-persona-card .persona-list-item", mobile_styles)
        self.assertIn("min-height: 0;", mobile_styles)
        self.assertIn(".task-persona-queue-row", mobile_styles)
        self.assertIn('"check type status"', mobile_styles)
        self.assertIn('"empty platform account"', mobile_styles)
        self.assertIn('"empty time actions"', mobile_styles)
        self.assertIn(".task-table-inner--regular .task-row", mobile_styles)
        self.assertIn('"check task status"', mobile_styles)
        self.assertIn('"empty time actions"', mobile_styles)
        self.assertIn("grid-auto-rows: max-content;", mobile_styles)
        self.assertIn("min-height: min-content;", mobile_styles)

    def test_regular_task_queue_keeps_delete_as_the_rightmost_action(self):
        regular_tasks_start = self.console_script.index("const regularTasksHtml")
        regular_tasks_template = self.console_script[
            regular_tasks_start:self.console_script.index("const currentPanel", regular_tasks_start)
        ]

        self.assertLess(
            regular_tasks_template.index("data-retry"),
            regular_tasks_template.index("data-delete-task"),
        )
        self.assertLess(
            regular_tasks_template.index("data-cancel-task"),
            regular_tasks_template.index("data-delete-task"),
        )

        mobile_styles = self.styles[self.styles.index("/* Mobile task queue density: align queue cards with the compact persona list. */"):]
        self.assertIn(
            ".console-page .task-table-inner--regular .task-row .row-actions .task-queue-delete-button {",
            mobile_styles,
        )
        self.assertIn("flex-wrap: nowrap;", mobile_styles)
        self.assertIn("justify-content: flex-end;", mobile_styles)
        self.assertIn("margin-left: 0;", mobile_styles)
        self.assertIn(
            ".task-row .row-actions a,\n.task-persona-queue-row .row-actions a {",
            self.styles,
        )
        self.assertIn("align-items: center;", self.styles)
        self.assertIn("justify-content: center;", self.styles)

    def test_task_queue_uses_trash_only_for_direct_delete_actions_and_does_not_nest_scroll(self):
        view_start = self.console_script.index("function renderTaskQueueView()")
        view_end = self.console_script.index("\nfunction currentBranch", view_start)
        queue_view = self.console_script[view_start:view_end]
        tabs_start = self.console_script.index("function renderTaskQueuePanelTabs(")
        tabs_end = self.console_script.index("\nfunction renderTaskQueueBulkControls", tabs_start)
        tabs = self.console_script[tabs_start:tabs_end]

        self.assertIn('data-task-queue-delete-selected="${esc(kind)}"', self.console_script)
        self.assertIn('data-task-clear-persona-queue="${esc(persona.id)}"', queue_view)
        self.assertIn('data-task-clear-persona-queue="${esc(persona.id)}" title="清空当前人设队列" aria-label="清空当前人设队列">${renderQueueClearIcon()}</button>', queue_view)
        self.assertIn("function renderQueueClearIcon()", self.console_script)
        self.assertIn('class="automation-capsule-tabs task-queue-panel-tabs"', tabs)
        self.assertIn("task-queue-persona-select-button", queue_view)
        self.assertIn('title="选择人设" aria-label="选择人设"', queue_view)
        self.assertNotIn("<span>选择人设</span>", queue_view)
        self.assertIn("task-panel-section-head--with-action", queue_view)
        self.assertIn("task-panel-section-heading-actions", queue_view)
        self.assertIn("task-panel-section-actions", queue_view)
        self.assertIn(".console-page .automation-capsule-tabs.task-queue-panel-tabs {", self.styles)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr));", self.styles)
        self.assertIn(".task-panel-section-head--with-action {", self.styles)
        self.assertIn(".console-page .task-table-inner {", self.styles)
        self.assertIn("max-height: none;", self.styles)
        self.assertIn("overflow-y: visible;", self.styles)

    def test_task_queue_removes_open_current_persona_action(self):
        self.assertNotIn("data-task-open-persona", self.console_script)
        self.assertNotIn("打开当前人设", self.console_script)

    def test_persona_generation_modes_use_short_labels_and_mobile_capsules(self):
        self.assertIn('["tweet", "普通推文"]', self.console_script)
        self.assertIn('["tweet_media", "批量推文"]', self.console_script)
        self.assertIn('["hot", "热点抓取"]', self.console_script)
        self.assertNotIn("只生成推文", self.console_script)
        self.assertNotIn("根据推文生成配图", self.console_script)

        mobile_rule = (
            ".console-page .persona-detail :is(\n"
            "    .persona-compose-toggle,\n"
            "    .persona-source-toggle,\n"
            "    .persona-media-operation-toggle,\n"
            "    .persona-content-tabs\n"
            '  ) button[type="button"] {\n'
            "    border-radius: 999px;"
        )
        self.assertIn(mobile_rule, self.styles)

    def test_persona_generate_and_polish_share_one_compose_flow(self):
        compose_tabs_start = self.console_script.index("function renderPersonaGenerateComposeTabs(mode,")
        compose_tabs_end = self.console_script.index(
            "\nfunction renderPersonaMediaOperationTabs(mode)",
            compose_tabs_start,
        )
        compose_tabs = self.console_script[compose_tabs_start:compose_tabs_end]
        self.assertIn('["tweet", "普通推文"]', compose_tabs)
        self.assertIn('["tweet_media", "批量推文"]', compose_tabs)
        self.assertIn('["hot", "热点抓取"]', compose_tabs)
        self.assertNotIn('["custom", "自定义"]', compose_tabs)

        content_panel_start = self.console_script.index("function renderPersonaContentPanel(persona, account, profile, step)")
        content_panel_end = self.console_script.index(
            "\nfunction refreshLiveBrowserSessionsSoon(",
            content_panel_start,
        )
        content_panel = self.console_script[content_panel_start:content_panel_end]
        self.assertNotIn("renderPersonaGenerateModeTabs", content_panel)
        self.assertIn('const isBatchCompose = composeMode === "tweet_media";', content_panel)
        self.assertIn('isBatchCompose && generateMode === "ai"', content_panel)
        self.assertIn('id="personaDraftTitle"', content_panel)
        self.assertIn('id="personaDraftContent"', content_panel)
        self.assertIn('<select id="personaGenerateCount">', content_panel)
        self.assertIn("PERSONA_GENERATE_MAX_COUNT", content_panel)
        self.assertNotIn('id="personaGenerateCount" type="number"', content_panel)
        self.assertNotIn('id="personaGeneratePrompt"', content_panel)
        self.assertNotIn('id="personaMemorySearch"', content_panel)
        self.assertNotIn("筛选记忆内容", content_panel)
        self.assertLess(
            content_panel.index("data-persona-create-post"),
            content_panel.index("data-persona-route-step=\"content:posts\""),
        )
        self.assertIn('aria-label="使用 AI 重新生成当前推文"', content_panel)
        self.assertIn('data-persona-draft-save-dock', content_panel)
        self.assertIn('const generateMode = isEditingDraft\n    ? "custom"', content_panel)

    def test_persona_generation_success_clears_only_the_active_compose_input(self):
        completion = self.console_script[
            self.console_script.index("async function completePersonaPostGenerationTask"):
            self.console_script.index("async function watchPersonaPostGenerationTask")
        ]
        request = self.console_script[
            self.console_script.index("async function generatePersonaDraftPosts"):
            self.console_script.index("async function completePersonaPostGenerationTask")
        ]
        clear_call = "clearPersonaDraftComposerInputs(persona.id, composeMode);"
        branch = "if (selectionRequired && generatedPosts.length)"

        self.assertEqual(completion.count(clear_call), 1)
        self.assertIn(f"if (generatedPosts.length) {clear_call}", completion)
        self.assertLess(completion.index(clear_call), completion.index(branch))
        self.assertNotIn(clear_call, request)
        self.assertNotIn("personaFormState(persona.id).draft = defaultPersonaDraftForm();", completion)

        clear_start = self.console_script.index("function clearPersonaDraftComposerInputs")
        clear_end = self.console_script.index("function syncPersonaDraftDirty", clear_start)
        clear_source = self.console_script[clear_start:clear_end]
        self.assertIn('form.generate.prompt = "";', clear_source)
        self.assertIn("clearUploadDropzoneState(", clear_source)
        self.assertIn('"personaPostMediaUploadFiles",', clear_source)
        self.assertIn("personaComposePendingMediaStateKey({ id: personaId }, composeMode)", clear_source)

    def test_normal_and_batch_tweet_inputs_keep_independent_state(self):
        snapshot = self.console_script[
            self.console_script.index("function snapshotPersonaCurrentForm()"):
            self.console_script.index("function personaImageLibraryState")
        ]
        handler_start = self.console_script.index(
            'const composeModeButton = event.target.closest("[data-persona-compose-mode]")'
        )
        handler_end = self.console_script.index(
            'const openImageSettingsButton = event.target.closest("[data-persona-open-image-settings]")',
            handler_start,
        )
        handler = self.console_script[handler_start:handler_end]
        reset_start = self.console_script.index("function resetPersonaNewDraftComposer(personaId)")
        reset_end = self.console_script.index("function openPersonaDraftEditor", reset_start)
        reset = self.console_script[reset_start:reset_end]

        self.assertIn("function storePersonaComposeDraftInput(form", self.console_script)
        self.assertIn("function restorePersonaComposeDraftInput(form", self.console_script)
        self.assertIn("function clearPersonaDraftComposerInputs(personaId, composeMode", self.console_script)
        self.assertIn("storePersonaComposeDraftInput(form);", snapshot)
        self.assertIn("restorePersonaComposeDraftInput(form, nextComposeMode);", handler)
        self.assertIn("const composeDraftInputs = ensurePersonaComposeDraftInputs(form);", reset)
        self.assertIn("composeDraftInputs.tweet = defaultPersonaComposeDraftInput();", reset)
        self.assertIn("composeDraftInputs.tweet_media = defaultPersonaComposeDraftInput();", reset)
        self.assertIn('if ($("personaDraftTitle")) $("personaDraftTitle").value = "";', reset)
        self.assertIn('if ($("personaDraftContent")) $("personaDraftContent").value = "";', reset)
        transient = self.console_script[
            self.console_script.index("function activePersonaDraftComposerTransientState"):
            self.console_script.index("async function confirmPersonaContentPlatformSwitch")
        ]
        self.assertIn("const composeDraftInputs = ensurePersonaComposeDraftInputs(form);", transient)
        self.assertIn("Object.values(composeDraftInputs).some", transient)
        self.assertIn("composeDraftInputs,", transient)

        media_key_start = self.console_script.index("function personaComposePendingMediaStateKey")
        media_key_end = self.console_script.index("function renderPersonaCompactMediaUpload", media_key_start)
        media_key_source = self.console_script[media_key_start:media_key_end]
        self.assertIn("personaComposeDraftInputKey(", media_key_source)
        self.assertIn("composeMode ||", media_key_source)
        self.assertIn("${modeKey}", media_key_source)

    def test_hotspot_top_capsule_switches_the_real_generation_mode(self):
        handler_start = self.console_script.index(
            'const composeModeButton = event.target.closest("[data-persona-compose-mode]")'
        )
        handler_end = self.console_script.index(
            'const openImageSettingsButton = event.target.closest("[data-persona-open-image-settings]")',
            handler_start,
        )
        handler = self.console_script[handler_start:handler_end]
        self.assertIn('["tweet_media", "hot"].includes', handler)
        self.assertIn('form.generate.mode = nextComposeMode === "hot" ? "hot" : "ai";', handler)
        self.assertIn('if (editingPostId) {', handler)
        self.assertIn('if (nextComposeMode !== "tweet")', handler)
        self.assertIn("批量推文和热点抓取已锁定", handler)

        self.assertIn(
            ".persona-generate-actions .persona-generate-ai-action {\n"
            "  margin-left: auto;",
            self.styles,
        )
        self.assertNotIn(".persona-memory-search", self.styles)
        self.assertIn(": PERSONA_GENERATE_DEFAULT_COUNT;", self.console_script)
        self.assertIn("PERSONA_GENERATE_MAX_COUNT = 5;", self.console_script)
        self.assertNotIn("PERSONA_GENERATE_COUNT_KEY", self.console_script)
        self.assertNotIn("PERSONA_GENERATE_TARGET_WORDS_KEY", self.console_script)
        self.assertIn(
            'payload.rewrite_source_content = rewriteSourceContent || String(draft.originalContent || "").trim();',
            self.console_script,
        )
        self.assertIn("function openPersonaGeneratedSelectionModal(persona, rows = [])", self.console_script)
        self.assertIn('modalKey: "persona-generated-selection"', self.console_script)
        self.assertIn('name="personaGeneratedSelection"', self.console_script)
        self.assertIn('{ value: "save", text: "保存草稿" }', self.console_script)
        self.assertIn('{ value: "media", text: "生成配图", primary: true }', self.console_script)
        self.assertIn("resolvePersonaOrdinaryGeneratedCandidates(persona, taskId, generatedPosts", self.console_script)
        self.assertNotIn("discardPersonaGeneratedCandidatePosts(", self.console_script)
        self.assertIn('.console-modal[data-modal-key="persona-generated-selection"]', self.styles)
        self.assertIn('.persona-generated-selection-card input[type="radio"]:focus', self.styles)
        self.assertIn("box-shadow: none;", self.styles)

    def test_generation_mode_loading_selection_and_media_steps_are_isolated(self):
        payload_builder = self.console_script[
            self.console_script.index("function generatePersonaPayloadFromState"):
            self.console_script.index("function personaGenerateRunState")
        ]
        completion = self.console_script[
            self.console_script.index("async function completePersonaPostGenerationTask"):
            self.console_script.index("async function watchPersonaPostGenerationTask")
        ]
        selection = self.console_script[
            self.console_script.index("async function resolvePersonaOrdinaryGeneratedCandidates"):
            self.console_script.index("function personaPostGenerationTaskStorageKey")
        ]
        content_panel = self.console_script[
            self.console_script.index("function renderPersonaContentPanel"):
            self.console_script.index("function refreshLiveBrowserSessionsSoon")
        ]

        self.assertIn('selection_required: String(form.composeMode || "tweet") === "tweet"', payload_builder)
        self.assertIn("generatedPosts.some((post) => Boolean(post?.generation_candidate))", completion)
        self.assertNotIn("&& isActiveGenerationSurface", completion)
        self.assertIn('return record?.payload?.selection_required ? "tweet" : "tweet_media";', self.console_script)
        self.assertIn('personaForm.generate.composeMode = "tweet";', selection)
        self.assertIn('personaForm.media.operationMode = "generate";', selection)
        self.assertIn("personaForm.media.focusPostId = finalizedPostId;", selection)
        self.assertIn("generate_posts/tasks/${encodeURIComponent(cleanTaskId)}/resolve", selection)
        self.assertNotIn("discardPersonaGeneratedCandidatePosts(", selection)
        self.assertIn('deletePersonaGeneratedPreview(persona.id, "tweet");', selection)
        self.assertIn("const generationLocked = isActionLocked", content_panel)
        self.assertIn("const generateBusy = generationLocked && activeGenerateComposeMode === composeMode;", content_panel)
        self.assertIn("const ordinaryMediaTarget", content_panel)
        self.assertIn("isEditingDraft || isBatchCompose || ordinaryMediaTarget", content_panel)

        chooser = self.console_script[
            self.console_script.index("async function openPersonaGeneratedSelectionModal"):
            self.console_script.index("function activePersonaGeneratePreview")
        ]
        self.assertIn("stack: true", chooser)
        self.assertIn("dismissOnBackdrop: false", chooser)
        self.assertIn("dismissOnEscape: false", chooser)
        self.assertIn("showClose: false", chooser)

        reset = self.console_script[
            self.console_script.index("function resetPersonaNewDraftComposer"):
            self.console_script.index("function openPersonaDraftEditor")
        ]
        self.assertIn('form.media.focusPostId = "";', reset)
        self.assertIn("runState.selectionRequired", self.console_script)
        self.assertIn("post?.generation_candidate || post?.generationCandidate", self.console_script)
        media_submit = self.console_script[
            self.console_script.index("async function submitPersonaMediaTask"):
            self.console_script.index("async function attachPersonaTaskMediaToPost")
        ]
        self.assertIn("startedAt: submittedAt", media_submit)
        self.assertNotIn("watchTask(result.id", media_submit)
        self.assertEqual(media_submit.count("watchPersonaMediaTask(persona.id, post.id, result.id)"), 1)

    def test_generated_previews_are_isolated_by_compose_mode_and_hidden_from_hot_capture(self):
        preview_state = self.console_script[
            self.console_script.index("function normalizePersonaGeneratedPreviewComposeMode"):
            self.console_script.index("function personaGenerateRunDisplay")
        ]
        content_panel = self.console_script[
            self.console_script.index("function renderPersonaContentPanel"):
            self.console_script.index("function refreshLiveBrowserSessionsSoon")
        ]

        self.assertIn('return mode === "tweet_media" ? "tweet_media" : (mode === "tweet" ? "tweet" : "");', preview_state)
        self.assertIn("function personaGeneratedPreviewKey(personaId, composeMode)", preview_state)
        self.assertIn("const previewKey = personaGeneratedPreviewKey(key, previewComposeMode);", preview_state)
        self.assertIn("state.personaGeneratedPreviews[previewKey]", preview_state)
        self.assertIn("renderPersonaGeneratePreviewDock(persona, composeMode)", content_panel)
        self.assertIn('if (composeMode === "hot") return "";', self.console_script)

    def test_successful_persona_image_generation_and_attach_clear_prompt_without_changing_copy(self):
        media_refresh = self.console_script[
            self.console_script.index("async function refreshPersonaMediaTask"):
            self.console_script.index("async function watchPersonaMediaTask")
        ]
        media_attach = self.console_script[
            self.console_script.index("async function attachPersonaTaskMediaToPost"):
            self.console_script.index("async function savePersonaPostMediaFiles")
        ]

        self.assertIn('if (ok && taskType === "persona_post_image")', media_refresh)
        self.assertIn("clearPersonaMediaPrompt(personaId);", media_refresh)
        self.assertIn("clearPersonaMediaPrompt(persona.id);", media_attach)
        self.assertIn('$("personaMediaTaskPrompt").value = "";', self.console_script)
        self.assertIn("/media/from_task", media_attach)
        self.assertNotIn("draft.content =", media_attach)
        self.assertNotIn("form.draft.content =", media_attach)
        self.assertIn("作为配图补充要求", self.console_script)

    def test_mobile_task_queue_persona_list_reuses_shared_drawer(self):
        selector_start = self.console_script.index("function renderTaskQueuePersonaSelector()")
        selector_end = self.console_script.index("\nfunction renderTaskQueueView()", selector_start)
        selector = self.console_script[selector_start:selector_end]
        view_start = selector_end
        view_end = self.console_script.index("\nfunction currentBranch", view_start)
        view = self.console_script[view_start:view_end]
        handler_start = self.console_script.index('  $("taskTable").addEventListener("click", async (event) => {')
        handler_end = self.console_script.index("\n  });", handler_start)
        handler = self.console_script[handler_start:handler_end]

        self.assertIn('id="taskQueuePersonaSidebar"', selector)
        self.assertIn("persona-mobile-drawer", selector)
        self.assertIn("data-persona-mobile-sidebar", selector)
        self.assertIn("data-persona-mobile-list-close", selector)
        self.assertIn("data-persona-mobile-list-backdrop", selector)
        self.assertIn('data-persona-mobile-list-toggle="taskQueuePersonaSidebar"', view)
        persona_panel = view[view.index('title: "当前人设自动化队列"'):]
        self.assertEqual(persona_panel.count("extraActions:"), 1)
        select_start = handler.index('const taskPersonaSelect = event.target.closest("[data-task-persona-select]");')
        select_handler = handler[select_start:]
        self.assertIn('const reopenTaskQueuePersonaSidebar = Boolean(', select_handler)
        self.assertIn(
            'setPersonaMobileSidebarOpen(reopenTaskQueuePersonaSidebar, "taskQueuePersonaSidebar");',
            select_handler,
        )
        self.assertNotIn('setPersonaMobileSidebarOpen(false, "taskQueuePersonaSidebar");', select_handler)
        self.assertIn(
            'setPersonaMobileSidebarOpen(reopenTaskQueuePersonaSidebar, "taskQueuePersonaSidebar");',
            self.console_script,
        )

    def test_mobile_draft_hot_metrics_stay_in_one_horizontal_row(self):
        mobile_rule = self.styles.index(
            ".persona-hot-metric-strip {\n    align-items: center;"
        )
        mobile_start = self.styles.rfind("@media (max-width: 760px)", 0, mobile_rule)
        mobile_end = self.styles.index("@media (max-width: 1180px)", mobile_start)
        mobile_styles = self.styles[mobile_start:mobile_end]

        self.assertIn(".persona-hot-metric-strip {\n    align-items: center;", mobile_styles)
        self.assertIn("grid-template-columns: repeat(6, minmax(0, 1fr));", mobile_styles)
        self.assertIn(".persona-hot-metric-values > span {", mobile_styles)
        self.assertIn("flex-direction: column;", mobile_styles)

    def test_mobile_persona_hot_detail_metrics_stay_in_one_row(self):
        marker = "/* Persona statistics keep two clear rows and adapt each row without page overflow. */"
        mobile_styles = self.styles[self.styles.index(marker):]

        self.assertIn(
            ".persona-profile-data-panel .persona-hot-summary-metrics--hot {\n"
            "    grid-template-columns: repeat(4, minmax(0, 1fr));",
            mobile_styles,
        )
        self.assertIn(
            ".persona-profile-data-panel .persona-hot-total-metric {\n"
            "    grid-column: 1 / -1;",
            mobile_styles,
        )

    def test_second_mobile_dock_click_scrolls_active_view_to_top(self):
        handler_start = self.console_script.index(
            "const handleWorkspaceModuleNavigation = async (event) => {"
        )
        handler_end = self.console_script.index(
            '\n  $("moduleMenu").addEventListener', handler_start
        )
        handler = self.console_script[handler_start:handler_end]

        self.assertIn("function isCurrentMobileTaskDockTarget(button)", self.console_script)
        self.assertIn("function scrollConsolePageToTop()", self.console_script)
        self.assertIn('event.target.closest(".mobile-task-dock-button")', handler)
        self.assertIn("isCurrentMobileTaskDockTarget(dockButton)", handler)
        self.assertIn("scrollConsolePageToTop();", handler)
        self.assertNotIn("await waitForSegmentedBackgroundSlide(event, dockButton", handler)
        self.assertIn("currentPersonaDraftEditPersonaId()", handler)
        self.assertIn("activeTransientWorkspaceState()", handler)
        self.assertEqual(handler.count("if (dockButton) {"), 2)
        self.assertEqual(
            handler.count("commitMobileTaskDockNavigation(dockButton,"),
            2,
        )
        self.assertIn("commitMobileTaskDockNavigation(dockButton, commitView);", handler)
        self.assertIn("commitMobileTaskDockNavigation(dockButton, commitModule);", handler)
        self.assertLess(
            handler.index("scrollConsolePageToTop();"),
            handler.index('event.target.closest("[data-workspace-view]")'),
        )

    def test_mobile_persona_navigation_does_not_open_the_persona_drawer(self):
        handler_start = self.console_script.index(
            "const handleWorkspaceModuleNavigation = async (event) => {"
        )
        handler_end = self.console_script.index(
            '\n  $("moduleMenu").addEventListener', handler_start
        )
        handler = self.console_script[handler_start:handler_end]

        self.assertNotIn('dockButton?.dataset.module === "personas"', handler)
        module_branch = handler[handler.index('const button = event.target.closest("[data-module]")'):]
        self.assertNotIn(
            'setPersonaMobileSidebarOpen(true, "personaWorkspaceSidebar");',
            module_branch,
        )

    def test_mobile_profile_header_hides_the_persona_create_copy_and_action(self):
        settings_start = self.console_script.index(
            "function renderPersonaSettingsPanelV2("
        )
        settings_end = self.console_script.index(
            "\nfunction renderPersonaAccountPanelV2", settings_start
        )
        settings = self.console_script[settings_start:settings_end]

        self.assertIn("persona-profile-base-head", settings)
        self.assertIn("persona-profile-new-button", settings)
        self.assertIn("data-persona-open-create", settings)
        self.assertIn("新建人设", settings)
        self.assertIn("名称、简介、头像、链接和推文风格分别设置", settings)
        self.assertIn("/* Keep the mobile persona editor focused on the selected profile. */", self.styles)
        mobile_styles = self.styles[
            self.styles.index("/* Keep the mobile persona editor focused on the selected profile. */"):
        ]
        self.assertIn(".persona-profile-base-head", mobile_styles)
        self.assertIn("display: none;", mobile_styles)

    def test_persona_account_setting_keeps_status_beside_title_and_centers_add_action(self):
        panel_start = self.console_script.index("function renderPersonaAccountPanelV2(")
        panel_end = self.console_script.index("\nfunction personaAccountPoolCandidates", panel_start)
        panel = self.console_script[panel_start:panel_end]

        self.assertIn("persona-account-section-head", panel)
        self.assertIn("persona-account-section-title", panel)
        self.assertIn("data-persona-account-platform-tabs", panel)
        self.assertIn("renderAccountPoolPlatformIcon(value)", panel)
        self.assertIn('role="tablist"', panel)
        self.assertIn("account-pool-empty-state persona-account-empty-state", panel)
        self.assertNotIn("切换账号池", panel)
        self.assertIn("account-pool-add-row persona-account-action-row", panel)
        self.assertIn("persona-account-action-row", panel)
        self.assertIn("data-persona-account-add", panel)
        self.assertIn("personaAccountPickerTriggerDisplay", panel)
        self.assertIn("persona-account-add-button", panel)
        account_add_handler_start = self.console_script.index(
            'const personaAccountAdd = event.target.closest("[data-persona-account-add]");'
        )
        account_add_handler_end = self.console_script.index(
            "const personaAccountPlatform =", account_add_handler_start
        )
        account_add_handler = self.console_script[account_add_handler_start:account_add_handler_end]
        self.assertIn("openPersonaAccountPoolPickerModal", account_add_handler)
        self.assertNotIn("createPersonaAutomationAccount()", account_add_handler)
        self.assertLess(
            panel.index('class="persona-account-section-title"'),
            panel.index("account-pool-selection-count"),
        )
        self.assertLess(
            panel.index("persona-account-section-title"),
            panel.index("persona-account-action-row"),
        )
        self.assertIn(".persona-account-pool-panel .persona-account-section-title", self.styles)
        self.assertIn(".persona-account-pool-panel .persona-account-action-row", self.styles)
        self.assertIn("justify-content: center;", self.styles)

    def test_persona_account_card_reuses_the_account_pool_card_layout(self):
        renderer_start = self.console_script.index("function renderAccountPoolCard(")
        renderer_end = self.console_script.index("\nfunction renderAccountPoolCards", renderer_start)
        renderer = self.console_script[renderer_start:renderer_end]

        self.assertIn('const isPersonaSettings = variant === "persona-settings";', renderer)
        self.assertIn('data-persona-account-card="${esc(accountId)}"', renderer)
        self.assertIn('account-pool-card--persona', renderer)
        self.assertIn('account-pool-bound-persona', renderer)
        self.assertIn('account-card-meta', renderer)
        self.assertNotIn('persona-account-pool-card--summary', renderer)
        self.assertIn('.account-pool-card--persona {', self.styles)
        self.assertIn('padding-left: 12px;', self.styles)

    def test_persona_account_picker_allows_existing_platform_accounts_and_replaces_current_binding(self):
        picker_start = self.console_script.index("function personaAccountPoolCandidates(")
        picker_end = self.console_script.index("\nfunction personaAutomationTasksFor", picker_start)
        picker = self.console_script[picker_start:picker_end]

        self.assertNotIn("!String(account?.persona_id", picker)
        self.assertIn("personaAccountPoolCandidates(normalizedPlatform, persona)", picker)
        self.assertIn("replace_existing_binding: true", picker)
        self.assertNotIn("require_unbound: true", picker)
        self.assertIn("persona-account-picker-intro", picker)
        self.assertIn('renderPersonaAccountBindingIcon("bind")', picker)
        self.assertIn("currentPersonaId", picker)
        self.assertIn("String(account?.persona_id || \"\").trim() !== currentPersonaId", picker)
        self.assertIn("persona-account-picker-empty-state", picker)
        self.assertIn('renderPersonaAccountBindingIcon("replace")', picker)

    def test_persona_account_settings_reuses_the_mobile_platform_rail_and_swipe(self):
        self.assertIn("function bindPersonaAccountPlatformSwipe(host)", self.console_script)
        self.assertIn("personaAutomationPlatformOptions(persona)", self.console_script)
        self.assertIn("state.personaAutomationPlatform = platforms[nextIndex];", self.console_script)
        self.assertIn('bindPersonaAccountPlatformSwipe($("personaDetail"));', self.console_script)

        mobile_account_pool_styles = self.styles[self.styles.rindex("/* Account pool: platforms and accounts are separate functional modules. */"):]
        self.assertIn(".persona-account-platform-panel {", mobile_account_pool_styles)
        self.assertIn(".persona-account-platform-tabs {", mobile_account_pool_styles)
        self.assertIn("overflow-x: auto;", mobile_account_pool_styles)
        self.assertIn("scroll-snap-type: x proximity;", mobile_account_pool_styles)

    def test_mobile_account_add_uses_a_border_transition_without_icon_motion(self):
        self.assertIn("function startAccountPoolAddButtonMotion(button)", self.console_script)
        self.assertIn("function closeAccountPoolAddButtonMotion(button)", self.console_script)
        self.assertIn("if (isMobileNavMode())", self.console_script)
        self.assertIn('button.classList.add("is-modal-open");', self.console_script)
        self.assertIn('button.classList.add("is-opening");', self.console_script)
        self.assertIn('button.classList.add("is-closing");', self.console_script)
        self.assertIn("window.setTimeout(finish, 600);", self.console_script)
        persona_handler_start = self.console_script.index(
            'const personaAccountAdd = event.target.closest("[data-persona-account-add]");'
        )
        persona_handler_end = self.console_script.index(
            "const personaAccountPlatform =", persona_handler_start
        )
        persona_handler = self.console_script[persona_handler_start:persona_handler_end]
        self.assertIn("openPersonaAccountPoolPickerModal(persona, state.personaAutomationPlatform, personaAccountAdd)", persona_handler)
        picker_start = self.console_script.index("async function openPersonaAccountPoolPickerModal(")
        picker_end = self.console_script.index("\nfunction personaAutomationTasksFor", picker_start)
        picker = self.console_script[picker_start:picker_end]
        self.assertIn("motionTrigger = null", picker)
        self.assertIn("startAccountPoolAddButtonMotion(motionTrigger);", picker)
        self.assertIn("closeAccountPoolAddButtonMotion(motionTrigger)", picker)
        self.assertLess(picker.index("openConsoleModal({"), picker.index("startAccountPoolAddButtonMotion(motionTrigger);"))
        self.assertNotIn("account-pool-add-button-motion-proxy", self.console_script)
        editor_start = self.console_script.index("function openAccountPoolEditorModal(options)")
        editor_end = self.console_script.index("\nfunction openAccountPoolCreateModal(", editor_start)
        editor = self.console_script[editor_start:editor_end]
        self.assertNotIn("motionTrigger", editor)
        self.assertNotIn("mobileAddTrigger", editor)
        self.assertIn("openAccountPoolCreateModal();", self.console_script)
        self.assertIn(".account-pool-add-button.is-opening {", self.styles)
        self.assertIn(".account-pool-add-button.is-closing {", self.styles)
        mobile_marker = "/* Mobile add-account triggers keep only a lightweight border transition. */"
        self.assertIn(mobile_marker, self.styles)
        mobile_styles = self.styles[self.styles.index(mobile_marker):]
        self.assertIn("border: 1px solid transparent;", mobile_styles)
        self.assertIn("transition: border-color 180ms ease;", mobile_styles)
        self.assertIn("border-color: var(--accent);", mobile_styles)
        self.assertIn("background: transparent;", mobile_styles)
        self.assertIn("transform: none;", mobile_styles)
        self.assertIn("animation: none;", mobile_styles)
        self.assertIn("transition: none;", mobile_styles)
        self.assertGreater(
            self.styles.index(mobile_marker),
            self.styles.index("@keyframes account-pool-add-icon-close"),
        )
        self.assertNotIn(".account-pool-add-button-motion-proxy", self.styles)
        self.assertIn("animation: account-pool-add-button-open 420ms", self.styles)
        self.assertIn(".account-pool-add-button.is-opening span {", self.styles)
        self.assertIn("transform: rotate(180deg) scale(1.04);", self.styles)

    def test_mobile_account_pool_uses_swipeable_platform_tabs_and_an_empty_account_hint(self):
        account_pool_start = self.console_script.index("function renderAccountPool()")
        account_pool_end = self.console_script.index("\nasync function bindAccountPoolAccountToPersona", account_pool_start)
        account_pool = self.console_script[account_pool_start:account_pool_end]
        platform_tabs_start = self.console_script.index("function renderAccountPoolPlatformTabs()")
        platform_tabs_end = self.console_script.index("\nfunction accountById", platform_tabs_start)
        platform_tabs = self.console_script[platform_tabs_start:platform_tabs_end]
        cards_start = self.console_script.index("function renderAccountPoolCards(")
        cards_end = self.console_script.index("\nfunction accountPoolDraftValue", cards_start)
        cards = self.console_script[cards_start:cards_end]

        self.assertNotIn('class="account-pool-head"', account_pool)
        self.assertIn('data-account-pool-platform-tabs', platform_tabs)
        self.assertIn("renderAccountPoolPlatformIcon(value)", platform_tabs)
        self.assertIn('class="platform-brand-icon"', self.console_script)
        self.assertIn('class="platform-outline-icon platform-outline-icon--instagram"', self.console_script)
        self.assertIn('role="tablist"', platform_tabs)
        self.assertIn("account-pool-empty-state", cards)
        self.assertIn("暂无账号", cards)
        self.assertIn("function bindAccountPoolPlatformSwipe(host)", self.console_script)
        self.assertIn("function transitionAccountPoolPlatform(platform = \"\", direction = 0)", self.console_script)
        self.assertIn("function createAccountPoolPlatformMotion(platform = \"\", direction = 0)", self.console_script)
        self.assertIn('const swipeSurface = host?.querySelector(".account-pool-body");', self.console_script)
        self.assertIn('swipeSurface.addEventListener("pointerdown"', self.console_script)
        self.assertIn('window.addEventListener("pointermove", moveWindowGesture', self.console_script)
        self.assertIn('window.removeEventListener("pointermove", moveWindowGesture, true);', self.console_script)
        self.assertNotIn('event.target.closest("button, input, select, textarea, a")', self.console_script[
            self.console_script.index("function bindAccountPoolPlatformSwipe(host)"):
            self.console_script.index("\nfunction bindPersonaAccountPlatformSwipe(host)")
        ])
        self.assertIn("gesture.deltaX = gesture.motion.apply(deltaX);", self.console_script)
        self.assertIn("settleAccountPoolPlatformMotion(currentGesture.motion, commit)", self.console_script)
        self.assertIn("distanceThreshold", self.console_script)
        self.assertIn("Math.min(72, currentGesture.motion.width * 0.18)", self.console_script)
        self.assertNotIn('"lostpointercapture"', self.console_script[
            self.console_script.index("function bindAccountPoolPlatformSwipe(host)"):
            self.console_script.index("\nfunction bindPersonaAccountPlatformSwipe(host)")
        ])
        self.assertIn('window.addEventListener("pointerup", finishWindowGesture, true);', self.console_script)
        self.assertIn('window.removeEventListener("pointerup", finishWindowGesture, true);', self.console_script)
        self.assertIn("accountPoolPlatformSwipeSuppressClickUntil", self.console_script)
        self.assertIn("currentGesture.velocityX", self.console_script)
        self.assertIn("prefers-reduced-motion: reduce", self.console_script)
        motion_start = self.console_script.index("function createAccountPoolPlatformMotion(")
        motion_end = self.console_script.index("\nfunction clearAccountPoolPlatformMotion", motion_start)
        motion = self.console_script[motion_start:motion_end]
        self.assertIn('currentPanel?.querySelector(".account-pool-content-window")', motion)
        self.assertIn('contentWindow?.querySelector(".account-pool-content")', motion)
        self.assertIn('incomingPanel?.querySelector(".account-pool-content")', motion)
        self.assertIn('incomingContent.classList.add("account-pool-content-drag-peer")', motion)
        self.assertIn("contentWindow.appendChild(incomingContent)", motion)
        self.assertIn("Math.max(currentContent.offsetHeight, incomingContent.scrollHeight)", motion)
        self.assertNotIn("currentPanel.style.transform", motion)
        self.assertNotIn("account-pool-account-panel-drag-peer", motion)
        self.assertIn("account-pool-content-window", cards)
        self.assertIn("account-pool-content", cards)
        self.assertIn("function pulseAccountPoolPlatformCards()", self.console_script)
        self.assertIn('card.classList.add("is-platform-refresh-pulse")', self.console_script)
        self.assertIn('card.classList.remove("is-platform-refresh-pulse")', self.console_script)
        settle_start = self.console_script.index("async function settleAccountPoolPlatformMotion(")
        settle_end = self.console_script.index("\nasync function transitionAccountPoolPlatform", settle_start)
        settle = self.console_script[settle_start:settle_end]
        self.assertIn("stageAccountPoolPlatformSelection(next);", settle)
        self.assertLess(
            settle.index("stageAccountPoolPlatformSelection(next);"),
            settle.index("contentWindow.classList.add(\"is-account-platform-settling\")"),
        )
        self.assertNotIn("if (commit) selectAccountPoolPlatform(next);", settle)
        self.assertIn("renderSocialAccounts();", settle)
        self.assertIn("function syncAccountPoolPlatformTabs(", self.console_script)
        transition_start = self.console_script.index("async function transitionAccountPoolPlatform(")
        transition_end = self.console_script.index("\nfunction accountPoolAccounts", transition_start)
        transition = self.console_script[transition_start:transition_end]
        self.assertIn("accountPoolPlatformQueuedTarget = next;", transition)
        self.assertIn("await transitionAccountPoolPlatform(queuedTarget", transition)

        mobile_account_pool_styles = self.styles[self.styles.rindex("/* Account pool: platforms and accounts are separate functional modules. */"):]
        self.assertIn("border-bottom: 1px solid var(--line);", mobile_account_pool_styles)
        self.assertIn("overflow-x: auto;", mobile_account_pool_styles)
        self.assertIn("scroll-snap-type: x proximity;", mobile_account_pool_styles)
        self.assertIn("grid-template-columns: minmax(0, 1fr) auto;", mobile_account_pool_styles)
        self.assertIn(".account-pool-content-window.is-account-platform-dragging", mobile_account_pool_styles)
        self.assertIn(".account-pool-content-drag-peer", mobile_account_pool_styles)
        self.assertIn(".account-pool-content-window.is-account-platform-settling", mobile_account_pool_styles)
        self.assertIn("transition: transform 280ms", mobile_account_pool_styles)
        self.assertIn(".account-pool-content-window.is-account-platform-settling .account-pool-content-drag-current", mobile_account_pool_styles)
        self.assertIn("void currentContent.offsetWidth;", self.console_script)
        self.assertIn("void incomingContent.offsetWidth;", self.console_script)
        self.assertIn(".account-pool-body :is(button, input, select, textarea, a)", mobile_account_pool_styles)
        self.assertIn("touch-action: pan-y;", mobile_account_pool_styles)
        self.assertIn("@media (prefers-reduced-motion: reduce)", mobile_account_pool_styles)
        self.assertIn("@keyframes accountPoolCardRefreshPulse", mobile_account_pool_styles)
        self.assertIn("@keyframes accountPoolCardRefreshSweep", mobile_account_pool_styles)
        self.assertIn(".account-pool-card.is-platform-refresh-pulse", mobile_account_pool_styles)
        self.assertNotIn(".account-pool-account-panel.is-account-platform-drag-current", mobile_account_pool_styles)
        self.assertNotIn("@keyframes account-pool-platform", mobile_account_pool_styles)
        self.assertNotIn("will-change: transform, opacity;", mobile_account_pool_styles)

    def test_mobile_persistent_dock_pages_hide_the_left_toolbar_toggle_except_page_back_navigation(self):
        helper_start = self.console_script.index("function isMobilePersistentDockPage()")
        helper_end = self.console_script.index("\nfunction syncMobilePageToolbar()", helper_start)
        helper = self.console_script[helper_start:helper_end]
        toolbar = self.console_script[helper_end:self.console_script.index("\nfunction renderMobileTaskDock()", helper_end)]

        self.assertIn('state.view === "persona_dashboard"', helper)
        self.assertIn('state.view === "accounts"', helper)
        self.assertIn('state.view === "tasks"', helper)
        self.assertIn('if (state.view === "accounts") return true;', helper)
        self.assertIn('["personas", "tweet_generation", "publishing"].includes(state.activeModule)', helper)
        self.assertIn("function mobilePageBackTarget()", self.console_script)
        self.assertIn('["tasks", "billing", "console_settings"].includes(state.view)', self.console_script)
        self.assertIn('const navToggle = $("mobileNavToggle");', toolbar)
        self.assertIn("const showBrowserBack", toolbar)
        self.assertIn("const pageBackTarget = mobilePageBackTarget();", toolbar)
        self.assertIn('const showBrowserBack = pageBackTarget === "live-browser";', toolbar)
        self.assertIn("const showPageBack = Boolean(pageBackTarget);", toolbar)
        self.assertIn("navToggle.hidden = !showPageBack && isMobilePersistentDockPage();", toolbar)
        self.assertIn("renderMobileNavToggleIcon(showPageBack)", toolbar)
        self.assertIn('.mobile-page-toolbar > .mobile-nav-toggle[hidden]', self.styles)

    def test_console_settings_mobile_back_and_input_mode_avoid_full_page_rerender(self):
        navigation_start = self.console_script.index("function bindMobileNavigation()")
        navigation_end = self.console_script.index("\nfunction setPersonaMobileSidebarOpen", navigation_start)
        navigation = self.console_script[navigation_start:navigation_end]
        preference_start = self.console_script.index("function setBrowserPreferenceChoice(")
        preference_end = self.console_script.index("\nfunction refreshConsoleSettingsDependents()", preference_start)
        preferences = self.console_script[preference_start:preference_end]
        click_start = self.console_script.index('const inputMode = event.target.closest("[data-browser-text-input-mode]");')
        click_end = self.console_script.index("\n    if (event.target.closest(\"[data-browser-recommendation-refresh]\"))", click_start)
        input_mode_click = self.console_script[click_start:click_end]

        self.assertIn("const pageBackTarget = mobilePageBackTarget();", navigation)
        self.assertIn('if (pageBackTarget === "live-browser")', navigation)
        self.assertIn("setView(pageBackTarget);", navigation)
        self.assertIn('{ render = true } = {}', preferences)
        self.assertIn('if (render) renderConsoleSettingsPage();', preferences)
        self.assertIn('commit: () => setBrowserPreferenceChoice("text_input_mode", mode, { render: false })', input_mode_click)
        self.assertIn("syncBrowserTextInputModeTabs(mode);", input_mode_click)

    def test_persona_create_uses_the_shared_modal_and_merges_create_paths(self):
        create_start = self.console_script.index(
            "function renderPersonaCreateWorkbench()"
        )
        create_end = self.console_script.index(
            "\nfunction personaGroupStepOptions", create_start
        )
        create_workbench = self.console_script[create_start:create_end]

        self.assertIn('data-persona-create-ai-keywords', create_workbench)
        self.assertIn('"提炼关键词")}</button>', create_workbench)
        self.assertIn('data-persona-create aria-busy=', create_workbench)
        self.assertIn('renderBusyButtonContent("正在提炼关键词", true, createBusy.keywordsStartedAt)', create_workbench)
        self.assertIn('renderBusyButtonContent("正在生成人设", true, createBusy.aiCreateStartedAt)', create_workbench)
        self.assertNotIn("renderPersonaProfileListToggle", create_workbench)
        self.assertNotIn('data-persona-mobile-list-toggle', create_workbench)
        self.assertNotIn("data-persona-create-mode", create_workbench)
        self.assertNotIn(">AI 生成</button>", create_workbench)
        self.assertNotIn(">手动输入</button>", create_workbench)

        self.assertIn('modalKey: "persona-create"', create_workbench)
        self.assertIn('dialog.classList.add("persona-create-modal")', create_workbench)
        self.assertIn("function openPersonaCreateModal()", create_workbench)

    def test_persona_profile_editor_uses_the_shared_primary_button_style(self):
        self.assertIn(
            'class="primary persona-profile-editor-launch" data-persona-open-profile-editor',
            self.console_script,
        )

    def test_persona_create_keyword_limit_and_running_exit_confirmation_are_explicit(self):
        create_start = self.console_script.index("function renderPersonaCreateWorkbench()")
        create_end = self.console_script.index("\nfunction isPersonaCreateModalOpen()", create_start)
        create_workbench = self.console_script[create_start:create_end]
        modal_start = self.console_script.index("function openPersonaCreateModal()")
        modal_end = self.console_script.index("\nfunction personaGroupStepOptions", modal_start)
        create_modal = self.console_script[modal_start:modal_end]

        self.assertIn("最多选择 2 个，用于确定人设生成的重点方向", create_workbench)
        self.assertIn("const keywordLimitReached = aiSelectedKeywords.length >= 2;", create_workbench)
        self.assertIn("const disabled = aiCreateBusy || (!active && keywordLimitReached);", create_workbench)
        self.assertIn("function personaCreateHasPendingChanges()", self.console_script)
        self.assertIn('modal.__requestClose = () => {', create_modal)
        self.assertIn("const hasPendingChanges = personaCreateHasPendingChanges();", create_modal)
        self.assertIn('modalKey: "persona-create-exit-confirm",', create_modal)
        self.assertIn("stack: true,", create_modal)
        self.assertIn('cancelText: isBusy ? "继续运行" : "继续编辑",', create_modal)
        self.assertIn('confirmText: "确认退出",', create_modal)
        self.assertNotIn("window.confirm", create_modal)

    def test_selecting_the_current_persona_exits_persona_create_mode(self):
        selection_start = self.console_script.index(
            'const personaSelectButton = event.target.closest("[data-persona-select]")'
        )
        selection_end = self.console_script.index(
            'if (event.target.closest("[data-persona-open-create]"))',
            selection_start,
        )
        selection = self.console_script[selection_start:selection_end]

        self.assertIn("const wasCreatingPersona = state.personaCreateMode;", selection)
        self.assertIn(
            "if (nextPersonaId !== previousPersonaId || wasCreatingPersona)",
            selection,
        )
        self.assertIn(
            'if (wasCreatingPersona) setPersonaMobileSidebarOpen(false, "personaWorkspaceSidebar");',
            selection,
        )

    def test_persona_create_closes_the_drawer_and_opens_the_shared_modal(self):
        module_handler_start = self.console_script.index('$("moduleBody").addEventListener("click", async (event) => {')
        module_handler_end = self.console_script.index('\n  $("moduleBody").addEventListener("change"', module_handler_start)
        module_handler = self.console_script[module_handler_start:module_handler_end]
        create_handler_start = module_handler.index('if (event.target.closest("[data-persona-open-create]"))')
        create_handler_end = module_handler.index('const personaGroupButton = event.target.closest("[data-persona-group]")', create_handler_start)
        create_handler = module_handler[create_handler_start:create_handler_end]

        self.assertIn('setPersonaMobileSidebarOpen(false, "personaWorkspaceSidebar");', create_handler)
        self.assertIn('void openPersonaCreateModal();', create_handler)
        self.assertNotIn('renderPersonaDetail();', create_handler)

    def test_mobile_dock_repeat_click_checks_exact_account_panel(self):
        helper_start = self.console_script.index(
            "function isCurrentMobileTaskDockTarget(button)"
        )
        helper_end = self.console_script.index(
            "\nfunction scrollConsolePageToTop()", helper_start
        )
        helper = self.console_script[helper_start:helper_end]

        self.assertIn('state.view === "workspace"', helper)
        self.assertIn("moduleId === state.activeModule", helper)
        self.assertIn('button.dataset.workspacePanel || "accounts"', helper)
        self.assertIn("nextPanel === state.accountBrowserPanel", helper)

    def test_mobile_persona_editor_keeps_its_drawer_anchor_and_clears_on_close(self):
        module_start = self.console_script.index("function renderPersonaModule()")
        module_end = self.console_script.index("\nfunction personaGeneratedPreviewPosts", module_start)
        module = self.console_script[module_start:module_end]
        sidebar_start = self.console_script.index("function setPersonaMobileSidebarOpen")
        sidebar_end = self.console_script.index("\nfunction syncPersonaMobileSidebarMode", sidebar_start)
        sidebar = self.console_script[sidebar_start:sidebar_end]

        self.assertIn(
            'document.getElementById("personaWorkspaceSidebar")?.classList.contains("is-mobile-open")',
            module,
        )
        self.assertIn(
            'setPersonaMobileSidebarOpen(reopenPersonaWorkspaceSidebar, "personaWorkspaceSidebar")',
            module,
        )
        self.assertIn('if (!nextOpen && isMobileNavMode())', sidebar)
        self.assertIn('state.personaListEditorId = ""', sidebar)
        self.assertIn('removePersonaCardEditorPortal()', sidebar)

    def test_mobile_persona_drawer_matches_the_shared_site_drawer_width(self):
        self.assertIn(
            "--site-mobile-drawer-width: min(320px, 100vw);",
            self.navigation_styles,
        )
        self.assertIn(
            "width: var(--site-mobile-drawer-width);",
            self.styles,
        )
        backdrop_rule = self.styles.split(
            "  .persona-mobile-drawer-backdrop {", 1
        )[1].split("  }", 1)[0]
        self.assertIn("width: 100vw;", backdrop_rule)
        self.assertIn("height: 100dvh;", backdrop_rule)
        for obsolete_width in (
            "width: min(80vw, 280px);",
            "width: min(82vw, 264px);",
            "width: min(84vw, 304px);",
            "width: min(88vw, 292px);",
        ):
            self.assertNotIn(obsolete_width, self.styles)

    def test_persona_bulk_management_unifies_personas_and_groups(self):
        module_start = self.console_script.index("function renderPersonaModule()")
        module_end = self.console_script.index("\nfunction personaGeneratedPreviewPosts", module_start)
        module = self.console_script[module_start:module_end]
        folder_start = self.console_script.index("function renderPersonaFolder(")
        folder_end = self.console_script.index("\nfunction renderPersonaCollectionList", folder_start)
        folder = self.console_script[folder_start:folder_end]
        handler_start = self.console_script.index(
            'const startPersonaBulk = event.target.closest("[data-persona-bulk-start]");'
        )
        handler_end = self.console_script.index(
            'const previewButton = event.target.closest("[data-media-preview-group]");',
            handler_start,
        )
        handler = self.console_script[handler_start:handler_end]
        delete_start = self.console_script.index(
            "async function deleteBulkSelectedPersonaEntries()"
        )
        delete_end = self.console_script.index(
            "\nasync function duplicatePersonaArchive", delete_start
        )
        delete_flow = self.console_script[delete_start:delete_end]

        self.assertNotIn("personaBulkScope", self.console_script)
        self.assertNotIn("data-persona-bulk-scope", self.console_script)
        self.assertNotIn(".persona-bulk-scope", self.styles)
        self.assertIn("bulkSelectedPersonaIds.size + bulkSelectedGroupIds.size", module)
        self.assertIn("currentPagePersonaIds.every", module)
        self.assertIn("currentPageGroupIds.every", module)
        self.assertIn('data-persona-bulk-group-check="${esc(group.id)}"', folder)
        self.assertIn('data-persona-bulk-check="${esc(persona.id)}"', self.console_script)
        self.assertIn("const collapsed = Boolean(group.collapsed);", folder)
        self.assertIn('data-persona-toggle-folder="${esc(group.id)}"', folder)
        self.assertEqual(folder.count('data-persona-bulk-group-toggle="${esc(group.id)}"'), 1)
        self.assertIn('button.closest(".persona-folder-card.is-bulk-selecting")', self.console_script)
        self.assertIn("state.personaBulkSelectedIds = new Set();", handler)
        self.assertIn("state.personaBulkSelectedGroupIds = new Set();", handler)
        self.assertIn("setPersonaBulkSelection(personaIds, !allSelected);", handler)
        self.assertIn("setPersonaBulkGroupSelection(groupIds, !allSelected);", handler)
        self.assertEqual(delete_flow.count("openConsoleModal({"), 1)
        self.assertEqual(delete_flow.count("/api/persona_dashboard/selection/batch-delete"), 1)
        self.assertIn("JSON.stringify({ persona_ids: personaIds, group_ids: groupIds })", delete_flow)

    def test_mobile_publish_group_editor_keeps_the_publish_drawer_open(self):
        module_start = self.console_script.index("function renderSimpleFlowModule(moduleId)")
        module_end = self.console_script.index("\nfunction bindSimpleFlowInputs", module_start)
        module = self.console_script[module_start:module_end]

        self.assertIn(
            'document.getElementById("publishPersonaSidebar")?.classList.contains("is-mobile-open")',
            module,
        )
        self.assertIn(
            'setPersonaMobileSidebarOpen(reopenPublishPersonaSidebar, "publishPersonaSidebar")',
            module,
        )
        self.assertNotIn(
            'if (moduleId === "publishing" || moduleId === "automation") setPersonaMobileSidebarOpen(false);',
            module,
        )

    def test_mobile_persona_selection_preserves_every_open_drawer(self):
        module_start = self.console_script.index("function renderSimpleFlowModule(moduleId)")
        module_end = self.console_script.index("\nfunction bindSimpleFlowInputs", module_start)
        module = self.console_script[module_start:module_end]
        selection_start = self.console_script.index(
            'const personaSelectButton = event.target.closest("[data-persona-select]")'
        )
        selection_end = self.console_script.index(
            'if (event.target.closest("[data-persona-open-create]"))',
            selection_start,
        )
        selection = self.console_script[selection_start:selection_end]
        binding_start = self.console_script.index("async function bindAccountPoolAccountToPersona")
        binding_end = self.console_script.index("\nasync function unbindAccountPoolAccount", binding_start)
        binding = self.console_script[binding_start:binding_end]

        self.assertIn(
            'document.getElementById("automationPersonaSidebar")?.classList.contains("is-mobile-open")',
            module,
        )
        self.assertIn(
            'setPersonaMobileSidebarOpen(reopenAutomationPersonaSidebar, "automationPersonaSidebar")',
            module,
        )
        self.assertNotIn('setPersonaMobileSidebarOpen(false)', selection)
        self.assertNotIn('setPersonaMobileSidebarOpen(false)', binding)

        close_start = self.console_script.index(
            'if (event.target.closest("[data-persona-mobile-list-close], [data-persona-mobile-list-backdrop]"))'
        )
        close_end = self.console_script.index("\n    const startPersonaBulk", close_start)
        self.assertIn("setPersonaMobileSidebarOpen(false);", self.console_script[close_start:close_end])

    def test_mobile_account_pool_persona_drawer_reserves_header_and_status_space(self):
        account_sidebar_start = self.console_script.index("function renderAccountPoolPersonaSidebar")
        account_sidebar_end = self.console_script.index("\nfunction renderAccountPool", account_sidebar_start)
        account_sidebar = self.console_script[account_sidebar_start:account_sidebar_end]

        self.assertIn(
            'class="persona-head-copy account-pool-persona-head-copy"',
            account_sidebar,
        )
        self.assertIn(
            ".account-pool-persona-shell .persona-list-head--queue",
            self.styles,
        )
        self.assertIn(
            ".persona-mobile-drawer.account-pool-persona-shell .publish-persona-card",
            self.styles,
        )
        self.assertIn("padding-right: 56px;", self.styles)

    def test_avatar_add_button_keeps_the_desktop_icon_size_on_mobile(self):
        self.assertIn(
            'class="persona-avatar-add-button" data-persona-avatar-crop-open',
            self.console_script,
        )
        mobile_start = self.styles.index(
            "  .console-page .console-shell .persona-detail button.persona-avatar-add-button {",
            self.styles.index("/* Final mobile density pass:"),
        )
        mobile_rule = self.styles[mobile_start:self.styles.index("\n  }", mobile_start) + 4]
        self.assertIn("width: 28px;", mobile_rule)
        self.assertIn("height: 28px;", mobile_rule)
        self.assertIn("min-width: 28px;", mobile_rule)
        self.assertIn("min-height: 28px;", mobile_rule)
        self.assertIn("border-radius: 50%;", mobile_rule)
        self.assertNotIn("32px", mobile_rule)

    def test_avatar_without_persona_images_requires_confirmation_before_generation(self):
        start = self.console_script.index("async function openPersonaAvatarCropModal()")
        end = self.console_script.index("\nfunction personaProfileEditDraft", start)
        module = self.console_script[start:end]

        self.assertIn('title: "还没有可用的人设图"', module)
        self.assertIn('confirmText: "生成人设图"', module)
        self.assertIn('cancelText: "暂不生成"', module)
        self.assertIn("if (goToGeneration) await submitPersonaImageGeneration();", module)
        self.assertIn(
            "await loadPersonaImageLibrary(persona.id, { force: true, throwOnError: true });",
            module,
        )

    def test_avatar_crop_supports_touch_pinch_and_device_neutral_guidance(self):
        start = self.console_script.index("function personaAvatarCropModalHtml")
        end = self.console_script.index("\nfunction personaProfileEditDraft", start)
        module = self.console_script[start:end]

        self.assertIn(
            "圆形区域为最终头像范围。拖动图片调整位置，缩放图片调整大小。",
            module,
        )
        self.assertIn("调整完成后点击“应用头像”保存。", module)
        self.assertNotIn("使用滚轮放大或缩小", module)
        self.assertIn("const activePointers = new Map();", module)
        self.assertIn("Math.hypot(", module)
        self.assertIn("pinchState.zoom * (pointerDistance() / pinchState.distance)", module)
        self.assertIn('stage.addEventListener("pointercancel", stopDragging);', module)
        self.assertIn('stage.addEventListener("lostpointercapture", stopDragging);', module)
        self.assertNotIn("event.isPrimary === false", module)

    def test_mobile_publish_content_expands_without_inner_scroll(self):
        self.assertIn(".mobile-task-dock {", self.styles)
        self.assertIn("grid-template-columns: repeat(5, minmax(0, 1fr));", self.styles)
        self.assertIn(".publish-header-main > .publish-mode-tabs", self.styles)
        self.assertIn(".publish-time-tabs {", self.styles)
        self.assertIn(".publish-post-card-snippet {", self.styles)
        self.assertIn("white-space: pre-wrap;", self.styles)
        self.assertNotIn('.slice(0, 86) || "当前内容为空。"', self.console_script)
        self.assertNotIn('.slice(0, 170))}</p>', self.console_script)

    def test_draft_bulk_toolbar_does_not_restore_a_white_fill(self):
        toolbar = self.styles[
            self.styles.index(".persona-draft-toolbar--posts {"):
            self.styles.index("}\n", self.styles.index(".persona-draft-toolbar--posts {"))
        ]
        self.assertIn("background: transparent;", toolbar)

    def test_mobile_page_toolbar_is_shared_and_keeps_publish_header_compact(self):
        header_start = self.console_script.index("function renderPublishHeaderRow(mode, account)")
        header_end = self.console_script.index("\nconst SHANGHAI_TIME_ZONE", header_start)
        header = self.console_script[header_start:header_end]
        toolbar_start = self.markup.index('id="mobilePageToolbar"')
        toolbar_end = self.markup.index('<main id="main-content"', toolbar_start)
        toolbar = self.markup[toolbar_start:toolbar_end]
        header_end = self.markup.index("</header>")
        site_header = self.markup[:header_end]

        self.assertNotIn('id="mobileNavToggle"', site_header)
        self.assertIn('id="mobileNavToggle"', toolbar)
        self.assertIn('id="mobilePageToolbarTitle"', toolbar)
        self.assertNotIn('id="mobilePageContextAction"', toolbar)
        self.assertNotIn('id="mobilePageContextLabel"', toolbar)
        self.assertIn("function mobilePageToolbarDescriptor()", self.console_script)
        self.assertIn("function syncMobilePageToolbar()", self.console_script)
        self.assertIn('grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);', self.styles)
        self.assertIn("height: 52px;", self.styles)
        self.assertIn("min-height: 52px;", self.styles)
        self.assertIn("height: 40px;", self.styles)
        self.assertIn("min-height: 40px;", self.styles)
        self.assertIn("height: 44px;", self.styles)
        self.assertIn("min-height: 44px;", self.styles)
        self.assertIn(".mobile-page-toolbar > .mobile-nav-toggle", self.styles)
        self.assertNotIn(".mobile-page-context-action", self.styles)
        self.assertIn('class="publish-inline-title">任务</strong>', header)
        self.assertNotIn('${renderMobileTaskIcon("publishing")}', header)
        self.assertNotIn('class="publish-header-end-slot"', header)
        self.assertNotIn('data-persona-mobile-list-toggle="publishPersonaSidebar"', header)
        toggle_start = self.console_script.index("function renderPersonaProfileListToggle(")
        toggle_end = self.console_script.index("\nfunction personaAvatarCropModalHtml", toggle_start)
        toggle = self.console_script[toggle_start:toggle_end]
        self.assertNotIn("function renderPersonaModuleSummary(", self.console_script)
        self.assertNotIn(".module-persona-summary", self.styles)
        self.assertIn('data-persona-mobile-list-toggle="${esc(sidebarId)}"', toggle)
        self.assertNotIn("<span>人设列表</span>", toggle)
        self.assertIn('sidebarId: "publishPersonaSidebar"', self.console_script)
        self.assertIn("renderPersonaProfileIdentity(selectedPersonaForPublish, null, {", self.console_script)
        self.assertIn('state.activeModule === "tweet_generation"', self.console_script)
        self.assertIn("renderPersonaProfileIdentity(persona, profile, {", self.console_script)
        self.assertIn("persona-profile-compact-meta", self.styles)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr));", self.styles)
        self.assertNotIn("publish-account-badge", header)
        self.assertNotIn("到账号管理绑定", header)

    def test_mobile_persona_profile_uses_the_existing_sidebar_with_inline_summary(self):
        self.assertNotIn('id="persistentPersonaSummary"', self.markup)
        self.assertNotIn("renderPersistentPersonaSummary", self.console_script)
        self.assertNotIn("persistentPersona", self.console_script)
        self.assertNotIn("persistent-persona", self.styles)
        self.assertIn("function personaSummaryCounts(persona)", self.console_script)
        identity = self.console_script[
            self.console_script.index("function renderPersonaProfileIdentity("):
            self.console_script.index("\nfunction renderPersonaContentOverview")
        ]
        self.assertNotIn("名称、简介、头像与生成设置", identity)
        self.assertIn('class="persona-profile-summary-strip"', identity)
        self.assertIn('class="persona-profile-summary-grid"', identity)
        self.assertIn("personaGroupsForPersona(persona?.id)", identity)
        self.assertIn("人设分组", identity)
        self.assertIn("草稿", identity)
        self.assertIn("收藏", identity)
        self.assertNotIn("类型：", identity)
        self.assertIn("renderPersonaExecutionAccountBadge(persona)", identity)
        self.assertIn("renderPersonaProfileListToggle(sidebarId)", identity)
        self.assertIn("renderPersonaAvatar(persona, resolvedProfile, displayAvatar)", identity)
        self.assertIn('class="persona-profile-compact-layout"', identity)
        self.assertIn('class="persona-profile-compact-meta"', identity)
        self.assertNotIn('class="persona-profile-compact-actions"', identity)
        self.assertNotIn("selectionLabel", identity)
        self.assertIn("${listToggle}", identity)
        self.assertNotIn("人设简介</strong>\n          ${listToggle}\n        </div>\n        <div class=\"persona-profile-compact-layout\"", identity)
        self.assertLess(
            identity.index("persona-profile-compact-layout"),
            identity.index("persona-profile-account-status"),
        )
        self.assertLess(
            identity.index("persona-profile-account-status"),
            identity.index("persona-profile-compact-meta"),
        )
        full_title_index = identity.index("<strong>人设简介</strong>")
        full_identity_start = identity.rfind(
            '<div class="persona-profile-data-panel-head persona-profile-data-panel-head--identity">',
            0,
            full_title_index,
        )
        full_identity = identity[full_identity_start:]
        full_header = full_identity[:full_identity.index("</div>")]
        full_name_start = full_identity.index('<div class="persona-profile-name-row">')
        full_name_row = full_identity[full_name_start:full_identity.index("</div>", full_name_start)]
        self.assertIn("persona-profile-header-account", full_header)
        self.assertLess(full_header.index("人设简介"), full_header.index("persona-profile-header-account"))
        self.assertLess(full_header.index("persona-profile-header-account"), full_header.index("${listToggle}"))
        self.assertNotIn("persona-profile-account-status", full_name_row)
        self.assertIn("persona-profile-overview-shell", self.console_script)
        self.assertIn('sidebarId = "personaWorkspaceSidebar"', identity)
        self.assertIn("function setPersonaMobileSidebarOpen(open, sidebarId", self.console_script)
        self.assertIn('data-persona-mobile-sidebar', self.console_script)
        self.assertIn(".persona-profile-summary-strip {", self.styles)
        self.assertIn(".persona-profile-list-toggle {", self.styles)
        self.assertIn(".persona-profile-account-status {", self.styles)
        self.assertIn(".persona-profile-data-panel-head--identity {", self.styles)
        self.assertIn("grid-template-columns: max-content minmax(0, 1fr) max-content;", self.styles)
        self.assertIn(".persona-profile-header-account {", self.styles)
        self.assertIn("grid-template-columns: 88px minmax(0, 1fr) 36px;", self.styles)
        self.assertIn(
            ".persona-profile-data-panel-head--identity .persona-profile-header-account {\n"
            "    justify-self: start;",
            self.styles,
        )
        self.assertIn(".persona-profile-identity-content {", self.styles)
        self.assertIn(".persona-profile-name-row {", self.styles)
        self.assertIn(
            ".console-page .persona-detail .persona-avatar {\n"
            "    width: 88px;",
            self.styles,
        )
        self.assertIn(".persona-profile-overview-shell", self.styles)

    def test_matrix_publish_moves_persona_list_control_into_submit_preview(self):
        publishing_start = self.console_script.index('if (moduleId === "publishing")')
        publishing_end = self.console_script.index('} else if (moduleId === "automation")', publishing_start)
        publishing = self.console_script[publishing_start:publishing_end]
        matrix_start = publishing.index('if (publishMode === "matrix_start")')
        matrix_end = publishing.index('} else if (publishMode === "automation_tasks")', matrix_start)
        matrix_branch = publishing[matrix_start:matrix_end]

        self.assertNotIn("${personaSummary}", matrix_branch)
        self.assertLess(matrix_branch.index("${modeTabs}"), matrix_branch.index("${renderMatrixPublishPanel()}"))

        panel_start = self.console_script.index("function renderMatrixPublishPanel(")
        panel_end = self.console_script.index("\nasync function submitMatrixPublishTask", panel_start)
        panel = self.console_script[panel_start:panel_end]
        self.assertIn('renderPersonaProfileListToggle("publishPersonaSidebar")', panel)
        self.assertLess(
            panel.index('renderPersonaProfileListToggle("publishPersonaSidebar")'),
            panel.index("data-matrix-remove-all"),
        )

    def test_matrix_publish_panel_uses_the_shared_white_functional_card_surface(self):
        self.assertIn(
            ".matrix-publish-panel {\n"
            "  display: grid;\n"
            "  gap: 14px;\n"
            "  padding: 14px;\n"
            "  border: 1px solid var(--line);\n"
            "  border-radius: var(--radius);\n"
            "  background: var(--panel-solid);",
            self.styles,
        )

    def test_matrix_publish_reuses_account_pool_platform_cards_in_a_vertical_dropdown(self):
        panel_start = self.console_script.index("function renderMatrixPublishPanel(")
        panel_end = self.console_script.index("\nasync function submitMatrixPublishTask", panel_start)
        panel = self.console_script[panel_start:panel_end]

        self.assertIn("const renderPlatformTab = (value) =>", panel)
        self.assertIn("renderAccountPoolPlatformIcon(value)", panel)
        self.assertIn('data-matrix-publish-platform-option="${esc(value)}"', panel)
        self.assertIn('class="matrix-publish-platform-trigger" data-matrix-publish-platform-trigger', panel)
        self.assertIn('class="matrix-publish-platform-menu" data-matrix-publish-platform-menu', panel)
        self.assertIn('class="account-pool-platforms account-pool-platform-tabs matrix-publish-platform-options"', panel)
        self.assertIn('id="matrixPublishPlatform" type="hidden"', panel)
        self.assertNotIn('<select id="matrixPublishPlatform">', panel)
        self.assertNotIn("matrix-publish-account-notice", panel)
        self.assertIn('document.querySelectorAll("[data-matrix-publish-platform-option]")', self.console_script)
        self.assertIn(".matrix-publish-settings {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));", self.styles)
        self.assertIn(".matrix-publish-platform-options {\n  position: static;\n  grid-template-columns: minmax(0, 1fr);", self.styles)
        self.assertIn(".console-page .matrix-publish-platform-options.account-pool-platforms.account-pool-platform-tabs {\n    display: grid;\n    grid-template-columns: minmax(0, 1fr);", self.styles)
        self.assertIn(
            ".matrix-publish-platform-trigger,\n"
            ".matrix-publish-count-field select {\n"
            "  box-sizing: border-box;\n"
            "  width: 100%;\n"
            "  height: 50px;\n"
            "  min-height: 50px;\n"
            "  padding: 10px 11px;\n"
            "  border: 1px solid var(--line);\n"
            "  border-radius: var(--radius);",
            self.styles,
        )
        self.assertIn(".matrix-toolbar {\n  display: flex;\n  align-items: center;", self.styles)
        self.assertIn(
            ".console-page .matrix-publish-panel {\n"
            "    padding: var(--mobile-functional-card-padding);",
            self.styles,
        )

    def test_matrix_publish_count_select_is_limited_to_current_common_capacity(self):
        update_start = self.console_script.index("function updateMatrixPublishStateFromForm()")
        update_end = self.console_script.index("\nfunction closeMatrixPublishPlatformPicker", update_start)
        update = self.console_script[update_start:update_end]
        panel_start = self.console_script.index("function renderMatrixPublishPanel(")
        panel_end = self.console_script.index("\nasync function submitMatrixPublishTask", panel_start)
        panel = self.console_script[panel_start:panel_end]

        self.assertIn("matrixPublishCommonLimit(matrixPublishAvailabilityRows(selectedIds, source, platform))", update)
        self.assertIn("const availableLimit = Math.min(matrixPublishCommonLimit(availability), 20);", panel)
        self.assertIn("const countOptions = availableLimit", panel)
        self.assertIn('<select id="matrixPublishCount" ${countOptions.length ? "" : "disabled"}>', panel)
        self.assertIn("Array.from({ length: availableLimit }, (_, index) => index + 1)", panel)
        self.assertIn('<option value="0">暂无可执行内容</option>', panel)

    def test_non_matrix_publish_modes_render_persona_summary_below_mode_tabs(self):
        publishing_start = self.console_script.index('if (moduleId === "publishing")')
        publishing_end = self.console_script.index('} else if (moduleId === "automation")', publishing_start)
        publishing = self.console_script[publishing_start:publishing_end]

        automation_start = publishing.index('} else if (publishMode === "automation_tasks")')
        history_start = publishing.index('} else if (publishMode === "publish_history")', automation_start)
        automation_branch = publishing[automation_start:history_start]
        self.assertLess(automation_branch.index("${modeTabs}"), automation_branch.index("${personaSummary}"))
        self.assertLess(automation_branch.index("${personaSummary}"), automation_branch.index("${renderAutomationTaskPlanPanel"))

        normal_start = publishing.index("} else {", history_start)
        history_branch = publishing[history_start:normal_start]
        self.assertLess(history_branch.index("${modeTabs}"), history_branch.index("${personaSummary}"))
        self.assertLess(history_branch.index("${personaSummary}"), history_branch.index("${renderPublishHistoryPanel"))

        normal_branch = publishing[normal_start:]
        self.assertLess(normal_branch.index("${modeTabs}"), normal_branch.index("${personaSummary}"))
        self.assertLess(normal_branch.index("${personaSummary}"), normal_branch.index("${renderPublishContentPanel"))

    def test_persona_profile_editor_emphasizes_name_and_opens_image_lightbox(self):
        editor_start = self.console_script.index("async function openPersonaProfileEditorModal()")
        editor_end = self.console_script.index("modal?.addEventListener(\"change\"", editor_start)
        editor_handler = self.console_script[editor_start:editor_end]

        self.assertIn('const previewButton = event.target.closest("[data-media-preview-group]");', editor_handler)
        self.assertIn("openPersonaMediaLightbox(", editor_handler)
        self.assertLess(
            editor_handler.index('const previewButton = event.target.closest("[data-media-preview-group]");'),
            editor_handler.index('const pageButton = event.target.closest("button[data-persona-profile-editor-page]");'),
        )
        self.assertIn("zoomHint: true,", self.console_script)
        self.assertIn("function renderZoomInIcon()", self.console_script)
        self.assertIn("${renderZoomInIcon()}", self.console_script)
        self.assertIn(".persona-profile-editor-item--profile .persona-profile-editor-item-copy b {", self.styles)
        self.assertIn(".persona-profile-editor-form #personaProfileEditorName {", self.styles)
        self.assertIn(".persona-image-library-zoom-hint {", self.styles)
        self.assertIn(".persona-image-library-zoom-hint .ui-zoom-in-icon {", self.styles)

    def test_mobile_page_shells_do_not_create_nested_cards(self):
        marker = "/* Mobile pages use a canvas plus functional cards, never page-card-in-page-card. */"
        self.assertIn(marker, self.styles)
        mobile_styles = self.styles[self.styles.index(marker):]

        self.assertIn(".console-page .console-main,", mobile_styles)
        self.assertIn(".console-page .view {", mobile_styles)
        self.assertIn('.view[data-panel="workspace"]', mobile_styles)
        self.assertIn('.view[data-panel="persona_dashboard"]', mobile_styles)
        self.assertIn('background: var(--bg);', mobile_styles)
        self.assertIn('.view[data-panel="workspace"] .module-panel', mobile_styles)
        self.assertIn('.persona-step-shell > .persona-inline-panel', mobile_styles)
        self.assertIn('.account-pool-main', mobile_styles)
        self.assertIn('.automation-plan-row-main', mobile_styles)
        self.assertIn('.automation-plan-submit-row', mobile_styles)
        self.assertIn('.live-browser-panel', mobile_styles)
        self.assertIn('.persona-mobile-drawer > .persona-list-toolbar.persona-inline-panel', mobile_styles)
        functional_shell_start = mobile_styles.index(".console-page .persona-detail,")
        functional_shell_end = mobile_styles.index("\n  }", functional_shell_start)
        functional_shell = mobile_styles[functional_shell_start:functional_shell_end]
        self.assertIn(
            ".console-page .persona-compose-media-side.persona-production-section,",
            functional_shell,
        )
        for declaration in (
            "padding: 0;",
            "border: 0;",
            "border-radius: 0;",
            "background: transparent;",
            "box-shadow: none;",
        ):
            self.assertIn(declaration, functional_shell)

    def test_mobile_pages_share_the_persona_reference_content_gutter(self):
        marker = "/* Shared mobile page spacing: one canvas gutter, then functional-card padding. */"
        self.assertIn(marker, self.styles)
        mobile_styles = self.styles[self.styles.index(marker):]

        self.assertIn("--mobile-page-inner-gutter: 6px;", mobile_styles)
        self.assertIn("--mobile-functional-card-padding: 8px;", mobile_styles)
        shared_gutter_selector = (
            ".console-page .persona-detail,\n"
            "  .console-page .publish-config-panel,\n"
            "  .console-page .persona-dashboard-page,\n"
            '  .console-page .view[data-panel="tasks"],\n'
            '  .console-page .view[data-panel="accounts"],\n'
            '  .console-page .view[data-panel="console_settings"],\n'
            "  .console-page .billing-view {"
        )
        self.assertIn(shared_gutter_selector, mobile_styles)
        shared_gutter_start = mobile_styles.index(shared_gutter_selector)
        shared_gutter_end = mobile_styles.index("\n  }", shared_gutter_start)
        self.assertIn(
            "padding: var(--mobile-page-inner-gutter);",
            mobile_styles[shared_gutter_start:shared_gutter_end],
        )

    def test_mobile_persona_sidebar_triggers_remain_available(self):
        self.assertNotIn(
            ".console-main .persona-mobile-list-toggle[data-persona-mobile-list-toggle]",
            self.styles,
        )
        self.assertNotIn(
            ".persona-mobile-list-toggle[data-persona-mobile-list-toggle] {\n    display: none;",
            self.styles,
        )
        self.assertIn('sidebarId: "publishPersonaSidebar"', self.console_script)
        self.assertIn('data-persona-mobile-list-toggle="automationPersonaSidebar"', self.console_script)
        self.assertIn('data-persona-mobile-list-toggle="taskQueuePersonaSidebar"', self.console_script)

    def test_publish_preview_number_tabs_are_hidden_only_on_mobile(self):
        preview = self.console_script[
            self.console_script.index("function renderPublishContentPreview"):
            self.console_script.index("\nfunction renderPublishContentPanel")
        ]
        self.assertIn(
            'class="publish-content-preview publish-content-preview--selection ${selectedPosts.length ? "" : "is-empty"}"',
            preview,
        )
        self.assertIn(
            'aria-label="${esc(`第${previewIndex + 1}篇：${previewTitle}`)}"',
            preview,
        )
        self.assertIn("publish-preview-tabs-layout", preview)
        self.assertIn("data-publish-preview-post", preview)
        self.assertIn("publish-preview-tab-index", preview)
        mobile_tabs = self.styles.index(
            "  .publish-content-preview--selection .publish-preview-tabs-layout {"
        )
        self.assertIn("display: none;", self.styles[mobile_tabs:mobile_tabs + 140])

    def test_publish_source_cards_render_complete_media(self):
        self.assertIn(
            'class="publish-post-card-media">${renderPublishPreviewMedia(mediaItems)}',
            self.console_script,
        )
        self.assertIn(".publish-post-card-media {", self.styles)
        desktop_rule = self.styles.index(".publish-post-card-media {\n  display: none;")
        mobile_rule = self.styles.index(".publish-post-card-media {\n    display: block;")
        self.assertLess(desktop_rule, mobile_rule)

    def test_generation_reuses_shared_link_settings_before_media_composer(self):
        self.assertIn("function applyPersonaLinkPresetToContent", self.console_script)
        self.assertIn("function personaLinkEndingContent(preset)", self.console_script)
        self.assertIn("function renderPublishLinkSettings", self.console_script)
        self.assertIn('class="unified-action-icon-button" data-persona-create-memory', self.console_script)
        self.assertIn('data-persona-open-links', self.console_script)
        self.assertIn('class="unified-action-icon-button" data-persona-open-links title="链接设置" aria-label="链接设置"', self.console_script)
        self.assertIn('class="account-pool-bind-persona unified-action-icon-button"', self.console_script)
        unified_icon_rules = self.styles[self.styles.index(".unified-action-icon-button {"):self.styles.index(".unified-action-icon-button.danger {")]
        self.assertIn("border: 0;", unified_icon_rules)
        self.assertIn("background: transparent;", unified_icon_rules)
        self.assertIn('<svg class="ui-link-icon" viewBox="0 0 24 24"', self.console_script)
        self.assertNotIn('<span>链接设置</span>', self.console_script)
        self.assertIn('content_override: publishContentForPost(post, persona)', self.console_script)
        generation_start = self.console_script.index("function renderPersonaContentPanel")
        generation_end = self.console_script.index('\n  if (panel === "media")', generation_start)
        generation_panel = self.console_script[generation_start:generation_end]
        self.assertIn("${renderPublishLinkSettings(persona)}", generation_panel)
        self.assertLess(
            generation_panel.index("${renderPublishLinkSettings(persona)}"),
            generation_panel.index("renderPersonaInlineMediaComposer"),
        )

    def test_account_pool_cards_open_the_existing_persona_binding_drawer(self):
        card_start = self.console_script.index("function renderAccountPoolCard(account")
        card_end = self.console_script.index("\nfunction renderAccountPoolCards", card_start)
        card_renderer = self.console_script[card_start:card_end]
        self.assertIn(
            'renderPersonaProfileListToggle("accountPoolPersonaSidebar")',
            card_renderer,
        )

        pool_start = self.console_script.index("function renderAccountPool()")
        pool_end = self.console_script.index("\nfunction bindAccountPoolPlatformSwipe", pool_start)
        pool_renderer = self.console_script[pool_start:pool_end]
        self.assertIn(
            "${renderAccountPoolPersonaSidebar(selectedAccount)}",
            pool_renderer,
        )

        account_click_start = self.console_script.index(
            'const personaMobileToggle = event.target.closest("[data-persona-mobile-list-toggle]");',
            self.console_script.index('if ($("accountBrowserShell"))'),
        )
        account_click_end = self.console_script.index(
            'if (event.target.closest("[data-persona-mobile-list-close]',
            account_click_start,
        )
        account_click = self.console_script[account_click_start:account_click_end]
        self.assertIn("selectAccountPoolAccount", account_click)
        self.assertIn('setPersonaMobileSidebarOpen(true, "accountPoolPersonaSidebar")', account_click)

        social_render_start = self.console_script.index("function renderSocialAccounts()")
        social_render_end = self.console_script.index(
            "\nfunction setAccountBrowserPanel",
            social_render_start,
        )
        social_render = self.console_script[social_render_start:social_render_end]
        self.assertIn("reopenAccountPoolPersonaSidebar", social_render)
        self.assertIn(
            'setPersonaMobileSidebarOpen(true, "accountPoolPersonaSidebar")',
            social_render,
        )
        self.assertIn(
            '} else if (state.view === "accounts") {',
            social_render,
        )

        self.assertIn(".account-pool-card > .persona-profile-list-toggle {", self.styles)
        self.assertIn(
            ".account-pool-layout--standalone > .account-pool-persona-shell {",
            self.styles,
        )
        self.assertIn(".publish-link-settings {", self.styles)
        self.assertIn(".publish-link-settings button[data-persona-open-links] .ui-link-icon {", self.styles)
        self.assertIn(".persona-compose-media-stack > .publish-link-settings", self.styles)
        self.assertNotIn('<span class="publish-link-settings-label">', self.console_script)
        self.assertNotIn("publish-link-settings-label", self.styles)
        self.assertNotIn('<span class="publish-link-settings-label">临时链接</span>', self.console_script)

    def test_persona_account_health_icon_precedes_ungrouped_badge(self):
        card_start = self.console_script.index("function renderPersonaCard")
        card_end = self.console_script.index("\nfunction renderPersonaFolder", card_start)
        card_renderer = self.console_script[card_start:card_end]

        title_start = card_renderer.index('class="persona-card-title"')
        title_end = card_renderer.index("${isPublishContext", title_start)
        title_markup = card_renderer[title_start:title_end]
        self.assertLess(
            title_markup.index("persona-account-health-icon"),
            title_markup.index("persona-ungrouped-badge"),
        )

        status_start = card_renderer.index('class="persona-card-status"')
        status_markup = card_renderer[status_start:]
        self.assertLess(
            status_markup.index("persona-account-health-icon"),
            status_markup.index("persona-ungrouped-badge"),
        )

    def test_link_templates_use_one_unified_ending_content_field(self):
        self.assertIn('label>结尾内容', self.console_script)
        self.assertIn('id="personaLinkPresetEnding"', self.console_script)
        self.assertNotIn('id="personaLinkPresetUrl"', self.console_script)
        self.assertNotIn('label>链接地址', self.console_script)
        self.assertNotIn('结尾文案', self.console_script)
        self.assertIn('link_url: "",', self.console_script)
        self.assertIn('personaLinkEndingContent(item)', self.console_script)
        self.assertIn('.persona-link-content {', self.styles)

    def test_mobile_publish_source_stays_above_content_without_a_link_panel(self):
        responsive_start = self.styles.index("@media (max-width: 1180px)")
        responsive_styles = self.styles[responsive_start:]

        self.assertIn(
            ".publish-post-picker {\n"
            "    order: -1;",
            responsive_styles,
        )
        self.assertIn(
            ".console-page .publish-source-tabs {\n"
            "    width: 100%;\n"
            "    min-width: 0;",
            responsive_styles,
        )
        self.assertNotIn(".publish-content-preview .publish-link-settings", responsive_styles)
        self.assertNotIn("publish-mobile-custom-link-settings", responsive_styles)
        self.assertNotIn(
            ".module-panel.is-publishing-module:has(.publish-content-preview--selection)",
            responsive_styles,
        )
        self.assertNotIn(
            ".console-page .view:has(.publish-content-preview--selection)",
            responsive_styles,
        )

    def test_link_settings_support_real_enable_disable_and_keep_mobile_header_visible(self):
        self.assertIn('data-persona-activate-preset-id="${esc(presetId)}"', self.console_script)
        self.assertIn('isActive ? "关闭启用" : "启用"', self.console_script)
        self.assertNotIn("data-persona-view-preset", self.console_script)
        self.assertIn('modal?.addEventListener("click", (event) => {', self.console_script)
        self.assertIn('const activatePresetId = event.target.closest("[data-persona-activate-preset-id]");', self.console_script)
        self.assertLess(
            self.console_script.index('const activatePresetId = event.target.closest("[data-persona-activate-preset-id]");'),
            self.console_script.index('const selectPreset = event.target.closest("[data-persona-select-preset]");'),
        )
        self.assertIn('await savePersonaPresetList(nextPresets, isActive ? "" : String(preset.id));', self.console_script)
        self.assertIn("const activePreset = activePersonaLinkPreset(profile);", self.console_script)
        self.assertNotIn(
            "const activePreset = personaPresetById(profile, profile?.active_link_preset_id) || selectedPersonaPreset(profile);",
            self.console_script,
        )
        self.assertIn(
            ".console-modal-dialog.persona-link-settings-modal {\n  width: min(860px, calc(100vw - 32px));\n  grid-template-rows: auto auto minmax(0, 1fr);",
            self.styles,
        )
        self.assertIn("grid-template-areas:\n      \"index name status actions\"\n      \"content content content content\";", self.styles)
        self.assertIn(".persona-link-list-panel {\n    height: auto;\n    max-height: none;", self.styles)

    def test_mobile_task_dock_is_flush_with_the_viewport(self):
        self.assertIn('content="width=device-width, initial-scale=1.0, viewport-fit=cover"', self.markup)
        self.assertIn("right: 0;\n    bottom: 0;\n    left: 0;", self.styles)
        self.assertIn("border-width: 1px 0 0;", self.styles)

    def test_mobile_publish_history_is_compact(self):
        self.assertIn('class="publish-post-picker publish-history-picker"', self.console_script)
        self.assertIn(
            ".publish-history-preview .publish-history-metrics",
            self.styles,
        )
        self.assertIn("grid-template-columns: repeat(6, minmax(0, 1fr));", self.styles)
        self.assertIn('data-publish-history-view="${esc(recordId)}"', self.console_script)
        self.assertIn('data-publish-history-requeue="${esc(recordId)}"', self.console_script)
        self.assertIn("function openPublishHistoryRecordModal", self.console_script)
        self.assertIn('extraActions: [{ value: "requeue", text: "重入队" }]', self.console_script)
        self.assertIn(
            ".publish-history-preview {\n    display: none;",
            self.styles,
        )
        self.assertIn(".publish-history-card-actions {", self.styles)
        self.assertIn(".publish-history-card .publish-post-card-snippet", self.styles)
        self.assertIn("-webkit-line-clamp: 2;", self.styles)

    def test_refresh_actions_have_distinct_labels_and_behaviors(self):
        self.assertIn(">刷新显示</button>", self.markup)
        self.assertIn(">同步全部数据</button>", self.markup)
        self.assertIn(
            'personaDashboardRoot?.querySelector(`#${id}`) || document.getElementById(id)',
            self.dashboard_script,
        )
        self.assertIn(
            'refresh.addEventListener("click", () => pdLoadDashboard())',
            self.dashboard_script,
        )
        self.assertIn(
            'refreshAll.addEventListener("click", () => pdStartRefresh(""))',
            self.dashboard_script,
        )

    def test_dashboard_layout_uses_scoped_console_rules(self):
        required_rules = (
            ".persona-dashboard-topbar-actions",
            ".persona-dashboard-view #personaDashboardMsg:empty",
            ".persona-dashboard-view .persona-kpi-grid",
            ".persona-dashboard-view .persona-chart-panel",
            ".persona-dashboard-view .persona-workbench-panel",
        )
        for rule in required_rules:
            with self.subTest(rule=rule):
                self.assertIn(rule, self.styles)

    def test_console_opens_the_dashboard_by_default_and_keeps_mobile_summary_compact(self):
        self.assertIn(
            'view: initialConsoleViewIsSupported ? initialConsoleView : "persona_dashboard"',
            self.console_script,
        )
        self.assertIn("function clearInitialConsoleRouteHint()", self.console_script)
        self.assertIn('url.searchParams.delete("view");', self.console_script)
        self.assertIn('url.searchParams.delete("browser_panel");', self.console_script)
        self.assertIn("clearInitialConsoleRouteHint();", self.console_script)
        mobile_dashboard_styles = self.styles[
            self.styles.index("@media (max-width: 760px) {"):
            self.styles.index(".persona-dashboard-view .persona-tab-rail {", self.styles.index("@media (max-width: 760px) {"))
        ]
        self.assertIn("grid-template-columns: repeat(12, minmax(0, 1fr));", mobile_dashboard_styles)
        self.assertIn("min-height: 64px;", mobile_dashboard_styles)
        self.assertIn(".persona-dashboard-view .persona-kpi:nth-child(n + 5)", mobile_dashboard_styles)
        self.assertIn("grid-column: span 4;", mobile_dashboard_styles)
        self.assertIn(".persona-dashboard-view .persona-kpi:nth-child(-n + 4)", mobile_dashboard_styles)
        self.assertIn("grid-column: span 3;", mobile_dashboard_styles)
        self.assertIn("font-size: 18px;", mobile_dashboard_styles)
        self.assertIn("font-size: 11px;", mobile_dashboard_styles)
        summary_start = self.dashboard_script.index("function pdRenderSummary(data, visiblePersonas)")
        summary_end = self.dashboard_script.index("\nfunction pdPersonaWarnings", summary_start)
        summary = self.dashboard_script[summary_start:summary_end]
        self.assertNotIn(".filter((card) => Number(card.value || 0) > 0)", summary)

    def test_dashboard_charts_reuse_the_console_accent(self):
        self.assertIn('const colors = ["var(--accent)"', self.dashboard_script)
        self.assertIn('color: "var(--accent)"', self.dashboard_script)
        self.assertIn(
            ".persona-dashboard-view .persona-bar-fill",
            self.styles,
        )

    def test_dashboard_uses_compact_persona_tabs_and_chart_placeholders_for_empty_data(self):
        mobile_dashboard_styles = self.styles[
            self.styles.index("@media (max-width: 760px) {"):
            self.styles.index(".persona-dashboard-view .persona-chart-grid {", self.styles.index("@media (max-width: 760px) {"))
        ]
        self.assertIn("width: 116px;", mobile_dashboard_styles)
        self.assertIn("min-width: 116px;", mobile_dashboard_styles)
        self.assertIn("min-height: 38px;", mobile_dashboard_styles)
        self.assertIn("function pdRenderChartPlaceholder(kind", self.dashboard_script)
        self.assertIn('pdRenderChartPlaceholder("bars", "暂无热度数据")', self.dashboard_script)
        self.assertIn('pdRenderChartPlaceholder("donut", "暂无分布数据")', self.dashboard_script)
        self.assertIn('pdRenderChartPlaceholder("line", "暂无走势数据")', self.dashboard_script)
        self.assertIn(".persona-dashboard-view .persona-chart-placeholder", self.styles)
        self.assertIn(".persona-chart-placeholder--donut", self.styles)
        self.assertIn(".persona-chart-placeholder--line", self.styles)

    def test_unbound_persona_account_badge_uses_the_compact_account_label(self):
        details_start = self.console_script.index("function personaExecutionAccountDetails(persona)")
        details_end = self.console_script.index("\nfunction personaExecutionAccountLabel", details_start)
        details = self.console_script[details_start:details_end]
        self.assertIn('const platform = String(account?.platform || (handle ? "threads" : "")).trim().toLowerCase();', details)
        self.assertIn('platformLabel: platform ? platformLabel(platform) : "",', details)

        start = self.console_script.index("function renderPersonaExecutionAccountBadge(persona)")
        end = self.console_script.index("\nfunction personaSummaryCounts", start)
        badge = self.console_script[start:end]

        self.assertIn("personaExecutionAccountDetails(persona)", badge)
        self.assertIn("personaAccounts(persona)", badge)
        self.assertIn("persona-execution-platform-logos", badge)
        self.assertIn('persona-execution-platform-logo${isCurrent ? " is-current" : ""}', badge)
        self.assertIn('账号：${esc(accountLabel)}', badge)
        self.assertIn('const accountSyncPending = !state.socialDataLoadedAt && !hasExecutionAccount;', badge)
        self.assertIn('accountSyncPending ? "账号同步中"', badge)
        self.assertIn('accountSyncPending ? "is-loading" : "is-warning"', badge)
        self.assertIn('.persona-status-chip.is-loading {', self.styles)

        active_logo_start = self.styles.index(".persona-execution-platform-logo.is-current")
        active_logo_end = self.styles.index(".persona-execution-platform-logo svg", active_logo_start)
        active_logo = self.styles[active_logo_start:active_logo_end]
        self.assertIn("background: var(--brand-bg);", active_logo)
        self.assertIn("color: var(--panel-solid);", active_logo)

        mobile_identity_start = self.styles.rindex(".persona-profile-data-panel-head--identity {")
        mobile_identity_end = self.styles.index(".persona-profile-list-toggle {", mobile_identity_start)
        mobile_identity = self.styles[mobile_identity_start:mobile_identity_end]
        self.assertIn("grid-template-columns: 88px minmax(0, 1fr) 36px;", mobile_identity)
        self.assertIn(".persona-profile-data-panel-head--identity > strong", mobile_identity)
        self.assertIn("justify-self: center;", mobile_identity)

    def test_draft_source_controls_are_wide_without_quick_select(self):
        self.assertNotIn("草稿快速选择", self.console_script)
        self.assertNotIn("收藏快速选择", self.console_script)
        self.assertIn(".persona-source-toggle {\n  width: min(100%, 280px);", self.styles)

    def test_favorite_copy_keeps_its_stored_numeric_title(self):
        title_helper = self.console_script[
            self.console_script.index("function personaDraftDisplayTitle"):
            self.console_script.index("function personaDraftDisplayTitleForPost")
        ]
        self.assertIn("post?.source_post_id", title_helper)
        self.assertIn("sourceMeta.favoriteSourcePostId", title_helper)
        self.assertIn("/^第\\d+篇$/.test(title) && !isFavoriteCopy", title_helper)

    def test_content_tabs_keep_generate_drafts_and_favorites_in_one_pill_switcher(self):
        tabs = self.console_script[
            self.console_script.index("function renderPersonaStepTabs"):
            self.console_script.index("function renderPersonaPostsViewTabs")
        ]
        posts_panel = self.console_script[
            self.console_script.index('if (panel === "posts")'):
            self.console_script.index('if (panel === "history")')
        ]
        self.assertIn('class="persona-content-tabs persona-publish-content-tabs account-browser-tabs"', tabs)
        self.assertIn('["generate", "新建推文"]', tabs)
        self.assertIn('["posts", "草稿库"]', tabs)
        self.assertIn('["favorites", "收藏"]', tabs)
        self.assertIn('data-persona-content-tab=', tabs)
        self.assertIn('classList.toggle("persona-detail--content", groupKey === "content")', self.console_script)
        self.assertNotIn('persona-source-toggle', posts_panel)
        self.assertNotIn('data-persona-open-new-draft', posts_panel)
        self.assertNotIn('data-persona-edit-post=', posts_panel)
        self.assertNotIn('data-persona-open-publishing', posts_panel)
        self.assertIn('${renderPersonaPostBulkActions(persona, postSource, sourceRows)}', posts_panel)
        self.assertNotIn('sourceRows.length ? renderPersonaPostBulkActions', posts_panel)
        self.assertIn('const contentTabButton = event.target.closest("[data-persona-content-tab]");', self.console_script)
        self.assertIn('.persona-content-tabs {\n  width: min(100%, 420px);', self.styles)
        self.assertIn(".persona-content-tabs button {\n  min-height: 34px;\n  padding: 0 18px;", self.styles)
        self.assertIn("position: sticky;", self.styles)
        self.assertIn('.persona-content-tabs.account-browser-tabs button {\n  font-weight: inherit;', self.styles)
        self.assertIn('.console-page .persona-content-tabs {\n    grid-template-columns: repeat(3, minmax(0, 1fr));', self.styles)
        self.assertIn('.console-page .persona-detail.persona-detail--content {', self.styles)

    def test_tweet_generation_reuses_platform_cards_and_filters_archives_by_platform(self):
        platform_helpers = self.console_script[
            self.console_script.index("function personaContentPlatform"):
            self.console_script.index("function personaDraftPosts")
        ]
        content_panel = self.console_script[
            self.console_script.index("function renderPersonaContentPanel"):
            self.console_script.index("function refreshLiveBrowserSessionsSoon")
        ]
        payload = self.console_script[
            self.console_script.index("function generatePersonaPayloadFromState"):
            self.console_script.index("function personaGenerateRunState")
        ]
        create_post = self.console_script[
            self.console_script.index("async function createPersonaDraftPost"):
            self.console_script.index("async function stashPersonaDraftEdit")
        ]

        self.assertIn("state.personaContentPlatforms", platform_helpers)
        self.assertIn('return "threads";', platform_helpers)
        self.assertIn("personaPostMatchesContentPlatform", platform_helpers)
        self.assertIn("function renderPersonaContentPlatformRail", self.console_script)
        self.assertIn("account-pool-platforms account-pool-platform-tabs persona-content-platform-tabs", self.console_script)
        self.assertIn("renderAccountPoolPlatformIcon(value)", self.console_script)
        self.assertGreaterEqual(content_panel.count("renderPersonaContentPlatformRail"), 2)
        self.assertIn("platform: personaContentPlatform(persona)", payload)
        self.assertIn("platform: personaContentPlatform(persona)", create_post)
        self.assertIn(".persona-content-platform-tabs {", self.styles)
        self.assertIn("overflow-x: auto;", self.styles[self.styles.index(".persona-content-platform-tabs {"):])

    def test_persona_header_platform_logos_and_counts_share_content_platform_state(self):
        badge = self.console_script[
            self.console_script.index("function renderPersonaExecutionAccountBadge(persona)"):
            self.console_script.index("\nfunction personaSummaryCounts", self.console_script.index("function renderPersonaExecutionAccountBadge(persona)"))
        ]
        summary = self.console_script[
            self.console_script.index("function personaSummaryCounts(persona)"):
            self.console_script.index("\nfunction currentPersonaGroupStep", self.console_script.index("function personaSummaryCounts(persona)"))
        ]
        identity = self.console_script[
            self.console_script.index("function renderPersonaProfileIdentity"):
            self.console_script.index("\nfunction renderPersonaContentOverview", self.console_script.index("function renderPersonaProfileIdentity"))
        ]

        self.assertIn("personaContentPlatform(persona)", badge)
        self.assertIn("accountPoolPlatforms.map", badge)
        self.assertIn('data-persona-content-platform="${esc(item)}"', badge)
        self.assertIn('<span class="persona-execution-platform-logo', badge)
        self.assertNotIn('type="button"', badge)
        self.assertIn("allDrafts", summary)
        self.assertIn("allFavorites", summary)
        self.assertIn("totalDraftCount", summary)
        self.assertIn("totalFavoriteCount", summary)
        self.assertIn("selectedPlatformLabel", identity)
        self.assertIn("totalDraftCount", identity)
        self.assertIn("totalFavoriteCount", identity)
        self.assertEqual(identity.count("data-persona-platform-summary"), 2)
        self.assertEqual(identity.count("data-persona-total-drafts"), 2)
        self.assertEqual(identity.count("data-persona-total-favorites"), 2)
        summary_grid = self.styles[
            self.styles.index(".persona-profile-summary-grid {"):
            self.styles.index("}", self.styles.index(".persona-profile-summary-grid {"))
        ]
        self.assertIn(
            "grid-template-columns: minmax(0, .8fr) minmax(0, 1.35fr) repeat(2, minmax(0, .72fr));",
            summary_grid,
        )

    def test_generate_and_archive_panels_keep_platform_rail_at_the_same_vertical_offset(self):
        self.assertNotIn(
            ".persona-detail--content .persona-generate-panel {\n"
            "    gap: var(--mobile-module-gap);",
            self.styles,
        )

    def test_new_tweet_composer_and_platform_switch_have_mis_touch_guards(self):
        transient = self.console_script[
            self.console_script.index("function activePersonaDraftComposerTransientState"):
            self.console_script.index("function activeTransientWorkspaceState")
        ]
        handler_start = self.console_script.index('const contentPlatformButton = event.target.closest("[data-persona-content-platform]");')
        handler = self.console_script[
            handler_start:
            self.console_script.index('const contentTabButton = event.target.closest("[data-persona-content-tab]");', handler_start)
        ]

        self.assertIn("personaDraftTitle", transient)
        self.assertIn("personaDraftContent", transient)
        self.assertIn("personaPostMediaUploadFiles", transient)
        self.assertIn('kind: "persona_draft_composer"', transient)
        self.assertIn("confirmPersonaContentPlatformSwitch", handler)
        self.assertIn("resetPersonaNewDraftComposer", handler)
        self.assertIn("setPersonaContentPlatform", handler)
        self.assertIn('state.activeModule === "publishing"', handler)
        self.assertIn('renderSimpleFlowModule("publishing")', handler)
        publish_selection = self.console_script[
            self.console_script.index("function publishSelectionKey("):
            self.console_script.index("\nfunction publishSourceRows", self.console_script.index("function publishSelectionKey("))
        ]
        self.assertIn("personaContentPlatform(persona)", publish_selection)
        self.assertIn("activePersonaDraftComposerTransientState", self.console_script)
        self.assertIn('window.addEventListener("beforeunload"', self.console_script)
        self.assertIn('gap: var(--mobile-control-gap);', self.styles)
        self.assertIn('min-height: var(--mobile-touch-target);', self.styles)

    def test_generated_titles_are_only_written_from_manual_input_without_numbering(self):
        generated_titles = self.console_script[
            self.console_script.index("async function applyPersonaGeneratedBatchTitles"):
            self.console_script.index("async function resolvePersonaOrdinaryGeneratedCandidates")
        ]
        self.assertIn("if (!rows.length || !title) return;", generated_titles)
        self.assertIn("applyPersonaGeneratedCandidateTitle(personaId, post, title)", generated_titles)
        self.assertNotIn("numberedTitle", generated_titles)

    def test_hidden_draft_menu_keeps_delete_actions_as_text(self):
        actions = self.console_script[
            self.console_script.index("function renderPersonaDraftPostActions"):
            self.console_script.index("function renderPersonaDraftTableRows")
        ]
        self.assertIn('data-persona-delete-favorite="${esc(post.id)}">移出收藏</button>', actions)
        self.assertIn('data-persona-delete-post="${esc(post.id)}">删除草稿</button>', actions)
        self.assertNotIn("unified-action-icon-button", actions)
        self.assertNotIn("renderTrashIcon()", actions)

    def test_open_draft_menu_stays_below_fixed_navigation(self):
        workbench_layer = self.styles[
            self.styles.index(".persona-workbench-shell.is-menu-open {"):
            self.styles.index("}", self.styles.index(".persona-workbench-shell.is-menu-open {")) + 1
        ]
        panel_layer = self.styles[
            self.styles.index(".persona-inline-panel.is-menu-open {"):
            self.styles.index("}", self.styles.index(".persona-inline-panel.is-menu-open {")) + 1
        ]
        self.assertIn("z-index: 40;", workbench_layer)
        self.assertIn("z-index: 40;", panel_layer)
        self.assertNotIn("z-index: 5400;", workbench_layer)
        self.assertNotIn("z-index: 5400;", panel_layer)

    def test_opening_draft_editor_clears_the_previous_menu_layer(self):
        editor = self.console_script[
            self.console_script.index("function openPersonaDraftEditor"):
            self.console_script.index("async function deletePersonaDraftPost")
        ]
        self.assertIn("closePersonaDraftMenus();", editor)
        self.assertLess(
            editor.index("closePersonaDraftMenus();"),
            editor.index("renderPersonaDetail();"),
        )

    def test_draft_editor_uses_icon_exit_and_expands_its_content(self):
        content_panel = self.console_script[
            self.console_script.index("function renderPersonaContentPanel"):
            self.console_script.index("function refreshLiveBrowserSessionsSoon")
        ]
        self.assertIn('class="unified-action-icon-button" data-persona-exit-draft-edit', content_panel)
        self.assertIn('${renderCloseIcon()}', content_panel)
        self.assertIn('class="persona-draft-content--full"', content_panel)
        self.assertIn("function resizePersonaDraftEditContent()", self.console_script)
        self.assertIn("window.requestAnimationFrame(resizePersonaDraftEditContent);", self.console_script)
        self.assertIn("resizePersonaDraftEditContent();", self.console_script)
        self.assertIn(".persona-draft-content--full {", self.styles)
        self.assertIn("overflow-y: hidden;", self.styles)

    def test_editing_draft_locks_incompatible_compose_modes_without_delete_action(self):
        compose_tabs = self.console_script[
            self.console_script.index("function renderPersonaGenerateComposeTabs"):
            self.console_script.index("function renderPersonaMediaOperationTabs")
        ]
        content_panel = self.console_script[
            self.console_script.index("function renderPersonaContentPanel"):
            self.console_script.index("function refreshLiveBrowserSessionsSoon")
        ]
        compose_handler = self.console_script[
            self.console_script.index('const composeModeButton = event.target.closest("[data-persona-compose-mode]");'):
            self.console_script.index("const openImageSettingsButton", self.console_script.index('const composeModeButton = event.target.closest("[data-persona-compose-mode]");'))
        ]
        self.assertIn(
            "function renderPersonaGenerateComposeTabs(mode, { editingDraft = false, disabled = false } = {})",
            compose_tabs,
        )
        self.assertIn(
            'const locked = disabled || (editingDraft && value !== "tweet");',
            compose_tabs,
        )
        self.assertIn('disabled title="${esc(lockReason)}"', compose_tabs)
        self.assertIn("renderPersonaGenerateComposeTabs(composeMode, {", content_panel)
        self.assertIn("editingDraft: isEditingDraft,", content_panel)
        self.assertIn("disabled: generationLocked,", content_panel)
        self.assertIn("persona-compose-lock-hint", content_panel)
        self.assertNotIn('data-persona-delete-post="${esc(draftForm.editingPostId)}"', content_panel)
        self.assertIn('if (editingPostId) {', compose_handler)
        self.assertIn('form.generate.mode = "custom";', compose_handler)
        self.assertIn('if (nextComposeMode !== "tweet")', compose_handler)
        self.assertLess(
            compose_handler.index('if (editingPostId) {'),
            compose_handler.index('event.__vectoSegmentSlideHandled = true;'),
        )
        self.assertIn(".persona-compose-toggle button:disabled", self.styles)
        self.assertIn(".persona-compose-lock-hint {", self.styles)

    def test_draft_toolbar_uses_icon_bulk_actions_and_aligned_controls(self):
        bulk_actions = self.console_script[
            self.console_script.index("function renderPersonaPostBulkActions"):
            self.console_script.index("async function viewPersonaDraftPost")
        ]
        self.assertIn('title="全选" aria-label="全选"', bulk_actions)
        self.assertIn('data-persona-post-bulk="all"', bulk_actions)
        self.assertIn('aria-label="全选" ${rows.length ? "" : "disabled"}', bulk_actions)
        self.assertIn("${renderSelectAllIcon()}", bulk_actions)
        self.assertIn("${renderClearSelectionIcon()}", bulk_actions)
        self.assertIn('title="清空选择" aria-label="清空选择"', bulk_actions)
        self.assertIn('aria-label="清空选择" ${selectedCount ? "" : "disabled"}', bulk_actions)
        self.assertIn("${renderTrashIcon()}", bulk_actions)
        self.assertNotIn(">全选</button>", bulk_actions)
        self.assertNotIn(">清空</button>", bulk_actions)
        self.assertIn('data-persona-post-bulk="execute"', self.console_script)
        self.assertIn('setPublishSelectedPostIds(persona, source, selectedIds);', self.console_script)
        self.assertIn('setWorkspaceModule("publishing");', self.console_script)
        self.assertIn('if (postBulkButton.disabled || postBulkButton.getAttribute("aria-disabled") === "true") return;', self.console_script)
        self.assertIn(".persona-draft-toolbar--posts {", self.styles)
        self.assertIn("position: sticky;", self.styles)
        self.assertIn("grid-template-columns: minmax(0, 1fr) auto;", self.styles)
        self.assertIn(".persona-post-bulk-actions .persona-post-bulk-icon-button {", self.styles)
        self.assertIn('.persona-post-bulk-actions .persona-post-bulk-icon-button > :is(.ui-action-icon, .ui-trash-icon) {', self.styles)
        self.assertIn("${renderSelectAllIcon()}", self.console_script)
        self.assertIn("${renderClearSelectionIcon()}", self.console_script)
        self.assertIn('.persona-post-bulk-actions [data-persona-post-bulk="delete"] {', self.styles)
        self.assertIn(".persona-post-bulk-execute {", self.styles)

    def test_publish_task_source_tabs_put_drafts_first_without_duplicate_source_label(self):
        source_tabs = self.console_script[
            self.console_script.index("function renderPublishContentSourceTabs"):
            self.console_script.index("function renderPublishSourceActions")
        ]
        source_panel = self.console_script[
            self.console_script.index("function renderPublishContentPanel"):
            self.console_script.index("function renderPublishMobileSelectionStrip")
        ]

        self.assertLess(source_tabs.index('["posts", "草稿"]'), source_tabs.index('["favorites", "收藏"]'))
        self.assertLess(source_tabs.index('["favorites", "收藏"]'), source_tabs.index('["custom", "自定义"]'))
        self.assertNotIn('<span>${esc(publishContentSourceLabel(source))}</span>', source_panel)
        self.assertIn("bulk-selection-icon-button", self.console_script)
        self.assertIn('class="publish-post-picker publish-post-picker--${esc(source)}"', source_panel)
        self.assertIn(".publish-post-picker--custom {\n  grid-template-rows: auto auto;", self.styles)

    def test_mobile_hidden_publish_preview_does_not_leave_a_source_gap(self):
        preview = self.console_script[
            self.console_script.index("function renderPublishContentPreview"):
            self.console_script.index("function renderPublishContentPanel")
        ]

        self.assertIn(
            'class="publish-content-preview publish-content-preview--selection ${selectedPosts.length ? "" : "is-empty"}"',
            preview,
        )
        self.assertIn(
            ".publish-content-preview--selection {\n    display: none;",
            self.styles,
        )

    def test_persona_publish_entry_tabs_are_square_white_buttons(self):
        render_start = self.console_script.index("function renderPersonaStepTabs(groupKey, profile)")
        render_end = self.console_script.index("\nfunction renderPersonaPostsViewTabs", render_start)
        renderer = self.console_script[render_start:render_end]

        self.assertIn("persona-publish-content-tabs", renderer)
        self.assertIn("grid-template-columns: repeat(3, minmax(0, 1fr));", self.styles)
        self.assertIn(".persona-content-tabs.persona-publish-content-tabs button", self.styles)
        self.assertIn("border-radius: 6px;", self.styles)
        self.assertIn("border: 1px solid var(--line);", self.styles)
        self.assertIn("background: var(--panel-solid);", self.styles)
        self.assertIn("background: #071112;", self.styles)
        self.assertIn(
            ".persona-detail .persona-content-tabs.persona-publish-content-tabs button[type=\"button\"]",
            self.styles,
        )

    def test_segmented_controls_use_a_simple_sliding_background_without_click_highlight(self):
        interaction_start = self.styles.index("/* Segmented controls keep their existing state behavior")
        interaction = self.styles[interaction_start:]
        slider = self.console_script[
            self.console_script.index("async function slideSegmentedButtonBackground"):
            self.console_script.index("\nfunction bindEvents()")
        ]

        self.assertIn(".automation-capsule-tabs,", interaction)
        self.assertIn(".persona-content-tabs,", interaction)
        self.assertIn(".persona-media-operation-toggle,", interaction)
        self.assertIn("-webkit-tap-highlight-color: transparent !important;", interaction)
        self.assertIn("> button:focus:not(:focus-visible)", interaction)
        self.assertIn(".is-segment-background-sliding::before", interaction)
        self.assertIn(
            "> button:is(.is-active, .is-segment-slide-to)",
            interaction,
        )
        self.assertIn("transform: translate3d(var(--segment-slide-x), var(--segment-slide-y), 0);", interaction)
        self.assertIn("transform 180ms cubic-bezier(.2, .72, .2, 1)", interaction)
        self.assertIn("async function slideSegmentedButtonBackground(button, options = {})", slider)
        self.assertIn("itemRect.left - groupRect.left - group.clientLeft", slider)
        self.assertIn("itemRect.top - groupRect.top - group.clientTop", slider)
        self.assertIn("window.setTimeout(() => requestAnimationFrame(resolve), 180);", slider)
        self.assertIn("requestAnimationFrame(() => {", slider)
        self.assertIn("pointer-events: none;", interaction)
        self.assertIn('const SEGMENTED_BACKGROUND_BUTTON_SELECTOR = [', self.console_script)
        self.assertIn('".persona-content-tabs > button"', self.console_script)
        self.assertIn('".persona-compose-toggle > button"', self.console_script)
        self.assertIn('".persona-media-operation-toggle > button"', self.console_script)
        self.assertIn('".automation-capsule-tabs > button"', self.console_script)
        self.assertIn('".mobile-task-dock > button"', self.console_script)
        self.assertNotIn('".publish-preview-tabs > button"', self.console_script)
        self.assertNotIn('".persona-dashboard-picker-tabs > button"', self.console_script)
        self.assertNotIn('".persona-dashboard-platform-tabs > button"', self.console_script)
        self.assertNotIn('".persona-group-tabs > button"', self.console_script)
        self.assertNotIn('".persona-step-tabs > button"', self.console_script)

        self.assertIn(
            "button:focus-visible {\n  outline: 2px solid var(--ink);",
            self.styles,
        )
        self.assertIn(
            "):hover:not(:disabled) {\n"
            "  color: var(--vecto-action-ink);\n"
            "  border-color: var(--vecto-action-border);\n"
            "  box-shadow: none;",
            self.styles,
        )
        self.assertNotIn(
            ".account-pool-add-button:is(:hover, :focus, :active, .is-modal-open)",
            self.styles,
        )
        self.assertIn(
            ".account-pool-add-button:is(:hover, :focus-visible, :active, .is-modal-open)",
            self.styles,
        )
        self.assertNotIn('".persona-subflow-tabs > button"', self.console_script)
        self.assertNotIn('".automation-tab-strip > button"', self.console_script)
        self.assertNotIn('".automation-account-tabs > button"', self.console_script)
        self.assertNotIn('".account-pool-platforms > button"', self.console_script)
        self.assertNotIn('".persona-account-platform-tabs > button"', self.console_script)
        self.assertIn("!button.matches?.(SEGMENTED_BACKGROUND_BUTTON_SELECTOR)", slider)
        self.assertIn('const positionGroup = getComputedStyle(group).position === "static";', slider)
        self.assertIn('group.classList.add("is-segment-slide-positioned")', slider)
        self.assertIn(".is-segment-slide-positioned {", interaction)
        self.assertNotIn(
            ".is-segment-background-sliding {\n  position: relative;",
            interaction,
        )
        self.assertIn('button.classList.contains("is-pending")', slider)
        self.assertIn('group.style.setProperty("--segment-slide-background", slideStyle.background);', slider)
        self.assertNotIn("activeStyle.backgroundColor", slider)
        self.assertNotIn(
            "if (segmentedButton) await waitForSegmentedBackgroundSlide(event, segmentedButton);",
            self.console_script,
        )
        self.assertNotIn("await waitForSegmentedBackgroundSlide(", self.console_script)
        self.assertNotIn("commitSegmentedBackgroundChange", self.console_script)
        self.assertNotIn("animation:", interaction)
        self.assertNotIn("left 180ms cubic-bezier(.2, .72, .2, 1)", interaction)
        self.assertNotIn("scale(", slider)

    def test_segmented_page_switches_commit_content_when_the_slide_starts(self):
        module_handler = self.console_script[
            self.console_script.index('$("moduleBody").addEventListener("click"'):
            self.console_script.index('\n  $("moduleBody").addEventListener("change"')
        ]
        settings_handler = self.console_script[
            self.console_script.index('$("consoleSettingsBody").addEventListener("click"'):
            self.console_script.index('\n  $("consoleSettingsBody").addEventListener("input"')
        ]
        automation_handler = self.console_script[
            self.console_script.index('if (moduleId === "automation") {'):
            self.console_script.index('\n  document.querySelectorAll("[data-matrix-persona]")')
        ]

        self.assertNotIn("await waitForSegmentedBackgroundSlide", module_handler)
        self.assertNotIn("await waitForSegmentedBackgroundSlide", settings_handler)
        self.assertNotIn("await waitForSegmentedBackgroundSlide", automation_handler)
        for selector in (
            "[data-persona-content-tab]",
            "[data-persona-compose-mode]",
            "[data-persona-media-operation]",
            "[data-persona-draft-view]",
        ):
            self.assertIn(selector, module_handler)
        self.assertGreaterEqual(module_handler.count("await slideSegmentedButtonBackground("), 4)
        self.assertGreaterEqual(settings_handler.count("await slideSegmentedButtonBackground("), 2)
        self.assertGreaterEqual(automation_handler.count("await slideSegmentedButtonBackground("), 2)
        self.assertGreaterEqual(module_handler.count("event.__vectoSegmentSlideHandled = true;"), 4)
        self.assertGreaterEqual(settings_handler.count("event.__vectoSegmentSlideHandled = true;"), 2)
        self.assertGreaterEqual(automation_handler.count("event.__vectoSegmentSlideHandled = true;"), 2)
        self.assertIn("commit: () => {", module_handler)
        self.assertIn("resolveButton: () =>", module_handler)

    def test_publish_segmented_tabs_commit_content_when_the_slide_starts(self):
        mode_handler = self.console_script[
            self.console_script.index('document.querySelectorAll("[data-simple-publish-mode]")'):
            self.console_script.index('document.querySelectorAll("[data-automation-plan-mode]")')
        ]
        source_handler = self.console_script[
            self.console_script.index('document.querySelectorAll("[data-publish-content-source]")'):
            self.console_script.index('document.querySelectorAll("[data-publish-source-select]")')
        ]
        handlers = mode_handler + source_handler

        self.assertEqual(handlers.count("await slideSegmentedButtonBackground(node, {"), 2)
        self.assertIn("state.simpleBranches.publishing = nextMode;", handlers)
        self.assertIn("state.publishContentSource = nextSource;", handlers)
        self.assertEqual(handlers.count('renderSimpleFlowModule("publishing");'), 2)
        self.assertIn("resolveButton: () => document.querySelector(", handlers)
        self.assertEqual(handlers.count("&& activeTransientWorkspaceState()"), 2)
        self.assertNotIn("await slideSegmentedButtonBackground(node);\n", handlers)
        self.assertLess(
            self.console_script.index("commit();", self.console_script.index("async function slideSegmentedButtonBackground")),
            self.console_script.index('group.classList.add("is-segment-background-sliding")', self.console_script.index("async function slideSegmentedButtonBackground")),
        )

    def test_child_pages_and_public_modals_reuse_the_task_segment_slide(self):
        publish_picker = self.console_script[
            self.console_script.index("async function choosePublishPlatformAccount"):
            self.console_script.index("\nfunction publishPlatformLabel")
        ]
        automation_modal = self.console_script[
            self.console_script.index("function openAutomationPlanTaskConfigurator"):
            self.console_script.index("\nfunction openAutomationPlanTaskDetails")
        ]
        automation_mode = self.console_script[
            self.console_script.index('document.querySelectorAll("[data-automation-plan-mode]")'):
            self.console_script.index('document.querySelectorAll("[data-automation-plan-time]")')
        ]
        queue_panel = self.console_script[
            self.console_script.index('const taskQueuePanelButton = event.target.closest("[data-task-queue-panel]")'):
            self.console_script.index('const taskQueuePageButton = event.target.closest("[data-task-queue-page]")')
        ]

        self.assertIn('tab.addEventListener("click", async (event) => {', publish_picker)
        self.assertIn("await slideSegmentedButtonBackground(tab, {", publish_picker)
        self.assertIn("resolveButton: () => modal?.querySelector(", publish_picker)
        self.assertIn("const onAutomationTaskConfigure = async (event) => {", automation_modal)
        self.assertIn("await slideSegmentedButtonBackground(stepButton, {", automation_modal)
        self.assertIn("resolveButton: () => modal?.querySelector(", automation_modal)
        self.assertIn('node.addEventListener("click", async (event) => {', automation_mode)
        self.assertIn("await slideSegmentedButtonBackground(node, {", automation_mode)
        self.assertIn("resolveButton: () => document.querySelector(", automation_mode)
        self.assertIn("await slideSegmentedButtonBackground(taskQueuePanelButton, {", queue_panel)
        self.assertIn("resolveButton: () => document.querySelector(", queue_panel)

    def test_account_pool_and_proxy_tabs_reuse_the_task_segment_slide(self):
        handler_start = self.console_script.index('const tab = event.target.closest("[data-account-browser-tab]")')
        account_browser_handler = self.console_script[
            handler_start:
            self.console_script.index('const accountPasswordToggle = event.target.closest("[data-account-password-toggle]")', handler_start)
        ]

        self.assertIn('".account-browser-tabs > button"', self.console_script)
        self.assertIn("event.__vectoSegmentSlideHandled = true;", account_browser_handler)
        self.assertIn("await slideSegmentedButtonBackground(tab, {", account_browser_handler)
        self.assertIn("commit: () => setAccountBrowserPanel(nextPanel)", account_browser_handler)
        self.assertIn("resolveButton: () => document.querySelector(", account_browser_handler)

    def test_mobile_task_dock_reuses_fixed_size_segment_slide_without_delaying_navigation(self):
        renderer = self.console_script[
            self.console_script.index("function renderMobileTaskDock()"):
            self.console_script.index("\nfunction isCurrentMobileTaskDockTarget")
        ]
        navigation = self.console_script[
            self.console_script.index("const handleWorkspaceModuleNavigation"):
            self.console_script.index('\n  $("moduleMenu").addEventListener', self.console_script.index("const handleWorkspaceModuleNavigation"))
        ]
        dock_styles = self.styles[
            self.styles.index("  .mobile-task-dock {\n    position: fixed;"):
            self.styles.index("\n  .publish-header-row", self.styles.index("  .mobile-task-dock {\n    position: fixed;"))
        ]
        self.assertIn('if (!dock.querySelector(".mobile-task-dock-button"))', renderer)
        self.assertIn("syncMobileTaskDockState(dock);", renderer)
        self.assertNotIn("--mobile-task-dock-offset", renderer)
        self.assertNotIn(".mobile-task-dock::before", dock_styles)
        self.assertEqual(navigation.count("commitMobileTaskDockNavigation(dockButton,"), 2)
        self.assertNotIn("await commitMobileTaskDockNavigation", navigation)
        self.assertIn(
            ".mobile-task-dock.is-segment-background-sliding::before {\n"
            "  will-change: transform;\n"
            "  transition: transform 180ms cubic-bezier(.2, .72, .2, 1);",
            self.styles,
        )
        self.assertIn("if (moduleChanged) setModule(nextModule);", navigation)
        self.assertIn("state.socialViewRefreshTarget === targetView", self.console_script)
        self.assertIn("cancelScheduledSocialViewRefresh();", self.console_script)
        account_refresh = self.console_script[
            self.console_script.index("async function refreshSocialAccountsOnly"):
            self.console_script.index("\nfunction updateAccountStatusViews")
        ]
        self.assertNotIn("state.socialDataLoadedAt = Date.now();", account_refresh)
        self.assertIn(
            'if (window.matchMedia("(max-width: 820px)").matches) renderSocialAccounts();',
            self.console_script,
        )

    def test_mobile_task_dock_reads_stable_live_geometry_instead_of_animation_cache(self):
        slider = self.console_script[
            self.console_script.index("async function slideSegmentedButtonBackground"):
            self.console_script.index("\nfunction bindEvents()")
        ]
        dock_state = self.console_script[
            self.console_script.index("function syncMobileTaskDockState"):
            self.console_script.index("\nfunction isCurrentMobileTaskDockTarget")
        ]

        self.assertNotIn("mobileTaskDockSlideMetrics", slider)
        self.assertNotIn("scheduleMobileTaskDockSlideMetrics", dock_state)
        self.assertIn("const groupRect = group.getBoundingClientRect();", slider)
        self.assertIn("const activeStyle = getComputedStyle(current);", slider)
        self.assertIn("const inactiveColor = getComputedStyle(button).color;", slider)

    def test_mobile_task_dock_defers_real_navigation_one_frame_without_removing_page_slide(self):
        helper = self.console_script[
            self.console_script.index("function mobileTaskDockNavigationDirection(button)"):
            self.console_script.index("\nfunction renderModuleMenu()", self.console_script.index("function mobileTaskDockNavigationDirection(button)"))
        ]

        self.assertIn("function animateMobileTaskDockPage(direction)", helper)
        self.assertIn('document.querySelector(".console-main > .view.is-active")', helper)
        self.assertIn("const animation = page?.animate ? page.animate(keyframes, timing) : null;", helper)
        self.assertEqual(helper.count("mobileTaskDockCommitFrame = window.requestAnimationFrame"), 1)
        self.assertIn("commit();", helper)
        self.assertLess(
            helper.index("slideSegmentedButtonBackground(button).catch(() => {});"),
            helper.index("mobileTaskDockCommitFrame = window.requestAnimationFrame"),
        )
        self.assertLess(
            helper.index("mobileTaskDockCommitFrame = window.requestAnimationFrame"),
            helper.index("commit();"),
        )
        self.assertLess(helper.index("commit();"), helper.index("animateMobileTaskDockPage(direction);"))
        self.assertNotIn("freezePage", helper)

    def test_mobile_task_dock_page_and_indicator_slide_start_in_the_same_commit(self):
        start = self.console_script.index("function mobileTaskDockNavigationDirection(button)")
        end = self.console_script.index("\nfunction renderModuleMenu()", start)
        helper = self.console_script[start:end]

        self.assertIn("function animateMobileTaskDockPage(direction)", helper)
        self.assertIn('window.matchMedia?.("(max-width: 820px)")?.matches', helper)
        self.assertIn('window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches', helper)
        self.assertIn(
            'document.querySelector(".console-main > .view.is-active")',
            helper,
        )
        self.assertNotIn('document.querySelector(".console-main")', helper)
        self.assertIn("mobileTaskDockPageAnimation?.cancel();", helper)
        self.assertIn("left: `${direction * distance}px`", helper)
        self.assertIn('left: "0px"', helper)
        page_keyframes = helper[
            helper.index("const keyframes = ["):
            helper.index("const publishActionKeyframes = [")
        ]
        self.assertNotIn("translate3d(", page_keyframes)
        self.assertIn("duration: 180", helper)
        self.assertIn('easing: "cubic-bezier(.2, .72, .2, 1)"', helper)
        self.assertIn(
            ".console-page .console-main {\n"
            "    overflow-x: clip;",
            self.styles,
        )
        self.assertIn(
            ".console-page .console-main > .view.is-active {\n"
            "    position: relative;",
            self.styles,
        )
        self.assertIn("function commitMobileTaskDockNavigation(button, commit)", helper)
        self.assertLess(
            helper.index("slideSegmentedButtonBackground(button).catch(() => {});"),
            helper.index("mobileTaskDockCommitFrame = window.requestAnimationFrame"),
        )
        self.assertLess(
            helper.index("mobileTaskDockCommitFrame = window.requestAnimationFrame"),
            helper.index("commit();"),
        )
        self.assertLess(helper.index("commit();"), helper.index("animateMobileTaskDockPage(direction);"))
        self.assertNotIn("await ", helper)

    def test_draft_detail_omits_content_type_but_keeps_detail_media(self):
        detail = self.console_script[
            self.console_script.index("async function viewPersonaDraftPost"):
            self.console_script.index("\nasync function refreshPersonaHotPost")
        ]
        self.assertNotIn("<span>内容类型</span>", detail)
        self.assertNotIn("renderMediaTypeBadge(mediaItems)", detail)
        self.assertIn("const mediaItems = personaDraftMediaItems", detail)
        self.assertIn("${renderPersonaDraftDetailMedia(mediaItems)}", detail)

    def test_draft_detail_reuses_hot_metrics_and_has_edit_close_actions(self):
        detail = self.console_script[
            self.console_script.index("async function viewPersonaDraftPost"):
            self.console_script.index("\nasync function refreshPersonaHotPost")
        ]
        self.assertIn("${renderPersonaHotMetricStrip(hotMeta)}", detail)
        self.assertIn('modalKey: "persona-draft-detail"', detail)
        self.assertIn('cancelText: "关闭"', detail)
        self.assertIn("if (shouldEdit) openPersonaDraftEditor(post.id);", detail)
        self.assertIn(
            '.console-modal[data-modal-key="persona-draft-detail"] .console-modal-actions {',
            self.styles,
        )
        self.assertIn(
            '.console-modal[data-modal-key="persona-draft-detail"] .console-modal-actions > [data-console-modal-confirm] {',
            self.styles,
        )

    def test_draft_more_menu_flips_above_the_mobile_dock(self):
        self.assertIn("function positionPersonaDraftMenu(menu)", self.console_script)
        self.assertIn('document.querySelector(".mobile-task-dock")', self.console_script)
        self.assertIn('menu.classList.toggle("opens-upward"', self.console_script)
        self.assertIn(".persona-draft-more.opens-upward .persona-draft-more-menu {", self.styles)
        self.assertIn("bottom: calc(100% + 6px);", self.styles)

    def test_hot_card_metrics_use_compact_thousands(self):
        self.assertIn("function hotMetricText(value)", self.console_script)
        self.assertIn("${esc(hotMetricText(value))}", self.console_script)

    def test_shared_navigation_isolated_from_legacy_brand_styles(self):
        header_rule = re.search(
            r"\.site-header\s*\{(?P<body>.*?)\}",
            self.navigation_styles,
            re.DOTALL,
        )
        self.assertIsNotNone(header_rule)
        self.assertIn("font-size: 16px;", header_rule.group("body"))
        self.assertIn("line-height: normal;", header_rule.group("body"))

        brand_rule = re.search(
            r"\.site-header \.brand\s*\{(?P<body>.*?)\}",
            self.navigation_styles,
            re.DOTALL,
        )
        self.assertIsNotNone(brand_rule)
        for declaration in (
            "padding: 0;",
            "background: transparent;",
            "border: 0;",
            "border-radius: 0;",
            "box-shadow: none;",
        ):
            with self.subTest(declaration=declaration):
                self.assertIn(declaration, brand_rule.group("body"))

        for page in ("index.html", "console.html", "pricing.html"):
            markup = (STATIC_ROOT / page).read_text(encoding="utf-8")
            with self.subTest(page=page):
                self.assertIn(
                    "/assets/opc/site-navigation.css?v=__SITE_NAVIGATION_CSS_VERSION__",
                    markup,
                )

    def test_shared_svg_icons_keep_their_visual_center(self):
        self.assertIn(
            ".ui-action-icon,\n.ui-trash-icon,\n.ui-eye-icon,\n.ui-form-list-icon,\n.ui-expand-icon,",
            self.styles,
        )
        for declaration in ("display: block;", "flex: 0 0 auto;", "margin: 0;"):
            with self.subTest(declaration=declaration):
                self.assertIn(declaration, self.styles)
                self.assertIn(declaration, self.navigation_styles)
        self.assertIn('<path d="M6 6l1 14h10l1-14"></path>', self.console_script)
        self.assertNotIn('<path d="M6 6l1 15h10l1-15"></path>', self.console_script)
        self.assertIn(
            ".persona-memory-actions > button,\n"
            "  .persona-hot-media-action",
            self.styles,
        )
        self.assertIn("place-items: center;\n  padding: 0;\n  line-height: 0;", self.styles)

    def test_editor_and_persona_menu_deletes_use_red_text_actions(self):
        self.assertIn(
            'class="persona-menu-tab persona-menu-tab--action persona-menu-tab--danger" data-persona-delete',
            self.console_script,
        )
        self.assertIn(
            'data-persona-delete-group="${esc(group.id)}"><span class="persona-menu-icon" aria-hidden="true">${renderTrashIcon()}</span><span>删除</span></button>',
            self.console_script,
        )
        for action in (
            'data-persona-delete-memory="${esc(row.id)}">删除</button>',
            'data-persona-delete-preset-id="${esc(presetId)}">删除</button>',
            'data-persona-delete-image="${esc(item.id)}" ${!item.id ? "disabled" : ""}>删除</button>',
            'data-persona-account-delete="${esc(accountId)}">删除</button>',
            'data-social-delete-account="${esc(accountId)}">删除</button>',
            'data-proxy-delete="${esc(proxy.id)}"',
        ):
            with self.subTest(action=action):
                self.assertIn(action, self.console_script)
        self.assertIn('${isMarketplace ? renderProxyReleaseIcon() : renderTrashIcon()}</button>', self.console_script)
        self.assertNotIn("account-pool-delete-icon", self.console_script)
        self.assertIn(".persona-link-actions button.danger,", self.styles)
        self.assertIn(".proxy-card-actions button.danger {", self.styles)

    def test_proxy_pool_uses_desktop_field_list_and_mobile_summary_cards(self):
        proxy_pool = self.console_script[
            self.console_script.index("function renderProxyPool()"):
            self.console_script.index("\nfunction proxyMarketCatalogRoot", self.console_script.index("function renderProxyPool()"))
        ]
        detail_modal = self.console_script[
            self.console_script.index("function openProxyDetailModal("):
            self.console_script.index("\nfunction renderProxyPool()", self.console_script.index("function openProxyDetailModal("))
        ]
        event_handler = self.console_script[
            self.console_script.index('const proxyView = event.target.closest("[data-proxy-view]")'):
            self.console_script.index('const proxyPage = event.target.closest("[data-proxy-page]")')
        ]

        self.assertIn('class="proxy-card-grid" data-proxy-mobile-cards role="list"', proxy_pool)
        self.assertIn('class="proxy-pool-card ', proxy_pool)
        self.assertIn('class="proxy-table-wrap" data-proxy-desktop-list', proxy_pool)
        self.assertIn('class="proxy-table" role="table"', proxy_pool)
        self.assertIn(
            'const columns = ["序号", "分组", "IP 类型", "来源", "购买状态", "节点名称", "代理资讯", "备注", "代理状态", "出口归属", "出口 IP", "已绑账号", "代理协议", "系统有效性", "操作"];',
            proxy_pool,
        )
        self.assertIn('class="proxy-table-row proxy-table-row--head"', proxy_pool)
        desktop_list = proxy_pool[
            proxy_pool.index('class="proxy-table-wrap" data-proxy-desktop-list'):
            proxy_pool.index('class="proxy-card-grid" data-proxy-mobile-cards')
        ]
        mobile_actions = proxy_pool[
            proxy_pool.index("const renderProxyMobileActions"):
            proxy_pool.index("root.innerHTML = `")
        ]
        mobile_cards = proxy_pool[proxy_pool.index('class="proxy-card-grid" data-proxy-mobile-cards'):]
        self.assertNotIn('data-proxy-view=', desktop_list)
        self.assertIn('${renderNetworkIcon()}</button>', desktop_list)
        self.assertIn('商城代理不可编辑', desktop_list)
        self.assertIn('${isMarketplace ? renderProxyReleaseIcon() : renderTrashIcon()}</button>', desktop_list)
        self.assertNotIn('${renderRefreshIcon()}</button>', desktop_list)
        self.assertNotIn('${isMarketplace ? "释放" : "删除"}', desktop_list)
        self.assertIn('data-proxy-view="${esc(proxy.id)}"', mobile_actions)
        self.assertIn('${renderEyeIcon()}</button>', mobile_actions)
        self.assertIn('${renderNetworkIcon()}</button>', mobile_actions)
        self.assertIn('${renderEditIcon()}</button>', mobile_actions)
        self.assertIn('${isMarketplace ? renderProxyReleaseIcon() : renderTrashIcon()}</button>', mobile_actions)
        self.assertIn('${renderProxyMobileActions(proxy)}', mobile_cards)

        self.assertIn('modalKey: "proxy-details"', detail_modal)
        self.assertIn('class="console-modal-detail proxy-detail-modal"', detail_modal)
        self.assertIn('showConfirm: false', detail_modal)
        self.assertIn('openProxyDetailModal(proxyView.dataset.proxyView || "")', event_handler)
        self.assertLess(
            event_handler.index('const proxyView = event.target.closest("[data-proxy-view]")'),
            event_handler.index('const proxyCheck = event.target.closest("[data-proxy-check]")'),
        )

        self.assertIn(".proxy-card-grid {", self.styles)
        self.assertIn(".proxy-pool-card {", self.styles)
        self.assertIn("max-width: 420px;", self.styles)
        self.assertIn(".proxy-table-wrap {", self.styles)
        self.assertIn(".proxy-table-row {", self.styles)
        self.assertIn("108px 104px;", self.styles)
        self.assertIn(".proxy-table-actions :is(.ui-action-icon, .ui-trash-icon) {", self.styles)
        self.assertIn(".proxy-card-grid {\n    display: grid;", self.styles)
        self.assertIn(".proxy-table-wrap {\n    display: none;", self.styles)

    def test_automation_plan_strategy_summary_stays_on_one_full_width_line(self):
        renderer = self.console_script[
            self.console_script.index("function renderAutomationPlanStrategyFields"):
            self.console_script.index("\nfunction automationPlanStrategySummary")
        ]

        self.assertIn(
            'class="automation-plan-detail-strategy automation-plan-detail-strategy--summary"',
            renderer,
        )
        self.assertIn(".automation-plan-detail-strategy--summary {", self.styles)
        self.assertIn("grid-column: 1 / -1;", self.styles)
        self.assertIn(".automation-plan-detail-strategy--summary dd {", self.styles)
        self.assertIn("white-space: nowrap;", self.styles)
        self.assertIn("overflow-wrap: normal;", self.styles)

    def test_proxy_market_modal_uses_card_skeletons_and_corrects_stale_country_titles(self):
        modal = self.console_script[
            self.console_script.index("function proxyMarketCatalogRoot"):
            self.console_script.index("function proxyFormPayload")
        ]

        self.assertIn("function proxyMarketCatalogTotal(payload = {})", modal)
        self.assertIn("function renderProxyMarketMiniSkeletonCards(count = 4)", modal)
        self.assertIn('class="proxy-market-mini-card is-loading"', modal)
        self.assertIn("proxyMarketAvailableCount: 0", self.console_script)
        self.assertIn("state.proxyMarketAvailableCount = Math.max(0, Number(summary?.available_catalog_count || 0));", self.console_script)
        self.assertIn("let placeholderCount = Math.max(1, Math.min(12, Number(state.proxyMarketAvailableCount || 0) || 4));", modal)
        self.assertIn("grid.innerHTML = renderProxyMarketMiniSkeletonCards(placeholderCount);", modal)
        self.assertIn("function proxyMarketItemTitle(item = {})", modal)
        self.assertIn("/^[a-z]{2}$/i.test(alias)", modal)
        self.assertIn("actualCountry.key !== namedCountry.key", modal)
        self.assertIn("const title = proxyMarketItemTitle(item);", modal)
        self.assertIn(".proxy-market-mini-card.is-loading", self.styles)
        self.assertIn("@keyframes proxy-market-mini-skeleton-shift", self.styles)

    def test_media_generation_requires_a_loadable_persona_reference_image(self):
        self.assertIn(
            "async function ensurePersonaReferenceImageForMediaTask(persona)",
            self.console_script,
        )
        self.assertIn('title: "请先生成人设图"', self.console_script)
        self.assertIn('confirmText: "去生成人设图"', self.console_script)
        self.assertIn("await openPersonaImageGeneration(personaId)", self.console_script)
        submit = re.search(
            r"async function submitPersonaMediaTask\(\) \{(?P<body>.*?)\n\}",
            self.console_script,
            re.DOTALL,
        )
        self.assertIsNotNone(submit)
        body = submit.group("body")
        guard = "if (!(await ensurePersonaReferenceImageForMediaTask(persona))) return;"
        self.assertIn(guard, body)
        self.assertLess(body.index(guard), body.index("snapshotPersonaCurrentForm();"))
        self.assertLess(body.index(guard), body.index('api("/api/tasks/submit"'))

    def test_media_generation_uses_a_single_optional_prompt_and_four_image_limit(self):
        self.assertNotIn("function renderPersonaMediaContentModeTabs", self.console_script)
        self.assertNotIn("personaMediaManualContent", self.console_script)
        self.assertIn("function normalizePersonaMediaGenerationForm", self.console_script)
        self.assertIn("<select id=\"personaMediaImageCount\">", self.console_script)
        self.assertIn("[1, 2, 3, 4]", self.console_script)
        self.assertNotIn('"AI 润色预览"', self.console_script)
        self.assertIn('taskState?.taskId ? "重新生成" : "生成预览"', self.console_script)
        self.assertIn("content_source_mode: \"draft\"", self.console_script)
        self.assertNotIn("contentMode === \"manual\"", self.console_script)
        self.assertNotIn("manual_content:", self.console_script)
        self.assertGreaterEqual(self.console_script.count('value="auto"'), 2)
        self.assertNotIn("自动（AI 匹配）", self.console_script)
        self.assertGreaterEqual(
            self.console_script.count(
                '${String(mediaForm.aspectRatio || "auto") === "auto" ? "selected" : ""}>自动</option>'
            ),
            2,
        )
        self.assertIn('aspectRatio: "auto"', self.console_script)
        self.assertIn('String(form.aspectRatio || "auto")', self.console_script)
        self.assertNotIn(
            "Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : 1, 1), 8)",
            self.console_script,
        )

    def test_media_task_selection_keeps_image_nodes_and_draft_edit_reuses_media_editor(self):
        task_handler_start = self.console_script.index(
            'const taskMediaSelect = event.target.closest("[data-persona-task-media-select]")'
        )
        task_handler_end = self.console_script.index(
            'if (event.target.closest("[data-persona-attach-task-media]"))',
            task_handler_start,
        )
        task_handler = self.console_script[task_handler_start:task_handler_end]
        self.assertIn("syncPersonaTaskMediaSelectionState(", task_handler)
        self.assertIn('taskMediaSelect.closest(".persona-media-operation-pane")', task_handler)
        self.assertNotIn("renderPersonaDetail()", task_handler)
        self.assertIn("thumbnailUrl: thumbnailUrl || previewUrl", self.console_script)

        composer_start = self.console_script.index(
            "function renderPersonaInlineMediaComposer("
        )
        composer_end = self.console_script.index(
            "\nfunction taskOutputMediaItems",
            composer_start,
        )
        composer = self.console_script[composer_start:composer_end]
        self.assertIn("renderPersonaEditableMediaGrid(postMediaItems", composer)
        self.assertIn("postMediaItems.length", composer)
        self.assertIn("renderPersonaCompactMediaUpload(persona, post)", composer)
        self.assertIn("data-persona-edit-post-media", self.console_script)
        self.assertIn("data-persona-delete-post-media", self.console_script)

    def test_full_refresh_scope_is_limited_to_visible_personas(self):
        user = {"id": 7}
        with mock.patch.object(
            server,
            "_visible_persona_ids",
            return_value={"persona-b", "persona-a"},
        ):
            self.assertEqual(
                server._persona_dashboard_refresh_archive_ids("", user),
                ["persona-a", "persona-b"],
            )

    def test_single_refresh_scope_still_checks_persona_access(self):
        user = {"id": 7}
        with mock.patch.object(server, "_require_persona_access") as require_access:
            self.assertEqual(
                server._persona_dashboard_refresh_archive_ids("persona-a", user),
                ["persona-a"],
            )
        require_access.assert_called_once_with("persona-a", user)

    def test_full_refresh_rejects_an_empty_visible_scope(self):
        with mock.patch.object(server, "_visible_persona_ids", return_value=set()):
            with self.assertRaises(HTTPException) as raised:
                server._persona_dashboard_refresh_archive_ids("", {"id": 7})
        self.assertEqual(raised.exception.status_code, 400)

    def test_selected_persona_survives_refresh_with_workspace_scoped_storage(self):
        self.assertIn(
            'const SELECTED_PERSONA_STORAGE_KEY = "wk-selected-persona";',
            self.console_script,
        )
        self.assertIn(
            "consoleUserId(ADMIN_WORKSPACE_USER_ID || user?.id)",
            self.console_script,
        )
        self.assertIn(
            "state.selectedPersonaId || storedSelectedPersonaId() || \"\"",
            self.console_script,
        )
        self.assertIn(
            "setSelectedPersonaId(requestedPersonaExists ? requestedPersonaId : state.personas[0]?.id || \"\");",
            self.console_script,
        )
        self.assertIn(
            "setSelectedPersonaId(nextPersonaId);",
            self.console_script,
        )
        self.assertIn(
            'if (cleanId) window.localStorage.setItem(key, cleanId);',
            self.console_script,
        )
        self.assertIn(
            "else window.localStorage.removeItem(key);",
            self.console_script,
        )

    def test_persona_account_picker_shows_binding_status_without_browser_environment_copy(self):
        self.assertIn("function personaAccountBindingDisplay(", self.console_script)
        self.assertIn("function personaAccountPickerTriggerDisplay(", self.console_script)
        self.assertIn("function renderPersonaAccountBindingIcon(", self.console_script)
        self.assertIn('label: "可选 · 未绑定人设"', self.console_script)
        self.assertIn("已绑定人设：${currentPersona?.name || currentPersonaId}", self.console_script)
        self.assertIn("添加后替换", self.console_script)
        self.assertIn("persona-account-picker-binding", self.console_script)
        self.assertIn("persona-account-picker-proxy", self.console_script)
        self.assertIn("persona-account-picker-card-action is-${esc(binding.actionKind)}", self.console_script)
        self.assertIn("renderPersonaAccountBindingIcon(binding.actionKind)", self.console_script)
        self.assertNotIn("浏览器环境已配置", self.console_script)
        self.assertNotIn("浏览器环境未配置", self.console_script)
        self.assertNotIn("已配置浏览器环境", self.console_script)
        self.assertNotIn("未配置浏览器环境", self.console_script)
        self.assertIn("grid-template-columns: minmax(0, 1fr) auto;", self.styles)
        self.assertIn(".persona-account-picker-card-meta {\n  display: grid;", self.styles)
        self.assertIn("grid-template-columns: minmax(0, 1fr);", self.styles)
        self.assertIn(".persona-account-picker-card .persona-account-picker-binding.is-bound", self.styles)

    def test_persona_account_picker_uses_stateful_icons_and_proxy_aligned_actions(self):
        self.assertIn('action: "绑定账号", actionKind: "bind"', self.console_script)
        self.assertIn('action: "已绑定",\n      actionKind: "current"', self.console_script)
        self.assertIn('action: "替换绑定",\n    actionKind: "replace"', self.console_script)
        self.assertIn('label: "更换账号"', self.console_script)
        self.assertIn('label: "绑定账号"', self.console_script)
        self.assertIn('label: "添加账号"', self.console_script)
        card_start = self.styles.index(".persona-account-picker-card {")
        card_rule = self.styles[card_start:self.styles.index("}", card_start) + 1]
        self.assertIn('"meta action"', card_rule)
        self.assertNotIn('"action action"', card_rule)
        self.assertIn(".persona-account-picker-card-action.is-current", self.styles)
        self.assertIn(".persona-account-picker-card-action.is-replace", self.styles)
        self.assertIn(".persona-account-add-button:not(.is-add) > span::before", self.styles)

    def test_shared_console_modal_uses_a_bottom_slide_without_fade_or_scale(self):
        keyframe_start = self.styles.index("@keyframes vecto-console-modal-dialog-bottom-slide-in {")
        dialog_start = self.styles.rindex(".console-modal-dialog {", 0, keyframe_start)
        modal_start = self.styles.rindex(".console-modal {", 0, dialog_start)
        modal_rule = self.styles[modal_start:self.styles.index("}", modal_start) + 1]
        dialog_rule = self.styles[dialog_start:self.styles.index("}", dialog_start) + 1]
        keyframe_rule = self.styles[keyframe_start:self.styles.index("}", self.styles.index("}", keyframe_start) + 1) + 1]

        self.assertNotIn("animation:", modal_rule)
        self.assertIn("transform-origin: center bottom;", dialog_rule)
        self.assertIn("animation: vecto-console-modal-dialog-bottom-slide-in", dialog_rule)
        self.assertIn("transform: translateY(28px);", keyframe_rule)
        self.assertNotIn("opacity:", keyframe_rule)
        self.assertNotIn("scale(", keyframe_rule)

    def test_persona_account_picker_reuses_account_pool_identity_field_order(self):
        picker_start = self.console_script.index("function renderPersonaAccountPoolPickerCard(")
        picker_end = self.console_script.index("\nasync function bindPoolAccountToPersona", picker_start)
        picker = self.console_script[picker_start:picker_end]
        helper_start = self.console_script.index("function renderAccountPoolCardFields(")
        helper_end = self.console_script.index("\nfunction renderAccountPoolCard(", helper_start)
        helper = self.console_script[helper_start:helper_end]

        self.assertIn("renderAccountPoolCardFields(account)", picker)
        self.assertIn('"platform status"', self.styles)
        self.assertIn('"username totp"', self.styles)
        self.assertLess(helper.index("account-pool-card-platform"), helper.index("account-pool-card-copy"))
        self.assertLess(helper.index("account-pool-card-copy"), helper.index("account-pool-card-flags"))

    def test_persona_account_picker_reuses_compact_account_pool_status_styles(self):
        selector = ".persona-account-picker-card .account-pool-card-flags .status,\n.persona-account-picker-card .account-totp-badge {"
        start = self.styles.index(selector)
        rule = self.styles[start:self.styles.index("}", start) + 1]

        self.assertIn("min-height: 20px;", rule)
        self.assertIn("padding: 2px 6px;", rule)
        self.assertIn("font-size: 10px;", rule)
        self.assertIn("line-height: 1.15;", rule)

    def test_persona_account_picker_places_totp_on_the_account_pool_second_row(self):
        main_selector = ".persona-account-picker-card .account-pool-card-main {"
        main_start = self.styles.index(main_selector)
        main_rule = self.styles[main_start:self.styles.index("}", main_start) + 1]
        flags_selector = ".persona-account-picker-card .account-pool-card-flags {"
        flags_start = self.styles.index(flags_selector)
        flags_rule = self.styles[flags_start:self.styles.index("}", flags_start) + 1]

        self.assertIn('"platform status"', main_rule)
        self.assertIn('"username totp"', main_rule)
        self.assertIn("display: contents;", flags_rule)
        self.assertIn("grid-area: status;", self.styles)
        self.assertIn("grid-area: totp;", self.styles)

    def test_mobile_persona_dashboard_posts_load_at_the_bottom_without_replacing_desktop_pager(self):
        self.assertIn('const PD_MOBILE_TWEET_STREAM_QUERY = "(max-width: 760px)";', self.dashboard_script)
        self.assertIn("function pdBindMobilePostStream(", self.dashboard_script)
        self.assertIn('data-persona-mobile-post-sentinel', self.dashboard_script)
        self.assertIn("new IntersectionObserver(", self.dashboard_script)
        self.assertIn("insertAdjacentHTML(\"beforeend\"", self.dashboard_script)
        self.assertIn('id="personaPostPrev"', self.dashboard_script)
        self.assertIn('id="personaPostNext"', self.dashboard_script)
        self.assertIn("pdDisconnectMobilePostStream();", self.dashboard_script)

    def test_mobile_tweet_surfaces_share_one_incremental_loading_manager(self):
        self.assertIn('const MOBILE_TWEET_STREAM_QUERY = "(max-width: 760px)";', self.console_script)
        self.assertIn("function mobileTweetStreamInfo(", self.console_script)
        self.assertIn("function renderMobileTweetStreamFooter(", self.console_script)
        self.assertIn("function bindMobileTweetStreamObservers(", self.console_script)
        self.assertIn("new IntersectionObserver(", self.console_script)
        self.assertIn('if (target === "persona-detail") renderPersonaDetail();', self.console_script)
        self.assertIn('else if (target === "publishing") renderSimpleFlowModule("publishing");', self.console_script)
        self.assertIn(".mobile-tweet-stream-footer", self.styles)

    def test_mobile_draft_batches_keep_selection_against_the_full_source(self):
        draft_rows_start = self.console_script.index("function renderPersonaDraftRows(")
        draft_rows_end = self.console_script.index("\nfunction personaDraftViewMode(", draft_rows_start)
        draft_rows = self.console_script[draft_rows_start:draft_rows_end]
        table_rows_start = self.console_script.index("function renderPersonaDraftTableRows(")
        table_rows_end = self.console_script.index("\nfunction renderPersonaPostBulkActions(", table_rows_start)
        table_rows = self.console_script[table_rows_start:table_rows_end]
        self.assertIn("syncPersonaSelectedPostIds(selectedPersona(), source, allRows)", draft_rows)
        self.assertIn("syncPersonaSelectedPostIds(selectedPersona(), source, allRows)", table_rows)

    def test_mobile_publish_sources_and_history_render_only_the_loaded_batch(self):
        source_start = self.console_script.index("function renderPublishPostSelectionList(")
        source_end = self.console_script.index("\nfunction renderPublishContentPreview(", source_start)
        source_renderer = self.console_script[source_start:source_end]
        history_start = self.console_script.index("function renderPublishHistorySelectionList(")
        history_end = self.console_script.index("\nfunction renderPublishHistoryPreview(", history_start)
        history_renderer = self.console_script[history_start:history_end]
        self.assertIn('mobileTweetStreamInfo(rows, `publish-source:', source_renderer)
        self.assertIn("stream.items.map(", source_renderer)
        self.assertIn('renderMobileTweetStreamFooter(stream, "publishing")', source_renderer)
        self.assertIn('mobileTweetStreamInfo(rows, `publish-history:', history_renderer)
        self.assertIn("stream.items.map(", history_renderer)
        self.assertIn('renderMobileTweetStreamFooter(stream, "publishing")', history_renderer)

    def test_mobile_publish_preview_does_not_build_hidden_tabs_for_every_selected_post(self):
        preview_start = self.console_script.index("function renderPublishContentPreview(")
        preview_end = self.console_script.index("\nfunction renderPublishContentPanel(", preview_start)
        preview = self.console_script[preview_start:preview_end]
        self.assertIn("const previewPosts = isMobileTweetStreamMode()", preview)
        self.assertIn("previewPosts.map(", preview)

    def test_mobile_tweet_loading_shows_a_spinner_and_locks_scroll_until_layout_finishes(self):
        self.assertIn("const MOBILE_TWEET_STREAM_MIN_LOADING_MS = 220;", self.console_script)
        self.assertIn("function renderMobileTweetStreamLoadingIndicator()", self.console_script)
        self.assertIn("function lockMobileTweetStreamScroll()", self.console_script)
        self.assertIn("function unlockMobileTweetStreamScroll()", self.console_script)
        self.assertIn("function cancelMobileTweetStreamLoading()", self.console_script)
        self.assertIn('document.documentElement.classList.add("mobile-tweet-stream-scroll-locked")', self.console_script)
        self.assertIn('event.preventDefault();', self.console_script)
        self.assertIn("function finishMobileTweetStreamLoading(", self.console_script)
        self.assertIn("mobileTweetStreamLoadingGeneration", self.console_script)
        self.assertIn("!node.isConnected || !node.getClientRects().length", self.console_script)
        self.assertIn('role="status" aria-live="polite" aria-atomic="true" aria-busy="false"', self.console_script)
        self.assertIn('class="mobile-tweet-stream-spinner"', self.console_script)
        self.assertIn('rootMargin: "0px 0px -72px 0px"', self.console_script)
        self.assertIn("threshold: 0.85", self.console_script)
        self.assertIn("@keyframes mobile-tweet-stream-spin", self.styles)
        self.assertIn(".mobile-tweet-stream-scroll-locked", self.styles)

    def test_dashboard_incremental_append_uses_the_same_loading_lock(self):
        load_start = self.dashboard_script.index("function pdLoadNextMobilePostBatch(")
        load_end = self.dashboard_script.index("\nfunction pdBindMobilePostStream(", load_start)
        loader = self.dashboard_script[load_start:load_end]
        self.assertIn("lockMobileTweetStreamScroll();", loader)
        self.assertIn("renderMobileTweetStreamLoadingIndicator()", loader)
        self.assertIn("finishMobileTweetStreamLoading(", loader)
        self.assertIn("triggerStreamKey !== personaDashboardMobilePostKey", loader)
        self.assertIn("!status?.isConnected", loader)


if __name__ == "__main__":
    unittest.main()
