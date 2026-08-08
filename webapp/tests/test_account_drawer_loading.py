from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
NAVIGATION = (ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.js").read_text(encoding="utf-8")
CONSOLE = (ROOT / "webapp" / "static" / "console.html").read_text(encoding="utf-8")
STYLES = (ROOT / "webapp" / "static" / "assets" / "opc" / "site-navigation.css").read_text(encoding="utf-8")
FIXED_LIGHT = (ROOT / "webapp" / "static" / "assets" / "fixed-light.css").read_text(encoding="utf-8")


class AccountDrawerLoadingTests(unittest.TestCase):
    def test_drawer_fetches_identity_when_opened_before_console_bootstrap(self):
        self.assertIn('async function loadAccountProfile()', NAVIGATION)
        self.assertIn('fetchAccountJson("/api/auth/me")', NAVIGATION)
        self.assertIn('if (accountProfileLoadPromise) return accountProfileLoadPromise;', NAVIGATION)
        self.assertIn('void loadAccountProfile().then(() => loadAccountBilling({ force: true }));', NAVIGATION)

    def test_drawer_renders_a_local_pending_state_without_a_global_overlay(self):
        self.assertIn('const identityLoading = accountProfileLoading && !currentAccount;', NAVIGATION)
        self.assertIn('node.setAttribute("aria-busy", identityLoading ? "true" : "false");', NAVIGATION)
        self.assertIn('identityLoading ? labels.billingLoading : labels.profileSignatureEmpty', NAVIGATION)

    def test_drawer_keeps_email_with_the_personal_profile_fields(self):
        self.assertIn('data-site-account-email', NAVIGATION)
        self.assertIn('profileEmailEmpty', NAVIGATION)
        self.assertIn('.site-account-profile-email {', STYLES)

    def test_header_avatar_has_its_own_circular_clip(self):
        header_avatar = STYLES.split('.site-user .site-user-avatar {', 1)[1].split('}', 1)[0]
        self.assertIn('width: 20px;', header_avatar)
        self.assertIn('height: 20px;', header_avatar)
        self.assertIn('border-radius: 50%;', header_avatar)
        self.assertIn('overflow: hidden;', header_avatar)
        self.assertIn('.site-user-avatar.has-avatar {', STYLES)
        self.assertIn('node.classList.toggle("has-avatar", Boolean(avatarUrl));', NAVIGATION)

    def test_avatar_renderer_falls_back_to_the_shared_account_icon_if_an_image_fails(self):
        self.assertIn('image.addEventListener("error"', NAVIGATION)
        self.assertIn('node.innerHTML = accountIcon(className);', NAVIGATION)

    def test_account_drawer_avatar_clips_uploaded_images_to_its_existing_circle(self):
        drawer_avatar = STYLES.split('.site-account-avatar {', 1)[1].split('}', 1)[0]
        self.assertIn('border-radius: 50%;', drawer_avatar)
        self.assertIn('overflow: hidden;', drawer_avatar)

    def test_billing_metrics_use_one_svg_divided_information_board(self):
        self.assertEqual(CONSOLE.count('class="site-account-billing-icon"'), 6)
        self.assertEqual(NAVIGATION.count('class="site-account-billing-icon"'), 6)
        self.assertIn('.site-account-billing-card:nth-child(2n)', STYLES)
        self.assertIn('.site-account-billing-card:nth-child(n + 3)', STYLES)
        self.assertIn('grid-template-columns: 20px minmax(0, 1fr);', STYLES)
        self.assertIn('linear-gradient(135deg, rgba(29, 52, 70, .72)', STYLES)
        self.assertIn('border: 1px solid transparent;', STYLES)
        self.assertIn('.site-account-billing-icon {\n  display: block;', STYLES)

    def test_billing_panel_has_one_border_owner_without_legacy_overrides(self):
        self.assertEqual(STYLES.count('.site-account-billing {'), 1)
        self.assertEqual(STYLES.count('.site-account-billing-state {'), 1)
        self.assertEqual(STYLES.count('.site-account-billing-card strong {'), 1)
        self.assertNotIn('.site-account-profile-fields + .site-account-billing::before', STYLES)
        self.assertNotIn('.site-account-billing-card', FIXED_LIGHT)


if __name__ == "__main__":
    unittest.main()
