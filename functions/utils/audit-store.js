/**
 * 审计日志的 D1 数据访问层（对应 migrations/0005_tokens_pastes_audit.sql）。
 *
 * ============================================================================
 * 为什么这份日志**必须**迁出 KV
 * ============================================================================
 *
 * 原实现把记录写成 `audit:<ts>:<rand>` —— 时间戳在前、6 字节随机后缀在后。
 * 这个键名结构决定了它**天然不可读**：
 *
 *   1. 随机后缀让枚举出的顺序与时间无关（同一毫秒内多条记录顺序随机）
 *   2. 没有索引，想按时间倒序取最近 N 条，只能把**整个前缀** list() 回来
 *      再在内存里排序、切片
 *   3. `list()` 是 KV 里按前缀计费的昂贵操作，而日志是持续增长的
 *
 * 结论是：这份日志写进去就再也读不出来了。它不产生任何价值，却按每次
 * 令牌操作消耗一次 KV 写 —— 而 KV 写额度只有 1000 次/天。
 *
 * 落成表之后，`ORDER BY timestamp DESC LIMIT n` 是一条走索引的查询。
 *
 * ============================================================================
 * 与 KV 版的行为对齐
 * ============================================================================
 *
 *   · **保留期**：KV 版用 `expirationTtl`（180 天）自动过期。D1 没有 TTL，
 *     所以写入时**顺手清理**超期记录 —— 见 {@link writeAuditRecord}。
 *     不清理的话表会无限增长，且查询会扫过大量死数据。
 *   · **截断长度**：event/tokenId/operation/client/detail 的上限与 KV 版
 *     逐字一致，避免迁移后写入形态变化。
 *   · **失败不阻断**：调用方（`writeAuditLog`）本就吞掉异常，这里也只在
 *     出错时 warn 并返回 `{ok:false}`。
 *
 * @module audit-store
 */

import { ensureSchema } from './schema.js';

/** 与 utils/audit.js 保持一致：180 天保留期。 */
export const AUDIT_RETENTION_SECONDS = 180 * 24 * 3600;

/** 字段长度上限，与 KV 版逐字一致。 */
const MAX_LEN = {
  event: 64,
  tokenId: 128,
  operation: 64,
  client: 80,
  detail: 500,
};

/** D1 是否可用（与 metadata-d1.js 的判定保持一致，绑定名 DB）。 */
function isD1Enabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
}

function truncate(value, length) {
  return value == null ? null : String(value).slice(0, length);
}

/**
 * 写入一条审计记录，并顺带清理超出保留期的旧记录。
 *
 * ## 为什么在这里清理
 *
 * KV 版靠 `expirationTtl` 自动过期，D1 没有对等机制。可选方案：
 *   A. 定时任务（Cron Trigger）定期清理 —— 需要额外的部署配置
 *   B. 写入时顺带清理 —— 零配置，清理频率自然跟随写入频率
 *   C. 不清理，查询时过滤 —— 表无限增长，查询越扫越慢
 *
 * 选 B：审计写入本就是低频操作（只在令牌管理时发生），顺带一条 DELETE
 * 的开销可以忽略；而且"写的时候顺手清旧的"在语义上也最自然。
 *
 * 清理用 `timestamp < ?` 走 `idx_audit_logs_timestamp`，代价与超期记录数
 * 成正比，与表总大小无关。
 *
 * @param {any} env
 * @param {object} entry - 见 utils/audit.js 的 writeAuditLog
 * @returns {Promise<{ok: boolean, disabled?: boolean, error?: string}>}
 */
export async function writeAuditRecord(env, entry = {}) {
  await ensureSchema(env);
  if (!isD1Enabled(env)) return { ok: false, disabled: true };

  const timestamp = Number(entry.timestamp) || Date.now();

  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs
         (event, token_id, operation, success, client, detail, timestamp)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(
      truncate(entry.event || 'UNKNOWN', MAX_LEN.event),
      truncate(entry.tokenId, MAX_LEN.tokenId),
      truncate(entry.operation, MAX_LEN.operation),
      entry.success === false ? 0 : 1,
      truncate(entry.client, MAX_LEN.client),
      truncate(entry.detail, MAX_LEN.detail),
      timestamp
    ).run();

    // 顺带清理超期记录（KV 版的 expirationTtl 等价物）
    const cutoff = timestamp - AUDIT_RETENTION_SECONDS * 1000;
    await env.DB.prepare('DELETE FROM audit_logs WHERE timestamp < ?')
      .bind(cutoff).run();

    return { ok: true };
  } catch (error) {
    console.warn('D1 writeAuditRecord failed:', error?.message || error);
    return { ok: false, error: error?.message };
  }
}

/**
 * 列出审计记录（按时间倒序）。
 *
 * 这是 KV 版**做不到**的那件事：KV 里没有索引，只能全前缀 list() 再内存排序。
 *
 * @param {any} env
 * @param {{limit?: number, offset?: number, event?: string, tokenId?: string, since?: number}} options
 * @returns {Promise<{items: object[], total: number, disabled?: boolean}>}
 */
export async function listAuditRecords(env, options = {}) {
  await ensureSchema(env);
  if (!isD1Enabled(env)) return { items: [], total: 0, disabled: true };

  const limit = Math.max(1, Math.min(Number(options.limit) || 50, 200));
  const offset = Math.max(0, Number(options.offset) || 0);

  const where = [];
  const params = [];
  if (options.event) {
    where.push('event = ?');
    params.push(String(options.event));
  }
  if (options.tokenId) {
    where.push('token_id = ?');
    params.push(String(options.tokenId));
  }
  if (Number(options.since) > 0) {
    where.push('timestamp >= ?');
    params.push(Number(options.since));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_logs ${whereSql}`
    ).bind(...params).first();

    const rows = await env.DB.prepare(
      `SELECT event, token_id, operation, success, client, detail, timestamp
         FROM audit_logs ${whereSql}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    return {
      items: (rows?.results || []).map(rowToAuditEntry),
      total: Number(totalRow?.n) || 0,
    };
  } catch (error) {
    console.warn('D1 listAuditRecords failed:', error?.message || error);
    return { items: [], total: 0, disabled: true, error: error?.message };
  }
}

/**
 * 行 → 记录形状（与 KV 版写入的 JSON 结构逐字段一致）。
 * @param {object} row
 */
export function rowToAuditEntry(row) {
  if (!row) return null;
  return {
    event: row.event,
    tokenId: row.token_id || null,
    operation: row.operation || null,
    timestamp: Number(row.timestamp) || 0,
    success: Number(row.success) !== 0,
    client: row.client || null,
    detail: row.detail == null ? null : row.detail,
  };
}
