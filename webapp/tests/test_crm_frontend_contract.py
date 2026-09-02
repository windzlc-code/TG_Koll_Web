from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "modules" / "crm" / "frontend"
NAVIGATION = (ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")
NAVIGATION_CSS = (ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.css").read_text(encoding="utf-8")


def test_crm_shell_is_native_and_uses_shared_navigation():
    shell = (ROOT / "webapp" / "static" / "crm.html").read_text(encoding="utf-8")
    assert 'data-site-page="crm"' in shell
    assert 'data-site-mode="public"' in shell
    assert 'data-site-auth-state="pending"' in shell
    assert '/assets/opc/site-navigation.js' in shell
    assert '/assets/fixed-light.css' in shell
    assert '<iframe' not in shell.lower()
    assert '127.0.0.1' not in shell
    assert ':8090' not in shell
    assert ':8091' not in shell


def test_shared_navigation_adds_crm_immediately_after_console():
    desktop = NAVIGATION.index('navLink({ key: "console", href: "/console.html", current })')
    crm = NAVIGATION.index('navLink({ key: "crm", href: "/crm.html", current })', desktop)
    about = NAVIGATION.index('navLink({ key: "aboutVecto", href: "/about-vecto.html", current })', crm)
    assert desktop < crm < about
    mobile_console = NAVIGATION.index('{ group: "mobileWorkspace", key: "console", href: "/console.html" }')
    mobile_crm = NAVIGATION.index('{ group: "mobileWorkspace", key: "crm", href: "/crm.html" }', mobile_console)
    assert mobile_crm > mobile_console


def test_crm_navigation_entry_is_always_visible_and_keeps_auth_boundary():
    visibility = NAVIGATION[NAVIGATION.index("async function syncCrmEntryVisibility"):NAVIGATION.index("function syncPublicAdminEntry")]
    assert 'const initiallyHidden = key === "crm" ? " hidden" : "";' not in NAVIGATION
    assert 'const adminIdentity = currentSessionMode === "admin"' not in visibility
    assert "entry.hidden = false" in visibility
    assert 'fetchAccountJson("/api/crm/v1/bootstrap")' not in visibility

    source_shell = (FRONTEND / "index.html").read_text(encoding="utf-8")
    production_shell = (ROOT / "webapp" / "static" / "crm.html").read_text(encoding="utf-8")
    assert 'data-site-mode="public"' in source_shell
    assert 'data-site-auth-state="pending"' in source_shell
    assert 'data-crm-entry hidden' not in source_shell
    assert '>采集工作台</span>' in source_shell
    for control in (
        "data-site-mobile-menu",
        "data-site-subscription-entry",
        "data-site-language-toggle",
        "data-open-login",
    ):
        assert control in source_shell
        assert control in production_shell
    assert 'X-Admin-Workspace-User-ID' in (FRONTEND / "src" / "api.ts").read_text(encoding="utf-8")
    assert "function installAdminEntry" in NAVIGATION
    assert 'document.querySelectorAll("[data-site-header]")' in NAVIGATION[NAVIGATION.index("function syncPublicAdminEntry"):]
    assert 'header.dataset.siteMode || "public"' in NAVIGATION
    assert "[data-site-global-controls]" in NAVIGATION[NAVIGATION.index("function installAdminEntry"):NAVIGATION.index("function syncPublicAdminEntry")]
    assert '["console", "crm"].includes(page)' not in NAVIGATION


def test_crm_and_shared_navigation_reject_legacy_green_palette():
    crm_css = (FRONTEND / "src" / "styles.css").read_text(encoding="utf-8").lower()
    shared_css = NAVIGATION_CSS.lower()
    rejected = ("#0a817f", "#77d8c3", "#087f72", "rgba(119, 216, 195", "rgba(35, 134, 111")
    for token in rejected:
        assert token not in crm_css
        assert token not in shared_css


def test_crm_production_assets_are_built_with_content_hashes():
    shell = (ROOT / "webapp" / "static" / "crm.html").read_text(encoding="utf-8")
    assert '/assets/crm/assets/index-' in shell
    assert (ROOT / "webapp" / "static" / "assets" / "crm" / ".vite" / "manifest.json").is_file()


def test_crm_page_and_container_use_native_authenticated_single_service_runtime():
    server = (ROOT / "webapp" / "server.py").read_text(encoding="utf-8")
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    entrypoint = (ROOT / "docker" / "entrypoint.sh").read_text(encoding="utf-8")
    assert '@app.get("/crm.html"' in server
    assert "effective_module_state" in server
    assert "_get_session_user_allowing_password_change" in server
    assert "install_crm(" in server
    assert 'raise HTTPException(status_code=403, detail="administrator workspace access required")' in server
    assert 'detail="administrator access required"' not in server
    assert "def _require_admin_operator" in (ROOT / "webapp" / "crm" / "router.py").read_text(encoding="utf-8")
    assert "_require_admin_operator(user)" not in (ROOT / "webapp" / "crm" / "router.py").read_text(encoding="utf-8")
    assert "CRM_ENABLED=0" in dockerfile
    assert "EXPOSE 8001" in dockerfile
    assert "8090" not in dockerfile and "8091" not in dockerfile and "EXPOSE 3000" not in dockerfile
    assert "uvicorn" in entrypoint and "--port \"$WEB_PORT\"" in entrypoint


def test_blocked_capabilities_are_runtime_data_not_visual_placeholders():
    capability_source = (ROOT / "webapp" / "crm" / "capabilities.py").read_text(encoding="utf-8")
    app_source = (FRONTEND / "src" / "App.tsx").read_text(encoding="utf-8")
    assert '"direct_message_batch"' in capability_source
    assert '"instagram_group_management"' in capability_source
    assert '"legacy_ai_secret_config"' in capability_source
    assert '"enabled": False' in capability_source
    assert "bootstrap.capabilities" in app_source
    assert "workflowActionByView" in app_source
    assert "crmApi.preflight" in app_source
    assert "preflight_token" in app_source


def test_crm_frontend_has_cursor_review_and_single_poll_contracts():
    app_source = (FRONTEND / "src" / "App.tsx").read_text(encoding="utf-8")
    api_source = (FRONTEND / "src" / "api.ts").read_text(encoding="utf-8")
    polling_source = (FRONTEND / "src" / "useTaskPolling.ts").read_text(encoding="utf-8")
    helper_source = (FRONTEND / "src" / "runtime-helpers.js").read_text(encoding="utf-8")
    assert "next_cursor" in api_source
    assert "mergeCursorPage" in app_source
    assert "crmApi.reviewAction" in app_source
    assert "/actions/${encodeURIComponent(actionId)}/review" in api_source
    assert "createSinglePollScheduler" in polling_source
    assert 'document.visibilityState === "visible" ? 8_000 : 20_000' in polling_source
    assert "if (inFlight)" in helper_source


def test_crm_admin_access_editor_requires_loading_current_permission():
    admin_html = (ROOT / "webapp" / "static" / "admin.html").read_text(encoding="utf-8")
    admin_js = (ROOT / "webapp" / "static" / "assets" / "admin.js").read_text(encoding="utf-8")
    assert 'id="btnCrmUserAccessSave" type="submit" disabled' in admin_html
    assert 'id="btnCrmUserAccessLoad"' in admin_html
    assert "loadCrmUserAccess" in admin_js
    assert "crmUserAccessLoadedId" in admin_js
    assert "回收 CRM 权限" in admin_js


def test_crm_admin_center_is_novice_friendly_and_hides_technical_payloads():
    admin_html = (ROOT / "webapp" / "static" / "admin.html").read_text(encoding="utf-8")
    admin_js = (ROOT / "webapp" / "static" / "assets" / "admin.js").read_text(encoding="utf-8")
    admin_css = (ROOT / "webapp" / "static" / "assets" / "style.css").read_text(encoding="utf-8")
    crm_section = admin_html[
        admin_html.index('id="secCrm"') : admin_html.index('id="secRuntime"')
    ]

    for copy in (
        "按步骤管理客户 CRM",
        "打开 CRM 工作台",
        "确认服务",
        "开通客户",
        "导入资料",
        "第一步：检查文件",
        "第二步：确认导入",
        "只显示易懂的状态，不显示技术代码",
    ):
        assert copy in crm_section

    for technical_copy in (
        "CRM_ENABLED",
        "dry-run",
        "批次 ID",
        "crm_imports",
        "source_sha256",
        "code-box",
    ):
        assert technical_copy not in crm_section

    assert 'id="crmImportBatchId" type="hidden"' in crm_section
    assert "renderCrmImportStatus" in admin_js
    assert "crmFriendlyError" in admin_js
    assert "JSON.stringify(payload?.items" not in admin_js
    assert ".page-admin #secCrm .crm-quick-guide" in admin_css
    assert ".page-admin #secCrm .crm-import-record" in admin_css
