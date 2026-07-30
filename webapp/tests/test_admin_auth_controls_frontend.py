import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AdminAuthControlsFrontendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "static" / "admin.html").read_text(encoding="utf-8")
        cls.script = (ROOT / "static" / "assets" / "admin.js").read_text(encoding="utf-8")
        cls.styles = (ROOT / "static" / "assets" / "style.css").read_text(encoding="utf-8")

    def test_account_list_exposes_auth_and_email_filters(self):
        for field_id in ("adminUserAuthMethod", "adminUserEmailStatus"):
            self.assertIn(f'id="{field_id}"', self.html)
        filters = self.script[
            self.script.index("function readUserListFilters")
            : self.script.index("function syncUserBatchSelection")
        ]
        self.assertIn("auth_method:", filters)
        self.assertIn("email_status:", filters)
        self.assertIn('value="google"', self.html)
        self.assertIn('value="verified"', self.html)

    def test_account_list_and_detail_render_auth_contract_fields(self):
        for field in (
            "verified_email",
            "email_verified_at",
            "auth_methods",
            "last_login_method",
        ):
            self.assertIn(field, self.script)
        for control_id in (
            "userAuthSection",
            "userVerifiedEmail",
            "userPasswordLoginEnabled",
            "userGoogleLoginEnabled",
            "btnSaveUserAuthMethods",
            "btnUnlinkUserGoogle",
            "userAuthMethodMsg",
        ):
            self.assertIn(f'id="{control_id}"', self.html)

    def test_auth_method_mutations_use_the_admin_api_contract(self):
        save = self.script[
            self.script.index("async function saveSelectedUserAuthMethods")
            : self.script.index("async function unlinkSelectedUserGoogle")
        ]
        self.assertIn("/auth-methods`", save)
        self.assertIn('method: "PATCH"', save)
        self.assertIn("password_login_enabled", save)
        self.assertIn("google_login_enabled", save)
        self.assertIn("confirm(", save)

        unlink = self.script[
            self.script.index("async function unlinkSelectedUserGoogle")
            : self.script.index("function clearUserPasswordReset")
        ]
        self.assertIn("/oauth-identities/google`", unlink)
        self.assertIn('method: "DELETE"', unlink)
        self.assertIn("confirm(", unlink)
        self.assertNotIn("verification_code", unlink)
        self.assertNotIn("access_token", unlink)
        self.assertNotIn("id_token", unlink)

    def test_runtime_form_persists_global_auth_switches_and_credential_status(self):
        for field_id in (
            "rtEmailRegistrationEnabled",
            "rtGoogleLoginEnabled",
            "rtGoogleAuthStatus",
        ):
            self.assertIn(f'id="{field_id}"', self.html)
        for field in (
            "auth_email_registration_enabled",
            "auth_google_login_enabled",
            "auth_google_oauth_configured",
        ):
            self.assertIn(field, self.script)
        self.assertIn("syncRuntimeAuthProviderAvailability", self.script)
        self.assertIn("googleToggle.disabled = !configured && !googleToggle.checked", self.script)

    def test_auth_controls_use_admin_scoped_responsive_styles(self):
        for selector in (
            ".page-admin .admin-user-auth-cell {",
            ".page-admin .admin-user-auth-section {",
            ".page-admin .admin-user-auth-methods {",
            ".page-admin .admin-runtime-auth-status {",
        ):
            self.assertIn(selector, self.styles)
        self.assertIn("@media (max-width: 720px)", self.styles)


if __name__ == "__main__":
    unittest.main()
