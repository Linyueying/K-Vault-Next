/**
 * 元数据访问层（D1）— file-record.js 的 D1 版本，并列存在、可逐点切换。
 *
 * ============================================================================
 * 设计原则
 * ============================================================================
 *
 * 1. **形状兼容**：getRecord() 返回 `{ record: { metadata }, kvKey }`，
 *    与 `file-record.js` 的 getRecordWithKey() 逐字段一致。调用方（file/[[path]].js、
 *    v1/upload.js、manage/*）无需改动安全分支即可切换。
 *
 * 2. **开关回落**：所有函数先看 `isD1Enabled(env)`。D1 未绑定（env.DB 不存在）
 *    时：查询类返回 null（调用方回落到 KV），写入类静默 no-op。
 *    这让代码可以先合进仓库、跑在纯 KV 环境上而零影响；绑上 D1 后自动生效。
 *
 * 3. **计数原子化**：下载计数**绝不** read-modify-write。
 *    用单条 `UPDATE ... SET share_download_count = share_download_count + 1
 *    WHERE ... AND (max=0 OR count < max)` 同时完成「校验 + 扣减」，
 *    既消除并发丢计数，又消除并发超发（原 KV 实现两步分离，两者都会出问题）。
 *
 * 4. **去重靠约束**：`INSERT ... ON CONFLICT(content_sha) DO NOTHING`，
 *    由 SQLite 唯一索引保证，无竞态窗口。
 *
 * 5. **不参与鉴权**：本模块只做数据读写，block/whitelist/密码判断仍在调用方。
 *    唯一例外是 tryConsumeDownload() —— 它必须原子地「校验并扣减」，
 *    这是数据层的职责，不是绕过鉴权。
 *
 * ============================================================================
 * 迁移期策略（方案 A：D1 为唯一计数源）
 * ============================================================================
 *   - 下载计数：D1 单源。存量 `dlc:` 计数在迁移脚本里一次性搬运后弃用。
 *   - 文件记录：双写过渡（KV + D1），读路径先 D1、miss 回落 KV。
 *   - 详见各函数注释。
 */

/** D1 是否可用（绑定名 DB，与 .env.example / wrangler 配置保持一致）。 */
export function isD1Enabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
}

/** 当前毫秒时间戳。 */
function now() {
  return Date.now();
}

/**
 * 把 D1 行映射成 KV getWithMetadata 的形状。
 *
 * 调用方看到的是 `{ metadata: {...}, ... }`，与 KV 返回结构一致，
 * 因此 `record.metadata.fileName` 这类访问无需改写。
 *
 * @param {object|null} row - D1 查询结果行
 * @returns {{metadata: object}|null}
 */
export function rowToRecord(row) {
  if (!row) return null;

  const metadata = {
    TimeStamp: row.uploaded_at,
    fileName: row.file_name,
    fileSize: row.file_size,
    storageType: row.storage,
    storage: row.storage,
    folderPath: row.folder_path || undefined,
    ListType: row.list_type || 'None',
    Label: row.label || 'None',
    liked: Boolean(row.liked),
    shareDownloadCount: row.share_download_count,
  };

  // 存储定位字段：按存储类型还原成原有字段名，兼容既有读取点
  if (row.storage_key) {
    if (row.storage === 'r2') metadata.r2Key = row.storage_key;
    else if (row.storage === 's3') metadata.s3Key = row.storage_key;
    else if (row.storage === 'huggingface') metadata.hfPath = row.storage_key;
    else if (row.storage === 'webdav') metadata.webdavPath = row.storage_key;
    else if (row.storage === 'github') metadata.githubStorageKey = row.storage_key;
  }

  // storage_extra：discord 等存储的附加定位信息
  if (row.storage_extra) {
    try {
      Object.assign(metadata, JSON.parse(row.storage_extra));
    } catch {
      /* 脏数据忽略，不影响主记录 */
    }
  }

  // 分享设置
  if (row.share_slug) metadata.shareSlug = row.share_slug;
  if (row.share_password_salt) metadata.sharePasswordSalt = row.share_password_salt;
  if (row.share_password_hash) metadata.sharePasswordHash = row.share_password_hash;
  if (row.share_expires_at) metadata.shareExpiresAt = row.share_expires_at;
  if (row.share_max_downloads) metadata.shareMaxDownloads = row.share_max_downloads;

  return { metadata };
}

