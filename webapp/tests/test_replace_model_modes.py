import unittest

import replace_model


class ReplaceModelModeTests(unittest.TestCase):
    def test_primary_mode_uses_width_height_nodes(self):
        nodes = replace_model._build_node_info_list(
            mode="primary",
            app_id=replace_model.PRIMARY_APP_ID,
            video_path="video.mp4",
            image_path="image.png",
            prompt="ignored",
            width=1280,
            height=720,
            frame=30,
            duration_seconds=10,
            start_seconds=0,
        )
        self.assertEqual([node["nodeId"] for node in nodes], ["55", "60", "43", "49"])
        self.assertEqual(nodes[2]["fieldValue"], "1280")
        self.assertEqual(nodes[3]["fieldValue"], "720")

    def test_slice_mode_uses_prompt_duration_start_nodes(self):
        nodes = replace_model._build_node_info_list(
            mode="slice",
            app_id=replace_model.SLICE_APP_ID,
            video_path="video.mp4",
            image_path="image.png",
            prompt="一个女人夜晚在路上",
            width=576,
            height=1024,
            frame=30,
            duration_seconds=5,
            start_seconds=2,
        )
        self.assertEqual([node["nodeId"] for node in nodes], ["352", "318", "284", "339", "341"])
        self.assertEqual(nodes[2]["fieldValue"], "一个女人夜晚在路上")
        self.assertEqual(nodes[3]["fieldValue"], "5")
        self.assertEqual(nodes[4]["fieldValue"], "2")

    def test_unknown_mode_falls_back_to_original(self):
        nodes = replace_model._build_node_info_list(
            mode="unknown",
            app_id=replace_model.DEFAULT_APP_ID,
            video_path="video.mp4",
            image_path="image.png",
            prompt="原版提示词",
            width=576,
            height=1024,
            frame=30,
            duration_seconds=10,
            start_seconds=0,
        )
        self.assertEqual(nodes[0]["nodeId"], "172")
        self.assertEqual(nodes[-1]["fieldValue"], "原版提示词")


if __name__ == "__main__":
    unittest.main()
