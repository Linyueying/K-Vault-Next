const { createClient } = require('redis');

function serializeValue(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function deserializeValue(rawValue) {
  if (typeof rawValue !== 'string') return null;
  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class RedisSettingsStore {
  constructor(config) {
    this.redisUrl = config.settingsRedisUrl;
    this.redisPrefix = config.settingsRedisPrefix || 'k-vault';
    this.connectTimeoutMs = Math.max(1000, Number(config.settingsRedisConnectTimeoutMs || 5000));
    this.hashKey = `${this.redisPrefix}:app_settings`;

    if (!this.redisUrl) {
      throw new Error('SETTINGS_STORE=redis requires SETTINGS_REDIS_URL (or REDIS_URL).');
    }

    this.client = createClient({
      url: this.redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries >= 5) {
            return false;
          }
          return Math.min((retries + 1) * 200, 1000);
        },
      },
    });
    this.connectPromise = null;

    this.client.on('error', (error) => {
      console.error('[settings:redis] client error:', error.message || error);
    });
  }

  async ensureConnected() {
    if (this.client.isReady) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect()
        .catch((error) => {
          this.connectPromise = null;
          throw error;
        });
    }
    try {
      await withTimeout(
        this.connectPromise,
        this.connectTimeoutMs,
        `Redis connect timeout (${this.connectTimeoutMs}ms)`
      );
    } catch (error) {
      if (!this.client.isReady) {
        this.connectPromise = null;
      }
      throw error;
    }
  }

  async getAll() {
    await this.ensureConnected();
    const values = await this.client.hGetAll(this.hashKey);
    const output = {};
    for (const [key, rawValue] of Object.entries(values || {})) {
      output[key] = deserializeValue(rawValue);
    }
    return output;
  }

  async getMany(keys = []) {
    if (!Array.isArray(keys) || keys.length === 0) {
      return {};
    }

    await this.ensureConnected();
    const normalizedKeys = keys
      .map((key) => String(key || '').trim())
      .filter(Boolean);

    if (normalizedKeys.length === 0) {
      return {};
    }

    const rawValues = await this.client.hmGet(this.hashKey, normalizedKeys);
    const output = {};
    normalizedKeys.forEach((key, index) => {
      const rawValue = rawValues[index];
      if (rawValue == null) return;
      output[key] = deserializeValue(rawValue);
    });

    return output;
  }

  async setMany(values = {}) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return;
    }

    const payload = {};
    for (const [rawKey, value] of Object.entries(values)) {
      const key = String(rawKey || '').trim();
      if (!key) continue;
      payload[key] = serializeValue(value);
    }

    if (Object.keys(payload).length === 0) {
      return;
    }

    await this.ensureConnected();
    await this.client.hSet(this.hashKey, payload);
  }

  async deleteMany(keys = []) {
    if (!Array.isArray(keys) || keys.length === 0) {
      return;
    }

    const normalizedKeys = keys
      .map((key) => String(key || '').trim())
      .filter(Boolean);
    if (normalizedKeys.length === 0) {
      return;
    }

    await this.ensureConnected();
    await this.client.hDel(this.hashKey, ...normalizedKeys);
  }

  async healthCheck() {
    try {
      await this.ensureConnected();
      const pong = await withTimeout(
        this.client.ping(),
        this.connectTimeoutMs,
        `Redis ping timeout (${this.connectTimeoutMs}ms)`
      );
      return {
        backend: 'redis',
        connected: pong === 'PONG',
        message: pong === 'PONG' ? 'Redis settings store connected' : `Redis ping result: ${pong}`,
      };
    } catch (error) {
      return {
        backend: 'redis',
        connected: false,
        message: `Redis unavailable: ${error.message}`,
      };
    }
  }

  async close() {
    if (this.client?.isOpen) {
      await this.client.quit().catch(() => {});
    }
  }
}

module.exports = {
  RedisSettingsStore,
};
