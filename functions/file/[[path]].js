import { createS3Client } from '../utils/s3client.js';
import { getDiscordFileUrl } from '../utils/discord.js';
import { getHuggingFaceFile } from '../utils/huggingface.js';
import { getWebDAVFile } from '../utils/webdav.js';
import { getGitHubFile } from '../utils/github.js';
import {
  getRecordWithKey as findRecordWithKey,
  readDownloadCount,
  incrementDownloadCount,
  putRecordIndex,
} from '../utils/file-record.js';
import {
  buildTelegramBotApiUrl,
  buildTelegramFileUrl,
  parseSignedTelegramFileId,
  shouldWriteTelegramMetadata,
} from '../utils/telegram.js';

const MIME_TYPES = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  wma: 'audio/x-ms-wma',
  opus: 'audio/opus',
  oga: 'audio/ogg',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  md: 'text/markdown',
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
};

/**
 * 对外入口。
 *
 * 这里只做一件额外的事：把「显式下载」请求的响应后处理一遍
 * （详见 `applyDownloadDisposition`）。放在最外层统一处理，而不是改 7 个
 * 存储分支 —— 分支各自实现一遍 attachment 头，早晚会漏掉一两个。
 */
export async function onRequest(context) {
  const response = await handleRequest(context);
  return applyDownloadDisposition(context, response);
}

async function handleRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') {
    return handleOptions();
  }

  try {
    let fileId = params.path;
if (Array.isArray(fileId)) {
  fileId = fileId.join('/');
}
if (!fileId) {
  return errorResponse('Missing file id', 400);
}

  try {
      fileId = decodeURIComponent(fileId);
    } catch (e) {}

    const signedTelegramMeta = await parseSignedTelegramFileId(fileId, env);
    if (signedTelegramMeta) {
      // Signed links must go through the same share controls, block-list and
      // whitelist rules as the regular path. Previously this branch returned
      // before any of them ran, so expiry / password / download cap and
      // block / whitelist were all silently bypassed.
      const signedUrl = new URL(request.url);
      const signedRecord = await getRecordWithKey(
        env,
        `${signedTelegramMeta.fileId}.${signedTelegramMeta.fileExtension || 'bin'}`
      );
      const signedMetadata = signedRecord?.metadata || null;

      let signedShareAccess = null;
      if (signedMetadata) {
        signedShareAccess = await verifyShareAccess(context, signedMetadata, signedRecord.kvKey);
        if (signedShareAccess?.response) {
          return signedShareAccess.response;
        }
        if (shouldBlock(signedMetadata)) {
          return blockRedirect(signedUrl, request);
        }
      }

      // No KV record means the list type is unknown, so whitelist mode has to
      // deny instead of allowing the file through.
      if (shouldWhitelistDeny(env, signedMetadata || {})) {
        return Response.redirect(`${signedUrl.origin}/whitelist-on.html`, 302);
      }

      const signedResponse = await handleSignedTelegramFile(context, signedTelegramMeta);

      if (signedShareAccess?.trackDownload && shouldCountAsDownload(request, signedResponse)) {
        const updatePromise = incrementShareDownloadCount(env, signedShareAccess.kvKey, signedShareAccess.metadata);
        if (typeof context.waitUntil === 'function') {
          context.waitUntil(updatePromise.catch(() => {}));
        } else {
          updatePromise.catch(() => {});
        }
      }

      return signedResponse;
    }

    const recordResult = await getRecordWithKey(env, fileId);
    const record = recordResult?.record;
    const kvKey = recordResult?.kvKey || fileId;

    if (env.img_url && !record?.metadata) {
      return errorResponse('File not found', 404);
    }

    let shareAccess = null;
    if (record?.metadata) {
      shareAccess = await verifyShareAccess(context, record.metadata, kvKey);
      if (shareAccess?.response) {
        return shareAccess.response;
      }
    }

    const storageType = inferStorageType(fileId, record?.metadata || {});
    let response;
    if (storageType === 'r2') {
  const r2Key = record?.metadata?.r2Key || String(fileId).replace(/^r2:/, '');
  response = await handleR2File(context, r2Key, record);
} else if (storageType === 's3') {
      response = await handleS3File(context, fileId, record);
    } else if (storageType === 'discord') {
      response = await handleDiscordFile(context, fileId, record);
    } else if (storageType === 'huggingface') {
      response = await handleHFFile(context, fileId, record);
    } else if (storageType === 'webdav') {
      response = await handleWebDAVFile(context, fileId, record);
    } else if (storageType === 'github') {
      response = await handleGitHubFile(context, fileId, record);
    } else {
      response = await handleTelegramFile(context, fileId, record);
    }

    if (shareAccess?.trackDownload && shouldCountAsDownload(request, response)) {
      const updatePromise = incrementShareDownloadCount(env, shareAccess.kvKey, shareAccess.metadata);
      if (typeof context.waitUntil === 'function') {
        context.waitUntil(updatePromise.catch(() => {}));
      } else {
        updatePromise.catch(() => {});
      }
    }

    return response;
  } catch (error) {
    console.error('file route error:', error);
    return errorResponse(`File proxy error: ${error?.message || 'Unknown error'}`, 502);
  }
}

