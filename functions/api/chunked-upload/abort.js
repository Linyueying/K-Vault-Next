/**
 * Abort a chunked upload task and release R2 multipart space.
 * POST /api/chunked-upload/abort
 *
 * ================================================================
 * 修复 A（前端“取消”/“从头重传”触发的服务端清理）
 * ================================================================
 * 背景：旧实现里用户主动取消上传时，前端只会 abort 本地 XHR，
 * 服务端的 R2 multipart upload（及其已上传的 part）永远不会被
 * abort，成为孤儿，一直占用 R2 空间，直到 90 分钟后惰性清理或
 * R2 生命周期兜底。
 *
 * 本端点接收前端传来的 uploadId，立即：
 *   1) abort R2 multipart —— 真正释放已上传分片占用的 R2 空间
 *   2) 删除任务 KV（upload:<uploadId>）
 *   3) 从 user-multiparts:<ownerId> 列表移除该条目
 *   4) 清掉 resume-map:<ownerId>:<fileId>，避免孤儿任务被断点续传误命中
 *
 * 归属校验：只允许 abort 自己 ownerId 下的任务，禁止越权。
 * 幂等：uploadId 不存在 / R2 已 complete 或已 abort 都安全返回 ok。
 * ================================================================
 */

import { checkAuthentication } from '../../utils/auth.js';
import { envValue } from '../../utils/env-config.js';
import { deleteTelegramMessagesBatch } from '../../utils/telegram.js';
import {
  decodeTelegramPartRef,
  deletePartStates,
  listUploadedParts,
  resumeMapKey,
} from '../../utils/chunk-state.js';

// 与 init.js 保持一致（私有辅助函数，未导出，这里自包含复制）
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function normalizeUploadId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[a-f0-9]{16,64}$/i.test(trimmed) ? trimmed : null;
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

// user-multiparts 列表 TTL，与 init.js 的 USER_STATE_TTL 对齐（2 天）
const USER_STATE_TTL = 86400 * 2;

