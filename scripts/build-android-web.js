'use strict';
/*
 * `npm run build:android-web`: makes www/, the web app that the Android shell (Capacitor) wraps.
 *
 * www/ is the same window as on a computer (a copy of src/) plus one extra script,
 * platform-android.js, which stands in for preload.js + main.js: it is platform/android/ and the
 * lib/ modules it needs, bundled into a single file. The page's Content-Security-Policy stays as it
 * is (scripts from the app only, no inline scripts, no eval), so the bundle is a plain script.
 *
 * Nothing from Node may end up in the bundle: the build fails if a module still needs fs, path, …
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// Only used on a computer: the window shown when the app cannot start.
const DESKTOP_ONLY = new Set(['recovery.html', 'recovery-preload.js']);
const APP_SCRIPT = '<script src="app.js"></script>';

async function build(outDir = path.join(root, 'www')) {
  const esbuild = require('esbuild');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'src'), outDir, {
    recursive: true,
    filter: (from) => !DESKTOP_ONLY.has(path.basename(from)) && path.basename(from) !== '.DS_Store',
  });

  await esbuild.build({
    entryPoints: [path.join(root, 'platform', 'android', 'platform-android.js')],
    outfile: path.join(outDir, 'platform-android.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    inject: [path.join(root, 'platform', 'android', 'shims.js')],
    legalComments: 'inline',
    logLevel: 'warning',
  });

  const page = path.join(outDir, 'index.html');
  const html = fs.readFileSync(page, 'utf8');
  if (!html.includes(APP_SCRIPT)) throw new Error(`src/index.html no longer loads app.js with ${APP_SCRIPT}`);
  fs.writeFileSync(page, html.replace(APP_SCRIPT, '<script src="platform-android.js"></script>\n' + APP_SCRIPT));
  return outDir;
}

module.exports = { build };

if (require.main === module) {
  build().then(
    (dir) => console.log(`Built ${path.relative(root, dir) || dir}/`),
    (e) => {
      console.error(e.message || e);
      process.exit(1);
    }
  );
}
