from __future__ import annotations

import json
import os
import shutil
import time
import uuid
import hashlib
import base64
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


COMFY_ROOT = Path(os.getenv("COMFY_ROOT", r"D:\comfyui\ComfyUI_windows_portable\ComfyUI")).resolve()
PORTABLE_ROOT = COMFY_ROOT.parent
COMFY_URL = os.getenv("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
HOST = os.getenv("COMFY_GATEWAY_HOST", "0.0.0.0")
PORT = int(os.getenv("COMFY_GATEWAY_PORT", "9000"))
TOKEN = os.getenv("COMFY_GATEWAY_TOKEN", "").strip()
WORKFLOW_ROOTS = [
    ("user", (COMFY_ROOT / "user" / "default" / "workflows").resolve()),
    ("api", (PORTABLE_ROOT / "api_workflows").resolve()),
]
CONVERTER_VERSION = "2026-06-08.1"
CONVERTED_ROOT = WORKFLOW_ROOTS[1][1] / "__converted__"
CONVERT_MANIFEST_PATH = CONVERTED_ROOT / "manifest.json"
CUSTOM_NODES_ROOT = (COMFY_ROOT / "custom_nodes").resolve()
INPUT_ROOT = (COMFY_ROOT / "input").resolve()
FRONTEND_ONLY_CLASS_TYPES = {"Note", "MarkdownNote", "Fast Bypasser (rgthree)"}
UUID_CLASS_TYPE_ALIASES = {
    # ComfyUI frontend subgraph/proxy node ids used by FireRed image-edit workflows.
    # The frontend submits these as the concrete lrzjason node type to /prompt.
    "21448e4e-c19c-4be4-8b62-b4b760ae4387": "TextEncodeQwenImageEditPlusAdvance_lrzjason",
    "8bd4310c-a285-466b-b1d3-ffc7ed9c6241": "TextEncodeQwenImageEditPlusAdvance_lrzjason",
}
OUTPUT_CLASS_TYPES = {"SaveImage", "PreviewImage", "Image Comparer (rgthree)"}


def _json_bytes(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _json_hash(data: Any) -> str:
    payload = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return _sha256_bytes(payload)


def _classify_workflow(data: Any) -> str:
    if isinstance(data, dict) and isinstance(data.get("prompt"), dict):
        return "api_wrapper"
    if isinstance(data, dict) and data and all(
        str(k).isdigit() and isinstance(v, dict) and "class_type" in v for k, v in data.items()
    ):
        return "api_prompt"
    if isinstance(data, dict) and isinstance(data.get("nodes"), list):
        return "ui_workflow"
    return "unknown"


def _safe_workflow_path(value: Any) -> Path:
    text = str(value or "").replace("\\", "/").strip().lstrip("/")
    if not text:
        raise ValueError("workflow path is required")
    parts = Path(text).parts
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("invalid workflow path")
    for _name, root in WORKFLOW_ROOTS:
        candidate = (root / text).resolve()
        if root == candidate or root in candidate.parents:
            if candidate.exists() and candidate.is_file() and candidate.suffix.lower() == ".json":
                return candidate
    raise FileNotFoundError(text)


def _safe_workflow_write_path(root_name: Any, value: Any) -> Path:
    root_key = str(root_name or "user").strip().lower()
    roots = {name: root for name, root in WORKFLOW_ROOTS}
    if root_key not in roots:
        raise ValueError("workflow root must be user or api")
    text = str(value or "").replace("\\", "/").strip().lstrip("/")
    if not text:
        raise ValueError("workflow path is required")
    if not text.lower().endswith(".json"):
        raise ValueError("workflow path must end with .json")
    parts = Path(text).parts
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("invalid workflow path")
    root = roots[root_key]
    candidate = (root / text).resolve()
    if root != candidate and root not in candidate.parents:
        raise ValueError("workflow path escapes root")
    return candidate


def _safe_input_image_path(subfolder_value: Any, filename_value: Any) -> tuple[Path, str, str]:
    filename = Path(str(filename_value or "").replace("\\", "/")).name
    if not filename:
        raise ValueError("filename is required")
    if Path(filename).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
        raise ValueError("unsupported image extension")
    subfolder = str(subfolder_value or "telegram").replace("\\", "/").strip().strip("/")
    parts = Path(subfolder).parts if subfolder else ()
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("invalid image subfolder")
    target_dir = (INPUT_ROOT / subfolder).resolve() if subfolder else INPUT_ROOT
    if INPUT_ROOT != target_dir and INPUT_ROOT not in target_dir.parents:
        raise ValueError("image path escapes input root")
    target = (target_dir / filename).resolve()
    if target_dir != target.parent or (INPUT_ROOT != target and INPUT_ROOT not in target.parents):
        raise ValueError("image path escapes input root")
    return target, filename, subfolder


def _decode_upload_content(body: dict[str, Any]) -> bytes:
    if isinstance(body.get("content_b64"), str):
        return base64.b64decode(body["content_b64"], validate=True)
    if isinstance(body.get("content"), str):
        return body["content"].encode("utf-8")
    raise ValueError("content or content_b64 is required")


def _upload_workflow(body: dict[str, Any]) -> dict[str, Any]:
    target = _safe_workflow_write_path(body.get("root"), body.get("path"))
    raw = _decode_upload_content(body)
    if len(raw) > 50 * 1024 * 1024:
        raise ValueError("workflow upload is too large")
    data = json.loads(raw.decode("utf-8-sig"))
    kind = _classify_workflow(data)
    if kind == "unknown":
        raise ValueError("uploaded JSON is not a recognized workflow")
    expected_sha = str(body.get("sha256") or "").strip().lower()
    actual_sha = _sha256_bytes(raw)
    if expected_sha and expected_sha != actual_sha:
        raise ValueError("sha256 mismatch")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)
    root = {name: path for name, path in WORKFLOW_ROOTS}[str(body.get("root") or "user").strip().lower()]
    return {
        "ok": True,
        "root": str(body.get("root") or "user"),
        "path": target.relative_to(root).as_posix(),
        "kind": kind,
        "bytes": len(raw),
        "sha256": actual_sha,
    }


def _upload_input_image(body: dict[str, Any]) -> dict[str, Any]:
    target, filename, subfolder = _safe_input_image_path(body.get("subfolder"), body.get("filename") or body.get("name"))
    raw = _decode_upload_content(body)
    if len(raw) > 30 * 1024 * 1024:
        raise ValueError("image upload is too large")
    overwrite = str(body.get("overwrite") or "").strip().lower() in {"1", "true", "yes", "on"}
    if target.exists() and not overwrite:
        target = target.with_name(f"{target.stem}_{uuid.uuid4().hex[:8]}{target.suffix}")
        filename = target.name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)
    image_value = f"{subfolder}/{filename}" if subfolder else filename
    return {
        "ok": True,
        "name": filename,
        "filename": filename,
        "subfolder": subfolder,
        "type": "input",
        "image": image_value,
        "path": str(target),
        "size": len(raw),
        "sha256": _sha256_bytes(raw),
    }


