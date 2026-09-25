import {
  AUTO_FARM_LIST_PREFIX, IMPORTANT_BUILDINGS, canDevelop, isAutoFarmList, isRaidableOasis, oasisAnimals,
} from './rules.js';
import { formatStatus } from './travian.js';

// Empty building slots the bot may construct on (39 is the rally point, 40 the wall).
const CONSTRUCTION_SLOTS = Array.from({ length: 20 }, (_, i) => 19 + i);
// Construction page tab holding each building: 1 infrastructure, 3 resources.
const CATEGORY = { 5: 3, 6: 3, 7: 3, 8: 3, 9: 3 };
const FIELD_KEYS = ['wood', 'clay', 'iron', 'crop'];

// Balanced growth: the lowest-level field first, breaking ties by the resource we hold least of.
// Cropland jumps the line when net crop production gets thin.
export function pickField(status) {
  const candidates = status.fields.filter((f) => !f.maxLevel && !f.underConstruction);
  if (!candidates.length) return null;
  const lowCrop = status.production?.crop != null && status.production.crop < 10;
  const affordable = candidates.filter((f) => f.canBuild);
  const pool = affordable.length ? affordable : candidates;
  const score = (f) => [lowCrop && f.type === 'crop' ? 0 : 1, f.level, status.stock?.[f.type] ?? 0];
  return [...pool].sort((a, b) => {
    const [sa, sb] = [score(a), score(b)];
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i];
    return a.id - b.id;
  })[0];
}

// Important buildings to work on next: the least developed relative to its max level first, with
// missing buildings counting as level 0 once their prerequisites are met.
export function pickBuildings(slots, fields) {
  const levelOf = (key) => (FIELD_KEYS.includes(key)
    ? Math.max(0, ...fields.filter((f) => f.type === key).map((f) => f.level))
    : Math.max(0, ...slots.filter((s) => s.gid === Number(key)).map((s) => s.level)));
  const emptySlot = slots.find((s) => s.gid === 0 && CONSTRUCTION_SLOTS.includes(s.id));
  const jobs = [];
  IMPORTANT_BUILDINGS.forEach((b, rank) => {
    const slot = slots.find((s) => s.gid === b.gid);
    if (!slot) {
      const ready = Object.entries(b.requires ?? {}).every(([key, level]) => levelOf(key) >= level);
      if (emptySlot && ready) jobs.push({ kind: 'construct', ...b, rank, slotId: emptySlot.id, progress: 0, canBuild: true });
    } else if (!slot.maxLevel && !slot.underConstruction && slot.level < b.maxLevel) {
      jobs.push({ kind: 'upgrade', ...b, rank, slotId: slot.id, progress: slot.level / b.maxLevel, canBuild: slot.canBuild });
    }
  });
  return jobs.sort((a, b) => (b.canBuild - a.canBuild) || (a.progress - b.progress) || (a.rank - b.rank));
}

// Each returns a description of the queued job, or null when nothing could be queued.
async function queueField(game, village, status) {
  const field = pickField(status);
  if (!field) return null;
  game.log(`${village.name}: ${field.type} field (slot ${field.id}) ${field.level} -> ${field.level + 1}`);
  if (await game.upgrade(field.id, village.did)) return { field };
  game.log(`${village.name}: not enough resources for that field yet.`);
  return null;
}

async function queueBuilding(game, village, status) {
  const queued = status.queue.map((q) => q.name ?? '');
  const jobs = pickBuildings(await game.buildings(), status.fields)
    .filter((job) => !queued.some((name) => name.startsWith(`${job.name} Level`)));
  for (const job of jobs.slice(0, 3)) {
    const done = job.kind === 'construct'
      ? await game.construct(job.slotId, job.gid, CATEGORY[job.gid] ?? 1, village.did)
      : await game.upgrade(job.slotId, village.did);
    if (done) {
      game.log(`${village.name}: ${job.kind} ${job.name} (slot ${job.slotId}).`);
      return { name: job.name };
    }
    game.log(`${village.name}: cannot ${job.kind} ${job.name} yet.`);
  }
  return null;
}

