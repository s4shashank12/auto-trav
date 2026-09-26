import { DEFAULT_CONFIG } from '../config.js';

export class ValidationError extends Error {}

// Settings whose keys are free-form (building gids, village names).
const MAP_PATHS = new Set(['train.units', 'train.overrides', 'research.overrides', 'smithy.overrides']);

const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

// Settings limited to a few values, and numbers limited to a range.
const CHOICES = {};
// Settings that no longer exist: dropped from saved configs instead of refused, so a config saved
// before they went can still be saved. (heroRaid.mode: the game only allows raids on oases.)
const REMOVED = new Set(['heroRaid.mode']);
const RANGES = {
  'heroRaid.radius': [1, 100], 'heroRaid.minHealth': [1, 100], 'heroRaid.maxLoss': [1, 99], 'smithy.maxLevel': [1, 20],
};

// Checks that config overrides only use known settings with the right types.
export function validateConfig(overrides, defaults = DEFAULT_CONFIG, prefix = '') {
  if (kind(overrides) !== 'object') throw new ValidationError(`${prefix || 'config'} must be an object`);
  for (const [key, value] of Object.entries(overrides)) {
    const pathName = prefix ? `${prefix}.${key}` : key;
    if (REMOVED.has(pathName)) {
      delete overrides[key];
      continue;
    }
    if (!(key in defaults)) throw new ValidationError(`Unknown setting "${pathName}"`);
    const expected = kind(defaults[key]);
    if (kind(value) !== expected) throw new ValidationError(`"${pathName}" must be ${expected === 'array' ? 'an array' : `a ${expected}`}`);
    if (expected === 'number' && !Number.isFinite(value)) throw new ValidationError(`"${pathName}" must be a finite number`);
    if (CHOICES[pathName] && !CHOICES[pathName].includes(value)) throw new ValidationError(`"${pathName}" must be one of ${CHOICES[pathName].join(', ')}`);
    const range = RANGES[pathName];
    if (range && (value < range[0] || value > range[1])) throw new ValidationError(`"${pathName}" must be between ${range[0]} and ${range[1]}`);
    if (expected === 'object' && !MAP_PATHS.has(pathName)) validateConfig(value, defaults[key], pathName);
  }
  return overrides;
}

const text = (value, name, { required = false, max = 200 } = {}) => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${name} is required`);
  if (value.length > max) throw new ValidationError(`${name} is too long`);
  return value.trim();
};

// Validates a server create (all required) or update (all optional) body.
export function validateServer(body, { create = false } = {}) {
  if (kind(body) !== 'object') throw new ValidationError('Body must be a JSON object');
  const out = {
    name: text(body.name, 'Name', { required: create, max: 60 }),
    url: text(body.url, 'Game world URL', { required: create }),
    username: text(body.username, 'Username', { required: create }),
    password: body.password === undefined || body.password === '' ? undefined : text(body.password, 'Password'),
    config: body.config === undefined ? undefined : validateConfig(body.config),
  };
  if (create && !out.password) throw new ValidationError('Password is required');
  if (out.url !== undefined) {
    let parsed;
    try {
      parsed = new URL(out.url);
    } catch {
      throw new ValidationError('Game world URL is not a valid URL');
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new ValidationError('Game world URL must start with http(s)://');
    out.url = parsed.origin;
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}
