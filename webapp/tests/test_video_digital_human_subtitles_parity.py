from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from video_core import digital_human_subtitles as subtitles
from video_core.contracts import VideoTaskContext
from video_core.source_backend import ArchivedSourceBackend
from video_core import source_backend


TEMPLATE_KEYS = (
    "split_hook",
    "handwritten_quote",
    "bilingual_dual",
    "keyword_focus",
)


@pytest.fixture(autouse=True)
def _restore_subtitle_font_cache():
    previous = subtitles._SUBTITLE_FONT_CACHE
    previous_asr = dict(subtitles._SUBTITLE_ASR_MODEL_CACHE)
    subtitles._SUBTITLE_FONT_CACHE = None
    subtitles._SUBTITLE_ASR_MODEL_CACHE.clear()
    try:
        yield
    finally:
        subtitles._SUBTITLE_FONT_CACHE = previous
        subtitles._SUBTITLE_ASR_MODEL_CACHE.clear()
        subtitles._SUBTITLE_ASR_MODEL_CACHE.update(previous_asr)


def _ass_seconds(value: str) -> float:
    hours, minutes, seconds = value.split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


@pytest.mark.parametrize("template_key", TEMPLATE_KEYS)
def test_write_ass_subtitles_preserves_all_four_original_templates(
    tmp_path: Path,
    template_key: str,
) -> None:
    ass_path, filter_text = subtitles.write_ass_subtitles(
        output_path=tmp_path / f"{template_key}.ass",
        chunks=["第一句字幕", "第二句字幕"],
        duration_seconds=5.0,
        template_key=template_key,
        keyword_lines=["核心卖点", "真实体验", "现在出发"],
    )

    content = ass_path.read_text(encoding="utf-8")
    preset = subtitles.SUBTITLE_TEMPLATE_PRESETS[template_key]

    assert ass_path.exists()
    assert "PlayResX: 1080" in content
    assert "PlayResY: 1920" in content
    assert preset["label"].startswith("模板")
    assert content.count(r"\p1") == len(preset["fixed_overlays"])
    assert "核心卖点" in content
    assert "第一句字幕" in content
    assert filter_text.startswith("ass='")


def test_fixed_graphic_layers_span_the_full_video_and_can_be_disabled(tmp_path: Path) -> None:
    enabled_path, _ = subtitles.write_ass_subtitles(
        output_path=tmp_path / "enabled.ass",
        chunks=["字幕"],
        duration_seconds=7.25,
        template_key="split_hook",
        keyword_lines=["标题"],
    )
    disabled_path, _ = subtitles.write_ass_subtitles(
        output_path=tmp_path / "disabled.ass",
        chunks=["字幕"],
        duration_seconds=7.25,
        template_key="split_hook",
        keyword_lines=["标题"],
        include_fixed_overlays=False,
    )

    enabled = enabled_path.read_text(encoding="utf-8")
    disabled = disabled_path.read_text(encoding="utf-8")

    assert enabled.count(r"\p1") == 2
    assert "Dialogue: 0,0:00:00.00,0:00:07.25" in enabled
    assert r"\p1" not in disabled
    assert "标题" in disabled


def test_segmented_subtitle_times_are_strictly_monotonic(tmp_path: Path) -> None:
    ass_path, _ = subtitles.write_ass_subtitles(
        output_path=tmp_path / "segmented.ass",
        segment_texts=[
            "第一段很长的字幕，需要按原平台规则拆成多个字幕块。",
            "第二段字幕继续播放。",
            "第三段字幕收尾。",
        ],
        segment_durations=[3.0, 2.5, 2.0],
        timing_shift_seconds=-0.5,
        template_key="keyword_focus",
        keyword_lines=["分段测试", "时间单调"],
    )
    content = ass_path.read_text(encoding="utf-8")
    ranges: list[tuple[float, float]] = []
    for line in content.splitlines():
        if not line.startswith("Dialogue:") or r"\an2" not in line:
            continue
        match = re.match(r"Dialogue: 0,([^,]+),([^,]+),", line)
        assert match is not None
        ranges.append((_ass_seconds(match.group(1)), _ass_seconds(match.group(2))))

    assert len(ranges) >= 3
    assert all(end > start for start, end in ranges)
    assert all(current_start >= previous_end for (_, previous_end), (current_start, _) in zip(ranges, ranges[1:]))
    assert ranges[-1][1] <= 7.51


