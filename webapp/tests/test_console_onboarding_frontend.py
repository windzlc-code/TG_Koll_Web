from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_HTML = (ROOT / "webapp" / "static" / "console.html").read_text(encoding="utf-8")
ONBOARDING_JS_PATH = ROOT / "webapp" / "static" / "assets" / "console-onboarding.js"
ONBOARDING_CSS_PATH = ROOT / "webapp" / "static" / "assets" / "console-onboarding.css"


def test_console_loads_isolated_onboarding_assets():
    assert '/assets/console-onboarding.css?v=20260817-4' in CONSOLE_HTML
    assert '/assets/console-onboarding.js?v=20260817-4' in CONSOLE_HTML


def test_onboarding_is_scoped_to_new_non_admin_users_and_can_be_reopened():
    script = ONBOARDING_JS_PATH.read_text(encoding="utf-8")

    assert 'const ONBOARDING_VERSION = "2026.08"' in script
    assert 'created_at' in script
    assert 'is_admin' in script
    assert 'acting_admin' in script
    assert 'vecto-console-onboarding' in script
    assert 'consoleOnboardingLauncher' in script
    assert '重新打开新手引导' in script
    eligibility_check = script.index('runtime.eligible = isNewUser(user);')
    eligibility_exit = script.index('if (!runtime.eligible) return;', eligibility_check)
    launcher_binding = script.index('bindLauncher();', eligibility_exit)
    assert eligibility_check < eligibility_exit < launcher_binding


def test_onboarding_covers_the_primary_business_flow_without_blocking_it():
    script = ONBOARDING_JS_PATH.read_text(encoding="utf-8")

    expected_steps = (
        'id: "personas"',
        'id: "accounts"',
        'id: "tweet_generation"',
        'id: "publishing"',
        'id: "persona_dashboard"',
    )
    for step in expected_steps:
        assert step in script

    assert 'className = "console-onboarding-beacon"' in script
    assert 'data-onboarding-start' in script
    assert 'data-onboarding-jump' in script
    assert 'data-onboarding-dismiss' in script
    assert 'data-onboarding-exit' in script
    assert 'click()' in script
    assert 'role="dialog"' in script
    assert 'aria-modal="false"' in script


def test_onboarding_visuals_are_subtle_responsive_and_motion_safe():
    styles = ONBOARDING_CSS_PATH.read_text(encoding="utf-8")

    assert '.console-onboarding-beacon' in styles
    assert '.site-header .console-onboarding-launcher[hidden]' in styles
    assert 'z-index: 1500' in styles
    assert '@keyframes console-onboarding-beacon-pulse' in styles
    assert '.console-onboarding-card' in styles
    assert '.is-onboarding-focus' in styles
    assert '@media (max-width: 820px)' in styles
    assert '@media (prefers-reduced-motion: reduce)' in styles
    assert 'pointer-events: none' in styles
    assert '.console-onboarding-card' in styles and 'pointer-events: auto' in styles
