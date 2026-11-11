'use strict';
/*
 * A fetch() that goes through the VibeHttp plugin instead of the page, for the servers the page may
 * not talk to: playlists, Xtream Codes servers and the streams a channel check looks at. It offers
 * the parts of fetch that lib/net.js and lib/probe.js use. The whole answer arrives at once, so there
 * is no `body` stream; both of them read `arrayBuffer()` instead when it is missing.
 */

function abortError() {
  const e = new Error('Timed out');
  e.name = 'AbortError';
  return e;
}

function fromBase64(text) {
  const bin = atob(text || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * @param {object} http       the VibeHttp plugin: request({ url, headers, timeout, maxBytes, sniff })
 * @param {object} [options]  sent with every request, e.g. { sniff: true, maxBytes, timeout } for channel checks
 */
function createNativeFetch(http, options = {}) {
  return async function nativeFetch(url, opts = {}) {
    const signal = opts.signal;
    if (signal && signal.aborted) throw abortError();
    const request = http.request({ url: String(url), headers: opts.headers || {}, ...options });
    // The caller's timeout ends the wait; the plugin's own timeout ends the request itself.
    const r = await (signal
      ? Promise.race([request, new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }))])
      : request);
    if (r.truncated && !options.sniff) throw new Error('The file is too large');
    const bytes = fromBase64(r.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      url: r.url || String(url),
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? r.contentType || null : null) },
      arrayBuffer: async () => bytes.buffer,
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    };
  };
}

module.exports = { createNativeFetch };
