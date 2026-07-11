import tempfile
import unittest
from io import BytesIO
from pathlib import Path

from PIL import Image

from webapp.social_automation_api import _screenshot_thumbnail_bytes


class SocialScreenshotThumbnailTests(unittest.TestCase):
    def test_thumbnail_is_small_jpeg_with_preserved_aspect_ratio(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            source_path = Path(tmpdir) / "screenshot.png"
            Image.new("RGB", (1600, 810), "white").save(source_path, format="PNG")

            content = _screenshot_thumbnail_bytes(source_path)

            with Image.open(BytesIO(content)) as thumbnail:
                self.assertEqual(thumbnail.format, "JPEG")
                self.assertLessEqual(thumbnail.width, 480)
                self.assertLessEqual(thumbnail.height, 270)
                self.assertAlmostEqual(thumbnail.width / thumbnail.height, 1600 / 810, places=1)
            self.assertLess(len(content), source_path.stat().st_size)


if __name__ == "__main__":
    unittest.main()
