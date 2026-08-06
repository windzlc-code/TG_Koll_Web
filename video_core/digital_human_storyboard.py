from __future__ import annotations

import inspect
import json
import math
import re
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from .contracts import VideoTaskCancelled


__all__ = [
    "build_digital_human_view_sequence",
    "normalize_digital_human_segment_scripts",
]


_SCENE_LABELS = [
    "living",
    "kitchen",
    "bedroom",
    "bathroom",
    "balcony",
    "exterior",
    "vehicle_interior",
    "vehicle_exterior",
    "generic",
]


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _estimate_digital_human_short_script_seconds(script_text: str) -> int:
    text = re.sub(r"\s+", "", str(script_text or ""))
    if not text:
        return 15
    ascii_count = len(re.findall(r"[A-Za-z0-9]", text))
    weighted_units = max(len(text) - ascii_count, 0) + ascii_count * 0.55
    return max(4, min(180, int(math.ceil(weighted_units / 4.8)) + 1))


def _digital_human_storyboard_view_count(script_text: str) -> int:
    return 4


def _digital_human_segment_count(
    script_text: str,
    *,
    mode: str,
    max_segment_seconds: Any = 20,
    max_segments: Any = 8,
) -> int:
    if str(mode or "").strip().lower() == "storyboard":
        return _digital_human_storyboard_view_count(script_text)
    segment_seconds = max(_to_int(max_segment_seconds, 20), 8)
    segment_limit = max(_to_int(max_segments, 8), 1)
    estimated_seconds = _estimate_digital_human_short_script_seconds(script_text)
    return min(
        max(int(math.ceil(estimated_seconds / segment_seconds)), 1),
        segment_limit,
    )


def _split_digital_human_single_script_segments(
    text: str,
    count: int,
) -> list[str]:
    raw_source = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    total = max(int(count or 1), 1)
    explicit_lines = [line.strip() for line in raw_source.split("\n") if line.strip()]
    if len(explicit_lines) > 1:
        return explicit_lines
    source = re.sub(r"\s+", " ", raw_source).strip()
    if not source:
        return [""]
    if total <= 1:
        return [source]

    sentence_atoms = [
        item.strip()
        for item in re.findall(r"[^。！？!?；;]+[。！？!?；;]+|[^。！？!?；;]+$", source)
        if item.strip()
    ]
    if len(sentence_atoms) <= 1:
        return [source]
    if len(sentence_atoms) <= total:
        return sentence_atoms

    def _speech_weight(value: str) -> float:
        compact = re.sub(r"\s+", "", str(value or ""))
        if not compact:
            return 0.0
        ascii_count = len(re.findall(r"[A-Za-z0-9]", compact))
        return max(len(compact) - ascii_count, 0) + ascii_count * 0.55

    total_weight = sum(_speech_weight(atom) for atom in sentence_atoms)
    target_weight = total_weight / total if total_weight > 0 else len(source) / total
    segments: list[str] = []
    current_atoms: list[str] = []
    current_weight = 0.0
    for idx, atom in enumerate(sentence_atoms):
        current_atoms.append(atom)
        current_weight += _speech_weight(atom)
        remaining_atoms = len(sentence_atoms) - idx - 1
        remaining_segments = total - len(segments) - 1
        if remaining_segments <= 0:
            continue
        if remaining_atoms == remaining_segments or current_weight >= target_weight:
            segment = "".join(current_atoms).strip()
            if segment:
                segments.append(segment)
            current_atoms = []
            current_weight = 0.0
    tail = "".join(current_atoms).strip()
    if tail:
        segments.append(tail)
    return segments or [source]