// Maxes resource fields and important buildings in a village under the population limit, filling
// the build queue up to `queueMax` jobs (3 for Romans with Travian Plus: one field and one building
// running, plus one in the waiting loop). Returns the village's queue afterwards.
export async function developVillage(game, village, { queueMax = 3 } = {}) {
  await game.switchVillage(village.did);
  let status = await game.status();
  game.log(formatStatus(status));
  if (status.did !== village.did) {
    game.log(`Skipping ${village.name}: another village is active.`);
    return [];
  }
  if (!canDevelop({ population: status.population })) {
    game.log(`Skipping ${village.name}: population ${status.population} is not under the limit.`);
    return status.queue;
  }

  // Romans build a field and a building side by side, so one type may hold at most queueMax - 1 jobs.
  const perType = status.roman ? queueMax - 1 : queueMax;
  const exhausted = new Set();
  for (let attempt = 0; attempt < queueMax + 2 && status.queue.length < queueMax; attempt++) {
    const fieldJobs = status.queue.filter((q) => q.isField).length;
    const buildingJobs = status.queue.length - fieldJobs;
    const canField = !exhausted.has('field') && fieldJobs < perType;
    const canBuilding = !exhausted.has('building') && buildingJobs < perType;
    if (!canField && !canBuilding) break;
    const kind = canField && (!canBuilding || fieldJobs <= buildingJobs) ? 'field' : 'building';
    const queued = kind === 'field' ? await queueField(game, village, status) : await queueBuilding(game, village, status);
    if (!queued) {
      exhausted.add(kind);
      continue;
    }
    if (game.dryRun) {
      // Nothing was clicked, so pretend the job went in rather than re-reading an unchanged queue.
      if (queued.field) queued.field.underConstruction = true;
      status.queue.push({ name: `${queued.name ?? queued.field.type} Level ?`, isField: kind === 'field', secondsLeft: null });
      continue;
    }
    const before = status.queue.length;
    status = await game.status();
    if (status.did !== village.did) break;
    if (status.queue.length <= before) exhausted.add(kind); // the game did not take the order
  }
  return status.queue;
}

// Raidable oases around every village, each assigned to the nearest village that can raid it.
export async function scanOases(game, raiders, radius) {
  const found = new Map();
  for (const v of raiders) {
    const tiles = await game.mapTiles(v.x, v.y);
    for (const tile of tiles.values()) {
      if (!isRaidableOasis(tile)) continue;
      const { x, y } = tile.position;
      const dist = Math.hypot(x - v.x, y - v.y);
      if (dist > radius) continue;
      const key = `${x}|${y}`;
      if (!found.has(key) || found.get(key).dist > dist) found.set(key, { x, y, dist, did: v.did });
    }
    await game.pause(400, 1000);
  }
  return [...found.values()].sort((a, b) => a.dist - b.dist);
}

// Distance bands, one farm list each, so near oases can be raided more often than far ones.
// Units are tried in order: fast light cavalry for near targets, heavy cavalry for far ones.
export const FARM_BANDS = [
  { suffix: 'near', maxDist: 10, units: ['t5', 't6'] },
  { suffix: 'far', maxDist: Infinity, units: ['t6', 't5'] },
];

// Splits a village's cavalry across its bands: each target gets up to `perSlot` units, at least 2.
export function planFarmLists(targets, troops, perSlot) {
  const budget = { ...troops };
  const plans = [];
  let minDist = 0;
  for (const band of FARM_BANDS) {
    const inBand = targets.filter((o) => o.dist >= minDist && o.dist < band.maxDist);
    minDist = band.maxDist;
    if (!inBand.length) continue;
    const unit = band.units.find((u) => (budget[u] ?? 0) >= inBand.length * 2);
    if (!unit) continue;
    const amount = Math.min(perSlot, Math.floor(budget[unit] / inBand.length));
    budget[unit] -= amount * inBand.length;
    plans.push({ name: `${AUTO_FARM_LIST_PREFIX} ${band.suffix}`, targets: inBand, troops: { [unit]: amount } });
  }
  return plans;
}

