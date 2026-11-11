'use strict';
/*
 * TV guide (XMLTV) loader.
 * Guide files can be hundreds of megabytes, so the XML is scanned as a stream and only
 * programmes for channels in the current playlist, inside a ~2 day window, are kept.
 */
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');
const { finished } = require('stream/promises');
const { matchKey } = require('../src/m3u.js');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
  if (!s) return '';
  if (s.includes('<![CDATA[')) s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  if (s.includes('&')) {
    s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(code); } catch (err) { return ''; }
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    });
  }
  return s.replace(/\s+/g, ' ').trim();
}

// "20261111183000 +0100" -> epoch milliseconds
function parseTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-])?(\d{2})?:?(\d{2})?/.exec(String(s || '').trim());
  if (!m) return 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (m[7] && m[8]) {
    const offset = (+m[8] * 60 + +(m[9] || 0)) * 60000;
    t += m[7] === '+' ? -offset : offset;
  }
  return t;
}

const attrRe = (name) => new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')');
const RE_ID = attrRe('id');
const RE_CHANNEL = attrRe('channel');
const RE_START = attrRe('start');
const RE_STOP = attrRe('stop');
const RE_TITLE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/;
const RE_DESC = /<desc(?:\s[^>]*)?>([\s\S]*?)<\/desc>/;
const RE_NAMES = /<display-name(?:\s[^>]*)?>([\s\S]*?)<\/display-name>/g;

const attr = (re, s) => {
  const m = re.exec(s);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
};

class XmltvParser {
  /**
   * @param {object} o
   * @param {Set<string>|null} o.wantedIds   lower-cased tvg-ids from the playlist (null = keep everything)
   * @param {Set<string>|null} o.wantedNames matchKey()'d channel names, used when ids do not line up
   */
  constructor({ wantedIds = null, wantedNames = null, from, to, maxDesc = 320, maxProgrammes = 600000 } = {}) {
    this.wantedIds = wantedIds;
    this.wantedNames = wantedNames;
    this.from = from ?? Date.now() - 6 * 3600 * 1000;
    this.to = to ?? Date.now() + 48 * 3600 * 1000;
    this.maxDesc = maxDesc;
    this.maxProgrammes = maxProgrammes;
    this.buf = '';
    this.keep = new Set(); // lower-cased guide channel ids we collect programmes for
    this.nameIndex = {}; // matchKey(display name) -> guide channel id
    this.programmes = {};
    this.channelCount = 0;
    this.programmeCount = 0;
    this.sawXmltv = false;
  }

  write(str) {
    this.buf = this.buf ? this.buf + str : str;
    const buf = this.buf;
    let pos = 0;
    let nextChannel = -2; // -2 = not searched yet, -1 = none left in this buffer
    let nextProgramme = -2;

    for (;;) {
      if (nextChannel !== -1 && nextChannel < pos) nextChannel = buf.indexOf('<channel', pos);
      if (nextProgramme !== -1 && nextProgramme < pos) nextProgramme = buf.indexOf('<programme', pos);
      let start;
      let isProgramme;
      if (nextChannel === -1 && nextProgramme === -1) {
        pos = Math.max(pos, buf.length - 16); // keep a possible partial "<programme"
        break;
      } else if (nextChannel === -1 || (nextProgramme !== -1 && nextProgramme < nextChannel)) {
        start = nextProgramme;
        isProgramme = true;
      } else {
        start = nextChannel;
        isProgramme = false;
      }

      const openEnd = buf.indexOf('>', start);
      if (openEnd < 0) { pos = start; break; }
      const open = buf.slice(start, openEnd);
      this.sawXmltv = true;

      if (buf[openEnd - 1] === '/') {
        if (!isProgramme) this.onChannel(open, '');
        pos = openEnd + 1;
        continue;
      }
      const closeTag = isProgramme ? '</programme>' : '</channel>';
      const end = buf.indexOf(closeTag, openEnd);
      if (end < 0) { pos = start; break; }
      const inner = buf.slice(openEnd + 1, end);
      if (isProgramme) this.onProgramme(open, inner);
      else this.onChannel(open, inner);
      pos = end + closeTag.length;
    }
    this.buf = pos >= buf.length ? '' : buf.slice(pos);
  }

