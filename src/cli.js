#!/usr/bin/env node
import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { canDevelop, POPULATION_LIMIT } from './rules.js';
import { developVillage, runFarmLists, setupFarmLists } from './strategy.js';
import { CaptchaError, Travian } from './travian.js';

const USAGE = `Usage: auto-travian <command>

Commands:
  villages           List villages, population and whether the bot may build there
  build              Max resource fields and economy buildings in villages under ${POPULATION_LIMIT} population
  farm-setup         Create/refresh "Oases (auto)" farm lists with empty, unoccupied oases
  raid               Re-check the auto farm lists' oases and start them
  play               build + raid
  --loop             Repeat build, raid or play every LOOP_MIN..LOOP_MAX minutes
  screenshot [path]  Save a screenshot of a game page (default /dorf1.php)

Configuration comes from environment variables (or .env via npm scripts):
  TRAVIAN_SERVER, TRAVIAN_USERNAME, TRAVIAN_PASSWORD
  HEADLESS=false, DRY_RUN=true, RAID_RADIUS (20), RAID_PER_SLOT (5),
  LOOP_MIN_MINUTES (20), LOOP_MAX_MINUTES (40)`;

const COMMANDS = ['villages', 'build', 'farm-setup', 'raid', 'play', 'screenshot'];
const env = process.env;
const flag = (v) => /^(1|true|yes)$/i.test(v ?? '');
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const farmOptions = { radius: Number(env.RAID_RADIUS ?? 20), perSlot: Number(env.RAID_PER_SLOT ?? 5) };
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
  try {
    return await fn();
  } finally {
    await fs.rm(LOCK_FILE, { force: true });
  }
}

async function build(game) {
  for (const v of (await game.villages()).filter(canDevelop)) {
    await developVillage(game, v);
  }
}

async function play(game) {
  await build(game);
  await runFarmLists(game);
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

  const run = async () => {
    await game.login();
    if (command === 'villages') {
      for (const v of await game.villages()) {
        console.log(`${v.name.padEnd(14)} (${v.x}|${v.y})  pop ${String(v.population).padStart(5)}  ${canDevelop(v) ? 'develop' : 'no building'}`);
      }
    } else if (command === 'build') {
      await build(game);
    } else if (command === 'farm-setup') {
      await setupFarmLists(game, await game.villages(), farmOptions);
    } else if (command === 'raid') {
      await runFarmLists(game);
    } else if (command === 'screenshot') {
      await game.goto(arg ?? '/dorf1.php');
      log(`Screenshot: ${await game.screenshot('page')}`);
    } else {
      await play(game);
    }
  };

  await game.start();
  try {
    if (arg !== '--loop') {
      await withLock(run);
      return;
    }
    const min = Number(env.LOOP_MIN_MINUTES ?? 20);
    const max = Number(env.LOOP_MAX_MINUTES ?? 40);
    for (;;) {
      try {
        await withLock(run);
      } catch (err) {
        if (err instanceof CaptchaError) throw err;
        log(`Pass failed: ${err.message}`);
        await game.screenshot('error').then((f) => log(`Screenshot: ${f}`), () => {});
      }
      const minutes = min + Math.random() * (max - min);
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
