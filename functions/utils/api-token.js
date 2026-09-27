/**
 * API Token core (Cloudflare Pages / Workers).
 *
 * ============================================================================
 * 存储：D1 优先，KV 兜底（可解绑回滚）
 * ============================================================================
 *
 * 绑定了 D1（env.DB）时，凭据与遥测都读写 D1 表 api_tokens / token_stats；
 * 未绑定时整段回落原来的 KV 实现。判据统一走 isD1Enabled(env)，
 * **解绑 D1 即回到旧路径**，不需要改代码。
 *
 * 注意：这里的降级是"整段回落"而非"逐键合并"。若一半令牌在 KV、一半在 D1，
 * 不做跨源合并 —— 那会让"这个令牌到底存不存在"变得不确定，鉴权路径上
 * 这种不确定性比暂时读不到更危险。
 *
 * Storage model (requirement #2 — decoupled credential vs telemetry):
 * - D1:  api_tokens  (凭据) + token_stats (遥测)，两表 1:1
 * - KV:  [api_token:<id>] 凭据记录：
 *                       { id, name, scopes, enabled, expiresAt, createdAt,
 *                         tokenSalt, tokenHash, tokenSuffix, tokenPreview,
 *                         policies, rotatedAt }
 *                       Telemetry writes NEVER touch this key, so an admin
 *                       disable/scope-change can never be resurrected by a
 *                       stale read-modify-write.
 * - KV:  [token_stat:<id>] 遥测：{ lastUsedAt, usageCount, lastSuccessAt,
 *                       lastFailureAt, lastOperation, lastClient, lastTouchAt }
 *                       lastUsedAt is sampled: at most one write per 60s.
 * - KV:  [token_rl:<id>:<window>] approximate per-token rate limit counters.
 *                       限流计数**仍留在 KV**：它是短 TTL 的窗口计数，D1 没有
 *                       原子自增也没有自动过期，迁过去反而要自己写清理逻辑。
 *
 * 两路共用的解析/校验逻辑（parseScopesStrict / normalizePolicies /
 * toPublicRecord / hashTokenSecret）刻意抽在数据源之外，保证 D1 与 KV
 * 产出的记录形状完全一致 —— 否则"解绑 D1"就不是等价回滚，而是换了个程序。
 *
 * Expiry semantics (requirement #8): API input accepts ISO-8601 strings or
 * explicit `expiresAtMs`. Bare numeric expiresAt is rejected (INVALID_EXPIRY).
 * Internal code always passes epoch milliseconds.
 *
 * Scope semantics (requirement #9): invalid scopes are rejected with 400
 * INVALID_SCOPE + invalidScopes[], never silently filtered.
 */

import {
  insertTokenRecord,
  updateTokenRecord,
  getTokenRecord,
  getTokenStat,
  listTokenRecords,
  deleteTokenRecord,
  touchTokenStat,
  tokenIdExists,
} from './api-token-d1.js';

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

/** D1 是否可用（绑定名 DB）。可用时全部读写走 D1。 */
function isD1Enabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
}

/** 降级态专用键名（D1 可用时不产生）。 */
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

/**
 * 读取遥测。D1 优先；未绑定回落 KV。
 *
 * 注意 `getStat` 在 D1 路径下**不**经过 getRecordById 的存在性检查 ——
 * 遥测可能先于凭据被读（列表场景），让它独立可用。
 */
