from __future__ import annotations

import unittest

from webapp.deployment import (
    APPLICATION_ROLE,
    COLLECTOR_ROLE,
    deployment_boundary,
    deployment_role,
)


class DeploymentBoundaryTests(unittest.TestCase):
    def test_application_is_the_default_and_does_not_block_product_routes(self) -> None:
        self.assertEqual(deployment_role(""), APPLICATION_ROLE)
        boundary = deployment_boundary("application")
        self.assertFalse(boundary.collector)
        self.assertFalse(boundary.blocks("/pricing.html"))
        self.assertFalse(boundary.blocks("/api/auth/register"))

    def test_collector_hides_marketing_registration_and_billing(self) -> None:
        boundary = deployment_boundary("collector")
        self.assertEqual(boundary.role, COLLECTOR_ROLE)
        for path in (
            "/about-vecto.html",
            "/pricing.html",
            "/register.html",
            "/subscription.html",
            "/api/auth/apply",
            "/api/auth/register",
            "/api/auth/google/start",
            "/api/billing/orders",
        ):
            with self.subTest(path=path):
                self.assertTrue(boundary.blocks(path))

    def test_collector_keeps_crm_hotspot_account_and_core_admin_surfaces(self) -> None:
        boundary = deployment_boundary("collector")
        for path in (
            "/crm.html",
            "/api/crm/v1/bootstrap",
            "/api/crm/v1/threads/search",
            "/api/persona_dashboard/automation/accounts",
            "/api/persona_dashboard/automation/tasks",
            "/api/admin/sentiment/browser_auth/profiles",
            "/api/admin/modules/crm/health",
            "/admin-console.html",
            "/collector-admin.html",
        ):
            with self.subTest(path=path):
                self.assertFalse(boundary.blocks(path))

    def test_unknown_role_fails_closed(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "unsupported TG_DEPLOYMENT_ROLE"):
            deployment_role("mixed")


if __name__ == "__main__":
    unittest.main()
