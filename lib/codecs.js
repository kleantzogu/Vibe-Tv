'use strict';
/*
 * Which codecs does a stream use, and can the player decode them itself?
 *
 * MPEG-TS streams (most IPTV) announce their codecs in the program map table, which sits in the first
 * few packets, so the bytes the probe already read are enough to decide before playback starts:
 * play directly, or convert with ffmpeg first, and then only the part that needs it.
 */

// MPEG-TS stream_type values (ISO 13818-1 and the common ATSC / DVB / Blu-ray extensions).
const STREAM_TYPES = {
  0x01: ['video', 'mpeg1video'],
  0x02: ['video', 'mpeg2video'],
  0x03: ['audio', 'mpeg-audio'], // layer I, II or III: looked up in the first audio frame
  0x04: ['audio', 'mpeg-audio'],
  0x0f: ['audio', 'aac'],
  0x10: ['video', 'mpeg4'],
  0x11: ['audio', 'aac_latm'],
  0x1b: ['video', 'h264'],
  0x1c: ['audio', 'aac'], // MPEG-4 audio without extra wrapping
  0x20: ['video', 'h264'], // MVC sub-bitstream
  0x24: ['video', 'hevc'],
  0x33: ['video', 'vvc'],
  0x42: ['video', 'cavs'],
  0x80: ['audio', 'pcm_bluray'],
  0x81: ['audio', 'ac3'],
  0x82: ['audio', 'dts'],
  0x83: ['audio', 'truehd'],
  0x84: ['audio', 'eac3'],
  0x85: ['audio', 'dts'],
  0x86: ['audio', 'dts'],
  0x87: ['audio', 'eac3'],
  0xa1: ['audio', 'eac3'],
  0xa2: ['audio', 'dts'],
  0xd1: ['video', 'dirac'],
  0xd2: ['video', 'avs2'],
  0xd4: ['video', 'avs3'],
  0xea: ['video', 'vc1'],
};

// Registration descriptor ids ("format_identifier") seen on private-data streams.
const REGISTRATIONS = {
  'AC-3': ['audio', 'ac3'],
  'EAC3': ['audio', 'eac3'],
  'AC-4': ['audio', 'ac4'],
  'DTS1': ['audio', 'dts'],
  'DTS2': ['audio', 'dts'],
  'DTS3': ['audio', 'dts'],
  'Opus': ['audio', 'opus'],
  'BSSD': ['audio', 'pcm_s302m'],
  'HEVC': ['video', 'hevc'],
  'VC-1': ['video', 'vc1'],
  'drac': ['video', 'dirac'],
  'AV01': ['video', 'av1'],
  'KLVA': ['data', 'klv'],
  'ID3 ': ['data', 'id3'],
};

// DVB descriptor tags on private-data streams.
const DESCRIPTORS = {
  0x6a: ['audio', 'ac3'],
  0x7a: ['audio', 'eac3'],
  0x7b: ['audio', 'dts'],
  0x7c: ['audio', 'aac'],
  0x56: ['data', 'teletext'],
  0x45: ['data', 'vbi'],
  0x59: ['data', 'dvb_subtitle'],
};

function syncOffset(b) {
  for (let i = 0; i < Math.min(b.length - 188, 188 * 2); i++) {
    if (b[i] === 0x47 && b[i + 188] === 0x47 && (i + 376 >= b.length || b[i + 376] === 0x47)) return i;
  }
  return b[0] === 0x47 ? 0 : -1;
}

// Payload of one 188-byte packet, or null when it carries none.
function payloadOf(b, at) {
  const afc = (b[at + 3] >> 4) & 3;
  if (afc === 0 || afc === 2) return null;
  const start = at + 4 + (afc === 3 ? 1 + b[at + 4] : 0);
  return start < at + 188 ? b.subarray(start, at + 188) : null;
}

// Body of a PSI section (PAT / PMT) that starts in this packet.
function sectionOf(payload) {
  const pointer = payload[0];
  const s = payload.subarray(1 + pointer);
  if (s.length < 8) return null;
  const length = ((s[1] & 0x0f) << 8) | s[2];
  return { tableId: s[0], body: s.subarray(0, Math.min(s.length, 3 + length)) };
}

