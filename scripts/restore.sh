#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: bash scripts/restore.sh ARCHIVE.tar.gz [NEW_EMPTY_DIRECTORY]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ARCHIVE="$(realpath -e -- "$1")"
if [[ ! -f "$ARCHIVE" ]]; then
  echo "Backup archive not found: $ARCHIVE" >&2
  exit 1
fi

if ! tar -tzf "$ARCHIVE" >/dev/null; then
  echo "The backup archive is invalid; nothing was extracted." >&2
  exit 1
fi

if tar -tzf "$ARCHIVE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "The archive contains an unsafe path; nothing was extracted." >&2
  exit 1
fi

if tar -tvzf "$ARCHIVE" | awk '
  substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { unsafe = 1; exit }
  END { exit unsafe ? 0 : 1 }
'; then
  echo "The archive contains a link or special file; nothing was extracted." >&2
  exit 1
fi

if [[ $# -eq 2 ]]; then
  DEST="$2"
else
  DEST="${ARCHIVE%.tar.gz}-restored"
fi

DEST_PARENT="$(realpath -m -- "$(dirname -- "$DEST")")"
DEST_NAME="$(basename -- "$DEST")"
DEST="$DEST_PARENT/$DEST_NAME"

case "$DEST/" in
  "$ROOT/"*)
    echo "Restore to a new directory outside the live project." >&2
    exit 1
    ;;
esac

mkdir -p -- "$DEST_PARENT"
if [[ -e "$DEST" || -L "$DEST" ]]; then
  echo "Restore destination already exists; nothing was overwritten: $DEST" >&2
  exit 1
fi

mkdir -m 700 -- "$DEST"
tar --extract --gzip --file="$ARCHIVE" --directory="$DEST" --no-same-owner --no-same-permissions

printf 'Snapshot extracted to: %s\n' "$DEST"
printf 'The live project and host data were not changed. Review the restored files before use.\n'
