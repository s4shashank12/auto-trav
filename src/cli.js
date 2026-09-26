#!/usr/bin/env node
// Single-account command line. The server (src/server) runs many accounts from the dashboard;
// this runs one from environment variables, handy on a laptop or for trying things out.
import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { configFromEnv } from './config.js';
import { canDevelop } from './rules.js';
import { Runner } from './runner.js';
import { FileStore } from './stores.js';
import { CaptchaError, Travian } from './travian.js';
import { FileWorldStore, findInactives } from './world.js';

const USAGE = `Usage: auto-travian <command>

Commands:
  villages           List villages, population and whether the bot may build there
  build              Develop the villages under the population limit
  farm-setup         Fill the bot's farm lists with empty, unoccupied oases
  farm-rebuild       Empty the bot's farm lists, then fill them again (farm-setup from scratch)
  raid               Send one raid wave from the bot's farm lists
  world              Import today's world data (map.sql); update inactive lists if enabled
  inactives          List inactive players' villages near yours (needs a few days of world data)
  inactive-raid      Raid the inactive farm lists now
  train              Research missing units, improve them in the Smithy, then keep big villages training
  research           Research the units villages need in their Academy
  smithy             Start the next Smithy upgrade in every village that wants one
  play               build + train + raid
  --loop             Repeat play (or another command) until stopped
  screenshot [path]  Save a screenshot of a game page (default /dorf1.php)

Configuration: TRAVIAN_SERVER, TRAVIAN_USERNAME, TRAVIAN_PASSWORD, and optionally
bot.config.json (overrides of src/config.js) plus HEADLESS=false, DRY_RUN=true, BUILD_QUEUE_MAX,
RAID_RADIUS, RAID_EVERY_MINUTES, RAID_CYCLE_MINUTES, TRAIN_EVERY_MINUTES, LOOP_MIN_MINUTES,
LOOP_MAX_MINUTES, LOOP_FLOOR_MINUTES.`;

const COMMANDS = ['villages', 'build', 'farm-setup', 'farm-rebuild', 'raid', 'train', 'research', 'smithy', 'play', 'screenshot', 'world', 'inactives', 'inactive-raid'];
const env = process.env;
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const LOCK_FILE = '.auth/bot.lock';

// Several runs can share one account, but the game keeps a single "active village" per session, so
// only one of them may drive the browser at a time. A lock older than 15 minutes is treated as stale.
let holdingLock = false;
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
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (holdingLock) rmSync(LOCK_FILE, { force: true });
    process.exit(130);
  });
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (!COMMANDS.includes(command)) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const fileConfig = JSON.parse(await fs.readFile(env.BOT_CONFIG ?? 'bot.config.json', 'utf8').catch(() => '{}'));
  const cfg = configFromEnv(env, fileConfig);
  const game = new Travian({
    server: env.TRAVIAN_SERVER,
    username: env.TRAVIAN_USERNAME,
    password: env.TRAVIAN_PASSWORD,
    headless: !/^(0|false|no)$/i.test(env.HEADLESS ?? ''),
    dryRun: cfg.dryRun,
    store: new FileStore('.auth'),
    log,
  });
  const world = new FileWorldStore('.auth/world');
  const runner = new Runner(game, cfg, { world });

  // Returns seconds until the next build job finishes, when known, so --loop can wake up for it.
  const run = async () => {
    if (command === 'villages') {
      await runner.action('villages');
      for (const v of runner.snapshot.villages) {
        console.log(`${v.name.padEnd(14)} (${v.x}|${v.y})  pop ${String(v.population).padStart(5)}  ${canDevelop(v, cfg) ? 'develop' : 'no building'}${v.capital ? '  capital' : ''}`);
      }
      return null;
    }
    if (command === 'inactives') {
      await runner.action('villages');
      const found = await findInactives(world, runner.snapshot.villages, cfg);
      if (!found.ready) console.log(`Need ${found.needDays} days of world data (have ${found.days}); run "world" once a day.`);
      for (const t of found.targets.slice(0, 50)) {
        console.log(`${String(t.dist).padStart(5)}  (${t.x}|${t.y})  ${t.village} — ${t.player} [${t.alliance ?? ''}] pop ${t.population}, player ${t.playerChange >= 0 ? '+' : ''}${t.playerChange}`);
      }
      return null;
    }
    if (command === 'screenshot') {
      await game.login();
      await game.goto(arg ?? '/dorf1.php');
      log(`Screenshot: ${await game.screenshot('page')}`);
      return null;
    }
    if (command === 'play') return runner.round();
    await runner.action(command);
    return null;
  };

  await game.start();
  try {
    if (arg !== '--loop') {
      await withLock(run);
      return;
    }
    for (;;) {
      let soonest = null;
      try {
        soonest = await withLock(run);
      } catch (err) {
        if (err instanceof CaptchaError) throw err;
        log(`Pass failed: ${err.message}`);
        await game.screenshot('error').then((f) => log(`Screenshot: ${f}`), () => {});
      }
      const minutes = runner.sleepMinutes(soonest);
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
