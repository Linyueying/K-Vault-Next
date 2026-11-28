/**
 * Upload one file chunk.
 * POST /api/chunked-upload/chunk[?uploadId=<id>&chunkIndex=<n>]
 *
 * ================================================================
 * 【本次变更】先验任务、再读字节；精确分片大小；原始 body 快速路径
 * ================================================================
 *
 * 1) 「先验任务，再读字节」
 *    旧实现无条件 `request.formData()`，无效任务（不存在 / 无权 / 越界 /
 *    大小不符）也会先付出完整 multipart 解析成本 —— 对一个 50MB 的分片，
 *    这是一次白白吃掉 isolate 内存的拷贝。
 *    新协议把 uploadId / chunkIndex 放进 URL 查询参数，body 直接就是分片
 *    字节（Content-Type: application/octet-stream）。服务端先读任务、完成
 *    归属与大小校验，全部通过后才触碰 body。
 *
 * 2) 精确分片大小校验
 *    旧的「平均分片大小 × 2」软上限允许约 2 倍的尺寸偏差通过，错位分片
 *    要到 complete 阶段才暴露。任务 KV 里的 chunkSize 是 init 阶段写入的
 *    实际值，分片大小因此可以精确推导：
 *      非末片 = chunkSize
 *      末片   = fileSize - chunkSize × (totalChunks - 1)
 *    旧任务（无 chunkSize 字段）回落启发式，兼容不破坏。
 *
 * 3) 原始 body 快速路径省一次拷贝
 *    multipart 路径：运行时缓冲 → formData File → arrayBuffer()，两份拷贝。
 *    原始 body 路径：运行时缓冲 → arrayBuffer()，一份拷贝。
 *    R2 原生 multipart 的 uploadPart 直接吃 ArrayBuffer，不再经过 File。
 *    （进一步流式化受 R2 绑定对未知长度流的支持限制，暂不做。）
 *
 * 旧客户端（FormData 带 uploadId/chunkIndex 字段）仍走兼容路径，
 * 校验强度不低于旧实现。
 * ================================================================
 *
 * 历史修复保留：
 * 1. 强制鉴权（不再依赖 AUTH_REQUIRED 环境变量）
 * 2. 严格校验 chunkIndex 为整数且在 [0, totalChunks) 范围内
 * 3. 校验分片实际字节数与声明大小的一致性（关键防御）
 * 4. 限制 totalChunks 上限，防止 complete.js 循环 DoS
 * 5. 限制单分片大小
 * 6. 任务归属校验（若 init.js 已写入 ownerId）
 * 7. 分片状态由客户端跟踪，服务端只持久化 part etag
 * 8. 空分片拒绝
 * 9. 统一 getOwnerId(auth)，禁止 ownerId 为空时跳过归属校验
 * 10. KV 分片大小兜底：KV 单值上限 25MB，非 R2 后端拒绝过大分片
 *
 * ================================================================
 * 存储清理责任划分（与 R2 泄漏修复对齐）
 * ================================================================
 * - KV 分片（chunk:{uploadId}:{chunkIndex}）：
 *   靠与上传任务一致的到期规则自动过期。
 *
 * - R2 临时分片对象（chunk-upload/<uploadId>/<chunkIndex>）：
 *   R2 不支持 expirationTtl，必须由以下两者之一清理：
 *   a) complete.js 成功路径调用 cleanupUploadTask 主动删除
 *   b) 上传初始化时后台清理已过期的旧版暂存对象
 *
 * - R2 原生 multipart 的 part 元信息（part-state:<uploadId>:<index>）：
 *   etag 落库，供服务端级续传使用；由 complete.js 成功后清理，
 *   或随上传任务到期。
 * ================================================================
 */
import { checkAuthentication } from '../../utils/auth.js';
import { envValue } from '../../utils/env-config.js';
import {
  buildTelegramBotApiUrl,
  pickTelegramFileId,
} from '../../utils/telegram.js';
import {
  decodeTelegramPartRef,
  encodeTelegramPartRef,
  getUploadedPart,
  isChunkTaskExpired,
  LEGACY_CHUNK_TTL_SECONDS,
  recordUploadedPart,
} from '../../utils/chunk-state.js';
import { classifyR2Error, retryR2Op } from '../../utils/r2-retry.js';
import {
  MAX_TOTAL_CHUNKS,
  MAX_FILE_SIZE_R2,
  CHUNK_SIZE_TELEGRAM,
} from '../../utils/chunk-limits.js';

const TEMP_CHUNK_PREFIX = 'chunk-upload';

