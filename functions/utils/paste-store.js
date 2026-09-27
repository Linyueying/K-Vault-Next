/**
 * Paste 存储层 —— D1 优先，KV 兜底。
 *
 * ## 两条路的职责划分
 *
 *   · **D1**（`paste-d1.js`）：读写全走 `pastes` 表。列表接口的排序与分页
 *     下推给 SQL，不再全前缀 list() 后内存排序。
 *   · **KV**：仅在 D1 未绑定时使用，行为与迁移前逐字一致。
 *
 * ## 一个容易搞错的点：content 存哪儿
 *
 * KV 版的记录是「键存空值 + metadata 存摘要 + **值**存完整 JSON（含 content）」。
 * 迁到 D1 后 content 落到 `content` 列，`summarize()` 仍然是**对外摘要**
 * （不含 content），两者是不同层次，不要合并。
 *
 * @module paste-store
 */

import {
  deletePasteRecord,
  getPasteRecord,
  listPasteRecords,
  pasteIdExists,
  purgeExpiredPastes,
  putPasteRecord,
} from './paste-d1.js';

const PASTE_KEY_PREFIX = 'paste:';
const PASTE_ID_LENGTH = 10;
const PASTE_SALT_LENGTH = 12;
const MAX_CONTENT_SIZE = 1024 * 1024; // 1 MiB

/** D1 是否可用（绑定名 DB）。 */
function isD1Enabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
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

function ensureKv(env) {
  if (!env?.img_url) {
    throw new Error('KV binding img_url is not configured.');
  }
}

function normalizePasteId(rawValue = '') {
  const value = String(rawValue || '').trim();
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(value)) return '';
  return value;
}

function normalizeLanguage(rawValue = '') {
  const normalized = String(rawValue || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_+-]/g, '');
  return normalized.slice(0, 40) || 'text';
}

