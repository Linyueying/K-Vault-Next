/**
 * Upload one file chunk.
 * POST /api/chunked-upload/chunk
 *
 * 修复要点：
 * 1. 强制鉴权（不再依赖 AUTH_REQUIRED 环境变量）
 * 2. 严格校验 chunkIndex 为整数且在 [0, totalChunks) 范围内
 * 3. 校验分片实际字节数与声明大小的一致性（关键防御）
 * 4. 限制 totalChunks 上限，防止 complete.js 循环 DoS
 * 5. 限制单分片大小，并根据文件大小推导软上限
 * 6. 任务归属校验（若 init.js 已写入 ownerId）
 * 7. 分片状态由客户端跟踪，服务端不再写 chunk-state（省 KV 写入）
 * 8. 空分片拒绝
 * 9. 统一 getOwnerId(auth)，禁止 ownerId 为空时跳过归属校验
 * 10. KV 分片大小兜底：KV 单值上限 25MB，非 R2 后端拒绝过大分片
 *
 * ================================================================
 * 存储清理责任划分（与 R2 泄漏修复对齐）
 * ================================================================
 * - KV 分片（chunk:{uploadId}:{chunkIndex}）：
 *   靠 expirationTtl 自动过期（此处设置 5400 秒 = 90 分钟，
 *   与 init.js 的 TASK_TTL_SECONDS 对齐）。
 *
 * - R2 临时分片对象（chunk-upload/<uploadId>/<chunkIndex>）：
 *   R2 不支持 expirationTtl，必须由以下两者之一清理：
 *   a) complete.js 成功路径调用 cleanupUploadTask 主动删除
 *   b) R2 生命周期规则：前缀 chunk-upload/ → 1 天后删除
 *
 * - R2 原生 Multipart Upload：
 *   由 init.js / complete.js 主动 abort，
 *   或由 R2 生命周期规则"全局 1 天后自动 abort"兜底。
 *
 * - 分片状态（chunk-state:...）：
 *   不再写入。已上传分片列表由前端内存维护，complete 时随
 *   请求体 parts 一起提交。
 * ================================================================
 */
import { checkAuthentication } from '../../utils/auth.js';
import {
  MAX_TOTAL_CHUNKS,
  MAX_FILE_SIZE_R2,
} from '../../utils/chunk-limits.js';

const TEMP_CHUNK_PREFIX = 'chunk-upload';

// 单个分片硬上限
// 必须 >= CHUNK_SIZE（当前 50MB），且低于 Workers 100MB 请求体上限。
const MAX_CHUNK_SIZE = 64 * 1024 * 1024; // 64MB

// KV 单值上限 25MB，留安全余量按 24MB 作为 KV 分片硬上限。
// 仅在 chunkBackend === 'kv' 时生效；R2 分片无此限制。
const MAX_KV_CHUNK_SIZE = 24 * 1024 * 1024; // 24MB

// 分片相关 KV TTL（与 init.js 的 TASK_TTL_SECONDS 对齐 = 90 分钟）
const CHUNK_KV_TTL_SECONDS = 90 * 60;

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
    // 2. 严格解析表单参数
    // ============================================
    const formData = await request.formData();
    const uploadId = formData.get('uploadId');
    const rawChunkIndex = formData.get('chunkIndex');
    const chunk = formData.get('chunk');

    if (
      !uploadId ||
      typeof uploadId !== 'string' ||
      !/^[a-f0-9]{16,64}$/i.test(uploadId)
    ) {
      return jsonResponse({ error: 'uploadId 格式错误' }, 400);
    }

    const chunkIndex =
      typeof rawChunkIndex === 'string' && /^\d+$/.test(rawChunkIndex)
        ? parseInt(rawChunkIndex, 10)
        : NaN;

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return jsonResponse({ error: 'chunkIndex 必须为非负整数' }, 400);
    }

    if (
      !chunk ||
      typeof chunk === 'string' ||
      typeof chunk.size !== 'number'
    ) {
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

    // ============================================
    // 3. 读取并校验任务
    // ============================================
    const taskData = await env.img_url.get(`upload:${uploadId}`, { type: 'json' });
    if (!taskData) {
      return jsonResponse({ error: '上传任务不存在或已过期' }, 404);
    }

    if (!taskData.ownerId || taskData.ownerId !== ownerId) {
      return jsonResponse({ error: '无权操作该上传任务' }, 403);
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
    // 4. 分片大小一致性校验（关键防御）
    // ============================================
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

    const chunkArrayBuffer = await chunk.arrayBuffer();
    if (chunkArrayBuffer.byteLength !== chunk.size) {
      return jsonResponse(
        { error: '分片实际字节数与声明不一致', code: 'CHUNK_BYTES_MISMATCH' },
        400
      );
    }

    // ============================================
    // 5. R2 原生 Multipart 分支（保持不变）
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

      return jsonResponse({
        success: true,
        chunkIndex,
        partNumber,
        etag: uploadedPart.etag,
        size: chunk.size,
      });
    }

    // ============================================
    // 6. 非 R2 原生存储节点：分片暂存分支
    // ============================================
    // 注意：不再读取/写入 chunk-state。
    // 已上传分片由前端内存维护，complete 时通过请求体提交。
    const chunkBackend = resolveChunkBackend(taskData, env);

    // KV 单值上限 25MB，非 R2 后端拒绝过大分片，避免 KV 写入失败。
    // （正常情况下前端会在无 R2 时把分片降到 20MB，这里仅作兜底。）
    if (chunkBackend === 'kv' && chunk.size > MAX_KV_CHUNK_SIZE) {
      return jsonResponse(
        {
          error:
            `当前未配置 R2，分片只能暂存到 KV（单个值上限 25MB），` +
            `当前分片 ${chunk.size} 字节过大。请配置 R2 或减小分片大小。`,
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
            size: String(chunk.size),
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
          size: chunk.size,
          createdAt: Date.now(),
        },
      });
    }

    // 非全局精确进度：仅基于当前请求的 chunkIndex 近似计算。
    const progress = (((chunkIndex + 1) / totalChunks) * 100).toFixed(1);

    return jsonResponse({
      success: true,
      chunkIndex,
      size: chunk.size,
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