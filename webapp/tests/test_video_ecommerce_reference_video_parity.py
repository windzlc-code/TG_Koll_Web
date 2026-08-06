from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from PIL import Image

from video_core import ecommerce_reference_video as reference_video
from video_core import source_backend
from video_core.contracts import VideoTaskContext
from video_core.source_backend import ArchivedSourceBackend


class _NoPaidBackend(ArchivedSourceBackend):
    def _submit_and_poll(self, **_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("reference-video analysis must not submit a paid video workflow")

    def image_generate(self, **_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("reference-video analysis must not invoke paid image generation")


def _context(task_id: str = "reference-video-parity") -> VideoTaskContext:
    return VideoTaskContext(task_id=task_id, task_type="ecommerce_short_video")


def _images_only_result(segments: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "images_only": True,
        "template": "template_b",
        "layout_variant": "reference-video-test",
        "segments": segments,
        "image_paths": [],
        "completed_segments": [],
        "ratio": "9:16",
        "resolution": "720x1280",
        "download_path": "",
        "image_path": "",
    }


def test_ffprobe_metadata_preserves_original_reference_video_contract(
    tmp_path: Path, monkeypatch: Any
) -> None:
    video = tmp_path / "reference.mp4"
    video.write_bytes(b"video")
    calls: list[tuple[list[str], dict[str, Any]]] = []

    def fake_run(command: list[str], **kwargs: Any) -> SimpleNamespace:
        calls.append((list(command), dict(kwargs)))
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                {
                    "streams": [{"width": "1080", "height": 1920, "r_frame_rate": "30000/1001"}],
                    "format": {"duration": "12.3456"},
                }
            ),
            stderr="",
        )

    monkeypatch.setattr(reference_video.subprocess, "run", fake_run)

    metadata = reference_video._probe_video(video, ffprobe_path="mock-ffprobe")

    assert metadata == {
        "duration_seconds": 12.3456,
        "width": 1080,
        "height": 1920,
        "frame_rate": "30000/1001",
    }
    command, kwargs = calls[0]
    assert command == [
        "mock-ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate:format=duration",
        "-of",
        "json",
        str(video),
    ]
    assert kwargs == {"capture_output": True, "text": True, "timeout": 30, "check": False}


def test_reference_frame_extraction_is_evenly_spaced_capped_and_best_effort(
    tmp_path: Path,
) -> None:
    video = tmp_path / "reference.mp4"
    video.write_bytes(b"video")
    commands: list[list[str]] = []

    def fake_ffmpeg(command: list[str], **kwargs: Any) -> SimpleNamespace:
        assert kwargs == {"capture_output": True, "text": True, "timeout": 60, "check": False}
        commands.append(list(command))
        output = Path(command[-1])
        if len(commands) != 3:
            output.write_bytes(f"frame-{len(commands)}".encode())
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        return SimpleNamespace(returncode=1, stdout="", stderr="decode failure")

    frames = reference_video.extract_reference_frames(
        video,
        tmp_path / "frames",
        duration_seconds=12,
        ffmpeg_path="mock-ffmpeg",
        max_frames=99,
        context=_context(),
        run_process=fake_ffmpeg,
    )

    assert len(commands) == 6
    assert [command[command.index("-ss") + 1] for command in commands] == [
        "0.000",
        "2.000",
        "4.000",
        "6.000",
        "8.000",
        "10.000",
    ]
    assert all(command[0] == "mock-ffmpeg" for command in commands)
    assert [path.name for path in frames] == [
        "frame_1.jpg",
        "frame_2.jpg",
        "frame_4.jpg",
        "frame_5.jpg",
        "frame_6.jpg",
    ]


def test_pace_and_style_summary_preserve_reference_video_analysis_fields(tmp_path: Path) -> None:
    pace_frames: list[Path] = []
    for index, luma in enumerate((80, 120, 80), start=1):
        path = tmp_path / f"pace-{index}.png"
        Image.new("L", (160, 160), color=luma).save(path)
        pace_frames.append(path)

    fast = reference_video.summarize_reference_frames(
        pace_frames,
        width=720,
        height=1280,
        duration_seconds=9.8765,
    )

    assert fast["schema_version"] == "local_seeding_reference_video_audit/v1"
    assert fast["duration_seconds"] == 9.877
    assert (fast["width"], fast["height"], fast["orientation"]) == (720, 1280, "vertical")
    assert fast["pace_hint"] == "fast_cut"
    assert fast["average_frame_delta"] == 40.0
    assert fast["detail_hint"] == "scene_anchor"
    assert fast["style_tags"][:3] == ["vertical_story", "fast_cut", "scene_anchor"]
    assert fast["subtitle_probe"] == {"has_subtitle": False, "scores": [0.0, 0.0, 0.0]}
    assert fast["frame_paths"] == [str(path.resolve()) for path in pace_frames]
    assert len(fast["frame_stats"]) == 3
    assert isinstance(fast["style_summary"], str) and fast["style_summary"]

    checker = Image.new("L", (160, 160))
    checker.putdata([255 if (x + y) % 2 else 0 for y in range(160) for x in range(160)])
    detail_frames = [tmp_path / "detail-1.png", tmp_path / "detail-2.png"]
    for path in detail_frames:
        checker.save(path)

    detailed = reference_video.summarize_reference_frames(
        detail_frames,
        width=1920,
        height=1080,
        duration_seconds=4,
    )

    assert detailed["orientation"] == "horizontal"
    assert detailed["pace_hint"] == "steady_lifestyle"
    assert detailed["detail_hint"] == "macro_detail"
    assert detailed["subtitle_probe"]["has_subtitle"] is True
    assert detailed["style_tags"][:3] == ["horizontal", "steady_lifestyle", "macro_detail"]
    assert "subtitle_present" in detailed["style_tags"]


