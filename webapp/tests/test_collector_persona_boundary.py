from pathlib import Path


STATIC_ROOT = Path(__file__).resolve().parents[1] / "static"


def read_static(relative: str) -> str:
    return (STATIC_ROOT / relative).read_text(encoding="utf-8")


def test_collector_boundary_assets_exist_and_strip_persona_product_surfaces() -> None:
    script = read_static("assets/collector-boundary.js")
    styles = read_static("assets/collector-boundary.css")

    assert "stripPersonaProductSurfaces" in script
    assert "account-pool-bound-persona" in script
    assert "accountPoolPersonaSidebar" in script
    assert "data-account-pool-bind-persona" in script
    assert "installCollectorLoginMonitorTab" in script
    assert "登录监控" in script

    assert "html[data-deployment-role=\"collector\"] .account-pool-bound-persona" in styles
    assert "html[data-deployment-role=\"collector\"] .account-pool-persona-shell" in styles
    assert 'html[data-deployment-role="collector"] [data-view="persona_dashboard"]' in styles


def test_shared_console_gates_persona_pool_ui_behind_collector_role() -> None:
    script = read_static("assets/console.js")
    html = read_static("console.html")

    assert "const COLLECTOR_DEPLOYMENT = DEPLOYMENT_ROLE === \"collector\";" in script
    assert "function consoleModules()" in script
    assert "COLLECTOR_CONSOLE_MODULES" in script
    assert "if (COLLECTOR_DEPLOYMENT) return \"\";" in script
    assert "COLLECTOR_DEPLOYMENT || isPersonaSettings" in script
    assert 'label: COLLECTOR_DEPLOYMENT ? "热点抓取" : "推文生成"' in script
    assert 'label: COLLECTOR_DEPLOYMENT ? "账号与登录" : "账号管理"' in script

    assert 'name="deployment-role" content="__DEPLOYMENT_ROLE__"' in html
    assert "data-deployment-role=\"__DEPLOYMENT_ROLE__\"" in html
    assert "__COLLECTOR_BOUNDARY_ASSETS__" in html
    assert "/assets/persona-dashboard.js" in html


def test_collector_admin_no_longer_links_into_product_persona_console() -> None:
    dashboard = read_static("collector-admin.html")
    assert "进入完整账号管理" not in dashboard
    assert "进入完整代理管理" not in dashboard
    assert "进入采集账号管理" in dashboard
    assert "进入采集代理管理" in dashboard