def _split_text_into_weighted_segments(text: str, count: int) -> list[str]:
    raw_source = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    total = max(int(count or 1), 1)
    explicit_lines = [line.strip() for line in raw_source.split("\n") if line.strip()]
    if total > 1 and len(explicit_lines) == total:
        return explicit_lines
    source = re.sub(r"\s+", " ", raw_source).strip()
    if not source:
        return ["" for _ in range(total)]
    if total <= 1:
        return [source]

    def _balanced_character_segments(value: str, segment_count: int) -> list[str]:
        segment_count = max(int(segment_count or 1), 1)
        if segment_count <= 1:
            return [value]
        length = len(value)
        if length <= segment_count:
            return [value]
        boundaries = [0]
        min_size = max(8, int(length / segment_count * 0.55))
        for idx in range(1, segment_count):
            target_index = round(length * idx / segment_count)
            lower = max(boundaries[-1] + min_size, 1)
            upper = min(length - min_size * (segment_count - idx), length - 1)
            if lower > upper:
                cut = min(max(target_index, boundaries[-1] + 1), length - 1)
            else:
                candidates = [
                    pos + 1
                    for pos in range(lower, upper)
                    if value[pos] in "。！？!?；;，,、"
                ]
                cut = (
                    min(candidates, key=lambda pos: abs(pos - target_index))
                    if candidates
                    else min(max(target_index, lower), upper)
                )
            boundaries.append(cut)
        boundaries.append(length)
        return [
            value[boundaries[idx] : boundaries[idx + 1]]
            for idx in range(segment_count)
        ]

    def _speech_weight(value: str) -> float:
        compact = re.sub(r"\s+", "", str(value or ""))
        if not compact:
            return 0.0
        ascii_count = len(re.findall(r"[A-Za-z0-9]", compact))
        return max(len(compact) - ascii_count, 0) + ascii_count * 0.55

    atoms = [
        item.strip()
        for item in re.findall(r"[^。！？!?；;]+[。！？!?；;]?", source)
        if item.strip()
    ]
    if len(atoms) == 1 and total > 1 and _speech_weight(atoms[0]) > 28:
        soft_atoms = [
            item.strip()
            for item in re.findall(r"[^，,、]+[，,、]?", source)
            if item.strip()
        ]
        if len(soft_atoms) > 1:
            atoms = soft_atoms
    if not atoms:
        atoms = [source]
    while len(atoms) <= total:
        atom_weights = [_speech_weight(atom) for atom in atoms]
        nonzero_weights = [weight for weight in atom_weights if weight > 0]
        needs_split = len(atoms) < total and len(atoms) == 1
        if (
            len(atoms) == total
            and nonzero_weights
            and min(nonzero_weights) > 0
            and (
                max(nonzero_weights) / min(nonzero_weights) >= 1.9
                or max(len(atom) for atom in atoms)
                / max(min(len(atom) for atom in atoms), 1)
                >= 1.9
            )
        ):
            needs_split = True
        if not needs_split:
            break
        split_index = max(range(len(atoms)), key=lambda idx: atom_weights[idx])
        soft_atoms = [
            item.strip()
            for item in re.findall(r"[^，,、]+[，,、]?", atoms[split_index])
            if item.strip()
        ]
        if len(soft_atoms) <= 1:
            if len(atoms) < total and len(atoms[split_index]) > 1:
                pieces = _balanced_character_segments(atoms[split_index], 2)
                if len(pieces) > 1:
                    atoms = [
                        *atoms[:split_index],
                        *pieces,
                        *atoms[split_index + 1 :],
                    ]
                    continue
            break
        atoms = [*atoms[:split_index], *soft_atoms, *atoms[split_index + 1 :]]
        if len(atoms) > total:
            break
    if len(atoms) <= total:
        return atoms[:]

    weights = [_speech_weight(atom) for atom in atoms]
    prefix = [0.0]
    for weight in weights:
        prefix.append(prefix[-1] + weight)
    target = prefix[-1] / total if total else prefix[-1]

    def _range_weight(start: int, end: int) -> float:
        return prefix[end] - prefix[start]

    dp: list[list[float]] = [
        [float("inf")] * (len(atoms) + 1) for _ in range(total + 1)
    ]
    back: list[list[int]] = [
        [-1] * (len(atoms) + 1) for _ in range(total + 1)
    ]
    dp[0][0] = 0.0
    for group_count in range(1, total + 1):
        for end in range(group_count, len(atoms) + 1):
            for start in range(group_count - 1, end):
                segment_weight = _range_weight(start, end)
                score = dp[group_count - 1][start] + (segment_weight - target) ** 2
                if score < dp[group_count][end]:
                    dp[group_count][end] = score
                    back[group_count][end] = start

    boundaries: list[tuple[int, int]] = []
    end = len(atoms)
    for group_count in range(total, 0, -1):
        start = back[group_count][end]
        if start < 0:
            return _split_text_into_weighted_segments(
                source,
                min(total, len(atoms)),
            )
        boundaries.append((start, end))
        end = start
    boundaries.reverse()
    chunks = ["".join(atoms[start:end]).strip() for start, end in boundaries]
    chunks = [chunk for chunk in chunks if chunk]
    lengths = [len(chunk) for chunk in chunks if chunk]
    if (
        len(chunks) == total
        and lengths
        and min(lengths) > 0
        and max(lengths) / min(lengths) >= 1.9
    ):
        if len(re.findall(r"[。！？!?；;]", source)) > total:
            return chunks
        return _balanced_character_segments(source, total)
    return chunks


