'use strict';
/*
 * Plays every test stream in the Android app, one after the other, and prints what happened.
 *
 *   node test/android/streams.js                      (leave it running)
 *   node test/android/playback-check.js emulator-5554  (the app must be open on that device)
 *
 * It works the app as a person would: types the channel's name in the search field, taps the first
 * result and watches the player for up to 25 seconds.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const { CHANNELS } = require('./streams');

const serial = process.argv[2] || 'emulator-5554';
const port = String(9400 + Math.floor(Math.random() * 400));
const inApp = (body) => {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'webview.js'), serial, port, body], { encoding: 'utf8' });
  if (out.startsWith('ERROR')) throw new Error(out);
  return JSON.parse(out);
};

const IMPORT = `
  const st = (await api.init()).state;
  for (const p of st.playlists) if (p.name === 'test') await api.removePlaylist(p.id);
  const r = await api.importUrl('', 'http://10.0.2.2:8123/test.m3u');
  api.patchState({ activePlaylistId: r.playlist.id });
  location.reload();
  return r.added;`;

const PLAY = (name) => `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const input = document.querySelector('.search input');
  input.value = ${JSON.stringify(name)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  let row = null;
  for (let i = 0; i < 40 && !row; i++) { await sleep(50); row = [...document.querySelectorAll('.row')].find((r) => r.textContent.includes(${JSON.stringify(name)})); }
  if (!row) return { result: 'not in the list' };
  row.click();
  const video = document.getElementById('video');
  const t0 = performance.now();
  let result = 'did not start in 25 s';
  while (performance.now() - t0 < 25000) {
    await sleep(250);
    if (!document.getElementById('overlayError').hidden) { result = 'error: ' + document.getElementById('errorTitle').textContent; break; }
    if (video.currentTime > 1.5 && !video.paused) { result = 'plays'; break; }
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  await sleep(1500);
  const sound = typeof video.webkitAudioDecodedByteCount === 'number' ? video.webkitAudioDecodedByteCount > 0 : video.hasSound;
  return {
    result, secs,
    picture: video.videoWidth ? video.videoWidth + 'x' + video.videoHeight : 'none',
    sound: result === 'plays' ? (sound === undefined ? '?' : sound ? 'yes' : 'NO') : '',
    detail: document.getElementById('overlayError').hidden
      ? [document.getElementById('liveInfo').textContent, (document.querySelector('.native-note') || {}).textContent].filter(Boolean).join(' · ')
      : (document.getElementById('errorDetail').title || document.getElementById('errorDetail').textContent).slice(0, 90),
  };`;

console.log(`${inApp(IMPORT)} test channels imported on ${serial}`);
execFileSync('sleep', ['5']);
const rows = [];
for (const [name] of CHANNELS) {
  const r = inApp(PLAY(name));
  rows.push({ channel: name, ...r });
  console.log(`${r.result.padEnd(24)} ${String(r.secs || '').padStart(5)}s  picture ${String(r.picture).padEnd(8)} sound ${String(r.sound).padEnd(3)}  ${name}${r.detail ? '  [' + r.detail + ']' : ''}`);
}
console.log('\n' + JSON.stringify(rows));