export async function onRequestPost(context) {
  const { request, env } = context;

  // ============================================
  // 1. 强制鉴权
  // ============================================
  const auth = await checkAuthentication(context);
  if (!auth || !auth.authenticated) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  const ownerId = getOwnerId(auth);
  if (!ownerId) {
    return jsonResponse({ error: '无法识别用户身份，拒绝取消上传任务' }, 401);
  }

  // ============================================
  // 2. 解析 body
  // ============================================
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const uploadId = normalizeUploadId(body?.uploadId);
  if (!uploadId) {
    return jsonResponse({ error: 'uploadId 缺失或格式错误' }, 400);
  }

  // ============================================
  // 3. 并行读取任务 KV 与 user-multiparts 列表（省掉重复读）
  // ============================================
  const [taskData, pending] = await Promise.all([
    env.img_url.get(`upload:${uploadId}`, { type: 'json' }).catch((err) => {
      console.error('read upload task failed:', err);
      return null;
    }),
    env.img_url.get(`user-multiparts:${ownerId}`, { type: 'json' }).catch(() => null),
  ]);

  if (taskData && taskData.ownerId && taskData.ownerId !== ownerId) {
    return jsonResponse({ error: '无权操作该上传任务' }, 403);
  }

  // ============================================
  // 4. abort R2 multipart —— 按 key+r2UploadId 去重，避免重复调用
  // ============================================
  const seenCandidates = new Set();
  const r2Candidates = [];
  const pushCandidate = (key, r2UploadId) => {
    if (!key || !r2UploadId || !env.R2_BUCKET) return;
    const sig = `${key}::${r2UploadId}`;
    if (seenCandidates.has(sig)) return;
    seenCandidates.add(sig);
    r2Candidates.push({ key, r2UploadId });
  };

  if (taskData?.r2Multipart?.key && taskData?.r2Multipart?.uploadId) {
    pushCandidate(taskData.r2Multipart.key, taskData.r2Multipart.uploadId);
  }
  let matchedPendingTotalChunks = 0;
  if (Array.isArray(pending)) {
    for (const entry of pending) {
      if (entry?.uploadId === uploadId) {
        pushCandidate(entry.key, entry.r2UploadId);
        if (Number(entry.totalChunks) > matchedPendingTotalChunks) {
          matchedPendingTotalChunks = Number(entry.totalChunks);
        }
      }
    }
  }

  let abortedR2 = false;
  if (r2Candidates.length > 0) {
    const abortResults = await Promise.allSettled(
      r2Candidates.map(async (c) => {
        const mp = env.R2_BUCKET.resumeMultipartUpload(c.key, c.r2UploadId);
        await mp.abort();
        console.log(`Aborted R2 multipart: key=${c.key}, r2UploadId=${c.r2UploadId}`);
        return true;
      })
    );
    abortedR2 = abortResults.some((r) => r.status === 'fulfilled' && r.value === true);
    abortResults.forEach((r, idx) => {
      if (r.status === 'rejected') {
        console.warn(
          `abort R2 multipart failed (${r2Candidates[idx].r2UploadId}):`,
          r.reason?.message || r.reason
        );
      }
    });
  }

  // ============================================
  // 4.5 清理 Telegram 虚拟分片已上传的频道消息（best-effort）
  // ============================================
  let deletedTelegramChunks = 0;
  if (
    taskData?.chunkBackend === 'telegram' &&
    envValue(env, 'TG_BOT_TOKEN') &&
    envValue(env, 'TG_CHAT_ID')
  ) {
    try {
      const uploadedParts = await listUploadedParts(env, uploadId);
      const msgIds = [];
      const seenMsgIds = new Set();
      for (const part of uploadedParts) {
        const ref = decodeTelegramPartRef(part?.etag);
        if (ref?.msgId && !seenMsgIds.has(String(ref.msgId))) {
          seenMsgIds.add(String(ref.msgId));
          msgIds.push(ref.msgId);
        }
      }
      if (msgIds.length > 0) {
        const batchRes = await deleteTelegramMessagesBatch(env, msgIds);
        deletedTelegramChunks = batchRes.deleted;
      }
    } catch (err) {
      console.warn('abort Telegram chunk messages failed (best-effort):', err?.message || err);
    }
  }

  // ============================================
  // 5. 并行清理 KV / D1 痕迹（含 upload_parts / part-state，防止孤儿状态泄漏）
  // ============================================
  const totalChunks = Number(taskData?.totalChunks || matchedPendingTotalChunks || 0);
  const cleanupJobs = [
    env.img_url.delete(`upload:${uploadId}`).catch(() => {}),
    deletePartStates(env, uploadId, totalChunks).catch((err) => {
      console.warn('deletePartStates on abort failed:', err?.message || err);
    }),
  ];

  if (Array.isArray(pending)) {
    const next = pending.filter((e) => e?.uploadId !== uploadId);
    if (next.length !== pending.length) {
      cleanupJobs.push(
        env.img_url.put(`user-multiparts:${ownerId}`, JSON.stringify(next), {
          expirationTtl: USER_STATE_TTL,
        }).catch(() => {})
      );
    }
  }

  if (taskData?.fileId) {
    cleanupJobs.push(env.img_url.delete(resumeMapKey(ownerId, taskData.fileId)).catch(() => {}));
  }

  await Promise.allSettled(cleanupJobs);

  return jsonResponse({
    ok: true,
    abortedR2,
    deletedTelegramChunks,
    message: abortedR2
      ? '已取消上传并释放 R2 空间'
      : deletedTelegramChunks > 0
        ? `已取消上传并清理 ${deletedTelegramChunks} 个 Telegram 分片消息`
        : '任务已清理（R2 分片可能已不存在或已过期）',
  });
}
