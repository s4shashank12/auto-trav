// Runs the engine bundle the way the app does, but in Node: the `Native` bridge (BotEngine.kt) is
// played by this file, with node:sqlite for the app's SQLite and Playwright's Chromium pages for
// the app's off-screen WebViews. A profile is a browser context here (a WebView profile in the
// app). The engine runs in its own vm context, as it has its own WebView in the app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function bundleEngine() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [path.join(here, '..', 'build.mjs')], { env: { ...process.env, ENGINE_OUT: out, APP_VERSION: 'test' } });
  return fs.readFileSync(path.join(out, 'engine.js'), 'utf8');
}

export async function startEngine({ multiProfile = true, source } = {}) {
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const browser = await chromium.launch();
  const contexts = new Map();
  const pages = new Map();
  const timers = new Map();
  const responses = new Map();
  const statuses = [];
  let reqSeq = 0;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  let ctx;
  const done = (id, ok, payload) => ctx.__nativeDone(id, ok, payload == null ? '' : String(payload));
  const later = (id, fn) => {
    Promise.resolve().then(fn).then((v) => done(id, true, v ?? ''), (e) => done(id, false, e.message));
  };
  const context = async (profile) => {
    const key = multiProfile ? profile : '';
    if (!contexts.has(key)) contexts.set(key, await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' }));
    return contexts.get(key);
  };
  const safe = (rel) => {
    const p = path.resolve(filesDir, rel);
    if (!p.startsWith(filesDir)) throw new Error('Bad path');
    return p;
  };
  const rows = (stmt, params) => stmt.all(...params);

  const Native = {
    deviceInfo: () => JSON.stringify({ multiProfile, webView: 'test' }),
    engineReady: () => readyResolve(),
    engineFailed: (msg) => { throw new Error(`engine failed: ${msg}`); },
    setStatus: (json) => { statuses.push(JSON.parse(json)); },
    apiResponse: (id, status, body) => {
      responses.get(id)?.({ status, body: body ? JSON.parse(body) : null });
      responses.delete(id);
    },
    dbQuery: (sql, params) => JSON.stringify(rows(db.prepare(sql), JSON.parse(params))),
    dbRun: (sql, params) => {
      const r = db.prepare(sql).run(...JSON.parse(params));
      return JSON.stringify({ changes: Number(r.changes), lastId: Number(r.lastInsertRowid) });
    },
    dbBatch: (json) => {
      let changes = 0;
      db.exec('BEGIN');
      try {
        for (const s of JSON.parse(json)) {
          const stmt = db.prepare(s.sql);
          for (const params of s.rows ?? [s.params ?? []]) changes += Number(stmt.run(...params).changes);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return JSON.stringify({ changes });
    },
    encrypt: (plain) => `test:${Buffer.from(plain).toString('base64')}`,
    decrypt: (stored) => (stored.startsWith('test:') ? Buffer.from(stored.slice(5), 'base64').toString() : null),
    timerStart: (id, ms) => {
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        ctx.__timerFire(id);
      }, ms));
    },
    timerCancel: (id) => {
      clearTimeout(timers.get(id));
      timers.delete(id);
    },
    pageCreate: (id, pageId, profile, hook) => later(id, async () => {
      const page = await (await context(profile)).newPage();
      await page.addInitScript(hook);
      const entry = { page, started: 0, finished: 0 };
      page.on('request', (r) => {
        if (r.isNavigationRequest() && r.frame() === page.mainFrame()) entry.started += 1;
      });
      page.on('load', () => { entry.finished = entry.started; });
      pages.set(pageId, entry);
    }),
    pageClose: (id, pageId) => later(id, async () => {
      await pages.get(pageId)?.page.close();
      pages.delete(pageId);
    }),
    pageGoto: (id, pageId, url, timeout) => later(id, async () => {
      await pages.get(pageId).page.goto(url, { waitUntil: 'load', timeout });
    }),
    // evaluateJavascript: the JSON encoding of the script's value, "null" when it could not run.
    pageEval: (id, pageId, script) => later(id, async () => {
      try {
        return JSON.stringify((await pages.get(pageId).page.evaluate(script)) ?? null);
      } catch {
        return 'null';
      }
    }),
    pageUrl: (pageId) => pages.get(pageId)?.page.url() ?? '',
    pageNavState: (pageId) => {
      const e = pages.get(pageId);
      return e ? `${e.started},${e.finished}` : '0,0';
    },
    pageScreenshot: (id, pageId, rel) => later(id, async () => {
      fs.mkdirSync(path.dirname(safe(rel)), { recursive: true });
      await pages.get(pageId).page.screenshot({ path: safe(rel) });
    }),
    cookiesGet: (id, profile, origin) => later(id, async () => (await (await context(profile)).cookies(origin))
      .map((c) => `${c.name}=${c.value}`).join('; ')),
    cookiesSet: (id, profile, origin, cookies) => later(id, async () => {
      const list = cookies.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
        const i = s.indexOf('=');
        return { name: s.slice(0, i), value: s.slice(i + 1), url: origin };
      });
      if (list.length) await (await context(profile)).addCookies(list);
    }),
    cookiesClear: (id, profile) => later(id, async () => { await (await context(profile)).clearCookies(); }),
    profileDelete: (id, profile) => later(id, async () => {
      await contexts.get(profile)?.close();
      contexts.delete(profile);
    }),
    listFiles: (rel) => JSON.stringify(fs.existsSync(safe(rel)) ? fs.readdirSync(safe(rel)) : []),
    readFileBase64: (rel) => (fs.existsSync(safe(rel)) ? fs.readFileSync(safe(rel)).toString('base64') : ''),
    deleteFiles: (rel) => { fs.rmSync(safe(rel), { recursive: true, force: true }); },
  };

  ctx = vm.createContext({
    Native,
    console,
    URL,
    URLSearchParams,
    performance,
    structuredClone,
    TextEncoder,
    TextDecoder,
    setTimeout: () => { throw new Error('engine timers must go through Native'); },
    clearTimeout: () => {},
  });
  vm.runInContext(source ?? await bundleEngine(), ctx, { filename: 'engine.js' });
  await ready;

  const api = (method, url, body) => new Promise((resolve) => {
    const id = ++reqSeq;
    responses.set(id, resolve);
    ctx.__api(id, method, url, body === undefined ? '' : JSON.stringify(body));
  });

  return {
    api,
    db,
    ctx,
    statuses,
    filesDir,
    pages,
    contexts,
    async close() {
      await ctx.__engine.shutdown().catch(() => {});
      for (const t of timers.values()) clearTimeout(t);
      await browser.close();
      fs.rmSync(filesDir, { recursive: true, force: true });
    },
  };
}

// Polls `fn` until it returns a truthy value (or throws after `ms`).
export async function until(fn, ms = 60_000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => { setTimeout(r, 200); });
  }
}
