/**
 * 隔空投送 —— 收端下载单个文件
 * GET /api/airdrop/download?code=XXXXXXXX&token=...&idx=0
 *
 * 必须带收端凭证：8 位连接码会出现在二维码里，不足以作为下载凭据。
 *
 * 房间进入 uploaded（发端整批发完）后才能取；取完把该条目标记为 downloaded。
 * 全部文件都 downloaded 后，收端调用 /api/airdrop/complete 确认完成。
 * 进入 done 后临时文件已被删除 —— 投递是一次性的，文件落地到收端本地即
 * 完成使命，不留在中转节点上占空间、也不留副本。
 */
import {
  getSession,
  roleOf,
  parseManifest,
  readTempFile,
  markFileDownloaded,
  contentDisposition,
  jsonResponse
} from '../../utils/airdrop.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const params = new URL(request.url).searchParams;
  const code = String(params.get('code') || '').trim().toUpperCase();
  const token = String(params.get('token') || '').trim();
  const idxRaw = params.get('idx');
  const idx = Number.isInteger(Number(idxRaw)) ? Number(idxRaw) : -1;

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
  if (session.status === 'uploading') {
    return jsonResponse({ error: '对方还在发送文件，请稍候。', code: 'NOT_READY' }, 409);
  }
  if (session.status !== 'uploaded') {
    return jsonResponse(
      { error: session.status === 'done' ? '本次投递已完成。' : '对方还没有发送文件。', code: 'NOT_READY' },
      409
    );
  }

  const files = parseManifest(session.files_json);
  const file = files[idx];
  if (!file) {
    return jsonResponse({ error: '文件不存在或已失效。', code: 'GONE' }, 410);
  }

  const stream = await readTempFile(env, file);
  if (!stream) {
    return jsonResponse({ error: '文件已失效，请让对方重新发送。', code: 'GONE' }, 410);
  }

  // 先让浏览器开始收，再在后台标记已下载（标记失败不应打断下载本身）
  markFileDownloaded(env, code, idx).catch(() => {});

  return new Response(stream.body, {
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'Content-Length': String(stream.size || file.size || 0),
      'Content-Disposition': contentDisposition(file.name),
      'Cache-Control': 'no-store'
    }
  });
}