def _safe_model_path(category: Any, value: Any) -> Path:
    category_text = str(category or "").replace("\\", "/").strip().strip("/")
    path_text = str(value or "").replace("\\", "/").strip().lstrip("/")
    if not category_text or not path_text:
        raise ValueError("category and path are required")
    category_parts = Path(category_text).parts
    path_parts = Path(path_text).parts
    if any(part in {"", ".", ".."} for part in [*category_parts, *path_parts]):
        raise ValueError("invalid model path")
    root = (COMFY_ROOT / "models" / category_text).resolve()
    candidate = (root / path_text).resolve()
    if root != candidate and root not in candidate.parents:
        raise ValueError("model path escapes category root")
    return candidate


def _safe_custom_node_path(package: Any, value: Any = "") -> Path:
    package_text = str(package or "").replace("\\", "/").strip().strip("/")
    path_text = str(value or "").replace("\\", "/").strip().lstrip("/")
    if not package_text:
        raise ValueError("package is required")
    package_parts = Path(package_text).parts
    path_parts = Path(path_text).parts if path_text else ()
    if any(part in {"", ".", ".."} for part in [*package_parts, *path_parts]):
        raise ValueError("invalid custom node path")
    root = (CUSTOM_NODES_ROOT / package_text).resolve()
    candidate = (root / path_text).resolve() if path_text else root
    if root != candidate and root not in candidate.parents:
        raise ValueError("custom node path escapes package root")
    if CUSTOM_NODES_ROOT != root and CUSTOM_NODES_ROOT not in root.parents:
        raise ValueError("package path escapes custom_nodes root")
    return candidate


def _check_models(body: dict[str, Any]) -> dict[str, Any]:
    items = body.get("items")
    if not isinstance(items, list):
        raise ValueError("items must be a list")
    rows: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        category = str(item.get("category") or "")
        rel = str(item.get("path") or "")
        try:
            path = _safe_model_path(category, rel)
            exists = path.exists() and path.is_file()
            rows.append(
                {
                    "category": category,
                    "path": rel,
                    "exists": exists,
                    "bytes": path.stat().st_size if exists else 0,
                }
            )
        except Exception as exc:
            rows.append({"category": category, "path": rel, "exists": False, "error": str(exc)})
    return {"ok": True, "items": rows}


def _upload_model_chunk(body: dict[str, Any]) -> dict[str, Any]:
    path = _safe_model_path(body.get("category"), body.get("path"))
    raw = _decode_upload_content(body)
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError("chunk is too large")
    offset = int(body.get("offset") or 0)
    total = int(body.get("total") or 0)
    if offset < 0 or total <= 0 or offset > total:
        raise ValueError("invalid offset or total")
    if offset + len(raw) > total:
        raise ValueError("chunk exceeds total size")
    expected_sha = str(body.get("sha256") or "").strip().lower()

    path.parent.mkdir(parents=True, exist_ok=True)
    if offset == 0:
        mode = "wb"
    else:
        if not path.exists():
            raise ValueError("target file does not exist for non-zero offset")
        current_size = path.stat().st_size
        if current_size != offset:
            raise ValueError(f"offset mismatch: expected {current_size}, received {offset}")
        mode = "ab"
    with path.open(mode) as handle:
        handle.write(raw)

    current = path.stat().st_size
    complete = current == total
    response: dict[str, Any] = {
        "ok": True,
        "category": str(body.get("category") or ""),
        "path": str(body.get("path") or ""),
        "bytes": current,
        "total": total,
        "complete": complete,
    }
    if complete and expected_sha:
        actual_sha = _sha256_file(path)
        response["sha256"] = actual_sha
        if actual_sha != expected_sha:
            path.unlink(missing_ok=True)
            raise ValueError("sha256 mismatch after upload")
    return response


