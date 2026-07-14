import unittest
from unittest import mock

import webapp.server as server


class BillingTaskRegressionTests(unittest.TestCase):
    def test_single_image_url_counts_as_one_billable_output(self):
        self.assertEqual(
            server._billing_actual_image_quantity({"image_url": "/uploads/generated.png"}),
            1,
        )
        self.assertEqual(
            server._billing_actual_image_quantity({"image_urls": ["a.png", "b.png"]}),
            2,
        )

    def test_persona_image_task_exposes_generated_image_count(self):
        result = {
            "generation": {"image_url": "/uploads/persona.png"},
            "saved_item_id": "saved-1",
        }
        with mock.patch.object(server, "_run_persona_image_cli_for_web", return_value=result):
            output = server._run_persona_image_task(
                "task-1",
                {"related_persona_id": "persona-1"},
            )

        self.assertEqual(output["image_url"], "/uploads/persona.png")
        self.assertEqual(output["image_count"], 1)


if __name__ == "__main__":
    unittest.main()
