from __future__ import annotations

import inspect
import re
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from .contracts import VideoTaskCancelled
from .image_sanitize import sanitize_generated_image_file


SUPPORTED_IMAGE_MODES = frozenset(
    {
        "product_only",
        "model_product",
        "scene_image",
        "subject_replace",
        "poster_translate",
        "digital_human_character",
        "three_view",
    }
)

CLOSED_WORKFLOW_STAGE = "closed_image_model"
CLOSED_WORKFLOW_STAGE_PREFIX = f"{CLOSED_WORKFLOW_STAGE}:"

_PROVIDER_ALIASES = {
    "auto": "auto",
    "closed": "closed_model_api",
    "closed_model": "closed_model_api",
    "closed_model_api": "closed_model_api",
    "workflow": "runninghub_workflow",
    "runninghub": "runninghub_workflow",
    "runninghub_workflow": "runninghub_workflow",
    "standard": "standard_image_api",
    "standard_api": "standard_image_api",
    "standard_image_api": "standard_image_api",
    "runninghub_standard_api": "standard_image_api",
}

Callback = Callable[..., Any]


def _text(value: Any) -> str:
    return str(value or "").strip()


def _flatten_strings(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [item.strip() for item in re.split(r"[,，;；\n\r]+", value) if item.strip()]
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        values: list[str] = []
        for item in value:
            values.extend(_flatten_strings(item))
        return values
    text = _text(value)
    return [text] if text else []


def _unique(values: Sequence[str]) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = _text(value)
        if text and text not in seen:
            seen.add(text)
            output.append(text)
    return output


def map_image_reference_roles(mode: str, input_image_paths: Sequence[str | Path]) -> list[str]:
    """Map already-normalized source-backend inputs to their mode-specific roles."""

    normalized_mode = _text(mode).lower()
    if normalized_mode not in SUPPORTED_IMAGE_MODES:
        raise ValueError(f"unsupported image generation mode: {normalized_mode or '(empty)'}")
    count = len(input_image_paths)
    if normalized_mode == "product_only":
        return ["product", *[f"product_reference_{index}" for index in range(2, count + 1)]] if count else []
    if normalized_mode == "model_product":
        roles = ["product", "model"][:count]
        roles.extend(f"extra_reference_{index}" for index in range(1, max(count - 2, 0) + 1))
        return roles
    if normalized_mode == "subject_replace":
        roles = ["source", "replacement", "replacement_secondary"]
        if count > len(roles):
            roles.extend(f"replacement_reference_{index}" for index in range(3, count))
        return roles[:count]
    if normalized_mode == "poster_translate":
        return ["poster"][:count]
    if normalized_mode == "digital_human_character":
        return [f"character_reference_{index}" for index in range(1, count + 1)]
    if normalized_mode == "scene_image":
        return []
    return [f"reference_{index}" for index in range(1, count + 1)]


def _resolve_provider(payload: Mapping[str, Any]) -> str:
    raw = _text(payload.get("image_generate_provider") or payload.get("image_generate_mode_default") or "closed_model_api")
    provider = _PROVIDER_ALIASES.get(raw.lower())
    if not provider:
        supported = "auto, closed_model_api, runninghub_workflow, standard_image_api"
        raise ValueError(f"unsupported image_generate_provider {raw!r}; supported providers: {supported}")
    return provider


def _workflow_ids(payload: Mapping[str, Any]) -> list[str]:
    configured = _flatten_strings(payload.get("image_generate_workflow_ids"))
    if not configured:
        configured = _flatten_strings(payload.get("image_runninghub_workflow_id"))
    return _unique(configured)


def _model_priority(payload: Mapping[str, Any]) -> list[str]:
    ordered: list[str] = []
    for key in (
        "image_generate_model",
        "image_model_priority_order",
        "image_model_default_model_gpt",
        "image_model_default_model_gemini",
        "image_model_default_model",
    ):
        ordered.extend(_flatten_strings(payload.get(key)))
    return _unique(ordered)


def _resolve_count(payload: Mapping[str, Any], count: int | None) -> int:
    value: Any = count
    if value is None:
        for key in ("image_count", "imageCount", "nano_images", "count"):
            if payload.get(key) is not None:
                value = payload.get(key)
                break
    if value is None:
        value = 1
    if isinstance(value, bool):
        raise ValueError("image count must be an integer between 1 and 20")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("image count must be an integer between 1 and 20") from exc
    if parsed < 1 or parsed > 20:
        raise ValueError("image count must be between 1 and 20")
    return parsed


def _is_cancelled_error(exc: BaseException) -> bool:
    name = type(exc).__name__.lower()
    return isinstance(exc, VideoTaskCancelled) or "cancelled" in name or "canceled" in name


def _check_cancelled(payload: Mapping[str, Any], context: Any) -> None:
    checker = getattr(context, "check_cancelled", None)
    if callable(checker):
        checker()
    payload_checker = payload.get("_cancel_check")
    if callable(payload_checker):
        payload_checker()


def _invoke(callback: Callback, values: dict[str, Any]) -> Any:
    """Call injected boundaries while allowing narrow test and integration callbacks."""

    try:
        signature = inspect.signature(callback)
    except (TypeError, ValueError):
        return callback(**values)
    if any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values()):
        return callback(**values)
    accepted = {
        name: value
        for name, value in values.items()
        if name in signature.parameters
        and signature.parameters[name].kind
        in {inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY}
    }
    return callback(**accepted)


