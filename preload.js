'use strict';
/*
 * Bridge between the app window and the main process.
 * The page itself has no Node access; it can only call the functions listed here.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || !res.ok) throw new Error((res && res.error) || 'Something went wrong');
  return res.value;
}

const EVENTS = new Set(['menu', 'check:progress', 'files:opened', 'import:waiting', 'theme:accent']);

contextBridge.exposeInMainWorld('api', {
  init: () => call('app:init'),
  patchState: (patch) => ipcRenderer.send('state:patch', patch),

  createPlaylist: (name) => call('playlist:create', name),
  renamePlaylist: (id, name) => call('playlist:rename', id, name),
  removePlaylist: (id) => call('playlist:remove', id),
  playlistChannels: (id) => call('playlist:channels', id),
  removeChannels: (id, urls) => call('playlist:remove-channels', id, urls),
  setHiddenGroups: (id, names) => call('playlist:hidden-groups', id, names),

  // Import M3U files or an address into a playlist ('' makes a new playlist).
  importPick: (playlistId) => call('import:pick', playlistId),
  importFiles: (playlistId, paths) => call('import:files', playlistId, paths),
  importUrl: (playlistId, url) => call('import:url', playlistId, url),
  // Xtream Codes: { server, username, password, movies, name } -> a playlist with the account's channels.
  xtreamLogin: (form) => call('xtream:login', form),
  xtreamRefresh: (playlistId) => call('xtream:refresh', playlistId),

  lookupChannels: (ids) => call('db:lookup', ids),

  probe: (url, headers) => call('stream:probe', { url, headers }),
  mediaCaps: (caps) => call('media:caps', caps),
  convertOpen: (args) => call('convert:open', args),
  convertStatus: (id) => call('convert:status', id),
  convertInspect: (url, headers) => call('convert:inspect', { url, headers }),
  convertClose: (id) => call('convert:close', id),
  setStreamHeaders: (headers) => call('stream:headers', headers),

  startCheck: (items) => call('check:start', items),
  cancelCheck: () => call('check:cancel'),

  popupMenu: (items) => call('menu:popup', items),
  setWindowButtons: (visible) => call('window:buttons', visible),
  confirm: (opts) => call('dialog:confirm', opts),
  copyText: (text) => call('clipboard:write', text),

  on: (event, fn) => {
    if (!EVENTS.has(event)) throw new Error('Unknown event ' + event);
    ipcRenderer.on(event, (_e, ...args) => fn(...args));
  },
});

/*
 * Drag & drop of playlist files. The real file path is only available on this side of the
 * bridge, so it is read here and handed to the page, which imports the files.
 */
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const paths = Array.from(e.dataTransfer.files)
    .map((f) => {
      try { return webUtils.getPathForFile(f); } catch (err) { return ''; }
    })
    .filter(Boolean);
  if (paths.length) window.postMessage({ type: 'm3u:dropped', paths }, '*');
});
