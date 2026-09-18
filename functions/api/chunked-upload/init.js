/**
 * Initialize chunked upload task.
 * POST /api/chunked-upload/init
 */
import { checkAuthentication, isAuthRequired } from '../../utils/auth.js';
import { checkGuestUpload } from '../../utils/guest.js';
import { shouldWriteTelegramMetadata } from '../../utils/telegram.js';
import {
  findShareSlugOwner,
  hasShareOptions,
  parseShareOptions,
  validateShareOptions,
} from '../../utils/share-options.js';

const CHUNK_SIZE = 5 * 1024 * 1024;
const MB = 1024 * 1024;
const GB = 1024 * MB;

// 存储端单文件上限矩阵（R2 与 S3 提升至 2GB，其余保持各平台原有限制）
const STORAGE_MAX_LIMITS = {
  telegram: 20 * MB,
  r2: 2 * GB,
  s3: 2 * GB,
  discord: 25 * MB,
  huggingface: 35 * MB,
  github: 100 * MB,
  webdav: 100 * MB,
};

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (!env.img_url) {
      return jsonResponse({ error: 'KV binding img_url is required for chunk upload task state.' }, 500);
    }

    const isAdmin = isAuthRequired(env)
      ? (await checkAuthentication(context)).authenticated
      : true;

    if (!isAdmin) {
      const guestCheck = await checkGuestUpload(request, env, 0);
      if (!guestCheck.allowed) {
        return jsonResponse({ error: '访客不支持分片上传，请使用普通上传' }, 403);
      }
    }

    const body = await request.json();
    const { fileName, fileSize, fileType, totalChunks, storageMode } = body || {};
    const folderPath = normalizeFolderPath(body?.folderPath || body?.folder || '');
    const normalizedFileSize = Number(fileSize || 0);
    const normalizedTotalChunks = Number(totalChunks || 0);

    if (!fileName || !normalizedFileSize || !normalizedTotalChunks) {
      return jsonResponse({ error: '缺少必要参数' }, 400);
    }

    const validModes = ['telegram', 'r2', 's3', 'discord', 'huggingface', 'webdav', 'github'];
    const normalizedStorage = validModes.includes(storageMode) ? storageMode : 'telegram';

    const validation = validateChunkUpload(normalizedStorage, normalizedFileSize);
    if (!validation.ok) {
      return jsonResponse({ error: validation.message, code: validation.code }, validation.status);
    }

    // Optional share settings applied when the chunks are merged. Admin only,
    // so a guest can neither squat a slug nor publish a protected link. The
    // slug is reserved here, before any bytes are stored, so a conflict fails
    // fast instead of orphaning an already-uploaded object.
    const shareOptions = isAdmin ? parseShareOptions(body || {}) : null;
    if (hasShareOptions(shareOptions)) {
      const shareOptionError = validateShareOptions(shareOptions);
      if (shareOptionError) {
        return jsonResponse({ error: shareOptionError }, 400);
      }
      if (shareOptions.slug && (await findShareSlugOwner(env, shareOptions.slug))) {
        return jsonResponse({ error: '自定义短链标识已被占用。', code: 'SLUG_CONFLICT' }, 409);
      }
      // Telegram can be configured to skip the KV metadata record
      // (TELEGRAM_METADATA_MODE=off / TELEGRAM_SKIP_METADATA=1), which is exactly
      // where the share fields live.
      if (normalizedStorage === 'telegram' && !shouldWriteTelegramMetadata(env)) {
        return jsonResponse({
          error: '当前 Telegram 元数据写入已关闭（TELEGRAM_METADATA_MODE=off 或 TELEGRAM_SKIP_METADATA=1），无法设置有效期 / 密码 / 下载次数 / 短链。请改用其他存储后端，或恢复元数据写入。',
          code: 'SHARE_OPTIONS_UNSUPPORTED',
        }, 409);
      }
    }

    const uploadId = generateUploadId();
    const chunkBackend = resolveChunkBackend(env);

    // 针对 R2 存储节点初始化 R2 原生 Multipart Upload，彻底免除合并时将整个大文件载入 Worker 内存
    let r2Multipart = null;
    if (normalizedStorage === 'r2') {
      if (!env.R2_BUCKET) {
        return jsonResponse({ error: 'R2 未配置，无法初始化分片上传任务' }, 500);
      }
      const fileExtension = getFileExtension(fileName);
      const r2Id = `r2_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const objectKey = `${r2Id}.${fileExtension}`;

      // 自定义元数据 fileName 经过 encodeURIComponent 处理，确保非 ASCII（中文）文件名安全
      const multipart = await env.R2_BUCKET.createMultipartUpload(objectKey, {
        httpMetadata: {
          contentType: fileType || 'application/octet-stream',
        },
        customMetadata: {
          fileName: encodeURIComponent(fileName),
          uploadTime: Date.now().toString(),
        },
      });

      r2Multipart = {
        uploadId: multipart.uploadId,
        key: objectKey,
      };
    }

    const uploadTask = {
      uploadId,
      fileName,
      fileSize: normalizedFileSize,
      fileType,
      totalChunks: normalizedTotalChunks,
      storageMode: normalizedStorage,
      folderPath,
      chunkBackend,
      r2Multipart,
      shareOptions: hasShareOptions(shareOptions) ? shareOptions : null,
      uploadedChunks: [],
      uploadedParts: [],
      createdAt: Date.now(),
      status: 'pending',
    };

    await env.img_url.put(`upload:${uploadId}`, JSON.stringify(uploadTask), {
      expirationTtl: 3600,
    });

    return jsonResponse({
      success: true,
      uploadId,
      chunkSize: CHUNK_SIZE,
      chunkBackend,
    });
  } catch (error) {
    console.error('Init upload error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

/**
 * GET /api/chunked-upload/init?uploadId=xxx
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const uploadId = url.searchParams.get('uploadId');

  if (!uploadId) {
    return jsonResponse({ error: '缺少 uploadId' }, 400);
  }

  if (!env.img_url) {
    return jsonResponse({ error: 'KV binding img_url is required.' }, 500);
  }

  try {
    const taskData = await env.img_url.get(`upload:${uploadId}`, { type: 'json' });
    if (!taskData) {
      return jsonResponse({ error: '上传任务不存在或已过期' }, 404);
    }

    return jsonResponse({
      success: true,
      ...taskData,
    });
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function resolveChunkBackend(env) {
  const mode = String(env.CHUNK_BACKEND || 'auto').toLowerCase();
  if (mode === 'kv') return 'kv';
  if (mode === 'r2') return env.R2_BUCKET ? 'r2' : 'kv';
  return env.R2_BUCKET ? 'r2' : 'kv';
}

function generateUploadId() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

function validateChunkUpload(storageMode, fileSize) {
  const maxLimit = STORAGE_MAX_LIMITS[storageMode] || (100 * MB);
  if (fileSize > maxLimit) {
    const desc = maxLimit >= GB ? `${maxLimit / GB}GB` : `${maxLimit / MB}MB`;
    return {
      ok: false,
      status: 413,
      code: 'FILE_TOO_LARGE',
      message: `文件大小超过当前存储端限制 (最大 ${desc})`,
    };
  }

  if (storageMode === 'telegram' && fileSize > 20 * MB) {
    return {
      ok: false,
      status: 400,
      code: 'TELEGRAM_CHUNK_UNSUPPORTED',
      message: 'Cloudflare Pages 上的 Telegram 网页上传仅适合 20MB 以内文件。更大的文件请切换到 R2/S3/WebDAV/GitHub，或把文件直接发到 Telegram 后使用 Webhook 回链。',
    };
  }

  if (storageMode === 'discord' && fileSize > 25 * MB) {
    return {
      ok: false,
      status: 413,
      code: 'DISCORD_FILE_TOO_LARGE',
      message: 'Discord 默认上传上限按 25MB 处理；更大的文件请使用 R2/S3/WebDAV/GitHub。',
    };
  }

  if (storageMode === 'huggingface' && fileSize > 35 * MB) {
    return {
      ok: false,
      status: 413,
      code: 'HUGGINGFACE_FILE_TOO_LARGE',
      message: 'HuggingFace 普通上传链路建议控制在 35MB 以内；更大的文件请使用 LFS 或其他对象存储。',
    };
  }

  return { ok: true };
}

function getFileExtension(fileName) {
  const ext = String(fileName || '').split('.').pop()?.toLowerCase();
  if (!ext || ext === String(fileName || '').toLowerCase()) return 'bin';
  return ext.replace(/[^a-z0-9]/g, '') || 'bin';
}

function normalizeFolderPath(value) {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  const output = [];
  for (const part of raw.split('/')) {
    const piece = part.trim();
    if (!piece || piece === '.') continue;
    if (piece === '..') {
      output.pop();
      continue;
    }
    output.push(piece);
  }
  return output.join('/');
}
