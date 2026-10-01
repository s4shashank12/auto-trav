// One worker per server row, as on the server (src/server/manager.js). Instead of one shared
// Chromium, each account gets its own Browser: a WebView profile of its own (cookies and storage
// kept apart, like a Playwright browser context) when the phone's WebView supports profiles.
// Without that, accounts share one cookie jar and take turns (`lock`).
import { call, sync } from './native.js';
import { Browser, Lock } from './shims/playwright.js';
import { BotWorker } from './worker.js';

export const profileName = (id) => `server-${id}`;

export class BotManager {
  constructor({ repo, multiProfile }) {
    this.repo = repo;
    this.multiProfile = multiProfile;
    this.lock = multiProfile ? null : new Lock();
    this.workers = new Map();
    this.publishTimer = null;
  }

  worker(id) {
    if (!this.workers.has(id)) {
      this.workers.set(id, new BotWorker(id, {
        repo: this.repo,
        browser: new Browser({ profile: this.multiProfile ? profileName(id) : null, lock: this.lock }),
        onChange: () => this.publish(),
      }));
    }
    return this.workers.get(id);
  }

  // Live state of a worker, which is fresher than what is stored in the database.
  state(id) {
    const w = this.workers.get(id);
    return w && {
      status: w.status, message: w.message, nextRunAt: w.nextRunAt, running: w.running,
    };
  }

  async start(id) {
    await this.repo.updateServer(id, { enabled: true });
    this.worker(id).start();
  }

  async stop(id) {
    await this.repo.updateServer(id, { enabled: false });
    await this.workers.get(id)?.stop();
  }

  // New credentials or a new game world: the account's saved login is dropped and a running
  // worker restarts with them.
  async reload(id, { clearLogin = false } = {}) {
    const w = this.workers.get(id);
    const wasRunning = Boolean(w?.running);
    if (wasRunning) await w.stop();
    if (clearLogin && this.multiProfile) await call('cookiesClear', profileName(id)).catch(() => {});
    if (wasRunning) w.start();
  }

  async remove(id) {
    const w = this.workers.get(id);
    if (w) {
      await w.stop({ force: true });
      this.workers.delete(id);
    }
    if (this.multiProfile) await call('profileDelete', profileName(id)).catch(() => {});
    this.publish();
  }

  async startEnabled() {
    // Servers that were mid-round when the app stopped are no longer running.
    for (const server of await this.repo.listServers()) {
      if (server.enabled) this.worker(server.id).start();
      else if (server.status !== 'stopped' && server.status !== 'captcha') await this.repo.setStatus(server.id, 'stopped');
    }
    this.publish();
  }

  // The notification's "Stop all": every account stops and stays stopped.
  async stopAll() {
    const running = [...this.workers.entries()].filter(([, w]) => w.running);
    await Promise.all(running.map(([id]) => this.stop(id).catch(() => {})));
  }

  async shutdown() {
    await Promise.all([...this.workers.values()].map((w) => w.stop({ force: true }).catch(() => {})));
  }

  // Tells the app how many accounts run (it keeps the phone awake for them) and what they do,
  // for its notification.
  publish() {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      const active = [...this.workers.values()].filter((w) => w.running || w.status === 'running');
      const accounts = active.map((w) => ({
        name: w.name, status: w.status, nextRunAt: w.nextRunAt ? new Date(w.nextRunAt).toISOString() : null,
      }));
      // `running`: accounts started; `busy`: those plus one-off actions on stopped accounts.
      const running = active.filter((w) => w.running).length;
      try {
        sync('setStatus', JSON.stringify({ running, busy: active.length, accounts }));
      } catch (err) {
        console.error(`setStatus failed: ${err.message}`);
      }
    }, 200);
  }
}
