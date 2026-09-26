/**
 * 文件记录定位工具 — 公共底座（D1 优先，KV 兜底）
 *
 * ============================================================================
 * 架构（A 方案：全新部署，D1 为元数据主源）
 * ============================================================================
 *
 *   D1 `files` 表  ── 第一条数据源（上传时写入，见 registerFileRecord）
 *   KV  `img_url`  ── 兜底（D1 写入失败的降级目标 / 未绑定 D1 时仍可用）
 *
 * 读取顺序：D1 → miss → KV 前缀探测
 * 写入顺序：D1 → 失败 → KV（由调用方的既有 KV 写入负责兜底）
 *
 * ============================================================================
 * 为什么保留 KV 探测回落
 * ============================================================================
 *   1. D1 未绑定（env.DB 不存在）时，本模块行为与历史版本完全一致 ——
 *      代码可以先合进仓库、跑在纯 KV 环境，绑上 D1 后自动提速。
 *   2. D1 写入可能失败（网络抖动 / 额度耗尽），此时 KV 里有记录而 D1 没有，
 *      回落能兜住，不至于文件"凭空消失"。
 *
 * ============================================================================
 * 与历史版本的接口兼容
 * ============================================================================
 * 下列 6 个导出函数的**签名与返回值形状完全不变**，因此 20+ 个调用点
 * （upload.js / file/[[path]].js / share-options.js / manage/* ...）零改动。
 *
 *   getRecordWithKey(env, fileId, opts)   → { record, kvKey }
 *   putRecordIndex(env, kvKey, opts)      → void
 *   deleteRecordIndex(env, fileId)        → void
 *   readDownloadCount(env, kvKey, meta)   → number
 *   incrementDownloadCount(env, kvKey)    → void
 *   deleteDownloadCount(env, kvKey)       → void
 *
 * 语义变化（有意为之）：
 *   · putRecordIndex / deleteRecordIndex → **no-op**。D1 主键即索引，
 *     不再需要 idxt: 旁挂键。保留函数名是为了不动调用点。
 *   · deleteDownloadCount → **no-op**。计数在 files 表内，随记录删除。
 *   · incrementDownloadCount → 改走 D1 原子自增（修并发丢计数 / 超发）。
 */

import {
  isD1Enabled,
  getFileRecord,
  putFileRecord,
  deleteFileRecord,
  tryConsumeDownload,
  refundDownloadQuota,
  listFileRecords,
  listFolderMarkers,
  folderFileCounts,
  upsertFolderMarker,
  deleteFolderMarkers,
  moveFolderTree,
  clearFolderPath,
} from './metadata-d1.js';

/**
 * 存储前缀列表。顺序与调用点原有实现保持一致（v1/upload.js 另有顺序，
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

/** 索引键前缀（D1 模式下已弃用，仅为兼容保留常量）。 */
export const ID_INDEX_PREFIX = 'idxt:';

/** 分享下载计数键前缀（D1 模式下已弃用，仅为兼容保留常量）。 */
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

// ============================================================================
// 列表侧
// ============================================================================

/**
 * 把 D1 行转成与 KV `getWithMetadata` 逐字段同形的 `{ name, metadata }`。
 *
 * **为什么必须同形**：`file-list.js` 的 `normalizeKey(key)` 读 `key.name` 与
 * `key.metadata.*`；`share-options.js` 的 `buildShareRecord(env, metadata, kvKey)`
 * 也读 `metadata.*` + kvKey。只要这里形状对齐，所有下游（列表、分享总览、
 * 合集成员）就能在 D1 / KV 两种数据源上跑同一套代码，零分支。
 *
 * @param {object} row - D1 files 表行
 * @returns {{name: string, metadata: object}}
 */
