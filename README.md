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
                                             └──────────────────────────┘
       GitHub Actions ── merge to master ──▶ ghcr.io image ◀── Watchtower pulls updates
```

- **`src/`**: the bot. It builds in small villages, ships resources, uses hero resources,
  trains troops, reinforces when crop is low, and raids oases in waves. Every rule is a setting
  (`src/config.js`).
- **`src/server/`**: the backend.
  - A REST API behind a bearer token.
  - Postgres storage, with Travian passwords encrypted using AES-256-GCM.
  - One worker per Travian account, all sharing one Chromium.
- **`dashboard/`**: a static React app for Firebase Hosting. From it you can:
  - add Travian accounts on any game world;
  - start and stop them;
  - see villages, build queues, raids and training;
  - read live logs and error screenshots;
  - run actions on demand;
  - edit every setting.
- **`deploy/`**: `docker-compose.yml` for the VM, with Postgres, the backend, Watchtower and
  Caddy.

## Deploying

### 1. Container image (GitHub Actions → GHCR)

`.github/workflows/docker.yml` builds the backend image:

- **On every pull request:** checks that the image builds.
- **When a PR merges to `master`:** pushes it to `ghcr.io/s4shashank12/auto-travian` as
  `latest` and `sha-<commit>`.

It needs no secrets. The first push creates the package as **private**. Either make it public
(the package's settings on GitHub), or give Watchtower a token with `read:packages` (step 2).

`.github/workflows/ci.yml` runs the unit tests and builds the dashboard on every PR.

### 2. Backend on the VM

On a GCP VM with Docker (e2-small or larger; each account's browser context needs a few
hundred MB):

```bash
git clone https://github.com/s4shashank12/auto-travian.git && cd auto-travian/deploy
cp .env.example .env
openssl rand -hex 32   # use one for ADMIN_TOKEN, another for APP_SECRET
nano .env              # tokens, POSTGRES_PASSWORD, API_DOMAIN, CORS_ORIGINS
# While the GHCR package is private:
echo <token> | docker login ghcr.io -u <github-user> --password-stdin
docker compose up -d
docker compose logs -f backend
```

- **Database.** With `COMPOSE_PROFILES` including `local-db`, Postgres runs in the stack. To
  use your own database instead, such as Cloud SQL or a managed Postgres:
  1. remove `local-db` from `COMPOSE_PROFILES`;
  2. set `DATABASE_URL` (plus `DATABASE_SSL=true` if the database requires TLS);
  3. or use the standard `PGHOST`/`PGUSER`/… variables.

  Tables are created and migrated automatically on start.
- **HTTPS.** The dashboard is served over HTTPS, so browsers only let it call an HTTPS API.
  With the `https` profile, Caddy gets a Let's Encrypt certificate for `API_DOMAIN`:
  1. point that name at the VM's external IP;
  2. allow ports 80 and 443 in the VPC firewall.

  No domain? `<ip-with-dashes>.sslip.io` (for example `34-12-56-78.sslip.io`) works.
- **Updates.** Watchtower checks GHCR every 5 minutes and restarts the backend on a new
  image. Only containers labelled for it are touched, so Postgres and Caddy are never
  restarted. Running accounts resume on their own (`AUTOSTART=true`).
- **Backups.** Everything lives in the `pgdata` volume, or in your own database. For example:
  `docker compose exec db pg_dump -U travian travian > backup.sql`.

### 3. Dashboard on Firebase Hosting

```bash
cd dashboard
npm ci
VITE_API_URL=https://api.example.com npm run build   # optional: pre-fills the connect form
npx firebase-tools login
npx firebase-tools deploy --only hosting --project <your-firebase-project-id>
```

Put the site's URLs (`https://<project>.web.app`, `https://<project>.firebaseapp.com`) in the
backend's `CORS_ORIGINS`. Open the site, enter the backend URL and `ADMIN_TOKEN`, and add your
accounts.

`.github/workflows/dashboard.yml` can deploy it on every merge instead. It stays skipped until
these are set:
- the repository secret `FIREBASE_SERVICE_ACCOUNT` (a service account JSON key with Firebase
  Hosting Admin);
- the repository variables `FIREBASE_PROJECT_ID` and `API_URL`.

### Security notes

- Every API route except `/api/health` needs `Authorization: Bearer <ADMIN_TOKEN>`. Repeated
  wrong tokens from one IP are refused for 10 minutes.
- The backend listens on `127.0.0.1:8080` by default, and only Caddy is exposed.
- Travian passwords are encrypted with a key derived from `APP_SECRET`. The API never returns
  them. Keep `APP_SECRET` safe: changing it makes stored passwords unreadable, so you would
  have to re-enter them.
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
- **Raiding:**
  - Only unoccupied oases with no animals are raided, and only through farm lists whose names
    start with `raid.listPrefix`. Other farm lists and "Start all farm lists" are never used.
  - "Farm list setup" fills lists of up to 100 targets per unit type ("rainbow" farming): slow
    infantry takes the nearest oases and cavalry the far ones.
  - A wave goes out every `raid.everyMinutes` (10), whether or not earlier raids are back. The
    nearest targets go first, and troops at home are the limit.
  - Every target is checked on the live map right before sending.
  - Raids carry 10 infantry or 5 cavalry: a lone unit sometimes dies even against an empty
    oasis's base defence.

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
DRY_RUN=true npm run play                # log what would happen without clicking
```

On Claude Code on the web, run `scripts/trust-proxy-ca.sh` once per session so Chromium trusts
the sandbox's proxy.
