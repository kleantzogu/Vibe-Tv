'use strict';
/*
 * `npm run release`: builds the installer for this computer and publishes it on GitHub Releases as
 * version vX.Y.Z (from package.json), together with the files the app's updater reads
 * (latest-mac.yml / latest.yml / latest-linux.yml). Installed copies then offer the update.
 *
 * Before building it checks that the tests pass and that every change is committed and pushed, so a
 * release always matches the code on GitHub. Bump "version" in package.json first.
 * Run it once on each system you release for (macOS, Windows, Linux); each adds its files to the
 * same release.
 */
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
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
const tags = run('git', ['ls-remote', '--tags', 'origin', `v${pkg.version}`]);
if (tags) console.log(`Note: v${pkg.version} already exists on GitHub; this system's files are added to it.\n`);

if (spawnSync('npm', ['test'], { cwd: root, stdio: 'inherit' }).status !== 0) fail('The tests failed.');

let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
if (!token) {
  try {
    token = run('gh', ['auth', 'token']);
  } catch (e) {
    fail('No GitHub token. Log in with `gh auth login`, or set GH_TOKEN.');
  }
}

const build = spawnSync('npx', ['electron-builder', '--publish', 'always'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, GH_TOKEN: token },
});
if (build.status !== 0) fail('The build or upload failed (see above).');

console.log(`\n✓ Published: https://github.com/kleantzogu/Vibe-Tv/releases/tag/v${pkg.version}`);
console.log('  Add release notes there; installed copies show them under "What’s new".\n');
