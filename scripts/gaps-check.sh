#!/usr/bin/env bash
# Liste les compétences manquantes repérées par chaque bot sur le VPS (lecture seule).
# Usage : scripts/gaps-check.sh [min_count]   (par défaut : 1)
set -euo pipefail
HOST="${DEPLOY_HOST:-root@169.58.55.167}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/contabo_minecraft}"
MIN="${1:-1}"
ssh -i "$KEY" -o BatchMode=yes "$HOST" "for b in minecraftia:Alex minecraftia-lea:Lea; do
  dir=\${b%%:*}; name=\${b##*:}
  sqlite3 -readonly -separator ' | ' /opt/\$dir/data/minecraftia.db \
    \"SELECT '\$name', kind, count, datetime(last_at/1000,'unixepoch'), key, example FROM skill_gaps WHERE count >= $MIN ORDER BY count DESC\"
done"
