'use strict';
/*
 * Runs JavaScript inside the Android app's WebView on an emulator or a phone, through Chrome's
 * remote debugging (debug builds allow it). Handy for trying `window.api` by hand and for checks:
 *
 *   node test/android/webview.js <adb serial> <free local port> '<body of an async function>'
 *   node test/android/webview.js emulator-5554 9301 'return (await api.init()).state.playlists'
 */
const { execFileSync } = require('child_process');
const [serial, port, body] = process.argv.slice(2);
const adb = (...a) => execFileSync('adb', ['-s', serial, ...a], { encoding: 'utf8' });

(async () => {
  const pid = adb('shell', 'pidof', 'com.vibetv.app').trim();
  if (!pid) throw new Error('the app is not running');
  adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find((p) => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not connect to the WebView')); });
  const reply = new Promise((resolve) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d); }; });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true } }));
  const d = await reply;
  ws.close();
  const r = d.result || {};
  if (r.exceptionDetails) { console.log('ERROR', JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); process.exit(1); }
  console.log(JSON.stringify(r.result && r.result.value, null, 1));
})().catch((e) => { console.log('ERROR', e.message); process.exit(1); });
