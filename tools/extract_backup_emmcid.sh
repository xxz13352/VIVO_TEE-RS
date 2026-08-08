#!/system/bin/sh

set -eu

usage() {
  echo "Usage: $0 [backup_partition] [payload_bytes]" >&2
  echo "Default payload_bytes: 16" >&2
}

find_backup_partition() {
  for candidate in \
    /dev/block/by-name/backup \
    /dev/block/platform/*/by-name/backup \
    /dev/block/platform/*/*/by-name/backup
  do
    if [ -e "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

to_hex() {
  od -An -tx1 -v | tr -d ' \n'
}

to_text() {
  tr -d '\000\r\n'
}

if [ "$#" -gt 2 ]; then
  usage
  exit 2
fi

BACKUP_PARTITION=${1:-}
PAYLOAD_BYTES=${2:-16}

case "$PAYLOAD_BYTES" in
  ''|*[!0-9]*|0)
    echo "payload_bytes must be a positive integer" >&2
    exit 2
    ;;
esac

if [ -z "$BACKUP_PARTITION" ]; then
  BACKUP_PARTITION=$(find_backup_partition) || {
    echo "backup partition not found" >&2
    exit 1
  }
fi

if [ ! -r "$BACKUP_PARTITION" ]; then
  echo "backup partition is not readable: $BACKUP_PARTITION" >&2
  exit 1
fi

RESOLVED_PARTITION=$(readlink -f "$BACKUP_PARTITION" 2>/dev/null || printf '%s' "$BACKUP_PARTITION")
PARTITION_SIZE=$(stat -c '%s' "$BACKUP_PARTITION" 2>/dev/null || printf 'unknown')
printf 'backup=%s\n' "$RESOLVED_PARTITION"
printf 'size=%s\n' "$PARTITION_SIZE"

# Scan byte-by-byte through od output so this works with Android toybox and
# does not load the whole backup partition into a shell variable.
MARKER_OFFSET=$(
  od -An -tx1 -v "$BACKUP_PARTITION" 2>/dev/null |
    awk '
      BEGIN { offset = 0; previous = ""; previous2 = ""; previous3 = "" }
      {
        for (i = 1; i <= NF; i++) {
          byte = tolower($i)
          if (previous == "01" && byte == "ce") {
            print (offset - 1) ":2:binary"
            exit
          }
          if (previous3 == "30" && previous2 == "31" && previous == "63" && byte == "65") {
            print (offset - 3) ":4:ascii"
            exit
          }
          previous3 = previous2
          previous2 = previous
          previous = byte
          offset++
        }
      }
    '
)

if [ -z "$MARKER_OFFSET" ]; then
  echo "01ce marker not found" >&2
  exit 3
fi

MARKER_REST=${MARKER_OFFSET#*:}
MARKER_OFFSET=${MARKER_OFFSET%%:*}
MARKER_BYTES=${MARKER_REST%%:*}
MARKER_TYPE=${MARKER_REST#*:}

if [ "$MARKER_TYPE" = "ascii" ]; then
  MARKER_AND_PAYLOAD=$(dd if="$BACKUP_PARTITION" bs=1 skip="$MARKER_OFFSET" count=$((PAYLOAD_BYTES + MARKER_BYTES)) 2>/dev/null | to_text)
  PAYLOAD_AFTER_MARKER=$(dd if="$BACKUP_PARTITION" bs=1 skip=$((MARKER_OFFSET + MARKER_BYTES)) count="$PAYLOAD_BYTES" 2>/dev/null | to_text)
else
  MARKER_AND_PAYLOAD=$(dd if="$BACKUP_PARTITION" bs=1 skip="$MARKER_OFFSET" count=$((PAYLOAD_BYTES + MARKER_BYTES)) 2>/dev/null | to_hex)
  PAYLOAD_AFTER_MARKER=$(dd if="$BACKUP_PARTITION" bs=1 skip=$((MARKER_OFFSET + MARKER_BYTES)) count="$PAYLOAD_BYTES" 2>/dev/null | to_hex)
fi

printf 'marker_offset=%s\n' "$MARKER_OFFSET"
printf 'marker_offset_hex=0x%x\n' "$MARKER_OFFSET"
printf 'marker_type=%s\n' "$MARKER_TYPE"
printf 'emmcid_candidate=%s\n' "$MARKER_AND_PAYLOAD"
printf 'payload_after_marker=%s\n' "$PAYLOAD_AFTER_MARKER"
