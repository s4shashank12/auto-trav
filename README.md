# auto-travian

A small Playwright script that logs into a Travian Legends game world and keeps a village's
resource fields growing evenly.

> Travian's game rules forbid automated play, and accounts caught running bots can be banned.
> Use this at your own risk.

## What it does

Each pass of `play`:

1. Logs in, or reuses the saved session in `.auth/state.json`.
2. Reads the resource overview (`dorf1.php`): stock, storage, production, field levels and the build queue.
3. If the build queue has a free slot, it upgrades the resource field with the lowest level.
   When several fields tie, it picks the resource you hold the least of. Cropland goes first
   when net crop production falls under 10/h.

It waits a random 0.3–2.2 s between clicks. In `--loop` mode it sleeps until the current build
finishes, clamped to 5–45 minutes by default.

## Setup

```bash
npm install
npx playwright install chromium   # skip if Chromium is already provided
cp .env.example .env              # fill in server, username, password
```

`TRAVIAN_SERVER` is the game world URL from your address bar, for example
`https://ts1.x1.international.travian.com`.

## Usage

```bash
npm run status        # print the village overview and save a screenshot
npm run play          # one upkeep pass
npm run loop          # keep playing until stopped
npm run screenshot -- /build.php?id=1
DRY_RUN=true npm run play   # show what would be built without clicking
```

Screenshots are saved to `screenshots/`.

### Claude Code on the web

Chromium doesn't trust the sandbox's egress proxy by default. Run `scripts/trust-proxy-ca.sh`
once per session before launching the browser.