async function getStat(tokenId, env) {
  if (isD1Enabled(env)) {
    const stat = await getTokenStat(env, tokenId);
    return stat || null;
  }

  try {
    const value = await env.img_url.get(statKey(tokenId), { type: 'json' });
    if (!value || typeof value !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * 归一化一条记录（两路共用）。
 *
 * D1 与 KV 的原始形状有差异（表里 scopes 是 JSON 文本、expiresAt 用 0 表示
 * 不过期），这里统一成同一份内存形状，使调用方完全感知不到存储介质。
 */
function normalizeRecordShape(value, id) {
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

export async function getRecordById(tokenId, env) {
  const id = sanitizeTokenId(tokenId);
  if (!id) return null;

  if (isD1Enabled(env)) {
    const record = await getTokenRecord(env, id);
    if (!record) return null;
    return normalizeRecordShape(record, id);
  }

  ensureKvBinding(env);
  const value = await env.img_url.get(credentialKey(id), { type: 'json' });
  if (!value || typeof value !== 'object') return null;
  return normalizeRecordShape(value, id);
}

function normalizeStoredPolicies(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // Stored policies were validated at write time; trust shape but copy.
  return { ...raw };
}

/**
 * 写入整条记录（仅 create / rotate 这类"全量已知"的路径使用）。
 *
 * 刻意**不**用于 updateApiToken —— 那条路径必须用局部更新，
 * 否则并发写会互相回退（详见 api-token-d1.js 的模块头注释）。
 */
async function putRecord(record, env) {
  if (isD1Enabled(env)) {
    // create 与 rotate 都会走到这里，但语义不同：
    //   · create：行不存在 → INSERT
    //   · rotate：行已存在 → 只更新密钥相关列
    // 用 updateTokenRecord 的 changes 判断行是否存在，避免多查一次。
    const patched = await updateTokenRecord(env, record.id, {
      tokenHash: record.tokenHash,
      tokenSalt: record.tokenSalt,
      tokenSuffix: record.tokenSuffix,
      rotatedAt: record.rotatedAt,
      name: record.name,
      scopes: record.scopes,
      policies: record.policies,
      enabled: record.enabled,
      expiresAt: record.expiresAt,
    });
    if (patched.ok && patched.updated > 0) return;

    const inserted = await insertTokenRecord(env, record);
    if (inserted.ok) return;
    // INSERT 撞主键说明并发下已被别人建好；再走一次局部更新兜住。
    if (inserted.conflict) {
      await updateTokenRecord(env, record.id, {
        tokenHash: record.tokenHash,
        tokenSalt: record.tokenSalt,
        tokenSuffix: record.tokenSuffix,
        rotatedAt: record.rotatedAt,
      });
      return;
    }
    throw new Error(inserted.error || 'Failed to write token record.');
  }

  ensureKvBinding(env);
  await env.img_url.put(credentialKey(record.id), JSON.stringify(record));
}

async function generateUniqueTokenId(env, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = randomString(TOKEN_ID_LENGTH);

    if (isD1Enabled(env)) {
      const { exists, disabled } = await tokenIdExists(env, candidate);
      // 表查询失败（disabled/异常）时保守跳过本轮，交由上层重试或报错，
      // 而不是拿一个"未确认唯一"的 id 去写 —— 撞 id 会覆盖别人的令牌。
      if (!disabled && !exists) return candidate;
      continue;
    }

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
  if (!isD1Enabled(env)) ensureKvBinding(env);

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
  if (isD1Enabled(env)) {
    const { items, disabled } = await listTokenRecords(env);
    if (!disabled) {
      return items.map(({ record, stat }) => toPublicRecord(record, stat));
    }
    // 查询失败（表缺失/迁移未跑）→ 回落 KV，不让后台列表直接白屏
  }

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

  if (isD1Enabled(env)) {
    // 只把 patch 里出现过的字段交给 D1 —— 未提及的列保持原值，
    // 这样"禁用令牌"与"轮换密钥"并发时不会互相回退。
    const partial = {};
    ['enabled', 'name', 'scopes', 'expiresAt', 'policies'].forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(patch, key)) partial[key] = next[key];
    });

    const res = await updateTokenRecord(env, record.id, partial);
    // 行在 getRecordById 与这次 UPDATE 之间被删掉了：按"不存在"处理，
    // 与 KV 版语义一致（KV 版此处会重新 put 出一条，反而是旧实现的缺陷）。
    if (res.ok && res.updated === 0) return null;
  } else {
    await putRecord(next, env);
  }

  return { record: toPublicRecord(next, await getStat(record.id, env)), auditExtras };
}

export async function deleteApiToken(tokenId, env) {
  const id = sanitizeTokenId(tokenId);
  if (!id) return false;

  if (isD1Enabled(env)) {
    // 用 DELETE 的 changes 判断存在性，省掉一次「先查再删」的读。
    // D1 不可用（未绑 DB）时也要能正常走 KV 分支，故只在 D1 路径返回。
    const res = await deleteTokenRecord(env, id);
    if (!res.disabled) return res.deleted > 0;
  }

  ensureKvBinding(env);
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

  if (isD1Enabled(env)) {
    // 轮换**只碰密钥相关列**：不整行覆盖，避免把并发中的 enable/scope
    // 变更用旧快照写回去（那正是 KV 版整条 put 的隐患）。
    const res = await updateTokenRecord(env, next.id, {
      tokenHash: next.tokenHash,
      tokenSalt: next.tokenSalt,
      tokenSuffix: next.tokenSuffix,
      rotatedAt: next.rotatedAt,
    });
    if (res.ok && res.updated === 0) return null;
  } else {
    await putRecord(next, env);
  }

  return {
    token: `${TOKEN_PREFIX}${next.id}_${tokenSecret}`,
    record: toPublicRecord(next, await getStat(next.id, env)),
  };
}

/**
 * Telemetry write (requirement #2). Writes ONLY the telemetry store with a
 * 60s sample debounce (minIntervalMs can raise it, e.g. 1h in low-write mode).
 * Never touches the credential record.
 *
 * D1 路径只用**一条**条件 UPSERT（采样判定下推到 SQL 的 WHERE），
 * 因此这是一条真正的高频路径也只花 1 次查询 —— 见 api-token-d1.js 的
 * touchTokenStat 注释。KV 路径保持原来的「先读再写」两跳。
 */
export async function touchApiTokenUsage(tokenId, env, { success = true, operation = '', client = '', minIntervalMs = 0 } = {}) {
  try {
    const id = sanitizeTokenId(tokenId);
    if (!id) return false;

    const now = Date.now();
    // Sampled write: skip inside the debounce window. Low-write mode callers
    // may raise the effective interval (e.g. 1h with MINIMIZE_KV_WRITES=true).
    const minInterval = Math.max(STAT_DEBOUNCE_MS, Math.max(0, Number(minIntervalMs) || 0));

    if (isD1Enabled(env)) {
      const res = await touchTokenStat(env, id, { now, minIntervalMs: minInterval, success, operation, client });
      // 表缺失/迁移未跑 → 静默放弃这次遥测。遥测丢一次远好过让鉴权路径报错。
      return res.ok ? res.written : false;
    }

    ensureKvBinding(env);
    const stat = (await getStat(id, env)) || {};
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
