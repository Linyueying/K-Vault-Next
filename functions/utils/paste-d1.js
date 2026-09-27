/**
 * Paste 的 D1 数据访问层（对应 migrations/0005_tokens_pastes_audit.sql）。
 *
 * ============================================================================
 * 为什么迁
 * ============================================================================
 *
 * `listPastes()` 的 KV 实现是：全前缀 `list()` 翻完整个命名空间 →
 * 内存过滤过期项 → 排序 → 切片分页。文件数 N 时每次列表请求都是 O(N) 次
 * KV 分页调用 —— 与文件列表早期那个 O(N²) 问题同源，只是换了个对象。
 *
 * 更别扭的是过期处理：KV 版**没有**给 paste 设 `expirationTtl`（因为要支持
 * 不带过期的 paste），于是过期判断只能在读取时做，还得顺手删掉过期键。
 * 结果每次列表都在做「枚举 + 判断 + 批量 delete」这套组合动作。
 *
 * 落表后：`WHERE expires_at = 0 OR expires_at > now` 交给 SQL，排序分页
 * 交给 SQL，过期记录用清理接口一次性处理。
 *
 * ============================================================================
 * 过期语义
 * ============================================================================
 *
 * 约定 `expires_at = 0` 表示**永不过期**（与 KV 版 `expiresAt: null` 对应）。
 * 读取一律带 `expires_at = 0 OR expires_at > ?` 条件，因此即便清理没跑，
 * 过期记录也**不会**被返回 —— 清理只是回收空间，不承担正确性职责。
 * 这个分工很重要：把正确性寄托在"定时清理跑过了"上是不可靠的。
 *
 * @module paste-d1
 */

import { ensureSchema } from './schema.js';

/** D1 是否可用（绑定名 DB）。 */
function isD1Enabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
}

function now() {
  return Date.now();
}

/**
 * 行 → 记录形状。
 *
 * 与 KV 版 `summarize()` 产出的字段刻意区分：
 *   · `summarize()` 是**对外摘要**（不含 content、用 hasPassword 布尔）
 *   · 这里返回**完整记录**（含 content 与 passwordHash/Salt）
 * 由调用方决定暴露哪一层，数据层不替业务做脱敏决策。
 *
 * @param {object} row
 */
export function rowToPaste(row) {
  if (!row) return null;
  return {
    id: row.paste_id,
    content: row.content || '',
    language: row.language || 'text',
    createdAt: Number(row.created_at) || 0,
    expiresAt: Number(row.expires_at) || null,
    size: Number(row.size) || 0,
    passwordHash: row.password_hash || null,
    passwordSalt: row.password_salt || null,
  };
}

/**
 * 按 ID 读取 paste（自动排除已过期记录）。
 *
 * 刻意**不返回**过期记录，也不在这里做删除 —— 删除是副作用，
 * 让读操作携带副作用会让调用点难以推理（重试、并发都会变得微妙）。
 *
 * @param {any} env
 * @param {string} pasteId
 * @returns {Promise<object|null>} 记录；未命中或已过期返回 null
 */
export async function getPasteRecord(env, pasteId) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !pasteId) return null;

  try {
    const row = await env.DB.prepare(
      `SELECT * FROM pastes
        WHERE paste_id = ? AND (expires_at = 0 OR expires_at > ?)
        LIMIT 1`
    ).bind(String(pasteId), now()).first();

    return rowToPaste(row);
  } catch (error) {
    console.warn('D1 getPasteRecord failed:', error?.message || error);
    return null;
  }
}

/**
 * 写入 paste（upsert）。
 *
 * @param {any} env
 * @param {object} record - 完整记录（见 rowToPaste 的逆）
 * @returns {Promise<{ok: boolean, disabled?: boolean, error?: string}>}
 */
