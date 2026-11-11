'use strict';
/*
 * `npm start`: runs Vibe TV from source.
 *
 * On macOS the menu bar, the About box, the Dock and the app switcher take the app's name and icon
 * from the app bundle that is running, and from source that is Electron's own Electron.app. So the
 * first start makes a copy of it called "Vibe TV" with the app's icon, in .dev/ (an APFS clone, so it
 * is instant and takes no extra space), and runs that. node_modules is left as it is. The copy is made
 * again when Electron or the icon changes. Other systems run Electron directly.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const electron = require('electron'); // path of the Electron executable

const root = path.join(__dirname, '..');

function devBundle() {
  const source = path.resolve(path.dirname(electron), '..', '..'); // …/Electron.app
  const icon = path.join(root, 'build', 'icon.icns');
  const dir = path.join(root, '.dev');
  const bundle = path.join(dir, 'Vibe TV.app');
  const exe = path.join(bundle, 'Contents', 'MacOS', path.basename(electron));
  const stampFile = path.join(dir, 'stamp.json');
  const stamp = JSON.stringify({ electron: require('electron/package.json').version, icon: fs.statSync(icon).mtimeMs });
  if (fs.existsSync(exe) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp) return exe;

  fs.rmSync(bundle, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    execFileSync('cp', ['-cR', source, bundle]); // clone on APFS
  } catch (e) {
    execFileSync('cp', ['-R', source, bundle]);
  }
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  for (const [key, value] of [
    ['CFBundleName', 'Vibe TV'],
    ['CFBundleDisplayName', 'Vibe TV'],
    ['CFBundleIdentifier', 'com.vibetv.app.dev'],
  ]) {
    execFileSync('plutil', ['-replace', key, '-string', value, plist]);
  }
  fs.copyFileSync(icon, path.join(bundle, 'Contents', 'Resources', 'electron.icns'));
  // The edits above break Electron's signature; sign the copy again for this computer only.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'ignore' });
  fs.writeFileSync(stampFile, stamp);
  return exe;
}

let bin = electron;
if (process.platform === 'darwin') {
  try {
    bin = devBundle();
  } catch (e) {
    console.warn(`Starting as "Electron" (couldn't prepare the Vibe TV copy: ${e.message})`);
  }
}

const child = spawn(bin, [root, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('close', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
