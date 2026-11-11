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

// The app's own plugins: android/app/src/main/java/com/vibetv/app/
const VibeDevice = registerPlugin('VibeDevice');
const VibeFiles = registerPlugin('VibeFiles');
const VibeHttp = registerPlugin('VibeHttp');
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

const { api, flush } = createApi({
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
  },
});

// Settings are saved a moment after they change; when the app leaves the screen, save them now.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});

// Android's WebView paints a large grey play button on a video that has nothing to show yet.
// A transparent poster keeps the player area as the app draws it.
for (const video of document.querySelectorAll('video')) {
  if (!video.poster) video.poster = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
}

window.api = api;
