from __future__ import annotations

import hashlib
from pathlib import Path
from threading import Event
from typing import Any

import pytest
from PIL import Image, ImageDraw

from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core.ecommerce_seeding_dynamic import (
    EcommerceSeedingCallbacks,
    draw_storyboard_frame,
    render_ecommerce_seeding_dynamic,
    render_local_ecommerce_storyboard_video,
)


class MockDynamicSuppliers:
    def __init__(self) -> None:
        self.image_calls: list[dict[str, Any]] = []
        self.qa_calls: list[dict[str, Any]] = []
        self.tts_calls: list[dict[str, Any]] = []
        self.encode_calls: list[dict[str, Any]] = []
        self.concat_calls: list[dict[str, Any]] = []
        self.mux_calls: list[dict[str, Any]] = []
        self.checkpoints: list[dict[str, Any]] = []
        self.durations: dict[str, float] = {}
        self.reject_first_scene_once = True

    def generate_image(self, **kwargs: Any) -> dict[str, Any]:
        self.image_calls.append(dict(kwargs))
        output = Path(kwargs["output_path"])
        output.parent.mkdir(parents=True, exist_ok=True)
        segment_index = int(kwargs["segment_index"])
        shot_index = int(kwargs["shot_index"])
        attempt = int(kwargs["attempt"])
        image = Image.new("RGB", (180, 240), (28 * segment_index, 44 * shot_index, 52 * attempt))
        draw = ImageDraw.Draw(image)
        draw.rectangle((18, 24, 160, 220), fill=(50 + 18 * shot_index, 80 + 12 * segment_index, 120 + 20 * attempt))
        draw.ellipse((45, 65, 130, 150), fill=(210, 140 + 10 * segment_index, 65 + 10 * shot_index))
        image.save(output)
        return {"image_path": str(output), "provider_task_id": f"image-{len(self.image_calls)}"}

    def inspect_image(self, **kwargs: Any) -> dict[str, Any]:
        self.qa_calls.append(dict(kwargs))
        if (
            self.reject_first_scene_once
            and int(kwargs["segment_index"]) == 1
            and int(kwargs["shot_index"]) == 1
            and int(kwargs["attempt"]) == 1
        ):
            return {
                "status": "rejected",
                "issues": [
                    {
                        "code": "generated_text_overlay",
                        "severity": "high",
                        "message": "readable package text",
                    }
                ],
            }
        return {"status": "passed", "issues": [], "metrics": {"mock": True}}

    def synthesize_tts(self, **kwargs: Any) -> dict[str, Any]:
        self.tts_calls.append(dict(kwargs))
        output = Path(kwargs["output_path"])
        output.write_bytes(f"tts-{kwargs['segment_index']}".encode())
        duration = 3.0 if int(kwargs["segment_index"]) == 1 else 2.0
        self.durations[str(output.resolve())] = duration
        return {"audio_path": str(output)}

    def probe_duration(self, **kwargs: Any) -> float:
        path = Path(kwargs["path"]).resolve()
        if str(path) in self.durations:
            return self.durations[str(path)]
        if kwargs.get("kind") == "video":
            return float(kwargs.get("segment_index") or 1) + 2.0
        return 0.0

    def encode_frames(self, **kwargs: Any) -> dict[str, Any]:
        frame_dir = Path(kwargs["frame_dir"])
        frames = sorted(frame_dir.glob("frame_*.png"))
        assert len(frames) == kwargs["frame_count"]
        hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in frames]
        record = {**kwargs, "frame_hashes": hashes}
        self.encode_calls.append(record)
        output = Path(kwargs["output_path"])
        output.write_bytes((kwargs["motion_template"] + "\n" + "\n".join(hashes)).encode())
        return {"video_path": str(output)}

    def concat_videos(self, **kwargs: Any) -> dict[str, Any]:
        self.concat_calls.append(dict(kwargs))
        paths = [Path(path) for path in kwargs["segment_paths"]]
        assert paths and all(path.is_file() for path in paths)
        output = Path(kwargs["output_path"])
        output.write_bytes(b"|".join(path.read_bytes() for path in paths))
        return {"video_path": str(output)}

    def mux_audio(self, **kwargs: Any) -> dict[str, Any]:
        self.mux_calls.append(dict(kwargs))
        output = Path(kwargs["output_path"])
        output.write_bytes(Path(kwargs["video_path"]).read_bytes() + b"+" + Path(kwargs["audio_path"]).read_bytes())
        self.durations[str(output.resolve())] = float(kwargs["target_duration_seconds"])
        return {"video_path": str(output)}

    def checkpoint_segment(self, **kwargs: Any) -> None:
        self.checkpoints.append(dict(kwargs))

    def callbacks(self) -> EcommerceSeedingCallbacks:
        return EcommerceSeedingCallbacks(
            generate_image=self.generate_image,
            inspect_image=self.inspect_image,
            synthesize_tts=self.synthesize_tts,
            probe_duration=self.probe_duration,
            encode_frames=self.encode_frames,
            concat_videos=self.concat_videos,
            mux_audio=self.mux_audio,
            checkpoint_segment=self.checkpoint_segment,
        )


