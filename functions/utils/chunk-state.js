/**
 * 分片上传状态统一模块
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
 * 本模块把「分片数据键 / part 状态键 / 已上传列表查询 / 任务状态清理」
 * 收敛到一处，前后端共用同一套键名约定，杜绝再次跑偏。
 *
 * ================================================================
 * 键名约定（改动前必须先读这里）
 * ================================================================
 *   KV 暂存分片数据   chunk:<uploadId>:<chunkIndex>
 *   R2 暂存分片对象   chunk-upload/<uploadId>/<chunkIndex>
 *   R2 multipart part part-state:<uploadId>:<chunkIndex>   ← etag 落库
 *   文件指纹映射     resume-map:<ownerId>:<fileId>         ← fileId → uploadId
 *   秒传索引         instant:<ownerId>:<fileHash>          ← 内容哈希 → 已完成文件
 *   任务记录         upload:<uploadId>
 *
 * 注意：分片「数据键」与「状态键」合二为一（KV 分支下数据键本身就是状态），
 * 不再额外写 chunk-state:，省掉每分片一次 KV 写入。
 */

// 秒传索引 TTL：30 天。KV 自动过期，不需要额外清理任务。
// 定 30 天是因为秒传解决的是「最近又传了一遍同一个文件」，放久了只会让
// 索引里堆满早被删除的文件的引用。
const INSTANT_INDEX_TTL_SECONDS = 86400 * 30;

// 分片数据（KV 暂存后端）
export function chunkDataKey(uploadId, chunkIndex) {
  return `chunk:${uploadId}:${chunkIndex}`;
}

// 分片对象（R2 暂存后端）
export function chunkObjectKey(uploadId, chunkIndex) {
  return `chunk-upload/${uploadId}/${chunkIndex}`;
}

// R2 原生 multipart 的 part 元信息（etag 必须落库，否则无法跨端续传）
export function partStateKey(uploadId, chunkIndex) {
  return `part-state:${uploadId}:${chunkIndex}`;
}

// 文件指纹 → uploadId 的映射
export function resumeMapKey(ownerId, fileId) {
  return `resume-map:${ownerId}:${fileId}`;
}

/**
 * KV prefix list 的完整遍历（处理 cursor 分页）。
 *
 * 分片数受 MAX_TOTAL_CHUNKS(256) 约束，一次 list 通常就够；
 * 这里保留 cursor 循环是为了防止日后调高上限后静默丢数据。
 */
