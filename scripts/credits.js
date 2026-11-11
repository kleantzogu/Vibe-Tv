'use strict';
/*
 * `npm run credits`: writes src/credits.json, the list the app shows in Acknowledgements: every
 * open-source component that ships inside Vibe TV, with its version, license (and the license text),
 * what it does here, and where its source lives.
 *
 * It is built from what is actually installed: the libraries in src/vendor/, the npm packages that go
 * into the app (dependencies, not devDependencies), and Electron. `npm test` checks the file is up to
 * date, so a release can't ship with a stale list. Electron, Chromium, Node.js and FFmpeg versions are
 * filled in by the running app, which knows them exactly.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
// Line endings are normalised: Git on Windows checks text files out with CRLF.
const lf = (s) => s.replace(/\r\n?/g, '\n');
const read = (p) => lf(fs.readFileSync(path.join(root, p), 'utf8'));
const exists = (p) => fs.existsSync(path.join(root, p));

function licenseText(dir) {
  const full = path.join(root, dir);
  const file = fs.readdirSync(full).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  return file ? lf(fs.readFileSync(path.join(full, file), 'utf8')).trim() : '';
}

const repoUrl = (pkg) => {
  const r = pkg.repository;
  let url = typeof r === 'string' ? r : r && r.url;
  if (!url) return pkg.homepage || `https://www.npmjs.com/package/${pkg.name}`;
  url = url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');
  if (/^github:/.test(url)) url = 'https://github.com/' + url.slice(7);
  if (/^[\w-]+\/[\w.-]+$/.test(url)) url = 'https://github.com/' + url;
  return url;
};

// The vendored players, with their versions as built into the files.
function vendor(name, file, licenseFile, re, license, url, purpose) {
  const m = re.exec(read(file));
  return { name, version: m ? m[1] : '', license, url, purpose, text: read(licenseFile).trim() };
}

function npmPackages() {
  let out0;
  try {
    out0 = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
  } catch (e) {
    out0 = e.stdout; // npm ls exits with an error for harmless warnings; the tree is still printed
  }
  const tree = JSON.parse(out0);
  const direct = Object.keys(tree.dependencies || {});
  const usedBy = new Map(); // name -> Set of direct dependencies that pull it in
  const versions = new Map();
  const walk = (deps, top) => {
    for (const [name, info] of Object.entries(deps || {})) {
      if (!info || !info.version) continue;
      versions.set(name, info.version);
      if (top !== name) {
        if (!usedBy.has(name)) usedBy.set(name, new Set());
        usedBy.get(name).add(top);
      }
      walk(info.dependencies, top);
    }
  };
  for (const name of direct) walk({ [name]: tree.dependencies[name] }, name);
  const out = [];
  for (const [name, version] of [...versions].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dir = `node_modules/${name}`;
    if (!exists(dir)) continue;
    const pkg = JSON.parse(read(`${dir}/package.json`));
    out.push({
      name,
      version,
      license: typeof pkg.license === 'string' ? pkg.license : (pkg.license && pkg.license.type) || 'See license text',
      url: repoUrl(pkg),
      direct: direct.includes(name),
      usedBy: usedBy.has(name) ? [...usedBy.get(name)].sort() : [],
      text: licenseText(dir),
    });
  }
  return out;
}

function build() {
  const pkgs = npmPackages();
  const take = (name) => pkgs.find((p) => p.name === name);
  const updater = take('electron-updater');
  const ffmpegStatic = take('ffmpeg-static');
  const electronPkg = JSON.parse(read('node_modules/electron/package.json'));

  return {
    app: {
      name: 'Vibe TV',
      license: 'MIT',
      url: 'https://github.com/kleantzogu/Vibe-Tv',
      text: read('LICENSE').trim(),
    },
    sections: [
      {
        title: 'Playback',
        items: [
          vendor('hls.js', 'src/vendor/hls.min.js', 'src/vendor/hls.LICENSE.txt', /version["' :=]+(\d+\.\d+\.\d+)/, 'Apache-2.0', 'https://github.com/video-dev/hls.js', 'Plays HLS (.m3u8) streams'),
          vendor('mpegts.js', 'src/vendor/mpegts.js', 'src/vendor/mpegts.LICENSE.txt', /"(1\.\d+\.\d+)"/, 'Apache-2.0', 'https://github.com/xqq/mpegts.js', 'Plays MPEG-TS and FLV streams'),
          vendor('dash.js', 'src/vendor/dash.mediaplayer.min.js', 'src/vendor/dash.LICENSE.md', /"(5\.\d+\.\d+)"/, 'BSD-3-Clause', 'https://github.com/Dash-Industry-Forum/dash.js', 'Plays MPEG-DASH (.mpd) streams'),
        ],
      },
      {
        title: 'Conversion',
        items: [
          {
            id: 'ffmpeg',
            name: 'FFmpeg',
            version: '', // the running app asks ffmpeg
            license: 'GPL', // the running app reads it from ffmpeg's build settings
            url: 'https://ffmpeg.org',
            source: 'https://ffmpeg.org/download.html',
            purpose: 'Converts video and sound the player can’t decode (MPEG-2, AC-3, MP2, DTS…) and opens rtmp://, rtsp:// and udp:// streams. It runs as a separate program.',
            text: '', // the running app reads the license file shipped next to its ffmpeg
          },
          { ...ffmpegStatic, purpose: 'Provides the FFmpeg build included with the app' },
        ],
      },
      {
        title: 'App framework',
        items: [
          {
            id: 'electron',
            name: 'Electron',
            version: electronPkg.version,
            license: 'MIT',
            url: 'https://github.com/electron/electron',
            purpose: 'Runs Vibe TV as a desktop app on macOS, Windows and Linux',
            text: read('node_modules/electron/LICENSE').trim(),
          },
          {
            id: 'chromium',
            name: 'Chromium',
            version: '',
            license: 'BSD-3-Clause and others',
            url: 'https://www.chromium.org',
            licenseUrl: 'https://chromium.googlesource.com/chromium/src/+/main/LICENSE',
            purpose: 'The browser engine inside Electron: the window, the video player and the network. It includes many other open-source components, listed in its license file.',
            text: '',
          },
          {
            id: 'node',
            name: 'Node.js',
            version: '',
            license: 'MIT',
            url: 'https://nodejs.org',
            licenseUrl: 'https://github.com/nodejs/node/blob/main/LICENSE',
            purpose: 'Runs the app’s own code outside the window: files, playlists, updates',
            text: '',
          },
        ],
      },
      {
        title: 'Updates',
        items: [{ ...updater, purpose: 'Checks GitHub for new versions and installs them' }],
      },
      {
        title: 'Data',
        items: [
          {
            name: 'iptv-org',
            version: '',
            license: 'See their repository',
            url: 'https://github.com/iptv-org/database',
            purpose: 'Logos and categories for channels that only carry a tvg-id, from the public iptv-org database',
            text: '',
          },
        ],
      },
      {
        title: 'Supporting libraries',
        collapsed: true,
        items: pkgs
          .filter((p) => !p.direct)
          .map((p) => ({ ...p, purpose: `Used by ${p.usedBy.join(' and ')}` })),
      },
    ].map((s) => ({ ...s, items: s.items.map(({ direct, usedBy, ...item }) => item) })),
  };
}

const file = path.join(root, 'src', 'credits.json');
const json = JSON.stringify(build(), null, 1) + '\n';
if (process.argv.includes('--check')) {
  if (!fs.existsSync(file) || lf(fs.readFileSync(file, 'utf8')) !== json) {
    console.error('src/credits.json is out of date: run `npm run credits` and commit it.');
    process.exit(1);
  }
} else {
  fs.writeFileSync(file, json);
  const data = JSON.parse(json);
  console.log(`Wrote src/credits.json: ${data.sections.reduce((n, s) => n + s.items.length, 0)} components.`);
}

