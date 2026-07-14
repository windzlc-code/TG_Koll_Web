import unittest
from pathlib import Path


class OnlineApplicationFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        static_dir = Path(__file__).resolve().parents[1] / "static"
        cls.pricing_script = (static_dir / "assets" / "opc" / "pricing.js").read_text(encoding="utf-8")
        cls.console_script = (static_dir / "assets" / "console.js").read_text(encoding="utf-8")

    def test_pending_application_is_not_described_as_payment_review(self):
        self.assertIn('pending: "待审批"', self.console_script)
        self.assertNotIn('pending: "待付款审核"', self.console_script)

    def test_submit_retry_does_not_generate_a_new_key_inside_submit_handler(self):
        marker = 'addEventListener("submit"'
        submit_handler = self.pricing_script[self.pricing_script.index(marker):]
        self.assertNotIn("const idempotencyKey =", submit_handler)
        self.assertNotIn("randomUUID", submit_handler)

    def test_partial_account_failures_are_not_coerced_to_known_empty_values(self):
        self.assertNotIn(
            'state.summary = summaryResult.status === "fulfilled" ? summaryResult.value : null;',
            self.pricing_script,
        )
        self.assertNotIn(
            'state.orders = ordersResult.status === "fulfilled" ? list(ordersResult.value?.items) : [];',
            self.pricing_script,
        )


if __name__ == "__main__":
    unittest.main()
