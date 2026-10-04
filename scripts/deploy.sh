#!/usr/bin/env bash
# Déploie le bot sur le VPS : envoie le code, la config des mods, puis reconstruit et relance.
# Usage : scripts/deploy.sh [service...]   (par défaut : minecraftia)
set -euo pipefail
HOST="${DEPLOY_HOST:-root@169.58.55.167}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/contabo_minecraft}"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")
cd "$(dirname "$0")/.."

echo "→ envoi du code"
tar czf - --exclude=node_modules --exclude=dist --exclude=data --exclude=graphify-out --exclude=.git --exclude=.env \
  package.json package-lock.json tsconfig.json Dockerfile .dockerignore src scripts test \
  | "${SSH[@]}" 'mkdir -p /opt/minecraftia/app /opt/minecraftia/data && rm -rf /opt/minecraftia/app/src /opt/minecraftia/app/scripts /opt/minecraftia/app/test && tar xzf - -C /opt/minecraftia/app'

echo "→ compose et configuration des mods"
"${SSH[@]}" 'cat > /opt/minecraft/docker-compose.yml' < deploy/docker-compose.yml
for f in deploy/mc-config/*.json; do
  "${SSH[@]}" "mkdir -p /opt/minecraft/data/config && cat > /opt/minecraft/data/config/$(basename "$f")" < "$f"
done

echo "→ construction et relance"
"${SSH[@]}" "cd /opt/minecraft && docker compose up -d --build ${*:-minecraftia} 2>&1 | tail -5"
