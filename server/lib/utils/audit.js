/**
 * Audit log for token management events (requirement #12) — Docker/SQLite variant.
 *
 * Events: TOKEN_CREATED, TOKEN_ROTATED, TOKEN_DISABLED, TOKEN_ENABLED,
 *         TOKEN_SCOPE_CHANGED, TOKEN_DELETED, TOKEN_VERIFY_FAILED
 *
 * - Never records full token secrets (redaction applied to detail).
 * - No IP addresses are stored; only a short client tag is kept.
 * - Records live in the `audit_logs` SQLite table (180 days, pruned lazily).
 * - Audit failures must never break the main request flow.
 */

const { redactSecrets } = require('./redact');

const AUDIT_TTL_MS = 180 * 24 * 3600 * 1000;

const AUDIT_EVENTS = {
  TOKEN_CREATED: 'TOKEN_CREATED',
  TOKEN_ROTATED: 'TOKEN_ROTATED',
  TOKEN_DISABLED: 'TOKEN_DISABLED',
  TOKEN_ENABLED: 'TOKEN_ENABLED',
  TOKEN_SCOPE_CHANGED: 'TOKEN_SCOPE_CHANGED',
  TOKEN_DELETED: 'TOKEN_DELETED',
  TOKEN_VERIFY_FAILED: 'TOKEN_VERIFY_FAILED',
};

function writeAuditLog(db, entry = {}) {
  try {
    if (!db) return false;
    const now = Date.now();
    db.prepare(
      `INSERT INTO audit_logs (event, token_id, operation, timestamp, success, client, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      String(entry.event || 'UNKNOWN').slice(0, 64),
      String(entry.tokenId || '').slice(0, 128) || null,
      String(entry.operation || '').slice(0, 64) || null,
      now,
      entry.success === false ? 0 : 1,
      String(entry.client || '').slice(0, 80) || null,
      entry.detail == null ? null : redactSecrets(String(entry.detail)).slice(0, 500),
    );
    // Lazy retention pruning (cheap: indexed range delete, no job runner needed).
    db.prepare('DELETE FROM audit_logs WHERE timestamp < ?').run(now - AUDIT_TTL_MS);
    return true;
  } catch (error) {
    console.warn('Audit log write failed:', error?.message || error);
    return false;
  }
}

function listAuditLogs(db, { limit = 100 } = {}) {
  try {
    if (!db) return [];
    const rows = db.prepare(
      `SELECT event, token_id AS tokenId, operation, timestamp, success, client, detail
       FROM audit_logs ORDER BY timestamp DESC LIMIT ?`
    ).all(Math.max(1, Math.min(1000, Number(limit) || 100)));
    return rows.map((row) => ({ ...row, success: row.success === 1 }));
  } catch (error) {
    console.warn('Audit log read failed:', error?.message || error);
    return [];
  }
}

module.exports = {
  AUDIT_EVENTS,
  AUDIT_TTL_MS,
  writeAuditLog,
  listAuditLogs,
};
