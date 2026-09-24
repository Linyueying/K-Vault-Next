/**
 * 合集分享写入接口 —— `POST /api/manage/share-bundle`
 *
 * 与 `share/[id].js`（单文件分享）平行的一套写入口，一次性管理**一个合集**。
 * 由 `action` 决定行为：
 *
 *   · `create` —— 建立合集：把一组文件聚合成一个 `/s/:slug` 分享链接
 *   · `update` —— 修改合集的参数 / 成员（未提及的字段保持原值）
 *   · `revoke` —— 彻底取消：删除合集与 slug 索引
 *
 * ## 为什么是独立接口而不是扩展 `share/[id].js`
 *
 * 单文件分享的路径参数 `:id` 天然限定了"一个文件"。合集的成员是数组，
 * 塞进同一条路由会让 `:id` 语义在两种形态间摆动。更重要的是**写目标不同**：
 * 单文件分享写进文件自己的 KV metadata，合集写进独立的 `bundle:<slug>`。
 * 分成两个端点，两边各自的校验、错误码与回滚逻辑都能保持简单直白。
 *
 * ## 「部分成功」语义
 *
 * 成员文件里可能有已被删除的。这里**不**让整批失败：能解析的文件照常进合集，
 * 解析不到的通过 `missing[]` 明确回报，前端汇总展示。
 *
 * 之所以不做静默丢弃：用户选了 10 个文件、其中 1 个刚好被删，如果接口默默
 * 建出 9 个文件的合集并返回 200，用户会以为 10 个都成功了 —— 这种"看起来
 * 成功"的失败比直接报错危险得多。
 *
 * ## 鉴权
 *
 * 位于 `/api/manage/**` 之下，`_middleware.js` 已完成管理员鉴权
 * （Cookie session 或 Basic Auth），且未配置 BASIC_USER/BASIC_PASS 时
 * fail-closed。此处不重复鉴权。
 *
 * @module api/manage/share-bundle
 */

import {
  MAX_BUNDLE_FILES,
  buildBundlePasswordFields,
  buildBundleSlug,
  deleteBundle,
  isBundleSlugAvailable,
  parseBundleOptions,
  readBundle,
  readBundleFileIds,
  resolveBundleFileIds,
  writeBundle,
} from '../../utils/share-bundle.js';

const VALID_ACTIONS = new Set(['create', 'update', 'revoke']);

/** 自动生成短链时的最大重试次数。 */
const SLUG_ATTEMPTS = 5;

/**
 * 取一个尚未被占用的合集短链。
 *
 * `buildBundleSlug()` 只有 4 位时间戳 + 4 位随机，单次碰撞概率虽低但
 * 不能忽略（合集与文件短链共用一个命名空间）。这里重试有限次，
 * 而不是无限循环 —— 真的连续撞上说明命名空间接近饱和，
 * 此时应快速失败让调用方稍后重试，而不是把请求挂住。
 *
 * @param env - Pages 环境。
 * @returns 可用短链；连续 {@link SLUG_ATTEMPTS} 次都撞则返回空串。
 */
async function pickAvailableBundleSlug(env) {
  for (let i = 0; i < SLUG_ATTEMPTS; i += 1) {
    const candidate = buildBundleSlug();
    if (candidate && (await isBundleSlugAvailable(env, candidate))) return candidate;
  }
  return '';
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed. Use POST.' }, 405);
  }
  if (!env?.img_url) {
    return jsonResponse({ success: false, error: 'KV binding img_url is not configured.' }, 500);
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
    if (action === 'revoke') return await handleRevoke(env, body);
    return await handleWrite(env, body, action);
  } catch (error) {
    console.error('Share bundle error:', error);
    return jsonResponse({ success: false, error: error?.message || 'Unknown error' }, 500);
  }
}

/* ============================================================
 * revoke
 * ============================================================ */

async function handleRevoke(env, body) {
  const slug = String(body.slug || '').trim().toLowerCase();
  if (!slug) {
    return jsonResponse({ success: false, error: 'Missing slug.' }, 400);
  }

  const existing = await readBundle(env, slug);
  if (!existing) {
    return jsonResponse({ success: false, error: `Bundle not found: ${slug}` }, 404);
  }

  await deleteBundle(env, slug);

  return jsonResponse({
    success: true,
    action: 'revoke',
    slug,
    active: false,
    revoked: true,
  });
}

/* ============================================================
 * create / update
 * ============================================================ */

