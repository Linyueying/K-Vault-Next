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

  return context.next();
}
