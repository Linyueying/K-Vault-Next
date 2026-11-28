/**
 * 分享短链入口 —— `GET /s/:slug`
 *
 * ## 行为变更（破坏性）
 *
 * 改造前：本文件解析 `share_slug:<slug>` 映射，然后 **302 到 `/file/<id>`**，
 * 浏览器直接开始下载文件。
 *
 * 改造后：只做一件事 —— **302 到 `/share.html?s=<原值>`**，由分享页负责
 * 展示文件信息、提供预览与下载两个入口。
 *
 * 这样用户点开分享链接先看到一个正常页面，而不是被静默下载一个陌生文件；
 * 同时「预览」与「下载」得以分开，下载计数只在用户真的点下载时才走。
 *
 * ## 合集短链（`?b=`）
 *
 * 单文件分享与合集分享共用 `/s/:slug` 这一个入口，但下游共享页用**不同的
 * 查询参数**区分形态：`?s=` 给单文件，`?b=` 给合集。
 *
 * 所以这里必须先判断 slug 属于哪一个命名空间：
 *   · 命中 `bundle_slug:<slug>` → 302 到 `/share.html?b=<slug>`
 *   · 否则 → 302 到 `/share.html?s=<slug>`（保持原逻辑）
 *
 * 判序上把合集放在前面、且**不做回落猜测**：两个命名空间在创建时就已互斥
 * （见 `share-bundle.js` 的 `isBundleSlugAvailable`），因此命中哪个是确定的。
 * 若先试文件再试合集，一个合集 slug 会先被当作文件 ID 往下传，共享页拿到
 * 一个解析不出东西的 `?s=` 值，报「链接不存在」——错误现象会与真实原因脱节。
 *
 * ## 为什么不在这里解析映射
 *
 * 映射解析交给 `/api/share-info`。原因是解析结果（文件名、大小、剩余次数）
 * 本来就要通过接口拿，重复解析一次只是多一次 KV 读。把「原值」原样透传，
 * 让 `share-info` 统一处理「自定义短链」与「/s/<文件ID>」两种形式。
 *
 * ## 为什么丢弃 password 查询参数
 *
 * 旧实现把全部查询参数透传给了 `/file/...`，包括 `password`。那会让密码
 * 出现在浏览器历史、Referer 头、以及服务器访问日志里。分享页改为让用户
 * 在页面内输入密码，密码只存在于内存中。
 *
 * @module s/[slug]
 */

import { BUNDLE_SLUG_KEY_PREFIX } from '../utils/share-bundle.js';
import { bundleSlugExists } from '../utils/bundle-store.js';

/** 分享页路径。集中在此便于未来调整。 */
const SHARE_PAGE_PATH = '/share.html';

/** 与 `sanitizeShareSlug` 一致的上限，防止超长输入进入下游。 */
const MAX_IDENTIFIER_LENGTH = 128;

function decodePathParam(rawValue = '') {
  try {
    return decodeURIComponent(String(rawValue || ''));
  } catch {
    return String(rawValue || '');
  }
}

/**
 * 判断 slug 是否属于合集命名空间。
 *
 * ## 查 D1 而不是 KV
 *
 * 原实现读 `bundle_slug:<slug>` 这个「存在性索引键」。它是纯冗余：
 * `bundles.slug` 本身就是主键，一次主键查询即可判定，没有理由再维护一份
 * 需要同步、会过期、且每次访问都要付费的 KV 副本。
 *
 * 更关键的是额度结构：**KV 读 10 万/天，D1 rows read 500 万/天**。
 * `/s/:slug` 是分享链路的第一跳，每一次点击都要走一次判定 —— 把最高频的
 * 路径放在最窄的额度上，是这份配额最先被打爆的地方。
 *
 * ## 什么时候读 KV
 *
 * 只在 **D1 给出"不可用"信号**时回落（`disabled: true`，即未绑定或查询报错）。
 * D1 可用且明确回答"没有"时采信结果、不再读 KV —— 否则每次文件短链访问
 * 都要白搭一次 KV 读，等于没优化。
 *
 * 唯一的风险窗口是「D1 写入失败、只有 KV 有数据」的存量脏记录。
 * `writeBundle()` 目前是 KV 先写、D1 后镜像（失败不致命），所以这种情况
 * 理论上存在；待 P3 停止双写后自然消失。
 *
 * 读失败时返回 `false`（按单文件处理）：两个分支都会跳到分享页，最坏情况
 * 是分享页显示「链接不存在」，而不是抛出 500 把整个入口打挂。
 *
 * @param env - Pages 环境。
 * @param slug - 归一化前的 slug 原值。
 */
async function isBundleSlug(env, slug) {
  if (!slug) return false;

  const d1 = await bundleSlugExists(env, slug);
  if (!d1.disabled) return d1.exists;

  // D1 不可用 → 回落 KV 索引键
  if (!env?.img_url) return false;
  try {
    const mapped = await env.img_url.get(`${BUNDLE_SLUG_KEY_PREFIX}${slug}`);
    return Boolean(mapped);
  } catch {
    return false;
  }
}

export async function onRequest(context) {
  const { request, params, env } = context;

  const rawValue = decodePathParam(params?.slug || '');

  // 空值 / 超长值仍然跳分享页：让页面统一显示「链接不存在」，
  // 而不是在这里抛 404 让用户看到一屏纯文本。
  const target = rawValue && rawValue.length <= MAX_IDENTIFIER_LENGTH ? rawValue : '';

  const redirectUrl = new URL(SHARE_PAGE_PATH, request.url);
  if (target) {
    const bundle = await isBundleSlug(env, target.toLowerCase());
    redirectUrl.searchParams.set(bundle ? 'b' : 's', target);
  }

  return Response.redirect(redirectUrl.toString(), 302);
}