// 单个分片硬上限
// 必须 >= CHUNK_SIZE_R2（当前 50MB），且低于 Workers 100MB 请求体上限。
const MAX_CHUNK_SIZE = 64 * 1024 * 1024; // 64MB

// KV 单值上限 25MB，留安全余量按 24MB 作为 KV 分片硬上限。
// 仅在 chunkBackend === 'kv' 时生效；R2 分片无此限制。
const MAX_KV_CHUNK_SIZE = 24 * 1024 * 1024; // 24MB

// KV 暂存分片仍使用旧任务的 TTL。
const CHUNK_KV_TTL_SECONDS = LEGACY_CHUNK_TTL_SECONDS;

// Telegram 全局 429 冷却态：仅在真正触发 429 时写入一次（正常路径 0 写入开销），
// L1 按 env.img_url 隔离（WeakMap），跨标签/多用户/多 isolate 通过 KV 共享剩余冷却时间，
// 收到后续分片时在读取 18MB body 之前直接短路返回 429 + 剩余 Retry-After。
const TG_COOLDOWN_KV_PREFIX = 'tg-cooldown:';
const TG_MAX_RETRY_AFTER_SECONDS = 3600;
const tgCooldownByKv = new WeakMap();
const tgCooldownFallback = new Map();

function getCooldownMap(env) {
  if (!env?.img_url) return tgCooldownFallback;
  let map = tgCooldownByKv.get(env.img_url);
  if (!map) {
    map = new Map();
    tgCooldownByKv.set(env.img_url, map);
  }
  return map;
}

function telegramCooldownKey(chatId) {
  return `${TG_COOLDOWN_KV_PREFIX}${String(chatId || '').trim()}`;
}

export async function getTelegramCooldownRemainingSec(env, chatId) {
  const cid = String(chatId || '').trim();
  if (!cid) return 0;
  const now = Date.now();
  const map = getCooldownMap(env);
  const localUntil = map.get(cid) || 0;
  if (localUntil > now) {
    return Math.max(1, Math.ceil((localUntil - now) / 1000));
  }
  if (localUntil > 0) map.delete(cid);

  if (env?.img_url) {
    try {
      const stored = await env.img_url.get(telegramCooldownKey(cid), { type: 'json' });
      const until = Number(stored?.until || 0);
      if (Number.isFinite(until) && until > now) {
        map.set(cid, until);
        return Math.max(1, Math.ceil((until - now) / 1000));
      }
    } catch {
      // ignore KV read failure; fall through to normal upload
    }
  }
  return 0;
}

export async function recordTelegramCooldown(env, chatId, retryAfterSec) {
  const cid = String(chatId || '').trim();
  const secs = Math.max(1, Math.min(TG_MAX_RETRY_AFTER_SECONDS, Math.ceil(Number(retryAfterSec) || 5)));
  if (!cid) return;
  const until = Date.now() + secs * 1000;
  const map = getCooldownMap(env);
  const nextUntil = Math.max(map.get(cid) || 0, until);
  map.set(cid, nextUntil);

  if (env?.img_url) {
    // Cloudflare KV 最小 expirationTtl 为 60s；实际精确过期由 payload.until 裁决
    const kvTtl = Math.max(60, Math.min(TG_MAX_RETRY_AFTER_SECONDS + 60, secs + 5));
    await env.img_url
      .put(
        telegramCooldownKey(cid),
        JSON.stringify({ until: nextUntil, retryAfter: secs }),
        { expirationTtl: kvTtl }
      )
      .catch(() => {});
  }
}

/** @internal 供测试在同 env 模拟时间推进时清理冷却态 */
export async function clearTelegramCooldown(env, chatId = null) {
  const map = getCooldownMap(env);
  if (chatId) {
    const cid = String(chatId).trim();
    map.delete(cid);
    if (env?.img_url) {
      await env.img_url.delete(telegramCooldownKey(cid)).catch(() => {});
    }
    return;
  }
  const keys = Array.from(map.keys());
  map.clear();
  if (env?.img_url) {
    for (const cid of keys) {
      await env.img_url.delete(telegramCooldownKey(cid)).catch(() => {});
    }
  }
}

export function telegramRateLimitResponse(retryAfterSec, shared = false) {
  const retryAfter = Math.max(1, Math.min(TG_MAX_RETRY_AFTER_SECONDS, Math.ceil(Number(retryAfterSec) || 5)));
  return new Response(
    JSON.stringify({
      error: `Telegram 触发频控限流，将在 ${retryAfter} 秒后重试`,
      code: 'TG_RATE_LIMITED',
      retryable: true,
      retryAfter,
      ...(shared ? { cooldownSource: 'shared' } : {}),
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
      },
    }
  );
}

