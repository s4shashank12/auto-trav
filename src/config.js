// Every setting the bot uses, with defaults. A server (Travian account) stores only its
// overrides; resolveConfig() deep-merges them over these defaults. Arrays are replaced, not merged.

export const DEFAULT_CONFIG = {
  // Log what would be done without clicking anything.
  dryRun: false,

  features: {
    build: true, // develop small villages
    supply: true, // ship resources from big villages to small ones
    hero: true, // cover build shortfalls from the hero's inventory
    train: true, // keep barracks and stables training
    reinforce: true, // move troops to the reinforcement target when crop runs low
    raid: true, // send farm list waves
    research: true, // research units in the Academy (see research below)
    smithy: true, // improve units in the Smithy (see smithy below)
    heroRaid: false, // send the hero on adventures, else to clear oases of animals (see heroRaid below)
  },

  build: {
    // Villages at or above this population get no building or resource-field upgrades.
    populationLimit: 500,
    // Jobs kept in each small village's queue (3 for Romans with Travian Plus, 2 without).
    queueMax: 3,
    // Cropland goes first while net crop production is under this (per hour).
    cropFirstBelow: 10,
    // Buildings the bot may upgrade or construct in small villages, in priority order, with what
    // they need before they can be constructed (building gids or resource field types).
    // Anything not listed is never touched.
    buildings: [
      { gid: 15, name: 'Main Building', maxLevel: 20 },
      { gid: 10, name: 'Warehouse', maxLevel: 20, requires: { 15: 1 } },
      { gid: 11, name: 'Granary', maxLevel: 20, requires: { 15: 1 } },
      { gid: 17, name: 'Marketplace', maxLevel: 20, requires: { 15: 3, 10: 1, 11: 1 } },
      { gid: 5, name: 'Sawmill', maxLevel: 5, requires: { 15: 5, wood: 10 } },
      { gid: 6, name: 'Brickyard', maxLevel: 5, requires: { 15: 5, clay: 10 } },
      { gid: 7, name: 'Iron Foundry', maxLevel: 5, requires: { 15: 5, iron: 10 } },
      { gid: 8, name: 'Grain Mill', maxLevel: 5, requires: { 15: 5, crop: 5 } },
      { gid: 9, name: 'Bakery', maxLevel: 5, requires: { 15: 5, 8: 5, crop: 10 } },
    ],
  },

  supply: {
    low: 0.3, // ship when a small village has less than this share of storage in any resource
    fill: 0.7, // fill towards this share of storage
    fillMax: 15000, // but never more than this per resource
    reserve: 5000, // big villages keep this much of each resource
    minShipment: 500, // skip shipments smaller than this
  },

  train: {
    everyMinutes: 30,
    aheadMinutes: 60, // top a queue up when less than this is left
    targetMinutes: 180, // ... to this much
    reserve: 5000, // resources of each kind kept back
    units: { 19: 't2', 20: 't6' }, // unit per building gid (19 barracks, 20 stable); "none" = idle
    overrides: {}, // per village name, e.g. { "Chingdi": { "19": "t3" } }; may add buildings (21 workshop)
  },

  // Academy research, checked with training. A village researches its list (its override, else
  // the default list) plus, with fromTraining, the units it is set to train. One at a time.
  research: {
    fromTraining: true,
    units: [], // e.g. ["t3", "t6"]
    overrides: {}, // per village name: a list that replaces the default one
  },

  // Smithy upgrades, checked with training. A village improves its list (its override, else the
  // default list) plus, with fromTraining, the units it is set to train: one upgrade at a time,
  // lowest level first, up to maxLevel (and never above the Smithy's own level).
  smithy: {
    fromTraining: true,
    units: [], // e.g. ["t3", "t6"]
    overrides: {}, // per village name: a list that replaces the default one
    maxLevel: 20,
  },

  // The hero's own outings, checked every round while it is home: an adventure whenever one is
  // open (normal before hard, nearest first), otherwise a raid on the unoccupied oasis with the
  // most animals within `radius` fields of its home village that it can clear losing at most
  // `maxLoss` health (estimated from its fighting strength and the animals' defence). The game
  // only allows raids on unoccupied oases.
  heroRaid: {
    adventures: true, // adventures come first
    oases: true, // then oases with animals
    radius: 15, // fields from the hero's home village
    minHealth: 50, // the hero only leaves with at least this much health (%)
    maxLoss: 25, // skip oases that would cost it more health than this (%)
  },

  reinforce: {
    target: '', // village that takes the troops; empty means the capital
    cropLow: 200, // a village under this net crop/h stops training and reinforces
    cropTarget: 600, // ... until it is back to this
    targetCropMin: 2000, // the target village keeps at least this net crop/h
    units: [{ unit: 't2', upkeep: 1 }, { unit: 't6', upkeep: 4 }], // sent in this order
  },

  raid: {
    everyMinutes: 10, // one wave this often
    cycleMinutes: 10, // a target is not raided twice within this many minutes
    radius: 45, // farm-setup: oases this many fields from the village at most
    listPrefix: 'Oases (auto)', // farm lists the bot owns; others are never touched
    listSize: 100,
    // Raiding units, slowest first: slow units take the nearest oases, fast ones the far ones.
    // perSlot is the troops per raid; planUnits what farm-setup budgets per target.
    units: [
      { unit: 't1', name: 'Legionnaires', short: 'Legionnaires', perSlot: 10, planUnits: 10 },
      { unit: 't3', name: 'Imperians', short: 'Imperians', perSlot: 10, planUnits: 10 },
      { unit: 't6', name: 'Equites Caesaris', short: 'EC', perSlot: 5, planUnits: 5 },
      { unit: 't5', name: 'Equites Imperatoris', short: 'EI', perSlot: 5, planUnits: 5 },
    ],
  },

  // Raiding inactive players (off by default). A player is inactive when their total population
  // has not grown for `days` days, judged from the game world's daily map.sql.
  inactive: {
    enabled: false,
    days: 3,
    radius: 25, // fields from one of our villages
    minPop: 1, // village population range to raid
    maxPop: 800,
    excludeOwnAlliance: true,
    excludeAlliances: [], // alliance tags, e.g. ["NAP1", "WING"]
    excludePlayers: [], // player names
    excludeTribes: [4, 5], // 4 nature, 5 Natars
    villages: [], // names of our villages that raid them; empty means any with the units
    units: [ // preference order: each raiding village uses the first it has enough of
      { unit: 't5', perSlot: 10 },
      { unit: 't6', perSlot: 10 },
      { unit: 't3', perSlot: 20 },
      { unit: 't1', perSlot: 20 },
    ],
    maxTargets: 100, // per raiding village
    listPrefix: 'Inactives (auto)',
    listSize: 100,
    everyMinutes: 60, // one raid on every target this often
    hours: '', // only raid in these hours, e.g. "6-23" (empty means any time)
    timezone: 'UTC', // for hours, e.g. "Asia/Dhaka"
    keepDays: 14, // world snapshots kept
  },

  loop: {
    minMinutes: 20, // idle wait between rounds when nothing else is due
    maxMinutes: 40,
    floorMinutes: 4, // never wake for a build job sooner than this
  },
};

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export function mergeConfig(base, overrides) {
  if (!isPlainObject(overrides)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeConfig(out[key], value) : structuredClone(value);
  }
  return out;
}

