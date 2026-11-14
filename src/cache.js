'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Small two-level cache: in-memory LRU + files on disk.
// On free hosts the disk is usually wiped on restart; that's fine.
class Cache {
  constructor({ dir = process.env.CACHE_DIR || path.join(os.tmpdir(), 'gemini-subtitle-cache'), maxItems = 100 } = {}) {
    this.dir = dir;
    this.maxItems = maxItems;
    this.mem = new Map();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (_) {
      this.dir = null;
    }
  }

  _remember(key, value) {
    this.mem.delete(key);
    this.mem.set(key, value);
    while (this.mem.size > this.maxItems) this.mem.delete(this.mem.keys().next().value);
  }

  async get(key) {
    if (this.mem.has(key)) {
      const v = this.mem.get(key);
      this._remember(key, v);
      return v;
    }
    if (!this.dir) return null;
    try {
      const v = await fs.promises.readFile(path.join(this.dir, `${key}.srt`), 'utf8');
      this._remember(key, v);
      return v;
    } catch (_) {
      return null;
    }
  }

  async set(key, value) {
    this._remember(key, value);
    if (!this.dir) return;
    try {
      await fs.promises.writeFile(path.join(this.dir, `${key}.srt`), value, 'utf8');
    } catch (_) {
      /* disk full or read-only: memory cache still works */
    }
  }
}

module.exports = { Cache };