def _callback_result(result: Any, target: Path, *, label: str) -> tuple[dict[str, Any], Path]:
    if isinstance(result, Mapping):
        normalized = dict(result)
    elif isinstance(result, (str, Path)):
        normalized = {"image_path": str(result)}
    else:
        normalized = {"raw_result": result}
    status = _text(normalized.get("status")).lower()
    if normalized.get("ok") is False or status in {"failed", "fail", "error", "cancelled", "canceled"}:
        detail = _text(normalized.get("error") or normalized.get("message") or status)
        raise RuntimeError(f"{label} failed: {detail or 'provider returned failure'}")
    returned_path = _text(
        normalized.get("image_path")
        or normalized.get("output_path")
        or normalized.get("download_path")
    )
    output = Path(returned_path).expanduser().resolve() if returned_path else target.resolve()
    if not output.exists() or not output.is_file():
        raise RuntimeError(f"{label} did not create an output image: {output}")
    normalized["image_path"] = str(output)
    return normalized, output


def _task_ids(result: Mapping[str, Any]) -> list[str]:
    values: list[Any] = []
    listed = result.get("runninghub_task_ids")
    if isinstance(listed, Sequence) and not isinstance(listed, (str, bytes, bytearray)):
        values.extend(listed)
    values.extend(
        result.get(key)
        for key in ("runninghub_task_id", "provider_task_id", "task_id", "taskId", "task id")
    )
    return _unique([_text(value) for value in values])


def _iter_usage(value: Any):
    if isinstance(value, Mapping):
        if any(key in value for key in ("consumeCoins", "consumeMoney", "thirdPartyConsumeMoney")):
            yield value
            return
        for child in value.values():
            yield from _iter_usage(child)
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for child in value:
            yield from _iter_usage(child)


def _merged_usage(values: Sequence[Any]) -> dict[str, float]:
    totals = {"consumeCoins": 0.0, "consumeMoney": 0.0, "thirdPartyConsumeMoney": 0.0}
    found = False
    for value in values:
        for usage in _iter_usage(value):
            found = True
            for key in totals:
                try:
                    totals[key] += float(usage.get(key) or 0)
                except (TypeError, ValueError):
                    continue
    return {key: round(value, 6) for key, value in totals.items()} if found else {}


def _semantic_inputs(mode: str, input_paths: list[str]) -> tuple[str, str, list[str]]:
    product_input = input_paths[0] if input_paths else ""
    model_input = product_input
    if mode in {"model_product", "subject_replace"} and len(input_paths) > 1:
        model_input = input_paths[1]
    return product_input, model_input, map_image_reference_roles(mode, input_paths)


def _callback_values(
    *,
    task_id: str,
    payload: Mapping[str, Any],
    mode: str,
    prompt: str,
    input_paths: list[str],
    output_path: Path,
    size: str,
    image_index: int,
    image_count: int,
    context: Any,
    model: str = "",
    model_priority: Sequence[str] = (),
    workflow_id: str = "",
    step_index: int = 0,
    step_count: int = 0,
) -> dict[str, Any]:
    product_input, model_input, roles = _semantic_inputs(mode, input_paths)
    return {
        "task_id": str(task_id),
        "payload": dict(payload),
        "mode": mode,
        "prompt": prompt,
        "prompt_text": prompt,
        "input_image_path": input_paths[0] if input_paths else None,
        "input_image_paths": list(input_paths),
        "reference_roles": roles,
        "product_input": product_input or None,
        "model_input": model_input or None,
        "output_path": str(output_path),
        "output_image_path": str(output_path),
        "size": size,
        "image_index": image_index,
        "image_count": image_count,
        "model": model,
        "model_priority": list(model_priority),
        "workflow_id": workflow_id,
        "step_index": step_index,
        "step_count": step_count,
        "context": context,
        "check_cancelled": lambda: _check_cancelled(payload, context),
    }


