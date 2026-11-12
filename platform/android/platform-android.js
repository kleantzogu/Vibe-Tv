'use strict';
/*
 * Entry of the Android web bundle (built by scripts/build-android-web.js into www/platform-android.js
 * and loaded before app.js). It provides `window.api` on Android, as preload.js does on a computer;
 * platform/api-contract.js lists what that takes and api.js answers it.
 */
const { registerPlugin } = require('@capacitor/core');
const { createApi } = require('./api');
const { createBackend } = require('./backend');
const { nativeStorage } = require('./storage-native');
const { createNativeFetch } = require('./native-fetch');
const { decodeText } = require('../../lib/imports');
const { installNativePlayer } = require('./player');
const { createMenu } = require('./menu');
const { installTouch } = require('./touch');

// The app's own plugins: android/app/src/main/java/com/vibetv/app/
const VibeDevice = registerPlugin('VibeDevice');
const VibeFiles = registerPlugin('VibeFiles');
const VibeHttp = registerPlugin('VibeHttp');
const VibePlayer = registerPlugin('VibePlayer');
let device = null;

// Lets the person choose playlist files with the system's picker. Resolves with null when they cancel.
function pickFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true; // no `accept`: Android does not know .m3u, and would grey the files out
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
      resolve(Array.from(input.files || []).map((f) => ({ name: f.name, read: async () => decodeText(await f.arrayBuffer()) })));
    });
    input.click();
  });
}

const menu = createMenu(document);

// Playlist files another app handed over ("Open with Vibe TV"), until the app imports them.
const opened = new Map(); // token -> { name, data (base64) }
const bytesOf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const { api, flush, emit, whenStarted } = createApi({
  openBackend: () =>
    createBackend({
      storage: nativeStorage(VibeFiles),
      // Playlists and Xtream servers don't allow requests from a page; the channel database does,
      // and the page reads it as it downloads instead of all at once.
      fetchImpl: createNativeFetch(VibeHttp, { timeout: 90000, maxBytes: 128 * 1024 * 1024 }),
      dbFetchImpl: (url, opts) => fetch(url, opts),
      dataDir: 'data',
    }),
  getDevice: () => (device = device || VibeDevice.getInfo()),
  probeFetch: createNativeFetch(VibeHttp, { sniff: true, timeout: 12000, maxBytes: 256 * 1024 }),
  host: {
    confirm: async ({ message, detail }) => window.confirm([message, detail].filter(Boolean).join('\n\n')),
    copyText: (text) => navigator.clipboard.writeText(text),
    credits: () => fetch('credits.json').then((r) => r.json()),
    openExternal: async (url) => {
      window.open(url, '_blank');
    },
    pickFiles,
    popupMenu: (items) => menu.show(items),
    openedFiles: (tokens) =>
      tokens.filter((t) => opened.has(t)).map((t) => {
        const f = opened.get(t);
        opened.delete(t);
        return { name: f.name, read: async () => decodeText(bytesOf(f.data)) };
      }),
  },
});

// Settings are saved a moment after they change; when the app leaves the screen, save them now.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});

// The player: the app's <video> is swapped for a stand-in that drives the native player (player.js).
let tv = false;
Promise.resolve(VibeDevice.getInfo()).then((d) => { tv = !!d.tv; }).catch(() => {});
const nativePlayer = installNativePlayer({ plugin: VibePlayer, document, isTv: () => tv, probe: (url, headers) => api.probe(url, headers) });
window.vibeNativePlayer = nativePlayer;
installTouch({ video: nativePlayer.element, playerEl: document.getElementById('player') });

// "Open with Vibe TV" on a playlist file: the app imports it, as when a file is opened on a computer.
let openedCount = 0;
VibeDevice.addListener('opened', (file) => {
  const token = `opened:${++openedCount}`;
  opened.set(token, file);
  whenStarted.then(() => emit('files:opened', [token]));
});

// Back (the button, the gesture, or Back on a remote) closes what is open, from the top down, and
// leaves the app when nothing is.
VibeDevice.addListener('back', () => {
  if (menu.close()) return;
  const dialog = [...document.querySelectorAll('dialog[open]')].pop();
  if (dialog) {
    if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
    return;
  }
  const pop = document.getElementById('groupPop');
  if (pop && !pop.hidden) return void pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  if (nativePlayer.isFullscreen()) return nativePlayer.exitFullscreen();
  VibeDevice.leave();
});

window.api = api;
