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
if [[ ! -d "$DATA_DIR" || ! -r "$DATA_DIR" || ! -x "$DATA_DIR" ]]; then
  echo "The selected data directory is not readable; no backup was created." >&2
  exit 1
fi
DATA_DIR="$(cd "$DATA_DIR" && pwd -P)"

is_inside() {
  local path="$1"
  local parent="$2"
  [[ "$path" == "$parent" || "$path" == "$parent/"* ]]
}

STAGE=""
for candidate in "${TMPDIR:-/tmp}" /tmp /var/tmp; do
  [[ -d "$candidate" && -w "$candidate" ]] || continue
  candidate="$(realpath -e -- "$candidate")"
  if is_inside "$candidate" "$ROOT"; then
    continue
  fi
  if STAGE="$(mktemp -d "$candidate/.sugar-ai-backup.XXXXXX" 2>/dev/null)"; then
    break
  fi
done
if [[ -z "$STAGE" ]]; then
  echo "No safe temporary directory is available; no backup was created." >&2
  exit 1
fi

TEMP_ARCHIVE="$(mktemp "$OUTPUT_DIR/.sugar-ai-backup.XXXXXX")"
cleanup() {
  rm -rf -- "$STAGE"
  rm -f -- "$TEMP_ARCHIVE"
}
trap cleanup EXIT

(
  cd "$ROOT"
  find . \
    \( -type d \( \
      -name .git -o -name node_modules -o -name .cache -o -name .local -o \
      -name .conversation -o -name data -o -name backups -o -name .ssh -o \
      -name .aws -o -iname credential -o -iname credentials -o \
      -iname secret -o -iname secrets \
    \) -prune \) -o \
    \( -type f \
      ! -name '.env' \
      ! -name '.envrc' \
      ! -name '.npmrc' \
      ! -name '.netrc' \
      ! -name '.pypirc' \
      ! -name '*.env' \
      ! \( -name '.env.*' ! -name '.env.example' \) \
      ! -iname '*credential*' \
      ! -iname '*secret*' \
      ! -iname '*password*' \
      ! -iname '*api-key*' \
      ! -iname '*api_key*' \
      ! -iname '*access-token*' \
      ! -iname '*access_token*' \
      ! -iname '*service-account*' \
      ! -iname '*service_account*' \
      ! -iname '*private-key*' \
      ! -iname '*private_key*' \
      ! -iname '*.pem' \
      ! -iname '*.key' \
      ! -iname '*.p12' \
      ! -iname '*.pfx' \
      ! -iname '*.keystore' \
      ! -iname '*.jks' \
      ! -name 'id_rsa*' \
      ! -name 'id_ed25519*' \
      -print0 \) |
    while IFS= read -r -d '' file; do
      cp -pP --parents -- "$file" "$STAGE"
    done
)

# Copy only the app's known durable data files. This avoids collecting
# credentials from DATA_DIR and avoids recursively archiving an output
# directory placed under /data for FadeHost's file manager.
mkdir -p -- "$STAGE/data"
for DATA_FILE in settings.json memory.json private-chats.json moderation-logs.json onboarding-guide.json self-roles.json nsfw-visibility.json; do
  SOURCE="$DATA_DIR/$DATA_FILE"
  if [[ -L "$SOURCE" ]]; then
    echo "$DATA_FILE is a symlink; refusing to back it up." >&2
    exit 1
  elif [[ -e "$SOURCE" ]]; then
    if [[ ! -f "$SOURCE" || ! -r "$SOURCE" ]]; then
      echo "$DATA_FILE is not a readable regular file; no backup was created." >&2
      exit 1
    fi
    cp -p -- "$SOURCE" "$STAGE/data/$DATA_FILE"
  fi
done

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
