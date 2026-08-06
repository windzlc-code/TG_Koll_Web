from __future__ import annotations

import threading
from pathlib import Path

import pytest

from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core.replacement_pipeline import run_replacement_pipeline


class WorkdirBackend:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _workdir(self, task_id: str, payload: dict) -> Path:
        path = self.root / task_id
        path.mkdir(parents=True, exist_ok=True)
        return path


def _media_files(tmp_path: Path) -> tuple[Path, Path, Path]:
    video = tmp_path / "source.mp4"
    model = tmp_path / "model.png"
    product = tmp_path / "product.png"
    video.write_bytes(b"video")
    model.write_bytes(b"model")
    product.write_bytes(b"product")
    return video, model, product


def _context(task_id: str, task_type: str, *, event=None) -> VideoTaskContext:
    return VideoTaskContext(task_id=task_id, task_type=task_type, cancel_event=event)


def test_replace_model_runs_closed_image_then_ordered_workflow_chain(tmp_path: Path) -> None:
    video, model, _product = _media_files(tmp_path)
    calls: list[tuple] = []
    checkpoints: list[dict] = []

    def closed_image_provider(**values):
        calls.append(("closed", values["subject"], values["model"], values["input_path"]))
        output = Path(values["output_path"])
        output.write_bytes(b"closed-model")
        return {"ok": True, "image_path": str(output)}

    def workflow_provider(**values):
        calls.append(("workflow", values["subject"], values["app_id"], values["input_video"]))
        output = Path(values["output_path"])
        output.write_bytes(values["app_id"].encode("utf-8"))
        return {
            "status": "success",
            "runninghub_task_id": f"rh-{values['app_id']}",
            "runninghub_usage": {"consumeCoins": 1},
            "download_path": str(output),
        }

    result = run_replacement_pipeline(
        WorkdirBackend(tmp_path / "work"),
        "replace_model",
        "replace-model-task",
        {
            "video_local_path": str(video),
            "model_image_local_path": str(model),
            "mode": "original",
            "replace_model_original_workflow_ids": [
                "closed_image_model:gpt-image-2",
                "model-1",
                "model-2",
            ],
            "_replacement_closed_image_provider": closed_image_provider,
            "_replacement_workflow_provider": workflow_provider,
            "_checkpoint_video_progress": lambda **values: checkpoints.append(values),
        },
        _context("replace-model-task", "replace_model"),
    )

    assert result["ok"] is True
    assert Path(result["download_path"]).read_bytes() == b"model-2"
    assert [call[:3] for call in calls] == [
        ("closed", "model", "gpt-image-2"),
        ("workflow", "model", "model-1"),
        ("workflow", "model", "model-2"),
    ]
    assert calls[2][3].endswith("model_workflow_01.mp4")
    assert result["runninghub_task_ids"] == ["rh-model-1", "rh-model-2"]
    assert result["runninghub_usage"]["consumeCoins"] == 2.0
    assert [step["stage_id"] for step in result["replacement_checkpoint"]["completed_stages"]] == [
        "model:closed:01",
        "model:workflow:01:model-1",
        "model:workflow:02:model-2",
    ]
    assert checkpoints[-1]["final_output_path"] == result["download_path"]


def test_replace_product_uses_archived_node_mapping_for_every_workflow(tmp_path: Path) -> None:
    video, _model, product = _media_files(tmp_path)

    class Backend(WorkdirBackend):
        def __init__(self, root: Path) -> None:
            super().__init__(root)
            self.submissions: list[dict] = []

        def _resolve_media(self, *, media_kind, local_values, **_kwargs):
            return f"https://media.test/{media_kind}/{Path(local_values[0]).name}"

        def _workflow_submit_url(self, payload, app_id):
            return f"https://runninghub.test/{app_id}"

        def _submit_and_poll(self, *, submit_url, submit_payload, output_path, **_kwargs):
            self.submissions.append({"url": submit_url, "payload": submit_payload})
            Path(output_path).write_bytes(b"product-output")
            app_id = submit_url.rsplit("/", 1)[-1]
            return {"status": "success", "runninghub_task_id": f"rh-{app_id}"}

    backend = Backend(tmp_path / "work")
    result = run_replacement_pipeline(
        backend,
        "replace_product",
        "replace-product-task",
        {
            "video_local_path": str(video),
            "product_image_local_path": str(product),
            "replace_product_workflow_ids": ["product-1", "product-2"],
            "product_name": "cup",
            "prompt_text": "replace only the cup",
            "duration_seconds": 12,
            "frame_rate": 24,
            "width": 720,
            "height": 1280,
        },
        _context("replace-product-task", "replace_product"),
    )

    assert result["ok"] is True
    assert len(backend.submissions) == 2
    assert [item["url"].rsplit("/", 1)[-1] for item in backend.submissions] == [
        "product-1",
        "product-2",
    ]
    first_nodes = backend.submissions[0]["payload"]["nodeInfoList"]
    assert [node["nodeId"] for node in first_nodes] == [
        "188",
        "57",
        "197",
        "304",
        "297",
        "191",
        "311",
        "312",
    ]
    assert next(node for node in first_nodes if node["nodeId"] == "304")["fieldValue"] == "cup"
    assert result["runninghub_task_ids"] == ["rh-product-1", "rh-product-2"]


