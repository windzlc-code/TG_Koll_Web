from __future__ import annotations

import math
import re
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any


def _dialogue_weight(value: Any) -> float:
    compact = re.sub(r"\s+", "", str(value or ""))
    if not compact:
        return 0.0
    ascii_count = len(re.findall(r"[A-Za-z0-9]", compact))
    return max(len(compact) - ascii_count, 0) + ascii_count * 0.55


def prepare_ecommerce_segment_audio_paths(
    *,
    audio_inputs: Sequence[Path],
    segment_durations: Sequence[float],
    workdir: Path,
    segment_dialogues: Sequence[Any] | None = None,
    probe_duration: Callable[[Path], float],
    cut_segment: Callable[[Path, Path, float, float], Path],
    check_cancelled: Callable[[], None] | None = None,
) -> list[Path | None]:
    """Split uploaded voice references exactly as the archived ad runner did."""

    durations = [max(float(item), 0.1) for item in segment_durations]
    if not audio_inputs:
        return [None for _ in durations]
    if not durations:
        return []
    dialogue_hints = [str(item or "").strip() for item in (segment_dialogues or [])]

    def cancelled() -> None:
        if callable(check_cancelled):
            check_cancelled()

    def weights_for_indexes(indexes: list[int]) -> list[float]:
        weights: list[float] = []
        has_dialogue = False
        for index in indexes:
            text = dialogue_hints[index] if 0 <= index < len(dialogue_hints) else ""
            weight = _dialogue_weight(text)
            has_dialogue = has_dialogue or weight > 0
            weights.append(weight)
        if has_dialogue:
            return [weight if weight > 0 else 0.1 for weight in weights]
        return [max(durations[index], 0.1) for index in indexes]

    workdir = Path(workdir).expanduser().resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    inputs = [Path(item).expanduser().resolve() for item in audio_inputs]
    segment_count = len(durations)
    if len(inputs) == 1:
        audio = inputs[0]
        duration = max(float(probe_duration(audio) or 0.0), 0.0)
        if segment_count == 1 and (duration <= 0 or duration <= 15.0):
            return [audio]
        if segment_count > 1 and duration > 0 and any(_dialogue_weight(item) > 0 for item in dialogue_hints):
            prepared: list[Path | None] = [None for _ in durations]
            indexes = list(range(segment_count))
            weights = weights_for_indexes(indexes)
            total_weight = max(sum(weights), 0.1)
            cursor = 0.0
            for position, segment_index in enumerate(indexes):
                cancelled()
                remaining_segments = len(indexes) - position - 1
                if remaining_segments <= 0:
                    cut_duration = max(duration - cursor, 0.1)
                else:
                    cut_duration = max(duration * weights[position] / total_weight, 0.1)
                    maximum = max(duration - cursor - 0.1 * remaining_segments, 0.1)
                    cut_duration = min(cut_duration, maximum)
                cut_duration = min(cut_duration, durations[segment_index], 15.0)
                target = workdir / f"ecommerce_voice_audio_segment_{segment_index + 1}.mp3"
                prepared[segment_index] = cut_segment(audio, target, cursor, cut_duration)
                cursor += cut_duration
            return prepared

        cancelled()
        target = workdir / "ecommerce_voice_audio_reference.mp3"
        cut_duration = min(15.0, max(duration, 0.1) if duration > 0 else 15.0)
        reference = cut_segment(audio, target, 0.0, cut_duration)
        return [reference for _ in durations]

    prepared: list[Path | None] = [None for _ in durations]
    for audio_index, audio in enumerate(inputs):
        start_segment = math.floor(audio_index * segment_count / len(inputs))
        end_segment = math.floor((audio_index + 1) * segment_count / len(inputs))
        if end_segment <= start_segment:
            end_segment = min(start_segment + 1, segment_count)
        assigned = list(range(start_segment, min(end_segment, segment_count)))
        if not assigned:
            continue
        audio_duration = max(float(probe_duration(audio) or 0.0), 0.0)
        weights = weights_for_indexes(assigned)
        total_weight = sum(weights)
        scale = audio_duration / total_weight if audio_duration > 0 and total_weight > 0 else 1.0
        cursor = 0.0
        for local_index, segment_index in enumerate(assigned):
            cancelled()
            target_duration = min(durations[segment_index], 15.0)
            cut_duration = min(target_duration, max(weights[local_index] * scale, 0.1))
            if audio_duration > 0:
                cut_duration = min(cut_duration, max(audio_duration - cursor, 0.1))
            target = workdir / f"ecommerce_voice_audio_segment_{segment_index + 1}.mp3"
            prepared[segment_index] = cut_segment(audio, target, cursor, cut_duration)
            cursor += cut_duration
    return prepared


__all__ = ["prepare_ecommerce_segment_audio_paths"]