def test_cjk_font_file_is_used_for_style_and_ffmpeg_fontsdir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    font_dir = tmp_path / "fonts"
    font_dir.mkdir()
    font_path = font_dir / "NotoSansCJK-Regular.ttc"
    font_path.write_bytes(b"font-placeholder")
    monkeypatch.setenv("SUBTITLE_FONT_FILE", str(font_path))
    monkeypatch.delenv("SUBTITLE_FONT_NAME", raising=False)
    subtitles._SUBTITLE_FONT_CACHE = None

    ass_path, filter_text = subtitles.write_ass_subtitles(
        output_path=tmp_path / "font.ass",
        chunks=["中文字体回退"],
        duration_seconds=2.0,
    )
    content = ass_path.read_text(encoding="utf-8")

    assert "Style: Default,Noto Sans CJK SC," in content
    assert "fontsdir='" in filter_text
    assert str(font_dir.resolve()).replace("\\", "\\\\").replace(":", "\\:") in filter_text


def test_cjk_font_resolution_falls_back_to_original_noto_family(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SUBTITLE_FONT_FILE", raising=False)
    monkeypatch.delenv("SUBTITLE_FONT_NAME", raising=False)
    monkeypatch.setattr(subtitles.shutil, "which", lambda _name: None)
    monkeypatch.setattr(subtitles.Path, "exists", lambda _path: False)

    assert subtitles._resolve_subtitle_font() == ("Noto Sans CJK SC", None)


def test_source_backend_burns_digital_human_segments_with_original_ass(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_video = tmp_path / "source.mp4"
    source_video.write_bytes(b"video")
    commands: list[list[str]] = []

    def fake_local_process(command, **_kwargs):
        commands.append(list(command))
        Path(command[-1]).write_bytes(b"rendered")
        return 0, "", ""

    monkeypatch.setattr(source_backend, "_run_local_process", fake_local_process)
    monkeypatch.setattr(source_backend.shutil, "which", lambda name: "ffmpeg" if name == "ffmpeg" else None)
    backend = ArchivedSourceBackend()
    rendered, count = backend._burn_subtitles_if_requested(
        video_path=source_video,
        payload={"subtitles": {"enabled": True, "template": "split_hook"}},
        context=VideoTaskContext(task_id="subtitle-ass", task_type="create_video"),
        workdir=tmp_path,
        speech_text="第一段。第二段。",
        segment_texts=["第一段", "第二段"],
        segment_durations=[1.5, 2.0],
    )

    assert rendered.exists()
    assert count == 2
    assert (tmp_path / "source.ass").exists()
    filter_index = commands[0].index("-vf") + 1
    assert commands[0][filter_index].startswith("ass='")


def _subtitle_dialogue_times(ass_path: Path) -> list[tuple[float, float]]:
    ranges: list[tuple[float, float]] = []
    for line in ass_path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("Dialogue:") or r"\an2" not in line:
            continue
        match = re.match(r"Dialogue: 0,([^,]+),([^,]+),", line)
        assert match is not None
        ranges.append((_ass_seconds(match.group(1)), _ass_seconds(match.group(2))))
    return ranges


def test_write_ass_subtitles_aligns_dialogue_to_local_asr_word_timestamps(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    media_path = tmp_path / "speech.mp4"
    media_path.write_bytes(b"local-media-placeholder")
    calls: list[dict[str, object]] = []

    class FakeWhisperModel:
        def transcribe(self, source: str, **kwargs):
            calls.append({"source": source, **kwargs})
            return iter(
                [
                    SimpleNamespace(
                        text="第一句字幕",
                        start=0.8,
                        end=1.8,
                        words=[SimpleNamespace(word="第一句字幕", start=0.8, end=1.8)],
                    ),
                    SimpleNamespace(
                        text="第二句字幕",
                        start=3.0,
                        end=4.25,
                        words=[SimpleNamespace(word="第二句字幕", start=3.0, end=4.25)],
                    ),
                ]
            ), SimpleNamespace()

    monkeypatch.setattr(subtitles, "_subtitle_asr_model", lambda: FakeWhisperModel())

    ass_path, _ = subtitles.write_ass_subtitles(
        output_path=tmp_path / "asr-aligned.ass",
        chunks=["第一句字幕", "第二句字幕"],
        duration_seconds=6.0,
        media_path=media_path,
    )

    assert _subtitle_dialogue_times(ass_path) == [(0.8, 1.8), (3.0, 4.25)]
    assert calls == [
        {
            "source": str(media_path.resolve()),
            "language": "zh",
            "vad_filter": True,
            "beam_size": 1,
            "word_timestamps": True,
        }
    ]


def test_write_ass_subtitles_falls_back_when_local_asr_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    media_path = tmp_path / "speech.mp4"
    media_path.write_bytes(b"local-media-placeholder")

    class FailingWhisperModel:
        def transcribe(self, _source: str, **_kwargs):
            raise RuntimeError("local asr unavailable")

    monkeypatch.setattr(subtitles, "_subtitle_asr_model", lambda: FailingWhisperModel())
    monkeypatch.setattr(subtitles, "_detect_audio_active_spans", lambda *_args, **_kwargs: [])

    fallback_path, _ = subtitles.write_ass_subtitles(
        output_path=tmp_path / "fallback.ass",
        chunks=["第一句字幕", "第二句字幕"],
        duration_seconds=6.0,
        media_path=media_path,
    )
    baseline_path, _ = subtitles.write_ass_subtitles(
        output_path=tmp_path / "baseline.ass",
        chunks=["第一句字幕", "第二句字幕"],
        duration_seconds=6.0,
    )

    assert _subtitle_dialogue_times(fallback_path) == _subtitle_dialogue_times(baseline_path)


def test_write_ass_subtitles_falls_back_when_local_asr_model_cannot_initialize(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    media_path = tmp_path / "speech.mp4"
    media_path.write_bytes(b"local-media-placeholder")

    def fail_model_init():
        raise RuntimeError("model initialization failed")

    monkeypatch.setattr(subtitles, "_subtitle_asr_model", fail_model_init)
    monkeypatch.setattr(subtitles, "_detect_audio_active_spans", lambda *_args, **_kwargs: [])

    ass_path, _ = subtitles.write_ass_subtitles(
        output_path=tmp_path / "model-init-fallback.ass",
        chunks=["第一句字幕", "第二句字幕"],
        duration_seconds=6.0,
        media_path=media_path,
    )

    assert len(_subtitle_dialogue_times(ass_path)) == 2


def test_audio_active_spans_use_original_ffmpeg_silence_detection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    media_path = tmp_path / "speech.mp4"
    media_path.write_bytes(b"local-media-placeholder")
    monkeypatch.setattr(subtitles, "_resolve_ffmpeg_exe", lambda: "ffmpeg")
    monkeypatch.setattr(
        subtitles.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(
            stdout="",
            stderr="\n".join(
                [
                    "silence_start: 0.0",
                    "silence_end: 1.0",
                    "silence_start: 2.0",
                    "silence_end: 3.0",
                    "silence_start: 4.0",
                ]
            ),
        ),
    )

    assert subtitles._detect_audio_active_spans(media_path, duration_seconds=5.0) == [
        (1.0, 2.0),
        (3.0, 4.0),
    ]
