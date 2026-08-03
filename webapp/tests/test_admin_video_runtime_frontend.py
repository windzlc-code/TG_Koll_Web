import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AdminVideoRuntimeFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "static" / "admin.html").read_text(encoding="utf-8")
        cls.javascript = (ROOT / "static" / "assets" / "admin.js").read_text(encoding="utf-8")

    def test_video_runtime_tab_and_fields_are_present(self):
        self.assertIn('data-model-tab="video"', self.html)
        self.assertIn('data-model-panel="video"', self.html)
        field_ids = (
            "rtVideoRunningHubBaseUrl",
            "rtVideoRunningHubApiKey",
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
            "rtVideoLocalMaxConcurrency",
        )
        for field_id in field_ids:
            self.assertIn(f'id="{field_id}"', self.html)

    def test_payload_and_fill_support_every_video_runtime_key(self):
        runtime_keys = (
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
            "video_local_max_concurrency",
        )
        for runtime_key in runtime_keys:
            self.assertGreaterEqual(
                self.javascript.count(runtime_key),
                2,
                f"{runtime_key} must be serialized and restored",
            )

    def test_video_secrets_use_existing_mask_and_reveal_contract(self):
        self.assertIn('rtVideoRunningHubApiKey: "video_runninghub_api_key"', self.javascript)
        self.assertIn('rtVideoTtsApiKey: "video_tts_api_key"', self.javascript)
        self.assertIn('runtimeSecretInputValue("rtVideoRunningHubApiKey")', self.javascript)
        self.assertIn('runtimeSecretInputValue("rtVideoTtsApiKey")', self.javascript)
        self.assertIn('setRuntimeSecretInputState("rtVideoRunningHubApiKey"', self.javascript)
        self.assertIn('setRuntimeSecretInputState("rtVideoTtsApiKey"', self.javascript)


if __name__ == "__main__":
    unittest.main()
