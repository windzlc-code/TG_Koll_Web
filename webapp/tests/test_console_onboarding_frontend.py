from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_HTML = (ROOT / "webapp" / "static" / "console.html").read_text(encoding="utf-8")
ONBOARDING_JS_PATH = ROOT / "webapp" / "static" / "assets" / "console-onboarding.js"
ONBOARDING_CSS_PATH = ROOT / "webapp" / "static" / "assets" / "console-onboarding.css"


def test_console_loads_isolated_onboarding_assets():
    assert '/assets/console-onboarding.css?v=20260817-14' in CONSOLE_HTML
    assert '/assets/console-onboarding.js?v=20260817-14' in CONSOLE_HTML
    assert 'id="consoleOnboardingLauncher"' not in CONSOLE_HTML


def test_onboarding_is_available_to_all_non_admin_users_and_can_be_reopened():
    script = ONBOARDING_JS_PATH.read_text(encoding="utf-8")

    assert 'const ONBOARDING_VERSION = "2026.08"' in script
    assert 'ONBOARDING_RELEASE_EPOCH' not in script
    assert 'created_at' not in script
    assert 'is_admin' in script
    assert 'acting_admin' in script
    assert 'vecto-console-onboarding' in script
    assert 'consoleOnboardingEdgeLauncher' in script
    assert 'consoleOnboardingHomeLauncher' in script
    assert '打开新手提示' in script
    assert 'personaDashboardToolbarActions' in script
    assert '重新查看新手教程' in script
    assert '<span>教程</span>' in script
    assert 'toolbar.insertBefore(launcher, document.getElementById("btnPersonaDashboardSync"));' in script
    assert 'if (homeLauncher) homeLauncher.hidden = false;' in script
    assert 'const cardOpen = Boolean(runtime.host?.querySelector(".console-onboarding-card"));' in script
    assert 'const reminderSuppressed = ["dismissed", "completed"].includes(progress.status);' in script
    assert 'edgeLauncher.hidden = homeLauncherVisible || cardOpen || reminderSuppressed;' in script
    assert 'if (!runtime.guided && ["dismissed", "completed"].includes(progress.status))' in script
    assert 'function isEligibleUser(user)' in script
    eligibility_check = script.index('runtime.eligible = isEligibleUser(user);')
    eligibility_exit = script.index('if (!runtime.eligible) return;', eligibility_check)
    launcher_binding = script.index('syncLaunchers();', eligibility_exit)
    assert eligibility_check < eligibility_exit < launcher_binding

    launch_start = script.index('function launchReminder()')
    launch_end = script.index('function ensureEdgeLauncher()', launch_start)
    launch_body = script[launch_start:launch_end]
    assert 'const progress = readProgress();' in launch_body
    assert 'if (progress.status === "active")' in launch_body
    assert 'startGuide(resumeStep());' in launch_body
    assert 'openReminder(resumeStep());' in launch_body


def test_active_tutorial_only_marks_the_current_unfinished_step():
    script = ONBOARDING_JS_PATH.read_text(encoding="utf-8")

    assert 'const activeIndex = progress.status === "active" ? resumeStep() : -1;' in script
    assert 'const completed = new Set(completedStepIds(progress));' in script
    assert 'const shouldShow = (activeIndex < 0 || index === activeIndex) && !completed.has(step.id);' in script
    assert 'if (!shouldShow || !beaconHost || beacon.parentElement !== beaconHost) removeBeacon(beacon);' in script
    assert 'if (!shouldShow) return;' in script
    assert 'if (latest.status === "active")' in script
    assert 'startGuide(resumeStep());' in script
    assert 'openReminder(index);' in script
    assert 'completedSteps:' in script
    assert 'markStepCompleted(index);' in script


