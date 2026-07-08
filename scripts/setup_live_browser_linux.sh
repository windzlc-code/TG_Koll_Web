#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This setup script is only for Linux." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "Only apt-based Linux distributions are supported by this helper." >&2
  exit 1
fi

KASMVNC_DEB_URL="${KASMVNC_DEB_URL:-https://github.com/kasmtech/KasmVNC/releases/download/v1.4.0/kasmvncserver_bookworm_1.4.0_amd64.deb}"
KASMVNC_DEB_SHA256="${KASMVNC_DEB_SHA256:-a059b9db8d93a7d8bb753e9cf2b119b132c8cf0d832b549a1287b81be68e956a}"

sudo apt-get update
sudo apt-get install -y ca-certificates curl

tmp_deb="$(mktemp /tmp/kasmvncserver.XXXXXX.deb)"
trap 'rm -f "$tmp_deb"' EXIT
curl -fL --retry 3 -o "$tmp_deb" "$KASMVNC_DEB_URL"
echo "$KASMVNC_DEB_SHA256  $tmp_deb" | sha256sum -c -
sudo apt-get install -y "$tmp_deb"

echo "Live browser dependencies installed: KasmVNC"
