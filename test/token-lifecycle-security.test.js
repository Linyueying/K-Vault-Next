const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { initDatabase } = require('../server/db');
const { ApiTokenRepository, parseExpiryInput } = require('../server/lib/repos/api-token-repo');

describe('API token lifecycle security (Docker repo)', function () {
  let db;
  let repo;

  beforeEach(function () {
    const tmpDir = path.join(__dirname, '..', 'data', `tmp-token-life-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    db = initDatabase(path.join(tmpDir, 'token-life.db'));
    repo = new ApiTokenRepository(db);
  });

  function createToken(overrides = {}) {
    return repo.create({
      name: 'lifecycle',
      scopes: ['upload', 'read'],
      ...overrides,
    });
  }

  it('creates a token whose secret verifies', function () {
    const { token, record } = createToken();
    assert.ok(token.startsWith('kvault_'));
    const result = repo.verify(token, 'upload');
    assert.ok(result.ok);
    assert.strictEqual(result.token.id, record.id);
  });

  it('rejects disabled tokens even after usage telemetry is written', function () {
    const { token, record } = createToken();
    repo.touchApiTokenUsage(record.id, { success: true, operation: 'POST /api/v1/upload', client: 'test' });
    repo.update(record.id, { enabled: false });
    assert.ok(!repo.verify(token, 'upload').ok);
    // telemetry must never resurrect a disabled token
    repo.touchApiTokenUsage(record.id, { success: true, operation: 'POST /api/v1/upload', client: 'test' });
    assert.ok(!repo.verify(token, 'upload').ok);
  });

  it('rejects expired tokens', function () {
    const { token } = createToken({ expiresAt: Date.now() - 1000 });
    const result = repo.verify(token, 'upload');
    assert.ok(!result.ok);
    assert.ok(['TOKEN_EXPIRED', 'TOKEN_INVALID'].includes(result.code));
  });

  it('denies scopes the token does not have', function () {
    const { token } = createToken({ scopes: ['read'] });
    const result = repo.verify(token, 'delete');
    assert.ok(!result.ok);
    assert.strictEqual(result.status, 403);
  });

  it('rejects invalid scopes at creation with the invalid list', function () {
    assert.throws(() => createToken({ scopes: ['upload', 'root'] }), (error) => {
      assert.strictEqual(error.code, 'INVALID_SCOPE');
      assert.deepStrictEqual(error.invalidScopes, ['root']);
      return true;
    });
  });

  it('rejects bare numeric expiresAt (unit ambiguity)', function () {
    // Strict parsing lives at parseExpiryInput / route layer; the repo
    // stores already-normalized epoch-ms values.
    assert.throws(() => parseExpiryInput(1790000000000), (error) => {
      assert.strictEqual(error.code, 'INVALID_EXPIRY');
      return true;
    });
  });

  it('rotate() invalidates the old secret and issues a working new one', function () {
    const { token, record } = createToken();
    const rotated = repo.rotate(record.id);
    assert.ok(rotated.token.startsWith('kvault_'));
    assert.notStrictEqual(rotated.token, token);
    assert.ok(!repo.verify(token, 'upload').ok);
    assert.ok(repo.verify(rotated.token, 'upload').ok);
    assert.ok(Number(rotated.record.rotatedAt || 0) > 0);
  });

  it('parses expiresAtMs / ISO expiresAt / null through parseExpiryInput', function () {
    const ms = Date.now() + 3600 * 1000;
    assert.strictEqual(parseExpiryInput({ expiresAtMs: ms }), ms);
    assert.ok(parseExpiryInput(new Date(ms).toISOString()) > Date.now());
    assert.strictEqual(parseExpiryInput(null), null);
  });

  it('touchApiTokenUsage feeds stats without exposing credentials', function () {
    const { token, record } = createToken();
    repo.touchApiTokenUsage(record.id, { success: true, operation: 'GET /api/v1/files', client: 'mocha' });
    const stat = repo.getStat(record.id);
    assert.ok(stat);
    assert.ok(Number(stat.usageCount || 0) >= 1);
    const publicRecord = repo.toPublicRecord(repo.getById(record.id), stat);
    assert.ok(!('secret' in publicRecord));
    assert.ok(!('tokenHash' in publicRecord));
    assert.ok(!('salt' in publicRecord));
    assert.ok(repo.verify(token, 'read').ok);
  });
});
