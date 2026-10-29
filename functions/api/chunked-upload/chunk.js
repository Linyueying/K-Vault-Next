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
 *   靠 expirationTtl 自动过期（5400 秒，与 init.js TASK_TTL_SECONDS 对齐）。
 *
 * - R2 临时分片对象（chunk-upload/<uploadId>/<chunkIndex>）：
 *   R2 不支持 expirationTtl，必须由以下两者之一清理：
 *   a) complete.js 成功路径调用 cleanupUploadTask 主动删除
 *   b) R2 生命周期规则：前缀 chunk-upload/ → 1 天后删除
 *
 * - R2 原生 multipart 的 part 元信息（part-state:<uploadId>:<index>）：
 *   etag 落库，供服务端级续传使用；由 complete.js 成功后清理，
 *   或靠 KV expirationTtl（90 分钟）兜底。
 * ================================================================
 */
import { checkAuthentication } from '../../utils/auth.js';
import { partStateKey } from '../../utils/chunk-state.js';
import {
  MAX_TOTAL_CHUNKS,
  MAX_FILE_SIZE_R2,
} from '../../utils/chunk-limits.js';

const TEMP_CHUNK_PREFIX = 'chunk-upload';

// 单个分片硬上限
// 必须 >= CHUNK_SIZE_R2（当前 50MB），且低于 Workers 100MB 请求体上限。
const MAX_CHUNK_SIZE = 64 * 1024 * 1024; // 64MB

// KV 单值上限 25MB，留安全余量按 24MB 作为 KV 分片硬上限。
// 仅在 chunkBackend === 'kv' 时生效；R2 分片无此限制。
const MAX_KV_CHUNK_SIZE = 24 * 1024 * 1024; // 24MB

// 分片相关 KV TTL（与 init.js 的 TASK_TTL_SECONDS 对齐 = 90 分钟）
const CHUNK_KV_TTL_SECONDS = 90 * 60;

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
      if (!taskData) {
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
      if (!taskData) {
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

    let chunkArrayBuffer;
    let chunkSize;

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

      chunkArrayBuffer = await request.arrayBuffer();
      if (chunkArrayBuffer.byteLength !== contentLength) {
        return jsonResponse(
          { error: '分片实际字节数与 Content-Length 不一致', code: 'CHUNK_BYTES_MISMATCH' },
          400
        );
      }
      chunkSize = chunkArrayBuffer.byteLength;
    } else {
      // ---- multipart 兼容路径（旧客户端 / 显式 multipart 的新客户端） ----
      // 旧协议在坐标解析阶段已拿到 formData 与 chunk；查询参数 + multipart
      // 的混合形态属于异常客户端，这里补一次解析兜底。
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
    if (taskData.storageMode === 'r2' && taskData.r2Multipart && env.R2_BUCKET) {
      if (!taskData.r2Multipart.key || !taskData.r2Multipart.uploadId) {
        return jsonResponse({ error: 'R2 multipart 任务信息不完整' }, 500);
      }

      const mp = env.R2_BUCKET.resumeMultipartUpload(
        taskData.r2Multipart.key,
        taskData.r2Multipart.uploadId
      );

      const partNumber = chunkIndex + 1;
      const uploadedPart = await mp.uploadPart(partNumber, chunkArrayBuffer);

      if (!uploadedPart || !uploadedPart.etag) {
        return jsonResponse({ error: 'R2 uploadPart 未返回有效 etag' }, 500);
      }

      // ============================================================
      // 持久化 part 元信息（服务端级断点续传的关键）
      //
      // etag 是 complete 合并 multipart 的必需品。以前它只存在于前端内存
      // 与 localStorage，一旦换设备/清缓存就彻底丢失，用户只能重传整个文件。
      // 这里把它落到 KV，服务端就能自己拼出完整 parts 直接合并。
      //
      // 写失败不回滚：分片已经成功进入 R2，本次上传仍然有效，
      // 只是"下次续传"拿不到这一片。宁可降级为客户端续传，也不要让
      // 一个已经成功的分片变成失败。
      // ============================================================
      try {
        await env.img_url.put(
          partStateKey(uploadId, chunkIndex),
          JSON.stringify({
            partNumber,
            etag: uploadedPart.etag,
            size: chunkSize,
            uploadedAt: Date.now(),
          }),
          { expirationTtl: CHUNK_KV_TTL_SECONDS }
        );
      } catch (stateErr) {
        console.error(
          `Persist part state failed (uploadId=${uploadId}, part=${partNumber}):`,
          stateErr
        );
      }

      return jsonResponse({
        success: true,
        chunkIndex,
        partNumber,
        etag: uploadedPart.etag,
        size: chunkSize,
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

      // ⚠️ R2 对象无 TTL，清理依赖：
      //    a) complete.js 成功时 cleanupUploadTask
      //    b) R2 生命周期规则（chunk-upload/ 前缀 1 天后删除）
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
