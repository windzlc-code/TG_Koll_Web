from __future__ import annotations

import json
import os
from importlib import metadata
from pathlib import Path
from typing import Any, Callable


PINNED_CAMOUFOX_PACKAGE_VERSION = "0.4.11"
PINNED_BROWSERFORGE_PACKAGE_VERSION = "1.2.4"
PINNED_CAMOUFOX_BROWSER_VERSION = "152.0.4"
PINNED_CAMOUFOX_BROWSER_RELEASE = "beta.28"


def _default_cache_root() -> Path:
    configured = str(os.getenv("XDG_CACHE_HOME") or "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".cache"


def verify_pinned_browser_runtime(
    *,
    cache_root: Path | None = None,
    package_version: Callable[[str], str] = metadata.version,
) -> dict[str, str]:
    expected_packages = {
        "camoufox": PINNED_CAMOUFOX_PACKAGE_VERSION,
        "browserforge": PINNED_BROWSERFORGE_PACKAGE_VERSION,
    }
    actual_packages: dict[str, str] = {}
    for package_name, expected_version in expected_packages.items():
        try:
            actual_version = str(package_version(package_name)).strip()
        except metadata.PackageNotFoundError as exc:
            raise RuntimeError(
                f"受管浏览器运行环境缺少 {package_name}=={expected_version}，"
                "请从项目锁定依赖恢复，禁止直接拉取最新版。"
            ) from exc
        if actual_version != expected_version:
            raise RuntimeError(
                f"受管浏览器运行环境版本不匹配：{package_name} 当前为 {actual_version or '未知'}，"
                f"要求 {expected_version}。请从项目锁定依赖恢复，禁止直接升级。"
            )
        actual_packages[package_name] = actual_version

    version_file = (cache_root or _default_cache_root()) / "camoufox" / "version.json"
    try:
        payload: Any = json.loads(version_file.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"受管浏览器构建清单不存在：{version_file}。"
            "请从服务器浏览器构建备份恢复，禁止下载其他版本。"
        ) from exc
    except (OSError, ValueError, TypeError) as exc:
        raise RuntimeError(
            f"受管浏览器构建清单无法读取：{version_file}。"
            "请从服务器浏览器构建备份恢复。"
        ) from exc

    if not isinstance(payload, dict):
        payload = {}
    actual_browser_version = str(payload.get("version") or "").strip()
    actual_browser_release = str(payload.get("release") or "").strip()
    if (
        actual_browser_version != PINNED_CAMOUFOX_BROWSER_VERSION
        or actual_browser_release != PINNED_CAMOUFOX_BROWSER_RELEASE
    ):
        actual_label = f"{actual_browser_version or '未知'}-{actual_browser_release or '未知'}"
        expected_label = f"{PINNED_CAMOUFOX_BROWSER_VERSION}-{PINNED_CAMOUFOX_BROWSER_RELEASE}"
        raise RuntimeError(
            f"受管浏览器构建版本不匹配：当前为 {actual_label}，要求 {expected_label}。"
            "请从服务器浏览器构建备份恢复，禁止直接升级。"
        )

    return {
        **actual_packages,
        "browser_version": actual_browser_version,
        "browser_release": actual_browser_release,
        "version_file": str(version_file),
    }
