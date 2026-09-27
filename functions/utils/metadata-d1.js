import { ensureSchema } from './schema.js';
import { inferFileType } from './file-type.js';

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
    mime: row.mime || undefined,
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
  // 分享文案：允许为空，空即"回退默认标题 / 无描述"
  if (row.share_title) metadata.shareTitle = row.share_title;
  if (row.share_description) metadata.shareDescription = row.share_description;

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
    // 文件大类按扩展名推断后物化入库：让后台 stats 能一条 SQL 聚合出来，
    // 不必把全部行取回内存再数。判定复用 file-type.js，与列表侧同口径。
    file_type: inferFileType(kvKey, metadata),
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
    share_title: metadata.shareTitle || null,
    share_description: metadata.shareDescription || null,
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
  await ensureSchema(env);
  if (!isD1Enabled(env) || !id) return { ok: false, error: 'd1-disabled' };

  const c = metadataToColumns(metadata, kvKey);
  const ts = now();

  try {
    await env.DB.prepare(
      `INSERT INTO files (
         id, kv_key, is_folder, storage, storage_key, storage_extra, file_type,
         file_name, file_size, mime, folder_path, uploaded_at, content_sha,
         list_type, label, liked,
         share_slug, share_password_salt, share_password_hash,
         share_expires_at, share_max_downloads,
         share_title, share_description,
         created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         kv_key = excluded.kv_key,
         is_folder = excluded.is_folder,
         storage = excluded.storage,
         storage_key = excluded.storage_key,
         storage_extra = excluded.storage_extra,
         file_type = excluded.file_type,
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
         share_title = excluded.share_title,
         share_description = excluded.share_description,
         updated_at = excluded.updated_at`
    ).bind(
      id, kvKey || null, c.is_folder, c.storage, c.storage_key, c.storage_extra, c.file_type,
      c.file_name, c.file_size, c.mime, c.folder_path, c.uploaded_at, c.content_sha,
      c.list_type, c.label, c.liked,
      c.share_slug, c.share_password_salt, c.share_password_hash,
      c.share_expires_at, c.share_max_downloads,
      c.share_title, c.share_description,
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
  await ensureSchema(env);
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
 * 按自定义短链读取记录 —— `files.share_slug` 上有唯一索引，一次主键级查询即可。
 *
 * ## 为什么需要它
 *
 * 短链解析原先只有 KV 实现（`share-options.js` 的 `findShareSlugOwner`）：
 * 每次访问 `/s/<slug>` 都要读一次 `share_slug:<slug>`。**KV 读额度是
 * 10 万/天，D1 rows read 是 500 万/天** —— 短链是分享页的热路径，
 * 把它留在 KV 上等于拿最窄的那份额度去扛最高频的流量。
 *
 * 这里直接返回**整行记录**（而不是只返回 kvKey），调用方拿到后无需再
 * `getRecordWithKey()` 二次查询 —— 一次解析 = 一次 D1 读。
 *
 * ## 与 getFileRecord 的关系
 *
 * 形状完全一致（`{record, kvKey}` / `null`），因此 `share-info.js` 里两种
 * 解析结果可以互换，无需分支适配。
 *
 * @param {any} env
 * @param {string} slug - 已归一化的短链
 * @returns {Promise<{record: {metadata: object}, kvKey: string}|null>}
 *   未命中 / D1 未绑定 / 查询失败均返回 null —— 调用方据此回落 KV。
 */
export async function getFileRecordByShareSlug(env, slug) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !slug) return null;

  try {
    const row = await env.DB.prepare(
      'SELECT * FROM files WHERE share_slug = ? LIMIT 1'
    ).bind(String(slug)).first();

    if (!row) return null;
    return { record: rowToRecord(row), kvKey: row.kv_key || String(row.id || '') };
  } catch (error) {
    console.warn('D1 getFileRecordByShareSlug failed:', error?.message || error);
    return null;
  }
}

