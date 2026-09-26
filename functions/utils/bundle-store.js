import { ensureSchema } from './schema.js';

/**
 * 合集分享的 D1 数据访问层（对应 migrations/0003_share_bundles.sql）。
 *
 * ============================================================================
 * 设计原则（与 metadata-d1.js 保持一致）
 * ============================================================================
 *
 * 1. **开关回落**：所有函数先看 `isD1Enabled(env)`。D1 未绑定时，
 *    读类返回 `null` / `{disabled:true}`，写类返回 `{ok:false, disabled:true}`，
 *    由调用方（share-bundle.js）回落到 KV 实现。数据层不擅自决定策略。
 *
 * 2. **形状兼容**：`rowToBundle()` 产出的对象与 `readBundle()` 的返回值
 *    逐字段一致，调用方拿到后无感。
 *
 * 3. **计数原子化**：合集下载计数同样**不做** read-modify-write。
 *    原 KV 实现是「读合集 → +1 → 写回」，并发下丢计数（源码注释已承认）。
 *    这里用单条 UPDATE 完成，与原 file 级计数保持一致。
 *
 * 4. **成员顺序稳定**：快照型合集的成员存在 bundle_files 表，靠 position
 *    保序；不依赖 SQL 的隐式行序。
 *
 * @module bundle-store
 */

/** D1 是否可用（与 metadata-d1.js 的判定保持一致，绑定名 DB）。 */
function isD1Enabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
}

function now() {
  return Date.now();
}

/**
 * bundle_files 行 → 文件 ID 数组（保序）。
 * @param {Array} rows
 * @returns {string[]}
 */
function rowsToFileIds(rows) {
  return (rows || []).map((row) => String(row.file_id || '')).filter(Boolean);
}

/**
 * 把 bundles 行（+ 成员）映射成 readBundle() 的同形对象。
 *
 * @param {object} row - bundles 表行
 * @param {string[]} fileIds - 成员文件 ID（快照型才有）
 * @returns {object|null}
 */
export function rowToBundle(row, fileIds = []) {
  if (!row) return null;

  const type = row.type === 'folder' ? 'folder' : 'files';

  // 与 KV 版一致的"空壳"判定：快照型没有成员即视为无效，
  // 避免渲染出"零文件"的分享页。
  if (type === 'files' && !fileIds.length) return null;

  return {
    slug: row.slug,
    type,
    fileIds,
    folderPath: type === 'folder' ? String(row.folder_path || '') : '',
    includeSubfolders: type === 'folder' ? Boolean(row.include_subfolders) : false,
    expiresAt: Number(row.expires_at) || 0,
    maxDownloads: Number(row.max_downloads) || 0,
    downloadCount: Number(row.download_count) || 0,
    passwordSalt: String(row.password_salt || ''),
    passwordHash: String(row.password_hash || ''),
    createdAt: Number(row.created_at) || 0,
    label: String(row.label || ''),
  };
}

/**
 * 读取一个合集（含快照型成员）。
 * @param {any} env
 * @param {string} slug
 * @returns {Promise<object|null>} D1 不可用时返回 null（调用方回落 KV）
 */
export async function readBundleRecord(env, slug) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !slug) return null;

  try {
    const row = await env.DB.prepare('SELECT * FROM bundles WHERE slug = ?')
      .bind(String(slug))
      .first();
    if (!row) return null;

    // 只有快照型需要取成员；实时型成员是动态列举的，不落库
    let fileIds = [];
    if (row.type !== 'folder') {
      const members = await env.DB.prepare(
        'SELECT file_id FROM bundle_files WHERE bundle_slug = ? ORDER BY position ASC, file_id ASC'
      ).bind(String(slug)).all();
      fileIds = rowsToFileIds(members?.results);
    }

    return rowToBundle(row, fileIds);
  } catch (error) {
    console.warn('D1 readBundleRecord failed:', error?.message || error);
    return null;
  }
}

