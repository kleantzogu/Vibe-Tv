'use strict';
/* Self-contained checks for the parts that do not need a window: `npm test` */
const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const M3U = require('../src/m3u.js');
const { buildIndex, lookup } = require('../lib/channeldb.js');
const { XmltvParser, loadGuide, parseTime } = require('../lib/epg.js');
const { probe, sniff, checkAll } = require('../lib/probe.js');
const { Library } = require('../lib/library.js');
const { Store } = require('../lib/store.js');
const nodeStorage = require('../lib/storage-node.js');
const { memoryStorage } = require('../lib/storage-memory.js');
const { DEFAULTS, pruneStatus, applyPatch } = require('../lib/state.js');
const { createImports, decodeText } = require('../lib/imports.js');
const contract = require('../platform/api-contract.js');
const xtream = require('../lib/xtream.js');
const codecs = require('../lib/codecs.js');
const { Updates, notesText, friendlyError } = require('../lib/updates.js');
const startup = require('../lib/startup.js');
const { inputArgs, cleanError, parseStreams } = require('../lib/convert.js');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('playlist: attributes, names with commas, quality and tags', () => {
  const { channels, epgUrl } = M3U.parse(
    '\uFEFF#EXTM3U url-tvg="http://guide.example/a.xml.gz,http://guide.example/b.xml"\r\n' +
      '#EXTINF:-1 tvg-id="ABC.us@East" tvg-logo="https://img.example/abc.png" group-title="News;Local",ABC, East Coast (1080p) [Geo-blocked]\r\n' +
      'https://a.example/abc.m3u8\r\n' +
      '#EXTINF:-1 tvg-id="",Plain (Hawaii) (720p) [Not 24/7]\n' +
      '#EXTVLCOPT:http-referrer=https://ref.example/\n' +
      '#EXTVLCOPT:http-user-agent=Agent/1.0 (X11)\n' +
      'http://b.example/live\n' +
      '#EXTINF:0,Kodi style\n' +
      'http://c.example/s.m3u8|User-Agent=K%2F1&Referer=http://k.example/\n' +
      'http://d.example/path/cool-channel/index.m3u8\n'
  );
  assert.strictEqual(epgUrl, 'http://guide.example/a.xml.gz');
  assert.strictEqual(channels.length, 4);
  assert.deepStrictEqual(
    [channels[0].name, channels[0].quality, channels[0].tags, channels[0].groups, channels[0].logo, channels[0].tvgId],
    ['ABC, East Coast', '1080p', ['Geo-blocked'], ['News', 'Local'], 'https://img.example/abc.png', 'ABC.us@East']
  );
  assert.deepStrictEqual([channels[1].name, channels[1].quality, channels[1].tags], ['Plain (Hawaii)', '720p', ['Not 24/7']]);
  assert.deepStrictEqual(channels[1].headers, { referrer: 'https://ref.example/', userAgent: 'Agent/1.0 (X11)' });
  assert.strictEqual(channels[2].url, 'http://c.example/s.m3u8');
  assert.deepStrictEqual(channels[2].headers, { userAgent: 'K/1', referrer: 'http://k.example/' });
  assert.strictEqual(channels[3].name, 'cool-channel');
  assert.strictEqual(channels[3].headers, null);
});

test('playlist: search folding', () => {
  assert.strictEqual(M3U.fold('Télé Québec'), 'tele quebec');
  assert.strictEqual(M3U.matchKey('CNBC HD'), M3U.matchKey('cnbc'));
});

test('channel database: best logo and categories', () => {
  const index = buildIndex(
    [{ id: 'ABC.us', categories: ['general', 'news'] }],
    [
      { channel: 'ABC.us', feed: null, in_use: false, format: 'PNG', width: 300, url: 'https://x/old.png' },
      { channel: 'ABC.us', feed: null, in_use: true, format: 'PNG', width: 300, url: 'https://x/new.png' },
      { channel: 'ABC.us', feed: 'West', in_use: true, format: 'PNG', width: 300, url: 'https://x/west.png' },
      { channel: 'OnlyFeed.us', feed: 'HD', in_use: true, format: 'SVG', width: 300, url: 'https://x/feed.svg' },
    ],
    [{ id: 'general', name: 'General' }, { id: 'news', name: 'News' }]
  );
  const r = lookup(index, ['ABC.us@East', 'ABC.us@West', 'OnlyFeed.us@SD', 'Nope.us']);
  assert.deepStrictEqual(r['ABC.us@East'], { logo: 'https://x/new.png', groups: ['General', 'News'] });
  assert.strictEqual(r['ABC.us@West'].logo, 'https://x/west.png');
  assert.strictEqual(r['OnlyFeed.us@SD'].logo, 'https://x/feed.svg');
  assert.strictEqual(r['Nope.us'], undefined);
});

