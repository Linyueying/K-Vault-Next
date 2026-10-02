/**
 * 根级中间件 —— 阻止生产环境把源码 / 配置 / 开发产物当静态资源发出去。
 *
 * ## 为什么需要它
 *
 * Cloudflare Pages 会把部署目录里的**每一个文件**都当静态资源提供。
 * 本项目没有构建步骤，整个仓库就是发布目录，于是这些也被一并公开：
 *
 *   · `/package.json`      —— 依赖与版本，等于把 CVE 靶子清单递给攻击者
 *   · `/wrangler.toml`     —— D1 database_id、绑定名等基础设施信息
 *   · `/.env.example`      —— 环境变量清单（含管理员账密字段名）
 *   · `/migrations/*.sql`  —— 完整数据库表结构
 *   · `/docs/**`           —— 内部运维文档（含本地开发用明文凭据）
 *   · `/scripts/**`、`/functions/**`、`/demo/**`、`.git/**` —— 源码与开发产物
 *
 * 根级 `_middleware.js` 在 Pages 里匹配**所有**路径，且先于静态资源回落，
 * 因此在这里拦掉即可（见 docs：'If no Function is matched, it will fall back
 * to a static asset'）。
 *
 * ## 为什么返回 404 而不是 403
 *
 * 403 会确认「这个路径存在，只是不给你看」，反而成了 probing 的正面信号。
 * 404 让敏感文件与 genuinely 不存在的路径无法区分。
 *
 * @module _middleware
 */

/** 精确匹配（小写、已去尾斜杠） */
const BLOCKED_EXACT = new Set([
  '/package.json',
  '/package-lock.json',
  '/pnpm-lock.yaml',
  '/yarn.lock',
  '/wrangler.toml',
  '/wrangler.json',
  '/wrangler.jsonc',
  '/.env',
  '/.env.example',
  '/.env.local',
  '/.env.production',
  '/.dev.vars',
  '/.npmrc',
  '/.node-version',
  '/.nvmrc',
  '/.editorconfig',
  '/.gitignore',
  '/.gitattributes',
  '/.markdownlint.json',
  '/.prettierrc',
  // README 逐条列了七种存储后端、环境变量表与部署拓扑，34089 B，
  // 是生产实例上最大的一份「架构说明书」。开发仓库里它是文档，
  // 部署到线上就成了侦察材料。
  '/readme.md',
  '/readme-en.md',
  // 目录本身（不带尾斜杠的请求）也要拦，否则 list 不到但直接访问仍可能命中
  '/scripts',
  '/docs',
  '/demo',
  '/migrations',
  '/functions',
  '/node_modules',
]);

/** 目录前缀匹配（小写、必须以 / 结尾，保证是目录边界而非字符串前缀） */
const BLOCKED_PREFIXES = [
  '/.git/',
  '/.github/',
  '/functions/',
  '/migrations/',
  '/scripts/',
  '/docs/',
  '/demo/',
  '/node_modules/',
];

/**
 * 判断是否命中拦截名单。
 *
 * 同时比对原始 pathname 与解码后的 pathname：`/%77rangler.toml` 这类
 * 百分号编码绕写在 Pages 上会被还原，这里提前一步覆盖掉。
 *
 * @param {Request} request
 * @returns {boolean}
 */
function isBlocked(request) {
  let pathname = '';
  try {
    pathname = new URL(request.url).pathname || '/';
  } catch {
    return false;
  }

  const candidates = new Set([pathname]);
  try {
    candidates.add(decodeURIComponent(pathname));
  } catch {
    // 非法编码：只用原始值判断
  }

  for (const raw of candidates) {
    // 去掉尾斜杠（`/package.json/` 与 `/package.json` 同义）
    const normalized = String(raw || '/').replace(/\/+$/, '') || '/';
    const lower = normalized.toLowerCase();

    if (BLOCKED_EXACT.has(lower)) return true;
    for (const prefix of BLOCKED_PREFIXES) {
      // 前缀一律以 / 结尾，因此只可能是目录边界，不会误伤 /scriptsfiles 这类同前缀路径
      if (lower.startsWith(prefix)) return true;
    }
  }

  return false;
}

