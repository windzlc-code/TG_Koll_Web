from __future__ import annotations

import io
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps, PngImagePlugin

_STILL_FORMATS = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP"}


def sanitize_generated_image_file(path: str | Path) -> dict[str, Any]:
    """Re-encode a model still in place without metadata. GIFs and undecodable files are left unchanged."""
    source = Path(path)
    suffix = source.suffix.lower()
    if not source.is_file():
        return {"ok": False, "changed": False, "skipped": "missing"}
    if suffix == ".gif" or suffix not in _STILL_FORMATS:
        return {"ok": True, "changed": False, "skipped": "gif" if suffix == ".gif" else "format"}
    try:
        payload = _reencode_without_metadata(source, _STILL_FORMATS[suffix])
    except Exception as exc:
        return {"ok": False, "changed": False, "skipped": "decode", "error": str(exc)}
    temp = source.with_name(f".{source.name}.sanitize.tmp")
    temp.write_bytes(payload)
    temp.replace(source)
    return {"ok": True, "changed": True, "skipped": ""}


def _reencode_without_metadata(source: Path, fmt: str) -> bytes:
    with Image.open(source) as opened:
        opened.load()
        image = ImageOps.exif_transpose(opened).copy()
    buffer = io.BytesIO()
    if fmt == "JPEG":
        if image.mode in {"RGBA", "LA", "PA", "P"}:
            rgba = image.convert("RGBA")
            canvas = Image.new("RGB", rgba.size, (255, 255, 255))
            canvas.paste(rgba, mask=rgba.getchannel("A"))
            rgb = canvas
        else:
            rgb = image.convert("RGB")
        rgb.save(buffer, format="JPEG", quality=92, optimize=True, progressive=False)
        return buffer.getvalue()
    if fmt == "PNG":
        converted = image.convert("RGBA") if "A" in image.getbands() or image.mode == "P" else image.convert("RGB")
        converted.save(buffer, format="PNG", optimize=True, pnginfo=PngImagePlugin.PngInfo())
        return buffer.getvalue()
    converted = image.convert("RGBA") if "A" in image.getbands() else image.convert("RGB")
    converted.save(buffer, format="WEBP", quality=92, method=4, exif=b"")
    return buffer.getvalue()
