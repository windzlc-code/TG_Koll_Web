import json
import os
from typing import Any

import requests


def upload_file(
    *,
    server_ip: str,
    server_port: int,
    local_path: str,
    remote_path: str,
    timeout_seconds: int = 20,
) -> dict[str, Any]:
    if not str(server_ip).strip():
        raise ValueError("server_ip 不能为空")
    if not int(server_port):
        raise ValueError("server_port 不能为空")
    if not str(local_path).strip():
        raise ValueError("local_path 不能为空")
    if not str(remote_path).strip():
        raise ValueError("remote_path 不能为空")
    if not os.path.exists(local_path):
        return {"statu": "failed", "path": "", "error": "file_not_found"}

    url = f"http://{server_ip}:{int(server_port)}/upload"
    result: dict[str, Any] = {"statu": "failed", "path": ""}

    try:
        with open(local_path, "rb") as f:
            files = {"file": f}
            data = {"target_path": remote_path}
            response = requests.post(url, files=files, data=data, timeout=int(timeout_seconds))

        if response.status_code == 200:
            result["statu"] = "success"
            result["path"] = f"http://{server_ip}:{int(server_port)}/{remote_path}"
        else:
            result["statu"] = f"failed_{response.status_code}"
            result["error"] = response.text[:300]

    except requests.exceptions.ConnectionError:
        result["statu"] = "failed_connection"
    except requests.exceptions.Timeout:
        result["statu"] = "failed_timeout"
    except Exception as exc:
        result["statu"] = f"failed_{type(exc).__name__}"
        result["error"] = str(exc)

    print(json.dumps(result, ensure_ascii=False))
    return result

