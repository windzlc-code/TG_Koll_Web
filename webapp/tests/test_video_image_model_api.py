from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_core.source import image_model_api


class _Response:
    text = ""

    def __init__(self, body):
        self.body = body

    def raise_for_status(self):
        return None

    def json(self):
        return self.body


class VideoImageModelApiTests(unittest.TestCase):
    def test_gemini_base_url_with_v1_suffix_does_not_duplicate_version(self):
        encoded = base64.b64encode(b"image").decode("ascii")
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "result.png"
            with patch.object(
                image_model_api.requests,
                "post",
                return_value=_Response({"candidates": [{"content": {"parts": [{"inlineData": {"data": encoded}}]}}]}),
            ) as post:
                result = image_model_api.generate_image(
                    base_url="https://provider.example/v1",
                    model="gemini-3.1-flash-image-preview",
                    prompt="test",
                    output_image_path=str(output),
                    gemini_api_key="key",
                )
        self.assertEqual(post.call_args.args[0], "https://provider.example/v1beta/models/gemini-3.1-flash-image-preview:generateContent")
        self.assertEqual(Path(result["image_path"]).name, "result.png")

    def test_gpt_base_url_with_v1_suffix_does_not_duplicate_version(self):
        encoded = base64.b64encode(b"image").decode("ascii")
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "result.png"
            with patch.object(
                image_model_api.requests,
                "post",
                return_value=_Response({"data": [{"b64_json": encoded}]}),
            ) as post:
                image_model_api.generate_image(
                    base_url="https://provider.example/v1",
                    model="gpt-image-1",
                    prompt="test",
                    output_image_path=str(output),
                    gpt_api_key="key",
                )
        self.assertEqual(post.call_args.args[0], "https://provider.example/v1/images/generations")


if __name__ == "__main__":
    unittest.main()