const stamp = (t) => new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
function sampleGuide(now) {
  let xml = '<?xml version="1.0"?><tv><channel id="One.us"><display-name>One</display-name></channel><channel id="n-2"><display-name>Two HD</display-name></channel><channel id="Skip.us"><display-name>Skip</display-name></channel>';
  for (const ch of ['One.us', 'n-2', 'Skip.us']) {
    for (let i = -30; i < 60; i++) {
      xml += `<programme start="${stamp(now + i * 3600e3)}" stop="${stamp(now + (i + 1) * 3600e3)}" channel="${ch}"><title lang="en">Show ${i} &amp; co</title><desc>About ${i}</desc></programme>`;
    }
  }
  return xml + '</tv>';
}

test('guide: time zones', () => {
  assert.strictEqual(parseTime('20261111183000 +0100'), Date.UTC(2026, 10, 11, 17, 30));
  assert.strictEqual(parseTime('20261111183000 -0530'), Date.UTC(2026, 10, 12, 0, 0));
  assert.strictEqual(parseTime('20261111183000'), Date.UTC(2026, 10, 11, 18, 30));
});

test('guide: streaming parser keeps wanted channels inside the time window', () => {
  const now = Date.UTC(2026, 10, 11, 12);
  const xml = sampleGuide(now);
  for (const size of [5, 333, xml.length]) {
    const p = new XmltvParser({ wantedIds: new Set(['one.us']), wantedNames: new Set([M3U.matchKey('Two')]), from: now - 6 * 3600e3, to: now + 48 * 3600e3 });
    for (let i = 0; i < xml.length; i += size) p.write(xml.slice(i, i + size));
    const g = p.finish();
    assert.deepStrictEqual(Object.keys(g.programmes).sort(), ['n-2', 'one.us']);
    assert.strictEqual(g.nameIndex[M3U.matchKey('Two')], 'n-2');
    assert.strictEqual(g.programmes['one.us'].length, 56);
    assert.strictEqual(g.programmes['one.us'][0][2], 'Show -7 & co');
  }
});

test('file reading: waits for cloud files, then explains what to do', async () => {
  const { readFileRetry, explainReadError } = require('../lib/readfile.js');
  const err = (code) => Object.assign(new Error(code), { code });
  let calls = 0;
  let waiting = 0;
  let nudged = 0;
  const flaky = async () => { if (++calls < 3) throw err('ETIMEDOUT'); return Buffer.from('#EXTM3U'); };
  const opts = { delays: [5, 5, 5], nudge: () => nudged++, onWaiting: () => waiting++ };
  assert.strictEqual(String(await readFileRetry('/x', { ...opts, read: flaky })), '#EXTM3U');
  assert.deepStrictEqual([calls, waiting, nudged], [3, 1, 1]);
  calls = 0;
  await assert.rejects(readFileRetry('/x', { ...opts, read: async () => { calls++; throw err('EDEADLK'); } }), /EDEADLK/);
  assert.strictEqual(calls, 4); // first try + three retries
  calls = 0;
  await assert.rejects(readFileRetry('/x', { ...opts, read: async () => { calls++; throw err('ENOENT'); } }), /ENOENT/);
  assert.strictEqual(calls, 1); // a missing file is not retried
  calls = 0;
  await assert.rejects(readFileRetry('/x', { ...opts, delays: [50, 50], deadline: 20, read: async () => { calls++; throw err('ETIMEDOUT'); } }));
  assert.strictEqual(calls, 1); // gives up once the overall deadline would be passed
  assert.match(explainReadError(err('ETIMEDOUT'), '/f.m3u', 'darwin').long, /Download Now/);
  assert.match(explainReadError(err('ETIMEDOUT'), 'C:\\f.m3u', 'win32').long, /downloaded to this computer/);
  assert.match(explainReadError(err('ENOENT'), '/f.m3u').long, /moved or deleted/);
  assert.match(explainReadError(err('EPERM'), '/f.m3u', 'darwin').long, /Privacy & Security/);
});

async function withServer(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await fn('http://127.0.0.1:' + srv.address().port);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
}

test('guide: gzip download', async () => {
  const xml = sampleGuide(Date.now());
  await withServer((req, res) => {
    if (req.url === '/g.xml.gz') res.end(zlib.gzipSync(xml));
    else if (req.url === '/bad') res.end('<html>nope</html>');
    else { res.statusCode = 404; res.end(); }
  }, async (base) => {
    const g = await loadGuide(fetch, base + '/g.xml.gz', { wantedIds: ['one.us'] });
    assert.ok(g.programmes['one.us'].length > 40);
    await assert.rejects(loadGuide(fetch, base + '/bad', {}), /XMLTV/);
    await assert.rejects(loadGuide(fetch, base + '/missing', {}), /404/);
  });
});

