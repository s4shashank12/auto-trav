# auto-travian

A bot system for Travian Legends. A backend plays any number of Travian accounts, and a web
dashboard shows and manages them.

> Travian's game rules forbid automated play. The game says it answers suspected bots with
> CAPTCHAs, then emptied warehouses, troop losses and a ban. The bot makes no attempt to hide
> itself. If a CAPTCHA appears, it stops that account and marks it in the dashboard. Use it at
> your own risk.

```
 Firebase Hosting                   GCP VM (docker compose)
┌──────────────┐  HTTPS + token  ┌───────┐   ┌──────────────────────────┐   ┌──────────┐
│  dashboard/  │ ──────────────▶ │ Caddy │──▶│ backend (API + workers)  │──▶│ Postgres │
│ React SPA    │   REST /api/*   └───────┘   │ one Chromium, a context  │   └──────────┘
└──────────────┘                             │ per Travian account      │
       ▲                                     └──────────────────────────┘
       │                                                  ▲
       └──── GitHub Actions on merge to master ──▶ ghcr.io image ◀── Watchtower pulls updates
```

- **`src/`**: the bot. It builds in small villages, ships resources, uses hero resources,
  trains troops, reinforces when crop is low, raids oases in waves and, if you switch it on,
  raids inactive players. Every rule is a setting (`src/config.js`).
- **`src/server/`**: the backend.
  - A REST API behind a bearer token.
  - Postgres storage, with Travian passwords encrypted using AES-256-GCM.
  - One worker per Travian account, all sharing one Chromium.
- **`dashboard/`**: a static React app for Firebase Hosting. From it you can:
  - add Travian accounts on any game world;
  - start and stop them;
  - see villages, build queues, raids and training;
  - find inactive players near you and raid them on a schedule;
  - read live logs and error screenshots;
  - run actions on demand;
  - edit every setting.
- **`deploy/`**:
  - `docker-compose.yml` for the VM: Postgres, the backend, Watchtower and Caddy.
  - `docker-compose.local.yml` for running the whole stack on your own machine.

## Releases (GitHub Actions)

`.github/workflows/release.yml` runs when a pull request merges to `master` (or from the
Actions tab, via "Run workflow"). It does four things:

1. **Version.** Each release is `<major>.<minor>.<run number>` (for example `0.2.17`). Major and
   minor come from `package.json`. The dashboard shows the version in its top bar. If the
   backend's version differs, it is shown next to it, so you can see when the two are out of
   step. `GET /api/health` also returns the version.
2. **Backend image.** Built and pushed to `ghcr.io/s4shashank12/auto-trav` with the tags
   `<version>`, `latest` and `sha-<commit>`.
3. **Dashboard.** Built with the same version, then deployed to Firebase Hosting.
4. **Cleanup.** Only the 5 newest builds are kept:
   - Older images are deleted from GHCR.
   - Firebase Hosting is told to keep only 5 releases, and deletes older ones itself.

`.github/workflows/ci.yml` runs on every pull request. It runs the unit tests, builds the
dashboard and checks that the image builds.

### One-time GitHub setup

- **Image visibility.** The first release creates the package as **private**. You have two
  options:
  - make it public: github.com → your profile → Packages → auto-trav → Package settings →
    Change visibility;
  - or give Watchtower a token (see `GHCR_USER`/`GHCR_TOKEN` in `deploy/.env.example`).
- **Cleanup permission.** The cleanup job deletes images with the workflow's own token. It
  needs the repository to have **Admin** under Package settings → Manage Actions access.
  Packages first published by the workflow get this automatically. If the job fails with a
  permission error, add the repository there with the Admin role.