def _ensure_digital_human_storyboard_segment_count(
    segments: list[str],
    target_count: int,
) -> list[str]:
    target = max(int(target_count or 1), 1)
    chunks = [
        str(item or "").strip()
        for item in segments
        if str(item or "").strip()
    ]
    if not chunks:
        return ["" for _ in range(target)]
    while len(chunks) < target:
        split_idx = max(range(len(chunks)), key=lambda idx: len(chunks[idx]))
        source = chunks[split_idx]
        if len(source) <= 1:
            chunks.append("")
            continue
        midpoint = len(source) // 2
        candidates = [
            pos + 1
            for pos, char in enumerate(source)
            if char in "，,、；;：:"
        ]
        cut = (
            min(candidates, key=lambda pos: abs(pos - midpoint))
            if candidates
            else midpoint
        )
        cut = min(max(cut, 1), len(source) - 1)
        left = source[:cut].strip()
        right = source[cut:].strip()
        if not left or not right:
            chunks.append("")
            continue
        chunks = [*chunks[:split_idx], left, right, *chunks[split_idx + 1 :]]
    return chunks[:target]


def _storyboard_items(value: Any) -> list[Any]:
    if isinstance(value, Mapping):
        for key in ("items", "segments", "shots", "storyboard"):
            nested = value.get(key)
            if isinstance(nested, Sequence) and not isinstance(
                nested,
                (str, bytes, bytearray),
            ):
                return list(nested)
        return []
    if isinstance(value, Sequence) and not isinstance(
        value,
        (str, bytes, bytearray),
    ):
        return list(value)
    return []


def _storyboard_text(item: Any) -> str:
    if isinstance(item, Mapping):
        for key in ("speech_text", "dialogue", "script", "text", "copy", "narration"):
            value = str(item.get(key) or "").strip()
            if value:
                return value
        return ""
    return str(item or "").strip()


def normalize_digital_human_segment_scripts(
    script_text: Any = "",
    *,
    mode: Any = "storyboard",
    segment_scripts: Sequence[Any] | None = None,
    storyboard: Any = None,
    max_segment_seconds: Any = 20,
    max_segments: Any = 8,
) -> list[str]:
    """Normalize speech/storyboard input to the source platform's segment contract.

    Storyboard mode always returns four entries. Single-video mode retains
    explicit multi-line scripts and otherwise uses the source duration estimate,
    weighted sentence splitting, and original defaults.
    """

    source = str(script_text or "").strip()
    supplied_items: list[Any] | None = None
    if segment_scripts is not None:
        supplied_items = list(segment_scripts)
    elif storyboard is not None:
        supplied_items = _storyboard_items(storyboard)
    supplied_segments = (
        [_storyboard_text(item) for item in supplied_items]
        if supplied_items is not None
        else []
    )
    supplied_segments = [item for item in supplied_segments if item]
    normalized_mode = str(mode or "").strip().lower()

    if normalized_mode == "storyboard":
        target_count = _digital_human_segment_count(
            source,
            mode=normalized_mode,
            max_segment_seconds=max_segment_seconds,
            max_segments=max_segments,
        )
        segments = supplied_segments or _split_text_into_weighted_segments(
            source,
            target_count,
        )
        return _ensure_digital_human_storyboard_segment_count(
            segments,
            target_count,
        )

    if supplied_segments:
        return supplied_segments
    target_count = _digital_human_segment_count(
        source,
        mode=normalized_mode,
        max_segment_seconds=max_segment_seconds,
        max_segments=max_segments,
    )
    return _split_digital_human_single_script_segments(source, target_count)