test('probe: stream kinds and dead streams', async () => {
  assert.strictEqual(sniff(Buffer.from('#EXTM3U\n'), ''), 'hls');
  assert.strictEqual(sniff(Buffer.from([0x47, 0x40, 0x00]), ''), 'mpegts');
  assert.strictEqual(sniff(Buffer.from('<?xml version="1.0"?><MPD xmlns="x">'), ''), 'dash');
  assert.strictEqual(sniff(Buffer.from('<!DOCTYPE html><html>'), 'text/html'), 'webpage');
  await withServer((req, res) => {
    if (req.url === '/master.m3u8') res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n');
    else if (req.url === '/media.m3u8') res.end('#EXTM3U\n#EXTINF:2,\ns0.ts\n');
    else if (req.url === '/deadmaster.m3u8') res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\ngone.m3u8\n');
    else if (req.url === '/ts') res.end(Buffer.alloc(188 * 20, 0x47));
    else if (req.url === '/hang') { /* never answers */ }
    else { res.statusCode = 404; res.end(); }
  }, async (base) => {
    assert.deepStrictEqual(await probe(fetch, base + '/master.m3u8'), { ok: true, kind: 'hls', status: 200 });
    assert.strictEqual((await probe(fetch, base + '/deadmaster.m3u8')).ok, false);
    assert.deepStrictEqual(await probe(fetch, base + '/ts'), { ok: true, kind: 'mpegts', status: 200 });
    assert.strictEqual((await probe(fetch, base + '/nope')).status, 404);
    assert.strictEqual((await probe(fetch, base + '/hang', null, { timeout: 500 })).reason, 'timeout');
    assert.strictEqual((await probe(fetch, 'rtmp://x/y')).reason, 'unsupported');
  });
});

test('check: limits per server, retries passing failures once', async () => {
  const ts = Buffer.alloc(188 * 4, 0x47);
  const running = new Map();
  const peak = new Map();
  const calls = new Map();
  let total = 0;
  let peakTotal = 0;
  const fakeFetch = async (url) => {
    const host = new URL(url).host;
    calls.set(url, (calls.get(url) || 0) + 1);
    running.set(host, (running.get(host) || 0) + 1);
    peak.set(host, Math.max(peak.get(host) || 0, running.get(host)));
    peakTotal = Math.max(peakTotal, ++total);
    await new Promise((r) => setTimeout(r, 10));
    running.set(host, running.get(host) - 1);
    total--;
    const path = new URL(url).pathname;
    const n = calls.get(url);
    if (path === '/flaky' && n === 1) return new Response('', { status: 503 });
    if (path === '/busy') return new Response('', { status: 403 });
    if (path === '/gone') return new Response('', { status: 404 });
    return new Response(ts, { status: 200 });
  };
  const items = [
    ...Array.from({ length: 20 }, (_, i) => ({ url: `http://iptv.example:8080/u/p/${i}` })),
    ...Array.from({ length: 6 }, (_, i) => ({ url: `http://other.example/${i}` })),
    { url: 'http://iptv.example:8080/flaky' },
    { url: 'http://iptv.example:8080/busy' },
    { url: 'http://iptv.example:8080/gone' },
  ];
  const results = new Map();
  const run = checkAll(fakeFetch, items, { concurrency: 5, perHost: 3, onResult: (it, r) => {
    assert.ok(!results.has(it.url), 'reported once');
    results.set(it.url, r);
  } });
  assert.deepStrictEqual(await run.done, { cancelled: false });
  assert.strictEqual(results.size, items.length);
  assert.strictEqual(peak.get('iptv.example:8080'), 3);
  assert.ok(peakTotal <= 5 && peakTotal > 3, 'other servers fill the remaining slots');
  assert.strictEqual(results.get('http://iptv.example:8080/flaky').ok, true);
  assert.strictEqual(calls.get('http://iptv.example:8080/flaky'), 2);
  assert.strictEqual(results.get('http://iptv.example:8080/busy').status, 403);
  assert.strictEqual(calls.get('http://iptv.example:8080/busy'), 2);
  assert.strictEqual(calls.get('http://iptv.example:8080/gone'), 1, 'a 404 is not retried');

  // Cancelling stops new probes and still settles.
  let seen = 0;
  const c = checkAll(fakeFetch, items, { concurrency: 2, perHost: 2, onResult: () => { seen++; } });
  setTimeout(() => c.cancel(), 25);
  assert.deepStrictEqual(await c.done, { cancelled: true });
  assert.ok(seen < items.length);
});

