import { canDevelop } from './rules.js';
import { formatStatus } from './travian.js';

// Empty building slots the bot may construct on (39 is the rally point, 40 the wall).
const CONSTRUCTION_SLOTS = Array.from({ length: 20 }, (_, i) => 19 + i);
// Buildings that have a slot of their own.
const FIXED_SLOT = { 16: 39 };
// Construction page tab listing each building: 1 infrastructure (the default), 2 military,
// 3 resources; 0 for the rally point, whose slot offers nothing else.
const CATEGORY = {
  5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 13: 2, 14: 2, 16: 0, 19: 2, 20: 2, 21: 2, 22: 2, 29: 2, 30: 2, 46: 2,
};
const FIELD_KEYS = ['wood', 'clay', 'iron', 'crop'];

// Balanced growth: the lowest-level field first, breaking ties by the resource we hold least of.
// Cropland jumps the line while net crop production is under `cropFirstBelow`.
export function pickField(status, cropFirstBelow = 10) {
  const candidates = status.fields.filter((f) => !f.maxLevel && !f.underConstruction);
  if (!candidates.length) return null;
  const lowCrop = status.production?.crop != null && status.production.crop < cropFirstBelow;
  const affordable = candidates.filter((f) => f.canBuild);
  const pool = affordable.length ? affordable : candidates;
  const score = (f) => [lowCrop && f.type === 'crop' ? 0 : 1, f.level, status.stock?.[f.type] ?? 0];
  return [...pool].sort((a, b) => {
    const [sa, sb] = [score(a), score(b)];
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i];
    return a.id - b.id;
  })[0];
}

// Buildings (from the configured list) to work on next: the least developed relative to its max
// level first, with missing buildings counting as level 0 once their prerequisites are met.
export function pickBuildings(slots, fields, buildings) {
  const levelOf = (key) => (FIELD_KEYS.includes(key)
    ? Math.max(0, ...fields.filter((f) => f.type === key).map((f) => f.level))
    : Math.max(0, ...slots.filter((s) => s.gid === Number(key)).map((s) => s.level)));
  const emptySlot = (gid) => (FIXED_SLOT[gid]
    ? slots.find((s) => s.id === FIXED_SLOT[gid] && s.gid === 0)
    : slots.find((s) => s.gid === 0 && CONSTRUCTION_SLOTS.includes(s.id)));
  const jobs = [];
  buildings.forEach((b, rank) => {
    const slot = slots.find((s) => s.gid === b.gid);
    if (!slot) {
      const ready = Object.entries(b.requires ?? {}).every(([key, level]) => levelOf(key) >= level);
      const target = emptySlot(b.gid);
      if (target && ready) jobs.push({ kind: 'construct', ...b, rank, slotId: target.id, progress: 0, canBuild: true });
    } else if (!slot.maxLevel && !slot.underConstruction && slot.level < b.maxLevel) {
      jobs.push({ kind: 'upgrade', ...b, rank, slotId: slot.id, progress: slot.level / b.maxLevel, canBuild: slot.canBuild });
    }
  });
  return jobs.sort((a, b) => (b.canBuild - a.canBuild) || (a.progress - b.progress) || (a.rank - b.rank));
}

const RESOURCES = ['wood', 'clay', 'iron', 'crop'];

