import unittest

from webapp import server
from webapp import video_workbench


class AdminVideoRuntimeConfigTests(unittest.TestCase):
    def test_source_video_runtime_settings_are_normalized(self):
        normalized = server._normalize_runtime_config(
            {
                "runninghub_personal_api_key": "personal-key",
                "runninghub_enterprise_api_key": "enterprise-key",
                "digital_human_oral_hot_topic_mode": "soft",
                "video_image_model_priority_order": "nano banana 2, gpt image 2, invalid-model",
                "minimax_api_key": "minimax-key",
                "minimax_base_url": "https://overseas.invalid",
                "minimax_tts_model": "speech-2.8-hd",
                "minimax_tts_voice_id": "male-qn-qingse",
            }
        )

        self.assertEqual(normalized["runninghub_personal_api_key"], "personal-key")
        self.assertEqual(normalized["runninghub_enterprise_api_key"], "enterprise-key")
        self.assertEqual(normalized["digital_human_oral_hot_topic_mode"], "soft")
        self.assertEqual(normalized["video_image_model_priority_order"], "nano banana 2, gpt image 2")
        self.assertEqual(normalized["minimax_api_key"], "minimax-key")
        self.assertEqual(normalized["minimax_base_url"], "https://api.minimaxi.com")
        self.assertEqual(normalized["minimax_tts_model"], "speech-2.8-hd")
        self.assertEqual(normalized["minimax_tts_voice_id"], "male-qn-qingse")

    def test_invalid_source_values_fall_back_to_source_defaults(self):
        normalized = server._normalize_runtime_config(
            {
                "digital_human_oral_hot_topic_mode": "unexpected",
                "video_image_model_priority_order": "unsupported-model",
            }
        )

        self.assertEqual(normalized["digital_human_oral_hot_topic_mode"], "strong")
        self.assertEqual(
            normalized["video_image_model_priority_order"],
            "gpt image 2, nano banana 2, nano banana pro",
        )

    def test_video_image_tasks_receive_video_source_model_order(self):
        merged = video_workbench.apply_video_runtime_defaults(
            "image_generate",
            {},
            {
                "image_model_priority_order": "general-image-model",
                "video_image_model_priority_order": "nano banana 2, gpt image 2",
            },
        )

        self.assertEqual(merged["image_model_priority_order"], "nano banana 2, gpt image 2")
        self.assertEqual(merged["image_model_default_model"], "nano banana 2")

    def test_partial_admin_save_only_contains_source_visible_settings(self):
        payload = server.RuntimeConfigPayload(
            runninghub_personal_api_key="personal-key",
            digital_human_oral_hot_topic_mode="off",
            video_image_model_priority_order="gpt image 2",
            minimax_tts_model="speech-2.8-hd",
        )

        self.assertEqual(
            payload.model_dump(exclude_unset=True),
            {
                "runninghub_personal_api_key": "personal-key",
                "digital_human_oral_hot_topic_mode": "off",
                "video_image_model_priority_order": "gpt image 2",
                "minimax_tts_model": "speech-2.8-hd",
            },
        )


if __name__ == "__main__":
    unittest.main()