export function d1FileToKey(row) {
  const kvKey = row.kv_key || '';
  const id = row.id || deriveIndexId(kvKey);

  // storage_key 是存储内的对象名；KV metadata 缺它会定位不到文件，
  // 故此处必须回填（与原 rowToRecord 的字段命名保持一致）。
  const storage = String(row.storage || 'telegram').toLowerCase();
  const storageFields = {};
  if (row.storage_key) {
    if (storage === 'r2') storageFields.r2Key = row.storage_key;
    else if (storage === 's3') storageFields.s3Key = row.storage_key;
    else if (storage === 'huggingface') storageFields.hfPath = row.storage_key;
    else if (storage === 'webdav') storageFields.webdavPath = row.storage_key;
    else if (storage === 'github') storageFields.githubStorageKey = row.storage_key;
  }

  let extra = {};
  if (row.storage_extra) {
    try {
      extra = JSON.parse(row.storage_extra) || {};
    } catch {
      /* 脏数据忽略 */
    }
  }

  const metadata = {
    fileName: row.file_name,
    fileSize: Number(row.file_size) || 0,
    TimeStamp: row.uploaded_at,
    storageType: storage,
    storage,
    folderPath: row.folder_path || '',
    ListType: row.list_type || 'None',
    Label: row.label || 'None',
    liked: Boolean(row.liked),
    shareDownloadCount: Number(row.share_download_count) || 0,
    ...storageFields,
    ...extra,
  };

  if (row.share_slug) metadata.shareSlug = row.share_slug;
  if (row.share_password_salt) metadata.sharePasswordSalt = row.share_password_salt;
  if (row.share_password_hash) metadata.sharePasswordHash = row.share_password_hash;
  if (row.share_expires_at) metadata.shareExpiresAt = row.share_expires_at;
  if (row.share_max_downloads) metadata.shareMaxDownloads = row.share_max_downloads;

  // `name` 必须是 kvKey：下游 buildShareRecord / 下载定位都依赖它，
  // 回退到裸 ID 会让分享链接指不到文件。
  return { name: kvKey || id, metadata };
}

/**
 * 【新函数】列出一页文件（D1 优先，未绑定返回 disabled 让调用方回落 KV）。
 *
 * 返回体刻意保持中立：不套 `normalizeKey`，因为归一化（storageType /
 * fileType / folderPath 推导）是 `file-list.js` 的职责，放在数据层会造成
 * 两处规则漂移 —— 正是 `file-list.js` 文件头注释里担心的那种幽灵条目。
 *
 * @param {any} env
 * @param {{
 *   storage?: string,
 *   folderPath?: string,
 *   limit?: number,
 *   offset?: number,
 *   sort?: string
 * }} options
 * @returns {Promise<{files: Array<{name: string, metadata: object}>, total: number, disabled?: boolean}>}
 */
export async function listRecordsPage(env, options = {}) {
  if (!isD1Enabled(env)) return { files: [], total: 0, disabled: true };

  const page = await listFileRecords(env, options);
  if (page.error !== undefined || page.disabled) {
    // 查询失败也回落 KV —— 宁可慢一点列出文件，也不能让面板空白
    return { files: [], total: 0, disabled: true, error: page.error };
  }

  return {
    files: (page.rows || []).map(d1FileToKey),
    total: page.total || 0,
  };
}

/**
 * 【新函数】不限量拉取全部文件（供统计 / 文件夹树 / 分享总览使用）。
 *
 * 内部按 200 一批翻页（D1 单次 LIMIT 上限），避免一次查询拉爆内存。
 * D1 未绑定时返回 `{ disabled: true }`，调用方回落 `listAllKeys`。
 *
 * @param {any} env
 * @param {{storage?: string, sort?: string, batchSize?: number}} options
 * @returns {Promise<{files: Array, total: number, disabled?: boolean}>}
 */
