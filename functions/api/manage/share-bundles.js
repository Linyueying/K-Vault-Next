/**
 * 合集分享总览接口 —— `GET /api/manage/share-bundles`
 *
 * 后台「合集管理」面板的数据源，与 `shares.js`（单文件分享列表）平行。
 *
 * ## 与 `shares.js` 的两点结构性差异
 *
 * 1. **不能用 `listNormalizedFiles()` 反查。** 单文件分享的列表是从文件列表
 *    里筛出"带分享字段"的条目 —— 因为那些字段就存在文件的 KV metadata 上。
 *    合集的元数据存在独立的 `bundle:<slug>` 键里，与文件列表无关，所以这里
 *    必须**枚举 `bundle_slug:` 前缀**再逐个读合集本体。
 *
 * 2. **需要额外一次文件名校验。** 合集成员文件可能已被删除，而列表要显示
 *    文件名让人认得出是哪个合集。这里只对成员做存在性检查，不做内容读取，
 *    把 KV 读控制在"每合集 1 次枚举命中 + N 次成员探测"的量级。
 *
 * ## 为什么不做服务端分页
 *
 * 与 `shares.js` 保持一致：一次性返回全量，筛选/搜索在前端做。合集的创建
 * 频率天然低于文件上传，总量通常很小，而面板需要展示"总共多少个合集"这类
 * 汇总数字，分页反而让统计变复杂。
 *
 * 鉴权由 `functions/api/manage/_middleware.js` 统一完成，此处不重复。
 *
 * @module api/manage/share-bundles
 */

import { getRecordWithKey } from '../../utils/file-record.js';
import {
  BUNDLE_SLUG_KEY_PREFIX,
  isBundleActive,
  isBundleExhausted,
  isBundleExpired,
  listAllBundles,
  listFolderMembersLive,
  readBundle,
} from '../../utils/share-bundle.js';

/** KV list 单页上限（KV 自身上限为 1000）。 */
const LIST_PAGE_SIZE = 1000;