def _check_custom_nodes(body: dict[str, Any]) -> dict[str, Any]:
    items = body.get("items")
    if not isinstance(items, list):
        raise ValueError("items must be a list")
    rows: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        package = str(item.get("package") or "")
        rel = str(item.get("path") or "")
        try:
            path = _safe_custom_node_path(package, rel)
            exists = path.exists() and path.is_file()
            row = {
                "package": package,
                "path": rel,
                "exists": exists,
                "bytes": path.stat().st_size if exists else 0,
            }
            if exists and item.get("sha256"):
                row["sha256"] = _sha256_file(path)
            rows.append(row)
        except Exception as exc:
            rows.append({"package": package, "path": rel, "exists": False, "error": str(exc)})
    return {"ok": True, "items": rows}


def _upload_custom_node_chunk(body: dict[str, Any]) -> dict[str, Any]:
    path = _safe_custom_node_path(body.get("package"), body.get("path"))
    raw = _decode_upload_content(body)
    if len(raw) > 16 * 1024 * 1024:
        raise ValueError("chunk is too large")
    offset = int(body.get("offset") or 0)
    total = int(body.get("total") or 0)
    if offset < 0 or total <= 0 or offset > total:
        raise ValueError("invalid offset or total")
    if offset + len(raw) > total:
        raise ValueError("chunk exceeds total size")
    expected_sha = str(body.get("sha256") or "").strip().lower()

    path.parent.mkdir(parents=True, exist_ok=True)
    if offset == 0:
        mode = "wb"
    else:
        if not path.exists():
            raise ValueError("target file does not exist for non-zero offset")
        current_size = path.stat().st_size
        if current_size != offset:
            raise ValueError(f"offset mismatch: expected {current_size}, received {offset}")
        mode = "ab"
    with path.open(mode) as handle:
        handle.write(raw)

    current = path.stat().st_size
    complete = current == total
    response: dict[str, Any] = {
        "ok": True,
        "package": str(body.get("package") or ""),
        "path": str(body.get("path") or ""),
        "bytes": current,
        "total": total,
        "complete": complete,
    }
    if complete and expected_sha:
        actual_sha = _sha256_file(path)
        response["sha256"] = actual_sha
        if actual_sha != expected_sha:
            path.unlink(missing_ok=True)
            raise ValueError("sha256 mismatch after upload")
    return response


def _delete_custom_node(body: dict[str, Any]) -> dict[str, Any]:
    target = _safe_custom_node_path(body.get("package"), body.get("path") or "")
    existed = target.exists()
    if target.is_dir():
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()
    return {
        "ok": True,
        "package": str(body.get("package") or ""),
        "path": str(body.get("path") or ""),
        "deleted": existed,
    }


def _list_workflows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for root_name, root in WORKFLOW_ROOTS:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.json")):
            if path.resolve() == CONVERT_MANIFEST_PATH.resolve():
                continue
            try:
                data = _read_json(path)
                kind = _classify_workflow(data)
            except Exception:
                kind = "invalid_json"
            rel = path.relative_to(root).as_posix()
            rows.append(
                {
                    "root": root_name,
                    "path": rel,
                    "name": path.name,
                    "kind": kind,
                    "can_run": kind in {"api_prompt", "api_wrapper"},
                    "bytes": path.stat().st_size,
                    "updated_at": int(path.stat().st_mtime),
                }
            )
    return rows


def _load_api_prompt(path: Path) -> dict[str, Any]:
    data = _read_json(path)
    kind = _classify_workflow(data)
    if kind == "api_wrapper":
        prompt = data.get("prompt")
    elif kind == "api_prompt":
        prompt = data
    else:
        raise ValueError(f"workflow is {kind}, export API format first")
    if not isinstance(prompt, dict):
        raise ValueError("invalid API prompt")
    return prompt


def _api_output_path_for_ui_workflow(path: Path) -> Path:
    source_root = WORKFLOW_ROOTS[0][1]
    try:
        rel = path.resolve().relative_to(source_root)
    except Exception:
        rel = Path(path.name)
    safe_parts = [part for part in rel.parts if part not in {"", ".", ".."}]
    rel = Path(*safe_parts) if safe_parts else Path(path.name)
    return (CONVERTED_ROOT / rel).with_suffix(".api.json").resolve()


def _source_rel_for_manifest(path: Path) -> str:
    try:
        return path.resolve().relative_to(WORKFLOW_ROOTS[0][1]).as_posix()
    except Exception:
        return path.name


def _load_convert_manifest() -> dict[str, Any]:
    if not CONVERT_MANIFEST_PATH.exists():
        return {"version": 1, "items": {}}
    try:
        data = _read_json(CONVERT_MANIFEST_PATH)
    except Exception:
        return {"version": 1, "items": {}}
    if not isinstance(data, dict):
        return {"version": 1, "items": {}}
    if not isinstance(data.get("items"), dict):
        data["items"] = {}
    return data


def _write_convert_manifest(manifest: dict[str, Any]) -> None:
    CONVERT_MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONVERT_MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def _object_input_order(object_info: dict[str, Any], class_type: str) -> list[str]:
    item = object_info.get(class_type) if isinstance(object_info, dict) else None
    inputs = item.get("input") if isinstance(item, dict) else None
    if not isinstance(inputs, dict):
        return []
    ordered: list[str] = []
    for group in ("required", "optional"):
        values = inputs.get(group)
        if isinstance(values, dict):
            ordered.extend([str(key) for key in values.keys()])
    return ordered


