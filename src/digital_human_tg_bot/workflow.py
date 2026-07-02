from __future__ import annotations

import shutil
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .config import AppConfig
from .media import extract_audio_track, get_audio_duration_seconds
from .runninghub import RunningHubClient, WorkflowCancelledError


@dataclass(frozen=True)
class WorkflowRequest:
    source_video_path: Path
    avatar_image_path: Path
    script_text: str
    work_dir: Path
    target_duration_seconds: int | None = None
    publish_to_default_paths: bool = False


@dataclass(frozen=True)
class WorkflowRunResult:
    script_text: str
    source_video_path: Path
    avatar_image_path: Path
    extracted_audio_path: Path
    cloned_audio_path: Path
    final_video_path: Path
    cloned_audio_duration_seconds: int
    video_duration_seconds: int
    audio_task_id: str
    video_task_id: str


class DigitalHumanWorkflowRunner:
    def __init__(self, config: AppConfig, *, cancellation_check: Callable[[], None] | None = None) -> None:
        self.config = config
        self.cancellation_check = cancellation_check
        self.client = RunningHubClient(config.runninghub_api_key, cancellation_check=cancellation_check)

    def build_default_request(self, script_text: str) -> WorkflowRequest:
        script = str(script_text or "").strip() or self.config.default_script_text
        return WorkflowRequest(
            source_video_path=self.config.source_video_path,
            avatar_image_path=self.config.avatar_image_path,
            script_text=script,
            work_dir=self.config.jobs_dir / "default_flow",
            publish_to_default_paths=True,
        )

    def run(self, script_text: str, progress_callback=None) -> WorkflowRunResult:
        return self.run_request(self.build_default_request(script_text), progress_callback=progress_callback)

    def run_request(self, request: WorkflowRequest, progress_callback=None) -> WorkflowRunResult:
        self._check_cancelled()
        self._validate_request(request)

        extracted_audio_path = request.work_dir / "extracted_audio.mp4"
        cloned_audio_path = request.work_dir / "cloned_voice.flac"
        final_video_path = request.work_dir / "digital_human.mp4"

        self._progress(progress_callback, "開始執行工作流")
        self._progress(progress_callback, f"來源視頻: {request.source_video_path}")

        extracted_audio = extract_audio_track(request.source_video_path, extracted_audio_path)
        self._check_cancelled()
        self._progress(progress_callback, f"已完成音頻擷取: {extracted_audio}")

        audio_task_id = self._clone_voice(
            reference_audio_path=extracted_audio,
            script_text=request.script_text,
            output_audio_path=cloned_audio_path,
            progress_callback=progress_callback,
        )

        cloned_audio_duration_seconds = get_audio_duration_seconds(cloned_audio_path)
        self._check_cancelled()
        self._progress(progress_callback, f"克隆音頻時長: {cloned_audio_duration_seconds} 秒")

        if request.target_duration_seconds is None:
            video_duration_seconds = cloned_audio_duration_seconds
        else:
            video_duration_seconds = max(int(request.target_duration_seconds), 1)
        self._progress(progress_callback, f"最終視頻時長: {video_duration_seconds} 秒")

        video_task_id = self._create_digital_human_video(
            image_path=request.avatar_image_path,
            audio_path=cloned_audio_path,
            duration_seconds=video_duration_seconds,
            output_video_path=final_video_path,
            progress_callback=progress_callback,
        )
        self._check_cancelled()

        result = WorkflowRunResult(
            script_text=request.script_text,
            source_video_path=request.source_video_path,
            avatar_image_path=request.avatar_image_path,
            extracted_audio_path=extracted_audio,
            cloned_audio_path=cloned_audio_path,
            final_video_path=final_video_path,
            cloned_audio_duration_seconds=cloned_audio_duration_seconds,
            video_duration_seconds=video_duration_seconds,
            audio_task_id=audio_task_id,
            video_task_id=video_task_id,
        )

        if request.publish_to_default_paths:
            self._check_cancelled()
            self._publish_default_outputs(result)

        self._check_cancelled()
        self._progress(progress_callback, f"工作流完成，成品已輸出: {result.final_video_path}")
        return result

    def _clone_voice(
        self,
        *,
        reference_audio_path: Path,
        script_text: str,
        output_audio_path: Path,
        progress_callback=None,
    ) -> str:
        self._progress(progress_callback, "正在上傳參考音頻")
        uploaded_audio = self.client.upload_binary(reference_audio_path)
        self._progress(progress_callback, f"參考音頻已上傳: {uploaded_audio.filename}")

        node_info_list = [
            {
                "nodeId": "4",
                "fieldName": "audio",
                "fieldValue": uploaded_audio.filename,
                "description": "reference_audio",
            },
            {
                "nodeId": "7",
                "fieldName": "text",
                "fieldValue": script_text,
                "description": "script_text",
            },
        ]

        task_id = self.client.submit_ai_app_task(
            self.config.audio_workflow_id,
            node_info_list,
            progress_callback=progress_callback,
        )
        self._progress(progress_callback, f"語音克隆任務已提交: {task_id}")

        result = self.client.wait_for_task(
            task_id,
            poll_interval_seconds=self.config.poll_interval_seconds,
            progress_callback=progress_callback,
        )
        self.client.download_first_result(
            result,
            output_audio_path,
            preferred_output_types={"flac", "wav", "mp3", "m4a", "aac", "ogg"},
        )
        self._progress(progress_callback, f"已取得克隆音頻: {output_audio_path}")
        return task_id

    def _create_digital_human_video(
        self,
        *,
        image_path: Path,
        audio_path: Path,
        duration_seconds: int,
        output_video_path: Path,
        progress_callback=None,
    ) -> str:
        self._progress(progress_callback, "正在上傳照片與克隆音頻")
        uploaded_image = self.client.upload_binary(image_path)
        uploaded_audio = self.client.upload_binary(audio_path)
        self._progress(progress_callback, f"數字人視頻時長設定: {duration_seconds} 秒")

        workflow_id = str(self.config.video_workflow_id or "").strip()
        if workflow_id in {"2018758760096862209", "2031016553440878594"}:
            width, height = self._normalize_video_dimensions(*self._read_image_size(image_path))
            self._progress(progress_callback, f"數字人視頻尺寸設定: {width}x{height}")
            node_info_list = [
                {
                    "nodeId": "42",
                    "fieldName": "image",
                    "fieldValue": uploaded_image.filename,
                    "description": "avatar_image",
                },
                {
                    "nodeId": "17",
                    "fieldName": "audio",
                    "fieldValue": uploaded_audio.filename,
                    "description": "cloned_audio",
                },
                {
                    "nodeId": "248",
                    "fieldName": "value",
                    "fieldValue": str(duration_seconds),
                    "description": "video_duration_seconds",
                },
                {
                    "nodeId": "7",
                    "fieldName": "text",
                    "fieldValue": "",
                    "description": "motion_prompt",
                },
                {
                    "nodeId": "33",
                    "fieldName": "value",
                    "fieldValue": str(width),
                    "description": "video_width",
                },
                {
                    "nodeId": "34",
                    "fieldName": "value",
                    "fieldValue": str(height),
                    "description": "video_height",
                },
            ]
        else:
            node_info_list = [
                {
                    "nodeId": "133",
                    "fieldName": "image",
                    "fieldValue": uploaded_image.filename,
                    "description": "avatar_image",
                },
                {
                    "nodeId": "218",
                    "fieldName": "audio",
                    "fieldValue": uploaded_audio.filename,
                    "description": "cloned_audio",
                },
                {
                    "nodeId": "230",
                    "fieldName": "value",
                    "fieldValue": "0",
                    "description": "audio_start_seconds",
                },
                {
                    "nodeId": "231",
                    "fieldName": "value",
                    "fieldValue": str(duration_seconds),
                    "description": "audio_end_seconds",
                },
            ]

        task_id = self.client.submit_ai_app_task(
            workflow_id,
            node_info_list,
            progress_callback=progress_callback,
        )
        self._progress(progress_callback, f"數字人任務已提交: {task_id}")

        result = self.client.wait_for_task(
            task_id,
            poll_interval_seconds=self.config.poll_interval_seconds,
            progress_callback=progress_callback,
        )
        self.client.download_first_result(
            result,
            output_video_path,
            preferred_output_types={"mp4", "mov", "avi", "mkv", "webm"},
        )
        self._progress(progress_callback, f"已取得數字人成品視頻: {output_video_path}")
        return task_id

    @staticmethod
    def _read_image_size(path: Path) -> tuple[int | None, int | None]:
        try:
            data = path.read_bytes()
        except OSError:
            return None, None
        if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
            width, height = struct.unpack('>II', data[16:24])
            return int(width), int(height)
        if data[:2] == b"\xff\xd8":
            index = 2
            while index < len(data):
                while index < len(data) and data[index] == 0xFF:
                    index += 1
                if index >= len(data):
                    break
                marker = data[index]
                index += 1
                if marker in {0xD8, 0xD9} or 0xD0 <= marker <= 0xD7:
                    continue
                if index + 2 > len(data):
                    break
                segment_length = struct.unpack('>H', data[index:index + 2])[0]
                if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                    if index + 7 <= len(data):
                        height, width = struct.unpack('>HH', data[index + 3:index + 7])
                        return int(width), int(height)
                    break
                index += segment_length
            return None, None
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 30 and data[12:16] == b"VP8X":
            width = 1 + int.from_bytes(data[24:27], 'little')
            height = 1 + int.from_bytes(data[27:30], 'little')
            return int(width), int(height)
        return None, None

    @staticmethod
    def _normalize_video_dimensions(width: int | None, height: int | None) -> tuple[int, int]:
        safe_width = 576
        safe_height = 1024
        try:
            width_value = int(width or 0)
        except (TypeError, ValueError):
            width_value = 0
        try:
            height_value = int(height or 0)
        except (TypeError, ValueError):
            height_value = 0
        if width_value <= 0 or height_value <= 0:
            return safe_width, safe_height
        if width_value <= safe_width and height_value <= safe_height:
            return width_value, height_value
        return safe_width, safe_height

    def _validate_request(self, request: WorkflowRequest) -> None:
        if not str(request.script_text or "").strip():
            raise RuntimeError("文案內容不能為空")

        for path in (request.source_video_path, request.avatar_image_path):
            if not path.exists():
                raise FileNotFoundError(f"找不到檔案: {path}")

        request.work_dir.mkdir(parents=True, exist_ok=True)

    def _publish_default_outputs(self, result: WorkflowRunResult) -> None:
        self.config.extracted_audio_path.parent.mkdir(parents=True, exist_ok=True)
        self.config.cloned_audio_path.parent.mkdir(parents=True, exist_ok=True)
        self.config.final_video_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(result.extracted_audio_path, self.config.extracted_audio_path)
        shutil.copy2(result.cloned_audio_path, self.config.cloned_audio_path)
        shutil.copy2(result.final_video_path, self.config.final_video_path)

    @staticmethod
    def _progress(callback, message: str) -> None:
        if callback is not None:
            callback(message)

    def _check_cancelled(self) -> None:
        if self.cancellation_check is not None:
            self.cancellation_check()
