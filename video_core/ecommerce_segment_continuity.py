from __future__ import annotations

import re
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

from PIL import Image, ImageDraw, ImageFont

from .contracts import VideoDependencyError, VideoTaskContext


_ECOMMERCE_TIME_UNIT_PATTERN = r"(?:秒|seconds?|secs?|s)"
_ECOMMERCE_TIME_RANGE_PATTERN = rf"(\d+)\s*[-到至]\s*(\d+)\s*{_ECOMMERCE_TIME_UNIT_PATTERN}\s*[:：]"
_ECOMMERCE_TIME_RANGE_LOOKAHEAD = (
    rf"(?=\d+\s*[-到至]\s*\d+\s*{_ECOMMERCE_TIME_UNIT_PATTERN}\s*[:：]"
    r"|(?:旁白|画外音|纪录片旁白|人物对白|台词|对白)[:：]"
    r"|【强化词】|声音约束[:：]|$)"
)


def _ecommerce_storyboard_recap_from_prompt(
    *,
    segment_prompt: str,
    segment_index: int,
    segment_duration: int,
    max_chars: int = 42,
) -> str:
    """Copy of the source platform's deterministic segment-recap helper."""

    text = re.sub(r"\s+", " ", str(segment_prompt or "")).strip()
    if not text:
        return "本段展示商品/项目与讲解人的互动，结尾自然承接下一段。"
    text = re.sub(r"素材说明：.*?。", "", text)
    text = re.sub(r"分段拼接要求：.*?。", "", text)
    text = re.sub(r"片段\s*\d+/\d+，负责总视频\s*\d+-\d+\s*秒内容，时长\s*\d+\s*秒。", "", text)
    text = re.sub(r"本段负责[^。]*。", "", text)
    text = re.sub(r"最后一张参考图是上一段视频抽帧生成的六宫格前情提要[^。]*。", "", text)
    text = re.sub(r"前情提要参考图：[^。]*。", "", text)
    timed_parts = [
        match.group(0)
        for match in re.finditer(
            rf"{_ECOMMERCE_TIME_RANGE_PATTERN}\s*.*?{_ECOMMERCE_TIME_RANGE_LOOKAHEAD}",
            text,
            flags=re.DOTALL | re.IGNORECASE,
        )
    ]
    if timed_parts:
        recap = " ".join(part.strip() for part in timed_parts[:3])
    else:
        sentences = [item.strip() for item in re.split(r"[。！？!?]\s*", text) if item.strip()]
        useful = [
            item
            for item in sentences
            if not any(noise in item for noise in ("禁止", "必须", "要求", "不要", "参考图编号", "品类模板"))
        ]
        recap = "。".join((useful or sentences)[:3])
    recap = re.sub(r"\s+", " ", recap).strip(" ，。")
    lowered = recap + text
    subject_groups = [
        ("热水器", "热水器"),
        ("房屋", "房屋"),
        ("楼盘", "楼盘"),
        ("公寓", "公寓"),
        ("汽车", "汽车"),
        ("车辆", "汽车"),
        ("服装", "服装"),
        ("衣服", "服装"),
    ]
    feature_groups = [
        ("恒温", "恒温"),
        ("大水量", "大水量"),
        ("稳定水流", "稳定水流"),
        ("多点用水", "多点用水"),
        ("外立面", "外立面"),
        ("外观", "外观"),
        ("交通", "交通"),
        ("配套", "配套"),
        ("采光", "采光"),
        ("空间", "空间"),
        ("整车", "整车外观"),
        ("车身", "车身线条"),
        ("车灯", "车灯"),
        ("轮毂", "轮毂"),
        ("内饰", "内饰"),
        ("中控", "中控"),
        ("上身", "上身效果"),
        ("版型", "版型"),
        ("面料", "面料"),
        ("搭配", "搭配"),
        ("质地", "质地"),
        ("妆效", "妆效"),
        ("肤感", "肤感"),
        ("包装", "包装"),
    ]
    scene_groups = [("浴室", "浴室"), ("厨房", "厨房"), ("客厅", "客厅"), ("卧室", "卧室")]
    subjects: list[str] = []
    features: list[str] = []
    scenes: list[str] = []
    for needle, label in subject_groups:
        if needle in lowered and label not in subjects:
            subjects.append(label)
    for needle, label in feature_groups:
        if needle in lowered and label not in features:
            features.append(label)
    for needle, label in scene_groups:
        if needle in lowered and label not in scenes:
            scenes.append(label)
    if subjects or features or scenes:
        presenter = "讲解人"
        if any(word in lowered for word in ("女销售", "女顾问", "女讲解", "女模特")):
            presenter = "女销售员"
        elif any(word in lowered for word in ("男销售", "男顾问", "男讲解", "男模特")):
            presenter = "男销售员"
        elif any(word in lowered for word in ("销售", "顾问", "讲解", "模特")):
            presenter = "讲解人"
        subject = subjects[0] if subjects else "产品"
        details = features[:4] if features else scenes[:3]
        if details:
            detail_text = "、".join(details[:-1]) + ("与" + details[-1] if len(details) > 1 else details[0])
            summary = f"{presenter}介绍了{subject}{detail_text}的卖点"
        else:
            summary = f"{presenter}介绍了{subject}的核心卖点"
        return summary[:max_chars].rstrip("，。、与")
    if any(word in lowered for word in ("销售", "讲解", "介绍", "顾问", "模特")):
        if any(word in lowered for word in ("指向", "拿", "翻转", "展示", "水流", "面板", "机身")):
            return "人物展示核心卖点"[:max_chars]
        return "人物讲解产品内容"[:max_chars]
    if len(recap) > max_chars:
        recap = recap[:max_chars].rstrip(" ，。")
    if not recap:
        recap = f"本段围绕商品/项目完成第 {segment_index} 段展示，人物动作和镜头方向需要由下一段自然承接。"
    return recap


