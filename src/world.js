import fs from 'node:fs/promises';
import path from 'node:path';

// Travian publishes every village of a game world once a day at /map.sql. Keeping a snapshot per
// day shows which players stopped growing: those are the inactive players.

// Parses the INSERT INTO `x_world` VALUES (...) lines of map.sql.
export function parseMapSql(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const start = line.indexOf('VALUES (');
    if (start < 0) continue;
    const values = [];
    let i = start + 8;
    while (i < line.length && line[i] !== ')') {
      if (line[i] === "'") {
        let s = '';
        i++;
        while (i < line.length) {
          if (line[i] === '\\') { s += line[i + 1]; i += 2; continue; }
          if (line[i] === "'" && line[i + 1] === "'") { s += "'"; i += 2; continue; }
          if (line[i] === "'") { i++; break; }
          s += line[i++];
        }
        values.push(s);
      } else {
        let raw = '';
        while (i < line.length && line[i] !== ',' && line[i] !== ')') raw += line[i++];
        raw = raw.trim();
        values.push(raw === 'NULL' ? null : raw === 'TRUE' ? true : raw === 'FALSE' ? false : Number(raw));
      }
      if (line[i] === ',') i++;
    }
    const [, x, y, tid, vid, name, uid, player, aid, alliance, population, , capital] = values;
    if (vid == null) continue;
    rows.push({
      vid, x, y, tid, name, uid, player, aid, alliance, population, capital: capital === true,
    });
  }
  return rows;
}

export const today = (now = new Date()) => now.toISOString().slice(0, 10);

const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86_400_000);

// Daily snapshots as JSON files, for the single-account CLI. The server uses Postgres.
export class FileWorldStore {
  constructor(dir = '.auth/world') {
    this.dir = dir;
  }

  async days() {
    const files = await fs.readdir(this.dir).catch(() => []);
    return files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
  }

  async getDay(day) {
    return JSON.parse(await fs.readFile(path.join(this.dir, `${day}.json`), 'utf8').catch(() => '[]'));
  }

  async saveDay(day, rows) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, `${day}.json`), JSON.stringify(rows));
  }

  async prune(keepDays) {
    const days = await this.days();
    for (const day of days.slice(0, Math.max(0, days.length - keepDays))) {
      await fs.rm(path.join(this.dir, `${day}.json`), { force: true });
    }
  }
}

// Players whose total population has not grown for `cfg.inactive.days` days, and their villages
// within reach of our own. `own` are our villages (did, x, y). Returns { ready, ... }: not ready
// until there is a snapshot old enough to compare with.
export async function findInactives(world, own, cfg) {
  const c = cfg.inactive;
  const days = await world.days();
  const latest = days.at(-1);
  const base = [...days].reverse().find((d) => latest && daysBetween(d, latest) >= c.days);
  if (!latest || !base) {
    return {
      ready: false, latest: latest ?? null, days: days.length, needDays: c.days + 1, targets: [], players: [],
    };
  }
  const [now, then] = await Promise.all([world.getDay(latest), world.getDay(base)]);
  const ownIds = new Set(own.map((v) => v.did));
  const me = now.find((r) => ownIds.has(r.vid));
  const myUid = me?.uid;
  const myAid = me?.aid;
  const excludedAlliances = new Set(c.excludeAlliances.map((a) => a.toLowerCase()));
  const excludedPlayers = new Set(c.excludePlayers.map((p) => p.toLowerCase()));
  const excludedTribes = new Set(c.excludeTribes);

  const totals = (rows) => rows.reduce((m, r) => m.set(r.uid, (m.get(r.uid) ?? 0) + r.population), new Map());
  const popNow = totals(now);
  const popThen = totals(then);
  const skip = (r) => r.uid === myUid
    || (c.excludeOwnAlliance && myAid && r.aid === myAid)
    || excludedTribes.has(r.tid)
    || (r.alliance && excludedAlliances.has(r.alliance.toLowerCase()))
    || excludedPlayers.has(String(r.player).toLowerCase());

  const players = new Map();
  const targets = [];
  for (const r of now) {
    if (skip(r) || !popThen.has(r.uid)) continue;
    const change = popNow.get(r.uid) - popThen.get(r.uid);
    if (change > 0) continue; // still growing: active
    if (r.population < c.minPop || r.population > c.maxPop) continue;
    let nearest = null;
    for (const v of own) {
      const dist = Math.hypot(r.x - v.x, r.y - v.y);
      if (!nearest || dist < nearest.dist) nearest = { did: v.did, name: v.name, dist };
    }
    if (!nearest || nearest.dist > c.radius) continue;
    targets.push({
      vid: r.vid, x: r.x, y: r.y, village: r.name, uid: r.uid, player: r.player, alliance: r.alliance,
      tribe: r.tid, population: r.population, playerChange: change, dist: Number(nearest.dist.toFixed(1)), from: nearest.name, fromDid: nearest.did,
    });
    const p = players.get(r.uid) ?? {
      uid: r.uid, player: r.player, alliance: r.alliance, population: popNow.get(r.uid), change, villages: 0,
    };
    p.villages += 1;
    players.set(r.uid, p);
  }
  targets.sort((a, b) => a.dist - b.dist);
  return {
    ready: true, latest, base, days: days.length, targets, players: [...players.values()].sort((a, b) => b.population - a.population),
  };
}
