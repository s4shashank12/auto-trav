// End-to-end checks of the Android engine in Node: the real bot (src/) running through the
// WebView shim against a mock game world, with the app's side played by harness.js.
import assert from 'node:assert/strict';
import {
  after, before, describe, test,
} from 'node:test';
import { bundleEngine, startEngine, until } from './harness.js';
import { startMockTravian } from './mock-travian.js';

const ONLY_BUILD = {
  features: {
    build: true, supply: true, hero: true, train: false, reinforce: false, raid: false, research: false, smithy: false, heroRaid: false,
  },
};

let source;
let world;

before(async () => {
  source = await bundleEngine();
  world = await startMockTravian({ password: 'secret' });
});

after(async () => {
  await world?.close();
});

const newServer = (engine, username, extra = {}) => engine.api('POST', '/api/servers', {
  name: `Acc ${username}`, url: world.url, username, password: 'secret', config: ONLY_BUILD, ...extra,
});

const events = async (engine, id) => (await engine.api('GET', `/api/servers/${id}/events?limit=500`)).body.map((e) => e.message);

const actionDone = (engine, id, action) => until(async () => {
  const log = await events(engine, id);
  return log.some((m) => m === `Action ${action} finished.` || m.startsWith(`Action ${action} failed`)) && log;
}, 240_000, `action ${action}`);

describe('API', () => {
  let engine;
  before(async () => { engine = await startEngine({ source }); });
  after(async () => { await engine.close(); });

  test('meta, create, validate, update and delete servers', async () => {
    const meta = await engine.api('GET', '/api/meta');
    assert.equal(meta.status, 200);
    assert.equal(meta.body.platform, 'android');
    assert.ok(meta.body.actions.includes('farm-setup'));
    assert.ok(meta.body.defaults.raid);

    const bad = await engine.api('POST', '/api/servers', { name: 'x', url: 'nope', username: 'u' });
    assert.equal(bad.status, 400);

    const created = await newServer(engine, 'api-user');
    assert.equal(created.status, 201);
    assert.equal(created.body.hasPassword, true);
    assert.equal(created.body.enabled, false);
    assert.equal(created.body.password, undefined);
    const stored = engine.db.prepare('select password_enc from servers where id = ?').get(created.body.id);
    assert.ok(!stored.password_enc.includes('secret'), 'password is stored encrypted');

    const badConfig = await engine.api('PATCH', `/api/servers/${created.body.id}`, { config: { raid: { everyMinutes: 'often' } } });
    assert.equal(badConfig.status, 400);
    const patched = await engine.api('PATCH', `/api/servers/${created.body.id}`, { config: { raid: { everyMinutes: 15 } } });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.config, { raid: { everyMinutes: 15 } });

    const one = await engine.api('GET', `/api/servers/${created.body.id}`);
    assert.equal(one.body.effectiveConfig.raid.everyMinutes, 15);
    assert.equal(one.body.effectiveConfig.raid.cycleMinutes, 10);

    const list = await engine.api('GET', '/api/servers');
    assert.equal(list.body.length, 1);
    assert.equal((await engine.api('GET', '/api/servers/999')).status, 404);
    assert.equal((await engine.api('GET', '/api/nope')).status, 404);

    const inactive = await engine.api('GET', `/api/servers/${created.body.id}/inactives`);
    assert.equal(inactive.body.reason, 'no-villages');

    assert.equal((await engine.api('DELETE', `/api/servers/${created.body.id}`)).status, 204);
    assert.equal((await engine.api('GET', '/api/servers')).body.length, 0);
  });
});

