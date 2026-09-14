from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ADMIN_HTML = (ROOT / "webapp" / "static" / "admin.html").read_text(encoding="utf-8")
ADMIN_JS = (ROOT / "webapp" / "static" / "assets" / "admin.js").read_text(encoding="utf-8")
PROFILE_HTML = (ROOT / "webapp" / "static" / "profile.html").read_text(encoding="utf-8")
PROFILE_JS = (ROOT / "webapp" / "static" / "assets" / "profile.js").read_text(encoding="utf-8")
PROFILE_CSS = (ROOT / "webapp" / "static" / "assets" / "profile.css").read_text(encoding="utf-8")
CONSOLE_HTML = (ROOT / "webapp" / "static" / "console.html").read_text(encoding="utf-8")
SITE_NAVIGATION_JS = (ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")
SITE_NAVIGATION_CSS = (ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.css").read_text(encoding="utf-8")
STYLE_CSS = (ROOT / "webapp" / "static" / "assets" / "style.css").read_text(encoding="utf-8")
PRICING_JS = (ROOT / "webapp" / "static" / "assets" / "opc" / "pricing.js").read_text(encoding="utf-8")


def test_admin_redemption_workspace_has_its_own_navigation_page():
    assert 'data-page="redemptionCodes">兑换邀请</button>' in ADMIN_HTML
    assert 'id="secRedemptionCodes" data-page-view="redemptionCodes"' in ADMIN_HTML
    assert 'id="redemptionCodeForm"' in ADMIN_HTML
    assert 'id="btnCheckRedemptionCode"' in ADMIN_HTML
    assert 'id="btnCheckRedemptionCodes"' in ADMIN_HTML
    assert 'id="redemptionCodeCheckResult"' in ADMIN_HTML
    assert 'id="redemptionCodeBody"' in ADMIN_HTML
    assert 'redemptionCodes: "兑换邀请"' in ADMIN_JS
    assert 'secRedemptionCodes: "redemptionCodes"' in ADMIN_JS
    assert 'if (nextPage === "redemptionCodes")' in ADMIN_JS
    assert "/api/admin/billing/redemption-codes" in ADMIN_JS
    assert "完整代码仅显示一次" in ADMIN_HTML
    assert "redemptionCodeCreateInFlight" in ADMIN_JS
    assert '"/api/admin/billing/redemption-codes/check"' in ADMIN_JS
    assert 'el("btnCheckRedemptionCode")?.addEventListener' in ADMIN_JS
    assert 'submit.disabled = true' in ADMIN_JS


def test_invitation_workspace_extends_redemption_without_replacing_it():
    assert 'data-redemption-invite-tab="codes"' in ADMIN_HTML
    assert 'data-redemption-invite-tab="invitations"' in ADMIN_HTML
    assert 'id="invitationSettingsForm"' in ADMIN_HTML
    assert 'id="invitationBody"' in ADMIN_HTML
    assert "/api/admin/invitations/settings" in ADMIN_JS
    assert "/api/admin/invitations?" in ADMIN_JS
    assert 'data-profile-open-invitation' in PROFILE_HTML
    assert "/api/invitations/me" in PROFILE_JS
    assert "/api/invitations/code" in PROFILE_JS
    assert 'data-site-open-invitation data-site-copy="inviteCode"' in CONSOLE_HTML
    assert 'data-site-open-invitation data-site-copy="inviteCode"' in SITE_NAVIGATION_JS


def test_invitation_admin_uses_real_statuses_versioned_limits_and_its_own_table_layout():
    for value in ("pending", "rewarded", "pending_permission", "revoked"):
        assert f'<option value="{value}">' in ADMIN_HTML
    for field_id in ("inviterDailyLimit", "sourceDailyLimit"):
        assert f'id="{field_id}"' in ADMIN_HTML
    for key in ("inviter_daily_limit", "source_daily_limit", "expected_version"):
        assert key in ADMIN_JS
    assert 'class="table admin-billing-table admin-invitation-table"' in ADMIN_HTML
    assert ".page-admin #secRedemptionCodes .admin-invitation-table" in STYLE_CSS
    assert ".admin-invitation-table th:nth-child(1)" in STYLE_CSS


def test_profile_invitation_respects_disabled_permission_pending_and_paginates_records():
    assert 'id="profileInvitationPrevious"' in PROFILE_HTML
    assert 'id="profileInvitationNext"' in PROFILE_HTML
    assert "invitationOffset" in PROFILE_JS
    assert "invitationTotal" in PROFILE_JS
    assert "next_offset" in PROFILE_JS
    assert '`/api/invitations/me?${query}`' in PROFILE_JS
    assert 'state.invitation?.enabled === false' in PROFILE_JS
    assert 'internal_status' in PROFILE_JS
    assert 'viewer_role' in PROFILE_JS
    assert 'pending_permission' in PROFILE_JS
    assert 'permissionPending' in PROFILE_JS
    assert 'invitationRecordRole' in PROFILE_JS
    assert ".profile-invitation-pagination" in PROFILE_CSS
    assert ".profile-invitation-share-grid" in PROFILE_CSS
    assert "grid-template-columns: minmax(0, 1fr);" in PROFILE_CSS


def test_profile_invitation_has_vecto_visual_story_without_changing_action_ids():
    for marker in (
        "profile-invitation-hero-visual",
        "profile-invitation-network",
        "profile-invitation-benefits",
        "profile-invitation-journey",
        "profile-invitation-value-shell--code",
    ):
        assert marker in PROFILE_HTML
        assert f".{marker}" in PROFILE_CSS
    for action_id in (
        "profileGenerateInvitation",
        "profileCopyInvitationCode",
        "profileCopyInvitationLink",
        "profileInvitationPrevious",
        "profileInvitationNext",
        "profileInvitationWorkbench",
    ):
        assert f'id="{action_id}"' in PROFILE_HTML
    assert 'class="profile-invitation-hero-actions"' in PROFILE_HTML
    assert ".profile-invitation-hero-actions" in PROFILE_CSS
    assert "@media (prefers-reduced-motion: reduce)" in PROFILE_CSS
    assert "invitationJourneyShare" in PROFILE_JS
    assert "invitationJourneyRegister" in PROFILE_JS
    assert "invitationJourneyReward" in PROFILE_JS
    assert 'classList.toggle("is-invitation-view", invitationView)' in PROFILE_JS
    assert 'profileText("invitationShareCopy", { link: normalizedLink })' in PROFILE_JS
    assert "profile-invitation-value-shell--message" in PROFILE_HTML
    assert ".profile-invitation-share-message" in PROFILE_CSS


def test_profile_does_not_contain_a_second_redemption_entry_or_flow():
    assert 'id="profileRedeemCode"' not in PROFILE_HTML
    assert "/api/billing/redemption-codes/redeem" not in PROFILE_JS
    assert "#redemption-code" not in PROFILE_JS
    assert "openRequestedRedemptionCodeDialog" not in PROFILE_JS


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
    assert "display: flex" in STYLE_CSS
    assert "flex-wrap: nowrap" in STYLE_CSS
    assert "align-items: flex-end" in STYLE_CSS
    assert "column-gap: 14px" in STYLE_CSS


def test_admin_redemption_statuses_keep_the_shared_billing_badge_palette():
    assert ".page-admin #secRedemptionCodes .admin-billing-status" in STYLE_CSS
    assert ".page-admin #secRedemptionCodes .admin-billing-status.is-active" in STYLE_CSS
    assert ".page-admin #secRedemptionCodes .admin-billing-status.is-redeemed" in STYLE_CSS
    assert ".page-admin #secRedemptionCodes .admin-billing-status.is-revoked" in STYLE_CSS
    assert 'active: "未兑换"' in ADMIN_JS
    assert 'option value="active">未兑换</option>' in ADMIN_HTML
    assert ".page-admin #secRedemptionCodes .admin-billing-status.is-active {\n  color: #8a5a08;" in STYLE_CSS
    assert "background: #fff6dc;" in STYLE_CSS
    assert "color: #1d4ed8" in STYLE_CSS
    assert "background: #eff6ff" in STYLE_CSS


def test_admin_redemption_list_has_compact_presets_pagination_and_record_actions():
    assert 'id="redemptionCodePageSize"' in ADMIN_HTML
    assert 'id="btnRedemptionCodePrevious"' in ADMIN_HTML
    assert 'id="btnRedemptionCodeNext"' in ADMIN_HTML
    assert "redemptionCodeOffset" in ADMIN_JS
    assert "redemptionCodeTotal" in ADMIN_JS
    assert "renderRedemptionCodePagination" in ADMIN_JS
    assert "/reveal" in ADMIN_JS
    assert "/delete" in ADMIN_JS
    assert 'redemptionCodeIconButton("view"' in ADMIN_JS
    assert 'redemptionCodeIconButton("copy"' in ADMIN_JS
    assert 'redemptionCodeIconButton("edit"' in ADMIN_JS
    assert 'id="redemptionCodeEditModal"' in ADMIN_HTML
    assert 'id="btnRedemptionCodeEditRevoke"' in ADMIN_HTML
    assert 'id="btnRedemptionCodeEditDelete"' in ADMIN_HTML
    assert "admin-redemption-detail" in ADMIN_JS
    assert ".admin-redemption-detail" in STYLE_CSS
    assert ".admin-redemption-icon-button" in STYLE_CSS
    assert "justify-content: center" in STYLE_CSS
    assert "min-height: 62px" in STYLE_CSS
    assert ".admin-redemption-pagination" in STYLE_CSS
    assert 'data-redemption-select-id' in ADMIN_JS
    assert 'id="redemptionCodeSelectAll"' in ADMIN_HTML
    assert "min-width: 1120px" in STYLE_CSS
    assert ".admin-redemption-table th" in STYLE_CSS
    assert "padding: 5px 7px" in STYLE_CSS
    assert ".admin-redemption-bulk-toolbar .admin-compact-button" in STYLE_CSS
    assert "width: 28px" in STYLE_CSS


def test_admin_redemption_presets_match_the_current_ntd_rules_and_use_fold_labels():
    expected = (
        ("31", "60 元 · 9.5折"),
        ("108", "200 元 · 9.2折"),
        ("357", "650 元 · 9折"),
        ("672", "1200 元 · 8.8折"),
        ("50", "100 元"),
        ("151", "300 元 · 9.9折"),
        ("255", "500 元 · 9.8折"),
        ("515", "1000 元 · 9.7折"),
    )
    for points, label in expected:
        assert f'data-points="{points}"' in ADMIN_HTML
        assert f'<small>{label}</small>' in ADMIN_HTML
    assert "2 台币 = 1 积分" in ADMIN_HTML
    assert "优惠 5%" not in ADMIN_HTML
    assert 'data-note="充值：100 元 → 50 点"' in ADMIN_HTML
    assert 'data-note="充值：100 元 → 50 点 · 10折"' not in ADMIN_HTML
    assert "function formatRedemptionCodeNote(item)" in ADMIN_JS
    assert "const isSubscription = /连续包月|订阅规则/.test(rawNote);" in ADMIN_JS
    assert "foldValue !== 10" in ADMIN_JS
    assert "foldValue.toFixed(1)}折" in ADMIN_JS


def test_public_pricing_uses_decimal_fold_not_percentage_points():
    assert 'return `${Number.isInteger(fold) ? fold : fold.toFixed(1)}折`;' in PRICING_JS
    assert 'return percent ? `${100 - percent} 折` : "原價";' not in PRICING_JS
