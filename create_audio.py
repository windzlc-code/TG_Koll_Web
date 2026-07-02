import os
import requests
import time
from typing import Any
import json

from runninghub_common import rh_get, rh_post
from runtime_config_bootstrap import load_runtime_config

config = load_runtime_config()
DEFAULT_APP_ID = str(config.get("create_audio_app_id") or "1965684535247650818")


def download_audio(url, filename):
    response = rh_get(url)
    if response.status_code == 200:
        with open(filename, "wb") as f:
            f.write(response.content)
        print(f"Downloaded {filename}")
    else:
        print(f"Failed to download {filename}")

def _safe_preview(value: Any, limit: int = 600) -> str:
    try:
        import json

        text = json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)
    text = text.replace("\n", " ").replace("\r", " ")
    return text[: max(int(limit), 50)]


def _is_queue_limit_error(result: Any) -> bool:
    if not isinstance(result, dict):
        return False
    code = str(result.get("code") or "").strip()
    err_code = str(result.get("errorCode") or "").strip()
    msg = str(result.get("msg") or result.get("errorMessage") or result.get("message") or "").lower()
    if code in {"421", "429"} or err_code in {"421", "429"}:
        return True
    return ("limit reached" in msg) or ("并发" in msg) or ("retry later" in msg) or ("queue limit" in msg)


def submit_audio_task(
    *,
    api_key: str,
    word: str,
    emotion: str,
    language: str,
    model_choice: str = "1.7B",
    speaker: str = "Ryan",
    app_id: str | None = None,
    max_retries: int = 12,
    base_sleep_seconds: float = 2.0,
    logger=None,
) -> dict[str, Any]:
    app_id_text = str(app_id or "").strip() or DEFAULT_APP_ID
    url = f"https://www.runninghub.cn/openapi/v2/run/ai-app/{app_id_text}"
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    data = {
        "nodeInfoList": [
            {"nodeId": "1", "fieldName": "text", "fieldValue": f"{word}", "description": "text"},
            {"nodeId": "2", "fieldName": "text", "fieldValue": f"{emotion}", "description": "text"},
            {
                "nodeId": "6",
                "fieldName": "language",
                "fieldData": "[[\"Auto\", \"Chinese\", \"English\", \"Japanese\", \"Korean\", \"French\", \"German\", \"Spanish\", \"Portuguese\", \"Russian\", \"Italian\"], {\"default\": \"Auto\"}]",
                "fieldValue": f"{language}",
                "description": "language",
            },
            {
                "nodeId": "6",
                "fieldName": "model_choice",
                "fieldData": "[[\"0.6B\", \"1.7B\"], {\"default\": \"1.7B\"}]",
                "fieldValue": f"{model_choice}",
                "description": "model_choice",
            },
            {
                "nodeId": "6",
                "fieldName": "speaker",
                "fieldData": "[[\"Aiden\", \"Dylan\", \"Eric\", \"Ono_anna\", \"Ryan\", \"Serena\", \"Sohee\", \"Uncle_fu\", \"Vivian\", \"zhenzhen\"], {\"default\": \"Ryan\"}]",
                "fieldValue": f"{speaker}",
                "description": "speaker",
            },
        ],
        "instanceType": "default",
        "usePersonalQueue": False,
    }

    attempts = max(int(max_retries or 0), 0) + 1
    last: dict[str, Any] = {}
    for i in range(attempts):
        try:
            resp = rh_post(url, headers=headers, json=data)
            status_code = int(getattr(resp, "status_code", 0) or 0)
            try:
                result = resp.json()
            except Exception:
                result = {"status": "", "taskId": "", "message": str(getattr(resp, "text", "") or "")[:600]}
            last = result if isinstance(result, dict) else {"raw": result}

            task_id = str(last.get("taskId") or last.get("task_id") or last.get("task id") or "").strip()
            status = str(last.get("status") or "").strip().upper()
            if task_id and (status in {"SUCCESS", "RUNNING", "QUEUED"} or not status):
                return {"ok": True, "task_id": task_id, "status": status or "RUNNING", "raw": last, "http_status": status_code}

            if i < attempts - 1 and _is_queue_limit_error(last):
                sleep_s = min(float(base_sleep_seconds) * (1.35**i), 30.0)
                if logger:
                    try:
                        logger(f"RunningHub 音频任务触发并发限制，等待 {sleep_s:.1f}s 后重试（{i+1}/{attempts-1}）")
                    except Exception:
                        pass
                time.sleep(max(sleep_s, 0.5))
                continue

            msg = str(last.get("errorMessage") or last.get("msg") or last.get("message") or "").strip()
            if not msg:
                msg = f"提交音频任务失败：未返回 taskId（http={status_code}） preview={_safe_preview(last)}"
            return {"ok": False, "task_id": "", "status": status or "FAILED", "message": msg, "raw": last, "http_status": status_code}
        except Exception as exc:
            if i < attempts - 1:
                sleep_s = min(float(base_sleep_seconds) * (1.35**i), 30.0)
                if logger:
                    try:
                        logger(f"提交音频任务异常：{exc}，等待 {sleep_s:.1f}s 后重试（{i+1}/{attempts-1}）")
                    except Exception:
                        pass
                time.sleep(max(sleep_s, 0.5))
                continue
            return {"ok": False, "task_id": "", "status": "FAILED", "message": str(exc), "raw": last}

    return {"ok": False, "task_id": "", "status": "FAILED", "message": f"提交音频任务失败：{_safe_preview(last)}", "raw": last}


