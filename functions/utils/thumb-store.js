/**
 * 缩略图附属对象存储（KV / D1 / R2 三选一）
 * ================================================================
 * 【定位：为什么它不写进文件元数据】
 * 缩略图是「附属对象」—— 它的键由**原文件的 key 纯派生**，因此：
 *   · 不给 files 表加列、不往 KV metadata 加字段
 *   · 上传 / 改名 / 移动 / 分享等既有路径**零改动**
 *   · 只有三处需要关心它：写入（上传后）、读取（/thumb/）、删除（级联）
 *
 * 这带来一个重要的容错性质：**元数据里没有它、原文件照常工作**。
 * 缩略图写失败、读不到、被误删，都只是「这一次用原图」，不会伤到主流程。
 *
 * ================================================================
 * 键名约定（改动前先读这里）
 * ================================================================
 *   KV 附属键    thumb:<fileKey>      例如 thumb:r2:r2_17xx_ab.png
 *   D1 附属表    file_thumbs(id = <fileKey>)  独立表，见 schema.js 的 0013
 *   R2 附属对象  thumb/<fileKey>      例如 thumb/r2:r2_17xx_ab.png
 *
 * 与 utils/chunk-state.js 同源：附属对象一律用「短前缀 + 原 key」表达，
 * 既能按前缀 list 批量清理，也一眼看得出它挂靠在谁身上。
 *
 * ================================================================
 * 【后端选择：显式指定，不自动推断】
 * ================================================================
 * config:thumb 的 backend ∈ { kv（默认）, d1, r2 }。三者平级，用户选哪个就
 * 用哪个 —— **不做 auto 降级**：「缩略图存在哪」直接决定 KV 写额度与读取
 * 延迟，用户需要的是可预测的结果，而不是系统替他猜。
 *
 *   · 未绑定的后端不可选：后台下拉项按实际可用性渲染（见 settings.js 下发的
 *     `thumb.available`）；配置里若残留一个不可用的后端，写入**直接失败**
 *     （reason: 'no-backend'），不会静默换一个地方写。
 *   · 默认 kv：img_url 是必需绑定，所以默认值在任何部署上都能用。
 *
 * 三者的取舍（免费额度）：
 *   KV  写 1k/天、读 10 万/天，读在边缘（快）—— 额度最紧，但永远可用
 *   D1  写 100k 行/天、读 500 万行/天，但读走单 primary，延迟高于边缘
 *   R2  写 100 万/月、读 1000 万/月，读在边缘，最适合图片量大的部署
 */

import { getThumbConfig, DEFAULT_THUMB_BACKEND } from './runtime-config.js';

/** KV 附属键前缀 */
export const THUMB_KV_PREFIX = 'thumb:';
/** R2 附属对象前缀 */
export const THUMB_R2_PREFIX = 'thumb/';
/** D1 附属表名（建表见 schema.js 的 0013_file_thumbs） */
export const THUMB_D1_TABLE = 'file_thumbs';

/**
 * 缩略图体积上限（防御性，非设计约束）。
 * 一张 400px 的 webp 通常 5~40KB；超过 512KB 说明客户端传了异常体积，
 * 宁可拒收，也不让 KV value / D1 行被无谓地吃掉。
 */
export const THUMB_MAX_BYTES = 512 * 1024;

/** 生成 KV 附属键 */
export function thumbKvKey(fileKey) {
  return `${THUMB_KV_PREFIX}${String(fileKey || '')}`;
}

/** 生成 R2 附属对象键 */
export function thumbR2Key(fileKey) {
  return `${THUMB_R2_PREFIX}${String(fileKey || '')}`;
}

/**
 * 从 Pages 路由参数里解析出文件 key。
 *
 * `/thumb/<key>` 与 `/api/thumb/<key>` 两个端点都要做这件事，放这里收敛一份，
 * 避免两处各自 decode 出不同的结果（`file/[[path]].js` 亦用同样的规则）。
 *
 * @param {{path?: string | string[]}} params
 * @returns {string} 规范化后的 key（解析不出来时为空串）
 */
export function parseFileKey(params) {
  let fileId = params?.path ?? '';
  if (Array.isArray(fileId)) fileId = fileId.join('/');
  try {
    fileId = decodeURIComponent(String(fileId));
  } catch {
    /* 非法百分号编码：保留原值，让它自然 miss */
  }
  return String(fileId || '').replace(/^\/+/, '');
}

