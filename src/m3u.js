/*
 * M3U / M3U8 playlist parser.
 * Works both in the app window (window.M3U) and in Node (require) so it can be unit-tested.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.M3U = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ATTR_RE = /([A-Za-z0-9_-]+)="([^"]*)"/g;

  function parseAttrs(str) {
    const attrs = {};
    let m;
    let end = 0;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(str))) {
      attrs[m[1].toLowerCase()] = m[2].trim();
      end = ATTR_RE.lastIndex;
    }
    return { attrs, end };
  }

  // "#EXTINF:-1 tvg-id="x" group-title="News",Channel, with comma (720p) [Geo-blocked]"
  function parseExtinf(line) {
    const body = line.slice(line.indexOf(':') + 1);
    const { attrs, end } = parseAttrs(body);
    const comma = body.indexOf(',', end);
    const rawName = comma >= 0 ? body.slice(comma + 1).trim() : '';
    return { attrs, rawName };
  }

  // Pulls "(1080p)" and "[Geo-blocked]" style markers out of a channel name. The patterns don't start
  // with \s*: on a name with a long run of spaces that makes every replace take quadratic time (the
  // parser runs in the desktop app's main process). The spaces left behind are collapsed below.
  function splitName(rawName) {
    let quality = '';
    const tags = [];
    let name = rawName
      .replace(/\((\d{3,4})p\)/gi, (_, q) => {
        if (!quality) quality = q + 'p';
        return '';
      })
      .replace(/\[([^\]]{1,40})\]/g, (_, t) => {
        tags.push(t.trim());
        return '';
      })
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!name) name = rawName.trim();
    return { name, quality, tags };
  }

  function nameFromUrl(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      const last = (parts.pop() || u.hostname).replace(/\.[a-z0-9]{2,5}$/i, '');
      const generic = /^(index|playlist|master|live|stream|chunklist|mono|video)$/i.test(last);
      return decodeURIComponent(generic ? parts.pop() || u.hostname : last);
    } catch (e) {
      return url;
    }
  }

  // A line break (or another control character) in a header value would let a playlist add request
  // headers of its own: ffmpeg writes the value into its request as it is.
  const isHeaderValue = (v) => !/[\0-\x08\n-\x1f\x7f]/.test(v);

  // Kodi style: http://host/stream.m3u8|User-Agent=Foo&Referer=http://bar
  function splitKodiHeaders(url, headers) {
    const bar = url.indexOf('|');
    if (bar < 0) return url;
    const tail = url.slice(bar + 1);
    for (const pair of tail.split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const key = pair.slice(0, eq).trim().toLowerCase();
      let value = pair.slice(eq + 1).trim();
      try { value = decodeURIComponent(value); } catch (e) { /* keep raw */ }
      if (key === 'user-agent') headers.userAgent = headers.userAgent || value;
      else if (key === 'referer' || key === 'referrer') headers.referrer = headers.referrer || value;
    }
    return url.slice(0, bar);
  }

  function parse(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const lines = text.split(/\r\n|\n|\r/);
    const channels = [];
    let epgUrl = '';
    let pending = null;
    let opts = {};
    let sawHeader = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line[0] === '#') {
        const upper = line.slice(0, 12).toUpperCase();
        if (upper.startsWith('#EXTM3U')) {
          sawHeader = true;
          const { attrs } = parseAttrs(line);
          const guide = attrs['url-tvg'] || attrs['x-tvg-url'] || attrs['tvg-url'] || '';
          if (guide && !epgUrl) epgUrl = guide.split(',')[0].trim();
        } else if (upper.startsWith('#EXTINF:')) {
          pending = parseExtinf(line);
          opts = {};
        } else if (upper.startsWith('#EXTGRP:')) {
          opts.group = line.slice(8).trim();
        } else if (upper.startsWith('#EXTVLCOPT:')) {
          const kv = line.slice(11);
          const eq = kv.indexOf('=');
          if (eq > 0) {
            const key = kv.slice(0, eq).trim().toLowerCase();
            const value = kv.slice(eq + 1).trim();
            if (key === 'http-referrer' || key === 'http-referer') opts.referrer = value;
            else if (key === 'http-user-agent') opts.userAgent = value;
          }
        }
        continue;
      }

      // Anything else is a stream address.
      const headers = {};
      if (opts.referrer) headers.referrer = opts.referrer;
      if (opts.userAgent) headers.userAgent = opts.userAgent;
      const url = splitKodiHeaders(line, headers);

      const attrs = pending ? pending.attrs : {};
      if (attrs['http-referrer']) headers.referrer = headers.referrer || attrs['http-referrer'];
      if (attrs['http-user-agent'] || attrs['user-agent']) {
        headers.userAgent = headers.userAgent || attrs['http-user-agent'] || attrs['user-agent'];
      }
      for (const k of ['referrer', 'userAgent']) if (headers[k] && !isHeaderValue(headers[k])) delete headers[k];

      const rawName = (pending && pending.rawName) || attrs['tvg-name'] || nameFromUrl(url);
      const { name, quality, tags } = splitName(rawName);

      const groupText = attrs['group-title'] || opts.group || '';
      const groups = groupText
        .split(';')
        .map((g) => g.trim())
        .filter((g) => g && !/^undefined$/i.test(g));

      const logo = attrs['tvg-logo'] || attrs['logo'] || '';

      channels.push({
        index: channels.length,
        name,
        rawName,
        url,
        tvgId: attrs['tvg-id'] || '',
        tvgName: attrs['tvg-name'] || '',
        number: attrs['tvg-chno'] || attrs['channel-number'] || '',
        logo: /^(https?:|data:image\/)/i.test(logo) ? logo : '',
        groups,
        quality,
        tags,
        headers: headers.referrer || headers.userAgent ? headers : null,
      });

      pending = null;
      opts = {};
    }

    return { channels, epgUrl, valid: sawHeader || channels.length > 0 };
  }

  // Lower-cased, accent-free text for search and loose name matching.
  function fold(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  // Aggressive normalisation used to match playlist names against guide names.
  function matchKey(s) {
    return fold(s)
      .replace(/\b(hd|fhd|uhd|sd|4k|tv)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, '');
  }

  return { parse, splitName, fold, matchKey };
});
