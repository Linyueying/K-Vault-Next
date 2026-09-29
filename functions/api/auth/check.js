/**
 * 检查认证状态 API
 * GET /api/auth/check
 */
import {
  checkAuthentication,
  isAuthRequired
} from '../../utils/auth.js';
import { getGuestConfig } from '../../utils/guest.js';
import { getAirdropConfig } from '../../utils/runtime-config.js';
import { effectiveMaxBytes, resolveBackend } from '../../utils/airdrop.js';
import { envValue } from '../../utils/env-config.js';

/**
 * 隔空投送对前端可见的能力描述。
 *
 * 这里只下发"能不能用、能传多大"这类**非敏感**信息，不下发任何房间凭证。
 * 前端拿它做两件事：功能关闭时直接隐藏入口；访客不可用时把入口置灰并提示登录。
 */
async function buildAirdropInfo(env) {
  try {
    const cfg = await getAirdropConfig(env);
    const limit = await effectiveMaxBytes(env);
    const hasTG = Boolean(env?.TG_BOT_TOKEN) && Boolean(envValue(env, 'TG_CHAT_ID'));
    return {
      enabled: Boolean(cfg.enabled) && Boolean(limit.backend),
      guestAllowed: Boolean(cfg.guestAllowed),
      maxBytes: limit.maxBytes || 0,
      backend: limit.backend,
      backendLabel: limit.label,
      ttlMinutes: cfg.ttlMinutes,
      hasR2: Boolean(env?.R2_BUCKET),
      hasKV: Boolean(env?.img_url),
      hasTG
    };
  } catch (e) {
    // 能力探测失败不该让登录检查整个挂掉：按"不可用"处理，前端隐藏入口
    console.error('Airdrop capability error:', e);
    return { enabled: false, guestAllowed: false, maxBytes: 0, backend: null };
  }
}

export async function onRequestGet(context) {
  const { env } = context;

  try {
    const guestConfig = await getGuestConfig(env);
    const airdrop = await buildAirdropInfo(env);
    const authRequired = isAuthRequired(env); // 明确转为布尔值使用

    // 如果没有配置认证
    if (!authRequired) {
      return new Response(JSON.stringify({
        authenticated: true,
        authRequired: false,
        message: '无需登录',
        guestUpload: guestConfig,
        airdrop
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const authResult = await checkAuthentication(context);

    return new Response(JSON.stringify({
      authenticated: authResult.authenticated,
      authRequired: true,
      reason: authResult.reason,
      guestUpload: guestConfig,
      airdrop
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Auth check error:', error);
    return new Response(JSON.stringify({
      authenticated: false,
      authRequired: true,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}