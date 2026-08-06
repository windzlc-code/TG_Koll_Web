from __future__ import annotations

import json
import tempfile
import unittest
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from video_core.contracts import VideoTaskContext
from video_core.source_backend import ArchivedSourceBackend


class _FakeEcommerceBackend(ArchivedSourceBackend):
    def __init__(self) -> None:
        super().__init__()
        self.submissions: list[dict] = []

    def _resolve_media(self, **kwargs):
        return f"https://media.invalid/{kwargs['media_kind']}"

    def _submit_and_poll(self, **kwargs):
        self.submissions.append(kwargs)
        output_path = kwargs["output_path"]
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"video")
        return {"status": "success", "runninghub_task_id": "rh-storyboard-1"}


class ArchivedVideoSourceBackendTest(unittest.TestCase):
    @staticmethod
    def _context(task_type: str) -> VideoTaskContext:
        return VideoTaskContext(task_id=f"task-{task_type}", task_type=task_type)

    @staticmethod
    def _write_image(directory: str, name: str) -> str:
        path = Path(directory) / name
        path.write_bytes(b"image")
        return str(path)

    def test_explicit_video_tts_settings_override_legacy_runtime_aliases(self):
        captured: dict = {}

        class FakeResponse:
            @staticmethod
            def raise_for_status():
                return None

            @staticmethod
            def json():
                return {"base_resp": {"status_code": 0}, "data": {"audio": "00"}}

        def fake_post(url, **kwargs):
            captured["url"] = url
            captured["json"] = kwargs["json"]
            return FakeResponse()

        with tempfile.TemporaryDirectory() as tmpdir:
            backend = ArchivedSourceBackend()
            backend.http = SimpleNamespace(post=fake_post)
            output = backend._generate_minimax_tts(
                speech_text="hello",
                output_path=Path(tmpdir) / "speech.mp3",
                payload={
                    "video_tts_api_key": "test-key",
                    "video_tts_base_url": "https://video.example.invalid",
                    "minimax_base_url": "https://legacy.example.invalid",
                    "video_tts_model": "explicit-video-model",
                    "minimax_tts_model": "legacy-runtime-model",
                    "video_default_voice_id": "explicit-video-voice",
                    "minimax_tts_voice_id": "legacy-runtime-voice",
                },
                context=self._context("create_video"),
            )
            output_bytes = output.read_bytes()

        self.assertEqual(captured["url"], "https://video.example.invalid/v1/t2a_v2")
        self.assertEqual(captured["json"]["model"], "explicit-video-model")
        self.assertEqual(captured["json"]["voice_setting"]["voice_id"], "explicit-video-voice")
        self.assertEqual(output_bytes, b"\x00")

    def test_image_generate_builds_mode_specific_prompts_and_inputs(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            first = self._write_image(tmpdir, "first.png")
            second = self._write_image(tmpdir, "second.png")
            cases = {
                "product_only": ({"product_image_local_path": first, "product_name": "Jacket"}, "纯产品电商广告图", 1),
                "model_product": (
                    {"product_image_local_path": first, "model_image_local_path": second, "style_hint": "studio"},
                    "图2人物",
                    2,
                ),
                "subject_replace": (
                    {"source_image_local_path": first, "subject_image_local_path": second, "subject_kind": "person"},
                    "纯局部图片主体替换任务",
                    2,
                ),
                "poster_translate": (
                    {"poster_image_local_path": first, "source_language": "English", "target_language": "Chinese"},
                    "电商海报文字语种切换任务",
                    1,
                ),
                "digital_human_character": ({"negative_prompt": "watermark"}, "数字人人设三视图", 0),
                "three_view": ({"reference_image_local_path": first}, "结构参考三视图", 1),
            }
            calls: list[dict] = []

            def fake_generate_image(**kwargs):
                calls.append(kwargs)
                Path(kwargs["output_image_path"]).write_bytes(b"generated")
                return {"image_path": kwargs["output_image_path"], "selected_model": "fake"}

            with patch("video_core.source_backend.image_model_api.generate_image", side_effect=fake_generate_image):
                for mode, (extra, marker, input_count) in cases.items():
                    with self.subTest(mode=mode):
                        payload = {
                            "output_dir": str(Path(tmpdir) / mode),
                            "video_image_mode": mode,
                            "prompt": "user creative direction",
                            **extra,
                        }
                        result = ArchivedSourceBackend().image_generate(
                            task_id=f"task-{mode}", payload=payload, context=self._context("image_generate")
                        )
                        call = calls[-1]
                        self.assertIn(marker, call["prompt"])
                        if mode != "poster_translate":
                            self.assertIn("user creative direction", call["prompt"])
                        self.assertEqual(len(call["input_image_paths"]), input_count)
                        self.assertEqual(result["raw_result"]["mode"], mode)

    def test_image_generate_count_returns_every_generated_output(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            reference = self._write_image(tmpdir, "product.png")
            output_dir = Path(tmpdir) / "outputs"
            calls: list[dict] = []

            def fake_generate_image(**kwargs):
                calls.append(kwargs)
                Path(kwargs["output_image_path"]).write_bytes(f"image-{len(calls)}".encode())
                return {"image_path": kwargs["output_image_path"], "selected_model": "fake"}

            with patch("video_core.source_backend.image_model_api.generate_image", side_effect=fake_generate_image):
                result = ArchivedSourceBackend().image_generate(
                    task_id="task-count",
                    payload={
                        "output_dir": str(output_dir),
                        "video_image_mode": "product_only",
                        "product_image_local_path": reference,
                        "prompt": "clean catalog shot",
                        "count": 3,
                    },
                    context=self._context("image_generate"),
                )

            self.assertEqual(len(calls), 3)
            self.assertEqual(result["image_count"], 3)
            self.assertEqual(result["nano_images"], 3)
            self.assertEqual(len(result["image_paths"]), 3)
            self.assertEqual(len(set(result["image_paths"])), 3)
            self.assertTrue(all(Path(path).is_file() for path in result["image_paths"]))
            self.assertEqual(result["image_path"], result["image_paths"][0])
            self.assertEqual(len(result["raw_result"]["generations"]), 3)

    def test_poster_translate_builds_default_prompt_when_form_has_no_prompt_field(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            poster = self._write_image(tmpdir, "poster.png")
            calls: list[dict] = []

            def fake_generate_image(**kwargs):
                calls.append(kwargs)
                Path(kwargs["output_image_path"]).write_bytes(b"translated")
                return {"image_path": kwargs["output_image_path"], "selected_model": "fake"}

            with patch("video_core.source_backend.image_model_api.generate_image", side_effect=fake_generate_image):
                result = ArchivedSourceBackend().image_generate(
                    task_id="task-poster-default",
                    payload={
                        "output_dir": str(Path(tmpdir) / "output"),
                        "video_image_mode": "poster_translate",
                        "poster_image_local_path": poster,
                        "source_language": "English",
                    },
                    context=self._context("image_generate"),
                )
            self.assertTrue(result["ok"])
            self.assertIn("电商海报文字语种切换任务", calls[0]["prompt"])
            self.assertIn("中文", calls[0]["prompt"])

    def test_image_generate_rejects_invalid_or_incompatible_parameters(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            first = self._write_image(tmpdir, "first.png")
            backend = ArchivedSourceBackend()
            context = self._context("image_generate")
            invalid_payloads = (
                ({"video_image_mode": "unknown", "prompt": "x"}, "video_image_mode"),
                ({"video_image_mode": "model_product", "prompt": "x", "product_image_local_path": first}, "2-4"),
                ({"video_image_mode": "product_only", "prompt": "x", "product_image_local_path": first, "count": 0}, "count"),
                ({"video_image_mode": "product_only", "prompt": "x", "product_image_url": "https://example.invalid/a.png"}, "local"),
            )
            for payload, marker in invalid_payloads:
                with self.subTest(payload=payload):
                    with self.assertRaisesRegex(ValueError, marker):
                        backend.image_generate(task_id="task-invalid", payload={"output_dir": tmpdir, **payload}, context=context)

    def test_original_multi_reference_slots_are_accepted(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = [self._write_image(tmpdir, f"reference-{index}.png") for index in range(1, 4)]
            calls: list[dict] = []

            def fake_generate_image(**kwargs):
                calls.append(kwargs)
                Path(kwargs["output_image_path"]).write_bytes(b"generated")
                return {"image_path": kwargs["output_image_path"], "selected_model": "fake"}

            with patch("video_core.source_backend.image_model_api.generate_image", side_effect=fake_generate_image):
                ArchivedSourceBackend().image_generate(
                    task_id="task-multi-reference",
                    payload={
                        "output_dir": str(Path(tmpdir) / "output"),
                        "video_image_mode": "three_view",
                        "product_image_local_paths": paths,
                        "prompt": "preserve all product angles",
                    },
                    context=self._context("image_generate"),
                )
            self.assertEqual(calls[0]["input_image_paths"], paths)

    def test_hidden_combined_replacement_runner_remains_internally_reachable(self):
        backend = ArchivedSourceBackend()
        context = self._context("replace_product_and_model")
        with patch(
            "video_core.source_backend.replacement_pipeline.run_replacement_pipeline",
            return_value={"ok": True, "task_type": "replace_product_and_model"},
        ) as combined:
            result = backend.run_task(
                "replace_productANDmodel",
                "task-combined",
                {"internal": True},
                context,
            )
        self.assertTrue(result["ok"])
        self.assertEqual(combined.call_args.args[1], "replace_product_and_model")
        self.assertEqual(combined.call_args.args[2], "task-combined")

    def test_ecommerce_storyboard_is_aggregated_into_one_paid_submission_and_preserved(self):
        backend = _FakeEcommerceBackend()
        storyboard = [
            {"id": "shot-1", "shot": "close-up", "dialogue": "Meet the product", "visual_prompt": "sunlit table"},
            {"id": "shot-2", "shot": "handheld demo", "dialogue": "Easy to use", "visual_prompt": "natural motion"},
        ]
        prompt_segments = ["opening hook", {"prompt": "final call to action"}]
        with tempfile.TemporaryDirectory() as tmpdir:
            result = backend.ecommerce_short_video(
                task_id="task-storyboard",
                payload={
                    "output_dir": tmpdir,
                    "product_image_local_path": str(Path(tmpdir) / "product.png"),
                    "reference_video_local_path": str(Path(tmpdir) / "reference.mp4"),
                    "audio_local_path": str(Path(tmpdir) / "reference.wav"),
                    "prompt": "base campaign",
                    "storyboard": storyboard,
                    "prompt_segments": prompt_segments,
                },
                context=self._context("ecommerce_short_video"),
            )

        self.assertTrue(result["ok"])
        self.assertEqual(len(backend.submissions), 1)
        aggregate = backend.submissions[0]["submit_payload"]["prompt"]
        for expected in ("base campaign", "sunlit table", "Meet the product", "opening hook", "final call to action"):
            self.assertIn(expected, aggregate)
        self.assertEqual(result["raw_result"]["storyboard"], storyboard)
        self.assertEqual(result["raw_result"]["prompt_segments"], prompt_segments)
        self.assertEqual(result["raw_result"]["segment_prompts"][0], aggregate)
        self.assertEqual(result["raw_result"]["segment_count"], 4)
        self.assertEqual(backend.submissions[0]["submit_payload"]["videoUrls"], ["https://media.invalid/ecommerce_reference_video"])
        self.assertEqual(backend.submissions[0]["submit_payload"]["audioUrls"], ["https://media.invalid/ecommerce_voice_audio"])

    def test_ecommerce_animation_redraw_is_applied_before_video_submission(self):
        backend = _FakeEcommerceBackend()
        with tempfile.TemporaryDirectory() as tmpdir:
            original = Path(tmpdir) / "product.png"
            original.write_bytes(b"original")
            redrawn = Path(tmpdir) / "redrawn.png"
            redrawn.write_bytes(b"redrawn")
            resolved_locals: list[tuple[str, ...]] = []

            def resolve_media(**kwargs):
                resolved_locals.append(tuple(str(value) for value in kwargs.get("local_values") or ()))
                return f"https://media.invalid/{kwargs['media_kind']}"

            with patch(
                "video_core.source_backend.ecommerce_animation_redraw.redraw_animation_references",
                return_value={
                    "ok": True,
                    "params": {
                        "output_dir": tmpdir,
                        "ecommerce_ad_style": "animation",
                        "ecommerce_animation_redraw_done": True,
                        "product_image_local_path": str(redrawn),
                        "prompt": "animated product campaign",
                    },
                    "image_paths": [str(redrawn)],
                },
            ) as redraw, patch.object(backend, "_resolve_media", side_effect=resolve_media):
                result = backend.ecommerce_short_video(
                    task_id="task-animation-redraw",
                    payload={
                        "output_dir": tmpdir,
                        "ecommerce_ad_style": "animation",
                        "product_image_local_path": str(original),
                        "prompt": "animated product campaign",
                    },
                    context=self._context("ecommerce_short_video"),
                )

            self.assertTrue(result["ok"])
            redraw.assert_called_once()
            self.assertIn((str(redrawn),), resolved_locals)
            self.assertEqual(len(backend.submissions), 1)

    def test_ecommerce_rejects_malformed_segment_parameters_before_submission(self):
        backend = _FakeEcommerceBackend()
        with tempfile.TemporaryDirectory() as tmpdir:
            with self.assertRaisesRegex(ValueError, "storyboard"):
                backend.ecommerce_short_video(
                    task_id="task-bad-storyboard",
                    payload={
                        "output_dir": tmpdir,
                        "product_image_local_path": str(Path(tmpdir) / "product.png"),
                        "prompt": "base campaign",
                        "storyboard": "silently ignored before",
                    },
                    context=self._context("ecommerce_short_video"),
                )
        self.assertEqual(backend.submissions, [])

    def test_submit_and_poll_resumes_existing_provider_task_without_posting_again(self):
        class NoPostSession:
            def __init__(self) -> None:
                self.post_calls = 0

            def post(self, *args, **kwargs):
                self.post_calls += 1
                raise AssertionError("resume must not submit a second provider task")

        session = NoPostSession()
        backend = ArchivedSourceBackend(http_session=session)
        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "resumed.mp4"
            with patch(
                "video_core.source_backend.runninghub_common.query_task",
                return_value={"status": "success", "progress": 100, "video_path": str(output_path)},
            ) as query_task:
                result = backend._submit_and_poll(
                    task_id="task-resume",
                    payload={
                        "video_runninghub_api_key": "test-key",
                        "resume_runninghub_task_id": "provider-existing-42",
                        "video_poll_interval_seconds": 0.01,
                    },
                    context=self._context("ecommerce_short_video"),
                    submit_url="https://provider.invalid/submit",
                    submit_payload={"prompt": "must not be posted"},
                    output_path=output_path,
                    label="resume test",
                )

        self.assertEqual(session.post_calls, 0)
        self.assertEqual(query_task.call_count, 1)
        self.assertEqual(query_task.call_args.kwargs["task_id"], "provider-existing-42")
        self.assertEqual(result["runninghub_task_id"], "provider-existing-42")
        self.assertEqual(result["provider_task_id"], "provider-existing-42")
        self.assertTrue(result["resumed"])

    def test_subtitle_cues_are_rendered_locally_without_provider_calls(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workdir = Path(tmpdir)
            source_video = workdir / "source.mp4"
            source_video.write_bytes(b"video")
            commands: list[list[str]] = []

            def fake_process(command, **_kwargs):
                commands.append(command)
                Path(command[-1]).write_bytes(b"subtitled-video")
                return 0, "", ""

            with patch("video_core.source_backend._run_local_process", side_effect=fake_process):
                result_path, cue_count = ArchivedSourceBackend()._burn_subtitles_if_requested(
                    video_path=source_video,
                    payload={
                        "ffmpeg_path": "ffmpeg",
                        "subtitles": {
                            "enabled": True,
                            "items": [
                                {"start_seconds": 0, "end_seconds": 1.25, "text": "第一句"},
                                {"start_seconds": 1.25, "end_seconds": 3, "text": "Second line"},
                            ],
                        },
                    },
                    context=self._context("create_video"),
                    workdir=workdir,
                )

            self.assertEqual(cue_count, 2)
            self.assertTrue(result_path.is_file())
            self.assertEqual(len(commands), 1)
            self.assertIn("subtitles=filename=", commands[0][commands[0].index("-vf") + 1])
            srt = (workdir / "source.srt").read_text(encoding="utf-8-sig")
            self.assertIn("00:00:00,000 --> 00:00:01,250", srt)
            self.assertIn("第一句", srt)

    def test_disabled_subtitles_do_not_invoke_ffmpeg(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            source_video = Path(tmpdir) / "source.mp4"
            source_video.write_bytes(b"video")
            with patch("video_core.source_backend._run_local_process") as process:
                result_path, cue_count = ArchivedSourceBackend()._burn_subtitles_if_requested(
                    video_path=source_video,
                    payload={"subtitles": {"enabled": False, "items": []}},
                    context=self._context("create_video"),
                    workdir=Path(tmpdir),
                )
            self.assertEqual(result_path, source_video)
            self.assertEqual(cue_count, 0)
            process.assert_not_called()

    def test_language_replace_preserves_background_with_local_ffmpeg_fallback(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workdir = Path(tmpdir)
            source_video = workdir / "source.mp4"
            target_audio = workdir / "speech.mp3"
            source_video.write_bytes(b"video")
            target_audio.write_bytes(b"audio")
            commands: list[list[str]] = []

            def fake_process(command, **_kwargs):
                commands.append(command)
                Path(command[-1]).write_bytes(b"result")
                return 0, "", ""

            with patch("video_core.source_backend._run_local_process", side_effect=fake_process):
                result = ArchivedSourceBackend().video_language_replace(
                    task_id="task-language-background",
                    payload={
                        "output_dir": str(workdir / "output"),
                        "video_local_path": str(source_video),
                        "target_audio_local_path": str(target_audio),
                        "duration_seconds": 5,
                        "ffmpeg_path": "ffmpeg",
                        "preserve_background_audio": True,
                        "target_language": "English",
                    },
                    context=self._context("video_language_replace"),
                )

            self.assertTrue(result["ok"])
            self.assertEqual(len(commands), 3)
            self.assertEqual(result["raw_result"]["background_audio_mode"], "ffmpeg_side_bed")
            self.assertEqual(result["raw_result"]["background_audio_mode"], "ffmpeg_side_bed")
            self.assertTrue(result["raw_result"]["background_audio_preserved"])
            self.assertTrue(Path(result["video_path"]).is_file())
            self.assertTrue(any(str(item).endswith("video_language_mix_audio.m4a") for item in commands[-1]))

    def test_language_replace_auto_transcribes_translates_and_uses_timed_tts(self):
        class FakeTtsBackend(ArchivedSourceBackend):
            def _generate_minimax_tts(self, *, speech_text, output_path, **_kwargs):
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(speech_text.encode("utf-8"))
                return output_path

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_video = root / "source.mp4"
            source_video.write_bytes(b"video")
            callback_calls: list[dict] = []

            def transcribe_translate(**kwargs):
                callback_calls.append(kwargs)
                return {
                    "target_script": "Hello world",
                    "segments": [{"start_seconds": 0, "end_seconds": 2, "text": "Hello world"}],
                    "source_segments": [{"start_seconds": 0, "end_seconds": 2, "text": "Hola mundo"}],
                    "source_script": "Hola mundo",
                    "source_language": "Spanish",
                    "meta": {"provider": "mock"},
                }

            def fake_process(command, **_kwargs):
                Path(command[-1]).write_bytes(b"result")
                return 0, "", ""

            with patch("video_core.source_backend._run_local_process", side_effect=fake_process):
                result = FakeTtsBackend().video_language_replace(
                    task_id="task-auto-language",
                    payload={
                        "output_dir": str(root / "output"),
                        "video_local_path": str(source_video),
                        "duration_seconds": 2,
                        "ffmpeg_path": "ffmpeg",
                        "target_language": "English",
                        "_video_language_transcribe_translate": transcribe_translate,
                    },
                    context=self._context("video_language_replace"),
                )

            self.assertEqual(len(callback_calls), 1)
            self.assertEqual(callback_calls[0]["source_duration"], 2)
            self.assertEqual(callback_calls[0]["source_language"], "Auto")
            self.assertEqual(result["raw_result"]["transcribe_translate_mode"], "callback")
            self.assertEqual(result["raw_result"]["source_language"], "Spanish")
            self.assertEqual(result["raw_result"]["transcribe_translate_meta"], {"provider": "mock"})
            self.assertEqual(len(result["raw_result"]["timed_audio_segments"]), 1)

    def test_language_timed_tts_regenerates_only_requested_segment_when_audio_is_reusable(self):
        class FakeTtsBackend(ArchivedSourceBackend):
            def __init__(self):
                super().__init__()
                self.generated_texts: list[str] = []

            def _generate_minimax_tts(self, *, speech_text, output_path, **_kwargs):
                self.generated_texts.append(speech_text)
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(speech_text.encode("utf-8"))
                return output_path

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            reused = root / "segment-1.mp3"
            reused.write_bytes(b"existing")
            backend = FakeTtsBackend()

            def fake_process(command, **_kwargs):
                Path(command[-1]).write_bytes(b"mixed")
                return 0, "", ""

            with patch("video_core.source_backend._run_local_process", side_effect=fake_process):
                _audio, generated, _duration = backend._generate_timed_tts_audio(
                    segments=[
                        {"start_seconds": 0, "end_seconds": 1, "text": "Hello"},
                        {"start_seconds": 1, "end_seconds": 2, "text": "World"},
                    ],
                    source_duration=2,
                    payload={
                        "ffmpeg_path": "ffmpeg",
                        "regenerate_segment_index": 2,
                        "_video_language_reuse_segments": [
                            {"index": 1, "audio_path": str(reused)},
                        ],
                    },
                    context=self._context("video_language_replace"),
                    workdir=root / "work",
                )

            self.assertEqual(backend.generated_texts, ["World"])
            self.assertTrue(generated[0]["reused"])
            self.assertFalse(generated[1]["reused"])
            self.assertEqual(Path(generated[0]["audio_path"]), reused.resolve())

    def test_language_replace_uses_injected_background_separator(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_video = root / "source.mp4"
            target_audio = root / "speech.mp3"
            background = root / "background.wav"
            for path, content in ((source_video, b"video"), (target_audio, b"speech"), (background, b"background")):
                path.write_bytes(content)
            registered: list[str] = []
            commands: list[list[str]] = []

            def fake_process(command, **_kwargs):
                commands.append(command)
                Path(command[-1]).write_bytes(b"result")
                return 0, "", ""

            with patch("video_core.source_backend._run_local_process", side_effect=fake_process):
                result = ArchivedSourceBackend().video_language_replace(
                    task_id="task-injected-background",
                    payload={
                        "output_dir": str(root / "output"),
                        "video_local_path": str(source_video),
                        "target_audio_local_path": str(target_audio),
                        "duration_seconds": 3,
                        "ffmpeg_path": "ffmpeg",
                        "preserve_background_audio": True,
                        "_video_language_background_separator": lambda **_kwargs: {
                            "background_path": str(background),
                            "runninghub_task_id": "rh-injected-1",
                            "usage": {"credits": 2},
                        },
                        "_register_runninghub_task": lambda runninghub_task_id, **_kwargs: registered.append(runninghub_task_id),
                    },
                    context=self._context("video_language_replace"),
                )

            self.assertEqual(len(commands), 2)
            self.assertEqual(result["runninghub_task_id"], "rh-injected-1")
            self.assertEqual(result["runninghub_usage"], {"credits": 2})
            self.assertEqual(result["raw_result"]["background_audio_mode"], "injected_separator")
            self.assertEqual(registered, ["rh-injected-1"])

    def test_language_replace_runs_default_runninghub_background_separator(self):
        class FakeResponse:
            def __init__(self, body=None, content=b""):
                self._body = body
                self.content = content

            def raise_for_status(self):
                return None

            def json(self):
                return self._body

            def iter_content(self, chunk_size=8192):
                yield self.content

        class FakeSession:
            def __init__(self):
                self.posts: list[tuple[str, dict]] = []
                self.downloaded = ""

            def post(self, url, **kwargs):
                self.posts.append((url, kwargs))
                if url.endswith("/media/upload/binary"):
                    return FakeResponse({"code": 0, "data": {"fileName": "uploaded-source.wav"}})
                if "/run/ai-app/2054844989808619521" in url:
                    return FakeResponse({"code": 0, "taskId": "rh-default-1"})
                if url.endswith("/openapi/v2/query"):
                    return FakeResponse({
                        "code": 0,
                        "status": "SUCCESS",
                        "usage": {"credits": 3},
                        "results": [
                            {"nodeId": "4", "outputType": "wav", "url": "https://media.invalid/vocals.wav"},
                            {"nodeId": "5", "outputType": "wav", "url": "https://media.invalid/background.wav", "fileName": "background"},
                        ],
                    })
                raise AssertionError(url)

            def get(self, url, **_kwargs):
                self.downloaded = url
                return FakeResponse(content=b"background")

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_video = root / "source.mp4"
            target_audio = root / "speech.mp3"
            source_video.write_bytes(b"video")
            target_audio.write_bytes(b"speech")
            session = FakeSession()

            def fake_process(command, **_kwargs):
                Path(command[-1]).write_bytes(b"result")
                return 0, "", ""

            with patch("video_core.source_backend._run_local_process", side_effect=fake_process):
                result = ArchivedSourceBackend(http_session=session).video_language_replace(
                    task_id="task-runninghub-background",
                    payload={
                        "output_dir": str(root / "output"),
                        "video_local_path": str(source_video),
                        "target_audio_local_path": str(target_audio),
                        "duration_seconds": 3,
                        "ffmpeg_path": "ffmpeg",
                        "preserve_background_audio": True,
                        "video_runninghub_api_key": "test-key",
                    },
                    context=self._context("video_language_replace"),
                )

            submit = next(kwargs for url, kwargs in session.posts if "/run/ai-app/" in url)
            self.assertEqual(json.loads(submit["data"])["nodeInfoList"][0]["nodeId"], "3")
            self.assertEqual(session.downloaded, "https://media.invalid/background.wav")
            self.assertEqual(result["runninghub_task_id"], "rh-default-1")
            self.assertEqual(result["raw_result"]["background_audio_mode"], "runninghub_separator")

    def test_language_replace_separator_failure_falls_back_to_local_ffmpeg(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_video = root / "source.mp4"
            target_audio = root / "speech.mp3"
            source_video.write_bytes(b"video")
            target_audio.write_bytes(b"speech")
            commands: list[list[str]] = []

            def fake_process(command, **_kwargs):
                commands.append(command)
                Path(command[-1]).write_bytes(b"result")
                return 0, "", ""

            with patch("video_core.source_backend._run_local_process", side_effect=fake_process):
                result = ArchivedSourceBackend().video_language_replace(
                    task_id="task-background-fallback",
                    payload={
                        "output_dir": str(root / "output"),
                        "video_local_path": str(source_video),
                        "target_audio_local_path": str(target_audio),
                        "duration_seconds": 3,
                        "ffmpeg_path": "ffmpeg",
                        "preserve_background_audio": True,
                        "_video_language_background_separator": lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("separator unavailable")),
                    },
                    context=self._context("video_language_replace"),
                )

            self.assertEqual(len(commands), 3)
            self.assertEqual(result["raw_result"]["background_audio_mode"], "ffmpeg_side_bed_fallback")
            self.assertIn("separator unavailable", result["raw_result"]["background_audio_provider_error"])
            self.assertTrue(result["raw_result"]["background_audio_preserved"])

    def test_language_replace_composes_timed_tts_segments_and_does_not_shorten_video(self):
        class FakeTtsBackend(ArchivedSourceBackend):
            def _generate_minimax_tts(self, *, speech_text, output_path, **_kwargs):
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(speech_text.encode("utf-8"))
                return output_path

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_video = root / "source.mp4"
            source_video.write_bytes(b"video")
            commands: list[list[str]] = []

            def fake_process(command, **_kwargs):
                commands.append(command)
                Path(command[-1]).write_bytes(b"result")
                return 0, "", ""

            with patch("video_core.source_backend._run_local_process", side_effect=fake_process):
                result = FakeTtsBackend().video_language_replace(
                    task_id="task-language-timed",
                    payload={
                        "output_dir": str(root / "output"),
                        "video_local_path": str(source_video),
                        "duration_seconds": 6,
                        "ffmpeg_path": "ffmpeg",
                        "target_language": "English",
                        "target_script": "First\nSecond",
                        "script_segments": [
                            {"start_seconds": 0.5, "end_seconds": 2, "text": "First"},
                            {"start_seconds": 3, "end_seconds": 5, "text": "Second"},
                        ],
                    },
                    context=self._context("video_language_replace"),
                )

            self.assertTrue(result["ok"])
            self.assertEqual(len(result["raw_result"]["timed_audio_segments"]), 2)
            self.assertEqual(result["raw_result"]["aligned_total_duration_seconds"], 6)
            self.assertEqual(len(commands), 5)
            self.assertEqual(result["raw_result"]["background_audio_mode"], "ffmpeg_side_bed")
            self.assertIn("adelay=500:all=1", commands[0][commands[0].index("-filter_complex") + 1])
            mux_command = next(command for command in commands if str(command[-1]).endswith("video_language_replaced.mp4"))
            self.assertNotIn("-shortest", mux_command)
            self.assertIn("6.000", mux_command)
            self.assertTrue(result["subtitles_applied"])

    def test_language_replace_inserts_opening_and_ending_into_timed_tts_plan(self):
        class FakeTtsBackend(ArchivedSourceBackend):
            def _generate_minimax_tts(self, *, speech_text, output_path, **_kwargs):
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(speech_text.encode("utf-8"))
                return output_path

            @staticmethod
            def _probe_media_duration_seconds(path, payload):
                if "opening" in path.name:
                    return 1.5
                if "ending" in path.name:
                    return 2.0
                return 1.0

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_video = root / "source.mp4"
            source_video.write_bytes(b"video")

            def fake_process(command, **_kwargs):
                Path(command[-1]).write_bytes(b"result")
                return 0, "", ""

            with patch("video_core.source_backend._run_local_process", side_effect=fake_process):
                result = FakeTtsBackend().video_language_replace(
                    task_id="task-language-inserts",
                    payload={
                        "output_dir": str(root / "output"),
                        "video_local_path": str(source_video),
                        "duration_seconds": 5,
                        "ffmpeg_path": "ffmpeg",
                        "target_script": "Main line",
                        "opening_insert_text": "Opening line",
                        "ending_insert_text": "Ending line",
                        "script_segments": [{"start_seconds": 0.5, "end_seconds": 4, "text": "Main line"}],
                    },
                    context=self._context("video_language_replace"),
                )

            rows = result["raw_result"]["timed_audio_segments"]
            self.assertEqual([item["role"] for item in rows], ["opening", "source", "ending"])
            self.assertEqual(rows[0]["start_seconds"], 0)
            self.assertEqual(rows[1]["start_seconds"], 1.5)
            self.assertEqual(rows[2]["start_seconds"], 5.0)
            self.assertEqual(result["raw_result"]["aligned_total_duration_seconds"], 7.0)
            self.assertEqual(result["raw_result"]["opening_insert_text"], "Opening line")
            self.assertEqual(result["raw_result"]["ending_insert_text"], "Ending line")

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg/ffprobe are required")
    def test_language_replace_local_ffmpeg_smoke_with_background_and_subtitles(self):
        ffmpeg = str(shutil.which("ffmpeg"))
        ffprobe = str(shutil.which("ffprobe"))
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_video = root / "source.mp4"
            target_audio = root / "target.wav"
            subprocess.run(
                [
                    ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source_video),
                ],
                check=True,
                timeout=60,
            )
            subprocess.run(
                [
                    ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "sine=frequency=880:duration=1.5",
                    "-c:a", "pcm_s16le", str(target_audio),
                ],
                check=True,
                timeout=60,
            )

            result = ArchivedSourceBackend().video_language_replace(
                task_id="task-local-ffmpeg",
                payload={
                    "output_dir": str(root / "output"),
                    "video_local_path": str(source_video),
                    "target_audio_local_path": str(target_audio),
                    "duration_seconds": 2,
                    "ffmpeg_path": ffmpeg,
                    "ffprobe_path": ffprobe,
                    "preserve_background_audio": True,
                    "target_language": "English",
                    "subtitles": {
                        "enabled": True,
                        "items": [{"start_seconds": 0.1, "end_seconds": 1.6, "text": "Local subtitle smoke"}],
                    },
                },
                context=self._context("video_language_replace"),
            )

            self.assertTrue(result["ok"])
            self.assertTrue(result["raw_result"]["background_audio_preserved"])
            self.assertTrue(result["subtitles_applied"], result.get("subtitle_warning"))
            final_path = Path(result["video_path"])
            self.assertTrue(final_path.is_file())
            duration = float(subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(final_path)],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            ).stdout.strip())
            self.assertGreaterEqual(duration, 1.9)


if __name__ == "__main__":
    unittest.main()
