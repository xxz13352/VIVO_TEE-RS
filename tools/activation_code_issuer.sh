#!/usr/bin/env sh

set -eu

usage() {
  echo "Usage: $0 [fingerprint] [output.lic] [license-id] [days]" >&2
  echo "Set LICENSE_PRIVATE_KEY to override ~/.teesimulator-rs/license-private.pem." >&2
}

prompt_value() {
  label=$1
  default=${2-}
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$label" "$default" >&2
  else
    printf '%s: ' "$label" >&2
  fi
  value=
  if ! IFS= read -r value; then
    echo "interactive input ended before all fields were entered" >&2
    exit 2
  fi
  if [ -z "$value" ]; then
    value=$default
  fi
  printf '%s' "$value"
}

if [ "$#" -gt 4 ]; then
  usage
  exit 2
fi

INTERACTIVE=0
if [ "$#" -eq 0 ]; then
  INTERACTIVE=1
  FINGERPRINT=$(prompt_value '设备指纹（64位小写SHA-256）')
  OUTPUT=$(prompt_value '输出文件' 'activation.lic')
  LICENSE_ID=$(prompt_value '许可证 ID' "offline-$(date +%Y%m%d)")
  DAYS=$(prompt_value '有效天数' '365')
else
  FINGERPRINT=$1
  OUTPUT=${2:-activation.lic}
  LICENSE_ID=${3:-offline-$(date +%Y%m%d)}
  DAYS=${4:-365}
fi

while :; do
  valid=1
  case "$FINGERPRINT" in
    *[!0123456789abcdef]*|'') valid=0 ;;
  esac
  if [ "${#FINGERPRINT}" -ne 64 ]; then valid=0; fi
  if [ "$valid" -eq 1 ]; then break; fi
  echo "fingerprint must be exactly 64 lowercase hexadecimal characters" >&2
  if [ "$INTERACTIVE" -eq 0 ]; then exit 2; fi
  FINGERPRINT=$(prompt_value '请重新输入设备指纹（64位小写SHA-256）')
done

while :; do
  case "$DAYS" in
    ''|*[!0-9]*|0) valid=0 ;;
    *) valid=1 ;;
  esac
  if [ "$valid" -eq 1 ]; then break; fi
  echo "days must be a positive integer" >&2
  if [ "$INTERACTIVE" -eq 0 ]; then exit 2; fi
  DAYS=$(prompt_value '请重新输入有效天数' '365')
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PRIVATE_KEY=${LICENSE_PRIVATE_KEY:-${HOME:-.}/.teesimulator-rs/license-private.pem}
PYTHON_BIN=${PYTHON:-python3}

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1 || ! "$PYTHON_BIN" -c 'import sys' >/dev/null 2>&1; then
  PYTHON_BIN=python
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1 || ! "$PYTHON_BIN" -c 'import sys' >/dev/null 2>&1; then
  echo "python interpreter is not available" >&2
  exit 1
fi

if [ ! -f "$PRIVATE_KEY" ] || [ ! -r "$PRIVATE_KEY" ]; then
  echo "issuer private key is not readable: $PRIVATE_KEY" >&2
  exit 1
fi

exec "$PYTHON_BIN" "$SCRIPT_DIR/license_issuer.py" issue \
  --private-key "$PRIVATE_KEY" \
  --fingerprint "$FINGERPRINT" \
  --out "$OUTPUT" \
  --license-id "$LICENSE_ID" \
  --days "$DAYS"
