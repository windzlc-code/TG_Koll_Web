from __future__ import annotations

import concurrent.futures
import time
from collections.abc import Callable, Iterable, Sequence
from typing import TypeVar

from .contracts import VideoTaskCancelled, VideoTaskContext


ViewResult = TypeVar("ViewResult")
GenerateOne = Callable[[int, int, str], ViewResult]
LateOutput = Callable[[str, Exception], ViewResult | None]


_NON_RETRYABLE_VIEW_ERROR_MARKERS: tuple[str, ...] = (
    "缺少闭源图像模型 Base URL",
    "缺少闭源图像模型 API Key",
    "缺少商品图",
    "商品图不存在",
    "模特图不存在",
    "需要上传模特图",
    "图片生成需要填写提示词",
    "requires a local model reference",
    "requires local model and product references",
    "does not exist",
)


def is_non_retryable_digital_human_view_error(exc: Exception) -> bool:
    """Return whether an original-platform permanent view error must not retry."""

    text = str(exc or "")
    return any(marker in text for marker in _NON_RETRYABLE_VIEW_ERROR_MARKERS)


def _normalize_view_indexes(view_indexes: Iterable[int]) -> list[int]:
    indexes = [int(value) for value in view_indexes]
    if len(indexes) != len(set(indexes)):
        raise ValueError("digital-human view indexes must be unique")
    return sorted(indexes)


def _normalize_progress(
    progress: Sequence[float | int | None] | None,
) -> tuple[float | int | None, float | int | None]:
    if progress is None:
        return 35, 43
    values = list(progress)
    if len(values) != 2:
        raise ValueError("progress must contain start and completion values")
    return values[0], values[1]


def _sleep_with_cancellation(context: VideoTaskContext, seconds: float) -> None:
    deadline = time.monotonic() + max(float(seconds), 0.0)
    while True:
        context.check_cancelled()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 0.05))


def run_digital_human_view_images_parallel(
    *,
    view_indexes: Iterable[int],
    generate_one: GenerateOne[ViewResult],
    late_output: LateOutput[ViewResult],
    context: VideoTaskContext,
    max_workers: int = 3,
    retries: int = 2,
    progress: Sequence[float | int | None] | None = (35, 43),
    task_suffix: str = "view",
    stage_message: str = "生成一致性视角图",
) -> tuple[list[ViewResult], dict[int, int]]:
    """Generate consistent digital-human views with the original retry policy.

    ``generate_one`` receives ``(view_index, attempt, attempt_task_id)``.
    ``late_output`` receives ``(attempt_task_id, error)`` after a failed
    generation attempt and may return a late result.  Results are returned in
    ascending view-index order together with the successful attempt number for
    each view.

    The source platform retries twice (three total attempts).  ``retries`` is
    therefore capped at two even if a larger value is supplied.
    """

    indexes = _normalize_view_indexes(view_indexes)
    start_progress, done_progress = _normalize_progress(progress)
    context.check_cancelled()
    if not indexes:
        return [], {}
    if not callable(generate_one):
        raise TypeError("generate_one must be callable")
    if not callable(late_output):
        raise TypeError("late_output must be callable")

    worker_count = min(len(indexes), max(int(max_workers or 1), 1))
    retry_count = min(max(int(retries or 0), 0), 2)
    max_attempts = retry_count + 1
    suffix = str(task_suffix or "view").strip() or "view"

    context.progress(
        stage="digital_human_image_fusion",
        status="running",
        message=(
            f"{stage_message}：并发生成 {len(indexes)} 张视角图，"
            f"每张失败会自动重试 {retry_count} 次"
        ),
        progress=start_progress,
    )

    def _generate_view(index: int) -> tuple[int, ViewResult, int]:
        last_error = ""
        for attempt in range(1, max_attempts + 1):
            context.check_cancelled()
            attempt_task_id = f"{context.task_id}_{suffix}_{index}_try{attempt}"
            try:
                result = generate_one(index, attempt, attempt_task_id)
                context.check_cancelled()
                return index, result, attempt
            except VideoTaskCancelled:
                raise
            except Exception as exc:
                last_error = str(exc) or exc.__class__.__name__
                context.check_cancelled()
                try:
                    late_result = late_output(attempt_task_id, exc)
                except VideoTaskCancelled:
                    raise
                context.check_cancelled()
                if late_result is not None:
                    return index, late_result, attempt
                if is_non_retryable_digital_human_view_error(exc):
                    raise RuntimeError(f"视角图 {index} 生成失败：{last_error}") from exc
                if attempt >= max_attempts:
                    if retry_count:
                        raise RuntimeError(
                            f"视角图 {index} 已自动重试 {retry_count} 次仍失败：{last_error}"
                        ) from exc
                    raise RuntimeError(f"视角图 {index} 生成失败：{last_error}") from exc
                _sleep_with_cancellation(context, 0.4 * attempt)
        raise RuntimeError(f"视角图 {index} 生成失败：{last_error}")

    results: dict[int, ViewResult] = {}
    attempts: dict[int, int] = {}
    failures: dict[int, str] = {}
    executor = concurrent.futures.ThreadPoolExecutor(
        max_workers=worker_count,
        thread_name_prefix="dh-view",
    )
    future_indexes: dict[
        concurrent.futures.Future[tuple[int, ViewResult, int]], int
    ] = {
        executor.submit(_generate_view, index): index for index in indexes
    }
    pending = set(future_indexes)
    cancelled = False
    try:
        while pending:
            context.check_cancelled()
            completed, pending = concurrent.futures.wait(
                pending,
                timeout=0.05,
                return_when=concurrent.futures.FIRST_COMPLETED,
            )
            for future in completed:
                try:
                    index, result, attempt_count = future.result()
                except VideoTaskCancelled:
                    cancelled = True
                    raise
                except Exception as exc:
                    index = future_indexes[future]
                    failures[index] = str(exc) or f"视角图 {index} 生成失败"
                else:
                    results[index] = result
                    attempts[index] = attempt_count
    except VideoTaskCancelled:
        cancelled = True
        for future in pending:
            future.cancel()
        raise
    finally:
        executor.shutdown(wait=not cancelled, cancel_futures=cancelled)

    if failures:
        joined = "；".join(failures[index] for index in sorted(failures))
        raise RuntimeError(
            f"多分镜一致性视角图生成失败：{joined}。请点击「重新生成」重试。"
        )

    context.check_cancelled()
    context.progress(
        stage="digital_human_image_fusion",
        status="running",
        message=f"{stage_message}：{len(indexes)} 张视角图已生成",
        progress=done_progress,
    )
    return [results[index] for index in indexes], {
        index: attempts[index] for index in indexes
    }
