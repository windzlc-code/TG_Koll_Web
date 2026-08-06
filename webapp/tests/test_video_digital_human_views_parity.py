from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core.digital_human_views import (
    is_non_retryable_digital_human_view_error,
    run_digital_human_view_images_parallel,
)


def _context(
    *,
    cancel_event: threading.Event | None = None,
    progress_events: list[dict] | None = None,
) -> VideoTaskContext:
    return VideoTaskContext(
        task_id="task-views",
        task_type="create_video",
        cancel_event=cancel_event,
        progress_callback=(progress_events.append if progress_events is not None else None),
    )


def test_parallel_views_return_index_order_and_attempts() -> None:
    active = 0
    peak_active = 0
    lock = threading.Lock()
    release = threading.Event()

    def generate(index: int, attempt: int, attempt_task_id: str) -> Path:
        nonlocal active, peak_active
        assert attempt == 1
        assert attempt_task_id == f"task-views_fusion_{index}_try1"
        with lock:
            active += 1
            peak_active = max(peak_active, active)
            if peak_active >= 2:
                release.set()
        assert release.wait(1)
        time.sleep(0.01 * (4 - index))
        with lock:
            active -= 1
        return Path(f"view-{index}.png")

    results, attempts = run_digital_human_view_images_parallel(
        view_indexes=[4, 2, 3],
        generate_one=generate,
        late_output=lambda _task_id, _exc: None,
        context=_context(),
        max_workers=3,
        task_suffix="fusion",
    )

    assert peak_active >= 2
    assert results == [Path("view-2.png"), Path("view-3.png"), Path("view-4.png")]
    assert attempts == {2: 1, 3: 1, 4: 1}


def test_retry_and_late_output_match_original_order(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: dict[int, int] = {}
    late_calls: list[tuple[str, str]] = []
    monkeypatch.setattr("video_core.digital_human_views.time.sleep", lambda _seconds: None)

    def generate(index: int, attempt: int, _attempt_task_id: str) -> str:
        calls[index] = calls.get(index, 0) + 1
        if index == 2 and attempt < 3:
            raise RuntimeError("temporary failure")
        if index == 3:
            raise RuntimeError("provider timed out")
        return f"view-{index}-attempt-{attempt}"

    def late_output(attempt_task_id: str, exc: Exception) -> str | None:
        late_calls.append((attempt_task_id, str(exc)))
        if "_3_try1" in attempt_task_id:
            return "late-view-3"
        return None

    results, attempts = run_digital_human_view_images_parallel(
        view_indexes=[2, 3],
        generate_one=generate,
        late_output=late_output,
        context=_context(),
        max_workers=2,
        retries=2,
    )

    assert results == ["view-2-attempt-3", "late-view-3"]
    assert attempts == {2: 3, 3: 1}
    assert calls == {2: 3, 3: 1}
    assert len(late_calls) == 3


@pytest.mark.parametrize(
    "message",
    [
        "缺少闭源图像模型 Base URL",
        "缺少闭源图像模型 API Key",
        "缺少商品图",
        "商品图不存在",
        "模特图不存在",
        "需要上传模特图",
        "图片生成需要填写提示词",
    ],
)
def test_original_permanent_errors_are_non_retryable(message: str) -> None:
    assert is_non_retryable_digital_human_view_error(RuntimeError(message)) is True


def test_non_retryable_error_stops_after_first_attempt() -> None:
    calls = 0

    def generate(_index: int, _attempt: int, _task_id: str) -> str:
        nonlocal calls
        calls += 1
        raise RuntimeError("商品图不存在")

    with pytest.raises(RuntimeError, match="视角图 2 生成失败"):
        run_digital_human_view_images_parallel(
            view_indexes=[2],
            generate_one=generate,
            late_output=lambda _task_id, _exc: None,
            context=_context(),
            retries=2,
        )

    assert calls == 1


def test_retry_count_is_capped_at_three_total_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0
    monkeypatch.setattr("video_core.digital_human_views.time.sleep", lambda _seconds: None)

    def generate(_index: int, _attempt: int, _task_id: str) -> str:
        nonlocal calls
        calls += 1
        raise RuntimeError("temporary failure")

    with pytest.raises(RuntimeError, match="已自动重试 2 次仍失败"):
        run_digital_human_view_images_parallel(
            view_indexes=[2],
            generate_one=generate,
            late_output=lambda _task_id, _exc: None,
            context=_context(),
            retries=99,
        )

    assert calls == 3


def test_parallel_failure_message_keeps_the_correct_view_index() -> None:
    def generate(index: int, _attempt: int, _task_id: str) -> str:
        if index == 4:
            raise RuntimeError("商品图不存在")
        time.sleep(0.02)
        return f"view-{index}"

    with pytest.raises(RuntimeError, match="视角图 4 生成失败") as caught:
        run_digital_human_view_images_parallel(
            view_indexes=[2, 4],
            generate_one=generate,
            late_output=lambda _task_id, _exc: None,
            context=_context(),
            max_workers=2,
        )

    assert "视角图 2 生成失败" not in str(caught.value)


def test_late_output_is_checked_before_permanent_error_is_rejected() -> None:
    results, attempts = run_digital_human_view_images_parallel(
        view_indexes=[2],
        generate_one=lambda _index, _attempt, _task_id: (_ for _ in ()).throw(
            RuntimeError("商品图不存在")
        ),
        late_output=lambda _task_id, _exc: "late-view",
        context=_context(),
    )

    assert results == ["late-view"]
    assert attempts == {2: 1}


def test_cancellation_is_not_converted_to_retry_or_late_output() -> None:
    cancel_event = threading.Event()
    late_calls = 0

    def generate(_index: int, _attempt: int, _task_id: str) -> str:
        cancel_event.set()
        raise VideoTaskCancelled("cancelled by test")

    def late_output(_task_id: str, _exc: Exception) -> None:
        nonlocal late_calls
        late_calls += 1
        return None

    with pytest.raises(VideoTaskCancelled):
        run_digital_human_view_images_parallel(
            view_indexes=[2],
            generate_one=generate,
            late_output=late_output,
            context=_context(cancel_event=cancel_event),
        )

    assert late_calls == 0


def test_progress_uses_requested_range() -> None:
    events: list[dict] = []

    results, attempts = run_digital_human_view_images_parallel(
        view_indexes=[2],
        generate_one=lambda index, _attempt, _task_id: f"view-{index}",
        late_output=lambda _task_id, _exc: None,
        context=_context(progress_events=events),
        progress=(31, 47),
        stage_message="生成补充视角",
    )

    assert results == ["view-2"]
    assert attempts == {2: 1}
    assert [event["progress"] for event in events] == [31, 47]
    assert events[0]["data"]["stage"] == "digital_human_image_fusion"
    assert "失败会自动重试 2 次" in events[0]["status"]
    assert "1 张视角图已生成" in events[1]["status"]


def test_duplicate_view_indexes_are_rejected() -> None:
    with pytest.raises(ValueError, match="must be unique"):
        run_digital_human_view_images_parallel(
            view_indexes=[2, 2],
            generate_one=lambda _index, _attempt, _task_id: "unused",
            late_output=lambda _task_id, _exc: None,
            context=_context(),
        )
