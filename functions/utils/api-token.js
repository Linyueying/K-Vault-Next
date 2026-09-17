/**
 * API Token core (Cloudflare Pages / Workers KV).
 *
 * Storage model (requirement #2 — decoupled credential vs telemetry):
 * - `api_token:<id>`  : credential record only. { id, name, scopes, enabled,
 *                       expiresAt, createdAt, tokenSalt, tokenHash, tokenSuffix,
 *                       tokenPreview, policies, rotatedAt }
 *                       Telemetry writes NEVER touch this key, so an admin
 *                       disable/scope-change can never be resurrected by a
 *                       stale read-modify-write.
 * - `token_stat:<id>` : telemetry only. { lastUsedAt, usageCount, lastSuccessAt,
 *                       lastFailureAt, lastOperation, lastClient, lastTouchAt }
 *                       lastUsedAt is sampled: at most one write per 60s.
 * - `token_rl:<id>:<window>` : approximate per-token rate limit counters.
 *
 * Expiry semantics (requirement #8): API input accepts ISO-8601 strings or
 * explicit `expiresAtMs`. Bare numeric expiresAt is rejected (INVALID_EXPIRY).
 * Internal code always passes epoch milliseconds.
 *
 * Scope semantics (requirement #9): invalid scopes are rejected with 400
 * INVALID_SCOPE + invalidScopes[], never silently filtered.
 */

export const TOKEN_PREFIX = 'kvault_';
const TOKEN_KEY_PREFIX = 'api_token:';
const STAT_KEY_PREFIX = 'token_stat:';
const VALID_SCOPES = new Set(['upload', 'read', 'delete', 'paste']);
export const VALID_STORAGES = ['telegram', 'r2', 's3', 'discord', 'huggingface', 'webdav', 'github'];
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

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function sanitizeTokenId(rawValue = '') {
  const value = String(rawValue || '').trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(value)) return '';
  return value;
}

function randomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += chars[bytes[i] % chars.length];
  }
  return output;
}

function splitToken(rawToken = '') {
  const value = String(rawToken || '').trim();
  const match = /^kvault_([A-Za-z0-9_-]{6,128})_([A-Za-z0-9_-]{16,256})$/.exec(value);
  if (!match) return null;
  return { tokenId: match[1], secret: match[2], value };
}

