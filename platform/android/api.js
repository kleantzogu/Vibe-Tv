'use strict';
/*
 * `window.api` for Android: the same calls preload.js + main.js answer on a computer
 * (platform/api-contract.js), answered here inside the WebView.
 *
 * Playlists, imports, the channel database and channel checks work as on a computer, through the
 * shared lib/ modules. Playback comes with the native player.
 */
const { EVENTS } = require('../api-contract');
const { probe, checkAll } = require('../../lib/probe');

// On a computer every answer crosses a process boundary, so the window gets copies it can change
// freely. The same holds here.
const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/**
 * @param {object} deps
 * @param {function} deps.openBackend  async () => platform/android/backend.js createBackend(...)
 * @param {function} deps.getDevice    async () => { tv:boolean, version:string }
 * @param {function} deps.probeFetch   fetch() for channel checks: reads only the beginning of a stream
 * @param {{ name:string, url:string }} [deps.defaultPlaylist]  a playlist the app starts with: imported once,
 *   the first time the app runs with no playlists (and not again if the person deletes it)
 * @param {object} deps.host           what only the page can do:
 *   { confirm, copyText, credits, openExternal, pickFiles: async () => [{ name, read }] | null,
 *     popupMenu: async (items) => id | null, openedFiles: (tokens) => [{ name, read }] }
 */
const DEFAULT_PLAYLIST = 'default-playlist'; // stands for the starting playlist among the "files" to import

