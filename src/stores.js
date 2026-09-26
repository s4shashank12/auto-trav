import fs from 'node:fs/promises';
import path from 'node:path';

// Small bits of bot state (which farm list targets were raided when, reinforcements under way),
// one JSON file per key. The server keeps the same keys in Postgres instead (server/store.js).
export class FileStore {
  constructor(dir = '.auth') {
    this.dir = dir;
  }

  file(key) {
    return path.join(this.dir, `${key}.json`);
  }

  async get(key) {
    return JSON.parse(await fs.readFile(this.file(key), 'utf8').catch(() => 'null'));
  }

  async set(key, value) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(key), JSON.stringify(value));
  }
}