/**
 * 查询某个短链当前被哪个文件占用（唯一性校验用）。
 *
 * ## 为什么不复用 getFileRecordByShareSlug
 *
 * 两者的**空值语义不同**，这是本函数存在的唯一理由：
 *
 *   · getFileRecordByShareSlug 返回 null = 「未命中 或 未绑定 或 查询失败」，
 *     调用方一律回落 KV —— 对**解析**来说这是对的（最坏多读一次 KV）
 *   · 本函数返回 {owner, disabled} 明确区分三态。唯一性校验**不能**把
 *     「查不了」当成「没人占用」：那会让两个用户拿到同一个短链，
 *     后写的把先写的映射覆盖掉。
 *
 * 所以宁可要多一个函数，也不要把这里的语义指望在调用方"记得判断"上。
 *
 * 与 bundle 侧的 `isSlugTaken` 形状对称（那边是 {taken, disabled}）。
 *
 * @returns {Promise<{owner: string, disabled?: boolean, error?: string}>}
 *   owner 为空串 = 该短链空闲；disabled = D1 不可用，调用方应回落 KV
 */
export async function findFileOwnerBySlug(env, slug) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !slug) return { owner: '', disabled: true };

  try {
    const row = await env.DB.prepare(
      'SELECT kv_key, id FROM files WHERE share_slug = ? LIMIT 1'
    ).bind(String(slug)).first();
    if (!row) return { owner: '' };
    return { owner: String(row.kv_key || row.id || '') };
  } catch (error) {
    console.warn('D1 findFileOwnerBySlug failed:', error?.message || error);
    return { owner: '', disabled: true, error: error?.message };
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
  await ensureSchema(env);
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
  await ensureSchema(env);
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
 * 读取侧用（上传前查重，命中则秒传）。`files.content_sha` 上有唯一索引，
 * 因此这是一次索引查找，不是全表扫描。
 *
 * ## ttlSeconds 用来复刻 KV 版的语义
 *
 * 原先的去重索引是 KV 键 `sha_dup:<sha>`，带 `expirationTtl`（默认 90 天）：
 * 超过窗口后同名内容允许重新上传。D1 的 `content_sha` 列没有 TTL 概念，
 * 若直接照搬会**永久**去重 —— 语义悄悄变严，且不可逆地占用存储空间。
 *
 * 因此这里用 `uploaded_at > now - ttl` 把窗口显式表达出来，行为与 KV 版对齐。
 * 传 0（默认）表示不限窗口。
 *
 * @param {any} env
 * @param {string} sha
 * @param {{ttlSeconds?: number}} options
 * @returns {Promise<{record: {metadata: object}, kvKey: string}|null>}
 */
export async function findByContentSha(env, sha, options = {}) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !sha) return null;

  const ttlMs = Number(options.ttlSeconds) > 0 ? Number(options.ttlSeconds) * 1000 : 0;
  const params = [String(sha)];
  let sql = 'SELECT * FROM files WHERE content_sha = ?';
  if (ttlMs > 0) {
    sql += ' AND uploaded_at > ?';
    params.push(Date.now() - ttlMs);
  }
  sql += ' LIMIT 1';

  try {
    const row = await env.DB.prepare(sql).bind(...params).first();
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
  await ensureSchema(env);
  if (!isD1Enabled(env)) return { rows: [], total: 0, disabled: true };

  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const offset = Math.max(Number(options.offset) || 0, 0);

  const where = [];
  const params = [];
  // 与 KV 路径的 matchStorage() 对齐：'kv' 与 'telegram' 同义，
  // 不归一化会导致 ?storage=kv 拿 'kv' 去比对 'telegram' 而永远查空。
  const storage = normalizeStorageFilter(options.storage);
  if (storage) { where.push('storage = ?'); params.push(storage); }
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
 * 一次扫描算出后台面板需要的全部统计（total / byType / byStorage）。
 *
 * 替代原先「取回全部行 → 内存 computeStats」的做法。后者经 listAllRecords
 * 分页批取，每批都要跑一次 COUNT(*) 且 OFFSET 递增，扫描量是 **O(N²)**；
 * 这里用条件聚合把三份统计压进**一次**扫描，rows read 降为 O(N)。
 *
 * 口径与 list.js 的 computeStats() 严格对齐：
 *   · 只数真实文件（is_folder = 0 且 file_name 非空）
 *   · byType 取 files.file_type（由 inferFileType 按扩展名物化，与内存侧同函数）
 *   · byStorage 只统计已知的七种取值，未知值不计入
 *     （与内存侧 hasOwnProperty 检查保持一致 —— 那边的实现就是忽略未知键）
 *
 * @param {any} env
 * @param {{storage?: string}} [options] - 可选的存储类型筛选
 * @returns {Promise<{stats: object|null, disabled?: boolean, error?: string}>}
 *   stats 形状与 computeStats() 完全一致；D1 不可用 / 查询失败时返回
 *   disabled=true，调用方应回落到内存计算。
 */
export async function aggregateFileStats(env, options = {}) {
  await ensureSchema(env);
  if (!isD1Enabled(env)) return { stats: null, disabled: true };

  const storage = normalizeStorageFilter(options.storage);
  const where = [
    'is_folder = 0',
    "file_name IS NOT NULL AND file_name != ''",
  ];
  const params = [];
  if (storage) {
    where.push('storage = ?');
    params.push(storage);
  }

  // 一次扫描算完 12 个计数。
  // 用 SUM(CASE WHEN ...) 而不是 3 条 GROUP BY —— 后者会把全表扫三遍。
  const sql = `SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN file_type = 'image'    THEN 1 ELSE 0 END), 0) AS image,
      COALESCE(SUM(CASE WHEN file_type = 'video'    THEN 1 ELSE 0 END), 0) AS video,
      COALESCE(SUM(CASE WHEN file_type = 'audio'    THEN 1 ELSE 0 END), 0) AS audio,
      COALESCE(SUM(CASE WHEN file_type = 'document' THEN 1 ELSE 0 END), 0) AS document,
      COALESCE(SUM(CASE WHEN storage = 'telegram'    THEN 1 ELSE 0 END), 0) AS telegram,
      COALESCE(SUM(CASE WHEN storage = 'r2'          THEN 1 ELSE 0 END), 0) AS r2,
      COALESCE(SUM(CASE WHEN storage = 's3'          THEN 1 ELSE 0 END), 0) AS s3,
      COALESCE(SUM(CASE WHEN storage = 'discord'     THEN 1 ELSE 0 END), 0) AS discord,
      COALESCE(SUM(CASE WHEN storage = 'huggingface' THEN 1 ELSE 0 END), 0) AS huggingface,
      COALESCE(SUM(CASE WHEN storage = 'webdav'      THEN 1 ELSE 0 END), 0) AS webdav,
      COALESCE(SUM(CASE WHEN storage = 'github'      THEN 1 ELSE 0 END), 0) AS github
    FROM files
   WHERE ${where.join(' AND ')}`;

  try {
    const row = await env.DB.prepare(sql).bind(...params).first();
    if (!row) return { stats: null, disabled: true };

    return {
      stats: {
        total: Number(row.total) || 0,
        byType: {
          image: Number(row.image) || 0,
          video: Number(row.video) || 0,
          audio: Number(row.audio) || 0,
          document: Number(row.document) || 0,
        },
        byStorage: {
          telegram: Number(row.telegram) || 0,
          r2: Number(row.r2) || 0,
          s3: Number(row.s3) || 0,
          discord: Number(row.discord) || 0,
          huggingface: Number(row.huggingface) || 0,
          webdav: Number(row.webdav) || 0,
          github: Number(row.github) || 0,
        },
      },
    };
  } catch (error) {
    console.warn('D1 aggregateFileStats failed:', error?.message || error);
    return { stats: null, disabled: true, error: error?.message };
  }
}

/**
 * 删除一条文件记录。
 * @param {any} env
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteFileRecord(env, id) {
  await ensureSchema(env);
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
  await ensureSchema(env);
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

/**
 * 局部更新文件元数据列（改文件名 / 改所在目录等）。
 *
 * ============================================================================
 * 为什么必须有这个函数
 * ============================================================================
 *
 * 此前 `editName` / `move-folder` 这两个接口**只写 KV**：
 *
 *     await env.img_url.put(kvKey, '', { metadata });   // 只改了 KV
 *
 * 而读侧 `getRecordWithKey` 是 **D1 优先**。于是 D1 绑定后会出现：
 * 用户改了文件名，接口返回成功，但刷新列表**还是旧名字** ——
 * 因为读的是 D1，而 D1 从来没被更新。
 *
 * 这不是"优化空间"，是**现存的正确性 bug**，只是在 D1 全面接管读侧之后
 * 才暴露出来。所以这里补上 D1 写入，而不是等 P3。
 *
 * ============================================================================
 * 只更新显式传入的列
 * ============================================================================
 *
 * 与 updateShareOptions 的 COALESCE 写法同源：未传入的字段保持原值。
 * 这样"改名字"不会顺手把 folderPath 清空，"换目录"也不会重置文件名 ——
 * 整行覆盖式写入在这里同样会造成并发回退。
 *
 * @param {any} env
 * @param {string} id - 裸 ID（已剥离存储前缀）
 * @param {object} patch - 允许的键：fileName / folderPath
 * @returns {Promise<{ok: boolean, updated?: number, disabled?: boolean, error?: string}>}
 */
export async function updateFileMetadataFields(env, id, patch = {}) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !id) return { ok: false, disabled: true };

  const assignments = [];
  const values = [];

  // 白名单：列名与 patch 键的映射。不在这里的键一律忽略，
  // 防止调用方手滑把任意列写成用户输入。
  const COLUMN_FOR = {
    fileName: 'file_name',
    folderPath: 'folder_path',
  };

  for (const [key, column] of Object.entries(COLUMN_FOR)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = patch[key];
    assignments.push(`${column} = ?`);
    // folderPath 允许显式置空（移到根目录）；fileName 不允许为空
    values.push(value == null ? null : String(value));
  }

  if (assignments.length === 0) return { ok: true, updated: 0 };

  assignments.push('updated_at = ?');
  values.push(now());
  values.push(String(id));

  try {
    const res = await env.DB.prepare(
      `UPDATE files SET ${assignments.join(', ')} WHERE id = ?`
    ).bind(...values).run();
    return { ok: true, updated: Number(res?.changes) || 0 };
  } catch (error) {
    console.warn('D1 updateFileMetadataFields failed:', error?.message || error);
    return { ok: false, error: error?.message };
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
  await ensureSchema(env);
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
 * 归一化外部传入的 storage 筛选值到 D1 `files.storage` 的实际取值。
 *
 * KV 时代由键名前缀推断出的 `telegram`，在 UI 与 API 上也被叫做 `kv`
 * （见 file-list.js 的 matchStorage：两者同义）。下推 SQL 前必须先折叠成
 * 同一种取值，否则 `?storage=kv` 会拿 'kv' 去比对 'telegram' 而永远查空。
 *
 * @param {string} value - 外部传入的 storage 筛选值
 * @returns {string} 归一化后的取值；空串表示「不筛选」
 */
export function normalizeStorageFilter(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'kv') return 'telegram';
  return normalized;
}

