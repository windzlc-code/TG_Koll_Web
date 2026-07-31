import unittest

from social_automation import runner


class WarmupTimeBudgetTests(unittest.TestCase):
    def test_model_timeout_allows_the_live_gateway_to_finish(self):
        self.assertEqual(runner._warmup_model_timeout_seconds({}), 30)

    def test_setup_time_is_deducted_from_the_declared_session_budget(self):
        task = {"started_at": 1_000}

        remaining = runner._remaining_warmup_session_seconds(
            task,
            480,
            now_epoch=1_075,
        )

        self.assertEqual(remaining, 405)

    def test_missing_task_start_keeps_the_full_session_budget(self):
        remaining = runner._remaining_warmup_session_seconds(
            {},
            480,
            now_epoch=1_075,
        )

        self.assertEqual(remaining, 480)

    def test_expired_task_budget_does_not_become_negative(self):
        remaining = runner._remaining_warmup_session_seconds(
            {"started_at": 1_000},
            480,
            now_epoch=1_600,
        )

        self.assertEqual(remaining, 0)


if __name__ == "__main__":
    unittest.main()
