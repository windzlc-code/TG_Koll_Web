from __future__ import annotations

import re
import unicodedata
from typing import Any


# Keep these limits aligned with the source digital-human platform. Complex lines
# use the lower cap to avoid making numbers and multi-clause speech unintelligible.
VIDEO_LANGUAGE_SOURCE_MAX_PLAYBACK_TEMPO = 1.25
VIDEO_LANGUAGE_COMPLEX_SOURCE_MAX_PLAYBACK_TEMPO = 1.12

_TRADITIONAL_CHINESE_PHRASES = {
    "臺灣": "台湾",
    "台灣": "台湾",
    "馬來西亞": "马来西亚",
    "總價": "总价",
    "實用面積": "实用面积",
    "建築面積": "建筑面积",
    "管理費": "管理费",
    "陽台": "阳台",
    "衛浴": "卫浴",
    "廚房": "厨房",
    "客廳": "客厅",
    "臥室": "卧室",
    "電梯": "电梯",
    "樓層": "楼层",
    "這間": "这间",
    "這套": "这套",
    "這邊": "这边",
    "裡面": "里面",
    "後面": "后面",
    "開放式": "开放式",
    "採光": "采光",
    "視野": "视野",
    "鄰近": "邻近",
    "歡迎": "欢迎",
    "讓我們": "让我们",
}

_OPENCC_T2S_CONVERTER: Any | None = None
_OPENCC_T2S_LOAD_FAILED = False
_CHINESE_DIGITS = "零一二三四五六七八九"
_CHINESE_SMALL_UNITS = ["", "十", "百", "千"]
_CHINESE_BIG_UNITS = ["", "万", "亿", "兆"]


def build_atempo_chain(tempo: float) -> str:
    """Build an ffmpeg atempo chain for values outside one filter's 0.5-2 range."""

    value = max(float(tempo or 1.0), 0.05)
    parts: list[str] = []
    while value > 2.0:
        parts.append("atempo=2.0")
        value /= 2.0
    while value < 0.5:
        parts.append("atempo=0.5")
        value /= 0.5
    parts.append(f"atempo={value:.6f}")
    return ",".join(parts)


def _opencc_t2s_convert(text: str) -> str:
    global _OPENCC_T2S_CONVERTER, _OPENCC_T2S_LOAD_FAILED
    if _OPENCC_T2S_LOAD_FAILED:
        return ""
    try:
        if _OPENCC_T2S_CONVERTER is None:
            from opencc import OpenCC

            _OPENCC_T2S_CONVERTER = OpenCC("t2s")
        return str(_OPENCC_T2S_CONVERTER.convert(text) or "")
    except Exception:
        _OPENCC_T2S_LOAD_FAILED = True
        return ""


def _normalize_chinese_text_for_mandarin_tts(text: str) -> str:
    normalized = unicodedata.normalize("NFC", str(text or "")).strip()
    if not normalized:
        return ""
    converted = _opencc_t2s_convert(normalized)
    if converted:
        normalized = converted
    for source, target in _TRADITIONAL_CHINESE_PHRASES.items():
        normalized = normalized.replace(source, target)
    normalized = re.sub(r"[ \t]+", " ", normalized)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized.strip()


def _int_to_spoken_chinese(value: int) -> str:
    number = int(value or 0)
    if number == 0:
        return _CHINESE_DIGITS[0]

    def convert_four_digits(chunk: int) -> str:
        if chunk <= 0:
            return ""
        parts: list[str] = []
        zero_pending = False
        digits = list(map(int, f"{chunk:04d}"))
        for index, digit in enumerate(digits):
            unit_index = 3 - index
            if digit == 0:
                if parts:
                    zero_pending = True
                continue
            if zero_pending:
                parts.append("零")
                zero_pending = False
            if digit == 1 and unit_index == 1 and not parts:
                parts.append("十")
            else:
                parts.append(_CHINESE_DIGITS[digit] + _CHINESE_SMALL_UNITS[unit_index])
        return "".join(parts)

    groups: list[int] = []
    while number > 0:
        groups.append(number % 10000)
        number //= 10000
    result: list[str] = []
    zero_between_groups = False
    for group_index in range(len(groups) - 1, -1, -1):
        group_value = groups[group_index]
        if group_value == 0:
            zero_between_groups = bool(result)
            continue
        if result and (zero_between_groups or group_value < 1000):
            result.append("零")
        result.append(convert_four_digits(group_value))
        result.append(_CHINESE_BIG_UNITS[group_index])
        zero_between_groups = False
    return "".join(part for part in result if part).rstrip("零")