function normalizeExpiresIn(rawValue) {
  if (rawValue == null || rawValue === '') return null;
  const parsed = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function isExpired(record = {}, now = Date.now()) {
  const expiresAt = Number(record.expiresAt || 0);
  return Number.isFinite(expiresAt) && expiresAt > 0 && now > expiresAt;
}

function summarize(record = {}) {
  return {
    id: record.id,
    language: record.language || 'text',
    createdAt: Number(record.createdAt || 0),
    expiresAt: record.expiresAt ?? null,
    hasPassword: Boolean(record.passwordHash),
    size: Number(record.size || 0),
  };
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function hashPassword(password, salt) {
  return sha256Hex(`${salt}:${password}`);
}

function buildKey(id) {
  return `${PASTE_KEY_PREFIX}${id}`;
}

async function generateUniquePasteId(env, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = randomString(PASTE_ID_LENGTH);

    // D1 优先：主键查询，比 KV 少一次网络往返
    const d1 = await pasteIdExists(env, candidate);
    if (!d1.disabled) {
      if (!d1.exists) return candidate;
      continue;
    }

    const exists = await env.img_url.get(buildKey(candidate));
    if (exists == null) {
      return candidate;
    }
  }
  throw new Error('Failed to generate a unique paste id.');
}

export async function createPaste(
  {
    content,
    language = 'text',
    expiresIn = null,
    password = '',
  },
  env
) {
  ensureKv(env);
  const normalizedContent = String(content || '');
  if (!normalizedContent.trim()) {
    throw new Error('Paste content is required.');
  }

  const byteLength = new TextEncoder().encode(normalizedContent).byteLength;
  if (byteLength > MAX_CONTENT_SIZE) {
    throw new Error('Paste content exceeds 1 MiB limit.');
  }

  const now = Date.now();
  const expiresInSeconds = normalizeExpiresIn(expiresIn);
  const expiresAt = expiresInSeconds ? now + expiresInSeconds * 1000 : null;
  const normalizedPassword = String(password || '');
  const passwordSalt = normalizedPassword ? randomString(PASTE_SALT_LENGTH) : null;
  const passwordHash = normalizedPassword ? await hashPassword(normalizedPassword, passwordSalt) : null;
  const id = await generateUniquePasteId(env);

  const record = {
    id,
    content: normalizedContent,
    language: normalizeLanguage(language),
    createdAt: now,
    expiresAt,
    size: byteLength,
    passwordHash,
    passwordSalt,
  };

  // ---------- 路径 A：D1 ----------
  const d1 = await putPasteRecord(env, record);
  if (!d1.disabled) return summarize(record);

  // ---------- 路径 B：KV 兜底 ----------
  const kvOptions = {
    metadata: summarize(record),
  };
  if (expiresInSeconds) {
    kvOptions.expirationTtl = expiresInSeconds;
  }

  await env.img_url.put(buildKey(id), JSON.stringify(record), kvOptions);
  return summarize(record);
}

export async function getPasteById(id, env, { password = '' } = {}) {
  ensureKv(env);
  const pasteId = normalizePasteId(id);
  if (!pasteId) {
    return {
      ok: false,
      status: 404,
      code: 'PASTE_NOT_FOUND',
      message: 'Paste not found.',
    };
  }

  // ---------- 路径 A：D1 ----------
  // `getPasteRecord` 的 WHERE 已带过期条件，因此查不到 = 不存在 **或** 已过期。
  // 要区分两者得再多查一次，代价不划算；而 KV 版对这两种情况都返回 404
  // （过期时只看 code 不同，status 同样是 404），所以这里也不区分。
  const d1Record = await getPasteRecord(env, pasteId);
  if (d1Record) {
    return finishPasteRead(d1Record, password);
  }
  if (isD1Enabled(env)) {
    // D1 可用且明确回答"没有" → 采信，不再回落（该 ID 大概率已被新记录覆盖）
    return {
      ok: false,
      status: 404,
      code: 'PASTE_NOT_FOUND',
      message: 'Paste not found.',
    };
  }

  // ---------- 路径 B：KV 兜底 ----------
  const record = await env.img_url.get(buildKey(pasteId), { type: 'json' });
  if (!record || typeof record !== 'object') {
    return {
      ok: false,
      status: 404,
      code: 'PASTE_NOT_FOUND',
      message: 'Paste not found.',
    };
  }

  if (isExpired(record)) {
    await env.img_url.delete(buildKey(pasteId));
    return {
      ok: false,
      status: 404,
      code: 'PASTE_EXPIRED',
      message: 'Paste has expired.',
    };
  }

  return finishPasteRead(record, password);
}

/**
 * 密码校验 + 组装返回体。D1 与 KV 两条路共用，保证校验与响应逐字段一致。
 *
 * @param {object} record - 完整记录（含 passwordHash / passwordSalt / content）
 * @param {string} password - 访问者提供的明文密码
 */
async function finishPasteRead(record, password = '') {
  const hasPassword = Boolean(record.passwordHash);
  if (hasPassword && !String(password || '')) {
    return {
      ok: false,
      status: 401,
      code: 'PASTE_PASSWORD_REQUIRED',
      message: 'Paste password is required.',
    };
  }

  if (hasPassword) {
    const expected = await hashPassword(String(password || ''), String(record.passwordSalt || ''));
    if (!timingSafeEqual(expected, String(record.passwordHash || ''))) {
      return {
        ok: false,
        status: 403,
        code: 'PASTE_PASSWORD_INVALID',
        message: 'Paste password is invalid.',
      };
    }
  }

  return {
    ok: true,
    paste: {
      ...summarize(record),
      content: String(record.content || ''),
    },
  };
}

export async function listPastes(env, { limit = 50, cursor = 0 } = {}) {
  const normalizedLimit = Math.max(1, Math.min(Number(limit || 50), 200));
  const offset = Math.max(0, Number.parseInt(String(cursor || '0'), 10) || 0);

  // ---------- 路径 A：D1 ----------
  // 排序与分页下推给 SQL。KV 版必须先拉回全部 paste 才能在内存里排序，
  // 取第 2 页同样要先算完全集 —— 这就是这里要迁掉的东西。
  const d1List = await listPasteRecords(env, { limit: normalizedLimit, offset });
  if (!d1List.disabled) {
    const nextCursor = offset + normalizedLimit < d1List.total
      ? String(offset + normalizedLimit)
      : null;
    return {
      items: d1List.items.map((record) => summarize(record)),
      total: d1List.total,
      cursor: nextCursor,
      listComplete: !nextCursor,
    };
  }

  // ---------- 路径 B：KV 兜底 ----------
  ensureKv(env);

  const allKeys = [];
  let kvCursor = undefined;
  let guard = 0;

  do {
    const page = await env.img_url.list({
      prefix: PASTE_KEY_PREFIX,
      limit: 1000,
      cursor: kvCursor,
    });
    allKeys.push(...(page.keys || []));
    kvCursor = page.list_complete ? undefined : page.cursor;
    guard += 1;
  } while (kvCursor && guard < 10000);

  const summaries = [];
  const expiredIds = [];
  const now = Date.now();

  for (const key of allKeys) {
    const id = String(key?.name || '').slice(PASTE_KEY_PREFIX.length);
    if (!id) continue;

    const metadata = key?.metadata || {};
    const expiresAt = Number(metadata.expiresAt || 0) || null;
    if (expiresAt && now > expiresAt) {
      expiredIds.push(id);
      continue;
    }

    if (metadata.id && metadata.createdAt) {
      summaries.push({
        id: metadata.id,
        language: metadata.language || 'text',
        createdAt: Number(metadata.createdAt || 0),
        expiresAt,
        hasPassword: Boolean(metadata.hasPassword),
        size: Number(metadata.size || 0),
      });
      continue;
    }

    const fallback = await env.img_url.get(buildKey(id), { type: 'json' });
    if (!fallback || typeof fallback !== 'object') continue;
    if (isExpired(fallback, now)) {
      expiredIds.push(id);
      continue;
    }
    summaries.push(summarize(fallback));
  }

  if (expiredIds.length > 0) {
    await Promise.allSettled(expiredIds.map((id) => env.img_url.delete(buildKey(id))));
  }

  summaries.sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));

  const page = summaries.slice(offset, offset + normalizedLimit);
  const nextCursor = offset + normalizedLimit < summaries.length ? String(offset + normalizedLimit) : null;

  return {
    items: page,
    total: summaries.length,
    cursor: nextCursor,
    listComplete: !nextCursor,
  };
}

