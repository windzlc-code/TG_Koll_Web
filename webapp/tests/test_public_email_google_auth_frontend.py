import unittest
from pathlib import Path


STATIC_DIR = Path(__file__).resolve().parents[1] / "static"
SCRIPT_PATH = STATIC_DIR / "assets" / "opc" / "script.js"
STYLES_PATH = STATIC_DIR / "assets" / "opc" / "styles.css"


class PublicEmailGoogleAuthFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = SCRIPT_PATH.read_text(encoding="utf-8")
        cls.styles = STYLES_PATH.read_text(encoding="utf-8")
        cls.google_svg = (STATIC_DIR / "assets" / "opc" / "google-g-gradient.svg").read_text(encoding="utf-8")
        cls.auth_script = (STATIC_DIR / "assets" / "auth.js").read_text(encoding="utf-8")
        cls.change_password = (STATIC_DIR / "change-password.html").read_text(encoding="utf-8")

    def test_email_registration_uses_verification_challenge_contract(self):
        self.assertIn('api("/api/auth/email-verification/send"', self.script)
        self.assertIn('purpose: "register"', self.script)
        self.assertIn("challenge_id: registerChallengeId", self.script)
        self.assertIn("verification_code: applicationForm.elements.verification_code.value.trim()", self.script)
        self.assertIn("full_name: applicationForm.elements.full_name.value.trim()", self.script)
        self.assertIn("company: applicationForm.elements.company.value.trim()", self.script)
        self.assertIn("use_case: applicationForm.elements.use_case.value", self.script)
        self.assertIn("consent: applicationForm.elements.consent.checked", self.script)
        self.assertNotIn("phone: applicationForm.elements.phone", self.script)
        self.assertIn('api("/api/auth/register"', self.script)
        self.assertNotIn('api("/api/auth/apply"', self.script)

    def test_registration_shows_all_account_fields_on_one_page(self):
        registration_markup = self.script[
            self.script.index("function registrationPanelMarkup"):
            self.script.index("function googleSetupPanelMarkup")
        ]
        self.assertIn("auth-registration-panel", registration_markup)
        self.assertNotIn("data-register-email-step", registration_markup)
        self.assertNotIn("data-register-details", registration_markup)
        self.assertNotIn("步驟 1 / 2", registration_markup)
        self.assertNotIn("步驟 2 / 2", registration_markup)
        field_positions = [
            registration_markup.index('name="email"'),
            registration_markup.index('name="verification_code"'),
            registration_markup.index('name="full_name"'),
            registration_markup.index('name="username"'),
            registration_markup.index('name="password"'),
            registration_markup.index('name="password_confirmation"'),
            registration_markup.index('name="company"'),
            registration_markup.index('name="use_case"'),
            registration_markup.index('name="consent"'),
        ]
        self.assertEqual(field_positions, sorted(field_positions))
        self.assertNotIn('name="phone"', registration_markup)
        self.assertNotIn("field-requirement", registration_markup)
        self.assertNotIn("使用者名稱", registration_markup)
        self.assertIn("用戶名", registration_markup)
        for label in (
            "電子信箱",
            "信箱驗證碼",
            "姓名",
            "用戶名",
            "登入密碼",
            "再次確認密碼",
            "公司 / 團隊（選填）",
            "預計使用情境",
        ):
            with self.subTest(label=label):
                self.assertIn(f'<span class="field-label">{label}</span>', registration_markup)
        self.assertIn('placeholder="請輸入姓名"', registration_markup)
        self.assertIn('placeholder="請輸入公司或團隊名稱"', registration_markup)
        self.assertIn(
            "我已閱讀並同意《用戶服務協議》和《隱私政策》",
            registration_markup,
        )
        self.assertIn('id="registerVerificationStatus"', registration_markup)
        self.assertLess(
            registration_markup.index('id="registerVerificationStatus"'),
            registration_markup.index('name="verification_code"'),
        )
        self.assertIn('button class="submit-button" type="submit"', registration_markup)

    def test_registration_confirms_password_and_uses_svg_visibility_toggles(self):
        registration_markup = self.script[
            self.script.index("function registrationPanelMarkup"):
            self.script.index("function googleSetupPanelMarkup")
        ]
        self.assertIn('name="password_confirmation"', registration_markup)
        self.assertEqual(registration_markup.count("data-register-password-toggle"), 2)
        self.assertGreaterEqual(registration_markup.count('class="auth-eye-icon"'), 2)
        self.assertIn("password_confirmation.value", self.script)
        self.assertIn("passwordsMatch", self.script)
        self.assertIn("setupRegisterPasswordToggle", self.script)

    def test_registration_uses_one_verification_button_for_send_and_resend(self):
        registration_markup = self.script[
            self.script.index("function registrationPanelMarkup"):
            self.script.index("function googleSetupPanelMarkup")
        ]
        self.assertEqual(registration_markup.count("data-register-verification"), 1)
        self.assertNotIn("data-send-register-code", registration_markup)
        self.assertNotIn("data-resend-register-code", registration_markup)
        self.assertNotIn("registerResendCode", self.script)
        self.assertIn("function startRegisterResendCountdown(seconds)", self.script)
        self.assertIn("result?.resend_after", self.script)
        self.assertIn("秒後可重發", self.script)
        self.assertIn("重新發送驗證碼", self.script)
        self.assertIn("window.setInterval", self.script)
        self.assertIn(".auth-verification-button", self.styles)

    def test_policy_controls_google_and_email_registration_entry_points(self):
        self.assertIn("policy.google_login_enabled !== false", self.script)
        self.assertIn("updateRegisterVerificationAvailability", self.script)
        self.assertIn("registrationEmailIsValid", self.script)
        self.assertIn("const emailValid = registrationEmailIsValid()", self.script)
        self.assertIn("busy || !available || !emailValid", self.script)
        self.assertIn("registrationPolicyEnabled", self.script)
        self.assertIn('applicationForm?.elements?.email?.addEventListener("input"', self.script)
        self.assertIn('applicationForm?.elements?.email?.addEventListener("change"', self.script)
        self.assertIn("registrationPolicyEnabled = null", self.script)
        self.assertIn('googleLoginButton.dataset.googleLogin = ""', self.script)
        self.assertIn('window.location.assign(`/api/auth/google/start?return_url=${encodeURIComponent(returnUrl)}`)', self.script)

    def test_google_entry_is_static_on_every_public_login_and_uses_official_asset(self):
        for page_name in (
            "index.html",
            "pricing.html",
            "about-vecto.html",
            "proxy-market.html",
        ):
            with self.subTest(page=page_name):
                markup = (STATIC_DIR / page_name).read_text(encoding="utf-8")
                self.assertIn('data-google-login aria-label="使用 Google 帳號登入"', markup)
                self.assertIn('src="/assets/opc/google-g-gradient.svg"', markup)
                self.assertNotIn("data-google-login hidden", markup)
                self.assertLess(markup.index('class="submit-button"'), markup.index("data-google-login-container"))
                self.assertLess(markup.index("data-google-login-container"), markup.index("data-google-login aria-label"))
        self.assertIn('width="20" height="20"', self.google_svg)
        self.assertIn('viewBox="10 10 20 20"', self.google_svg)
        self.assertIn("data-figma-gradient-fill", self.google_svg)
        self.assertNotIn('icon.textContent = "G"', self.script)

    def test_google_entry_stays_available_when_policy_request_temporarily_fails(self):
        policy_loader = self.script[
            self.script.index("async function loadLoginPolicy"):
            self.script.index("function initHomeExperience")
        ]
        catch_block = policy_loader[policy_loader.index("} catch {"):]
        self.assertIn("googleLoginButton.hidden = false", catch_block)
        self.assertIn("googleContainer.hidden = false", catch_block)

    def test_google_first_login_completes_unique_username(self):
        self.assertIn('searchParams.get("google_setup") === "1"', self.script)
        self.assertIn('data-auth-view="google-setup"', self.script)
        self.assertIn('api("/api/auth/google/complete"', self.script)
        self.assertIn("body: JSON.stringify({ username: usernameInput.value.trim() })", self.script)
        self.assertIn("document.body.dataset.googleReturnUrl", self.script)

    def test_google_oauth_errors_are_shown_and_removed_from_the_url(self):
        self.assertIn('searchParams.get("oauth_error")', self.script)
        self.assertIn('currentUrl.searchParams.delete("oauth_error")', self.script)
        self.assertIn("google_verification_failed", self.script)
        self.assertIn("Google 登录失败，请重试。", self.script)

    def test_google_user_can_set_a_local_password_with_verified_email(self):
        self.assertIn('id="verifiedPasswordSetup"', self.change_password)
        self.assertIn('id="sendPasswordSetupCode"', self.change_password)
        self.assertIn('id="passwordSetupCode"', self.change_password)
        self.assertIn('purpose: "set_password"', self.auth_script)
        self.assertIn('api("/api/auth/password/setup"', self.auth_script)
        self.assertIn("account?.password_login_enabled !== false", self.auth_script)

    def test_login_copy_accepts_email_or_username_on_every_public_page(self):
        for page_name in (
            "index.html",
            "pricing.html",
            "about-vecto.html",
            "proxy-market.html",
        ):
            with self.subTest(page=page_name):
                markup = (STATIC_DIR / page_name).read_text(encoding="utf-8")
                self.assertIn("電子信箱或使用者名稱", markup)
                self.assertIn("name@example.com 或使用者名稱", markup)

    def test_errors_are_rendered_as_text_and_linked_to_fields(self):
        registration_slice = self.script[
            self.script.index("function registrationErrorField"):
            self.script.index("async function submitUserLogin")
        ]
        self.assertIn("apiErrorDetail(error)", registration_slice)
        self.assertIn("setFieldError(target, message)", registration_slice)
        self.assertIn("email_already_registered", registration_slice)
        self.assertIn("element.textContent = String(message || \"\")", self.script)
        self.assertNotIn("innerHTML = result", registration_slice)
        self.assertNotIn("insertAdjacentHTML(result", registration_slice)
        self.assertIn("data.httpStatus = response.status", self.script)
        self.assertIn("registrationStatusMessage(error, fallback)", self.script)
        self.assertIn("驗證碼服務暫時不可用，請重新整理頁面後再試。", self.script)
        self.assertIn("registerVerificationStatus", self.script)

    def test_auth_dialog_is_mobile_and_keyboard_accessible(self):
        self.assertIn('event.key !== "Tab"', self.script)
        self.assertIn("loginFocusableElements()", self.script)
        self.assertIn(".auth-dialog.is-registering > [data-open-register]", self.styles)
        self.assertIn(".auth-email-action {", self.styles)
        self.assertIn(".auth-registration-profile", self.styles)
        self.assertIn("background: #fff;", self.styles)
        self.assertNotIn("background: #f7faf9;", self.styles)
        self.assertIn("width: min(520px, 100%);", self.styles)
        self.assertIn(".auth-placeholder-field .field-label", self.styles)
        self.assertIn(".auth-registration-consent input {", self.styles)
        self.assertIn("min-height: 18px !important;", self.styles)
        self.assertIn("accent-color: var(--teal-dark);", self.styles)
        self.assertIn("box-shadow: none !important;", self.styles)
        self.assertIn(".auth-registration-form .auth-form-status:empty", self.styles)
        profile_rule = self.styles[
            self.styles.index(".auth-registration-profile {"):
            self.styles.index(".auth-registration-profile .field")
        ]
        self.assertIn("grid-template-columns: 1fr;", profile_rule)
        mobile = self.styles[self.styles.index("@media (max-width: 560px)"):]
        self.assertIn("grid-template-columns: 1fr;", mobile)
        self.assertIn("grid-template-columns: minmax(0, 1fr) 112px;", mobile)
        self.assertIn(".auth-google-button:focus-visible", self.styles)


if __name__ == "__main__":
    unittest.main()
