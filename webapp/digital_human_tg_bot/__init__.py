"""Digital human Telegram bot package."""

from __future__ import annotations

import sys
from pathlib import Path

_SOURCE_DIR = Path(__file__).resolve().parents[2] / "video_core" / "source"
if _SOURCE_DIR.is_dir() and str(_SOURCE_DIR) not in sys.path:
    sys.path.insert(0, str(_SOURCE_DIR))
