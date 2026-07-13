#!/usr/bin/env bash
set -euo pipefail

export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${WEBAPP_DATA_DIR:-/data/webapp_data}/cache}"
mkdir -p "${WEBAPP_DATA_DIR:-/data/webapp_data}" "${TOOL_R18_RUNTIME_DIR:-/data/tool_r18_runtime}" "$XDG_CACHE_HOME"
export TOOL_R18_UPLOAD_HOST_DIR="${TOOL_R18_UPLOAD_HOST_DIR:-${WEBAPP_DATA_DIR:-/data/webapp_data}/tool_r18_uploads}"
export TOOL_R18_PUBLIC_URL="${TOOL_R18_PUBLIC_URL:-http://47.243.99.2:8001}"
mkdir -p "$TOOL_R18_UPLOAD_HOST_DIR"

CONTROL_FILE="${TOOL_R18_PROCESS_CONTROL_FILE:-${TOOL_R18_RUNTIME_DIR:-/data/tool_r18_runtime}/process-control.json}"
STATUS_FILE="${TOOL_R18_PROCESS_STATUS_FILE:-${TOOL_R18_RUNTIME_DIR:-/data/tool_r18_runtime}/process-status.json}"

write_status() {
  local state="$1"
  local pid="${2:-}"
  mkdir -p "$(dirname "$STATUS_FILE")"
  cat > "$STATUS_FILE" <<EOF
{"state":"${state}","pid":"${pid}","updated_at":"$(date -Iseconds)"}
EOF
}

desired_state() {
  if [[ -f "$CONTROL_FILE" ]] && grep -q '"desired"[[:space:]]*:[[:space:]]*"stopped"' "$CONTROL_FILE"; then
    echo "stopped"
  else
    echo "running"
  fi
}

kill_bot_processes() {
  local signal="${1:-TERM}"
  local current_pid="$$"
  local found="0"
  if command -v pgrep >/dev/null 2>&1; then
    while read -r pid; do
      if [[ -n "$pid" && "$pid" != "$current_pid" ]]; then
        kill "-$signal" "$pid" 2>/dev/null || true
      fi
    done < <(pgrep -f "node --import tsx src/daemon.ts|tsx src/daemon.ts|/app/tool_r18.*src/daemon.ts" 2>/dev/null || true)
    found="1"
  fi
  if [[ "$found" == "0" ]]; then
    for proc in /proc/[0-9]*; do
      [[ -r "$proc/cmdline" ]] || continue
      local pid="${proc##*/}"
      [[ "$pid" == "$current_pid" ]] && continue
      local cmdline
      cmdline="$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)"
      case "$cmdline" in
        *"node --import tsx src/daemon.ts"*|*"tsx src/daemon.ts"*|*"/app/tool_r18"*"src/daemon.ts"*)
          kill "-$signal" "$pid" 2>/dev/null || true
          ;;
      esac
    done
  fi
}

start_bot() {
  if [[ -n "${BOT_PID:-}" ]] && kill -0 "$BOT_PID" 2>/dev/null; then
    return
  fi
  kill_bot_processes TERM
  sleep 1
  kill_bot_processes KILL
  echo "Starting Tool_R18 Telegram bot daemon..."
  (
    cd /app/tool_r18
    node --import tsx src/daemon.ts
  ) &
  BOT_PID=$!
  write_status "running" "$BOT_PID"
  echo "Tool_R18 daemon PID: ${BOT_PID}"
}

stop_bot() {
  if [[ -n "${BOT_PID:-}" ]] && kill -0 "$BOT_PID" 2>/dev/null; then
    echo "Stopping Tool_R18 Telegram bot daemon..."
    kill "$BOT_PID" 2>/dev/null || true
    for _ in $(seq 1 15); do
      if ! kill -0 "$BOT_PID" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    if kill -0 "$BOT_PID" 2>/dev/null; then
      kill -9 "$BOT_PID" 2>/dev/null || true
    fi
    wait "$BOT_PID" 2>/dev/null || true
  fi
  kill_bot_processes TERM
  sleep 1
  kill_bot_processes KILL
  BOT_PID=""
  write_status "stopped" ""
}

cleanup() {
  if [[ -n "${WEB_PID:-}" ]]; then kill "$WEB_PID" 2>/dev/null || true; fi
  stop_bot
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting Workflow Delivery Web backend..."
WEB_PORT="${WEBAPP_PORT:-8001}"
"${VIRTUAL_ENV:-/opt/venv}/bin/uvicorn" webapp.server:app --host 0.0.0.0 --port "$WEB_PORT" &
WEB_PID=$!

if [[ "$(desired_state)" == "running" ]]; then
  start_bot
else
  write_status "stopped" ""
fi

echo "Web backend: http://0.0.0.0:${WEB_PORT}"

while true; do
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "Web backend exited; stopping container." >&2
    exit 1
  fi
  if [[ "$(desired_state)" == "stopped" ]]; then
    stop_bot
  else
    if [[ -z "${BOT_PID:-}" ]] || ! kill -0 "$BOT_PID" 2>/dev/null; then
      echo "Tool_R18 daemon is not running; starting it."
      start_bot
    else
      write_status "running" "$BOT_PID"
    fi
  fi
  sleep 5
done
