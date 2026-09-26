import fs from 'node:fs/promises';
import {
  AUTO_FARM_LIST_PREFIX, FARM_LIST_SIZE, RAID_UNITS, isAutoFarmList, isRaidableOasis, oasisAnimals,
} from './rules.js';

// Map tiles fetched in 31x31 windows, reusing a window for every tile it covers.
export class TileCache {
  constructor(game) {
    this.game = game;
    this.windows = [];
  }

  covering(x, y) {
    return this.windows.find((w) => Math.abs(w.x - x) <= 14 && Math.abs(w.y - y) <= 14);
  }

  async get(x, y) {
    let win = this.covering(x, y);
    if (!win) {
      win = { x, y, tiles: await this.game.mapTiles(x, y) };
      this.windows.push(win);
      await this.game.pause(300, 800);
    }
    return win.tiles.get(`${x}|${y}`);
  }

  // Every tile within `radius` fields (a square) of (x, y).
  async area(x, y, radius) {
    const steps = Math.ceil(radius / 29);
    for (let i = -steps; i <= steps; i++) {
      for (let j = -steps; j <= steps; j++) await this.get(x + i * 29, y + j * 29);
    }
    const tiles = [];
    for (const w of this.windows) {
      for (const t of w.tiles.values()) {
        if (Math.abs(t.position.x - x) <= radius && Math.abs(t.position.y - y) <= radius) tiles.push(t);
      }
    }
    return tiles;
  }
}

const key = (x, y) => `${x}|${y}`;

// The unit an auto farm list raids with: the one its first slot sends most of.
export function listUnit(list) {
  const troop = list.slots[0]?.troop;
  if (troop) return Object.keys(RAID_UNITS).sort((a, b) => (troop[b] ?? 0) - (troop[a] ?? 0))[0];
  const words = list.name.slice(AUTO_FARM_LIST_PREFIX.length).trim().replace(/ \d+$/, '');
  return Object.entries(RAID_UNITS).find(([, u]) => words === u.short || words === u.name)?.[0];
}

// How many more farm list targets each raiding unit of a village can take on, budgeting
// `planUnits` per target: its troops at home plus the targets being raided (their troops are out),
// minus the targets it already has.
export function slotCapacity(home, lists) {
  const cap = {};
  for (const [unit, { planUnits }] of Object.entries(RAID_UNITS)) {
    const slots = lists.flatMap((l) => l.slots).filter((s) => (s.troop[unit] ?? 0) > 0);
    const running = slots.filter((s) => s.isRunning).length;
    cap[unit] = Math.max(0, Math.floor((home[unit] ?? 0) / planUnits) + running - slots.length);
  }
  return cap;
}

// Splits a village's oases (nearest first) between its raiding units in proportion to what each
// can cover: slow units take the nearest band, fast units the farthest ("rainbow" farming).
export function splitByUnit(oases, cap) {
  const units = Object.keys(RAID_UNITS).filter((u) => cap[u] > 0);
  const total = units.reduce((n, u) => n + cap[u], 0);
  const take = Object.fromEntries(units.map((u) => [u, Math.min(cap[u], Math.floor((oases.length * cap[u]) / total))]));
  let left = oases.length - units.reduce((n, u) => n + take[u], 0);
  for (const u of [...units].reverse()) {
    const extra = Math.min(left, cap[u] - take[u]);
    take[u] += extra;
    left -= extra;
  }
  const plan = [];
  let i = 0;
  for (const u of units) {
    plan.push({ unit: u, targets: oases.slice(i, i + take[u]) });
    i += take[u];
  }
  return plan.filter((p) => p.targets.length);
}

