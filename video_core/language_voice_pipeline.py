from __future__ import annotations

import inspect
from dataclasses import asdict, replace
from pathlib import Path
from typing import Any, Callable

from .contracts import VideoTaskContext
from .source import commerce_video_generator


_DEFAULT_MINIMAX_BASE_URL = "https://api.minimaxi.com"
_LANGUAGE_ALIASES = {
    "chinese": "Chinese",
    "中文": "Chinese",
    "汉语": "Chinese",
    "中文简体": "Chinese",
    "english": "English",
    "英文": "English",
    "英语": "English",
    "japanese": "Japanese",
    "日文": "Japanese",
    "日语": "Japanese",
    "日本語": "Japanese",
    "malay": "Malay",
    "马来语": "Malay",
    "馬來語": "Malay",
    "bahasa malaysia": "Malay",
    "bahasa melayu": "Malay",
    "spanish": "Spanish",
    "西班牙语": "Spanish",
    "西班牙語": "Spanish",
    "español": "Spanish",
    "thai": "Thai",
    "泰语": "Thai",
    "泰語": "Thai",
    "indonesian": "Indonesian",
    "印尼语": "Indonesian",
    "印尼語": "Indonesian",
    "印度尼西亚语": "Indonesian",
    "印度尼西亞語": "Indonesian",
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _bool(value: Any, default: bool) -> bool:
    if value is None or value == "":
        return bool(default)
    if isinstance(value, bool):
        return value
    normalized = _text(value).lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return bool(default)


def _normalize_language(value: Any) -> str:
    text = _text(value)
    if text in {"Chinese", "English", "Japanese", "Malay", "Spanish", "Thai", "Indonesian"}:
        return text
    return _LANGUAGE_ALIASES.get(text.lower(), _LANGUAGE_ALIASES.get(text, "Chinese"))


def _invoke_compatible(callback: Callable[..., Any], **values: Any) -> Any:
    """Call injected providers without forcing them to accept adapter-only fields."""

    try:
        signature = inspect.signature(callback)
    except (TypeError, ValueError):
        return callback(**values)
    accepts_kwargs = any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
    )
    kwargs = values if accepts_kwargs else {
        name: value for name, value in values.items() if name in signature.parameters
    }
    return callback(**kwargs)


def _resolve_callback(payload: dict[str, Any], *names: str) -> Callable[..., Any] | None:
    for name in names:
        callback = payload.get(name)
        if callable(callback):
            return callback
    return None


def _build_audio_settings(payload: dict[str, Any]) -> commerce_video_generator.AudioSettings:
    """Build the same MiniMax settings used by the archived language runner."""

    language = _normalize_language(payload.get("target_language") or payload.get("language"))
    configured_boost = _text(payload.get("minimax_tts_language_boost"))
    language_boost = configured_boost if configured_boost.lower() not in {"", "auto"} else language
    voice_id = _text(
        payload.get("voice_id")
        or payload.get("video_default_voice_id")
        or payload.get("minimax_tts_voice_id")
        or payload.get("speaker")
        or "male-qn-qingse"
    )
    return commerce_video_generator.AudioSettings(
        emotion=_text(payload.get("emotion") or "neutral"),
        language=language,
        model_choice=_text(payload.get("model_choice") or "1.7B"),
        speaker=_text(payload.get("speaker") or "Ryan"),
        app_id=_text(payload.get("create_audio_app_id")),
        # The original language replacement runner explicitly changes the
        # digital-human default (1.08) to 1.0 when no speed was supplied.
        speed=_float(payload.get("audio_speed"), 1.0),
        volume_gain_db=_float(payload.get("audio_volume_gain_db"), 8.0),
        tts_provider="minimax",
        minimax_api_key=_text(payload.get("video_tts_api_key") or payload.get("minimax_api_key")),
        minimax_base_url=_text(
            payload.get("video_tts_base_url")
            or payload.get("minimax_base_url")
            or _DEFAULT_MINIMAX_BASE_URL
        ).rstrip("/"),
        minimax_model=_text(
            payload.get("video_tts_model")
            or payload.get("minimax_tts_model")
            or "speech-2.8-hd"
        ),
        minimax_voice_id=voice_id,
        minimax_format=_text(payload.get("minimax_tts_format") or "mp3").lower(),
        minimax_sample_rate=max(int(_float(payload.get("minimax_tts_sample_rate"), 32000)), 8000),
        minimax_bitrate=max(int(_float(payload.get("minimax_tts_bitrate"), 128000)), 32000),
        minimax_channel=max(int(_float(payload.get("minimax_tts_channel"), 1)), 1),
        minimax_language_boost=language_boost,
        reverb_enabled=_bool(payload.get("digital_human_audio_reverb_enabled"), True),
        reverb_in_gain=_float(payload.get("digital_human_audio_reverb_in_gain"), 0.92),
        reverb_out_gain=_float(payload.get("digital_human_audio_reverb_out_gain"), 1.0),
        reverb_delays_ms=_text(payload.get("digital_human_audio_reverb_delays_ms") or "65|125|190"),
        reverb_decays=_text(payload.get("digital_human_audio_reverb_decays") or "0.10|0.055|0.025"),
    )


