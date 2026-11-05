#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUTPUT_DIR="${1:-$HOME/sugar-backups}"

OUTPUT_DIR="$(realpath -m -- "$OUTPUT_DIR")"

case "$OUTPUT_DIR/" in
  "$ROOT/"*)
    echo "Choose a backup directory outside the project." >&2
    exit 1
    ;;
esac

mkdir -p -m 700 -- "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd -P)"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$OUTPUT_DIR/sugar-ai-$STAMP.tar.gz"
if [[ -e "$ARCHIVE" ]]; then
  echo "A backup with that timestamp already exists: $ARCHIVE" >&2
  exit 1
fi

DATA_DIR="$(
  cd "$ROOT"
  node --input-type=module -e 'import("./src/settings.js").then(({ resolveDataDir }) => process.stdout.write(resolveDataDir()))'
)"
case "$DATA_DIR" in
  /*) ;;
  *) DATA_DIR="$ROOT/$DATA_DIR" ;;
esac
if [[ ! -d "$DATA_DIR" || ! -r "$DATA_DIR" ]]; then
  echo "The selected data directory is not readable; no backup was created." >&2
  exit 1
fi

STAGE="$(mktemp -d "$OUTPUT_DIR/.sugar-ai-backup.XXXXXX")"
TEMP_ARCHIVE="$OUTPUT_DIR/.sugar-ai-backup.$$.tar.gz"
cleanup() {
  rm -rf -- "$STAGE"
  rm -f -- "$TEMP_ARCHIVE"
}
trap cleanup EXIT

(
  cd "$ROOT"
  find . \( -type f -o -type l \) \
    ! -path './.git/*' \
    ! -path './node_modules/*' \
    ! -path './.cache/*' \
    ! -path './.local/*' \
    ! -path './.conversation/*' \
    ! -path './data/*' \
    ! -path './backups/*' \
    ! -name '.env' \
    ! -name '.envrc' \
    ! \( -name '.env.*' ! -name '.env.example' \) \
    -print0 |
    while IFS= read -r -d '' file; do
      cp -pP --parents -- "$file" "$STAGE"
    done
)

mkdir -p -- "$STAGE/data"
cp -a -- "$DATA_DIR/." "$STAGE/data/"

REVISION="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"
{
  printf 'Created (UTC): %s\n' "$STAMP"
  printf 'Source revision: %s\n' "$REVISION"
  printf 'Application data: copied from the configured data directory\n'
  printf 'Secrets: excluded; configure them separately on the recovery host\n'
} > "$STAGE/BACKUP-INFO.txt"

tar -czf "$TEMP_ARCHIVE" -C "$STAGE" .
chmod 600 "$TEMP_ARCHIVE"
mv -- "$TEMP_ARCHIVE" "$ARCHIVE"

printf 'Backup created: %s\n' "$ARCHIVE"
printf 'Secret environment files were excluded.\n'