function streamFromPmtEntry(type, descriptors) {
  if (STREAM_TYPES[type]) return STREAM_TYPES[type];
  // Private data (0x06) and user-private types: the descriptors say what it is.
  let found = null;
  for (let i = 0; i + 2 <= descriptors.length; i += 2 + descriptors[i + 1]) {
    const tag = descriptors[i];
    const len = descriptors[i + 1];
    if (tag === 0x05 && len >= 4) {
      const id = String.fromCharCode(...descriptors.subarray(i + 2, i + 6));
      if (REGISTRATIONS[id]) return REGISTRATIONS[id];
    } else if (DESCRIPTORS[tag] && (!found || found[0] === 'data')) {
      found = DESCRIPTORS[tag];
    } else if (tag === 0x7f && len >= 1) {
      // DVB extension descriptor: 0x15 AC-4, 0x0e DTS-HD, 0x0f DTS Neural
      const ext = descriptors[i + 2];
      if (ext === 0x15) return ['audio', 'ac4'];
      if (ext === 0x0e || ext === 0x0f) return ['audio', 'dts'];
    }
  }
  return found || ['data', type === 0x06 ? 'private' : `0x${type.toString(16)}`];
}

// Layer of the first MPEG audio frame on a PID: 'mp3', 'mp2' or 'mp1'.
function mpegAudioLayer(b, start, pid) {
  for (let at = start; at + 188 <= b.length; at += 188) {
    if (b[at] !== 0x47) break;
    if ((((b[at + 1] & 0x1f) << 8) | b[at + 2]) !== pid || !(b[at + 1] & 0x40)) continue;
    const p = payloadOf(b, at);
    if (!p || p.length < 9 || p[0] !== 0 || p[1] !== 0 || p[2] !== 1) continue;
    const data = p.subarray(9 + p[8]);
    for (let i = 0; i + 1 < data.length; i++) {
      if (data[i] === 0xff && (data[i + 1] & 0xe0) === 0xe0) {
        const layer = (data[i + 1] >> 1) & 3;
        if (layer === 1) return 'mp3';
        if (layer === 2) return 'mp2';
        if (layer === 3) return 'mp1';
      }
    }
  }
  return '';
}

/**
 * Reads the program map of an MPEG-TS stream.
 * @returns {{ found: boolean, streams: Array<{ pid:number, kind:'video'|'audio'|'data', codec:string }> }}
 */
function tsStreams(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const start = syncOffset(b);
  if (start < 0) return { found: false, streams: [] };
  let pmtPid = -1;
  for (let at = start; at + 188 <= b.length; at += 188) {
    if (b[at] !== 0x47) break;
    const pid = ((b[at + 1] & 0x1f) << 8) | b[at + 2];
    const unitStart = b[at + 1] & 0x40;
    if (!unitStart) continue;
    const p = payloadOf(b, at);
    if (!p) continue;
    const sec = sectionOf(p);
    if (!sec) continue;

    if (pid === 0 && sec.tableId === 0x00 && pmtPid < 0) {
      // PAT: first program with a number other than 0 (0 points at the network table).
      for (let i = 8; i + 4 <= sec.body.length - 4; i += 4) {
        const program = (sec.body[i] << 8) | sec.body[i + 1];
        if (program !== 0) { pmtPid = ((sec.body[i + 2] & 0x1f) << 8) | sec.body[i + 3]; break; }
      }
    } else if (pid === pmtPid && sec.tableId === 0x02) {
      const body = sec.body;
      const infoLen = ((body[10] & 0x0f) << 8) | body[11];
      const streams = [];
      for (let i = 12 + infoLen; i + 5 <= body.length - 4; ) {
        const type = body[i];
        const esPid = ((body[i + 1] & 0x1f) << 8) | body[i + 2];
        const esLen = ((body[i + 3] & 0x0f) << 8) | body[i + 4];
        const [kind, codec0] = streamFromPmtEntry(type, body.subarray(i + 5, i + 5 + esLen));
        let codec = codec0;
        let unsure = false;
        if (codec === 'mpeg-audio') {
          codec = mpegAudioLayer(b, start, esPid);
          if (!codec) { codec = 'mp2'; unsure = true; } // no audio frame seen yet: converting is the safe guess
        }
        streams.push(unsure ? { pid: esPid, kind, codec, unsure } : { pid: esPid, kind, codec });
        i += 5 + esLen;
      }
      return { found: true, streams };
    }
  }
  return { found: false, streams: [] };
}