@pytest.mark.parametrize(
    ("mode", "app_id_key", "app_id", "expected_node_ids"),
    [
        ("primary", "replace_model_primary_app_id", "primary-app", ["55", "60", "43", "49"]),
        ("slice", "replace_model_slice_app_id", "slice-app", ["352", "318", "284", "339", "341"]),
        ("motion_transfer", "replace_model_motion_transfer_app_id", "motion-app", ["55", "60", "43", "49"]),
    ],
)
def test_replace_model_modes_use_original_mode_app_and_node_contract(
    tmp_path: Path,
    mode: str,
    app_id_key: str,
    app_id: str,
    expected_node_ids: list[str],
) -> None:
    video, model, _product = _media_files(tmp_path)

    class Backend(WorkdirBackend):
        def __init__(self, root: Path) -> None:
            super().__init__(root)
            self.submit_url = ""
            self.nodes: list[dict] = []

        def _resolve_media(self, *, local_values, **_kwargs):
            return f"https://media.test/{Path(local_values[0]).name}"

        def _workflow_submit_url(self, payload, app_id):
            return f"https://runninghub.test/{app_id}"

        def _submit_and_poll(self, *, submit_url, submit_payload, output_path, **_kwargs):
            self.submit_url = submit_url
            self.nodes = submit_payload["nodeInfoList"]
            Path(output_path).write_bytes(b"mode-output")
            return {"status": "success", "runninghub_task_id": "rh-mode"}

    backend = Backend(tmp_path / mode)
    result = run_replacement_pipeline(
        backend,
        "replace_model",
        f"mode-{mode}",
        {
            "video_local_path": str(video),
            "model_image_local_path": str(model),
            "mode": mode,
            app_id_key: app_id,
            "prompt": "walk",
            "duration_seconds": 5,
            "start_seconds": 2,
            "width": 720,
            "height": 1280,
        },
        _context(f"mode-{mode}", "replace_model"),
    )

    assert result["ok"] is True
    assert backend.submit_url.endswith(f"/{app_id}")
    assert [node["nodeId"] for node in backend.nodes] == expected_node_ids


def test_combined_replacement_preprocesses_both_images_then_runs_model_and_product_chains(tmp_path: Path) -> None:
    video, model, product = _media_files(tmp_path)
    calls: list[tuple[str, str, str]] = []

    def closed_image_provider(**values):
        calls.append(("closed", values["subject"], values["model"]))
        output = Path(values["output_path"])
        output.write_bytes(values["subject"].encode("utf-8"))
        return {"status": "success", "image_path": str(output)}

    def workflow_provider(**values):
        calls.append(("workflow", values["subject"], values["app_id"]))
        output = Path(values["output_path"])
        output.write_bytes(f"{values['subject']}:{values['app_id']}".encode("utf-8"))
        return {"status": "success", "task_id": f"rh-{values['subject']}-{values['app_id']}"}

    result = run_replacement_pipeline(
        WorkdirBackend(tmp_path / "work"),
        "replace_productANDmodel",
        "combined-task",
        {
            "video_local_path": str(video),
            "model_image_local_path": str(model),
            "product_image_local_path": str(product),
            "model_workflow_chain_ids": ["closed_image_model:model-prep", "model-1", "model-2"],
            "product_workflow_chain_ids": ["closed_image_model:product-prep", "product-1"],
            "_replacement_closed_image_provider": closed_image_provider,
            "_replacement_workflow_provider": workflow_provider,
        },
        _context("combined-task", "replace_product_and_model"),
    )

    assert result["ok"] is True
    assert result["task_type"] == "replace_product_and_model"
    assert calls == [
        ("closed", "model", "model-prep"),
        ("closed", "product", "product-prep"),
        ("workflow", "model", "model-1"),
        ("workflow", "model", "model-2"),
        ("workflow", "product", "product-1"),
    ]
    assert Path(result["download_path"]).read_bytes() == b"product:product-1"
    assert result["runninghub_task_ids"] == [
        "rh-model-model-1",
        "rh-model-model-2",
        "rh-product-product-1",
    ]


