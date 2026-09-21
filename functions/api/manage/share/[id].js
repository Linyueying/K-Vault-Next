/**
 * 分享配置写入接口 —— `POST /api/manage/share/:id`
 *
 * 这是「条目级分享」的唯一写入口，取代了此前只在首页大面板里做「开关式分享」
 * 的做法。一次调用可完成三件事，由 `action` 决定：
 *
 *   · `create` —— 建立分享（可同时带有效期 / 密码 / 次数 / 自定义短链）
 *   · `update` —— 字段级增量修改；未提及的字段保持原值
 *   · `revoke` —— 彻底取消分享，删除短链映射与全部分享元数据
 *
 * ## 增量语义与 `-1` 哨兵
 *
 * 请求体字段有三种状态，必须分清楚：
 *
 *   · **未出现**（`undefined`）—— 保持不变
 *   · **`-1`**           —— 保持不变（显式写法，便于表单原样回传）
 *   · **`0` / `''` / `null`** —— 清除该设置（不限次数 / 去掉密码 / 恢复自动短链）
 *   · **具体值**          —— 设置为该值
 *
 * `-1` 之所以要单独拦下来：`parseShareOptions()` 最终走 `parsePositiveInt()`，
 * 而它把负数夹到 `min`（`-1` → `1`）。直接喂进去会把「不要改」误解成
 * 「改成 1」。这里在解析之前就消化掉哨兵，只把真值交给 `patchShareOptions()`。
 *
 * ## 鉴权
 *
 * 本文件位于 `/api/manage/**` 之下，`functions/api/manage/_middleware.js`
 * 已完成管理员鉴权（Cookie session 或 Basic Auth），并对未配置
 * `BASIC_USER` / `BASIC_PASS` 的情况 fail-closed。因此这里不重复鉴权。
 *
 * @module api/manage/share
 */

import { getRecordWithKey } from '../../../utils/file-record.js';
import {
  buildShareSummary,
  clearShareOptions,
  findShareSlugOwner,
  hasActiveShare,
  patchShareOptions,
  sanitizeShareSlug,
} from '../../../utils/share-options.js';
import { shouldWriteTelegramMetadata } from '../../../utils/telegram.js';

/** 与 `share-options.js` 的上限保持一致，避免两处漂移。 */
const MAX_EXPIRES_IN_SECONDS = 3650 * 24 * 3600;
const MAX_DOWNLOADS = 1000000000;

/** 哨兵值：表示「保持当前设置不变」。 */
const KEEP = -1;

