// Smithy upgrades: each village improves the units it wants, one upgrade at a time, lowest level
// first, up to smithy.maxLevel (the game also caps a unit at the Smithy's own level). A village is
// looked at again when its running upgrade ends, hourly while it waits for resources, and every
// few hours once everything it wants is at the cap.
import { canDevelop, trainingBuildings, trainingUnit } from './rules.js';

const STATE = 'smithy';
const HOUR = 3_600_000;

// Units village `village` should improve: its own list (or the default list), plus the units it
// is set to train when smithy.fromTraining is on (only big villages train). Chiefs and settlers
// have no Smithy upgrades.
export function wantedUpgrades(village, cfg) {
  const { fromTraining, units, overrides } = cfg.smithy;
  const wanted = new Set(overrides[village.name] ?? units);
  if (fromTraining && !canDevelop(village, cfg)) {
    for (const gid of trainingBuildings(village, cfg)) {
      const unit = trainingUnit(village, gid, cfg);
      if (unit) wanted.add(unit);
    }
  }
  return [...wanted].filter((u) => /^t[1-8]$/.test(u));
}

// What a village's Smithy should do next: the wanted units still below the cap, and of those the
// lowest one that can be improved right now (ties in list order).
export function planUpgrade(smithy, want, maxLevel) {
  const cap = Math.min(maxLevel, smithy.level);
  const pending = smithy.units.filter((u) => want.includes(u.unit) && u.level < cap);
  const next = smithy.busy ? null : pending
    .filter((u) => u.link)
    .sort((a, b) => a.level - b.level || want.indexOf(a.unit) - want.indexOf(b.unit))[0] ?? null;
  return { cap, pending, next };
}

// When to look at a village's Smithy again, after this visit.
export function recheckAt(now, { smithy, plan, started }) {
  if (!smithy) return now + 6 * HOUR; // no Smithy
  if (!plan.pending.length) return now + 6 * HOUR; // everything wanted is at the cap
  if (started) return now; // the next one can be planned as soon as this one runs
  if (smithy.busy) return now + Math.max(60, smithy.runningSeconds ?? 1800) * 1000;
  return now + HOUR; // waiting for resources
}

// Starts the next Smithy upgrade in every village that wants one. With `force` every Smithy is
// looked at now, whatever the recheck times say. Returns a summary per village that has work.
export async function improveUnits(game, villages, cfg, { force = false } = {}) {
  const state = (await game.store?.get(STATE)) ?? {};
  const next = state.next ?? {};
  const now = Date.now();
  const summary = [];
  for (const village of villages) {
    const want = wantedUpgrades(village, cfg);
    if (!want.length) continue;
    const entry = { village: village.name };
    if (!force && next[village.did] > now) {
      summary.push({ ...(state.last?.[village.name] ?? entry), nextCheckAt: new Date(next[village.did]).toISOString() });
      continue;
    }
    const smithy = await game.smithy(village.did);
    if (!smithy) {
      next[village.did] = recheckAt(now, { smithy });
      summary.push({ ...entry, note: 'no Smithy', nextCheckAt: new Date(next[village.did]).toISOString() });
      continue;
    }
    const plan = planUpgrade(smithy, want, cfg.smithy.maxLevel);
    Object.assign(entry, {
      smithyLevel: smithy.level,
      cap: plan.cap,
      levels: Object.fromEntries(smithy.units.filter((u) => want.includes(u.unit)).map((u) => [u.unit, u.level])),
      running: smithy.running?.[0] ?? null,
    });
    let started = false;
    if (plan.next) {
      started = await game.improve(village.did, plan.next.unit, plan.next.link);
      if (started) {
        entry.started = `${plan.next.name ?? plan.next.unit} to level ${plan.next.level + 1}`;
        game.log(`${village.name}: Smithy improving ${entry.started}.`);
      } else {
        entry.note = `${plan.next.name ?? plan.next.unit} could not be started`;
      }
    }
    entry.waiting = plan.pending.filter((u) => u !== plan.next).map((u) => ({
      unit: u.unit,
      name: u.name,
      reason: smithy.busy || started ? 'after the current upgrade' : u.link ? 'queued' : (u.note ?? 'not enough resources'),
    }));
    const missing = want.filter((u) => !smithy.units.some((x) => x.unit === u));
    for (const unit of missing) entry.waiting.push({ unit, reason: 'not researched yet' });
    next[village.did] = recheckAt(now, { smithy, plan, started });
    entry.nextCheckAt = new Date(next[village.did]).toISOString();
    summary.push(entry);
  }
  const last = Object.fromEntries(summary.map((e) => [e.village, e]));
  if (!game.dryRun) await game.store?.set(STATE, { next, last });
  return summary;
}
