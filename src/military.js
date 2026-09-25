import fs from 'node:fs/promises';
import {
  CAPITAL_CROP_MIN, CROP_LOW, CROP_TARGET, DEFENSIVE_UNITS, REINFORCE_TARGET, canDevelop,
} from './rules.js';

const RESOURCES = ['wood', 'clay', 'iron', 'crop'];
const REINFORCE_STATE = '.auth/reinforcements.json';
const BUILDING_NAMES = { 19: 'Barracks', 20: 'Stable' };
const UNIT_NAMES = { t2: 'Praetorians', t6: 'Equites Caesaris' };

async function readState() {
  return JSON.parse(await fs.readFile(REINFORCE_STATE, 'utf8').catch(() => '{}'));
}

async function writeState(state) {
  await fs.mkdir('.auth', { recursive: true });
  await fs.writeFile(REINFORCE_STATE, JSON.stringify(state));
}

// How many units to add so the queue lasts `targetMinutes`, limited by resources above `reserve`,
// the game's own maximum and the crop the village can spare above CROP_LOW.
export function trainAmount(info, { aheadMinutes, targetMinutes, reserve }) {
  if (info.queueSeconds >= aheadMinutes * 60 || !info.unitSeconds) return 0;
  const wanted = Math.ceil((targetMinutes * 60 - info.queueSeconds) / info.unitSeconds);
  const affordable = Math.min(...RESOURCES.map((r) => (info.cost[r] ? Math.floor((info.stock[r] - reserve) / info.cost[r]) : Infinity)));
  const cropRoom = Math.floor((info.production.crop - CROP_LOW) / Math.max(1, info.upkeep));
  return Math.max(0, Math.min(wanted, affordable, info.max, cropRoom));
}

// Sends defensive troops from a village short on crop to the capital, so their upkeep moves there.
// Sends only what brings the village back to CROP_TARGET, only while the capital keeps
// CAPITAL_CROP_MIN, and not again until the previous reinforcement has arrived.
async function relieveCrop(game, village, capital, crop, capitalCrop) {
  const state = await readState();
  if ((state[village.did] ?? 0) > Date.now()) {
    game.log(`${village.name}: crop ${crop}/h, reinforcement to ${capital.name} still on its way.`);
    return capitalCrop;
  }
  const home = (await game.villageTroops()).get(village.did) ?? {};
  let need = CROP_TARGET - crop;
  const troops = {};
  for (const [unit, upkeep] of [['t2', 1], ['t6', 4]]) {
    const n = Math.min(home[unit] ?? 0, Math.ceil(need / upkeep));
    if (n > 0) {
      troops[unit] = n;
      need -= n * upkeep;
    }
    if (need <= 0) break;
  }
  const upkeep = (troops.t2 ?? 0) + (troops.t6 ?? 0) * 4;
  if (!upkeep) {
    game.log(`${village.name}: crop ${crop}/h and no defensive troops at home to move.`);
    return capitalCrop;
  }
  if (capitalCrop - upkeep < CAPITAL_CROP_MIN) {
    game.log(`${village.name}: crop ${crop}/h, but ${capital.name} (${capitalCrop}/h) cannot feed ${upkeep} more upkeep.`);
    return capitalCrop;
  }
  game.log(`${village.name}: crop ${crop}/h, sending ${Object.entries(troops).map(([u, n]) => `${n} ${UNIT_NAMES[u]}`).join(', ')} to reinforce ${capital.name}.`);
  const arrival = await game.sendReinforcement(village.did, capital, troops);
  if (!game.dryRun) await writeState({ ...state, [village.did]: arrival });
  return capitalCrop - upkeep;
}

// Keeps barracks and stables in the big villages training defensive units. Small villages keep
// their resources for building. Villages low on crop reinforce the capital instead of training.
export async function trainDefense(game, villages, {
  aheadMinutes = 60, targetMinutes = 180, reserve = 5_000,
} = {}) {
  const capital = villages.find((v) => v.name === REINFORCE_TARGET);
  let capitalCrop = null;
  for (const village of villages.filter((v) => !canDevelop(v))) {
    for (const [gid, unit] of Object.entries(DEFENSIVE_UNITS).map(([g, u]) => [Number(g), u])) {
      const info = await game.trainingInfo(village.did, gid, unit);
      if (!info) continue;
      const crop = info.production.crop;
      if (crop < CROP_LOW) {
        if (capital && village.did !== capital.did) {
          if (capitalCrop == null) capitalCrop = (await game.trainingInfo(capital.did, 19, 't2'))?.production.crop ?? 0;
          capitalCrop = await relieveCrop(game, village, capital, crop, capitalCrop);
        } else {
          game.log(`${village.name}: crop ${crop}/h is too low to train.`);
        }
        break;
      }
      const amount = trainAmount(info, { aheadMinutes, targetMinutes, reserve });
      const queued = Math.round(info.queueSeconds / 60);
      if (!amount) {
        if (info.queueSeconds < aheadMinutes * 60) game.log(`${village.name} ${BUILDING_NAMES[gid]}: ${queued} min queued, not enough resources to add ${UNIT_NAMES[unit]}.`);
        continue;
      }
      game.log(`${village.name} ${BUILDING_NAMES[gid]}: ${queued} min queued, training ${amount} ${UNIT_NAMES[unit]}.`);
      await game.train(village.did, unit, amount);
    }
  }
}
