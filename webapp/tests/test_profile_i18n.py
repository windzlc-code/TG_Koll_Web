import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
PROFILE_HTML = REPO_ROOT / "webapp" / "static" / "profile.html"
PROFILE_JS = REPO_ROOT / "webapp" / "static" / "assets" / "profile.js"


class ProfileI18nTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.markup = PROFILE_HTML.read_text(encoding="utf-8")
        cls.source = PROFILE_JS.read_text(encoding="utf-8")

    def test_profile_loads_bidirectional_opencc_resources(self):
        for resource in (
            "/assets/vendor/opencc-js/st-characters.js?v=1.4.1",
            "/assets/vendor/opencc-js/ts-characters.js?v=1.4.1",
            "/assets/vendor/opencc-js/ts-phrases.js?v=1.4.1",
        ):
            self.assertIn(resource, self.markup)

    def test_profile_static_ui_uses_explicit_translation_keys(self):
        for key in (
            "pageTitle",
            "skipToMain",
            "accountProfile",
            "personalProfile",
            "profileDescription",
            "backToConsole",
            "avatar",
            "avatarHelp",
            "removeAvatar",
            "displayName",
            "signature",
            "personalTags",
            "phone",
            "email",
            "loginUsername",
            "accountId",
            "accountType",
            "saveProfile",
        ):
            self.assertIn(f'data-profile-i18n="{key}"', self.markup)

        for attribute, key in (
            ("aria-label", "uploadAvatar"),
            ("aria-label", "profileSettings"),
            ("placeholder", "displayNamePlaceholder"),
            ("placeholder", "signaturePlaceholder"),
            ("placeholder", "tagsPlaceholder"),
            ("placeholder", "phonePlaceholder"),
            ("aria-label", "addedTags"),
            ("aria-label", "addTag"),
            ("aria-label", "readonlyAccountInfo"),
        ):
            self.assertIn(f'data-profile-i18n-{attribute}="{key}"', self.markup)

    def test_profile_dynamic_ui_uses_global_language_and_keyed_copy(self):
        for marker in (
            'const PROFILE_LANGUAGE_STORAGE_KEY = "wk-console-language"',
            "const PROFILE_COPY =",
            "function applyProfileLanguage",
            'window.addEventListener("vecto:language-change"',
            'window.addEventListener("storage"',
            "window.VectoOpenCcStCharacters",
            "window.VectoOpenCcTsCharacters",
            "window.VectoOpenCcTsPhrases",
            "setStatusKey(",
            'setProfileCopy($("profileSave"), "savingProfile")',
            'setProfileCopy($("profileSave"), "saveProfile")',
        ):
            self.assertIn(marker, self.source)

        for key in (
            "tagAlreadyExists",
            "profileLoadFailed",
            "selectImageFile",
            "avatarTooLarge",
            "avatarLoaded",
            "avatarReadFailed",
            "displayNameLength",
            "profileSaved",
            "profileSaveFailed",
            "avatarWillBeRemoved",
        ):
            self.assertIn(f'"{key}"', self.source)

    def test_profile_user_data_is_not_passed_through_ui_translation(self):
        direct_assignments = (
            '$("profileFullName").value = String(account?.full_name || "").trim()',
            '$("profileSignature").value = String(account?.profile_signature || "").trim()',
            '$("profileUsername").textContent = String(account?.username || "-")',
            "label.textContent = tag",
        )
        for assignment in direct_assignments:
            self.assertIn(assignment, self.source)

        self.assertNotIn("translateProfileUserData", self.source)


if __name__ == "__main__":
    unittest.main()
