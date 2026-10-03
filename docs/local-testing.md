# Testing phase: run the system on your own computer

Until the server arrives, the whole system (web app, database, sync, audit) runs on one Windows
computer in the office. It talks to 1C **directly** over the office network: you type the 1C
computer's address in the web app, and no agent or extension is needed.

```
Your computer (Docker)                         1C computer (same Wi-Fi / LAN)
  web app  http://localhost:8080   ──HTTP──▶   1C base published with OData
  database, sync, audit                        (or the same computer: type "localhost")
```

## 1. Start the system (once, about 10 minutes)

1. Install **Docker Desktop** (https://www.docker.com/products/docker-desktop/) and start it.
2. Get the code: `git clone https://github.com/odiljonjamoliddinov39-cloud/1C_integration` (or *Code → Download ZIP*).
3. In PowerShell, in that folder:
   ```powershell
   powershell -ExecutionPolicy Bypass -File start-local.ps1
   ```
   The first run builds everything, asks for your login (email and password) and opens
   http://localhost:8080.

Run the same command after a restart. Your data stays in Docker volumes. To stop the system:
`docker compose -f deploy/docker-compose.yml down`.

## 2. Prepare the 1C base (once per base)

On the computer with 1C (see [`direct-connection.md`](direct-connection.md) for details):

1. Configurator → *Администрирование → Публикация на веб-сервере*. Tick **«Публиковать
   стандартный интерфейс OData»**, then click **«Опубликовать»** (IIS: *Turn Windows features on →
   Internet Information Services*).
2. 1C:Enterprise → *Администрирование → «Настройка стандартного интерфейса OData»*: allow the
   catalogs, documents and `Хозрасчетный`.
3. A 1C user for the app.
4. If the system runs on **another** computer, allow port 80 on the 1C computer, in PowerShell as
   Administrator:
   ```powershell
   New-NetFirewallRule -DisplayName "1C web" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow
   ```
   Then find its IP with `ipconfig` (IPv4 Address).

Check: `http://<1C computer>/<base>/odata/standard.odata/` in a browser asks for the 1C login.

## 3. Connect

Web app → **Admin → Connect a 1C base**:

| Field | 1C on another computer | 1C on this computer |
|---|---|---|
| Server address | its IP, e.g. `192.168.1.25` | `localhost` |
| Base name | the publication name, e.g. `TEST_CRYSTAL` | same |
| 1C user / password | from step 2.3 | same |

**Test connection** checks the base and shows its organization and INN. **Connect and sync** loads
the data. Each base is checked against its company's INN, so a company can only be connected to
its own base.

## When the server arrives

The server runs the same `deploy/docker-compose.yml` with a real domain and HTTPS (see
[`deploy/README.md`](../deploy/README.md)). For the system and 1C to keep talking directly, the
server must be able to reach the 1C computer:

* **The server is in the office network** (or 1C runs on the server itself): nothing changes.
  Keep the addresses, or update them under *Connect 1C*.
* **The server is a cloud VPS**: link the office network and the VPS with a VPN (e.g. WireGuard on
  the 1C computer or the office router), then type the 1C computer's VPN address.

To keep your test data, copy the database across. In `deploy/` on this computer:

```bash
docker compose exec -T postgres pg_dump -U app -Fc app > app.dump
```

Then on the server, restore it as in *Restore a backup* in `deploy/README.md`. Also copy `SECRET_KEY`
from this computer's `deploy/.env` to the server's, because the saved 1C passwords are encrypted
with it. Otherwise enter them again under *Connect 1C*. Or start fresh: connect the bases again
and run a full sync.