import { resolveCorsHeaders } from './utils/cors.js';
import { fixedWindowRateLimit, getClientIp } from './utils/ratelimit.js';

/**
 * 全站安全响应头。
 *
 * 与 `_headers` 里的同名条目**刻意重复**：`_headers` 只作用于静态资源，
 * 这里补上 Functions 响应与被 `next()` 放行的路径，两者合起来才覆盖全站。
 *
 * 关于 CSP 里的两个 `unsafe-*`，这是当前架构的硬约束，不是偷懒：
 *   · `'unsafe-inline'` —— 六个页面共有 8 处内联 `<script>`，且大量
 *     内联 `style` / Vue 动态样式绑定。去掉它需要先给每个内联块发 nonce，
 *     属于一次前端改造。
 *   · `'unsafe-eval'` —— `assets/vendor/vue.global.prod.min.js` 是**含运行时
 *     编译器**的全量构建，模板编译走 `Function(code)()`。
 *     去掉它要换成 `vue.runtime.*` 构建并把模板预编译。
 *
 * 即便如此，CSP 仍然挡住了真正致命的几类：外部脚本加载（`script-src`
 * 只认本站）、`<base>` 劫持、表单外泄、`object`/插件内容、以及被任意站点
 * 嵌套（与 X-Frame-Options 一并防点击劫持）。
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // 外链带来源便于统计，但不泄露完整 URL；跨站降级为仅 origin
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // SAMEORIGIN 而非 DENY：预览页是被 index/admin/gallery/share 用 iframe
  // 嵌入的，DENY 会把站内预览一起干掉
  'X-Frame-Options': 'SAMEORIGIN',
  // 摄像头**必须**放行 —— 隔空投送的二维码扫码用 getUserMedia({video})
  'Permissions-Policy':
    'camera=(self), geolocation=(), microphone=(), payment=(), usb=(), ' +
    'serial=(), xr-spatial-tracking=(), interest-cohort=()',
  // 不带 includeSubDomains：把兄弟子域一起纳入 HSTS 会在混合部署的域名上
  // 造成不可逆的副作用；确认全部子域都是 HTTPS 后再自行加上
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy':
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https:; " +
    "media-src 'self' blob: https:; " +
    "font-src 'self' data:; " +
    "connect-src 'self' https:; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'self'",
};

/* ============================================================
 * 通用限流（L1）
 * ============================================================
 *
 * 登录（15 次窗口）与管理面（30 次/分）早就有限流，但 `/api/**`、`/file/**`
 * 这些通用端点一直裸奔。这里补一层默认防护。
 *
 * 刻意做成两层，因为**成本差了一个数量级**：
 *
 *   1) isolate 内计数 —— 默认开，零 KV 开销。挡得住打在同一个 isolate 上
 *      的脚本洪水（绝大多数扫描/爆破就是这个形态）。
 *   2) KV 计数 —— 默认**关**。`fixedWindowRateLimit()` 每请求要 1 读 1 写，
 *      而 KV 免费额度是 1000 写/天：全局开启等于几分钟把一天的额度打穿。
 *      需要跨 isolate 强一致约束时（付费计划）设 `RATE_LIMIT_GLOBAL_MAX`
 *      显式开启，设 0 关闭。
 */

/** 需要限流的路径：API、文件流与上传入口。静态页面不在此列。 */
function needsRateLimit(request) {
  let path = '/';
  try {
    path = new URL(request.url).pathname || '/';
  } catch {
    return false;
  }
  return path.startsWith('/api/') || path.startsWith('/file/') || path === '/upload';
}

const LOCAL_WINDOW_MS = 60 * 1000;
const LOCAL_MAX_PER_WINDOW = 600;

/** 仅本 isolate 有效的固定窗口计数（无 KV 开销） */
const localHits = new Map();