/**
 * 从 metadata 对象反推 D1 列值。
 *
 * storage_key 的取值有两条路：
 *   1. 优先取 metadata 里存储类型对应的字段（r2Key / s3Key / hfPath / ...）
 *   2. 缺失时，从 kvKey 剥离存储前缀推导（如 `r2:xxx.png` → `xxx.png`）
 *     —— 兜住"调用方只传 kvKey 没传 storageKey 字段"的情况，
 *        避免下载时定位不到对象。
 *
 * @param {object} metadata
 * @param {string} [kvKey] - 实际 KV key，用于兜底推导存储键
 * @returns {object} 列名 → 值
 */
function metadataToColumns(metadata = {}, kvKey = '') {
  const folderMarker = metadata.folderMarker === true
    || String(kvKey || '').startsWith('folder:');
  const storage = folderMarker
    ? 'folder'
    : String(metadata.storageType || metadata.storage || 'telegram').toLowerCase();

  // 存储定位键：按类型取对应字段
  let storageKey = null;
  if (folderMarker) storageKey = null;
  else if (storage === 'r2') storageKey = metadata.r2Key || null;
  else if (storage === 's3') storageKey = metadata.s3Key || null;
  else if (storage === 'huggingface') storageKey = metadata.hfPath || null;
  else if (storage === 'webdav') storageKey = metadata.webdavPath || null;
  else if (storage === 'github') storageKey = metadata.githubStorageKey || null;
  else if (storage === 'discord') storageKey = metadata.discordMessageId || null;

  // 兜底：从 kvKey 剥离前缀推导（`r2:xxx.png` → `xxx.png`）
  // 文件夹标记的 kvKey 形如 `folder:<path>`，剥离后是路径，**不能**当 storage_key
  if (!storageKey && kvKey && !folderMarker) {
    const key = String(kvKey);
    const colon = key.indexOf(':');
    storageKey = colon >= 0 ? key.slice(colon + 1) : key;
  }

  // discord 类附加字段打包进 storage_extra
  let storageExtra = null;
  const extra = {};
  for (const k of [
    'discordChannelId', 'discordMessageId', 'discordAttachmentId',
    'discordUploadMode', 'discordSourceUrl', 'webdavEtag',
    'telegramFileId', 'telegramMessageId',
  ]) {
    if (metadata[k] !== undefined && metadata[k] !== null) extra[k] = metadata[k];
  }
  if (Object.keys(extra).length) storageExtra = JSON.stringify(extra);

  return {
    is_folder: folderMarker ? 1 : 0,
    storage,
    storage_key: storageKey,
    storage_extra: storageExtra,
    // 文件夹标记无文件名，但 file_name 列为 NOT NULL，
    // 用路径填充（同时让列表查询的 file_name != '' 过滤自然排除标记行）
    file_name: folderMarker
      ? (metadata.folderPath || String(kvKey || '').slice('folder:'.length) || 'folder')
      : String(metadata.fileName || 'unknown'),
    file_size: Number(metadata.fileSize || 0),
    mime: metadata.mime || metadata.contentType || null,
    folder_path: folderMarker
      ? (metadata.folderPath || String(kvKey || '').slice('folder:'.length) || null)
      : (metadata.folderPath || null),
    uploaded_at: Number(metadata.TimeStamp || now()),
    content_sha: metadata.contentSha || metadata.sha256 || null,
    list_type: metadata.ListType || 'None',
    label: metadata.Label || 'None',
    liked: metadata.liked ? 1 : 0,
    share_slug: metadata.shareSlug || null,
    share_password_salt: metadata.sharePasswordSalt || null,
    share_password_hash: metadata.sharePasswordHash || null,
    share_expires_at: metadata.shareExpiresAt || null,
    share_max_downloads: Number(metadata.shareMaxDownloads || 0),
  };
}

