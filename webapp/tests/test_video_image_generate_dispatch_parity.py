from __future__ import annotations

import threading
from pathlib import Path

import pytest

from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core.image_generate_dispatch import dispatch_image_generate, map_image_reference_roles


def _image(tmp_path: Path, name: str) -> str:
    path = tmp_path / name
    path.write_bytes(b"reference")
    return str(path)


def _write_result(**values):
    output = Path(values["output_path"])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(f"{values.get('provider', 'provider')}:{values.get('model', '')}".encode())
    return {"ok": True, "image_path": str(output), "selected_model": values.get("model", "")}


def test_dedicated_workflow_chain_preserves_ids_count_and_reference_semantics(tmp_path: Path):
    product = _image(tmp_path, "product.png")
    model = _image(tmp_path, "model.png")
    calls: list[dict] = []

    def workflow(**values):
        calls.append(values)
        result = _write_result(provider="workflow", **values)
        result.update({"runninghub_task_id": f"rh-{values['image_index']}-{values['step_index']}"})
        return result

    result = dispatch_image_generate(
        task_id="workflow-task",
        payload={
            "image_generate_provider": "runninghub_workflow",
            "image_generate_workflow_ids": ["wf-detail", "wf-polish"],
        },
        mode="model_product",
        prompt="studio catalog image",
        input_image_paths=[product, model],
        output_dir=tmp_path / "out",
        count=2,
        size="1:1",
        workflow_callback=workflow,
    )

    assert [(call["workflow_id"], call["image_index"]) for call in calls] == [
        ("wf-detail", 1),
        ("wf-polish", 1),
        ("wf-detail", 2),
        ("wf-polish", 2),
    ]
    assert calls[0]["input_image_paths"] == [product, model]
    assert calls[0]["reference_roles"] == ["product", "model"]
    assert calls[1]["product_input"] == calls[0]["output_path"]
    assert calls[1]["model_input"] == calls[0]["output_path"]
    assert result["image_count"] == result["nano_images"] == 2
    assert len(result["image_paths"]) == 2
    assert [Path(path).name for path in result["image_paths"]] == ["image_generate_001.png", "image_generate_002.png"]
    assert result["runninghub_task_ids"] == ["rh-1-1", "rh-1-2", "rh-2-1", "rh-2-2"]
    assert result["raw_result"]["workflow_ids"] == ["wf-detail", "wf-polish"]


def test_closed_provider_uses_model_priority_and_keeps_all_references(tmp_path: Path):
    references = [_image(tmp_path, f"view-{index}.png") for index in range(3)]
    calls: list[dict] = []

    def closed(**values):
        calls.append(values)
        if values["model"] == "bad-model":
            raise RuntimeError("model unavailable")
        return _write_result(provider="closed", **values)

    result = dispatch_image_generate(
        task_id="closed-task",
        payload={
            "image_generate_provider": "closed_model_api",
            "image_model_priority_order": "bad-model, good-model",
        },
        mode="three_view",
        prompt="turnaround",
        input_image_paths=references,
        output_dir=tmp_path / "out",
        count=2,
        closed_model_callback=closed,
    )

    assert [call["model"] for call in calls] == ["bad-model", "good-model", "bad-model", "good-model"]
    assert all(call["input_image_paths"] == references for call in calls)
    assert all(call["reference_roles"] == ["reference_1", "reference_2", "reference_3"] for call in calls)
    assert result["image_count"] == 2
    assert result["image_model_used"] == "good-model"
    assert len(result["image_model_attempts"]) == 4


def test_workflow_ids_can_mix_dedicated_and_closed_model_stages(tmp_path: Path):
    product = _image(tmp_path, "mixed-product.png")
    model = _image(tmp_path, "mixed-model.png")
    calls: list[tuple[str, str, list[str]]] = []

    def workflow(**values):
        calls.append(("workflow", values["workflow_id"], values["input_image_paths"]))
        return _write_result(provider="workflow", **values)

    def closed(**values):
        calls.append(("closed", values["model"], values["input_image_paths"]))
        return _write_result(provider="closed", **values)

    result = dispatch_image_generate(
        task_id="mixed-chain",
        payload={
            "image_generate_provider": "workflow",
            "image_generate_workflow_ids": ["wf-layout", "closed_image_model:detail-model", "wf-finish"],
            "image_model_priority_order": "fallback-model",
        },
        mode="model_product",
        prompt="mixed provider chain",
        input_image_paths=[product, model],
        output_dir=tmp_path / "mixed-out",
        workflow_callback=workflow,
        closed_model_callback=closed,
    )

    assert [(provider, identifier) for provider, identifier, _paths in calls] == [
        ("workflow", "wf-layout"),
        ("closed", "detail-model"),
        ("workflow", "wf-finish"),
    ]
    assert calls[0][2] == [product, model]
    assert calls[1][2] == [result["raw_result"]["generations"][0]["steps"][0]["output_path"]]
    assert Path(result["image_path"]).name == "image_generate.png"


