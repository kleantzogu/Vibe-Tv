'use strict';
/*
 * The page's side of the Android player (android/.../VibePlayerPlugin.kt).
 *
 * The app drives playback through its <video> element: it sets a source, calls play() and pause(),
 * reads currentTime / duration / paused / videoHeight, and listens for "playing", "waiting",
 * "pause", "error" and friends. On Android the picture is drawn by the native player behind the page,
 * so the <video> is swapped for a stand-in: an empty, see-through element with the same properties,
 * methods and events, which passes everything on to the plugin and tells it where on the screen it is.
 * The app then needs one small hook (window.vibeNativePlayer, used in app.js play()).
 */

/**
 * @param {object} deps
 * @param {object} deps.plugin    the VibePlayer plugin
 * @param {Document} deps.document
 * @param {function} [deps.isTv]  () => boolean, known once the app has started
 * @param {function} [deps.probe] async (url, headers) => lib/probe.js result, to say why a stream could not be read
 */
function installNativePlayer({ plugin, document, isTv = () => false, probe = null }) {
  const real = document.getElementById('video');
  const el = document.createElement('div');
  el.id = 'video';
  el.className = 'native-video';
  real.replaceWith(el);
  document.documentElement.classList.add('native-player');

  const s = { paused: true, time: 0, duration: NaN, live: true, width: 0, height: 0, volume: 1, muted: false, error: null, ended: false, sound: null };
  let playing = null; // the channel that is open
  let session = 0;
  let onError = null;
  let loaded = false; // the plugin has been given the current source
  let phase = ''; // the last state the plugin reported: buffering | playing | paused | ended
  const fire = (name) => el.dispatchEvent(new Event(name));
  const call = (method, args) => Promise.resolve(plugin[method](args || {})).catch(() => {});
  const sendVolume = () => call('setVolume', { volume: s.volume, muted: s.muted });

  Object.defineProperties(el, {
    paused: { get: () => s.paused },
    ended: { get: () => s.ended },
    error: { get: () => s.error },
    duration: { get: () => s.duration },
    videoWidth: { get: () => s.width },
    videoHeight: { get: () => s.height },
    currentTime: {
      get: () => s.time,
      set: (v) => { s.time = Number(v) || 0; call('seek', { position: s.time }); fire('timeupdate'); },
    },
    volume: {
      get: () => s.volume,
      set: (v) => { s.volume = Math.min(1, Math.max(0, Number(v) || 0)); sendVolume(); fire('volumechange'); },
    },
    muted: {
      get: () => s.muted,
      set: (v) => { s.muted = !!v; sendVolume(); fire('volumechange'); },
    },
    hasSound: { get: () => s.sound }, // true / false once the stream's tracks are known
    src: {
      get: () => el.getAttribute('src') || '',
      set: (v) => el.setAttribute('src', String(v)),
    },
  });

  function reset() {
    Object.assign(s, { paused: true, time: 0, duration: NaN, live: true, width: 0, height: 0, error: null, ended: false, sound: null });
    phase = '';
    note('');
  }

  // Starts the stream. `channel` carries the address and, when the playlist gave them, its headers.
  function open(channel) {
    session++;
    loaded = true;
    playing = channel;
    reset();
    s.paused = false;
    el.setAttribute('src', channel.url);
    const h = channel.headers || {};
    fire('play');
    fire('waiting');
    place();
    Promise.resolve(plugin.play({ url: channel.url, userAgent: h.userAgent || '', referrer: h.referrer || '', kind: kindOf(channel.url), session }))
      .catch((e) => fail('offline', e && e.message));
    sendVolume();
  }

  el.play = () => {
    if (!loaded) return Promise.reject(new Error('Nothing to play'));
    s.paused = false;
    fire('play');
    return call('resume');
  };
  el.pause = () => {
    if (s.paused) return;
    s.paused = true;
    fire('pause');
    call('pause');
  };
  // The app calls load() after taking the source away, to let go of the stream.
  el.load = () => {
    if (el.getAttribute('src')) return;
    stop();
  };
  function stop() {
    if (!loaded) return;
    session++;
    loaded = false;
    onError = null;
    reset();
    call('stop');
  }

  function fail(reason, detail) {
    const report = onError;
    onError = null;
    if (report) report(reason, detail);
  }

  /* ── what the plugin reports ── */

  plugin.addListener('state', (e) => {
    if (e.session !== session || !loaded) return;
    const duration = e.duration > 0 && !e.live ? e.duration : Infinity;
    const sized = e.width !== s.width || e.height !== s.height;
    const timed = duration !== s.duration;
    s.time = e.position;
    s.live = !!e.live;
    s.width = e.width;
    s.height = e.height;
    s.duration = duration;
    if (timed) fire('durationchange');
    if (sized) fire('resize');
    // While a channel plays the plugin reports twice a second; only a change is an event for the app.
    const changed = e.state && e.state !== phase;
    if (e.state) phase = e.state;
    if (!changed) return fire('timeupdate');
    if (e.state === 'buffering') fire('waiting');
    else if (e.state === 'playing') {
      s.ended = false;
      if (s.paused) { s.paused = false; fire('play'); }
      fire('canplay');
      fire('playing');
    } else if (e.state === 'paused') {
      // Paused from outside the page too: a phone call, headphones pulled out, the app left.
      if (!s.paused) { s.paused = true; fire('pause'); }
    } else if (e.state === 'ended') {
      s.ended = true;
      s.paused = true;
      fire('pause');
      fire('ended');
    }
    fire('timeupdate');
  });

  plugin.addListener('error', async (e) => {
    if (e.session !== session) return;
    // "Not a stream this player reads" is often something simpler: a web page, or a server that
    // answers with an error page. A look at the address tells which.
    if (e.reason === 'unsupported' && /PARSING/.test(e.detail || '') && probe && playing) {
      const mine = session;
      const p = await probe(playing.url, playing.headers || null).catch(() => null);
      if (mine !== session) return;
      if (p && p.reason === 'webpage') return fail('webpage', e.detail);
      if (p && !p.ok) return fail('offline', p.reason);
    }
    fail(e.reason, e.detail);
  });

  // Part of the stream has no decoder on this device: say so, rather than play silently or black.
  plugin.addListener('tracks', (e) => {
    if (e.session !== session) return;
    s.sound = !!e.audio && !e.noSound;
    if (e.noPicture && e.noSound) return fail('unsupported', `${nice(e.video)} video and ${nice(e.audio)} sound`);
    note(e.noSound ? `No sound: this device can’t play ${nice(e.audio)} audio` : e.noPicture ? `No picture: this device can’t play ${nice(e.video)} video` : '');
  });

  const NAMES = { 'audio/ac3': 'AC-3', 'audio/eac3': 'E-AC-3', 'audio/mpeg-L2': 'MP2', 'audio/vnd.dts': 'DTS', 'audio/vnd.dts.hd': 'DTS-HD', 'video/mpeg2': 'MPEG-2', 'video/hevc': 'HEVC', 'video/avc': 'H.264' };
  const nice = (codec) => NAMES[codec] || String(codec || 'this').replace(/^(audio|video)\//, '').toUpperCase();

  // A line over the picture, for what the person should know while the channel plays.
  let noteEl = null;
  function note(text) {
    if (!noteEl) {
      noteEl = document.createElement('div');
      noteEl.className = 'native-note';
      noteEl.setAttribute('role', 'status');
      el.after(noteEl);
    }
    noteEl.textContent = text;
    noteEl.hidden = !text;
  }

  /* ── where the picture goes ── */

  let last = '';
  function place() {
    const r = el.getBoundingClientRect();
    const rect = { x: r.left, y: r.top, width: r.width, height: r.height };
    const key = JSON.stringify(rect);
    if (key === last || !r.width || !r.height) return;
    last = key;
    call('setRect', rect);
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(place).observe(el);
  const view = document.defaultView;
  view.addEventListener('resize', place);
  document.addEventListener('transitionend', place, true);
  view.setInterval(place, 400); // the sidebar sliding in or out moves the player without resizing the window

  /* ── full screen ── */

  // A page can't go full screen over a native view, so "full screen" is done here: the player
  // covers the page, the system bars hide, and a phone turns sideways.
  const playerEl = document.getElementById('player');
  let full = false;
  function setFull(on) {
    if (full === on) return;
    full = on;
    document.documentElement.classList.toggle('native-full', on);
    call('setImmersive', { on, landscape: !isTv() });
    document.dispatchEvent(new Event('fullscreenchange'));
    place();
  }
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => (full ? playerEl : null) });
  document.exitFullscreen = async () => setFull(false);
  playerEl.requestFullscreen = async () => setFull(true);

  return {
    element: el,
    /** Used by app.js: plays a channel, and reports a failure once through `report(reason, detail)`. */
    start(channel, report) {
      onError = report;
      open(channel);
      return { destroy: stop, isLive: () => s.live };
    },
    isFullscreen: () => full,
    exitFullscreen: () => setFull(false),
  };
}

// What the address says the stream is; anything else the player works out from the first bytes.
function kindOf(url) {
  let pathname = '';
  try { pathname = new URL(url).pathname.toLowerCase(); } catch (e) { return ''; }
  if (/\.m3u8?$/.test(pathname)) return 'hls';
  if (/\.mpd$/.test(pathname)) return 'dash';
  return '';
}

module.exports = { installNativePlayer, kindOf };
