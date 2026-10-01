// The part of Playwright's API that src/travian.js uses, on top of Android WebViews. The bot code
// is the same as on the server; only where its "browser" lives changes.
//
//   Browser   one per account; its contexts use the account's own WebView profile (cookies and
//             storage of its own) when the phone's WebView supports profiles. Without profiles,
//             accounts share one cookie jar, so only one may have a page open at a time (`lock`)
//             and each one's cookies are put back from its saved storage state.
//   Context   owns the pages; storageState() and close() as in Playwright.
//   Page      a WebView the app keeps off screen (BotEngine.kt / GamePage.kt). Scripts run in the
//             page through evaluateJavascript, as page.evaluate() does with Chromium.
//   Locator   resolved in the page on every use, like Playwright's: CSS (with :has), first/last,
//             filter({ has, hasText }), getByRole('button', { name }).
import { call, callWithin, sleep, sync } from '../native.js';

export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

const POLL_MS = 100;
let pageSeq = 0;
let evalSeq = 0;

// An argument for a script sent to the page, written as JavaScript source. Like Playwright's own
// serialiser it keeps undefined (also inside arrays and objects), NaN, Infinity, -0 and Dates,
// which JSON would turn into null or drop: travian.js passes [url, undefined, 'GET'] for GETs.
export function toSource(value, seen = new Set()) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    if (Object.is(value, -0)) return '-0';
    return String(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (value instanceof Date) return `new Date(${value.getTime()})`;
  if (value instanceof RegExp) return `new RegExp(${JSON.stringify(value.source)}, ${JSON.stringify(value.flags)})`;
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error('Cannot pass a circular structure to the page');
    seen.add(value);
    const out = Array.isArray(value)
      ? `[${value.map((v) => toSource(v, seen)).join(', ')}]`
      : `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${toSource(v, seen)}`).join(', ')}}`;
    seen.delete(value);
    return out;
  }
  throw new Error(`Cannot pass a ${typeof value} to the page`);
}

const matcher = (m) => {
  if (m == null) return null;
  return m instanceof RegExp ? { re: m.source, flags: m.flags } : { text: String(m) };
};

// Runs in the game page: the locator resolver and the element checks Playwright makes before
// acting (attached, visible, enabled). Self-contained: it is sent to the page as source text.
/* eslint-disable no-undef */
function pageLib() {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const test = (m, s) => {
    if (m.re != null) {
      const re = new RegExp(m.re, m.flags);
      return re.test(String(s ?? '')) || re.test(norm(s));
    }
    return norm(s).toLowerCase().includes(norm(m.text).toLowerCase());
  };
  const visible = (e) => {
    if (!e || !e.isConnected) return false;
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    return getComputedStyle(e).visibility !== 'hidden';
  };
  const disabled = (e) => Boolean(e.disabled) || e.getAttribute('aria-disabled') === 'true'
    || Boolean(e.closest && e.closest('fieldset:disabled'));
  // Every element under `root`, including inside open shadow roots (cookie banners use them).
  const deep = (root) => {
    const out = [];
    const walk = (node) => {
      for (const e of node.querySelectorAll('*')) {
        out.push(e);
        if (e.shadowRoot) walk(e.shadowRoot);
      }
    };
    walk(root);
    return out;
  };
  const ROLES = {
    button: 'button, input[type="button"], input[type="submit"], input[type="reset"], input[type="image"], [role="button"]',
    link: 'a[href], [role="link"]',
    checkbox: 'input[type="checkbox"], [role="checkbox"]',
    radio: 'input[type="radio"], [role="radio"]',
    textbox: 'input:not([type]), input[type="text"], input[type="email"], input[type="password"], textarea, [role="textbox"]',
  };
  const accessibleName = (e) => norm(e.getAttribute('aria-label') || e.innerText || e.textContent || e.value || e.getAttribute('title') || '');
  const resolve = (steps, root) => {
    let els = [root];
    for (const s of steps) {
      if (s.css != null) {
        const out = [];
        const seen = new Set();
        for (const e of els) {
          if (!e.querySelectorAll) continue;
          for (const m of e.querySelectorAll(s.css)) {
            if (!seen.has(m)) {
              seen.add(m);
              out.push(m);
            }
          }
        }
        els = out;
      } else if (s.role != null) {
        const sel = ROLES[s.role] ?? `[role="${s.role}"]`;
        const out = [];
        for (const e of els) {
          for (const m of deep(e)) {
            if (m.matches(sel) && visible(m) && (!s.name || test(s.name, accessibleName(m)))) out.push(m);
          }
        }
        els = out;
      } else if (s.nth != null) {
        const e = s.nth < 0 ? els[els.length + s.nth] : els[s.nth];
        els = e ? [e] : [];
      } else if (s.hasText != null) {
        els = els.filter((e) => test(s.hasText, e.textContent));
      } else if (s.has != null) {
        els = els.filter((e) => resolve(s.has, e).length > 0);
      }
    }
    return els;
  };
  return { resolve, visible, disabled };
}

// Runs in the game page: one operation on the first element a locator resolves to. Returns
// { wait: '<state>' } while that element is not ready for it yet.
function pageOp(op, lib) {
  const { visible, disabled } = lib;
  const els = lib.resolve(op.steps, document);
  const el = els[0];
  const ready = (state) => {
    if (!el) return 'attached';
    if ((state === 'visible' || state === 'enabled') && !visible(el)) return 'visible';
    if (state === 'enabled' && disabled(el)) return 'enabled';
    return null;
  };
  const wait = (state) => {
    const missing = ready(state);
    return missing ? { wait: missing } : null;
  };
  const setValue = (e, value) => {
    const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(e, value);
    else e.value = value;
  };
  const mouse = (e) => {
    const r = e.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    e.dispatchEvent(new PointerEvent('pointerover', init));
    e.dispatchEvent(new MouseEvent('mouseover', init));
    e.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
    e.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
    if (typeof e.focus === 'function') e.focus({ preventScroll: true });
    e.dispatchEvent(new PointerEvent('pointerup', init));
    e.dispatchEvent(new MouseEvent('mouseup', init));
    e.click();
  };

  switch (op.kind) {
    case 'count':
      return els.length;
    case 'isVisible':
      return visible(el);
    case 'waitFor': {
      if (op.state === 'attached') return el ? {} : { wait: 'attached' };
      if (op.state === 'detached') return el ? { wait: 'detached' } : {};
      if (op.state === 'hidden') return visible(el) ? { wait: 'hidden' } : {};
      return wait('visible') ?? {};
    }
    case 'isDisabled':
      return wait('attached') ?? { value: disabled(el) };
    case 'getAttribute':
      return wait('attached') ?? { value: el.getAttribute(op.name) };
    case 'textContent':
      return wait('attached') ?? { value: el.textContent };
    case 'innerText':
      return wait('attached') ?? { value: el.innerText };
    case 'click': {
      const w = wait('enabled');
      if (w) return w;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      mouse(el);
      return {};
    }
    case 'fill': {
      const w = wait('enabled');
      if (w) return w;
      if (el.readOnly) return { wait: 'editable' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      if (typeof el.select === 'function' && el.type !== 'number') el.select();
      setValue(el, op.value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: op.value, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return {};
    }
    case 'check': {
      const w = wait('enabled');
      if (w) return w;
      if (!el.checked) mouse(el);
      if (!el.checked) {
        el.checked = true;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return {};
    }
    case 'press': {
      const target = document.activeElement ?? document.body ?? document;
      const codes = { Escape: 27, Enter: 13, Tab: 9 };
      const init = {
        key: op.key, code: op.key, keyCode: codes[op.key] ?? 0, which: codes[op.key] ?? 0, bubbles: true, cancelable: true, composed: true,
      };
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
      return {};
    }
    default:
      throw new Error(`Unknown locator operation ${op.kind}`);
  }
}

// Installed in every game page: records the page's own fetch and XMLHttpRequest calls, so
// waitForResponse() can see the request a click sends and its status.
export const NETWORK_HOOK = `(function () {
  if (window.__botNet) return;
  var log = [];
  var seq = 0;
  Object.defineProperty(window, '__botNet', { value: { log: log, seq: function () { return seq; } } });
  var record = function (url, method, status) {
    try {
      log.push({ seq: ++seq, url: String(new URL(String(url), location.href)), method: String(method || 'GET').toUpperCase(), status: status });
      if (log.length > 200) log.splice(0, log.length - 200);
    } catch (e) { /* not a URL */ }
  };
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      var method = (init && init.method) || (input && input.method) || 'GET';
      return origFetch.apply(this, arguments).then(function (res) { record(url, method, res.status); return res; },
        function (err) { record(url, method, 0); throw err; });
    };
  }
  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__botReq = { method: method, url: url };
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var x = this;
    if (x.__botReq) x.addEventListener('loadend', function () { record(x.__botReq.url, x.__botReq.method, x.status); });
    return send.apply(this, arguments);
  };
})();`;
/* eslint-enable no-undef */

const describe = (steps) => steps.map((s) => {
  if (s.css != null) return `locator(${JSON.stringify(s.css)})`;
  if (s.role != null) return `getByRole(${JSON.stringify(s.role)}${s.name ? `, { name: ${s.name.re != null ? `/${s.name.re}/${s.name.flags}` : JSON.stringify(s.name.text)} }` : ''})`;
  if (s.nth === 0) return 'first()';
  if (s.nth === -1) return 'last()';
  if (s.nth != null) return `nth(${s.nth})`;
  if (s.hasText != null) return 'filter({ hasText })';
  return 'filter({ has })';
}).join('.');

export class Locator {
  constructor(page, steps) {
    this.page = page;
    this.steps = steps;
  }

  toString() {
    return describe(this.steps);
  }

  with(step) {
    return new Locator(this.page, [...this.steps, step]);
  }

  locator(selector) {
    return this.with({ css: selector });
  }

  first() {
    return this.with({ nth: 0 });
  }

  last() {
    return this.with({ nth: -1 });
  }

  nth(i) {
    return this.with({ nth: i });
  }

  filter({ has, hasText } = {}) {
    let out = this;
    if (hasText != null) out = out.with({ hasText: matcher(hasText) });
    if (has != null) out = out.with({ has: has.steps });
    return out;
  }

  getByRole(role, { name } = {}) {
    return this.with({ role, name: matcher(name) });
  }

  // One operation, retried until the element is ready for it or the timeout passes.
  async act(kind, extra = {}, { timeout } = {}) {
    const ms = timeout ?? this.page.context.timeout;
    const deadline = Date.now() + ms;
    for (;;) {
      const res = await this.page.op({ kind, steps: this.steps, ...extra });
      if (!res?.wait) return res;
      if (Date.now() >= deadline) {
        throw new TimeoutError(`locator.${kind}: Timeout ${ms}ms exceeded.\nwaiting for ${this} to be ${res.wait}`);
      }
      await sleep(POLL_MS);
    }
  }

  async count() {
    return this.page.op({ kind: 'count', steps: this.steps });
  }

  async isVisible() {
    return Boolean(await this.page.op({ kind: 'isVisible', steps: this.steps }));
  }

  async isDisabled(options) {
    return (await this.act('isDisabled', {}, options)).value;
  }

  async getAttribute(name, options) {
    return (await this.act('getAttribute', { name }, options)).value;
  }

  async textContent(options) {
    return (await this.act('textContent', {}, options)).value;
  }

  async innerText(options) {
    return (await this.act('innerText', {}, options)).value;
  }

  async waitFor({ state = 'visible', timeout } = {}) {
    await this.act('waitFor', { state }, { timeout });
  }

  async fill(value, options) {
    await this.act('fill', { value: String(value) }, options);
  }

  async check(options) {
    await this.act('check', {}, options);
  }

  // A click that starts a navigation (a link, a form, a button setting location.href) waits for
  // the new page to load, as Playwright waits for navigations its clicks start.
  async click(options) {
    const before = this.page.navState();
    await this.act('click', {}, options);
    await this.page.settleAfterAction(before);
  }

  async evaluate(fn, arg) {
    await this.act('waitFor', { state: 'attached' });
    return this.page.evaluateWith(`(function (op) {
      const el = (${pageLib.toString()})().resolve(op.steps, document)[0];
      if (!el) throw new Error('Element is not attached to the DOM');
      return (${fn.toString()})(el, op.arg);
    })`, { steps: this.steps, arg });
  }
}

export class Page {
  constructor(context, id) {
    this.context = context;
    this.id = id;
    this.closed = false;
    this.keyboard = { press: (key) => this.op({ kind: 'press', steps: [], key }) };
  }

  // Current address, as the app last saw it (Playwright's page.url() is synchronous too).
  url() {
    return sync('pageUrl', this.id) || 'about:blank';
  }

  // Navigation counters from the app: pages started and finished loading in this WebView.
  navState() {
    const [started, finished] = String(sync('pageNavState', this.id) || '0,0').split(',').map(Number);
    return { started, finished };
  }

  on() {
    // Request events are not available on Android (DEBUG_API logging only).
  }

  async waitForTimeout(ms) {
    await sleep(ms);
  }

  async goto(url, { timeout } = {}) {
    const target = new URL(url, this.url().startsWith('http') ? this.url() : undefined).href;
    const ms = timeout ?? this.context.navigationTimeout;
    await callWithin(ms + 15_000, 'pageGoto', this.id, target, ms);
    this.context.visited.add(new URL(target).origin);
    await this.waitForLoadState('domcontentloaded', { timeout: ms });
    return null;
  }

  // Runs a script string in the page through the app; returns the script's string result. A page
  // in the middle of a navigation can come back empty: then it is tried again shortly.
  async raw(script, { timeout = this.context.timeout } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (this.closed) throw new Error('Target page, context or browser has been closed');
      const out = JSON.parse((await callWithin(Math.max(timeout, 30_000), 'pageEval', this.id, script)) || 'null');
      if (typeof out === 'string') return JSON.parse(out);
      if (Date.now() >= deadline) throw new TimeoutError(`page.evaluate: Timeout ${timeout}ms exceeded (the page did not respond)`);
      await sleep(POLL_MS);
    }
  }

  async op(op) {
    const res = await this.raw(`(function () {
      try { return JSON.stringify({ ok: true, v: (${pageOp.toString()})(${toSource(op)}, (${pageLib.toString()})()) }); }
      catch (e) { return JSON.stringify({ ok: false, e: String((e && e.message) || e) }); }
    })()`);
    if (!res.ok) throw new Error(`${describe(op.steps) || 'page'}: ${res.e}`);
    return res.v;
  }

  // Like Playwright's page.evaluate(fn, arg): `fn` runs in the page and may return a promise;
  // its result comes back as JSON. A navigation while it runs fails it, as in Playwright.
  async evaluate(fn, arg) {
    const src = typeof fn === 'function' ? fn.toString() : `function () { return (${fn}); }`;
    return this.evaluateWith(src, arg, arg === undefined);
  }

  async evaluateWith(src, arg, noArg = false) {
    const id = `e${++evalSeq}`;
    const start = await this.raw(`(function () {
      try {
        var v = (${src})(${noArg ? '' : toSource(arg)});
        if (v && typeof v.then === 'function') {
          var box = window.__botResults || (window.__botResults = {});
          v.then(function (r) { box['${id}'] = { ok: true, v: r === undefined ? null : r }; },
            function (e) { box['${id}'] = { ok: false, e: String((e && e.message) || e) }; });
          return JSON.stringify({ pending: true, doc: performance.timeOrigin });
        }
        return JSON.stringify({ ok: true, v: v === undefined ? null : v });
      } catch (e) { return JSON.stringify({ ok: false, e: String((e && e.message) || e) }); }
    })()`);
    let res = start;
    const doc = start.doc;
    const deadline = Date.now() + Math.max(this.context.timeout, 60_000) * 2;
    while (res.pending) {
      await sleep(50);
      res = await this.raw(`(function () {
        var box = window.__botResults, r = box && box['${id}'];
        if (r) { delete box['${id}']; return JSON.stringify(r); }
        return JSON.stringify({ pending: true, doc: performance.timeOrigin });
      })()`);
      if (res.pending && res.doc !== doc) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
      if (res.pending && Date.now() >= deadline) throw new TimeoutError('page.evaluate: the script did not finish');
    }
    if (!res.ok) throw new Error(`page.evaluate: ${res.e}`);
    return res.v;
  }

  locator(selector) {
    return new Locator(this, [{ css: selector }]);
  }

  getByRole(role, { name } = {}) {
    return new Locator(this, [{ role, name: matcher(name) }]);
  }

  fill(selector, value, options) {
    return this.locator(selector).fill(value, options);
  }

  click(selector, options) {
    return this.locator(selector).click(options);
  }

  check(selector, options) {
    return this.locator(selector).check(options);
  }

  // After a click: if it sent the tab to a new page within a moment, wait until that page has
  // loaded. A navigation that never finishes (a download, a 204) is left to the next step.
  async settleAfterAction(before, { grace = 600 } = {}) {
    const until = Date.now() + grace;
    let state = this.navState();
    while (state.started === before.started && Date.now() < until) {
      await sleep(POLL_MS);
      state = this.navState();
    }
    if (state.started === before.started) return;
    await this.waitForNavigationFinished(state.started, this.context.navigationTimeout).catch(() => {});
  }

  async waitForNavigationFinished(count, timeout) {
    const deadline = Date.now() + timeout;
    while (this.navState().finished < count) {
      if (this.closed) throw new Error('Target page, context or browser has been closed');
      if (Date.now() >= deadline) throw new TimeoutError(`Navigation timeout of ${timeout}ms exceeded`);
      await sleep(POLL_MS);
    }
  }

  async readyState() {
    return this.raw('JSON.stringify(document.readyState)').catch(() => 'loading');
  }

  async waitForLoadState(state = 'load', { timeout } = {}) {
    const ms = timeout ?? this.context.navigationTimeout;
    const deadline = Date.now() + ms;
    const { started } = this.navState();
    await this.waitForNavigationFinished(started, ms);
    for (;;) {
      const ready = await this.readyState();
      if (ready === 'complete' || (ready === 'interactive' && state === 'domcontentloaded')) return;
      if (Date.now() >= deadline) throw new TimeoutError(`page.waitForLoadState: Timeout ${ms}ms exceeded.`);
      await sleep(POLL_MS);
    }
  }

  async waitForURL(pattern, { timeout } = {}) {
    const ms = timeout ?? this.context.navigationTimeout;
    const deadline = Date.now() + ms;
    const matches = (u) => (pattern instanceof RegExp ? pattern.test(u)
      : typeof pattern === 'function' ? pattern(new URL(u)) : u === pattern);
    for (;;) {
      const url = this.url();
      if (matches(url)) {
        const { started, finished } = this.navState();
        if (finished >= started) return;
      }
      if (Date.now() >= deadline) throw new TimeoutError(`page.waitForURL: Timeout ${ms}ms exceeded.`);
      await sleep(POLL_MS);
    }
  }

  // Only 'domcontentloaded' (the next page to load in this tab) is used by the bot.
  async waitForEvent(event, { timeout } = {}) {
    if (event !== 'domcontentloaded' && event !== 'load') throw new Error(`waitForEvent('${event}') is not supported on Android`);
    const ms = timeout ?? this.context.timeout;
    const { started } = this.navState();
    const deadline = Date.now() + ms;
    while (this.navState().started <= started) {
      if (Date.now() >= deadline) throw new TimeoutError(`page.waitForEvent: Timeout ${ms}ms exceeded while waiting for event "${event}"`);
      await sleep(POLL_MS);
    }
    await this.waitForNavigationFinished(started + 1, Math.max(1000, deadline - Date.now()));
  }

  // Resolves with the first fetch/XHR response, from now on, that `predicate` accepts. Responses
  // are seen through NETWORK_HOOK (installed when each page starts loading).
  async waitForResponse(predicate, { timeout } = {}) {
    const ms = timeout ?? this.context.timeout;
    const deadline = Date.now() + ms;
    const mark = await this.raw(`(function () {
      ${NETWORK_HOOK}
      return JSON.stringify({ doc: performance.timeOrigin, seq: window.__botNet.seq() });
    })()`);
    let { doc, seq } = mark;
    for (;;) {
      const batch = await this.raw(`(function () {
        if (!window.__botNet) return JSON.stringify({ doc: performance.timeOrigin, log: [] });
        return JSON.stringify({ doc: performance.timeOrigin, log: window.__botNet.log });
      })()`).catch(() => ({ doc: null, log: [] }));
      if (batch.doc != null && batch.doc !== doc) {
        doc = batch.doc;
        seq = 0;
      }
      for (const e of batch.log.filter((x) => x.seq > seq)) {
        seq = e.seq;
        const response = {
          url: () => e.url,
          status: () => e.status,
          ok: () => e.status >= 200 && e.status <= 299,
          request: () => ({ method: () => e.method, url: () => e.url }),
        };
        if (await predicate(response)) return response;
      }
      if (Date.now() >= deadline) throw new TimeoutError(`page.waitForResponse: Timeout ${ms}ms exceeded while waiting for event "response"`);
      await sleep(POLL_MS);
    }
  }

  async screenshot({ path } = {}) {
    await callWithin(30_000, 'pageScreenshot', this.id, path ?? `screenshots/${Date.now()}.png`);
    return null;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await callWithin(30_000, 'pageClose', this.id).catch(() => {});
  }
}

export class BrowserContext {
  constructor(browser, { storageState } = {}) {
    this.browser = browser;
    this.storage = storageState ?? null;
    this.timeout = 30_000;
    this.navigationTimeout = 30_000;
    this.pages = [];
    this.visited = new Set(Object.keys(this.storage?.cookies ?? {}));
    this.closed = false;
  }

  setDefaultTimeout(ms) {
    this.timeout = ms;
  }

  setDefaultNavigationTimeout(ms) {
    this.navigationTimeout = ms;
  }

  // Without profiles every account shares the WebView cookie jar: this account's saved cookies
  // replace whatever the last one left.
  async open() {
    if (this.browser.profile) return;
    await call('cookiesClear', '');
    for (const [origin, cookies] of Object.entries(this.storage?.cookies ?? {})) {
      await call('cookiesSet', '', origin, cookies);
    }
  }

  async newPage() {
    if (this.closed) throw new Error('Target page, context or browser has been closed');
    const page = new Page(this, `p${++pageSeq}`);
    await callWithin(30_000, 'pageCreate', page.id, this.browser.profile ?? '', NETWORK_HOOK);
    this.pages.push(page);
    return page;
  }

  // Cookies of every game origin this context visited (by profile, or in the shared jar).
  async storageState() {
    const cookies = {};
    for (const origin of this.visited) {
      const value = await call('cookiesGet', this.browser.profile ?? '', origin);
      if (value) cookies[origin] = value;
    }
    return { android: true, profile: this.browser.profile, cookies };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.pages.map((p) => p.close()));
    this.browser.release();
  }
}

// A simple async mutex: the shared cookie jar can serve one account at a time.
export class Lock {
  constructor() {
    this.tail = Promise.resolve();
  }

  acquire() {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const ready = this.tail.then(() => release);
    this.tail = this.tail.then(() => next);
    return ready;
  }
}

export class Browser {
  // `profile`: the WebView profile of this account (null without multi-profile support, then
  // `lock` keeps accounts from using the shared cookie jar at the same time).
  constructor({ profile = null, lock = null } = {}) {
    this.profile = profile;
    this.lock = lock;
    this.releases = [];
  }

  isConnected() {
    return true;
  }

  async newContext(options = {}) {
    if (this.lock) this.releases.push(await this.lock.acquire());
    const context = new BrowserContext(this, options);
    try {
      await context.open();
    } catch (err) {
      this.release();
      throw err;
    }
    return context;
  }

  release() {
    this.releases.shift()?.();
  }

  async close() {}
}

// The server launches Chromium; on the phone there is nothing to launch.
export const chromium = {
  launch: async () => new Browser(),
};

export default { chromium };
