from __future__ import annotations

import threading
from pathlib import Path

import pytest

from video_core.contracts import VideoTaskCancelled, VideoTaskContext
from video_core.language_voice_pipeline import (
    prepare_language_voice,
    prepare_language_voice_settings,
)


def _context(cancel_event: threading.Event | None = None) -> VideoTaskContext:
    return VideoTaskContext(
        task_id="task-language-voice",
        task_type="video_language_replace",
        cancel_event=cancel_event,
    )


def test_final_target_audio_bypasses_voice_clone_and_tts(tmp_path: Path) -> None:
    target_audio = tmp_path / "translated-final.mp3"
    reference_audio = tmp_path / "reference.wav"
    target_audio.write_bytes(b"final")
    reference_audio.write_bytes(b"reference")

    def unexpected_provider(**_kwargs):
        pytest.fail("an already generated target audio must not trigger a provider call")

    result = prepare_language_voice(
        {
            "target_audio_local_path": str(target_audio),
            "audio_local_path": str(reference_audio),
            "target_script": "This must not be synthesized.",
            "_video_voice_clone": unexpected_provider,
            "_video_tts_generate": unexpected_provider,
        },
        _context(),
        tmp_path / "work",
    )

    assert result["target_audio_path"] == str(target_audio.resolve())
    assert result["reference_audio_path"] == str(reference_audio.resolve())
    assert result["mode"] == "provided_target_audio"
    assert result["tts_generated"] is False
    assert result["voice_cloned"] is False


def test_settings_helper_resolves_config_without_calling_clone_or_tts(tmp_path: Path) -> None:
    def unexpected_provider(**_kwargs):
        pytest.fail("settings-only preparation must not call a provider without a reference")

    result = prepare_language_voice_settings(
        {
            "target_language": "English",
            "video_tts_model": "speech-2.8-turbo",
            "video_default_voice_id": "configured-voice",
            "audio_speed": 1.2,
            "_video_voice_clone": unexpected_provider,
            "_video_tts_generate": unexpected_provider,
        },
        _context(),
        tmp_path / "work",
    )

    settings = result["settings"]
    assert settings.language == "English"
    assert settings.minimax_model == "speech-2.8-turbo"
    assert settings.minimax_voice_id == "configured-voice"
    assert settings.speed == pytest.approx(1.2)
    assert result["cloned_voice_id"] == ""
    assert result["reference_audio_path"] == ""


def test_settings_helper_clones_reference_without_calling_tts(tmp_path: Path) -> None:
    reference_audio = tmp_path / "reference-only.wav"
    reference_audio.write_bytes(b"reference")
    calls = []

    def clone_voice(*, reference_audio_path, settings, workdir, **_kwargs):
        calls.append((Path(reference_audio_path), settings.minimax_voice_id, Path(workdir)))
        return {"cloned_voice_id": "settings-clone"}

    def unexpected_tts(**_kwargs):
        pytest.fail("settings-only preparation must never call TTS")

    result = prepare_language_voice_settings(
        {
            "voice_audio_local_path": str(reference_audio),
            "minimax_tts_voice_id": "base-voice",
            "_video_voice_clone": clone_voice,
            "_video_tts_generate": unexpected_tts,
        },
        _context(),
        tmp_path / "work",
    )

    assert calls == [
        (reference_audio.resolve(), "base-voice", (tmp_path / "work").resolve())
    ]
    assert result["settings"].minimax_voice_id == "settings-clone"
    assert result["cloned_voice_id"] == "settings-clone"
    assert result["reference_audio_path"] == str(reference_audio.resolve())


