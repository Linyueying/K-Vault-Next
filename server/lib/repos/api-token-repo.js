const crypto = require('node:crypto');
const { all, get, run } = require('../../db');

const TOKEN_PREFIX = 'kvault_';
const VALID_SCOPES = new Set(['upload', 'read', 'delete', 'paste']);
const VALID_STORAGES = ['telegram', 'r2', 's3', 'discord', 'huggingface', 'webdav', 'github'];
const TOKEN_ID_LENGTH = 12;
const TOKEN_SECRET_LENGTH = 40;
const TOKEN_SALT_LENGTH = 16;
const MASK_PREFIX = '******';
const STAT_DEBOUNCE_MS = 60 * 1000;

const MIME_PATTERN = /^[\w.+-]+\/[\w.+-]+$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\.?$/;

function tokenError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function timingSafeEqualHex(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function randomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(length);
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += chars[bytes[i] % chars.length];
  }
  return output;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function hashTokenSecret(secret, salt) {
  return sha256Hex(`${salt}:${secret}`);
}

function sanitizeTokenId(rawValue = '') {
  const value = String(rawValue || '').trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(value)) return '';
  return value;
}

function splitToken(rawToken = '') {
  const value = String(rawToken || '').trim();
  const match = /^kvault_([A-Za-z0-9_-]{6,128})_([A-Za-z0-9_-]{16,256})$/.exec(value);
  if (!match) return null;
  return { tokenId: match[1], secret: match[2], value };
}

/** Internal: epoch-ms sanity check (internal code always passes epoch ms). */
function normalizeExpiryMs(rawValue) {
  if (rawValue == null || rawValue === '') return null;
  const numeric = typeof rawValue === 'number' ? rawValue : Number(rawValue);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

/**
 * Public API input parsing (requirement #8, parity with Pages).
 * Accepts: ISO-8601 string | { expiresAtMs } explicit | null.
 * Rejects bare numbers (seconds-vs-ms ambiguity) and unparseable strings.
 */
function parseExpiryInput(rawValue) {
  if (rawValue == null || rawValue === '') return null;

  if (typeof rawValue === 'number') {
    throw tokenError('INVALID_EXPIRY', 'expiresAt must be an ISO-8601 string. Use expiresAtMs for epoch milliseconds.');
  }

  if (typeof rawValue === 'object') {
    if (Object.prototype.hasOwnProperty.call(rawValue, 'expiresAtMs')) {
      const ms = normalizeExpiryMs(rawValue.expiresAtMs);
      if (ms == null) {
        throw tokenError('INVALID_EXPIRY', 'expiresAtMs must be a positive epoch-milliseconds number.');
      }
      return ms;
    }
    throw tokenError('INVALID_EXPIRY', 'Unsupported expiresAt payload.');
  }

  const text = String(rawValue).trim();
  if (!text) return null;

  // Pure numeric strings are ambiguous (seconds vs ms) -> reject.
  if (/^-?\d+$/.test(text)) {
    throw tokenError('INVALID_EXPIRY', 'Bare numeric expiresAt is ambiguous. Send an ISO-8601 string or expiresAtMs.');
  }

  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw tokenError('INVALID_EXPIRY', `expiresAt "${text}" is not a valid ISO-8601 timestamp.`);
  }
  return parsed;
}

/** Strict scope parsing (requirement #9): never silently filter. */
function parseScopesStrict(rawScopes = []) {
  const list = Array.isArray(rawScopes) ? rawScopes : [rawScopes];
  const normalized = [];
  const invalidScopes = [];
  list.forEach((item) => {
    const scope = String(item || '').trim().toLowerCase();
    if (!scope) return;
    if (!VALID_SCOPES.has(scope)) {
      if (!invalidScopes.includes(scope)) invalidScopes.push(scope);
      return;
    }
    if (!normalized.includes(scope)) normalized.push(scope);
  });
  if (invalidScopes.length > 0) {
    throw tokenError('INVALID_SCOPE', `Unknown scopes: ${invalidScopes.join(', ')}.`, { invalidScopes });
  }
  if (normalized.length === 0) {
    throw tokenError('INVALID_SCOPE', 'At least one valid scope is required.', { invalidScopes: [] });
  }
  return normalized;
}

