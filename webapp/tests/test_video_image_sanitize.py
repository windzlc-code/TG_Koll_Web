from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path

from PIL import Image, PngImagePlugin

from video_core.contracts import VideoTaskContext
from video_core.image_generate_dispatch import dispatch_image_generate
from video_core.image_sanitize import sanitize_generated_image_file


class GeneratedImageSanitizeTests(unittest.TestCase):
    def test_jpeg_drops_generator_exif(self):
        image = Image.new("RGB", (12, 8), (40, 80, 120))
        exif = image.getexif()
        exif[0x010F] = "OpenAI"
        exif[0x0131] = "ChatGPT Image"
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=90, exif=exif)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ai.jpg"
            path.write_bytes(buffer.getvalue())
            result = sanitize_generated_image_file(path)
            cleaned = path.read_bytes()
        self.assertTrue(result["changed"])
        self.assertNotIn(b"ChatGPT", cleaned)
        self.assertNotIn(b"OpenAI", cleaned)
        opened = Image.open(io.BytesIO(cleaned))
        self.assertEqual(opened.format, "JPEG")
        self.assertFalse(dict(opened.getexif()))

    def test_png_text_is_stripped_but_file_stays_png(self):
        image = Image.new("RGB", (10, 10), (200, 30, 30))
        info = PngImagePlugin.PngInfo()
        info.add_text("Software", "Midjourney")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", pnginfo=info)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ai.png"
            path.write_bytes(buffer.getvalue())
            result = sanitize_generated_image_file(path)
            cleaned = path.read_bytes()
        self.assertTrue(result["changed"])
        self.assertNotIn(b"Midjourney", cleaned)
        opened = Image.open(io.BytesIO(cleaned))
        self.assertEqual(opened.format, "PNG")
        self.assertEqual(opened.size, (10, 10))

    def test_gif_is_left_unchanged(self):
        image = Image.new("P", (4, 4), 1)
        buffer = io.BytesIO()
        image.save(buffer, format="GIF")
        raw = buffer.getvalue()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "loop.gif"
            path.write_bytes(raw)
            result = sanitize_generated_image_file(path)
            self.assertFalse(result["changed"])
            self.assertEqual(result["skipped"], "gif")
            self.assertEqual(path.read_bytes(), raw)

    def test_undecodable_bytes_do_not_fail_generation_dispatch(self):
        notes: list[str] = []

        def closed(**values):
            output = Path(values["output_path"])
            output.write_bytes(b"not-an-image")
            return {"ok": True, "image_path": str(output), "selected_model": "test-model"}

        context = VideoTaskContext(task_id="t", task_type="image_generate", progress_callback=lambda body: notes.append(str(body.get("status") or "")))
        with tempfile.TemporaryDirectory() as tmp:
            result = dispatch_image_generate(
                task_id="t",
                payload={"image_generate_provider": "closed_model_api"},
                mode="product_only",
                prompt="studio",
                input_image_paths=[],
                output_dir=tmp,
                count=1,
                closed_model_callback=closed,
                context=context,
            )
            output = Path(result["image_path"])
            self.assertEqual(output.read_bytes(), b"not-an-image")
        self.assertTrue(any("清洗" in item for item in notes))