def test_prepare_language_voice_reuses_settings_helper(monkeypatch, tmp_path: Path) -> None:
    from video_core import language_voice_pipeline

    calls = []
    original_helper = language_voice_pipeline.prepare_language_voice_settings

    def wrapped_helper(payload, context, workdir):
        calls.append((payload, context, Path(workdir)))
        return original_helper(payload, context, workdir)

    def generate_tts(*, settings, output_path, **_kwargs):
        assert settings.minimax_voice_id == "segment-compatible-voice"
        Path(output_path).write_bytes(b"generated")
        return Path(output_path)

    monkeypatch.setattr(
        language_voice_pipeline,
        "prepare_language_voice_settings",
        wrapped_helper,
    )

    result = prepare_language_voice(
        {
            "target_script": "Generate through the refactored path",
            "minimax_tts_voice_id": "segment-compatible-voice",
            "_video_tts_generate": generate_tts,
        },
        _context(),
        tmp_path / "work",
    )

    assert len(calls) == 1
    assert calls[0][2] == (tmp_path / "work").resolve()
    assert Path(result["target_audio_path"]).read_bytes() == b"generated"


def test_reference_audio_is_cloned_then_used_for_target_tts(tmp_path: Path) -> None:
    reference_audio = tmp_path / "reference.wav"
    reference_audio.write_bytes(b"reference")
    calls: list[tuple[str, object]] = []

    def clone_voice(*, reference_audio_path, settings, context, **_kwargs):
        context.check_cancelled()
        calls.append(("clone", (Path(reference_audio_path), settings)))
        return "cloned-voice-id"

    def generate_tts(*, speech_text, settings, output_path, context, **_kwargs):
        context.check_cancelled()
        calls.append(("tts", (speech_text, settings)))
        Path(output_path).write_bytes(b"generated")
        return Path(output_path)

    result = prepare_language_voice(
        {
            "audio_local_path": str(reference_audio),
            "target_script": "Hello from the translated script.",
            "target_language": "English",
            "video_tts_api_key": "test-only-key",
            "video_tts_model": "speech-2.8-turbo",
            "video_default_voice_id": "preset-voice",
            "audio_speed": 1.15,
            "emotion": "happy",
            "_video_voice_clone": clone_voice,
            "_video_tts_generate": generate_tts,
        },
        _context(),
        tmp_path / "work",
    )

    assert [item[0] for item in calls] == ["clone", "tts"]
    clone_path, clone_settings = calls[0][1]
    speech_text, tts_settings = calls[1][1]
    assert clone_path == reference_audio.resolve()
    assert clone_settings.minimax_voice_id == "preset-voice"
    assert clone_settings.minimax_model == "speech-2.8-turbo"
    assert clone_settings.language == "English"
    assert clone_settings.speed == pytest.approx(1.15)
    assert clone_settings.emotion == "happy"
    assert speech_text == "Hello from the translated script."
    assert tts_settings.minimax_voice_id == "cloned-voice-id"
    assert result["cloned_voice_id"] == "cloned-voice-id"
    assert result["mode"] == "cloned_voice_tts"
    assert result["voice_cloned"] is True
    assert result["tts_generated"] is True
    assert Path(result["target_audio_path"]).read_bytes() == b"generated"


def test_voice_audio_alias_is_a_clone_reference_not_final_audio(tmp_path: Path) -> None:
    reference_audio = tmp_path / "voice-alias.mp3"
    reference_audio.write_bytes(b"reference")
    clone_paths: list[Path] = []

    def clone_voice(*, reference_audio_path, **_kwargs):
        clone_paths.append(Path(reference_audio_path))
        return {"voice_id": "alias-clone"}

    def generate_tts(*, output_path, **_kwargs):
        Path(output_path).write_bytes(b"tts")
        return {"audio_path": str(output_path), "emotion": "calm"}

    result = prepare_language_voice(
        {
            "voice_audio_local_path": str(reference_audio),
            "translated_script": "Translated copy",
            "_video_voice_clone": clone_voice,
            "_video_tts_generate": generate_tts,
        },
        _context(),
        tmp_path / "work",
    )

    assert clone_paths == [reference_audio.resolve()]
    assert result["cloned_voice_id"] == "alias-clone"
    assert result["tts_emotion"] == "calm"
    assert Path(result["target_audio_path"]).read_bytes() == b"tts"


