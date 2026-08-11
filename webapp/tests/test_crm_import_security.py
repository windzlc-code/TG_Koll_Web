import base64
import hashlib
import hmac
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from webapp import db as db_module
from webapp.crm.errors import CRMError
from webapp.crm.importer import activate_import, dry_run_import, import_root
from webapp.crm.tracking import sign_tracking_token, verify_tracking_token


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class CRMImportSecurityTests(unittest.TestCase):
    def setUp(self):
        keys = (
            "APP_DB_PATH", "WEBAPP_DATA_DIR", "CRM_TRACKING_SECRET", "CRM_MIN_FREE_BYTES",
            "CRM_MEDIA_MAX_BYTES", "CRM_MEDIA_MAX_DIMENSION", "CRM_MEDIA_MAX_PIXELS", "CRM_MEDIA_MAX_FRAMES",
        )
        self.previous = {key: os.environ.get(key) for key in keys}
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.data_root = Path(self.tmp.name)
        os.environ["APP_DB_PATH"] = str(self.data_root / "app.db")
        os.environ["WEBAPP_DATA_DIR"] = str(self.data_root)
        os.environ["CRM_TRACKING_SECRET"] = "crm-test-secret-that-is-longer-than-32-bytes"
        os.environ["CRM_MIN_FREE_BYTES"] = "0"
        db_module.init_db()
        with db_module.db() as conn:
            now = 1_700_000_000
            self.user_id = int(conn.execute(
                "INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at) VALUES ('import_owner','x',1,0,'approved',?,?)",
                (now, now),
            ).lastrowid)

    def tearDown(self):
        for key, value in self.previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def _dry_run(self, source: str):
        with db_module.db() as conn:
            return dry_run_import(
                conn,
                user_id=self.user_id,
                actor_user_id=self.user_id,
                root=import_root(self.data_root),
                source=source,
            )

    def _assert_activation_blocked(self, batch_id: str, expected_code: str = "crm_import_blocked"):
        with self.assertRaises(CRMError) as raised:
            with db_module.db() as conn:
                activate_import(conn, batch_id=batch_id, user_id=self.user_id)
        self.assertEqual(raised.exception.code, expected_code)
        with db_module.db() as conn:
            batch = conn.execute("SELECT status,report_json FROM crm_import_batches WHERE id=?", (batch_id,)).fetchone()
        self.assertEqual(batch["status"], "failed")
        self.assertFalse(json.loads(batch["report_json"])["activated"])

    def test_invalid_json_is_a_blocking_error_and_failed_activation_is_persisted(self):
        package = import_root(self.data_root) / "invalid-json"
        package.mkdir()
        (package / "good.json").write_text(json.dumps({"pools": [{"id": "p1", "name": "ok"}]}), encoding="utf-8")
        (package / "broken.json").write_text("{not-json", encoding="utf-8")

        dry = self._dry_run("invalid-json")
        self.assertTrue(any(item["code"] == "crm_import_invalid_json" for item in dry["report"]["blocking_errors"]))
        self._assert_activation_blocked(dry["id"])
        with db_module.db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM crm_pools WHERE active=1").fetchone()[0], 0)

    def test_missing_and_ambiguous_platform_account_mappings_block_activation(self):
        root = import_root(self.data_root)
        missing = root / "missing-account.json"
        missing.write_text(json.dumps({
            "relationships": [{"platform": "threads", "senderUsername": "sender", "targetUsername": "lead"}],
        }), encoding="utf-8")
        dry_missing = self._dry_run("missing-account.json")
        self.assertEqual(dry_missing["report"]["account_mapping"]["threads:sender"], "missing")
        self._assert_activation_blocked(dry_missing["id"])

        with db_module.db() as conn:
            now = 1_700_000_000
            for index in (1, 2):
                conn.execute(
                    "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                    (f"account-{index}", self.user_id, f"persona-{index}", "threads", "duplicate", f"profile-{index}", now, now),
                )
        ambiguous = root / "ambiguous-account.json"
        ambiguous.write_text(json.dumps({
            "relationships": [{"platform": "threads", "senderUsername": "duplicate", "targetUsername": "lead"}],
        }), encoding="utf-8")
        dry_ambiguous = self._dry_run("ambiguous-account.json")
        self.assertEqual(dry_ambiguous["report"]["account_mapping"]["threads:duplicate"], "ambiguous")
        self._assert_activation_blocked(dry_ambiguous["id"])

    def test_disguised_image_is_rejected_before_activation(self):
        package = import_root(self.data_root) / "bad-media"
        package.mkdir()
        (package / "state.json").write_text(json.dumps({"templates": [{"id": "t1", "name": "bad", "media": "fake.png"}]}), encoding="utf-8")
        (package / "fake.png").write_bytes(b"this is not a png")

        dry = self._dry_run("bad-media")
        self.assertTrue(any(item["code"] == "crm_import_media_decode_failed" for item in dry["report"]["blocking_errors"]))
        self._assert_activation_blocked(dry["id"])

        mismatch = import_root(self.data_root) / "format-mismatch"
        mismatch.mkdir()
        (mismatch / "state.json").write_text(json.dumps({"templates": [{"id": "t2", "name": "bad", "media": "fake.jpg"}]}), encoding="utf-8")
        (mismatch / "fake.jpg").write_bytes(PNG_1X1)
        mismatch_dry = self._dry_run("format-mismatch")
        self.assertTrue(any(item["code"] == "crm_import_media_format_mismatch" for item in mismatch_dry["report"]["blocking_errors"]))
        self._assert_activation_blocked(mismatch_dry["id"])

    def test_activation_requires_copy_bytes_plus_safety_margin(self):
        package = import_root(self.data_root) / "capacity"
        package.mkdir()
        (package / "state.json").write_text(json.dumps({"templates": [{"id": "t1", "name": "image", "media": "image.png"}]}), encoding="utf-8")
        (package / "image.png").write_bytes(PNG_1X1)
        dry = self._dry_run("capacity")
        self.assertEqual(dry["report"]["attachment_copy_bytes"], len(PNG_1X1))
        os.environ["CRM_MIN_FREE_BYTES"] = "50"

        initial_usage = type("Usage", (), {"total": 2000, "used": 1000, "free": 1000})()
        depleted_usage = type("Usage", (), {"total": 2000, "used": 1900, "free": 100})()
        with patch("webapp.crm.importer.shutil.disk_usage", side_effect=[initial_usage, depleted_usage]):
            self._assert_activation_blocked(dry["id"], "crm_import_storage_unavailable")

    def test_v2_token_is_opaque_and_legacy_signed_tokens_remain_readable(self):
        payload = {
            "user_id": self.user_id,
            "campaign_id": "campaign-secret",
            "lead_id": "lead-secret",
            "destination_id": "destination-secret",
            "version": 2,
            "expires_at": 4_000_000_000,
        }
        token = sign_tracking_token(payload)
        self.assertTrue(token.startswith("v2_"))
        self.assertNotIn(".", token)
        ciphertext = base64.urlsafe_b64decode(token[3:] + "=" * (-len(token[3:]) % 4))
        self.assertNotIn(b"campaign-secret", ciphertext)
        self.assertEqual(verify_tracking_token(token), payload)

        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        encoded = base64.urlsafe_b64encode(body).decode("ascii").rstrip("=")
        signature = hmac.new(os.environ["CRM_TRACKING_SECRET"].encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
        legacy = f"{encoded}.{base64.urlsafe_b64encode(signature).decode('ascii').rstrip('=')}"
        self.assertEqual(verify_tracking_token(legacy), payload)

    def test_legacy_crm_state_injects_audited_tracking_destinations_idempotently(self):
        source = import_root(self.data_root) / "crm-state.json"
        source.write_text(json.dumps({
            "version": 8,
            "pools": [{"id": "pool-1", "name": "Legacy"}],
            # A source-provided collision must not override the historical
            # fixed destination allowlist.
            "destinations": [{"legacy_id": "o", "url": "https://example.test/not-legacy"}],
        }), encoding="utf-8")

        dry = self._dry_run("crm-state.json")
        self.assertEqual(dry["counts"]["destinations"], 3)
        with db_module.db() as conn:
            activated = activate_import(conn, batch_id=dry["id"], user_id=self.user_id)
            replay = activate_import(conn, batch_id=dry["id"], user_id=self.user_id)
            rows = conn.execute(
                "SELECT legacy_id,url,legacy_payload_json FROM crm_destinations WHERE user_id=? AND active=1 ORDER BY legacy_id",
                (self.user_id,),
            ).fetchall()

        self.assertEqual(activated["status"], "active")
        self.assertEqual(replay["id"], activated["id"])
        self.assertEqual([(row["legacy_id"], row["url"]) for row in rows], [
            ("l", "https://line.me/R/ti/p/@vecto"),
            ("o", "https://www.instagram.com/vecto.ai/"),
        ])
        for row in rows:
            audit = json.loads(row["legacy_payload_json"])
            self.assertEqual(audit["source"], "legacy_crm_recordTaskTrackingClick")
            self.assertEqual(audit["source_schema_version"], 1)

    def test_import_preserves_raw_template_media_and_cross_platform_leads(self):
        package = import_root(self.data_root) / "complete-legacy"
        package.mkdir()
        (package / "template.png").write_bytes(PNG_1X1)
        (package / "state.json").write_text(json.dumps({
            "pools": [{
                "id": "pool", "name": "Pool", "leads": [
                    {"id": "same", "platform": "threads", "username": "dual"},
                    {"id": "same", "platform": "instagram", "username": "dual"},
                ],
            }],
            "templates": [{"id": "tpl", "name": "With media", "message": "hello", "imagePath": "template.png"}],
        }), encoding="utf-8")
        dry = self._dry_run("complete-legacy")
        with db_module.db() as conn:
            activated = activate_import(conn, batch_id=dry["id"], user_id=self.user_id)
            leads = conn.execute("SELECT platform,username FROM crm_leads WHERE user_id=? AND active=1 ORDER BY platform", (self.user_id,)).fetchall()
            template = conn.execute("SELECT media_ids_json,legacy_payload_json FROM crm_templates WHERE user_id=? AND active=1", (self.user_id,)).fetchone()
        self.assertEqual(activated["status"], "active")
        self.assertEqual({(row["platform"], row["username"]) for row in leads}, {("threads", "dual"), ("instagram", "dual")})
        self.assertEqual(len(json.loads(template["media_ids_json"])), 1)
        self.assertEqual(json.loads(template["legacy_payload_json"])["imagePath"], "template.png")

    def test_relationship_platform_is_inferred_from_inspected_url(self):
        with db_module.db() as conn:
            now = 1_700_000_000
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,created_at,updated_at) VALUES ('ig-sender',?,'p','instagram','sender','p','ready',?,?)",
                (self.user_id, now, now),
            )
        source = import_root(self.data_root) / "relationship.json"
        source.write_text(json.dumps({
            "leads": [{"id": "lead", "platform": "instagram", "username": "target"}],
            "relationships": [{"id": "rel", "senderUsername": "sender", "targetUsername": "target", "inspectedUrl": "https://www.instagram.com/target/", "status": "mutual"}],
        }), encoding="utf-8")
        dry = self._dry_run("relationship.json")
        self.assertEqual(dry["report"]["account_mapping"]["instagram:sender"], "matched")
        with db_module.db() as conn:
            activate_import(conn, batch_id=dry["id"], user_id=self.user_id)
            row = conn.execute("SELECT lead_id,account_id,legacy_payload_json FROM crm_relationships WHERE user_id=? AND active=1", (self.user_id,)).fetchone()
        self.assertTrue(row["lead_id"])
        self.assertEqual(row["account_id"], "ig-sender")
        self.assertIn("inspectedUrl", json.loads(row["legacy_payload_json"]))

    def test_rotation_account_key_with_platform_prefix_becomes_native_state(self):
        with db_module.db() as conn:
            now = 1_700_000_000
            conn.execute(
                "INSERT INTO social_accounts(id,user_id,persona_id,platform,username,profile_dir,status,created_at,updated_at) VALUES ('rotation-sender',?,'p','threads','sender','p','ready',?,?)",
                (self.user_id, now, now),
            )
        source = import_root(self.data_root) / "rotation.json"
        source.write_text(json.dumps({
            "events": [{
                "id": "rotation:threads:sender",
                "type": "sender_rotation_state",
                "detail": {
                    "account_key": "threads:sender",
                    "state": {"channel": "threads", "consecutiveComposerFailures": 3},
                },
            }],
        }), encoding="utf-8")
        dry = self._dry_run("rotation.json")
        with db_module.db() as conn:
            activate_import(conn, batch_id=dry["id"], user_id=self.user_id)
            row = conn.execute("SELECT lead_id,event_type,payload_json FROM crm_events WHERE user_id=? AND active=1", (self.user_id,)).fetchone()
        payload = json.loads(row["payload_json"])
        self.assertEqual(row["lead_id"], "rotation-sender")
        self.assertEqual(row["event_type"], "sender_rotation_state")
        self.assertTrue(payload["locked"])
        self.assertTrue(payload["requires_follow_action"])


if __name__ == "__main__":
    unittest.main()
