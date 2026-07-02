import unittest

from aiogram.types import ReplyKeyboardMarkup

from src.digital_human_tg_bot import bot


class TextToImageStatusTextTests(unittest.TestCase):
    def test_internal_webapp_task_list_shows_workflow_name(self) -> None:
        text = bot._format_internal_webapp_tg_tasks(
            [
                {
                    "id": "task_1",
                    "type": "get_nano_banana",
                    "status": "running",
                    "workflow_name": "圖片編輯",
                    "workflow_ids": ["__converted__/old.api.json"],
                    "current_workflow_name": "圖片編輯",
                    "current_workflow_ids": ["__converted__/轉化TG機器人/firered图像编辑.api.json"],
                }
            ]
        )

        self.assertIn("工作流：圖片編輯 / 轉化TG機器人/firered图像编辑", text)

    def test_internal_webapp_status_shows_active_workflow_name(self) -> None:
        text = bot._format_internal_webapp_tg_status(
            {
                "counts": {"queued": 0, "running": 1, "success": 0, "failed": 0},
                "active_task": {
                    "id": "task_1",
                    "type": "get_nano_banana",
                    "workflow_name": "圖片編輯",
                    "workflow_ids": ["__converted__/old.api.json"],
                    "current_workflow_name": "圖片編輯",
                    "current_workflow_ids": ["__converted__/轉化TG機器人/firered图像编辑.api.json"],
                },
            },
            chat_id=8100401093,
        )

        self.assertIn("目前占用: get_nano_banana / task_1", text)
        self.assertIn("工作流：圖片編輯 / 轉化TG機器人/firered图像编辑", text)

    def test_status_text_omits_unselected_placeholders(self) -> None:
        text = bot._text_to_image_status_text(
            step="1/4 請選擇圖像比例",
            params={
                "ratio_selected": False,
                "resolution_selected": False,
                "persona_selected": False,
                "prompt_mode_selected": False,
            },
        )

        self.assertEqual(text, "文生圖設置\n當前步驟：1/4 請選擇圖像比例")
        self.assertNotIn("畫面比例：", text)
        self.assertNotIn("基礎分辨率：", text)
        self.assertNotIn("最終分辨率：", text)
        self.assertNotIn("人設 LoRA：", text)
        self.assertNotIn("提示詞方式：", text)

    def test_status_text_expands_only_selected_settings(self) -> None:
        text = bot._text_to_image_status_text(
            step="2/4 請選擇最終分辨率",
            params={
                "ratio_selected": True,
                "aspect_ratio": "2:3",
                "note": "基礎豎圖",
                "width": 640,
                "height": 960,
                "resolution_selected": False,
                "persona_selected": False,
                "prompt_mode_selected": False,
            },
        )

        self.assertEqual(
            text,
            "文生圖設置\n當前步驟：2/4 請選擇最終分辨率\n畫面比例：2:3（基礎豎圖）\n基礎分辨率：640 x 960",
        )
        self.assertNotIn("最終分辨率：", text)
        self.assertNotIn("人設 LoRA：", text)
        self.assertNotIn("提示詞方式：", text)

    def test_status_text_hides_final_resolution_when_workflow_has_base_only(self) -> None:
        text = bot._text_to_image_status_text(
            step="2/3 請選擇人設 LoRA",
            params={
                "ratio_selected": True,
                "aspect_ratio": "8:15",
                "note": "人設_t2i 基本比例",
                "width": 1024,
                "height": 1920,
                "final_resolution_available": False,
                "final_resolution_enabled": False,
                "resolution_selected": True,
                "persona_selected": False,
                "prompt_mode_selected": False,
            },
        )

        self.assertIn("當前步驟：2/3 請選擇人設 LoRA", text)
        self.assertIn("畫面比例：8:15（人設_t2i 基本比例）", text)
        self.assertIn("基礎分辨率：1024 x 1920", text)
        self.assertNotIn("最終分辨率：", text)

    def test_prompt_failure_keyboard_uses_reply_keyboard(self) -> None:
        markup = bot._text_to_image_prompt_failure_reply_keyboard()

        self.assertIsInstance(markup, ReplyKeyboardMarkup)
        labels = [button.text for row in markup.keyboard for button in row]
        self.assertIn("重新生成提示詞", labels)
        self.assertIn("輸入自定義提示詞", labels)
        self.assertNotIn("使用這個提示詞生成", labels)

    def test_video_prompt_failure_keyboard_prioritizes_available_actions(self) -> None:
        markup = bot._video_i2v_prompt_failure_keyboard()

        self.assertIsInstance(markup, ReplyKeyboardMarkup)
        rows = [[button.text for button in row] for row in markup.keyboard]
        self.assertEqual(
            rows,
            [
                ["重新生成提示詞"],
                ["輸入自定義提示詞提交"],
                ["返回參數設定", bot.MAIN_MENU_BUTTON],
            ],
        )
        labels = [label for row in rows for label in row]
        self.assertNotIn("使用這個提示詞生成", labels)
        self.assertNotIn("繼續讓 Grok 調整", labels)

    def test_video_i2v_payload_instructs_grok_to_use_uploaded_image_as_first_frame(self) -> None:
        source = bot.Path(bot.__file__).read_text(encoding="utf-8")

        self.assertIn("Treat the reference image as the first frame and opening state", source)
        self.assertIn("preserve its subject, pose, composition, scene, lighting, clothing/body state, and camera framing", source)
        self.assertIn('"tg_original_user_request": prompt', source)

    def test_image_edit_prompt_review_keyboard_uses_static_traditional_text(self) -> None:
        markup = bot._image_edit_prompt_review_keyboard()

        self.assertIsInstance(markup, ReplyKeyboardMarkup)
        rows = [[button.text for button in row] for row in markup.keyboard]
        self.assertEqual(
            rows,
            [
                ["使用這個提示詞提交"],
                ["輸入自定義提示詞提交"],
                ["繼續讓 Grok 調整", "重新生成提示詞"],
                ["上一步", bot.MAIN_MENU_BUTTON],
            ],
        )
        labels = [label for row in rows for label in row]
        self.assertNotIn("提交單圖編輯任務", labels)
        self.assertNotIn("提交圖片編輯任務", labels)

    def test_image_edit_prompt_mode_keyboard_requires_choice_before_prompt_entry(self) -> None:
        markup = bot._image_edit_prompt_mode_keyboard()

        self.assertIsInstance(markup, ReplyKeyboardMarkup)
        rows = [[button.text for button in row] for row in markup.keyboard]
        self.assertEqual(
            rows,
            [
                ["讓 Grok 生成提示詞"],
                ["輸入自定義提示詞"],
                ["上一步", bot.MAIN_MENU_BUTTON],
            ],
        )
        self.assertTrue(hasattr(bot.ProductionWorkflowForm, "image_edit_waiting_for_prompt_mode"))

    def test_image_edit_flow_does_not_prompt_for_request_immediately_after_assets(self) -> None:
        source = bot.Path(bot.__file__).read_text(encoding="utf-8")

        self.assertNotIn("步驟 3/4：請輸入這次圖片編輯要求", source)
        self.assertNotIn("步驟 2/3：請輸入這次圖片編輯要求", source)
        self.assertIn("image_edit_waiting_for_prompt_mode", source)
        self.assertIn("請選擇提示詞方式", source)
        self.assertIn("請輸入這次圖片編輯要求，Grok 會先生成提示詞供你確認", source)

    def test_face_swap_prompt_keyboard_offers_natural_swap_button(self) -> None:
        markup = bot._face_swap_prompt_keyboard()

        self.assertIsInstance(markup, ReplyKeyboardMarkup)
        rows = [[button.text for button in row] for row in markup.keyboard]
        self.assertEqual(
            rows,
            [
                ["自然換臉"],
                ["輸入自定義換臉要求"],
                ["上一步", bot.MAIN_MENU_BUTTON],
            ],
        )

    def test_simplified_button_aliases_are_still_accepted(self) -> None:
        self.assertEqual(bot._canonical_button_text("图片编辑"), bot.IMAGE_EDIT_BUTTON)
        self.assertEqual(bot._canonical_button_text("返回主菜单"), bot.MAIN_MENU_BUTTON)
        self.assertEqual(bot._canonical_button_text("图生视频"), bot.VIDEO_GENERAL_EDIT_BUTTON)
        self.assertEqual(bot._canonical_button_text("人物换脸"), bot.FACE_SWAP_BUTTON)
        self.assertEqual(bot._canonical_button_text("增加解析度 2 倍"), bot.FACE_SWAP_UPSCALE_BUTTON)
        self.assertEqual(bot._canonical_button_text("重新生成人物換臉"), bot.FACE_SWAP_RERUN_BUTTON)
        self.assertEqual(bot._canonical_button_text("繼續編輯結果圖"), bot.IMAGE_EDIT_CONTINUE_RESULT_BUTTON)
        self.assertEqual(bot._canonical_button_text("重新生成圖片編輯"), bot.IMAGE_EDIT_RERUN_BUTTON)

    def test_continue_text_to_image_restores_params_but_requires_new_prompt(self) -> None:
        restored = bot._text_to_image_continue_state_from_payload(
            {
                "aspect_ratio": "2:3",
                "width": 640,
                "height": 960,
                "final_resolution_enabled": False,
                "persona_enabled": True,
                "persona_lora": r"Character Setting\人设1捞女1金君雅.safetensors",
                "persona_label": "人設1撈女1金君雅",
                "tg_original_prompt": "臥室白髮少女",
                "tg_llm_rewritten_prompt": "一位白髮少女站在現代臥室中，柔和光線，寫實攝影",
                "tg_llm_selected_model": "xai/grok-4.3",
                "tg_prompt_display_text": "一位白髮少女站在現代臥室中，柔和光線，寫實攝影",
            }
        )

        self.assertEqual(restored["original_user_request"], "臥室白髮少女")
        self.assertEqual(restored["last_grok_user_request"], "")
        self.assertEqual(restored["previous_final_prompt_text"], "一位白髮少女站在現代臥室中，柔和光線，寫實攝影")
        self.assertEqual(restored["final_prompt_text"], "")
        self.assertFalse(restored["prompt_display_ready"])
        self.assertEqual(restored["prompt_mode_label"], "Grok 生成")
        self.assertTrue(restored["persona_enabled"])

    def test_person_t2i_node_inputs_leave_lora_controls_to_gateway_workflow(self) -> None:
        params = bot._text_to_image_params({"text_to_image_workflow_profile": "person_t2i"})
        node_inputs = bot._text_to_image_remote_node_inputs(params)

        self.assertEqual(node_inputs["160"]["batch_size"], 3)
        self.assertNotIn("184", node_inputs)
        self.assertNotIn("185", node_inputs)
        self.assertNotIn("186", node_inputs)
        self.assertNotIn("191", node_inputs)
        self.assertNotIn("195", node_inputs)
        self.assertNotIn("196", node_inputs)
        self.assertNotIn("197", node_inputs)

    def test_text_to_image_ratio_options_include_common_view_ratios(self) -> None:
        expected = ["2:3", "3:4", "9:16", "3:2", "4:3", "16:9", "1:1"]

        standard_ratios = list(bot._text_to_image_ratio_options("zit_final").keys())
        person_ratios = list(bot._text_to_image_ratio_options("person_t2i").keys())

        for ratio in expected:
            self.assertIn(ratio, standard_ratios)
            self.assertIn(ratio, person_ratios)

    def test_person_t2i_native_ratio_label_is_basic_ratio(self) -> None:
        options = bot._text_to_image_ratio_options("person_t2i")

        self.assertEqual(options["8:15"]["label"], "基本比例")
        self.assertEqual(options["8:15"]["width"], 1024)
        self.assertEqual(options["8:15"]["height"], 1920)

    def test_person_t2i_widescreen_ratio_updates_comfy_dimensions(self) -> None:
        params = bot._text_to_image_params(
            {
                "text_to_image_workflow_profile": "person_t2i",
                "aspect_ratio": "16:9",
            }
        )
        node_inputs = bot._text_to_image_remote_node_inputs(params)

        self.assertEqual(params["width"], 1820)
        self.assertEqual(params["height"], 1024)
        self.assertEqual(node_inputs["160"]["width"], 1820)
        self.assertEqual(node_inputs["160"]["height"], 1024)
        self.assertEqual(node_inputs["160"]["batch_size"], 3)

    def test_person_t2i_reroll_does_not_reuse_stale_lora_controls(self) -> None:
        payload, _seed = bot._text_to_image_reroll_payload(
            {
                "text_to_image_workflow_profile": "person_t2i",
                "prompt": "臥室人物",
                "remote_comfy_node_inputs": {
                    "185": {"lora_name": r"ZIT\臀部Z-Hip-Slider.safetensors", "strength_model": 0.6, "strength_clip": 1.0},
                    "186": {"lora_name": r"ZIT\胸部Z-Breast-Slider.safetensors", "strength_model": 0.6, "strength_clip": 1.0},
                    "191": {"lora_name": r"Z-Image\Z-ImageTubro big-nipples.safetensors", "strength_model": 0.0, "strength_clip": 0.0},
                },
            }
        )

        node_inputs = payload["remote_comfy_node_inputs"]
        self.assertNotIn("185", node_inputs)
        self.assertNotIn("186", node_inputs)
        self.assertNotIn("191", node_inputs)
        self.assertNotIn("195", node_inputs)
        self.assertNotIn("196", node_inputs)
        self.assertNotIn("197", node_inputs)


if __name__ == "__main__":
    unittest.main()
