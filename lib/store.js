'use strict';
/*
 * Small JSON settings store with debounced, atomic writes.
 * The file itself is read and written by a storage backend (storage-node.js on a computer).
 */

class Store {
  /**
   * With a backend that can read right away (a computer), the saved settings are loaded here.
   * With one that cannot, use `await Store.open(...)`.
   */
  constructor(file, defaults, storage) {
    this.file = file;
    this.storage = storage;
    this.defaults = defaults;
    this.data = JSON.parse(JSON.stringify(defaults)); // not structuredClone: older Android WebViews lack it
    this.timer = null;
    if (storage.readSync) {
      try {
        this.apply(storage.readSync(file));
      } catch (e) {
        /* first run or unreadable file: start from defaults */
      }
    }
  }

  static async open(file, defaults, storage) {
    const store = new Store(file, defaults, storage);
    if (!storage.readSync) {
      try {
        store.apply(await storage.read(file));
      } catch (e) {
        /* first run or unreadable file: start from defaults */
      }
    }
    return store;
  }

  apply(text) {
    const saved = JSON.parse(text);
    if (!saved || typeof saved !== 'object') return;
    for (const key of Object.keys(this.defaults)) {
      if (saved[key] === undefined) continue;
      const def = this.defaults[key];
      const isPlainObject = def && typeof def === 'object' && !Array.isArray(def);
      this.data[key] = isPlainObject ? { ...def, ...saved[key] } : saved[key];
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const failed = (e) => console.error('Could not save settings:', e.message);
    try {
      const text = JSON.stringify(this.data);
      if (this.storage.writeSync) this.storage.writeSync(this.file, text);
      else this.storage.write(this.file, text).catch(failed);
    } catch (e) {
      failed(e);
    }
  }
}

module.exports = { Store };
