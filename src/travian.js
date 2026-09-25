import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const STATE_FILE = '.auth/state.json';
const SCREENSHOT_DIR = 'screenshots';

export const FIELD_TYPES = { 1: 'wood', 2: 'clay', 3: 'iron', 4: 'crop' };

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
  }

  async close() {
    await this.browser?.close();
  }

  // Random human-ish delay so actions are not fired back to back.
  async pause(minMs = 800, maxMs = 2200) {
    await this.page.waitForTimeout(minMs + Math.random() * (maxMs - minMs));
  }

  async goto(pathname) {
    await this.page.goto(`${this.server}${pathname}`, { waitUntil: 'domcontentloaded' });
    await this.pause();
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
    if (await this.isLoggedIn()) {
      this.log('Reusing saved session.');
      return;
    }
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
    if (!(await this.isLoggedIn())) {
      const shot = await this.screenshot('login-failed');
      throw new Error(`Login failed; see ${shot}`);
    }
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await this.context.storageState({ path: STATE_FILE });
    this.log('Logged in.');
  }

  // Reads the resource overview (dorf1): stock, storage, production, fields and build queue.
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
        village: text('#villageName') ?? text('.villageInput') ?? document.querySelector('.villageInput')?.value ?? null,
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
      village: raw.village?.trim() || null,
      stock: byType(raw.stock),
      maxStorage: byType(raw.maxStorage),
      production: byType(raw.production),
      fields: raw.fields
        .map((f) => ({
          ...f, id: toInt(f.id), gid: toInt(f.gid), level: toInt(f.level), type: FIELD_TYPES[toInt(f.gid)],
        }))
        .filter((f) => f.id && f.type),
      queue: raw.queue.map((q) => ({ ...q, secondsLeft: toInt(q.secondsLeft) })),
    };
  }

  // Balanced growth: upgrade the lowest-level field, breaking ties by the resource we hold least of.
  // Crop fields jump the line when net crop production gets thin, so troops never starve.
  pickField(status) {
    const candidates = status.fields.filter((f) => !f.maxLevel && !f.underConstruction);
    if (!candidates.length) return null;
    const lowCrop = status.production?.crop != null && status.production.crop < 10;
    const affordable = candidates.filter((f) => f.canBuild);
    const pool = affordable.length ? affordable : candidates;
    const score = (f) => [
      lowCrop && f.type === 'crop' ? 0 : 1,
      f.level,
      status.stock?.[f.type] ?? 0,
    ];
    return [...pool].sort((a, b) => {
      const [sa, sb] = [score(a), score(b)];
      for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i];
      return a.id - b.id;
    })[0];
  }

  // Opens a building slot and presses the green upgrade button. Returns false if it cannot be built now.
  async upgrade(slotId) {
    await this.goto(`/build.php?id=${slotId}`);
    const button = this.page.locator('.upgradeButtonsContainer .section1 button.green:not(.disabled)').first();
    if (!(await button.isVisible().catch(() => false))) return false;
    const label = (await button.textContent())?.replace(/\s+/g, ' ').trim();
    if (this.dryRun) {
      this.log(`[dry run] would click "${label}" on slot ${slotId}`);
      return true;
    }
    await button.click();
    await this.page.waitForURL(/dorf[12]\.php/, { timeout: 15_000 }).catch(() => {});
    await this.pause();
    this.log(`Clicked "${label}" on slot ${slotId}.`);
    return true;
  }

  // One upkeep pass. Returns the status it acted on, so callers can decide when to come back.
  async play({ queueSlots = 1 } = {}) {
    const status = await this.status();
    this.log(formatStatus(status));
    if (status.queue.length >= queueSlots) {
      this.log('Build queue is full; nothing to do.');
      return status;
    }
    const field = this.pickField(status);
    if (!field) {
      this.log('Every resource field is maxed or under construction.');
      return status;
    }
    this.log(`Next: ${field.type} field (slot ${field.id}) level ${field.level} -> ${field.level + 1}`);
    if (!(await this.upgrade(field.id))) {
      this.log('Not enough resources yet (or the upgrade button is unavailable).');
    }
    return status;
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
    `Village: ${s.village ?? 'unknown'}`,
    `Resources: ${res.join(' | ')}`,
    `Fields: ${levels.join(' ')}`,
    `Queue: ${queue}`,
  ].join('\n');
}
