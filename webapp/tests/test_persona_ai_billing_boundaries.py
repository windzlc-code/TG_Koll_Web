import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from webapp import commercial_billing
from webapp import db as db_module
from webapp import server


class PersonaAiBillingBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.old_db_path = os.environ.get("APP_DB_PATH")
        self.old_billing_enabled = os.environ.get("COMMERCIAL_BILLING_ENABLED")
        self.old_grace = os.environ.get("BILLING_ORPHAN_RESERVATION_GRACE_SECONDS")
        self.old_tool_runtime_dir = server.TOOL_R18_RUNTIME_DIR
        self.tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmpdir.name)
        os.environ["APP_DB_PATH"] = str(self.root / "app.db")
        os.environ["COMMERCIAL_BILLING_ENABLED"] = "1"
        os.environ["BILLING_ORPHAN_RESERVATION_GRACE_SECONDS"] = "60"
        server.TOOL_R18_RUNTIME_DIR = self.root / "tool_r18_runtime"
        server.TOOL_R18_RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        db_module.init_db()
        with db_module.db() as conn:
            created = conn.execute(
                """
                INSERT INTO users(
                  username, password_hash, is_admin, is_disabled,
                  balance_cents, created_at, updated_at
                ) VALUES ('persona_ai_billing', 'hash', 0, 0, 0, 100, 100)
                """
            )
            self.user_id = int(created.lastrowid)
            commercial_billing.initialize_new_user_wallet(
                conn,
                user_id=self.user_id,
                source="persona-ai-billing-test",
                now=100,
            )
        self.user = {"id": self.user_id, "username": "persona_ai_billing", "is_admin": 0}

    def tearDown(self):
        server.TOOL_R18_RUNTIME_DIR = self.old_tool_runtime_dir
        self._restore_env("APP_DB_PATH", self.old_db_path)
        self._restore_env("COMMERCIAL_BILLING_ENABLED", self.old_billing_enabled)
        self._restore_env("BILLING_ORPHAN_RESERVATION_GRACE_SECONDS", self.old_grace)
        self.tmpdir.cleanup()

    @staticmethod
    def _restore_env(name: str, value: str | None) -> None:
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value

    def _reservation_rows(self):
        with db_module.db() as conn:
            return conn.execute(
                "SELECT id, ref_type, status, meta_json FROM billing_reservations ORDER BY created_at, id"
            ).fetchall()

    def test_startup_cleanup_releases_all_orphaned_persona_ai_holds(self):
        with db_module.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            for ref_type in ("persona_ai_keywords", "persona_ai_create", "persona_ai_profile"):
                commercial_billing.reserve_charge(
                    conn,
                    user_id=self.user_id,
                    ref_type=ref_type,
                    ref_id=f"{ref_type}-orphan",
                    sku="basic_text_post",
                    quantity=1,
                    now=100,
                )

        with mock.patch.object(server, "_now_ts", return_value=1_000):
            server._resume_pending_tasks()

        rows = self._reservation_rows()
        self.assertEqual({str(row["ref_type"]) for row in rows}, {
            "persona_ai_keywords",
            "persona_ai_create",
            "persona_ai_profile",
        })
        self.assertEqual({str(row["status"]) for row in rows}, {"released"})

    def test_empty_derived_profile_fails_and_releases_reservation(self):
        payload = server.PersonaDashboardPersonaAiProfilePayload(
            name="Night Driver",
            prompt="Build a detailed urban night-shift persona",
            selected_keywords=["night shift", "city"],
        )
        with db_module.db() as conn:
            before = commercial_billing.billing_summary(conn, self.user_id)["credit_units"]

        with mock.patch.object(
            server,
            "_run_persona_create_cli",
            return_value={"ok": True, "name": "Night Driver", "content": "", "setup": {}},
        ):
            with self.assertRaises(HTTPException) as raised:
                server._run_billable_operation(
                    self.user,
                    ref_type="persona_ai_profile",
                    sku="basic_text_post",
                    quantity=1,
                    operation=lambda: server._persona_dashboard_generate_profile_content(payload),
                )

        self.assertEqual(raised.exception.status_code, 502)
        rows = self._reservation_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(str(rows[0]["status"]), "released")
        with db_module.db() as conn:
            after = commercial_billing.billing_summary(conn, self.user_id)["credit_units"]
        self.assertEqual(after, before)

    def test_durable_persona_checkpoint_is_settled_after_crash_before_billing(self):
        archive_id = "persona-ai-crash-safe"

        def persist_persona():
            archive = {
                "id": archive_id,
                "name": "Crash Safe",
                "content": "Persisted persona content",
                "setup": {"personaName": "Crash Safe"},
                "posts": [],
            }
            (server.TOOL_R18_RUNTIME_DIR / "persona_archives.json").write_text(
                json.dumps([archive], ensure_ascii=False),
                encoding="utf-8",
            )
            now = server._now_ts()
            with db_module.db() as conn:
                conn.execute(
                    """
                    INSERT INTO persona_owners(archive_id, user_id, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (archive_id, self.user_id, now, now),
                )
            return {"ok": True, "profile": {"id": archive_id, "name": "Crash Safe"}}

        with mock.patch.object(
            server.commercial_billing,
            "settle_reservation",
            side_effect=KeyboardInterrupt("simulated process crash before settlement"),
        ):
            with self.assertRaises(KeyboardInterrupt):
                server._run_billable_operation(
                    self.user,
                    ref_type="persona_ai_create",
                    sku="basic_text_post",
                    quantity=1,
                    operation=persist_persona,
                )

        held = self._reservation_rows()[0]
        self.assertEqual(str(held["status"]), "held")
        checkpoint = json.loads(str(held["meta_json"])).get("operation_checkpoint") or {}
        self.assertEqual(checkpoint.get("state"), "durable_output")
        self.assertEqual(checkpoint.get("archive_id"), archive_id)

        with db_module.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            recovered = server._recover_orphaned_persona_ai_reservations(
                conn,
                cutoff_ts=server._now_ts() + 1,
            )

        self.assertEqual(recovered, {"settled": 1, "released": 0})
        self.assertEqual(str(self._reservation_rows()[0]["status"]), "settled")

    def test_transient_settlement_failure_retries_without_waiting_for_restart(self):
        archive_id = "persona-ai-transient-settle"

        def persist_persona():
            archive = {
                "id": archive_id,
                "name": "Retry Safe",
                "content": "Persisted persona content",
                "setup": {"personaName": "Retry Safe"},
                "posts": [],
            }
            (server.TOOL_R18_RUNTIME_DIR / "persona_archives.json").write_text(
                json.dumps([archive], ensure_ascii=False),
                encoding="utf-8",
            )
            now = server._now_ts()
            with db_module.db() as conn:
                conn.execute(
                    """
                    INSERT INTO persona_owners(archive_id, user_id, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (archive_id, self.user_id, now, now),
                )
            return {"ok": True, "profile": {"id": archive_id, "name": "Retry Safe"}}

        real_settle = commercial_billing.settle_reservation
        settle_calls = 0

        def settle_once_then_succeed(*args, **kwargs):
            nonlocal settle_calls
            settle_calls += 1
            if settle_calls == 1:
                raise RuntimeError("transient settlement failure")
            return real_settle(*args, **kwargs)

        with mock.patch.object(
            server.commercial_billing,
            "settle_reservation",
            side_effect=settle_once_then_succeed,
        ):
            result = server._run_billable_operation(
                self.user,
                ref_type="persona_ai_create",
                sku="basic_text_post",
                quantity=1,
                operation=persist_persona,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(settle_calls, 2)
        self.assertEqual(str(self._reservation_rows()[0]["status"]), "settled")

    def test_unverifiable_durable_checkpoint_is_released_for_manual_recovery(self):
        with db_module.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            reservation = commercial_billing.reserve_charge(
                conn,
                user_id=self.user_id,
                ref_type="persona_ai_create",
                ref_id="persona-ai-missing-output",
                sku="basic_text_post",
                quantity=1,
                now=100,
            )
            row = conn.execute(
                "SELECT meta_json FROM billing_reservations WHERE id = ?",
                (str(reservation["id"]),),
            ).fetchone()
            meta = json.loads(str(row["meta_json"]))
            meta["operation_checkpoint"] = {
                "state": "durable_output",
                "archive_id": "missing-persona",
            }
            conn.execute(
                "UPDATE billing_reservations SET meta_json = ? WHERE id = ?",
                (json.dumps(meta), str(reservation["id"])),
            )

        with db_module.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            recovered = server._recover_orphaned_persona_ai_reservations(conn, cutoff_ts=1_000)

        self.assertEqual(recovered, {"settled": 0, "released": 1})
        self.assertEqual(str(self._reservation_rows()[0]["status"]), "released")


if __name__ == "__main__":
    unittest.main()
