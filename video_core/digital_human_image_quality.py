from __future__ import annotations

import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from PIL import Image, ImageFilter, ImageStat

from .contracts import VideoTaskCancelled, VideoTaskContext


ImageGenerateCallback = Callable[[str, dict[str, Any]], dict[str, Any]]
VisualSemanticLLMCallback = Callable[..., tuple[dict[str, Any], Any, Any]]


def _env_int(name: str, default: int) -> int:
    try:
        return int(str(os.getenv(name, str(default)) or "").strip() or str(default))
    except Exception:
        return int(default)


def _env_float(name: str, default: float) -> float:
    try:
        return float(str(os.getenv(name, str(default)) or "").strip() or str(default))
    except Exception:
        return float(default)


REAL_ESTATE_DH_IMAGE_QA_MAX_ATTEMPTS = min(
    max(_env_int("REAL_ESTATE_DH_IMAGE_QA_MAX_ATTEMPTS", 5), 3), 8
)
REAL_ESTATE_DH_MIN_FACE_HEIGHT_PCT = min(
    max(_env_float("REAL_ESTATE_DH_MIN_FACE_HEIGHT_PCT", 20.0), 10.0), 45.0
)


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return int(default)


def _to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on", "y"}:
        return True
    if text in {"0", "false", "no", "off", "n"}:
        return False
    return bool(default)


def _qa_issue(
    code: str,
    severity: str,
    message: str,
    suggestion: str = "",
    *,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "code": str(code or "unknown"),
        "severity": str(severity or "warning"),
        "message": str(message or "").strip(),
        "suggestion": str(suggestion or "").strip(),
        "data": data or {},
    }


def _qa_status_from_issues(issues: list[dict[str, Any]]) -> str:
    severities = {str(issue.get("severity") or "").lower() for issue in issues}
    if "high" in severities or "critical" in severities:
        return "rejected"
    if "medium" in severities or "warning" in severities:
        return "warning"
    return "passed"


_DIGITAL_HUMAN_VISUAL_COPY_ONLY_KEYS = {
    "product_details",
    "product_description",
    "product_intro",
    "speech_text",
    "message",
    "copy_text",
    "prompt_text",
    "user_prompt",
    "tg_user_instruction",
    "ai_copy",
}


def _digital_human_visual_payload(
    payload: dict[str, Any] | None,
) -> dict[str, Any]:
    """Remove copy-only fields before image fusion, matching the source server."""

    cleaned = dict(payload or {})
    for key in _DIGITAL_HUMAN_VISUAL_COPY_ONLY_KEYS:
        cleaned.pop(key, None)
    return cleaned


def _normalize_product_category(value: Any) -> str:
    text = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if text in {"real_estate", "realestate", "property", "房地产", "房产"}:
        return "real_estate"
    return text


def _digital_human_clean_reference_image_rule() -> str:
    return (
        "数字人口播图像只生成干净的画面参考图，不得出现任何可读文字、字幕、台词文字、卖点文案、标题、标签、"
        "气泡框、讲解牌、广告牌、地址、出租/出售/预约/价格/参数文字、中文/日文/英文促销短句、话题符号、时间码、"
        "播放器控件、播放按钮、暂停按钮、音量条、进度条、黑色半透明字幕底板、水印、界面截图或社交媒体视频框。"
        "不能出现字幕、台词文字、卖点文案、标题、标签、时间码、播放器控件、进度条。"
        "如果参考图、口播稿或用户简介里含有文字、卖点、地址或产品详情，只能作为口播理解，不得转写、翻译、摘要或画成图中文字。"
    )


