/**
 * Audit log for token management events (requirement #12).
 *
 * Events: TOKEN_CREATED, TOKEN_ROTATED, TOKEN_DISABLED, TOKEN_ENABLED,
 *         TOKEN_SCOPE_CHANGED, TOKEN_DELETED, TOKEN_VERIFY_FAILED
 *
 * - Never records full token secrets (redaction applied to detail).
 * - No IP addresses are stored; only a short client tag is kept.
 * - Records live in KV under `audit:<ts>:<rand>` with 180-day TTL.
 * - Audit failures must never break the main request flow.
 */

import { redactSecrets } from './redact.js';

const AUDIT_TTL_SECONDS = 180 * 24 * 3600;

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
};

export async function writeAuditLog(env, entry = {}) {
  try {
    if (!env?.img_url) return false;
    const record = {
      event: String(entry.event || 'UNKNOWN').slice(0, 64),
      tokenId: String(entry.tokenId || '').slice(0, 128) || null,
      operation: String(entry.operation || '').slice(0, 64) || null,
      timestamp: Date.now(),
      success: entry.success !== false,
      client: String(entry.client || '').slice(0, 80) || null,
      detail: entry.detail == null ? null : redactSecrets(String(entry.detail)).slice(0, 500),
    };
    const key = `audit:${Date.now().toString(36)}:${shortRandom()}`;
    await env.img_url.put(key, JSON.stringify(record), {
      expirationTtl: AUDIT_TTL_SECONDS,
    });
    return true;
  } catch (error) {
    console.warn('Audit log write failed:', error?.message || error);
    return false;
  }
}

export async function listAuditLogs(env, { limit = 100 } = {}) {
  if (!env?.img_url) return [];
  const keys = [];
  let cursor;
  let guard = 0;
  do {
    const page = await env.img_url.list({ prefix: 'audit:', limit: 1000, cursor });
    keys.push(...(page.keys || []).map((item) => item.name));
    cursor = page.list_complete ? undefined : page.cursor;
    guard += 1;
  } while (cursor && guard < 100);

  const records = await Promise.all(
    keys.slice(-limit).map(async (key) => {
      try {
        return await env.img_url.get(key, { type: 'json' });
      } catch {
        return null;
      }
    })
  );
  return records.filter(Boolean).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
}
