import {
  createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto';

// Travian passwords are stored encrypted with a key derived from APP_SECRET (AES-256-GCM).
export function makeCipher(appSecret) {
  const key = scryptSync(appSecret, 'auto-travian:v1', 32);
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
    },
    decrypt(stored) {
      if (!stored?.startsWith('v1:')) throw new Error('Unknown secret format');
      const raw = Buffer.from(stored.slice(3), 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

// Compares two secrets without leaking their length or content through timing.
export function safeEqual(a, b) {
  const digest = (s) => createHash('sha256').update(String(s)).digest();
  return timingSafeEqual(digest(a), digest(b));
}
