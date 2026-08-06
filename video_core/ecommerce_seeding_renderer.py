from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from .contracts import VideoDependencyError, VideoTaskContext


TEMPLATE_LAYOUTS = {
    "template_b": "webinar_spine",
    "template_d": "story_column",
    "template_f": "closeup_sidebar",
}


def normalize_template(value: Any) -> str:
    template = str(value or "").strip().lower()
    if template not in TEMPLATE_LAYOUTS:
        supported = ", ".join(TEMPLATE_LAYOUTS)
        raise ValueError(f"ecommerce_seeding_template must be one of: {supported}")
    return template


def canvas_size(ratio: Any, resolution: Any) -> tuple[int, int]:
    ratio_text = str(ratio or "9:16").strip()
    resolution_text = str(resolution or "720p").strip().lower()
    long_edge = 1920 if resolution_text in {"1080p", "2k"} else 1280
    short_edge = 1080 if resolution_text in {"1080p", "2k"} else 720
    if ratio_text == "16:9":
        return long_edge, short_edge
    if ratio_text == "1:1":
        return short_edge, short_edge
    return short_edge, long_edge


def template_filter(template: Any, *, width: int, height: int) -> str:
    normalized = normalize_template(template)
    base = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}"
    if normalized == "template_b":
        spine = max(int(width * 0.075), 36)
        footer = max(int(height * 0.15), 72)
        return (
            f"{base},drawbox=x=0:y=0:w={spine}:h={height}:color=0x17324d@0.88:t=fill,"
            f"drawbox=x={spine}:y={height - footer}:w={width - spine}:h={footer}:color=black@0.36:t=fill"
        )
    if normalized == "template_d":
        inset_x = max(int(width * 0.05), 24)
        inset_y = max(int(height * 0.05), 24)
        return (
            f"{base},drawbox=x={inset_x}:y={inset_y}:w={width - inset_x * 2}:h={height - inset_y * 2}:"
            "color=white@0.08:t=fill,"
            f"drawbox=x=0:y=0:w={width}:h={max(int(height * 0.058), 42)}:color=0x17324d@0.80:t=fill"
        )
    sidebar = max(int(width * 0.27), 96)
    accent = max(int(width * 0.012), 6)
    return (
        f"{base},drawbox=x={width - sidebar}:y=0:w={sidebar}:h={height}:color=0x17324d@0.88:t=fill,"
        f"drawbox=x=0:y=0:w={accent}:h={height}:color=0x2f8fde@0.95:t=fill"
    )