function hasKv(env) {
  return Boolean(env?.img_url?.put && env?.img_url?.get);
}

function hasD1(env) {
  return Boolean(env?.DB && typeof env.DB.prepare === 'function');
}

function hasR2(env) {
  return Boolean(env?.R2_BUCKET?.put && env?.R2_BUCKET?.get);
}

/**
 * 当前部署**实际可用**的缩略图后端列表，顺序即后台下拉项的展示顺序。
 *
 * 后台据此只渲染「配得上的」选项；thumb-store 内部也用它做判断，
 * 保证「后台能选」与「运行时能用」永远是同一份依据。
 *
 * @param {any} env
 * @returns {Array<'kv' | 'd1' | 'r2'>}
 */
export function availableThumbBackends(env) {
  const list = [];
  if (hasKv(env)) list.push('kv');
  if (hasD1(env)) list.push('d1');
  if (hasR2(env)) list.push('r2');
  return list;
}

/**
 * 选出写入要用的后端。
 *
 * **严格匹配**：配置指定的后端没绑定时返回 null（写入直接失败），而不是
 * 换一个地方写 —— 静默换后端会让「我在后台明明选了 R2」的预期落空，而且
 * 写进 KV 的那一份还会悄悄吃掉稀缺的写额度。
 *
 * @returns {'kv' | 'd1' | 'r2' | null}
 */
function pickWriteBackend(env, configured) {
  const available = availableThumbBackends(env);
  if (!available.length) return null;
  const want = String(configured || DEFAULT_THUMB_BACKEND).toLowerCase();
  return available.includes(want) ? want : null;
}

/**
 * 写入缩略图。
 *
 * **永不抛出**：调用方（上传路径）不应因为缩略图失败而失败，
 * 所有异常都收敛成 `{ ok: false, reason }`。
 *
 * @param {any} env
 * @param {string} fileKey - 原文件的 kvKey（如 `r2:xxx.png`）
 * @param {ArrayBuffer | Uint8Array} bytes - 缩略图字节
 * @param {{contentType?: string}} [options]
 * @returns {Promise<{ok: boolean, backend?: string, reason?: string}>}
 */
export async function putThumb(env, fileKey, bytes, options = {}) {
  if (!fileKey || !bytes) return { ok: false, reason: 'invalid' };

  const size = bytes.byteLength ?? bytes.size ?? 0;
  if (size <= 0) return { ok: false, reason: 'empty' };
  if (size > THUMB_MAX_BYTES) return { ok: false, reason: 'too-large' };

  const config = await getThumbConfig(env).catch(() => null);
  if (config && config.enabled === false) return { ok: false, reason: 'disabled' };

  const backend = pickWriteBackend(env, config?.backend);
  if (!backend) return { ok: false, reason: 'no-backend' };

  const contentType = String(options.contentType || 'image/webp');

  try {
    await writeTo(env, backend, fileKey, bytes, contentType);
    return { ok: true, backend };
  } catch (error) {
    console.warn('putThumb failed:', error?.message || error);
    return { ok: false, reason: 'error' };
  }
}

/**
 * 读取缩略图。
 *
 * @param {any} env
 * @param {string} fileKey
 * @returns {Promise<null | {body: ReadableStream | ArrayBuffer, contentType: string, size: number}>}
 */
export async function getThumb(env, fileKey) {
  if (!fileKey) return null;

  const available = availableThumbBackends(env);
  if (!available.length) return null;

  let backend;
  if (available.length === 1) {
    /* 只有一个后端可用 → **不需要读配置**：唯一选项就是答案。
       这不仅省掉一次 KV 往返，也让「默认 kv 的单后端部署」在图片热路径上
       完全零配置读 —— 而配置缓存只在同 isolate、30 秒内才有效（见
       runtime-config.js 的说明），不该让图片加载依赖这种运气。 */
    backend = available[0];
  } else {
    // 多后端时无从推断，读配置定夺；配置的后端若已被解绑，回落到第一个可用项。
    const config = await getThumbConfig(env).catch(() => null);
    const want = String(config?.backend || DEFAULT_THUMB_BACKEND).toLowerCase();
    backend = available.includes(want) ? want : available[0];
  }

  return await readFrom(env, backend, fileKey);
}

