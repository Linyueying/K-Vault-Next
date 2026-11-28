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
      return jsonResponse({
        authenticated: true,
        authRequired: false,
        message: '无需登录',
        guestUpload: guestConfig,
        airdrop
      });
    }

    const authResult = await checkAuthentication(context);

    // 未登录响应只留「能不能进」的判定依据。
    //
    // `guestUpload`（访客配额）与 `airdrop` 里的房间 TTL / 每日限额 / 单文件
    // 上限，都是站点级的运营参数。它们挂在**登录检查**这个必然对匿名开放、
    // 也无法关闭的入口上，等于给任意路过的人递一张你家 dashboard 的复印件。
    //
    // 但 airdrop 的 `enabled` 不属于运营参数，它是**入口可用性**：访客凭连接码
    // 接收投送是本功能的核心用法（收端门禁见 utils/airdrop.js 的
    // checkAirdropReceiveAccess），扫码落到 index 页后前端必须先知道
    // 「此刻能不能用」，否则只能拿默认值 false 去猜。此前这里把 airdrop 整个
    // 移除，于是未登录扫码时 capability 停在初始的 `{enabled:false, nodes:[]}`，
    // 入口把「能力未知」误判成「没有中转节点」——表象正是
    // 「未登录用户扫码接收，提示没有可用储存节点」，而房间与节点其实都好着。
    //
    // 折中：只下发**收端够用**的最小能力（开关 + 两个访客权限位 + 节点清单），
    // 这些字段匿名侧本来就能通过 create/join 的错误码探测出来；房间 TTL、
    // dailyLimit、maxFileSize 等运营参数继续隐藏 —— 只有发端用得上，
    // 合起来才是「这个站怎么配的」的完整侧写。
    if (!authResult.authenticated) {
      return jsonResponse({
        authenticated: false,
        authRequired: true,
        airdrop: {
          enabled: airdrop.enabled,
          guestAllowed: airdrop.guestAllowed,
          guestReceiveAllowed: airdrop.guestReceiveAllowed,
          nodes: airdrop.nodes,
        },
      });
    }

    // `authResult.reason` 是内部判定来源（'session' / 'basic-auth' /
    // 'no-auth-required'），把认证机制告诉调用方没有价值，只多了侦察面。
    return jsonResponse({
      authenticated: true,
      authRequired: true,
      guestUpload: guestConfig,
      airdrop
    });

  } catch (error) {
    // 细节只在服务端留痕，不回显给客户端
    console.error('Auth check error:', error);
    return jsonResponse(
      { authenticated: false, authRequired: true, error: 'Auth check failed' },
      500
    );
  }
}

/**
 * 认证态响应一律 `no-store` + `Vary: Cookie`。
 *
 * 这个响应随会话 Cookie 变化。缺 `no-store` 时，中间缓存（或浏览器启发式
 * 缓存）可能把「已登录」的结果拿去应答另一个人 —— 那是最糟糕的一类缓存事故。
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Vary: 'Cookie',
    },
  });
}