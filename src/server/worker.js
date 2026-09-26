import path from 'node:path';
import { resolveConfig } from '../config.js';
import { Runner } from '../runner.js';
import { CaptchaError, Travian } from '../travian.js';
import { pgSession, pgStore } from './repo.js';

export const ACTIONS = ['villages', 'build', 'train', 'raid', 'farm-setup'];

// Plays one Travian account (a "server" row): rounds on a timer while running, plus one-off
// actions from the dashboard. Everything that touches the game goes through exclusive(), so a
// round and an action never drive the browser at the same time.
export class BotWorker {
  constructor(serverId, { repo, getBrowser, dataDir }) {
    this.id = serverId;
    this.repo = repo;
    this.getBrowser = getBrowser;
    this.dataDir = dataDir;
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
    console.log(`[${new Date().toISOString()}] [${this.name}] ${message}`);
    this.repo.addEvent(this.id, level, message).catch((err) => console.error(`event write failed: ${err.message}`));
  }

  async setStatus(status, message = null, nextRunAt = null) {
    Object.assign(this, { status, message, nextRunAt });
    await this.repo.setStatus(this.id, status, message, nextRunAt).catch(() => {});
  }

  exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // Opens (or reuses) the browser session for this account with the latest settings.
  async session() {
    const server = await this.repo.getServer(this.id);
    if (!server) throw new Error('Server no longer exists');
    this.name = server.name;
    const cfg = resolveConfig(server.config);
    if (!this.game || this.game.browser?.isConnected?.() === false) {
      await this.closeSession();
      const creds = await this.repo.getCredentials(this.id);
      this.game = new Travian({
        server: creds.url,
        username: creds.username,
        password: creds.password,
        dryRun: cfg.dryRun,
        browser: await this.getBrowser(),
        session: pgSession(this.repo, this.id),
        store: pgStore(this.repo, this.id),
        screenshotDir: path.join(this.dataDir, 'screenshots', String(this.id)),
        log: (m) => this.log(m),
      });
      await this.game.start();
      this.runner = new Runner(this.game, cfg);
    }
    // Settings changes apply from the next round on, keeping the wave and training timers.
    this.game.dryRun = cfg.dryRun;
    this.runner.cfg = cfg;
    return this.runner;
  }

  async closeSession() {
    const { game } = this;
    this.game = null;
    this.runner = null;
    await game?.close().catch(() => {});
  }

  async saveSnapshot() {
    if (this.runner) await this.repo.saveSnapshot(this.id, this.runner.snapshot).catch(() => {});
  }

  async screenshot(name) {
    return this.game?.screenshot(name).then((f) => this.log(`Screenshot saved: ${path.basename(f)}`), () => {});
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop().catch((err) => this.log(`Worker crashed: ${err.message}`, 'error'));
  }

  // Stops after the current round, or at once with `force` (closing the browser session makes
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
        if (!this.running) await this.closeSession();
        await this.setStatus(this.running ? previous : 'stopped', null, this.running ? this.nextRunAt : null);
      }
    });
  }
}
