/**
 * 密码库独立存储层（D1 优先 + KV 兜底 + 乐观锁 CAS + 旧版 Paste 自动迁移）。
 *
 * ============================================================================
 * 架构演进（第一性原理）
 * ============================================================================
 *
 * 旧版密码库借道 Pastebin（`POST /api/manage/paste` 创建新随机 ID + `DELETE` 旧 ID），
 * 存在多处结构性缺陷：
 *   1. 每次保存都会更换资源 ID，多设备本地缓存的旧 ID 指针易陈旧分叉；
 *   2. 新设备扫描仅取前 50 条 paste，普通粘贴增多后会漏扫密码库并触发重复建库；
 *   3. 缺乏服务端单调版本号（revision）与原子 CAS，多端并发写入会静默互相覆盖；
 *   4. 密文混入公共粘贴列表，易在 paste.html 被误删。
 *
 * 新架构将密码库提升为一等独立资源：
 *   - 固定逻辑主键 `vaultKey`（当前默认 `'default'`，便于二次开发扩展至多用户 `userId`）；
 *   - 单调递增整型 `revision` + 原子 Compare-And-Swap（`expectedRevision`），冲突返回 409 与服务端最新密文供客户端解密合并；
 *   - D1 写入失败直接抛错，绝不静默返回成功；
 *   - 首次读取若尚无规范记录，自动扫描历史 `language = 'kvault-vault-v1'` 粘贴并零损迁移至 `revision = 1`。
 *
 * @module vault-store
 */

import { changedCount } from './d1-result.js';
import { ensureSchema } from './schema.js';

export const DEFAULT_VAULT_KEY = 'default';
export const MAX_VAULT_BYTES = 2 * 1024 * 1024; // 2 MiB
const KV_VAULT_PREFIX = 'vault:record:';
const LEGACY_PASTE_PREFIX = 'paste:';
const LEGACY_VAULT_LANGUAGE = 'kvault-vault-v1';

function isD1Enabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
}

function isKvEnabled(env) {
  return Boolean(env && env.img_url && typeof env.img_url.get === 'function');
}

function normalizeVaultKey(raw) {
  const key = String(raw || DEFAULT_VAULT_KEY).trim();
  if (!key || !/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) {
    return DEFAULT_VAULT_KEY;
  }
  return key;
}

function normalizeDeviceId(raw) {
  return String(raw || '').trim().slice(0, 80);
}

function kvKey(vaultKey) {
  return `${KV_VAULT_PREFIX}${vaultKey}`;
}

/**
 * 校验零知识密文信封结构，返回规范化后的对象与序列化文本/字节数。
 * 服务端永远无法、也不尝试解密密文，仅校验外层结构与体积上限。
 */
export function validateVaultEnvelope(rawEnvelope) {
  let envelope = rawEnvelope;
  if (typeof envelope === 'string') {
    try {
      envelope = JSON.parse(envelope);
    } catch {
      throw Object.assign(new Error('密文信封不是有效的 JSON。'), { status: 400 });
    }
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw Object.assign(new Error('密文信封格式无效。'), { status: 400 });
  }
  if (Number(envelope.v) !== 1) {
    throw Object.assign(new Error('不支持的密码库信封版本。'), { status: 400 });
  }
  if (!envelope.kdf || !envelope.kdf.salt || !Number(envelope.kdf.iterations)) {
    throw Object.assign(new Error('密文信封缺少 KDF 参数。'), { status: 400 });
  }
  if (!envelope.enc || !envelope.enc.iv || typeof envelope.ct !== 'string' || !envelope.ct) {
    throw Object.assign(new Error('密文信封缺少加密数据。'), { status: 400 });
  }

  const serialized = JSON.stringify(envelope);
  const byteSize = new TextEncoder().encode(serialized).byteLength;
  if (byteSize > MAX_VAULT_BYTES) {
    throw Object.assign(new Error('密码库体积超过 2 MiB 上限，请清理冗余记录或导出备份。'), { status: 413 });
  }

  return { envelope, serialized, byteSize };
}

function parseStoredEnvelope(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && Number(parsed.v) === 1 && parsed.ct ? parsed : null;
  } catch {
    return null;
  }
}

