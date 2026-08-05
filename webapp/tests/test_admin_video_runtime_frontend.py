import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AdminVideoRuntimeFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "static" / "admin.html").read_text(encoding="utf-8")
        cls.javascript = (ROOT / "static" / "assets" / "admin.js").read_text(encoding="utf-8")

    def test_video_runtime_tab_shows_only_supported_fields(self):
        self.assertIn('data-model-tab="video"', self.html)
        self.assertIn('data-model-panel="video"', self.html)
        shared_field_ids = (
            "rtRunningHubPersonalApiKey",
            "rtRunningHubEnterpriseApiKey",
        )
        for field_id in shared_field_ids:
            self.assertIn(f'id="{field_id}"', self.html)

        video_field_ids = (
            "rtVideoMiniMaxApiKey",
            "rtVideoMiniMaxBaseUrl",
            "rtVideoMiniMaxTtsModel",
            "rtVideoMiniMaxTtsVoiceId",
            "rtVideoLocalMaxConcurrency",
        )
        for field_id in video_field_ids:
            self.assertIn(f'id="{field_id}"', self.html)

        hidden_field_ids = (
            "rtVideoRunningHubBaseUrl",
            "rtVideoRunningHubApiKey",
            "rtVideoRunningHubPersonalApiKey",
            "rtVideoRunningHubEnterpriseApiKey",
            "rtVideoCreateAudioAppId",
            "rtVideoCreateVideoAppId",
            "rtVideoReplaceModelAppId",
            "rtVideoReplaceProductAppId",
            "rtVideoEcommerceAppId",
            "rtVideoEcommerceFastAppId",
            "rtVideoTtsProvider",
            "rtVideoTtsBaseUrl",
            "rtVideoTtsApiKey",
            "rtVideoTtsModel",
            "rtVideoDefaultVoiceId",
            "rtVideoDefaultDurationSeconds",
            "rtVideoDefaultRatio",
            "rtVideoDefaultResolution",
        )
        for field_id in hidden_field_ids:
            self.assertNotIn(f'id="{field_id}"', self.html)

        for target in ("runninghub", "text", "image"):
            self.assertIn(f'data-model-config-jump="{target}"', self.html)

    def test_payload_and_fill_use_original_video_runtime_keys(self):
        runtime_keys = (
            "runninghub_personal_api_key",
            "runninghub_enterprise_api_key",
            "minimax_api_key",
            "minimax_base_url",
            "minimax_tts_model",
            "minimax_tts_voice_id",
            "video_local_max_concurrency",
        )
        for runtime_key in runtime_keys:
            self.assertGreaterEqual(
                self.javascript.count(runtime_key),
                2,
                f"{runtime_key} must be serialized and restored",
            )

        removed_runtime_keys = (
            "video_runninghub_base_url",
            "video_runninghub_api_key",
            "video_create_audio_app_id",
            "video_create_video_app_id",
            "video_replace_model_app_id",
            "video_replace_product_app_id",
            "video_ecommerce_app_id",
            "video_ecommerce_fast_app_id",
            "video_tts_provider",
            "video_tts_base_url",
            "video_tts_api_key",
            "video_tts_model",
            "video_default_voice_id",
            "video_default_duration_seconds",
            "video_default_ratio",
            "video_default_resolution",
        )
        for runtime_key in removed_runtime_keys:
            self.assertNotIn(runtime_key, self.javascript)

    def test_video_secrets_use_existing_mask_and_reveal_contract(self):
        secret_fields = {
            "rtRunningHubPersonalApiKey": "runninghub_personal_api_key",
            "rtRunningHubEnterpriseApiKey": "runninghub_enterprise_api_key",
            "rtVideoMiniMaxApiKey": "minimax_api_key",
        }
        for field_id, runtime_key in secret_fields.items():
            self.assertIn(f'{field_id}: "{runtime_key}"', self.javascript)
            self.assertIn(f'runtimeSecretInputValue("{field_id}")', self.javascript)
            self.assertIn(f'setRuntimeSecretInputState("{field_id}"', self.javascript)

    def test_video_links_reuse_existing_system_model_tabs(self):
        self.assertIn('document.querySelectorAll("[data-model-config-jump]")', self.javascript)
        self.assertIn('button.dataset.modelConfigJump', self.javascript)
        self.assertIn('const enterpriseKey = runtimeSecretInputValue("rtRunningHubEnterpriseApiKey")', self.javascript)
        self.assertIn('const personalKey = runtimeSecretInputValue("rtRunningHubPersonalApiKey")', self.javascript)

    def test_minimax_model_and_voice_defaults_match_original_project(self):
        self.assertIn('v.minimax_tts_model || "speech-2.8-hd"', self.javascript)
        self.assertIn('v.minimax_tts_voice_id || "male-qn-qingse"', self.javascript)


if __name__ == "__main__":
    unittest.main()
