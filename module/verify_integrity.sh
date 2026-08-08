#!/system/bin/sh

MODDIR=$1
STATUS_FILE=$2
MANIFEST="$MODDIR/integrity.sha256"

write_status() {
  mkdir -p "$(dirname "$STATUS_FILE")"
  printf '%s\n' "$1" > "$STATUS_FILE.tmp" && mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

if [ ! -f "$MANIFEST" ] || ! command -v sha256sum >/dev/null 2>&1; then
  write_status unavailable
  exit 0
fi

status=verified
entries=0
while IFS=' ' read -r expected relative_path; do
  [ -n "$expected" ] || continue
  entries=$((entries + 1))
  case "$expected" in
    ""|*[!0123456789abcdef]*)
      status=modified
      break
      ;;
  esac
  case "$relative_path" in
    ""|/*|../*|*/../*|*/..)
      status=modified
      break
      ;;
  esac
  actual=$(sha256sum "$MODDIR/$relative_path" 2>/dev/null | cut -d ' ' -f 1)
  if [ "$actual" != "$expected" ]; then
    status=modified
    break
  fi
done < "$MANIFEST"

if [ "$entries" -eq 0 ]; then
  status=unavailable
fi

write_status "$status"