/**
 * 写入 / 更新一个合集（upsert），快照型成员全量替换。
 *
 * 成员替换走"先删后插"而非逐条 upsert：合集创建时是一次性提交，
 * 编辑场景也总是整体覆盖，全量替换语义最简单、也不会残留旧成员。
 *
 * @param {any} env
 * @param {object} bundle - 与 writeBundle() 入参同形
 * @returns {Promise<{ok: boolean, disabled?: boolean, error?: string}>}
 */
export async function writeBundleRecord(env, bundle) {
  await ensureSchema(env);
  if (!isD1Enabled(env)) return { ok: false, disabled: true };

  const slug = String(bundle?.slug || '');
  if (!slug) return { ok: false, error: 'empty-slug' };

  const type = bundle?.type === 'folder' ? 'folder' : 'files';
  const fileIds = Array.isArray(bundle?.fileIds)
    ? bundle.fileIds.map((id) => String(id || '')).filter(Boolean)
    : [];

  if (type === 'files' && !fileIds.length) {
    return { ok: false, error: 'empty-members' };
  }

  const ts = now();
  const createdAt = Number(bundle?.createdAt) || ts;

  try {
    await env.DB.prepare(
      `INSERT INTO bundles (
         slug, type, folder_path, include_subfolders,
         expires_at, max_downloads, download_count,
         password_salt, password_hash, label, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET
         type = excluded.type,
         folder_path = excluded.folder_path,
         include_subfolders = excluded.include_subfolders,
         expires_at = excluded.expires_at,
         max_downloads = excluded.max_downloads,
         download_count = excluded.download_count,
         password_salt = excluded.password_salt,
         password_hash = excluded.password_hash,
         label = excluded.label,
         updated_at = excluded.updated_at`
    ).bind(
      slug,
      type,
      type === 'folder' ? String(bundle?.folderPath || '') : null,
      type === 'folder' && bundle?.includeSubfolders ? 1 : 0,
      Number(bundle?.expiresAt) || 0,
      Number(bundle?.maxDownloads) || 0,
      Number(bundle?.downloadCount) || 0,
      String(bundle?.passwordSalt || ''),
      String(bundle?.passwordHash || ''),
      String(bundle?.label || ''),
      createdAt,
      ts
    ).run();

    // 成员全量替换（仅快照型有意义）
    if (type === 'files') {
      await env.DB.prepare('DELETE FROM bundle_files WHERE bundle_slug = ?')
        .bind(slug).run();

      for (let i = 0; i < fileIds.length; i += 1) {
        await env.DB.prepare(
          `INSERT INTO bundle_files (bundle_slug, position, file_id)
           VALUES (?,?,?)
           ON CONFLICT(bundle_slug, file_id) DO NOTHING`
        ).bind(slug, i, fileIds[i]).run();
      }
    } else {
      // 实时型不持有成员，清掉可能残留的旧快照成员
      await env.DB.prepare('DELETE FROM bundle_files WHERE bundle_slug = ?')
        .bind(slug).run();
    }

    return { ok: true };
  } catch (error) {
    console.warn('D1 writeBundleRecord failed:', error?.message || error);
    return { ok: false, error: error?.message || 'd1-write-failed' };
  }
}

/**
 * 删除合集（成员随外键语义一并清理）。
 * @param {any} env
 * @param {string} slug
 * @returns {Promise<{ok: boolean, disabled?: boolean}>}
 */
export async function deleteBundleRecord(env, slug) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !slug) return { ok: false, disabled: true };

  try {
    await env.DB.prepare('DELETE FROM bundle_files WHERE bundle_slug = ?')
      .bind(String(slug)).run();
    await env.DB.prepare('DELETE FROM bundles WHERE slug = ?')
      .bind(String(slug)).run();
    return { ok: true };
  } catch (error) {
    console.warn('D1 deleteBundleRecord failed:', error?.message || error);
    return { ok: false, error: error?.message };
  }
}

