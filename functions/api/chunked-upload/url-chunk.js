/**
 * Range-chunked remote URL transfer for one chunk of an initialized upload task.
 * POST /api/chunked-upload/url-chunk
 *
 * 将大文件 URL 转存拆分为多请求 Range 分片（每片仅耗 2~3 个 subrequest）：
 * - Telegram 虚拟分片：单片 <= 18MB，支持最高 2GB（114 片），共享全局 429 冷却与幂等续传
 * - R2 原生 Multipart：单片 <= 50MB，支持最高 10GB（256 片），Workers 运行时使用 FixedLengthStream O(1) 零拷贝直通
 *
 * 每片严格执行 SSRF 重定向校验、HTTP 206 + Content-Range 精确偏移校验及字节长度校验，
 * 避免源站忽略 Range 或中途文件变更导致数据错位。
 */
import { normalizeRangeValidator, rangeUploadSourceId } from '../../utils/range-upload-source.js';
import {
  beginTelegramUploadPart,
  confirmTelegramUploadPart,
  discardUnconfirmedTelegramPart,
} from '../../utils/telegram-upload-state.js';
import { checkAuthentication } from '../../utils/auth.js';
import { envValue } from '../../utils/env-config.js';
import { buildTelegramBotApiUrl, pickTelegramFileId } from '../../utils/telegram.js';
import {
  decodeTelegramPartRef,
  encodeTelegramPartRef,
  getUploadedPart,
  isChunkTaskExpired,
  recordUploadedPart,
} from '../../utils/chunk-state.js';
import { classifyR2Error, retryR2Op } from '../../utils/r2-retry.js';
import {
  CHUNK_SIZE_TELEGRAM,
  MAX_FILE_SIZE_R2,
  MAX_TOTAL_CHUNKS,
} from '../../utils/chunk-limits.js';
import { MAX_REDIRECTS, validateRedirectLocation, validateRemoteUrl } from '../../utils/ssrf-guard.js';
import {
  computeExpectedChunkSize,
  computeTelegramSendTimeoutMs,
  getTelegramCooldownRemainingSec,
  recordTelegramCooldown,
  telegramRateLimitResponse,
} from './chunk.js';

const MAX_URL_CHUNK_SIZE = 64 * 1024 * 1024; // 64MB (>= 50MB R2 part)
const RANGE_IDLE_TIMEOUT_MS = 40_000;
const RANGE_EOF_GRACE_MS = 1_500;
const TG_MAX_RETRY_AFTER_SECONDS = 3600;
const INNER_RETRY_BUDGET_MS = 25_000;

class RangeFetchError extends Error {
  constructor(status, message, code = 'RANGE_FETCH_FAILED', retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function jsonResponse(data, status = 200, extraHeaders = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(extraHeaders || {}),
    },
  });
}

function getOwnerId(auth) {
  if (!auth) return null;
  if (typeof auth.user === 'string' && auth.user.trim()) return auth.user.trim();
  if (typeof auth.username === 'string' && auth.username.trim()) return auth.username.trim();
  if (typeof auth.userId === 'string' && auth.userId.trim()) return auth.userId.trim();
  if (typeof auth.id === 'string' && auth.id.trim()) return auth.id.trim();
  if (auth.authType === 'basic' && typeof auth.basicUser === 'string' && auth.basicUser.trim()) {
    return auth.basicUser.trim();
  }
  return null;
}

function sanitizeReferer(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (trimmed.length > 2048 || /[\r\n]/.test(trimmed)) {
    throw new RangeFetchError(400, 'Referer 格式无效', 'INVALID_REFERER', false);
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new RangeFetchError(400, 'Referer 必须是有效的 HTTP/HTTPS 地址', 'INVALID_REFERER', false);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RangeFetchError(400, 'Referer 仅支持 HTTP/HTTPS 协议', 'INVALID_REFERER', false);
  }
  return parsed.href;
}

function parseContentRange(header) {
  const match = String(header || '').trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
  return { start, end, total };
}

