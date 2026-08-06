from __future__ import annotations

import difflib
import math
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any


_ECOMMERCE_TIME_UNIT_PATTERN = r"(?:秒钟|秒|seconds?|secs?|s)"
_ECOMMERCE_TIME_RANGE_PATTERN = rf"(\d+)\s*[-到至]\s*(\d+)\s*{_ECOMMERCE_TIME_UNIT_PATTERN}\s*[:：]"


def _clean_subtitle_source_text(text: Any) -> str:
    content = str(text or "").strip()
    if not content:
        return ""
    content = re.sub(r"(?m)^\s*【[^】]+】\s*$", "", content)
    content = re.sub(r"(?m)^\s*无字幕[，,、]?\s*无背景音乐[。.]?\s*$", "", content)
    content = re.sub(r"(?m)^\s*声音(?:要求|约束)[:：].*$", "", content)
    content = re.sub(r"(?m)^\s*(?:色彩矩阵|视觉基调|模特形象|镜头类型|分镜剧情)[:：].*$", "", content)
    content = re.sub(rf"{_ECOMMERCE_TIME_RANGE_PATTERN}\s*", "", content, flags=re.IGNORECASE)
    content = re.sub(
        r"(?:口播|旁白|画外音|纪录片旁白|人物对白|台词|对白|voice[- ]?over|narration|dialogue)[:：]",
        "",
        content,
        flags=re.IGNORECASE,
    )
    content = re.sub(r"[“”\"']", "", content)
    if re.search(r"[A-Za-z]", content) and not re.search(r"[\u3400-\u9fff\u3040-\u30ff]", content):
        content = re.sub(r"\s+", " ", content)
    else:
        content = re.sub(r"\s+", "", content)
    return content.strip(" ，,。；;.!?！？")


_SUBTITLE_SEMANTIC_BOUNDARY_TOKENS = (
    "无论是",
    "还是",
    "以及",
    "并且",
    "这里就是",
    "这里都能",
    "都有",
    "都能",
    "都会",
    "都可以",
    "也有",
    "也能",
    "还能",
    "可以",
    "可直接",
    "为您介绍",
    "坐落于",
    "位于",
    "适合",
    "适用于",
    "需要",
    "建议",
    "同时",
    "而且",
    "所以",
    "因此",
    "这样",
    "这里",
    "这类",
    "与",
    "和",
)


def _subtitle_best_semantic_split(text: str, *, max_chars: int) -> int | None:
    content = str(text or "")
    length = len(content)
    if length <= max_chars:
        return None
    min_left = max(5, int(max_chars * 0.45))
    max_left = min(max(int(max_chars * 1.35), max_chars), length - 4)
    if max_left < min_left:
        return None

    candidates: list[int] = []
    for token in _SUBTITLE_SEMANTIC_BOUNDARY_TOKENS:
        start = 0
        while True:
            index = content.find(token, start)
            if index < 0:
                break
            if min_left <= index <= max_left:
                candidates.append(index)
            end_index = index + len(token)
            if min_left <= end_index <= max_left and token in {"这类", "这里", "这样", "为您介绍", "坐落于", "位于"}:
                candidates.append(end_index)
            start = index + 1

    if not candidates:
        for index in range(min(length - 1, max_left), min_left - 1, -1):
            left = content[:index]
            right = content[index:]
            if re.search(r"(?:的|了|中|上|下|里|内|外|前|后|类|器|品|房|车|图|款)$", left) and len(right) >= 4:
                candidates.append(index)
                break

    if candidates:
        target = min(max_chars, max(length // 2, min_left))
        return min(candidates, key=lambda item: (abs(item - target), -item))
    return max_left if max_left >= min_left else None


def _split_subtitle_part_by_semantics(text: str, *, max_chars: int) -> list[str]:
    content = str(text or "").strip(" ，,、")
    if not content:
        return []
    split_at = _subtitle_best_semantic_split(content, max_chars=max_chars)
    if len(content) <= max_chars and split_at is None:
        return [content]
    if split_at is None or split_at <= 0 or split_at >= len(content):
        split_at = max_chars
    left = content[:split_at].strip(" ，,、")
    right = content[split_at:].strip(" ，,、")
    chunks: list[str] = []
    if left:
        chunks.extend(_split_subtitle_part_by_semantics(left, max_chars=max_chars))
    if right:
        chunks.extend(_split_subtitle_part_by_semantics(right, max_chars=max_chars))
    return chunks


_DIGITAL_HUMAN_SUBTITLE_MAX_CHARS = 16


def _split_subtitle_chunks(text: Any, *, max_chars: int = _DIGITAL_HUMAN_SUBTITLE_MAX_CHARS) -> list[str]:
    content = _clean_subtitle_source_text(text)
    if not content:
        return []
    sentences = [
        item.strip(" ，,。；;")
        for item in re.split(r"[。！？!?；;]\s*", content)
        if item.strip(" ，,。；;")
    ]
    deduped_sentences: list[str] = []
    seen_sentences: set[str] = set()
    for sentence in sentences:
        key = re.sub(r"\W+", "", sentence)
        if key and key in seen_sentences:
            continue
        if key:
            seen_sentences.add(key)
        deduped_sentences.append(sentence)
    sentences = deduped_sentences
    chunks: list[str] = []
    for sentence in sentences or [content]:
        soft_parts = [item.strip(" ，,、") for item in re.split(r"[，,、]", sentence) if item.strip(" ，,、")]
        if not soft_parts:
            soft_parts = [sentence]
        for part in soft_parts:
            chunks.extend(_split_subtitle_part_by_semantics(part, max_chars=max_chars))
    return [item for item in chunks if item]


def _subtitle_display_total_seconds(chunks: list[str], duration_seconds: float) -> float:
    video_duration = max(float(duration_seconds or 0), 0.1)
    if not chunks:
        return video_duration
    char_count = sum(len(re.sub(r"\s+", "", chunk)) for chunk in chunks)
    estimated = sum(max(0.9, min(2.8, len(chunk) / 5.2 + 0.35)) for chunk in chunks)
    estimated += max(len(chunks) - 1, 0) * 0.08
    if estimated >= video_duration * 0.72:
        return video_duration
    return min(video_duration, max(estimated, char_count / 5.5))


_SUBTITLE_ASR_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}


def _subtitle_asr_enabled() -> bool:
    return str(os.getenv("SUBTITLE_ASR_ENABLED", "true")).strip().lower() not in {"0", "false", "no", "off"}


def _subtitle_asr_model() -> Any | None:
    if not _subtitle_asr_enabled():
        return None
    try:
        from faster_whisper import WhisperModel
    except Exception:
        return None
    model_size = str(os.getenv("SUBTITLE_ASR_MODEL", "tiny")).strip() or "tiny"
    device = str(os.getenv("SUBTITLE_ASR_DEVICE", "cpu")).strip() or "cpu"
    compute_type = str(os.getenv("SUBTITLE_ASR_COMPUTE_TYPE", "int8")).strip() or "int8"
    cache_key = (model_size, device, compute_type)
    model = _SUBTITLE_ASR_MODEL_CACHE.get(cache_key)
    if model is None:
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        _SUBTITLE_ASR_MODEL_CACHE[cache_key] = model
    return model


def _strip_video_language_timecode_prefix(line: str) -> str:
    text = str(line or "").strip()
    return re.sub(r"^\s*\[[^\]]+\]\s*", "", text).strip()


def _video_language_alignment_text(value: Any) -> str:
    text = _strip_video_language_timecode_prefix(str(value or ""))
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"[，,。！？!?；;、：:“”\"'（）()【】\[\]…—·]", "", text)
    return text.strip()


