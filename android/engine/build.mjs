// Bundles the engine (src/main.js) with the bot it runs (../../src) into one script for the
// app's engine WebView. Playwright, node:fs and node:path are swapped for the Android shims.
//   ENGINE_OUT   output folder (default: dist)
//   APP_VERSION  version shown in the dashboard
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.env.ENGINE_OUT ?? path.join(here, 'dist'));
const version = process.env.APP_VERSION || 'dev';

const shims = {
  playwright: 'shims/playwright.js',
  fs: 'shims/fs.js',
  'fs/promises': 'shims/fs.js',
  path: 'shims/path.js',
};

const androidShims = {
  name: 'android-shims',
  setup(b) {
    b.onResolve({ filter: /^(node:)?(fs|fs\/promises|path)$|^playwright$/ }, (args) => {
      const name = args.path.replace(/^node:/, '');
      return { path: path.join(here, 'src', shims[name]) };
    });
    // The server-only modules must never end up in the phone's bundle.
    b.onResolve({ filter: /^(express|pg|node:.*)$/ }, (args) => ({
      errors: [{ text: `${args.path} is not available in the Android engine (imported from ${args.importer})` }],
    }));
  },
};

await mkdir(out, { recursive: true });
await build({
  entryPoints: [path.join(here, 'src/main.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  // Modern syntax as written: functions sent to game pages (page.evaluate) are serialised with
  // toString(), so they must not be rewritten to use bundler helpers.
  target: 'es2022',
  minify: false,
  keepNames: false,
  legalComments: 'none',
  banner: { js: 'globalThis.process = globalThis.process || { env: {} };' },
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [androidShims],
  outfile: path.join(out, 'engine.js'),
  logLevel: 'warning',
});
await copyFile(path.join(here, 'index.html'), path.join(out, 'index.html'));
console.log(`Engine ${version} built into ${out}`);
