import { useEffect, useRef, useState } from 'react';

// Re-runs `fn` every `ms` while mounted (and immediately), exposing the latest result or error.
export function usePoll(fn, ms, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    let alive = true;
    let timer;
    const tick = async () => {
      try {
        const data = await saved.current();
        if (alive) setState({ data, error: null, loading: false });
      } catch (error) {
        if (alive) setState((s) => ({ ...s, error, loading: false }));
      }
      if (alive) timer = setTimeout(tick, ms);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export const navigate = (path) => {
  window.location.hash = path;
};

export function timeAgo(value) {
  if (!value) return '—';
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 0) return timeUntil(value);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(value).toLocaleString();
}

export function timeUntil(value) {
  if (!value) return '—';
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.round(seconds / 60)} min`;
  return `in ${Math.round(seconds / 3600)} h`;
}

export const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const out = structuredClone(obj ?? {});
  let node = out;
  keys.slice(0, -1).forEach((k) => {
    if (node[k] == null || typeof node[k] !== 'object' || Array.isArray(node[k])) node[k] = {};
    node = node[k];
  });
  node[keys.at(-1)] = value;
  return out;
}

export function unsetPath(obj, path) {
  const keys = path.split('.');
  const out = structuredClone(obj ?? {});
  const parents = [];
  let node = out;
  for (const k of keys.slice(0, -1)) {
    if (node[k] == null || typeof node[k] !== 'object') return out;
    parents.push([node, k]);
    node = node[k];
  }
  delete node[keys.at(-1)];
  // Drop objects left empty so overrides stay minimal.
  for (const [parent, k] of parents.reverse()) {
    if (Object.keys(parent[k]).length === 0) delete parent[k];
  }
  return out;
}

// Key order does not matter (Postgres jsonb reorders object keys).
const stable = (v) => (Array.isArray(v) ? v.map(stable)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
export const sameJson = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
