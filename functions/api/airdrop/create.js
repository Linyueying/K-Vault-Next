/**
 * 隔空投送 —— 发端创建房间
 * POST /api/airdrop/create
 *
 * 成功返回 8 位连接码（给收端看）与发端凭证（给后续上传用）。
 * 连接码和凭证的分工见 utils/airdrop.js 顶部说明：一个负责「找到房间」，
 * 一个负责「证明你是房间里的人」。
 *
 * 本接口不设管理员鉴权 —— 隔空投送面向普通用户（是否对访客开放由
 * 后台的 guestAllowed 决定），门禁全部走 checkAirdropAccess。
 */
import {
  checkAirdropAccess,
  createSession,
  incrementDailyCount,
  resolveBackend,
  jsonResponse
} from '../../utils/airdrop.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const gate = await checkAirdropAccess(request, env);
  if (!gate.allowed) {
    return jsonResponse({ error: gate.reason, code: gate.code, requireLogin: gate.status === 401 }, gate.status);
  }

  const created = await createSession(env, request);
  if (!created.ok) {
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
