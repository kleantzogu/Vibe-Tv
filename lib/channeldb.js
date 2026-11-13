'use strict';
/*
 * Channel database lookup (logos + categories) for playlists that only carry a tvg-id.
 * Data: the public iptv-org API (https://github.com/iptv-org/api).
 * The three JSON files are downloaded once, reduced to a compact index and cached on disk
 * (through a storage backend: storage-node.js on a computer).
 */
const { fetchJson } = require('./net');

const DEFAULT_API = 'https://iptv-org.github.io/api';
const MAX_AGE = 7 * 24 * 3600 * 1000;
const INDEX_VERSION = 1;

function logoScore(l) {
  let s = 0;
  if (l.in_use) s += 8;
  const fmt = String(l.format || '').toUpperCase();
  if (fmt === 'PNG' || fmt === 'SVG' || fmt === 'WEBP') s += 2;
  const w = Number(l.width) || 0;
  if (w >= 96 && w <= 1200) s += 2;
  const tags = Array.isArray(l.tags) ? l.tags : [];
  if (tags.includes('horizontal')) s -= 1; // square-ish marks read better in a small tile
  return s;
}

function buildIndex(channels, logos, categories) {
  const catName = {};
  for (const c of categories || []) catName[c.id] = c.name;

  const cats = {};
  for (const ch of channels || []) {
    if (!ch || !ch.id || !Array.isArray(ch.categories) || !ch.categories.length) continue;
    cats[ch.id.toLowerCase()] = ch.categories.map((id) => catName[id] || id.charAt(0).toUpperCase() + id.slice(1));
  }

  const best = new Map(); // key -> { url, score }
  const anyFeed = new Map(); // channel -> { url, score } (best logo that belongs to some feed)
  const consider = (map, key, url, score) => {
    const cur = map.get(key);
    if (!cur || score > cur.score) map.set(key, { url, score });
  };
  for (const l of logos || []) {
    if (!l || !l.channel || !/^https?:\/\//i.test(l.url || '')) continue;
    const ch = l.channel.toLowerCase();
    const score = logoScore(l);
    if (l.feed) {
      consider(best, ch + '@' + String(l.feed).toLowerCase(), l.url, score);
      consider(anyFeed, ch, l.url, score);
    } else {
      consider(best, ch, l.url, score);
    }
  }
  for (const [ch, v] of anyFeed) if (!best.has(ch)) best.set(ch, v);

  const logo = {};
  for (const [k, v] of best) logo[k] = v.url;
  return { v: INDEX_VERSION, cats, logo };
}

function lookup(index, tvgIds) {
  const out = {};
  if (!index) return out;
  for (const id of tvgIds) {
    if (!id) continue;
    const key = String(id).toLowerCase();
    const channel = key.split('@')[0];
    const logo = index.logo[key] || index.logo[channel] || '';
    const groups = index.cats[channel] || null;
    if (logo || groups) out[id] = { logo, groups };
  }
  return out;
}

class ChannelDb {
  constructor({ fetchImpl, cacheDir, api = DEFAULT_API, storage }) {
    if (!storage) throw new Error('ChannelDb needs a storage backend');
    this.fetchImpl = fetchImpl;
    this.storage = storage;
    this.file = storage.join(cacheDir, 'channel-db.json');
    this.api = api.replace(/\/$/, '');
    this.index = null;
    this.loadedAt = 0;
    this.pending = null;
  }

  async readCache() {
    try {
      const cached = JSON.parse(await this.storage.read(this.file));
      if (cached && cached.index && cached.index.v === INDEX_VERSION) return cached;
    } catch (e) { /* no cache yet */ }
    return null;
  }

  async download() {
    const opts = { timeout: 60000, maxBytes: 128 * 1024 * 1024 };
    const [channels, logos, categories] = await Promise.all([
      fetchJson(this.fetchImpl, this.api + '/channels.json', opts),
      fetchJson(this.fetchImpl, this.api + '/logos.json', opts),
      fetchJson(this.fetchImpl, this.api + '/categories.json', opts).catch(() => []),
    ]);
    if (!Array.isArray(channels) || !Array.isArray(logos)) throw new Error('Unexpected channel database format');
    const index = buildIndex(channels, logos, categories);
    try {
      await this.storage.write(this.file, JSON.stringify({ ts: Date.now(), index }));
    } catch (e) { /* cache is best effort */ }
    return index;
  }

  // Returns the index, or null when it cannot be obtained (offline and nothing cached).
  async load() {
    if (this.index && Date.now() - this.loadedAt < MAX_AGE) return this.index;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const cached = await this.readCache();
      if (cached && Date.now() - cached.ts < MAX_AGE) {
        this.index = cached.index;
        this.loadedAt = cached.ts;
        return this.index;
      }
      try {
        this.index = await this.download();
        this.loadedAt = Date.now();
      } catch (e) {
        if (cached) {
          this.index = cached.index; // stale is better than nothing
          this.loadedAt = Date.now() - MAX_AGE + 3600 * 1000; // try again in an hour
        } else {
          this.index = null;
        }
      }
      return this.index;
    })();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  async lookup(tvgIds) {
    const index = await this.load();
    return lookup(index, tvgIds);
  }
}

module.exports = { ChannelDb, buildIndex, lookup };
