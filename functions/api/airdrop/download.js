/**
 * 隔空投送 —— 收端下载
 * GET /api/airdrop/download?code=XXXXXXXX&token=...
 *
 * 必须带收端凭证：8 位连接码会出现在二维码里，不足以作为下载凭据。
 *
 * 只在 uploaded 状态可取。进入 done 后临时文件已被删除 —— 投递是一次性的，
 * 文件落地到收端本地即完成使命，不留在中转节点上占空间、也不留副本。
 */
import {
  getSession,
  roleOf,
  readTempFile,
  contentDisposition,
  jsonResponse
} from '../../utils/airdrop.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const params = new URL(request.url).searchParams;
  const code = String(params.get('code') || '').trim().toUpperCase();
  const token = String(params.get('token') || '').trim();

  if (!code || !token) {
    return jsonResponse({ error: '缺少 code 或 token。', code: 'BAD_PARAMS' }, 400);
  }

  const session = await getSession(env, code);
  if (!session) {
    return jsonResponse({ error: '房间不存在或已过期。', code: 'EXPIRED' }, 404);
  }
  if (roleOf(session, token) !== 'receiver') {
    return jsonResponse({ error: '只有接收方可以下载。', code: 'FORBIDDEN' }, 403);
  }
  if (session.status !== 'uploaded') {
    return jsonResponse(
      { error: session.status === 'done' ? '本次投递已完成。' : '对方还没有发送文件。', code: 'NOT_READY' },
      409
    );
  }

  const file = await readTempFile(env, session);
  if (!file) {
    return jsonResponse({ error: '文件已失效，请让对方重新发送。', code: 'GONE' }, 410);
  }

  return new Response(file.body, {
    headers: {
      'Content-Type': session.file_type || 'application/octet-stream',
      'Content-Length': String(file.size || session.file_size || 0),
      'Content-Disposition': contentDisposition(session.file_name),
      'Cache-Control': 'no-store'
    }
  });
}
