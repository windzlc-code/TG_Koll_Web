from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from cryptography.fernet import Fernet

from webapp.collector_vault import (
    CollectorVault,
    CollectorVaultDecryptError,
    CollectorVaultUnavailableError,
    secret_purpose,
)


class CollectorVaultTests(unittest.TestCase):
    def test_ciphertext_is_bound_to_account_and_secret_kind(self) -> None:
        vault = CollectorVault(key=Fernet.generate_key(), key_version="test-v1")
        plaintext = "not-present-in-ciphertext"
        ciphertext = vault.encrypt("colacct_one", "totp", plaintext)

        self.assertNotIn(plaintext, ciphertext)
        self.assertEqual(vault.decrypt("colacct_one", "totp", ciphertext), plaintext)
        with self.assertRaises(CollectorVaultDecryptError):
            vault.decrypt("colacct_two", "totp", ciphertext)
        with self.assertRaises(CollectorVaultDecryptError):
            vault.decrypt("colacct_one", "login_password", ciphertext)

    def test_historical_keyring_can_decrypt_old_envelope(self) -> None:
        old_key = Fernet.generate_key()
        new_key = Fernet.generate_key()
        old_vault = CollectorVault(key=old_key, key_version="v1")
        ciphertext = old_vault.encrypt("colacct_one", "login_password", "secret")
        rotated = CollectorVault(
            key=new_key,
            key_version="v2",
            keyring={"v1": old_key},
        )

        self.assertEqual(
            rotated.decrypt("colacct_one", "login_password", ciphertext),
            "secret",
        )

    def test_missing_key_fails_closed_and_is_never_created(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            missing = Path(root) / "missing.key"
            with self.assertRaises(CollectorVaultUnavailableError):
                CollectorVault(key_file=missing)
            self.assertFalse(missing.exists())

    def test_identifiers_and_purposes_are_strict(self) -> None:
        self.assertEqual(
            secret_purpose("colacct_one", "totp"),
            "collector-account:colacct_one:totp",
        )
        with self.assertRaises(ValueError):
            secret_purpose("../escape", "totp")
        with self.assertRaises(ValueError):
            secret_purpose("colacct_one", "unknown")


if __name__ == "__main__":
    unittest.main()
