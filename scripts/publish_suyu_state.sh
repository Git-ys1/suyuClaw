#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="/home/yusu/.openclaw/workspace"
STATE_ROOT="/root/.openclaw"
RELEASE_DIR="$WORKSPACE/releases/state"
LATEST_DIR="$RELEASE_DIR/latest"
OLD_DIR="$RELEASE_DIR/old"
PASSPHRASE_FILE="/root/.openclaw/backup-passphrase.txt"
TMP_ROOT="/tmp"
TS="$(date +%Y%m%d-%H%M%S)"
STAGING_DIR="$TMP_ROOT/suyu-state-$TS"
RAW_ARCHIVE="$TMP_ROOT/suyuClaw-state-$TS.tar.gz"
ENC_ARCHIVE="$LATEST_DIR/suyuClaw-state-$TS.tar.gz.enc"
SHA_FILE="$ENC_ARCHIVE.sha256"

if [[ ! -f "$PASSPHRASE_FILE" ]]; then
  echo "Missing passphrase file: $PASSPHRASE_FILE" >&2
  exit 1
fi

PASSPHRASE="$(cat "$PASSPHRASE_FILE")"

mkdir -p "$LATEST_DIR" "$OLD_DIR"

# Move previous latest artifacts into old/
shopt -s nullglob
for f in "$LATEST_DIR"/*.enc "$LATEST_DIR"/*.sha256; do
  mv "$f" "$OLD_DIR"/
done
shopt -u nullglob

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR/.openclaw"

cp -a "$STATE_ROOT/openclaw.json" "$STAGING_DIR/.openclaw/"
cp -a "$STATE_ROOT/credentials" "$STAGING_DIR/.openclaw/"
cp -a "$STATE_ROOT/identity" "$STAGING_DIR/.openclaw/"
cp -a "$STATE_ROOT/devices" "$STAGING_DIR/.openclaw/"
cp -a "$STATE_ROOT/agents/main" "$STAGING_DIR/.openclaw/agents-main"
[[ -f "$STATE_ROOT/exec-approvals.json" ]] && cp -a "$STATE_ROOT/exec-approvals.json" "$STAGING_DIR/.openclaw/" || true
[[ -f "$STATE_ROOT/update-check.json" ]] && cp -a "$STATE_ROOT/update-check.json" "$STAGING_DIR/.openclaw/" || true

tar -C "$TMP_ROOT" -czf "$RAW_ARCHIVE" "$(basename "$STAGING_DIR")"
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -in "$RAW_ARCHIVE" \
  -out "$ENC_ARCHIVE" \
  -pass pass:"$PASSPHRASE"
sha256sum "$ENC_ARCHIVE" > "$SHA_FILE"

rm -f "$RAW_ARCHIVE"
rm -rf "$STAGING_DIR"

cd "$WORKSPACE"
git add -A .
git commit -m "Auto publish workspace and encrypted state ($TS)" || true
git push origin master

echo "Published latest encrypted state: $ENC_ARCHIVE"