/**
 * 写入 / 更新一条文件记录（upsert）。
 *
 * 迁移期双写：本函数由调用方在「写完 KV 之后」调用，D1 写入失败不抛出，
 * 只告警 —— 绝不让元数据镜像拖垮主上传流程。
 *
 * @param {any} env
 * @param {string} id - 裸 ID（主键）
 * @param {string} kvKey - 原 KV key，兼容保留
 * @param {object} metadata - 与 KV metadata 同结构
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function putFileRecord(env, id, kvKey, metadata) {
  if (!isD1Enabled(env) || !id) return { ok: false, error: 'd1-disabled' };

  const c = metadataToColumns(metadata, kvKey);
  const ts = now();

  try {
    await env.DB.prepare(
      `INSERT INTO files (
         id, kv_key, is_folder, storage, storage_key, storage_extra,
         file_name, file_size, mime, folder_path, uploaded_at, content_sha,
         list_type, label, liked,
         share_slug, share_password_salt, share_password_hash,
         share_expires_at, share_max_downloads,
         created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         kv_key = excluded.kv_key,
         is_folder = excluded.is_folder,
         storage = excluded.storage,
         storage_key = excluded.storage_key,
         storage_extra = excluded.storage_extra,
         file_name = excluded.file_name,
         file_size = excluded.file_size,
         mime = excluded.mime,
         folder_path = excluded.folder_path,
         uploaded_at = excluded.uploaded_at,
         content_sha = excluded.content_sha,
         list_type = excluded.list_type,
         label = excluded.label,
         liked = excluded.liked,
         share_slug = excluded.share_slug,
         share_password_salt = excluded.share_password_salt,
         share_password_hash = excluded.share_password_hash,
         share_expires_at = excluded.share_expires_at,
         share_max_downloads = excluded.share_max_downloads,
         updated_at = excluded.updated_at`
    ).bind(
      id, kvKey || null, c.is_folder, c.storage, c.storage_key, c.storage_extra,
      c.file_name, c.file_size, c.mime, c.folder_path, c.uploaded_at, c.content_sha,
      c.list_type, c.label, c.liked,
      c.share_slug, c.share_password_salt, c.share_password_hash,
      c.share_expires_at, c.share_max_downloads,
      ts, ts
    ).run();

    return { ok: true };
  } catch (error) {
    // 唯一索引冲突（同 slug / 同 sha 被别的记录占用）等，交由调用方决定是否致命
    return { ok: false, error: error?.message || 'd1-write-failed' };
  }
}

/**
 * 按裸 ID 读取记录，返回与 file-record.js 同形状。
 * @param {any} env
 * @param {string} id
 * @returns {Promise<{record: {metadata: object}, kvKey: string}|null>}
 */
export async function getFileRecord(env, id) {
  if (!isD1Enabled(env) || !id) return null;

  try {
    const row = await env.DB.prepare(
      'SELECT * FROM files WHERE id = ? LIMIT 1'
    ).bind(String(id)).first();

    if (!row) return null;
    return { record: rowToRecord(row), kvKey: row.kv_key || String(id) };
  } catch (error) {
    console.warn('D1 getFileRecord failed:', error?.message || error);
    return null;
  }
}

/**
 * 原子消费一次下载配额。
 *
 * ## 为什么必须这样写
 *
 * 原 KV 实现是两步：先 readDownloadCount() 读、判断是否超限；再 +1 写回。
 * 并发下会同时出两个问题：
 *   · 丢计数：两个请求读到同一个旧值，都写回 +1，实际只涨了 1
 *   · 超发：两个请求都通过「未超限」判断，明明限 1 次却都放行
 *
 * 本函数把它们压成**一条 UPDATE**：数据库层面串行化，
 * `share_download_count < share_max_downloads` 的判定与自增在同一原子操作内，
 * 两个问题一并消失。
 *
 * @param {any} env
 * @param {string} id - 裸 ID
 * @returns {Promise<{ok: boolean, disabled?: boolean, notFound?: boolean, limited?: boolean, count?: number}>}
 *   ok=true       消费成功
 *   limited=true  已达上限（调用方应返回 410）
 *   notFound=true D1 里没有该记录（调用方回落 KV 逻辑）
 *   disabled=true D1 未启用（调用方回落 KV 逻辑）
 */
