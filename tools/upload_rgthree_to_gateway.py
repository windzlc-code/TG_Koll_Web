from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_CONFIG = REPO_ROOT / "webapp_data" / "runtime_config.json"
DEFAULT_GATEWAY_URL = "http://47.243.99.2/gpu"
DEFAULT_SOURCE = Path(r"F:\ComfyUI_Data\custom_nodes\rgthree-comfy")
PACKAGE_NAME = "rgthree-comfy"
CHUNK_SIZE = 4 * 1024 * 1024
SKIP_DIRS = {".git", "__pycache__", ".pytest_cache", "node_modules"}

ZIT_COMPAT = """ANY = "*"


class RgthreeFastBypasserCompat:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "LoRA加载器（仅模型）": (ANY,),
                "Detailer (SEGS)": (ANY,),
                "使用模型放大图像": (ANY,),
                "input": (ANY,),
            }
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("OPT_CONNECTION",)
    FUNCTION = "passthrough"
    CATEGORY = "ZIT/compat"

    def passthrough(self, **kwargs):
        for value in kwargs.values():
            if value is not None:
                return (value,)
        return (None,)


class RgthreeFastGroupsBypasserCompat:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "input_1": (ANY,),
                "input_2": (ANY,),
                "input_3": (ANY,),
                "input_4": (ANY,),
                "input_5": (ANY,),
            }
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("OPT_CONNECTION",)
    FUNCTION = "passthrough"
    CATEGORY = "ZIT/compat"

    def passthrough(self, **kwargs):
        for value in kwargs.values():
            if value is not None:
                return (value,)
        return (None,)


class NoteCompat:
    @classmethod
    def INPUT_TYPES(cls):
        return {"optional": {"text": ("STRING", {"multiline": True, "default": ""})}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "ZIT/compat"

    def noop(self, **kwargs):
        return ()


class MarkdownNoteCompat(NoteCompat):
    pass


NODE_CLASS_MAPPINGS = {
    "Fast Bypasser (rgthree)": RgthreeFastBypasserCompat,
    "Fast Groups Bypasser (rgthree)": RgthreeFastGroupsBypasserCompat,
    "Note": NoteCompat,
    "MarkdownNote": MarkdownNoteCompat,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Fast Bypasser (rgthree)": "Fast Bypasser (rgthree)",
    "Fast Groups Bypasser (rgthree)": "Fast Groups Bypasser (rgthree)",
    "Note": "Note",
    "MarkdownNote": "MarkdownNote",
}
"""


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


def _sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _iter_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        files.append(path)
    return sorted(files)


def _check_remote(base_url: str, token: str, items: list[dict[str, str]]) -> dict[tuple[str, str], dict[str, Any]]:
    rows: dict[tuple[str, str], dict[str, Any]] = {}
    for i in range(0, len(items), 200):
        response = _request(base_url, token, "/api/custom_nodes/check", {"items": items[i : i + 200]})
        for row in response.get("items", []) if isinstance(response, dict) else []:
            if isinstance(row, dict):
                rows[(str(row.get("package")), str(row.get("path")))] = row
    return rows


def _upload_bytes(base_url: str, token: str, package: str, rel: str, raw: bytes, sha: str) -> None:
    total = len(raw)
    offset = 0
    while offset < total or (total == 0 and offset == 0):
        chunk = raw[offset : offset + CHUNK_SIZE] if total else b""
        next_offset = offset + len(chunk)
        body = {
            "package": package,
            "path": rel,
            "offset": offset,
            "total": total,
            "content_b64": base64.b64encode(chunk).decode("ascii"),
        }
        if next_offset == total:
            body["sha256"] = sha
        result = _request(base_url, token, "/api/custom_nodes/upload_chunk", body)
        if result.get("complete"):
            return
        offset = next_offset
    if total == 0:
        return


def _upload_file(base_url: str, token: str, source_root: Path, path: Path, remote: dict[str, Any] | None) -> str:
    rel = path.relative_to(source_root).as_posix()
    total = path.stat().st_size
    sha = _sha256_file(path)
    if remote and remote.get("exists") and remote.get("bytes") == total and remote.get("sha256") == sha:
        return f"skip {rel}"

    offset = 0
    started = time.time()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(CHUNK_SIZE)
            if not chunk:
                break
            next_offset = offset + len(chunk)
            body = {
                "package": PACKAGE_NAME,
                "path": rel,
                "offset": offset,
                "total": total,
                "content_b64": base64.b64encode(chunk).decode("ascii"),
            }
            if next_offset == total:
                body["sha256"] = sha
            _request(base_url, token, "/api/custom_nodes/upload_chunk", body)
            offset = next_offset
    elapsed = max(time.time() - started, 0.1)
    return f"upload {rel} ({total / 1024:.1f} KB, {total / 1024 / elapsed:.1f} KB/s)"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=str(DEFAULT_SOURCE), help="Local rgthree-comfy directory")
    parser.add_argument("--delete-first", action="store_true", help="Delete remote rgthree-comfy before upload")
    args = parser.parse_args()

    source_root = Path(args.source)
    if not source_root.exists():
        print(f"source directory not found: {source_root}", file=sys.stderr)
        return 2

    cfg = _load_runtime_config()
    token = str(cfg.get("remote_comfy_gateway_token") or "").strip()
    base_url = str(cfg.get("remote_comfy_gateway_url") or DEFAULT_GATEWAY_URL).strip().rstrip("/")
    if not token:
        print("remote gateway token is missing in runtime_config.json", file=sys.stderr)
        return 2

    if args.delete_first:
        print("Deleting remote rgthree-comfy package...")
        _request(base_url, token, "/api/custom_nodes/delete", {"package": PACKAGE_NAME})

    files = _iter_files(source_root)
    items = [{"package": PACKAGE_NAME, "path": p.relative_to(source_root).as_posix(), "sha256": "1"} for p in files]
    remote = _check_remote(base_url, token, items)
    print(f"Uploading {len(files)} rgthree-comfy files to {base_url}")
    for index, path in enumerate(files, 1):
        rel = path.relative_to(source_root).as_posix()
        message = _upload_file(base_url, token, source_root, path, remote.get((PACKAGE_NAME, rel)))
        print(f"[{index}/{len(files)}] {message}")

    print("Uploading ZIT compatibility nodes for missing rgthree bypasser classes and notes...")
    raw = ZIT_COMPAT.encode("utf-8")
    _upload_bytes(
        base_url,
        token,
        "zit_workflow_compat",
        "__init__.py",
        raw,
        _sha256_bytes(raw),
    )
    print("Done. Restart remote ComfyUI to load the real rgthree frontend nodes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
