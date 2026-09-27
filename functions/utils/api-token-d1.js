/**
 * API Token 的 D1 数据访问层（对应 migrations/0005_tokens_pastes_audit.sql）。
 *
 * ============================================================================
 * 为什么迁
 * ============================================================================
 *
 * KV 版 `listApiTokens()` 是：全前缀 `list()` 翻页拿 key → 对每个 key
 * `get()` 一次凭据 → 再 `get()` 一次遥测。N 个令牌就是 1 次 list + 2N 次读。
 * 而 `token_stat:` 是**每 60 秒采样写一次**的高频键 —— 写额度（1000/天）
 * 是全站最紧的约束，把遥测钉在 KV 上等于每天约 1000 次请求就写不动了。
 *
 * 落表后：
 *   · 列表 = 1 条 LEFT JOIN 查询（凭据 + 遥测一次取回）
 *   · 遥测写入 = 1 条 UPSERT，不占 KV 额度
 *   · 按 created_at 排序由索引承担，不再全量拉回内存排
 *
 * ============================================================================
 * 两张表的分工（刻意分表，不合并）
 * ============================================================================
 *
 * `api_tokens` 是**凭据**：改它会影响鉴权正确性，必须精确。
 * `token_stats` 是**遥测**：高频覆盖写，允许采样丢精度。
 *
 * 分开存的意义是让遥测的 read-modify-write 不可能与凭据更新互相覆盖 ——
 * 这正是 KV 版把 credential 与 telemetry 拆成两个键的原始意图，迁到表结构
 * 后继续保留，不因为"反正是一张表能塞下"就合并掉。
 *
 * ============================================================================
 * 覆盖语义（与 KV 版的差异）
 * ============================================================================
 *
 * KV 版 `putRecord()` 是整条覆盖 —— 读出来的记录缺什么，写回去就丢什么。
 * 表结构下如果照抄「先 SELECT 再整行 UPDATE」，一旦中间有并发写（例如
 * rotate 与 scope 变更同时发生），后写的一方会拿旧快照覆盖前一方。
 *
 * 因此这里的 `updateTokenRecord()` **只更新 patch 里显式给的列**，
 * 未提及的列一律不动。这让「禁用令牌」与「轮换密钥」可以安全并发。
 *
 * @module api-token-d1
 */

import { ensureSchema } from './schema.js';

/** D1 是否可用（绑定名 DB）。 */
function isD1Enabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
}

function now() {
  return Date.now();
}

/** 解析 JSON 列，坏数据一律当空处理（不抛，避免一条脏行拖垮整个列表）。 */
function parseJsonColumn(raw, fallback = null) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 行 → 凭据记录。
 *
 * 返回**原始形状**（scopes 数组直接给出、policies 原样），
 * 与之配套的校验/归一化仍由 api-token.js 的 getRecordById 做 ——
 * 数据层不替业务层决定"什么算合法 scope"。
 *
 * @param {object} row
 */
export function rowToTokenRecord(row) {
  if (!row) return null;
  return {
    id: row.token_id,
    name: row.name || '',
    scopes: parseJsonColumn(row.scopes, []),
    policies: parseJsonColumn(row.policies, null),
    tokenHash: row.secret_hash || '',
    tokenSalt: row.secret_salt || '',
    tokenSuffix: row.secret_suffix || '',
    enabled: Number(row.enabled) !== 0,
    expiresAt: Number(row.expires_at) || null,
    createdAt: Number(row.created_at) || 0,
    rotatedAt: row.rotated_at == null ? null : Number(row.rotated_at) || 0,
  };
}

/**
 * 行 → 遥测记录（对应 KV 版 token_stat:<id> 的载荷）。
 * @param {object} row
 */
export function rowToTokenStat(row) {
  if (!row) return null;
  return {
    lastUsedAt: Number(row.last_used_at) || null,
    usageCount: Number(row.request_count) || 0,
    lastSuccessAt: Number(row.last_success_at) || null,
    lastFailureAt: Number(row.last_failure_at) || null,
    lastOperation: row.last_operation || null,
    lastClient: row.last_client || null,
    lastTouchAt: Number(row.last_touch_at) || 0,
  };
}

