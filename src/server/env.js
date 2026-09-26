// Server settings, all from environment variables (see deploy/.env.example).
// Postgres: DATABASE_URL, or the standard PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE variables.
// TLS: DATABASE_SSL (false, require, verify-ca, verify-full), or sslmode= in DATABASE_URL, or
// PGSSLMODE; DATABASE_SSL_CA / _CERT / _KEY are PEM files (or the PEM text itself).

function required(env, name, minLength) {
  const value = env[name];
  if (!value || value.length < minLength) {
    throw new Error(`${name} must be set to at least ${minLength} characters`);
  }
  return value;
}

export function loadEnv(env = process.env) {
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    adminToken: required(env, 'ADMIN_TOKEN', 16),
    appSecret: required(env, 'APP_SECRET', 16),
    databaseUrl: env.DATABASE_URL || null,
    databaseSsl: env.DATABASE_SSL || null,
    pgSslMode: env.PGSSLMODE || null,
    pgHost: env.PGHOST || null,
    databaseSslCa: env.DATABASE_SSL_CA || null,
    databaseSslCert: env.DATABASE_SSL_CERT || null,
    databaseSslKey: env.DATABASE_SSL_KEY || null,
    corsOrigins: (env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
    dataDir: env.DATA_DIR ?? './data',
    headless: !/^(0|false|no)$/i.test(env.HEADLESS ?? ''),
    autostart: !/^(0|false|no)$/i.test(env.AUTOSTART ?? ''),
    eventsRetentionDays: Number(env.EVENTS_RETENTION_DAYS ?? 7),
    version: env.APP_VERSION ?? 'dev',
  };
}
