import unittest
from unittest.mock import patch

import get_gemini
from model_endpoint_utils import build_model_request_url


class ModelEndpointUtilsTests(unittest.TestCase):
    def test_builds_default_https_url_from_host_and_port(self):
        url = build_model_request_url(
            host="example.com",
            port="3008",
            path="/v1beta/models/gemini-3-pro-preview:generateContent",
        )
        self.assertEqual(url, "https://example.com:3008/v1beta/models/gemini-3-pro-preview:generateContent")

    def test_accepts_http_base_url(self):
        url = build_model_request_url(
            host="http://202.90.21.53:3008",
            path="/v1beta/models/gemini-3-pro-preview:generateContent",
        )
        self.assertEqual(url, "http://202.90.21.53:3008/v1beta/models/gemini-3-pro-preview:generateContent")

    def test_bare_ip_defaults_to_http(self):
        url = build_model_request_url(
            host="202.90.21.53",
            port="3008",
            path="/v1beta/models/gemini-3-pro-preview:generateContent",
        )
        self.assertEqual(url, "http://202.90.21.53:3008/v1beta/models/gemini-3-pro-preview:generateContent")

    def test_keeps_full_endpoint_url_unchanged(self):
        url = build_model_request_url(
            host=" `http://202.90.21.53:3008/v1beta/models/gemini-3.1-pro-preview:generateContent` ",
            path="/v1beta/models/gemini-3-pro-preview:generateContent",
        )
        self.assertEqual(url, "http://202.90.21.53:3008/v1beta/models/gemini-3.1-pro-preview:generateContent")

    def test_grok_models_use_openai_chat_completions_endpoint(self):
        class FakeResponse:
            text = ""

            def raise_for_status(self):
                return None

            def json(self):
                return {"choices": [{"message": {"content": "{\"ok\": true}"}}]}

        class FakeSession:
            def __init__(self):
                self.trust_env = True
                self.calls = []

            def post(self, *args, **kwargs):
                self.calls.append((args, kwargs))
                return FakeResponse()

        fake_session = FakeSession()
        with patch.object(get_gemini.requests, "Session", return_value=fake_session):
            result = get_gemini.request_gemini3_pro_json(
                user_input="ping",
                host="https://api.tu-zi.com/v1",
                api_key="sk-test",
                system_prompt="return json",
                model="grok-4",
            )

        self.assertEqual(result["ok"], True)
        args, kwargs = fake_session.calls[0]
        self.assertEqual(args[0], "https://api.tu-zi.com/v1/chat/completions")
        self.assertEqual(kwargs["json"]["model"], "grok-4")
        self.assertEqual(kwargs["json"]["messages"][0]["role"], "user")


if __name__ == "__main__":
    unittest.main()