def _subtitle_asr_segments(
    media_path: Path,
    *,
    duration_seconds: float,
    word_timestamps: bool,
) -> list[dict[str, Any]]:
    source = Path(media_path).expanduser().resolve()
    if not source.exists():
        return []
    try:
        model = _subtitle_asr_model()
    except Exception:
        return []
    if model is None:
        return []
    try:
        segments_iter, _info = model.transcribe(
            str(source),
            language=str(os.getenv("SUBTITLE_ASR_LANGUAGE", "zh")).strip() or "zh",
            vad_filter=True,
            beam_size=1,
            word_timestamps=word_timestamps,
        )
        total = max(float(duration_seconds or 0.0), 0.1)
        results: list[dict[str, Any]] = []
        for segment in segments_iter:
            text = str(getattr(segment, "text", "") or "").strip()
            start = max(0.0, min(float(getattr(segment, "start", 0.0) or 0.0), total))
            end = max(start, min(float(getattr(segment, "end", 0.0) or 0.0), total))
            words = []
            if word_timestamps:
                for word in getattr(segment, "words", None) or []:
                    word_start = max(0.0, min(float(getattr(word, "start", 0.0) or 0.0), total))
                    word_end = max(word_start, min(float(getattr(word, "end", 0.0) or 0.0), total))
                    word_text = str(getattr(word, "word", "") or "").strip()
                    if word_text and word_end > word_start:
                        words.append((word_text, word_start, word_end))
            if text and end - start >= 0.25:
                results.append({"text": text, "start": start, "end": end, "words": words})
        return results
    except Exception:
        return []


def _coerce_monotonic_dialogue_ranges(
    ranges: list[tuple[float, float]],
    *,
    duration_seconds: float,
    min_duration: float = 0.1,
) -> list[tuple[float, float]]:
    total = max(float(duration_seconds or 0.0), min_duration)
    normalized: list[tuple[float, float]] = []
    previous_end = 0.0
    for start, end in list(ranges or []):
        start_value = max(min(float(start or 0.0), total), 0.0)
        end_value = max(min(float(end or 0.0), total), start_value)
        start_value = max(start_value, previous_end)
        if end_value < start_value + min_duration:
            end_value = min(total, start_value + min_duration)
        if end_value <= start_value:
            end_value = min(total, start_value + min_duration)
        normalized.append((round(start_value, 3), round(end_value, 3)))
        previous_end = end_value
    return normalized


def _coerce_monotonic_start_times(
    starts: list[float],
    *,
    duration_seconds: float,
    min_step: float = 0.001,
) -> list[float]:
    total = max(float(duration_seconds or 0.0), max(float(min_step or 0.0), 0.0))
    normalized: list[float] = []
    previous_start = -max(float(min_step or 0.0), 0.0)
    for raw_start in list(starts or []):
        start_value = max(min(float(raw_start or 0.0), total), 0.0)
        if normalized:
            start_value = max(start_value, previous_start + max(float(min_step or 0.0), 0.0))
        start_value = min(start_value, total)
        start_value = round(start_value, 3)
        normalized.append(start_value)
        previous_start = start_value
    return normalized


def _timed_text_alignment_average_similarity(
    *,
    chunks: list[str],
    timed_units: list[dict[str, Any]],
) -> float:
    normalized_chunks = [str(item or "").strip() for item in list(chunks or []) if str(item or "").strip()]
    usable_units = [dict(item) for item in list(timed_units or []) if isinstance(item, dict) and str(item.get("text") or "").strip()]
    if not normalized_chunks or len(normalized_chunks) != len(usable_units):
        return 0.0
    similarities: list[float] = []
    for idx, chunk in enumerate(normalized_chunks):
        chunk_text = _video_language_alignment_text(chunk)
        unit_text = _video_language_alignment_text(usable_units[idx].get("text") or "")
        if not chunk_text or not unit_text:
            similarities.append(0.0)
            continue
        similarities.append(difflib.SequenceMatcher(None, chunk_text, unit_text).ratio())
    if not similarities:
        return 0.0
    return sum(similarities) / len(similarities)


def _align_chunks_to_timed_text_ranges(
    *,
    chunks: list[str],
    timed_units: list[dict[str, Any]],
    duration_seconds: float,
    max_group_units: int,
) -> list[tuple[float, float]]:
    normalized_chunks = [str(item or "").strip() for item in list(chunks or []) if str(item or "").strip()]
    usable_units = [dict(item) for item in list(timed_units or []) if isinstance(item, dict) and str(item.get("text") or "").strip()]
    if not normalized_chunks or not usable_units or len(usable_units) < len(normalized_chunks):
        return []
    chunk_units = [_video_language_alignment_text(item) for item in normalized_chunks]
    timed_text_units = [_video_language_alignment_text(item.get("text") or "") for item in usable_units]
    chunk_lengths = [max(len(item), 1) for item in chunk_units]
    timed_lengths = [max(len(item), 1) for item in timed_text_units]
    prefix_lengths = [0]
    for length in timed_lengths:
        prefix_lengths.append(prefix_lengths[-1] + length)

    def group_length(start_idx: int, end_idx: int) -> int:
        return prefix_lengths[end_idx] - prefix_lengths[start_idx]

    def group_text(start_idx: int, end_idx: int) -> str:
        return "".join(timed_text_units[start_idx:end_idx])

    chunk_count = len(normalized_chunks)
    unit_count = len(usable_units)
    inf = float("inf")
    dp = [[inf] * (unit_count + 1) for _ in range(chunk_count + 1)]
    prev: list[list[tuple[int, int] | None]] = [[None] * (unit_count + 1) for _ in range(chunk_count + 1)]
    dp[0][0] = 0.0
    for chunk_idx in range(1, chunk_count + 1):
        min_unit_end = chunk_idx
        max_unit_end = unit_count - (chunk_count - chunk_idx)
        for unit_end in range(min_unit_end, max_unit_end + 1):
            unit_start_min = max(chunk_idx - 1, unit_end - max_group_units)
            for unit_start in range(unit_start_min, unit_end):
                previous_cost = dp[chunk_idx - 1][unit_start]
                if previous_cost == inf:
                    continue
                current_chunk = chunk_units[chunk_idx - 1]
                grouped_text = group_text(unit_start, unit_end)
                similarity = difflib.SequenceMatcher(None, current_chunk, grouped_text).ratio() if current_chunk and grouped_text else 0.0
                current_group_length = group_length(unit_start, unit_end)
                length_ratio = current_group_length / max(chunk_lengths[chunk_idx - 1], 1)
                length_penalty = abs(math.log(max(length_ratio, 1e-6)))
                similarity_penalty = (1.0 - similarity) * 6.0
                grouping_penalty = max(unit_end - unit_start - 1, 0) * 0.12
                cost = previous_cost + length_penalty + similarity_penalty + grouping_penalty
                if cost < dp[chunk_idx][unit_end]:
                    dp[chunk_idx][unit_end] = cost
                    prev[chunk_idx][unit_end] = (unit_start, unit_end)
    if dp[chunk_count][unit_count] == inf:
        return []
    ranges_reversed: list[tuple[float, float]] = []
    unit_cursor = unit_count
    for chunk_idx in range(chunk_count, 0, -1):
        decision = prev[chunk_idx][unit_cursor]
        if decision is None:
            return []
        unit_start, unit_end = decision
        start_value = max(float(usable_units[unit_start].get("start", 0.0) or 0.0), 0.0)
        end_value = max(float(usable_units[unit_end - 1].get("end", start_value) or start_value), start_value)
        ranges_reversed.append((start_value, end_value))
        unit_cursor = unit_start
    ranges_reversed.reverse()
    return _coerce_monotonic_dialogue_ranges(ranges_reversed, duration_seconds=duration_seconds)


