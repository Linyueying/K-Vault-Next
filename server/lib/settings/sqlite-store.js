const { all, get, run } = require('../../db');

function serializeValue(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function deserializeValue(valueJson) {
  if (typeof valueJson !== 'string') return null;
  try {
    return JSON.parse(valueJson);
  } catch {
    return valueJson;
  }
}

class SqliteSettingsStore {
  constructor(db) {
    this.db = db;
  }

  async getAll() {
    const rows = all(this.db, 'SELECT key, value_json FROM app_settings');
    const output = {};
    for (const row of rows) {
      output[row.key] = deserializeValue(row.value_json);
    }
    return output;
  }

  async getMany(keys = []) {
    if (!Array.isArray(keys) || keys.length === 0) {
      return {};
    }

    const result = {};
    for (const key of keys) {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey) continue;
      const row = get(this.db, 'SELECT value_json FROM app_settings WHERE key = ?', [normalizedKey]);
      if (row) {
        result[normalizedKey] = deserializeValue(row.value_json);
      }
    }
    return result;
  }

  async setMany(values = {}) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return;
    }

    const now = Date.now();
    for (const [rawKey, value] of Object.entries(values)) {
      const key = String(rawKey || '').trim();
      if (!key) continue;

      run(
        this.db,
        `INSERT INTO app_settings(key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
        [key, serializeValue(value), now]
      );
    }
  }

  async deleteMany(keys = []) {
    if (!Array.isArray(keys) || keys.length === 0) {
      return;
    }

    for (const rawKey of keys) {
      const key = String(rawKey || '').trim();
      if (!key) continue;
      run(this.db, 'DELETE FROM app_settings WHERE key = ?', [key]);
    }
  }

  async healthCheck() {
    return {
      backend: 'sqlite',
      connected: true,
      message: 'SQLite app settings store enabled',
    };
  }

  async close() {}
}

module.exports = {
  SqliteSettingsStore,
};
