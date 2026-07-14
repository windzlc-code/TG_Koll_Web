import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = REPO_ROOT / "webapp" / "static" / "assets" / "console.js"


class ConsoleSessionBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = CONSOLE_JS.read_text(encoding="utf-8")

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
        self.assertIn('loadAutomationTasksShared().catch', task_refresh)
        self.assertNotIn("loadAutomationTasksShared({ force: true })", task_refresh)

    def test_customer_persona_generation_does_not_read_admin_runtime_config(self):
        preflight = self._function_source("personaGeneratePreflight")
        self.assertIn("!state.currentUser?.is_admin", preflight)
        self.assertIn("return { ready: true, issues: [] }", preflight)

    def test_open_login_defaults_to_automatic_and_expired_toasts_are_not_revived(self):
        create_task = self._function_source("createSocialTask")
        toast = self._section("function showToast", "function defaultToastTargetForMessage")
        self.assertIn('auto_submit: taskType === "open_login" ? true : undefined', create_task)
        self.assertIn("refreshLiveBrowserSessionsSoon", create_task)
        self.assertIn('existingToast.classList.contains("is-leaving")', toast)
        refresh_start = toast.index("if (isTaskRefresh)")
        refresh_end = toast.index("return existingToast;", refresh_start)
        self.assertNotIn("clearToastRemovalTimer", toast[refresh_start:refresh_end])

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
        self.assertIn("automaticLoginActive", browser_refresh)
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

              state.socialBrowserSessions = [{{ task_id: "task-auto", task_type: "open_login", task_status: "running", login_mode: "automatic" }}];
              refreshLiveBrowserSessionsSoon("task-auto", 1, 1);
              await callbacks.pop()();
              assert.ok(state.liveBrowserRefreshTokens["task-auto"]);
              assert.ok(callbacks.length > 0);
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

    def test_live_browser_actions_bind_to_the_stable_module_root(self):
        bind_events = self._function_source("bindEvents")

        self.assertIn('$("moduleBody").addEventListener("click", (event) => {', bind_events)
        self.assertNotIn(
            'if ($("accountBrowserShell")) $("accountBrowserShell").addEventListener("click", (event) => {',
            bind_events,
        )
        self.assertIn('const liveBrowserMode = event.target.closest("[data-live-browser-mode]")', bind_events)

    def test_account_edit_does_not_resubmit_unchanged_proxy_and_clears_revealed_password(self):
        modal = self._function_source("openAccountPoolEditModal")
        save = self._function_source("saveAccountPoolEditForm")
        clear_password = self._function_source("clearAccountPasswordReveal")

        self.assertIn('modal.dataset.accountProxyDirty = "false"', modal)
        self.assertIn('modal.dataset.accountProxyDirty = "true"', modal)
        self.assertIn('clearAccountPasswordReveal(account.id, "pool-edit")', modal)
        self.assertIn("delete state.accountPasswordValues[cleanId]", clear_password)
        self.assertIn("delete state.accountPasswordVisible[accountPasswordStateKey(cleanId, scope)]", clear_password)
        self.assertIn('const proxyFieldsDirty = $("consoleModal")?.dataset.accountProxyDirty === "true"', save)
        self.assertIn("if (proxyEnabled && (proxyFieldsDirty || !existingProxy))", save)
        self.assertNotIn(
            'const residentialProxy = accountResidentialProxyPayload("accountPoolEdit", username, accountResidentialProxy(account))',
            save,
        )

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
