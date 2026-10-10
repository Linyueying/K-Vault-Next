/**
 * `PATCH /api/v1/file/:id/share` —— 为「已存在的文件」创建 / 修改 / 取消分享。
 *
 * ============================================================================
 * 为什么需要这个端点
 * ============================================================================
 *
 * 在此之前，分享配置只有**两个入口**：
 *
 *   · 上传时附带分享参数（`POST /api/v1/upload` 的 slug / expires_in / ...）；
 *   · 管理后台的条目级面板（`POST /api/manage/share/:id`，走 Cookie/Basic）。
 *
 * 于是「文件已经躺在存储里了，我现在想给它生成一个分享链接」这件事，对
 * API Token / MCP / CLI 用户是**做不到的** —— 唯一的办法是重新上传一份，
 * 而那会产出新文件、浪费存储，还可能因为内容去重没命中去重而留下两份。
 *
 * 本端点是 `api/manage/share/[id].js` 在 v1 侧的对应物，**复用同一套
 * `utils/share-options.js` 逻辑**（增量语义、`-1` 哨兵、slug 冲突检测、
 * 密码哈希、D1 镜像），因此两条入口的行为不会漂移。
 *
 * ============================================================================
 * 与 manage 版的差异（有意为之）
 * ============================================================================
 *
 *   1. **鉴权方式**：Bearer Token + `share` scope（manage 版是管理员会话）。
 *      独立 scope 是刻意的 —— 见 api-token.js 中 VALID_SCOPES 的注释。
 *   2. **支持 `action: 'get'`**：只读查询当前分享配置。manage 版没有，
 *      因为它有独立的列表接口；这里给 Agent 一个「先看看现在是什么样」的
 *      低成本入口，避免它为了查询而走一次写路径。
 *   3. **错误码统一成 v1 风格**（`{success,error:{code,message}}`）。
 *
 * ============================================================================
 * 增量语义（与 manage 版逐字对齐）
 * ============================================================================
 *
 *   · **未出现**（undefined）—— 保持不变
 *   · **`-1`**              —— 保持不变（显式哨兵，便于表单原样回传）
 *   · **`0` / `''` / `null`** —— 清除该设置（不限次数 / 去掉密码 / 恢复自动短链）
 *   · **具体值**             —— 设置为该值
 *
 * `-1` 必须在进入 `parsePositiveInt` 之前拦下：后者把负数夹到 `min`，
 * 会把「不要改」误解成「改成 1」。
 *
 * @module api/v1/file/share
 */

import { getRecordWithKey } from '../../../../utils/file-record.js';
import {
  SHARE_TEXT_LIMITS,
  buildShareSummary,
  clearShareOptions,
  hasActiveShare,
  patchShareOptions,
  sanitizeShareSlug,
  sanitizeShareText,
} from '../../../../utils/share-options.js';
import { shouldWriteTelegramMetadata } from '../../../../utils/telegram.js';
import { apiError, apiSuccess, decodePathParam } from '../../../../utils/api-v1.js';

/** 与 share-options.js 的上限保持一致，避免两处漂移。 */
const MAX_EXPIRES_IN_SECONDS = 3650 * 24 * 3600;
const MAX_DOWNLOADS = 1000000000;

/** 哨兵：表示「保持当前设置不变」。 */
const KEEP = -1;

const VALID_ACTIONS = new Set(['create', 'update', 'revoke', 'get']);

/**
 * 从 `[[path]]` 参数解析文件 ID。
 *
 * 这里有个必须处理的歧义：路由是 `/api/v1/file/<id>/share`，而 `<id>` 自身
 * 可能含斜杠（例如 Telegram 的签名 fileId）。因此不能简单取 `params.path` ——
 * 它会把结尾的 `share` 也包含进来。
 *
 * 解法：拿到拼接后的完整路径，**剥掉结尾的 `/share` 段**，剩下的就是 id。
 */
