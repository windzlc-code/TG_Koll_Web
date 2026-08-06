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
            "rtVideoMiniMaxApiKey",
            "rtVideoMiniMaxBaseUrl",
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
            "MiniMax API Key",
            "MiniMax 国内版接口地址",
            "TTS 模型 ID",
            "默认音色 ID",
        ):
            self.assertIn(label, self.html)
        self.assertIn('id="rtVideoMiniMaxBaseUrl" type="url" value="https://api.minimaxi.com" readonly', self.html)
        self.assertIn("文字模型沿用系统文字模型配置", self.html)

    def test_source_runtime_keys_are_serialized_and_restored(self):
        for runtime_key in (
            "runninghub_personal_api_key",
            "runninghub_enterprise_api_key",
            "digital_human_oral_hot_topic_mode",
            "video_image_model_priority_order",
            "minimax_api_key",
            "minimax_tts_model",
            "minimax_tts_voice_id",
        ):
            self.assertGreaterEqual(self.javascript.count(runtime_key), 2)
        self.assertIn('minimax_base_url: "https://api.minimaxi.com"', self.javascript)

    def test_source_secrets_use_existing_mask_contract(self):
        mappings = {
            "rtVideoRunningHubPersonalApiKey": "runninghub_personal_api_key",
            "rtVideoRunningHubEnterpriseApiKey": "runninghub_enterprise_api_key",
            "rtVideoMiniMaxApiKey": "minimax_api_key",
        }
        for field_id, runtime_key in mappings.items():
            self.assertIn(f'{field_id}: "{runtime_key}"', self.javascript)
            self.assertIn(f'runtimeSecretInputValue("{field_id}")', self.javascript)
            self.assertIn(f'setRuntimeSecretInputState("{field_id}"', self.javascript)


if __name__ == "__main__":
    unittest.main()
