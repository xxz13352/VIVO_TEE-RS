MODDIR=${0%/*}
CONFIG_DIR=/data/adb/tricky_store
cd $MODDIR

update_integrity_manifest() {
  [ -f "$MODDIR/integrity.sha256" ] || return 0
  checksum=$(sha256sum "$MODDIR/module.prop" 2>/dev/null | awk '{print $1}')
  [ -n "$checksum" ] || return 0
  awk -v checksum="$checksum" '
    $2 == "module.prop" { print checksum "  module.prop"; next }
    { print }
  ' "$MODDIR/integrity.sha256" > "$MODDIR/integrity.sha256.status.tmp" &&
    mv -f "$MODDIR/integrity.sha256.status.tmp" "$MODDIR/integrity.sha256"
}

update_module_status() {
  case "$1" in
    verified) label='已激活' ;;
    missing) label='未激活' ;;
    expired) label='已过期' ;;
    device_mismatch) label='设备不匹配' ;;
    invalid_signature|invalid_format|invalid_product|invalid_key) label='激活码无效' ;;
    unavailable) label='验证失败' ;;
    *) label='验证中' ;;
  esac
  sed -i "s#^description=.*#description=设备授权保护服务 | 授权状态：$label#" "$MODDIR/module.prop"
  update_integrity_manifest
}

mkdir -p "$CONFIG_DIR"
printf '%s\n' verifying > "$CONFIG_DIR/license_status"
update_module_status verifying

if [ -f "$MODDIR/verify_integrity.sh" ]; then
  sh "$MODDIR/verify_integrity.sh" "$MODDIR" "$CONFIG_DIR/module_integrity_status"
else
  mkdir -p "$CONFIG_DIR"
  printf '%s\n' unavailable > "$CONFIG_DIR/module_integrity_status"
fi

# The supervisor exits rather than restarting when the daemon rejects an offline license.
./supervisor ./daemon "$MODDIR" &

(
  attempts=0
  while [ "$attempts" -lt 20 ]; do
    status=$(cat "$CONFIG_DIR/license_status" 2>/dev/null || printf '%s' unavailable)
    case "$status" in
      verifying|'')
        sleep 1
        attempts=$((attempts + 1))
        ;;
      *)
        update_module_status "$status"
        exit 0
        ;;
    esac
  done
  update_module_status unavailable
) &

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