def _voice_id_from_result(value: Any) -> str:
    if isinstance(value, dict):
        return _text(value.get("voice_id") or value.get("cloned_voice_id") or value.get("id"))
    return _text(value)


def _audio_result(value: Any, *, default_emotion: str) -> tuple[Path, str]:
    emotion = default_emotion
    candidate = value
    if isinstance(value, tuple):
        if not value:
            raise RuntimeError("TTS provider returned an empty result")
        candidate = value[0]
        if len(value) > 1 and _text(value[1]):
            emotion = _text(value[1])
    elif isinstance(value, dict):
        candidate = (
            value.get("audio_path")
            or value.get("target_audio_path")
            or value.get("output_path")
            or value.get("path")
        )
        if _text(value.get("emotion")):
            emotion = _text(value.get("emotion"))
    path_text = _text(candidate)
    if not path_text:
        raise RuntimeError("TTS provider did not return an audio path")
    return Path(path_text).expanduser().resolve(), emotion


def prepare_language_voice_settings(
    payload: dict[str, Any],
    context: VideoTaskContext,
    workdir: str | Path,
) -> dict[str, Any]:
    """Resolve MiniMax settings and optionally clone a reference voice.

    This helper deliberately performs no TTS generation. It is suitable for
    callers that must retain their own per-timestamp or per-segment TTS loop
    while sharing the archived platform's voice-clone semantics.
    """

    source = dict(payload or {})
    output_dir = Path(workdir).expanduser().resolve()
    context.check_cancelled()
    output_dir.mkdir(parents=True, exist_ok=True)

    reference_audio_text = _text(
        source.get("audio_local_path") or source.get("voice_audio_local_path")
    )
    reference_path = (
        Path(reference_audio_text).expanduser().resolve()
        if reference_audio_text
        else None
    )
    if reference_path is not None and (not reference_path.exists() or not reference_path.is_file()):
        raise FileNotFoundError(f"voice reference audio does not exist: {reference_path}")

    settings = _build_audio_settings(source)
    cloned_voice_id = ""
    if reference_path is not None:
        context.progress(
            stage="audio_clone",
            status="running",
            message="正在克隆参考音频音色",
            progress=42,
        )
        clone_provider = _resolve_callback(
            source,
            "_video_voice_clone",
            "_clone_minimax_voice_from_reference",
            "_clone_voice_from_reference",
        ) or commerce_video_generator.clone_minimax_voice_from_reference
        context.check_cancelled()
        clone_result = _invoke_compatible(
            clone_provider,
            reference_audio_path=reference_path,
            settings=settings,
            payload=source,
            context=context,
            workdir=output_dir,
            logger=context.log,
        )
        context.check_cancelled()
        cloned_voice_id = _voice_id_from_result(clone_result)
        if not cloned_voice_id:
            raise RuntimeError("voice clone provider did not return a voice id")
        settings = replace(settings, minimax_voice_id=cloned_voice_id)

    return {
        "settings": settings,
        "cloned_voice_id": cloned_voice_id,
        "reference_audio_path": str(reference_path) if reference_path else "",
    }