export async function tryConsumeDownload(env, id) {
  if (!isD1Enabled(env) || !id) return { ok: false, disabled: true };

  try {
    // 一条语句完成「存在性 + 未超限 + 自增」。
    // WHERE 同时包含 max 判定，超限时 changes=0 且不会误增。
    const result = await env.DB.prepare(
      `UPDATE files
          SET share_download_count = share_download_count + 1,
              updated_at = ?
        WHERE id = ?
          AND (share_max_downloads = 0 OR share_download_count < share_max_downloads)`
    ).bind(now(), String(id)).run();

    const changed = result?.meta?.changes ?? result?.changes ?? 0;
    if (changed > 0) return { ok: true };

    // 没改动：要么记录不存在，要么已超限。需要一次读来区分，
    // 但只在「没改动」这条冷路径上发生，热路径（正常下载）依然 1 次写。
    const row = await env.DB.prepare(
      'SELECT share_max_downloads, share_download_count FROM files WHERE id = ? LIMIT 1'
    ).bind(String(id)).first();

    if (!row) return { ok: false, notFound: true };
    return {
      ok: false,
      limited: true,
      count: row.share_download_count,
    };
  } catch (error) {
    console.warn('D1 tryConsumeDownload failed:', error?.message || error);
    return { ok: false, disabled: true }; // 失败时回落 KV，不阻断下载
  }
}

/**
 * 补回一次预占的下载配额（原子 -1，下限 0）。
 *
 * 用于「D1 原子预占发生在响应生成前，但最终响应属于不该计数的情况」时回滚。
 * `MAX(share_download_count - 1, 0)` 保证不出现负数：即便并发下已经
 * 有别的请求正常计数，也不会把计数扣成负值。
 *
 * @param {any} env
 * @param {string} id - 裸 ID
 * @returns {Promise<{ok: boolean}>}
 */
export async function refundDownloadQuota(env, id) {
  if (!isD1Enabled(env) || !id) return { ok: false };

  try {
    await env.DB.prepare(
      `UPDATE files
          SET share_download_count = MAX(share_download_count - 1, 0),
              updated_at = ?
        WHERE id = ?`
    ).bind(now(), String(id)).run();
    return { ok: true };
  } catch (error) {
    console.warn('D1 refundDownloadQuota failed:', error?.message || error);
    return { ok: false };
  }
}

/**
 * 内容去重：若 content_sha 已存在，返回已存在的记录；否则返回 null。
 *
 * 读取侧用（上传前查重，命中则秒传）。
 * @param {any} env
 * @param {string} sha
 * @returns {Promise<{record: {metadata: object}, kvKey: string}|null>}
 */
export async function findByContentSha(env, sha) {
  if (!isD1Enabled(env) || !sha) return null;

  try {
    const row = await env.DB.prepare(
      'SELECT * FROM files WHERE content_sha = ? LIMIT 1'
    ).bind(String(sha)).first();

    if (!row) return null;
    return { record: rowToRecord(row), kvKey: row.kv_key || row.id };
  } catch (error) {
    console.warn('D1 findByContentSha failed:', error?.message || error);
    return null;
  }
}

/**
 * 列出文件（替代 KV 扫前缀 + cursor 分页）。
 *
 * 与 KV 版的关键差异：**SQL 分页取代全量拉取**。
 *   · KV 版：list() 翻完整个命名空间 → 内存过滤 → 切片分页
 *     （文件数 N 时每次请求都是 O(N) 次 KV list，成本与延迟线性增长）
 *   · D1 版：WHERE + ORDER BY + LIMIT/OFFSET 全部下推数据库
 *     （走索引，单页成本恒定）
 *
 * @param {any} env
 * @param {{
 *   storage?: string,
 *   folderPath?: string,
 *   limit?: number,
 *   offset?: number,
 *   sort?: 'timeasc'|'sizeasc'|'sizedesc'|'name'
 * }} options
 * @returns {Promise<{rows: object[], total: number, disabled?: boolean, error?: string}>}
 *   `rows` 为原始表行；调用方应经 file-record.js 的 d1FileToKey() 转换。
 */