def _rgthree_power_lora_inputs(widgets: Any) -> dict[str, Any]:
    if not isinstance(widgets, list):
        return {}
    lora_inputs: dict[str, Any] = {}
    for value in widgets:
        if not isinstance(value, dict):
            continue
        if "lora" not in value:
            continue
        index = len(lora_inputs) + 1
        lora_inputs[f"lora_{index}"] = dict(value)
    return lora_inputs


def _ui_widget_value(node: dict[str, Any], widget_name: str) -> Any:
    widgets = node.get("widgets_values")
    if isinstance(widgets, dict):
        return widgets.get(widget_name)
    if not isinstance(widgets, list):
        return None
    widget_names: list[str] = []
    for input_item in node.get("inputs") or []:
        if not isinstance(input_item, dict):
            continue
        widget = input_item.get("widget")
        if isinstance(widget, dict):
            name = str(widget.get("name") or input_item.get("name") or "").strip()
            if name:
                widget_names.append(name)
    if widget_name in widget_names:
        index = widget_names.index(widget_name)
        if index < len(widgets):
            return widgets[index]
    if widget_name == "text" and widgets and isinstance(widgets[0], str):
        return widgets[0]
    return None


def _proxy_widget_default_value(data: dict[str, Any], class_type: str, node: dict[str, Any], widget_name: str) -> Any:
    properties = node.get("properties") if isinstance(node.get("properties"), dict) else {}
    proxy_widgets = properties.get("proxyWidgets")
    if not isinstance(proxy_widgets, list):
        return None
    definitions = data.get("definitions") if isinstance(data.get("definitions"), dict) else {}
    subgraphs = definitions.get("subgraphs")
    if not isinstance(subgraphs, list):
        return None
    for proxy_item in proxy_widgets:
        if not isinstance(proxy_item, list) or len(proxy_item) < 2 or str(proxy_item[1]) != widget_name:
            continue
        proxy_node_id = str(proxy_item[0])
        for subgraph in subgraphs:
            if not isinstance(subgraph, dict) or str(subgraph.get("id") or "") != class_type:
                continue
            for inner_node in subgraph.get("nodes") or []:
                if not isinstance(inner_node, dict) or str(inner_node.get("id") or "") != proxy_node_id:
                    continue
                value = _ui_widget_value(inner_node, widget_name)
                if value is not None:
                    return value
    return None


def _prepend_prompt_text(addition: str, existing: str) -> str:
    prefix = str(addition or "").strip()
    current = str(existing or "").strip()
    if not prefix:
        return current
    if not current:
        return prefix
    if current == prefix or current.startswith(f"{prefix}\n"):
        return current
    return f"{prefix}\n\n{current}"


def _normalize_ui_node_class_type(node: dict[str, Any], class_type: str, object_info: dict[str, Any]) -> str:
    if class_type in object_info:
        return class_type
    alias = UUID_CLASS_TYPE_ALIASES.get(class_type)
    if alias and alias in object_info:
        return alias
    properties = node.get("properties") if isinstance(node.get("properties"), dict) else {}
    proxy_widgets = properties.get("proxyWidgets")
    has_text_proxy = any(
        isinstance(item, list) and len(item) >= 2 and str(item[1]) == "text"
        for item in (proxy_widgets if isinstance(proxy_widgets, list) else [])
    )
    has_clip_input = any(
        isinstance(item, dict) and str(item.get("name") or "") == "clip" and str(item.get("type") or "") == "CLIP"
        for item in (node.get("inputs") or [])
    )
    has_conditioning_output = any(
        isinstance(item, dict) and str(item.get("type") or "") == "CONDITIONING"
        for item in (node.get("outputs") or [])
    )
    if has_text_proxy and has_clip_input and has_conditioning_output and "CLIPTextEncode" in object_info:
        return "CLIPTextEncode"
    return class_type


def _linked_node_ids(value: Any) -> set[str]:
    linked: set[str] = set()
    if isinstance(value, list):
        if len(value) == 2 and isinstance(value[1], int):
            linked.add(str(value[0]))
        else:
            for item in value:
                linked.update(_linked_node_ids(item))
    elif isinstance(value, dict):
        for item in value.values():
            linked.update(_linked_node_ids(item))
    return linked


def _prune_api_prompt_to_output_ancestors(prompt: dict[str, Any]) -> tuple[dict[str, Any], int]:
    output_ids = [
        node_id
        for node_id, node in prompt.items()
        if isinstance(node, dict) and str(node.get("class_type") or "") in OUTPUT_CLASS_TYPES
    ]
    if not output_ids:
        return prompt, 0
    keep: set[str] = set()
    stack = list(output_ids)
    while stack:
        node_id = stack.pop()
        if node_id in keep or node_id not in prompt:
            continue
        keep.add(node_id)
        node = prompt.get(node_id)
        inputs = node.get("inputs") if isinstance(node, dict) else {}
        for linked_node_id in _linked_node_ids(inputs):
            if linked_node_id in prompt and linked_node_id not in keep:
                stack.append(linked_node_id)
    if not keep:
        return prompt, 0
    pruned = {node_id: node for node_id, node in prompt.items() if node_id in keep}
    return pruned, len(prompt) - len(pruned)


