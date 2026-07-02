import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch, Mock

import get_nano_banana
import image_model_api
import requests


class NanoBananaParseTests(unittest.TestCase):
    def test_extract_image_url_from_markdown_image(self):
        text = "![Image](https://example.com/result.jpeg)"
        self.assertEqual(
            get_nano_banana._extract_image_url_from_text(text),
            "https://example.com/result.jpeg",
        )

    def test_extract_image_url_from_markdown_link(self):
        text = "[download](https://example.com/result.webp)"
        self.assertEqual(
            get_nano_banana._extract_image_url_from_text(text),
            "https://example.com/result.webp",
        )

    def test_extract_image_url_from_plain_text_with_suffix(self):
        text = "结果如下 https://example.com/result.png)"
        self.assertEqual(
            get_nano_banana._extract_image_url_from_text(text),
            "https://example.com/result.png",
        )

    def test_extract_candidate_image_payload_from_text_part(self):
        payload = get_nano_banana._extract_candidate_image_payload(
            candidate={
                "content": {
                    "role": "model",
                    "parts": [
                        {
                            "text": "![Image](https://example.com/result.jpeg)",
                        }
                    ],
                }
            },
            timeout_seconds=1,
        )
        self.assertEqual(
            payload,
            {"kind": "url", "value": "https://example.com/result.jpeg"},
        )

    def test_extract_candidate_image_payload_keeps_base64_support(self):
        payload = get_nano_banana._extract_candidate_image_payload(
            candidate={
                "content": {
                    "parts": [
                        {
                            "inline_data": {
                                "data": "aGVsbG8=",
                            }
                        }
                    ]
                }
            },
            timeout_seconds=1,
        )
        self.assertEqual(payload, {"kind": "base64", "value": "aGVsbG8="})

    def test_extract_candidate_image_payload_ignores_non_image_url(self):
        payload = get_nano_banana._extract_candidate_image_payload(
            candidate={
                "content": {
                    "parts": [
                        {
                            "text": "详情见 https://example.com/result.txt",
                        }
                    ]
                }
            },
            timeout_seconds=1,
        )
        self.assertIsNone(payload)

    @patch("get_nano_banana.requests.post")
    def test_logs_http_failure_details(self, mock_post):
        response = Mock()
        response.status_code = 401
        response.text = '{"error":"unauthorized"}'
        response.headers = {}
        http_error = requests.HTTPError("401 Client Error", response=response)
        response.raise_for_status.side_effect = http_error
        mock_post.return_value = response

        logs: list[str] = []
        with TemporaryDirectory() as tmpdir:
            image_path = Path(tmpdir) / "input.png"
            image_path.write_bytes(b"fake")
            with self.assertRaises(RuntimeError):
                get_nano_banana.get_nano_banana_pro(
                    prompt="hello",
                    output_image_path=str(Path(tmpdir) / "out.png"),
                    api_key="sk-test",
                    input_image_path=str(image_path),
        host="202.90.21.53",
                    retry_count=0,
                    logger=logs.append,
                )

        self.assertTrue(logs)
        self.assertIn("Nano Banana 请求失败", logs[0])
        self.assertIn("response_preview", logs[0])


class ImageModelApiTests(unittest.TestCase):
    def test_resolve_api_key_uses_gpt_key_for_gpt_model(self):
        self.assertEqual(
            image_model_api._resolve_api_key(
                model="gpt-image-2",
                gemini_api_key="sk-gemini",
                gpt_api_key="sk-gpt",
            ),
            "sk-gpt",
        )

    def test_resolve_api_key_uses_gemini_key_for_gemini_model(self):
        self.assertEqual(
            image_model_api._resolve_api_key(
                model="gemini-3-pro-image-preview",
                gemini_api_key="sk-gemini",
                gpt_api_key="sk-gpt",
            ),
            "sk-gemini",
        )


if __name__ == "__main__":
    unittest.main()
