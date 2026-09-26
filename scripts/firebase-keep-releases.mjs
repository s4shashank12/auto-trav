#!/usr/bin/env node
// Tells Firebase Hosting to keep only the newest KEEP_BUILDS releases of a site; older ones are
// deleted by Firebase. Used by .github/workflows/release.yml after each deploy.
//   SERVICE_ACCOUNT  the service account JSON key (Firebase Hosting Admin)
//   SITE             the Hosting site id (usually the project id)
//   KEEP_BUILDS      how many releases to keep (default 5)
import crypto from 'node:crypto';

const sa = JSON.parse(process.env.SERVICE_ACCOUNT ?? '{}');
const site = process.env.SITE;
const keep = Number(process.env.KEEP_BUILDS ?? 5);
if (!sa.client_email || !sa.private_key || !site) {
  console.error('SERVICE_ACCOUNT (JSON key) and SITE are required.');
  process.exit(1);
}

// OAuth access token for the service account (JWT bearer grant), without needing gcloud.
const now = Math.floor(Date.now() / 1000);
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
  iss: sa.client_email,
  scope: 'https://www.googleapis.com/auth/cloud-platform',
  aud: 'https://oauth2.googleapis.com/token',
  iat: now,
  exp: now + 600,
})}`;
const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
});
if (!tokenRes.ok) {
  console.error(`Token request failed: ${tokenRes.status} ${await tokenRes.text()}`);
  process.exit(1);
}
const { access_token: token } = await tokenRes.json();

const res = await fetch(`https://firebasehosting.googleapis.com/v1beta1/sites/${site}/config?updateMask=maxVersions`, {
  method: 'PATCH',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ maxVersions: keep }),
});
if (!res.ok) {
  console.error(`Updating ${site} failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`Firebase Hosting site ${site} keeps the newest ${keep} releases.`);
