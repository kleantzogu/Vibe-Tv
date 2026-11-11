'use strict';
const { tsStreams, hlsStreams } = require('./codecs');
/*
 * Stream probe: answers "is this channel alive?" and "what kind of stream is it?"
 * by requesting the address and looking at the first bytes that come back.
 */

function requestHeaders(h) {
  const out = {};
  if (h && h.userAgent) out['User-Agent'] = h.userAgent;
  if (h && h.referrer) out['Referer'] = h.referrer;
  return out;
}

function sniff(bytes, contentType) {
  const head = Buffer.from(bytes.slice(0, 1024)).toString('latin1');
  const trimmed = head.replace(/^\uFEFF|^ï»¿/, '').trimStart();
  if (trimmed.startsWith('#EXTM3U') || trimmed.startsWith('#EXT-X-')) return 'hls';
  if (/<MPD[\s>]/.test(head)) return 'dash';
  if (bytes.length > 0 && bytes[0] === 0x47 && (bytes.length <= 188 || bytes[188] === 0x47)) return 'mpegts';
  if (head.startsWith('FLV')) return 'flv';
  if (head.slice(4, 8) === 'ftyp' || head.slice(4, 8) === 'styp' || head.slice(4, 8) === 'moof') return 'native';
  if (bytes.length > 3 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'native';
  if (head.startsWith('ID3') || head.startsWith('OggS') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'native';

  const ct = String(contentType || '').toLowerCase();
  if (/mpegurl/.test(ct)) return 'hls';
  if (/dash\+xml/.test(ct)) return 'dash';
  if (/mp2t/.test(ct)) return 'mpegts';
  if (/x-flv/.test(ct)) return 'flv';
  if (/^(video|audio)\//.test(ct)) return 'native';
  if (/text\/html/.test(ct) || /^\s*<(!doctype|html)/i.test(head)) return 'webpage';
  return '';
}

// For MPEG-TS, keep reading until the program map and the kind of each MPEG audio track are known.
function tsComplete(buf) {
  if (buf.length < 376 || buf[0] !== 0x47) return true; // not TS (or not aligned): nothing to wait for
  const r = tsStreams(buf);
  return r.found && !r.streams.some((s) => s.unsure);
}

async function readSome(res, limit) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
      // Only text playlists need to be read in full; for video a first taste is enough, except that
      // MPEG-TS is read up to its program map (usually the first few KB) so its codecs are known.
      if (size >= 512 && !/^\s*(\uFEFF)?#EXT/.test(chunks[0].toString('utf8', 0, 16))) {
        if (chunks[0][0] !== 0x47 || size >= 256 * 1024 || tsComplete(Buffer.concat(chunks))) break;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

async function get(fetchImpl, url, headers, timeout, limit) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetchImpl(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) {
      ctrl.abort();
      return { ok: false, status: res.status };
    }
    const body = await readSome(res, limit);
    ctrl.abort();
    return { ok: true, status: res.status, body, contentType: res.headers.get('content-type') || '', url: res.url || url };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// First media-playlist address inside an HLS master playlist.
function firstVariant(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (!l || l[0] === '#') continue;
      try { return new URL(l, baseUrl).href; } catch (e) { return ''; }
    }
  }
  return '';
}

/**
 * @returns {Promise<{ok:boolean, kind:string, status:number, reason?:string, streams?:Array}>}
 *   streams: the codecs, when the first bytes tell (MPEG-TS program map, HLS CODECS attribute)
 */
async function probe(fetchImpl, url, streamHeaders, { timeout = 9000 } = {}) {
  if (!/^https?:\/\//i.test(url)) return { ok: false, kind: '', status: 0, reason: 'unsupported' };
  const headers = requestHeaders(streamHeaders);
  const started = Date.now();
  const first = await get(fetchImpl, url, headers, timeout, 256 * 1024);
  if (!first.ok) return { ok: false, kind: '', status: first.status, reason: first.error || 'http' };
  if (!first.body.length) return { ok: false, kind: '', status: first.status, reason: 'empty' };

  const kind = sniff(first.body, first.contentType);
  if (kind === 'webpage') return { ok: false, kind, status: first.status, reason: 'webpage' };

  let streams;
  if (kind === 'mpegts') {
    const ts = tsStreams(first.body);
    if (ts.found) streams = ts.streams;
  }

  if (kind === 'hls') {
    const text = first.body.toString('utf8');
    const announced = hlsStreams(text);
    if (announced.length) streams = announced;
    const variant = firstVariant(text, first.url);
    if (variant) {
      // A master playlist that points at dead media playlists is a very common failure.
      const left = Math.max(2500, timeout - (Date.now() - started));
      const second = await get(fetchImpl, variant, headers, left, 192 * 1024);
      if (!second.ok) return { ok: false, kind, status: second.status, reason: second.error || 'http' };
      if (!/#EXTINF|#EXT-X-PART/.test(second.body.toString('utf8'))) {
        return { ok: false, kind, status: second.status, reason: 'no-segments' };
      }
    } else if (!/#EXTINF|#EXT-X-PART/.test(text)) {
      return { ok: false, kind, status: first.status, reason: 'no-segments' };
    }
  }
  return streams ? { ok: true, kind, status: first.status, streams } : { ok: true, kind, status: first.status };
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch (e) {
    return '';
  }
}

// Failures that say something about the server's mood rather than the channel: busy, rate limited,
// "too many connections" (IPTV servers often answer that with 403), slow to start. Worth a second try.
function isRetryable(r) {
  if (r.reason === 'unsupported' || r.reason === 'webpage') return false;
  if (r.reason === 'http') return [403, 408, 425, 429].includes(r.status) || r.status >= 500;
  return true; // timeouts, dropped connections, empty answers, playlists without segments
}

/**
 * Runs probes for many channels. At most `concurrency` probes run at once, and at most `perHost`
 * against any one server: a whole IPTV playlist usually lives on one server that limits connections
 * per account, answers a flood with errors, and may block accounts that open too many.
 * A channel that fails for a passing reason is tried again once the first round is over, and is
 * only reported offline if it fails again. `onResult` is called once per item, with the final result.
 */
function checkAll(fetchImpl, items, { concurrency = 16, perHost = 6, retries = 1, onResult, timeout } = {}) {
  let cancelled = false;
  let wake = () => {};

  const run = async () => {
    let round = items.map((item) => ({ item, tries: 0 }));
    while (round.length && !cancelled) {
      const retry = [];
      const queues = new Map(); // host -> entries still to probe, in playlist order
      for (const entry of round) {
        const h = hostOf(entry.item.url);
        if (!queues.has(h)) queues.set(h, []);
        queues.get(h).push(entry);
      }
      const busy = new Map(); // host -> probes running
      let running = 0;
      const start = (h, entry) => {
        running++;
        busy.set(h, (busy.get(h) || 0) + 1);
        probe(fetchImpl, entry.item.url, entry.item.headers, { timeout })
          .catch((e) => ({ ok: false, kind: '', status: 0, reason: String((e && e.message) || e) }))
          .then((r) => {
            running--;
            busy.set(h, busy.get(h) - 1);
            if (cancelled) return;
            entry.tries++;
            if (!r.ok && entry.tries <= retries && isRetryable(r)) retry.push(entry);
            else onResult(entry.item, r);
          })
          .finally(() => wake());
      };
      for (;;) {
        if (!cancelled) {
          for (const [h, q] of queues) {
            while (q.length && running < concurrency && (busy.get(h) || 0) < perHost) start(h, q.shift());
            if (!q.length) queues.delete(h);
          }
        }
        if (!running && (cancelled || !queues.size)) break;
        await new Promise((resolve) => { wake = resolve; });
      }
      round = retry;
    }
    return { cancelled };
  };

  const done = run();
  return {
    done,
    cancel: () => {
      cancelled = true;
      wake();
    },
  };
}

module.exports = { probe, checkAll, sniff, requestHeaders, isRetryable };