describe('playing through WebView profiles', () => {
  let engine;
  before(async () => { engine = await startEngine({ source, multiProfile: true }); });
  after(async () => { await engine.close(); });

  test('a build action logs in, ships resources, uses the hero and queues jobs', async () => {
    const acc = world.account('builder');
    acc.short.add(1); // the first field is short of resources: the hero covers it
    const { body: server } = await newServer(engine, 'builder');
    const res = await engine.api('POST', `/api/servers/${server.id}/actions`, { action: 'build' });
    assert.equal(res.status, 202);
    const log = await actionDone(engine, server.id, 'build');
    assert.ok(log.includes('Action build finished.'), log.join('\n'));
    assert.ok(log.some((m) => /Transferred from hero: 120 lumber/.test(m)), 'hero transfer seen through waitForResponse');
    assert.deepEqual(acc.heroTransfers, [1]);
    assert.deepEqual(acc.builds.map((b) => b.id), [1, 26, 2], 'field, building, field (Roman queue)');
    assert.ok(acc.builds.every((b) => b.did === 101));
    assert.equal(acc.shipments.length, 1, 'small village supplied from the big one');
    assert.equal(acc.shipments[0].x, 1);
    assert.equal(acc.shipments[0].y, 2);

    const { body: detail } = await engine.api('GET', `/api/servers/${server.id}`);
    assert.equal(detail.snapshot.tribe, 1);
    assert.deepEqual(detail.snapshot.villages.map((v) => [v.name, v.x, v.y, v.population, v.capital]), [
      ['builder-Alpha', 1, 2, 120, true], ['builder-Beta', -3, 4, 900, false],
    ]);
    assert.equal(detail.snapshot.queues['builder-Alpha'].length, 3);
    assert.equal(detail.status, 'stopped');
    assert.ok(engine.statuses.length > 0, 'the app hears about state changes');
  });

  test('the hero goes through the rally point to raid an oasis with animals', async () => {
    const acc = world.account('hero-user');
    const { body: server } = await newServer(engine, 'hero-user', { config: { features: { heroRaid: true } } });
    await engine.api('POST', `/api/servers/${server.id}/actions`, { action: 'hero' });
    const log = await actionDone(engine, server.id, 'hero');
    assert.ok(log.includes('Action hero finished.'), log.join('\n'));
    assert.ok(log.some((m) => /Hero: raiding the oasis at \(3\|2\).*3 Rat/.test(m)), log.join('\n'));
    assert.deepEqual(acc.heroSent, [{
      x: 3, y: 2, eventType: '4', hero: '1',
    }]);
    const { body: detail } = await engine.api('GET', `/api/servers/${server.id}`);
    assert.equal(detail.snapshot.hero.action.type, 'oasis');
  });

  test('accounts keep their own cookies (one profile each)', async () => {
    const { body: a } = await newServer(engine, 'iso-a');
    const { body: b } = await newServer(engine, 'iso-b');
    await Promise.all([
      engine.api('POST', `/api/servers/${a.id}/actions`, { action: 'villages' }),
      engine.api('POST', `/api/servers/${b.id}/actions`, { action: 'villages' }),
    ]);
    await actionDone(engine, a.id, 'villages');
    await actionDone(engine, b.id, 'villages');
    const names = async (id) => (await engine.api('GET', `/api/servers/${id}`)).body.snapshot.villages.map((v) => v.name);
    assert.deepEqual(await names(a.id), ['iso-a-Alpha', 'iso-a-Beta']);
    assert.deepEqual(await names(b.id), ['iso-b-Alpha', 'iso-b-Beta']);
  });

  test('a running account plays rounds; a CAPTCHA stops it', async () => {
    const acc = world.account('looper');
    const { body: server } = await newServer(engine, 'looper', { config: { ...ONLY_BUILD, features: { ...ONLY_BUILD.features, supply: false } } });
    await engine.api('POST', `/api/servers/${server.id}/start`);
    await until(async () => (await engine.api('GET', `/api/servers/${server.id}`)).body.status === 'sleeping', 240_000, 'first round');
    const { body: slept } = await engine.api('GET', `/api/servers/${server.id}`);
    assert.equal(slept.enabled, true);
    assert.ok(new Date(slept.nextRunAt) > new Date(), 'next round scheduled');
    assert.ok(acc.builds.length >= 1);
    assert.ok(engine.statuses.at(-1).running >= 1, 'the app keeps the phone awake for it');

    // Wake it up early with the CAPTCHA on: the worker stops and disables the account.
    acc.captcha = true;
    const worker = await engine.api('POST', `/api/servers/${server.id}/actions`, { action: 'villages' });
    assert.equal(worker.status, 202);
    await until(async () => (await events(engine, server.id)).some((m) => /CAPTCHA/.test(m)), 120_000, 'captcha');
    const shots = await engine.api('GET', `/api/servers/${server.id}/screenshots`);
    assert.ok(shots.body.some((f) => f.endsWith('-captcha.png')), JSON.stringify(shots.body));
    const shot = await engine.api('GET', `/api/servers/${server.id}/screenshots/${shots.body[0]}`);
    assert.match(shot.body.dataUrl, /^data:image\/png;base64,iVBOR/);
    await engine.api('POST', `/api/servers/${server.id}/stop`);
    await until(async () => (await engine.api('GET', `/api/servers/${server.id}`)).body.status === 'stopped', 120_000, 'stop');
    acc.captcha = false;
  });
});

describe('playing without WebView profiles (shared cookie jar)', () => {
  let engine;
  before(async () => { engine = await startEngine({ source, multiProfile: false }); });
  after(async () => { await engine.close(); });

  test('accounts take turns and get their own cookies back', async () => {
    const { body: a } = await newServer(engine, 'jar-a');
    const { body: b } = await newServer(engine, 'jar-b');
    await Promise.all([
      engine.api('POST', `/api/servers/${a.id}/actions`, { action: 'villages' }),
      engine.api('POST', `/api/servers/${b.id}/actions`, { action: 'villages' }),
    ]);
    await actionDone(engine, a.id, 'villages');
    await actionDone(engine, b.id, 'villages');
    const names = async (id) => (await engine.api('GET', `/api/servers/${id}`)).body.snapshot.villages.map((v) => v.name);
    assert.deepEqual(await names(a.id), ['jar-a-Alpha', 'jar-a-Beta']);
    assert.deepEqual(await names(b.id), ['jar-b-Alpha', 'jar-b-Beta']);

    // Account a again: its saved cookies are put back, so it does not log in a second time.
    const logins = () => world.log.filter((l) => l === 'POST /api/v1/auth/login').length;
    const before2 = logins();
    await engine.api('POST', `/api/servers/${a.id}/actions`, { action: 'villages' });
    await until(async () => (await events(engine, a.id)).filter((m) => m === 'Action villages finished.').length === 2, 120_000, 'second action');
    assert.equal(logins(), before2, 'logged in with the saved cookies');
    assert.deepEqual(await names(a.id), ['jar-a-Alpha', 'jar-a-Beta']);
  });
});
