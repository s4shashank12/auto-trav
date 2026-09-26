import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
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
  // Daily copies of the game world's map.sql, for finding inactive players.
  `create table world_villages (
     server_id integer not null references servers(id) on delete cascade,
     day date not null,
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
     capital boolean,
     primary key (server_id, day, vid)
   );`,
];

const SSL_URL_PARAMS = ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

// Normalises an SSL setting (DATABASE_SSL, sslmode= in the URL or PGSSLMODE) to disable,
// require (encrypted, certificate not checked), verify-ca (signed by the CA) or verify-full
// (signed by the CA and issued for the host name). null when not set.
export function sslMode(value, name = 'DATABASE_SSL') {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  if (['0', 'false', 'no', 'off', 'disable'].includes(v)) return 'disable';
  if (['1', 'true', 'yes', 'on', 'require', 'prefer', 'allow', 'no-verify'].includes(v)) return 'require';
  if (v === 'verify-ca') return 'verify-ca';
  if (['verify', 'verify-full'].includes(v)) return 'verify-full';
  throw new Error(`${name}: unknown SSL mode "${value}"; use false, require, verify-ca or verify-full`);
}

// A PEM setting is either a file path or the PEM text itself (with real or \n line breaks).
const readPem = (value, read) => (value.includes('-----BEGIN ') ? value.replace(/\\n/g, '\n') : read(value, 'utf8'));

function hostOf(connectionString, pgHost) {
  try {
    if (connectionString) return new URL(connectionString).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
  return pgHost ?? '';
}

// pg.Pool options from the environment. SSL settings in DATABASE_URL are taken out of the URL
// and applied here: pg would otherwise let them override `ssl` and treat sslmode=require as
// verify-full, which rejects the private CAs of most managed databases (Cloud SQL, Supabase, ...).
// The modes follow libpq: require only encrypts, unless a CA is given, then the CA is checked.
export function poolOptions(env, read = fs.readFileSync) {
  let connectionString = env.databaseUrl ?? undefined;
  const fromUrl = {};
  const q = connectionString?.indexOf('?') ?? -1;
  if (q >= 0) {
    const params = new URLSearchParams(connectionString.slice(q + 1));
    for (const key of SSL_URL_PARAMS) {
      if (params.has(key)) fromUrl[key] = params.get(key);
      params.delete(key);
    }
    const rest = params.toString();
    connectionString = connectionString.slice(0, q) + (rest ? `?${rest}` : '');
  }

  const ca = env.databaseSslCa ?? (fromUrl.sslrootcert === 'system' ? null : fromUrl.sslrootcert) ?? null;
  const cert = env.databaseSslCert ?? fromUrl.sslcert ?? null;
  const key = env.databaseSslKey ?? fromUrl.sslkey ?? null;
  let mode = sslMode(env.databaseSsl)
    ?? sslMode(fromUrl.sslmode ?? fromUrl.ssl, 'sslmode in DATABASE_URL')
    ?? sslMode(env.pgSslMode, 'PGSSLMODE');
  if (fromUrl.sslrootcert === 'system' && (!mode || mode === 'require')) mode = 'verify-full';
  if (ca && (!mode || mode === 'require')) mode = 'verify-ca';
  if (!mode && cert) mode = 'require';

  const options = { connectionString, max: env.databasePoolMax ?? 5, keepAlive: true };
  if (!mode || mode === 'disable') return { ...options, ssl: false };
  const ssl = { rejectUnauthorized: mode !== 'require' };
  if (ca) ssl.ca = readPem(ca, read);
  if (cert) ssl.cert = readPem(cert, read);
  if (key) ssl.key = readPem(key, read);
  // verify-ca: the CA must have signed the certificate, whatever host name it was issued for
  // (Cloud SQL's server certificates name the instance, not its IP address).
  if (mode === 'verify-ca') ssl.checkServerIdentity = () => undefined;
  // verify-full to an IP address: pg sends no server name then, and Node would check the
  // certificate against "localhost" instead of the address.
  const host = hostOf(connectionString, env.pgHost);
  if (mode === 'verify-full' && net.isIP(host)) ssl.checkServerIdentity = (_, peer) => tls.checkServerIdentity(host, peer);
  return { ...options, ssl, sslMode: mode };
}

export function createPool(env) {
  // With no DATABASE_URL, pg reads PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE itself.
  const { sslMode: mode, ...options } = poolOptions(env);
  const pool = new pg.Pool(options);
  pool.sslMode = mode ?? 'disable';
  // Managed databases close idle connections now and then; without a listener that would crash
  // the process. The pool replaces the connection on the next query.
  pool.on('error', (err) => console.error(`Postgres connection lost: ${err.message}`));
  return pool;
}

// Adds a hint to the connection errors people run into with hosted databases.
export function explainDbError(err) {
  const msg = err.message ?? String(err);
  if (/no encryption|SSL off|requires SSL|SSL connection is required/i.test(msg)) {
    return `${msg}\nThe database only accepts encrypted connections: set DATABASE_SSL=require (or verify-ca with DATABASE_SSL_CA).`;
  }
  if (/does not support SSL/i.test(msg)) {
    return `${msg}\nThe database does not accept encrypted connections: set DATABASE_SSL=false and remove sslmode from DATABASE_URL.`;
  }
  if (/client certificate/i.test(msg)) {
    return `${msg}\nThe database wants a client certificate: set DATABASE_SSL_CERT and DATABASE_SSL_KEY (Cloud SQL: client-cert.pem and client-key.pem).`;
  }
  if (/does not match certificate/i.test(msg)) {
    return `${msg}\nThe certificate was issued for another name: connect by that name, or set DATABASE_SSL=verify-ca to check only that the CA signed it.`;
  }
  if (/self[- ]signed|unable to verify|unable to get local issuer|certificate/i.test(msg)) {
    return `${msg}\nThe database's certificate could not be verified: set DATABASE_SSL_CA to its CA file (e.g. Cloud SQL's server-ca.pem), or DATABASE_SSL=require to encrypt without checking it.`;
  }
  return msg;
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
