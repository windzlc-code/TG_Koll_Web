from pathlib import Path

from fastapi import FastAPI

from webapp.fingerprint_login_admin import register_fingerprint_login_admin_routes


ROOT = Path(__file__).resolve().parents[1]


def test_fingerprint_login_routes_are_registered_by_the_main_app() -> None:
    server_source = (ROOT / "server.py").read_text(encoding="utf-8")

    assert "from .fingerprint_login_admin import register_fingerprint_login_admin_routes" in server_source
    assert "register_fingerprint_login_admin_routes(app)" in server_source


def test_fingerprint_login_module_exposes_accounts_and_sessions_routes() -> None:
    app = FastAPI()
    register_fingerprint_login_admin_routes(app)
    paths = {route.path for route in app.routes}

    assert "/api/admin/fingerprint-login/accounts" in paths
    assert "/api/admin/fingerprint-login/sessions" in paths
    assert "/api/admin/fingerprint-login/accounts/{account_id}/open_login" in paths


def test_admin_page_loads_the_account_login_workspace_assets() -> None:
    markup = (ROOT / "static" / "admin.html").read_text(encoding="utf-8")
    script = (ROOT / "static" / "assets" / "admin.js").read_text(encoding="utf-8")

    assert '/assets/admin-fingerprint-login.css?v=__ADMIN_FINGERPRINT_LOGIN_CSS_VERSION__' in markup
    assert '/assets/admin-fingerprint-login.js?v=__ADMIN_FINGERPRINT_LOGIN_JS_VERSION__' in markup
    assert 'data-page="fingerprintLogin">账号与登录</button>' in markup
    assert 'id="fpAccountGrid"' in markup
    assert 'id="fpLiveBrowserSessions"' in markup
    assert 'fingerprintLogin: "账号与登录"' in script
    assert 'typeof loadFingerprintLoginAccounts === "function"' in script