- **Firebase deploy.** It is skipped, with a warning naming what is missing, until these are
  set in Settings → Secrets and variables → Actions, as *repository* secrets and variables (not
  environment, Codespaces or Dependabot ones):

  | Kind | Name | Value |
  | --- | --- | --- |
  | Secret | `FIREBASE_SERVICE_ACCOUNT` | JSON key of a service account with the **Firebase Hosting Admin** and **API Keys Viewer** roles. Create it under Google Cloud console → IAM → Service accounts, then Keys → Add key → JSON. |
  | Variable | `FIREBASE_PROJECT_ID` | Your Firebase project id. A repository secret with this name works too. |
  | Variable | `API_URL` | Optional. The backend URL the connect form suggests, e.g. `https://34-12-56-78.sslip.io`. |
  | Variable | `FIREBASE_SITE` | Optional. The Hosting site to deploy to. Defaults to `"site"` in `dashboard/firebase.json` (`auto-travian`, i.e. https://auto-travian.web.app). |

## Running on a GCP VM

Only the `deploy/` folder is needed on the VM. The backend image comes from GHCR.

### 1. Create the VM

The backend is built for small VMs:
- the image is about 200 MB to download (Node plus Chromium's headless shell only);
- Chromium only runs during a round and closes about a minute later, without loading images.

A round peaks around 450 MB and the backend idles at about 60 MB; Postgres, Caddy and
Watchtower add about 60 MB more. So:
- **e2-micro (1 GB, free tier):** fine for one or two accounts, with 2 GB of swap (below).
- **e2-small (2 GB):** comfortable for a few accounts.

Memory limits (`BACKEND_MEM_LIMIT`, `DB_MEM_LIMIT` in `.env`) keep the bot from starving
other programs on the VM.

From Cloud Shell, or anywhere with `gcloud`:

```bash
gcloud compute addresses create travian-bot-ip --region=us-central1
gcloud compute instances create travian-bot \
  --zone=us-central1-a --machine-type=e2-small \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB --tags=http-server,https-server \
  --address=travian-bot-ip
gcloud compute firewall-rules create allow-web \
  --allow=tcp:80,tcp:443 --target-tags=http-server,https-server
gcloud compute addresses describe travian-bot-ip --region=us-central1 --format='value(address)'
```

Notes:
- The console works too. Tick "Allow HTTP traffic" and "Allow HTTPS traffic", and reserve a
  static external IP.
- Ports 80 and 443 are for Caddy. Port 80 is only used to get the certificate. The API itself
  is never exposed on 8080.
- If `allow-web` already exists (the default `default-allow-http`/`https` rules do the same
  job), skip that command.

### 2. Install Docker (and swap on a 1 GB VM)

```bash
gcloud compute ssh travian-bot --zone=us-central1-a
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
docker compose version          # Docker Compose v2 is included

# 1 GB VMs: 2 GB of swap absorbs the short peaks of a round.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 3. Get the deploy files and configure them

```bash
git clone https://github.com/s4shashank12/auto-trav.git
cd auto-trav/deploy
cp .env.example .env
openssl rand -hex 32            # run twice: one value for ADMIN_TOKEN, one for APP_SECRET
nano .env
```

Private repository? Either clone it with a token
(`git clone https://<user>:<token>@github.com/...`), or copy just the folder from your
computer: `gcloud compute scp --recurse deploy travian-bot:~ --zone=us-central1-a`.

In `.env`, set at least:

| Variable | What to put |
| --- | --- |
| `ADMIN_TOKEN` | A random value. You type it into the dashboard to connect. |
| `APP_SECRET` | Another random value. It encrypts the stored Travian passwords, so keep it: changing it means re-entering them. |
| `POSTGRES_PASSWORD` | Any password for the bundled Postgres. |
| `API_DOMAIN` | A name pointing at the VM's IP. No domain? Use `<ip-with-dashes>.sslip.io`, e.g. `34-12-56-78.sslip.io`. |
| `CORS_ORIGINS` | Your dashboard URLs: `https://<project>.web.app,https://<project>.firebaseapp.com`. |
| `COMPOSE_PROFILES` | `local-db,https` (the default). This runs Postgres and Caddy on the VM. |

**Using your own database** (Cloud SQL, Supabase, Neon, any managed Postgres):
1. Drop `local-db` from `COMPOSE_PROFILES`.
2. Set `DATABASE_URL`. Connection strings with `?sslmode=require` work as the provider gives
   them.
3. If the database requires SSL and the URL doesn't say so, set `DATABASE_SSL`:

   | `DATABASE_SSL` | Meaning |
   | --- | --- |
   | `require` (or `true`) | Encrypted. The server's certificate is not checked. |
   | `verify-ca` | Encrypted, and the certificate must be signed by `DATABASE_SSL_CA`. Setting a CA turns this on. |
   | `verify-full` | As `verify-ca`, and the certificate must be issued for the host in `DATABASE_URL`. |
   | `false` | No encryption. |

   `DATABASE_SSL` wins over `sslmode` in the URL. With neither set, the connection is
   unencrypted.
4. Put certificate files in `deploy/certs`, which the backend sees as `/certs`, and point
   `DATABASE_SSL_CA`, `DATABASE_SSL_CERT` and `DATABASE_SSL_KEY` at them (see
   `deploy/certs/README.md`).

Cloud SQL example, with the instance's SSL mode set to "Allow only SSL connections":
- Encrypted, without checking the certificate: `DATABASE_SSL=require`.
- Also checking the certificate:
  1. Download `server-ca.pem` from the instance's Connections → Security page.
  2. Put it in `deploy/certs` and set `DATABASE_SSL_CA=/certs/server-ca.pem`.
  3. This uses `verify-ca`, because Cloud SQL's certificates name the instance, not its IP address.
- If the instance requires trusted client certificates:
  1. Create one on the same page.
  2. Add `DATABASE_SSL_CERT=/certs/client-cert.pem` and `DATABASE_SSL_KEY=/certs/client-key.pem`.
- Connect the VM over the instance's private IP (same VPC), or add the VM's external IP under
  "Authorized networks".

Tables are created and migrated on start. The backend's log shows `Database ready (SSL: …)` with
the mode in use. If it can't connect, the error says which setting to change.

### 4. Start it

```bash
# Only while the GHCR package is private:
echo <github-token-with-read:packages> | docker login ghcr.io -u <github-user> --password-stdin

docker compose up -d
docker compose ps                         # backend "healthy", db "healthy", caddy and watchtower up
curl https://<API_DOMAIN>/api/health      # {"ok":true,"version":"0.2.17"}
```

**Ports 80 or 443 already in use** (another web server on the VM)? Use the `https-port`
profile instead: set `COMPOSE_PROFILES=local-db,https-port` and `API_PORT=15678` (any port
open in the firewall).
- Let's Encrypt can only verify a domain on ports 80/443, so Caddy uses its own certificate
  there, valid for a year and renewed automatically.
- Before the first connection, open `https://<API_DOMAIN>:15678/api/health` in each browser you
  use and accept the certificate warning.
- In the dashboard, the backend URL is then `https://<API_DOMAIN>:15678`.
- If the other web server already has HTTPS for a domain, a cleaner option is to proxy a
  hostname or path there to `127.0.0.1:8080`, and run without Caddy.

Then open the dashboard on Firebase:
1. Enter `https://<API_DOMAIN>` (plus `:API_PORT` with `https-port`) and your `ADMIN_TOKEN`.
2. Add your Travian accounts (game world URL, username, password).
3. Press Start.

Accounts that were running start again by themselves after a restart or update
(`AUTOSTART=true`).

> Run each Travian account in one place only. Two bots on the same account fight over the
> build queue and the active village. Stop any other copy before starting it on the VM.

### 5. Day to day

| Task | Command (in `~/auto-trav/deploy`) |
| --- | --- |
| Logs | `docker compose logs -f backend` (the dashboard's Logs tab shows the same per account) |
| Update now | Watchtower checks GHCR every 5 minutes and restarts the backend on a new image. To force it: `docker compose pull backend && docker compose up -d backend`. |
| Which version is running | `curl https://<API_DOMAIN>/api/health`, or the version pill in the dashboard |
| Pin a version | Set `IMAGE=ghcr.io/s4shashank12/auto-trav:0.2.17` in `.env`, then `docker compose up -d`. |
| Restart | `docker compose restart backend` |
| Stop everything | `docker compose down` (data stays in the volumes) |
| Back up | `docker compose exec db pg_dump -U travian travian > backup-$(date +%F).sql` |
| Restore | `docker compose exec -T db psql -U travian travian < backup.sql` |
| Change settings in `.env` | `docker compose up -d` (recreates what changed) |

Watchtower only touches containers labelled for it. Postgres and Caddy are never restarted by
it.

## Dashboard on Firebase Hosting

After the one-time setup above, every release deploys it. To deploy by hand instead:

```bash
cd dashboard
npm ci
VITE_API_URL=https://api.example.com VITE_APP_VERSION=manual npm run build
npx firebase-tools login
npx firebase-tools deploy --only hosting --project <your-firebase-project-id>
```

## Running the whole stack locally

`deploy/docker-compose.local.yml` builds the backend and dashboard from this checkout and runs
them with Postgres. Everything is bound to 127.0.0.1:

```bash
cd deploy
docker compose -f docker-compose.local.yml up -d --build
# dashboard: http://localhost:8081   backend: http://localhost:8080   token: local-admin-token-change-me
docker compose -f docker-compose.local.yml down        # add -v to also delete the data
```

Notes:
- `ADMIN_TOKEN`, `APP_SECRET`, `APP_VERSION`, `BACKEND_PORT` and `DASHBOARD_PORT` can be set in
  the environment.
- `AUTOSTART` is off here, so a local copy never quietly starts playing an account the VM also
  plays.
- Turn on "Dry run" in an account's settings to see what the bot would do without clicking
  anything.

## Security notes

- Every API route except `/api/health` needs `Authorization: Bearer <ADMIN_TOKEN>`. Repeated
  wrong tokens from one IP are refused for 10 minutes.
- The backend listens on `127.0.0.1:8080` by default, and only Caddy is exposed.
- Travian passwords are encrypted with a key derived from `APP_SECRET`, and the API never
  returns them.
- The dashboard keeps the backend URL and token in the browser's localStorage. Use Disconnect
  on shared machines.

## What the bot does

Each account's settings start from the defaults in `src/config.js`. The dashboard's Settings tab
changes them per account; only the changed values are stored.

- **Building** (villages under `build.populationLimit`, default 500):
  - Resource fields and the listed buildings (Main Building, Warehouse, Granary, Marketplace and
    the five production buildings) go to max.
  - Each queue holds `build.queueMax` jobs (3 for Romans with Travian Plus).
  - Fields go lowest level first, with cropland first when crop runs low.
  - Missing buildings are constructed once the game allows them.
  - Military buildings are never built, and population is re-checked before every click.
- **Supply:**
  - A small village under 30% of storage gets merchants from the nearest big village with a
    surplus. Shipments already on the way count.
  - A job that is still short uses the game's own "transfer from hero" dialog, which the build
    page pre-fills with exactly the shortfall.
  - Gold (NPC exchange, master builder) is never used.
- **Training:**
  - Big villages keep their barracks and stables queued 3 hours ahead with the configured
    unit: Praetorians and Equites Caesaris by default, with per-village overrides such as
    Imperians in one barracks.
  - Training uses only resources above the reserve.
- **Reinforcement:** a village whose crop would drop under 200/h stops training and sends
  troops to the capital (or `reinforce.target`), until it is back to 600/h. That happens only
  while the target keeps at least 2,000/h.
- **Raiding oases:**
  - Only unoccupied oases with no animals are raided, and only through farm lists whose names
    start with `raid.listPrefix`. Other farm lists and "Start all farm lists" are never used.
  - "Farm list setup" fills lists of up to 100 targets per unit type ("rainbow" farming): slow
    infantry takes the nearest oases and cavalry the far ones.
  - A wave goes out every `raid.everyMinutes` (10), whether or not earlier raids are back. The
    nearest targets go first, and troops at home are the limit.
  - Every target is checked on the live map right before sending.
  - Raids carry 10 infantry or 5 cavalry: a lone unit sometimes dies even against an empty
    oasis's base defence.
- **Inactive players** (off until you switch it on in the "Inactive players" tab):
  - **Detection.** Once a day the bot downloads the game world's public `map.sql` (every
    village with its owner and population) and keeps 14 days of it. A player counts as
    inactive when their total population has not grown in `inactive.days` (3) days, so the
    list appears after 4 daily snapshots.
  - **Filters:** distance (`radius`), village population range, your own alliance, Natars and
    nature, and any alliances or players you skip.
  - **Farm lists.** Targets go into "Inactives (auto)" farm lists at the nearest village that
    has enough of a raiding unit (by default 10 Equites Imperatoris or Caesaris, else 20
    Imperians or Legionnaires). Targets that start growing again are removed.
  - **Schedule.** Each target is raided at most every `inactive.everyMinutes` (60),
    optionally only within `inactive.hours` (e.g. `6-23` in your timezone).
  - The tab lists the current targets, and "Skip player" leaves a player alone from then on.
  - Inactive accounts can still have troops or defences at home. Watch the first reports and
    raise the troops per raid if raids come back with losses.

## Development

```bash
npm install
npm test                                 # unit tests
npm run server                           # backend; needs ADMIN_TOKEN, APP_SECRET, DATABASE_URL in .env
cd dashboard && npm install && npm run dev
```

The single-account command line still works without Postgres. Credentials come from
`TRAVIAN_SERVER`, `TRAVIAN_USERNAME` and `TRAVIAN_PASSWORD`, and settings from
`bot.config.json` (overrides of `src/config.js`) plus the variables in `.env.example`:

```bash
npm run villages | build | train | raid | farm-setup | play
npm run loop                             # play until stopped
node src/cli.js world                    # import today's map.sql (the loop does this daily)
node src/cli.js inactives                # list inactive players near your villages
DRY_RUN=true npm run play                # log what would happen without clicking
```

On Claude Code on the web, run `scripts/trust-proxy-ca.sh` once per session so Chromium trusts
the sandbox's proxy.
