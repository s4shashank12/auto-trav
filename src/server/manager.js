import { chromium } from 'playwright';
import { launchOptions } from '../travian.js';
import { BotWorker } from './worker.js';

// Owns one Chromium shared by every account (each gets its own browser context) and one worker
// per server row. Workers borrow the browser for a round and give it back; once nobody has used
// it for env.browserIdleSeconds it is closed, so it takes no memory while the bots sleep.
export class BotManager {
  constructor({ repo, env, pool }) {
    this.repo = repo;
    this.pool = pool;
    this.env = env;
    this.workers = new Map();
    this.browser = null;
    this.launching = null;
    this.users = 0;
    this.idleTimer = null;
  }

  async getBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = chromium.launch(launchOptions({ headless: this.env.headless })).then((b) => {
        this.browser = b;
        this.launching = null;
        return b;
      }, (err) => {
        this.launching = null;
        throw err;
      });
    }
    return this.launching;
  }

  async acquireBrowser() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.users += 1;
    try {
      return await this.getBrowser();
    } catch (err) {
      this.users -= 1;
      throw err;
    }
  }

  releaseBrowser() {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.users > 0 || !this.browser) return;
      const { browser } = this;
      this.browser = null;
      browser.close().catch(() => {});
    }, this.env.browserIdleSeconds * 1000);
    this.idleTimer.unref?.();
  }

  worker(id) {
    if (!this.workers.has(id)) {
      this.workers.set(id, new BotWorker(id, {
        repo: this.repo,
        pool: this.pool,
        acquireBrowser: () => this.acquireBrowser(),
        releaseBrowser: () => this.releaseBrowser(),
        dataDir: this.env.dataDir,
      }));
    }
    return this.workers.get(id);
  }

  // Live state of a worker, which is fresher than what is stored in the database.
  state(id) {
    const w = this.workers.get(id);
    return w && { status: w.status, message: w.message, nextRunAt: w.nextRunAt, running: w.running };
  }

  async start(id) {
    await this.repo.updateServer(id, { enabled: true });
    this.worker(id).start();
  }

  async stop(id) {
    await this.repo.updateServer(id, { enabled: false });
    await this.workers.get(id)?.stop();
  }

  // Restarts a running worker so new credentials or a new game world take effect.
  async reload(id) {
    const w = this.workers.get(id);
    if (!w?.running) return;
    await w.stop();
    w.start();
  }

  async remove(id) {
    const w = this.workers.get(id);
    if (w) {
      await w.stop({ force: true });
      this.workers.delete(id);
    }
  }

  async startEnabled() {
    // Servers that were mid-round when the process stopped are no longer running.
    for (const server of await this.repo.listServers()) {
      if (server.enabled) this.worker(server.id).start();
      else if (server.status !== 'stopped' && server.status !== 'captcha') await this.repo.setStatus(server.id, 'stopped');
    }
  }

  async shutdown() {
    await Promise.all([...this.workers.values()].map((w) => w.stop({ force: true }).catch(() => {})));
    clearTimeout(this.idleTimer);
    await this.browser?.close().catch(() => {});
  }
}