/**
 * 按分片体积动态计算单次 Telegram sendDocument 超时（25s ~ 55s）。
 * 配合超时后不再同 Worker 内循环重试，彻底杜绝 55s×2=110s 触发 Cloudflare 100s (524)。
 */
export function computeTelegramSendTimeoutMs(chunkBytes) {
  const mb = Math.max(1, Math.ceil((Number(chunkBytes) || 0) / (1024 * 1024)));
  return Math.min(55 * 1000, Math.max(25 * 1000, 20 * 1000 + mb * 2000));
}

/**
 * 精确推导分片应有多少字节。
 *
 * 任务 KV 的 chunkSize 是 init 阶段写入的实际分片大小（R2 原生 50MB /
 * KV 暂存 20MB，或更早契约的其他值）。前端按「固定 chunkSize 切片、
 * 末片取剩余」的规则分片，因此每个分片的大小都可以精确算出：
 *   - 非末片：chunkSize
 *   - 末片：fileSize - chunkSize × (totalChunks - 1)
 *
 * 旧任务可能没有 chunkSize 字段（或值非法），此时返回 null，
 * 调用方回落到旧的「平均大小 × 2」启发式 —— 只放宽、不误拒。
 *
 * @param {object} taskData 任务 KV 数据
 * @param {number} chunkIndex 分片下标（0 起）
 * @param {number} totalChunks 任务总分片数
 * @param {number} declaredFileSize 任务声明的文件总大小
 * @returns {number|null} 精确字节数；无法精确推导时为 null
 */
