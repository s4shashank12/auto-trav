// All database access for the server.

const SERVER_COLUMNS = `id, name, url, username, enabled, config, status, status_message, next_run_at,
  last_pass_at, snapshot, created_at, updated_at, (password_enc is not null) as has_password`;

export function makeRepo(pool, cipher) {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0] ?? null;

  return {
    async listServers() {
      return (await pool.query(`select ${SERVER_COLUMNS} from servers order by id`)).rows;
    },

    getServer: (id) => one(`select ${SERVER_COLUMNS} from servers where id = $1`, [id]),

    // Server row plus its decrypted password, for the worker only.
    async getCredentials(id) {
      const row = await one('select url, username, password_enc from servers where id = $1', [id]);
      return row && { url: row.url, username: row.username, password: cipher.decrypt(row.password_enc) };
    },

    createServer({
      name, url, username, password, config = {}, enabled = false,
    }) {
      return one(
        `insert into servers (name, url, username, password_enc, config, enabled)
         values ($1, $2, $3, $4, $5, $6) returning ${SERVER_COLUMNS}`,
        [name, url, username, cipher.encrypt(password), config, enabled],
      );
    },

    async updateServer(id, fields) {
      const sets = [];
      const params = [id];
      const add = (column, value) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (fields.name !== undefined) add('name', fields.name);
      if (fields.url !== undefined) add('url', fields.url);
      if (fields.username !== undefined) add('username', fields.username);
      if (fields.password) add('password_enc', cipher.encrypt(fields.password));
      if (fields.config !== undefined) add('config', fields.config);
      if (fields.enabled !== undefined) add('enabled', fields.enabled);
      // New credentials or a new game world make the saved login useless.
      if (fields.url !== undefined || fields.username !== undefined || fields.password) sets.push('storage_state = null');
      if (!sets.length) return this.getServer(id);
      return one(`update servers set ${sets.join(', ')}, updated_at = now() where id = $1 returning ${SERVER_COLUMNS}`, params);
    },

    async deleteServer(id) {
      return (await pool.query('delete from servers where id = $1', [id])).rowCount > 0;
    },

    async setStatus(id, status, message = null, nextRunAt = null) {
      await pool.query(
        'update servers set status = $2, status_message = $3, next_run_at = $4 where id = $1',
        [id, status, message, nextRunAt],
      );
    },

    async saveSnapshot(id, snapshot) {
      await pool.query('update servers set snapshot = $2, last_pass_at = now() where id = $1', [id, snapshot]);
    },

    async loadSession(id) {
      return (await one('select storage_state from servers where id = $1', [id]))?.storage_state ?? null;
    },

    async saveSession(id, state) {
      await pool.query('update servers set storage_state = $2 where id = $1', [id, state]);
    },

    async kvGet(id, key) {
      return (await one('select value from server_kv where server_id = $1 and key = $2', [id, key]))?.value ?? null;
    },

    async kvSet(id, key, value) {
      await pool.query(
        `insert into server_kv (server_id, key, value) values ($1, $2, $3)
         on conflict (server_id, key) do update set value = excluded.value`,
        [id, key, JSON.stringify(value)],
      );
    },

    async addEvent(id, level, message) {
      await pool.query('insert into events (server_id, level, message) values ($1, $2, $3)', [id, level, message]);
    },

    // Newest first, or everything after `after` (oldest first) for polling.
    async listEvents(id, { after = null, limit = 200 } = {}) {
      const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000);
      if (after != null) {
        return (await pool.query(
          'select id, ts, level, message from events where server_id = $1 and id > $2 order by id asc limit $3',
          [id, after, cap],
        )).rows;
      }
      return (await pool.query(
        'select id, ts, level, message from events where server_id = $1 order by id desc limit $2',
        [id, cap],
      )).rows.reverse();
    },

    async pruneEvents(days) {
      await pool.query('delete from events where ts < now() - make_interval(days => $1)', [days]);
    },
  };
}

// Adapters giving the bot (src/travian.js) its login and state storage in Postgres.
export const pgSession = (repo, id) => ({
  load: () => repo.loadSession(id),
  save: (state) => repo.saveSession(id, state),
});

export const pgStore = (repo, id) => ({
  get: (key) => repo.kvGet(id, key),
  set: (key, value) => repo.kvSet(id, key, value),
});
