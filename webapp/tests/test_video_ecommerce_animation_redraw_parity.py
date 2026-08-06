from __future__ import annotations

from pathlib import Path
from threading import Event
from typing import Any

import pytest

from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core.ecommerce_animation_redraw import redraw_animation_references


def _context(task_id: str = "redraw-task", cancel_event: Event | None = None) -> VideoTaskContext:
    return VideoTaskContext(
        task_id=task_id,
        task_type="ecommerce_short_video",
        cancel_event=cancel_event,
    )


def test_redraw_animation_references_preserves_original_field_rewrites(tmp_path: Path) -> None:
    product_one = tmp_path / "product-one.jpg"
    product_two = tmp_path / "product-two.png"
    model = tmp_path / "model.webp"
    for path in (product_one, product_two, model):
        path.write_bytes(path.name.encode("utf-8"))

    calls: list[dict[str, Any]] = []

    def generate_image(**kwargs: Any) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
        calls.append(dict(kwargs))
        output = Path(kwargs["output_image_path"])
        output.write_bytes(f"redrawn-{len(calls)}".encode("utf-8"))
        return (
            {"image_path": str(output)},
            {"model": f"mock-model-{len(calls)}"},
            [{"model": "mock", "ok": True}],
        )

    payload = {
        "ecommerce_ad_style": "animation",
        "prompt": "一支厨卫热水器动画广告",
        "product_category": "electronics",
        "ecommerce_effective_product_image_local_paths": [str(product_one), str(product_two)],
        "model_image_local_path": str(model),
        "custom_value": "keep-me",
    }
    result = redraw_animation_references(
        payload,
        task_id="redraw-task",
        workdir=tmp_path / "work",
        context=_context(),
        generate_image=generate_image,
    )

    assert result["ok"] is True
    assert len(calls) == 3
    assert [call["request_label"] for call in calls] == [
        "动画广告素材转绘 1/3",
        "动画广告素材转绘 2/3",
        "动画广告素材转绘 3/3",
    ]
    assert "厨卫家电动画广告参考图" in calls[0]["prompt"]
    assert "产品/场景有效图1" in calls[0]["prompt"]
    assert "人物需转成统一的 2D 商业动画角色" in calls[2]["prompt"]
    assert calls[0]["source"] is not payload
    assert calls[0]["allow_builtin"] is True
    assert Path(calls[0]["input_image_path"]) == product_one.resolve()

    params = result["params"]
    image_paths = result["image_paths"]
    assert params["custom_value"] == "keep-me"
    assert params["product_image_local_path"] == image_paths[0]
    assert params["product_image_local_paths"] == image_paths[:2]
    assert params["ecommerce_effective_product_image_local_paths"] == image_paths[:2]
    assert params["model_image_local_path"] == image_paths[2]
    assert params["ecommerce_model_reference_skipped"] is False
    assert params["ecommerce_animation_redraw_done"] is True
    assert params["ecommerce_animation_redraw_skipped"] is False
    assert params["ecommerce_animation_original_reference_paths"] == [
        str(product_one.resolve()),
        str(product_two.resolve()),
        str(model.resolve()),
    ]
    assert params["ecommerce_animation_redrawn_reference_paths"] == image_paths
    assert params["ecommerce_animation_redraw_result"] == {
        "task_id": "redraw-task",
        "product_category": "sanitary_kitchen",
        "items": [
            {
                "index": index,
                "kind": "model" if index == 3 else "product",
                "source_path": str((model if index == 3 else (product_one, product_two)[index - 1]).resolve()),
                "output_path": image_paths[index - 1],
                "model": f"mock-model-{index}",
                "attempts": [{"model": "mock", "ok": True}],
            }
            for index in range(1, 4)
        ],
    }


def test_redraw_animation_references_skips_model_exactly_like_old_step(tmp_path: Path) -> None:
    product = tmp_path / "product.png"
    model = tmp_path / "model.png"
    product.write_bytes(b"product")
    model.write_bytes(b"model")
    calls: list[dict[str, Any]] = []

    def generate_image(**kwargs: Any) -> tuple[dict[str, Any], dict[str, Any], list[Any]]:
        calls.append(dict(kwargs))
        output = Path(kwargs["output_image_path"])
        output.write_bytes(b"redrawn")
        return {"image_path": str(output)}, {}, []

    result = redraw_animation_references(
        {
            "ecommerce_ad_style": "animation",
            "product_image_local_path": str(product),
            "model_image_local_path": str(model),
            "model_reference_skipped": "true",
        },
        task_id="skip-model",
        workdir=tmp_path / "work",
        context=_context("skip-model"),
        generate_image=generate_image,
    )

    assert len(calls) == 1
    assert result["params"]["model_image_local_path"] == str(model)
    assert "ecommerce_model_reference_skipped" not in result["params"]


@pytest.mark.parametrize("style", ["", "realistic", "REALISTIC"])
def test_redraw_animation_references_only_accepts_animation(style: str, tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="只有动画广告风格需要执行素材转绘"):
        redraw_animation_references(
            {"ecommerce_ad_style": style},
            task_id="wrong-style",
            workdir=tmp_path,
            context=_context("wrong-style"),
            generate_image=lambda **_kwargs: ({}, {}, []),
        )


def test_redraw_animation_references_preserves_missing_input_and_output_errors(tmp_path: Path) -> None:
    missing = tmp_path / "missing.png"
    with pytest.raises(FileNotFoundError, match="待转绘产品图不存在"):
        redraw_animation_references(
            {"ecommerce_ad_style": "animation", "product_image_local_path": str(missing)},
            task_id="missing-input",
            workdir=tmp_path / "work-one",
            context=_context("missing-input"),
            generate_image=lambda **_kwargs: ({}, {}, []),
        )

    product = tmp_path / "product.png"
    product.write_bytes(b"product")
    with pytest.raises(RuntimeError, match="动画素材转绘成功但未找到输出图"):
        redraw_animation_references(
            {"ecommerce_ad_style": "animation", "product_image_local_path": str(product)},
            task_id="missing-output",
            workdir=tmp_path / "work-two",
            context=_context("missing-output"),
            generate_image=lambda **_kwargs: ({}, {"model": "mock"}, []),
        )


def test_redraw_animation_references_checks_cancellation_between_items(tmp_path: Path) -> None:
    products = [tmp_path / "one.png", tmp_path / "two.png"]
    for product in products:
        product.write_bytes(b"product")
    cancelled = Event()
    calls = 0

    def generate_image(**kwargs: Any) -> tuple[dict[str, Any], dict[str, Any], list[Any]]:
        nonlocal calls
        calls += 1
        output = Path(kwargs["output_image_path"])
        output.write_bytes(b"redrawn")
        cancelled.set()
        return {"image_path": str(output)}, {}, []

    with pytest.raises(VideoTaskCancelled):
        redraw_animation_references(
            {
                "ecommerce_ad_style": "animation",
                "product_image_local_paths": [str(path) for path in products],
            },
            task_id="cancel-redraw",
            workdir=tmp_path / "work",
            context=_context("cancel-redraw", cancelled),
            generate_image=generate_image,
        )
    assert calls == 1
