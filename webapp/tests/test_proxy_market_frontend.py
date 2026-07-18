import json
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADMIN_JS = ROOT / "static" / "assets" / "admin.js"
ADMIN_HTML = ROOT / "static" / "admin.html"


class ProxyMarketFrontendTests(unittest.TestCase):
    def test_admin_proxy_market_actions_are_split_and_labels_are_clear(self):
        html = ADMIN_HTML.read_text(encoding="utf-8")
        self.assertIn('id="btnInspectProxyMarketConnection"', html)
        self.assertIn("检测自动填写字段", html)
        self.assertIn('id="btnTestProxyMarketItem"', html)
        self.assertIn(">真实检测<", "".join(html.split()))
        self.assertIn('id="btnPublishProxyMarketItem"', html)
        self.assertIn(">发布<", "".join(html.split()))
        self.assertNotIn("检测并补全地区", html)
        self.assertNotIn("真实检测并发布", html)
        self.assertIn("socks5://user:password@198.51.100.27:8022", html)
        self.assertIn("198.51.100.27:8022:user:password", html)
        self.assertIn("direct.provider.example:8001:user:password", html)
        self.assertIn('rows="6"', html)
        self.assertIn("height: 136px", html)
        self.assertIn("min-height: 136px", html)
        self.assertIn("min-width: 248px", html)
        self.assertIn("flex-wrap: nowrap", html)
        self.assertIn("height: 36px", html)
        self.assertIn("height: 44px", html)
        source = ADMIN_JS.read_text(encoding="utf-8")
        self.assertIn('String(item.pending_check_status || "") === "healthy"', source)
        self.assertIn('actionRow.className = "proxy-market-table-actions"', source)

    def _run_node(self, body: str):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        source = ADMIN_JS.read_text(encoding="utf-8")
        start = source.index("const PROXY_MARKET_SMART_FIELD_ALIASES")
        end = source.index("function proxyMarketItemById", start)
        smart_source = source[start:end]
        harness = textwrap.dedent(
            f"""
            const assert = require("node:assert/strict");
            const vm = require("node:vm");

            const controls = new Map();
            const control = (id, value = "") => {{
              const node = {{ id, value: String(value), disabled: false, dataset: {{}}, textContent: "" }};
              controls.set(id, node);
              return node;
            }};
            [
              ["proxyMarketSmartInput", ""],
              ["proxyMarketSmartResult", ""],
              ["proxyMarketHost", "old.example"],
              ["proxyMarketPort", "8080"],
              ["proxyMarketProxyType", "socks5"],
              ["proxyMarketUsername", "saved-user"],
              ["proxyMarketPassword", "saved-password"],
              ["proxyMarketProviderKey", "provider-a"],
              ["proxyMarketSku", ""],
              ["proxyMarketDisplayName", ""],
              ["proxyMarketCountry", ""],
              ["proxyMarketRegion", ""],
              ["proxyMarketCity", ""],
              ["proxyMarketIsp", ""],
              ["btnInspectProxyMarketConnection", ""],
              ["btnCancelProxyMarketEdit", ""],
              ["btnSaveProxyMarketItem", ""],
              ["btnTestProxyMarketItem", ""],
              ["btnPublishProxyMarketItem", ""],
            ].forEach(([id, value]) => control(id, value));
            controls.set("proxyMarketItemForm", {{
              elements: [...controls.values()],
              reportValidity: () => true,
              reset: () => {{}},
            }});

            let apiImpl = async () => ({{}});
            let apiCalls = 0;
            const context = {{
              URL,
              console,
              setTimeout,
              clearTimeout,
              window: {{ setTimeout, clearTimeout }},
              adminState: {{
                proxyMarketSelectedItemId: null,
                proxyMarketInspectRequestId: 0,
                proxyMarketPendingCheckId: "",
                proxyMarketEditorBusy: false,
              }},
              el: (id) => controls.get(id) || null,
              setText: (id, value) => {{
                const node = controls.get(id);
                if (node) node.textContent = String(value || "");
              }},
              localInputFromTimestamp: (value) => String(value),
              api: async (...args) => {{
                apiCalls += 1;
                return apiImpl(...args);
              }},
              getErrorMessage: (error) => error?.message || String(error),
            }};
            vm.createContext(context);
            vm.runInContext({json.dumps(smart_source)}, context);

            async function main() {{
            {textwrap.indent(textwrap.dedent(body), "  ")}
            }}
            main().catch((error) => {{
              console.error(error);
              process.exitCode = 1;
            }});
            """
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            harness_path = Path(temp_dir) / "proxy-market-frontend-test.cjs"
            harness_path.write_text(harness, encoding="utf-8")
            result = subprocess.run(
                [node, str(harness_path)],
                cwd=ROOT.parent,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_smart_parser_is_atomic_and_preserves_structured_credentials(self):
        self._run_node(
            """
            const parse = context.parseProxyMarketSmartInput;
            const apply = context.applyProxyMarketSmartInput;

            const originalValues = Object.fromEntries(
              [...controls.entries()].map(([id, node]) => [id, node.value])
            );
            controls.get("proxyMarketSmartInput").value = '{"host":';
            assert.equal(apply(), null);
            assert.equal(controls.get("proxyMarketSmartInput").value, '{"host":');
            for (const id of [
              "proxyMarketHost", "proxyMarketPort", "proxyMarketProxyType",
              "proxyMarketUsername", "proxyMarketPassword", "proxyMarketSku",
              "proxyMarketDisplayName",
            ]) {
              assert.equal(controls.get(id).value, originalValues[id]);
            }

            const invalid = parse("host: new.example\\nport: 70000");
            assert.ok(invalid._errors.some((message) => message.includes("1-65535")));

            controls.get("proxyMarketSmartInput").value = "host: new.example\\nport: 70000";
            assert.equal(apply(), null);
            assert.equal(controls.get("proxyMarketHost").value, "old.example");
            assert.equal(controls.get("proxyMarketPort").value, "8080");

            controls.get("proxyMarketSmartInput").value = JSON.stringify({
              host: "json.example",
              port: 9000,
            });
            context.adminState.proxyMarketPendingCheckId = "proxy-check-stale";
            assert.ok(apply());
            assert.equal(context.adminState.proxyMarketPendingCheckId, "");
            assert.equal(controls.get("proxyMarketHost").value, "json.example");
            assert.equal(controls.get("proxyMarketPort").value, "9000");
            assert.equal(controls.get("proxyMarketUsername").value, "saved-user");
            assert.equal(controls.get("proxyMarketPassword").value, "saved-password");

            controls.get("proxyMarketSmartInput").value = "plain.example:9001";
            assert.ok(apply());
            assert.equal(controls.get("proxyMarketUsername").value, "");
            assert.equal(controls.get("proxyMarketPassword").value, "");

            controls.get("proxyMarketSku").value = "MANUAL-SKU";
            controls.get("proxyMarketSmartInput").value = "manual.example:9002";
            assert.ok(apply());
            assert.equal(controls.get("proxyMarketSku").value, "MANUAL-SKU");
            """
        )

    def test_original_proxy_input_formats_remain_supported(self):
        self._run_node(
            """
            const parse = context.parseProxyMarketSmartInput;

            const url = parse("socks5://old-user:old-pass@198.51.100.10:1080");
            assert.equal(url.proxy_type, "socks5");
            assert.equal(url.host, "198.51.100.10");
            assert.equal(url.port, 1080);
            assert.equal(url.username, "old-user");
            assert.equal(url.password, "old-pass");

            const fourPart = parse("198.51.100.11:8080:old-user:old-pass");
            assert.equal(fourPart.host, "198.51.100.11");
            assert.equal(fourPart.port, 8080);
            assert.equal(fourPart.username, "old-user");
            assert.equal(fourPart.password, "old-pass");

            const authFirst = parse("old-user:old-pass@proxy.example:9000");
            assert.equal(authFirst.host, "proxy.example");
            assert.equal(authFirst.port, 9000);
            assert.equal(authFirst.username, "old-user");
            assert.equal(authFirst.password, "old-pass");

            const pipeSeparated = parse("proxy.example|9001|old-user|old-pass");
            assert.equal(pipeSeparated.host, "proxy.example");
            assert.equal(pipeSeparated.port, 9001);
            assert.equal(pipeSeparated.username, "old-user");
            assert.equal(pipeSeparated.password, "old-pass");

            const noAuth = parse("proxy.example:9002");
            assert.equal(noAuth.host, "proxy.example");
            assert.equal(noAuth.port, 9002);
            assert.equal(noAuth.username, "");
            assert.equal(noAuth.password, "");

            const jsonInput = parse(JSON.stringify({
              protocol: "https",
              host: "json.example",
              port: 9443,
              username: "json-user",
              password: "json-pass",
            }));
            assert.equal(jsonInput.proxy_type, "https");
            assert.equal(jsonInput.host, "json.example");
            assert.equal(jsonInput.port, 9443);
            assert.equal(jsonInput.username, "json-user");
            assert.equal(jsonInput.password, "json-pass");

            const keyValue = parse([
              "协议: http",
              "主机: key-value.example",
              "端口: 8088",
              "用户名: key-user",
              "密码: key-pass",
            ].join("\\n"));
            assert.equal(keyValue.proxy_type, "http");
            assert.equal(keyValue.host, "key-value.example");
            assert.equal(keyValue.port, 8088);
            assert.equal(keyValue.username, "key-user");
            assert.equal(keyValue.password, "key-pass");
            """
        )

    def test_smart_parser_accepts_provider_endpoint_and_spanish_country_hint(self):
        self._run_node(
            """
            const parse = context.parseProxyMarketSmartInput;
            const apply = context.applyProxyMarketSmartInput;
            const screenshotInput = [
              "194.143.193.241:8022:qarqwsdxaw:oqymoyumoqymiyo",
              "",
              "direct.miyavip.vip:8001:qarqwsdxaw:oqymoyumoqymiyo",
              "西班牙",
            ].join("\\n");
            const parsed = parse(screenshotInput);

            assert.equal(parsed.host, "194.143.193.241");
            assert.equal(parsed.port, 8022);
            assert.equal(parsed.username, "qarqwsdxaw");
            assert.equal(parsed.password, "oqymoyumoqymiyo");
            assert.equal(parsed.provider_key, "miyavip");
            assert.equal(parsed.country, "ES");
            assert.equal(parsed._country_label, "西班牙");
            assert.deepEqual(parsed._errors || [], []);

            controls.get("proxyMarketSmartInput").value = screenshotInput;
            assert.ok(apply());
            assert.equal(controls.get("proxyMarketHost").value, "194.143.193.241");
            assert.equal(controls.get("proxyMarketPort").value, "8022");
            assert.equal(controls.get("proxyMarketProviderKey").value, "miyavip");
            assert.equal(controls.get("proxyMarketCountry").value, "ES");
            assert.equal(controls.get("proxyMarketSmartResult").dataset.state, "success");

            const labeledCountry = parse([
              "194.143.193.241：8022：qarqwsdxaw：oqymoyumoqymiyo",
              "国家 / 地区： España ",
            ].join("\\n"));
            assert.equal(labeledCountry.host, "194.143.193.241");
            assert.equal(labeledCountry.country, "ES");
            assert.deepEqual(labeledCountry._errors || [], []);

            const unknown = parse([
              "194.143.193.241:8022:qarqwsdxaw:oqymoyumoqymiyo",
              "",
              "",
              "不是有效地区",
            ].join("\\n"));
            assert.ok(unknown._errors.includes("第 4 行无法识别"));
            """
        )

    def test_original_proxy_input_formats_still_fill_editor_fields(self):
        self._run_node(
            """
            const apply = context.applyProxyMarketSmartInput;
            const cases = [
              {
                raw: "socks5://url-user:url-pass@198.51.100.20:1080",
                type: "socks5", host: "198.51.100.20", port: "1080",
                username: "url-user", password: "url-pass",
              },
              {
                raw: "198.51.100.21:8080:four-user:four-pass",
                type: "socks5", host: "198.51.100.21", port: "8080",
                username: "four-user", password: "four-pass",
              },
              {
                raw: "auth-user:auth-pass@proxy.example:9000",
                type: "socks5", host: "proxy.example", port: "9000",
                username: "auth-user", password: "auth-pass",
              },
              {
                raw: "pipe.example|9001|pipe-user|pipe-pass",
                type: "socks5", host: "pipe.example", port: "9001",
                username: "pipe-user", password: "pipe-pass",
              },
              {
                raw: JSON.stringify({
                  protocol: "https",
                  host: "json.example",
                  port: 9443,
                  username: "json-user",
                  password: "json-pass",
                }),
                type: "https", host: "json.example", port: "9443",
                username: "json-user", password: "json-pass",
              },
            ];

            for (const item of cases) {
              controls.get("proxyMarketSmartInput").value = item.raw;
              controls.get("proxyMarketSmartResult").textContent = "";
              context.adminState.proxyMarketPendingCheckId = "stale-check";
              assert.ok(apply(), item.raw);
              assert.equal(controls.get("proxyMarketProxyType").value, item.type);
              assert.equal(controls.get("proxyMarketHost").value, item.host);
              assert.equal(controls.get("proxyMarketPort").value, item.port);
              assert.equal(controls.get("proxyMarketUsername").value, item.username);
              assert.equal(controls.get("proxyMarketPassword").value, item.password);
              assert.equal(controls.get("proxyMarketSmartInput").value, "");
              assert.equal(context.adminState.proxyMarketPendingCheckId, "");
              assert.ok(!controls.get("proxyMarketSmartResult").textContent.includes(item.password));
            }
            """
        )

    def test_editor_publish_action_tracks_candidate_and_busy_state(self):
        self._run_node(
            """
            const sync = context.syncProxyMarketEditorActions;
            const invalidate = context.invalidateProxyMarketPendingCheck;
            context.adminState.proxyMarketSelectedItemId = "proxy-item-1";
            context.adminState.proxyMarketPendingCheckId = "";
            sync();
            assert.equal(controls.get("btnPublishProxyMarketItem").disabled, true);

            context.adminState.proxyMarketPendingCheckId = "proxy-check-1";
            sync();
            assert.equal(controls.get("btnPublishProxyMarketItem").disabled, false);

            context.setProxyMarketEditorBusy(true);
            assert.equal(controls.get("btnCancelProxyMarketEdit").disabled, true);
            assert.equal(controls.get("btnSaveProxyMarketItem").disabled, true);
            assert.equal(controls.get("btnTestProxyMarketItem").disabled, true);
            assert.equal(controls.get("btnPublishProxyMarketItem").disabled, true);
            assert.equal(controls.get("proxyMarketHost").disabled, true);

            context.setProxyMarketEditorBusy(false);
            assert.equal(controls.get("btnPublishProxyMarketItem").disabled, false);
            assert.equal(controls.get("proxyMarketHost").disabled, false);
            assert.equal(invalidate(), true);
            assert.equal(context.adminState.proxyMarketPendingCheckId, "");
            assert.equal(controls.get("btnPublishProxyMarketItem").disabled, true);
            """
        )

    def test_inspection_rejects_invalid_input_and_ignores_stale_response(self):
        self._run_node(
            """
            const inspect = context.inspectProxyMarketConnection;

            controls.get("proxyMarketSmartInput").value = "host: invalid.example\\nport: 99999";
            assert.equal(await inspect(), null);
            assert.equal(apiCalls, 0);
            assert.equal(controls.get("proxyMarketHost").value, "old.example");

            controls.get("proxyMarketSmartInput").value = "";
            let resolveRequest;
            apiImpl = () => new Promise((resolve) => { resolveRequest = resolve; });
            const pending = inspect();
            assert.equal(apiCalls, 1);
            controls.get("proxyMarketHost").value = "different.example";
            resolveRequest({
              check: {
                latency_ms: 20,
                detected: { country: "TW", city: "Taipei", isp: "Example ISP" },
              },
            });
            assert.equal(await pending, null);
            assert.equal(controls.get("proxyMarketCountry").value, "");
            assert.equal(controls.get("proxyMarketCity").value, "");
            assert.equal(controls.get("proxyMarketIsp").value, "");

            const pendingResolvers = [];
            apiImpl = () => new Promise((resolve) => pendingResolvers.push(resolve));
            controls.get("proxyMarketHost").value = "first.example";
            const first = inspect();
            controls.get("proxyMarketHost").value = "second.example";
            const second = inspect();
            pendingResolvers[1]({
              check: {
                latency_ms: 10,
                detected: { country: "JP", city: "Tokyo", isp: "Latest ISP" },
              },
            });
            assert.ok(await second);
            assert.equal(controls.get("proxyMarketCountry").value, "JP");
            assert.equal(controls.get("proxyMarketIsp").value, "Latest ISP");
            assert.equal(controls.get("btnInspectProxyMarketConnection").disabled, false);
            pendingResolvers[0]({
              check: {
                latency_ms: 99,
                detected: { country: "US", city: "Old City", isp: "Stale ISP" },
              },
            });
            assert.equal(await first, null);
            assert.equal(controls.get("proxyMarketCountry").value, "JP");
            assert.equal(controls.get("proxyMarketCity").value, "Tokyo");
            assert.equal(controls.get("proxyMarketIsp").value, "Latest ISP");
            assert.equal(controls.get("btnInspectProxyMarketConnection").disabled, false);
            """
        )

    def test_multiline_provider_format_fills_primary_endpoint_and_region(self):
        self._run_node(
            """
            const parse = context.parseProxyMarketSmartInput;
            const apply = context.applyProxyMarketSmartInput;
            const source = [
              "198.51.100.27:8022:fixture-user:fixture-password",
              "direct.provider.example:8001:fixture-user:fixture-password",
              "台湾",
            ].join("\\n");
            const parsed = parse(source);
            assert.deepEqual(parsed._errors, undefined);
            assert.equal(parsed.host, "198.51.100.27");
            assert.equal(parsed.port, 8022);
            assert.equal(parsed.username, "fixture-user");
            assert.equal(parsed.password, "fixture-password");
            assert.equal(parsed.country, "TW");
            assert.equal(parsed.provider_key, "provider");
            assert.equal(parsed._provider_endpoint_count, 1);

            controls.get("proxyMarketSmartInput").value = source;
            assert.ok(apply());
            assert.equal(controls.get("proxyMarketHost").value, "198.51.100.27");
            assert.equal(controls.get("proxyMarketPort").value, "8022");
            assert.equal(controls.get("proxyMarketCountry").value, "TW");
            assert.equal(controls.get("proxyMarketProviderKey").value, "provider");
            assert.equal(controls.get("proxyMarketDisplayName").value, "台湾静态住宅代理");
            assert.ok(!controls.get("proxyMarketSmartResult").textContent.includes("fixture-password"));

            const oldHost = controls.get("proxyMarketHost").value;
            controls.get("proxyMarketSmartInput").value = [
              "198.51.100.27:8022:user-a:pass-a",
              "direct.provider.example:8001:user-b:pass-b",
              "台湾",
            ].join("\\n");
            assert.equal(apply(), null);
            assert.equal(controls.get("proxyMarketHost").value, oldHost);
            assert.ok(controls.get("proxyMarketSmartInput").value.includes("pass-b"));
            """
        )

    def test_multiline_parser_rejects_ambiguous_primary_connections(self):
        self._run_node(
            """
            const parse = context.parseProxyMarketSmartInput;
            const multipleIps = parse([
              "198.51.100.27:8022:user:password",
              "198.51.100.28:8022:user:password",
              "台湾",
            ].join("\\n"));
            assert.ok(multipleIps._errors.some((message) => message.includes("多个 IP 主连接")));

            const multipleDomains = parse([
              "direct-a.example.com:8001:user:password",
              "direct-b.example.com:8001:user:password",
              "台湾",
            ].join("\\n"));
            assert.ok(multipleDomains._errors.some((message) => message.includes("多个域名连接")));
            """
        )

    def test_generated_sku_is_stable_bounded_and_connection_specific(self):
        self._run_node(
            """
            const sku = context.proxyMarketGeneratedSku;
            const base = sku("gateway.example", 1080, "socks5", "provider-a");
            assert.equal(base, sku("gateway.example", 1080, "socks5", "provider-a"));
            assert.notEqual(base, sku("gateway.example", 1080, "http", "provider-a"));
            assert.notEqual(base, sku("gateway.example", 1080, "socks5", "provider-b"));
            const longHost = "a".repeat(120) + ".example";
            const first = sku(longHost, 1080, "socks5", "");
            const second = sku(longHost, 1081, "socks5", "");
            assert.notEqual(first, second);
            assert.ok(first.length <= 80);
            assert.ok(first.includes("-1080-"));
            assert.match(first, /^[A-Za-z0-9._-]+$/);
            """
        )


if __name__ == "__main__":
    unittest.main()
