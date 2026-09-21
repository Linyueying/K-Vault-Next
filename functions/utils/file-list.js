/**
 * 文件列表的公共工具 —— 从 `functions/api/manage/list.js` 提取而来。
 *
 * 提取动机：`/api/manage/list`（文件总览）与 `/api/manage/shares`（分享总览）
 * 需要完全一致的「什么算一个文件」判定。此前这些规则只存在于 list.js 内部，
 * 新接口若复制一份，两处一旦漂移就会出现「分享面板里看到的文件，在文件列表里
 * 找不到」这类幽灵条目。
 *
 * 本模块只做「筛选 + 归一化」，不涉及任何鉴权。鉴权仍在各路由的
 * `_middleware.js` / 处理函数里完成。
 *
 * @module file-list
 */

// idxt: 为记录索引键、dlc: 为下载计数键 —— 均属内部辅助数据，不得出现在文件列表中。
export const INVALID_PREFIXES = ['session:', 'chunk:', 'upload:', 'temp:', 'idxt:', 'dlc:'];

export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'ico', 'svg', 'heic', 'heif', 'avif']);
export const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogg', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'm4v', '3gp', 'ts']);
export const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'ape', 'opus']);

/**
 * 归一化文件夹路径：统一斜杠、去掉空段与 `.`、解析 `..`。
 * @param value - 原始路径。
 * @returns 归一化后的路径（无前导/尾随斜杠）。
 */
export function normalizeFolderPath(value = '') {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  const output = [];
  for (const part of raw.split('/')) {
    const piece = part.trim();
    if (!piece || piece === '.') continue;
    if (piece === '..') {
      output.pop();
      continue;
    }
    output.push(piece);
  }
  return output.join('/');
}

/**
 * 推断存储后端类型：优先读元数据显式声明，否则按 KV key 前缀判断。
 */
export function inferStorageType(name, metadata = {}) {
  const explicit = metadata.storageType || metadata.storage;
  if (explicit) return String(explicit).toLowerCase();

  const keyName = String(name || '');
  if (keyName.startsWith('r2:')) return 'r2';
  if (keyName.startsWith('s3:')) return 's3';
  if (keyName.startsWith('discord:')) return 'discord';
  if (keyName.startsWith('hf:')) return 'huggingface';
  if (keyName.startsWith('webdav:')) return 'webdav';
  if (keyName.startsWith('github:')) return 'github';
  return 'telegram';
}

/**
 * 按扩展名推断文件大类（image / video / audio / document）。
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

/** 是否为文件夹占位标记（不应出现在文件列表里）。 */
export function isFolderMarker(key) {
  if (!key?.name) return false;
  if (String(key.name).startsWith('folder:')) return true;
  return key.metadata?.folderMarker === true;
}

/**
 * 是否应被视为一个真实文件条目。
 * 要求同时有 `fileName` 与 `TimeStamp`，以排除各种内部辅助键。
 */
export function shouldIncludeKey(key) {
  if (!key?.name) return false;
  if (INVALID_PREFIXES.some((item) => key.name.startsWith(item))) return false;
  if (isFolderMarker(key)) return false;

  const metadata = key.metadata || {};
  return Boolean(metadata.fileName) && metadata.TimeStamp !== undefined && metadata.TimeStamp !== null;
}

/**
 * 归一化一条 KV key 记录，补齐 `storageType` / `fileType` / `folderPath`。
 *
 * 注意：`metadata` 是展开保留的，因此分享字段（`shareSlug`、`shareExpiresAt`、
 * `shareMaxDownloads`、`sharePasswordHash` 等）会原样带出，调用方可直接使用。
 *
 * @param key - `env.img_url.list()` 返回的单条记录。
 */
export function normalizeKey(key) {
  const metadata = key.metadata || {};
  const storageType = inferStorageType(key.name, metadata);
  const fileType = inferFileType(key.name, metadata);
  const folderPath = normalizeFolderPath(metadata.folderPath || metadata.path || '');

  return {
    ...key,
    metadata: {
      ...metadata,
      storageType,
      fileType,
      folderPath,
    },
  };
}

/**
 * 分页拉取 KV 中全部 key。
 * @param env - Pages 环境（需绑定 `img_url`）。
 * @param prefix - 可选前缀过滤。
 */
export async function listAllKeys(env, prefix = '') {
  const allKeys = [];
  let cursor = undefined;
  let guard = 0;

  do {
    const page = await env.img_url.list({ limit: 1000, cursor, prefix: prefix || undefined });
    allKeys.push(...(page.keys || []));
    cursor = page.list_complete ? undefined : page.cursor;
    guard += 1;
  } while (cursor && guard < 10000);

  return allKeys;
}

/**
 * 一次性拿到「全部归一化后的文件条目」。
 *
 * 分享总览等只读接口的通用入口：拉取 → 过滤内部键 → 归一化。
 *
 * @param env - Pages 环境（需绑定 `img_url`）。
 * @param options.prefix - 可选前缀过滤。
 * @returns {Promise<Array>} 归一化后的文件条目数组。
 */
export async function listNormalizedFiles(env, options = {}) {
  const allKeys = await listAllKeys(env, options.prefix || '');
  return allKeys.filter(shouldIncludeKey).map(normalizeKey);
}
