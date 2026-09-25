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
- **Troops:** the big villages' barracks and stables train defensive units only. Villages short
  on crop send defensive troops to Chingdi as reinforcements.

## Commands

```bash
npm run villages     # villages, population and whether the bot may build there
npm run build        # one pass over the small villages
npm run farm-setup   # fill the "Oases (auto)" farm lists (100 per list, per unit type)
npm run raid         # re-check the oases on the map and start the farm lists
npm run train        # keep barracks and stables training defensive troops
npm run play         # build + train + raid
npm run loop         # keep playing until stopped
npm run screenshot -- /build.php?id=39&gid=16&tt=99
DRY_RUN=true npm run play   # log what would happen without clicking
```

### Building

Romans can upgrade one resource field and one building at the same time. With Travian Plus, one
more job fits in the waiting loop. The bot keeps each small village's queue at `BUILD_QUEUE_MAX`
jobs (default 3; use 2 without Plus). In `--loop` mode it wakes up when the first job finishes, so
queues don't sit idle, and raids at most every `RAID_EVERY_MINUTES` (default 10).

Fields go lowest level first. Ties go to the resource you hold the least of, and cropland
goes first when net crop falls under 10/h. Buildings go least developed first, compared with their
max level. Missing buildings are constructed on an empty slot once the game allows them.

Queues are kept busy from two sources of resources:

- **Merchants:** when a small village drops under 30% of its storage in any resource, the nearest
  big village with a surplus sends merchants to top it up towards 70%. Shipments already on the way
  count towards that, and every source keeps 20,000 of each resource.
- **Hero inventory:** when a job is still short, the bot clicks the missing resource on the build
  page. That opens the game's own "transfer from hero" dialog, pre-filled with exactly the
  shortfall. The bot confirms it, then builds. It never uses gold (NPC exchange, master builder).

### Raiding ("rainbow" farming)

`farm-setup` does the following:

1. Works out how many more slots each village's raiding units can cover. Raiding units are
   Legionnaires, Imperians, Equites Caesaris and Equites Imperatoris; Praetorians and scouts never
   farm. The count uses troops at home plus those out on raids.
2. Scans the map for unoccupied oases with no animals within `RAID_RADIUS` fields (default 45) of
   those villages.
3. Gives each oasis to the nearest village with room.
4. Splits each village's oases between its unit types by distance: slow infantry takes the
   nearest band and fast cavalry the farthest.
5. Files them into lists named `Oases (auto) <unit>`, up to 100 targets each, adding lists as
   needed.

Each oasis is in one list only. Re-running adds new oases and removes bot targets beyond the
radius. Your own farm lists are never touched.

`raid` checks every target on the map again right before sending. It sends only slots whose oasis
is still unoccupied and empty, has no raid under way, and whose troops are at home (shared across
a village's lists). An oasis with animals again, or one a player has taken, is skipped until it
qualifies again.

### Defensive troops

`train` keeps the barracks (Praetorians) and stables (Equites Caesaris, where researched) of the
big villages training. It tops a queue up to 3 hours whenever less than 1 hour is left, using only
resources above 5,000 of each. Small villages keep their resources for building. Training stops
once a village's net crop would drop under 200/h. At that point the village sends enough
Praetorians (then Equites Caesaris) to Chingdi as reinforcements to get back to 600/h, so their
upkeep moves to the capital. That happens only while Chingdi keeps at least 2,000/h, and not
again until the previous reinforcement has arrived. Tune these in `src/rules.js`.

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
