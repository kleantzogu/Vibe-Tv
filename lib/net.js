'use strict';
/*
 * Thin helpers around a fetch() implementation. In the app this is Electron's net.fetch
 * (system proxy + certificate store); in tests it is Node's built-in fetch.
 */

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('Timed out')), ms);
  return { signal: ctrl.signal, abort: () => ctrl.abort(), done: () => clearTimeout(timer) };
}

function describe(err) {
  if (!err) return 'Unknown error';
  if (err.name === 'AbortError' || /abort|timed out/i.test(err.message || '')) return 'The server took too long to respond';
  const msg = String(err.message || err);
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(msg)) return 'The address could not be found';
  if (/ERR_INTERNET_DISCONNECTED|ENETUNREACH/.test(msg)) return 'No internet connection';
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(msg)) return 'The server refused the connection';
  if (/ERR_CERT|certificate/i.test(msg)) return 'The server has an invalid security certificate';
  return msg.replace(/^net::/, '');
}

async function fetchBuffer(fetchImpl, url, { timeout = 30000, maxBytes = 64 * 1024 * 1024, headers } = {}) {
  const t = withTimeout(timeout);
  try {
    const res = await fetchImpl(url, { signal: t.signal, headers, redirect: 'follow' });
    if (!res.ok) throw new Error(`The server answered with an error (${res.status})`);
    // A fetch that hands over the whole answer at once (a native HTTP bridge) has no stream to read.
    if (!res.body || !res.body.getReader) {
      const whole = Buffer.from(await res.arrayBuffer());
      if (whole.length > maxBytes) throw new Error('The file is too large');
      return whole;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        t.abort();
        throw new Error('The file is too large');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    t.done();
  }
}

async function fetchText(fetchImpl, url, opts) {
  const buf = await fetchBuffer(fetchImpl, url, opts);
  return buf.toString('utf8');
}

async function fetchJson(fetchImpl, url, opts) {
  return JSON.parse(await fetchText(fetchImpl, url, opts));
}

module.exports = { withTimeout, describe, fetchBuffer, fetchText, fetchJson };
