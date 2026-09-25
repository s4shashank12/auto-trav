// The account owner's rules. Everything the bot builds or attacks goes through these checks.

// Villages at or above this population get no building or resource-field upgrades.
// Villages below it have their resource fields and IMPORTANT_BUILDINGS maxed.
export const POPULATION_LIMIT = 500;

export const canDevelop = (village) => village.population != null && village.population < POPULATION_LIMIT;

// Economy buildings the bot may upgrade or construct in small villages, in priority order, with
// what they need before they can be constructed. Anything not listed here (barracks, stable,
// workshop, academy, smithy, rally point, wall, hero's mansion, hospital, ...) is never touched.
export const IMPORTANT_BUILDINGS = [
  { gid: 15, name: 'Main Building', maxLevel: 20 },
  { gid: 10, name: 'Warehouse', maxLevel: 20, requires: { 15: 1 } },
  { gid: 11, name: 'Granary', maxLevel: 20, requires: { 15: 1 } },
  { gid: 17, name: 'Marketplace', maxLevel: 20, requires: { 15: 3, 10: 1, 11: 1 } },
  { gid: 5, name: 'Sawmill', maxLevel: 5, requires: { 15: 5, wood: 10 } },
  { gid: 6, name: 'Brickyard', maxLevel: 5, requires: { 15: 5, clay: 10 } },
  { gid: 7, name: 'Iron Foundry', maxLevel: 5, requires: { 15: 5, iron: 10 } },
  { gid: 8, name: 'Grain Mill', maxLevel: 5, requires: { 15: 5, crop: 5 } },
  { gid: 9, name: 'Bakery', maxLevel: 5, requires: { 15: 5, 8: 5, crop: 10 } },
];

// Only unoccupied oases with no animals in them may be raided. `tile` is an entry from the
// map API (/api/v1/map/position); unoccupied oases have title "{k.fo}" and no owner uid.
export function oasisAnimals(tile) {
  return [...(tile.text ?? '').matchAll(/unit u\d+"><\/i><span class="value ">(\d+)/g)]
    .reduce((sum, m) => sum + Number(m[1]), 0);
}

export function isRaidableOasis(tile) {
  return Boolean(tile) && tile.title === '{k.fo}' && tile.uid == null && oasisAnimals(tile) === 0;
}

// Farm lists the bot owns start with this name. Lists with any other name are never started or edited.
export const AUTO_FARM_LIST_PREFIX = 'Oases (auto)';
export const isAutoFarmList = (list) => list.name.startsWith(AUTO_FARM_LIST_PREFIX);