test('playlists: import appends, skips duplicates, converts old playlists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u-lib-'));
  const store = { data: { playlists: [{ id: 'old1', name: 'Old', kind: 'file', source: '/x.m3u' }], activePlaylistId: '' }, save() {} };
  const lib = new Library(store, dir, async () => '#EXTM3U\n#EXTINF:-1 group-title="News",One\nhttp://a/1\n', nodeStorage);
  try {
    const p = lib.create('Mine');
    const a = '#EXTM3U\n#EXTINF:-1 group-title="News",One\nhttp://a/1\n#EXTINF:-1,Two\nhttp://a/2\n';
    const b = '#EXTM3U\n#EXTINF:-1,Two again\nhttp://a/2\n#EXTINF:-1,Three\nhttp://a/3\n';
    assert.deepStrictEqual([(await lib.importText(p.id, a)).added, (await lib.importText(p.id, b)).added], [2, 1]);
    assert.strictEqual((await lib.importText(p.id, a)).skipped, 2);
    assert.strictEqual(p.count, 3);
    await assert.rejects(lib.importText(p.id, 'hello'), /no channels/);

    // Read back from disk, as after a restart.
    const again = new Library(store, dir, null, nodeStorage);
    assert.deepStrictEqual((await again.channels(p.id)).map((c) => c.name), ['One', 'Two', 'Three']);
    await again.removeChannels(p.id, ['http://a/2']);
    assert.deepStrictEqual((await new Library(store, dir, null, nodeStorage).channels(p.id)).map((c) => c.url), ['http://a/1', 'http://a/3']);

    // A playlist from an older version holds no channels, only a file; it is converted on first use.
    const old = await lib.channels('old1');
    assert.deepStrictEqual([old.length, old[0].groups], [1, ['News']]);
    assert.strictEqual(store.data.playlists[0].source, undefined);
    assert.ok(fs.existsSync(path.join(dir, 'old1.json')));

    // Hidden groups are kept per playlist, without duplicates.
    assert.deepStrictEqual(lib.setHiddenGroups(p.id, ['News', 'News', '\u0000ungrouped', 5]).hiddenGroups, ['News', '\u0000ungrouped']);

    await lib.remove(p.id);
    assert.ok(!fs.existsSync(path.join(dir, `${p.id}.json`)));
    assert.deepStrictEqual(store.data.playlists.map((x) => x.id), ['old1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('xtream: reads logins, lists channels and movies, refreshes a playlist', async () => {
  assert.deepStrictEqual(
    xtream.normalizeLogin({ server: 'http://tv.example:8080/get.php?username=me&password=p%20w&type=m3u_plus' }),
    { server: 'http://tv.example:8080', username: 'me', password: 'p w' }
  );
  assert.strictEqual(xtream.normalizeLogin({ server: 'tv.example:81/', username: ' me ', password: 'x' }).server, 'http://tv.example:81');
  assert.throws(() => xtream.normalizeLogin({ server: 'tv.example' }), /username/);
  assert.deepStrictEqual([xtream.liveExtension([]), xtream.liveExtension(['m3u8', 'ts']), xtream.liveExtension(['m3u8'])], ['ts', 'ts', 'm3u8']);

  let live = [
    { num: 1, name: 'News One (1080p)', stream_id: 11, stream_icon: 'http://img/1.png', epg_channel_id: 'one.us', category_id: '5' },
    { num: 2, name: 'Sport', stream_id: 12, stream_icon: '', category_id: '9', category_ids: [9, 5] },
  ];
  await withServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    if (!req.url.startsWith('/player_api.php')) { res.statusCode = 404; return res.end(); }
    if (q.get('password') !== 'secret') return res.end(JSON.stringify({ user_info: { auth: 0 } }));
    const action = q.get('action') || '';
    const body = {
      '': { user_info: { auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 86400), max_connections: '2', allowed_output_formats: ['m3u8', 'ts'] } },
      get_live_categories: [{ category_id: '5', category_name: 'News' }, { category_id: '9', category_name: 'Sports' }],
      get_live_streams: live,
      get_vod_categories: [{ category_id: '1', category_name: 'Action' }],
      get_vod_streams: [{ name: 'A Film', stream_id: 70, container_extension: 'mkv', category_id: '1' }],
    }[action];
    res.end(JSON.stringify(body === undefined ? [] : body));
  }, async (base) => {
    await assert.rejects(xtream.loadAccount(fetch, { server: base, username: 'me', password: 'nope' }), /not accepted/);
    await assert.rejects(xtream.loadAccount(fetch, { server: base + '/elsewhere', username: 'me', password: 'secret' }), /reach the server|404/);

    const r = await xtream.loadAccount(fetch, { server: base + '/player_api.php', username: 'me', password: 'secret' }, { movies: true });
    assert.deepStrictEqual([r.live, r.movies, r.account.maxConnections], [2, 1, 2]);
    assert.ok(r.account.expires > Date.now());
    const [one, sport, film] = r.channels;
    assert.deepStrictEqual(
      [one.name, one.quality, one.url, one.tvgId, one.number, one.groups],
      ['News One', '1080p', `${base}/live/me/secret/11.ts`, 'one.us', '1', ['News']]
    );
    assert.deepStrictEqual(sport.groups, ['Sports', 'News']);
    assert.deepStrictEqual([film.url, film.groups], [`${base}/movie/me/secret/70.mkv`, ['Movies: Action']]);

    // Refreshing replaces the channels: new ones come in, ones the server dropped go.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u-xt-'));
    const store = { data: { playlists: [], activePlaylistId: '' }, save() {} };
    const lib = new Library(store, dir, null, nodeStorage);
    try {
      const p = lib.create('TV');
      await lib.addChannels(p.id, r.channels.slice(0, 2));
      live = [live[1], { name: 'Kids', stream_id: 13, category_id: '5' }];
      const again = await xtream.loadAccount(fetch, { server: base, username: 'me', password: 'secret' });
      const res = await lib.replaceChannels(p.id, again.channels);
      assert.deepStrictEqual([res.added, res.removed, p.count], [1, 1, 2]);
      assert.deepStrictEqual((await new Library(store, dir, null, nodeStorage).channels(p.id)).map((c) => c.name), ['Sport', 'Kids']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Builds MPEG-TS packets: a PAT, a PMT listing the given streams, and optionally one audio PES.
function tsPackets(streams, audioFrame) {
  const packet = (pid, payload, start = true) => {
    const b = Buffer.alloc(188, 0xff);
    b[0] = 0x47; b[1] = (start ? 0x40 : 0) | (pid >> 8); b[2] = pid & 0xff; b[3] = 0x10;
    payload.copy(b, 4);
    return b;
  };
  const section = (tableId, body) => {
    const len = body.length + 4; // + CRC (not checked)
    return Buffer.concat([Buffer.from([0, tableId, 0xb0 | (len >> 8), len & 0xff]), body, Buffer.alloc(4)]);
  };
  const pat = section(0x00, Buffer.from([0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00])); // program 1 -> PMT PID 0x1000
  const entries = streams.map(([type, pid, desc = []]) => Buffer.from([type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, desc.length, ...desc]));
  const pmt = section(0x02, Buffer.concat([Buffer.from([0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00]), ...entries]));
  const out = [packet(0, pat), packet(0x1000, pmt)];
  if (audioFrame) {
    const [pid, header] = audioFrame;
    out.push(packet(pid, Buffer.from([0, 0, 1, 0xc0, 0, 0, 0x80, 0x80, 0, ...header])));
  }
  return Buffer.concat(out);
}

test('codecs: reads the MPEG-TS program map and decides what to convert', () => {
  const kinds = (buf) => codecs.tsStreams(buf).streams.map((x) => `${x.kind}:${x.codec}`);
  assert.deepStrictEqual(kinds(tsPackets([[0x1b, 0x100], [0x0f, 0x101]])), ['video:h264', 'audio:aac']);
  assert.deepStrictEqual(kinds(tsPackets([[0x02, 0x100], [0x81, 0x101]])), ['video:mpeg2video', 'audio:ac3']);
  // DVB private streams say what they are in descriptors: E-AC-3, AC-3, teletext; registration 'Opus'.
  assert.deepStrictEqual(kinds(tsPackets([[0x24, 0x100], [0x06, 0x101, [0x7a, 0]], [0x06, 0x102, [0x6a, 0]], [0x06, 0x103, [0x56, 0]], [0x06, 0x104, [0x05, 4, 0x4f, 0x70, 0x75, 0x73]]])),
    ['video:hevc', 'audio:eac3', 'audio:ac3', 'data:teletext', 'audio:opus']);
  // MPEG audio: the frame header tells MP3 (layer III) from MP2 (layer II); unknown counts as MP2.
  assert.deepStrictEqual(kinds(tsPackets([[0x1b, 0x100], [0x04, 0x101]], [0x101, [0xff, 0xfb]])), ['video:h264', 'audio:mp3']);
  assert.deepStrictEqual(kinds(tsPackets([[0x1b, 0x100], [0x03, 0x101]], [0x101, [0xff, 0xfd]])), ['video:h264', 'audio:mp2']);
  assert.strictEqual(codecs.tsStreams(tsPackets([[0x03, 0x101]])).streams[0].unsure, true);
  assert.strictEqual(codecs.tsStreams(Buffer.from('not a stream')).found, false);

  const can = { video: ['h264', 'hevc'], audio: ['aac', 'mp3'] };
  const plan = (list) => codecs.plan(list.map(([kind, codec]) => ({ kind, codec })), can);
  assert.strictEqual(plan([['video', 'h264'], ['audio', 'aac']]).convert, false);
  assert.deepStrictEqual(((p) => [p.convert, p.video, p.audio])(plan([['video', 'hevc'], ['audio', 'eac3']])), [true, 'copy', 'encode']);
  assert.deepStrictEqual(((p) => [p.video, p.audio, p.why])(plan([['video', 'mpeg2video'], ['audio', 'mp2']])), ['encode', 'encode', 'mpeg2video video and mp2 audio']);
  // A second, playable audio track is picked (and passed through) instead of converting the first.
  assert.deepStrictEqual(((p) => [p.convert, p.audio, p.audioTrack])(plan([['video', 'h264'], ['audio', 'ac3'], ['audio', 'aac']])), [true, 'copy', 1]);
  assert.deepStrictEqual(((p) => [p.convert, p.video, p.audio])(plan([['audio', 'mp2']])), [true, 'none', 'encode']);

  assert.deepStrictEqual(codecs.hlsStreams('#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640028,ec-3"\nv.m3u8').map((x) => x.codec), ['h264', 'eac3']);
});

test('convert: ffmpeg input options per kind of address', () => {
  const http = inputArgs('http://h/x', { userAgent: 'UA/1', referrer: 'http://r/' });
  assert.ok(http.includes('-reconnect') && http[http.indexOf('-user_agent') + 1] === 'UA/1' && http[http.indexOf('-referer') + 1] === 'http://r/');
  assert.ok(inputArgs('rtsp://cam/1').includes('-rtsp_transport'));
  assert.ok(inputArgs('udp://239.0.0.1:1234').includes('-overrun_nonfatal'));
  assert.strictEqual(inputArgs('http://h/x', null, { loglevel: 'info' })[inputArgs('http://h/x').indexOf('-loglevel') + 1], 'info');
  const listed = parseStreams([
    'Input #0, mpegts, from \'x\':',
    '  Program 1',
    '  Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p, 1920x1080',
    '  Stream #0:1[0x101](eng): Audio: ac3 (AC-3 / 0x332D4341), 48000 Hz, stereo',
    '  Program 2',
    '  Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p, 1920x1080',
    '  Stream #0:2: Video: mjpeg (Baseline), yuvj420p, 600x600 (attached pic)',
  ].join('\n'));
  assert.deepStrictEqual(listed.map((x) => `${x.kind}:${x.codec}`), ['video:h264', 'audio:ac3']);
  assert.strictEqual(inputArgs('http://h/x').slice(-2).join(' '), '-i http://h/x');
  assert.strictEqual(cleanError('[http @ 0x1] HTTP error 403 Forbidden'), 'The server refused the stream (403)');
});

test('updates: release notes, errors, and running from source', async () => {
  assert.strictEqual(notesText('<h2>New</h2><ul><li>Quick search</li><li>Faster &amp; smoother</li></ul>'), 'New\n• Quick search\n• Faster & smoother');
  assert.strictEqual(notesText([{ note: '<p>One</p>' }, { note: '<p>Two</p>' }]), 'One\n\nTwo');
  assert.strictEqual(friendlyError(new Error('net::ERR_INTERNET_DISCONNECTED')), 'No internet connection');
  assert.strictEqual(friendlyError(new Error('HttpError: 404 Not Found')), 'No release has been published yet');
  // From source there is nothing to update: no checks, no electron-updater loaded.
  const u = new Updates({ enabled: false, auto: true, currentVersion: '1.0.0' });
  assert.deepStrictEqual([u.state.status, (await u.check(true)).status], ['off', 'off']);
});

test('credits: the acknowledgements list matches what ships', () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'credits.js'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'credits.json'), 'utf8'));
  const names = c.sections.flatMap((s) => s.items.map((i) => i.name));
  for (const n of ['hls.js', 'mpegts.js', 'dash.js', 'FFmpeg', 'Electron', 'electron-updater']) assert.ok(names.includes(n), n);
  for (const s of c.sections) for (const i of s.items) assert.ok(i.license && i.url && i.purpose, i.name);
});

