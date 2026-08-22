from pathlib import Path


STATIC_ROOT = Path(__file__).resolve().parents[1] / "static"


def read_static(relative: str) -> str:
    return (STATIC_ROOT / relative).read_text(encoding="utf-8")


def test_collector_pages_are_standalone_and_use_shared_assets() -> None:
    login = read_static("collector-login.html")
    dashboard = read_static("collector-admin.html")

    assert 'data-collector-page="login"' in login
    assert 'data-collector-page="dashboard"' in dashboard
    for document in (login, dashboard):
        assert '/assets/collector-admin.css' in document
        assert '/assets/collector-admin.js' in document
        assert "管理员采集节点" in document


def test_collector_dashboard_keeps_the_requested_modules_and_boundary_copy() -> None:
    dashboard = read_static("collector-admin.html")

    for view in ("crm", "hot", "accounts", "cookies", "proxies", "tasks", "system"):
        assert f'data-collector-view="{view}"' in dashboard
        assert f'data-collector-panel="{view}"' in dashboard

    assert dashboard.count("完整保留") >= 4
    assert "人设全量刷新" in dashboard
    assert "新机执行" in dashboard
    assert "用户自有账号" in dashboard
    assert "管理员采集账号池" in dashboard
    assert "进入采集账号管理" in dashboard
    assert "进入完整账号管理" not in dashboard
    assert 'href="/admin-console.html?view=accounts"' in dashboard


def test_collector_javascript_uses_only_existing_read_endpoints_for_summaries() -> None:
    script = read_static("assets/collector-admin.js")

    for endpoint in (
        "/api/auth/me",
        "/api/health",
        "/api/admin/modules/crm/health",
        "/api/admin/collector/overview",
        "/api/persona_dashboard/automation/overview",
        "/api/admin/sentiment/browser_auth/profiles",
    ):
        assert endpoint in script

    assert 'requestJson("/api/auth/admin-login"' in script
    assert 'requestJson("/api/auth/logout"' in script
    assert '"X-Admin-Console": "1"' in script
    assert 'href="/crm.html?admin_console=1"' in read_static("collector-admin.html")
    assert "Promise.all" in script
    assert "safeRequest" in script


def test_collector_summary_never_renders_secret_fields_or_raw_payloads() -> None:
    script = read_static("assets/collector-admin.js")

    forbidden = (
        "login_password",
        "totp_secret",
        "cookie.value",
        "profile_dir",
        "password_vault",
        "console.log",
        "console.debug",
        "JSON.stringify(overview",
        "JSON.stringify(profile",
    )
    for token in forbidden:
        assert token not in script

    assert "escapeHtml" in script
    assert "validCookieCount" in script
    assert "totp_configured" in script


def test_collector_styles_are_responsive_and_accessibility_aware() -> None:
    styles = read_static("assets/collector-admin.css")

    assert "@media (max-width: 820px)" in styles
    assert "@media (prefers-reduced-motion: reduce)" in styles
    assert "--collector-amber" in styles
    assert "--collector-cyan" in styles