def _ui_link_origins(data: dict[str, Any]) -> dict[int, list[Any]]:
    origins: dict[int, list[Any]] = {}
    for item in data.get("links") or []:
        if isinstance(item, list) and len(item) >= 3:
            try:
                origins[int(item[0])] = [str(item[1]), int(item[2])]
            except Exception:
                continue
        elif isinstance(item, dict):
            try:
                link_id = int(item.get("id"))
                origin_id = str(item.get("origin_id") or item.get("from_node") or item.get("source_id"))
                origin_slot = int(item.get("origin_slot") or item.get("from_slot") or item.get("source_slot") or 0)
                origins[link_id] = [origin_id, origin_slot]
            except Exception:
                continue
    return origins


def _ui_workflow_to_api_prompt(data: dict[str, Any], object_info: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    nodes = data.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("workflow does not contain UI nodes")
    link_origins = _ui_link_origins(data)
    prompt: dict[str, Any] = {}
    warnings: list[str] = []

    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id") or "").strip()
        original_class_type = str(node.get("type") or "").strip()
        class_type = original_class_type
        if not node_id or not class_type:
            continue
        proxy_text_default = _proxy_widget_default_value(data, original_class_type, node, "text")
        class_type = _normalize_ui_node_class_type(node, class_type, object_info)
        inputs_payload: dict[str, Any] = {}

        for input_item in node.get("inputs") or []:
            if not isinstance(input_item, dict):
                continue
            name = str(input_item.get("name") or "").strip()
            if not name:
                continue
            link_id = input_item.get("link")
            if link_id is None:
                continue
            try:
                origin = link_origins.get(int(link_id))
            except Exception:
                origin = None
            if origin:
                inputs_payload[name] = origin

        order = _object_input_order(object_info, class_type)
        if not order:
            warnings.append(f"{node_id}:{class_type} object_info missing; widget mapping may be incomplete")

        widgets = node.get("widgets_values")
        if isinstance(widgets, dict):
            for key, value in widgets.items():
                name = str(key)
                if name and name not in inputs_payload:
                    inputs_payload[name] = value
        elif isinstance(widgets, list):
            if class_type == "Power Lora Loader (rgthree)":
                inputs_payload.update(
                    {
                        key: value
                        for key, value in _rgthree_power_lora_inputs(widgets).items()
                        if key not in inputs_payload
                    }
                )
                widgets = []
            if class_type == "KSampler" and len(widgets) >= 7 and str(widgets[1]).strip().lower() in {
                "fixed",
                "randomize",
                "increment",
                "decrement",
            }:
                widgets = [widgets[0], *widgets[2:]]
            widget_index = 0
            for name in order:
                if name in inputs_payload:
                    continue
                if widget_index >= len(widgets):
                    break
                inputs_payload[name] = widgets[widget_index]
                widget_index += 1
            if widget_index < len(widgets):
                warnings.append(
                    f"{node_id}:{class_type} has {len(widgets) - widget_index} unmapped widget value(s)"
                )
        if class_type == "CLIPTextEncode" and "text" not in inputs_payload:
            inputs_payload["text"] = proxy_text_default if isinstance(proxy_text_default, str) else ""

        title = str((node.get("properties") or {}).get("Node name for S&R") or node.get("title") or "").strip()
        prompt[node_id] = {
            "class_type": class_type,
            "inputs": inputs_payload,
            "_meta": {"title": title or class_type},
        }

    if not prompt:
        raise ValueError("no runnable nodes found in UI workflow")
    prompt, pruned_count = _prune_api_prompt_to_output_ancestors(prompt)
    if pruned_count:
        warnings.append(f"pruned {pruned_count} node(s) not connected to output")
    return prompt, warnings


def _convert_ui_workflow(
    path: Path,
    *,
    object_info: dict[str, Any],
    object_info_hash: str,
    manifest: dict[str, Any],
    force: bool = False,
    overwrite: bool = True,
    comfyui_version: str = "",
) -> dict[str, Any]:
    data = _read_json(path)
    kind = _classify_workflow(data)
    if kind in {"api_prompt", "api_wrapper"}:
        return {
            "ok": True,
            "source_path": path.name,
            "kind": kind,
            "already_api": True,
            "skipped": True,
            "skip_reason": "already API format",
            "output_path": path.name,
            "warnings": [],
        }
    if kind != "ui_workflow" or not isinstance(data, dict):
        raise ValueError(f"workflow is {kind}, cannot convert")
    output_path = _api_output_path_for_ui_workflow(path)
    source_rel = _source_rel_for_manifest(path)
    source_hash = _sha256_file(path)
    output_rel = output_path.relative_to(WORKFLOW_ROOTS[1][1]).as_posix()
    manifest_items = manifest.setdefault("items", {})
    previous = manifest_items.get(source_rel) if isinstance(manifest_items, dict) else None
    if (
        not force
        and output_path.exists()
        and isinstance(previous, dict)
        and previous.get("source_hash") == source_hash
        and previous.get("object_info_hash") == object_info_hash
        and previous.get("converter_version") == CONVERTER_VERSION
        and previous.get("output_path") == output_rel
    ):
        return {
            "ok": True,
            "source_path": source_rel,
            "kind": "api_prompt",
            "already_api": False,
            "skipped": True,
            "skip_reason": "source unchanged",
            "output_path": output_rel,
            "warnings": [],
        }
    prompt, warnings = _ui_workflow_to_api_prompt(data, object_info)
    if output_path.exists() and not overwrite:
        raise FileExistsError(str(output_path))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(prompt, ensure_ascii=False, indent=2), encoding="utf-8")
    output_hash = _sha256_file(output_path)
    manifest_items[source_rel] = {
        "source_hash": source_hash,
        "output_hash": output_hash,
        "output_path": output_rel,
        "object_info_hash": object_info_hash,
        "converter_version": CONVERTER_VERSION,
        "comfyui_version": comfyui_version,
        "converted_at": int(time.time()),
        "nodes": len(prompt),
    }
    return {
        "ok": True,
        "source_path": source_rel,
        "kind": "api_prompt",
        "already_api": False,
        "skipped": False,
        "output_path": output_rel,
        "warnings": warnings,
        "nodes": len(prompt),
    }


