// The engine's storage: SQLite on the phone (the app's own database file), with the same
// operations as the server's Postgres repo (src/server/repo.js), so the API and the workers
// work alike. Statements go through the app (BotEngine.kt / BotDatabase.kt).
import { sync } from './native.js';

// Schema changes, applied in order once each. Never edit a released migration; add a new one.
const MIGRATIONS = [
  [
    `create table servers (
       id integer primary key autoincrement,
       name text not null,
       url text not null,
       username text not null,
       password_enc text not null,
       enabled integer not null default 0,
       config text not null default '{}',
       storage_state text,
       status text not null default 'stopped',
       status_message text,
       next_run_at text,
       last_pass_at text,
       snapshot text,
       created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
       updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     )`,
    `create table server_kv (
       server_id integer not null references servers(id) on delete cascade,
       key text not null,
       value text,
       primary key (server_id, key)
     )`,
    `create table events (
       id integer primary key autoincrement,
       server_id integer not null references servers(id) on delete cascade,
       ts text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
       level text not null,
       message text not null
     )`,
    'create index events_server_id on events (server_id, id)',
    'create index events_ts on events (ts)',
    // Daily copies of the game world's map.sql, for finding inactive players.
    `create table world_villages (
       server_id integer not null references servers(id) on delete cascade,
       day text not null,
       vid integer not null,
       x integer not null,
       y integer not null,
       tid integer,
       name text,
       uid integer,
       player text,
       aid integer,
       alliance text,
       population integer,
       capital integer,
       primary key (server_id, day, vid)
     )`,
  ],
];

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// Values go to the app as JSON: booleans become 0/1, objects JSON text.
const bindable = (v) => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
};

// The app answers { error } when SQLite refuses a statement.
const checked = (text, sql) => {
  const out = JSON.parse(text);
  if (out && !Array.isArray(out) && out.error) throw new Error(`SQLite: ${out.error} (in: ${String(sql).slice(0, 120)})`);
  return out;
};

export const db = {
  query(sql, params = []) {
    return checked(sync('dbQuery', sql, JSON.stringify(params.map(bindable))), sql);
  },
  one(sql, params = []) {
    return this.query(sql, params)[0] ?? null;
  },
  run(sql, params = []) {
    return checked(sync('dbRun', sql, JSON.stringify(params.map(bindable))), sql);
  },
  // Statements in one transaction: { sql, params } or { sql, rows: [params, ...] }.
  batch(statements) {
    const payload = statements.map((s) => ({
      sql: s.sql,
      params: s.params?.map(bindable),
      rows: s.rows?.map((r) => r.map(bindable)),
    }));
    return checked(sync('dbBatch', JSON.stringify(payload)), statements[0]?.sql);
  },
};

export function migrate() {
  db.run('create table if not exists schema_migrations (version integer primary key, applied_at text not null)');
  const done = new Set(db.query('select version from schema_migrations').map((r) => r.version));
  MIGRATIONS.forEach((statements, i) => {
    const version = i + 1;
    if (done.has(version)) return;
    db.batch([
      ...statements.map((sql) => ({ sql })),
      { sql: `insert into schema_migrations (version, applied_at) values (?, ${NOW})`, params: [version] },
    ]);
  });
}

