/**
 * 隔空投送 —— 发端创建房间
 * POST /api/airdrop/create
 *
 * 成功返回 8 位连接码（给收端看）与发端凭证（给后续上传用）。
 * 连接码和凭证的分工见 utils/airdrop.js 顶部说明：一个负责「找到房间」，
 * 一个负责「证明你是房间里的人」。
 *
 * 本接口不设管理员鉴权 —— 隔空投送面向普通用户（是否对访客开放由
 * 后台的 guestAllowed 决定，即"访客能否发起"），门禁全部走 checkAirdropAccess。
 * 注意这是**发端**门禁：收端加入走的是 checkAirdropReceiveAccess（join.js），
 * 两者不应混用。
 */
import {
  checkAirdropAccess,
  createSession,
  incrementDailyCount,
  releaseDailySlot,
  resolveBackend,
  jsonResponse
} from '../../utils/airdrop.js';
import { getClientIp, fixedWindowRateLimit } from '../../utils/ratelimit.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  // 硬限流：每日额度走 KV 计数，而 KV 的"读-判定-写"不是原子的 ——
  // 并发请求会同时读到旧值、一起放行（实测：限额 3 时并发 12 个全部成功）。
  // KV 没有原子自增，靠它做硬约束不现实；这里补一层**IP 级固定窗口**：
  // 它是每窗口一次的确定性判定，不受读-改-写竞态影响，能把并发刷量按住。
  // 阈值按"正常用户不可能触发"设置（建房间是低频操作），
  // 真正的精细策略仍交给 Cloudflare Rate Limiting / WAF。
  const ip = getClientIp(request);
  const rl = await fixedWindowRateLimit({
    env,
    key: ip,
    namespace: 'airdrop-create',
    windowMs: 60 * 1000,
    max: 10
  });
  if (!rl.allowed) {
    return jsonResponse(
      { error: '创建投送过于频繁，请稍后再试。', code: 'RATE_LIMITED' },
      429,
      { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) }
    );
  }

  const gate = await checkAirdropAccess(request, env);
  if (!gate.allowed) {
    return jsonResponse({ error: gate.reason, code: gate.code, requireLogin: gate.status === 401 }, gate.status);
  }

  const created = await createSession(env, request);
  if (!created.ok) {
    // 建房间没成功就把本地占的坑还回去：额度只该为**成功**的投送计数
    releaseDailySlot(gate.ip);
    return jsonResponse({ error: created.error, code: 'CREATE_FAILED' }, 500);
  }

  // 只有真正建成功才消耗当日额度：失败的请求不该扣用户的次数
  await incrementDailyCount(env, gate.ip);

  const backend = resolveBackend(env);
  return jsonResponse({
    ok: true,
    code: created.code,
    senderToken: created.senderToken,
    expiresAt: created.expiresAt,
    ttlMinutes: gate.config.ttlMinutes,
    backend: backend.backend,
    backendLabel: backend.label,
    // 节点能力与管理配置取小：管理员能收紧，但不能超出节点本身的上限
    maxBytes: Math.min(backend.maxBytes, gate.config.maxFileSize)
  });
}
