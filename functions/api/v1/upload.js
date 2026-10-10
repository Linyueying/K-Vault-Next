import { onRequestPost as uploadInternal } from '../../upload.js';
import { parseSignedTelegramFileId, shouldWriteTelegramMetadata } from '../../utils/telegram.js';
import { checkUploadPolicy } from '../../utils/policy-enforce.js';
import { apiError, apiSuccess, buildAbsoluteUrl, parsePositiveInt } from '../../utils/api-v1.js';
import { getRecordWithKey, putRecordIndex, putKvFileMetadata } from '../../utils/file-record.js';
import { findDuplicate, recordDuplicate } from '../../utils/dedup-index.js';

// 注意：本文件原有的前缀顺序以 r2: 开头，与其他文件不同。
// 保留原顺序语义（同名 ID 命中多个前缀时，命中的记录必须与优化前一致）。
const STORAGE_PREFIXES = ['r2:', 's3:', 'discord:', 'hf:', 'webdav:', 'github:', 'img:', 'vid:', 'aud:', 'doc:', ''];
const SHARE_SLUG_KEY_PREFIX = 'share_slug:';
const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
const DEDUP_TTL_SECONDS = 90 * 24 * 3600;
const DEDUP_MAX_INLINE_BYTES = 25 * 1024 * 1024; // pre-upload dedup only for small files