  onChannel(open, inner) {
    const id = attr(RE_ID, open);
    if (!id) return;
    this.channelCount++;
    const key = decode(id).toLowerCase();
    let wanted = !this.wantedIds || this.wantedIds.has(key);
    if (this.wantedNames && inner) {
      RE_NAMES.lastIndex = 0;
      let m;
      while ((m = RE_NAMES.exec(inner))) {
        const nameKey = matchKey(decode(m[1]));
        if (nameKey && this.wantedNames.has(nameKey)) {
          wanted = true;
          if (!this.nameIndex[nameKey]) this.nameIndex[nameKey] = key;
        }
      }
    }
    if (wanted) this.keep.add(key);
  }

  onProgramme(open, inner) {
    const channel = attr(RE_CHANNEL, open);
    if (!channel) return;
    const key = decode(channel).toLowerCase();
    if (!this.keep.has(key)) {
      if (this.wantedIds && !this.wantedIds.has(key)) return;
      this.keep.add(key);
    }
    const start = parseTime(attr(RE_START, open));
    if (!start || start > this.to) return;
    const stop = parseTime(attr(RE_STOP, open));
    if (stop && stop < this.from) return;
    if (!stop && start < this.from - 6 * 3600 * 1000) return;
    if (this.programmeCount >= this.maxProgrammes) return;

    const t = RE_TITLE.exec(inner);
    const d = RE_DESC.exec(inner);
    let desc = d ? decode(d[1]) : '';
    if (desc.length > this.maxDesc) desc = desc.slice(0, this.maxDesc - 1).trimEnd() + '…';
    (this.programmes[key] || (this.programmes[key] = [])).push([start, stop, t ? decode(t[1]) : '', desc]);
    this.programmeCount++;
  }

  finish() {
    for (const list of Object.values(this.programmes)) {
      list.sort((a, b) => a[0] - b[0]);
      // Fill in missing end times from the next programme.
      for (let i = 0; i < list.length; i++) {
        if (!list[i][1]) list[i][1] = i + 1 < list.length ? list[i + 1][0] : list[i][0] + 3600 * 1000;
      }
    }
    return {
      programmes: this.programmes,
      nameIndex: this.nameIndex,
      channelCount: this.channelCount,
      matchedChannels: Object.keys(this.programmes).length,
      programmeCount: this.programmeCount,
      loadedAt: Date.now(),
    };
  }
}

/** Downloads (and if needed gunzips) an XMLTV file and returns the filtered guide. */
async function loadGuide(fetchImpl, url, { wantedIds, wantedNames, timeout = 180000 } = {}) {
  const parser = new XmltvParser({
    wantedIds: wantedIds ? new Set(wantedIds) : null,
    wantedNames: wantedNames ? new Set(wantedNames) : null,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`The guide server answered with an error (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new StringDecoder('utf8');
    const feed = (chunk) => parser.write(decoder.write(chunk));
    let gunzip = null;
    let gunzipError = null;
    let first = true;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (first) {
        first = false;
        if (chunk.length > 2 && chunk[0] === 0x1f && chunk[1] === 0x8b) {
          gunzip = zlib.createGunzip();
          gunzip.on('data', feed);
          gunzip.on('error', (e) => { gunzipError = e; });
        } else if (chunk.length > 5 && chunk[0] === 0xfd && chunk.slice(1, 5).toString('latin1') === '7zXZ') {
          throw new Error('This guide is .xz compressed, which is not supported. Use the .xml or .xml.gz address instead');
        }
      }
      if (gunzip) {
        if (gunzipError) throw gunzipError;
        if (!gunzip.write(chunk)) await new Promise((r) => gunzip.once('drain', r));
      } else {
        feed(chunk);
      }
    }
    if (gunzip) {
      gunzip.end();
      await finished(gunzip).catch((e) => { gunzipError = gunzipError || e; });
      if (gunzipError) throw new Error('The guide file is damaged (could not decompress it)');
    }
    parser.write(decoder.end());
    if (!parser.sawXmltv) throw new Error('This address does not contain a TV guide in XMLTV format');
    return parser.finish();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { XmltvParser, loadGuide, parseTime, decode };