def _detect_digital_human_face_metrics(image_path: Path) -> dict[str, Any]:
    metrics: dict[str, Any] = {"enabled": False, "faces": []}
    try:
        import cv2  # type: ignore

        image = cv2.imread(str(image_path))
        if image is None:
            metrics["error"] = "image_read_failed"
            return metrics
        height, width = image.shape[:2]
        if width <= 0 or height <= 0:
            metrics["error"] = "invalid_image_size"
            return metrics
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        detector = cv2.CascadeClassifier(cascade_path)
        if detector.empty():
            metrics["error"] = "face_detector_unavailable"
            return metrics
        faces = detector.detectMultiScale(
            gray, scaleFactor=1.05, minNeighbors=4, minSize=(80, 80)
        )
        normalized_faces: list[dict[str, Any]] = []
        for x, y, face_width, face_height in faces:
            normalized_faces.append(
                {
                    "x": int(x),
                    "y": int(y),
                    "width": int(face_width),
                    "height": int(face_height),
                    "height_pct": round(
                        (float(face_height) / float(height)) * 100.0, 2
                    ),
                    "area_pct": round(
                        (float(face_width * face_height) / float(width * height))
                        * 100.0,
                        2,
                    ),
                }
            )
        normalized_faces.sort(
            key=lambda item: float(item.get("height_pct") or 0.0), reverse=True
        )
        metrics.update(
            {
                "enabled": True,
                "width": int(width),
                "height": int(height),
                "faces": normalized_faces,
                "max_face_height_pct": (
                    float(normalized_faces[0]["height_pct"])
                    if normalized_faces
                    else 0.0
                ),
                "min_required_face_height_pct": float(
                    REAL_ESTATE_DH_MIN_FACE_HEIGHT_PCT
                ),
            }
        )
    except Exception as exc:
        metrics["error"] = str(exc)[:240]
    return metrics


