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
    assert "headerNav.dataset.collectorUnified !== \"true\"" in script
    assert "collectorSurfaceReady" in script
    assert "collectorRedirectsReady" in script
    assert "collectorStandaloneRedirected" in script
    assert "applyDom" in script
    assert "applyRedirectsOnce" in script
    # Redirects must not run on every MutationObserver tick; that reloads /admin.html.
    observer_idx = script.rindex("new MutationObserver")
    observer_chunk = script[observer_idx:observer_idx + 280]
    assert "applyDom()" in observer_chunk
    assert "enforceStandaloneAdmin()" not in observer_chunk
    assert "applyRedirectsOnce()" not in observer_chunk

    assert "pruneCollectorUnusedProxyMarket" in script
    assert '["proxyMarket", "代理 IP"]' not in script
    assert '["crm", "CRM 后端"]' not in script
    assert "html[data-deployment-role=\"collector\"] #secProxyMarket" in styles
    assert "html[data-deployment-role=\"collector\"] #secCrm" in styles
    assert "html[data-deployment-role=\"collector\"] .account-pool-bound-persona" in styles
    assert "html[data-deployment-role=\"collector\"] .account-pool-persona-shell" in styles
    assert 'html[data-deployment-role="collector"] [data-view="persona_dashboard"]' in styles


def test_admin_init_does_not_redirect_admin_html_to_admin_loop() -> None:
    script = read_static("assets/admin.js")
    assert "location.href = \"/admin\"" not in script
    assert "document.body.classList.contains(\"page-admin\")" in script
    assert 'path === "/admin.html"' in script
    assert 'collectorDeployment ? "/?login=1" : "/admin"' in script


def test_admin_js_renders_grouped_collector_proxy_traffic() -> None:
    script = read_static("assets/admin.js")
    assert "/api/admin/collector-proxy/traffic" in script
    assert "renderCollectorProxyTrafficGroup" in script
    assert "collectorProxyTraffic${prefix}Total" in script
    assert 'prefix === "Rotating"' in script
    assert "btnRefreshCollectorProxyTraffic" in script
    assert "COLLECTOR_PROXY_TRAFFIC_POLL_INTERVAL_MS" in script
    assert 'el("collectorProxyTrafficCard")' in script


def test_collector_session_boundary_does_not_bounce_through_admin() -> None:
    script = read_static("assets/console.js")
    assert "const collectorDeployment = typeof COLLECTOR_DEPLOYMENT !== \"undefined\" && COLLECTOR_DEPLOYMENT;" in script
    assert "const loginTarget = isAdminConsole && !collectorDeployment" in script
    assert 'location.href = COLLECTOR_DEPLOYMENT ? "/admin-console.html#operations" : "/admin.html"' in script


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
