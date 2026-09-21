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

export async function onRequest(context) {
  const { request, params } = context;

  const rawValue = decodePathParam(params?.slug || '');

  // 空值 / 超长值仍然跳分享页：让页面统一显示「链接不存在」，
  // 而不是在这里抛 404 让用户看到一屏纯文本。
  const target = rawValue && rawValue.length <= MAX_IDENTIFIER_LENGTH ? rawValue : '';

  const redirectUrl = new URL(SHARE_PAGE_PATH, request.url);
  if (target) {
    redirectUrl.searchParams.set('s', target);
  }

  return Response.redirect(redirectUrl.toString(), 302);
}