function formatRecord(row, { metaOnly = false } = {}) {
  if (!row) {
    return {
      exists: false,
      revision: 0,
      updatedAt: 0,
      updatedBy: '',
      byteSize: 0,
      ...(metaOnly ? {} : { envelope: null }),
    };
  }
  const base = {
    exists: true,
    revision: Number(row.revision) || 1,
    updatedAt: Number(row.updatedAt ?? row.updated_at) || 0,
    updatedBy: String(row.updatedBy ?? row.updated_by ?? ''),
    byteSize: Number(row.byteSize ?? row.byte_size) || 0,
  };
  if (metaOnly) return base;
  return {
    ...base,
    envelope: parseStoredEnvelope(row.envelope),
  };
}

/* ============================================================================
 * 旧版 Pastebin 密码库零损自动迁移（仅在规范存储尚无记录时触发）
 * ============================================================================ */

function envelopeTimestamp(env, fallbackTs) {
  const metaTs = Number(env && env.meta && env.meta.updatedAt) || 0;
  return metaTs > 0 ? metaTs : (Number(fallbackTs) || 0);
}

async function scanLegacyVaultCandidates(env) {
  const candidates = [];
  const now = Date.now();

  // 1) D1 pastes 表扫描
  if (isD1Enabled(env)) {
    try {
      const rows = await env.DB.prepare(
        `SELECT paste_id, content, created_at
           FROM pastes
          WHERE language = ? AND (expires_at = 0 OR expires_at > ?)
          ORDER BY created_at DESC
          LIMIT 25`
      ).bind(LEGACY_VAULT_LANGUAGE, now).all();
      for (const r of rows?.results || []) {
        const parsed = parseStoredEnvelope(r.content);
        if (parsed) {
          candidates.push({
            envelope: parsed,
            score: envelopeTimestamp(parsed, r.created_at),
            source: 'd1-paste:' + r.paste_id,
          });
        }
      }
    } catch (error) {
      console.warn('[vault-store] legacy D1 paste scan skipped:', error?.message || error);
    }
  }

  // 2) KV paste: 前缀全量扫描（兼容尚未迁入 D1 的老实例）
  if (isKvEnabled(env)) {
    try {
      let cursor = undefined;
      let guard = 0;
      const legacyKeys = [];
      do {
        const page = await env.img_url.list({
          prefix: LEGACY_PASTE_PREFIX,
          limit: 1000,
          cursor,
        });
        for (const k of page.keys || []) {
          const lang = String(k?.metadata?.language || '').toLowerCase();
          if (lang === LEGACY_VAULT_LANGUAGE || !k?.metadata?.language) {
            legacyKeys.push(k);
          }
        }
        cursor = page.list_complete ? undefined : page.cursor;
        guard += 1;
      } while (cursor && guard < 100);

      // 优先检查明确标注了 language 的记录，按 createdAt 倒序取最新 15 条读取内容
      const tagged = legacyKeys
        .filter((k) => String(k?.metadata?.language || '').toLowerCase() === LEGACY_VAULT_LANGUAGE)
        .sort((a, b) => (Number(b?.metadata?.createdAt) || 0) - (Number(a?.metadata?.createdAt) || 0))
        .slice(0, 15);

      for (const k of tagged) {
        const rec = await env.img_url.get(k.name, { type: 'json' });
        if (!rec || rec.language !== LEGACY_VAULT_LANGUAGE) continue;
        const parsed = parseStoredEnvelope(rec.content);
        if (parsed) {
          candidates.push({
            envelope: parsed,
            score: envelopeTimestamp(parsed, rec.createdAt),
            source: 'kv-paste:' + k.name,
          });
        }
      }
    } catch (error) {
      console.warn('[vault-store] legacy KV paste scan skipped:', error?.message || error);
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

async function migrateLegacyVaultIfFound(env, vaultKey) {
  if (vaultKey !== DEFAULT_VAULT_KEY) return null;
  const latest = await scanLegacyVaultCandidates(env);
  if (!latest) return null;

  const { serialized, byteSize } = validateVaultEnvelope(latest.envelope);
  const ts = latest.score || Date.now();

  if (isD1Enabled(env)) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO vault_records (
         vault_key, revision, envelope, updated_at, updated_by, byte_size
       ) VALUES (?, 1, ?, ?, ?, ?)`
    ).bind(vaultKey, serialized, ts, 'legacy-migration', byteSize).run();
    const row = await env.DB.prepare('SELECT * FROM vault_records WHERE vault_key = ? LIMIT 1')
      .bind(vaultKey)
      .first();
    return row || null;
  }

  if (isKvEnabled(env)) {
    const existing = await env.img_url.get(kvKey(vaultKey), { type: 'json' });
    if (existing && existing.envelope) return existing;
    const record = {
      revision: 1,
      envelope: latest.envelope,
      updatedAt: ts,
      updatedBy: 'legacy-migration',
      byteSize,
    };
    await env.img_url.put(kvKey(vaultKey), JSON.stringify(record));
    return record;
  }

  return null;
}

/* ============================================================================
 * 规范读写接口
 * ============================================================================ */

async function readRawRecord(env, vaultKey, { metaOnly = false } = {}) {
  if (isD1Enabled(env)) {
    const schema = await ensureSchema(env);
    if (!schema.ok && !schema.skipped) {
      throw new Error(schema.error || 'D1 schema 初始化失败，无法读取密码库。');
    }
    const sql = metaOnly
      ? 'SELECT vault_key, revision, updated_at, updated_by, byte_size FROM vault_records WHERE vault_key = ? LIMIT 1'
      : 'SELECT vault_key, revision, envelope, updated_at, updated_by, byte_size FROM vault_records WHERE vault_key = ? LIMIT 1';
    const row = await env.DB.prepare(sql).bind(vaultKey).first();
    if (row) return row;

    // D1 表里尚无记录：尝试从 KV 规范键或历史 paste 自动迁移
    if (isKvEnabled(env)) {
      const kvExisting = await env.img_url.get(kvKey(vaultKey), { type: 'json' });
      if (kvExisting && parseStoredEnvelope(kvExisting.envelope)) {
        const { serialized, byteSize } = validateVaultEnvelope(kvExisting.envelope);
        await env.DB.prepare(
          `INSERT OR IGNORE INTO vault_records (
             vault_key, revision, envelope, updated_at, updated_by, byte_size
           ) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          vaultKey,
          Math.max(1, Number(kvExisting.revision) || 1),
          serialized,
          Number(kvExisting.updatedAt) || Date.now(),
          normalizeDeviceId(kvExisting.updatedBy) || 'kv-migration',
          byteSize
        ).run();
        return await env.DB.prepare(sql).bind(vaultKey).first();
      }
    }

    const migrated = await migrateLegacyVaultIfFound(env, vaultKey);
    return migrated || null;
  }

  if (isKvEnabled(env)) {
    const existing = await env.img_url.get(kvKey(vaultKey), { type: 'json' });
    if (existing && parseStoredEnvelope(existing.envelope)) return existing;
    const migrated = await migrateLegacyVaultIfFound(env, vaultKey);
    return migrated || null;
  }

  throw new Error('未配置 D1（DB）或 KV（img_url）存储绑定，无法访问密码库。');
}

