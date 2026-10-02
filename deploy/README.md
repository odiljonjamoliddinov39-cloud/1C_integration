# Deploy

One VPS with Docker Compose. Caddy terminates HTTPS with automatic certificates and proxies
`/api`, `/mcp` and `/agent` (WebSocket) to the backend. Everything else is the React app.

## First deploy

1. A VPS (2 vCPU, 4 GB RAM is plenty) with Docker and the compose plugin. Point the domain's
   A record at it, and open ports 80 and 443 only.
2. Clone the repo, then:

   ```bash
   cd deploy
   cp .env.example .env   # fill in DOMAIN, passwords, SECRET_KEY, ANTHROPIC_API_KEY
   docker compose up -d --build
   docker compose exec api python -m app.cli create-owner you@example.com
   ```

3. Open `https://<DOMAIN>`, log in, and turn on 2FA (Settings).
4. Admin → Companies: add the 4 companies, then click **Agent token** for each one. Copy each
   token into the laptop's `agent.ini` (see `agent/agent.ini.example`).

## Services

| Service | What it does |
|---|---|
| `postgres` | Mirror of the 1C data (12 tables). The `app_ro` role is read-only (Ask AI, MCP), created by `postgres/init-readonly.sh` |
| `redis` | Job queue (RQ) and the agent command queue |
| `api` | Runs migrations, then FastAPI: `/api`, `/agent` WebSocket, `/mcp` |
| `worker` | RQ worker: syncs, audits, Claude explanations, agent reply callbacks |
| `scheduler` | Incremental sync every 5 minutes, full audit nightly at 02:00 |
| `caddy` | HTTPS and the built web app |
| `backup` | `pg_dump` daily at 01:30 into `deploy/backups/`, kept 14 days |

## Updates

```bash
git pull && cd deploy && docker compose up -d --build
```

## Restore a backup

```bash
docker compose exec -T postgres pg_restore -U app -d app --clean < backups/app-YYYYMMDD.dump
```

## Security checklist

- `deploy/.env` stays on the server and is never committed.
- Only ports 80 and 443 are open. PostgreSQL and Redis have no published ports.
- On the laptop, the extension listens on `127.0.0.1:8080` only, and the agent connects outbound.