/**
 * 按 ID 读取凭据。
 *
 * @param {any} env
 * @param {string} tokenId
 * @returns {Promise<object|null>} 记录；未命中返回 null
 */
export async function getTokenRecord(env, tokenId) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !tokenId) return null;

  try {
    const row = await env.DB.prepare(
      'SELECT * FROM api_tokens WHERE token_id = ? LIMIT 1'
    ).bind(String(tokenId)).first();
    return rowToTokenRecord(row);
  } catch (error) {
    console.warn('D1 getTokenRecord failed:', error?.message || error);
    return null;
  }
}

/** 判断 token id 是否已被占用（生成唯一 ID 时用，只查主键）。 */
export async function tokenIdExists(env, tokenId) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !tokenId) return { exists: false, disabled: true };

  try {
    const row = await env.DB.prepare(
      'SELECT 1 AS x FROM api_tokens WHERE token_id = ? LIMIT 1'
    ).bind(String(tokenId)).first();
    return { exists: Boolean(row) };
  } catch (error) {
    console.warn('D1 tokenIdExists failed:', error?.message || error);
    return { exists: false, disabled: true, error: error?.message };
  }
}

/**
 * 插入一条新凭据（仅 create 路径使用）。
 *
 * 刻意用 INSERT 而非 upsert：token id 是刚生成的随机值，撞车应当报错而不是
 * 静默覆盖已有令牌 —— 静默覆盖会把别人的令牌换成新密钥，是安全事故。
 *
 * @returns {Promise<{ok: boolean, conflict?: boolean, disabled?: boolean, error?: string}>}
 */