export async function listAllRecords(env, options = {}) {
  if (!isD1Enabled(env)) return { files: [], total: 0, disabled: true };

  const batchSize = Math.min(Math.max(Number(options.batchSize) || 200, 1), 200);
  const files = [];
  let offset = 0;
  let total = null;

  // 上限保护：即使数据异常也不会无限循环
  for (let guard = 0; guard < 10000; guard += 1) {
    // 注意：这里直接调 listFileRecords（返回原始行），不能走 listRecordsPage ——
    // 后者也会转换形状，套两层会让 offset 推进与 raw 行数脱钩。
    const page = await listFileRecords(env, { ...options, limit: batchSize, offset });
    if (page.error !== undefined || page.disabled) {
      return { files: [], total: 0, disabled: true, error: page.error };
    }
    if (total === null) total = page.total || 0;

    const rows = page.rows || [];
    if (!rows.length) break;

    files.push(...rows.map(d1FileToKey));
    offset += rows.length;
    if (offset >= (page.total || 0)) break;
  }

  return { files, total: total || files.length };
}

// ============================================================================
// 写入侧
// ============================================================================

/**
 * 登记一条文件记录到 D1（主源）。
 *
 * 【新函数】供各上传点在写完 KV 元数据后调用。拿完整 metadata 直接入库，
 * 不回读 KV（零额外读）。
 *
 * @param {any} env
 * @param {string} kvKey - 实际 KV key（如 `r2:xxx.png`）
 * @param {object} metadata - 与 KV metadata 同结构
 * @param {{indexId?: string, prefixes?: string[]}} options
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function registerFileRecord(env, kvKey, metadata, options = {}) {
  if (!isD1Enabled(env) || !kvKey || !metadata) {
    return { ok: false, error: 'd1-disabled' };
  }
  const prefixes = Array.isArray(options.prefixes) ? options.prefixes : STORAGE_PREFIXES;
  const id = options.indexId !== undefined
    ? String(options.indexId)
    : deriveIndexId(kvKey, prefixes);

  if (!id) return { ok: false, error: 'empty-id' };
  return putFileRecord(env, id, kvKey, metadata);
}

/**
 * 【兼容函数】历史用途是把「裸 ID → kvKey」写进 KV 索引键。
 * 兼容语义（重要）：
 *   · D1 未绑定          → no-op（历史行为：只写 KV 索引，D1 模式下无意义）
 *   · D1 已绑定 + 传了 metadata → 直接写 D1，零额外读
 *   · D1 已绑定 + 未传 metadata → **自动回读 KV 记录**再写 D1
 *     （多一次 KV 读，但让上传点无需改动结构 —— 只改函数名即可）
 *
 * ⚠️ 上传点的 KV 元数据写入必须在调用本函数**之前**完成，
 *    否则回读会拿到空记录（此时静默跳过并告警，不影响上传主流程）。
 *
 * @param {any} env
 * @param {string} kvKey
 * @param {{prefixes?: string[], indexId?: string, metadata?: object}} options
 */
export async function putRecordIndex(env, kvKey, options = {}) {
  if (!isD1Enabled(env) || !kvKey) return;

  // 快路径：metadata 已在手边，直接写
  if (options && options.metadata) {
    await registerFileRecord(env, kvKey, options.metadata, options);
    return;
  }

  // 慢路径：回读 KV 拿 metadata（上传点未传 metadata 时走这里）
  if (!env?.img_url) return;
  try {
    const rec = await env.img_url.getWithMetadata(String(kvKey));
    if (!rec?.metadata) {
      console.warn('putRecordIndex: no KV metadata for', kvKey, '- skipped D1 registration');
      return;
    }
    await registerFileRecord(env, kvKey, rec.metadata, options);
  } catch (error) {
    console.warn('putRecordIndex: KV re-read failed for', kvKey, '-', error?.message || error);
  }
}

/**
 * 【兼容函数】删除索引键。D1 模式下 no-op（索引即主键）。
 * @param {any} env
 * @param {string} fileId
 */
export async function deleteRecordIndex(env, fileId) {
  // 兼容层：D1 无独立索引，无需清理。
  // 真正删除记录由 deleteFileRecord 完成（见 manage/delete）。
  return;
}

/**
 * 【新函数】删除 D1 中的文件记录（含计数，随行删除）。
 * @param {any} env
 * @param {string} id - 裸 ID
 * @returns {Promise<boolean>}
 */
