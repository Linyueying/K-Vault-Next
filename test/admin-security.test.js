const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { createApp } = require('../server/app');

describe('Admin API fail-closed security (Docker)', function () {
  const originalEnv = { ...process.env };
  let tmpDir;

  beforeEach(function () {
    tmpDir = path.join(__dirname, '..', 'data', `tmp-admin-sec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    process.env.CONFIG_ENCRYPTION_KEY = 'admin_sec_key_123456';
    process.env.SESSION_SECRET = 'admin_sec_secret_123456';
    process.env.DATA_DIR = tmpDir;
    process.env.DB_PATH = path.join(tmpDir, 'admin-sec.db');
    process.env.BASIC_USER = '';
    process.env.BASIC_PASS = '';
    process.env.TG_BOT_TOKEN = '';
    process.env.TG_CHAT_ID = '';
    process.env.DEFAULT_STORAGE_TYPE = 'telegram';
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

  const adminRoutes = [
    ['GET', '/api/admin/tokens', null],
    ['POST', '/api/admin/tokens', JSON.stringify({ name: 'x', scopes: ['read'] })],
    ['PATCH', '/api/admin/tokens/some-id', JSON.stringify({ enabled: false })],
    ['DELETE', '/api/admin/tokens/some-id', null],
    ['POST', '/api/admin/tokens/some-id/rotate', null],
    ['GET', '/api/admin/audit-logs', null],
  ];

  it('returns 503 ADMIN_AUTH_NOT_CONFIGURED on every admin route when auth is unconfigured', async function () {
    const app = createApp();
    for (const [method, url, body] of adminRoutes) {
      const response = await app.fetch(new Request(`http://localhost${url}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body || undefined,
      }));
      const payload = await response.json();
      assert.strictEqual(response.status, 503, `${method} ${url} -> ${response.status}`);
      assert.strictEqual(payload.error?.code, 'ADMIN_AUTH_NOT_CONFIGURED', `${method} ${url}`);
    }
  });

  it('returns 401 when auth is configured but credentials are missing', async function () {
    process.env.BASIC_USER = 'admin';
    process.env.BASIC_PASS = 'secret123';
    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/api/admin/tokens'));
    assert.strictEqual(response.status, 401);
  });

  it('allows admin token management with valid basic auth credentials', async function () {
    process.env.BASIC_USER = 'admin';
    process.env.BASIC_PASS = 'secret123';
    const authHeader = `Basic ${Buffer.from('admin:secret123').toString('base64')}`;
    const app = createApp();

    const createResponse = await app.fetch(new Request('http://localhost/api/admin/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({ name: 'ci-bot', scopes: ['upload', 'read'] }),
    }));
    assert.strictEqual(createResponse.status, 201);
    const createPayload = await createResponse.json();
    assert.ok(String(createPayload.token || '').startsWith('kvault_'));

    const listResponse = await app.fetch(new Request('http://localhost/api/admin/tokens', {
      headers: { Authorization: authHeader },
    }));
    assert.strictEqual(listResponse.status, 200);
    const listPayload = await listResponse.json();
    assert.ok(Array.isArray(listPayload.tokens));

    const auditResponse = await app.fetch(new Request('http://localhost/api/admin/audit-logs', {
      headers: { Authorization: authHeader },
    }));
    assert.strictEqual(auditResponse.status, 200);
    const auditPayload = await auditResponse.json();
    assert.ok(Array.isArray(auditPayload.logs));
    assert.ok(auditPayload.logs.some((entry) => entry.event === 'TOKEN_CREATED'));
  });

  it('rejects bare numeric expiresAt with 400 INVALID_EXPIRY', async function () {
    process.env.BASIC_USER = 'admin';
    process.env.BASIC_PASS = 'secret123';
    const authHeader = `Basic ${Buffer.from('admin:secret123').toString('base64')}`;
    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/api/admin/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({ name: 'x', scopes: ['read'], expiresAt: 1790000000000 }),
    }));
    const payload = await response.json();
    assert.strictEqual(response.status, 400);
    assert.strictEqual(payload.error?.code, 'INVALID_EXPIRY');
  });
});
