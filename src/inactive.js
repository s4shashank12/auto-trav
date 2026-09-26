// Raiding inactive players: import the world's daily map.sql, pick the villages of players who
// stopped growing, keep them in the bot's "Inactives (auto)" farm lists and raid them on a schedule.
import { findInactives, parseMapSql, today } from './world.js';

const IMPORT_STATE = 'world-import';
const RAID_STATE = 'inactive-raids';

// True when `now` falls within cfg.inactive.hours ("6-23", "22-5" wraps midnight; empty = always).
export function inRaidHours(cfg, now = new Date()) {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(cfg.inactive.hours ?? '');
  if (!m) return true;
  const [from, to] = [Number(m[1]), Number(m[2])];
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: cfg.inactive.timezone || 'UTC' }).format(now));
  return from <= to ? hour >= from && hour <= to : hour >= from || hour <= to;
}

// Downloads today's map.sql once a day and stores it. Returns the day imported, or null if today's
// snapshot is already there.
export async function importWorld(game, world, cfg, { force = false } = {}) {
  const day = today();
  const last = await game.store?.get(IMPORT_STATE);
  if (!force && last?.day === day) return null;
  const text = await game.fetchText('/map.sql');
  const rows = parseMapSql(text);
  if (rows.length < 10) throw new Error(`map.sql looks empty (${rows.length} villages)`);
  await world.saveDay(day, rows);
  await world.prune(cfg.inactive.keepDays);
  await game.store?.set(IMPORT_STATE, { day, villages: rows.length, at: Date.now() });
  game.log(`World data for ${day}: ${rows.length} villages.`);
  return day;
}

const isInactiveList = (list, cfg) => list.name.startsWith(cfg.inactive.listPrefix);

// Unit each raiding village uses: the first in cfg.inactive.units it has enough of, counting
// troops at home plus those out on raids from its farm lists (they come back).
function raidingUnits(villages, troops, allLists, cfg) {
  const allowed = new Set(cfg.inactive.villages);
  const out = new Map();
  for (const v of villages) {
    if (allowed.size && !allowed.has(v.name)) continue;
    const total = { ...(troops.get(v.did) ?? {}) };
    for (const l of allLists.filter((x) => x.ownerVillage.id === v.did)) {
      for (const s of l.slots.filter((x) => x.isRunning)) {
        for (const [u, n] of Object.entries(s.troop)) total[u] = (total[u] ?? 0) + n;
      }
    }
    const pick = cfg.inactive.units.find((u) => (total[u.unit] ?? 0) >= u.perSlot);
    if (pick) out.set(v.did, pick);
  }
  return out;
}

