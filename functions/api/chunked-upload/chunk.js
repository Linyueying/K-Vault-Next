/**
 * Upload one file chunk.
 * POST /api/chunked-upload/chunk
 */
import { checkAuthentication, isAuthRequired } from '../../utils/auth.js';

const TEMP_CHUNK_PREFIX = 'chunk-upload';

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (isAuthRequired(env)) {
      const auth = await checkAuthentication(context);
      if (!auth.authenticated) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
    }

    if (!env.img_url) {
      return jsonResponse({ error: 'KV binding img_url is required for chunk upload task state.' }, 500);
    }

    const formData = await request.formData();
    const uploadId = formData.get('uploadId');
    const chunkIndex = parseInt(formData.get('chunkIndex'), 10);
    const chunk = formData.get('chunk');

    if (!uploadId || Number.isNaN(chunkIndex) || !chunk) {
      return jsonResponse({ error: '缺少必要参数' }, 400);
    }

    const taskData = await env.img_url.get(`upload:${uploadId}`, { type: 'json' });
    if (!taskData) {
      return jsonResponse({ error: '上传任务不存在或已过期' }, 404);
    }
    const totalChunks = Number(taskData.totalChunks || 0);
    if (!Number.isFinite(totalChunks) || totalChunks <= 0) {
      return jsonResponse({ error: 'Invalid totalChunks in upload task.' }, 400);
    }

    const chunkBackend = resolveChunkBackend(taskData, env);
    const minimizeKvWrites = isKvWriteMinimized(env);

    if (!minimizeKvWrites && Array.isArray(taskData.uploadedChunks) && taskData.uploadedChunks.includes(chunkIndex)) {
      return jsonResponse({
        success: true,
        message: '分片已存在',
        uploadedChunks: taskData.uploadedChunks,
      });
    }

    const chunkArrayBuffer = await chunk.arrayBuffer();

    if (chunkBackend === 'r2') {
      if (!env.R2_BUCKET) {
        return jsonResponse({ error: 'R2 chunk backend requested but R2_BUCKET is not configured.' }, 500);
      }

      await env.R2_BUCKET.put(getChunkObjectKey(uploadId, chunkIndex), chunkArrayBuffer, {
        customMetadata: {
          type: 'chunk',
          uploadId,
          chunkIndex: String(chunkIndex),
          createdAt: String(Date.now()),
        },
      });
    } else {
      await env.img_url.put(`chunk:${uploadId}:${chunkIndex}`, chunkArrayBuffer, {
        expirationTtl: 3600,
        metadata: {
          type: 'chunk',
          uploadId,
          chunkIndex,
          createdAt: Date.now(),
        },
      });
    }

    let uploadedChunks = taskData.uploadedChunks || [];
    if (!minimizeKvWrites) {
      uploadedChunks = Array.from(new Set([...uploadedChunks, chunkIndex])).sort((a, b) => a - b);
      taskData.uploadedChunks = uploadedChunks;
      taskData.chunkBackend = chunkBackend;

      await env.img_url.put(`upload:${uploadId}`, JSON.stringify(taskData), {
        expirationTtl: 3600,
      });
    }

    const progress = minimizeKvWrites
      ? (((chunkIndex + 1) / totalChunks) * 100).toFixed(1)
      : ((uploadedChunks.length / totalChunks) * 100).toFixed(1);

    return jsonResponse({
      success: true,
      chunkIndex,
      uploadedChunks,
      chunkBackend,
      progress,
    });
  } catch (error) {
    console.error('Chunk upload error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isKvWriteMinimized(env) {
  return env.MINIMIZE_KV_WRITES === 'true';
}

function resolveChunkBackend(taskData, env) {
  if (taskData?.chunkBackend === 'r2' && env.R2_BUCKET) return 'r2';
  if (taskData?.chunkBackend === 'kv') return 'kv';
  return env.R2_BUCKET ? 'r2' : 'kv';
}

function getChunkObjectKey(uploadId, chunkIndex) {
  return `${TEMP_CHUNK_PREFIX}/${uploadId}/${chunkIndex}`;
}