// Creates "Oases (auto) near/far" farm lists for each village with cavalry and fills them with the
// empty, unoccupied oases nearest to it. Safe to re-run: existing targets are not added twice.
export async function setupFarmLists(game, villages, { radius = 20, perSlot = 5 } = {}) {
  const raiders = [];
  for (const v of villages) {
    await game.switchVillage(v.did);
    const troops = await game.troopsAtHome();
    if ((troops.t5 ?? 0) + (troops.t6 ?? 0) > 0) raiders.push({ ...v, troops });
  }
  game.log(`Villages with cavalry: ${raiders.map((v) => `${v.name} (t5 ${v.troops.t5 ?? 0}, t6 ${v.troops.t6 ?? 0})`).join(', ') || 'none'}`);
  const oases = await scanOases(game, raiders, radius);
  game.log(`Found ${oases.length} empty unoccupied oases within ${radius} fields.`);
  let lists = await game.farmLists();

  for (const v of raiders) {
    const plans = planFarmLists(oases.filter((o) => o.did === v.did), v.troops, perSlot);
    for (const plan of plans) {
      let list = lists.find((l) => l.name === plan.name && l.ownerVillage.id === v.did);
      if (!list) {
        const id = await game.createFarmList({ did: v.did, villageName: v.name, name: plan.name, troops: plan.troops });
        if (!id) continue;
        lists = await game.farmLists();
        list = lists.find((l) => l.id === id);
      }
      await game.openFarmLists(v.did);
      const existing = new Set(list.slots.map((s) => `${s.target.x}|${s.target.y}`));
      const toAdd = plan.targets.filter((o) => !existing.has(`${o.x}|${o.y}`));
      const [unit, amount] = Object.entries(plan.troops)[0];
      game.log(`${v.name}: adding ${toAdd.length} oases to "${plan.name}" with ${amount}x ${unit} each.`);
      for (const o of toAdd) {
        await game.addFarmListTarget(list.id, o, plan.troops);
        game.log(`  + (${o.x}|${o.y}) ${o.dist.toFixed(1)} fields away`);
      }
    }
  }
}

// Map tiles fetched in 31x31 windows, reusing a window for every target it covers.
class TileCache {
  constructor(game) {
    this.game = game;
    this.windows = [];
  }

  async get(x, y) {
    let win = this.windows.find((w) => Math.abs(w.x - x) <= 14 && Math.abs(w.y - y) <= 14);
    if (!win) {
      win = { x, y, tiles: await this.game.mapTiles(x, y) };
      this.windows.push(win);
    }
    return win.tiles.get(`${x}|${y}`);
  }
}

function unsafeReason(tile) {
  if (!tile) return 'not on the map';
  if (tile.title !== '{k.fo}' || tile.uid != null) return 'no longer an unoccupied oasis';
  return `${oasisAnimals(tile)} animals`;
}

// Raids with the bot's own farm lists. Right before sending, every target is checked on the map
// again and only oases that are still unoccupied and animal-free are sent; slots with a raid
// already under way are left alone.
export async function runFarmLists(game) {
  const lists = (await game.farmLists()).filter(isAutoFarmList);
  if (!lists.length) {
    game.log('No "Oases (auto)" farm lists yet; run farm-setup first.');
    return;
  }
  const tiles = new TileCache(game);
  for (const list of lists) {
    await game.openFarmLists(list.ownerVillage.id);
    const running = await game.runningSlots(list.id);
    const safe = [];
    for (const slot of list.slots.filter((s) => s.isActive && !running.has(s.id))) {
      const tile = await tiles.get(slot.target.x, slot.target.y);
      if (isRaidableOasis(tile)) safe.push(slot);
      else game.log(`${list.ownerVillage.name} "${list.name}": skipping (${slot.target.x}|${slot.target.y}), ${unsafeReason(tile)}.`);
    }
    if (!safe.length) {
      game.log(`${list.ownerVillage.name} "${list.name}": nothing to send (${running.size} raids under way).`);
      continue;
    }
    const results = await game.startFarmListTargets(list.id, safe.map((s) => s.id));
    const failed = results.filter((r) => r.error);
    game.log(`${list.ownerVillage.name} "${list.name}": sent ${results.length - failed.length}/${safe.length}`
      + `${failed.length ? `, not sent: ${[...new Set(failed.map((r) => JSON.stringify(r.error)))].join(', ')}` : ''}`
      + ` (${running.size} already under way).`);
  }
}
