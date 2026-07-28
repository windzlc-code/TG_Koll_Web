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