const parse = (text) => {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const SERVER_COLUMNS = `id, name, url, username, enabled, config, status, status_message, next_run_at,
  last_pass_at, snapshot, created_at, updated_at, (password_enc is not null) as has_password`;

// A row as the Postgres repo returns it: booleans and JSON columns decoded.
const serverRow = (r) => r && {
  ...r,
  enabled: Boolean(r.enabled),
  has_password: Boolean(r.has_password),
  config: parse(r.config) ?? {},
  snapshot: parse(r.snapshot),
};

// `cipher` encrypts the game passwords (the app does it with a key in the Android Keystore).
export function makeRepo(cipher) {
  const getServer = async (id) => serverRow(db.one(`select ${SERVER_COLUMNS} from servers where id = ?`, [id]));

  return {
    async listServers() {
      return db.query(`select ${SERVER_COLUMNS} from servers order by id`).map(serverRow);
    },

    getServer,

    // Server row plus its decrypted password, for the worker only.
    async getCredentials(id) {
      const row = db.one('select url, username, password_enc from servers where id = ?', [id]);
      if (!row) return null;
      let password;
      try {
        password = cipher.decrypt(row.password_enc);
      } catch (err) {
        throw new Error(`The saved password cannot be read (${err.message}); enter it again under Account.`);
      }
      return { url: row.url, username: row.username, password };
    },

    async createServer({
      name, url, username, password, config = {}, enabled = false,
    }) {
      const { lastId } = db.run(
        'insert into servers (name, url, username, password_enc, config, enabled) values (?, ?, ?, ?, ?, ?)',
        [name, url, username, cipher.encrypt(password), config, enabled],
      );
      return getServer(lastId);
    },

    async updateServer(id, fields) {
      const sets = [];
      const params = [];
      const add = (column, value) => {
        sets.push(`${column} = ?`);
        params.push(value);
      };
      if (fields.name !== undefined) add('name', fields.name);
      if (fields.url !== undefined) add('url', fields.url);
      if (fields.username !== undefined) add('username', fields.username);
      if (fields.password) add('password_enc', cipher.encrypt(fields.password));
      if (fields.config !== undefined) add('config', fields.config);
      if (fields.enabled !== undefined) add('enabled', fields.enabled);
      // New credentials or a new game world make the saved login useless.
      if (fields.url !== undefined || fields.username !== undefined || fields.password) sets.push('storage_state = null');
      if (!sets.length) return getServer(id);
      db.run(`update servers set ${sets.join(', ')}, updated_at = ${NOW} where id = ?`, [...params, id]);
      return getServer(id);
    },

    async deleteServer(id) {
      return db.run('delete from servers where id = ?', [id]).changes > 0;
    },

    async setStatus(id, status, message = null, nextRunAt = null) {
      db.run(
        'update servers set status = ?, status_message = ?, next_run_at = ? where id = ?',
        [status, message, nextRunAt ? new Date(nextRunAt).toISOString() : null, id],
      );
    },

    async saveSnapshot(id, snapshot) {
      db.run(`update servers set snapshot = ?, last_pass_at = ${NOW} where id = ?`, [snapshot, id]);
    },

    async loadSession(id) {
      return parse(db.one('select storage_state from servers where id = ?', [id])?.storage_state);
    },

    async saveSession(id, state) {
      db.run('update servers set storage_state = ? where id = ?', [state, id]);
    },

    async kvGet(id, key) {
      return parse(db.one('select value from server_kv where server_id = ? and key = ?', [id, key])?.value);
    },

    async kvSet(id, key, value) {
      db.run(
        `insert into server_kv (server_id, key, value) values (?, ?, ?)
         on conflict (server_id, key) do update set value = excluded.value`,
        [id, key, JSON.stringify(value)],
      );
    },

    async addEvent(id, level, message) {
      db.run('insert into events (server_id, level, message) values (?, ?, ?)', [id, level, String(message)]);
    },

    // Newest first, or everything after `after` (oldest first) for polling.
    async listEvents(id, { after = null, limit = 200 } = {}) {
      const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000);
      if (after != null) {
        return db.query('select id, ts, level, message from events where server_id = ? and id > ? order by id asc limit ?', [id, after, cap]);
      }
      return db.query('select id, ts, level, message from events where server_id = ? order by id desc limit ?', [id, cap]).reverse();
    },

    async pruneEvents(days) {
      db.run("delete from events where ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)", [`-${Number(days)} days`]);
    },
  };
}

const WORLD_COLUMNS = ['vid', 'x', 'y', 'tid', 'name', 'uid', 'player', 'aid', 'alliance', 'population', 'capital'];

// Daily world snapshots (map.sql) for one server, as the bot's world store (src/world.js).
export const sqliteWorld = (id) => ({
  async days() {
    return db.query('select distinct day from world_villages where server_id = ? order by day', [id]).map((r) => r.day);
  },
  async getDay(day) {
    return db.query(`select ${WORLD_COLUMNS.join(', ')} from world_villages where server_id = ? and day = ?`, [id, day])
      .map((r) => ({ ...r, capital: Boolean(r.capital) }));
  },
  async saveDay(day, rows) {
    db.batch([
      { sql: 'delete from world_villages where server_id = ? and day = ?', params: [id, day] },
      {
        sql: `insert into world_villages (server_id, day, ${WORLD_COLUMNS.join(', ')}) values (?, ?, ${WORLD_COLUMNS.map(() => '?').join(', ')})`,
        rows: rows.map((r) => [id, day, ...WORLD_COLUMNS.map((c) => r[c] ?? null)]),
      },
    ]);
  },
  async prune(keepDays) {
    db.run(
      `delete from world_villages where server_id = ? and day not in (
         select distinct day from world_villages where server_id = ? order by day desc limit ?)`,
      [id, id, keepDays],
    );
  },
});

// Adapters giving the bot (src/travian.js) its login and state storage in SQLite.
export const dbSession = (repo, id) => ({
  load: () => repo.loadSession(id),
  save: (state) => repo.saveSession(id, state),
});

export const dbStore = (repo, id) => ({
  get: (key) => repo.kvGet(id, key),
  set: (key, value) => repo.kvSet(id, key, value),
});
