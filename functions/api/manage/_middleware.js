import { 
  checkAuthentication,
  isAuthRequired 
} from '../../utils/auth.js';
import { apiError } from '../../utils/api-v1.js';

/**
 * The login entry helper deliberately stays reachable while logged out.
 * Without this allowlist the middleware answers 401 first, so the
 * "401 -> /api/manage/login" recovery flow used by gallery.html dead-ends on a
 * plain-text 401 instead of redirecting the visitor to the login page.
 */
const LOGIN_HELPER_PATH = '/api/manage/login';

function isLoginHelper(request) {
  try {
    const pathname = new URL(request.url).pathname.replace(/\/+$/, '');
    return pathname === LOGIN_HELPER_PATH;
  } catch {
    return false;
  }
}

async function errorHandling(context) {
    try {
      return await context.next();
    } catch (err) {
      return new Response(`${err.message}\n${err.stack}`, { status: 500 });
    }
  }

    
    
  
  async function authentication(context) {
    // 检查 KV 是否绑定
    if (typeof context.env.img_url == "undefined" || context.env.img_url == null || context.env.img_url == "") {
        return new Response('Dashboard is disabled. Please bind a KV namespace to use this feature.', { status: 200 });
    }

    // 登录入口本身必须能在未登录状态访问，否则无法登录。
    if (isLoginHelper(context.request)) {
        return context.next();
    }

    // 管理接口 fail-closed：未配置 BASIC_USER/BASIC_PASS 时拒绝所有请求。
    // 修复前此处直接放行，等于「没设密码 = 删除/重命名/移动/黑白名单全部对公网开放」。
    // 该策略与 /api/admin/** 以及 README 记录的 admin API 策略保持一致。
    if (!isAuthRequired(context.env)) {
        return apiError(
          'ADMIN_AUTH_NOT_CONFIGURED',
          'Management API requires BASIC_USER and BASIC_PASS to be configured. It fails closed when no admin credential is set.',
          503
        );
    }
    
    // 使用统一的认证检查（支持 Cookie session 和 Basic Auth）
    const authResult = await checkAuthentication(context);
    
    if (authResult.authenticated) {
        return context.next();
    }
    
    // 认证失败，返回 401
    return new Response('You need to login.', {
        status: 401,
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'Cache-Control': 'no-store',
        },
    });
  }
  
  export const onRequest = [errorHandling, authentication];