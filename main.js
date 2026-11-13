'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, nativeTheme, systemPreferences, session, net } = require('electron');

// boot.js loads this file and keeps a way to recover if it fails. Tell it when the window is up, and
// report launch checks (VIBE_TV_SMOKE_TEST=1: start, make sure the page came up, quit) through it.
const boot = global.vibeBoot || { healthy() {}, smoke(ok, m) { console.log(ok ? 'VIBE_TV_SMOKE_OK ' + m : 'VIBE_TV_SMOKE_FAIL ' + m); app.exit(ok ? 0 : 1); } };
const SMOKE = process.env.VIBE_TV_SMOKE_TEST === '1';
const smokeFail = (why) => boot.smoke(false, why);
const fs = require('fs');
const path = require('path');

const { Store } = require('./lib/store');
const storage = require('./lib/storage-node');
const { DEFAULTS, pruneStatus, applyPatch } = require('./lib/state');
const { createImports, decodeText } = require('./lib/imports');
const { describe } = require('./lib/net');
const { ChannelDb } = require('./lib/channeldb');
const { probe, checkAll } = require('./lib/probe');
const { readFileRetry, explainReadError } = require('./lib/readfile');
const { Library } = require('./lib/library');
const { Converter } = require('./lib/convert');
const { Updates } = require('./lib/updates');
const codecs = require('./lib/codecs');

// Optional overrides (used by the automated tests; also handy for a portable setup).
// The M3U_PLAYER_* names are from before the app was called Vibe TV and still work.
const envVar = (name) => process.env['VIBE_TV_' + name] || process.env['M3U_PLAYER_' + name] || '';
if (envVar('USER_DATA')) app.setPath('userData', envVar('USER_DATA'));

// When a domain publishes an HTTPS DNS record (every Cloudflare-fronted host does), Chromium
// silently rewrites http:// requests to https:// on the same port. IPTV servers usually speak plain
// HTTP on a custom port (http://host:8080/user/pass/123), so the upgraded request fails with
// ERR_SSL_PROTOCOL_ERROR and the channel looks offline. Use stream addresses exactly as written.
app.commandLine.appendSwitch('disable-features', 'UseDnsHttpsSvcb');

const isMac = process.platform === 'darwin';

let win = null;
let store = null;
let channelDb = null;
let library = null;
let imports = null; // imports from addresses and Xtream logins (lib/imports.js)
let converter = null;
let updates = null;
// Where releases live: the GitHub repository in the publish settings, so a fork points at its own.
// Installed builds don't have package.json's "build" section (electron-builder leaves it out), but
// they carry app-update.yml with the same owner and repo.
function releaseRepo() {
  const pkg = require('./package.json');
  const fromBuild = pkg.build && Array.isArray(pkg.build.publish) && pkg.build.publish[0];
  if (fromBuild && fromBuild.owner && fromBuild.repo) return fromBuild;
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const owner = (/^owner:\s*(\S+)/m.exec(yml) || [])[1];
    const repo = (/^repo:\s*(\S+)/m.exec(yml) || [])[1];
    if (owner && repo) return { owner, repo };
  } catch (e) { /* running from source, or no update settings */ }
  const m = /github\.com\/([^/]+)\/([^/.#]+)/.exec(String((pkg.repository && pkg.repository.url) || pkg.repository || ''));
  if (m) return { owner: m[1], repo: m[2] };
  return { owner: 'kleantzogu', repo: 'Vibe-Tv' };
}
const { owner: GH_OWNER, repo: GH_REPO } = releaseRepo();
const RELEASES = `https://github.com/${GH_OWNER}/${GH_REPO}/releases`;
// Codecs the window decodes itself in an MPEG-TS stream, reported by the window when it starts.
let canPlayTs = { video: ['h264'], audio: ['aac', 'mp3'] };
let activeHeaders = null; // { referrer, userAgent } for the channel that is playing
let activeCheck = null;
let rendererReady = false;
let pendingOpen = []; // playlist files handed to us by the OS before the window was ready, to import

const fetchImpl = (url, opts) => net.fetch(url, opts);

// Chromium refuses requests that set Referer directly, so checks made from here carry the wanted
// Referer / User-Agent under private names; installStreamHooks() swaps them in on the way out.
const REFERER_MARK = 'x-m3u-referer';
const AGENT_MARK = 'x-m3u-user-agent';
const probeFetch = (url, opts = {}) => {
  const headers = {};
  for (const [k, v] of Object.entries(opts.headers || {})) {
    const name = k.toLowerCase();
    headers[name === 'referer' ? REFERER_MARK : name === 'user-agent' ? AGENT_MARK : k] = v;
  }
  return net.fetch(url, { ...opts, headers });
};
const cacheDir = () => path.join(app.getPath('userData'), 'cache');
const cacheFile = (name) => path.join(cacheDir(), name);

/* ───────────────────────────── settings ───────────────────────────── */

// The app used to be called "M3U Player", and its data folder was named after it. The first time
// Vibe TV starts, playlists, favorites and settings are copied over from that folder (which is left
// as it was).
function adoptOldData() {
  if (envVar('USER_DATA')) return;
  const now = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'M3U Player');
  if (old === now || fs.existsSync(path.join(now, 'settings.json')) || !fs.existsSync(path.join(old, 'settings.json'))) return;
  try {
    fs.mkdirSync(now, { recursive: true });
    for (const name of ['playlists', 'cache', 'settings.json']) { // settings last: its presence marks the copy as done
      const from = path.join(old, name);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(now, name), { recursive: true });
    }
  } catch (e) {
    console.error('Could not copy the data of M3U Player:', e.message);
  }
}

