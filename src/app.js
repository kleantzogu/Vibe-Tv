/* Vibe TV — window logic. Talks to the main process only through window.api (see preload.js). */
(() => {
  'use strict';

  const api = window.api;
  const { fold } = window.M3U;
  const $ = (id) => document.getElementById(id);

  const ROW_H = 60;
  const UNGROUPED = '\u0000ungrouped';
  const MAX_RECENTS = 40;
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const MOD = isMac ? '⌘' : 'Ctrl+';

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function svg(paths, size = 16) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', `0 0 ${size} ${size}`);
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = paths; // static icon markup defined below, never user data
    return s;
  }
  const ICON = {
    file: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
    web: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/>',
    all: '<rect x="2.5" y="3" width="11" height="8" rx="1.5"/><path d="M5.5 13.5h5"/>',
    star: '<path d="M8 2.3l1.75 3.6 3.95.55-2.85 2.8.7 3.95L8 11.3l-3.55 1.9.7-3.95-2.85-2.8 3.95-.55z"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
    more: '<circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none"/>',
    star20: '<path d="M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z"/>',
  };

  /* ───────────────────────────── state ───────────────────────────── */

  const state = {
    playlists: [],
    activeId: '',
    channels: [],
    loading: false,
    loadingNote: '',
    loadError: '',
    favorites: [],
    recents: [],
    status: {},
    settings: { hideOffline: false, volume: 1, muted: false, sidebar: 'show', sidebarLast: 'hide' },
    view: { type: 'all', group: '' },
    query: '',
    filtered: [],
    hiddenOffline: 0,
    cursor: -1,
    current: null,
    db: {}, // tvg-id -> { logo, groups } from the channel database
    importing: false,
    hidden: new Set(), // groups of the open playlist the person chose not to see
    checking: null, // { total, done, dead }
  };
  const favUrls = new Set();
  const badLogos = new Set();

  const activePlaylist = () => state.playlists.find((p) => p.id === state.activeId) || null;
  const logoOf = (c) => c.logo || (state.db[c.tvgId] && state.db[c.tvgId].logo) || '';
  const groupsOf = (c) => (c.groups && c.groups.length ? c.groups : (state.db[c.tvgId] && state.db[c.tvgId].groups) || []);
  const isDead = (c) => !!state.status[c.url] && state.status[c.url].s === 'dead';
  // A channel is out of sight when every group it is in is hidden.
  function isShown(c) {
    if (!state.hidden.size) return true;
    const gs = groupsOf(c);
    return gs.length ? gs.some((g) => !state.hidden.has(g)) : !state.hidden.has(UNGROUPED);
  }
  const shownChannels = () => (state.hidden.size ? state.channels.filter(isShown) : state.channels);
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

  function indexChannel(c) {
    c._s = fold(`${c.name} ${c.tvgId || ''} ${groupsOf(c).join(' ')}`);
  }

  const snapshot = (c) => ({
    name: c.name,
    rawName: c.rawName || c.name,
    url: c.url,
    tvgId: c.tvgId || '',
    tvgName: c.tvgName || '',
    logo: logoOf(c),
    groups: groupsOf(c),
    quality: c.quality || '',
    tags: c.tags || [],
    headers: c.headers || null,
  });

  let saveTimer = 0;
  const pendingPatch = {};
  function persist(patch) {
    // Settings saved in quick succession are merged, not replaced (sidebar mode, then its width).
    if (patch.settings && pendingPatch.settings) patch = { ...patch, settings: { ...pendingPatch.settings, ...patch.settings } };
    Object.assign(pendingPatch, patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.patchState({ ...pendingPatch });
      for (const k of Object.keys(pendingPatch)) delete pendingPatch[k];
    }, 300);
  }

  /* ───────────────────────────── small UI helpers ───────────────────────────── */

  let toastTimer = 0;
  // A short note at the bottom of the window, optionally with one button (Undo).
  function toast(message, ms = 4500, action) {
    const t = $('toast');
    t.textContent = message;
    if (action) {
      const b = h('button', 'toast-btn', action.label);
      b.addEventListener('click', () => { t.hidden = true; action.run(); });
      t.append(' ', b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? Math.max(ms, 7000) : ms);
  }

  function applyAccent(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const root = document.documentElement.style;
    root.setProperty('--accent', hex);
    root.setProperty('--on-accent', lum > 0.45 ? '#141416' : '#ffffff');
    // Accent used as text has to stay readable on the window background in both themes.
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    let text = hex;
    if (!dark && lum > 0.32) text = `color-mix(in srgb, ${hex} 58%, black)`;
    if (dark && lum < 0.3) text = `color-mix(in srgb, ${hex} 55%, white)`;
    root.setProperty('--accent-text', text);
  }

  function initials(name) {
    const words = String(name).replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    const first = [...words[0]][0];
    const second = words.length > 1 ? [...words[1]][0] : [...words[0]][1] || '';
    return (first + second).toUpperCase();
  }
  function hue(name) {
    let x = 0;
    for (let i = 0; i < name.length; i++) x = (x * 31 + name.charCodeAt(i)) >>> 0;
    return x % 360;
  }

  // Shows the channel logo, or a coloured tile with initials when there is none (or it fails to load).
  function setLogo(box, c) {
    const url = logoOf(c);
    const usable = url && !badLogos.has(url);
    let img = box.firstElementChild;
    if (usable) {
      if (!img) {
        img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.draggable = false;
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => {
          badLogos.add(img.dataset.src);
          if (box._c) setLogo(box, box._c);
        });
        box.textContent = '';
        box.appendChild(img);
      }
      if (img.dataset.src !== url) {
        img.dataset.src = url;
        img.src = url;
      }
      box.classList.add('has-img');
      box.classList.remove('initials');
    } else {
      if (img) img.remove();
      box.classList.remove('has-img');
      box.classList.add('initials');
      box.textContent = initials(c.name);
      box.style.setProperty('--hue', hue(c.name));
    }
    box._c = c;
  }

  /* ───────────────────────────── header & filters ───────────────────────────── */

  function renderHeader() {
    const p = activePlaylist();
    $('plName').textContent = p ? p.name : 'Playlists';
    $('btnPlaylist').title = p ? `${p.name}: switch playlist` : 'Switch playlist';
  }

  // Groups in the order the playlist first mentions them, with their channel counts.
  function groupCounts({ all = false } = {}) {
    const counts = new Map();
    let ungrouped = 0;
    for (const c of state.channels) {
      const gs = groupsOf(c);
      if (!gs.length) ungrouped++;
      for (const g of gs) counts.set(g, (counts.get(g) || 0) + 1);
    }
    const out = [...counts].map(([key, n]) => ({ key, label: key, n }));
    if (ungrouped && out.length) out.push({ key: UNGROUPED, label: 'Uncategorized', n: ungrouped });
    return all ? out : out.filter((g) => !state.hidden.has(g.key));
  }

  const isView = (type, group = '') => state.view.type === type && (type !== 'group' || state.view.group === group);

  function chip(label, selected, onClick, icon) {
    const b = h('button', 'chip' + (selected ? ' on' : ''));
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (icon) {
      b.classList.add('has-icon');
      b.appendChild(svg(icon));
    }
    b.appendChild(h('span', '', label));
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderFilters() {
    const box = $('filters');
    box.textContent = '';
    box.append(
      chip('All', isView('all'), () => setView({ type: 'all', group: '' })),
      chip('Favorites', isView('favorites'), () => setView({ type: 'favorites', group: '' }), ICON.star),
      chip('Recent', isView('recents'), () => setView({ type: 'recents', group: '' }), ICON.clock)
    );
    // One pill for the groups: it names the chosen group and opens the list of all of them.
    const groups = groupCounts();
    const chosen = state.view.type === 'group' && groups.find((g) => g.key === state.view.group);
    const b = $('btnGroups');
    b.hidden = !groups.length;
    b.classList.toggle('on', !!chosen);
    $('groupLabel').textContent = chosen ? chosen.label : 'Groups';
    b.title = chosen ? `${chosen.label}: choose another group` : `Choose one of ${plural(groups.length, 'group', 'groups')}`;
    if (!$('groupPop').hidden) renderGroupPop();
  }

  function setView(view) {
    state.view = view;
    state.cursor = -1;
    closeGroupPop();
    renderFilters();
    applyFilter(true);
  }

  // Searchable list of every group, for playlists with more groups than fit in the chip row.
  function renderGroupPop() {
    const ul = $('groupList');
    ul.textContent = '';
    const terms = fold($('groupSearch').value).split(/\s+/).filter(Boolean);
    const groups = groupCounts().filter((g) => terms.every((t) => fold(g.label).includes(t)));
    for (const g of groups) {
      const li = h('li', 'group-item' + (isView('group', g.key) ? ' on' : ''));
      li.append(h('span', 'label', g.label), h('span', 'num', g.n.toLocaleString()));
      li.addEventListener('click', () => setView({ type: 'group', group: g.key }));
      li.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        const id = await api.popupMenu([{ id: 'hide', label: `Hide “${g.label}”` }, { type: 'separator' }, { id: 'manage', label: 'Manage Groups…' }]);
        if (id === 'hide') hideGroup(g.key);
        else if (id === 'manage') openGroupManager([g.key]);
      });
      ul.appendChild(li);
    }
    if (!groups.length) ul.appendChild(h('li', 'group-none', state.hidden.size && terms.length ? 'No shown groups match' : 'No groups match'));
    const hiddenCount = groupCounts({ all: true }).filter((g) => state.hidden.has(g.key)).length;
    $('groupHiddenNote').textContent = hiddenCount ? `${plural(hiddenCount, 'group', 'groups')} hidden` : '';
  }
  function openGroupPop() {
    $('groupSearch').value = '';
    renderGroupPop();
    const b = $('btnGroups');
    $('groupPop').style.top = b.offsetTop + b.offsetHeight + 6 + 'px';
    $('groupPop').hidden = false;
    $('btnGroups').setAttribute('aria-expanded', 'true');
    $('groupSearch').focus();
    const on = $('groupList').querySelector('.group-item.on');
    if (on) on.scrollIntoView({ block: 'center' });
  }
  function closeGroupPop() {
    $('groupPop').hidden = true;
    $('btnGroups').setAttribute('aria-expanded', 'false');
  }
  $('btnGroups').addEventListener('click', (e) => {
    e.stopPropagation();
    $('groupPop').hidden ? openGroupPop() : closeGroupPop();
  });
  $('groupSearch').addEventListener('input', renderGroupPop);
  $('groupSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeGroupPop(); $('btnGroups').focus(); }
    else if (e.key === 'Enter') { const first = $('groupList').querySelector('.group-item'); if (first) first.click(); }
  });
  document.addEventListener('mousedown', (e) => {
    if (!$('groupPop').hidden && !e.target.closest('#groupPop, #btnGroups')) closeGroupPop();
  });

  /* ───────────────────────────── hiding groups ───────────────────────────── */

  let hiddenSaveTimer = 0;
  function setHidden(keys, hide) {
    for (const k of keys) hide ? state.hidden.add(k) : state.hidden.delete(k);
    hiddenChanged();
  }
  function hiddenChanged() {
    const p = activePlaylist();
    if (p) {
      p.hiddenGroups = [...state.hidden];
      clearTimeout(hiddenSaveTimer);
      hiddenSaveTimer = setTimeout(() => api.setHiddenGroups(p.id, p.hiddenGroups).catch((e) => toast(e.message)), 250);
    }
    if (state.view.type === 'group' && state.hidden.has(state.view.group)) state.view = { type: 'all', group: '' };
    renderFilters();
    applyFilter(false);
    if ($('dlgGroups').open) renderGroupManager();
  }
  function hideGroup(key) {
    const before = new Set(state.hidden);
    const label = key === UNGROUPED ? 'Uncategorized' : key;
    setHidden([key], true);
    toast(`Hid “${label}”`, 7000, { label: 'Undo', run: () => { state.hidden = before; hiddenChanged(); } });
  }

  // Groups gathered by the prefix IPTV playlists put in front of them ("ES | LALIGA VIP" -> ES). Groups
  // without one join a prefix section when their first word is that prefix ("ARAB VIP" -> ARAB).
  const pipePrefix = (label) => (/^\s*([^|]{1,20}?)\s*\|\s*\S/.exec(label) || [])[1] || '';
  function groupSections() {
    const groups = groupCounts({ all: true });
    const prefixes = new Map();
    for (const g of groups) {
      const p = g.key === UNGROUPED ? '' : pipePrefix(g.label);
      if (p) prefixes.set(p.toUpperCase(), (prefixes.get(p.toUpperCase()) || 0) + 1);
    }
    const by = new Map();
    for (const g of groups) {
      let k = g.key === UNGROUPED ? '' : pipePrefix(g.label).toUpperCase();
      if (!k && g.key !== UNGROUPED) {
        const first = g.label.trim().split(/\s+/)[0].toUpperCase();
        if (prefixes.has(first)) k = first;
      }
      if (k && (prefixes.get(k) || 0) < 2 && !by.has(k)) k = ''; // a prefix only one group uses is no section
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(g);
    }
    const sections = [...by].filter(([k]) => k).map(([k, list]) => ({ key: k, label: k, groups: list }));
    const loose = by.get('') || [];
    if (!sections.length) return [{ key: '', label: '', groups: loose }];
    if (loose.length) sections.push({ key: '\u0000other', label: 'Other groups', groups: loose });
    return sections;
  }
  const shortName = (g, sec) => (sec.key && pipePrefix(g.label).toUpperCase() === sec.key ? g.label.replace(/^[^|]*\|\s*/, '') : g.label);

  const gmOpen = new Set(); // expanded sections
  let gmFlash = new Set(); // groups to point out when the manager opens

  function checkbox(checked, indeterminate, label, onChange) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.indeterminate = !!indeterminate;
    cb.setAttribute('aria-label', label);
    cb.addEventListener('change', () => onChange(cb.checked));
    cb.addEventListener('click', (e) => e.stopPropagation());
    return cb;
  }

  function renderGroupManager() {
    const list = $('gmList');
    const keep = list.scrollTop;
    list.textContent = '';
    const terms = fold($('gmSearch').value).split(/\s+/).filter(Boolean);
    const sections = groupSections();
    const all = sections.flatMap((s) => s.groups);
    const shown = (g) => !state.hidden.has(g.key);
    const matched = [];

    const row = (g, sec) => {
      const r = h('label', 'gm-row' + (shown(g) ? '' : ' off') + (gmFlash.has(g.key) ? ' flash' : ''));
      r.title = g.label;
      r.append(
        checkbox(shown(g), false, `Show ${g.label}`, (on) => setHidden([g.key], !on)),
        h('span', 'gm-name', shortName(g, sec)),
        h('span', 'gm-meta', g.n.toLocaleString())
      );
      return r;
    };

    for (const sec of sections) {
      const groups = sec.groups.filter((g) => !terms.length || terms.every((t) => fold(`${g.label} ${sec.label}`).includes(t)));
      if (!groups.length) continue;
      matched.push(...groups);
      if (!sec.key) { // no sections: one plain list
        for (const g of groups) list.appendChild(row(g, sec));
        continue;
      }
      const on = groups.filter(shown).length;
      const box = h('div', 'gm-sec' + (gmOpen.has(sec.key) || terms.length ? ' open' : ''));
      const head = h('div', 'gm-sec-head' + (on ? '' : ' off'));
      const chev = h('button', 'gm-chev');
      chev.appendChild(svg('<path d="M6 4l4 4-4 4"/>'));
      chev.setAttribute('aria-label', `Show the groups in ${sec.label}`);
      const channels = groups.reduce((n, g) => n + g.n, 0);
      head.append(
        chev,
        checkbox(on === groups.length, on > 0 && on < groups.length, `Show every group in ${sec.label}`, (yes) => setHidden(groups.map((g) => g.key), !yes)),
        h('span', 'gm-name', sec.label),
        h('span', 'gm-meta', `${on === groups.length ? plural(groups.length, 'group', 'groups') : `${on} of ${groups.length} shown`} · ${channels.toLocaleString()}`)
      );
      head.addEventListener('click', () => {
        gmOpen.has(sec.key) ? gmOpen.delete(sec.key) : gmOpen.add(sec.key);
        box.classList.toggle('open');
      });
      const items = h('div', 'gm-items');
      for (const g of groups) items.appendChild(row(g, sec));
      box.append(head, items);
      list.appendChild(box);
    }
    if (!matched.length) list.appendChild(h('div', 'gm-empty', all.length ? 'No groups match' : 'This playlist has no groups.'));

    const shownGroups = all.filter(shown).length;
    const shownCount = shownChannels().length;
    $('gmTitle').textContent = `Groups in ${(activePlaylist() || {}).name || 'this playlist'}`;
    $('gmSummary').textContent = `${shownGroups.toLocaleString()} of ${plural(all.length, 'group', 'groups')} shown · ${shownCount.toLocaleString()} of ${plural(state.channels.length, 'channel', 'channels')}`;

    const bulk = $('gmBulk');
    bulk.textContent = '';
    const act = (label, run) => {
      const b = h('button', 'chip', label);
      b.addEventListener('click', run);
      bulk.appendChild(b);
    };
    const keys = matched.map((g) => g.key);
    if (terms.length && matched.length) {
      bulk.appendChild(h('span', 'gm-bulk-note', `${plural(matched.length, 'group matches', 'groups match')}:`));
      act('Show these', () => setHidden(keys, false));
      act('Hide these', () => setHidden(keys, true));
      act('Show only these', () => { state.hidden = new Set(all.map((g) => g.key).filter((k) => !keys.includes(k))); hiddenChanged(); });
    } else if (all.length) {
      act('Show all', () => { state.hidden = new Set(); hiddenChanged(); });
      act('Hide all', () => { state.hidden = new Set(all.map((g) => g.key)); hiddenChanged(); });
      if (sections.length > 1) {
        act('Expand all', () => { sections.forEach((s) => gmOpen.add(s.key)); renderGroupManager(); });
        act('Collapse all', () => { gmOpen.clear(); renderGroupManager(); });
      }
    }
    list.scrollTop = keep;
  }

  // flash: group keys to point out (their sections open, the first one scrolled into view).
  function openGroupManager(flash) {
    closeGroupPop();
    gmFlash = new Set(flash || []);
    $('gmSearch').value = '';
    for (const sec of groupSections()) if (sec.groups.some((g) => gmFlash.has(g.key))) gmOpen.add(sec.key);
    renderGroupManager();
    $('gmList').scrollTop = 0;
    $('dlgGroups').showModal();
    const first = $('gmList').querySelector('.flash');
    if (first) first.scrollIntoView({ block: 'center' });
    else $('gmSearch').focus();
    gmFlash = new Set();
  }
  $('gmSearch').addEventListener('input', renderGroupManager);
  $('btnManageGroups').addEventListener('click', () => openGroupManager());

  /* ───────────────────────────── quick search (Spotlight style) ───────────────────────────── */

  // "/" or Cmd/Ctrl+K: a big search field in the middle of the window, over everything (full screen
  // and a hidden sidebar included). Empty, it offers recently watched channels and favorites; typing
  // finds channels of the open playlist (hidden groups left out) and its groups.
  const SPOT_MAX = 40;
  const spot = { items: [], sel: -1 };
  const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function openSpot() {
    const dlg = $('dlgSpot');
    if (dlg.open) return $('spotInput').select();
    if (document.querySelector('dialog[open]')) return;
    if (!state.channels.length && !state.recents.length && !state.favorites.length) return;
    closeGroupPop();
    $('spotInput').value = '';
    renderSpot();
    dlg.showModal();
    $('spotInput').focus();
  }
  function closeSpot() {
    if ($('dlgSpot').open) $('dlgSpot').close();
  }

  // Best matches first: the name starts with the search, then a word in it does, then it contains it.
  function rankChannels(terms) {
    const whole = terms.join(' ');
    const wordStart = new RegExp('(^|[^a-z0-9])' + escapeRe(terms[0]));
    const recent = new Set(state.recents.map((r) => r.url));
    const hits = [];
    for (const c of shownChannels()) {
      if (c._s === undefined) indexChannel(c);
      if (!terms.every((t) => c._s.includes(t))) continue;
      const n = c._n || (c._n = fold(c.name));
      let score = 0;
      if (n.startsWith(whole)) score += 100;
      else if (wordStart.test(n)) score += 50;
      if (n.includes(whole)) score += 30;
      if (terms.every((t) => n.includes(t))) score += 20; // in the name, not just the group
      if (favUrls.has(c.url)) score += 15;
      if (recent.has(c.url)) score += 10;
      if (isDead(c)) score -= 25;
      hits.push([score - n.length / 200, c]);
    }
    hits.sort((a, b) => b[0] - a[0]);
    return { list: hits.slice(0, SPOT_MAX).map((x) => x[1]), total: hits.length };
  }

  // The channel name with the searched words in bold (when the name has no accents to fold away).
  function markedName(name, terms) {
    const el = h('div', 'spot-name');
    const folded = fold(name);
    if (!terms.length || folded.length !== name.length) { el.textContent = name; return el; }
    const marks = [];
    for (const t of terms) {
      const i = folded.indexOf(t);
      if (i >= 0) marks.push([i, i + t.length]);
    }
    marks.sort((a, b) => a[0] - b[0]);
    let at = 0;
    for (const [a, b] of marks) {
      if (a < at) continue;
      el.append(name.slice(at, a), h('mark', '', name.slice(a, b)));
      at = b;
    }
    el.append(name.slice(at));
    return el;
  }

  function spotRow(item, terms) {
    const i = spot.items.length;
    spot.items.push(item);
    const r = h('div', 'spot-row');
    r.id = 'spot-' + i;
    r.setAttribute('role', 'option');
    if (item.type === 'channel') {
      const c = item.c;
      const logo = h('div', 'logo');
      setLogo(logo, c);
      const main = h('div', 'spot-main');
      const st = state.status[c.url];
      const groups = groupsOf(c).join(', ');
      main.append(markedName(c.name, terms), h('div', 'spot-sub', st && st.s === 'dead' ? `Offline when last checked${groups ? ' · ' + groups : ''}` : groups || ' '));
      const side = h('div', 'spot-side');
      if (state.current && state.current.url === c.url) side.appendChild(h('span', 'spot-tag', 'Playing'));
      if (c.quality) side.appendChild(h('span', 'badge', c.quality));
      if (favUrls.has(c.url)) { const s = svg(ICON.star); s.classList.add('spot-fav'); side.appendChild(s); }
      if (st) side.appendChild(h('span', 'dot ' + st.s));
      r.append(logo, main, side);
      r.setAttribute('aria-label', c.name);
    } else {
      const ic = h('div', 'spot-ic');
      ic.appendChild(svg('<path d="M2.5 5.5v6a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V6.5A1.5 1.5 0 0 0 12 5H8L6.5 3.5H4A1.5 1.5 0 0 0 2.5 5z"/>'));
      const main = h('div', 'spot-main');
      main.append(markedName(item.g.label, terms), h('div', 'spot-sub', plural(item.g.n, 'channel', 'channels')));
      r.append(ic, main, h('span', 'spot-go', 'Show group'));
      r.setAttribute('aria-label', `Group ${item.g.label}`);
    }
    r.addEventListener('mousemove', () => { if (spot.sel !== i) selectSpot(i, false); });
    r.addEventListener('click', () => activateSpot(i));
    return r;
  }

  function renderSpot() {
    const list = $('spotList');
    list.textContent = '';
    spot.items = [];
    const q = $('spotInput').value.trim();
    const terms = fold(q).split(/\s+/).filter(Boolean);
    const section = (title, note) => {
      const s = h('div', 'spot-sec');
      s.append(h('span', '', title), h('span', '', note || ''));
      list.appendChild(s);
    };
    const empty = (title, body) => {
      const e = h('div', 'spot-empty');
      e.append(h('strong', '', title), body || '');
      list.appendChild(e);
    };
    const p = activePlaylist();
    $('spotScope').textContent = p ? `In ${p.name}` : '';

    if (!terms.length) {
      const recent = state.recents.slice(0, 6);
      const favs = state.favorites.filter((f) => !recent.some((r) => r.url === f.url)).slice(0, 6);
      if (recent.length) { section('Recently watched'); recent.forEach((c) => list.appendChild(spotRow({ type: 'channel', c }, terms))); }
      if (favs.length) { section('Favorites'); favs.forEach((c) => list.appendChild(spotRow({ type: 'channel', c }, terms))); }
      if (!recent.length && !favs.length) empty(`Search ${plural(shownChannels().length, 'channel', 'channels')}`, 'Type a channel or group name.');
    } else {
      const { list: hits, total } = rankChannels(terms);
      const groups = groupCounts().filter((g) => terms.every((t) => fold(g.label).includes(t))).slice(0, 5);
      if (hits.length) {
        section('Channels', total > hits.length ? `Best ${hits.length} of ${total.toLocaleString()}` : '');
        hits.forEach((c) => list.appendChild(spotRow({ type: 'channel', c }, terms)));
      }
      if (groups.length) {
        section('Groups');
        groups.forEach((g) => list.appendChild(spotRow({ type: 'group', g }, terms)));
      }
      if (!hits.length && !groups.length) {
        const hidden = state.hidden.size ? state.channels.filter((c) => !isShown(c) && (c._s !== undefined || (indexChannel(c), true)) && terms.every((t) => c._s.includes(t))).length : 0;
        empty(`Nothing matches “${q}”`, hidden ? `${plural(hidden, 'channel in a hidden group matches', 'channels in hidden groups match')}. Show them in Manage Groups.` : 'Check the spelling, or try fewer words.');
      }
    }
    selectSpot(spot.items.length ? 0 : -1, true);
  }

  function selectSpot(i, scroll) {
    const list = $('spotList');
    const old = list.querySelector('.spot-row.sel');
    if (old) { old.classList.remove('sel'); old.setAttribute('aria-selected', 'false'); }
    spot.sel = i;
    const input = $('spotInput');
    const item = spot.items[i];
    if (i < 0 || !item) { input.removeAttribute('aria-activedescendant'); return; }
    const r = $('spot-' + i);
    r.classList.add('sel');
    r.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', r.id);
    $('spotEnterHint').textContent = item.type === 'group' ? 'show group' : 'play';
    if (scroll) r.scrollIntoView({ block: 'nearest' });
  }

  function activateSpot(i) {
    const item = spot.items[i];
    if (!item) return;
    closeSpot();
    if (item.type === 'group') {
      setView({ type: 'group', group: item.g.key });
      peek(true);
      return;
    }
    const at = state.filtered.findIndex((c) => c.url === item.c.url);
    if (at >= 0) { state.cursor = at; scrollToIndex(at); }
    play(item.c);
  }

  let spotTimer = 0;
  $('spotInput').addEventListener('input', () => {
    clearTimeout(spotTimer);
    spotTimer = setTimeout(renderSpot, 12); // coalesces fast typing; ranking 12,000 channels takes ~10 ms
  });
  $('spotInput').addEventListener('keydown', (e) => {
    const n = spot.items.length;
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey) || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      if (n) selectSpot((spot.sel + 1) % n, true);
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      if (n) selectSpot((spot.sel - 1 + n) % n, true);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      if (n) selectSpot(Math.max(0, Math.min(n - 1, spot.sel + (e.key === 'PageDown' ? 6 : -6))), true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activateSpot(spot.sel);
    }
  });
  // A click on the dimmed area around the box closes it.
  $('dlgSpot').addEventListener('click', (e) => { if (e.target === $('dlgSpot')) closeSpot(); });

  /* ───────────────────────────── updates ───────────────────────────── */

  // New versions come from GitHub Releases (see lib/updates.js). A card in the bottom-left corner says
  // when one is out (in "ask" mode), how the download goes, and when it's ready to install.
  let dismissedUpdate = ''; // "version:status" the person closed or put off
  function renderUpdate(s) {
    const card = $('updateCard');
    if (!s) return;
    if (s.manual && s.status === 'none') toast(`You’re up to date: Vibe TV ${s.current} is the newest version.`);
    if (s.manual && s.status === 'error') toast(`Couldn’t check for updates: ${s.error}.`, 7000);

    const key = `${s.version}:${s.status}`;
    const show =
      dismissedUpdate !== key &&
      (s.status === 'available' || s.status === 'ready' || (s.status === 'downloading' && (!s.auto || s.manual || card.dataset.status === 'downloading')));
    if (!show) {
      card.hidden = true;
      card.dataset.status = '';
      return;
    }
    const later = () => { dismissedUpdate = key; card.hidden = true; card.dataset.status = ''; };
    let title = '';
    let body = '';
    const actions = [];
    if (s.status === 'available') {
      title = `Vibe TV ${s.version} is available`;
      body = `You have ${s.current}. Download it now, or later from the app menu.`;
      actions.push(['Download', 'primary', () => api.downloadUpdate()], ['Later', '', later]);
    } else if (s.status === 'downloading') {
      title = `Downloading Vibe TV ${s.version}`;
      body = `${s.progress || 0}% · you can keep watching.`;
    } else {
      title = `Vibe TV ${s.version} is ready`;
      body = 'Restart to finish updating. It also installs by itself the next time you quit.';
      actions.push(['Restart now', 'primary', () => api.installUpdate()], ['Later', '', later]);
    }
    // Same card already on screen: only update what changed, so the progress bar moves smoothly.
    if (card.dataset.status === s.status && card.dataset.version === s.version) {
      card.querySelector('.uc-text span').textContent = body;
      const bar = card.querySelector('.uc-bar i');
      if (bar) bar.style.width = (s.progress || 0) + '%';
      card.hidden = false;
      return;
    }
    card.dataset.status = s.status;
    card.dataset.version = s.version;
    card.textContent = '';
    const head = h('div', 'uc-head');
    const icon = document.createElement('img');
    icon.src = 'icon.png';
    icon.alt = '';
    const text = h('div', 'uc-text');
    text.append(h('strong', '', title), h('span', '', body));
    const close = h('button', 'icon-btn uc-close');
    close.setAttribute('aria-label', 'Close');
    close.appendChild(svg('<path d="M4 4l8 8M12 4l-8 8"/>'));
    close.addEventListener('click', later);
    head.append(icon, text, close);
    card.appendChild(head);
    if (s.status === 'downloading') {
      const bar = h('div', 'uc-bar');
      const fill = h('i');
      fill.style.width = (s.progress || 0) + '%';
      bar.appendChild(fill);
      card.appendChild(bar);
    }
    if (actions.length || s.version) {
      const row = h('div', 'uc-actions');
      for (const [label, kind, run] of actions) {
        const b = h('button', 'btn' + (kind ? ' ' + kind : ''), label);
        b.addEventListener('click', run);
        row.appendChild(b);
      }
      const notes = h('button', 'text-btn', 'What’s new');
      notes.addEventListener('click', () => api.openReleaseNotes(s.version).catch(() => {}));
      row.appendChild(notes);
      card.appendChild(row);
    }
    card.hidden = false;
  }
  api.on('update:state', renderUpdate);

  /* ───────────────────────────── sidebar width ───────────────────────────── */

  // Drag the sidebar's right edge. Dragging well past the narrowest width tucks the sidebar away
  // (Hide mode) and keeps the width for when it comes back; double-click resets it.
  const SB_MIN = 260;
  const SB_DEFAULT = 360;
  const SB_COLLAPSE = 70; // px past the minimum that count as "put it away"
  const sbMax = () => Math.max(SB_MIN, Math.min(640, window.innerWidth - 400));
  const clampWidth = (w) => Math.round(Math.max(SB_MIN, Math.min(sbMax(), w)));
  const sidebarWidth = () => sidebarEl.getBoundingClientRect().width;

  function setSidebarWidth(w, save) {
    if (w == null) {
      appEl.style.removeProperty('--sb-w');
    } else {
      appEl.style.setProperty('--sb-w', clampWidth(w) + 'px');
    }
    const handle = $('sbResize');
    handle.setAttribute('aria-valuemin', SB_MIN);
    handle.setAttribute('aria-valuemax', sbMax());
    handle.setAttribute('aria-valuenow', Math.round(sidebarWidth()));
    if (save) {
      state.settings.sidebarWidth = w == null ? null : clampWidth(w);
      persist({ settings: { sidebarWidth: state.settings.sidebarWidth } });
    }
  }

  (() => {
    const handle = $('sbResize');
    let startX = 0;
    let startW = 0;
    let collapsing = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startW = sidebarWidth();
      collapsing = false;
      appEl.classList.add('resizing');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!appEl.classList.contains('resizing')) return;
      const want = startW + (e.clientX - startX);
      // Only a docked sidebar collapses; an overlay one just stops at the minimum.
      collapsing = sidebarMode() === 'show' && want < SB_MIN - SB_COLLAPSE;
      sidebarEl.classList.toggle('will-collapse', collapsing);
      setSidebarWidth(want, false);
    });
    const end = () => {
      if (!appEl.classList.contains('resizing')) return;
      appEl.classList.remove('resizing');
      sidebarEl.classList.remove('will-collapse');
      if (collapsing) {
        setSidebarWidth(startW, false); // keep the width it had for when it comes back
        setSidebarMode('hide');
        toast(`Sidebar hidden. Bring it back with ${SIDEBAR_KEY} or the button at the top left.`);
      } else {
        setSidebarWidth(sidebarWidth(), true);
      }
      collapsing = false;
      queueRows();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
    handle.addEventListener('dblclick', () => { setSidebarWidth(null, true); queueRows(); });
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 60 : 20;
      let w = null;
      if (e.key === 'ArrowLeft') w = sidebarWidth() - step;
      else if (e.key === 'ArrowRight') w = sidebarWidth() + step;
      else if (e.key === 'Home') w = SB_MIN;
      else if (e.key === 'End') w = sbMax();
      else if (e.key === 'Enter') { setSidebarWidth(null, true); return; }
      else return;
      e.preventDefault();
      setSidebarWidth(w, true);
    });
    // Keep the numbers the handle reports right when the window changes size.
    window.addEventListener('resize', () => setSidebarWidth(state.settings.sidebarWidth || null, false));
  })();

  /* ───────────────────────────── sidebar: show, auto-hide, hide ───────────────────────────── */

  // show: docked next to the video. auto: tucked away, slides in when the pointer touches the left
  // edge and out again when it leaves. hide: tucked away until asked for (button, menu, shortcut).
  const SIDEBAR_MODES = ['show', 'auto', 'hide'];
  const SIDEBAR_KEY = isMac ? '⌃⌘S' : 'Ctrl+B';
  const appEl = $('app');
  const sidebarEl = appEl.querySelector('.sidebar');
  let peekTimer = 0;

  const sidebarMode = () => (SIDEBAR_MODES.includes(state.settings.sidebar) ? state.settings.sidebar : 'show');
  const sidebarShown = () => sidebarMode() === 'show' || appEl.classList.contains('peek');

  function applySidebar() {
    const mode = sidebarMode();
    appEl.classList.toggle('sb-auto', mode === 'auto');
    appEl.classList.toggle('sb-hide', mode === 'hide');
    if (mode === 'show') appEl.classList.remove('peek');
    const pin = mode !== 'show';
    $('btnSidebar').title = pin ? `Keep the sidebar open (${SIDEBAR_KEY})` : `Hide the sidebar (${SIDEBAR_KEY}). Right-click for auto-hide`;
    $('btnSidebar').setAttribute('aria-label', pin ? 'Keep the sidebar open' : 'Hide the sidebar');
    $('btnSidebar').classList.toggle('on', pin);
    $('btnShowSidebar').title = `Show the sidebar (${SIDEBAR_KEY})`;
    syncWindowButtons();
  }

  function setSidebarMode(mode) {
    if (!SIDEBAR_MODES.includes(mode)) return;
    if (mode !== 'show') state.settings.sidebarLast = mode;
    state.settings.sidebar = mode;
    persist({ settings: { sidebar: mode, sidebarLast: state.settings.sidebarLast } });
    applySidebar();
  }

  function toggleSidebar() {
    setSidebarMode(sidebarMode() === 'show' ? state.settings.sidebarLast || 'hide' : 'show');
  }

  // Slides the tucked-away sidebar in over the video, or back out.
  function peek(on) {
    clearTimeout(peekTimer);
    if (sidebarMode() === 'show') return;
    appEl.classList.toggle('peek', on);
    if (!on) {
      closeGroupPop();
      if (sidebarEl.contains(document.activeElement)) document.activeElement.blur();
    }
    syncWindowButtons();
  }
  // Stays out while the pointer is over it, while typing a search, or while the group list is open.
  function unpeekSoon() {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      const busy = sidebarEl.matches(':hover') || !$('groupPop').hidden || document.activeElement === $('search');
      if (!busy) peek(false);
    }, 450);
  }

  $('edgeZone').addEventListener('mouseenter', () => { if (sidebarMode() === 'auto') peek(true); });
  sidebarEl.addEventListener('mouseenter', () => clearTimeout(peekTimer));
  sidebarEl.addEventListener('mouseleave', () => { if (appEl.classList.contains('peek')) unpeekSoon(); });
  $('search').addEventListener('blur', () => { if (appEl.classList.contains('peek')) unpeekSoon(); });
  sidebarEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && appEl.classList.contains('peek') && $('groupPop').hidden && !$('search').value) peek(false);
  });

  $('btnSidebar').addEventListener('click', toggleSidebar);
  $('btnSidebar').addEventListener('contextmenu', (e) => { e.preventDefault(); sidebarMenu(); });
  $('btnShowSidebar').addEventListener('click', () => (sidebarMode() === 'auto' ? peek(true) : setSidebarMode('show')));
  $('btnShowSidebar').addEventListener('contextmenu', (e) => { e.preventDefault(); sidebarMenu(); });

  async function sidebarMenu() {
    const mode = sidebarMode();
    const id = await api.popupMenu([
      { id: 'show', label: 'Always Show Sidebar', checked: mode === 'show' },
      { id: 'auto', label: 'Auto-Hide Sidebar', checked: mode === 'auto' },
      { id: 'hide', label: 'Hide Sidebar', checked: mode === 'hide' },
    ]);
    if (id) setSidebarMode(id);
  }

  // macOS: with the sidebar away, the window buttons fade together with the player controls.
  let windowButtons = true;
  function syncWindowButtons() {
    const p = $('player');
    const visible = sidebarShown() || p.classList.contains('idle') || !p.classList.contains('controls-hidden');
    if (visible === windowButtons) return;
    windowButtons = visible;
    api.setWindowButtons(visible).catch(() => {});
  }

  /* ───────────────────────────── channel list ───────────────────────────── */

  const list = $('list');
  const spacer = $('listSpacer');
  const rows = new Map(); // index -> row element
  const pool = [];

  function baseList() {
    const v = state.view;
    if (v.type === 'favorites') return state.favorites;
    if (v.type === 'recents') return state.recents;
    if (v.type === 'group') {
      return v.group === UNGROUPED
        ? state.channels.filter((c) => !groupsOf(c).length)
        : state.channels.filter((c) => groupsOf(c).includes(v.group));
    }
    return shownChannels();
  }

  function applyFilter(resetScroll) {
    let items = baseList();
    const terms = fold(state.query).split(/\s+/).filter(Boolean);
    if (terms.length) {
      items = items.filter((c) => {
        if (c._s === undefined) indexChannel(c);
        return terms.every((t) => c._s.includes(t));
      });
    }
    state.hiddenOffline = 0;
    if (state.settings.hideOffline) {
      const before = items.length;
      items = items.filter((c) => !isDead(c));
      state.hiddenOffline = before - items.length;
    }
    state.filtered = items;
    if (state.cursor >= items.length) state.cursor = items.length - 1;

    for (const [i, r] of rows) { r.remove(); pool.push(r); rows.delete(i); }
    if (resetScroll) list.scrollTop = 0;
    renderRows();
    renderCount();
    renderEmpty();
  }

  // The search field says how many channels it searches: "Search 12,120 channels".
  function renderCount() {
    const input = $('search');
    if (state.loading || state.importing) {
      input.placeholder = state.importing ? 'Importing…' : 'Loading…';
      return;
    }
    if (state.query.trim()) return; // the placeholder is not visible while typing
    const n = state.filtered.length;
    const noun = state.view.type === 'favorites' ? ['favorite', 'favorites'] : state.view.type === 'recents' ? ['recent channel', 'recent channels'] : ['channel', 'channels'];
    input.placeholder = n ? `Search ${plural(n, noun[0], noun[1])}` : 'Search channels';
    let label = input.placeholder;
    if (state.hiddenOffline) label += `, ${plural(state.hiddenOffline, 'offline channel', 'offline channels')} hidden`;
    input.setAttribute('aria-label', label);
    input.title = label;
  }

  function renderEmpty() {
    const box = $('listEmpty');
    box.textContent = '';
    const show = (title, body, button, action) => {
      box.appendChild(h('strong', '', title));
      if (body) box.appendChild(h('span', '', body));
      if (button) {
        const b = h('button', 'btn', button);
        b.addEventListener('click', action);
        box.appendChild(b);
      }
      box.hidden = false;
    };
    if (state.importing) return show('Importing…', state.loadingNote);
    if (state.loading) return show('Loading playlist…', state.loadingNote);
    if (state.loadError) return show('This playlist couldn’t be loaded', state.loadError, 'Try again', () => openPlaylist(state.activeId));
    if (state.filtered.length) { box.hidden = true; return; }
    // Nothing to see because of hidden groups: say so, and offer the way back.
    if (state.view.type === 'all' && state.hidden.size) {
      const terms = fold(state.query).split(/\s+/).filter(Boolean);
      const out = state.channels.filter((c) => !isShown(c) && (c._s !== undefined || (indexChannel(c), true)) && terms.every((t) => c._s.includes(t)));
      if (out.length) {
        return terms.length
          ? show(`No shown channels match “${state.query.trim()}”`, `${plural(out.length, 'channel in a hidden group matches', 'channels in hidden groups match')}.`, 'Manage groups…', () => openGroupManager(out.flatMap((c) => (groupsOf(c).length ? groupsOf(c) : [UNGROUPED]))))
          : show('Every group is hidden', 'Choose which groups to show in this playlist.', 'Manage groups…', () => openGroupManager());
      }
    }
    if (state.query.trim()) {
      return show(`No channels match “${state.query.trim()}”`, state.view.type === 'all' ? 'Check the spelling, or try a shorter search.' : 'The search only looks inside the current selection.', 'Clear search', () => {
        $('search').value = '';
        state.query = '';
        applyFilter(true);
      });
    }
    if (state.hiddenOffline) {
      return show('Every channel here is marked offline', 'They did not respond when they were last checked.', 'Show offline channels', () => setHideOffline(false));
    }
    if (state.view.type === 'favorites') return show('No favorites yet', 'Hover a channel and click the star to keep it here.');
    if (state.view.type === 'recents') return show('Nothing watched yet', 'Channels you play show up here.');
    show('This playlist is empty', 'Import an M3U file to add its channels here.', 'Import M3U file…', () => importFromPicker());
  }

  function createRow() {
    const r = h('div', 'row');
    r.setAttribute('role', 'option');
    r._logo = h('div', 'logo');
    const main = h('div', 'row-main');
    r._name = h('div', 'row-name');
    r._sub = h('div', 'row-sub');
    main.append(r._name, r._sub);
    const side = h('div', 'row-side');
    r._badge = h('span', 'badge');
    r._dot = h('span', 'dot');
    r._star = h('button', 'star');
    r._star.appendChild(svg(ICON.star));
    side.append(r._badge, r._dot, r._star);
    r.append(r._logo, main, side);
    return r;
  }

  function fillRow(r, c, i) {
    r._c = c;
    r._i = i;
    const playing = !!state.current && state.current.url === c.url;
    const st = state.status[c.url];
    r.classList.toggle('playing', playing);
    r.classList.toggle('cursor', i === state.cursor);
    r.classList.toggle('offline', !!st && st.s === 'dead');
    r.setAttribute('aria-selected', playing ? 'true' : 'false');
    if (r._name.textContent !== c.name) r._name.textContent = c.name;
    setLogo(r._logo, c);

    r._sub.textContent = '';
    const text = st && st.s === 'dead' ? 'Offline when last checked' : groupsOf(c).join(', ');
    if (text) r._sub.appendChild(h('span', 'sub-text', text));
    for (const t of c.tags || []) r._sub.appendChild(h('span', 'badge', t));

    r._badge.hidden = !c.quality;
    r._badge.textContent = c.quality || '';
    r._dot.hidden = !st;
    r._dot.className = 'dot ' + (st ? st.s : '');
    r._dot.title = st ? (st.s === 'ok' ? 'Online when last checked' : 'Offline when last checked') : '';
    const fav = favUrls.has(c.url);
    r._star.classList.toggle('on', fav);
    r._star.title = fav ? 'Remove from favorites' : 'Add to favorites';
    r._star.setAttribute('aria-label', r._star.title);
  }

  let rowsQueued = false;
  function renderRows() {
    rowsQueued = false;
    const n = state.filtered.length;
    spacer.style.height = n * ROW_H + 'px';
    const top = list.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW_H) - 5);
    const last = Math.min(n - 1, Math.ceil((top + list.clientHeight) / ROW_H) + 5);
    for (const [i, r] of rows) {
      if (i < first || i > last) { r.remove(); pool.push(r); rows.delete(i); }
    }
    for (let i = first; i <= last; i++) {
      let r = rows.get(i);
      if (!r) {
        r = pool.pop() || createRow();
        r.style.top = i * ROW_H + 2 + 'px';
        rows.set(i, r);
        spacer.appendChild(r);
      }
      fillRow(r, state.filtered[i], i);
    }
  }
  function queueRows() {
    if (rowsQueued) return;
    rowsQueued = true;
    requestAnimationFrame(renderRows);
  }

  function scrollToIndex(i) {
    if (i < 0) return;
    const top = i * ROW_H;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_H - list.clientHeight;
  }

  list.addEventListener('scroll', queueRows, { passive: true });
  new ResizeObserver(queueRows).observe(list);

  list.addEventListener('click', (e) => {
    const r = e.target.closest('.row');
    if (!r) return;
    if (e.target.closest('.star')) return toggleFavorite(r._c);
    state.cursor = r._i;
    play(r._c);
  });
  list.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.row');
    if (!r) return;
    e.preventDefault();
    channelMenu(r._c);
  });
  list.addEventListener('keydown', (e) => {
    const n = state.filtered.length;
    if (!n) return;
    const page = Math.max(1, Math.floor(list.clientHeight / ROW_H) - 1);
    let next = state.cursor;
    if (e.key === 'ArrowDown') next = Math.min(n - 1, state.cursor + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, state.cursor - 1);
    else if (e.key === 'PageDown') next = Math.min(n - 1, Math.max(0, state.cursor) + page);
    else if (e.key === 'PageUp') next = Math.max(0, state.cursor - page);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Enter' && state.cursor >= 0) { e.preventDefault(); return play(state.filtered[state.cursor]); }
    else return;
    e.preventDefault();
    state.cursor = next;
    scrollToIndex(next);
    renderRows();
  });

  /* ───────────────────────────── playlists ───────────────────────────── */

  let loadToken = 0;

  function showShell() {
    const any = state.playlists.length > 0;
    $('app').hidden = !any;
    $('welcome').hidden = any;
  }

  function upsertPlaylist(p) {
    const i = state.playlists.findIndex((x) => x.id === p.id);
    if (i < 0) state.playlists.push(p);
    else state.playlists[i] = p;
  }

  async function openPlaylist(id) {
    const p = state.playlists.find((x) => x.id === id);
    if (!p) return;
    const token = ++loadToken;
    if (state.checking && id !== state.activeId) api.cancelCheck().catch(() => {});
    state.activeId = id;
    state.loading = true;
    state.loadingNote = '';
    state.loadError = '';
    state.channels = [];
    state.hidden = new Set(p.hiddenGroups || []);
    state.view = { type: 'all', group: '' };
    state.query = '';
    state.cursor = -1;
    $('search').value = '';
    persist({ activePlaylistId: id });
    closeGroupPop();
    renderHeader();
    renderFilters();
    applyFilter(true);

    try {
      const channels = await api.playlistChannels(id);
      if (token !== loadToken) return;
      state.channels = channels;
      p.count = channels.length;
    } catch (e) {
      if (token !== loadToken) return;
      state.loadError = e.message;
    }
    state.loading = false;
    for (const c of state.channels) indexChannel(c);
    renderFilters();
    applyFilter(true);
    if (state.channels.length) enrichFromDatabase(token);
  }

  // Logos and categories for channels that only carry a tvg-id.
  async function enrichFromDatabase(token) {
    const ids = new Set();
    for (const c of [...state.channels, ...state.favorites, ...state.recents]) {
      if (c.tvgId && !(c.tvgId in state.db) && (!c.logo || !(c.groups && c.groups.length))) ids.add(c.tvgId);
    }
    if (!ids.size) return;
    let found;
    try {
      found = await api.lookupChannels([...ids]);
    } catch (e) {
      return;
    }
    for (const id of ids) state.db[id] = found[id] || { logo: '', groups: null };
    if (token !== loadToken) return;
    for (const c of state.channels) indexChannel(c);
    renderFilters();
    applyFilter(false);
    renderNow();
  }

  // The file exists but its contents are still being fetched (cloud or network folder).
  api.on('import:waiting', (name) => {
    if (!state.importing) return;
    state.loadingNote = `Waiting for “${name}” to download from its cloud or network folder. This can take up to a minute.`;
    renderEmpty();
  });

  /* ───────────────────────────── importing ───────────────────────────── */

  // Runs an import into the open playlist (or a new one when there is none) and reports the result.
  async function runImport(start) {
    if (state.importing) return;
    state.importing = true;
    state.loadingNote = '';
    if (!state.channels.length) applyFilter(false);
    renderCount();
    let res = null;
    try {
      res = await start(state.activeId);
    } catch (e) {
      toast(e.message, 7000);
    }
    state.importing = false;
    state.loadingNote = '';
    if (!res) {
      renderCount();
      renderEmpty();
      return null;
    }
    upsertPlaylist(res.playlist);
    showShell();
    const where = `“${res.playlist.name}”`;
    let msg = res.message || (res.added
      ? `Added ${plural(res.added, 'channel', 'channels')} to ${where}.`
      : `Nothing new to add: ${where} already has these channels.`);
    if (!res.message && res.added && res.skipped) msg += ` ${plural(res.skipped, 'was', 'were')} already in it.`;
    if (res.errors && res.errors.length) msg += `\n${res.errors[0]}`;
    toast(msg, 6000);
    await openPlaylist(res.playlist.id);
    return res;
  }

  const importFromPicker = () => runImport((id) => api.importPick(id));
  const importPaths = (paths) => paths && paths.length && runImport((id) => api.importFiles(id, paths));

  function openUrlDialog() {
    const p = activePlaylist();
    $('urlTitle').textContent = p ? `Import into “${p.name}”` : 'Import from URL';
    $('urlInput').value = '';
    $('urlError').hidden = true;
    $('dlgUrl').showModal();
    $('urlInput').focus();
  }
  $('formUrl').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('urlInput').value;
    $('urlSubmit').disabled = true;
    $('urlSubmit').textContent = 'Importing…';
    let failed = null;
    const res = await runImport((id) => api.importUrl(id, url).catch((err) => { failed = err; return null; }));
    $('urlSubmit').disabled = false;
    $('urlSubmit').textContent = 'Import';
    if (res) return $('dlgUrl').close();
    if (failed) {
      $('urlError').textContent = failed.message;
      $('urlError').hidden = false;
    }
  });

  /* ───────────────────────────── Xtream Codes ───────────────────────────── */

  function accountNote(account) {
    if (!account || !account.expires) return '';
    const date = new Date(account.expires).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    return ` The account runs until ${date}.`;
  }

  function openXtreamDialog() {
    $('formXtream').reset();
    $('xtError').hidden = true;
    $('dlgXtream').showModal();
    $('xtServer').focus();
  }
  $('formXtream').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = {
      server: $('xtServer').value,
      username: $('xtUser').value,
      password: $('xtPass').value,
      name: $('xtName').value,
      movies: $('xtMovies').checked,
    };
    $('xtSubmit').disabled = true;
    $('xtSubmit').textContent = 'Logging in…';
    $('xtError').hidden = true;
    let failed = null;
    const res = await runImport(async () => {
      const r = await api.xtreamLogin(form).catch((err) => { failed = err; return null; });
      if (!r) return null;
      const what = r.movies
        ? `${plural(r.live, 'channel', 'channels')} and ${plural(r.movies, 'movie', 'movies')}`
        : plural(r.live, 'channel', 'channels');
      r.message = r.created
        ? `Logged in. “${r.playlist.name}” has ${what}.`
        : `Logged in. “${r.playlist.name}” was refreshed: ${what}.`;
      r.message += accountNote(r.account);
      return r;
    });
    $('xtSubmit').disabled = false;
    $('xtSubmit').textContent = 'Log In';
    if (res) return $('dlgXtream').close();
    if (failed) {
      $('xtError').textContent = failed.message;
      $('xtError').hidden = false;
    }
  });

  // Loads the playlist's channels from its Xtream server again.
  function refreshFromServer(p) {
    if (!p) return;
    if (!p.xtream) return toast('Only playlists made with an Xtream Codes login can be refreshed from a server.');
    toast(`Refreshing “${p.name}”…`, 30000);
    return runImport(async () => {
      const r = await api.xtreamRefresh(p.id);
      const changes = [r.added && `${plural(r.added, 'new channel', 'new channels')}`, r.removed && `${r.removed.toLocaleString()} gone`].filter(Boolean);
      r.message = `“${r.playlist.name}” is up to date${changes.length ? ` (${changes.join(', ')})` : ''}.${accountNote(r.account)}`;
      return r;
    });
  }

  /* ───────────────────────────── managing playlists ───────────────────────────── */

  for (const b of document.querySelectorAll('[data-close]')) {
    b.addEventListener('click', () => b.closest('dialog').close());
  }

  let nameAction = null;
  function askName(title, submit, value, action) {
    nameAction = action;
    $('nameTitle').textContent = title;
    $('nameSubmit').textContent = submit;
    $('nameInput').value = value || '';
    $('dlgName').showModal();
    $('nameInput').select();
  }
  $('formName').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('nameInput').value.trim();
    if (!name || !nameAction) return;
    try {
      await nameAction(name);
      $('dlgName').close();
    } catch (err) {
      toast(err.message);
    }
  });

  function newPlaylist() {
    askName('New playlist', 'Create', '', async (name) => {
      const p = await api.createPlaylist(name);
      upsertPlaylist(p);
      showShell();
      openPlaylist(p.id);
    });
  }

  function renamePlaylist(p) {
    if (!p) return;
    askName('Rename playlist', 'Rename', p.name, async (name) => {
      Object.assign(p, await api.renamePlaylist(p.id, name));
      renderHeader();
    });
  }

  async function removePlaylist(p) {
    if (!p) return;
    const yes = await api.confirm({
      message: `Delete “${p.name}”?`,
      detail: `Its ${plural(p.count || 0, 'channel is', 'channels are')} removed from the app. Your favorites and the M3U files you imported are kept.`,
      confirmLabel: 'Delete',
    });
    if (!yes) return;
    await api.removePlaylist(p.id);
    state.playlists = state.playlists.filter((x) => x.id !== p.id);
    if (state.activeId === p.id) {
      state.activeId = '';
      state.channels = [];
      state.loadError = '';
      if (state.playlists.length) openPlaylist(state.playlists[0].id);
    }
    showShell();
    renderHeader();
  }

  async function playlistMenu() {
    const active = activePlaylist();
    const items = state.playlists.map((p) => ({
      id: 'open:' + p.id,
      label: `${p.name}${p.count ? `  (${p.count.toLocaleString()})` : ''}`,
      checked: p.id === state.activeId,
    }));
    items.push({ type: 'separator' }, { id: 'new', label: 'New Playlist…' }, { id: 'xtream', label: 'Log In with Xtream Codes…' });
    if (active) {
      items.push(
        { type: 'separator' },
        { id: 'import', label: `Import M3U File into “${active.name}”…` },
        { id: 'url', label: 'Import from URL…' },
        ...(active.xtream ? [{ id: 'refresh', label: 'Refresh from Server' }] : []),
        { type: 'separator' },
        { id: 'rename', label: 'Rename…' },
        { id: 'delete', label: `Delete “${active.name}”…` }
      );
    }
    const id = await api.popupMenu(items);
    if (!id) return;
    if (id.startsWith('open:')) { if (id.slice(5) !== state.activeId) openPlaylist(id.slice(5)); }
    else if (id === 'new') newPlaylist();
    else if (id === 'xtream') openXtreamDialog();
    else if (id === 'import') importFromPicker();
    else if (id === 'url') openUrlDialog();
    else if (id === 'refresh') refreshFromServer(active);
    else if (id === 'rename') renamePlaylist(active);
    else if (id === 'delete') removePlaylist(active);
  }

  async function removeFromPlaylist(c) {
    const p = activePlaylist();
    if (!p) return;
    try {
      Object.assign(p, await api.removeChannels(p.id, [c.url]));
    } catch (e) {
      return toast(e.message);
    }
    state.channels = state.channels.filter((x) => x.url !== c.url);
    renderFilters();
    applyFilter(false);
    toast(`Removed ${c.name} from “${p.name}”`);
  }

  /* ───────────────────────────── favorites & recents ───────────────────────────── */

  function toggleFavorite(c) {
    if (!c) return;
    if (favUrls.has(c.url)) {
      favUrls.delete(c.url);
      state.favorites = state.favorites.filter((f) => f.url !== c.url);
    } else {
      favUrls.add(c.url);
      state.favorites = [...state.favorites, snapshot(c)];
    }
    persist({ favorites: state.favorites });
    if (state.view.type === 'favorites') applyFilter(false);
    else renderRows();
    renderNow();
  }

  function addRecent(c) {
    const snap = snapshot(c);
    snap.at = Date.now();
    const rest = state.recents.filter((r) => r.url !== c.url);
    // While the "Recently watched" list is on screen keep its order stable; it re-sorts next time it opens.
    if (state.view.type === 'recents' && rest.length !== state.recents.length) {
      state.recents = state.recents.map((r) => (r.url === c.url ? snap : r));
    } else {
      state.recents = [snap, ...rest].slice(0, MAX_RECENTS);
    }
    persist({ recents: state.recents });
  }

  async function channelMenu(c) {
    const fav = favUrls.has(c.url);
    const inPlaylist = state.view.type !== 'favorites' && state.view.type !== 'recents';
    const id = await api.popupMenu([
      { id: 'play', label: 'Play' },
      { id: 'fav', label: fav ? 'Remove from Favorites' : 'Add to Favorites' },
      { type: 'separator' },
      { id: 'check', label: 'Check if Online' },
      { id: 'copy', label: 'Copy Stream Address' },
      ...(inPlaylist ? [{ type: 'separator' }, ...groupsOf(c).slice(0, 3).map((g) => ({ id: 'hide:' + g, label: `Hide Group “${g}”` })), { id: 'remove', label: 'Remove from Playlist' }] : []),
    ]);
    if (id && id.startsWith('hide:')) hideGroup(id.slice(5));
    else if (id === 'play') play(c);
    else if (id === 'remove') removeFromPlaylist(c);
    else if (id === 'fav') toggleFavorite(c);
    else if (id === 'copy') { await api.copyText(c.url); toast('Stream address copied'); }
    else if (id === 'check') {
      toast(`Checking ${c.name}…`, 12000);
      const r = await api.probe(c.url, c.headers || null).catch(() => ({ ok: false }));
      setStatus(c.url, r.ok ? 'ok' : 'dead');
      toast(r.ok ? `${c.name} is online` : `${c.name} did not respond`);
      state.settings.hideOffline ? applyFilter(false) : renderRows();
    }
  }

  /* ───────────────────────────── online / offline checks ───────────────────────────── */

  function setStatus(url, s) {
    state.status[url] = { s, t: Date.now() };
    persist({ status: state.status });
  }

  function setHideOffline(on) {
    state.settings.hideOffline = on;
    persist({ settings: { hideOffline: on } });
    applyFilter(false);
    if (on && state.hiddenOffline) toast(`Hiding ${plural(state.hiddenOffline, 'offline channel', 'offline channels')}`);
    else if (!on) toast('Showing offline channels');
    // Nothing to hide until the channels have been tested at least once.
    if (on && !state.checking && state.channels.length && !state.channels.some((c) => state.status[c.url])) {
      startCheck();
    }
  }

  function renderCheck() {
    const k = state.checking;
    $('checkBar').hidden = !k;
    if (!k) return;
    $('checkFill').style.width = (k.total ? (k.done / k.total) * 100 : 0) + '%';
    $('checkText').textContent = `${k.done.toLocaleString()} of ${k.total.toLocaleString()}, ${k.dead.toLocaleString()} offline`;
  }

  let checkPaint = 0;
  async function startCheck() {
    if (state.checking) {
      api.cancelCheck().catch(() => {});
      return;
    }
    const items = shownChannels().filter((c) => /^https?:\/\//i.test(c.url)).map((c) => ({ url: c.url, headers: c.headers || null }));
    if (!items.length) return toast('Open a playlist first.');
    state.checking = { total: items.length, done: 0, dead: 0 };
    renderCheck();
    let result = { cancelled: true };
    try {
      result = await api.startCheck(items);
    } catch (e) {
      toast(e.message);
    }
    const k = state.checking;
    state.checking = null;
    renderCheck();
    persist({ status: state.status });
    applyFilter(false);
    if (k && !result.cancelled) {
      toast(`${plural(k.total - k.dead, 'channel is', 'channels are')} online, ${k.dead.toLocaleString()} did not respond.` + (k.dead && !state.settings.hideOffline ? '\nTurn on “Hide offline” to tuck those away.' : ''), 7000);
    }
  }

  api.on('check:progress', (batch) => {
    const k = state.checking;
    if (!k) return;
    const t = Date.now();
    for (const r of batch) {
      state.status[r.url] = { s: r.ok ? 'ok' : 'dead', t };
      k.done++;
      if (!r.ok) k.dead++;
    }
    renderCheck();
    if (t - checkPaint > 700) {
      checkPaint = t;
      state.settings.hideOffline ? applyFilter(false) : renderRows();
    }
  });

  /* ───────────────────────────── now playing ───────────────────────────── */

  // Name, groups and favorite star of the playing channel, shown with the player controls.
  function renderNow() {
    const c = state.current;
    const meta = $('nowMeta');
    meta.textContent = '';
    if (!c) {
      $('nowName').textContent = '';
      document.title = 'Vibe TV';
      return;
    }
    setLogo($('nowLogo'), c);
    $('nowName').textContent = c.name;
    document.title = `${c.name} - Vibe TV`;
    if (c.quality) meta.appendChild(h('span', 'badge', c.quality));
    const groups = groupsOf(c).join(', ');
    if (groups) meta.appendChild(h('span', '', groups));
    const fav = favUrls.has(c.url);
    $('btnFav').classList.toggle('on', fav);
    $('btnFav').title = (fav ? 'Remove from favorites' : 'Add to favorites') + ` (${MOD}D)`;
    $('btnFav').setAttribute('aria-label', $('btnFav').title);
  }

  /* ───────────────────────────── player ───────────────────────────── */

  const video = $('video');
  const playerEl = $('player');
  let engine = null;
  let engineKind = '';
  let playToken = 0;
  let startTimer = 0;
  let started = false;
  let converting = null; // { id, src, plan } while ffmpeg converts the playing channel
  let canConvert = false; // ffmpeg was found
  // How each channel ended up playing this session, so going back to it skips the failed attempts.
  const routes = new Map(); // url -> { streams, force }
  let freshRetry = 0; // play token already retried without a remembered route

  // What the player decodes itself inside an MPEG-TS stream (mpegts.js on top of Media Source).
  const mse = (t) => { try { return !!(window.MediaSource && MediaSource.isTypeSupported(t)); } catch (e) { return false; } };
  const CAN_PLAY_TS = {
    video: ['h264', ...(mse('video/mp4; codecs="hvc1.1.6.L120.90"') ? ['hevc'] : [])],
    audio: ['aac', 'mp3', ...(mse('audio/mp4; codecs="opus"') ? ['opus'] : [])],
  };
  // Addresses only ffmpeg can open, and files the built-in engine has no chance with.
  const CONVERT_SCHEMES = /^(rtmp|rtmps|rtmpt|rtmpe|rtsp|rtsps|rtp|udp|srt|mms|mmsh|mmst):\/\//i;
  const CONVERT_EXT = /^(avi|wmv|asf|mpg|mpeg|m2v|vob|m2ts|mts|3gp|3g2|rm|rmvb|divx|xvid|f4v|ogv|dv|mxf|wtv|ac3|eac3|dts|mp2|wma|amr|ape|aiff|aif|caf|mka)$/;

  const ERRORS = {
    offline: ['This channel isn’t responding', 'The stream may be offline right now, or it may not be available where you are.'],
    timeout: ['This channel took too long to start', 'The stream did not begin within 30 seconds. It may be overloaded or offline.'],
    codec: ['This stream uses a format the player can’t decode', 'Some channels broadcast video or audio (for example MPEG-2 or AC-3) that the player only handles with ffmpeg, which isn’t installed. Install ffmpeg (on a Mac: brew install ffmpeg) and play the channel again.'],
    protocol: ['This kind of stream address needs ffmpeg', 'rtmp://, rtsp://, udp:// and similar addresses are played through ffmpeg, which isn’t installed. Install ffmpeg (on a Mac: brew install ffmpeg) and play the channel again.'],
    convert: ['This channel couldn’t be played', ''],
    'protocol-other': ['This kind of stream address isn’t supported', 'Streams can be played from http://, https://, rtmp://, rtsp://, udp:// and similar addresses.'],
    webpage: ['This address is a web page, not a stream', 'The playlist points at a website for this channel instead of a video stream.'],
  };

  function setOverlay(mode) {
    $('overlayLoading').hidden = mode !== 'loading';
    $('overlayError').hidden = mode !== 'error';
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-lib="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.dataset.lib = src;
      s.onload = resolve;
      s.onerror = () => { s.remove(); reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function kindFromUrl(url) {
    let pathname = '';
    try { pathname = new URL(url).pathname.toLowerCase(); } catch (e) { return ''; }
    const ext = (/\.([a-z0-9]{2,5})$/.exec(pathname) || [])[1] || '';
    if (ext === 'm3u8' || ext === 'm3u') return 'hls';
    if (ext === 'mpd') return 'dash';
    if (ext === 'ts' || ext === 'mts') return 'mpegts';
    if (ext === 'flv') return 'flv';
    if (CONVERT_EXT.test(ext)) return 'convert';
    if (/^(mp4|m4v|webm|mov|mkv|mp3|aac|m4a|ogg|oga|wav)$/.test(ext)) return 'native';
    return '';
  }

  function teardown() {
    clearTimeout(startTimer);
    started = false;
    if (engine) {
      try { engine.destroy(); } catch (e) { /* already gone */ }
      engine = null;
    }
    engineKind = '';
    if (converting) {
      api.convertClose(converting.id).catch(() => {});
      converting = null;
    }
    if (video.getAttribute('src') || video.src) {
      video.removeAttribute('src');
      video.load();
    }
    $('liveInfo').textContent = '';
    playerEl.classList.remove('vod');
  }

  function fail(token, reason, detail) {
    if (token !== playToken) return;
    const c = state.current;
    // A remembered way of playing that stopped working (the broadcaster changed the stream): start over.
    if (c && routes.has(c.url) && freshRetry !== token) {
      routes.delete(c.url);
      freshRetry = token;
      teardown();
      return play(c, token);
    }
    // What the built-in engine can't decode, ffmpeg converts: try that before giving up.
    if ((reason === 'codec' || reason === 'protocol') && canConvert && !converting && c) {
      return playConverted(c, token, null);
    }
    teardown();
    const [title, text] = ERRORS[reason] || ERRORS.offline;
    $('errorTitle').textContent = title;
    let body = text || String(detail || '');
    if (reason === 'convert') body = `${detail || 'ffmpeg could not read this stream'}.`.replace(/\.\.$/, '.');
    if (reason === 'offline' && c && (c.tags || []).some((t) => /geo/i.test(t))) {
      body = 'This channel is marked as geo-blocked, so it may only work from certain countries.';
    }
    $('errorDetail').textContent = body;
    $('errorDetail').title = detail ? String(detail) : '';
    setOverlay('error');
    playerEl.classList.add('paused');
    showControls();
    if (c && !['codec', 'protocol', 'protocol-other'].includes(reason)) {
      setStatus(c.url, 'dead');
      renderRows(); // stays listed even with "Hide offline" on, so the error has context
    }
  }

  async function play(c, again) {
    if (!c) return;
    const token = again || ++playToken;
    teardown();
    state.current = c;
    playerEl.classList.remove('idle', 'paused');
    setOverlay('loading');
    renderNow();
    renderRows();
    showOsd(c.name);
    showControls();

    if (!/^https?:\/\//i.test(c.url)) return fail(token, CONVERT_SCHEMES.test(c.url) ? 'protocol' : 'protocol-other');
    try { await api.setStreamHeaders(c.headers || null); } catch (e) { /* plain request */ }
    if (token !== playToken) return;

    const route = canConvert && routes.get(c.url);
    if (route) return playConverted(c, token, route.streams, route.force);

    let kind = kindFromUrl(c.url);
    if (kind === 'convert') return canConvert ? playConverted(c, token, null) : fail(token, 'codec');
    if (!kind || kind === 'mpegts') {
      // Look at what the server actually sends: the kind of stream, and for MPEG-TS its codecs.
      const p = await api.probe(c.url, c.headers || null).catch(() => ({ ok: false }));
      if (token !== playToken) return;
      if (!p.ok) return fail(token, p.reason === 'webpage' ? 'webpage' : 'offline', p.reason);
      kind = p.kind || 'native';
      if (p.plan && p.plan.convert) return playConverted(c, token, p.streams);
    }
    startTimer = setTimeout(() => { if (!started) fail(token, 'timeout'); }, 30000);
    try {
      await startEngine(kind, c, token);
    } catch (e) {
      fail(token, 'offline', e.message);
    }
  }

  // Plays a channel through ffmpeg, converting only the video or audio the player can't decode.
  async function playConverted(c, token, streams, force) {
    if (token !== playToken) return;
    teardown();
    setOverlay('loading');
    let conv;
    try {
      conv = await api.convertOpen({ url: c.url, headers: c.headers || null, streams: streams || null, force: force || null });
    } catch (e) {
      converting = { id: '' }; // no second attempt from fail()
      return fail(token, 'convert', e.message);
    }
    if (token !== playToken) { api.convertClose(conv.id).catch(() => {}); return; }
    conv.force = force || null;
    converting = conv;
    clearTimeout(startTimer);
    startTimer = setTimeout(() => { if (!started) fail(token, 'timeout'); }, 30000);
    try {
      await startEngine('mpegts', { ...c, url: conv.src }, token, conv);
    } catch (e) {
      fail(token, 'convert', e.message);
    }
  }

  async function startEngine(kind, c, token, conv) {
    const fatal = (reason, detail) => fail(token, reason, detail);
    const autoplay = () => video.play().catch(() => {});

    if (kind === 'hls') {
      if (!window.Hls || !window.Hls.isSupported()) return fatal('codec');
      const Hls = window.Hls;
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
      let networkRetries = 0;
      let mediaRetries = 0;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal || token !== playToken) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          const manifest = /manifest/i.test(data.details || '');
          if (!manifest && networkRetries++ < 2) return hls.startLoad();
          fatal('offline', data.details);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (!/incompatiblecodecs/i.test(data.details || '') && mediaRetries++ < 2) return hls.recoverMediaError();
          fatal('codec', data.details);
        } else {
          fatal('offline', data.details);
        }
      });
      let live = null;
      hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
        live = !!(data.details && data.details.live);
        updateLiveInfo();
      });
      hls.on(Hls.Events.MANIFEST_PARSED, autoplay);
      hls.loadSource(c.url);
      hls.attachMedia(video);
      engine = { destroy: () => hls.destroy(), isLive: () => live };
    } else if (kind === 'dash') {
      await loadScript('vendor/dash.mediaplayer.min.js');
      if (token !== playToken) return;
      const dash = window.dashjs.MediaPlayer().create();
      dash.on(window.dashjs.MediaPlayer.events.ERROR, (e) => fatal('offline', e && e.error && e.error.message));
      dash.initialize(video, c.url, true);
      engine = {
        destroy: () => dash.destroy(),
        isLive: () => { try { return dash.isDynamic(); } catch (e) { return null; } },
      };
    } else if (kind === 'mpegts' || kind === 'flv') {
      await loadScript('vendor/mpegts.js');
      if (token !== playToken) return;
      const mpegts = window.mpegts;
      if (!mpegts.isSupported()) return fatal('codec');
      const p = mpegts.createPlayer({ type: kind, isLive: true, url: c.url }, { enableWorker: false, lazyLoad: false });
      p.on(mpegts.Events.ERROR, async (type, detail) => {
        if (!conv) return fatal(type === mpegts.ErrorTypes.MEDIA_ERROR ? 'codec' : 'offline', detail);
        // Video passed through as it was, and the player still couldn't decode it (some broadcasters'
        // HEVC): convert the picture too.
        if (type === mpegts.ErrorTypes.MEDIA_ERROR && conv.plan.video === 'copy' && token === playToken) {
          return playConverted(state.current, token, conv.streams, { video: 'encode' });
        }
        const st = await api.convertStatus(conv.id).catch(() => ({}));
        fatal('convert', st.error || detail);
      });
      p.attachMediaElement(video);
      p.load();
      autoplay();
      engine = {
        destroy: () => {
          p.pause();
          p.unload();
          p.detachMediaElement();
          p.destroy();
        },
        isLive: () => true,
      };
    } else {
      video.src = c.url;
      autoplay();
      engine = { destroy: () => {} };
    }
    engineKind = kind;
  }

  // The built-in engine sometimes drops a track it can't decode without saying so (AC-3 sound in an MP4,
  // MKV or HLS stream; ProRes or MPEG-2 pictures): the channel plays, silent or black. A moment after
  // it starts, a missing picture or sound is checked against what the stream really carries, and if
  // something is lost the channel switches to ffmpeg.
  const inspected = new Map(); // url -> streams, for this session
  function watchTracks(token) {
    const c = state.current;
    if (!c || converting || !canConvert) return;
    const at = video.currentTime;
    setTimeout(async () => {
      if (token !== playToken || converting || state.current !== c) return;
      if (!video.ended && (video.paused || video.currentTime - at < 1)) return; // stalled or paused: nothing to judge yet
      const noSound = typeof video.webkitAudioDecodedByteCount === 'number' && video.webkitAudioDecodedByteCount === 0;
      const noPicture = video.videoWidth === 0;
      if (!noSound && !noPicture) return;
      let streams = inspected.get(c.url); // what ffmpeg says the stream carries
      if (!streams) {
        streams = await api.convertInspect(c.url, c.headers || null).catch(() => []);
        inspected.set(c.url, streams);
      }
      if (token !== playToken || converting) return;
      const lost = (noSound && streams.some((s) => s.kind === 'audio')) || (noPicture && streams.some((s) => s.kind === 'video'));
      if (lost) playConverted(c, token, streams);
    }, 2200);
  }

  video.addEventListener('playing', () => {
    if (!started && state.current && converting && converting.streams) {
      routes.set(state.current.url, { streams: converting.streams, force: converting.force });
    }
    if (!started && state.current) {
      addRecent(state.current); // only channels that actually played
      watchTracks(playToken);
    }
    started = true;
    clearTimeout(startTimer);
    setOverlay('none');
    playerEl.classList.remove('paused');
    if (state.current) {
      const was = state.status[state.current.url];
      setStatus(state.current.url, 'ok');
      if (!was || was.s !== 'ok') renderRows();
    }
    scheduleHide();
  });
  video.addEventListener('waiting', () => { if ($('overlayError').hidden && state.current) setOverlay('loading'); });
  video.addEventListener('canplay', () => { if (!$('overlayLoading').hidden && !video.paused) setOverlay('none'); });
  video.addEventListener('pause', () => { playerEl.classList.add('paused'); showControls(); });
  video.addEventListener('play', () => playerEl.classList.remove('paused'));
  video.addEventListener('error', () => {
    if (engineKind !== 'native' || !video.error) return;
    fail(playToken, video.error.code === 2 ? 'offline' : 'codec', video.error.message);
  });
  // Live channels get a "Live" marker; recordings and films get a seek bar instead.
  const clock = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    const hh = Math.floor(sec / 3600);
    const mm = Math.floor((sec % 3600) / 60);
    const ss = String(sec % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  };
  function isLive() {
    const known = engine && engine.isLive ? engine.isLive() : null;
    return known === null || known === undefined ? !Number.isFinite(video.duration) : known;
  }
  function updateLiveInfo() {
    const info = $('liveInfo');
    info.textContent = '';
    const active = !!state.current && started;
    const live = active && isLive();
    playerEl.classList.toggle('vod', active && !live && Number.isFinite(video.duration) && video.duration > 0);
    if (!active) return;
    if (live) {
      info.appendChild(h('span', 'live-dot'));
      info.appendChild(h('span', '', 'Live'));
    }
    if (video.videoHeight) info.appendChild(h('span', '', `${video.videoHeight}p`));
    if (converting && converting.plan) {
      const pl = converting.plan;
      const tag = h('span', 'conv-tag', pl.video === 'encode' ? 'Converted' : pl.audio === 'encode' ? 'Audio converted' : 'Via ffmpeg');
      const names = { mpeg2video: 'MPEG-2', mpeg1video: 'MPEG-1', mpeg4: 'MPEG-4', ac3: 'AC-3', eac3: 'E-AC-3', mp2: 'MP2', dts: 'DTS' };
      const nice = (x) => names[x] || x.toUpperCase();
      tag.title = pl.why
        ? `${pl.why.replace(/(\w+) (video|audio)/g, (_, k, t) => `${nice(k)} ${t}`)} converted with ffmpeg; the rest plays as broadcast`
        : 'Played through ffmpeg';
      info.appendChild(tag);
    }
    updateSeek();
  }
  let seeking = false;
  function updateSeek() {
    if (!playerEl.classList.contains('vod')) return;
    const seek = $('seek');
    seek.max = video.duration;
    if (!seeking) seek.value = video.currentTime;
    $('timeLabel').textContent = `${clock(seeking ? Number(seek.value) : video.currentTime)} / ${clock(video.duration)}`;
  }
  for (const ev of ['playing', 'resize', 'durationchange']) video.addEventListener(ev, updateLiveInfo);
  video.addEventListener('timeupdate', updateSeek);
  $('seek').addEventListener('input', () => { seeking = true; updateSeek(); });
  $('seek').addEventListener('change', (e) => {
    seeking = false;
    video.currentTime = Number(e.target.value);
  });

  function togglePlay() {
    if (!state.current) return;
    if (!$('overlayError').hidden) return play(state.current);
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function step(delta) {
    const items = state.filtered;
    if (!items.length) return;
    let i = state.current ? items.findIndex((c) => c.url === state.current.url) : -1;
    if (i < 0) i = state.cursor >= 0 ? state.cursor - (delta > 0 ? 1 : 0) : delta > 0 ? -1 : items.length;
    const next = Math.min(items.length - 1, Math.max(0, i + delta));
    if (next === i) return;
    state.cursor = next;
    scrollToIndex(next);
    play(items[next]);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else playerEl.requestFullscreen().catch(() => {});
  }

  async function togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (state.current && started) await video.requestPictureInPicture();
    } catch (e) {
      toast('Picture in picture isn’t available for this stream.');
    }
  }

  // Volume
  function applyVolume() {
    video.volume = Math.min(1, Math.max(0, Number(state.settings.volume) || 0));
    video.muted = !!state.settings.muted;
    $('volume').value = video.muted ? 0 : video.volume;
    playerEl.classList.toggle('muted', video.muted || video.volume === 0);
  }
  $('volume').addEventListener('input', (e) => {
    state.settings.volume = Number(e.target.value);
    state.settings.muted = state.settings.volume === 0;
    applyVolume();
    persist({ settings: { volume: state.settings.volume, muted: state.settings.muted } });
  });
  function toggleMute() {
    state.settings.muted = !state.settings.muted;
    if (!state.settings.muted && !state.settings.volume) state.settings.volume = 0.5;
    applyVolume();
    persist({ settings: { volume: state.settings.volume, muted: state.settings.muted } });
  }

  // Controls fade out while a channel is playing and the pointer is still.
  let hideTimer = 0;
  function showControls() {
    playerEl.classList.remove('controls-hidden', 'hide-cursor');
    syncWindowButtons();
    scheduleHide();
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!started || video.paused || $('controls').matches(':hover') || $('controls').contains(document.activeElement)) return;
      playerEl.classList.add('controls-hidden', 'hide-cursor');
      syncWindowButtons();
    }, 2800);
  }
  playerEl.addEventListener('mousemove', showControls);
  playerEl.addEventListener('mouseleave', scheduleHide);

  let osdTimer = 0;
  function showOsd(text) {
    const o = $('osd');
    o.textContent = text;
    o.classList.add('show');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => o.classList.remove('show'), 2200);
  }

  $('btnPlay').addEventListener('click', togglePlay);
  $('btnPrev').addEventListener('click', () => step(-1));
  $('btnNext').addEventListener('click', () => step(1));
  $('btnMute').addEventListener('click', toggleMute);
  $('btnPip').addEventListener('click', togglePip);
  $('btnFull').addEventListener('click', toggleFullscreen);
  $('btnRetry').addEventListener('click', () => play(state.current));
  $('btnCopyUrl').addEventListener('click', async () => {
    if (!state.current) return;
    await api.copyText(state.current.url);
    toast('Stream address copied');
  });
  $('btnFav').addEventListener('click', () => toggleFavorite(state.current));
  // On the picture, a click pauses or plays, a double-click goes full screen, and pressing and moving
  // the pointer drags the whole window. Whether it was a click is decided when the button is released:
  // if the pointer travelled, it was a drag and playback is left alone.
  (() => {
    const THRESHOLD = 5; // px the pointer has to travel before it is a drag rather than a click
    let drag = null;
    const stopMoving = () => {
      playerEl.classList.remove('moving-window');
      drag = null;
    };
    video.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      drag = { id: e.pointerId, sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY, moving: false };
      if (!document.fullscreenElement) {
        try { video.setPointerCapture(e.pointerId); } catch (err) { /* not capturable: moves still arrive while over the video */ }
      }
    });
    video.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!(e.buttons & 1)) return stopMoving(); // released somewhere we didn't hear about
      const dx = e.screenX - drag.sx;
      const dy = e.screenY - drag.sy;
      if (!drag.moving) {
        if (Math.hypot(dx, dy) < THRESHOLD || document.fullscreenElement) return;
        drag.moving = true;
        playerEl.classList.add('moving-window');
      }
      api.moveWindow(drag.wx + dx, drag.wy + dy);
    });
    video.addEventListener('pointerup', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const wasClick = !drag.moving;
      stopMoving();
      if (wasClick) togglePlay();
    });
    video.addEventListener('pointercancel', stopMoving);
    video.addEventListener('dblclick', toggleFullscreen);
  })();
  $('btnPrev').title = `Previous channel (${MOD}↑)`;
  $('btnNext').title = `Next channel (${MOD}↓)`;

  /* ───────────────────────────── search, toolbar, keyboard ───────────────────────────── */

  let searchTimer = 0;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = e.target.value;
      state.cursor = -1;
      applyFilter(true);
    }, 90);
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && state.filtered.length) {
      e.preventDefault();
      state.cursor = Math.max(0, state.cursor);
      list.focus();
      renderRows();
    } else if (e.key === 'Enter' && state.filtered.length) {
      state.cursor = 0;
      play(state.filtered[0]);
    } else if (e.key === 'Escape' && e.target.value) {
      e.preventDefault();
      e.target.value = '';
      state.query = '';
      applyFilter(true);
    }
  });

  $('btnStopCheck').addEventListener('click', () => { if (state.checking) startCheck(); });
  $('btnMore').addEventListener('click', async () => {
    const hidden = state.hiddenOffline;
    const id = await api.popupMenu([
      { id: 'hide', label: hidden ? `Hide Offline Channels (${hidden.toLocaleString()} hidden)` : 'Hide Offline Channels', checked: !!state.settings.hideOffline },
      { id: 'check', label: state.checking ? 'Stop Checking Channels' : 'Check Which Channels Are Online', enabled: state.channels.length > 0 || !!state.checking },
      { type: 'separator' },
      { id: 'groups', label: state.hidden.size ? `Manage Groups… (${state.hidden.size.toLocaleString()} hidden)` : 'Manage Groups…', enabled: state.channels.length > 0 },
    ]);
    if (id === 'hide') setHideOffline(!state.settings.hideOffline);
    else if (id === 'check') startCheck();
    else if (id === 'groups') openGroupManager();
  });
  $('btnPlaylist').addEventListener('click', playlistMenu);
  $('btnImport').addEventListener('click', async () => {
    const p = activePlaylist();
    const id = await api.popupMenu([
      { id: 'file', label: p ? `Import M3U File into “${p.name}”…` : 'Import M3U File…' },
      { id: 'url', label: 'Import from URL…' },
      { id: 'xtream', label: 'Log In with Xtream Codes…' },
      { type: 'separator' },
      { id: 'new', label: 'New Playlist…' },
    ]);
    if (id === 'file') importFromPicker();
    else if (id === 'url') openUrlDialog();
    else if (id === 'xtream') openXtreamDialog();
    else if (id === 'new') newPlaylist();
  });
  $('btnWelcomeFile').addEventListener('click', importFromPicker);
  $('btnWelcomeUrl').addEventListener('click', openUrlDialog);
  $('btnWelcomeXtream').addEventListener('click', openXtreamDialog);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const typing = e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox';
    if (typing) return;
    const key = e.key.toLowerCase();
    if (key === ' ') {
      if (e.target instanceof HTMLButtonElement) return; // let the focused button act
      e.preventDefault();
      togglePlay();
    } else if (key === 'f') toggleFullscreen();
    else if (key === 'm') toggleMute();
    else if (key === '/') { e.preventDefault(); openSpot(); }
    else if (document.fullscreenElement && (key === 'arrowup' || key === 'arrowdown')) {
      e.preventDefault();
      step(key === 'arrowdown' ? 1 : -1);
    }
  });

  const MENU = {
    'new-playlist': newPlaylist,
    'open-file': importFromPicker,
    'add-url': openUrlDialog,
    xtream: openXtreamDialog,
    'xtream-refresh': () => refreshFromServer(activePlaylist()),
    'rename-playlist': () => renamePlaylist(activePlaylist()),
    'manage-groups': () => state.channels.length && openGroupManager(),
    find: () => { peek(true); $('search').focus(); $('search').select(); },
    'quick-search': openSpot,
    'sidebar-toggle': toggleSidebar,
    'sidebar-show': () => setSidebarMode('show'),
    'sidebar-auto': () => setSidebarMode('auto'),
    'sidebar-hide': () => setSidebarMode('hide'),
    check: startCheck,
    'toggle-hide-offline': () => setHideOffline(!state.settings.hideOffline),
    'play-pause': togglePlay,
    next: () => step(1),
    previous: () => step(-1),
    favorite: () => toggleFavorite(state.current),
    fullscreen: toggleFullscreen,
    pip: togglePip,
  };
  api.on('menu', (id) => {
    if (document.querySelector('dialog[open]')) return;
    if (MENU[id]) MENU[id]();
  });

  /* ───────────────────────────── files from outside ───────────────────────────── */

  // Files dropped on the window or opened from Finder / Explorer are imported into the open playlist.
  api.on('files:opened', importPaths);
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.type === 'm3u:dropped' && Array.isArray(e.data.paths)) importPaths(e.data.paths);
  });

  let dragDepth = 0;
  const draggingFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!draggingFiles(e)) return;
    dragDepth++;
    const p = activePlaylist();
    $('dropText').textContent = p ? `Drop to import into “${p.name}”` : 'Drop the playlist to import it';
    $('dropHint').hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!draggingFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropHint').hidden = true;
  });
  window.addEventListener('drop', () => {
    dragDepth = 0;
    $('dropHint').hidden = true;
  });

  api.on('theme:accent', (hex) => { state.accent = hex; applyAccent(hex); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAccent(state.accent));

  /* ───────────────────────────── start ───────────────────────────── */

  (async function start() {
    const init = await api.init();
    const s = init.state;
    state.playlists = s.playlists || [];
    state.favorites = s.favorites || [];
    state.recents = (s.recents || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    state.status = s.status || {};
    state.settings = { ...state.settings, ...(s.settings || {}) };
    state.accent = init.accent;
    for (const f of state.favorites) favUrls.add(f.url);

    applyAccent(init.accent);
    api.mediaCaps(CAN_PLAY_TS).then((r) => { canConvert = !!r.convert; }).catch(() => {});
    applyVolume();
    document.documentElement.classList.add('platform-' + init.platform);
    applySidebar();
    setSidebarWidth(state.settings.sidebarWidth || null, false);
    api.updateState().then(renderUpdate).catch(() => {});
    showShell();
    renderHeader();
    renderFilters();
    renderNow();
    renderCheck();

    const first = state.playlists.some((p) => p.id === s.activePlaylistId) ? s.activePlaylistId : state.playlists[0] && state.playlists[0].id;
    if (first) await openPlaylist(first);
    importPaths(init.files);
  })();
})();