export async function deletePasteById(id, env) {
  const pasteId = normalizePasteId(id);
  if (!pasteId) return false;

  // ---------- 路径 A：D1 ----------
  // 用 DELETE 的 changes 判断存在性，省掉一次 SELECT。
  // 注意不能像 KV 那样"先查后删"：并发下两次查询之间记录可能已被别的请求删掉。
  const d1 = await deletePasteRecord(env, pasteId);
  if (!d1.disabled) return (d1.deleted || 0) > 0;

  // ---------- 路径 B：KV 兜底 ----------
  ensureKv(env);
  const exists = await env.img_url.get(buildKey(pasteId));
  if (exists == null) return false;
  await env.img_url.delete(buildKey(pasteId));
  return true;
}

/**
 * 清理过期 paste。
 *
 * 仅 **管理用**：读取侧本就带过期条件，因此这属于空间回收而非正确性保障
 * （见 paste-d1.js 的说明）。D1 未绑定时返回 `{deleted: 0}`，由 KV 的
 * `expirationTtl` 自己处理（仅对设了过期时间的记录生效）。
 *
 * @param {any} env
 * @returns {Promise<{ok: boolean, deleted: number, disabled?: boolean}>}
 */
export async function purgeExpiredPastesForAdmin(env) {
  const res = await purgeExpiredPastes(env);
  if (res.disabled) return { ok: false, deleted: 0, disabled: true };
  return { ok: res.ok !== false, deleted: res.deleted || 0 };
}