// Fills the bot's farm lists with every empty, unoccupied oasis within `radius` fields of the
// village raiding it, up to FARM_LIST_SIZE slots per list, one list set per unit type. Each oasis
// goes to one list only, and bot slots farther than `radius` are removed. Safe to re-run.
export async function setupFarmLists(game, villages, { radius = 45 } = {}) {
  let lists = (await game.farmLists()).filter(isAutoFarmList);
  const byId = new Map(villages.map((v) => [v.did, v]));
  const tooFar = lists.flatMap((l) => {
    const owner = byId.get(l.ownerVillage.id);
    return l.slots.filter((s) => Math.hypot(s.target.x - owner.x, s.target.y - owner.y) > radius).map((s) => s.id);
  });
  if (tooFar.length) {
    game.log(`Removing ${tooFar.length} targets more than ${radius} fields from their village.`);
    await game.deleteFarmListSlots(tooFar);
    lists = (await game.farmLists()).filter(isAutoFarmList);
  }

  // Bring every bot slot to its unit's current per-raid amount.
  const resize = lists.flatMap((l) => l.slots.map((s) => ({ l, s, unit: listUnit(l) })))
    .filter(({ s, unit }) => Object.entries(s.troop).some(([u, n]) => n !== (u === unit ? RAID_UNITS[unit].perSlot : 0)))
    .map(({ l, s, unit }) => ({ id: s.id, listId: l.id, x: s.target.x, y: s.target.y, troops: { [unit]: RAID_UNITS[unit].perSlot } }));
  if (resize.length) {
    game.log(`Setting ${resize.length} targets to ${Object.values(RAID_UNITS).map((u) => `${u.perSlot} ${u.name}`).join(' / ')} per raid.`);
    await game.updateFarmListSlots(resize);
    lists = (await game.farmLists()).filter(isAutoFarmList);
  }
  const troops = await game.villageTroops();
  const known = new Set(lists.flatMap((l) => l.slots.map((s) => key(s.target.x, s.target.y))));

  const raiders = villages
    .map((v) => ({ ...v, cap: slotCapacity(troops.get(v.did) ?? {}, lists.filter((l) => l.ownerVillage.id === v.did)) }))
    .filter((v) => Object.values(v.cap).some((n) => n > 0));
  for (const v of raiders) {
    game.log(`${v.name}: room for ${Object.entries(v.cap).filter(([, n]) => n).map(([u, n]) => `${n} ${RAID_UNITS[u].name}`).join(', ')} slots.`);
  }

  const tiles = new TileCache(game);
  const oases = new Map();
  for (const v of raiders) {
    for (const t of await tiles.area(v.x, v.y, radius)) {
      if (isRaidableOasis(t) && !known.has(key(t.position.x, t.position.y))) oases.set(key(t.position.x, t.position.y), t.position);
    }
  }
  game.log(`Found ${oases.size} new empty, unoccupied oases within ${radius} fields.`);

  // Nearest village with room left gets each oasis.
  const room = new Map(raiders.map((v) => [v.did, Object.values(v.cap).reduce((a, b) => a + b, 0)]));
  const pairs = [];
  for (const o of oases.values()) {
    for (const v of raiders) {
      const dist = Math.hypot(o.x - v.x, o.y - v.y);
      if (dist <= radius) pairs.push({ o, v, dist });
    }
  }
  pairs.sort((a, b) => a.dist - b.dist);
  const assigned = new Map(raiders.map((v) => [v.did, []]));
  const taken = new Set();
  for (const { o, v, dist } of pairs) {
    if (taken.has(key(o.x, o.y)) || room.get(v.did) <= 0) continue;
    taken.add(key(o.x, o.y));
    room.set(v.did, room.get(v.did) - 1);
    assigned.get(v.did).push({ ...o, dist });
  }

  for (const v of raiders) {
    for (const { unit, targets } of splitByUnit(assigned.get(v.did), v.cap)) {
      const { name, short, perSlot } = RAID_UNITS[unit];
      const troopsPerSlot = { [unit]: perSlot };
      let pending = targets;
      while (pending.length) {
        let list = lists.find((l) => l.ownerVillage.id === v.did && listUnit(l) === unit && l.slots.length < FARM_LIST_SIZE);
        if (!list) {
          const base = `${AUTO_FARM_LIST_PREFIX} ${short}`;
          const taken = new Set(lists.filter((l) => l.ownerVillage.id === v.did).map((l) => l.name));
          let listName = base;
          for (let n = 2; taken.has(listName); n++) listName = `${base} ${n}`;
          const id = await game.createFarmList({ did: v.did, villageName: v.name, name: listName, troops: troopsPerSlot });
          if (!id) break;
          lists = (await game.farmLists()).filter(isAutoFarmList);
          list = lists.find((l) => l.id === id);
        }
        const batch = pending.slice(0, FARM_LIST_SIZE - list.slots.length);
        pending = pending.slice(batch.length);
        game.log(`${v.name}: adding ${batch.length} oases (${batch[0].dist.toFixed(0)}-${batch.at(-1).dist.toFixed(0)} fields) to "${list.name}", ${perSlot} ${name} each.`);
        await game.addFarmListSlots(list.id, batch, troopsPerSlot);
        list.slots.push(...batch.map((t) => ({ target: t, troop: troopsPerSlot, isActive: true })));
      }
    }
  }
}

