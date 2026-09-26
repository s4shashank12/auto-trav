import { runFarmLists, setupFarmLists } from './farming.js';
import { sendHero } from './hero.js';
import {
  importWorld, inRaidHours, raidInactives, syncInactiveLists,
} from './inactive.js';
import { trainTroops } from './military.js';
import { researchUnits } from './research.js';
import { improveUnits } from './smithy.js';
import { canDevelop, isAutoFarmList } from './rules.js';
import { developVillage } from './strategy.js';
import { CaptchaError } from './travian.js';
import { findInactives } from './world.js';

const minutesSince = (t) => (Date.now() - t) / 60_000;

// Plays one account: a round builds in the small villages, trains when due and sends a raid wave
// when due. Keeps the timers between rounds and a snapshot of what it last saw for the dashboard.
export class Runner {
  // `world` stores the daily world snapshots used to find inactive players (optional).
  constructor(game, cfg, { world = null } = {}) {
    this.game = game;
    this.cfg = cfg;
    this.worldStore = world;
    this.lastRaid = 0;
    this.lastTrain = 0;
    this.lastInactiveRaid = 0;
    this.snapshot = {};
  }

  async villages() {
    const villages = await this.game.villages();
    this.snapshot.villages = villages.map((v) => ({ ...v, develop: canDevelop(v, this.cfg) }));
    // The dashboard names units by tribe.
    if (this.snapshot.tribe == null) this.snapshot.tribe = await this.game.tribe().catch(() => null);
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
    // Research first: a unit has to be researched before it can be trained.
    if (this.cfg.features.research) await this.research(villages);
    // Then Smithy upgrades, so they are paid for before training uses the resources.
    if (this.cfg.features.smithy) await this.smithy(villages);
    this.snapshot.training = await trainTroops(this.game, villages, this.cfg);
  }

  // With `force` every Smithy is looked at now (the dashboard's button), not only the due ones.
  async smithy(villages, { force = false } = {}) {
    this.snapshot.smithy = await improveUnits(this.game, villages, this.cfg, { force });
    this.snapshot.smithyAt = new Date().toISOString();
  }

  async research(villages) {
    this.snapshot.research = await researchUnits(this.game, villages, this.cfg);
    this.snapshot.researchAt = new Date().toISOString();
  }

  async raid(villages) {
    this.lastRaid = Date.now();
    this.snapshot.raids = await runFarmLists(this.game, this.cfg, villages);
    this.snapshot.lastWaveAt = new Date(this.lastRaid).toISOString();
  }

  async farmSetup(villages, { rebuild = false } = {}) {
    const result = await setupFarmLists(this.game, villages, this.cfg, { rebuild });
    const lists = (await this.game.farmLists()).filter((l) => isAutoFarmList(l, this.cfg));
    this.snapshot.farmSetup = {
      ...result,
      rebuild,
      at: new Date().toISOString(),
      lists: lists.map((l) => ({ village: l.ownerVillage.name, list: l.name, targets: l.slots.length })),
    };
    return result;
  }

  // Sends the hero out if it is home and fit: an adventure first, else an oasis with animals.
  async hero({ force = false } = {}) {
    this.snapshot.hero = await sendHero(this.game, this.cfg, { force });
  }

  // Imports today's world data (once a day unless forced) and, when inactive raiding is on,
  // brings the inactive farm lists up to date.
  async updateWorld(villages, { force = false } = {}) {
    if (!this.worldStore) throw new Error('No world data store configured');
    const day = await importWorld(this.game, this.worldStore, this.cfg, { force });
    if (!day && !force) return null;
    const result = this.cfg.inactive.enabled
      ? await syncInactiveLists(this.game, villages, this.worldStore, this.cfg)
      : { ...(await findInactives(this.worldStore, villages, this.cfg)), added: 0, removed: 0 };
    this.snapshot.inactives = {
      ready: result.ready, latest: result.latest, base: result.base, days: result.days, needDays: result.needDays,
      count: result.targets.length, added: result.added, removed: result.removed, updatedAt: new Date().toISOString(),
    };
    return result;
  }

  async raidInactives(villages) {
    this.lastInactiveRaid = Date.now();
    this.snapshot.inactiveRaids = await raidInactives(this.game, villages, this.cfg);
    this.snapshot.lastInactiveRaidAt = new Date(this.lastInactiveRaid).toISOString();
  }

  // One round of play. Returns seconds until the next build job finishes, when known.
  async round() {
    const { game, cfg } = this;
    await game.login();
    const villages = await this.villages();
    const soonest = cfg.features.build ? await this.build(villages) : null;
    if (cfg.features.train && minutesSince(this.lastTrain) >= cfg.train.everyMinutes) await this.train(villages);
    if (this.worldStore) {
      // World data is collected every day so inactive players can be found as soon as raiding them
      // is switched on; lists and raids only happen when it is.
      await this.updateWorld(villages).catch((err) => game.log(`World data import failed: ${err.message}`));
      if (cfg.inactive.enabled && minutesSince(this.lastInactiveRaid) >= 9.5 && inRaidHours(cfg)) await this.raidInactives(villages);
    }
    if (cfg.features.heroRaid) {
      // A failed hero outing should not cost the rest of the round (a CAPTCHA still stops it).
      await this.hero().catch((err) => {
        if (err instanceof CaptchaError) throw err;
        game.log(`Hero: ${err.message}`);
      });
    }
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
    else if (name === 'research') await this.research(villages);
    else if (name === 'smithy') await this.smithy(villages, { force: true });
    else if (name === 'hero') await this.hero({ force: true });
    else if (name === 'raid') await this.raid(villages);
    else if (name === 'farm-setup') result = await this.farmSetup(villages);
    else if (name === 'farm-rebuild') result = await this.farmSetup(villages, { rebuild: true });
    else if (name === 'world') result = await this.updateWorld(villages, { force: true });
    else if (name === 'inactive-raid') await this.raidInactives(villages);
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
    if (this.cfg.inactive.enabled && this.worldStore) minutes = Math.min(minutes, Math.max(1, 10 - minutesSince(this.lastInactiveRaid)));
    return minutes;
  }
}
