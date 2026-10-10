/**
 * Audit log for token management events (requirement #12).
 *
 * Events: TOKEN_CREATED, TOKEN_ROTATED, TOKEN_DISABLED, TOKEN_ENABLED,
 *         TOKEN_SCOPE_CHANGED, TOKEN_DELETED, TOKEN_VERIFY_FAILED,
 *         MCP_TOOL_CALL, MCP_TOOL_DENIED
 *
 * - Never records full token secrets (redaction applied to detail).
 * - No IP addresses are stored; only a short client tag is kept.
 * - **D1 优先**：写入 `audit_logs` 表，按时间倒序可查（见下方说明）。
 *   D1 未绑定时回落 KV 的 `audit:<ts>:<rand>`（180 天 TTL）。
 * - Audit failures must never break the main request flow.
 *
 * ## 为什么要迁出 KV
 *
 * 原键名 `audit:<ts>:<rand>` 决定了这份日志**天然不可读**：随机后缀让枚举
 * 顺序与时间无关，且没有索引，想按时间倒序读只能全前缀 list() 再内存排序。
 * 于是它写进去就再也读不出来 —— 不产生价值，却按每次令牌操作消耗一次
 * KV 写（额度仅 1000 次/天）。
 *
 * 落表后 `ORDER BY timestamp DESC LIMIT n` 是一条走索引的查询。
 * 保留期语义由 `audit-store.js` 在写入时顺带清理来复刻。
 */

import { redactSecrets } from './redact.js';
import { writeAuditRecord } from './audit-store.js';

/** KV 兜底路径的 TTL。D1 路径的等价物见 audit-store.js 的保留期清理。 */
const AUDIT_TTL_SECONDS = 180 * 24 * 3600;

/** KV 回退时的键前缀。D1 可用时不使用。 */
export const AUDIT_KEY_PREFIX = 'audit:';

function shortRandom() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const AUDIT_EVENTS = {
  TOKEN_CREATED: 'TOKEN_CREATED',
  TOKEN_ROTATED: 'TOKEN_ROTATED',
  TOKEN_DISABLED: 'TOKEN_DISABLED',
  TOKEN_ENABLED: 'TOKEN_ENABLED',
  TOKEN_SCOPE_CHANGED: 'TOKEN_SCOPE_CHANGED',
  TOKEN_DELETED: 'TOKEN_DELETED',
  TOKEN_VERIFY_FAILED: 'TOKEN_VERIFY_FAILED',
  // MCP 端点：工具被真实执行 / 因 scope 不足被拒。
  // 分开记是因为两者的排查方向完全不同 —— 前者要看「谁在什么时候动了什么」，
  // 后者是「凭据权限配错了」，混成一个事件会两边都查不清。
  MCP_TOOL_CALL: 'MCP_TOOL_CALL',
  MCP_TOOL_DENIED: 'MCP_TOOL_DENIED',
};

/**
 * 归一化审计记录（脱敏 + 截断）。写入路径与 KV 兜底共用同一份，
 * 保证两条路的存留形态一致。
 */
function normalizeAuditEntry(entry = {}) {
  return {
    event: String(entry.event || 'UNKNOWN').slice(0, 64),
    tokenId: String(entry.tokenId || '').slice(0, 128) || null,
    operation: String(entry.operation || '').slice(0, 64) || null,
    timestamp: Date.now(),
    success: entry.success !== false,
    client: String(entry.client || '').slice(0, 80) || null,
    detail: entry.detail == null ? null : redactSecrets(String(entry.detail)).slice(0, 500),
  };
}

export async function writeAuditLog(env, entry = {}) {
  try {
    const record = normalizeAuditEntry(entry);

    // ---------- 路径 A：D1 ----------
    const d1 = await writeAuditRecord(env, record);
    if (!d1.disabled) return d1.ok;

    // ---------- 路径 B：KV 兜底（D1 未绑定） ----------
    if (!env?.img_url) return false;
    const key = `${AUDIT_KEY_PREFIX}${Date.now().toString(36)}:${shortRandom()}`;
    await env.img_url.put(key, JSON.stringify(record), {
      expirationTtl: AUDIT_TTL_SECONDS,
    });
    return true;
  } catch (error) {
    console.warn('Audit log write failed:', error?.message || error);
    return false;
  }
}

