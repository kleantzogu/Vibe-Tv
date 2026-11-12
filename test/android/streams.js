'use strict';
/*
 * Test streams for the Android app: `node test/android/streams.js`
 *
 * Makes a set of streams with the project's own ffmpeg (a test picture and a tone, nothing from a
 * real provider) and serves them on this computer, port 8123. An Android emulator reaches this
 * computer at 10.0.2.2, so in the app import  http://10.0.2.2:8123/test.m3u
 *
 * Like most IPTV servers, the streams are plain http and do NOT allow requests from web pages
 * (no CORS headers); the same streams under /cors/ do. Live MPEG-TS channels are encoded while
 * they are watched and never end.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ffmpeg = process.env.VIBE_TV_FFMPEG || require('ffmpeg-static');

const PORT = Number(process.env.PORT) || 8123;
const BASE = process.env.BASE || `http://10.0.2.2:${PORT}`;
const dir = path.join(__dirname, '..', '..', '.dev', 'android-streams'); // .dev/ is not in Git

const picture = (label) => ['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25,drawbox=x=0:y=0:w=640:h=40:color=black@0.6:t=fill`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-metadata', `title=${label}`];
const VIDEO = {
  h264: ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '50', '-b:v', '700k'],
  hevc: ['-c:v', 'libx265', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '50', '-b:v', '600k', '-x265-params', 'log-level=error'],
  mpeg2: ['-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-g', '12', '-b:v', '1500k'],
};
const AUDIO = {
  aac: ['-c:a', 'aac', '-b:a', '96k', '-ac', '2'],
  mp2: ['-c:a', 'mp2', '-b:a', '128k', '-ac', '2'],
  ac3: ['-c:a', 'ac3', '-b:a', '192k', '-ac', '2'],
  eac3: ['-c:a', 'eac3', '-b:a', '192k', '-ac', '2'],
};

// Live MPEG-TS channels (Xtream-style addresses): number -> [name, video, audio]
const LIVE = {
  1: ['MPEG-TS · H.264 + AAC', 'h264', 'aac'],
  2: ['MPEG-TS · H.264 + MP2', 'h264', 'mp2'],
  3: ['MPEG-TS · H.264 + AC-3', 'h264', 'ac3'],
  4: ['MPEG-TS · MPEG-2 + MP2', 'mpeg2', 'mp2'],
  5: ['MPEG-TS · HEVC + AAC', 'hevc', 'aac'],
  6: ['MPEG-TS · H.264 + E-AC-3', 'h264', 'eac3'],
};

const CHANNELS = [
  ['HLS live · H.264 + AAC', '/hls-live/index.m3u8'],
  ['HLS live · server allows web pages (CORS)', '/cors/hls-live/index.m3u8'],
  ['HLS · address without .m3u8, redirected', '/play/hls-live'],
  ['HLS film · H.264 + AC-3', '/hls-ac3/index.m3u8'],
  ...Object.entries(LIVE).map(([n, [name]]) => [name, `/live/user/pass/${n}.ts`]),
  ['MP4 film · H.264 + AAC', '/vod/film.mp4'],
  ['MKV film · H.264 + AC-3', '/vod/film.mkv'],
  ['DASH film · H.264 + AAC', '/dash/manifest.mpd'],
  ['HLS · needs Referer and User-Agent', '/protected/index.m3u8', ['#EXTVLCOPT:http-referrer=http://ref.example/', '#EXTVLCOPT:http-user-agent=VibeTest/1.0']],
  ['Offline · server answers 404', '/gone/index.m3u8'],
  ['A web page instead of a stream', '/page.html'],
];

function playlist() {
  const lines = ['#EXTM3U'];
  for (const [name, url, extra = []] of CHANNELS) lines.push(`#EXTINF:-1 group-title="Test streams",${name}`, ...extra, BASE + url);
  return lines.join('\n') + '\n';
}

function run(args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || '').trim().split('\n').pop()}`);
}

// The films are made once and kept; delete .dev/android-streams to make them again.
function makeFiles() {
  const make = (file, args) => {
    const out = path.join(dir, file);
    if (fs.existsSync(out)) return;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    console.log('making ' + file);
    run([...args, out]);
  };
  const film = ['-t', '30'];
  make('vod/film.mp4', [...picture('mp4'), ...film, ...VIDEO.h264, ...AUDIO.aac, '-movflags', '+faststart']);
  make('vod/film.mkv', [...picture('mkv'), ...film, ...VIDEO.h264, ...AUDIO.ac3]);
  make('hls-ac3/index.m3u8', [...picture('hls ac3'), ...film, ...VIDEO.h264, ...AUDIO.ac3, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod']);
  make('dash/manifest.mpd', [...picture('dash'), ...film, ...VIDEO.h264, ...AUDIO.aac, '-f', 'dash', '-seg_duration', '2']);
}

// One live HLS channel, encoded for as long as this runs (a sliding window of six 2-second pieces).
function startLiveHls() {
  const out = path.join(dir, 'hls-live');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', ...picture('hls live'), ...VIDEO.h264, ...AUDIO.aac,
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6', '-hls_flags', 'delete_segments+omit_endlist', path.join(out, 'index.m3u8')], { stdio: 'ignore' });
  process.on('exit', () => child.kill());
}

const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mpd': 'application/dash+xml', '.m4s': 'video/iso.segment', '.html': 'text/html' };

function sendFile(req, res, file) {
  let stat;
  try { stat = fs.statSync(file); } catch (e) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(file).pipe(res);
}

function serve(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname.startsWith('/cors/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    pathname = pathname.slice(5);
  }
  if (pathname === '/test.m3u') return res.end(playlist());
  if (pathname === '/page.html') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><html><body>Not a stream</body></html>'); }
  if (pathname === '/play/hls-live') { res.statusCode = 302; res.setHeader('Location', '/hls-live/index.m3u8'); return res.end(); }
  if (pathname.startsWith('/gone/')) { res.statusCode = 404; return res.end(); }

  const live = /^\/live\/[^/]+\/[^/]+\/(\d+)\.ts$/.exec(pathname);
  if (live && LIVE[live[1]]) {
    const [name, v, a] = LIVE[live[1]];
    res.setHeader('Content-Type', 'video/mp2t');
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-re', ...picture(name), ...VIDEO[v], ...AUDIO[a], '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.pipe(res);
    const stop = () => child.kill('SIGKILL');
    req.on('close', stop);
    res.on('close', stop);
    return;
  }

  if (pathname.startsWith('/protected/')) {
    if (req.headers.referer !== 'http://ref.example/' || req.headers['user-agent'] !== 'VibeTest/1.0') { res.statusCode = 403; return res.end(); }
    pathname = '/hls-ac3/' + pathname.slice('/protected/'.length);
  }
  const file = path.normalize(path.join(dir, pathname));
  if (!file.startsWith(dir + path.sep)) { res.statusCode = 403; return res.end(); }
  sendFile(req, res, file);
}

module.exports = { CHANNELS, playlist };

if (require.main === module) {
  makeFiles();
  startLiveHls();
  http.createServer(serve).listen(PORT, '127.0.0.1', () => {
    console.log(`Test streams on http://127.0.0.1:${PORT}  (from an emulator: ${BASE}/test.m3u)`);
  });
}
