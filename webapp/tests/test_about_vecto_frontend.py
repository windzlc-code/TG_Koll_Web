import re
import unittest
from pathlib import Path


STATIC_ROOT = Path(__file__).resolve().parents[1] / "static"
SERVER_SOURCE = STATIC_ROOT.parent / "server.py"


class AboutVectoFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.about_markup = (STATIC_ROOT / "about-vecto.html").read_text(encoding="utf-8")
        cls.about_styles = (STATIC_ROOT / "assets" / "opc" / "about.css").read_text(encoding="utf-8")
        cls.navigation_script = (
            STATIC_ROOT / "assets" / "opc" / "site-navigation.js"
        ).read_text(encoding="utf-8")
        cls.server_source = SERVER_SOURCE.read_text(encoding="utf-8")

    def test_shared_navigation_contains_only_current_public_destinations(self):
        navigation = self.navigation_script[
            self.navigation_script.index("function navigationLinks")
            : self.navigation_script.index("function accountMenuMarkup")
        ]
        for key in ("solution", "proxyMarket", "console", "aboutVecto"):
            self.assertIn(f'key: "{key}"', navigation)
        for removed_key in ("accounts", "scenarios", "difference"):
            self.assertNotIn(f'key: "{removed_key}"', navigation)
        self.assertIn('console: "控制台"', self.navigation_script)
        self.assertIn('aboutVecto: "了解 Vecto"', self.navigation_script)

        for page_name in (
            "index.html",
            "pricing.html",
            "proxy-market.html",
            "console.html",
            "about-vecto.html",
        ):
            markup = (STATIC_ROOT / page_name).read_text(encoding="utf-8")
            with self.subTest(page=page_name):
                for removed_key in ("accounts", "scenarios", "difference"):
                    self.assertNotIn(f'data-site-nav-key="{removed_key}"', markup)
                self.assertIn('data-site-nav-key="console"', markup)
                self.assertIn('data-site-nav-key="aboutVecto"', markup)

    def test_about_page_covers_product_story_and_marks_roadmap_features(self):
        self.assertIn('data-site-page="aboutVecto"', self.about_markup)
        self.assertIn('data-login-redirect="/about-vecto.html"', self.about_markup)
        for control in (
            "data-site-mobile-menu",
            "data-site-subscription-entry",
            "data-site-language-toggle",
            "data-open-login",
        ):
            self.assertIn(control, self.about_markup)
        self.assertIn('["pricing", "console", "proxyMarket", "aboutVecto"].includes(page)', self.navigation_script)
        for heading in (
            "六個階段，從公域訊號走到成交復盤",
            "七個產品模組，覆蓋日常社媒作業",
            "五類智能體沿同一目標協同",
            "軟體中樞與落地服務雙引擎",
            "核心競爭力來自系統協作，而非單點功能",
        ):
            self.assertIn(heading, self.about_markup)
        self.assertIn("LIVE", self.about_markup)
        self.assertIn("ROADMAP", self.about_markup)
        self.assertIn("實際可用範圍以控制台和交付方案為準", self.about_markup)

    def test_about_assets_exist_and_all_local_image_references_resolve(self):
        image_paths = re.findall(r'<img[^>]+src="(/assets/[^"]+)"', self.about_markup)
        self.assertGreaterEqual(len(image_paths), 10)
        for image_path in image_paths:
            clean_path = image_path.split("?", 1)[0]
            with self.subTest(image=clean_path):
                self.assertTrue((STATIC_ROOT / clean_path.removeprefix("/")).is_file())
        self.assertIn("@media (max-width: 680px)", self.about_styles)
        self.assertIn("overflow: clip", self.about_styles)

    def test_server_exposes_versioned_about_page(self):
        route = self.server_source[
            self.server_source.index('@app.get("/about-vecto.html"')
            : self.server_source.index('@app.get("/proxy-market.html"')
        ]
        self.assertIn('"about-vecto.html"', route)
        for token in (
            "__OPC_STYLES_VERSION__",
            "__OPC_ABOUT_CSS_VERSION__",
            "__OPC_SCRIPT_VERSION__",
            "__SITE_NAVIGATION_CSS_VERSION__",
            "__SITE_NAVIGATION_JS_VERSION__",
        ):
            self.assertIn(token, route)


if __name__ == "__main__":
    unittest.main()
