import { changedCount } from './d1-result.js';

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const PROCESSING_STALE_MS = 15 * 60 * 1000;

const TTL_MS = IDEMPOTENCY_TTL_SECONDS * 1000;
const KV_KEY_PREFIX = 'idem:v2:sha256:';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS api_idempotency (
    token_id TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    status INTEGER,
    response_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY(token_id, idem_key)
  )
`;

function hasD1(env) {
  return Boolean(env?.DB && typeof env.DB.prepare === 'function');
}

function hasKv(env) {
  return Boolean(env?.img_url && typeof env.img_url.get === 'function');
}

function timestamp(value) {
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function kvStoreKey(tokenId, key) {
  return `${KV_KEY_PREFIX}${await sha256Hex(`${String(tokenId)}\0${String(key)}`)}`;
}

function completedResult(row, backend) {
  let body = null;
  try {
    body = typeof row.response_json === 'string' ? JSON.parse(row.response_json) : row.body;
  } catch {
    body = null;
  }
  return {
    state: 'completed',
    status: Number(row.status) || 200,
    body,
    backend,
  };
}

/** Ensure the standalone table exists; the migration remains the production source of truth. */
export async function ensureSchema(env) {
  if (!hasD1(env)) return false;
  await env.DB.prepare(CREATE_TABLE_SQL).run();
  return true;
}

async function selectD1(env, tokenId, key) {
  return env.DB.prepare(`
    SELECT token_id, idem_key, request_hash, state, status, response_json,
           created_at, updated_at, expires_at
    FROM api_idempotency
    WHERE token_id = ? AND idem_key = ?
  `).bind(tokenId, key).first();
}

async function insertD1(env, tokenId, key, requestHash, now) {
  const result = await env.DB.prepare(`
    INSERT INTO api_idempotency (
      token_id, idem_key, request_hash, state, status, response_json,
      created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, 'processing', NULL, NULL, ?, ?, ?)
    ON CONFLICT(token_id, idem_key) DO NOTHING
  `).bind(tokenId, key, requestHash, now, now, now + TTL_MS).run();
  return changedCount(result) === 1;
}

async function beginD1(env, tokenId, key, requestHash, now) {
  // Each retry follows a lost conditional takeover/delete, never a blind retry.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await insertD1(env, tokenId, key, requestHash, now)) {
      return { state: 'acquired', backend: 'd1', lease: now };
    }

    const row = await selectD1(env, tokenId, key);
    if (!row) continue;

    if (row.state === 'completed') {
      if (Number(row.expires_at) > now) {
        if (row.request_hash !== requestHash) {
          return { state: 'conflict', backend: 'd1' };
        }
        return completedResult(row, 'd1');
      }

      // Expired snapshots no longer reserve the key. Only one racer can delete it.
      await env.DB.prepare(`
        DELETE FROM api_idempotency
        WHERE token_id = ? AND idem_key = ? AND state = 'completed' AND expires_at <= ?
      `).bind(tokenId, key, now).run();
      continue;
    }

    if (row.request_hash !== requestHash) {
      return { state: 'conflict', backend: 'd1' };
    }
    if (row.state !== 'processing') {
      return { state: 'processing', backend: 'd1' };
    }

    const updatedAt = Number(row.updated_at) || 0;
    if (now - updatedAt <= PROCESSING_STALE_MS) {
      return { state: 'processing', backend: 'd1' };
    }

    // updated_at doubles as the lease: a stale owner cannot complete/release a takeover.
    const lease = Math.max(now, updatedAt + 1);
    const takeover = await env.DB.prepare(`
      UPDATE api_idempotency
      SET request_hash = ?, state = 'processing', status = NULL, response_json = NULL,
          created_at = ?, updated_at = ?, expires_at = ?
      WHERE token_id = ? AND idem_key = ? AND request_hash = ?
        AND state = 'processing' AND updated_at = ?
    `).bind(
      requestHash, now, lease, now + TTL_MS,
      tokenId, key, requestHash, updatedAt
    ).run();
    if (changedCount(takeover) === 1) {
      return { state: 'acquired', backend: 'd1', lease };
    }
  }

  return { state: 'processing', backend: 'd1' };
}

async function readKv(env, storeKey) {
  const value = await env.img_url.get(storeKey, { type: 'json' });
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

async function beginKv(env, tokenId, key, requestHash, now) {
  if (!hasKv(env)) return { state: 'disabled', backend: 'none' };
  try {
    const storeKey = await kvStoreKey(tokenId, key);
    const row = await readKv(env, storeKey);

    if (row?.state === 'completed' && Number(row.expiresAt) > now) {
      if (row.requestHash !== requestHash) return { state: 'conflict', backend: 'kv' };
      return completedResult(row, 'kv');
    }
    if (row && row.state !== 'completed' && row.requestHash !== requestHash) {
      return { state: 'conflict', backend: 'kv' };
    }
    if (row?.state === 'processing' && now - (Number(row.updatedAt) || 0) <= PROCESSING_STALE_MS) {
      return { state: 'processing', backend: 'kv' };
    }

    // KV has no conditional put. This path is intentionally best-effort only.
    const next = {
      requestHash,
      state: 'processing',
      status: null,
      body: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + TTL_MS,
    };
    await env.img_url.put(storeKey, JSON.stringify(next), { expirationTtl: IDEMPOTENCY_TTL_SECONDS });
    return { state: 'acquired', backend: 'kv', lease: now };
  } catch (error) {
    console.warn('idempotency KV begin failed:', error?.message || error);
    return { state: 'disabled', backend: 'none' };
  }
}

/**
 * Atomically acquire an idempotency key, or return its current conflict/replay state.
 * @returns {Promise<{state:'acquired'|'completed'|'conflict'|'processing'|'disabled',
 *   backend:string, lease?:number, status?:number, body?:any}>}
 */
export async function begin(env, { tokenId = 'anon', key, requestHash, now } = {}) {
  if (!key || !requestHash) return { state: 'disabled', backend: 'none' };
  const at = timestamp(now);
  const normalizedToken = String(tokenId || 'anon');
  const normalizedKey = String(key);
  const normalizedHash = String(requestHash);

  if (hasD1(env)) {
    try {
      await ensureSchema(env);
      return await beginD1(env, normalizedToken, normalizedKey, normalizedHash, at);
    } catch (error) {
      console.warn('idempotency D1 begin failed; using KV:', error?.message || error);
    }
  }
  return beginKv(env, normalizedToken, normalizedKey, normalizedHash, at);
}

async function completeD1(env, tokenId, key, requestHash, status, body, lease, now) {
  const leaseClause = lease == null ? '' : ' AND updated_at = ?';
  const params = [
    status, JSON.stringify(body ?? null), now, now + TTL_MS,
    tokenId, key, requestHash,
  ];
  if (lease != null) params.push(lease);
  const result = await env.DB.prepare(`
    UPDATE api_idempotency
    SET state = 'completed', status = ?, response_json = ?, updated_at = ?, expires_at = ?
    WHERE token_id = ? AND idem_key = ? AND request_hash = ? AND state = 'processing'${leaseClause}
  `).bind(...params).run();
  if (changedCount(result) === 1) return { ok: true, state: 'completed', backend: 'd1' };

  const row = await selectD1(env, tokenId, key);
  if (row?.state === 'completed' && row.request_hash === requestHash) {
    return { ok: true, state: 'completed', backend: 'd1' };
  }
  return {
    ok: false,
    state: row?.request_hash === requestHash ? row.state : 'conflict',
    backend: 'd1',
  };
}

async function completeKv(env, tokenId, key, requestHash, status, body, lease, now) {
  if (!hasKv(env)) return { ok: false, state: 'disabled', backend: 'none' };
  try {
    const storeKey = await kvStoreKey(tokenId, key);
    const row = await readKv(env, storeKey);
    if (row?.state === 'completed' && row.requestHash === requestHash) {
      return { ok: true, state: 'completed', backend: 'kv' };
    }
    if (!row || row.state !== 'processing' || row.requestHash !== requestHash) {
      return { ok: false, state: row?.requestHash === requestHash ? row.state : 'conflict', backend: 'kv' };
    }
    if (lease != null && Number(row.updatedAt) !== Number(lease)) {
      return { ok: false, state: 'processing', backend: 'kv' };
    }

    await env.img_url.put(storeKey, JSON.stringify({
      ...row,
      state: 'completed',
      status,
      body: body ?? null,
      updatedAt: now,
      expiresAt: now + TTL_MS,
    }), { expirationTtl: IDEMPOTENCY_TTL_SECONDS });
    return { ok: true, state: 'completed', backend: 'kv' };
  } catch (error) {
    console.warn('idempotency KV complete failed:', error?.message || error);
    return { ok: false, state: 'disabled', backend: 'none' };
  }
}

/** Save the exact successful response body for 24-hour replay. */
export async function complete(env, {
  tokenId = 'anon', key, requestHash, status = 200, body, lease, now,
} = {}) {
  if (!key || !requestHash) return { ok: false, state: 'disabled', backend: 'none' };
  const at = timestamp(now);
  const normalizedToken = String(tokenId || 'anon');
  const normalizedKey = String(key);
  const normalizedHash = String(requestHash);
  const normalizedStatus = Number(status) || 200;

  if (hasD1(env)) {
    try {
      await ensureSchema(env);
      return await completeD1(
        env, normalizedToken, normalizedKey, normalizedHash,
        normalizedStatus, body, lease, at
      );
    } catch (error) {
      console.warn('idempotency D1 complete failed; using KV:', error?.message || error);
    }
  }
  return completeKv(
    env, normalizedToken, normalizedKey, normalizedHash,
    normalizedStatus, body, lease, at
  );
}

async function releaseD1(env, tokenId, key, requestHash, lease) {
  const leaseClause = lease == null ? '' : ' AND updated_at = ?';
  const params = [tokenId, key, requestHash];
  if (lease != null) params.push(lease);
  const result = await env.DB.prepare(`
    DELETE FROM api_idempotency
    WHERE token_id = ? AND idem_key = ? AND request_hash = ?
      AND state = 'processing'${leaseClause}
  `).bind(...params).run();
  return { ok: changedCount(result) === 1, state: 'released', backend: 'd1' };
}

async function releaseKv(env, tokenId, key, requestHash, lease) {
  if (!hasKv(env)) return { ok: false, state: 'disabled', backend: 'none' };
  try {
    const storeKey = await kvStoreKey(tokenId, key);
    const row = await readKv(env, storeKey);
    if (!row || row.state !== 'processing' || row.requestHash !== requestHash) {
      return { ok: false, state: row?.state || 'missing', backend: 'kv' };
    }
    if (lease != null && Number(row.updatedAt) !== Number(lease)) {
      return { ok: false, state: 'processing', backend: 'kv' };
    }
    await env.img_url.delete(storeKey);
    return { ok: true, state: 'released', backend: 'kv' };
  } catch (error) {
    console.warn('idempotency KV release failed:', error?.message || error);
    return { ok: false, state: 'disabled', backend: 'none' };
  }
}

/** Release only the caller's processing lease so a failed upload can be retried. */
export async function release(env, { tokenId = 'anon', key, requestHash, lease } = {}) {
  if (!key || !requestHash) return { ok: false, state: 'disabled', backend: 'none' };
  const normalizedToken = String(tokenId || 'anon');
  const normalizedKey = String(key);
  const normalizedHash = String(requestHash);

  if (hasD1(env)) {
    try {
      await ensureSchema(env);
      return await releaseD1(env, normalizedToken, normalizedKey, normalizedHash, lease);
    } catch (error) {
      console.warn('idempotency D1 release failed; using KV:', error?.message || error);
    }
  }
  return releaseKv(env, normalizedToken, normalizedKey, normalizedHash, lease);
}