function openStore() {
  adoptOldData();
  store = new Store(path.join(app.getPath('userData'), 'settings.json'), DEFAULTS, storage);
  pruneStatus(store.data);
}

/* ───────────────────────────── playlists ───────────────────────────── */

async function readPlaylistFile(file) {
  try {
    return decodeText(await readFileRetry(file, { onWaiting: () => send('import:waiting', path.basename(file)) }));
  } catch (e) {
    throw new Error(explainReadError(e, file).long);
  }
}

// Playlists saved by older versions pointed at a file or address. Their channels are taken from the
// copy that version kept, or from the original, and then stored like any other playlist.
async function legacyText(p) {
  const copy = cacheFile(`playlist-${p.id}.m3u`);
  let text;
  try {
    text = decodeText(await fs.promises.readFile(copy));
  } catch (e) {
    text = p.kind === 'url' ? await imports.readPlaylistUrl(p.source) : await readPlaylistFile(p.source);
  }
  return text;
}

// Imports files into a playlist; with no playlist given, a new one is made, named after the first file.
function importFiles(playlistId, files) {
  files = files.filter((f) => typeof f === 'string' && f);
  return imports.importTexts(playlistId, files.map((f) => ({ name: path.basename(f), read: () => readPlaylistFile(path.resolve(f)) })));
}

/* ───────────────────────────── stream requests ───────────────────────────── */

// Streams are loaded by the page with XHR / <video>. Two things have to be fixed up on the way:
//  1. some channels only answer when a specific Referer / User-Agent is sent (#EXTVLCOPT lines);
//  2. streaming servers rarely send CORS headers, which the page would otherwise refuse.
function installStreamHooks() {
  const ses = session.defaultSession;
  const filter = { urls: ['http://*/*', 'https://*/*'] };
  const isStream = (d) => win && !win.isDestroyed() && d.webContentsId === win.webContents.id && (d.resourceType === 'xhr' || d.resourceType === 'media');
  const drop = (headers, name) => {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === name) delete headers[k];
  };

  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = details.requestHeaders;
    if (!isStream(details)) {
      // Requests made by this process (channel checks): apply the marked headers, if any.
      let changed = false;
      for (const k of Object.keys(headers)) {
        const name = k.toLowerCase();
        if (name !== REFERER_MARK && name !== AGENT_MARK) continue;
        const value = headers[k];
        delete headers[k];
        headers[name === REFERER_MARK ? 'Referer' : 'User-Agent'] = value;
        changed = true;
      }
      return callback(changed ? { requestHeaders: headers } : {});
    }
    drop(headers, 'origin'); // "file://" means nothing to a streaming server and some reject it
    if (activeHeaders) {
      if (activeHeaders.referrer) {
        drop(headers, 'referer');
        headers['Referer'] = activeHeaders.referrer;
        try { headers['Origin'] = new URL(activeHeaders.referrer).origin; } catch (e) { /* not a URL */ }
      }
      if (activeHeaders.userAgent) {
        drop(headers, 'user-agent');
        headers['User-Agent'] = activeHeaders.userAgent;
      }
    }
    callback({ requestHeaders: headers });
  });

  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    if (!isStream(details)) return callback({});
    const headers = details.responseHeaders || {};
    drop(headers, 'access-control-allow-origin');
    drop(headers, 'access-control-allow-credentials');
    headers['Access-Control-Allow-Origin'] = ['*'];
    callback({ responseHeaders: headers });
  });
}

