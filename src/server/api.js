import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { CONFIG_FIELDS, DEFAULT_CONFIG, resolveConfig } from '../config.js';
import { findInactives } from '../world.js';
import { pgWorld } from './repo.js';
import { safeEqual } from './crypto.js';
import { ValidationError, validateServer } from './validate.js';
import { ACTIONS } from './worker.js';

// Bearer-token auth with a small per-IP limit on failed attempts.
function auth(token) {
  const failures = new Map();
  const WINDOW = 10 * 60_000;
  const LIMIT = 20;
  return (req, res, next) => {
    const ip = req.ip ?? 'unknown';
    const entry = failures.get(ip);
    if (entry && Date.now() - entry.since < WINDOW && entry.count >= LIMIT) {
      return res.status(429).json({ error: 'Too many failed attempts; try again later.' });
    }
    const header = req.get('authorization') ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (given && safeEqual(given, token)) return next();
    const fresh = !entry || Date.now() - entry.since >= WINDOW;
    failures.set(ip, { since: fresh ? Date.now() : entry.since, count: fresh ? 1 : entry.count + 1 });
    if (failures.size > 5000) {
      for (const [key, value] of failures) if (Date.now() - value.since >= WINDOW) failures.delete(key);
    }
    return res.status(401).json({ error: 'Missing or wrong API token.' });
  };
}

function cors(origins) {
  const any = origins.includes('*');
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && (any || origins.includes(origin))) {
      res.set('Access-Control-Allow-Origin', any ? '*' : origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  };
}

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

export function createApp({
  repo, manager, env, pool,
}) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(cors(env.corsOrigins));
  app.use(express.json({ limit: '1mb' }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const serverId = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Bad server id');
    return id;
  };
  const found = async (req, res) => {
    const row = await repo.getServer(serverId(req));
    if (!row) res.status(404).json({ error: 'Server not found' });
    return row;
  };

  app.get('/api/health', wrap(async (req, res) => {
    await pool.query('select 1');
    res.json({ ok: true, version: env.version });
  }));

  app.use('/api', auth(env.adminToken));

  app.get('/api/meta', (req, res) => {
    res.json({
      version: env.version, defaults: DEFAULT_CONFIG, fields: CONFIG_FIELDS, actions: ACTIONS,
    });
  });

  app.get('/api/servers', wrap(async (req, res) => {
    res.json((await repo.listServers()).map((row) => view(row, manager)));
  }));

  app.post('/api/servers', wrap(async (req, res) => {
    const fields = validateServer(req.body, { create: true });
    const row = await repo.createServer(fields);
    if (req.body.enabled === true) await manager.start(row.id);
    res.status(201).json(view(await repo.getServer(row.id), manager));
  }));

  app.get('/api/servers/:id', wrap(async (req, res) => {
    const row = await found(req, res);
    if (!row) return;
    res.json({ ...view(row, manager), effectiveConfig: resolveConfig(row.config) });
  }));

  app.patch('/api/servers/:id', wrap(async (req, res) => {
    const row = await found(req, res);
    if (!row) return;
    const fields = validateServer(req.body);
    const updated = await repo.updateServer(row.id, fields);
    if (fields.url || fields.username || fields.password) await manager.reload(row.id);
    res.json(view(updated, manager));
  }));

  app.delete('/api/servers/:id', wrap(async (req, res) => {
    const row = await found(req, res);
    if (!row) return;
    await manager.remove(row.id);
    await repo.deleteServer(row.id);
    res.sendStatus(204);
  }));

  app.post('/api/servers/:id/start', wrap(async (req, res) => {
    const row = await found(req, res);
    if (!row) return;
    await manager.start(row.id);
    res.json(view(await repo.getServer(row.id), manager));
  }));

  app.post('/api/servers/:id/stop', wrap(async (req, res) => {
    const row = await found(req, res);
    if (!row) return;
    // Stopping waits for the current round to end, so answer right away.
    manager.stop(row.id).catch((err) => console.error(`stop failed: ${err.message}`));
    res.status(202).json({ ok: true });
  }));

  app.post('/api/servers/:id/actions', wrap(async (req, res) => {
    const row = await found(req, res);
    if (!row) return;
    const action = req.body?.action;
    if (!ACTIONS.includes(action)) throw new ValidationError(`action must be one of ${ACTIONS.join(', ')}`);
    // Actions can take minutes; the result shows up in the log and the snapshot.
    manager.worker(row.id).action(action).catch(() => {});
    res.status(202).json({ ok: true, action });
  }));

  app.get('/api/servers/:id/events', wrap(async (req, res) => {
    const row = await found(req, res);
    if (!row) return;
    const after = req.query.after != null ? Number(req.query.after) : null;
    res.json(await repo.listEvents(row.id, { after: Number.isFinite(after) ? after : null, limit: req.query.limit }));
  }));

  // Inactive players near this account's villages, from the stored world data. Works before
  // inactive raiding is switched on, so the list can be reviewed first.
  app.get('/api/servers/:id/inactives', wrap(async (req, res) => {
    const row = await found(req, res);
    if (!row) return;
    const villages = row.snapshot?.villages ?? [];
    if (!villages.length) return res.json({ ready: false, reason: 'no-villages', targets: [], players: [] });
    const result = await findInactives(pgWorld(pool, row.id), villages, resolveConfig(row.config));
    return res.json({ ...result, targets: result.targets.slice(0, 500) });
  }));

  const shotDir = (id) => path.join(env.dataDir, 'screenshots', String(id));

  app.get('/api/servers/:id/screenshots', wrap(async (req, res) => {
    const row = await found(req, res);
    if (!row) return;
    const files = (await fs.readdir(shotDir(row.id)).catch(() => [])).filter((f) => f.endsWith('.png')).sort().reverse();
    res.json(files.slice(0, 30));
  }));

  app.get('/api/servers/:id/screenshots/:file', wrap(async (req, res) => {
    const row = await found(req, res);
    if (!row) return;
    const file = path.basename(req.params.file);
    if (!/^[\w.-]+\.png$/.test(file)) throw new ValidationError('Bad file name');
    res.sendFile(path.resolve(shotDir(row.id), file), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Screenshot not found' });
    });
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body is not valid JSON' });
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
