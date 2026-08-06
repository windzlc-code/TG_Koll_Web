from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

from video_core.contracts import VideoTaskContext
from video_core.image_generate_dispatch import SUPPORTED_IMAGE_MODES, map_image_reference_roles
from video_core.source_backend import ArchivedSourceBackend
from webapp.video_workbench import VIDEO_MODULE_METADATA


def test_scene_image_is_internal_only_and_needs_no_reference_image() -> None:
    assert "scene_image" in SUPPORTED_IMAGE_MODES
    assert map_image_reference_roles("scene_image", []) == []
    assert "scene_image" not in VIDEO_MODULE_METADATA
    assert set(VIDEO_MODULE_METADATA) == {
        "create_video",
        "ecommerce_short_video",
        "video_language_replace",
        "replace_model",
        "replace_product",
        "image_generate",
    }


def test_source_backend_dispatches_hidden_scene_image_as_text_to_image() -> None:
    captured: dict = {}

    def generate_image(**kwargs):
        captured.update(kwargs)
        output = Path(kwargs["output_image_path"])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"image")
        return {"ok": True, "image_path": str(output), "selected_model": "fake-model"}

    with tempfile.TemporaryDirectory() as tmpdir:
        with patch("video_core.source_backend.image_model_api.generate_image", side_effect=generate_image):
            result = ArchivedSourceBackend().image_generate(
                task_id="hidden-scene",
                payload={
                    "output_dir": tmpdir,
                    "mode": "scene_image",
                    "prompt": "自然光下的现代办公空间",
                    "image_size": "2K",
                },
                context=VideoTaskContext(task_id="hidden-scene", task_type="image_generate"),
            )

    assert result["ok"] is True
    assert result["mode"] == "scene_image"
    assert captured["input_image_paths"] == []
    assert "数字人口播背景" in captured["prompt"]
    assert captured["size"] == "2K"
