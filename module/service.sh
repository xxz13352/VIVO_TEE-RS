MODDIR=${0%/*}
CONFIG_DIR=/data/adb/tricky_store
cd "$MODDIR" || exit 0

mkdir -p "$CONFIG_DIR"
printf '%s\n' verifying > "$CONFIG_DIR/license_status"

if [ ! -x "$MODDIR/supervisor" ] || ! "$MODDIR/supervisor" --verify-install "$MODDIR"; then
  printf '%s\n' modified > "$CONFIG_DIR/module_integrity_status"
  printf '%s\n' unavailable > "$CONFIG_DIR/license_status"
  exit 0
fi
printf '%s\n' verified > "$CONFIG_DIR/module_integrity_status"

if [ ! -x "$MODDIR/daemon" ] || ! "$MODDIR/daemon" "$MODDIR" --license-preflight >/dev/null 2>&1; then
  status=$(cat "$CONFIG_DIR/license_status" 2>/dev/null || printf '%s' unavailable)
  [ -n "$status" ] || status=unavailable
  printf '%s\n' "$status" > "$CONFIG_DIR/license_status"
  exit 0
fi

"$MODDIR/supervisor" "$MODDIR/daemon" "$MODDIR" &

if [ -f "$MODDIR/diag.sh" ]; then
  . "$MODDIR/diag.sh"
  diag_setup
fi

(
  until [ "$(getprop sys.boot_completed)" = "1" ]; do
    sleep 1
  done
  setprop persist.logd.size ""
  setprop persist.logd.size.crash ""
  setprop persist.logd.size.system ""
  setprop persist.logd.size.main ""
) &
