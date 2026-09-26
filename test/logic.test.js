import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, configFromEnv, mergeConfig, resolveConfig } from '../src/config.js';
import { listUnit, slotCapacity, splitByUnit } from '../src/farming.js';
import { trainAmount } from '../src/military.js';
import {
  canDevelop, isRaidableOasis, oasisAnimals, reinforceTarget, trainingUnit,
} from '../src/rules.js';
import { pickBuildings, pickField } from '../src/strategy.js';

const cfg = resolveConfig({});

test('mergeConfig deep-merges objects and replaces arrays', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { raid: { everyMinutes: 5, units: [] }, features: { raid: false } });
  assert.equal(merged.raid.everyMinutes, 5);
  assert.equal(merged.raid.radius, DEFAULT_CONFIG.raid.radius);
  assert.deepEqual(merged.raid.units, []);
  assert.equal(merged.features.raid, false);
  assert.equal(merged.features.build, true);
  assert.equal(DEFAULT_CONFIG.raid.everyMinutes, 10, 'defaults are not mutated');
});

test('configFromEnv maps the CLI environment variables', () => {
  const c = configFromEnv({ DRY_RUN: 'true', RAID_EVERY_MINUTES: '7', LOOP_MIN_MINUTES: '15' }, { build: { queueMax: 2 } });
  assert.equal(c.dryRun, true);
  assert.equal(c.raid.everyMinutes, 7);
  assert.equal(c.raid.cycleMinutes, 7);
  assert.equal(c.loop.minMinutes, 15);
  assert.equal(c.build.queueMax, 2);
  assert.equal(configFromEnv({}).dryRun, false);
});

test('population limit, training overrides and reinforcement target', () => {
  assert.equal(canDevelop({ population: 499 }, cfg), true);
  assert.equal(canDevelop({ population: 500 }, cfg), false);
  const c = resolveConfig({ train: { overrides: { Chingdi: { 19: 't3' } } } });
  assert.equal(trainingUnit({ name: 'Chingdi' }, 19, c), 't3');
  assert.equal(trainingUnit({ name: 'Jhol' }, 19, c), 't2');
  const villages = [{ name: 'A' }, { name: 'B', capital: true }];
  assert.equal(reinforceTarget(villages, cfg).name, 'B');
  assert.equal(reinforceTarget(villages, resolveConfig({ reinforce: { target: 'A' } })).name, 'A');
});

test('oasis safety check', () => {
  const animals = '<i class="unit u31"></i><span class="value ">3</span><i class="unit u35"></i><span class="value ">2</span>';
  assert.equal(oasisAnimals({ text: animals }), 5);
  assert.equal(isRaidableOasis({ title: '{k.fo}', text: 'empty' }), true);
  assert.equal(isRaidableOasis({ title: '{k.fo}', text: animals }), false);
  assert.equal(isRaidableOasis({ title: '{k.bt}', text: '' }), false, 'occupied oasis');
  assert.equal(isRaidableOasis({ title: '{k.fo}', uid: 5, text: '' }), false);
  assert.equal(isRaidableOasis(undefined), false);
});

test('pickField prefers the lowest affordable field, cropland when crop is low', () => {
  const f = (id, type, level, canBuild = true) => ({ id, type, level, canBuild, maxLevel: false, underConstruction: false });
  const status = { fields: [f(1, 'wood', 2), f(2, 'crop', 2), f(3, 'clay', 1, false), f(4, 'iron', 2)], stock: { wood: 5, crop: 9, iron: 1 }, production: { crop: 50 } };
  assert.equal(pickField(status).id, 4, 'lowest affordable, least stock');
  assert.equal(pickField({ ...status, production: { crop: 5 } }).id, 2, 'cropland first');
});

test('pickBuildings constructs missing buildings once prerequisites are met', () => {
  const slots = [{ id: 26, gid: 15, level: 5, canBuild: true }, { id: 19, gid: 0, level: 0 }];
  const fields = [{ type: 'wood', level: 10 }, { type: 'crop', level: 1 }];
  const names = pickBuildings(slots, fields, cfg.build.buildings).map((j) => `${j.kind} ${j.name}`);
  assert.ok(names.includes('construct Warehouse'));
  assert.ok(names.includes('construct Sawmill'), 'woodcutter 10 + main building 5');
  assert.ok(!names.includes('construct Brickyard'), 'needs a level 10 clay pit');
});

test('farm list helpers', () => {
  const { units } = cfg.raid;
  assert.equal(listUnit({ name: 'Oases (auto) EC 2', slots: [] }, cfg), 't6');
  assert.equal(listUnit({ name: 'x', slots: [{ troop: { t3: 10 } }] }, cfg), 't3');
  const cap = slotCapacity({ t3: 100, t6: 20 }, [{ slots: [{ troop: { t3: 10 }, isRunning: true }] }], units);
  assert.equal(cap.t3, 10, '100/10 at home + 1 running - 1 slot');
  assert.equal(cap.t6, 4);
  const oases = Array.from({ length: 6 }, (_, i) => ({ dist: i }));
  const plan = splitByUnit(oases, { t3: 3, t6: 3 }, units);
  assert.deepEqual(plan.map((p) => [p.unit, p.targets.map((t) => t.dist)]), [['t3', [0, 1, 2]], ['t6', [3, 4, 5]]]);
});

test('trainAmount respects queue, resources, game max and crop', () => {
  const info = {
    queueSeconds: 0, unitSeconds: 300, cost: { wood: 100, clay: 100, iron: 100, crop: 50 }, upkeep: 1,
    max: 100, stock: { wood: 7000, clay: 7000, iron: 7000, crop: 7000 }, production: { crop: 1000 },
  };
  const opts = { aheadMinutes: 60, targetMinutes: 180, reserve: 5000, cropLow: 200 };
  assert.equal(trainAmount(info, opts), 20, 'resources above the reserve');
  assert.equal(trainAmount({ ...info, queueSeconds: 3600 }, opts), 0, 'queue long enough');
  assert.equal(trainAmount({ ...info, production: { crop: 210 } }, opts), 10, 'crop room');
  assert.equal(trainAmount({ ...info, max: 3 }, opts), 3, 'game max');
});