/**
 * 列出全部合集（含各自成员）。
 *
 * 与 KV 版的区别：KV 要先枚举 `bundle_slug:` 前缀（分页扫），再逐个
 * `getWithMetadata` 读本体（N 次读）。这里两条 SQL 搞定：
 * 一条取全部合集，一条取全部成员后按 slug 分组。
 *
 * @param {any} env
 * @returns {Promise<{bundles: object[], disabled?: boolean}>}
 */
export async function listBundleRecords(env) {
  await ensureSchema(env);
  if (!isD1Enabled(env)) return { bundles: [], disabled: true };

  try {
    const rows = await env.DB.prepare(
      'SELECT * FROM bundles ORDER BY created_at DESC'
    ).all();
    const all = rows?.results || [];
    if (!all.length) return { bundles: [] };

    // 一次性取全部成员，按 slug 分组 —— 避免 N+1 次查询
    const memberRows = await env.DB.prepare(
      'SELECT bundle_slug, file_id FROM bundle_files ORDER BY bundle_slug ASC, position ASC, file_id ASC'
    ).all();

    const bySlug = new Map();
    for (const m of memberRows?.results || []) {
      const key = String(m.bundle_slug || '');
      if (!bySlug.has(key)) bySlug.set(key, []);
      bySlug.get(key).push(String(m.file_id || ''));
    }

    const bundles = [];
    for (const row of all) {
      const bundle = rowToBundle(row, bySlug.get(String(row.slug)) || []);
      // 快照型空壳合集直接跳过（与 readBundle 的语义一致）
      if (bundle) bundles.push(bundle);
    }

    return { bundles };
  } catch (error) {
    console.warn('D1 listBundleRecords failed:', error?.message || error);
    return { bundles: [], error: error?.message };
  }
}

/**
 * 原子累计一次合集下载。
 *
 * 原 KV 实现是「读 → +1 → 写回」，并发会丢计数（源码注释也承认了）。
 * 这里单条 UPDATE 完成，且**不做上限校验** —— 配额校验在调用方
 * （`isBundleExhausted` 在下载前判），本函数只负责计数不丢。
 *
 * @param {any} env
 * @param {string} slug
 * @returns {Promise<{ok: boolean, count: number, disabled?: boolean}>}
 */
export async function incrementBundleCount(env, slug) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !slug) return { ok: false, count: 0, disabled: true };

  try {
    await env.DB.prepare(
      `UPDATE bundles SET download_count = download_count + 1, updated_at = ?
        WHERE slug = ?`
    ).bind(now(), String(slug)).run();

    const row = await env.DB.prepare('SELECT download_count FROM bundles WHERE slug = ?')
      .bind(String(slug)).first();
    return { ok: true, count: Number(row?.download_count) || 0 };
  } catch (error) {
    console.warn('D1 incrementBundleCount failed:', error?.message || error);
    return { ok: false, count: 0, error: error?.message };
  }
}

/**
 * 判断 slug 是否已被占用（合集本体或单文件分享任一）。
 *
 * 原 KV 版要同时查 `share_slug:` 与 `bundle_slug:` 两个键，
 * 这里两条 SELECT 各查一张表的主键/唯一索引。
 *
 * @param {any} env
 * @param {string} slug
 * @returns {Promise<{taken: boolean, disabled?: boolean}>}
 */
export async function isSlugTaken(env, slug) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !slug) return { taken: false, disabled: true };

  try {
    const bundleHit = await env.DB.prepare('SELECT 1 AS x FROM bundles WHERE slug = ?')
      .bind(String(slug)).first();
    if (bundleHit) return { taken: true };

    const fileHit = await env.DB.prepare('SELECT 1 AS x FROM files WHERE share_slug = ?')
      .bind(String(slug)).first();
    return { taken: Boolean(fileHit) };
  } catch (error) {
    console.warn('D1 isSlugTaken failed:', error?.message || error);
    return { taken: false, disabled: true, error: error?.message };
  }
}