/** Legacy read filter: old rows may contain garbage scopes; never throw on read. */
function parseScopesJson(scopesJson) {
  try {
    const list = Array.isArray(JSON.parse(scopesJson || '[]')) ? JSON.parse(scopesJson || '[]') : [];
    return list.map((scope) => String(scope).trim().toLowerCase()).filter((scope) => VALID_SCOPES.has(scope));
  } catch {
    return [];
  }
}

/** Per-token policies (requirement #10). Returns null when absent. */
function normalizePolicies(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') {
    try {
      return normalizePolicies(JSON.parse(raw));
    } catch {
      throw tokenError('INVALID_POLICY', 'policies must be a valid JSON object.');
    }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw tokenError('INVALID_POLICY', 'policies must be an object.');
  }

  const out = {};

  if (raw.allowedStorages != null) {
    const list = (Array.isArray(raw.allowedStorages) ? raw.allowedStorages : [raw.allowedStorages])
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean);
    const invalid = list.filter((item) => !VALID_STORAGES.includes(item));
    if (invalid.length > 0) {
      throw tokenError('INVALID_POLICY', `Unknown storage backend(s): ${invalid.join(', ')}.`, { invalidStorages: invalid });
    }
    const unique = [...new Set(list)];
    if (unique.length > 0) out.allowedStorages = unique;
  }

  if (raw.allowedMimeTypes != null) {
    const list = (Array.isArray(raw.allowedMimeTypes) ? raw.allowedMimeTypes : [raw.allowedMimeTypes])
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean);
    const invalid = list.filter((item) => !MIME_PATTERN.test(item));
    if (invalid.length > 0) {
      throw tokenError('INVALID_POLICY', `Invalid MIME type(s): ${invalid.join(', ')}.`, { invalidMimeTypes: invalid });
    }
    const unique = [...new Set(list)];
    if (unique.length > 0) out.allowedMimeTypes = unique;
  }

  if (raw.maxFileSize != null) {
    const size = Number(raw.maxFileSize);
    if (!Number.isFinite(size) || size <= 0 || size > 1024 * 1024 * 1024) {
      throw tokenError('INVALID_POLICY', 'maxFileSize must be a positive number of bytes (max 1GiB).');
    }
    out.maxFileSize = Math.floor(size);
  }

  if (raw.folderPrefix != null) {
    const prefix = String(raw.folderPrefix).replace(/\\/g, '/').trim().replace(/^\/+/, '');
    if (prefix.includes('..')) {
      throw tokenError('INVALID_POLICY', 'folderPrefix must not contain path traversal.');
    }
    if (prefix) out.folderPrefix = prefix.replace(/\/+$/, '');
  }

  if (raw.rateLimit != null) {
    if (typeof raw.rateLimit !== 'object' || Array.isArray(raw.rateLimit)) {
      throw tokenError('INVALID_POLICY', 'rateLimit must be an object { windowMs, max }.');
    }
    const windowMs = Number(raw.rateLimit.windowMs);
    const max = Number(raw.rateLimit.max);
    if (!Number.isFinite(windowMs) || windowMs < 1000 || windowMs > 24 * 3600 * 1000) {
      throw tokenError('INVALID_POLICY', 'rateLimit.windowMs must be between 1000 and 86400000 ms.');
    }
    if (!Number.isFinite(max) || max < 1 || max > 100000) {
      throw tokenError('INVALID_POLICY', 'rateLimit.max must be between 1 and 100000.');
    }
    out.rateLimit = { windowMs: Math.floor(windowMs), max: Math.floor(max) };
  }

  if (raw.allowedSourceHosts != null) {
    const list = (Array.isArray(raw.allowedSourceHosts) ? raw.allowedSourceHosts : [raw.allowedSourceHosts])
      .map((item) => String(item || '').trim().toLowerCase().replace(/\.$/, ''))
      .filter(Boolean);
    const invalid = list.filter((item) => !HOST_PATTERN.test(item));
    if (invalid.length > 0) {
      throw tokenError('INVALID_POLICY', `Invalid source host(s): ${invalid.join(', ')}.`, { invalidHosts: invalid });
    }
    const unique = [...new Set(list)];
    if (unique.length > 0) out.allowedSourceHosts = unique;
  }

  return Object.keys(out).length > 0 ? out : null;
}

function parseStoredPolicies(raw) {
  if (raw == null || raw === '') return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return { ...parsed };
  } catch {
    return null;
  }
}

function maskTokenSuffix(suffix = '') {
  return `${MASK_PREFIX}${String(suffix || '')}`;
}

