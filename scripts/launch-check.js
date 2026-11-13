'use strict';
/*
 * `node scripts/launch-check.js <the packaged app's executable>`
 *
 * Starts a packaged build twice, each time with an empty data folder, and fails unless:
 *  1. it starts normally (the window comes up and the app reports in), and
 *  2. with a simulated broken start, the recovery window comes up and can look for a fix.
 * The Release workflow runs this before anything is published, so a release that can't start, or
 * that couldn't fix itself if it failed to, never reaches anyone.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) {
  console.error(`launch-check: no app at ${exe || '(none given)'}`);
  process.exit(2);
}

function launch(label, extraEnv) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-tv-check-'));
    const result = path.join(dir, 'result.txt');
    const args = process.platform === 'linux' ? ['--no-sandbox'] : [];
    const child = spawn(exe, args, {
      env: { ...process.env, VIBE_TV_SMOKE_TEST: '1', VIBE_TV_SMOKE_RESULT: result, VIBE_TV_USER_DATA: path.join(dir, 'data'), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('close', (code) => {
      clearTimeout(timer);
      let line = '';
      try { line = fs.readFileSync(result, 'utf8').trim(); } catch (e) { line = (out.match(/VIBE_TV_SMOKE_\w+.*/) || [''])[0]; }
      fs.rmSync(dir, { recursive: true, force: true });
      const ok = code === 0 && line.startsWith('VIBE_TV_SMOKE_OK');
      console.log(`${ok ? '✓' : '✗'} ${label}: ${line || `no result (exit ${code})`}`);
      if (!ok && out.trim()) console.log(out.trim().split('\n').slice(-15).map((l) => '    ' + l).join('\n'));
      resolve(ok);
    });
  });
}

(async () => {
  const normal = await launch('starts normally', {});
  const recovery = await launch('recovers from a broken start', { VIBE_TV_SIMULATE_CRASH: 'startup' });
  process.exit(normal && recovery ? 0 : 1);
})();