def test_without_reference_audio_uses_configured_voice_directly(tmp_path: Path) -> None:
    captured = {}

    def unexpected_clone(**_kwargs):
        pytest.fail("voice clone must not run without a reference audio")

    def generate_tts(*, settings, output_path, **_kwargs):
        captured["voice_id"] = settings.minimax_voice_id
        Path(output_path).write_bytes(b"preset")
        return Path(output_path), "neutral"

    result = prepare_language_voice(
        {
            "speech_text": "Preset voice text",
            "minimax_tts_voice_id": "configured-voice",
            "_video_voice_clone": unexpected_clone,
            "_video_tts_generate": generate_tts,
        },
        _context(),
        tmp_path / "work",
    )

    assert captured["voice_id"] == "configured-voice"
    assert result["mode"] == "preset_voice_tts"
    assert result["voice_cloned"] is False


def test_source_module_clone_and_tts_are_the_default_providers(monkeypatch, tmp_path: Path) -> None:
    from video_core import language_voice_pipeline

    reference_audio = tmp_path / "reference.mp3"
    reference_audio.write_bytes(b"reference")
    observed = {}

    def fake_source_clone(*, reference_audio_path, settings, logger=None):
        observed["clone"] = (Path(reference_audio_path), settings, logger)
        return "source-clone"

    def fake_source_tts(*, speech_text, settings, output_path, logger=None):
        observed["tts"] = (speech_text, settings, logger)
        Path(output_path).write_bytes(b"source-tts")
        return Path(output_path)

    monkeypatch.setattr(
        language_voice_pipeline.commerce_video_generator,
        "clone_minimax_voice_from_reference",
        fake_source_clone,
    )
    monkeypatch.setattr(
        language_voice_pipeline.commerce_video_generator,
        "_generate_minimax_audio",
        fake_source_tts,
    )

    result = prepare_language_voice(
        {
            "audio_local_path": str(reference_audio),
            "target_script": "Use archived providers",
        },
        _context(),
        tmp_path / "work",
    )

    assert observed["clone"][0] == reference_audio.resolve()
    assert observed["tts"][0] == "Use archived providers"
    assert observed["tts"][1].minimax_voice_id == "source-clone"
    assert Path(result["target_audio_path"]).read_bytes() == b"source-tts"


def test_missing_reference_and_empty_script_fails_before_provider_call(tmp_path: Path) -> None:
    calls = []

    def provider(**_kwargs):
        calls.append(True)

    with pytest.raises(ValueError, match="target script"):
        prepare_language_voice(
            {
                "audio_local_path": str(tmp_path / "missing.wav"),
                "_video_voice_clone": provider,
                "_video_tts_generate": provider,
            },
            _context(),
            tmp_path / "work",
        )

    assert calls == []


def test_cancellation_before_start_prevents_all_provider_calls(tmp_path: Path) -> None:
    cancel_event = threading.Event()
    cancel_event.set()

    def provider(**_kwargs):
        pytest.fail("cancelled preparation must not call a provider")

    with pytest.raises(VideoTaskCancelled):
        prepare_language_voice(
            {
                "target_script": "Do not generate",
                "_video_tts_generate": provider,
            },
            _context(cancel_event),
            tmp_path / "work",
        )


def test_cancellation_after_clone_prevents_tts(tmp_path: Path) -> None:
    cancel_event = threading.Event()
    reference_audio = tmp_path / "reference.wav"
    reference_audio.write_bytes(b"reference")

    def clone_voice(**_kwargs):
        cancel_event.set()
        return "cloned-before-cancel"

    def unexpected_tts(**_kwargs):
        pytest.fail("TTS must not start after cancellation")

    with pytest.raises(VideoTaskCancelled):
        prepare_language_voice(
            {
                "audio_local_path": str(reference_audio),
                "target_script": "Do not synthesize after cancellation",
                "_video_voice_clone": clone_voice,
                "_video_tts_generate": unexpected_tts,
            },
            _context(cancel_event),
            tmp_path / "work",
        )