def _qa_real_estate_digital_human_image(
    image_path: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    metrics: dict[str, Any] = {"path": str(image_path)}
    try:
        with Image.open(image_path) as image:
            rgb = image.convert("RGB")
            width, height = rgb.size
            metrics["width"] = width
            metrics["height"] = height
            if width <= 0 or height <= 0:
                issues.append(
                    _qa_issue(
                        "real_estate_image_unreadable",
                        "high",
                        "房产数字人图像尺寸异常",
                        "请重新生成。",
                    )
                )
                return issues, metrics
            # Detect white-film / render placeholder backgrounds in the far side of real-estate exteriors.
            # The target defect is a large bright, low-saturation, low-detail area where real city/building detail should exist.
            candidate_boxes = {
                "right_mid_far_background": (0.78, 0.32, 1.00, 0.55),
                "right_upper_far_background": (0.72, 0.25, 0.95, 0.45),
                "right_lower_far_background": (0.78, 0.35, 1.00, 0.62),
                "right_bottom_render_background": (0.74, 0.58, 1.00, 0.90),
                "right_lower_corner_render_background": (0.82, 0.58, 1.00, 0.88),
            }
            region_metrics: dict[str, dict[str, float]] = {}
            for name, box in candidate_boxes.items():
                x1, y1, x2, y2 = box
                crop = rgb.crop(
                    (
                        int(width * x1),
                        int(height * y1),
                        int(width * x2),
                        int(height * y2),
                    )
                )
                if crop.width < 8 or crop.height < 8:
                    continue
                gray = crop.convert("L")
                sat = crop.convert("HSV").split()[1]
                edges = gray.filter(ImageFilter.FIND_EDGES)
                stat_gray = ImageStat.Stat(gray)
                stat_sat = ImageStat.Stat(sat)
                stat_edges = ImageStat.Stat(edges)
                item = {
                    "mean_luma": float(
                        stat_gray.mean[0] if stat_gray.mean else 0.0
                    ),
                    "std_luma": float(
                        stat_gray.stddev[0] if stat_gray.stddev else 0.0
                    ),
                    "mean_saturation": float(
                        stat_sat.mean[0] if stat_sat.mean else 0.0
                    ),
                    "edge_mean": float(
                        stat_edges.mean[0] if stat_edges.mean else 0.0
                    ),
                }
                region_metrics[name] = item
            metrics["real_estate_regions"] = region_metrics
            for name, item in region_metrics.items():
                mean_luma = float(item.get("mean_luma") or 0)
                std_luma = float(item.get("std_luma") or 0)
                mean_saturation = float(item.get("mean_saturation") or 0)
                edge_mean = float(item.get("edge_mean") or 0)
                if (
                    mean_luma >= 232
                    and mean_saturation <= 42
                    and edge_mean <= 9
                ) or (
                    mean_luma >= 220
                    and std_luma <= 28
                    and mean_saturation <= 36
                    and edge_mean <= 12
                ) or (
                    mean_luma >= 190
                    and std_luma <= 35
                    and mean_saturation <= 18
                    and edge_mean <= 13
                ):
                    issues.append(
                        _qa_issue(
                            "real_estate_white_film_background",
                            "high",
                            "房产数字人图像远景存在白膜/低细节几何背景风险",
                            "必须重跑：远处建筑和街区应有真实窗户、墙面、路缘、路牌、阴影和材质细节，不能是发白的渲染占位体。",
                            data={"region": name, **item},
                        )
                    )
                    break
            face_metrics = _detect_digital_human_face_metrics(image_path)
            metrics["face_detection"] = face_metrics
            if face_metrics.get("enabled"):
                max_face_height_pct = float(
                    face_metrics.get("max_face_height_pct") or 0.0
                )
                min_required = float(
                    face_metrics.get("min_required_face_height_pct")
                    or REAL_ESTATE_DH_MIN_FACE_HEIGHT_PCT
                )
                if max_face_height_pct <= 0:
                    issues.append(
                        _qa_issue(
                            "real_estate_face_not_detected",
                            "high",
                            "房产数字人图像未检测到清晰可识别的人脸",
                            "必须重跑：人物需面向镜头或三分之二正面，脸部、眼睛和嘴部清晰可见。",
                            data=face_metrics,
                        )
                    )
                elif max_face_height_pct < min_required:
                    issues.append(
                        _qa_issue(
                            "real_estate_face_too_small",
                            "high",
                            f"房产数字人图像人物脸部占比过小：{max_face_height_pct:.1f}% < {min_required:.1f}%",
                            "必须重跑：推近机位或裁掉更多背景、地面、墙面、楼体和下半身，优先保证人脸不小于参考图。",
                            data=face_metrics,
                        )
                    )
    except Exception as exc:
        issues.append(
            _qa_issue(
                "real_estate_image_qa_failed",
                "medium",
                f"房产数字人图像 QA 读取失败：{exc}",
                "请人工检查成品图。",
            )
        )
    return issues, metrics


def _real_estate_visual_semantic_issue_severity(
    parsed: dict[str, Any],
) -> str:
    raw_issues = (
        parsed.get("issues") if isinstance(parsed.get("issues"), list) else []
    )
    parts = [str(item or "") for item in raw_issues]
    parts.extend(
        [
            str(parsed.get("reason") or ""),
            str(parsed.get("person_integration") or ""),
            str(parsed.get("background_realism") or ""),
        ]
    )
    text = " ".join(parts).lower()
    score_matches = [
        float(item)
        for item in re.findall(
            r"\bscore\s*[:：]?\s*(\d+(?:\.\d+)?)\s*/\s*10\b", text
        )
    ]
    if any(score <= 4.0 for score in score_matches):
        return "high"
    severe_markers = (
        "obvious",
        "severe",
        "strong",
        "clearly",
        "identity mismatch",
        "different person",
        "different face",
        "different gender",
        "different ethnicity",
        "reference person",
        "scene mismatch",
        "different building",
        "different property",
        "different scene",
        "hard cutout",
        "paper",
        "cardboard",
        "floating",
        "white edge",
        "subtitle",
        "caption",
        "timecode",
        "timestamp",
        "progress bar",
        "playback control",
        "video player",
        "ui overlay",
        "sharp cutout",
        "unrealistic foot",
        "scale mismatch",
        "wrong scale",
        "too short",
        "miniature",
        "tiny person",
        "ground plane mismatch",
        "wrong ground plane",
        "curb reaches knee",
        "curb at knee",
        "knee-high curb",
        "curb too high",
        "road curb",
        "sidewalk curb",
        "perspective scale",
        "scale/perspective",
        "严重",
        "明显",
        "身份不一致",
        "不是同一个人",
        "人物不像",
        "换脸",
        "性别不一致",
        "人种不一致",
        "场景不一致",
        "不是同一栋",
        "换了房子",
        "换了建筑",
        "换了场景",
        "纸片",
        "漂浮",
        "白边",
        "字幕",
        "字幕条",
        "台词文字",
        "时间码",
        "进度条",
        "播放器",
        "播放控件",
        "视频界面",
        "黑色半透明",
        "硬边",
        "锐利抠图",
        "脚底未贴合",
        "透视错误",
        "尺度错误",
        "比例错误",
        "人物太矮",
        "人物过小",
        "像小人",
        "小人",
        "缩小",
        "路牙到膝盖",
        "路缘石到膝盖",
        "路牙高到膝盖",
        "路缘高到膝盖",
        "路牙",
        "路缘石",
        "地面平面不一致",
        "地平面错误",
        "不真实",
    )
    mild_markers = (
        "slight",
        "slightly",
        "moderate",
        "fair",
        "minor",
        "mostly realistic",
        "acceptable",
        "一般",
        "轻微",
        "略微",
        "基本真实",
        "可接受",
    )
    if any(marker in text for marker in severe_markers):
        return "high"
    if any(marker in text for marker in mild_markers):
        return "medium"
    return "high"


def _qa_real_estate_digital_human_visual_semantics(
    image_path: Path,
    *,
    source: dict[str, Any] | None = None,
    visual_semantic_llm: VisualSemanticLLMCallback | None = None,
    context: VideoTaskContext | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    metrics: dict[str, Any] = {"path": str(image_path), "enabled": False}
    if not image_path.exists() or not image_path.is_file():
        return issues, metrics
    if (
        source is not None
        and _to_bool(source.get("real_estate_visual_qa_enabled"), True) is False
    ):
        metrics["skipped"] = "disabled"
        return issues, metrics
    reference_paths: list[str] = []
    model_ref = Path(
        str((source or {}).get("model_image_local_path") or "")
    ).expanduser()
    product_ref = Path(
        str(
            (source or {}).get("product_image_local_path")
            or (source or {}).get("image_local_path")
            or ""
        )
    ).expanduser()
    if model_ref.exists() and model_ref.is_file():
        reference_paths.append(str(model_ref.resolve()))
    if (
        product_ref.exists()
        and product_ref.is_file()
        and str(product_ref.resolve()) not in reference_paths
    ):
        reference_paths.append(str(product_ref.resolve()))
    has_references = bool(reference_paths)
    system_prompt = (
        "你是房产数字人口播图像质检员。只输出严格 JSON，不要代码块。"
        '输出字段固定为 {"passed": boolean, "issues": string[], "person_identity": string, "scene_fidelity": string, "person_integration": string, "background_realism": string, "reason": string}。'
        "请严格检查图片是否适合作为房产数字人口播分镜。重点判断："
        "1 若提供参考图，必须检查成品人物是否保持参考人物身份，包括性别、年龄段、人种/地区气质、五官、发型、眼镜和服装气质；如果明显换成另一个人，passed=false。"
        "2 若提供房源/场景参考图，必须检查成品是否仍是同一房源/同一建筑/同一关键场景，只允许真实化重建效果图质感；如果换成另一栋楼、另一条街或完全不同场景，passed=false。"
        "3 人物是否像真实站在现场，而不是平面人像贴图、抠图贴片、纸片人或棚拍人像贴到背景上；"
        "4 人物脸部、头发、衣服、手部的光照方向、色温、对比度、阴影是否与街道、树影、楼体一致；"
        "5 人物脚底/下半身若出现，是否有合理接触阴影和透视，不漂浮、不像贴在画面前景；"
        "6 人物尺度是否和路牙、路缘石、台阶、人行道、入口门、车辆、树木一致；必须先找画面前景最高的路牙/混凝土挡边/平台边缘，估计它相对人物脚踝、小腿、膝盖的位置。"
        "如果任何前景路牙/路缘石/挡边在人物身体纵向上达到膝盖或大腿附近、人物明显太矮、像小人，或人物与道路不在同一地面平面，passed=false，不能解释为正常透视；"
        "7 人物边缘是否有自然环境反射光、景深/空气透视过渡，而不是硬边、白边、锐利抠图边；"
        "8 背景是否真实，不是白膜、低细节几何块、CG 渲染、效果图或广告合成背景。"
        "9 成品必须是干净画面参考图，不能出现字幕、台词文字、卖点文案、标题、标签、时间码、播放器控件、进度条、黑色半透明字幕底板、水印或视频界面；出现则 passed=false。"
        "10 如果房源/场景主体参考图是外景、建筑外观、楼盘外立面、项目入口或完整房屋主体，成品也必须让人完整观察并识别同一建筑/房屋/项目主体。"
        "如果成品切成室内房间、厨房、客厅、样板间、只从窗户看到一小块外景、人物遮挡主体导致建筑不可识别，或只拍局部入口而看不清整体房源，passed=false。"
        "同一人或同一房源明显不一致时必须判 failed；只有轻微融合瑕疵但身份和场景正确时，可判 failed 并描述为 slight/moderate，系统会按警告处理。"
    )
    if has_references:
        user_input = (
            "请质检这些图片：@Image 1 是生成成品，@Image 2 是用户上传的模特/人物参考图，"
            "@Image 3 是用户上传的房源/场景主体参考图。必须判断成品是否仍是同一个人、同一房源/场景，并判断融合真实度。"
        )
    else:
        user_input = "请质检这张房产数字人口播图像，判断人物是否真实融入场景。"
    try:
        if context is not None:
            context.check_cancelled()
        if visual_semantic_llm is None:
            raise RuntimeError("visual semantic LLM callback is unavailable")
        result, selected, attempts = visual_semantic_llm(
            source=source or {},
            user_input=user_input,
            system_prompt=system_prompt,
            parameters="",
            image_paths=[str(image_path), *reference_paths],
            allow_builtin=True,
            request_label="房产数字人图像视觉QA",
        )
        if context is not None:
            context.check_cancelled()
        parsed = result.get("parsed") if isinstance(result, dict) else None
        metrics.update(
            {
                "enabled": True,
                "llm_selected": selected,
                "llm_attempts": attempts,
                "raw": parsed or result,
            }
        )
        if isinstance(parsed, dict) and parsed.get("passed") is False:
            severity = _real_estate_visual_semantic_issue_severity(parsed)
            raw_issues = (
                parsed.get("issues")
                if isinstance(parsed.get("issues"), list)
                else []
            )
            issue_text = "；".join(
                str(item).strip() for item in raw_issues if str(item).strip()
            )
            if not issue_text:
                issue_text = str(
                    parsed.get("reason") or "人物与场景融合不真实"
                ).strip()
            message = (
                "房产数字人图像人物融合不真实，存在平面贴图/抠图感风险"
                if severity in {"high", "critical"}
                else "房产数字人图像人物融合存在轻微贴图感，建议人工确认"
            )
            suggestion = (
                "必须重跑：人物需要重新受现场光照影响，脚底接触阴影、边缘环境反射光、色温、对比度和景深都要与场景一致。"
                if severity in {"high", "critical"}
                else "结果可保留：若后续视频效果仍显得像贴图，再重新生成；建议优先使用中近景或膝上构图。"
            )
            issues.append(
                _qa_issue(
                    "real_estate_person_pasted_flat",
                    severity,
                    message,
                    suggestion,
                    data={
                        "issues": raw_issues,
                        "reason": str(parsed.get("reason") or ""),
                        "person_identity": str(
                            parsed.get("person_identity") or ""
                        ),
                        "scene_fidelity": str(
                            parsed.get("scene_fidelity") or ""
                        ),
                        "person_integration": str(
                            parsed.get("person_integration") or ""
                        ),
                        "background_realism": str(
                            parsed.get("background_realism") or ""
                        ),
                    },
                )
            )
    except VideoTaskCancelled:
        raise
    except Exception as exc:
        metrics.update({"enabled": False, "error": str(exc)[:240]})
    return issues, metrics


def _real_estate_digital_human_retry_prompt_suffix(
    issues: list[dict[str, Any]], *, attempt: int = 2
) -> str:
    issue_text = "；".join(
        str(item.get("message") or item.get("code") or "")
        for item in issues
        if item
    )
    attempt_no = max(int(attempt or 2), 2)
    return (
        f"上一版生成结果不合格：{issue_text}。这是第 {attempt_no} 次自动重生成，必须明显修正上一版问题。"
        "采用更稳妥的真实带看构图：人物站在入口旁、树荫边缘、檐下阴影或人行道安全区，使用平视头肩近景、胸像近景或胸口到上腰部近景，人物脸部和上半身清楚；减少远处空白街道和大面积亮天空。"
        "如果上一版问题涉及人脸未检测到、人脸过小、人物太远或空间占比过大，必须把相机推近到人脸清晰可见：脸部高度至少占画面高度 20%，建议 22%-30%；"
        "允许裁掉完整楼体、窗户、地面、道路、墙面、室内空白和人物下半身，不允许为了展示完整空间牺牲人脸占比。"
        "如果问题涉及人物贴图感，必须重新把人物作为现场照片中的真人生成：只保留参考人物身份和服装气质，不复制原人像轮廓、边缘、棚拍光或背景；"
        "不要沿用人物参考图原本的棚拍/室内光照；人物脸部、头发、衣服、手部要按当前柔和日光、树荫或入口阴影重新受光，衣服暗部、脸部高光、手部阴影和背景光源方向一致；"
        "不强制露出完整脚部；如果露脚，脚底必须真实压在路面/入口平台上，有接触阴影和与树影、车辆阴影同方向的投影；如果脚部难以自然融合，直接裁到膝部以上。人物边缘要有环境反射光、空气透视和自然景深过渡，不能有硬边、白边、纸片感或前景贴片感。"
        "如果上一版人物尺度或地面平面错误，必须把人物放到同一人行道/入口地面上重新校准：路牙、路缘石、台阶和平台边缘只能在脚踝到小腿以下高度，不能到膝盖；人物不能像小人、不能被路牙遮到膝盖。"
        "这次必须把远景和背景做成真实现场照片：远处建筑不能是白膜、灰膜、透明块、低细节几何体或渲染占位；"
        "右侧和右下角不能出现半透明白色建筑块、白雾边缘、发灰远景或低饱和渲染背景；"
        "必须补足真实窗户、墙面接缝、栏杆、路牌、电线、路缘石、道路纹理、树影和自然阴影。"
        "如果素材本身像效果图/白膜渲染，不要继续在原效果图上贴人物；只保留建筑、入口和道路绿化位置，重建为普通手机/相机实拍现场，再把人物按同一曝光重新生成进去。"
        "光影优先使用柔和阴天、树荫或入口阴影下的真实现场光，不能像渲染器全局光、棚拍补光、强烈正午阳光、过亮蓝天、白雾、虚假光晕或广告效果图。"
        "外景用平视真实看房记录感，退后到街对面、入口前或庭院，必须让建筑主体、入口和道路关系完整可辨；不能改成室内带窗外景、只拍局部入口或只露一小块外立面。"
        f"{_digital_human_clean_reference_image_rule()}"
    )


def run_digital_human_image_generate_with_quality_gate(
    task_id: str,
    payload: dict[str, Any],
    *,
    product_category: Any,
    generate_image: ImageGenerateCallback,
    visual_semantic_llm: VisualSemanticLLMCallback | None = None,
    context: VideoTaskContext | None = None,
) -> dict[str, Any]:
    """Generate a digital-human image and apply the source real-estate QA loop."""

    if not callable(generate_image):
        raise TypeError("generate_image must be callable")
    payload = _digital_human_visual_payload(payload)
    if _to_bool(
        (payload or {}).get("real_estate_image_qa_enabled"), True
    ) is False or _to_bool((payload or {}).get("web_image_qa_enabled"), True) is False:
        if context is not None:
            context.check_cancelled()
        return generate_image(task_id, payload)
    if _normalize_product_category(product_category) != "real_estate":
        if context is not None:
            context.check_cancelled()
        return generate_image(task_id, payload)
    base_prompt = str(
        payload.get("prompt")
        or payload.get("prompt_text")
        or payload.get("message")
        or ""
    ).strip()
    last_issues: list[dict[str, Any]] = []
    last_metrics: dict[str, Any] = {}
    max_attempts = max(
        _to_int(
            payload.get("real_estate_image_qa_max_attempts"),
            REAL_ESTATE_DH_IMAGE_QA_MAX_ATTEMPTS,
        ),
        3,
    )
    max_attempts = min(max_attempts, 8)
    for attempt in range(1, max_attempts + 1):
        if context is not None:
            context.check_cancelled()
        attempt_payload = dict(payload)
        if attempt > 1:
            attempt_payload["prompt"] = (
                base_prompt
                + _real_estate_digital_human_retry_prompt_suffix(
                    last_issues, attempt=attempt
                )
            )
        attempt_task_id = (
            task_id if attempt == 1 else f"{task_id}_qa_retry{attempt}"
        )
        result = generate_image(attempt_task_id, attempt_payload)
        if context is not None:
            context.check_cancelled()
        if not isinstance(result, dict):
            raise TypeError("generate_image must return a dict")
        image_path = Path(
            str(result.get("image_path") or result.get("download_path") or "")
        ).resolve()
        issues, metrics = _qa_real_estate_digital_human_image(image_path)
        semantic_issues, semantic_metrics = (
            _qa_real_estate_digital_human_visual_semantics(
                image_path,
                source=attempt_payload,
                visual_semantic_llm=visual_semantic_llm,
                context=context,
            )
        )
        issues.extend(semantic_issues)
        metrics["visual_semantics"] = semantic_metrics
        result["real_estate_image_qa"] = {
            "attempt": attempt,
            "status": _qa_status_from_issues(issues),
            "issues": issues,
            "metrics": metrics,
        }
        if not any(
            str(issue.get("severity") or "").lower() in {"high", "critical"}
            for issue in issues
        ):
            return result
        last_issues = issues
        last_metrics = metrics
    message = "；".join(
        str(issue.get("message") or issue.get("code") or "")
        for issue in last_issues
    ) or "房产数字人图像 QA 未通过"
    raise RuntimeError(
        f"房产数字人图像生成后 QA 未通过，已自动重试 {max_attempts - 1} 次：{message}"
    )


_run_digital_human_image_generate_with_quality_gate = (
    run_digital_human_image_generate_with_quality_gate
)


__all__ = [
    "REAL_ESTATE_DH_IMAGE_QA_MAX_ATTEMPTS",
    "REAL_ESTATE_DH_MIN_FACE_HEIGHT_PCT",
    "_detect_digital_human_face_metrics",
    "_qa_real_estate_digital_human_image",
    "_qa_real_estate_digital_human_visual_semantics",
    "_real_estate_digital_human_retry_prompt_suffix",
    "_real_estate_visual_semantic_issue_severity",
    "_run_digital_human_image_generate_with_quality_gate",
    "run_digital_human_image_generate_with_quality_gate",
]
