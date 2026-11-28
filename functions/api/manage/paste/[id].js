/**
 * Session-authenticated single-paste endpoints for the web UI.
 *
 * Companion to `/api/manage/paste`; see that module for why these exist next to
 * the bearer-token-only `/api/v1/paste/:id` routes.
 *
 * GET    /api/manage/paste/:id?password=  → paste content + summary
 * DELETE /api/manage/paste/:id            → delete the paste
 *
 * @module api/manage/paste/[id]
 */
import { deletePasteById, getPasteById } from '../../../utils/paste-store.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function readPasteId(params) {
  try {
    return decodeURIComponent(String(params?.id || ''));
  } catch {
    return String(params?.id || '');
  }
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const pasteId = readPasteId(params);
  const password = new URL(request.url).searchParams.get('password') || '';

  try {
    const result = await getPasteById(pasteId, env, { password });
    if (!result.ok) {
      return jsonResponse({ ok: false, code: result.code, error: result.message }, result.status || 400);
    }
    return jsonResponse({ ok: true, paste: result.paste });
  } catch (error) {
    return jsonResponse({ ok: false, error: error?.message || '读取粘贴失败。' }, 500);
  }
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  const pasteId = readPasteId(params);

  try {
    const deleted = await deletePasteById(pasteId, env);
    if (!deleted) {
      return jsonResponse({ ok: false, error: '粘贴不存在或已过期。' }, 404);
    }
    return jsonResponse({ ok: true, id: pasteId });
  } catch (error) {
    return jsonResponse({ ok: false, error: error?.message || '删除粘贴失败。' }, 500);
  }
}
