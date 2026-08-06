from __future__ import annotations

import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from PIL import Image

from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core import digital_human_image_quality as quality


def _fixture_image(tmp_path: Path, name: str = "fusion.png") -> Path:
    path = tmp_path / name
    Image.new("RGB", (320, 240), (72, 116, 154)).save(path)
    return path


def _disable_face_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        quality,
        "_detect_digital_human_face_metrics",
        lambda _path: {"enabled": False, "faces": [], "error": "cv2 unavailable"},
    )


def _llm_response(parsed: dict[str, Any]):
    return {"parsed": parsed}, "offline-visual-qa", [{"provider": "offline"}]


def test_non_real_estate_generation_passes_through_without_qa(
    tmp_path: Path,
) -> None:
    image_path = _fixture_image(tmp_path)
    generation_calls: list[tuple[str, dict[str, Any]]] = []
    llm_calls: list[dict[str, Any]] = []

    def generate(task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        generation_calls.append((task_id, payload))
        return {"image_path": str(image_path), "provider": "local"}

    result = quality.run_digital_human_image_generate_with_quality_gate(
        "task-non-property",
        {
            "prompt": "clean visual prompt",
            "prompt_text": "sales copy must be removed",
            "message": "more copy-only text",
        },
        product_category="apparel",
        generate_image=generate,
        visual_semantic_llm=lambda **kwargs: llm_calls.append(kwargs),
    )

    assert result == {"image_path": str(image_path), "provider": "local"}
    assert len(generation_calls) == 1
    assert generation_calls[0][0] == "task-non-property"
    assert generation_calls[0][1]["prompt"] == "clean visual prompt"
    assert "prompt_text" not in generation_calls[0][1]
    assert "message" not in generation_calls[0][1]
    assert llm_calls == []


def test_real_estate_high_severity_retries_with_source_prompt_suffix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    image_path = _fixture_image(tmp_path)
    _disable_face_gate(monkeypatch)
    generation_calls: list[tuple[str, dict[str, Any]]] = []
    semantic_results = iter(
        [
            {
                "passed": False,
                "issues": ["obvious hard cutout and white edge"],
                "person_integration": "score: 3/10",
                "reason": "人物明显像纸片贴图",
            },
            {"passed": True, "issues": [], "reason": "融合通过"},
        ]
    )

    def generate(task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        generation_calls.append((task_id, payload))
        return {"image_path": str(image_path), "task_id": task_id}

    def visual_semantic_llm(**_kwargs):
        return _llm_response(next(semantic_results))

    result = quality.run_digital_human_image_generate_with_quality_gate(
        "task-property",
        {"prompt": "base real-estate prompt", "real_estate_image_qa_max_attempts": 3},
        product_category="real_estate",
        generate_image=generate,
        visual_semantic_llm=visual_semantic_llm,
    )

    assert [item[0] for item in generation_calls] == [
        "task-property",
        "task-property_qa_retry2",
    ]
    retry_prompt = generation_calls[1][1]["prompt"]
    assert retry_prompt.startswith("base real-estate prompt上一版生成结果不合格：")
    assert "这是第 2 次自动重生成" in retry_prompt
    assert "房产数字人图像人物融合不真实" in retry_prompt
    assert "不得出现任何可读文字" in retry_prompt
    assert result["real_estate_image_qa"]["attempt"] == 2
    assert result["real_estate_image_qa"]["status"] == "passed"


def test_real_estate_quality_gate_returns_first_passing_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    image_path = _fixture_image(tmp_path)
    _disable_face_gate(monkeypatch)
    generation_calls: list[str] = []
    llm_calls: list[dict[str, Any]] = []

    def generate(task_id: str, _payload: dict[str, Any]) -> dict[str, Any]:
        generation_calls.append(task_id)
        return {"download_path": str(image_path), "ok": True}

    def visual_semantic_llm(**kwargs):
        llm_calls.append(kwargs)
        return _llm_response(
            {
                "passed": True,
                "issues": [],
                "person_identity": "same person",
                "scene_fidelity": "same property",
            }
        )

    result = quality.run_digital_human_image_generate_with_quality_gate(
        "task-pass",
        {"prompt": "property visual"},
        product_category="real-estate",
        generate_image=generate,
        visual_semantic_llm=visual_semantic_llm,
    )

    assert generation_calls == ["task-pass"]
    assert result["real_estate_image_qa"]["attempt"] == 1
    assert result["real_estate_image_qa"]["status"] == "passed"
    assert result["real_estate_image_qa"]["issues"] == []
    assert result["real_estate_image_qa"]["metrics"]["visual_semantics"][
        "llm_selected"
    ] == "offline-visual-qa"
    assert llm_calls[0]["request_label"] == "房产数字人图像视觉QA"
    assert llm_calls[0]["image_paths"] == [str(image_path.resolve())]


def test_real_estate_final_failure_keeps_three_attempt_semantics_and_message(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    image_path = _fixture_image(tmp_path)
    _disable_face_gate(monkeypatch)
    generation_calls: list[tuple[str, str]] = []

    def generate(task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        generation_calls.append((task_id, str(payload.get("prompt") or "")))
        return {"image_path": str(image_path)}

    def visual_semantic_llm(**_kwargs):
        return _llm_response(
            {
                "passed": False,
                "issues": ["identity mismatch: different person"],
                "reason": "不是同一个人",
            }
        )

    with pytest.raises(
        RuntimeError,
        match="房产数字人图像生成后 QA 未通过，已自动重试 2 次",
    ) as caught:
        quality.run_digital_human_image_generate_with_quality_gate(
            "task-fail",
            {
                "prompt": "base prompt",
                "real_estate_image_qa_max_attempts": 3,
            },
            product_category="房地产",
            generate_image=generate,
            visual_semantic_llm=visual_semantic_llm,
        )

    assert [item[0] for item in generation_calls] == [
        "task-fail",
        "task-fail_qa_retry2",
        "task-fail_qa_retry3",
    ]
    assert "房产数字人图像人物融合不真实，存在平面贴图/抠图感风险" in str(
        caught.value
    )
    assert "这是第 3 次自动重生成" in generation_calls[2][1]


def test_cancellation_stops_before_qa_or_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    image_path = _fixture_image(tmp_path)
    _disable_face_gate(monkeypatch)
    cancel_event = threading.Event()
    generation_calls: list[str] = []
    llm_calls: list[dict[str, Any]] = []
    context = VideoTaskContext(
        task_id="task-cancel",
        task_type="image_generate",
        cancel_event=cancel_event,
    )

    def generate(task_id: str, _payload: dict[str, Any]) -> dict[str, Any]:
        generation_calls.append(task_id)
        cancel_event.set()
        return {"image_path": str(image_path)}

    with pytest.raises(VideoTaskCancelled, match="video task cancelled: task-cancel"):
        quality.run_digital_human_image_generate_with_quality_gate(
            "task-cancel",
            {"prompt": "property"},
            product_category="real_estate",
            generate_image=generate,
            visual_semantic_llm=lambda **kwargs: llm_calls.append(kwargs),
            context=context,
        )

    assert generation_calls == ["task-cancel"]
    assert llm_calls == []


def test_missing_cv2_and_llm_keep_original_nonfatal_degradation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    image_path = _fixture_image(tmp_path)
    monkeypatch.setitem(sys.modules, "cv2", None)

    result = quality.run_digital_human_image_generate_with_quality_gate(
        "task-degraded",
        {"prompt": "property", "real_estate_image_qa_max_attempts": 3},
        product_category="real_estate",
        generate_image=lambda _task_id, _payload: {"image_path": str(image_path)},
        visual_semantic_llm=None,
    )

    qa = result["real_estate_image_qa"]
    assert qa["attempt"] == 1
    assert qa["status"] == "passed"
    assert qa["issues"] == []
    face_metrics = qa["metrics"]["face_detection"]
    assert face_metrics["enabled"] is False
    assert "cv2" in face_metrics["error"]
    semantic_metrics = qa["metrics"]["visual_semantics"]
    assert semantic_metrics["enabled"] is False
    assert semantic_metrics["error"] == "visual semantic LLM callback is unavailable"


def test_face_metrics_keep_source_sorting_and_thresholds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FakeDetector:
        @staticmethod
        def empty() -> bool:
            return False

        @staticmethod
        def detectMultiScale(*_args, **kwargs):
            assert kwargs == {
                "scaleFactor": 1.05,
                "minNeighbors": 4,
                "minSize": (80, 80),
            }
            return [(10, 20, 100, 100), (30, 40, 120, 250)]

    fake_cv2 = SimpleNamespace(
        imread=lambda _path: SimpleNamespace(shape=(1000, 500, 3)),
        COLOR_BGR2GRAY=7,
        cvtColor=lambda image, code: (image, code),
        data=SimpleNamespace(haarcascades="offline-cascade/"),
        CascadeClassifier=lambda path: (
            FakeDetector()
            if path == "offline-cascade/haarcascade_frontalface_default.xml"
            else None
        ),
    )
    monkeypatch.setitem(sys.modules, "cv2", fake_cv2)

    metrics = quality._detect_digital_human_face_metrics(tmp_path / "unused.png")

    assert metrics["enabled"] is True
    assert metrics["width"] == 500
    assert metrics["height"] == 1000
    assert metrics["max_face_height_pct"] == 25.0
    assert metrics["faces"][0]["area_pct"] == 6.0
    assert metrics["min_required_face_height_pct"] == pytest.approx(
        quality.REAL_ESTATE_DH_MIN_FACE_HEIGHT_PCT
    )


def test_basic_qa_and_semantic_severity_keep_source_thresholds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    white_render = tmp_path / "white-render.png"
    Image.new("RGB", (320, 240), (245, 245, 245)).save(white_render)
    _disable_face_gate(monkeypatch)

    issues, metrics = quality._qa_real_estate_digital_human_image(white_render)

    assert issues[0]["code"] == "real_estate_white_film_background"
    assert issues[0]["severity"] == "high"
    assert metrics["real_estate_regions"]["right_mid_far_background"][
        "mean_luma"
    ] >= 232
    assert quality._real_estate_visual_semantic_issue_severity(
        {"issues": ["score: 4/10"]}
    ) == "high"
    assert quality._real_estate_visual_semantic_issue_severity(
        {"issues": ["slight integration issue"]}
    ) == "medium"
    assert quality._real_estate_visual_semantic_issue_severity(
        {"issues": ["ambiguous failure"]}
    ) == "high"
