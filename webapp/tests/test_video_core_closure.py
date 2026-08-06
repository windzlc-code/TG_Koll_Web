from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from video_core.contracts import VideoTaskContext
from video_core.source_backend import ArchivedSourceBackend
from webapp import video_workbench


def _context() -> VideoTaskContext:
    return VideoTaskContext(task_id="task-closure", task_type="create_video")


def test_all_eight_workbench_modules_resolve_to_registered_core_runners() -> None:
    expected = {
        "digital_human_video": "create_video",
        "ecommerce_short_video": "ecommerce_short_video",
        "video_language_replace": "video_language_replace",
        "video_subject_replace": "replace_model",
        "ecommerce_image": "image_generate",
        "subject_replace": "image_generate",
        "poster_translate": "image_generate",
        "subject_generate": "image_generate",
    }
    assert {item["id"]: item["task_type"] for item in video_workbench.VIDEO_UI_MODULE_METADATA} == expected
    for task_type in {"create_video", "ecommerce_short_video", "video_language_replace", "replace_model", "replace_product", "image_generate"}:
        assert callable(video_workbench.VIDEO_TASK_RUNNERS[task_type])


@pytest.mark.parametrize(
    ("task_type", "payload", "sku"),
    [
        ("create_video", {"duration_seconds": 12}, "oral_video_second"),
        ("ecommerce_short_video", {"duration": 8, "resolution": "1080p"}, "seedance_1080p_second"),
        ("video_language_replace", {"duration_seconds": 9}, "video_language_replace_second"),
        ("replace_model", {"duration_seconds": 7}, "video_model_replace_second"),
        ("replace_product", {"duration_seconds": 6}, "video_product_replace_second"),
        ("image_generate", {"video_image_mode": "product_only", "count": 2}, "ecommerce_image"),
        ("image_generate", {"video_image_mode": "subject_replace"}, "subject_replace_image"),
        ("image_generate", {"video_image_mode": "poster_translate"}, "poster_translate_image"),
        ("image_generate", {"video_image_mode": "three_view"}, "subject_generate_image"),
    ],
)
def test_every_video_capability_has_a_billing_sku(task_type: str, payload: dict, sku: str) -> None:
    spec = video_workbench.video_task_billing_spec(task_type, payload)
    assert spec is not None
    assert spec[0] == sku
    assert spec[1] >= 1


def test_digital_human_long_audio_is_split_with_cancel_aware_local_process(tmp_path: Path) -> None:
    audio = tmp_path / "speech.mp3"
    audio.write_bytes(b"audio")
    commands: list[list[str]] = []

    def fake_process(command, **_kwargs):
        commands.append(command)
        Path(command[-1]).write_bytes(b"part")
        return 0, "", ""

    with patch("video_core.source_backend._run_local_process", side_effect=fake_process):
        parts = ArchivedSourceBackend()._split_digital_human_audio(
            audio_path=audio,
            duration_seconds=32,
            segment_index=1,
            payload={"ffmpeg_path": "ffmpeg", "output_dir": str(tmp_path)},
            context=_context(),
            workdir=tmp_path,
        )

    assert [duration for _path, duration in parts] == [15.0, 15.0, 2.0]
    assert len(commands) == 3
    assert all(path.is_file() for path, _duration in parts)


def test_digital_human_continuation_reuses_fusion_views_and_segment_plan() -> None:
    result = video_workbench._video_continuation_fields(
        "create_video",
        {
            "video_checkpoint": {
                "fusion_images": ["C:/task/fusion-1.png"],
                "segment_scripts": ["one", "two"],
                "view_sequence": [1, 2],
            }
        },
    )
    assert result == {
        "digital_human_fusion_image_paths": ["C:/task/fusion-1.png"],
        "segment_scripts": ["one", "two"],
        "view_sequence": [1, 2],
    }


def test_digital_human_visual_review_stops_before_video_segments(tmp_path: Path) -> None:
    class ReviewBackend(ArchivedSourceBackend):
        def image_generate(self, *, payload, **_kwargs):
            output = Path(payload["output_dir"]) / "fusion.png"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"image")
            return {"ok": True, "image_path": str(output), "image_paths": [str(output)]}

        def generate_digital_human_segment(self, **_kwargs):
            raise AssertionError("visual review must stop before video segment generation")

    model = tmp_path / "model.png"
    product = tmp_path / "product.png"
    model.write_bytes(b"model")
    product.write_bytes(b"product")
    result = ReviewBackend().create_video(
        task_id="task-review",
        payload={
            "output_dir": str(tmp_path),
            "model_image_local_path": str(model),
            "product_image_local_path": str(product),
            "speech_text": "review copy",
            "digital_human_operation": "visual_review",
            "digital_human_fusion_count": 1,
        },
        context=VideoTaskContext(task_id="task-review", task_type="create_video"),
    )

    assert result["ok"] is True
    assert result["raw_result"]["digital_human_stage"] == "visual_review"
    assert result["fusion_images"]
    assert result["video_path"] == ""
    assert video_workbench.video_billing_actual_quantity("create_video", result, {}) == 0


