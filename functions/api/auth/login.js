/**
 * 登录 API
 * POST /api/auth/login
 */
import {
  createSession,
  createSessionCookieHeader,
  isAuthRequired,
  safeStringEqual,
} from '../../utils/auth.js';
import {
  getClientIp,
  fixedWindowRateLimit,
  getAccountLockState,
  applyFailure,
  resetFailures,
} from '../../utils/ratelimit.js';

// 登录限流参数（可按实例调整）
const LOGIN_IP_WINDOW_MS = 60 * 1000;          // 1 分钟窗口
const LOGIN_IP_MAX = 15;                        // 每 IP 每窗口最多 15 次登录尝试（含成功）
const LOGIN_MAX_FAILS = 5;                      // 同一账户连续失败 5 次触发锁定
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;    // 失败计数在 15 分钟内累计（滑动窗口）
const LOGIN_LOCK_MS = 15 * 60 * 1000;           // 锁定 15 分钟

/**
 * 显式拒绝 GET，防止任何方法混淆或意外执行
 */
export function onRequestGet() {
  return new Response(JSON.stringify({
    success: false,
    message: 'Method Not Allowed'
  }), {
    status: 405,
    headers: {
      'Content-Type': 'application/json',
      'Allow': 'POST'
    }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 未配置认证：无需登录，直接放行（无登录表单可爆破）
    if (!isAuthRequired(env)) {
      return new Response(JSON.stringify({
        success: true,
        message: '无需登录',
        authRequired: false
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const ip = getClientIp(request);

    // 1) IP 级节流：防止单 IP 高频扫号 / 分布式爆破的总闸门。
    //    成功与失败都计入，避免攻击者用成功请求探测窗口边缘。
    const ipRl = await fixedWindowRateLimit({
      env, key: ip, namespace: 'login-ip',
      windowMs: LOGIN_IP_WINDOW_MS, max: LOGIN_IP_MAX,
    });
    if (!ipRl.allowed) {
      const retryAfter = Math.ceil(ipRl.retryAfterMs / 1000);
      return new Response(JSON.stringify({
        success: false,
        code: 'RATE_LIMITED',
        message: '登录尝试过于频繁，请稍后再试。',
        retryAfterMs: ipRl.retryAfterMs,
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(ipRl.limit),
          'X-RateLimit-Remaining': String(ipRl.remaining),
        },
      });
    }

    const body = await request.json();
    const username = String(body?.username ?? body?.user ?? '').trim();
    const password = String(body?.password ?? body?.pass ?? '');

    if (!username || password === '') {
      return new Response(JSON.stringify({
        success: false,
        message: 'Missing username or password.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2) 恒定时间比较：两次比较总是执行（无短路），避免时序泄露用户名是否存在。
    const userMatch = safeStringEqual(username, env.BASIC_USER);
    const passMatch = safeStringEqual(password, env.BASIC_PASS);

    if (userMatch) {
      // 3) 账户级失败锁定（仅对存在的用户名维度生效，跨 IP —— 防针对某账户的定向爆破）。
      const lock = await getAccountLockState(env, username, 'login-account', {
        windowMs: LOGIN_FAIL_WINDOW_MS,
        lockMs: LOGIN_LOCK_MS,
      });
      if (lock.locked) {
        const retryAfter = Math.ceil(lock.retryAfterMs / 1000);
        return new Response(JSON.stringify({
          success: false,
          code: 'ACCOUNT_LOCKED',
          message: '该账户因多次登录失败已被临时锁定，请稍后再试。',
          retryAfterMs: lock.retryAfterMs,
        }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfter),
          },
        });
      }

      if (passMatch) {
        // 登录成功：清零失败计数
        await resetFailures(env, username, 'login-account');
        const sessionToken = await createSession(username, env);

        return new Response(JSON.stringify({
          success: true,
          message: '登录成功'
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': createSessionCookieHeader(sessionToken)
          }
        });
      }

      // 密码错误：登记失败，可能触发锁定
      const failRes = await applyFailure(env, lock._internal, {
        maxFails: LOGIN_MAX_FAILS,
        windowMs: LOGIN_FAIL_WINDOW_MS,
        lockMs: LOGIN_LOCK_MS,
      });
      if (failRes.locked) {
        const retryAfter = Math.ceil(failRes.retryAfterMs / 1000);
        return new Response(JSON.stringify({
          success: false,
          code: 'ACCOUNT_LOCKED',
          message: '该账户因多次登录失败已被临时锁定 15 分钟。',
          retryAfterMs: failRes.retryAfterMs,
        }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfter),
          },
        });
      }
    } else {
      // 用户名不存在：passMatch 已执行以维持相近耗时（防时序枚举），
      // 但不登记失败（不对该用户名写 KV，且本就无法登录成功）。
    }

    return new Response(JSON.stringify({
      success: false,
      message: '用户名或密码错误'
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Login error:', error);
    return new Response(JSON.stringify({
      success: false,
      message: '登录失败：' + error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}