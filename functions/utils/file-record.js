/**
 * 文件记录定位工具 — KV 读放大优化的公共底座。
 *
 * 背景：
 *   KV 中文件的 key 带有存储前缀（img: / vid: / r2: / ... ），但调用方常常
 *   只持有"裸 ID"。历史实现为此把所有前缀都拼一遍、串行 getWithMetadata
 *   逐个试，最坏 11 次读。
 *
 * 优化：
 *   引入一层轻量索引键 `idxt:<裸ID>` → 实际 kvKey。
 *     · 命中索引：1~2 次读直接定位（get 索引 + getWithMetadata 记录）
 *     · 未命中  ：回落到原有的"逐前缀串行探测"，行为与优化前完全一致，
 *                 并在命中后回填索引，下次即走快路径
 *
 * 安全性：
 *   本模块只负责"定位 key"，不参与任何鉴权 / 封禁 / 白名单 / 密码 / 限额判断。
 *   返回值结构 { record, kvKey } 与各调用点原有的本地实现逐字段一致，
 *   因此调用方后续的安全分支无需改动。
 */

/**
 * 存储前缀列表。顺序与各调用点原有实现保持一致（v1/upload.js 另有顺序，
 * 通过 buildCandidateKeys 的 prefixes 参数传入，不在此处强行统一）。
 */
export const STORAGE_PREFIXES = [
  'img:',
  'vid:',
  'aud:',
  'doc:',
  'r2:',
  's3:',
  'discord:',
  'hf:',
  'webdav:',
  'github:',
  '',
];

/** 索引键前缀：idxt:<裸ID> → 实际 kvKey */
export const ID_INDEX_PREFIX = 'idxt:';

/** 分享下载计数键前缀：dlc:<kvKey> → 计数字符串 */
export const DOWNLOAD_COUNT_PREFIX = 'dlc:';

/**
 * 判断 ID 是否已经带有已知存储前缀。
 * @param {string} fileId
 * @param {string[]} prefixes
 * @returns {boolean}
 */
export function hasStoragePrefix(fileId, prefixes = STORAGE_PREFIXES) {
  const value = String(fileId || '');
  return prefixes.some((prefix) => prefix && value.startsWith(prefix));
}

/**
 * 构造候选 key 列表（保留调用方原有的前缀顺序语义）。
 * @param {string} fileId
 * @param {{prefixes?: string[], forceAll?: boolean}} options
 * @returns {string[]}
 */
export function buildCandidateKeys(fileId, options = {}) {
  const value = String(fileId || '');
  const prefixes = Array.isArray(options.prefixes) ? options.prefixes : STORAGE_PREFIXES;
  const forceAll = options.forceAll === true;

  if (!forceAll && hasStoragePrefix(value, prefixes)) {
    return [value];
  }
  return prefixes.map((prefix) => `${prefix}${value}`);
}

/**
 * 从实际 kvKey 反推索引用的"裸 ID"。
 * 带前缀则剥离前缀；无前缀（如 Telegram 的 `${fileId}.${ext}`）原样返回。
 * @param {string} kvKey
 * @param {string[]} prefixes
 * @returns {string}
 */
