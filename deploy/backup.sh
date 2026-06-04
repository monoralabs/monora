#!/usr/bin/env bash
# Nightly backup: Postgres dump + the git data plane volume, kept locally with
# rotation. Run from the deploy dir (where docker-compose.prod.yml lives).
#
#   ./backup.sh                 # one-off
#   # cron (daily 03:30):  30 3 * * *  cd /opt/monora && ./backup.sh >> /var/log/monora-backup.log 2>&1
#
# Off-box copy (recommended): after this runs, sync $DEST to a Hetzner Storage
# Box with restic/borg/rsync. Left as a follow-up so no extra creds are needed yet.
set -euo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml"
DEST="${BACKUP_DIR:-/opt/monora/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"

echo "[backup $STAMP] postgres dump..."
$COMPOSE exec -T postgres pg_dump -U monora_owner -d monora --format=custom \
  > "$DEST/monora-db-$STAMP.dump"

echo "[backup $STAMP] git data plane..."
docker run --rm \
  -v monora_gitdata:/data:ro \
  -v "$DEST":/backup \
  alpine:3 tar czf "/backup/monora-git-$STAMP.tar.gz" -C /data .

echo "[backup $STAMP] rotating (>$KEEP_DAYS days)..."
find "$DEST" -name 'monora-db-*.dump' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -name 'monora-git-*.tar.gz' -mtime "+$KEEP_DAYS" -delete

echo "[backup $STAMP] done -> $DEST"
