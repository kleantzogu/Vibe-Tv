'use strict';
/*
 * Playing what the built-in engine cannot decode (MPEG-2 video, AC-3 / E-AC-3 / MP2 / DTS audio,
 * rtmp:// rtsp:// udp:// addresses, unusual containers): ffmpeg reads the stream and hands the
 * player an MPEG-TS stream it can decode, over a local address only this computer can reach.
 *
 * Only what needs it is converted. Video the player can decode is passed through untouched, so the
 * common case (fine video, AC-3 or MP2 audio) costs almost nothing; video is re-encoded only when it
 * has to be, with the hardware encoder when there is one.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const isMac = process.platform === 'darwin';
const exe = (name) => (process.platform === 'win32' ? name + '.exe' : name);

// Where ffmpeg may be. Apps started from Finder / Explorer do not see the shell's PATH, so the usual
// install folders are tried by name.
function candidates(name, extra = []) {
  const dirs = [
    ...extra,
    process.resourcesPath ? path.join(process.resourcesPath, 'ffmpeg') : '',
    path.join(__dirname, '..', 'vendor-bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    '/usr/bin',
    '/snap/bin',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'ffmpeg', 'bin') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '',
    'C:\\ffmpeg\\bin',
    ...String(process.env.PATH || '').split(path.delimiter),
  ].filter(Boolean);
  return dirs.map((d) => path.join(d, exe(name)));
}

// The ffmpeg that ships with the app (the ffmpeg-static package). In a packaged app it sits outside
// the app archive, because programs can't be started from inside one.
function bundledFfmpeg() {
  try {
    const p = String(require('ffmpeg-static') || '').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    return p && fs.existsSync(p) ? p : '';
  } catch (e) {
    return '';
  }
}

function findTool(name, override) {
  if (override) return fs.existsSync(override) ? override : '';
  for (const p of candidates(name)) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (e) { /* not here */ }
  }
  return '';
}

// Runs a program and hands back what it wrote, whatever its exit code.
const run = (file, args, timeout) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: !!(err && err.killed) });
    });
  });

// Input options: headers, reconnects and low start-up delay, depending on the kind of address.
function inputArgs(url, headers, { probeSize = '1500000', analyze = '1500000', loglevel = 'error' } = {}) {
  const a = ['-hide_banner', '-nostdin', '-loglevel', loglevel];
  const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(url) || [])[1] || '';
  if (/^https?$/i.test(scheme)) {
    if (headers && headers.userAgent) a.push('-user_agent', headers.userAgent);
    if (headers && headers.referrer) a.push('-referer', headers.referrer);
    a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '4');
    a.push('-rw_timeout', '15000000');
  } else if (/^rtsps?$/i.test(scheme)) {
    a.push('-rtsp_transport', 'tcp', '-timeout', '15000000');
  } else if (/^(udp|rtp)$/i.test(scheme)) {
    a.push('-timeout', '15000000', '-fifo_size', '1000000', '-overrun_nonfatal', '1');
  } else if (/^rtmps?$/i.test(scheme)) {
    a.push('-rw_timeout', '15000000');
  }
  a.push('-fflags', '+genpts+discardcorrupt', '-probesize', probeSize, '-analyzeduration', analyze);
  a.push('-i', url);
  return a;
}

class Converter {
  // ffmpeg: an explicit path (or VIBE_TV_FFMPEG), else the bundled one, else one installed on the system.
  constructor({ ffmpeg } = {}) {
    const custom = ffmpeg || process.env.VIBE_TV_FFMPEG || process.env.M3U_PLAYER_FFMPEG;
    const bundled = custom ? '' : bundledFfmpeg();
    this.ffmpeg = custom ? findTool('ffmpeg', custom) : bundled || findTool('ffmpeg');
    this.source = custom ? 'custom' : bundled ? 'bundled' : this.ffmpeg ? 'system' : '';
    this.encoders = null;
    this.server = null;
    this.port = 0;
    this.sessions = new Map(); // id -> { url, headers, plan, child, error, live }
  }

  get available() {
    return !!this.ffmpeg;
  }

  // Video and audio encoders this ffmpeg has, looked up once.
  async loadEncoders() {
    if (this.encoders) return this.encoders;
    const out = (await run(this.ffmpeg, ['-hide_banner', '-encoders'], 8000)).stdout;
    const has = (n) => new RegExp(`^\\s*[VAS][^\\s]*\\s+${n}\\s`, 'm').test(out);
    this.encoders = {
      video: has('h264_videotoolbox') && isMac ? 'h264_videotoolbox' : has('libx264') ? 'libx264' : has('h264_nvenc') ? 'h264_nvenc' : has('h264_qsv') ? 'h264_qsv' : 'mpeg4',
      audio: has('aac') ? 'aac' : has('aac_at') ? 'aac_at' : 'libmp3lame',
    };
    return this.encoders;
  }

  /** The codecs of a stream, from what ffmpeg prints about its input (no output is written). */
  async inspect(url, headers) {
    if (!this.ffmpeg) throw new Error('ffmpeg is not installed');
    const r = await run(this.ffmpeg, inputArgs(url, headers, { probeSize: '2500000', analyze: '2500000', loglevel: 'info' }), 20000);
    const streams = parseStreams(r.stderr);
    if (!streams.length) {
      const why = r.timedOut ? 'the stream did not answer in time' : lastError(r.stderr) || 'no video or audio was found';
      throw new Error(cleanError(why));
    }
    return streams;
  }

