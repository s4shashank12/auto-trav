// The hero's own outings: an adventure whenever one is open, else the unoccupied oasis with the
// most animals within heroRaid.radius that the hero can beat without losing more than
// heroRaid.maxLoss health. It only leaves from its home village with at least
// heroRaid.minHealth health, and never when it is dead, regenerating or already out.
import { TileCache } from './farming.js';

// Nature's units (u31-u40): defence against infantry and cavalry, and upkeep (the hero's
// experience for killing one).
export const ANIMALS = {
  31: { name: 'Rat', inf: 25, cav: 20, upkeep: 1 },
  32: { name: 'Spider', inf: 35, cav: 40, upkeep: 1 },
  33: { name: 'Snake', inf: 40, cav: 60, upkeep: 1 },
  34: { name: 'Bat', inf: 66, cav: 50, upkeep: 1 },
  35: { name: 'Wild Boar', inf: 70, cav: 33, upkeep: 2 },
  36: { name: 'Wolf', inf: 80, cav: 70, upkeep: 2 },
  37: { name: 'Bear', inf: 140, cav: 200, upkeep: 3 },
  38: { name: 'Crocodile', inf: 380, cav: 240, upkeep: 3 },
  39: { name: 'Tiger', inf: 170, cav: 250, upkeep: 3 },
  40: { name: 'Elephant', inf: 440, cav: 520, upkeep: 5 },
};

// The animals in a map tile's text, as [{ id, name, count }].
export function tileAnimals(tile) {
  return [...(tile?.text ?? '').matchAll(/unit u(\d+)"><\/i><span class="value ">(\d+)/g)]
    .map((m) => ({ id: Number(m[1]), name: ANIMALS[m[1]]?.name ?? `u${m[1]}`, count: Number(m[2]) }))
    .filter((a) => a.count > 0);
}

// Estimated health the hero loses raiding `animals` (percent, 100 = it would die), from the
// game's battle formula for a raid: with x = (defence / attack)^1.5 the winner loses x / (1 + x)
// of its strength. (The game turns any attack on an unoccupied oasis into a raid.) A mounted hero
// meets the animals' cavalry defence. Armour and other bonuses are left out, so the estimate errs
// on the safe side.
export function estimateLoss(animals, { power, mounted }) {
  if (!power) return 100;
  const defence = animals.reduce((n, a) => n + a.count * ((mounted ? ANIMALS[a.id]?.cav : ANIMALS[a.id]?.inf) ?? 1000), 0);
  if (!defence) return 0;
  if (defence >= power) return 100;
  const x = (defence / power) ** 1.5;
  return Math.ceil((100 * x) / (1 + x));
}

// The oasis to clear: most animals first, then most experience, then nearest.
export function pickOasis(tiles, from, hero, cfg) {
  const { radius, maxLoss } = cfg.heroRaid;
  return tiles
    .filter((t) => t.title === '{k.fo}' && t.uid == null)
    .map((t) => {
      const animals = tileAnimals(t);
      return {
        x: t.position.x,
        y: t.position.y,
        dist: Math.hypot(t.position.x - from.x, t.position.y - from.y),
        animals,
        count: animals.reduce((n, a) => n + a.count, 0),
        experience: animals.reduce((n, a) => n + a.count * (ANIMALS[a.id]?.upkeep ?? 0), 0),
        loss: estimateLoss(animals, hero),
      };
    })
    .filter((o) => o.count > 0 && o.dist <= radius && o.loss <= maxLoss && o.loss < hero.health)
    .sort((a, b) => b.count - a.count || b.experience - a.experience || a.dist - b.dist)[0] ?? null;
}

// The adventure to go on: normal ones before hard ones, nearest first.
export function pickAdventure(adventures) {
  return [...(adventures ?? [])].sort((a, b) => (a.difficulty ?? 0) - (b.difficulty ?? 0) || (a.travelingDuration ?? a.distance ?? 0) - (b.travelingDuration ?? b.distance ?? 0))[0] ?? null;
}

// Why the hero stays home, or null if it may leave.
export function staysHome(status, cfg) {
  if (!status.isAlive) return 'the hero is dead';
  if (!status.home) return status.away ? `the hero is away (${status.away})` : 'the hero is not in its home village';
  if (status.health < cfg.heroRaid.minHealth) return `health ${status.health}% is under ${cfg.heroRaid.minHealth}%`;
  return null;
}

const describe = (animals) => animals.map((a) => `${a.count} ${a.name}`).join(', ');

const STATE = 'hero';
const QUIET_MS = 30 * 60_000;

// One decision for the hero: an adventure, an oasis, or staying home (with the reason). After a
// look at the map finds no oasis it can clear, the map is left alone for half an hour (unless
// `force`), so rounds do not keep scanning it.
export async function sendHero(game, cfg, { force = false } = {}) {
  const status = await game.heroStatus();
  const summary = {
    health: status.health, home: status.homeVillage?.name ?? null, adventures: status.adventures.length, at: new Date().toISOString(),
  };
  const reason = staysHome(status, cfg);
  if (reason) return { ...summary, note: reason };
  const adventure = cfg.heroRaid.adventures ? pickAdventure(status.adventures) : null;
  if (adventure) {
    const sent = await game.startAdventure(adventure.number);
    game.log(`Hero: off on an adventure at (${adventure.x}|${adventure.y})${sent?.arrivalIn ? `, arriving in ${sent.arrivalIn}` : ''}.`);
    return { ...summary, action: { type: 'adventure', x: adventure.x, y: adventure.y, difficulty: adventure.difficulty } };
  }
  if (!cfg.heroRaid.oases) return { ...summary, note: 'no adventure open' };
  const state = (await game.store?.get(STATE)) ?? {};
  if (!force && state.quietUntil > Date.now()) return { ...summary, note: state.note, nextLookAt: new Date(state.quietUntil).toISOString() };
  const hero = { ...(await game.heroPower()), health: status.health };
  const from = status.homeVillage;
  const tiles = await new TileCache(game).area(from.x, from.y, cfg.heroRaid.radius);
  const oasis = pickOasis(tiles, from, hero, cfg);
  if (!oasis) {
    const note = `no oasis within ${cfg.heroRaid.radius} fields the hero can clear losing at most ${cfg.heroRaid.maxLoss}% health`;
    await game.store?.set(STATE, { quietUntil: Date.now() + QUIET_MS, note });
    return { ...summary, note, nextLookAt: new Date(Date.now() + QUIET_MS).toISOString() };
  }
  await game.sendHeroTo(from.id, oasis);
  game.log(`Hero: raiding the oasis at (${oasis.x}|${oasis.y}), ${oasis.dist.toFixed(1)} fields away: ${describe(oasis.animals)} (about ${oasis.loss}% health).`);
  return {
    ...summary,
    action: {
      type: 'oasis', x: oasis.x, y: oasis.y, animals: describe(oasis.animals), loss: oasis.loss,
    },
  };
}
