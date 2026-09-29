/**
 * 隔空投送 —— 取消
 * POST /api/airdrop/cancel   { code, token }
 *
 * 两端都能取消（发端改主意了、收端不想收了，都应该立刻生效）。
 * 取消属于终态：房间不再接受上传/下载，临时文件立即释放。
 */
import {
  getSession,
  roleOf,
  cancelSession,
  markStatFailed,
  deleteTempFile,
  parseStorageMeta,
  jsonResponse
} from '../../utils/airdrop.js';

const TERMINAL = ['done', 'failed', 'cancelled', 'expired'];

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
  if (!roleOf(session, token)) {
    return jsonResponse({ error: '无权操作该房间。', code: 'FORBIDDEN' }, 403);
  }
  if (TERMINAL.includes(session.status)) {
    return jsonResponse({ ok: true, already: true, status: session.status });
  }

  await cancelSession(env, code);
  await markStatFailed(env, code, 'cancelled');
  await deleteTempFile(env, session.storage_backend, session.storage_key, parseStorageMeta(session.storage_meta));

  return jsonResponse({ ok: true, code, status: 'cancelled' });
}
