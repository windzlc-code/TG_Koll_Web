import unittest

from webapp import server
from webapp import video_workbench


class AdminVideoRuntimeConfigTests(unittest.TestCase):
    def test_legacy_video_secrets_migrate_to_original_project_keys(self):
        normalized = server._normalize_runtime_config(
            {
                "video_runninghub_api_key": "legacy-runninghub",
                "video_tts_api_key": "legacy-minimax",
                "video_tts_model": "legacy-model",
                "video_default_voice_id": "legacy-voice",
            }
        )

        self.assertEqual(normalized["runninghub_personal_api_key"], "legacy-runninghub")
        self.assertEqual(normalized["runninghub_enterprise_api_key"], "")
        self.assertEqual(normalized["runninghub_api_key"], "legacy-runninghub")
        self.assertEqual(normalized["video_runninghub_api_key"], "legacy-runninghub")
        self.assertEqual(normalized["minimax_api_key"], "legacy-minimax")
        self.assertEqual(normalized["minimax_tts_model"], "legacy-model")
        self.assertEqual(normalized["minimax_tts_voice_id"], "legacy-voice")
        self.assertEqual(normalized["video_tts_api_key"], "legacy-minimax")

    def test_split_runninghub_and_minimax_values_drive_video_aliases(self):
        normalized = server._normalize_runtime_config(
            {
                "runninghub_personal_api_key": "personal-key",
                "runninghub_enterprise_api_key": "enterprise-key",
                "minimax_api_key": "minimax-key",
                "minimax_base_url": "https://overseas.example.invalid",
                "minimax_tts_model": "speech-2.8-hd",
                "minimax_tts_voice_id": "male-qn-qingse",
            }
        )

        self.assertEqual(normalized["runninghub_api_key"], "personal-key")
        self.assertEqual(normalized["video_runninghub_api_key"], "personal-key")
        self.assertEqual(normalized["minimax_base_url"], "https://api.minimaxi.com")
        self.assertEqual(normalized["video_tts_base_url"], "https://api.minimaxi.com")
        self.assertEqual(normalized["video_tts_model"], "speech-2.8-hd")
        self.assertEqual(normalized["video_default_voice_id"], "male-qn-qingse")

    def test_empty_original_keys_do_not_erase_valid_compatibility_values(self):
        normalized = server._normalize_runtime_config(
            {
                "runninghub_personal_api_key": "",
                "runninghub_enterprise_api_key": "",
                "video_runninghub_api_key": "legacy-runninghub",
                "minimax_api_key": "",
                "video_tts_api_key": "legacy-minimax",
                "minimax_tts_model": "",
                "video_tts_model": "explicit-video-model",
                "minimax_tts_voice_id": "",
                "video_default_voice_id": "explicit-video-voice",
            }
        )

        self.assertEqual(normalized["runninghub_personal_api_key"], "legacy-runninghub")
        self.assertEqual(normalized["video_runninghub_api_key"], "legacy-runninghub")
        self.assertEqual(normalized["minimax_api_key"], "legacy-minimax")
        self.assertEqual(normalized["minimax_tts_model"], "explicit-video-model")
        self.assertEqual(normalized["minimax_tts_voice_id"], "explicit-video-voice")

    def test_enterprise_only_key_is_not_duplicated_into_personal_slot(self):
        normalized = server._normalize_runtime_config(
            {
                "runninghub_personal_api_key": "",
                "runninghub_enterprise_api_key": "enterprise-key",
                "video_runninghub_api_key": "enterprise-key",
            }
        )

        self.assertEqual(normalized["runninghub_personal_api_key"], "")
        self.assertEqual(normalized["runninghub_enterprise_api_key"], "enterprise-key")
        self.assertEqual(normalized["video_runninghub_api_key"], "enterprise-key")
        self.assertEqual(normalized["new_persona_runninghub_api_key"], "enterprise-key")

    def test_existing_new_persona_key_migrates_to_shared_enterprise_key(self):
        normalized = server._normalize_runtime_config(
            {
                "new_persona_runninghub_base_url": "https://shared.runninghub.invalid",
                "new_persona_runninghub_api_key": "existing-enterprise-key",
                "runninghub_personal_api_key": "",
                "runninghub_enterprise_api_key": "",
                "video_runninghub_api_key": "",
            }
        )

        self.assertEqual(normalized["runninghub_personal_api_key"], "")
        self.assertEqual(normalized["runninghub_enterprise_api_key"], "existing-enterprise-key")
        self.assertEqual(normalized["new_persona_runninghub_api_key"], "existing-enterprise-key")
        self.assertEqual(normalized["video_runninghub_api_key"], "existing-enterprise-key")
        self.assertEqual(normalized["video_runninghub_base_url"], "https://shared.runninghub.invalid")

    def test_task_defaults_forward_original_project_keys(self):
        merged = video_workbench.apply_video_runtime_defaults(
            "create_video",
            {},
            {
                "runninghub_personal_api_key": "personal-key",
                "runninghub_enterprise_api_key": "enterprise-key",
                "minimax_api_key": "minimax-key",
                "minimax_base_url": "https://api.minimaxi.com",
                "minimax_tts_model": "speech-2.8-hd",
                "minimax_tts_voice_id": "male-qn-qingse",
            },
        )

        self.assertEqual(merged["runninghub_personal_api_key"], "personal-key")
        self.assertEqual(merged["runninghub_enterprise_api_key"], "enterprise-key")
        self.assertEqual(merged["minimax_api_key"], "minimax-key")
        self.assertEqual(merged["minimax_tts_model"], "speech-2.8-hd")
        self.assertEqual(merged["minimax_tts_voice_id"], "male-qn-qingse")

    def test_partial_admin_save_does_not_emit_hidden_video_defaults(self):
        payload = server.RuntimeConfigPayload(
            runninghub_personal_api_key="personal-key",
            minimax_tts_model="speech-2.8-hd",
            video_local_max_concurrency=3,
        )

        explicit = payload.model_dump(exclude_unset=True)
        self.assertEqual(
            explicit,
            {
                "runninghub_personal_api_key": "personal-key",
                "minimax_tts_model": "speech-2.8-hd",
                "video_local_max_concurrency": 3,
            },
        )
        self.assertNotIn("video_create_video_app_id", explicit)
        self.assertNotIn("video_default_duration_seconds", explicit)
        self.assertNotIn("new_persona_runninghub_api_key", explicit)

    def test_original_project_secret_keys_are_redacted(self):
        redacted = server._redact_runtime_config(
            {
                "runninghub_personal_api_key": "personal-secret",
                "runninghub_enterprise_api_key": "enterprise-secret",
                "minimax_api_key": "minimax-secret",
            }
        )

        for key in (
            "runninghub_personal_api_key",
            "runninghub_enterprise_api_key",
            "minimax_api_key",
        ):
            self.assertEqual(redacted[key], "")
            self.assertTrue(redacted[f"{key}_configured"])
            self.assertTrue(redacted[f"{key}_masked"])


if __name__ == "__main__":
    unittest.main()