async function sleepAbortable(ms, signal) {
  if (ms <= 0) return;
  if (signal?.aborted) throw new RangeFetchError(408, '分片传输已中断', 'ABORTED', true);
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RangeFetchError(408, '分片传输已中断', 'ABORTED', true));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchRemoteRange(initialUrl, { start, end, totalSize, referer, validator, signal }) {
  let currentUrl = initialUrl;
  let effectiveReferer = referer;
  let triedSameOriginReferer = false;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const check = validateRemoteUrl(currentUrl.href);
    if (!check.ok) {
      throw new RangeFetchError(400, `SSRF 防护：${check.message}`, 'SSRF_BLOCKED', false);
    }

    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 K-Vault URL Uploader',
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Range: `bytes=${start}-${end}`,
    };
    if (effectiveReferer) headers.Referer = effectiveReferer;
    if (validator) headers['If-Range'] = validator;

    let response;
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const ctrl = new AbortController();
      const onParentAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onParentAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, RANGE_IDLE_TIMEOUT_MS);

      try {
        response = await fetch(currentUrl.href, {
          method: 'GET',
          redirect: 'manual',
          signal: ctrl.signal,
          headers,
        });
      } catch (err) {
        if (signal?.aborted) {
          throw new RangeFetchError(408, '分片传输已取消', 'ABORTED', true);
        }
        if (!timedOut && attempt === 0) {
          await sleepAbortable(400, signal);
          continue;
        }
        throw new RangeFetchError(
          timedOut ? 408 : 502,
          timedOut ? '源站分片响应超时' : `无法拉取源站分片: ${err?.message || err}`,
          timedOut ? 'RANGE_TIMEOUT' : 'RANGE_FETCH_FAILED',
          true
        );
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onParentAbort);
      }

      if ([408, 429, 500, 502, 503, 504].includes(response.status) && attempt === 0 && !signal?.aborted) {
        void response.body?.cancel().catch(() => {});
        const ra = Number(response.headers.get('Retry-After') || 0);
        const waitMs = response.status === 429 && ra > 0 ? Math.min(5000, Math.round(ra * 1000)) : 500;
        await sleepAbortable(waitMs, signal);
        continue;
      }
      break;
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get('Location');
      if (!location) {
        throw new RangeFetchError(502, '远程 URL 重定向缺少 Location 头', 'REDIRECT_INVALID', false);
      }
      const redirectCheck = validateRedirectLocation(location, currentUrl);
      if (!redirectCheck.ok) {
        throw new RangeFetchError(400, `SSRF 防护：${redirectCheck.message}`, 'SSRF_BLOCKED', false);
      }
      currentUrl = redirectCheck.url;
      continue;
    }

    if (response.status === 403 && !effectiveReferer && !triedSameOriginReferer && !signal?.aborted) {
      void response.body?.cancel().catch(() => {});
      triedSameOriginReferer = true;
      effectiveReferer = `${currentUrl.origin}/`;
      hop -= 1;
      continue;
    }

    if (validator && (response.status === 200 || response.status === 206)) {
      const header = validator.startsWith('"') ? 'ETag' : 'Last-Modified';
      const returned = normalizeRangeValidator(response.headers.get(header));
      if (returned && returned !== validator) {
        void response.body?.cancel().catch(() => {});
        throw new RangeFetchError(409, '远程源文件版本已变更，请重试转存', 'SOURCE_CHANGED', false);
      }
    }

    if (response.status === 200) {
      void response.body?.cancel().catch(() => {});
      throw new RangeFetchError(
        422,
        '源站忽略了 Range 请求并返回整文件，不支持 Range 分片转存',
        'RANGE_NOT_SUPPORTED',
        false
      );
    }

    if (response.status === 412 || response.status === 416) {
      void response.body?.cancel().catch(() => {});
      throw new RangeFetchError(
        409,
        '远程源文件已变更或分片区间失效，请重新开始转存',
        'SOURCE_CHANGED',
        false
      );
    }

    if (response.status !== 206) {
      void response.body?.cancel().catch(() => {});
      const isTransient = [408, 429, 500, 502, 503, 504].includes(response.status);
      throw new RangeFetchError(
        isTransient ? 503 : response.status === 403 || response.status === 404 ? response.status : 502,
        `源站分片响应异常（HTTP ${response.status}）`,
        'RANGE_UPSTREAM_ERROR',
        isTransient
      );
    }

    const rangeInfo = parseContentRange(response.headers.get('Content-Range'));
    if (
      !rangeInfo ||
      rangeInfo.start !== start ||
      rangeInfo.end !== end ||
      (rangeInfo.total !== null && rangeInfo.total !== totalSize)
    ) {
      void response.body?.cancel().catch(() => {});
      throw new RangeFetchError(
        409,
        '源站返回的 Content-Range 与请求分片不匹配（源文件可能已更新）',
        'SOURCE_CHANGED',
        false
      );
    }

    return response;
  }

  throw new RangeFetchError(400, `重定向次数过多（最多 ${MAX_REDIRECTS} 次）`, 'TOO_MANY_REDIRECTS', false);
}