export async function listFileRecords(env, options = {}) {
  if (!isD1Enabled(env)) return { rows: [], total: 0, disabled: true };

  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const offset = Math.max(Number(options.offset) || 0, 0);

  const where = [];
  const params = [];
  if (options.storage) { where.push('storage = ?'); params.push(String(options.storage)); }
  if (options.folderPath !== undefined) {
    // folderPath === '' 语义为"根目录"，对应表中 folder_path 为 NULL
    where.push('folder_path IS ?');
    params.push(options.folderPath === '' ? null : String(options.folderPath));
  }
  // 仅返回真实文件记录：
  //   · is_folder = 0 排除文件夹标记行（0002 迁移引入）
  //   · file_name 非空排除异常数据（正常写入路径不会产生）
  where.push('is_folder = 0');
  where.push("file_name IS NOT NULL AND file_name != ''");
  const whereSql = `WHERE ${where.join(' AND ')}`;

  // 排序白名单：绝不允许把外部输入拼进 SQL
  const SORTS = {
    timeasc: 'uploaded_at ASC',
    sizeasc: 'file_size ASC, uploaded_at DESC',
    sizedesc: 'file_size DESC, uploaded_at DESC',
    name: 'file_name ASC',
  };
  const orderBy = SORTS[String(options.sort || '').toLowerCase()] || 'uploaded_at DESC';

  try {
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM files ${whereSql}`
    ).bind(...params).first();

    const rows = await env.DB.prepare(
      `SELECT * FROM files ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    // 返回**原始行**而非展开后的扁平对象：
    // 形状转换（row → {name, metadata}）集中由 file-record.js 的 d1FileToKey()
    // 完成。若此处先展开一次、调用方再转一次，就会出现"字段名已经变了、
    // 再按列名读却读到 undefined"的双重转换 bug。
    return {
      rows: rows?.results || [],
      total: countRow?.n || 0,
    };
  } catch (error) {
    console.warn('D1 listFileRecords failed:', error?.message || error);
    return { rows: [], total: 0, error: error?.message };
  }
}

/**
 * 删除一条文件记录。
 * @param {any} env
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteFileRecord(env, id) {
  if (!isD1Enabled(env) || !id) return false;

  try {
    await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(String(id)).run();
    return true;
  } catch (error) {
    console.warn('D1 deleteFileRecord failed:', error?.message || error);
    return false;
  }
}

/**
 * 覆盖分享设置（密码 / 过期 / 限次 / slug）。
 * 只更新分享相关列，不触碰文件本体字段。
 *
 * @param {any} env
 * @param {string} id
 * @param {object} sharePatch - 形如 { shareSlug, sharePasswordSalt, ... }
 * @returns {Promise<{ok: boolean, conflict?: boolean, error?: string}>}
 */
export async function updateShareOptions(env, id, sharePatch = {}) {
  if (!isD1Enabled(env) || !id) return { ok: false, error: 'd1-disabled' };

  try {
    await env.DB.prepare(
      `UPDATE files SET
         share_slug = COALESCE(?, share_slug),
         share_password_salt = COALESCE(?, share_password_salt),
         share_password_hash = COALESCE(?, share_password_hash),
         share_expires_at = COALESCE(?, share_expires_at),
         share_max_downloads = COALESCE(?, share_max_downloads),
         updated_at = ?
       WHERE id = ?`
    ).bind(
      sharePatch.shareSlug ?? null,
      sharePatch.sharePasswordSalt ?? null,
      sharePatch.sharePasswordHash ?? null,
      sharePatch.shareExpiresAt ?? null,
      sharePatch.shareMaxDownloads ?? null,
      now(),
      String(id)
    ).run();

    return { ok: true };
  } catch (error) {
    const message = error?.message || '';
    // slug 唯一索引冲突
    if (message.includes('UNIQUE') || message.includes('idx_files_share_slug')) {
      return { ok: false, conflict: true, error: message };
    }
    return { ok: false, error: message };
  }
}

// ============================================================================
// 文件夹操作（0002 迁移引入 is_folder 列后启用）
// ============================================================================