/** 成员探测的并发批大小，避免合集多时一次性打出过多并发。 */
const MEMBER_BATCH_SIZE = 10;

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET') {
    return jsonResponse({ success: false, error: 'Method not allowed. Use GET.' }, 405);
  }
  if (!env?.img_url) {
    return jsonResponse({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

  const url = new URL(request.url);
  const includeStats = !['0', 'false', 'no'].includes(
    String(url.searchParams.get('includeStats') || '').toLowerCase()
  );

  try {
    // D1 优先：两条 SQL 取回全部合集 + 全部成员（避免 N+1 次读）
    const d1 = await listAllBundles(env);
    let bundles;
    let source;
    if (!d1.disabled) {
      bundles = d1.bundles;
      source = 'd1';
    } else {
      // KV 兜底：枚举 bundle_slug: 前缀再逐个读本体
      const slugs = await listBundleSlugs(env);
      bundles = [];
      for (const slug of slugs) {
        const bundle = await readBundle(env, slug);
        if (bundle) bundles.push(bundle);
      }
      // 按创建时间倒序，与文件分享列表的默认排序一致
      bundles.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      source = 'kv';
    }

    const rows = [];
    for (let i = 0; i < bundles.length; i += MEMBER_BATCH_SIZE) {
      const batch = bundles.slice(i, i + MEMBER_BATCH_SIZE);
      const built = await Promise.all(batch.map((bundle) => buildBundleRecord(env, bundle)));
      for (const row of built) rows.push(row);
    }

    const payload = { success: true, bundles: rows, count: rows.length, source };
    if (includeStats) payload.stats = computeBundleStats(rows);

    return jsonResponse(payload);
  } catch (error) {
    console.error('Failed to list share bundles:', error);
    return jsonResponse({ success: false, error: error?.message || 'Unknown error' }, 500);
  }
}

/**
 * 枚举全部合集 slug。
 *
 * 以 `bundle_slug:` 索引键为准而非 `bundle:` 前缀：索引键在
 * `writeBundle()` 里与合集本体一同写入、在 `deleteBundle()` 里一同删除，
 * 两者生命周期一致，但索引键的值就是 slug 本身，比解析 `bundle:` 键名更
 * 直接（键名截前缀还要处理编码，容易出错）。
 *
 * 分页循环是必要的：KV `list()` 单次最多返回 1000 个键，合集数量理论上
 * 无上限，不分页会静默丢掉第 1001 个之后的所有合集。
 */
async function listBundleSlugs(env) {
  const slugs = [];
  let cursor = undefined;

  do {
    const page = await env.img_url.list({
      prefix: BUNDLE_SLUG_KEY_PREFIX,
      limit: LIST_PAGE_SIZE,
      cursor,
    });
    for (const key of page.keys || []) {
      const slug = String(key.name || '').slice(BUNDLE_SLUG_KEY_PREFIX.length);
      if (slug) slugs.push(slug);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return slugs;
}

/**
 * 组装单条合集的后台展示记录。
 *
 * 成员文件只做「存在性 + 显示名」探测，不进 `share-options.js` 的构建流程
 * —— 那些函数是给"这条记录本身被分享"的场景用的，对合集成员没有意义。
 */
async function buildBundleRecord(env, bundle) {
  const isFolder = bundle.type === 'folder';
  const folderPath = isFolder ? (bundle.folderPath || '') : '';
  const includeSubfolders = isFolder ? Boolean(bundle.includeSubfolders) : false;

  const resolved = [];
  const missing = [];

  if (isFolder) {
    // 实时文件夹分享：按目录实时列举，反映当前真实成员数（分享管理同步更新）。
    const members = await listFolderMembersLive(env, folderPath, includeSubfolders);
    for (const m of members) {
      resolved.push({
        fileId: '',
        ok: true,
        kvKey: String(m.name || ''),
        fileName: m.metadata.fileName || String(m.name || ''),
        fileSize: Number(m.metadata.fileSize) || 0,
        fileType: m.metadata.fileType || 'document',
        storageType: m.metadata.storageType || 'telegram',
      });
    }
  } else {
    const ids = Array.isArray(bundle.fileIds) ? bundle.fileIds : [];
    for (let i = 0; i < ids.length; i += MEMBER_BATCH_SIZE) {
      const batch = ids.slice(i, i + MEMBER_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (fileId) => {
          try {
            const { record, kvKey } = await getRecordWithKey(env, fileId);
            if (!record?.metadata) return { fileId, ok: false };
            return {
              fileId,
              ok: true,
              kvKey: String(kvKey || ''),
              fileName: record.metadata.fileName || String(kvKey || fileId),
              fileSize: Number(record.metadata.fileSize) || 0,
              fileType: record.metadata.fileType || 'document',
              storageType: record.metadata.storageType || record.metadata.storage || 'telegram',
            };
          } catch {
            return { fileId, ok: false };
          }
        })
      );
      for (const item of results) {
        if (item.ok) resolved.push(item);
        else missing.push(item.fileId);
      }
    }
  }

  const expired = isBundleExpired(bundle);
  const exhausted = isBundleExhausted(bundle);

  return {
    slug: bundle.slug,
    sharePath: `/s/${encodeURIComponent(bundle.slug)}`,
    type: isFolder ? 'folder' : 'files',
    folderShare: isFolder,
    folderPath,
    includeSubfolders,
    fileCount: resolved.length,
    // 成员条目只暴露展示所需字段，不含 fileId（沿用 share-info 不外泄内部
    // 标识的基线；这里给的是 fileName，足够后台辨认）。
    files: resolved.map((item) => ({
      fileName: item.fileName,
      fileSize: item.fileSize,
      fileType: item.fileType,
      storageType: item.storageType,
    })),
    missingCount: missing.length,
    downloadCount: Number(bundle.downloadCount) || 0,
    maxDownloads: Number(bundle.maxDownloads) || 0,
    expiresAt: Number(bundle.expiresAt) || 0,
    passwordProtected: Boolean(bundle.passwordHash),
    createdAt: Number(bundle.createdAt) || 0,
    active: isBundleActive(bundle),
    expired,
    exhausted,
  };
}

/** 汇总统计，供面板顶部概览卡片使用，字段与 `shares.js` 对齐。 */
function computeBundleStats(bundles) {
  let expired = 0;
  let exhausted = 0;
  let protectedCount = 0;
  let totalDownloads = 0;
  let uncapped = 0;
  let totalFiles = 0;
  let missingFiles = 0;

  for (const bundle of bundles) {
    if (bundle.expired) expired += 1;
    if (bundle.exhausted) exhausted += 1;
    if (bundle.passwordProtected) protectedCount += 1;
    totalFiles += bundle.fileCount;
    missingFiles += bundle.missingCount;
    if (bundle.maxDownloads > 0) totalDownloads += bundle.downloadCount;
    else uncapped += 1;
  }

  return {
    total: bundles.length,
    active: bundles.filter((b) => !b.expired && !b.exhausted).length,
    expired,
    exhausted,
    passwordProtected: protectedCount,
    uncapped,
    totalDownloads,
    totalFiles,
    missingFiles,
  };
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