// Tops up a small village from the nearest big village with a surplus, so its build queue does
// not wait on resources. Triggers when any resource is under `low` of storage and fills towards
// `fill` (at most `fillMax`), counting merchants already on the way. Sources keep `reserve` of
// each resource; this runs before troop training, so small villages come first.
export async function supplyVillage(game, village, status, villages, cfg) {
  const {
    low, fill, fillMax, reserve, minShipment,
  } = cfg.supply;
  const cap = status.maxStorage;
  if (!RESOURCES.some((r) => status.stock[r] < low * cap[r])) return false;
  const economy = await game.economy();
  const incoming = Object.fromEntries(RESOURCES.map((r) => [r, 0]));
  for (const v of economy) {
    for (const move of v.outgoing.filter((m) => m.to === village.did)) {
      for (const r of RESOURCES) incoming[r] += move.resources[r];
    }
  }
  const want = Object.fromEntries(RESOURCES.map((r) => [r,
    Math.max(0, Math.floor(Math.min(fill * cap[r], fillMax) - status.stock[r] - incoming[r]))]));
  if (RESOURCES.every((r) => status.stock[r] + incoming[r] >= low * cap[r])) return false;

  const dist = (v) => Math.hypot(v.x - village.x, v.y - village.y);
  const sources = villages.filter((v) => !canDevelop(v, cfg)).sort((a, b) => dist(a) - dist(b));
  for (const source of sources) {
    const eco = economy.find((e) => e.did === source.did);
    if (!eco?.merchants.available) continue;
    const send = Object.fromEntries(RESOURCES.map((r) => [r, Math.max(0, Math.min(want[r], eco.stock[r] - reserve))]));
    const total = RESOURCES.reduce((sum, r) => sum + send[r], 0);
    if (total < minShipment) continue;
    const room = eco.merchants.available * eco.merchants.capacity;
    if (total > room) for (const r of RESOURCES) send[r] = Math.floor((send[r] * room) / total);
    game.log(`${village.name}: shipping ${RESOURCES.map((r) => `${send[r]} ${r}`).join(', ')} from ${source.name}.`);
    await game.switchVillage(source.did);
    const sent = await game.sendResources(source.did, village, send);
    await game.switchVillage(village.did);
    return sent;
  }
  game.log(`${village.name}: low on resources, but no big village has a surplus and free merchants.`);
  return false;
}

// Each returns a description of the queued job, or null when nothing could be queued.
async function queueField(game, village, status, cfg) {
  const field = pickField(status, cfg.build.cropFirstBelow);
  if (!field) return null;
  game.log(`${village.name}: ${field.type} field (slot ${field.id}) ${field.level} -> ${field.level + 1}`);
  if (await game.upgrade(field.id, village.did, { hero: cfg.features.hero })) return { field };
  game.log(`${village.name}: not enough resources for that field yet.`);
  return null;
}

async function queueBuilding(game, village, status, cfg) {
  const queued = status.queue.map((q) => q.name ?? '');
  const jobs = pickBuildings(await game.buildings(), status.fields, cfg.build.buildings)
    .filter((job) => !queued.some((name) => name.startsWith(`${job.name} Level`)));
  for (const job of jobs.slice(0, 3)) {
    const done = job.kind === 'construct'
      ? await game.construct(job.slotId, job.gid, CATEGORY[job.gid] ?? 1, village.did, { hero: cfg.features.hero })
      : await game.upgrade(job.slotId, village.did, { hero: cfg.features.hero });
    if (done) {
      game.log(`${village.name}: ${job.kind} ${job.name} (slot ${job.slotId}).`);
      return { name: job.name };
    }
    game.log(`${village.name}: cannot ${job.kind} ${job.name} yet.`);
  }
  return null;
}

// Maxes resource fields and the configured buildings in a village under the population limit,
// filling the build queue up to `queueMax` jobs (3 for Romans with Travian Plus: one field and one
// building running, plus one in the waiting loop). Returns the village's queue afterwards.
export async function developVillage(game, village, cfg, villages = []) {
  const { queueMax } = cfg.build;
  await game.switchVillage(village.did);
  let status = await game.status();
  game.log(formatStatus(status));
  if (status.did !== village.did) {
    game.log(`Skipping ${village.name}: another village is active.`);
    return [];
  }
  if (!canDevelop({ population: status.population }, cfg)) {
    game.log(`Skipping ${village.name}: population ${status.population} is not under the limit.`);
    return status.queue;
  }

  if (cfg.features.supply && villages.length) await supplyVillage(game, village, status, villages, cfg);

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
    const queued = kind === 'field' ? await queueField(game, village, status, cfg) : await queueBuilding(game, village, status, cfg);
    if (!queued) {
      exhausted.add(kind);
      continue;
    }
    if (game.dryRun) {
      // Nothing was clicked, so pretend the job went in rather than re-reading an unchanged queue.
      if (queued.field) queued.field.underConstruction = true;
      const name = queued.name ? `${queued.name} Level ? (dry run)` : `${queued.field.type} field (dry run)`;
      status.queue.push({ name, isField: kind === 'field', secondsLeft: null });
      continue;
    }
    const before = status.queue.length;
    status = await game.status();
    if (status.did !== village.did) break;
    if (status.queue.length <= before) exhausted.add(kind); // the game did not take the order
  }
  return status.queue;
}
