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

## 2a. Turn on the AI assistant (optional)

1. At **console.anthropic.com**: add billing, set a monthly spend limit (Settings → Limits), and
   create an API key.
2. Add it on GitHub as the repository secret **`ANTHROPIC_API_KEY`** (same page as above).
3. Run **Deploy server** again. The key is copied into `/opt/platform/.env` on the server; it never
   goes into the desktop app.

Limits: each trial account may use 1 000 000 tokens (about $1–3 of Claude usage) and at most
`AI_DAILY_TOKENS` (default 300 000) per day. Cached prompt tokens (re-read on every step of an
answer) count a tenth, as they cost a tenth. Usage per request is in the `ai_usage` table:

```bash
docker compose exec postgres psql -U platform platform -c \
  "select a.name, count(*), sum(cost_usd) from ai_usage u join accounts a on a.id = u.account_id group by 1"
```

## 3. Build the Windows installer

GitHub → **Actions → Desktop app (Windows .exe) → Run workflow**, with the address from step 2,
e.g. `https://203-0-113-5.sslip.io`. When it finishes, download **platform-desktop-windows** from
the run page. It contains `1C-Platform-Setup-0.1.<run number>.exe`.

After that, every push to the default branch that changes the app builds it again (the address comes
from the `PLATFORM_API_URL` repository variable, else from `DEPLOY_HOST`).

### Updates

Installed apps update themselves; nobody downloads a new installer:

1. Each build gets a new version, `0.1.<run number>` (change major/minor in
   `apps/desktop/package.json`).
2. With the deploy secrets set, the workflow puts the installer, its `.blockmap` and `latest.yml` in
   `https://<server>/download/` (`latest.yml` last, so apps never see a half-uploaded version).
3. The app reads `latest.yml` at start and every 4 hours, downloads a newer version in the background
   (only the changed parts when it can), and shows _"Version … is ready"_ with **Restart and update**.
   If the user ignores it, the update installs when the app is closed.

Clicking the version in the app's header checks right away. Versions installed before auto-update
existed (0.1.0) need one manual install of a new build.

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

## 5. Website on Vercel

The marketing site and customer cabinet (`apps/web`, Astro) are static pages on Vercel. Vercel forwards
`/api/*` to the server (`apps/web/vercel.json`), so the browser never talks to another domain.

1. At **vercel.com**, sign in with GitHub and choose **Add New → Project**. Import
   `1C_integration` (allow Vercel access to the repository if it asks).
2. Set **Root Directory** to `apps/web`. Vercel detects Astro; the install and build commands come from
   `vercel.json`. Leave the environment variables empty.
3. Click **Deploy**. The site gets an address such as `https://1c-integration.vercel.app`; every push
   to the production branch (the repository's default branch) deploys again.

The Download page links to `https://<server>/download/1C-Platform-Setup.exe`. The **Desktop app
(Windows .exe)** workflow puts the installer there after each build (it uses the same deploy secrets).

When the server address changes (a domain is bought), update the `destination` in
`apps/web/vercel.json` and `DOWNLOAD_URL` in `apps/web/src/lib/config.ts`.

## 6. Admin dashboard

Our staff's dashboard is served by the server itself at `https://<server>/admin/` (no separate
hosting). It shows customers (plan, status, end date, PCs, companies, last activity), each customer's
users, PCs and AI use, AI cost per day and per customer, and a log of every admin action.

1. GitHub → **Settings → Secrets and variables → Actions → New repository secret**, twice:
   - `ADMIN_EMAIL`: the owner's email, e.g. `you@yourcompany.uz`
   - `ADMIN_PASSWORD`: at least 10 characters, without the `'` character
2. Push any change, or run **Actions → Deploy server → Run workflow**.
3. Open `https://<server>/admin/` and sign in.

Changing `ADMIN_PASSWORD` and deploying again resets the owner's password. Owners add more admins on
the **Admins** page: _support_ admins can look up customers, extend licenses and remove or restore
PCs; only owners can block accounts and manage admins.

**Extend** adds days to the end date (from today if it has passed) and reactivates a suspended
account; PCs pick it up at their next license check (every 6 hours, or when the app starts).
**Remove** on a PC frees its seat. **Block account** signs the customer out of the app and the
assistant until unblocked. Revenue reports come with Payme payments.

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
