/**
 * 隔空投送 —— 收端凭连接码加入房间
 * POST /api/airdrop/join   { code: "AB3KD9XQ" }
 *
 * 加入成功会签发一个收端凭证，之后下载必须带它。连接码本身不参与下载鉴权：
 * 它会出现在二维码里、可能被旁人看到，不足以作为凭据。
 */
import {
  checkAirdropAccess,
  joinSession,
  jsonResponse
} from '../../utils/airdrop.js';

const CODE_PATTERN = /^[A-Z0-9]{8}$/;

export async function onRequestPost(context) {
  const { request, env } = context;

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

  const gate = await checkAirdropAccess(request, env);
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
