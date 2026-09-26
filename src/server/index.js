#!/usr/bin/env node
// Multi-account server: REST API for the dashboard plus one bot worker per Travian account.
import fs from 'node:fs/promises';
import { createApp } from './api.js';
import { makeCipher } from './crypto.js';
import { createPool, migrate } from './db.js';
import { loadEnv } from './env.js';
import { BotManager } from './manager.js';
import { makeRepo } from './repo.js';

async function main() {
  const env = loadEnv();
  await fs.mkdir(env.dataDir, { recursive: true });

  const pool = createPool(env);
  await migrate(pool);
  const repo = makeRepo(pool, makeCipher(env.appSecret));
  const manager = new BotManager({ repo, env });
  const app = createApp({
    repo, manager, env, pool,
  });

  const server = app.listen(env.port, env.host, () => {
    console.log(`auto-travian ${env.version} listening on ${env.host}:${env.port}`);
  });

  await repo.pruneEvents(env.eventsRetentionDays);
  const pruner = setInterval(() => repo.pruneEvents(env.eventsRetentionDays).catch(() => {}), 3_600_000);
  if (env.autostart) await manager.startEnabled();

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down.`);
    clearInterval(pruner);
    server.close();
    await manager.shutdown();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