def _normalize_product_category(value: Any) -> str:
    lowered = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "property": "real_estate",
        "realestate": "real_estate",
        "房地产": "real_estate",
        "房地產": "real_estate",
        "car": "vehicle",
        "automotive": "vehicle",
        "汽车": "vehicle",
        "汽車": "vehicle",
    }
    return aliases.get(lowered, lowered)


def _digital_human_segment_scene_markers(text: Any) -> set[str]:
    source = str(text or "").lower()
    groups = [
        ("kitchen", ("厨房", "廚房", "厨", "廚", "冰箱", "微波炉", "微波爐", "灶", "料理", "烹饪", "kitchen")),
        ("living", ("客厅", "客廳", "起居", "沙发", "沙發", "会客", "采光", "窗", "阳光", "陽光", "living", "living room", "lounge")),
        ("bedroom", ("卧室", "臥室", "睡眠", "床", "衣柜", "衣櫃", "收纳", "收納", "bedroom")),
        ("bathroom", ("卫浴", "衛浴", "浴室", "卫生间", "洗手间", "沐浴", "淋浴", "bathroom", "toilet")),
        ("balcony", ("阳台", "陽台", "露台", "晾晒", "景观", "景觀", "balcony", "terrace")),
        ("exterior", ("外观", "外觀", "外景", "建筑", "建築", "入口", "门厅", "門廳", "立面", "exterior", "facade", "entrance")),
        ("vehicle_interior", ("内饰", "內飾", "座舱", "座艙", "中控", "方向盘", "方向盤", "座椅", "后排", "interior", "cockpit", "dashboard")),
        ("vehicle_exterior", ("车身", "車身", "轮毂", "輪轂", "车灯", "車燈", "前脸", "尾灯", "尾燈", "exterior", "wheel", "headlight")),
    ]
    markers: set[str] = set()
    for marker, needles in groups:
        if any(needle.lower() in source for needle in needles):
            markers.add(marker)
    return markers


def _digital_human_segment_is_topic_closing(
    text: Any,
    *,
    product_category: Any = "",
) -> bool:
    source = str(text or "").strip()
    if not source:
        return False
    normalized = _normalize_product_category(product_category)
    close_tokens = (
        "最后",
        "最後",
        "总结",
        "總結",
        "总的来说",
        "總的來說",
        "整体来看",
        "整體來看",
        "回到",
        "点题",
        "點題",
        "这就是",
        "這就是",
        "如果你正在",
        "欢迎",
        "歡迎",
        "预约",
        "預約",
        "咨询",
        "諮詢",
        "立即",
        "下单",
        "下單",
        "适合",
        "適合",
        "值得",
        "选择",
        "選擇",
    )
    if any(
        token in source
        for token in (
            "点题",
            "點題",
            "总结",
            "總結",
            "总的来说",
            "總的來說",
            "最后",
            "最後",
        )
    ):
        return True
    if normalized == "real_estate":
        subject_tokens = (
            "这套房",
            "這套房",
            "这个房子",
            "這個房子",
            "这处房源",
            "這處房源",
            "这个房源",
            "這個房源",
            "房源",
            "安家",
            "入住",
            "看房",
            "家",
        )
        action_tokens = (
            "适合",
            "適合",
            "值得",
            "选择",
            "選擇",
            "预约",
            "預約",
            "咨询",
            "諮詢",
            "安家",
            "入住",
            "看房",
        )
        return any(token in source for token in subject_tokens) and any(
            token in source for token in action_tokens
        )
    if normalized == "vehicle":
        subject_tokens = (
            "这台车",
            "這台車",
            "这辆车",
            "這輛車",
            "这款车",
            "這款車",
            "车型",
            "車型",
            "座驾",
            "座駕",
        )
        action_tokens = (
            "适合",
            "適合",
            "值得",
            "选择",
            "選擇",
            "试驾",
            "試駕",
            "咨询",
            "諮詢",
            "入手",
        )
        return any(token in source for token in subject_tokens) and any(
            token in source for token in action_tokens
        )
    subject_tokens = (
        "这款产品",
        "這款產品",
        "这个产品",
        "這個產品",
        "这件产品",
        "這件產品",
        "这款",
        "這款",
        "产品",
        "產品",
        "品牌",
    )
    action_tokens = (
        "适合",
        "適合",
        "值得",
        "选择",
        "選擇",
        "入手",
        "下单",
        "下單",
        "咨询",
        "諮詢",
        "购买",
        "購買",
    )
    return any(token in source for token in close_tokens) and any(
        token in source for token in subject_tokens + action_tokens
    )