def _align_chunks_to_asr_segment_ranges(
    *,
    chunks: list[str],
    asr_segments: list[dict[str, Any]],
    duration_seconds: float,
    max_group_segments: int = 8,
) -> list[tuple[float, float]]:
    return _align_chunks_to_timed_text_ranges(
        chunks=chunks,
        timed_units=asr_segments,
        duration_seconds=duration_seconds,
        max_group_units=max_group_segments,
    )


def _align_chunks_to_asr_word_ranges(
    *,
    chunks: list[str],
    words: list[tuple[str, float, float]],
    duration_seconds: float,
    max_group_words: int = 24,
    max_skip_words: int = 12,
) -> list[tuple[float, float]]:
    normalized_chunks = [str(item or "").strip() for item in list(chunks or []) if str(item or "").strip()]
    timed_words = [
        {"text": str(word_text or "").strip(), "start": float(start or 0.0), "end": float(end or 0.0)}
        for word_text, start, end in list(words or [])
        if str(word_text or "").strip() and float(end or 0.0) > float(start or 0.0)
    ]
    if not normalized_chunks or len(timed_words) < len(normalized_chunks):
        return []
    ranges: list[tuple[float, float]] = []
    word_cursor = 0
    total_words = len(timed_words)
    for chunk_idx, chunk in enumerate(normalized_chunks):
        chunk_text = _video_language_alignment_text(chunk)
        if not chunk_text:
            return []
        remaining_chunks = len(normalized_chunks) - chunk_idx - 1
        latest_start = total_words - max(remaining_chunks, 0) - 1
        best_choice: tuple[float, int, int] | None = None
        start_limit = min(latest_start, word_cursor + max(max_skip_words, 0))
        for start_idx in range(word_cursor, max(start_limit, word_cursor) + 1):
            max_end_exclusive = min(total_words - remaining_chunks, start_idx + max(max_group_words, 1))
            grouped_text = ""
            for end_exclusive in range(start_idx + 1, max_end_exclusive + 1):
                grouped_text += _video_language_alignment_text(timed_words[end_exclusive - 1].get("text") or "")
                similarity = difflib.SequenceMatcher(None, chunk_text, grouped_text).ratio() if grouped_text else 0.0
                length_ratio = max(len(grouped_text), 1) / max(len(chunk_text), 1)
                length_penalty = abs(math.log(max(length_ratio, 1e-6)))
                skip_penalty = max(start_idx - word_cursor, 0) * 0.08
                grouping_penalty = max(end_exclusive - start_idx - 1, 0) * 0.05
                cost = ((1.0 - similarity) * 6.0) + length_penalty + skip_penalty + grouping_penalty
                if best_choice is None or cost < best_choice[0]:
                    best_choice = (cost, start_idx, end_exclusive)
        if best_choice is None:
            return []
        _, start_idx, end_exclusive = best_choice
        ranges.append(
            (
                max(float(timed_words[start_idx].get("start", 0.0) or 0.0), 0.0),
                max(float(timed_words[end_exclusive - 1].get("end", 0.0) or 0.0), float(timed_words[start_idx].get("start", 0.0) or 0.0)),
            )
        )
        word_cursor = end_exclusive
    return _coerce_monotonic_dialogue_ranges(ranges, duration_seconds=duration_seconds)


def _asr_word_range_alignment_average_similarity(
    *,
    chunks: list[str],
    words: list[tuple[str, float, float]],
    ranges: list[tuple[float, float]],
) -> float:
    normalized_chunks = [str(item or "").strip() for item in list(chunks or []) if str(item or "").strip()]
    if not normalized_chunks or len(normalized_chunks) != len(list(ranges or [])):
        return 0.0
    scores: list[float] = []
    timed_words = [
        (str(word_text or "").strip(), float(start or 0.0), float(end or 0.0))
        for word_text, start, end in list(words or [])
        if str(word_text or "").strip() and float(end or 0.0) > float(start or 0.0)
    ]
    for chunk, (range_start, range_end) in zip(normalized_chunks, ranges):
        chunk_text = _video_language_alignment_text(chunk)
        grouped_text = "".join(
            _video_language_alignment_text(word_text)
            for word_text, word_start, word_end in timed_words
            if word_start >= float(range_start or 0.0) - 1e-6 and word_end <= float(range_end or 0.0) + 1e-6
        )
        scores.append(difflib.SequenceMatcher(None, chunk_text, grouped_text).ratio() if chunk_text and grouped_text else 0.0)
    return sum(scores) / max(len(scores), 1)


def _timed_range_alignment_average_similarity(
    *,
    chunks: list[str],
    timed_units: list[dict[str, Any]],
    ranges: list[tuple[float, float]],
) -> float:
    normalized_chunks = [str(item or "").strip() for item in list(chunks or []) if str(item or "").strip()]
    usable_units = [dict(item) for item in list(timed_units or []) if isinstance(item, dict) and str(item.get("text") or "").strip()]
    if not normalized_chunks or len(normalized_chunks) != len(list(ranges or [])):
        return 0.0
    scores: list[float] = []
    for chunk, (range_start, range_end) in zip(normalized_chunks, ranges):
        chunk_text = _video_language_alignment_text(chunk)
        grouped_text = "".join(
            _video_language_alignment_text(item.get("text") or "")
            for item in usable_units
            if float(item.get("start", 0.0) or 0.0) >= float(range_start or 0.0) - 1e-6
            and float(item.get("end", 0.0) or 0.0) <= float(range_end or 0.0) + 1e-6
        )
        scores.append(difflib.SequenceMatcher(None, chunk_text, grouped_text).ratio() if chunk_text and grouped_text else 0.0)
    return sum(scores) / max(len(scores), 1)


def _subtitle_asr_speech_spans(media_path: Path, *, duration_seconds: float) -> list[tuple[float, float]]:
    source = Path(media_path).expanduser().resolve()
    if not source.exists():
        return []
    total = max(float(duration_seconds or 0.0), 0.1)
    segments = _subtitle_asr_segments(source, duration_seconds=total, word_timestamps=False)
    if not segments:
        return []
    spans: list[tuple[float, float]] = []
    for item in segments:
        start = max(0.0, min(float(item.get("start", 0.0) or 0.0), total))
        end = max(start, min(float(item.get("end", 0.0) or 0.0), total))
        text = str(item.get("text", "") or "").strip()
        if text and end - start >= 0.25:
            spans.append((start, end))
    if not spans:
        return []
    merged: list[tuple[float, float]] = []
    for start, end in spans:
        if merged and start - merged[-1][1] <= 0.18:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    active_total = sum(end - start for start, end in merged)
    if active_total < 0.8 or active_total > total * 0.95:
        return []
    return merged


