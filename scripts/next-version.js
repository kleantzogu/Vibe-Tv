'use strict';
/*
 * The version the Release workflow gives a merge to main: one more than the newest release
 * (v1.2.3 -> 1.2.4). "version" in package.json is the lowest the next release may be, so a pull
 * request that raises it to 1.3.0 makes the next release 1.3.0. A commit that already has a
 * version tag keeps it, so running the workflow again doesn't skip a number.
 *
 * `node scripts/next-version.js` prints `version=1.2.4` and `tag=v1.2.4` for $GITHUB_OUTPUT.
 */

const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? m.slice(1).map(Number) : null;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const newest = (list) => list.map(parse).filter(Boolean).sort(compare).pop() || null;

/**
 * @param {string[]} tags      every tag of the repository (others than vX.Y.Z are ignored)
 * @param {string} current     "version" in package.json
 * @param {string[]} headTags  the tags of the commit being released
 */
function nextVersion(tags, current, headTags = []) {
  const own = newest(headTags);
  if (own) return own.join('.');
  const floor = parse(current);
  if (!floor) throw new Error(`"version" in package.json is not like 1.2.3: ${current}`);
  const latest = newest(tags);
  if (!latest || compare(floor, latest) > 0) return floor.join('.');
  return [latest[0], latest[1], latest[2] + 1].join('.');
}

if (require.main === module) {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const { version } = require(path.join(__dirname, '..', 'package.json'));
  const next = nextVersion(git('tag', '--list', 'v*'), version, git('tag', '--points-at', 'HEAD', '--list', 'v*'));
  process.stdout.write(`version=${next}\ntag=v${next}\n`);
}

module.exports = { nextVersion };
