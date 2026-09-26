import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const RALLY_POINT = 39;

export const FIELD_TYPES = { 1: 'wood', 2: 'clay', 3: 'iron', 4: 'crop' };
const FIELD_NAMES = /^(Woodcutter|Clay Pit|Iron Mine|Cropland)\b/i;

export class CaptchaError extends Error {}

const toInt = (text) => {
  if (text == null) return null;
  const n = parseInt(String(text).replace(/[^\d-]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
};

// Chromium settings that keep memory low (the backend runs on 1 GB VMs): no /dev/shm, GPU,
// extensions or background services, fewer renderer processes, and no images unless
// LOAD_IMAGES=true (the bot reads the page, it doesn't need to see it).
export function launchOptions({ headless = true, loadImages = /^(1|true|yes)$/i.test(process.env.LOAD_IMAGES ?? '') } = {}) {
  const args = [
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--no-first-run',
    '--mute-audio',
    '--renderer-process-limit=2',
    '--disable-site-isolation-trials',
    '--disable-features=site-per-process,IsolateOrigins,Translate,MediaRouter,OptimizationHints',
  ];
  if (!loadImages) args.push('--blink-settings=imagesEnabled=false');
  return { headless, args };
}

// How long a page load or click may take. The default Playwright 30s is too short on a small VM
// that is swapping, where a page can take a minute and still load.
export const pageTimeoutMs = () => Math.max(10, Number(process.env.PAGE_TIMEOUT_SECONDS) || 90) * 1000;

// Resolves to `fallback` if `promise` takes longer than `ms` (for cleanup that must not hang).
const within = (promise, ms, fallback = undefined) => Promise.race([
  promise,
  new Promise((resolve) => { setTimeout(() => resolve(fallback), ms).unref?.(); }),
]);

// Saved login (cookies) kept in a JSON file; the server keeps it in Postgres instead.
export const fileSession = (file = '.auth/state.json') => ({
  load: async () => JSON.parse(await fs.readFile(file, 'utf8').catch(() => 'null')),
  save: async (state) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(state));
  },
});

export class Travian {
  // `browser` lets several accounts share one Chromium (each gets its own context); `session`
  // loads and saves the login; `store` keeps small bits of bot state (see stores.js).
  constructor({
    server, username, password, headless = true, dryRun = false, log = console.log,
    browser = null, session = fileSession(), store = null, screenshotDir = 'screenshots',
  }) {
    if (!server) throw new Error('No Travian server URL (e.g. https://ts1.x1.international.travian.com)');
    this.server = server.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.headless = headless;
    this.dryRun = dryRun;
    this.log = log;
    this.sharedBrowser = browser;
    this.session = session;
    this.store = store;
    this.screenshotDir = screenshotDir;
  }