export async function removeFileRecord(env, id) {
  return deleteFileRecord(env, id);
}

// ============================================================================
// 读取侧
// ============================================================================

/**
 * 带 D1 优先的记录定位。
 *
 * 行为契约（**返回值形状与历史版本逐字段一致**）：
 *   - D1 已绑定 → 先查 D1；命中即返回；未命中回落 KV 前缀探测
 *   - D1 未绑定 → 直接走 KV 前缀探测（与历史版本完全一致）
 *   - 找不到    → 返回 { record: null, kvKey: fileId }
 *
 * @param {any} env
 * @param {string} fileId
 * @param {{
 *   prefixes?: string[],
 *   forceAll?: boolean,
 *   skipIndex?: boolean,   // 兼容旧参数；D1 模式下表示"跳过 D1 直查 KV"
 *   onIndexHit?: (info: {indexed: boolean, kvKey: string}) => void
 * }} options
 * @returns {Promise<{record: any, kvKey: string}>}
 */
export async function getRecordWithKey(env, fileId, options = {}) {
  const value = String(fileId || '');
  const prefixes = Array.isArray(options.prefixes) ? options.prefixes : STORAGE_PREFIXES;

  // ---------- 路径 A：D1 优先 ----------
  if (isD1Enabled(env) && !options.skipIndex) {
    const id = deriveIndexId(value, prefixes);
    const hit = await getFileRecord(env, id);
    if (hit) {
      if (typeof options.onIndexHit === 'function') {
        options.onIndexHit({ indexed: true, kvKey: hit.kvKey });
      }
      return hit;
    }
    // miss → 继续走 KV 兜底（D1 写入失败 / 记录尚未登记）
  }

  if (!env?.img_url) return { record: null, kvKey: value };

  // ---------- 路径 B：带前缀，直查 KV ----------
  if (hasStoragePrefix(value, prefixes) && !options.forceAll) {
    const record = await env.img_url.getWithMetadata(value);
    if (record?.metadata) {
      return { record, kvKey: value };
    }
    return { record: null, kvKey: value };
  }

  // ---------- 路径 C：裸 ID，并发探测 KV ----------
  // 候选集合与命中优先级沿用原有语义与顺序；并发只改变等待方式。
  const candidateKeys = buildCandidateKeys(value, {
    prefixes,
    forceAll: options.forceAll === true,
  });
  const probed = await Promise.all(
    candidateKeys.map((key) => env.img_url.getWithMetadata(key).catch(() => null))
  );

  const hitIndex = probed.findIndex((record) => record?.metadata);
  if (hitIndex !== -1) {
    const key = candidateKeys[hitIndex];
    if (typeof options.onIndexHit === 'function') {
      options.onIndexHit({ indexed: false, kvKey: key });
    }
    return { record: probed[hitIndex], kvKey: key };
  }

  if (typeof options.onIndexHit === 'function') {
    options.onIndexHit({ indexed: false, kvKey: value });
  }
  return { record: null, kvKey: value };
}

// ============================================================================
// 下载计数
// ============================================================================

/**
 * 读取分享下载计数。
 *
 * D1 已绑定时优先读表内字段；未绑定回落到 KV 的 `dlc:` 键（历史兼容）。
 *
 * @param {any} env
 * @param {string} kvKey
 * @param {object} metadata
 * @param {{prefixes?: string[]}} options
 * @returns {Promise<number>}
 */
