import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from webapp import db as db_module
import webapp.server as server


class BillingTaskRegressionTests(unittest.TestCase):
    def test_single_image_url_counts_as_one_billable_output(self):
        self.assertEqual(
            server._billing_actual_image_quantity({"image_url": "/uploads/generated.png"}),
            1,
        )
        self.assertEqual(
            server._billing_actual_image_quantity({"image_urls": ["a.png", "b.png"]}),
            2,
        )

    def test_persona_image_task_exposes_generated_image_count(self):
        result = {
            "generation": {"image_url": "/uploads/persona.png"},
            "saved_item_id": "saved-1",
        }
        with mock.patch.object(server, "_run_persona_image_cli_for_web", return_value=result):
            output = server._run_persona_image_task(
                "task-1",
                {"related_persona_id": "persona-1"},
            )

        self.assertEqual(output["image_url"], "/uploads/persona.png")
        self.assertEqual(output["image_count"], 1)

    def test_persona_image_task_forwards_custom_prompt(self):
        result = {
            "generation": {"image_url": "/uploads/persona-prompt.png"},
            "saved_item_id": "saved-prompt-1",
        }
        with mock.patch.object(server, "_run_persona_image_cli_for_web", return_value=result) as runner:
            server._run_persona_image_task(
                "task-prompt-1",
                {
                    "related_persona_id": "persona-1",
                    "prompt": "穿深色西装，办公室暖光，半身构图",
                },
            )

        self.assertEqual(runner.call_args.kwargs["prompt"], "穿深色西装，办公室暖光，半身构图")

    def test_persona_image_regeneration_keeps_standard_reference_sheet_chain(self):
        archive = {
            "id": "persona-1",
            "name": "测试人设",
            "content": "测试人设正文",
            "setup": {"personaImageReferenceUrl": "/existing-reference.jpg"},
        }
        completed = mock.Mock(
            returncode=0,
            stdout=json.dumps(
                {
                    "referenceSheet": {"ok": True, "url": "/generated-reference.jpg"},
                    "imageResult": {"ok": True, "url": "/generated-reference.jpg", "mode": "closed-person"},
                }
            ),
            stderr="",
        )
        with (
            mock.patch.object(server, "_persona_archive_source_for_write", return_value=(Path("archive.json"), {}, [archive])),
            mock.patch.object(server, "_sync_tool_r18_api_config_for_persona_workflow"),
            mock.patch.object(server.subprocess, "run", return_value=completed) as run,
            mock.patch.object(server, "_persona_archive_persist_reference_image", return_value={"saved_item_id": "saved-reference"}),
        ):
            result = server._run_persona_image_cli_for_web(
                "persona-1",
                prompt="爆奶美女，身材非常的好，性感知性。",
            )

        cli_payload = json.loads(run.call_args.args[0][4])
        self.assertTrue(cli_payload["generateReferenceSheet"])
        self.assertFalse(cli_payload.get("editExistingImage"))
        self.assertIsNone(cli_payload["referenceImageUrl"])
        self.assertIsNone(cli_payload["referenceSheetUrl"])
        self.assertEqual(cli_payload["content"], "测试人设正文")
        self.assertEqual(cli_payload["customPrompt"], "爆奶美女，身材非常的好，性感知性。")
        self.assertEqual(result["generation"]["image_url"], "/generated-reference.jpg")

    def test_persona_image_blank_prompt_uses_archive_content(self):
        archive = {
            "id": "persona-1",
            "name": "测试人设",
            "content": "测试人设正文",
            "setup": {"personaImageReferenceUrl": "/existing-reference.jpg"},
        }
        completed = mock.Mock(
            returncode=0,
            stdout=json.dumps(
                {
                    "referenceSheet": {"ok": True, "url": "/generated-reference.jpg"},
                    "imageResult": {"ok": True, "url": "/generated-reference.jpg", "mode": "closed-person"},
                }
            ),
            stderr="",
        )
        with (
            mock.patch.object(server, "_persona_archive_source_for_write", return_value=(Path("archive.json"), {}, [archive])),
            mock.patch.object(server, "_sync_tool_r18_api_config_for_persona_workflow"),
            mock.patch.object(server.subprocess, "run", return_value=completed) as run,
            mock.patch.object(server, "_persona_archive_persist_reference_image", return_value={"saved_item_id": "saved-reference"}),
        ):
            server._run_persona_image_cli_for_web("persona-1")

        cli_payload = json.loads(run.call_args.args[0][4])
        self.assertTrue(cli_payload["generateReferenceSheet"])
        self.assertEqual(cli_payload["content"], "测试人设正文")
        self.assertIsNone(cli_payload.get("customPrompt"))

    def test_persona_image_edit_uses_selected_library_image_instead_of_sheet(self):
        archive = {
            "id": "persona-1",
            "name": "测试人设",
            "content": "测试人设正文",
            "setup": {"personaImageReferenceUrl": "/existing-reference.jpg"},
            "personaImageLibrary": [
                {"id": "img-edit-1", "imageUrl": "/library/edit-source.jpg"},
            ],
        }
        completed = mock.Mock(
            returncode=0,
            stdout=json.dumps(
                {
                    "imageResult": {"ok": True, "url": "/generated-edit.jpg", "mode": "closed-person"},
                }
            ),
            stderr="",
        )
        with (
            mock.patch.object(server, "_persona_archive_source_for_write", return_value=(Path("archive.json"), {}, [archive])),
            mock.patch.object(server, "_sync_tool_r18_api_config_for_persona_workflow"),
            mock.patch.object(server.subprocess, "run", return_value=completed) as run,
            mock.patch.object(server, "_persona_archive_persist_reference_image", return_value={"saved_item_id": "saved-edit"}),
        ):
            result = server._run_persona_image_cli_for_web(
                "persona-1",
                prompt="把西装改成红色连衣裙",
                source_image_id="img-edit-1",
            )

        cli_payload = json.loads(run.call_args.args[0][4])
        self.assertFalse(cli_payload["generateReferenceSheet"])
        self.assertTrue(cli_payload["editExistingImage"])
        self.assertEqual(cli_payload["referenceImageUrl"], "/library/edit-source.jpg")
        self.assertEqual(cli_payload["customPrompt"], "把西装改成红色连衣裙")
        self.assertEqual(cli_payload["content"], "")
        self.assertEqual(cli_payload.get("setup") or {}, {})
        self.assertEqual(result["generation"]["image_url"], "/generated-edit.jpg")

    def test_persona_image_library_downloads_remote_result_before_saving_record(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
            root = Path(tmpdir)
            archive_path = root / "persona_archives.json"
            archives = [{"id": "persona-1", "name": "测试人设", "setup": {}, "personaImageLibrary": []}]
            archive_path.write_text(json.dumps(archives, ensure_ascii=False), encoding="utf-8")

            def download(_url, target):
                target.write_bytes(b"persisted-image")

            with (
                mock.patch.object(server, "_persona_archive_source_for_write", return_value=(archive_path, archives, archives)),
                mock.patch.object(server, "_persona_media_root", return_value=root / "persona_media"),
                mock.patch.object(server, "_download_to_file", side_effect=download) as downloader,
            ):
                result = server._persona_archive_persist_reference_image(
                    "persona-1",
                    image_url="https://provider.example/result.png",
                )

            stored_url = result["current_reference_url"]
            stored_path = Path(stored_url).resolve()
            self.assertTrue(stored_path.is_relative_to((root / "persona_media").resolve()))
            self.assertEqual(stored_path.read_bytes(), b"persisted-image")
            self.assertEqual(archives[0]["personaImageLibrary"][0]["imageUrl"], stored_url)
            downloader.assert_called_once()

    def test_startup_releases_only_held_social_reservation_without_task(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
            db_path = Path(tmpdir) / "app.db"
            with mock.patch.dict(os.environ, {"APP_DB_PATH": str(db_path)}):
                db_module.init_db()
                now = server._now_ts()
                with db_module.db() as conn:
                    inserted = conn.execute(
                        """
                        INSERT INTO users(username, password_hash, created_at, updated_at)
                        VALUES ('startup-billing-user', 'unused', ?, ?)
                        """,
                        (now, now),
                    )
                    user_id = int(inserted.lastrowid)
                    conn.execute(
                        """
                        INSERT INTO billing_wallets(
                          user_id, credit_units, billing_mode, migrated_legacy_balance,
                          created_at, updated_at
                        ) VALUES (?, 970, 'enforced', 0, ?, ?)
                        """,
                        (user_id, now, now),
                    )
                    conn.execute(
                        """
                        INSERT INTO social_accounts(
                          id, user_id, persona_id, platform, username, profile_dir,
                          created_at, updated_at
                        ) VALUES (
                          'account-1', ?, 'persona-1', 'threads', 'startup-user',
                          'profiles/account-1', ?, ?
                        )
                        """,
                        (user_id, now, now),
                    )
                    conn.execute(
                        """
                        INSERT INTO social_automation_tasks(
                          id, user_id, persona_id, account_id, platform, task_type,
                          status, payload_json, created_at, updated_at
                        ) VALUES (
                          'social-existing', ?, 'persona-1', 'account-1', 'threads',
                          'publish_post', 'queued', '{}', ?, ?
                        )
                        """,
                        (user_id, now, now),
                    )
                    conn.execute(
                        """
                        INSERT INTO tasks(
                          id, user_id, type, status, input_json, output_json, error,
                          runninghub_task_id, usage_json, created_at, updated_at
                        ) VALUES (
                          'normal-existing', ?, 'get_gemini', 'succeeded', '{}', '{}',
                          '', '', '{}', ?, ?
                        )
                        """,
                        (user_id, now, now),
                    )
                    reservations = (
                        ("hold-social-orphan", "social_task", "social-missing", "held", 10, now - 301),
                        ("hold-social-fresh", "social_task", "social-fresh-missing", "held", 11, now),
                        ("hold-social-existing", "social_task", "social-existing", "held", 20, now),
                        ("hold-normal-existing", "normal_task", "normal-existing", "held", 30, now),
                        ("settled-social-orphan", "social_task", "settled-missing", "settled", 40, now),
                    )
                    for reservation_id, ref_type, ref_id, status, credit_units, created_at in reservations:
                        conn.execute(
                            """
                            INSERT INTO billing_reservations(
                              id, user_id, ref_type, ref_id, sku, status,
                              reserved_credit_units, settled_credit_units,
                              catalog_version_id, meta_json, idempotency_key,
                              created_at, updated_at
                            ) VALUES (?, ?, ?, ?, 'threads_text_publish', ?, ?, ?, '', '{}', ?, ?, ?)
                            """,
                            (
                                reservation_id,
                                user_id,
                                ref_type,
                                ref_id,
                                status,
                                credit_units if status == "held" else 0,
                                credit_units if status == "settled" else 0,
                                f"test:{reservation_id}",
                                created_at,
                                created_at,
                            ),
                        )

                server._resume_pending_tasks()
                server._resume_pending_tasks()

                with db_module.db() as conn:
                    statuses = {
                        str(row["id"]): str(row["status"])
                        for row in conn.execute(
                            "SELECT id, status FROM billing_reservations"
                        ).fetchall()
                    }
                    wallet_units = int(
                        conn.execute(
                            "SELECT credit_units FROM billing_wallets WHERE user_id = ?",
                            (user_id,),
                        ).fetchone()["credit_units"]
                    )
                    release_rows = conn.execute(
                        """
                        SELECT reservation_id
                        FROM billing_ledger
                        WHERE event_type = 'release'
                        ORDER BY reservation_id
                        """
                    ).fetchall()

        self.assertEqual(statuses["hold-social-orphan"], "released")
        self.assertEqual(statuses["hold-social-fresh"], "held")
        self.assertEqual(statuses["hold-social-existing"], "held")
        self.assertEqual(statuses["hold-normal-existing"], "held")
        self.assertEqual(statuses["settled-social-orphan"], "settled")
        self.assertEqual(wallet_units, 980)
        self.assertEqual(
            [str(row["reservation_id"]) for row in release_rows],
            ["hold-social-orphan"],
        )


if __name__ == "__main__":
    unittest.main()