// Codec names from an HLS / DASH "CODECS" value: avc1.640028, hvc1..., mp4a.40.2, ec-3...
function fromCodecString(s) {
  const c = String(s || '').trim().toLowerCase();
  if (/^(avc1|avc3)/.test(c)) return ['video', 'h264'];
  if (/^(hvc1|hev1)/.test(c)) return ['video', 'hevc'];
  if (/^(dvh1|dvhe)/.test(c)) return ['video', 'hevc']; // Dolby Vision on HEVC
  if (/^av01/.test(c)) return ['video', 'av1'];
  if (/^(vp09|vp9)/.test(c)) return ['video', 'vp9'];
  if (/^vp8/.test(c)) return ['video', 'vp8'];
  if (/^mp4v\.(60|61|62|63|64|65)/.test(c)) return ['video', 'mpeg2video'];
  if (/^mp4v/.test(c)) return ['video', 'mpeg4'];
  if (/^mp4a\.40/.test(c)) return ['audio', 'aac'];
  if (/^mp4a\.(69|6b)/.test(c)) return ['audio', 'mp3'];
  if (/^mp4a\.a5|^ac-3/.test(c)) return ['audio', 'ac3'];
  if (/^mp4a\.a6|^ec-3/.test(c)) return ['audio', 'eac3'];
  if (/^ac-4/.test(c)) return ['audio', 'ac4'];
  if (/^(dts|dtsc|dtsh|dtsl|dtse)/.test(c)) return ['audio', 'dts'];
  if (/^opus/.test(c)) return ['audio', 'opus'];
  if (/^flac|^fLaC/i.test(c)) return ['audio', 'flac'];
  if (/^(stpp|wvtt)/.test(c)) return ['data', c];
  return ['', c];
}

function hlsStreams(text) {
  const streams = [];
  const seen = new Set();
  for (const m of String(text).matchAll(/CODECS="([^"]+)"/g)) {
    for (const part of m[1].split(',')) {
      const [kind, codec] = fromCodecString(part);
      if (kind && !seen.has(kind + codec)) {
        seen.add(kind + codec);
        streams.push({ kind, codec });
      }
    }
  }
  return streams;
}

/**
 * What to do with a stream, given its codecs and what the player can decode.
 * `canPlay` is { video: [...], audio: [...] } of codec names the player decodes for this kind of stream.
 * @returns {{ convert: boolean, video: 'copy'|'encode'|'none', audio: 'copy'|'encode'|'none', why: string }}
 */
function plan(streams, canPlay) {
  const video = streams.filter((s) => s.kind === 'video');
  const audio = streams.filter((s) => s.kind === 'audio');
  const okVideo = new Set(canPlay.video || []);
  const okAudio = new Set(canPlay.audio || []);
  // Several audio tracks: the first one the player decodes is used, otherwise the first one.
  // The built-in player always takes the first track, so picking another one also means converting
  // (cheaply: the chosen track is passed through as it is).
  let track = audio.findIndex((s) => okAudio.has(s.codec));
  if (track < 0) track = 0;
  const a = audio[track];
  const v = video[0];
  const out = {
    video: !v ? 'none' : okVideo.has(v.codec) ? 'copy' : 'encode',
    audio: !a ? 'none' : okAudio.has(a.codec) ? 'copy' : 'encode',
    audioTrack: track,
    videoCodec: v ? v.codec : '',
    audioCodec: a ? a.codec : '',
  };
  out.convert = out.video === 'encode' || out.audio === 'encode' || track > 0;
  const why = [];
  if (out.video === 'encode') why.push(`${v.codec} video`);
  if (out.audio === 'encode') why.push(`${a.codec} audio`);
  else if (track > 0) why.push(`audio track ${track + 1} (${a.codec}) chosen`);
  out.why = why.join(' and ');
  return out;
}

module.exports = { tsStreams, hlsStreams, fromCodecString, plan, STREAM_TYPES };
