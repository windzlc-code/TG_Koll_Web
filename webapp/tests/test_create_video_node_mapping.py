import unittest
from unittest.mock import patch

import create_video


class CreateVideoNodeMappingTests(unittest.TestCase):
    @patch("create_video.calculate_image_width", return_value={"width": 576, "height": 1024})
    def test_runninghub_201875_app_uses_documented_nodes(self, _mock_size):
        node_info = create_video._build_node_info_list(
            app_id="2018758760096862209",
            image_url="image.png",
            audio_url="audio.mp3",
            duration_seconds=15,
            prompt_text="一个女孩在深情地歌唱，镜头环绕她缓缓旋转",
            camera_video_url="camera.mp4",
        )

        self.assertEqual(
            node_info,
            [
                {"nodeId": "42", "fieldName": "image", "fieldValue": "image.png", "description": "请导入图片"},
                {"nodeId": "17", "fieldName": "audio", "fieldValue": "audio.mp3", "description": "请导入音频"},
                {"nodeId": "248", "fieldName": "value", "fieldValue": "15", "description": "设置视频时长（秒）"},
                {"nodeId": "7", "fieldName": "text", "fieldValue": "一个女孩在深情地歌唱，镜头环绕她缓缓旋转", "description": "动作提示词"},
                {"nodeId": "33", "fieldName": "value", "fieldValue": "576", "description": "视频宽度"},
                {"nodeId": "34", "fieldName": "value", "fieldValue": "1024", "description": "视频高度"},
            ],
        )

    @patch("create_video.calculate_image_width", return_value={"width": 1984, "height": 1184})
    def test_runninghub_201875_app_clamps_large_dimensions_for_video_workflow(self, _mock_size):
        node_info = create_video._build_node_info_list(
            app_id="2018758760096862209",
            image_url="image.png",
            audio_url="audio.mp3",
            duration_seconds=15,
            prompt_text="提示词",
            camera_video_url=None,
        )

        self.assertEqual(node_info[4]["fieldValue"], "576")
        self.assertEqual(node_info[5]["fieldValue"], "1024")

    @patch("create_video.calculate_image_width", return_value={"width": 576, "height": 1024})
    def test_current_203101_app_uses_digital_human_nodes(self, _mock_size):
        node_info = create_video._build_node_info_list(
            app_id="2031016553440878594",
            image_url="image.png",
            audio_url="audio.mp3",
            duration_seconds=15,
            prompt_text="提示词",
            camera_video_url="camera.mp4",
        )

        self.assertEqual([item["nodeId"] for item in node_info], ["42", "17", "248", "7", "33", "34"])

    def test_default_196802_app_keeps_legacy_nodes(self):
        node_info = create_video._build_node_info_list(
            app_id="1968024407312596994",
            image_url="image.png",
            audio_url="audio.mp3",
            duration_seconds=15,
            prompt_text="提示词",
            camera_video_url="camera.mp4",
        )

        self.assertEqual([item["nodeId"] for item in node_info], ["48", "49", "57", "32", "53"])


if __name__ == "__main__":
    unittest.main()
