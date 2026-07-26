from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_CSS = ROOT / "webapp" / "static" / "assets" / "console.css"


def test_mobile_tweet_generation_uses_one_vertical_spacing_rhythm():
    css = CONSOLE_CSS.read_text(encoding="utf-8")

    assert ".persona-detail.persona-detail--content {\n    gap: var(--mobile-module-gap);" in css
    assert ".persona-detail--content > .persona-step-shell {\n    gap: var(--mobile-module-gap);" in css
    assert ".persona-detail--content .persona-generate-panel {\n    gap: var(--mobile-module-gap);" in css
    assert ".persona-detail--content .persona-panel-intro--reserved {\n    display: none;" in css
    assert (
        ".persona-compose-post-side.persona-production-section {\n"
        "    gap: var(--mobile-module-gap);\n"
        "    padding: var(--mobile-functional-card-padding);"
    ) in css


def test_mobile_tweet_spacing_does_not_override_shared_tab_components():
    css = CONSOLE_CSS.read_text(encoding="utf-8")
    marker = "/* Keep every mobile page on one compact 8px rhythm. */"
    rhythm_block = css[css.index(marker) :]

    assert "\n  .console-page .account-browser-tabs {" not in rhythm_block
    assert "\n  .console-page .persona-step-tabs {" not in rhythm_block
    assert "\n  .console-page .row-actions {" not in rhythm_block
