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

// Telegram 单消息直传与 getFile 上限（20MB）
export const TELEGRAM_WEB_UPLOAD_LIMIT = 20 * 1024 * 1024;   // 20MB
// Telegram 虚拟分片模式：单片 18MB（严格低于 20MB getFile 红线，留 2MB 协议余量）
export const CHUNK_SIZE_TELEGRAM = 18 * 1024 * 1024;         // 18MB
// Telegram 虚拟分片模式单文件上限（2GB ≈ 114 片，≤ MAX_TOTAL_CHUNKS 256）
export const TELEGRAM_CHUNKED_MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

export const DISCORD_UPLOAD_LIMIT = 25 * 1024 * 1024;         // 25MB
export const HUGGINGFACE_UPLOAD_LIMIT = 35 * 1024 * 1024;     // 35MB
export const GITHUB_UPLOAD_LIMIT = 100 * 1024 * 1024;         // 100MB