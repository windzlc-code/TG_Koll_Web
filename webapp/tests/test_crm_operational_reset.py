import unittest

from webapp.crm.operational_reset import (
    OPERATIONAL_RESET_CONFIRMATION,
    apply_operational_reset,
    create_operational_reset_plan,
)


class CRMOperationalResetPolicyTests(unittest.TestCase):
    def setUp(self):
        self.state = {
            "version": 1,
            "tasks": [
                {"id": "running", "status": "running"},
                {"id": "done", "status": "completed"},
            ],
            "pools": [{"id": "pool"}],
            "events": [{"id": "event"}],
            "hotspots": [{"id": "hotspot"}],
            "relationships": [{"id": "relationship"}],
            "templates": [{"id": "template"}],
            "settings": {"senders": [{"username": "sender"}], "daily_limit": 10},
            "configuration": {"provider": "configured"},
            "updatedAt": "2026-08-01T00:00:00Z",
        }

    def test_reset_requires_both_boolean_and_exact_confirmation(self):
        for confirmed, confirmation in (
            (False, OPERATIONAL_RESET_CONFIRMATION),
            (True, "wrong"),
            (False, "wrong"),
        ):
            plan = create_operational_reset_plan(
                self.state,
                confirmed=confirmed,
                confirmation=confirmation,
            )
            self.assertFalse(plan["allowed"])
            self.assertEqual(plan["reason"], "confirmation_required")

    def test_plan_reports_exact_clear_and_preserve_boundaries(self):
        plan = create_operational_reset_plan(
            self.state,
            confirmed=True,
            confirmation=OPERATIONAL_RESET_CONFIRMATION,
        )
        self.assertTrue(plan["allowed"])
        self.assertEqual(plan["cleared"]["tasks"], 2)
        self.assertEqual(plan["cleared"]["pools"], 1)
        self.assertEqual(plan["preserved"], {"templates": 1, "sender_settings": 1})
        self.assertEqual(plan["active_task_ids_to_stop"], ["running"])

    def test_apply_clears_only_operational_data_and_does_not_mutate_input(self):
        result = apply_operational_reset(
            self.state,
            confirmed=True,
            confirmation=OPERATIONAL_RESET_CONFIRMATION,
            reset_at="2026-08-16T03:16:16Z",
        )
        self.assertTrue(result["ok"])
        clean = result["state"]
        for key in ("tasks", "pools", "events", "hotspots", "relationships"):
            self.assertEqual(clean[key], [])
        self.assertEqual(clean["templates"], self.state["templates"])
        self.assertEqual(clean["settings"], self.state["settings"])
        self.assertEqual(clean["configuration"], self.state["configuration"])
        self.assertEqual(clean["updatedAt"], "2026-08-16T03:16:16Z")
        self.assertEqual(len(self.state["tasks"]), 2)
        self.assertEqual(len(self.state["pools"]), 1)

    def test_refused_reset_returns_unchanged_deep_copy(self):
        result = apply_operational_reset(
            self.state,
            confirmed=True,
            confirmation="wrong",
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["state"], self.state)
        self.assertIsNot(result["state"], self.state)
        result["state"]["settings"]["daily_limit"] = 99
        self.assertEqual(self.state["settings"]["daily_limit"], 10)


if __name__ == "__main__":
    unittest.main()
