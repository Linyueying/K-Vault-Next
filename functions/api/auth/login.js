/**
 * 登录 API
 * POST /api/auth/login
 */
import {
  createSession,
  createSessionCookieHeader,
  isAuthRequired
} from '../../utils/auth.js';

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
    // 如果没有配置认证，返回成功
    if (!isAuthRequired(env)) {
      return new Response(JSON.stringify({
        success: true,
        message: '无需登录',
        authRequired: false
      }), {
        headers: { 'Content-Type': 'application/json' }
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

    // 验证凭据
    if (username === env.BASIC_USER && password === env.BASIC_PASS) {
      // 创建会话
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