// The dashboard's REST API (as in src/server/api.js), answered inside the app. The dashboard sends
// each request over the app's bridge instead of HTTP: handle(method, url, body) -> { status, body }.
// There is no token: only the app's own screens can reach it.
import { CONFIG_FIELDS, DEFAULT_CONFIG, resolveConfig } from '../../../src/config.js';
import { ValidationError, validateServer } from '../../../src/server/validate.js';
import { findInactives } from '../../../src/world.js';
import { sync } from './native.js';
import { sqliteWorld } from './repo.js';
import { ACTIONS } from './worker.js';

class NotFound extends Error {}

// Server row as the dashboard sees it: never the password, and live worker state when there is one.
function view(row, manager) {
  const live = manager.state(row.id);
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    username: row.username,
    hasPassword: row.has_password,
    enabled: row.enabled,
    status: live?.status ?? row.status,
    statusMessage: live ? live.message : row.status_message,
    nextRunAt: live ? live.nextRunAt : row.next_run_at,
    lastPassAt: row.last_pass_at,
    config: row.config,
    snapshot: row.snapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createApi({
  repo, manager, version, device = {},
}) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    routes.push({ method, re, handler });
  };

  const serverId = (params) => {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Bad server id');
    return id;
  };
  const found = async (params) => {
    const row = await repo.getServer(serverId(params));
    if (!row) throw new NotFound('Server not found');
    return row;
  };

  route('GET', '/api/health', async () => ({ ok: true, version }));

  route('GET', '/api/meta', async () => ({
    version, defaults: DEFAULT_CONFIG, fields: CONFIG_FIELDS, actions: ACTIONS, platform: 'android', device,
  }));

  route('GET', '/api/servers', async () => (await repo.listServers()).map((row) => view(row, manager)));

  route('POST', '/api/servers', async ({ body }) => {
    const fields = validateServer(body, { create: true });
    const row = await repo.createServer(fields);
    if (body.enabled === true) await manager.start(row.id);
    return { status: 201, body: view(await repo.getServer(row.id), manager) };
  });

  route('GET', '/api/servers/:id', async ({ params }) => {
    const row = await found(params);
    return { ...view(row, manager), effectiveConfig: resolveConfig(row.config) };
  });

  route('PATCH', '/api/servers/:id', async ({ params, body }) => {
    const row = await found(params);
    const fields = validateServer(body);
    const updated = await repo.updateServer(row.id, fields);
    if (fields.url || fields.username || fields.password) await manager.reload(row.id, { clearLogin: true });
    return view(updated, manager);
  });

  route('DELETE', '/api/servers/:id', async ({ params }) => {
    const row = await found(params);
    await manager.remove(row.id);
    await repo.deleteServer(row.id);
    sync('deleteFiles', `screenshots/${row.id}`);
    return { status: 204 };
  });

  route('POST', '/api/servers/:id/start', async ({ params }) => {
    const row = await found(params);
    await manager.start(row.id);
    return view(await repo.getServer(row.id), manager);
  });

  route('POST', '/api/servers/:id/stop', async ({ params }) => {
    const row = await found(params);
    // Stopping waits for the current round to end, so answer right away.
    manager.stop(row.id).catch((err) => console.error(`stop failed: ${err.message}`));
    return { status: 202, body: { ok: true } };
  });

  route('POST', '/api/servers/:id/actions', async ({ params, body }) => {
    const row = await found(params);
    const action = body?.action;
    if (!ACTIONS.includes(action)) throw new ValidationError(`action must be one of ${ACTIONS.join(', ')}`);
    // Actions can take minutes; the result shows up in the log and the snapshot.
    manager.worker(row.id).action(action).catch(() => {});
    return { status: 202, body: { ok: true, action } };
  });

  route('GET', '/api/servers/:id/events', async ({ params, query }) => {
    const row = await found(params);
    const after = query.get('after') != null ? Number(query.get('after')) : null;
    return repo.listEvents(row.id, { after: Number.isFinite(after) ? after : null, limit: query.get('limit') });
  });

  // Inactive players near this account's villages, from the stored world data. Works before
  // inactive raiding is switched on, so the list can be reviewed first.
  route('GET', '/api/servers/:id/inactives', async ({ params }) => {
    const row = await found(params);
    const villages = row.snapshot?.villages ?? [];
    if (!villages.length) return { ready: false, reason: 'no-villages', targets: [], players: [] };
    const result = await findInactives(sqliteWorld(row.id), villages, resolveConfig(row.config));
    return { ...result, targets: result.targets.slice(0, 500) };
  });

  route('GET', '/api/servers/:id/screenshots', async ({ params }) => {
    const row = await found(params);
    const files = JSON.parse(sync('listFiles', `screenshots/${row.id}`) || '[]');
    return files.filter((f) => f.endsWith('.png')).sort().reverse().slice(0, 30);
  });

  // On the phone a screenshot comes back as a data: URL the dashboard can show directly.
  route('GET', '/api/servers/:id/screenshots/:file', async ({ params }) => {
    const row = await found(params);
    const file = decodeURIComponent(params.file);
    if (!/^[\w.-]+\.png$/.test(file)) throw new ValidationError('Bad file name');
    const data = sync('readFileBase64', `screenshots/${row.id}/${file}`);
    if (!data) throw new NotFound('Screenshot not found');
    return { dataUrl: `data:image/png;base64,${data}` };
  });

  return async function handle(method, url, body) {
    const parsed = new URL(url, 'http://app');
    const verb = String(method).toUpperCase();
    try {
      for (const r of routes) {
        if (r.method !== verb) continue;
        const m = r.re.exec(parsed.pathname);
        if (!m) continue;
        const out = await r.handler({ params: m.groups ?? {}, query: parsed.searchParams, body: body ?? {} });
        if (out && typeof out === 'object' && 'status' in out && Object.keys(out).every((k) => k === 'status' || k === 'body')) {
          return { status: out.status, body: out.body ?? null };
        }
        return { status: 200, body: out };
      }
      return { status: 404, body: { error: 'Not found' } };
    } catch (err) {
      if (err instanceof ValidationError) return { status: 400, body: { error: err.message } };
      if (err instanceof NotFound) return { status: 404, body: { error: err.message } };
      console.error(err?.stack ?? err);
      return { status: 500, body: { error: `Internal error: ${err.message}` } };
    }
  };
}
