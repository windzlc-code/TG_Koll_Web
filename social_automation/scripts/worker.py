from __future__ import annotations

import argparse
import time

from webapp.db import init_db
from webapp.social_automation_api import run_social_automation_once


def main() -> None:
    parser = argparse.ArgumentParser(description="Run queued social automation tasks.")
    parser.add_argument("--once", action="store_true", help="Process at most one task and exit.")
    parser.add_argument("--sleep", type=float, default=5.0, help="Idle sleep seconds for daemon mode.")
    args = parser.parse_args()
    init_db()
    if args.once:
        task = run_social_automation_once()
        print(task or {"ok": True, "task": None})
        return
    while True:
        run_social_automation_once()
        time.sleep(max(1.0, args.sleep))


if __name__ == "__main__":
    main()