async function sha256HexBuffer(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function idempotencyStoreKey(tokenId, rawKey) {
  return `idem:${String(tokenId || 'anon')}:${fnv1aHex(String(rawKey || ''))}`;
}

function fnv1aHex(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

async function persistUploadSideEffects(env, apiToken, idempotencyKey, contentSha256, info) {
  if (!env?.img_url) return;
  const body = {
    success: true,
    file: {
      id: info.canonicalId || info.publicId,
      name: info.fileName,
      size: info.fileSize,
      type: info.mime,
      storage: info.storageType,
      uploadedAt: new Date(info.uploadedAt || Date.now()).toISOString(),
      ...(contentSha256 ? { sha256: contentSha256 } : {}),
    },
    links: {
      download: buildAbsoluteUrl(info.request, `/file/${encodeURIComponent(info.publicId)}`),
      share: buildAbsoluteUrl(info.request, `/s/${encodeURIComponent(info.shareId || info.publicId)}`),
      delete: buildAbsoluteUrl(info.request, `/api/v1/file/${encodeURIComponent(info.canonicalId || info.publicId)}`),
    },
    deduplicated: false,
  };
  if (idempotencyKey) {
    try {
      await env.img_url.put(idempotencyStoreKey(apiToken?.id, idempotencyKey), JSON.stringify({ status: 200, body, createdAt: Date.now() }), { expirationTtl: IDEMPOTENCY_TTL_SECONDS });
    } catch { /* snapshot failures are non-fatal */ }
  }
  // D1 可用时无需登记：`content_sha` 列随记录一起落库，本身就是索引。
  // 只有 D1 未绑定（回滚态）才写 KV，否则白白消耗 1000 次/天的写额度。
  if (contentSha256) {
    try {
      await recordDuplicate(env, contentSha256, {
        publicId: info.publicId,
        fileName: info.fileName,
        size: info.fileSize,
        mime: info.mime,
        storage: info.storageType,
        uploadedAt: body.file.uploadedAt,
      }, { ttlSeconds: DEDUP_TTL_SECONDS });
    } catch { /* dedup index failures are non-fatal */ }
  }
}

function normalizeStorageType(name = '', metadata = {}) {
  const explicit = metadata.storageType || metadata.storage;
  if (explicit) return String(explicit).toLowerCase();
  const keyName = String(name || '');
  if (keyName.startsWith('r2:')) return 'r2';
  if (keyName.startsWith('s3:')) return 's3';
  if (keyName.startsWith('discord:')) return 'discord';
  if (keyName.startsWith('hf:')) return 'huggingface';
  if (keyName.startsWith('webdav:')) return 'webdav';
  if (keyName.startsWith('github:')) return 'github';
  return 'telegram';
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

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function findRecordByFileId(env, fileId) {
  if (!env?.img_url) return null;

  const rawId = String(fileId || '').trim();
  const signed = await parseSignedTelegramFileId(rawId, env);
  const hasKnownPrefix = STORAGE_PREFIXES.some((prefix) => prefix && rawId.startsWith(prefix));

  // 快路径：裸 ID（非签名串）先查索引，命中即 1~2 次读直达。
  // 未命中则回落到下面的客户端候选列表，候选顺序与优化前逐项一致。
  if (!signed && !hasKnownPrefix) {
    const located = await getRecordWithKey(env, rawId, { prefixes: STORAGE_PREFIXES });
    if (located?.record?.metadata) {
      return { key: located.kvKey, record: located.record };
    }
  }

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  pushCandidate(rawId);

  if (signed) {
    const extension = signed.fileExtension || 'bin';
    pushCandidate(`${signed.fileId}.${extension}`);
    pushCandidate(signed.fileId);
  }

  if (!hasKnownPrefix && !signed) {
    STORAGE_PREFIXES.forEach((prefix) => pushCandidate(`${prefix}${rawId}`));
  }

  for (const key of candidates) {
    const record = await env.img_url.getWithMetadata(key);
    if (record?.metadata) {
      return { key, record };
    }
  }

  return null;
}

function sanitizeSlug(rawValue = '') {
  const normalized = String(rawValue || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return normalized.slice(0, 64);
}

/**
 * 写入上传相关的分享元数据 + 内容指纹。
 *
 * 导出仅为单测可达 —— 它是「指纹有没有真的落库」这个缺陷的所在层，
 * 而完整上传路径依赖真实的 R2/S3/Telegram 绑定，不适合放进 `npm test`。
 */
export async function applyApiUploadMetadata(env, key, originalMetadata, options = {}) {
  if (!env?.img_url || !key) return;

  const nextMetadata = {
    ...(originalMetadata || {}),
  };
  const oldSlug = sanitizeSlug(originalMetadata?.shareSlug || '');

  // 内容指纹随元数据一起落库。
  //
  // 为什么必须在这里写：D1 的 `files.content_sha` 列取自
  // `metadata.contentSha || metadata.sha256`（见 metadata-d1.js 的
  // metadataToColumns），而 `content_sha` 上那条唯一索引正是去重查询的
  // 依据。此前 SHA-256 只在「预检分支」里算了一次、用完即弃，从未写回元
  // 数据 —— 于是**首次上传的 D1 行 content_sha 恒为 NULL**，第二次传同
  // 一份内容时查不到任何记录，去重永远不会命中（`--dedupe` 形同虚设）。
  //
  // 只在本次真的算出了指纹时才写，避免把已有的指纹擦成 undefined。
  if (options.contentSha) {
    nextMetadata.contentSha = options.contentSha;
  }

  const expiresIn = parsePositiveInt(options.expiresIn, { defaultValue: 0, min: 1, max: 3650 * 24 * 3600 });
  if (expiresIn > 0) {
    nextMetadata.shareExpiresAt = Date.now() + expiresIn * 1000;
  }

  const maxDownloads = parsePositiveInt(options.maxDownloads, { defaultValue: 0, min: 1, max: 1000000000 });
  if (maxDownloads > 0) {
    nextMetadata.shareMaxDownloads = maxDownloads;
    if (!Number.isFinite(Number(nextMetadata.shareDownloadCount))) {
      nextMetadata.shareDownloadCount = 0;
    }
  }

  const slug = sanitizeSlug(options.slug);
  if (slug) {
    nextMetadata.shareSlug = slug;
  }

  const password = String(options.password || '');
  if (password) {
    const salt = randomString(12);
    const hash = await sha256Hex(`${salt}:${password}`);
    nextMetadata.sharePasswordSalt = salt;
    nextMetadata.sharePasswordHash = hash;
  }

  if (slug) {
    const existing = await env.img_url.get(`${SHARE_SLUG_KEY_PREFIX}${slug}`);
    if (existing && String(existing) !== String(key)) {
      throw new Error('自定义短链标识已被占用。');
    }
  }

  // 回滚模式闸门：关闭时跳过 KV 元数据写入（D1 已是唯一数据源）。
  // 顺带把 nextMetadata 交给 D1，省掉登记时的 KV 回读。
  await putKvFileMetadata(env, key, nextMetadata);
  await putRecordIndex(env, key, { prefixes: STORAGE_PREFIXES, metadata: nextMetadata });

  if (slug && oldSlug && oldSlug !== slug) {
    await env.img_url.delete(`${SHARE_SLUG_KEY_PREFIX}${oldSlug}`);
  }
  if (slug) {
    await env.img_url.put(`${SHARE_SLUG_KEY_PREFIX}${slug}`, key, {
      metadata: {
        fileId: key,
        updatedAt: Date.now(),
      },
    });
  }

  return nextMetadata;
}

function extractUploadResultId(payload) {
  if (Array.isArray(payload)) {
    const src = payload[0]?.src;
    if (!src) return '';
    return String(src).replace(/^\/file\//, '');
  }

  if (payload && typeof payload === 'object' && payload.src) {
    return String(payload.src).replace(/^\/file\//, '');
  }

  return '';
}

function mapMimeType(fileName = '', fallback = 'application/octet-stream') {
  const extension = String(fileName || '').split('.').pop()?.toLowerCase();
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    txt: 'text/plain',
    json: 'application/json',
    pdf: 'application/pdf',
  };
  return map[extension] || fallback;
}

function resolveUploadErrorStatus(status, message) {
  if (status === 413) return 413;
  const text = String(message || '').toLowerCase();
  if (text.includes('size limit') || text.includes('too large') || text.includes('limit exceeded')) {
    return 413;
  }
  if (status >= 400 && status < 600) return status;
  return 500;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const apiToken = context.data?.apiToken || null;
  // Idempotency replay (requirement #11): same key returns the saved response.
  const idempotencyKey = String(request.headers.get('Idempotency-Key') || '').trim().slice(0, 200);
  if (idempotencyKey && env?.img_url) {
    try {
      const saved = await env.img_url.get(idempotencyStoreKey(apiToken?.id, idempotencyKey), { type: 'json' });
      if (saved?.status && saved?.body) {
        return new Response(JSON.stringify(saved.body), {
          status: saved.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Idempotency-Replayed': 'true' },
        });
      }
    } catch { /* replay lookup failure is non-fatal */ }
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return apiError('BAD_REQUEST', '请求必须使用 multipart/form-data 格式。', 400);
  }

  const file = formData.get('file');
  if (!file) {
    return apiError('VALIDATION_ERROR', '缺少必填字段 "file"。', 400);
  }

  const url = new URL(request.url);
  const storage = String(formData.get('storage') || url.searchParams.get('storage') || '').trim().toLowerCase();
  const password = String(formData.get('password') || url.searchParams.get('password') || '');
  const expiresIn = String(formData.get('expires_in') || url.searchParams.get('expires_in') || '');
  const maxDownloads = String(formData.get('max_downloads') || url.searchParams.get('max_downloads') || '');
  const slug = String(formData.get('slug') || url.searchParams.get('slug') || '');
  const normalizedSlug = sanitizeSlug(slug);
  if (slug && !normalizedSlug) {
    return apiError('VALIDATION_ERROR', '字段 "slug" 只能包含字母、数字、下划线或短横线。', 400);
  }

  // Per-token policy enforcement (requirement #10).
  const folderPath = String(formData.get('folderPath') || formData.get('folder') || url.searchParams.get('folder') || '');
  const deduplicate = String(formData.get('deduplicate') || url.searchParams.get('deduplicate') || '').toLowerCase() === 'true';
  const policyCheck = checkUploadPolicy(apiToken, {
    storage,
    mime: file.type || mapMimeType(file.name, ''),
    sizeBytes: file.size,
    folderPath,
    request,
  });
  if (!policyCheck.ok) {
    return apiError(policyCheck.code, policyCheck.message, policyCheck.status);
  }

  // ==========================================================================
  // 内容指纹：算一次，两处用
  // ==========================================================================
  //
  // 此前 SHA-256 只在「需要去重预检」时才计算，且算完即弃。这带来两个后果：
  //
  //   1. 不带 `deduplicate` 的上传**从不记录指纹** → 之后拿同一份内容来查重
  //      也查不到（索引里根本没这条）;
  //   2. 带 `deduplicate` 首次上传时同样没写回元数据 → D1 的 `content_sha`
  //      列留空 → 第二次上传依旧查不到。两条路叠加，去重实际永不命中。
  //
  // 因此改为**指纹始终计算并落库**（受下面同一个体积闸门约束），
  // 只是「要不要拿它去查重」仍由 `deduplicate` 决定。这样：
  //   · 首次上传无论是否带 `deduplicate`，指纹都进了索引；
  //   · 后续任何一次带 `deduplicate` 的上传都能命中。
  //
  // 体积闸门（`DEDUP_MAX_INLINE_BYTES = 25MB`）是刻意的：要把整个文件读进
  // 内存才能算哈希，对大文件做这件事会吃掉 Worker 的内存预算，收益（省一次
  // 上传）也远不如小文件场景明显。
  let contentSha256 = '';
  if (file.size > 0 && file.size <= DEDUP_MAX_INLINE_BYTES && env?.img_url) {
    try {
      const bytes = await file.arrayBuffer();
      contentSha256 = await sha256HexBuffer(bytes);
    } catch {
      contentSha256 = '';
    }
  }

  // 去重预检：只有显式要求时才查（查重本身很便宜，但语义上该由调用方决定）。
  if (deduplicate && contentSha256) {
    try {
      // D1 优先（content_sha 唯一索引 + 90 天窗口），未命中回落 KV 的存量键。
      // 命中后统一成 `existing` 的原形状，下面拼响应的代码无需改动。
      const hit = await findDuplicate(env, contentSha256, { ttlSeconds: DEDUP_TTL_SECONDS });
      const existing = hit?.kvKey
        ? {
            publicId: hit.kvKey,
            fileName: hit.fileName,
            size: hit.size,
            mime: hit.mime,
            storage: hit.storage,
            uploadedAt: hit.uploadedAt,
          }
        : null;
      if (existing?.publicId) {
        const dedupBody = {
          success: true,
          file: {
            id: existing.publicId,
            name: existing.fileName || file.name,
            size: Number(existing.size || file.size),
            type: existing.mime || file.type || mapMimeType(file.name, 'application/octet-stream'),
            storage: existing.storage || storage || 'telegram',
            uploadedAt: existing.uploadedAt || new Date().toISOString(),
            sha256: contentSha256,
          },
          links: {
            download: buildAbsoluteUrl(request, `/file/${encodeURIComponent(existing.publicId)}`),
            share: buildAbsoluteUrl(request, `/s/${encodeURIComponent(existing.publicId)}`),
            delete: buildAbsoluteUrl(request, `/api/v1/file/${encodeURIComponent(existing.publicId)}`),
          },
          deduplicated: true,
        };
        if (idempotencyKey) {
          try {
            await env.img_url.put(idempotencyStoreKey(apiToken?.id, idempotencyKey), JSON.stringify({ status: 200, body: dedupBody, createdAt: Date.now() }), { expirationTtl: IDEMPOTENCY_TTL_SECONDS });
          } catch { /* non-fatal */ }
        }
        return new Response(JSON.stringify(dedupBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
    } catch { /* dedup failures fall through to a normal upload */ }
  }

  const uploadForm = new FormData();
  for (const [key, value] of formData.entries()) {
    if (key === 'storage') continue;
    uploadForm.append(key, value);
  }
  if (storage) {
    uploadForm.set('storageMode', storage);
  }

  const headers = new Headers(request.headers);
  headers.delete('content-type');
  headers.delete('Content-Type');
  headers.delete('content-length');
  headers.delete('Content-Length');

  const proxiedRequest = new Request(request.url, {
    method: 'POST',
    headers,
    body: uploadForm,
  });

  const uploadResponse = await uploadInternal({
    ...context,
    request: proxiedRequest,
  });

  let uploadPayload = null;
  try {
    uploadPayload = await uploadResponse.clone().json();
  } catch {
    uploadPayload = null;
  }

  if (!uploadResponse.ok) {
    const message = uploadPayload?.error || uploadPayload?.message || '上传失败。';
    const status = resolveUploadErrorStatus(uploadResponse.status || 500, message);
    const code = status === 413 ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED';
    return apiError(code, message, status);
  }

  const publicId = extractUploadResultId(uploadPayload);
  if (!publicId) {
    return apiError('UPLOAD_FAILED', '上传响应中缺少文件标识。', 502);
  }

  // Low-write mode: signed Telegram uploads skip the post-upload KV metadata
  // probe entirely (password/expires_in/max_downloads/slug are ignored and
  // no delete link is returned).
  const signedTelegram = await parseSignedTelegramFileId(publicId, env);
  const skipTelegramMetadata = Boolean(signedTelegram) && !shouldWriteTelegramMetadata(env);
  const lookup = skipTelegramMetadata
    ? null
    : await findRecordByFileId(env, publicId);
  let metadata = lookup?.record?.metadata || {};
  if (lookup?.key) {
    try {
      metadata = await applyApiUploadMetadata(env, lookup.key, lookup.record?.metadata || {}, {
        password,
        expiresIn,
        maxDownloads,
        slug: normalizedSlug,
        contentSha: contentSha256,
      });
    } catch (error) {
      const message = error?.message || '写入上传元数据失败。';
      if (message.includes('已被占用')) {
        return apiError('SLUG_CONFLICT', message, 409);
      }
      return apiError('UPLOAD_METADATA_FAILED', message, 500);
    }
  }

  const canonicalId = lookup?.key || publicId;
  const fileName = metadata.fileName || file.name || signedTelegram?.fileName || canonicalId;
  const fileSize = Number(metadata.fileSize || signedTelegram?.fileSize || file.size || 0);
  const uploadedAtValue = Number(metadata.TimeStamp || signedTelegram?.timestamp || Date.now());
  const shareSlug = lookup?.key
    ? (sanitizeSlug(metadata.shareSlug || '') || normalizedSlug)
    : '';
  const shareId = shareSlug || publicId;

  await persistUploadSideEffects(env, apiToken, idempotencyKey, contentSha256, {
    request,
    publicId,
    canonicalId,
    fileName,
    fileSize,
    mime: mapMimeType(fileName, file.type || 'application/octet-stream'),
    storageType: normalizeStorageType(canonicalId, metadata),
    uploadedAt: uploadedAtValue,
    shareId,
  });

  return apiSuccess({
    file: {
      id: canonicalId,
      name: fileName,
      size: fileSize,
      type: mapMimeType(fileName, file.type || 'application/octet-stream'),
      storage: normalizeStorageType(canonicalId, metadata),
      uploadedAt: new Date(uploadedAtValue).toISOString(),
    },
    links: {
      download: buildAbsoluteUrl(request, `/file/${encodeURIComponent(publicId)}`),
      share: buildAbsoluteUrl(request, `/s/${encodeURIComponent(shareId)}`),
      delete: skipTelegramMetadata
        ? null
        : buildAbsoluteUrl(request, `/api/v1/file/${encodeURIComponent(canonicalId)}`),
    },
  });
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return apiError('METHOD_NOT_ALLOWED', '请求方法不被允许。', 405);
  }
  return onRequestPost(context);
}

