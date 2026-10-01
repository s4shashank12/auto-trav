// The bot engine: runs in an off-screen WebView inside the app's foreground service
// (BotService.kt), so it keeps playing with the app closed and the screen off. It is the
// server (src/server) for one phone: SQLite instead of Postgres, WebViews instead of Chromium,
// and the dashboard's API answered over the app's bridge instead of HTTP.
import { createApi } from './api.js';
import { BotManager } from './manager.js';
import { installTimers, sync } from './native.js';
import { makeRepo, migrate } from './repo.js';

const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
const EVENTS_RETENTION_DAYS = 7;

function boot() {
  installTimers();
  const device = JSON.parse(sync('deviceInfo') || '{}');
  migrate();
  const cipher = {
    encrypt: (plain) => sync('encrypt', String(plain)),
    decrypt: (stored) => {
      const plain = sync('decrypt', String(stored ?? ''));
      if (plain == null) throw new Error('decryption failed');
      return plain;
    },
  };
  const repo = makeRepo(cipher);
  const manager = new BotManager({ repo, multiProfile: Boolean(device.multiProfile) });
  const api = createApi({
    repo, manager, version: VERSION, device,
  });

  // Requests from the dashboard (through the app): the answer goes back with apiResponse.
  globalThis.__api = (requestId, method, url, bodyText) => {
    let body;
    try {
      body = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      sync('apiResponse', requestId, 400, JSON.stringify({ error: 'Body is not valid JSON' }));
      return;
    }
    api(method, url, body).then(
      (res) => sync('apiResponse', requestId, res.status, res.body == null ? '' : JSON.stringify(res.body)),
      (err) => sync('apiResponse', requestId, 500, JSON.stringify({ error: String(err?.message ?? err) })),
    );
  };
  globalThis.__engine = {
    stopAll: () => manager.stopAll(),
    shutdown: () => manager.shutdown(),
  };

  repo.pruneEvents(EVENTS_RETENTION_DAYS).catch(() => {});
  setInterval(() => repo.pruneEvents(EVENTS_RETENTION_DAYS).catch(() => {}), 3_600_000);
  console.log(`auto-naitra engine ${VERSION} ready (WebView profiles: ${device.multiProfile ? 'yes' : 'no'}).`);
  sync('engineReady');
  // Accounts that were running start again by themselves (after a restart, update or reboot).
  manager.startEnabled().catch((err) => console.error(`autostart failed: ${err.message}`));
}

try {
  boot();
} catch (err) {
  console.error(`Engine failed to start: ${err?.stack ?? err}`);
  try {
    sync('engineFailed', String(err?.message ?? err));
  } catch { /* not in the app */ }
}
