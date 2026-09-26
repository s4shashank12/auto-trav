import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig } from '../src/config.js';
import { inRaidHours } from '../src/inactive.js';
import { findInactives, parseMapSql } from '../src/world.js';

test('parseMapSql reads villages, NULLs, booleans and quoted names', () => {
  const sql = [
    "INSERT INTO `x_world` VALUES (92879,47,-31,1,22626,'Jhol',1288,'Bokachoda',3,'ARAM',881,NULL,FALSE,NULL,NULL,NULL);",
    "INSERT INTO `x_world` VALUES (1,-5,7,2,500,'Tom\\'s, place',42,'O''Neil',0,'',120,NULL,TRUE,NULL,NULL,NULL);",
    'garbage line',
  ].join('\n');
  const rows = parseMapSql(sql);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    vid: 22626, x: 47, y: -31, tid: 1, name: 'Jhol', uid: 1288, player: 'Bokachoda', aid: 3, alliance: 'ARAM', population: 881, capital: false,
  });
  assert.equal(rows[1].name, "Tom's, place");
  assert.equal(rows[1].player, "O'Neil");
  assert.equal(rows[1].capital, true);
});

test('inRaidHours handles empty, normal and overnight windows', () => {
  const cfg = (hours) => resolveConfig({ inactive: { hours, timezone: 'UTC' } });
  const at = (h) => new Date(Date.UTC(2026, 0, 1, h, 30));
  assert.equal(inRaidHours(cfg(''), at(3)), true);
  assert.equal(inRaidHours(cfg('6-23'), at(3)), false);
  assert.equal(inRaidHours(cfg('6-23'), at(12)), true);
  assert.equal(inRaidHours(cfg('22-5'), at(23)), true);
  assert.equal(inRaidHours(cfg('22-5'), at(12)), false);
});

function fakeWorld(days) {
  return {
    days: async () => Object.keys(days).sort(),
    getDay: async (d) => days[d] ?? [],
  };
}

test('findInactives picks players who stopped growing, near us, and not excluded', async () => {
  const v = (vid, uid, pop, x, y, extra = {}) => ({
    vid, uid, population: pop, x, y, tid: 1, name: `v${vid}`, player: `p${uid}`, aid: 0, alliance: '', ...extra,
  });
  const then = [
    v(1, 1288, 800, 0, 0, { aid: 3, alliance: 'ARAM' }), // us
    v(2, 10, 300, 5, 5), // stopped growing -> inactive
    v(3, 11, 300, 6, 6), // growing -> active
    v(4, 12, 200, 7, 7, { aid: 3, alliance: 'ARAM' }), // own alliance
    v(5, 13, 200, 90, 90), // too far
    v(6, 14, 200, 3, 3, { tid: 5 }), // Natars
  ];
  const now = then.map((r) => (r.uid === 11 ? { ...r, population: 320 } : r));
  const world = fakeWorld({ '2026-01-01': then, '2026-01-04': now });
  const own = [{ did: 1, name: 'Home', x: 0, y: 0 }];
  const found = await findInactives(world, own, resolveConfig({ inactive: { days: 3, radius: 25 } }));
  assert.equal(found.ready, true);
  assert.deepEqual(found.targets.map((t) => t.vid), [2]);
  assert.equal(found.targets[0].from, 'Home');

  const early = await findInactives(fakeWorld({ '2026-01-03': then, '2026-01-04': now }), own, resolveConfig({}));
  assert.equal(early.ready, false, 'needs a snapshot at least `days` old');

  const skipped = await findInactives(world, own, resolveConfig({ inactive: { excludePlayers: ['P10'] } }));
  assert.equal(skipped.targets.length, 0);
});
