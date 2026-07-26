import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_CSS = ROOT / "webapp" / "static" / "assets" / "console.css"
CONSOLE_HTML = ROOT / "webapp" / "static" / "console.html"


def test_mobile_pages_share_persona_dashboard_top_spacing():
    css = CONSOLE_CSS.read_text(encoding="utf-8")

    assert "--mobile-page-top-gap: 8px;" in css
    assert "--mobile-module-gap: 8px;" in css
    assert re.search(
        r"\.console-page \.console-main > \.view\.is-active\s*"
        r"\{\s*padding-top:\s*var\(--mobile-page-top-gap\);",
        css,
    )
    assert re.search(
        r"\.console-page \.persona-detail\s*"
        r"\{\s*margin-top:\s*0;\s*padding-top:\s*0;",
        css,
    )
    assert re.search(
        r"\.console-page \.publish-config-panel\s*"
        r"\{\s*grid-row:\s*1;\s*gap:\s*var\(--mobile-module-gap\);"
        r"\s*padding-top:\s*0;",
        css,
    )
    assert re.search(
        r'\.console-page \.view\[data-panel="persona_dashboard"\] '
        r"\.persona-dashboard-page\s*"
        r"\{\s*gap:\s*var\(--mobile-page-section-gap\);"
        r"\s*padding-top:\s*0;",
        css,
    )
    assert re.search(
        r"\.console-page \.console-settings-page\s*"
        r"\{\s*margin-top:\s*0;",
        css,
    )
    assert re.search(
        r'\.console-page \.account-browser-shell'
        r'\[data-account-browser-panel="browsers"\] '
        r"\.account-browser-toolbar\s*\{\s*display:\s*none;",
        css,
    )


def test_mobile_toolbar_spacing_covers_each_primary_console_panel():
    html = CONSOLE_HTML.read_text(encoding="utf-8")

    for panel in (
        "workspace",
        "tasks",
        "accounts",
        "billing",
        "persona_dashboard",
        "console_settings",
    ):
        assert f'data-panel="{panel}"' in html
