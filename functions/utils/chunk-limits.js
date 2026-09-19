/**
 * 分片上传共享限制常量。
 *
 * 该模块同时被 init.js、chunk.js、complete.js 使用，
 * 用于统一 CHUNK_SIZE、内存拼装上限、各存储大小限制。
 */

// 与前端 index.html uploadConfig.chunkSize 保持一致
export const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

// 非 R2 原生 multipart 分支需要在 Worker 内存中拼装，
// 该值为内存拼装安全上限。
export const MAX_IN_MEMORY_ASSEMBLY = 40 * 1024 * 1024; // 40MB

// R2 原生 multipart 单任务最大文件大小
export const MAX_FILE_SIZE_R2 = 2048 * 1024 * 1024; // 2GB

// 单任务最大分片数
export const MAX_TOTAL_CHUNKS = 256;

// 各存储平台限制
export const TELEGRAM_WEB_UPLOAD_LIMIT = 20 * 1024 * 1024;   // 20MB
export const DISCORD_UPLOAD_LIMIT = 25 * 1024 * 1024;         // 25MB
export const HUGGINGFACE_UPLOAD_LIMIT = 35 * 1024 * 1024;     // 35MB
export const GITHUB_UPLOAD_LIMIT = 100 * 1024 * 1024;         // 100MB