def _convert_workflows(body: dict[str, Any]) -> dict[str, Any]:
    overwrite = bool(body.get("overwrite", True))
    force = bool(body.get("force", False))
    paths = body.get("paths")
    if isinstance(paths, list) and paths:
        targets = [_safe_workflow_path(path) for path in paths]
    else:
        targets = []
        for item in _list_workflows():
            if item.get("root") == "user" and item.get("kind") == "ui_workflow":
                targets.append(_safe_workflow_path(item.get("path")))
    if not targets:
        return {
            "ok": True,
            "converted": 0,
            "skipped": 0,
            "failed": 0,
            "force": force,
            "items": [],
        }
    object_info = _comfy_request("GET", "/object_info", timeout=60)
    object_info = object_info if isinstance(object_info, dict) else {}
    object_info_hash = _json_hash(object_info)
    try:
        stats = _comfy_request("GET", "/system_stats", timeout=30)
        comfyui_version = str(((stats or {}).get("system") or {}).get("comfyui_version") or "")
    except Exception:
        comfyui_version = ""
    manifest = _load_convert_manifest()
    items: list[dict[str, Any]] = []
    manifest_changed = False
    for path in targets:
        try:
            item = _convert_ui_workflow(
                path,
                object_info=object_info,
                object_info_hash=object_info_hash,
                manifest=manifest,
                force=force,
                overwrite=overwrite,
                comfyui_version=comfyui_version,
            )
            items.append(item)
            if item.get("ok") and not item.get("skipped"):
                manifest_changed = True
        except Exception as exc:
            items.append({"ok": False, "source_path": path.name, "error": str(exc)})
    if manifest_changed:
        _write_convert_manifest(manifest)
    converted = sum(1 for item in items if item.get("ok") and not item.get("already_api") and not item.get("skipped"))
    skipped = sum(1 for item in items if item.get("ok") and item.get("skipped"))
    failed = sum(1 for item in items if not item.get("ok"))
    return {
        "ok": failed == 0,
        "converted": converted,
        "skipped": skipped,
        "failed": failed,
        "force": force,
        "object_info_hash": object_info_hash,
        "converter_version": CONVERTER_VERSION,
        "items": items,
    }


def _apply_prompt_overrides(prompt: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    positive = str(body.get("prompt_text") or body.get("prompt") or "").strip()
    negative = str(body.get("negative_prompt") or "").strip()
    positive_node_ids = {str(value).strip() for value in body.get("prompt_text_node_ids") or [] if str(value).strip()}
    negative_node_ids = {str(value).strip() for value in body.get("negative_text_node_ids") or [] if str(value).strip()}
    width = _int_or_none(body.get("width"))
    height = _int_or_none(body.get("height"))
    steps = _int_or_none(body.get("steps"))
    seed = _int_or_none(body.get("seed"))
    batch_size = _int_or_none(body.get("batch_size"))
    input_images = _normalize_input_images(body.get("input_images"))
    input_image_bindings = _normalize_input_image_bindings(body.get("input_image_bindings"))

    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type") or "")
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        title = str((node.get("_meta") or {}).get("title") or "").lower()

        if class_type == "CLIPTextEncode" and isinstance(inputs.get("text"), str):
            if positive_node_ids:
                if positive and str(node_id) in positive_node_ids:
                    inputs["text"] = positive
                elif negative and str(node_id) in negative_node_ids:
                    inputs["text"] = _prepend_prompt_text(negative, inputs.get("text") or "")
            elif negative_node_ids and negative and str(node_id) in negative_node_ids:
                inputs["text"] = _prepend_prompt_text(negative, inputs.get("text") or "")
            elif ("negative" in title or "neg" in title) and negative:
                inputs["text"] = _prepend_prompt_text(negative, inputs.get("text") or "")
            elif positive and "negative" not in title and "neg" not in title:
                inputs["text"] = positive

        if width is not None and isinstance(inputs.get("width"), int):
            inputs["width"] = width
        if height is not None and isinstance(inputs.get("height"), int):
            inputs["height"] = height
        if steps is not None and isinstance(inputs.get("steps"), int):
            inputs["steps"] = steps
        if seed is not None and "seed" in inputs and isinstance(inputs.get("seed"), int):
            inputs["seed"] = seed
        if batch_size is not None and isinstance(inputs.get("batch_size"), int):
            inputs["batch_size"] = batch_size

    if input_images:
        _apply_input_images_to_prompt(prompt, input_images, input_image_bindings)

    explicit = body.get("node_inputs")
    if isinstance(explicit, dict):
        for node_id, values in explicit.items():
            node = prompt.get(str(node_id))
            if not isinstance(node, dict) or not isinstance(values, dict):
                continue
            inputs = node.setdefault("inputs", {})
            if isinstance(inputs, dict):
                if (
                    str(node_id) in negative_node_ids
                    and str(node.get("class_type") or "") == "CLIPTextEncode"
                    and isinstance(values.get("text"), str)
                ):
                    inputs["text"] = _prepend_prompt_text(values.get("text") or "", inputs.get("text") or "")
                    inputs.update({key: value for key, value in values.items() if key != "text"})
                else:
                    inputs.update(values)
    return prompt


def _normalize_input_images(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, str]] = []
    for item in value:
        if isinstance(item, dict):
            text = str(item.get("image") or item.get("name") or item.get("filename") or "").strip()
            role = str(item.get("role") or item.get("kind") or "input").strip().lower() or "input"
            node_id = str(item.get("node_id") or item.get("node") or "").strip()
            input_name = str(item.get("input_name") or item.get("input") or "image").strip() or "image"
        else:
            text = str(item or "").strip()
            role = "input"
            node_id = ""
            input_name = "image"
        if text:
            normalized = {"image": text, "role": role, "input_name": input_name}
            if node_id:
                normalized["node_id"] = node_id
            result.append(normalized)
    return result