def create_audios(api_key, word, emotion, language, model_choice="1.7B", speaker="Ryan", app_id=None):

    out = submit_audio_task(
        api_key=str(api_key or "").strip(),
        word=str(word or ""),
        emotion=str(emotion or ""),
        language=str(language or ""),
        model_choice=str(model_choice or "1.7B"),
        speaker=str(speaker or "Ryan"),
        app_id=str(app_id or "").strip() or DEFAULT_APP_ID,
    )
    if out.get("ok"):
        return str(out.get("task_id") or "")
    print(str(out.get("message") or "音频任务提交失败"))
    return None

def query_task_status(api_key, task_id):
    url = "https://www.runninghub.cn/openapi/v2/query"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }
    data = {
        "taskId": task_id
    }
    response = rh_post(url, headers=headers, json=data)
    result = response.json()
    return result

def requests_audio_api(
        api_key,
        word,
        emotion,
        language,
        model_choice="1.7B",
        speaker="Ryan",
        output_file=None
    ):
    create_task_id = create_audios(api_key, word, emotion, language, model_choice, speaker)

    last_status = None
    while True:
        task_progress = query_task_status(api_key, create_task_id)
        current_status = task_progress.get("status")
        
        if current_status == "SUCCESS":
            print("[*] 任务完成")
            url = task_progress.get("results")[0]["url"]
            audio_path = f"{output_file}/{word}_{emotion}.mp3"
            download_audio(url, audio_path)
            print(f"音频文件已保存至: {audio_path}")
            return audio_path
        elif current_status == "FAILED":
            print("[*] 任务失败")
            print(f"[*] 错误码：{task_progress['errorCode']}")
            print(f"[*] 错误信息：{task_progress['errorMessage']}")
            print(f"[*] 完整信息：{task_progress}")
            break
        elif current_status == "QUEUED":
            if last_status != "QUEUED":
                print("[*] 任务排队中")
        elif current_status == "RUNNING":
            if last_status != "RUNNING":
                print("[*] 运行中")
        
        last_status = current_status
        time.sleep(10)  # 每10秒查询一次状态

if __name__ == "__main__":
    api_key = os.getenv("RUNNINGHUB_API_KEY", "")
    if not api_key:
        raise RuntimeError("请先设置 RUNNINGHUB_API_KEY 环境变量")
    word = "丢雷老母，这是一个真皮手工制作的包包，由法国艺术设计师，哈巴得拉哈拉嘛黑精心设计，其借鉴了罗密欧与朱丽叶的故事背景而设计"
    emotion = "happy"
    language = "Chinese"
    model_choice = "1.7B"
    speaker = "Ryan"
    output_file = "audio"
    requests_audio_api(api_key, word, emotion, language, model_choice, speaker, output_file)
