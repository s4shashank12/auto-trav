import {
  canDevelop, reinforceTarget, trainingBuildings, trainingUnit,
} from './rules.js';

const RESOURCES = ['wood', 'clay', 'iron', 'crop'];
const REINFORCE_STATE = 'reinforcements';
const BUILDING_NAMES = {
  19: 'Barracks', 20: 'Stable', 21: 'Workshop', 29: 'Great Barracks', 30: 'Great Stable',
};

// How many units to add so the queue lasts `targetMinutes`, limited by resources above `reserve`,
// the game's own maximum and the crop the village can spare above `cropLow`.
export function trainAmount(info, {
  aheadMinutes, targetMinutes, reserve, cropLow,
}) {
  if (info.queueSeconds >= aheadMinutes * 60 || !info.unitSeconds) return 0;
  const wanted = Math.ceil((targetMinutes * 60 - info.queueSeconds) / info.unitSeconds);
  const affordable = Math.min(...RESOURCES.map((r) => (info.cost[r] ? Math.floor((info.stock[r] - reserve) / info.cost[r]) : Infinity)));
  const cropRoom = Math.floor((info.production.crop - cropLow) / Math.max(1, info.upkeep));
  return Math.max(0, Math.min(wanted, affordable, info.max, cropRoom));
}

// Sends troops from a village short on crop to the reinforcement target, so their upkeep moves
// there. Sends only what brings the village back to `cropTarget`, only while the target keeps
// `targetCropMin`, and not again until the previous reinforcement has arrived.
async function relieveCrop(game, village, target, crop, targetCrop, cfg) {
  const { cropTarget, targetCropMin, units } = cfg.reinforce;
  const state = (await game.store?.get(REINFORCE_STATE)) ?? {};
  if ((state[village.did] ?? 0) > Date.now()) {
    game.log(`${village.name}: crop ${crop}/h, reinforcement to ${target.name} still on its way.`);
    return targetCrop;
  }
  const home = (await game.villageTroops()).get(village.did) ?? {};
  let need = cropTarget - crop;
  const troops = {};
  let upkeep = 0;
  for (const u of units) {
    const n = Math.min(home[u.unit] ?? 0, Math.ceil(need / u.upkeep));
    if (n > 0) {
      troops[u.unit] = n;
      need -= n * u.upkeep;
      upkeep += n * u.upkeep;
    }
    if (need <= 0) break;
  }
  if (!upkeep) {
    game.log(`${village.name}: crop ${crop}/h and no troops at home to move.`);
    return targetCrop;
  }
  if (targetCrop - upkeep < targetCropMin) {
    game.log(`${village.name}: crop ${crop}/h, but ${target.name} (${targetCrop}/h) cannot feed ${upkeep} more upkeep.`);
    return targetCrop;
  }
  game.log(`${village.name}: crop ${crop}/h, sending ${Object.entries(troops).map(([u, n]) => `${n} ${u}`).join(', ')} to reinforce ${target.name}.`);
  const arrival = await game.sendReinforcement(village.did, target, troops);
  if (!game.dryRun) await game.store?.set(REINFORCE_STATE, { ...state, [village.did]: arrival });
  return targetCrop - upkeep;
}

// Keeps the configured military buildings in the big villages training (per-village overrides
// apply). Small villages keep their resources for building. Villages low on crop reinforce the
// target village instead of training. Returns a summary per building.
export async function trainTroops(game, villages, cfg) {
  const {
    aheadMinutes, targetMinutes, reserve,
  } = cfg.train;
  const { cropLow } = cfg.reinforce;
  const target = reinforceTarget(villages, cfg);
  let targetCrop = null;
  const summary = [];
  for (const village of villages.filter((v) => !canDevelop(v, cfg))) {
    for (const gid of trainingBuildings(village, cfg)) {
      const unit = trainingUnit(village, gid, cfg);
      if (!unit) continue;
      const info = await game.trainingInfo(village.did, gid, unit);
      if (!info) continue;
      const building = BUILDING_NAMES[gid] ?? `Building ${gid}`;
      const crop = info.production.crop;
      if (crop < cropLow) {
        summary.push({ village: village.name, building, unit: info.name ?? unit, queuedMinutes: Math.round(info.queueSeconds / 60), trained: 0, note: 'low crop' });
        if (cfg.features.reinforce && target && village.did !== target.did) {
          if (targetCrop == null) targetCrop = await game.netCrop(target.did);
          targetCrop = await relieveCrop(game, village, target, crop, targetCrop, cfg);
        } else {
          game.log(`${village.name}: crop ${crop}/h is too low to train.`);
        }
        break;
      }
      const amount = trainAmount(info, {
        aheadMinutes, targetMinutes, reserve, cropLow,
      });
      const queued = Math.round(info.queueSeconds / 60);
      const unitName = info.name ?? unit;
      summary.push({ village: village.name, building, unit: unitName, queuedMinutes: queued, trained: amount });
      if (!amount) {
        if (info.queueSeconds < aheadMinutes * 60) game.log(`${village.name} ${building}: ${queued} min queued, not enough resources to add ${unitName}.`);
        continue;
      }
      game.log(`${village.name} ${building}: ${queued} min queued, training ${amount} ${unitName}.`);
      await game.train(village.did, unit, amount);
    }
  }
  return summary;
}
