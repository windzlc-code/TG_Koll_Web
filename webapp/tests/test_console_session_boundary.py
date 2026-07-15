import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = REPO_ROOT / "webapp" / "static" / "assets" / "console.js"
CONSOLE_CSS = REPO_ROOT / "webapp" / "static" / "assets" / "console.css"


class ConsoleSessionBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = CONSOLE_JS.read_text(encoding="utf-8")
        cls.styles = CONSOLE_CSS.read_text(encoding="utf-8")

    def _section(self, start_marker, end_marker):
        start = self.source.index(start_marker)
        end = self.source.index(end_marker, start)
        return self.source[start:end]

    def _function_source(self, name):
        marker = f"function {name}("
        start = self.source.index(marker)
        brace = self.source.index("{", start)
        depth = 0
        quote = None
        escaped = False
        line_comment = False
        block_comment = False
        index = brace
        while index < len(self.source):
            char = self.source[index]
            next_char = self.source[index + 1] if index + 1 < len(self.source) else ""
            if line_comment:
                if char == "\n":
                    line_comment = False
            elif block_comment:
                if char == "*" and next_char == "/":
                    block_comment = False
                    index += 1
            elif quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    quote = None
            elif char in {'"', "'", "`"}:
                quote = char
            elif char == "/" and next_char == "/":
                line_comment = True
                index += 1
            elif char == "/" and next_char == "*":
                block_comment = True
                index += 1
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return self.source[start:index + 1]
            index += 1
        self.fail(f"Could not extract JavaScript function {name}")

    def _css_block(self, marker, start=0):
        block_start = self.styles.index(marker, start)
        brace = self.styles.index("{", block_start)
        depth = 0
        for index in range(brace, len(self.styles)):
            if self.styles[index] == "{":
                depth += 1
            elif self.styles[index] == "}":
                depth -= 1
                if depth == 0:
                    return self.styles[block_start:index + 1]
        self.fail(f"Could not extract CSS block {marker}")

    def _run_node(self, script):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        with tempfile.TemporaryDirectory() as tmpdir:
            harness = Path(tmpdir) / "session-boundary-test.js"
            harness.write_text(script, encoding="utf-8")
            result = subprocess.run(
                [node, str(harness)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=20,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_init_validates_me_before_bootstrap_or_tenant_loads(self):
        init = self._section("async function init()", "\ninit().catch")
        me_index = init.index("const me = await loadMe()")
        self.assertLess(me_index, init.index("hydratePersonaOverviewFromBootstrap(me)"))
        self.assertLess(me_index, init.index("bindEvents()"))
        self.assertLess(me_index, init.index("setView(state.view)"))
        self.assertLess(me_index, init.index("loadTasks()"))
        self.assertLess(me_index, init.index("loadSocial("))
        self.assertNotIn("hydratePersonaOverviewFromCache", init)
        self.assertNotIn("hydrateSocialAccountsFromCache", init)

    def test_bootstrap_requires_matching_server_user_id(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const state = {{ currentUser: null }};
            const window = {{ __CONSOLE_BOOTSTRAP__: {{ user_id: "11", personas: [{{ id: "p1" }}] }} }};
            let applied = 0;
            function applyPersonaOverviewData() {{ applied += 1; }}
            {self._function_source("consoleUserId")}
            {self._function_source("consoleBootstrapUserId")}
            {self._function_source("discardConsoleBootstrap")}
            {self._function_source("hydratePersonaOverviewFromBootstrap")}

            assert.strictEqual(hydratePersonaOverviewFromBootstrap({{ id: 12 }}), false);
            assert.strictEqual(applied, 0);
            assert.strictEqual(window.__CONSOLE_BOOTSTRAP__, null);

            window.__CONSOLE_BOOTSTRAP__ = {{ user_id: 11, personas: [{{ id: "p2" }}] }};
            assert.strictEqual(hydratePersonaOverviewFromBootstrap({{ id: "11" }}), true);
            assert.strictEqual(applied, 1);
            assert.strictEqual(window.__CONSOLE_BOOTSTRAP__, null);
            """
        )
        self._run_node(harness)

    def test_auth_boundaries_redirect_but_customer_403_does_not(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            let consoleBoundaryNavigationActive = false;
            let cleared = 0;
            let target = "";
            const window = {{ location: {{ replace(value) {{ target = value; }} }} }};
            function clearTenantInMemoryState() {{ cleared += 1; }}
            {self._function_source("handleSessionBoundary")}

            assert.strictEqual(handleSessionBoundary(403), false);
            assert.strictEqual(cleared, 0);
            assert.strictEqual(target, "");

            assert.strictEqual(handleSessionBoundary(401), true);
            assert.strictEqual(cleared, 1);
            assert.strictEqual(target, "/login.html");

            consoleBoundaryNavigationActive = false;
            target = "";
            assert.strictEqual(handleSessionBoundary(428), true);
            assert.strictEqual(cleared, 2);
            assert.strictEqual(target, "/change-password.html");
            """
        )
        self._run_node(harness)

    def test_auth_clear_resets_tenant_collections_and_invalidates_requests(self):
        clear_state = self._function_source("clearTenantInMemoryState")
        self.assertIn("tenantStateGeneration += 1", clear_state)
        self.assertIn("state.events.close?.()", clear_state)
        self.assertIn("state.personaCreateKeywordController.abort?", clear_state)
        for assignment in (
            "state.tasks = []",
            "state.personas = []",
            "state.socialAccounts = []",
            "state.socialProxies = []",
            "state.socialTasks = []",
            "state.socialBrowserSessions = []",
            "state.personaDraftPosts = {}",
            "state.personaForms = {}",
            "state.accountPasswordValues = {}",
        ):
            self.assertIn(assignment, clear_state)

        api = self._section("async function api(", "async function apiWithTimeout(")
        self.assertIn("handleSessionBoundary(response.status)", api)
        self.assertIn("requestGeneration !== tenantStateGeneration", api)

        social_loader = self._section("async function loadAutomationTasksShared(", "async function activateCreatedPersona(")
        self.assertIn("tenantArrayFallback(error, state.socialTasks)", social_loader)
        fallback = self._function_source("tenantArrayFallback")
        self.assertIn("[401, 428]", fallback)
        self.assertNotIn("403", fallback)

    def test_unfinished_manual_tasks_keep_status_refresh_active(self):
        active_task = self._function_source("activeSocialAutomationTask")
        refresh_check = self._function_source("hasActiveSocialTaskToast")

        self.assertIn('status === "need_manual" && isUnfinishedTask(task)', active_task)
        self.assertIn("activeSocialAutomationTask(task)", refresh_check)
        self.assertNotIn('["queued", "running"].includes', refresh_check)

    def test_status_refresh_does_not_replace_the_account_pool_dom(self):
        account_refresh = self._section("async function refreshSocialAccountsOnly", "function refreshLiveBrowserSessionsSoon")
        account_status = self._function_source("updateAccountStatusViews")
        task_refresh = self._function_source("syncSocialTaskToastAutoRefresh")

        self.assertIn('api("/api/persona_dashboard/automation/accounts")', account_refresh)
        self.assertIn("if (includeOverview) renderLiveBrowserSessions()", account_refresh)
        self.assertNotIn("renderSocialTasks()", account_refresh)
        self.assertNotIn("renderSocialAccounts()", account_status)
        self.assertNotIn("renderConfirmSummary()", account_status)
        self.assertIn('loadAutomationTasksShared().catch', task_refresh)
        self.assertNotIn("loadAutomationTasksShared({ force: true })", task_refresh)

    def test_live_browser_polling_preserves_unchanged_placeholder_nodes(self):
        browser_render = self._function_source("renderLiveBrowserSessions")
        placeholder_sync = self._function_source("syncLiveBrowserPlaceholders")
        card_insert = self._function_source("insertLiveBrowserSessionCard")

        self.assertIn("syncLiveBrowserPlaceholders(grid, sessions.length)", browser_render)
        self.assertIn("insertLiveBrowserSessionCard(grid, card)", browser_render)
        self.assertNotIn('querySelectorAll("[data-live-browser-placeholder]").forEach', browser_render)
        self.assertNotIn('insertAdjacentHTML("beforeend", renderLiveBrowserPlaceholders', browser_render)
        self.assertIn('querySelectorAll("[data-live-browser-placeholder]")', placeholder_sync)
        self.assertIn("existing.slice(desiredCount).forEach", placeholder_sync)
        self.assertIn("missingCount", placeholder_sync)

        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            {self._function_source("renderLiveBrowserPlaceholder")}
            {placeholder_sync}
            {card_insert}

            const first = {{ removed: false, remove() {{ this.removed = true; }} }};
            const second = {{ removed: false, remove() {{ this.removed = true; }} }};
            const grid = {{
              placeholders: [first],
              inserted: "",
              querySelectorAll() {{ return this.placeholders.filter((node) => !node.removed); }},
              insertAdjacentHTML(_position, markup) {{ this.inserted += markup; }},
            }};

            syncLiveBrowserPlaceholders(grid, 1);
            assert.strictEqual(first.removed, false);
            assert.strictEqual(grid.inserted, "");

            grid.placeholders.push(second);
            syncLiveBrowserPlaceholders(grid, 1);
            assert.strictEqual(first.removed, false);
            assert.strictEqual(second.removed, true);

            syncLiveBrowserPlaceholders(grid, 2);
            assert.strictEqual(first.removed, true);

            const overflowPlaceholder = {{ removed: false, remove() {{ this.removed = true; }} }};
            grid.placeholders = [overflowPlaceholder];
            syncLiveBrowserPlaceholders(grid, 3);
            assert.strictEqual(overflowPlaceholder.removed, true);

            grid.placeholders = [];
            syncLiveBrowserPlaceholders(grid, 0);
            assert.strictEqual((grid.inserted.match(/data-live-browser-placeholder/g) || []).length, 2);

            const placeholder = {{ kind: "placeholder" }};
            const card = {{ kind: "session" }};
            const orderedGrid = {{
              children: [placeholder],
              querySelector() {{ return this.children.find((node) => node.kind === "placeholder") || null; }},
              insertBefore(node, anchor) {{
                const index = anchor ? this.children.indexOf(anchor) : this.children.length;
                this.children.splice(index, 0, node);
              }},
            }};
            insertLiveBrowserSessionCard(orderedGrid, card);
            assert.deepStrictEqual(orderedGrid.children, [card, placeholder]);
            """
        )
        self._run_node(harness)

    def test_live_browser_grid_uses_container_width_and_mobile_fallback(self):
        desktop_selector = (
            '.account-browser-page[data-account-browser-page="browsers"] '
            '.live-browser-panel[data-live-browser-view="grid"] .live-browser-grid'
        )
        container_rule = self._css_block(
            '.account-browser-page[data-account-browser-page="browsers"] .live-browser-panel {'
        )
        desktop_rule = self._css_block(desktop_selector)
        wide_container_marker = "@container account-live-browser (min-width: 941px)"
        wide_container_start = self.styles.index(wide_container_marker)
        wide_container = self._css_block(wide_container_marker)
        wide_rule = self._css_block(desktop_selector, wide_container_start)
        compact_container = self._css_block("@container account-live-browser (max-width: 520px)")
        mobile_rule_start = self.styles.rindex(desktop_selector)
        mobile_media_start = self.styles.rfind("@media (max-width: 760px)", 0, mobile_rule_start)
        mobile_media = self._css_block("@media (max-width: 760px)", mobile_media_start)
        mobile_rule = self._css_block(desktop_selector, mobile_rule_start)
        mobile_controls_start = self.styles.index(
            "@media (max-width: 760px)",
            self.styles.index(".live-browser-card-actions .live-browser-mode-toggle button:not"),
        )
        mobile_controls = self._css_block("@media (max-width: 760px)", mobile_controls_start)

        self.assertIn("container: account-live-browser / inline-size;", container_rule)
        self.assertIn("grid-template-columns: minmax(0, 1fr);", desktop_rule)
        self.assertIn(wide_rule, wide_container)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr));", wide_rule)
        self.assertIn(".live-browser-card-head", compact_container)
        self.assertIn("flex-direction: column;", compact_container)
        self.assertIn(".live-browser-card-actions", compact_container)
        self.assertIn("justify-content: flex-start;", compact_container)
        self.assertIn(mobile_rule, mobile_media)
        self.assertIn("grid-template-columns: 1fr;", mobile_rule)
        self.assertIn(".live-browser-card-head", mobile_controls)
        self.assertIn("flex-direction: column;", mobile_controls)
        self.assertIn(".live-browser-card-actions", mobile_controls)
        self.assertIn("justify-content: flex-start;", mobile_controls)

    def test_public_toast_uses_bottom_wide_layout(self):
        host = self._css_block(".toast-host {")
        message = self._css_block(".toast-message {")
        slide = self._css_block("@keyframes toastSlideIn")

        self.assertIn("left: 50%;", host)
        self.assertIn("bottom: 22px;", host)
        self.assertIn("width: min(560px, calc(100vw - 32px));", host)
        self.assertIn("transform: translateX(-50%);", host)
        self.assertNotIn("top: 16px;", host)
        self.assertNotIn("right: 16px;", host)
        self.assertIn("min-height: 64px;", message)
        self.assertIn("padding: 18px 12px 18px 20px;", message)
        self.assertIn("border: 2px solid var(--line);", message)
        self.assertIn("transform: translateY(18px);", slide)

    def test_status_tone_covers_live_detection_and_recovery_states(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            {self._function_source("statusLabel")}
            {self._function_source("statusTone")}
            {self._function_source("accountStatusClassNames")}
            assert.strictEqual(statusTone("ready"), "success");
            assert.strictEqual(statusTone("pending_login"), "manual");
            assert.strictEqual(statusTone("account_confirmation_required"), "manual");
            assert.strictEqual(statusTone("cookie_expired"), "error");
            assert.strictEqual(statusTone("checking"), "active");
            assert.strictEqual(statusTone("browser_launch"), "active");
            assert.strictEqual(statusTone("preparing"), "active");
            assert.strictEqual(statusTone("login_wait_timeout"), "error");
            assert.strictEqual(statusTone("disabled"), "muted");
            assert.strictEqual(statusLabel("need_verification"), "需验证");
            assert.strictEqual(statusLabel("account_confirmation_required"), "需确认关联账号");
            assert.strictEqual(accountStatusClassNames("account_confirmation_required"), "account_confirmation_required need_verification");
            assert.strictEqual(statusLabel("preparing"), "准备执行");
            """
        )
        self._run_node(harness)

    def test_status_badges_have_distinct_semantic_color_groups(self):
        for variable in (
            "--status-success-bg",
            "--status-error-bg",
            "--status-queued-bg",
            "--status-manual-bg",
            "--status-running-bg",
            "--status-muted-bg",
        ):
            self.assertIn(variable, self.styles)

        for selector in (
            ".status.pending_login",
            ".status.need_verification",
            ".status.cookie_expired",
            ".status.transient_error",
            ".status.checking",
            ".status.disabled",
        ):
            self.assertIn(selector, self.styles)

        task_rows = self.styles[
            self.styles.index(".task-row .task-status-text.is-success"):
            self.styles.index(".status.success")
        ]
        self.assertIn("background: var(--status-running-bg)", task_rows)
        self.assertIn("color: var(--status-running-ink)", task_rows)

    def test_account_pool_bind_replaces_existing_persona_binding_in_one_action(self):
        bind_account = self._function_source("bindAccountPoolAccountToPersona")

        self.assertIn("replace_existing_binding: true", bind_account)
        self.assertNotIn("请先解绑原账号", bind_account)
        self.assertIn("if (state.accountPoolBinding) return", bind_account)
        self.assertIn("state.accountPoolBinding = true", bind_account)
        self.assertIn("state.accountPoolBinding = false", bind_account)

    def test_customer_persona_generation_does_not_read_admin_runtime_config(self):
        preflight = self._function_source("personaGeneratePreflight")
        self.assertIn("!state.currentUser?.is_admin", preflight)
        self.assertIn("return { ready: true, issues: [] }", preflight)

    def test_open_login_uses_saved_credentials_and_expired_toasts_are_not_revived(self):
        create_task = self._function_source("createSocialTask")
        toast = self._section("function showToast", "function defaultToastTargetForMessage")
        self.assertIn('auto_submit: taskType === "open_login" ? Boolean(selected?.login_password_configured) : undefined', create_task)
        self.assertIn("refreshLiveBrowserSessionsSoon", create_task)
        self.assertIn('existingToast.classList.contains("is-leaving")', toast)
        refresh_start = toast.index("if (isTaskRefresh)")
        refresh_end = toast.index("pendingToastRequest = request", refresh_start)
        self.assertNotIn("clearToastRemovalTimer", toast[refresh_start:refresh_end])
        self.assertNotIn("applyToastMeta(existingToast", toast[refresh_start:refresh_end])
        self.assertIn("keep the existing DOM and class", toast[refresh_start:refresh_end])

    def test_manual_takeover_waits_for_backend_ack_and_keeps_task_refresh_active(self):
        set_mode = self._section("async function setLiveBrowserMode", "function liveBrowserToolInput")
        prompt_suppression = self._function_source("socialTaskPromptSuppressed")
        active_refresh = self._function_source("hasActiveSocialTaskToast")

        self.assertIn('result?.acknowledged ? "manual" : "switching"', set_mode)
        self.assertIn("Boolean(result?.acknowledged)", set_mode)
        self.assertIn("refreshLiveBrowserSessionsSoon(taskId, 40, 500)", set_mode)
        self.assertIn("definitelyRejected", set_mode)
        self.assertLess(set_mode.index("suppressedSocialTaskPromptIds.add"), set_mode.index("await api("))
        self.assertIn("suppressedSocialTaskPromptIds", prompt_suppression)
        self.assertNotIn("socialBrowserSessions", prompt_suppression)
        self.assertNotIn("socialTaskPromptSuppressed", active_refresh)
        browser_refresh = self._function_source("refreshLiveBrowserSessionsSoon")
        self.assertIn('liveBrowserLoginMode(matched) === "switching"', browser_refresh)
        self.assertIn("found && !takeoverPending", browser_refresh)
        self.assertNotIn("automaticLoginActive", browser_refresh)
        self.assertIn("refreshLiveBrowserSessionsOnly", browser_refresh)
        self.assertIn("liveBrowserRefreshTokens[refreshKey]", browser_refresh)
        self.assertIn('matched.login_mode = "takeover_timeout"', browser_refresh)
        self.assertIn("observedTarget || taskFinished", browser_refresh)
        self.assertIn('["success", "failed", "cancelled"]', prompt_suppression)

    def test_browser_session_refreshes_are_isolated_and_timeout_safely(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const state = {{ socialBrowserSessions: [], liveBrowserRefreshTokens: {{}} }};
            const callbacks = [];
            const window = {{ setTimeout(callback) {{ callbacks.push(callback); }} }};
            async function refreshLiveBrowserSessionsOnly() {{}}
            function liveBrowserLoginMode(session) {{ return session.login_mode || "automatic"; }}
            function liveBrowserTaskStatus(session) {{ return session.task_status || session.status || "running"; }}
            function renderLiveBrowserSessions() {{}}
            function showMsg() {{}}
            {self._function_source("refreshLiveBrowserSessionsSoon")}

            (async () => {{
              refreshLiveBrowserSessionsSoon("task-a", 1, 1);
              refreshLiveBrowserSessionsSoon("task-b", 1, 1);
              assert.strictEqual(Object.keys(state.liveBrowserRefreshTokens).length, 2);
              state.socialBrowserSessions = [{{ task_id: "task-a", login_mode: "switching", input_allowed: false }}];
              await callbacks.shift()();
              assert.strictEqual(state.socialBrowserSessions[0].login_mode, "takeover_timeout");
              assert.ok(!state.liveBrowserRefreshTokens["task-a"]);
              assert.ok(state.liveBrowserRefreshTokens["task-b"]);

              state.socialBrowserSessions = [{{ task_id: "task-gone", login_mode: "switching" }}];
              refreshLiveBrowserSessionsSoon("task-gone", 10, 1);
              state.socialBrowserSessions = [];
              await callbacks.pop()();
              assert.ok(!state.liveBrowserRefreshTokens["task-gone"]);

              callbacks.length = 0;
              state.socialBrowserSessions = [{{ task_id: "task-auto", task_type: "open_login", task_status: "running", login_mode: "automatic" }}];
              refreshLiveBrowserSessionsSoon("task-auto", 1, 1);
              await callbacks.pop()();
              assert.ok(!state.liveBrowserRefreshTokens["task-auto"]);
              assert.strictEqual(callbacks.length, 0);
            }})().catch((error) => {{ console.error(error); process.exit(1); }});
            """
        )
        self._run_node(harness)

    def test_manual_takeover_button_is_available_for_every_active_login_session(self):
        render_toggle = self._function_source("renderLiveBrowserModeToggle")
        update_card = self._function_source("updateLiveBrowserSessionCard")

        self.assertIn('["running", "need_manual"].includes', render_toggle)
        self.assertNotIn("browserReady", render_toggle)
        self.assertIn('button.disabled = !sessionId || !["running", "need_manual"].includes(status)', update_card)
        self.assertNotIn('status !== "running"', update_card)

        set_mode = self._function_source("setLiveBrowserMode")
        self.assertIn('liveBrowserLoginMode(session) === "manual" && Boolean(session.input_allowed)', set_mode)

    def test_account_browser_actions_bind_to_the_owning_shell(self):
        bind_events = self._function_source("bindEvents")

        for event_name in ("click", "keydown", "input", "change"):
            self.assertIn(
                f'if ($("accountBrowserShell")) $("accountBrowserShell").addEventListener("{event_name}", (event) => {{',
                bind_events,
            )
        self.assertIn('const liveBrowserMode = event.target.closest("[data-live-browser-mode]")', bind_events)

    def test_account_pool_visible_checkbox_uses_the_multi_select_path(self):
        bind_events = self._function_source("bindEvents")
        account_events = bind_events[
            bind_events.index('if ($("accountBrowserShell")) $("accountBrowserShell").addEventListener("click"'):
            bind_events.index('if ($("accountBrowserShell")) $("accountBrowserShell").addEventListener("keydown"')
        ]

        self.assertIn('const accountCheckTarget = event.target.closest(".account-pool-card-check")', account_events)
        self.assertIn('accountCheckTarget.querySelector("[data-account-pool-check]")', account_events)
        self.assertIn("event.preventDefault()", account_events)
        self.assertIn(".account-pool-card-check", account_events)

    def test_account_proxy_picker_replaces_legacy_edit_checkbox_and_keeps_single_binding(self):
        card = self._section("function renderAccountPoolCard", "function renderAccountPoolCards")
        picker = self._function_source("openAccountProxyPickerModal")
        modal = self._function_source("openAccountPoolEditModal")
        save = self._function_source("saveAccountPoolEditForm")
        clear_password = self._function_source("clearAccountPasswordReveal")

        self.assertIn('data-account-proxy-picker="${esc(accountId)}"', card)
        self.assertIn("accountProxyOptionCardsHtml(account.proxy_id", picker)
        self.assertIn("saveAccountProxyBinding", picker)
        self.assertIn('modal.dataset.originalProxyId = String(account.proxy_id || "").trim()', picker)
        self.assertIn('modal.dataset.accountProxyDirty = "false"', picker)
        self.assertIn('if (modal.dataset.accountProxyDirty !== "true")', picker)
        self.assertIn("reconcileAccountProxyBindingConflict", picker)
        self.assertIn('modal.dataset.selectedProxyId = String(account.proxy_id || "").trim()', modal)
        self.assertIn('modal.dataset.originalProxyId = String(account.proxy_id || "").trim()', modal)
        self.assertIn("renderAccountProxyPickerPanel(account)", modal)
        self.assertIn('event.target.closest("[data-account-proxy-choice]")', modal)
        self.assertNotIn('accountResidentialProxyFormHtml("accountPoolEdit"', modal)
        self.assertIn('clearAccountPasswordReveal(account.id, "pool-edit")', modal)
        self.assertIn("delete state.accountPasswordValues[cleanId]", clear_password)
        self.assertIn("delete state.accountPasswordVisible[accountPasswordStateKey(cleanId, scope)]", clear_password)
        self.assertIn('const selectedProxyId = String(editModal?.dataset.selectedProxyId || "").trim()', save)
        self.assertIn("accountProxyBindingChanged(originalProxyId, selectedProxyId)", save)
        self.assertIn("payload.expected_proxy_id = originalProxyId", save)
        self.assertIn("payload.proxy_id = selectedProxyId", save)
        self.assertIn("payload.clear_residential_proxy = true", save)
        self.assertNotIn("payload.residential_proxy", save)

    def test_account_proxy_picker_matches_backend_eligibility_and_tracks_real_changes(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            function proxyStatusLabel(value = "") {{
              return {{ active: "正常", inactive: "停用", pending: "待检测", failed: "异常" }}[String(value || "").toLowerCase()] || String(value || "");
            }}
            {self._function_source("accountProxyEligibility")}
            {self._function_source("accountProxyBindingChanged")}

            const now = 2000;
            const valid = {{ ip_type: "static_residential", expires_at: 3000, status: "active", last_check_at: 1900, last_check_result: {{ ok: true }} }};
            assert.deepStrictEqual(accountProxyEligibility(null, now), {{ eligible: true, reason: "" }});
            assert.strictEqual(accountProxyEligibility(valid, now).eligible, true);
            assert.strictEqual(accountProxyEligibility({{ ...valid, ip_type: "datacenter" }}, now).reason, "仅支持静态住宅 IP");
            assert.strictEqual(accountProxyEligibility({{ ...valid, expires_at: now }}, now).reason, "已过期");
            assert.strictEqual(accountProxyEligibility({{ ...valid, status: "inactive" }}, now).eligible, false);
            assert.strictEqual(accountProxyEligibility({{ ...valid, last_check_at: 0 }}, now).reason, "未通过网络检测");
            assert.strictEqual(accountProxyEligibility({{ ...valid, last_check_result: {{ ok: false }} }}, now).eligible, false);
            assert.strictEqual(accountProxyBindingChanged("proxy-a", "proxy-a"), false);
            assert.strictEqual(accountProxyBindingChanged("proxy-a", "proxy-b"), true);
            assert.strictEqual(accountProxyBindingChanged("", ""), false);
            """
        )
        self._run_node(harness)

        options = self._section("function accountProxyOptionCardsHtml", "function updateAccountProxyChoice")
        status_refresh = self._function_source("updateAccountStatusViews")
        binding_save = self._function_source("saveAccountProxyBinding")
        self.assertIn("accountProxyEligibility(proxy)", options)
        self.assertIn('disabled aria-disabled=\\"true\\"', options)
        self.assertIn("data-account-proxy-options", options)
        self.assertIn("[data-account-proxy-for]", status_refresh)
        self.assertIn("[data-account-proxy-picker]", status_refresh)
        self.assertIn("expected_proxy_id", binding_save)

        reconcile = self._function_source("reconcileAccountProxyBindingConflict")
        self.assertIn("fetchSocialDataShared({ force: true })", reconcile)
        self.assertIn("accountProxyBindingChanged(originalProxyId, latestProxyId)", reconcile)
        self.assertIn("accountProxyOptionCardsHtml(latestProxyId", reconcile)
        self.assertIn("modal.dataset.originalProxyId = latestProxyId", reconcile)

    def test_pageshow_and_focus_share_identity_revalidation(self):
        revalidation = self._section("async function revalidateConsoleIdentity()", "async function loadSetupStatus()")
        self.assertIn('api("/api/me")', revalidation)
        self.assertLess(revalidation.index("maskConsoleForIdentityRevalidation()"), revalidation.index('api("/api/me")'))
        self.assertIn("unmaskConsoleAfterIdentityRevalidation()", revalidation)
        self.assertIn("consoleUserId(me.id) !== expectedUserId", revalidation)
        self.assertIn("reloadForIdentityChange()", revalidation)
        self.assertIn("handleSessionBoundary(428)", revalidation)
        catch_branch = revalidation[revalidation.index(".catch((error)") :]
        self.assertNotIn("unmaskConsoleAfterIdentityRevalidation()", catch_branch)

        event_binding = self._section("function bindIdentityRevalidationEvents()", "async function init()")
        self.assertIn('window.addEventListener("pageshow"', event_binding)
        self.assertIn('window.addEventListener("focus"', event_binding)
        self.assertGreaterEqual(event_binding.count("revalidateConsoleIdentity()"), 2)

    def test_identity_revalidation_only_unmasks_for_same_identity_success(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const state = {{ currentUser: {{ id: "7", username: "old" }} }};
            const document = {{
              documentElement: {{ hidden: false }},
              getElementById() {{ return null; }},
            }};
            const window = {{ location: {{ reload() {{ reloads += 1; }} }} }};
            let consoleIdentityReady = true;
            let consoleBoundaryNavigationActive = false;
            let identityRevalidationPromise = null;
            let reloads = 0;
            let redirects = [];
            let warnings = 0;
            let apiImpl;
            const $ = () => null;
            const api = (...args) => apiImpl(...args);
            const appendEvent = () => {{ warnings += 1; }};
            function handleSessionBoundary(status) {{
              if (![401, 428].includes(Number(status))) return false;
              consoleBoundaryNavigationActive = true;
              redirects.push(Number(status));
              return true;
            }}
            function clearTenantInMemoryState() {{}}
            {self._function_source("consoleUserId")}
            {self._function_source("maskConsoleForIdentityRevalidation")}
            {self._function_source("unmaskConsoleAfterIdentityRevalidation")}
            {self._function_source("reloadForIdentityChange")}
            {self._function_source("revalidateConsoleIdentity")}

            (async () => {{
              apiImpl = async () => ({{ id: 7, username: "same" }});
              const samePromise = revalidateConsoleIdentity();
              assert.strictEqual(document.documentElement.hidden, true);
              await samePromise;
              assert.strictEqual(document.documentElement.hidden, false);
              assert.strictEqual(state.currentUser.username, "same");

              apiImpl = async () => ({{ id: 8, username: "other" }});
              const changedPromise = revalidateConsoleIdentity();
              assert.strictEqual(document.documentElement.hidden, true);
              await changedPromise;
              assert.strictEqual(document.documentElement.hidden, true);
              assert.strictEqual(reloads, 1);

              consoleBoundaryNavigationActive = false;
              document.documentElement.hidden = false;
              state.currentUser = {{ id: "7", username: "old" }};
              apiImpl = async () => {{ throw {{ status: 500, detail: "down" }}; }};
              await revalidateConsoleIdentity();
              assert.strictEqual(document.documentElement.hidden, true);
              assert.strictEqual(warnings, 1);

              document.documentElement.hidden = false;
              apiImpl = async () => {{ throw new TypeError("network"); }};
              await revalidateConsoleIdentity();
              assert.strictEqual(document.documentElement.hidden, true);
              assert.strictEqual(warnings, 2);

              document.documentElement.hidden = false;
              apiImpl = async () => {{
                handleSessionBoundary(401);
                throw {{ status: 401 }};
              }};
              await revalidateConsoleIdentity();
              assert.strictEqual(document.documentElement.hidden, true);
              assert.deepStrictEqual(redirects, [401]);

              consoleBoundaryNavigationActive = false;
              document.documentElement.hidden = false;
              apiImpl = async () => ({{ id: 7, must_change_password: true }});
              await revalidateConsoleIdentity();
              assert.strictEqual(document.documentElement.hidden, true);
              assert.deepStrictEqual(redirects, [401, 428]);
            }})().catch((error) => {{
              console.error(error);
              process.exitCode = 1;
            }});
            """
        )
        self._run_node(harness)

    def test_console_javascript_syntax(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        result = subprocess.run(
            [node, "--check", str(CONSOLE_JS)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=20,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_console_settings_use_user_browser_policy_endpoints_and_keep_pagination_local(self):
        render = self._function_source("renderConsoleSettingsPage")
        save = self._function_source("saveConsoleSettingsPage")
        load = self._function_source("loadBrowserPolicySettings")
        auto_configure = self._function_source("autoConfigureBrowserPreferences")

        for field in (
            "completion_policy",
            "standby_seconds",
            "auto_close_seconds",
            "manual_timeout_seconds",
            "requested_concurrency",
            "text_input_mode",
        ):
            self.assertIn(field, render)
        self.assertIn("review_hold_seconds", self._function_source("normalizeBrowserPreferences"))
        self.assertIn("仅供检查，不提升速度", render)
        self.assertIn("resource_level", self._function_source("renderBrowserRecommendationCard"))
        self.assertIn("effective_limits", self._function_source("renderBrowserRecommendationCard"))
        self.assertIn('api("/api/persona_dashboard/automation/browser_preferences", {', save)
        self.assertIn('method: "PUT"', save)
        self.assertIn('api("/api/persona_dashboard/automation/browser_preferences")', load)
        self.assertIn('api("/api/persona_dashboard/automation/browser_recommendation")', load)
        self.assertIn('api("/api/persona_dashboard/automation/browser_preferences/auto_configure"', auto_configure)
        self.assertIn('method: "POST"', auto_configure)
        self.assertIn("PERSONA_LIST_PAGE_SIZE_KEY", save)
        self.assertNotIn("LIVE_BROWSER_", save)
        self.assertNotIn("browser_settings", self.source)

    def test_browser_preferences_normalize_server_payload_for_policy_controls(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            {self._function_source("normalizeBrowserPreferences")}
            {self._function_source("browserPreferencesResponseValue")}

            assert.deepStrictEqual(
              browserPreferencesResponseValue({{ preferences: {{
                completion_policy: "review_hold",
                review_hold_seconds: 999,
                standby_seconds: 120,
                auto_close_seconds: 7200,
                manual_timeout_seconds: 600,
                requested_concurrency: 0,
                text_input_mode: "type",
              }} }}),
              {{
                completion_policy: "review_hold",
                review_hold_seconds: 300,
                standby_seconds: 120,
                auto_close_seconds: 7200,
                manual_timeout_seconds: 600,
                requested_concurrency: 1,
                text_input_mode: "type",
              }},
            );
            assert.deepStrictEqual(
              normalizeBrowserPreferences({{
                completion_policy: "unknown",
                review_hold_seconds: 1,
                standby_seconds: 9999,
                auto_close_seconds: 1,
                manual_timeout_seconds: 750,
                requested_concurrency: 99,
                text_input_mode: "unknown",
              }}),
              {{
                completion_policy: "immediate_close",
                review_hold_seconds: 10,
                standby_seconds: 3600,
                auto_close_seconds: 10,
                manual_timeout_seconds: 750,
                requested_concurrency: 12,
                text_input_mode: "paste",
              }},
            );
            """
        )
        self._run_node(harness)

    def test_browser_duration_controls_support_presets_and_custom_seconds(self):
        render = self._function_source("renderConsoleSettingsPage")
        update = self._function_source("updateBrowserPreferencesDraft")
        sync = self._section("function syncBrowserDurationCustomField", "function browserPreferencesResponseValue")
        options = self._function_source("browserDurationOptions")

        self.assertIn('value="custom"', options)
        self.assertIn("自定义时间", options)
        self.assertIn("settingsBrowserStandbyCustomSeconds", render)
        self.assertIn("settingsBrowserAutoCloseCustomSeconds", render)
        self.assertIn("settingsManualTimeoutCustomSeconds", render)
        self.assertIn('min="0" max="3600"', render)
        self.assertIn('min="10" max="86400"', render)
        self.assertIn('min="300" max="1800"', render)
        self.assertIn("browserDurationValue", update)
        self.assertIn("wrapper.hidden = !usesCustom", sync)
        self.assertIn("input.focus()", sync)
        self.assertIn("browserDurationDrafts", self.source)
        self.assertIn("invalidDurationInput", self._function_source("saveConsoleSettingsPage"))

    def test_browser_recommendation_adapts_split_server_payload(self):
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            {self._function_source("browserRecommendationResponseValue")}

            assert.deepStrictEqual(
              browserRecommendationResponseValue({{
                environment: {{ resource_level: "limited", summary: "2 核 CPU" }},
                recommended: {{ requested_concurrency: 2, manual_timeout_seconds: 900 }},
                reasons: ["优先释放资源"],
                limits: {{ global_max_concurrency: 2 }},
              }}),
              {{
                resource_level: "limited",
                summary: "2 核 CPU",
                recommended: {{ requested_concurrency: 2, manual_timeout_seconds: 900 }},
                reasons: ["优先释放资源"],
                limits: {{
                  recommended_concurrency: 2,
                  global_max_concurrency: 2,
                  manual_timeout_minutes: 15,
                }},
              }},
            );
            """
        )
        self._run_node(harness)

    def test_proxy_auto_detection_falls_back_and_autofills_editable_fields(self):
        helper_source = "\n".join(
            [
                self._section("function proxyNameCanAutofill", "async function testProxyConfiguration"),
                self._section("async function testProxyConfiguration", "async function testProxyForm"),
            ]
        )
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            const fields = {{
              proxyFormProtocol: {{ value: "auto" }},
              proxyFormName: {{ value: "" }},
            }};
            const calls = [];
            let rendered = null;
            function $(id) {{ return fields[id] || null; }}
            function proxyCheckRequestPayload(payload) {{ return payload; }}
            function renderProxyCheckResult(_target, result) {{ rendered = result; }}
            async function api(_url, options) {{
              const payload = JSON.parse(options.body);
              calls.push(payload.proxy_type);
              if (payload.proxy_type === "http") return {{ result: {{ ok: false, error: "wrong protocol" }} }};
              return {{ result: {{
                ok: true,
                exit_ip: "194.143.193.241",
                response: {{ ip: "194.143.193.241", country_code: "ES", city: "Zaragoza" }},
              }} }};
            }}
            {helper_source}
            (async () => {{
              const payload = {{ proxy_type: "auto", host: "194.143.193.241", port: 8022, name: "" }};
              const result = await testProxyConfiguration(payload, "", "result", "proxyForm");
              assert.deepStrictEqual(calls, ["http", "socks5"]);
              assert.strictEqual(result.ok, true);
              assert.strictEqual(result.detected_proxy_type, "socks5");
              assert.strictEqual(payload.proxy_type, "socks5");
              assert.strictEqual(fields.proxyFormProtocol.value, "socks5");
              assert.strictEqual(fields.proxyFormName.value, "[静态住宅] ES · Zaragoza · 194.143.193.241");
              assert.strictEqual(payload.name, fields.proxyFormName.value);
              assert.strictEqual(rendered, result);
            }})().catch((error) => {{
              console.error(error);
              process.exitCode = 1;
            }});
            """
        )
        self._run_node(harness)

    def test_proxy_detection_preserves_manual_name_and_keeps_metadata_in_preview(self):
        self.assertIn('["auto", "自动检测（推荐）"]', self.source)
        self.assertNotIn('id="${esc(prefix)}Country"', self.source)
        helper_source = self._section("function proxyNameCanAutofill", "function applyProxyDetectionAutofill")
        harness = textwrap.dedent(
            f"""
            const assert = require("assert");
            {helper_source}
            const payload = {{ host: "proxy.example.com", port: 1080 }};
            assert.strictEqual(proxyNameCanAutofill("", payload), true);
            assert.strictEqual(proxyNameCanAutofill("socks5://proxy.example.com:1080", payload), true);
            assert.strictEqual(proxyNameCanAutofill("西班牙主账号代理", payload), false);
            """
        )
        self._run_node(harness)


if __name__ == "__main__":
    unittest.main()
