#!/usr/bin/env bash
# One-command demo without 1C: PostgreSQL + Redis (Docker), backend, a fake 1C serving four
# bases, the real agent, and the web app. Works in GitHub Codespaces and on any Linux/macOS box
# with Docker, Python 3.11+ and Node 20.19+.
#
#   bash scripts/demo.sh        # then open the forwarded port 5173; Ctrl+C stops everything
#
# Logins: owner@example.com / owner-password-1, accountant@example.com / accountant-password-1,
#         viewer@example.com / viewer-password-1 (sees TEXMASH only).
# Every run starts from fresh demo data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.demo"
mkdir -p "$RUN"
PIDS=()

say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }

port_open() {
  python3 - "$1" <<'EOF'
import socket, sys
s = socket.socket()
s.settimeout(0.5)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
EOF
}

wait_port() {
  for _ in $(seq 1 60); do port_open "$1" && return 0; sleep 1; done
  echo "Port $1 did not open; see logs in $RUN" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  cat >&2 <<MSG

  ✖ '$1' is not installed in this environment.
    In Codespaces this usually means the codespace is in recovery mode (a failed container rebuild).
    Fix: Ctrl+Shift+P → "Codespaces: Full Rebuild Container", then run this script again.
MSG
  exit 1
}

need_docker() {
  need docker
  if ! docker info >/dev/null 2>&1; then
    cat >&2 <<MSG

  ✖ Docker is installed but not running, and nothing is listening on 5432/6379.
    Start Docker (Docker Desktop, or 'sudo service docker start'), or start PostgreSQL and Redis
    yourself on ports 5432 and 6379, then run this script again.
MSG
    exit 1
  fi
}

# Node may be installed through nvm without being on PATH in this shell.
use_node() {
  for nvm_sh in "${NVM_DIR:-}/nvm.sh" /usr/local/share/nvm/nvm.sh "$HOME/.nvm/nvm.sh"; do
    if [ -s "$nvm_sh" ]; then
      # shellcheck disable=SC1090
      . "$nvm_sh"
      break
    fi
  done
  local major
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -lt 22 ] && command -v nvm >/dev/null 2>&1; then
    nvm install 22 >/dev/null && nvm use 22 >/dev/null
  fi
  need npm
}

cleanup() {
  say "Stopping"
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

say "Checking tools"
need python3
use_node
echo "python $(python3 -V 2>&1 | cut -d' ' -f2) · node $(node -v) · npm $(npm -v)"

# --- PostgreSQL and Redis --------------------------------------------------------------------
say "PostgreSQL and Redis"
if port_open 5432; then
  echo "Using the PostgreSQL already listening on 5432"
else
  need_docker
  docker rm -f onec-demo-postgres >/dev/null 2>&1 || true
  docker run -d --name onec-demo-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16 >/dev/null
  wait_port 5432
  sleep 3 # first start runs initdb, then restarts
  wait_port 5432
fi
if port_open 6379; then
  echo "Using the Redis already listening on 6379"
else
  need_docker
  docker rm -f onec-demo-redis >/dev/null 2>&1 || true
  docker run -d --name onec-demo-redis -p 6379:6379 redis:7 redis-server --save "" >/dev/null
  wait_port 6379
fi

# --- Python ----------------------------------------------------------------------------------
say "Python packages"
if [ ! -x "$RUN/venv/bin/python" ]; then
  python3 -m venv "$RUN/venv"
fi
"$RUN/venv/bin/pip" install -q --disable-pip-version-check -r "$ROOT/backend/requirements.txt" -r "$ROOT/agent/requirements.txt"
PY="$RUN/venv/bin/python"

say "Demo database"
ADMIN_URL="${DEMO_PG_ADMIN_URL:-postgresql+psycopg://postgres:postgres@127.0.0.1:5432/postgres}"
(cd "$ROOT/backend" && "$PY" -m scripts.demo_seed --admin-url "$ADMIN_URL" --db app_demo --agent-ini "$RUN/agent.ini")

# --- backend, fake 1C, agent -------------------------------------------------------------------
say "Backend on :8000"
export DATABASE_URL="${ADMIN_URL%/*}/app_demo"
export READONLY_DATABASE_URL="postgresql+psycopg://app_ro:app_ro@127.0.0.1:5432/app_demo"
export REDIS_URL="redis://127.0.0.1:6379/5"
export JOBS_EAGER=1
export SECRET_KEY="demo-secret-key-$(date +%s)-long-enough-for-hs256"
(cd "$ROOT/backend" && exec "$PY" -m uvicorn app.main:app --port 8000 >"$RUN/api.log" 2>&1) &
PIDS+=($!)
(cd "$ROOT/backend" && exec "$PY" -m scripts.fake_extension --port 8081 --token ext-token \
  --bases TEST_CRYSTAL,TEST_TEXMASH,TEST_CRYSTAL_OOO,TEST_TEHMASH >"$RUN/fake1c.log" 2>&1) &
PIDS+=($!)
wait_port 8000
wait_port 8081

say "Agent (4 bases)"
(cd "$ROOT/agent" && ONEC_AGENT_CONFIG="$RUN/agent.ini" exec "$PY" -m onec_agent run >"$RUN/agent.log" 2>&1) &
PIDS+=($!)
for _ in $(seq 1 30); do [ "$(grep -c connected "$RUN/agent.log" 2>/dev/null || true)" -ge 4 ] && break; sleep 1; done

say "First sync of the 4 companies"
"$PY" - <<'EOF'
import httpx
c = httpx.Client(base_url="http://127.0.0.1:8000", timeout=120)
token = c.post("/api/auth/login", json={"email": "owner@example.com", "password": "owner-password-1"}).json()["token"]
c.headers["Authorization"] = f"Bearer {token}"
for company in c.get("/api/companies").json():
    c.post(f"/api/companies/{company['id']}/sync", params={"full": "true"}).raise_for_status()
findings = c.get("/api/findings").json()
print(f"synced {len(c.get('/api/companies').json())} companies, {len(findings)} open audit findings")
EOF

# --- web ---------------------------------------------------------------------------------------
say "Web app on :5173"
(cd "$ROOT/web" && { [ -d node_modules ] || npm ci --no-audit --no-fund; })
# Run Vite's own entry point (not npx) so the PID we record is the server itself.
(cd "$ROOT/web" && exec node node_modules/vite/bin/vite.js --host 0.0.0.0 --port 5173 --strictPort >"$RUN/web.log" 2>&1) &
PIDS+=($!)
wait_port 5173

cat <<EOF

  ✅ Running. Open http://localhost:5173
     (in Codespaces: the PORTS tab → port 5173 → globe icon)

  owner@example.com       owner-password-1       all 4 companies
  accountant@example.com  accountant-password-1  all 4 companies
  viewer@example.com      viewer-password-1      TEXMASH only

  API docs: http://localhost:8000/api/docs     Logs: .demo/*.log
  Press Ctrl+C to stop.
EOF
wait
