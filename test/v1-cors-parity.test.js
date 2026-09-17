const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { createApp } = require('../server/app');

describe('API v1 CORS allow-list (Docker)', function () {
  const originalEnv = { ...process.env };
  let tmpDir;

  beforeEach(function () {
    tmpDir = path.join(__dirname, '..', 'data', `tmp-cors-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    process.env.CONFIG_ENCRYPTION_KEY = 'cors_key_123456';
    process.env.SESSION_SECRET = 'cors_secret_123456';
    process.env.DATA_DIR = tmpDir;
    process.env.DB_PATH = path.join(tmpDir, 'cors.db');
    process.env.BASIC_USER = '';
    process.env.BASIC_PASS = '';
    process.env.TG_BOT_TOKEN = '';
    process.env.TG_CHAT_ID = '';
    process.env.DEFAULT_STORAGE_TYPE = 'telegram';
    process.env.API_CORS_ORIGINS = 'https://app.example.com, https://blog.example.org/';
  });

  afterEach(function () {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  it('answers OPTIONS preflight with 204 and no ACAO for unknown origins', async function () {
    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/api/v1/upload', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.net',
        'Access-Control-Request-Method': 'POST',
      },
    }));
    assert.strictEqual(response.status, 204);
    assert.strictEqual(response.headers.get('access-control-allow-origin'), null);
    assert.ok(String(response.headers.get('vary') || '').includes('Origin'));
  });

  it('echoes allow-listed origins on preflight and permits Idempotency-Key header', async function () {
    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/api/v1/upload', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Idempotency-Key',
      },
    }));
    assert.strictEqual(response.status, 204);
    assert.strictEqual(response.headers.get('access-control-allow-origin'), 'https://app.example.com');
    assert.strictEqual(response.headers.get('access-control-allow-credentials'), 'true');
    assert.ok(String(response.headers.get('access-control-allow-headers') || '').includes('Idempotency-Key'));
  });

  it('normalizes trailing slashes from API_CORS_ORIGINS entries on real responses', async function () {
    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/api/v1/capabilities', {
      headers: { Origin: 'https://blog.example.org' },
    }));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('access-control-allow-origin'), 'https://blog.example.org');
  });

  it('never adds CORS headers for non-listed origins on real responses', async function () {
    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/api/v1/capabilities', {
      headers: { Origin: 'https://evil.example.net' },
    }));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('access-control-allow-origin'), null);
  });
});
