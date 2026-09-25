# auto-travian

A Playwright bot for a Travian Legends account. It grows small villages and raids empty oases
through the game's own farm lists.

> Travian's game rules forbid automated play. The game says it answers suspected bots with
> CAPTCHAs, then emptied warehouses, troop losses and a ban. The bot makes no attempt to hide
> itself. If a CAPTCHA appears, it stops immediately. Use it at your own risk.

## Rules the bot follows

All rules live in [`src/rules.js`](src/rules.js).

- **Villages with 500 or more population:** no building or resource-field upgrades.
- **Villages under 500 population:** resource fields and economy buildings go to max. Economy
  buildings are Main Building, Warehouse, Granary, Marketplace, Sawmill, Brickyard, Iron Foundry,
  Grain Mill and Bakery. Military buildings are never touched. Population is re-checked on the
  village's own page before every build.
- **Attacks:** only raids on unoccupied oases that have no animals, and only through farm lists
  named `Oases (auto) …`. Other farm lists and "Start all farm lists" are never used.

## Commands

```bash
npm run villages     # villages, population and whether the bot may build there
npm run build        # one pass over the small villages
npm run farm-setup   # create/refresh the "Oases (auto) near/far" farm lists
npm run raid         # re-check the oases on the map and start the farm lists
npm run play         # build + raid
npm run loop         # build + raid every 20-40 minutes until stopped
npm run screenshot -- /build.php?id=39&gid=16&tt=99
DRY_RUN=true npm run play   # log what would happen without clicking
```

### Building

Romans can upgrade one resource field and one building at the same time, and the bot fills both
queues. Fields go lowest level first. Ties go to the resource you hold the least of, and cropland
goes first when net crop falls under 10/h. Buildings go least developed first, compared with their
max level. Missing buildings are constructed on an empty slot once the game allows them.

### Raiding

`farm-setup` does the following:

1. Finds the villages with cavalry (Equites Imperatoris `t5` or Equites Caesaris `t6`).
2. Scans the map around each one for unoccupied oases with no animals, within `RAID_RADIUS`
   (default 20).
3. Gives each oasis to the nearest village.
4. Fills two lists per village:
   - `Oases (auto) near`: under 10 fields, fast `t5` first.
   - `Oases (auto) far`: `t6` first.

   Each oasis gets up to `RAID_PER_SLOT` units (default 5), split so the village's cavalry covers
   every target. Re-running only adds oases that are not on a list yet.

`raid` looks up every target on the map again. It ticks only the slots whose oasis is still
unoccupied and empty and has no raid already under way. Then it presses Start, which sends only
the ticked slots. An oasis with animals again, or one a player has taken, is skipped until it
qualifies again.

## Setup

```bash
npm install
npx playwright install chromium   # skip if Chromium is already provided
cp .env.example .env              # fill in server, username, password
```

`TRAVIAN_SERVER` is the game world URL from your address bar, for example
`https://ts4.x1.international.travian.com`.

Only one run drives the browser at a time. Runs share a lock file (`.auth/bot.lock`), because the
game keeps a single "active village" per session. Screenshots go to `screenshots/`.

### Claude Code on the web

Chromium doesn't trust the sandbox's egress proxy by default. Run `scripts/trust-proxy-ca.sh`
once per session before launching the browser.
