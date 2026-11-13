'use strict';
/*
 * Vibe TV starts here, before anything else.
 *
 * Its one job is that a broken release can always be fixed by the next one. It loads the app
 * (main.js); if that throws, crashes before the app is up, or the app never reports that its window
 * came up, it opens a small recovery window instead. The recovery window looks for a newer version on
 * GitHub, downloads it and restarts into it, whatever the update settings say. A version that failed
 * to start twice in a row goes straight to recovery.
 *
 * Keep this file small and independent: it uses only Electron, electron-updater and lib/startup.js,
 * so a mistake elsewhere in the app can't stop it from working. Every release runs it both ways
 * (normal start, and a simulated broken start) before anything is published.
 */
const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { decide, sanitize, issueUrl } = require('./lib/startup');

const HEALTHY_WITHIN = 40000; // ms the app has to report that its window is up
const RECHECK_EVERY = 30 * 60 * 1000;
const SMOKE = process.env.VIBE_TV_SMOKE_TEST === '1';
const SIMULATE = process.env.VIBE_TV_SIMULATE_CRASH || ''; // 'startup': pretend the app failed to load
const forced = process.argv.includes('--force-start');

// Same data folder the app uses (it can be moved for tests or portable setups).
const dataDir = process.env.VIBE_TV_USER_DATA || process.env.M3U_PLAYER_USER_DATA;
if (dataDir) app.setPath('userData', dataDir);

let healthy = false;
let recovering = false;
let recoveryWin = null;
let failure = '';

/* ───────── launch checks (Release workflow) ───────── */

function smoke(ok, message) {
  if (!SMOKE) return;
  const line = `${ok ? 'VIBE_TV_SMOKE_OK' : 'VIBE_TV_SMOKE_FAIL'} ${message}`;
  console.log(line);
  if (process.env.VIBE_TV_SMOKE_RESULT) {
    try { fs.writeFileSync(process.env.VIBE_TV_SMOKE_RESULT, line + '\n'); } catch (e) { /* the exit code still says it */ }
  }
  app.exit(ok ? 0 : 1);
}

/* ───────── what earlier starts left behind ───────── */

const stateFile = () => path.join(app.getPath('userData'), 'startup.json');
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { return {}; }
}
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(s));
  } catch (e) { /* not being able to remember is no reason to stop */ }
}

const describe = (e) => sanitize((e && e.stack) || String(e), app.getPath('home'));

/* ───────── the app reports in ───────── */

// main.js calls these: healthy() once the window's page has started, smoke() for launch checks.
global.vibeBoot = {
  healthy() {
    if (healthy || recovering) return;
    healthy = true;
    writeState({ version: app.getVersion(), failures: 0, lastError: '' });
  },
  smoke,
  get recovering() { return recovering; },
};

/* ───────── recovery ───────── */

function releaseRepo() {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const owner = (/^owner:\s*(\S+)/m.exec(yml) || [])[1];
    const repo = (/^repo:\s*(\S+)/m.exec(yml) || [])[1];
    if (owner && repo) return { owner, repo };
  } catch (e) { /* from source */ }
  try {
    const p = require('./package.json').build.publish[0];
    if (p.owner && p.repo) return { owner: p.owner, repo: p.repo };
  } catch (e) { /* no build settings */ }
  return { owner: 'kleantzogu', repo: 'Vibe-Tv' };
}

const status = { stage: 'checking', version: '', progress: 0, error: '', current: app.getVersion() };
function setStatus(patch) {
  Object.assign(status, patch);
  if (recoveryWin && !recoveryWin.isDestroyed()) recoveryWin.webContents.send('recovery:status', status);
}

let updater = null;
function lookForFix() {
  if (!updater) {
    try {
      updater = require('electron-updater').autoUpdater;
    } catch (e) {
      return setStatus({ stage: 'error', error: 'The updater could not be loaded: ' + describe(e) });
    }
    updater.logger = null;
    updater.autoDownload = true; // in recovery the fix is fetched whatever the settings say
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    if (process.env.VIBE_TV_UPDATE_URL) {
      updater.forceDevUpdateConfig = true;
      updater.setFeedURL({ provider: 'generic', url: process.env.VIBE_TV_UPDATE_URL });
    }
    updater.on('checking-for-update', () => setStatus({ stage: 'checking', error: '' }));
    updater.on('update-not-available', () => setStatus({ stage: 'none' }));
    updater.on('update-available', (i) => setStatus({ stage: 'downloading', version: i.version, progress: 0 }));
    updater.on('download-progress', (p) => setStatus({ stage: 'downloading', progress: Math.round(p.percent || 0) }));
    updater.on('update-downloaded', (i) => setStatus({ stage: 'ready', version: i.version, progress: 100 }));
    updater.on('error', (e) => setStatus({ stage: 'error', error: sanitize(e && e.message, app.getPath('home')) }));
    setInterval(() => { if (status.stage === 'none' || status.stage === 'error') lookForFix(); }, RECHECK_EVERY).unref();
  }
  if (!app.isPackaged && !process.env.VIBE_TV_UPDATE_URL) {
    return setStatus({ stage: 'error', error: 'This copy runs from source: pull the latest code instead.' });
  }
  updater.checkForUpdates().catch((e) => setStatus({ stage: 'error', error: sanitize(e && e.message, app.getPath('home')) }));
}

