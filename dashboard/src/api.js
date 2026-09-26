// Talks to the backend REST API. The API URL and token are kept in this browser's localStorage.

const KEY = 'auto-travian.connection';

export function loadConnection() {
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

export function createClient({ url, token }) {
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