def render_ecommerce_seeding(
    *,
    task_id: str,
    payload: dict[str, Any],
    context: VideoTaskContext,
    workdir: Path,
    segments: list[dict[str, Any]],
    completed_segments: dict[int, dict[str, Any]],
    generate_scene: Callable[..., dict[str, Any]],
    run_local_process: Callable[..., tuple[int, str, str]],
    concat_segments: Callable[..., None],
    checkpoint_segment: Callable[..., None],
) -> dict[str, Any]:
    template = normalize_template(payload.get("ecommerce_seeding_template"))
    ratio = str(payload.get("ratio") or payload.get("video_default_ratio") or "9:16").strip() or "9:16"
    resolution = str(payload.get("resolution") or payload.get("video_default_resolution") or "720p").strip() or "720p"
    width, height = canvas_size(ratio, resolution)
    ffmpeg = str(payload.get("ffmpeg_path") or "").strip()
    if not ffmpeg:
        import shutil

        ffmpeg = shutil.which("ffmpeg") or ""
    if not ffmpeg:
        raise VideoDependencyError("local ecommerce seeding rendering requires ffmpeg")

    operation = str(payload.get("ecommerce_seeding_operation") or "final_video").strip().lower()
    images_only = operation == "images_only"
    confirmed_values = payload.get("ecommerce_seeding_confirmed_image_paths")
    if confirmed_values is not None and not isinstance(confirmed_values, list):
        raise ValueError("ecommerce_seeding_confirmed_image_paths must be a list")
    confirmed_paths: list[Path] = []
    if not images_only and isinstance(confirmed_values, list) and confirmed_values:
        if len(confirmed_values) != len(segments):
            raise ValueError("confirmed ecommerce seeding image count must match storyboard segment count")
        for value in confirmed_values:
            path = Path(str(value or "")).expanduser().resolve()
            if not path.exists() or not path.is_file():
                raise FileNotFoundError(f"confirmed ecommerce seeding image does not exist: {path}")
            confirmed_paths.append(path)
    segment_records: list[dict[str, Any]] = []
    completed_output: list[dict[str, Any]] = []
    scene_results: list[dict[str, Any]] = []
    scene_paths: list[str] = []
    video_paths: list[Path] = []
    timeout_seconds = max(int(float(payload.get("video_task_timeout_seconds") or 3600)), 30)

    for offset, segment in enumerate(segments, start=1):
        context.check_cancelled()
        index = int(segment.get("index") or offset)
        duration = max(float(segment.get("duration_seconds") or 1.0), 1.0)
        existing = completed_segments.get(index) if not images_only else None
        if existing is not None:
            existing_path = Path(str(existing["path"])).expanduser().resolve()
            record = {
                **segment,
                "index": index,
                "path": str(existing_path),
                "duration_seconds": duration,
                "runninghub_task_id": str(existing.get("runninghub_task_id") or "").strip(),
                "status": "success",
                "skipped": True,
            }
            segment_records.append(record)
            video_paths.append(existing_path)
            completed_output.append(
                {
                    "index": index,
                    "path": str(existing_path),
                    "duration_seconds": duration,
                    "runninghub_task_id": record["runninghub_task_id"],
                }
            )
            continue

        context.progress(
            stage="seeding_image_confirm" if confirmed_paths else "seeding_image_generate",
            status="running",
            message=(
                f"Using confirmed ecommerce seeding scene {offset}/{len(segments)}"
                if confirmed_paths
                else f"Generating ecommerce seeding scene {offset}/{len(segments)}"
            ),
            progress=round(10 + 45 * (offset - 1) / max(len(segments), 1), 2),
        )
        scene_result = (
            {"image_path": str(confirmed_paths[offset - 1]), "source": "confirmed"}
            if confirmed_paths
            else generate_scene(segment=segment, segment_index=index, output_dir=workdir / f"seeding_scene_{index:03d}")
        )
        context.check_cancelled()
        if not isinstance(scene_result, dict):
            raise RuntimeError(f"seeding scene {index} did not return a result")
        scene_value = str(scene_result.get("image_path") or "").strip()
        scene_path = Path(scene_value).expanduser().resolve() if scene_value else Path()
        if not scene_value or not scene_path.exists() or not scene_path.is_file():
            raise RuntimeError(f"seeding scene {index} did not create an image")
        scene_results.append(scene_result)
        scene_paths.append(str(scene_path))

        provider_id = str(scene_result.get("runninghub_task_id") or "").strip()
        if images_only:
            segment_records.append(
                {
                    **segment,
                    "index": index,
                    "path": str(scene_path),
                    "image_path": str(scene_path),
                    "duration_seconds": duration,
                    "runninghub_task_id": provider_id,
                    "status": "success",
                    "skipped": False,
                }
            )
            continue

        output_path = workdir / f"ecommerce_local_seeding_segment_{index:03d}.mp4"
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-loop",
            "1",
            "-t",
            f"{duration:.3f}",
            "-i",
            str(scene_path),
            "-vf",
            template_filter(template, width=width, height=height),
            "-r",
            "30",
            "-c:v",
            str(payload.get("seeding_video_codec") or "libx264"),
            "-preset",
            str(payload.get("seeding_encode_preset") or "medium"),
            "-crf",
            str(min(max(int(float(payload.get("seeding_crf") or 18)), 0), 51)),
            "-pix_fmt",
            "yuv420p",
            "-an",
            str(output_path),
        ]
        context.progress(
            stage="seeding_local_render",
            status="running",
            message=f"Rendering ecommerce seeding segment {offset}/{len(segments)}",
            progress=round(55 + 35 * offset / max(len(segments), 1), 2),
        )
        returncode, _stdout, stderr = run_local_process(
            command,
            timeout_seconds=timeout_seconds,
            payload=payload,
            context=context,
        )
        context.check_cancelled()
        if returncode != 0 or not output_path.exists() or not output_path.is_file():
            raise RuntimeError(f"ffmpeg ecommerce seeding segment {index} failed: {str(stderr or '')[-1000:]}")
        checkpoint = {
            "index": index,
            "path": str(output_path.resolve()),
            "duration_seconds": duration,
            "runninghub_task_id": provider_id,
        }
        checkpoint_segment(task_id=task_id, payload=payload, segment=checkpoint)
        completed_output.append(checkpoint)
        video_paths.append(output_path.resolve())
        segment_records.append(
            {
                **segment,
                **checkpoint,
                "image_path": str(scene_path),
                "status": "success",
                "skipped": False,
            }
        )

    if images_only:
        if not scene_paths:
            raise RuntimeError("ecommerce seeding image stage produced no images")
        return {
            "ok": True,
            "images_only": True,
            "video_path": "",
            "download_path": scene_paths[0],
            "image_path": scene_paths[0],
            "image_paths": scene_paths,
            "segments": segment_records,
            "completed_segments": completed_output,
            "scene_results": scene_results,
            "template": template,
            "layout_variant": TEMPLATE_LAYOUTS[template],
            "ratio": ratio,
            "resolution": resolution,
        }

    if not video_paths:
        raise RuntimeError("ecommerce seeding local renderer produced no video segments")
    final_path = workdir / "ecommerce_short_video_local.mp4"
    concat_segments(segment_paths=video_paths, output_path=final_path)
    context.check_cancelled()
    context.progress(stage="seeding_local_render", status="success", message="Ecommerce seeding video rendered", progress=95)
    return {
        "ok": True,
        "images_only": False,
        "video_path": str(final_path.resolve()),
        "download_path": str(final_path.resolve()),
        "image_paths": scene_paths,
        "segments": segment_records,
        "completed_segments": completed_output,
        "scene_results": scene_results,
        "template": template,
        "layout_variant": TEMPLATE_LAYOUTS[template],
        "ratio": ratio,
        "resolution": resolution,
    }


__all__ = [
    "TEMPLATE_LAYOUTS",
    "canvas_size",
    "normalize_template",
    "render_ecommerce_seeding",
    "template_filter",
]