def _context(task_id: str, cancel_event: Event | None = None) -> VideoTaskContext:
    return VideoTaskContext(task_id=task_id, task_type="ecommerce_short_video", cancel_event=cancel_event)


def _segments() -> list[dict[str, Any]]:
    return [
        {
            "index": 1,
            "duration_seconds": 2,
            "prompt": "A warm opening and authentic product recommendation",
            "dialogue": "I used it for a week and this is what changed.",
            "selling_points": ["Everyday routine", "Visible product detail", "Natural recommendation"],
            "shots": [
                {"prompt": "morning routine", "duration_seconds": 1, "motion_template": "hero_push"},
                {"prompt": "product in hand", "duration_seconds": 1, "motion_template": "drift_right"},
            ],
        },
        {
            "index": 2,
            "duration_seconds": 2,
            "prompt": "Close detail and final takeaway",
            "dialogue": "The texture is light, so it fits my daily routine.",
            "shots": [
                {"prompt": "macro texture", "duration_seconds": 1, "motion_template": "macro_push_arc"},
                {"prompt": "closing lifestyle shot", "duration_seconds": 1, "motion_template": "orbit_sweep"},
            ],
        },
    ]


def test_dynamic_orchestrator_preserves_motion_audio_redraw_checkpoint_and_final_concat(tmp_path: Path) -> None:
    suppliers = MockDynamicSuppliers()
    result = render_ecommerce_seeding_dynamic(
        task_id="dynamic-parity",
        payload={
            "ecommerce_seeding_template": "template_d",
            "ratio": "1:1",
            "resolution": "720p",
            "fps": 2,
            "local_seeding_image_qa_max_attempts": 3,
            "product_name": "Daily Serum",
        },
        context=_context("dynamic-parity"),
        workdir=tmp_path,
        callbacks=suppliers.callbacks(),
        segments=_segments(),
    )

    assert result["ok"] is True
    assert Path(result["video_path"]).is_file()
    assert result["layout_variant"] == "story_column"
    assert result["motion_templates"] == ["hero_push", "drift_right", "macro_push_arc", "orbit_sweep"]

    # One failed visual QA causes exactly one redraw with the source retry constraint.
    assert len(suppliers.image_calls) == 5
    first_scene_calls = [call for call in suppliers.image_calls if call["segment_index"] == 1 and call["shot_index"] == 1]
    assert [call["attempt"] for call in first_scene_calls] == [1, 2]
    assert "no readable text" in first_scene_calls[1]["prompt"]
    assert result["image_generation_qa"][0]["attempts"][0]["report"]["status"] == "rejected"
    assert result["image_generation_qa"][0]["qa_report"]["status"] == "passed"

    # TTS is requested once per segment, then its probed duration drives the shot timeline.
    assert [call["segment_index"] for call in suppliers.tts_calls] == [1, 2]
    assert [call["target_duration_seconds"] for call in suppliers.mux_calls] == [3.0, 2.0]
    first_segment_encodes = [call for call in suppliers.encode_calls if call["segment_index"] == 1]
    assert sum(call["duration_seconds"] for call in first_segment_encodes) == pytest.approx(3.0)

    # Each scene is a generated frame sequence with camera/copy changes, not a static loop.
    assert len(suppliers.encode_calls) == 4
    assert all(len(set(call["frame_hashes"])) > 1 for call in suppliers.encode_calls)
    assert len({call["motion_template"] for call in suppliers.encode_calls}) == 4

    assert [call["completed_segment"]["index"] for call in suppliers.checkpoints] == [1, 2]
    assert [call["kind"] for call in suppliers.concat_calls] == ["shots", "shots", "segments"]
    assert len(result["completed_segments"]) == 2


