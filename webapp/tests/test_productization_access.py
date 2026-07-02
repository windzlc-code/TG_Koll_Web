import json
import os
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import webapp.server as server
from webapp import db as db_module
from webapp.auth import hash_password


class ProductizationAccessTests(unittest.TestCase):
    def setUp(self):
        self._old_env = {
            "APP_DB_PATH": os.environ.get("APP_DB_PATH"),
            "APP_RUNTIME_CONFIG_PATH": os.environ.get("APP_RUNTIME_CONFIG_PATH"),
            "WEBAPP_DATA_DIR": os.environ.get("WEBAPP_DATA_DIR"),
            "ALLOW_PUBLIC_REGISTER": os.environ.get("ALLOW_PUBLIC_REGISTER"),
        }
        self._old_paths = {
            "DATA_DIR": server.DATA_DIR,
            "UPLOAD_ROOT": server.UPLOAD_ROOT,
            "OUTPUT_ROOT": server.OUTPUT_ROOT,
            "RUNTIME_CONFIG_PATH": server.RUNTIME_CONFIG_PATH,
        }
        self._tmpdir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmpdir.name)
        os.environ["WEBAPP_DATA_DIR"] = str(self.data_dir)
        os.environ["APP_DB_PATH"] = str(self.data_dir / "app.db")
        os.environ["APP_RUNTIME_CONFIG_PATH"] = str(self.data_dir / "runtime_config.json")
        os.environ.pop("ALLOW_PUBLIC_REGISTER", None)
        server.DATA_DIR = self.data_dir
        server.UPLOAD_ROOT = self.data_dir / "uploads"
        server.OUTPUT_ROOT = self.data_dir / "outputs"
        server.RUNTIME_CONFIG_PATH = self.data_dir / "runtime_config.json"
        with patch.object(server, "_resume_pending_tasks", return_value=None), \
             patch.object(server, "_start_task_workers", return_value=None), \
             patch.object(server, "_start_cleanup_worker", return_value=None):
            self.client = TestClient(server.create_app())

    def tearDown(self):
        for key, value in self._old_paths.items():
            setattr(server, key, value)
        for key, value in self._old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._tmpdir.cleanup()

    def _login_admin(self):
        resp = self.client.post("/api/auth/login", json={"username": "admin", "password": "admin123"})
        self.assertEqual(resp.status_code, 200, resp.text)

    def _create_customer(self, username="customer001", password="customer123", balance_cents=1000):
        self._login_admin()
        resp = self.client.post(
            "/api/admin/users",
            json={
                "username": username,
                "password": password,
                "is_admin": False,
                "balance_cents": balance_cents,
            },
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()["user"]

    def _login_customer(self, username="customer001", password="customer123"):
        resp = self.client.post("/api/auth/login", json={"username": username, "password": password})
        self.assertEqual(resp.status_code, 200, resp.text)

    def test_public_registration_disabled_by_default(self):
        resp = self.client.post("/api/auth/register", json={"username": "new_customer", "password": "newpass123"})
        self.assertEqual(resp.status_code, 403)
        self.assertIn("管理员开通", resp.json()["detail"])
        with db_module.db() as conn:
            count = conn.execute("SELECT COUNT(*) AS c FROM users WHERE username = ?", ("new_customer",)).fetchone()["c"]
        self.assertEqual(count, 0)

    def test_admin_can_create_customer_with_initial_balance_and_customer_can_login(self):
        customer = self._create_customer(balance_cents=2500)
        self.assertEqual(customer["username"], "customer001")
        self.assertEqual(customer["is_admin"], 0)
        self.assertEqual(customer["balance_cents"], 2500)

        self._login_customer()
        me = self.client.get("/api/me")
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()["username"], "customer001")
        self.assertEqual(me.json()["balance_cents"], 2500)

    def test_non_admin_cannot_create_customer(self):
        self._create_customer()
        self._login_customer()
        resp = self.client.post(
            "/api/admin/users",
            json={"username": "blocked", "password": "blocked123", "balance_cents": 100},
        )
        self.assertEqual(resp.status_code, 403)

    def test_admin_can_recharge_customer_and_ledger_is_written(self):
        customer = self._create_customer(balance_cents=100)
        resp = self.client.post(
            f"/api/admin/users/{customer['id']}/recharge",
            json={"amount_cents": 900, "note": "test recharge"},
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["balance_cents"], 1000)
        with db_module.db() as conn:
            row = conn.execute(
                "SELECT type, amount_cents, meta_json FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
                (customer["id"],),
            ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["type"], "recharge")
        self.assertEqual(row["amount_cents"], 900)
        self.assertEqual(json.loads(row["meta_json"])["admin_username"], "admin")

    def test_admin_recharge_rejects_non_positive_amount(self):
        customer = self._create_customer(balance_cents=100)
        resp = self.client.post(
            f"/api/admin/users/{customer['id']}/recharge",
            json={"amount_cents": 0, "note": "bad"},
        )
        self.assertEqual(resp.status_code, 400)
        with db_module.db() as conn:
            bal = conn.execute("SELECT balance_cents FROM users WHERE id = ?", (customer["id"],)).fetchone()["balance_cents"]
        self.assertEqual(bal, 100)

    def test_recent_image_card_renderer_uses_image_tag_for_thumbnail(self):
        js_path = Path(server.__file__).resolve().parent / "static" / "assets" / "app.js"
        js_text = js_path.read_text(encoding="utf-8")
        self.assertIn("<img class=\"recent-image-thumb-img\"", js_text)

        css_path = Path(server.__file__).resolve().parent / "static" / "assets" / "style.css"
        css_text = css_path.read_text(encoding="utf-8")
        self.assertIn(".recent-image-card", css_text)
        self.assertIn(".recent-image-thumb", css_text)
        self.assertIn(".recent-image-mode", css_text)

        css_path = Path(server.__file__).resolve().parent / "static" / "assets" / "style.css"
        css_text = css_path.read_text(encoding="utf-8")
        self.assertIn(".upload-slot.mode-optional::after", css_text)
        self.assertIn("可跳过", css_text)

    def test_style_sheet_contains_image_mode_emphasis_classes(self):
        css_path = Path(server.__file__).resolve().parent / "static" / "assets" / "style.css"
        css_text = css_path.read_text(encoding="utf-8")
        self.assertIn(".upload-slot.mode-optional", css_text)
        self.assertIn(".upload-slot.mode-required", css_text)

    def test_index_page_contains_image_mode_hint_nodes(self):
        self._create_customer(balance_cents=1000)
        self._login_customer()
        resp = self.client.get("/index.html")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertIn('id="imageModeHint"', resp.text)
        self.assertIn('id="modelSlotHint"', resp.text)
        self.assertIn('id="productSlotHint"', resp.text)

    def test_index_page_contains_explicit_image_mode_control(self):
        self._create_customer(balance_cents=1000)
        self._login_customer()
        resp = self.client.get("/index.html")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertIn('id="imageGenerateMode"', resp.text)
        self.assertIn('仅商品图', resp.text)
        self.assertIn('模特图 + 商品图', resp.text)

    def test_index_page_uses_material_generation_as_primary_entry_label(self):
        self._create_customer(balance_cents=1000)
        self._login_customer()
        resp = self.client.get("/index.html")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertIn('data-page="generate">素材生成</button>', resp.text)
        self.assertIn('id="currentPageLabel">素材生成</div>', resp.text)
        self.assertIn('id="generatePageTitle">素材生成</h2>', resp.text)

    def test_index_page_contains_explicit_primary_mode_tabs_for_image_and_video(self):
        self._create_customer(balance_cents=1000)
        self._login_customer()
        resp = self.client.get("/index.html")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertIn('id="taskTypeTabs"', resp.text)
        self.assertIn('id="taskTypeModeVideo"', resp.text)
        self.assertIn('id="taskTypeModeImage"', resp.text)
        self.assertIn('data-task-type="commerce_video"', resp.text)
        self.assertIn('data-task-type="image_generate"', resp.text)

    def test_app_js_contains_primary_task_type_tab_wiring(self):
        js_path = Path(server.__file__).resolve().parent / "static" / "assets" / "app.js"
        js_text = js_path.read_text(encoding="utf-8")
        self.assertIn('generate: "素材生成"', js_text)
        self.assertIn('function syncTaskTypeTabs()', js_text)
        self.assertIn('taskTypeModeVideo', js_text)
        self.assertIn('taskTypeModeImage', js_text)

    def test_index_page_contains_comfy_image_generation_controls(self):
        self._create_customer(balance_cents=1000)
        self._login_customer()
        resp = self.client.get("/index.html")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertIn('data-task-type="image_generate"', resp.text)
        self.assertNotIn('id="imageGenerateProvider"', resp.text)
        self.assertNotIn('闭源模型 API', resp.text)
        self.assertNotIn('id="imageGenerateModelWrap"', resp.text)
        self.assertNotIn('id="imageGenerateModel"', resp.text)

    def test_admin_runtime_page_contains_editable_image_and_llm_service_fields(self):
        self._login_admin()
        resp = self.client.get("/admin.html")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertIn('图片生成服务', resp.text)
        self.assertIn('文字大模型（Gemini）', resp.text)
        self.assertIn('id="rtImageRunninghubWorkflowId"', resp.text)
        self.assertIn('id="rtImageModelProviderBaseUrl"', resp.text)
        self.assertIn('id="rtImageModelProviderApiKeyGemini"', resp.text)
        self.assertIn('id="rtImageModelProviderApiKeyGpt"', resp.text)
        self.assertIn('id="rtLlmBaseUrl"', resp.text)
        self.assertIn('id="rtLlmApiKey"', resp.text)

    def test_app_js_contains_quick_video_slot_hint_reset_copy(self):
        js_path = Path(server.__file__).resolve().parent / "static" / "assets" / "app.js"
        js_text = js_path.read_text(encoding="utf-8")
        self.assertIn("快速模式下必须上传 1 张模特图。", js_text)
        self.assertIn("当前已复用场景图，无需重复上传商品图。", js_text)

    def test_customer_submit_image_generate_with_single_product_image_enqueues_payload(self):
        self._create_customer(balance_cents=1000)
        self._login_customer()
        with patch.object(server, "_new_id", return_value="task_image_generate"), \
             patch.object(server, "_enqueue_task") as enqueue_mock:
            resp = self.client.post(
                "/api/tasks/submit",
                data={"task_type": "image_generate", "params_json": json.dumps({"mode": "product_only", "prompt": "生成电商展示图"})},
                files=[
                    ("files", ("product.jpg", b"product-bytes", "image/jpeg")),
                ],
            )
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["task_type"], "image_generate")
        enqueue_mock.assert_called_once()
        task_id, user_id, task_type, payload = enqueue_mock.call_args.args
        self.assertEqual(task_id, "task_image_generate")
        self.assertGreater(user_id, 0)
        self.assertEqual(task_type, "image_generate")
        self.assertEqual(payload["mode"], "product_only")
        self.assertTrue(str(payload["product_image_local_path"]).endswith("file_1.jpg"))
        self.assertEqual(str(payload.get("model_image_local_path") or ""), "")

    def test_customer_submit_image_generate_with_model_and_product_images_enqueues_payload(self):
        self._create_customer(balance_cents=1000)
        self._login_customer()
        with patch.object(server, "_new_id", return_value="task_image_generate_both"), \
             patch.object(server, "_enqueue_task") as enqueue_mock:
            resp = self.client.post(
                "/api/tasks/submit",
                data={"task_type": "image_generate", "params_json": json.dumps({"mode": "model_product", "prompt": "模特手持商品"})},
                files=[
                    ("files", ("model.png", b"model-bytes", "image/png")),
                    ("files", ("product.jpg", b"product-bytes", "image/jpeg")),
                ],
            )
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["task_type"], "image_generate")
        enqueue_mock.assert_called_once()
        _task_id, _user_id, task_type, payload = enqueue_mock.call_args.args
        self.assertEqual(task_type, "image_generate")
        self.assertEqual(payload["mode"], "model_product")
        self.assertTrue(str(payload["model_image_local_path"]).endswith("file_1.png"))
        self.assertTrue(str(payload["product_image_local_path"]).endswith("file_2.jpg"))

    def test_customer_submit_image_generate_infers_model_product_mode_when_two_images_uploaded(self):
        self._create_customer(balance_cents=1000)
        self._login_customer()
        with patch.object(server, "_new_id", return_value="task_image_generate_infer"), \
             patch.object(server, "_enqueue_task") as enqueue_mock:
            resp = self.client.post(
                "/api/tasks/submit",
                data={"task_type": "image_generate", "params_json": json.dumps({"prompt": "模特手持商品"})},
                files=[
                    ("files", ("model.png", b"model-bytes", "image/png")),
                    ("files", ("product.jpg", b"product-bytes", "image/jpeg")),
                ],
            )
        self.assertEqual(resp.status_code, 200, resp.text)
        _task_id, _user_id, task_type, payload = enqueue_mock.call_args.args
        self.assertEqual(task_type, "image_generate")
        self.assertEqual(payload["mode"], "model_product")
        self.assertTrue(str(payload["model_image_local_path"]).endswith("file_1.png"))
        self.assertTrue(str(payload["product_image_local_path"]).endswith("file_2.jpg"))

    def test_customer_submit_image_generate_rejects_missing_required_images(self):
        self._create_customer(balance_cents=1000)
        self._login_customer()
        with patch.object(server, "_new_id", return_value="task_image_missing"), \
             patch.object(server, "_enqueue_task") as enqueue_mock:
            resp = self.client.post(
                "/api/tasks/submit",
                data={"task_type": "image_generate", "params_json": json.dumps({"mode": "model_product", "prompt": "模特手持商品"})},
                files=[("files", ("product.jpg", b"product-bytes", "image/jpeg"))],
            )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("图片生成", resp.json()["detail"])
        enqueue_mock.assert_not_called()
        self.assertFalse((server.UPLOAD_ROOT / "customer001" / "task_image_missing").exists())

    def test_customer_submit_commerce_video_with_two_images_enqueues_ordered_payload(self):
        self._create_customer(balance_cents=1000)
        self._login_customer()
        with patch.object(server, "_new_id", return_value="task_test"), \
             patch.object(server, "_enqueue_task") as enqueue_mock:
            resp = self.client.post(
                "/api/tasks/submit",
                data={"task_type": "commerce_video", "params_json": "{}"},
                files=[
                    ("files", ("model.png", b"model-bytes", "image/png")),
                    ("files", ("product.jpg", b"product-bytes", "image/jpeg")),
                ],
            )
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["task_type"], "commerce_video")
        enqueue_mock.assert_called_once()
        task_id, user_id, task_type, payload = enqueue_mock.call_args.args
        self.assertEqual(task_id, "task_test")
        self.assertGreater(user_id, 0)
        self.assertEqual(task_type, "commerce_video")
        self.assertTrue(str(payload["model_image_local_path"]).endswith("file_1.png"))
        self.assertTrue(str(payload["product_image_local_path"]).endswith("file_2.jpg"))

    def test_customer_submit_commerce_video_rejects_single_image_and_does_not_enqueue(self):
        self._create_customer(balance_cents=1000)
        self._login_customer()
        with patch.object(server, "_new_id", return_value="task_single_image"), \
             patch.object(server, "_enqueue_task") as enqueue_mock:
            resp = self.client.post(
                "/api/tasks/submit",
                data={"task_type": "commerce_video", "params_json": "{}"},
                files=[("files", ("model.png", b"model-bytes", "image/png"))],
            )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("2 张图片", resp.json()["detail"])
        enqueue_mock.assert_not_called()
        self.assertFalse((server.UPLOAD_ROOT / "customer001" / "task_single_image").exists())

    def test_batch_run_rejects_unsafe_plan_paths_before_enqueue(self):
        self._create_customer(balance_cents=1000)
        self._login_customer()
        plan_id = "plan_aaaaaaaaaaaaaaaaaaaa"
        plan_dir = server.UPLOAD_ROOT / "customer001" / plan_id
        plan_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(plan_dir / "batch_zip.zip", "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("model.png", b"model")
            zf.writestr("product.png", b"product")

        with patch.object(server, "_enqueue_task") as enqueue_mock:
            resp = self.client.post(
                "/api/batch/create_video/run",
                json={
                    "plan_id": plan_id,
                    "plan": {
                        "items": [
                            {
                                "id": "item_1",
                                "model_image": "../../runtime_config.json",
                                "product_image": "product.png",
                            }
                        ]
                    },
                },
            )

        self.assertEqual(resp.status_code, 400)
        self.assertIn("路径不安全", resp.json()["detail"])
        enqueue_mock.assert_not_called()

    def test_regular_user_task_list_only_returns_own_tasks(self):
        now = int(time.time())
        with db_module.db() as conn:
            conn.execute(
                "INSERT INTO users(username, password_hash, is_admin, is_disabled, balance_cents, created_at, updated_at) VALUES (?, ?, 0, 0, 100, ?, ?)",
                ("alice", hash_password("alice123"), now, now),
            )
            conn.execute(
                "INSERT INTO users(username, password_hash, is_admin, is_disabled, balance_cents, created_at, updated_at) VALUES (?, ?, 0, 0, 100, ?, ?)",
                ("bob", hash_password("bob1234"), now, now),
            )
            alice_id = conn.execute("SELECT id FROM users WHERE username = ?", ("alice",)).fetchone()["id"]
            bob_id = conn.execute("SELECT id FROM users WHERE username = ?", ("bob",)).fetchone()["id"]
            for task_id, uid in (("task_alice", alice_id), ("task_bob", bob_id)):
                conn.execute(
                    """
                    INSERT INTO tasks(id, user_id, type, status, input_json, output_json, error, runninghub_task_id, usage_json, cost_cents, created_at, updated_at)
                    VALUES (?, ?, 'commerce_video', 'success', '{}', '{}', '', '', '{}', 0, ?, ?)
                    """,
                    (task_id, uid, now, now),
                )
        resp = self.client.post("/api/auth/login", json={"username": "alice", "password": "alice123"})
        self.assertEqual(resp.status_code, 200)
        list_resp = self.client.get("/api/tasks")
        self.assertEqual(list_resp.status_code, 200)
        self.assertEqual([item["id"] for item in list_resp.json()["items"]], ["task_alice"])

    def test_regular_user_cannot_read_or_download_other_user_task(self):
        output_file = self.data_dir / "bob-output.mp4"
        output_file.write_bytes(b"video")
        now = int(time.time())
        with db_module.db() as conn:
            conn.execute(
                "INSERT INTO users(username, password_hash, is_admin, is_disabled, balance_cents, created_at, updated_at) VALUES (?, ?, 0, 0, 100, ?, ?)",
                ("alice", hash_password("alice123"), now, now),
            )
            conn.execute(
                "INSERT INTO users(username, password_hash, is_admin, is_disabled, balance_cents, created_at, updated_at) VALUES (?, ?, 0, 0, 100, ?, ?)",
                ("bob", hash_password("bob1234"), now, now),
            )
            bob_id = conn.execute("SELECT id FROM users WHERE username = ?", ("bob",)).fetchone()["id"]
            conn.execute(
                """
                INSERT INTO tasks(id, user_id, type, status, input_json, output_json, error, runninghub_task_id, usage_json, cost_cents, created_at, updated_at)
                VALUES (?, ?, 'commerce_video', 'success', '{}', ?, '', '', '{}', 0, ?, ?)
                """,
                ("task_bob", bob_id, json.dumps({"download_path": str(output_file)}), now, now),
            )
        resp = self.client.post("/api/auth/login", json={"username": "alice", "password": "alice123"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self.client.get("/api/tasks/task_bob").status_code, 404)
        self.assertEqual(self.client.get("/api/tasks/task_bob/download").status_code, 404)


if __name__ == "__main__":
    unittest.main()
