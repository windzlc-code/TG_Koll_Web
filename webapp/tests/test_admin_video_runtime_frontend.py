import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AdminVideoRuntimeFrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "static" / "admin.html").read_text(encoding="utf-8")
        cls.javascript = (ROOT / "static" / "assets" / "admin.js").read_text(encoding="utf-8")

    def test_video_tab_exposes_only_source_admin_settings(self):
        expected_ids = (
            "rtVideoRunningHubPersonalApiKey",
            "rtVideoRunningHubEnterpriseApiKey",
            "rtVideoOralHotTopicMode",
            "rtVideoImagePriorityModelList",
            "rtVideoImageModelCandidate",
            "btnAddVideoImagePriorityModel",
            "rtVideoMiniMaxTtsModel",
            "rtVideoMiniMaxTtsVoiceId",
        )
        for field_id in expected_ids:
            self.assertIn(f'id="{field_id}"', self.html)

        unsupported_ids = (
            "rtVideoRunningHubBaseUrl",
            "rtVideoRunningHubApiKey",
            "rtVideoCreateAudioAppId",
            "rtVideoCreateVideoAppId",
            "rtVideoReplaceModelAppId",
            "rtVideoReplaceProductAppId",
            "rtVideoEcommerceAppId",
            "rtVideoEcommerceFastAppId",
            "rtVideoMiniMaxApiKey",
            "rtVideoMiniMaxBaseUrl",
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
        for field_id in unsupported_ids:
            self.assertNotIn(f'id="{field_id}"', self.html)

    def test_source_labels_and_fixed_minimax_url_are_preserved(self):
        for label in (
            "个人 API Key",
            "企业级共享 API Key",
            "口播热点模式",
            "图片模型优先级",
            "MiniMax Speech",
            "TTS 模型 ID",
            "默认音色 ID",
        ):
            self.assertIn(label, self.html)
        self.assertIn('id="rtVideoMiniMaxTtsModel"', self.html)
        self.assertIn("<select id=\"rtVideoMiniMaxTtsModel\">", self.html)
        self.assertIn('value="speech-2.8-hd"', self.html)
        self.assertIn('value="speech-2.8-turbo"', self.html)
        self.assertIn('value="speech-02-hd"', self.html)
        self.assertNotIn("speech-01-hd", self.html)
        self.assertNotIn("MiniMax API Key", self.html)
        self.assertNotIn("https://api.minimaxi.com", self.html)
        self.assertIn('value="male-qn-qingse"', self.html)
        self.assertIn('VIDEO_SPEECH_VOICE_DEFAULT = "male-qn-qingse"', self.javascript)
        self.assertIn('text === "Wise_Woman"', self.javascript)
        self.assertIn("文字模型沿用系统文字模型配置", self.html)

    def test_source_runtime_keys_are_serialized_and_restored(self):
        for runtime_key in (
            "runninghub_personal_api_key",
            "runninghub_enterprise_api_key",
            "digital_human_oral_hot_topic_mode",
            "video_image_model_priority_order",
            "minimax_tts_model",
            "minimax_tts_voice_id",
        ):
            self.assertGreaterEqual(self.javascript.count(runtime_key), 2)
        self.assertIn('video_tts_provider: "runninghub"', self.javascript)
        self.assertNotIn('minimax_base_url: "https://api.minimaxi.com"', self.javascript)

    def test_source_secrets_use_existing_mask_contract(self):
        mappings = {
            "rtVideoRunningHubPersonalApiKey": "runninghub_personal_api_key",
            "rtVideoRunningHubEnterpriseApiKey": "runninghub_enterprise_api_key",
        }
        for field_id, runtime_key in mappings.items():
            self.assertIn(f'{field_id}: "{runtime_key}"', self.javascript)
            self.assertIn(f'runtimeSecretInputValue("{field_id}")', self.javascript)
            self.assertIn(f'setRuntimeSecretInputState("{field_id}"', self.javascript)


if __name__ == "__main__":
    unittest.main()