// Keeps the bot's inactive farm lists in line with the current inactive players: targets that
// started growing again (or were excluded) are removed, new ones are added to the nearest village
// that can raid them. Returns what it found and changed.
export async function syncInactiveLists(game, villages, world, cfg) {
  const found = await findInactives(world, villages, cfg);
  if (!found.ready) {
    game.log(`Inactive players: need ${found.needDays} days of world data, have ${found.days}.`);
    return { ...found, added: 0, removed: 0 };
  }
  const troops = await game.villageTroops();
  const allLists = await game.farmLists();
  const units = raidingUnits(villages, troops, allLists, cfg);
  const byDid = new Map(villages.map((v) => [v.did, v]));
  const key = (x, y) => `${x}|${y}`;

  // Nearest raiding village for each target, at most maxTargets per village.
  const perVillage = new Map();
  for (const t of found.targets) {
    let best = null;
    for (const did of units.keys()) {
      const v = byDid.get(did);
      const dist = Math.hypot(t.x - v.x, t.y - v.y);
      if (dist <= cfg.inactive.radius && (!best || dist < best.dist)) best = { did, dist };
    }
    if (!best) continue;
    const list = perVillage.get(best.did) ?? [];
    if (list.length < cfg.inactive.maxTargets) list.push({ ...t, dist: best.dist });
    perVillage.set(best.did, list);
  }
  const wanted = new Map([...perVillage].flatMap(([did, ts]) => ts.map((t) => [key(t.x, t.y), did])));

  let lists = allLists.filter((l) => isInactiveList(l, cfg));
  const stale = lists.flatMap((l) => l.slots.filter((s) => wanted.get(key(s.target.x, s.target.y)) !== l.ownerVillage.id).map((s) => s.id));
  if (stale.length) {
    game.log(`Inactive players: removing ${stale.length} targets that are active again, excluded or out of reach.`);
    await game.deleteFarmListSlots(stale);
    lists = (await game.farmLists()).filter((l) => isInactiveList(l, cfg));
  }

  let added = 0;
  for (const [did, targets] of perVillage) {
    const v = byDid.get(did);
    const u = units.get(did);
    const troopsPerSlot = { [u.unit]: u.perSlot };
    const known = new Set(lists.filter((l) => l.ownerVillage.id === did).flatMap((l) => l.slots.map((s) => key(s.target.x, s.target.y))));
    let pending = targets.filter((t) => !known.has(key(t.x, t.y)));
    while (pending.length) {
      let list = lists.find((l) => l.ownerVillage.id === did && l.slots.length < cfg.inactive.listSize);
      if (!list) {
        const names = new Set(lists.filter((l) => l.ownerVillage.id === did).map((l) => l.name));
        let name = cfg.inactive.listPrefix;
        for (let n = 2; names.has(name); n++) name = `${cfg.inactive.listPrefix} ${n}`;
        const id = await game.createFarmList({ did, villageName: v.name, name, troops: troopsPerSlot });
        if (!id) break;
        lists = (await game.farmLists()).filter((l) => isInactiveList(l, cfg));
        list = lists.find((l) => l.id === id);
      }
      const batch = pending.slice(0, cfg.inactive.listSize - list.slots.length);
      pending = pending.slice(batch.length);
      game.log(`${v.name}: adding ${batch.length} inactive villages to "${list.name}", ${u.perSlot} ${u.unit} each.`);
      await game.addFarmListSlots(list.id, batch, troopsPerSlot);
      list.slots.push(...batch.map((t) => ({ target: t, troop: troopsPerSlot })));
      added += batch.length;
    }
  }
  return {
    ...found, added, removed: stale.length, targets: found.targets.slice(0, 300),
  };
}

// Raids every inactive target that has not been raided within cfg.inactive.everyMinutes, as far as
// the troops at home allow. Returns a summary per list.
export async function raidInactives(game, villages, cfg) {
  const lists = (await game.farmLists()).filter((l) => isInactiveList(l, cfg) && l.slots.length);
  if (!lists.length) return [];
  const now = Date.now();
  const stored = (await game.store?.get(RAID_STATE)) ?? {};
  const lastSent = Object.fromEntries(Object.entries(stored).filter(([, t]) => now - t < 7 * 86_400_000));
  const due = (cfg.inactive.everyMinutes - 5) * 60_000;
  const byDid = new Map(villages.map((v) => [v.did, v]));
  const homes = new Map();
  const summary = [];
  for (const list of lists) {
    const did = list.ownerVillage.id;
    const owner = byDid.get(did);
    if (!owner) continue;
    if (!homes.has(did)) homes.set(did, { ...(list.ownerVillage.troops?.ownTroopsAtTown?.units ?? {}) });
    const home = homes.get(did);
    const dist = (s) => Math.hypot(s.target.x - owner.x, s.target.y - owner.y);
    const send = [];
    let waiting = 0;
    for (const slot of list.slots.filter((s) => s.isActive && now - (lastSent[s.id] ?? 0) >= due).sort((a, b) => dist(a) - dist(b))) {
      if (!Object.entries(slot.troop).every(([u, n]) => (home[u] ?? 0) >= n)) {
        waiting++;
        continue;
      }
      for (const [u, n] of Object.entries(slot.troop)) home[u] -= n;
      send.push(slot);
    }
    const entry = {
      list: list.name, village: list.ownerVillage.name, targets: list.slots.length, running: list.slots.filter((s) => s.isRunning).length, sent: 0, waiting, unsafe: 0,
    };
    summary.push(entry);
    if (!send.length) continue;
    const results = await game.startFarmListTargets(list.id, send.map((s) => s.id));
    for (const r of results.filter((x) => !x.error)) lastSent[r.id] = now;
    entry.sent = results.filter((r) => !r.error).length;
    game.log(`${list.ownerVillage.name} "${list.name}": raided ${entry.sent} inactive villages${waiting ? `, ${waiting} waiting for troops` : ''}.`);
  }
  if (!game.dryRun) await game.store?.set(RAID_STATE, lastSent);
  return summary;
}
