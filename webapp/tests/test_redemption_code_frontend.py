from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ADMIN_HTML = (ROOT / "webapp" / "static" / "admin.html").read_text(encoding="utf-8")
ADMIN_JS = (ROOT / "webapp" / "static" / "assets" / "admin.js").read_text(encoding="utf-8")
PROFILE_HTML = (ROOT / "webapp" / "static" / "profile.html").read_text(encoding="utf-8")
PROFILE_JS = (ROOT / "webapp" / "static" / "assets" / "profile.js").read_text(encoding="utf-8")
CONSOLE_HTML = (ROOT / "webapp" / "static" / "console.html").read_text(encoding="utf-8")
SITE_NAVIGATION_JS = (ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")
SITE_NAVIGATION_CSS = (ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.css").read_text(encoding="utf-8")
STYLE_CSS = (ROOT / "webapp" / "static" / "assets" / "style.css").read_text(encoding="utf-8")


def test_admin_redemption_workspace_has_its_own_navigation_page():
    assert 'data-page="redemptionCodes">兑换码</button>' in ADMIN_HTML
    assert 'id="secRedemptionCodes" data-page-view="redemptionCodes"' in ADMIN_HTML
    assert 'id="redemptionCodeForm"' in ADMIN_HTML
    assert 'id="btnCheckRedemptionCodes"' in ADMIN_HTML
    assert 'id="redemptionCodeBody"' in ADMIN_HTML
    assert 'redemptionCodes: "兑换码"' in ADMIN_JS
    assert 'secRedemptionCodes: "redemptionCodes"' in ADMIN_JS
    assert 'if (nextPage === "redemptionCodes")' in ADMIN_JS
    assert "/api/admin/billing/redemption-codes" in ADMIN_JS
    assert "完整代码仅显示一次" in ADMIN_HTML
    assert "redemptionCodeCreateInFlight" in ADMIN_JS
    assert 'submit.disabled = true' in ADMIN_JS


def test_profile_does_not_contain_a_second_redemption_entry_or_flow():
    assert 'id="profileRedeemCode"' not in PROFILE_HTML
    assert "/api/billing/redemption-codes/redeem" not in PROFILE_JS
    assert "#redemption-code" not in PROFILE_JS


def test_account_drawer_opens_the_shared_redemption_dialog_in_place():
    assert 'data-site-open-redemption data-site-copy="redeemCode"' in CONSOLE_HTML
    assert 'data-site-open-redemption data-site-copy="redeemCode"' in SITE_NAVIGATION_JS
    assert 'redeemCode: "兑换码"' in SITE_NAVIGATION_JS
    assert 'window.location.assign("/profile.html#redemption-code")' not in SITE_NAVIGATION_JS
    assert "openRedemptionCodeDialog();" in SITE_NAVIGATION_JS
    assert "/api/billing/redemption-codes/redeem" in SITE_NAVIGATION_JS
    assert "showIcon: false" in SITE_NAVIGATION_JS
    assert 'dialogClass: "is-form is-redemption-success"' in SITE_NAVIGATION_JS
    assert ".site-auth-feedback.is-redemption-success .site-auth-feedback-icon" in SITE_NAVIGATION_CSS


def test_admin_redemption_controls_share_one_aligned_row_with_spacing():
    assert ".page-admin #secRedemptionCodes .admin-billing-toolbar" in STYLE_CSS
    assert "align-items: flex-end" in STYLE_CSS
    assert "column-gap: 14px" in STYLE_CSS