function createApi({ openBackend, getDevice, probeFetch, host, defaultPlaylist = null }) {
  let backend = null;
  let tv = false;
  let activeCheck = null;
  let ready;
  const whenStarted = new Promise((resolve) => { ready = resolve; });
  const listeners = new Map();
  /** Sends an event to the window, as main.js does with webContents.send. */
  const emit = (event, ...args) => {
    for (const fn of listeners.get(event) || []) fn(...copy(args));
  };
  const started = () => {
    if (!backend) throw new Error('The app has not started yet');
    return backend;
  };
  const answer = (fn) => async (...args) => copy(await fn(...copy(args)));
  const nothing = async () => {};
  const noUpdates = async () => ({ status: 'off', auto: false }); // the APK is updated by installing a new one

  const api = {
    init: answer(async () => {
      const [b, device] = await Promise.all([openBackend(), getDevice().catch(() => ({}))]);
      backend = b;
      tv = !!device.tv;
      setTimeout(ready, 0); // once the window has what it asked for
      return {
        state: b.store.data,
        accent: '',
        platform: device.tv ? 'androidtv' : 'android',
        version: device.version || '',
        files: [],
      };
    }),
    patchState: (patch) => {
      started().patchState(copy(patch));
    },

    createPlaylist: answer((name) => started().library.create(name)),
    renamePlaylist: answer((id, name) => started().library.rename(id, name)),
    removePlaylist: answer((id) => started().library.remove(id)),
    playlistChannels: answer((id) => started().library.channels(id)),
    removeChannels: answer((id, urls) => started().library.removeChannels(id, Array.isArray(urls) ? urls : [])),
    setHiddenGroups: answer((id, names) => started().library.setHiddenGroups(id, names)),

    importPick: answer(async (playlistId) => {
      // TVs have no file picker; a playlist gets there by address or login.
      if (tv) throw new Error('Files can’t be picked on a TV. Use “Import from URL” or “Xtream Codes login” instead.');
      const files = await host.pickFiles();
      return files && files.length ? started().imports.importTexts(playlistId || '', files) : null;
    }),
    // On a computer these are paths (dropped on the window, opened from the file manager). Here they
    // are tokens for playlist files another app handed over with "Open with" (see "files:opened").
    importFiles: answer(async (playlistId, tokens) => {
      tokens = Array.isArray(tokens) ? tokens : [];
      if (tokens.includes(DEFAULT_PLAYLIST) && defaultPlaylist) return importDefault();
      const files = host.openedFiles ? host.openedFiles(tokens) : [];
      return files.length ? started().imports.importTexts(playlistId || '', files) : null;
    }),
    importUrl: answer((playlistId, url) => started().imports.importUrl(playlistId || '', url)),
    xtreamLogin: answer((form) => started().imports.xtreamLogin(form)),
    xtreamRefresh: answer((id) => started().imports.xtreamRefresh(id)),

    lookupChannels: answer((ids) => started().channelDb.lookup(Array.isArray(ids) ? ids.slice(0, 200000) : [])),

    probe: answer((url, headers) => probe(probeFetch, url, headers, { timeout: 12000 })),
    // Nothing is converted on Android: the native player plays the original address.
    mediaCaps: async () => ({ convert: false, ffmpeg: '', source: '' }),
    convertOpen: async () => {
      throw new Error('Streams are not converted on Android');
    },
    convertStatus: async () => null,
    convertInspect: async () => [],
    convertClose: nothing,
    setStreamHeaders: nothing,

    // Results reach the window in batches, as "check:progress" events.
    startCheck: answer(async (items) => {
      if (activeCheck) activeCheck.cancel();
      let batch = [];
      const flush = () => {
        if (batch.length) emit('check:progress', batch);
        batch = [];
      };
      const timer = setInterval(flush, 200);
      const run = checkAll(probeFetch, Array.isArray(items) ? items : [], {
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
    }),
    cancelCheck: async () => {
      if (activeCheck) activeCheck.cancel();
    },

    popupMenu: async (items) => (host.popupMenu ? host.popupMenu(Array.isArray(items) ? items : []) : null),
    confirm: (opts) => host.confirm(opts || {}),
    copyText: (text) => host.copyText(String(text || '')),
    setWindowButtons: nothing,
    moveWindow: () => {},

    updateState: noUpdates,
    checkForUpdates: noUpdates,
    downloadUpdate: noUpdates,
    installUpdate: nothing,
    setAutoUpdate: nothing,
    openReleaseNotes: nothing,

    credits: answer(async () => {
      const credits = await host.credits();
      const device = await getDevice().catch(() => ({}));
      if (device.version) credits.app.version = device.version;
      return credits;
    }),
    // Only the links listed in the acknowledgements open, as on a computer.
    openCreditLink: async (url) => {
      const credits = await host.credits();
      const allowed = new Set([credits.app.url, `${credits.app.url}/blob/main/LICENSE`]);
      for (const s of credits.sections) for (const i of s.items) for (const u of [i.url, i.source, i.licenseUrl]) if (u) allowed.add(u);
      if (!allowed.has(url) || !/^https:\/\//.test(url)) throw new Error('That link is not in the acknowledgements');
      return host.openExternal(url);
    },

    on: (event, fn) => {
      if (!Object.prototype.hasOwnProperty.call(EVENTS, event)) throw new Error('Unknown event ' + event);
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
  };

  // The playlist the app starts with: a playlist of its own, named, filled from its address.
  async function importDefault() {
    const b = started();
    const made = b.library.create(defaultPlaylist.name);
    try {
      const r = await b.imports.importUrl(made.id, defaultPlaylist.url);
      b.store.data.settings.defaultPlaylist = defaultPlaylist.url; // done: never added a second time
      b.store.save();
      return { ...r, created: true };
    } catch (e) {
      await b.library.remove(made.id);
      throw e;
    }
  }
  /** Whether the starting playlist is still to be imported; if so, the token to import it with. */
  const pendingDefault = () =>
    defaultPlaylist && backend && !backend.library.playlists.length && !backend.store.data.settings.defaultPlaylist ? DEFAULT_PLAYLIST : null;

  /** Writes what has changed right away: Android may end the app at any moment once it is in the background. */
  const flush = () => {
    if (backend) backend.store.flush();
  };

  return { api, emit, flush, whenStarted, pendingDefault };
}

module.exports = { createApi };