  async ensureServer() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.serve(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
  }

  /**
   * Gets a conversion ready. ffmpeg starts when the player requests the returned address, and stops
   * when the player lets go of it, or another conversion starts.
   * @param plan { video: 'copy'|'encode'|'none', audio: 'copy'|'encode'|'none', seek?: number }
   */
  async open(url, headers, plan) {
    if (!this.available) throw new Error('ffmpeg is not installed');
    await this.ensureServer();
    await this.loadEncoders();
    this.closeAll();
    const id = crypto.randomBytes(9).toString('hex');
    this.sessions.set(id, { url, headers, plan, child: null, error: '' });
    return { id, src: `http://127.0.0.1:${this.port}/convert/${id}.ts` };
  }

  status(id) {
    const s = this.sessions.get(id);
    return s ? { error: s.error } : { error: '' };
  }

  close(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.child) s.child.kill('SIGKILL');
    this.sessions.delete(id);
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  outputArgs(plan) {
    const enc = this.encoders;
    const a = ['-map', '0:v:0?', '-map', `0:a:${plan.audioTrack || 0}?`, '-sn', '-dn'];
    if (plan.video === 'none') a.push('-vn');
    else if (plan.video === 'copy') a.push('-c:v', 'copy');
    else {
      // Broadcast MPEG-2 is often interlaced: deinterlace only the frames that are.
      a.push('-vf', 'yadif=mode=0:parity=-1:deint=1,format=yuv420p');
      a.push('-c:v', enc.video);
      if (enc.video === 'h264_videotoolbox') a.push('-realtime', '1', '-b:v', '8M', '-maxrate', '12M', '-bufsize', '16M', '-profile:v', 'high');
      else if (enc.video === 'libx264') a.push('-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '20', '-maxrate', '12M', '-bufsize', '16M', '-profile:v', 'high');
      else a.push('-b:v', '8M');
      a.push('-g', '50', '-bf', '0');
    }
    if (plan.audio === 'none') a.push('-an');
    else if (plan.audio === 'copy') a.push('-c:a', 'copy');
    else a.push('-c:a', enc.audio, '-b:a', '192k', '-ac', '2', '-ar', '48000');
    a.push('-f', 'mpegts', '-mpegts_flags', '+resend_headers', '-flush_packets', '1', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1');
    return a;
  }

  serve(req, res) {
    const m = /^\/convert\/([0-9a-f]+)\.ts$/.exec(req.url.split('?')[0]);
    const s = m && this.sessions.get(m[1]);
    if (!s || req.method !== 'GET') {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }
    if (s.child) s.child.kill('SIGKILL'); // the player reconnected: start over
    const args = [...inputArgs(s.url, s.headers)];
    if (s.plan.seek > 0) args.splice(args.indexOf('-i'), 0, '-ss', String(s.plan.seek));
    args.push(...this.outputArgs(s.plan));
    const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    s.child = child;
    s.error = '';
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => { s.error = e.message; });
    child.on('close', (code) => {
      if (s.child === child) s.child = null;
      if (code && !s.error) s.error = cleanError(stderr.trim().split('\n').pop() || `ffmpeg stopped (${code})`);
      res.end();
    });
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    child.stdout.pipe(res);
    req.on('close', () => { if (s.child === child) child.kill('SIGKILL'); });
  }

  shutdown() {
    this.closeAll();
    if (this.server) this.server.close();
  }
}

// "Stream #0:1[0x101](eng): Audio: ac3 (AC-3 / 0x332D4341), 48000 Hz, stereo" -> { kind, codec, index }.
// Streams listed again under several programs are counted once; cover art in audio files (a
// one-picture "video" stream) is left out.
function parseStreams(text) {
  const seen = new Set();
  const out = [];
  for (const m of String(text).matchAll(/Stream #\d+:(\d+)[^:]*: (Video|Audio): ([A-Za-z0-9_]+)([^\n]*)/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    if (m[2] === 'Video' && /attached pic/.test(m[4])) continue;
    out.push({ kind: m[2].toLowerCase(), codec: m[3].toLowerCase(), index: Number(m[1]) });
  }
  return out;
}

// The line where ffmpeg says what went wrong with the input, skipping its "no output" note.
function lastError(text) {
  const lines = String(text).trim().split('\n').filter((l) => l && !/At least one output file|Use -h to get/.test(l));
  return lines.reverse().find((l) => /error|fail|refused|not found|forbidden|invalid|timed out|could not|unable|no such/i.test(l)) || '';
}

// ffmpeg's last line of complaint, made readable.
function cleanError(line) {
  const l = String(line).replace(/^\[[^\]]+\]\s*/, '').replace(/^.*?:\s(?=Server returned|Connection|Input\/output|Invalid data)/, '');
  if (/Server returned 4\d\d|403 Forbidden|404 Not Found/i.test(l)) return 'The server refused the stream (' + (/(\d{3})/.exec(l) || ['', 'error'])[1] + ')';
  if (/Connection refused/i.test(l)) return 'The server refused the connection';
  if (/timed out|Operation timed out/i.test(l)) return 'The stream did not answer in time';
  if (/Invalid data found/i.test(l)) return 'The address does not point at a stream ffmpeg can read';
  if (/not resolve|Name or service not known|nodename nor servname/i.test(l)) return 'The address could not be found';
  return l.slice(0, 200);
}

module.exports = { Converter, findTool, bundledFfmpeg, inputArgs, cleanError, parseStreams };
