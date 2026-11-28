/**
 * 文件大类判定（image / video / audio / document）。
 *
 * 单独成模块的原因：这个判定同时被两处需要 ——
 *   · `file-list.js` 的 normalizeKey()：给列表条目补 fileType（内存侧）
 *   · `metadata-d1.js` 的 metadataToColumns()：写入 files.file_type 列（存储侧）
 *
 * 若把它放在 file-list.js 里，metadata-d1.js 就得 import file-list.js，
 * 而 file-list.js → file-record.js → metadata-d1.js 已经形成依赖链，
 * 反向引用会造成循环依赖。故下沉为独立模块，两边共用同一份判定，
 * 保证「内存算的」与「存在库里的」永远同口径。
 *
 * @module file-type
 */

export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'ico', 'svg', 'heic', 'heif', 'avif']);
export const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogg', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'm4v', '3gp', 'ts']);
export const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'ape', 'opus']);

/** 四大类的合法取值（与后台 stats.byType 的键一一对应）。 */
export const FILE_TYPES = ['image', 'video', 'audio', 'document'];

/**
 * 按扩展名推断文件大类。
 *
 * 取名优先用 `metadata.fileName`（真实文件名），缺失时退回 key 名。
 * 无法识别的一律归为 `document`，与旧行为一致。
 *
 * @param {string} name - KV key / 存储对象名（作为文件名缺失时的兜底）
 * @param {object} metadata - 记录元数据
 * @returns {'image'|'video'|'audio'|'document'}
 */
export function inferFileType(name, metadata = {}) {
  const sourceName = metadata.fileName || name || '';
  const segments = String(sourceName).split('.');
  const ext = segments.length > 1 ? segments.pop().toLowerCase() : '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'document';
}