export async function getVaultRecord(env, { vaultKey = DEFAULT_VAULT_KEY, metaOnly = false } = {}) {
  const key = normalizeVaultKey(vaultKey);
  const raw = await readRawRecord(env, key, { metaOnly });
  return formatRecord(raw, { metaOnly });
}

/**
 * 原子写入密码库（带乐观锁 CAS）。
 *
 * - `expectedRevision === 0`：仅当云端尚无记录时创建（revision = 1），否则返回 conflict + 当前最新记录；
 * - `expectedRevision >= 1`：仅当云端当前 revision 严格等于 `expectedRevision` 时推进至 `revision + 1`，否则返回 conflict + 当前最新记录；
 * - `force === true`：跳过版本比对强制写入（仅用于显式覆盖/重置主密码确认后的场景）。
 */
export async function putVaultRecord(
  env,
  {
    vaultKey = DEFAULT_VAULT_KEY,
    envelope,
    expectedRevision = 0,
    deviceId = '',
    force = false,
  } = {}
) {
  const key = normalizeVaultKey(vaultKey);
  const { envelope: validEnv, serialized, byteSize } = validateVaultEnvelope(envelope);
  const expected = Math.max(0, Math.floor(Number(expectedRevision) || 0));
  const actor = normalizeDeviceId(deviceId);
  const now = Date.now();

  if (isD1Enabled(env)) {
    const schema = await ensureSchema(env);
    if (!schema.ok && !schema.skipped) {
      throw new Error(schema.error || 'D1 schema 初始化失败，无法保存密码库。');
    }

    // 首次创建前检查是否存在可迁移的历史数据，避免新设备误建空库把历史数据藏住
    if (expected === 0 && !force) {
      const preExisting = await readRawRecord(env, key, { metaOnly: false });
      if (preExisting) {
        return {
          ok: false,
          conflict: true,
          current: formatRecord(preExisting, { metaOnly: false }),
        };
      }
    }

    if (force) {
      await env.DB.prepare(
        `INSERT INTO vault_records (
           vault_key, revision, envelope, updated_at, updated_by, byte_size
         ) VALUES (?, 1, ?, ?, ?, ?)
         ON CONFLICT(vault_key) DO UPDATE SET
           revision   = vault_records.revision + 1,
           envelope   = excluded.envelope,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by,
           byte_size  = excluded.byte_size`
      ).bind(key, serialized, now, actor, byteSize).run();

      const saved = await env.DB.prepare(
        'SELECT vault_key, revision, updated_at, updated_by, byte_size FROM vault_records WHERE vault_key = ? LIMIT 1'
      ).bind(key).first();
      return {
        ok: true,
        ...formatRecord(saved, { metaOnly: true }),
      };
    }

    if (expected === 0) {
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO vault_records (
           vault_key, revision, envelope, updated_at, updated_by, byte_size
         ) VALUES (?, 1, ?, ?, ?, ?)`
      ).bind(key, serialized, now, actor, byteSize).run();

      if (changedCount(res) === 1) {
        return {
          ok: true,
          exists: true,
          revision: 1,
          updatedAt: now,
          updatedBy: actor,
          byteSize,
        };
      }

      const current = await env.DB.prepare('SELECT * FROM vault_records WHERE vault_key = ? LIMIT 1')
        .bind(key)
        .first();
      return {
        ok: false,
        conflict: true,
        current: formatRecord(current, { metaOnly: false }),
      };
    }

    const res = await env.DB.prepare(
      `UPDATE vault_records
          SET revision   = revision + 1,
              envelope   = ?,
              updated_at = ?,
              updated_by = ?,
              byte_size  = ?
        WHERE vault_key = ? AND revision = ?`
    ).bind(serialized, now, actor, byteSize, key, expected).run();

    if (changedCount(res) === 1) {
      return {
        ok: true,
        exists: true,
        revision: expected + 1,
        updatedAt: now,
        updatedBy: actor,
        byteSize,
      };
    }

    const current = await env.DB.prepare('SELECT * FROM vault_records WHERE vault_key = ? LIMIT 1')
      .bind(key)
      .first();
    return {
      ok: false,
      conflict: true,
      current: formatRecord(current, { metaOnly: false }),
    };
  }

  if (isKvEnabled(env)) {
    const existing = await readRawRecord(env, key, { metaOnly: false });
    const currentRev = existing ? Math.max(1, Number(existing.revision) || 1) : 0;

    if (!force && currentRev !== expected) {
      return {
        ok: false,
        conflict: true,
        current: formatRecord(existing, { metaOnly: false }),
      };
    }

    const nextRev = currentRev + 1;
    const record = {
      revision: nextRev,
      envelope: validEnv,
      updatedAt: now,
      updatedBy: actor,
      byteSize,
    };
    await env.img_url.put(kvKey(key), JSON.stringify(record));
    return {
      ok: true,
      exists: true,
      revision: nextRev,
      updatedAt: now,
      updatedBy: actor,
      byteSize,
    };
  }

  throw new Error('未配置 D1（DB）或 KV（img_url）存储绑定，无法保存密码库。');
}

export async function deleteVaultRecord(env, { vaultKey = DEFAULT_VAULT_KEY } = {}) {
  const key = normalizeVaultKey(vaultKey);
  let deleted = false;

  if (isD1Enabled(env)) {
    const schema = await ensureSchema(env);
    if (!schema.ok && !schema.skipped) {
      throw new Error(schema.error || 'D1 schema 初始化失败，无法删除密码库。');
    }
    const res = await env.DB.prepare('DELETE FROM vault_records WHERE vault_key = ?')
      .bind(key)
      .run();
    deleted = changedCount(res) > 0;
  }

  if (isKvEnabled(env)) {
    const existing = await env.img_url.get(kvKey(key));
    if (existing != null) {
      await env.img_url.delete(kvKey(key));
      deleted = true;
    }
  }

  return { ok: true, deleted };
}
