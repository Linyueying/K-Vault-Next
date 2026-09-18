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
