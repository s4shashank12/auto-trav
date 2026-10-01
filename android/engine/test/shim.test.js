// The Playwright shim's pieces that need no page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toSource } from '../src/shims/playwright.js';

const roundTrip = (v) => (0, eval)(`(${toSource(v)})`); // eslint-disable-line no-eval

test('page arguments keep what JSON would lose, as Playwright does', () => {
  assert.deepEqual(roundTrip(['/api/v1/hero', undefined, 'GET']), ['/api/v1/hero', undefined, 'GET']);
  assert.equal(roundTrip(['x', undefined])[1], undefined);
  assert.ok(Number.isNaN(roundTrip(NaN)));
  assert.equal(roundTrip(-Infinity), -Infinity);
  assert.ok(Object.is(roundTrip(-0), -0));
  assert.equal(roundTrip(new Date(5)).getTime(), 5);
  assert.deepEqual(roundTrip({ a: 1, 'b-c': [null, 'q"uote '], d: { e: true } }), { a: 1, 'b-c': [null, 'q"uote '], d: { e: true } });
  assert.ok('k' in roundTrip({ k: undefined }));
  const loop = [];
  loop.push(loop);
  assert.throws(() => toSource(loop), /circular/);
});
