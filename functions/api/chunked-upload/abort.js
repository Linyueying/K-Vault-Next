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
import { resumeMapKey } from '../../utils/chunk-state.js';

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
  // 3. 读任务 KV（用于归属校验 + 拿 R2 信息 + fileId）
  // ============================================
  let taskData = null;
  try {
    taskData = await env.img_url.get(`upload:${uploadId}`, { type: 'json' });
  } catch (err) {
    console.error('read upload task failed:', err);
  }

  if (taskData && taskData.ownerId && taskData.ownerId !== ownerId) {
    // 越权：A 用户不能 abort B 用户的任务
    return jsonResponse({ error: '无权操作该上传任务' }, 403);
  }

  // ============================================
  // 4. abort R2 multipart —— 真正释放 part 占用的空间
  //    候选来源：
  //      a) task.r2Multipart（任务 KV 仍在时最可靠）
  //      b) user-multiparts 列表（task KV 已过期时的兜底）
  // ============================================
  const r2Candidates = [];
  if (taskData?.r2Multipart?.key && taskData?.r2Multipart?.uploadId && env.R2_BUCKET) {
    r2Candidates.push({
      key: taskData.r2Multipart.key,
      r2UploadId: taskData.r2Multipart.uploadId,
    });
  }
  try {
    const pending = await env.img_url.get(`user-multiparts:${ownerId}`, { type: 'json' });
    if (Array.isArray(pending)) {
      for (const entry of pending) {
        if (entry?.uploadId === uploadId && entry.key && entry.r2UploadId) {
          r2Candidates.push({ key: entry.key, r2UploadId: entry.r2UploadId });
        }
      }
    }
  } catch (_) {}

  let abortedR2 = false;
  for (const c of r2Candidates) {
    try {
      const mp = env.R2_BUCKET.resumeMultipartUpload(c.key, c.r2UploadId);
      await mp.abort();
      abortedR2 = true;
      console.log(`Aborted R2 multipart: key=${c.key}, r2UploadId=${c.r2UploadId}`);
    } catch (err) {
      // 已 complete / 已 abort / 网络异常 → 忽略，
      // 最终由 R2 未完成 multipart 生命周期规则兜底
      console.warn(`abort R2 multipart failed (${c.r2UploadId}):`, err?.message || err);
    }
  }

  // ============================================
  // 5. 清理 KV 痕迹
  // ============================================
  // 5a) 删除任务 KV（可能已过期，delete 幂等）
  try {
    await env.img_url.delete(`upload:${uploadId}`);
  } catch (_) {}

  // 5b) 从 user-multiparts 列表移除该 uploadId
  try {
    const pending = await env.img_url.get(`user-multiparts:${ownerId}`, { type: 'json' });
    if (Array.isArray(pending)) {
      const next = pending.filter((e) => e?.uploadId !== uploadId);
      if (next.length !== pending.length) {
        await env.img_url.put(`user-multiparts:${ownerId}`, JSON.stringify(next), {
          expirationTtl: USER_STATE_TTL,
        });
      }
    }
  } catch (_) {}

  // 5c) 清 resume-map（避免孤儿任务被下一次同文件续传误命中）
  if (taskData?.fileId) {
    try {
      await env.img_url.delete(resumeMapKey(ownerId, taskData.fileId));
    } catch (_) {}
  }

  return jsonResponse({
    ok: true,
    abortedR2,
    message: abortedR2
      ? '已取消上传并释放 R2 空间'
      : '任务已清理（R2 分片可能已不存在或已过期）',
  });
}