/**
 * 按 folder_path 统计每个目录的文件数。
 *
 * 输出形状与 folders.js 的 `buildFolderSnapshot()` 的 `folders` 字段一致：
 *   { "<path>": { count, marker } }
 * 差别是这里由 SQL GROUP BY 一次算完，不再全量扫 KV。
 *
 * @param {any} env
 * @param {{storage?: string}} [options] - 可选的存储类型筛选，下推到 SQL
 * @returns {Promise<{folders: object, disabled?: boolean}>}
 */
export async function folderFileCounts(env, options = {}) {
  await ensureSchema(env);
  if (!isD1Enabled(env)) return { folders: {}, disabled: true };

  const storage = normalizeStorageFilter(options.storage);

  try {
    const where = [
      'is_folder = 0',
      "folder_path IS NOT NULL AND folder_path != ''",
    ];
    const params = [];
    if (storage) {
      where.push('storage = ?');
      params.push(storage);
    }

    const rows = await env.DB.prepare(
      `SELECT folder_path AS path, COUNT(*) AS n
         FROM files
        WHERE ${where.join(' AND ')}
        GROUP BY folder_path`
    ).bind(...params).all();

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
      if (storage) {
        // 筛选模式：标记只给「已由筛选后文件推导出的目录」补 marker 标志，
        // 不凭空造出 count=0 的目录节点。这与 KV 版一致 —— KV 路径里标记行
        // 同样要过 matchStorage()，筛选 r2 时标记是被过滤掉的。
        const existing = folders[path];
        if (existing) existing.marker = true;
        continue;
      }
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
  await ensureSchema(env);
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
  await ensureSchema(env);
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
  await ensureSchema(env);
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
  await ensureSchema(env);
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