def test_resume_skips_completed_stage_and_continues_from_its_output(tmp_path: Path) -> None:
    video, model, _product = _media_files(tmp_path)
    completed_output = tmp_path / "completed-model-step.mp4"
    completed_output.write_bytes(b"completed")
    calls: list[tuple[str, str]] = []

    def workflow_provider(**values):
        calls.append((values["app_id"], values["input_video"]))
        output = Path(values["output_path"])
        output.write_bytes(b"resumed-final")
        return {"status": "success", "runninghub_task_id": "rh-model-2"}

    result = run_replacement_pipeline(
        WorkdirBackend(tmp_path / "work"),
        "replace_model",
        "resume-task",
        {
            "video_local_path": str(video),
            "model_image_local_path": str(model),
            "replace_model_original_workflow_ids": ["model-1", "model-2"],
            "resume_checkpoint": {
                "replacement_checkpoint": {
                    "completed_stages": [
                        {
                            "stage_id": "model:workflow:01:model-1",
                            "stage_index": 1,
                            "subject": "model",
                            "provider": "runninghub_workflow",
                            "app_id": "model-1",
                            "status": "success",
                            "output_path": str(completed_output),
                            "runninghub_task_id": "rh-model-1",
                            "runninghub_task_ids": ["rh-model-1"],
                            "result": {"status": "success"},
                        }
                    ]
                }
            },
            "_replacement_workflow_provider": workflow_provider,
        },
        _context("resume-task", "replace_model"),
    )

    assert calls == [("model-2", str(completed_output.resolve()))]
    assert result["ok"] is True
    assert result["runninghub_task_ids"] == ["rh-model-1", "rh-model-2"]
    assert result["replacement_checkpoint"]["completed_stages"][0]["resumed"] is True


def test_failed_workflow_returns_normalized_failure_and_keeps_prior_checkpoint(tmp_path: Path) -> None:
    video, model, _product = _media_files(tmp_path)
    calls = 0

    def workflow_provider(**values):
        nonlocal calls
        calls += 1
        output = Path(values["output_path"])
        if calls == 1:
            output.write_bytes(b"first")
            return {"status": "success", "runninghub_task_id": "rh-first"}
        return {"status": "failed", "runninghub_task_id": "rh-failed", "message": "provider failed"}

    result = run_replacement_pipeline(
        WorkdirBackend(tmp_path / "work"),
        "replace_model",
        "failure-task",
        {
            "video_local_path": str(video),
            "model_image_local_path": str(model),
            "replace_model_original_workflow_ids": ["model-1", "model-2"],
            "_replacement_workflow_provider": workflow_provider,
        },
        _context("failure-task", "replace_model"),
    )

    assert result["ok"] is False
    assert result["message"] == "provider failed"
    assert result["runninghub_task_ids"] == ["rh-first", "rh-failed"]
    assert [item["stage_id"] for item in result["replacement_checkpoint"]["completed_stages"]] == [
        "model:workflow:01:model-1"
    ]
    assert result["raw_result"]["failed_stage"]["stage_id"] == "model:workflow:02:model-2"


