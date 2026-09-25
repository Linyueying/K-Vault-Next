/**
 * 分享元信息接口 —— `GET /api/share-info?s=<slug 或文件 ID>` 或 `?b=<合集 slug>`
 *
 * `share.html` 用来渲染分享页的**唯一**数据来源。刻意保持公开（无需登录）：
 * 分享链接本身就是凭证，要求登录才能看元信息会让分享失去意义。
 *
 * 两条互斥入口：
 *   · `s` —— 单文件分享（自定义短链或文件 ID），见文件末尾的单文件分支
 *   · `b` —— 合集分享（多个文件聚合成一个链接），见 {@link respondBundle}
 *
 * 两者的状态码契约**完全一致**，`share.html` 得以共用同一套分支逻辑。
 *
 * ## 返回什么、不返回什么
 *
 * 返回：文件名、大小、类型、**可访问的文件 URL**、有效期、次数上限与已用量、
 * 是否设了密码。
 *
 * **绝不返回**：
 *   · 裸 `fileId` / KV key —— 拿到它就能绕过短链直接访问 `/file/...`，
 *     从而避开计数（虽然次数校验仍在 file 路由，但不外泄内部标识是底线）
 *   · `sharePasswordHash` / `sharePasswordSalt` —— 盐泄露会显著降低离线爆破成本
 *   · `shareSlug` 之外的任何内部键
 *
 * ## 状态码契约（share.html 依赖它做分支）
 *
 * | 码  | 场景                        |
 * |-----|-----------------------------|
 * | 200 | 可访问 / 密码校验通过        |
 * | 401 | 需要密码（`SHARE_PASSWORD_REQUIRED`） |
 * | 403 | 密码错误（`SHARE_PASSWORD_INVALID`）  |
 * | 410 | 已过期 / 超出次数上限        |
 * | 404 | 短链不存在，或该文件未开启分享 |
 *
 * 响应一律带 `Cache-Control: no-store`。带密码的 200 响应若被浏览器缓存，
 * 后续同机其他用户就能白拿。
 *
 * @module api/share-info
 */

import { getRecordWithKey } from '../utils/file-record.js';
import {
  buildShareRecord,
  findShareSlugOwner,
  sanitizeShareSlug,
  verifySharePassword,
} from '../utils/share-options.js';
import {
  isBundleExhausted,
  isBundleExpired,
  listFolderMembersLive,
  readBundle,
  verifyBundlePassword,
} from '../utils/share-bundle.js';

/**
 * 记录是否「开通（或曾开通）过分享」。
 *
 * 与 `hasActiveShare()` 的关键区别：**已过期不算未开通**。
 * 过期链接必须能走到 410 分支，而不是被当成 404 抹掉。
 *
 * 注意这里**不能**把 `shareDownloadCount` 算作分享字段：
 * `clearShareOptions()` 取消分享时会刻意保留计数（防止「取消再分享」绕过
 * 次数上限），因此「只剩计数」恰恰是**已取消**的典型形态。把它当作开通
 * 证据会让取消后的链接继续返回 200，等于分享没被真正关掉。
 *
 * @param metadata - KV 元数据。
 */