@lru_cache(maxsize=128)
def _load_storyboard_font(size: int, *, bold: bool = False) -> ImageFont.ImageFont:
    bold_candidates = [
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    regular_candidates = [
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    candidates = [*bold_candidates, *regular_candidates] if bold else regular_candidates
    for candidate in candidates:
        try:
            path = Path(candidate)
            if path.exists():
                return ImageFont.truetype(str(path), size=size)
        except Exception:
            continue
    return ImageFont.load_default()


def _wrap_storyboard_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.ImageFont,
    max_width: int,
) -> list[str]:
    raw = re.sub(r"\s+", " ", str(text or "").strip())
    if not raw:
        return []
    leading_punctuation = set("，。！？：；、）】》”’,.!?:;)%")
    lines: list[str] = []
    current = ""
    for char in raw:
        candidate = current + char
        try:
            width = draw.textbbox((0, 0), candidate, font=font)[2]
        except Exception:
            width = len(candidate) * 16
        if current and width > max_width:
            if char in leading_punctuation:
                lines.append(candidate)
                current = ""
            else:
                lines.append(current)
                current = char
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def _resolve_ffmpeg_exe(ffmpeg_path: str = "") -> str:
    ffmpeg = str(ffmpeg_path or shutil.which("ffmpeg") or "").strip()
    if ffmpeg:
        return ffmpeg
    try:
        import imageio_ffmpeg

        return str(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception as exc:
        raise VideoDependencyError("缺少 ffmpeg，无法生成广告前情六宫格") from exc


def _probe_video_duration_seconds(
    video_path: Path,
    default_seconds: float = 15.0,
    *,
    ffmpeg_path: str = "",
    run_process: Callable[..., Any] = subprocess.run,
) -> float:
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        proc = run_process(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(video_path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        try:
            value = float(str(proc.stdout or "").strip())
            if value > 0:
                return value
        except Exception:
            pass
    ffmpeg = _resolve_ffmpeg_exe(ffmpeg_path)
    proc = run_process(
        [ffmpeg, "-i", str(video_path)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", f"{proc.stderr}\n{proc.stdout}")
    if match:
        return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))
    return max(float(default_seconds or 15.0), 1.0)


def _build_ecommerce_storyboard_sheet(
    *,
    video_path: Path,
    output_path: Path,
    segment_index: int,
    segment_duration: int,
    summary: str,
    ratio: str,
    include_annotations: bool = True,
    context: VideoTaskContext | None = None,
    ffmpeg_path: str = "",
    run_process: Callable[..., Any] = subprocess.run,
    probe_duration: Callable[[Path], float] | None = None,
) -> Path:
    """Build the source platform's six-frame continuity sheet.

    The first seven arguments preserve the original contract.  The optional
    context and dependency hooks make the extracted helper cancellable and
    locally testable without a provider.
    """

    del ratio  # Preserved for source-call compatibility; layout follows source frames.
    if context is not None:
        context.check_cancelled()
    ffmpeg = _resolve_ffmpeg_exe(ffmpeg_path)
    video_path = Path(video_path).expanduser().resolve()
    output_path = Path(output_path).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    frame_dir = output_path.parent / f"{output_path.stem}_frames"
    if frame_dir.exists():
        shutil.rmtree(frame_dir)
    frame_dir.mkdir(parents=True, exist_ok=True)
    try:
        if probe_duration is not None:
            probed = float(probe_duration(video_path) or 0.0)
        else:
            probed = _probe_video_duration_seconds(
                video_path,
                default_seconds=float(segment_duration),
                ffmpeg_path=ffmpeg,
                run_process=run_process,
            )
        duration = probed if probed > 0 else max(float(segment_duration), 1.0)
        interval = max(duration / 6.0, 0.1)
        frame_paths: list[Path] = []
        for idx in range(6):
            if context is not None:
                context.check_cancelled()
            timestamp = min(idx * interval, max(duration - 0.1, 0.0))
            frame_path = frame_dir / f"frame_{idx + 1}.jpg"
            proc = run_process(
                [
                    ffmpeg,
                    "-y",
                    "-ss",
                    f"{timestamp:.3f}",
                    "-i",
                    str(video_path),
                    "-frames:v",
                    "1",
                    "-q:v",
                    "2",
                    str(frame_path),
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            if context is not None:
                context.check_cancelled()
            if proc.returncode == 0 and frame_path.exists():
                frame_paths.append(frame_path)
        if not frame_paths:
            raise RuntimeError("未能从广告短视频片段中抽取前情六宫格帧")
        with Image.open(frame_paths[0]) as first_image:
            first = first_image.convert("RGB")
        source_w, source_h = first.size
        cell_w = min(max(source_w, 360), 640)
        cell_h = max(int(cell_w * source_h / max(source_w, 1)), 1)
        grid_cols, grid_rows = 3, 2
        gap = 12
        margin = 18
        title_font = _load_storyboard_font(28)
        body_font = _load_storyboard_font(24)
        bg_color = "#f8fafc"
        border_color = "#cbd5e1"
        temp = Image.new("RGB", (cell_w * grid_cols + gap * 2 + margin * 2, 400), bg_color)
        temp_draw = ImageDraw.Draw(temp)
        summary_title = f"片段 {segment_index} 前情六宫格"
        summary_text = f"前情提要：{summary}"
        lines = _wrap_storyboard_text(temp_draw, summary_text, body_font, cell_w * grid_cols + gap * 2)
        line_height = 34
        text_h = 54 + max(len(lines), 1) * line_height + margin if include_annotations else 0
        canvas_w = cell_w * grid_cols + gap * 2 + margin * 2
        canvas_h = cell_h * grid_rows + gap + margin * 2 + text_h
        canvas = Image.new("RGB", (canvas_w, canvas_h), bg_color)
        draw = ImageDraw.Draw(canvas)
        labels = ["首帧", "过程1", "过程2", "过程3", "过程4", "尾帧"]
        for idx in range(6):
            if context is not None:
                context.check_cancelled()
            src_path = frame_paths[min(idx, len(frame_paths) - 1)]
            with Image.open(src_path) as opened:
                image = opened.convert("RGB").resize((cell_w, cell_h), Image.Resampling.LANCZOS)
            x = margin + (idx % grid_cols) * (cell_w + gap)
            y = margin + (idx // grid_cols) * (cell_h + gap)
            canvas.paste(image, (x, y))
            draw.rectangle((x, y, x + cell_w, y + cell_h), outline=border_color, width=2)
            if include_annotations:
                label = labels[idx]
                label_w = draw.textbbox((0, 0), label, font=body_font)[2] + 24
                draw.rectangle((x + 12, y + 12, x + 12 + label_w, y + 52), fill="#e0e7ff")
                draw.text((x + 24, y + 17), label, fill="#111827", font=body_font)
        if include_annotations:
            text_y = margin + cell_h * grid_rows + gap + 28
            draw.text((margin, text_y), summary_title, fill="#1e3a8a", font=title_font)
            text_y += 44
            for line in lines[:6]:
                draw.text((margin, text_y), line, fill="#111827", font=body_font)
                text_y += line_height
        if context is not None:
            context.check_cancelled()
        canvas.save(output_path)
        return output_path.resolve()
    finally:
        shutil.rmtree(frame_dir, ignore_errors=True)


__all__ = [
    "_build_ecommerce_storyboard_sheet",
    "_ecommerce_storyboard_recap_from_prompt",
]
