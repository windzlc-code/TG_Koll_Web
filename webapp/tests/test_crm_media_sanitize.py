from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path

from PIL import Image, PngImagePlugin

from webapp.crm.media_sanitize import sanitize_crm_image


class CrmMediaSanitizeTests(unittest.TestCase):
    def _write(self, directory: Path, name: str, payload: bytes) -> Path:
        path = directory / name
        path.write_bytes(payload)
        return path

    def test_jpeg_drops_generator_exif_and_stays_jpeg(self):
        image = Image.new("RGB", (12, 8), (40, 80, 120))
        exif = image.getexif()
        exif[0x010F] = "OpenAI"
        exif[0x0131] = "ChatGPT Image"
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=90, exif=exif)
        raw = buffer.getvalue()
        self.assertIn(b"ChatGPT", raw)
        with tempfile.TemporaryDirectory() as tmp:
            source = self._write(Path(tmp), "ai.jpg", raw)
            cleaned, mime, suffix = sanitize_crm_image(source)
        self.assertEqual(mime, "image/jpeg")
        self.assertEqual(suffix, ".jpg")
        self.assertNotIn(b"ChatGPT", cleaned)
        self.assertNotIn(b"OpenAI", cleaned)
        self.assertNotIn(b"c2pa", cleaned.lower())
        opened = Image.open(io.BytesIO(cleaned))
        self.assertEqual(opened.format, "JPEG")
        self.assertEqual(opened.size, (12, 8))
        self.assertFalse(dict(opened.getexif()))

    def test_png_text_chunks_are_stripped_and_opaque_png_becomes_jpeg(self):
        image = Image.new("RGB", (10, 10), (200, 30, 30))
        info = PngImagePlugin.PngInfo()
        info.add_text("Software", "Midjourney")
        info.add_text("Comment", "c2pa:urn:ai")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", pnginfo=info)
        raw = buffer.getvalue()
        self.assertIn(b"Midjourney", raw)
        with tempfile.TemporaryDirectory() as tmp:
            source = self._write(Path(tmp), "ai.png", raw)
            cleaned, mime, suffix = sanitize_crm_image(source)
        self.assertEqual(mime, "image/jpeg")
        self.assertEqual(suffix, ".jpg")
        self.assertNotIn(b"Midjourney", cleaned)
        self.assertNotIn(b"c2pa", cleaned.lower())
        opened = Image.open(io.BytesIO(cleaned))
        self.assertEqual(opened.format, "JPEG")
        self.assertEqual(opened.size, (10, 10))

    def test_transparent_png_stays_png_without_text(self):
        image = Image.new("RGBA", (6, 6), (10, 20, 30, 80))
        info = PngImagePlugin.PngInfo()
        info.add_text("Software", "Google Imagen")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", pnginfo=info)
        with tempfile.TemporaryDirectory() as tmp:
            source = self._write(Path(tmp), "alpha.png", buffer.getvalue())
            cleaned, mime, suffix = sanitize_crm_image(source)
        self.assertEqual(mime, "image/png")
        self.assertEqual(suffix, ".png")
        self.assertNotIn(b"Imagen", cleaned)
        opened = Image.open(io.BytesIO(cleaned))
        self.assertEqual(opened.format, "PNG")
        self.assertEqual(opened.mode, "RGBA")
        self.assertNotIn("Software", opened.info)
