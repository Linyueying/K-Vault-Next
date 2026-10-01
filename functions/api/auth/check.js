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
import { availableBackends } from '../../utils/airdrop.js';

/**
 * 隔空投送对前端可见的能力描述。
 *
 * 这里只下发"能不能用、能传多大"这类**非敏感**信息，不下发任何房间凭证。
 * 前端拿它做两件事：功能关闭时直接隐藏入口；访客不可用时把入口置灰并提示登录。
 */
async function buildAirdropInfo(env) {
  try {
    const cfg = await getAirdropConfig(env);
    // 可用中转节点（R2 / Telegram）；发端在界面上二选一，默认值由前端沿用
    // index 页当前选的节点。没有可用节点则功能整体不可用。
    const nodes = availableBackends(env);
    return {
      enabled: Boolean(cfg.enabled) && nodes.length > 0,
      // 访客能否**发起**投送（发端）。缺省 false。
      guestAllowed: Boolean(cfg.guestAllowed),
      // 访客能否**接收**投送（收端）。缺省 true —— 与 guestAllowed 方向相反。
      // 前端据此决定访客能否进「我要接收」；进错了会把"扫码收不了文件"重现。
      guestReceiveAllowed: Boolean(cfg.guestReceiveAllowed),
      nodes,
      ttlMinutes: cfg.ttlMinutes
    };
  } catch (e) {
    // 能力探测失败不该让登录检查整个挂掉：按"不可用"处理，前端隐藏入口
    console.error('Airdrop capability error:', e);
    return { enabled: false, guestAllowed: false, guestReceiveAllowed: true, nodes: [] };
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