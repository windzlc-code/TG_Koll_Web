from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path

from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core.runninghub_image_models import (
    GPT_IMAGE2_MODEL_ID,
    GPT_IMAGE2_OFFICIAL_MODEL_ID,
    NANO_BANANA2_MODEL_ID,
    NANO_BANANA2_OFFICIAL_MODEL_ID,
    NANO_BANANA_PRO_MODEL_ID,
    NANO_BANANA_PRO_OFFICIAL_MODEL_ID,
    RequestsRunningHubImageTransport,
    generate_image_with_fallback,
    normalize_model_order,
    resolve_api_key,
)


class _HttpResponse:
    def __init__(self, body=None, *, status_code=200, chunks=()) -> None:
        self.body = body or {}
        self.status_code = status_code
        self.text = ""
        self.chunks = list(chunks)

    def json(self):
        return self.body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size=8192):
        del chunk_size
        return iter(self.chunks)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class _HttpSession:
    def __init__(self) -> None:
        self.trust_env = True
        self.posts: list[dict] = []
        self.gets: list[dict] = []

    def post(self, url, **kwargs):
        self.posts.append({"url": url, **kwargs})
        if url.endswith("/media/upload/binary"):
            return _HttpResponse({"code": 0, "data": {"fileName": "media/input.png"}})
        if url.endswith("/query"):
            return _HttpResponse(status_code=405)
        return _HttpResponse({"code": 0, "data": {"taskId": "rh-http"}})

    def get(self, url, **kwargs):
        self.gets.append({"url": url, **kwargs})
        if url.endswith("/query"):
            return _HttpResponse({"code": 0, "data": {"status": "SUCCESS", "imageUrl": "https://cdn.invalid/final.png"}})
        return _HttpResponse(chunks=[b"http-", b"image"])


class _FakeTransport:
    def __init__(self) -> None:
        self.uploads: list[dict] = []
        self.submissions: list[dict] = []
        self.queries: list[dict] = []
        self.downloads: list[dict] = []
        self.sleeps: list[float] = []
        self.submit_results: list[object] = [{"data": {"imageUrl": "https://result.invalid/image.png"}}]
        self.query_results: list[dict] = []
        self.query_hook = None

    def upload_image(self, **kwargs):
        self.uploads.append(kwargs)
        kwargs["check_cancelled"]()
        return f"https://upload.invalid/{kwargs['file_path'].name}"

    def submit(self, **kwargs):
        self.submissions.append(kwargs)
        result = self.submit_results.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result

    def query(self, **kwargs):
        self.queries.append(kwargs)
        if self.query_hook is not None:
            self.query_hook()
        return self.query_results.pop(0)

    def download(self, **kwargs):
        self.downloads.append(kwargs)
        kwargs["check_cancelled"]()
        kwargs["output_path"].write_bytes(b"generated-image")

    def sleep(self, seconds):
        self.sleeps.append(seconds)


