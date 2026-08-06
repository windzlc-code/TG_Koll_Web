from __future__ import annotations

import inspect
import re
import shutil
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any

from .contracts import VideoDependencyError, VideoTaskCancelled, VideoTaskContext
from .digital_human_audio_postprocess import adjust_digital_human_segment_durations
from .digital_human_cover import _maybe_create_digital_human_video_cover
from .digital_human_storyboard import (
    build_digital_human_view_sequence,
    normalize_digital_human_segment_scripts,
)


_DEFAULT_LIPSYNC_PROMPT = "角色面向镜头深情的说话，固定镜头。"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return _text(value).lower() in {"1", "true", "yes", "on", "enabled"}


def _integer(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _unique_text(values: Iterable[Any]) -> list[str]:
    result: list[str] = []
    for value in values:
        item = _text(value)
        if item and item not in result:
            result.append(item)
    return result


def _invoke(callback: Callable[..., Any], **kwargs: Any) -> Any:
    """Call injected providers without forcing them to accept orchestration-only fields."""

    try:
        signature = inspect.signature(callback)
    except (TypeError, ValueError):
        return callback(**kwargs)
    if any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values()):
        return callback(**kwargs)
    accepted = {name: value for name, value in kwargs.items() if name in signature.parameters}
    return callback(**accepted)


def _provider(
    backend: Any,
    payload: Mapping[str, Any],
    payload_names: Iterable[str],
    backend_names: Iterable[str],
) -> Callable[..., Any] | None:
    for name in payload_names:
        candidate = payload.get(name)
        if callable(candidate):
            return candidate
    for name in backend_names:
        candidate = getattr(backend, name, None)
        if callable(candidate):
            return candidate
    return None


def _reference_values(payload: Mapping[str, Any], kind: str) -> list[str]:
    values: list[Any] = []
    for suffix in ("local_paths", "urls"):
        raw = payload.get(f"{kind}_image_{suffix}")
        if isinstance(raw, (list, tuple)):
            values.extend(raw)
    for suffix in ("local_path", "url"):
        values.append(payload.get(f"{kind}_image_{suffix}"))
    if kind == "model":
        values.extend((payload.get("image_local_path"), payload.get("image_url")))
    return _unique_text(values)


def _validate_local_references(values: Iterable[str], label: str) -> None:
    for value in values:
        if value.lower().startswith(("http://", "https://")):
            continue
        path = Path(value).expanduser()
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"{label} reference does not exist: {path}")


def _storyboard_items(value: Any) -> list[Any]:
    if isinstance(value, dict):
        for key in ("items", "segments", "shots", "storyboard"):
            if isinstance(value.get(key), list):
                return list(value[key])
        return []
    return list(value) if isinstance(value, (list, tuple)) else []


def _storyboard_text(item: Any) -> str:
    if isinstance(item, dict):
        for key in ("speech_text", "dialogue", "script", "text", "copy", "narration"):
            value = _text(item.get(key))
            if value:
                return value
        return ""
    return _text(item)


def _storyboard_prompt(item: Any) -> str:
    if isinstance(item, dict):
        for key in ("visual_prompt", "prompt", "shot", "description", "scene"):
            value = _text(item.get(key))
            if value:
                return value
    return ""


def _split_script(text: str, count: int) -> list[str]:
    clean = _text(text)
    count = max(int(count or 1), 1)
    if count == 1:
        return [clean] if clean else []
    sentences = [item.strip() for item in re.split(r"(?<=[。！？!?；;\.])\s*|\n+", clean) if item.strip()]
    if not sentences:
        return []
    if len(sentences) == count:
        return sentences
    if len(sentences) < count:
        # The archived platform guarantees the requested storyboard count. Keep
        # empty expansion deterministic by splitting the longest available text.
        characters = list(clean)
        if len(characters) >= count:
            boundaries = [round(index * len(characters) / count) for index in range(count + 1)]
            return ["".join(characters[boundaries[index] : boundaries[index + 1]]).strip() for index in range(count)]
        return sentences + [sentences[-1]] * (count - len(sentences))
    boundaries = [round(index * len(sentences) / count) for index in range(count + 1)]
    return ["".join(sentences[boundaries[index] : boundaries[index + 1]]).strip() for index in range(count)]


def _result_paths(value: Any) -> list[str]:
    if isinstance(value, (str, Path)):
        return [_text(value)]
    if isinstance(value, (list, tuple)):
        return _unique_text(value)
    if not isinstance(value, dict):
        return []
    candidates: list[Any] = []
    for key in ("paths", "fusion_images", "image_paths", "output_paths"):
        raw = value.get(key)
        if isinstance(raw, (list, tuple)):
            candidates.extend(raw)
    candidates.extend((value.get("path"), value.get("image_path"), value.get("output_path")))
    return _unique_text(candidates)


def _task_ids(value: Any) -> list[str]:
    if not isinstance(value, dict):
        return []
    candidates: list[Any] = []
    for key in ("runninghub_task_ids", "provider_task_ids", "task_ids"):
        raw = value.get(key)
        if isinstance(raw, (list, tuple)):
            candidates.extend(raw)
    candidates.extend(
        (
            value.get("runninghub_task_id"),
            value.get("provider_task_id"),
            value.get("task_id"),
            value.get("taskId"),
            value.get("task id"),
        )
    )
    return _unique_text(candidates)


def _video_path(value: Any, fallback: Path) -> Path:
    if isinstance(value, (str, Path)):
        raw = _text(value)
    elif isinstance(value, dict):
        raw = _text(
            value.get("video_path")
            or value.get("download_path")
            or value.get("output_path")
            or value.get("path")
        )
    else:
        raw = ""
    return Path(raw).expanduser().resolve() if raw else fallback.resolve()


