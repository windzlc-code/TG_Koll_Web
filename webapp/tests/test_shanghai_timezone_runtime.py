import calendar
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from webapp import server
from webapp import social_automation_api


ROOT = Path(__file__).resolve().parents[2]
SHANGHAI = timezone(timedelta(hours=8), name="Asia/Shanghai")


class ShanghaiTimezoneRuntimeTests(unittest.TestCase):
    def test_cleanup_clock_is_independent_of_process_local_timezone(self):
        now = datetime(2026, 8, 1, 3, 29, tzinfo=SHANGHAI).timestamp()
        with (
            mock.patch.object(server.time, "time", return_value=now),
            mock.patch.object(server.time, "localtime", side_effect=time.gmtime),
            mock.patch.object(server.time, "mktime", side_effect=calendar.timegm),
        ):
            self.assertEqual(server._seconds_until_next_local_time(3, 30), 60.0)

    def test_server_date_key_uses_shanghai_day(self):
        timestamp = datetime(2026, 7, 31, 16, 30, tzinfo=timezone.utc).timestamp()
        with mock.patch.object(server.time, "localtime", side_effect=time.gmtime):
            self.assertEqual(server._date_key(timestamp), "2026-08-01")
        self.assertEqual(server._date_key("2026-07-31T16:30:00Z"), "2026-08-01")

    def test_naive_iso_values_use_shanghai_but_z_values_stay_utc(self):
        naive_expected = int(datetime(2026, 8, 1, 0, 30, tzinfo=SHANGHAI).timestamp())
        utc_expected = int(datetime(2026, 8, 1, 0, 30, tzinfo=timezone.utc).timestamp())

        self.assertEqual(server._parse_business_iso_timestamp("2026-08-01T00:30:00"), naive_expected)
        self.assertEqual(server._parse_business_iso_timestamp("2026-08-01T00:30:00Z"), utc_expected)
        self.assertEqual(
            social_automation_api._parse_business_iso_timestamp("2026-08-01T00:30:00"),
            naive_expected,
        )
        self.assertEqual(
            social_automation_api._parse_business_iso_timestamp("2026-08-01T00:30:00Z"),
            utc_expected,
        )
        with mock.patch.dict("os.environ", {"WEBAPP_TIMEZONE": "UTC"}):
            self.assertEqual(
                social_automation_api._parse_schedule("2026-08-01T00:30:00"),
                naive_expected,
            )

    def test_archive_and_retention_parsers_use_shanghai_for_naive_iso(self):
        expected = int(datetime(2026, 8, 1, 0, 30, tzinfo=SHANGHAI).timestamp())
        self.assertEqual(
            int(server._persona_post_retention_timestamp({"createdAt": "2026-08-01T00:30:00"}, history=False)),
            expected,
        )
        self.assertEqual(
            social_automation_api._parse_archive_time("2026-08-01T00:30:00"),
            expected,
        )

    def test_z_authorization_timestamp_is_not_parsed_as_local_time(self):
        now = datetime(2026, 8, 2, 0, 0, tzinfo=timezone.utc).timestamp()
        with (
            mock.patch.object(server.time, "time", return_value=now),
            mock.patch.object(server.time, "mktime", side_effect=AssertionError("must not parse Z as local time")),
        ):
            state = server._sentiment_auth_state([], "2026-08-01T00:00:00Z", "threads")
        self.assertEqual(state["lastAuthorizedAgeDays"], 1.0)

    def test_container_runtime_declares_shanghai_timezone(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        entrypoint = (ROOT / "docker" / "entrypoint.sh").read_text(encoding="utf-8")
        self.assertIn("TZ=Asia/Shanghai", dockerfile)
        self.assertIn('export TZ="Asia/Shanghai"', entrypoint)
        self.assertIn('export WEBAPP_TIMEZONE="Asia/Shanghai"', entrypoint)


if __name__ == "__main__":
    unittest.main()
