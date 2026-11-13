'use strict';
/*
 * Xtream Codes logins. Many IPTV providers hand out a server address, a username and a password
 * instead of an M3U file. Their server answers a small JSON API (player_api.php); this turns its
 * channel lists into the same channel objects an imported M3U playlist gives.
 */
const { fetchJson, describe } = require('./net');
const M3U = require('../src/m3u.js');

const MAX_BYTES = 256 * 1024 * 1024; // big providers list well over 100,000 movies
// Account details and category lists are small; a smaller cap keeps a hostile server from making
// every call of a login hold a quarter gigabyte at once.
const MAX_SMALL_BYTES = 16 * 1024 * 1024;

/**
 * Reads what the person typed. The server may be "host:8080", "http://host:8080/", or a full
 * get.php / player_api.php address, which can carry the username and password too.
 * @returns {{ server:string, username:string, password:string }}
 */
function normalizeLogin({ server, username, password } = {}) {
  let text = String(server || '').trim();
  if (!text) throw new Error('Enter the server address your provider gave you');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'http://' + text;
  let u;
  try {
    u = new URL(text);
  } catch (e) {
    throw new Error('That server address does not look right. It is usually like http://example.com:8080');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The server address must start with http:// or https://');
  const user = String(username || '').trim() || u.searchParams.get('username') || decodeURIComponent(u.username || '');
  const pass = String(password || '') || u.searchParams.get('password') || decodeURIComponent(u.password || '');
  if (!user) throw new Error('Enter your username');
  if (!pass) throw new Error('Enter your password');
  // Keep any folder the server lives under, but not the API file itself.
  const dir = u.pathname.replace(/\/(get|player_api|panel_api|xmltv)\.php$/i, '').replace(/\/+$/, '');
  return { server: `${u.protocol}//${u.host}${dir}`, username: user, password: pass };
}

const apiUrl = (login, action) => {
  const q = new URLSearchParams({ username: login.username, password: login.password });
  if (action) q.set('action', action);
  return `${login.server}/player_api.php?${q}`;
};

async function call(fetchImpl, login, action, timeout, maxBytes = MAX_SMALL_BYTES) {
  try {
    return await fetchJson(fetchImpl, apiUrl(login, action), { timeout, maxBytes });
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error('That server did not answer like an Xtream Codes server. Check the address and port.');
    if (/\((401|403)\)/.test(e.message)) throw new Error('The username or password was not accepted.');
    throw new Error(`Couldn’t reach the server: ${describe(e)}.`);
  }
}

/** Logs in. Resolves with the account details, or rejects with a reason a person can act on. */
async function authenticate(fetchImpl, login, { timeout = 20000 } = {}) {
  const info = await call(fetchImpl, login, '', timeout);
  const user = info && info.user_info;
  if (!user || typeof user !== 'object') {
    throw new Error('That server did not answer like an Xtream Codes server. Check the address and port.');
  }
  if (Number(user.auth) !== 1) throw new Error('The username or password was not accepted.');
  const status = String(user.status || 'Active');
  const exp = Number(user.exp_date) > 0 ? Number(user.exp_date) * 1000 : 0;
  if (/expired/i.test(status) || (exp && exp < Date.now())) throw new Error('This account has expired. Contact your provider to renew it.');
  if (/banned|disabled/i.test(status)) throw new Error(`This account is ${status.toLowerCase()}.`);
  const formats = Array.isArray(user.allowed_output_formats) ? user.allowed_output_formats.map(String) : [];
  return {
    status,
    expires: exp,
    maxConnections: Number(user.max_connections) || 0,
    activeConnections: Number(user.active_cons) || 0,
    formats,
  };
}

// MPEG-TS is what providers' own M3U files point at; HLS when that is all the account allows.
function liveExtension(formats) {
  if (!formats.length || formats.includes('ts')) return 'ts';
  if (formats.includes('m3u8')) return 'm3u8';
  return formats[0];
}

const list = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const seg = (s) => encodeURIComponent(s);

function categoryNames(categories) {
  const names = new Map();
  for (const c of list(categories)) {
    if (c && c.category_id != null) names.set(String(c.category_id), String(c.category_name || '').trim());
  }
  return names;
}

function toChannel(s, url, groups) {
  const rawName = String(s.name || s.title || '').trim() || `Stream ${s.stream_id}`;
  const { name, quality, tags } = M3U.splitName(rawName);
  const logo = String(s.stream_icon || s.cover || '');
  return {
    name,
    rawName,
    url,
    tvgId: String(s.epg_channel_id || ''),
    tvgName: '',
    number: s.num != null ? String(s.num) : '',
    logo: /^(https?:|data:image\/)/i.test(logo) ? logo : '',
    groups,
    quality,
    tags,
    headers: null,
  };
}

function groupsOf(s, names, prefix) {
  const ids = Array.isArray(s.category_ids) && s.category_ids.length ? s.category_ids : [s.category_id];
  const groups = [...new Set(ids.map((id) => names.get(String(id))).filter(Boolean))];
  return prefix ? (groups.length ? groups.map((g) => `${prefix}: ${g}`) : [prefix]) : groups;
}

/**
 * Logs in and lists the account's channels (and, when asked, its movies).
 * @returns {{ login, account, channels: object[], live:number, movies:number }}
 */
async function loadAccount(fetchImpl, input, { movies = false, timeout = 60000 } = {}) {
  const login = normalizeLogin(input);
  const account = await authenticate(fetchImpl, login);
  const u = seg(login.username);
  const p = seg(login.password);

  const [liveCats, liveStreams, vodCats, vodStreams] = await Promise.all([
    call(fetchImpl, login, 'get_live_categories', timeout).catch(() => []),
    call(fetchImpl, login, 'get_live_streams', timeout, MAX_BYTES),
    movies ? call(fetchImpl, login, 'get_vod_categories', timeout).catch(() => []) : [],
    movies ? call(fetchImpl, login, 'get_vod_streams', timeout, MAX_BYTES) : [],
  ]);

  const channels = [];
  const ext = liveExtension(account.formats);
  const liveNames = categoryNames(liveCats);
  for (const s of list(liveStreams)) {
    if (!s || s.stream_id == null) continue;
    channels.push(toChannel(s, `${login.server}/live/${u}/${p}/${s.stream_id}.${ext}`, groupsOf(s, liveNames)));
  }
  const live = channels.length;

  const vodNames = categoryNames(vodCats);
  for (const s of list(vodStreams)) {
    if (!s || s.stream_id == null) continue;
    const container = /^[a-z0-9]{2,5}$/i.test(String(s.container_extension || '')) ? s.container_extension : 'mp4';
    channels.push(toChannel(s, `${login.server}/movie/${u}/${p}/${s.stream_id}.${container}`, groupsOf(s, vodNames, 'Movies')));
  }

  if (!channels.length) throw new Error('You are logged in, but this account has no channels.');
  return { login, account, channels, live, movies: channels.length - live };
}

module.exports = { normalizeLogin, authenticate, loadAccount, liveExtension };
