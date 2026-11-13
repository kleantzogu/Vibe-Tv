'use strict';
/*
 * Playlists are lists the person makes in the app. Importing an M3U file (or address) appends its
 * channels to one of them; the file itself is not needed afterwards.
 * Each playlist's channels live in their own JSON file next to settings.json:
 *   <userData>/playlists/<id>.json  ->  { channels: [...] }
 * The files are read and written by a storage backend (storage-node.js on a computer).
 */
const M3U = require('../src/m3u.js');

// 12 hex characters, like crypto.randomBytes(6).toString('hex'), with the Web Crypto every platform has.
function newId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// What is kept of a parsed channel.
function keep(c) {
  return {
    name: c.name,
    rawName: c.rawName || c.name,
    url: c.url,
    tvgId: c.tvgId || '',
    tvgName: c.tvgName || '',
    number: c.number || '',
    logo: c.logo || '',
    groups: c.groups || [],
    quality: c.quality || '',
    tags: c.tags || [],
    headers: c.headers || null,
  };
}

class Library {
  /**
   * @param {object} store  settings store; store.data.playlists holds { id, name, count, createdAt }
   * @param {string} dir    folder for the channel files
   * @param {function} [legacy]  async (playlist) => M3U text, for playlists saved by an older version
   *   (they pointed at a file instead of holding channels); each is converted once, on first use
   * @param {object} storage  storage backend that holds the channel files
   */
  constructor(store, dir, legacy, storage) {
    if (!storage) throw new Error('Library needs a storage backend');
    this.store = store;
    this.dir = dir;
    this.legacy = legacy;
    this.storage = storage;
    this.cache = new Map(); // id -> channels, for the playlists opened this session
  }

  get playlists() {
    return this.store.data.playlists;
  }

  find(id) {
    const p = this.playlists.find((x) => x.id === id);
    if (!p) throw new Error('This playlist no longer exists');
    return p;
  }

  file(id) {
    return this.storage.join(this.dir, `${id}.json`);
  }

  create(name) {
    const p = {
      id: newId(),
      name: String(name || '').trim().slice(0, 80) || 'My channels',
      count: 0,
      createdAt: Date.now(),
    };
    this.playlists.push(p);
    this.cache.set(p.id, []);
    this.store.save();
    return p;
  }

  rename(id, name) {
    const p = this.find(id);
    const n = String(name || '').trim().slice(0, 80);
    if (n) p.name = n;
    this.store.save();
    return p;
  }

  async remove(id) {
    // Only a playlist this library knows has a file to delete: the id becomes part of a file name.
    const known = this.playlists.some((p) => p.id === id);
    this.store.data.playlists = this.playlists.filter((p) => p.id !== id);
    if (this.store.data.activePlaylistId === id) this.store.data.activePlaylistId = '';
    this.store.save();
    this.cache.delete(id);
    if (known) await this.storage.remove(this.file(id));
  }

  async channels(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const p = this.find(id);
    let channels = null;
    try {
      const saved = JSON.parse(await this.storage.read(this.file(id)));
      if (saved && Array.isArray(saved.channels)) channels = saved.channels;
    } catch (e) { /* not written yet */ }

    if (!channels && p.source && this.legacy) {
      const text = await this.legacy(p);
      channels = M3U.parse(text).channels.map(keep);
      await this.write(id, channels);
      delete p.kind;
      delete p.source;
      delete p.epgUrl;
      delete p.addedAt;
      p.createdAt = p.createdAt || Date.now();
    }
    channels = channels || [];
    p.count = channels.length;
    this.store.save();
    this.cache.set(id, channels);
    return channels;
  }

  async write(id, channels) {
    await this.storage.write(this.file(id), JSON.stringify({ channels }));
  }

  /**
   * Adds the channels of an M3U text to a playlist. Channels whose stream address is already in
   * the playlist are skipped, so importing the same file twice changes nothing.
   * @returns {{ playlist, added:number, skipped:number }}
   */
  async importText(id, text, sourceName = 'The file') {
    // Only lines that are stream addresses count, so a stray text file adds nothing.
    const found = M3U.parse(text).channels.filter((c) => /^[a-z][a-z0-9+.-]*:\/\//i.test(c.url));
    if (!found.length) {
      throw new Error(`${sourceName} has no channels in it. Make sure it is an M3U playlist (it should start with #EXTM3U).`);
    }
    return this.addChannels(id, found);
  }

  /** Appends channels, skipping stream addresses the playlist already has. */
  async addChannels(id, found) {
    const p = this.find(id);
    const channels = await this.channels(id);
    const have = new Set(channels.map((c) => c.url));
    let added = 0;
    for (const c of found) {
      if (have.has(c.url)) continue;
      have.add(c.url);
      channels.push(keep(c));
      added++;
    }
    if (added) await this.write(id, channels);
    p.count = channels.length;
    this.store.save();
    return { playlist: p, added, skipped: found.length - added };
  }

  /**
   * Replaces all of a playlist's channels (refreshing a playlist that comes from a server). Hidden
   * groups and favorites are kept, as they go by group name and stream address.
   * @returns {{ playlist, added:number, removed:number }}
   */
  async replaceChannels(id, found) {
    const p = this.find(id);
    const before = new Set((await this.channels(id)).map((c) => c.url));
    const seen = new Set();
    const channels = [];
    for (const c of found) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      channels.push(keep(c));
    }
    let added = 0;
    for (const url of seen) if (!before.delete(url)) added++;
    this.cache.set(id, channels);
    await this.write(id, channels);
    p.count = channels.length;
    this.store.save();
    return { playlist: p, added, removed: before.size };
  }

  /** Extra details kept with a playlist, such as the login it was loaded with. */
  setSource(id, fields) {
    const p = this.find(id);
    Object.assign(p, fields);
    this.store.save();
    return p;
  }

  /** Groups the person chose not to see in this playlist (names; '\u0000ungrouped' for channels without one). */
  setHiddenGroups(id, names) {
    const p = this.find(id);
    p.hiddenGroups = [...new Set((Array.isArray(names) ? names : []).filter((n) => typeof n === 'string'))];
    this.store.save();
    return p;
  }

  async removeChannels(id, urls) {
    const p = this.find(id);
    const drop = new Set(urls);
    const channels = (await this.channels(id)).filter((c) => !drop.has(c.url));
    this.cache.set(id, channels);
    await this.write(id, channels);
    p.count = channels.length;
    this.store.save();
    return p;
  }
}

module.exports = { Library };
