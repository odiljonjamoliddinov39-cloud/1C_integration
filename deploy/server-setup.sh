#!/usr/bin/env bash
# Prepares an Ubuntu server and (re)starts the control system. Safe to run again: it never
# overwrites existing secrets. Runs as root from /opt/platform (the deploy workflow copies it there).
#
#   API_IMAGE=ghcr.io/owner/repo-api:latest bash /opt/platform/server-setup.sh
set -euo pipefail
APP_DIR=/opt/platform
cd "$APP_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

# Only SSH and the web ports are open (TD §11).
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

mkdir -p backups downloads
if [ ! -f .env ]; then
  echo "Writing $APP_DIR/.env with new secrets..."
  ip=$(curl -fsS --max-time 3 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address 2>/dev/null \
    || curl -fsS --max-time 5 https://api.ipify.org)
  secret() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }
  key=$(openssl genpkey -algorithm ed25519 | awk 'NF { printf "%s\\n", $0 }')
  umask 077
  cat > .env <<ENV
# Written by server-setup.sh. Keep this file secret and backed up: LICENSE_PRIVATE_KEY signs every
# desktop license, and losing it means every PC has to sign in again.
SITE_ADDRESS=${ip//./-}.sslip.io
POSTGRES_PASSWORD=$(secret)
JWT_SECRET=$(secret)
LICENSE_PRIVATE_KEY='${key}'
ALLOW_REGISTRATION=true
ENV
fi

# The deploy workflow drops the Claude API key here (from the ANTHROPIC_API_KEY repository secret).
if [ -f .anthropic-key ]; then
  anthropic_key=$(tr -d '\r\n' < .anthropic-key)
  rm -f .anthropic-key
  umask 077
  { grep -v '^ANTHROPIC_API_KEY=' .env || true; echo "ANTHROPIC_API_KEY=${anthropic_key}"; } > .env.new
  mv .env.new .env
  echo "Claude API key updated."
fi

# The admin dashboard's owner sign-in (ADMIN_EMAIL / ADMIN_PASSWORD repository secrets), line by line.
if [ -f .admin-credentials ]; then
  admin_email=$(sed -n 1p .admin-credentials | tr -d '\r')
  admin_password=$(sed -n 2p .admin-credentials | tr -d '\r')
  rm -f .admin-credentials
  case "$admin_password" in
    *"'"*) echo "ADMIN_PASSWORD must not contain a single quote ('); the admin sign-in was not changed." >&2 ;;
    *)
      umask 077
      { grep -v -e '^ADMIN_EMAIL=' -e '^ADMIN_PASSWORD=' .env || true
        echo "ADMIN_EMAIL=${admin_email}"
        echo "ADMIN_PASSWORD='${admin_password}'"; } > .env.new
      mv .env.new .env
      echo "Admin sign-in updated."
      ;;
  esac
fi

if [ -n "${API_IMAGE:-}" ]; then
  grep -q '^API_IMAGE=' .env && sed -i "s#^API_IMAGE=.*#API_IMAGE=${API_IMAGE}#" .env || echo "API_IMAGE=${API_IMAGE}" >> .env
fi

docker compose pull --quiet api postgres caddy backup 2>/dev/null || docker compose pull api postgres caddy backup
docker compose up -d --remove-orphans
docker image prune -f >/dev/null

site=$(grep '^SITE_ADDRESS=' .env | cut -d= -f2)
echo "Waiting for https://${site}/health ..."
for _ in $(seq 1 60); do
  if curl -fsS "https://${site}/health" >/dev/null 2>&1; then
    echo "OK: the control system answers at https://${site}"
    exit 0
  fi
  sleep 5
done
echo "The API did not answer over HTTPS yet. Check: docker compose -f $APP_DIR/docker-compose.yml logs --tail 50"
exit 1