function enterRecovery(reason, details) {
  if (recovering) return;
  recovering = true;
  failure = details || failure || '';
  const saved = readState();
  writeState({ ...saved, version: app.getVersion(), lastError: failure.slice(0, 2000) });
  if (SMOKE && !SIMULATE) return smoke(false, `${reason} ${failure}`.slice(0, 600));

  const open = () => {
    recoveryWin = new BrowserWindow({
      width: 520,
      height: 460,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Vibe TV',
      show: false,
      backgroundColor: '#1d1d1f',
      webPreferences: {
        preload: path.join(__dirname, 'src', 'recovery-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Whatever the broken app opened goes away; the recovery window is the one to look at.
    for (const w of BrowserWindow.getAllWindows()) if (w !== recoveryWin) w.destroy();
    recoveryWin.once('ready-to-show', () => recoveryWin.show());
    recoveryWin.on('closed', () => { recoveryWin = null; app.quit(); });
    recoveryWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    recoveryWin.webContents.on('will-navigate', (e) => e.preventDefault());
    recoveryWin.webContents.once('did-finish-load', () => {
      setStatus({ reason });
      lookForFix();
      if (SMOKE) {
        setTimeout(async () => {
          const ok = await recoveryWin.webContents.executeJavaScript("!!document.querySelector('#title') && !!window.recovery").catch(() => false);
          smoke(ok, ok ? `recovery ${app.getVersion()} ${process.platform}` : 'the recovery window did not come up');
        }, 2500);
      }
    });
    recoveryWin.loadFile(path.join(__dirname, 'src', 'recovery.html'));
  };
  app.isReady() ? open() : app.whenReady().then(open);
}

ipcMain.handle('recovery:get', () => ({
  ...status,
  current: app.getVersion(),
  details: failure,
  releases: `https://github.com/${releaseRepo().owner}/${releaseRepo().repo}/releases/latest`,
}));
ipcMain.handle('recovery:check', () => lookForFix());
ipcMain.handle('recovery:install', () => {
  if (status.stage === 'ready' && updater) updater.quitAndInstall(false, true);
});
ipcMain.handle('recovery:retry', () => {
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--force-start').concat('--force-start') });
  app.exit(0);
});
ipcMain.handle('recovery:copy', () => clipboard.writeText(`Vibe TV ${app.getVersion()} (${process.platform} ${process.arch})\n${failure}`));
ipcMain.handle('recovery:releases', () => {
  const { owner, repo } = releaseRepo();
  return shell.openExternal(`https://github.com/${owner}/${repo}/releases/latest`);
});
ipcMain.handle('recovery:report', () =>
  shell.openExternal(issueUrl(releaseRepo(), { version: app.getVersion(), platform: process.platform, arch: process.arch, error: failure }))
);

/* ───────── start ───────── */

// A second copy (Vibe TV opened while it's running) hands over to the first and quits; it must not
// count as a failed start.
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// Errors before the app is up mean it can't start: recover. After that, they're the app's business
// (logged, not fatal), so a small mistake somewhere doesn't take the whole app down.
process.on('uncaughtException', (e) => {
  if (!healthy) return enterRecovery('It ran into a problem while opening.', describe(e));
  console.error('Vibe TV:', e);
});

const plan = decide(readState(), app.getVersion(), forced);
if (plan.recover) {
  failure = plan.lastError;
  enterRecovery('It didn’t open the last two times, so this time it looks for a fix first.', plan.lastError);
} else {
  writeState({ version: app.getVersion(), failures: plan.failures, lastError: plan.lastError });
  try {
    if (SIMULATE === 'startup') throw new Error('Simulated startup failure (VIBE_TV_SIMULATE_CRASH=startup)');
    require('./main.js');
    // Loaded, but it still has to come up: if its window never reports in, offer recovery.
    setTimeout(() => {
      if (!healthy && !recovering) enterRecovery('It took too long to open.', failure || 'The window never finished starting.');
    }, HEALTHY_WITHIN).unref();
  } catch (e) {
    enterRecovery('Something in this version stops it from opening.', describe(e));
  }
}