def test_dynamic_canvas_keeps_template_direction_and_title_feature_animation() -> None:
    scene = Image.new("RGB", (180, 240), (25, 45, 80))
    draw = ImageDraw.Draw(scene)
    draw.rectangle((10, 20, 120, 210), fill=(220, 130, 60))
    draw.ellipse((75, 40, 170, 135), fill=(40, 180, 150))
    common = {
        "scene_image": scene,
        "output_size": (240, 240),
        "title": "A real result",
        "product_name": "Daily Serum",
        "bullets": ["Light texture", "Simple routine"],
        "motion_template": "drift_right",
        "copy_animate_in": True,
        "copy_animate_out": False,
    }
    first = draw_storyboard_frame(layout_variant="story_column", progress=0.0, **common)
    middle = draw_storyboard_frame(layout_variant="story_column", progress=0.5, **common)
    last = draw_storyboard_frame(layout_variant="story_column", progress=1.0, **common)
    template_f = draw_storyboard_frame(layout_variant="closeup_sidebar", progress=0.5, **common)

    assert first.tobytes() != middle.tobytes() != last.tobytes()
    assert middle.tobytes() != template_f.tobytes()


def test_source_shaped_storyboard_renderer_injects_encoder_without_static_loop(tmp_path: Path) -> None:
    scene_path = tmp_path / "scene.png"
    image = Image.new("RGB", (180, 240), (30, 60, 90))
    ImageDraw.Draw(image).rectangle((20, 25, 155, 220), fill=(225, 125, 55))
    image.save(scene_path)
    encoded: list[dict[str, Any]] = []

    def encode_frames(**kwargs: Any) -> dict[str, Any]:
        frames = sorted(Path(kwargs["frame_dir"]).glob("frame_*.png"))
        hashes = {hashlib.sha256(frame.read_bytes()).hexdigest() for frame in frames}
        assert len(hashes) > 1
        encoded.append(dict(kwargs))
        Path(kwargs["output_path"]).write_bytes(b"dynamic")
        return {"video_path": str(kwargs["output_path"])}

    output = render_local_ecommerce_storyboard_video(
        scene_image_path=scene_path,
        output_path=tmp_path / "shot.mp4",
        duration_seconds=2,
        canvas_size=(240, 240),
        motion_template="hold_breathe",
        storyboard_template="template_b",
        encode_frames=encode_frames,
        context=_context("direct-storyboard"),
        prompt="A practical daily routine",
        product_name="Daily Serum",
        feature_hints=["Easy to use", "Clear details"],
        fps=2,
    )

    assert output.is_file()
    assert encoded[0]["motion_template"] == "hold_breathe"
    assert encoded[0]["layout_variant"] == "webinar_spine"
    assert not (tmp_path / "shot_frames").exists()


def test_dynamic_orchestrator_stops_before_any_supplier_when_cancelled(tmp_path: Path) -> None:
    suppliers = MockDynamicSuppliers()
    cancelled = Event()
    cancelled.set()

    with pytest.raises(VideoTaskCancelled):
        render_ecommerce_seeding_dynamic(
            task_id="dynamic-cancelled",
            payload={"ecommerce_seeding_template": "template_b", "fps": 1},
            context=_context("dynamic-cancelled", cancelled),
            workdir=tmp_path,
            callbacks=suppliers.callbacks(),
            segments=_segments()[:1],
        )

    assert suppliers.image_calls == []
    assert suppliers.tts_calls == []
    assert suppliers.encode_calls == []


def test_dynamic_orchestrator_resumes_completed_segment_and_still_builds_final_file(tmp_path: Path) -> None:
    suppliers = MockDynamicSuppliers()
    suppliers.reject_first_scene_once = False
    completed = tmp_path / "completed-segment-one.mp4"
    completed.write_bytes(b"already-rendered")

    result = render_ecommerce_seeding_dynamic(
        task_id="dynamic-resume",
        payload={
            "ecommerce_seeding_template": "template_f",
            "ratio": "1:1",
            "fps": 1,
            "product_name": "Daily Serum",
        },
        context=_context("dynamic-resume"),
        workdir=tmp_path / "run",
        callbacks=suppliers.callbacks(),
        segments=_segments(),
        completed_segments=[{"index": 1, "path": str(completed), "duration_seconds": 3.0}],
    )

    assert Path(result["video_path"]).is_file()
    assert result["segments"][0]["skipped"] is True
    assert [call["segment_index"] for call in suppliers.tts_calls] == [2]
    assert {call["segment_index"] for call in suppliers.image_calls} == {2}
    assert [call["completed_segment"]["index"] for call in suppliers.checkpoints] == [2]
    final_concat = suppliers.concat_calls[-1]
    assert final_concat["kind"] == "segments"
    assert [Path(path).resolve() for path in final_concat["segment_paths"]] == [
        completed.resolve(),
        Path(result["segments"][1]["path"]).resolve(),
    ]