export const resolveConfig = (overrides) => mergeConfig(DEFAULT_CONFIG, overrides);

// Settings shown as form fields in the dashboard; anything else is edited as JSON.
export const CONFIG_FIELDS = [
  { section: 'General', path: 'dryRun', type: 'boolean', label: 'Dry run', help: 'Log actions without clicking.' },
  { section: 'General', path: 'features.build', type: 'boolean', label: 'Build in small villages' },
  { section: 'General', path: 'features.supply', type: 'boolean', label: 'Ship resources to small villages' },
  { section: 'General', path: 'features.hero', type: 'boolean', label: 'Use hero resources for builds' },
  { section: 'General', path: 'features.train', type: 'boolean', label: 'Train troops' },
  { section: 'General', path: 'features.reinforce', type: 'boolean', label: 'Reinforce when crop is low' },
  { section: 'General', path: 'features.raid', type: 'boolean', label: 'Raid oases' },
  { section: 'General', path: 'features.research', type: 'boolean', label: 'Research units in the Academy' },
  { section: 'General', path: 'features.smithy', type: 'boolean', label: 'Improve units in the Smithy' },
  { section: 'General', path: 'features.heroRaid', type: 'boolean', label: 'Send the hero on adventures and oasis raids' },
  { section: 'Building', path: 'build.populationLimit', type: 'number', label: 'Population limit', help: 'Villages at or above this are not built in.' },
  { section: 'Building', path: 'build.queueMax', type: 'number', label: 'Queue length', help: '3 for Romans with Plus, 2 without.' },
  { section: 'Building', path: 'build.cropFirstBelow', type: 'number', label: 'Cropland first below (crop/h)' },
  { section: 'Building', path: 'build.buildings', type: 'json', label: 'Buildings to develop' },
  { section: 'Supply', path: 'supply.low', type: 'number', step: 0.05, label: 'Ship below (share of storage)' },
  { section: 'Supply', path: 'supply.fill', type: 'number', step: 0.05, label: 'Fill to (share of storage)' },
  { section: 'Supply', path: 'supply.fillMax', type: 'number', label: 'Fill at most (per resource)' },
  { section: 'Supply', path: 'supply.reserve', type: 'number', label: 'Source reserve (per resource)' },
  { section: 'Supply', path: 'supply.minShipment', type: 'number', label: 'Smallest shipment' },
  { section: 'Training', path: 'train.everyMinutes', type: 'number', label: 'Check every (minutes)' },
  { section: 'Training', path: 'train.aheadMinutes', type: 'number', label: 'Top up below (minutes queued)' },
  { section: 'Training', path: 'train.targetMinutes', type: 'number', label: 'Top up to (minutes queued)' },
  { section: 'Training', path: 'train.reserve', type: 'number', label: 'Resource reserve' },
  { section: 'Training', path: 'train.units', type: 'json', label: 'Unit per building', help: '{ "19": "t2", "20": "t6" }' },
  { section: 'Training', path: 'train.overrides', type: 'json', label: 'Per-village overrides', help: '{ "Village": { "19": "t3" } }' },
  { section: 'Research', path: 'research.fromTraining', type: 'boolean', label: 'Research what a village trains' },
  { section: 'Research', path: 'research.units', type: 'json', label: 'Units to research', help: '["t3", "t6"]' },
  { section: 'Research', path: 'research.overrides', type: 'json', label: 'Per-village research', help: '{ "Village": ["t3"] }' },
  { section: 'Smithy', path: 'smithy.fromTraining', type: 'boolean', label: 'Improve what a village trains' },
  { section: 'Smithy', path: 'smithy.units', type: 'json', label: 'Units to improve', help: '["t3", "t6"]' },
  { section: 'Smithy', path: 'smithy.overrides', type: 'json', label: 'Per-village upgrades', help: '{ "Village": ["t3"] }' },
  { section: 'Smithy', path: 'smithy.maxLevel', type: 'number', label: 'Improve up to level' },
  { section: 'Hero', path: 'heroRaid.adventures', type: 'boolean', label: 'Go on adventures first' },
  { section: 'Hero', path: 'heroRaid.oases', type: 'boolean', label: 'Otherwise clear oases of animals' },
  { section: 'Hero', path: 'heroRaid.radius', type: 'number', label: 'Oases within (fields)' },
  { section: 'Hero', path: 'heroRaid.minHealth', type: 'number', label: 'Leave with at least (% health)' },
  { section: 'Hero', path: 'heroRaid.maxLoss', type: 'number', label: 'Lose at most (% health per oasis)' },
  { section: 'Reinforcement', path: 'reinforce.target', type: 'string', label: 'Target village', help: 'Empty means the capital.' },
  { section: 'Reinforcement', path: 'reinforce.cropLow', type: 'number', label: 'Reinforce below (crop/h)' },
  { section: 'Reinforcement', path: 'reinforce.cropTarget', type: 'number', label: 'Until back to (crop/h)' },
  { section: 'Reinforcement', path: 'reinforce.targetCropMin', type: 'number', label: 'Target keeps at least (crop/h)' },
  { section: 'Reinforcement', path: 'reinforce.units', type: 'json', label: 'Units to send' },
  { section: 'Raiding', path: 'raid.everyMinutes', type: 'number', label: 'Wave every (minutes)' },
  { section: 'Raiding', path: 'raid.cycleMinutes', type: 'number', label: 'Same target at most every (minutes)' },
  { section: 'Raiding', path: 'raid.radius', type: 'number', label: 'Farm-setup radius (fields)' },
  { section: 'Raiding', path: 'raid.listPrefix', type: 'string', label: 'Bot farm list name prefix' },
  { section: 'Raiding', path: 'raid.listSize', type: 'number', label: 'Targets per list' },
  { section: 'Raiding', path: 'raid.units', type: 'json', label: 'Raiding units (slowest first)' },
  { section: 'Inactive players', path: 'inactive.enabled', type: 'boolean', label: 'Raid inactive players', help: 'Off by default.' },
  { section: 'Inactive players', path: 'inactive.days', type: 'number', label: 'No growth for (days)' },
  { section: 'Inactive players', path: 'inactive.radius', type: 'number', label: 'Within (fields)' },
  { section: 'Inactive players', path: 'inactive.minPop', type: 'number', label: 'Village population from' },
  { section: 'Inactive players', path: 'inactive.maxPop', type: 'number', label: 'Village population to' },
  { section: 'Inactive players', path: 'inactive.everyMinutes', type: 'number', label: 'Raid each target every (minutes)' },
  { section: 'Inactive players', path: 'inactive.hours', type: 'string', label: 'Only in hours', help: 'e.g. 6-23; empty means any time.' },
  { section: 'Inactive players', path: 'inactive.timezone', type: 'string', label: 'Timezone for hours', help: 'e.g. UTC or Asia/Dhaka' },
  { section: 'Inactive players', path: 'inactive.maxTargets', type: 'number', label: 'Targets per village' },
  { section: 'Inactive players', path: 'inactive.excludeOwnAlliance', type: 'boolean', label: 'Skip own alliance' },
  { section: 'Inactive players', path: 'inactive.excludeAlliances', type: 'json', label: 'Skip alliances', help: '["TAG1", "TAG2"]' },
  { section: 'Inactive players', path: 'inactive.excludePlayers', type: 'json', label: 'Skip players', help: '["name"]' },
  { section: 'Inactive players', path: 'inactive.excludeTribes', type: 'json', label: 'Skip tribes', help: '4 nature, 5 Natars' },
  { section: 'Inactive players', path: 'inactive.villages', type: 'json', label: 'Raid from villages', help: 'Names; empty means any with the units.' },
  { section: 'Inactive players', path: 'inactive.units', type: 'json', label: 'Units per raid (preference order)' },
  { section: 'Inactive players', path: 'inactive.listPrefix', type: 'string', label: 'Farm list name prefix' },
  { section: 'Loop', path: 'loop.minMinutes', type: 'number', label: 'Idle wait from (minutes)' },
  { section: 'Loop', path: 'loop.maxMinutes', type: 'number', label: 'Idle wait to (minutes)' },
  { section: 'Loop', path: 'loop.floorMinutes', type: 'number', label: 'Shortest wait (minutes)' },
];

// Config for the single-account CLI: the defaults, then bot.config.json if present, then the
// environment variables the CLI has always accepted.
export function configFromEnv(env, fileOverrides = {}) {
  const num = (v) => (v == null || v === '' ? undefined : Number(v));
  const fromEnv = {
    dryRun: /^(1|true|yes)$/i.test(env.DRY_RUN ?? '') || undefined,
    build: { queueMax: num(env.BUILD_QUEUE_MAX) },
    train: { everyMinutes: num(env.TRAIN_EVERY_MINUTES) },
    raid: {
      everyMinutes: num(env.RAID_EVERY_MINUTES),
      cycleMinutes: num(env.RAID_CYCLE_MINUTES) ?? num(env.RAID_EVERY_MINUTES),
      radius: num(env.RAID_RADIUS),
    },
    loop: {
      minMinutes: num(env.LOOP_MIN_MINUTES), maxMinutes: num(env.LOOP_MAX_MINUTES), floorMinutes: num(env.LOOP_FLOOR_MINUTES),
    },
  };
  return mergeConfig(resolveConfig(fileOverrides), JSON.parse(JSON.stringify(fromEnv)));
}