export function computeExpectedChunkSize(taskData, chunkIndex, totalChunks, declaredFileSize) {
  const chunkSize = Number(taskData?.chunkSize || 0);
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) return null;
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) return null;

  if (chunkIndex === totalChunks - 1) {
    const lastSize = declaredFileSize - chunkSize * (totalChunks - 1);
    // 末片至少 1 字节：fileSize 恰好整除时 totalChunks 会少 1，
    // 因此合法任务的末片必然 > 0。<= 0 说明任务数据本身不一致，
    // 交还给调用方按错误处理，而不是在这里猜。
    return lastSize > 0 ? lastSize : null;
  }
  return chunkSize;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // ============================================
    // 1. 强制鉴权
    // ============================================
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
      return jsonResponse({ error: '无法识别用户身份，拒绝分片上传' }, 401);
    }

    // ============================================
    // 2. 解析分片坐标（查询参数优先，回退表单字段）
    // ============================================
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return jsonResponse({ error: 'Invalid request URL' }, 400);
    }

    const queryUploadId = url.searchParams.get('uploadId');
    const queryChunkIndex = url.searchParams.get('chunkIndex');

    // 查询参数带了但格式非法 → 明确拒绝（而不是静默回退表单路径，
    // 否则新客户端的协议错误会被当成「旧客户端」处理，难以排查）。
    if (
      (queryUploadId !== null && !/^[a-f0-9]{16,64}$/i.test(queryUploadId)) ||
      (queryChunkIndex !== null && !/^\d+$/.test(queryChunkIndex))
    ) {
      return jsonResponse({ error: 'uploadId / chunkIndex 查询参数格式错误' }, 400);
    }

    const useRawBody = queryUploadId !== null && queryChunkIndex !== null;
    let uploadId;
    let chunkIndex;
    let taskData = null;
    let legacyChunk = null;

    if (useRawBody) {
      uploadId = queryUploadId;
      chunkIndex = parseInt(queryChunkIndex, 10);

      // ---- 先验任务：读完任务、校验完归属与范围，才允许触碰 body ----
      taskData = await env.img_url.get(`upload:${uploadId}`, { type: 'json' });
      if (!taskData || isChunkTaskExpired(taskData)) {
        return jsonResponse({ error: '上传任务不存在或已过期' }, 404);
      }
      if (!taskData.ownerId || taskData.ownerId !== ownerId) {
        return jsonResponse({ error: '无权操作该上传任务' }, 403);
      }
    } else {
      // ---- 旧协议：multipart 表单携带坐标，只能解析后校验 ----
      // 注意 formData 只能解析一次，这里顺带把 chunk 取出来供第 4 步复用。
      const formData = await request.formData();
      uploadId = formData.get('uploadId');
      const rawChunkIndex = formData.get('chunkIndex');
      legacyChunk = formData.get('chunk');

      if (
        !uploadId ||
        typeof uploadId !== 'string' ||
        !/^[a-f0-9]{16,64}$/i.test(uploadId)
      ) {
        return jsonResponse({ error: 'uploadId 格式错误' }, 400);
      }

      chunkIndex =
        typeof rawChunkIndex === 'string' && /^\d+$/.test(rawChunkIndex)
          ? parseInt(rawChunkIndex, 10)
          : NaN;
    }

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return jsonResponse({ error: 'chunkIndex 必须为非负整数' }, 400);
    }

    // ============================================
    // 3. 读取并校验任务（raw 路径已读，此处只做旧协议补读）
    // ============================================
    if (!taskData) {
      taskData = await env.img_url.get(`upload:${uploadId}`, { type: 'json' });
      if (!taskData || isChunkTaskExpired(taskData)) {
        return jsonResponse({ error: '上传任务不存在或已过期' }, 404);
      }

      if (!taskData.ownerId || taskData.ownerId !== ownerId) {
        return jsonResponse({ error: '无权操作该上传任务' }, 403);
      }
    }

    const totalChunks = Number(taskData.totalChunks || 0);
    const declaredFileSize = Number(taskData.fileSize || 0);

    if (!Number.isFinite(totalChunks) || totalChunks <= 0) {
      return jsonResponse({ error: 'Invalid totalChunks in upload task.' }, 400);
    }

    if (totalChunks > MAX_TOTAL_CHUNKS) {
      return jsonResponse(
        { error: `totalChunks 超过上限 (${MAX_TOTAL_CHUNKS})` },
        400
      );
    }

    if (!Number.isFinite(declaredFileSize) || declaredFileSize <= 0) {
      return jsonResponse({ error: 'Invalid fileSize in upload task.' }, 400);
    }

    if (declaredFileSize > MAX_FILE_SIZE_R2) {
      return jsonResponse(
        { error: `fileSize 超过上限 (${MAX_FILE_SIZE_R2} bytes)` },
        413
      );
    }

    if (chunkIndex >= totalChunks) {
      return jsonResponse(
        { error: `chunkIndex ${chunkIndex} 超出范围 (0 ~ ${totalChunks - 1})` },
        400
      );
    }

    // ============================================
    // 4. 分片大小校验（关键防御）
    //
    // 精确值优先（computeExpectedChunkSize），旧任务回落启发式：
    //   expectedAverage ≈ fileSize / totalChunks，允许 2 倍软上限。
    // ============================================
    const exactSize = computeExpectedChunkSize(
      taskData,
      chunkIndex,
      totalChunks,
      declaredFileSize
    );

    let chunkArrayBuffer = null;
    let chunkSize;
    let streamToR2 = false;

    const isR2Native =
      taskData.storageMode === 'r2' &&
      Boolean(taskData.r2Multipart) &&
      Boolean(env.R2_BUCKET);
    const isTelegramChunked =
      taskData.storageMode === 'telegram' &&
      taskData.chunkBackend === 'telegram';
    const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();

    if (useRawBody && !contentType.includes('multipart/form-data')) {
      // ---- 原始 body 快速路径：Content-Length 即分片大小，先验后读 ----
      const contentLength = Number(request.headers.get('Content-Length') || 0);

      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        return jsonResponse(
          { error: '缺少或非法 Content-Length，无法校验分片大小', code: 'CHUNK_LENGTH_MISSING' },
          400
        );
      }

      if (contentLength > MAX_CHUNK_SIZE) {
        return jsonResponse(
          { error: `单个分片超过上限 (${MAX_CHUNK_SIZE} bytes)` },
          413
        );
      }

      if (exactSize !== null && contentLength !== exactSize) {
        return jsonResponse(
          {
            error: `分片大小异常：分片 ${chunkIndex} 声明 ${contentLength} 字节，` +
              `任务契约要求 ${exactSize} 字节`,
            code: 'CHUNK_SIZE_MISMATCH',
          },
          400
        );
      }

      if (exactSize === null) {
        // 旧任务无精确契约 → 沿用启发式软上限
        const expectedAverage = declaredFileSize / totalChunks;
        const softMaxChunkSize = Math.min(
          MAX_CHUNK_SIZE,
          Math.max(1, Math.ceil(expectedAverage * 2))
        );
        if (contentLength > softMaxChunkSize) {
          return jsonResponse(
            {
              error: `分片大小异常：分片 ${chunkIndex} 为 ${contentLength} 字节，` +
                `超过任务声明允许的上限 ${softMaxChunkSize} 字节`,
              code: 'CHUNK_SIZE_MISMATCH',
            },
            400
          );
        }
      }

      // Telegram 虚拟分片：先验单片上限 + 查是否已落库幂等复用，命中直接返回，
      // 既避免 18MB ArrayBuffer 拷贝，也杜绝客户端响应丢失重传时在频道里产生重复消息与额外 429。
      if (isTelegramChunked) {
        if (contentLength > CHUNK_SIZE_TELEGRAM) {
          return jsonResponse(
            {
              error: `Telegram 虚拟分片单片不能超过 ${CHUNK_SIZE_TELEGRAM} 字节（当前 ${contentLength} 字节）`,
              code: 'TG_CHUNK_TOO_LARGE',
            },
            413
          );
        }
        const existingPart = await getUploadedPart(env, uploadId, chunkIndex);
        if (
          existingPart &&
          existingPart.partNumber === chunkIndex + 1 &&
          decodeTelegramPartRef(existingPart.etag)?.fileId &&
          (!existingPart.size || existingPart.size === contentLength)
        ) {
          if (request.body && typeof request.body.cancel === 'function') {
            await request.body.cancel().catch(() => {});
          }
          return jsonResponse({
            success: true,
            chunkIndex,
            partNumber: existingPart.partNumber,
            etag: existingPart.etag,
            size: contentLength,
            chunkBackend: 'telegram',
            reused: true,
          });
        }
        const tgChatIdPre = envValue(env, 'TG_CHAT_ID');
        const coolRemainSec = await getTelegramCooldownRemainingSec(env, tgChatIdPre);
        if (coolRemainSec > 0) {
          if (request.body && typeof request.body.cancel === 'function') {
            await request.body.cancel().catch(() => {});
          }
          return telegramRateLimitResponse(coolRemainSec, true);
        }
      }

      // Workers 运行时具备 FixedLengthStream 时，R2 原生分片直接流式透传，
      // 不再把 10~50MB 整片缓冲到 Worker V8 堆内存，单路内存峰值降至 O(1)。
      const canStreamR2 =
        isR2Native &&
        typeof FixedLengthStream === 'function' &&
        Boolean(request.body) &&
        typeof request.body.pipeTo === 'function';

      if (canStreamR2) {
        streamToR2 = true;
        chunkSize = contentLength;
      } else {
        chunkArrayBuffer = await request.arrayBuffer();
        if (chunkArrayBuffer.byteLength !== contentLength) {
          return jsonResponse(
            { error: '分片实际字节数与 Content-Length 不一致', code: 'CHUNK_BYTES_MISMATCH' },
            400
          );
        }
        chunkSize = chunkArrayBuffer.byteLength;
      }
    } else {
      // ---- multipart 兼容路径（旧客户端 / 显式 multipart 的新客户端） ----
      let chunk = legacyChunk;
      if (!chunk && useRawBody) {
        const formData = await request.formData();
        chunk = formData.get('chunk');
      }

      if (!chunk || typeof chunk === 'string' || typeof chunk.size !== 'number') {
        return jsonResponse({ error: 'chunk 参数格式错误' }, 400);
      }

      if (chunk.size <= 0) {
        return jsonResponse({ error: '空分片不允许上传' }, 400);
      }

      if (chunk.size > MAX_CHUNK_SIZE) {
        return jsonResponse(
          { error: `单个分片超过上限 (${MAX_CHUNK_SIZE} bytes)` },
          413
        );
      }

      if (exactSize !== null && chunk.size !== exactSize) {
        return jsonResponse(
          {
            error: `分片大小异常：分片 ${chunkIndex} 为 ${chunk.size} 字节，` +
              `任务契约要求 ${exactSize} 字节`,
            code: 'CHUNK_SIZE_MISMATCH',
          },
          400
        );
      }

      if (exactSize === null) {
        const expectedAverage = declaredFileSize / totalChunks;
        const softMaxChunkSize = Math.min(
          MAX_CHUNK_SIZE,
          Math.max(1, Math.ceil(expectedAverage * 2))
        );
        if (chunk.size > softMaxChunkSize) {
          return jsonResponse(
            {
              error: `分片大小异常：分片 ${chunkIndex} 为 ${chunk.size} 字节，` +
                `超过任务声明允许的上限 ${softMaxChunkSize} 字节`,
              code: 'CHUNK_SIZE_MISMATCH',
            },
            400
          );
        }
      }

      chunkArrayBuffer = await chunk.arrayBuffer();
      if (chunkArrayBuffer.byteLength !== chunk.size) {
        return jsonResponse(
          { error: '分片实际字节数与声明不一致', code: 'CHUNK_BYTES_MISMATCH' },
          400
        );
      }
      chunkSize = chunk.size;
    }

    // ============================================
    // 5. R2 原生 Multipart 分支
    // ============================================
    if (isR2Native) {
      if (!taskData.r2Multipart.key || !taskData.r2Multipart.uploadId) {
        return jsonResponse({ error: 'R2 multipart 任务信息不完整' }, 500);
      }

      const mp = env.R2_BUCKET.resumeMultipartUpload(
        taskData.r2Multipart.key,
        taskData.r2Multipart.uploadId
      );

      const partNumber = chunkIndex + 1;
      let uploadedPart;

      try {
        if (streamToR2) {
          const fixedStream = new FixedLengthStream(chunkSize);
          const [partResult] = await Promise.all([
            mp.uploadPart(partNumber, fixedStream.readable),
            request.body.pipeTo(fixedStream.writable),
          ]);
          uploadedPart = partResult;
        } else {
          // 缓冲模式（Node 测试或旧 FormData 客户端）：幂等重试瞬态 R2 抖动
          uploadedPart = await retryR2Op(
            () => mp.uploadPart(partNumber, chunkArrayBuffer),
            {
              maxAttempts: 3,
              baseDelayMs: 200,
              maxDelayMs: 1500,
              onRetry: (err, attempt, delayMs) => {
                console.warn(
                  `R2 uploadPart retry ${attempt} (uploadId=${uploadId}, part=${partNumber}, wait=${delayMs}ms):`,
                  err?.message || err
                );
              },
            }
          );
        }
      } catch (r2Err) {
        const msg = String(r2Err?.message || r2Err || '');
        if (streamToR2 && /fixedlengthstream|exceeded|ended prematurely|expected.*bytes|short write/i.test(msg)) {
          return jsonResponse(
            { error: '分片实际字节数与 Content-Length 不一致', code: 'CHUNK_BYTES_MISMATCH' },
            400
          );
        }
        const kind = classifyR2Error(r2Err);
        console.error(
          `R2 uploadPart failed (uploadId=${uploadId}, part=${partNumber}, kind=${kind}):`,
          msg
        );
        if (kind === 'expired') {
          return jsonResponse(
            { error: 'R2 分片上传会话已过期，请重新初始化', code: 'R2_UPLOAD_EXPIRED' },
            404
          );
        }
        if (kind === 'client') {
          return jsonResponse(
            { error: `R2 分片校验失败: ${msg}`, code: 'R2_PART_INVALID' },
            400
          );
        }
        return new Response(
          JSON.stringify({ error: `R2 分片写入暂时失败，请重试: ${msg}`, code: 'R2_PART_RETRY' }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '1',
            },
          }
        );
      }

      if (!uploadedPart || !uploadedPart.etag) {
        return new Response(
          JSON.stringify({ error: 'R2 uploadPart 未返回有效 etag', code: 'R2_PART_RETRY' }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '1',
            },
          }
        );
      }

      // 持久化 part 元信息（D1 upload_parts 优先，失败或无 D1 回落 KV）
      // 写失败不回滚：分片已经成功进入 R2，本次上传仍然有效。
      await recordUploadedPart(
        env,
        uploadId,
        chunkIndex,
        {
          partNumber,
          etag: uploadedPart.etag,
          size: chunkSize,
          uploadedAt: Date.now(),
        },
        taskData
      );

      return jsonResponse({
        success: true,
        chunkIndex,
        partNumber,
        etag: uploadedPart.etag,
        size: chunkSize,
        streamed: streamToR2,
      });
    }

    // ============================================
    // 5.5 Telegram 虚拟分片直传分支
    //     每片 <= 18MB 直接作为 document 发到 Telegram 频道，不落 KV/R2 暂存，
    //     仅把 (file_id, message_id) 编码写入 upload_parts / part-state 供续传与合并。
    // ============================================
    if (isTelegramChunked) {
      if (chunkSize > CHUNK_SIZE_TELEGRAM) {
        return jsonResponse(
          {
            error: `Telegram 虚拟分片单片不能超过 ${CHUNK_SIZE_TELEGRAM} 字节（当前 ${chunkSize} 字节）`,
            code: 'TG_CHUNK_TOO_LARGE',
          },
          413
        );
      }

      const tgBotToken = envValue(env, 'TG_BOT_TOKEN');
      const tgChatId = envValue(env, 'TG_CHAT_ID');
      if (!tgBotToken || !tgChatId) {
        return jsonResponse(
          { error: 'Telegram Bot 未配置（缺少 TG_BOT_TOKEN / TG_CHAT_ID）' },
          500
        );
      }

      const partNumber = chunkIndex + 1;
      // 兼容旧 multipart 路径的幂等复用与全局 429 冷却兜底（raw body 快路径已在读 body 前短路）
      if (!useRawBody || contentType.includes('multipart/form-data')) {
        const existingPart = await getUploadedPart(env, uploadId, chunkIndex);
        if (
          existingPart &&
          existingPart.partNumber === partNumber &&
          decodeTelegramPartRef(existingPart.etag)?.fileId &&
          (!existingPart.size || existingPart.size === chunkSize)
        ) {
          chunkArrayBuffer = null;
          return jsonResponse({
            success: true,
            chunkIndex,
            partNumber: existingPart.partNumber,
            etag: existingPart.etag,
            size: chunkSize,
            chunkBackend: 'telegram',
            reused: true,
          });
        }
        const coolRemainSec = await getTelegramCooldownRemainingSec(env, tgChatId);
        if (coolRemainSec > 0) {
          chunkArrayBuffer = null;
          return telegramRateLimitResponse(coolRemainSec, true);
        }
      }

      const partName = `${uploadId.slice(0, 12)}.part${String(chunkIndex).padStart(3, '0')}`;
      const sendUrl = buildTelegramBotApiUrl(env, 'sendDocument');
      const tgSendTimeoutMs = computeTelegramSendTimeoutMs(chunkSize);
      const sendLoopStartAt = Date.now();
      const INNER_RETRY_BUDGET_MS = 25 * 1000;

      let tgResp = null;
      let tgData = null;
      let lastErr = null;
      const maxAttempts = 2;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const tgForm = new FormData();
        tgForm.append('chat_id', tgChatId);
        tgForm.append(
          'document',
          new File([chunkArrayBuffer], partName, {
            type: 'application/octet-stream',
          })
        );

        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let timeoutId = null;
        if (ctrl) {
          timeoutId = setTimeout(() => {
            try { ctrl.abort(); } catch {}
          }, tgSendTimeoutMs);
        }

        try {
          tgResp = await fetch(sendUrl, {
            method: 'POST',
            body: tgForm,
            ...(ctrl ? { signal: ctrl.signal } : {}),
          });
          tgData = await tgResp.json().catch(() => null);
        } catch (netErr) {
          const isTimeout = netErr?.name === 'AbortError';
          lastErr = isTimeout
            ? new Error('Telegram sendDocument 超时')
            : netErr;
          tgResp = null;
          tgData = null;
          // 超时（25~55s）或已消耗 >=25s 时绝不在同一次 Worker 调用内重发，
          // 防止 55s×2=110s 突破 Cloudflare 100s (524) 代理超时，改交由前端退避重传。
          if (!isTimeout && attempt < maxAttempts && (Date.now() - sendLoopStartAt) < INNER_RETRY_BUDGET_MS) {
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          break;
        } finally {
          if (timeoutId !== null) clearTimeout(timeoutId);
        }

        // 429 FloodWait：记录全局共享冷却态，并完整透传真实 Retry-After（封顶 3600s）
        // 给前端：<=300s 自动倒计时续传，>300s 优雅暂停保留断点。
        if (tgResp.status === 429) {
          const retryAfter = Math.max(
            1,
            Math.min(TG_MAX_RETRY_AFTER_SECONDS, Number(tgData?.parameters?.retry_after) || 5)
          );
          await recordTelegramCooldown(env, tgChatId, retryAfter);
          chunkArrayBuffer = null;
          return telegramRateLimitResponse(retryAfter);
        }

        if (tgResp.ok && tgData?.ok) {
          lastErr = null;
          break;
        }

        // 5xx 瞬态错误：仅在单次 Worker 时间预算充裕时短退避重试一次
        if (tgResp.status >= 500 && attempt < maxAttempts && (Date.now() - sendLoopStartAt) < INNER_RETRY_BUDGET_MS) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }

        // 4xx 确定性错误或重试耗尽
        break;
      }

      // 分片字节已发完，尽快释放 18MB ArrayBuffer 引用，降低并发请求下 Worker 128MB isolate 内存峰值
      chunkArrayBuffer = null;

      if (!tgResp || !tgResp.ok || !tgData?.ok) {
        const status = tgResp?.status || 0;
        const detail =
          tgData?.description ||
          lastErr?.message ||
          (status ? `HTTP ${status}` : '网络请求失败');
        const isTransient = !status || status >= 500 || status === 408;

        console.error(
          `Telegram chunk sendDocument failed (uploadId=${uploadId}, part=${partNumber}, status=${status}):`,
          detail
        );

        if (isTransient) {
          return new Response(
            JSON.stringify({
              error: `Telegram 分片上传暂时失败，请重试: ${detail}`,
              code: 'TG_PART_RETRY',
              retryable: true,
            }),
            {
              status: 503,
              headers: {
                'Content-Type': 'application/json',
                'Retry-After': '1',
              },
            }
          );
        }

        return jsonResponse(
          {
            error: `Telegram 分片上传失败: ${detail}`,
            code: 'TG_PART_FAILED',
            retryable: false,
          },
          status >= 400 && status < 500 ? status : 502
        );
      }

      const fileId = pickTelegramFileId(tgData);
      const messageId = tgData?.result?.message_id ?? null;
      if (!fileId) {
        return new Response(
          JSON.stringify({
            error: 'Telegram sendDocument 未返回有效的 file_id',
            code: 'TG_PART_RETRY',
            retryable: true,
          }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '1',
            },
          }
        );
      }

      const partRef = encodeTelegramPartRef(fileId, messageId);
      await recordUploadedPart(
        env,
        uploadId,
        chunkIndex,
        {
          partNumber,
          etag: partRef,
          size: chunkSize,
          uploadedAt: Date.now(),
        },
        taskData
      );

      return jsonResponse({
        success: true,
        chunkIndex,
        partNumber,
        etag: partRef,
        size: chunkSize,
        chunkBackend: 'telegram',
      });
    }

    // ============================================
    // 6. 非 R2 原生存储节点：分片暂存分支
    // ============================================
    const chunkBackend = resolveChunkBackend(taskData, env);

    // KV 单值上限 25MB，非 R2 后端拒绝过大分片，避免 KV 写入失败。
    // （正常情况下前端会在无 R2 时把分片降到 20MB，这里仅作兜底。）
    if (chunkBackend === 'kv' && chunkSize > MAX_KV_CHUNK_SIZE) {
      return jsonResponse(
        {
          error:
            `当前未配置 R2，分片只能暂存到 KV（单个值上限 25MB），` +
            `当前分片 ${chunkSize} 字节过大。请配置 R2 或减小分片大小。`,
          code: 'KV_CHUNK_TOO_LARGE',
        },
        413
      );
    }

    // 写入分片数据
    if (chunkBackend === 'r2') {
      if (!env.R2_BUCKET) {
        return jsonResponse(
          { error: 'R2 chunk backend requested but R2_BUCKET is not configured.' },
          500
        );
      }

      // 兼容升级前已经使用 R2 暂存的任务。
      await env.R2_BUCKET.put(
        getChunkObjectKey(uploadId, chunkIndex),
        chunkArrayBuffer,
        {
          customMetadata: {
            type: 'chunk',
            uploadId,
            chunkIndex: String(chunkIndex),
            size: String(chunkSize),
            createdAt: String(Date.now()),
          },
        }
      );
    } else {
      // KV 分片靠 expirationTtl 自动过期（90 分钟）
      await env.img_url.put(`chunk:${uploadId}:${chunkIndex}`, chunkArrayBuffer, {
        expirationTtl: CHUNK_KV_TTL_SECONDS,
        metadata: {
          type: 'chunk',
          uploadId,
          chunkIndex,
          size: chunkSize,
          createdAt: Date.now(),
        },
      });
    }

    // 非全局精确进度：仅基于当前请求的 chunkIndex 近似计算。
    const progress = (((chunkIndex + 1) / totalChunks) * 100).toFixed(1);

    return jsonResponse({
      success: true,
      chunkIndex,
      size: chunkSize,
      chunkBackend,
      progress,
    });
  } catch (error) {
    console.error('Chunk upload error:', error);
    return jsonResponse({ error: error.message || 'Unknown error' }, 500);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getOwnerId(auth) {
  const raw =
    auth?.userId ??
    auth?.user?.id ??
    auth?.user?.email ??
    auth?.email ??
    (typeof auth?.user === 'string' ? auth.user : null) ??
    null;

  if (raw === null || raw === undefined) return null;

  const value = String(raw).trim();
  return value || null;
}

function resolveChunkBackend(taskData, env) {
  if (taskData?.chunkBackend === 'r2' && env.R2_BUCKET) return 'r2';
  if (taskData?.chunkBackend === 'kv') return 'kv';
  return env.R2_BUCKET ? 'r2' : 'kv';
}

function getChunkObjectKey(uploadId, chunkIndex) {
  return `${TEMP_CHUNK_PREFIX}/${uploadId}/${chunkIndex}`;
}
