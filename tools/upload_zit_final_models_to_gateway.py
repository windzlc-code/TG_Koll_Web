from __future__ import annotations

import base64
import hashlib
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_CONFIG = REPO_ROOT / "webapp_data" / "runtime_config.json"
DEFAULT_GATEWAY_URL = "http://47.243.99.2/gpu"
LOCAL_MODEL_ROOT = Path(r"F:\ComfyUI\ComfyUI_official\models")
CHUNK_SIZE = 32 * 1024 * 1024

FILES = [
    ("diffusion_models", "moodyRealMix_zitV6DPO.safetensors"),
    ("upscale_models", "4xNomosWebPhoto_RealPLKSR.pth"),
    ("upscale_models", "1xSkinContrast-High-SuperUltraCompact.pth"),
    ("loras", r"fix\zit_fdpo_v1.safetensors"),
    ("loras", r"fix\zit_sda_v1.safetensors"),
    ("loras", r"Z-Image\b3tternud3s_v3.safetensors"),
    ("loras", r"Z-Image\Z-ImageTubro big-nipples.safetensors"),
    ("loras", r"Z-Image\Z-ImageTubro pussy-zimage-v1.safetensors"),
    ("loras", r"Character Setting\人设1捞女1金君雅.safetensors"),
]


def _load_runtime_config() -> dict[str, Any]:
    if not RUNTIME_CONFIG.exists():
        return {}
    return json.loads(RUNTIME_CONFIG.read_text(encoding="utf-8-sig"))


def _request(base_url: str, token: str, endpoint: str, body: Any) -> Any:
    data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        base_url.rstrip("/") + endpoint,
        data=data,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw else None


def _check_remote_models(base_url: str, token: str) -> dict[tuple[str, str], dict[str, Any]]:
    items = [{"category": category, "path": rel} for category, rel in FILES]
    response = _request(base_url, token, "/api/models/check", {"items": items})
    rows = response.get("items", []) if isinstance(response, dict) else []
    return {(str(row.get("category")), str(row.get("path"))): row for row in rows if isinstance(row, dict)}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(16 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _upload_one(base_url: str, token: str, category: str, rel: str, remote: dict[str, Any] | None) -> None:
    local_path = LOCAL_MODEL_ROOT / category / rel
    if not local_path.exists():
        raise FileNotFoundError(str(local_path))
    total = local_path.stat().st_size
    remote_size = int((remote or {}).get("bytes") or 0)
    if remote_size == total:
        print(f"跳过已存在: {category}/{rel} ({total / 1024 / 1024:.1f} MB)")
        return
    if remote_size > total:
        print(f"远端文件比本地大，重新上传: {category}/{rel}")
        remote_size = 0
    elif remote_size > 0:
        print(f"续传: {category}/{rel} from {remote_size / 1024 / 1024:.1f} MB")
    sha = _sha256_file(local_path)
    offset = remote_size
    started = time.time()
    with local_path.open("rb") as handle:
        handle.seek(offset)
        while True:
            chunk = handle.read(CHUNK_SIZE)
            if not chunk:
                break
            body = {
                "category": category,
                "path": rel,
                "offset": offset,
                "total": total,
                "content_b64": base64.b64encode(chunk).decode("ascii"),
            }
            if offset + len(chunk) == total:
                body["sha256"] = sha
            result = _request(base_url, token, "/api/models/upload_chunk", body)
            offset += len(chunk)
            mb_done = offset / 1024 / 1024
            mb_total = total / 1024 / 1024
            elapsed = max(time.time() - started, 0.1)
            speed = mb_done / elapsed
            print(f"{category}/{rel}: {mb_done:.1f}/{mb_total:.1f} MB, {speed:.1f} MB/s")
            if result.get("complete"):
                print(f"完成: {category}/{rel}")


def main() -> int:
    cfg = _load_runtime_config()
    token = str(cfg.get("remote_comfy_gateway_token") or "").strip()
    base_url = str(cfg.get("remote_comfy_gateway_url") or DEFAULT_GATEWAY_URL).strip().rstrip("/")
    if not token:
        print("remote gateway token is missing in runtime_config.json")
        return 2
    remote_models = _check_remote_models(base_url, token)
    for category, rel in FILES:
        _upload_one(base_url, token, category, rel, remote_models.get((category, rel)))
    print("所有 ZIT_final 缺失模型上传完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