export async function insertTokenRecord(env, record = {}) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !record.id) return { ok: false, disabled: true };

  try {
    await env.DB.prepare(
      `INSERT INTO api_tokens (
         token_id, name, scopes, policies,
         secret_hash, secret_salt, secret_suffix,
         enabled, expires_at, created_at, rotated_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      String(record.id),
      String(record.name || ''),
      JSON.stringify(Array.isArray(record.scopes) ? record.scopes : []),
      record.policies ? JSON.stringify(record.policies) : null,
      String(record.tokenHash || ''),
      String(record.tokenSalt || ''),
      record.tokenSuffix || null,
      record.enabled === false ? 0 : 1,
      Number(record.expiresAt) || 0,
      Number(record.createdAt) || now(),
      record.rotatedAt == null ? null : Number(record.rotatedAt) || 0,
      now()
    ).run();

    return { ok: true };
  } catch (error) {
    const message = String(error?.message || error);
    const conflict = /UNIQUE|PRIMARY KEY|constraint/i.test(message);
    if (!conflict) console.warn('D1 insertTokenRecord failed:', message);
    return { ok: false, conflict, error: message };
  }
}

/**
 * 局部更新凭据 —— **只更新 patch 里出现的列**。
 *
 * 这是与 KV 版整条覆盖的关键差异（见模块头注释）。未提及的列保持原值，
 * 因此「禁用令牌」与「轮换密钥」并发时不会互相回退。
 *
 * @param {any} env
 * @param {string} tokenId
 * @param {object} patch - 允许的键：name/scopes/policies/enabled/expiresAt/
 *                         tokenHash/tokenSalt/tokenSuffix/rotatedAt
 * @returns {Promise<{ok: boolean, updated?: number, disabled?: boolean, error?: string}>}
 */
export async function updateTokenRecord(env, tokenId, patch = {}) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !tokenId) return { ok: false, disabled: true };

  // 白名单 → 列名映射。不在这里的键一律忽略，防止调用方手滑写进任意列。
  const COLUMN_FOR = {
    name: 'name',
    scopes: 'scopes',
    policies: 'policies',
    enabled: 'enabled',
    expiresAt: 'expires_at',
    tokenHash: 'secret_hash',
    tokenSalt: 'secret_salt',
    tokenSuffix: 'secret_suffix',
    rotatedAt: 'rotated_at',
  };

  const assignments = [];
  const values = [];

  for (const [key, column] of Object.entries(COLUMN_FOR)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = patch[key];

    if (key === 'scopes') {
      assignments.push(`${column} = ?`);
      values.push(JSON.stringify(Array.isArray(value) ? value : []));
    } else if (key === 'policies') {
      assignments.push(`${column} = ?`);
      values.push(value ? JSON.stringify(value) : null);
    } else if (key === 'enabled') {
      assignments.push(`${column} = ?`);
      values.push(value === false ? 0 : 1);
    } else if (key === 'expiresAt') {
      assignments.push(`${column} = ?`);
      values.push(Number(value) || 0);
    } else if (key === 'rotatedAt') {
      assignments.push(`${column} = ?`);
      values.push(value == null ? null : Number(value) || 0);
    } else {
      assignments.push(`${column} = ?`);
      values.push(value == null ? null : String(value));
    }
  }

  if (assignments.length === 0) return { ok: true, updated: 0 };

  assignments.push('updated_at = ?');
  values.push(now());
  values.push(String(tokenId));

  try {
    const res = await env.DB.prepare(
      `UPDATE api_tokens SET ${assignments.join(', ')} WHERE token_id = ?`
    ).bind(...values).run();
    return { ok: true, updated: Number(res?.changes) || 0 };
  } catch (error) {
    console.warn('D1 updateTokenRecord failed:', error?.message || error);
    return { ok: false, error: error?.message };
  }
}

/**
 * 列出全部令牌（凭据 + 遥测一次取回，按创建时间倒序）。
 *
 * 这是 P5 迁移收益最直观的一处：KV 版需要 1 次 list + 2N 次 get，
 * 这里是一条 LEFT JOIN。用 LEFT JOIN 而非 INNER JOIN，是因为遥测行可能
 * 还不存在（令牌从未被使用过），此时凭据仍必须出现在列表里。
 *
 * @returns {Promise<{items: object[], disabled?: boolean}>}
 */
export async function listTokenRecords(env) {
  await ensureSchema(env);
  if (!isD1Enabled(env)) return { items: [], disabled: true };

  try {
    const rows = await env.DB.prepare(
      `SELECT t.*,
              s.request_count, s.last_used_at, s.last_success_at, s.last_failure_at,
              s.last_operation, s.last_client, s.last_touch_at
         FROM api_tokens t
         LEFT JOIN token_stats s ON s.token_id = t.token_id
        ORDER BY t.created_at DESC`
    ).all();

    return {
      items: (rows?.results || []).map((row) => ({
        record: rowToTokenRecord(row),
        stat: row.request_count == null && row.last_touch_at == null ? null : rowToTokenStat(row),
      })),
    };
  } catch (error) {
    console.warn('D1 listTokenRecords failed:', error?.message || error);
    return { items: [], disabled: true, error: error?.message };
  }
}

/**
 * 删除令牌（凭据 + 遥测，同一处清理）。
 *
 * 遥测行跟着凭据走 —— 留着它会成为永远读不到的孤儿行，而 token id 是随机
 * 生成的，不会被后来的令牌复用，所以不存在"下次创建时白捡旧统计"的问题。
 *
 * 用 `changes` 判断存在性，避免为了返回 404 与否再查一次。
 *
 * @returns {Promise<{ok: boolean, deleted: number, disabled?: boolean}>}
 */
export async function deleteTokenRecord(env, tokenId) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !tokenId) return { ok: false, deleted: 0, disabled: true };

  try {
    const res = await env.DB.prepare('DELETE FROM api_tokens WHERE token_id = ?')
      .bind(String(tokenId)).run();
    const deleted = Number(res?.changes) || 0;

    // 只有真的删掉了凭据才顺手清遥测；若凭据本就不存在，不要误删孤儿行
    // （理论不存在，但保持"以凭据为准"的单一事实来源更稳）。
    if (deleted > 0) {
      await env.DB.prepare('DELETE FROM token_stats WHERE token_id = ?')
        .bind(String(tokenId)).run().catch(() => {});
    }

    return { ok: true, deleted };
  } catch (error) {
    console.warn('D1 deleteTokenRecord failed:', error?.message || error);
    return { ok: false, deleted: 0, error: error?.message };
  }
}

/**
 * 读取遥测。
 * @returns {Promise<object|null>}
 */
export async function getTokenStat(env, tokenId) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !tokenId) return null;

  try {
    const row = await env.DB.prepare(
      'SELECT * FROM token_stats WHERE token_id = ? LIMIT 1'
    ).bind(String(tokenId)).first();
    return rowToTokenStat(row);
  } catch (error) {
    console.warn('D1 getTokenStat failed:', error?.message || error);
    return null;
  }
}

/**
 * 采样写遥测（单条 UPSERT，采样判定下推到 SQL 的 WHERE）。
 *
 * ============================================================================
 * 为什么不用「先读再写」
 * ============================================================================
 *
 * 朴素实现是 SELECT last_touch_at → 判断是否在去抖窗口内 → 决定要不要
 * INSERT/UPDATE。那是**两次查询**，而这是一条**每次 API 调用都会走到**的
 * 热点路径 —— 免费版 D1 每天 500 万 rows read，翻倍很快。
 *
 * 这里把判定写进 ON CONFLICT 的 WHERE：
 *
 *   · 行不存在       → 插入（首次使用总会记下来）
 *   · 行存在但在窗口内 → WHERE 不成立 → **完全不改行**（采样跳过）
 *   · 行存在且超窗口   → 更新，计数 +1
 *
 * 于是无论采样是否跳过，都只花 1 次查询。`changes` 为 0 即表示"被采样跳过"，
 * 与旧实现的返回值语义一一对应。
 *
 * 注意 `request_count = token_stats.request_count + 1` 用的是**表里当前值**，
 * 而非调用方传入的旧快照 —— 并发下不会丢计数（旧实现"读出来的 count + 1"
 * 在并发时会互相覆盖）。
 *
 * @param {any} env
 * @param {string} tokenId
 * @param {{now: number, minIntervalMs: number, success: boolean,
 *          operation?: string, client?: string}} entry
 * @returns {Promise<{ok: boolean, written: boolean, skipped?: boolean, disabled?: boolean, error?: string}>}
 */
export async function touchTokenStat(env, tokenId, entry = {}) {
  await ensureSchema(env);
  if (!isD1Enabled(env) || !tokenId) return { ok: false, written: false, disabled: true };

  const now = Number(entry.now) || Date.now();
  const minInterval = Math.max(0, Number(entry.minIntervalMs) || 0);
  const success = entry.success !== false;
  const operation = entry.operation ? String(entry.operation).slice(0, 64) : null;
  const client = entry.client ? String(entry.client).slice(0, 80) : null;

  try {
    const res = await env.DB.prepare(
      `INSERT INTO token_stats (
         token_id, request_count, last_used_at, last_success_at, last_failure_at,
         last_operation, last_client, last_touch_at, updated_at
       ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(token_id) DO UPDATE SET
         request_count   = token_stats.request_count + 1,
         last_used_at    = excluded.last_used_at,
         last_success_at = excluded.last_success_at,
         last_failure_at = excluded.last_failure_at,
         last_operation  = excluded.last_operation,
         last_client     = excluded.last_client,
         last_touch_at   = excluded.last_touch_at,
         updated_at      = excluded.updated_at
       WHERE token_stats.last_touch_at = 0
          OR excluded.last_touch_at - token_stats.last_touch_at >= ?`
    ).bind(
      String(tokenId),
      now,
      success ? now : 0,
      success ? 0 : now,
      operation,
      client,
      now,
      now,
      minInterval
    ).run();

    const written = (Number(res?.changes) || 0) > 0;
    return { ok: true, written, skipped: !written };
  } catch (error) {
    console.warn('D1 touchTokenStat failed:', error?.message || error);
    return { ok: false, written: false, error: error?.message };
  }
}
