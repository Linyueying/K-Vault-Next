/**
 * 认证工具模块
 * 支持 Cookie-based 会话认证和 Basic Auth
 */

const SESSION_COOKIE_NAME = 'k_vault_session';
const LEGACY_SESSION_COOKIE_NAME = 'katelya_session';
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24小时

/**
 * 生成会话令牌
 */
export function generateSessionToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 验证 Basic Auth 凭据
 */
export function verifyBasicAuth(request, env) {
  const authorization = request.headers.get('Authorization');
  if (!authorization) return null;

  const [scheme, encoded] = authorization.split(' ');
  if (!encoded || scheme !== 'Basic') return null;

  try {
    const buffer = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(buffer).normalize();
    const index = decoded.indexOf(':');

    if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) return null;

    const user = decoded.substring(0, index);
    const pass = decoded.substring(index + 1);

    if (env.BASIC_USER === user && env.BASIC_PASS === pass) {
      return { user, authenticated: true };
    }
  } catch (e) {
    console.error('Basic auth decode error:', e);
  }
  return null;
}

/**
 * 从 Cookie 获取会话
 */
export function getSessionFromCookie(request) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.split('=');
    const value = valueParts.join('=');
    if (name === SESSION_COOKIE_NAME || name === LEGACY_SESSION_COOKIE_NAME) {
      return value;
    }
  }
  return null;
}

/**
 * 验证会话令牌
 */
export async function verifySession(sessionToken, env) {
  if (!sessionToken || !env.img_url) return null;

  try {
    const sessionData = await env.img_url.get(`session:${sessionToken}`, { type: 'json' });
    if (!sessionData) return null;

    // 检查会话是否过期
    if (Date.now() > sessionData.expiresAt) {
      await env.img_url.delete(`session:${sessionToken}`);
      return null;
    }

    return sessionData;
  } catch (e) {
    console.error('Session verify error:', e);
    return null;
  }
}

/**
 * 创建会话
 */
export async function createSession(user, env) {
  const token = generateSessionToken();
  const sessionData = {
    user,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION
  };

  await env.img_url.put(`session:${token}`, JSON.stringify(sessionData), {
    expirationTtl: Math.floor(SESSION_DURATION / 1000)
  });

  return token;
}

/**
 * 删除会话
 */
export async function deleteSession(sessionToken, env) {
  if (sessionToken && env.img_url) {
    await env.img_url.delete(`session:${sessionToken}`);
  }
}

/**
 * 创建带会话 Cookie 的响应
 */