test('startup: recovery after failed starts, and private details kept out', () => {
  // First start of a version: try it. Each start counts as failed until the app reports in.
  assert.deepStrictEqual(startup.decide({}, '1.3.0', false), { recover: false, failures: 1, lastError: '' });
  assert.strictEqual(startup.decide({ version: '1.3.0', failures: 1 }, '1.3.0', false).recover, false);
  // Two failed starts in a row: go straight to recovery, unless the person says "Try again".
  assert.deepStrictEqual(startup.decide({ version: '1.3.0', failures: 2, lastError: 'boom' }, '1.3.0', false), { recover: true, failures: 2, lastError: 'boom' });
  assert.strictEqual(startup.decide({ version: '1.3.0', failures: 2 }, '1.3.0', true).recover, false);
  // A new version (the fix) starts with a clean slate.
  assert.deepStrictEqual(startup.decide({ version: '1.3.0', failures: 5, lastError: 'x' }, '1.3.1', false), { recover: false, failures: 1, lastError: '' });

  const raw = 'TypeError at /Users/kleant/Library/x.js and C:\\Users\\Kleant\\a.js while playing http://srv:8080/user/pass/123 (rtmp://a/b)';
  const safe = startup.sanitize(raw, '/Users/kleant');
  assert.ok(!/kleant/i.test(safe) && !/user\/pass/.test(safe), safe);
  assert.ok(safe.includes('<address>') && safe.includes('~/Library/x.js'), safe);

  const url = startup.issueUrl({ owner: 'o', repo: 'r' }, { version: '1.3.0', platform: 'win32', arch: 'x64', error: 'boom' });
  assert.ok(url.startsWith('https://github.com/o/r/issues/new?labels=bug&title=Vibe%20TV%201.3.0'));
  assert.ok(decodeURIComponent(url).includes('boom'));
});