// The window needs no camera, microphone, location, notifications and so on: only full screen for
// the player. Electron grants every permission unless told otherwise.
function restrictPermissions() {
  const ses = session.defaultSession;
  const allowed = (permission) => permission === 'fullscreen';
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed(permission));
}

/* ───────────────────────────── window ───────────────────────────── */

function accentColor() {
  try {
    const c = systemPreferences.getAccentColor ? systemPreferences.getAccentColor() : '';
    if (c && /^[0-9a-f]{6,8}$/i.test(c)) return '#' + c.slice(0, 6);
  } catch (e) { /* not available on this system */ }
  return '';
}

function send(channel, ...args) {
  if (win && !win.isDestroyed() && rendererReady) win.webContents.send(channel, ...args);
}

function createWindow() {
  const saved = store.data.window || {};
  win = new BrowserWindow({
    width: Math.max(940, saved.width || 1280),
    height: Math.max(560, saved.height || 800),
    x: Number.isFinite(saved.x) ? saved.x : undefined,
    y: Number.isFinite(saved.y) ? saved.y : undefined,
    minWidth: 940,
    minHeight: 560,
    show: false,
    title: 'Vibe TV',
    // No title bar: the window controls sit over the app itself.
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 16, y: 18 } }
      : { titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 36 } }),
    icon: isMac ? undefined : path.join(__dirname, 'src', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1d1d1f' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  if (saved.maximized) win.maximize();

  win.once('ready-to-show', () => win.show());
  win.on('close', () => {
    const maximized = win.isMaximized();
    const b = maximized || win.isFullScreen() ? store.data.window : win.getNormalBounds();
    store.data.window = { ...store.data.window, ...b, maximized };
    store.flush();
  });
  win.on('closed', () => {
    win = null;
    rendererReady = false;
  });

  // The window only ever shows the app itself.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (SMOKE) {
    win.webContents.on('render-process-gone', (_e, d) => smokeFail('the window crashed: ' + (d && d.reason)));
    win.webContents.on('console-message', (e, level, message) => {
      const text = String(message === undefined ? e.message : message);
      if (/^Uncaught/.test(text)) smokeFail('error in the window: ' + text);
    });
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const up = await win.webContents
        .executeJavaScript("!!window.api && (!document.getElementById('app').hidden || !document.getElementById('welcome').hidden)")
        .catch((e) => smokeFail(e.message));
      if (!up) smokeFail('the window loaded but the app did not start');
      boot.smoke(true, `${app.getVersion()} ${process.platform}`);
    }, 2500));
    setTimeout(() => smokeFail('the window did not load within 45 seconds'), 45000);
  }
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

const SIDEBAR_MODES = [
  ['show', 'Always Show Sidebar'],
  ['auto', 'Auto-Hide Sidebar'],
  ['hide', 'Hide Sidebar'],
];

// Update items, in the app menu on macOS and the Help menu elsewhere.
// "About Vibe TV" opens the app's own About window (version, license, and every open-source component
// it's built on), not the system's plain About box.
function aboutMenuItem() {
  return { label: 'About Vibe TV', click: () => send('menu', 'about') };
}

function updateMenuItems() {
  return [
    { id: 'check-updates', label: 'Check for Updates…', click: () => checkForUpdatesByHand() },
    {
      id: 'auto-update',
      label: 'Install Updates Automatically',
      type: 'checkbox',
      checked: store.data.settings.autoUpdate !== false,
      click: (item) => setAutoUpdate(item.checked),
    },
  ];
}

function checkForUpdatesByHand() {
  if (!updates || !updates.enabled) {
    dialog.showMessageBox(win, {
      type: 'info',
      message: 'Updates work in the installed app',
      detail: `This copy is running from source (version ${app.getVersion()}). Pull the latest code instead, or install Vibe TV from ${RELEASES}.`,
    });
    return;
  }
  updates.check(true);
}

function setAutoUpdate(on) {
  store.data.settings.autoUpdate = !!on;
  store.save();
  if (updates) updates.setAuto(on);
  const item = Menu.getApplicationMenu() && Menu.getApplicationMenu().getMenuItemById('auto-update');
  if (item) item.checked = !!on;
  send('update:state', updates ? updates.state : null);
}