function parseBearerToken(request) {
  const authorization = String(request.headers.get('Authorization') || '').trim();
  if (!authorization) return '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return '';
  return String(match[1] || '').trim();
}

function getApiTokenScopes() {
  return [...VALID_SCOPES];
}

/**
 * API Token repository (Docker/SQLite).
 *
 * Requirement #2 — decoupled credential vs telemetry:
 * - `api_tokens`   : credential only. Telemetry writes NEVER touch this table,
 *                    so an admin disable/scope-change can never be resurrected
 *                    by a stale read-modify-write. (Legacy last_used_at column
 *                    remains for old rows but is no longer written.)
 * - `token_stats`  : telemetry only, sampled with a 60s debounce.
 * - `verify()` is a pure read: it can never resurrect a disabled token.
 */
class ApiTokenRepository {
  constructor(db) {
    this.db = db;
    this._rateBuckets = new Map(); // `${tokenId}:${windowStart}` -> count
  }

  getStat(tokenId) {
    try {
      const row = get(
        this.db,
        `SELECT token_id, last_used_at, usage_count, last_success_at, last_failure_at,
                last_operation, last_client, last_touch_at
         FROM token_stats WHERE token_id = ?`,
        [tokenId],
      );
      if (!row) return null;
      return {
        lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
        usageCount: Number(row.usage_count || 0),
        lastSuccessAt: row.last_success_at == null ? null : Number(row.last_success_at),
        lastFailureAt: row.last_failure_at == null ? null : Number(row.last_failure_at),
        lastOperation: row.last_operation || null,
        lastClient: row.last_client || null,
        lastTouchAt: row.last_touch_at == null ? null : Number(row.last_touch_at),
      };
    } catch {
      return null; // table may not exist on databases mid-migration
    }
  }

  toPublicRecord(record = {}, stat = null) {
    const legacyLastUsed = record.lastUsedAt == null ? null : Number(record.lastUsedAt || 0);
    return {
      id: record.id,
      name: record.name,
      scopes: Array.isArray(record.scopes) ? [...record.scopes] : [],
      expiresAt: record.expiresAt ?? null,
      createdAt: Number(record.createdAt || 0),
      lastUsedAt: stat?.lastUsedAt != null ? Number(stat.lastUsedAt) : legacyLastUsed,
      usageCount: stat?.usageCount != null ? Number(stat.usageCount) : 0,
      lastOperation: stat?.lastOperation ?? null,
      lastClient: stat?.lastClient ?? null,
      enabled: Boolean(record.enabled),
      policies: record.policies ? { ...record.policies } : null,
      rotatedAt: record.rotatedAt == null ? null : Number(record.rotatedAt || 0),
      tokenPreview: record.tokenPreview || maskTokenSuffix(record.tokenSuffix || ''),
    };
  }

