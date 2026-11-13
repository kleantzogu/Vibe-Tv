'use strict';
/*
 * Storage backend for Android (what a backend offers: lib/storage-node.js). The files are the same
 * JSON files as on a computer, kept in the app's private folder by the VibeFiles plugin
 * (android/app/src/main/java/com/vibetv/app/VibeFilesPlugin.kt), which writes each in one step.
 */
function nativeStorage(files) {
  return {
    join: (...parts) => parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/'),
    async read(file) {
      const r = await files.read({ path: file });
      if (r.missing || typeof r.data !== 'string') throw new Error('No such file: ' + file);
      return r.data;
    },
    async write(file, text) {
      await files.write({ path: file, data: String(text) });
    },
    async remove(file) {
      await files.remove({ path: file });
    },
  };
}

module.exports = { nativeStorage };
