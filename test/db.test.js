import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainDbError, poolOptions, sslMode } from '../src/server/db.js';
import { loadEnv } from '../src/server/env.js';

const env = (vars) => loadEnv({ ADMIN_TOKEN: 'x'.repeat(16), APP_SECRET: 'y'.repeat(16), ...vars });
const files = { '/certs/ca.pem': 'CA PEM', '/certs/client.pem': 'CERT PEM', '/certs/client.key': 'KEY PEM' };
const read = (file) => {
  if (!(file in files)) throw new Error(`ENOENT ${file}`);
  return files[file];
};
const opts = (vars) => poolOptions(env(vars), read);

test('sslMode accepts the libpq names and common booleans', () => {
  assert.equal(sslMode(''), null);
  assert.equal(sslMode('false'), 'disable');
  assert.equal(sslMode('TRUE'), 'require');
  assert.equal(sslMode('prefer'), 'require');
  assert.equal(sslMode('no-verify'), 'require');
  assert.equal(sslMode('verify-ca'), 'verify-ca');
  assert.equal(sslMode('verify'), 'verify-full');
  assert.throws(() => sslMode('maybe'), /unknown SSL mode/);
});

test('no SSL unless asked for', () => {
  assert.equal(opts({ DATABASE_URL: 'postgres://u:p@db:5432/travian' }).ssl, false);
  assert.equal(opts({ DATABASE_URL: 'postgres://u:p@db/travian', DATABASE_SSL: 'false' }).ssl, false);
});

test('sslmode=require in the URL encrypts without verifying, and is removed from the URL', () => {
  const o = opts({ DATABASE_URL: 'postgres://u:p%40ss@db.example.com:5432/travian?sslmode=require&application_name=bot' });
  assert.equal(o.connectionString, 'postgres://u:p%40ss@db.example.com:5432/travian?application_name=bot');
  assert.deepEqual(o.ssl, { rejectUnauthorized: false });
  assert.equal(o.sslMode, 'require');
  assert.equal(opts({ DATABASE_URL: 'postgres://u:p@db/travian?ssl=true' }).sslMode, 'require');
});

test('DATABASE_SSL wins over the URL, which wins over PGSSLMODE', () => {
  assert.equal(opts({ DATABASE_URL: 'postgres://u:p@db/t?sslmode=require', DATABASE_SSL: 'disable' }).ssl, false);
  assert.equal(opts({ DATABASE_URL: 'postgres://u:p@db/t?sslmode=disable', PGSSLMODE: 'require' }).ssl, false);
  assert.equal(opts({ PGSSLMODE: 'require' }).sslMode, 'require');
});

test('a CA turns on verification; verify-ca ignores the host name, verify-full checks it', () => {
  const ca = opts({ DATABASE_URL: 'postgres://u:p@10.1.2.3/t', DATABASE_SSL_CA: '/certs/ca.pem' });
  assert.equal(ca.sslMode, 'verify-ca');
  assert.equal(ca.ssl.rejectUnauthorized, true);
  assert.equal(ca.ssl.ca, 'CA PEM');
  assert.equal(ca.ssl.checkServerIdentity(), undefined);

  const full = opts({ DATABASE_URL: 'postgres://u:p@db.example.com/t', DATABASE_SSL: 'verify-full', DATABASE_SSL_CA: '/certs/ca.pem' });
  assert.equal(full.sslMode, 'verify-full');
  assert.equal(full.ssl.checkServerIdentity, undefined, 'pg checks host names itself');
  const ip = opts({ DATABASE_URL: 'postgres://u:p@10.1.2.3/t', DATABASE_SSL: 'verify-full' });
  assert.equal(typeof ip.ssl.checkServerIdentity, 'function', 'IP addresses are checked against the address');

  const fromUrl = opts({ DATABASE_URL: 'postgres://u:p@db/t?sslmode=verify-ca&sslrootcert=/certs/ca.pem' });
  assert.equal(fromUrl.sslMode, 'verify-ca');
  assert.equal(fromUrl.ssl.ca, 'CA PEM');
  assert.equal(fromUrl.connectionString, 'postgres://u:p@db/t');
  assert.equal(opts({ DATABASE_URL: 'postgres://u:p@db/t?sslrootcert=system' }).sslMode, 'verify-full');
});

test('client certificates from files, the URL or inline PEM', () => {
  const o = opts({ DATABASE_URL: 'postgres://u@db/t', DATABASE_SSL_CERT: '/certs/client.pem', DATABASE_SSL_KEY: '/certs/client.key' });
  assert.equal(o.sslMode, 'require');
  assert.equal(o.ssl.cert, 'CERT PEM');
  assert.equal(o.ssl.key, 'KEY PEM');
  const url = opts({ DATABASE_URL: 'postgres://u@db/t?sslmode=require&sslcert=/certs/client.pem&sslkey=/certs/client.key' });
  assert.equal(url.ssl.cert, 'CERT PEM');
  const inline = opts({ DATABASE_URL: 'postgres://u@db/t', DATABASE_SSL: 'verify-full', DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----' });
  assert.equal(inline.ssl.ca, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----');
  assert.throws(() => opts({ DATABASE_URL: 'postgres://u@db/t', DATABASE_SSL_CA: '/missing.pem' }), /ENOENT/);
});

test('explainDbError points at the setting to change', () => {
  assert.match(explainDbError(new Error('pg_hba.conf rejects connection for host "1.2.3.4", no encryption')), /DATABASE_SSL=require/);
  assert.match(explainDbError(new Error('self-signed certificate in certificate chain')), /DATABASE_SSL_CA/);
  assert.match(explainDbError(new Error('connection requires a valid client certificate')), /DATABASE_SSL_CERT/);
  assert.match(explainDbError(new Error('The server does not support SSL connections')), /DATABASE_SSL=false/);
  assert.equal(explainDbError(new Error('password authentication failed')), 'password authentication failed');
});
