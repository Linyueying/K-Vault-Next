/**
 * 隔空投送 —— 收端凭连接码加入房间
 * POST /api/airdrop/join   { code: "AB3KD9XQ" }
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
  joinSession,
  jsonResponse
} from '../../utils/airdrop.js';
import { getClientIp, fixedWindowRateLimit } from '../../utils/ratelimit.js';

const CODE_PATTERN = /^[A-Z0-9]{8}$/;

export async function onRequestPost(context) {
  const { request, env } = context;

  // 枚举防护：连接码只有 8 位（约 39 bit），不加限流的话可以拿脚本批量试。
  // 正常用户一次投送只会 join 一两次，20 次/分钟足够宽松、不会误伤，
  // 但足以把"批量猜码"的成本抬到不可行。
  const rl = await fixedWindowRateLimit({
    env,
    key: getClientIp(request),
    namespace: 'airdrop-join',
    windowMs: 60 * 1000,
    max: 20
  });
  if (!rl.allowed) {
    return jsonResponse(
      { error: '尝试过于频繁，请稍后再试。', code: 'RATE_LIMITED' },
      429,
      { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: '请求体必须是 JSON。', code: 'BAD_BODY' }, 400);
  }

  // 连接码允许小写输入（手机软键盘默认首字母大写/小写混着来），统一抬升
  const code = String(body?.code || '').trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) {
    return jsonResponse({ error: '连接码为 8 位字母数字组合。', code: 'BAD_CODE' }, 400);
  }

  const gate = await checkAirdropReceiveAccess(request, env);
  if (!gate.allowed) {
    return jsonResponse({ error: gate.reason, code: gate.code, requireLogin: gate.status === 401 }, gate.status);
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