def test_seeding_image_confirmation_stage_does_not_settle_video_seconds() -> None:
    output = {
        "ok": True,
        "raw_result": {"seeding_stage": "images_only", "duration": 30},
        "image_paths": ["scene-1.png"],
    }
    assert video_workbench.video_billing_actual_quantity("ecommerce_short_video", output, {"duration": 30}) == 0


def test_voice_preset_submission_keeps_original_minimax_fallback_contract() -> None:
    script = (Path(__file__).parents[1] / "static" / "assets" / "video-workbench.js").read_text(encoding="utf-8")
    assert 'values.elevenlabs_tts_preset_key = draft.values.elevenlabs_tts_preset_key || ""' in script
    assert 'values.speaker = draft.values.voice_name || draft.values.speaker || ""' in script
    assert 'values.minimax_tts_voice_id = ""' in script
    assert "values.voice_id = draft.values.voice_id" not in script


def test_create_video_requires_both_presenter_and_product_like_original_ui() -> None:
    with pytest.raises(ValueError, match="产品图片"):
        video_workbench.build_video_submit_payload(
            "create_video",
            {"speech_text": "hello", "file_roles": ["model"]},
            [{"name": "presenter.png", "path": "C:/uploads/presenter.png", "kind": "image"}],
        )


def test_create_video_ai_copy_flag_uses_boolean_semantics() -> None:
    files = [
        {"name": "presenter.png", "path": "C:/uploads/presenter.png", "kind": "image"},
        {"name": "product.png", "path": "C:/uploads/product.png", "kind": "image"},
    ]
    payload = video_workbench.build_video_submit_payload(
        "create_video",
        {"use_ai_copy": True, "file_roles": ["model", "product"]},
        files,
    )
    assert payload["use_ai_copy"] is True

    with pytest.raises(ValueError, match="create_video"):
        video_workbench.build_video_submit_payload(
            "create_video",
            {"use_ai_copy": "false", "file_roles": ["model", "product"]},
            files,
        )


def test_every_video_runner_marks_task_recoverable_before_provider_work() -> None:
    checkpoints: list[dict] = []

    class Backend:
        @staticmethod
        def run_task(task_type, task_id, payload, context):
            return {"ok": True, "task_type": task_type, "task_id": task_id}

    runners = video_workbench.make_video_task_runners(
        Backend(),
        payload_enricher=lambda _type, _id, payload: {
            **payload,
            "_checkpoint_video_progress": lambda **values: checkpoints.append(values),
        },
    )
    result = runners["video_language_replace"]("task-start", {})
    assert result["ok"]
    assert checkpoints == [{
        "task_id": "task-start",
        "stage": "video_task_started",
        "message": "video_language_replace started",
    }]


def test_video_billing_reservation_probes_uploaded_media_and_uses_safe_defaults(tmp_path, monkeypatch) -> None:
    media = tmp_path / "source.mp4"
    media.write_bytes(b"media")
    monkeypatch.setattr(
        video_workbench.DEFAULT_SOURCE_BACKEND,
        "_probe_duration",
        lambda path, payload: 12.2,
    )

    assert video_workbench.video_task_billing_spec(
        "create_video", {"audio_local_path": str(media)}
    ) == ("oral_video_second", 13, False)
    assert video_workbench.video_task_billing_spec(
        "video_language_replace", {"video_local_path": str(media)}
    ) == ("video_language_replace_second", 13, False)
    assert video_workbench.video_task_billing_spec(
        "replace_model", {"video_local_path": str(media)}
    ) == ("video_model_replace_second", 13, False)

    assert video_workbench.video_task_billing_spec("create_video", {}) == ("oral_video_second", 10, False)
    assert video_workbench.video_task_billing_spec(
        "create_video", {"oral_target_duration_seconds": 30}
    ) == ("oral_video_second", 30, False)
    assert video_workbench.video_task_billing_spec("video_language_replace", {}) == (
        "video_language_replace_second", 10, False
    )
    assert video_workbench.video_task_billing_spec("replace_product", {}) == (
        "video_product_replace_second", 20, False
    )