export async function readDownloadCount(env, kvKey, metadata = {}, options = {}) {
  const fallback = Number(metadata?.shareDownloadCount || 0) || 0;
  if (!kvKey) return fallback;

  // D1 优先
  if (isD1Enabled(env)) {
    const prefixes = Array.isArray(options.prefixes) ? options.prefixes : STORAGE_PREFIXES;
    const id = deriveIndexId(kvKey, prefixes);
    const hit = await getFileRecord(env, id);
    if (hit?.record?.metadata) {
      return Number(hit.record.metadata.shareDownloadCount || 0) || 0;
    }
  }

  // KV 兜底
  if (!env?.img_url) return fallback;
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
 * 递增分享下载计数。
 *
 * ⚠️ 本函数是**非原子的**「读 → +1 → 写」语义，仅为函数签名兼容而保留。
 *    并发场景下会丢计数。**新代码请改用 tryConsumeDownload()**（原子）。
 *
 * D1 已绑定时走 UPDATE ... SET count = count + 1（数据库层原子，不丢）；
 * 未绑定时回落 KV 的 read-modify-write（旧行为）。
 *
 * @param {any} env
 * @param {string} kvKey
 * @param {object} metadata
 * @param {number} ttlSeconds - 仅 KV 兜底路径使用
 * @param {{prefixes?: string[]}} options
 */
export async function incrementDownloadCount(env, kvKey, metadata = {}, ttlSeconds = 60 * 60 * 24 * 30, options = {}) {
  if (!kvKey) return;

  // D1 优先：原子自增（无限次配额校验，仅递增）
  if (isD1Enabled(env)) {
    const prefixes = Array.isArray(options.prefixes) ? options.prefixes : STORAGE_PREFIXES;
    const id = deriveIndexId(kvKey, prefixes);
    const res = await tryConsumeDownload(env, id);
    if (res.ok || res.limited) return;   // 已处理（含超限），无需回落
    // disabled / notFound → 回到 KV 兜底
  }

  // KV 兜底（旧行为）
  if (!env?.img_url) return;
  const current = await readDownloadCount(env, kvKey, metadata, options);
  await env.img_url.put(`${DOWNLOAD_COUNT_PREFIX}${kvKey}`, String(current + 1), {
    expirationTtl: ttlSeconds,
  });
}

/**
 * 【兼容函数】清理下载计数键。D1 模式下 no-op（计数随记录删除）。
 * @param {any} env
 * @param {string} kvKey
 */
export async function deleteDownloadCount(env, kvKey) {
  // D1 模式：计数在 files 表内，随 removeFileRecord 一并删除。
  // 仅在未绑定 D1 且 KV 中确实存在 dlc: 键时，才做兼容清理。
  if (isD1Enabled(env)) return;
  if (!env?.img_url || !kvKey) return;
  try {
    await env.img_url.delete(`${DOWNLOAD_COUNT_PREFIX}${kvKey}`);
  } catch (error) {
    console.warn('Failed to delete download count:', error?.message || error);
  }
}

// ============================================================================
// 暴露给下载鉴权路径的原子消费接口（供 file/[[path]].js 后续接入）
// ============================================================================

/**
 * 原子消费一次下载配额。
 *
 * 调用方拿到 `{ ok, limited, notFound, disabled }` 后：
 *   · ok=true        → 放行，配额已扣减
 *   · limited=true   → 返回 410（已达上限）
 *   · notFound/disabled → 回落原有 KV 两步逻辑
 *
 * @param {any} env
 * @param {string} kvKey
 * @param {{prefixes?: string[]}} options
 * @returns {Promise<{ok: boolean, disabled?: boolean, notFound?: boolean, limited?: boolean, count?: number}>}
 */
export async function consumeDownloadQuota(env, kvKey, options = {}) {
  if (!isD1Enabled(env) || !kvKey) return { ok: false, disabled: true };
  const prefixes = Array.isArray(options.prefixes) ? options.prefixes : STORAGE_PREFIXES;
  const id = deriveIndexId(kvKey, prefixes);
  return tryConsumeDownload(env, id);
}

/**
 * 补回一次预占的下载配额（原子 -1，下限 0）。
 *
 * 场景：`verifyShareAccess` 用 D1 原子预占了配额，但最终响应属于
 * 不该计数的情况（404 路径不存在 / 上游 5xx），需把这次预占退回。
 *
 * @param {any} env
 * @param {string} kvKey
 * @param {{prefixes?: string[]}} options
 * @returns {Promise<{ok: boolean}>}
 */
export async function refundQuota(env, kvKey, options = {}) {
  if (!isD1Enabled(env) || !kvKey) return { ok: false };
  const prefixes = Array.isArray(options.prefixes) ? options.prefixes : STORAGE_PREFIXES;
  const id = deriveIndexId(kvKey, prefixes);
  return refundDownloadQuota(env, id);
}

// ============================================================================
// 文件夹操作（D1 优先；未绑定时由调用方回落原有 KV 逻辑）
// ============================================================================
//
// 这批函数的定位是「D1 可用时的替换实现」：全部返回 `{disabled: true}` 或
// `{ok: false, disabled: true}` 作为「请走 KV 老路」的信号，
// 由 folders.js 决定何时回落。数据层不擅自决定策略。

/**
 * 取文件夹统计（D1 版，直接给出 buildFolderNodes 所需的 folders 映射）。
 * @param {any} env
 * @returns {Promise<{folders: object, disabled?: boolean}>}
 */
export async function listFolderStats(env) {
  if (!isD1Enabled(env)) return { folders: {}, disabled: true };
  return folderFileCounts(env);
}

/**
 * 取文件夹标记列表（用于判断目录是否存在、是否有子目录）。
 * @param {any} env
 * @returns {Promise<{folders: Array, disabled?: boolean}>}
 */
export async function listMarkers(env) {
  if (!isD1Enabled(env)) return { folders: [], disabled: true };
  return listFolderMarkers(env);
}

/** 新建 / 更新文件夹标记。@returns D1 不可用时 `{ok:false, disabled:true}` */
export async function ensureFolderMarker(env, path) {
  if (!isD1Enabled(env) || !path) return { ok: false, disabled: true };
  return upsertFolderMarker(env, path);
}

/** 删除文件夹标记（可选递归删子目录标记）。 */
export async function removeFolderMarkers(env, path, recursive = false) {
  if (!isD1Enabled(env) || !path) return { count: 0, disabled: true };
  const count = await deleteFolderMarkers(env, path, recursive);
  return { count };
}

/**
 * 移动 / 重命名目录树（文件 + 标记一并改写 folder_path）。
 * @returns D1 不可用时 `{disabled:true}`，调用方回落 KV 逐条改写
 */
export async function moveFolder(env, sourcePath, targetPath) {
  if (!isD1Enabled(env) || !sourcePath || !targetPath) {
    return { disabled: true, updatedFiles: 0, updatedMarkers: 0 };
  }
  return moveFolderTree(env, sourcePath, targetPath);
}

/** 把目录（含子目录）内文件的 folder_path 置空（移回根目录，不删文件）。 */
export async function clearFolder(env, path, recursive = false) {
  if (!isD1Enabled(env) || !path) return { count: 0, disabled: true };
  const count = await clearFolderPath(env, path, recursive);
  return { count };
}

/**
 * 判断目录下是否还有文件或子目录（用于非递归删除的前置校验）。
 * @returns D1 不可用时 `{disabled:true}`
 */
export async function folderHasContent(env, path) {
  if (!isD1Enabled(env) || !path) return { disabled: true };

  try {
    const likePattern = escapeLikePath(path) + '/%';

    const files = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM files
        WHERE is_folder = 0
          AND (folder_path = ? OR folder_path LIKE ? ESCAPE '\\')`
    ).bind(path, likePattern).first();

    const childMarkers = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM files
        WHERE is_folder = 1
          AND folder_path LIKE ? ESCAPE '\\'`
    ).bind(likePattern).first();

    return {
      hasFiles: (files?.n || 0) > 0,
      hasChildFolders: (childMarkers?.n || 0) > 0,
    };
  } catch (error) {
    console.warn('D1 folderHasContent failed:', error?.message || error);
    return { disabled: true, error: error?.message };
  }
}

