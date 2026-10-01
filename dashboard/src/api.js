// Talks to the backend REST API. The API URL and token are kept in this browser's localStorage.
// Inside the Android app the same API is answered by the bot engine on the phone, through the
// app's bridge (window.AutoNaitraAndroid) instead of HTTP; there is nothing to connect to.

const KEY = 'auto-travian.connection';

const androidBridge = typeof window !== 'undefined' ? window.AutoNaitraAndroid : undefined;
export const isAndroid = Boolean(androidBridge);
const ANDROID_CONNECTION = { url: 'android:', token: 'local' };

export function loadConnection() {
  if (isAndroid) return ANDROID_CONNECTION;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (saved?.url && saved?.token) return saved;
  } catch {
    // Storage unavailable (private mode) or corrupted: start disconnected.
  }
  return null;
}

export function saveConnection(connection) {
  try {
    if (connection) localStorage.setItem(KEY, JSON.stringify(connection));
    else localStorage.removeItem(KEY);
  } catch {
    // Not fatal: the connection just is not remembered.
  }
}

export const defaultApiUrl = () => import.meta.env.VITE_API_URL ?? '';

// Set at build time by the release workflow (VITE_APP_VERSION); "dev" for local builds.
export const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'dev';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Requests over the Android app's bridge: the app answers with window.__androidResponse.
function androidTransport() {
  const pending = new Map();
  let seq = 0;
  window.__androidResponse = (id, status, text) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve({ status, text });
  };
  return async function request(method, path, body) {
    const id = ++seq;
    const { status, text } = await new Promise((resolve, reject) => {
      // The engine restarts if Android ends its renderer; a request it never saw must not hang.
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new ApiError('The bot engine did not answer; it may be restarting. Try again in a moment.', 0));
      }, 60_000);
      pending.set(id, { resolve, timer });
      androidBridge.request(id, method, path, body !== undefined ? JSON.stringify(body) : '');
    });
    if (status === 204) return null;
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: reported below by status.
    }
    if (status < 200 || status > 299) throw new ApiError(data?.error ?? `Request failed (${status})`, status);
    return data;
  };
}

function androidClient() {
  const request = androidTransport();
  return {
    base: 'android:',
    android: true,
    health: () => request('GET', '/api/health'),
    meta: () => request('GET', '/api/meta'),
    servers: () => request('GET', '/api/servers'),
    server: (id) => request('GET', `/api/servers/${id}`),
    createServer: (body) => request('POST', '/api/servers', body),
    updateServer: (id, body) => request('PATCH', `/api/servers/${id}`, body),
    deleteServer: (id) => request('DELETE', `/api/servers/${id}`),
    start: (id) => request('POST', `/api/servers/${id}/start`),
    stop: (id) => request('POST', `/api/servers/${id}/stop`),
    action: (id, action) => request('POST', `/api/servers/${id}/actions`, { action }),
    inactives: (id) => request('GET', `/api/servers/${id}/inactives`),
    events: (id, after) => request('GET', `/api/servers/${id}/events${after != null ? `?after=${after}` : '?limit=300'}`),
    screenshots: (id) => request('GET', `/api/servers/${id}/screenshots`),
    // A data: URL; revoking it (as for the web's blob URLs) is harmless.
    screenshotUrl: async (id, file) => (await request('GET', `/api/servers/${id}/screenshots/${encodeURIComponent(file)}`)).dataUrl,
  };
}

// The phone's settings that decide whether the bot keeps running in the background.
export const phone = isAndroid ? {
  status: () => {
    try {
      return JSON.parse(androidBridge.phoneStatus());
    } catch {
      return null;
    }
  },
  allowBackground: () => androidBridge.allowBackground(),
  allowNotifications: () => androidBridge.allowNotifications(),
} : null;

export function createClient({ url, token }) {
  if (isAndroid) return androidClient();
  const base = url.replace(/\/+$/, '');

  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(`Cannot reach ${base}. Check the URL, HTTPS and the backend's CORS_ORIGINS. If the backend uses its own certificate (https-port), open ${base}/api/health in a new tab and accept it first.`, 0);
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
    return data;
  }

  return {
    base,
    health: () => fetch(`${base}/api/health`).then((r) => r.json()),
    meta: () => request('GET', '/api/meta'),
    servers: () => request('GET', '/api/servers'),
    server: (id) => request('GET', `/api/servers/${id}`),
    createServer: (body) => request('POST', '/api/servers', body),
    updateServer: (id, body) => request('PATCH', `/api/servers/${id}`, body),
    deleteServer: (id) => request('DELETE', `/api/servers/${id}`),
    start: (id) => request('POST', `/api/servers/${id}/start`),
    stop: (id) => request('POST', `/api/servers/${id}/stop`),
    action: (id, action) => request('POST', `/api/servers/${id}/actions`, { action }),
    inactives: (id) => request('GET', `/api/servers/${id}/inactives`),
    events: (id, after) => request('GET', `/api/servers/${id}/events${after != null ? `?after=${after}` : '?limit=300'}`),
    screenshots: (id) => request('GET', `/api/servers/${id}/screenshots`),
    async screenshotUrl(id, file) {
      const res = await fetch(`${base}/api/servers/${id}/screenshots/${encodeURIComponent(file)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new ApiError('Screenshot not found', res.status);
      return URL.createObjectURL(await res.blob());
    },
  };
}