def _digits_to_spoken_chinese(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if raw.startswith("0") and len(raw) > 1:
        return "".join(_CHINESE_DIGITS[int(char)] for char in raw if char.isdigit())
    return _int_to_spoken_chinese(int(raw))


def _number_text_to_spoken_chinese(value: str, *, suffix: str = "") -> str:
    raw = str(value or "").strip().replace(",", "")
    if not raw:
        return ""
    negative = raw.startswith("-")
    if negative:
        raw = raw[1:]
    if "." in raw:
        integer_part, decimal_part = raw.split(".", 1)
        integer_spoken = _digits_to_spoken_chinese(integer_part or "0")
        decimal_spoken = "".join(_CHINESE_DIGITS[int(char)] for char in decimal_part if char.isdigit())
        spoken = integer_spoken if not decimal_spoken else f"{integer_spoken}点{decimal_spoken}"
    elif suffix == "年" and raw.isdigit():
        spoken = "".join(_CHINESE_DIGITS[int(char)] for char in raw)
    else:
        spoken = _digits_to_spoken_chinese(raw)
        spoken = re.sub(r"^二(?=[百千万亿兆])", "两", spoken)
        if spoken == "二" and suffix in {"分钟", "分", "秒", "个", "间", "套", "户", "倍", "万"}:
            spoken = "两"
    return f"负{spoken}" if negative else spoken


def _normalize_chinese_tts_numbers(text: str) -> str:
    normalized = str(text or "")
    if not normalized:
        return ""

    def replace_percent(match: re.Match[str]) -> str:
        return f"百分之{_number_text_to_spoken_chinese(match.group('number'))}"

    def replace_plain(match: re.Match[str]) -> str:
        number = str(match.group("number") or "")
        suffix = str(match.group("suffix") or "")
        return f"{_number_text_to_spoken_chinese(number, suffix=suffix)}{suffix}"

    normalized = re.sub(r"(?P<number>-?\d[\d,]*(?:\.\d+)?)\s*%", replace_percent, normalized)
    return re.sub(
        r"(?P<number>-?\d[\d,]*(?:\.\d+)?)(?P<suffix>年|月|日|号|號|层|樓|楼|分钟|分|秒|米|平方米|平米|㎡|坪|户|套|层楼|日币|人民币|元|万|千|百|倍)?",
        replace_plain,
        normalized,
    )


def _restore_chinese_tts_pause_punctuation(text: str) -> str:
    normalized = re.sub(r"\s+", " ", str(text or "").strip())
    if not normalized or " " not in normalized:
        return normalized
    parts = [part.strip(" ，、；;") for part in normalized.split(" ") if part.strip(" ，、；;")]
    if len(parts) <= 1:
        return normalized.replace(" ", "")
    rebuilt: list[str] = []
    for index, part in enumerate(parts):
        rebuilt.append(part)
        if index >= len(parts) - 1:
            continue
        next_part = parts[index + 1]
        separator = "，"
        if index >= 1 and len(part) <= 4 and len(next_part) <= 10 and not re.search(r"[。！？!?]$", part) and not re.search(r"\d", part + next_part):
            separator = "、"
        rebuilt.append(separator)
    return "".join(rebuilt)


def normalize_chinese_tts_text(text: str) -> str:
    """Apply the source platform's Mandarin TTS normalization to one line."""

    return _restore_chinese_tts_pause_punctuation(
        _normalize_chinese_tts_numbers(_normalize_chinese_text_for_mandarin_tts(text))
    )


def source_max_playback_tempo_for_text(text: str) -> float:
    content = str(text or "").strip()
    if not content:
        return VIDEO_LANGUAGE_SOURCE_MAX_PLAYBACK_TEMPO
    complexity_hits = 0
    if re.search(r"\d", content):
        complexity_hits += 1
    if any(marker in content for marker in ("，", ",", "、", "；", ";")):
        complexity_hits += 1
    if len(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]+", content)) >= 4 and len(content) >= 20:
        complexity_hits += 1
    return VIDEO_LANGUAGE_COMPLEX_SOURCE_MAX_PLAYBACK_TEMPO if complexity_hits else VIDEO_LANGUAGE_SOURCE_MAX_PLAYBACK_TEMPO


def build_timed_audio_layout(items: list[dict[str, Any]], *, source_duration: float) -> tuple[list[dict[str, Any]], float]:
    """Fit generated TTS clips to source slots using the original shift/tempo rules."""

    generated: list[dict[str, Any]] = []
    occupied_cursor = 0.0
    pending_source_shift = 0.0
    latest_source_end = 0.0
    source_positions = [index for index, item in enumerate(items) if str(item.get("role") or "source") == "source"]
    next_source_by_index = {
        item_index: source_positions[position + 1] if position + 1 < len(source_positions) else None
        for position, item_index in enumerate(source_positions)
    }

    for item_index, source in enumerate(items):
        item = dict(source)
        role = str(item.get("role") or "source")
        nominal_start = max(float(item.get("start_seconds") or 0.0), 0.0)
        raw_duration = max(float(item.get("raw_audio_duration_seconds") or 0.0), 0.0)
        slot_end = item.get("slot_end_seconds", item.get("end_seconds"))
        slot_end = None if slot_end is None else max(float(slot_end), nominal_start)
        start = nominal_start
        effective_duration = raw_duration
        playback_tempo = 1.0

        if role == "opening":
            start = max(nominal_start, occupied_cursor)
        elif role == "source":
            start = max(nominal_start + pending_source_shift, occupied_cursor)
            next_item_index = next_source_by_index.get(item_index)
            next_start = None
            if next_item_index is not None:
                next_start = max(float(items[next_item_index].get("start_seconds") or 0.0) + pending_source_shift, start)
            max_tempo = source_max_playback_tempo_for_text(str(item.get("text") or ""))
            if slot_end is not None:
                shifted_slot_end = max(slot_end + pending_source_shift, start)
                preferred_available = max(shifted_slot_end - start, 0.0)
                preferred_tempo = raw_duration / max(preferred_available, 0.05) if preferred_available > 0.01 else float("inf")
                if raw_duration > preferred_available + 0.01 and preferred_tempo <= max_tempo + 1e-6:
                    effective_duration = max(preferred_available, 0.05)
                    playback_tempo = max(raw_duration / effective_duration, 1.0)
            end_candidate = start + effective_duration
            if next_start is not None and end_candidate > next_start + 0.01:
                hard_available = max(next_start - start, 0.0)
                hard_tempo = raw_duration / max(hard_available, 0.05) if hard_available > 0.01 else float("inf")
                if hard_available > 0.01 and hard_tempo <= max_tempo + 1e-6:
                    effective_duration = max(hard_available, 0.05)
                    playback_tempo = max(raw_duration / effective_duration, 1.0)
                    end_candidate = start + effective_duration
            if next_start is not None and end_candidate > next_start + 0.01:
                pending_source_shift += end_candidate - next_start
            latest_source_end = max(latest_source_end, end_candidate)
            item["source_max_playback_tempo"] = round(max_tempo, 6)
        elif role == "ending":
            start = max(nominal_start + pending_source_shift, latest_source_end, occupied_cursor)

        end = start + effective_duration
        occupied_cursor = max(occupied_cursor, end)
        if role == "source":
            latest_source_end = max(latest_source_end, end)
        item.update(
            {
                "nominal_start_seconds": round(nominal_start, 3),
                "start_seconds": round(start, 3),
                "end_seconds": round(end, 3),
                "raw_audio_duration_seconds": round(raw_duration, 3),
                "audio_duration_seconds": round(effective_duration, 3),
                "playback_tempo": round(playback_tempo, 6),
                "duration_compressed": playback_tempo > 1.000001,
                "timing_shift_seconds": round(start - nominal_start, 3),
                "timing_shifted": abs(start - nominal_start) > 1e-6,
            }
        )
        generated.append(item)

    total_seconds = max(float(source_duration or 0.0), max((float(item["end_seconds"]) for item in generated), default=0.0), 0.1)
    return generated, round(total_seconds, 3)


__all__ = [
    "build_atempo_chain",
    "build_timed_audio_layout",
    "normalize_chinese_tts_text",
    "source_max_playback_tempo_for_text",
]
