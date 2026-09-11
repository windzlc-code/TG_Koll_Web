import json
import unittest
from unittest import mock

import requests

from webapp.persona_copy import (
    PublicPersonaProfileError,
    build_persona_copy_prompt,
    fetch_public_persona_profile,
)


class _FakeResponse:
    status_code = 200
    headers = {"Content-Type": "text/html; charset=utf-8"}
    encoding = "utf-8"

    def __init__(self, body: str):
        self._body = body.encode("utf-8")
        self.closed = False

    def iter_content(self, _chunk_size):
        yield self._body

    def close(self):
        self.closed = True


class _StreamingFailureResponse(_FakeResponse):
    def iter_content(self, _chunk_size):
        raise requests.exceptions.ReadTimeout("stream read timed out")


class PersonaCopyExtractionTests(unittest.TestCase):
    def test_fetches_public_html_without_credentials_and_extracts_profile_posts(self):
        html = """
        <html><head><title>Alice | Threads</title></head><body>
          <script type="application/ld+json">
            {"username":"alice","full_name":"Alice","biography":"城市观察与咖啡。",
             "followers":{"count":1234},"posts":[
               {"text":"今天在街角发现一家很好的咖啡店。","url":"https://www.threads.com/@alice/post/1"}
             ]}
          </script>
        </body></html>
        """
        with mock.patch("webapp.persona_copy.requests.get", return_value=_FakeResponse(html)) as get_mock:
            result = fetch_public_persona_profile("https://www.threads.com/@alice/")

        self.assertEqual(result["platform"], "threads")
        self.assertEqual(result["username"], "alice")
        self.assertEqual(result["bio"], "城市观察与咖啡。")
        self.assertEqual(result["followers"], 1234)
        self.assertEqual(result["posts"][0]["content"], "今天在街角发现一家很好的咖啡店。")
        self.assertEqual(result["sample_count"], 1)
        self.assertEqual(result["sample_limit"], 12)
        request_kwargs = get_mock.call_args.kwargs
        self.assertNotIn("cookies", request_kwargs)
        self.assertNotIn("Cookie", request_kwargs.get("headers", {}))

    def test_rejects_non_social_hosts_before_http_request(self):
        with mock.patch("webapp.persona_copy.requests.get") as get_mock:
            with self.assertRaises(PublicPersonaProfileError):
                fetch_public_persona_profile("https://example.com/@alice")
        get_mock.assert_not_called()

    def test_normalizes_streaming_request_exception_to_bad_gateway(self):
        response = _StreamingFailureResponse("")
        with mock.patch("webapp.persona_copy.requests.get", return_value=response):
            with self.assertRaises(PublicPersonaProfileError) as raised:
                fetch_public_persona_profile("https://www.threads.com/@alice")

        self.assertEqual(raised.exception.status_code, 502)
        self.assertTrue(response.closed)

    def test_extracts_json_from_script_without_type_or_id(self):
        html = """
        <html><body>
          <script>{"username":"plain-json","biography":"无属性脚本","followers":42}</script>
        </body></html>
        """
        with mock.patch("webapp.persona_copy.requests.get", return_value=_FakeResponse(html)):
            result = fetch_public_persona_profile("https://www.threads.com/@plain-json")

        self.assertEqual(result["username"], "plain-json")
        self.assertEqual(result["bio"], "无属性脚本")
        self.assertEqual(result["followers"], 42)

    def test_extracts_nested_json_from_rsc_script(self):
        rsc_payload = json.dumps(
            [1, json.dumps({"username": "rsc-user", "biography": "RSC 简介", "followers": {"count": 88}})],
            ensure_ascii=False,
        )
        html = f"<script>self.__next_f.push({rsc_payload})</script>"
        with mock.patch("webapp.persona_copy.requests.get", return_value=_FakeResponse(html)):
            result = fetch_public_persona_profile("https://www.threads.com/@rsc-user")

        self.assertEqual(result["username"], "rsc-user")
        self.assertEqual(result["bio"], "RSC 简介")
        self.assertEqual(result["followers"], 88)

    def test_orders_post_samples_newest_first_when_public_page_is_oldest_first(self):
        html = """
        <html><body><script>
          {"username":"alice","posts":[
            {"text":"最早的公开内容","shortcode":"old","taken_at_timestamp":1700000000},
            {"text":"最新的公开内容","shortcode":"new","taken_at_timestamp":1700200000},
            {"text":"没有时间的公开内容","shortcode":"unknown"}
          ]}
        </script></body></html>
        """
        with mock.patch("webapp.persona_copy.requests.get", return_value=_FakeResponse(html)):
            result = fetch_public_persona_profile("https://www.threads.com/@alice")

        self.assertEqual(
            [post["content"] for post in result["posts"]],
            ["最新的公开内容", "最早的公开内容", "没有时间的公开内容"],
        )

    def test_prompt_contains_public_source_and_post_samples(self):
        prompt = build_persona_copy_prompt({
            "platform": "threads",
            "url": "https://www.threads.com/@alice",
            "username": "alice",
            "display_name": "Alice",
            "bio": "城市观察。",
            "posts": [{"content": "一条公开内容"}],
        }, "新的人设")
        self.assertIn("公开简介：城市观察。", prompt)
        self.assertIn("一条公开内容", prompt)
        self.assertIn("不要声称这是原用户本人", prompt)
        self.assertIn("实际只提供 1 条文字样本", prompt)
