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

import { listAllRecords, listRecordsPage } from './file-record.js';
import { inferFileType } from './file-type.js';

// idxt: 为记录索引键、dlc: 为下载计数键 —— 均属内部辅助数据，不得出现在文件列表中。
export const INVALID_PREFIXES = ['session:', 'chunk:', 'upload:', 'temp:', 'idxt:', 'dlc:'];

// 判定下沉到 file-type.js（metadata-d1.js 写库时也要用同一份），
// 此处 re-export 是为了不动既有 import 方。
export { inferFileType, IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, FILE_TYPES } from './file-type.js';

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
// 短 TTL 缓存：翻页 / 多接口同时列举时，避免对同一前缀反复全量扫描 KV 命名空间
// （每次 list() 调用都计费，全量列举成本随文件数线性增长）。
// 代价：上传后最多 LIST_CACHE_TTL_MS 内才会出现在列表中；上传响应本身已返回新文件，
// 且列表并非强一致场景，2 秒窗口的轻微陈旧在文件库场景可接受。
const LIST_CACHE_TTL_MS = 2000;
const listCache = new Map(); // prefix -> { ts, keys }

export async function listAllKeys(env, prefix = '') {
  const cacheKey = prefix || '';
  const cached = listCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < LIST_CACHE_TTL_MS) {
    return cached.keys;
  }

  const allKeys = [];
  let cursor = undefined;
  let guard = 0;

  do {
    const page = await env.img_url.list({ limit: 1000, cursor, prefix: prefix || undefined });
    allKeys.push(...(page.keys || []));
    cursor = page.list_complete ? undefined : page.cursor;
    guard += 1;
  } while (cursor && guard < 10000);

  listCache.set(cacheKey, { ts: Date.now(), keys: allKeys });
  return allKeys;
}

/**
 * 一次性拿到「全部归一化后的文件条目」。
 *
 * 分享总览等只读接口的通用入口。
 *
 * **数据源策略（D1 优先 / KV 兜底）**：
 *   1. D1 已绑定 → 走 SQL 取回全部行（分页批取），转成 KV 同形状 key 后归一化。
 *      收益：不再全量扫 KV 命名空间；`idxt:` / `dlc:` 等内部键天然不存在于表中，
 *      过滤规则从"必须排除"退化为"无需排除"。
 *   2. D1 未绑定 / 查询失败 → 回落原有 `listAllKeys` 扫 KV。
 *
 * 两条路径产出的条目形状完全一致（都经 `normalizeKey`），调用方无感。
 *
 * @param env - Pages 环境（D1 走 `DB`，兜底走 `img_url`）。
 * @param options.prefix - 可选前缀过滤（仅 KV 路径生效；D1 路径由 storage 列表达）。
 * @returns {Promise<Array>} 归一化后的文件条目数组。
 */
export async function listNormalizedFiles(env, options = {}) {
  // ---------- 路径 A：D1 ----------
  if (!options.prefix) {
    const page = await listAllRecords(env, options);
    if (!page.disabled) {
      return page.files.map(normalizeKey);
    }
    // disabled / error → 落到 KV 路径
  }

  // ---------- 路径 B：KV 兜底 ----------
  const allKeys = await listAllKeys(env, options.prefix || '');
  return allKeys.filter(shouldIncludeKey).map(normalizeKey);
}

/**
 * 【新函数】分页列出文件（D1 优先 / KV 兜底），供 `/api/manage/list` 使用。
 *
 * 与 `listNormalizedFiles` 的区别：D1 路径下分页**下推到 SQL**，
 * 不会为了取第 N 页而把整个命名空间读一遍。
 *
 * 返回体与 `list.js` 原有响应结构对齐（keys / pageCount / list_complete），
 * 并额外返回 `source` 便于排查当前走的是哪条路径。
 *
 * @param env
 * @param {{
 *   limit?: number, offset?: number, prefix?: string,
 *   storage?: string, sort?: string, folderPath?: string
 * }} options
 * @returns {Promise<{keys: Array, list_complete: boolean, cursor: string|null, source: string, total?: number, disabled?: boolean}>}
 */