test('storage: settings are saved to a file in one step, and read back over the defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u-store-'));
  const file = path.join(dir, 'deep', 'settings.json');
  try {
    const s = new Store(file, DEFAULTS, nodeStorage);
    assert.deepStrictEqual(s.data, DEFAULTS);
    s.data.favorites.push('http://a/1');
    s.data.settings.volume = 0.5;
    s.flush();
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['settings.json']); // no temporary file left behind
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), s.data);

    // A file from an older version: missing settings take their defaults, unknown keys are dropped.
    fs.writeFileSync(file, JSON.stringify({ favorites: ['x'], settings: { muted: true }, gone: 1 }));
    const again = new Store(file, DEFAULTS, nodeStorage);
    assert.deepStrictEqual([again.data.favorites, again.data.settings.muted, again.data.settings.volume, again.data.gone], [['x'], true, 1, undefined]);
    assert.deepStrictEqual(DEFAULTS.favorites, []); // the defaults themselves are never written to
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state: only what the window may change is taken from a patch', () => {
  const data = structuredClone(DEFAULTS);
  assert.deepStrictEqual(applyPatch(data, null), { changed: false, settings: false });
  assert.deepStrictEqual(applyPatch(data, { favorites: ['a'], playlists: 'nope', activePlaylistId: 5 }), { changed: true, settings: false });
  assert.deepStrictEqual([data.favorites, data.playlists, data.activePlaylistId], [['a'], [], '']);
  assert.strictEqual(applyPatch(data, { settings: { muted: true } }).settings, true);
  assert.deepStrictEqual([data.settings.muted, data.settings.volume], [true, 1]);

  const now = Date.now();
  data.status = { fresh: { s: 'ok', t: now - 1000 }, old: { s: 'dead', t: now - 40 * 24 * 3600 * 1000 }, broken: null };
  pruneStatus(data, now);
  assert.deepStrictEqual(Object.keys(data.status), ['fresh']);
});

