'use strict';
/*
 * Reading a playlist file from disk, patiently.
 *
 * Files in iCloud Drive, OneDrive, Dropbox, Google Drive or on a network share can be listed in a
 * folder without their contents being on this computer. Reading one makes the system fetch it, and
 * that read can fail with ETIMEDOUT (or EDEADLK on macOS) while the download is still under way.
 * So: nudge the download, wait, and try again a few times before giving up.
 */
const fs = require('fs');
const { execFile } = require('child_process');

const NOT_READY = new Set(['ETIMEDOUT', 'EDEADLK', 'EAGAIN', 'EBUSY']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Asks iCloud Drive to download the file. Harmless for files that live anywhere else.
function nudgeDownload(file) {
  if (process.platform !== 'darwin') return;
  try {
    execFile('/usr/bin/brctl', ['download', file], { timeout: 15000 }, () => {});
  } catch (e) { /* best effort */ }
}

async function readFileRetry(file, opts = {}) {
  const { read = fs.promises.readFile, delays = [700, 1500, 3000, 5000, 8000], deadline = 40000, nudge = nudgeDownload, onWaiting } = opts;
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await read(file);
    } catch (e) {
      const wait = delays[attempt];
      if (!NOT_READY.has(e.code) || wait === undefined || Date.now() - started + wait > deadline) throw e;
      if (attempt === 0) {
        nudge(file);
        if (onWaiting) onWaiting();
      }
      await sleep(wait);
    }
  }
}

/** Human-readable reason: `short` fits in a sentence, `long` says what to do about it. */
function explainReadError(e, file, platform = process.platform) {
  const code = (e && e.code) || '';
  if (code === 'ENOENT') {
    return { short: 'the file was moved or deleted', long: `The file could not be found. It may have been moved or deleted:\n${file}` };
  }
  if (NOT_READY.has(code)) {
    const fix = platform === 'darwin'
      ? 'In Finder, right-click the file and choose “Download Now”, or move it to a folder that is not synced. Then try again.'
      : 'Make sure the file is downloaded to this computer, or copy it to a local folder. Then try again.';
    return {
      short: 'the file is in a cloud or network folder and is not downloaded',
      long: `The file did not arrive in time. It is most likely kept in iCloud Drive, another cloud folder or a network drive, and its contents are not on this computer yet.\n\n${fix}\n\n${file}`,
    };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    const fix = platform === 'darwin'
      ? 'Check System Settings ▸ Privacy & Security ▸ Files and Folders, or move the file to another folder.'
      : 'Check the permissions of the file, or move it to another folder.';
    return { short: 'this app is not allowed to read the file', long: `This app is not allowed to read the file. ${fix}\n\n${file}` };
  }
  if (code === 'EISDIR') return { short: 'that is a folder, not a file', long: `That is a folder, not a playlist file:\n${file}` };
  return { short: `the file could not be read (${code || (e && e.message)})`, long: `The file could not be read (${code || (e && e.message)}):\n${file}` };
}

module.exports = { readFileRetry, explainReadError, NOT_READY };
