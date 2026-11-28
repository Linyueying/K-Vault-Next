import { createS3Client } from '../utils/s3client.js';
import { parseByteLength, upstreamByteLength, withDownloadLength } from '../utils/download-length.js';
import { buildByteCacheKey, BYTE_CACHE_TTL_SECONDS, BYTE_CACHE_MAX_BYTES } from '../utils/byte-cache.js';
import { classifyR2Error, retryR2Op } from '../utils/r2-retry.js';
import { getDiscordFileUrl } from '../utils/discord.js';
import { getHuggingFaceFile } from '../utils/huggingface.js';
import { getWebDAVFile, headWebDAVFile } from '../utils/webdav.js';
import { getGitHubFile } from '../utils/github.js';
import {
  getRecordWithKey as findRecordWithKey,
  readDownloadCount,
  incrementDownloadCount,
  putRecordIndex,
  putKvFileMetadata,
  consumeDownloadQuota,
} from '../utils/file-record.js';
import {
  buildTelegramBotApiUrl,
  buildTelegramFileUrl,
  parseSignedTelegramFileId,
  shouldWriteTelegramMetadata,
} from '../utils/telegram.js';
import {
  consumeBundleDownloadQuota,
  incrementBundleDownloadCount,
  isBundleExpired,
  isBundleExhausted,
  readBundle,
  refundBundleDownloadQuota,
  verifyBundlePassword,
} from '../utils/share-bundle.js';

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
 * 这里做两件额外的事：
 *   1. 把「显式下载」请求的响应后处理一遍（详见 `applyDownloadDisposition`）。
 *      放在最外层统一处理，而不是改 7 个存储分支 —— 分支各自实现一遍
 *      attachment 头，早晚会漏掉一两个。
 *   2. 数字节 = 计次数（详见 `maybeCountBundleDownload`）。文件级的计数
 *      由内层在「拿到响应」后就发起，但那种写法要求响应本身成功（200/206）；
 *      合集这条路径上，上游存储不可用时会返回 500，配额就永远不动 ——
 *      而「请求确实打到了上游、只是上游挂了」并不该让访问者白嫖一次。
 *      所以连同文件级一起挪到最外层，用同一把尺子量。
 */
export async function onRequest(context) {
  const startedAt = Date.now();

  // ---- 字节缓存：命中就完全不必碰 D1 / KV / Telegram ----
  // 这是「国内用户 + Telegram 后端」唯一能把 TTFB 从跨洋降到 PoP 本地的手段。
  let response = await tryByteCacheMatch(context);
  const fromByteCache = Boolean(response);
  if (response) {
    response = conditionalFromByteCache(context, response);
  } else {
    response = await handleRequest(context);
  }

  /* HEAD 在进计次之前就脱掉 body：下游的 trackDownloadsIfNeeded 拿不到流，
     也就不会为一次「只问在不在」的探测去做流包装。 */
  const headless = stripBodyForHead(context.request, response);

  // 命中字节缓存时不落统计：能进缓存的文件全是「公开 + 无配额」的，
  // 它们的下载次数统计价值远低于首字节延迟，这里优先保速度。
  const tracked = fromByteCache
    ? headless
    : await trackDownloadsIfNeeded(context, headless);

  const tagged = await applyEntityTag(context, tracked);

  // 先判定「能不能缓存」再入缓存：storeByteCache 依赖这个标记，
  // 而它必须在同一请求内、拿到响应之后才能判（要算 status / Range）。
  markPublicCacheable(context, tagged);

  // 顺序不能反：storeByteCache 会把「累积字节」挂在响应流上并返回新的
  // 响应对象，disposition 必须基于**它返回的**那份改写 —— 否则两份响应
  // 会去读同一条流，后读的必然拿到空 body。
  const streamed = await storeByteCache(context, tagged);

  // 入缓存的是**未经 disposition 改写**的那份：键里不带 ?dl=1，
  // 预览与下载共用同一份字节，差异在交付前逐请求改写。
  const final = applyDownloadDisposition(context, streamed);
  flushBackground(context);

  return withDownloadLength(withTiming(context, final, startedAt));
}

/**
 * 生成稳定的实体标签（延迟优化 P1-2）。
 *
 * 输入刻意只用「标识字节内容」的字段，不含当前时间这类每次都变的量 ——
 * 否则 ETag 永远无法命中，304 形同虚设。
 */
/** @internal 供测试使用 */
export async function entityTagFor(metadata, kvKey) {
  const seed = [
    String(kvKey || ''),
    String(metadata?.fileSize || ''),
    String(metadata?.updatedAt || metadata?.uploadTime || metadata?.uploadedAt || ''),
    String(
      metadata?.telegramFileId ||
        metadata?.r2Key ||
        metadata?.s3Key ||
        metadata?.webdavPath ||
        metadata?.hfPath ||
        metadata?.githubPath ||
        ''
    ),
  ].join('|');
  return `"${(await sha256Hex(seed)).slice(0, 16)}"`;
}

/** 解析 If-None-Match：支持 `*`、多值与 `W/` 前缀。 */
/** @internal 供测试使用 */
export function parseETagList(raw) {
  const set = new Set();
  const value = String(raw || '').trim();
  if (!value) return set;
  for (const part of value.split(',')) {
    const token = part.trim();
    if (!token) continue;
    set.add(token);
    if (token.startsWith('W/')) set.add(token.slice(2));
  }
  return set;
}

/**
 * 推导文件的 Last-Modified 时间戳（毫秒）。
 * 优先取元数据更新时间/上传时间，其次取 R2 对象 uploaded 字段。
 */