def _digital_human_scene_image_paths(
    payload: Mapping[str, Any],
    *,
    max_count: int = 3,
) -> list[Path]:
    values = payload.get("digital_human_scene_image_local_paths")
    if not isinstance(values, list):
        values = payload.get("scene_image_local_paths")
    if not isinstance(values, list):
        values = []
    single_scene_candidates = [
        payload.get("scene_image_local_path"),
        payload.get("generated_scene_image_local_path"),
    ]
    paths: list[Path] = []
    seen: set[str] = set()
    for value in [*(values or []), *single_scene_candidates]:
        text = str(value or "").strip()
        if not text:
            continue
        path = Path(text).expanduser().resolve()
        key = str(path)
        if key in seen:
            continue
        if path.exists() and path.is_file():
            paths.append(path)
            seen.add(key)
        if len(paths) >= max_count:
            break
    return paths


def _digital_human_scene_marker_map_from_payload(
    payload: Mapping[str, Any],
    *,
    view_count: int,
) -> dict[int, set[str]]:
    marker_map: dict[int, set[str]] = {}
    labels = (
        payload.get("digital_human_scene_labels")
        or payload.get("scene_labels")
        or payload.get("digital_human_scene_marker_map")
    )
    if isinstance(labels, list):
        for idx, value in enumerate(labels, start=1):
            markers = _digital_human_segment_scene_markers(value)
            if markers:
                marker_map[idx] = markers
    elif isinstance(labels, Mapping):
        scene_paths = [str(path) for path in _digital_human_scene_image_paths(payload)]
        for raw_key, value in labels.items():
            markers = _digital_human_segment_scene_markers(value)
            if not markers:
                markers = _digital_human_segment_scene_markers(raw_key)
            if not markers:
                continue
            key = str(raw_key or "").strip()
            view_index = 0
            if key.isdigit():
                view_index = int(key)
            else:
                for idx, path in enumerate(scene_paths, start=1):
                    if key == path or key == Path(path).name:
                        view_index = idx
                        break
            if 1 <= view_index < max(int(view_count or 1), 1):
                marker_map[view_index] = markers
    for idx, path in enumerate(_digital_human_scene_image_paths(payload), start=1):
        if idx >= max(int(view_count or 1), 1):
            break
        markers = _digital_human_segment_scene_markers(
            " ".join(Path(str(path)).parts[-4:])
        )
        if markers:
            marker_map.setdefault(idx, set()).update(markers)
    return marker_map


def _invoke(callback: Callable[..., Any], **kwargs: Any) -> Any:
    try:
        signature = inspect.signature(callback)
    except (TypeError, ValueError):
        return callback(**kwargs)
    if any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
    ):
        return callback(**kwargs)
    accepted = {
        name: value for name, value in kwargs.items() if name in signature.parameters
    }
    return callback(**accepted)


def _check_cancelled(callback: Callable[[], Any] | None) -> None:
    if callback is not None:
        callback()


def _llm_analysis_enabled(payload: Mapping[str, Any], explicit: bool | None) -> bool:
    if explicit is not None:
        return bool(explicit)
    value = payload.get("digital_human_scene_llm_analysis", True)
    return str(value).strip().lower() not in {"0", "false", "no", "off"}


