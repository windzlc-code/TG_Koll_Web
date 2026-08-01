from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONSOLE_JS = (ROOT / "webapp" / "static" / "assets" / "console.js").read_text(encoding="utf-8")

class ConsoleLogLocalizationTests(unittest.TestCase):
    def test_recent_raw_log_codes_have_chinese_labels(self):
        for stage, label in {
            "force_stop": "强制停止",
            "cancel": "任务取消",
            "publish_batch_item_started": "批次发布进度",
        }.items():
            self.assertIn(f'{stage}: "{label}"', CONSOLE_JS)

    def test_recent_english_messages_have_chinese_presentations(self):
        for text in (
            "任务已取消：用户主动取消。",
            "已打开后台浏览器页面进行无干扰检测。",
            "批次发布任务已开始。",
            "登录状态不稳定，正在进行第",
            "页面截图失败，系统将继续执行或按策略重试。",
            "暂未识别到登录后的页面，正在继续确认。",
        ):
            self.assertIn(text, CONSOLE_JS)

    def test_unknown_internal_stage_codes_are_not_exposed(self):
        self.assertNotIn('return map[key] || statusLabel(key) || "日志";', CONSOLE_JS)
        self.assertIn('return "执行步骤";', CONSOLE_JS)
        self.assertIn('"执行步骤未完成，系统将按当前策略继续处理或重试。"', CONSOLE_JS)
