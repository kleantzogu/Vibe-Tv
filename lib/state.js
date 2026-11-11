'use strict';
/*
 * What the app remembers between runs (settings.json), and the changes the window may make to it.
 * Shared by every platform, so a playlist library looks the same wherever it is opened.
 */

const DEFAULTS = {
  playlists: [], // { id, name, count, createdAt }; channels are in playlists/<id>.json
  activePlaylistId: '',
  favorites: [],
  recents: [],
  status: {}, // stream url -> { s: 'ok' | 'dead', t: timestamp }
  settings: { hideOffline: false, volume: 1, muted: false, sidebar: 'show', autoUpdate: true }, // sidebar: show | auto | hide
  window: { width: 1280, height: 800 },
};

/** Forgets check results that are older than a month. */
function pruneStatus(data, now = Date.now()) {
  const cutoff = now - 30 * 24 * 3600 * 1000;
  for (const [url, v] of Object.entries(data.status)) {
    if (!v || !v.t || v.t < cutoff) delete data.status[url];
  }
}

/**
 * Applies a change sent by the window (api.patchState), keeping only the parts it is allowed to set.
 * @returns {{ changed:boolean, settings:boolean }}  settings: the settings were among the changes
 */
function applyPatch(data, patch) {
  if (!patch || typeof patch !== 'object') return { changed: false, settings: false };
  let settings = false;
  if (Array.isArray(patch.favorites)) data.favorites = patch.favorites;
  if (Array.isArray(patch.recents)) data.recents = patch.recents;
  if (patch.status && typeof patch.status === 'object') data.status = patch.status;
  if (typeof patch.activePlaylistId === 'string') data.activePlaylistId = patch.activePlaylistId;
  if (patch.settings && typeof patch.settings === 'object') {
    data.settings = { ...data.settings, ...patch.settings };
    settings = true;
  }
  return { changed: true, settings };
}

module.exports = { DEFAULTS, pruneStatus, applyPatch };
