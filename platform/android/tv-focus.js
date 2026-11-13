'use strict';
/*
 * Using the app with a TV remote: four arrows, OK and Back, plus the play / channel keys some
 * remotes have. Active on a TV only; a phone is not affected.
 *
 * The idea, as on any TV app: something always has the focus and shows it clearly, an arrow moves
 * the focus to the nearest thing in that direction, OK presses it.
 *
 *   Channel list   up / down move through the channels (the app does that itself), OK plays.
 *                  OK on the channel that is already playing, or right, goes full screen.
 *                  Holding OK on a channel opens its menu (add to favorites, and so on).
 *   Full screen    up / down change channel, OK or right shows the controls, left goes back to the list.
 *   Controls       left / right move along the buttons (the favorite star is among them, next to
 *                  full screen), OK presses, Back puts them away. Up / down change channel, except
 *                  in a film, where they reach the seek bar.
 *   Everything else (search, filters, menus, dialogs): arrows move between the things on screen.
 *
 * Text: a text field that has the focus hands every key of the remote to Android's keyboard, and the
 * page hears none of them, so the focus could never leave it. On a TV the fields are therefore
 * read-only stops for the focus, and OK on one asks for the text in a dialog of the system's own.
 */

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type="hidden"]), [tabindex="0"]';
const AXIS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * The best thing to move to from `from` in a direction: the nearest one that lies that way, with
 * a strong preference for things straight ahead over things off to the side.
 * @param {{left,top,right,bottom}} from
 * @param {Array<{left,top,right,bottom}>} rects
 * @returns {number} index into rects, or -1
 */