function resolveFileId(params = {}) {
  const raw = params.path ?? params.id ?? '';
  const joined = Array.isArray(raw) ? raw.join('/') : String(raw || '');
  const decoded = decodePathParam(joined);
  // 去掉结尾的 /share（可能带或不带前导斜杠）
  const stripped = decoded.replace(/\/share\/?$/, '').replace(/^\/+|\/+$/g, '');
  return stripped;
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

/**
 * 把当前分享状态渲染成响应体。
 *
 * `links.share` 与 `links.download` 一起给出：分享链接是 `/s/<slug>`（可带
 * 密码 / 次数 / 有效期约束），直链是 `/file/<id>`（不受分享设置影响）。
 * 两个都给，调用方不必自己拼。
 */
function describeShare(env, metadata, kvKey, fileId, request) {
  const summary = buildShareSummary(metadata, kvKey);
  const active = hasActiveShare(metadata);
  const origin = new URL(request.url).origin;
  const shortId = summary?.shareSlug || kvKey || fileId;

  return {
    active,
    share: summary || null,
    shareSlug: sanitizeShareSlug(metadata?.shareSlug || ''),
    sharePath: summary?.sharePath || '',
    shareExpiresAt: summary?.shareExpiresAt || null,
    shareMaxDownloads: summary?.shareMaxDownloads || null,
    sharePasswordProtected: Boolean(metadata?.sharePasswordHash),
    shareDownloadCount: Number(metadata?.shareDownloadCount) || 0,
    shareTitle: String(metadata?.shareTitle || ''),
    shareDescription: String(metadata?.shareDescription || ''),
    links: {
      share: summary?.sharePath ? `${origin}${summary.sharePath}` : (active ? `${origin}/s/${encodeURIComponent(shortId)}` : null),
      download: `${origin}/file/${encodeURIComponent(fileId)}`,
    },
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = String(request.method || 'GET').toUpperCase();

  if (!env?.img_url) {
    return apiError('SERVER_MISCONFIGURED', 'KV binding img_url is not configured.', 500);
  }

  if (method !== 'PATCH' && method !== 'POST' && method !== 'PUT' && method !== 'GET') {
    return apiError('METHOD_NOT_ALLOWED', '请求方法不被允许。', 405);
  }

  const fileId = resolveFileId(context.params);
  if (!fileId) {
    return apiError('VALIDATION_ERROR', '缺少文件 ID。', 400);
  }

  // GET：只读查询，不改动任何数据。
  if (method === 'GET') {
    const located = await getRecordWithKey(env, fileId);
    if (!located?.record?.metadata) {
      return apiError('FILE_NOT_FOUND', `未找到文件：${fileId}`, 404);
    }
    return apiSuccess({
      fileId,
      kvKey: located.kvKey,
      ...describeShare(env, located.record.metadata, located.kvKey, fileId, request),
    });
  }

  // ---- 以下为写路径 ----
  let body = {};
  try {
    const text = await request.text();
    if (text && text.trim()) {
      body = JSON.parse(text);
    }
  } catch {
    return apiError('BAD_REQUEST', '请求体必须是合法 JSON。', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return apiError('BAD_REQUEST', '请求体必须是 JSON 对象。', 400);
  }

  // GET 查询自带 action，写路径的默认动作是 create（与 manage 版一致）。
  const action = String(body.action || 'create').trim().toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    return apiError('VALIDATION_ERROR', `未知的 action "${action}"，应为 create / update / revoke / get。`, 400);
  }
  if (action === 'get') {
    const located = await getRecordWithKey(env, fileId);
    if (!located?.record?.metadata) {
      return apiError('FILE_NOT_FOUND', `未找到文件：${fileId}`, 404);
    }
    return apiSuccess({
      action,
      fileId,
      kvKey: located.kvKey,
      ...describeShare(env, located.record.metadata, located.kvKey, fileId, request),
    });
  }

  try {
    // ---------- 1. 定位文件 ----------
    const located = await getRecordWithKey(env, fileId);
    if (!located?.record?.metadata) {
      return apiError('FILE_NOT_FOUND', `未找到文件：${fileId}`, 404);
    }
    const { record, kvKey } = located;
    const metadata = record.metadata;
    const storageType = String(metadata.storageType || metadata.storage || 'telegram').toLowerCase();

    // ---------- 2. revoke 分支 ----------
    if (action === 'revoke') {
      const nextMetadata = await clearShareOptions(env, kvKey, metadata);
      return apiSuccess({
        action,
        fileId,
        kvKey,
        revoked: true,
        // 计数被刻意保留：见 share-options.js 中 clearShareOptions 的注释。
        downloadCount: Number(nextMetadata.shareDownloadCount) || 0,
        ...describeShare(env, nextMetadata, kvKey, fileId, request),
      });
    }

    // ---------- 3. 存储后端能力校验 ----------
    // Telegram 的分享字段寄存在消息 caption 里；关闭元数据写入时无处可存。
    // 静默丢弃会让调用方以为分享成功了，因此明确拒绝。
    if (storageType === 'telegram' && !shouldWriteTelegramMetadata(env)) {
      return apiError(
        'SHARE_UNSUPPORTED_STORAGE',
        'Telegram 元数据写入已关闭，无法保存分享设置。请在环境变量中启用 TELEGRAM_METADATA_MODE。',
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

    if (hasField(body, 'password') && !isKeep(body.password)) {
      const password = String(body.password ?? '');
      if (password.length > 200) {
        errors.push('访问密码过长（最多 200 个字符）。');
      } else {
        patch.password = password;
      }
    }

    if (hasField(body, 'slug') && !isKeep(body.slug)) {
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

    // 分享文案：超长**不报错而是截断** —— 标题少几个字不影响分享可用，
    // 让整次提交失败才糟。
    if (hasField(body, 'title') && !isKeep(body.title)) {
      patch.title = sanitizeShareText(body.title, SHARE_TEXT_LIMITS.title);
    }
    if (hasField(body, 'description') && !isKeep(body.description)) {
      patch.description = sanitizeShareText(body.description, SHARE_TEXT_LIMITS.description);
    }

    if (errors.length) {
      return apiError('VALIDATION_FAILED', errors.join(' '), 400, { messages: errors });
    }

    // ---------- 5. 写入（slug 冲突由 patchShareOptions 内部兜底判并抛错） ----------
    const storedMetadata = await patchShareOptions(env, kvKey, metadata, patch);

    return apiSuccess({
      action,
      fileId,
      kvKey,
      ...describeShare(env, storedMetadata, kvKey, fileId, request),
    });
  } catch (error) {
    console.error('v1 share config error:', error);
    const message = error?.message || 'Unknown error';
    // patchShareOptions 在并发抢同一 slug 时抛出的兜底错误
    if (/已被占用/.test(message)) {
      return apiError('SLUG_CONFLICT', message, 409);
    }
    return apiError('SHARE_UPDATE_FAILED', message, 500);
  }
}
