'use strict';
/*
 * The contract between the app window (src/app.js) and whatever runs it.
 *
 * The window only ever talks to the outside through `window.api`. On a computer that object is made
 * by preload.js and answered by main.js; on Android it is made by platform/android/platform-android.js.
 * Both must offer every call listed here: `npm test` checks that they do, so a call added on one
 * platform can't be forgotten on the other.
 *
 * Every call returns a Promise unless marked "no reply". A call a platform has no use for still
 * exists there and resolves with the value given under "elsewhere".
 */

/**
 * @typedef {object} Playlist
 * @property {string} id
 * @property {string} name
 * @property {number} count       channels in it
 * @property {number} createdAt
 * @property {string[]} [hiddenGroups]
 * @property {{ server:string, username:string, password:string, movies:boolean }} [xtream]
 *
 * @typedef {object} Channel
 * @property {string} name
 * @property {string} rawName
 * @property {string} url
 * @property {string} tvgId
 * @property {string} tvgName
 * @property {string} number
 * @property {string} logo
 * @property {string[]} groups
 * @property {string} quality
 * @property {string[]} tags
 * @property {?StreamHeaders} headers
 *
 * @typedef {{ referrer?:string, userAgent?:string }} StreamHeaders
 *
 * @typedef {object} ImportResult
 * @property {Playlist} playlist
 * @property {boolean} created   a new playlist was made for it
 * @property {number} added
 * @property {number} skipped    channels the playlist already had
 * @property {string[]} errors   one message per file that could not be imported
 *
 * @typedef {object} InitResult
 * @property {object} state      lib/state.js DEFAULTS, filled in with what was saved
 * @property {string} accent     the system's accent colour as #rrggbb, or ''
 * @property {string} platform   'darwin' | 'win32' | 'linux' | 'android' | 'androidtv'
 * @property {string} version
 * @property {string[]} files    playlist files the app was opened with
 *
 * @typedef {object} ProbeResult
 * @property {boolean} ok
 * @property {string} kind       'hls' | 'dash' | 'mpegts' | 'flv' | 'native' | 'webpage' | ''
 * @property {number} status
 * @property {string} [reason]
 * @property {object[]} [streams]
 * @property {object} [plan]     what has to be converted before the window can play it (computers only)
 */

const METHODS = {
  // Start-up and saved state
  init: '() => InitResult',
  patchState: '(patch) => void, no reply. patch: { favorites?, recents?, status?, activePlaylistId?, settings? }',

  // Playlists
  createPlaylist: '(name) => Playlist',
  renamePlaylist: '(id, name) => Playlist',
  removePlaylist: '(id) => void',
  playlistChannels: '(id) => Channel[]',
  removeChannels: '(id, urls) => Playlist',
  setHiddenGroups: '(id, names) => Playlist',

  // Imports. playlistId "" makes a new playlist.
  importPick: '(playlistId) => ImportResult | null (null: the person cancelled)',
  importFiles: '(playlistId, paths) => ImportResult | null',
  importUrl: '(playlistId, url) => ImportResult',
  xtreamLogin: '({ server, username, password, movies, name }) => ImportResult & { account, live, movies }',
  xtreamRefresh: '(playlistId) => { playlist, added, removed, account }',

  // Logos and categories from the iptv-org database
  lookupChannels: '(tvgIds) => { [tvgId]: { logo, groups } }',

  // Streams
  probe: '(url, headers) => ProbeResult',
  mediaCaps: '({ video, audio }) => { convert, ffmpeg, source }. elsewhere: { convert: false }',
  convertOpen: '({ url, headers, streams, force }) => conversion session. elsewhere: rejects',
  convertStatus: '(id) => status. elsewhere: null',
  convertInspect: '(url, headers) => streams. elsewhere: []',
  convertClose: '(id) => void',
  setStreamHeaders: '(StreamHeaders | null) => void',

  // Checking which channels are online; results arrive as "check:progress" events
  startCheck: '(items: { url, headers }[]) => { cancelled }',
  cancelCheck: '() => void',

  // Menus, dialogs and the window
  popupMenu: '(items: { id, label, enabled?, checked? } | { type: "separator" }) => id | null',
  confirm: '({ message, detail, confirmLabel }) => boolean',
  copyText: '(text) => void',
  setWindowButtons: '(visible) => void. elsewhere: nothing happens',
  moveWindow: '(x, y) => void, no reply. elsewhere: nothing happens',

  // Updates. elsewhere: { status: "off" } and nothing happens
  updateState: '() => { status, auto, ... }',
  checkForUpdates: '() => state',
  downloadUpdate: '() => state',
  installUpdate: '() => void',
  setAutoUpdate: '(on) => void',
  openReleaseNotes: '(version) => void',

  // Acknowledgements
  credits: '() => src/credits.json, with the versions that are really running',
  openCreditLink: '(url) => void. Only links listed in the credits open.',

  // Events from the platform
  on: '(event, fn) => void, no reply. Throws for an event that is not in EVENTS.',
};

const EVENTS = {
  menu: '(id) a command from the application menu',
  'check:progress': '([{ url, ok }]) results of the running channel check, in batches',
  'files:opened': '(paths) playlist files handed over by the system while the app is running',
  'import:waiting': '(fileName) a file is still being downloaded by a cloud drive',
  'theme:accent': '(colour) the system accent colour changed',
  'update:state': '(state) the updater has news',
};

module.exports = { METHODS, EVENTS };
