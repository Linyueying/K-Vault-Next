const PASTE_KEY_PREFIX = 'paste:';
const PASTE_ID_LENGTH = 10;
const PASTE_SALT_LENGTH = 12;
const MAX_CONTENT_SIZE = 1024 * 1024; // 1 MiB

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
  ensureKv(env);
  const normalizedLimit = Math.max(1, Math.min(Number(limit || 50), 200));
  const offset = Math.max(0, Number.parseInt(String(cursor || '0'), 10) || 0);

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
  ensureKv(env);
  const pasteId = normalizePasteId(id);
  if (!pasteId) return false;
  const exists = await env.img_url.get(buildKey(pasteId));
  if (exists == null) return false;
  await env.img_url.delete(buildKey(pasteId));
  return true;
}