function buildMenu() {
  const cmd = (id) => () => send('menu', id);
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            aboutMenuItem(),
            { type: 'separator' },
            ...updateMenuItems(),
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Playlist…', accelerator: 'CmdOrCtrl+N', click: cmd('new-playlist') },
        { type: 'separator' },
        { label: 'Import M3U File…', accelerator: 'CmdOrCtrl+O', click: cmd('open-file') },
        { label: 'Import from URL…', accelerator: 'CmdOrCtrl+L', click: cmd('add-url') },
        { label: 'Log In with Xtream Codes…', accelerator: 'CmdOrCtrl+Shift+L', click: cmd('xtream') },
        { label: 'Refresh Playlist from Server', accelerator: 'CmdOrCtrl+R', click: cmd('xtream-refresh') },
        { type: 'separator' },
        { label: 'Rename Playlist…', click: cmd('rename-playlist') },
        { label: 'Manage Groups…', accelerator: 'CmdOrCtrl+Shift+G', click: cmd('manage-groups') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: isMac ? 'Ctrl+Cmd+S' : 'Ctrl+B', click: cmd('sidebar-toggle') },
        ...SIDEBAR_MODES.map(([mode, label]) => ({
          id: 'sidebar-' + mode,
          label,
          type: 'radio',
          checked: (store.data.settings.sidebar || 'show') === mode,
          click: cmd('sidebar-' + mode),
        })),
        { type: 'separator' },
        { label: 'Quick Search…', accelerator: 'CmdOrCtrl+K', click: cmd('quick-search') },
        { label: 'Find Channel', accelerator: 'CmdOrCtrl+F', click: cmd('find') },
        { type: 'separator' },
        { label: 'Check Which Channels Are Online', accelerator: 'CmdOrCtrl+Shift+K', click: cmd('check') },
        {
          id: 'hide-offline',
          label: 'Hide Offline Channels',
          type: 'checkbox',
          checked: !!store.data.settings.hideOffline,
          accelerator: 'CmdOrCtrl+Shift+H',
          click: cmd('toggle-hide-offline'),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Playback',
      submenu: [
        { label: 'Play / Pause', accelerator: 'CmdOrCtrl+P', click: cmd('play-pause') },
        { label: 'Next Channel', accelerator: 'CmdOrCtrl+Down', click: cmd('next') },
        { label: 'Previous Channel', accelerator: 'CmdOrCtrl+Up', click: cmd('previous') },
        { type: 'separator' },
        { label: 'Add to / Remove from Favorites', accelerator: 'CmdOrCtrl+D', click: cmd('favorite') },
        { type: 'separator' },
        { label: 'Full Screen', accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11', click: cmd('fullscreen') },
        { label: 'Picture in Picture', accelerator: 'CmdOrCtrl+Shift+P', click: cmd('pip') },
      ],
    },
    { role: 'windowMenu' },
    ...(isMac ? [] : [{ label: 'Help', submenu: [...updateMenuItems(), { type: 'separator' }, aboutMenuItem()] }]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ───────────────────────────── IPC ───────────────────────────── */

// Wraps a handler so the page gets a clean, human-readable message instead of Electron's wrapper text.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : describe(e) };
    }
  });
}

