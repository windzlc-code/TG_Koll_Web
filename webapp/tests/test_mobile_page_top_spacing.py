import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_CSS = ROOT / "webapp" / "static" / "assets" / "console.css"
CONSOLE_HTML = ROOT / "webapp" / "static" / "console.html"


def test_mobile_pages_share_persona_dashboard_top_spacing():
    css = CONSOLE_CSS.read_text(encoding="utf-8")

    assert "--mobile-page-top-gap: 8px;" in css
    assert re.search(
        r"\.console-page \.console-main > \.view\.is-active\s*"
        r"\{\s*padding-top:\s*var\(--mobile-page-top-gap\);",
        css,
    )
    assert re.search(
        r'\.console-page \.view\[data-panel="persona_dashboard"\] '
        r"\.persona-dashboard-page\s*\{\s*padding-top:\s*0;",
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
