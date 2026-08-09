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
            mock.patch.object(runner, "_click_threads_instagram_login_entry") as handoff,
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
        handoff.assert_not_called()

    def test_missing_form_preserves_text_entry_then_uses_structural_branch_and_existing_flow(self):
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
            if stage == "threads_login_username_instead":
                return False
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
            mock.patch.object(runner, "_click_threads_instagram_login_entry") as handoff,
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
        self.assertEqual(
            [call.args[3] for call in click.call_args_list],
            ["threads_login_username_instead", "auto_login_submit"],
        )
        structure.assert_called_once()
        self.assertEqual(
            [call.args[2] for call in type_text.call_args_list],
            ["navon3562", "saved-password"],
        )
        handoff.assert_not_called()
        self.assertNotIn("_threads_official_handoff_attempted", payload)

    def test_structure_entry_reuses_instagram_anchor_and_safe_clicker(self):
        page = mock.Mock()
        page.url = "https://www.threads.com/"
        anchor = mock.Mock()
        anchor.evaluate.return_value = True
        target = mock.Mock()
        page.locator.return_value.first = target

        with (
            mock.patch.object(
                runner,
                "_find_threads_instagram_entry_by_structure",
                return_value=anchor,
            ) as find_anchor,
            mock.patch.object(runner, "_human_click", return_value=True) as human_click,
        ):
            clicked = runner._click_threads_username_entry_by_structure(page, _Logger())

        self.assertTrue(clicked)
        find_anchor.assert_called_once_with(page, abort_if=None)
        anchor.evaluate.assert_called_once()
        page.locator.assert_called_once_with('[data-vecto-threads-username-entry="1"]')
        human_click.assert_called_once_with(
            page,
            target,
            mock.ANY,
            "threads_login_username_structure",
            abort_if=None,
        )


if __name__ == "__main__":
    unittest.main()
