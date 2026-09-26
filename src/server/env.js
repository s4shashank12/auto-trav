// Server settings, all from environment variables (see deploy/.env.example).
// Postgres: DATABASE_URL, or the standard PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE variables.

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
    databaseSsl: /^(1|true|yes|require)$/i.test(env.DATABASE_SSL ?? ''),
    corsOrigins: (env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
    dataDir: env.DATA_DIR ?? './data',
    headless: !/^(0|false|no)$/i.test(env.HEADLESS ?? ''),
    autostart: !/^(0|false|no)$/i.test(env.AUTOSTART ?? ''),
    eventsRetentionDays: Number(env.EVENTS_RETENTION_DAYS ?? 7),
    version: env.APP_VERSION ?? 'dev',
  };
}