  rowToRecord(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      scopes: parseScopesJson(row.scopes_json),
      expiresAt: row.expires_at == null ? null : Number(row.expires_at || 0),
      createdAt: Number(row.created_at || 0),
      lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at || 0),
      enabled: row.enabled !== 0,
      policies: parseStoredPolicies(row.policies_json),
      rotatedAt: row.rotated_at == null ? null : Number(row.rotated_at || 0),
      tokenSalt: row.token_salt,
      tokenHash: row.token_hash,
      tokenSuffix: row.token_suffix,
      tokenPreview: row.token_preview,
    };
  }

  getById(tokenId) {
    const id = sanitizeTokenId(tokenId);
    if (!id) return null;
    return this.rowToRecord(get(this.db, 'SELECT * FROM api_tokens WHERE id = ?', [id]));
  }

  generateUniqueTokenId(maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i += 1) {
      const candidate = randomString(TOKEN_ID_LENGTH);
      const exists = get(this.db, 'SELECT id FROM api_tokens WHERE id = ?', [candidate]);
      if (!exists) return candidate;
    }
    throw new Error('Failed to generate a unique token id.');
  }

  create({ name, scopes, expiresAt, policies, enabled = true }) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
      throw tokenError('VALIDATION_ERROR', 'Token name is required.');
    }

    const normalizedScopes = parseScopesStrict(scopes);
    // Route layer parses user input via parseExpiryInput; this is epoch-ms or null.
    const expiryMs = normalizeExpiryMs(expiresAt);
    const normalizedPolicies = normalizePolicies(policies);

    const tokenId = this.generateUniqueTokenId();
    const tokenSecret = randomString(TOKEN_SECRET_LENGTH);
    const tokenSalt = randomString(TOKEN_SALT_LENGTH);
    const tokenHash = hashTokenSecret(tokenSecret, tokenSalt);
    const tokenSuffix = tokenSecret.slice(-6);
    const tokenPreview = maskTokenSuffix(tokenSuffix);
    const now = Date.now();

    run(
      this.db,
      `INSERT INTO api_tokens(
        id, name, scopes_json, expires_at, created_at, last_used_at,
        enabled, token_salt, token_hash, token_suffix, token_preview,
        policies_json, rotated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tokenId,
        normalizedName,
        JSON.stringify(normalizedScopes),
        expiryMs,
        now,
        null,
        enabled !== false ? 1 : 0,
        tokenSalt,
        tokenHash,
        tokenSuffix,
        tokenPreview,
        normalizedPolicies ? JSON.stringify(normalizedPolicies) : null,
        null,
      ]
    );

    const record = this.getById(tokenId);
    return {
      token: `${TOKEN_PREFIX}${tokenId}_${tokenSecret}`,
      record: this.toPublicRecord(record),
    };
  }

  list() {
    return all(this.db, 'SELECT * FROM api_tokens ORDER BY created_at DESC')
      .map((row) => {
        const record = this.rowToRecord(row);
        return this.toPublicRecord(record, this.getStat(record.id));
      });
  }

  update(tokenId, patch = {}) {
    const current = this.getById(tokenId);
    if (!current) return null;

    const next = { ...current };
    const auditExtras = {};

    if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
      next.enabled = Boolean(patch.enabled);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      const normalizedName = String(patch.name || '').trim();
      if (!normalizedName) {
        throw tokenError('VALIDATION_ERROR', 'Token name is required.');
      }
      next.name = normalizedName;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'scopes')) {
      next.scopes = parseScopesStrict(patch.scopes);
      auditExtras.scopes = [...next.scopes];
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'expiresAt')) {
      // Route layer passes epoch-ms (already parsed); accept legacy ISO strings.
      next.expiresAt = normalizeExpiryMs(patch.expiresAt);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'policies')) {
      next.policies = normalizePolicies(patch.policies);
    }

    run(
      this.db,
      `UPDATE api_tokens
       SET name = ?, scopes_json = ?, expires_at = ?, enabled = ?, policies_json = ?
       WHERE id = ?`,
      [
        next.name,
        JSON.stringify(next.scopes),
        next.expiresAt,
        next.enabled ? 1 : 0,
        next.policies ? JSON.stringify(next.policies) : null,
        current.id,
      ]
    );

    return {
      record: this.toPublicRecord(this.getById(current.id), this.getStat(current.id)),
      auditExtras,
    };
  }

  delete(tokenId) {
    const id = sanitizeTokenId(tokenId);
    if (!id) return false;
    const result = run(this.db, 'DELETE FROM api_tokens WHERE id = ?', [id]);
    try {
      run(this.db, 'DELETE FROM token_stats WHERE token_id = ?', [id]);
    } catch {
      // tolerate databases mid-migration
    }
    this._rateBuckets.clear();
    return Number(result.changes || 0) > 0;
  }

  /**
   * Rotate a token (requirement #7): new secret, same identity/scopes/policies.
   * The old secret stops working immediately because the stored hash changes.
   */
  rotate(tokenId) {
    const record = this.getById(tokenId);
    if (!record) return null;

    const tokenSecret = randomString(TOKEN_SECRET_LENGTH);
    const tokenSalt = randomString(TOKEN_SALT_LENGTH);
    const tokenHash = hashTokenSecret(tokenSecret, tokenSalt);
    const tokenSuffix = tokenSecret.slice(-6);
    const rotatedAt = Date.now();

    run(
      this.db,
      `UPDATE api_tokens
       SET token_salt = ?, token_hash = ?, token_suffix = ?, token_preview = ?, rotated_at = ?
       WHERE id = ?`,
      [tokenSalt, tokenHash, tokenSuffix, maskTokenSuffix(tokenSuffix), rotatedAt, record.id]
    );

    return {
      token: `${TOKEN_PREFIX}${record.id}_${tokenSecret}`,
      record: this.toPublicRecord(this.getById(record.id), this.getStat(record.id)),
    };
  }

  /**
   * Telemetry write (requirement #2). Writes ONLY token_stats with a 60s
   * sample debounce. Never touches api_tokens (credentials).
   */
  touchApiTokenUsage(tokenId, { success = true, operation = '', client = '' } = {}) {
    try {
      const id = sanitizeTokenId(tokenId);
      if (!id) return false;

      const now = Date.now();
      const stat = this.getStat(id) || {};

      if (Number(stat.lastTouchAt || 0) > 0 && now - Number(stat.lastTouchAt || 0) < STAT_DEBOUNCE_MS) {
        return false; // sampled: skip write inside the debounce window
      }

      run(
        this.db,
        `INSERT INTO token_stats(
          token_id, last_used_at, usage_count, last_success_at, last_failure_at,
          last_operation, last_client, last_touch_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_id) DO UPDATE SET
          last_used_at = excluded.last_used_at,
          usage_count = excluded.usage_count,
          last_success_at = excluded.last_success_at,
          last_failure_at = excluded.last_failure_at,
          last_operation = excluded.last_operation,
          last_client = excluded.last_client,
          last_touch_at = excluded.last_touch_at,
          updated_at = excluded.updated_at`,
        [
          id,
          now,
          Number(stat.usageCount || 0) + 1,
          success ? now : (Number(stat.lastSuccessAt || 0) || null),
          success ? (Number(stat.lastFailureAt || 0) || null) : now,
          String(operation || stat.lastOperation || '').slice(0, 64) || null,
          String(client || stat.lastClient || '').slice(0, 80) || null,
          now,
          now,
        ]
      );
      return true;
    } catch (error) {
      console.warn('Failed to update API token usage stats:', error?.message || error);
      return false;
    }
  }

  /**
   * Verify a bearer token. Pure read: never writes, so it can never resurrect
   * a disabled token or stale scopes (requirement #2).
   * requiredScope === '@me' means "any valid token" (introspection endpoint).
   */
  verify(tokenValue, requiredScope = '') {
    const split = splitToken(tokenValue);
    if (!split) {
      return { ok: false, status: 401, code: 'TOKEN_INVALID', message: 'API Token is invalid.' };
    }

    const record = this.getById(split.tokenId);
    if (!record) {
      return { ok: false, status: 401, code: 'TOKEN_INVALID', message: 'API Token is invalid.' };
    }

    const expectedHash = hashTokenSecret(split.secret, record.tokenSalt || '');
    if (!timingSafeEqualHex(expectedHash, String(record.tokenHash || ''))) {
      return { ok: false, status: 401, code: 'TOKEN_INVALID', message: 'API Token is invalid.' };
    }

    if (!record.enabled) {
      return { ok: false, status: 401, code: 'TOKEN_DISABLED', message: 'API Token is disabled.' };
    }

    if (Number.isFinite(record.expiresAt) && record.expiresAt > 0 && Date.now() > record.expiresAt) {
      return { ok: false, status: 401, code: 'TOKEN_EXPIRED', message: 'API Token has expired.' };
    }

    const normalizedScope = String(requiredScope || '').trim().toLowerCase();
    if (normalizedScope && normalizedScope !== '@me' && !record.scopes.includes(normalizedScope)) {
      return {
        ok: false,
        status: 403,
        code: 'TOKEN_SCOPE_DENIED',
        message: `API Token does not include "${normalizedScope}" scope.`,
      };
    }

    return { ok: true, token: record };
  }

  /**
   * Approximate per-token rate limit (requirement #10). In-memory fixed-window
   * counters (single-process server). Returns { allowed } / { retryAfterMs }.
   */
  checkTokenRateLimit(record) {
    const policy = record?.policies?.rateLimit;
    if (!policy) return { allowed: true };

    const now = Date.now();
    const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
    const retryAfterMs = Math.max(windowStart + policy.windowMs - now, 1);

    // Opportunistic pruning of stale windows.
    if (this._rateBuckets.size > 10000) {
      for (const key of this._rateBuckets.keys()) {
        const marker = Number(key.slice(key.lastIndexOf(':') + 1));
        if (marker < windowStart) this._rateBuckets.delete(key);
      }
    }

    const key = `${record.id}:${windowStart}`;
    const count = Number(this._rateBuckets.get(key) || 0);
    if (count >= policy.max) {
      return { allowed: false, retryAfterMs };
    }
    this._rateBuckets.set(key, count + 1);
    return { allowed: true };
  }
}

module.exports = {
  ApiTokenRepository,
  getApiTokenScopes,
  parseBearerToken,
  parseExpiryInput,
  parseScopesStrict,
  normalizePolicies,
  normalizeExpiryMs,
  VALID_STORAGES,
};
