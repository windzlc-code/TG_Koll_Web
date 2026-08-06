from __future__ import annotations

import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core.replacement_pipeline import run_replacement_pipeline
from webapp.video_workbench import video_billing_actual_quantity


class WorkdirBackend:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _workdir(self, task_id: str, payload: dict) -> Path:
        path = self.root / task_id
        path.mkdir(parents=True, exist_ok=True)
        return path


def _inputs(tmp_path: Path) -> tuple[Path, Path, Path]:
    video = tmp_path / "source.mp4"
    model = tmp_path / "model.png"
    product = tmp_path / "product.png"
    video.write_bytes(b"video")
    model.write_bytes(b"model")
    product.write_bytes(b"product")
    return video, model, product


def _run(
    tmp_path: Path,
    task_type: str,
    *,
    extra_payload: dict | None = None,
    cancel_event: threading.Event | None = None,
    backend: WorkdirBackend | None = None,
) -> tuple[dict, list[dict]]:
    video, model, product = _inputs(tmp_path)
    provider_payloads: list[dict] = []

    def workflow_provider(**values):
        provider_payloads.append(dict(values["payload"]))
        output = Path(values["output_path"])
        output.write_bytes(b"replacement")
        return {
            "status": "success",
            "runninghub_task_id": f"rh-{values['subject']}",
            "download_path": str(output),
        }

    payload = {
        "video_local_path": str(video),
        "model_image_local_path": str(model),
        "product_image_local_path": str(product),
        "replace_model_original_workflow_ids": ["model-app"],
        "replace_product_workflow_ids": ["product-app"],
        "model_workflow_chain_ids": ["model-app"],
        "product_workflow_chain_ids": ["product-app"],
        "_replacement_workflow_provider": workflow_provider,
    }
    payload.update(extra_payload or {})
    result = run_replacement_pipeline(
        backend or WorkdirBackend(tmp_path / "work"),
        task_type,
        f"duration-{task_type}",
        payload,
        VideoTaskContext(
            task_id=f"duration-{task_type}",
            task_type=task_type,
            cancel_event=cancel_event,
        ),
    )
    return result, provider_payloads


@pytest.mark.parametrize(
    "task_type",
    ["replace_model", "replace_product", "replace_productANDmodel"],
)
def test_missing_duration_uses_source_video_probe_for_result_and_workflows(
    tmp_path: Path,
    task_type: str,
) -> None:
    probe_calls: list[Path] = []

    def duration_probe(*, path: Path, **_values) -> float:
        probe_calls.append(path)
        return 12.25

    result, provider_payloads = _run(
        tmp_path,
        task_type,
        extra_payload={"_replacement_duration_probe": duration_probe},
    )

    assert probe_calls == [(tmp_path / "source.mp4").resolve()]
    assert result["duration_seconds"] == 13
    assert result["source_video_duration_seconds"] == pytest.approx(12.25)
    assert result["duration_source"] == "source_video"
    assert provider_payloads
    assert {payload["duration_seconds"] for payload in provider_payloads} == {13}
    if task_type in {"replace_model", "replace_product"}:
        assert video_billing_actual_quantity(task_type, result, {}) == 13


def test_explicit_duration_wins_without_probing(tmp_path: Path) -> None:
    def unexpected_probe(**_values) -> float:
        raise AssertionError("explicit duration must not probe the source video")

    result, provider_payloads = _run(
        tmp_path,
        "replace_model",
        extra_payload={
            "duration_seconds": 7,
            "_replacement_duration_probe": unexpected_probe,
        },
    )

    assert result["duration_seconds"] == 7
    assert result["duration_source"] == "payload"
    assert provider_payloads[0]["duration_seconds"] == 7


def test_missing_probe_support_uses_original_safe_fallback(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("video_core.replacement_pipeline.shutil.which", lambda _name: None)

    result, provider_payloads = _run(tmp_path, "replace_product")

    assert result["duration_seconds"] == 20
    assert "source_video_duration_seconds" not in result
    assert result["raw_result"]["source_video_duration_seconds"] == 0
    assert result["duration_source"] == "fallback"
    assert provider_payloads[0]["duration_seconds"] == 20
    assert video_billing_actual_quantity("replace_product", result, {}) == 20


def test_existing_backend_media_probe_is_reused(tmp_path: Path) -> None:
    class ProbingBackend(WorkdirBackend):
        def __init__(self, root: Path) -> None:
            super().__init__(root)
            self.probed: list[Path] = []

        def _probe_duration(self, path: Path, payload: dict) -> float:
            self.probed.append(path)
            assert "duration_seconds" not in payload
            return 4.2

    backend = ProbingBackend(tmp_path / "work")
    result, provider_payloads = _run(
        tmp_path,
        "replace_model",
        backend=backend,
    )

    assert backend.probed == [(tmp_path / "source.mp4").resolve()]
    assert result["source_video_duration_seconds"] == pytest.approx(4.2)
    assert result["duration_seconds"] == 5
    assert provider_payloads[0]["duration_seconds"] == 5


def test_local_source_is_probed_when_remote_video_url_is_also_present(tmp_path: Path) -> None:
    probe_calls: list[Path] = []

    result, _provider_payloads = _run(
        tmp_path,
        "replace_product",
        extra_payload={
            "video_url": "https://media.invalid/source.mp4",
            "_replacement_duration_probe": lambda *, path, **_values: probe_calls.append(path) or 6.4,
        },
    )

    assert probe_calls == [(tmp_path / "source.mp4").resolve()]
    assert result["duration_seconds"] == 7
    assert result["source_video_duration_seconds"] == pytest.approx(6.4)


def test_local_ffprobe_is_used_when_backend_has_no_probe(tmp_path: Path, monkeypatch) -> None:
    commands: list[list[str]] = []
    monkeypatch.setattr("video_core.replacement_pipeline.shutil.which", lambda name: "C:/tools/ffprobe.exe" if name == "ffprobe" else None)

    def fake_run(command, **kwargs):
        commands.append(command)
        assert kwargs["timeout"] == 30
        return SimpleNamespace(returncode=0, stdout="7.01\n", stderr="")

    monkeypatch.setattr("video_core.replacement_pipeline.subprocess.run", fake_run)
    result, provider_payloads = _run(tmp_path, "replace_product")

    assert commands == [[
        "C:/tools/ffprobe.exe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str((tmp_path / "source.mp4").resolve()),
    ]]
    assert result["source_video_duration_seconds"] == pytest.approx(7.01)
    assert result["duration_seconds"] == 8
    assert provider_payloads[0]["duration_seconds"] == 8


def test_cancellation_after_duration_probe_stops_before_provider(tmp_path: Path) -> None:
    event = threading.Event()

    def duration_probe(**_values) -> float:
        event.set()
        return 9.5

    with pytest.raises(VideoTaskCancelled):
        _run(
            tmp_path,
            "replace_model",
            extra_payload={"_replacement_duration_probe": duration_probe},
            cancel_event=event,
        )
