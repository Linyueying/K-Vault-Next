/**
 * 分片上传状态统一模块（D1 优先 / KV 并发回落）
 *
 * ================================================================
 * 【为什么要这个模块】
 * ================================================================
 * 断点续传原本是"客户端级"的：已完成分片只存在于浏览器 localStorage，
 * 换设备 / 换浏览器 / 清缓存后快照消失，只能整文件重传。
 *
 * 根因有两个：
 *   1) 前后端键名不一致 —— init.js 的 listUploadedChunks 按
 *      `chunk-state:<uploadId>:` 前缀 list，而 chunk.js 实际写入的是
 *      `chunk:<uploadId>:<index>`。前缀对不上，服务端查询永远返回空数组。
 *   2) R2 原生 multipart 分支的 etag 只存在于前端内存 —— complete 需要
 *      etag 才能合并，服务端没存就必然要求重传全部分片。
 *
 * 本次 R2 上传优化：
 *   - R2 原生 multipart 的 part 状态优先持久化到 D1 `upload_parts` 表：
 *       · 写入从 KV（1k 写/天）迁到 D1（100k 写/天），10GB 200 片任务
 *         从 ~400 次 KV 写/删降至 0 次 KV 写；
 *       · 续传/合并查询从「1 list + N 次串行 KV get（数秒）」收敛为
 *         单条 SQL 查询（数毫秒）；
 *       · 清理从 N 次 KV delete 收敛为单条 DELETE SQL。
 *   - D1 未绑定时自动回落 KV `part-state:*`，且将旧串行读取改为
 *     16 路并发分批读取（吞吐提升 12~16×），保持零破坏兼容。
 *   - 修复 cleanupTaskState 在 R2 原生 multipart 模式下多发 N 次无意义
 *     R2_BUCKET.delete('chunk-upload/...') 的冗余调用。
 *
 * ================================================================
 * 键名约定（改动前必须先读这里）
 * ================================================================
 *   KV 暂存分片数据   chunk:<uploadId>:<chunkIndex>
 *   R2 暂存分片对象   chunk-upload/<uploadId>/<chunkIndex>
 *   R2 multipart part D1 upload_parts 表（无 D1 时回落 KV part-state:<uploadId>:<chunkIndex>）
 *   文件指纹映射     resume-map:<ownerId>:<fileId>         ← fileId → uploadId
 *   任务记录         upload:<uploadId>
 */

import { ensureSchema } from './schema.js';

export const LEGACY_CHUNK_TTL_SECONDS = 90 * 60;
export const R2_MULTIPART_TTL_SECONDS = 24 * 60 * 60;

const KV_BATCH_CONCURRENCY = 16;

function isD1Available(env) {
  return Boolean(env?.DB && typeof env.DB.prepare === 'function');
}

async function ensurePartsTable(env) {
  if (!isD1Available(env)) return false;
  try {
    const res = await ensureSchema(env);
    return Boolean(res?.ok);
  } catch (err) {
    console.warn('ensurePartsTable failed, falling back to KV:', err?.message || err);
    return false;
  }
}

