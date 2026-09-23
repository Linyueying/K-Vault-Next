// ============================================================
// 分片大小（按分片暂存后端能力区分）
// ============================================================

// R2 原生 multipart：单分片 50MB
export const CHUNK_SIZE_R2 = 50 * 1024 * 1024; // 50MB

// KV 暂存后端：单分片 20MB（KV 单值上限 25MB，留安全余量）
export const CHUNK_SIZE_KV = 20 * 1024 * 1024; // 20MB

/**
 * 根据“分片暂存后端”返回合适的分片大小。
 *
 * ⚠️ 前后端必须使用同一规则，否则 init.js 的 totalChunks 校验会
 *    报 CHUNK_COUNT_MISMATCH：
 *    - 后端 init.js：resolveChunkSizeForBackend(chunkBackend === 'r2')
 *    - 前端 index.html：this.r2Available ? CHUNK_SIZE_R2 : CHUNK_SIZE_KV
 *
 * @param {boolean} hasR2Backend
 *   是否可用 R2 作为分片暂存后端。
 *   - true  → 50MB（R2 原生 multipart 可直接承接大分片）
 *   - false → 20MB（KV 单值上限 25MB，需留安全余量）
 * @returns {number} 分片字节大小
 */
export function resolveChunkSizeForBackend(hasR2Backend) {
  return hasR2Backend ? CHUNK_SIZE_R2 : CHUNK_SIZE_KV;
}

// ============================================================
// 分片大小分档（按文件体积自适应）
// ============================================================

// 目标分片数：让分片数落在十几个的量级 —— 足够喂满并发、进度够平滑，
// 又不至于把 512MB 文件切成上百个请求去消耗 Pages 请求配额。
export const TARGET_CHUNK_COUNT = 16;

// 分档后的单片上下限。上限 40MB 是被 isolate 内存倒推出来的硬约束：
// 并发 2 路 × 40MB = 80MB，在 128MB 共享 isolate 里还留 48MB 余量。
export const MIN_CHUNK_SIZE_ADAPTIVE = 8 * 1024 * 1024; // 8MB
export const MAX_CHUNK_SIZE_ADAPTIVE = 40 * 1024 * 1024; // 40MB

/**
 * 按文件体积推导分片大小（自适应分档）。
 *
 * 为什么不再固定 50MB：
 *   - 单片 50MB 时，一片失败就要重传 50MB，弱网下代价极高；
 *   - 单片过大时 totalChunks 很少（512MB 只有 11 片），进度条一跳就是 9%，
 *     观感割裂，也喂不饱分片级并发；
 *   - 但仍必须保证 totalChunks ≤ MAX_TOTAL_CHUNKS(256)，否则 init 直接拒绝。
 *
 * 分档结果（R2 后端）：
 *   20MB  → 8MB  × 3 片
 *   512MB → 32MB × 16 片
 *   1GB   → 40MB × 26 片
 *   10GB  → 40MB × 256 片（正好卡在上限内）
 *
 * ⚠️ 非 R2（KV 暂存）分支不做分档：KV 单值上限 25MB，且后续 complete
 *    阶段要在内存里一次性拼装整个文件（≤40MB），分片再小也没有收益，
 *    反而徒增请求数。
 *
 * @param {boolean} hasR2Backend 是否可用 R2 作为分片暂存后端
 * @param {number} fileSize 文件字节数
 * @returns {number} 分片字节大小
 */
export function resolveChunkSizeForFile(hasR2Backend, fileSize) {
  if (!hasR2Backend) return CHUNK_SIZE_KV;

  const size = Number(fileSize) || 0;
  if (size <= 0) return MIN_CHUNK_SIZE_ADAPTIVE;

  const ideal = Math.ceil(size / TARGET_CHUNK_COUNT);
  return Math.min(
    MAX_CHUNK_SIZE_ADAPTIVE,
    Math.max(MIN_CHUNK_SIZE_ADAPTIVE, ideal)
  );
}

// ============================================================
// 全局上限
// ============================================================

// 非 R2 原生 multipart 分支需要在 Worker 内存中拼装，
// 该值为内存拼装安全上限。
export const MAX_IN_MEMORY_ASSEMBLY = 40 * 1024 * 1024; // 40MB

// R2 原生 multipart 单任务最大文件大小
export const MAX_FILE_SIZE_R2 = 10 * 1024 * 1024 * 1024; // 10GB

// 单任务最大分片数
export const MAX_TOTAL_CHUNKS = 256;

// ============================================================
// 各存储平台限制
// ============================================================

export const TELEGRAM_WEB_UPLOAD_LIMIT = 20 * 1024 * 1024;   // 20MB
export const DISCORD_UPLOAD_LIMIT = 25 * 1024 * 1024;         // 25MB
export const HUGGINGFACE_UPLOAD_LIMIT = 35 * 1024 * 1024;     // 35MB
export const GITHUB_UPLOAD_LIMIT = 100 * 1024 * 1024;         // 100MB