def test_auto_falls_back_from_workflow_to_closed_then_standard_api(tmp_path: Path):
    product = _image(tmp_path, "product.png")
    model = _image(tmp_path, "model.png")
    calls: list[str] = []

    def workflow(**_values):
        calls.append("workflow")
        raise RuntimeError("workflow rejected")

    def closed(**_values):
        calls.append("closed")
        raise RuntimeError("closed quota")

    def standard(**values):
        calls.append("standard")
        result = _write_result(provider="standard", **values)
        result["runninghub_task_id"] = "rh-standard"
        return result

    result = dispatch_image_generate(
        task_id="auto-task",
        payload={
            "image_generate_provider": "auto",
            "image_generate_workflow_ids": ["wf-special"],
            "image_model_priority_order": ["closed-a"],
        },
        mode="model_product",
        prompt="catalog",
        input_image_paths=[product, model],
        output_dir=tmp_path / "out",
        workflow_callback=workflow,
        closed_model_callback=closed,
        standard_api_callback=standard,
    )

    assert calls == ["workflow", "closed", "standard"]
    assert result["provider_used"] == "standard_image_api"
    assert result["runninghub_task_id"] == "rh-standard"
    assert [item["provider"] for item in result["image_model_attempts"]] == [
        "runninghub_workflow",
        "closed_model_api",
        "standard_image_api",
    ]


@pytest.mark.parametrize(
    ("mode", "count", "roles"),
    [
        ("product_only", 3, ["product", "product_reference_2", "product_reference_3"]),
        ("model_product", 4, ["product", "model", "extra_reference_1", "extra_reference_2"]),
        ("subject_replace", 3, ["source", "replacement", "replacement_secondary"]),
        ("poster_translate", 1, ["poster"]),
        ("digital_human_character", 2, ["character_reference_1", "character_reference_2"]),
        ("three_view", 3, ["reference_1", "reference_2", "reference_3"]),
    ],
)
def test_all_six_normalized_modes_map_reference_roles(mode: str, count: int, roles: list[str]):
    assert map_image_reference_roles(mode, [f"ref-{index}" for index in range(count)]) == roles


def test_subject_replace_multi_reference_does_not_drop_a_reference_for_workflow(tmp_path: Path):
    references = [_image(tmp_path, f"subject-{index}.png") for index in range(3)]
    calls: list[dict] = []

    def closed(**values):
        calls.append(values)
        return _write_result(provider="closed", **values)

    result = dispatch_image_generate(
        task_id="subject-task",
        payload={
            "image_generate_provider": "runninghub_workflow",
            "image_generate_workflow_ids": ["wf-single-replacement"],
            "image_model_priority_order": "closed-safe",
        },
        mode="subject_replace",
        prompt="replace both references",
        input_image_paths=references,
        output_dir=tmp_path / "out",
        workflow_callback=lambda **_values: pytest.fail("workflow would drop the third reference"),
        closed_model_callback=closed,
    )

    assert calls[0]["input_image_paths"] == references
    assert result["provider_used"] == "closed_model_api"
    assert result["raw_result"]["provider_requested"] == "runninghub_workflow"


def test_cancellation_is_never_converted_to_provider_fallback(tmp_path: Path):
    event = threading.Event()
    event.set()
    calls: list[str] = []
    context = VideoTaskContext(task_id="cancelled", task_type="image_generate", cancel_event=event)

    with pytest.raises(VideoTaskCancelled):
        dispatch_image_generate(
            task_id="cancelled",
            payload={"image_generate_provider": "auto"},
            mode="digital_human_character",
            prompt="person",
            input_image_paths=[],
            output_dir=tmp_path / "out",
            context=context,
            closed_model_callback=lambda **_values: calls.append("closed"),
            standard_api_callback=lambda **_values: calls.append("standard"),
        )
    assert calls == []


def test_callback_cancellation_is_not_swallowed_by_auto_fallback(tmp_path: Path):
    calls: list[str] = []

    def closed(**_values):
        calls.append("closed")
        raise VideoTaskCancelled("cancelled while provider was running")

    with pytest.raises(VideoTaskCancelled):
        dispatch_image_generate(
            task_id="provider-cancelled",
            payload={"image_generate_provider": "auto"},
            mode="digital_human_character",
            prompt="person",
            input_image_paths=[],
            output_dir=tmp_path / "out",
            closed_model_callback=closed,
            standard_api_callback=lambda **_values: calls.append("standard"),
        )
    assert calls == ["closed"]


@pytest.mark.parametrize(
    ("payload", "callbacks", "message"),
    [
        ({"image_generate_provider": "unknown"}, {"closed_model_callback": _write_result}, "provider"),
        ({"image_generate_provider": "runninghub_workflow"}, {"workflow_callback": _write_result}, "workflow"),
        ({"image_generate_provider": "closed_model_api"}, {}, "callback"),
    ],
)
def test_configuration_errors_are_explicit(tmp_path: Path, payload: dict, callbacks: dict, message: str):
    with pytest.raises((ValueError, RuntimeError), match=message):
        dispatch_image_generate(
            task_id="bad-config",
            payload=payload,
            mode="digital_human_character",
            prompt="person",
            input_image_paths=[],
            output_dir=tmp_path / "out",
            **callbacks,
        )


def test_callback_success_without_an_output_file_is_rejected(tmp_path: Path):
    with pytest.raises(RuntimeError, match="output"):
        dispatch_image_generate(
            task_id="missing-output",
            payload={"image_generate_provider": "closed_model_api", "image_generate_model": "fake"},
            mode="digital_human_character",
            prompt="person",
            input_image_paths=[],
            output_dir=tmp_path / "out",
            closed_model_callback=lambda **_values: {"ok": True},
        )