function hasAnyShareField(metadata = {}) {
  if (!metadata) return false;
  return Boolean(
    sanitizeShareSlug(metadata.shareSlug || '')
    || Number(metadata.shareExpiresAt) > 0
    || Number(metadata.shareMaxDownloads) > 0
    || metadata.sharePasswordHash
  );
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);
  }

  if (!env?.img_url) {
    return jsonResponse({ error: 'SHARE_UNAVAILABLE', message: 'KV binding img_url is not configured.' }, 500);
  }

  const url = new URL(request.url);

  // ---------- 合集分支 ----------
  // `?b=<slug>` 与 `?s=<slug|fileId>` 是两条互斥的入口：`b` 专指合集，
  // `s` 保持单文件语义不变。刻意不用「先试 b 再回落 s」的猜测式解析 ——
  // 那会让一个写错的 `b` 参数静默变成对同名文件的查找，错误难以定位。
  const bundleSlug = String(url.searchParams.get('b') || '').trim();
  if (bundleSlug) {
    if (bundleSlug.length > 128) {
      return jsonResponse({ error: 'SHARE_NOT_FOUND', message: 'Invalid share identifier.' }, 404);
    }
    return await respondBundle(env, bundleSlug, url, request);
  }

  const rawValue = String(url.searchParams.get('s') || url.searchParams.get('slug') || '').trim();
  if (!rawValue) {
    return jsonResponse({ error: 'SHARE_NOT_FOUND', message: 'Missing share identifier.' }, 404);
  }
  if (rawValue.length > 128) {
    return jsonResponse({ error: 'SHARE_NOT_FOUND', message: 'Invalid share identifier.' }, 404);
  }

  try {
    // ---------- 1. 解析标识：先当自定义短链查映射，未命中再当文件 ID ----------
    // 与 `functions/s/[slug].js` 的行为保持一致，保证「自定义短链」与
    // 「/s/<文件ID>」两类链接都能打开。
    let fileId = rawValue;
    const normalizedSlug = sanitizeShareSlug(rawValue);
    if (normalizedSlug) {
      const mapped = await findShareSlugOwner(env, normalizedSlug);
      if (mapped) fileId = mapped;
    }

    // ---------- 2. 定位记录 ----------
    const { record, kvKey } = await getRecordWithKey(env, fileId);
    if (!record?.metadata) {
      return jsonResponse({ error: 'SHARE_NOT_FOUND', message: '分享链接不存在。' }, 404);
    }

    const metadata = record.metadata;

    // ---------- 2.5 是否真的开启过分享 ----------
    //
    // 这里不能用 `hasActiveShare()`：它把「已过期」也算作「没有分享」，
    // 于是过期链接会得到 404「链接不存在」，而不是 410「链接已过期」。
    // 对访问者来说两者差别很大 —— 404 让人以为链接写错了，会反复重试；
    // 410 才说得清「链接曾经有效，现在到期了」。
    //
    // 因此改用「是否残留任何一个分享字段」来判断开通状态，把过期的判定
    // 交给下一步，让它有机会返回 410。
    if (!hasAnyShareField(metadata)) {
      return jsonResponse({ error: 'SHARE_NOT_FOUND', message: '分享链接不存在。' }, 404);
    }

    // ---------- 3. 有效期 ----------
    const expiresAt = Number(metadata.shareExpiresAt) || 0;
    if (expiresAt > 0 && Date.now() > expiresAt) {
      return jsonResponse(
        {
          error: 'SHARE_EXPIRED',
          message: '分享链接已过期。',
          expiresAt,
        },
        410
      );
    }

    // ---------- 4. 密码 ----------
    // 密码校验放在次数校验之前：未通过密码验证的访问者不应获得
    // 「还剩几次」这类信息。同时 401/403 都要在耗尽检查之前返回，
    // 否则「已耗尽」会变成一个无需密码即可探测的公开事实。
    const providedPassword =
      url.searchParams.get('password') || request.headers.get('X-Share-Password') || '';

    const passwordState = await verifySharePassword(metadata, providedPassword);
    if (passwordState === 'missing') {
      return jsonResponse(
        {
          error: 'SHARE_PASSWORD_REQUIRED',
          passwordProtected: true,
        },
        401
      );
    }
    if (passwordState === 'invalid') {
      return jsonResponse(
        {
          error: 'SHARE_PASSWORD_INVALID',
          message: '访问密码不正确。',
          passwordProtected: true,
        },
        403
      );
    }

    // ---------- 5. 次数上限 ----------
    const shareRecord = await buildShareRecord(env, metadata, kvKey);
    if (shareRecord.exhausted) {
      return jsonResponse(
        {
          error: 'SHARE_LIMIT_REACHED',
          message: '分享链接的下载次数已用尽。',
          maxDownloads: shareRecord.shareMaxDownloads,
          downloadCount: shareRecord.downloadCount,
        },
        410
      );
    }

    // ---------- 6. 组装响应 ----------
    // fileUrl 走 `/file/<kvKey>`：kvKey 是内部标识，但它是访问文件流所必需的。
    // 这里之所以敢返回，是因为它对**已通过密码校验的访问者**才可见，
    // 而这正是分享链接持有者的权限范围。
    const fileUrl = `/file/${encodeURIComponent(kvKey)}`;

    return jsonResponse({
      success: true,
      fileName: shareRecord.fileName,
      fileSize: shareRecord.fileSize,
      fileType: shareRecord.fileType,
      fileUrl,
      // 若该文件设了密码，访问者后续请求文件流必须带上，否则 file 路由会 401
      filePasswordRequired: Boolean(metadata.sharePasswordHash),
      expiresAt: expiresAt || null,
      maxDownloads: shareRecord.shareMaxDownloads,
      downloadCount: shareRecord.downloadCount,
      remainingDownloads: shareRecord.shareMaxDownloads
        ? Math.max(0, shareRecord.shareMaxDownloads - shareRecord.downloadCount)
        : null,
      passwordProtected: Boolean(metadata.sharePasswordHash),
      uploadTime: shareRecord.createdAt,
    });
  } catch (error) {
    console.error('share-info error:', error);
    return jsonResponse({ error: 'SHARE_INFO_FAILED', message: error?.message || 'Unknown error' }, 500);
  }
}

