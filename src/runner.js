import { runFarmLists, setupFarmLists } from './farming.js';
import { trainTroops } from './military.js';
import { canDevelop } from './rules.js';
import { developVillage } from './strategy.js';

const minutesSince = (t) => (Date.now() - t) / 60_000;

// Plays one account: a round builds in the small villages, trains when due and sends a raid wave
// when due. Keeps the timers between rounds and a snapshot of what it last saw for the dashboard.
export class Runner {
  constructor(game, cfg) {
    this.game = game;
    this.cfg = cfg;
    this.lastRaid = 0;
    this.lastTrain = 0;
    this.snapshot = {};
  }

  async villages() {
    const villages = await this.game.villages();
    this.snapshot.villages = villages.map((v) => ({ ...v, develop: canDevelop(v, this.cfg) }));
    return villages;
  }

  // Develops every small village. Returns seconds until the first queued job finishes, or null.
  async build(villages) {
    let soonest = null;
    const queues = {};
    for (const v of villages.filter((x) => canDevelop(x, this.cfg))) {
      const queue = await developVillage(this.game, v, this.cfg, villages);
      queues[v.name] = queue.map((q) => ({ name: q.name, minutes: q.secondsLeft != null ? Math.ceil(q.secondsLeft / 60) : null }));
      for (const q of queue) {
        if (q.secondsLeft != null && (soonest == null || q.secondsLeft < soonest)) soonest = q.secondsLeft;
      }
    }
    this.snapshot.queues = queues;
    return soonest;
  }

  async train(villages) {
    this.lastTrain = Date.now();
    this.snapshot.training = await trainTroops(this.game, villages, this.cfg);
  }

  async raid(villages) {
    this.lastRaid = Date.now();
    this.snapshot.raids = await runFarmLists(this.game, this.cfg, villages);
    this.snapshot.lastWaveAt = new Date(this.lastRaid).toISOString();
  }

  async farmSetup(villages) {
    return setupFarmLists(this.game, villages, this.cfg);
  }

  // One round of play. Returns seconds until the next build job finishes, when known.
  async round() {
    const { game, cfg } = this;
    await game.login();
    const villages = await this.villages();
    const soonest = cfg.features.build ? await this.build(villages) : null;
    if (cfg.features.train && minutesSince(this.lastTrain) >= cfg.train.everyMinutes) await this.train(villages);
    if (cfg.features.raid && minutesSince(this.lastRaid) >= cfg.raid.everyMinutes - 0.5) await this.raid(villages);
    this.snapshot.updatedAt = new Date().toISOString();
    return soonest;
  }

  // Runs a single step by name (for the CLI and the dashboard's buttons).
  async action(name) {
    await this.game.login();
    const villages = await this.villages();
    let result = null;
    if (name === 'build') await this.build(villages);
    else if (name === 'train') await this.train(villages);
    else if (name === 'raid') await this.raid(villages);
    else if (name === 'farm-setup') result = await this.farmSetup(villages);
    else if (name !== 'villages') throw new Error(`Unknown action "${name}"`);
    this.snapshot.updatedAt = new Date().toISOString();
    return result;
  }

  // Minutes to wait after a round: until the first build job finishes (so its slot does not sit
  // idle) or the next raid wave is due, else a random idle wait.
  sleepMinutes(soonest) {
    const { minMinutes, maxMinutes, floorMinutes } = this.cfg.loop;
    let minutes = minMinutes + Math.random() * (maxMinutes - minMinutes);
    if (soonest != null) minutes = Math.max(floorMinutes, Math.min(minutes, soonest / 60 + 0.5 + Math.random() * 1.5));
    if (this.cfg.features.raid) {
      minutes = Math.min(minutes, Math.max(1, this.cfg.raid.everyMinutes - minutesSince(this.lastRaid)));
    }
    return minutes;
  }
}