function registerIpc() {
  handle('app:init', () => {
    rendererReady = true;
    boot.healthy(); // the window's page is running: this version starts fine
    const files = pendingOpen;
    pendingOpen = [];
    return {
      state: store.data,
      accent: accentColor(),
      platform: process.platform,
      version: app.getVersion(),
      files,
    };
  });

  ipcMain.on('state:patch', (_e, patch) => {
    const d = store.data;
    const applied = applyPatch(d, patch);
    if (!applied.changed) return;
    if (applied.settings) {
      const menu = Menu.getApplicationMenu();
      const item = menu && menu.getMenuItemById('hide-offline');
      if (item) item.checked = !!d.settings.hideOffline;
      const mode = menu && menu.getMenuItemById('sidebar-' + d.settings.sidebar);
      if (mode) mode.checked = true;
    }
    store.save();
  });

  handle('update:get', () => ({ ...(updates ? updates.state : { status: 'off' }), auto: store.data.settings.autoUpdate !== false }));
  handle('update:check', () => (updates ? updates.check(true) : null));
  handle('update:download', () => (updates ? updates.download() : null));
  handle('update:install', () => updates && updates.install());
  handle('update:auto', (on) => setAutoUpdate(on));
  // "What's new": the release page of that version, in the browser.
  handle('update:notes', (version) => {
    const v = /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(String(version || '')) ? `/tag/v${version}` : '';
    return shell.openExternal(RELEASES + v);
  });

  // Acknowledgements: the open-source components (src/credits.json, made by `npm run credits`) with the
  // versions this copy really runs, and links that open in the browser (only the ones listed there).
  handle('credits:get', async () => {
    const credits = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'credits.json'), 'utf8'));
    const ff = converter ? await converter.about().catch(() => null) : null;
    const live = {
      electron: { version: process.versions.electron },
      chromium: { version: process.versions.chrome },
      node: { version: process.versions.node },
      ffmpeg: ff ? { version: ff.version, license: ff.license, text: ff.text, note: ff.source === 'bundled' ? '' : 'The FFmpeg installed on this computer' } : { version: 'not found' },
    };
    for (const s of credits.sections) for (const item of s.items) if (item.id && live[item.id]) Object.assign(item, live[item.id]);
    credits.app.version = app.getVersion();
    return credits;
  });
  handle('credits:open', (url) => {
    const credits = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'credits.json'), 'utf8'));
    const allowed = new Set([credits.app.url, RELEASES, `${credits.app.url}/blob/main/LICENSE`]);
    for (const s of credits.sections) for (const i of s.items) for (const u of [i.url, i.source, i.licenseUrl]) if (u) allowed.add(u);
    if (!allowed.has(url) || !/^https:\/\//.test(url)) throw new Error('That link is not in the acknowledgements');
    return shell.openExternal(url);
  });

  handle('playlist:create', (name) => library.create(name));
  handle('playlist:rename', (id, name) => library.rename(id, name));
  handle('playlist:remove', (id) => library.remove(id));
  handle('playlist:channels', (id) => library.channels(id));
  handle('playlist:hidden-groups', (id, names) => library.setHiddenGroups(id, names));
  handle('playlist:remove-channels', (id, urls) => library.removeChannels(id, Array.isArray(urls) ? urls : []));

  handle('import:pick', async (playlistId) => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Import M3U playlist',
      buttonLabel: 'Import',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Playlists', extensions: ['m3u', 'm3u8', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return res.canceled ? null : importFiles(playlistId || '', res.filePaths);
  });
  handle('import:files', (playlistId, files) => importFiles(playlistId || '', Array.isArray(files) ? files : []));
  handle('import:url', (playlistId, url) => imports.importUrl(playlistId || '', url));
  handle('xtream:login', (form) => imports.xtreamLogin(form));
  handle('xtream:refresh', (id) => imports.xtreamRefresh(id));

  handle('db:lookup', (ids) => channelDb.lookup(Array.isArray(ids) ? ids.slice(0, 200000) : []));

  // The probe also says whether the stream has to be converted before the window can play it.
  handle('stream:probe', async ({ url, headers }) => {
    const r = await probe(probeFetch, url, headers, { timeout: 12000 });
    if (r.ok && r.streams && converter.available) r.plan = codecs.plan(r.streams, canPlayTs);
    return r;
  });

  handle('media:caps', (caps) => {
    if (caps && Array.isArray(caps.video) && Array.isArray(caps.audio)) canPlayTs = { video: caps.video, audio: caps.audio };
    return { convert: converter.available, ffmpeg: converter.ffmpeg, source: converter.source };
  });

  // Starts a conversion. Without known codecs, ffmpeg looks at the stream first.
  // force.video = 'encode': the passed-through video failed to decode, so re-encode it this time.
  handle('convert:open', async ({ url, headers, streams, force }) => {
    if (!converter.available) throw new Error('ffmpeg is not installed');
    const found = Array.isArray(streams) && streams.length ? streams : await converter.inspect(url, headers);
    if (!found.some((s) => s.kind === 'video' || s.kind === 'audio')) throw new Error('No video or audio was found in this stream');
    const plan = codecs.plan(found, canPlayTs);
    if (force && force.video === 'encode' && plan.video === 'copy') {
      plan.video = 'encode';
      plan.convert = true;
      plan.why = [`${plan.videoCodec} video`, plan.why].filter(Boolean).join(' and ');
    }
    const session = await converter.open(url, headers, plan);
    return { ...session, plan, streams: found };
  });
  handle('convert:inspect', ({ url, headers }) => (converter.available ? converter.inspect(url, headers) : []));
  handle('convert:status', (id) => converter.status(id));
  handle('convert:close', (id) => converter.close(id));

  // Focus mode on macOS: the red/yellow/green buttons fade with the player controls.
  // Dragging the picture moves the window (sent many times a second, so no reply).
  ipcMain.on('window:move', (_e, pos) => {
    if (!win || win.isDestroyed() || win.isFullScreen() || (!isMac && win.isMaximized())) return;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    win.setPosition(Math.round(pos.x), Math.round(pos.y));
  });

  handle('window:buttons', (visible) => {
    if (isMac && win && !win.isDestroyed()) win.setWindowButtonVisibility(!!visible);
  });

  handle('stream:headers', (h) => {
    activeHeaders = h && (h.referrer || h.userAgent)
      ? { referrer: String(h.referrer || ''), userAgent: String(h.userAgent || '') }
      : null;
  });

  handle('check:start', async (items) => {
    if (activeCheck) activeCheck.cancel();
    let batch = [];
    const flush = () => {
      if (batch.length) send('check:progress', batch);
      batch = [];
    };
    const timer = setInterval(flush, 200);
    const run = checkAll(probeFetch, items, {
      concurrency: 16,
      perHost: 6,
      onResult: (item, r) => batch.push({ url: item.url, ok: r.ok }),
    });
    activeCheck = run;
    try {
      return await run.done;
    } finally {
      clearInterval(timer);
      flush();
      if (activeCheck === run) activeCheck = null;
    }
  });

  handle('check:cancel', () => {
    if (activeCheck) activeCheck.cancel();
  });

  // Native context menu. Resolves with the id of the chosen item, or null.
  handle('menu:popup', (items) =>
    new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const template = (items || []).map((it) =>
        it.type === 'separator'
          ? { type: 'separator' }
          : {
              label: String(it.label),
              enabled: it.enabled !== false,
              type: typeof it.checked === 'boolean' ? 'checkbox' : 'normal',
              checked: !!it.checked,
              click: () => done(it.id),
            }
      );
      // On some systems "closed" fires just before "click", so give the click a moment.
      Menu.buildFromTemplate(template).popup({ window: win, callback: () => setTimeout(() => done(null), 150) });
    })
  );

  handle('dialog:confirm', async ({ message, detail, confirmLabel }) => {
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [confirmLabel || 'OK', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: String(message || ''),
      detail: detail ? String(detail) : undefined,
    });
    return res.response === 0;
  });

  handle('clipboard:write', (text) => clipboard.writeText(String(text || '')));
}