/* ============================================================
 * 合集分支 —— `?b=<slug>`
 * ============================================================ */

/**
 * 渲染一个合集分享。
 *
 * 状态码契约与单文件分支**完全一致**（200/401/403/410/404），这样 `share.html`
 * 两种形态可以共用同一套分支逻辑，不必为合集再写一套错误处理。
 *
 * 与单文件分支的关键差异：
 *
 *   · 成员文件**逐个**返回名称/大小/类型，前端渲染成清单；
 *   · 每个成员各自的**文件名与大小**来自文件自身的 metadata，但访问控制
 *     完全由合集承担 —— 也就是说，合集里的文件**不需要**自己开过分享。
 *     这正是合集存在的意义：把一堆未单独分享的文件一次性分享出去。
 *   · **不返回**成员文件的 KV key / fileId。改成返回
 *     `/file/<kvKey>` 形态的 URL —— 这是访问文件流所必需的，而该 URL 只对
 *     **已通过密码校验**的访问者可见，与单文件分支的 `fileUrl` 同理。
 *     裸 `fileId` 仍然不外泄，避免被拿去绕过短链直接调用其它接口。
 *
 * @param env - Pages 环境。
 * @param slug - 合集 slug。
 * @param url - 请求 URL（用于取密码参数）。
 * @param request - 请求对象（用于取密码头）。
 */
