import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeCipher, safeEqual } from '../src/server/crypto.js';
import { ValidationError, validateConfig, validateServer } from '../src/server/validate.js';

test('passwords round-trip through encryption and are not stored in clear', () => {
  const cipher = makeCipher('a-long-enough-app-secret');
  const stored = cipher.encrypt('hunter2');
  assert.ok(stored.startsWith('v1:'));
  assert.ok(!stored.includes('hunter2'));
  assert.notEqual(stored, cipher.encrypt('hunter2'), 'random IV');
  assert.equal(cipher.decrypt(stored), 'hunter2');
  assert.throws(() => makeCipher('another-app-secret-here').decrypt(stored));
});

test('safeEqual', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('validateConfig accepts known settings and rejects the rest', () => {
  assert.doesNotThrow(() => validateConfig({ raid: { everyMinutes: 5 }, train: { overrides: { Any: { 19: 't3' } }, units: { 29: 't2' } } }));
  assert.throws(() => validateConfig({ raid: { everyMinutes: '5' } }), ValidationError);
  assert.throws(() => validateConfig({ nope: 1 }), /Unknown setting/);
  assert.throws(() => validateConfig({ raid: { units: {} } }), /array/);
  assert.throws(() => validateConfig({ build: { populationLimit: Infinity } }), /finite/);
});

test('validateServer', () => {
  const ok = validateServer({
    name: ' A ', url: 'https://ts4.x1.international.travian.com/dorf1.php', username: 'u', password: 'p',
  }, { create: true });
  assert.equal(ok.name, 'A');
  assert.equal(ok.url, 'https://ts4.x1.international.travian.com');
  assert.throws(() => validateServer({ name: 'A', url: 'x', username: 'u' }, { create: true }), ValidationError);
  assert.deepEqual(validateServer({ password: '' }), {}, 'empty password keeps the old one');
});
