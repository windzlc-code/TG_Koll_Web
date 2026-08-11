#!/usr/bin/env bash
set -euo pipefail

umask 077

usage() {
  cat <<'EOF'
Build and sync an allowlisted capture-worker runtime snapshot.

Usage:
  sync_capture_worker_runtime.sh [--snapshot-id ID]
  sync_capture_worker_runtime.sh --build-only OUTPUT_TAR [--snapshot-id ID]

Required:
  CAPTURE_RUNTIME_SOURCE_DIR      New-host TOOL_R18_RUNTIME_DIR

Required for deployment:
  CAPTURE_WORKER_SSH_TARGET       SSH destination, for example root@old-worker

Optional profile snapshots (paths must stay below CAPTURE_PROFILE_SOURCE_ROOT):
  CAPTURE_PROFILE_SOURCE_ROOT     Usually /data/webapp_data/social_automation/profiles
  CAPTURE_THREADS_PROFILE_SOURCE Relative path to exactly one Threads profile
  CAPTURE_INSTAGRAM_PROFILE_SOURCE Relative path to exactly one Instagram profile

Only empty persona JSON scaffolds, an allowlisted Threads/Instagram capture
configuration, and consistent snapshots of explicitly selected cookies.sqlite
files are included. app.db, jobs.db,
publish_queue.db and every other runtime/database file are excluded.
Profiles are opt-in and limited to one explicitly selected profile per platform;
this does not migrate or validate all existing Threads/Instagram accounts.
EOF
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

cleanup_tree() {
  local path="${1:-}"
  [[ -n "$path" && -d "$path" && "$path" == /tmp/tg-capture-worker-runtime.* ]] || return 0
  find "$path" -depth -mindepth 1 -delete
  rmdir -- "$path"
}

validate_id() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$ ]] || die "snapshot id must be 8-80 safe characters"
}