/** Internal: epoch-ms sanity check. */
function normalizeExpiryMs(rawValue) {
  if (rawValue == null || rawValue === '') return null;
  const numeric = typeof rawValue === 'number' ? rawValue : Number(rawValue);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

/**
 * Public API input parsing (requirement #8).
 * Accepts: ISO-8601 string | { expiresAtMs } explicit | null.
 * Rejects bare numbers (unit ambiguity) and unparseable strings.
 */
export function parseExpiryInput(rawValue) {
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
export function parseScopesStrict(rawScopes = []) {
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

/** Per-token policies (requirement #10). Returns null when absent. */
export function normalizePolicies(raw) {
  if (raw == null || raw === '') return null;
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

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashTokenSecret(secret, salt) {
  return sha256Hex(`${salt}:${secret}`);
}

function maskTokenSuffix(suffix = '') {
  return `${MASK_PREFIX}${String(suffix || '')}`;
}

function ensureKvBinding(env) {
  if (!env?.img_url) {
    throw new Error('KV binding img_url is not configured.');
  }
}

function credentialKey(tokenId) {
  return `${TOKEN_KEY_PREFIX}${tokenId}`;
}

function statKey(tokenId) {
  return `${STAT_KEY_PREFIX}${tokenId}`;
}

function normalizeRecordScopes(record) {
  // Legacy records may contain scopes only; strict parse would throw on old
  // garbage, so fall back to a filtered read for legacy data.
  const scopes = Array.isArray(record.scopes) ? record.scopes : [];
  return scopes.map((scope) => String(scope).trim().toLowerCase()).filter((scope) => VALID_SCOPES.has(scope));
}

async function getStat(tokenId, env) {
  try {
    const value = await env.img_url.get(statKey(tokenId), { type: 'json' });
    if (!value || typeof value !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

export async function getRecordById(tokenId, env) {
  ensureKvBinding(env);
  const id = sanitizeTokenId(tokenId);
  if (!id) return null;
  const value = await env.img_url.get(credentialKey(id), { type: 'json' });
  if (!value || typeof value !== 'object') return null;
  return {
    ...value,
    id,
    scopes: normalizeRecordScopes(value),
    enabled: value.enabled !== false,
    expiresAt: normalizeExpiryMs(value.expiresAt),
    createdAt: Number(value.createdAt || 0),
    policies: normalizeStoredPolicies(value.policies),
    rotatedAt: value.rotatedAt == null ? null : Number(value.rotatedAt || 0),
  };
}

function normalizeStoredPolicies(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // Stored policies were validated at write time; trust shape but copy.
  return { ...raw };
}

async function putRecord(record, env) {
  ensureKvBinding(env);
  await env.img_url.put(credentialKey(record.id), JSON.stringify(record));
}

async function generateUniqueTokenId(env, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = randomString(TOKEN_ID_LENGTH);
    const exists = await env.img_url.get(credentialKey(candidate));
    if (exists == null) return candidate;
  }
  throw new Error('Failed to generate a unique token id.');
}

export function getApiTokenScopes() {
  return [...VALID_SCOPES];
}

export function parseBearerToken(request) {
  const authorization = String(request.headers.get('Authorization') || '').trim();
  if (!authorization) return '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return '';
  return String(match[1] || '').trim();
}

export async function createApiToken({ name, scopes, expiresAt, policies, enabled = true }, env) {
  ensureKvBinding(env);

  const normalizedName = String(name || '').trim();
  if (!normalizedName) {
    throw tokenError('VALIDATION_ERROR', 'Token name is required.');
  }

  const normalizedScopes = parseScopesStrict(scopes);
  // expiresAt here is already epoch-ms (route layer parses user input first).
  const expiryMs = normalizeExpiryMs(expiresAt);
  const normalizedPolicies = normalizePolicies(policies);

  const tokenId = await generateUniqueTokenId(env);
  const tokenSecret = randomString(TOKEN_SECRET_LENGTH);
  const tokenSalt = randomString(TOKEN_SALT_LENGTH);
  const tokenHash = await hashTokenSecret(tokenSecret, tokenSalt);
  const tokenSuffix = tokenSecret.slice(-6);
  const now = Date.now();

  const record = {
    id: tokenId,
    name: normalizedName,
    scopes: normalizedScopes,
    expiresAt: expiryMs,
    createdAt: now,
    enabled: enabled !== false,
    policies: normalizedPolicies,
    rotatedAt: null,
    tokenSalt,
    tokenHash,
    tokenSuffix,
    tokenPreview: maskTokenSuffix(tokenSuffix),
  };

  await putRecord(record, env);

  return {
    token: `${TOKEN_PREFIX}${tokenId}_${tokenSecret}`,
    record: toPublicRecord(record, null),
  };
}

export async function listApiTokens(env) {
  ensureKvBinding(env);

  const keys = [];
  let cursor;
  let guard = 0;
  do {
    const page = await env.img_url.list({ prefix: TOKEN_KEY_PREFIX, limit: 1000, cursor });
    keys.push(...(page.keys || []).map((item) => item.name));
    cursor = page.list_complete ? undefined : page.cursor;
    guard += 1;
  } while (cursor && guard < 10000);

  const records = await Promise.all(
    keys.map(async (key) => {
      const id = key.slice(TOKEN_KEY_PREFIX.length);
      const record = await getRecordById(id, env);
      if (!record) return null;
      const stat = await getStat(id, env);
      return toPublicRecord(record, stat);
    })
  );

  return records
    .filter(Boolean)
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
}

export async function updateApiToken(tokenId, patch = {}, env) {
  const record = await getRecordById(tokenId, env);
  if (!record) return null;

  const next = { ...record };
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
    next.expiresAt = normalizeExpiryMs(patch.expiresAt);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'policies')) {
    next.policies = normalizePolicies(patch.policies);
  }

  await putRecord(next, env);
  return { record: toPublicRecord(next, await getStat(record.id, env)), auditExtras };
}

export async function deleteApiToken(tokenId, env) {
  ensureKvBinding(env);
  const id = sanitizeTokenId(tokenId);
  if (!id) return false;
  const existing = await getRecordById(id, env);
  if (!existing) return false;
  await env.img_url.delete(credentialKey(id));
  await env.img_url.delete(statKey(id)).catch(() => {});
  return true;
}

/**
 * Rotate a token (requirement #7): new secret, same identity/scopes/policies.
 * The old secret stops working immediately because the stored hash changes.
 */
export async function rotateApiToken(tokenId, env) {
  const record = await getRecordById(tokenId, env);
  if (!record) return null;

  const tokenSecret = randomString(TOKEN_SECRET_LENGTH);
  const tokenSalt = randomString(TOKEN_SALT_LENGTH);
  const tokenHash = await hashTokenSecret(tokenSecret, tokenSalt);
  const tokenSuffix = tokenSecret.slice(-6);

  const next = {
    ...record,
    tokenSalt,
    tokenHash,
    tokenSuffix,
    tokenPreview: maskTokenSuffix(tokenSuffix),
    rotatedAt: Date.now(),
  };

  await putRecord(next, env);
  return {
    token: `${TOKEN_PREFIX}${next.id}_${tokenSecret}`,
    record: toPublicRecord(next, await getStat(next.id, env)),
  };
}

/**
 * Telemetry write (requirement #2). Writes ONLY the stat key with a 60s
 * sample debounce (minIntervalMs can raise it, e.g. 1h in low-write mode).
 * Never touches the credential record.
 */
export async function touchApiTokenUsage(tokenId, env, { success = true, operation = '', client = '', minIntervalMs = 0 } = {}) {
  try {
    ensureKvBinding(env);
    const id = sanitizeTokenId(tokenId);
    if (!id) return false;

    const now = Date.now();
    const stat = (await getStat(id, env)) || {};

    // Sampled write: skip inside the debounce window. Low-write mode callers
    // may raise the effective interval (e.g. 1h with MINIMIZE_KV_WRITES=true).
    const minInterval = Math.max(STAT_DEBOUNCE_MS, Math.max(0, Number(minIntervalMs) || 0));
    if (Number(stat.lastTouchAt || 0) > 0 && now - Number(stat.lastTouchAt || 0) < minInterval) {
      return false; // sampled: skip write inside the debounce window
    }

    const next = {
      lastUsedAt: now,
      usageCount: Number(stat.usageCount || 0) + 1,
      lastSuccessAt: success ? now : Number(stat.lastSuccessAt || 0) || null,
      lastFailureAt: success ? Number(stat.lastFailureAt || 0) || null : now,
      lastOperation: String(operation || stat.lastOperation || '').slice(0, 64) || null,
      lastClient: String(client || stat.lastClient || '').slice(0, 80) || null,
      lastTouchAt: now,
    };

    await env.img_url.put(statKey(id), JSON.stringify(next));
    return true;
  } catch (error) {
    console.warn('Failed to update API token usage stats:', error?.message || error);
    return false;
  }
}

/**
 * Verify a bearer token. Pure read: this function never writes KV, so it can
 * never resurrect a disabled token or stale scopes (requirement #2).
 * requiredScope === '@me' means "any valid token" (introspection endpoint).
 */
export async function verifyApiToken(tokenValue, env, requiredScope = '') {
  const split = splitToken(tokenValue);
  if (!split) {
    return { ok: false, status: 401, code: 'TOKEN_INVALID', message: 'API Token is invalid.' };
  }

  const record = await getRecordById(split.tokenId, env);
  if (!record) {
    return { ok: false, status: 401, code: 'TOKEN_INVALID', message: 'API Token is invalid.' };
  }

  const expectedHash = await hashTokenSecret(split.secret, record.tokenSalt || '');
  if (!timingSafeEqual(expectedHash, String(record.tokenHash || ''))) {
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

function toPublicRecord(record, stat = null) {
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

/**
 * Approximate per-token rate limit (requirement #10). KV has no atomic
 * counters, so counts can drift under races; acceptable for throttling.
 * Returns { allowed: true } or { allowed: false, retryAfterMs }.
 */
export async function checkTokenRateLimit(record, env) {
  const policy = record?.policies?.rateLimit;
  if (!policy) return { allowed: true };
  ensureKvBinding(env);

  const now = Date.now();
  const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
  const key = `token_rl:${record.id}:${windowStart}`;
  const retryAfterMs = windowStart + policy.windowMs - now;

  let count = 0;
  try {
    const raw = await env.img_url.get(key, { type: 'json' });
    count = Number(raw?.count || 0);
  } catch {
    count = 0;
  }

  if (count >= policy.max) {
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1) };
  }

  try {
    await env.img_url.put(key, JSON.stringify({ count: count + 1 }), {
      expirationTtl: Math.max(Math.ceil(policy.windowMs / 1000) + 5, 10),
    });
  } catch (error) {
    console.warn('Rate limit counter write failed:', error?.message || error);
  }

  return { allowed: true };
}
