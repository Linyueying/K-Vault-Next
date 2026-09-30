/**
 * /admin/* → admin.html 的 SPA fallback。
 *
 * 管理后台的前端分区导航（文件 / 分享 / 存储 / 设置）用的是
 * `history.pushState('/admin/<section>')`，也就是**真实路径**而不是 hash。
 * 好处是地址栏干净、前进后退语义正确、切板块不再触发锚点滚动；
 * 代价是这些路径在服务器上并不存在 —— 刷新或直接访问
 * `/admin/storage` 时，Pages 找不到对应文件，会直接 404。
 *
 * 这个函数补上那一环：把 `/admin/` 前缀下的**导航请求**统一交给
 * `admin.html` 处理，由前端脚本读 `location.pathname` 自行决定渲染哪个
 * 板块。**不写重定向** —— 用 `env.ASSETS.fetch()` 直接取文件内容，
 * 地址栏始终停留在用户输入的 URL 上（302 会让 URL 抖一下再回来）。
 *
 * 与 `functions/upload.js` 的 `serveUploadPage()` 是同一套做法
 * （`/upload` → `/index.html`），这里是 `/admin/*` → `/admin.html`。
 */

/** 带扩展名的路径段（如 `foo.js`、`logo.png`）视为静态资源，不接管。 */
const HAS_EXTENSION = /\.[a-z0-9]+$/i;

/**
 * 从请求路径里取 `/admin/` 之后的剩余段。
 *
 * 不用 `params.path`：catch-all 在不同 wrangler / Pages 版本下，
 * 对「单段」「多段」「带点号」的取值形态并不一致（数组 / 字符串 / 已解码），
 * 而这里要的只是「有没有扩展名」这一个判断，直接从 pathname 取最稳。
 */
function adminSubPath(request) {
  try {
    const pathname = new URL(request.url).pathname;
    return decodeURIComponent(pathname.replace(/^\/admin\/?/, ''));
  } catch {
    return '';
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  // 只有导航类请求才回落到 admin.html。POST/PUT/DELETE 落到这里说明
  // 是打错的接口地址，返回一个 200 的 HTML 只会让人更难排查。
  const method = String(request.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return context.next();
  }

  // `/admin/anything.js` 这类请求本意是取资源，不是导航。直接 404，
  // 不把它伪装成 200 的 HTML —— 否则调试时会被一个「看起来正常」的
  // 响应误导（拿 .js 的路径却收到 HTML）。
  const subPath = adminSubPath(request);
  if (HAS_EXTENSION.test(subPath)) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // 用 ASSETS 取 admin.html 的内容，但 URL 保持原样：前端会读 pathname
  // 定位板块，改用重定向的话这一步就读不到了。
  if (env?.ASSETS?.fetch) {
    const assetUrl = new URL('/admin.html', request.url);
    const assetRequest = new Request(assetUrl.toString(), {
      method,
      headers: request.headers,
    });
    return env.ASSETS.fetch(assetRequest);
  }

  // 本地/dev 环境未挂 ASSETS 时退回常规处理，便于排查
  if (typeof context.next === 'function') {
    return context.next();
  }

  return new Response('admin.html not available', { status: 500 });
}