test('backend without files: playlists, imports and settings on any storage (as on Android)', async () => {
  const { createBackend } = require('../platform/android/backend.js');
  const storage = memoryStorage();
  await withServer((req, res) => {
    if (req.url === '/lists/sports.m3u') return res.end('#EXTM3U\n#EXTINF:-1 group-title="Sport",One\nhttp://a/1\n');
    if (req.url === '/latin1.m3u') return res.end(Buffer.from('#EXTM3U\n#EXTINF:-1,Caf\xe9\nhttp://a/2\n', 'latin1'));
    res.statusCode = 404;
    res.end();
  }, async (base) => {
    const b = await createBackend({ storage, fetchImpl: fetch, dataDir: 'data' });
    assert.deepStrictEqual(b.store.data, DEFAULTS);

    // From an address: the new playlist is named after the file.
    const first = await b.imports.importUrl('', base + '/lists/sports.m3u');
    assert.deepStrictEqual([first.created, first.added, first.playlist.name], [true, 1, 'sports']);
    assert.match(first.playlist.id, /^[0-9a-f]{12}$/);
    // Older playlists that are not UTF-8 still read correctly.
    const second = await b.imports.importUrl(first.playlist.id, base + '/latin1.m3u');
    assert.deepStrictEqual([second.created, second.added], [false, 1]);
    assert.deepStrictEqual((await b.library.channels(first.playlist.id)).map((c) => c.name), ['One', 'Café']);
    // A failed import of a new playlist leaves nothing behind.
    await assert.rejects(b.imports.importUrl('', base + '/missing.m3u'), /download the playlist/);
    await assert.rejects(b.imports.importUrl('', 'ftp://a/b'), /http:\/\/ or https:\/\//);
    assert.strictEqual(b.library.playlists.length, 1);

    // From picked files: one playlist for all of them, and a file that cannot be read is reported.
    const picked = await b.imports.importTexts('', [
      { name: 'My list.m3u8', read: async () => '#EXTM3U\n#EXTINF:-1,Three\nhttp://a/3\n' },
      { name: 'broken.m3u', read: async () => { throw new Error('could not read it'); } },
      { name: 'again.m3u', read: async () => '#EXTM3U\n#EXTINF:-1,Three\nhttp://a/3\n#EXTINF:-1,Four\nhttp://a/4\n' },
    ]);
    assert.deepStrictEqual([picked.created, picked.playlist.name, picked.added, picked.skipped, picked.errors], [true, 'My list', 2, 1, ['could not read it']]);
    assert.strictEqual(await b.imports.importTexts('', []), null);

    b.patchState({ favorites: ['http://a/1'], activePlaylistId: first.playlist.id });
    b.store.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepStrictEqual([...storage.files.keys()].sort(), [`data/playlists/${first.playlist.id}.json`, `data/playlists/${picked.playlist.id}.json`, 'data/settings.json'].sort());

    // After a restart everything is still there.
    const again = await createBackend({ storage, fetchImpl: fetch, dataDir: 'data' });
    assert.deepStrictEqual([again.store.data.favorites, again.store.data.activePlaylistId], [['http://a/1'], first.playlist.id]);
    assert.deepStrictEqual(again.library.playlists.map((p) => [p.name, p.count]), [['sports', 2], ['My list', 2]]);
    assert.strictEqual((await again.library.channels(picked.playlist.id))[1].name, 'Four');
  });
  assert.strictEqual(decodeText(Buffer.from('é', 'utf8')), 'é');
});

test('platforms: preload.js offers exactly the calls and events of the contract', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const block = /exposeInMainWorld\('api', \{([\s\S]*?)\n\}\);/.exec(preload)[1];
  const offered = [...block.matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]);
  assert.deepStrictEqual(offered.slice().sort(), Object.keys(contract.METHODS).sort());
  const events = [.../const EVENTS = new Set\(\[([^\]]*)\]\)/.exec(preload)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(events.sort(), Object.keys(contract.EVENTS).sort());
  // Every call the window makes is in the contract.
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  for (const m of app.matchAll(/\bapi\.(\w+)\(/g)) assert.ok(contract.METHODS[m[1]], `app.js calls api.${m[1]}, which is not in the contract`);
});

