import { chromium } from 'playwright';
import { BotWorker } from './worker.js';

// Owns one Chromium shared by every account (each gets its own browser context) and one worker
// per server row.
export class BotManager {
  constructor({ repo, env, pool }) {
    this.repo = repo;
    this.pool = pool;
    this.env = env;
    this.workers = new Map();
    this.browser = null;
    this.launching = null;
  }

  async getBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = chromium.launch({ headless: this.env.headless }).then((b) => {
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

  worker(id) {
    if (!this.workers.has(id)) {
      this.workers.set(id, new BotWorker(id, {
        repo: this.repo,
        pool: this.pool,
        getBrowser: () => this.getBrowser(),
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
    await this.browser?.close().catch(() => {});
  }
}
