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