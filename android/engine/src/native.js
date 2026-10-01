// The app's native side (Kotlin, see BotEngine.kt) as the engine sees it. `Native` is the
// JavaScript interface the app adds to the engine's WebView:
//   - sync(name, ...args) calls a method that returns at once (SQLite, encryption, small reads);
//   - call(name, ...args) starts work on the app's side (page loads, scripts in game pages,
//     screenshots) and resolves when the app reports back through __nativeDone.

const bridge = () => {
  if (!globalThis.Native) throw new Error('Not running inside the app: the Native bridge is missing');
  return globalThis.Native;
};

const pending = new Map();
let seq = 0;

globalThis.__nativeDone = (id, ok, payload) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (ok) p.resolve(payload);
  else p.reject(new Error(payload));
};

export function call(name, ...args) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      bridge()[name](id, ...args);
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

// call() with a deadline: a page the app lost (its renderer died) must fail the bot's step, not
// leave it waiting forever.
export function callWithin(ms, name, ...args) {
  const id = seq + 1;
  let timer;
  return Promise.race([
    call(name, ...args),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${name}: the app did not answer within ${Math.round(ms / 1000)}s`));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export const sync = (name, ...args) => bridge()[name](...args);

// Timers run on the app's side. A WebView in a background service can have its own timers slowed
// down to once a minute; the app's timers keep the bot's pauses and sleeps on time.
export function installTimers() {
  const timers = new Map();
  let next = 0;
  globalThis.__timerFire = (id) => {
    const t = timers.get(id);
    if (!t) return;
    if (t.repeat) bridge().timerStart(id, t.ms);
    else timers.delete(id);
    try {
      t.fn(...t.args);
    } catch (err) {
      console.error(`Timer callback failed: ${err?.stack ?? err}`);
    }
  };
  const start = (repeat) => (fn, ms = 0, ...args) => {
    const id = ++next;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, {
      fn: typeof fn === 'function' ? fn : () => {}, ms: delay, args, repeat,
    });
    bridge().timerStart(id, delay);
    return id;
  };
  const stop = (id) => {
    if (timers.delete(id)) bridge().timerCancel(id);
  };
  globalThis.setTimeout = start(false);
  globalThis.setInterval = start(true);
  globalThis.clearTimeout = stop;
  globalThis.clearInterval = stop;
}

export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
