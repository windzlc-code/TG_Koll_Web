import unittest
from pathlib import Path
from unittest import mock

from social_automation import runner


class _Logger:
    def log(self, *_args, **_kwargs):
        return None


class ThreadsUsernameLoginEntryTests(unittest.TestCase):
    def test_existing_native_form_keeps_the_original_fill_and_submit_path(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/login"
        username_input = mock.Mock()
        password_input = mock.Mock()

        def visible_first(_page, selectors, _timeout_ms=1200):
            return password_input if any("password" in item for item in selectors) else username_input

        with (
            mock.patch.object(runner, "_visible_first", side_effect=visible_first),
            mock.patch.object(runner, "_clear_and_type") as type_text,
            mock.patch.object(runner, "_click_text_button", return_value=True) as click,
            mock.patch.object(runner, "_click_login_submit_by_structure", return_value=False),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner.time, "sleep"),
            mock.patch.object(runner, "_screenshot", return_value="native-form.png"),
        ):
            submitted = runner._auto_submit_login_form(
                page,
                "threads",
                {"login_username": "navon3562", "login_password": "saved-password"},
                _Logger(),
                {"id": "native-form"},
                Path("."),
            )

        self.assertTrue(submitted)
        self.assertEqual(
            [call.args[2] for call in type_text.call_args_list],
            ["navon3562", "saved-password"],
        )
        self.assertEqual([call.args[3] for call in click.call_args_list], ["auto_login_submit"])

    def test_missing_form_uses_structural_entry_before_text_and_keeps_existing_flow(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        username_input = mock.Mock()
        password_input = mock.Mock()
        state = {"form_ready": False}

        def visible_first(_page, selectors, _timeout_ms=1200):
            if not state["form_ready"]:
                return None
            return password_input if any("password" in item for item in selectors) else username_input

        def click_text(_page, _logger, names, stage, **_kwargs):
            if stage == "auto_login_submit":
                return True
            return False

        def click_structure(_page, _logger, **_kwargs):
            state["form_ready"] = True
            return True

        payload = {"login_username": "navon3562", "login_password": "saved-password"}
        with (
            mock.patch.object(runner, "_visible_first", side_effect=visible_first),
            mock.patch.object(runner, "_clear_and_type") as type_text,
            mock.patch.object(runner, "_click_text_button", side_effect=click_text) as click,
            mock.patch.object(
                runner,
                "_click_threads_username_entry_by_structure",
                side_effect=click_structure,
            ) as structure,
            mock.patch.object(runner, "_click_login_submit_by_structure", return_value=False),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner.time, "sleep"),
            mock.patch.object(runner, "_screenshot", return_value="username-entry.png"),
        ):
            submitted = runner._auto_submit_login_form(
                page,
                "threads",
                payload,
                _Logger(),
                {"id": "localized-username-entry"},
                Path("."),
            )

        self.assertTrue(submitted)
        structure.assert_called()
        self.assertEqual(structure.call_count, 1)
        self.assertEqual(
            [call.args[3] for call in click.call_args_list],
            ["auto_login_submit"],
        )
        self.assertEqual(
            [call.args[2] for call in type_text.call_args_list],
            ["navon3562", "saved-password"],
        )
        self.assertNotIn("_threads_official_handoff_attempted", payload)

    def test_structure_entry_reuses_instagram_anchor_and_safe_clicker(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        anchor = mock.Mock()
        anchor.evaluate.return_value = True
        target = mock.Mock()
        missing_link = mock.Mock()
        missing_link.count.return_value = 0

        def locate(selector):
            result = mock.Mock()
            result.first = (
                missing_link
                if selector == 'a[href^="/login"][href*="show_choice_screen=false"]'
                else target
            )
            return result

        page.locator.side_effect = locate

        with (
            mock.patch.object(
                runner,
                "_find_threads_login_card_anchor",
                return_value=anchor,
            ) as find_anchor,
            mock.patch.object(runner, "_human_click", return_value=True) as human_click,
        ):
            clicked = runner._click_threads_username_entry_by_structure(page, _Logger())

        self.assertTrue(clicked)
        find_anchor.assert_called_once_with(page, abort_if=None)
        anchor.evaluate.assert_called_once()
        page.locator.assert_any_call('[data-vecto-threads-username-entry="1"]')
        human_click.assert_called_once_with(
            page,
            target,
            mock.ANY,
            "threads_login_username_structure",
            abort_if=None,
        )

    def test_structure_entry_uses_official_login_href_without_instagram_anchor(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        login_link = mock.Mock()
        login_link.count.return_value = 1
        login_link.is_visible.return_value = True
        login_link.get_attribute.return_value = "/login?show_choice_screen=false"
        page.locator.return_value.first = login_link

        with (
            mock.patch.object(
                runner,
                "_find_threads_login_card_anchor",
                return_value=None,
            ),
            mock.patch.object(runner, "_goto") as goto,
        ):
            opened = runner._click_threads_username_entry_by_structure(page, _Logger())

        self.assertTrue(opened)
        page.locator.assert_called_once_with(
            'a[href^="/login"][href*="show_choice_screen=false"]'
        )
        goto.assert_called_once_with(
            page,
            "https://www.threads.com/login?show_choice_screen=false",
            mock.ANY,
            "threads_login_username_structure",
            timeout_ms=15000,
        )

    def test_home_without_form_clicks_login_on_home_instead_of_opening_login_url(self):
        page = mock.Mock()
        page.url = "https://www.threads.net/"
        username_input = mock.Mock()
        password_input = mock.Mock()
        state = {"form_ready": False}

        def visible_first(_page, selectors, _timeout_ms=1200):
            if not state["form_ready"]:
                return None
            return password_input if any("password" in item for item in selectors) else username_input

        def click_structure(_page, _logger, **_kwargs):
            state["form_ready"] = True
            return True

        with (
            mock.patch.object(runner, "_visible_first", side_effect=visible_first),
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_clear_and_type") as type_text,
            mock.patch.object(runner, "_click_text_button", return_value=True),
            mock.patch.object(runner, "_click_login_submit_by_structure", return_value=False),
            mock.patch.object(
                runner,
                "_click_threads_username_entry_by_structure",
                side_effect=click_structure,
            ) as structure,
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner.time, "sleep"),
            mock.patch.object(runner, "_screenshot", return_value="home-click-login.png"),
        ):
            submitted = runner._auto_submit_login_form(
                page,
                "threads",
                {"login_username": "sherryjim68", "login_password": "saved-password"},
                _Logger(),
                {"id": "home-click-login"},
                Path("."),
            )

        self.assertTrue(submitted)
        goto.assert_not_called()
        structure.assert_called()
        self.assertEqual(
            [call.args[2] for call in type_text.call_args_list],
            ["sherryjim68", "saved-password"],
        )

    def test_threads_login_state_uses_login_card_structure_without_english_copy(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        page.locator.return_value.first.is_visible.return_value = False
        page.locator.return_value.first.count.return_value = 0
        page.locator.return_value.inner_text.return_value = "Instagramで続ける"
        page.context.cookies.return_value = []

        with (
            mock.patch.object(runner, "_browser_navigation_error_visible", return_value=False),
            mock.patch.object(runner, "_find_threads_login_card_anchor", return_value=mock.Mock()),
        ):
            status = runner._detect_threads_login_state(page)

        self.assertEqual(status["status"], "cookie_expired")
        self.assertEqual(status["evidence"], "visual_structure")


if __name__ == "__main__":
    unittest.main()