function unsafeReason(tile) {
  if (!tile) return 'not on the map';
  if (tile.title !== '{k.fo}' || tile.uid != null) return 'no longer an unoccupied oasis';
  return `${oasisAnimals(tile)} animals`;
}

const RAID_STATE = '.auth/raid-state.json';

// Sends one raid wave from the bot's own farm lists ("rainbow" farming on an interval). Every wave
// (every `waveMinutes`) each list sends its targets again, whether or not earlier raids are back,
// so every target is raided about once per `cycleMinutes` (by default every wave). Nearest targets
// go first: their troops return soonest, so as many oases as the troops can sustain are hit every
// wave, and far ones get what is left. A target is not raided twice within one cycle, and troops at
// home are the other limit. Right before sending, each target is checked on the map again and only
// oases that are still unoccupied and animal-free are sent.
export async function runFarmLists(game, { waveMinutes = 10, cycleMinutes = 10 } = {}) {
  const lists = (await game.farmLists()).filter(isAutoFarmList);
  if (!lists.length) {
    game.log('No "Oases (auto)" farm lists yet; run farm-setup first.');
    return;
  }
  const lastSent = JSON.parse(await fs.readFile(RAID_STATE, 'utf8').catch(() => '{}'));
  const villages = new Map((await game.villages()).map((v) => [v.did, v]));
  const tiles = new TileCache(game);
  const homes = new Map();
  const now = Date.now();
  const fresh = (cycleMinutes - waveMinutes / 2) * 60_000;
  for (const list of lists.filter((l) => l.slots.length)) {
    const did = list.ownerVillage.id;
    const owner = villages.get(did);
    if (!homes.has(did)) homes.set(did, { ...(list.ownerVillage.troops?.ownTroopsAtTown?.units ?? {}) });
    const home = homes.get(did);
    const dist = (s) => Math.hypot(s.target.x - owner.x, s.target.y - owner.y);
    const active = list.slots.filter((s) => s.isActive);
    const quota = Math.ceil((active.length * waveMinutes) / cycleMinutes);
    const order = active.filter((s) => now - (lastSent[s.id] ?? 0) >= fresh)
      .sort((a, b) => dist(a) - dist(b));
    const send = [];
    let unsafe = 0;
    let short = 0;
    for (const slot of order) {
      if (send.length >= quota) break;
      if (!Object.entries(slot.troop).every(([u, n]) => (home[u] ?? 0) >= n)) {
        short++;
        continue;
      }
      const tile = await tiles.get(slot.target.x, slot.target.y);
      if (!isRaidableOasis(tile)) {
        unsafe++;
        game.log(`${list.ownerVillage.name} "${list.name}": skipping (${slot.target.x}|${slot.target.y}), ${unsafeReason(tile)}.`);
        continue;
      }
      for (const [u, n] of Object.entries(slot.troop)) home[u] -= n;
      send.push(slot);
    }
    const running = list.slots.filter((s) => s.isRunning).length;
    const summary = `${running}/${list.slots.length} targets being raided`
      + `${short ? `, ${short} waiting for troops` : ''}${unsafe ? `, ${unsafe} unsafe` : ''}`;
    if (!send.length) {
      game.log(`${list.ownerVillage.name} "${list.name}": nothing to send this wave (${summary}).`);
      continue;
    }
    const results = await game.startFarmListTargets(list.id, send.map((s) => s.id));
    const failed = results.filter((r) => r.error);
    for (const r of results.filter((x) => !x.error)) lastSent[r.id] = now;
    game.log(`${list.ownerVillage.name} "${list.name}": wave of ${results.length - failed.length}/${send.length}`
      + `${failed.length ? `, not sent: ${[...new Set(failed.map((r) => JSON.stringify(r.error)))].join(', ')}` : ''} (${summary}).`);
  }
  if (!game.dryRun) {
    await fs.mkdir('.auth', { recursive: true });
    await fs.writeFile(RAID_STATE, JSON.stringify(lastSent));
  }
}