def _run_model_provider(
    *,
    provider_name: str,
    callback: Callback,
    models: list[str],
    common: dict[str, Any],
    attempts: list[dict[str, Any]],
    payload: Mapping[str, Any],
    context: Any,
) -> tuple[dict[str, Any], Path]:
    candidates = models or [""]
    last_error: Exception | None = None
    for model in candidates:
        _check_cancelled(payload, context)
        values = {**common, "model": model, "model_priority": list(models)}
        try:
            raw = _invoke(callback, values)
            result, output = _callback_result(raw, Path(common["output_path"]), label=provider_name)
            attempts.append(
                {
                    "image_index": common["image_index"],
                    "provider": provider_name,
                    "model": model,
                    "ok": True,
                    "error": "",
                    "runninghub_task_ids": _task_ids(result),
                }
            )
            return result, output
        except Exception as exc:
            if _is_cancelled_error(exc):
                raise
            last_error = exc
            attempts.append(
                {
                    "image_index": common["image_index"],
                    "provider": provider_name,
                    "model": model,
                    "ok": False,
                    "error": _text(exc),
                }
            )
    raise RuntimeError(f"{provider_name} exhausted model priority: {_text(last_error) or 'all models failed'}") from last_error


def _run_workflow_chain(
    *,
    workflow_ids: list[str],
    workflow_callback: Callback | None,
    closed_model_callback: Callback | None,
    models: list[str],
    common: dict[str, Any],
    attempts: list[dict[str, Any]],
    payload: Mapping[str, Any],
    context: Any,
) -> tuple[dict[str, Any], Path, list[dict[str, Any]]]:
    current_inputs = list(common["input_image_paths"])
    step_results: list[dict[str, Any]] = []
    final_result: dict[str, Any] = {}
    final_target = Path(common["output_path"])
    final_output = final_target
    for step_index, workflow_id in enumerate(workflow_ids, start=1):
        _check_cancelled(payload, context)
        is_last = step_index == len(workflow_ids)
        target = final_target if is_last else final_target.with_name(
            f"{final_target.stem}_step_{step_index:02d}{final_target.suffix}"
        )
        values = {
            **common,
            **_callback_values(
                task_id=common["task_id"],
                payload=payload,
                mode=common["mode"],
                prompt=common["prompt"],
                input_paths=current_inputs,
                output_path=target,
                size=common["size"],
                image_index=common["image_index"],
                image_count=common["image_count"],
                context=context,
                model_priority=models,
                workflow_id=workflow_id,
                step_index=step_index,
                step_count=len(workflow_ids),
            ),
        }
        if workflow_id == CLOSED_WORKFLOW_STAGE or workflow_id.startswith(CLOSED_WORKFLOW_STAGE_PREFIX):
            if closed_model_callback is None:
                raise RuntimeError("closed image workflow stage requires a closed model callback")
            stage_model = _text(workflow_id[len(CLOSED_WORKFLOW_STAGE_PREFIX) :]) if workflow_id.startswith(CLOSED_WORKFLOW_STAGE_PREFIX) else ""
            stage_models = [stage_model] if stage_model else models
            result, output = _run_model_provider(
                provider_name="closed_model_api",
                callback=closed_model_callback,
                models=stage_models,
                common=values,
                attempts=attempts,
                payload=payload,
                context=context,
            )
        else:
            if workflow_callback is None:
                raise RuntimeError("runninghub workflow provider requires a workflow callback")
            try:
                raw = _invoke(workflow_callback, values)
                result, output = _callback_result(raw, target, label=f"runninghub workflow {workflow_id}")
                attempts.append(
                    {
                        "image_index": common["image_index"],
                        "provider": "runninghub_workflow",
                        "workflow_id": workflow_id,
                        "ok": True,
                        "error": "",
                        "runninghub_task_ids": _task_ids(result),
                    }
                )
            except Exception as exc:
                if _is_cancelled_error(exc):
                    raise
                attempts.append(
                    {
                        "image_index": common["image_index"],
                        "provider": "runninghub_workflow",
                        "workflow_id": workflow_id,
                        "ok": False,
                        "error": _text(exc),
                    }
                )
                raise
        final_result = result
        final_output = output
        step_results.append(
            {
                "step": step_index,
                "provider": "closed_model_api" if workflow_id.startswith(CLOSED_WORKFLOW_STAGE) else "runninghub_workflow",
                "workflow_id": workflow_id,
                "output_path": str(output),
                "result": result,
            }
        )
        # The source implementation feeds each chain result back as both the product and model reference.
        current_inputs = [str(output)]
    return final_result, final_output, step_results


