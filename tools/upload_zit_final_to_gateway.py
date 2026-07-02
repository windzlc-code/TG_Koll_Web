from __future__ import annotations

import base64
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_CONFIG = REPO_ROOT / "webapp_data" / "runtime_config.json"
DEFAULT_GATEWAY_URL = "http://47.243.99.2/gpu"
DEFAULT_WORKFLOW = Path(r"F:\ComfyUI\ComfyUI_official\user\default\workflows\ZIT_final.json")

REQUIRED_MODELS = [
    {"category": "diffusion_models", "path": "moodyRealMix_zitV6DPO.safetensors"},
    {"category": "diffusion_models", "path": "z_image_turbo_bf16.safetensors"},
    {"category": "text_encoders", "path": "qwen_3_4b.safetensors"},
    {"category": "vae", "path": "ae.safetensors"},
    {"category": "loras", "path": r"fix\zit_fdpo_v1.safetensors"},
    {"category": "loras", "path": r"Z-Image\b3tternud3s_v3.safetensors"},
    {"category": "loras", "path": r"Z-Image\Z-ImageTubro big-nipples.safetensors"},
    {"category": "loras", "path": r"Z-Image\Z-ImageTubro pussy-zimage-v1.safetensors"},
    {"category": "loras", "path": r"Character Setting\人设1捞女1金君雅.safetensors"},
    {"category": "SEEDVR2", "path": "seedvr2_ema_7b-Q4_K_M.gguf"},
    {"category": "SEEDVR2", "path": "ema_vae_fp16.safetensors"},
    {"category": "ultralytics", "path": r"bbox\face_yolov8m.pt"},
    {"category": "upscale_models", "path": "4xNomosWebPhoto_RealPLKSR.pth"},
    {"category": "upscale_models", "path": "1xSkinContrast-High-SuperUltraCompact.pth"},
]


def _load_runtime_config() -> dict[str, Any]:
    if not RUNTIME_CONFIG.exists():
        return {}
    return json.loads(RUNTIME_CONFIG.read_text(encoding="utf-8-sig"))


def _request(base_url: str, token: str, method: str, endpoint: str, body: Any | None = None) -> Any:
    data = None
    headers = {"Authorization": f"Bearer {token}"}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base_url.rstrip("/") + endpoint, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw else None


def main() -> int:
    cfg = _load_runtime_config()
    token = str(cfg.get("remote_comfy_gateway_token") or "").strip()
    base_url = str(cfg.get("remote_comfy_gateway_url") or DEFAULT_GATEWAY_URL).strip().rstrip("/")
    workflow = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_WORKFLOW
    if not token:
        print("remote gateway token is missing in runtime_config.json", file=sys.stderr)
        return 2
    if not workflow.exists():
        print(f"workflow not found: {workflow}", file=sys.stderr)
        return 2

    raw = workflow.read_bytes()
    sha = hashlib.sha256(raw).hexdigest()

    print(f"Gateway: {base_url}")
    print(f"Workflow: {workflow}")
    print("Checking health...")
    health = _request(base_url, token, "GET", "/api/health")
    system = health.get("system") if isinstance(health, dict) else {}
    print(f"ComfyUI: {system.get('comfyui_version', 'unknown')}")

    print("Uploading UI workflow...")
    upload = _request(
        base_url,
        token,
        "POST",
        "/api/workflows/upload",
        {
            "root": "user",
            "path": "ZIT_final.json",
            "content_b64": base64.b64encode(raw).decode("ascii"),
            "sha256": sha,
        },
    )
    print(json.dumps(upload, ensure_ascii=False, indent=2))

    print("Checking required models...")
    model_check = _request(base_url, token, "POST", "/api/models/check", {"items": REQUIRED_MODELS})
    missing = [item for item in model_check.get("items", []) if not item.get("exists")]
    for item in model_check.get("items", []):
        status = "OK" if item.get("exists") else "MISSING"
        print(f"{status}\t{item.get('category')}/{item.get('path')}")

    print("Converting to API format...")
    converted = _request(
        base_url,
        token,
        "POST",
        "/api/workflows/convert",
        {"paths": ["ZIT_final.json"], "overwrite": True, "force": True},
    )
    print(json.dumps(converted, ensure_ascii=False, indent=2))

    if missing:
        print("Upload completed, but some models are missing. Install/copy them before running.", file=sys.stderr)
        return 1
    print("Upload, model check, and conversion completed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
