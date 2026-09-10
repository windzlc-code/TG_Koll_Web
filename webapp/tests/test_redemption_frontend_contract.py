from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_static(name: str) -> str:
    return (ROOT / "static" / name).read_text(encoding="utf-8")


def read_asset(name: str) -> str:
    return (ROOT / "static" / "assets" / name).read_text(encoding="utf-8")


def test_profile_and_account_menus_expose_redemption_entry_points():
    console_html = read_static("console.html")
    navigation = read_asset("opc/site-navigation.js")

    assert 'data-site-open-redemption' in console_html
    assert 'data-site-open-redemption' in navigation
    assert 'openRedemptionCodeDialog' in navigation
    assert '/api/billing/redemption-codes/redeem' in navigation


def test_redemption_admin_module_keeps_controls_and_status_contract():
    admin_html = read_static("admin.html")
    admin_js = read_asset("admin.js")
    style_css = read_asset("style.css")

    for marker in (
        'id="secRedemptionCodes"',
        'id="redemptionCodeForm"',
        'id="redemptionCodeBody"',
        'id="btnCheckRedemptionCode"',
    ):
        assert marker in admin_html
    for marker in (
        "/api/admin/billing/redemption-codes",
        "redemptionCodeBody",
        "redemptionCodeStatus",
        "data-redemption-action",
    ):
        assert marker in admin_js
    for marker in ("is-active", "is-redeemed", "is-revoked"):
        assert marker in style_css
