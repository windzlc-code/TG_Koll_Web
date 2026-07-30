from __future__ import annotations

import json
import tempfile
import unittest
from importlib import metadata
from pathlib import Path

from social_automation import browser_runtime


class BrowserRuntimeLockTests(unittest.TestCase):
    def _cache(self, payload: object) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temporary = tempfile.TemporaryDirectory()
        cache_root = Path(temporary.name)
        version_file = cache_root / "camoufox" / "version.json"
        version_file.parent.mkdir(parents=True)
        version_file.write_text(json.dumps(payload), encoding="utf-8")
        return temporary, cache_root

    @staticmethod
    def _package_version(name: str) -> str:
        return {
            "camoufox": browser_runtime.PINNED_CAMOUFOX_PACKAGE_VERSION,
            "browserforge": browser_runtime.PINNED_BROWSERFORGE_PACKAGE_VERSION,
        }[name]

    def test_accepts_only_the_pinned_runtime(self):
        temporary, cache_root = self._cache(
            {
                "version": browser_runtime.PINNED_CAMOUFOX_BROWSER_VERSION,
                "release": browser_runtime.PINNED_CAMOUFOX_BROWSER_RELEASE,
            }
        )
        self.addCleanup(temporary.cleanup)

        result = browser_runtime.verify_pinned_browser_runtime(
            cache_root=cache_root,
            package_version=self._package_version,
        )

        self.assertEqual(result["camoufox"], "0.4.11")
        self.assertEqual(result["browserforge"], "1.2.4")
        self.assertEqual(result["browser_version"], "152.0.4")
        self.assertEqual(result["browser_release"], "beta.28")

    def test_rejects_a_different_browser_build_without_fetch_advice(self):
        temporary, cache_root = self._cache({"version": "153.0.0", "release": "beta.29"})
        self.addCleanup(temporary.cleanup)

        with self.assertRaises(RuntimeError) as raised:
            browser_runtime.verify_pinned_browser_runtime(
                cache_root=cache_root,
                package_version=self._package_version,
            )

        message = str(raised.exception)
        self.assertIn("版本不匹配", message)
        self.assertIn("禁止直接升级", message)
        self.assertNotIn("camoufox fetch", message)

    def test_rejects_missing_or_mismatched_python_packages(self):
        temporary, cache_root = self._cache(
            {
                "version": browser_runtime.PINNED_CAMOUFOX_BROWSER_VERSION,
                "release": browser_runtime.PINNED_CAMOUFOX_BROWSER_RELEASE,
            }
        )
        self.addCleanup(temporary.cleanup)

        with self.assertRaises(RuntimeError):
            browser_runtime.verify_pinned_browser_runtime(
                cache_root=cache_root,
                package_version=lambda name: "0.4.12" if name == "camoufox" else "1.2.4",
            )

        def missing(name: str) -> str:
            if name == "browserforge":
                raise metadata.PackageNotFoundError(name)
            return "0.4.11"

        with self.assertRaises(RuntimeError):
            browser_runtime.verify_pinned_browser_runtime(
                cache_root=cache_root,
                package_version=missing,
            )

    def test_requirements_pin_browser_dependencies_exactly(self):
        requirements = (Path(__file__).resolve().parents[2] / "requirements.txt").read_text(encoding="utf-8")
        self.assertIn("camoufox[geoip]==0.4.11", requirements)
        self.assertIn("browserforge==1.2.4", requirements)
        self.assertNotIn("camoufox[geoip]>=", requirements)
        runner_source = (Path(__file__).resolve().parents[1] / "runner.py").read_text(encoding="utf-8")
        self.assertNotIn("camoufox fetch", runner_source)
        self.assertNotIn("pip install camoufox", runner_source)


if __name__ == "__main__":
    unittest.main()
