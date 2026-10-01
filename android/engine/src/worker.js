// Plays one Travian account (a "server" row) on the phone. The same loop as the server's
// src/server/worker.js: rounds on a timer while running, one-off actions from the dashboard, and
// everything that touches the game goes through exclusive(), so a round and an action never drive
// the page at the same time. The game page (a WebView) only exists during a round or an action.
import { resolveConfig } from '../../../src/config.js';
import { Runner } from '../../../src/runner.js';
import { CaptchaError, Travian } from '../../../src/travian.js';
import { dbSession, dbStore, sqliteWorld } from './repo.js';

export const ACTIONS = ['villages', 'build', 'train', 'research', 'smithy', 'hero', 'raid', 'farm-setup', 'farm-rebuild', 'world', 'inactive-raid'];

export class BotWorker {
  // `browser` is this account's Browser (src/shims/playwright.js); `onChange` tells the manager
  // the worker's state changed (for the app's notification).
  constructor(serverId, { repo, browser, onChange = () => {} }) {
    this.id = serverId;
    this.repo = repo;
    this.browser = browser;
    this.onChange = onChange;
    this.name = `server ${serverId}`;
    this.status = 'stopped';
    this.message = null;
    this.nextRunAt = null;
    this.running = false;
    this.queue = Promise.resolve();
    this.wakeUp = null;
    this.game = null;
    this.runner = null;
  }

  log(message, level = 'info') {
    console.log(`[${this.name}] ${message}`);
    this.repo.addEvent(this.id, level, message).catch((err) => console.error(`event write failed: ${err.message}`));
  }

  async setStatus(status, message = null, nextRunAt = null) {
    Object.assign(this, { status, message, nextRunAt });
    await this.repo.setStatus(this.id, status, message, nextRunAt).catch(() => {});
    this.onChange();
  }

  exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // Opens the game page for this account with the latest settings. The Runner outlives
  // sessions, so its wave and training timers carry over from round to round.
  async session() {
    const server = await this.repo.getServer(this.id);
    if (!server) throw new Error('Server no longer exists');
    this.name = server.name;
    const cfg = resolveConfig(server.config);
    if (!this.game) {
      const creds = await this.repo.getCredentials(this.id);
      this.game = new Travian({
        server: creds.url,
        username: creds.username,
        password: creds.password,
        dryRun: cfg.dryRun,
        browser: this.browser,
        session: dbSession(this.repo, this.id),
        store: dbStore(this.repo, this.id),
        screenshotDir: `screenshots/${this.id}`,
        log: (m) => this.log(m),
      });
      try {
        await this.game.start();
      } catch (err) {
        await this.closeSession({ keepRunner: true });
        throw err;
      }
      if (this.runner) this.runner.game = this.game;
      else this.runner = new Runner(this.game, cfg, { world: sqliteWorld(this.id) });
    }
    // Settings changes apply from the next round on, keeping the wave and training timers.
    this.game.dryRun = cfg.dryRun;
    this.runner.cfg = cfg;
    return this.runner;
  }

  // Closes the game page. Without keepRunner the Runner goes too (after an error, so the next
  // round starts clean).
  async closeSession({ keepRunner = false } = {}) {
    const { game } = this;
    this.game = null;
    if (!keepRunner) this.runner = null;
    await game?.close().catch(() => {});
  }

  async saveSnapshot() {
    if (this.runner) await this.repo.saveSnapshot(this.id, this.runner.snapshot).catch(() => {});
  }

  async screenshot(name) {
    return this.game?.screenshot(name).then((f) => this.log(`Screenshot saved: ${f.split('/').pop()}`), () => {});
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.onChange();
    this.loop().catch((err) => this.log(`Worker crashed: ${err.message}`, 'error'));
  }

  // Stops after the current round, or at once with `force` (closing the game page makes
  // whatever the round is doing fail, which is what a shutdown wants).
  async stop({ force = false } = {}) {
    this.running = false;
    this.wakeUp?.();
    if (force) await this.closeSession();
    await this.exclusive(() => this.closeSession());
    await this.setStatus('stopped');
  }

  sleep(minutes) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, minutes * 60_000);
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async loop() {
    let failures = 0;
    this.log('Started.');
    while (this.running) {
      await this.setStatus('running');
      let minutes;
      try {
        const soonest = await this.exclusive(async () => {
          const runner = await this.session();
          const result = await runner.round();
          await this.saveSnapshot();
          await this.closeSession({ keepRunner: true });
          return result;
        });
        failures = 0;
        minutes = this.runner?.sleepMinutes(soonest) ?? 5;
      } catch (err) {
        if (err instanceof CaptchaError) {
          this.log(err.message, 'error');
          this.running = false;
          await this.exclusive(() => this.closeSession());
          await this.repo.updateServer(this.id, { enabled: false });
          await this.setStatus('captcha', 'Travian showed a CAPTCHA. Solve it in a browser, then start again.');
          return;
        }
        failures += 1;
        this.log(`Round failed: ${err.message}`, 'error');
        await this.exclusive(async () => {
          await this.screenshot('error');
          await this.closeSession(); // start clean next time
        });
        minutes = Math.min(30, 2 ** failures);
        await this.setStatus('error', err.message.slice(0, 500), new Date(Date.now() + minutes * 60_000));
      }
      if (!this.running) break;
      const next = new Date(Date.now() + minutes * 60_000);
      if (this.status !== 'error') await this.setStatus('sleeping', null, next);
      this.log(`Next round in ${Math.round(minutes)} min.`, 'debug');
      await this.sleep(minutes);
    }
    this.log('Stopped.');
  }

  // Runs one action now (between rounds if the bot is running, else in a short session).
  async action(name) {
    if (!ACTIONS.includes(name)) throw new Error(`Unknown action "${name}"`);
    this.log(`Action requested: ${name}.`);
    return this.exclusive(async () => {
      const previous = this.status;
      await this.setStatus('running', `action: ${name}`);
      try {
        const runner = await this.session();
        const result = await runner.action(name);
        await this.saveSnapshot();
        this.log(`Action ${name} finished.`);
        return result;
      } catch (err) {
        this.log(`Action ${name} failed: ${err.message}`, 'error');
        await this.screenshot('error');
        await this.closeSession();
        throw err;
      } finally {
        await this.closeSession({ keepRunner: true });
        await this.setStatus(this.running ? previous : 'stopped', null, this.running ? this.nextRunAt : null);
      }
    });
  }
}
