'use strict';
/*
 * `npm run release`: publishes version vX.Y.Z (from package.json) on GitHub Releases.
 *
 *  1. Checks that every change is committed and pushed and that the tests pass.
 *  2. Builds the macOS installer and update files, without publishing.
 *  3. Launch check (scripts/launch-check.js): the packaged app must start, and must recover from a
 *     simulated broken start. If either fails, nothing is tagged or published.
 *  4. Tags the commit and pushes the tag, which starts the Release workflow on GitHub: it builds,
 *     checks and adds the Windows and Linux installers the same way.
 *  5. Creates the release and uploads the macOS files (installer, zip, latest-mac.yml).
 * Installed copies then offer the update. Bump "version" in package.json first; run it on a Mac.
 */
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const { owner, repo } = pkg.build.publish[0]; // publish to the repository in package.json (a fork: its own)
const slug = `${owner}/${repo}`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts }).trim();
const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

console.log(`Releasing Vibe TV ${pkg.version}\n`);

if (run('git', ['status', '--porcelain'])) fail('There are uncommitted changes. Commit (and push) them first.');
run('git', ['fetch', '--quiet', 'origin']);
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (run('git', ['rev-parse', 'HEAD']) !== run('git', ['rev-parse', `origin/${branch}`])) {
  fail(`This branch isn't the same as origin/${branch}. Push (or pull) first.`);
}
if (spawnSync('npm', ['test'], { cwd: root, stdio: 'inherit' }).status !== 0) fail('The tests failed.');

// Build without publishing, then prove the packaged app starts (and can recover) before anyone gets it.
const fs = require('fs');
const dist = path.join(root, 'dist');
fs.rmSync(path.join(dist, 'mac-arm64'), { recursive: true, force: true });
fs.rmSync(path.join(dist, 'mac'), { recursive: true, force: true });
let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
if (!token) {
  try {
    token = run('gh', ['auth', 'token']);
  } catch (e) {
    fail('No GitHub token. Log in with `gh auth login`, or set GH_TOKEN.');
  }
}
const env = { ...process.env, GH_TOKEN: token };

if (spawnSync('npx', ['electron-builder', '--publish', 'never'], { cwd: root, stdio: 'inherit' }).status !== 0) fail('The build failed (see above).');
const appDir = ['mac-arm64', 'mac', 'mac-universal'].map((d) => path.join(dist, d)).find((d) => fs.existsSync(d));
const appBundle = appDir && fs.readdirSync(appDir).find((f) => f.endsWith('.app'));
if (!appBundle) fail('The built app was not found in dist/.');
const exe = path.join(appDir, appBundle, 'Contents', 'MacOS', pkg.productName);
console.log('\nLaunch check:');
if (spawnSync(process.execPath, [path.join(__dirname, 'launch-check.js'), exe], { cwd: root, stdio: 'inherit' }).status !== 0) {
  fail('The launch check failed, so nothing was published. Fix it and run npm run release again.');
}
const files = fs.readdirSync(dist)
  .filter((f) => (f.includes(`-${pkg.version}-`) || f === 'latest-mac.yml') && /\.(dmg|zip|blockmap|yml)$/.test(f))
  .map((f) => path.join(dist, f));
if (!files.some((f) => f.endsWith('latest-mac.yml')) || !files.some((f) => f.endsWith('.zip'))) fail('The update files were not built.');

// GitHub only publishes a release for a tag that exists, so tag this commit vX.Y.Z (once).
const tag = `v${pkg.version}`;
const remoteTag = run('git', ['ls-remote', '--tags', 'origin', tag]);
if (remoteTag) {
  const head = run('git', ['rev-parse', 'HEAD']);
  const peeled = run('git', ['ls-remote', 'origin', `${tag}^{}`]).split(/\s+/)[0] || remoteTag.split(/\s+/)[0];
  if (peeled !== head) fail(`${tag} already exists on GitHub for another commit. Raise the version in package.json.`);
  console.log(`\n${tag} already exists for this commit; adding the macOS files to its release.`);
} else {
  run('git', ['tag', tag]);
  run('git', ['push', 'origin', tag]);
  console.log(`\nTagged this commit ${tag} (the Release workflow now builds Windows and Linux).`);
}

const hasRelease = spawnSync('gh', ['release', 'view', tag, '-R', slug], { cwd: root, stdio: 'ignore', env }).status === 0;
if (!hasRelease) {
  try {
    run('gh', ['release', 'create', tag, '-R', slug, '--verify-tag', '--title', `Vibe TV ${pkg.version}`, '--notes', `Vibe TV ${pkg.version}`], { env });
  } catch (e) {
    // The Release workflow (started by the tag) may have made it a moment earlier: that's fine.
    if (spawnSync('gh', ['release', 'view', tag, '-R', slug], { stdio: 'ignore', env }).status !== 0) throw e;
  }
}
if (spawnSync('gh', ['release', 'upload', tag, '-R', slug, '--clobber', ...files], { cwd: root, stdio: 'inherit', env }).status !== 0) {
  fail('Uploading the macOS files failed (see above).');
}

console.log(`\n✓ Published: https://github.com/${slug}/releases/tag/${tag}`);
for (const f of files) console.log('    ' + path.basename(f));
console.log('  Add release notes there; installed copies show them under "What’s new".\n');
