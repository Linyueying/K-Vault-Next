/**
 * 路径规范化工具 —— 专治「中间件拿原始 pathname 做前缀判断」这一类绕过。
 *
 * ## 为什么要单独建这个模块
 *
 * Cloudflare Pages 的**路由匹配**会做若干归一化（大小写不敏感、多余斜杠折叠、
 * 百分号解码），但中间件里 `new URL(request.url).pathname` 拿到的是**原始字符串**。
 *
 * 于是只要中间件用原始值做 `startsWith` 判断，就会出现这种错位：
 *
 *   | 请求              | 中间件看到的      | 路由实际命中的   |
 *   |-------------------|-------------------|------------------|
 *   | `/API/V1/files`   | `/API/V1/files`   | `/api/v1/files`  |
 *   | `//wrangler.toml` | `//wrangler.toml` | `/wrangler.toml` |
 *
 * 「中间件认为不匹配 → 放行」与「路由认为匹配 → 执行处理器」叠加，鉴权和黑名单
 * 就被静默跳过了。这不是某个判断写错，而是**两侧用了不同的字符串**。
 *
 * 因此凡是要参与安全判定的路径，都必须先过这里：
 *   1. 先归一化到与路由**相同**的形态；
 *   2. 再做比较。
 *
 * @module utils/path-normalize
 */

/**
 * 百分号解码的最大迭代次数。
 *
 * `%252e%252e%252f` 这类双重编码要解两遍才还原，理论上可以无限套娃。
 * 设上限避免攻击者用超长编码串消耗 CPU，同时真实场景超过 3 层没有意义。
 */
const MAX_DECODE_PASSES = 3;

/**
 * 把单条路径归一化 —— 折叠分隔符、解析 `.` / `..` 段。
 *
 * @param {string} pathname 原始 pathname
 * @returns {string} 以 `/` 开头的规范化路径；目录保留尾斜杠（`/docs/` 仍是 `/docs/`）
 */
export function normalizePathname(pathname) {
  let input = String(pathname == null ? '/' : pathname);
  if (input === '') input = '/';

  // 反斜杠视作分隔符：部分静态服务器与早期 Pages 行为会把它当 `/`，
  // 这里提前统一，避免 `/docs\xfile` 这类形态漏网。
  input = input.replace(/\\/g, '/');

  if (!input.startsWith('/')) input = '/' + input;

  const hadTrailingSlash = input.length > 1 && input.endsWith('/');

  // 折叠重复斜杠（修复 `//wrangler.toml` 绕过）
  input = input.replace(/\/{2,}/g, '/');

  // 解析 `.` 与 `..` 段（修复 `/assets/../wrangler.toml` 这类穿越）
  const segments = input.split('/');
  const resolved = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // 已在根部的 `..` 直接丢弃，不让它逃逸出根
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  let result = '/' + resolved.join('/');
  if (result !== '/' && hadTrailingSlash) result += '/';
  return result === '' ? '/' : result;
}

/**
 * 去掉干扰匹配的点缀，用于生成额外候选。
 *
 * `%00`（空字节截断）、尾部空格/点（Windows 风格 `/file.`）在部分存储后端上
 * 等价于原文件名，多比一次没有副作用。
 *
 * @param {string} normalized 已规范化的路径
 * @returns {string}
 */
function stripNoise(normalized) {
  let out = normalized.replace(/[\u0000-\u001F\u007F]/g, '');
  // 逐段裁剪尾部空白与点：/wrangler.toml. -> /wrangler.toml
  out = out
    .split('/')
    .map((segment) => segment.replace(/[.\s]+$/, ''))
    .join('/');
  return out === '' ? '/' : out;
}

/**
 * 生成用于黑名单/白名单匹配的**全部小写候选路径**。
 *
 * 返回集合而不是单值，是因为「原始值」与「解码值」都可能各自命中不同条目，
 * 而攻击者可以选择提交其中任意一种形态 —— 任何一种漏掉就是绕过。
 *
 * @param {string} pathname 原始 pathname（来自 URL）
 * @returns {Set<string>} 小写候选集合，含保留尾斜杠与去除尾斜杠两种形态
 */
export function collectNormalizedCandidates(pathname) {
  const candidates = new Set();

  let current = String(pathname == null ? '/' : pathname);
  if (current === '') current = '/';

  for (let pass = 0; pass <= MAX_DECODE_PASSES; pass += 1) {
    addVariants(candidates, current);

    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      // 非法百分号编码（如 `/%zz`）：解不动，停止迭代
      break;
    }
    // 已经稳定，没必要继续
    if (!decoded || decoded === current) break;
    current = decoded;
  }

  return candidates;
}

/**
 * 把一条原始路径的三个形态塞进候选集合。
 *
 * @param {Set<string>} bucket
 * @param {string} raw
 */
function addVariants(bucket, raw) {
  const normalized = normalizePathname(raw);
  const lower = normalized.toLowerCase();

  // 保留尾斜杠：用于目录前缀匹配（`/docs/`）
  bucket.add(lower);

  // 去掉尾斜杠：用于精确匹配（`/wrangler.toml` 与 `/wrangler.toml/` 同义）
  const stripped = normalizePathname(lower.replace(/\/+$/, '') || '/');
  bucket.add(stripped);

  // 去噪后再来一次
  const denoised = normalizePathname(stripNoise(lower));
  bucket.add(denoised);
  bucket.add(normalizePathname(stripNoise(lower).replace(/\/+$/, '') || '/'));
}