test('android: window.api offers the same calls as on a computer, and starts empty', async () => {
  const { createApi } = require('../platform/android/api.js');
  const { createBackend } = require('../platform/android/backend.js');
  const opened = [];
  const credits = { app: { url: 'https://github.com/o/r', version: '0' }, sections: [{ items: [{ url: 'https://x.example/lib' }] }] };
  const make = (tv) => createApi({
    openBackend: () => createBackend({ storage: memoryStorage(), fetchImpl: fetch }),
    getDevice: async () => ({ tv, version: '9.9.9' }),
    host: { confirm: async () => true, copyText: async () => {}, credits: async () => structuredClone(credits), openExternal: async (u) => { opened.push(u); } },
  });
  const { api, emit } = make(false);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const onDesktop = [.../exposeInMainWorld\('api', \{([\s\S]*?)\n\}\);/.exec(preload)[1].matchAll(/^ {2}(\w+): /gm)].map((m) => m[1]);
  assert.deepStrictEqual(Object.keys(api).sort(), onDesktop.sort());
  assert.deepStrictEqual(Object.keys(api).sort(), Object.keys(contract.METHODS).sort());

  await assert.rejects(api.createPlaylist('Too early'), /not started/);
  const init = await api.init();
  assert.deepStrictEqual([init.platform, init.version, init.files, init.accent], ['android', '9.9.9', [], '']);
  assert.deepStrictEqual(init.state, DEFAULTS);
  assert.strictEqual((await make(true).api.init()).platform, 'androidtv');

  // What the window is handed is a copy, as it is across Electron's process boundary.
  init.state.favorites.push('changed in the window');
  const p = await api.createPlaylist('Mine');
  p.name = 'changed in the window';
  assert.strictEqual((await api.renamePlaylist(p.id, '')).name, 'Mine');
  assert.deepStrictEqual(await api.playlistChannels(p.id), []);
  assert.deepStrictEqual((await api.setHiddenGroups(p.id, ['News'])).hiddenGroups, ['News']);
  api.patchState({ activePlaylistId: p.id });

  // Not there yet says so; what Android never needs answers quietly.
  await assert.rejects(api.importUrl('', 'http://a/b.m3u'), /not available on Android yet/);
  await assert.rejects(api.startCheck([]), /not available on Android yet/);
  assert.deepStrictEqual([(await api.updateState()).status, (await api.mediaCaps({})).convert, await api.popupMenu([]), await api.convertInspect('x')], ['off', false, null, []]);
  assert.strictEqual(await api.confirm({ message: 'Sure?' }), true);
  assert.strictEqual((await api.credits()).app.version, '9.9.9');
  await api.openCreditLink('https://x.example/lib');
  await assert.rejects(api.openCreditLink('https://evil.example/'), /not in the acknowledgements/);
  assert.deepStrictEqual(opened, ['https://x.example/lib']);

  const got = [];
  api.on('check:progress', (batch) => got.push(batch));
  emit('check:progress', [{ url: 'http://a/1', ok: true }]);
  assert.deepStrictEqual(got, [[{ url: 'http://a/1', ok: true }]]);
  assert.throws(() => api.on('nope', () => {}), /Unknown event/);
});

test('android: the web app builds, with nothing from Node in it', async () => {
  const { build } = require('../scripts/build-android-web.js');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-www-'));
  try {
    await build(out);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(html.indexOf('platform-android.js') > 0 && html.indexOf('platform-android.js') < html.indexOf('<script src="app.js">'));
    const bundle = fs.readFileSync(path.join(out, 'platform-android.js'), 'utf8');
    assert.ok(!/\brequire\(["'](fs|path|crypto|child_process|electron)["']\)/.test(bundle));
    assert.ok(!/\beval\(|new Function\(/.test(bundle), 'the page forbids eval');
    assert.ok(html.includes('name="viewport"') && html.indexOf('android.css') > html.indexOf('styles.css'), 'Android styles come after the shared ones');
    for (const f of ['app.js', 'm3u.js', 'styles.css', 'android.css', 'credits.json', 'vendor/hls.min.js']) assert.ok(fs.existsSync(path.join(out, f)), f);
    assert.ok(!fs.existsSync(path.join(out, 'recovery.html')));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('ok   ' + name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + name + '\n     ' + String(e.stack || e).split('\n').slice(0, 4).join('\n     '));
    }
  }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nAll ${tests.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