def _normalize_input_image_bindings(value: Any) -> dict[str, dict[str, str]]:
    if not isinstance(value, (dict, list)):
        return {}
    rows: list[dict[str, Any]]
    if isinstance(value, dict):
        rows = []
        for role, binding in value.items():
            if isinstance(binding, dict):
                rows.append({"role": role, **binding})
            else:
                rows.append({"role": role, "node_id": binding})
    else:
        rows = [item for item in value if isinstance(item, dict)]
    result: dict[str, dict[str, str]] = {}
    for row in rows:
        role = str(row.get("role") or row.get("kind") or "").strip().lower()
        node_id = str(row.get("node_id") or row.get("node") or "").strip()
        if not role or not node_id:
            continue
        result[role] = {
            "node_id": node_id,
            "input_name": str(row.get("input_name") or row.get("input") or "image").strip() or "image",
        }
    return result


def _load_image_nodes(prompt: dict[str, Any]) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if str(node.get("class_type") or "") != "LoadImage" or not isinstance(inputs, dict) or "image" not in inputs:
            continue
        try:
            order_key = int(str(node_id))
        except Exception:
            order_key = 10**9
        title = str((node.get("_meta") or {}).get("title") or "")
        current_image = str(inputs.get("image") or "")
        nodes.append(
            {
                "order": order_key,
                "node_id": str(node_id),
                "inputs": inputs,
                "search_text": f"{title} {current_image}".lower(),
            }
        )
    nodes.sort(key=lambda item: (item["order"], item["node_id"]))
    return nodes


def _role_keywords(role: str) -> list[str]:
    role = str(role or "").strip().lower()
    if role in {"source_face", "face", "source", "reference_face", "identity"}:
        return [
            "source face",
            "source_face",
            "face source",
            "face",
            "reference",
            "ref",
            "identity",
            "src",
            "人脸",
            "人臉",
            "参考",
            "參考",
            "脸",
            "臉",
            "身份",
        ]
    if role in {"target", "original", "base", "destination"}:
        return [
            "target",
            "original",
            "base",
            "destination",
            "dst",
            "main",
            "background",
            "body",
            "原图",
            "原圖",
            "目标",
            "目標",
            "底图",
            "底圖",
            "主图",
            "主圖",
            "被换脸",
            "被換臉",
        ]
    return ["input", "image", "edit", "reference", "原图", "原圖", "参考", "參考"]


def _find_load_image_node_for_role(
    nodes: list[dict[str, Any]],
    role: str,
    used_node_ids: set[str],
) -> dict[str, Any] | None:
    keywords = _role_keywords(role)
    best: tuple[int, dict[str, Any]] | None = None
    for node in nodes:
        node_id = str(node.get("node_id") or "")
        if node_id in used_node_ids:
            continue
        text = str(node.get("search_text") or "")
        score = 0
        for keyword in keywords:
            if keyword and keyword.lower() in text:
                score += 2 if len(keyword) > 2 else 1
        if score <= 0:
            continue
        if best is None or score > best[0]:
            best = (score, node)
    return best[1] if best else None


def _apply_input_images_to_prompt(
    prompt: dict[str, Any],
    input_images: list[dict[str, str]],
    input_image_bindings: dict[str, dict[str, str]],
) -> None:
    nodes = _load_image_nodes(prompt)
    used_node_ids: set[str] = set()
    remaining_images: list[dict[str, str]] = []
    by_node_id = {str(node.get("node_id")): node for node in nodes}

    for item in input_images:
        role = str(item.get("role") or "input").strip().lower() or "input"
        image_value = str(item.get("image") or "").strip()
        if not image_value:
            continue
        binding = input_image_bindings.get(role) or {}
        explicit_node_id = str(item.get("node_id") or binding.get("node_id") or "").strip()
        if explicit_node_id:
            node = by_node_id.get(explicit_node_id)
            if node:
                input_name = str(item.get("input_name") or binding.get("input_name") or "image").strip() or "image"
                node["inputs"][input_name] = image_value
                used_node_ids.add(explicit_node_id)
                continue
        node = _find_load_image_node_for_role(nodes, role, used_node_ids)
        if node:
            node["inputs"]["image"] = image_value
            used_node_ids.add(str(node.get("node_id") or ""))
        else:
            remaining_images.append(item)

    remaining_nodes = [node for node in nodes if str(node.get("node_id") or "") not in used_node_ids]
    for item, node in zip(remaining_images, remaining_nodes):
        image_value = str(item.get("image") or "").strip()
        if image_value:
            node["inputs"]["image"] = image_value


