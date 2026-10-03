#!/usr/bin/env bash
# Runs the whole system on this computer (macOS/Linux), for the testing phase before a server.
# Needs Docker. Then open http://localhost:8080. Stop: docker compose -f deploy/docker-compose.yml down
set -euo pipefail
cd "$(dirname "$0")/deploy"

docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker, then run this again." >&2; exit 1; }

if [ ! -f .env ]; then
  secret() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48; }
  cat >.env <<ENV
# Local test setup written by start-local.sh. Plain HTTP on port 8080, no domain.
DOMAIN=:80
HTTP_PORT=8080
HTTPS_PORT=8443
POSTGRES_PASSWORD=$(secret)
POSTGRES_RO_PASSWORD=$(secret)
SECRET_KEY=$(secret)
ANTHROPIC_API_KEY=
AI_ANONYMIZE_DEFAULT=false
EINVOICE_PROVIDER=stub
ENV
  echo "Wrote deploy/.env with new random passwords."
fi

echo "Building and starting (the first time takes a few minutes)..."
docker compose up -d --build
echo "Waiting for the app..."
for _ in $(seq 1 90); do curl -fsS http://localhost:8080/api/health >/dev/null 2>&1 && break; sleep 2; done

docker compose exec api python -m app.cli ensure-owner

echo
echo "Running: http://localhost:8080"
echo "Connect your 1C: Admin -> Connect a 1C base (address, base name, 1C user, password)."
echo "1C on this same computer: type localhost as the address."
