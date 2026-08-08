MODDIR=${0%/*}
CONFIG_DIR=/data/adb/tricky_store
cd $MODDIR

if [ -f "$MODDIR/verify_integrity.sh" ]; then
  sh "$MODDIR/verify_integrity.sh" "$MODDIR" "$CONFIG_DIR/module_integrity_status"
else
  mkdir -p "$CONFIG_DIR"
  printf '%s\n' unavailable > "$CONFIG_DIR/module_integrity_status"
fi

# Fork-based supervisor for instant restart
./supervisor ./daemon "$MODDIR" &

# Debug builds ship diag.sh; its presence enables the external-storage diagnostic plane.
if [ -f "$MODDIR/diag.sh" ]; then
  . "$MODDIR/diag.sh"
  diag_setup
fi

# Clear logd size persist properties once boot completes
(
  until [ "$(getprop sys.boot_completed)" = "1" ]; do
    sleep 1
  done
  setprop persist.logd.size ""
  setprop persist.logd.size.crash ""
  setprop persist.logd.size.system ""
  setprop persist.logd.size.main ""
) &
