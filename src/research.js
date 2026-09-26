// Academy research: each village researches the units it needs, one at a time, as soon as the
// Academy allows it. Villages remember what is done, so their Academy is only visited while
// something is still missing.
import { canDevelop, trainingBuildings, trainingUnit } from './rules.js';

const STATE = 'research';
const NO_ACADEMY_RECHECK = 6 * 3_600_000;

// Units village `village` should have: its own list (or the default list), plus the units it is
// set to train when research.fromTraining is on (only big villages train). Legionnaire-type
// first units and settlers need no research.
export function wantedResearch(village, cfg) {
  const { fromTraining, units, overrides } = cfg.research;
  const wanted = new Set(overrides[village.name] ?? units);
  if (fromTraining && !canDevelop(village, cfg)) {
    for (const gid of trainingBuildings(village, cfg)) {
      const unit = trainingUnit(village, gid, cfg);
      if (unit) wanted.add(unit);
    }
  }
  return [...wanted].filter((u) => /^t[2-9]$/.test(u));
}

// A unit that shows up in a village's training form is researched there (even if the village
// has no Academy any more). Training calls this so research never waits for those.
export async function noteResearched(game, did, unit) {
  const state = (await game.store?.get(STATE)) ?? {};
  const done = state.done ?? {};
  if (done[did]?.includes(unit)) return;
  done[did] = [...(done[did] ?? []), unit];
  await game.store?.set(STATE, { ...state, done });
}

// Researches what each village still lacks. Returns a summary per village that had work.
export async function researchUnits(game, villages, cfg) {
  const state = (await game.store?.get(STATE)) ?? {};
  const done = state.done ?? {};
  const noAcademy = state.noAcademy ?? {};
  const summary = [];
  for (const village of villages) {
    const want = wantedResearch(village, cfg).filter((u) => !done[village.did]?.includes(u));
    if (!want.length) continue;
    const entry = {
      village: village.name, researched: [], started: null, waiting: [],
    };
    summary.push(entry);
    // A village without an Academy is looked at again every few hours, not every round.
    const recent = Date.now() - (noAcademy[village.did] ?? 0) < NO_ACADEMY_RECHECK;
    const academy = recent ? null : await game.academy(village.did);
    if (!academy) {
      if (!recent) noAcademy[village.did] = Date.now();
      entry.waiting = want.map((unit) => ({ unit, reason: 'no Academy' }));
      continue;
    }
    delete noAcademy[village.did];
    const listed = new Map(academy.units.map((u) => [u.unit, u]));
    // Not listed any more: researched (or being researched right now).
    entry.researched = want.filter((u) => !listed.has(u));
    done[village.did] = [...new Set([...(done[village.did] ?? []), ...entry.researched])];
    const pending = want.filter((u) => listed.has(u)).map((u) => listed.get(u));
    for (const u of pending.filter((x) => !x.ready)) {
      entry.waiting.push({ unit: u.unit, name: u.name, reason: `needs ${u.missing.join(', ') || 'more buildings'}` });
    }
    const next = academy.busy ? null : pending.find((u) => u.ready && u.canResearch);
    if (next && (await game.research(village.did, next.unit))) {
      entry.started = next.name ?? next.unit;
      game.log(`${village.name}: researching ${entry.started}.`);
    } else if (academy.busy) {
      entry.note = 'a research is running';
    }
    for (const u of pending.filter((x) => x.ready && x !== next)) {
      entry.waiting.push({ unit: u.unit, name: u.name, reason: academy.busy || next ? 'after the current research' : 'not enough resources' });
    }
  }
  if (!game.dryRun) await game.store?.set(STATE, { done, noAcademy });
  return summary;
}
