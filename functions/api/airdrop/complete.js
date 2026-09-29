/**
 * 隔空投送 —— 完成确认
 * POST /api/airdrop/complete   { code, token }
 *
 * 由收端在文件真正落到本地之后调用。这一刻同时做两件事：
 *   1. 房间进入 done，发端轮询到之后播放"已送达"
 *   2. 删除中转节点上的临时文件
 *
 * 只允许收端调用：如果发端也能点"完成"，就会出现收端还在下载、文件
 * 却已被删除的竞态，而这种错误在界面上表现为"下载到一半断了"，很难归因。
 */
import {
  getSession,
  roleOf,
  markCompleted,
  markStatCompleted,
  deleteTempFile,
  parseStorageMeta,
  jsonResponse
} from '../../utils/airdrop.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: '请求体必须是 JSON。', code: 'BAD_BODY' }, 400);
  }

  const code = String(body?.code || '').trim().toUpperCase();
  const token = String(body?.token || '').trim();
  if (!code || !token) {
    return jsonResponse({ error: '缺少 code 或 token。', code: 'BAD_PARAMS' }, 400);
  }

  const session = await getSession(env, code);
  if (!session) {
    return jsonResponse({ error: '房间不存在或已过期。', code: 'EXPIRED' }, 404);
  }
  if (roleOf(session, token) !== 'receiver') {
    return jsonResponse({ error: '只有接收方可以确认完成。', code: 'FORBIDDEN' }, 403);
  }
  if (session.status === 'done') {
    return jsonResponse({ ok: true, already: true });
  }
  if (session.status !== 'uploaded') {
    return jsonResponse({ error: '文件尚未送达中转节点。', code: 'NOT_READY' }, 409);
  }

  await markCompleted(env, code);
  await markStatCompleted(env, code);
  // 先置状态再删文件：即使删除失败，房间也已经是正确的终态，
  // 收端不会因此卡在"等待下载"里
  await deleteTempFile(env, session.storage_backend, session.storage_key, parseStorageMeta(session.storage_meta));

  return jsonResponse({ ok: true, code, completedAt: Date.now() });
}
