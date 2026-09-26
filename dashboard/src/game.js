// Game knowledge the dashboard needs so settings can be shown with names instead of the codes
// the bot stores (units t1..t10, building ids). Unit names depend on the tribe.

export const TRIBES = {
  1: 'Romans', 2: 'Teutons', 3: 'Gauls', 6: 'Egyptians', 7: 'Huns', 8: 'Spartans', 9: 'Vikings',
};

// Training buildings, as the bot's settings refer to them.
export const TRAINING_BUILDINGS = [
  { gid: 19, name: 'Barracks' },
  { gid: 20, name: 'Stable' },
  { gid: 21, name: 'Workshop' },
];
// The great versions train the same units.
const TRAINS_LIKE = { 29: 19, 30: 20 };

// [name, building it is trained in, kind] for t1..t10. Kind drives the icon.
const U = (name, gid, kind) => ({ name, gid, kind });
const SIEGE = (ram, cat) => [U(ram, 21, 'siege'), U(cat, 21, 'siege')];
const LEADERS = (chief) => [U(chief, 25, 'chief'), U('Settler', 25, 'settler')];
const UNITS = {
  1: [U('Legionnaire', 19, 'foot'), U('Praetorian', 19, 'foot'), U('Imperian', 19, 'foot'), U('Equites Legati', 20, 'horse'),
    U('Equites Imperatoris', 20, 'horse'), U('Equites Caesaris', 20, 'horse'), ...SIEGE('Battering Ram', 'Fire Catapult'), ...LEADERS('Senator')],
  2: [U('Clubswinger', 19, 'foot'), U('Spearman', 19, 'foot'), U('Axeman', 19, 'foot'), U('Scout', 19, 'foot'),
    U('Paladin', 20, 'horse'), U('Teutonic Knight', 20, 'horse'), ...SIEGE('Ram', 'Catapult'), ...LEADERS('Chief')],
  3: [U('Phalanx', 19, 'foot'), U('Swordsman', 19, 'foot'), U('Pathfinder', 20, 'horse'), U('Theutates Thunder', 20, 'horse'),
    U('Druidrider', 20, 'horse'), U('Haeduan', 20, 'horse'), ...SIEGE('Ram', 'Trebuchet'), ...LEADERS('Chieftain')],
  6: [U('Slave Militia', 19, 'foot'), U('Ash Warden', 19, 'foot'), U('Khopesh Warrior', 19, 'foot'), U('Sopdu Explorer', 20, 'horse'),
    U('Anhur Guard', 20, 'horse'), U('Resheph Chariot', 20, 'horse'), ...SIEGE('Ram', 'Stone Catapult'), ...LEADERS('Nomarch')],
  7: [U('Mercenary', 19, 'foot'), U('Bowman', 19, 'foot'), U('Spotter', 20, 'horse'), U('Steppe Rider', 20, 'horse'),
    U('Marksman', 20, 'horse'), U('Marauder', 20, 'horse'), ...SIEGE('Ram', 'Catapult'), ...LEADERS('Logades')],
  8: [U('Hoplite', 19, 'foot'), U('Sentinel', 19, 'foot'), U('Shieldsman', 19, 'foot'), U('Twinsteel Therion', 20, 'horse'),
    U('Elpida Rider', 20, 'horse'), U('Corinthian Crusher', 20, 'horse'), ...SIEGE('Ram', 'Ballista'), ...LEADERS('Ephor')],
  9: [U('Thrall', 19, 'foot'), U('Shield Maiden', 19, 'foot'), U('Berserker', 19, 'foot'), U("Heimdall's Eye", 20, 'horse'),
    U('Huskarl Rider', 20, 'horse'), U("Valkyrie's Blessing", 20, 'horse'), ...SIEGE('Ram', 'Catapult'), ...LEADERS('Jarl')],
};

const KIND_BY_INDEX = ['foot', 'foot', 'foot', 'horse', 'horse', 'horse', 'siege', 'siege', 'chief', 'settler'];
const GID_BY_INDEX = [19, 19, 19, 20, 20, 20, 21, 21, 25, 25];

// All ten units of a tribe as { code, name, gid, kind }. Unknown tribe: "Unit 1".. with the
// usual building layout, and any troop building accepts any of them.
export function tribeUnits(tribe) {
  const list = UNITS[tribe];
  return Array.from({ length: 10 }, (_, i) => ({
    code: `t${i + 1}`,
    name: list?.[i]?.name ?? `Unit ${i + 1}`,
    gid: list?.[i]?.gid ?? GID_BY_INDEX[i],
    kind: list?.[i]?.kind ?? KIND_BY_INDEX[i],
    known: Boolean(list),
  }));
}

export const unitName = (tribe, code) => tribeUnits(tribe).find((u) => u.code === code)?.name ?? code;

// Units a training building can train.
export function unitsFor(tribe, gid) {
  const building = TRAINS_LIKE[gid] ?? gid;
  return tribeUnits(tribe).filter((u) => u.gid === building);
}

