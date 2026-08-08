from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_CSS = ROOT / "webapp" / "static" / "assets" / "console.css"
CONSOLE_JS = ROOT / "webapp" / "static" / "assets" / "console.js"


def test_mobile_tweet_generation_uses_one_vertical_spacing_rhythm():
    css = CONSOLE_CSS.read_text(encoding="utf-8")

    assert ".console-page .persona-detail.persona-detail--content {\n    gap: var(--mobile-module-gap);" in css
    assert ".console-page .persona-detail--content > .persona-step-shell {\n    gap: var(--mobile-module-gap);" in css
    assert ".console-page .persona-detail--content .persona-panel-intro {\n    min-height: 1.45em;" in css
    assert (
        ".console-page\n"
        "    .persona-detail--content\n"
        "    .persona-compose-post-side.persona-production-section {\n"
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
    assert 'data-persona-stash-draft-edit' in panel
    assert 'AI 重新生成' in panel


def test_draft_edit_stash_only_updates_the_media_reference_without_saving():
    script = CONSOLE_JS.read_text(encoding="utf-8")
    start = script.index("async function stashPersonaDraftEdit()")
    end = script.index("\nasync function fetchPersonaHotCandidates", start)
    stash = script[start:end]

    assert "form.stagedReferenceContent = String(form.content || \"\")" in stash
    assert "renderPersonaDetail()" in stash
    assert "api(" not in stash
    assert 'method: "PATCH"' not in stash
    assert "form.originalTitle" not in stash
    assert "form.originalContent" not in stash
    assert "loadPersonaDraftPosts" not in stash
    assert "state.personaPanels.content = \"posts\"" not in stash
    assert 'event.target.closest("[data-persona-stash-draft-edit]")' in script
    assert "stagedReferenceContent: null" in script
    assert "function personaDraftReferenceContent(persona, post, source = \"posts\")" in script
    assert "const draftSourceText = personaDraftReferenceContent(persona, post, source).trim();" in script
    assert "const referenceContent = personaDraftReferenceContent(persona, post, isFavoriteMedia ? \"favorites\" : \"posts\").trim();" in script


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
    assert 'data-console-modal-value] {\n  grid-column: 2;' in css
    assert 'data-console-modal-confirm] {\n  grid-column: 1;' in css


def test_console_modal_places_positive_actions_before_dismissals():
    script = CONSOLE_JS.read_text(encoding="utf-8")

    assert 'const isDismissiveModalAction = (text = "")' in script
    assert 'if (action.dismissive || isDismissiveModalAction(action.text)) return 30;' in script
    assert 'if (action.primary || action.confirm) return 10;' in script
    assert '...(showCancel ? [{ kind: "cancel", text: cancelText, dismissive: true }] : []),' in script


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
    assert '.console-page .persona-draft-global-save-dock {' in css
    assert 'grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr);' in css
    assert '.console-page #personaDetail:has(.persona-draft-global-save-dock)' in css
    assert 'right: calc(25% + 5px);' in css
    assert '.console-page .persona-draft-save-cancel {' in css
    assert 'grid-row: 1;' in css
    assert 'font-size: 16px !important;' in css
    assert 'height: 50px !important;' in css
    assert 'dock.classList.toggle("is-selection-expanded", nextExpanded);' in script
    for message in (
        '已放弃本次修改。',
        '已取消未保存修改。',
        '已清空当前草稿编辑内容。',
        '已退出当前草稿编辑。',
    ):
        assert message not in script