/**
 * 删除缩略图（级联清理用）。
 *
 * **三个后端都清一遍、且永不抛出**：backend 配置可能被改过，旧副本会残留
 * 在别的后端上；只删「当前配置的那个」等于制造永久孤儿（KV / R2 没有针对
 * 它的生命周期规则，D1 也没有外来清理）。删除不存在的记录都是 no-op，
 * 代价可忽略。
 *
 * 注意：D1 表在尚未跑迁移的旧库上会报错，但异常被吞掉且不影响其余后端。
 *
 * @param {any} env
 * @param {string} fileKey
 */
export async function deleteThumb(env, fileKey) {
  if (!fileKey) return;

  const jobs = [];
  if (hasKv(env)) {
    jobs.push(Promise.resolve(env.img_url.delete(thumbKvKey(fileKey))).catch(() => {}));
  }
  if (hasD1(env)) {
    jobs.push(deleteD1Thumb(env, fileKey).catch(() => {}));
  }
  if (hasR2(env)) {
    jobs.push(Promise.resolve(env.R2_BUCKET.delete(thumbR2Key(fileKey))).catch(() => {}));
  }
  await Promise.allSettled(jobs);
}

/* ============================================================================
 * 各后端的实际读写
 * ========================================================================== */

/** 按后端写一份缩略图。异常向上抛，由 putThumb 统一收敛。 */
async function writeTo(env, backend, fileKey, bytes, contentType) {
  if (backend === 'r2') {
    await env.R2_BUCKET.put(thumbR2Key(fileKey), bytes, {
      httpMetadata: {
        contentType,
        // 缩略图内容按 key 恒定（重新生成会覆盖同一个 key），可长缓存。
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });
    return;
  }

  if (backend === 'd1') {
    // upsert：同一 key 重新生成时直接覆盖，不产生第二行。
    await env.DB.prepare(
      `INSERT INTO ${THUMB_D1_TABLE} (id, thumb, content_type, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         thumb = excluded.thumb,
         content_type = excluded.content_type,
         updated_at = excluded.updated_at`
    )
      .bind(fileKey, bytes, contentType, Date.now())
      .run();
    return;
  }

  await env.img_url.put(thumbKvKey(fileKey), bytes, { metadata: { contentType } });
}

/** 从指定后端读一份缩略图，任何异常都吞掉（读不到 = 回退原图，不是错误）。 */
async function readFrom(env, backend, fileKey) {
  try {
    if (backend === 'r2') {
      const object = await env.R2_BUCKET.get(thumbR2Key(fileKey));
      if (!object) return null;
      return {
        body: object.body,
        contentType: object.httpMetadata?.contentType || 'image/webp',
        size: object.size,
      };
    }

    if (backend === 'd1') return await readD1Thumb(env, fileKey);

    const record = await env.img_url.getWithMetadata(thumbKvKey(fileKey), { type: 'arrayBuffer' });
    const value = record?.value;
    if (!value) return null;
    const buffer = value instanceof ArrayBuffer ? value : (value.buffer ?? value);
    return {
      body: buffer,
      contentType: record?.metadata?.contentType || 'image/webp',
      size: buffer.byteLength ?? 0,
    };
  } catch (error) {
    console.warn('readThumb failed:', error?.message || error);
    return null;
  }
}

/**
 * 读 D1 里的一行缩略图。
 *
 * 只 SELECT 这两列（**绝不 `SELECT *`**）：thumb 是 BLOB，
 * 多带一列就是白白多传一份图片字节。
 */
async function readD1Thumb(env, fileKey) {
  const row = await env.DB.prepare(
    `SELECT thumb, content_type FROM ${THUMB_D1_TABLE} WHERE id = ?`
  )
    .bind(fileKey)
    .first();

  const blob = row?.thumb;
  if (!blob) return null;
  const buffer = blob instanceof ArrayBuffer ? blob : (blob.buffer ?? blob);
  return {
    body: buffer,
    contentType: row?.content_type || 'image/webp',
    size: buffer.byteLength ?? 0,
  };
}

async function deleteD1Thumb(env, fileKey) {
  await env.DB.prepare(`DELETE FROM ${THUMB_D1_TABLE} WHERE id = ?`).bind(fileKey).run();
}