/* ───────────────────────────── app lifecycle ───────────────────────────── */

function playlistArgs(argv) {
  return argv.filter((a) => a && !a.startsWith('-') && /\.m3u8?$/i.test(a));
}

function openFromOs(paths) {
  if (!paths.length) return;
  if (!rendererReady) {
    pendingOpen.push(...paths);
    return;
  }
  send('files:opened', paths);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    openFromOs(playlistArgs(argv.slice(1)));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('open-file', (e, file) => {
    e.preventDefault();
    openFromOs([file]);
  });

  app.whenReady().then(() => {
    openStore();
    // When run from source (npm start) macOS would show Electron's icon in the Dock.
    if (isMac && !app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, 'build', 'icon-mac.png'));
    converter = new Converter();
    library = new Library(store, path.join(app.getPath('userData'), 'playlists'), legacyText, storage);
    imports = createImports({ library, fetchImpl });
    channelDb = new ChannelDb({ fetchImpl, cacheDir: cacheDir(), api: envVar('DB_URL') || undefined, storage });
    pendingOpen.push(...playlistArgs(process.argv.slice(app.isPackaged ? 1 : 2)));
    registerIpc();
    installStreamHooks();
    restrictPermissions();
    buildMenu();
    createWindow();

    updates = new Updates({
      enabled: app.isPackaged || !!envVar('UPDATE_URL'),
      auto: store.data.settings.autoUpdate !== false,
      feedUrl: envVar('UPDATE_URL') || undefined, // a test feed; normally GitHub Releases
      currentVersion: app.getVersion(),
    });
    updates.on('state', (s) => send('update:state', { ...s, auto: store.data.settings.autoUpdate !== false }));
    updates.start();

    try {
      systemPreferences.on('accent-color-changed', () => send('theme:accent', accentColor()));
    } catch (e) { /* not supported here */ }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (store) store.flush();
    if (!isMac) app.quit();
  });
  app.on('before-quit', () => {
    if (converter) converter.shutdown();
    if (store) store.flush();
  });
}
