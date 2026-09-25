#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import { Travian, formatStatus } from './travian.js';

const USAGE = `Usage: auto-travian <command>

Commands:
  status             Log in and print the village overview
  play [--loop]      Run one upkeep pass (or keep running with --loop)
  screenshot [path]  Save a screenshot of a game page (default /dorf1.php)

Configuration comes from environment variables (or .env via npm scripts):
  TRAVIAN_SERVER, TRAVIAN_USERNAME, TRAVIAN_PASSWORD
  HEADLESS=false, DRY_RUN=true, BUILD_QUEUE_SLOTS, LOOP_MIN_MINUTES, LOOP_MAX_MINUTES`;

const env = process.env;
const flag = (v) => /^(1|true|yes)$/i.test(v ?? '');
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

// Wait until the current build finishes (plus jitter), clamped to the configured window.
function nextWaitMs(status) {
  const min = Number(env.LOOP_MIN_MINUTES ?? 5);
  const max = Number(env.LOOP_MAX_MINUTES ?? 45);
  const soonest = Math.min(...status.queue.map((q) => q.secondsLeft ?? Infinity)) / 60;
  const target = Number.isFinite(soonest) ? soonest + 1 : min;
  const minutes = Math.min(max, Math.max(min, target)) * (1 + Math.random() * 0.2);
  return minutes * 60_000;
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (!['status', 'play', 'screenshot'].includes(command)) {
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

  await game.start();
  try {
    await game.login();

    if (command === 'status') {
      console.log(formatStatus(await game.status()));
      log(`Screenshot: ${await game.screenshot('status')}`);
    } else if (command === 'screenshot') {
      await game.goto(arg ?? '/dorf1.php');
      log(`Screenshot: ${await game.screenshot('page')}`);
    } else if (arg !== '--loop') {
      await game.play({ queueSlots: Number(env.BUILD_QUEUE_SLOTS ?? 1) });
    } else {
      for (;;) {
        let waitMs = Number(env.LOOP_MIN_MINUTES ?? 5) * 60_000;
        try {
          await game.login();
          waitMs = nextWaitMs(await game.play({ queueSlots: Number(env.BUILD_QUEUE_SLOTS ?? 1) }));
        } catch (err) {
          log(`Pass failed: ${err.message}`);
          await game.screenshot('error').then((f) => log(`Screenshot: ${f}`), () => {});
        }
        log(`Sleeping ${Math.round(waitMs / 60_000)} min.`);
        await sleep(waitMs);
      }
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