export async function listFilesPage(env, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 1000);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const prefix = options.prefix || '';

  // ---------- 路径 A：D1（SQL 分页） ----------
  if (!prefix) {
    const page = await listRecordsPage(env, {
      storage: options.storage,
      folderPath: options.folderPath,
      sort: options.sort,
      limit,
      offset,
    });

    if (!page.disabled) {
      const items = page.files.map(normalizeKey);
      const nextOffset = offset + items.length < page.total ? offset + items.length : null;
      return {
        keys: items,
        list_complete: nextOffset == null,
        cursor: nextOffset == null ? null : String(nextOffset),
        source: 'd1',
        total: page.total,
      };
    }
    // disabled / error → 落到 KV 路径
  }

  // ---------- 路径 B：KV 兜底 ----------
  const allKeys = await listAllKeys(env, prefix);
  const filtered = allKeys
    .filter(shouldIncludeKey)
    .map(normalizeKey)
    .sort((a, b) => Number(b?.metadata?.TimeStamp || 0) - Number(a?.metadata?.TimeStamp || 0));

  const items = filtered.slice(offset, offset + limit);
  const nextOffset = offset + limit < filtered.length ? offset + limit : null;

  return {
    keys: items,
    list_complete: nextOffset == null,
    cursor: nextOffset == null ? null : String(nextOffset),
    source: 'kv',
    total: filtered.length,
  };
}

/**
 * 统计一批文件的类型 / 存储分布（后台面板的 stats 块）。
 *
 * 原为 `list.js` 的私有函数，下沉到这里是为了让测试能直接拿它与
 * `aggregateFileStats()`（SQL 版）逐字段对拍 —— 下推 SQL 最大的风险就是
 * 两条路径口径漂移，能对比才守得住。
 *
 * 口径要点（SQL 版必须与之完全一致）：
 *   · fileType 缺失 → 记入 document
 *   · storageType 缺失 → 记入 telegram
 *   · 未知取值 → **不计入**任何 byStorage 桶（hasOwnProperty 检查）
 *
 * @param {Array} files - 已过 normalizeKey 的条目
 */
export function computeStats(files = []) {
  const stats = {
    total: 0,
    byType: { image: 0, video: 0, audio: 0, document: 0 },
    byStorage: {
      telegram: 0,
      r2: 0,
      s3: 0,
      discord: 0,
      huggingface: 0,
      webdav: 0,
      github: 0,
    },
  };

  for (const file of files) {
    const fileType = file?.metadata?.fileType || 'document';
    const storageType = file?.metadata?.storageType || 'telegram';

    stats.total += 1;
    if (Object.prototype.hasOwnProperty.call(stats.byType, fileType)) {
      stats.byType[fileType] += 1;
    } else {
      stats.byType.document += 1;
    }

    if (Object.prototype.hasOwnProperty.call(stats.byStorage, storageType)) {
      stats.byStorage[storageType] += 1;
    }
  }

  return stats;
}

/**
 * 把 D1 的 folders 映射（{ "<path>": {count, marker} }）转成节点数组。
 *
 * 原为 `folders.js` 的私有函数。下沉到这里是因为 `/api/manage/list` 在
 * 把 folders 计算下推给 SQL 后也需要它 —— 两个接口必须产出完全一致的
 * 目录树形状，各写一份迟早漂移。
 *
 * 输出字段与 `buildFolderNodes()` 完全对齐（path / name / parentPath /
 * depth / fileCount），排序规则也一致（先按深度、再按字典序）。
 *
 * @param {object} folderMap - listFolderStats() 返回的 folders
 * @param {Array} markers - listMarkers() 返回的标记数组（仅用于补进空目录）
 */
export function nodesFromFolderMap(folderMap = {}, markers = []) {
  const paths = new Set(Object.keys(folderMap));

  // 标记可能在 folderMap 中缺席（如无文件的空目录），补进来
  for (const marker of markers) {
    const path = normalizeFolderPath(marker?.path || '');
    if (path) paths.add(path);
  }

  return [...paths]
    .sort((a, b) => {
      const depthA = a.split('/').length;
      const depthB = b.split('/').length;
      if (depthA !== depthB) return depthA - depthB;
      return a.localeCompare(b, 'en', { sensitivity: 'base' });
    })
    .map((pathValue) => {
      const parts = pathValue.split('/');
      return {
        path: pathValue,
        name: parts[parts.length - 1] || pathValue,
        parentPath: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
        depth: parts.length,
        fileCount: folderMap[pathValue]?.count || 0,
      };
    });
}
