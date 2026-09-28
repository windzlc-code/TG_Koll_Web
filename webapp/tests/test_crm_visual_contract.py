from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "webapp" / "static"
OVERRIDES = STATIC / "assets" / "crm-workbench-overrides.css"


def test_crm_shell_loads_desktop_visual_overrides_after_bundle():
    for shell_path in (STATIC / "crm.html", STATIC / "assets" / "crm" / "index.html"):
        shell = shell_path.read_text(encoding="utf-8")
        bundle_link = 'href="/assets/crm/assets/index-C_WLJXL7.css"'
        override_link = 'href="/assets/crm-workbench-overrides.css?v=20260928-crm-nav-visual11"'
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
    assert "border-bottom: 0" in css
    assert "max-width: 1180px" in css
    assert "grid-template-columns: repeat(2, minmax(0, 1fr))" in css
    assert "flex: 0 1 180px" in css
    assert "flex: 0 1 240px" in css
    assert ".crm-member-platforms, .crm-platform-fieldset" in css
    assert ".crm-detail-pane > *" in css
    assert "body.crm-page" in css
    assert "gap: 6px" in css
    assert "min-height: 40px" in css
    assert "border-radius: 8px" in css
    assert "body.crm-page .crm-nav button + button::before" in css
    assert "body.crm-page :is(.crm-nav-strip, .crm-panel-strip)" in css
    assert "transition: none !important" in css
    assert "will-change: auto" in css
    assert ".crm-wizard-fieldset.crm-platform-fieldset" in css
    assert "flex: 1 1 calc(50% - 2px)" in css
    assert "flex-basis: 100%" in css
    assert ".crm-account-platforms, .crm-member-platforms, .crm-wizard-fieldset.crm-platform-fieldset" in css
    assert ".crm-account-platforms" in css
    assert "grayscale(1) saturate(0.15)" in css
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
      body.crm-page { --crm-sidebar-width: 188px; --crm-accent-strong: #253746; --crm-on-dark: #ffffff; font-size: 14px; }
      * { box-sizing: border-box; }
      .crm-sidebar { position: fixed; width: var(--crm-sidebar-width); }
      .crm-nav-strip, .crm-panel-strip { transition: transform 180ms linear; will-change: transform; }
      .crm-line-chart { width: 100%; min-height: 180px; }
    """
    fixture = """
      <aside class="crm-sidebar"><div class="crm-sidebar-head"><div class="crm-monogram">CRM</div><strong>采集工作台</strong></div><nav class="crm-nav"><button class="is-active"><svg viewBox="0 0 24 24"></svg><span>总览</span></button><button><svg viewBox="0 0 24 24"></svg><span>采集</span></button></nav></aside>
      <div class="crm-nav-strip" style="transform: translate3d(-100%, 0, 0)"></div>
      <div class="crm-panel-strip" style="transform: translate3d(-100%, 0, 0)"></div>
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
            nav_gap = page.locator(".crm-nav").evaluate("el => getComputedStyle(el).rowGap")
            nav_radius = page.locator(".crm-nav button").first.evaluate("el => getComputedStyle(el).borderRadius")
            active_radius = page.locator(".crm-nav button.is-active").evaluate("el => getComputedStyle(el).borderRadius")
            subtitle = page.locator(".crm-sidebar-head strong").evaluate("el => getComputedStyle(el, '::after').content")
            active_background = page.locator(".crm-nav button.is-active").evaluate("el => getComputedStyle(el).backgroundColor")
            header_border = page.locator(".crm-sidebar-head").evaluate("el => ({style: getComputedStyle(el).borderBottomStyle, width: getComputedStyle(el).borderBottomWidth})")
            nav_transition = page.locator(".crm-nav-strip").evaluate("el => ({duration: getComputedStyle(el).transitionDuration, willChange: getComputedStyle(el).willChange})")
            panel_transition = page.locator(".crm-panel-strip").evaluate("el => ({duration: getComputedStyle(el).transitionDuration, willChange: getComputedStyle(el).willChange})")
            assert sidebar is not None
            assert sidebar["x"] == 16 and sidebar["y"] == 84
            assert sidebar["width"] == 264 and sidebar["height"] == 800
            assert logo is not None and logo["width"] == 42 and logo["height"] == 42
            assert title == "18px"
            assert nav_row is not None and nav_row["height"] == pytest.approx(40, abs=0.5)
            assert nav_text == "13px"
            assert nav_gap == "6px"
            assert nav_radius == "8px"
            assert active_radius == "8px"
            assert subtitle == '"Vecto OS 采集与数据素材"'
            assert active_background != "rgba(0, 0, 0, 0)"
            assert header_border == {"style": "none", "width": "0px"}
            assert nav_transition == {"duration": "0s", "willChange": "auto"}
            assert panel_transition == {"duration": "0s", "willChange": "auto"}
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
            mobile_nav_transition = page.locator(".crm-nav-strip").evaluate("el => ({duration: getComputedStyle(el).transitionDuration, willChange: getComputedStyle(el).willChange})")
            mobile_panel_transition = page.locator(".crm-panel-strip").evaluate("el => ({duration: getComputedStyle(el).transitionDuration, willChange: getComputedStyle(el).willChange})")
            assert mobile == {"sidebar": "188px", "font": "14px"}
            assert mobile_chart is not None
            assert mobile_chart["width"] < 980.5
            assert mobile_chart["height"] >= 180
            assert mobile_nav_transition == {"duration": "0.18s", "willChange": "transform"}
            assert mobile_panel_transition == {"duration": "0.18s", "willChange": "transform"}
        finally:
            browser.close()


def test_crm_desktop_collect_platform_tabs_are_horizontal_and_mobile_is_unchanged():
    sync_api = pytest.importorskip("playwright.sync_api")
    css = OVERRIDES.read_text(encoding="utf-8")
    base_css = """
      body { margin: 0; }
      body.crm-page { --crm-line: #b9c2cc; --crm-surface-soft: #f0f2f4; --crm-ink-soft: #334155; --crm-muted: #4b5563; }
      * { box-sizing: border-box; }
      .crm-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 900px; }
      .crm-field--wide { grid-column: 1 / -1; }
      .crm-wizard-fieldset { display: flex; flex-wrap: wrap; min-width: 0; margin: 0; padding: 6px 8px; gap: 4px; background: var(--crm-surface-soft); border: 1px solid var(--crm-line); }
      .crm-platform-fieldset > button { flex: 1 1 0; min-width: 0; min-height: 44px; }
      .crm-platform-fieldset > button[data-account-platform="instagram"] { color: #c13584; background: linear-gradient(#fff, #fff) padding-box, linear-gradient(45deg, #feda75, #d62976, #4f5bd5) border-box; border: 1px solid transparent; }
      .crm-platform-fieldset > button[data-account-platform="instagram"]:not(.is-active) > strong { color: transparent; background: linear-gradient(45deg, #feda75, #d62976, #4f5bd5); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
      .crm-platform-fieldset > button[data-account-platform="threads"].is-active { color: #fff; background: #000; border: 1px solid #000; }
      .crm-wizard-hint { flex: 1 1 100%; margin: 2px 0 0; color: var(--crm-muted); }
    """
    fixture = """
      <div class="crm-form-grid">
        <div class="crm-account-platforms">
          <button type="button" data-account-platform="instagram"><svg class="platform-outline-icon--instagram"></svg><strong>Instagram</strong></button>
          <button type="button" class="is-active" data-account-platform="threads"><strong>Threads</strong></button>
        </div>
        <fieldset class="crm-wizard-fieldset crm-platform-fieldset crm-field--wide">
          <legend>采集平台</legend>
          <button type="button" data-account-platform="instagram"><svg class="platform-outline-icon--instagram"></svg><strong>Instagram</strong></button>
          <button type="button" class="is-active" data-account-platform="threads"><strong>Threads</strong></button>
          <p class="crm-wizard-hint">仅采集已选择的平台。</p>
        </fieldset>
      </div>
    """
    with sync_api.sync_playwright() as playwright:
        browser = _launch_browser(playwright)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.set_content(f"<style>{base_css}{css}</style><body class='crm-page'>{fixture}</body>")
            buttons = page.locator(".crm-platform-fieldset > button")
            account_buttons = page.locator(".crm-account-platforms > button")
            first = buttons.nth(0).bounding_box()
            second = buttons.nth(1).bounding_box()
            hint = page.locator(".crm-platform-fieldset > .crm-wizard-hint").bounding_box()
            assert first is not None and second is not None and hint is not None
            assert second["x"] > first["x"]
            assert second["y"] == pytest.approx(first["y"], abs=0.5)
            assert hint["y"] > first["y"] + first["height"]
            instagram = buttons.nth(0)
            threads = buttons.nth(1)
            assert instagram.evaluate("el => ({background: getComputedStyle(el).backgroundColor, image: getComputedStyle(el).backgroundImage, color: getComputedStyle(el).color, border: getComputedStyle(el).borderColor})") == {
                "background": "rgb(240, 242, 244)",
                "image": "none",
                "color": "rgb(51, 65, 85)",
                "border": "rgb(185, 194, 204)",
            }
            assert instagram.locator("strong").evaluate("el => ({color: getComputedStyle(el).color, fill: getComputedStyle(el).webkitTextFillColor})") == {
                "color": "rgb(51, 65, 85)",
                "fill": "rgb(51, 65, 85)",
            }
            assert threads.evaluate("el => ({background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color})") == {
                "background": "rgb(0, 0, 0)",
                "color": "rgb(255, 255, 255)",
            }
            assert account_buttons.nth(0).evaluate("el => ({background: getComputedStyle(el).backgroundColor, image: getComputedStyle(el).backgroundImage, color: getComputedStyle(el).color})") == {
                "background": "rgb(240, 242, 244)",
                "image": "none",
                "color": "rgb(51, 65, 85)",
            }

            page.set_viewport_size({"width": 390, "height": 844})
            # The desktop-only rule must not leak into the compact/mobile
            # stylesheet: the shared component keeps its original flex basis.
            assert buttons.nth(0).evaluate("el => getComputedStyle(el).flexBasis") == "0px"
        finally:
            browser.close()
