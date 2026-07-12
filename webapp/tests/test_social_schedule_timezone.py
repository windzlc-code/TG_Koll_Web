import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from webapp.social_automation_api import _parse_schedule


class SocialScheduleTimezoneTests(unittest.TestCase):
    def test_naive_schedule_uses_configured_webapp_timezone(self):
        with mock.patch.dict(os.environ, {"WEBAPP_TIMEZONE": "Asia/Shanghai"}):
            actual = _parse_schedule("2026-07-13 04:05")

        expected = int(datetime(2026, 7, 13, 4, 5, tzinfo=timezone(timedelta(hours=8))).timestamp())
        self.assertEqual(actual, expected)

    def test_offset_schedule_is_independent_of_server_timezone(self):
        with mock.patch.dict(os.environ, {"WEBAPP_TIMEZONE": "UTC"}):
            actual = _parse_schedule("2026-07-13T04:05:00+08:00")

        expected = int(datetime(2026, 7, 12, 20, 5, tzinfo=timezone.utc).timestamp())
        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
