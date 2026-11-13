'use strict';
/*
 * The part of the desktop "main process" that Android needs too: settings, playlists, imports and
 * the channel database, built from the same lib/ modules, on top of whatever storage and network
 * access the platform hands in.
 */
const { Store } = require('../../lib/store');
const { Library } = require('../../lib/library');
const { ChannelDb } = require('../../lib/channeldb');
const { DEFAULTS, pruneStatus, applyPatch } = require('../../lib/state');
const { createImports } = require('../../lib/imports');

/**
 * @param {object} deps
 * @param {object} deps.storage      storage backend (see lib/storage-node.js for what one offers)
 * @param {function} deps.fetchImpl  fetch() for playlists and Xtream servers
 * @param {function} [deps.dbFetchImpl]  fetch() for the channel database, when that is another one
 * @param {string} [deps.dataDir]    folder inside the storage that holds everything
 */
async function createBackend({ storage, fetchImpl, dbFetchImpl = fetchImpl, dataDir = '' }) {
  const store = await Store.open(storage.join(dataDir, 'settings.json'), DEFAULTS, storage);
  pruneStatus(store.data);
  const library = new Library(store, storage.join(dataDir, 'playlists'), null, storage);
  const imports = createImports({ library, fetchImpl });
  const channelDb = new ChannelDb({ fetchImpl: dbFetchImpl, cacheDir: storage.join(dataDir, 'cache'), storage });
  return {
    store,
    library,
    imports,
    channelDb,
    patchState(patch) {
      if (applyPatch(store.data, patch).changed) store.save();
    },
  };
}

module.exports = { createBackend };