function localRateLimit(ip) {
  const now = Date.now();
  const windowStart = Math.floor(now / LOCAL_WINDOW_MS) * LOCAL_WINDOW_MS;

  // 顺手清掉过期窗口，避免 Map 无限增长
  for (const [key, entry] of localHits) {
    if (entry.windowStart !== windowStart) localHits.delete(key);
  }

  const entry = localHits.get(ip);
  if (!entry || entry.windowStart !== windowStart) {
    localHits.set(ip, { windowStart, count: 1 });
    return { allowed: true };
  }
  entry.count += 1;
  if (entry.count > LOCAL_MAX_PER_WINDOW) {
    return { allowed: false, retryAfterMs: windowStart + LOCAL_WINDOW_MS - now };
  }
  return { allowed: true };
}

export async function onRequest(context) {
  if (isBlocked(context.request)) {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  if (needsRateLimit(context.request)) {
    const ip = getClientIp(context.request) || 'unknown';

    const local = localRateLimit(ip);
    if (!local.allowed) {
      return tooManyRequests(local.retryAfterMs);
    }

    // 跨 isolate 的强约束：默认关闭，见上方说明
    const globalMax = Number(context.env?.RATE_LIMIT_GLOBAL_MAX || 0);
    if (globalMax > 0) {
      const rl = await fixedWindowRateLimit({
        env: context.env,
        key: ip,
        namespace: 'global-ip',
        windowMs: LOCAL_WINDOW_MS,
        max: globalMax,
      }).catch(() => ({ allowed: true, retryAfterMs: 0 }));
      if (!rl.allowed) {
        return tooManyRequests(rl.retryAfterMs);
      }
    }
  }

  return await harden(await context.next(), context);
}

function tooManyRequests(retryAfterMs = 0) {
  return new Response('Too many requests. Please slow down.', {
    status: 429,
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Retry-After': String(Math.max(Math.ceil((retryAfterMs || 1000) / 1000), 1)),
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * 给响应套上安全头，并顺手收敛 CORS。
 *
 * 静态资源响应的 headers 有可能是只读的，直接 `set` 会抛；
 * 这时复制一份头再构造新 Response，而不是让整条请求 500。
 */
async function harden(response, context) {
  if (!response || !response.headers) return response;

  const extra = { ...SECURITY_HEADERS };

  // 兜底收敛 CORS：把散落在各处写死的 `*` 拉回白名单。
  //
  // `functions/file/[[path]].js`、`api/share-info.js` 等历史代码在响应里
  // 直接写 `Access-Control-Allow-Origin: *`。逐个改要动十来处调用点（
  // 还得把 env 一层层传下去），这里改成在出口统一裁决：
  //   · 白名单含 `*` —— 尊重配置，原样保留；
  //   · 白名单含本次 Origin —— 收敛成具体 origin；
  //   · 都不含 —— 直接删掉 ACAO，浏览器自行拦截。
  // 只有真的带了 `*` 的响应才会去读一次运行时配置，其余请求零开销。
  if (response.headers.get('access-control-allow-origin') === '*') {
    const resolved = await resolveCorsHeaders(context.request, context.env).catch(() => ({}));
    const allowed = resolved['Access-Control-Allow-Origin'];
    if (allowed) {
      extra['Access-Control-Allow-Origin'] = allowed;
    } else {
      // Headers 没有 delete 语义的「不存在」值，用空串覆盖不掉，
      // 因此这一支走下面的「重建 Response」路径，把该头摘掉。
      return rebuild(response, extra, ['access-control-allow-origin']);
    }
  }

  try {
    for (const [key, value] of Object.entries(extra)) {
      response.headers.set(key, value);
    }
    return response;
  } catch {
    return rebuild(response, extra, []);
  }
}

/** 复制一份响应头后重建 Response（用于只读 headers 或需要删头的场景） */
function rebuild(response, extraHeaders, dropHeaders = []) {
  const headers = new Headers(response.headers);
  for (const key of dropHeaders) headers.delete(key);
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