def _workdir(backend: Any, task_id: str, payload: dict[str, Any]) -> Path:
    factory = getattr(backend, "_workdir", None)
    if callable(factory):
        path = Path(_invoke(factory, task_id=str(task_id), payload=payload)).expanduser().resolve()
    else:
        configured = _text(payload.get("output_dir") or payload.get("workdir"))
        path = Path(configured).expanduser().resolve() if configured else (Path("webapp_data") / "task_runs" / str(task_id)).resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def _completed_segments(payload: Mapping[str, Any], segment_count: int) -> dict[int, dict[str, Any]]:
    source: Any = payload.get("completed_segments")
    checkpoint = payload.get("resume_checkpoint") if isinstance(payload.get("resume_checkpoint"), dict) else {}
    checkpoint_raw = checkpoint.get("raw_result") if isinstance(checkpoint.get("raw_result"), dict) else {}
    if source is None:
        source = checkpoint.get("completed_segments") or checkpoint_raw.get("completed_segments")
    result: dict[int, dict[str, Any]] = {}
    if source is not None and not isinstance(source, (list, tuple)):
        raise ValueError("completed_segments must be a list")
    for offset, item in enumerate(source or (), start=1):
        if not isinstance(item, dict):
            continue
        index = _integer(item.get("segment_index") or item.get("index"), offset)
        path = _video_path(item, Path(""))
        if not (1 <= index <= segment_count) or not path.exists() or not path.is_file():
            continue
        result[index] = {
            "video_path": str(path),
            "provider_task_ids": _task_ids(item),
            "duration_seconds": max(_float(item.get("duration_seconds") or item.get("duration"), 0.0), 0.0),
        }

    raw_paths = payload.get("segment_video_paths")
    if not isinstance(raw_paths, (list, tuple)):
        raw_paths = checkpoint.get("segment_video_paths") or checkpoint_raw.get("segment_video_paths")
    raw_task_ids = checkpoint.get("segment_provider_task_ids") or checkpoint_raw.get("segment_provider_task_ids")
    raw_task_ids = raw_task_ids if isinstance(raw_task_ids, dict) else {}
    if isinstance(raw_paths, (list, tuple)):
        for index, raw_path in enumerate(raw_paths, start=1):
            if index in result or index > segment_count or not _text(raw_path):
                continue
            path = Path(_text(raw_path)).expanduser().resolve()
            if path.exists() and path.is_file():
                task_ids = raw_task_ids.get(str(index), raw_task_ids.get(index, []))
                if not isinstance(task_ids, (list, tuple)):
                    task_ids = [task_ids]
                result[index] = {
                    "video_path": str(path),
                    "provider_task_ids": _unique_text(task_ids),
                    "duration_seconds": 0.0,
                }
    return result


def _subtitles_enabled(payload: Mapping[str, Any]) -> bool:
    config = payload.get("subtitles") if isinstance(payload.get("subtitles"), dict) else {}
    return _bool(payload.get("subtitle_enabled") or payload.get("burn_subtitles") or config.get("enabled"), False)


def _usage_by_segment(segment_results: Mapping[int, Mapping[str, Any]]) -> dict[str, Any]:
    by_segment: dict[str, Any] = {}
    totals: dict[str, float] = {}
    for index, result in sorted(segment_results.items()):
        usage = result.get("usage") if isinstance(result.get("usage"), dict) else result.get("runninghub_usage")
        if not isinstance(usage, dict):
            continue
        by_segment[str(index)] = dict(usage)
        for key, value in usage.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                totals[key] = totals.get(key, 0.0) + float(value)
    normalized_totals = {key: int(value) if value.is_integer() else value for key, value in totals.items()}
    if by_segment:
        normalized_totals["segments"] = by_segment
    return normalized_totals


