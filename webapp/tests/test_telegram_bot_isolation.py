from __future__ import annotations

import json
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class TelegramBotIsolationTests(unittest.TestCase):
    def test_original_bot_core_is_preserved_but_has_no_runtime_entrypoint(self):
        core = ROOT / "tool_r18" / "src" / "telegram-bot.ts"
        self.assertTrue(core.is_file())
        core_text = core.read_text(encoding="utf-8")
        self.assertIn("export function startTelegramBot", core_text)
        imported = subprocess.run(
            [
                "node",
                "--import",
                "tsx",
                "-e",
                "import('./src/telegram-bot.ts').then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); })",
            ],
            cwd=ROOT / "tool_r18",
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(imported.returncode, 0, imported.stdout + imported.stderr)

        self.assertFalse((ROOT / "tool_r18" / "src" / "daemon.ts").exists())
        entrypoint = (ROOT / "docker" / "entrypoint.sh").read_text(encoding="utf-8")
        self.assertNotIn("src/daemon.ts", entrypoint)
        self.assertNotIn("Telegram", entrypoint)

    def test_web_console_has_no_telegram_bot_outbound_network(self):
        server_text = (ROOT / "webapp" / "server.py").read_text(encoding="utf-8")
        for forbidden in (
            "api.telegram.org",
            "telegram_bot_token",
            "_notify_tg_task_finished",
            "_ensure_tool_r18_stop_responder_started",
        ):
            self.assertNotIn(forbidden, server_text)
        self.assertIn('/api/internal/tg/status', server_text)

    def test_removed_image_tasks_have_no_telegram_entry_or_callback(self):
        core_text = (ROOT / "tool_r18" / "src" / "telegram-bot.ts").read_text(encoding="utf-8")
        for removed_marker in (
            '"text_to_image"',
            '"get_nano_banana"',
            '"nano_banana"',
            '"r18_image_replace"',
            '"r18_multi_image"',
            "r18_text_to_image",
            "r18_image_edit",
            "toolr18_t2i_",
            "toolr18_imgedit_",
        ):
            self.assertNotIn(removed_marker, core_text)
        self.assertIn('task_type: "persona_post_image"', core_text)
        self.assertIn('type: "image_generate"', core_text)
        self.assertIn('type: "get_gemini"', core_text)
        self.assertNotIn("image_auto_qa", core_text)
        self.assertNotIn("genpost_toggle_qa", core_text)
        self.assertNotIn('if (taskType === "image_generate") return 2;', core_text)
        self.assertIn(
            "const NEW_PERSONA_POST_IMAGE_TIMEOUT_MS = 25 * 60 * 1000;",
            core_text,
        )

    def test_package_scripts_cannot_start_or_selftest_the_bot(self):
        package = json.loads((ROOT / "tool_r18" / "package.json").read_text(encoding="utf-8"))
        scripts = package.get("scripts") or {}
        serialized = json.dumps(scripts, ensure_ascii=False)
        self.assertNotIn("src/daemon.ts", serialized)
        for removed_script in (
            "telegram-custom-post-selftest",
            "telegram-custom-publish-selftest",
            "telegram-publish-button-matrix-selftest",
            "telegram-warmup-button-selftest",
        ):
            self.assertNotIn(removed_script, serialized.lower())

    def test_portable_launcher_requires_tsx_before_starting_uvicorn(self):
        launcher = (ROOT / "portable_launcher.ps1").read_text(encoding="utf-8")
        start_web = launcher[launcher.index("function Start-WebBackend"):launcher.index("function Open-WebBackendPage")]
        tsx_check = start_web.index(r"tool_r18\node_modules\tsx\dist\cli.mjs")
        path_setup = start_web.index("$env:PATH =")
        existing_backend_check = start_web.index("$existing = Find-WebBackendProcess")
        uvicorn_start = start_web.index("Start-Process -FilePath $Python")
        self.assertLess(path_setup, tsx_check)
        self.assertLess(existing_backend_check, tsx_check)
        self.assertLess(tsx_check, uvicorn_start)
        self.assertRegex(
            start_web[tsx_check:uvicorn_start],
            r"Test-Path\s+-LiteralPath\s+\$tsxCliPath\s+-PathType\s+Leaf",
        )

    def test_sentiment_telegram_public_network_collection_is_disabled(self):
        scraper_path = (
            ROOT
            / "tool_r18"
            / "vendor"
            / "opinx-sentiment"
            / "plugins"
            / "sentiment"
            / "scrapers"
            / "social-realtime-sources.js"
        )
        scraper_text = scraper_path.read_text(encoding="utf-8")
        self.assertIn("const TELEGRAM_PUBLIC_NETWORK_COLLECTION_ENABLED = false;", scraper_text)
        scraper_match = re.search(
            r"export async function scrapeTelegramPublicChannels\b(?P<body>[\s\S]*?)\n}\n\nasync function scrapeMastodon",
            scraper_text,
        )
        self.assertIsNotNone(scraper_match)
        scraper_body = scraper_match.group("body")
        disabled_return = scraper_body.index(
            "if (!TELEGRAM_PUBLIC_NETWORK_COLLECTION_ENABLED) return scraperResult(0);"
        )
        self.assertLess(disabled_return, scraper_body.index("fetchPublicSource("))

        vendor_root = ROOT / "tool_r18" / "vendor" / "opinx-sentiment"
        legacy_scraper_text = (vendor_root / "scrapers" / "social-realtime-sources.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("const TELEGRAM_PUBLIC_NETWORK_COLLECTION_ENABLED = false;", legacy_scraper_text)
        legacy_scraper_start = legacy_scraper_text.index(
            "export async function scrapeTelegramPublicChannels"
        )
        legacy_disabled_return = legacy_scraper_text.index(
            "if (!TELEGRAM_PUBLIC_NETWORK_COLLECTION_ENABLED) return scraperResult(0);",
            legacy_scraper_start,
        )
        legacy_fetch = legacy_scraper_text.index("fetchPublicSource(", legacy_scraper_start)
        self.assertLess(legacy_disabled_return, legacy_fetch)

        legacy_http_text = (vendor_root / "scrapers" / "http.js").read_text(encoding="utf-8")
        self.assertIn("export function isTelegramPublicNetworkUrl", legacy_http_text)
        self.assertIn("if (isTelegramPublicNetworkUrl(url))", legacy_http_text)

        http_modules = ["./plugins/sentiment/scrapers/http.js"]
        for http_module in http_modules:
            network_check = subprocess.run(
                [
                    "node",
                    "--input-type=module",
                    "-e",
                    """
import { fetchPublicSource } from '__HTTP_MODULE__';
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  return new Response('ok', { status: 200 });
};
let blocked = false;
try {
  await fetchPublicSource('https://t.me/s/brand_alerts');
} catch (error) {
  blocked = /disabled/i.test(String(error?.message || error));
}
if (!blocked || calls !== 0) process.exit(2);
const response = await fetchPublicSource('https://example.test/news');
if (!response.ok || calls !== 1) process.exit(3);
""".replace("__HTTP_MODULE__", http_module),
                ],
                cwd=vendor_root,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(
                network_check.returncode,
                0,
                f"{http_module}: {network_check.stdout}{network_check.stderr}",
            )

        store_text = (
            ROOT
            / "tool_r18"
            / "vendor"
            / "opinx-sentiment"
            / "plugins"
            / "sentiment"
            / "sentiment-store.js"
        ).read_text(encoding="utf-8")
        self.assertIn('status: "telegram-public-network-disabled"', store_text)

        browser_fallback_text = (
            ROOT
            / "tool_r18"
            / "vendor"
            / "opinx-sentiment"
            / "plugins"
            / "sentiment"
            / "scrapers"
            / "browser-fallback.js"
        ).read_text(encoding="utf-8")
        self.assertIn('await context.route("**/*"', browser_fallback_text)
        self.assertIn("if (isTelegramPublicNetworkUrl(url))", browser_fallback_text)
        self.assertIn("if (isTelegramPublicNetworkUrl(item.url))", browser_fallback_text)


if __name__ == "__main__":
    unittest.main()