def prepare_language_voice(
    payload: dict[str, Any],
    context: VideoTaskContext,
    workdir: str | Path,
) -> dict[str, Any]:
    """Prepare final target-language audio using archived platform semantics.

    ``target_audio_local_path`` is a completed target-language track and is
    returned unchanged. ``audio_local_path`` and ``voice_audio_local_path`` are
    only voice-clone references; when either is present the cloned voice id is
    applied to the subsequent MiniMax TTS call.

    Providers can be injected through ``_video_voice_clone`` and
    ``_video_tts_generate`` (legacy-compatible aliases are accepted). Without
    injections, the white-listed archived ``commerce_video_generator`` clone
    and MiniMax TTS functions are used.
    """

    source = dict(payload or {})
    output_dir = Path(workdir).expanduser().resolve()
    context.check_cancelled()

    target_audio_text = _text(source.get("target_audio_local_path"))
    reference_audio_text = _text(
        source.get("audio_local_path") or source.get("voice_audio_local_path")
    )
    reference_path = (
        Path(reference_audio_text).expanduser().resolve()
        if reference_audio_text
        else None
    )

    if target_audio_text:
        target_path = Path(target_audio_text).expanduser().resolve()
        if not target_path.exists() or not target_path.is_file():
            raise FileNotFoundError(f"target audio does not exist: {target_path}")
        context.check_cancelled()
        return {
            "target_audio_path": str(target_path),
            "reference_audio_path": str(reference_path) if reference_path else "",
            "cloned_voice_id": "",
            "tts_emotion": "",
            "mode": "provided_target_audio",
            "voice_cloned": False,
            "tts_generated": False,
            "settings": {},
        }

    speech_text = _text(
        source.get("target_script")
        or source.get("translated_script")
        or source.get("script")
        or source.get("speech_text")
        or source.get("copy_text")
    )
    if not speech_text:
        raise ValueError("target script is required when target_audio_local_path is absent")
    prepared_settings = prepare_language_voice_settings(source, context, output_dir)
    settings = prepared_settings["settings"]
    cloned_voice_id = _text(prepared_settings.get("cloned_voice_id"))
    prepared_reference_path = _text(prepared_settings.get("reference_audio_path"))
    reference_path = Path(prepared_reference_path) if prepared_reference_path else None

    context.progress(
        stage="audio",
        status="running",
        message="正在生成目标语言音频",
        progress=50,
    )
    tts_provider = _resolve_callback(
        source,
        "_video_tts_generate",
        "_generate_video_language_tts_audio",
        "_generate_tts_audio",
    )
    requested_emotion = _text(source.get("emotion") or settings.emotion or "neutral")
    output_suffix = settings.minimax_format if settings.minimax_format in {"mp3", "wav", "flac"} else "mp3"
    output_path = output_dir / f"video_language_target.{output_suffix}"
    context.check_cancelled()
    if tts_provider is None:
        generated = commerce_video_generator._generate_minimax_audio(
            speech_text=speech_text,
            settings=settings,
            output_path=output_path,
            logger=context.log,
        )
    else:
        generated = _invoke_compatible(
            tts_provider,
            speech_text=speech_text,
            settings=settings,
            base_settings=settings,
            requested_emotion=requested_emotion,
            role="source",
            output_path=output_path,
            payload=source,
            context=context,
            workdir=output_dir,
            logger=context.log,
        )
    context.check_cancelled()
    target_path, used_emotion = _audio_result(generated, default_emotion=requested_emotion)
    if not target_path.exists() or not target_path.is_file():
        raise FileNotFoundError(f"TTS output does not exist: {target_path}")

    return {
        "target_audio_path": str(target_path),
        "reference_audio_path": str(reference_path) if reference_path else "",
        "cloned_voice_id": cloned_voice_id,
        "tts_emotion": used_emotion,
        "mode": "cloned_voice_tts" if cloned_voice_id else "preset_voice_tts",
        "voice_cloned": bool(cloned_voice_id),
        "tts_generated": True,
        "settings": asdict(settings),
    }


__all__ = ["prepare_language_voice", "prepare_language_voice_settings"]