def _int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except Exception:
        return None


def _comfy_request(method: str, path: str, body: Any = None, timeout: int = 60) -> Any:
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = _json_bytes(body)
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(COMFY_URL + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read()
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))


class Handler(BaseHTTPRequestHandler):
    server_version = "ComfyGatewayV2/1.0"

    def _send(self, status: int, data: Any) -> None:
        raw = _json_bytes(data)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _auth_ok(self) -> bool:
        if not TOKEN:
            return True
        return self.headers.get("Authorization", "").strip() == f"Bearer {TOKEN}"

    def _read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _guard(self) -> bool:
        if self._auth_ok():
            return True
        self._send(401, {"ok": False, "error": "unauthorized"})
        return False

    def do_GET(self) -> None:
        if not self._guard():
            return
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/health":
                self._send(200, _comfy_request("GET", "/system_stats"))
            elif path == "/api/object_info":
                self._send(200, _comfy_request("GET", "/object_info"))
            elif path == "/api/queue":
                self._send(200, _comfy_request("GET", "/queue"))
            elif path == "/api/history":
                self._send(200, _comfy_request("GET", "/history"))
            elif path.startswith("/api/history/"):
                prompt_id = urllib.parse.quote(path.split("/", 3)[-1])
                self._send(200, _comfy_request("GET", f"/history/{prompt_id}"))
            elif path == "/api/view":
                self._proxy_view(parsed.query)
            elif path == "/api/workflows":
                self._send(200, {"ok": True, "items": _list_workflows()})
            elif path == "/api/jobs":
                prompt_id = str((query.get("prompt_id") or [""])[0]).strip()
                if not prompt_id:
                    raise ValueError("prompt_id is required")
                self._send(200, _job_payload(prompt_id))
            else:
                self._send(404, {"ok": False, "error": "not_found"})
        except Exception as exc:
            self._send(502, {"ok": False, "error": str(exc)})

    def do_POST(self) -> None:
        if not self._guard():
            return
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"
        try:
            body = self._read_body()
            if path == "/api/prompt":
                self._send(200, _comfy_request("POST", "/prompt", body=body))
            elif path == "/api/workflows/run":
                workflow_path = _safe_workflow_path(body.get("path"))
                prompt = _load_api_prompt(workflow_path)
                prompt = json.loads(json.dumps(prompt))
                prompt = _apply_prompt_overrides(prompt, body)
                response = _comfy_request(
                    "POST",
                    "/prompt",
                    body={"prompt": prompt, "client_id": str(body.get("client_id") or uuid.uuid4())},
                )
                self._send(
                    200,
                    {
                        "ok": True,
                        "prompt_id": response.get("prompt_id"),
                        "workflow": workflow_path.name,
                        "raw": response,
                    },
                )
            elif path == "/api/workflows/convert":
                self._send(200, _convert_workflows(body))
            elif path == "/api/workflows/upload":
                self._send(200, _upload_workflow(body))
            elif path == "/api/upload/image":
                self._send(200, _upload_input_image(body))
            elif path == "/api/models/check":
                self._send(200, _check_models(body))
            elif path == "/api/models/upload_chunk":
                self._send(200, _upload_model_chunk(body))
            elif path == "/api/custom_nodes/check":
                self._send(200, _check_custom_nodes(body))
            elif path == "/api/custom_nodes/upload_chunk":
                self._send(200, _upload_custom_node_chunk(body))
            elif path == "/api/custom_nodes/delete":
                self._send(200, _delete_custom_node(body))
            else:
                self._send(404, {"ok": False, "error": "not_found"})
        except urllib.error.HTTPError as exc:
            self._send(exc.code, {"ok": False, "error": exc.read().decode("utf-8", errors="replace")})
        except Exception as exc:
            self._send(502, {"ok": False, "error": str(exc)})

    def _proxy_view(self, query: str) -> None:
        req = urllib.request.Request(COMFY_URL + "/view?" + query, method="GET")
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            self.send_response(200)
            self.send_header("Content-Type", response.headers.get("Content-Type", "application/octet-stream"))
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    def log_message(self, fmt: str, *args: Any) -> None:
        print("%s - %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), fmt % args))


def _job_payload(prompt_id: str) -> dict[str, Any]:
    history = _comfy_request("GET", f"/history/{urllib.parse.quote(prompt_id)}")
    item = history.get(prompt_id) if isinstance(history, dict) else None
    if not isinstance(item, dict):
        return {"ok": True, "done": False, "prompt_id": prompt_id, "outputs": []}
    outputs: list[dict[str, Any]] = []
    for node_id, output in (item.get("outputs") or {}).items():
        if not isinstance(output, dict):
            continue
        for kind in ("images", "videos", "gifs", "audio"):
            for file_item in output.get(kind, []) or []:
                if isinstance(file_item, dict):
                    outputs.append({"node": node_id, "kind": kind, **file_item})
    return {"ok": True, "done": True, "prompt_id": prompt_id, "outputs": outputs}


def main() -> None:
    for _name, root in WORKFLOW_ROOTS:
        root.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Comfy gateway v2 listening on http://{HOST}:{PORT}")
    print(f"ComfyUI upstream: {COMFY_URL}")
    print("Auth: " + ("enabled" if TOKEN else "disabled"))
    server.serve_forever()


if __name__ == "__main__":
    main()
