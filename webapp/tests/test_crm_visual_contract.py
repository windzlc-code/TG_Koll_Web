from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "webapp" / "static"
OVERRIDES = STATIC / "assets" / "crm-workbench-overrides.css"


def test_crm_shell_loads_desktop_visual_overrides_after_bundle():
    for shell_path in (STATIC / "crm.html", STATIC / "assets" / "crm" / "index.html"):
        shell = shell_path.read_text(encoding="utf-8")
        bundle_link = 'href="/assets/crm/assets/index-C_WLJXL7.css"'
        override_link = 'href="/assets/crm-workbench-overrides.css?v=20260927-crm-visual1"'
        assert bundle_link in shell
        assert override_link in shell
        assert shell.index(bundle_link) < shell.index(override_link)


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
      body.crm-page { --crm-sidebar-width: 188px; font-size: 14px; }
      .crm-line-chart { width: 100%; min-height: 180px; }
    """
    fixture = """
      <aside class="crm-sidebar"><div class="crm-sidebar-head"><div class="crm-monogram">CRM</div><strong>采集工作台</strong></div></aside>
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
            assert desktop == {"sidebar": "264px", "font": "15px"}
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