function inferStorageType(name, metadata = {}) {
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

function getMimeType(fileName = '') {
  const ext = String(fileName).split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function addCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition');
  headers.set('CDN-Cache-Control', 'no-store');
  return headers;
}

function addResponseHeaders(headers, fileName, mimeType, upstream = null) {
  addCorsHeaders(headers);
  headers.set('Content-Type', mimeType || 'application/octet-stream');
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('Accept-Ranges', 'bytes');

  if (fileName) {
    const encoded = encodeURIComponent(fileName);
    headers.set('Content-Disposition', `inline; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  }

  if (upstream) {
    const contentLength = upstream.headers.get('Content-Length');
    const contentRange = upstream.headers.get('Content-Range');
    if (contentLength) headers.set('Content-Length', contentLength);
    if (contentRange) headers.set('Content-Range', contentRange);
  }
}

function handleOptions() {
  const headers = new Headers();
  addCorsHeaders(headers);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

function errorResponse(message, status = 500) {
  const headers = new Headers();
  addCorsHeaders(headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return new Response(message, { status, headers });
}

function shouldBlock(metadata = {}) {
  const listType = String(metadata.ListType || '').toLowerCase();
  const label = String(metadata.Label || '').toLowerCase();
  return listType === 'block' || label === 'adult';
}

function shouldWhitelistDeny(env, metadata = {}) {
  if (env.WhiteList_Mode !== 'true') return false;
  const listType = String(metadata.ListType || '').toLowerCase();
  return listType !== 'white';
}

function blockRedirect(requestUrl, request) {
  const referer = request.headers.get('Referer');
  if (referer) {
    return Response.redirect('https://static-res.pages.dev/teleimage/img-block-compressed.png', 302);
  }
  return Response.redirect(`${requestUrl.origin}/block-img.html`, 302);
}

async function getRecordWithKey(env, fileId) {
  // 统一走 utils/file-record.js：带前缀 ID 行为不变，裸 ID 走索引加速
  return findRecordWithKey(env, fileId);
}

function getSharePassword(request) {
  const url = new URL(request.url);
  return String(
    url.searchParams.get('password')
    || request.headers.get('X-File-Password')
    || request.headers.get('X-Share-Password')
    || ''
  );
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

async function verifyShareAccess(context, metadata = {}, kvKey = '') {
  const expiresAt = Number(metadata.shareExpiresAt || 0);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() > expiresAt) {
    return { response: errorResponse('File link has expired', 410) };
  }

  const maxDownloads = Number(metadata.shareMaxDownloads || 0);
  // 计数来源改为「独立计数键 + 元数据内联值」合并读取：
  // 判断条件、阈值比较与 410 响应语义与优化前完全一致，仅数据来源扩展。
  const currentDownloads = await readDownloadCount(context.env, kvKey, metadata);
  if (Number.isFinite(maxDownloads) && maxDownloads > 0 && currentDownloads >= maxDownloads) {
    return { response: errorResponse('File download limit reached', 410) };
  }

  if (metadata.sharePasswordHash) {
    const providedPassword = getSharePassword(context.request);
    if (!providedPassword) {
      return { response: errorResponse('File password required', 401) };
    }
    const expected = await sha256Hex(`${String(metadata.sharePasswordSalt || '')}:${providedPassword}`);
    if (!timingSafeEqual(String(metadata.sharePasswordHash || ''), expected)) {
      return { response: errorResponse('File password invalid', 403) };
    }
  }

  return {
    response: null,
    trackDownload: Number.isFinite(maxDownloads) && maxDownloads > 0,
    kvKey,
    metadata,
  };
}

/**
 * 是否应计入一次分享下载。
 *
 * ## 语义变更
 *
 * 改造前：GET 且响应 200/206 就计数。问题在于分享页要提供「预览」——
 * 视频拖动进度条会发出一串 Range 请求，每个都是 206，于是一次预览就把
 * 下载配额吃光；图片预览、PDF 翻页同理。
 *
 * 改造后：**只有显式带 `dl=1` 的请求才计数**。分享页的下载按钮会带这个
 * 参数，预览用的 iframe 不会。
 *
 * `dl=1` 的 Range 请求（大文件续传）仍算一次下载 —— 用户点的是下载。
 *
 * @param request - 原始请求。
 * @param response - 已生成的响应。
 * @returns 是否计数。
 */
function shouldCountAsDownload(request, response) {
  if (String(request?.method || '').toUpperCase() !== 'GET') return false;
  if (!response) return false;
  if (!isExplicitDownload(request)) return false;
  return response.status === 200 || response.status === 206;
}

/** 请求是否显式要求下载（`?dl=1`）。 */
function isExplicitDownload(request) {
  try {
    return new URL(request.url).searchParams.get('dl') === '1';
  } catch {
    return false;
  }
}

/**
 * 显式下载时把 `Content-Disposition` 从 `inline` 改成 `attachment`。
 *
 * `addResponseHeaders()` 里恒定写 `inline`（那是 7 个存储分支共用的），
 * 分享页的下载按钮需要浏览器直接保存文件而不是内联打开，因此在最外层
 * 统一改写响应头，避免动 7 处调用点。
 *
 * 两个必须小心的点：
 *   1. **只在 `!response.bodyUsed` 时重建响应**。body 已被消费时再构造
 *      `new Response(oldResponse.body)` 会抛错。
 *   2. **跳过重定向响应**。302 的 `Content-Disposition` 没有意义，
 *      而且 `Response.redirect()` 的响应是 immutable 的，改头会抛
 *      `TypeError: immutable`。
 *
 * @param context - Pages 请求上下文。
 * @param response - 内层处理函数返回的响应。
 * @returns 改写后的响应（无需改写时原样返回）。
 */
function applyDownloadDisposition(context, response) {
  try {
    if (!response || !isExplicitDownload(context?.request)) return response;

    // 重定向 / 无内容 / 错误响应无需（也不能）改写
    if (response.status < 200 || response.status >= 300) return response;
    if (response.status === 204 || response.status === 304) return response;
    // 空 body（如 204/HEAD）无需改写
    if (!response.body || response.bodyUsed) return response;

    const headers = new Headers(response.headers);
    const fileName = extractFileNameFromDisposition(headers.get('Content-Disposition'));
    if (fileName) {
      const encoded = encodeURIComponent(fileName);
      // 同时给 `filename` 与 `filename*`：前者兼容老浏览器，后者保证
      // 中文文件名在各浏览器下不乱码。与 addResponseHeaders 的写法一致。
      headers.set('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    // 头改写属于锦上添花：失败时退回原响应，不要让下载整个挂掉
    console.warn('Failed to apply download disposition:', error?.message || error);
    return response;
  }
}

/**
 * 从已有的 `Content-Disposition` 里抠出文件名。
 * 优先读 RFC 5987 的 `filename*`（UTF-8 编码），退回 `filename`。
 * @param header - 原响应头值。
 * @returns 解码后的文件名，取不到时为空串。
 */
function extractFileNameFromDisposition(header) {
  const value = String(header || '');
  if (!value) return '';

  const starMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (starMatch) {
    try {
      return decodeURIComponent(starMatch[1].trim());
    } catch {
      /* 落到下面的 filename */
    }
  }

  const plainMatch = value.match(/filename="([^"]*)"/i) || value.match(/filename=([^;]+)/i);
  if (plainMatch) {
    const raw = plainMatch[1].trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return '';
}

async function incrementShareDownloadCount(env, kvKey, metadata = {}) {
  // 只写独立计数键（几字节），不再重写整个 metadata，写入体积大幅下降。
  await incrementDownloadCount(env, kvKey, metadata);
}

async function handleTelegramFile(context, fileId, record = null) {
  const { request, env } = context;
  const url = new URL(request.url);

  const metadata = record?.metadata || {};
  if (shouldBlock(metadata)) {
    return blockRedirect(url, request);
  }
  if (shouldWhitelistDeny(env, metadata)) {
    return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
  }

  const fileName = metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const telegramFileId = String(fileId).split('.')[0];
  const filePath = await getTelegramFilePath(env, telegramFileId);
  if (!filePath) {
    return errorResponse('Failed to get file path from Telegram', 500);
  }

  const rangeHeader = request.headers.get('Range');
  const fetchHeaders = new Headers();
  if (rangeHeader) fetchHeaders.set('Range', rangeHeader);

  const upstream = await fetch(buildTelegramFileUrl(env, filePath), {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: fetchHeaders,
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('Failed to fetch file from Telegram', upstream.status);
  }

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function handleSignedTelegramFile(context, signedMeta) {
  const { request, env } = context;

  const filePath = await getTelegramFilePath(env, signedMeta.fileId);
  if (!filePath) {
    return errorResponse('Failed to get file path from Telegram', 500);
  }

  await backfillSignedTelegramMetadata(env, signedMeta);

  const fileName = signedMeta.fileName || `${signedMeta.fileId}.${signedMeta.fileExtension || 'bin'}`;
  const mimeType = signedMeta.mimeType || getMimeType(fileName);

  const rangeHeader = request.headers.get('Range');
  const fetchHeaders = new Headers();
  if (rangeHeader) fetchHeaders.set('Range', rangeHeader);

  const upstream = await fetch(buildTelegramFileUrl(env, filePath), {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: fetchHeaders,
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('Failed to fetch file from Telegram', upstream.status);
  }

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function backfillSignedTelegramMetadata(env, signedMeta) {
  if (!env.img_url || !shouldWriteTelegramMetadata(env)) {
    return;
  }

  const fileExtension = signedMeta.fileExtension || 'bin';
  const kvKey = `${signedMeta.fileId}.${fileExtension}`;

  try {
    // 先查索引：命中说明该记录已登记，无需再读记录本体即可判定"已存在"。
    // 索引未命中（老数据）才回落到 getWithMetadata 做精确判断，
    // "已存在则不覆盖"的语义完全保留。
    const existing = await getRecordWithKey(env, kvKey);
    if (existing?.record?.metadata) return;

    await env.img_url.put(kvKey, '', {
      metadata: {
        TimeStamp: signedMeta.timestamp || Date.now(),
        ListType: 'None',
        Label: 'None',
        liked: false,
        fileName: signedMeta.fileName || `${signedMeta.fileId}.${fileExtension}`,
        fileSize: signedMeta.fileSize || 0,
        storageType: 'telegram',
        telegramFileId: signedMeta.fileId,
        telegramMessageId: signedMeta.messageId || undefined,
        signedLink: true,
        source: 'signed-backfill',
      },
    });
    // 回填后登记索引，后续同 ID 请求走快路径
    await putRecordIndex(env, kvKey);
  } catch (error) {
    console.warn('Signed metadata backfill skipped:', error.message);
  }
}

async function handleR2File(context, r2Key, record = null) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);

  if (!env.R2_BUCKET) {
    return errorResponse('R2 storage not configured', 500);
  }

  if (!record?.metadata) {
    const resolved = await getR2RecordFromKV(env, r2Key);
    record = resolved;
  }

  if (!record?.metadata) {
    return errorResponse('File not found', 404);
  }

  if (shouldBlock(record.metadata)) {
    return blockRedirect(requestUrl, request);
  }
  if (shouldWhitelistDeny(env, record.metadata)) {
    return Response.redirect(`${requestUrl.origin}/whitelist-on.html`, 302);
  }

  const fileName = record.metadata.fileName || r2Key;
  const mimeType = getMimeType(fileName);

  const rangeHeader = request.headers.get('Range');
  let object;
  let responseStatus = 200;
  let contentLength = null;
  let contentRange = null;

  if (rangeHeader) {
    const head = await env.R2_BUCKET.head(r2Key);
    if (!head) return errorResponse('File not found in R2', 404);

    const range = parseSimpleRange(rangeHeader, head.size);
    if (range) {
      if (range.unsatisfiable) {
        const headers = new Headers();
        addCorsHeaders(headers);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Content-Range', `bytes */${head.size}`);
        return new Response('Range Not Satisfiable', { status: 416, headers });
      }

      const { start, end } = range;
      object = await env.R2_BUCKET.get(r2Key, {
        range: { offset: start, length: end - start + 1 },
      });
      responseStatus = 206;
      contentLength = end - start + 1;
      contentRange = `bytes ${start}-${end}/${head.size}`;
    }
  }

  if (!object) {
    object = await env.R2_BUCKET.get(r2Key);
  }

  if (!object) {
    return errorResponse('File not found in R2', 404);
  }

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType);
  headers.set('Content-Length', String(contentLength ?? object.size));
  if (contentRange) headers.set('Content-Range', contentRange);

  return new Response(object.body, {
    status: responseStatus,
    headers,
  });
}

async function getR2RecordFromKV(env, r2Key) {
  if (!env.img_url) return null;

  const candidateKeys = r2Key.startsWith('r2:') ? [r2Key, r2Key.slice(3)] : [`r2:${r2Key}`, r2Key];

  for (const key of candidateKeys) {
    const record = await env.img_url.getWithMetadata(key);
    if (record?.metadata) return record;
  }

  return null;
}

function parseSimpleRange(rangeHeader, size = null) {
  const match = String(rangeHeader || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return null;

  let start;
  let end;

  if (!hasStart) {
    const suffixLength = parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    if (size == null) return { start: null, end: suffixLength };
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = parseInt(match[1], 10);
    end = hasEnd ? parseInt(match[2], 10) : (size == null ? null : size - 1);
  }

  if (!Number.isFinite(start) || (end != null && !Number.isFinite(end))) return null;

  if (size != null) {
    if (start >= size || (end != null && start > end)) {
      return { unsatisfiable: true };
    }
    end = Math.min(end ?? size - 1, size - 1);
  }

  return { start, end };
}

async function handleS3File(context, fileId, record = null) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['s3:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  if (shouldBlock(record.metadata)) {
    return blockRedirect(requestUrl, request);
  }
  if (shouldWhitelistDeny(env, record.metadata)) {
    return Response.redirect(`${requestUrl.origin}/whitelist-on.html`, 302);
  }

  const s3Key = record.metadata.s3Key || fileId.replace(/^s3:/, '');
  const fileName = record.metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const s3 = createS3Client(env);
  const rangeHeader = request.headers.get('Range');
  const upstream = await s3.getObject(s3Key, rangeHeader ? { range: rangeHeader } : {});

  if (!upstream) return errorResponse('File not found in S3', 404);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleDiscordFile(context, fileId, record = null) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['discord:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  if (shouldBlock(record.metadata)) {
    return blockRedirect(requestUrl, request);
  }
  if (shouldWhitelistDeny(env, record.metadata)) {
    return Response.redirect(`${requestUrl.origin}/whitelist-on.html`, 302);
  }

  const { discordChannelId, discordMessageId } = record.metadata;
  if (!discordChannelId || !discordMessageId) {
    return errorResponse('Discord metadata incomplete', 500);
  }

  const fileInfo = await getDiscordFileUrl(discordChannelId, discordMessageId, env);
  if (!fileInfo) return errorResponse('File not found on Discord', 404);

  const rangeHeader = request.headers.get('Range');
  const upstream = await fetch(fileInfo.url, {
    headers: rangeHeader ? { Range: rangeHeader } : {},
  });

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('Error fetching file from Discord', 502);
  }

  const fileName = record.metadata.fileName || fileInfo.filename || fileId;
  const mimeType = getMimeType(fileName);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleHFFile(context, fileId, record = null) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['hf:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  if (shouldBlock(record.metadata)) {
    return blockRedirect(requestUrl, request);
  }
  if (shouldWhitelistDeny(env, record.metadata)) {
    return Response.redirect(`${requestUrl.origin}/whitelist-on.html`, 302);
  }

  const hfPath = record.metadata.hfPath;
  if (!hfPath) return errorResponse('HuggingFace path missing', 500);

  const rangeHeader = request.headers.get('Range');
  const upstream = await getHuggingFaceFile(hfPath, env, rangeHeader ? { range: rangeHeader } : {});

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('File not found on HuggingFace', upstream.status || 404);
  }

  const fileName = record.metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleWebDAVFile(context, fileId, record = null) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['webdav:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  if (shouldBlock(record.metadata)) {
    return blockRedirect(requestUrl, request);
  }
  if (shouldWhitelistDeny(env, record.metadata)) {
    return Response.redirect(`${requestUrl.origin}/whitelist-on.html`, 302);
  }

  const webdavPath = record.metadata.webdavPath || fileId.replace(/^webdav:/, '');
  if (!webdavPath) return errorResponse('WebDAV path missing', 500);

  const rangeHeader = request.headers.get('Range');
  const upstream = await getWebDAVFile(webdavPath, env, rangeHeader ? { range: rangeHeader } : {});
  if (!upstream) return errorResponse('File not found on WebDAV', 404);

  const fileName = record.metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleGitHubFile(context, fileId, record = null) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['github:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  if (shouldBlock(record.metadata)) {
    return blockRedirect(requestUrl, request);
  }
  if (shouldWhitelistDeny(env, record.metadata)) {
    return Response.redirect(`${requestUrl.origin}/whitelist-on.html`, 302);
  }

  const githubStorageKey = record.metadata.githubStorageKey || fileId.replace(/^github:/, '');
  const rangeHeader = request.headers.get('Range');
  const upstream = await getGitHubFile(
    githubStorageKey,
    record.metadata || {},
    env,
    rangeHeader ? { range: rangeHeader } : {}
  );

  if (!upstream) return errorResponse('File not found on GitHub', 404);

  const fileName = record.metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function findRecordByPrefixes(env, fileId, prefixes = []) {
  if (!env.img_url) return null;

  for (const prefix of prefixes) {
    const key = `${prefix}${fileId}`;
    const record = await env.img_url.getWithMetadata(key);
    if (record?.metadata) return record;
  }
  return null;
}

async function getTelegramFilePath(env, fileId) {
  try {
    const url = `${buildTelegramBotApiUrl(env, 'getFile')}?file_id=${encodeURIComponent(fileId)}`;
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) return null;

    const data = await response.json();
    if (!data?.ok || !data?.result?.file_path) return null;
    return data.result.file_path;
  } catch (error) {
    console.error('getTelegramFilePath failed:', error);
    return null;
  }
}
