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

    def test_admin_entry_is_beside_subscription_and_keeps_permission_gate(self):
        subscription = self.markup.index('class="site-icon-button site-subscription-link"')
        admin_entry = self.markup.index('id="openAdmin"')
        account_menu = self.markup.index('class="site-account-menu"')

        self.assertLess(subscription, admin_entry)
        self.assertLess(admin_entry, account_menu)
        self.assertIn('class="site-admin-entry admin-only" hidden>运营后台</button>', self.markup)
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
        self.assertIn(
            ".persona-media-lightbox {\n"
            "  position: fixed;\n"
            "  inset: 0;\n"
            "  z-index: 7000;\n"
            "  display: grid;\n"
            "  place-items: center;",
            self.styles,
        )
        self.assertIn("background: #111817;", self.styles)
        self.assertIn("background: #050b0a;", self.styles)
        self.assertIn("object-fit: contain;", self.styles)
        self.assertIn("object-position: center;", self.styles)
        self.assertIn(".persona-post-gallery-card", self.dashboard_styles)
        self.assertIn("background: #111817;", self.dashboard_styles)
        self.assertIn(".persona-post-gallery-stage", self.dashboard_styles)
        self.assertIn("background: #050b0a;", self.dashboard_styles)
        self.assertIn("object-position: center;", self.dashboard_styles)

    def test_generation_and_media_result_actions_use_clear_compact_labels(self):
        self.assertIn('(isRewriteMode ? "AI 重写推文" : "开始生成")', self.console_script)
        self.assertNotIn('"自动生成草稿"', self.console_script)
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

    def test_mobile_task_dock_reuses_the_five_workspace_modules(self):
        self.assertIn('id="mobileTaskDock"', self.markup)
        self.assertIn("function renderMobileTaskDock()", self.console_script)
        self.assertIn("modules.map((item) =>", self.console_script)
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
            "browser_list",
        ):
            with self.subTest(module_id=module_id):
                self.assertIn(f'{module_id}:', self.console_script)

        self.assertIn(
            'item.label === "账号管理" ? "账号池"',
            self.console_script,
        )

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
        self.assertIn("margin-left: auto;", mobile_styles)

    def test_task_queue_removes_open_current_persona_action(self):
        self.assertNotIn("data-task-open-persona", self.console_script)
        self.assertNotIn("打开当前人设", self.console_script)

    def test_persona_generation_modes_use_short_labels_and_mobile_capsules(self):
        self.assertIn('["tweet", "生成推文"]', self.console_script)
        self.assertIn('["tweet_media", "推文加配图"]', self.console_script)
        self.assertNotIn("只生成推文", self.console_script)
        self.assertNotIn("根据推文生成配图", self.console_script)

        mobile_rule = (
            ".console-page .persona-detail :is(\n"
            "    .persona-compose-toggle,\n"
            "    .persona-source-toggle,\n"
            "    .persona-media-operation-toggle\n"
            '  ) button[type="button"] {\n'
            "    border-radius: 999px;"
        )
        self.assertIn(mobile_rule, self.styles)

    def test_mobile_task_queue_persona_list_reuses_shared_drawer(self):
        selector_start = self.console_script.index("function renderTaskQueuePersonaSelector()")
        selector_end = self.console_script.index("\nfunction renderTaskQueueView()", selector_start)
        selector = self.console_script[selector_start:selector_end]
        view_start = selector_end
        view_end = self.console_script.index("\nfunction currentBranch", view_start)
        view = self.console_script[view_start:view_end]
        handler_start = self.console_script.index('  $("taskTable").addEventListener("click", (event) => {')
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
        self.assertLess(
            select_handler.index('$("taskTable").innerHTML = renderTaskQueueView();'),
            select_handler.index('setPersonaMobileSidebarOpen(false, "taskQueuePersonaSidebar");'),
        )
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
        self.assertLess(
            handler.index("scrollConsolePageToTop();"),
            handler.index('event.target.closest("[data-workspace-view]")'),
        )

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

    def test_mobile_page_toolbar_is_shared_and_keeps_publish_header_compact(self):
        header_start = self.console_script.index("function renderPublishHeaderRow(mode, account)")
        header_end = self.console_script.index("\nfunction padSchedulePart", header_start)
        header = self.console_script[header_start:header_end]
        toolbar_start = self.markup.index('id="mobilePageToolbar"')
        toolbar_end = self.markup.index('<main id="main-content"', toolbar_start)
        toolbar = self.markup[toolbar_start:toolbar_end]
        header_end = self.markup.index("</header>")
        site_header = self.markup[:header_end]

        self.assertNotIn('id="mobileNavToggle"', site_header)
        self.assertIn('id="mobileNavToggle"', toolbar)
        self.assertIn('id="mobilePageToolbarTitle"', toolbar)
        self.assertIn('id="mobilePageContextAction"', toolbar)
        self.assertIn('id="mobilePageContextLabel"', toolbar)
        self.assertIn("function mobilePageToolbarDescriptor()", self.console_script)
        self.assertIn("function syncMobilePageToolbar()", self.console_script)
        self.assertIn('grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);', self.styles)
        self.assertIn("height: 52px;", self.styles)
        self.assertIn("min-height: 52px;", self.styles)
        self.assertIn(".mobile-page-toolbar > .mobile-nav-toggle", self.styles)
        self.assertIn(".mobile-page-context-action", self.styles)
        self.assertIn("grid-column: 3;", self.styles)
        self.assertIn("justify-self: end;", self.styles)
        self.assertIn('class="publish-inline-title">发布</strong>', header)
        self.assertNotIn('${renderMobileTaskIcon("publishing")}', header)
        self.assertNotIn('class="publish-header-end-slot"', header)
        self.assertIn('data-persona-mobile-list-toggle="publishPersonaSidebar"', header)
        self.assertNotIn("publish-account-badge", header)
        self.assertNotIn("到账号管理绑定", header)

    def test_current_persona_summary_is_shared_only_across_mobile_console_views(self):
        summary_start = self.markup.index('id="persistentPersonaSummary"')
        workspace_start = self.markup.index('<section class="view is-active" data-panel="workspace">')
        self.assertLess(summary_start, workspace_start)
        self.assertIn("function renderPersistentPersonaSummary()", self.console_script)
        self.assertIn("function personaSummaryCounts(persona)", self.console_script)
        toolbar = self.console_script[
            self.console_script.index("function syncMobilePageToolbar()"):
            self.console_script.index("\nfunction renderMobileTaskDock()")
        ]
        self.assertIn("renderPersistentPersonaSummary();", toolbar)
        overview = self.console_script[
            self.console_script.index("function applyPersonaOverviewData"):
            self.console_script.index("\nfunction hydratePersonaOverviewFromCache")
        ]
        self.assertIn("renderPersistentPersonaSummary();", overview)
        detail = self.console_script[
            self.console_script.index("function renderPersonaDetail()"):
            self.console_script.index("\nfunction renderPersonaContentPanel")
        ]
        self.assertIn("renderPersistentPersonaSummary();", detail)
        self.assertIn('class="persona-workbench-head"', detail)
        self.assertIn("persona-detail-summary-panel", detail)
        self.assertIn(".persistent-persona-summary {", self.styles)
        self.assertIn("display: none;", self.styles[self.styles.index(".persistent-persona-summary {"):])
        mobile_summary = self.styles.index("  .persistent-persona-summary {")
        self.assertIn("display: flex;", self.styles[mobile_summary:mobile_summary + 220])
        self.assertIn(
            ".persona-detail-summary-panel .persona-workbench-head",
            self.styles,
        )

    def test_mobile_persona_buttons_share_persistent_style(self):
        self.assertGreaterEqual(self.console_script.count('class="persona-mobile-list-toggle"'), 4)
        self.assertNotIn('<span>人设列表</span>', self.console_script)
        self.assertGreaterEqual(self.console_script.count("<span>选择人设</span>"), 5)
        self.assertIn(
            ".console-main .persona-mobile-list-toggle[data-persona-mobile-list-toggle]",
            self.styles,
        )
        self.assertIn(
            'Array.from(activePanel?.querySelectorAll("[data-persona-mobile-list-toggle]") || [])',
            self.console_script,
        )
        self.assertIn('.find((button) => !button.closest("[hidden]"));', self.console_script)
        self.assertIn(
            "setPersonaMobileSidebarOpen(!sidebar.classList.contains(\"is-mobile-open\"), sidebarId);",
            self.console_script,
        )

    def test_publish_preview_number_tabs_are_hidden_only_on_mobile(self):
        preview = self.console_script[
            self.console_script.index("function renderPublishContentPreview"):
            self.console_script.index("\nfunction renderPublishContentPanel")
        ]
        self.assertIn(
            'class="publish-content-preview publish-content-preview--selection"',
            preview,
        )
        self.assertIn(
            'aria-label="${esc(`第${index + 1}篇：${previewTitle}`)}"',
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

    def test_publish_reuses_shared_link_settings_and_refreshes_preview(self):
        self.assertIn("function applyPersonaLinkPresetToContent", self.console_script)
        self.assertIn("function renderPublishLinkSettings", self.console_script)
        self.assertIn('data-persona-open-links', self.console_script)
        self.assertIn('content_override: publishContentForPost(post, persona)', self.console_script)
        self.assertIn('if (state.activeModule === "publishing") renderSimpleFlowModule("publishing");', self.console_script)
        self.assertIn(".publish-link-settings {", self.styles)
        self.assertNotIn('<span class="publish-link-settings-label">', self.console_script)
        self.assertNotIn("publish-link-settings-label", self.styles)
        self.assertNotIn('<span class="publish-link-settings-label">临时链接</span>', self.console_script)

    def test_mobile_publish_source_stays_above_content_and_link_panel_is_stable(self):
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
        self.assertIn(
            ".publish-content-preview .publish-link-settings {\n"
            "    padding: 9px 12px;\n"
            "    border: 1px solid var(--line);\n"
            "    border-radius: var(--radius);\n"
            "    background: var(--panel-solid);",
            responsive_styles,
        )
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
        self.assertIn("grid-template-areas:\n      \"index name status actions\"\n      \"url url ending ending\";", self.styles)
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

    def test_dashboard_charts_reuse_the_console_accent(self):
        self.assertIn('const colors = ["var(--accent)"', self.dashboard_script)
        self.assertIn('color: "var(--accent)"', self.dashboard_script)
        self.assertIn(
            ".persona-dashboard-view .persona-bar-fill",
            self.styles,
        )

    def test_draft_source_controls_are_wide_without_quick_select(self):
        self.assertNotIn("草稿快速选择", self.console_script)
        self.assertNotIn("收藏快速选择", self.console_script)
        self.assertIn(".persona-source-toggle {\n  width: min(100%, 280px);", self.styles)

    def test_draft_toolbar_uses_icon_bulk_actions_and_aligned_controls(self):
        bulk_actions = self.console_script[
            self.console_script.index("function renderPersonaPostBulkActions"):
            self.console_script.index("async function viewPersonaDraftPost")
        ]
        self.assertIn('title="全选" aria-label="全选"', bulk_actions)
        self.assertIn("${renderSelectAllIcon()}", bulk_actions)
        self.assertIn('title="清空选择" aria-label="清空选择"', bulk_actions)
        self.assertIn("${renderClearSelectionIcon()}", bulk_actions)
        self.assertIn("${renderTrashIcon()}", bulk_actions)
        self.assertNotIn(">全选</button>", bulk_actions)
        self.assertNotIn(">清空</button>", bulk_actions)
        self.assertIn(
            ".console-page .persona-detail .persona-draft-toolbar > .row-actions > button {\n"
            "  height: 40px;\n"
            "  min-height: 40px;",
            self.styles,
        )
        self.assertIn(".persona-post-bulk-actions .persona-post-bulk-icon-button {", self.styles)

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
            ".ui-action-icon,\n.ui-trash-icon,\n.ui-eye-icon,\n.ui-expand-icon,",
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
            "  .persona-memory-delete,\n"
            "  .persona-hot-media-action",
            self.styles,
        )
        self.assertIn("place-items: center;\n  padding: 0;\n  line-height: 0;", self.styles)

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


if __name__ == "__main__":
    unittest.main()
