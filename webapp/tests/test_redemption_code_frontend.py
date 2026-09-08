from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ADMIN_HTML = (ROOT / "webapp" / "static" / "admin.html").read_text(encoding="utf-8")
ADMIN_JS = (ROOT / "webapp" / "static" / "assets" / "admin.js").read_text(encoding="utf-8")
PROFILE_HTML = (ROOT / "webapp" / "static" / "profile.html").read_text(encoding="utf-8")
PROFILE_JS = (ROOT / "webapp" / "static" / "assets" / "profile.js").read_text(encoding="utf-8")


def test_admin_redemption_workspace_is_part_of_existing_billing_page():
    assert 'id="secPricing"' in ADMIN_HTML
    assert 'id="redemptionCodeForm"' in ADMIN_HTML
    assert 'id="btnCheckRedemptionCodes"' in ADMIN_HTML
    assert 'id="redemptionCodeBody"' in ADMIN_HTML
    assert "/api/admin/billing/redemption-codes" in ADMIN_JS
    assert "完整代码仅显示一次" in ADMIN_HTML


def test_profile_uses_shared_feedback_dialog_for_redemption():
    assert 'id="profileRedeemCode"' in PROFILE_HTML
    assert "/api/billing/redemption-codes/redeem" in PROFILE_JS
    assert 'dialogClass: "is-form"' in PROFILE_JS
    assert 'kind: "success"' in PROFILE_JS
    assert "已到账 {added} 点" in PROFILE_JS
    assert 'profileRedeemCode").hidden = isAdminSession || Boolean(account?.is_admin)' in PROFILE_JS