def _analyze_digital_human_scene_marker_map_with_llm(
    payload: Mapping[str, Any],
    *,
    task_id: str,
    product_category: Any = "",
    analyze_scene_markers: Callable[..., Any] | None,
    llm_enabled: bool | None,
    check_cancelled: Callable[[], Any] | None,
) -> dict[int, set[str]]:
    if not _llm_analysis_enabled(payload, llm_enabled):
        return {}
    scene_paths = _digital_human_scene_image_paths(payload)
    if not scene_paths or analyze_scene_markers is None:
        return {}
    source = dict(payload or {})
    system_prompt = (
        "你是数字人口播场景图识别助手。请只输出严格 JSON，不要代码块。"
        "你会收到最多 3 张场景图，请判断每张图最适合的场景标签。"
        "可选标签只允许：living,kitchen,bedroom,bathroom,balcony,exterior,vehicle_interior,vehicle_exterior,generic。"
        "输出格式：{\"scenes\":[{\"index\":1,\"label\":\"kitchen\",\"description\":\"简短中文描述\"}]}。"
        "index 从 1 开始，对应输入图片顺序。"
        f"产品品类：{_normalize_product_category(product_category) or 'generic'}。"
    )
    user_input = json.dumps(
        {
            "task_id": task_id,
            "image_paths": [str(path) for path in scene_paths],
            "labels": _SCENE_LABELS,
        },
        ensure_ascii=False,
    )
    try:
        _check_cancelled(check_cancelled)
        callback_result = _invoke(
            analyze_scene_markers,
            payload=source,
            source=source,
            task_id=task_id,
            product_category=product_category,
            user_input=user_input,
            system_prompt=system_prompt,
            parameters="",
            image_paths=[str(path) for path in scene_paths],
            logger=payload.get("_event_logger"),
            allow_builtin=True,
            request_label="数字人场景图识别",
        )
        _check_cancelled(check_cancelled)
        result = callback_result[0] if isinstance(callback_result, tuple) else callback_result
        parsed = result.get("parsed") if isinstance(result, Mapping) else None
        if not isinstance(parsed, Mapping) and isinstance(result, Mapping):
            parsed = result
        scenes = parsed.get("scenes") if isinstance(parsed, Mapping) else None
        marker_map: dict[int, set[str]] = {}
        if isinstance(scenes, list):
            for item in scenes:
                if not isinstance(item, Mapping):
                    continue
                idx = _to_int(item.get("index"), 0)
                text = f"{item.get('label') or ''} {item.get('description') or ''}"
                markers = _digital_human_segment_scene_markers(text)
                label = str(item.get("label") or "").strip()
                if label and label != "generic":
                    markers.add(label)
                if 1 <= idx <= len(scene_paths) and markers:
                    marker_map[idx] = markers
        return marker_map
    except VideoTaskCancelled:
        raise
    except Exception:
        return {}


def _digital_human_view_scene_markers(
    *,
    view_index: int,
    view_count: int,
    product_category: Any = "",
    view_scene_markers: dict[int, set[str]] | None = None,
) -> set[str]:
    idx = max(int(view_index or 0), 0)
    if idx <= 0:
        return {"exterior", "opening", "closing"}
    if view_scene_markers and idx in view_scene_markers:
        return set(view_scene_markers.get(idx) or set())
    category = _normalize_product_category(product_category)
    if category == "real_estate":
        role_order = [
            {"living", "exterior"},
            {"kitchen"},
            {"bedroom", "bathroom", "balcony"},
        ]
        return role_order[(idx - 1) % len(role_order)]
    if category == "vehicle":
        role_order = [
            {"vehicle_exterior"},
            {"vehicle_interior"},
            {"vehicle_interior", "vehicle_exterior"},
        ]
        return role_order[(idx - 1) % len(role_order)]
    return set()


def _pick_digital_human_storyboard_view(
    *,
    segment_text: str,
    available_views: list[int],
    view_count: int,
    product_category: Any = "",
    view_scene_markers: dict[int, set[str]] | None = None,
) -> int:
    if not available_views:
        return 0
    segment_markers = _digital_human_segment_scene_markers(segment_text)
    if segment_markers:
        scored: list[tuple[int, int]] = []
        for view in available_views:
            markers = _digital_human_view_scene_markers(
                view_index=view,
                view_count=view_count,
                product_category=product_category,
                view_scene_markers=view_scene_markers,
            )
            scored.append((len(segment_markers & markers), view))
        scored.sort(key=lambda item: (-item[0], item[1]))
        if scored and scored[0][0] > 0:
            return scored[0][1]
    return available_views[0]


