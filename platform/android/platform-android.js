'use strict';
/*
 * Entry of the Android web bundle (built by scripts/build-android-web.js into www/platform-android.js
 * and loaded before app.js). It will provide `window.api` on Android, as preload.js does on a
 * computer; see platform/api-contract.js for what that takes.
 *
 * For now it only makes the shared backend available, which proves lib/ runs in a WebView.
 */
const { createBackend } = require('./backend');
const { memoryStorage } = require('../../lib/storage-memory');
const { probe, checkAll } = require('../../lib/probe');

window.vibeAndroid = { createBackend, memoryStorage, probe, checkAll };