def test_cancellation_is_checked_immediately_after_provider_returns(tmp_path: Path) -> None:
    video, model, _product = _media_files(tmp_path)
    event = threading.Event()

    def workflow_provider(**values):
        Path(values["output_path"]).write_bytes(b"cancelled")
        event.set()
        return {"status": "success", "runninghub_task_id": "rh-cancelled"}

    with pytest.raises(VideoTaskCancelled):
        run_replacement_pipeline(
            WorkdirBackend(tmp_path / "work"),
            "replace_model",
            "cancel-task",
            {
                "video_local_path": str(video),
                "model_image_local_path": str(model),
                "replace_model_original_workflow_ids": ["model-1", "model-2"],
                "_replacement_workflow_provider": workflow_provider,
            },
            _context("cancel-task", "replace_model", event=event),
        )


def test_long_replacement_splits_runs_each_segment_and_reassembles(tmp_path: Path) -> None:
    video, model, _product = _media_files(tmp_path)
    cuts: list[tuple[float, float]] = []
    workflow_inputs: list[str] = []

    def cut_segment(*, source_path, output_path, start_seconds, duration_seconds, **_kwargs):
        assert Path(source_path) == video.resolve()
        cuts.append((start_seconds, duration_seconds))
        Path(output_path).write_bytes(f"cut:{start_seconds}:{duration_seconds}".encode())
        return output_path

    def workflow_provider(**values):
        workflow_inputs.append(values["input_video"])
        output = Path(values["output_path"])
        output.write_bytes(f"segment:{len(workflow_inputs)}".encode())
        return {"status": "success", "runninghub_task_id": f"rh-{len(workflow_inputs)}", "download_path": str(output)}

    def concat_segments(*, segment_paths, output_path, **_kwargs):
        Path(output_path).write_bytes(b"|".join(Path(path).read_bytes() for path in segment_paths))
        return output_path

    result = run_replacement_pipeline(
        WorkdirBackend(tmp_path / "work"),
        "replace_model",
        "long-replacement",
        {
            "video_local_path": str(video),
            "model_image_local_path": str(model),
            "replace_model_original_workflow_ids": ["model-workflow"],
            "_replacement_duration_probe": lambda **_kwargs: 45.0,
            "_replacement_segment_cutter": cut_segment,
            "_replacement_segment_concat": concat_segments,
            "_replacement_workflow_provider": workflow_provider,
        },
        _context("long-replacement", "replace_model"),
    )

    assert result["ok"] is True
    assert result["source_video_segmented"] is True
    assert cuts == [(0.0, 20.0), (20.0, 20.0), (40.0, 5.0)]
    assert len(workflow_inputs) == 3
    assert Path(result["download_path"]).read_bytes() == b"segment:1|segment:2|segment:3"
    assert result["runninghub_task_ids"] == ["rh-1", "rh-2", "rh-3"]


def test_hard_subtitle_detection_uses_removal_output_before_workflow(tmp_path: Path) -> None:
    video, model, _product = _media_files(tmp_path)
    removed = tmp_path / "subtitle-removed.mp4"
    workflow_inputs: list[str] = []

    def remove_subtitles(*, video_path, output_path, **_kwargs):
        assert Path(video_path) == video.resolve()
        Path(output_path).write_bytes(b"clean-video")
        return {"video_path": str(output_path), "runninghub_task_id": "rh-clean"}

    def workflow_provider(**values):
        workflow_inputs.append(values["input_video"])
        output = Path(values["output_path"])
        output.write_bytes(b"replaced")
        return {"status": "success", "runninghub_task_id": "rh-replace", "download_path": str(output)}

    result = run_replacement_pipeline(
        WorkdirBackend(tmp_path / "work"),
        "replace_model",
        "subtitle-removal",
        {
            "video_local_path": str(video),
            "model_image_local_path": str(model),
            "duration_seconds": 10,
            "replace_model_original_workflow_ids": ["model-workflow"],
            "_replacement_subtitle_detector": lambda **_kwargs: {"has_subtitle": True, "score": 1.5},
            "_replacement_subtitle_removal_provider": remove_subtitles,
            "_replacement_workflow_provider": workflow_provider,
        },
        _context("subtitle-removal", "replace_model"),
    )

    preprocess = result["subject_preprocess"]
    assert preprocess["subtitle_detected"] is True
    assert preprocess["subtitle_removed"] is True
    assert workflow_inputs == [preprocess["video_for_upload"]]
    assert Path(workflow_inputs[0]).read_bytes() == b"clean-video"
    assert result["runninghub_task_ids"] == ["rh-replace"]