/** 转义 LIKE 特殊字符（与 metadata-d1.js 中的实现保持一致）。 */
function escapeLikePath(value) {
  return String(value).replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/**
 * 【新函数】列出所有「已开启分享」的文件记录（D1 版）。
 *
 * 与 KV 版的区别：这里直接让 SQL 过滤「有分享配置」的行，
 * 且 `share_download_count` 随行返回 —— 调用方不必再为每个限次分享
 * 单独读一次计数键（KV 版要分批并发读 dlc:，文件多了就是 N 次往返）。
 *
 * ⚠️ 过滤条件刻意与 `hasActiveShare()` 对齐：只认「真正的分享配置」。
 *    不能简单写成「share_* 任一非空」—— revoke 之后残留的
 *    share_download_count 不应让条目继续出现在分享列表里。
 *
 * @param {any} env
 * @returns {Promise<{files: Array<{name: string, metadata: object}>, disabled?: boolean}>}
 */
export async function listSharedRecords(env) {
  if (!isD1Enabled(env)) return { files: [], disabled: true };

  try {
    // 与 share-options.js 的 hasActiveShare 语义保持一致：
    //   有 slug，或 有密码，或 有过期时间，或 有限次 —— 四者任一即视为开启分享
    const rows = await env.DB.prepare(
      `SELECT * FROM files
        WHERE is_folder = 0
          AND file_name IS NOT NULL AND file_name != ''
          AND (
            share_slug IS NOT NULL
            OR share_password_hash IS NOT NULL
            OR (share_expires_at IS NOT NULL AND share_expires_at > 0)
            OR (share_max_downloads IS NOT NULL AND share_max_downloads > 0)
          )
        ORDER BY uploaded_at DESC`
    ).all();

    return { files: (rows?.results || []).map(d1FileToKey) };
  } catch (error) {
    console.warn('D1 listSharedRecords failed:', error?.message || error);
    return { files: [], disabled: true, error: error?.message };
  }
}

/**
 * 【新函数】按目录列举文件（D1 版，供「实时文件夹分享」使用）。
 *
 * 语义与 KV 版的 `listFolderMembersLive` 的过滤逻辑严格对齐：
 *   · folderPath === ''  → 根目录（folder_path 为 NULL），includeSubfolders
 *     为真时涵盖全部文件
 *   · 否则               → 精确匹配该目录，或（勾选时）匹配其所有子目录
 *
 * 返回的每条都经 `d1FileToKey` 转换，形状与 KV `getWithMetadata` 一致，
 * 调用方无需区分数据源。
 *
 * @param {any} env
 * @param {string} folderPath - 已归一化的目录路径（'' 表示根目录）
 * @param {boolean} includeSubfolders
 * @returns {Promise<{files: Array<{name: string, metadata: object}>, disabled?: boolean}>}
 */
export async function listRecordsInFolder(env, folderPath, includeSubfolders = false) {
  if (!isD1Enabled(env)) return { files: [], disabled: true };

  const normalized = String(folderPath || '');
  let sql = `SELECT * FROM files
              WHERE is_folder = 0
                AND file_name IS NOT NULL AND file_name != ''`;
  const params = [];

  if (normalized === '') {
    // 根目录：仅当不勾选子目录时限定 folder_path 为空
    if (!includeSubfolders) {
      sql += ' AND (folder_path IS NULL OR folder_path = \'\')';
    }
    // 勾选子目录时不加条件 —— 涵盖全部文件
  } else if (includeSubfolders) {
    sql += " AND (folder_path = ? OR folder_path LIKE ? ESCAPE '\\')";
    params.push(normalized, escapeLikePath(normalized) + '/%');
  } else {
    sql += ' AND folder_path = ?';
    params.push(normalized);
  }

  sql += ' ORDER BY uploaded_at DESC';

  try {
    const rows = await env.DB.prepare(sql).bind(...params).all();
    return { files: (rows?.results || []).map(d1FileToKey) };
  } catch (error) {
    console.warn('D1 listRecordsInFolder failed:', error?.message || error);
    return { files: [], disabled: true, error: error?.message };
  }
}
