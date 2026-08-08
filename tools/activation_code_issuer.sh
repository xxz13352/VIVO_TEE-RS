#!/usr/bin/env sh

# Create a device-bound offline activation code from the SHA-256 fingerprint
# displayed by the KernelSU WebUI. The issuer private key never leaves this PC.
set -eu

usage() {
  echo "Usage: $0 <fingerprint> [output.lic] [license-id] [days]" >&2
  echo "Set LICENSE_PRIVATE_KEY to override ~/.teesimulator-rs/license-private.pem." >&2
}

if [ "$#" -lt 1 ] || [ "$#" -gt 4 ]; then
  usage
  exit 2
fi

FINGERPRINT=$1
OUTPUT=${2:-activation.lic}
LICENSE_ID=${3:-offline-$(date +%Y%m%d)}
DAYS=${4:-365}

if [ "${#FINGERPRINT}" -ne 64 ] || ! printf '%s' "$FINGERPRINT" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "fingerprint must be exactly 64 lowercase hexadecimal characters" >&2
  exit 2
fi

case "$DAYS" in
  ''|*[!0-9]*|0)
    echo "days must be a positive integer" >&2
    exit 2
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PRIVATE_KEY=${LICENSE_PRIVATE_KEY:-"$HOME/.teesimulator-rs/license-private.pem"}
PYTHON_BIN=${PYTHON:-python3}

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  PYTHON_BIN=python
fi

if [ ! -r "$PRIVATE_KEY" ]; then
  echo "issuer private key is not readable: $PRIVATE_KEY" >&2
  exit 1
fi

exec "$PYTHON_BIN" "$SCRIPT_DIR/license_issuer.py" issue \
  --private-key "$PRIVATE_KEY" \
  --fingerprint "$FINGERPRINT" \
  --out "$OUTPUT" \
  --license-id "$LICENSE_ID" \
  --days "$DAYS"
