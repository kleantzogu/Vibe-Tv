'use strict';
/*
 * The decisions behind boot.js, kept free of Electron so they can be tested: whether to try starting
 * the app or go straight to recovery, and how to describe a failure without leaking private details.
 */

// After this many failed starts of the same version in a row, don't try again: recover instead.
const MAX_FAILED_STARTS = 2;

/**
 * @param {object} saved  what startup.json says about earlier starts: { version, failures, lastError }
 * @param {string} version  the version starting now
 * @param {boolean} forced  the person asked to try anyway ("Try again" in the recovery window)
 * @returns {{ recover: boolean, failures: number, lastError: string }}
 *   failures: how many starts in a row this version has failed, counting this one until it's healthy
 */
function decide(saved, version, forced) {
  const same = saved && saved.version === version;
  const before = same ? Number(saved.failures) || 0 : 0;
  const lastError = same ? String(saved.lastError || '') : '';
  if (!forced && before >= MAX_FAILED_STARTS) return { recover: true, failures: before, lastError };
  return { recover: false, failures: before + 1, lastError };
}

/**
 * An error made safe to show and share: home folders become ~, and web addresses (which for IPTV
 * often contain a username and password) become <address>.
 */
function sanitize(text, home) {
  let s = String(text || '');
  if (home) s = s.split(home).join('~');
  s = s
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, '~')
    .replace(/\/home\/[^/\s]+/g, '~')
    .replace(/\b(?:https?|rtmps?|rtsp|udp|rtp|srt|mms):\/\/[^\s'")]+/gi, '<address>');
  return s.slice(0, 4000);
}

/** A "new issue" link on GitHub, filled in with what went wrong. */
function issueUrl({ owner, repo }, { version, platform, arch, error }) {
  const title = `Vibe TV ${version} doesn't start (${platform})`;
  const body = [
    `**What happened:** Vibe TV ${version} couldn't start and opened its recovery window.`,
    '',
    `**System:** ${platform} ${arch}`,
    '',
    '**Details:**',
    '```',
    String(error || 'none').slice(0, 1500),
    '```',
  ].join('\n');
  return `https://github.com/${owner}/${repo}/issues/new?labels=bug&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

module.exports = { decide, sanitize, issueUrl, MAX_FAILED_STARTS };
