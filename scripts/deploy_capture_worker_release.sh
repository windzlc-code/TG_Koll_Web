#!/usr/bin/env bash
set -euo pipefail

umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_SOURCE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
SOURCE_ROOT="${CAPTURE_WORKER_SOURCE_ROOT:-$DEFAULT_SOURCE_ROOT}"

usage() {
  cat <<'EOF'
Build and deploy a versioned capture-worker code release.

Usage:
  deploy_capture_worker_release.sh [--release-id ID]
  deploy_capture_worker_release.sh --build-only OUTPUT_TAR [--release-id ID]

Required for deployment:
  CAPTURE_WORKER_SSH_TARGET       SSH destination, for example root@old-worker

Optional:
  CAPTURE_WORKER_SSH_PORT         SSH port (default: 22)
  CAPTURE_WORKER_SSH_CONFIG       OpenSSH config file
  CAPTURE_WORKER_SOURCE_ROOT      Source checkout (default: repository root)
  CAPTURE_WORKER_RELEASE_ROOT     Old-host code root
  CAPTURE_WORKER_RUNTIME_ROOT     Old-host versioned runtime root
  CAPTURE_WORKER_CONTAINER        Existing/new container name
  CAPTURE_WORKER_CANDIDATE_PORT   Temporary host canary port

The script never packages credentials or runtime databases. The old host must
already contain a versioned runtime snapshot created by
sync_capture_worker_runtime.sh. No production action is taken with --build-only.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

cleanup_tree() {
  local path="${1:-}"
  [[ -n "$path" && -d "$path" && "$path" == /tmp/tg-capture-worker-release.* ]] || return 0
  find "$path" -depth -mindepth 1 -delete
  rmdir -- "$path"
}

validate_release_id() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$ ]] ||
    die "release id must be 8-80 safe characters"
}

