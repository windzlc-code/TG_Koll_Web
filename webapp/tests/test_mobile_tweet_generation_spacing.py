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
    assert panel.index('persona-temp-edit-copy') < panel.index('persona-compose-mode-slot')
    assert 'data-persona-draft-save-dock' in panel
    assert 'data-persona-cancel-draft-edit' in panel
    assert 'data-persona-exit-draft-edit' in panel
    assert 'data-persona-clear-draft-edit' in panel
    assert 'data-persona-generate-posts' in panel
    assert 'AI 重新生成' in panel


def test_draft_exit_confirmation_uses_a_compact_left_right_action_layout():
    script = CONSOLE_JS.read_text(encoding="utf-8")
    css = CONSOLE_CSS.read_text(encoding="utf-8")

    assert 'modalKey: "persona-draft-edit-exit"' in script
    assert 'showCancel: false' in script
    assert '.console-modal[data-modal-key="persona-draft-edit-exit"] .console-modal-actions {' in css
    assert 'grid-template-columns: repeat(2, minmax(0, 1fr));' in css
    exit_modal_css = css[css.index('.console-modal[data-modal-key="persona-draft-edit-exit"]'):]
    assert 'console-modal-actions > [data-console-modal-cancel]' not in exit_modal_css[:exit_modal_css.index('@media (max-width: 760px)')]
    assert 'console-modal-actions > [data-console-modal-value]' in css
    assert 'console-modal-actions > [data-console-modal-confirm]' in css


def test_draft_edit_save_uses_a_global_button_with_long_press_actions():
    script = CONSOLE_JS.read_text(encoding="utf-8")
    css = CONSOLE_CSS.read_text(encoding="utf-8")

    assert 'const PERSONA_DRAFT_SAVE_LONG_PRESS_MS = 520;' in script
    assert 'function bindPersonaDraftSaveLongPress(host)' in script
    assert 'bindPersonaDraftSaveLongPress($("personaDetail"));' in script
    assert 'data-persona-create-post aria-expanded="false">保存修改</button>' in script
    assert 'data-persona-generate-posts aria-label="使用 AI 重新生成当前推文"' in script
    assert 'persona-temp-edit-icon-actions" aria-label="草稿编辑操作"' in script
    assert 'data-persona-clear-draft-edit' in script
    assert script.index('data-persona-clear-draft-edit', script.index('persona-draft-save-floating-actions')) < script.index('data-persona-exit-draft-edit', script.index('persona-draft-save-floating-actions'))
    assert 'class="publish-mobile-selection-cancel persona-draft-save-cancel" data-persona-cancel-draft-edit aria-hidden="true">取消</button>' in script
    assert 'createPostButton.dataset.personaDraftSaveLongPress === "true"' in script
    assert '.persona-draft-global-save-dock {' in css
    assert '.persona-draft-save-floating-actions {' in css
    assert '.persona-draft-global-save-dock.is-selection-expanded .persona-draft-save-floating-actions {' in css
    assert 'grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr);' in css
    assert '.console-page #personaDetail:has(.persona-draft-global-save-dock)' in css
    assert 'right: calc(25% + 5px);' in css
    assert '.console-page .persona-draft-save-cancel {' in css
    assert 'grid-row: 1;' in css
    assert 'font-size: 16px !important;' in css
    assert 'height: 50px !important;' in css
    assert 'dock.classList.toggle("is-selection-expanded", nextExpanded);' in script
