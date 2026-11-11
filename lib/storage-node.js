'use strict';
/*
 * Where the app keeps its JSON files, on a computer: plain files, written atomically (a temporary
 * file renamed into place). Store, Library and ChannelDb take one of these instead of using `fs`
 * themselves, so the same code runs on Android with another backend (see platform/android/).
 *
 * A storage backend has:
 *   join(...parts)        -> the name of a file inside a folder
 *   read(file)            -> Promise<string>, rejects when the file is not there
 *   write(file, text)     -> Promise, replaces the file in one step
 *   remove(file)          -> Promise, a missing file is not an error
 *   readSync / writeSync  -> the same, right away. Optional: only this backend has them. They are for
 *                            settings, which are read before the window opens and saved while quitting.
 */
const fs = require('fs');
const path = require('path');

const join = (...parts) => path.join(...parts);

function readSync(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeSync(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function read(file) {
  return fs.promises.readFile(file, 'utf8');
}

async function write(file, text) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.promises.writeFile(tmp, text);
  await fs.promises.rename(tmp, file);
}

async function remove(file) {
  await fs.promises.unlink(file).catch(() => {});
}

module.exports = { join, read, write, remove, readSync, writeSync };
