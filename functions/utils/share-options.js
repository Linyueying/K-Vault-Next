/**
 * Share options for the browser upload path.
 *
 * `/api/v1/upload` already supports `expires_in` / `password` /
 * `max_downloads` / `slug`, but it applies them itself *after* delegating the
 * actual upload to `functions/upload.js`. The browser upload route (`POST
 * /upload`) had no way to set them at all, so files uploaded from the web UI
 * could never be time-limited, password protected, download capped, or given a
 * custom `/s/:slug` short link.
 *
 * This module holds the shared helpers so both paths write exactly the same
 * metadata shape. `functions/file/[id].js` enforces those fields on every read,
 * so nothing here needs to change the read path.
 *
 * @module share-options
 */

import { parsePositiveInt } from './api-v1.js';
import { putRecordIndex, readDownloadCount } from './file-record.js';

export const SHARE_SLUG_KEY_PREFIX = 'share_slug:';

const MAX_EXPIRES_IN_SECONDS = 3650 * 24 * 3600;
const MAX_DOWNLOADS = 1000000000;

/**
 * Normalize a user supplied short-link slug to the same alphabet the
 * `/api/v1/upload` route accepts: lowercase letters, digits, `_` and `-`, at
 * most 64 characters.
 * @param rawValue - Candidate slug.
 * @returns The sanitized slug, or an empty string when nothing usable remains.
 */
export function sanitizeShareSlug(rawValue = '') {
  return String(rawValue || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64);
}