  async start() {
    this.browser = this.sharedBrowser ?? await chromium.launch(launchOptions({ headless: this.headless }));
    const storageState = await this.session.load().catch(() => null);
    this.context = await this.browser.newContext({
      storageState: storageState ?? undefined,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    this.context.setDefaultTimeout(pageTimeoutMs());
    this.context.setDefaultNavigationTimeout(pageTimeoutMs());
    this.page = await this.context.newPage();
    if (process.env.DEBUG_API) {
      this.page.on('request', (r) => {
        if (/\/api\//.test(r.url())) this.log(`API ${r.method()} ${r.url()} ${(r.postData() ?? '').slice(0, 800)}`);
      });
    }
  }

  async close() {
    // Keep the cookies the game refreshed during this session for the next one. Both steps are
    // bounded: a page that stopped responding must not keep the bot from starting over.
    if (this.context && this.loggedIn) {
      const state = await within(this.context.storageState().catch(() => null), 15_000, null);
      if (state) await this.session.save(state).catch(() => {});
    }
    await within(this.context?.close().catch(() => {}), 15_000);
    if (!this.sharedBrowser) await this.browser?.close();
  }

  // Random delay so actions are not fired back to back.
  async pause(minMs = 800, maxMs = 2200) {
    await this.page.waitForTimeout(minMs + Math.random() * (maxMs - minMs));
  }

  async goto(pathname) {
    await this.page.goto(`${this.server}${pathname}`, { waitUntil: 'domcontentloaded' });
    await this.pause();
    await this.checkCaptcha();
  }

  // Travian shows a CAPTCHA when it suspects a bot. Stop immediately instead of carrying on.
  async checkCaptcha() {
    const flagged = await this.page.evaluate(() => Boolean(document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"]'))
      || /CAPTCHA/.test(document.body?.innerText ?? ''));
    if (flagged) {
      const shot = await this.screenshot('captcha');
      throw new CaptchaError(`Travian is showing a CAPTCHA; stopping. See ${shot}`);
    }
  }

  async screenshot(name) {
    await fs.mkdir(this.screenshotDir, { recursive: true });
    const file = path.join(this.screenshotDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.png`);
    await this.page.screenshot({ path: file, fullPage: true, timeout: 20_000 });
    return file;
  }

  async isLoggedIn() {
    return this.page.locator('#stockBar, #resourceFieldContainer, #villageContent').first()
      .isVisible().catch(() => false);
  }

  async dismissCookieBanner() {
    const reject = this.page.getByRole('button', { name: /reject all/i });
    if (await reject.isVisible().catch(() => false)) {
      await reject.click();
      await this.pause(300, 800);
    }
  }

  async login() {
    await this.goto('/dorf1.php');
    if (!(await this.isLoggedIn())) {
      if (!this.username || !this.password) {
        throw new Error('TRAVIAN_USERNAME and TRAVIAN_PASSWORD must be set to log in');
      }
      await this.dismissCookieBanner();
      await this.page.fill('input[name="name"]', this.username);
      await this.pause(300, 900);
      await this.page.fill('input[name="password"]', this.password);
      await this.pause(300, 900);
      await this.page.click('button[type="submit"]');
      await this.page.waitForURL(/dorf[12]\.php/, { timeout: 30_000 }).catch(() => {});
      await this.pause();
      await this.checkCaptcha();
      if (!(await this.isLoggedIn())) {
        const shot = await this.screenshot('login-failed');
        throw new Error(`Login failed; see ${shot}`);
      }
      this.log('Logged in.');
    }
    await this.dismissCookieBanner();
    await this.session.save(await this.context.storageState());
    this.loggedIn = true;
  }

  // Calls the same JSON endpoints the game's own pages use, with the logged-in session. The game
  // reloads its page when a countdown on it ends, which cuts off a request made through it; with
  // `read` (a request that changes nothing) it is simply asked again. Orders are never repeated.
  async api(pathname, body, method = 'POST', { read = false } = {}) {
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await this.page.evaluate(async ([url, payload, verb]) => {
          const r = await fetch(url, {
            method: verb,
            headers: { 'content-type': 'application/json; charset=UTF-8' },
            body: JSON.stringify(payload),
          });
          return { status: r.status, text: await r.text() };
        }, [pathname, body, method]);
        break;
      } catch (err) {
        if (!read || attempt >= 3 || !/Execution context was destroyed|Failed to fetch|navigat/i.test(err.message)) throw err;
        await this.page.waitForLoadState('domcontentloaded').catch(() => {});
        await this.pause(500, 1000);
      }
    }
    if (res.status < 200 || res.status > 299) throw new Error(`${pathname} returned ${res.status}: ${res.text.slice(0, 200)}`);
    return res.text ? JSON.parse(res.text) : null;
  }

  // Queries only (the bot sends no GraphQL mutations), so they are safe to repeat.
  async graphql(query, variables = {}) {
    const res = await this.api('/api/v1/graphql', { query, variables }, 'POST', { read: true });
    if (res.errors?.length) throw new Error(`GraphQL error: ${res.errors.map((e) => e.message).join('; ')}`);
    return res.data;
  }

  // All own villages with id, name, coordinates, population and whether it is the capital.
  async villages() {
    await this.goto('/profile');
    const rows = await this.page.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll('table.villages tbody tr')].map((tr) => [
        tr.querySelector('td.name a')?.textContent.trim(),
        { population: tr.querySelector('td.inhabitants')?.textContent, capital: Boolean(tr.querySelector('td.name .additionalInfo')) },
      ]),
    ));
    const list = await this.page.evaluate(() => [...document.querySelectorAll('.villageList .listEntry')].map((e) => ({
      did: e.dataset.did,
      name: e.querySelector('.name')?.textContent.trim(),
      x: e.querySelector('.coordinateX')?.textContent,
      y: e.querySelector('.coordinateY')?.textContent,
    })));
    const coord = (t) => toInt(String(t).replace(/−/g, '-'));
    return list.map((v) => ({
      did: toInt(v.did),
      name: v.name,
      x: coord(v.x),
      y: coord(v.y),
      population: toInt(rows[v.name]?.population),
      capital: Boolean(rows[v.name]?.capital),
    }));
  }

  async switchVillage(did) {
    await this.goto(`/dorf1.php?newdid=${did}`);
  }

  // Resource overview (dorf1) of the active village: stock, storage, production, fields and build queue.
  async status() {
    await this.goto('/dorf1.php');
    const raw = await this.page.evaluate(() => {
      const text = (sel) => document.querySelector(sel)?.textContent ?? null;
      const js = typeof window.resources === 'object' ? window.resources : null;
      const fields = [...document.querySelectorAll('#resourceFieldContainer a[href*="build.php"]')].map((a) => {
        const cls = a.getAttribute('class') ?? '';
        return {
          id: new URL(a.href).searchParams.get('id') ?? cls.match(/buildingSlot(\d+)/)?.[1],
          gid: cls.match(/\bgid(\d+)\b/)?.[1],
          level: cls.match(/\blevel(\d+)\b/)?.[1] ?? a.textContent,
          canBuild: /\bgood\b/.test(cls),
          underConstruction: /underConstruction/.test(cls),
          maxLevel: /maxLevel/.test(cls),
        };
      });
      const queue = [...document.querySelectorAll('.buildingList li')].map((li) => ({
        name: li.querySelector('.name')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
        secondsLeft: li.querySelector('.timer')?.getAttribute('value') ?? null,
      }));
      return {
        did: document.querySelector('.villageInput')?.dataset.did ?? null,
        village: document.querySelector('.villageInput')?.value ?? null,
        population: text('#sidebarBoxActiveVillage .population span'),
        roman: /\btribe1\b/.test(document.querySelector('#resourceFieldContainer')?.className ?? ''),
        stock: js?.storage ?? { l1: text('#l1'), l2: text('#l2'), l3: text('#l3'), l4: text('#l4') },
        maxStorage: js?.maxStorage ?? {
          l1: text('.warehouse .capacity .value'), l2: text('.warehouse .capacity .value'),
          l3: text('.warehouse .capacity .value'), l4: text('.granary .capacity .value'),
        },
        production: js?.production ?? null,
        fields,
        queue,
      };
    });

    const byType = (obj) => obj && Object.fromEntries(
      Object.entries(FIELD_TYPES).map(([i, name]) => [name, toInt(obj[`l${i}`])]),
    );
    return {
      did: toInt(raw.did),
      village: raw.village?.trim() || null,
      population: toInt(raw.population),
      roman: raw.roman,
      stock: byType(raw.stock),
      maxStorage: byType(raw.maxStorage),
      production: byType(raw.production),
      fields: raw.fields
        .map((f) => ({
          ...f, id: toInt(f.id), gid: toInt(f.gid), level: toInt(f.level), type: FIELD_TYPES[toInt(f.gid)],
        }))
        .filter((f) => f.id && f.type),
      queue: raw.queue.map((q) => ({ ...q, secondsLeft: toInt(q.secondsLeft), isField: FIELD_NAMES.test(q.name ?? '') })),
    };
  }

  // Village centre (dorf2) of the active village: every building slot with its building and state.
  async buildings() {
    await this.goto('/dorf2.php');
    const slots = await this.page.evaluate(() => [...document.querySelectorAll('#villageContent .buildingSlot')].map((d) => {
      const cls = d.querySelector('a')?.getAttribute('class') ?? '';
      return {
        id: d.dataset.aid,
        gid: d.dataset.gid,
        name: d.dataset.name || null,
        level: d.querySelector('.labelLayer')?.textContent ?? '0',
        canBuild: /\bgood\b/.test(cls),
        underConstruction: /underConstruction/.test(cls),
        maxLevel: /maxLevel/.test(cls),
      };
    }));
    const seen = new Set();
    return slots
      .map((s) => ({ ...s, id: toInt(s.id), gid: toInt(s.gid), level: toInt(s.level) ?? 0 }))
      .filter((s) => s.id && !seen.has(s.id) && seen.add(s.id));
  }

  // Opens a slot and presses the green upgrade button. Returns false if it cannot be built now.
  // Only the plain green button is used, never gold (paid) or video-bonus buttons.
  // If resources are short and `hero` is on, the missing part is first transferred from the
  // hero's inventory.
  async upgrade(slotId, did, { hero = true } = {}) {
    const url = `/build.php?id=${slotId}`;
    const button = () => this.page.locator('.upgradeButtonsContainer .section1 button.green.build:not(.disabled)').first();
    await this.goto(url);
    if (hero && !(await button().isVisible().catch(() => false)) && (await this.topUpFromHero(this.page.locator('#contract'), did))) {
      await this.goto(url);
    }
    return this.pressBuildButton(button(), `slot ${slotId}`, did);
  }

  // Constructs building `gid` on empty slot `slotId`, topping up from the hero like upgrade().
  // Returns false if it is not available.
  async construct(slotId, gid, category, did, { hero = true } = {}) {
    const url = `/build.php?id=${slotId}${category ? `&category=${category}` : ''}`;
    const button = () => this.page.locator(`button.green.new[onclick*="gid=${gid}&"]:not(.disabled)`).first();
    await this.goto(url);
    if (hero && !(await button().isVisible().catch(() => false))
      && (await this.topUpFromHero(this.page.locator(`#contract_building${gid} #contract`), did))) {
      await this.goto(url);
    }
    return this.pressBuildButton(button(), `building ${gid} on slot ${slotId}`, did);
  }

  // A build page marks the resources a job is short of; clicking one opens the game's own
  // "transfer from hero" dialog pre-filled with the shortfall. Returns true if anything was moved.
  async topUpFromHero(contract, did) {
    const lacking = contract.locator('.inlineIcon.resource.transfer.fillUp').first();
    if (!(await lacking.isVisible().catch(() => false))) return false;
    const active = toInt(await this.page.locator('.villageInput').first().getAttribute('data-did').catch(() => null));
    if (did != null && active !== did) throw new Error(`Refusing hero transfer: village ${active} is active, expected ${did}`);
    if (this.dryRun) {
      this.log('[dry run] would transfer the missing resources from the hero');
      return false;
    }
    await lacking.click();
    const dlg = this.page.locator('.dialog, .dialogWrapper, #dialogContent').filter({ has: this.page.locator('input[name="lumber"]') }).last();
    await dlg.waitFor({ timeout: 10_000 });
    await this.pause(600, 1200);
    const amounts = await dlg.evaluate((d) => Object.fromEntries(['lumber', 'clay', 'iron', 'crop']
      .map((n) => [n, Number((d.querySelector(`input[name="${n}"]`)?.value ?? '').replace(/\D/g, '')) || 0])));
    // "Transfer" or "Transfer selected", never "Transfer maximum".
    const transfer = dlg.locator('button').filter({ hasText: /^\s*Transfer( selected)?\s*$/ }).first();
    if (!Object.values(amounts).some(Boolean) || (await transfer.isDisabled())) {
      this.log('The hero has nothing to cover the shortfall.');
      await this.page.keyboard.press('Escape');
      return false;
    }
    await Promise.all([
      this.page.waitForResponse((r) => r.url().includes('/hero/v2/inventory/use-item') && r.request().method() === 'POST', { timeout: 15_000 }),
      transfer.click(),
    ]);
    await this.pause(1500, 2500);
    this.log(`Transferred from hero: ${Object.entries(amounts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}.`);
    return true;
  }

  // `did` is the village the click is meant for; refuse if a different village is active.
  async pressBuildButton(button, what, did) {
    const active = toInt(await this.page.locator('.villageInput').first().getAttribute('data-did').catch(() => null));
    if (did != null && active !== did) throw new Error(`Refusing to build ${what}: village ${active} is active, expected ${did}`);
    if (!(await button.isVisible().catch(() => false))) return false;
    const onclick = (await button.getAttribute('onclick')) ?? '';
    if (!/action=build/.test(onclick) || /gold/.test((await button.getAttribute('class')) ?? '')) return false;
    const label = (await button.textContent())?.replace(/\s+/g, ' ').trim();
    if (this.dryRun) {
      this.log(`[dry run] would click "${label}" for ${what}`);
      return true;
    }
    await button.click();
    await this.page.waitForURL(/dorf[12]\.php/, { timeout: 15_000 }).catch(() => {});
    await this.pause();
    this.log(`Clicked "${label}" for ${what}.`);
    return true;
  }

  // Downloads a text file from the game world (for example /map.sql) with the browser session.
  async fetchText(pathname) {
    if (!this.page.url().startsWith(this.server)) await this.goto('/dorf1.php');
    const res = await this.page.evaluate(async (url) => {
      const r = await fetch(url);
      return { status: r.status, text: await r.text() };
    }, pathname);
    if (res.status !== 200) throw new Error(`${pathname} returned ${res.status}`);
    return res.text;
  }

  // Stock, free merchants and merchant movements of every own village, in one request.
  async economy() {
    const data = await this.graphql(`{ownPlayer{villages{id name
      resources{lumberStock clayStock ironStock cropStock}
      marketplace{merchantsInfo{total capacity available}
        merchantsMovements{edges{node{type cancelled to{id} carriedResources{lumber clay iron crop}}}}}}}}`);
    return data.ownPlayer.villages.map((v) => ({
      did: v.id,
      name: v.name,
      stock: {
        wood: v.resources.lumberStock, clay: v.resources.clayStock, iron: v.resources.ironStock, crop: v.resources.cropStock,
      },
      merchants: v.marketplace?.merchantsInfo ?? { total: 0, capacity: 0, available: 0 },
      outgoing: (v.marketplace?.merchantsMovements?.edges ?? []).map((e) => e.node)
        .filter((n) => n.type === 'OUTGOING' && !n.cancelled)
        .map((n) => ({
          to: n.to.id,
          resources: {
            wood: n.carriedResources.lumber, clay: n.carriedResources.clay, iron: n.carriedResources.iron, crop: n.carriedResources.crop,
          },
        })),
    }));
  }

  // Sends resources with merchants from the active village to (x|y) through the marketplace form.
  async sendResources(did, { x, y }, amounts) {
    await this.goto('/build.php?gid=17&t=5');
    const active = toInt(await this.page.locator('.villageInput').first().getAttribute('data-did').catch(() => null));
    if (active !== did) throw new Error(`Refusing to send resources: village ${active} is active, expected ${did}`);
    const form = this.page.locator('#content');
    await form.locator('input[name="x"]').fill(String(x));
    await form.locator('input[name="y"]').fill(String(y));
    const names = { wood: 'lumber', clay: 'clay', iron: 'iron', crop: 'crop' };
    for (const [key, name] of Object.entries(names)) {
      await form.locator(`input[name="${name}"]`).fill(String(amounts[key] ?? 0));
      await this.pause(200, 500);
    }
    if (this.dryRun) {
      this.log(`[dry run] would send ${JSON.stringify(amounts)} to (${x}|${y})`);
      return true;
    }
    const [response] = await Promise.all([
      this.page.waitForResponse((r) => r.url().includes('/marketplace/resources/send') && r.request().method() === 'POST', { timeout: 15_000 }),
      form.locator('button.send:not(.disabled)').click(),
    ]);
    await this.pause();
    return response.ok();
  }

  // Own troops at home in every village, keyed by village id.
  async villageTroops() {
    const data = await this.graphql(`{ownPlayer{villages{id troops{ownTroopsAtTown{units{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10}}}}}}`);
    return new Map(data.ownPlayer.villages.map((v) => [v.id, v.troops?.ownTroopsAtTown?.units ?? {}]));
  }

  // Training page of military building `gid` in village `did`: stock, net production, the queue's
  // remaining seconds and, for `unit`, its cost, upkeep, seconds per unit and the game's max.
  // Returns null when the village has no such building or cannot train the unit.
  async trainingInfo(did, gid, unit) {
    await this.goto(`/build.php?newdid=${did}&gid=${gid}`);
    const info = await this.page.evaluate((unitId) => {
      const block = document.querySelector(`.trainUnits .innerTroopWrapper[data-troopid="${unitId}"]`);
      const values = [...(block?.querySelectorAll('.resourceWrapper .value') ?? [])].map((e) => e.textContent);
      const js = typeof window.resources === 'object' ? window.resources : null;
      return {
        active: document.querySelector('.villageInput')?.dataset.did ?? null,
        hasForm: Boolean(document.querySelector('.trainUnits')),
        block: Boolean(block?.querySelector(`input[name="${unitId}"]`)),
        name: [...(block?.querySelectorAll('.tit a') ?? [])].map((a) => a.textContent.trim()).filter(Boolean).pop() ?? null,
        cost: values.slice(0, 4),
        upkeep: values[4] ?? null,
        duration: block?.querySelector('.inlineIcon.duration .value')?.textContent ?? null,
        max: block?.querySelector('.cta a')?.textContent ?? null,
        queue: [...document.querySelectorAll('table.under_progress td.dur .timer')].map((t) => t.getAttribute('value')),
        stock: js?.storage ?? null,
        production: js?.production ?? null,
      };
    }, unit);
    if (toInt(info.active) !== did) throw new Error(`Expected village ${did} to be active, got ${info.active}`);
    if (!info.hasForm || !info.block) return null;
    const seconds = (t) => (t ?? '0:0:0').split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
    const res = (o) => ({ wood: toInt(o?.l1), clay: toInt(o?.l2), iron: toInt(o?.l3), crop: toInt(o?.l4) });
    const [wood, clay, iron, crop] = info.cost.map(toInt);
    return {
      name: info.name,
      cost: { wood, clay, iron, crop },
      upkeep: toInt(info.upkeep) ?? 1,
      unitSeconds: seconds(info.duration),
      max: toInt(info.max) ?? 0,
      queueSeconds: Math.max(0, ...info.queue.map(toInt)),
      stock: res(info.stock),
      production: res(info.production),
    };
  }

  // Net crop production per hour of village `did`.
  async netCrop(did) {
    await this.goto(`/dorf1.php?newdid=${did}`);
    return toInt(await this.page.evaluate(() => window.resources?.production?.l4 ?? null)) ?? 0;
  }

  // Trains `amount` of `unit` on the training page opened by trainingInfo().
  async train(did, unit, amount) {
    const active = toInt(await this.page.locator('.villageInput').first().getAttribute('data-did').catch(() => null));
    if (active !== did) throw new Error(`Refusing to train: village ${active} is active, expected ${did}`);
    if (this.dryRun) {
      this.log(`[dry run] would train ${amount} ${unit}`);
      return true;
    }
    await this.page.locator(`.trainUnits .innerTroopWrapper[data-troopid="${unit}"] input[name="${unit}"]`).fill(String(amount));
    await this.pause(400, 900);
    await Promise.all([
      this.page.waitForLoadState('domcontentloaded'),
      this.page.locator('#content button.startTraining').first().click(),
    ]);
    await this.pause();
    return true;
  }

  // The account's tribe: 1 Romans, 2 Teutons, 3 Gauls, 6 Egyptians, 7 Huns, 8 Spartans, 9 Vikings.
  async tribe() {
    const data = await this.graphql('{ ownPlayer { tribeId } }');
    return toInt(data?.ownPlayer?.tribeId);
  }

  // What the Academy of village `did` can still research. Each unit is ready (its requirements
  // are met; canResearch when the Research button is enabled) or waits for the buildings in
  // `missing`. Researched units are not listed. `busy` while a research is running. null when
  // the village has no Academy.
  async academy(did) {
    await this.goto(`/build.php?newdid=${did}&gid=22`);
    const info = await this.page.evaluate(() => ({
      active: document.querySelector('.villageInput')?.dataset.did ?? null,
      isAcademy: Boolean(document.querySelector('#build.gid22')),
      busy: Boolean(document.querySelector('#build table.under_progress')),
      units: [...document.querySelectorAll('#build .researches .research')].map((r) => {
        const img = r.querySelector('img.unit');
        const n = /\bu(\d+)\b/.exec(img?.className ?? '')?.[1];
        const button = [...r.querySelectorAll('button.green')]
          .find((b) => !b.disabled && !b.classList.contains('disabled') && !b.classList.contains('purple'));
        return {
          unit: n ? `t${n}` : null,
          name: img?.getAttribute('alt') ?? null,
          ready: !r.closest('#researchFuture'),
          canResearch: Boolean(button),
          missing: [...r.querySelectorAll('.requirements .error')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
        };
      }),
    }));
    if (toInt(info.active) !== did) throw new Error(`Expected village ${did} to be active, got ${info.active}`);
    if (!info.isAcademy) return null;
    return { busy: info.busy, units: info.units.filter((u) => u.unit) };
  }

  // The link a green Academy or Smithy button opens (its onclick sets window.location), accepted
  // only when it is a build.php `action` for `unit`.
  linkFrom(onclick, action, unit) {
    const href = /location\.href\s*=\s*'([^']+)'/.exec(onclick ?? '')?.[1]?.replace(/&amp;/g, '&');
    if (!href) return null;
    const url = new URL(href, this.server);
    if (url.origin !== new URL(this.server).origin || url.pathname !== '/build.php') return null;
    if (url.searchParams.get('action') !== action || url.searchParams.get('t') !== unit) return null;
    return `${url.pathname}${url.search}`;
  }

  // Starts researching `unit` on the Academy page academy() opened. Only the plain green Research
  // button of that unit is used (never the video or building-upgrade buttons).
  async research(did, unit) {
    const active = toInt(await this.page.locator('.villageInput').first().getAttribute('data-did').catch(() => null));
    if (active !== did) throw new Error(`Refusing to research: village ${active} is active, expected ${did}`);
    const n = Number(String(unit).replace(/^t/, ''));
    const button = this.page.locator(`#build .researches .research:has(img.unit.u${n}) button.green:not(.disabled):not(.purple)`).first();
    if (!(await button.isVisible().catch(() => false))) return false;
    if (this.dryRun) {
      this.log(`[dry run] would research ${unit}`);
      return true;
    }
    await Promise.all([this.page.waitForLoadState('domcontentloaded'), button.click()]);
    await this.pause();
    return true;
  }

  // Village `did`'s Smithy: its level, whether an upgrade is running, and each unit it can
  // improve with the unit's level and the link of its plain green Improve button (null when the
  // unit cannot be improved right now). Returns null if the village has no Smithy.
  async smithy(did) {
    await this.goto(`/build.php?newdid=${did}&gid=13`);
    const info = await this.page.evaluate(() => {
      const build = document.querySelector('#build.gid13');
      return {
        active: document.querySelector('.villageInput')?.dataset.did ?? null,
        level: build ? Number(/\blevel(\d+)\b/.exec(build.className)?.[1] ?? 0) : null,
        running: [...document.querySelectorAll('#build table.under_progress tbody tr')]
          .map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean),
        runningSeconds: Number(document.querySelector('#build table.under_progress .timer')?.getAttribute('value') ?? NaN),
        units: [...document.querySelectorAll('#build .researches .research')].map((r) => {
          const img = r.querySelector('img.unit');
          const button = [...r.querySelectorAll('button.green')]
            .find((b) => !b.disabled && !b.classList.contains('disabled') && !b.classList.contains('purple') && !b.classList.contains('gold'));
          return {
            n: /\bu(\d+)\b/.exec(img?.className ?? '')?.[1] ?? null,
            name: img?.getAttribute('alt') ?? null,
            level: Number(/(\d+)/.exec(r.querySelector('.title .level')?.textContent ?? '')?.[1] ?? NaN),
            onclick: button?.getAttribute('onclick') ?? null,
            note: r.querySelector('.errorMessage, .upgradeBlocked, .none, .contractText')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
          };
        }),
      };
    });
    if (toInt(info.active) !== did) throw new Error(`Expected village ${did} to be active, got ${info.active}`);
    if (info.level == null) return null;
    const seconds = (n) => (Number.isFinite(n) ? n : null);
    const units = info.units.filter((u) => u.n && Number.isFinite(u.level)).map((u) => ({
      unit: `t${u.n}`,
      name: u.name,
      level: u.level,
      note: u.note,
      link: this.linkFrom(u.onclick, 'research', `t${u.n}`),
    }));
    return {
      level: info.level, busy: info.running.length > 0, running: info.running, runningSeconds: seconds(info.runningSeconds), units,
    };
  }

  // Improves `unit` in the Smithy smithy() opened, by opening its Improve link (the request the
  // button sends) and waiting for the page. Returns true once the Smithy shows the upgrade
  // running, or at least no longer offers to start it.
  async improve(did, unit, link) {
    const active = toInt(await this.page.locator('.villageInput').first().getAttribute('data-did').catch(() => null));
    if (active !== did) throw new Error(`Refusing to improve: village ${active} is active, expected ${did}`);
    const checked = this.linkFrom(`location.href = '${link}'`, 'research', unit);
    if (!checked || new URL(checked, this.server).searchParams.get('gid') !== '13') throw new Error(`Not a Smithy link for ${unit}: ${link}`);
    if (this.dryRun) {
      this.log(`[dry run] would improve ${unit} in the Smithy`);
      return true;
    }
    await this.goto(checked);
    if ((await this.page.locator('#build.gid13 table.under_progress').count()) > 0) return true;
    const n = unit.replace(/^t/, '');
    const offered = this.page.locator(`#build.gid13 .researches .research:has(img.unit.u${n}) button.green:not(.disabled):not(.purple):not(.gold)`);
    return (await this.page.locator('#build.gid13').count()) > 0 && (await offered.count()) === 0;
  }

  // The hero: alive, health, home village, where it is now and the adventures open to it, with
  // the query the game's adventure page uses (no page load).
  async heroStatus() {
    const data = await this.graphql(`{ownPlayer{hero{isAlive health isRegenerating
      homeVillage{id name x y}
      status{status inVillage{id name} arrivalIn onWayTo{x y}}
      adventures{number mapId x y distance difficulty travelingDuration}}}}`);
    const h = data.ownPlayer.hero;
    const where = h.status?.inVillage;
    return {
      isAlive: Boolean(h.isAlive),
      health: h.health ?? 0,
      homeVillage: h.homeVillage,
      home: Boolean(where && h.homeVillage && where.id === h.homeVillage.id && !h.status?.onWayTo),
      away: where && where.id !== h.homeVillage?.id ? `in ${where.name}` : h.status?.onWayTo ? `on the way to (${h.status.onWayTo.x}|${h.status.onWayTo.y})` : null,
      adventures: h.adventures ?? [],
    };
  }

  // The hero's fighting strength and whether it rides (a horse makes it fight as cavalry).
  async heroPower() {
    const res = await this.api('/api/v1/hero/v2/screen/attributes', undefined, 'GET', { read: true });
    return { power: res?.hero?.attributes?.power?.value ?? null, mounted: Boolean(res?.hero?.equipment?.horse) };
  }

  // Sends the hero on adventure `number` with the two requests the adventure page sends: a
  // preview that returns a one-time nonce, then the order with that nonce.
  async startAdventure(number) {
    const payload = { action: 'troopsSend', eventType: 50, troops: [{ t11: 1 }], target: { adventureId: number } };
    if (this.dryRun) {
      this.log(`[dry run] would send the hero on adventure ${number}`);
      return null;
    }
    const res = await this.page.evaluate(async (body) => {
      const headers = { 'content-type': 'application/json; charset=UTF-8' };
      const preview = await fetch('/api/v1/troop/send', { method: 'PUT', headers, body: JSON.stringify(body) });
      const nonce = preview.headers.get('x-nonce');
      const previewText = await preview.text();
      if (!preview.ok || !nonce) return { error: `preview returned ${preview.status}: ${previewText.slice(0, 200)}` };
      const sent = await fetch('/api/v1/troop/send', { method: 'POST', headers: { ...headers, 'X-Nonce': nonce }, body: JSON.stringify(body) });
      const text = await sent.text();
      return sent.ok ? { result: text ? JSON.parse(text) : {} } : { error: `send returned ${sent.status}: ${text.slice(0, 200)}` };
    }, payload);
    if (res.error) throw new Error(`Adventure ${number}: ${res.error}`);
    await this.pause();
    return { arrivalIn: res.result?.troops?.[0]?.arrivalIn ?? null };
  }

  // Sends the hero alone from village `did` to raid (or attack) the unoccupied oasis at (x|y),
  // through the rally point. The confirmation page must show exactly that before it is confirmed:
  // the raid type, the target, only the hero, from this village, against an unoccupied oasis.
  async sendHeroTo(did, { x, y }, mode = 'raid') {
    const eventType = mode === 'attack' ? '3' : '4';
    await this.goto(`/build.php?newdid=${did}&id=${RALLY_POINT}&gid=16&tt=2`);
    const active = toInt(await this.page.locator('.villageInput').first().getAttribute('data-did').catch(() => null));
    if (active !== did) throw new Error(`Refusing to send the hero: village ${active} is active, expected ${did}`);
    const hero = this.page.locator('input[name="troop[t11]"]');
    if (!(await hero.count()) || (await hero.isDisabled())) throw new Error('The hero is not available in the rally point');
    await hero.fill('1');
    await this.page.fill('input[name="x"]', String(x));
    await this.page.fill('input[name="y"]', String(y));
    await this.page.check(`input[name="eventType"][value="${eventType}"]`);
    await this.pause(400, 900);
    // Wait for the confirmation page itself (the current page is already loaded).
    await Promise.all([this.page.waitForEvent('domcontentloaded'), this.page.click('button[name="ok"]')]);
    await this.page.locator('table.troop_details .troopHeadline').first().waitFor();
    await this.pause();
    const order = await this.page.evaluate(() => ({
      headline: document.querySelector('table.troop_details .troopHeadline')?.textContent.trim() ?? '',
      fields: Object.fromEntries([...document.querySelectorAll('form input[type="hidden"]')].map((i) => [i.name, i.value])),
    }));
    const f = order.fields;
    const onlyHero = Array.from({ length: 10 }, (_, i) => f[`troops[0][t${i + 1}]`]).every((v) => v === '0') && f['troops[0][t11]'] === '1';
    const problems = [
      !/unoccupied oasis/i.test(order.headline) && `the order reads "${order.headline}"`,
      f.eventType !== eventType && `event type ${f.eventType}`,
      (f.x !== String(x) || f.y !== String(y)) && `target (${f.x}|${f.y})`,
      !onlyHero && 'troops other than the hero',
      f['troops[0][villageId]'] !== String(did) && `from village ${f['troops[0][villageId]']}`,
    ].filter(Boolean);
    if (problems.length) throw new Error(`Refusing to confirm the hero's raid: ${problems.join(', ')}`);
    if (this.dryRun) {
      this.log(`[dry run] would confirm "${order.headline}" at (${x}|${y}) with the hero`);
      await this.goto('/dorf1.php');
      return;
    }
    await Promise.all([this.page.waitForEvent('domcontentloaded'), this.page.click('#confirmSendTroops')]);
    await this.pause();
  }

  // Sends `troops` from village `did` as reinforcement to (x|y). The confirmation page must say
  // "Reinforcement" before it is confirmed. Returns the arrival time in ms, or null.
  async sendReinforcement(did, { x, y }, troops) {
    await this.goto(`/build.php?newdid=${did}&id=${RALLY_POINT}&gid=16&tt=2`);
    const active = toInt(await this.page.locator('.villageInput').first().getAttribute('data-did').catch(() => null));
    if (active !== did) throw new Error(`Refusing to send troops: village ${active} is active, expected ${did}`);
    for (const [unit, n] of Object.entries(troops)) await this.page.fill(`input[name="troop[${unit}]"]`, String(n));
    await this.page.fill('input[name="x"]', String(x));
    await this.page.fill('input[name="y"]', String(y));
    await this.page.check('input[name="eventType"][value="5"]');
    await this.pause(400, 900);
    await Promise.all([this.page.waitForLoadState('domcontentloaded'), this.page.click('button[name="ok"]')]);
    await this.pause();
    const headline = (await this.page.locator('table.troop_details .troopHeadline').first().innerText().catch(() => '')).trim();
    if (!/^Reinforcement/i.test(headline)) throw new Error(`Refusing to confirm troops: the order reads "${headline}"`);
    const arrivalText = await this.page.locator('#content').innerText();
    const m = arrivalText.match(/In (\d+):(\d+):(\d+) hours/);
    const arrival = Date.now() + (m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : 0);
    if (this.dryRun) {
      this.log(`[dry run] would confirm "${headline}"`);
      return arrival;
    }
    await Promise.all([this.page.waitForLoadState('domcontentloaded'), this.page.click('#confirmSendTroops')]);
    await this.pause();
    return arrival;
  }

  // Changes farm list slots with the request the "Edit target" dialog sends, in batches.
  // `slots` are { id, listId, x, y, troops }.
  async updateFarmListSlots(slots) {
    for (let i = 0; i < slots.length; i += 50) {
      const batch = slots.slice(i, i + 50);
      if (this.dryRun) {
        this.log(`[dry run] would update ${batch.length} farm list targets`);
        continue;
      }
      await this.api('/api/v1/farm-list/slot', {
        slots: batch.map((s) => ({
          listId: s.listId,
          x: s.x,
          y: s.y,
          units: Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`t${k + 1}`, s.troops[`t${k + 1}`] ?? 0])),
          active: true,
          abandoned: false,
          id: s.id,
        })),
      }, 'PUT');
      await this.pause(1000, 2000);
    }
  }

  // Deletes farm list slots with the request the list's "Delete" menu entry sends.
  async deleteFarmListSlots(slotIds) {
    if (!slotIds.length) return;
    if (this.dryRun) {
      this.log(`[dry run] would delete ${slotIds.length} farm list targets`);
      return;
    }
    await this.api('/api/v1/farm-list/slot', { slots: slotIds, abandoned: false }, 'DELETE');
    await this.pause();
  }

  // Adds targets to a farm list with the same request the "Add target" dialog sends, in batches.
  async addFarmListSlots(listId, targets, troops) {
    const units = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i + 1}`, troops[`t${i + 1}`] ?? 0]));
    for (let i = 0; i < targets.length; i += 20) {
      const batch = targets.slice(i, i + 20);
      if (this.dryRun) {
        this.log(`[dry run] would add ${batch.length} targets to farm list ${listId}`);
        continue;
      }
      await this.api('/api/v1/farm-list/slot', {
        slots: batch.map((t) => ({ listId, x: t.x, y: t.y, units, active: true, abandoned: false })),
      });
      await this.pause(1000, 2500);
    }
  }

  // Map tiles in a 31x31 area centred on (x, y), as the game's map loads them.
  async mapTiles(x, y) {
    const res = await this.api('/api/v1/map/position', { data: { x, y, zoomLevel: 3, ignorePositions: [] } }, 'POST', { read: true });
    return new Map(res.tiles.map((t) => [`${t.position.x}|${t.position.y}`, t]));
  }

  // Own troops currently at home in the active village, read from the send-troops form.
  async troopsAtHome() {
    await this.goto(`/build.php?id=${RALLY_POINT}&gid=16&tt=2`);
    const raw = await this.page.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll('input[name^="troop[t"]')].map((input) => [
        input.name.match(/t\d+/)[0],
        input.closest('td')?.innerText.match(/\/\s*([\d,.\s‬‭]+)/)?.[1] ?? '0',
      ]),
    ));
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, toInt(v) ?? 0]));
  }

  async farmLists() {
    const data = await this.graphql(`{ownPlayer{farmLists{id name
      ownerVillage{id name troops{ownTroopsAtTown{units{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10}}}}
      slots{id isActive isRunning target{x y} troop{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10}}}}}`);
    return data.ownPlayer.farmLists;
  }

  // Creates a farm list owned by village `did` and returns its id, with the request the game's
  // "Create farm list" dialog sends. Going through the API skips the farm list page, which with
  // many lists is too heavy for a small VM to render in time.
  async createFarmList({ did, villageName, name, troops }) {
    if (name.length > 30) throw new Error(`Farm list name "${name}" is longer than the game's 30 characters`);
    if (this.dryRun) {
      this.log(`[dry run] would create farm list "${name}" for ${villageName}`);
      return null;
    }
    const defaultUnits = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i + 1}`, troops[`t${i + 1}`] ?? 0]));
    const res = await this.api('/api/v1/farm-list', {
      villageId: Number(did), name, defaultUnits, useShip: false, onlyLosses: false,
    });
    await this.pause();
    const list = (await this.farmLists()).find((l) => (res?.id != null ? l.id === res.id : l.name === name && l.ownerVillage.id === Number(did)));
    if (!list) throw new Error(`Farm list "${name}" was not created for ${villageName}`);
    this.log(`Created farm list "${name}" (${list.id}) for ${villageName}.`);
    return list.id;
  }

  // Starts exactly `slotIds` of farm list `listId`, with the request its Start button sends when
  // those slots are ticked. Returns the game's per-target results.
  async startFarmListTargets(listId, slotIds) {
    if (!slotIds.length) return [];
    if (this.dryRun) {
      this.log(`[dry run] would start ${slotIds.length} targets of farm list ${listId}`);
      return slotIds.map((id) => ({ id, error: null }));
    }
    const res = await this.api('/api/v1/farm-list/send', { action: 'farmList', lists: [{ id: listId, targets: slotIds }] });
    await this.pause();
    return res?.lists?.find((l) => l.id === listId)?.targets ?? [];
  }
}

export function formatStatus(s) {
  const res = Object.keys(s.stock ?? {}).map((k) => {
    const prod = s.production?.[k] != null ? ` (+${s.production[k]}/h)` : '';
    return `${k} ${s.stock[k] ?? '?'}/${s.maxStorage?.[k] ?? '?'}${prod}`;
  });
  const levels = Object.values(FIELD_TYPES).map((t) => {
    const lv = s.fields.filter((f) => f.type === t).map((f) => f.level);
    return `${t} [${lv.join(',')}]`;
  });
  const queue = s.queue.length
    ? s.queue.map((q) => `${q.name}${q.secondsLeft != null ? ` (${Math.ceil(q.secondsLeft / 60)} min)` : ''}`).join('; ')
    : 'empty';
  return [
    `Village: ${s.village ?? 'unknown'} (population ${s.population ?? '?'})`,
    `Resources: ${res.join(' | ')}`,
    `Fields: ${levels.join(' ')}`,
    `Queue: ${queue}`,
  ].join('\n');
}
