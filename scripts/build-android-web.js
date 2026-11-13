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
const APP_STYLES = '<link rel="stylesheet" href="styles.css">';

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

  fs.copyFileSync(path.join(root, 'platform', 'android', 'android.css'), path.join(outDir, 'android.css'));

  // The page itself: sized to the device, with the Android styles and script added.
  const page = path.join(outDir, 'index.html');
  let html = fs.readFileSync(page, 'utf8');
  for (const [mark, replacement] of [
    [APP_SCRIPT, '<script src="platform-android.js"></script>\n' + APP_SCRIPT],
    [APP_STYLES, '<meta name="viewport" content="width=device-width, initial-scale=1">\n  ' + APP_STYLES + '\n  <link rel="stylesheet" href="android.css">'],
  ]) {
    if (!html.includes(mark)) throw new Error(`src/index.html no longer has ${mark}`);
    html = html.replace(mark, replacement);
  }
  fs.writeFileSync(page, html);
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