release_id=""
build_only=""
while (($#)); do
  case "$1" in
    --release-id)
      (($# >= 2)) || die "--release-id requires a value"
      release_id="$2"
      shift 2
      ;;
    --build-only)
      (($# >= 2)) || die "--build-only requires an output path"
      build_only="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_command tar
require_command sha256sum
require_command find
require_command sort

[[ -d "$SOURCE_ROOT" ]] || die "source root does not exist: $SOURCE_ROOT"
SOURCE_ROOT="$(cd -- "$SOURCE_ROOT" && pwd -P)"

if [[ -z "$release_id" ]]; then
  git_suffix="nogit"
  if command -v git >/dev/null 2>&1 && git -C "$SOURCE_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git_suffix="$(git -C "$SOURCE_ROOT" rev-parse --short=12 HEAD)"
  fi
  release_id="$(date -u +%Y%m%dT%H%M%SZ)-${git_suffix}"
fi
validate_release_id "$release_id"

boundary=(
  webapp/__init__.py
  webapp/worker_server.py
  webapp/remote_fetch_protocol.py
  webapp/collector_accounts.py
  webapp/collector_db.py
  webapp/collector_vault.py
  tool_r18/src
  tool_r18/scripts/skills/persona-hot-workflow.ts
  tool_r18/vendor/opinx-sentiment
  tool_r18/package.json
  tool_r18/package-lock.json
  tool_r18/tsconfig.json
)

for relative in "${boundary[@]}"; do
  [[ -e "$SOURCE_ROOT/$relative" ]] || die "worker boundary path is missing: $relative"
done

work_dir="$(mktemp -d /tmp/tg-capture-worker-release.XXXXXXXX)"
trap 'cleanup_tree "$work_dir"' EXIT
stage_dir="$work_dir/$release_id"
mkdir -p -- "$stage_dir"

# Tar is used as a path-preserving copy mechanism. The allowlist above is the
# complete worker code boundary; UI, control-plane code and runtime data stay out.
(
  cd -- "$SOURCE_ROOT"
  tar -cf - "${boundary[@]}"
) | (
  cd -- "$stage_dir"
  tar -xf -
)

# Podman cannot create a nested bind-mount target below the read-only /app
# release mount. Keep this empty directory in every release for node_modules.
mkdir -p -- "$stage_dir/tool_r18/node_modules"

if find "$stage_dir" -type f \( \
    -iname '*.db' -o -iname '*.sqlite' -o -iname '*.sqlite-wal' -o \
    -iname '*.sqlite-shm' -o -iname '.env' -o -iname '*.pem' -o \
    -iname 'id_rsa*' -o -iname 'credentials.json' -o -iname '*remote-fetch-keys*' \
  \) -print -quit | grep -q .; then
  die "worker code boundary unexpectedly contains a database or credential-like file"
fi

cat >"$stage_dir/RELEASE_METADATA" <<EOF
release_id=$release_id
created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
format=tg-koll-capture-worker-code-v1
EOF

(
  cd -- "$stage_dir"
  find . -type f ! -name SHA256SUMS -print0 |
    LC_ALL=C sort -z |
    xargs -0 -r sha256sum >SHA256SUMS
  sha256sum -c SHA256SUMS >/dev/null
)

archive="$work_dir/${release_id}.tar.gz"
tar -C "$work_dir" -czf "$archive" "$release_id"
archive_sha256="$(sha256sum "$archive" | awk '{print $1}')"

if [[ -n "$build_only" ]]; then
  output_parent="$(dirname -- "$build_only")"
  mkdir -p -- "$output_parent"
  cp -- "$archive" "$build_only"
  chmod 600 "$build_only"
  printf 'Built worker release %s\nArchive: %s\nSHA256: %s\n' \
    "$release_id" "$build_only" "$archive_sha256"
  exit 0
fi

require_command ssh
require_command scp
ssh_target="${CAPTURE_WORKER_SSH_TARGET:-}"
[[ -n "$ssh_target" ]] || die "CAPTURE_WORKER_SSH_TARGET is required"
ssh_port="${CAPTURE_WORKER_SSH_PORT:-22}"
[[ "$ssh_port" =~ ^[0-9]{1,5}$ ]] || die "invalid CAPTURE_WORKER_SSH_PORT"

ssh_args=(-p "$ssh_port" -o BatchMode=yes -o IdentitiesOnly=yes)
scp_args=(-P "$ssh_port" -o BatchMode=yes -o IdentitiesOnly=yes)
if [[ -n "${CAPTURE_WORKER_SSH_CONFIG:-}" ]]; then
  [[ -f "$CAPTURE_WORKER_SSH_CONFIG" ]] || die "SSH config file not found"
  ssh_args+=(-F "$CAPTURE_WORKER_SSH_CONFIG")
  scp_args+=(-F "$CAPTURE_WORKER_SSH_CONFIG")
fi

release_root="${CAPTURE_WORKER_RELEASE_ROOT:-/opt/tg-koll-capture-worker-code}"
runtime_root="${CAPTURE_WORKER_RUNTIME_ROOT:-/opt/tg-koll-capture-worker-runtime}"
container="${CAPTURE_WORKER_CONTAINER:-tg-koll-capture-worker}"
candidate_port="${CAPTURE_WORKER_CANDIDATE_PORT:-18093}"
[[ "$candidate_port" =~ ^[0-9]{2,5}$ ]] || die "invalid candidate port"

remote_archive="$release_root/incoming/${release_id}.tar.gz"
ssh "${ssh_args[@]}" "$ssh_target" bash -s -- "$release_root" "$release_id" <<'REMOTE_PREPARE'
set -euo pipefail
release_root="$1"
release_id="$2"
[[ "$(id -u)" -eq 0 ]] || { echo "old-host deployment requires root" >&2; exit 1; }
[[ "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$ ]] || exit 1
install -d -m 700 "$release_root/incoming" "$release_root/releases"
[[ ! -e "$release_root/releases/$release_id" ]] || {
  echo "release already exists: $release_id" >&2
  exit 1
}
REMOTE_PREPARE

scp "${scp_args[@]}" "$archive" "$ssh_target:$remote_archive"

ssh "${ssh_args[@]}" "$ssh_target" bash -s -- \
  "$release_root" "$runtime_root" "$release_id" "$archive_sha256" \
  "$container" "$candidate_port" <<'REMOTE_DEPLOY'
set -euo pipefail
umask 077

release_root="$1"
runtime_root="$2"
release_id="$3"
expected_archive_sha="$4"
container="$5"
candidate_port="$6"
archive="$release_root/incoming/${release_id}.tar.gz"
release_dir="$release_root/releases/$release_id"
lock_file="$release_root/deploy.lock"
data_root="/opt/tg-koll-capture-worker-data"
deps_root="/opt/tg-koll-web-console-deps/node_modules"
candidate="${container}-candidate-${release_id}"
rollback="${container}-rollback-${release_id}"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

cleanup_dir() {
  local path="${1:-}"
  [[ -n "$path" && -d "$path" && "$path" == "$release_root/candidate-state/"* ]] || return 0
  find "$path" -depth -mindepth 1 -delete
  rmdir -- "$path"
}

jobs_active() {
  podman exec "$container" /opt/venv/bin/python -c '
import os, sqlite3
p=os.environ.get("TG_FETCH_WORKER_DB", "/data/remote_fetch_worker/jobs.db")
c=sqlite3.connect(p, timeout=15)
print(c.execute("select count(*) from fetch_jobs where status in (\"queued\",\"running\")").fetchone()[0])
' 2>/dev/null
}

assert_idle() {
  local count
  count="$(jobs_active)" || die "unable to inspect worker job queue"
  [[ "$count" == "0" ]] || die "worker has $count queued/running jobs"
}

wait_health() {
  local port="$1"
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${port}/health" |
      grep -q '"service":"tg-koll-fetch-worker"'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

hmac_canary() {
  local target_container="$1"
  local expected_boundary="${2:-}"
  podman exec -i "$target_container" /opt/venv/bin/python - "$expected_boundary" <<'PY'
import json, os, secrets, sys, time, urllib.request
from webapp.remote_fetch_protocol import signed_headers

path = "/internal/worker/v1/capabilities"
keys_path = os.environ.get("TG_FETCH_WORKER_KEYS_FILE", "/data/internal/remote-fetch-keys.json")
with open(keys_path, "r", encoding="utf-8") as handle:
    keys = json.load(handle)
key_id = sorted(keys)[0]
headers = signed_headers(
    secret=str(keys[key_id]), key_id=key_id, method="GET", path=path,
    body=b"", timestamp=int(time.time()), nonce=secrets.token_urlsafe(24),
)
request = urllib.request.Request("http://127.0.0.1:8092" + path, headers=headers)
with urllib.request.urlopen(request, timeout=5) as response:
    payload = json.load(response)
if payload.get("ok") is not True or not isinstance(payload.get("capabilities"), list):
    raise SystemExit("invalid signed capability response")
if sys.argv[1] == "release":
    expected = [
        "crm.threads_live_search.v1",
        "persona.hot_candidates.v1",
        "persona.hot_post_metrics.v1",
    ]
    if payload.get("capabilities") != expected:
        raise SystemExit("unexpected worker capability boundary")
print("signed-capabilities-ok")
PY
}

prepare_execution_runtime() {
  local execution_dir="$1"
  local snapshot_container_dir="$2"
  [[ ! -e "$execution_dir" ]] || die "execution runtime already exists: $execution_dir"
  install -d -m 700 "$execution_dir/sentiment-opinx"
  local relative
  for relative in \
    persona_archives.json \
    persona_archives_cache.json \
    persona_groups.json \
    persona_memory.json; do
    ln -s "$snapshot_container_dir/$relative" "$execution_dir/$relative"
  done
  ln -s "$snapshot_container_dir/sentiment-opinx/sentiment-config.json" \
    "$execution_dir/sentiment-opinx/sentiment-config.json"
  printf 'snapshot=%s\n' "$snapshot_container_dir" >"$execution_dir/EXECUTION_RUNTIME_METADATA"
}

execution_runtime_canary() {
  local target_container="$1"
  local execution_dir="$2"
  local snapshot_dir="$3"
  podman exec "$target_container" /bin/sh -c '
    set -eu
    execution_dir="$1"
    snapshot_dir="$2"
    test -r "$execution_dir/persona_archives.json"
    test -r "$execution_dir/sentiment-opinx/sentiment-config.json"
    : >"$execution_dir/sentiment-hot-execution-stage-a.lock"
    rm -f "$execution_dir/sentiment-hot-execution-stage-a.lock"
    if (: >"$snapshot_dir/.stage-a-write-probe") 2>/dev/null; then
      rm -f "$snapshot_dir/.stage-a-write-probe"
      echo "authoritative runtime snapshot is writable" >&2
      exit 1
    fi
    test "$(sha256sum "$execution_dir/persona_archives.json" | cut -d " " -f 1)" = \
      "$(sha256sum "$snapshot_dir/persona_archives.json" | cut -d " " -f 1)"
  ' sh "$execution_dir" "$snapshot_dir"
  podman exec "$target_container" node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.env.TOOL_R18_RUNTIME_DIR;
    const archives = JSON.parse(fs.readFileSync(path.join(root, "persona_archives.json"), "utf8"));
    const config = JSON.parse(fs.readFileSync(process.env.TOOL_R18_SENTIMENT_CONFIG_PATH, "utf8"));
    if (!Array.isArray(archives) || !config || typeof config !== "object") process.exit(2);
    process.stdout.write("execution-runtime-ok\n");
  '
}

run_worker() {
  local name="$1"
  local code_dir="$2"
  local image="$3"
  local port="$4"
  local job_mount="$5"
  local execution_runtime_path="$6"
  local runtime_release_rel="$7"
  local -a args
  args=(
    run -d --name "$name" --restart unless-stopped
    --entrypoint /opt/venv/bin/uvicorn
    -p "127.0.0.1:${port}:8092"
    -v "$code_dir:/app:ro"
    -v "$deps_root:/app/tool_r18/node_modules:ro"
    -v "$data_root:/data:rw"
    -v "$runtime_root:/worker-runtime:ro"
    -e WEBAPP_DATA_DIR=/data/webapp_data
    -e "TG_FETCH_WORKER_DB=$job_mount"
    -e TG_FETCH_WORKER_AUTOCREATE=0
    -e "TOOL_R18_RUNTIME_DIR=$execution_runtime_path"
    # Both runtime paths deliberately resolve through the execution-runtime
    # symlinks. A later versioned runtime sync can then atomically move
    # /worker-runtime/current without recreating this container.
    -e "TOOL_R18_SENTIMENT_CONFIG_PATH=$execution_runtime_path/sentiment-opinx/sentiment-config.json"
    -e TG_FETCH_WORKER_KEYS_FILE=/data/internal/remote-fetch-keys.json
    -e COLLECTOR_DB_PATH=/collector/collector.db
    -e COLLECTOR_VAULT_KEY_FILE=/collector/collector_vault.key
    -e TG_COLLECTOR_POOL_REQUIRED=1
    -e TG_HOT_POOL_REFILL_SECONDS=21600
    -e TG_HOT_DISABLE_KEYWORD_MODEL=1
    -e TG_HOT_READER_INCLUDE_INSTAGRAM=0
    -v /opt/tg-koll-collector-admin-data/collector:/collector:rw
  )
  if [[ -f "$runtime_root/current/profiles/threads/current/cookies.sqlite" ]]; then
    args+=(-e "PERSONA_DASHBOARD_THREADS_PROFILE_DIR=/worker-runtime/current/profiles/threads/current")
  fi
  if [[ -f "$runtime_root/current/profiles/instagram/current/cookies.sqlite" ]]; then
    args+=(-e "PERSONA_DASHBOARD_INSTAGRAM_PROFILE_DIR=/worker-runtime/current/profiles/instagram/current")
  fi
  args+=("$image" webapp.worker_server:create_worker_app --factory --host 0.0.0.0 --port 8092)
  # Do not let conmon inherit the deployment flock for the lifetime of the
  # production container; only this deployment shell should own fd 9.
  podman "${args[@]}" 9>&-
}

rollback_container() {
  local failed_name="$container-failed-$release_id"
  podman stop -t 10 "$container" >/dev/null 2>&1 || true
  podman rename "$container" "$failed_name" >/dev/null 2>&1 || true
  podman rename "$rollback" "$container"
  podman start "$container" >/dev/null
  wait_health 8092 || die "rollback container did not recover health"
  hmac_canary "$container" >/dev/null || die "rollback HMAC canary failed"
}

command -v flock >/dev/null 2>&1 || die "flock is required"
command -v podman >/dev/null 2>&1 || die "podman is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v ss >/dev/null 2>&1 || die "ss is required for candidate port validation"
exec 9>"$lock_file"
flock -n 9 || die "another capture-worker deployment is running"

[[ "$(id -u)" -eq 0 ]] || die "old-host deployment requires root"
[[ -f "$archive" ]] || die "uploaded archive not found"
[[ "$(sha256sum "$archive" | awk '{print $1}')" == "$expected_archive_sha" ]] ||
  die "uploaded archive checksum mismatch"
[[ -d "$runtime_root/current/tool_r18_runtime" ]] ||
  die "versioned runtime is missing; run sync_capture_worker_runtime.sh first"
runtime_release_rel="$(readlink "$runtime_root/current")"
[[ "$runtime_release_rel" =~ ^releases/[A-Za-z0-9][A-Za-z0-9._-]{7,79}$ ]] ||
  die "runtime current does not point to a safe versioned release"
runtime_snapshot_host="$runtime_root/$runtime_release_rel/tool_r18_runtime"
# Keep the host-side pinned path for deployment validation, but make the
# container-side execution links follow the atomically switched current
# pointer. This is what allows sync_capture_worker_runtime.sh to take effect
# on the already-running worker.
runtime_snapshot_container="/worker-runtime/current/tool_r18_runtime"
[[ -d "$runtime_snapshot_host" ]] || die "pinned runtime snapshot is missing"
[[ -f "$data_root/internal/remote-fetch-keys.json" ]] || die "worker key file is missing"
[[ -d "$deps_root" ]] || die "worker node_modules mount is missing"

# Candidate pools belong to the old collector and must survive code/runtime
# releases. Only the authoritative persona/config files follow the versioned
# snapshot; candidate shards, Reader cache and scheduler state remain here.
stable_hot_runtime="$data_root/collector-hot-runtime"
install -d -m 700 "$stable_hot_runtime/sentiment-opinx"
for relative in persona_archives.json persona_archives_cache.json persona_groups.json persona_memory.json; do
  ln -sfn "$runtime_snapshot_container/$relative" "$stable_hot_runtime/$relative"
done
ln -sfn "$runtime_snapshot_container/sentiment-opinx/sentiment-config.json" \
  "$stable_hot_runtime/sentiment-opinx/sentiment-config.json"

if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  die "unsafe archive member"
fi
extract_root="$(mktemp -d "$release_root/.extract-${release_id}.XXXXXXXX")"
trap 'cleanup_dir "${candidate_state:-}"; if [[ -d "${extract_root:-}" ]]; then find "$extract_root" -depth -mindepth 1 -delete; rmdir "$extract_root"; fi' EXIT
tar -C "$extract_root" --no-same-owner -xzf "$archive"
[[ -d "$extract_root/$release_id" ]] || die "release archive root mismatch"
(
  cd "$extract_root/$release_id"
  sha256sum -c SHA256SUMS >/dev/null
)
chmod -R go-rwx "$extract_root/$release_id"
mv "$extract_root/$release_id" "$release_dir"

podman container exists "$container" || die "existing worker container not found"
podman container exists "$rollback" && die "rollback container name already exists"
podman container exists "$candidate" && die "candidate container name already exists"
if ss -H -ltn | awk '{print $4}' | grep -Eq "(^|:)$candidate_port$"; then
  die "candidate port $candidate_port is already listening"
fi
assert_idle
image="$(podman inspect --format '{{.Config.Image}}' "$container")"
[[ -n "$image" ]] || die "unable to resolve current worker image"

install -d -m 700 "$release_root/candidate-state"
candidate_state="$(mktemp -d "$release_root/candidate-state/${release_id}.XXXXXXXX")"
install -d -m 700 "$candidate_state/remote_fetch_worker"
candidate_execution="$candidate_state/execution-runtime"
prepare_execution_runtime "$candidate_execution" "$runtime_snapshot_container"
production_execution="$data_root/execution-runtime-releases/$release_id/tool_r18_runtime"
install -d -m 700 "$data_root/execution-runtime-releases/$release_id"
prepare_execution_runtime "$production_execution" "$runtime_snapshot_container"

# Candidate uses a separate job DB and the real key file. This exercises import,
# startup, health and HMAC without touching the production queue.
podman run -d --name "$candidate" --restart=no \
  --entrypoint /opt/venv/bin/uvicorn \
  -p "127.0.0.1:${candidate_port}:8092" \
  -v "$release_dir:/app:ro" \
  -v "$deps_root:/app/tool_r18/node_modules:ro" \
  -v "$data_root:/data:rw" \
  -v "$candidate_state/remote_fetch_worker:/data/remote_fetch_worker:rw" \
  -v "$runtime_root:/worker-runtime:ro" \
  -v "$candidate_execution:/execution-runtime:rw" \
  -e WEBAPP_DATA_DIR=/data/webapp_data \
  -e TG_FETCH_WORKER_DB=/data/remote_fetch_worker/jobs.db \
  -e TG_FETCH_WORKER_KEYS_FILE=/data/internal/remote-fetch-keys.json \
  -e TOOL_R18_RUNTIME_DIR=/execution-runtime \
  -e "TOOL_R18_SENTIMENT_CONFIG_PATH=/execution-runtime/sentiment-opinx/sentiment-config.json" \
  "$image" webapp.worker_server:create_worker_app --factory --host 0.0.0.0 --port 8092 \
  9>&- >/dev/null
if ! wait_health "$candidate_port" || \
   ! hmac_canary "$candidate" release >/dev/null || \
   ! execution_runtime_canary "$candidate" /execution-runtime "$runtime_snapshot_container" >/dev/null; then
  podman logs --tail 80 "$candidate" >&2 || true
  podman stop -t 10 "$candidate" >/dev/null 2>&1 || true
  podman rm "$candidate" >/dev/null 2>&1 || true
  die "candidate health/HMAC canary failed; production was not switched"
fi
podman stop -t 10 "$candidate" >/dev/null
podman rm "$candidate" >/dev/null
cleanup_dir "$candidate_state"
candidate_state=""

assert_idle
podman stop -t 30 "$container" >/dev/null
podman rename "$container" "$rollback"

production_execution_container="/data/execution-runtime-releases/$release_id/tool_r18_runtime"
if ! run_worker "$container" "$release_dir" "$image" 8092 \
  /data/remote_fetch_worker/jobs.db /data/collector-hot-runtime "$runtime_release_rel" >/dev/null; then
  rollback_container
  die "new worker failed to start; previous container restored"
fi

if ! wait_health 8092 || \
   ! hmac_canary "$container" release >/dev/null || \
   ! execution_runtime_canary "$container" /data/collector-hot-runtime "$runtime_snapshot_container" >/dev/null; then
  podman logs --tail 100 "$container" >&2 || true
  rollback_container
  die "new worker failed health/HMAC canary; previous container restored"
fi

next_link="$release_root/.current-${release_id}"
ln -s "releases/$release_id" "$next_link"
mv -Tf "$next_link" "$release_root/current"
sha256sum "$archive" >"$release_root/releases/$release_id/ARCHIVE_SHA256"
printf 'Deployed worker release %s; rollback container retained as %s\n' "$release_id" "$rollback"
REMOTE_DEPLOY

printf 'Worker release %s deployed. Local archive SHA256: %s\n' "$release_id" "$archive_sha256"
