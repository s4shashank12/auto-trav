#!/usr/bin/env node
import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { canDevelop, POPULATION_LIMIT } from './rules.js';
import { runFarmLists, setupFarmLists } from './farming.js';
import { trainDefense } from './military.js';
import { developVillage } from './strategy.js';
import { CaptchaError, Travian } from './travian.js';

const USAGE = `Usage: auto-travian <command>

Commands:
  villages           List villages, population and whether the bot may build there
  build              Max resource fields and economy buildings in villages under ${POPULATION_LIMIT} population
  farm-setup         Fill "Oases (auto)" farm lists (100 per list, one set per unit type)
  raid               Re-check the auto farm lists' oases and start them
  train              Keep barracks/stables in big villages training defensive troops
  play               build + train + raid
  --loop             Repeat build, raid or play; wakes early when a build job finishes
  screenshot [path]  Save a screenshot of a game page (default /dorf1.php)

Configuration comes from environment variables (or .env via npm scripts):
  TRAVIAN_SERVER, TRAVIAN_USERNAME, TRAVIAN_PASSWORD
  HEADLESS=false, DRY_RUN=true, BUILD_QUEUE_MAX (3), RAID_RADIUS (45), RAID_EVERY_MINUTES (10),
  RAID_CYCLE_MINUTES (60),
  TRAIN_EVERY_MINUTES (30), LOOP_MIN_MINUTES (20), LOOP_MAX_MINUTES (40), LOOP_FLOOR_MINUTES (4)`;

const COMMANDS = ['villages', 'build', 'farm-setup', 'raid', 'train', 'play', 'screenshot'];
const env = process.env;
const flag = (v) => /^(1|true|yes)$/i.test(v ?? '');
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const farmOptions = { radius: Number(env.RAID_RADIUS ?? 45) };
const LOCK_FILE = '.auth/bot.lock';

// Several runs can share one account, but the game keeps a single "active village" per session, so
// only one of them may drive the browser at a time. A lock older than 15 minutes is treated as stale.
async function withLock(fn) {
  await fs.mkdir('.auth', { recursive: true });
  for (;;) {
    try {
      await (await fs.open(LOCK_FILE, 'wx')).close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const age = Date.now() - (await fs.stat(LOCK_FILE).then((s) => s.mtimeMs, () => Date.now()));
      if (age > 15 * 60_000) await fs.rm(LOCK_FILE, { force: true });
      else await sleep(3000);
    }
  }
  holdingLock = true;
  try {
    return await fn();
  } finally {
    await fs.rm(LOCK_FILE, { force: true });
    holdingLock = false;
  }
}

// Exit on Ctrl+C / kill, releasing the lock if a pass was in progress.
let holdingLock = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (holdingLock) rmSync(LOCK_FILE, { force: true });
    process.exit(130);
  });
}

// Develops every small village. Returns seconds until the first queued job finishes, or null.
async function build(game) {
  let soonest = null;
  const villages = await game.villages();
  for (const v of villages.filter(canDevelop)) {
    const queue = await developVillage(game, v, { queueMax: Number(env.BUILD_QUEUE_MAX ?? 3), villages });
    for (const q of queue) {
      if (q.secondsLeft != null && (soonest == null || q.secondsLeft < soonest)) soonest = q.secondsLeft;
    }
  }
  return soonest;
}

let lastRaid = 0;
const raidEvery = Number(env.RAID_EVERY_MINUTES ?? 10);
async function raid(game) {
  lastRaid = Date.now();
  await runFarmLists(game, { waveMinutes: raidEvery, cycleMinutes: Number(env.RAID_CYCLE_MINUTES ?? 60) });
}

let lastTrain = 0;
async function train(game) {
  await trainDefense(game, await game.villages());
  lastTrain = Date.now();
}

async function play(game) {
  const soonest = await build(game);
  if (Date.now() - lastTrain >= Number(env.TRAIN_EVERY_MINUTES ?? 30) * 60_000) await train(game);
  if (Date.now() - lastRaid >= (raidEvery - 0.5) * 60_000) await raid(game);
  return soonest;
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (!COMMANDS.includes(command)) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const game = new Travian({
    server: env.TRAVIAN_SERVER,
    username: env.TRAVIAN_USERNAME,
    password: env.TRAVIAN_PASSWORD,
    headless: env.HEADLESS == null || flag(env.HEADLESS),
    dryRun: flag(env.DRY_RUN),
    log,
  });

  // Returns seconds until the next build job finishes, when known, so --loop can wake up for it.
  const run = async () => {
    await game.login();
    if (command === 'villages') {
      for (const v of await game.villages()) {
        console.log(`${v.name.padEnd(14)} (${v.x}|${v.y})  pop ${String(v.population).padStart(5)}  ${canDevelop(v) ? 'develop' : 'no building'}`);
      }
    } else if (command === 'build') {
      return build(game);
    } else if (command === 'farm-setup') {
      await setupFarmLists(game, await game.villages(), farmOptions);
    } else if (command === 'raid') {
      await raid(game);
    } else if (command === 'train') {
      await train(game);
    } else if (command === 'screenshot') {
      await game.goto(arg ?? '/dorf1.php');
      log(`Screenshot: ${await game.screenshot('page')}`);
    } else {
      return play(game);
    }
    return null;
  };

  await game.start();
  try {
    if (arg !== '--loop') {
      await withLock(run);
      return;
    }
    const min = Number(env.LOOP_MIN_MINUTES ?? 20);
    const max = Number(env.LOOP_MAX_MINUTES ?? 40);
    const floor = Number(env.LOOP_FLOOR_MINUTES ?? 4);
    for (;;) {
      let soonest = null;
      try {
        soonest = await withLock(run);
      } catch (err) {
        if (err instanceof CaptchaError) throw err;
        log(`Pass failed: ${err.message}`);
        await game.screenshot('error').then((f) => log(`Screenshot: ${f}`), () => {});
      }
      // Come back when the first build job finishes so its slot does not sit idle, and in time
      // for the next raid wave.
      let minutes = min + Math.random() * (max - min);
      if (soonest != null) minutes = Math.max(floor, Math.min(minutes, soonest / 60 + 0.5 + Math.random() * 1.5));
      if (command === 'play' || command === 'raid') {
        minutes = Math.min(minutes, Math.max(1, raidEvery - (Date.now() - lastRaid) / 60_000));
      }
      log(`Sleeping ${Math.round(minutes)} min.`);
      await sleep(minutes * 60_000);
    }
  } catch (err) {
    await game.screenshot('error').then((f) => log(`Screenshot: ${f}`), () => {});
    throw err;
  } finally {
    await game.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
