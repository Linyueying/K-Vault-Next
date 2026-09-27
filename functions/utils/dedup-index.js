/**
 * 内容去重索引（`sha_dup:` → D1 `content_sha`）。
 *
 * ## 为什么要迁
 *
 * 原实现是 KV 键 `sha_dup:<sha>`：每次带 `deduplicate=true` 的上传都要
 * **写一次 + 读一次** KV。而 KV 的免费写额度是 **1000 次/天** —— 全站最窄的
 * 一份额度。去重索引本质上是个缓存，却占着最贵的资源。
 *
 * D1 侧已经有现成的索引：`files.content_sha` 上建了唯一索引
 * （`idx_files_content_sha`），文件记录本来就要写 D1，去重信息随之落库，
 * **不需要额外任何一次写**。
 *
 * ## TTL 语义怎么保住
 *
 * KV 版带 `expirationTtl`（90 天）：窗口过后同一份内容允许重新上传。
 * D1 的列没有 TTL，若不管就是永久去重 —— 语义悄悄变严。
 * 所以查重一律带窗口条件（见 `findByContentSha` 的 `ttlSeconds`），
 * 行为与 KV 版逐一对齐。
 *
 * ## 什么时候还写 KV
 *
 * 只在 **D1 不可用** 时写 —— 那时 `content_sha` 无从查询，去重会整个失效。
 * D1 可用时不写：它是纯冗余，写了只消耗额度。
 *
 * @module dedup-index
 */

import { findByContentSha, isD1Enabled } from './metadata-d1.js';

/** KV 去重索引键前缀（D1 可用时不再写入，仅为兜底保留）。 */
export const DEDUP_KEY_PREFIX = 'sha_dup:';

/**
 * 按内容 SHA 查重。
 *
 * D1 优先，未命中回落 KV。两条路统一成同一形状返回，调用方无需分支。
 *
 * @param {any} env
 * @param {string} sha - 内容 SHA-256 十六进制
 * @param {{ttlSeconds?: number}} options - 去重窗口；0 表示不限
 * @returns {Promise<null|{
 *   source: 'd1'|'kv',
 *   kvKey: string,
 *   fileName: string,
 *   size: number,
 *   mime: string,
 *   storage: string,
 *   uploadedAt: string,
 *   raw: object|null
 * }>}
 */
export async function findDuplicate(env, sha, options = {}) {
  if (!sha) return null;

  const ttlSeconds = Number(options.ttlSeconds) || 0;

  // ---------- 路径 A：D1 ----------
  const hit = await findByContentSha(env, sha, { ttlSeconds });
  if (hit?.record?.metadata) {
    const m = hit.record.metadata;
    const ts = Number(m.TimeStamp) || 0;
    return {
      source: 'd1',
      kvKey: hit.kvKey,
      fileName: String(m.fileName || ''),
      size: Number(m.fileSize) || 0,
      mime: String(m.mime || ''),
      storage: String(m.storageType || m.storage || ''),
      uploadedAt: ts > 0 ? new Date(ts).toISOString() : '',
      raw: null,
    };
  }

  // ---------- 路径 B：KV 兜底 ----------
  // 两个用途：D1 未绑定（回滚态），以及迁移前写入的存量 `sha_dup:` 键。
  if (!env?.img_url) return null;
  try {
    const raw = await env.img_url.get(`${DEDUP_KEY_PREFIX}${sha}`, { type: 'json' });
    if (!raw || typeof raw !== 'object') return null;
    return {
      source: 'kv',
      kvKey: String(raw.publicId || raw.directId || ''),
      fileName: String(raw.fileName || ''),
      size: Number(raw.size) || 0,
      mime: String(raw.mime || ''),
      storage: String(raw.storage || ''),
      uploadedAt: String(raw.uploadedAt || ''),
      raw,
    };
  } catch (error) {
    console.warn('dedup index read failed:', error?.message || error);
    return null;
  }
}

/**
 * 登记去重索引。
 *
 * **D1 可用时直接跳过** —— `content_sha` 列随文件记录一起写入，本身即是
 * 索引，再写一份 KV 纯粹是浪费那 1000 次/天的写额度。
 *
 * @param {any} env
 * @param {string} sha
 * @param {object} payload - 兜底用的原始形态（两个调用点字段不同，故不透传结构）
 * @param {{ttlSeconds?: number}} options
 * @returns {Promise<{written: boolean, reason?: string}>}
 */
export async function recordDuplicate(env, sha, payload, options = {}) {
  if (!sha || !payload) return { written: false, reason: 'missing-input' };

  if (isD1Enabled(env)) return { written: false, reason: 'd1-indexed' };
  if (!env?.img_url) return { written: false, reason: 'no-kv' };

  const ttlSeconds = Number(options.ttlSeconds) || 0;
  try {
    await env.img_url.put(
      `${DEDUP_KEY_PREFIX}${sha}`,
      JSON.stringify(payload),
      ttlSeconds > 0 ? { expirationTtl: ttlSeconds } : {}
    );
    return { written: true };
  } catch (error) {
    console.warn('dedup index write failed:', error?.message || error);
    return { written: false, reason: error?.message };
  }
}
