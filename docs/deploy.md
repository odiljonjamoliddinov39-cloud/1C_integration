# Prototype deployment: server + desktop .exe

What runs where (TD §3):

```
DigitalOcean droplet (https://<ip-with-dashes>.sslip.io)      Accountant's Windows PC
  Caddy (HTTPS) → API (accounts, sign-in, licenses)  ◀──────  1C Platform.exe ──COM──▶ 1C
  PostgreSQL, daily backups                                    (the books stay on the PC)
```

No domain is needed yet. `sslip.io` turns the server's IP into a name
(`203.0.113.5` → `203-0-113-5.sslip.io`), so Caddy gets a real Let's Encrypt certificate. When a
domain is bought, put it in `SITE_ADDRESS` in `/opt/platform/.env` and run the deploy again.

## 1. Let GitHub reach the server (once)

On **your laptop** (PowerShell or a terminal):

```bash
ssh-keygen -t ed25519 -f platform-deploy -N ""      # makes platform-deploy and platform-deploy.pub
```

Add the public key to the droplet. Either paste `platform-deploy.pub` in DigitalOcean →
Droplet → Access, or run:

```bash
ssh root@<SERVER_IP> "cat >> ~/.ssh/authorized_keys" < platform-deploy.pub
```

On GitHub, go to the repository → **Settings → Secrets and variables → Actions → New repository
secret** and add:

| Secret           | Value                                                             |
| ---------------- | ----------------------------------------------------------------- |
| `DEPLOY_HOST`    | the droplet's IP                                                  |
| `DEPLOY_SSH_KEY` | the whole content of the `platform-deploy` file (the private key) |

## 2. Deploy the server

GitHub → **Actions → Deploy server → Run workflow**. The workflow:

1. builds the API image and pushes it to GitHub Container Registry;
2. copies `deploy/` to `/opt/platform` on the droplet;
3. the first time: installs Docker, opens only ports 22, 80 and 443, and writes
   `/opt/platform/.env` with new secrets (database password, JWT secret, the license signing key);
4. starts PostgreSQL, the API and Caddy, and waits until `https://<ip>.sslip.io/health` answers.

The address is printed at the end of the run. Every push to `main` that changes the API deploys again.

> **Back up `/opt/platform/.env`.** `LICENSE_PRIVATE_KEY` signs every desktop license.

## 3. Build the Windows installer

GitHub → **Actions → Desktop app (Windows .exe) → Run workflow**, with the address from step 2,
e.g. `https://203-0-113-5.sslip.io`. When it finishes, download **platform-desktop-windows** from
the run page. It contains `1C-Platform-Setup-0.1.0.exe`.

The installer is not code-signed yet (TD §14), so Windows shows _"Windows protected your PC"_.
Click **More info → Run anyway**.

## 4. Try it

1. Install and open **1C Platform**.
2. Click **Create one (prototype)**, enter your name, the firm name, email and a password of at
   least 10 characters. The account gets a 14-day trial and this PC is activated. The header shows
   _Trial · until …_.
3. **Connect company**: the 1C infobase folder, 1C user and password. This needs the PlatformAPI
   extension and the registered `comcntr.dll` (see `docs/phase-0.md`).

To try the app without 1C, start it with the demo base: in PowerShell,
`$env:PLATFORM_DEMO_1C=1; & "$env:LOCALAPPDATA\Programs\1C Platform\1C-Platform.exe"`.

## Useful commands on the server

```bash
cd /opt/platform
docker compose ps                    # what runs
docker compose logs -f api           # API log
docker compose exec postgres psql -U platform platform -c "select email, created_at from users"
ls backups/                          # daily database dumps, 14 days
```

Turning off open sign-up (later, when the website takes it over): set `ALLOW_REGISTRATION=false`
in `.env`, then run `docker compose up -d`.
