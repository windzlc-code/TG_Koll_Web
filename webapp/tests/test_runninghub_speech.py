from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_core.source import runninghub_common, runninghub_speech


class RunningHubSpeechTests(unittest.TestCase):
    def test_normalize_rejects_official_only_and_music_models(self):
        self.assertEqual(runninghub_speech.normalize_speech_model("speech-2.8-turbo"), "speech-2.8-turbo")
        self.assertEqual(runninghub_speech.normalize_speech_model("speech-01-hd"), "speech-2.8-hd")
        self.assertEqual(runninghub_speech.normalize_speech_model("music-2.5"), "speech-2.8-hd")
        self.assertEqual(runninghub_speech.normalize_speech_voice("male-qn-qingse"), "male-qn-qingse")
        self.assertEqual(runninghub_speech.normalize_speech_voice(""), "male-qn-qingse")
        self.assertEqual(runninghub_speech.normalize_speech_voice("Wise_Woman"), "male-qn-qingse")
        self.assertEqual(runninghub_speech.normalize_speech_voice("Elegant_Man"), "Elegant_Man")
        self.assertEqual(
            runninghub_speech.speech_base_url("https://api.minimaxi.com"),
            "https://www.runninghub.ai",
        )

    def test_query_task_downloads_mp3_results(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "speech.mp3"
            response = type("Resp", (), {"json": lambda self: {
                "taskId": "task_mp3_1",
                "status": "SUCCESS",
                "results": [
                    {
                        "url": "https://example.com/out.mp3",
                        "outputType": "mp3",
                    }
                ],
            }})()
            with patch.object(runninghub_common, "rh_post", return_value=response), patch.object(
                runninghub_common,
                "download_file",
                side_effect=lambda file_url, output_path: Path(output_path).write_bytes(b"mp3"),
            ):
                result = runninghub_common.query_task(
                    task_id="task_mp3_1",
                    api_key="rh-key",
                    video_output_path=str(output_path),
                )
        self.assertEqual(result["status"], "success")
        self.assertIn("Audio Download successfully!", result["message"])

    def test_generate_text_to_audio_posts_speech_endpoint_and_polls(self):
        captured = {}

        class FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {"taskId": "speech-1", "status": "RUNNING"}

        def fake_post(url, **kwargs):
            captured["url"] = url
            captured["data"] = kwargs.get("data")
            return FakeResponse()

        def fake_query(**kwargs):
            Path(kwargs["video_output_path"]).write_bytes(b"audio")
            captured["query"] = kwargs
            return {"status": "success"}

        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "out.mp3"
            with patch.object(runninghub_common, "rh_post", side_effect=fake_post), patch.object(
                runninghub_common,
                "query_task",
                side_effect=fake_query,
            ):
                result = runninghub_speech.generate_text_to_audio(
                    api_key="rh-key",
                    base_url="https://www.runninghub.ai",
                    model="speech-02-hd",
                    text="你好",
                    output_path=output,
                    voice_id="male-qn-qingse",
                )
            self.assertEqual(result.read_bytes(), b"audio")
        self.assertEqual(
            captured["url"],
            "https://www.runninghub.ai/openapi/v2/rhart-audio/text-to-audio/speech-02-hd",
        )
        body = json.loads(captured["data"])
        self.assertEqual(body["text"], "你好")
        self.assertEqual(body["voice_id"], "male-qn-qingse")
        self.assertEqual(captured["query"]["task_id"], "speech-1")


if __name__ == "__main__":
    unittest.main()