// Units that can be researched in the Academy (the first unit and settlers never need it).
export const researchable = (tribe) => tribeUnits(tribe).filter((u) => /^t[2-9]$/.test(u.code));

// Units the Smithy can improve: everything but chiefs and settlers.
export const improvable = (tribe) => tribeUnits(tribe).filter((u) => /^t[1-8]$/.test(u.code));

// Buildings a village can develop, with their in-game maximum level and prerequisites
// (building id -> level, or a resource field type -> level).
export const BUILDINGS = [
  { gid: 15, name: 'Main Building', group: 'Infrastructure', max: 20 },
  { gid: 10, name: 'Warehouse', group: 'Infrastructure', max: 20, requires: { 15: 1 } },
  { gid: 11, name: 'Granary', group: 'Infrastructure', max: 20, requires: { 15: 1 } },
  { gid: 17, name: 'Marketplace', group: 'Infrastructure', max: 20, requires: { 10: 1, 11: 1, 15: 3 } },
  { gid: 23, name: 'Cranny', group: 'Infrastructure', max: 10 },
  { gid: 18, name: 'Embassy', group: 'Infrastructure', max: 20, requires: { 15: 1 } },
  { gid: 25, name: 'Residence', group: 'Infrastructure', max: 20, requires: { 15: 5 } },
  { gid: 26, name: 'Palace', group: 'Infrastructure', max: 20, requires: { 15: 5, 18: 1 } },
  { gid: 24, name: 'Town Hall', group: 'Infrastructure', max: 20, requires: { 15: 10, 22: 10 } },
  { gid: 27, name: 'Treasury', group: 'Infrastructure', max: 20, requires: { 15: 10 } },
  { gid: 28, name: 'Trade Office', group: 'Infrastructure', max: 20, requires: { 17: 20, 20: 10 } },
  { gid: 38, name: 'Great Warehouse', group: 'Infrastructure', max: 20, requires: { 15: 10 } },
  { gid: 39, name: 'Great Granary', group: 'Infrastructure', max: 20, requires: { 15: 10 } },
  { gid: 5, name: 'Sawmill', group: 'Production', max: 5, requires: { 15: 5, wood: 10 } },
  { gid: 6, name: 'Brickyard', group: 'Production', max: 5, requires: { 15: 5, clay: 10 } },
  { gid: 7, name: 'Iron Foundry', group: 'Production', max: 5, requires: { 15: 5, iron: 10 } },
  { gid: 8, name: 'Grain Mill', group: 'Production', max: 5, requires: { 15: 5, crop: 5 } },
  { gid: 9, name: 'Bakery', group: 'Production', max: 5, requires: { 8: 5, 15: 5, crop: 10 } },
  { gid: 16, name: 'Rally Point', group: 'Military', max: 20 },
  { gid: 19, name: 'Barracks', group: 'Military', max: 20, requires: { 15: 3, 16: 1 } },
  { gid: 22, name: 'Academy', group: 'Military', max: 20, requires: { 15: 3, 19: 3 } },
  { gid: 13, name: 'Smithy', group: 'Military', max: 20, requires: { 15: 3, 22: 1 } },
  { gid: 20, name: 'Stable', group: 'Military', max: 20, requires: { 13: 3, 22: 5 } },
  { gid: 21, name: 'Workshop', group: 'Military', max: 20, requires: { 15: 5, 22: 10 } },
  { gid: 14, name: 'Tournament Square', group: 'Military', max: 20, requires: { 16: 15 } },
  { gid: 37, name: "Hero's Mansion", group: 'Military', max: 20, requires: { 15: 3, 16: 1 } },
];

const FIELD_NAMES = {
  wood: 'Woodcutters', clay: 'Clay pits', iron: 'Iron mines', crop: 'Croplands',
};

export const buildingName = (gid) => BUILDINGS.find((b) => b.gid === Number(gid))?.name
  ?? TRAINING_BUILDINGS.find((b) => b.gid === Number(gid))?.name ?? `Building ${gid}`;

export const requirementName = (key) => FIELD_NAMES[key] ?? buildingName(key);

// Problems with a build list: prerequisites that the list never reaches. Villages that already
// have the building are fine, so these are hints, not errors.
export function planWarnings(plan) {
  const byGid = new Map(plan.map((b) => [b.gid, b]));
  const out = new Map();
  for (const b of plan) {
    const notes = [];
    for (const [key, level] of Object.entries(b.requires ?? {})) {
      if (FIELD_NAMES[key]) continue; // fields are always developed
      const need = byGid.get(Number(key));
      if (!need) notes.push(`${buildingName(key)} ${level} is not in the list`);
      else if (need.maxLevel < level) notes.push(`needs ${need.name} ${level}, but the list stops at ${need.maxLevel}`);
    }
    if (notes.length) out.set(b.gid, notes);
  }
  return out;
}
