from pathlib import Path
import shutil
import subprocess


CONSOLE_JS = Path(__file__).resolve().parents[1] / "static" / "assets" / "console.js"


def test_cancelled_tasks_do_not_render_screenshot_results():
    source = CONSOLE_JS.read_text(encoding="utf-8")

    assert 'presentationStatus === "cancelled" ? "" : latestSocialTaskScreenshot(task, logs)' in source
    assert '["cancelled", "canceled"].includes(String(task?.status || "").trim().toLowerCase())' in source
    assert 'hideScreenshots: presentationStatus === "cancelled"' in source


def test_cancelled_task_screenshot_collection_returns_empty():
    node = shutil.which("node")
    assert node, "node is required for the console behavior test"
    source = CONSOLE_JS.read_text(encoding="utf-8")
    start = source.index("function collectTaskScreenshots")
    end = source.index("\nfunction renderTaskScreenshotGallery", start)
    function_source = source[start:end]
    harness = f"""
const assert = require("node:assert/strict");
{function_source}
const rows = collectTaskScreenshots({{ status: "cancelled" }}, [{{
  stage: "manual_screenshot",
  screenshot_url: "/screenshots/cancelled-task.png",
}}]);
assert.deepEqual(rows, []);
"""
    result = subprocess.run(
        [node, "-e", harness],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
