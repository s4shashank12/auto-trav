// node:path for the engine: the few helpers the bot uses, on '/'-separated relative paths.
export const sep = '/';

export function join(...parts) {
  const segments = [];
  for (const part of parts.join('/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

export const resolve = (...parts) => join(...parts);
export const basename = (p) => String(p).split('/').filter(Boolean).pop() ?? '';
export const dirname = (p) => String(p).split('/').slice(0, -1).join('/') || '.';

export default {
  sep, join, resolve, basename, dirname,
};
