import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const STATE_FILE = '.auth/state.json';
const SCREENSHOT_DIR = 'screenshots';
const RALLY_POINT = 39;

export const FIELD_TYPES = { 1: 'wood', 2: 'clay', 3: 'iron', 4: 'crop' };
const FIELD_NAMES = /^(Woodcutter|Clay Pit|Iron Mine|Cropland)\b/i;

export class CaptchaError extends Error {}

const toInt = (text) => {
  if (text == null) return null;
  const n = parseInt(String(text).replace(/[^\d-]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
};

export class Travian {
  constructor({ server, username, password, headless = true, dryRun = false, log = console.log }) {
    if (!server) throw new Error('TRAVIAN_SERVER is not set (e.g. https://ts1.x1.international.travian.com)');
    this.server = server.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.headless = headless;
    this.dryRun = dryRun;
    this.log = log;
  }

  async start() {
    this.browser = await chromium.launch({ headless: this.headless });
    const hasState = await fs.access(STATE_FILE).then(() => true, () => false);
    this.context = await this.browser.newContext({
      storageState: hasState ? STATE_FILE : undefined,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    this.page = await this.context.newPage();
    if (process.env.DEBUG_API) {
      this.page.on('request', (r) => {
        if (/\/api\//.test(r.url())) this.log(`API ${r.method()} ${r.url()} ${(r.postData() ?? '').slice(0, 800)}`);
      });
    }
  }

  async close() {
    await this.browser?.close();
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
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
    const file = path.join(SCREENSHOT_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.png`);
    await this.page.screenshot({ path: file, fullPage: true });
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
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await this.context.storageState({ path: STATE_FILE });
  }

  // Calls the same JSON endpoints the game's own pages use, with the logged-in session.
  async api(pathname, body) {
    const res = await this.page.evaluate(async ([url, payload]) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(payload),
      });
      return { status: r.status, text: await r.text() };
    }, [pathname, body]);
    if (res.status !== 200) throw new Error(`${pathname} returned ${res.status}: ${res.text.slice(0, 200)}`);
    return JSON.parse(res.text);
  }

  async graphql(query, variables = {}) {
    const res = await this.api('/api/v1/graphql', { query, variables });
    if (res.errors?.length) throw new Error(`GraphQL error: ${res.errors.map((e) => e.message).join('; ')}`);
    return res.data;
  }

  // All own villages with id, name, coordinates and population.
  async villages() {
    await this.goto('/profile');
    const pops = await this.page.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll('table.villages tbody tr')].map((tr) => [
        tr.querySelector('td.name a')?.textContent.trim(),
        tr.querySelector('td.inhabitants')?.textContent,
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
      did: toInt(v.did), name: v.name, x: coord(v.x), y: coord(v.y), population: toInt(pops[v.name]),
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
  // If resources are short, the missing part is first transferred from the hero's inventory.
  async upgrade(slotId, did) {
    const url = `/build.php?id=${slotId}`;
    const button = () => this.page.locator('.upgradeButtonsContainer .section1 button.green.build:not(.disabled)').first();
    await this.goto(url);
    if (!(await button().isVisible().catch(() => false)) && (await this.topUpFromHero(this.page.locator('#contract'), did))) {
      await this.goto(url);
    }
    return this.pressBuildButton(button(), `slot ${slotId}`, did);
  }

  // Constructs building `gid` on empty slot `slotId`, topping up from the hero like upgrade().
  // Returns false if it is not available.
  async construct(slotId, gid, category, did) {
    const url = `/build.php?id=${slotId}${category ? `&category=${category}` : ''}`;
    const button = () => this.page.locator(`button.green.new[onclick*="gid=${gid}&"]:not(.disabled)`).first();
    await this.goto(url);
    if (!(await button().isVisible().catch(() => false))
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

  // Map tiles in a 31x31 area centred on (x, y), as the game's map loads them.
  async mapTiles(x, y) {
    const res = await this.api('/api/v1/map/position', { data: { x, y, zoomLevel: 3, ignorePositions: [] } });
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
      slots{id isActive target{x y} troop{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10}}}}}`);
    return data.ownPlayer.farmLists;
  }

  async openFarmLists(did) {
    await this.switchVillage(did);
    await this.goto(`/build.php?id=${RALLY_POINT}&gid=16&tt=99`);
  }

  dialog() {
    return this.page.locator('.dialog, .dialogWrapper, #dialogContent').filter({ has: this.page.locator('button.save') }).last();
  }

  async fillTroops(scope, troops) {
    for (const [unit, amount] of Object.entries(troops)) {
      await scope.locator(`input[name="${unit}"]`).fill(String(amount));
    }
  }

  // Creates a farm list owned by village `did` and returns its id.
  async createFarmList({ did, villageName, name, troops }) {
    await this.openFarmLists(did);
    await this.page.locator('button.createFarmList').first().click();
    const dlg = this.dialog();
    await dlg.waitFor();
    await dlg.locator('input[name="listName"]').fill(name);
    await dlg.locator('select[name="villageId"]').selectOption({ label: villageName });
    await this.fillTroops(dlg, troops);
    await this.pause(300, 800);
    if (this.dryRun) {
      this.log(`[dry run] would create farm list "${name}" for ${villageName}`);
      await dlg.locator('button.cancel').click();
      return null;
    }
    await dlg.locator('button.save').click();
    await dlg.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    await this.pause();
    const list = (await this.farmLists()).find((l) => l.name === name && l.ownerVillage.id === did);
    if (!list) throw new Error(`Farm list "${name}" was not created for ${villageName}`);
    this.log(`Created farm list "${name}" (${list.id}) for ${villageName}.`);
    return list.id;
  }

  // Adds (x|y) to farm list `listId` through the "Add target" dialog. The farm list page must be open.
  async addFarmListTarget(listId, { x, y }, troops) {
    await this.page.getByText('Add target', { exact: false }).first().click();
    const dlg = this.dialog();
    await dlg.waitFor();
    await dlg.locator('select[name="listId"]').selectOption(String(listId));
    await dlg.locator('input[name="x"]').fill(String(x));
    await dlg.locator('input[name="y"]').fill(String(y));
    await this.pause(1200, 2000); // the dialog looks the target up
    await this.fillTroops(dlg, troops);
    if (this.dryRun) {
      this.log(`[dry run] would add (${x}|${y}) to farm list ${listId}`);
      await dlg.locator('button.cancel').click();
      return;
    }
    await dlg.locator('button.save').click();
    await dlg.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    await this.pause(500, 1200);
  }

  // Slot ids of a farm list that have a raid under way. The farm list page must be open.
  async runningSlots(listId) {
    const ids = await this.farmListWrapper(listId).evaluate((w) => [...w.querySelectorAll('tr.slot')]
      .filter((tr) => tr.querySelector('td.state i[class*="attack"]'))
      .map((tr) => tr.querySelector('input[name="selectOne"]')?.dataset.slotId));
    return new Set(ids.map(Number));
  }

  farmListWrapper(listId) {
    return this.page.locator('.farmListWrapper').filter({ has: this.page.locator(`[data-list="${listId}"]`) });
  }

  // Ticks exactly `slotIds` in one farm list and presses its Start button, which then sends only the
  // ticked targets. Never presses Start with nothing ticked (that would send the whole list) and
  // never uses "Start all farm lists". Returns the game's per-target results.
  async startFarmListTargets(listId, slotIds) {
    if (!slotIds.length) return [];
    const wrapper = this.farmListWrapper(listId);
    await this.dismissCookieBanner();
    for (const id of slotIds) {
      const box = wrapper.locator(`input[name="selectOne"][data-slot-id="${id}"]`);
      // A DOM click, so fixed overlays (cookie banner, footer) cannot swallow it.
      if (!(await box.isChecked())) await box.evaluate((el) => el.click());
      if (!(await box.isChecked())) throw new Error(`Farm list ${listId}: could not tick slot ${id}; not starting`);
      await this.pause(150, 400);
    }
    const button = wrapper.locator('.farmListHeader button.startFarmList');
    const label = (await button.innerText()).replace(/\s+/g, ' ').trim();
    if (label !== `Start (${slotIds.length})`) {
      throw new Error(`Farm list ${listId}: expected "Start (${slotIds.length})" but the button says "${label}"; not starting`);
    }
    if (this.dryRun) {
      this.log(`[dry run] would press "${label}" on farm list ${listId}`);
      return slotIds.map((id) => ({ id, error: null }));
    }
    const [response] = await Promise.all([
      this.page.waitForResponse((r) => r.url().includes('/api/v1/farm-list/send'), { timeout: 15_000 }),
      button.click(),
    ]);
    const body = await response.json().catch(() => ({}));
    await this.pause();
    return body.lists?.find((l) => l.id === listId)?.targets ?? [];
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
