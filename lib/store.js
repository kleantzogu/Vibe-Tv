'use strict';
/* Small JSON settings store with debounced, atomic writes. */
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, defaults) {
    this.file = file;
    this.data = structuredClone(defaults);
    this.timer = null;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved && typeof saved === 'object') {
        for (const key of Object.keys(defaults)) {
          if (saved[key] === undefined) continue;
          const def = defaults[key];
          const isPlainObject = def && typeof def === 'object' && !Array.isArray(def);
          this.data[key] = isPlainObject ? { ...def, ...saved[key] } : saved[key];
        }
      }
    } catch (e) {
      /* first run or unreadable file: start from defaults */
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Could not save settings:', e.message);
    }
  }
}

module.exports = { Store };
