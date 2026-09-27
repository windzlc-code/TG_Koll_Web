from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "webapp" / "static"
OVERRIDES = STATIC / "assets" / "crm-workbench-overrides.css"


def test_crm_shell_loads_desktop_visual_overrides_after_bundle():
    for shell_path in (STATIC / "crm.html", STATIC / "assets" / "crm" / "index.html"):
        shell = shell_path.read_text(encoding="utf-8")
        bundle_link = 'href="/assets/crm/assets/index-C_WLJXL7.css"'
        override_link = 'href="/assets/crm-workbench-overrides.css?v=20260927-crm-visual3"'
        assert bundle_link in shell
        assert override_link in shell
        assert shell.index(bundle_link) < shell.index(override_link)
        for nav_key in ("solution", "console", "aboutVecto", "caseStudies"):
            assert f'data-site-nav-key="{nav_key}"' in shell
        assert 'data-site-product-menu' in shell
        assert 'data-video-entry href="/video.html"' in shell
        assert 'data-crm-entry href="/crm.html"' in shell


def test_crm_visual_overrides_are_desktop_scoped_and_use_shared_brand_assets():
    css = OVERRIDES.read_text(encoding="utf-8")
    assert "@media (min-width: 981px)" in css
    assert "--crm-sidebar-width: 264px" in css
    assert "vecto-logo-ui-icon.png" in css
    assert "max-height: 300px" in css
    assert "body.crm-page" in css
    assert "@media (max-width:" not in css


def _launch_browser(playwright):
    candidates = (
        Path.home() / "AppData/Local/ms-playwright/chromium-1194/chrome-win/chrome.exe",
        Path.home() / "AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe",
    )
    for candidate in candidates:
        if candidate.exists():
            return playwright.chromium.launch(headless=True, executable_path=str(candidate))
    return playwright.chromium.launch(headless=True)


def test_crm_visual_overrides_keep_desktop_chart_bounded_and_mobile_unchanged():
    sync_api = pytest.importorskip("playwright.sync_api")
    css = OVERRIDES.read_text(encoding="utf-8")
    base_css = """
      body { margin: 0; }
      body.crm-page { --crm-sidebar-width: 188px; font-size: 14px; }
      * { box-sizing: border-box; }
      .crm-sidebar { position: fixed; width: var(--crm-sidebar-width); }
      .crm-line-chart { width: 100%; min-height: 180px; }
    """
    fixture = """
      <aside class="crm-sidebar"><div class="crm-sidebar-head"><div class="crm-monogram">CRM</div><strong>采集工作台</strong></div><nav class="crm-nav"><button><svg viewBox="0 0 24 24"></svg><span>总览</span></button><button><svg viewBox="0 0 24 24"></svg><span>采集</span></button></nav></aside>
      <main class="crm-main"><svg class="crm-line-chart" viewBox="0 0 720 250"><text x="52" y="30">任务数</text></svg></main>
    """
    with sync_api.sync_playwright() as playwright:
        browser = _launch_browser(playwright)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.set_content(f"<style>{base_css}{css}</style><body class='crm-page'>{fixture}</body>")
            desktop = page.locator("body.crm-page").evaluate(
                "el => ({sidebar: getComputedStyle(el).getPropertyValue('--crm-sidebar-width').trim(), font: getComputedStyle(el).fontSize})"
            )
            chart = page.locator(".crm-line-chart").bounding_box()
            assert desktop == {"sidebar": "264px", "font": "14px"}
            sidebar = page.locator(".crm-sidebar").bounding_box()
            logo = page.locator(".crm-monogram").bounding_box()
            title = page.locator(".crm-sidebar-head strong").evaluate("el => getComputedStyle(el).fontSize")
            nav_row = page.locator(".crm-nav button").first.bounding_box()
            nav_text = page.locator(".crm-nav button > span").first.evaluate("el => getComputedStyle(el).fontSize")
            assert sidebar is not None
            assert sidebar["x"] == 16 and sidebar["y"] == 84
            assert sidebar["width"] == 264 and sidebar["height"] == 800
            assert logo is not None and logo["width"] == 42 and logo["height"] == 42
            assert title == "18px"
            assert nav_row is not None and nav_row["height"] == 50
            assert nav_text == "14px"
            main = page.locator(".crm-main").bounding_box()
            assert main is not None and main["x"] == 296
            assert chart is not None
            assert chart["width"] <= 980.5
            assert chart["height"] <= 300.5

            page.set_viewport_size({"width": 390, "height": 844})
            mobile = page.locator("body.crm-page").evaluate(
                "el => ({sidebar: getComputedStyle(el).getPropertyValue('--crm-sidebar-width').trim(), font: getComputedStyle(el).fontSize})"
            )
            mobile_chart = page.locator(".crm-line-chart").bounding_box()
            assert mobile == {"sidebar": "188px", "font": "14px"}
            assert mobile_chart is not None
            assert mobile_chart["width"] < 980.5
            assert mobile_chart["height"] >= 180
        finally:
            browser.close()