export async function putPasteRecord(env, record = {}) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !record.id) return { ok: false, disabled: true };

  try {
    await env.DB.prepare(
      `INSERT INTO pastes (
         paste_id, content, language, size,
         password_hash, password_salt, expires_at, created_at
       ) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(paste_id) DO UPDATE SET
         content = excluded.content,
         language = excluded.language,
         size = excluded.size,
         password_hash = excluded.password_hash,
         password_salt = excluded.password_salt,
         expires_at = excluded.expires_at`
    ).bind(
      String(record.id),
      String(record.content || ''),
      String(record.language || 'text'),
      Number(record.size) || 0,
      record.passwordHash || null,
      record.passwordSalt || null,
      Number(record.expiresAt) || 0,
      Number(record.createdAt) || now()
    ).run();

    return { ok: true };
  } catch (error) {
    console.warn('D1 putPasteRecord failed:', error?.message || error);
    return { ok: false, error: error?.message };
  }
}

/**
 * 分页列出 paste（按创建时间倒序）。
 *
 * 与 KV 版的关键差异：**排序与分页都交给 SQL**。KV 版必须先把所有 paste
 * 拉回来才能在内存里排序，取第 2 页也要先算完全集。
 *
 * @param {any} env
 * @param {{limit?: number, offset?: number}} options
 * @returns {Promise<{items: object[], total: number, disabled?: boolean}>}
 */
export async function listPasteRecords(env, options = {}) {
  await ensureSchema(env);
  if (!isD1Enabled(env)) return { items: [], total: 0, disabled: true };

  const limit = Math.max(1, Math.min(Number(options.limit) || 50, 200));
  const offset = Math.max(0, Number(options.offset) || 0);
  const ts = now();

  try {
    const totalRow = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM pastes WHERE expires_at = 0 OR expires_at > ?'
    ).bind(ts).first();

    const rows = await env.DB.prepare(
      `SELECT * FROM pastes
        WHERE expires_at = 0 OR expires_at > ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`
    ).bind(ts, limit, offset).all();

    return {
      items: (rows?.results || []).map(rowToPaste),
      total: Number(totalRow?.n) || 0,
    };
  } catch (error) {
    console.warn('D1 listPasteRecords failed:', error?.message || error);
    return { items: [], total: 0, disabled: true, error: error?.message };
  }
}

/**
 * 删除单个 paste。
 * @returns {Promise<{ok: boolean, deleted?: number, disabled?: boolean}>}
 */
export async function deletePasteRecord(env, pasteId) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !pasteId) return { ok: false, disabled: true };

  try {
    const res = await env.DB.prepare('DELETE FROM pastes WHERE paste_id = ?')
      .bind(String(pasteId)).run();
    return { ok: true, deleted: Number(res?.changes) || 0 };
  } catch (error) {
    console.warn('D1 deletePasteRecord failed:', error?.message || error);
    return { ok: false, error: error?.message };
  }
}

/**
 * 清理已过期的 paste。
 *
 * 这是**空间回收**，不是正确性依赖 —— 读取侧本就带过期条件，
 * 即便这个函数从不运行，用户也看不到过期内容。
 *
 * @param {any} env
 * @returns {Promise<{ok: boolean, deleted?: number, disabled?: boolean}>}
 */
export async function purgeExpiredPastes(env) {
  await ensureSchema(env);
  if (!isD1Enabled(env)) return { ok: false, disabled: true };

  try {
    const res = await env.DB.prepare(
      'DELETE FROM pastes WHERE expires_at > 0 AND expires_at <= ?'
    ).bind(now()).run();
    return { ok: true, deleted: Number(res?.changes) || 0 };
  } catch (error) {
    console.warn('D1 purgeExpiredPastes failed:', error?.message || error);
    return { ok: false, error: error?.message };
  }
}

/**
 * 判断某个 paste id 是否已被占用（用于生成时判重）。
 *
 * 只查主键，不关心是否过期 —— 过期记录一旦被新记录撞上，upsert 会覆盖它，
 * 而覆盖正是想要的结果。
 *
 * @returns {Promise<{exists: boolean, disabled?: boolean}>}
 */
export async function pasteIdExists(env, pasteId) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !pasteId) return { exists: false, disabled: true };

  try {
    const row = await env.DB.prepare('SELECT 1 AS x FROM pastes WHERE paste_id = ? LIMIT 1')
      .bind(String(pasteId)).first();
    return { exists: Boolean(row) };
  } catch (error) {
    console.warn('D1 pasteIdExists failed:', error?.message || error);
    return { exists: false, disabled: true, error: error?.message };
  }
}