/** 文件夹标记的 ID 统一为 `folder:<path>`，与 KV 时代的键名保持一致。 */
export function folderMarkerId(path) {
  return `folder:${path}`;
}

/**
 * 列出全部文件夹标记。
 * @param {any} env
 * @returns {Promise<{folders: Array<{id: string, path: string, kvKey: string}>, disabled?: boolean}>}
 */
export async function listFolderMarkers(env) {
  if (!isD1Enabled(env)) return { folders: [], disabled: true };

  try {
    const rows = await env.DB.prepare(
      `SELECT id, folder_path, kv_key FROM files
        WHERE is_folder = 1 AND folder_path IS NOT NULL AND folder_path != ''
        ORDER BY folder_path ASC`
    ).all();

    return {
      folders: (rows?.results || []).map((row) => ({
        id: row.id,
        path: row.folder_path,
        kvKey: row.kv_key || row.id,
      })),
    };
  } catch (error) {
    console.warn('D1 listFolderMarkers failed:', error?.message || error);
    return { folders: [], error: error?.message };
  }
}

/**
 * 按 folder_path 统计每个目录的文件数。
 *
 * 输出形状与 folders.js 的 `buildFolderSnapshot()` 的 `folders` 字段一致：
 *   { "<path>": { count, marker } }
 * 差别是这里由 SQL GROUP BY 一次算完，不再全量扫 KV。
 *
 * @param {any} env
 * @returns {Promise<{folders: object, disabled?: boolean}>}
 */
export async function folderFileCounts(env) {
  if (!isD1Enabled(env)) return { folders: {}, disabled: true };

  try {
    const rows = await env.DB.prepare(
      `SELECT folder_path AS path, COUNT(*) AS n
         FROM files
        WHERE is_folder = 0
          AND folder_path IS NOT NULL AND folder_path != ''
        GROUP BY folder_path`
    ).all();

    const folders = {};
    const touch = (path) => {
      if (!path) return null;
      if (!folders[path]) folders[path] = { count: 0, marker: false };
      return folders[path];
    };
    // 自身 + 所有父路径都要入表（父路径 count 可能为 0，但需作为节点出现）
    const includeAll = (path) => {
      const parts = String(path).split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i += 1) touch(parts.slice(0, i).join('/'));
    };

    for (const row of rows?.results || []) {
      const path = String(row.path || '');
      if (!path) continue;
      includeAll(path);
      const entry = touch(path);
      if (entry) entry.count += Number(row.n) || 0;
    }

    const markers = await listFolderMarkers(env);
    for (const marker of markers.folders || []) {
      const path = String(marker.path || '');
      if (!path) continue;
      includeAll(path);
      const entry = touch(path);
      if (entry) entry.marker = true;
    }

    return { folders };
  } catch (error) {
    console.warn('D1 folderFileCounts failed:', error?.message || error);
    return { folders: {}, error: error?.message };
  }
}

/**
 * 标记 / 更新一个文件夹（upsert `folder:<path>`）。
 * @param {any} env
 * @param {string} path - 归一化后的目录路径
 * @returns {Promise<{ok: boolean}>}
 */
export async function upsertFolderMarker(env, path) {
  if (!isD1Enabled(env) || !path) return { ok: false };
  return putFileRecord(env, folderMarkerId(path), folderMarkerId(path), {
    folderMarker: true,
    folderPath: path,
    TimeStamp: now(),
  });
}

/**
 * 删除文件夹标记及其（可选）所有子目录标记。
 * @param {any} env
 * @param {string} path
 * @param {boolean} recursive
 * @returns {Promise<number>} 删除行数
 */
export async function deleteFolderMarkers(env, path, recursive = false) {
  if (!isD1Enabled(env) || !path) return 0;

  try {
    if (recursive) {
      const res = await env.DB.prepare(
        `DELETE FROM files
          WHERE is_folder = 1
            AND (folder_path = ? OR folder_path LIKE ? ESCAPE '\\')`
      ).bind(path, escapeLike(path) + '/%').run();
      return changedCount(res);
    }
    const res = await env.DB.prepare(
      `DELETE FROM files WHERE is_folder = 1 AND folder_path = ?`
    ).bind(path).run();
    return changedCount(res);
  } catch (error) {
    console.warn('D1 deleteFolderMarkers failed:', error?.message || error);
    return 0;
  }
}