def _digital_human_view_sequence(
    *,
    segment_count: int,
    view_count: int,
    segment_texts: list[str] | None = None,
    product_category: Any = "",
    view_scene_markers: dict[int, set[str]] | None = None,
    reuse_last_view_as_closing_main: bool = False,
) -> list[int]:
    segments = max(int(segment_count or 1), 1)
    views = max(int(view_count or 1), 1)
    if views <= 1:
        return [0 for _ in range(segments)]
    if segments <= 1:
        return [0]
    sequence = [0 for _ in range(segments)]
    texts = list(segment_texts or [])
    final_text = texts[-1] if texts else ""
    final_returns_to_main = segments >= 3 or _digital_human_segment_is_topic_closing(
        final_text,
        product_category=product_category,
    )
    if final_returns_to_main:
        sequence[-1] = 0
    positions = list(range(1, segments - 1 if final_returns_to_main else segments))
    middle_view_stop = (
        views - 1 if reuse_last_view_as_closing_main and views > 2 else views
    )
    middle_view_indexes = list(range(1, max(middle_view_stop, 1)))
    used_views: set[int] = set()
    for pos in positions:
        available_views = (
            [view for view in middle_view_indexes if view not in used_views]
            or middle_view_indexes
            or list(range(1, views))
        )
        text = texts[pos] if pos < len(texts) else ""
        view = _pick_digital_human_storyboard_view(
            segment_text=text,
            available_views=available_views,
            view_count=views,
            product_category=product_category,
            view_scene_markers=view_scene_markers,
        )
        sequence[pos] = view
        if view > 0:
            used_views.add(view)
    return sequence


def _digital_human_uses_reused_closing_main_view(
    mode: Any,
    fusion_views: Sequence[Any],
) -> bool:
    if str(mode or "").strip().lower() != "storyboard" or len(fusion_views) <= 2:
        return False
    try:
        return str(Path(fusion_views[0]).expanduser().resolve()) == str(
            Path(fusion_views[-1]).expanduser().resolve()
        )
    except Exception:
        return str(fusion_views[0]) == str(fusion_views[-1])


def build_digital_human_view_sequence(
    payload: Mapping[str, Any] | None,
    segment_scripts: Sequence[Any],
    fusion_views: Sequence[Any],
    *,
    task_id: str = "",
    product_category: Any = "",
    mode: Any = None,
    analyze_scene_markers: Callable[..., Any] | None = None,
    llm_enabled: bool | None = None,
    check_cancelled: Callable[[], Any] | None = None,
) -> list[int]:
    """Build the source-compatible, zero-based fusion-view sequence.

    Scene analysis is callback-injected. A normal callback failure degrades to
    explicit/default markers; ``VideoTaskCancelled`` is intentionally preserved.
    Fusion view ``0`` is the main view, matching the source helper contract.
    """

    source = dict(payload or {})
    texts = [str(item or "").strip() for item in segment_scripts]
    views = list(fusion_views)
    normalized_mode = str(
        mode
        if mode is not None
        else source.get("digital_human_short_mode") or "storyboard"
    ).strip().lower()
    category = product_category or source.get("product_category") or source.get("category") or source.get("industry") or ""
    effective_task_id = str(task_id or source.get("task_id") or "")

    _check_cancelled(check_cancelled)
    view_scene_markers = _digital_human_scene_marker_map_from_payload(
        source,
        view_count=len(views),
    )
    reuse_closing_main_view = _digital_human_uses_reused_closing_main_view(
        normalized_mode,
        views,
    )
    if normalized_mode == "storyboard" and len(views) > 1:
        llm_scene_markers = _analyze_digital_human_scene_marker_map_with_llm(
            source,
            task_id=effective_task_id,
            product_category=category,
            analyze_scene_markers=analyze_scene_markers,
            llm_enabled=llm_enabled,
            check_cancelled=check_cancelled,
        )
        for view_idx, markers in llm_scene_markers.items():
            view_scene_markers[view_idx] = set(markers)

    segment_count = max(len(texts), 1)
    if (
        normalized_mode == "storyboard"
        and segment_count == 5
        and len(views) >= 4
        and not reuse_closing_main_view
    ):
        sequence = [0, 1, 2, 3, 0]
    else:
        sequence = _digital_human_view_sequence(
            segment_count=segment_count,
            view_count=len(views),
            segment_texts=texts,
            product_category=category,
            view_scene_markers=view_scene_markers,
            reuse_last_view_as_closing_main=reuse_closing_main_view,
        )
    _check_cancelled(check_cancelled)
    return sequence