def _subtitle_asr_dialogue_start_times(
    *,
    media_path: Path,
    chunks: list[str],
    duration_seconds: float,
) -> list[float]:
    source = Path(media_path).expanduser().resolve()
    if not chunks or not source.exists():
        return []
    total = max(float(duration_seconds or 0.0), 0.1)
    segments = _subtitle_asr_segments(source, duration_seconds=total, word_timestamps=True)
    if not segments:
        return []
    direct_similarity = _timed_text_alignment_average_similarity(chunks=chunks, timed_units=segments)
    if len(segments) == len(chunks) and direct_similarity >= 0.72:
        return _coerce_monotonic_start_times(
            [float(item.get("start", 0.0) or 0.0) for item in segments],
            duration_seconds=total,
        )
    words = [word for item in segments for word in item.get("words", [])]
    word_ranges = _align_chunks_to_asr_word_ranges(chunks=chunks, words=words, duration_seconds=total)
    if len(word_ranges) == len(chunks):
        word_similarity = _asr_word_range_alignment_average_similarity(chunks=chunks, words=words, ranges=word_ranges)
        if word_similarity >= 0.62:
            return _coerce_monotonic_start_times([float(start or 0.0) for start, _end in word_ranges], duration_seconds=total)
    grouped_ranges = _align_chunks_to_asr_segment_ranges(chunks=chunks, asr_segments=segments, duration_seconds=total)
    if len(grouped_ranges) == len(chunks):
        grouped_similarity = _timed_range_alignment_average_similarity(chunks=chunks, timed_units=segments, ranges=grouped_ranges)
        if grouped_similarity >= 0.62:
            return _coerce_monotonic_start_times([float(start or 0.0) for start, _end in grouped_ranges], duration_seconds=total)
    if len(words) < len(chunks):
        return []
    chunk_weights = [max(len(_video_language_alignment_text(chunk)), 1) for chunk in chunks]
    total_weight = max(sum(chunk_weights), 1)
    total_units = max(sum(max(len(_video_language_alignment_text(word_text)), 1) for word_text, _start, _end in words), 1)
    starts: list[float] = []
    word_index = 0
    unit_cursor = 0
    for idx, _weight in enumerate(chunk_weights):
        starts.append(float(words[min(word_index, len(words) - 1)][1]))
        if idx == len(chunk_weights) - 1:
            break
        target_units = min(total_units, round((sum(chunk_weights[: idx + 1]) / total_weight) * total_units))
        while word_index < len(words) - 1 and unit_cursor < target_units:
            unit_cursor += max(len(_video_language_alignment_text(words[word_index][0])), 1)
            word_index += 1
    return _coerce_monotonic_start_times(starts, duration_seconds=total)


def _subtitle_asr_dialogue_ranges(
    *,
    media_path: Path,
    chunks: list[str],
    duration_seconds: float,
) -> list[tuple[float, float]]:
    source = Path(media_path).expanduser().resolve()
    if not chunks or not source.exists():
        return []
    total = max(float(duration_seconds or 0.0), 0.1)
    segments = _subtitle_asr_segments(source, duration_seconds=total, word_timestamps=True)
    if not segments:
        return []
    direct_similarity = _timed_text_alignment_average_similarity(chunks=chunks, timed_units=segments)
    if len(segments) == len(chunks) and direct_similarity >= 0.72:
        direct_ranges = [(float(item["start"]), float(item["end"])) for item in segments]
        return _coerce_monotonic_dialogue_ranges(direct_ranges, duration_seconds=total)
    words = [word for item in segments for word in item.get("words", [])]
    word_ranges = _align_chunks_to_asr_word_ranges(chunks=chunks, words=words, duration_seconds=total)
    if len(word_ranges) == len(chunks):
        word_similarity = _asr_word_range_alignment_average_similarity(chunks=chunks, words=words, ranges=word_ranges)
        if word_similarity >= 0.62:
            return word_ranges
    grouped_ranges = _align_chunks_to_asr_segment_ranges(chunks=chunks, asr_segments=segments, duration_seconds=total)
    if len(grouped_ranges) == len(chunks):
        grouped_similarity = _timed_range_alignment_average_similarity(chunks=chunks, timed_units=segments, ranges=grouped_ranges)
        if grouped_similarity >= 0.62:
            return grouped_ranges
    if len(words) < len(chunks):
        return []
    chunk_weights = [max(len(_video_language_alignment_text(chunk)), 1) for chunk in chunks]
    total_weight = max(sum(chunk_weights), 1)
    total_units = max(sum(max(len(_video_language_alignment_text(word_text)), 1) for word_text, _start, _end in words), 1)
    ranges: list[tuple[float, float]] = []
    word_index = 0
    unit_cursor = 0
    for idx, _weight in enumerate(chunk_weights):
        start_index = word_index
        if idx == len(chunk_weights) - 1:
            end_index = len(words) - 1
        else:
            target_units = min(total_units, round((sum(chunk_weights[: idx + 1]) / total_weight) * total_units))
            while word_index < len(words) - 1 and unit_cursor < target_units:
                unit_cursor += max(len(_video_language_alignment_text(words[word_index][0])), 1)
                word_index += 1
            end_index = max(start_index, min(word_index, len(words) - 1))
        start = words[start_index][1]
        end = words[end_index][2]
        if end <= start:
            end = min(total, start + 0.85)
        ranges.append((start, end))
    return _coerce_monotonic_dialogue_ranges(ranges, duration_seconds=total) if len(ranges) == len(chunks) else []


