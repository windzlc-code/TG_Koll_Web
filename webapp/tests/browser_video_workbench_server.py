from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Run an isolated server for the video workbench browser smoke test.")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    data_dir = Path(args.data_dir).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ["WEBAPP_DATA_DIR"] = str(data_dir)
    os.environ["APP_DB_PATH"] = str(data_dir / "app.db")
    os.environ["APP_RUNTIME_CONFIG_PATH"] = str(data_dir / "runtime_config.json")
    os.environ["ADMIN_BOOTSTRAP_USERNAME"] = "browseradmin"
    os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = "BrowserSmoke-2026!"
    os.environ["SESSION_COOKIE_SECURE"] = "0"
    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    import uvicorn

    uvicorn.run("webapp.server:app", host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
