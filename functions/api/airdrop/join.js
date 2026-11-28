/**
 * 隔空投送 —— 收端凭连接码加入房间
 * POST /api/airdrop/join   { code: "012345" }
 *
 * 加入成功会签发一个收端凭证，之后下载必须带它。连接码本身不参与下载鉴权：
 * 它会出现在二维码里、可能被旁人看到，不足以作为凭据。
 *
 * 门禁用 checkAirdropReceiveAccess（收端语义）：只看总开关与节点可用性，
 * 不被 guestAllowed（"访客能否发起"）拦住 —— 授权用户开好房间、把码给对方，
 * 对方（哪怕是访客）就应该能收。访客能否当收端由 guestReceiveAllowed 决定。
 */
import {
  checkAirdropReceiveAccess,
  claimJoinAttempt,
  joinSession,
  jsonResponse,
  AIRDROP_CODE_PATTERN,
  LEGACY_AIRDROP_CODE_PATTERN
} from '../../utils/airdrop.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: '请求体必须是 JSON。', code: 'BAD_BODY' }, 400);
  }

  const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!AIRDROP_CODE_PATTERN.test(code) && !LEGACY_AIRDROP_CODE_PATTERN.test(code)) {
    return jsonResponse({ error: '请输入 6 位数字连接码。', code: 'BAD_CODE' }, 400);
  }

  const gate = await checkAirdropReceiveAccess(request, env);
  if (!gate.allowed) {
    return jsonResponse({ error: gate.reason, code: gate.code, requireLogin: gate.status === 401 }, gate.status);
  }

  let retryAfter;
  try {
    // 只信任 Cloudflare 注入的地址。无可信地址时共用一个 IP 配额。
    retryAfter = await claimJoinAttempt(env, request.headers.get('CF-Connecting-IP')?.trim() || 'unknown');
  } catch (error) {
    console.error('Airdrop join limiter error:', error);
    return jsonResponse({ error: '配对暂时不可用，请稍后再试。', code: 'JOIN_UNAVAILABLE' }, 503);
  }
  if (retryAfter) {
    return jsonResponse(
      { error: '尝试过于频繁，请稍后再试。', code: 'RATE_LIMITED' },
      429,
      { 'Retry-After': String(retryAfter) }
    );
  }

  const joined = await joinSession(env, code);
  if (!joined.ok) {
    const code2 = joined.status === 404 ? 'NOT_FOUND'
      : joined.status === 410 ? 'EXPIRED'
      : 'JOIN_FAILED';
    return jsonResponse({ error: joined.error, code: code2 }, joined.status || 409);
  }

  return jsonResponse({
    ok: true,
    code: joined.code,
    receiverToken: joined.receiverToken,
    expiresAt: joined.expiresAt
  });
}
