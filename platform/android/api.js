'use strict';
/*
 * `window.api` for Android: the same calls preload.js + main.js answer on a computer
 * (platform/api-contract.js), answered here inside the WebView.
 *
 * This is the first cut: the app starts and playlists can be made, but they are kept in memory only.
 * Storage, imports and channel checks come with the data layer, playback with the native player;
 * until then those calls fail with a message that says so.
 */
const { EVENTS } = require('../api-contract');

// On a computer every answer crosses a process boundary, so the window gets copies it can change
// freely. The same holds here.
const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/**
 * @param {object} deps
 * @param {function} deps.openBackend  async () => platform/android/backend.js createBackend(...)
 * @param {function} deps.getDevice    async () => { tv:boolean, version:string }
 * @param {object} deps.host           what only the page can do: { confirm, copyText, credits, openExternal }
 */
function createApi({ openBackend, getDevice, host }) {
  let backend = null;
  const listeners = new Map();
  const started = () => {
    if (!backend) throw new Error('The app has not started yet');
    return backend;
  };
  const answer = (fn) => async (...args) => copy(await fn(...copy(args)));
  const notYet = (what) => async () => {
    throw new Error(`${what} is not available on Android yet.`);
  };
  const nothing = async () => {};
  const noUpdates = async () => ({ status: 'off', auto: false }); // the APK is updated by installing a new one

  const api = {
    init: answer(async () => {
      const [b, device] = await Promise.all([openBackend(), getDevice().catch(() => ({}))]);
      backend = b;
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

    importPick: notYet('Importing a playlist file'),
    importFiles: notYet('Importing a playlist file'),
    importUrl: notYet('Importing from an address'),
    xtreamLogin: notYet('Logging in with Xtream Codes'),
    xtreamRefresh: notYet('Refreshing from the server'),

    lookupChannels: async () => ({}),

    probe: notYet('Checking a stream'),
    // Nothing is converted on Android: the native player plays the original address.
    mediaCaps: async () => ({ convert: false, ffmpeg: '', source: '' }),
    convertOpen: async () => {
      throw new Error('Streams are not converted on Android');
    },
    convertStatus: async () => null,
    convertInspect: async () => [],
    convertClose: nothing,
    setStreamHeaders: nothing,

    startCheck: notYet('Checking which channels are online'),
    cancelCheck: nothing,

    popupMenu: async () => null,
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

  /** Sends an event to the window, as main.js does with webContents.send. */
  const emit = (event, ...args) => {
    for (const fn of listeners.get(event) || []) fn(...copy(args));
  };

  return { api, emit };
}

module.exports = { createApi };