def test_business_success_responses_advance_each_onboarding_step():
    script = ONBOARDING_JS_PATH.read_text(encoding="utf-8")

    for endpoint in (
        'path === "/api/persona_dashboard/personas"',
        'path === "/api/persona_dashboard/personas/ai_create"',
        'path === "/api/persona_dashboard/automation/accounts"',
        'generate_posts\\/tasks\\/',
        'path === "/api/persona_dashboard/automation/tasks"',
        'persona_dashboard\\/refresh\\/',
    ):
        assert endpoint in script
    assert 'document.addEventListener("click", armCurrentStepFromAction, true);' in script
    assert 'runtime.actionArmedStep !== index' in script
    assert 'Date.now() - runtime.actionArmedAt > 30 * 60 * 1000' in script
    assert 'response.clone().json()' in script
    assert 'navigateToStep(index + 1);' in script
    assert 'completeGuide();' in script


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

    for target_selector in (
        'targetSelector: "[data-persona-open-create]"',
        'targetSelector: "[data-account-pool-add], [data-persona-manage-account]"',
        'targetSelector: "[data-persona-generate-posts]"',
        'targetSelector: "[data-persona-publish-submit], [data-persona-run-automation]"',
        'targetSelector: "#btnPersonaDashboardSync"',
    ):
        assert target_selector in script
    assert 'beaconAnchorSelector: "strong"' in script
    assert 'target.querySelector(step.beaconAnchorSelector) || target' in script

    for entry_selector in (
        'entrySelector: \'[data-module="personas"]\'',
        'entrySelector: \'[data-workspace-module="accounts"]\'',
        'entrySelector: \'[data-module="tweet_generation"]\'',
        'entrySelector: \'[data-module="publishing"]\'',
        'entrySelector: \'[data-view="persona_dashboard"], [data-workspace-view="persona_dashboard"]\'',
    ):
        assert entry_selector in script

    assert 'className = "console-onboarding-beacon"' in script
    assert 'data-onboarding-start' in script
    assert 'data-onboarding-jump' in script
    assert 'data-onboarding-request-exit' in script
    assert 'class="is-exit" data-onboarding-request-exit>退出</button>' in script
    assert 'data-onboarding-confirm-exit' in script
    assert 'data-onboarding-cancel-exit' in script
    assert 'function renderExitConfirmation()' in script
    assert '要退出新手教程吗？' in script
    assert '确认退出' in script
    assert '继续教程' in script
    assert 'data-onboarding-close aria-label="暂时收起教程"' in script
    assert 'if (action.hasAttribute("data-onboarding-confirm-exit"))' in script
    assert 'if (action.hasAttribute("data-onboarding-request-exit"))' in script
    assert 'role="dialog"' in script
    assert 'aria-modal="false"' in script
    assert 'scheduleCardPosition(step)' in script
    assert '新手提示' in script
    assert 'const beaconLeft = targetRect.right - hostRect.left - 2;' in script
    assert 'const beaconTop = targetRect.top - hostRect.top + 2;' in script
    assert 'const target = activeStepTarget(step);' in script
    assert 'if (!target || !beaconHost) return;' in script
    assert 'if (!shouldShow || candidate !== target) delete candidate.dataset.onboardingTarget;' in script
    assert 'activeEntryTarget(step)?.click();' in script
    assert 'waitForStepTarget(step).then((nextTarget)' in script
    assert 'target.click();' not in script
    assert 'runtime.observer.observe(document.body, { childList: true, subtree: true });' in script
    assert '已完成全部提示' in script
    assert '以后可在首页标题栏的“教程”按钮重新查看。' in script
    assert 'data-onboarding-locate' in script
    assert 'scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" })' in script


def test_onboarding_visuals_are_subtle_responsive_and_motion_safe():
    styles = ONBOARDING_CSS_PATH.read_text(encoding="utf-8")

    assert '.console-onboarding-beacon' in styles
    assert '.console-onboarding-edge-launcher' in styles
    assert '.console-onboarding-home-launcher' in styles
    assert '.site-header .console-onboarding-launcher' not in styles
    assert 'background: #1684aa' in styles
    assert 'z-index: 1450' in styles
    assert '@keyframes console-onboarding-beacon-pulse' in styles
    assert '.console-onboarding-card' in styles
    assert '.is-onboarding-focus' in styles
    assert '@media (max-width: 820px)' in styles
    assert '@media (prefers-reduced-motion: reduce)' in styles
    assert 'pointer-events: none' in styles
    assert '.console-onboarding-card' in styles and 'pointer-events: auto' in styles
    assert 'width: 18px !important' in styles
    assert 'width: min(238px, calc(100vw - 20px))' in styles
    assert 'height: 18px !important' in styles
    assert 'z-index: 20' in styles
    assert 'overflow: visible !important' in styles
    assert '.console-onboarding-card.is-completion' in styles
    assert '.console-onboarding-home-launcher.is-located' in styles
    assert '.console-onboarding-home-launcher svg' in styles
    assert '.console-onboarding-home-slot' not in styles
    assert 'flex-wrap: nowrap' in styles
    assert 'min-height: 23px' in styles
    assert '.console-onboarding-actions button.is-exit' in styles
    assert '.console-onboarding-card.is-exit-confirmation' in styles
    assert '.console-onboarding-dismiss' not in styles
