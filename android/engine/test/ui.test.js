// The dashboard as the app shows it: built, served from the app's asset origin at phone size, with
// window.AutoNaitraAndroid (MainActivity's bridge) forwarding to the engine in harness.js.
//   SCREENSHOTS=<dir>  also saves a screenshot of each screen there.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startEngine, until } from './harness.js';
import { startMockTravian } from './mock-travian.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = path.resolve(here, '../../../dashboard');
const ORIGIN = 'https://appassets.androidplatform.net';
const shots = process.env.SCREENSHOTS;

let world;
let engine;
let browser;
let page;
let dist;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
};

async function shot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
}

before(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'));
  execFileSync('npm', ['exec', '--', 'vite', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: dashboard, env: { ...process.env, VITE_APP_VERSION: 'test' },
  });
  world = await startMockTravian({ password: 'secret' });
  engine = await startEngine();
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  // WebViewAssetLoader in the app: the dashboard's files at the root of the asset origin.
  await context.route(`${ORIGIN}/**`, (route) => {
    const rel = new URL(route.request().url()).pathname.replace(/^\/+/, '') || 'index.html';
    const file = path.join(dist, rel);
    if (!file.startsWith(dist) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'Not Found' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: fs.readFileSync(file) });
  });
  page = await context.newPage();
  page.on('pageerror', (err) => console.error(`dashboard error: ${err.message}`));
  // MainActivity's bridge: request() answers later through window.__androidResponse.
  await page.exposeBinding('__bridgeRequest', async (source, id, method, url, body) => {
    const res = await engine.api(method, url, body ? JSON.parse(body) : undefined);
    const text = res.body == null ? '' : JSON.stringify(res.body);
    await page.evaluate(([i, s, t]) => window.__androidResponse(i, s, t), [id, res.status, text]);
  });
  await page.addInitScript(() => {
    window.AutoNaitraAndroid = {
      request: (id, method, url, body) => { window.__bridgeRequest(id, method, url, body); },
      phoneStatus: () => JSON.stringify({
        batteryUnrestricted: false, notifications: true, multiProfile: true, webView: 'com.google.android.webview 140', android: '15', model: 'Google Pixel 8', app: 'test',
      }),
      allowBackground: () => { window.__askedBackground = true; },
      allowNotifications: () => {},
    };
  });
});

after(async () => {
  await browser?.close();
  await engine?.close();
  await world?.close();
  if (dist) fs.rmSync(dist, { recursive: true, force: true });
});

test('the dashboard runs on the phone engine: add, run, read logs, change settings', async () => {
  await page.goto(`${ORIGIN}/index.html`);
  await page.getByRole('heading', { name: 'Servers' }).waitFor();
  // No backend to connect to, and the phone's checklist is there.
  assert.equal(await page.getByText('Backend URL').count(), 0);
  assert.ok(await page.getByText('This phone').first().isVisible());
  assert.ok(await page.getByText('Restricted: Android may pause the bot').isVisible());
  await page.getByRole('button', { name: 'Allow' }).first().click();
  assert.equal(await page.evaluate(() => window.__askedBackground), true);
  await shot('1-servers-empty');

  await page.getByRole('link', { name: 'Add your first server' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Phone test');
  await page.getByLabel('Game world URL').fill(world.url);
  await page.getByLabel('Account name or email').fill('ui-user');
  await page.locator('input[type="password"]').fill('secret');
  assert.ok(await page.getByText('Stored encrypted on this phone').isVisible());
  await page.getByText('Dry run: log what the bot would do').click(); // off: really click in the mock world
  await shot('2-add-server');
  await page.getByRole('button', { name: 'Add server' }).click();
  await page.waitForURL(/#\/servers\/\d+$/);
  const id = Number(page.url().match(/servers\/(\d+)/)[1]);

  await page.getByRole('button', { name: /Run now/ }).click();
  await page.getByRole('menuitem', { name: /Refresh villages/ }).or(page.getByText('Refresh villages')).first().click();
  await page.getByText(/Refresh villages: started/).waitFor();
  await until(async () => (await engine.api('GET', `/api/servers/${id}/events`)).body.some((e) => e.message === 'Action villages finished.'), 120_000, 'villages action');
  await page.getByRole('link', { name: 'Overview' }).click();
  await page.getByText('ui-user-Alpha').first().waitFor({ timeout: 15_000 });
  await shot('3-overview');

  await page.getByRole('link', { name: 'Logs' }).click();
  await page.getByText('Action villages finished.').waitFor({ timeout: 15_000 });
  await shot('4-logs');

  await page.getByRole('link', { name: 'Army' }).click();
  await shot('5-army');
  await page.getByRole('link', { name: 'Buildings' }).click();
  await shot('6-buildings');
  await page.getByRole('link', { name: 'Raiding' }).click();
  await shot('7-raiding');

  // A setting changed on the phone is saved in its SQLite database.
  await page.getByRole('link', { name: 'Settings' }).click();
  const field = page.getByLabel('Same target at most every (minutes)');
  await field.fill('14');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await page.getByText(/Saved/).first().waitFor();
  await shot('8-settings');
  const { body } = await engine.api('GET', `/api/servers/${id}`);
  assert.equal(body.config.raid.cycleMinutes, 14);
  const row = engine.db.prepare('select config from servers where id = ?').get(id);
  assert.equal(JSON.parse(row.config).raid.cycleMinutes, 14);

  // Start from the list: the account runs a round on the phone.
  await page.goto(`${ORIGIN}/index.html#/`);
  await page.getByRole('button', { name: 'Start' }).click();
  await until(async () => (await engine.api('GET', `/api/servers/${id}`)).body.status === 'sleeping', 240_000, 'a round');
  await page.reload();
  await page.getByText('Waiting').first().waitFor({ timeout: 20_000 });
  await shot('9-servers-running');
  await page.getByRole('button', { name: 'Stop' }).click();
  await until(async () => (await engine.api('GET', `/api/servers/${id}`)).body.status === 'stopped', 120_000, 'stop');
});