function readField(source, names) {
  for (const name of names) {
    let value = null;
    if (source && typeof source.get === 'function') {
      value = source.get(name);
    } else if (source && typeof source === 'object') {
      value = source[name];
    }
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return '';
}

/**
 * Read the share options from a FormData/URLSearchParams/plain object.
 * @param source - Parsed request body carrying the raw option fields.
 * @returns Normalized options; `slugRaw` keeps the pre-sanitization input so
 *   callers can reject a slug that contains only invalid characters.
 */
export function parseShareOptions(source) {
  const slugRaw = readField(source, ['slug', 'shareSlug']);
  return {
    expiresIn: parsePositiveInt(readField(source, ['expires_in', 'expiresIn']), {
      defaultValue: 0,
      min: 1,
      max: MAX_EXPIRES_IN_SECONDS,
    }),
    maxDownloads: parsePositiveInt(readField(source, ['max_downloads', 'maxDownloads']), {
      defaultValue: 0,
      min: 1,
      max: MAX_DOWNLOADS,
    }),
    slugRaw,
    slug: sanitizeShareSlug(slugRaw),
    password: readField(source, ['password']),
  };
}

/**
 * Whether the caller actually asked for any share behaviour. Used to keep the
 * plain upload path free of extra KV reads and writes.
 * @param options - Result of {@link parseShareOptions}.
 */
export function hasShareOptions(options) {
  if (!options) return false;
  // `slugRaw` is included on purpose: a slug made only of invalid characters
  // yields an empty `slug`, and silently dropping it would hand the caller a
  // normal link while they believe they got a short one. Keeping it "present"
  // routes the request through validateShareOptions(), which rejects it with a
  // clear message — the same behaviour as /api/v1/upload.
  return Boolean(
    options.expiresIn || options.maxDownloads || options.slug || options.slugRaw || options.password
  );
}

/**
 * Validate the parsed options before the file is uploaded, so a bad slug fails
 * fast instead of orphaning an already-stored object.
 * @param options - Result of {@link parseShareOptions}.
 * @returns `null` when valid, otherwise a human readable Chinese message.
 */
export function validateShareOptions(options) {
  if (!options) return null;
  if (options.slugRaw && !options.slug) {
    return '短链标识只能包含字母、数字、下划线或短横线。';
  }
  if (options.password && options.password.length > 200) {
    return '访问密码过长（最多 200 个字符）。';
  }
  return null;
}

/**
 * Resolve a custom slug to the KV key it currently points at.
 * @returns The mapped key, or an empty string when the slug is free.
 */
export async function findShareSlugOwner(env, slug) {
  const normalized = sanitizeShareSlug(slug);
  if (!normalized || !env?.img_url) return '';
  try {
    const mapped = await env.img_url.get(`${SHARE_SLUG_KEY_PREFIX}${normalized}`);
    return mapped ? String(mapped) : '';
  } catch {
    return '';
  }
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function randomSalt() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Merge the share options into an existing KV record and publish the custom
 * slug mapping. Mirrors `/api/v1/upload` so both routes produce identical
 * metadata that `functions/file/[id].js` can enforce.
 * @param env - Pages environment (needs the `img_url` KV binding).
 * @param key - KV key of the freshly uploaded file.
 * @param originalMetadata - The metadata already stored for that key.
 * @param options - Result of {@link parseShareOptions}.
 * @returns The metadata that was written.
 * @throws When the requested slug is already taken by another file.
 */
export async function applyShareOptions(env, key, originalMetadata, options) {
  const nextMetadata = { ...(originalMetadata || {}) };
  const oldSlug = sanitizeShareSlug(originalMetadata?.shareSlug || '');

  if (options.expiresIn > 0) {
    nextMetadata.shareExpiresAt = Date.now() + options.expiresIn * 1000;
  }

  if (options.maxDownloads > 0) {
    nextMetadata.shareMaxDownloads = options.maxDownloads;
    if (!Number.isFinite(Number(nextMetadata.shareDownloadCount))) {
      nextMetadata.shareDownloadCount = 0;
    }
  }

  if (options.slug) {
    nextMetadata.shareSlug = options.slug;
  }

  if (options.password) {
    const salt = randomSalt();
    nextMetadata.sharePasswordSalt = salt;
    nextMetadata.sharePasswordHash = await sha256Hex(`${salt}:${options.password}`);
  }

  if (options.slug) {
    const owner = await findShareSlugOwner(env, options.slug);
    if (owner && owner !== String(key)) {
      throw new Error('自定义短链标识已被占用。');
    }
  }

  await env.img_url.put(key, '', { metadata: nextMetadata });

  // 登记记录索引，使后续按裸 ID 的查找走快路径。与
  // `functions/api/v1/upload.js` 的 applyApiUploadMetadata() 保持完全一致
  // —— 此前这里漏了这一步，导致经分享路径写入的文件在按裸 ID 访问时
  // 退化成"逐前缀串行探测"，虽然结果正确但多花 5~10 次 KV 读。
  await putRecordIndex(env, key);

  if (options.slug && oldSlug && oldSlug !== options.slug) {
    try {
      await env.img_url.delete(`${SHARE_SLUG_KEY_PREFIX}${oldSlug}`);
    } catch {
      /* the stale mapping is harmless: it still resolves to this same file */
    }
  }
  if (options.slug) {
    await env.img_url.put(`${SHARE_SLUG_KEY_PREFIX}${options.slug}`, key, {
      metadata: {
        fileId: key,
        updatedAt: Date.now(),
      },
    });
  }

  return nextMetadata;
}

/**
 * Extract the KV key from an upload response payload (`[{ "src": "/file/<key>" }]`).
 * @param payload - Parsed upload response body.
 */
export function extractUploadKey(payload) {
  const src = Array.isArray(payload) ? payload[0]?.src : payload?.src;
  if (!src) return '';
  const stripped = String(src).replace(/^\/file\//, '');
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

/**
 * Build the share fields that upload responses hand back to the browser.
 *
 * Why this exists: the browser UI used to be the only place that knew which
 * slug it had asked for, so a page refresh — or a history entry restored from
 * localStorage — permanently lost the short link. Returning the canonical
 * summary from the server makes `/s/<slug>` recoverable from the response
 * alone, for every upload path.
 *
 * @param metadata - The KV metadata actually stored for the file.
 * @param key - KV key of the file, used as the fallback short-link id.
 * @returns `null` when the file carries no share behaviour at all, otherwise
 *   an object whose fields mirror what `functions/file/[[path]].js` enforces.
 *   Every field is optional for callers, so older clients keep working.
 */
export function buildShareSummary(metadata, key) {
  if (!metadata) return null;

  const slug = sanitizeShareSlug(metadata.shareSlug || '');
  const expiresAt = Number(metadata.shareExpiresAt) || 0;
  const maxDownloads = Number(metadata.shareMaxDownloads) || 0;
  const hasPassword = Boolean(metadata.sharePasswordHash);

  if (!slug && !expiresAt && !maxDownloads && !hasPassword) return null;

  // `/s/:id` intentionally also accepts a bare file id, so a file without a
  // custom slug still has a working short link.
  const shareTarget = slug || String(key || '');
  if (!shareTarget) return null;

  return {
    shareSlug: slug || '',
    sharePath: `/s/${encodeURIComponent(shareTarget)}`,
    shareExpiresAt: expiresAt || null,
    shareMaxDownloads: maxDownloads || null,
    sharePasswordProtected: hasPassword,
  };
}

/**
 * Merge the share summary into an upload response payload in place.
 * The original fields (`src`, `fileName`, `size`, ...) are never touched.
 * @param payload - Parsed upload response body (array or object).
 * @param summary - Result of {@link buildShareSummary}.
 * @returns The same payload shape, with the share fields added.
 */
export function attachShareSummary(payload, summary) {
  if (!summary) return payload;
  const target = Array.isArray(payload) ? payload[0] : payload;
  if (!target || typeof target !== 'object') return payload;
  return Object.assign(target, summary);
}

/** Metadata keys owned by the share feature; cleared together on revoke. */
const SHARE_METADATA_FIELDS = [
  'shareSlug',
  'shareExpiresAt',
  'shareMaxDownloads',
  'shareDownloadCount',
  'sharePasswordSalt',
  'sharePasswordHash',
];

/**
 * Delete the `share_slug:<slug>` mapping, but only when it still points at the
 * file being cleaned up.
 *
 * Without the ownership check a rename would delete the *new* file's mapping
 * while leaving the old one dangling. `functions/api/manage/delete/[id].js`
 * carried its own copy of this logic; both now share this implementation so
 * the two call sites cannot drift apart.
 *
 * @param env - Pages environment (needs the `img_url` KV binding).
 * @param metadata - Metadata of the record whose mapping should go away.
 * @param kvKey - KV key that the mapping is expected to point at.
 */
export async function cleanupShareSlugMapping(env, metadata = {}, kvKey = '') {
  if (!env?.img_url || !kvKey) return;
  const slug = sanitizeShareSlug(metadata?.shareSlug || '');
  if (!slug) return;

  try {
    const mapKey = `${SHARE_SLUG_KEY_PREFIX}${slug}`;
    const mapped = await env.img_url.get(mapKey);
    if (!mapped || String(mapped) === String(kvKey)) {
      await env.img_url.delete(mapKey);
    }
  } catch (error) {
    console.warn('Failed to cleanup share slug mapping:', error?.message || error);
  }
}

/**
 * Strip every share field from a record and drop its short-link mapping.
 *
 * Deliberately keeps the download counter (`dlc:<kvKey>`) and the inline
 * `shareDownloadCount`: re-enabling a share must *not* hand out a fresh quota,
 * otherwise "revoke then re-share" becomes a way to bypass `maxDownloads`.
 *
 * @param env - Pages environment (needs the `img_url` KV binding).
 * @param key - KV key of the record to un-share.
 * @param metadata - Current metadata of that record.
 * @returns The metadata that was written back (share fields removed).
 */
export async function clearShareOptions(env, key, metadata = {}) {
  const nextMetadata = { ...(metadata || {}) };

  await cleanupShareSlugMapping(env, nextMetadata, key);

  for (const field of SHARE_METADATA_FIELDS) {
    delete nextMetadata[field];
  }

  // `shareDownloadCount` is intentionally re-attached so the exhausted quota
  // survives the revoke. A fresh share of the same file keeps counting up.
  const preservedCount = Number(metadata?.shareDownloadCount);
  if (Number.isFinite(preservedCount) && preservedCount > 0) {
    nextMetadata.shareDownloadCount = preservedCount;
  }

  if (env?.img_url) {
    await env.img_url.put(key, '', { metadata: nextMetadata });
  }

  return nextMetadata;
}

/**
 * Verify a candidate password against the stored hash.
 *
 * @param metadata - KV metadata carrying `sharePasswordHash` / `sharePasswordSalt`.
 * @param password - Password supplied by the visitor.
 * @returns `'ok'` when accepted, `'missing'` when no password was supplied,
 *   `'invalid'` when it does not match. Callers map these onto 200/401/403.
 */
export async function verifySharePassword(metadata = {}, password = '') {
  if (!metadata?.sharePasswordHash) return 'ok';
  const candidate = String(password || '');
  if (!candidate) return 'missing';

  const expected = await sha256Hex(`${String(metadata.sharePasswordSalt || '')}:${candidate}`);
  return timingSafeEqual(String(metadata.sharePasswordHash || ''), expected) ? 'ok' : 'invalid';
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Whether a record currently carries any share configuration at all.
 * Used by the admin list and the browser UI to decide whether an entry is
 * "shared" — a bare `shareSlug` left over from a revoke does not count.
 * @param metadata - KV metadata of the record.
 */
export function hasActiveShare(metadata = {}) {
  if (!metadata) return false;
  return Boolean(
    sanitizeShareSlug(metadata.shareSlug || '')
    || Number(metadata.shareExpiresAt) > 0
    || Number(metadata.shareMaxDownloads) > 0
    || metadata.sharePasswordHash
  );
}

/**
 * Create a random password hash pair for the share password.
 * Exposed so the management endpoint can patch a password in place without
 * going through the whole {@link applyShareOptions} pipeline.
 * @param password - Plaintext password.
 * @returns `{ sharePasswordSalt, sharePasswordHash }`.
 */
export async function buildPasswordFields(password) {
  const salt = randomSalt();
  return {
    sharePasswordSalt: salt,
    sharePasswordHash: await sha256Hex(`${salt}:${password}`),
  };
}

/**
 * Apply a partial patch to a record's share configuration.
 *
 * This is the write path behind `POST /api/manage/share/:id`, where the UI
 * needs field-level granularity: "change the expiry but leave the password
 * alone". {@link applyShareOptions} cannot express that — it is a create-time
 * function that only ever adds fields.
 *
 * Unspecified patch keys (`undefined`) leave the current value untouched. An
 * explicit value of `0` / `''` / `null` **clears** the field, which is how the
 * UI removes a download cap, a password or a custom slug.
 *
 * @param env - Pages environment (needs the `img_url` KV binding).
 * @param key - KV key of the record.
 * @param metadata - Current metadata.
 * @param patch - Partial share config.
 * @param patch.expiresIn - Seconds from now; `0`/`null` clears the expiry.
 * @param patch.maxDownloads - `0`/`null` clears the cap.
 * @param patch.password - `''`/`null` clears; any other string sets it.
 * @param patch.slug - `''`/`null` clears the custom slug; any other string sets it.
 * @returns The metadata that was written.
 * @throws When the requested slug is already owned by a different file.
 */
export async function patchShareOptions(env, key, metadata = {}, patch = {}) {
  const nextMetadata = { ...(metadata || {}) };
  const oldSlug = sanitizeShareSlug(nextMetadata.shareSlug || '');

  if (Object.prototype.hasOwnProperty.call(patch, 'expiresIn')) {
    const expiresIn = Number(patch.expiresIn) || 0;
    if (expiresIn > 0) {
      nextMetadata.shareExpiresAt = Date.now() + expiresIn * 1000;
    } else {
      delete nextMetadata.shareExpiresAt;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'maxDownloads')) {
    const maxDownloads = Number(patch.maxDownloads) || 0;
    if (maxDownloads > 0) {
      nextMetadata.shareMaxDownloads = maxDownloads;
      if (!Number.isFinite(Number(nextMetadata.shareDownloadCount))) {
        nextMetadata.shareDownloadCount = 0;
      }
    } else {
      delete nextMetadata.shareMaxDownloads;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'password')) {
    const password = String(patch.password || '');
    if (password) {
      Object.assign(nextMetadata, await buildPasswordFields(password));
    } else {
      delete nextMetadata.sharePasswordSalt;
      delete nextMetadata.sharePasswordHash;
    }
  }

  let newSlug = oldSlug;
  if (Object.prototype.hasOwnProperty.call(patch, 'slug')) {
    const requested = sanitizeShareSlug(patch.slug || '');
    if (requested) {
      const owner = await findShareSlugOwner(env, requested);
      if (owner && owner !== String(key)) {
        throw new Error('自定义短链标识已被占用。');
      }
    }
    newSlug = requested;
    if (newSlug) {
      nextMetadata.shareSlug = newSlug;
    } else {
      delete nextMetadata.shareSlug;
    }
  }

  await env.img_url.put(key, '', { metadata: nextMetadata });
  await putRecordIndex(env, key);

  // 旧 slug 的映射在「改名」与「清除 slug」两种情况下都要回收。
  if (oldSlug && oldSlug !== newSlug) {
    try {
      const mapKey = `${SHARE_SLUG_KEY_PREFIX}${oldSlug}`;
      const mapped = await env.img_url.get(mapKey);
      if (!mapped || String(mapped) === String(key)) {
        await env.img_url.delete(mapKey);
      }
    } catch {
      /* 残留映射无害：它仍指向本文件 */
    }
  }

  if (newSlug) {
    await env.img_url.put(`${SHARE_SLUG_KEY_PREFIX}${newSlug}`, key, {
      metadata: { fileId: key, updatedAt: Date.now() },
    });
  }

  return nextMetadata;
}

/**
 * Build the admin-facing record for one shared file.
 *
 * The download count comes from `dlc:<kvKey>` (falling back to the inline
 * `shareDownloadCount`), so the number shown in the dashboard matches exactly
 * what `functions/file/[[path]].js` enforces.
 *
 * @param env - Pages environment, needed to read the counter key.
 * @param metadata - Normalized metadata of the record.
 * @param kvKey - KV key of the record.
 * @returns A flat object safe to serialize to the admin UI.
 */
export async function buildShareRecord(env, metadata = {}, kvKey = '') {
  const slug = sanitizeShareSlug(metadata.shareSlug || '');
  const shareTarget = slug || String(kvKey || '');
  const maxDownloads = Number(metadata.shareMaxDownloads) || 0;

  // Only files with a cap need the counter read — an uncapped share has no
  // number worth displaying, and skipping the read keeps the KV budget flat.
  const downloadCount = maxDownloads > 0
    ? await readDownloadCount(env, kvKey, metadata)
    : Number(metadata.shareDownloadCount) || 0;

  const expiresAt = Number(metadata.shareExpiresAt) || 0;
  const expired = expiresAt > 0 && Date.now() > expiresAt;
  const exhausted = maxDownloads > 0 && downloadCount >= maxDownloads;

  return {
    kvKey: String(kvKey || ''),
    id: String(kvKey || '').replace(/^[a-z]+:/, ''),
    fileName: metadata.fileName || String(kvKey || ''),
    fileSize: Number(metadata.fileSize) || 0,
    fileType: metadata.fileType || 'document',
    storageType: metadata.storageType || metadata.storage || 'telegram',
    shareSlug: slug,
    sharePath: shareTarget ? `/s/${encodeURIComponent(shareTarget)}` : '',
    shareExpiresAt: expiresAt || null,
    shareMaxDownloads: maxDownloads || null,
    downloadCount,
    passwordProtected: Boolean(metadata.sharePasswordHash),
    createdAt: Number(metadata.TimeStamp) || null,
    active: !expired && !exhausted,
    expired,
    exhausted,
  };
}