async function handleWrite(env, body, action) {
  const isUpdate = action === 'update';

  // ---------- 1. 定位目标合集（update 必需） ----------
  let current = null;
  if (isUpdate) {
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!slug) return jsonResponse({ success: false, error: 'Missing slug for update.' }, 400);
    current = await readBundle(env, slug);
    if (!current) {
      return jsonResponse({ success: false, error: `Bundle not found: ${slug}` }, 404);
    }
  }

  // ---------- 2. 解析参数 ----------
  const { errors, options } = parseBundleOptions(body);
  if (errors.length) {
    return jsonResponse({ success: false, error: 'VALIDATION_FAILED', messages: errors }, 400);
  }

  // ---------- 3. 成员文件 ----------
  // update 未传 fileIds 时沿用现有成员，实现"只改参数不动成员"。
  const rawFileIds = readBundleFileIds(body);
  const wantsMemberChange = rawFileIds.length > 0;

  if (!isUpdate && !wantsMemberChange) {
    return jsonResponse(
      { success: false, error: 'VALIDATION_FAILED', messages: ['请至少选择一个文件。'] },
      400
    );
  }

  if (rawFileIds.length > MAX_BUNDLE_FILES) {
    return jsonResponse(
      {
        success: false,
        error: 'VALIDATION_FAILED',
        messages: [`单个合集最多包含 ${MAX_BUNDLE_FILES} 个文件。`],
      },
      400
    );
  }

  let fileIds = current?.fileIds || [];
  let missing = [];

  if (wantsMemberChange) {
    const { resolved, missing: missingIds } = await resolveBundleFileIds(env, rawFileIds);
    missing = missingIds;

    if (!resolved.length) {
      // 一个都没解析到：明确失败，而不是建出一个空合集。
      return jsonResponse(
        {
          success: false,
          error: 'NO_VALID_FILES',
          message: '所选文件都不可用，请刷新列表后重试。',
          missing,
        },
        404
      );
    }
    fileIds = resolved.map((item) => String(item.kvKey));
  }

  if (!fileIds.length) {
    return jsonResponse(
      { success: false, error: 'VALIDATION_FAILED', messages: ['合集至少需要一个文件。'] },
      400
    );
  }

  // ---------- 4. 短链 ----------
  // 没指定就自动生成：合集短链是系统产物，用户界面上根本不提供输入框
  // （合集不暴露自定义短链），所以「留空」是正常路径而非错误。
  // 生成后必须查重 —— 与文件短链共用命名空间，随机值可能撞上。
  let slug;
  if (isUpdate) {
    // update 只在显式传了 slug 且与当前不同时才换链。
    const requested = Object.prototype.hasOwnProperty.call(options, 'slug') ? options.slug : '';
    slug = requested && requested !== current.slug ? requested : current.slug;
  } else if (options.slug) {
    slug = options.slug;
  } else {
    slug = await pickAvailableBundleSlug(env);
  }

  if (!slug) {
    return jsonResponse(
      {
        success: false,
        error: 'SLUG_UNAVAILABLE',
        message: '暂时无法分配短链标识，请稍后重试。',
      },
      503
    );
  }

  if (slug !== (current?.slug || '')) {
    const available = await isBundleSlugAvailable(env, slug, {
      excludeBundleSlug: current?.slug || '',
    });
    if (!available) {
      return jsonResponse(
        {
          success: false,
          error: 'SLUG_CONFLICT',
          message: `短链标识 "${slug}" 已被其他分享占用。`,
          slug,
        },
        409
      );
    }
  }

  // ---------- 5. 组装并写入 ----------
  const expiresIn = Object.prototype.hasOwnProperty.call(options, 'expiresIn')
    ? options.expiresIn
    : null;
  const maxDownloads = Object.prototype.hasOwnProperty.call(options, 'maxDownloads')
    ? options.maxDownloads
    : null;

  const nextBundle = {
    slug,
    fileIds,
    createdAt: current?.createdAt || Date.now(),
    downloadCount: current?.downloadCount || 0,
    // 未提及则沿用现值；显式 0 表示清除。
    expiresAt:
      expiresIn === null
        ? current?.expiresAt || 0
        : expiresIn > 0
          ? Date.now() + expiresIn * 1000
          : 0,
    maxDownloads: maxDownloads === null ? current?.maxDownloads || 0 : maxDownloads,
    passwordSalt: current?.passwordSalt || '',
    passwordHash: current?.passwordHash || '',
  };

  if (Object.prototype.hasOwnProperty.call(options, 'password')) {
    if (options.password) {
      const fields = await buildBundlePasswordFields(options.password);
      nextBundle.passwordSalt = fields.passwordSalt;
      nextBundle.passwordHash = fields.passwordHash;
    } else {
      // 空串 = 清除密码，与 share/[id].js 的语义一致。
      nextBundle.passwordSalt = '';
      nextBundle.passwordHash = '';
    }
  }

  const saved = await writeBundle(env, nextBundle);

  return jsonResponse({
    success: true,
    action,
    slug: saved.slug,
    sharePath: `/s/${encodeURIComponent(saved.slug)}`,
    fileIds: saved.fileIds,
    fileCount: saved.fileIds.length,
    // 逐项结果：前端据此汇总展示
    accepted: fileIds.length,
    rejected: missing.length,
    missing,
    expiresAt: saved.expiresAt || null,
    maxDownloads: saved.maxDownloads || null,
    passwordProtected: Boolean(saved.passwordHash),
    createdAt: saved.createdAt || null,
  });
}

/* ============================================================
 * 响应辅助
 * ============================================================ */

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
