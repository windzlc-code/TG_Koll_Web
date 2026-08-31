from __future__ import annotations

import io
from pathlib import Path

from PIL import Image, ImageOps, PngImagePlugin

_JPEG = "image/jpeg"
_PNG = "image/png"


def _has_visible_alpha(image: Image.Image) -> bool:
    if image.mode == "P" and "transparency" in image.info:
        return True
    if "A" not in image.getbands():
        return False
    extrema = image.convert("RGBA").getchannel("A").getextrema()
    return bool(extrema and extrema[0] < 255)


def sanitize_crm_image(source: Path) -> tuple[bytes, str, str]:
    """Re-encode pixels only. Drop EXIF/XMP/IPTC/C2PA and PNG text chunks.

    Does not invent camera make/model or other capture provenance.
    Returns (payload, mime_type, suffix).
    """
    with Image.open(source) as opened:
        opened.load()
        image = ImageOps.exif_transpose(opened).copy()
    if _has_visible_alpha(image):
        converted = image.convert("RGBA")
        buffer = io.BytesIO()
        converted.save(buffer, format="PNG", optimize=True, pnginfo=PngImagePlugin.PngInfo())
        return buffer.getvalue(), _PNG, ".png"
    if image.mode in {"RGBA", "LA", "PA", "P"}:
        rgba = image.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, (255, 255, 255))
        canvas.paste(rgba, mask=rgba.getchannel("A"))
        rgb = canvas
    else:
        rgb = image.convert("RGB")
    buffer = io.BytesIO()
    rgb.save(buffer, format="JPEG", quality=92, optimize=True, progressive=False)
    return buffer.getvalue(), _JPEG, ".jpg"