snapshot_id=""
build_only=""
while (($#)); do
  case "$1" in
    --snapshot-id)
      (($# >= 2)) || die "--snapshot-id requires a value"
      snapshot_id="$2"
      shift 2
      ;;
    --build-only)
      (($# >= 2)) || die "--build-only requires an output path"
      build_only="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_command tar
require_command sha256sum
require_command python3
require_command realpath

source_runtime="${CAPTURE_RUNTIME_SOURCE_DIR:-}"
[[ -n "$source_runtime" ]] || die "CAPTURE_RUNTIME_SOURCE_DIR is required"
[[ -d "$source_runtime" ]] || die "runtime source directory not found"
source_runtime="$(realpath "$source_runtime")"

if [[ -z "$snapshot_id" ]]; then
  snapshot_id="$(date -u +%Y%m%dT%H%M%SZ)-runtime"
fi
validate_id "$snapshot_id"

work_dir="$(mktemp -d /tmp/tg-capture-worker-runtime.XXXXXXXX)"
trap 'cleanup_tree "$work_dir"' EXIT
stage_dir="$work_dir/$snapshot_id"
mkdir -p "$stage_dir/tool_r18_runtime/sentiment-opinx"

sentiment_source="${CAPTURE_SENTIMENT_CONFIG_SOURCE:-$source_runtime/sentiment-opinx/sentiment-config.json}"
[[ -f "$sentiment_source" ]] || die "sentiment config not found: $sentiment_source"
sentiment_source="$(realpath "$sentiment_source")"

# Require a stable set across the copy window. This avoids publishing a file
# while the application is rewriting it, without taking application locks.
stable=0
for attempt in 1 2 3; do
  before="$work_dir/source-before-$attempt"
  after="$work_dir/source-after-$attempt"
  : >"$before"
  sha256sum "$sentiment_source" >>"$before"

  printf '[]\n' >"$stage_dir/tool_r18_runtime/persona_archives.json"
  printf '{}\n' >"$stage_dir/tool_r18_runtime/persona_archives_cache.json"
  printf '{}\n' >"$stage_dir/tool_r18_runtime/persona_groups.json"
  printf '{}\n' >"$stage_dir/tool_r18_runtime/persona_memory.json"
  python3 - "$sentiment_source" "$stage_dir/tool_r18_runtime/sentiment-opinx/sentiment-config.json" <<'PY'
import json, pathlib, sys

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
with source.open("r", encoding="utf-8") as handle:
    raw = json.load(handle)

profiles = (((raw.get("sentimentSearch") or {}).get("browserFallback") or {}).get("profiles") or [])
allowed_fields = {
    "key", "platform", "sourceKey", "domain", "authUrl", "authUrls",
    "cookieDomains", "matchDomains", "urlTemplate", "linkPattern", "cookies",
}
allowed_platforms = {"threads", "instagram"}
allowed_cookie_fields = {
    "name", "value", "domain", "path", "expires", "expirationDate",
    "httpOnly", "secure", "sameSite", "hostOnly", "session",
}
blocked_cookie_names = {"authhelpertoken", "api_token", "api_key", "apikey", "llm_key"}
filtered = []
for profile in profiles if isinstance(profiles, list) else []:
    if not isinstance(profile, dict):
        continue
    identities = {
        str(profile.get(field) or "").strip().lower()
        for field in ("key", "platform", "sourceKey")
    }
    if not identities.intersection(allowed_platforms):
        continue
    clean_profile = {}
    for key in allowed_fields:
        if key not in profile:
            continue
        value = profile[key]
        if key == "cookies":
            clean_cookies = []
            for cookie in value if isinstance(value, list) else []:
                if not isinstance(cookie, dict):
                    continue
                cookie_name = str(cookie.get("name") or "").strip().lower()
                if cookie_name in blocked_cookie_names:
                    continue
                clean_cookies.append({
                    field: cookie[field]
                    for field in allowed_cookie_fields
                    if field in cookie and isinstance(cookie[field], (str, bool, int, float))
                })
            clean_profile[key] = clean_cookies
        elif isinstance(value, (str, bool, int, float)):
            clean_profile[key] = value
        elif isinstance(value, list) and all(isinstance(item, str) for item in value):
            clean_profile[key] = list(value)
    filtered.append(clean_profile)

payload = {"sentimentSearch": {"browserFallback": {"profiles": filtered}}}
destination.write_text(
    json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY

  : >"$after"
  sha256sum "$sentiment_source" >>"$after"
  if cmp -s "$before" "$after"; then
    stable=1
    break
  fi
  sleep 1
done
[[ "$stable" == "1" ]] || die "runtime files changed during all snapshot attempts"

python3 - "$stage_dir" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]) / "tool_r18_runtime"
for path in [
    root / "persona_archives.json",
    root / "persona_archives_cache.json",
    root / "persona_groups.json",
    root / "persona_memory.json",
    root / "sentiment-opinx" / "sentiment-config.json",
]:
    with path.open("r", encoding="utf-8") as handle:
        json.load(handle)
if json.loads((root / "persona_archives.json").read_text(encoding="utf-8")) != []:
    raise SystemExit("persona archive scaffold must be empty")
for name in ("persona_archives_cache.json", "persona_groups.json", "persona_memory.json"):
    if json.loads((root / name).read_text(encoding="utf-8")) != {}:
        raise SystemExit(f"{name} scaffold must be empty")
PY

snapshot_profile() {
  local platform="$1"
  local relative="$2"
  local profile_root="${CAPTURE_PROFILE_SOURCE_ROOT:-}"
  [[ -n "$profile_root" ]] || die "CAPTURE_PROFILE_SOURCE_ROOT is required when syncing a profile"
  [[ -d "$profile_root" ]] || die "profile source root not found"
  profile_root="$(realpath "$profile_root")"
  [[ "$relative" != /* ]] || die "unsafe $platform profile path"
  local profile_dir
  profile_dir="$(python3 - "$profile_root" "$relative" <<'PY'
import os, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
candidate = (root / sys.argv[2]).resolve()
if os.path.commonpath((str(root), str(candidate))) != str(root) or candidate == root:
    raise SystemExit("profile path escapes source root")
print(candidate)
PY
)" || die "$platform profile escapes source root"
  [[ -f "$profile_dir/cookies.sqlite" ]] || die "$platform profile has no cookies.sqlite"
  local destination="$stage_dir/profiles/$platform/current"
  mkdir -p "$destination"
  python3 - "$profile_dir/cookies.sqlite" "$destination/cookies.sqlite" <<'PY'
import sqlite3, sys
source, destination = sys.argv[1:]
src = sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=15)
dst = sqlite3.connect(destination, timeout=15)
try:
    src.backup(dst)
    row = dst.execute("PRAGMA integrity_check").fetchone()
    if not row or row[0] != "ok":
        raise SystemExit("cookie database snapshot failed integrity_check")
finally:
    dst.close()
    src.close()
PY
  printf '%s\n' "$relative" >"$destination/SOURCE_PROFILE_RELATIVE_PATH"
}

if [[ -n "${CAPTURE_THREADS_PROFILE_SOURCE:-}" ]]; then
  snapshot_profile threads "$CAPTURE_THREADS_PROFILE_SOURCE"
fi
if [[ -n "${CAPTURE_INSTAGRAM_PROFILE_SOURCE:-}" ]]; then
  snapshot_profile instagram "$CAPTURE_INSTAGRAM_PROFILE_SOURCE"
fi

if find "$stage_dir" -type f \( \
    -iname 'app.db' -o -iname 'jobs.db' -o -iname 'publish_queue.db' -o \
    -iname '*.sqlite-wal' -o -iname '*.sqlite-shm' -o -iname '.env' -o \
    -iname '*remote-fetch-keys*' -o -iname '*password*vault*' \
  \) -print -quit | grep -q .; then
  die "runtime snapshot contains forbidden database or credential material"
fi

cat >"$stage_dir/SNAPSHOT_METADATA" <<EOF
snapshot_id=$snapshot_id
created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
format=tg-koll-capture-worker-runtime-v1
EOF

(
  cd "$stage_dir"
  find . -type f ! -name SHA256SUMS -print0 |
    LC_ALL=C sort -z |
    xargs -0 -r sha256sum >SHA256SUMS
  sha256sum -c SHA256SUMS >/dev/null
)

archive="$work_dir/${snapshot_id}.tar.gz"
tar -C "$work_dir" -czf "$archive" "$snapshot_id"
archive_sha256="$(sha256sum "$archive" | awk '{print $1}')"

if [[ -n "$build_only" ]]; then
  mkdir -p "$(dirname "$build_only")"
  cp -- "$archive" "$build_only"
  chmod 600 "$build_only"
  printf 'Built runtime snapshot %s\nArchive: %s\nSHA256: %s\n' \
    "$snapshot_id" "$build_only" "$archive_sha256"
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

runtime_root="${CAPTURE_WORKER_RUNTIME_ROOT:-/opt/tg-koll-capture-worker-runtime}"
container="${CAPTURE_WORKER_CONTAINER:-tg-koll-capture-worker}"
remote_archive="$runtime_root/incoming/${snapshot_id}.tar.gz"

ssh "${ssh_args[@]}" "$ssh_target" bash -s -- "$runtime_root" "$snapshot_id" <<'REMOTE_PREPARE'
set -euo pipefail
runtime_root="$1"
snapshot_id="$2"
[[ "$(id -u)" -eq 0 ]] || { echo "old-host runtime sync requires root" >&2; exit 1; }
[[ "$snapshot_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$ ]] || exit 1
install -d -m 700 "$runtime_root/incoming" "$runtime_root/releases"
[[ ! -e "$runtime_root/releases/$snapshot_id" ]] || {
  echo "runtime snapshot already exists: $snapshot_id" >&2
  exit 1
}
REMOTE_PREPARE

scp "${scp_args[@]}" "$archive" "$ssh_target:$remote_archive"

ssh "${ssh_args[@]}" "$ssh_target" bash -s -- \
  "$runtime_root" "$snapshot_id" "$archive_sha256" "$container" <<'REMOTE_SYNC'
set -euo pipefail
umask 077
runtime_root="$1"
snapshot_id="$2"
expected_archive_sha="$3"
container="$4"
archive="$runtime_root/incoming/${snapshot_id}.tar.gz"
release_dir="$runtime_root/releases/$snapshot_id"
lock_file="$runtime_root/sync.lock"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

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

health_canary() {
  curl -fsS --max-time 5 http://127.0.0.1:8092/health |
    grep -q '"service":"tg-koll-fetch-worker"'
}

hmac_canary() {
  podman exec -i "$container" /opt/venv/bin/python - <<'PY'
import json, os, secrets, time, urllib.request
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
if payload.get("ok") is not True:
    raise SystemExit("signed canary returned invalid response")
print("signed-capabilities-ok")
PY
}

snapshot_canary() {
  local image="$1"
  podman run --rm --restart=no -i \
    --entrypoint /opt/venv/bin/python \
    -v "$runtime_root:/worker-runtime:ro" \
    "$image" - <<'PY'
import hashlib, json, pathlib, sqlite3

root = pathlib.Path("/worker-runtime/current")
manifest = root / "SHA256SUMS"
if not root.is_dir() or not manifest.is_file():
    raise SystemExit("runtime current/manifest is not readable")
for line in manifest.read_text(encoding="utf-8").splitlines():
    expected, relative = line.split(maxsplit=1)
    relative = relative.lstrip("* ")
    path = (root / relative).resolve()
    if root.resolve() not in path.parents:
        raise SystemExit("manifest path escapes runtime snapshot")
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"runtime checksum mismatch: {relative}")

runtime = root / "tool_r18_runtime"
json_paths = [
    runtime / "persona_archives.json",
    runtime / "persona_archives_cache.json",
    runtime / "persona_groups.json",
    runtime / "persona_memory.json",
    runtime / "sentiment-opinx" / "sentiment-config.json",
]
parsed = []
for path in json_paths:
    with path.open("r", encoding="utf-8") as handle:
        parsed.append(json.load(handle))
if parsed[0] != []:
    raise SystemExit("persona archive scaffold must be empty")
if any(value != {} for value in parsed[1:4]):
    raise SystemExit("persona cache/group/memory scaffolds must be empty")
if not isinstance(parsed[-1], dict):
    raise SystemExit("sentiment config must be a JSON object")
profiles = (((parsed[-1].get("sentimentSearch") or {}).get("browserFallback") or {}).get("profiles") or [])
allowed_fields = {
    "key", "platform", "sourceKey", "domain", "authUrl", "authUrls",
    "cookieDomains", "matchDomains", "urlTemplate", "linkPattern", "cookies",
}
allowed_cookie_fields = {
    "name", "value", "domain", "path", "expires", "expirationDate",
    "httpOnly", "secure", "sameSite", "hostOnly", "session",
}
blocked_cookie_names = {"authhelpertoken", "api_token", "api_key", "apikey", "llm_key"}
for profile in profiles:
    if not isinstance(profile, dict) or not set(profile).issubset(allowed_fields):
        raise SystemExit("sentiment profile contains a non-allowlisted field")
    identities = {
        str(profile.get(field) or "").strip().lower()
        for field in ("key", "platform", "sourceKey")
    }
    if not identities.intersection({"threads", "instagram"}):
        raise SystemExit("sentiment profile is not a Threads/Instagram capture profile")
    cookies = profile.get("cookies") if isinstance(profile.get("cookies"), list) else []
    for cookie in cookies:
        if not isinstance(cookie, dict) or not set(cookie).issubset(allowed_cookie_fields):
            raise SystemExit("sentiment cookie contains a non-allowlisted field")
        if str(cookie.get("name") or "").strip().lower() in blocked_cookie_names:
            raise SystemExit("sentiment cookie contains a blocked secret name")

for cookie_db in root.glob("profiles/*/current/cookies.sqlite"):
    connection = sqlite3.connect(f"file:{cookie_db}?mode=ro", uri=True, timeout=10)
    try:
        result = connection.execute("PRAGMA integrity_check").fetchone()
        if not result or result[0] != "ok":
            raise SystemExit(f"cookie database integrity failure: {cookie_db.parent.parent.name}")
        connection.execute("SELECT count(*) FROM moz_cookies").fetchone()
    finally:
        connection.close()
print("runtime-snapshot-ok")
PY
}

command -v flock >/dev/null 2>&1 || die "flock is required"
command -v podman >/dev/null 2>&1 || die "podman is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
exec 9>"$lock_file"
flock -n 9 || die "another runtime sync is running"

[[ "$(id -u)" -eq 0 ]] || die "old-host runtime sync requires root"
[[ -f "$archive" ]] || die "uploaded runtime archive not found"
[[ "$(sha256sum "$archive" | awk '{print $1}')" == "$expected_archive_sha" ]] ||
  die "runtime archive checksum mismatch"
podman container exists "$container" || die "worker container not found"
assert_idle
image="$(podman inspect --format '{{.Config.Image}}' "$container")"
[[ -n "$image" ]] || die "unable to resolve current worker image"

if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  die "unsafe runtime archive member"
fi
extract_root="$(mktemp -d "$runtime_root/.extract-${snapshot_id}.XXXXXXXX")"
trap 'if [[ -d "${extract_root:-}" ]]; then find "$extract_root" -depth -mindepth 1 -delete; rmdir "$extract_root"; fi' EXIT
tar -C "$extract_root" --no-same-owner -xzf "$archive"
[[ -d "$extract_root/$snapshot_id" ]] || die "runtime archive root mismatch"
(
  cd "$extract_root/$snapshot_id"
  sha256sum -c SHA256SUMS >/dev/null
)
chmod -R go-rwx "$extract_root/$snapshot_id"
mv "$extract_root/$snapshot_id" "$release_dir"

assert_idle
previous_target=""
if [[ -L "$runtime_root/current" ]]; then
  previous_target="$(readlink "$runtime_root/current")"
elif [[ -e "$runtime_root/current" ]]; then
  die "runtime current exists but is not a symlink"
fi

next_link="$runtime_root/.current-${snapshot_id}"
ln -s "releases/$snapshot_id" "$next_link"
mv -Tf "$next_link" "$runtime_root/current"

if ! snapshot_canary "$image" >/dev/null || ! health_canary || ! hmac_canary >/dev/null; then
  if [[ -n "$previous_target" ]]; then
    rollback_link="$runtime_root/.rollback-${snapshot_id}"
    ln -s "$previous_target" "$rollback_link"
    mv -Tf "$rollback_link" "$runtime_root/current"
  else
    failed_link="$runtime_root/current-failed-${snapshot_id}"
    mv -T "$runtime_root/current" "$failed_link"
  fi
  die "runtime health/HMAC canary failed; current pointer rolled back"
fi

sha256sum "$archive" >"$release_dir/ARCHIVE_SHA256"
printf 'Activated runtime snapshot %s\n' "$snapshot_id"
REMOTE_SYNC

printf 'Runtime snapshot %s synced. Local archive SHA256: %s\n' "$snapshot_id" "$archive_sha256"
