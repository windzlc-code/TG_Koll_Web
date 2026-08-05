import tempfile
import threading
import json
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, mock

from social_automation import runner


class _Page:
    url = "https://www.threads.net/"


class _Logger:
    def log(self, _level, _stage, _message, _data=None, _screenshot_path=""):
        return None


class WarmupChainParityTests(TestCase):
    def test_instagram_post_url_normalizes_equivalent_shortcode_routes(self):
        variants = (
            "https://www.instagram.com/p/DY8WwK_zBDF/",
            "https://www.instagram.com/reel/DY8WwK_zBDF/?utm_source=ig_web_copy_link",
            "https://www.instagram.com/wyy1993031/reel/DY8WwK_zBDF",
            "https://www.instagram.com/p/DY8WwK_zBDF/c/18119044984667239/",
        )

        canonical = {
            runner._canonical_warmup_post_url(value, "instagram")
            for value in variants
        }

        self.assertEqual(
            canonical,
            {"https://www.instagram.com/p/DY8WwK_zBDF"},
        )

    def test_instagram_post_target_uses_same_key_for_equivalent_routes(self):
        targets = [
            runner._warmup_post_target(
                {"text": "same post", "target_url": value},
                "instagram",
            )
            for value in (
                "https://www.instagram.com/wyy1993031/reel/DY8WwK_zBDF",
                "https://www.instagram.com/p/DY8WwK_zBDF/c/18119044984667239",
            )
        ]

        self.assertEqual(targets[0]["target_url"], targets[1]["target_url"])
        self.assertEqual(targets[0]["target_key"], targets[1]["target_key"])

    def test_threads_reply_targets_interactive_wrapper_before_inner_svg(self):
        scope = mock.Mock()
        wrapper = mock.Mock()
        wrapper.count.return_value = 1
        wrapper.is_visible.return_value = True
        scope.locator.return_value.first = wrapper

        selected = runner._threads_reply_button(mock.Mock(), root=scope)

        self.assertIs(selected, wrapper)
        self.assertEqual(
            scope.locator.call_args_list[0].args[0],
            '[role="button"]:has([aria-label="Reply"])',
        )

    def test_relevance_selection_skips_previously_seen_post_key(self):
        repeated = {
            "text": "理发师分享男士短发打理技巧。",
            "root": mock.Mock(),
            "target_key": "threads:post:repeated",
            "target_url": "https://www.threads.net/@barber/post/repeated",
        }
        fresh = {
            "text": "理发店今天做了一款新的短发造型。",
            "root": mock.Mock(),
            "target_key": "threads:post:fresh",
            "target_url": "https://www.threads.net/@barber/post/fresh",
        }
        with (
            mock.patch.object(
                runner,
                "_generate_warmup_search_keywords_with_ai",
                return_value=["男士短发"],
            ),
            mock.patch.object(
                runner,
                "_visible_warmup_post_contexts",
                return_value=[repeated, fresh],
            ),
            mock.patch.object(
                runner,
                "_assess_warmup_post_relevance",
                return_value={
                    "relevant": True,
                    "matched": ["理发"],
                    "score": 5,
                    "keywords": ["男士短发"],
                },
            ),
        ):
            selected = runner._ensure_warmup_relevant_surface(
                _Page(),
                {"require_persona_relevance": True},
                _Logger(),
                platform="threads",
                excluded_target_keys={"threads:post:repeated"},
            )

        self.assertEqual(selected["target_key"], "threads:post:fresh")

    def test_threads_comment_network_response_confirms_when_echo_is_delayed(self):
        request = SimpleNamespace(
            method="POST",
            url="https://www.threads.net/api/graphql",
            post_data=json.dumps(
                {"variables": {"text": "这个层次处理得很自然"}},
                ensure_ascii=True,
            ),
        )
        response = SimpleNamespace(status=200, url=request.url, request=request)

        self.assertTrue(
            runner._is_warmup_comment_submission_response(
                response,
                "threads",
                "这个层次处理得很自然",
            ),
        )

    def test_warmup_history_persists_only_confirmed_actions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            history_path = Path(temp_dir) / "history.json"
            runner._record_warmup_action_history(
                history_path,
                action="comment",
                target={
                    "target_key": "threads:post:1",
                    "target_url": "https://www.threads.net/@barber/post/1",
                },
                text="这个细节很实用",
                keyword="男士短发",
            )
            history = runner._load_warmup_action_history(history_path)

        self.assertIn("threads:post:1", history["commented"])
        self.assertNotIn("threads:post:1", history["liked"])

    def test_warmup_history_persists_browsed_targets_for_cross_task_dedupe(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            history_path = Path(temp_dir) / "history.json"
            runner._record_warmup_action_history(
                history_path,
                action="browse",
                target={
                    "target_key": "threads:post:browsed",
                    "target_url": "https://www.threads.net/@barber/post/browsed",
                    "target_fingerprint": "threads:text:browsed",
                },
                keyword="剪发工具",
            )
            history = runner._load_warmup_action_history(history_path)

        self.assertIn("threads:post:browsed", history["browsed"])
        self.assertIn(
            "threads:text:browsed",
            runner._warmup_history_identity_keys(history["browsed"]),
        )
        self.assertNotIn("threads:post:browsed", history["liked"])
        self.assertNotIn("threads:post:browsed", history["commented"])

    def test_warmup_waits_for_completed_browse_interval_before_first_interaction(self):
        payload = {
            "session_seconds": 15,
            "browse_limit": 3,
            "like_limit": 1,
            "like_chance": 100,
            "max_comments": 0,
            "interaction_every_min_posts": 2,
            "interaction_every_max_posts": 2,
            "require_persona_relevance": False,
        }
        events = []
        relevant = {"text": "理发技巧", "root": mock.Mock()}

        def click_like(*_args, **_kwargs):
            self.assertEqual(events.count("scroll"), 2)
            events.append("like")
            return 1

        def scroll(_page):
            events.append("scroll")
            return {"delta": 320}

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_guard_warmup_risk"),
            mock.patch.object(runner, "_ensure_warmup_relevant_surface", return_value=relevant),
            mock.patch.object(runner, "_next_warmup_interaction_at", return_value=2),
            mock.patch.object(runner, "_click_some_threads_likes", side_effect=click_like),
            mock.patch.object(runner, "_open_random_platform_post", return_value=False),
            mock.patch.object(runner, "_slow_human_scroll", side_effect=scroll),
            mock.patch.object(runner, "_wait_for_cancellation"),
            mock.patch.object(runner, "_screenshot", return_value="like.png"),
            mock.patch.object(runner, "_compose_warmup_evidence_sheet", return_value="evidence.jpg"),
            mock.patch.object(runner.time, "monotonic", return_value=0),
        ):
            result = runner._run_threads_warmup(
                _Page(),
                {"id": "browse-before-interaction"},
                payload,
                Path("."),
                _Logger(),
            )

        self.assertEqual(events[:3], ["scroll", "scroll", "like"])
        self.assertEqual(result["liked"], 1)

    def test_threads_comment_screenshot_callback_runs_after_typing_before_submit(self):
        page = mock.Mock()
        button = mock.Mock()
        box = mock.Mock()
        events = []

        with (
            mock.patch.object(runner, "_threads_reply_button", return_value=button),
            mock.patch.object(runner, "_threads_published_reply_count", return_value=0),
            mock.patch.object(runner, "_human_click"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_threads_text_box", return_value=box),
            mock.patch.object(
                runner,
                "_human_type",
                side_effect=lambda *_args, **_kwargs: events.append("typed"),
            ),
            mock.patch.object(
                runner,
                "_click_threads_reply_submit",
                side_effect=lambda *_args, **_kwargs: events.append("submit") or True,
            ),
            mock.patch.object(runner, "_wait_for_threads_reply_echo", return_value=True),
        ):
            posted = runner._post_threads_warmup_comment(
                page,
                _Logger(),
                "这个细节很实用",
                before_submit=lambda: events.append("screenshot"),
            )

        self.assertTrue(posted)
        self.assertEqual(events, ["typed", "screenshot", "submit"])

    def test_human_wheel_uses_bounded_native_input_on_live_display(self):
        page = mock.Mock()
        page.viewport_size = {"width": 1600, "height": 839}
        completed = mock.Mock(returncode=0)

        with (
            mock.patch.dict("os.environ", {"DISPLAY": ":90"}),
            mock.patch.object(runner.shutil, "which", return_value="/usr/bin/xdotool"),
            mock.patch.object(runner.subprocess, "run", return_value=completed) as run,
        ):
            driver = runner._send_human_wheel(page, 120)

        self.assertEqual(driver, "xdotool")
        self.assertEqual(run.call_count, 2)
        self.assertNotIn("--sync", run.call_args_list[0].args[0])
        self.assertIn("--screen", run.call_args_list[0].args[0])
        self.assertEqual(run.call_args_list[1].args[0][-1], "5")
        self.assertEqual(run.call_args_list[1].kwargs["env"]["DISPLAY"], ":90")
        page.mouse.wheel.assert_not_called()

    def test_human_wheel_uses_browser_scoped_display_after_launch_env_is_restored(self):
        page = mock.Mock()
        page.viewport_size = {"width": 1600, "height": 839}
        page.context._tg_live_display = ":91"
        completed = mock.Mock(returncode=0)

        with (
            mock.patch.dict("os.environ", {}, clear=True),
            mock.patch.object(runner.shutil, "which", return_value="/usr/bin/xdotool"),
            mock.patch.object(runner.subprocess, "run", return_value=completed) as run,
        ):
            driver = runner._send_human_wheel(page, 140)

        self.assertEqual(driver, "xdotool")
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[0].kwargs["env"]["DISPLAY"], ":91")
        self.assertEqual(run.call_args_list[1].kwargs["env"]["DISPLAY"], ":91")
        page.mouse.wheel.assert_not_called()

    def test_human_wheel_falls_back_to_playwright_without_live_display(self):
        page = mock.Mock()
        page.viewport_size = {"width": 1600, "height": 839}

        with (
            mock.patch.dict("os.environ", {}, clear=True),
            mock.patch.object(runner.shutil, "which", return_value="/usr/bin/xdotool"),
        ):
            driver = runner._send_human_wheel(page, -80)

        self.assertEqual(driver, "playwright")
        page.mouse.wheel.assert_called_once_with(0, -80)

    def test_warmup_hard_limits_allow_moderate_custom_limits(self):
        self.assertEqual(runner.MAX_WARMUP_LIKES, 16)
        self.assertEqual(runner.MAX_WARMUP_COMMENTS, 6)

    def test_warmup_relevance_requires_persona_topic_match(self):
        payload = {
            "persona_topics": ["理发店日常", "短发造型"],
            "persona_context": "资深理发师，分享理发店日常和短发造型。",
        }

        matched = runner._score_warmup_post_relevance(
            payload,
            "短发造型打理时，发尾层次和日常护理都很重要。",
        )
        unmatched = runner._score_warmup_post_relevance(
            payload,
            "今天的半导体财报和市场量能值得继续观察。",
        )

        self.assertTrue(matched["relevant"])
        self.assertIn("短发造型", matched["matched"])
        self.assertFalse(unmatched["relevant"])

    def test_warmup_relevance_uses_topics_when_persona_name_is_only_a_display_name(self):
        payload = {
            "persona_name": "李师傅",
            "persona_topics": ["茶文化", "家居清洁", "品茶", "慢生活"],
            "persona_context": "退休后的慢生活，分享茶文化、茶具和家居清洁心得。",
        }

        relevance = runner._score_warmup_post_relevance(
            payload,
            "中国绿茶怎么采摘？机械采茶省时又省力。",
            keywords=["绿茶保存技巧"],
        )
        unrelated = runner._score_warmup_post_relevance(
            payload,
            "今天的半导体财报和市场量能值得继续观察。",
            keywords=["绿茶保存技巧"],
        )

        self.assertTrue(relevance["relevant"])
        self.assertIn("绿茶", relevance["matched"])
        self.assertFalse(unrelated["relevant"])

    def test_warmup_relevance_does_not_accept_generic_keyword_prefix_without_persona_anchor(self):
        payload = {
            "persona_name": "李师傅",
            "persona_topics": ["茶文化", "家居清洁", "品茶", "慢生活"],
            "persona_context": "退休后的慢生活，分享茶文化、茶具和家居清洁心得。",
        }

        relevance = runner._score_warmup_post_relevance(
            payload,
            "水光镜面发型护理，打造顺滑发丝。",
            keywords=["镜面擦拭心得"],
        )

        self.assertFalse(relevance["relevant"])

    def test_search_relevance_uses_matching_visible_result_not_only_center_card(self):
        unrelated = {"text": "今天的财经市场讨论。", "root": mock.Mock()}
        matched = {"text": "理发师分享男士短发打理技巧。", "root": mock.Mock()}

        def assess(_payload, text, **_kwargs):
            return {
                "relevant": "理发师" in text,
                "matched": ["理发师"] if "理发师" in text else [],
                "score": 5 if "理发师" in text else 0,
                "keywords": ["理发师"],
            }

        with (
            mock.patch.object(runner, "_generate_warmup_search_keywords_with_ai", return_value=["理发师"]),
            mock.patch.object(runner, "_visible_warmup_post_contexts", return_value=[unrelated, matched], create=True),
            mock.patch.object(runner, "_assess_warmup_post_relevance", side_effect=assess),
        ):
            selected = runner._ensure_warmup_relevant_surface(
                mock.Mock(),
                {"require_persona_relevance": True},
                _Logger(),
                platform="threads",
            )

        self.assertIs(selected["root"], matched["root"])

    def test_warmup_relevance_derives_searchable_keywords_from_persona_context(self):
        payload = {
            "persona_topics": [],
            "persona_context": "资深理发师，分享理发店日常和短发造型。",
        }

        relevance = runner._score_warmup_post_relevance(
            payload,
            "男士短发打理时，理发技巧和发型层次都要兼顾。",
        )

        self.assertTrue(relevance["relevant"])
        self.assertIn("理发", relevance["matched"])

    def test_warmup_relevance_matches_topic_fragments_from_a_model_search_phrase(self):
        payload = {
            "persona_name": "理发师",
            "persona_context": "专注发型设计、洗护和理发店日常。",
        }

        relevance = runner._score_warmup_post_relevance(
            payload,
            "今天分享一套洗发后的护发流程，听理发师的建议就没错。",
            keywords=["油头复古理发店"],
        )

        self.assertTrue(relevance["relevant"])
        self.assertIn("理发店", relevance["keywords"])

    def test_warmup_relevance_falls_back_to_persona_keyword_search(self):
        payload = {
            "persona_topics": ["理发"],
            "persona_context": "理发店日常与发型设计。",
            "require_persona_relevance": True,
        }
        contexts = iter((
            {"text": "今日财经市场热点。", "root": None},
            {"text": "科技产品发布会。", "root": None},
            {"text": "体育赛事讨论。", "root": None},
            {"text": "理发店日常的短发打理技巧。", "root": None},
        ))
        page = _Page()
        logger = _Logger()
        with (
            mock.patch.object(
                runner,
                "_generate_warmup_search_keywords_with_ai",
                return_value=["理发"],
            ),
            mock.patch.object(
                runner,
                "_visible_warmup_post_contexts",
                side_effect=lambda *_args, **_kwargs: [next(contexts)],
            ),
            mock.patch.object(runner, "_slow_human_scroll"),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_search_warmup_interest_surface", return_value="ui") as search,
        ):
            result = runner._ensure_warmup_relevant_surface(
                page,
                payload,
                logger,
                platform="threads",
            )

        self.assertIsNotNone(result)
        self.assertEqual(result["text"], "理发店日常的短发打理技巧。")
        self.assertEqual(search.call_args.args[1], "threads")
        self.assertTrue(search.call_args.args[2])
        self.assertEqual(result["search_driver"], "ui")

    def test_threads_keyword_search_clicks_search_ui_types_and_submits(self):
        page = mock.Mock()
        search_entry = mock.Mock()
        search_input = mock.Mock()

        with (
            mock.patch.object(runner, "_warmup_search_entry_locator", return_value=search_entry, create=True),
            mock.patch.object(runner, "_warmup_search_input_locator", return_value=search_input, create=True),
            mock.patch.object(runner, "_human_click", return_value=True) as click,
            mock.patch.object(runner, "_type_text") as type_text,
            mock.patch.object(runner, "_warmup_search_result_signature", return_value=("old",)),
            mock.patch.object(runner, "_wait_for_warmup_search_results", return_value=True) as wait_ready,
            mock.patch.object(runner, "_goto") as goto,
            mock.patch.object(runner, "_sleep_between"),
        ):
            runner._search_warmup_interest_surface(
                page,
                "threads",
                "男士短发",
                _Logger(),
            )

        self.assertEqual(click.call_count, 1)
        self.assertEqual(click.call_args.args[1], search_input)
        page.keyboard.press.assert_any_call("Control+A")
        page.keyboard.press.assert_any_call("Backspace")
        type_text.assert_called_once()
        self.assertEqual(type_text.call_args.args[1], "男士短发")
        self.assertEqual(type_text.call_args.kwargs["mode"], "type")
        page.keyboard.press.assert_any_call("Enter")
        wait_ready.assert_called_once_with(
            page,
            "threads",
            "男士短发",
            mock.ANY,
            previous_signature=("old",),
        )
        goto.assert_not_called()

    def test_instagram_keyword_search_activates_suggestion_and_opens_result(self):
        page = mock.Mock()
        search_input = mock.Mock()

        with (
            mock.patch.object(runner, "_warmup_search_input_locator", return_value=search_input),
            mock.patch.object(runner, "_human_click", return_value=True),
            mock.patch.object(runner, "_type_text"),
            mock.patch.object(runner, "_warmup_search_result_signature", return_value=("old",)),
            mock.patch.object(
                runner,
                "_submit_instagram_warmup_search",
                return_value="click_type_suggestion_open_result",
            ) as submit,
            mock.patch.object(runner, "_wait_for_warmup_search_results", return_value=True),
            mock.patch.object(runner, "_sleep_between"),
        ):
            driver = runner._search_warmup_interest_surface(
                page,
                "instagram",
                "barber stories",
                _Logger(),
            )

        self.assertEqual(driver, "ui")
        submit.assert_called_once_with(
            page,
            "barber stories",
            mock.ANY,
            "instagram_warmup_relevance_search",
        )
        page.keyboard.press.assert_any_call("Escape")
        self.assertNotIn(mock.call("Enter"), page.keyboard.press.call_args_list)

    def test_instagram_search_submission_clicks_suggestion_then_grid_post(self):
        page = mock.Mock()
        suggestion = mock.Mock()
        result_link = mock.Mock()

        with (
            mock.patch.object(runner, "_human_click", return_value=True) as click,
            mock.patch.object(
                runner,
                "_visible_instagram_search_suggestion",
                return_value=suggestion,
            ),
            mock.patch.object(runner, "_warmup_search_result_signature", return_value=()),
            mock.patch.object(
                runner,
                "_visible_instagram_search_post_link",
                return_value=result_link,
            ),
            mock.patch.object(runner, "_sleep_between"),
        ):
            interaction = runner._submit_instagram_warmup_search(
                page,
                "barber stories",
                _Logger(),
                "instagram_warmup_relevance_search",
            )

        self.assertEqual(interaction, "click_type_suggestion_open_result")
        self.assertEqual(click.call_args_list[0].args[1], suggestion)
        self.assertEqual(click.call_args_list[1].args[1], result_link)
        self.assertNotIn(mock.call("Enter"), page.keyboard.press.call_args_list)

    def test_instagram_search_suggestion_matches_visible_query_container(self):
        page = mock.Mock()
        candidate = mock.Mock()
        candidate.is_visible.return_value = True
        candidate.bounding_box.return_value = {
            "x": 40,
            "y": 120,
            "width": 260,
            "height": 44,
        }
        candidate.inner_text.return_value = "barber stories"
        candidate.get_attribute.return_value = (
            "/explore/search/keyword/?q=barber%20stories"
        )
        candidates = mock.Mock()
        candidates.count.return_value = 1
        candidates.nth.return_value = candidate
        page.locator.return_value = candidates

        selected = runner._visible_instagram_search_suggestion(
            page,
            "barber stories",
        )

        self.assertIs(selected, candidate)

    def test_keyword_search_opens_search_ui_only_when_input_is_not_already_visible(self):
        page = mock.Mock()
        search_entry = mock.Mock()
        search_input = mock.Mock()

        with (
            mock.patch.object(runner, "_warmup_search_entry_locator", return_value=search_entry),
            mock.patch.object(
                runner,
                "_warmup_search_input_locator",
                side_effect=[None, search_input],
            ),
            mock.patch.object(runner, "_human_click", return_value=True) as click,
            mock.patch.object(runner, "_type_text"),
            mock.patch.object(runner, "_warmup_search_result_signature", return_value=("old",)),
            mock.patch.object(runner, "_wait_for_warmup_search_results", return_value=True),
            mock.patch.object(runner, "_sleep_between"),
        ):
            driver = runner._search_warmup_interest_surface(
                page,
                "threads",
                "剪发工具",
                _Logger(),
            )

        self.assertEqual(driver, "ui")
        self.assertEqual(click.call_args_list[0].args[1], search_entry)
        self.assertEqual(click.call_args_list[1].args[1], search_input)

    def test_keyword_search_failure_never_navigates_directly_to_a_search_url(self):
        page = mock.Mock()
        with (
            mock.patch.object(runner, "_warmup_search_entry_locator", return_value=None),
            mock.patch.object(runner, "_warmup_search_input_locator", return_value=None),
            mock.patch.object(runner, "_goto") as goto,
        ):
            with self.assertRaisesRegex(RuntimeError, "search UI interaction failed"):
                runner._search_warmup_interest_surface(
                    page,
                    "threads",
                    "理发店趣事",
                    _Logger(),
                )

        goto.assert_not_called()

    def test_search_result_calibration_waits_for_two_stable_reads_without_scrolling(self):
        page = mock.Mock()
        logger = _Logger()
        with (
            mock.patch.object(
                runner,
                "_warmup_search_result_signature",
                side_effect=[(), ("new-result",), ("new-result",)],
            ),
            mock.patch.object(runner, "_sleep_between") as pause,
            mock.patch.object(runner, "_slow_human_scroll") as scroll,
        ):
            ready = runner._wait_for_warmup_search_results(
                page,
                "threads",
                "男士短发",
                logger,
                previous_signature=("old-result",),
            )

        self.assertTrue(ready)
        self.assertEqual(pause.call_count, 2)
        scroll.assert_not_called()

    def test_keyword_cycle_rotates_before_reusing_a_keyword(self):
        payload = {}
        keywords = ["男士短发", "发型打理", "理发店日常"]

        with mock.patch.object(runner.random, "shuffle", side_effect=lambda items: None):
            selected = [
                runner._next_warmup_search_keywords(payload, keywords, limit=1)[0]
                for _ in range(4)
            ]

        self.assertEqual(selected[:3], keywords)
        self.assertEqual(selected[3], keywords[0])

    def test_keyword_batch_never_reuses_the_current_active_keyword(self):
        payload = {"_warmup_active_search_keyword": "男士短发"}
        keywords = ["男士短发", "发型打理", "理发店日常", "剪发工具"]

        with mock.patch.object(runner.random, "shuffle", side_effect=lambda items: None):
            selected = runner._next_warmup_search_keywords(
                payload,
                keywords,
                limit=3,
            )

        self.assertEqual(selected, ["发型打理", "理发店日常", "剪发工具"])
        self.assertNotIn("男士短发", selected)

    def test_keyword_can_repeat_for_only_one_additional_cycle(self):
        payload = {}
        keywords = ["理发技巧", "发型打理"]

        with mock.patch.object(runner.random, "shuffle", side_effect=lambda items: None):
            selected = []
            for _ in range(4):
                keyword = runner._next_warmup_search_keywords(
                    payload,
                    keywords,
                    limit=1,
                )[0]
                selected.append(keyword)
                runner._mark_warmup_search_keyword_used(payload, keyword)
            exhausted = runner._next_warmup_search_keywords(
                payload,
                keywords,
                limit=1,
            )

        self.assertEqual(selected, ["理发技巧", "发型打理", "理发技巧", "发型打理"])
        self.assertEqual(exhausted, [])

    def test_keyword_batch_prioritizes_every_unused_term_before_repeating(self):
        payload = {}
        keywords = ["理发技巧", "发型打理", "剪发工具", "短发造型"]

        with mock.patch.object(runner.random, "shuffle", side_effect=lambda items: None):
            first_batch = runner._next_warmup_search_keywords(
                payload,
                keywords,
                limit=3,
            )
            runner._mark_warmup_search_keyword_used(payload, first_batch[0])
            second_batch = runner._next_warmup_search_keywords(
                payload,
                keywords,
                limit=3,
            )

        self.assertNotIn(first_batch[0], second_batch)
        self.assertTrue({"发型打理", "剪发工具", "短发造型"} & set(second_batch))

    def test_search_input_recovers_focus_without_url_navigation_when_pointer_is_blocked(self):
        page = mock.Mock()
        search_input = mock.Mock()
        search_input.evaluate.return_value = True
        logger = _Logger()

        with mock.patch.object(runner, "_human_click", return_value=False):
            focused = runner._focus_warmup_search_input(
                page,
                search_input,
                logger,
                "threads_warmup_relevance_search_focus",
            )

        self.assertTrue(focused)
        page.keyboard.press.assert_called_once_with("Escape")
        search_input.focus.assert_called_once_with(timeout=2500)
        search_input.evaluate.assert_called_once()

    def test_active_search_keyword_rotates_after_bounded_relevant_posts(self):
        payload = {
            "_warmup_active_search_keyword": "男士短发",
            "_warmup_search_keyword_matches": 3,
            "warmup_keyword_rotation_posts": 3,
        }

        self.assertTrue(runner._warmup_search_rotation_due(payload, phase="browse"))
        self.assertFalse(runner._warmup_search_rotation_due(payload, phase="initial"))

    def test_keyword_prompt_keeps_reference_tg_constraints(self):
        payload = {
            "persona_name": "理发师",
            "persona_context": "分享男士短发和发型打理。",
            "persona_topics": ["理发", "短发"],
        }
        model_reply = {
            "ok": True,
            "raw_text": '{"keywords":["男士短发","发型打理"]}',
        }
        with (
            mock.patch.object(runner, "_warmup_ai_settings", return_value=("https://llm.example", "key", ["model-a"])),
            mock.patch("get_gemini.request_gemini3_pro_raw_text", return_value=model_reply) as request,
        ):
            keywords = runner._generate_warmup_search_keywords_with_ai(payload)

        prompt = request.call_args.kwargs["user_input"]
        self.assertIn("不要抽取年龄、语言、语气、人格描述", prompt)
        self.assertIn("不同子主题扩展", prompt)
        self.assertIn("禁止同义改写", prompt)
        self.assertIn("近期已用关键词", prompt)
        self.assertIn("Threads 或 Instagram", prompt)
        self.assertIn("禁止英文、拼音、数字年龄、语言风格词", prompt)
        self.assertIn('{"primary":["..."],"interests":["..."]}', prompt)
        self.assertEqual(request.call_args.kwargs["temperature"], 0.65)
        self.assertEqual(request.call_args.kwargs["max_output_tokens"], 240)
        self.assertEqual(keywords[:2], ["男士短发", "发型打理"])

    def test_keyword_history_guides_the_model_without_hard_rejecting_core_terms(self):
        payload = {
            "persona_name": "理发师",
            "persona_context": "分享理发店工作和男士发型。 ",
            "persona_topics": ["理发", "短发"],
            "_warmup_recent_search_keywords": ["理发店日常", "男士短发"],
        }
        model_reply = {
            "ok": True,
            "raw_text": (
                '{"keywords":["理发店日常","理发店日常趣事","男士短发",'
                '"剪发工具","染发护理","顾客发型沟通"]}'
            ),
        }
        with (
            mock.patch.object(
                runner,
                "_warmup_ai_settings",
                return_value=("https://llm.example", "key", ["model-a"]),
            ),
            mock.patch("get_gemini.request_gemini3_pro_raw_text", return_value=model_reply),
        ):
            keywords = runner._generate_warmup_search_keywords_with_ai(payload)

        self.assertIn("理发店日常", keywords)
        self.assertNotIn("理发店日常趣事", keywords)
        self.assertIn("男士短发", keywords)
        self.assertIn("剪发工具", keywords)
        self.assertIn("染发护理", keywords)

    def test_keyword_generation_has_no_local_fallback_when_model_is_unavailable(self):
        payload = {
            "persona_name": "旅行摄影师",
            "persona_context": "记录城市建筑与自然风光。",
            "persona_topics": ["摄影", "旅行"],
        }

        with mock.patch.object(runner, "_warmup_ai_settings", return_value=("", "", [])):
            keywords = runner._generate_warmup_search_keywords_with_ai(payload)

        self.assertEqual(keywords, [])
        self.assertEqual(
            payload["_warmup_search_keyword_source"],
            "model_unavailable",
        )

    def test_keyword_prompt_is_generic_and_contains_no_profession_specific_example(self):
        payload = {
            "persona_name": "旅行摄影师",
            "persona_context": "记录城市建筑与自然风光。",
            "persona_topics": ["摄影", "旅行"],
        }
        model_reply = {
            "ok": True,
            "raw_text": '{"keywords":["城市建筑摄影","自然风光构图"]}',
        }
        with (
            mock.patch.object(
                runner,
                "_warmup_ai_settings",
                return_value=("https://llm.example", "key", ["model-a"]),
            ),
            mock.patch(
                "get_gemini.request_gemini3_pro_raw_text",
                return_value=model_reply,
            ) as request,
        ):
            keywords = runner._generate_warmup_search_keywords_with_ai(payload)

        prompt = request.call_args.kwargs["user_input"]
        self.assertNotIn("例如理发师", prompt)
        self.assertNotIn("木工", prompt)
        self.assertIn("唯一的主要内容主轴", prompt)
        self.assertIn("至少 70%", prompt)
        self.assertIn("最多占 20%-30%", prompt)
        self.assertEqual(keywords, ["城市建筑摄影", "自然风光构图"])

    def test_keyword_model_is_called_only_once_per_task_payload(self):
        payload = {
            "persona_name": "旅行摄影师",
            "persona_context": "记录城市建筑与自然风光。",
            "persona_topics": ["摄影", "旅行"],
        }
        model_reply = {
            "ok": True,
            "raw_text": '{"keywords":["城市建筑摄影","自然风光构图"]}',
        }
        with (
            mock.patch.object(
                runner,
                "_warmup_ai_settings",
                return_value=("https://llm.example", "key", ["model-a"]),
            ),
            mock.patch(
                "get_gemini.request_gemini3_pro_raw_text",
                return_value=model_reply,
            ) as request,
        ):
            first = runner._generate_warmup_search_keywords_with_ai(payload)
            second = runner._generate_warmup_search_keywords_with_ai(payload)

        self.assertEqual(first, second)
        request.assert_called_once()

    def test_structured_keyword_groups_cap_interest_share_without_local_content(self):
        payload = {
            "persona_name": "旅行摄影师",
            "persona_context": "记录城市建筑与自然风光，也长期制作皮具。",
            "persona_topics": ["摄影", "旅行", "皮具"],
        }
        model_reply = {
            "ok": True,
            "raw_text": (
                '{"primary":["城市建筑摄影","自然风光构图","街头光影记录",'
                '"旅行镜头选择","建筑线条取景","户外摄影天气"],'
                '"interests":["皮具缝制过程","皮革工具保养","手作日常"]}'
            ),
        }
        with (
            mock.patch.object(
                runner,
                "_warmup_ai_settings",
                return_value=("https://llm.example", "key", ["model-a"]),
            ),
            mock.patch(
                "get_gemini.request_gemini3_pro_raw_text",
                return_value=model_reply,
            ),
        ):
            keywords = runner._generate_warmup_search_keywords_with_ai(payload)

        self.assertEqual(len(keywords), 8)
        self.assertEqual(keywords[-2:], ["皮具缝制过程", "皮革工具保养"])
        self.assertNotIn("手作日常", keywords)

    def test_relevance_does_not_accept_an_unrelated_post_from_generic_fragments(self):
        payload = {
            "persona_name": "理发师",
            "persona_topics": ["理发", "手工"],
        }

        result = runner._score_warmup_post_relevance(
            payload,
            "电影人回母校分享行业经验和作品。",
            keywords=["理发经验分享", "手艺人作品"],
        )

        self.assertFalse(result["relevant"])
        self.assertNotIn("作品", result["matched"])

    def test_keyword_history_persists_recent_searches_for_the_next_task(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "threads_account_keywords.json"
            runner._record_warmup_keyword_history(path, "理发店趣事")
            runner._record_warmup_keyword_history(path, "剪发工具")
            runner._record_warmup_keyword_history(path, "理发店趣事")

            recent = runner._load_warmup_keyword_history(path)

        self.assertEqual(recent[:2], ["理发店趣事", "剪发工具"])

    def test_model_keywords_are_used_without_lexical_fallback(self):
        payload = {
            "persona_name": "理发师",
            "persona_context": "分享男士短发和发型打理。",
            "persona_topics": ["理发", "短发"],
        }
        model_reply = {"ok": True, "raw_text": '["男士短发", "发型打理", "男士短发"]'}
        with (
            mock.patch.object(runner, "_warmup_ai_settings", return_value=("https://llm.example", "key", ["model-a"])),
            mock.patch(
                "get_gemini.request_gemini3_pro_raw_text",
                return_value=model_reply,
            ) as request,
        ):
            keywords = runner._generate_warmup_search_keywords_with_ai(payload)

        self.assertEqual(keywords[:2], ["男士短发", "发型打理"])
        self.assertEqual(keywords, ["男士短发", "发型打理"])
        self.assertEqual(payload["_warmup_generated_search_keywords"], keywords)
        self.assertEqual(payload["_warmup_search_keyword_source"], "model:model-a")

    def test_model_keyword_failure_stops_without_local_fallback(self):
        payload = {
            "persona_name": "理发师",
            "persona_context": "分享短发造型与理发店日常。",
            "persona_topics": ["理发"],
        }
        with (
            mock.patch.object(runner, "_warmup_ai_settings", return_value=("https://llm.example", "key", ["model-a"])),
            mock.patch("get_gemini.request_gemini3_pro_raw_text", return_value={"ok": False}),
        ):
            keywords = runner._generate_warmup_search_keywords_with_ai(payload)

        self.assertEqual(keywords, [])
        self.assertEqual(payload["_warmup_search_keyword_source"], "model_failed")

    def test_warmup_still_probes_page_when_model_keywords_are_missing(self):
        payload = {
            "session_seconds": 15,
            "browse_limit": 1,
            "like_limit": 0,
            "max_comments": 0,
            "require_persona_relevance": True,
        }
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_guard_warmup_risk"),
            mock.patch.object(
                runner,
                "_generate_warmup_search_keywords_with_ai",
                return_value=[],
            ),
            mock.patch.object(
                runner,
                "_ensure_warmup_relevant_surface",
                return_value=None,
            ) as ensure,
            mock.patch.object(runner, "_next_warmup_interaction_at", return_value=99),
            mock.patch.object(runner, "_open_random_platform_post", return_value=False),
            mock.patch.object(runner, "_slow_human_scroll", return_value={"delta": 320}),
            mock.patch.object(runner, "_wait_for_cancellation"),
            mock.patch.object(runner, "_screenshot", return_value="warmup.png"),
            mock.patch.object(runner.time, "monotonic", side_effect=[0, 0, 0, 16, 16]),
        ):
            runner._run_threads_warmup(
                _Page(),
                {"id": "missing-model-keywords"},
                payload,
                Path("."),
                _Logger(),
            )

        ensure.assert_called()

    def test_generic_personality_words_are_not_used_as_search_queries(self):
        self.assertEqual(
            runner._sanitize_warmup_search_keywords(["搞笑", "生活日常", "理发搞笑", "男士短发"]),
            ["理发搞笑", "男士短发"],
        )

    def test_model_can_confirm_semantically_relevant_post_without_exact_keyword(self):
        payload = {
            "persona_name": "理发师",
            "persona_context": "分享发型打理与理发店日常。",
            "persona_topics": ["理发"],
        }
        with (
            mock.patch.object(runner, "_warmup_ai_settings", return_value=("https://llm.example", "key", ["model-a"])),
            mock.patch(
                "get_gemini.request_gemini3_pro_raw_text",
                return_value={"ok": True, "raw_text": '{"relevant": true}'},
            ) as request,
        ):
            result = runner._assess_warmup_post_relevance(
                payload,
                "今天分享剪烫之后的居家护理方法。",
                keywords=["理发"],
            )

        self.assertTrue(result["relevant"])
        self.assertTrue(result["model_checked"])
        self.assertIn("判断语义而不是逐字匹配", request.call_args.kwargs["user_input"])
        self.assertIn("行业内自然同义表达", request.call_args.kwargs["system_prompt"])

    def test_model_rejection_overrides_a_lexical_keyword_match(self):
        payload = {"persona_topics": ["理发"]}
        with (
            mock.patch.object(runner, "_warmup_ai_settings", return_value=("https://llm.example", "key", ["model-a"])),
            mock.patch(
                "get_gemini.request_gemini3_pro_raw_text",
                return_value={"ok": True, "raw_text": '{"relevant": false}'},
            ),
        ):
            result = runner._assess_warmup_post_relevance(
                payload,
                "理发店抽奖推广，点击链接领取。",
                keywords=["理发"],
            )

        self.assertFalse(result["relevant"])

    def test_browse_only_rechecks_relevance_before_every_scroll_on_both_platforms(self):
        payload = {
            "session_seconds": 15,
            "browse_limit": 2,
            "like_limit": 0,
            "max_comments": 0,
            "require_persona_relevance": True,
            "persona_topics": ["理发"],
        }
        relevant = {"text": "理发技巧", "root": mock.Mock()}
        for platform, run in (("threads", runner._run_threads_warmup), ("instagram", runner._run_instagram_warmup)):
            with (
                self.subTest(platform=platform),
                mock.patch.object(runner, "_goto"),
                mock.patch.object(runner, "_guard_warmup_risk"),
                mock.patch.object(
                    runner,
                    "_generate_warmup_search_keywords_with_ai",
                    return_value=["鐞嗗彂"],
                ),
                mock.patch.object(runner, "_ensure_warmup_relevant_surface", return_value=relevant) as ensure,
                mock.patch.object(runner, "_next_warmup_interaction_at", return_value=99),
                mock.patch.object(runner, "_open_random_platform_post", return_value=False),
                mock.patch.object(runner, "_slow_human_scroll", return_value={"delta": 320}) as scroll,
                mock.patch.object(runner, "_wait_for_cancellation"),
                mock.patch.object(runner, "_screenshot", return_value="warmup.png"),
                mock.patch.object(runner.time, "monotonic", return_value=0),
                mock.patch.object(runner, "_dismiss_instagram_interstitials", return_value=False),
            ):
                run(_Page(), {"id": f"{platform}-recheck"}, dict(payload), Path("."), _Logger())

            self.assertEqual(ensure.call_count, 3)
            self.assertEqual(scroll.call_count, 2)

    def test_warmup_stops_before_second_scroll_when_relevance_is_lost(self):
        payload = {
            "session_seconds": 15,
            "browse_limit": 2,
            "like_limit": 0,
            "max_comments": 0,
            "require_persona_relevance": True,
            "persona_topics": ["理发"],
        }
        relevant = {"text": "理发技巧", "root": mock.Mock()}
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_guard_warmup_risk"),
            mock.patch.object(
                runner,
                "_generate_warmup_search_keywords_with_ai",
                return_value=["理发"],
            ),
            mock.patch.object(runner, "_ensure_warmup_relevant_surface", side_effect=[relevant, relevant, None]),
            mock.patch.object(runner, "_next_warmup_interaction_at", return_value=99),
            mock.patch.object(runner, "_slow_human_scroll", return_value={"delta": 320}) as scroll,
            mock.patch.object(runner, "_wait_for_cancellation"),
            mock.patch.object(runner.time, "monotonic", return_value=0),
        ):
            with self.assertRaisesRegex(RuntimeError, "停止"):
                runner._run_threads_warmup(_Page(), {"id": "lost-relevance"}, payload, Path("."), _Logger())

        self.assertEqual(scroll.call_count, 1)

    def test_warmup_finishes_when_relevance_is_exhausted_after_required_interaction(self):
        payload = {
            "session_seconds": 15,
            "browse_limit": 3,
            "like_limit": 1,
            "like_chance": 100,
            "max_comments": 0,
            "min_required_likes": 1,
            "require_persona_relevance": True,
            "persona_topics": ["理发"],
        }
        relevant = {
            "text": "分享理发技巧",
            "root": mock.Mock(),
            "target_key": "post-1",
            "target_url": "https://threads.net/post-1",
        }
        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_guard_warmup_risk"),
            mock.patch.object(
                runner,
                "_generate_warmup_search_keywords_with_ai",
                return_value=["理发技巧"],
            ),
            mock.patch.object(
                runner,
                "_ensure_warmup_relevant_surface",
                side_effect=[relevant, relevant, None],
            ),
            mock.patch.object(runner, "_next_warmup_interaction_at", return_value=0),
            mock.patch.object(runner, "_click_some_threads_likes", return_value=1),
            mock.patch.object(runner, "_slow_human_scroll", return_value={"delta": 320}),
            mock.patch.object(runner, "_wait_for_cancellation"),
            mock.patch.object(runner, "_screenshot", return_value="like.png"),
            mock.patch.object(runner, "_compose_warmup_evidence_sheet", return_value="evidence.jpg"),
            mock.patch.object(runner.time, "monotonic", return_value=0),
        ):
            result = runner._run_threads_warmup(
                _Page(),
                {"id": "completed-before-exhaustion"},
                payload,
                Path("."),
                _Logger(),
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["liked"], 1)
        self.assertEqual(result["evidenceScreenshots"], ["evidence.jpg"])

    def test_threads_like_scope_is_the_verified_post_root(self):
        page = mock.Mock()
        root = mock.Mock()
        with mock.patch.object(runner, "_threads_like_buttons", return_value=[]) as buttons:
            runner._click_some_threads_likes(page, _Logger(), 1, target_root=root)
        buttons.assert_called_once_with(root)

    def test_instagram_like_scope_is_the_verified_post_root(self):
        page = mock.Mock()
        root = mock.Mock()
        with mock.patch.object(runner, "_instagram_action_locators", return_value=[]) as locators:
            runner._click_some_instagram_likes(page, _Logger(), 1, target_root=root)
        locators.assert_called_once_with(root, "Like")

    def test_threads_browse_feed_does_not_start_the_full_warmup_chain(self):
        with (
            mock.patch.object(
                runner,
                "_run_browse_feed",
                return_value={"ok": True},
            ) as browse,
            mock.patch.object(runner, "_run_threads_warmup") as warmup,
        ):
            result = runner._dispatch_browse_feed(
                _Page(),
                {"id": "threads-browse"},
                {},
                Path("."),
                _Logger(),
                platform="threads",
            )

        self.assertTrue(result["ok"])
        browse.assert_called_once()
        warmup.assert_not_called()

    def test_both_platform_wrappers_use_the_shared_warmup_executor(self):
        with mock.patch.object(
            runner,
            "_run_platform_warmup",
            return_value={"ok": True},
        ) as execute:
            for platform, run in (
                ("threads", runner._run_threads_warmup),
                ("instagram", runner._run_instagram_warmup),
            ):
                with self.subTest(platform=platform):
                    run(
                        _Page(),
                        {"id": f"{platform}-shared"},
                        {},
                        Path("."),
                        _Logger(),
                    )

        self.assertEqual(
            [call.kwargs["platform"] for call in execute.call_args_list],
            ["threads", "instagram"],
        )

    def test_platform_post_reader_dispatches_to_the_matching_adapter(self):
        page = _Page()
        with (
            mock.patch.object(runner, "_open_random_threads_post", return_value=True) as threads_open,
            mock.patch.object(runner, "_open_random_instagram_post", return_value=True) as instagram_open,
        ):
            self.assertTrue(runner._open_random_platform_post(page, _Logger(), platform="threads"))
            self.assertTrue(runner._open_random_platform_post(page, _Logger(), platform="instagram"))

        threads_open.assert_called_once()
        instagram_open.assert_called_once()

    def test_both_platforms_have_a_topic_search_url(self):
        self.assertIn("threads.net/search", runner._warmup_interest_search_url("threads", "理发"))
        self.assertIn("instagram.com/explore/search/keyword", runner._warmup_interest_search_url("instagram", "理发"))

    def test_warmup_skips_test_post_content_before_generating_a_reply(self):
        payload = {
            "persona_topics": ["理发"],
            "require_persona_relevance": True,
        }
        with mock.patch.object(runner, "_generate_persona_reply_with_ai") as generate:
            reply = runner._pick_warmup_persona_reply(
                payload,
                "理发闭环测试，系统测试，请忽略",
            )

        self.assertEqual(reply, "")
        generate.assert_not_called()

    def test_warmup_comment_generation_uses_the_compact_comment_limit(self):
        payload = {
            "persona_topics": ["理发"],
            "require_persona_relevance": True,
        }
        with mock.patch.object(
            runner,
            "_generate_persona_reply_with_ai",
            return_value="这个打理思路很实用。",
        ) as generate:
            reply = runner._pick_warmup_persona_reply(
                payload,
                "分享一套理发后的日常打理技巧。",
            )

        self.assertEqual(reply, "这个打理思路很实用。")
        self.assertEqual(generate.call_args.kwargs["limit"], runner.MAX_WARMUP_COMMENT_CHARS)

    def test_warmup_comment_accepts_the_same_derived_topic_as_relevance_selection(self):
        payload = {
            "persona_context": "退休后喜欢研究茶文化、品茶和家居清洁。",
            "persona_topics": ["茶文化", "品茶", "家居清洁"],
            "require_persona_relevance": True,
        }
        target_text = "chineseteagirl #太平猴魁 #茶叶制作 #绿茶"

        generated_keywords = ["茶叶品质判断", "茶具陈列艺术"]
        self.assertTrue(
            runner._assess_warmup_post_relevance(
                payload,
                target_text,
                keywords=generated_keywords,
            )["relevant"]
        )
        with mock.patch.object(
            runner,
            "_generate_persona_reply_with_ai",
            return_value="太平猴魁香气独特，慢慢品更有味道。",
        ) as generate:
            reply = runner._pick_warmup_persona_reply(
                payload,
                target_text,
                keywords=generated_keywords,
            )

        self.assertEqual(reply, "太平猴魁香气独特，慢慢品更有味道。")
        generate.assert_called_once()

    def test_both_platform_wrappers_use_the_shared_auto_reply_executor(self):
        with mock.patch.object(
            runner,
            "_run_platform_auto_reply",
            return_value={"ok": True},
        ) as execute:
            for platform, run in (
                ("threads", runner._run_threads_auto_reply),
                ("instagram", runner._run_instagram_auto_reply),
            ):
                with self.subTest(platform=platform):
                    run(
                        _Page(),
                        {"id": f"{platform}-reply-shared"},
                        {},
                        Path("."),
                        _Logger(),
                    )

        self.assertEqual(
            [call.kwargs["platform"] for call in execute.call_args_list],
            ["threads", "instagram"],
        )

    def test_minimum_targets_must_fit_configured_capacity(self):
        with self.assertRaisesRegex(RuntimeError, "总上限"):
            runner._warmup_minimum_targets(
                {"min_required_interactions": 1},
                like_limit=0,
                max_comments=0,
            )

    def test_threads_like_is_not_counted_without_state_confirmation(self):
        button = mock.Mock()
        button.is_visible.return_value = True
        button.get_attribute.return_value = "Like"
        button.inner_text.return_value = ""
        group = mock.Mock()
        group.count.return_value = 1
        group.nth.return_value = button

        with (
            mock.patch.object(runner, "_threads_like_buttons", return_value=[group]),
            mock.patch.object(runner, "_threads_unlike_count", side_effect=[0, 0]),
            mock.patch.object(runner, "_human_click"),
            mock.patch.object(runner, "_sleep_between"),
        ):
            clicked = runner._click_some_threads_likes(
                mock.Mock(),
                _Logger(),
                1,
            )

        self.assertEqual(clicked, 0)

    def test_both_platforms_stop_when_warmup_risk_is_detected(self):
        risk = {
            "status": "need_verification",
            "reason": "触发平台风控限制",
        }
        for platform in ("threads", "instagram"):
            with (
                self.subTest(platform=platform),
                mock.patch.object(runner, "_warmup_risk_state", return_value=risk),
            ):
                with self.assertRaisesRegex(runner.NeedManualError, "风控"):
                    runner._guard_warmup_risk(
                        mock.Mock(),
                        platform,
                        {"stop_on_risk_limit": True},
                        _Logger(),
                    )

    def test_banned_risk_preserves_account_health_status(self):
        risk = {
            "status": "cookie_expired",
            "health_status": "banned",
            "reason": "账号已被封禁",
        }
        with mock.patch.object(runner, "_warmup_risk_state", return_value=risk):
            with self.assertRaises(runner.NeedManualError) as context:
                runner._guard_warmup_risk(
                    mock.Mock(),
                    "instagram",
                    {"stop_on_risk_limit": True},
                    _Logger(),
                )

        self.assertEqual(context.exception.health_status, "banned")

    def test_verification_risk_always_pauses_for_manual_takeover(self):
        callback = mock.Mock()
        risk = {
            "status": "need_verification",
            "health_status": "abnormal",
            "reason": "Instagram requires human verification",
            "force_manual": "true",
        }
        context_control = {
            "account_login_status_callback": callback,
        }
        with (
            mock.patch.object(runner, "_warmup_risk_state", return_value=risk),
            mock.patch.object(runner, "_screenshot", return_value="verification.png"),
            mock.patch.object(runner, "_request_manual_takeover") as request_manual,
            mock.patch.object(runner, "_resume_after_manual_takeover") as resume_auto,
            mock.patch.object(
                runner,
                "_wait_for_manual_login_completion",
                return_value={"status": "ready"},
            ) as wait_manual,
        ):
            runner._guard_warmup_risk(
                mock.Mock(),
                "instagram",
                {"stop_on_risk_limit": False},
                _Logger(),
                task={"id": "task-1", "payload": {}},
                screenshot_dir=Path("."),
                context_control=context_control,
            )

        request_manual.assert_called_once_with(context_control)
        resume_auto.assert_called_once_with(context_control)
        callback.assert_has_calls([mock.call("need_verification"), mock.call("ready")])
        wait_manual.assert_called_once()

    def test_confirm_human_page_is_an_immediate_manual_risk(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/"
        empty_group = mock.Mock()
        empty_group.count.return_value = 0
        body = mock.Mock()
        body.inner_text.return_value = "Confirm you're human Enter the code from the image"
        page.locator.side_effect = lambda selector: body if selector == "body" else empty_group

        risk = runner._warmup_risk_state(page, "instagram")

        self.assertEqual(risk["status"], "need_verification")
        self.assertEqual(risk["health_status"], "abnormal")
        self.assertEqual(risk["force_manual"], "true")
        self.assertEqual(risk["challenge_type"], "numeric_image_captcha")

    def test_human_verification_page_without_image_code_uses_dead_account_retry(self):
        page = mock.Mock()
        page.url = "https://www.instagram.com/challenge/"
        empty_group = mock.Mock()
        empty_group.count.return_value = 0
        body = mock.Mock()
        body.inner_text.return_value = "Help us confirm you're human to continue"
        page.locator.side_effect = lambda selector: body if selector == "body" else empty_group

        risk = runner._warmup_risk_state(page, "instagram")

        self.assertEqual(risk["status"], "need_verification")
        self.assertEqual(risk["health_status"], "abnormal")
        self.assertEqual(risk["force_manual"], "true")
        self.assertEqual(risk["challenge_type"], "human_verification")

    def test_human_verification_is_banned_after_the_single_retry(self):
        page = mock.Mock()
        callback = mock.Mock()
        context_control = {"account_login_status_callback": callback}
        challenge = {
            "status": "need_verification",
            "health_status": "abnormal",
            "reason": "Instagram requires human verification",
            "force_manual": "true",
            "challenge_type": "human_verification",
        }
        with (
            mock.patch.object(runner, "_warmup_risk_state", side_effect=[challenge, challenge]),
            mock.patch.object(runner, "_wait_for_cancellation"),
            mock.patch.object(runner, "_request_manual_takeover") as request_manual,
            self.assertRaises(runner.NeedManualError) as raised,
        ):
            runner._guard_warmup_risk(
                page,
                "instagram",
                {"stop_on_risk_limit": False},
                _Logger(),
                task={"id": "task-1", "payload": {}},
                screenshot_dir=Path("."),
                context_control=context_control,
            )

        page.reload.assert_called_once_with(wait_until="domcontentloaded", timeout=30000)
        request_manual.assert_not_called()
        callback.assert_called_once_with("disabled")
        self.assertEqual(raised.exception.status, "disabled")
        self.assertEqual(raised.exception.health_status, "banned")

    def test_numeric_image_captcha_retries_once_and_recovers_when_page_clears(self):
        page = mock.Mock()
        callback = mock.Mock()
        context_control = {"account_login_status_callback": callback}
        captcha = {
            "status": "need_verification",
            "health_status": "abnormal",
            "reason": "Instagram requires image verification",
            "force_manual": "true",
            "challenge_type": "numeric_image_captcha",
        }
        with (
            mock.patch.object(runner, "_warmup_risk_state", side_effect=[captcha, None]),
            mock.patch.object(runner, "_wait_for_cancellation") as wait_retry,
        ):
            runner._guard_warmup_risk(
                page,
                "instagram",
                {"stop_on_risk_limit": False},
                _Logger(),
                context_control=context_control,
            )

        page.reload.assert_called_once_with(wait_until="domcontentloaded", timeout=30000)
        wait_retry.assert_called_once()
        callback.assert_not_called()
        self.assertNotIn("instagram_numeric_captcha_retry_attempted", context_control)

    def test_numeric_image_captcha_is_banned_after_the_single_retry(self):
        page = mock.Mock()
        callback = mock.Mock()
        context_control = {"account_login_status_callback": callback}
        captcha = {
            "status": "need_verification",
            "health_status": "abnormal",
            "reason": "Instagram requires image verification",
            "force_manual": "true",
            "challenge_type": "numeric_image_captcha",
        }
        with (
            mock.patch.object(runner, "_warmup_risk_state", side_effect=[captcha, captcha]),
            mock.patch.object(runner, "_wait_for_cancellation"),
            mock.patch.object(runner, "_request_manual_takeover") as request_manual,
            self.assertRaises(runner.NeedManualError) as raised,
        ):
            runner._guard_warmup_risk(
                page,
                "instagram",
                {"stop_on_risk_limit": False},
                _Logger(),
                task={"id": "task-1", "payload": {}},
                screenshot_dir=Path("."),
                context_control=context_control,
            )

        page.reload.assert_called_once_with(wait_until="domcontentloaded", timeout=30000)
        request_manual.assert_not_called()
        callback.assert_called_once_with("disabled")
        self.assertEqual(raised.exception.status, "disabled")
        self.assertEqual(raised.exception.health_status, "banned")

    def test_numeric_image_captcha_reload_failure_remains_abnormal(self):
        page = mock.Mock()
        page.reload.side_effect = TimeoutError("reload timed out")
        callback = mock.Mock()
        context_control = {"account_login_status_callback": callback}
        captcha = {
            "status": "need_verification",
            "health_status": "abnormal",
            "reason": "Instagram requires image verification",
            "force_manual": "true",
            "challenge_type": "numeric_image_captcha",
        }
        with (
            mock.patch.object(runner, "_warmup_risk_state", return_value=captcha),
            mock.patch.object(runner, "_request_manual_takeover") as request_manual,
            self.assertRaises(runner.NeedManualError) as raised,
        ):
            runner._guard_warmup_risk(
                page,
                "instagram",
                {"stop_on_risk_limit": False},
                _Logger(),
                context_control=context_control,
            )

        request_manual.assert_called_once_with(context_control)
        callback.assert_called_once_with("need_verification")
        self.assertEqual(raised.exception.status, "need_verification")
        self.assertEqual(raised.exception.health_status, "abnormal")

    def test_threads_post_open_does_not_swallow_cancellation(self):
        cancel_event = threading.Event()
        link = mock.Mock()
        link.is_visible.return_value = True
        link.bounding_box.return_value = {
            "width": 100,
            "height": 40,
            "y": 120,
        }
        link.get_attribute.return_value = "/@tester/post/123"
        candidates = mock.Mock()
        candidates.count.return_value = 1
        candidates.nth.return_value = link
        page = mock.Mock()
        page.url = "https://www.threads.net/"
        page.locator.return_value = candidates

        def cancel_after_click(*_args, **_kwargs):
            cancel_event.set()

        with (
            mock.patch.object(runner, "_human_click", side_effect=cancel_after_click),
            mock.patch.object(runner.random, "shuffle"),
        ):
            with self.assertRaisesRegex(RuntimeError, "取消"):
                runner._open_random_threads_post(
                    page,
                    _Logger(),
                    cancel_event=cancel_event,
                )

    def test_instagram_post_open_does_not_swallow_cancellation(self):
        cancel_event = threading.Event()
        link = mock.Mock()
        link.is_visible.return_value = True
        link.bounding_box.return_value = {
            "width": 100,
            "height": 40,
            "y": 120,
        }
        link.get_attribute.return_value = "/p/123/"
        candidates = mock.Mock()
        candidates.count.return_value = 1
        candidates.nth.return_value = link
        page = mock.Mock()
        page.url = "https://www.instagram.com/"
        page.locator.return_value = candidates

        def cancel_after_click(*_args, **_kwargs):
            cancel_event.set()

        with (
            mock.patch.object(runner, "_human_click", side_effect=cancel_after_click),
            mock.patch.object(runner.random, "shuffle"),
        ):
            with self.assertRaisesRegex(RuntimeError, "取消"):
                runner._open_random_instagram_post(
                    page,
                    _Logger(),
                    cancel_event=cancel_event,
                )

    def test_instagram_rejects_success_below_minimum_total_interactions(self):
        payload = {
            "session_seconds": 15,
            "browse_limit": 1,
            "like_limit": 1,
            "like_chance": 0,
            "max_comments": 1,
            "comment_chance": 0,
            "min_required_likes": 0,
            "min_required_comments": 0,
            "min_required_interactions": 1,
        }

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(
                runner,
                "_dismiss_instagram_interstitials",
                return_value=False,
            ),
            mock.patch.object(runner, "_next_warmup_interaction_at", return_value=99),
            mock.patch.object(
                runner,
                "_slow_human_scroll",
                return_value={"delta": 320},
            ),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="warmup.png"),
            mock.patch.object(runner.time, "monotonic", return_value=0),
        ):
            with self.assertRaises(RuntimeError):
                runner._run_instagram_warmup(
                    _Page(),
                    {"id": "instagram-minimum-interactions"},
                    payload,
                    Path("."),
                    _Logger(),
                )

    def test_threads_rejects_success_below_minimum_total_interactions(self):
        payload = {
            "session_seconds": 15,
            "browse_limit": 1,
            "like_limit": 1,
            "like_chance": 0,
            "max_comments": 1,
            "comment_chance": 0,
            "min_required_likes": 0,
            "min_required_comments": 0,
            "min_required_interactions": 1,
        }

        with (
            mock.patch.object(runner, "_goto"),
            mock.patch.object(runner, "_next_warmup_interaction_at", return_value=99),
            mock.patch.object(
                runner,
                "_slow_human_scroll",
                return_value={"delta": 320},
            ),
            mock.patch.object(runner, "_sleep_between"),
            mock.patch.object(runner, "_screenshot", return_value="warmup.png"),
            mock.patch.object(runner.time, "monotonic", return_value=0),
        ):
            with self.assertRaises(RuntimeError):
                runner._run_threads_warmup(
                    _Page(),
                    {"id": "threads-minimum-interactions"},
                    payload,
                    Path("."),
                    _Logger(),
                )

    def test_threads_dispatch_passes_cancel_event_into_interruptible_warmup(self):
        cancel_event = threading.Event()
        page = mock.Mock()
        page.url = "https://www.threads.net/"
        context = mock.Mock()
        manager = mock.MagicMock()
        manager.__enter__.return_value = context

        def cancel_after_first_scroll(_page):
            cancel_event.set()
            return {"delta": 320}

        task = {
            "id": "threads-cancel",
            "task_type": "threads_warmup",
            "platform": "threads",
            "payload": {
                "session_seconds": 15,
                "browse_limit": 2,
                "like_limit": 0,
                "max_comments": 0,
                "require_persona_relevance": False,
            },
        }

        with tempfile.TemporaryDirectory() as data_dir:
            with (
                mock.patch.object(
                    runner,
                    "_open_camoufox_context",
                    return_value=manager,
                ),
                mock.patch.object(runner, "_import_initial_cookies"),
                mock.patch.object(runner, "_first_page", return_value=page),
                mock.patch.object(runner, "_sync_live_browser_viewport"),
                mock.patch.object(
                    runner,
                    "_check_platform_login",
                    return_value={"status": "ready"},
                ),
                mock.patch.object(runner, "_goto"),
                mock.patch.object(
                    runner,
                    "_next_warmup_interaction_at",
                    return_value=99,
                ),
                mock.patch.object(
                    runner,
                    "_slow_human_scroll",
                    side_effect=cancel_after_first_scroll,
                ),
                mock.patch.object(runner, "_sleep_between"),
                mock.patch.object(runner, "_screenshot", return_value="warmup.png"),
                mock.patch.object(runner.time, "monotonic", return_value=0),
            ):
                with self.assertRaisesRegex(RuntimeError, "取消"):
                    runner.run_social_task(
                        task=task,
                        account={"platform": "threads"},
                        proxy=None,
                        data_dir=data_dir,
                        logger=_Logger(),
                        cancel_event=cancel_event,
                    )
