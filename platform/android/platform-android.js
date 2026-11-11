'use strict';
/*
 * Entry of the Android web bundle (built by scripts/build-android-web.js into www/platform-android.js
 * and loaded before app.js). It provides `window.api` on Android, as preload.js does on a computer;
 * platform/api-contract.js lists what that takes and api.js answers it.
 */
const { registerPlugin } = require('@capacitor/core');
const { createApi } = require('./api');
const { createBackend } = require('./backend');
const { memoryStorage } = require('../../lib/storage-memory');

// android/app/src/main/java/com/vibetv/app/VibeDevicePlugin.kt
const VibeDevice = registerPlugin('VibeDevice');
let device = null;

const { api } = createApi({
  // Kept in memory for now: the data layer replaces this with files on the device.
  openBackend: () => createBackend({ storage: memoryStorage(), fetchImpl: (url, opts) => fetch(url, opts), dataDir: 'data' }),
  getDevice: () => (device = device || VibeDevice.getInfo()),
  host: {
    confirm: async ({ message, detail }) => window.confirm([message, detail].filter(Boolean).join('\n\n')),
    copyText: (text) => navigator.clipboard.writeText(text),
    credits: () => fetch('credits.json').then((r) => r.json()),
    openExternal: async (url) => {
      window.open(url, '_blank');
    },
  },
});

window.api = api;
