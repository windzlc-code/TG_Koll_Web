"""Queue-agnostic video task core used by the webapp adapter."""

from .contracts import (
    VIDEO_TASK_TYPES,
    VideoDependencyError,
    VideoTaskCancelled,
    VideoTaskContext,
    normalize_video_result,
)
from .runner import (
    clear_video_backend,
    configure_video_backend,
    run_video_task,
)
from .source_backend import ArchivedSourceBackend, DEFAULT_SOURCE_BACKEND

__all__ = [
    "VIDEO_TASK_TYPES",
    "VideoDependencyError",
    "VideoTaskCancelled",
    "VideoTaskContext",
    "ArchivedSourceBackend",
    "DEFAULT_SOURCE_BACKEND",
    "clear_video_backend",
    "configure_video_backend",
    "normalize_video_result",
    "run_video_task",
]
