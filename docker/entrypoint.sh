#!/usr/bin/env bash
set -euo pipefail

export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${WEBAPP_DATA_DIR:-/data/webapp_data}/cache}"
mkdir -p "${WEBAPP_DATA_DIR:-/data/webapp_data}" "${TOOL_R18_RUNTIME_DIR:-/data/tool_r18_runtime}" "$XDG_CACHE_HOME"
export TOOL_R18_UPLOAD_HOST_DIR="${TOOL_R18_UPLOAD_HOST_DIR:-${WEBAPP_DATA_DIR:-/data/webapp_data}/tool_r18_uploads}"
export TOOL_R18_PUBLIC_URL="${TOOL_R18_PUBLIC_URL:-http://47.243.99.2:8001}"
mkdir -p "$TOOL_R18_UPLOAD_HOST_DIR"

echo "Starting Workflow Delivery Web backend..."
WEB_PORT="${WEBAPP_PORT:-8001}"
export SESSION_COOKIE_SECURE="${SESSION_COOKIE_SECURE:-1}"
cd /app
exec "${VIRTUAL_ENV:-/opt/venv}/bin/uvicorn" webapp.server:app --host 0.0.0.0 --port "$WEB_PORT"
