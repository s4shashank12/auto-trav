import pg from 'pg';

// Schema changes, applied in order once each. Never edit a released migration; add a new one.
const MIGRATIONS = [
  `create table servers (
     id serial primary key,
     name text not null,
     url text not null,
     username text not null,
     password_enc text not null,
     enabled boolean not null default false,
     config jsonb not null default '{}',
     storage_state jsonb,
     status text not null default 'stopped',
     status_message text,
     next_run_at timestamptz,
     last_pass_at timestamptz,
     snapshot jsonb,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   );
   create table server_kv (
     server_id integer not null references servers(id) on delete cascade,
     key text not null,
     value jsonb,
     primary key (server_id, key)
   );
   create table events (
     id bigserial primary key,
     server_id integer not null references servers(id) on delete cascade,
     ts timestamptz not null default now(),
     level text not null,
     message text not null
   );
   create index events_server_id on events (server_id, id);
   create index events_ts on events (ts);`,
];

export function createPool(env) {
  // With no DATABASE_URL, pg reads PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE itself.
  return new pg.Pool({
    connectionString: env.databaseUrl ?? undefined,
    ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
}

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(727274)');
    await client.query(`create table if not exists schema_migrations (
      version integer primary key, applied_at timestamptz not null default now())`);
    const { rows } = await client.query('select version from schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    for (const [i, sql] of MIGRATIONS.entries()) {
      const version = i + 1;
      if (done.has(version)) continue;
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (version) values ($1)', [version]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}