async function respondBundle(env, slug, url, request) {
  try {
    const bundle = await readBundle(env, slug);
    if (!bundle) {
      return jsonResponse({ error: 'SHARE_NOT_FOUND', message: '分享链接不存在。' }, 404);
    }

    // ---------- 1. 有效期 ----------
    if (isBundleExpired(bundle)) {
      return jsonResponse(
        { error: 'SHARE_EXPIRED', message: '分享链接已过期。', expiresAt: bundle.expiresAt },
        410
      );
    }

    // ---------- 2. 密码 ----------
    // 顺序与单文件分支一致：密码先于次数。未通过密码验证的访问者不应拿到
    // 「还剩几次」这类信息，也不该能探测出「已耗尽」这个事实。
    const providedPassword =
      url.searchParams.get('password') || request.headers.get('X-Share-Password') || '';

    const passwordState = await verifyBundlePassword(bundle, providedPassword);
    if (passwordState === 'missing') {
      return jsonResponse(
        { error: 'SHARE_PASSWORD_REQUIRED', passwordProtected: true, bundle: true },
        401
      );
    }
    if (passwordState === 'invalid') {
      return jsonResponse(
        {
          error: 'SHARE_PASSWORD_INVALID',
          message: '访问密码不正确。',
          passwordProtected: true,
          bundle: true,
        },
        403
      );
    }

    // ---------- 3. 次数上限 ----------
    if (isBundleExhausted(bundle)) {
      return jsonResponse(
        {
          error: 'SHARE_LIMIT_REACHED',
          message: '分享链接的下载次数已用尽。',
          maxDownloads: bundle.maxDownloads,
          downloadCount: bundle.downloadCount,
        },
        410
      );
    }

    // ---------- 4. 组装成员清单 ----------
    const files = [];
    const isFolder = bundle.type === 'folder';
    if (isFolder) {
      // 实时文件夹分享：按 folderPath 实时扫 KV，反映目录此刻的真实内容。
      // 上传/删除文件后无需重新分享，访客刷新即见最新状态。
      const members = await listFolderMembersLive(env, bundle.folderPath, bundle.includeSubfolders);
      for (const member of members) {
        files.push({
          fileName: member.metadata.fileName || String(member.name),
          fileSize: Number(member.metadata.fileSize) || 0,
          fileType: member.metadata.fileType || 'document',
          fileUrl: `/file/${encodeURIComponent(member.name)}`,
        });
      }
    } else {
      for (const fileId of bundle.fileIds) {
        try {
          const { record, kvKey } = await getRecordWithKey(env, fileId);
          if (!record?.metadata) continue;
          files.push({
            fileName: record.metadata.fileName || String(kvKey || fileId),
            fileSize: Number(record.metadata.fileSize) || 0,
            fileType: record.metadata.fileType || 'document',
            // 与单文件分支同理：这是访问文件流所必需的标识，
            // 只对已通过密码校验的访问者返回。
            fileUrl: `/file/${encodeURIComponent(kvKey)}`,
          });
        } catch (error) {
          console.warn('Failed to resolve bundle member:', error?.message || error);
        }
      }
    }

    // 成员可能在上传后被逐个删除（或实时目录当前为空）。全部失效/为空时给 404
    // 而不是返回空清单 —— 一个「零文件的分享页」没有意义，且会让人误以为页面坏了。
    if (!files.length) {
      return jsonResponse(
        {
          error: 'SHARE_NOT_FOUND',
          message: isFolder ? '该文件夹目前没有任何文件。' : '该分享中的文件已全部失效。',
          folderShare: isFolder,
        },
        404
      );
    }

    return jsonResponse({
      success: true,
      bundle: true,
      slug: bundle.slug,
      fileCount: files.length,
      // 实时目录分享时，期望成员数即当前实时数；文件快照型沿用 fileIds 长度。
      expectedCount: isFolder ? files.length : bundle.fileIds.length,
      // 透传类型，便于前端区分「文件夹实时分享」与「文件合集」。
      type: bundle.type,
      folderShare: isFolder,
      folderPath: isFolder ? bundle.folderPath : '',
      includeSubfolders: isFolder ? Boolean(bundle.includeSubfolders) : false,
      files,
      // 后续请求文件流时若合集设了密码，必须带上，否则 file 路由会 401。
      // 注意：合集密码并不存在于文件元数据上，因此这里显式告知前端要以
      // header 形式透传，而不是依赖文件自身的 sharePasswordHash。
      filePasswordRequired: Boolean(bundle.passwordHash),
      expiresAt: bundle.expiresAt || null,
      maxDownloads: bundle.maxDownloads || null,
      downloadCount: bundle.downloadCount,
      remainingDownloads: bundle.maxDownloads
        ? Math.max(0, bundle.maxDownloads - bundle.downloadCount)
        : null,
      passwordProtected: Boolean(bundle.passwordHash),
      createdAt: bundle.createdAt || null,
    });
  } catch (error) {
    console.error('share-info bundle error:', error);
    return jsonResponse(
      { error: 'SHARE_INFO_FAILED', message: error?.message || 'Unknown error' },
      500
    );
  }
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Share-Password',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // 必须 no-store：带密码校验结果的响应一旦被缓存，
      // 同机其他用户不输密码也能拿到文件地址。
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