def _merge_usage_totals(*values: Any) -> dict[str, Any]:
    totals: dict[str, float] = {}

    def collect(value: Any) -> None:
        if isinstance(value, dict):
            preferred = value.get("runninghub_usage")
            if isinstance(preferred, dict) and preferred:
                collect(preferred)
                return
            preferred = value.get("usage")
            if isinstance(preferred, dict) and preferred:
                collect(preferred)
                return
            for key, item in value.items():
                if key in {"consumeCoins", "consumeMoney", "thirdPartyConsumeMoney"} and isinstance(item, (int, float)) and not isinstance(item, bool):
                    totals[key] = totals.get(key, 0.0) + float(item)
                elif key not in {"segments", "views"}:
                    collect(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                collect(item)

    for value in values:
        collect(value)
    return {key: int(value) if value.is_integer() else value for key, value in totals.items()}


def run_digital_human_pipeline(
    backend: Any,
    task_id: str,
    payload: dict[str, Any] | None,
    context: VideoTaskContext,
) -> dict[str, Any]:
    """Run the archived digital-human orchestration with injectable paid providers.

    The function owns orchestration only. Image fusion, per-segment generation,
    multi-segment concatenation, AI copy, and subtitle rendering are resolved
    from private payload callbacks first and backend adapter methods second.
    This keeps provider calls mockable while preserving the archived platform's
    partial-result, resume, and one-segment regeneration semantics.
    """

    request = dict(payload or {})
    context.check_cancelled()
    workdir = _workdir(backend, str(task_id), request)
    segment_dir = workdir / "digital_human_short_out" / "videos"
    segment_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_callback = request.get("_checkpoint_video_progress")

    def checkpoint_stage(stage: str, **changes: Any) -> None:
        if not callable(checkpoint_callback):
            return
        _invoke(
            checkpoint_callback,
            task_id=str(task_id),
            stage=stage,
            **changes,
        )

    resume_checkpoint = request.get("resume_checkpoint") if isinstance(request.get("resume_checkpoint"), dict) else {}
    resume_raw = resume_checkpoint.get("raw_result") if isinstance(resume_checkpoint.get("raw_result"), dict) else {}

    model_references = _reference_values(request, "model")
    product_references = _reference_values(request, "product")
    if not model_references:
        raise ValueError("digital human video requires at least one model reference")
    if not product_references:
        raise ValueError("digital human video requires at least one product reference")
    _validate_local_references(model_references, "model")
    _validate_local_references(product_references, "product")
    dual_presenter = _bool(request.get("dual_model_dialogue"), False) or len(model_references) >= 2

    mode = _text(request.get("digital_human_short_mode") or "single").lower()
    if mode not in {"single", "storyboard"}:
        mode = "single"
    storyboard = _storyboard_items(request.get("storyboard"))

    checkpoint_speech_text = _text(resume_checkpoint.get("speech_text") or resume_raw.get("speech_text"))
    speech_text = _text(
        checkpoint_speech_text
        or request.get("speech_text")
        or request.get("script")
        or request.get("copy_text")
        or request.get("message")
    )
    checkpoint_ai_meta = resume_checkpoint.get("ai_copy") or resume_raw.get("ai_copy")
    ai_meta: dict[str, Any] = dict(checkpoint_ai_meta) if isinstance(checkpoint_ai_meta, dict) else {}
    checkpoint_segments = resume_checkpoint.get("segment_scripts") or resume_raw.get("segment_scripts")
    ai_segments = [_text(item) for item in checkpoint_segments if _text(item)] if isinstance(checkpoint_segments, (list, tuple)) else []
    generated_ai_copy = False
    if not speech_text:
        if not (_bool(request.get("use_ai_script"), False) or _bool(request.get("use_ai_copy"), False)):
            raise ValueError("digital human video requires speech_text or use_ai_copy")
        ai_provider = _provider(
            backend,
            request,
            ("_digital_human_ai_copy_provider", "_video_ai_copy_provider"),
            ("generate_digital_human_copy", "_generate_digital_human_copy"),
        )
        if ai_provider is None:
            raise VideoDependencyError("digital human AI copy provider is not configured")
        context.progress(stage="digital_human_script", status="running", message="Generating digital-human script", progress=10)
        ai_result = _invoke(
            ai_provider,
            task_id=str(task_id),
            payload=request,
            context=context,
            model_references=model_references,
            product_references=product_references,
            storyboard=storyboard,
            mode=mode,
            dual_presenter=dual_presenter,
        )
        if isinstance(ai_result, dict):
            speech_text = _text(
                ai_result.get("speech_text")
                or ai_result.get("script")
                or ai_result.get("copy_text")
                or ai_result.get("message")
                or ai_result.get("text")
            )
            raw_ai_segments = ai_result.get("segment_scripts")
            if isinstance(raw_ai_segments, (list, tuple)):
                ai_segments = [_text(item) for item in raw_ai_segments if _text(item)]
            metadata = ai_result.get("metadata") or ai_result.get("ai_copy")
            if isinstance(metadata, dict):
                ai_meta = dict(metadata)
            else:
                ai_meta = {
                    key: value
                    for key, value in ai_result.items()
                    if key not in {"speech_text", "script", "copy_text", "message", "text", "segment_scripts"}
                }
            if isinstance(ai_result.get("speech_candidates"), list):
                ai_meta["speech_candidates"] = list(ai_result["speech_candidates"])
                ai_meta["selected_candidate_index"] = _integer(
                    ai_result.get("selected_speech_candidate_index"), 0
                )
        else:
            speech_text = _text(ai_result)
        if not speech_text:
            raise RuntimeError("digital human AI copy provider returned an empty script")
        generated_ai_copy = True
    context.progress(stage="digital_human_script", status="success", message="Digital-human script ready", progress=20)
    checkpoint_script_segments = normalize_digital_human_segment_scripts(
        speech_text,
        mode=mode,
        segment_scripts=(list(ai_segments) or None),
        storyboard=storyboard,
        max_segment_seconds=request.get("digital_human_max_segment_seconds", 20),
        max_segments=request.get("digital_human_max_segments", 8),
    )
    if generated_ai_copy:
        checkpoint_stage(
            "digital_human_script",
            speech_text=speech_text,
            segment_scripts=checkpoint_script_segments,
            ai_copy=ai_meta,
            message="Digital-human script ready",
        )

    explicit_fusion_paths = request.get("digital_human_fusion_image_paths")
    raw_fusion_paths = explicit_fusion_paths or resume_checkpoint.get("fusion_images") or resume_raw.get("fusion_images")
    if isinstance(raw_fusion_paths, (str, Path)):
        raw_fusion_paths = [raw_fusion_paths]
    fusion_paths = _unique_text(raw_fusion_paths or ())
    fusion_task_ids = _unique_text(
        [
            *(resume_checkpoint.get("runninghub_task_ids") or []),
            resume_checkpoint.get("runninghub_task_id"),
        ]
    )
    fusion_results: list[dict[str, Any]] = []
    desired_fusion_count = min(
        max(_integer(request.get("digital_human_fusion_count"), 0) or (4 if mode == "storyboard" else 1), 1),
        4,
    )
    main_provider = _provider(
        backend,
        request,
        ("_digital_human_fusion_main_provider",),
        ("generate_digital_human_fusion_main", "_generate_digital_human_fusion_main"),
    )
    views_provider = _provider(
        backend,
        request,
        ("_digital_human_consistency_views_provider",),
        ("generate_digital_human_consistency_views", "_generate_digital_human_consistency_views"),
    )
    single_view_provider = _provider(
        backend,
        request,
        ("_digital_human_single_consistency_view_provider",),
        ("generate_digital_human_single_consistency_view", "_generate_digital_human_single_consistency_view"),
    )
    combined_provider = _provider(
        backend,
        request,
        ("_digital_human_fusion_provider", "_video_image_fusion_provider"),
        ("generate_digital_human_fusion_views", "_generate_digital_human_fusion_views"),
    )
    combined_provider_used = False
    context.progress(stage="digital_human_image_fusion", status="running", message="Generating presenter/product views", progress=30)
    if not fusion_paths and main_provider is not None:
        main_result = _invoke(
            main_provider,
            task_id=str(task_id),
            payload=request,
            context=context,
            workdir=workdir,
            speech_text=speech_text,
            storyboard=storyboard,
            mode=mode,
            model_references=model_references,
            product_references=product_references,
            dual_presenter=dual_presenter,
        )
        main_paths = _result_paths(main_result)
        if not main_paths:
            raise RuntimeError("digital human fusion main provider returned no image")
        fusion_paths = [main_paths[0]]
        normalized_main = dict(main_result) if isinstance(main_result, dict) else {"image_path": main_paths[0]}
        fusion_results.append(normalized_main)
        fusion_task_ids = _unique_text([*fusion_task_ids, *_task_ids(normalized_main)])
        checkpoint_stage(
            "digital_human_fusion_main",
            fusion_images=list(fusion_paths),
            runninghub_task_id=fusion_task_ids[-1] if fusion_task_ids else "",
            runninghub_task_ids=fusion_task_ids,
            message="Digital-human fusion main image ready",
        )
    if fusion_paths and len(fusion_paths) < desired_fusion_count and views_provider is not None:
        views_payload = {
            **request,
            "_digital_human_fusion_runninghub_task_ids": list(fusion_task_ids),
        }
        views_result = _invoke(
            views_provider,
            task_id=str(task_id),
            payload=views_payload,
            context=context,
            workdir=workdir,
            main_image_path=fusion_paths[0],
            speech_text=speech_text,
            storyboard=storyboard,
            mode=mode,
            model_references=model_references,
            product_references=product_references,
            existing_fusion_images=fusion_paths,
            dual_presenter=dual_presenter,
        )
        generated_paths = _result_paths(views_result)
        if generated_paths:
            fusion_paths = generated_paths
        normalized_views = dict(views_result) if isinstance(views_result, dict) else {"image_paths": generated_paths}
        fusion_results.append(normalized_views)
        fusion_task_ids = _unique_text([*fusion_task_ids, *_task_ids(normalized_views)])
    if not fusion_paths and combined_provider is not None:
        combined_provider_used = True
        fusion_result = _invoke(
            combined_provider,
            task_id=str(task_id),
            payload=request,
            context=context,
            workdir=workdir,
            speech_text=speech_text,
            storyboard=storyboard,
            mode=mode,
            model_references=model_references,
            product_references=product_references,
            dual_presenter=dual_presenter,
        )
        fusion_paths = _result_paths(fusion_result)
        normalized_fusion = dict(fusion_result) if isinstance(fusion_result, dict) else {"image_paths": fusion_paths}
        fusion_results.append(normalized_fusion)
        fusion_task_ids = _unique_text([*fusion_task_ids, *_task_ids(normalized_fusion)])
    if not fusion_paths:
        raise VideoDependencyError("digital human image-fusion provider is not configured")

    regenerate_view_index = max(_integer(request.get("digital_human_regenerate_view_index"), 0), 0)
    if regenerate_view_index:
        if regenerate_view_index < 2 or regenerate_view_index > desired_fusion_count:
            raise ValueError(f"digital_human_regenerate_view_index must be between 2 and {desired_fusion_count}")
        if single_view_provider is None:
            raise VideoDependencyError("digital human single consistency-view provider is not configured")
        regenerated = _invoke(
            single_view_provider,
            task_id=str(task_id),
            payload=request,
            context=context,
            workdir=workdir,
            main_image_path=fusion_paths[0],
            view_index=regenerate_view_index,
            speech_text=speech_text,
            storyboard=storyboard,
            mode=mode,
            model_references=model_references,
            product_references=product_references,
            dual_presenter=dual_presenter,
        )
        regenerated_paths = _result_paths(regenerated)
        if not regenerated_paths:
            raise RuntimeError(f"digital human consistency view {regenerate_view_index} returned no image")
        while len(fusion_paths) < regenerate_view_index:
            fusion_paths.append("")
        fusion_paths[regenerate_view_index - 1] = regenerated_paths[0]
        normalized_regenerated = dict(regenerated) if isinstance(regenerated, dict) else {"image_path": regenerated_paths[0]}
        fusion_results.append(normalized_regenerated)
        fusion_task_ids = _unique_text([*fusion_task_ids, *_task_ids(normalized_regenerated)])
    if len(fusion_paths) < desired_fusion_count and explicit_fusion_paths is None and not combined_provider_used:
        raise RuntimeError(
            f"digital human image fusion returned {len(fusion_paths)} of {desired_fusion_count} required views"
        )
    if not fusion_paths:
        raise RuntimeError("digital human image fusion returned no views")
    _validate_local_references(fusion_paths, "fusion view")
    if explicit_fusion_paths is None or regenerate_view_index:
        checkpoint_stage(
            "digital_human_fusion_views",
            fusion_images=list(fusion_paths),
            runninghub_task_id=fusion_task_ids[-1] if fusion_task_ids else "",
            runninghub_task_ids=fusion_task_ids,
            message=f"Digital-human fusion views ready: {len(fusion_paths)}",
        )
    context.progress(stage="digital_human_image_fusion", status="success", message="Presenter/product views ready", progress=45)

    operation = _text(request.get("digital_human_operation") or "final_video").lower()
    if operation == "visual_review":
        fusion_usage = _merge_usage_totals(fusion_results)
        checkpoint_output = {
            "version": 1,
            "task_type": "create_video",
            "stage": "digital_human_visual_review",
            "recoverable": True,
            "fusion_images": list(fusion_paths),
            "speech_text": speech_text,
            "segment_scripts": list(checkpoint_script_segments),
            "runninghub_task_id": fusion_task_ids[-1] if fusion_task_ids else "",
            "runninghub_task_ids": list(fusion_task_ids),
        }
        context.progress(
            stage="digital_human_visual_review",
            status="success",
            message="Digital-human visual references are ready for confirmation",
            progress=100,
        )
        return {
            "ok": True,
            "status": "success",
            "message": "Digital-human visual references are ready for confirmation",
            "video_path": "",
            "download_path": fusion_paths[0],
            "image_path": fusion_paths[0],
            "image_paths": list(fusion_paths),
            "fusion_images": list(fusion_paths),
            "speech_text": speech_text,
            "segment_scripts": list(checkpoint_script_segments),
            "runninghub_task_id": fusion_task_ids[-1] if fusion_task_ids else "",
            "runninghub_task_ids": list(fusion_task_ids),
            "runninghub_usage": fusion_usage,
            "duration_seconds": 0,
            "audio_duration_seconds": 0,
            "video_checkpoint": checkpoint_output,
            "raw_result": {
                "digital_human_stage": "visual_review",
                "digital_human_short_mode": mode,
                "fusion_images": list(fusion_paths),
                "model_references": model_references,
                "product_references": product_references,
                "dual_model_dialogue": dual_presenter,
            },
        }

    explicit_scripts = checkpoint_segments if isinstance(checkpoint_segments, (list, tuple)) else request.get("segment_scripts")
    segment_scripts = normalize_digital_human_segment_scripts(
        speech_text,
        mode=mode,
        segment_scripts=(list(explicit_scripts) if isinstance(explicit_scripts, (list, tuple)) else (ai_segments or None)),
        storyboard=storyboard,
        max_segment_seconds=request.get("digital_human_max_segment_seconds", 20),
        max_segments=request.get("digital_human_max_segments", 8),
    )
    if not segment_scripts:
        raise ValueError("digital human storyboard contains no script segments")
    segment_count = len(segment_scripts)

    # The archived lip-sync workflow deliberately ignores visual/storyboard
    # prompts here. Complex motion prompts destabilize identity and mouth sync.
    prompt_segments = [_DEFAULT_LIPSYNC_PROMPT] * segment_count

    raw_sequence = request.get("view_sequence")
    if isinstance(raw_sequence, (list, tuple)) and len(raw_sequence) >= segment_count:
        parsed_sequence = [_integer(item, 1) for item in raw_sequence[:segment_count]]
        sequence = [max(item, 0) for item in parsed_sequence] if 0 in parsed_sequence else [max(item - 1, 0) for item in parsed_sequence]
        sequence = [min(item, len(fusion_paths) - 1) for item in sequence]
    else:
        sequence = build_digital_human_view_sequence(
            request,
            segment_scripts,
            fusion_paths,
            task_id=str(task_id),
            product_category=request.get("product_category") or request.get("category"),
            mode=mode,
            analyze_scene_markers=(
                request.get("_digital_human_scene_marker_llm")
                if callable(request.get("_digital_human_scene_marker_llm"))
                else None
            ),
            check_cancelled=context.check_cancelled,
        )
    context.progress(
        stage="digital_human_plan",
        status="success",
        message=f"Digital-human plan ready: {segment_count} segments",
        progress=55,
    )

    completed = _completed_segments(request, segment_count)
    configured_regenerate_index = _integer(request.get("digital_human_regenerate_segment_index"), 0)
    api_regenerate_index = _integer(request.get("regenerate_segment_index"), 0)
    regenerate_index = max(configured_regenerate_index or api_regenerate_index, 0)
    if regenerate_index > segment_count:
        raise ValueError(f"digital_human_regenerate_segment_index exceeds segment count {segment_count}")
    if regenerate_index:
        completed.pop(regenerate_index, None)

    segment_paths: dict[int, Path] = {}
    segment_provider_ids: dict[int, list[str]] = {}
    segment_durations: dict[int, float] = {}
    for index, item in sorted(completed.items()):
        source = Path(item["video_path"]).expanduser().resolve()
        destination = (segment_dir / f"{index}.mp4").resolve()
        if source != destination:
            shutil.copy2(source, destination)
        segment_paths[index] = destination
        segment_provider_ids[index] = list(item.get("provider_task_ids") or [])
        segment_durations[index] = max(_float(item.get("duration_seconds"), 0.0), 0.0)

    segment_results: dict[int, dict[str, Any]] = {}
    failures: list[dict[str, Any]] = []
    target_indices = [regenerate_index] if regenerate_index else [index for index in range(1, segment_count + 1) if index not in segment_paths]
    segment_provider = _provider(
        backend,
        request,
        ("_digital_human_segment_provider", "_video_segment_provider"),
        ("generate_digital_human_segment", "_generate_digital_human_segment"),
    )
    if target_indices and segment_provider is None:
        raise VideoDependencyError("digital human segment provider is not configured")
    for order, index in enumerate(target_indices, start=1):
        context.check_cancelled()
        destination = (segment_dir / f"{index}.mp4").resolve()
        try:
            result = _invoke(
                segment_provider,
                task_id=str(task_id),
                payload=request,
                context=context,
                workdir=workdir,
                output_path=destination,
                segment_index=index,
                segment_count=segment_count,
                script_text=segment_scripts[index - 1],
                prompt_text=prompt_segments[index - 1],
                source_image_path=fusion_paths[sequence[index - 1]],
                fusion_image_paths=fusion_paths,
                view_index=sequence[index - 1] + 1,
                view_sequence=[item + 1 for item in sequence],
                model_references=model_references,
                product_references=product_references,
                dual_presenter=dual_presenter,
                regenerate=index == regenerate_index,
            )
            normalized = dict(result) if isinstance(result, dict) else {"video_path": result}
            status = _text(normalized.get("status")).lower()
            if status in {"failed", "error", "cancelled", "canceled"} or normalized.get("ok") is False:
                raise RuntimeError(_text(normalized.get("message") or normalized.get("error")) or "provider reported failure")
            generated = _video_path(normalized, destination)
            if not generated.exists() or not generated.is_file():
                raise FileNotFoundError(f"segment provider did not create segment {index}: {generated}")
            if generated != destination:
                shutil.copy2(generated, destination)
            segment_paths[index] = destination
            segment_provider_ids[index] = _task_ids(normalized)
            segment_durations[index] = max(
                _float(
                    normalized.get("duration_seconds")
                    or normalized.get("video_seconds")
                    or normalized.get("duration"),
                    0.0,
                ),
                0.0,
            )
            segment_results[index] = normalized
        except VideoTaskCancelled:
            raise
        except Exception as exc:
            failures.append({"segment_index": index, "error": _text(exc) or exc.__class__.__name__})
            continue

        provider_ids = list(segment_provider_ids.get(index, []))
        provider_id = provider_ids[-1] if provider_ids else ""
        completed_segment = {
            "index": index,
            "path": str(destination),
            "duration_seconds": segment_durations[index],
            "runninghub_task_id": provider_id,
            "runninghub_task_ids": provider_ids,
            "provider_task_id": provider_id,
            "provider_task_ids": provider_ids,
        }
        if callable(checkpoint_callback):
            _invoke(
                checkpoint_callback,
                task_id=str(task_id),
                completed_segment=completed_segment,
                stage="digital_human_video",
                segment_index=index,
                segment_count=segment_count,
                fusion_images=fusion_paths,
                segment_scripts=segment_scripts,
                view_sequence=[item + 1 for item in sequence],
                message=f"Digital-human segment {index}/{segment_count} complete",
            )
        context.progress(
            stage="digital_human_video",
            status="running",
            message=f"Digital-human segment {index}/{segment_count} complete",
            progress=60 + round(order / max(len(target_indices), 1) * 28),
        )

    completed_indices = [index for index in range(1, segment_count + 1) if index in segment_paths and segment_paths[index].is_file()]
    missing_indices = [index for index in range(1, segment_count + 1) if index not in completed_indices]
    all_task_ids = _unique_text(
        [*fusion_task_ids, *(task_id for index in range(1, segment_count + 1) for task_id in segment_provider_ids.get(index, []))]
    )
    segment_path_list = [str(segment_paths[index]) if index in segment_paths else "" for index in range(1, segment_count + 1)]
    task_id_map = {str(index): list(segment_provider_ids.get(index, [])) for index in completed_indices}
    completed_output = []
    for index in completed_indices:
        provider_ids = list(segment_provider_ids.get(index, []))
        provider_id = provider_ids[-1] if provider_ids else ""
        completed_output.append(
            {
                "index": index,
                "path": str(segment_paths[index]),
                "duration_seconds": max(_float(segment_durations.get(index), 0.0), 0.0),
                "runninghub_task_id": provider_id,
                "runninghub_task_ids": provider_ids,
                "provider_task_id": provider_id,
                "provider_task_ids": provider_ids,
            }
        )
    checkpoint_output = {
        "version": 1,
        "task_type": "create_video",
        "stage": "digital_human_video",
        "segment_index": completed_indices[-1] if completed_indices else 0,
        "segment_count": segment_count,
        "completed_segments": completed_output,
        "segment_video_paths": segment_path_list,
        "segment_provider_task_ids": task_id_map,
        "runninghub_task_id": all_task_ids[-1] if all_task_ids else "",
        "runninghub_task_ids": all_task_ids,
        "fusion_images": fusion_paths,
        "segment_scripts": segment_scripts,
        "view_sequence": [item + 1 for item in sequence],
    }
    total_duration_seconds = sum(
        max(_float(segment_durations.get(index), 0.0), 0.0)
        for index in completed_indices
    )
    segment_usage = _usage_by_segment(segment_results)
    fusion_usage = _merge_usage_totals(fusion_results)
    combined_usage = _merge_usage_totals(fusion_usage, segment_usage)
    if fusion_usage:
        combined_usage["fusion"] = fusion_usage
    if isinstance(segment_usage.get("segments"), dict):
        combined_usage["segments"] = segment_usage["segments"]
    common = {
        "runninghub_task_id": all_task_ids[-1] if all_task_ids else "",
        "runninghub_task_ids": all_task_ids,
        "runninghub_usage": combined_usage,
        "speech_text": speech_text,
        "prompt_text": "\n".join(prompt_segments),
        "fusion_images": fusion_paths,
        "segment_scripts": segment_scripts,
        "view_sequence": [item + 1 for item in sequence],
        "ai_copy": ai_meta,
        "segment_provider_task_ids": task_id_map,
        "segment_video_paths": segment_path_list,
        "completed_segments": completed_output,
        "video_checkpoint": checkpoint_output,
        "duration_seconds": total_duration_seconds,
        "audio_duration_seconds": total_duration_seconds,
        "completed_segment_indices": completed_indices,
        "missing_segment_indices": missing_indices,
        "regenerated_segment_index": regenerate_index,
    }

    if missing_indices:
        failure_text = "; ".join(
            f"segment {item['segment_index']}: {item['error']}" for item in failures
        ) or f"missing segments: {', '.join(str(item) for item in missing_indices)}"
        can_resume = bool(completed_indices and missing_indices)
        return {
            "ok": False,
            "status": "failed",
            "message": f"Digital-human video partially completed; {failure_text}",
            "error": failure_text,
            "partial": True,
            "can_resume": can_resume,
            "resume_kind": "digital_human_video_segments" if can_resume else "",
            "video_path": "",
            "download_path": "",
            "subtitle_path": "",
            "subtitled": False,
            "subtitles_applied": False,
            "subtitle_count": 0,
            "cover_image_path": "",
            "poster_image_path": "",
            "warnings": [],
            **common,
            "raw_result": {
                "output_dir": str(segment_dir.parent),
                "digital_human_short_mode": mode,
                "segment_count": segment_count,
                "success_count": len(completed_indices),
                "segment_video_paths": segment_path_list,
                "completed_segment_indices": completed_indices,
                "missing_segment_indices": missing_indices,
                "failed_segment_indices": missing_indices,
                "segment_provider_task_ids": task_id_map,
                "completed_segments": completed_output,
                "failures": failures,
                "partial": True,
                "can_resume": can_resume,
                "dual_model_dialogue": dual_presenter,
                "model_references": model_references,
                "product_references": product_references,
            },
        }

    ordered_paths = [segment_paths[index] for index in range(1, segment_count + 1)]
    final_video = ordered_paths[0]
    concat_meta: dict[str, Any] = {}
    if len(ordered_paths) > 1:
        concat_provider = _provider(
            backend,
            request,
            ("_digital_human_concat_provider", "_video_concat_provider"),
            ("concat_digital_human_segments", "_concat_digital_human_segments"),
        )
        if concat_provider is None:
            raise VideoDependencyError("digital human concat provider is not configured for multi-segment output")
        context.progress(stage="digital_human_merge", status="running", message="Merging digital-human segments", progress=94)
        concat_output = (segment_dir.parent / "digital_human_short_video.mp4").resolve()
        concat_result = _invoke(
            concat_provider,
            task_id=str(task_id),
            payload=request,
            context=context,
            workdir=workdir,
            video_paths=ordered_paths,
            output_path=concat_output,
        )
        if isinstance(concat_result, dict):
            concat_meta = {
                "tail_audio_noise_trims": list(concat_result.get("tail_audio_noise_trims") or []),
                "segment_join_cleanup_trims": list(concat_result.get("segment_join_cleanup_trims") or []),
                "segment_join_crossfade_seconds": max(
                    _float(concat_result.get("segment_join_crossfade_seconds"), 0.0), 0.0
                ),
            }
        final_video = _video_path(concat_result, concat_output)
        if not final_video.exists() or not final_video.is_file():
            raise FileNotFoundError(f"digital human concat did not create output: {final_video}")

    warnings: list[str] = []
    trimmed_segments = [
        item for item in concat_meta.get("tail_audio_noise_trims", [])
        if isinstance(item, dict) and item.get("trimmed_path")
    ]
    if trimmed_segments:
        warnings.append(f"tail_audio_noise_trimmed: {len(trimmed_segments)}")
    normalized_join_segments = [
        item for item in concat_meta.get("segment_join_cleanup_trims", [])
        if isinstance(item, dict) and item.get("trimmed_path")
    ]
    if normalized_join_segments:
        warnings.append(f"segment_join_normalized: {len(normalized_join_segments)}")

    segment_preview_meta: list[dict[str, Any]] = []
    segment_preview_paths = [str(path) for path in ordered_paths]
    preview_provider = _provider(
        backend,
        request,
        ("_digital_human_segment_preview_provider",),
        ("build_digital_human_segment_previews",),
    )
    if preview_provider is not None:
        try:
            preview_result = _invoke(
                preview_provider,
                task_id=str(task_id),
                payload=request,
                context=context,
                workdir=workdir,
                video_paths=ordered_paths,
            )
            if isinstance(preview_result, dict):
                preview_values = preview_result.get("paths")
                if isinstance(preview_values, list) and preview_values:
                    segment_preview_paths = [str(item) for item in preview_values]
                metadata_values = preview_result.get("metadata")
                if isinstance(metadata_values, list):
                    segment_preview_meta = [dict(item) for item in metadata_values if isinstance(item, dict)]
        except VideoTaskCancelled:
            raise
        except Exception as exc:
            warnings.append(f"segment_preview_failed: {_text(exc) or exc.__class__.__name__}")

    audio_postprocess_meta: dict[str, Any] = {}
    audio_postprocess_provider = _provider(
        backend,
        request,
        ("_digital_human_audio_postprocess_provider",),
        ("postprocess_digital_human_audio",),
    )
    if audio_postprocess_provider is not None:
        try:
            audio_result = _invoke(
                audio_postprocess_provider,
                task_id=str(task_id),
                payload=request,
                context=context,
                workdir=workdir,
                video_path=final_video,
            )
            if isinstance(audio_result, dict):
                candidate = _text(audio_result.get("video_path"))
                if candidate and Path(candidate).is_file():
                    final_video = Path(candidate).expanduser().resolve()
                audio_postprocess_meta = {
                    key: audio_result.get(key)
                    for key in ("audio_delay", "ambient_audio", "tail_padding")
                    if key in audio_result
                }
                warnings.extend(
                    _text(item)
                    for item in (audio_result.get("warnings") or [])
                    if _text(item)
                )
        except VideoTaskCancelled:
            raise
        except Exception as exc:
            warnings.append(f"audio_postprocess_failed: {_text(exc) or exc.__class__.__name__}")

    concat_meta["segment_preview_paths"] = segment_preview_paths
    concat_meta["segment_preview_padding"] = segment_preview_meta
    concat_meta.update(audio_postprocess_meta)
    cover_source_video = final_video
    cover_meta = _maybe_create_digital_human_video_cover(
        cover_source_video,
        payload=request,
        speech_text=speech_text,
        warnings=warnings,
        context=context,
    )
    cover_path = _text((cover_meta or {}).get("path"))
    subtitle_path = ""
    subtitled = False
    subtitle_count = 0
    raw_subtitle_segment_durations = [
        max(_float(segment_durations.get(index), 0.0), 0.1)
        for index in range(1, segment_count + 1)
    ]
    subtitle_segment_durations = adjust_digital_human_segment_durations(
        raw_subtitle_segment_durations,
        expected_count=segment_count,
        crossfade_seconds=max(_float(concat_meta.get("segment_join_crossfade_seconds"), 0.0), 0.0),
        tail_padding_meta=(
            concat_meta.get("tail_padding")
            if isinstance(concat_meta.get("tail_padding"), dict)
            else None
        ),
    ) or raw_subtitle_segment_durations
    if _subtitles_enabled(request):
        subtitle_provider = _provider(
            backend,
            request,
            ("_digital_human_subtitle_provider", "_video_subtitle_provider"),
            ("render_digital_human_subtitles", "_apply_optional_subtitles"),
        )
        if subtitle_provider is None:
            warnings.append("subtitle rendering skipped: subtitle provider is not configured")
        else:
            context.progress(stage="digital_human_subtitle", status="running", message="Rendering subtitles", progress=97)
            subtitle_output = (segment_dir.parent / f"{final_video.stem}_subtitled.mp4").resolve()
            try:
                subtitle_result = _invoke(
                    subtitle_provider,
                    task_id=str(task_id),
                    payload=request,
                    context=context,
                    workdir=workdir,
                    video_path=final_video,
                    output_path=subtitle_output,
                    speech_text=speech_text,
                    segment_texts=segment_scripts,
                    segment_durations=subtitle_segment_durations,
                )
                if isinstance(subtitle_result, tuple):
                    rendered = Path(subtitle_result[0]).expanduser().resolve()
                    count = _integer(subtitle_result[1] if len(subtitle_result) > 1 else 0, 0)
                    warning = _text(subtitle_result[2] if len(subtitle_result) > 2 else "")
                    if warning:
                        warnings.append(warning)
                    if count > 0 and rendered.exists():
                        final_video = rendered
                        subtitled = True
                        subtitle_count = count
                else:
                    normalized_subtitle = dict(subtitle_result) if isinstance(subtitle_result, dict) else {"video_path": subtitle_result}
                    rendered = _video_path(normalized_subtitle, subtitle_output)
                    subtitle_path = _text(normalized_subtitle.get("subtitle_path"))
                    count = _integer(normalized_subtitle.get("count") or normalized_subtitle.get("subtitle_count"), 0)
                    if rendered.exists() and (count > 0 or subtitle_path):
                        final_video = rendered
                        subtitled = True
                        subtitle_count = count
                if subtitled and not subtitle_path:
                    configured_subtitle = final_video.with_suffix(".srt")
                    if configured_subtitle.exists():
                        subtitle_path = str(configured_subtitle)
            except VideoTaskCancelled:
                raise
            except Exception as exc:
                warnings.append(f"subtitle rendering skipped: {_text(exc) or exc.__class__.__name__}")

    context.progress(stage="digital_human_merge", status="success", message="Digital-human video complete", progress=100)
    return {
        "ok": True,
        "status": "success",
        "message": "Digital-human video complete",
        "video_path": str(final_video),
        "download_path": str(final_video),
        "subtitle_path": subtitle_path,
        "subtitled": subtitled,
        "subtitles_applied": subtitled,
        "subtitle_count": subtitle_count,
        "cover_image_path": cover_path,
        "poster_image_path": cover_path,
        "warnings": warnings,
        "partial": False,
        "can_resume": False,
        **common,
        "raw_result": {
            "output_dir": str(segment_dir.parent),
            "digital_human_short_mode": mode,
            "segment_count": segment_count,
            "success_count": len(completed_indices),
            "segment_video_paths": segment_path_list,
            "completed_segment_indices": completed_indices,
            "missing_segment_indices": [],
            "segment_provider_task_ids": task_id_map,
            "completed_segments": completed_output,
            "dual_model_dialogue": dual_presenter,
            "model_references": model_references,
            "product_references": product_references,
            "regenerated_segment_index": regenerate_index,
            "video_cover": cover_meta or {},
            "postprocess": concat_meta,
            "partial": False,
            "can_resume": False,
        },
    }


__all__ = ["run_digital_human_pipeline"]
