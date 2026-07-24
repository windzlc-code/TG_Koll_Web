import os
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

import webapp.server as server


class TestEnvironmentIsolationTests(unittest.TestCase):
    def test_default_test_paths_do_not_target_live_local_data(self):
        repo_root = Path(__file__).resolve().parents[2]

        self.assertNotEqual(
            Path(os.environ["APP_DB_PATH"]).resolve(),
            (repo_root / "webapp_data" / "app.db").resolve(),
        )
        self.assertNotEqual(
            Path(os.environ["TOOL_R18_RUNTIME_DIR"]).resolve(),
            (repo_root / "tool_r18" / ".runtime" / "automatic-script").resolve(),
        )
        self.assertNotEqual(
            server.DATA_DIR,
            (repo_root / "webapp_data").resolve(),
        )
        self.assertNotEqual(
            server.TOOL_R18_RUNTIME_DIR,
            (repo_root / "tool_r18" / ".runtime" / "automatic-script").resolve(),
        )

    def test_existing_persona_owner_cannot_be_reassigned(self):
        with server.db() as conn:
            first_id = conn.execute(
                "INSERT INTO users("
                "username, password_hash, is_admin, is_disabled, approval_status, "
                "balance_cents, created_at, updated_at"
                ") VALUES ('owner-a', 'x', 0, 0, 'approved', 0, 1, 1)"
            ).lastrowid
            second_id = conn.execute(
                "INSERT INTO users("
                "username, password_hash, is_admin, is_disabled, approval_status, "
                "balance_cents, created_at, updated_at"
                ") VALUES ('owner-b', 'x', 0, 0, 'approved', 0, 1, 1)"
            ).lastrowid
            conn.execute(
                "INSERT INTO persona_owners(archive_id, user_id, created_at, updated_at) "
                "VALUES ('persona-protected', ?, 1, 1)",
                (first_id,),
            )

        with self.assertRaises(HTTPException) as raised:
            server._record_persona_owner("persona-protected", {"id": second_id})

        self.assertEqual(raised.exception.status_code, 409)
        with server.db() as conn:
            owner_id = conn.execute(
                "SELECT user_id FROM persona_owners WHERE archive_id = 'persona-protected'"
            ).fetchone()["user_id"]
        self.assertEqual(owner_id, first_id)

    def test_existing_persona_group_owner_cannot_be_reassigned(self):
        with server.db() as conn:
            first_id = conn.execute(
                "INSERT INTO users("
                "username, password_hash, is_admin, is_disabled, approval_status, "
                "balance_cents, created_at, updated_at"
                ") VALUES ('group-owner-a', 'x', 0, 0, 'approved', 0, 1, 1)"
            ).lastrowid
            second_id = conn.execute(
                "INSERT INTO users("
                "username, password_hash, is_admin, is_disabled, approval_status, "
                "balance_cents, created_at, updated_at"
                ") VALUES ('group-owner-b', 'x', 0, 0, 'approved', 0, 1, 1)"
            ).lastrowid
            conn.execute(
                "INSERT INTO persona_group_owners(group_id, user_id, created_at, updated_at) "
                "VALUES ('group-protected', ?, 1, 1)",
                (first_id,),
            )

        with self.assertRaises(HTTPException) as raised:
            server._record_persona_group_owner("group-protected", {"id": second_id})

        self.assertEqual(raised.exception.status_code, 409)
        with server.db() as conn:
            owner_id = conn.execute(
                "SELECT user_id FROM persona_group_owners WHERE group_id = 'group-protected'"
            ).fetchone()["user_id"]
        self.assertEqual(owner_id, first_id)

    def test_owner_conflict_does_not_delete_existing_persona(self):
        with server.db() as conn:
            first_id = conn.execute(
                "INSERT INTO users("
                "username, password_hash, is_admin, is_disabled, approval_status, "
                "balance_cents, created_at, updated_at"
                ") VALUES ('wrapper-owner-a', 'x', 0, 0, 'approved', 0, 1, 1)"
            ).lastrowid
            second_id = conn.execute(
                "INSERT INTO users("
                "username, password_hash, is_admin, is_disabled, approval_status, "
                "balance_cents, created_at, updated_at"
                ") VALUES ('wrapper-owner-b', 'x', 0, 0, 'approved', 0, 1, 1)"
            ).lastrowid
            conn.execute(
                "INSERT INTO persona_owners(archive_id, user_id, created_at, updated_at) "
                "VALUES ('persona-wrapper-protected', ?, 1, 1)",
                (first_id,),
            )

        with mock.patch.object(server, "_delete_persona_dashboard_personas") as delete_personas:
            with self.assertRaises(HTTPException) as raised:
                server._create_persona_with_owner(
                    {"id": second_id},
                    lambda: {"id": "persona-wrapper-protected"},
                )

        self.assertEqual(raised.exception.status_code, 409)
        delete_personas.assert_not_called()
        with server.db() as conn:
            owner_id = conn.execute(
                "SELECT user_id FROM persona_owners WHERE archive_id = 'persona-wrapper-protected'"
            ).fetchone()["user_id"]
        self.assertEqual(owner_id, first_id)


if __name__ == "__main__":
    unittest.main()
