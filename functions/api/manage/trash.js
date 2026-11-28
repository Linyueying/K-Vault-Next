import { changeTrash, listTrash } from '../../utils/file-trash.js';

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestGet({ request, env }) {
  const offset = Number(new URL(request.url).searchParams.get('offset') || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
    return json({ success: false, error: '无效的分页位置。' }, 400);
  }
  return json({ success: true, ...await listTrash(env, offset) });
}

export async function onRequestPost({ request, env }) {
  const origin = new URL(request.url).origin;
  const source = request.headers.get('Origin');
  if (source && source !== origin) return json({ success: false, error: '请求来源无效。' }, 403);
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ success: false, error: '请求须使用 JSON。' }, 415);
  }
  const body = await request.json().catch(() => null);
  const { id, action, trashedAt: expected } = body || {};
  if (typeof id !== 'string' || !id || new TextEncoder().encode(id).byteLength > 512 ||
      !['trash', 'restore'].includes(action) ||
      (action === 'restore' && (!Number.isSafeInteger(expected) || expected <= 0))) {
    return json({ success: false, error: '无效的回收站操作。' }, 400);
  }

  const result = await changeTrash(env, { id, action, expected, origin });
  if (result.status === 404) return json({ success: false, error: '找不到该文件。' }, 404);
  if (result.status === 409) return json({ success: false, error: '文件状态已变化，请刷新回收站后重试。' }, 409);
  return json({ success: true, entry: result.entry });
}