async function listAllKeys(kv, prefix, limit = 1000) {
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

/**
 * 从分片索引键名尾部解析索引。
 * 解析失败返回 null，调用方跳过即可（不能因此中断续传）。
 */
function parseChunkIndex(key) {
  const parts = String(key || "").split(":");
  const idx = Number(parts[parts.length - 1]);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}

/**
 * 查询服务端真实存在的分片索引。
 *
 * - R2 原生 multipart：分片没有独立对象，状态在 part-state: 里
 * - R2 暂存后端：列举 chunk-upload/<uploadId>/ 下的对象
 * - KV 暂存后端：列举 chunk:<uploadId>: 前缀
 *
 * list 失败不抛错，返回空数组 —— 此时等价于全量重传，用户数据不会丢，
 * 只是上传慢一点。宁可退化也不能让 init 500。
 */
export async function listUploadedChunkIndices(env, uploadId, taskData) {
  const isR2Native =
    taskData?.storageMode === "r2" && Boolean(taskData?.r2Multipart?.uploadId);

  if (isR2Native) {
    try {
      const keys = await listAllKeys(env.img_url, `part-state:${uploadId}:`);
      const indices = new Set();
      for (const key of keys) {
        // part-state 存的是 {chunkIndex,...}，这里从键尾取索引即可，
        // 索引与 partNumber 是 partNumber = chunkIndex + 1 的关系。
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
 * 读取 R2 原生 multipart 已上传 part 的 {partNumber, etag}。
 *
 * complete 必须拿到 etag 才能合并，所以这份数据的价值在于：
 * 即使前端快照丢了，服务端也能自己拼出完整的 parts 交给 R2。
 */
export async function listUploadedParts(env, uploadId) {
  try {
    const keys = await listAllKeys(env.img_url, `part-state:${uploadId}:`);
    const parts = [];
    const seen = new Set();

    for (const key of keys) {
      const raw = await env.img_url.get(key, { type: "json" });
      if (!raw || !Number.isInteger(raw?.partNumber) || !raw?.etag) continue;
      if (seen.has(raw.partNumber)) continue;
      seen.add(raw.partNumber);
      parts.push({ partNumber: raw.partNumber, etag: raw.etag });
    }

    return parts.sort((a, b) => a.partNumber - b.partNumber);
  } catch (err) {
    console.error("listUploadedParts error:", err);
    return [];
  }
}

/**
 * 清理一个上传任务遗留的全部服务端状态。
 *
 * 覆盖：KV 分片数据、R2 暂存分片对象、part-state、resume-map。
 * 全部走 allSettled / catch，清理失败只记日志，不能掩盖主流程结果。
 */
export async function cleanupTaskState(env, uploadId, totalChunks, taskData) {
  const chunkBackend =
    taskData?.chunkBackend || (env.R2_BUCKET ? "r2" : "kv");
  const isR2Native =
    taskData?.storageMode === "r2" && Boolean(taskData?.r2Multipart?.uploadId);

  try {
    if (isR2Native || chunkBackend === "r2") {
      // part-state 在两种 R2 场景下都可能存在
      await deletePartStates(env, uploadId, totalChunks);
    }

    if (chunkBackend === "r2" && env.R2_BUCKET) {
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
 * 删除任务的 part-state 键（按索引逐个删，不依赖 list）。
 */
export async function deletePartStates(env, uploadId, totalChunks) {
  if (!env?.img_url) return;
  try {
    const jobs = [];
    for (let i = 0; i < totalChunks; i++) {
      jobs.push(env.img_url.delete(partStateKey(uploadId, i)));
    }
    await Promise.allSettled(jobs);
  } catch (error) {
    console.error("deletePartStates error:", error);
  }
}

/**
 * 清理文件指纹映射。fileId 为空时静默跳过（老客户端不传 fileId）。
 */
export async function deleteResumeMap(env, ownerId, fileId) {
  if (!env?.img_url || !ownerId || !fileId) return;
  try {
    await env.img_url.delete(resumeMapKey(ownerId, fileId));
  } catch (error) {
    console.error("deleteResumeMap error:", error);
  }
}

// ============================================================
// 秒传索引（内容哈希 → 已上传文件）
// ============================================================
// 与续传用的 resume-map 是两套完全独立的键空间，语义也不同：
//   resume-map —— 文件指纹 → 未完成的 uploadId（接着传）
//   instant    —— 内容哈希 → 已完成的文件（不用传）
// 键构造收敛到这里，是为了保证 init.js 查询与 complete.js 写入不会写歪。

export function instantIndexKey(ownerId, fileHash) {
  return `instant:${ownerId}:${fileHash}`;
}

/** 只接受标准 SHA-256 hex，避免拿脏数据去查 KV。 */
export function normalizeFileHash(value) {
  if (typeof value !== "string") return "";
  const v = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(v) ? v : "";
}

/**
 * 读取秒传索引。不存在 / 损坏 / 体积对不上时返回 null（一律当作未命中，
 * 让调用方降级成正常上传，而不是报错）。
 */
export async function readInstantIndex(env, ownerId, fileHash, fileSize) {
  if (!env?.img_url || !ownerId || !fileHash) return null;
  try {
    const raw = await env.img_url.get(instantIndexKey(ownerId, fileHash));
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || !rec.key) return null;
    // 哈希已能说明内容相同，体积是再多一道廉价确认，防索引写脏时误命中
    if (Number(rec.size) !== Number(fileSize)) return null;
    return rec;
  } catch (error) {
    console.error("readInstantIndex error:", error);
    return null;
  }
}

/**
 * 登记秒传索引。只在文件带全量内容哈希时写 —— 大文件不算哈希，
 * 自然也进不了索引（这是刻意取舍，见前端 INSTANT_HASH_MAX_BYTES）。
 */
export async function writeInstantIndex(env, ownerId, taskData, fileKey) {
  const hash = normalizeFileHash(taskData?.fileHash);
  if (!hash || !fileKey || !ownerId || !env?.img_url) return;

  const rec = {
    key: fileKey,
    url: `/file/${fileKey}`,
    fileName: taskData.fileName || "",
    size: taskData.fileSize,
    mime: taskData.fileType || "application/octet-stream",
    storageMode: taskData.storageMode || "",
    uploadedAt: Date.now(),
  };

  try {
    await env.img_url.put(instantIndexKey(ownerId, hash), JSON.stringify(rec), {
      expirationTtl: INSTANT_INDEX_TTL_SECONDS,
    });
  } catch (error) {
    // 写索引失败不该影响这次上传的结果
    console.error("writeInstantIndex error:", error);
  }
}
