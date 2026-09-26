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

// Units the bot farms with, slowest first: slow infantry takes the nearest oases and fast
// cavalry the far ones ("rainbow" farming). Praetorians and scouts never farm.
// `perSlot` is the troops per raid. Even an oasis without animals has a base defence (combat
// strength 10), and a raid of one unit loses it a few percent of the time (a Legionnaire about
// 10%); with 5-10 units the expected loss is close to zero and a raid also beats a few animals
// that respawned while it was on its way. `planUnits` is how many units farm-setup budgets per
// target. `short` names new farm lists, which the game caps at 30 characters.
export const RAID_UNITS = {
  t1: { name: 'Legionnaires', short: 'Legionnaires', perSlot: 10, planUnits: 10 },
  t3: { name: 'Imperians', short: 'Imperians', perSlot: 10, planUnits: 10 },
  t6: { name: 'Equites Caesaris', short: 'EC', perSlot: 5, planUnits: 5 },
  t5: { name: 'Equites Imperatoris', short: 'EI', perSlot: 5, planUnits: 5 },
};
export const FARM_LIST_SIZE = 100;

// Defensive units trained to keep military buildings busy, by building gid: Praetorians in the
// barracks, Equites Caesaris in the stable. Workshops (rams, catapults) are left alone.
export const DEFENSIVE_UNITS = { 19: 't2', 20: 't6' };

// Per-village exceptions to DEFENSIVE_UNITS, by village name: Chingdi's barracks trains Imperians.
export const TRAIN_OVERRIDES = { Chingdi: { 19: 't3' } };
export const trainingUnit = (village, gid) => TRAIN_OVERRIDES[village.name]?.[gid] ?? DEFENSIVE_UNITS[gid];

// Villages whose net crop drops under CROP_LOW stop training and send defensive troops to the
// capital as reinforcements until they are back to CROP_TARGET. The capital only takes them while
// its own net crop stays above CAPITAL_CROP_MIN.
export const REINFORCE_TARGET = 'Chingdi';
export const CROP_LOW = 200;
export const CROP_TARGET = 600;
export const CAPITAL_CROP_MIN = 2000;