def dispatch_image_generate(
    *,
    task_id: str,
    payload: Mapping[str, Any] | None,
    mode: str,
    prompt: str,
    input_image_paths: Sequence[str | Path] | None,
    output_dir: str | Path,
    count: int | None = None,
    size: str = "1:1",
    context: Any = None,
    workflow_callback: Callback | None = None,
    standard_api_callback: Callback | None = None,
    closed_model_callback: Callback | None = None,
) -> dict[str, Any]:
    """Dispatch normalized image generation without owning HTTP, DB, server, or Telegram I/O.

    ``source_backend.image_generate`` owns mode-specific input validation and prompt building. This
    function owns only provider selection, workflow chaining, model-priority fallback, count, and
    result aggregation. Every paid or remote boundary is an injected callback.
    """

    source: Mapping[str, Any] = payload if isinstance(payload, Mapping) else {}
    normalized_mode = _text(mode).lower()
    if normalized_mode not in SUPPORTED_IMAGE_MODES:
        raise ValueError(f"unsupported image generation mode: {normalized_mode or '(empty)'}")
    prompt_text = _text(prompt)
    if not prompt_text:
        raise ValueError("image generation requires a prompt")
    provider_requested = _resolve_provider(source)
    workflows = _workflow_ids(source)
    models = _model_priority(source)
    requested_count = _resolve_count(source, count)
    input_paths = _unique([_text(path) for path in input_image_paths or ()])
    reference_roles = map_image_reference_roles(normalized_mode, input_paths)
    target_dir = Path(output_dir).expanduser().resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    provider_effective = provider_requested
    multi_reference_workflow_fallback = (
        provider_requested == "runninghub_workflow"
        and normalized_mode == "subject_replace"
        and len(input_paths) > 2
    )
    if multi_reference_workflow_fallback:
        provider_effective = "closed_model_api"
    if provider_effective == "runninghub_workflow" and not workflows:
        raise RuntimeError("runninghub workflow provider requires image_generate_workflow_ids")

    if provider_effective == "closed_model_api" and closed_model_callback is None and standard_api_callback is None:
        raise RuntimeError("closed image provider requires a closed model or standard image API callback")
    if provider_effective == "standard_image_api" and standard_api_callback is None:
        raise RuntimeError("standard image provider requires a standard image API callback")

    attempts: list[dict[str, Any]] = []
    generations: list[dict[str, Any]] = []
    image_paths: list[str] = []
    runninghub_task_ids: list[str] = []
    providers_used: list[str] = []

    for image_index in range(1, requested_count + 1):
        _check_cancelled(source, context)
        output_path = target_dir / (
            "image_generate.png" if requested_count == 1 else f"image_generate_{image_index:03d}.png"
        )
        common = _callback_values(
            task_id=str(task_id),
            payload=source,
            mode=normalized_mode,
            prompt=prompt_text,
            input_paths=input_paths,
            output_path=output_path,
            size=_text(size) or "1:1",
            image_index=image_index,
            image_count=requested_count,
            context=context,
            model_priority=models,
        )
        result: dict[str, Any] | None = None
        output: Path | None = None
        step_results: list[dict[str, Any]] = []
        last_error: Exception | None = None

        candidates: list[str]
        if provider_effective == "auto":
            candidates = []
            if workflows:
                candidates.append("runninghub_workflow")
            if closed_model_callback is not None:
                candidates.append("closed_model_api")
            if standard_api_callback is not None:
                candidates.append("standard_image_api")
        elif provider_effective == "closed_model_api":
            # The archived closed-model entrypoint used RunningHub's Standard Image API when no
            # direct closed callback was configured, so retain that compatibility fallback.
            candidates = ["closed_model_api"] if closed_model_callback is not None else ["standard_image_api"]
        else:
            candidates = [provider_effective]
        if not candidates:
            raise RuntimeError("image generation auto provider has no injected provider callback")

        for candidate in candidates:
            _check_cancelled(source, context)
            try:
                if candidate == "runninghub_workflow":
                    result, output, step_results = _run_workflow_chain(
                        workflow_ids=workflows,
                        workflow_callback=workflow_callback,
                        closed_model_callback=closed_model_callback,
                        models=models,
                        common=common,
                        attempts=attempts,
                        payload=source,
                        context=context,
                    )
                elif candidate == "closed_model_api":
                    if closed_model_callback is None:
                        raise RuntimeError("closed image provider requires a closed model callback")
                    result, output = _run_model_provider(
                        provider_name="closed_model_api",
                        callback=closed_model_callback,
                        models=models,
                        common=common,
                        attempts=attempts,
                        payload=source,
                        context=context,
                    )
                else:
                    if standard_api_callback is None:
                        raise RuntimeError("standard image provider requires a standard image API callback")
                    result, output = _run_model_provider(
                        provider_name="standard_image_api",
                        callback=standard_api_callback,
                        models=models,
                        common=common,
                        attempts=attempts,
                        payload=source,
                        context=context,
                    )
                providers_used.append(candidate)
                break
            except Exception as exc:
                if _is_cancelled_error(exc):
                    raise
                last_error = exc
                if provider_effective != "auto":
                    raise
                continue
        if result is None or output is None:
            raise RuntimeError(f"all image generation providers failed: {_text(last_error)}") from last_error

        _check_cancelled(source, context)
        progress = getattr(context, "progress", None)
        if callable(progress):
            progress(
                stage="image_sanitize",
                status="running",
                message="正在清洗图片元数据",
                progress=round((image_index - 0.15) * 100 / requested_count, 2),
            )
        sanitize_generated_image_file(output)
        path_text = str(output)
        image_paths.append(path_text)
        task_id_sources = [
            item.get("result")
            for item in step_results
            if isinstance(item, Mapping) and isinstance(item.get("result"), Mapping)
        ] or [result]
        for provider_task_id in _unique(
            [task_id for task_result in task_id_sources for task_id in _task_ids(task_result)]
        ):
            if provider_task_id not in runninghub_task_ids:
                runninghub_task_ids.append(provider_task_id)
        generations.append(
            {
                "index": image_index,
                "provider": providers_used[-1],
                "image_path": path_text,
                "result": result,
                "steps": step_results,
            }
        )
        progress = getattr(context, "progress", None)
        if callable(progress):
            progress(
                stage="image_generate",
                status="running" if image_index < requested_count else "success",
                message=f"image generation {image_index}/{requested_count}",
                progress=round(image_index * 100 / requested_count, 2),
            )

    first_image = image_paths[0]
    for attempt in attempts:
        if not isinstance(attempt, Mapping):
            continue
        for provider_task_id in _flatten_strings(attempt.get("runninghub_task_ids")):
            if provider_task_id not in runninghub_task_ids:
                runninghub_task_ids.append(provider_task_id)
    selected_models = [
        _text(item.get("result", {}).get("selected_model") or item.get("result", {}).get("image_model_used"))
        for item in generations
        if isinstance(item.get("result"), Mapping)
    ]
    selected_models = [model for model in selected_models if model]
    provider_used = providers_used[-1] if providers_used else provider_effective
    return {
        "ok": True,
        "message": "image generation completed",
        "provider_used": provider_used,
        "providers_used": providers_used,
        "runninghub_task_id": runninghub_task_ids[-1] if runninghub_task_ids else "",
        "runninghub_task_ids": runninghub_task_ids,
        "runninghub_usage": _merged_usage(generations),
        "nano_images": len(image_paths),
        "image_count": len(image_paths),
        "image_path": first_image,
        "image_paths": image_paths,
        "scene_image_path": first_image,
        "download_path": first_image,
        "download_paths": image_paths,
        "mode": normalized_mode,
        "image_model_used": selected_models[-1] if selected_models else "",
        "image_model_attempts": attempts,
        "raw_result": {
            "provider_requested": provider_requested,
            "provider_effective": provider_effective,
            "workflow_ids": workflows,
            "model_priority": models,
            "mode": normalized_mode,
            "prompt": prompt_text,
            "input_image_paths": input_paths,
            "reference_roles": reference_roles,
            "size": _text(size) or "1:1",
            "requested_count": requested_count,
            "multi_reference_workflow_fallback": multi_reference_workflow_fallback,
            "generations": generations,
        },
    }


__all__ = [
    "CLOSED_WORKFLOW_STAGE",
    "SUPPORTED_IMAGE_MODES",
    "dispatch_image_generate",
    "map_image_reference_roles",
]
