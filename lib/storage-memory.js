'use strict';
/*
 * A storage backend (see storage-node.js) that keeps everything in memory. Nothing survives a
 * restart: it is for the checks, and for a platform that has no real storage wired up yet.
 */
function memoryStorage(files = new Map()) {
  return {
    files,
    join: (...parts) => parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/'),
    async read(file) {
      if (!files.has(file)) throw new Error('No such file: ' + file);
      return files.get(file);
    },
    async write(file, text) {
      files.set(file, String(text));
    },
    async remove(file) {
      files.delete(file);
    },
  };
}

module.exports = { memoryStorage };
