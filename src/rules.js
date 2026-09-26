// Rules every action goes through. The numbers come from the server's config (src/config.js).

// Villages at or above the population limit get no building or resource-field upgrades.
export const canDevelop = (village, cfg) => village.population != null && village.population < cfg.build.populationLimit;

// Only unoccupied oases with no animals in them may be raided. `tile` is an entry from the
// map API (/api/v1/map/position); unoccupied oases have title "{k.fo}" and no owner uid.
export function oasisAnimals(tile) {
  return [...(tile.text ?? '').matchAll(/unit u\d+"><\/i><span class="value ">(\d+)/g)]
    .reduce((sum, m) => sum + Number(m[1]), 0);
}

export function isRaidableOasis(tile) {
  return Boolean(tile) && tile.title === '{k.fo}' && tile.uid == null && oasisAnimals(tile) === 0;
}

// Farm lists the bot owns start with the configured prefix. Others are never started or edited.
export const isAutoFarmList = (list, cfg) => list.name.startsWith(cfg.raid.listPrefix);

// Unit a village trains in building `gid`: its override if it has one, else the default.
// "none" (in either) means the building trains nothing.
export function trainingUnit(village, gid, cfg) {
  const unit = cfg.train.overrides[village.name]?.[gid] ?? cfg.train.units[gid];
  return unit && unit !== 'none' ? unit : null;
}

// Buildings (gids) a village may train in: the defaults plus any its overrides add.
export const trainingBuildings = (village, cfg) => [...new Set([
  ...Object.keys(cfg.train.units),
  ...Object.keys(cfg.train.overrides[village.name] ?? {}),
])].map(Number);

// Village that takes reinforcements: the configured one, else the capital.
export const reinforceTarget = (villages, cfg) => (cfg.reinforce.target
  ? villages.find((v) => v.name === cfg.reinforce.target)
  : villages.find((v) => v.capital));