async function readExactChunkBytes(body, expectedSize, signal) {
  const reader = body?.getReader();
  if (!reader) {
    throw new RangeFetchError(502, '源站分片响应体为空', 'RANGE_EMPTY_BODY', true);
  }
  const out = new Uint8Array(expectedSize);
  let received = 0;
  let finished = false;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      let chunk;
      if (received === expectedSize) {
        let graceTimer = null;
        try {
          if (signal?.aborted) throw new RangeFetchError(408, '分片读取已取消', 'ABORTED', true);
          const readPromise = reader.read();
          readPromise.catch(() => {});
          const race = await Promise.race([
            readPromise,
            new Promise((resolve) => {
              graceTimer = setTimeout(() => resolve({ __eofGrace: true }), RANGE_EOF_GRACE_MS);
            }),
          ]);
          if (graceTimer !== null) clearTimeout(graceTimer);
          if (race?.__eofGrace) {
            finished = true;
            await Promise.race([
              reader.cancel().catch(() => {}),
              new Promise((resolve) => setTimeout(resolve, 100)),
            ]);
            return out;
          }
          chunk = race;
        } catch (err) {
          if (graceTimer !== null) clearTimeout(graceTimer);
          if (err instanceof RangeFetchError) throw err;
          if (signal?.aborted) throw new RangeFetchError(408, '分片读取已取消', 'ABORTED', true);
          finished = true;
          return out;
        }
      } else {
        let idleTimer = null;
        try {
          if (signal?.aborted) throw new RangeFetchError(408, '分片读取已取消', 'ABORTED', true);
          const readPromise = reader.read();
          readPromise.catch(() => {});
          const race = await Promise.race([
            readPromise,
            new Promise((_, reject) => {
              idleTimer = setTimeout(
                () => reject(new RangeFetchError(408, '源站分片读取超时', 'RANGE_READ_TIMEOUT', true)),
                RANGE_IDLE_TIMEOUT_MS
              );
            }),
          ]);
          if (idleTimer !== null) clearTimeout(idleTimer);
          chunk = race;
        } catch (err) {
          if (idleTimer !== null) clearTimeout(idleTimer);
          if (err instanceof RangeFetchError) throw err;
          if (signal?.aborted) throw new RangeFetchError(408, '分片读取已取消', 'ABORTED', true);
          throw new RangeFetchError(502, '源站分片读取中断', 'RANGE_READ_ERROR', true);
        }
      }

      if (chunk.done) {
        finished = true;
        if (received !== expectedSize) {
          throw new RangeFetchError(
            502,
            `源站分片字节不完整（收到 ${received} / 期望 ${expectedSize}）`,
            'RANGE_TRUNCATED',
            true
          );
        }
        return out;
      }

      const bytes = chunk.value;
      if (!bytes || !bytes.byteLength) continue;
      if (received + bytes.byteLength > expectedSize) {
        throw new RangeFetchError(
          502,
          `源站分片超出预期字节数（>${expectedSize}）`,
          'RANGE_OVERFLOW',
          true
        );
      }
      out.set(bytes, received);
      received += bytes.byteLength;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (!finished) onAbort();
    try {
      reader.releaseLock();
    } catch {
      // ignore if stream errored
    }
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let releaseTelegramPart;

  try {
    const auth = await checkAuthentication(context);
    if (!auth || !auth.authenticated) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    if (!env.img_url) {
      return jsonResponse(
        { error: 'KV binding img_url is required for chunk upload task state.' },
        500
      );
    }

    const ownerId = getOwnerId(auth);
    if (!ownerId) {
      return jsonResponse({ error: '无法识别用户身份，拒绝分片转存' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const uploadId = String(body?.uploadId || '').trim();
    const chunkIndex = Number(body?.chunkIndex);
    const rawUrl = String(body?.url || '').trim();
    const validator = normalizeRangeValidator(body?.validator);

    if (!/^[a-f0-9]{16,64}$/i.test(uploadId)) {
      return jsonResponse({ error: 'uploadId 格式错误' }, 400);
    }
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return jsonResponse({ error: 'chunkIndex 必须为非负整数' }, 400);
    }

    let remoteUrl;
    try {
      remoteUrl = new URL(rawUrl);
    } catch {
      return jsonResponse({ error: 'url 格式无效' }, 400);
    }
    if (!['http:', 'https:'].includes(remoteUrl.protocol)) {
      return jsonResponse({ error: '仅支持 HTTP/HTTPS URL' }, 400);
    }

    const referer = sanitizeReferer(body?.referer);

    // 校验任务归属与契约
    const taskData = await env.img_url.get(`upload:${uploadId}`, { type: 'json' });
    if (!taskData || isChunkTaskExpired(taskData)) {
      return jsonResponse({ error: '上传任务不存在或已过期', code: 'UPLOAD_EXPIRED' }, 404);
    }
    if (!taskData.ownerId || taskData.ownerId !== ownerId) {
      return jsonResponse({ error: '无权操作该上传任务' }, 403);
    }

    const totalChunks = Number(taskData.totalChunks || 0);
    const declaredFileSize = Number(taskData.fileSize || 0);
    const nominalChunkSize = Number(taskData.chunkSize || 0);

    if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > MAX_TOTAL_CHUNKS) {
      return jsonResponse({ error: '任务分片数无效' }, 400);
    }
    if (!Number.isInteger(declaredFileSize) || declaredFileSize <= 0 || declaredFileSize > MAX_FILE_SIZE_R2) {
      return jsonResponse({ error: '任务文件大小无效' }, 400);
    }
    if (chunkIndex >= totalChunks) {
      return jsonResponse({ error: `chunkIndex ${chunkIndex} 超出范围` }, 400);
    }

    const expectedSize = computeExpectedChunkSize(taskData, chunkIndex, totalChunks, declaredFileSize);
    if (!expectedSize || expectedSize > MAX_URL_CHUNK_SIZE) {
      return jsonResponse({ error: '无法推导合法的分片字节范围' }, 400);
    }

    const isR2Native =
      taskData.storageMode === 'r2' &&
      Boolean(taskData.r2Multipart) &&
      Boolean(env.R2_BUCKET);
    const isTelegramChunked =
      taskData.storageMode === 'telegram' &&
      taskData.chunkBackend === 'telegram';

    if (!isR2Native && !isTelegramChunked) {
      return jsonResponse(
        { error: '当前存储后端不支持 Range 分片 URL 转存', code: 'UNSUPPORTED_BACKEND' },
        400
      );
    }

    if (isTelegramChunked && expectedSize > CHUNK_SIZE_TELEGRAM) {
      return jsonResponse(
        { error: `Telegram 分片大小超出上限 (${CHUNK_SIZE_TELEGRAM} bytes)`, code: 'TG_CHUNK_TOO_LARGE' },
        413
      );
    }

    const partNumber = chunkIndex + 1;

    // 1) 幂等复用：已落库的分片直接返回，零源站流量、零重复上传
    if (isTelegramChunked) {
      if (taskData.remoteSourceId && await rangeUploadSourceId(remoteUrl.href, validator) !== taskData.remoteSourceId) {
        return jsonResponse({ error: '远程源文件版本已变更，请重试转存', code: 'SOURCE_CHANGED' }, 409);
      }
      const start = await beginTelegramUploadPart(env, uploadId, chunkIndex, taskData);
      if (!start.release) return jsonResponse(start.body, start.status);
      releaseTelegramPart = start.release;
    }

    const existingPart = await getUploadedPart(env, uploadId, chunkIndex, { strict: isTelegramChunked });
    if (
      existingPart &&
      existingPart.partNumber === partNumber &&
      (!existingPart.size || existingPart.size === expectedSize) &&
      (isTelegramChunked ? Boolean(decodeTelegramPartRef(existingPart.etag)?.fileId) : Boolean(existingPart.etag))
    ) {
      return jsonResponse({
        success: true,
        chunkIndex,
        partNumber: existingPart.partNumber,
        etag: existingPart.etag,
        size: expectedSize,
        chunkBackend: isTelegramChunked ? 'telegram' : 'r2',
        reused: true,
      });
    }

    // 2) Telegram 共享 429 冷却态短路：冷却期内不浪费源站流量
    const tgChatId = isTelegramChunked ? envValue(env, 'TG_CHAT_ID') : '';
    const tgBotToken = isTelegramChunked ? envValue(env, 'TG_BOT_TOKEN') : '';
    if (isTelegramChunked) {
      if (!tgBotToken || !tgChatId) {
        return jsonResponse({ error: 'Telegram Bot 未配置（缺少 TG_BOT_TOKEN / TG_CHAT_ID）' }, 500);
      }
      const coolRemainSec = await getTelegramCooldownRemainingSec(env, tgChatId);
      if (coolRemainSec > 0) {
        return telegramRateLimitResponse(coolRemainSec, true);
      }
    }

    // 3) 拉取源站精确字节区间
    const rangeStart = chunkIndex * nominalChunkSize;
    const rangeEnd = rangeStart + expectedSize - 1;
    const remoteResp = await fetchRemoteRange(remoteUrl, {
      start: rangeStart,
      end: rangeEnd,
      totalSize: declaredFileSize,
      referer,
      validator,
      signal: request.signal,
    });

    // 4) R2 原生 Multipart 写入（优先零拷贝 FixedLengthStream）
    if (isR2Native) {
      if (!taskData.r2Multipart.key || !taskData.r2Multipart.uploadId) {
        void remoteResp.body?.cancel().catch(() => {});
        return jsonResponse({ error: 'R2 multipart 任务信息不完整' }, 500);
      }

      const mp = env.R2_BUCKET.resumeMultipartUpload(
        taskData.r2Multipart.key,
        taskData.r2Multipart.uploadId
      );

      const canStream =
        typeof FixedLengthStream === 'function' &&
        Boolean(remoteResp.body) &&
        typeof remoteResp.body.pipeTo === 'function';

      let uploadedPart;
      try {
        if (canStream) {
          const fixed = new FixedLengthStream(expectedSize);
          const [partRes] = await Promise.all([
            mp.uploadPart(partNumber, fixed.readable),
            remoteResp.body.pipeTo(fixed.writable),
          ]);
          uploadedPart = partRes;
        } else {
          const bytes = await readExactChunkBytes(remoteResp.body, expectedSize, request.signal);
          uploadedPart = await retryR2Op(
            () => mp.uploadPart(partNumber, bytes),
            { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 1500, signal: request.signal }
          );
        }
      } catch (r2Err) {
        if (r2Err instanceof RangeFetchError) throw r2Err;
        const msg = String(r2Err?.message || r2Err || '');
        if (canStream && /fixedlengthstream|exceeded|ended prematurely|expected.*bytes|short write/i.test(msg)) {
          return jsonResponse(
            { error: '源站分片实际字节数与期望不一致', code: 'RANGE_TRUNCATED', retryable: true },
            502
          );
        }
        const kind = classifyR2Error(r2Err);
        if (kind === 'expired') {
          return jsonResponse(
            { error: 'R2 分片上传会话已过期，请重新开始', code: 'R2_UPLOAD_EXPIRED', retryable: false },
            404
          );
        }
        if (kind === 'client') {
          return jsonResponse(
            { error: `R2 分片校验失败: ${msg}`, code: 'R2_PART_INVALID', retryable: false },
            400
          );
        }
        return jsonResponse(
          { error: `R2 分片写入暂时失败: ${msg}`, code: 'R2_PART_RETRY', retryable: true },
          503,
          { 'Retry-After': '1' }
        );
      }

      if (!uploadedPart || !uploadedPart.etag) {
        return jsonResponse(
          { error: 'R2 uploadPart 未返回有效 etag', code: 'R2_PART_RETRY', retryable: true },
          503,
          { 'Retry-After': '1' }
        );
      }

      await recordUploadedPart(
        env,
        uploadId,
        chunkIndex,
        {
          partNumber,
          etag: uploadedPart.etag,
          size: expectedSize,
          uploadedAt: Date.now(),
        },
        taskData
      );

      return jsonResponse({
        success: true,
        chunkIndex,
        partNumber,
        etag: uploadedPart.etag,
        size: expectedSize,
        chunkBackend: 'r2',
        streamed: canStream,
        reused: false,
      });
    }

    // 5) Telegram 虚拟分片直传（单次请求只传 1 片 <= 18MB，仅耗 2~3 个 subrequest）
    let chunkBytes = await readExactChunkBytes(remoteResp.body, expectedSize, request.signal);
    const partName = `${uploadId.slice(0, 12)}.part${String(chunkIndex).padStart(3, '0')}`;
    const sendUrl = buildTelegramBotApiUrl(env, 'sendDocument');
    const tgSendTimeoutMs = computeTelegramSendTimeoutMs(expectedSize);
    const sendLoopStartAt = Date.now();

    let tgResp = null;
    let tgData = null;
    let lastErr = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (request.signal?.aborted) {
        chunkBytes = null;
        return jsonResponse({ error: '分片转存已取消', code: 'ABORTED', retryable: true }, 408);
      }

      const tgForm = new FormData();
      tgForm.append('chat_id', tgChatId);
      tgForm.append(
        'document',
        new File([chunkBytes], partName, { type: 'application/octet-stream' })
      );

      const ctrl = new AbortController();
      const onParentAbort = () => ctrl.abort();
      if (request.signal) request.signal.addEventListener('abort', onParentAbort, { once: true });
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, tgSendTimeoutMs);

      try {
        tgResp = await fetch(sendUrl, {
          method: 'POST',
          body: tgForm,
          signal: ctrl.signal,
        });
        tgData = await tgResp.json().catch(() => null);
      } catch (netErr) {
        if (request.signal?.aborted) {
          chunkBytes = null;
          return jsonResponse({ error: '分片转存已取消', code: 'ABORTED', retryable: true }, 408);
        }
        lastErr = timedOut ? new Error('Telegram sendDocument 超时') : netErr;
        tgResp = null;
        tgData = null;
        if (!timedOut && attempt === 1 && Date.now() - sendLoopStartAt < INNER_RETRY_BUDGET_MS) {
          await sleepAbortable(300, request.signal);
          continue;
        }
        break;
      } finally {
        clearTimeout(timeoutId);
        if (request.signal) request.signal.removeEventListener('abort', onParentAbort);
      }

      if (tgResp.status === 429) {
        const retryAfter = Math.max(
          1,
          Math.min(TG_MAX_RETRY_AFTER_SECONDS, Number(tgData?.parameters?.retry_after) || 5)
        );
        await recordTelegramCooldown(env, tgChatId, retryAfter);
        chunkBytes = null;
        return telegramRateLimitResponse(retryAfter);
      }

      if (tgResp.ok && tgData?.ok) {
        lastErr = null;
        break;
      }

      if (tgResp.status >= 500 && attempt === 1 && Date.now() - sendLoopStartAt < INNER_RETRY_BUDGET_MS) {
        await sleepAbortable(300, request.signal);
        continue;
      }
      break;
    }

    chunkBytes = null;

    if (!tgResp || !tgResp.ok || !tgData?.ok) {
      const status = tgResp?.status || 0;
      const detail =
        tgData?.description ||
        lastErr?.message ||
        (status ? `HTTP ${status}` : '网络请求失败');
      const isTransient = !status || status >= 500 || status === 408;
      if (isTransient) {
        return jsonResponse(
          { error: `Telegram 分片上传暂时失败，请重试: ${detail}`, code: 'TG_PART_RETRY', retryable: true },
          503,
          { 'Retry-After': '1' }
        );
      }
      return jsonResponse(
        { error: `Telegram 分片上传失败: ${detail}`, code: 'TG_PART_FAILED', retryable: false },
        status >= 400 && status < 500 ? status : 502
      );
    }

    const fileId = pickTelegramFileId(tgData);
    const messageId = tgData?.result?.message_id ?? null;
    if (!fileId) {
      await discardUnconfirmedTelegramPart(env, uploadId, chunkIndex, taskData, tgChatId, messageId, { knownUntracked: true });
      return jsonResponse(
        { error: 'Telegram sendDocument 未返回有效的 file_id', code: 'TG_PART_RETRY', retryable: true },
        503,
        { 'Retry-After': '1' }
      );
    }

    const partRef = encodeTelegramPartRef(fileId, messageId);
    const confirmation = await confirmTelegramUploadPart(env, uploadId, chunkIndex, {
      partNumber, etag: partRef, size: expectedSize, uploadedAt: Date.now(),
    }, taskData, tgChatId);
    if (confirmation !== 'saved') {
      await discardUnconfirmedTelegramPart(env, uploadId, chunkIndex, taskData, tgChatId, messageId, {
        knownUntracked: confirmation === 'closed',
      });
      if (confirmation === 'closed') {
        return jsonResponse({ error: '上传任务已结束', code: 'UPLOAD_EXPIRED' }, 404);
      }
      return jsonResponse({
        error: '分片状态暂时无法保存，请重试', code: 'TG_PART_STATE_RETRY', retryable: true,
      }, 503);
    }

    return jsonResponse({
      success: true,
      chunkIndex,
      partNumber,
      etag: partRef,
      size: expectedSize,
      chunkBackend: 'telegram',
      reused: false,
    });
  } catch (error) {
    if (error instanceof RangeFetchError) {
      return jsonResponse(
        { error: error.message, code: error.code, retryable: error.retryable },
        error.status
      );
    }
    console.error('URL range chunk transfer error:', error);
    return jsonResponse({ error: error?.message || '分片转存失败', retryable: true }, 500);
  } finally {
    if (releaseTelegramPart) await releaseTelegramPart();
  }
}