class RunningHubImageModelsTests(unittest.TestCase):
    def test_friendly_aliases_and_official_ids_select_original_endpoints(self):
        cases = {
            "gpt-image-2": (GPT_IMAGE2_MODEL_ID, "/openapi/v2/rhart-image-g-2/text-to-image"),
            GPT_IMAGE2_OFFICIAL_MODEL_ID: (
                GPT_IMAGE2_OFFICIAL_MODEL_ID,
                "/openapi/v2/rhart-image-g-2-official/text-to-image",
            ),
            "nano-banana-2": (NANO_BANANA2_MODEL_ID, "/openapi/v2/rhart-image-n-g31-flash/text-to-image"),
            NANO_BANANA2_OFFICIAL_MODEL_ID: (
                NANO_BANANA2_OFFICIAL_MODEL_ID,
                "/openapi/v2/rhart-image-n-g31-flash-official/text-to-image",
            ),
            "nano Banana Pro": (NANO_BANANA_PRO_MODEL_ID, "/openapi/v2/rhart-image-n-pro/text-to-image"),
            NANO_BANANA_PRO_OFFICIAL_MODEL_ID: (
                NANO_BANANA_PRO_OFFICIAL_MODEL_ID,
                "/openapi/v2/rhart-image-n-pro-official/text-to-image",
            ),
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            for index, (configured, expected) in enumerate(cases.items()):
                with self.subTest(model=configured):
                    transport = _FakeTransport()
                    output = Path(tmpdir) / f"result-{index}.png"
                    result = generate_image_with_fallback(
                        {"runninghub_enterprise_api_key": "enterprise", "image_generate_model": configured},
                        "product photo",
                        [],
                        output,
                        transport=transport,
                    )
                    self.assertTrue(transport.submissions[0]["url"].endswith(expected))
                    self.assertEqual(result["selected_model"], normalize_model_order(configured)[0])
                    self.assertEqual(output.read_bytes(), b"generated-image")

    def test_enterprise_and_shared_keys_are_preferred_over_legacy_and_personal(self):
        payload = {
            "runninghub_personal_api_key": "personal",
            "runninghub_api_key": "legacy",
            "video_runninghub_api_key": "video",
            "runninghub_shared_api_key": "shared",
            "runninghub_enterprise_api_key": "enterprise",
        }
        self.assertEqual(resolve_api_key(payload), "enterprise")
        payload["runninghub_enterprise_api_key"] = ""
        self.assertEqual(resolve_api_key(payload), "shared")

    def test_image_to_image_uploads_each_unique_input_and_preserves_request_parameters(self):
        transport = _FakeTransport()
        with tempfile.TemporaryDirectory() as tmpdir:
            first = Path(tmpdir) / "first.png"
            second = Path(tmpdir) / "second.jpg"
            first.write_bytes(b"one")
            second.write_bytes(b"two")
            output = Path(tmpdir) / "result.png"
            generate_image_with_fallback(
                {
                    "runninghub_enterprise_api_key": "enterprise",
                    "runninghub_personal_api_key": "personal",
                    "image_generate_model": "nano banana pro",
                    "aspect_ratio": "portrait",
                    "resolution": "1080p",
                    "runninghub_instance_type": "plus",
                },
                "replace the product",
                [first, first, second],
                output,
                transport=transport,
            )
        self.assertEqual([item["file_path"].name for item in transport.uploads], ["first.png", "second.jpg"])
        self.assertTrue(transport.submissions[0]["url"].endswith("/openapi/v2/rhart-image-n-pro/edit"))
        self.assertEqual(transport.submissions[0]["api_key"], "enterprise")
        self.assertEqual(
            transport.submissions[0]["body"],
            {
                "prompt": "replace the product",
                "aspectRatio": "9:16",
                "resolution": "2K",
                "imageUrls": ["https://upload.invalid/first.png", "https://upload.invalid/second.jpg"],
                "instanceType": "plus",
            },
        )

    def test_submit_query_register_and_download_form_a_complete_task_loop(self):
        transport = _FakeTransport()
        transport.submit_results = [{"data": {"taskId": "rh-task-1"}}]
        transport.query_results = [
            {"data": {"taskStatus": "RUNNING"}},
            {"data": {"taskStatus": "SUCCESS", "imageUrl": "https://result.invalid/final.webp"}},
        ]
        registered: list[dict] = []
        payload = {
            "_task_id": "local-task",
            "_register_runninghub_task": lambda **values: registered.append(values),
            "runninghub_enterprise_api_key": "enterprise",
            "image_generate_model": "gpt image 2",
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "result.webp"
            result = generate_image_with_fallback(
                payload,
                "studio photo",
                [],
                output,
                transport=transport,
                poll_interval_seconds=0,
            )
            self.assertEqual(output.read_bytes(), b"generated-image")
        self.assertEqual([item["task_id"] for item in transport.queries], ["rh-task-1", "rh-task-1"])
        self.assertTrue(transport.queries[0]["url"].endswith("/openapi/v2/query"))
        self.assertEqual(registered[0]["task_id"], "local-task")
        self.assertEqual(registered[0]["runninghub_task_id"], "rh-task-1")
        self.assertEqual(result["runninghub_task_ids"], ["rh-task-1"])
        self.assertEqual(payload["runninghub_task_ids"], ["rh-task-1"])

    def test_default_http_transport_uses_upload_post_query_get_fallback_and_stream_download(self):
        session = _HttpSession()
        transport = RequestsRunningHubImageTransport(session=session)
        with tempfile.TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / "source.png"
            source.write_bytes(b"source")
            output = Path(tmpdir) / "result.png"
            result = generate_image_with_fallback(
                {
                    "runninghub_enterprise_api_key": "enterprise",
                    "image_generate_model": "nano banana 2",
                    "image_model_provider_base_url": "https://runninghub.invalid/",
                },
                "http transport test",
                [source],
                output,
                transport=transport,
                poll_interval_seconds=0,
            )
            self.assertEqual(output.read_bytes(), b"http-image")
        self.assertFalse(session.trust_env)
        self.assertTrue(session.posts[0]["url"].endswith("/openapi/v2/media/upload/binary"))
        self.assertEqual(session.posts[0]["headers"]["Authorization"], "Bearer enterprise")
        self.assertTrue(session.posts[1]["url"].endswith("/openapi/v2/rhart-image-n-g31-flash/image-to-image"))
        self.assertTrue(session.posts[2]["url"].endswith("/openapi/v2/query"))
        self.assertEqual(session.gets[0]["params"], {"taskId": "rh-http"})
        self.assertEqual(session.gets[1]["url"], "https://cdn.invalid/final.png")
        self.assertEqual(result["runninghub_task_id"], "rh-http")

    def test_model_failures_fall_back_in_configured_order(self):
        transport = _FakeTransport()
        transport.submit_results = [RuntimeError("gpt unavailable"), {"imageUrl": "https://result.invalid/ok.png"}]
        with tempfile.TemporaryDirectory() as tmpdir:
            result = generate_image_with_fallback(
                {
                    "runninghub_enterprise_api_key": "enterprise",
                    "image_model_priority_order": "gpt image 2, nano banana 2, nano banana pro",
                },
                "fallback photo",
                [],
                Path(tmpdir) / "result.png",
                transport=transport,
            )
        self.assertEqual(result["selected_model"], NANO_BANANA2_MODEL_ID)
        self.assertEqual([item["model"] for item in result["image_model_attempts"]], [GPT_IMAGE2_MODEL_ID, NANO_BANANA2_MODEL_ID])
        self.assertEqual([item["ok"] for item in result["image_model_attempts"]], [False, True])

    def test_restart_resume_polls_existing_image_task_without_duplicate_submission(self):
        transport = _FakeTransport()
        transport.query_results = [
            {"status": "SUCCESS", "imageUrl": "https://result.invalid/resumed.png"},
        ]
        checkpoints: list[dict] = []
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "resumed.png"
            result = generate_image_with_fallback(
                {
                    "_task_id": "local-resume",
                    "_checkpoint_video_progress": lambda **values: checkpoints.append(values),
                    "runninghub_enterprise_api_key": "enterprise",
                    "image_generate_model": "gpt image 2",
                    "resume_runninghub_task_id": "rh-existing",
                },
                "resume image",
                [],
                output,
                transport=transport,
                poll_interval_seconds=0,
            )
        self.assertEqual(transport.submissions, [])
        self.assertEqual(transport.queries[0]["task_id"], "rh-existing")
        self.assertEqual(result["runninghub_task_id"], "rh-existing")
        self.assertEqual([item["stage"] for item in checkpoints], ["provider_running", "provider_success"])

    def test_cancellation_stops_polling_without_falling_back_or_downloading(self):
        event = threading.Event()
        context = VideoTaskContext(task_id="cancel-me", task_type="image_generate", cancel_event=event)
        transport = _FakeTransport()
        transport.submit_results = [{"taskId": "rh-cancel"}]
        transport.query_results = [{"status": "RUNNING"}]
        transport.query_hook = event.set
        with tempfile.TemporaryDirectory() as tmpdir:
            with self.assertRaises(VideoTaskCancelled):
                generate_image_with_fallback(
                    {
                        "runninghub_enterprise_api_key": "enterprise",
                        "image_model_priority_order": "gpt image 2, nano banana 2",
                    },
                    "cancel photo",
                    [],
                    Path(tmpdir) / "result.png",
                    context,
                    transport=transport,
                    poll_interval_seconds=0,
                )
        self.assertEqual(len(transport.submissions), 1)
        self.assertEqual(len(transport.queries), 1)
        self.assertEqual(transport.downloads, [])

    def test_tests_never_fall_through_to_default_network_transport(self):
        transport = _FakeTransport()
        with tempfile.TemporaryDirectory() as tmpdir:
            result = generate_image_with_fallback(
                {"runninghub_enterprise_api_key": "fake-only", "image_generate_model": "gpt image 2"},
                "offline test",
                [],
                Path(tmpdir) / "result.png",
                transport=transport,
            )
        self.assertTrue(result["ok"])
        self.assertEqual(len(transport.submissions), 1)


if __name__ == "__main__":
    unittest.main()
