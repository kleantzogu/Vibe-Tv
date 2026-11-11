'use strict';
/*
 * Getting channels into a playlist: from M3U text (files the person picked), from a web address,
 * or from an Xtream Codes login. Shared by every platform; how a file is read, and how the network
 * is reached, is handed in.
 */
const { describe, fetchBuffer } = require('./net');
const xtream = require('./xtream');

const PLAYLIST_EXT = /\.(m3u8?|txt)$/i;

function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    return new TextDecoder('windows-1252').decode(buf); // older playlists are often not UTF-8
  }
}

// The playlist name a file gives: its name without the extension.
const baseName = (fileName) => String(fileName || '').replace(PLAYLIST_EXT, '') || 'Playlist';

/**
 * @param {object} deps
 * @param {object} deps.library      the Library the channels go into
 * @param {function} deps.fetchImpl  fetch() used for addresses and Xtream servers
 */
function createImports({ library, fetchImpl }) {
  async function readPlaylistUrl(url) {
    try {
      return decodeText(await fetchBuffer(fetchImpl, url, { timeout: 30000 }));
    } catch (e) {
      throw new Error(`Couldn’t download the playlist: ${describe(e)}.`);
    }
  }

  /**
   * Imports M3U texts into a playlist; with no playlist given, a new one is made, named after the
   * first of them.
   * @param {string} playlistId  '' to make a new playlist
   * @param {Array<{ name:string, read:function }>} items  name: the file's name; read: async () => its text
   */
  async function importTexts(playlistId, items) {
    if (!items.length) return null;
    let id = playlistId;
    let created = null;
    let added = 0;
    let skipped = 0;
    const errors = [];
    for (const item of items) {
      try {
        const text = await item.read();
        if (!id) {
          created = library.create(baseName(item.name));
          id = created.id;
        }
        const r = await library.importText(id, text, `“${item.name}”`);
        added += r.added;
        skipped += r.skipped;
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (!id) throw new Error(errors[0] || 'Nothing was imported');
    return { playlist: library.find(id), created: !!created, added, skipped, errors };
  }

  async function importUrl(playlistId, url) {
    let parsed;
    try {
      parsed = new URL(String(url || '').trim());
    } catch (e) {
      throw new Error('That does not look like a web address. It should start with http:// or https://');
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('The address must start with http:// or https://');
    const text = await readPlaylistUrl(parsed.href);
    let id = playlistId;
    let created = false;
    if (!id) {
      const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '').replace(PLAYLIST_EXT, '');
      id = library.create(last && !/^(index|playlist|get|tv)$/i.test(last) ? last : parsed.hostname).id;
      created = true;
    }
    try {
      const r = await library.importText(id, text, 'This address');
      return { ...r, created, errors: [] };
    } catch (e) {
      if (created) await library.remove(id);
      throw e;
    }
  }

  // Xtream Codes: log in with server / username / password. The login is kept with the playlist so
  // it can be refreshed from the server later. Logging in again with the same account refreshes the
  // playlist that already has it instead of making a second one.
  async function xtreamLogin(form) {
    form = form && typeof form === 'object' ? form : {};
    const movies = !!form.movies;
    const r = await xtream.loadAccount(fetchImpl, form, { movies });
    const same = (p) => p.xtream && p.xtream.server === r.login.server && p.xtream.username === r.login.username;
    const existing = library.playlists.find(same);
    const source = { xtream: { ...r.login, movies } };
    if (existing) {
      library.setSource(existing.id, source);
      const res = await library.replaceChannels(existing.id, r.channels);
      return { ...res, created: false, skipped: 0, errors: [], account: r.account, live: r.live, movies: r.movies };
    }
    const name = String(form.name || '').trim() || new URL(r.login.server).hostname;
    const created = library.create(name);
    try {
      library.setSource(created.id, source);
      const res = await library.addChannels(created.id, r.channels);
      return { ...res, created: true, errors: [], account: r.account, live: r.live, movies: r.movies };
    } catch (e) {
      await library.remove(created.id);
      throw e;
    }
  }

  async function xtreamRefresh(id) {
    const p = library.find(id);
    if (!p.xtream) throw new Error('This playlist was not loaded from an Xtream Codes login');
    const r = await xtream.loadAccount(fetchImpl, p.xtream, { movies: !!p.xtream.movies });
    const res = await library.replaceChannels(id, r.channels);
    return { ...res, account: r.account };
  }

  return { readPlaylistUrl, importTexts, importUrl, xtreamLogin, xtreamRefresh };
}

module.exports = { createImports, decodeText, baseName, PLAYLIST_EXT };