function pickNext(from, rects, key) {
  const [dx, dy] = AXIS[key];
  let best = -1;
  let bestScore = Infinity;
  rects.forEach((r, i) => {
    // How far ahead it starts, and how far off to the side it is (0 when it overlaps our own span).
    const ahead = dx ? (dx > 0 ? r.left - from.right : from.left - r.right) : dy > 0 ? r.top - from.bottom : from.top - r.bottom;
    if (ahead < -1) return;
    const aside = dx
      ? Math.max(0, r.top - from.bottom, from.top - r.bottom)
      : Math.max(0, r.left - from.right, from.left - r.right);
    // Anything in line with where we are beats anything that is not, however near.
    const score = Math.max(0, ahead) + aside * 3 + (aside > 0 ? 10000 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/**
 * @param {object} deps
 * @param {Document} deps.document
 * @param {function} deps.isTv       () => boolean
 * @param {object} deps.player       platform/android/player.js: isFullscreen(), exitFullscreen()
 * @param {object} deps.menu         platform/android/menu.js: isOpen()
 * @param {function} deps.promptText async ({ title, value, password, hint }) => { value } | { cancelled: true }
 */
function installTvFocus({ document, isTv, player, menu, promptText }) {
  const $ = (id) => document.getElementById(id);
  const visible = (el) => !!el && el.getClientRects().length > 0 && document.defaultView.getComputedStyle(el).visibility !== 'hidden';
  const within = (box, el) => !!box && !!el && box.contains(el);
  const focus = (el) => { if (el) el.focus({ preventScroll: false }); };

  // The part of the page the arrows move within: what is on top, or the channel side of the app.
  function scope() {
    if (menu.isOpen()) return document.querySelector('.sheet');
    const dialog = [...document.querySelectorAll('dialog[open]')].pop();
    if (dialog) return dialog;
    if (!$('groupPop').hidden) return $('groupPop');
    if (player.isFullscreen()) return $('controls');
    if (!$('welcome').hidden) return $('welcome');
    return document.querySelector('.sidebar');
  }

  function move(key) {
    const box = scope();
    const all = [...box.querySelectorAll(FOCUSABLE)].filter(visible);
    if (!all.length) return false;
    const from = document.activeElement;
    // Nothing focused yet: start on the channels, or on the first thing there is.
    if (!within(box, from)) { focus(box.contains($('list')) && visible($('list')) ? $('list') : all[0]); return true; }
    const others = all.filter((el) => el !== from);
    const i = pickNext(from.getBoundingClientRect(), others.map((el) => el.getBoundingClientRect()), key);
    if (i < 0) return false;
    focus(others[i]);
    return true;
  }

  const isText = (el) => !!el && el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(el.type);
  // Text fields never take the keyboard on a TV (see the top of this file).
  document.addEventListener('focusin', (e) => {
    if (isTv() && isText(e.target)) e.target.readOnly = true;
  });
  async function edit(input) {
    const label = input.closest('label');
    const named = label && label.querySelector('span');
    const title = (named ? named.textContent : '') || input.getAttribute('aria-label') || input.placeholder || '';
    const r = await promptText({ title: title.trim(), value: input.value, password: input.type === 'password', hint: named ? input.placeholder : '' });
    if (!r || r.cancelled) return;
    input.value = r.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const controlsShown = () => !$('player').classList.contains('controls-hidden') && !$('player').classList.contains('idle');
  function showControls() {
    $('player').dispatchEvent(new Event('mousemove')); // what the app shows its controls on
    focus($('btnPlay'));
  }
  function hideControls() {
    if (document.activeElement && within($('controls'), document.activeElement)) document.activeElement.blur();
    $('player').classList.add('controls-hidden');
  }
  function toList() {
    if (player.isFullscreen()) player.exitFullscreen();
    focus($('list'));
  }
  const fullscreen = () => { if (!$('player').classList.contains('idle')) $('player').requestFullscreen(); };

  let held = null; // OK pressed on the channel list: { handled, goFull }
  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Enter' || !held) return;
    const h = held;
    held = null;
    if (isTv() && h.goFull && !h.handled) fullscreen();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!isTv() || e.ctrlKey || e.metaKey || e.altKey) return;
    const done = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    const key = e.key;

    const arrow = key in AXIS;
    if (!arrow && key !== 'Enter') return;
    if (key === 'Enter' && e.repeat) return done(); // a held OK presses once (see remoteKey 'holdOk')
    const at = document.activeElement;
    const onTop = menu.isOpen() || !!document.querySelector('dialog[open]') || !$('groupPop').hidden;

    // OK on a text field: type into it.
    if (isText(at) && key === 'Enter') { edit(at); return done(); }
    // A slider (the seek bar of a film) takes left and right itself.
    if (at && at.type === 'range' && (key === 'ArrowLeft' || key === 'ArrowRight')) return;

    if (!onTop && player.isFullscreen()) {
      const inControls = within($('controls'), at) && controlsShown();
      if (inControls) {
        if (key === 'Enter') return; // the focused button acts
        if (key === 'ArrowLeft' || key === 'ArrowRight') { move(key); return done(); }
        // Up / down: in a film, to the seek bar and back. Otherwise back to watching, and the app changes channel.
        if (visible($('seek')) && move(key)) return done();
        hideControls();
        return;
      }
      if (key === 'Enter' || key === 'ArrowRight') { showControls(); return done(); }
      if (key === 'ArrowLeft') { toList(); return done(); }
      return; // up / down: the app changes channel
    }

    if (!onTop && at === $('list')) {
      const cursor = document.querySelector('#list .row.cursor');
      if (key === 'ArrowRight') { fullscreen(); return done(); }
      if (key === 'ArrowLeft') return done();
      if (key === 'Enter') {
        // Wait for the key to come up: held, it is a long press (the menu), not "go full screen".
        held = { handled: false, goFull: !!cursor && cursor.classList.contains('playing') };
        if (held.goFull) return done();
      }
      // Up from the first channel leaves the list for what is above it.
      if (key === 'ArrowUp' && (!cursor || cursor.getBoundingClientRect().top <= $('list').getBoundingClientRect().top + 8) && $('list').scrollTop === 0) {
        move(key);
        return done();
      }
      return; // the app moves through the list and plays
    }

    if (key === 'Enter') return; // the focused button, checkbox or link acts
    // Right from the channel side, with nothing further right there, is the picture.
    if (!move(key) && !onTop && key === 'ArrowRight' && scope() === document.querySelector('.sidebar')) fullscreen();
    done();
  }, true);

  function start() {
    if (!isTv()) return;
    // The favorite star joins the row of buttons, where left / right reach it.
    if ($('btnFav').parentNode !== $('btnFull').parentNode) $('btnFull').before($('btnFav'));
    if (menu.isOpen() || document.querySelector('dialog[open]')) return;
    if (!$('welcome').hidden) focus([...$('welcome').querySelectorAll(FOCUSABLE)].filter(visible)[0]);
    else focus($('list'));
  }
  // The first screen gives way to the channels once there is a playlist: the focus goes with it.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => { if (!$('app').hidden && !within($('app'), document.activeElement)) start(); }).observe($('app'), { attributes: true, attributeFilter: ['hidden'] });
  }

  return {
    /** Starts with the focus on the channels (or the first button of the first screen). */
    start,
    /**
     * Keys some remotes have and a page is not told about (they arrive from MainActivity by name):
     * Menu opens the ⋯ menu, channel up / down and the play key do what their buttons do.
     */
    remoteKey(name) {
      // OK held down (MainActivity sees that; a page is not told reliably): the channel's menu.
      if (name === 'holdOk') {
        if (!isTv() || menu.isOpen() || document.querySelector('dialog[open]') || document.activeElement !== $('list')) return;
        const row = document.querySelector('#list .row.cursor');
        if (!row) return;
        if (held) held.handled = true;
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        return;
      }
      if (name === 'playPause') $('btnPlay').click();
      else if (name === 'next') $('btnNext').click();
      else if (name === 'previous') $('btnPrev').click();
      else if (name === 'menu' && !menu.isOpen() && !document.querySelector('dialog[open]')) {
        if (player.isFullscreen()) player.exitFullscreen();
        $('btnMore').click();
      }
    },
    /** Back, before anything else: with the controls up in full screen, it puts them away. */
    handleBack() {
      if (!isTv() || !player.isFullscreen() || !within($('controls'), document.activeElement)) return false;
      hideControls();
      return true;
    },
  };
}

module.exports = { installTvFocus, pickNext };
