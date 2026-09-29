/**
 * 隔空投送 —— 房间状态轮询
 * GET /api/airdrop/status?code=XXXXXXXX&token=...
 *
 * 两端都靠这个接口推进状态机（每秒级一次）。没有用 WebSocket 是因为
 * Pages Functions 没有长连接能力，而这个功能的跃迁频率低到轮询完全够用。
 *
 * 之所以要 token 才能看状态：房间里有文件名、大小这些对方不该提前知道的
 * 信息（收端在"等待对方发送"阶段不该看到发端选了什么）。
 */
import {
  getSession,
  roleOf,
  sessionView,
  jsonResponse
} from '../../utils/airdrop.js';
import { getClientIp, fixedWindowRateLimit } from '../../utils/ratelimit.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const params = new URL(request.url).searchParams;
  const code = String(params.get('code') || '').trim().toUpperCase();
  const token = String(params.get('token') || '').trim();

  if (!code || !token) {
    return jsonResponse({ error: '缺少 code 或 token。', code: 'BAD_PARAMS' }, 400);
  }

  // 轮询是高频路径，给它单独的宽松配额。卡在这里会直接表现为"两边都不动"，
  // 所以宁可放宽：真正的滥用面在 create/join/upload，那三处已有门禁。
  const rl = await fixedWindowRateLimit({
    env,
    key: getClientIp(request),
    namespace: 'airdrop-poll',
    windowMs: 60 * 1000,
    max: 180
  });
  if (!rl.allowed) {
    return jsonResponse(
      { error: '请求过于频繁，请稍后再试。', code: 'RATE_LIMITED' },
      429,
      { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) }
    );
  }

  const session = await getSession(env, code);
  if (!session) {
    return jsonResponse({ error: '房间不存在或已过期。', code: 'EXPIRED' }, 404);
  }

  const role = roleOf(session, token);
  if (!role) {
    return jsonResponse({ error: '无权查看该房间。', code: 'FORBIDDEN' }, 403);
  }

  return jsonResponse({ ok: true, session: sessionView(session, role) });
}