async function mapBatched(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// New R2 tasks use one absolute deadline for task, fingerprint and part records.
export function chunkTaskExpiration(task) {
  return Number.isInteger(task?.expiresAt)
    ? { expiration: task.expiresAt }
    : { expirationTtl: LEGACY_CHUNK_TTL_SECONDS };
}

export function isChunkTaskExpired(task, now = Date.now()) {
  return Number.isInteger(task?.expiresAt) && now >= task.expiresAt * 1000;
}

const LEGACY_R2_SWEEP_KEY = 'maintenance:legacy-r2-chunks';
const LEGACY_R2_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const LEGACY_R2_CHUNK_MIN_AGE_MS = 24 * 60 * 60 * 1000;

// Only old builds write standalone R2 chunk objects. Scan one page per call
// and leave active tasks and unrelated objects in the bucket alone.
export async function cleanupLegacyR2Chunks(env) {
  const { img_url: kv, R2_BUCKET: bucket } = env;
  if (!kv || !bucket) return;
  const state = await kv.get(LEGACY_R2_SWEEP_KEY, { type: "json" });
  const now = Date.now();
  if (now < state?.nextRunAt) return;

  const page = await bucket.list({
    prefix: "chunk-upload/",
    include: ["customMetadata"],
    limit: 16,
    cursor: state?.cursor,
  });

  const candidates = page.objects.filter((object) => {
    const metadata = object.customMetadata;
    return metadata?.type === "chunk" &&
      /^[a-f0-9]{16,64}$/i.test(metadata.uploadId) &&
      /^\d+$/.test(metadata.chunkIndex) &&
      object.key === chunkObjectKey(metadata.uploadId, metadata.chunkIndex) &&
      now - new Date(object.uploaded).getTime() >= LEGACY_R2_CHUNK_MIN_AGE_MS;
  });
  const liveTasks = new Map();
  const expiredKeys = [];
  for (const object of candidates) {
    const { uploadId } = object.customMetadata;
    if (!liveTasks.has(uploadId)) {
      liveTasks.set(uploadId, await kv.get(`upload:${uploadId}`));
    }
    if (!liveTasks.get(uploadId)) expiredKeys.push(object.key);
  }
  if (expiredKeys.length) await bucket.delete(expiredKeys);

  const cursor = page.truncated ? page.cursor : undefined;
  await kv.put(LEGACY_R2_SWEEP_KEY, JSON.stringify({
    cursor,
    nextRunAt: cursor ? now + 60_000 : now + LEGACY_R2_SWEEP_INTERVAL_MS,
  }), { expirationTtl: 7 * 24 * 60 * 60 });
}

/**
 * 清理 D1 upload_parts 中已过期的孤儿记录（由 init 后台触发）。
 */
export async function cleanupExpiredUploadParts(env) {
  if (!await ensurePartsTable(env)) return 0;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await env.DB.prepare(
      `DELETE FROM upload_parts WHERE expires_at < ?
       AND (substr(etag, 1, 3) <> 'tg:' OR expires_at < ?)`
    ).bind(nowSec, nowSec - 2 * 24 * 60 * 60).run();
    return Number(res?.meta?.changes || 0);
  } catch (err) {
    console.warn('cleanupExpiredUploadParts failed:', err?.message || err);
    return 0;
  }
}

// 分片数据（KV 暂存后端）
export function chunkDataKey(uploadId, chunkIndex) {
  return `chunk:${uploadId}:${chunkIndex}`;
}

// 分片对象（R2 暂存后端）
export function chunkObjectKey(uploadId, chunkIndex) {
  return `chunk-upload/${uploadId}/${chunkIndex}`;
}

// R2 原生 multipart 的 part 元信息（无 D1 时回落 KV）
export function partStateKey(uploadId, chunkIndex) {
  return `part-state:${uploadId}:${chunkIndex}`;
}

// 文件指纹 → uploadId 的映射
export function resumeMapKey(ownerId, fileId) {
  return `resume-map:${ownerId}:${fileId}`;
}

/**
 * 编码 Telegram 虚拟分片句柄，复用 upload_parts.etag 列存储（零额外建表）。
 */
export function encodeTelegramPartRef(fileId, messageId = null) {
  const payload = { f: String(fileId || '') };
  if (messageId !== undefined && messageId !== null && messageId !== '') {
    payload.m = messageId;
  }
  return `tg:${JSON.stringify(payload)}`;
}

/**
 * 解码 Telegram 虚拟分片句柄 → { fileId, msgId } | null。
 */