/**
 * 重命名 / 移动目录：把 sourcePath 及其所有子路径下的**文件和标记**
 * 的 folder_path 一次性改写为 targetPath 前缀。
 *
 * 相比 KV 版的优势：KV 需要逐个 `put` 每条记录（N 次网络往返），
 * 这里用两条 UPDATE 完成（文件一条、标记一条），与目录内文件数无关。
 *
 * @param {any} env
 * @param {string} sourcePath
 * @param {string} targetPath
 * @returns {Promise<{updatedFiles: number, updatedMarkers: number, error?: string}>}
 */
export async function moveFolderTree(env, sourcePath, targetPath) {
  if (!isD1Enabled(env) || !sourcePath || !targetPath) {
    return { updatedFiles: 0, updatedMarkers: 0 };
  }

  // substr(folder_path, sourcePath.length + 1) 取出 sourcePath 之后的剩余部分，
  // 再拼上 targetPath。用 substr 而非 replace()，避免路径中间恰好出现
  // 同名字符串时被误替换。
  const sql = `UPDATE files
       SET folder_path = ? || substr(folder_path, ?),
           updated_at = ?
     WHERE is_folder = ?
       AND (folder_path = ? OR folder_path LIKE ? ESCAPE '\\')`;
  const likePattern = escapeLike(sourcePath) + '/%';
  const ts = now();

  try {
    const files = await env.DB.prepare(sql)
      .bind(targetPath, sourcePath.length + 1, ts, 0, sourcePath, likePattern)
      .run();
    const markers = await env.DB.prepare(sql)
      .bind(targetPath, sourcePath.length + 1, ts, 1, sourcePath, likePattern)
      .run();

    // 标记的 id 与 kv_key 都内嵌了路径，必须同步改写；
    // 否则下次 upsertFolderMarker 会插入新 id，旧行残留成幽灵目录。
    await env.DB.prepare(
      `UPDATE files
          SET id = 'folder:' || folder_path,
              kv_key = 'folder:' || folder_path
        WHERE is_folder = 1
          AND (folder_path = ? OR folder_path LIKE ? ESCAPE '\\')`
    ).bind(targetPath, escapeLike(targetPath) + '/%').run();

    return {
      updatedFiles: changedCount(files),
      updatedMarkers: changedCount(markers),
    };
  } catch (error) {
    console.warn('D1 moveFolderTree failed:', error?.message || error);
    return { updatedFiles: 0, updatedMarkers: 0, error: error?.message };
  }
}

/**
 * 清空目录：把目录（含子目录）下所有文件的 folder_path 置空（移回根目录）。
 * 文件本体不删，与 KV 版语义一致。
 *
 * @param {any} env
 * @param {string} path
 * @param {boolean} recursive
 * @returns {Promise<number>} 受影响文件数
 */
export async function clearFolderPath(env, path, recursive = false) {
  if (!isD1Enabled(env) || !path) return 0;

  try {
    const res = recursive
      ? await env.DB.prepare(
          `UPDATE files SET folder_path = NULL, updated_at = ?
            WHERE is_folder = 0
              AND (folder_path = ? OR folder_path LIKE ? ESCAPE '\\')`
        ).bind(now(), path, escapeLike(path) + '/%').run()
      : await env.DB.prepare(
          `UPDATE files SET folder_path = NULL, updated_at = ?
            WHERE is_folder = 0 AND folder_path = ?`
        ).bind(now(), path).run();
    return changedCount(res);
  } catch (error) {
    console.warn('D1 clearFolderPath failed:', error?.message || error);
    return 0;
  }
}

/** 转义 LIKE 模式中的特殊字符（% _ \），配合 ESCAPE '\\' 使用。 */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/** 从 D1 run() 结果中取出受影响行数（兼容 meta.changes / changes 两种形状）。 */
function changedCount(res) {
  if (!res) return 0;
  if (res.meta && typeof res.meta.changes === 'number') return res.meta.changes;
  if (typeof res.changes === 'number') return res.changes;
  return 0;
}