function deriveLastModifiedMs(metadata = null, r2Object = null) {
  const raw =
    metadata?.updatedAt ??
    metadata?.uploadTime ??
    metadata?.uploadedAt ??
    metadata?.TimeStamp ??
    null;
  if (raw !== null && raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n > 1e11 ? n : n * 1000;
    const parsed = Date.parse(String(raw));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const uploaded = r2Object?.uploaded;
  if (uploaded instanceof Date && Number.isFinite(uploaded.getTime())) {
    return uploaded.getTime();
  }
  if (uploaded) {
    const parsed = Date.parse(String(uploaded));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/**
 * RFC 9110 §13.1.5 If-Range 校验：
 * - 无 If-Range 头 → 允许 Range（返回 true）
 * - ETag 形态（以 `"` 开头）→ 强比较（弱 ETag `W/` 永不匹配 If-Range）
 * - HTTP-date 形态 → 比较秒级 Last-Modified
 */
/** @internal 供测试使用 */
export function matchesIfRange(ifRangeHeader, entityTag, lastModifiedMs = 0) {
  const raw = String(ifRangeHeader || '').trim();
  if (!raw) return true;
  if (raw.startsWith('W/')) return false;
  if (raw.startsWith('"')) {
    return Boolean(entityTag) && raw === String(entityTag).trim();
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || !Number.isFinite(lastModifiedMs) || lastModifiedMs <= 0) {
    return false;
  }
  return Math.floor(lastModifiedMs / 1000) <= Math.floor(parsed / 1000);
}

/** RFC 9110 §13.1.3 If-Modified-Since 校验（秒级精度）。 */
function isNotModifiedSince(ifModifiedSinceHeader, lastModifiedMs) {
  const raw = String(ifModifiedSinceHeader || '').trim();
  if (!raw || !Number.isFinite(lastModifiedMs) || lastModifiedMs <= 0) return false;
  const sinceMs = Date.parse(raw);
  if (!Number.isFinite(sinceMs)) return false;
  return Math.floor(lastModifiedMs / 1000) <= Math.floor(sinceMs / 1000);
}

/** 304 响应：只有标签与缓存语义，不带 body。 */
function notModifiedResponse(entityTag, lastModifiedMs = 0) {
  const headers = new Headers();
  addCorsHeaders(headers);
  if (entityTag) headers.set('ETag', entityTag);
  if (lastModifiedMs > 0) headers.set('Last-Modified', new Date(lastModifiedMs).toUTCString());
  headers.set('Cache-Control', 'no-cache');
  headers.set('Server-Timing', 'app;dur=0');
  return new Response(null, { status: 304, headers });
}

/** 给 200 / 206 响应补上 ETag 与 Last-Modified，让下一次请求可走 304 且 Range 续传可用 If-Range 校验一致性。 */
async function applyEntityTag(context, response) {
  const tag = context?.__kvEntityTag;
  const lastModMs = Number(context?.__kvLastModifiedMs || 0);
  if (!response) return response;
  const status = Number(response.status);
  if (status !== 200 && status !== 206) return response;

  const needEtag = Boolean(tag) && !response.headers.get('ETag');
  const needLastMod = lastModMs > 0 && !response.headers.get('Last-Modified');
  if (!needEtag && !needLastMod) return response;

  try {
    const headers = new Headers(response.headers);
    if (needEtag) headers.set('ETag', tag);
    if (needLastMod) headers.set('Last-Modified', new Date(lastModMs).toUTCString());
    return new Response(response.body, {
      status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    console.warn('Failed to attach ETag:', error?.message || error);
    return response;
  }
}

/**
 * 附加耗时与缓存命中观测头。
 *
 * `Server-Timing` 是标准头，浏览器 DevTools 直接可读；两个 X- 头用于
 * 判断这一次到底省下了哪一跳 —— 没有它们，线上就只能靠感觉判断优化是否生效。
 */
function withTiming(context, response, startedAt) {
  try {
    if (!response?.headers) return response;
    const headers = new Headers(response.headers);
    headers.set('Server-Timing', `app;dur=${Date.now() - startedAt}`);
    if (context.__kvByteCache) headers.set('X-KVault-Byte-Cache', context.__kvByteCache);
    if (context.__kvTgPathSource) headers.set('X-KVault-TgPath', context.__kvTgPathSource);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    console.warn('Failed to attach timing headers:', error?.message || error);
    return response;
  }
}

/** 取请求的文件 ID（params.path 可能是数组）。 */
function requestFileId(context) {
  let fileId = context?.params?.path;
  if (Array.isArray(fileId)) fileId = fileId.join('/');
  return String(fileId || '');
}

/**
 * 后台任务收集器。
 *
 * Worker 在被回收前会等 waitUntil 的任务跑完 —— 记录缓存回填、字节缓存
 * 写入这类「丢了只是下次 miss、不影响正确性」的活挂在这里最合适：
 * 既不阻塞首字节，又不会因为 Worker 被提前回收而白白丢掉。
 */
function ensureBackground(context) {
  if (!Array.isArray(context.__kvBackground)) context.__kvBackground = [];
  return context.__kvBackground;
}

function flushBackground(context) {
  const jobs = context.__kvBackground;
  if (Array.isArray(jobs) && jobs.length && typeof context.waitUntil === 'function') {
    context.waitUntil(Promise.allSettled(jobs));
  }
}

// ============================================================================
// 字节缓存（延迟优化 P0-3 + 并发内存安全 + HEAD / Range 边缘命中）
// ============================================================================
// isolate 级旁路缓存缓冲预算（48MB）与单飞去重表：
//   - 同一文件并发回源时只有 1 路做缓冲写入，避免 N × 64MB 把 128MB isolate 打爆；
//   - 多文件并发回源时，超预算的后发请求自动退化为纯透传（仍优先允许单路文件最高缓冲至 BYTE_CACHE_MAX_BYTES）。
const BYTE_CACHE_INFLIGHT_BUDGET = 48 * 1024 * 1024;
const inFlightByteCacheKeys = new Set();
let inflightByteCacheBytes = 0;

/**
 * 尝试从边缘缓存取字节。命中则后续完全不必碰任何后端。
 *
 * 支持：
 *   - 完整 GET 命中（<5ms PoP 本地吐字节）
 *   - HEAD 命中（复用 GET 缓存键，外层 stripBodyForHead 脱体，<5ms 0 回源）
 *   - Range 命中（当运行时的 Cache API 原生从 200 缓存切片返回 206 时直接命中；
 *     若携带 If-Range 且不匹配则直接返回完整 200；否则透传回源 Range）
 *
 * @returns {Promise<Response|null>} 命中返回可直接交付的响应，否则 null
 */
async function tryByteCacheMatch(context) {
  const { request } = context;
  context.__kvByteCache = 'BYPASS';

  // 运行环境没有 Cache API（本地 node 测试、非 Worker 运行时）时静默跳过：
  // 打到这里的每一次都记一条 warn 只会把真正的异常淹掉。
  if (typeof caches === 'undefined' || !caches?.default) return null;
  const method = String(request.method || '').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (context.__kvBundleAccess || context.__kvSignedLink) return null;

  const baseKey = buildByteCacheKey(request.url, requestFileId(context));
  const rangeHeader = method === 'GET' ? request.headers.get('Range') : null;

  try {
    if (rangeHeader) {
      const rangedReq = new Request(baseKey.url, {
        method: 'GET',
        headers: { Range: rangeHeader },
      });
      const cached = await caches.default.match(rangedReq);
      if (!cached) return null;

      const ifRange = request.headers.get('If-Range');
      const cachedEtag = cached.headers.get('ETag');
      const cachedLastMod = Date.parse(cached.headers.get('Last-Modified') || '') || 0;
      const ifRangeOk = matchesIfRange(ifRange, cachedEtag, cachedLastMod);

      if (cached.status === 206 && ifRangeOk) {
        context.__kvByteCache = 'HIT';
        return cached;
      }
      if (cached.status === 200 && !ifRangeOk) {
        context.__kvByteCache = 'HIT';
        return cached;
      }
      // Cache API 未原生切片（返回 200 但客户端要 206）→ 释放流并走回源 Range
      if (cached.body && typeof cached.body.cancel === 'function') {
        cached.body.cancel().catch(() => {});
      }
      return null;
    }

    const cached = await caches.default.match(baseKey);
    if (!cached) {
      context.__kvByteCache = method === 'GET' ? 'MISS' : 'BYPASS';
      return null;
    }
    context.__kvByteCache = 'HIT';
    return cached;
  } catch (error) {
    console.warn('byte cache match failed:', error?.message || error);
    return null;
  }
}

/**
 * 命中字节缓存后仍然支持条件请求（If-None-Match 与 If-Modified-Since）。
 *
 * @param {object} context
 * @param {Response} cached
 * @returns {Response} 命中条件请求时返回 304，否则原样返回
 */
function conditionalFromByteCache(context, cached) {
  try {
    if (!cached || Number(cached.status) !== 200) return cached;
    const tag = cached.headers?.get('ETag');
    const lastModHeader = cached.headers?.get('Last-Modified');
    const lastModMs = lastModHeader ? Date.parse(lastModHeader) || 0 : 0;

    const rawIfNoneMatch = context?.request?.headers?.get('If-None-Match');
    if (rawIfNoneMatch) {
      if (tag) {
        const noneMatch = parseETagList(rawIfNoneMatch);
        if (noneMatch.has('*') || noneMatch.has(tag)) {
          if (cached.body && typeof cached.body.cancel === 'function') {
            cached.body.cancel().catch(() => {});
          }
          return notModifiedResponse(tag, lastModMs);
        }
      }
      return cached;
    }

    const rawIfModSince = context?.request?.headers?.get('If-Modified-Since');
    if (rawIfModSince && isNotModifiedSince(rawIfModSince, lastModMs)) {
      if (cached.body && typeof cached.body.cancel === 'function') {
        cached.body.cancel().catch(() => {});
      }
      return notModifiedResponse(tag, lastModMs);
    }
    return cached;
  } catch (error) {
    console.warn('conditional byte cache check failed:', error?.message || error);
    return cached;
  }
}

/**
 * 把响应接进边缘缓存，并返回**供客户端消费**的响应。
 *
 * 结合单流截获 + isolate 级单飞去重 + 并发字节预算 + cancel 及时释放，
 * 保证高并发大文件回源既不断流，也不会打爆 128MB Worker 内存上限。
 *
 * @param {object} context
 * @param {Response} response
 * @returns {Promise<Response>} 可能与入参相同，也可能是包了截获流的响应
 */
async function storeByteCache(context, response) {
  const { request } = context;

  if (typeof caches === 'undefined' || !caches?.default) return response;
  if (context.__kvByteCache !== 'MISS') return response;   // 只有这次真的回源了才需要写
  if (!context.__kvPublicCacheable) return response;       // 闸门判定：必须公开不可变
  if (Number(response?.status) !== 200) return response;
  if (!response.body) return response;

  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > BYTE_CACHE_MAX_BYTES) return response;

  const cacheKey = buildByteCacheKey(request.url, requestFileId(context));
  const cacheUrl = cacheKey.url;

  // 单飞去重：同 isolate 上已有同键在缓冲写缓存，后续并发请求直接透传不再重复占内存
  if (inFlightByteCacheKeys.has(cacheUrl)) return response;
  // 若已有其他大文件占用较多缓冲且当前声明体积会突破并发预算，直接透传保稳定
  if (
    inflightByteCacheBytes > 0 &&
    Number.isFinite(declared) &&
    declared > 0 &&
    inflightByteCacheBytes + declared > BYTE_CACHE_INFLIGHT_BUDGET
  ) {
    return response;
  }

  inFlightByteCacheKeys.add(cacheUrl);

  // 单流截获：变换里先 enqueue 再累积，客户端永远不等缓存。
  const chunks = [];
  let total = 0;
  let overflow = false;
  let released = false;

  const releaseAccounting = () => {
    if (released) return;
    released = true;
    inFlightByteCacheKeys.delete(cacheUrl);
    if (total > 0) {
      inflightByteCacheBytes = Math.max(0, inflightByteCacheBytes - total);
      total = 0;
    }
    chunks.length = 0;
  };

  const tap = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (overflow) return;
      const len = chunk.byteLength;
      const nextTotal = total + len;
      const otherInflight = inflightByteCacheBytes - total;
      const exceedsSoloCap = nextTotal > BYTE_CACHE_MAX_BYTES;
      const exceedsConcurrentCap = otherInflight > 0 && otherInflight + nextTotal > BYTE_CACHE_INFLIGHT_BUDGET;
      if (exceedsSoloCap || exceedsConcurrentCap) {
        overflow = true;
        releaseAccounting();
        return;
      }
      total = nextTotal;
      inflightByteCacheBytes += len;
      chunks.push(chunk);
    },
    flush() {
      if (overflow || total <= 0) {
        releaseAccounting();
        return;
      }
      const finalSize = total;
      let blob;
      try {
        blob = new Blob(chunks);
      } catch (error) {
        console.warn('byte cache blob build failed:', error?.message || error);
        releaseAccounting();
        return;
      }
      // 构造 Blob 后立即清空 chunks 引用并归还并发预算
      releaseAccounting();
      try {
        const headers = new Headers(response.headers);
        headers.set('Cache-Control', `public, max-age=${BYTE_CACHE_TTL_SECONDS}`);
        headers.set('Content-Length', String(finalSize));
        const job = caches.default
          .put(cacheKey, new Response(blob, { status: 200, headers }))
          .catch((error) => console.warn('byte cache put failed:', error?.message || error));
        if (typeof context.waitUntil === 'function') context.waitUntil(job);
        else ensureBackground(context).push(job);
      } catch (error) {
        console.warn('byte cache put failed:', error?.message || error);
      }
    },
    cancel() {
      // 客户端中途断开下载时立刻释放已累积的缓冲区
      overflow = true;
      releaseAccounting();
    },
  });

  return new Response(response.body.pipeThrough(tap), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * 判定「这个文件能不能被当作不可变的公开资源缓存」，并把结论挂到 context。
 *
 * 这是整个下载链路里**唯一**决定「能不能缓存」的地方：字节缓存的
 * 存取两侧都读这个标记，所以同一份事实不会被判两遍而漂移。
 *
 * 三条排除规则（见 isImmutablePublic）：带密码 / 有有效期 / 有次数上限；
 * 另外合集成员与签名直链也在调用点被排除 —— 它们受各自的闸门保护，
 * 一旦进边缘缓存，闸门就绕过去了。
 *
 * 只做判定、**不改写响应**：给不给浏览器缓存由字节缓存命中时自带的
 * Cache-Control 决定，这里不再额外加一层短时缓存头（那会引入第二个
 * 残留窗口，却没有对应的清理路径）。
 */
/** @internal 供测试使用 */
export function markPublicCacheable(context, response) {
  try {
    if (!response || Number(response.status) !== 200) return;
    if (String(context?.request?.method || '').toUpperCase() !== 'GET') return;
    // 分段响应（206/Range）与带 Range 的请求不进：缓存键里没有 Range，
    // 不同区间的响应会互相污染。
    if (context.request.headers.get('Range')) return;
    // 合集成员文件受合集密码与配额保护；签名直链自带有效期 —— 都不缓存。
    if (context.__kvBundleAccess || context.__kvSignedLink) return;
    if (!isImmutablePublic(context.__kvFileMetadata)) return;

    context.__kvPublicCacheable = true;
  } catch (error) {
    console.warn('Failed to mark public cacheable:', error?.message || error);
  }
}

/**
 * 该文件是否可以安全地当作不可变公共资源缓存。
 *
 * 三条排除规则，任一命中就禁缓存：
 *   · 有有效期（shareExpiresAt）
 *   · 有密码（sharePasswordHash）
 *   · 有下载次数上限（shareMaxDownloads > 0）
 * 这三者都是「闸门」，而闸门一旦被边缘缓存跳过就形同虚设。
 */
function isImmutablePublic(metadata) {
  if (!metadata || typeof metadata !== 'object') return false;
  if (metadata.isFolder === true) return false;
  if (Number(metadata.shareExpiresAt || 0) > 0) return false;
  if (metadata.sharePasswordHash) return false;
  if (Number(metadata.shareMaxDownloads || 0) > 0) return false;
  return true;
}

/**
 * HEAD 响应收敛：只保留状态行与响应头，不带 body。
 *
 * 每个存储分支都是照着 GET 写的（拉对象 / 拉上游），对 HEAD 也原样跑一遍。
 * 与其让分支各自判断 method，不如在最外层统一脱 body —— 顺带保证 workerd
 * 不再去 pull 那条流。
 *
 * 注意这只能省掉「边缘 → 客户端」这一段的开销；真正省掉上游读取的，是
 * R2 分支里改用 `head()` 的短路（见 handleR2File）。
 *
 * @param request - 原始请求。
 * @param response - 待收敛的响应。
 * @returns 无 body 的响应（非 HEAD 或本来就没 body 时原样返回）。
 */
function stripBodyForHead(request, response) {
  if (!response) return response;
  if (String(request?.method || '').toUpperCase() !== 'HEAD') return response;
  if (!response.body) return response;

  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * 核销一次分享下载（乐观计数）。
 *
 * 判断只有一条：`shouldCountAsDownload` —— 是不是一次真正的下载请求。
 * 命中就用 `waitUntil` 落账，响应**原样放行**，不碰响应体。
 *
 * 为什么不再「等字节发完再记」：那需要在响应流上挂钩子（旧实现是把 body
 * 包进自定义 ReadableStream 数字节），而 workerd 一旦发现 body 被重新包装，
 * 就会剥掉显式设置的 Content-Length、退化成 chunked —— 浏览器（尤其手机端）
 * 拿不到长度，下载框显示 0 B、进度条不动，看起来和卡死没区别。
 * 保住长度，比「数完字节才算数」重要得多。
 *
 * 计次语义因此从「字节交付完成」放宽为「字节开始交付」：用户中途取消也会
 * 记一次。这与「上游 5xx 仍计次」是同一个取舍（见下）—— 宁可多记一次，
 * 也不留下一个反复重放就能绕过配额的入口。
 *
 * @param context - Pages 请求上下文。
 * @param response - 已生成的响应（HEAD 在进这里之前已是无 body 响应）。
 * @returns 原响应。
 */
async function trackDownloadsIfNeeded(context, response) {
  const pending = context.__kvTrackPending;
  // 无待记账目标 → 不是分享链接，直接放行（绝大多数请求走这条）。
  if (!pending || !response) return response;
  if (!pending.file && !pending.bundle) return response;

  // 【语义】只有真正开始交付字节（200 / 206）才消耗配额。
  // 上游 5xx、416 等失败响应一个字节都没交付，客户端重试是合理行为，
  // 因此预占的那一次必须退还（见下方的回滚分支）。
  //
  // 「反复制造失败来绕过配额」这个担心不成立：绕过配额的前提是拿到字节，
  // 而拿到字节的那一次必然是 200/206，必然计数。
  const counting = shouldCountAsDownload(context.request, response);

  // ---------------------------------------------------------------------------
  // 预占回滚：D1 原子预占发生在响应生成之前，若最终响应不属于「已交付」
  // （404 路径不存在 / 上游 5xx / 416 / 闸门拦下），预占的那一次配额
  // 必须补回 —— 否则用户会为一次失败的访问白付配额。
  //
  // 注意这与旧实现的一个细微差异：旧实现是「成功才计数」，天然不会白吃；
  // 新实现是「先占后核」，因此需要显式回滚。回滚失败只告警，不影响响应。
  // ---------------------------------------------------------------------------
  if ((context.__kvQuotaConsumed || context.__kvBundleQuotaConsumed) && !counting) {
    if (typeof context.waitUntil === 'function') {
      context.waitUntil(refundCheckout(context, pending).catch(() => {}));
    }
  }

  if (counting && typeof context.waitUntil === 'function') {
    context.waitUntil(settleTrackCounts(context, pending));
  }

  // 计次无需读取响应体，最终交付统一保留已知长度。
  return response;
}

/**
 * 补回一次被预占但最终未成立的配额。
 *
 * 只在「D1 已原子预占」+「最终响应不该计数」的交叉情况下调用。
 * D1 里做 -1（下限 0），避免负数。
 *
 * @param context - Pages 请求上下文。
 * @param pending - 暂存对象（需带 file.kvKey）。
 */
async function refundCheckout(context, pending) {
  const env = pending?.env || context.env;
  const jobs = [];

  if (pending?.file?.kvKey && context.__kvQuotaConsumed) {
    jobs.push(
      (async () => {
        const { refundQuota } = await import('../utils/file-record.js');
        await refundQuota(env, pending.file.kvKey);
      })().catch((error) => {
        console.warn('Failed to refund download quota:', error?.message || error);
      })
    );
  }

  // 合集预占同样要退还：否则一次 500 会吃掉合集的下载次数，
  // 而用户什么都没拿到。
  if (pending?.bundle?.slug && context.__kvBundleQuotaConsumed) {
    jobs.push(
      refundBundleDownloadQuota(env, pending.bundle.slug).catch((error) => {
        console.warn('Failed to refund bundle quota:', error?.message || error);
      })
    );
  }

  if (!jobs.length) return;
  await Promise.allSettled(jobs);
}

/**
 * 把「这一请求该记在哪本账上」暂存到 context，交给外层计次。
 *
 * 为什么不在当前层直接计次：计次要同时看到「是不是一次下载请求」和最终的
 * 响应状态（闸门可能在这一层之后才把它判成 401/403/410），这两样只有
 * 最外层才拿得全。内层只登记、不落账。
 *
 * `shareAccess` 必须是原始对象，不能是可能为 null 的中间值：
 * 这里只在它带 `trackDownload` 时才记，语义与旧的 inline 判断一致。
 *
 * @param context - Pages 请求上下文。
 * @param shareAccess - `verifyShareAccess()` 的返回值（可为 null）。
 * @param bundleAccess - `verifyBundleAccess()` 的返回值。
 */
function rememberTrackTargets(context, shareAccess, bundleAccess = {}) {
  const file =
    shareAccess?.trackDownload && shareAccess.kvKey
      ? { kvKey: shareAccess.kvKey, metadata: shareAccess.metadata }
      : null;
  const bundle = bundleAccess?.trackDownload && bundleAccess.slug ? { slug: bundleAccess.slug } : null;
  // 两个目标都不存在时不要设置 pending：普通（非分享）下载占绝大多数，
  // 没有记账目标就没有理由让它们多走一层判断。
  if (!file && !bundle) return;
  context.__kvTrackPending = { env: context.env, file, bundle };
}

/**
 * 真正落账：文件级与合集级各记一次。
 *
 * 只在响应体读完（字节确实交付完）之后调用。放在这里而不是发起时，
 * 是为了让「上游失败」不消耗配额。
 *
 * @param context - Pages 请求上下文。
 * @param pending - {@link rememberTrackTargets} 写入的暂存对象。
 */
async function settleTrackCounts(context, pending) {
  const env = pending.env || context.env;

  const jobs = [];
  // 文件级：若 verifyShareAccess 已用 D1 原子预占过配额，这里不再重复落账。
  // （D1 未绑定时不会设置该标记，仍走旧的 increment 路径。）
  if (pending.file && !context.__kvQuotaConsumed) {
    jobs.push(incrementShareDownloadCount(env, pending.file.kvKey, pending.file.metadata));
  }
  // 合集与文件同一把尺子：D1 已原子预占过就不再重复 +1。
  if (pending.bundle && !context.__kvBundleQuotaConsumed) {
    jobs.push(incrementBundleDownloadCount(env, pending.bundle.slug));
  }
  if (!jobs.length) return;

  await Promise.allSettled(jobs);
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

    // background 收集器提前初始化：保证签名直链与普通路径都能通过 waitUntil 落地记录缓存回填。
    const background = ensureBackground(context);

    // 合集成员链接（`?b=<slug>`）先过合集这道闸门。放在最前面是因为合集
    // 自带密码与独立配额：过期/超次/密码不对时，没必要再去读文件元数据。
    const bundleAccess = await verifyBundleAccess(context);
    if (bundleAccess.response) return bundleAccess.response;
    // 合集成员文件：受合集自身的密码与配额保护，公共缓存必须让路
    if (bundleAccess?.slug) context.__kvBundleAccess = true;

    const signedTelegramMeta = await parseSignedTelegramFileId(fileId, env);
    if (signedTelegramMeta) {
      // 签名直链自带有效期，同样不进公共缓存
      context.__kvSignedLink = true;
      // Signed links must go through the same share controls as the regular
      // path. Previously this branch returned before any of them ran, so
      // expiry / password / download cap were all silently bypassed.
      const signedRecord = await getRecordWithKey(
        env,
        `${signedTelegramMeta.fileId}.${signedTelegramMeta.fileExtension || 'bin'}`,
        { background }
      );
      // getRecordWithKey 返回 { record, kvKey }，其中 record 才是
      // getWithMetadata 的 { value, metadata }。少一层 .record 会让
      // signedMetadata 恒为 null —— 分享闸门全部静默跳过。
      const signedMetadata = signedRecord?.record?.metadata || null;

      let signedShareAccess = null;
      if (signedMetadata) {
        signedShareAccess = await verifyShareAccess(context, signedMetadata, signedRecord.kvKey);
        if (signedShareAccess?.response) {
          return signedShareAccess.response;
        }
      }

      const signedResponse = await handleSignedTelegramFile(context, signedTelegramMeta);

      // 计次不在分支里做：等外层确认「字节真的开始流出」再计。
      rememberTrackTargets(context, signedShareAccess, bundleAccess);

      return signedResponse;
    }

    const recordResult = await getRecordWithKey(env, fileId, { background });
    const record = recordResult?.record;
    const kvKey = recordResult?.kvKey || fileId;

    // 供外层判定「能否安全缓存」（见 markPublicCacheable）
    context.__kvFileMetadata = record?.metadata || null;

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

    // ---- 条件请求：ETag / If-Modified-Since 命中就不必再打扰上游 ----
    // 浏览器或下载器重复请求同一文件时，这一条能省掉整条链路，直接返回 304。
    const requestMethod = String(request.method || '').toUpperCase();
    if (record?.metadata && (requestMethod === 'GET' || requestMethod === 'HEAD')) {
      const entityTag = await entityTagFor(record.metadata, kvKey);
      const lastModifiedMs = deriveLastModifiedMs(record.metadata);
      context.__kvEntityTag = entityTag;
      if (lastModifiedMs > 0) context.__kvLastModifiedMs = lastModifiedMs;

      const rawIfNoneMatch = request.headers.get('If-None-Match');
      if (rawIfNoneMatch) {
        const noneMatch = parseETagList(rawIfNoneMatch);
        if (noneMatch.has('*') || noneMatch.has(entityTag)) {
          return notModifiedResponse(entityTag, lastModifiedMs);
        }
      } else if (!request.headers.get('Range')) {
        const rawIfModSince = request.headers.get('If-Modified-Since');
        if (rawIfModSince && isNotModifiedSince(rawIfModSince, lastModifiedMs)) {
          return notModifiedResponse(entityTag, lastModifiedMs);
        }
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

    rememberTrackTargets(context, shareAccess, bundleAccess);

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
  headers.set('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin, If-None-Match, If-Modified-Since, If-Range');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition, ETag, Last-Modified, X-KVault-Byte-Cache, X-KVault-Storage, X-KVault-Chunk-Size, Retry-After');
  headers.set('CDN-Cache-Control', 'no-store');
  return headers;
}

function addResponseHeaders(headers, fileName, mimeType, upstream = null, fullSize = null) {
  addCorsHeaders(headers);
  headers.set('Content-Type', mimeType || 'application/octet-stream');
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('Accept-Ranges', 'bytes');

  if (fileName) {
    const encoded = encodeURIComponent(fileName);
    headers.set('Content-Disposition', `inline; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  }

  if (upstream) {
    const length = upstreamByteLength(upstream, fullSize);
    const contentRange = upstream.headers.get('Content-Range');
    if (length !== null) headers.set('Content-Length', String(length));
    if (contentRange) headers.set('Content-Range', contentRange);
  }
}

function handleOptions() {
  const headers = new Headers();
  addCorsHeaders(headers);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

function errorResponse(message, status = 500, extraHeaders = null) {
  const headers = new Headers();
  addCorsHeaders(headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v !== undefined && v !== null) headers.set(k, String(v));
    }
  }
  return new Response(message, { status, headers });
}

/** 请求是否为 HEAD（只问元数据、不要字节）。 */
function isHeadRequest(request) {
  return String(request?.method || '').toUpperCase() === 'HEAD';
}

/**
 * 构造只有响应头、没有 body 的 HEAD 响应。
 *
 * 外层 stripBodyForHead 已经能脱掉 body，但那是**下载之后**再丢掉：
 * 上游的字节已经跨网络走了一趟。真正的省法是在存储分支里就不要发起
 * 下载 —— 本函数是那些分支的统一收口。
 */
function headOnlyResponse(fileName, mimeType, contentLength) {
  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType);
  const length = parseByteLength(contentLength);
  if (length !== null) headers.set('Content-Length', String(length));
  return new Response(null, { status: 200, headers });
}

async function getRecordWithKey(env, fileId, options = {}) {
  // 统一走 utils/file-record.js：带前缀 ID 行为不变，裸 ID 走索引加速；
  // 透传 options.background，确保 L2 记录缓存回填挂入 context.waitUntil 不被提前回收。
  return findRecordWithKey(env, fileId, options);
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
  const hasLimit = Number.isFinite(maxDownloads) && maxDownloads > 0;

  // 密码先于配额校验：密码不对不应消耗任何配额。
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

  // ---------------------------------------------------------------------------
  // 配额校验：D1 走「原子预占」，KV 走「读-判断」（旧行为）
  //
  // 只有显式下载（`?dl=1`）才消耗配额 —— 预览（视频拖拽产生的 Range 请求）
  // 不应吃配额。判断在 URL 上就能得出，无需等响应，因此可以在此预占。
  //
  // D1 路径把「是否超限」与「计数 +1」压成一条 UPDATE，从根上消除并发超发
  // （旧 KV 实现两步分离：并发下两个请求可以同时通过「未超限」判断）。
  // 预占成功后在 context 上标记，外层 trackDownloadsIfNeeded 会跳过重复计次。
  // ---------------------------------------------------------------------------
  if (hasLimit) {
    const counting = isExplicitDownload(context.request);

    if (counting) {
      const quota = await consumeDownloadQuota(context.env, kvKey);
      if (quota.limited) {
        // D1 明确判定已达上限
        return { response: errorResponse('File download limit reached', 410) };
      }
      if (quota.ok) {
        // 原子预占成功：标记已计次，外层不再重复落账
        context.__kvQuotaConsumed = true;
        // 与合集同理：预占后可能被后续闸门提前返回，
        // 先把记账目标挂上，保证失败时能退款。
        context.__kvTrackPending = {
          env: context.env,
          file: { kvKey, metadata },
          bundle: context.__kvTrackPending?.bundle || null,
        };
      } else {
        // D1 未绑定 / 记录不在 D1 → 回落旧的「读-判断」逻辑
        const currentDownloads = await readDownloadCount(context.env, kvKey, metadata);
        if (currentDownloads >= maxDownloads) {
          return { response: errorResponse('File download limit reached', 410) };
        }
      }
    } else {
      // 非显式下载（预览）：只做只读校验，不消耗配额
      const currentDownloads = await readDownloadCount(context.env, kvKey, metadata);
      if (currentDownloads >= maxDownloads) {
        return { response: errorResponse('File download limit reached', 410) };
      }
    }
  }

  return {
    response: null,
    trackDownload: hasLimit,
    kvKey,
    metadata,
  };
}

/**
 * 校验「这次请求是否来自一个合集」。
 *
 * 分享页的合集成员链接会带上 `?b=<slug>`，于是同一个文件可以经由两条完全
 * 独立的配额体系被下载：
 *   · 文件自身的分享属性（`shareMaxDownloads` 等）
 *   · 所属合集的配额与密码
 *
 * 合集是**独立实体**，它的配额不能靠文件元数据推断，必须回查合集体。
 * 两套校验都要跑：文件级管「这个文件自己被限制了多少次」，
 * 合集级管「这个链接整体被限制了多少次」。
 *
 * 状态码与 `/api/share-info` 的合集分支保持一致（410 过期 / 410 超次 /
 * 401 缺密码 / 403 密码错误），免得同一个链接在不同入口给出不同解释。
 *
 * 只有显式带 `dl=1` 的请求才计次，理由与文件级计数相同：预览不该吃配额。
 *
 * @returns `{ response, trackDownload, slug }`；`response` 非空表示应直接返回。
 */
async function verifyBundleAccess(context) {
  const url = new URL(context.request.url);
  const slug = String(url.searchParams.get('b') || '').trim().toLowerCase();
  if (!slug) return { response: null, trackDownload: false, slug: '' };

  const bundle = await readBundle(context.env, slug);
  if (!bundle) return { response: errorResponse('Bundle not found', 404), trackDownload: false, slug };

  if (isBundleExpired(bundle)) {
    return { response: errorResponse('Bundle link has expired', 410), trackDownload: false, slug };
  }

  // ---------------------------------------------------------------------------
  // 配额：显式下载走 D1 原子预占，与文件级同一套语义
  //
  // 旧实现是「先读 bundle 判断是否超限 → 放行 → 事后 +1」，两步分离，
  // 并发请求可以同时通过「未超限」判断而超发。新的 consumeBundleDownloadQuota
  // 用一条 UPDATE 把「判上限」与「+1」压在一起（详见 utils/bundle-store.js）。
  //
  // 密码校验必须排在配额之前：密码不对不应消耗任何配额。
  // 预览（非 dl=1）只做只读校验，不吃配额。
  // ---------------------------------------------------------------------------
  const verdict = await verifyBundlePassword(bundle, getSharePassword(context.request));
  if (verdict === 'missing') {
    return { response: errorResponse('Bundle password required', 401), trackDownload: false, slug };
  }
  if (verdict === 'invalid') {
    return { response: errorResponse('Bundle password invalid', 403), trackDownload: false, slug };
  }

  const explicit = isExplicitDownload(context.request);

  if (explicit) {
    const quota = await consumeBundleDownloadQuota(context.env, slug);
    if (quota.limited) {
      return { response: errorResponse('Bundle download limit reached', 410), trackDownload: false, slug };
    }
    if (quota.ok) {
      // 原子预占成功：标记已计次，外层不再重复 +1；若最终响应未交付字节，
      // 外层的回滚会把这一次补回。
      context.__kvBundleQuotaConsumed = true;
      // 【关键】立刻把记账目标挂到 context 上。
      // 预占之后请求可能被引擎提前返回（文件级 410 超限 / 401 缺密码 /
      // 404 路径不存在），那些 return 发生在 rememberTrackTargets 之前 ——
      // 若只依赖后者，pending 为空，退款逻辑找不到目标，这一次配额就泄漏了。
      context.__kvTrackPending = {
        env: context.env,
        file: context.__kvTrackPending?.file || null,
        bundle: { slug },
      };
      return { response: null, trackDownload: true, slug };
    }
    // disabled（D1 未绑定）/ error：回落到旧的读-判断。
    // error 不能被当成 limited —— 那是把存储故障伪装成「配额用完了」。
    if (quota.error) {
      console.warn('Bundle quota consume failed, falling back to read check:', quota.error);
    }
  }

  if (isBundleExhausted(bundle)) {
    return { response: errorResponse('Bundle download limit reached', 410), trackDownload: false, slug };
  }

  return { response: null, trackDownload: true, slug };
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
 * 实际判定落在 `trackDownloadsIfNeeded()` 里（那里拿得到状态码与响应体），
 * 保留本函数是为了让「什么叫一次下载」这件事只有一处定义。
 *
 * @param request - 原始请求。
 * @param response - 已生成的响应。
 * @returns 是否计数。
 */
function shouldCountAsDownload(request, response) {
  if (String(request?.method || '').toUpperCase() !== 'GET') return false;
  if (!response) return false;
  if (!isExplicitDownload(request)) return false;
  // 只有字节真的开始交付（200 全量 / 206 分段）才算一次下载。
  // 闸门拦下（401/403/410）、路径不存在（404）、上游失败（5xx）、
  // Range 不合法（416）都没有交付任何字节 —— 它们不该消耗配额，
  // 而客户端的自动重试也不该因此把用户的配额刷光。
  const status = Number(response.status);
  return status === 200 || status === 206;
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

  const metadata = record?.metadata || {};
  const fileName = metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  // Telegram 虚拟分片对象：流式拼接 + 跨分片原生 Range
  if (
    metadata.telegramChunked === true &&
    Array.isArray(metadata.telegramChunks) &&
    metadata.telegramChunks.length > 0
  ) {
    return handleChunkedTelegramFile(context, fileId, record);
  }

  // 优先用 metadata 里记录的 file_id，其次才回退到「kvKey 第一段即 file_id」
  // 的历史约定。
  //
  // 为什么需要这个回退顺序：`split('.')[0]` 只在「kvKey 恰好是 `<fileId>.<ext>`
  // 且文件名不含 `/`」时成立 —— 那是网页上传的形态。WebDAV 服务端的 kvKey 是
  // DAV 路径（如 `rikkahub_backups/a.json`），沿用旧写法会推导出
  // `rikkahub_backups/a`，拿去调 getFile 必然失败并返回 500。
  //
  // 既有记录不受影响：网页上传的 metadata.telegramFileId 与旧推导结果一致，
  // 两条路径得到同一个值（upload.js / upload-from-url.js / webhook.js /
  // chunked-upload / v1/import.js 均会写入该字段）。
  const telegramFileId =
    metadata.telegramFileId || String(fileId).split('.')[0];

  const filePath = await getTelegramFilePathCached(env, telegramFileId, context);
  if (!filePath) {
    return errorResponse('Failed to get file path from Telegram', 500);
  }

  let upstream = await fetchTelegramUpstream(env, context.request, filePath);

  // 路径失效兜底：Telegram 偶尔会轮换 file_path，此时 persist 下来的旧值
  // 会让每一次后续下载都失败 —— 失效后重新解析一次，而不是直接报错。
  if (!telegramUpstreamOk(upstream)) {
    await invalidateTelegramFilePath(env, telegramFileId);
    const refreshed = await getTelegramFilePathCached(env, telegramFileId, context);
    if (refreshed && refreshed !== filePath) {
      upstream = await fetchTelegramUpstream(env, context.request, refreshed);
    }
  }

  if (!telegramUpstreamOk(upstream)) {
    return errorResponse('Failed to fetch file from Telegram', upstream?.status || 502);
  }

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * 打开单个 Telegram 分片的指定字节切片，带 file_path 失效自愈、5xx/429 瞬态退避重试与本地精准切片。
 *
 * 关键稳定性修复：
 * 1. 不再向 `api.telegram.org/file/bot...` 发送 `Range` 头：Telegram 官方文件服务对 Range 行为不一致，
 *    断点续传（尤其是最后 1% 落入末片中间偏移时）带 Range 极易触发上游 502/400/416 或连接重置。
 *    改为始终 plain GET（单片 <=18MB）并流式跳过前 `reqStart` 字节，零额外内存且 100% 稳定。
 * 2. 透传 `getFile` 的真实 429 Retry-After / 503 subrequestLimit / 具体上游错误，不再全部吞成黑盒 502。
 * 3. 对上游响应头等待加 25s 超时（收到头后立即清定时器，不影响慢速客户端流式传输），防止僵尸连接拖出 CF 502/524。
 */
async function openTelegramChunkSlice(
  env,
  context,
  item,
  resumeOffset = 0,
  preResolvedPath = null,
  options = null
) {
  const reqStart = item.sliceStart + resumeOffset;
  const reqEnd = item.sliceEnd;
  const needBytes = item.sliceLen - resumeOffset;
  if (needBytes <= 0) {
    return { ok: false, status: 500, error: 'Invalid chunk slice range' };
  }

  const multiChunk = options?.multiChunk === true;
  const pathCacheOpts = multiChunk ? TG_CHUNK_STREAM_PATH_OPTS : TG_CHUNK_PATH_CACHE_OPTS;

  let filePath = preResolvedPath;
  if (!filePath) {
    const resolved = await resolveTelegramFilePathDetailed(env, item.fileId, context, pathCacheOpts);
    if (!resolved.ok || !resolved.path) {
      return {
        ok: false,
        status: resolved.status || 503,
        retryAfter: resolved.retryAfter || (resolved.status === 503 ? 2 : 0),
        subrequestLimit: Boolean(resolved.subrequestLimit),
        error: resolved.error || `Failed to get chunk ${item.chunkIndex} file path from Telegram`,
      };
    }
    filePath = resolved.path;
  }

  const HEADER_TIMEOUT_MS = 25 * 1000;
  const doFetch = async (targetPath) => {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    if (ctrl) {
      timer = setTimeout(() => {
        try { ctrl.abort(); } catch {}
      }, HEADER_TIMEOUT_MS);
    }
    try {
      const resp = await fetch(buildTelegramFileUrl(env, targetPath), {
        method: 'GET',
        headers: { 'Accept-Encoding': 'identity' },
        cf: { cacheTtl: 0, cacheEverything: false },
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
      if (timer !== null) clearTimeout(timer);
      return resp;
    } catch (err) {
      if (timer !== null) clearTimeout(timer);
      throw err;
    }
  };

  let resp = null;
  let lastStatus = 503;
  let lastRetryAfter = 0;
  let lastDetail = '';
  let pathRefreshed = false;
  const MAX_OPEN_ATTEMPTS = multiChunk ? 2 : 3;

  for (let attempt = 1; attempt <= MAX_OPEN_ATTEMPTS; attempt += 1) {
    try {
      resp = await doFetch(filePath);
    } catch (fetchErr) {
      const fetchMsg = String(fetchErr?.message || fetchErr || '');
      if (/too many subrequests/i.test(fetchMsg)) {
        return {
          ok: false,
          status: 503,
          subrequestLimit: true,
          retryAfter: 2,
          error: 'Cloudflare Worker subrequest limit reached; use Range/chunked download',
        };
      }
      lastDetail = fetchErr?.name === 'AbortError' ? 'upstream header timeout' : fetchMsg;
      lastStatus = 503;
      resp = null;
    }

    if (telegramUpstreamOk(resp)) {
      break;
    }

    const status = Number(resp?.status || 0);
    if (status > 0) lastStatus = status;
    const raRaw = resp?.headers?.get?.('Retry-After');
    const raNum = Number(raRaw);
    if (Number.isFinite(raNum) && raNum > 0) {
      lastRetryAfter = Math.min(300, Math.ceil(raNum));
    }
    if (resp) {
      lastDetail = `HTTP ${status}`;
      if (resp.body && typeof resp.body.cancel === 'function') {
        await resp.body.cancel().catch(() => {});
      }
    }
    resp = null;

    if (attempt >= MAX_OPEN_ATTEMPTS) break;

    const isPathInvalid = status === 400 || status === 404 || status === 410;
    const isTransient = !status || status === 408 || status === 429 || status >= 500;

    if (isPathInvalid && !pathRefreshed) {
      pathRefreshed = true;
      await invalidateTelegramFilePath(env, item.fileId, context, pathCacheOpts);
      const refreshed = await resolveTelegramFilePathDetailed(env, item.fileId, context, pathCacheOpts);
      if (refreshed.ok && refreshed.path) {
        filePath = refreshed.path;
        continue;
      }
      if (refreshed.subrequestLimit || refreshed.status === 429) {
        return {
          ok: false,
          status: refreshed.status || 503,
          retryAfter: refreshed.retryAfter || 2,
          subrequestLimit: Boolean(refreshed.subrequestLimit),
          error: refreshed.error || `Failed to refresh chunk ${item.chunkIndex} file path`,
        };
      }
      lastDetail = refreshed.error || lastDetail;
      break;
    }

    if (isTransient) {
      // 429 且要求等待超过 3s：立即交还客户端按 Retry-After 退避，不在 Worker 内盲等或重复撞墙
      if (status === 429 && lastRetryAfter > 3) {
        break;
      }
      // 仅在单分片请求时对 5xx 顺手刷新路径；多片连续流严控子请求数不额外耗费 delete+getFile
      if (!multiChunk && !pathRefreshed && status >= 500) {
        pathRefreshed = true;
        await invalidateTelegramFilePath(env, item.fileId, context, pathCacheOpts);
        const refreshed = await resolveTelegramFilePathDetailed(env, item.fileId, context, pathCacheOpts);
        if (refreshed.ok && refreshed.path) filePath = refreshed.path;
      }
      const waitMs = status === 429
        ? Math.min(2500, Math.max(400, (lastRetryAfter || 1) * 1000))
        : Math.min(1000, 180 * attempt + Math.floor(Math.random() * 120));
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    // 其他确定性 4xx 不盲目重试
    break;
  }

  if (!telegramUpstreamOk(resp)) {
    const outStatus = lastStatus === 429 ? 429 : (lastStatus >= 500 || !lastStatus ? 503 : lastStatus);
    return {
      ok: false,
      status: outStatus,
      retryAfter: outStatus === 429 ? (lastRetryAfter || 3) : (outStatus === 503 ? 2 : 0),
      error: `Failed to fetch Telegram chunk ${item.chunkIndex}${lastDetail ? ` (${lastDetail})` : ''}`,
    };
  }

  // 上游固定 plain GET 返回完整分片（200 OK）；若自建代理仍返回 206 则按 Content-Range 偏移对齐
  let skipBytes = 0;
  if (reqStart > 0) {
    if (Number(resp.status) === 206) {
      const cr = resp.headers.get('Content-Range');
      const m = cr && String(cr).match(/^bytes\s+(\d+)-(\d+)\//i);
      if (m) {
        const upstreamStart = parseInt(m[1], 10);
        if (Number.isFinite(upstreamStart) && upstreamStart <= reqStart) {
          skipBytes = reqStart - upstreamStart;
        }
      }
    } else {
      skipBytes = reqStart;
    }
  }

  return { ok: true, response: resp, skipBytes, needBytes };
}

/**
 * Telegram 虚拟分片对象的流式拼接与跨分片原生 HTTP Range 下载器。
 *
 * 特性：
 * - HEAD 零上游请求，直接由清单返回精确 Content-Length、Accept-Ranges 与分片对齐头
 * - 完整支持 Range（区间 / 开放尾部 / 后缀）+ If-Range 校验 + 416
 * - pull 驱动的 ReadableStream，严格遵循背压，内存峰值 O(1)
 * - 单片 Range 请求走 L1 + Edge Cache (caches.default, 45min, 0 KV 写)；
 *   多片连续流跳过 Edge Cache 读写，把每片子请求数压到最低（冷 2 / 热 1），且不提前挂起未消费的下一片 HTTP 流
 * - 单片中断 / 截断时退避重连并从已输出偏移精确续传
 */
async function handleChunkedTelegramFile(context, fileId, record) {
  const { request, env } = context;
  const metadata = record?.metadata || {};
  const fileName = metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const rawChunks = [...metadata.telegramChunks].sort(
    (a, b) => Number(a?.i ?? 0) - Number(b?.i ?? 0)
  );
  const chunks = [];
  let totalSize = 0;

  for (let idx = 0; idx < rawChunks.length; idx += 1) {
    const c = rawChunks[idx];
    const size = Number(c?.size);
    const chunkFileId = c?.fileId ? String(c.fileId) : '';
    if (!chunkFileId || !Number.isInteger(size) || size <= 0) {
      return errorResponse('Corrupted Telegram chunk manifest', 500);
    }
    chunks.push({
      i: idx,
      fileId: chunkFileId,
      size,
      offset: totalSize,
      end: totalSize + size - 1,
    });
    totalSize += size;
  }

  if (totalSize <= 0) {
    return errorResponse('Empty Telegram chunk manifest', 500);
  }

  const nominalChunkSize =
    Number.isInteger(Number(metadata.telegramChunkSize)) && Number(metadata.telegramChunkSize) > 0
      ? Number(metadata.telegramChunkSize)
      : chunks[0].size;

  const attachChunkedHeaders = (targetHeaders) => {
    targetHeaders.set('X-KVault-Storage', 'telegram-chunked');
    if (nominalChunkSize > 0) {
      targetHeaders.set('X-KVault-Chunk-Size', String(nominalChunkSize));
    }
  };

  // HEAD：零 Telegram API 往返，直接返回虚拟对象完整元信息与分片对齐提示
  if (isHeadRequest(request)) {
    const headResp = headOnlyResponse(fileName, mimeType, totalSize);
    attachChunkedHeaders(headResp.headers);
    return headResp;
  }

  const rangeHeader = request.headers.get('Range');
  const ifRangeOk = matchesIfRange(
    request.headers.get('If-Range'),
    context.__kvEntityTag,
    context.__kvLastModifiedMs
  );

  let rangeStart = 0;
  let rangeEnd = totalSize - 1;
  let isPartial = false;

  if (rangeHeader && ifRangeOk) {
    const parsed = parseSimpleRange(rangeHeader, totalSize);
    if (parsed) {
      if (parsed.unsatisfiable) {
        return rangeNotSatisfiableResponse(totalSize);
      }
      rangeStart = parsed.start;
      rangeEnd = parsed.end;
      isPartial = true;
    } else if (/^bytes=/i.test(String(rangeHeader))) {
      // 例如 bytes=-0 或非法的 bytes= 语法 → 按 RFC 返回 416
      return rangeNotSatisfiableResponse(totalSize);
    }
  }

  const responseLength = rangeEnd - rangeStart + 1;

  // 只挑选与目标字节区间重叠的最小分片集合
  const plan = [];
  for (const chunk of chunks) {
    if (chunk.end < rangeStart) continue;
    if (chunk.offset > rangeEnd) break;
    const sliceStart = Math.max(0, rangeStart - chunk.offset);
    const sliceEnd = Math.min(chunk.size - 1, rangeEnd - chunk.offset);
    plan.push({
      fileId: chunk.fileId,
      chunkIndex: chunk.i,
      chunkSize: chunk.size,
      sliceStart,
      sliceEnd,
      sliceLen: sliceEnd - sliceStart + 1,
    });
  }

  if (plan.length === 0) {
    return rangeNotSatisfiableResponse(totalSize);
  }

  const isMultiChunkPlan = plan.length > 1;
  const openOpts = { multiChunk: isMultiChunkPlan };
  const pathCacheOpts = isMultiChunkPlan ? TG_CHUNK_STREAM_PATH_OPTS : TG_CHUNK_PATH_CACHE_OPTS;

  // 在发出响应头之前先打开首片：若上游不可达，可干净返回 503/429（并触发分享配额退还）
  const firstSlice = await openTelegramChunkSlice(env, context, plan[0], 0, null, openOpts);
  if (!firstSlice.ok) {
    return errorResponse(
      firstSlice.error || 'Failed to fetch file from Telegram',
      firstSlice.status || 503,
      firstSlice.retryAfter ? { 'Retry-After': String(firstSlice.retryAfter) } : null
    );
  }

  let planIdx = 0;
  let emittedForSlice = 0;
  let sliceAttempt = 0;
  const maxSliceAttempts = isMultiChunkPlan ? 3 : 4;
  let activeReader = null;
  let skipRemaining = 0;
  let preOpenedFirst = firstSlice;
  // 仅在小跨度（<=8 片）时提前解析下一片 file_path 字符串（轻量、不提前打开 18MB HTTP 流）；
  // 大跨度单连接严格按需串行解析，省下每一分免费版 50 子请求配额。
  const enablePathLookahead = plan.length > 1 && plan.length <= 8;
  let nextPathPromise =
    enablePathLookahead
      ? getTelegramFilePathCached(env, plan[1].fileId, context, pathCacheOpts).catch(() => null)
      : null;
  let lookaheadTriggeredFor = 0;
  let cancelled = false;

  const releaseReader = async () => {
    const r = activeReader;
    activeReader = null;
    if (r) {
      try {
        await r.cancel();
      } catch {
        // ignore cancel errors
      }
    }
  };

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (!cancelled) {
          if (planIdx >= plan.length) {
            controller.close();
            return;
          }

          const item = plan[planIdx];

          if (!activeReader) {
            let opened = null;
            if (planIdx === 0 && preOpenedFirst) {
              opened = preOpenedFirst;
              preOpenedFirst = null;
            } else {
              let prePath = null;
              if (sliceAttempt === 0 && nextPathPromise && lookaheadTriggeredFor === planIdx - 1) {
                prePath = await nextPathPromise;
                nextPathPromise = null;
              }
              opened = await openTelegramChunkSlice(
                env,
                context,
                item,
                emittedForSlice,
                prePath,
                openOpts
              );
            }

            if (enablePathLookahead && planIdx + 1 < plan.length && lookaheadTriggeredFor < planIdx) {
              lookaheadTriggeredFor = planIdx;
              nextPathPromise = getTelegramFilePathCached(
                env,
                plan[planIdx + 1].fileId,
                context,
                pathCacheOpts
              ).catch(() => null);
            }

            if (!opened.ok) {
              const errMsg = opened.error || `Telegram chunk ${item.chunkIndex} failed`;
              if (opened.subrequestLimit || opened.status === 429) {
                throw new Error(errMsg);
              }
              sliceAttempt += 1;
              if (sliceAttempt >= maxSliceAttempts) {
                throw new Error(errMsg);
              }
              await invalidateTelegramFilePath(env, item.fileId, context, pathCacheOpts);
              await new Promise((r) => setTimeout(r, Math.min(1000, 200 * sliceAttempt)));
              continue;
            }

            if (!opened.response.body) {
              throw new Error(`Telegram chunk ${item.chunkIndex} returned empty body`);
            }

            skipRemaining = opened.skipBytes;
            activeReader = opened.response.body.getReader();
          }

          let readResult;
          try {
            readResult = await activeReader.read();
          } catch (readErr) {
            await releaseReader();
            sliceAttempt += 1;
            if (sliceAttempt >= maxSliceAttempts) {
              throw readErr;
            }
            await invalidateTelegramFilePath(env, item.fileId, context, pathCacheOpts);
            await new Promise((r) => setTimeout(r, Math.min(1000, 200 * sliceAttempt)));
            continue;
          }

          const { done, value } = readResult;
          if (done) {
            await releaseReader();
            if (emittedForSlice < item.sliceLen) {
              sliceAttempt += 1;
              if (sliceAttempt >= maxSliceAttempts) {
                throw new Error(
                  `Telegram chunk ${item.chunkIndex} truncated (${emittedForSlice}/${item.sliceLen})`
                );
              }
              await invalidateTelegramFilePath(env, item.fileId, context, pathCacheOpts);
              await new Promise((r) => setTimeout(r, Math.min(1000, 200 * sliceAttempt)));
              continue;
            }
            planIdx += 1;
            emittedForSlice = 0;
            sliceAttempt = 0;
            continue;
          }

          if (!value || value.byteLength === 0) continue;

          let view = value instanceof Uint8Array ? value : new Uint8Array(value);

          if (skipRemaining > 0) {
            if (view.byteLength <= skipRemaining) {
              skipRemaining -= view.byteLength;
              continue;
            }
            view = view.subarray(skipRemaining);
            skipRemaining = 0;
          }

          const needNow = item.sliceLen - emittedForSlice;
          if (view.byteLength > needNow) {
            view = view.subarray(0, needNow);
          }

          if (view.byteLength > 0) {
            controller.enqueue(view);
            emittedForSlice += view.byteLength;

            if (emittedForSlice >= item.sliceLen) {
              await releaseReader();
              planIdx += 1;
              emittedForSlice = 0;
              sliceAttempt = 0;
            }
            return;
          }
        }
      } catch (err) {
        await releaseReader();
        const errMsg = String(err?.message || err || '');
        if (/too many subrequests|subrequest limit/i.test(errMsg)) {
          console.warn(
            `Telegram chunked stream hit Cloudflare Workers subrequest limit (fileId=${fileId}, planIdx=${planIdx}/${plan.length}). Recommend Range/chunked download (e.g. KVault.downloadResumable or IDM/aria2).`
          );
        }
        if (!cancelled) {
          controller.error(err);
        }
      }
    },
    async cancel() {
      cancelled = true;
      await releaseReader();
      if (preOpenedFirst?.response?.body) {
        try {
          await preOpenedFirst.response.body.cancel();
        } catch {
          // ignore
        }
        preOpenedFirst = null;
      }
    },
  });

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType);
  attachChunkedHeaders(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(responseLength));
  if (isPartial) {
    headers.set('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${totalSize}`);
  }

  return new Response(stream, {
    status: isPartial ? 206 : 200,
    headers,
  });
}

async function handleSignedTelegramFile(context, signedMeta) {
  const { request, env } = context;

  const filePath = await getTelegramFilePathCached(env, signedMeta.fileId, context);
  if (!filePath) {
    return errorResponse('Failed to get file path from Telegram', 500);
  }

  await backfillSignedTelegramMetadata(env, signedMeta);

  const fileName = signedMeta.fileName || `${signedMeta.fileId}.${signedMeta.fileExtension || 'bin'}`;
  const mimeType = signedMeta.mimeType || getMimeType(fileName);

  let upstream = await fetchTelegramUpstream(env, request, filePath);
  if (!telegramUpstreamOk(upstream)) {
    await invalidateTelegramFilePath(env, signedMeta.fileId);
    const refreshed = await getTelegramFilePathCached(env, signedMeta.fileId, context);
    if (refreshed && refreshed !== filePath) {
      upstream = await fetchTelegramUpstream(env, request, refreshed);
    }
  }

  if (!telegramUpstreamOk(upstream)) {
    return errorResponse('Failed to fetch file from Telegram', upstream?.status || 502);
  }

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * 上游 Telegram 响应是否可用（200 / 206 都算成功）。
 *
 * @param {Response|null} response
 * @returns {boolean}
 */
function telegramUpstreamOk(response) {
  return Boolean(response) && (response.ok || Number(response.status) === 206);
}

/**
 * 向 Telegram 取文件字节（或 HEAD）。
 *
 * `cf.cacheTtl: 0`：不让 Cloudflare 在这一跳上自行缓存 —— 字节是否该缓存
 * 由本文件的字节缓存（Cache API）统一决定，避免两处缓存互相打架。
 *
 * @param env - Pages 环境。
 * @param request - 原始请求（取 Range 与方法）。
 * @param filePath - 已解析的 file_path。
 * @returns {Promise<Response>}
 */
async function fetchTelegramUpstream(env, request, filePath) {
  const rangeHeader = request.headers.get('Range');
  const fetchHeaders = new Headers({ 'Accept-Encoding': 'identity' });
  if (rangeHeader) fetchHeaders.set('Range', rangeHeader);

  const isHead = String(request?.method || '').toUpperCase() === 'HEAD';

  return fetch(buildTelegramFileUrl(env, filePath), {
    method: isHead ? 'HEAD' : 'GET',
    headers: fetchHeaders,
    cf: { cacheTtl: 0, cacheEverything: false },
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

    // 先算出 metadata 再写：KV 与 D1 共用同一份，省掉 D1 登记时的 KV 回读
    const recordMetadata = {
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
    };
    await putKvFileMetadata(env, kvKey, recordMetadata);
    // 回填后登记索引，后续同 ID 请求走快路径
    await putRecordIndex(env, kvKey, { metadata: recordMetadata });
  } catch (error) {
    console.warn('Signed metadata backfill skipped:', error.message);
  }
}

const R2_READ_RETRY_OPTS = { maxAttempts: 3, baseDelayMs: 120, maxDelayMs: 800 };

function rangeNotSatisfiableResponse(totalSize) {
  const headers = new Headers();
  addCorsHeaders(headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes */${totalSize}`);
  return new Response('Range Not Satisfiable', { status: 416, headers });
}

function isR2RangeError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? 0);
  if (status === 416) return true;
  const msg = String(error?.message || error || '');
  return /range\s*not\s*satisfiable|invalid\s*range|offset.*exceed|416/i.test(msg);
}

async function handleR2File(context, r2Key, record = null) {
  const { request, env } = context;

  if (!env.R2_BUCKET) {
    return errorResponse('R2 storage not configured', 500);
  }

  if (!record?.metadata) {
    record = await getR2RecordFromKV(env, r2Key);
  }

  if (!record?.metadata) {
    return errorResponse('File not found', 404);
  }

  const fileName = record.metadata.fileName || r2Key;
  const mimeType = getMimeType(fileName);

  try {
    // HEAD 无论是否携带 Range 都只走 R2 head()（不拉对象体），带瞬态重试。
    if (isHeadRequest(request)) {
      const meta = await retryR2Op(() => env.R2_BUCKET.head(r2Key), R2_READ_RETRY_OPTS);
      if (!meta) return errorResponse('File not found in R2', 404);

      if (!context.__kvLastModifiedMs) {
        const modMs = deriveLastModifiedMs(record.metadata, meta);
        if (modMs > 0) context.__kvLastModifiedMs = modMs;
      }

      const headHeaders = new Headers();
      addResponseHeaders(headHeaders, fileName, mimeType);
      headHeaders.set('Content-Length', String(meta.size));
      return new Response(null, { status: 200, headers: headHeaders });
    }

    const rangeHeader = request.headers.get('Range');
    const ifRangeOk = matchesIfRange(
      request.headers.get('If-Range'),
      context.__kvEntityTag,
      context.__kvLastModifiedMs
    );

    let object = null;
    let responseStatus = 200;
    let contentLength = null;
    let contentRange = null;

    if (rangeHeader && ifRangeOk) {
      const parsedRaw = parseSimpleRange(rangeHeader, null);
      if (parsedRaw) {
        const rawKnown = parseByteLength(record.metadata.fileSize);
        const knownSize = rawKnown && rawKnown > 0 ? rawKnown : null;
        const obviousBad =
          (parsedRaw.start !== null && parsedRaw.end !== null && parsedRaw.start > parsedRaw.end) ||
          (knownSize !== null && parsedRaw.start !== null && parsedRaw.start >= knownSize);

        let effectiveSize = knownSize;
        if (obviousBad) {
          // 疑似越界：用 head 核对真实对象大小后再判 416，防止陈旧元数据误拒
          const head = await retryR2Op(() => env.R2_BUCKET.head(r2Key), R2_READ_RETRY_OPTS);
          if (!head) return errorResponse('File not found in R2', 404);
          effectiveSize = parseByteLength(head.size) ?? 0;
          const checked = parseSimpleRange(rangeHeader, effectiveSize);
          if (!checked || checked.unsatisfiable) {
            return rangeNotSatisfiableResponse(effectiveSize);
          }
        }

        // 单 RTT 原生 R2 Range 读取：跳过前置 head()，直接带 range 调 R2_BUCKET.get()
        const buildR2Range = (sizeHint) => {
          if (parsedRaw.start === null) {
            if (sizeHint !== null && sizeHint > 0) {
              const s = Math.max(sizeHint - parsedRaw.end, 0);
              return { offset: s, length: sizeHint - s };
            }
            return { suffix: parsedRaw.end };
          }
          if (parsedRaw.end !== null) {
            const clampedEnd = sizeHint !== null && sizeHint > 0
              ? Math.min(parsedRaw.end, sizeHint - 1)
              : parsedRaw.end;
            return { offset: parsedRaw.start, length: Math.max(1, clampedEnd - parsedRaw.start + 1) };
          }
          return sizeHint !== null && sizeHint > 0
            ? { offset: parsedRaw.start, length: Math.max(1, sizeHint - parsedRaw.start) }
            : { offset: parsedRaw.start };
        };

        try {
          object = await retryR2Op(
            () => env.R2_BUCKET.get(r2Key, { range: buildR2Range(effectiveSize) }),
            R2_READ_RETRY_OPTS
          );
        } catch (rangeErr) {
          if (!isR2RangeError(rangeErr)) throw rangeErr;
          const head = await retryR2Op(() => env.R2_BUCKET.head(r2Key), R2_READ_RETRY_OPTS);
          if (!head) return errorResponse('File not found in R2', 404);
          return rangeNotSatisfiableResponse(parseByteLength(head.size) ?? 0);
        }

        if (!object) return errorResponse('File not found in R2', 404);

        const actualSize = parseByteLength(object.size) ?? effectiveSize;
        if (actualSize !== null) {
          const resolved = parseSimpleRange(rangeHeader, actualSize);
          if (!resolved || resolved.unsatisfiable) {
            if (object.body && typeof object.body.cancel === 'function') {
              object.body.cancel().catch(() => {});
            }
            return rangeNotSatisfiableResponse(actualSize);
          }

          // 若元数据 fileSize 陈旧导致实际返回区间与目标区间不一致，自动按真实大小重取一次保证字节精确
          const needsRefetch =
            effectiveSize !== null &&
            effectiveSize !== actualSize &&
            (parsedRaw.start === null || parsedRaw.end === null || parsedRaw.end >= effectiveSize);
          if (needsRefetch) {
            if (object.body && typeof object.body.cancel === 'function') {
              object.body.cancel().catch(() => {});
            }
            object = await retryR2Op(
              () =>
                env.R2_BUCKET.get(r2Key, {
                  range: { offset: resolved.start, length: resolved.end - resolved.start + 1 },
                }),
              R2_READ_RETRY_OPTS
            );
            if (!object) return errorResponse('File not found in R2', 404);
          }

          responseStatus = 206;
          contentLength = resolved.end - resolved.start + 1;
          contentRange = `bytes ${resolved.start}-${resolved.end}/${actualSize}`;
        }
      }
    }

    if (!object) {
      object = await retryR2Op(() => env.R2_BUCKET.get(r2Key), R2_READ_RETRY_OPTS);
    }

    if (!object) {
      return errorResponse('File not found in R2', 404);
    }

    if (!context.__kvLastModifiedMs) {
      const modMs = deriveLastModifiedMs(record.metadata, object);
      if (modMs > 0) context.__kvLastModifiedMs = modMs;
    }

    const headers = new Headers();
    addResponseHeaders(headers, fileName, mimeType);
    const length = parseByteLength(contentLength ?? object.size);
    if (length !== null) headers.set('Content-Length', String(length));
    if (contentRange) headers.set('Content-Range', contentRange);

    return new Response(object.body, {
      status: responseStatus,
      headers,
    });
  } catch (error) {
    if (classifyR2Error(error) === 'transient') {
      console.warn('R2 read transient failure after retries:', error?.message || error);
      return errorResponse('R2 暂时不可用，请稍后重试', 503, { 'Retry-After': '1' });
    }
    throw error;
  }
}

async function getR2RecordFromKV(env, r2Key) {
  if (!env.img_url) return null;

  const candidateKeys = r2Key.startsWith('r2:') ? [r2Key, r2Key.slice(3)] : [`r2:${r2Key}`, r2Key];
  const probed = await Promise.all(
    candidateKeys.map((key) => env.img_url.getWithMetadata(key).catch(() => null))
  );
  return probed.find((record) => record?.metadata) || null;
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
    if (size === 0) return { unsatisfiable: true };
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

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['s3:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  const s3Key = record.metadata.s3Key || fileId.replace(/^s3:/, '');
  const fileName = record.metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const s3 = createS3Client(env);

  // HEAD 只问「在不在、多大」：走 S3 的 HeadObject，不要把整个对象拉回来。
  if (isHeadRequest(request)) {
    try {
      const meta = await s3.headObject(s3Key);
      if (!meta) return errorResponse('File not found in S3', 404);
      return headOnlyResponse(fileName, mimeType, meta.contentLength);
    } catch (error) {
      console.warn('S3 headObject failed:', error?.message || error);
      return errorResponse(`S3 元数据探测失败: ${error?.message || error}`, 502);
    }
  }

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

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['discord:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  const { discordChannelId, discordMessageId } = record.metadata;
  if (!discordChannelId || !discordMessageId) {
    return errorResponse('Discord metadata incomplete', 500);
  }

  const fileInfo = await getDiscordFileUrl(discordChannelId, discordMessageId, env);
  if (!fileInfo) return errorResponse('File not found on Discord', 404);

  // HEAD 只问元数据：对附件直链发 HEAD，不下载字节
  if (isHeadRequest(request)) {
    try {
      const probe = await fetch(fileInfo.url, { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' } });
      if (!probe.ok && probe.status !== 206) {
        return errorResponse('File not found on Discord', probe.status === 404 ? 404 : 502);
      }
      return headOnlyResponse(
        record.metadata.fileName || fileInfo.filename || fileId,
        getMimeType(record.metadata.fileName || fileInfo.filename || fileId),
        upstreamByteLength(probe, fileInfo.size)
      );
    } catch (error) {
      console.warn('Discord HEAD failed:', error?.message || error);
      return errorResponse(`Discord 元数据探测失败: ${error?.message || error}`, 502);
    }
  }

  const rangeHeader = request.headers.get('Range');
  const upstream = await fetch(fileInfo.url, {
    headers: { 'Accept-Encoding': 'identity', ...(rangeHeader ? { Range: rangeHeader } : {}) },
  });

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('Error fetching file from Discord', 502);
  }

  const fileName = record.metadata.fileName || fileInfo.filename || fileId;
  const mimeType = getMimeType(fileName);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream, fileInfo.size);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleHFFile(context, fileId, record = null) {
  const { request, env } = context;

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['hf:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  const hfPath = record.metadata.hfPath;
  if (!hfPath) return errorResponse('HuggingFace path missing', 500);

  // HEAD 只问元数据
  if (isHeadRequest(request)) {
    const probe = await getHuggingFaceFile(hfPath, env, { method: 'HEAD' });
    if (!probe.ok && probe.status !== 206) {
      return errorResponse('File not found on HuggingFace', probe.status || 404);
    }
    return headOnlyResponse(
      record.metadata.fileName || fileId,
      getMimeType(record.metadata.fileName || fileId),
      upstreamByteLength(probe)
    );
  }

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

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['webdav:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  const webdavPath = record.metadata.webdavPath || fileId.replace(/^webdav:/, '');
  if (!webdavPath) return errorResponse('WebDAV path missing', 500);

  // HEAD 只取响应头，不下载字节
  if (isHeadRequest(request)) {
    try {
      const meta = await headWebDAVFile(webdavPath, env);
      if (!meta) return errorResponse('File not found on WebDAV', 404);
      return headOnlyResponse(record.metadata.fileName || fileId, getMimeType(record.metadata.fileName || fileId), meta.contentLength);
    } catch (error) {
      console.warn('WebDAV HEAD failed:', error?.message || error);
      return errorResponse(`WebDAV 元数据探测失败: ${error?.message || error}`, 502);
    }
  }

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

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['github:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

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

  // 并发探测：串行版本最坏要把 prefixes.length 次 KV 往返叠起来。
  // 命中判定仍按 prefixes 的原顺序取第一个，语义与串行版一致。
  const keys = prefixes.map((prefix) => `${prefix}${fileId}`);
  const probed = await Promise.all(
    keys.map((key) => env.img_url.getWithMetadata(key).catch(() => null))
  );
  return probed.find((record) => record?.metadata) || null;
}

// ============================================================================
// Telegram file_path 短期缓存 + single-flight
// ============================================================================
// 每次 GET / HEAD / Range 都要先调一次 Bot API 的 getFile 才能拿到真实
// 下载路径：一个正在拖动进度条的视频预览会把它放大成几十次同样的调用，
// 既拖慢响应（每次多一跳伦敦/新加坡往返），又白白吃掉 Bot 的配额。
//
// file_path 在 Telegram 侧有稳定的有效期（远超这里的 10 分钟），且它只是
// 一个**指针**，不含任何权限信息 —— 缓存它不会绕过任何访问控制，
// 真正的权限判定全在本文件的闸门里完成。
const TG_FILE_PATH_TTL_MS = 10 * 60 * 1000;
const TG_FILE_PATH_MAX_ENTRIES = 256;
const tgFilePathCache = new Map();      // fileId -> { path, expiresAt }
const tgFilePathInFlight = new Map();   // fileId -> Promise（single-flight）

// ============================================================================
// Telegram file_path 的 KV 持久化（延迟优化 P0-1）
// ============================================================================
//
// 为什么必须落到 KV 而不是只留 isolate 内存：
//   isolate 缓存的命中率远低于直觉 —— 请求会被分配到不同 PoP，同一 PoP 内
//   也有多个 isolate，且 isolate 会被回收。对「国内用户 + Telegram 后端」
//   这种每次 getFile 都要跨洋往返的场景，命中率不够就等于没优化，
//   用户感受到的依然是「点了之后很久才开始下」。
//
// 为什么用独立 KV 键而不是写回文件元数据：
//   getRecordWithKey 是 **D1 优先**，记录一旦从 D1 返回，写进 KV metadata
//   的字段根本不会被读到 —— 持久化等于白做。独立键与记录来源解耦，
//   无论记录从 D1 还是 KV 来都能命中。
//
// file_path 只是一个指针，不含任何权限信息：缓存它不会绕过任何访问控制，
// 真正的权限判定全在本文件的闸门里完成。
const TG_PATH_KV_PREFIX = 'tgpath:';
const TG_PATH_KV_TTL_SECONDS = 7 * 24 * 3600;
const TG_PATH_EDGE_VERSION = 'v1';
const TG_PATH_EDGE_TTL_SECONDS = 45 * 60; // 45 分钟，匹配 Telegram file_path ~1 小时有效期，自然过期不留脏缓存
const TG_CHUNK_PATH_CACHE_OPTS = Object.freeze({ useKv: false, useEdgeCache: true });
const TG_CHUNK_STREAM_PATH_OPTS = Object.freeze({ useKv: false, useEdgeCache: false });

/**
 * 构造 Telegram 分片 file_path 的 Cloudflare Edge Cache API 缓存键。
 *
 * 为什么虚拟分片改用 caches.default 而不是 KV：
 *   2GB 虚拟分片文件含 114 个 chunk file_id。写 KV 每次冷下载就会吃掉 114 次 KV 写，
 *   1 小时后路径轮换还会额外触发 114 次 KV 删 + 114 次 KV 写（直接逼近免费版 1,000 次/天上限）。
 *   单片 Range 请求（plan.length === 1）使用 caches.default 免费共享（0 KV 写/删）；
 *   多片连续流（plan.length > 1）走 TG_CHUNK_STREAM_PATH_OPTS 跳过 caches.default，
 *   避免 Cache API 计入免费版 50 子请求上限导致大文件单连接中途断流。
 */
/** @internal 供测试使用 */
export function buildTgPathEdgeCacheKey(requestUrl, fileId) {
  if (!requestUrl || !fileId) return null;
  try {
    const url = new URL(requestUrl);
    url.search = '';
    url.pathname = `/__kvault-tgpath/${TG_PATH_EDGE_VERSION}/${encodeURIComponent(String(fileId))}`;
    return new Request(url.toString(), { method: 'GET' });
  } catch {
    return null;
  }
}

/**
 * 普通单文件（≤20MB）的 file_path KV 持久化仍默认开启；
 * 虚拟分片通过 `TG_CHUNK_PATH_CACHE_OPTS` / `TG_CHUNK_STREAM_PATH_OPTS` 实现 0 KV 写/删。
 */

/** 把任务挂到 waitUntil；没有 context 时火后不管（写失败只会让下次 miss）。 */
function background(context, promise) {
  const settled = Promise.resolve(promise).catch(() => {});
  if (context && typeof context.waitUntil === 'function') {
    context.waitUntil(settled);
  }
}

/** 写入 isolate 内存缓存（含 LRU 淘汰）。 */
function rememberTgFilePath(fileId, path) {
  if (tgFilePathCache.size >= TG_FILE_PATH_MAX_ENTRIES) {
    // Map 保持插入顺序，第一个就是最旧的 —— 淘汰它以维持上限，
    // 避免长期运行的 isolate 被冷门文件 ID 撑爆。
    const oldest = tgFilePathCache.keys().next().value;
    if (oldest !== undefined) tgFilePathCache.delete(oldest);
  }
  tgFilePathCache.set(fileId, { path, expiresAt: Date.now() + TG_FILE_PATH_TTL_MS });
}

/** @internal 供测试模拟跨 isolate（清 L1 内存，保留 Edge Cache） */
export function clearTgFilePathMemoryCache() {
  tgFilePathCache.clear();
}

/**
 * 丢弃某个 fileId 的缓存解析结果（isolate 内存 + 边缘缓存 / KV）。
 *
 * 触发时机：用该路径去取文件却失败了。此时多半是 Telegram 侧的路径轮换，
 * 而不是文件真的没了 —— 清掉后下一次访问会重新走一次 getFile。
 */
async function invalidateTelegramFilePath(env, fileId, context = null, options = null) {
  if (!fileId) return;
  tgFilePathCache.delete(fileId);
  const useKv = options?.useKv !== false;
  const useEdgeCache = options?.useEdgeCache !== false;

  if (useEdgeCache && typeof caches !== 'undefined' && caches?.default) {
    const edgeKey = buildTgPathEdgeCacheKey(context?.request?.url, fileId);
    if (edgeKey) {
      await caches.default.delete(edgeKey).catch(() => {});
    }
  }

  if (!useKv || !env?.img_url) return;
  try {
    await env.img_url.delete(`${TG_PATH_KV_PREFIX}${fileId}`);
  } catch (error) {
    console.warn('Failed to invalidate tgpath cache:', error?.message || error);
  }
}

/**
 * 带结构化错误诊断的三级 file_path 解析：
 *   - 正常命中返回 `{ ok: true, path }`
 *   - 失败保留真实 HTTP 状态（429 + retryAfter / 503 subrequestLimit / Telegram 错误描述），
 *     避免把 429 频控或 50 子请求熔断全部吞成黑盒 502。
 */
async function resolveTelegramFilePathDetailed(env, fileId, context = null, options = null) {
  if (!fileId) {
    return { ok: false, path: null, status: 400, retryAfter: 0, error: 'Missing Telegram file_id' };
  }

  // ---- L1：isolate 内存（零往返） ----
  const cached = tgFilePathCache.get(fileId);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      if (context) context.__kvTgPathSource = 'memory';
      return { ok: true, path: cached.path };
    }
    tgFilePathCache.delete(fileId);
  }

  const useKv = options?.useKv !== false;
  const useEdgeCache = !useKv && options?.useEdgeCache !== false;
  const edgeCache = useEdgeCache && typeof caches !== 'undefined' && caches?.default ? caches.default : null;
  const edgeKey = edgeCache ? buildTgPathEdgeCacheKey(context?.request?.url, fileId) : null;

  // ---- L2a：Cloudflare Edge Cache API（单片虚拟分片专用：免费、不占 KV 额度、同 PoP 跨 isolate 共享） ----
  if (edgeCache && edgeKey) {
    try {
      const edgeResp = await edgeCache.match(edgeKey);
      if (edgeResp && edgeResp.ok) {
        const stored = (await edgeResp.text()).trim();
        if (stored) {
          rememberTgFilePath(fileId, stored);
          if (context) context.__kvTgPathSource = 'edge-cache';
          return { ok: true, path: stored };
        }
      }
    } catch (error) {
      const msg = String(error?.message || error || '');
      if (/too many subrequests/i.test(msg)) {
        return {
          ok: false,
          path: null,
          status: 503,
          retryAfter: 2,
          subrequestLimit: true,
          error: 'Cloudflare Worker subrequest limit reached; use Range/chunked download',
        };
      }
      console.warn('Failed to read tgpath edge cache:', msg);
    }
  }

  // ---- L2b：KV（普通单文件：跨 isolate / 跨 PoP 共享，边缘读 ~5-20ms） ----
  const persistKv = useKv && Boolean(env?.img_url);
  const kvCacheKey = `${TG_PATH_KV_PREFIX}${fileId}`;
  if (persistKv) {
    try {
      const stored = await env.img_url.get(kvCacheKey);
      if (stored) {
        rememberTgFilePath(fileId, stored);
        if (context) context.__kvTgPathSource = 'kv';
        return { ok: true, path: stored };
      }
    } catch (error) {
      console.warn('Failed to read tgpath cache:', error?.message || error);
    }
  }

  // ---- L3：Bot API（唯一可能跨洋的一跳） ----
  let pending = tgFilePathInFlight.get(fileId);
  if (!pending) {
    pending = getTelegramFilePathDetailed(env, fileId).finally(() => {
      tgFilePathInFlight.delete(fileId);
    });
    tgFilePathInFlight.set(fileId, pending);
  }

  const res = await pending;
  if (!res?.ok || !res.path) {
    return res || { ok: false, path: null, status: 503, retryAfter: 2, error: 'Telegram getFile failed' };
  }

  rememberTgFilePath(fileId, res.path);
  if (context) context.__kvTgPathSource = 'api';

  // 回填 L2：单片虚拟分片写免费 Edge Cache（45min，0 KV 写）；普通单文件回填 KV
  if (edgeCache && edgeKey) {
    background(
      context,
      edgeCache
        .put(
          edgeKey,
          new Response(res.path, {
            status: 200,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': `public, max-age=${TG_PATH_EDGE_TTL_SECONDS}`,
            },
          })
        )
        .catch((error) => console.warn('Failed to persist tgpath edge cache:', error?.message || error))
    );
  } else if (persistKv) {
    background(
      context,
      env.img_url
        .put(kvCacheKey, res.path, { expirationTtl: TG_PATH_KV_TTL_SECONDS })
        .catch((error) => console.warn('Failed to persist tgpath:', error?.message || error))
    );
  }

  return { ok: true, path: res.path };
}

/**
 * 三级解析 file_id → file_path：
 *   - 普通单文件（默认 useKv: true）：isolate 内存 → KV → Bot API
 *   - 单片虚拟分片（useKv: false, useEdgeCache: true）：isolate 内存 → Edge Cache (45min) → Bot API
 *   - 多片连续流（useKv: false, useEdgeCache: false）：isolate 内存 → Bot API（最低子请求消耗）
 */
/** @internal 供测试使用 */
export async function getTelegramFilePathCached(env, fileId, context = null, options = null) {
  const res = await resolveTelegramFilePathDetailed(env, fileId, context, options);
  return res?.ok ? res.path : null;
}

async function getTelegramFilePathDetailed(env, fileId) {
  const url = `${buildTelegramBotApiUrl(env, 'getFile')}?file_id=${encodeURIComponent(fileId)}`;
  const MAX_ATTEMPTS = 3;
  const GET_FILE_TIMEOUT_MS = 15 * 1000;
  let lastStatus = 503;
  let lastRetryAfter = 0;
  let lastError = 'Telegram getFile failed';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    if (ctrl) {
      timer = setTimeout(() => {
        try { ctrl.abort(); } catch {}
      }, GET_FILE_TIMEOUT_MS);
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.ok && data?.result?.file_path) {
        return { ok: true, path: data.result.file_path };
      }

      const status = Number(response?.status || 0);
      const desc = String(data?.description || '').trim();
      lastStatus = status || 503;
      lastError = `Telegram getFile failed (HTTP ${lastStatus}${desc ? `: ${desc}` : ''})`;

      if (status === 429) {
        const retrySec = Math.max(
          1,
          Math.min(300, Math.ceil(Number(data?.parameters?.retry_after || response.headers?.get?.('Retry-After') || 5)))
        );
        lastRetryAfter = retrySec;
        if (retrySec <= 3 && attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, retrySec * 1000));
          continue;
        }
        return {
          ok: false,
          path: null,
          status: 429,
          retryAfter: retrySec,
          error: `Telegram getFile rate limited (retry after ${retrySec}s)`,
        };
      }

      const isTransient = status === 408 || status >= 500;
      if (isTransient && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, Math.min(800, 150 * attempt)));
        continue;
      }

      return {
        ok: false,
        path: null,
        status: status >= 400 && status < 500 ? status : 503,
        retryAfter: status >= 500 ? 2 : 0,
        error: lastError,
      };
    } catch (error) {
      const msg = String(error?.message || error || '');
      if (/too many subrequests/i.test(msg)) {
        return {
          ok: false,
          path: null,
          status: 503,
          retryAfter: 2,
          subrequestLimit: true,
          error: 'Cloudflare Worker subrequest limit reached; use Range/chunked download',
        };
      }
      lastStatus = 503;
      lastError = error?.name === 'AbortError'
        ? 'Telegram getFile timed out'
        : `Telegram getFile network error: ${msg}`;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, Math.min(800, 150 * attempt)));
        continue;
      }
      console.error('getTelegramFilePath failed:', error);
      return { ok: false, path: null, status: 503, retryAfter: 2, error: lastError };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  return {
    ok: false,
    path: null,
    status: lastStatus === 429 ? 429 : 503,
    retryAfter: lastStatus === 429 ? (lastRetryAfter || 5) : 2,
    error: lastError,
  };
}
