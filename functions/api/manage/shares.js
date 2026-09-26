/**
 * 分享总览接口 —— `GET /api/manage/shares`
 *
 * 后台「分享管理」面板的数据来源：列出当前所有开启分享的文件，附带
 * 有效期、下载次数、密码状态，供管理员监控与取消。
 *
 * ## KV 读预算
 *
 * 下载计数存在独立的 `dlc:<kvKey>` 键里，读一次就是一次 KV 读。因此：
 *
 *   · **只对配置了 `maxDownloads` 的文件**去读计数 —— 不限次数的分享
 *     没有「还剩几次」可显示，读它纯属浪费。
 *   · 读取**分批并发**（每批 20），避免文件多时一次性打出上百个并发
 *     请求把 KV 打到限流。
 *
 * ## 为什么不做服务端筛选/分页
 *
 * 与 `/api/manage/list` 保持一致：一次性返回全量，筛选与分页在前端做。
 * 分享条目通常远少于文件总数，而且管理员需要看到「总共有多少分享」这类
 * 汇总数字，分页反而让统计变复杂。
 *
 * 鉴权由 `functions/api/manage/_middleware.js` 统一完成，此处不重复。
 *
 * @module api/manage/shares
 */

import { listNormalizedFiles } from '../../utils/file-list.js';
import { listSharedRecords } from '../../utils/file-record.js';
import { buildShareRecord, hasActiveShare } from '../../utils/share-options.js';

/** 计数读取的并发批大小（仅 KV 兜底路径使用）。 */
const COUNT_BATCH_SIZE = 20;

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
  // `includeStats=0` 可跳过汇总计算（前端若要自行统计）
  const includeStats = !['0', 'false', 'no'].includes(
    String(url.searchParams.get('includeStats') || '').toLowerCase()
  );

  try {
    // ========================================================================
    // 路径 A：D1 —— 一条 SQL 拿到「所有开启分享的文件 + 实时下载计数」
    //
    // KV 版要先全量列举文件，再对每个限次分享逐条读 `dlc:` 计数键
    // （分批 20 并发，避免打爆 KV 限流）。这里 share_download_count 就在
    // 同一行里，计数读取的 N 次网络往返直接归零。
    // ========================================================================
    const d1 = await listSharedRecords(env);
    if (!d1.disabled) {
      const shares = [];
      for (const item of d1.files) {
        const record = await buildShareRecord(env, item.metadata, item.name).catch((error) => {
          console.warn('Failed to build share record:', error?.message || error);
          return null;
        });
        if (record) shares.push(record);
      }

      const payload = { success: true, shares, count: shares.length, source: 'd1' };
      if (includeStats) payload.stats = computeShareStats(shares);
      return jsonResponse(payload);
    }

    // ========================================================================
    // 路径 B：KV 兜底（原有逻辑）
    // ========================================================================
    const files = await listNormalizedFiles(env);

    // 只保留真正开启分享的条目。
    // 注意用 hasActiveShare 而非「有任一 share 字段」：revoke 之后残留的
    // shareDownloadCount 不应让条目继续出现在分享列表里。
    const sharedFiles = files.filter((file) => hasActiveShare(file.metadata || {}));

    // 按上传时间倒序，与文件列表的默认排序一致
    sharedFiles.sort(
      (a, b) => Number(b.metadata?.TimeStamp || 0) - Number(a.metadata?.TimeStamp || 0)
    );

    const shares = [];
    for (let i = 0; i < sharedFiles.length; i += COUNT_BATCH_SIZE) {
      const batch = sharedFiles.slice(i, i + COUNT_BATCH_SIZE);
      const records = await Promise.all(
        batch.map((file) =>
          buildShareRecord(env, file.metadata || {}, file.name).catch((error) => {
            console.warn('Failed to build share record:', error?.message || error);
            return null;
          })
        )
      );
      for (const record of records) {
        if (record) shares.push(record);
      }
    }

    const payload = { success: true, shares, count: shares.length };
    if (includeStats) payload.stats = computeShareStats(shares);
    return jsonResponse(payload);
  } catch (error) {
    console.error('Failed to list shares:', error);
    return jsonResponse({ success: false, error: error?.message || 'Unknown error' }, 500);
  }
}

/**
 * 汇总统计，供面板顶部的概览卡片使用。
 * @param shares - `buildShareRecord()` 产出的记录数组。
 */
function computeShareStats(shares) {
  const now = Date.now();
  let expired = 0;
  let exhausted = 0;
  let protectedCount = 0;
  let totalDownloads = 0;
  let uncapped = 0;

  for (const share of shares) {
    const expiresAt = Number(share.shareExpiresAt) || 0;
    const maxDownloads = Number(share.shareMaxDownloads) || 0;
    const downloadCount = Number(share.downloadCount) || 0;

    const isExpired = expiresAt > 0 && now > expiresAt;
    const isExhausted = maxDownloads > 0 && downloadCount >= maxDownloads;

    if (isExpired) expired += 1;
    if (isExhausted) exhausted += 1;
    if (share.passwordProtected) protectedCount += 1;
    if (maxDownloads > 0) {
      totalDownloads += downloadCount;
    } else {
      uncapped += 1;
    }
  }

  return {
    total: shares.length,
    // active 与 buildShareRecord 的 active 语义一致：既未过期也未超限
    active: shares.length - shares.filter((s) => s.expired || s.exhausted).length,
    expired,
    exhausted,
    passwordProtected: protectedCount,
    uncapped,
    totalDownloads,
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