def _resolve_ffmpeg_exe() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    try:
        import imageio_ffmpeg

        return str(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception as exc:
        raise RuntimeError("缺少 ffmpeg，无法分析字幕语音区间") from exc


def _detect_audio_active_spans(media_path: Path, *, duration_seconds: float) -> list[tuple[float, float]]:
    source = Path(media_path).expanduser().resolve()
    if not source.exists():
        return []
    try:
        ffmpeg = _resolve_ffmpeg_exe()
        proc = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-nostats",
                "-i",
                str(source),
                "-af",
                "silencedetect=n=-35dB:d=0.12",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except Exception:
        return []
    log_text = f"{proc.stderr}\n{proc.stdout}"
    if "does not contain any stream" in log_text.lower():
        return []
    events: list[tuple[float, str]] = []
    for match in re.finditer(r"silence_(start|end):\s*([0-9]+(?:\.[0-9]+)?)", log_text):
        events.append((max(float(match.group(2)), 0.0), match.group(1)))
    if not events:
        return []
    total = max(float(duration_seconds or 0.0), 0.1)
    events.sort(key=lambda item: item[0])
    spans: list[tuple[float, float]] = []
    cursor = 0.0
    in_silence = False
    for seconds, kind in events:
        seconds = min(max(seconds, 0.0), total)
        if kind == "start":
            if not in_silence and seconds > cursor:
                spans.append((cursor, seconds))
            in_silence = True
        else:
            cursor = seconds
            in_silence = False
    if not in_silence and cursor < total:
        spans.append((cursor, total))
    normalized: list[tuple[float, float]] = []
    for start, end in spans:
        start = max(0.0, min(start, total))
        end = max(start, min(end, total))
        if end - start >= 0.25:
            normalized.append((start, end))
    active_total = sum(end - start for start, end in normalized)
    if active_total < 0.8 or active_total > total * 0.92:
        return []
    return normalized


def _time_in_spans(spans: list[tuple[float, float]], offset: float) -> float:
    remaining = max(float(offset or 0.0), 0.0)
    if not spans:
        return remaining
    for start, end in spans:
        span_duration = max(end - start, 0.0)
        if remaining <= span_duration:
            return start + remaining
        remaining -= span_duration
    return spans[-1][1]


def _subtitle_dialogue_ranges(
    *,
    chunks: list[str],
    duration_seconds: float,
    media_path: Path | None = None,
) -> list[tuple[float, float]]:
    if not chunks:
        return []
    video_duration = max(float(duration_seconds or 0.0), 0.1)
    if media_path is not None:
        asr_ranges = _subtitle_asr_dialogue_ranges(
            media_path=media_path,
            chunks=chunks,
            duration_seconds=video_duration,
        )
        if len(asr_ranges) == len(chunks):
            return asr_ranges
    active_spans = []
    if media_path is not None:
        active_spans = _subtitle_asr_speech_spans(media_path, duration_seconds=video_duration)
        if not active_spans:
            active_spans = _detect_audio_active_spans(media_path, duration_seconds=video_duration)
    active_total = sum(end - start for start, end in active_spans) if active_spans else 0.0
    total = active_total if active_total > 0 else _subtitle_display_total_seconds(chunks, video_duration)
    weights = [max(len(re.sub(r"\s+", "", chunk)), 4) for chunk in chunks]
    weight_total = max(sum(weights), 1)
    ranges: list[tuple[float, float]] = []
    cursor = 0.0
    for idx, weight in enumerate(weights):
        start_offset = cursor
        if idx == len(weights) - 1:
            end_offset = total
        else:
            end_offset = min(total, cursor + total * (weight / weight_total))
        if end_offset - start_offset < 0.85:
            end_offset = min(total, start_offset + 0.85)
        cursor = end_offset
        if active_spans:
            start = _time_in_spans(active_spans, start_offset)
            end = _time_in_spans(active_spans, end_offset)
        else:
            start = start_offset
            end = end_offset
        if end <= start:
            end = min(video_duration, start + 0.85)
        ranges.append((start, end))
    return ranges


def _ass_timestamp(seconds: float) -> str:
    value = max(float(seconds or 0.0), 0.0)
    hours = int(value // 3600)
    minutes = int((value % 3600) // 60)
    secs = int(value % 60)
    centis = int(round((value - int(value)) * 100))
    if centis >= 100:
        secs += 1
        centis = 0
    return f"{hours}:{minutes:02d}:{secs:02d}.{centis:02d}"


def _escape_ass_text(text: Any) -> str:
    return str(text or "").replace("\\", "\\\\").replace("{", "｛").replace("}", "｝").replace("\n", "\\N")


_SUBTITLE_FONT_CACHE: tuple[str, Path | None] | None = None


_SUBTITLE_TEMPLATE_PRESETS: dict[str, dict[str, Any]] = {
    "split_hook": {
        "key": "split_hook",
        "label": "模板1 · 强钩子分屏",
        "preview": {"top_mask": 0, "subtitle_box": True, "subtitle_box_alpha": 78},
        "fixed_overlays": [
            {
                "shape": "polygon",
                "points": [(84, 80), (624, 80), (572, 292), (84, 292)],
                "fill": (255, 246, 244),
                "fill_alpha": 24,
                "outline": (255, 246, 244),
                "outline_alpha": 255,
                "border": 0,
                "blur": 0.0,
            },
            {
                "shape": "polygon",
                "points": [(264, 124), (1014, 124), (1014, 430), (176, 430)],
                "fill": (96, 14, 28),
                "fill_alpha": 38,
                "outline": (105, 17, 31),
                "outline_alpha": 255,
                "border": 0,
                "blur": 0.0,
            },
        ],
        "keyword_styles": [
            {
                "font_size": 92,
                "x": 274,
                "y": 192,
                "align": 7,
                "bold": True,
                "fill": (255, 247, 250),
                "outline": (152, 43, 62),
                "shadow": (72, 19, 28),
                "border": 10,
                "shadow_size": 1,
                "blur": 0.8,
            },
            {
                "font_size": 92,
                "x": 334,
                "y": 292,
                "align": 7,
                "bold": True,
                "fill": (255, 247, 250),
                "outline": (152, 43, 62),
                "shadow": (72, 19, 28),
                "border": 10,
                "shadow_size": 1,
                "blur": 0.8,
            },
        ],
        "subtitle": {
            "font_size": 104,
            "x": 540,
            "y": 1716,
            "align": 2,
            "bold": True,
            "fill": (255, 255, 255),
            "outline": (10, 10, 10),
            "shadow": (0, 0, 0),
            "border": 6,
            "shadow_size": 1,
            "blur": 0.6,
        },
    },
    "handwritten_quote": {
        "key": "handwritten_quote",
        "label": "模板2 · 手写金句",
        "preview": {"top_mask": 0, "subtitle_box": True, "subtitle_box_alpha": 72},
        "fixed_overlays": [
            {
                "shape": "box",
                "x": 98,
                "y": 64,
                "width": 900,
                "height": 304,
                "fill": (24, 18, 16),
                "fill_alpha": 76,
                "outline": (26, 20, 18),
                "outline_alpha": 255,
                "border": 0,
            },
            {
                "shape": "box",
                "x": 132,
                "y": 82,
                "width": 728,
                "height": 58,
                "fill": (246, 208, 96),
                "fill_alpha": 88,
                "outline": (246, 208, 96),
                "outline_alpha": 0,
                "border": 0,
            },
        ],
        "keyword_styles": [
            {
                "font_size": 92,
                "x": 526,
                "y": 152,
                "align": 8,
                "bold": True,
                "fill": (255, 211, 76),
                "outline": (40, 28, 16),
                "shadow": (22, 18, 14),
                "border": 7,
                "shadow_size": 1,
                "blur": 0.8,
            },
            {
                "font_size": 78,
                "x": 552,
                "y": 246,
                "align": 8,
                "bold": True,
                "fill": (255, 211, 76),
                "outline": (40, 28, 16),
                "shadow": (22, 18, 14),
                "border": 7,
                "shadow_size": 1,
                "blur": 0.8,
            },
        ],
        "subtitle": {
            "font_size": 100,
            "x": 540,
            "y": 1752,
            "align": 2,
            "bold": True,
            "fill": (255, 248, 236),
            "outline": (42, 30, 16),
            "shadow": (0, 0, 0),
            "border": 6,
            "shadow_size": 1,
            "blur": 0.7,
        },
    },
    "bilingual_dual": {
        "key": "bilingual_dual",
        "label": "模板3 · 双语字幕",
        "preview": {"top_mask": 0, "subtitle_box": True, "subtitle_box_alpha": 80},
        "fixed_overlays": [
            {
                "shape": "box",
                "x": 130,
                "y": 26,
                "width": 820,
                "height": 310,
                "fill": (34, 40, 52),
                "fill_alpha": 50,
                "outline": (34, 40, 52),
                "outline_alpha": 0,
                "border": 0,
            }
        ],
        "keyword_styles": [
            {
                "font_size": 84,
                "x": 540,
                "y": 78,
                "align": 8,
                "bold": True,
                "fill": (248, 249, 252),
                "outline": (20, 23, 30),
                "shadow": (0, 0, 0),
                "border": 6,
                "shadow_size": 1,
                "blur": 0.7,
            },
            {
                "font_size": 106,
                "x": 540,
                "y": 190,
                "align": 8,
                "bold": True,
                "fill": (106, 222, 255),
                "outline": (33, 70, 102),
                "shadow": (0, 0, 0),
                "border": 6,
                "shadow_size": 1,
                "blur": 0.7,
            },
        ],
        "subtitle": {
            "font_size": 104,
            "x": 540,
            "y": 1758,
            "align": 2,
            "bold": True,
            "fill": (255, 255, 255),
            "outline": (12, 12, 18),
            "shadow": (0, 0, 0),
            "border": 6,
            "shadow_size": 1,
            "blur": 0.7,
        },
    },
    "keyword_focus": {
        "key": "keyword_focus",
        "label": "模板4 · 关键词焦点",
        "preview": {"top_mask": 0, "subtitle_box": False},
        "fixed_overlays": [
            {
                "shape": "box",
                "x": 58,
                "y": 26,
                "width": 964,
                "height": 324,
                "fill": (40, 38, 44),
                "fill_alpha": 48,
                "outline": (40, 38, 44),
                "outline_alpha": 0,
                "border": 0,
            }
        ],
        "keyword_styles": [
            {
                "font_size": 86,
                "x": 540,
                "y": 74,
                "align": 8,
                "bold": True,
                "fill": (255, 255, 255),
                "outline": (24, 26, 32),
                "shadow": (0, 0, 0),
                "border": 6,
                "shadow_size": 1,
                "blur": 0.7,
            },
            {
                "font_size": 118,
                "x": 540,
                "y": 192,
                "align": 8,
                "bold": True,
                "fill": (180, 255, 217),
                "outline": (24, 42, 34),
                "shadow": (0, 0, 0),
                "border": 6,
                "shadow_size": 1,
                "blur": 0.7,
            },
            {
                "font_size": 122,
                "x": 540,
                "y": 1536,
                "align": 8,
                "bold": True,
                "fill": (45, 232, 139),
                "outline": (17, 37, 29),
                "shadow": (239, 255, 245),
                "border": 6,
                "shadow_size": 1,
                "blur": 0.7,
            },
        ],
        "subtitle": {
            "font_size": 98,
            "x": 540,
            "y": 1782,
            "align": 2,
            "bold": True,
            "fill": (244, 255, 250),
            "outline": (16, 40, 30),
            "shadow": (0, 0, 0),
            "border": 5,
            "shadow_size": 1,
            "blur": 0.7,
        },
    },
}

SUBTITLE_TEMPLATE_PRESETS = _SUBTITLE_TEMPLATE_PRESETS
DEFAULT_SUBTITLE_TEMPLATE = "split_hook"


def _subtitle_font_name_from_file(path: Path) -> str:
    name = path.name.lower()
    if "wqy-microhei" in name:
        return "WenQuanYi Micro Hei"
    if "wqy-zenhei" in name:
        return "WenQuanYi Zen Hei"
    if "notosanscjk" in name or "noto sans cjk" in name:
        return "Noto Sans CJK SC"
    if "sourcehansans" in name or "source han sans" in name:
        return "Source Han Sans SC"
    if "uming" in name:
        return "AR PL UMing CN"
    if "ukai" in name:
        return "AR PL UKai CN"
    if "droid" in name and "fallback" in name:
        return "Droid Sans Fallback"
    return path.stem


def _subtitle_font_is_cjk_family(family: str, file_text: str = "") -> bool:
    text = f"{family} {file_text}".lower()
    if any(
        token in text
        for token in (
            "notosanscjk",
            "noto sans cjk",
            "notoserifcjk",
            "noto serif cjk",
            "sourcehan",
            "source han",
            "wenquanyi",
            "wqy",
            "droid sans fallback",
            "uming",
            "ukai",
        )
    ):
        return True
    if any(token in text for token in ("dejavu", "liberation", "ubuntu", "arial", "times new roman")):
        return False
    return any(token in text for token in ("cjk", "han sans", "han serif", "hei", "song", "ming"))


def _resolve_subtitle_font() -> tuple[str, Path | None]:
    global _SUBTITLE_FONT_CACHE
    if _SUBTITLE_FONT_CACHE is not None:
        return _SUBTITLE_FONT_CACHE

    env_name = str(os.getenv("SUBTITLE_FONT_NAME") or "").strip()
    env_file = str(os.getenv("SUBTITLE_FONT_FILE") or "").strip()
    if env_file:
        font_path = Path(env_file).expanduser()
        if font_path.exists():
            _SUBTITLE_FONT_CACHE = (env_name or _subtitle_font_name_from_file(font_path), font_path.resolve())
            return _SUBTITLE_FONT_CACHE
    if env_name:
        _SUBTITLE_FONT_CACHE = (env_name, None)
        return _SUBTITLE_FONT_CACHE

    fc_match = shutil.which("fc-match")
    if fc_match:
        try:
            proc = subprocess.run(
                [fc_match, "-s", "-f", "%{family[0]}|%{file}\n", ":lang=zh"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            for line in (proc.stdout or "").strip().splitlines():
                line = line.strip()
                if not line or "|" not in line:
                    continue
                family, file_text = [item.strip() for item in line.split("|", 1)]
                if not _subtitle_font_is_cjk_family(family, file_text):
                    continue
                font_path = Path(file_text).expanduser() if file_text else None
                if family and font_path and font_path.exists():
                    _SUBTITLE_FONT_CACHE = (family, font_path.resolve())
                    return _SUBTITLE_FONT_CACHE
                if family:
                    _SUBTITLE_FONT_CACHE = (family, None)
                    return _SUBTITLE_FONT_CACHE
        except Exception:
            pass

    candidates = [
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf"),
        Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"),
        Path("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"),
        Path("/usr/share/fonts/truetype/arphic/uming.ttc"),
        Path("/usr/share/fonts/truetype/arphic/ukai.ttc"),
        Path("/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf"),
    ]
    for font_path in candidates:
        if font_path.exists():
            _SUBTITLE_FONT_CACHE = (_subtitle_font_name_from_file(font_path), font_path.resolve())
            return _SUBTITLE_FONT_CACHE

    _SUBTITLE_FONT_CACHE = ("Noto Sans CJK SC", None)
    return _SUBTITLE_FONT_CACHE


def _subtitle_style_line() -> str:
    font_name, _font_path = _resolve_subtitle_font()
    return f"Style: Default,{font_name},112,&H00FFFFFF,&H000000FF,&H99000000,&H66000000,-1,0,0,0,100,100,0,0,1,7,1,2,72,72,180,1"


def _normalize_subtitle_template_key(value: Any) -> str:
    key = str(value or "").strip().lower()
    return key if key in _SUBTITLE_TEMPLATE_PRESETS else DEFAULT_SUBTITLE_TEMPLATE


def _subtitle_template_preset(value: Any) -> dict[str, Any]:
    return _SUBTITLE_TEMPLATE_PRESETS[_normalize_subtitle_template_key(value)]


def _ass_bgr_hex(color: tuple[int, int, int] | list[int] | None) -> str:
    rgb = list(color or (255, 255, 255))[:3]
    while len(rgb) < 3:
        rgb.append(255)
    r, g, b = (max(0, min(int(v), 255)) for v in rgb)
    return f"{b:02X}{g:02X}{r:02X}"


def _ass_alpha_hex(value: Any, default: int = 0) -> str:
    try:
        alpha = int(value if value is not None else default)
    except Exception:
        alpha = int(default)
    alpha = max(0, min(alpha, 255))
    return f"{alpha:02X}"


def _subtitle_style_value(style: dict[str, Any] | None, key: str, default: Any) -> Any:
    if not isinstance(style, dict):
        return default
    value = style.get(key, default)
    return default if value is None else value


def _subtitle_ass_text(text: Any, style: dict[str, Any] | None, *, default_align: int = 8) -> str:
    style = style if isinstance(style, dict) else {}
    align = int(_subtitle_style_value(style, "align", default_align) or default_align)
    pos_x = int(_subtitle_style_value(style, "x", 540) or 540)
    pos_y = int(_subtitle_style_value(style, "y", 340) or 340)
    font_size = max(int(_subtitle_style_value(style, "font_size", 100) or 100), 24)
    fill = _ass_bgr_hex(_subtitle_style_value(style, "fill", (255, 255, 255)))
    outline = _ass_bgr_hex(_subtitle_style_value(style, "outline", (0, 0, 0)))
    shadow = _ass_bgr_hex(_subtitle_style_value(style, "shadow", (0, 0, 0)))
    border = max(float(_subtitle_style_value(style, "border", 6)), 0.0)
    shadow_size = max(float(_subtitle_style_value(style, "shadow_size", 1)), 0.0)
    blur = max(float(_subtitle_style_value(style, "blur", 0.8)), 0.0)
    bold = 1 if _subtitle_style_value(style, "bold", True) else 0
    return (
        rf"{{\an{align}\q2\pos({pos_x},{pos_y})\fs{font_size}\b{bold}"
        rf"\bord{border:.1f}\shad{shadow_size:.1f}\blur{blur:.1f}"
        rf"\1c&H{fill}&\3c&H{outline}&\4c&H{shadow}&}}"
        + _escape_ass_text(text)
    )


def _subtitle_ass_shape(style: dict[str, Any] | None) -> str:
    style = style if isinstance(style, dict) else {}
    shape = str(style.get("shape") or "").strip().lower()
    points = style.get("points")
    if shape not in {"polygon", "box"}:
        return ""
    polygon_points: list[tuple[int, int]] = []
    if shape == "box":
        x = int(_subtitle_style_value(style, "x", 0) or 0)
        y = int(_subtitle_style_value(style, "y", 0) or 0)
        width = max(int(_subtitle_style_value(style, "width", 0) or 0), 1)
        height = max(int(_subtitle_style_value(style, "height", 0) or 0), 1)
        polygon_points = [(x, y), (x + width, y), (x + width, y + height), (x, y + height)]
    elif isinstance(points, list):
        for item in points:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                polygon_points.append((int(item[0]), int(item[1])))
    if len(polygon_points) < 3:
        return ""
    fill = _ass_bgr_hex(_subtitle_style_value(style, "fill", (255, 255, 255)))
    outline = _ass_bgr_hex(_subtitle_style_value(style, "outline", (255, 255, 255)))
    shadow = _ass_bgr_hex(_subtitle_style_value(style, "shadow", (0, 0, 0)))
    fill_alpha = _ass_alpha_hex(_subtitle_style_value(style, "fill_alpha", 0), 0)
    outline_alpha = _ass_alpha_hex(_subtitle_style_value(style, "outline_alpha", 255), 255)
    shadow_alpha = _ass_alpha_hex(_subtitle_style_value(style, "shadow_alpha", 255), 255)
    border = max(float(_subtitle_style_value(style, "border", 0)), 0.0)
    shadow_size = max(float(_subtitle_style_value(style, "shadow_size", 0)), 0.0)
    blur = max(float(_subtitle_style_value(style, "blur", 0.0)), 0.0)
    path = " ".join(
        [f"m {polygon_points[0][0]} {polygon_points[0][1]}"]
        + [f"l {x} {y}" for x, y in polygon_points[1:]]
    )
    return (
        rf"{{\an7\pos(0,0)\p1"
        rf"\bord{border:.1f}\shad{shadow_size:.1f}\blur{blur:.1f}"
        rf"\1c&H{fill}&\1a&H{fill_alpha}&"
        rf"\3c&H{outline}&\3a&H{outline_alpha}&"
        rf"\4c&H{shadow}&\4a&H{shadow_alpha}&}}"
        + path
        + r"{\p0}"
    )


def _subtitle_headline_ass_lines(
    *,
    template_key: Any,
    keyword_lines: list[str] | None,
    duration_seconds: float,
    include_fixed_overlays: bool = True,
) -> list[str]:
    preset = _subtitle_template_preset(template_key)
    fixed_overlays = (
        [item for item in (preset.get("fixed_overlays") or []) if isinstance(item, dict)]
        if include_fixed_overlays
        else []
    )
    keyword_styles = [item for item in (preset.get("keyword_styles") or []) if isinstance(item, dict)]
    headline = preset["headline"] if isinstance(preset.get("headline"), dict) else {}
    subtitle_kicker = preset["subtitle_kicker"] if isinstance(preset.get("subtitle_kicker"), dict) else {}
    lines = [str(item or "").strip()[:14] for item in (keyword_lines or []) if str(item or "").strip()]
    if not lines and not fixed_overlays and not subtitle_kicker:
        return []
    start = _ass_timestamp(0.0)
    end = _ass_timestamp(max(float(duration_seconds or 0.0), 0.1))
    ass_lines: list[str] = []
    for overlay in fixed_overlays:
        shape_line = _subtitle_ass_shape(overlay)
        if shape_line:
            ass_lines.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{shape_line}")
            continue
        if str(overlay.get("text") or "").strip():
            ass_lines.append(
                f"Dialogue: 0,{start},{end},Default,,0,0,0,,{_subtitle_ass_text(str(overlay.get('text') or '').strip(), overlay, default_align=int(overlay.get('align', 8) or 8))}"
            )
    if keyword_styles:
        for idx, line in enumerate(lines[: len(keyword_styles)]):
            style = dict(keyword_styles[idx])
            text = _subtitle_ass_text(line, style, default_align=int(style.get("align", 8) or 8))
            ass_lines.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}")
    else:
        pos_x = int(headline.get("x", 540) or 540)
        base_y = int(headline.get("y", 340) or 340)
        line_gap = max(int(headline.get("line_gap", 116) or 116), 72)
        for idx, line in enumerate(lines[:3]):
            line_style = dict(headline)
            line_style["x"] = pos_x
            line_style["y"] = base_y + idx * line_gap
            text = _subtitle_ass_text(line, line_style, default_align=int(headline.get("align", 8) or 8))
            ass_lines.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}")
    if subtitle_kicker and str(subtitle_kicker.get("text") or "").strip():
        ass_lines.append(
            f"Dialogue: 0,{start},{end},Default,,0,0,0,,{_subtitle_ass_text(str(subtitle_kicker.get('text') or '').strip(), subtitle_kicker, default_align=int(subtitle_kicker.get('align', 8) or 8))}"
        )
    return ass_lines


def _ass_document_lines() -> list[str]:
    return [
        "[Script Info]",
        "ScriptType: v4.00+",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "PlayResX: 1080",
        "PlayResY: 1920",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        _subtitle_style_line(),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]


def _fixed_single_line_subtitle_text(text: Any, *, template_key: str = DEFAULT_SUBTITLE_TEMPLATE) -> str:
    preset = _subtitle_template_preset(template_key)
    subtitle = preset["subtitle"] if isinstance(preset.get("subtitle"), dict) else {}
    return _subtitle_ass_text(text, subtitle, default_align=int(subtitle.get("align", 2) or 2))


def _write_subtitle_ass(
    *,
    chunks: list[str],
    output_path: Path,
    duration_seconds: float,
    media_path: Path | None = None,
    timing_shift_seconds: float = 0.0,
    template_key: str = DEFAULT_SUBTITLE_TEMPLATE,
    keyword_lines: list[str] | None = None,
    include_fixed_overlays: bool = True,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    dialogue_ranges = _subtitle_dialogue_ranges(
        chunks=chunks,
        duration_seconds=float(duration_seconds or 0),
        media_path=media_path,
    )
    lines = _ass_document_lines()
    lines.extend(
        _subtitle_headline_ass_lines(
            template_key=template_key,
            keyword_lines=keyword_lines,
            duration_seconds=float(duration_seconds or 0),
            include_fixed_overlays=include_fixed_overlays,
        )
    )
    last_end = 0.0
    video_duration = max(float(duration_seconds or 0), 0.1)
    timing_shift = min(max(float(timing_shift_seconds or 0.0), -2.0), 2.0)
    for chunk, (raw_start, raw_end) in zip(chunks, dialogue_ranges):
        start = min(max(float(raw_start or 0.0) + timing_shift, 0.0), video_duration)
        end = min(max(float(raw_end or 0.0) + timing_shift, start), video_duration)
        if start < last_end + 0.03:
            start = min(video_duration, last_end + 0.03)
        if end <= start:
            end = min(video_duration, start + 0.35)
        if end <= start:
            continue
        last_end = end
        lines.append(
            f"Dialogue: 0,{_ass_timestamp(start)},{_ass_timestamp(end)},Default,,0,0,0,,{_fixed_single_line_subtitle_text(chunk, template_key=template_key)}"
        )
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return output_path


def _write_segmented_subtitle_ass(
    *,
    segment_texts: list[str],
    segment_durations: list[float],
    output_path: Path,
    timing_shift_seconds: float = 0.0,
    template_key: str = DEFAULT_SUBTITLE_TEMPLATE,
    keyword_lines: list[str] | None = None,
    include_fixed_overlays: bool = True,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    total_duration = max(sum(max(float(item or 0.0), 0.0) for item in segment_durations), 0.1)
    lines = _ass_document_lines()
    lines.extend(
        _subtitle_headline_ass_lines(
            template_key=template_key,
            keyword_lines=keyword_lines,
            duration_seconds=total_duration,
            include_fixed_overlays=include_fixed_overlays,
        )
    )
    cursor = 0.0
    last_end = 0.0
    timing_shift = min(max(float(timing_shift_seconds or 0.0), -2.0), 2.0)
    for text, raw_duration in zip(segment_texts, segment_durations):
        segment_duration = max(float(raw_duration or 0.0), 0.1)
        chunks = _split_subtitle_chunks(text, max_chars=_DIGITAL_HUMAN_SUBTITLE_MAX_CHARS)
        if chunks:
            local_ranges = _subtitle_dialogue_ranges(chunks=chunks, duration_seconds=segment_duration)
            for chunk, (local_start, local_end) in zip(chunks, local_ranges):
                start = min(max(cursor + float(local_start or 0.0) + timing_shift, cursor), cursor + segment_duration)
                end = min(max(cursor + float(local_end or 0.0) + timing_shift, start), cursor + segment_duration)
                if start < last_end + 0.03:
                    start = min(cursor + segment_duration, last_end + 0.03)
                if end <= start:
                    end = min(cursor + segment_duration, start + 0.35)
                if end <= start:
                    continue
                last_end = end
                fixed_text = _fixed_single_line_subtitle_text(chunk, template_key=template_key)
                lines.append(f"Dialogue: 0,{_ass_timestamp(start)},{_ass_timestamp(end)},Default,,0,0,0,,{fixed_text}")
        cursor += segment_duration
        last_end = min(last_end, cursor)
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return output_path


def _ffmpeg_filter_escape(path: Path) -> str:
    text = str(path.resolve())
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def subtitle_ass_filter(ass_path: Path) -> str:
    _font_name, font_path = _resolve_subtitle_font()
    filter_text = f"ass='{_ffmpeg_filter_escape(ass_path)}'"
    if font_path is not None and font_path.parent.exists():
        filter_text = f"{filter_text}:fontsdir='{_ffmpeg_filter_escape(font_path.parent)}'"
    return filter_text


def write_ass_subtitles(
    *,
    output_path: Path,
    chunks: list[str] | None = None,
    duration_seconds: float | None = None,
    media_path: Path | None = None,
    segment_texts: list[str] | None = None,
    segment_durations: list[float] | None = None,
    timing_shift_seconds: float = 0.0,
    template_key: str = DEFAULT_SUBTITLE_TEMPLATE,
    keyword_lines: list[str] | None = None,
    include_fixed_overlays: bool = True,
) -> tuple[Path, str]:
    """Write original-platform ASS subtitles with optional local ASR alignment."""
    target = Path(output_path).expanduser().resolve()
    has_segment_texts = segment_texts is not None or segment_durations is not None
    if has_segment_texts:
        texts = [str(item or "") for item in (segment_texts or [])]
        durations = list(segment_durations or [])
        if not texts or not durations:
            raise ValueError("segment_texts and segment_durations are required")
        if len(texts) != len(durations):
            raise ValueError("segment_texts and segment_durations must have the same length")
        path = _write_segmented_subtitle_ass(
            segment_texts=texts,
            segment_durations=durations,
            output_path=target,
            timing_shift_seconds=timing_shift_seconds,
            template_key=_normalize_subtitle_template_key(template_key),
            keyword_lines=keyword_lines,
            include_fixed_overlays=include_fixed_overlays,
        )
    else:
        normalized_chunks = [str(item or "").strip() for item in (chunks or []) if str(item or "").strip()]
        if not normalized_chunks:
            raise ValueError("chunks are required when segment timings are not provided")
        if duration_seconds is None or float(duration_seconds) <= 0:
            raise ValueError("duration_seconds must be greater than zero")
        path = _write_subtitle_ass(
            chunks=normalized_chunks,
            output_path=target,
            duration_seconds=float(duration_seconds),
            media_path=Path(media_path).expanduser().resolve() if media_path is not None else None,
            timing_shift_seconds=timing_shift_seconds,
            template_key=_normalize_subtitle_template_key(template_key),
            keyword_lines=keyword_lines,
            include_fixed_overlays=include_fixed_overlays,
        )
    return path, subtitle_ass_filter(path)


__all__ = [
    "DEFAULT_SUBTITLE_TEMPLATE",
    "SUBTITLE_TEMPLATE_PRESETS",
    "subtitle_ass_filter",
    "write_ass_subtitles",
]
