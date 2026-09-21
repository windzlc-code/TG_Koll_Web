import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
INDEX_HTML = ROOT / "webapp" / "static" / "index.html"
HOME_SCRIPT = ROOT / "webapp" / "static" / "assets" / "opc" / "script.js"
SITE_NAV_SCRIPT = ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.js"
CASE_SCRIPT = ROOT / "webapp" / "static" / "assets" / "opc" / "case-studies.js"


class HomePerformanceContractTests(unittest.TestCase):
    def test_only_primary_hero_image_is_eager(self):
        html = INDEX_HTML.read_text(encoding="utf-8")

        self.assertRegex(
            html,
            r'<img class="home-hero-media" src="/assets/opc/home/hero-ai-control\.jpg"[^>]+fetchpriority="high"',
        )
        self.assertGreaterEqual(html.count('class="home-hero-media" data-src='), 5)
        self.assertEqual(html.count('data-poster="/assets/opc/home/'), 2)
        self.assertNotRegex(html, r'<img(?=[^>]+\ssrc="[^"]+")[^>]+loading="lazy"')

    def test_noncritical_scripts_do_not_block_html_parsing(self):
        html = INDEX_HTML.read_text(encoding="utf-8")

        self.assertIn(
            '<script async src="/assets/opc/site-navigation.js?v=__SITE_NAVIGATION_JS_VERSION__"></script>',
            html,
        )
        self.assertIn(
            '<script async src="/assets/opc/script.js?v=__OPC_SCRIPT_VERSION__"></script>',
            html,
        )
        self.assertNotIn('<script src="/assets/vendor/opencc-js/', html)

    def test_deferred_media_has_runtime_activation(self):
        script = HOME_SCRIPT.read_text(encoding="utf-8")

        self.assertIn("const loadDeferredImage = (image) =>", script)
        self.assertIn("const loadDeferredVideoPoster = (video) =>", script)
        self.assertIn('scene.querySelectorAll("img[data-src]").forEach(loadDeferredImage)', script)
        self.assertIn('new IntersectionObserver((entries, observer) =>', script)
        self.assertIn('rootMargin: "0px"', script)
        self.assertIn("function schedulePublicLanguageDictionaries()", script)
        self.assertIn("resetPublicLanguageDictionaries();", script)

    def test_public_navigation_scripts_are_async_safe(self):
        for name in ("index.html", "about-vecto.html", "case-studies.html", "product-login.html"):
            markup = (ROOT / "webapp" / "static" / name).read_text(encoding="utf-8")
            self.assertIn('<script async src="/assets/opc/site-navigation.js', markup)

        site_nav = SITE_NAV_SCRIPT.read_text(encoding="utf-8")
        case_script = CASE_SCRIPT.read_text(encoding="utf-8")
        self.assertIn('document.addEventListener("DOMContentLoaded", initializeNavigation, { once: true })', site_nav)
        self.assertIn('document.addEventListener("DOMContentLoaded", initializeCaseStudies, { once: true })', case_script)


if __name__ == "__main__":
    unittest.main()