export function decodeTelegramPartRef(etag) {
  const raw = String(etag || '');
  if (!raw.startsWith('tg:')) return null;
  try {
    const parsed = JSON.parse(raw.slice(3));
    if (!parsed || typeof parsed.f !== 'string' || !parsed.f) return null;
    return {
      fileId: parsed.f,
      msgId: parsed.m !== undefined && parsed.m !== null ? parsed.m : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 持久化单个 R2 multipart / Telegram 虚拟分片的 part 元信息（D1 优先，失败或未绑 D1 时回落 KV）。
 */
export async function recordUploadedPart(env, uploadId, chunkIndex, partInfo, taskData) {
  const partNumber = Number(partInfo?.partNumber);
  const etag = String(partInfo?.etag || '');
  const size = Number(partInfo?.size || 0);
  const uploadedAt = Number(partInfo?.uploadedAt || Date.now());
  const expiresAt = Number.isInteger(taskData?.expiresAt)
    ? taskData.expiresAt
    : Math.floor(uploadedAt / 1000) + LEGACY_CHUNK_TTL_SECONDS;

  if (!uploadId || !Number.isInteger(chunkIndex) || !Number.isInteger(partNumber) || !etag) {
    return { ok: false, store: 'none' };
  }

  if (await ensurePartsTable(env)) {
    try {
      const result = await env.DB.prepare(
        `INSERT OR REPLACE INTO upload_parts
         (upload_id, chunk_index, part_number, etag, size, uploaded_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(uploadId, chunkIndex, partNumber, etag, size, uploadedAt, expiresAt).run();
      if (result?.success === false) throw new Error('D1 part write failed');
      return { ok: true, store: 'd1' };
    } catch (err) {
      console.warn(`D1 recordUploadedPart failed (uploadId=${uploadId}, part=${partNumber}), falling back to KV:`, err?.message || err);
    }
  }

  if (env?.img_url) {
    try {
      await env.img_url.put(
        partStateKey(uploadId, chunkIndex),
        JSON.stringify({ partNumber, etag, size, uploadedAt }),
        etag.startsWith('tg:')
          ? { expiration: expiresAt + 2 * 24 * 60 * 60 }
          : chunkTaskExpiration(taskData)
      );
      return { ok: true, store: 'kv' };
    } catch (err) {
      console.error(`KV recordUploadedPart failed (uploadId=${uploadId}, part=${partNumber}):`, err);
    }
  }

  return { ok: false, store: 'none' };
}

/**
 * 精准查询单个分片的已持久化 part 记录（D1 主键直查优先，未命中或无 D1 时回落 KV）。
 *
 * 用于 Telegram 虚拟分片服务端幂等复用：若客户端因响应丢失/超时重发同一分片，
 * 命中后直接返回已有 etag，避免重复消耗 18MB 内存与 Telegram 频道发信配额。
 */
export async function getUploadedPart(env, uploadId, chunkIndex, { strict = false } = {}) {
  if (!uploadId || !Number.isInteger(chunkIndex) || chunkIndex < 0) return null;

  const hasD1 = await ensurePartsTable(env);
  if (strict && isD1Available(env) && !hasD1) throw new Error('Upload part database unavailable');
  if (hasD1) {
    try {
      const bound = env.DB.prepare(
        `SELECT part_number, etag, size, uploaded_at
         FROM upload_parts
         WHERE upload_id = ? AND chunk_index = ?
         LIMIT 1`
      ).bind(uploadId, chunkIndex);
      const row = typeof bound.first === 'function'
        ? await bound.first()
        : (await bound.all())?.results?.[0];
      const partNumber = Number(row?.part_number);
      const etag = typeof row?.etag === 'string' ? row.etag : '';
      const size = Number(row?.size || 0);
      if (Number.isInteger(partNumber) && partNumber > 0 && etag) {
        return {
          partNumber,
          etag,
          size,
          uploadedAt: Number(row?.uploaded_at || 0),
          store: 'd1',
        };
      }
    } catch (err) {
      if (strict) throw err;
      console.warn(`D1 getUploadedPart failed (uploadId=${uploadId}, idx=${chunkIndex}), falling back to KV:`, err?.message || err);
    }
  }

  if (env?.img_url) {
    try {
      const raw = await env.img_url.get(partStateKey(uploadId, chunkIndex), { type: 'json' });
      const partNumber = Number(raw?.partNumber);
      const etag = typeof raw?.etag === 'string' ? raw.etag : '';
      const size = Number(raw?.size || 0);
      if (Number.isInteger(partNumber) && partNumber > 0 && etag) {
        return {
          partNumber,
          etag,
          size,
          uploadedAt: Number(raw?.uploadedAt || 0),
          store: 'kv',
        };
      }
    } catch (err) {
      if (strict) throw err;
      console.warn(`KV getUploadedPart failed (uploadId=${uploadId}, idx=${chunkIndex}):`, err?.message || err);
    }
  }

  return null;
}

/**
 * KV prefix list 的完整遍历（处理 cursor 分页）。
 */
async function listAllKeys(kv, prefix, limit = 1000) {
  if (!kv || typeof kv.list !== 'function') return [];
  const keys = [];
  let cursor = undefined;

  do {
    const result = await kv.list({ prefix, limit, cursor });
    for (const key of result?.keys || []) {
      if (key?.name) keys.push(key.name);
    }
    cursor = result?.list_complete === false ? result?.cursor : undefined;
  } while (cursor);

  return keys;
}

function parseChunkIndex(key) {
  const parts = String(key || "").split(":");
  const idx = Number(parts[parts.length - 1]);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}

/**
 * 读取 R2 原生 multipart / Telegram 虚拟分片已上传 part 的 {partNumber, etag, size}。
 *
 * 优先从 D1 `upload_parts` 单次 SQL 查询获取（O(1) 往返）；
 * D1 未绑定或未命中（兼容升级前仍在进行的 KV 任务）时回落 KV 并采用
 * 16 路并发批量读取，彻底消除旧版 N 次串行 KV get 延迟。
 */
export async function listUploadedParts(env, uploadId, { mergeKv = false, includeDuplicates = false, strict = false } = {}) {
  if (!uploadId) return [];

  const parts = [];
  const seen = new Set();
  const add = (partNumber, etag, size) => {
    if (!Number.isInteger(partNumber) || partNumber <= 0 || !etag) return;
    const key = includeDuplicates ? etag : partNumber;
    if (seen.has(key)) return;
    seen.add(key);
    parts.push({ partNumber, etag, ...(size > 0 ? { size } : {}) });
  };

  const hasD1 = await ensurePartsTable(env);
  if (strict && isD1Available(env) && !hasD1) throw new Error('Upload part database unavailable');
  if (hasD1) {
    try {
      const res = await env.DB.prepare(
        `SELECT part_number, etag, size
         FROM upload_parts
         WHERE upload_id = ?
         ORDER BY part_number ASC`
      ).bind(uploadId).all();
      for (const row of res?.results || []) {
        add(Number(row.part_number), row.etag, Number(row.size));
      }
      if (parts.length && !mergeKv) return parts;
    } catch (err) {
      if (strict) throw err;
      console.warn('listUploadedParts (D1) failed, falling back to KV:', err?.message || err);
    }
  }

  if (env?.img_url) {
    try {
      const keys = await listAllKeys(env.img_url, `part-state:${uploadId}:`);
      for (let start = 0; start < keys.length; start += 100) {
        const batch = keys.slice(start, start + 100);
        const values = await env.img_url.get(batch, { type: 'json' });
        // Older local bindings and test doubles may only implement single-key reads.
        const loaded = values instanceof Map
          ? values.values()
          : await Promise.all(batch.map((key) => env.img_url.get(key, { type: 'json' })));
        for (const raw of loaded) add(raw?.partNumber, raw?.etag, Number(raw?.size));
      }
    } catch (err) {
      if (strict) throw err;
      console.error('listUploadedParts (KV) error:', err);
    }
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

/**
 * 查询服务端真实存在的分片索引。
 *
 * - R2 原生 multipart / Telegram 虚拟分片：优先查 D1 `upload_parts`，无记录或未绑 D1 时查 KV `part-state:`
 * - R2 暂存后端：列举 chunk-upload/<uploadId>/ 下的对象
 * - KV 暂存后端：列举 chunk:<uploadId>: 前缀
 */
export async function listUploadedChunkIndices(env, uploadId, taskData) {
  const isPartTracked =
    (taskData?.storageMode === "r2" && Boolean(taskData?.r2Multipart?.uploadId)) ||
    (taskData?.storageMode === "telegram" && taskData?.chunkBackend === "telegram");

  if (isPartTracked) {
    if (await ensurePartsTable(env)) {
      try {
        const res = await env.DB.prepare(
          `SELECT chunk_index
           FROM upload_parts
           WHERE upload_id = ?
           ORDER BY chunk_index ASC`
        ).bind(uploadId).all();
        const rows = res?.results || [];
        if (rows.length > 0) {
          return rows
            .map((r) => Number(r?.chunk_index))
            .filter((idx) => Number.isInteger(idx) && idx >= 0);
        }
      } catch (err) {
        console.warn("listUploadedChunkIndices (D1) error, falling back to KV:", err?.message || err);
      }
    }

    try {
      const keys = await listAllKeys(env.img_url, `part-state:${uploadId}:`);
      const indices = new Set();
      for (const key of keys) {
        const idx = parseChunkIndex(key);
        if (idx !== null) indices.add(idx);
      }
      return Array.from(indices).sort((a, b) => a - b);
    } catch (err) {
      console.error("listUploadedChunkIndices (part-state) error:", err);
      return [];
    }
  }

  const chunkBackend =
    taskData?.chunkBackend || (env.R2_BUCKET ? "r2" : "kv");

  if (chunkBackend === "r2" && env.R2_BUCKET) {
    try {
      const listed = await env.R2_BUCKET.list({
        prefix: `chunk-upload/${uploadId}/`,
      });
      const indices = new Set();
      for (const obj of listed?.objects || []) {
        const parts = String(obj?.key || "").split("/");
        const idx = Number(parts[parts.length - 1]);
        if (Number.isInteger(idx) && idx >= 0) indices.add(idx);
      }
      return Array.from(indices).sort((a, b) => a - b);
    } catch (err) {
      console.error("listUploadedChunkIndices (R2) error:", err);
      return [];
    }
  }

  try {
    const keys = await listAllKeys(env.img_url, `chunk:${uploadId}:`);
    const indices = new Set();
    for (const key of keys) {
      const idx = parseChunkIndex(key);
      if (idx !== null) indices.add(idx);
    }
    return Array.from(indices).sort((a, b) => a - b);
  } catch (err) {
    console.error("listUploadedChunkIndices (KV) error:", err);
    return [];
  }
}

/**
 * 清理一个上传任务遗留的全部服务端状态。
 *
 * 覆盖：D1 upload_parts / KV part-state / KV 分片数据 / R2 暂存分片对象。
 * R2 原生 multipart 与 Telegram 虚拟分片均不产生 KV/R2 暂存分片对象，
 * 清理完 part 状态后直接返回。
 */
export async function cleanupTaskState(env, uploadId, totalChunks, taskData) {
  const chunkBackend =
    taskData?.chunkBackend || (env.R2_BUCKET ? "r2" : "kv");
  const isPartOnly =
    (taskData?.storageMode === "r2" && Boolean(taskData?.r2Multipart?.uploadId)) ||
    chunkBackend === "telegram";

  try {
    if (isPartOnly) {
      await deletePartStates(env, uploadId, totalChunks);
      return;
    }

    if (chunkBackend === "r2" && env.R2_BUCKET) {
      await deletePartStates(env, uploadId, totalChunks);
      const jobs = [];
      for (let i = 0; i < totalChunks; i++) {
        jobs.push(env.R2_BUCKET.delete(chunkObjectKey(uploadId, i)));
      }
      await Promise.allSettled(jobs);
      return;
    }

    if (chunkBackend === "kv" && env.img_url) {
      const jobs = [];
      for (let i = 0; i < totalChunks; i++) {
        jobs.push(env.img_url.delete(chunkDataKey(uploadId, i)));
      }
      await Promise.allSettled(jobs);
    }
  } catch (error) {
    console.error("cleanupTaskState error:", error);
  }
}

/**
 * 删除任务的 part 状态（D1 单条 SQL 优先；无 D1 时按索引分批并发删除 KV）。
 */
export async function deletePartStates(env, uploadId, totalChunks = 0, { mergeKv = false } = {}) {
  if (!uploadId) return;

  let deletedFromD1 = 0;
  let d1Handled = false;
  if (await ensurePartsTable(env)) {
    try {
      const res = await env.DB.prepare(
        'DELETE FROM upload_parts WHERE upload_id = ?'
      ).bind(uploadId).run();
      deletedFromD1 = Number(res?.meta?.changes || 0);
      d1Handled = true;
    } catch (err) {
      console.warn("deletePartStates (D1) failed:", err?.message || err);
    }
  }

  // 若 D1 已接管并命中删除（或 totalChunks <= 0），不再消耗 KV 写额度；
  // 若 D1 未绑定（纯 KV 部署），或 D1 中 0 行（兼容升级前遗留的 KV 任务），才清理 KV 键。
  if (!env?.img_url) return;
  if (!mergeKv && d1Handled && deletedFromD1 > 0) return;

  try {
    if (mergeKv || (d1Handled && deletedFromD1 === 0)) {
      // 仅检查是否真有旧 KV 键存在（1 次 list，0 次多余 delete），避免白烧 KV 写额度
      const legacyKeys = await listAllKeys(env.img_url, `part-state:${uploadId}:`);
      if (!legacyKeys.length) return;
      await mapBatched(legacyKeys, KV_BATCH_CONCURRENCY, (key) => env.img_url.delete(key));
      return;
    }

    if (totalChunks > 0) {
      const indices = Array.from({ length: totalChunks }, (_, i) => i);
      await mapBatched(indices, KV_BATCH_CONCURRENCY, (i) =>
        env.img_url.delete(partStateKey(uploadId, i))
      );
    } else {
      const keys = await listAllKeys(env.img_url, `part-state:${uploadId}:`);
      if (keys.length) {
        await mapBatched(keys, KV_BATCH_CONCURRENCY, (key) => env.img_url.delete(key));
      }
    }
  } catch (error) {
    console.error("deletePartStates (KV) error:", error);
  }
}

/**
 * 清理文件指纹映射。fileId 为空时静默跳过（老客户端不传 fileId）。
 */
export async function deleteResumeMap(env, ownerId, fileId, expectedUploadId) {
  if (!env?.img_url || !ownerId || !fileId) return;
  try {
    const key = resumeMapKey(ownerId, fileId);
    if (expectedUploadId && await env.img_url.get(key) !== expectedUploadId) return;
    await env.img_url.delete(key);
  } catch (error) {
    console.error("deleteResumeMap error:", error);
  }
}
