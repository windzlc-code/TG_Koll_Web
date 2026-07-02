#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-auto-tweet}"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "systemd service install only supports Linux." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found; this server does not appear to use systemd." >&2
  exit 1
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "node executable not found. Set NODE_BIN=/path/to/node and retry." >&2
  exit 1
fi

cat <<EOF | sudo tee "$SERVICE_FILE" >/dev/null
[Unit]
Description=Auto Tweet Ops Console Daemon
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${PROJECT_ROOT}
Environment=NODE_ENV=production
Environment=TELEGRAM_PROXY_URL=
Environment=NODE_OPTIONS=--max-old-space-size=512
ExecStart=${NODE_BIN} --import tsx src/daemon.ts
Restart=always
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"
sudo systemctl --no-pager --full status "$SERVICE_NAME"

echo "Installed and started ${SERVICE_NAME}.service"
echo "Logs: journalctl -u ${SERVICE_NAME} -f"
