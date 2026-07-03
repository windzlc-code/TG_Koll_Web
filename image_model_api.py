def _resolve_api_key(*, model: str, gemini_api_key: str = "", gpt_api_key: str = "") -> str:
    model_name = str(model or "").strip().lower()
    if model_name.startswith("gpt-") or "openai" in model_name:
        return str(gpt_api_key or "").strip()
    return str(gemini_api_key or "").strip()