export function deriveIndexId(kvKey, prefixes = STORAGE_PREFIXES) {
  const value = String(kvKey || '');
  for (const prefix of prefixes) {
    if (prefix && value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return value;
}

/**
 * 登记索引：idxt:<裸ID> = kvKey
 * 失败不影响主流程（索引只是加速层）。
 * @param {any} env
 * @param {string} kvKey 实际写入的 KV key
 * @param {{prefixes?: string[]}} options
 */
export async function putRecordIndex(env, kvKey, options = {}) {
  if (!env?.img_url || !kvKey) return;
  const prefixes = Array.isArray(options.prefixes) ? options.prefixes : STORAGE_PREFIXES;
  const indexId = options.indexId !== undefined ? String(options.indexId) : deriveIndexId(kvKey, prefixes);
  if (!indexId) return;

  try {
    await env.img_url.put(`${ID_INDEX_PREFIX}${indexId}`, String(kvKey), {
      metadata: { kvKey: String(kvKey), indexedAt: Date.now() },
    });
  } catch (error) {
    console.warn('Failed to write record index:', error?.message || error);
  }
}

/**
 * 清理索引。删除文件时同步调用，避免索引残留在列表里或指向已删除 key。
 * @param {any} env
 * @param {string} fileId 裸 ID 或 kvKey，二者都可
 * @param {{prefixes?: string[]}} options
 */
export async function deleteRecordIndex(env, fileId, options = {}) {
  if (!env?.img_url || !fileId) return;
  const prefixes = Array.isArray(options.prefixes) ? options.prefixes : STORAGE_PREFIXES;
  const candidates = new Set([
    `${ID_INDEX_PREFIX}${String(fileId)}`,
    `${ID_INDEX_PREFIX}${deriveIndexId(String(fileId), prefixes)}`,
  ]);

  await Promise.all(
    [...candidates].map((key) =>
      env.img_url.delete(key).catch(() => {})
    )
  );
}

/**
 * 清理下载计数键。
 * @param {any} env
 * @param {string} kvKey
 */
export async function deleteDownloadCount(env, kvKey) {
  if (!env?.img_url || !kvKey) return;
  try {
    await env.img_url.delete(`${DOWNLOAD_COUNT_PREFIX}${kvKey}`);
  } catch (error) {
    console.warn('Failed to delete download count:', error?.message || error);
  }
}

/**
 * 通过索引键快速定位（1 次读索引 + 1 次读记录）。
 * @returns {Promise<{record: any, kvKey: string}|null>}
 */
async function locateByIndex(env, fileId) {
  const indexKey = `${ID_INDEX_PREFIX}${fileId}`;
  const kvKey = await env.img_url.get(indexKey);
  if (!kvKey) return null;

  const record = await env.img_url.getWithMetadata(String(kvKey));
  if (record?.metadata) {
    return { record, kvKey: String(kvKey) };
  }

  // 索引陈旧（记录已被外部删除或改名）：清理后交给调用方走回落路径
  await env.img_url.delete(indexKey).catch(() => {});
  return null;
}

/**
 * 带索引加速的记录定位。
 *
 * 行为契约（与优化前各文件本地实现保持一致）：
 *   - 带已知前缀  → 直接 getWithMetadata(fileId)，1 次读，不碰索引
 *   - 裸 ID      → 先查索引；命中即返回；未命中回落逐前缀串行探测
 *   - 找不到      → 返回 { record: null, kvKey: fileId }
 *
 * @param {any} env
 * @param {string} fileId
 * @param {{
 *   prefixes?: string[],
 *   forceAll?: boolean,
 *   skipIndex?: boolean,
 *   onIndexHit?: (info: {indexed: boolean, kvKey: string}) => void
 * }} options
 * @returns {Promise<{record: any, kvKey: string}>}
 */
export async function getRecordWithKey(env, fileId, options = {}) {
  if (!env?.img_url) return { record: null, kvKey: fileId };

  const value = String(fileId || '');
  const prefixes = Array.isArray(options.prefixes) ? options.prefixes : STORAGE_PREFIXES;
  const known = hasStoragePrefix(value, prefixes);

  // 路径 A：已带前缀，直接读（与优化前完全一致，零额外开销）
  if (known && !options.forceAll) {
    const record = await env.img_url.getWithMetadata(value);
    return { record, kvKey: value };
  }

  // 路径 B：裸 ID，先查索引
  if (!options.skipIndex) {
    const indexed = await locateByIndex(env, value);
    if (indexed) {
      if (typeof options.onIndexHit === 'function') {
        options.onIndexHit({ indexed: true, kvKey: indexed.kvKey });
      }
      return indexed;
    }
  }

  // 路径 C：回落逐前缀串行探测（保留原有语义与顺序）
  const candidateKeys = buildCandidateKeys(value, { prefixes, forceAll: options.forceAll === true });
  for (const key of candidateKeys) {
    const record = await env.img_url.getWithMetadata(key);
    if (record?.metadata) {
      // 命中后回填索引（幂等；失败不影响本次结果）
      if (!options.skipIndex) {
        await putRecordIndex(env, key, { prefixes, indexId: value });
      }
      if (typeof options.onIndexHit === 'function') {
        options.onIndexHit({ indexed: false, kvKey: key });
      }
      return { record, kvKey: key };
    }
  }

  if (typeof options.onIndexHit === 'function') {
    options.onIndexHit({ indexed: false, kvKey: value });
  }
  return { record: null, kvKey: value };
}

/**
 * 读取分享下载计数：优先独立计数键，缺失则回落到元数据内联值。
 *
 * 语义与优化前一致 —— 优化前直接读 metadata.shareDownloadCount，
 * 这里只是把"来源"扩展为两处合并，对首次写入前的存量数据保持兼容。
 *
 * @param {any} env
 * @param {string} kvKey
 * @param {object} metadata
 * @returns {Promise<number>}
 */
export async function readDownloadCount(env, kvKey, metadata = {}) {
  const fallback = Number(metadata?.shareDownloadCount || 0) || 0;
  if (!env?.img_url || !kvKey) return fallback;

  try {
    const raw = await env.img_url.get(`${DOWNLOAD_COUNT_PREFIX}${kvKey}`);
    if (raw !== null && raw !== undefined && raw !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  } catch (error) {
    console.warn('Failed to read download count:', error?.message || error);
  }
  return fallback;
}

/**
 * 递增分享下载计数（只写几字节数字，不再重写整个 metadata）。
 * @param {any} env
 * @param {string} kvKey
 * @param {object} metadata
 * @param {number} ttlSeconds
 */
export async function incrementDownloadCount(env, kvKey, metadata = {}, ttlSeconds = 60 * 60 * 24 * 30) {
  if (!env?.img_url || !kvKey) return;
  const current = await readDownloadCount(env, kvKey, metadata);
  await env.img_url.put(`${DOWNLOAD_COUNT_PREFIX}${kvKey}`, String(current + 1), {
    expirationTtl: ttlSeconds,
  });
}