const VALID_ACTIONS = new Set(['create', 'update', 'revoke']);

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed. Use POST.' }, 405);
  }
  if (!env?.img_url) {
    return jsonResponse({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

  let fileId = params?.id;
  if (Array.isArray(fileId)) fileId = fileId.join('/');
  if (!fileId) return jsonResponse({ success: false, error: 'Missing file id.' }, 400);
  try {
    fileId = decodeURIComponent(fileId);
  } catch {
    /* 解码失败时按原样查找，与其它路由一致 */
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON body.' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ success: false, error: 'Request body must be a JSON object.' }, 400);
  }

  const action = String(body.action || 'create').trim().toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    return jsonResponse(
      { success: false, error: `Unknown action "${action}". Expected create, update or revoke.` },
      400
    );
  }

  try {
    // ---------- 1. 定位文件 ----------
    const { record, kvKey } = await getRecordWithKey(env, fileId);
    if (!record?.metadata) {
      return jsonResponse({ success: false, error: `File not found: ${fileId}` }, 404);
    }

    const metadata = record.metadata;
    const storageType = String(metadata.storageType || metadata.storage || 'telegram').toLowerCase();

    // ---------- 2. revoke 分支 ----------
    if (action === 'revoke') {
      const nextMetadata = await clearShareOptions(env, kvKey, metadata);
      return jsonResponse({
        success: true,
        action,
        fileId,
        kvKey,
        active: false,
        revoked: true,
        share: null,
        sharePath: '',
        // 计数被刻意保留：见 share-options.js 中 clearShareOptions 的注释。
        shareDownloadCount: Number(nextMetadata.shareDownloadCount) || 0,
      });
    }

    // ---------- 3. 存储后端能力校验 ----------
    // Telegram 的分享字段寄存在消息 caption 里；关闭元数据写入时无处可存。
    // 静默丢弃会让用户以为分享成功了，因此明确拒绝。
    if (storageType === 'telegram' && !shouldWriteTelegramMetadata(env)) {
      return jsonResponse(
        {
          success: false,
          error: 'SHARE_UNSUPPORTED_STORAGE',
          message:
            'Telegram 元数据写入已关闭，无法保存分享设置。请在环境变量中启用 TELEGRAM_METADATA_MODE。',
        },
        409
      );
    }

    // ---------- 4. 解析并校验参数 ----------
    const errors = [];
    const patch = {};

    if (hasField(body, 'expiresIn')) {
      const parsed = resolvePositive(body.expiresIn, {
        label: '有效期',
        unitHint: '（0 表示永久）',
        max: MAX_EXPIRES_IN_SECONDS,
        errors,
      });
      if (parsed !== KEEP) patch.expiresIn = parsed;
    }

    if (hasField(body, 'maxDownloads')) {
      const parsed = resolvePositive(body.maxDownloads, {
        label: '下载次数上限',
        unitHint: '（0 表示不限）',
        max: MAX_DOWNLOADS,
        errors,
      });
      if (parsed !== KEEP) patch.maxDownloads = parsed;
    }

    if (hasField(body, 'password')) {
      if (!isKeep(body.password)) {
        const password = String(body.password ?? '');
        if (password.length > 200) {
          errors.push('访问密码过长（最多 200 个字符）。');
        } else {
          patch.password = password;
        }
      }
    }

    if (hasField(body, 'slug')) {
      if (!isKeep(body.slug)) {
        const rawSlug = String(body.slug ?? '').trim();
        if (!rawSlug) {
          patch.slug = '';
        } else {
          const normalized = sanitizeShareSlug(rawSlug);
          if (!normalized) {
            errors.push('短链标识只能包含字母、数字、下划线或短横线。');
          } else {
            patch.slug = normalized;
          }
        }
      }
    }

    if (errors.length) {
      return jsonResponse({ success: false, error: 'VALIDATION_FAILED', messages: errors }, 400);
    }

    // ---------- 5. 短链冲突预检 ----------
    // 同一条目复用自己已有的 slug 不算冲突。patchShareOptions 内部会再查一次
    // 作为并发兜底，这里提前查是为了给出更明确的 409 + 可读文案。
    if (patch.slug) {
      const owner = await findShareSlugOwner(env, patch.slug);
      if (owner && owner !== String(kvKey)) {
        return jsonResponse(
          {
            success: false,
            error: 'SLUG_CONFLICT',
            message: `短链标识 "${patch.slug}" 已被其他文件占用。`,
            slug: patch.slug,
          },
          409
        );
      }
    }

    // ---------- 6. 写入 ----------
    const storedMetadata = await patchShareOptions(env, kvKey, metadata, patch);
    const summary = buildShareSummary(storedMetadata, kvKey);

    return jsonResponse({
      success: true,
      action,
      fileId,
      kvKey,
      active: hasActiveShare(storedMetadata),
      share: summary || null,
      shareSlug: sanitizeShareSlug(storedMetadata.shareSlug || ''),
      sharePath: summary?.sharePath || '',
      shareExpiresAt: summary?.shareExpiresAt || null,
      shareMaxDownloads: summary?.shareMaxDownloads || null,
      sharePasswordProtected: Boolean(storedMetadata.sharePasswordHash),
      shareDownloadCount: Number(storedMetadata.shareDownloadCount) || 0,
    });
  } catch (error) {
    console.error('Share config error:', error);
    const message = error?.message || 'Unknown error';
    // patchShareOptions 在并发改名抢同一 slug 时抛出的兜底错误
    if (/已被占用/.test(message)) {
      return jsonResponse({ success: false, error: 'SLUG_CONFLICT', message }, 409);
    }
    return jsonResponse({ success: false, error: message }, 500);
  }
}

/** 字段是否出现在请求体里（`null` 也算出现 —— 表示「清除」）。 */
function hasField(body, name) {
  return Object.prototype.hasOwnProperty.call(body, name);
}

/** 是否为「保持不变」哨兵。 */
function isKeep(raw) {
  return raw === KEEP || raw === '-1';
}

/**
 * 归一化一个「非负整数」字段。
 * @returns 归一化后的数值，或 `KEEP`（表示保持不变 / 校验失败）。
 */
function resolvePositive(raw, { label, unitHint = '', max, errors }) {
  if (isKeep(raw)) return KEEP;
  if (raw === null || raw === '' || raw === 0 || raw === '0') return 0;

  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) {
    errors.push(`${label}必须是整数${unitHint}。`);
    return KEEP;
  }
  if (parsed < 0) {
    errors.push(`${label}不能为负数。`);
    return KEEP;
  }
  if (parsed > max) {
    errors.push(`${label}超出允许范围。`);
    return KEEP;
  }
  return parsed;
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  });
}