def test_source_backend_injects_reference_audit_without_paid_provider_calls(
    tmp_path: Path, monkeypatch: Any
) -> None:
    product = tmp_path / "product.png"
    reference = tmp_path / "reference.mp4"
    product.write_bytes(b"product")
    reference.write_bytes(b"video")
    audit = {
        "schema_version": "local_seeding_reference_video_audit/v1",
        "video_path": str(reference.resolve()),
        "duration_seconds": 8.0,
        "width": 1080,
        "height": 1920,
        "orientation": "vertical",
        "pace_hint": "fast_cut",
        "detail_hint": "macro_detail",
        "average_luma": 128.0,
        "average_frame_delta": 31.0,
        "style_tags": ["vertical_story", "fast_cut", "macro_detail"],
        "style_summary": "vertical fast-cut product detail reference",
        "frame_paths": [str(tmp_path / "frame_1.jpg")],
        "frame_stats": [{"mean_luma": 128.0, "stddev_luma": 50.0}],
        "subtitle_probe": {"has_subtitle": False, "scores": [0.2]},
        "contact_sheet_path": "",
    }
    audit_calls: list[dict[str, Any]] = []
    renderer_calls: list[dict[str, Any]] = []

    def fake_audit(video_path: str, **kwargs: Any) -> dict[str, Any]:
        audit_calls.append({"video_path": video_path, **kwargs})
        return audit

    def fake_renderer(**kwargs: Any) -> dict[str, Any]:
        renderer_calls.append(kwargs)
        return _images_only_result(kwargs["segments"])

    monkeypatch.setattr(source_backend.ecommerce_reference_video, "audit_ecommerce_reference_video", fake_audit)
    monkeypatch.setattr(source_backend.ecommerce_seeding_renderer, "render_ecommerce_seeding", fake_renderer)

    payload = {
        "output_dir": str(tmp_path / "output"),
        "product_image_local_path": str(product),
        "reference_video_local_path": str(reference),
        "ffmpeg_path": "mock-ffmpeg",
        "ffprobe_path": "mock-ffprobe",
        "ecommerce_seeding_operation": "images_only",
        "storyboard": [{"duration": 4, "visual_prompt": "show the product"}],
        "prompt": "natural product recommendation",
    }
    context = _context("reference-success")
    result = _NoPaidBackend()._run_local_ecommerce_seeding(
        task_id="reference-success",
        payload=payload,
        context=context,
    )

    assert result["ok"] is True
    assert len(audit_calls) == 1
    assert audit_calls[0]["video_path"] == str(reference)
    assert audit_calls[0]["ffmpeg_path"] == "mock-ffmpeg"
    assert audit_calls[0]["ffprobe_path"] == "mock-ffprobe"
    assert audit_calls[0]["context"] is context
    assert audit_calls[0]["workdir"] == (tmp_path / "output" / "reference_video_audit").resolve()
    assert payload["ecommerce_reference_video_audit"] is audit
    integrated = renderer_calls[0]["payload"]["ecommerce_reference_video_audit"]
    assert integrated is audit
    assert {
        "schema_version",
        "video_path",
        "duration_seconds",
        "width",
        "height",
        "orientation",
        "pace_hint",
        "detail_hint",
        "average_luma",
        "average_frame_delta",
        "style_tags",
        "style_summary",
        "frame_paths",
        "frame_stats",
        "subtitle_probe",
        "contact_sheet_path",
    } <= integrated.keys()


def test_source_backend_degrades_reference_analysis_errors_to_audit_fields(
    tmp_path: Path, monkeypatch: Any
) -> None:
    product = tmp_path / "product.png"
    reference = tmp_path / "reference.mp4"
    product.write_bytes(b"product")
    reference.write_bytes(b"video")
    renderer_calls: list[dict[str, Any]] = []

    def fail_audit(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("ffprobe decode failed")

    def fake_renderer(**kwargs: Any) -> dict[str, Any]:
        renderer_calls.append(kwargs)
        return _images_only_result(kwargs["segments"])

    monkeypatch.setattr(source_backend.ecommerce_reference_video, "audit_ecommerce_reference_video", fail_audit)
    monkeypatch.setattr(source_backend.ecommerce_seeding_renderer, "render_ecommerce_seeding", fake_renderer)

    payload = {
        "output_dir": str(tmp_path / "output"),
        "product_image_local_path": str(product),
        "reference_video_local_path": str(reference),
        "ecommerce_seeding_operation": "images_only",
        "storyboard": [{"duration": 4, "visual_prompt": "show the product"}],
    }
    result = _NoPaidBackend()._run_local_ecommerce_seeding(
        task_id="reference-fallback",
        payload=payload,
        context=_context("reference-fallback"),
    )

    assert result["ok"] is True
    assert payload["ecommerce_reference_video_audit"] == {
        "video_path": str(reference),
        "error": "ffprobe decode failed",
        "style_tags": [],
    }
    assert renderer_calls[0]["payload"]["ecommerce_reference_video_audit"] == payload[
        "ecommerce_reference_video_audit"
    ]
