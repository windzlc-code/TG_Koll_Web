from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_CSS = ROOT / "webapp" / "static" / "assets" / "console.css"
CONSOLE_JS = ROOT / "webapp" / "static" / "assets" / "console.js"


def test_mobile_tweet_generation_uses_one_vertical_spacing_rhythm():
    css = CONSOLE_CSS.read_text(encoding="utf-8")

    assert ".persona-detail.persona-detail--content {\n    gap: var(--mobile-module-gap);" in css
    assert ".persona-detail--content > .persona-step-shell {\n    gap: var(--mobile-module-gap);" in css
    assert ".persona-detail--content .persona-generate-panel {\n    gap: var(--mobile-module-gap);" in css
    assert ".persona-detail--content .persona-panel-intro {\n    min-height: 1.45em;" in css
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


def test_hot_mode_uses_the_stable_intro_slot_without_duplicate_copy():
    script = CONSOLE_JS.read_text(encoding="utf-8")
    intro = "按当前人设与记忆抓取 Threads / Instagram 热点候选。"

    assert script.count(intro) == 1
    assert '? "按当前人设与记忆抓取 Threads / Instagram 热点候选。"' in script
    assert '<span class="persona-panel-intro" data-i18n-ui>' in script
    assert "<strong>热点抓取</strong>" not in script

def test_editing_draft_copy_and_controls_share_the_compose_card_header():
    script = CONSOLE_JS.read_text(encoding="utf-8")
    panel = script[script.index('if (panel === "generate")'):script.index('if (panel === "posts")')]

    assert 'persona-temp-edit-toolbar--hint' not in panel
    assert 'class="persona-temp-edit-copy"' in panel
    assert 'class="persona-temp-edit-icon-actions"' in panel
    assert panel.index('persona-temp-edit-copy') < panel.index('persona-compose-mode-slot')
    assert panel.index('persona-temp-edit-icon-actions') < panel.index('persona-compose-mode-slot')


def test_draft_exit_confirmation_uses_a_compact_left_right_action_layout():
    script = CONSOLE_JS.read_text(encoding="utf-8")
    css = CONSOLE_CSS.read_text(encoding="utf-8")

    assert 'modalKey: "persona-draft-edit-exit"' in script
    assert '.console-modal[data-modal-key="persona-draft-edit-exit"] .console-modal-actions {' in css
    assert 'grid-template-columns: minmax(76px, 1fr) minmax(96px, 1.2fr) minmax(76px, 1fr);' in css
    assert 'console-modal-actions > [data-console-modal-cancel]' in css
    assert 'console-modal-actions > [data-console-modal-value]' in css
    assert 'console-modal-actions > [data-console-modal-confirm]' in css