export function createSessionCookieHeader(token, maxAge = SESSION_DURATION / 1000) {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

/**
 * 创建清除会话 Cookie 的响应头
 */
export function createClearSessionCookieHeader() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function createLegacyClearSessionCookieHeader() {
  return `${LEGACY_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/**
 * 检查是否需要认证
 * 必须返回布尔值，避免因 JavaScript && 返回操作数本身而泄露密码
 */
export function isAuthRequired(env) {
  return Boolean(env.BASIC_USER && env.BASIC_PASS);
}

/* ============================================================
 * 预览部署（Preview Deployment）访问控制
 * ============================================================
 *
 * ## 问题
 *
 * Cloudflare Pages 的**环境变量默认只对生产环境生效**，「Include preview
 * deployments」不勾选时，分支预览部署拿不到 `BASIC_USER` / `BASIC_PASS`。
 * 而 `isAuthRequired()` 的语义是「没配凭据 = 不需要认证」，于是预览部署上的
 * 整套鉴权**自动关闭**：管理接口、素材列表、签名接口一律匿名可达。
 *
 * 这个语义对生产环境是合理的（确实存在「有意公开的图床实例」），但对预览
 * 部署不合理 —— 那里没有「有意公开」这回事，只有「忘了配变量」。
 *
 * ## 修法
 *
 * 识别预览域名，并在凭据缺失时 **fail-closed**：拒绝访问，而不是放行。
 * 默认值取「安全的一侧」，需要公开预览时必须显式设置开关。
 */

/**
 * 是否为 Cloudflare Pages 的预览部署。
 *
 * 判定依据是 Pages 自己的域名形态：
 *
 *   | 部署类型     | 域名                              | 去掉 `.pages.dev` 后的段数 |
 *   |--------------|-----------------------------------|----------------------------|
 *   | 生产         | `<project>.pages.dev`             | 1                          |
 *   | 分支预览     | `<branch>.<project>.pages.dev`    | ≥2                         |
 *   | 提交预览     | `<hash>.<project>.pages.dev`      | ≥2                         |
 *
 * 自定义域名（生产为主）一律不当预览处理，避免误伤正式站点。
 *
 * @param {Request} request
 * @param {object} env
 * @returns {boolean}
 */
export function isPreviewDeployment(request, env) {
  let hostname = '';
  try {
    hostname = new URL(request.url).hostname.toLowerCase();
  } catch {
    hostname = '';
  }

  if (!hostname) {
    const pagesUrl = String(env?.CF_PAGES_URL || '').trim().toLowerCase();
    hostname = pagesUrl.replace(/^https?:\/\//, '').split('/')[0] || '';
  }

  if (!hostname.endsWith('.pages.dev')) return false;

  const labels = hostname
    .slice(0, -'.pages.dev'.length)
    .split('.')
    .filter(Boolean);

  // 生产域名只有 project 一段；任何多出来的前缀都说明这是预览部署
  return labels.length > 1;
}

/**
 * 预览部署是否被显式允许公开访问。
 *
 * 逃生舱：确实需要公开预览（例如给外部做 UI 评审）时设置
 * `PREVIEW_DEPLOYMENT_PUBLIC=true`。默认不设 = 收紧。
 *
 * @param {object} env
 * @returns {boolean}
 */
function previewExplicitlyPublic(env) {
  return String(env?.PREVIEW_DEPLOYMENT_PUBLIC ?? '')
    .trim()
    .toLowerCase() === 'true';
}

/**
 * 预览部署的门禁：返回 null 表示放行，返回 Response 表示拦截。
 *
 * 放行条件（任一满足）：
 *   1. 不是 Pages 预览部署 —— 生产站点保持原有语义，公开实例照常公开；
 *   2. 已配置 BASIC_USER / BASIC_PASS —— 交给正常的会话 / Basic Auth 流程；
 *   3. 显式设置了 `PREVIEW_DEPLOYMENT_PUBLIC=true`。
 *
 * 其余情况一律 fail-closed。
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Response|null}
 */
export function previewAccessGuard(request, env) {
  if (!isPreviewDeployment(request, env)) return null;
  if (isAuthRequired(env)) return null;
  if (previewExplicitlyPublic(env)) return null;

  return new Response(
    JSON.stringify({
      error: 'PREVIEW_ACCESS_DENIED',
      code: 'PREVIEW_AUTH_NOT_CONFIGURED',
      message:
        'This is a Cloudflare Pages preview deployment and no BASIC_USER / BASIC_PASS ' +
        'is configured for this environment. Access is denied by default (fail-closed). ' +
        'Configure the credentials for preview deployments, set PREVIEW_DEPLOYMENT_PUBLIC=true ' +
        'to opt out explicitly, or disable preview deployments in the Cloudflare dashboard.',
    }),
    {
      status: 403,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Cache-Control': 'no-store',
        'X-Preview-Access': 'denied',
      },
    }
  );
}

/**
 * 综合认证检查
 */
export async function checkAuthentication(context) {
  const { request, env } = context;

  // 如果没有配置认证，直接放行
  if (!isAuthRequired(env)) {
    return { authenticated: true, reason: 'no-auth-required' };
  }

  // 检查 Cookie 会话
  const sessionToken = getSessionFromCookie(request);
  const sessionData = sessionToken ? await verifySession(sessionToken, env) : null;
  if (sessionData) {
    return {
      authenticated: true,
      reason: 'session',
      token: sessionToken,
      user: sessionData.user,
    };
  }

  // 检查 Basic Auth
  const basicAuth = verifyBasicAuth(request, env);
  if (basicAuth) {
    return { authenticated: true, reason: 'basic-auth', user: basicAuth.user };
  }

  return { authenticated: false };
}

/**
 * 恒定时间字符串比较，用于凭据校验，防止时序攻击。
 *
 * 注意：Cloudflare Workers / 浏览器环境的 Web Crypto（crypto.subtle）
 * 没有 timingSafeEqual（那是 Node 专有 API），因此这里用纯 JS 实现：
 * 遍历两串的较短长度做逐字节 XOR 累加，并以长度异或反映长度差异，
 * 既不短路、也不依赖任何非标准 API，在 Workers / 浏览器 / Node 下行为一致。
 *
 * 长度不同直接反映到 diff 并返回 false（不泄露「差多少」，只泄露「不相等」），
 * 调用方务必「总是执行两次比较、再用 && 组合」，避免短路泄露用户名是否存在
 * （见 functions/api/auth/login.js）。
 */
export function safeStringEqual(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  const ea = new TextEncoder().encode(sa);
  const eb = new TextEncoder().encode(sb);
  const lenA = ea.length;
  const lenB = eb.length;
  // 长度差异直接反映到 diff（不泄露具体差多少，只泄露「不相等」）。
  let diff = lenA ^ lenB;
  const n = lenA < lenB ? lenA : lenB;
  for (let i = 0; i < n; i++) {
    diff |= ea[i] ^ eb[i];
  }
  return diff === 0;
}